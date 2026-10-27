# Release history

**English** · [Français](../changelog.md) · [← Back to README](../../README.md)

Changes by version. See [GitHub releases](https://github.com/zerr0o/prime-agent-studio/releases) for installers and source archives.

## 4.4.7-beta.1

- **On-demand delegation**: the main agent keeps its model and reasoning level. Desktop tasks use ordinary native subagents with the configured Computer Use model and effort. No child or desktop worker is created just by enabling permission. An idle child can be reused, or a new one created for another task.
- **Exclusive desktop**: several conversations can be authorized, but only one exact agent holds the desktop. Siblings cannot share its lock. Finishing, stopping or releasing the child frees the desktop and invalidates old frames. A busy desktop is refused without takeover or automatic replay.
- **Verified access**: the child's model comes from its native session and image support from the model catalog, not tool-call hints. Permission revocation and worker creation remain safe across concurrent requests. Tool errors expose bounded diagnostic details to the model.
- **Scope**: this is the delegation change, not a claim that every temporary-window, partial-action or screenshot-retention issue is resolved. Real-desktop acceptance remains separate from automated fake-desktop tests.

## 4.4.6

- **GPT-6.1 Terra**: added to the OpenAI API and Codex catalogs with verified model metadata and reasoning levels. Codex availability still depends on your account; your default model is unchanged.
- **Files**: simpler Changes and History views. The commit message and **Suggest a message** remain visible in Changes. History shows commits beside their files, with tags, automatic loading on bottom scroll, and GitHub Desktop status colors. Click a file to open its diff in the viewer.
- **Worktrees**: a count in the tab, rounded selection, a **Current** badge, and separate path and change-status lines. Opening a worktree changes only the Files context, not the conversation.
- **Stable layout**: background file refreshes no longer flash a loading message or reset checked files. Branch, status, and Fetch/Pull/Push share one compact toolbar. Active skill chips no longer collapse the primary message input.
- **Git safety**: commits include only selected files and preserve unrelated staged files. File names are treated literally, and read-only access keeps Git write operations blocked.

## 4.4.6-beta.2

- **Input with an active skill**: fixed a CSS specificity conflict that collapsed the primary input to a few pixels and caused an unwanted scrollbar. The input now keeps its width with or without a skill on desktop, laptop, and mobile layouts.

## 4.4.6-beta.1

- **Files**: four separate views — **Changes**, **History**, **Worktrees**, and **Browse**. Wide panels show the diff next to the list; narrow panels offer an enlarged view.
- **Git history**: paginated commits, visible tags, commit files, and diffs against the first parent, including the repository’s first commit. Search and the tags filter cover loaded commits; **Load more** extends the list.
- **Worktrees**: list repository worktrees and select Studio-managed worktrees for the Files panel without changing the conversation. External worktrees remain visible without granting access to an unregistered file context.
- **Commits**: the existing **Suggest a message** button is preserved, including in managed worktrees. Commits include only selected files and leave unrelated staged files in the index. Names containing Git pathspec characters are treated literally. No automatic commit or push.
- **Read-only access**: history and diffs remain available in consultation mode; Git write actions remain blocked. History reads run neither hooks nor external diff tools.

## 4.4.5

- **Windows reserved ports**: if the local port is unavailable, Studio selects another port and remembers it. You can also change it in **Preferences → System**, or from the launcher after a startup failure. The change confirms the server shutdown and restarts the application safely, with an extra confirmation if agents are working. `PRIME_STUDIO_DESKTOP_PORT` still takes priority.
- **Startup and conversations**: a lightweight local index avoids rereading every history on each launch. Only changed files are parsed again, and opening a conversation loads only its history. The first index build can still take time. The list appears without waiting for the engine or models; stalled requests retry automatically, and slow stages are logged without conversation content.
- **Outside-project previews**: **File previews outside the project**, in **Preferences → Appearance**, is enabled by default. Links to local files outside the project open a read-only preview with their full path. Disabling the option is enforced on the server. Protected directories, network paths and remote consultation access remain excluded; no extra edit or execution permissions are granted.
- **Preferences**: fixed a translation error in the Windows autostart status.
- **Security**: updated DOMPurify to 3.4.17.

> Changing the port changes the Web origin: layouts and drafts saved for the previous address may no longer be visible. Projects and conversations are preserved.

## 4.4.4

- **Code highlighting**: file previews and code blocks in conversations are colored like in VS Code (dark and light themes), with line numbers. highlight.js is served by Studio itself and loaded only when code is shown; very large files stay plain text. The **Syntax highlighting in conversations** option, in Preferences → Appearance, turns it off in conversations.
- **Open with the Windows app**: **Open** uses the default Windows application for documents, web pages and code (the browser for an `.html` file, your editor for a `.ts` or `.json` file). Scripts that Windows would run (`.js`, `.ps1`, `.bat`, `.py`…) still open in Notepad, and programs are still refused.
- **Run a script**: the new **Run** button starts the script, after a confirmation, in a visible console opened in its folder, which stays open at the end. It is available on the PC and in remote full-control access, never in read-only access.
- **Reliable file links**: in messages, only references to an existing file become links. Bare names and path endings are looked up in the project files, honoring `.gitignore`, and line ranges (`app.js:62-63`) are understood. A link to a missing file appears struck through; version numbers and branch names stay plain text. Agents are also told to write paths from the project folder.

## 4.4.3

- **Reliable message sending**: as soon as you send, the input turns grey and locks with “Sending message…”, then empties when the message appears in the conversation. Text edited during the wait can no longer stay in the field after it was sent. On failure, the text becomes editable again. Same behavior during a run (Steer, Follow up).
- **Setup before the first message**: while no provider is connected, or the main agent or subagent model is missing, a new conversation shows three steps instead of the suggestions, and sending waits until setup is done. Without a connection, the engine default model failed (401 error). If only the subagent model is missing, **Use the same** is enough.
- **Simpler models**: the “Advanced models” block and all quota management (quota fallback, caps, autonomous budgets) are removed. Codex usage stays visible. If old values exist, a “Legacy settings detected” card removes them in one click; an old fallback model blocks runs until this reset.
- **Clearer component setup**: the welcome screen says whether this is a first-time setup or a repair. During setup, a step list shows the current step, its elapsed time, the downloaded size and an explanation for long steps. On a first install, Studio opens by itself at the end.
- **More robust start**: the app no longer depends on how Node reads long Windows paths (`\\?\C:\…`), and the build refuses an incompatible Node. A start error shows a plain explanation, with the technical details folded.
- **Interface**: “Studio preferences” from the notification area no longer freezes the window. Subagent history groups tool calls between two messages and opens at the latest message. The top bar “…” button is removed: the menu stays on each conversation in the list (right-click or “…”). Dot icons stay visible on very high-density screens, and “Refresh” is aligned with the search field in the Providers window.

## 4.4.3-beta.1

- **“Studio preferences” menu fixed**: from the notification area icon, Preferences open in front again, on the Updates tab. Before, an invisible window could block every click.
- **Clearer component setup**: the welcome screen says whether this is a first-time setup or a repair, and explains what each component is for. During setup, a step list shows the current step, its elapsed time, the downloaded size and an explanation for long steps (npm dependencies, Python). On failure, the failed step is marked with Try again and Open logs. On a first install, Studio opens by itself at the end.
- **More robust start**: the app no longer depends on how Node reads long Windows paths (`\\?\C:\…`), and the build refuses an incompatible Node. A start error shows a plain explanation, with the technical details folded.
- **Easier-to-read subagent history**: in the Agents panel, tool calls between two messages are grouped in a collapsible “Agent activity” block, like in the main conversation, and the window opens at the latest message.

## 4.4.2

- **Questions stay in order**: answered or skipped questions now remain beside the assistant message that preceded them, instead of staying at the bottom after newer messages arrive. This also covers question batches and windowed history, including when the conversation view is recreated. Pending questions remain near the composer; questions already linked to a tool keep their existing position. Contributed by [@evgyur](https://github.com/evgyur) in [#12](https://github.com/zerr0o/prime-agent-studio/pull/12).

## 4.4.1

- **Simpler subagent settings**: the Explore / Implement / Review role selectors have been removed. Choose the default model and thinking level globally or per project; explicit choices when launching a subagent still take priority.
- **Existing conversations stay compatible**: saved role-specific settings no longer affect model selection. Legacy `role` arguments are ignored, so older conversations can continue without errors caused by the removed selector.
- **Other controls are unchanged**: the Git suggestion model, budgets and quota fallback remain available. The pinned Prime Agent 0.9.8 setup fix and the opt-in Context (Beta) feature from 4.4.0 are preserved.

## 4.4.0

- **Prime Agent setup fixed**: the engine remains pinned to 0.9.8. Studio uses a source and digests recorded in the build instead of parsing a remote installer script that changes independently. Archives are still verified before activation. Fixes the `source_contract_changed` blocker reported in issue #10.
- **Repair diagnostics**: failures show the `components.log` path in English and French (PR #11).
- **Context (Beta)**: the new project context system is disabled by default and requires explicit opt-in. Its tab is marked Beta. It provides a local code index and search, symbol and project-map tools; no remote embedding service is used.
- **Routing and budgets**: subagent roles, auxiliary models, quota fallback and configurable budgets. Model choices use the shared picker; quota actions display the affected model name.
- **Performance**: stopped runs are excluded from the success-rate calculation. This stable release also includes usage metrics and the context gauge from 4.4.0-beta.2.

## 4.4.0-beta.2

- **Performance tab**: a new tool tab in the modular workspace shows your usage for this project or all projects, over today, 7, 30 or 90 days: estimated cost, tokens, cache rate, runs, median duration and time to first token, a daily chart, a ranking of your models on your own work (success rate, cost per completed run, latency, errors) and a by-project table. It follows the active project or stays locked to one; in classic and mobile layouts it opens from the Session tab. It refreshes when shown, after each run or with Refresh, never on a timer.
- **Context gauge**: a quiet "Context x % · Cache y %" line under every composer (main editor, modular tabs, mobile), updated on run events. When idle, it shows the last request. Amber at 80 %, red at 95 %.
- **Clearer usage in the Session panel**: uncached input, output, cache read and cache write, cache rate, and totals that include subagents without double counting. The main agent figure no longer includes part of the subagents' usage, and its details stay open while the panel refreshes.
- **Usage metrics**: Studio records content-free metadata for every request, subagents included (tokens, cache, estimated cost, statuses, durations), keeps it 90 days in the data folder and backfills existing sessions in the background. No prompt, response or tool content is stored.

## 4.3.8-beta.3

- **Copy a conversation ID**: the conversation menu now offers **Copy conversation ID**. It copies the saved conversation ID, useful with the public API or for support. Contributed by [@evgyur](https://github.com/evgyur) in [#8](https://github.com/zerr0o/prime-agent-studio/pull/8).

## 4.3.8-beta.2

- **The window reopens where you left it**: the main window keeps its position, size and maximized state across restarts. A window larger than its screen is resized to fit, and a window left on a disconnected screen returns to the main screen.

## 4.3.8-beta.1

- **Waiting agents are visible in the Session panel**: in "Running agents", an agent waiting for your answer shows the amber question dot used in the sidebar and tabs, in place of the spinner. The spinner comes back once you answer. Contributed by [@evgyur](https://github.com/evgyur) in [#7](https://github.com/zerr0o/prime-agent-studio/pull/7).

## 4.3.7

- **Voice messages**: a microphone in the composer records a message and transcribes it, then sends the text or adds it to the draft (**Send after transcription**). Turn it on in Preferences › Tools › Voice messages, with **Groq** (the Groq key from Providers, or `GROQ_API_KEY`) or a **local Whisper** server such as whisper.cpp; the setting is per PC. After a temporary failure, **Retry** resends the same recording. Contributed by [@evgyur](https://github.com/evgyur) in [#6](https://github.com/zerr0o/prime-agent-studio/pull/6).
- **Several questions at once**: the agent can ask 1 to 6 questions in one call. Browse them on one line, ← Question 2/3 →, answer each with an option or your own text, or skip it: a skipped question shows a check and "Question skipped", and pressing again undoes it. Then send all answers together. Free text is always available, including for a single question. The public API accepts `{ values: [...] }` for several questions; a single question keeps its format.
- **The sidebar no longer replaces an open conversation**: in the modular workspace, picking a conversation, run or project opens it in a new tab right after the active conversation, or focuses its existing tab. At eight open conversations, Studio asks you to close a tab instead of replacing one.
- **Narrow windows and mobile**: the visible editor always sends. A hidden tab's editor can no longer send stale text.
- **Every tab**: secondary tabs show the Latest messages button above their composer, and no longer add a redundant "question(s) waiting" bar.
- **Updates**: the beta option no longer says there is no automatic check.

## 4.3.6-beta.2

- **Voice messages**: a microphone in the composer records a message, transcribes it and sends the text. Turn it on in Preferences › Tools › Voice messages, with **Groq** (the Groq key from Providers, or `GROQ_API_KEY`) or a **local Whisper** server such as whisper.cpp. The setting is specific to each PC. Contributed by [@evgyur](https://github.com/evgyur) in [#6](https://github.com/zerr0o/prime-agent-studio/pull/6).
- **Send or keep as draft**: turn off **Send after transcription** to add the transcribed text to the draft without sending it, so you can complete it first.
- **Reliable dictation**: after a temporary failure (rate limit, timeout, service unavailable), **Retry** resends the same recording. If the original conversation is gone, **Copy text** keeps the transcript. The microphone always uses the visible editor, including on mobile.

## 4.3.6-beta.1

- **Several questions at once**: the agent can ask 1 to 6 questions in one call. Browse them on a single line, ← Question 2/3 →, answer each with an option or your own text, skip any, then send all answers together. A free-text answer is always available, including for a single question. The public API accepts `{ values: [...] }` for several questions; a single question keeps its format.
- **The sidebar no longer replaces an open conversation**: in the modular workspace, picking a conversation, run or project opens it in a new tab right after the active conversation, or focuses its existing tab. At eight open conversations, Studio asks you to close a tab instead of replacing one.
- **Narrow windows and mobile**: the visible editor always sends. A hidden tab's editor can no longer send stale text.
- **Latest messages in every tab**: secondary tabs show the same Latest messages button, centered above their composer.

## 4.3.5

- **Roadmap order syncs**: moving a plan, milestone or backlog entry now reaches other PCs. Before, each PC kept its own order when merging, so two PCs could stay different forever while both showed "synced". The order of the most recently edited roadmap wins; on a tie, every PC picks the same one. On the first cycle after updating, each remote roadmap is merged again once so existing differences heal.

## 4.3.4

- **Muse Code models match your subscription**: the picker now only shows the models your plan actually serves. Muse Wonder Full no longer appears on plans that do not include it, instead of failing with "model not found". The list is read from Meta (read-only); when it is unavailable, all models stay listed.
- **Muse Wonder Contributor**: new Muse Code variant (`muse-wonder-1.0-contributor`), served in the default Contributor mode of subscriptions. It gives more usage in exchange for using content for training.

## 4.3.3

- **Sync from the public API**: `GET /api/v1/sync` reads state; `POST /api/v1/projects/{projectId}/sync` immediately syncs one conversation through R2 (even one this PC has never seen) or runs a full cycle. New `sync:write` permission, unchecked by default. An app can continue on one PC a conversation finished on another without waiting for the five-minute cycle.
- **Reliable end-of-turn upload**: a conversation sync now waits for a running cycle instead of being skipped.
- **Muse Wonder**: new Meta model (`muse-wonder-1.0`, preview) with an API key or a Muse Code subscription; **Muse Wonder Full** with a Muse Code subscription (Power Usage and Maximum Usage plans).

## 4.3.2

- **Update available**: the Windows app checks for updates 10 seconds after startup, then every 30 minutes, on the selected channel (stable or beta). When a version exists, an **Update available** button appears next to **Preferences** and opens **Preferences → Updates**. Nothing is downloaded or installed without your click; errors from this check stay silent.
- **New conversations always possible**: closed conversations stayed registered and, beyond 24, blocked creation even with few open tabs. Studio now frees the oldest closed conversation without a draft, attachment or running agent. Its history remains available from the sidebar.
- **README**: new FR/EN landing page with the full presentation film; providers, configuration and navigation guides corrected for full-control remote access.

## 4.3.1

- **Computer Use in the public API**: `GET /api/v1/computer-use` reads state; `POST` enables or disables authorization for one session or run. The new `computer:write` permission defaults unchecked and is not added to existing tokens. Every write requires the previously read revision, with no takeover of another target's controller and no implicit capture or input. FR/EN guides and OpenAPI are updated.
- **Open folders outside the project**: **Open folder** accepts any existing folder accessible to the PC, without registering it as a project. Absolute, relative and `file://` paths are supported; a file opens its parent folder. Previews and downloads keep their access boundaries.
- **Link menus inside previews**: links in a document dialog can also open their containing folder; the menu remains clickable and keyboard focus is preserved.

## 4.3.0

- **Stable dockable workspace**: arrange up to eight conversations and sixteen tool panels. Each conversation keeps its composer, drafts, attachments and reading position. Classic and mobile layouts remain available.
- **Independent, lockable tools**: Roadmap, Session, Agents, Files and Preferences can follow the active conversation or stay pinned. Missing targets stay unavailable; permissions remain live. Named layouts save panel types and geometry, never conversations or drafts.
- **Computer Use flicker fixed**: switching conversations no longer clears the desktop owner, last action and stop shortcut in Session panels, including locked panels. Cached display data never grants the new conversation permission to control the desktop; delayed responses and errors remain guarded.
- **Faster history and reliable navigation**: paged, virtual history keeps saved data complete. New conversations open distinct tabs; Roadmap loading, Preferences dialogs and first-click links/images are fixed.
- **Refined tabs and input**: compact tool names, integrated locks, drag-and-drop placement, per-pane slash commands and inline skill expansion.
- **Other improvements since 4.2.0**: opt-in public API v1 and interactive documentation, Roadmap completion provenance, mobile polish and dependency security updates.
- **Limits**: native floating windows are not included. Browser Find searches mounted history text only; one very large expanded message can still be expensive. Existing reconnect-navigation and Skills focus-return issues remain tracked separately.

## 4.3.0-beta.10

- **Clean labels**: tool tabs and the Add tab menu show only Roadmap, Session, Agents, Files or Preferences. The project and conversation remain visible in the panel content.
- **Integrated lock**: the lock sits inside the tab surface with its own accessible button. Lock behavior is unchanged.
- **Simpler menu**: the Move to submenu is removed. Drag-and-drop movement remains available.

## 4.3.0-beta.9

- **Independent tool tabs**: open multiple Roadmap, Session, Agents, Files and Preferences panels, with up to sixteen tool panels alongside eight conversations. Each panel keeps its own selection, forms and dialogs.
- **Lock a target**: pin a tool to its conversation and project, or let it follow the active conversation. Locks survive reloads; data and permissions stay live. Missing targets remain unavailable instead of silently switching to another conversation.
- **Simpler layouts**: add and move tabs from the tab menu. The Layout dialog keeps the workspace switch, named layouts and reset. Named layouts store only panel types and geometry, not conversations, drafts or locks, and reuse parked panels without starting a run.
- **Reliable Preferences**: the main button opens a popup even from an inactive tab; Add tab opens a docked instance. Settings stay global while each panel owns its category, forms and child-dialog return focus. Late responses no longer overwrite newer confirmed values.
- **First-click links and images**: inactive primary and secondary conversations open their links and images on the first click. Modified clicks, keyboard activation, text selection and drafts remain intact.
- **Correct live context**: Session panels show Computer Use owner, action and stop shortcut from one shared status poller. Controls stay bound to the active conversation. Project overview search and mobile focus no longer jump back to the primary conversation.
- **Compatibility**: classic and mobile modes remain available. Closing a tab does not delete its contents or stop its run. Native floating windows are not included.

## 4.3.0-beta.8

- **Conversations are ready immediately**: the input and four welcome suggestions appear as soon as the pane opens, including after adding a project. Suggestions fill the owning pane and follow the selected language.
- **Create without replacing**: the New session button, Ctrl+N and project menu add a distinct tab in the dockable workspace. Existing conversations, drafts, attachments and reading positions stay intact; the eight-tab limit refuses an extra creation without overwriting a tab.
- **Consistent restore**: tabs and their project names return after reload. An empty conversation no longer inherits the state of another agent still waiting for a session ID.
- **Roadmap loading fixed**: equivalent Windows path spellings no longer cause valid responses to be discarded. Initial errors leave the loading state and offer Retry. Conversation or project switches during a request preserve the current document and drafts without showing a stale response.
- **Regression coverage**: creation, rapid tab switches, delayed responses, errors, translations and restore checks are part of the usual test commands. Classic and mobile modes remain available.

## 4.3.0-beta.7

- **Smoother resizing**: splitter weights no longer cause inherited style updates across the entire conversation. Virtual spacer heights never animate.
- **Dynamic history**: open the latest 80 messages first, then load earlier pages by scrolling up or using the load button. Only nearby message blocks are mounted; closed activity groups defer their heavy tool bodies.
- **Independent panes**: paging, streaming, reconnect replay and canonical response completion preserve the owning pane’s reading position, drafts and focus. History links can reveal older, unmounted messages.
- **Data stays complete**: saved histories, engine context, read receipts and full-history exports are not truncated. Existing unpaged API callers keep the complete response.
- **Known limits**: browser Find searches mounted text only. One very large expanded message or activity can still be expensive. Native floating windows and the pre-existing reconnect-navigation and Skills focus-return issues remain outside this change.

## 4.3.0-beta.6

- **Per-pane slash commands**: the `/` menu opens above the active input in both classic and dockable layouts. Insertion, resizing and draft restoration stay bound to the owning pane.
- **Skills inside messages**: insert several `/skill:name` tokens at different positions. Instructions expand in place, in order, without removing surrounding text. Paths, URLs, escapes and code blocks remain literal; native commands keep their existing behavior.
- **Consistent input**: aligned base height and text growth, equally sized send/stop buttons, and readable model and permission controls in narrow panes. Drafts and skill chips remain independent after reload.
- **Polish**: aligned footer hints, more readable model names, nonbreaking French punctuation and whole visible lines in filled inputs. The visual review covers isolated screenshots, not certification across all devices.
- **Known limits**: detached native windows are not included. Initial rendering of very long histories and the pre-existing reconnect-navigation and Skills focus-return issues remain tracked separately.

## 4.3.0-beta.5

- **Fewer unnecessary loads**: unopened conversations use the read/unread state already provided by the server, without downloading their full histories. The active conversation still receives new answers, including those added from another device.
- **Compressed histories**: large history API responses use gzip when the browser accepts it. All messages and tool results are preserved; access controls and no-store behavior are unchanged.
- **Tab closing**: the context menu now says only “Close”. Middle-click also closes a tab without deleting its conversation or draft or triggering autoscroll. The × button keeps its descriptive accessible label.
- **Measurements and limits**: in an isolated 13-conversation scenario, history loads drop from 14 to 1; a varied synthetic history shrinks from 198,598 to 33,493 bytes with gzip. These are not guaranteed end-to-end speed gains on a physical phone. Initial rendering of very long histories and the pre-existing reconnect-navigation and Skills focus-return issues remain tracked separately.

## 4.3.0-beta.4

- **Owner-targeted conversation rendering**: streaming no longer repaints transcripts in unrelated panes. Concurrent updates remain coalesced, without truncating messages or losing drafts.
- **Update recovery**: an already-current server with verified identity no longer requests an unnecessary restart. The recovery guide exposes the restart button and retains confirmation when agents are working.
- **Clearer states**: messages distinguish the Studio version, the engine version and a stopped server. An unavailable probe is no longer presented as pending activation; an old operation whose outcome was not confirmed after relaunch does not mean installation failed.
- **Windows startup**: an unreadable preference is shown as unknown in both the launcher and Preferences, rather than being replaced by “off”. Additional checks cover the stable app identity and installer protections for existing settings and shortcuts.
- **Known limits**: very large active transcripts still have a rendering cost to optimize. The Skills focus-return test also fails on beta.3 and remains tracked separately. Windows protections were inspected without running a real upgrade on the workstation.

## 4.3.0-beta.3

- **Smoother multi-conversation streaming**: coalesces live transcript updates instead of rendering immediately for every background event, and avoids painting hidden conversation panes. Dock drop previews only update when needed and pending previews are cancelled on drop or cancel.
- **Restored conversations**: all visible saved conversation panes load their history without requiring a focus click; background loading preserves the active conversation and drafts.
- **Roadmap loading**: invalidated requests are replaced without waiting for the polling tick, with bounded requests and stale-response guards preserved.
- **Single run indicator**: removes the duplicated working label above independent conversation composers while keeping loading and unavailable notices.

## 4.3.0-beta.2

- **Conversation history restored**: fixes a regression introduced in 4.3.0-beta.1 that could leave the transcript blank when a conversation contained tool calls. The messages were loaded, but rendering stopped with `Assignment to constant variable.`
- **Opening conversations from other projects**: the same fix applies when adding or dragging a conversation into the dockable workspace. No history migration or reset is required.
- **Regression coverage**: historical native tool calls and results are now exercised in classic, primary and additional conversation views, including same-project and cross-project openings.

## 4.3.0-beta.1

- **Dockable workspace**: enable it from **Layout** on desktop screens wider than 1080 px. Split, group, reorder and resize real panels without gaps. Classic and mobile layouts remain available.
- **Independent conversations**: display up to eight conversation panes, each with its own full composer, model, reasoning and Questions controls. Drafts, attachments and live output stay with their conversation; only the focused pane drives shared tools.
- **Precise tabs and navigation**: drag a conversation from the sidebar or insert a tab between its neighbors. **Add Tab** offers a project/conversation picker; the main **New conversation** button and **Ctrl+N** reuse the focused pane.
- **Close others**: keep the selected tab and park only its siblings in that group, without discarding drafts or attachments or stopping runs. Other groups stay intact.
- **Independent tools and Preferences**: Session, Agents, Files and Roadmap can be arranged separately. The Preferences button opens a modal popup by default; **Add Tab → Preferences** explicitly opens a docked tab. Both paths preserve the same live form and its child dialogs.
- **Named layouts and safe restore**: save and load panel geometry without embedding conversation content or session bindings. Closing, reopening, reloading and narrow-window transitions preserve per-view state. Tab icons use their panel type and owning project color.
- **Resize reliability**: minimum-width panels no longer leave an empty strip or cause a width jump. Pointer and keyboard resizing, cancellation and saved geometry remain consistent.

## 4.2.1-beta.3

- **Mobile header and composer**: grouped header actions fit at 320 and 390 px, the full running-state placeholder stays visible, and compact permission labels retain their full accessible names. Desktop layout and the full-screen mobile details panel are preserved.
- **Roadmap completion provenance**: each newly completed step records the Studio machine ID, the associated conversation (when available), and the completion time. The details can be opened below the step without starting an agent.
- **Preserved history**: repeated checks and unrelated edits keep the original attribution; reopening a step clears it. Synchronization and `.pastudio` export/import retain the source without attributing it to the receiving Studio. Historical checks are not retroactively filled in.
- **API and OpenAPI**: read-only `completion` metadata is documented and returned for Roadmap steps. `step.check` accepts an optional `sessionId` checked against the selected project; native agents use their verified current conversation, including child conversations.

## 4.2.1-beta.2

- **Public API v1 for external integrations**: project-scoped Bearer tokens, projects and conversations, run control, resumable SSE, Roadmap reads and writes, and linked file downloads. The API is disabled by default and managed locally in **Preferences → API**.
- **Interactive OpenAPI documentation**: open `/api-docs` from Preferences for a manual test of each of the 18 operations, with JSON, cURL, status, headers and response. Tokens stay in page memory; POST tests require confirmation; stream and file previews are bounded and cancellable.
- **Scoped access and safe retries**: separate run, Roadmap and file permissions, token expiry and revocation, one-hour in-memory request deduplication, revision conflicts, and permission rechecks before delayed actions.
- **File streaming and resume**: HEAD, byte ranges and file validators, with per-reference local provenance checks to avoid substituting files from another PC.
- **Remote boundaries preserved**: API tokens do not unlock internal routes or remote token management. Remote API calls require Tailscale or HTTPS; plain LAN HTTP and cross-origin browser access are not enabled.
- **Documentation and validation**: FR/EN guides, a generated OpenAPI contract, and browser checks for all operations. Run access can execute code and incur provider costs; linked files may be outside the project folder. Disabling the API does not stop agents already running.

## 4.2.1-beta.1

Maintenance beta based on 4.2.0. No new user-facing feature or API change.

- **Less duplicate code**: Computer Use integration tests now use the production caller resolver; JSONC parsing, desktop polling and Rust updater helpers reuse their existing implementations.
- **Standard CRC32**: archive and image fixtures use Node.js CRC32 instead of maintaining separate copies. A regression test covers stored and compressed archives and rejects damaged payloads.
- **Frontend cleanup**: removed unused sync-status code, an unused import and an unused translation export.
- **Simpler maintenance**: UI tests keep the same browser overrides and fallbacks with less setup code. One release workflow now handles both new builds and draft rebuilds.

## 4.2.0

Stable release. Includes every 4.1.5 beta below, plus:

- **Full control from your phone**: a remote device in full-control mode can now do everything the PC can do (providers and keys, models, sync, `.pastudio` archives, worktrees, remote access settings). Consultation mode stays read-only. Folder pickers and Explorer still open on the PC screen.
- **Commit message suggestion**: "Propose a message" in the Git panel writes a conventional commit message from the checked files, in the language of your recent commits. It uses the auxiliary model if set, otherwise the default model; credentials stay in a separate process.
- **Roadmap conflict warning**: when a Roadmap cannot be merged, the sync panel shows which project and where the other PC's copy was kept, and the sync status turns amber.
- **Conversation origin marker**: the PC icon now shows the PC that wrote the last message, not a PC that only re-published read state.
- **Fixes**: reasoning preview stays visible on finished answers; the composer bar fits at 320 px; Providers is available on phones.
- **Reliability**: UI tests pick an installed browser automatically, flaky UI and Rust updater tests are fixed.

## 4.1.5-beta.15

- **No wasted turns after an answer**: when a subagent ends after already replying to a busy parent, its end notice is kept as context for the next message instead of starting one extra model call per subagent after the answer. An idle parent, or a subagent that never replied, still wakes the parent.

## 4.1.5-beta.14

- **Web search key**: the Serper key used by the agent's web search can be set in Preferences → Models and agents → Providers (search "web"). It is saved in the same place as the CLI `/login`.
- **Quieter end of answers**: subagent end notices (completed, no reply, cancelled) now join the agent activity group instead of showing one "Context" card each after the answer.

## 4.1.5-beta.13

- **Update path**: same code as 4.1.5-beta.12, published under a new number so installations that ran a local 4.1.5-beta.12 test build receive the update.

## 4.1.5-beta.12

- **Plan colors in the plan menu**: the plan menu ("···" or right-click) shows the plan color swatches; one click applies a color.
- **Faster Roadmap sync**: Roadmap edits are sent 2 seconds after the change, and an open Roadmap fetches other PCs' changes at most once a minute.
- **PC color**: choosing this PC's color in Preferences → Sync works again (it was rejected as an invalid configuration).

## 4.1.5-beta.11

- **Roadmap sync**: the Roadmap of each synced project syncs between PCs with a three-way merge against the last synced version; one-sided edits win, both-sided edits keep the newest, deletions and additions are preserved. An unusable remote copy is saved, never lost.
- **Timestamped backlog**: backlog entries get a stable id and timestamps; if two PCs create the same number offline, the older entry keeps it.
- **Colors**: separate palettes for projects, Roadmap plans and PCs. Plan colors, project colors and the color of each PC sync between PCs.
- **Origin marker**: conversations last run on another PC show a monitor icon in that PC's color, in the sidebar and the header.
- **Roadmap context menu**: right-clicking a plan, milestone or backlog row opens the same menu as "···".

## 4.1.5-beta.10

- **Machines in the PWA**: a new Machines screen lists the PCs that run Studio. Add a PC by scanning the QR code from its Preferences → Remote access, from a photo of that code, or by entering its address. Rename, change or remove a machine; the list stays on the phone.
- **Opens on the list**: once another machine is saved, the PWA opens on this list. The list also opens when the PC does not answer, and the reconnection screen offers "Open another machine".
- **One access per PC**: each PC keeps its own gateway, access code and sessions. A PC updated to this version keeps your session when you open it from the list.

## 4.1.5-beta.9

- **Git in the Files tab**: branch selector with search (local and remote branches, new branch), ahead/behind counts, Fetch, Pull (fast-forward only) and Push (never forced, sets the upstream for new branches).
- **Commit from Studio**: choose files with checkboxes, write a multi-line message, then commit (Ctrl+Enter). Repository hooks run on commit and push; a refused commit leaves the index as it was.
- **Safety**: switching branch never overwrites local changes; switch and pull are blocked while an agent works in the project. Available remotely in full-control mode.

## 4.1.5-beta.8

- **Clearer subagent wait**: when a turn ends while subagents are still working, the activity indicator shows "Waiting for subagents" instead of "Turn ended". It switches to "Turn ended" once the last subagent finishes.

## 4.1.5-beta.7

- **Align Git** is now a primary button in the session panel.
- **Launcher**: the startup screen shows the required Prime Agent 0.9.8 instead of 0.9.7.
- **Leaner codebase**: duplicated helpers removed with no behavior change; 16 previously unwired UI and native tests now run through `npm run test:*`.

## 4.1.5-beta.6

- **Read state syncs between PCs**: a conversation read on one PC is no longer unread on the other; "Mark as unread" syncs too. The newest action wins.
- **Git context in the session panel**: branch and commit recorded by the conversation, compared with this PC.
- **Align Git**: puts the project on the conversation's branch and commit (fetch, switch, fast-forward only). Refused on uncommitted changes, divergence or an unpushed commit; nothing is overwritten.
- **Clearer sync status**: a running conversation is no longer counted as "to send", and "Sync now" always reports its result.

## 4.1.5-beta.5

- **Stable project identity across PCs**: a synced project is recognized by its Git repository, then by its name, or by an explicit link, even when renamed.
- **Synced projects list**: see which projects other PCs sync, how each one is linked, and add a missing one by choosing its local folder.
- **Link choice** when adding a folder, and "Link sync…" in the project menu.

## 4.1.5-beta.4

- **Sync panel**: status and "Sync now" at the top; configuration folded below; "Forget" is a red button with an in-app confirmation.
- **Accurate pending count**: conversations already sent by an earlier beta no longer show as "to send".
- **Faster status updates**: the footer opens the Sync tab directly, and the sidebar redraws only when a badge changes.
- **Session panel**: the quota sits right under the session and refreshes automatically every 5 minutes; the terminal note is removed.

## 4.1.5-beta.3

- **Sync status everywhere**: a permanent status under the engine status (synced, uploading with progress, changes to send, error), a sync glyph on synced project folders, and a per-conversation state in the header.
- **Check on open**: opening a conversation quickly fetches its latest version from R2, keeping your draft. Finished turns are sent right away.
- **Pinned, title and archive state** now sync between PCs; the newest change wins.
- **Safer reconnection**: forgetting and reconnecting the same bucket no longer re-uploads everything.

## 4.1.5-beta.2

- **Conversation sync (beta)**: sync conversations between PCs through your own Cloudflare R2 bucket, encrypted before upload. Only new messages are sent and images are stored once. No machine needs to stay online.
- **Per-project sync**: enabled by default, can be turned off when adding a folder or from the project menu.
- **Alt wheel**: titles stay inside sectors, the conversation title sits above the project name, and sectors get a subtle tint while running or unread.

## 4.1.4

- **Prime Agent 0.9.8**: update native model discovery and refresh the native model picker on every open. Studio retains its newer Codex client identity for GPT-6.1 Sol.

- **GPT-6.1 Sol**: add the model to OpenAI API and eligible Codex accounts, with always-on reasoning, its API cache pricing, and the current official Codex client identity. Existing defaults and account access checks are preserved.

- **Prime Agent 0.9.7**: update the managed engine for more efficient large Python output handling, more accurate native session activity, and upstream Azure Responses and Vertex Gemma 4 fixes.
- **Reliable subagent handoff**: parents receive one native end-of-run notice even after a child has sent progress updates. The notice reports that execution ended, not that the task succeeded.
- **Ordered child messages**: admit the initial task before delivering early agent messages, including broadcasts and sibling messages. Startup errors, cancellation and deletion still unblock waiting senders.
- **Safe engine migration**: prepare a new managed engine and Python generation while retaining the previous files. No active kernel is modified in place.
- **Accurate native component checks**: read-only diagnostics no longer cancel themselves when their input is closed, avoiding false errors for valid engine and uv paths.
- **Restart confirmation after maintenance**: completed operations no longer block restart confirmation while agents are running. Protections for operations still in progress are preserved.

## 4.1.4-beta.2

- **GPT-6.1 Sol**: add the model to OpenAI API and eligible Codex accounts, with always-on reasoning, its API cache pricing, and the current official Codex client identity. Existing defaults and account access checks are preserved.

## 4.1.4-beta.1

- **Prime Agent 0.9.7**: update the managed engine for more efficient large Python output handling, more accurate native session activity, and upstream Azure Responses and Vertex Gemma 4 fixes.
- **Reliable subagent handoff**: parents receive one native end-of-run notice even after a child has sent progress updates. The notice reports that execution ended, not that the task succeeded.
- **Ordered child messages**: admit the initial task before delivering early agent messages, including broadcasts and sibling messages. Startup errors, cancellation and deletion still unblock waiting senders.
- **Safe engine migration**: prepare a new managed engine and Python generation while retaining the previous files. No active kernel is modified in place.
- **Accurate native component checks**: read-only diagnostics no longer cancel themselves when their input is closed, avoiding false errors for valid engine and uv paths.
- **Restart confirmation after maintenance**: completed operations no longer block restart confirmation while agents are running. Protections for operations still in progress are preserved.

## 4.1.3

- **Subagent deletion no longer ends the parent wait**: a child’s cancelled completion wait stays local to that child. The parent continues waiting for remaining delegated work instead of closing the session. Explicit parent cancellation and other errors still propagate.

- **Compact context notices**: routine goal reminders join Agent activity, compaction and branch summaries are collapsed by default, and completed activity cards take less space. Budget alerts, objective changes and unknown notices stay visible. Full details remain available; native history and model context are unchanged.

- **Windows notification clicks**: while Studio is running, clicking a notification focuses the app and opens its conversation across projects, with drafts preserved. This does not relaunch a fully quit app.
- **Mark as unread**: the conversation menu updates the shared read state used by the sidebar and Alt switcher. Marking the open conversation returns to its project overview and keeps its draft.
- **Vivid project colors**: existing pastel assignments use the matching vivid color. Project pins and idle pinned conversations share that tint; activity indicators keep their priority.
- **Clearer preferences**: Computer Use has a short explanation, providers appear before models, and installed application / running server versions are visible without expanding technical details. In-app notifications appear above the preferences blur.

- **Quick conversation switcher**: hold **Alt** to open an animated radial menu above the workspace. It shows the six most recently updated, non-archived conversations across projects, sorted by title. Each segment includes the project name in bold and its assigned color.
- Move onto a segment or press **1–6 on the numpad**, then release **Alt** to open it. Return to the center or press **Escape** to cancel. Drafts are preserved; reduced-motion preferences are respected.
- **Live activity indicators**: the radial menu reuses the sidebar badges for running agents, unread responses and pending questions. They update while the menu stays open.

## 4.1.2 (included in 4.1.3)

- **Harness review in Project knowledge**: new **Prompts**, **Skills** and **Subagents** filters show every native harness entry the agent receives. **Global** shows only cross-project entries.
- **Claude quota**: sessions using a linked Claude subscription (OAuth) show the 5-hour and weekly quota, like Codex. When the main agent and subagents use different subscriptions, both quotas are shown. Manual refresh only; also in Providers.
- **Lighter agent context**: long lists of restored Python variable names are replaced by a count in requests sent to the model. The session file keeps the full list. Measured on a long session: about 816,000 characters of these notices down to 8,000.
- **Steadier quota panel**: the Codex quota no longer disappears for a moment about once a minute.
- **Roll back this refinement** and **Correct** prefill a native `/refine` command in the owning conversation. Nothing runs until you send it; Studio never writes the harness itself. Hidden in read-only remote access.

## 4.1.1

- **Conversation**: agent messages and technical notifications grouped inside Agent activity without changing history. Replies and interactions remain accessible; completed reasoning previews are hidden.

- **Maintenance**: remove unused kernel, Computer Use bridge and components UI helpers; share component-bridge detection and restart confirmation without changing authorization or cancellation rules.
- **Shared implementations**: reuse provider JSONC override detection, PowerShell launch setup and the existing Rust atomic writer while preserving validation and error handling.
- **Image safety tests**: remove obsolete image filters and test the active context normalizer directly. Computer Use screenshot limits and input history remain unchanged.
- **Regression coverage**: strengthen restart cancellation and atomic-write failure cleanup checks. No new dependencies.

## 4.1.0 (pre-release)

- **Prime Agent 0.9.6**: pinned engine preparation with a separate managed Python environment. Runtime checks require the new generic MCP discovery methods. The upstream background-command fix is recognized without rewriting its native implementation.
- **Native model settings**: the shared model picker now exposes `imageModel` for image turns on text-only models. Auxiliary-model guidance covers refinement, compaction and branch summaries. The default service tier offers Standard, Flex, Priority and Auto without changing active sessions. Routed image turns preserve the configured conversation model on later resume, with append-only native metadata.
- **MCP OAuth compatibility**: confidential dynamic registration retains the client identity for code exchange and refresh. Advanced options support a client ID, a secret environment variable name, metadata URL and scopes. Custom servers and the existing Linear/Notion cards remain supported.
- **Anthropic subscription warning**: explicit acknowledgment of the Claude Code identity and possible account restrictions before subscription login. API-key entry stays separate.
- **Startup and Roadmap reliability**: isolated child processes no longer inherit an older Studio installation’s loaders. Brief Windows file-access refusals during Roadmap saves are retried without dropping path checks or hiding persistent errors.
- **Preserved behavior**: no new delegated screenshot-analysis agent, no automatic installation or restart, and no change to Computer Use authorization or Stop controls. Upstream speed and cost changes are not Studio benchmark results.

## 3.8.1

- **Muse Code subscription login (experimental)**: separate `muse-code` provider using browser device-code login, with no API key and no CLI install. Requires an active subscription and fails closed with no fallback to paid usage.
- **Explicit consent before login**: the Connect flow shows the experimental warning and requires the confirmation checkbox before any login request is sent. The checkbox stays compact and aligned with the first text line on desktop and narrow layouts.
- **No silent billing switch**: while an engine fallback model is set, a Muse session refuses to start instead of switching billing on quota or outage. Clear the engine fallback to run Muse. This guard covers Studio session starts.
- **Provider docs and coverage**: updated provider guides in English and French, with unit and UI coverage for the gated provider.

## 3.8.0

- **One desktop window**: Preferences, updates and recovery now share the main window, including when the server is stopped or still uses an older interface.
- **Clear update controls**: check for updates, update Studio, repair missing components and restart the server have distinct actions. Repair does not restart the server implicitly.
- **Real progress and cancellation**: operation stages, received bytes, known totals, elapsed time and errors remain available when the panel is reopened. Interrupted operations no longer leave the interface permanently busy.
- **Explicit server restart**: confirm the interruption of active agents and cancellable work. Restart waits for cancellation to finish, verifies the server identity and refuses to stop unrelated processes. Installer handoff cannot be cancelled.
- **Quit stops the server**: Quit application from the system tray stops the verified Studio server before closing. Closing the window with X still hides it and leaves agents running.
- **Meta Model API**: connect Muse Spark with an API key, without the Muse Code CLI. Custom provider settings are preserved. The Contributor model displays a warning that prompts and responses may be used for training; access and billing remain managed by Meta.
- **French and English interface**: clearer confirmations, recovery messages and responsive update panels on desktop and mobile. Projects, accounts and conversation history are preserved.

## 3.7.1

- **Continuation after tools**: backport Prime Agent upstream fix #2372 into new Studio-managed Python environments. Consuming a `bash()` result withdraws its notification before the cell ends, to prevent interrupted continuation. Dedicated fingerprint, compatibility checks and protocol validation before use. In-use environments and external Python installations are not modified.
- **Clearer activity**: a turn ending without session completion shows a waiting state distinct from generation. New activity reactivates the indicator. No implied success or early closure of sessions, subagents or background tasks.
- **Safe rollout**: engine remains on 0.9.5. Active sessions keep their current environment; the Python fix applies to new kernels after this Studio version is activated. This fix does not address the Codex `Previous response not found` error.

## 3.7.0

- **Engine migration to Prime Agent 0.9.5**: pinned policy (npm 10.9.4 and uv 0.8.22 unchanged), one-time explanation for users coming from a version < 3.7.0. After updating the application, prepare then activate 0.9.5 from **Preferences → Updates**; downloading requires your consent, and activation can restart the managed server only when agents are idle. Accounts and sessions are preserved. Native recovery retained for stopped or older servers.
- **Update flow**: components integrated into Preferences, separate prepare then activate steps with retry without downloading again, serialized operations and no automatic interruption of active agents. Explicitly validated external installations can reactivate without fabricated download receipts.
- **Unified advanced models**: shared picker with search, providers and the engine default choice, without changing the conversation model. Refinement, fallback and native subagent settings with default autonomous budgets, never enabled implicitly.
- **Conversation and tracking**: 0.9.5 and legacy inter-agent messages, subagent progress and last activity, provider waiting, fallback and restoration states. Ordered live relay with an explicit memory limit and no history replay. Mirrored user message heading — time on the left, "You" with avatar on the right.
- **Explicit authentication**: environment then native storage, with no silent import of CLI accounts. Grok OAuth and API-key flows preserved.

## 3.7.0-beta.2

- Components integrated into Preferences, required-engine notice and guidance after application updates. Native recovery retained for stopped or older servers.
- Preparation and activation separated; validated components preserved, explicit logged activation failures and retry without downloading again.
- Component preparation, application updates and restarts serialized; no automatic interruption of active agents.
- Explicitly validated external installations can activate without fabricated download receipts; managed installation checks remain intact.
- Advanced models use the shared picker with search, providers and the engine default choice, without changing the conversation model.
- One-time migration explanation for users coming from a version < 3.7.0: FR/EN notice, prepare then activate 0.9.5, no automatic install or restart, accounts and sessions preserved.
- Conversation: mirrored user message heading — time on the left, “You” with avatar on the right, above the card.

## 3.7.0-beta.1

- **Guided packaging**: policy pinned to Prime Agent **0.9.5** (npm 10.9.4 and uv 0.8.22 unchanged), with the three `@earendil-works` dependencies checked against the same official inventory.

- **Live relay**: worker events stay ordered when the internal buffer fills, with an explicit memory limit and no history replay.
- **Native runtime**: Python `rlm.spawn(..., name=...)`, `rlm.progress_note(...)` notes and the engine’s direct Node entrypoint preserve hooks and supervisor identity.
- **Advanced settings**: refinement, fallback and native subagent models; default autonomous budgets. No fallback or autonomous mode enabled implicitly. Backups, native locking and concurrent-change detection are preserved.
- **Authentication**: environment then native storage, with no silent import of CLI accounts. Grok OAuth and API-key flows are preserved.
- **Conversation and tracking**: 0.9.5 and legacy inter-agent messages, subagent progress and last activity, provider waiting, fallback and restoration states.

## 3.6.1

- **Windows release**: bounded retries clean up the restart test’s temporary files after process shutdown.

## 3.6.0

- **Read while streaming**: scrolling up detaches automatic following. Return to the bottom or use the return button to resume following without interrupting the response.
- **Progress per plan**: a discreet percentage complements task counts. Completed checkboxes are green; partially completed groups retain their existing color.
- **Remaining only**: a reversible filter hides completed tasks in plans and backlog without changing data or percentages. Parents, notes and plans remain accessible.
- **Last-minute instructions**: an optional additional-instructions field is sent to a new conversation or the active conversation queue. Revision conflicts preserve the entered text.
- **Validation**: unit tests and isolated browser tests, with simulated streaming and roadmap checks on desktop and small screens.

## 3.5.0

- **Faster opening path**: connecting screen in the main window, immediate reuse of a running server and lightweight component checks on cold startup. Full diagnostics show their phases and remain available on demand.
- **Stable conversation order**: new messages no longer reorder conversations. Pinned conversations stay first; reorder within a project using the menu, keyboard or drag and drop. New conversations appear at the top of their group.
- **Quieter imports**: imported conversations start as read; the imported badge disappears on first open or after three minutes, without a yellow banner. Keep the historical model when usable, otherwise use the configured destination default; manual selection is needed only when no usable model is available.
- **Validation**: code reviews, native compilation and isolated checks. Full live startup timing and the complete touch interaction remain unverified; no test suite rerun for this release.

## 3.4.1

- **.pastudio export fixes (transferable file, operation on the PC itself)**: transferable file importable on another PC; export and import from Studio opened on that PC, not from a remote browser (LAN/Tailscale/PWA). Selective ZIP DEFLATE compression (level 6, only when smaller, otherwise stored, sequential with stored fallback); export fork tolerance — canonical id is `header.id`, filename stays the physical path, only duplicate canonical ids from different physical files are rejected; original error code preserved with bounded generic detail.
- **Unchanged limits and compatibility**: compressed archive capped at 128 MiB matched on server and UI, 256 MiB total uncompressed and 128 MiB per entry unchanged, one operation at a time. The 128 MiB limit remains, not unlimited. An archive over 64 MiB exported in 3.4.1 cannot be imported in 3.4.0: update both instances.
- **Unchanged content**: project files, settings, provider keys, memories and engine never included; no streaming — export stays in-memory, sequential.
- **Honest validation**: independent review approved plus export/decode round-trip on real projects with identical per-file hash (Vtrott 178 MB → 88 MB, PrimeAgentGUI 75 MB → 30 MB); real import and live resume not claimed.
- **After installation**: restart the server from preferences once your agents have finished.

## 3.4.0

- **.pastudio archives v1 (local-only)**: export a full project then import it into another existing project, on this device only. Transferred content: complete conversations with subagents plus the project Roadmap. Project files, settings, provider keys, memories and the engine are never included.
- **Additive import without overwrite**: existing sessions and Roadmap are kept; local vision stays unchanged (source vision as a backlog note). Reimporting the same archive is detected and skipped by digest; if the source changed, new copies are created into the new folder, never merged.
- **Explicit resume**: history stays readable, but the next run of an imported session requires an explicitly chosen available model; no historical model is reapplied.
- **Secrets and recovery**: histories may contain secrets — review before sharing a file. An interrupted import stays pending and retries without duplication.
- **Validation limits**: source review ACCEPT and isolated fixtures passed; physical two-PC validation and live resume not claimed.
- **After installation**: restart the server from preferences once your agents have finished.

## 3.3.3

- **Hardened components**: fixed download hosts with no inherited `NODE_OPTIONS`, verified-receipt resume, external engines never executed without explicit selection, launcher state preserved after cancellation, catalog warning shown after interruption.
- **Secure signing**: workflows never sign an uploaded installer; they always rebuild the installer from the tag before signing.

## 3.3.2

- **Compact components**: status and versions fit on one or two lines. The Details button reveals paths, download sources and advanced options; this area is collapsed by default.
- **Contextual actions**: the installation button disappears once everything is ready. Progress and errors remain visible.

## 3.3.1

- **Guided setup fixed**: Prime Agent dependencies install from the engine directory regardless of where Studio was launched. Fixes preparation failures in the installed Windows application. Previously validated components are reused.
- **Validation**: complete installation tested with bundled Node from a directory without `package.json`, matching the installed application.

## 3.3.0

- **Guided setup**: prepare Prime Agent, uv and Python on first launch or from settings after an explicit click. Reuse compatible installations, track progress, cancel and retry failed setup.
- **Engine compatibility**: Studio 3.3.0 targets Prime Agent 0.9.4. A future Studio version may request an engine upgrade; no automatic background downloads.
- **Visible roadmap**: a full button in the top bar shows project completion, refreshed even when the panel is closed.
- **Clearer configuration**: a warning appears when no provider is configured or no model is selected; sub-agent thinking selectors have consistent alignment and color.
- **After installation**: restart the server from preferences once your agents have finished.

## 3.2.7

- **Optional passkey sign-in**: register a passkey from Preferences → Remote access on the mobile Tailscale HTTPS address. Confirm with your device biometrics or unlock PIN; the Studio access code remains available. Manage and revoke keys from the PC. Changing the Studio access code invalidates existing keys.
- **Compact tablet layout**: reduced top bar height, removed the redundant location label below the composer and the incorrect version in the session panel.
- **Pending questions**: an amber question mark beside Workspace opens a conversation awaiting your answer.
- **Roadmap activity**: current activity text and indicator pulse blue, respecting reduced-motion settings.
- **After installation**: restart the Studio server from Preferences → Updates once your agents have finished.

## 3.2.6

- **Mobile updates**: a permanent button checks again and bypasses the cache. The button becomes available again after an error or timeout; installation request errors are visible in the mobile panel.
- **Questions in the conversation**: interactive questions and their answers stay beside their tool call while subsequent messages stream below, instead of remaining at the bottom until the turn ends.
- **After installation**: restart the server from preferences once your agents have finished.

## 3.2.5

- **Interactive questions**: native requests remain delivered during engine resynchronization or stream backpressure instead of being discarded with display events.
- **Notification sound**: system sound enabled on Windows; PWA notifications are not silent, subject to phone settings. Existing Windows focus rules and preferences are preserved.
- **Applying the fix**: after installing, restart the Studio server once your agents have finished.

## 3.2.4

- **Quota and context over authenticated remote access**: Codex quota and session context stay available from authenticated mobile access through limited, sanitized endpoints. Manual refresh only, linked Codex account (OAuth) required; context shows an honest state when measurement is unavailable.
- **Optional per-device mobile PWA push**: **Preferences → Notifications → Mobile notifications** enables **Questions** and **Turn ends** alerts on this device, even with the PWA closed. Per-device VAPID Web Push subscription, generic text only, off by default. Requirements: PWA installed from the Tailscale HTTPS address, notifications allowed, PC on with active server, Tailscale connected on both sides. On iPhone/iPad: iOS 16.4+, Safari, Share → Add to Home Screen, then open from the icon. [PWA guide](pwa.md).
- **Remote update through the PC**: from remote access, **Preferences → Updates** shows the published version and can request installation on the PC. The PC downloads, verifies the signature, then installs through its signed native updater; the request is refused while agents are active or when access is read-only. Release notes render as sanitized markdown.
- **Validation limits**: no physical-device push or real remote update end-to-end validated.

## 3.2.3

- **Conversation activity in the Roadmap**: each item shows **In progress · …**, with a **+N** control to expand other conversations. Activity also appears under each task and opens its conversation.
- **Subagent thinking field**: label and dropdown stay aligned and full width with the model picker, without overlap.
- **Optional Codex quota**: for OpenAI/Codex models, a block with short and weekly bars and a **Refresh quota** button. Manual checks only, linked Codex account (OAuth) required; API-key models show a note without quota. Unavailable from remote access.
- **Prime Agent context**: the session shows **X / Y tokens (Z%)** with a bar, from the native current context, never the cumulative total. Hidden when unavailable.

## 3.2.2

- **Windows notifications restored**: fixed an initialization crash that prevented monitoring for questions and completed turns from starting. Notification preferences and silence while Studio has focus are preserved.
- **Visible pending questions**: an amber **?** replaces the green activity dot in the conversation list and on its project, including when collapsed. The project view also shows **Question awaiting an answer**.
- **Drafts after sending**: accepted text is cleared even if you switch conversations before sending finishes, including messages sent to an already active agent. A newer draft typed in the meantime is preserved; a failed send does not clear it.

## 3.2.1

- **Questions allowed by default**: choose the initial value in **Preferences → Models & agents**. The default is shared by devices connected to the PC, while each conversation keeps its saved choice.
- **Windows notifications**: independent switches for pending questions and completed turns in **Preferences → Notifications**. Errors follow the completed-turn setting; manual stops stay silent.
- **Quiet in the foreground**: no notification while any Studio window has focus. Silent events are not replayed when focus changes. Monitoring continues while the window is hidden, as long as the application remains open.
- **Choices preserved**: a delayed response cannot replace an acknowledged default. [Configuration guide](configuration.md#windows-notifications).

## 3.2.0

- **Images in agent responses**: display project images inline and click to enlarge. Studio reads the original file without storing an extra copy; moved or deleted images show an unavailable state. Available on desktop and through authenticated mobile access.
- **Native interactive questions**: enable **Allow questions** per conversation. Select a suggested answer, write your own, or skip. Questions use Prime Agent’s native request/reply mechanism, resume the waiting agent and synchronize across connected devices.
- **Details when you need them**: each choice has a short description, collapsed by default. The **Skip** button has a discreet outline. Image loading and incoming questions preserve your reading position.
- **Illustrated documentation**: French and English README captures show both features in a fictional Lotus Elise conversation. [Configuration guide](configuration.md#interactive-questions-and-conversation-images).

## 3.1.4

- **Collapse or expand all nested tasks** from inside each Roadmap plan. The plan stays open, with its main tasks and completion counts visible.
- **Model and thinking choices per conversation**: selections are saved with the conversation and restored on reload or another device. Delayed history responses cannot undo a confirmed change.
- **Change thinking while the agent works**: the new level applies to subsequent model calls without interrupting the current tool or changing global defaults. Model selection remains available between runs. [Configuration guide](configuration.md).

## 3.1.3

- **Reliable Windows folder selection**: the native picker is attached to the Tauri window. Selecting or cancelling allows another attempt; closing the browser form cancels its pending selection and preserves newly entered fields.
- **Open the project folder** directly from the workspace’s **Files** tab, beside **Refresh**. Remote access clearly identifies the host PC; read-only access cannot open folders.

## 3.1.2

- **Expanded Roadmap**: open a view across the workspace, then return to the side panel using the reduce button or Escape.
- **Compact lists**: collapse categories and parent tasks while keeping their completed/total count at the end of the row. Descriptions are hidden by default and open with **Show description**.
- **Reading state preserved**: collapsed items stay in place during refreshes. Controls work with keyboards and phones. [Roadmap guide](roadmap.md).

## 3.1.1

- **MCP tests in the Windows app** now find Python in the persistent application data folder, including after an update. If Python has not been prepared yet, Studio sets it up automatically before discovering tools. [MCP guide](mcp.md).

## 3.1.0

- **Project Roadmap**: organize milestones, plans, nested checklists and a backlog in a shared panel on desktop and phone.
- **From planning to conversation**: choose **Work on this** to start or continue work with Prime Agent. Follow declared agent activity and return to the linked conversation, including subagent history.
- **Native agent tools**: six tools use the same project document as the interface. Revision checks protect concurrent edits, and drafts remain recoverable after a conflict. Opening the panel starts no model call.
- **Project knowledge within reach**: consult native memories and refinements from the panel, or export the Roadmap as Markdown. [Roadmap guide](roadmap.md).

## 3.0.1

- **Native Prime Agent 0.9.4 catalog**: Studio uses the installed engine’s available model registry, including thinking levels. Refresh the catalog directly from the model picker.
- **OpenRouter availability**: models removed from the public catalog are marked unavailable. A discontinued free variant remains distinct from its paid equivalent; Studio never switches automatically. Custom endpoint connections are preserved.
- **Choices preserved**: refreshing keeps the selection, favorites, search and draft. If the network fails, the catalog remains readable and can be retried. [Provider guide](providers.md).

## 3.0.0

- **Projects and conversations together**: conversations appear beneath collapsible projects in one sidebar, with pinned projects first and **Show more** for older sessions. Search, archives, unread indicators and project reordering remain within reach. Collapsing a project keeps the active conversation and its draft open. On phones, tapping a project name expands or collapses it while keeping the sidebar open; selecting a conversation closes it. Conversation actions also open with a right-click on desktop. [Navigation guide](navigation.md).
- **Project knowledge**: find past work from **Session** in the right panel, the project overview or its **⋯** menu. Search text, filter results and read the exact native source, with a link to the original conversation when available. Browsing also works on phones and through authenticated read-only access. [Knowledge guide](knowledge.md).
- **Native memories and refinements**: read session memories and recorded before/after changes. Global records are labelled **Global** and remain shared across projects by Prime Agent. Browsing leaves the native records unchanged.
- **History tools for agents**: new Studio runs and their subagents can search and read relevant project sources on demand. Text search needs no model call, and a local cache avoids rereading unchanged conversations. The full history is not automatically added to the agent’s context.

## 2.9

- **2.9.3 updates from Preferences**: **Preferences → Updates** shows application and server versions, release notes and signed installation. Optionally restart the server afterward; active agents require confirmation. The tray’s app settings retain these controls when an older server is still running.
- **2.9.3 Windows fixes**: web links and Codex sign-in open in the default browser; files and images can be dropped into the conversation. Completed empty responses are hidden without changing the native history.
- **2.9.2 version fix**: system settings and health checks read the version from the server’s packaged metadata. Version 2.9.0 incorrectly displayed 2.8.1 even when its new server was running. An older server that is still active continues to report its own version until restarted.
- **Agent messages**: compact, collapsed previews with the sender’s name. Click to read the full message and delivery details. Automatic queued messages are clearly identified and protected from editing or removal.
- **Project order**: drag projects directly in the sidebar with a mouse, or use the handle on touchscreens. The order is saved across devices.
- **Shared unread state**: reading a response on desktop clears its indicator on the phone and vice versa, including read-only remote access.
- **Long Codex sessions**: renew aging idle WebSocket connections between requests and clear transient failure states after a successful native retry. Active requests are preserved.
- **Restrained presentation**: readable text and discreet labels, without colored side borders. Desktop/mobile, French/English and light/dark rendering reviewed.

## 2.8

- **2.8.1 packaging fix**: the Windows installer now includes the workers used by messages, skills, providers and MCP, plus the folder/file helpers. Updating also restores the missing files in the original 2.8.0 server cache without restarting its agents.
- **Tauri 2 Windows application**: per-user installer, desktop and Start menu shortcuts, bundled Node.js and a crisp icon sized for Windows displays.
- **Background work**: the shortcut starts the server or reuses the active instance. Closing or quitting the application lets agents keep working. Start with Windows is optional and disabled by default.
- **Migration and remote access**: reuse projects and settings from an existing installation. LAN, Tailscale, HTTPS, QR codes and the mobile PWA remain available.

[Installation, migration and updates](desktop.md).

## 2.6

- **Project folder**: **Choose folder** in the add-project dialog opens the Windows picker and fills in the path. Your project name is preserved; cancelling leaves the form unchanged.
- **Skills and prompts**: both tabs in **Commands and skills** offer **Global · All projects** or **Selected project**, followed by **Open folder**. A missing folder is created on demand.
- **Desktop and remote access**: the Windows picker is available in local Studio. Resource folders can also be opened from a remote connection with full control, on the host PC.
- **Bilingual documentation**: the README and guides are available in French and English.

## 2.5

- **French and English**: choose **Automatic / Français / English** in preferences or on the mobile sign-in page, with browser language detection.
- **Instant switching**: conversations, drafts, attachments and forms keep their contents, and running responses continue. Tabs at the same address share the language choice.
- **One table**: 1,051 messages keep their translations side by side. Parameters, plurals and references are checked automatically; missing or empty translations fall back to French.
- **Mobile and PWA**: sign-in, errors, sign-out, installation information and the offline screen follow the selected language.
- **More languages can be added**: the [translation guide](translations.md) explains how to extend the table and check the interface.
