# Cua Driver distribution research (pinned tag only)

Scope: packaging and deployment of Cua Driver ONLY. No product edits, no desktop runs, no restarts, no installations. Source pinned at tag `cua-driver-rs-v0.28.2`. No `main`-only features assumed. Install scripts were read, never executed. The driver binary was downloaded to an ignored research path and inspected as a zip, never executed.

Worktree: `E:/Documents/GitHub/PrimeAgentGUI-computer-use`. Studio target: beta.3 with Cua Driver integration while retaining the Windows-native fallback (`runtime/computer-use-worker.ps1` + `lib/computer-use-driver.mjs`).

## 1. Pinned release identity

- Repo: `trycua/cua`
- Tag: `cua-driver-rs-v0.28.2`
- Release ID: `389486122`
- Release name: `cua-driver-rs: v0.28.2`
- Target commit: `fc188250b4ca8549b8e61f937fdb1fb560770e86`
- GitHub flags: `draft=false`, `prerelease=true`, published `2026-09-15T21:55:39Z`
- Release body note: GitHub shows Pre-release only so the monorepo-wide Latest pointer does not flip between independently released products. The body states a plain Cua Driver SemVer is a stable release and npm/PyPI publish it on normal stable channels.
- Rust workspace version at tag: `0.28.2` (`libs/cua-driver/rust/VERSION`, workspace `Cargo.toml`)
- Fixes in 0.28.2 only (from release body and `libs/cua-driver/rust/CHANGELOG.md`): Hyprland AX scrolling, desktop snapshot identity and payload ownership, macOS capture without PATH reliance, background text through Hyprland input. No Windows behavior change is claimed in this patch.

## 2. Exact asset URLs, checksums, provenance

Primary Windows x64 asset for Studio beta research:

- URL: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2/cua-driver-rs-0.28.2-windows-x86_64-binary.zip`
- Size: `29085823` bytes
- SHA256: `1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba`
- GitHub API digest field: `sha256:1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba` (matches)
- Local verification: downloaded to ignored `test-results/cua-integration/research-distribution/cua-driver-rs-0.28.2-windows-x86_64-binary.zip`, streamed SHA256 matches exactly, byte count matches. Binary was NOT executed.

Sibling Windows assets at the same tag:

- Full directory zip (what `install.ps1` actually downloads): `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2/cua-driver-rs-0.28.2-windows-x86_64.zip`, size `29086255`, SHA256 `3c1fcf10ff9513b94e4af78ad6a216ab62aa95b2c9a3b70dfbdba9f04e021533`
- ARM64 flat binary zip: `cua-driver-rs-0.28.2-windows-arm64-binary.zip`, size `27394922`, SHA256 `578b88ff2dd56f06eb7e984d73aaf5e76f59c6fde9542c967d6a30d00213c680`
- ARM64 directory zip: `cua-driver-rs-0.28.2-windows-arm64.zip`, size `27395342`, SHA256 `69720568a44ed8eab3620c892b9df524a8231013ac42e0afcdaa4317cd90d0f1`

Checksum and manifest sources:

- `checksums.txt`: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2/checksums.txt` (SHA256 `448fbf0f9b6ca13dc0bdd3adb0f0f8432293abb0519efd2fe77be90e816e6539`, lists the file hashes above; verified over redirect)
- `release-manifest.json`: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2/release-manifest.json` (SHA256 `fce29f1135000b206aa682d3171114d7261499ee76105b8fa551bb61050bcbd1`, schema v1, product `cua-driver-rs`, version `0.28.2`, sha `fc188250...`, compare URL `cua-driver-rs-v0.28.1...cua-driver-rs-v0.28.2`)
- Pinned installer scripts as release assets: `install.ps1` (`3e770fa8...`), `install.sh` (`317ba3a4...`), `uninstall.ps1` (`191c86cb...`), `uninstall.sh` (`d3fb2d53...`), `_install-rust.sh` (`c3b4423d...`)
- Canonical short URLs (`https://cua.ai/driver/install.ps1`, `.../install.sh`) resolve to installer logic, not to a pinned version. For beta reproducibility, use the full tag-pinned `releases/download/...` URLs above, never the short URL and never `latest`.

Provenance limits:

- No Sigstore or SLSA attestation was found for this tag (GitHub attestations API returns 404 for the asset path). Provenance is therefore: tag commit + release-manifest.json + per-asset GitHub `digest` + `checksums.txt`. Treat those three as the trust set and re-verify all three at bundling time.
- Caution: the `install.ps1` baked-version constant at this tag still reads `0.28.1`, so the default `irm | iex` path without an explicit pin does not prove 0.28.2 behavior. Studio must pin explicitly.

## 3. Archive contents and licenses

Inspected `cua-driver-rs-0.28.2-windows-x86_64-binary.zip` by zip listing only (6 entries, total uncompressed `80151998` bytes, no LICENSE file inside):

- `cua-driver.exe` (`30922064` bytes): daemon + MCP stdio server + CLI. This is the only file Studio needs for daemon mode.
- `cua-driver-uia.exe` (`21205328` bytes): Windows UIAccess worker. Ship alongside `cua-driver.exe` in the same directory. Do not rename or separate them.
- `cua-cursor-theme.exe` (`2033480` bytes): short-lived cursor dotLottie validation, compilation, preview, installation sidecar. Not needed for normal capture and input.
- `cua_driver_sdk.dll` (`25339216` bytes): in-process native runtime for app SDK embedding. Not needed for daemon sidecar use.
- `cua_driver_node_runtime.node` (`643912` bytes): Node native runtime for the JS SDK. Not needed for daemon sidecar use.
- `cua_driver_abi.h` (`7998` bytes): generated C ABI header. Build-time reference only.

License finding:

- Repo license at tag: MIT (`LICENSE.md`, `Copyright (c) 2025 Cua AI, Inc.`, SPDX MIT via GitHub license API). Workspace `Cargo.toml` also declares `license = "MIT"`.
- The `-binary.zip` contains no license text. The installer-expected directory zip expands to `cua-driver-rs-<v>-<arch>\cua-driver.exe (+ LICENSE)` per `install.ps1` comments, so the full zip path carries attribution but the flat binary zip does not.
- Action: when bundling from `-binary.zip`, add `LICENSE.md` (or the equivalent MIT notice) from the pinned tag next to the sidecar and in the Studio third-party notices. Do not rely on the zip to supply it.

Binary versus full zip:

- `install.ps1` downloads `cua-driver-rs-<version>-<archLabel>.zip` (directory form, for example `cua-driver-rs-0.28.2-windows-x86_64.zip`) and expects stage dir `cua-driver-rs-<v>-<arch>` containing `cua-driver.exe`.
- The `-binary` suffixed zip is the flat bare-binary form used by the Unix `_install-rust.sh` path and published for direct sidecar use. Size delta on Windows x64 is only 432 bytes (directory wrapper plus license), so either source is bit-consistent for the exe, but Studio sidecar work should standardize on the `-binary.zip` URL above plus an explicit MIT file.

## 4. Native dependencies (Windows x64)

From `libs/cua-driver/rust/crates/platform-windows/Cargo.toml` and Skills/docs at tag:

- Target: `x86_64-pc-windows-msvc` label `windows-x86_64`. No separate VC redist step is documented in the installer; the Rust binary plus `cua-driver-uia.exe` are the runtime.
- OS floor: Windows 10 1903 or later in practice (Windows.Graphics.Capture is the supported path for UWP and DirectComposition surfaces; PrintWindow and BitBlt fallbacks fail on occluded modern surfaces).
- Subsystems used: UIA and Accessibility, GDI and DWM, keyboard and mouse input, pointer and touch injection, HiDPI, OpenGL and Direct3D11 with DXGI, WinRT package enumeration, Task Scheduler for autostart, named pipes for the daemon socket.
- DPI manifest is embedded at build time (`embed-resource`), which matters for coordinate correctness at 125, 150, 200 percent scaling.
- No Python, Node, or pyatspi runtime is required for the daemon path. AT-SPI native D-Bus handling is Linux-only. `keyring` and `clipboard-rs` are compiled in, not external installs.
- Interactive desktop session is required. `cua-driver doctor` explicitly warns outside an interactive desktop (Session 0). Services, Session 0 hosts, and headless CI cannot drive GUI tools.
- UWP and AppContainer targets (Calculator, Settings, Photos) need a High integrity daemon. That is why the vendor autostart task uses RunLevel Highest. A Medium integrity Studio child will see the documented `background_uipi_blocked` class or stub UIA trees on those targets. This is a beta scope decision, not a bundling bug.

## 5. Daemon auto-start, control flags, state isolation

Read at tag in `libs/cua-driver/rust/crates/cua-driver/src/{cli.rs,main.rs,serve.rs,autostart.rs,bundle.rs,version_check.rs,telemetry.rs}` and `libs/cua-driver/scripts/{install.ps1,uninstall.ps1,install.sh,uninstall.sh,README.md}`. Nothing was launched.

Transport and socket:

- `serve` speaks line-delimited JSON over a platform socket. Default paths: Windows `\\.\pipe\cua-driver`, macOS `~/Library/Caches/cua-driver/cua-driver.sock`, Linux `~/.cache/cua-driver/cua-driver.sock`. Source-built `cua-driver-local` uses the `cua-driver-local` namespace on every platform.
- CLI verbs: default bare `cua-driver` is the MCP server; explicit `mcp`, `call <tool> [json]`, tool shorthand, `list-tools`, `describe`, `serve`, `stop`, `status`, `sessions list`, `mcp-config`, `config`, `doctor`, `diagnose`, `permissions status|grant`, `check-update`, `update --apply`, `channel`, `telemetry`, `autostart`, `skills`, `manifest`, `history` (experimental preview only), cursor theme verbs.
- MCP profile at this tag: modern stdio `2026-07-28` plus legacy `2025-06-18` initialize flow; `server/discover`, `skills/list`, `skills/get`, `resources/read`; authenticated loopback HTTP stays legacy-only. Studio should use stdio `cua-driver mcp --socket <private-pipe>`, not HTTP.

Auto-start (do NOT enable for Studio beta):

- Vendor default installer uses `-AutoStart:$true` and registers Scheduled Task `cua-driver-serve` with LogonType Interactive so the daemon lands in Session 1+ with an attached desktop. The task wraps `cua-driver.exe serve` in hidden PowerShell so no console window persists.
- `cua-driver autostart {enable|disable|status|kick}` manages the same entry. Windows only. macOS and Linux return not-implemented at this tag and point at manual `launchctl` or `systemd --user` recipes.
- Studio must NOT register this task and must NOT call `autostart enable` or `install.ps1 -AutoStart`. Studio owns process lifetime: spawn the sidecar `serve` as a Studio child with a private `--socket`, supervise it, and call `stop` on shutdown. A system-wide autostart entry would outlive Studio, collide with a user standalone install, and break the single-controller contract in `planning/computer-use-implementation-contract.md`.

State directory isolation:

- Canonical home is `%USERPROFILE%\.cua-driver` on Windows (`~/.cua-driver` on Unix), overridable per process by `CUA_DRIVER_RS_HOME`. Legacy `.cua-driver-rs` is migrated, not written.
- Home holds `packages/`, `skills/`, `config.json` (`telemetry_enabled`, `update_check_enabled`), `version_check.json` (20 hour cache), telemetry identity files, install channel markers, and release records.
- Telemetry-only override exists as `CUA_DRIVER_TELEMETRY_HOME`, but full isolation needs `CUA_DRIVER_RS_HOME`.
- Computer History preview (nightly only, out of beta scope) uses `%LOCALAPPDATA%\cua-driver\computer-history` on Windows, `~/Library/Application Support/cua-driver/computer-history` on macOS, `$XDG_STATE_HOME/cua-driver/computer-history` on Linux.
- Studio isolation recipe: set `CUA_DRIVER_RS_HOME` to a Studio-owned data subdirectory (under the Tauri `app_local_data_dir` root already used for Studio state), pass an explicit Studio-private `--socket` pipe name (never the default `cua-driver` pipe), keep `USERPROFILE` and `PATH` untouched, and never run `skills install` (it symlinks into `~/.claude/skills`, `~/.agents/skills`, `~/.prime/agent/skills`, and others).

Control and safety flags relevant to Studio:

- `serve --socket <path>`: required isolation knob. Also supports permission mode, capability manifest, grants, `--no-permissions-gate`, `--claude-code-computer-use-compat`, `--experimental-history` (preview only, leave off).
- `mcp --socket <path>` or `mcp --direct`: for Studio, always use `--socket` against the Studio-owned daemon. `--direct` changes TCC attribution on macOS and bypasses the Studio daemon boundary.
- `stop [--socket <path>] [--expected-pid <pid>]`: use the validated PID form from `uninstall.sh` guidance to avoid stopping a foreign daemon.
- `status [--socket <path>]`: liveness without side effects.
- Permission mode is fixed at daemon launch: `standard` default; `bounded` needs `--capability-manifest` plus approval; `unrestricted` needs `--dangerously-bypass-approvals` (or the two-part env contract). Studio beta should run `standard` and keep policy enforcement in Studio plus optional `CUA_DRIVER_POLICY_FILE`.
- Env knobs to set for a Studio child: `CUA_DRIVER_RS_HOME=<studio-data>\cua-driver-home`, `CUA_DRIVER_RS_UPDATE_CHECK=0` (or `false`, `no`, `off`), `CUA_DRIVER_RS_TELEMETRY_ENABLED=0` unless product decides otherwise, `CUA_LOG=WARN` or stricter. Never set `CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS=1` in beta.
- Update path to block: `update --apply` re-runs the vendor installer as a child and touches user PATH, junctions, and tasks. Studio must never invoke it. Use `check-update` or `doctor` for diagnostics only, with update checks disabled by env in normal runs.
- UIA worker resolution: keep `cua-driver-uia.exe` next to `cua-driver.exe`. The `uia_executable_name()` is `cua-driver-uia.exe` for release installs and `cua-driver-uia-local.exe` for local builds, so do not rename.

## 6. Sidecar bundling via existing Studio scripts and runtime paths

Current Studio layout (read, not changed):

- `scripts/build-desktop-resources.mjs` stages `server.mjs`, `index.html`, `package.json`, `package-lock.json`, `LICENSE`, `lib`, `public`, `assets`, `runtime`, plus the allowlisted `scripts/desktop-runtime-resources.mjs` set, into `.desktop-build/studio`, runs `npm ci --omit=dev --ignore-scripts`, copies `node.exe`, fetches the Node license, and writes `.desktop-build/desktop-resource.json` (SHA256 identity over the staged tree).
- `scripts/desktop-runtime-resources.mjs` verifies that every referenced `.mjs`, `.js`, `.ps1`, `.py` exists inside the bundle. Binaries are outside that scanner today.
- `src-tauri/tauri.conf.json` maps `../.desktop-build/` to Tauri resource prefix `backend/`, so the installed backend tree is `<resourceDir>/backend/` (release) with dev fallback to `../.desktop-build`. Native code runs `resources.join("node.exe")` and `resources.join("studio/scripts/desktop-start.mjs")` with the working directory set to resources.
- `.gitignore` already ignores `test-results/`, so the research zip is untracked by construction.

Recommended sidecar shape (proposal, not implemented here):

- Stage under `.desktop-build/cua-driver/0.28.2-windows-x86_64/` with exactly: `cua-driver.exe`, `cua-driver-uia.exe`, pinned `LICENSE.cua-driver.md` (MIT from tag), `VERSION` (`0.28.2`), `SHA256SUMS` (the two exe hashes plus manifest references), and a small `source.json` (repo, tag, commit, asset URL, release ID).
- Installed path becomes `<resourceDir>/backend/cua-driver/0.28.2-windows-x86_64/cua-driver.exe`. Invoke by absolute path only. No PATH mutation, no junction chain, no `current` symlink, no Scheduled Task.
- Extend the build step (in a later product change, not this report) to: download only the pinned `-binary.zip` URL, verify SHA256 `1f4bfcee...` plus `release-manifest.json` hash before extract, extract only the two exes, assert `cua-driver-uia.exe` sits beside `cua-driver.exe`, inject the MIT file, and fail closed on mismatch. The existing `.desktop-build/desktop-resource.json` fingerprint will then cover the sidecar automatically because it hashes the whole output tree.
- Add an explicit binary allowlist check next to `verifyDesktopRuntimeResources` (extension, exact names, size and SHA256), since that verifier currently only scans script references.
- Runtime state: `CUA_DRIVER_RS_HOME=<StudioDataRoot>/cua-driver-home`, socket `\\.\pipe\<studio-private-name>` (include Studio version or instance id, never `cua-driver`), spawn with hidden console (`CREATE_NO_WINDOW`), supervise as a Studio child, `stop --expected-pid` on shutdown. Keep the existing PowerShell fallback untouched so beta can fall back per session.
- Guardrails for beta: Windows x64 only, gate the sidecar behind the existing opt-in Computer Use toggle, keep single-controller generation semantics from the implementation contract, reuse `doctor` and `status --socket` for diagnostics, show the sidecar version in the Computer Use status surface.

## 7. Platform support limits for beta

Beta scope: Windows x64 ONLY. Ship no macOS or Linux driver in beta.3.

- Windows x64 supported: Windows 10 1903+ on `x86_64`. ARM64 asset exists (`windows-arm64-binary.zip`) but Studio beta targets x64 desktops, so exclude it to keep the installer small and the test matrix tight.
- Windows integrity note: High integrity is needed for UWP and AppContainer targets. A Studio-spawned Medium integrity daemon will work for Win32, WPF, WinUI3, WebView2, Electron, and Tauri hosts (per `docs/action-support.md` accepted baselines) but must surface `background_uipi_blocked` or stub-tree behavior on elevated and AppContainer apps as expected refusals, not as generic failures.
- macOS deferred. Requirements at tag are non-trivial: Accessibility plus Screen Recording grants tied to the responsible app identity, stable certificate-backed code signing (ad-hoc `cdhash` grants do not survive rebuilds), and a choice between Standalone (`CuaDriver.app` plus `open -n -g -a CuaDriver --args serve`), Explicit direct MCP (`mcp --direct` uses spawner attribution, no AppKit overlay without a certified host adapter), and Embedded (`CUA_DRIVER_EMBEDDED=1` child of the Studio host inheriting grants, private socket, no LaunchServices launch). Uninstall revokes TCC by default. None of this is needed for a Windows-only beta and it must not ride along as dead code or docs promises.
- Linux deferred. At tag Linux is per display server, not one API: X11 with Openbox has 116/116 accepted rows but Xvfb does not prove real Xorg MPX and uinput behavior; Sway on wlroots passes 116/116 with cursor oracle unsupported; GNOME needs the WinRects helper plus one Shell restart plus portal grants, with shared renderers and portal video still open; KDE Plasma 6 has a live KWin identity adapter but raw target-addressed input stays refused; nested `cua-compositor` is opt-in; Hyprland needs the separate plugin tarballs. Runtime needs an interactive session with `DISPLAY` or `WAYLAND_DISPLAY`, reachable X11, AT-SPI bus, and for some paths `/dev/uinput`, `/dev/dri`, GNOME Keyring Secret Service, and portal libei sessions. None of this belongs in a Windows beta bundle.

## 8. Optional dependencies to exclude from the Studio bundle

Exclude all of these from beta.3 packaging:

- `cua-cursor-theme.exe`: authoring sidecar only.
- `cua_driver_sdk.dll`, `cua_driver_node_runtime.node`, `cua_driver_abi.h`: in-process SDK embedding only; Studio uses daemon stdio, not linked SDK.
- `cua-driver-rs-v0.28.2-skills.tar.gz` and any `skills install` step: the MCP endpoint already serves the 8-file skill through `skills/list`, `skills/get`, `resources/read` with digests; filesystem installation would write into user agent dirs and is explicitly opt-in upstream.
- `cua-hyprland-plugin-*.tar.gz` and build kit: Hyprland-only, Linux-only.
- Python wheels (`cua_driver-*-win_amd64.whl` and the macOS and Linux wheels): app SDK clients, not the Studio daemon path.
- npm packages (`trycua-cua-driver-*.tgz`): same reason.
- `install.ps1`, `install.sh`, `uninstall.ps1`, `uninstall.sh`, `_install-rust.sh`: system-install path with PATH, junctions, tasks, LaunchAgents, systemd units, TCC handling. Studio sidecar must not execute or bundle them as runtime; keep them as documentation references only.
- `cua-driver channel set`, `update --apply`, Computer History preview flags, nightly channel: all out of beta scope.
- macOS universal and Linux tarballs: out of beta scope entirely.

Minimal beta set: `cua-driver.exe` + `cua-driver-uia.exe` + pinned MIT notice + `VERSION` + `SHA256SUMS` + `source.json`.

## 9. Actionable findings

1. Pin this exact asset for Windows x64 beta work: `cua-driver-rs-0.28.2-windows-x86_64-binary.zip`, SHA256 `1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba`. Verified locally.
2. Do not use `latest` or `cua.ai` short URLs in build code. Use tag-pinned `releases/download/cua-driver-rs-v0.28.2/...` plus `release-manifest.json` verification.
3. Bundle only the two Windows exes plus license metadata as a versioned Tauri resource sidecar. Exclude SDK DLL, Node runtime, cursor theme compiler, skills pack, Hyprland plugin, Python wheels, npm tgzs, and installer scripts.
4. Isolate at runtime with `CUA_DRIVER_RS_HOME` under Studio data, a Studio-private `--socket` pipe, update checks off, telemetry off unless product opts in, `standard` permission mode, no autostart task, no PATH change, no `skills install`.
5. Keep the Windows-native PowerShell fallback as the beta default path and add the driver behind the same opt-in toggle and single-controller rules. UWP gaps at Medium integrity are expected refusals.
6. Defer macOS (signing and TCC identity) and Linux (display-server matrix and portal helpers) to after beta. Do not ship their assets in beta.3.
7. Provenance is GitHub digests plus `checksums.txt` plus `release-manifest.json`. There is no Sigstore attestation to verify at this tag.

## 10. Sources read at pinned tag (no execution)

- Release API: `repos/trycua/cua/releases/tags/cua-driver-rs-v0.28.2` (ID `389486122`, commit `fc188250...`)
- `checksums.txt`, `release-manifest.json` (both fetched with redirect)
- `libs/cua-driver/rust/README.md`, `VERSION`, `Cargo.toml`, `CHANGELOG.md`
- `libs/cua-driver/README.md`, `libs/cua-driver/scripts/README.md`, `libs/cua-driver/scripts/install.ps1`, `install.sh`, `uninstall.ps1`, `uninstall.sh`, `_install-rust.sh` (read-only)
- `libs/cua-driver/rust/crates/cua-driver/src/{main.rs,cli.rs,serve.rs,autostart.rs,bundle.rs,doctor.rs,version_check.rs,telemetry.rs,skills.rs}`
- `libs/cua-driver/rust/crates/cua-driver-core/src/{daemon.rs,authorization.rs,session_manifest.rs,policy.rs,lib.rs}`
- `libs/cua-driver/rust/crates/platform-windows/Cargo.toml`
- `libs/cua-driver/docs/{action-support.md,mcp-protocol-and-skills.md,linux-desktop-validation.md,computer-history-preview.md}`
- `libs/cua-driver/rust/Skills/cua-driver/{WINDOWS.md,MACOS.md,LINUX.md,EMBEDDING.md}`
- Studio files: `scripts/build-desktop-resources.mjs`, `scripts/desktop-runtime-resources.mjs`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/src/components.rs`, `package.json`, `.gitignore`

Verification log:

- Downloaded `cua-driver-rs-0.28.2-windows-x86_64-binary.zip` (`29085823` bytes) to ignored `test-results/cua-integration/research-distribution/`. SHA256 `1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba` matches the release body, `checksums.txt`, and the GitHub API digest.
- Listed zip contents without extraction or execution: `cua-driver.exe`, `cua-driver-uia.exe`, `cua-cursor-theme.exe`, `cua_driver_sdk.dll`, `cua_driver_node_runtime.node`, `cua_driver_abi.h`. No license file inside.
- No install script was executed. No daemon was started. No capture or input was attempted.
