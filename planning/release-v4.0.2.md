# v4.0.2

- Roadmap: archive plans into a new Archived tab (read-only, excluded from progress, hidden from agents).
- Fix new conversations from the project listing or sidebar button failing on the first message (click event sent as cwd).

- Add a thinking level for the Computer Use decision model (Preferences > Tools). Default inherits the conversation level; applies only to runs with Computer Use authorized.
- MCP connections: show the real provider error instead of a generic OAuth message, with specific guidance for servers that require a client secret (such as Supabase).
- MCP connections: add a direct token mode (masked, stored privately, sent as `Authorization: Bearer`), and detect tokens pasted into the environment variable name field.
- MCP connections: pasting the return address after a failed OAuth attempt now shows the actual error.
- Conversation top bar: running agent, Expert desktop, then Roadmap on the far right; the separate desktop status text is removed.

## Additional changes included in the latest local build

- Project file links now support binary extensions and explicit project paths such as `.local/desktop-release/...exe`. Clicking previews only; executables remain blocked by the existing native-open policy.
- File links have an Open / Open folder / Copy path context menu. The viewer has Open folder beside Open; folder views show only Open folder. Managed worktree folder reveal uses the same file-root authorization as previews. Private data roots remain blocked, without release-path exceptions.
- Expanded skills in user messages appear as collapsed Skill disclosures. User request text stays visible; copying a user message omits expanded instructions when request text exists. Native stored history is unchanged.
- Multiple skill chips can be selected, removed and restored from drafts. Studio expands multiple leading `/skill:` commands using native catalog file paths and engine-compatible blocks; single-skill invocations remain engine-owned. Duplicate skills expand once. Expansion reads and message sizes are bounded. New runs and live steering/follow-up are covered.
- Validation: `npm run check`, 925 passed / 1 intentional skip / 0 failed, plus skills, command chips, commands, file links, file context menu and inspector UI scripts. Chromium desktop/mobile fixtures, OS folder/file launches stubbed. Evidence: `test-results/file-skills-final/*-r2.log`, `test-results/skills-ui/`, `test-results/file-links/`.
- Managed test Python is now `C:/Users/zerr0o/AppData/Local/com.primeagent.studio/.local/kernel-venv/f228d8c4a67657b1-2247099f/Scripts/python.exe`. The previous interpreter no longer imports `rlm`; this was an environment issue, not a product failure.
- Packaged in the latest local v4.0.2 build (r5). No installation, commit, push or publication.

## Latest installer verification

925 tests passed, one intentional skip, zero failures; `npm run check` passes. All 17 staged feature files match source byte-for-byte. Windows x64, updater signature and trusted comment verified. Installer: `.local/desktop-release/v4.0.2/Prime-Agent-Studio_4.0.2_x64-setup.exe` (40,798,390 bytes, SHA256 1025b939db852ef6d04394c4213b2ef2a654690ab178c0b7e8c6142c4728a17f). Evidence: `test-results/build-v4.0.2/*-r5.log`. This supersedes the previous installer with SHA256 eb1f1728aeb219db4fc574e5ac2efddfd2cbb882b814cf8a56f0e9ddb7bc2dac.

## Known limitation

Supabase OAuth needs an engine change: its dynamic client registration issues a client secret required for code exchange and refresh, which the engine OAuth provider does not keep. Use the direct token mode with a Supabase personal access token. Evidence: `test-results/mcp-panel/`.

Delegated image analysis was prototyped and removed before release (`test-results/v4.0.2-image-analysis/`). Includes preserved updater SemVer work. No installation, commit, push or publication.
