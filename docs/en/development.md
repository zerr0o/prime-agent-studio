# Development and internals

**English** · [Français](../development.md) · [← Back to README](../../README.md)

## Installation and development

Requirements: **Node.js 22.8 or later** and **Prime Agent 0.9.2** installed. Configure a provider before the first message, in Prime Agent or the local **Providers** panel. This version of Studio and its subagent adapter are validated with **0.9.2**. The GUI reuses existing accounts without requesting their keys again.

```powershell
npm ci
npm run setup:runtime
npm start
```

There is no build step. Markdown libraries are served locally from `node_modules`, without a CDN. `npm start` keeps the server in your terminal; use the VBS launcher for fully silent startup.

In the add-project dialog, **Choose folder** opens the Windows picker and fills in the path, without adding the project until you submit the form. The PowerShell helper stays hidden; PowerShell 7 provides the modern picker when installed, with Windows PowerShell as a fallback. The picker is available only in local Studio on Windows. `npm run test:folders` covers selection, cancellation, errors and late responses. For this test and `scripts/test-commands-ui.mjs`, set `PRIME_STUDIO_TEST_BROWSER=chrome` to use Chrome instead of Edge.

On Windows, the Python engine is provisioned under `.local/kernel-venv/` to retain the workaround for Prime Agent’s POSIX `bin/python` path. Studio prepares the runtime, its libraries and enabled Python skills on the first message or through `npm run setup:runtime`. Initial installation requires Internet access. `scripts/native-skill-resources.mjs` shares native discovery with the command catalog: filters, project priority, configured packages and disabled MCP integrations are respected.

`lib/kernel-skills.mjs` reads `pyproject.toml` files with a TOML parser and resolves local dependencies between sibling packages, including helpers without `SKILL.md`. The runtime and all local packages are passed by path in a single `uv pip install --python …` resolution. Packages with matching names on PyPI therefore do not replace local sources. Packages are installed normally, without modifying `sys.path` or creating editable links to an active session’s sources.

`lib/kernel.mjs` keeps a format-2 marker keyed by a fingerprint of the runtime, Python sources, `pyproject.toml` files and expected imports. Every reuse checks actual imports, the runtime protocol and, when the skill is enabled, that `agent_message.send` is callable. The `kernel-setup.lock` lock serializes setup across processes. An old or damaged installation automatically produces a new generation; the previous environment stays intact. No ready marker is published after an installation or validation failure.

`runtime/kernel-loader.mjs` adapts only the bootstrap entry point in processes launched by Studio. The parent, every child and every resumed kernel therefore pass their native skill list to the same setup. The shared supervisor no longer fixes the first project’s Python for all workers. The hook supports the native module and its bundle, and explicitly rejects an incompatible signature; no installed Prime Agent file is modified.

An explicitly supplied `PRIME_AGENT_KERNEL_PYTHON` takes priority and is never modified automatically. Studio verifies compatibility: a missing essential dependency or `agent_message.send` blocks startup with the Python path and import error; an unavailable optional skill produces an explicit warning. The [native documentation](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md#python-backed-skills) explains why Prime Agent automatically installs nothing into this external Python.

To repair or prepare a specific project, use `npm run setup:runtime -- "C:\project path"`. Without an argument, the command uses the current folder. Stop and restart Studio to load a new adapter and restart already-open kernels; histories are preserved. Older generations can be retained while their kernels are in use.

`test/kernel.test.mjs` covers installation, migration, imports on every reuse, source/dependency changes, failure followed by retry, concurrency, Windows paths containing spaces, external Python and native discovery. `test:subagents:native` also includes `scripts/test-kernel-messaging-native.mjs`: a simulated localhost provider, real kernels, explicit messages in both directions verified in histories **and** model contexts, then resuming the same parent after engine shutdown. A child-completion notification does not satisfy this test.

## Long sessions and synchronization

`runtime/transport-loader.mjs` adapts the OpenAI Codex transport in memory for the engine launched by Studio. [OpenAI WebSocket connections have a 60-minute limit](https://developers.openai.com/api/docs/guides/websocket-mode). An idle connection older than 50 minutes is renewed before the next request; its previous response cache is discarded and the engine sends the full context. The adapter never interrupts a busy request. Prime Agent remains responsible for retries: Studio does not replay messages or tools itself. A provider error followed by a successful native retry no longer leaves the run marked as failed. Other network disconnections remain possible. `test/transport.test.mjs` exercises both installed modules with an accelerated clock; it does not replace a real one-hour test.

Project order and shared read receipts are kept in `workspace.json`, without modifying native histories. Receipts identify an exact response, only advance along the current branch and are allowed for authenticated read-only devices. Receipt revisions and history freshness are handled separately to support delayed HTTP responses. `npm run test:activity` checks two browsers with independent storage; `npm run test:stability` covers cards, protected queues and persistent ordering on desktop/mobile. `node scripts/fixtures/session-stability.mjs` starts their isolated synthetic preview.

## Silent Windows processes

Provider management uses `lib/provider-service.mjs` and a hidden `scripts/provider-auth-worker.mjs` process. `lib/provider-auth.mjs` loads the native catalog and OAuth flows without project extensions. Keys pass through stdin; only display information and sign-in steps return to the browser. Writes use `FileAuthStorageBackend` and `AuthStorage`, checking the provider revision under a lock. Closing a flow stops only its sign-in process. `/api/providers` and its subroutes are not in the remote gateway’s allowlist.

`npm run test:providers` checks adding and removing keys in temporary native storage, model refresh, the simulated OAuth flow, draft preservation and rejection of routes on phones and remote PCs. `test/providers.test.mjs` covers locks, conflicts, invalid keys, secret commands not being executed, cancellations and OAuth timeouts. These tests connect or disconnect no personal accounts.

The server invokes the CLI’s JavaScript file directly with Node, without a `.cmd` launcher or PowerShell console.

Studio starts its own Prime Agent supervisor in the background at a private communication address. It does not reuse an external terminal’s supervisor. Requests share this engine, but each keeps its client: **Stop** asks the relevant client to cleanly close its session and subagents. Forcibly terminating its process remains a fallback if the client stops responding.

The local `runtime/windows-hidden.cjs` fix applies `windowsHide` to the CLI’s Node subprocesses. `runtime/python/sitecustomize.py` applies `CREATE_NO_WINDOW` and `SW_HIDE` to Python engine subprocesses, including PowerShell calls. These settings are passed only to the GUI’s process tree. The global Prime Agent installation is unchanged.

`runtime/windows-session-leases.cjs` lets Prime Agent 0.9.1 recognize a Windows directory collision when reclaiming a session lock. Prime Agent retains its PID and process-start-time checks: the fix does not remove locks belonging to active sessions.

The local `runtime/headless-loader.mjs` loader enables native waiting for subagent completion before the JSON client closes its session. A parent response therefore does not stop newly delegated tasks. The change applies in memory, only to Studio’s execution mode; installed Prime Agent files stay intact. If a CLI update changes this integration point, Studio reports an explicit error instead of applying an uncertain transformation.

Closing a tab does not kill the agent. **Stop** closes the run and its descendants. Closing or restarting the server interrupts active runs; already-recorded messages remain readable and the conversation can be resumed.

## Developing preferences without interruptions

Build the native application and installer with `npm run desktop:build`: see [the Windows guide](desktop.md). Native tests use a temporary folder and dedicated port. The interface has no generic Tauri shell access; launcher commands check their local origin, and external links open in the browser.

Studio serves repository files directly. Use a separate worktree when sessions are active: editing the served checkout could change their interface. `node scripts/preview-preferences.mjs --serve` starts a preview with temporary directories, a simulated runtime and loopback listeners only; displayed network addresses are examples. It starts no agents and changes no real accounts or access settings.

`lib/remote-network.mjs` owns the gateways and their lifecycle separately. Network changes and PIN rotation share a write queue and configuration revision. A new listener must bind before persistence and replacement of the old listener; failure rolls back staged listeners. Closing a gateway destroys its proxy connections without invoking agent cancellation. The remote gateway never forwards network or system configuration routes.

`lib/tailscale-https.mjs` prepares and verifies Tailscale Serve using `execFile`, without a shell or Windows console. The loopback gateway must listen before changing Serve. Rollback restores only the staged forwarding if it still belongs to Studio; third-party services and Funnel are never replaced. Approval links are restricted to HTTPS Serve/DNS pages on `login.tailscale.com`. Disabling HTTPS closes the local gateway and retains private forwarding for the next activation.

`npm run test:https` checks approval, retry, pending state, PIN, QR and HTTPS options on desktop/mobile. `test/https-settings.test.mjs` checks conflicts, rollback and agent continuity. These tests and the preview use a Tailscale emulator: no real configuration command runs.

`npm run test:settings` checks navigation, focus, network changes, QR codes, languages and 390/320 px widths. `test/remote-network.test.mjs` checks PIN preservation, failures, concurrent revisions, permissions and agents remaining active. Tests use only temporary data and loopback ports. Set `PRIME_STUDIO_TEST_BROWSER=chrome` to use Chrome instead of Edge in the relevant UI tests.

## Checks

```powershell
npm run check
npm test
npm run test:ui
npm run test:i18n
npm run test:mobile
npm run test:layout
npm run test:attachments
npm run test:inspector
npm run test:reasoning
npm run test:remote-access
npm run test:subagents:native
npm run test:pwa
```

## Interface translations

`public/translations.js` contains the language registry and a single table: one row per identifier, with all translations. `public/i18n-core.js` provides parameters, native `Intl` plurals, language selection and French fallback, also usable by the server. `public/i18n.js` applies the browser choice and updates only text and attributes bound to translations. Form inputs and conversation contents are not replaced when switching languages.

`npm run check` includes validation of languages, parameters, plurals and references in code and HTML. `test/i18n.test.mjs` deliberately tests a missing translation to verify real fallback. `npm run test:i18n` tests switching in a real browser, synchronization across tabs, provider and MCP sign-in drafts, a running response without cancellation, attachments, mobile sign-in and the offline PWA. Other graphical tests explicitly select French.

To add a message or language, follow the [translation guide](translations.md). Server text remains in the reference language in native data; the browser translates only Studio-owned labels and diagnostics. No external translation service is used.

Documentation also has two language versions. `npm run check:docs`, included in `npm run check`, checks the pair registry, links, anchors and review fingerprints. After an edit, review both languages and run `npm run docs:sync -- identifier`; the [translation guide](translations.md#maintain-bilingual-documentation) describes this process. This check does not automatically assess linguistic quality.

Automated tests use temporary data and a fake engine, without model usage. Windows tests also check native process-creation parameters, VBS startup, server reuse and descendant shutdown. Browser tests use the locally installed Microsoft Edge and produce screenshots under `test-results/`.

`test:subagents:native` uses the real engine and Python with a simulated local HTTP provider, without an account or paid call. It verifies default and explicit arguments, the existing prompt, live and historical reasoning levels, then a project-specific change while the first subagents are still working.

`runtime/subagent-loader.mjs` is added only to Studio processes’ environment. Its hook recognizes engine 0.9.2 methods, in modules or the bundle, and rejects unknown structures. Omitted arguments are filled before native validation; the instruction is added to system-prompt supplements and rebuilt before new turns. Child snapshots include their effective `thinkingLevel`. No installed Prime Agent file is modified. After updating this loader, restart Studio once active sessions finish.

`test:reasoning` checks the three display modes, sanitized Markdown, tracking of the last two lines on every delta and rotation, Agents panel values, and global/project configuration. The old boolean preference migrates to Hidden or Expanded; new installations use Preview.

Optional live test using the already-configured Luna account (**uses model calls**):

```powershell
node scripts/smoke-luna.mjs
```

It uses `openai-codex/gpt-5.6-luna` and isolated sessions in `.local/smoke-sessions`. It verifies a Python tool call to PowerShell with the silent-process fix loaded.

The live delegation, tool-resume and interruption scenario is explicitly launched with `node scripts/smoke-worker-recovery.mjs --run-luna`. It uses only Luna and keeps sessions and reports in `.local/recovery-smoke-workspace/`.

## Session, Agents and Files panel

`lib/session-inspector.mjs` reconstructs delegations from native registry links, without creating or repairing them. During an active run, `get_state` and `get_rlm_children` enrich the history; the client verifies ownership, project and session header before any read. No `attach`, `detach` or stop is sent. Snapshots are shared for two seconds, and the browser pauses refreshes when the panel is hidden.

`lib/project-files.mjs` restricts paths to registered projects, verifies real link targets and hides technical and private folders. Git runs without a shell or window, with time and size limits, without optional locks, external diffs or textconv. `GET /api/inspector*` and `GET /api/project-files*` use existing origin protections and authentication, including downloads.

Document references go through `GET /api/project-files/resolve` and the same project checks. `public/file-links.js` connects Markdown links and code-formatted paths to the viewer, without browser navigation. Native opening uses only `POST /api/project-files/open`, allowed for remote full-control connections. `lib/open-file.mjs` and the Windows helper pass the path as data to `ShellExecuteW`, requesting a visible application window from a hidden PowerShell helper. Scripts go to Notepad, and executables are rejected.

`npm run test:inspector` covers a nested hierarchy, activity of a reused agent, files and diffs, exact downloads, remote read-only mode, keyboard navigation, themes and widths of 1440, 390 and 320 pixels. It checks that native files, the Git index and the draft remain intact. `npm run test:commands:native` also checks reading the new snapshot from the real 0.9.2 engine during a Python tool call, without a paid provider call.

## Messages during a run

During a run, the input offers **Steer**—after the current step’s tools—or **Follow up**—after the current response. Queued messages can be edited, reordered, removed or moved between these modes. The stop square remains a separate control. A send confirmation means the engine accepted the message; actual delivery appears later in the conversation.

`lib/live-session-client.mjs` uses existing daemon commands without creating or restarting a session. `/api/live/sessions/:id` routes retain normal mobile authentication and permissions.

Targeted checks are `node scripts/test-live-messages-ui.mjs` and `node scripts/test-live-integration.mjs`. `node scripts/smoke-live-messages.mjs --run-native` uses the installed Prime Agent with a real Python tool and a simulated localhost provider, without calling a model account.

## Attachments

`lib/images.mjs` validates PNG/JPEG/GIF/WebP images. At launch, Studio uses native CLI `@path` arguments with images stored in `.studio-images/`; `steer` and `follow_up` RPC commands receive `ImageContent` blocks directly. Both paths record pixels in native messages. Queue edits deliberately omit the `images` field, preserving attached images according to Prime Agent 0.9.1’s native contract.

`lib/files.mjs` stores other files under random identifiers in `.local/attachments/`. Original names are metadata; file bytes are not interpreted as text. The message contains a `prime_studio_files` block listing local paths available to tools. History shows authenticated download links through `GET /api/files/:id`. Editing a queued message preserves its file references.

The browser provides two pickers, conversation drop support and pasting of clipboard `File` objects. A path copied as plain text is not imported automatically. Draft attachments use IndexedDB and are removed only after acceptance. The server announces this capability in bootstrap to prevent silently ignored submissions to an older server still running.

```powershell
npm run test:attachments
node scripts/smoke-live-messages.mjs --run-native --attachments
```

The first scenario checks real pickers, pasting, dropping, drafts, downloads, both delivery modes and mobile/desktop layout through the authenticated gateway. The second uses the real engine, a Python tool and a simulated local provider: it checks received pixels, file reads and preservation after queue editing, without using a model account or touching user sessions.

## PWA and private HTTPS

`public/manifest.webmanifest` describes the standalone app and its icons. `public/pwa.js` offers the native installation dialog or browser-specific help on the sign-in page and in the menu. The `/service-worker.js` service worker caches only a fixed list of icons, the manifest, a stylesheet, translation resources and the reconnection screen. APIs, SSE streams, submissions and user files are excluded. Authenticated pages are never stored in Cache Storage.

`lib/pwa.mjs` defines the only public resources needed for installation and validates the Tailscale HTTPS origin. `lib/lan.mjs` accepts this origin only on the dedicated loopback gateway, keeps Host/Origin checks and issues a Secure cookie. Proxy headers do not define the trusted origin. `scripts/enable-pwa.mjs` preserves existing configuration and points Tailscale Serve to this gateway, never directly to the local API.

`npm run test:pwa` uses a temporary Edge profile to check installation criteria through CDP, the service worker, absence of private data from the cache, offline fallback, draft preservation and iPhone instructions. The installation dialog is simulated so tests do not actually install an app on the PC. HTTP tests in `test/pwa.test.mjs` cover HTTPS authentication, public resources, origins and Serve configuration conflicts.

`public/viewport.js` adjusts chat height to the visible viewport, including when the keyboard shrinks only that viewport. Pinch zoom remains available. System margins are reserved around the interface; the secondary footer is hidden on mobile. `npm run test:layout` checks a long conversation in portrait, landscape and simulated keyboard/system-bar geometries. These simulations do not replace testing on a physical phone.

The PWA test also covers arriving from another site followed by reloading with the service worker active. This relay preserves navigation mode but may send `Sec-Fetch-Dest: empty`. The gateway accepts this case only for GET navigation to `/` and `/index.html`, while retaining Host/Origin checks, authentication and API protections.

## Projects, sign-out and MCP

`npm run test:workspace` checks project and session menus on touchscreens, their stability during resizing, confirmed removal with file preservation, MCP forms and browser sign-out during a simulated run. Desktop/mobile screenshots are stored in `test-results/`.

On Windows, `lib/open-directory.mjs` uses a hidden PowerShell helper and a ShellExecute request explicitly asking for a visible Explorer window. An existing window for the same folder is reused, including one hidden by an older launch. Success notification waits for confirmation of a visible, non-minimized window; agent processes retain silent startup. The path is passed as data without constructing a PowerShell command.

`npm run test:explorer` is an optional Windows test that actually opens a temporary folder in Explorer from a hidden process, verifies visibility, reproduces an invisible window and verifies restoration without duplicates. It closes only the window for the scenario’s temporary folder. This desktop test is separate from `npm test`, which must not open folders during normal checks.

`lib/mcp-config.mjs` validates native format, masks secrets returned to the browser and writes only `mcpServers` using `FileSettingsStorage.withLock`. Model defaults use the same lock. Each MCP edit checks the configuration revision to reject overwriting from a stale screen. `lib/prime-native.mjs` loads modules from the Prime Agent installation resolved by Studio; an incompatible installation produces an explicit error.

`lib/mcp-service.mjs` owns only its discovery and authorization processes. `scripts/mcp-probe-worker.mjs` and `scripts/mcp-probe.py` use native OAuth storage and the `rlm.mcp` Python client. `scripts/mcp-oauth-worker.mjs` uses the native OAuth provider with full-URL input from another device. Timeouts, cancellations and shutdowns are limited to manager processes. No daemon shutdown or user-session reload is triggered.

`test/mcp.test.mjs` covers concurrent writes with model settings, secrets, conflicts, reserved servers, stdio and HTTP connections with the real Python client, and a complete HTTPS OAuth flow with PKCE and mobile callback. These tests use only temporary servers, files and certificates; no provider account is used. They require Prime Agent installed and, for connections, `npm run setup:runtime`.

MCP routes are `/api/mcp` (GET/POST/PATCH/DELETE), `/api/mcp/test`, `/api/mcp/login`, `/api/mcp/disconnect`, `/api/mcp/login/complete` (POST), and `/api/mcp/login/:id` (GET/DELETE). The gateway rejects them in read-only mode. `POST /lan/logout` revokes the current cookie and its proxy connections, including SSE, without stopping runs. `DELETE /api/projects` removes project metadata; a persistent marker prevents immediate reimport from native sessions.

## Code organization

`public/composer.js` keeps the selected command separate from arguments in the textarea. `composerText()` serializes both for drafts and both delivery paths; `setComposerText()` synchronizes editing and the chip. Attachment paste events remain attached to the same textarea. Immediate shortcuts are shared between the interface and server in `public/command-definitions.js`.

The browser prefetches the catalog, shares requests, caches each context for 30 seconds and invalidates late responses when switching sessions. Server validation remains native. The menu offers shortcuts without waiting for the network, and the detailed catalog shows batches of 30 results. `scripts/test-command-chips.mjs`, included in `npm run test:commands`, deliberately holds the HTTP response to verify immediate opening and uses 801 skills to test pagination and search, then drafts, clipboard, attachments and submissions during a turn on desktop and mobile.

`lib/commands.mjs` exposes the catalog and validates slash submissions before admission. `scripts/command-catalog-worker.mjs` uses package management and skill/prompt readers from the native installation in a hidden process with limits. It ignores missing packages and does not load JavaScript extensions. During an active run, `get_commands` supplies actually-loaded resources after verifying worker identity.

Native session commands go through `prompt` with `streamingBehavior` and `queueIfBusy`: `steer` and `follow_up` alone do not trigger native command parsing. Skills and prompts retain these ordinary delivery paths and are expanded by the engine. Native `custom` results with `display: true` are projected as context messages. Replacing a normal message with a queued command is rejected because their native action types differ.

`npm run test:commands` checks desktop/mobile flows through an authenticated gateway, the catalog, keyboard completion, shortcuts, untrusted content and composer layout. `npm run test:commands:native` uses a real Prime Agent worker, its Python tool and a fake local provider in temporary folders. It verifies skill expansion, prompt arguments, mid-turn commands, their history and uninterrupted tools. No user account or daemon is used.

`server.mjs` exposes the local API and SSE streams. `lib/store.mjs` reads native sessions and stores preferences. `lib/agent.mjs` manages the CLI, models, events and shutdown. `public/` contains the interface. `runtime/` isolates subprocess fixes. `scripts/` contains launchers and verification tools.

Main routes are `GET /api/bootstrap`, `GET /api/overview`, `GET /api/history?id=…`, the local `/api/model-config` and `/api/model-defaults` routes, `POST /api/projects`, `PATCH /api/projects`, `PATCH /api/sessions`, `POST /api/runs`, `GET /api/runs/:id/events` and `POST /api/runs/:id/stop`. SSE streams accept `Last-Event-ID` to resume events after disconnection.

## Regenerate README screenshots

```powershell
node scripts/capture-readme.mjs
```

This command regenerates illustrations **in French and English** from the repository's current HTML, JavaScript and styles. It uses the Chromium installed for Playwright without a visible window. `PRIME_STUDIO_BROWSER` can select another already installed channel, such as `chrome` or `msedge`.

Scenarios are split into three groups in `scripts/readme-captures/`:

| Group       | Views covered                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `core`      | Conversations, projects, import, Roadmap, live messages, questions, attachments, models and subagents. |
| `tools`     | Providers, MCP, commands, files, knowledge and session context.                                        |
| `platforms` | Mobile conversation, remote access, notifications, Windows setup and updates.                          |

Each group starts a temporary server on the loopback address with isolated folders and fictional data. No native agent, provider account, real MCP server or user session is used. Engine, desktop and network services may be simulated to display the documented states: **these screenshots illustrate the interface; they do not validate a real connection or Windows installation**.

Screenshots contain no added banners. Fictional data is disclosed in the README, outside the images. Views use dimensions suited to their content: desktop, cropped dialogs and phones. Each language has its own captures and demonstration content.

All requested captures are produced before replacing files in `docs/screenshots/` and `docs/screenshots/en/`. The `test-results/readme-captures.json` report records scenarios, dimensions and image hashes. Temporary servers, browsers and folders are cleaned up after execution, including on failure.

To regenerate only one language or group, or prepare a review without replacing published illustrations:

```powershell
node scripts/capture-readme.mjs --lang en
node scripts/capture-readme.mjs --group core
node scripts/capture-readme.mjs --output .local/readme-preview
```

`--docs-en` remains an alias for `--lang en`. Specialized test scripts and `scripts/capture-roadmap.mjs` remain available for their own scenarios; they are not needed to rebuild the README illustrations.
