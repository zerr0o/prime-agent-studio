# Prime Agent Studio 4.0.1

Windows x64 prerelease. This release consolidates all changes since stable **3.8.1**, including the published previews through **3.10.0-beta.4**, the locally prepared **beta.5 through beta.8**, and the latest workspace improvements.

**Download this preview manually from the assets below.** The current in-app beta updater does not discover a prerelease tagged exactly `v4.0.1` without a `-beta.N` suffix. This publication does not replace stable 3.8.1.

## Fixed in 4.0.1

- Fix project folder colors being saved without changing the visible icon. The selected color now fills the inside of the original folder SVG while preserving its shape and outline. All five colors, reload persistence and the transparent reset are checked against the rendered fill and stroke.
- Make the **Computer Use model** button use the same selector styling, model icon and chevron as the other model selectors. The existing model-selection dialog and saved model behavior are unchanged.
- Verify the selector on desktop and narrow mobile layouts, including keyboard focus and expanded state.

## Workspace improvements

- Open folders in the foreground, including existing Explorer windows that were hidden or minimized.
- Open PowerShell directly in the selected workspace from its context menu on Windows. Folder paths with spaces, accents and special characters are supported.
- Choose from six folder-icon colors per project. The first, transparent option restores the default. The choice persists across reloads and restarts and affects only that project's folder icon.
- Navigate the project context menu and color choices with the keyboard without getting stuck on hidden actions.

## Computer Use on Windows

- Let an image-capable agent inspect windows, capture screenshots and use the mouse and keyboard on the real Windows desktop.
- Computer Use is off by default and requires explicit authorization. It has a separate desktop Stop control and a `Ctrl+Alt+Shift+F10` emergency hotkey where available.
- Fresh-frame checks, bounded action batches, single-owner control, cancellation and verification screenshots help prevent stale or unintended input. Screenshots are sent to the selected model provider.
- Add an opt-in **Cua Driver** backend alongside the original Windows integration. It supports accessibility inspection and snapshot-bound, element-targeted actions while keeping Studio's existing agent loop.
- Supervise CUA processes with Windows Jobs, verified teardown and visible cleanup-retry state. Partial or unverifiable action outcomes remain explicit; actions are not blindly replayed.

### Fixes and refinements from the local beta.5 to beta.8 builds

- Fix CUA startup failures caused by proxy process adoption (`win32 5`).
- Fix CUA text entry, scrolling and accessibility value updates being rejected by an empty input-guard plan. Preserve pending held-input cleanup across subsequent actions.
- Improve bounded window activation and refusal diagnostics.
- Fix non-ASCII text handling in the original Windows backend, including accents, symbols and emoji.
- Limit provider-bound images to **2000 pixels per axis**. Oversized attachments are resized for provider context only. Oversized desktop screenshots are rejected or omitted to preserve coordinate safety. Stored sessions are never rewritten.
- Move the desktop engine choice to **Preferences > Tools** as a global setting.
- Add a global **Computer Use model** setting, defaulting to the conversation model. Unavailable or text-only models are refused explicitly. This setting applies to the entire desktop-authorized run, not only image analysis.

## Models and provider compatibility

- Add built-in **Claude Opus 5.5** compatibility, including adaptive thinking support.
- Add **GPT-6 Sol** and **GPT-6 Luna**, with separate OpenAI API and ChatGPT/Codex entries and updated Codex model discovery.
- Fix Anthropic OAuth requests being rejected because Studio's integrated client identity was below the model's required minimum. Newer client versions are not downgraded.
- Keep API-key authentication, subscription authentication and explicit header overrides separate. Model access still depends on your provider account; catalog entries do not grant access.

## Prerelease update controls

- Add an opt-in beta option under **Preferences > Update**, off by default and available only in the local Windows application.
- Update checks remain manual. Changing the option clears the previous result without checking, downloading or installing anything automatically.
- Updates never downgrade the installed version. Installation still requires confirmation and a valid updater signature.
- This exact `v4.0.1` preview requires manual installation, as noted above.

## Git worktrees: still in preparation

**The worktree system is still in preparation and is not yet 100% operational. Treat it as experimental, not as a finished workflow.**

The current preview includes:

- Task-specific Git worktrees and branches created from **New worktree**, with conversations kept under the original project and saved worktrees available to reopen.
- Branch, path, changed-file and bounded-diff views.
- **Prepare merge with agent** for task-side commits, conflict-resolution preparation and checks, followed by a user-confirmed **fast-forward merge**.
- Guards against dirty checkouts, stale revisions, diverged branches and active runs. Removing a worktree retains its branch; discarding uncommitted or unmerged work requires extra confirmation.

Important limits:

- A new worktree starts at committed `HEAD`. Uncommitted changes, dependencies, ignored files and local secrets are not copied.
- A worktree is **not a sandbox**. Processes, ports, databases and external services remain shared.
- Worktree management is local-only. Repositories using executable Git filters are not supported in this preview.
- Semantic conflict resolution by a live model has not been validated end to end. Some interface and recovery paths still need refinement.

## Installation and validation

- Windows x64 installer, Tauri updater signature, update manifest and SHA-256 checksums are attached.
- The Tauri updater signature is verified. The installer does not have a Windows Authenticode signature, so Windows may show a SmartScreen warning.
- If an older server remains active after installation, wait for agents to finish, then use **Preferences > Update** to restart it and load the new version.
- JavaScript test suite: **883 passed, one intentional skip, zero failures**. Rust tests: **42 passed**. Syntax, translations and documentation checks passed. Workspace, Computer Use and preferences UI checks passed. Native Windows checks verified folder foreground activation and PowerShell's working directory.
