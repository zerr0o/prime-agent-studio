//! Prerelease (beta) update channel selection (pure, no Tauri, no network).
//! Included by updates.rs; selection never supplies arbitrary download URLs.
//!
//! Channel policy:
//! - Stable channel (includePrereleases=false, default) uses the configured
//!   `latest.json` endpoint only. Preserved in updates.rs, untouched here.
//! - Prerelease channel (includePrereleases=true) uses the fixed public GitHub
//!   `zerr0o/prime-agent-studio` releases metadata, considers both eligible
//!   stable releases and all SemVer prereleases, picks the newest semver strictly greater
//!   than current (never downgrade/equal), rejects drafts, unsupported tags
//!   and releases missing a supported manifest asset, then builds a trusted
//!   fixed `.../releases/download/v<version>/(beta.json|latest.json)` URL.
//!   Arbitrary API URLs (browser_download_url, etc.) are never trusted.
//! - Manifest version must match the selected tag exactly. A selected newer
//!   tag with a mismatched/older/equal manifest is an explicit version
//!   mismatch error, never a silent available=false (review invariant).
//! - Native signature verification stays inside tauri-plugin-updater
//!   (Update::download verifies minisign). This module never downloads
//!   payloads directly.

use std::cmp::Ordering;

pub const RELEASES_API_URL: &str =
    "https://api.github.com/repos/zerr0o/prime-agent-studio/releases?per_page=100";
pub const DOWNLOAD_BASE_URL: &str =
    "https://github.com/zerr0o/prime-agent-studio/releases/download";

pub const STABLE_MANIFEST: &str = "latest.json";
pub const BETA_MANIFEST: &str = "beta.json";

pub const ERR_METADATA_FAILED: &str = "prerelease_metadata_failed";
pub const ERR_MANIFEST_FAILED: &str = "prerelease_manifest_failed";
pub const ERR_VERSION_MISMATCH: &str = "prerelease_version_mismatch";
pub const ERR_CHANNEL_CHANGED: &str = "update_channel_changed";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelVersion {
    pub version: semver::Version,
    pub version_string: String,
    pub manifest_file: &'static str,
    pub tag: String,
}

/// Parse a canonical SemVer version, including arbitrary prerelease labels.
/// Keep input bounded and let the updater's own version library reject unsafe syntax.
pub fn parse_version_string(raw: &str) -> Option<ChannelVersion> {
    let s = raw.trim();
    if s.is_empty() || s.len() > 128 {
        return None;
    }
    let version = semver::Version::parse(s).ok()?;
    let version_string = version.to_string();
    if s != version_string {
        return None;
    }
    let manifest_file = if version.pre.is_empty() {
        STABLE_MANIFEST
    } else {
        BETA_MANIFEST
    };
    Some(ChannelVersion {
        version,
        version_string: version_string.clone(),
        manifest_file,
        tag: format!("v{version_string}"),
    })
}

/// GitHub tags must retain the canonical `v<SemVer>` shape.
pub fn parse_tag_version(raw: &str) -> Option<ChannelVersion> {
    let s = raw.trim();
    let v = parse_version_string(s.strip_prefix('v')?)?;
    if s != v.tag {
        return None;
    }
    Some(v)
}

pub fn cmp_versions(a: &ChannelVersion, b: &ChannelVersion) -> Ordering {
    // Build metadata does not make an equal version an upgrade.
    a.version.cmp_precedence(&b.version)
}

pub fn is_newer_than(candidate: &ChannelVersion, current: &ChannelVersion) -> bool {
    cmp_versions(candidate, current) == Ordering::Greater
}

pub fn include_prereleases_or_default(v: Option<bool>) -> bool {
    v.unwrap_or(false)
}

pub fn verify_channel(pending_include: bool, requested_include: bool) -> Result<(), &'static str> {
    if pending_include == requested_include {
        Ok(())
    } else {
        Err(ERR_CHANNEL_CHANGED)
    }
}

/// Build the trusted fixed manifest URL for an already-validated version.
/// Canonical only: `.../releases/download/v<version>/(beta.json|latest.json)`.
/// Never uses API-provided URLs.
pub fn build_manifest_url(v: &ChannelVersion) -> String {
    format!("{}/{}/{}", DOWNLOAD_BASE_URL, v.tag, v.manifest_file)
}

/// Validate that a URL is exactly the trusted fixed shape for some valid
/// version: https scheme, github.com host, fixed owner/repo/download prefix,
/// single `v<version>` segment, allowlisted manifest filename,
/// no query/fragment/encoding tricks. Used at runtime (defense in depth)
/// and in endpoint-safety tests.
pub fn manifest_url_is_trusted(url: &str) -> bool {
    if url.len() > 256 || url.is_empty() {
        return false;
    }
    if url.chars().any(|c| c.is_control()) {
        return false;
    }
    if url
        .chars()
        .any(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '\\'))
    {
        return false;
    }
    let prefix = format!("{DOWNLOAD_BASE_URL}/v");
    let rest = match url.strip_prefix(prefix.as_str()) {
        Some(r) => r,
        None => return false,
    };
    // Reject query/fragment/percent/userinfo tricks outright.
    if rest.chars().any(|c| matches!(c, '?' | '#' | '@' | '%')) {
        return false;
    }
    if rest.contains("..") {
        return false;
    }
    let mut parts = rest.split('/');
    let version_part = match parts.next() {
        Some(p) => p,
        None => return false,
    };
    let file_part = match parts.next() {
        Some(p) => p,
        None => return false,
    };
    // Exactly two segments, no trailing slash or extra path.
    if parts.next().is_some() {
        return false;
    }
    if file_part != STABLE_MANIFEST && file_part != BETA_MANIFEST {
        return false;
    }
    let Some(parsed) = parse_version_string(version_part) else {
        return false;
    };
    // Both known manifest names are allowed, never an API-provided URL.
    format!("{}/{}/{}", DOWNLOAD_BASE_URL, parsed.tag, file_part) == url
}

/// Both GitHub stable releases and prereleases are eligible in this opt-in channel.
/// The GitHub flag is metadata, not a constraint on the SemVer suffix.
/// Require a published release and a known manifest asset; never trust its URL.
pub fn eligible_from_api(value: &serde_json::Value) -> Option<ChannelVersion> {
    if value.get("draft").and_then(|v| v.as_bool()) != Some(false) {
        return None;
    }
    value.get("prerelease")?.as_bool()?;
    let tag = value.get("tag_name").and_then(|v| v.as_str())?;
    let mut parsed = parse_tag_version(tag)?;
    let assets = value.get("assets").and_then(|v| v.as_array())?;
    // Prefer the historical name for this version, but accept either supported
    // manifest name regardless of the release's suffix or GitHub channel flag.
    parsed.manifest_file = [parsed.manifest_file, STABLE_MANIFEST, BETA_MANIFEST]
        .into_iter()
        .find(|name| {
            assets
                .iter()
                .any(|asset| asset.get("name").and_then(|v| v.as_str()) == Some(*name))
        })?;
    Some(parsed)
}

/// Collect eligible versions from a parsed releases-list JSON value.
/// Caller must have verified the value is an array (non-array is a metadata
/// failure, not an empty list). Ineligible entries are skipped, never errors.
pub fn collect_eligible(json: &serde_json::Value) -> Vec<ChannelVersion> {
    let Some(arr) = json.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in arr {
        if let Some(v) = eligible_from_api(entry) {
            out.push(v);
        }
    }
    out
}

/// Newest eligible strictly greater than current, or None (no downgrade/equal).
pub fn select_newest<'a>(
    candidates: &'a [ChannelVersion],
    current: &ChannelVersion,
) -> Option<&'a ChannelVersion> {
    let mut best: Option<&'a ChannelVersion> = None;
    for c in candidates {
        if !is_newer_than(c, current) {
            continue;
        }
        match best {
            None => best = Some(c),
            Some(b) => {
                if cmp_versions(c, b) == Ordering::Greater {
                    best = Some(c);
                }
            }
        }
    }
    best
}

/// Validate that a fetched manifest `version` string matches the selected tag
/// exactly (canonical). Mismatch/older/equal-vs-selected is false and the
/// caller must return an explicit version-mismatch error, never silent false.
pub fn validate_manifest_version(manifest_version: &str, selected: &ChannelVersion) -> bool {
    let s = manifest_version.trim();
    let Some(parsed) = parse_version_string(s) else {
        return false;
    };
    parsed.version == selected.version
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> ChannelVersion {
        parse_version_string(s).unwrap_or_else(|| panic!("must parse {s}"))
    }

    fn t(s: &str) -> ChannelVersion {
        parse_tag_version(s).unwrap_or_else(|| panic!("must parse tag {s}"))
    }

    #[test]
    fn default_is_stable_only() {
        assert!(!include_prereleases_or_default(None));
        assert!(include_prereleases_or_default(Some(true)));
        assert!(!include_prereleases_or_default(Some(false)));
        let stable = t("v3.10.0");
        assert!(stable.version.pre.is_empty());
        assert_eq!(stable.manifest_file, "latest.json");
        assert_eq!(stable.version_string, "3.10.0");
        let beta = t("v3.10.0-beta.4");
        assert!(!beta.version.pre.is_empty());
        assert_eq!(beta.manifest_file, "beta.json");
        assert_eq!(beta.version_string, "3.10.0-beta.4");
    }

    #[test]
    fn channel_mismatch_returns_update_channel_changed() {
        assert!(verify_channel(false, false).is_ok());
        assert!(verify_channel(true, true).is_ok());
        assert_eq!(
            verify_channel(false, true).unwrap_err(),
            "update_channel_changed"
        );
        assert_eq!(
            verify_channel(true, false).unwrap_err(),
            "update_channel_changed"
        );
    }

    #[test]
    fn beta_eligibility_and_ordering_vs_stable_promotion() {
        let current = v("3.10.0-beta.3");
        let beta4 = v("3.10.0-beta.4");
        let beta5 = v("3.10.0-beta.5");
        let stable_new = v("3.10.0");
        let stable_old = v("3.9.9");
        let beta_old = v("3.10.0-beta.2");
        // Stable promotion: same core stable beats newer beta numerically?
        // 3.10.0 (stable) > 3.10.0-beta.5 > 3.10.0-beta.4 > current.
        assert!(is_newer_than(&beta4, &current));
        assert!(is_newer_than(&beta5, &current));
        assert!(is_newer_than(&stable_new, &current));
        assert!(!is_newer_than(&stable_old, &current));
        assert!(!is_newer_than(&beta_old, &current));
        assert!(!is_newer_than(&current, &current));
        assert_eq!(
            cmp_versions(&stable_new, &beta5),
            std::cmp::Ordering::Greater
        );
        assert_eq!(cmp_versions(&beta5, &beta4), std::cmp::Ordering::Greater);
        let pool = vec![
            beta4.clone(),
            beta_old.clone(),
            stable_old.clone(),
            beta5.clone(),
            stable_new.clone(),
        ];
        let best = select_newest(&pool, &current).expect("must pick newest");
        assert_eq!(best, &stable_new, "stable promotion must win over beta");
        // Beta-only pool picks newest beta.
        let beta_pool = vec![beta4.clone(), beta5.clone(), beta_old.clone()];
        let best_beta = select_newest(&beta_pool, &current).expect("must pick beta");
        assert_eq!(best_beta, &beta5);
        // Equal/older only => None (never downgrade/equal).
        let stale = vec![current.clone(), beta_old.clone(), stable_old.clone()];
        assert!(select_newest(&stale, &current).is_none());
        // Empty => None (available=false, not error).
        let empty: Vec<ChannelVersion> = Vec::new();
        assert!(select_newest(&empty, &current).is_none());
    }

    #[test]
    fn drafts_are_excluded() {
        let base = serde_json::json!({
            "tag_name": "v3.10.0-beta.4",
            "draft": false,
            "prerelease": true,
            "assets": [{"name": "beta.json"}]
        });
        assert!(eligible_from_api(&base).is_some());
        let mut draft = base.clone();
        draft["draft"] = serde_json::json!(true);
        assert!(
            eligible_from_api(&draft).is_none(),
            "drafts must be rejected"
        );
        let mut missing_draft = base.clone();
        missing_draft.as_object_mut().unwrap().remove("draft");
        assert!(
            eligible_from_api(&missing_draft).is_none(),
            "missing draft flag must be rejected (strict false required)"
        );
        // GitHub prerelease status does not have to match a suffix.
        let stable_as_prerelease = serde_json::json!({
            "tag_name": "v3.10.0",
            "draft": false,
            "prerelease": true,
            "assets": [{"name": "latest.json"}]
        });
        assert!(eligible_from_api(&stable_as_prerelease).is_some());
        let beta_as_stable = serde_json::json!({
            "tag_name": "v3.10.0-beta.4",
            "draft": false,
            "prerelease": false,
            "assets": [{"name": "beta.json"}]
        });
        assert!(eligible_from_api(&beta_as_stable).is_some());
    }

    #[test]
    fn all_semver_prereleases_are_selected_without_a_beta_suffix() {
        let release = |tag: &str, manifest: &str| {
            serde_json::json!({
                "tag_name": tag, "draft": false, "prerelease": true,
                "assets": [{"name": manifest, "browser_download_url": "https://evil.example/ignored"}]
            })
        };
        // Regression: the installed 4.0.0 must see GitHub's prerelease 4.0.1.
        let published = collect_eligible(&serde_json::json!([
            release("v4.0.0", "latest.json"),
            release("v4.0.1", "latest.json")
        ]));
        let selected = select_newest(&published, &v("4.0.0")).unwrap();
        assert_eq!(selected.version_string, "4.0.1");
        assert!(validate_manifest_version("4.0.1", selected));
        assert!(!validate_manifest_version("4.0.0", selected));
        assert!(select_newest(&published, &v("4.0.1")).is_none());

        let tags = [
            "v4.1.0-alpha.1",
            "v4.1.0-beta.2",
            "v4.1.0-beta.10",
            "v4.1.0-rc.1",
            "v4.1.0",
        ];
        for manifest in [STABLE_MANIFEST, BETA_MANIFEST] {
            let pool: Vec<_> = tags
                .iter()
                .map(|tag| {
                    let candidate = eligible_from_api(&release(tag, manifest)).unwrap();
                    assert_eq!(candidate.manifest_file, manifest);
                    assert!(manifest_url_is_trusted(&build_manifest_url(&candidate)));
                    assert!(validate_manifest_version(
                        &candidate.version_string,
                        &candidate
                    ));
                    candidate
                })
                .collect();
            for pair in pool.windows(2) {
                assert!(is_newer_than(&pair[1], &pair[0]));
            }
            assert_eq!(
                select_newest(&pool, &v("4.0.1")).unwrap().version_string,
                "4.1.0"
            );
        }
        assert!(!is_newer_than(&v("4.0.1+build.2"), &v("4.0.1+build.1")));
        let mut bad_flag = release("v4.0.1", "latest.json");
        bad_flag["prerelease"] = serde_json::json!("true");
        assert!(eligible_from_api(&bad_flag).is_none());
        assert!(eligible_from_api(&release("v4.0.1", "custom.json")).is_none());
    }

    #[test]
    fn malformed_tags_and_assets_rejected() {
        for bad in [
            "",
            "3.10.0",
            "v",
            "v1.2",
            "v1.2.3.4",
            "v1.2.3-",
            "v1.2.3-beta.",
            "v01.2.3",
            "v1.02.3",
            "v1.2.03",
            "v1.2.3-beta.04",
            "V1.2.3",
            "v1.2.3 beta.4",
            "v1..3",
            "v.2.3",
            "v999999999999999999999.0.0",
        ] {
            assert!(
                parse_tag_version(bad).is_none(),
                "malformed tag must be rejected: {bad}"
            );
        }
        for bad in ["", "1.2", "01.2.3", "1.2.3-beta.04"] {
            assert!(
                parse_version_string(bad).is_none(),
                "malformed version must be rejected: {bad}"
            );
        }
        // Assets: missing, wrong shape, wrong file, case mismatch.
        let good_tag = "v3.10.0-beta.4";
        for assets in [
            serde_json::json!(null),
            serde_json::json!({}),
            serde_json::json!([]),
            serde_json::json!([{"name": "BETA.JSON"}]),
            serde_json::json!([{"name": "beta.json "}]),
            serde_json::json!([{"other": "beta.json"}]),
            serde_json::json!("beta.json"),
        ] {
            let entry = serde_json::json!({
                "tag_name": good_tag,
                "draft": false,
                "prerelease": true,
                "assets": assets
            });
            assert!(
                eligible_from_api(&entry).is_none(),
                "bad assets must be rejected"
            );
        }
        // Either recognized manifest name can be used, including stable-form prereleases.
        let stable_wrong = serde_json::json!({
            "tag_name": "v3.10.0",
            "draft": false,
            "prerelease": false,
            "assets": [{"name": "beta.json"}]
        });
        assert!(eligible_from_api(&stable_wrong).is_some());
        let stable_good = serde_json::json!({
            "tag_name": "v3.10.0",
            "draft": false,
            "prerelease": false,
            "assets": [{"name": "latest.json"}]
        });
        assert!(eligible_from_api(&stable_good).is_some());
    }

    #[test]
    fn endpoint_safety_ignores_api_urls_and_rejects_injection() {
        let beta = v("3.10.0-beta.4");
        let stable = v("3.10.0");
        let beta_url = build_manifest_url(&beta);
        let stable_url = build_manifest_url(&stable);
        assert_eq!(
            beta_url,
            "https://github.com/zerr0o/prime-agent-studio/releases/download/v3.10.0-beta.4/beta.json"
        );
        assert_eq!(
            stable_url,
            "https://github.com/zerr0o/prime-agent-studio/releases/download/v3.10.0/latest.json"
        );
        assert!(manifest_url_is_trusted(&beta_url));
        assert!(manifest_url_is_trusted(&stable_url));
        // API-provided evil URLs are never used: builder output stays fixed.
        let evil_entry = serde_json::json!({
            "tag_name": "v3.10.0-beta.4",
            "draft": false,
            "prerelease": true,
            "assets": [{"name": "beta.json", "browser_download_url": "https://evil.example/pwned.json"}],
            "url": "https://evil.example/releases/1",
            "assets_url": "https://evil.example/assets"
        });
        let parsed = eligible_from_api(&evil_entry).expect("eligible despite evil extra fields");
        assert_eq!(build_manifest_url(&parsed), beta_url);
        assert!(!beta_url.contains("evil"));
        for evil in [
            "http://github.com/zerr0o/prime-agent-studio/releases/download/v3.10.0/latest.json",
            "https://evil.example/zerr0o/prime-agent-studio/releases/download/v3.10.0/latest.json",
            "https://github.com.evil.example/zerr0o/prime-agent-studio/releases/download/v3.10.0/latest.json",
            "https://github.com/zerr0o/prime-agent-studio/releases/download/v3.10.0/latest.json?token=abc",
            "https://github.com/zerr0o/prime-agent-studio/releases/download/v3.10.0/latest.json#frag",
            "https://github.com/zerr0o/prime-agent-studio/releases/download/v3.10.0/../evil/latest.json",
            "https://github.com/zerr0o/prime-agent-studio/releases/download/v3.10.0/%2e%2e/latest.json",
            "https://github.com/zerr0o/prime-agent-studio/releases/download/v1.2.3/latest.json/extra",
            "https://github.com/zerr0o/other-repo/releases/download/v3.10.0/latest.json",
            "https://github.com/zerr0o/prime-agent-studio/releases/download/3.10.0/latest.json",
            "https://github.com/zerr0o/prime-agent-studio/releases/download/v01.2.3/latest.json",
            "",
        ] {
            assert!(
                !manifest_url_is_trusted(evil),
                "untrusted endpoint must be rejected: {evil}"
            );
        }
    }

    #[test]
    fn metadata_failures_are_explicit_not_silent_false() {
        // Non-array releases JSON is a metadata failure (caller maps to explicit code),
        // not an empty eligible list.
        let not_array = serde_json::json!({"oops": 1});
        assert!(not_array.as_array().is_none());
        // Empty array is valid and means available=false (no error).
        let empty = serde_json::json!([]);
        assert!(collect_eligible(&empty).is_empty());
        // Malformed JSON bytes fail to parse (caller returns metadata_failed).
        let bad: Result<serde_json::Value, _> =
            serde_json::from_slice::<serde_json::Value>(b"not json");
        assert!(bad.is_err());
        // Version mismatch is explicit false from validator (caller returns mismatch error).
        let selected = v("3.10.0-beta.4");
        assert!(validate_manifest_version("3.10.0-beta.4", &selected));
        assert!(!validate_manifest_version("3.10.0-beta.5", &selected));
        assert!(!validate_manifest_version("3.10.0", &selected));
        assert!(!validate_manifest_version("3.10.0-beta.3", &selected));
        assert!(!validate_manifest_version("", &selected));
        assert!(!validate_manifest_version("not-a-version", &selected));
        // Whitespace-trimmed exact match is accepted (manifests are canonical).
        assert!(validate_manifest_version("  3.10.0-beta.4  ", &selected));
    }

    // --- Beta signature verification through the real updater plugin ---
    // Same minisign fixture as the stable updater test: valid payload passes,
    // tampered payload fails Minisign, older/equal never downgrades, malformed
    // manifest errors. Proves the beta manifest path keeps native signature
    // verification (tauri-plugin-updater), not a raw download.

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

    struct BetaFeed {
        url: String,
        stop: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl BetaFeed {
        fn new(version: &str, payload: Vec<u8>, malformed: bool) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let manifest = if malformed {
                b"{}".to_vec()
            } else {
                serde_json::to_vec(&serde_json::json!({
                    "version": version,
                    "platforms": {
                        "windows-x86_64": {
                            "url": format!("{url}/payload"),
                            "signature": include_str!("../../test/fixtures/updater/payload.txt.sig").trim()
                        }
                    }
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
                        let body = if String::from_utf8_lossy(&buffer[..size])
                            .starts_with("GET /payload ")
                        {
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

    impl Drop for BetaFeed {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.thread.take().unwrap().join().unwrap();
        }
    }

    #[test]
    fn beta_manifest_keeps_signature_verification_and_no_downgrade() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": config["plugins"]["updater"]["pubkey"],
                "endpoints": [],
                "dangerousInsecureTransportProtocol": true
            }),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        tauri::async_runtime::block_on(async {
            // Newer beta passes signature, tampered fails Minisign.
            for (version, tamper, malformed, expect_some) in [
                ("99.0.0-beta.1", false, false, true),
                ("99.0.0-beta.1", true, false, true),
                ("99.0.0-rc.1", false, false, true),
                ("99.0.0", false, false, true),
                ("99.0.0", true, false, true),
                ("0.0.0-beta.1", false, false, false),
                ("99.0.0-beta.1", false, true, false),
            ] {
                let mut payload =
                    include_bytes!("../../test/fixtures/updater/payload.txt").to_vec();
                if tamper {
                    payload[0] ^= 1;
                }
                let feed = BetaFeed::new(version, payload.clone(), malformed);
                let updater = app
                    .updater_builder()
                    .endpoints(vec![format!("{}/beta", feed.url).parse().unwrap()])
                    .unwrap()
                    .timeout(Duration::from_secs(5))
                    .build()
                    .unwrap();
                let result = updater.check().await;
                if malformed {
                    assert!(result.is_err(), "malformed beta manifest must error");
                    continue;
                }
                let update = result.unwrap();
                if !expect_some {
                    assert!(
                        update.is_none(),
                        "older/equal beta must not downgrade ({version})"
                    );
                    continue;
                }
                let bytes = update.unwrap().download(|_, _| {}, || {}).await;
                if tamper {
                    assert!(
                        matches!(bytes, Err(tauri_plugin_updater::Error::Minisign(_))),
                        "tampered beta payload must fail signature"
                    );
                } else {
                    assert_eq!(bytes.unwrap(), payload);
                }
            }
        });
    }
}
