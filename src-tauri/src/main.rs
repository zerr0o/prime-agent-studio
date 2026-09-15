#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod directory_picker;
mod components;
mod notifications;
#[cfg(test)]
mod update_tests;
mod updates;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Default, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    started: bool,
    legacy_root: Option<String>,
    #[serde(default)]
    notifications: notifications::Preferences,
}
struct Desktop {
    root: PathBuf,
    resources: PathBuf,
    port: u16,
    prefs: Mutex<Preferences>,
    starting: AtomicBool,
}

fn native_only(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if is_launcher_url(&url) {
        Ok(())
    } else {
        Err("This action is reserved for the desktop launcher.".into())
    }
}
fn is_launcher_url(url: &tauri::Url) -> bool {
    url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (["http", "https"].contains(&url.scheme())
                && url.host_str() == Some("tauri.localhost")))
}
fn is_external_link(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto" | "tel")
}
fn is_studio_url(url: &tauri::Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
}
fn update_window_only(window: &WebviewWindow, app: &tauri::AppHandle) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if is_launcher_url(&url) {
        return Ok(());
    }
    // Never panic on missing state inside the WebView IPC handler: deny closed.
    let port = app
        .try_state::<Desktop>()
        .map(|state| state.port)
        .ok_or_else(|| "This action is reserved for the Studio desktop application.".to_string())?;
    if window.label() == "main" && is_studio_url(&url, port) {
        Ok(())
    } else {
        Err("This action is reserved for the Studio desktop application.".into())
    }
}
fn open_external_link(app: &tauri::AppHandle, url: &tauri::Url) {
    if is_external_link(url) {
        if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
            // Do not persist the URL: OAuth links can contain short-lived secrets.
            let _ = fs::write(
                app.state::<Desktop>().root.join("desktop-link-error.log"),
                "The system browser could not be opened.",
            );
        }
    }
}
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
fn show_settings(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("desktop-settings") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    // Never panic on missing state inside an IPC handler: report instead.
    let data_directory = app
        .try_state::<Desktop>()
        .map(|state| state.root.join("webview"))
        .ok_or_else(|| "settings_unavailable".to_string())?;
    let links_app = app.clone();
    let navigation_app = app.clone();
    let built = WebviewWindowBuilder::new(
        app,
        "desktop-settings",
        WebviewUrl::App("index.html?settings".into()),
    )
    .data_directory(data_directory)
    .title("Prime Agent Studio · Application")
    .inner_size(660.0, 760.0)
    .min_inner_size(560.0, 600.0)
    .on_new_window(move |url, _| {
        open_external_link(&links_app, &url);
        tauri::webview::NewWindowResponse::Deny
    })
    .on_navigation(move |url| {
        if is_launcher_url(url) {
            return true;
        }
        open_external_link(&navigation_app, url);
        false
    })
    .build();
    match built {
        Ok(window) => {
            let _ = window.show();
            let _ = window.set_focus();
            Ok(())
        }
        Err(error) => {
            // Concurrent double-click can race check-then-build on one label.
            // Reuse the winner instead of leaving a dead button.
            if let Some(window) = app.get_webview_window("desktop-settings") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                return Ok(());
            }
            // Persist only the non-secret build error kind for diagnostics.
            if let Some(root) = app.try_state::<Desktop>().map(|state| state.root.clone()) {
                let _ = fs::create_dir_all(&root);
                let _ = fs::write(root.join("desktop-settings-error.log"), error.to_string());
            }
            Err("settings_unavailable".into())
        }
    }
}
fn save_preferences(state: &Desktop, prefs: &Preferences) -> Result<(), String> {
    fs::create_dir_all(&state.root).map_err(|e| e.to_string())?;
    let temp = state.root.join("desktop.json.tmp");
    fs::write(
        &temp,
        serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temp, state.root.join("desktop.json")).map_err(|e| e.to_string())
}
#[tauri::command]
fn desktop_state(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<Desktop>,
) -> Result<serde_json::Value, String> {
    native_only(&window)?;
    let prefs = state.prefs.lock().map_err(|e| e.to_string())?.clone();
    Ok(
        serde_json::json!({"version":app.package_info().version.to_string(),"started":prefs.started,"legacyRoot":prefs.legacy_root,"imported":state.root.join("data").exists(),"autostart":app.autolaunch().is_enabled().map_err(|e| e.to_string())?}),
    )
}
#[tauri::command]
fn desktop_autostart(
    window: WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    native_only(&window)?;
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|e| e.to_string())
}
#[tauri::command]
async fn desktop_choose_legacy(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    native_only(&window)?;
    let chosen = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Installation existante de Prime Agent Studio")
            .pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(folder) = chosen else {
        return Ok(None);
    };
    if !folder.join("server.mjs").is_file() || !folder.join(".local/workspace.json").is_file() {
        return Err("Choisissez le dossier de l’ancienne installation du Studio. / Select the previous Studio installation folder.".into());
    }
    let state = app.state::<Desktop>();
    if state.root.join("data").exists() || state.starting.load(Ordering::SeqCst) {
        return Err(
            "Les données sont déjà initialisées. / Data has already been initialized.".into(),
        );
    }
    let path = folder.to_string_lossy().to_string();
    let mut prefs = state.prefs.lock().map_err(|e| e.to_string())?;
    prefs.legacy_root = Some(path.clone());
    save_preferences(&state, &prefs)?;
    Ok(Some(path))
}
#[tauri::command]
fn desktop_logs(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<Desktop>,
) -> Result<(), String> {
    native_only(&window)?;
    fs::create_dir_all(&state.root).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(state.root.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn desktop_start(
    window: WebviewWindow,
    app: tauri::AppHandle,
    allow_unconfigured: Option<bool>,
    background: Option<bool>,
) -> Result<serde_json::Value, String> {
    native_only(&window)?;
    // B2: clone prefs/lock state BEFORE claiming starting, so an early
    // prefs-lock failure never returns with the flag held (permanent busy).
    let (root, resources, port, legacy) = {
        let state = app.state::<Desktop>();
        let prefs = state.prefs.lock().map_err(|e| e.to_string())?;
        (
            state.root.clone(),
            state.resources.clone(),
            state.port,
            prefs.legacy_root.clone(),
        )
    };
    let state = app.state::<Desktop>();
    if state.starting.swap(true, Ordering::SeqCst) {
        return Err("Le démarrage est déjà en cours. / Startup is already in progress.".into());
    }
    // Explicit background flag only gates error-window pop (constrained UI,
    // no privilege). Always logged via desktop-error.log below.
    let background = background.unwrap_or(false);
    let requested = fs::read(state.root.join("restart-after-update.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|request| request["version"] == app.package_info().version.to_string());
    let allow_unconfigured = allow_unconfigured.unwrap_or(false);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let options = serde_json::json!({"resourceDir":resources,"dataRoot":root,"port":port,"legacyRoot":legacy,"allowUnconfigured":allow_unconfigured});
        if requested {
            let restart = run_desktop_control(&resources, &options);
            // A busy server needs a fresh, explicit confirmation in Preferences.
            let _ = fs::remove_file(root.join("restart-after-update.json"));
            if let Ok(value) = restart {
                if value["restarted"] == true { return Ok(value); }
            }
        }
        let mut command = Command::new(resources.join("node.exe"));
        command.arg(resources.join("studio/scripts/desktop-start.mjs"))
            .arg(serde_json::json!({"resourceDir":resources,"dataRoot":root,"port":port,"legacyRoot":legacy,"allowUnconfigured":allow_unconfigured}).to_string())
            .current_dir(&resources);
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let output = command.output().map_err(|e| format!("Impossible de lancer le Studio. / Could not start Studio: {e}"))?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).chars().take(3000).collect::<String>()) }
        let mut value = serde_json::from_slice::<serde_json::Value>(&output.stdout).map_err(|e| e.to_string())?;
        if requested { value["showUpdates"] = true.into(); }
        Ok(value)
    }).await.map_err(|e|e.to_string()).and_then(|r|r);
    state.starting.store(false, Ordering::SeqCst);
    match result {
        Ok(result) => {
            let mut prefs = state.prefs.lock().map_err(|e| e.to_string())?;
            prefs.started = true;
            save_preferences(&state, &prefs)?;
            let _ = fs::write(state.root.join("backend.json"), result.to_string());
            if let Some(main) = app.get_webview_window("main") {
                main.navigate(
                    tauri::Url::parse(&format!(
                        "http://127.0.0.1:{}/{}",
                        state.port,
                        if result["showUpdates"] == true {
                            "?settings=updates"
                        } else {
                            ""
                        }
                    ))
                    .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                if window.label() == "desktop-settings" {
                    show_main(&app);
                }
            }
            // An older running server may not yet contain the new Preferences UI.
            // Keep the bundled restart controls reachable immediately after updating.
            if result["showUpdates"] == true {
                let _ = show_settings(&app);
            }
            Ok(result)
        }
        Err(error) => {
            let _ = fs::create_dir_all(&state.root);
            let _ = fs::write(state.root.join("desktop-error.log"), &error);
            // B4: background failures must not pop a hidden window. Foreground
            // keeps existing behaviour (show launcher for setup/failure).
            if !background {
                show_main(&app);
            }
            Err(error)
        }
    }
}

fn run_desktop_control(
    resources: &PathBuf,
    options: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut command = Command::new(resources.join("node.exe"));
    command
        .arg(resources.join("studio/scripts/desktop-control.mjs"))
        .arg(options.to_string())
        .current_dir(resources);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().map_err(|_| "server_status_failed")?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(1000)
            .collect());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "server_status_failed".into())
}

#[tauri::command]
async fn desktop_update_status(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    update_window_only(&window, &app)?;
    let state = app.state::<Desktop>();
    let resources = state.resources.clone();
    let options = serde_json::json!({"action":"status", "dataRoot":state.root,"port":state.port});
    let mut status =
        tauri::async_runtime::spawn_blocking(move || run_desktop_control(&resources, &options))
            .await
            .map_err(|_| "server_status_failed")??;
    status["appVersion"] = app.package_info().version.to_string().into();
    Ok(status)
}

#[tauri::command]
async fn desktop_server_restart(
    window: WebviewWindow,
    app: tauri::AppHandle,
    force: bool,
) -> Result<serde_json::Value, String> {
    update_window_only(&window, &app)?;
    if app.state::<updates::Updates>().is_busy() {
        return Err("update_busy".into());
    }
    let state = app.state::<Desktop>();
    if state.starting.swap(true, Ordering::SeqCst) {
        return Err("update_busy".into());
    }
    let resources = state.resources.clone();
    let options = serde_json::json!({"resourceDir":resources,"dataRoot":state.root,"port":state.port,"force":force});
    let result =
        tauri::async_runtime::spawn_blocking(move || run_desktop_control(&resources, &options))
            .await
            .map_err(|_| "server_restart_failed".to_string())
            .and_then(|r| r);
    state.starting.store(false, Ordering::SeqCst);
    if let Err(error) = &result {
        let _ = fs::write(state.root.join("desktop-server-error.log"), error);
    }
    if let Ok(value) = &result {
        if value["restarted"] == true {
            let _ = fs::write(state.root.join("backend.json"), value.to_string());
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.navigate(
                    format!("http://127.0.0.1:{}/?settings=updates", state.port)
                        .parse()
                        .unwrap(),
                );
            }
        }
    }
    result
}

fn main() {
    // The updater enables reqwest's rustls-no-provider feature process-wide,
    // but initializes ring only when checking for updates. The notification
    // client starts earlier (even for HTTP); initialize the same provider now.
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|arg| arg == "--settings") {
                let _ = show_settings(app);
            } else if !args.iter().any(|arg| arg == "--background") {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        // Studio has no opener IPC permission. The
        // plugin's default click interceptor prevents navigation then invokes a
        // denied IPC command. Let the native navigation callbacks handle links.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(directory_picker::DirectoryPicker::default())
        .manage(components::Components::default())
        .manage(updates::Updates::default())
        .invoke_handler(tauri::generate_handler![
            desktop_state,
            components::desktop_components,
            components::desktop_components_cancel,
            components::desktop_components_open,
            desktop_autostart,
            desktop_choose_legacy,
            desktop_logs,
            desktop_start,
            desktop_update_status,
            desktop_server_restart,
            directory_picker::desktop_pick_directory,
            updates::desktop_update_check,
            updates::desktop_update_install,
            notifications::desktop_notification_preferences
        ])
        .setup(|app| {
            let root = std::env::var_os("PRIME_STUDIO_DESKTOP_DATA_ROOT")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_local_data_dir()?);
            let mut resources = app.path().resource_dir()?.join("backend");
            if cfg!(debug_assertions) && !resources.join("node.exe").is_file() {
                resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.desktop-build");
            }
            let port = std::env::var("PRIME_STUDIO_DESKTOP_PORT")
                .ok()
                .map(|p| p.parse::<u16>())
                .transpose()?
                .unwrap_or(3088);
            if port == 0 {
                return Err("Invalid Studio port".into());
            }
            // Only these commands cross into the exact local Studio origin.
            // No general filesystem, shell, opener or launcher settings permissions.
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("studio-updates")
                    .window("main")
                    .remote(format!("http://127.0.0.1:{port}/*"))
                    .permission("allow-desktop-update-status")
                    .permission("allow-desktop-components-open")
                    .permission("allow-desktop-server-restart")
                    .permission("allow-desktop-pick-directory")
                    .permission("allow-desktop-notification-preferences")
                    .permission("allow-desktop-update-check")
                    .permission("allow-desktop-update-install"),
            )?;
            let prefs = fs::read(root.join("desktop.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
            let webview_data = root.join("webview");
            app.manage(Desktop {
                root,
                resources,
                port,
                prefs: Mutex::new(prefs),
                starting: AtomicBool::new(false),
            });
            let handle = app.handle().clone();
            let navigation_app = handle.clone();
            let links_app = handle.clone();
            let background = std::env::args().any(|arg| arg == "--background");
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App(
                    if background {
                        "index.html?background"
                    } else {
                        "index.html"
                    }
                    .into(),
                ),
            )
            .title("Prime Agent Studio")
            .inner_size(1280.0, 860.0)
            .min_inner_size(860.0, 620.0)
            .visible(!background)
            .data_directory(webview_data)
            // Otherwise Windows consumes file drops before the HTML composer.
            .disable_drag_drop_handler()
            .initialization_script(
                "Object.defineProperty(window, '__PRIME_STUDIO_DESKTOP__', { value: true }); Object.defineProperty(window, '__PRIME_STUDIO_DIRECTORY_PICKER__', { value: true }); Object.defineProperty(window, '__PRIME_STUDIO_NOTIFICATIONS__', { value: true });",
            )
            .on_new_window(move |url, _| {
                open_external_link(&links_app, &url);
                tauri::webview::NewWindowResponse::Deny
            })
            .on_navigation(move |url| {
                if is_launcher_url(url) || is_studio_url(url, port) {
                    return true;
                }
                open_external_link(&navigation_app, url);
                false
            })
            .build()?;
            let french = sys_locale::get_locale()
                .unwrap_or_else(|| "en".into())
                .to_lowercase()
                .starts_with("fr");
            let open = MenuItem::with_id(
                app,
                "open",
                if french {
                    "Ouvrir le Studio"
                } else {
                    "Open Studio"
                },
                true,
                None::<&str>,
            )?;
            let settings = MenuItem::with_id(
                app,
                "settings",
                if french {
                    "Réglages de l’application"
                } else {
                    "App settings"
                },
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(
                app,
                "quit",
                if french {
                    "Quitter l’application"
                } else {
                    "Quit application"
                },
                true,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &settings, &separator, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Prime Agent Studio")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "settings" => {
                        let _ = show_settings(app);
                    }
                    "quit" => app.exit(0),
                    _ => (),
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            if std::env::args().any(|arg| arg == "--settings") {
                let _ = show_settings(app.handle());
            }
            notifications::start(app.handle().clone(), port);
            updates::start_update_intent_poller(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Prime Agent Studio desktop failed");
}
