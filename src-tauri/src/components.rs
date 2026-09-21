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
    pub(crate) input: Mutex<Option<ChildStdin>>,
}
impl Components {
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}
pub fn is_component_action_allowed(action: &str) -> bool {
    matches!(
        action,
        "status" | "diagnose" | "install" | "prepare" | "select" | "activate" | "apply"
    )
}
pub fn is_component_action_readonly(action: &str) -> bool {
    // Read-only checks never mutate shared state: no Updates guard, no
    // Components busy, no global child stdin, no tracker report. They read
    // atomic files and probe the OS only through a readonly child.
    // Mutations (install/prepare/select/activate/apply) stay serialized.
    matches!(action, "status" | "diagnose")
}
pub(crate) struct ComponentsBusyGuard<'a> {
    state: &'a Components,
}
impl<'a> ComponentsBusyGuard<'a> {
    pub(crate) fn claim(state: &'a Components) -> Result<Self, String> {
        if state.busy.swap(true, Ordering::SeqCst) {
            return Err("setup_busy".into());
        }
        Ok(Self { state })
    }
}
impl Drop for ComponentsBusyGuard<'_> {
    fn drop(&mut self) {
        // RAII: reset on EVERY return path (including tracker start errors),
        // even if the input lock is poisoned. Never leave a permanent busy.
        // Clearing the global stdin handle also releases any owned child pipe.
        if let Ok(mut input) = self.state.input.lock() {
            *input = None;
        }
        self.state.busy.store(false, Ordering::SeqCst);
    }
}

// Async (thread-pool) on purpose: opening/focusing settings from inside
// the Studio WebView IPC callback must not run re-entrantly on the WebView2 thread.
// Single window: recovery flag maps to the same main shell, never a second window.
// Opening settings never touches the server, so agents keep running.
#[tauri::command]
pub async fn desktop_components_open(
    window: WebviewWindow,
    app: tauri::AppHandle,
    _recovery: Option<bool>,
) -> Result<(), String> {
    super::update_window_only(&window, &app)?;
    super::show_settings(&app)?;
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

// Read-only probe: no Updates guard, no Components busy, no global child
// stdin, no tracker report. Spawns the helper with piped stdout only and
// collects its result/failure lines. Never navigates, never writes shared
// state, so isBusy stays false and a failed snapshot is never overwritten.
async fn run_components_readonly(
    app: &tauri::AppHandle,
    action: &str,
) -> Result<serde_json::Value, String> {
    let (resources, root, port, legacy) = {
        let desktop = app.state::<super::Desktop>();
        let prefs = desktop
            .prefs
            .lock()
            .map_err(|_| "preparation_failed")?;
        (
            desktop.resources.clone(),
            desktop.root.clone(),
            desktop.port,
            prefs.legacy_root.clone(),
        )
    };
    let options = serde_json::json!({
        "action": action,
        "dataRoot": root,
        "resourceDir": resources,
        "port": port,
        "legacyRoot": legacy,
    });
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(resources.join("node.exe"));
        command
            .arg(resources.join("studio/scripts/desktop-components.mjs"))
            .arg(options.to_string())
            .current_dir(&resources)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| "preparation_failed".to_owned())?;
        let mut result = Err("preparation_failed".to_owned());
        for line in BufReader::new(child.stdout.take().ok_or("preparation_failed")?).lines() {
            let line = line.map_err(|_| "preparation_failed")?;
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            match value["type"].as_str() {
                Some("result") => {
                    result = Ok(value["result"].clone());
                }
                Some("failure") => {
                    result = Ok(serde_json::json!({"failure": value}));
                }
                _ => {}
            }
        }
        let _ = child.wait();
        result
    })
    .await
    .map_err(|_| "preparation_failed".to_owned())
    .and_then(|r| r)
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
    if !is_component_action_allowed(&action) {
        return Err("action_invalid".into());
    }
    // Read-only checks never take the Updates guard, never claim Components
    // busy, never touch the global child stdin and never report to the tracker.
    // A failed operation snapshot survives settings opens and no fictive busy
    // blocks check during CIM. isBusy stays false on this path.
    if is_component_action_readonly(&action) {
        return run_components_readonly(&app, &action).await;
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
    // RAII guard: EVERY early return below (including tracker start errors)
    // resets busy and clears the global stdin handle via Drop. The previous
    // swap-then-track-? sequence could leave a permanent busy on tracker Err.
    let _busy_guard = ComponentsBusyGuard::claim(&state)?;
    let on_progress: Option<Channel<serde_json::Value>> =
        on_progress.map(|id| id.channel_on(window.as_ref().clone()));
    let worker_app = app.clone();
    let initiator = window.clone();
    let action_for_done = action.clone();
    // Tracked operation for 1s light poll. Kind prepare for repair flow,
    // components otherwise. Cancellable via stdin cancel + await real busy.
    // Explicit error when tracker reports incoherent active op (never ignore).
    let track_kind = if action == "prepare" { "prepare" } else { "components" };
    let track_id = super::updates::track_operation_start(&app, track_kind, "preparing", true)?;
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
    // The RAII busy guard drops here (reset + stdin cleanup) before the
    // tracker finish below, so settlement is observable right away.
    drop(_busy_guard);
    // Finish tracked operation for 1s poll (done/error/cancelled terminal).
    match &result {
        Ok(v) if v.get("cancelled").and_then(|c| c.as_bool()).unwrap_or(false) => {
            super::updates::track_operation_finish(&app, &track_id, "cancelled", Some("download_cancelled"));
        }
        Ok(v) if v.get("failure").is_some() => {
            let code = v
                .get("failure")
                .and_then(|f| f.get("error"))
                .and_then(|e| e.as_str())
                .unwrap_or("preparation_failed");
            if code == "cancelled" {
                super::updates::track_operation_finish(&app, &track_id, "cancelled", Some("download_cancelled"));
            } else {
                super::updates::track_operation_finish(&app, &track_id, "error", Some(code));
            }
        }
        Ok(_) => {
            super::updates::track_operation_finish(&app, &track_id, "done", None);
        }
        Err(e) if e == "cancelled" || e.contains("cancel") => {
            super::updates::track_operation_finish(&app, &track_id, "cancelled", Some("download_cancelled"));
        }
        Err(e) => {
            super::updates::track_operation_finish(&app, &track_id, "error", Some(e));
        }
    }
    // All helper work is finished. A freshly navigated page must be able to
    // read status immediately, without racing the previous operation's guard.
    drop(_operation);
    if let Ok(value) = &result {
        // Prepare installs/validates without restarting: never auto restart an
        // active agent. Only explicit install/apply with active activation
        // navigates back; prepare leaves the shell to propose one Restart now.
        if value["activation"] == "active" && from_studio && action_for_done != "prepare" {
            let port = app.state::<super::Desktop>().port;
            if let Ok(url) = format!("http://127.0.0.1:{port}/?settings=updates").parse() {
                let _ = initiator.navigate(url);
            }
        }
    }
    result
}
