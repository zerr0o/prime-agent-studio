#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod components;
mod desktop_port;
mod directory_picker;
mod notifications;
#[cfg(test)]
mod update_tests;
mod updates;
mod window_state;

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
    /// Preferred Studio loopback port. `None` (4.4.4 files) means 3088.
    #[serde(default)]
    port: Option<u16>,
}
struct Desktop {
    root: PathBuf,
    resources: PathBuf,
    /// Effective loopback port (preferred or automatic fallback).
    port: u16,
    /// Preferred port before fallback; equals `port` when no move happened.
    preferred_port: u16,
    /// Explicit `PRIME_STUDIO_DESKTOP_PORT` override: strict, no fallback.
    env_override: bool,
    prefs: Mutex<Preferences>,
    starting: AtomicBool,
    restart_phase: Mutex<Option<serde_json::Value>>,
}
// Real launcher origin observed at runtime (correct custom protocol for this
// platform). Separate managed state so the Desktop shape stays untouched.
#[derive(Default)]
struct LauncherOrigin {
    origin: Mutex<Option<String>>,
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
fn is_update_origin(label: &str, url: &tauri::Url, port: u16) -> bool {
    // Single window: only main exists. Both bundled shell and exact Studio
    // loopback origin require the main label. No second window label passes.
    label == "main" && (is_launcher_url(url) || is_studio_url(url, port))
}
fn update_window_only(window: &WebviewWindow, app: &tauri::AppHandle) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if window.label() == "main" && is_launcher_url(&url) {
        return Ok(());
    }
    // Never panic on missing state inside the WebView IPC handler: deny closed.
    let port = app
        .try_state::<Desktop>()
        .map(|state| state.port)
        .ok_or_else(|| "This action is reserved for the Studio desktop application.".to_string())?;
    if is_update_origin(window.label(), &url, port) {
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
/// Windows may return verbatim paths (`\\?\C:\...`). Some Node versions
/// cannot start a script from such a path (v24.20.0: EISDIR lstat 'C:'), so
/// every path handed to node.exe uses the plain drive form. UNC and other
/// verbatim forms stay unchanged.
pub(crate) fn plain_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
            return PathBuf::from(rest);
        }
    }
    path
}
pub(crate) fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        if window_state::take_pending_maximize(app) {
            let _ = window.maximize();
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}
// Eval scripts below are pure builders so tests assert the real fallback
// contract without a WebView: panel-or-replace for settings, flag-or-replace
// for quit. eval().is_ok() alone never proves anything opened.
fn settings_panel_script(shell: &str) -> String {
    format!(
        // 1. Served Studio hook: opens the real Preferences popup (also when
        //    the dock layout hides the dialog).
        // 2. Older pages: unhide, show, then verify the modal really paints.
        //    A modal with no box makes the whole page inert (frozen window),
        //    so close it and fall back to the local shell instead.
        "(() => {{ const shell = {shell:?}; const hook = window.__PRIME_STUDIO_OPEN_PREFERENCES__; if (typeof hook === 'function') {{ try {{ hook('updates'); return; }} catch (e) {{}} }} const dialog = document.getElementById('settings-dialog'); const tab = document.getElementById('settings-tab-updates'); if (!dialog || !tab) {{ window.location.replace(shell); return; }} dialog.hidden = false; tab.click(); if (!dialog.open) {{ try {{ dialog.showModal(); }} catch (e) {{ dialog.setAttribute('open', ''); }} }} if (!dialog.getClientRects().length) {{ try {{ dialog.close(); }} catch (e) {{}} window.location.replace(shell); }} }})()",
    )
}
fn quit_handshake_script(shell: &str) -> String {
    format!(
        "(() => {{ if (window.__PRIME_STUDIO_QUIT_READY__ === true) {{ window.dispatchEvent(new CustomEvent('studio:quit-request')); }} else {{ window.location.replace({shell:?}); }} }})()",
    )
}
// Once Studio has opened, native Back must not revisit the bootstrap page.
// Explicit settings/quit recovery still uses the trusted local shell.
fn allow_launcher_navigation(url: &tauri::Url, studio_entered: bool) -> bool {
    is_launcher_url(url)
        && (!studio_entered
            || url.query_pairs().any(|(key, _)| key == "settings" || key == "quit"))
}
// Local shell URL inside the single main window. Prefers the launcher origin
// observed at runtime (same scheme/host the window was created with); derives
// it from the current URL when already on the shell; last resort is the
// http tauri.localhost form. Never creates a second window.
fn local_shell_url(app: &tauri::AppHandle, query: &str) -> tauri::Url {
    let query = query.trim_start_matches('?');
    if let Some(main) = app.get_webview_window("main") {
        if let Ok(url) = main.url() {
            if is_launcher_url(&url) {
                let mut current = url;
                current.set_path("/index.html");
                current.set_query(Some(query));
                return current;
            }
        }
    }
    if let Some(origin) = app
        .try_state::<LauncherOrigin>()
        .and_then(|state| state.origin.lock().ok().and_then(|guard| guard.clone()))
    {
        if let Ok(url) = tauri::Url::parse(&format!("{origin}/index.html?{query}")) {
            return url;
        }
    }
    format!("http://tauri.localhost/index.html?{query}")
        .parse()
        .expect("hardcoded local shell URL must parse")
}
fn show_settings(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(main) = app.get_webview_window("main") else {
        return Err("settings_unavailable".into());
    };
    let port = app
        .try_state::<Desktop>()
        .map(|state| state.port)
        .ok_or_else(|| "settings_unavailable".to_string())?;
    if main.url().is_ok_and(|url| is_studio_url(&url, port)) {
        // Single window: prefer the served Studio Preferences Updates panel
        // when it exists. No reload or navigation so drafts and agents stay
        // intact. NOTE: eval().is_ok() only means JS was accepted, NOT that the
        // panel opened. An older server without the settings DOM would accept
        // the eval and do nothing, so the fallback lives INSIDE the evaluated
        // JS: when the panel is missing the page replaces its own location
        // with the local shell URL (embedded by native, correct protocol).
        let shell = local_shell_url(app, "settings").to_string();
        let script = settings_panel_script(&shell);
        main.eval(&script)
            .map_err(|_| "settings_unavailable".to_string())?;
        show_main(app);
        return Ok(());
    }
    // Fallback and recovery share the same surface: local shell inside main.
    // Works when the server is stopped, on an older version, or on first run.
    let _ = main.navigate(local_shell_url(app, "settings"));
    show_main(app);
    Ok(())
}
fn show_shell_quit(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(main) = app.get_webview_window("main") else {
        return Err("settings_unavailable".into());
    };
    let _ = main.navigate(local_shell_url(app, "quit"));
    show_main(app);
    Ok(())
}
fn request_quit_confirmation(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        // Confirmation lives inside main (served Studio or local shell), never
        // in an extra native window. Both fronts set __PRIME_STUDIO_QUIT_READY__
        // and listen for studio:quit-request. An older server without the
        // handler would accept the eval silently, so detection also lives
        // INSIDE the evaluated JS: without the flag the page replaces its own
        // location with the local quit shell instead.
        // If the page cannot run JS at all (navigating, closed), fall back
        // to the local quit shell so the user still gets an explicit choice.
        let shell = local_shell_url(app, "quit").to_string();
        let script = quit_handshake_script(&shell);
        let accepted = main.eval(&script).is_ok();
        show_main(app);
        if !accepted {
            let _ = show_shell_quit(app);
        }
    }
}
fn request_components_cancel(app: &tauri::AppHandle) -> bool {
    // Interruptible work today: components child stdin cancel line.
    // Returns true when a cancel was requested (busy was observed).
    let busy = app
        .try_state::<components::Components>()
        .map(|s| s.is_busy())
        .unwrap_or(false);
    if !busy {
        return false;
    }
    if let Some(state) = app.try_state::<components::Components>() {
        if let Ok(mut guard) = state.input.lock() {
            if let Some(input) = guard.as_mut() {
                use std::io::Write;
                let _ = input.write_all(b"cancel\n");
                return true;
            }
        }
    }
    busy
}
async fn cancel_interruptible_and_wait(app: &tauri::AppHandle, cancel_current: bool) -> Result<(), String> {
    // Components holds Updates busy too (shared begin guard), so routing via
    // operation kind first: components => stdin cancel + await settlement,
    // check/install => worker Notify helper. Then shared guard. Never fake cancel.
    let components_busy = app
        .try_state::<components::Components>()
        .map(|s| s.is_busy())
        .unwrap_or(false);
    let updates_busy = app
        .try_state::<updates::Updates>()
        .map(|s| s.is_busy())
        .unwrap_or(false);
    if !components_busy && !updates_busy {
        return Ok(());
    }
    if !cancel_current {
        return Err("update_busy".into());
    }
    // Route by kind: worker snapshot kind decides, components flag wins because
    // components/prepare also holds the Updates guard.
    let kind = updates::operation_snapshot(app)
        .get("kind")
        .and_then(|k| k.as_str())
        .unwrap_or("")
        .to_string();
    if components_busy || matches!(kind.as_str(), "components" | "prepare") {
        let _ = request_components_cancel(app);
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let still_components = app
                .try_state::<components::Components>()
                .map(|s| s.is_busy())
                .unwrap_or(false);
            let still_updates = app
                .try_state::<updates::Updates>()
                .map(|s| s.is_busy())
                .unwrap_or(false);
            if !still_components && !still_updates {
                return Ok(());
            }
        }
        return Err("update_busy".into());
    }
    // check/install path: worker Notify + bounded wait. verifying/installing
    // returns install_noncancellable explicitly so the shell offers retry.
    // Restart/quit kinds are not cancellable here: explicit busy, no fake cancel.
    if matches!(kind.as_str(), "check" | "install") {
        let _ = updates::cancel_and_wait_cancellable(app).await?;
        return Ok(());
    }
    Err("update_busy".into())
}
fn is_quit_terminated(stopped: bool, reason: Option<&str>) -> bool {
    // Control contract: absent server => {stopped:false, reason:already-stopped}.
    // Treat already-stopped as terminated (nothing to stop, safe to exit).
    // Real prod helper: used by desktop_quit exit + finish decisions below.
    stopped || reason == Some("already-stopped")
}
fn is_restart_success(value: &serde_json::Value) -> bool {
    // No false success: done only when restarted==true. Refusals
    // (agents_running/components_required/...) are terminal errors, never done.
    // Real prod helper: used by restart finish below.
    value.get("restarted").and_then(|v| v.as_bool()).unwrap_or(false)
}
fn is_verified_current_backend(status: &serde_json::Value, app_version: &str) -> bool {
    // Live backend already serving this release on a restartable lineage.
    let running = status.get("running").and_then(|v| v.as_bool()).unwrap_or(false);
    let version_ok = status.get("version").and_then(|v| v.as_str()) == Some(app_version);
    let lineage_ok = status
        .get("canRestart")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || matches!(
            status.get("ownership").and_then(|v| v.as_str()),
            Some("managed" | "recoverable")
        );
    running && version_ok && lineage_ok
}
fn restart_refusal_reason(value: &serde_json::Value) -> String {
    // Real prod helper: terminal error reason when restarted != true.
    value
        .get("reason")
        .and_then(|r| r.as_str())
        .unwrap_or("restart_failed")
        .to_string()
}
fn restart_control_options(
    resources: &PathBuf,
    data_root: &PathBuf,
    port: u16,
    force: bool,
) -> serde_json::Value {
    // Real prod builder: restart via control starts even when stopped
    // (control skips stop, starts replacement). No pid/kill keys ever.
    serde_json::json!({"resourceDir":resources,"dataRoot":data_root,"port":port,"force":force})
}
fn quit_control_options(
    resources: &PathBuf,
    data_root: &PathBuf,
    port: u16,
    force: bool,
) -> serde_json::Value {
    // Real prod builder for stopDesktop action stop. No pid/kill keys ever.
    serde_json::json!({"action":"stop","dataRoot":data_root,"port":port,"force":force,"resourceDir":resources})
}
fn control_options_contain_forbidden_pid(options: &serde_json::Value) -> bool {
    // Non-kill proof: our control options never carry pid/kill/signal keys.
    // Ownership/provenance checks live in the control worker, never a raw PID.
    if let Some(obj) = options.as_object() {
        for key in ["pid", "kill", "signal", "killPid", "processId"] {
            if obj.contains_key(key) {
                return true;
            }
        }
    }
    false
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
    update_window_only(&window, &app)?;
    let prefs = state.prefs.lock().map_err(|e| e.to_string())?.clone();
    // Best-effort autostart read: a query failure must not fail the whole
    // state command. None serializes as null (unknown), never as false, so
    // the shell can display unknown/disabled without implying opt-out.
    Ok(
        serde_json::json!({"version":app.package_info().version.to_string(),"started":prefs.started,"legacyRoot":prefs.legacy_root,"imported":state.root.join("data").exists(),"autostart":app.autolaunch().is_enabled().ok()}),
    )
}
/// Current loopback port selection: `{port, envOverride, movedFrom}`.
/// `movedFrom` is the preferred port when the automatic fallback moved us
/// elsewhere, otherwise null (including under an env override).
#[tauri::command]
fn desktop_port_state(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    update_window_only(&window, &app)?;
    let state = app.state::<Desktop>();
    Ok(serde_json::json!({
        "port": state.port,
        "envOverride": state.env_override,
        "movedFrom": if state.env_override || state.port == state.preferred_port {
            serde_json::Value::Null
        } else {
            state.preferred_port.into()
        },
    }))
}
/// Persist a new preferred port, then restart the app so the next launch
/// serves it. Returns `{changed:true, port}` once the restart is requested,
/// or a control-style refusal `{changed:false, reason:"agents_running"}`
/// when agents are active and `force` is false. Rejects unknown ports with
/// `port_invalid`, env overrides with `port_env_override`, and occupied or
/// unbindable destinations with `port_unavailable`. A failed preference
/// write after the stop rejects with `port_save_failed` (old server already
/// stopped; re-invoke Start or relaunch).
#[tauri::command]
async fn desktop_port_set(
    window: WebviewWindow,
    app: tauri::AppHandle,
    port: i64,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    update_window_only(&window, &app)?;
    let force = force.unwrap_or(false);
    // Shared guards: never change ports while another server operation runs.
    let updates = app.state::<updates::Updates>();
    let _operation = updates::begin(&updates)?;
    // Tracked stop with Quit parity, so the port change is visible in the
    // 1s light poll instead of an invisible stop. No cancellation override:
    // the kind is one-shot and the blocking stop is awaited, never timed out.
    let track_id = updates::track_operation_start(&app, "quit", "working", false)?;
    let state = app.state::<Desktop>();
    if state.starting.swap(true, Ordering::SeqCst) {
        updates::track_operation_finish(&app, &track_id, "error", Some("update_busy"));
        return Err("update_busy".into());
    }
    let outcome = desktop_port_set_inner(&app, port, force, &track_id).await;
    // Restart path keeps the guard through request_restart/process exit:
    // a late Start IPC must see busy, never boot the old-port server while
    // the new process comes up on the new port.
    if !desktop_port::port_set_keep_starting_guard(&outcome) {
        state.starting.store(false, Ordering::SeqCst);
    }
    // Every exit lands terminal: changed/no-op finish done, refusals and
    // errors finish error with the stable code.
    let (stage, code) = desktop_port::port_change_terminal(&outcome);
    updates::track_operation_finish(&app, &track_id, stage, code.as_deref());
    match outcome {
        Ok((value, restart)) => {
            if restart {
                // Single-instance Exit cleanup must run so the lock file is
                // released; never use the immediate `restart()` here.
                app.request_restart();
            }
            Ok(value)
        }
        Err(error) => Err(error),
    }
}
async fn desktop_port_set_inner(
    app: &tauri::AppHandle,
    requested: i64,
    force: bool,
    track_id: &str,
) -> Result<(serde_json::Value, bool), String> {
    let (root, resources, current, env_override, preferred) = {
        let state = app.state::<Desktop>();
        (
            state.root.clone(),
            state.resources.clone(),
            state.port,
            state.env_override,
            state.preferred_port,
        )
    };
    if desktop_port::validate_port_request(env_override, current, requested)? {
        return Ok((
            serde_json::json!({
                "changed": false,
                "port": current,
                "envOverride": env_override,
                "movedFrom": if env_override || current == preferred {
                    serde_json::Value::Null
                } else {
                    preferred.into()
                },
            }),
            false,
        ));
    }
    let requested = requested as u16;
    // Never steal a live port: healthy Studio, foreign service, reserved
    // range, or an unbindable socket all reject here.
    if !desktop_port::destination_available_live(requested) {
        return Err("port_unavailable".into());
    }
    // Safely stop the old server with the same ownership and active-agent
    // gates as Quit: only a clean stop (or nothing running) may proceed.
    // Phases relay into the tracked operation (no timeout: the underlying
    // stop is awaited, never abandoned).
    let options =
        quit_control_options(&resources, &root, current, force);
    let app_for_phases = app.clone();
    let track_for_phases = track_id.to_string();
    let stop = tauri::async_runtime::spawn_blocking(move || {
        run_desktop_control_with_phases(&resources, &options, Some(&|phase: serde_json::Value| {
            let stage = phase.get("stage").and_then(|s| s.as_str()).unwrap_or("working");
            let detail = phase.get("detail").and_then(|s| s.as_str()).unwrap_or("");
            updates::track_operation_progress(
                &app_for_phases,
                &track_for_phases,
                stage,
                0,
                None,
                detail,
                false,
            );
        }))
    })
    .await
    .map_err(|_| "server_stop_failed".to_string())
    .and_then(|r| r);
    match desktop_port::classify_stop_result(&stop) {
        desktop_port::StopOutcome::Proceed => {}
        desktop_port::StopOutcome::AgentsRunning(value) => {
            let mut refusal = serde_json::json!({
                "changed": false,
                "reason": "agents_running",
                "port": current,
            });
            if let Some(active) = value.get("activeRuns") {
                refusal["activeRuns"] = active.clone();
            }
            return Ok((refusal, false));
        }
        desktop_port::StopOutcome::Failed(reason) => return Err(reason),
    }
    // Persist only after the old server stopped cleanly: persisting
    // before the stop could record the new port despite an active-agent
    // refusal, and rolling that back is worse than failing here. On save
    // failure the in-memory preference is restored (disk untouched) and a
    // stable port_save_failed is returned: the old server is already
    // stopped, so the user re-invokes Start (state.port is unchanged) or
    // relaunches. No auto-restart recovery: it would risk a duplicate
    // server for a best-effort write.
    {
        let state = app.state::<Desktop>();
        let mut prefs = state.prefs.lock().map_err(|e| e.to_string())?;
        let previous = prefs.port;
        prefs.port = Some(requested);
        if let Err(error) = save_preferences(&state, &prefs) {
            prefs.port = previous;
            let _ = fs::write(state.root.join("desktop-server-error.log"), &error);
            return Err("port_save_failed".into());
        }
    }
    Ok((serde_json::json!({"changed": true, "port": requested}), true))
}
#[tauri::command]
fn desktop_autostart(
    window: WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    update_window_only(&window, &app)?;
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
    let updates = app.state::<updates::Updates>();
    let _operation = updates::begin(&updates)?;
    if state.starting.swap(true, Ordering::SeqCst) {
        return Err("Le démarrage est déjà en cours. / Startup is already in progress.".into());
    }
    // Explicit background flag only gates error-window pop (constrained UI,
    // no privilege). Always logged via desktop-error.log below.
    let background = background.unwrap_or(false);
    let app_version = app.package_info().version.to_string();
    let requested = fs::read(state.root.join("restart-after-update.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|request| request["version"] == app_version);
    let allow_unconfigured = allow_unconfigured.unwrap_or(false);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let options = serde_json::json!({"resourceDir":resources,"dataRoot":root,"port":port,"legacyRoot":legacy,"allowUnconfigured":allow_unconfigured});
        // Drop the marker only for a verified current backend; any other
        // outcome keeps today's restart path with its ownership gates.
        let mut pending_restart = requested;
        if requested {
            let status_options = serde_json::json!({"action":"status","dataRoot":root,"resourceDir":resources,"port":port});
            if let Ok(status) = run_desktop_control(&resources, &status_options) {
                if is_verified_current_backend(&status, &app_version) {
                    let _ = fs::remove_file(root.join("restart-after-update.json"));
                    pending_restart = false;
                }
            }
        }
        if pending_restart {
            let restart = run_desktop_control(&resources, &options);
            // Keep restart-after-update.json until restart is confirmed.
            // A busy server needs a fresh, explicit confirmation in main.
            if let Ok(value) = restart {
                if value["restarted"] == true {
                    let _ = fs::remove_file(root.join("restart-after-update.json"));
                    return Ok(value);
                }
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
        if pending_restart { value["showUpdates"] = true.into(); }
        Ok(value)
    }).await.map_err(|e|e.to_string()).and_then(|r|r);
    state.starting.store(false, Ordering::SeqCst);
    match result {
        Ok(result) => {
            let mut prefs = state.prefs.lock().map_err(|e| e.to_string())?;
            prefs.started = true;
            save_preferences(&state, &prefs)?;
            drop(prefs);
            let _ = fs::write(state.root.join("backend.json"), result.to_string());
            // Startup is complete before navigation bootstraps native status
            // reads. Do not hold either lock across that document transition.
            drop(_operation);
            if result["showUpdates"] == true && !allow_unconfigured && !background {
                // Show the packaged update guide in MAIN first. An older server
                // cannot serve the newly installed components UI yet.
                return Ok(result);
            }
            if let Some(main) = app.get_webview_window("main") {
                let studio_url = format!(
                    "http://127.0.0.1:{}/{}",
                    state.port,
                    if result["showUpdates"] == true {
                        "?settings=updates"
                    } else {
                        ""
                    }
                );
                // This must be browser-initiated navigation. A renderer-side
                // location.replace from tauri.localhost sends cross-site fetch
                // metadata, correctly rejected by the server's origin guard.
                main.navigate(tauri::Url::parse(&studio_url).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            }
            // ?settings=updates opens the existing main Preferences panel once
            // its page is ready. Do not also open a duplicate launcher window.
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
    run_desktop_control_with_phases(resources, options, None)
}
fn run_desktop_control_with_phases(
    resources: &PathBuf,
    options: &serde_json::Value,
    on_phase: Option<&dyn Fn(serde_json::Value)>,
) -> Result<serde_json::Value, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    let mut command = Command::new(resources.join("node.exe"));
    let mut opts = options.clone();
    // Production relays restart/stop JSONL phases when the worker supports it.
    // Tests stay isolated: no live spawn there, this path is not covered by unit tests.
    if opts.get("action").and_then(|a| a.as_str()).is_some_and(|a| a != "status") {
        opts["progress"] = true.into();
    }
    command
        .arg(resources.join("studio/scripts/desktop-control.mjs"))
        .arg(opts.to_string())
        .current_dir(resources)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| "server_status_failed")?;
    let mut last: Option<serde_json::Value> = None;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };
            // Worker JSONL: progress objects plus a final result object.
            // Single-JSON workers (current status/restart) yield one line.
            let is_progress = value.get("type").and_then(|t| t.as_str()) == Some("progress")
                || value.get("stage").is_some() && value.get("restarted").is_none() && value.get("stopped").is_none();
            if is_progress {
                if let Some(cb) = on_phase {
                    cb(value.clone());
                }
                continue;
            }
            last = Some(value);
        }
    }
    let output = child.wait_with_output().map_err(|_| "server_status_failed")?;
    if !output.status.success() && last.is_none() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Never fail silently: keep a short explicit reason for the shell.
        let reason: String = stderr.chars().take(1000).collect();
        if reason.is_empty() {
            return Err("server_status_failed".into());
        }
        return Err(reason);
    }
    if let Some(value) = last {
        return Ok(value);
    }
    // Fallback for workers that print one JSON blob without newlines.
    if output.stdout.is_empty() {
        return Err("server_status_failed".into());
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
    // Single operation truth: worker snapshot only (track_* unique, no local copy).
    // Heavy OS probe stays on demand; 1s light poll uses desktop_update_operation.
    status["operation"] = updates::operation_snapshot(&app);
    Ok(status)
}

#[tauri::command]
async fn desktop_server_restart(
    window: WebviewWindow,
    app: tauri::AppHandle,
    force: bool,
    cancel_current: Option<bool>,
) -> Result<serde_json::Value, String> {
    update_window_only(&window, &app)?;
    // Do not hide an explicit user force behind a generic busy: cancel/wait
    // interruptible work first, then take the shared guard. Noncancellable
    // installer handoff returns update_busy explicitly so the shell offers retry.
    cancel_interruptible_and_wait(&app, cancel_current.unwrap_or(false)).await?;
    let updates = app.state::<updates::Updates>();
    let _operation = updates::begin(&updates)?;
    // Tracked operation for 1s light poll (worker authoritative, local fallback kept).
    // Explicit error when tracker reports incoherent active op (never ignore via .ok()).
    let track_id = updates::track_operation_start(&app, "restart", "checking", false)?;
    let state = app.state::<Desktop>();
    if state.starting.swap(true, Ordering::SeqCst) {
        updates::track_operation_finish(&app, &track_id, "error", Some("update_busy"));
        return Err("update_busy".into());
    }
    if let Ok(mut phase) = state.restart_phase.lock() {
        *phase = Some(serde_json::json!({"stage":"checking","detail":""}));
    }
    let resources = state.resources.clone();
    let options = restart_control_options(&resources, &state.root, state.port, force);
    let app_for_phases = app.clone();
    let track_for_phases = track_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_desktop_control_with_phases(&resources, &options, Some(&|phase: serde_json::Value| {
            if let Some(desktop) = app_for_phases.try_state::<Desktop>() {
                if let Ok(mut guard) = desktop.restart_phase.lock() {
                    *guard = Some(phase.clone());
                }
            }
            // Contract stages checking/stopping/starting flow here despite free-stage FINAL.
            let stage = phase.get("stage").and_then(|s| s.as_str()).unwrap_or("working");
            let detail = phase.get("detail").and_then(|s| s.as_str()).unwrap_or("");
            updates::track_operation_progress(&app_for_phases, &track_for_phases, stage, 0, None, detail, false);
        }))
    })
    .await
    .map_err(|_| "server_restart_failed".to_string())
    .and_then(|r| r);
    state.starting.store(false, Ordering::SeqCst);
    if let Ok(mut phase) = state.restart_phase.lock() {
        *phase = None;
    }
    // No false success: done only when restarted==true, else terminal error
    // with the control reason (agents_running/components_required/...).
    match &result {
        Ok(value) if is_restart_success(value) => {
            updates::track_operation_finish(&app, &track_id, "done", None);
        }
        Ok(value) => {
            let reason = restart_refusal_reason(value);
            updates::track_operation_finish(&app, &track_id, "error", Some(&reason));
        }
        Err(e) => {
            updates::track_operation_finish(&app, &track_id, "error", Some(e));
        }
    }
    if let Err(error) = &result {
        let _ = fs::write(state.root.join("desktop-server-error.log"), error);
    }
    if let Ok(value) = &result {
        if is_restart_success(value) {
            let _ = fs::write(state.root.join("backend.json"), value.to_string());
            // No stale success UI: navigate main back to Studio updates panel
            // so the shell shows the fresh version immediately.
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

#[tauri::command]
async fn desktop_quit(
    window: WebviewWindow,
    app: tauri::AppHandle,
    force: Option<bool>,
    cancel_current: Option<bool>,
) -> Result<serde_json::Value, String> {
    update_window_only(&window, &app)?;
    let force = force.unwrap_or(false);
    cancel_interruptible_and_wait(&app, cancel_current.unwrap_or(false)).await?;
    let updates = app.state::<updates::Updates>();
    let _operation = updates::begin(&updates)?;
    let track_id = updates::track_operation_start(&app, "quit", "working", false)?;
    let state = app.state::<Desktop>();
    if state.starting.swap(true, Ordering::SeqCst) {
        updates::track_operation_finish(&app, &track_id, "error", Some("update_busy"));
        return Err("update_busy".into());
    }
    let resources = state.resources.clone();
    let options = quit_control_options(&resources, &state.root, state.port, force);
    let result = tauri::async_runtime::spawn_blocking(move || run_desktop_control(&resources, &options))
        .await
        .map_err(|_| "server_stop_failed".to_string())
        .and_then(|r| r);
    state.starting.store(false, Ordering::SeqCst);
    // Done only on stopped/already-stopped, else terminal error with reason.
    // Real helpers is_quit_terminated + refusal reason avoid inline duplication.
    match &result {
        Ok(v) => {
            let stopped = v.get("stopped").and_then(|s| s.as_bool()).unwrap_or(false);
            let reason = v.get("reason").and_then(|r| r.as_str());
            if is_quit_terminated(stopped, reason) {
                updates::track_operation_finish(&app, &track_id, "done", None);
            } else {
                let code = reason.unwrap_or("quit_failed");
                updates::track_operation_finish(&app, &track_id, "error", Some(code));
            }
        }
        Err(e) => {
            updates::track_operation_finish(&app, &track_id, "error", Some(e));
        }
    }
    // Control delivered: absent server returns {stopped:false, reason:already-stopped}.
    // Treat already-stopped as terminated for Quit (nothing to stop, safe to exit).
    match &result {
        Ok(value) => {
            let stopped = value.get("stopped").and_then(|s| s.as_bool()).unwrap_or(false);
            let reason = value.get("reason").and_then(|r| r.as_str());
            if is_quit_terminated(stopped, reason) {
                app.exit(0);
                return Ok(value.clone());
            }
            Ok(value.clone())
        }
        Err(error) => {
            let _ = fs::write(state.root.join("desktop-server-error.log"), error);
            Err(error.clone())
        }
    }
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
            updates::desktop_update_operation,
            updates::desktop_update_cancel,
            desktop_server_restart,
            desktop_quit,
            desktop_port_state,
            desktop_port_set,
            directory_picker::desktop_pick_directory,
            updates::desktop_update_check,
            updates::desktop_update_install,
            notifications::desktop_notification_preferences
        ])
        .setup(|app| {
            let root = plain_path(
                std::env::var_os("PRIME_STUDIO_DESKTOP_DATA_ROOT")
                    .map(PathBuf::from)
                    .unwrap_or(app.path().app_local_data_dir()?),
            );
            let mut resources = plain_path(app.path().resource_dir()?.join("backend"));
            if cfg!(debug_assertions) && !resources.join("node.exe").is_file() {
                resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.desktop-build");
            }
            // Preferred port first: explicit env override wins (strict, no
            // fallback) over the persisted preference (default 3088).
            // Stable error: `port_invalid` for any bad override value.
            let env_port = match desktop_port::env_port_override() {
                Ok(port) => port,
                Err(code) => {
                    let _ = fs::write(root.join("desktop-error.log"), &code);
                    return Err(code.into());
                }
            };
            let prefs: Preferences = fs::read(root.join("desktop.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
            let preferred = match env_port {
                Some(port) => port,
                None => desktop_port::preferred_port(prefs.port),
            };
            let env_override = env_port.is_some();
            // Effective port BEFORE the exact-origin capability is
            // registered: reserved 3088 (EACCES) and foreign occupants fall
            // through to spaced alternatives, then an OS ephemeral port.
            // A healthy Studio on the preferred port is reused; a live
            // server we own on another port (backend.json hint verified by
            // instance identity against data/server.json) is reused so two
            // writers never share one data root.
            let (port, _moved_from) = if env_override {
                (preferred, None)
            } else {
                desktop_port::resolve_effective_port(&root, preferred)
            };
            // Only these commands cross into the exact local Studio origin.
            // No general filesystem, shell, opener or launcher settings permissions.
            // Operation getter/cancel live in the worker update_operation module;
            // permissions are pre-registered here so the worker only adds the file.
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("studio-updates")
                    .window("main")
                    .remote(format!("http://127.0.0.1:{port}/*"))
                    .permission("allow-desktop-update-status")
                    .permission("allow-desktop-update-operation")
                    .permission("allow-desktop-update-cancel")
                    .permission("allow-desktop-components-open")
                    .permission("allow-desktop-components")
                    .permission("allow-desktop-components-cancel")
                    .permission("allow-desktop-state")
                    .permission("allow-desktop-autostart")
                    .permission("allow-desktop-server-restart")
                    .permission("allow-desktop-quit")
                    .permission("allow-desktop-port-state")
                    .permission("allow-desktop-port-set")
                    .permission("allow-desktop-pick-directory")
                    .permission("allow-desktop-notification-preferences")
                    .permission("allow-desktop-update-check")
                    .permission("allow-desktop-update-install"),
            )?;
            let webview_data = root.join("webview");
            let window_file = root.join(window_state::FILE);
            let error_log = root.join("desktop-error.log");
            app.manage(Desktop {
                root,
                resources,
                port,
                preferred_port: preferred,
                env_override,
                prefs: Mutex::new(prefs),
                starting: AtomicBool::new(false),
                restart_phase: Mutex::new(None),
            });
            // Persistent fallback: when the resolver moved away from the
            // preference, store the effective port so the next launch serves
            // the same origin instead of flip-flopping. Desktop keeps the
            // original preference for this launch's movedFrom notice. A
            // failed write is logged, never fatal: worst case the next
            // launch re-resolves.
            if desktop_port::persisted_effective_port(preferred, port, env_override).is_some() {
                let state = app.state::<Desktop>();
                match state.prefs.lock() {
                    Ok(mut guard) => {
                        guard.port = Some(port);
                        if let Err(error) = save_preferences(&state, &guard) {
                            let _ = fs::write(&error_log, &error);
                        }
                    }
                    Err(error) => {
                        let _ = fs::write(&error_log, error.to_string());
                    }
                };
            }
            app.manage(LauncherOrigin::default());
            let handle = app.handle().clone();
            let navigation_app = handle.clone();
            let studio_entered = AtomicBool::new(false);
            let links_app = handle.clone();
            let background = std::env::args().any(|arg| arg == "--background");
            let main_window = WebviewWindowBuilder::new(
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
            // Shown once its saved position and size are applied.
            .visible(false)
            .data_directory(webview_data)
            // Otherwise Windows consumes file drops before the HTML composer.
            .disable_drag_drop_handler()
            .initialization_script(
                "Object.defineProperty(window, '__PRIME_STUDIO_DESKTOP__', { value: true }); Object.defineProperty(window, '__PRIME_STUDIO_DIRECTORY_PICKER__', { value: true }); Object.defineProperty(window, '__PRIME_STUDIO_NOTIFICATIONS__', { value: true }); Object.defineProperty(window, '__PRIME_STUDIO_COMPONENTS__', { value: true });",
            )
            .on_new_window(move |url, _| {
                open_external_link(&links_app, &url);
                tauri::webview::NewWindowResponse::Deny
            })
            .on_navigation(move |url| {
                if is_studio_url(url, port) {
                    studio_entered.store(true, Ordering::Relaxed);
                    return true;
                }
                if is_launcher_url(url) {
                    return allow_launcher_navigation(url, studio_entered.load(Ordering::Relaxed));
                }
                open_external_link(&navigation_app, url);
                false
            })
            .build()?;
            let saved = window_state::load(&window_file)
                .map(|saved| window_state::restore(&main_window, saved));
            let maximize = saved.is_some_and(|saved| saved.maximized);
            app.manage(window_state::Tracker::new(
                window_file,
                saved,
                background && maximize,
            ));
            if !background {
                if maximize {
                    let _ = main_window.maximize();
                }
                let _ = main_window.show();
            }
            // Record the real launcher origin once (correct custom protocol for
            // this platform). Fallback shell navigation reuses it instead of a
            // hardcoded scheme that WebView2 may not resolve.
            if let Some(main) = app.get_webview_window("main") {
                if let Ok(url) = main.url() {
                    if is_launcher_url(&url) {
                        let origin = format!(
                            "{}://{}",
                            url.scheme(),
                            url.host_str().unwrap_or("localhost")
                        );
                        if let Some(state) = app.try_state::<LauncherOrigin>() {
                            if let Ok(mut guard) = state.origin.lock() {
                                *guard = Some(origin);
                            }
                        }
                    }
                }
            }
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
                    "Préférences du Studio"
                } else {
                    "Studio preferences"
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
                    // Quit never exits directly: confirmation lives inside main
                    // via studio:quit-request, then desktop_quit stops the
                    // server first. Close (X) stays hide, never stop.
                    "quit" => request_quit_confirmation(app),
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
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                        window_state::track(window)
                    }
                    _ => (),
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Prime Agent Studio desktop failed");
}
