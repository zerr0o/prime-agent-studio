# Windows application

**English** · [Français](../desktop.md) · [← Back to README](../../README.md)

The **Prime Agent Studio** application, built with Tauri 2, opens Studio in a dedicated Windows window. Its shortcut silently starts the server or reuses the running instance. There is no need to launch the VBS manually.

> This update workflow and server shutdown from the system tray are available starting with **3.8.0**.

## Installation and first launch

Run [Prime-Agent-Studio_3.8.1_x64-setup.exe](https://github.com/zerr0o/prime-agent-studio/releases/download/v3.8.1/Prime-Agent-Studio_3.8.1_x64-setup.exe). Installation is limited to your Windows user and offers Start menu and desktop shortcuts. Node.js is included. The installer installs WebView2 when needed; this component may require an Internet connection.

Studio downloads **Prime Agent, private npm, uv and Python** on demand. These components are not bundled in the installer. No previous Node, npm or Python installation, PATH changes or terminal commands are needed. An initial network connection is required. **Git Bash remains a separate prerequisite** for engine shell commands; its absence is reported.

On first launch, check Studio status and use **Repair Studio** if required components are missing. Downloads require an explicit click. Repair does not restart the server; then use **Restart now**. Existing paths and diagnostics remain in technical details. After validation, configure a provider in **Connections**: repair does not sign into accounts or send paid prompts. If you used the checkout with the VBS launcher, select **Use an existing installation** and choose its folder containing `server.mjs` and `.local`.

Migration copies projects, subagent defaults, attachments and remote access settings, including the PIN. The original installation remains intact. If its server is running, the application connects immediately and postpones copying until the first launch when that server is stopped. It interrupts no runs. Prime Agent sessions remain in their usual location. After migration, use the application to open Studio; the old launcher retains its own copy of the settings.

Browser appearance preferences and drafts are not copied: the Tauri window has its own persistent storage.

## Preparation, repair and compatibility

**Preferences → Updates** groups checking, updating, repair and restart. **System → Studio components**, the tray menu and `--settings` open the same surface. There is only one native window: if the server is unavailable or uses an older interface, that window shows local recovery controls. Versions, paths and logs are in collapsed technical details.

Existing installation selection accepts the Prime Agent package root, `uv.exe` or `python.exe`. `PRIME_AGENT_CLI`, `PRIME_GUI_UV` and `PRIME_AGENT_KERNEL_PYTHON` remain authoritative. Invalid explicit paths must be corrected, without silent replacement. A valid external Python is checked without modifying its environment.

In the current source tree, the versioned policy in `lib/desktop-components.mjs` pairs Studio with **Prime Agent 0.9.5**, **npm 10.9.4** and **uv 0.8.22**, using Python 3.11. Packaging accepts Windows x64 with Node 22 ≥ 22.16 or Node 24; the engine requires ≥ 22.8. A later Studio version may require another exact engine: the button then installs that version after explicit consent. There is no periodic monitoring, blind “stable” selection or automatic update of external installations.

Preparation reads the origin contract from the [official installer](https://app.primeintellect.ai/prime-agent/install.sh), without executing that script. The engine archive and its three Prime packages are checked against `releases/v<version>/SHA256SUMS`. npm comes from the [versioned official registry](https://registry.npmjs.org/npm/10.9.4), verified using its SHA-512 integrity before extraction; Studio Node executes its `npm-cli.js`. The [uv Windows x64 archive](https://github.com/astral-sh/uv/releases/tag/0.8.22) is checked against its `.sha256` file. These HTTPS references from the same origin provide transfer integrity, not an independent signature. Allowed hosts are fixed and any origin rotation fails closed. An automatically detected external engine is not executed: select it explicitly to grant trust. With Prime Agent 0.9.5, `dist/bundle/cli.js` is a launcher that delegates to `dist/bundle/cli-node.js`; validation requires the complete package (both files) and keeps the public `cli.js` path in its receipts, while managed execution uses the direct Node entry to preserve PID and hooks.

npm scripts are disabled (`--ignore-scripts`). Prime's postinstall only prepares optional tools and its own kernel when requested; Studio uses `ensureLocalKernel`. Installation retains complete resources and dependencies, checks native provider, model, command, MCP and Photon imports before validation. npm retains its lockfile to diagnose resolved transitive dependencies. uv downloads managed Python when needed (`UV_PYTHON_DOWNLOADS=automatic`, `UV_PYTHON_PREFERENCE=only-managed`). Existing code validates Python imports, kernel protocol and essential skills. Optional tools, including fd/rg and account integrations, are not all installed by this preparation.

Starting with **3.7.1**, new managed Python environments receive the Prime Agent [#2372](https://github.com/PrimeIntellect-ai/prime-agent/pull/2372) continuation fix. Its content is part of the kernel fingerprint: a new generation is created and validated without rewriting an active environment or the engine source. An explicitly selected Python or a `PRIME_AGENT_KERNEL_PYTHON` override stays unchanged; if it lacks the corrected protocol, Studio rejects it and asks for a compatible environment. Read-only checks neither prepare nor modify kernels. The fix applies to new kernels after the 3.7.1 server is activated; it does not repair an already interrupted session in place.

Components live in `engine/prime-agent/<version-id>`, `engine/uv/<version-id>`, `engine/npm/<version-id>` and `engine/python`, under the data directory. `engine/prepared.json` retains validated components for retries; `engine/installation.json` atomically selects paths, versions, provenance and digests after Python validation. `engine/selection.json` stores explicit selections. Kernels remain in `.local`. Archives use fresh staging, size limits and rejection of traversal, links and ambiguous Windows names. Previous versions and external installations are never deleted. A validated external selection can be activated without a download receipt: the explicitly selected path must still match its validation receipt. Managed installations retain their provenance and digest checks.

Progress shows actual stages and received bytes, without an invented overall percentage. Cancellation or failure allows retrying without losing validated components. A lock prevents simultaneous preparations and recovers a stopped owner. The application also serializes component preparation, Studio installation and server restarts. `engine/logs/components.log` contains only stages, codes, phases and bytes. Final activation errors are recorded separately from preparation failures, without commands, environment variables or raw tool output. Downloads never start merely by opening a remote page or signing into Windows.

**Repair Studio** installs and validates components without stopping the server. One **Restart now** button then applies ready changes. Validated components remain available after failure. Server identity must be proved before a stop: marker, PID, instance, executable, arguments, generation and Windows port owner. A missing marker can be recovered only when this evidence agrees; an unverified port or process is never stopped. Previous generations remain available.

## Window and background work

- **Closing the window** hides it and keeps the icon near the clock. Agents, the server and mobile access continue.
- Clicking this icon or launching the shortcut again brings back the same window.
- The icon’s menu offers **Open Studio**, **Studio preferences** and **Quit application**. Quitting first stops the verified Studio server, then closes the application. Active agents or operations require confirmation. If stopping fails, the application stays open and shows the reason.
- In **Preferences → System**, **Start with Windows** is disabled by default. Enabling it starts Studio in the background when you sign in, without opening its window. Background startup errors are logged without opening a window; open Studio to access recovery controls.
- External links open in your usual browser. LAN, Tailscale, HTTPS and the mobile PWA still use the same server.

Daily, the main window first shows a connecting state (“Preparing your workspace”), then opens Studio: it reuses the running server or starts it. Settings appear only when setup is needed, on error, or when opened explicitly via `--settings` or the menu. Before a cold start, the launcher quickly checks the installation receipt (versions, provenance, paths, Python marker) without executing components; when something changed or failed, use **Check for updates** or **Repair Studio**, which report each step (engine, Python, shell, uv).

To reconnect to a stopped server, open **Studio preferences** from the tray icon, then **Open Studio** in the recovery view in the same window. This button reuses an existing instance and never stops agents.

A Windows shortcut can use the `--settings` argument to open application settings directly, including when the app is already running in the background.

## Data and updates

Data is stored in `%LOCALAPPDATA%\com.primeagent.studio`:

| Location       | Contents                                                            |
| -------------- | ------------------------------------------------------------------- |
| `data`         | Projects, attachments, hashed PIN, network settings and server logs |
| `.local`       | Persistent Python kernels                                           |
| `versions`     | Immutable copies of server files and Node.js                        |
| `webview`      | Window preferences and storage                                      |
| `desktop.json` | Launcher preferences and installation to migrate                    |

An update installs the new application and prepares a new server copy. **Preferences → Updates** distinguishes the installed application version from the running server version. Old copies are not automatically removed, preserving any processes still using them.

**Upgrading to 3.0.0:** if the previous server stays running after installation, Studio still shows that server’s version and features. Wait for agents to finish, then use **Preferences → Updates → Restart server** in the Windows application to load V3. [Collapsible project navigation](navigation.md) and [project knowledge](knowledge.md) then become available; new runs and their subagents receive the history search and reading tools.

The **2.8.1** fix adds a one-time startup repair: the ten helpers omitted from release 2.8.0 are added to its original cache, even while its server is running. Existing files are preserved. This restores messages, skill discovery and providers without stopping agents.

In Studio, open **Preferences → Updates**. Three actions have distinct roles:

- **Check for updates** looks for a new version without installing anything.
- **Update Studio** asks for confirmation, downloads the file, verifies its signature and relaunches the application. The server restarts if idle; agents that are still active require another confirmation.
- **Restart now** fully stops the server and starts it again with already installed files. Confirmation explains the effect on agents and connected devices. **Repair Studio** appears when required components are missing; repair does not restart the server.

To include prereleases, enable the beta option in this panel, then click **Check for updates**. The option is off by default and its choice is remembered in this local interface. It checks published stable and beta releases without offering an older version. Changing the option clears the previous result; it does not start a check, download or installation. Confirmation and signature verification still apply. This option is limited to the local Windows application, not remote access.

You can close and reopen the panel without losing the operation. Stages, received bytes, known total size, real percentage, elapsed time and errors are retained. Downloads can be cancelled. A requested restart waits for interruptible work to actually stop before changing the server. Installer handoff cannot be cancelled and its reason is displayed.

The application and running server have separate versions, shown in technical details. A mismatch calls for a restart, not a false success. If the server is unavailable or uses an older interface, recovery controls open in the main window, never in another native window. Browsers and phones can still view versions and release notes. A remote installation request requires write access, a running Windows application and no active agents; these conditions are rechecked on the PC.

Web links, including Codex sign-in, open in the default browser. File drops use the HTML composer directly, without another file bridge. The components bridge is limited to the main application window at its exact local origin, or the native launcher. The page cannot supply paths, executables or download URLs; the verified policy and native dialogs retain that responsibility. Browsers, other ports and LAN pages do not receive these rights. Preparation buttons are absent for remote or read-only access.

A network error, missing catalog or invalid signature is never reported as “up to date”. You can retry; technical details are in `desktop-update-error.log` in the data folder. The catalog becomes available with the first release containing `latest.json`. Checking is manual, with no periodic background polling.

Updates carry a Tauri cryptographic signature. Installers do not yet carry a Windows Authenticode signature, which requires a separate Windows certificate.

## Build and verify

`npm run test:components` checks resolution, local-server download fixtures, digests, hostile archives, locks and the FR/EN flow in Edge without real installation. `npm run test:components:download` requires `.desktop-build` resources: it launches bundled Node in an isolated temporary directory with a reduced local PATH, downloads real components, prepares Python, checks `/api/version` and rejects any download during a second preparation. It retains its diagnostics directory without hiding or deleting user tools. It uses no account or paid model. To validate sessions with a simulated provider, run `scripts/test-commands-native.mjs` with `PRIME_AGENT_CLI` and `PRIME_AGENT_KERNEL_PYTHON` from this isolated manifest.

These checks do not replace testing the new wizard in a packaged Tauri binary, in FR/EN, on a clean Windows x64 VM. That step requires Rust/MSVC and WebView2. In particular, check absent Git Bash, cancellation on application exit, insufficient disk space and deferred restart during an active session.

On Windows, install Rust/MSVC and the [Tauri 2 development prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```powershell
npm ci
npm run desktop:build
```

The installer is in `src-tauri/target/release/bundle/nsis`. `npm run desktop:dev` prepares resources and starts the development build. `npm run desktop:icons` regenerates icons from the SVG; the 256 px frame must stay first in the ICO used by Tauri.

The build validates module, worker and native helper references before creating the installer. `npm run test:desktop-runtime` exercises the resources prepared in `.desktop-build` using real Prime Agent workers and an isolated project and account storage: Python skills, prompts and providers.

`npm run test:desktop` tests the previously compiled debug executable: resources extracted by the executable, messages and the Python kernel using a simulated local HTTP model, provider and command APIs, reusing a server with an active simulated agent, starting the bundled server, single instance behavior and server survival when the Tauri process closes. Prime Agent and uv must be available. Pass another executable path after `--` to test a different build. `npm run test:desktop-ui` checks presentation changes in Chrome/Edge. Tests make no paid model calls.

For isolated tests, `PRIME_STUDIO_DESKTOP_DATA_ROOT` and `PRIME_STUDIO_DESKTOP_PORT` override the data folder and port. Leave them unset for normal use. VBS remains available for source installations.

`npm run test:desktop-folder-picker` checks the real Windows folder dialog, its Tauri owner, selection and cancellation. First build with `node scripts/build-desktop.mjs --debug --no-bundle --config test/fixtures/desktop-picker/tauri.conf.json`, then set `PRIME_STUDIO_TEST_EXE` to the resulting executable’s absolute path. The test refuses the production identity, uses temporary directories and a port, and closes only its own process.

`npm run test:desktop-updates` and `npm run test:settings-updates` check both panels in French and English. `npm run test:desktop-lifecycle` validates a real Tauri restart with a busy server, confirmation, preserved data and activation of the installed version. `cargo test --manifest-path src-tauri/Cargo.toml --locked` tests the actual updater client against a local server: valid signature, tampered file, equal/older versions and invalid catalog. Tests never execute an installer.

For native tests alongside your application, compile a separate test identity: `$env:TAURI_CONFIG = '{"identifier":"com.primeagent.studio.interaction-test"}'`, then `cargo build --manifest-path src-tauri/Cargo.toml --locked`. Remove the variable afterward (`Remove-Item Env:TAURI_CONFIG`) before a distribution build. `npm run test:desktop-interactions` tests web and synthetic OAuth links, attachments, clipboard, export and permissions in actual WebView2. It opens test tabs in the default browser without signing into an account.

The `npm run test:components:pipeline-native` test requires `PRIME_STUDIO_TEST_EXE` and an already validated isolated engine and Python. Build its executable with `tauri build --debug --no-bundle --config test/fixtures/components-pipeline-tauri.json`: its separate identifier protects the installed instance. The test creates its own data, ports and server; it refuses a production executable and downloads no components.

## Prepare an update release

The private signing key stays outside the repository, in `%USERPROFILE%\.tauri\prime-agent-studio.key` on the release machine. Back it up securely: installed applications trust its embedded public key, and an incompatible replacement key would prevent updates. `desktop:build` uses this local key or `TAURI_SIGNING_PRIVATE_KEY` (path or content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Without a key, `npm run desktop:build -- --no-bundle` builds only the executable.

After a signed build, run `npm run desktop:manifest -- path/notes.md` (notes are optional). `.local/desktop-release/v<version>` contains the three files to attach together to release `v<version>`: the installer with a space-free name, its `.sig` signature and the catalog, `latest.json` for a stable version or `beta.json` for a `-beta.N` version. Publish a beta as a prerelease without replacing the latest stable release. Do not rename the installer afterward: the catalog contains its exact URL.

The GitHub **Windows desktop release** workflow runs manually with an existing stable or beta tag matching `package.json`. It tests, builds, signs and prepares a **draft release** containing these three files. Configure repository secrets `TAURI_SIGNING_PRIVATE_KEY` and, for an encrypted key, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. It refuses to overwrite a published release. The workflows never sign a manually uploaded installer: they always rebuild the installer from the tag before signing it. The **Rebuild and sign release installer from tag source** (`desktop-sign-local.yml`) workflow applies the same secure rebuild when a draft needs to be regenerated. Review the draft before publishing. A stable version may become the latest stable release; a beta must remain a prerelease. Do not publish a release without its catalog and installer.
