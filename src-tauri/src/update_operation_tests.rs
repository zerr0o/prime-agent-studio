//! New tests for update_operation tracking (owned by update-native-operation-state).
//! Does NOT touch update_tests.rs. Included via #[path] from update_operation.rs.

use super::*;

#[test]
fn snapshot_keys_and_terminal_done_mirror() {
    let mut s = OperationSnapshot::new("upd-1-2".into(), "check", "checking", true);
    assert_eq!(s.done, false);
    assert_eq!(s.terminal, false);
    assert!(s.cancellable);
    let v = s.to_value();
    for k in ["id","kind","stage","startedAt","updatedAt","receivedBytes","totalBytes","percent","detail","error","code","cancellable","done","terminal"] {
        assert!(v.get(k).is_some(), "missing key {k}: {v}");
    }
    // terminal mirror
    s.stage = "done".into();
    s.done = true;
    s.terminal = true;
    s.cancellable = false;
    let v2 = s.to_value();
    assert_eq!(v2["done"], serde_json::json!(true));
    assert_eq!(v2["terminal"], serde_json::json!(true));
}

#[test]
fn kinds_allow_restart_quit_components_start_prepare() {
    for k in ["check","install","restart","components","start","quit","prepare"] {
        assert!(is_valid_kind(k), "{k}");
    }
    assert!(!is_valid_kind("hack"));
    assert!(!is_valid_kind(""));
}

#[test]
fn stages_free_string_plus_terminal() {
    for s in ["checking","downloading","verifying","installing","working","checking_server","stopping","starting","preparing","validating"] {
        assert!(normalize_stage(s).is_some(), "{s}");
    }
    for t in ["done","error","cancelled"] {
        assert!(is_terminal_stage(t));
    }
    assert!(!is_terminal_stage("working"));
    assert!(normalize_stage("").is_none());
    assert!(normalize_stage("   ").is_none());
    assert!(normalize_stage(&"x".repeat(65)).is_none());
    assert!(normalize_stage("bad\nstage").is_none());
}

#[test]
fn detail_bounded_and_error_no_tokens() {
    let long = "a".repeat(600);
    assert_eq!(clamp_detail(&long).chars().count(), 500);
    let url = "GET https://example.com/payload?token=SECRET123&x=1 failed";
    let red = redact_url_queries(url);
    assert!(!red.contains("SECRET123"), "{red}");
    assert!(red.contains("?redacted"), "{red}");
    let err = sanitize_error("download_failed: GET https://example.com/f?sig=ABCDEF rest");
    assert!(!err.contains("ABCDEF"), "{err}");
    assert!(err.chars().count() <= 200);
}

#[test]
fn percent_computation() {
    assert_eq!(compute_percent(50, Some(100)), Some(50));
    assert_eq!(compute_percent(0, Some(0)), None);
    assert_eq!(compute_percent(5, None), None);
    assert_eq!(compute_percent(150, Some(100)), Some(100));
}

#[test]
fn persist_and_log_bounded_no_tokens_tmpdir() {
    let dir = std::env::temp_dir().join(format!("upd-op-test-{}-{}", std::process::id(), now_ms()));
    let _ = std::fs::create_dir_all(&dir);
    let s = OperationSnapshot::new("upd-x".into(), "install", "downloading", true);
    persist_snapshot(&dir, Some(&s));
    let loaded = load_snapshot(&dir).expect("load");
    assert_eq!(loaded.id, "upd-x");
    // log bounded 20
    for i in 0..25 {
        let mut e = s.clone();
        e.id = format!("upd-{i}");
        append_log_file(&dir, &e);
    }
    let raw = std::fs::read(log_file_path(&dir)).unwrap();
    let arr: Vec<OperationSnapshot> = serde_json::from_slice(&raw).unwrap();
    assert_eq!(arr.len(), 20);
    assert_eq!(arr.last().unwrap().id, "upd-24");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn initial_stage_mapping() {
    assert_eq!(initial_stage_for_kind("check"), "checking");
    assert_eq!(initial_stage_for_kind("install"), "downloading");
    assert_eq!(initial_stage_for_kind("restart"), "working");
    assert_eq!(initial_stage_for_kind("quit"), "working");
}

#[test]
fn stale_nonterminal_normalizes_to_interrupted_error() {
    let s = OperationSnapshot::new("upd-stale".into(), "install", "downloading", true);
    assert!(!s.terminal);
    let n = normalize_stale_persisted(s);
    assert_eq!(n.stage, "error");
    assert_eq!(n.error.as_deref(), Some("operation_interrupted"));
    assert_eq!(n.code.as_deref(), Some("operation_interrupted"));
    assert!(n.terminal && n.done && !n.cancellable);
    assert!(n.detail.contains("operation_interrupted"));
    // Terminal passes through (never fake completed to done).
    let mut d = OperationSnapshot::new("upd-d".into(), "check", "checking", false);
    d.stage = "done".into();
    d.terminal = true;
    d.done = true;
    let d2 = normalize_stale_persisted(d.clone());
    assert_eq!(d2.stage, "done");
    assert!(d2.error.is_none());
}
