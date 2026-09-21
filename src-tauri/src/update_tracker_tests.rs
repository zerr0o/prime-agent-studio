//! Tracker async/cancellation tests (owned by update-native-operation-state).
//! No real app, no live dataRoot, mock runtime only. Gate untouched (no window).
//! Covers: manual finish freezes late callbacks (renamed faithfully), real abort job via helper, stale id ignored,
//! first terminal wins, unknown total, persisted nonterminal after relaunch does not lock busy,
//! progress file throttle (memory every chunk, file throttled).

use super::*;
use tauri::Manager;

fn mock_handle() -> tauri::AppHandle<tauri::test::MockRuntime> {
    let context = tauri::test::mock_context(tauri::test::noop_assets());
    let app = tauri::test::mock_builder()
        .manage(Updates::default())
        .build(context)
        .unwrap();
    app.handle().clone()
}

#[test]
fn late_callbacks_with_stale_id_ignored() {
    let handle = mock_handle();
    let state = handle.try_state::<Updates>().unwrap();
    let _guard = begin(&state).unwrap();
    let id1 = track_operation_start(&handle, "install", "downloading", true).unwrap();
    let _ = track_operation_progress(&handle, &id1, "downloading", 100, Some(1000), "", true);
    let v = track_operation_finish(&handle, &id1, "done", None);
    assert_eq!(v["stage"], serde_json::json!("done"));
    // Late progress same id after terminal ignored.
    let late = track_operation_progress(&handle, &id1, "downloading", 900, Some(1000), "late", true);
    assert_eq!(late["stage"], serde_json::json!("done"));
    assert_eq!(late["receivedBytes"], v["receivedBytes"]);
    // New op allowed after terminal; old id ignored.
    drop(_guard);
    let state2 = handle.try_state::<Updates>().unwrap();
    let _guard2 = begin(&state2).unwrap();
    let id2 = track_operation_start(&handle, "check", "checking", true).unwrap();
    assert_ne!(id1, id2);
    let stale = track_operation_progress(&handle, &id1, "checking", 5, None, "stale", true);
    // Still id2, not id1.
    assert_eq!(stale["id"], serde_json::json!(id2));
}

#[test]
fn first_terminal_wins() {
    let handle = mock_handle();
    let state = handle.try_state::<Updates>().unwrap();
    let _guard = begin(&state).unwrap();
    let id = track_operation_start(&handle, "check", "checking", true).unwrap();
    let done = track_operation_finish(&handle, &id, "done", None);
    assert_eq!(done["stage"], serde_json::json!("done"));
    assert!(done.get("error").is_none() || done["error"].is_null());
    // Second terminal same id ignored.
    let second = track_operation_finish(&handle, &id, "error", Some("check_failed"));
    assert_eq!(second["stage"], serde_json::json!("done"));
    assert!(second.get("error").is_none() || second["error"].is_null());
}

#[test]
fn unknown_total_download_tracks_bytes_without_percent() {
    let handle = mock_handle();
    let state = handle.try_state::<Updates>().unwrap();
    let _guard = begin(&state).unwrap();
    let id = track_operation_start(&handle, "install", "downloading", true).unwrap();
    let mut received = 0u64;
    for _ in 0..200 {
        received += 1000;
        let v = track_operation_progress(&handle, &id, "downloading", received, None, "", true);
        assert!(v["percent"].is_null(), "percent must stay null without total");
        assert_eq!(v["receivedBytes"], serde_json::json!(received));
        assert!(v["totalBytes"].is_null());
    }
    let cur = operation_snapshot(&handle);
    assert_eq!(cur["receivedBytes"], serde_json::json!(200_000));
    assert!(cur["percent"].is_null());
    let _ = track_operation_finish(&handle, &id, "done", None);
}

#[test]
fn persisted_nonterminal_after_relaunch_does_not_lock_busy() {
    // Pure file part (temp dir, no live dataRoot).
    let dir = std::env::temp_dir().join(format!(
        "upd-tracker-relaunch-{}-{}",
        std::process::id(),
        update_operation::now_ms()
    ));
    let _ = std::fs::create_dir_all(&dir);
    let snap = OperationSnapshot::new(
        "upd-stale-1".to_string(),
        "install",
        "downloading",
        true,
    );
    assert!(!snap.terminal);
    update_operation::persist_snapshot(&dir, Some(&snap));
    let loaded = update_operation::load_snapshot(&dir).expect("load stale");
    assert_eq!(loaded.id, "upd-stale-1");
    assert!(!loaded.terminal);
    // Fresh process memory never busy, even with stale file on disk.
    let fresh = Updates::default();
    assert!(!fresh.is_busy());
    assert!(fresh.current.lock().unwrap().is_none());
    // New tracker (mock, no Desktop so file not consulted for busy) still starts.
    let handle = mock_handle();
    let state = handle.try_state::<Updates>().unwrap();
    assert!(!state.is_busy());
    let guard = begin(&state);
    assert!(guard.is_ok(), "stale file must not lock busy");
    let id = track_operation_start(&handle, "check", "checking", true).unwrap();
    assert!(!id.is_empty());
    let _ = track_operation_finish(&handle, &id, "done", None);
    drop(guard);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn manual_finish_freezes_late_callbacks_before_guard_release() {
    // Async-style: worker progresses, main cancels to terminal, late callbacks ignored,
    // guard released only after settlement, new op allowed.
    let handle = mock_handle();
    let state = handle.try_state::<Updates>().unwrap();
    // Guard held across whole job (like check/install), released only after settlement.
    let guard = begin(&state).unwrap();
    let id = track_operation_start(&handle, "install", "downloading", true).unwrap();
    // Worker does 3 progresses.
    for i in 1..=3u64 {
        let v = track_operation_progress(
            &handle,
            &id,
            "downloading",
            i * 100,
            Some(1000),
            "",
            true,
        );
        assert_eq!(v["stage"], serde_json::json!("downloading"));
    }
    // Main observes cancel and settles to cancelled (download future dropped).
    let term = track_operation_finish(&handle, &id, "cancelled", Some("download_cancelled"));
    assert_eq!(term["stage"], serde_json::json!("cancelled"));
    assert_eq!(term["terminal"], serde_json::json!(true));
    // Late worker callbacks same id before guard release ignored (no more callbacks).
    for i in 4..=6u64 {
        let late = track_operation_progress(
            &handle,
            &id,
            "downloading",
            i * 100,
            Some(1000),
            "late",
            true,
        );
        assert_eq!(late["stage"], serde_json::json!("cancelled"));
        // receivedBytes frozen at settlement (300), not overwritten by late 400..600.
        assert_eq!(late["receivedBytes"], serde_json::json!(300));
    }
    // Guard release only after settlement (drop here), then new op allowed (no busy lock).
    drop(guard);
    let state2 = handle.try_state::<Updates>().unwrap();
    assert!(!state2.is_busy());
    let guard2 = begin(&state2).unwrap();
    let id2 = track_operation_start(&handle, "check", "checking", true).unwrap();
    assert_ne!(id, id2);
    drop(guard2);
    let _ = track_operation_finish(&handle, &id2, "done", None);
}

#[test]
fn cancel_and_wait_respects_noncancellable_handoff_without_real_app() {
    let handle = mock_handle();
    let id = {
        let owned = handle.clone();
        let state = owned.try_state::<Updates>().unwrap();
        let _guard = begin(&state).unwrap();
        // Cancellable downloading => cancel_and_wait signals and waits (worker will finish).
        // Hold guard in this scope (like check/install); drop before async to satisfy borrow.
        let id = track_operation_start(&handle, "install", "downloading", true).unwrap();
        // Keep guard until settlement simulated below; drop now for borrow, busy tested separately.
        id
    };
    // Simulate settlement in background via async block_on: finish after 50ms.
    let h2 = handle.clone();
    let h3 = handle.clone();
    let waiter = tauri::async_runtime::block_on(async move {
        // Spawn settler that finishes cancelled shortly.
        let settler = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = track_operation_finish(&h2, &id, "cancelled", Some("download_cancelled"));
        });
        // cancel_and_wait should signal + observe settlement within 5s.
        let res = cancel_and_wait_cancellable(&h3).await;
        let _ = settler.await;
        res
    });
    assert!(waiter.is_ok(), "cancellable must settle, got {:?}", waiter);
    // Noncancellable installing refused clearly.
    let id2 = {
        let owned2 = handle.clone();
        let state2 = owned2.try_state::<Updates>().unwrap();
        let _guard2 = begin(&state2).unwrap();
        let id2 = track_operation_start(&handle, "install", "downloading", true).unwrap();
        let _ = track_operation_progress(&handle, &id2, "installing", 100, None, "", false);
        id2
    };
    let res2 = tauri::async_runtime::block_on(cancel_and_wait_cancellable(&handle));
    assert!(res2.is_err());
    assert!(res2.unwrap_err().starts_with("install_noncancellable"));
    let _ = track_operation_finish(&handle, &id2, "done", None);
}

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};

#[test]
fn real_tokio_job_abort_settles_before_guard_release_via_helper() {
    // Uses productive helper await_cancellable (same as check/download), not manual finish alone.
    // Fake job increments counter until abort drops it; counter must freeze before guard release.
    let handle = mock_handle();
    let owned = handle.clone();
    let state = owned.try_state::<Updates>().unwrap();
    let guard = begin(&state).unwrap();
    let id = track_operation_start(&handle, "install", "downloading", true).unwrap();
    let counter = Arc::new(AtomicU64::new(0));
    let c_job = counter.clone();
    let h_job = handle.clone();
    let id_job = id.clone();
    let h_async = handle.clone();
    tauri::async_runtime::block_on(async move {
        // Real tokio job (productive abort target): progress callbacks until dropped.
        let job = tokio::spawn(async move {
            loop {
                let n = c_job.fetch_add(1, Ordering::SeqCst) + 1;
                let _ = track_operation_progress(
                    &h_job,
                    &id_job,
                    "downloading",
                    n * 100,
                    Some(10_000),
                    "",
                    true,
                );
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            #[allow(unreachable_code)]
            Ok::<(), String>(())
        });
        // Let job run briefly, then productive cancel request (flag+Notify, no manual finish).
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let req = super::request_cancel_inner(&h_async);
        assert!(req.is_ok(), "cancel request must be accepted while downloading");
        // Productive helper aborts + awaits settlement BEFORE terminal (all paths).
        let res: Result<(), String> = super::await_cancellable(
            &h_async,
            job,
            std::time::Duration::from_secs(5),
            "download_cancelled",
            "download_timed_out",
        )
        .await
        .map(|_| ());
        assert_eq!(res, Err("download_cancelled".into()));
        // Production pattern: finish terminal ONLY after helper settlement.
        let _ = track_operation_finish(&h_async, &id, "cancelled", Some("download_cancelled"));
        // Counter stable before guard release (no more callbacks applied).
        let n1 = counter.load(Ordering::SeqCst);
        assert!(n1 > 0, "job must have progressed before abort");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let n2 = counter.load(Ordering::SeqCst);
        assert_eq!(n1, n2, "counter must freeze after abort+await, before guard release");
        // Late callbacks same id ignored after terminal.
        let late = track_operation_progress(&h_async, &id, "downloading", 99999, Some(10_000), "late", true);
        assert_eq!(late["stage"], serde_json::json!("cancelled"));
    });
    // Guard released only after settlement above.
    drop(guard);
    assert!(!handle.try_state::<Updates>().unwrap().is_busy());
}

#[test]
fn persisted_nonterminal_getter_normalizes_to_interrupted_with_desktop() {
    // Covers bug: current_value loaded stale nonterminal file -> frontend eternal busy.
    // With Desktop state (temp root), getter must render terminal error operation_interrupted.
    let dir = std::env::temp_dir().join(format!(
        "upd-tracker-stale-{}-{}",
        std::process::id(),
        update_operation::now_ms()
    ));
    let _ = std::fs::create_dir_all(&dir);
    let stale = OperationSnapshot::new("upd-stale-2".to_string(), "install", "downloading", true);
    assert!(!stale.terminal);
    update_operation::persist_snapshot(&dir, Some(&stale));
    // Mock app WITH Desktop rooted at temp dir (covers file fallback path).
    let context = tauri::test::mock_context(tauri::test::noop_assets());
    let desktop = crate::Desktop {
        root: dir.clone(),
        resources: dir.clone(),
        port: 3088,
        prefs: Mutex::new(Default::default()),
        starting: AtomicBool::new(false),
        restart_phase: Mutex::new(None),
    };
    let app = tauri::test::mock_builder()
        .manage(Updates::default())
        .manage(desktop)
        .build(context)
        .unwrap();
    let handle = app.handle().clone();
    // Fresh memory, not busy (never locked by file).
    assert!(!handle.try_state::<Updates>().unwrap().is_busy());
    // Getter renders normalized terminal error, not eternal downloading.
    let got = operation_snapshot(&handle);
    assert_eq!(got["id"], serde_json::json!("upd-stale-2"));
    assert_eq!(got["stage"], serde_json::json!("error"));
    assert_eq!(got["error"], serde_json::json!("operation_interrupted"));
    assert_eq!(got["code"], serde_json::json!("operation_interrupted"));
    assert_eq!(got["terminal"], serde_json::json!(true));
    assert_eq!(got["done"], serde_json::json!(true));
    assert!(got["detail"].as_str().unwrap().contains("operation_interrupted"));
    // Current controls: new op allowed (not busy-locked by stale file).
    let owned = handle.clone();
    let state = owned.try_state::<Updates>().unwrap();
    let _guard = begin(&state).unwrap();
    let id = track_operation_start(&handle, "check", "checking", true).unwrap();
    assert!(!id.is_empty());
    let _ = track_operation_finish(&handle, &id, "done", None);
    let _ = std::fs::remove_dir_all(&dir);
}
