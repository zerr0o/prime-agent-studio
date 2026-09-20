use std::{
    io::{BufRead, BufReader, Write},
    process::{ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    ipc::{Channel, JavaScriptChannelId},
    Emitter, Manager, WebviewWindow,
};

#[derive(Default)]
pub struct Components {
    busy: AtomicBool,
    input: Mutex<Option<ChildStdin>>,
}

// Async (thread-pool) on purpose: opening/focusing the settings window from inside
// the Studio WebView IPC callback must not run re-entrantly on the WebView2 thread.
// The tray opener runs outside that callback, which is why it stayed working.
// Focus the main Preferences panel when available, otherwise the native recovery
// window. Opening settings never touches the server, so agents keep running.
#[tauri::command]
pub async fn desktop_components_open(
    window: WebviewWindow,
    app: tauri::AppHandle,
    recovery: Option<bool>,
) -> Result<(), String> {
    super::update_window_only(&window, &app)?;
    if recovery.unwrap_or(false) {
        super::show_recovery_settings(&app)?;
    } else {
        super::show_settings(&app)?;
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_components_cancel(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    super::update_window_only(&window, &app)?;
    if let Some(input) = app
        .state::<Components>()
        .input
        .lock()
        .map_err(|_| "preparation_failed")?
        .as_mut()
    {
        input
            .write_all(b"cancel\n")
            .map_err(|_| "preparation_failed")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_components(
    window: WebviewWindow,
    app: tauri::AppHandle,
    action: String,
    component: Option<String>,
    on_progress: Option<JavaScriptChannelId>,
) -> Result<serde_json::Value, String> {
    // Only the bundled launcher or the main WebView at its exact owned loopback
    // origin may use this bridge. LAN, browsers and other ports are denied.
    // The page supplies no path, command or URL: downloads use the pinned policy;
    // explicit paths still come only from the native user-initiated file picker.
    super::update_window_only(&window, &app)?;
    if ![
        "status", "diagnose", "install", "select", "activate", "apply",
    ]
    .contains(&action.as_str())
    {
        return Err("action_invalid".into());
    }
    let updates = app.state::<super::updates::Updates>();
    let _operation = super::updates::begin(&updates)?;
    if app
        .state::<super::Desktop>()
        .starting
        .load(Ordering::SeqCst)
    {
        return Err("setup_busy".into());
    }
    let state = app.state::<Components>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("setup_busy".into());
    }
    let on_progress: Option<Channel<serde_json::Value>> =
        on_progress.map(|id| id.channel_on(window.as_ref().clone()));
    let worker_app = app.clone();
    let initiator = window.clone();
    // The launcher already calls desktop_start after activation. Only the
    // served Studio page needs native navigation; otherwise two starts race.
    let from_studio = window.label() == "main"
        && window
            .url()
            .map(|url| super::is_studio_url(&url, app.state::<super::Desktop>().port))
            .unwrap_or(false);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let desktop = worker_app.state::<super::Desktop>();
        let resources = desktop.resources.clone();
        let mut options = serde_json::json!({"action": action, "dataRoot": desktop.root, "resourceDir": resources, "port": desktop.port});
        options["legacyRoot"] = serde_json::to_value(&desktop.prefs.lock().map_err(|_| "preparation_failed")?.legacy_root)
            .map_err(|_| "preparation_failed")?;
        if action == "select" {
            let kind = component.as_deref().unwrap_or("engine");
            if !["engine", "uv", "python"].contains(&kind) { return Err("selection_invalid".into()); }
            let picker = rfd::FileDialog::new().set_parent(&window);
            let selected = if kind == "engine" { picker.pick_folder() } else { picker.add_filter("Executable", &["exe"]).pick_file() };
            let Some(path) = selected else { return Ok(serde_json::json!({"cancelled":true})); };
            options["component"] = kind.into();
            options["path"] = path.to_string_lossy().to_string().into();
        }
        let mut command = Command::new(resources.join("node.exe"));
        command.arg(resources.join("studio/scripts/desktop-components.mjs")).arg(options.to_string())
            .current_dir(&resources).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn().map_err(|_| "preparation_failed".to_owned())?;
        *worker_app.state::<Components>().input.lock().map_err(|_| "preparation_failed")? = child.stdin.take();
        let mut result = Err("preparation_failed".to_owned());
        for line in BufReader::new(child.stdout.take().ok_or("preparation_failed")?).lines() {
            let line = line.map_err(|_| "preparation_failed")?;
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
            match value["type"].as_str() {
                Some("progress") => {
                    if let Some(channel) = &on_progress { let _ = channel.send(value.clone()); }
                    let _ = window.emit("components-progress", &value);
                },
                Some("result") => { result = Ok(value["result"].clone()); },
                Some("failure") => { result = Ok(serde_json::json!({"failure":value})); },
                _ => {}
            }
        }
        let _ = child.wait();
        result
    }).await.map_err(|_| "preparation_failed".to_owned()).and_then(|r| r);
    // Never return with busy held (permanent setup_busy): reset even if the
    // input lock is poisoned.
    if let Ok(mut input) = state.input.lock() {
        *input = None;
    }
    state.busy.store(false, Ordering::SeqCst);
    // All helper work is finished. A freshly navigated page must be able to
    // read status immediately, without racing the previous operation's guard.
    drop(_operation);
    if let Ok(value) = &result {
        if value["activation"] == "active" && from_studio {
            let port = app.state::<super::Desktop>().port;
            if let Ok(url) = format!("http://127.0.0.1:{port}/?settings=updates").parse() {
                let _ = initiator.navigate(url);
            }
        }
    }
    result
}
