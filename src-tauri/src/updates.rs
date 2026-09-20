use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates {
    busy: AtomicBool,
    pending: Mutex<Option<Update>>,
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
fn failure(app: &AppHandle, error: impl std::fmt::Display, code: &str) -> String {
    let root = &app.state::<super::Desktop>().root;
    let _ = std::fs::create_dir_all(root);
    let _ = std::fs::write(root.join("desktop-update-error.log"), error.to_string());
    code.into()
}

#[tauri::command]
pub async fn desktop_update_check(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    super::update_window_only(&window, &app)?;
    let state = app.state::<Updates>();
    let _operation = begin(&state)?;
    *state.pending.lock().map_err(|_| "update_failed")? = None;
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| failure(&app, e, "check_failed"))?;
    // Bound only the metadata request. The download may take longer on a slow connection.
    let update = tokio::time::timeout(Duration::from_secs(20), updater.check())
        .await
        .map_err(|e| failure(&app, e, "check_failed"))?
        .map_err(|e| failure(&app, e, "check_failed"))?;
    let response = match &update {
        Some(update) => {
            serde_json::json!({"available":true,"version":update.version,"notes":update.body})
        }
        None => serde_json::json!({"available":false}),
    };
    *state.pending.lock().map_err(|_| "update_failed")? = update;
    Ok(response)
}

#[tauri::command]
pub async fn desktop_update_install(
    window: WebviewWindow,
    app: AppHandle,
    version: String,
    restart_server: Option<bool>,
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
    let state = app.state::<Updates>();
    let _operation = begin(&state)?;
    let update = state
        .pending
        .lock()
        .map_err(|_| "update_failed")?
        .clone()
        .ok_or("check_required")?;
    if update.version != version {
        return Err("check_required".into());
    }
    let mut downloaded = 0_u64;
    let mut last_percent = None;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let percent = total
                    .filter(|total| *total > 0)
                    .map(|total| (downloaded * 100 / total).min(100));
                if percent != last_percent || last_percent.is_none() {
                    let _ =
                        on_event.send(serde_json::json!({"stage":"downloading","percent":percent}));
                    last_percent = percent;
                }
            },
            || {
                let _ = on_event.send(serde_json::json!({"stage":"verifying"}));
            },
        )
        .await
        .map_err(|e| failure(&app, e, "download_failed"))?;
    // Download verifies the signature. The newly installed app handles an idle
    // server restart; it never carries permission to interrupt agents across updates.
    let restart_path = app
        .state::<super::Desktop>()
        .root
        .join("restart-after-update.json");
    if restart_server.unwrap_or(false) {
        std::fs::write(
            &restart_path,
            serde_json::json!({"version":version}).to_string(),
        )
        .map_err(|e| failure(&app, e, "install_failed"))?;
    } else {
        let _ = std::fs::remove_file(&restart_path);
    }
    let _ = on_event.send(serde_json::json!({"stage":"installing"}));
    update.install(bytes).map_err(|e| {
        let _ = std::fs::remove_file(&restart_path);
        failure(&app, e, "install_failed")
    })?;
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
