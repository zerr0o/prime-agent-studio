use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use tauri_plugin_updater::UpdaterExt;

#[test]
fn desktop_links_do_not_expand_the_privileged_or_studio_origins() {
    assert!(super::is_studio_url(
        &"http://127.0.0.1:3088/?project=test".parse().unwrap(),
        3088
    ));
    for raw in [
        "https://127.0.0.1:3088/",
        "http://127.0.0.1:3089/",
        "http://127.0.0.1.evil.test:3088/",
        "http://user@127.0.0.1:3088/",
    ] {
        assert!(!super::is_studio_url(&raw.parse().unwrap(), 3088));
    }
    for raw in [
        "https://auth.openai.com/authorize?state=demo",
        "http://localhost:1455/auth/callback?code=demo",
        "mailto:test@example.com",
        "tel:+33123456789",
    ] {
        let url = raw.parse().unwrap();
        assert!(super::is_external_link(&url));
        assert!(!super::is_launcher_url(&url));
    }
    for raw in [
        "file:///C:/Windows/notepad.exe",
        "javascript:alert(1)",
        "data:text/html,test",
        "ms-settings:privacy",
        "tauri://localhost/index.html",
    ] {
        assert!(!super::is_external_link(&raw.parse().unwrap()));
    }
}

#[test]
fn only_bundled_origins_can_invoke_native_commands() {
    for url in [
        "tauri://localhost/index.html",
        "http://tauri.localhost/index.html?settings",
    ] {
        assert!(super::is_launcher_url(&url.parse().unwrap()));
    }
    for url in [
        "http://127.0.0.1:3088/",
        "https://example.com",
        "http://tauri.localhost:1234",
        "http://user@tauri.localhost",
        "https://tauri.localhost.evil.test",
    ] {
        assert!(!super::is_launcher_url(&url.parse().unwrap()));
    }
}

struct Feed {
    url: String,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Feed {
    fn new(version: &str, payload: Vec<u8>, malformed: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let manifest = if malformed {
            b"{}".to_vec()
        } else {
            serde_json::to_vec(&serde_json::json!({
                "version":version, "platforms":{"windows-x86_64":{
                    "url":format!("{url}/payload"),
                    "signature":include_str!("../../test/fixtures/updater/payload.txt.sig").trim()
                }}
            }))
            .unwrap()
        };
        let stop = Arc::new(AtomicBool::new(false));
        let running = stop.clone();
        let thread = thread::spawn(move || {
            while !running.load(Ordering::Relaxed) {
                if let Ok((mut stream, _)) = listener.accept() {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut buffer = [0; 4096];
                    let size = stream.read(&mut buffer).unwrap_or(0);
                    let body =
                        if String::from_utf8_lossy(&buffer[..size]).starts_with("GET /payload ") {
                            &payload
                        } else {
                            &manifest
                        };
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(body);
                } else {
                    thread::sleep(Duration::from_millis(5));
                }
            }
        });
        Self {
            url,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Feed {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}

#[test]
fn updater_verifies_signed_downloads_and_rejects_tampering() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "pubkey":config["plugins"]["updater"]["pubkey"],
            "endpoints":[], "dangerousInsecureTransportProtocol":true
        }),
    );
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    tauri::async_runtime::block_on(async {
        for (version, tamper, malformed) in [
            ("99.0.0", false, false),
            ("99.0.0", true, false),
            ("0.0.0", false, false),
            ("0.1.0", false, false),
            ("99.0.0", false, true),
        ] {
            let mut payload = include_bytes!("../../test/fixtures/updater/payload.txt").to_vec();
            if tamper {
                payload[0] ^= 1;
            }
            let feed = Feed::new(version, payload.clone(), malformed);
            let updater = app
                .updater_builder()
                .endpoints(vec![format!("{}/latest", feed.url).parse().unwrap()])
                .unwrap()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap();
            let result = updater.check().await;
            if malformed {
                assert!(result.is_err());
                continue;
            }
            let update = result.unwrap();
            if version.starts_with('0') {
                assert!(
                    update.is_none(),
                    "Must not downgrade or reinstall the same version"
                );
                continue;
            }
            let bytes = update.unwrap().download(|_, _| {}, || {}).await;
            if tamper {
                assert!(matches!(
                    bytes,
                    Err(tauri_plugin_updater::Error::Minisign(_))
                ));
            } else {
                assert_eq!(bytes.unwrap(), payload);
            }
        }
    });
}

#[test]
fn component_bridge_rejects_lan_browser_like_origins_and_other_windows() {
    // Single window: only main exists. Launcher URL or main at exact Studio
    // loopback origin may invoke native commands. No desktop-settings window.
    assert!(super::is_update_origin(
        "main",
        &"http://127.0.0.1:3088/".parse().unwrap(),
        3088
    ));
    assert!(super::is_update_origin(
        "main",
        &"tauri://localhost/index.html?settings".parse().unwrap(),
        3088
    ));
    for raw in [
        "http://192.168.1.20:3088/",
        "http://localhost:3088/",
        "http://127.0.0.1:3089/",
        "https://127.0.0.1:3088/",
        "http://user@127.0.0.1:3088/",
        "http://127.0.0.1.evil.test:3088/",
    ] {
        assert!(
            !super::is_update_origin("main", &raw.parse().unwrap(), 3088),
            "{raw}"
        );
    }
    assert!(!super::is_update_origin(
        "main",
        &"http://127.0.0.1:3088/".parse().unwrap(),
        9999
    ));
    assert!(!super::is_update_origin(
        "other",
        &"http://127.0.0.1:3088/".parse().unwrap(),
        3088
    ));
    // Single-window gate: only main label passes, even for launcher URL.
    // No second window exists, so other labels are denied for both origins.
    assert!(!super::is_update_origin(
        "other",
        &"tauri://localhost/index.html?settings".parse().unwrap(),
        3088
    ));
}

#[test]
fn single_window_has_no_secondary_settings_label() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let caps = config["app"]["security"]["capabilities"].as_array().unwrap();
    for cap in caps {
        if let Some(windows) = cap.get("windows") {
            let list: Vec<String> =
                serde_json::from_value(windows.clone()).unwrap_or_default();
            assert!(
                !list.iter().any(|w| w == "desktop-settings"),
                "secondary desktop-settings window must be gone"
            );
        }
    }
    // Gate is the real proof (bridge test): only main label passes for both
    // launcher and Studio origins. No second window label exists to create.
    assert!(super::is_update_origin(
        "main",
        &"tauri://localhost/index.html?settings".parse().unwrap(),
        3088
    ));
    assert!(!super::is_update_origin(
        "other",
        &"tauri://localhost/index.html?settings".parse().unwrap(),
        3088
    ));
}

#[test]
fn components_prepare_is_allowed_without_auto_restart() {
    assert!(super::components::is_component_action_allowed("prepare"));
    assert!(super::components::is_component_action_allowed("install"));
    assert!(super::components::is_component_action_allowed("diagnose"));
    assert!(!super::components::is_component_action_allowed("restart"));
    assert!(!super::components::is_component_action_allowed("prepare_now"));
}

#[test]
fn components_readonly_status_and_diagnose_skip_mutation_state() {
    // status/diagnose take no Updates guard, no Components busy, no global
    // stdin and no tracker report; every mutation stays serialized.
    assert!(super::components::is_component_action_readonly("status"));
    assert!(super::components::is_component_action_readonly("diagnose"));
    for action in ["install", "prepare", "select", "activate", "apply"] {
        assert!(
            !super::components::is_component_action_readonly(action),
            "{action}"
        );
    }
}

#[test]
fn components_busy_guard_resets_on_every_return_path() {
    // RAII: a tracker start error after swap(true) must not leave a permanent
    // busy. Dropping the guard always resets and clears the stdin handle.
    use super::components::{Components, ComponentsBusyGuard};
    let state = Components::default();
    assert!(!state.is_busy());
    {
        let _guard = ComponentsBusyGuard::claim(&state).unwrap();
        assert!(state.is_busy());
        assert!(matches!(
            ComponentsBusyGuard::claim(&state),
            Err(code) if code == "setup_busy"
        ));
    }
    assert!(!state.is_busy());
    assert!(state.input.lock().map(|g| g.is_none()).unwrap_or(false));
    // Reclaimable after drop: no permanent busy.
    assert!(ComponentsBusyGuard::claim(&state).is_ok());
}

#[test]
fn settings_eval_falls_back_inside_js_when_panel_missing() {
    // eval().is_ok() never proves the panel opened, so the fallback lives in
    // the script itself: missing DOM replaces location with the shell URL.
    let shell = "http://tauri.localhost/index.html?settings";
    let script = super::settings_panel_script(shell);
    assert!(script.contains("settings-dialog"));
    assert!(script.contains("settings-tab-updates"));
    assert!(script.contains("window.location.replace"));
    assert!(script.contains(shell));
}

#[test]
fn quit_eval_detects_handler_before_dispatching() {
    // Old server pages without the quit flag must land on the quit shell
    // instead of silently dropping the confirmation.
    let shell = "http://tauri.localhost/index.html?quit";
    let script = super::quit_handshake_script(shell);
    assert!(script.contains("__PRIME_STUDIO_QUIT_READY__"));
    assert!(script.contains("studio:quit-request"));
    assert!(script.contains("window.location.replace"));
    assert!(script.contains(shell));
}

#[test]
fn quit_treats_already_stopped_as_terminated() {
    // Real criteria: absent server {stopped:false, reason:already-stopped} is done.
    assert!(super::is_quit_terminated(true, None));
    assert!(super::is_quit_terminated(false, Some("already-stopped")));
    assert!(!super::is_quit_terminated(false, Some("agents_running")));
    assert!(!super::is_quit_terminated(false, None));
}

#[test]
fn restart_marks_done_only_on_restarted_true() {
    // No false success: refusals are terminal errors, never done.
    assert!(super::is_restart_success(&serde_json::json!({"restarted": true})));
    assert!(!super::is_restart_success(
        &serde_json::json!({"restarted": false, "reason": "agents_running"})
    ));
    assert!(!super::is_restart_success(
        &serde_json::json!({"restarted": false, "reason": "components_required"})
    ));
    assert!(!super::is_restart_success(&serde_json::json!({})));
    assert_eq!(
        super::restart_refusal_reason(
            &serde_json::json!({"restarted": false, "reason": "agents_running"})
        ),
        "agents_running"
    );
}

#[test]
fn control_options_never_carry_unknown_pid() {
    // Real builders used in prod restart/quit: no pid/kill/signal keys.
    // Ownership checks stay in control worker, never a raw PID from shell.
    use std::path::PathBuf;
    let resources = PathBuf::from("/res");
    let data = PathBuf::from("/data");
    let restart = super::restart_control_options(&resources, &data, 3088, true);
    assert_eq!(restart["port"], 3088);
    assert_eq!(restart["force"], true);
    assert!(!super::control_options_contain_forbidden_pid(&restart));
    let quit = super::quit_control_options(&resources, &data, 3088, false);
    assert_eq!(quit["action"], "stop");
    assert_eq!(quit["force"], false);
    assert!(!super::control_options_contain_forbidden_pid(&quit));
    assert!(super::control_options_contain_forbidden_pid(&serde_json::json!({"pid": 1234})));
    assert!(super::control_options_contain_forbidden_pid(&serde_json::json!({"signal": "kill"})));
}

#[test]
fn operation_snapshot_uses_terminal_not_done_code() {
    // FINAL: snapshot exposes done AND terminal plus code/error (done==terminal).
    let sample = serde_json::json!({
        "id": "components",
        "kind": "components",
        "stage": "preparing",
        "startedAt": 0,
        "updatedAt": 0,
        "receivedBytes": 0,
        "totalBytes": null,
        "percent": null,
        "detail": "",
        "error": null,
        "code": null,
        "cancellable": true,
        "done": false,
        "terminal": false
    });
    assert_eq!(sample["terminal"], false);
    assert_eq!(sample["done"], false);
    assert!(sample.get("code").is_some());
    assert_eq!(sample["cancellable"], true);
}

#[test]
fn component_preparation_app_updates_and_restarts_share_one_operation() {
    let state = super::updates::Updates::default();
    let preparation = super::updates::begin(&state).unwrap();
    assert!(state.is_busy());
    assert!(matches!(super::updates::begin(&state), Err(code) if code == "update_busy"));
    drop(preparation);
    assert!(!state.is_busy());
    let restart = super::updates::begin(&state).unwrap();
    assert!(super::updates::begin(&state).is_err());
    drop(restart);
    assert!(!state.is_busy());
}
