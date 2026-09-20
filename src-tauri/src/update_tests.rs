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
    assert!(super::is_update_origin(
        "main",
        &"http://127.0.0.1:3088/".parse().unwrap(),
        3088
    ));
    assert!(super::is_update_origin(
        "desktop-settings",
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
        "desktop-settings",
        &"http://127.0.0.1:3088/".parse().unwrap(),
        3088
    ));
    assert!(!super::is_update_origin(
        "other",
        &"http://127.0.0.1:3088/".parse().unwrap(),
        3088
    ));
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
