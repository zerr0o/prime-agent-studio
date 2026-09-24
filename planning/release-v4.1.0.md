# Studio 4.1.0: Prime Agent 0.9.6 migration

Status: source implementation and isolated acceptance complete. Local Windows x64 installer built and verified on user request. Changes are uncommitted. No installation changed or release published.

## Authorized scope

User requested removal of all Studio branches/worktrees except `main`, then the changes required for official Prime Agent 0.9.6 in Studio 4.1.0. Git tags and other repositories are outside the cleanup. The active Studio installation, running user agents and private settings are not modified.

## Git cleanup completed

- Six local branches and two GitHub branches removed after explicit confirmation.
- `WorkrteeTest` removed through the existing worktree service without force; its registry entry was removed by the same operation.
- Verified `git bundle --all` and complete worktree ZIP retained in `test-results/v4.1.0-cleanup/`, with CRC/content SHA checks and `SHA256.json`.
- Local and remote branch inventories now contain only `main`. Release tags remain.
- The separate dirty Prime Agent checkout and local OAuth branch were not touched.

## Engine preparation verified

The version pin is 0.9.6. npm 10.9.4, uv 0.8.22 and Python 3.11 remain unchanged.

The official tarball SHA256 is `e5bf0e349e55b3f75c79e66006c993b10c51ed1c9bf15863b06658fcaf0232b2` (11,354,912 bytes). A full production `prepareComponents` run used an isolated data root under `.local/engine-0.9.6/managed`, with no explicit CLI/Python overrides. It downloaded, verified, installed and validated the engine and a new managed Python environment. The resulting installation receipt is ready. The five new generic MCP discovery methods import successfully.

The upstream background-command completion fix is detected as already patched. Check-only validation leaves its file unchanged. Explicit user-managed Python is never patched.

Evidence: `test-results/engine-0.9.6/prepare-0.9.6.log`, `verify-prepared-0.9.6.mjs`, `explicit-no-patch-proof.mjs`.

## Compatibility boundaries

- Runtime readiness requires `list_plugins`, `search_plugins`, `list_connections`, `search_tools` and `describe_tool` from `rlm.mcp`.
- The actual official 0.9.6 package still exposes the previous harness CRUD methods and `path` grouping. The release-note prose about consolidated methods and `topic` does not match that artifact. Studio makes no direct obsolete CRUD calls, so no speculative API rewrite is applied.
- Custom HTTP and stdio MCP settings stay supported. The actual 0.9.6 pi-ai MCP entry point still exports `BUILTIN_MCP_CATALOG` for Linear and Notion. Studio keeps that native contract and does not recreate the terminal `/plugins` catalog or native multi-account manager. An initial assumption that this export was absent was disproved by a fresh direct import; the unused resolver fallback was removed.
- Confidential OAuth uses the native configured-provider factory for login and refresh. Optional client identity settings use a secret environment variable name, never a plaintext secret in `settings.json`. Endpoint/identity changes remove stale credentials.
- The existing model picker exposes native `imageModel`, distinct from Computer Use. New and live sends accept an image turn on a text-only conversation model only when a usable route is configured; Studio forwards the original model and images unchanged. Saving or clearing the setting refreshes the composer without reload, including when an older catalog request is in flight. The rejected delegated screenshot-analysis experiment remains deleted. Computer Use authorization, model image capability checks, frame fences and Stop controls stay in place.
- A real 0.9.6 persistence defect was reproduced: the live model stayed text, but a vision assistant's metadata made both native cold resume and Studio history select vision. The existing Studio image extension now appends an ordinary native `model_change` on completion only for a text-model/vision-assistant mismatch. It preserves the assistant message, honors a later explicit model change and leaves defaults unchanged. No installed engine patch or transcript rewrite is used. Old transcripts are not repaired retroactively.
- Native `defaultServiceTier` exposes Standard, Flex, Priority and Auto. Auxiliary-model help describes refinement, compaction and branch summaries. Fields remain opt-in; saving defaults does not restart active sessions.
- Anthropic subscription login requires acknowledgment of the upstream account-risk warning. API-key entry remains separate.
- Owned daemon environments discard only known loader imports inherited from another Studio installation. User flags, unrelated imports and this installation's loaders remain. The seven existing runtime adapters retain their original fail-closed behavior.
- A reproduced Windows `EPERM` during the atomic Roadmap rename could leave a delayed session unlinked. The write retries at most five times, 25 ms apart, for Windows `EPERM`/`EACCES` only. It retains the lock, rechecks safe paths before each attempt and reports persistent failure normally. The process causing the transient refusal was not identified.

## Validation checkpoint

Already verified:

- Production isolated install and Python readiness; explicit interpreter no-write proof.
- Targeted engine-settings/server tests with the real 0.9.6 native settings reader: 40 passed.
- Engine settings UI: shared picker, persistence, clearing, revision conflicts, language switches, catalog outage and 320/390px layouts.
- Provider UI under 0.9.6: real temporary credential persistence, simulated OAuth UI, Anthropic/Muse consent and remote access restrictions.
- MCP identity settings UI: four fields, unchanged-edit preservation, clearing, 320/390/1440px layouts, no login or probe.
- Native OAuth fixture covers confidential DCR exchange, refresh, secret persistence and a missing configured secret failing before network requests.
- Real Studio service/store/OAuth worker persists the fixture grant; the real probe worker refreshes it. The fixture deliberately has no MCP transport, so this proof does not claim tool discovery success.
- Native daemon smokes for commands, Roadmap, knowledge and subagents pass against isolated 0.9.6 with local model fixtures. Kernel compatibility tests pass 14/14, including reconstruction of the old unpatched block without machine-local tarball dependencies.
- Image admission tests: server 23/23 and live client 13/13. The full application UI proves save/clear with a held pre-save catalog response, retained attachment and unchanged conversation selection. A browser-only mutation restoring the old callback fails at the expected send-enabled assertion; production source was not modified for that negative proof.
- Final affected browser batch passes: engine settings, provider consent, MCP settings and image composer guard. Evidence: `test-results/engine-0.9.6/browser-final.log`.
- Native image dispatch and cold resume now pass through the real runtime factory with a loopback provider: vision request, unchanged PNG bytes, live configured text model, corrected native branch context and Studio history, then a text-only resumed request. The pre-fix reproduction is retained in `image-routing-native-baseline.json`; the positive proof is in `image-routing-parent-fixed.log` and `image-routing-native-fixed.json`. The added extension has four focused tests and an independent read-only review. Live image admission is covered by the live-client tests, not by this cold-resume proof.
- Rust release tests pass 43/43. This is not an installer build.
- Initial complete unit run: 933 passed, 7 failed, 1 skipped. Updated native fixtures removed six failures; the remaining delayed Roadmap link exposed the Windows rename failure described above. Failed logs are retained, including `full-suite-inflight-parent.log` and `full-suite-final.log`. The rename correction then passed 48/48 links in parallel pressure probes.

Final acceptance:

- Complete suite after the image persistence correction: **951 total, 950 passed, 1 intentional skip, 0 failed**. Evidence: `test-results/engine-0.9.6/full-suite-final-r4.log`. Tests use the isolated 0.9.6 CLI and its matching managed Python, not the installed 0.9.5 interpreter. The existing default-driver stop-callback test remains intentionally skipped.
- Final native image proof also verifies that `defaultProvider`, `defaultModel` and `imageModel` stay unchanged. Evidence: `image-routing-final.log` and `image-routing-native.json`.
- Native commands regression passes again after the extension change: `commands-after-image-fix.log`.
- Checks pass: 1,799 FR/EN messages, 16 documentation pairs, 274 local links, syntax and `git diff --check`. Independent final review found no confirmed remaining blocker.
- The final owned-process probe found zero processes with the isolated managed runtime path. The image proof confirms runtime/provider closure and removal of its temporary root. All browser fixtures closed their owned servers and browsers.
- Final Git inventory still shows `main` only, one Studio worktree and unchanged HEAD `58c162839fcce2f49ce3226463309bb531dbf57a`. Source changes remain uncommitted. Evidence: `final-git-state.txt` and `owned-processes-final.json`.

No real Supabase account login/refresh, real provider billing test or desktop action has been performed. Upstream speed/cost improvements are not measured Studio benchmarks. A debug test-identity Tauri executable is needed for the full Windows components pipeline UI; no production-identity executable is used as a substitute. The local installer below is not published or installed.


## Local Windows build

Built on explicit user request. `npm run check` and `npm run desktop:build` succeeded. Tauri produced the Windows x64 NSIS installer and updater signature. The compiler reported one unused-function warning for `control_options_contain_forbidden_pid`; the build succeeded.

- Installer: `.local/desktop-release/v4.1.0/Prime-Agent-Studio_4.1.0_x64-setup.exe`.
- Size: 40,798,987 bytes.
- SHA256: `83449f15487483a645b13b2d70ae66a49b9c0ce3cab232b26c30d5f60c6ce4af`.
- Updater signature and trusted comment verified cryptographically against the application public key. This is not Authenticode signing.
- Application architecture, version, local installer copy and changed staged runtime files verified. Resource identity: `41120f620fa8d01f8b32552043981a6d848103edf7dc3b5f41ef54793407d835`.
- Local updater manifest, signature and SHA256SUMS prepared alongside the installer. No upload, commit, tag, installation or restart.

Evidence: `test-results/build-v4.1.0/{check,build,manifest,verify}.log` and `artifact-verification.json`.


## Pre-release publication authorization

The user explicitly authorized GitHub pre-release publication after validating the local build. Publish the same verified installer bytes under `v4.1.0`, with pre-release status and without making it the latest stable release. Version 4.0.2 remains stable. Only source release labels/documentation change after the build; installer and runtime code are unchanged. Publication evidence is retained in `test-results/publish-v4.1.0/`. This authorization does not include installation or restart.
