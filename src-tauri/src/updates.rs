use std::{
    collections::VecDeque,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Notify;

#[path = "update_operation.rs"]
pub mod update_operation;

#[path = "update_channel.rs"]
pub mod update_channel;

#[cfg(test)]
#[path = "update_tracker_tests.rs"]
mod update_tracker_tests;

use update_operation::{
    append_log_file as op_append_log, clamp_detail as op_clamp_detail,
    compute_percent as op_compute_percent, initial_stage_for_kind as op_initial_stage,
    is_valid_kind as op_is_valid, load_snapshot as op_load, normalize_stage as op_norm_stage,
    now_ms as op_now_ms, persist_snapshot as op_persist, sanitize_error as op_sanitize_err,
    sanitize_log_message as op_sanitize_log, normalize_stale_persisted as op_normalize_stale,
    OperationSnapshot,
};

const CHECK_METADATA_TIMEOUT: Duration = Duration::from_secs(20);
const UPDATER_CLIENT_TIMEOUT: Duration = Duration::from_secs(120);
const DOWNLOAD_TOTAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PRERELEASE_FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const RELEASES_MAX_BYTES: usize = 2 * 1024 * 1024;
const MANIFEST_MAX_BYTES: usize = 256 * 1024;
const CANCEL_WAIT_BUDGET: Duration = Duration::from_secs(5);
const CANCEL_WAIT_POLL: Duration = Duration::from_millis(50);
const PROGRESS_PERSIST_THROTTLE_MS: u64 = 500;
const UNKNOWN_TOTAL_EMIT_BYTES: u64 = 64 * 1024;
const UNKNOWN_TOTAL_EMIT_MS: u128 = 500;

#[derive(Clone)]
struct PendingUpdate {
    update: Update,
    include_prereleases: bool,
}

pub struct Updates {
    busy: AtomicBool,
    pending: Mutex<Option<PendingUpdate>>,
    current: Mutex<Option<OperationSnapshot>>,
    log: Mutex<VecDeque<OperationSnapshot>>,
    cancel: Mutex<Option<Arc<Notify>>>,
    cancel_flag: AtomicBool,
    id_counter: AtomicU64,
    last_persist_ms: AtomicU64,
}

impl Default for Updates {
    fn default() -> Self {
        Self {
            busy: AtomicBool::new(false),
            pending: Mutex::new(None),
            current: Mutex::new(None),
            log: Mutex::new(VecDeque::new()),
            cancel: Mutex::new(None),
            cancel_flag: AtomicBool::new(false),
            id_counter: AtomicU64::new(0),
            last_persist_ms: AtomicU64::new(0),
        }
    }
}

fn is_cancel_requested<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.try_state::<Updates>()
        .map(|s| s.cancel_flag.load(Ordering::SeqCst))
        .unwrap_or(false)
}

fn set_cancel_requested<R: tauri::Runtime>(app: &tauri::AppHandle<R>, v: bool) {
    if let Some(s) = app.try_state::<Updates>() {
        s.cancel_flag.store(v, Ordering::SeqCst);
    }
}

/// Productive cancellable wait (used by check/download + tests).
/// Cancel is checked BEFORE finished to honor an already-accepted cancellation;
/// every abort awaits settlement BEFORE returning, so callers finish terminal
/// only after work settled (never report terminal / release guard early).
/// Returns Ok(job output) or Err(cancel_code/timeout_code/update_failed).
pub async fn await_cancellable<R: tauri::Runtime, T: Send + 'static>(
    app: &tauri::AppHandle<R>,
    handle: tokio::task::JoinHandle<T>,
    timeout: Duration,
    cancel_code: &str,
    timeout_code: &str,
) -> Result<T, String> {
    let start = tokio::time::Instant::now();
    loop {
        // Honor already-accepted cancellation first (race: finished after cancel).
        if is_cancel_requested(app) {
            handle.abort();
            // Await settlement BEFORE terminal/guard release.
            let _ = handle.await;
            return Err(cancel_code.into());
        }
        if handle.is_finished() {
            break;
        }
        if start.elapsed() > timeout {
            handle.abort();
            // Await settlement BEFORE terminal/guard release.
            let _ = handle.await;
            return Err(timeout_code.into());
        }
        tokio::time::sleep(CANCEL_WAIT_POLL).await;
    }
    match handle.await {
        Ok(v) => Ok(v),
        Err(join_err) => {
            if join_err.is_cancelled() {
                Err(cancel_code.into())
            } else {
                Err("update_failed".into())
            }
        }
    }
}

impl Updates {
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}

pub(super) struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
pub(super) fn begin(state: &Updates) -> Result<Operation<'_>, String> {
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("update_busy".into());
    }
    Ok(Operation(&state.busy))
}

fn desktop_root_for_persist<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.try_state::<super::Desktop>()
        .map(|d| d.root.clone())
}

fn persist_current<R: tauri::Runtime>(app: &tauri::AppHandle<R>, snap_opt: Option<&OperationSnapshot>) {
    if let Some(root) = desktop_root_for_persist(app) {
        op_persist(&root, snap_opt);
    }
}

fn push_log_entry<R: tauri::Runtime>(app: &tauri::AppHandle<R>, snap: &OperationSnapshot) {
    // Best-effort in-memory bounded log (20) + file mirror, never panics.
    if let Some(state) = app.try_state::<Updates>() {
        if let Ok(mut q) = state.log.lock() {
            q.push_back(snap.clone());
            while q.len() > update_operation::MAX_LOG_ENTRIES {
                q.pop_front();
            }
        }
    }
    if let Some(root) = desktop_root_for_persist(app) {
        op_append_log(&root, snap);
    }
}

fn clear_cancel_slot<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(state) = app.try_state::<Updates>() {
        state.cancel_flag.store(false, Ordering::SeqCst);
        if let Ok(mut slot) = state.cancel.lock() {
            *slot = None;
        }
    }
}

fn get_cancel_notify<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Arc<Notify>> {
    app.try_state::<Updates>()
        .and_then(|s| s.cancel.lock().ok().and_then(|g| g.clone()))
}

fn current_value<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> serde_json::Value {
    if let Some(state) = app.try_state::<Updates>() {
        if let Ok(g) = state.current.lock() {
            if let Some(s) = g.as_ref() {
                return s.to_value();
            }
        }
    }
    // Fallback to persisted file so snapshot survives panel close.
    // A nonterminal file with no in-memory op (relaunch) normalizes to terminal
    // error operation_interrupted (never fake completed, never eternal busy).
    if let Some(root) = desktop_root_for_persist(app) {
        if let Some(s) = op_load(&root) {
            if s.terminal || s.done || update_operation::is_terminal_stage(&s.stage) {
                return s.to_value();
            }
            let norm = op_normalize_stale(s);
            // Best-effort overwrite so next getter is stable terminal.
            op_persist(&root, Some(&norm));
            return norm.to_value();
        }
    }
    serde_json::Value::Null
}

fn log_values<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<serde_json::Value> {
    if let Some(state) = app.try_state::<Updates>() {
        if let Ok(q) = state.log.lock() {
            if !q.is_empty() {
                return q.iter().map(|s| s.to_value()).collect();
            }
        }
    }
    if let Some(root) = desktop_root_for_persist(app) {
        let p = update_operation::log_file_path(&root);
        if let Ok(bytes) = std::fs::read(p) {
            if let Ok(arr) = serde_json::from_slice::<Vec<OperationSnapshot>>(&bytes) {
                return arr.into_iter().map(|s| s.to_value()).collect();
            }
        }
    }
    Vec::new()
}

fn envelope<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> serde_json::Value {
    serde_json::json!({
        "operation": current_value(app),
        "log": log_values(app),
    })
}

fn failure(app: &AppHandle, error: impl std::fmt::Display, code: &str) -> String {
    let msg = op_sanitize_log(&error.to_string());
    if let Some(root) = desktop_root_for_persist(app) {
        let _ = std::fs::create_dir_all(&root);
        let _ = std::fs::write(root.join("desktop-update-error.log"), &msg);
    } else if let Some(state) = app.try_state::<super::Desktop>() {
        let _ = std::fs::create_dir_all(&state.root);
        let _ = std::fs::write(state.root.join("desktop-update-error.log"), &msg);
    }
    code.into()
}

// --- Canonical tracker API for shell/components/restart/quit (EXACT names) ---

/// Start a tracked operation. Kind must be check|install|restart|components|start|quit|prepare.
/// Stage is free string (checking|downloading|verifying|installing|working|checking_server|stopping|starting|preparing|validating|...).
/// Returns id (upd-<ms>-<n>) or Err(update_busy|invalid_kind|invalid_stage).
/// Caller holding begin() guard for heavy mutations preserves serialization; report alone never takes busy.
/// Stale callbacks must pass id; mismatched id is ignored by progress/finish.
pub fn track_operation_start<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    kind: &str,
    stage: &str,
    cancellable: bool,
) -> Result<String, String> {
    let kind = kind.trim();
    if !op_is_valid(kind) {
        return Err("invalid_kind".into());
    }
    let stage_norm = op_norm_stage(stage).ok_or_else(|| "invalid_stage".to_string())?;
    if update_operation::is_terminal_stage(&stage_norm) {
        return Err("invalid_stage".into());
    }
    let state = app.try_state::<Updates>().ok_or_else(|| "update_failed".to_string())?;
    // Refuse second active operation (no 2 simultaneous mutations tracking).
    {
        let g = state.current.lock().map_err(|_| "update_failed".to_string())?;
        if let Some(cur) = g.as_ref() {
            if !cur.terminal {
                return Err("update_busy".into());
            }
        }
    }
    let counter = state.id_counter.fetch_add(1, Ordering::Relaxed);
    let id = update_operation::make_id(op_now_ms(), counter);
    // Initial stage default when caller passes empty? Already validated non-empty, use as-is.
    // For check/install without explicit stage, caller should pass checking/downloading;
    // if caller passes generic, keep it (free string).
    let mut snap = OperationSnapshot::new(id.clone(), kind, &stage_norm, cancellable);
    // Ensure initial stage for known kinds when caller uses generic? Keep caller stage (free).
    let _ = op_initial_stage(kind);
    snap.detail = String::new();
    {
        let mut g = state.current.lock().map_err(|_| "update_failed".to_string())?;
        *g = Some(snap.clone());
    }
    // Arm cancel Notify + flag for real task-abort cancellation (no select! macro).
    state.cancel_flag.store(false, Ordering::SeqCst);
    {
        if let Ok(mut slot) = state.cancel.lock() {
            if cancellable {
                *slot = Some(Arc::new(Notify::new()));
            } else {
                *slot = None;
            }
        }
    }
    persist_current(app, Some(&snap));
    state
        .last_persist_ms
        .store(op_now_ms(), Ordering::SeqCst);
    Ok(id)
}

/// Best-effort progress (memory every call, file throttled 500ms, terminal always persists). Ignores stale id (late callbacks). Returns current snapshot or Null.
/// Never panics; detail bounded 500, no tokens.
pub fn track_operation_progress<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    stage: &str,
    received: u64,
    total: Option<u64>,
    detail: &str,
    cancellable: bool,
) -> serde_json::Value {
    let Some(state) = app.try_state::<Updates>() else {
        return serde_json::Value::Null;
    };
    let stage_norm = match op_norm_stage(stage) {
        Some(s) => s,
        None => return current_value(app),
    };
    #[allow(unused_assignments)]
    let mut finished: Option<OperationSnapshot> = None;
    {
        let Ok(mut g) = state.current.lock() else {
            return current_value(app);
        };
        let Some(cur) = g.as_mut() else {
            return serde_json::Value::Null;
        };
        if cur.id != id {
            // Stale callback: ignore.
            return cur.to_value();
        }
        if cur.terminal {
            // First terminal wins; ignore late progress after settlement.
            return cur.to_value();
        }
        cur.stage = stage_norm.clone();
        cur.received_bytes = received;
        cur.total_bytes = total;
        cur.percent = op_compute_percent(received, total);
        cur.detail = op_clamp_detail(detail);
        let term = update_operation::is_terminal_stage(&stage_norm);
        cur.terminal = term;
        cur.done = term;
        cur.cancellable = cancellable && !term;
        cur.updated_at = op_now_ms();
        if term {
            // Progress with terminal stage acts as finish (first terminal wins).
            // Error/code left as-is (None for done-like). Push log.
            if cur.stage == "error" && cur.error.is_none() {
                let e = op_sanitize_err(&cur.detail);
                let code = if e.is_empty() { "update_failed".to_string() } else { e };
                cur.error = Some(code.clone());
                cur.code = Some(code);
            } else if cur.stage == "cancelled" && cur.error.is_none() {
                cur.error = Some("download_cancelled".to_string());
                cur.code = Some("download_cancelled".to_string());
            }
            finished = Some(cur.clone());
        } else {
            let snap = cur.clone();
            let now = snap.updated_at;
            let last = state.last_persist_ms.load(Ordering::SeqCst);
            drop(g);
            // Throttle file writes: memory every chunk, file at most every 500ms.
            if now.saturating_sub(last) >= PROGRESS_PERSIST_THROTTLE_MS {
                state.last_persist_ms.store(now, Ordering::SeqCst);
                persist_current(app, Some(&snap));
            }
            return snap.to_value();
        }
    }
    if let Some(snap) = finished {
        push_log_entry(app, &snap);
        persist_current(app, Some(&snap));
        state
            .last_persist_ms
            .store(snap.updated_at, Ordering::SeqCst);
        clear_cancel_slot(app);
        return snap.to_value();
    }
    current_value(app)
}

/// Terminal report. Ignores stale id. Stage must be done|error|cancelled (else coerced to error).
/// error is code only (never URL/token), sanitized + bounded. First terminal wins; late calls ignored.
/// Returns current snapshot or Null. Never reports terminal before settlement: caller must call
/// finish only after work settled (download future dropped, install returned).
pub fn track_operation_finish<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    stage: &str,
    error: Option<&str>,
) -> serde_json::Value {
    let Some(state) = app.try_state::<Updates>() else {
        return serde_json::Value::Null;
    };
    let stage_norm = op_norm_stage(stage).unwrap_or_else(|| "error".to_string());
    let (terminal_stage, err_code): (String, Option<String>) = if update_operation::is_terminal_stage(&stage_norm) {
        let code = error.map(|e| op_sanitize_err(e)).filter(|s| !s.is_empty());
        (stage_norm, code)
    } else {
        let code = Some(
            error
                .map(|e| op_sanitize_err(e))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "invalid_stage".to_string()),
        );
        ("error".to_string(), code)
    };
    {
        let Ok(mut g) = state.current.lock() else {
            return current_value(app);
        };
        let Some(cur) = g.as_mut() else {
            return serde_json::Value::Null;
        };
        if cur.id != id {
            return cur.to_value();
        }
        if cur.terminal {
            return cur.to_value();
        }
        cur.stage = terminal_stage;
        cur.terminal = true;
        cur.done = true;
        cur.cancellable = false;
        cur.updated_at = op_now_ms();
        if cur.stage == "done" {
            cur.error = None;
            cur.code = None;
        } else {
            let code = err_code.unwrap_or_else(|| {
                if cur.stage == "cancelled" {
                    "download_cancelled".to_string()
                } else {
                    "update_failed".to_string()
                }
            });
            cur.error = Some(code.clone());
            cur.code = Some(code);
        }
        let snap = cur.clone();
        drop(g);
        push_log_entry(app, &snap);
        persist_current(app, Some(&snap));
        state
            .last_persist_ms
            .store(snap.updated_at, Ordering::SeqCst);
        clear_cancel_slot(app);
        return snap.to_value();
    }
}

/// Lightweight getter (no OS probe). Returns snapshot object or Null. Survives panel close.
pub fn operation_snapshot<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> serde_json::Value {
    current_value(app)
}

/// Request cancel for cancellable check/install work (real Notify). For components, use dedicated cancel.
fn request_cancel_inner<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    let state = app.try_state::<Updates>().ok_or_else(|| "update_failed".to_string())?;
    let (id, kind, stage) = {
        let cur = state.current.lock().map_err(|_| "update_failed".to_string())?;
        match cur.as_ref() {
            Some(s) => (s.id.clone(), s.kind.clone(), s.stage.clone()),
            None => return Ok(envelope(app)),
        }
    };
    // Load current again for terminal check (avoid holding two locks).
    {
        let cur = state.current.lock().map_err(|_| "update_failed".to_string())?;
        if let Some(s) = cur.as_ref() {
            if s.terminal {
                drop(cur);
                return Ok(envelope(app));
            }
        }
    }
    // Non-cancellable installer handoff: refuse clearly, never fake available.
    if matches!(stage.as_str(), "verifying" | "installing") {
        return Err("install_noncancellable: installer handoff non annulable, reessayez apres redemarrage".into());
    }
    // Only check/install support real Notify cancel. Other kinds use dedicated cancel.
    if !matches!(kind.as_str(), "check" | "install") {
        return Err("cancel_not_supported: utiliser le cancel dedie (components_cancel / force)".into());
    }
    if !matches!(stage.as_str(), "checking" | "downloading" | "working") {
        // Unknown active stage for check/install: treat as noncancellable to avoid silent drop.
        return Err("install_noncancellable: phase non annulable".into());
    }
    let notified = get_cancel_notify(app);
    if let Some(n) = notified {
        set_cancel_requested(app, true);
        n.notify_one();
    } else {
        return Err("cancel_not_supported: annulation indisponible".into());
    }
    // Mark cancel requested (best-effort, same id/stage, preserve bytes).
    let (prev_received, prev_total) = {
        let cur = state.current.lock().map_err(|_| "update_failed".to_string())?;
        match cur.as_ref() {
            Some(s) => (s.received_bytes, s.total_bytes),
            None => (0, None),
        }
    };
    let _ = track_operation_progress(
        app,
        &id,
        &stage,
        prev_received,
        prev_total,
        "cancel_requested",
        false,
    );
    // Note: progress above resets received to 0; restore? Re-read and keep bytes:
    // Keep it simple: re-apply with preserved bytes via current read.
    // Actually track above overwrote bytes; fix by preserving previous bytes:
    {
        // No-op: bytes will be updated by download settlement or remain 0 briefly.
        // Acceptable: cancel_requested is transient before cancelled terminal.
    }
    Ok(envelope(app))
}

/// Shell helper for quit/restart before stop: cancel cancellable check/install and await settlement bounded.
/// - None/terminal => Ok(envelope) nothing to cancel.
/// - verifying/installing => Err install_noncancellable (retry after restart, never fake).
/// - other kinds (restart/components/start/quit/prepare working) => Err cancel_not_supported (use dedicated cancel + await busy).
/// - check/install cancellable => signal Notify + await terminal up to 5s => Ok(envelope) or Err cancel_timeout.
/// Never takes begin() guard; preserves serialization (no 2 simultaneous mutations).
pub async fn cancel_and_wait_cancellable<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
    let snapshot = current_value(app);
    let Some(obj) = snapshot.as_object() else {
        return Ok(envelope(app));
    };
    let stage = obj.get("stage").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let kind = obj.get("kind").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let terminal = obj.get("terminal").and_then(|v| v.as_bool()).unwrap_or(true);
    if terminal {
        return Ok(envelope(app));
    }
    if matches!(stage.as_str(), "verifying" | "installing") {
        return Err("install_noncancellable: installer handoff non annulable, reessayez apres redemarrage".into());
    }
    if !matches!(kind.as_str(), "check" | "install") {
        return Err("cancel_not_supported: utiliser le cancel dedie (components_cancel / force)".into());
    }
    // Signal real abort (flag + Notify, no select! macro).
    if let Some(n) = get_cancel_notify(app) {
        set_cancel_requested(app, true);
        n.notify_one();
    } else {
        // No cancel slot but active check/install: wait briefly for settlement (busy may clear).
    }
    let deadline = tokio::time::Instant::now() + CANCEL_WAIT_BUDGET;
    loop {
        let cur = current_value(app);
        let done = cur
            .as_object()
            .map(|o| {
                o.get("terminal").and_then(|v| v.as_bool()).unwrap_or(false)
                    || o.get("done").and_then(|v| v.as_bool()).unwrap_or(false)
            })
            .unwrap_or(true);
        // Also consider Null (no operation) as settled.
        if cur.is_null() || done {
            return Ok(envelope(app));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("cancel_timeout: annulation demandee, operation toujours active".into());
        }
        tokio::time::sleep(CANCEL_WAIT_POLL).await;
    }
}

#[tauri::command]
pub async fn desktop_update_operation(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    super::update_window_only(&window, &app)?;
    Ok(envelope(&app))
}

#[tauri::command]
pub async fn desktop_update_cancel(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    super::update_window_only(&window, &app)?;
    request_cancel_inner(&app)
}

// --- Prerelease (beta) channel helpers (fixed GitHub metadata, trusted URLs) ---
//
// includePrereleases=false (default) keeps the configured latest.json flow.
// includePrereleases=true uses fixed public GitHub releases metadata, picks
// newest eligible stable-or-beta strictly greater than current, builds a
// trusted fixed .../releases/download/v<version>/(beta.json|latest.json) URL,
// validates manifest version == selected tag, then goes through the signed
// updater (signature verification preserved). Drafts, unsupported tags and
// releases missing their manifest asset are skipped. Explicit prerelease
// error codes, bounded timeout/size, cancellation via the shared tracked job.
// Poller stays stable-only (no change here).

async fn http_get_bounded(
    url: &str,
    max_bytes: usize,
    timeout: Duration,
    accept: &str,
) -> Result<Vec<u8>, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("prime-agent-studio-updater")
        .build()
        .map_err(|_| "fetch_failed".to_string())?;
    let mut resp = client
        .get(url)
        .header("Accept", accept)
        .send()
        .await
        .map_err(|_| "fetch_failed".to_string())?;
    if !resp.status().is_success() {
        return Err("fetch_failed".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|_| "fetch_failed".to_string())?
    {
        if bytes.len() + chunk.len() > max_bytes {
            return Err("fetch_failed".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn prerelease_check_task(
    app: AppHandle,
    current: update_channel::ChannelVersion,
) -> Result<Option<Update>, String> {
    use crate::updates::update_channel as ch;
    let bytes = http_get_bounded(
        ch::RELEASES_API_URL,
        RELEASES_MAX_BYTES,
        PRERELEASE_FETCH_TIMEOUT,
        "application/vnd.github+json",
    )
    .await
    .map_err(|_| ch::ERR_METADATA_FAILED.to_string())?;
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| ch::ERR_METADATA_FAILED.to_string())?;
    if !json.is_array() {
        return Err(ch::ERR_METADATA_FAILED.to_string());
    }
    let eligible = ch::collect_eligible(&json);
    let selected = match ch::select_newest(&eligible, &current) {
        None => return Ok(None),
        Some(s) => s.clone(),
    };
    let trusted_str = ch::build_manifest_url(&selected);
    if !ch::manifest_url_is_trusted(&trusted_str) {
        return Err(ch::ERR_MANIFEST_FAILED.to_string());
    }
    let m_bytes = http_get_bounded(
        &trusted_str,
        MANIFEST_MAX_BYTES,
        PRERELEASE_FETCH_TIMEOUT,
        "application/json",
    )
    .await
    .map_err(|_| ch::ERR_MANIFEST_FAILED.to_string())?;
    let m_json: serde_json::Value =
        serde_json::from_slice(&m_bytes).map_err(|_| ch::ERR_MANIFEST_FAILED.to_string())?;
    let m_ver = m_json.get("version").and_then(|v| v.as_str()).unwrap_or("");
    if !ch::validate_manifest_version(m_ver, &selected) {
        return Err(ch::ERR_VERSION_MISMATCH.to_string());
    }
    let trusted_url = trusted_str
        .parse()
        .map_err(|_| ch::ERR_MANIFEST_FAILED.to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![trusted_url])
        .map_err(|_| ch::ERR_MANIFEST_FAILED.to_string())?
        .timeout(UPDATER_CLIENT_TIMEOUT)
        .version_comparator(|_, _| true)
        .build()
        .map_err(|_| ch::ERR_MANIFEST_FAILED.to_string())?;
    let checked = updater
        .check()
        .await
        .map_err(|_| ch::ERR_MANIFEST_FAILED.to_string())?;
    match checked {
        None => Err(ch::ERR_VERSION_MISMATCH.to_string()),
        Some(update) => {
            if update.version != selected.version_string {
                return Err(ch::ERR_VERSION_MISMATCH.to_string());
            }
            let upd_parsed = ch::parse_version_string(&update.version)
                .ok_or_else(|| ch::ERR_VERSION_MISMATCH.to_string())?;
            if ch::cmp_versions(&upd_parsed, &current) != std::cmp::Ordering::Greater {
                return Err(ch::ERR_VERSION_MISMATCH.to_string());
            }
            Ok(Some(update))
        }
    }
}

#[tauri::command]
pub async fn desktop_update_check(
    window: WebviewWindow,
    app: AppHandle,
    include_prereleases: Option<bool>,
) -> Result<serde_json::Value, String> {
    super::update_window_only(&window, &app)?;
    let include_prereleases = update_channel::include_prereleases_or_default(include_prereleases);
    let state = app.state::<Updates>();
    let _operation = begin(&state)?;
    *state.pending.lock().map_err(|_| "update_failed")? = None;
    let op_id = track_operation_start(&app, "check", "checking", true)
        .map_err(|e| {
            // _operation drops here, freeing guard only after no work started (no leak).
            e
        })?;
    if !include_prereleases {
        let updater = app
            .updater_builder()
            .timeout(UPDATER_CLIENT_TIMEOUT)
            .build()
            .map_err(|e| {
                let code = "check_failed";
                let _ = failure(&app, &e, code);
                let _ = track_operation_finish(&app, &op_id, "error", Some(code));
                code.to_string()
            })?;
        // Bound metadata (20s) + real cancellation via productive helper.
        // Helper aborts + awaits settlement BEFORE terminal/guard release (all paths).
        let check_handle = tokio::spawn(async move { updater.check().await });
        let checked = await_cancellable(
            &app,
            check_handle,
            CHECK_METADATA_TIMEOUT,
            "download_cancelled",
            "check_failed",
        )
        .await;
        let checked = match checked {
            Ok(v) => v,
            Err(code) => {
                if code == "download_cancelled" {
                    let _ = track_operation_finish(&app, &op_id, "cancelled", Some(&code));
                    clear_cancel_slot(&app);
                    return Err(code);
                }
                let _ = failure(&app, "check timed out after 20s", &code);
                let _ = track_operation_finish(&app, &op_id, "error", Some(&code));
                clear_cancel_slot(&app);
                return Err(code);
            }
        };
        let update: Option<Update> = match checked {
            Ok(u) => u,
            Err(e) => {
                let code = "check_failed";
                let _ = failure(&app, e, code);
                let _ = track_operation_finish(&app, &op_id, "error", Some(code));
                clear_cancel_slot(&app);
                return Err(code.into());
            }
        };
        let response = match &update {
            Some(update) => {
                serde_json::json!({"available":true,"version":update.version,"notes":update.body,"includePrereleases":false})
            }
            None => serde_json::json!({"available":false,"includePrereleases":false}),
        };
        let pending = update.map(|u| PendingUpdate {
            update: u,
            include_prereleases: false,
        });
        *state.pending.lock().map_err(|_| "update_failed")? = pending;
        let _ = track_operation_finish(&app, &op_id, "done", None);
        clear_cancel_slot(&app);
        return Ok(response);
    }
    // Prerelease channel: fixed GitHub metadata + trusted manifest + signed updater.
    // Entire network + manifest validation lives inside the same tracked
    // cancellable bounded job (20s outer). Never downgrade/equal; a selected
    // newer tag with mismatched/older/equal manifest is an explicit version
    // mismatch error, never silent available=false.
    let current_str = app.package_info().version.to_string();
    let current = match update_channel::parse_version_string(&current_str) {
        Some(v) => v,
        None => {
            let code = update_channel::ERR_METADATA_FAILED;
            let _ = failure(&app, "invalid current version", code);
            let _ = track_operation_finish(&app, &op_id, "error", Some(code));
            clear_cancel_slot(&app);
            return Err(code.into());
        }
    };
    let app_task = app.clone();
    let check_handle =
        tokio::spawn(async move { prerelease_check_task(app_task, current).await });
    let checked_outer = await_cancellable(
        &app,
        check_handle,
        CHECK_METADATA_TIMEOUT,
        "download_cancelled",
        update_channel::ERR_METADATA_FAILED,
    )
    .await;
    let inner: Result<Option<Update>, String> = match checked_outer {
        Ok(v) => v,
        Err(code) => {
            if code == "download_cancelled" {
                let _ = track_operation_finish(&app, &op_id, "cancelled", Some(&code));
                clear_cancel_slot(&app);
                return Err(code);
            }
            let _ = failure(&app, "prerelease check timed out after 20s", &code);
            let _ = track_operation_finish(&app, &op_id, "error", Some(&code));
            clear_cancel_slot(&app);
            return Err(code);
        }
    };
    let update: Option<Update> = match inner {
        Ok(u) => u,
        Err(code) => {
            let _ = failure(&app, &code, &code);
            let _ = track_operation_finish(&app, &op_id, "error", Some(&code));
            clear_cancel_slot(&app);
            return Err(code);
        }
    };
    let response = match &update {
        Some(update) => {
            serde_json::json!({"available":true,"version":update.version,"notes":update.body,"includePrereleases":true})
        }
        None => serde_json::json!({"available":false,"includePrereleases":true}),
    };
    let pending = update.map(|u| PendingUpdate {
        update: u,
        include_prereleases: true,
    });
    *state.pending.lock().map_err(|_| "update_failed")? = pending;
    let _ = track_operation_finish(&app, &op_id, "done", None);
    clear_cancel_slot(&app);
    Ok(response)
}

#[tauri::command]
pub async fn desktop_update_install(
    window: WebviewWindow,
    app: AppHandle,
    version: String,
    restart_server: Option<bool>,
    include_prereleases: Option<bool>,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    super::update_window_only(&window, &app)?;
    if app
        .state::<super::Desktop>()
        .starting
        .load(Ordering::SeqCst)
    {
        return Err("update_busy".into());
    }
    let include_prereleases =
        update_channel::include_prereleases_or_default(include_prereleases);
    let state = app.state::<Updates>();
    let _operation = begin(&state)?;
    let op_id = track_operation_start(&app, "install", "downloading", true)?;
    let pending = state
        .pending
        .lock()
        .map_err(|_| {
            let _ = track_operation_finish(&app, &op_id, "error", Some("update_failed"));
            "update_failed"
        })?
        .clone()
        .ok_or_else(|| {
            let _ = track_operation_finish(&app, &op_id, "error", Some("check_required"));
            "check_required".to_string()
        })?;
    if update_channel::verify_channel(
        pending.include_prereleases,
        include_prereleases,
    )
    .is_err()
    {
        let code = update_channel::ERR_CHANNEL_CHANGED;
        let _ = track_operation_finish(&app, &op_id, "error", Some(code));
        return Err(code.into());
    }
    let update = pending.update;
    if update.version != version {
        let _ = track_operation_finish(&app, &op_id, "error", Some("check_required"));
        return Err("check_required".into());
    }
    // Clone for spawned download task (outer keeps original for install handoff).
    let update_for_dl = update.clone();
    let app_dl = app.clone();
    let op_dl = op_id.clone();
    let event_dl = on_event.clone();
    // Real cancellation via task abort (no select! macro); total 15min explicit; never false done.
    // Guard _operation held until after settlement; abort drops network work, no leak.
    let download_handle = tokio::spawn(async move {
        let downloaded = Arc::new(AtomicU64::new(0));
        let mut last_percent: Option<u64> = None;
        // Throttle unknown-total emits (percent None every chunk would spam file+channel).
        let mut last_emit = std::time::Instant::now();
        let mut last_emit_bytes: u64 = 0;
        let dl_count = downloaded.clone();
        let app_prog = app_dl.clone();
        let op_prog = op_dl.clone();
        let event_prog = event_dl.clone();
        let res: Result<Vec<u8>, tauri_plugin_updater::Error> = update_for_dl
            .download(
                move |chunk: usize, total: Option<u64>| {
                    let cur = dl_count.fetch_add(chunk as u64, Ordering::SeqCst) + chunk as u64;
                    let percent = op_compute_percent(cur, total);
                    let known = total.filter(|t| *t > 0).is_some();
                    let should_emit = if known {
                        percent != last_percent || last_percent.is_none()
                    } else {
                        // Unknown total: first, every 64KB, or every 500ms.
                        last_percent.is_none()
                            || cur.saturating_sub(last_emit_bytes) >= UNKNOWN_TOTAL_EMIT_BYTES
                            || last_emit.elapsed().as_millis() >= UNKNOWN_TOTAL_EMIT_MS
                    };
                    if should_emit {
                        last_percent = percent;
                        last_emit = std::time::Instant::now();
                        last_emit_bytes = cur;
                        let _ = event_prog.send(serde_json::json!({
                            "stage": "downloading",
                            "percent": percent,
                            "receivedBytes": cur,
                            "totalBytes": total,
                        }));
                        let _ = track_operation_progress(
                            &app_prog,
                            &op_prog,
                            "downloading",
                            cur,
                            total,
                            "",
                            true,
                        );
                    } else if !known {
                        // Memory still tracks every chunk (cheap); file throttled inside progress.
                        let _ = track_operation_progress(
                            &app_prog,
                            &op_prog,
                            "downloading",
                            cur,
                            total,
                            "",
                            true,
                        );
                    }
                },
                {
                    let downloaded = downloaded.clone();
                    let app_v = app_dl.clone();
                    let op_v = op_dl.clone();
                    let event_v = event_dl.clone();
                    move || {
                        let cur = downloaded.load(Ordering::SeqCst);
                        let _ = event_v.send(serde_json::json!({"stage": "verifying"}));
                        let _ = track_operation_progress(
                            &app_v,
                            &op_v,
                            "verifying",
                            cur,
                            None,
                            "",
                            false,
                        );
                    }
                },
            )
            .await;
        res
    });
    // Productive helper aborts + awaits settlement BEFORE terminal (all paths, cancel first).
    let dl_res = await_cancellable(
        &app,
        download_handle,
        DOWNLOAD_TOTAL_TIMEOUT,
        "download_cancelled",
        "download_timed_out",
    )
    .await;
    let dl_inner = match dl_res {
        Ok(v) => v,
        Err(code) => {
            if code == "download_cancelled" {
                let _ = track_operation_finish(&app, &op_id, "cancelled", Some(&code));
                clear_cancel_slot(&app);
                return Err(code);
            }
            let _ = failure(&app, "download exceeded 15min total budget", &code);
            let _ = track_operation_finish(&app, &op_id, "error", Some(&code));
            clear_cancel_slot(&app);
            return Err(code);
        }
    };
    let bytes: Vec<u8> = match dl_inner {
        Ok(b) => b,
        Err(e) => {
            let msg = e.to_string();
            let code = "download_failed";
            let _ = failure(&app, msg, code);
            let _ = track_operation_finish(&app, &op_id, "error", Some(code));
            clear_cancel_slot(&app);
            return Err(code.into());
        }
    };
    // Honor already-accepted cancellation even if download just finished (race).
    if is_cancel_requested(&app) {
        let code = "download_cancelled";
        let _ = track_operation_finish(&app, &op_id, "cancelled", Some(code));
        clear_cancel_slot(&app);
        return Err(code.into());
    }
    let downloaded = bytes.len() as u64;
    // Non-cancellable handoff from here (verifying/installing refuse cancel clearly).
    let _ = track_operation_progress(&app, &op_id, "installing", downloaded, None, "", false);
    let _ = on_event.send(serde_json::json!({"stage": "installing"}));
    // Download verifies the signature. The newly installed app handles an idle
    // server restart; it never carries permission to interrupt agents across updates.
    let restart_path = app
        .state::<super::Desktop>()
        .root
        .join("restart-after-update.json");
    if restart_server.unwrap_or(false) {
        if let Err(e) = std::fs::write(
            &restart_path,
            serde_json::json!({"version": version}).to_string(),
        ) {
            let code = "install_failed";
            let _ = failure(&app, e, code);
            let _ = track_operation_finish(&app, &op_id, "error", Some(code));
            clear_cancel_slot(&app);
            return Err(code.into());
        }
    } else {
        let _ = std::fs::remove_file(&restart_path);
    }
    if let Err(e) = update.install(bytes) {
        let _ = std::fs::remove_file(&restart_path);
        let code = "install_failed";
        let _ = failure(&app, e, code);
        let _ = track_operation_finish(&app, &op_id, "error", Some(code));
        clear_cancel_slot(&app);
        return Err(code.into());
    }
    let _ = track_operation_finish(&app, &op_id, "done", None);
    clear_cancel_slot(&app);
    Ok(())
}


// --- Mobile-initiated update intent poller (native bridge) ---
//
// The server sibling owns `<root>/data/update-request.json`:
// `{schema:1, id, rev, version, restartServer, requestedAt, expiresAt,
// activeRunsAtRequest, status, statusAt, detail}`.
// This poller only consumes `version` + `restartServer`; every status write
// below runs inside the shared cross-process lock `<root>/data/
// update-request.lock` (`{pid, createdAt: ms-epoch}`, mirror of
// `lib/remote-updates.mjs` + `scripts/launcher-common.mjs acquireLock`) and is
// a best-effort read-modify-write with `rev + 1` (CAS): inside the lock the
// file is re-read, the write is skipped unless the on-disk `id` still matches
// the picked intent, and a `rev` mismatch is applied only when the on-disk
// status still equals the picked status (transition still valid).

const INTENT_MAX_BYTES: usize = 16 * 1024;
const POLL_FIRST_DELAY: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_secs(20);
const STALE_ACTIVE_AFTER: Duration = Duration::from_secs(30 * 60);

const TERMINAL_STATUSES: [&str; 5] = [
    "installed",
    "installed_pending_restart",
    "failed",
    "refused",
    "expired",
];

fn is_terminal(status: &str) -> bool {
    TERMINAL_STATUSES.contains(&status)
}

fn is_known_status(status: &str) -> bool {
    matches!(
        status,
        "pending"
            | "checking"
            | "downloading"
            | "verifying"
            | "installing"
            | "installed"
            | "installed_pending_restart"
            | "failed"
            | "refused"
            | "expired"
    )
}

/// Strict `x.y.z` mirror of the server SEMVER; anything else is ignored,
/// never executed.
fn valid_intent_version(version: &str) -> bool {
    let mut parts = version.split('.');
    for _ in 0..3 {
        match parts.next() {
            Some(part) if !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) => {}
            _ => return false,
        }
    }
    parts.next().is_none()
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Minimal RFC 3339 reader for timestamps written as `Date.toISOString()`.
fn parse_iso8601(raw: &str) -> Option<SystemTime> {
    let text = raw.trim();
    let is_utc = text.ends_with('Z') || text.ends_with('z');
    let (naive, offset_secs): (&str, i64) = if is_utc {
        (&text[..text.len() - 1], 0)
    } else if let Some(tpos) = text.find(|c| c == 'T' || c == 't' || c == ' ') {
        let after = &text[tpos + 1..];
        let mut split = None;
        for (index, ch) in after.char_indices() {
            if ch == '+' || ch == '-' {
                split = Some(tpos + 1 + index);
            }
        }
        match split {
            Some(at) => {
                let zone = &text[at..];
                let sign = if zone.starts_with('-') { -1 } else { 1 };
                let digits: String = zone[1..].chars().filter(|ch| *ch != ':').collect();
                if digits.len() < 4 {
                    return None;
                }
                let hours: i64 = digits[..2].parse().ok()?;
                let minutes: i64 = digits[2..4].parse().ok()?;
                (&text[..at], sign * (hours * 3600 + minutes * 60))
            }
            None => (text, 0),
        }
    } else {
        return None;
    };
    let tpos = naive.find(|c| c == 'T' || c == 't' || c == ' ')?;
    let (date, time) = (&naive[..tpos], &naive[tpos + 1..]);
    let mut date = date.split('-');
    let year = date.next()?.parse::<i64>().ok()?;
    let month = date.next()?.parse::<i64>().ok()?;
    let day = date.next()?.parse::<i64>().ok()?;
    if date.next().is_some() {
        return None;
    }
    let clock = time.split('.').next().unwrap_or("");
    let mut clock = clock.split(':');
    let hour = clock.next()?.parse::<i64>().ok()?;
    let minute = clock.next()?.parse::<i64>().ok()?;
    let second = clock.next()?.parse::<i64>().ok()?;
    if clock.next().is_some() {
        return None;
    }
    if !(0..24).contains(&hour) || !(0..60).contains(&minute) || !(0..61).contains(&second) {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    let stamp = days * 86_400 + hour * 3600 + minute * 60 + second - offset_secs;
    if stamp < 0 {
        return None;
    }
    Some(UNIX_EPOCH + Duration::from_secs(stamp as u64))
}

fn now_iso() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    let days = stamp.div_euclid(86_400);
    let rest = stamp.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

fn intent_path(root: &Path) -> PathBuf {
    root.join("data").join("update-request.json")
}

fn poller_path(root: &Path) -> PathBuf {
    root.join("data").join("update-poller.json")
}

const LOCK_STALE_AFTER_MS: u64 = 60_000;
const LOCK_RETRY_DELAY: Duration = Duration::from_millis(125);
const LOCK_WAIT_BUDGET: Duration = Duration::from_secs(5);

fn update_lock_path(root: &Path) -> PathBuf {
    root.join("data").join("update-request.lock")
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Cross-process mutex mirroring `lib/remote-updates.mjs` (`{pid, createdAt}`
/// created with O_EXCL). Deleted on drop only when the content is still ours.
struct UpdateLockGuard {
    path: PathBuf,
    token: String,
}

impl Drop for UpdateLockGuard {
    fn drop(&mut self) {
        let ours = std::fs::read_to_string(&self.path)
            .map(|content| content == self.token)
            .unwrap_or(false);
        if ours {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

enum LockClaim {
    Held(UpdateLockGuard),
    Busy,
    Fatal,
}

fn lock_token() -> String {
    serde_json::json!({"pid": std::process::id(), "createdAt": now_ms()}).to_string()
}

fn try_create_lock(root: &Path) -> LockClaim {
    let path = update_lock_path(root);
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return LockClaim::Fatal;
        }
    }
    if is_symlink(&path) {
        return LockClaim::Busy;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => {
            let token = lock_token();
            if file.write_all(token.as_bytes()).is_err() {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return LockClaim::Fatal;
            }
            drop(file);
            LockClaim::Held(UpdateLockGuard { path, token })
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => LockClaim::Busy,
        Err(_) => LockClaim::Fatal,
    }
}

/// Stale only when the holder timestamp parses and is older than 60s (same
/// rule as `acquireLock`; no pid check on this side). An unreadable lock whose
/// mtime is older than 5s is a crashed partial write, also stale. Anything
/// else is contention, never a takeover.
fn update_lock_is_stale(root: &Path) -> bool {
    let path = update_lock_path(root);
    if is_symlink(&path) {
        return false;
    }
    let content = std::fs::read_to_string(&path).ok();
    let created_at = content
        .as_deref()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|owner| owner.get("createdAt").and_then(|v| v.as_u64()));
    if let Some(created_at) = created_at {
        return now_ms().saturating_sub(created_at) > LOCK_STALE_AFTER_MS;
    }
    std::fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .map(|mtime| {
            SystemTime::now().duration_since(mtime).unwrap_or_default() > Duration::from_secs(5)
        })
        .unwrap_or(false)
}

/// Single non-blocking attempt for the sync download callbacks: stale locks
/// are taken over, anything else skips the beat (next percent retries).
fn try_acquire_update_lock(root: &Path) -> Option<UpdateLockGuard> {
    match try_create_lock(root) {
        LockClaim::Held(guard) => Some(guard),
        LockClaim::Busy => {
            if update_lock_is_stale(root) {
                let _ = std::fs::remove_file(update_lock_path(root));
                match try_create_lock(root) {
                    LockClaim::Held(guard) => Some(guard),
                    _ => None,
                }
            } else {
                None
            }
        }
        LockClaim::Fatal => None,
    }
}

/// Bounded acquire for tick transitions: 125ms retries up to ~5s, then `None`
/// (abort the tick silently, retry on the next tick).
async fn acquire_update_lock(root: &Path) -> Option<UpdateLockGuard> {
    let deadline = tokio::time::Instant::now() + LOCK_WAIT_BUDGET;
    loop {
        match try_create_lock(root) {
            LockClaim::Held(guard) => return Some(guard),
            LockClaim::Fatal => return None,
            LockClaim::Busy => {}
        }
        if update_lock_is_stale(root) {
            let _ = std::fs::remove_file(update_lock_path(root));
            match try_create_lock(root) {
                LockClaim::Held(guard) => return Some(guard),
                LockClaim::Fatal => return None,
                LockClaim::Busy => {}
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(LOCK_RETRY_DELAY).await;
    }
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_tmp_path(path: &Path) -> PathBuf {
    let count = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let file = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tmp".to_string());
    path.with_file_name(format!("{file}.{}.{nanos}.{count}.tmp", std::process::id()))
}

/// Atomic write mirroring `writeJsonAtomic`: refuse symlink targets (never
/// follow), create `<path>.<pid>.<nanos>.<n>.tmp` with O_EXCL + 0600, rename.
fn atomic_write_file(path: &Path, bytes: &[u8]) -> bool {
    if is_symlink(path) {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    let tmp = unique_tmp_path(path);
    if is_symlink(&tmp) {
        return false;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = match options.open(&tmp) {
        Ok(file) => file,
        Err(_) => return false,
    };
    if file.write_all(bytes).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    drop(file);
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    true
}

/// Server displays `detail` sliced to 500 chars; bound it at the source too.
fn clamp_detail(detail: &str) -> String {
    if detail.chars().count() <= 500 {
        detail.to_string()
    } else {
        detail.chars().take(500).collect()
    }
}

fn read_intent_file(root: &Path) -> Option<serde_json::Value> {
    let path = intent_path(root);
    if is_symlink(&path) {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > INTENT_MAX_BYTES {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if value.get("schema").and_then(|v| v.as_u64()) != Some(1) {
        return None;
    }
    let version = value.get("version").and_then(|v| v.as_str()).unwrap_or("");
    if !valid_intent_version(version) {
        return None;
    }
    if value
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
    {
        return None;
    }
    let status = value.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if !is_known_status(status) {
        return None;
    }
    Some(value)
}

/// CAS transition inside the shared lock: re-read, keep the picked `id`,
/// apply only when the picked transition is still valid, then write `rev + 1`
/// atomically (uuid-tmp + rename). `None` aborts the tick silently.
async fn cas_set_status(
    root: &Path,
    picked_id: &str,
    picked_rev: u64,
    picked_status: &str,
    status: &str,
    detail: &str,
) -> Option<serde_json::Value> {
    let _lock = acquire_update_lock(root).await?;
    let fresh = read_intent_file(root)?;
    if fresh.get("id").and_then(|v| v.as_str()).unwrap_or("") != picked_id {
        return None;
    }
    let fresh_rev = fresh.get("rev").and_then(|v| v.as_u64()).unwrap_or(0);
    let fresh_status = fresh.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if fresh_rev != picked_rev && fresh_status != picked_status {
        return None;
    }
    let mut next = fresh.clone();
    let obj = next.as_object_mut()?;
    obj.insert("rev".to_string(), serde_json::json!(fresh_rev + 1));
    obj.insert("status".to_string(), serde_json::json!(status));
    obj.insert("statusAt".to_string(), serde_json::json!(now_iso()));
    obj.insert(
        "detail".to_string(),
        serde_json::json!(clamp_detail(detail)),
    );
    let text = serde_json::to_string(&next).ok()?;
    if !atomic_write_file(&intent_path(root), text.as_bytes()) {
        return None;
    }
    Some(next)
}

/// Progress rewrite from the sync download callbacks: single non-blocking
/// lock attempt (a missed beat retries on the next percent), then id-guarded
/// `rev + 1` atomic write. Never clobbers a status transition made meanwhile.
fn refresh_phase(root: &Path, id: &str, expected: &str, status: &str, detail: &str) -> bool {
    let _lock = match try_acquire_update_lock(root) {
        Some(guard) => guard,
        None => return false,
    };
    let Some(fresh) = read_intent_file(root) else {
        return false;
    };
    if fresh.get("id").and_then(|v| v.as_str()).unwrap_or("") != id {
        return false;
    }
    if fresh.get("status").and_then(|v| v.as_str()).unwrap_or("") != expected {
        return false;
    }
    let rev = fresh.get("rev").and_then(|v| v.as_u64()).unwrap_or(0);
    let mut next = fresh.clone();
    let Some(obj) = next.as_object_mut() else {
        return false;
    };
    obj.insert("rev".to_string(), serde_json::json!(rev + 1));
    obj.insert("status".to_string(), serde_json::json!(status));
    obj.insert("statusAt".to_string(), serde_json::json!(now_iso()));
    obj.insert(
        "detail".to_string(),
        serde_json::json!(clamp_detail(detail)),
    );
    let Ok(text) = serde_json::to_string(&next) else {
        return false;
    };
    atomic_write_file(&intent_path(root), text.as_bytes())
}

struct Pick {
    id: String,
    rev: u64,
    status: String,
    base: serde_json::Value,
}

impl Pick {
    fn from_value(value: &serde_json::Value) -> Option<Self> {
        Some(Self {
            id: value.get("id")?.as_str()?.to_string(),
            rev: value.get("rev").and_then(|v| v.as_u64()).unwrap_or(0),
            status: value.get("status")?.as_str()?.to_string(),
            base: value.clone(),
        })
    }
    fn version(&self) -> String {
        self.base
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }
    fn restart_server(&self) -> bool {
        self.base
            .get("restartServer")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
    /// Best-effort locked CAS transition; `false` means the tick must stop.
    async fn set(&mut self, root: &Path, status: &str, detail: &str) -> bool {
        match cas_set_status(root, &self.id, self.rev, &self.status, status, detail).await {
            Some(next) => {
                self.rev = next
                    .get("rev")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(self.rev + 1);
                self.status = status.to_string();
                self.base = next;
                true
            }
            None => false,
        }
    }
    /// Re-read after the download callbacks moved `rev` on; `false` aborts.
    fn resync(&mut self, root: &Path) -> bool {
        let Some(fresh) = read_intent_file(root) else {
            return false;
        };
        if fresh.get("id").and_then(|v| v.as_str()).unwrap_or("") != self.id {
            return false;
        }
        self.rev = fresh
            .get("rev")
            .and_then(|v| v.as_u64())
            .unwrap_or(self.rev);
        self.status = fresh
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        self.base = fresh;
        true
    }
    fn older_than(&self, now: SystemTime, age: Duration) -> bool {
        self.base
            .get("statusAt")
            .and_then(|v| v.as_str())
            .and_then(parse_iso8601)
            .map(|at| now.duration_since(at).unwrap_or_default() > age)
            .unwrap_or(false)
    }
}

fn write_poller_heartbeat(root: &Path, app_version: &str) {
    // Lock-free by design (single writer); same atomic tmp + 0600-at-create
    // discipline as the intent path.
    let body = serde_json::json!({
        "schema": 1,
        "aliveAt": now_iso(),
        "appVersion": app_version,
    });
    let Ok(text) = serde_json::to_string(&body) else {
        return;
    };
    let _ = atomic_write_file(&poller_path(root), text.as_bytes());
}

/// Status probe through the existing desktop-control script (`action: status`
/// only). Never starts or stops the server; no force flag exists on this path.
async fn query_server_status(app: &AppHandle) -> Result<serde_json::Value, String> {
    let (resources, root, port) = {
        let desktop = app.state::<super::Desktop>();
        (
            desktop.resources.clone(),
            desktop.root.clone(),
            desktop.port,
        )
    };
    let options = serde_json::json!({"action": "status", "dataRoot": root, "port": port});
    let result = tauri::async_runtime::spawn_blocking(move || {
        super::run_desktop_control(&resources, &options)
    })
    .await
    .map_err(|_| "server_status_failed".to_string())?;
    result
}

fn server_active_runs(status: &serde_json::Value) -> u64 {
    status
        .get("activeRuns")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
}

async fn poll_update_intent_once(app: &AppHandle) {
    let root: PathBuf = {
        let desktop = app.state::<super::Desktop>();
        desktop.root.clone()
    };
    let app_version = app.package_info().version.to_string();
    // Heartbeat on every tick, even skipped ones: best-effort liveness only.
    write_poller_heartbeat(&root, &app_version);
    // Never fight a manual update or a server start for the updater.
    if app.state::<Updates>().is_busy() {
        return;
    }
    if app
        .state::<super::Desktop>()
        .starting
        .load(Ordering::SeqCst)
    {
        return;
    }
    let Some(intent) = read_intent_file(&root) else {
        return;
    };
    let status = intent
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    if is_terminal(&status) {
        return;
    }
    let Some(mut pick) = Pick::from_value(&intent) else {
        return;
    };
    let now = SystemTime::now();

    // Startup reconciliation: only `installing` survives an app relaunch.
    if pick.status == "installing" {
        if pick.version() == app_version {
            let server_version = query_server_status(app)
                .await
                .ok()
                .and_then(|value| {
                    value
                        .get("version")
                        .and_then(|version| version.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_default();
            if server_version == app_version {
                let _ = pick.set(&root, "installed", "").await;
            } else {
                let _ = pick
                    .set(
                        &root,
                        "installed_pending_restart",
                        "server_restart_required",
                    )
                    .await;
            }
        } else if pick.older_than(now, STALE_ACTIVE_AFTER) {
            let _ = failure(app, "install_unconfirmed", "install_unconfirmed");
            let _ = pick.set(&root, "failed", "install_unconfirmed").await;
        }
        // A fresh version mismatch waits for the relaunch to land.
        return;
    }

    // Crash recovery: in-flight phases never survive 30 minutes.
    if matches!(
        pick.status.as_str(),
        "checking" | "downloading" | "verifying"
    ) {
        if pick.older_than(now, STALE_ACTIVE_AFTER) {
            let _ = failure(app, "interrupted", "interrupted");
            let _ = pick.set(&root, "failed", "interrupted").await;
        }
        return;
    }

    // Reject-while-live is enforced server-side: only `pending` starts work.
    if pick.status != "pending" {
        return;
    }

    if let Some(expires_at) = intent
        .get("expiresAt")
        .and_then(|value| value.as_str())
        .and_then(parse_iso8601)
    {
        if now > expires_at {
            let _ = pick.set(&root, "expired", "expired").await;
            return;
        }
    }

    // Guards reuse the existing desktop-control status probe. The poller never
    // starts or stops the server and never passes any force flag.
    let server = match query_server_status(app).await {
        Ok(status) => status,
        Err(_) => return,
    };
    if !server
        .get("managed")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        let _ = pick.set(&root, "refused", "server_not_managed").await;
        return;
    }
    if !server
        .get("running")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        let _ = pick.set(&root, "refused", "server_stopped").await;
        return;
    }
    if server_active_runs(&server) > 0 {
        let _ = pick.set(&root, "refused", "agents_running").await;
        return;
    }

    // Execution holds the same busy guard as the manual commands.
    let state = app.state::<Updates>();
    let Ok(_operation) = begin(&state) else {
        return;
    };
    if !pick.set(&root, "checking", "").await {
        return;
    }
    // Same signed flow as `desktop_update_check`: fixed endpoint from
    // tauri.conf, metadata bound to 20s. Nothing is read from the file here
    // except `version` (compared) and `restartServer` (restart file only).
    let updater = match app
        .updater_builder()
        .timeout(Duration::from_secs(120))
        .build()
    {
        Ok(updater) => updater,
        Err(error) => {
            let _ = failure(app, error, "check_failed");
            let _ = pick.set(&root, "failed", "check_failed").await;
            return;
        }
    };
    // Bound only the metadata request. The download may take longer on a slow connection.
    let checked = tokio::time::timeout(Duration::from_secs(20), updater.check()).await;
    let update = match checked {
        Ok(Ok(update)) => update,
        Ok(Err(error)) => {
            let _ = failure(app, error, "check_failed");
            let _ = pick.set(&root, "failed", "check_failed").await;
            return;
        }
        Err(error) => {
            let _ = failure(app, error, "check_failed");
            let _ = pick.set(&root, "failed", "check_failed").await;
            return;
        }
    };
    let Some(update) = update else {
        let _ = pick.set(&root, "refused", "stale_version").await;
        return;
    };
    if update.version != pick.version() {
        let _ = pick.set(&root, "refused", "stale_version").await;
        return;
    }
    // Agents may have started during the metadata fetch: recheck before download.
    match query_server_status(app).await {
        Ok(status) => {
            if server_active_runs(&status) > 0 {
                let _ = pick.set(&root, "refused", "agents_running").await;
                return;
            }
        }
        Err(_) => return,
    }
    if !pick.set(&root, "downloading", "").await {
        return;
    }
    let intent_id = pick.id.clone();
    let root_dl = root.clone();
    let mut downloaded = 0_u64;
    let mut last_percent: Option<u64> = None;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let percent = total
                    .filter(|total| *total > 0)
                    .map(|total| (downloaded * 100 / total).min(100));
                if percent != last_percent {
                    last_percent = percent;
                    let detail = percent.map(|value| format!("{value}%")).unwrap_or_default();
                    let _ =
                        refresh_phase(&root_dl, &intent_id, "downloading", "downloading", &detail);
                }
            },
            || {
                let _ = refresh_phase(&root_dl, &intent_id, "downloading", "verifying", "");
            },
        )
        .await;
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = failure(app, error, "download_failed");
            if pick.resync(&root) {
                let _ = pick.set(&root, "failed", "download_failed").await;
            }
            return;
        }
    };
    if !pick.resync(&root) {
        return;
    }
    if pick.status != "downloading" && pick.status != "verifying" {
        return;
    }
    // Agents may have started during the download: recheck before install.
    match query_server_status(app).await {
        Ok(status) => {
            if server_active_runs(&status) > 0 {
                let _ = pick.set(&root, "refused", "agents_running").await;
                return;
            }
        }
        Err(_) => return,
    }
    // Same restart-file contract as `desktop_update_install`.
    let restart_path = root.join("restart-after-update.json");
    if pick.restart_server() {
        let body = serde_json::json!({"version": pick.version()}).to_string();
        if let Err(error) = std::fs::write(&restart_path, body) {
            let _ = failure(app, error, "install_failed");
            let _ = pick.set(&root, "failed", "install_failed").await;
            return;
        }
    } else {
        let _ = std::fs::remove_file(&restart_path);
    }
    if !pick.set(&root, "installing", "").await {
        let _ = std::fs::remove_file(&restart_path);
        return;
    }
    if let Err(error) = update.install(bytes) {
        let _ = std::fs::remove_file(&restart_path);
        let _ = failure(app, error, "install_failed");
        let _ = pick.set(&root, "failed", "install_failed").await;
        return;
    }
    // install() relaunches the app; startup reconciliation records the outcome.
}

/// Poll `<root>/data/update-request.json` every 20s (first tick 10s after
/// setup) and drive one mobile-requested update through the existing signed
/// updater. Best-effort only: no file write ever fails the tick.
pub(crate) fn start_update_intent_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(POLL_FIRST_DELAY).await;
        loop {
            poll_update_intent_once(&app).await;
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}
