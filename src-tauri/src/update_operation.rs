//! Shared serializable update operation tracking (pure, no Tauri).
//! Owner: update-native-operation-state worker. Shell must NOT add `mod update_operation`
//! in main.rs. This file is included via `#[path = "update_operation.rs"] pub mod update_operation`
//! inside updates.rs; use `updates::update_operation::..` or `updates::track_operation_*`.
//!
//! Canonical snapshot keys (camelCase JSON):
//! {id,kind,stage,startedAt,updatedAt,receivedBytes,totalBytes,percent,detail,error,code,cancellable,done,terminal}
//! - timestamps ms epoch, receivedBytes u64, totalBytes u64|null, percent 0-100|null
//! - detail bounded 500 chars, no tokens. error==code (code only, never URL/token).
//! - done==terminal (both exposed: terminal canonical, done for parent compat).
//! - operation null when never started. Otherwise last snapshot incl. terminal (survives panel close
//!   via process memory + desktop-update-operation.json + bounded log file).
//! Kinds: check|install|restart|components|start|quit|prepare
//! Stages: free string (1..64 chars, no control) + terminal done|error|cancelled.
//! Update flow uses checking|downloading|verifying|installing; shell may use
//! checking_server|stopping|starting|preparing|validating|working|etc.

use std::path::{Path, PathBuf};

pub const MAX_DETAIL_CHARS: usize = 500;
pub const MAX_LOG_ENTRIES: usize = 20;
pub const MAX_ERROR_CHARS: usize = 200;
pub const MAX_STAGE_CHARS: usize = 64;
pub const MAX_LOG_MESSAGE_CHARS: usize = 1000;

pub const VALID_KINDS: [&str; 7] = [
    "check",
    "install",
    "restart",
    "components",
    "start",
    "quit",
    "prepare",
];

pub fn is_valid_kind(kind: &str) -> bool {
    VALID_KINDS.contains(&kind)
}

pub fn is_terminal_stage(stage: &str) -> bool {
    matches!(stage, "done" | "error" | "cancelled")
}

/// Free-string stage: trimmed, 1..=64 chars, no control chars.
/// Returns normalized stage or None when invalid.
pub fn normalize_stage(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if s.chars().count() > MAX_STAGE_CHARS {
        return None;
    }
    if s.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(s.to_string())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Bound detail to 500 chars (server slices to 500 too).
pub fn clamp_detail(raw: &str) -> String {
    let s = raw.trim();
    if s.chars().count() <= MAX_DETAIL_CHARS {
        s.to_string()
    } else {
        s.chars().take(MAX_DETAIL_CHARS).collect()
    }
}

/// Sanitize error/code: single line, bounded 200, redacted query, never raw token blob.
pub fn sanitize_error(raw: &str) -> String {
    let mut s = raw.trim().replace(['\r', '\n'], " ");
    // Redact URL query (?...) to ?redacted to avoid SAS tokens in logs.
    s = redact_url_queries(&s);
    // Keep it short: first token-ish code when caller passes "code: message".
    // We keep full short message but bounded; codes remain exact for known values.
    if s.chars().count() > MAX_ERROR_CHARS {
        s = s.chars().take(MAX_ERROR_CHARS).collect();
    }
    s.trim().to_string()
}

pub fn redact_url_queries(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Look for http(s):// then redact ?... until space/quote/bracket.
        if input[i..].starts_with("http://") || input[i..].starts_with("https://") {
            let start = i;
            // Find '?' after scheme.
            let mut q: Option<usize> = None;
            let mut j = i;
            while j < bytes.len() {
                let c = bytes[j] as char;
                if c == ' ' || c == '"' || c == '\'' || c == '\n' || c == '\r' {
                    break;
                }
                if c == '?' && q.is_none() {
                    q = Some(j);
                }
                j += 1;
            }
            if let Some(qpos) = q {
                out.push_str(&input[start..=qpos]);
                out.push_str("redacted");
                i = j;
                continue;
            } else {
                out.push_str(&input[start..j]);
                i = j;
                continue;
            }
        } else {
            // push one char (handle utf8)
            let ch = input[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Bound + redact any log message (error file, detail file). No tokens.
pub fn sanitize_log_message(raw: &str) -> String {
    let redacted = redact_url_queries(raw);
    let s = redacted.trim().replace(['\r', '\n'], " ");
    if s.chars().count() <= MAX_LOG_MESSAGE_CHARS {
        s
    } else {
        s.chars().take(MAX_LOG_MESSAGE_CHARS).collect()
    }
}

pub fn compute_percent(received: u64, total: Option<u64>) -> Option<u64> {
    total
        .filter(|t| *t > 0)
        .map(|t| (received.saturating_mul(100) / t).min(100))
}

pub fn initial_stage_for_kind(kind: &str) -> &'static str {
    match kind {
        "check" => "checking",
        "install" => "downloading",
        _ => "working",
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationSnapshot {
    pub id: String,
    pub kind: String,
    pub stage: String,
    pub started_at: u64,
    pub updated_at: u64,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<u64>,
    pub detail: String,
    pub error: Option<String>,
    pub code: Option<String>,
    pub cancellable: bool,
    pub done: bool,
    pub terminal: bool,
}

impl OperationSnapshot {
    pub fn new(id: String, kind: &str, stage: &str, cancellable: bool) -> Self {
        let now = now_ms();
        let terminal = is_terminal_stage(stage);
        Self {
            id,
            kind: kind.to_string(),
            stage: stage.to_string(),
            started_at: now,
            updated_at: now,
            received_bytes: 0,
            total_bytes: None,
            percent: None,
            detail: String::new(),
            error: None,
            code: None,
            cancellable: cancellable && !terminal,
            done: terminal,
            terminal,
        }
    }

    pub fn to_value(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

pub fn make_id(now: u64, counter: u64) -> String {
    format!("upd-{now}-{counter}")
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

pub(crate) fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> bool {
    if is_symlink(path) {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    // uuid-free unique tmp: pid + nanos + counter
    static TMP_N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = TMP_N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = now_ms();
    let fname = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tmp".to_string());
    let tmp = path.with_file_name(format!("{fname}.{}.{nanos}.{n}.tmp", std::process::id()));
    if is_symlink(&tmp) {
        return false;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = match opts.open(&tmp) {
        Ok(f) => f,
        Err(_) => return false,
    };
    use std::io::Write as _;
    if f.write_all(bytes).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    drop(f);
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    true
}

pub fn snapshot_file_path(root: &Path) -> PathBuf {
    root.join("desktop-update-operation.json")
}

pub fn log_file_path(root: &Path) -> PathBuf {
    root.join("desktop-update-operations.log")
}

/// Best-effort persist current snapshot (or remove file when None).
pub fn persist_snapshot(root: &Path, snap: Option<&OperationSnapshot>) {
    match snap {
        Some(s) => {
            if let Ok(text) = serde_json::to_string(s) {
                let _ = atomic_write_bytes(&snapshot_file_path(root), text.as_bytes());
            }
        }
        None => {
            let _ = std::fs::remove_file(snapshot_file_path(root));
        }
    }
}

pub fn load_snapshot(root: &Path) -> Option<OperationSnapshot> {
    let p = snapshot_file_path(root);
    if is_symlink(&p) {
        return None;
    }
    let bytes = std::fs::read(p).ok()?;
    if bytes.len() > 16 * 1024 {
        return None;
    }
    let v: OperationSnapshot = serde_json::from_slice(&bytes).ok()?;
    if !is_valid_kind(&v.kind) {
        return None;
    }
    if normalize_stage(&v.stage).is_none() {
        return None;
    }
    Some(v)
}

/// Best-effort bounded log file (JSON array, max 20, sanitized already via snapshot).
pub fn append_log_file(root: &Path, snap: &OperationSnapshot) {
    let path = log_file_path(root);
    if is_symlink(&path) {
        return;
    }
    let mut entries: Vec<OperationSnapshot> = std::fs::read(&path)
        .ok()
        .and_then(|b| {
            if b.len() > 64 * 1024 {
                None
            } else {
                serde_json::from_slice(&b).ok()
            }
        })
        .unwrap_or_default();
    entries.push(snap.clone());
    if entries.len() > MAX_LOG_ENTRIES {
        let excess = entries.len() - MAX_LOG_ENTRIES;
        entries.drain(0..excess);
    }
    if let Ok(text) = serde_json::to_string(&entries) {
        let _ = atomic_write_bytes(&path, text.as_bytes());
    }
}

/// Normalize a persisted snapshot with no in-memory op (relaunch/panel close).
/// Nonterminal file becomes terminal error (never fake completed):
/// stage error, error/code operation_interrupted, detail operation_interrupted verify state.
/// Terminal files pass through unchanged.
pub fn normalize_stale_persisted(mut snap: OperationSnapshot) -> OperationSnapshot {
    if snap.terminal || snap.done || is_terminal_stage(&snap.stage) {
        snap.done = true;
        snap.terminal = true;
        snap.cancellable = false;
        return snap;
    }
    let now = now_ms();
    snap.stage = "error".to_string();
    snap.error = Some("operation_interrupted".to_string());
    snap.code = Some("operation_interrupted".to_string());
    snap.detail = clamp_detail("operation_interrupted: verify state");
    snap.terminal = true;
    snap.done = true;
    snap.cancellable = false;
    snap.updated_at = now;
    snap
}

#[cfg(test)]
#[path = "update_operation_tests.rs"]
mod update_operation_tests;
