# Configuration and local data

**English** · [Français](../configuration.md) · [← Back to README](../../README.md)

## Preferences and setting scope

**Preferences** organizes settings into seven categories: **Appearance**, **Models & agents**, **Tools**, **Remote access**, **Notifications**, **System** and **Updates**. Navigation works on small screens and with the keyboard. Closing a manager opened from preferences returns to its category.

A note below each title explains scope without adding controls: appearance and typing preferences apply to this browser and address; accounts, MCP and model defaults apply to Prime Agent on this PC. Studio subagent defaults can be overridden for a project. The conversation model remains separate from the default model.

**Tools** opens MCP and Skills/Prompts catalogs, with their global and selected-project folders. **Remote access**, restricted to the PC, enables LAN and Tailscale without interrupting agents and provides links and QR codes: see [the mobile guide](lan.md). **System** shows versions, engine availability and the running agent count; copied diagnostics exclude keys and conversations. Opening logs is restricted to the PC.

The **Tailscale HTTPS** card also configures the private address needed for [PWA installation](pwa.md), with a Tailscale approval link when needed and a retry action in the panel. It preserves the PIN and other access channels.

## Interface language

**Preferences → Appearance → Language** offers **Automatic**, **Français** and **English** on desktop and mobile. Automatic mode uses browser languages, with French as the fallback. The choice is stored in `prime-studio.language` for this browser and access address. Tabs at the same address synchronize; other devices keep their own choice.

Changing language does not reload the page, send a message or stop an agent. Open forms, drafts, attachments, model selections and reasoning levels are preserved. Conversations, reasoning, files, model names and command identifiers keep their original contents. External resource descriptions and diagnostics received directly from a provider remain in their original language when Studio has no translation for them.

A preference cookie, `prime_studio_language`, separate from the authentication cookie, lets the server render mobile sign-in in the appropriate language before JavaScript loads. The translation table and engine are public PWA resources; no conversations or attachments are added to its cache.

The [translation documentation](translations.md) describes the single table, fallback and automated checks.

## Configure models

### Interactive questions and conversation images

The **Allow questions** checkbox beside thinking enables the question tool for this conversation. It is checked by default and can be changed between runs. **Preferences → Models & agents → Allow questions by default** sets the initial value, shared by devices connected to this PC. Saved conversation choices take precedence. The agent offers choices with short descriptions, collapsed by default and accessible via **Show description**. Select an option, write another answer, or skip. Studio uses Prime Agent’s native interactive protocol and records the result in its tool history. Answering on a phone also resolves the request on the PC. Reloading the page restores requests while the run and server remain active; stopping the engine cancels them.

The agent can display a project PNG, JPEG, GIF or WebP file with `![Preview](captures/result.png)`. Studio reads the original file without copying it, and clicking enlarges the image. Moved or deleted images show an unavailable state. Editing the file therefore changes its preview on the next load. Project access rules apply on mobile too; this feature does not expose files outside the project. User-uploaded attachments retain their existing behavior.

### Windows notifications

In the Windows application, **Preferences → Notifications** offers two independent switches, both initially enabled: **Agent question** and **Agent turn completed**. Agent errors follow the completed-turn setting; manual stops stay silent. Preferences are saved on this PC in `desktop.json`.

Studio shows no notification while any of its windows has focus, including its app settings window. Silent events are not replayed when you switch to another application. Native monitoring continues while the window is hidden; fully quitting the app stops it. Past events are not replayed at startup. Windows notification settings and **Do not disturb** still apply.

These notifications require the new installed Windows build. Browsers and the PWA do not trigger Windows notifications on the host PC. Development builds may use the PowerShell identity for notifications, as described in the [Tauri documentation](https://v2.tauri.app/plugin/notification/).

### Model and thinking level

The model and thinking selectors beside the message field belong to the current conversation. Studio restores its choices when reopened, including from another device. New conversations start from Prime Agent defaults; changing one conversation does not change those global defaults.

You can change thinking while the agent is working. The engine applies the supported level to subsequent model calls, without interrupting the current call or tool. A message confirms acceptance; if it fails, the selector returns to its previous value. Choose the model between runs.

Open **Preferences → Models & agents → Configure** on the PC. The first area chooses the main agent’s default model with the conversation selector, its integrated search and shared favorites. Click **Save** to apply the choice. This area writes only the native `defaultProvider` and `defaultModel` fields in `~/.prime/agent/settings.json`, as in Prime Agent 0.9.1. The choice applies to Studio’s selector and future launches. **Prime Agent automatic selection** removes these two fields. **New session**, **Ctrl+N** and opening an empty conversation use this default model even if a different model was selected in the previous conversation. Existing conversations restore the model from their history.

The **Subagents** area, verified with Prime Agent **0.9.6**, defines the default model and reasoning level for all projects. The model button opens the same selector as conversations: identical catalog, integrated search by name, provider or ID, and shared favorites. Available levels depend on the selected model. **Engine default** uses the native default model, or the parent model when none is set. **Parent level** preserves reasoning-level inheritance.

For a specific project, open a conversation and the right panel’s **Agents** tab. Settings are available before the first message, as soon as a project is selected; they are saved for that project without creating a Prime Agent session or starting an agent. In the compact **Project subagents** block, **Global** hides the selectors and uses shared defaults. Choose **This project** to show the model and reasoning level and create a project override. Each change saves immediately. Returning to **Global** removes the override and hides the selectors again. This setting is also available on phones with full control; read-only connections can only view it. Global settings remain desktop-only.

Studio adds a dynamic instruction to the system prompt without replacing `SYSTEM.md`, `APPEND_SYSTEM.md`, project instructions or skills. It also supplies missing values in `rlm.spawn(…, name="…")` calls, so the engine applies the choice. Explicit `model` or `thinking` arguments take priority. When the Studio default is empty, the native default applies before the parent model. Prime Agent checks model authentication and reasoning-level compatibility; if you inherit the parent model while fixing a level, that model must support the level.

Settings are stored in `.local/subagent-defaults.json`, separately from native files. New delegations and subsequent agent turns use updated values, including in a session already loaded by Studio. Existing subagents retain their model and level. Concurrent changes from another tab require reloading settings before saving. Sessions launched independently of Studio retain Prime Agent’s behavior.

The same screen also adds, edits or removes custom definitions in `~/.prime/agent/models.json`, then refreshes the selector. Existing advanced fields are preserved. For a new provider, enter an environment variable’s **name**, never its secret value. The server accepts only the four protocols documented by Prime Agent and blocks URLs containing credentials, query parameters or fragments. HTTPS is required except for local loopback services. An address associated with existing credentials cannot be replaced from the form, to prevent accidentally sending a key to another server.

Before writing, Studio saves a `models.json.prime-studio.bak` or `settings.json.prime-studio.bak` copy in the same folder. The configurator and its write routes are restricted to `127.0.0.1`; they do not pass through the LAN gateway. Already-configured models remain available in the phone’s selector.

### Advanced models and autonomous budgets (Prime Agent 0.9.6)

The **Advanced models** card, on the same **Configure** screen, exposes the new native Prime Agent 0.9.6 settings without changing your current values. While fields stay empty, native behavior is preserved: no fallback model or autonomous mode is enabled automatically, and default models stay unchanged.

The **summary and refinement model** (`auxiliaryModel`) serves refinement, compaction summaries and branch summaries. The engine uses the session model when this choice is unset or unusable, or when the selected model cannot fit a branch summary. This is native engine routing, not a measured Studio cost guarantee.

The **image model** (`imageModel`) handles turns with attached images when the session model accepts only text. It must support images. Leaving it empty keeps the native explicit refusal for unsupported image turns. It does not replace the Computer Use decision model or enable a separate screenshot-analysis agent.

The **fallback model** (`providerBackupModel`) stays off by default: requests never silently switch models. When set and authenticated, it applies on quota exhaustion or provider outage. Model selectors share the authenticated catalog (`/api/models`, unavailable models excluded); an empty choice deletes the field and restores native behavior.

The **default service tier** (`defaultServiceTier`) applies to new sessions. **Standard** restores the engine default; **Flex**, **Priority** and **Auto** depend on provider support and may change cost or latency. Saving a default does not change or restart an active session.

The four **default autonomous budgets** (`autonomous.maxContinuations`, `maxTurns`, `maxTokens`, `timeoutMs`) accept a positive integer or `Unlimited`. An empty field deletes that budget and restores the native default (3 continuations, 12 turns, 80,000 tokens, 30 minutes). These limits are ready without enabling autonomous mode; explicit launch flags still win on every run.

The **native subagent default** (`subagentDefaultModel`) is a separate native field, labeled distinctly so it cannot be confused with Studio settings. Saving this field does not change the Studio preferences in `.local/subagent-defaults.json`. Priority stays: explicit `model`/`thinking` arguments > Studio settings (global or project) > native default > parent model. Clearing this field removes the native default; explicit arguments and Studio preferences still take priority.

Writes go through the native `FileSettingsStorage` lock, merge unknown fields without erasing them, validate every value strictly, and keep a `settings.json.prime-studio.bak` backup. A concurrent change from another tab returns a 409 conflict: reload settings before saving. The `GET`/`POST /api/engine-settings` routes are PC-only (`127.0.0.1`) and absent from the LAN gateway: from remote or read-only access the panel stays viewable but disabled, with no mutation possible.

## Data and configuration

The [Providers panel](providers.md), available only through the PC’s local address, manages native `auth.json` credentials. It offers account flows, API keys and disconnection with confirmation. Stored secrets are not returned to the browser; external settings and MCP credentials are preserved.

The [MCP manager](mcp.md), separate from the model configurator, is also available remotely with full control. It edits the native `mcpServers` field in `settings.json` and delegates OAuth credentials to Prime Agent’s `auth.json` storage. Model-default and MCP writes use the same native lock to preserve simultaneous changes.

| Location                                                   | Contents                                                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.prime/agent/sessions/`                                 | Native Prime Agent conversations                                                                                                        |
| `~/.prime/agent/settings.json`, `models.json`, `auth.json` | Engine configuration; the configurator can write `models.json` and defaults in `settings.json` without sending secrets to the interface |
| `.local/workspace.json`                                    | GUI projects, titles, pins and archives                                                                                                 |
| `.local/subagent-defaults.json`                            | Subagent model and reasoning: global defaults and project overrides                                                                     |
| `.local/kernel-venv/`                                      | Python environments per skill configuration, with validation markers; previous generations remain available                             |
| `.local/kernel-ready.json`                                 | Path of the latest Python fully prepared and verified by Studio                                                                         |
| `.local/attachments/`                                      | Original attached files and download metadata; keep them to reopen files from sessions                                                  |
| `~/.prime/agent/sessions/.studio-images/`                  | Images passed to the CLI, also recorded in native messages                                                                              |
| Browser IndexedDB                                          | Draft attachments, separated by session or new project                                                                                  |
| Browser local storage                                      | Drafts, theme and input preferences                                                                                                     |
| Browser Cache Storage                                      | PWA icons and reconnection screen; no conversations or sent attachments                                                                 |
| `.local/lan-access.json`                                   | Hashed access code and LAN, Tailscale and HTTPS PWA gateways                                                                            |
| `.local/logs/server.log`                                   | Background server log                                                                                                                   |
| `.local/logs/launcher.log`                                 | Launcher diagnostics                                                                                                                    |

| Environment variable           | Purpose                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `PORT`                         | HTTP port; defaults to `3088`                                                                                       |
| `PRIME_AGENT_CLI`              | Path to Prime Agent’s `cli.js` or npm folder                                                                        |
| `PRIME_AGENT_CODING_AGENT_DIR` | Prime Agent configuration folder                                                                                    |
| `PRIME_AGENT_SESSION_DIR`      | Folder for reading and creating sessions                                                                            |
| `PRIME_AGENT_GUI_DATA_DIR`     | GUI metadata folder; defaults to `.local`                                                                           |
| `PRIME_AGENT_GUI_NODE`         | Node executable used by the VBS launcher                                                                            |
| `PRIME_AGENT_KERNEL_PYTHON`    | Already-prepared external Python with runtime, libraries and Python skills; verified without automatic installation |
| `PRIME_GUI_UV`                 | Path to the `uv` executable used to prepare Studio environments                                                     |

### Python and skills

When no external Python is configured, Studio prepares the runtime and enabled project Python skills on Windows. Discovery follows Prime Agent settings, including extra paths and disabled skills. Parents and their subagents use this preparation, including after resuming.

To repair an older installation missing `agent_message`, run on the PC:

```powershell
npm run setup:runtime
npm stop
npm run start:silent
```

You do not need to delete the old venv. Setup checks imports and automatically creates a complete environment when needed. For another project: `npm run setup:runtime -- "C:\project path"`. An already-open kernel keeps its environment until restarted; stopping Studio also ends active runs but preserves conversations.

If `PRIME_AGENT_KERNEL_PYTHON` is set, you manage that Python’s packages. Studio installs nothing into it and reports missing imports precisely. The runtime and enabled messaging skill are required; other unavailable skills are reported as optional. A managed environment is reported as successfully prepared only after complete verification.

The control server listens only on `127.0.0.1`. Optional mobile access goes through an authenticated gateway that allows commands according to its mode. External origins and unknown hostnames are rejected; only interface files and allowed routes are served. Do not expose it through a public proxy: this is a personal local application.
