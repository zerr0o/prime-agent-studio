# Current authoritative status

Beta.5 local build and updater-signature verification completed. Final Node suite: 842 pass, one skip of 843. Rust: 42 pass. Windows Job: 26 checks plus direct/nested Node-parented adoption. A deterministic early-timer wait-pacing regression was fixed and reviewed before build. Packaged source and pinned sidecar verified; resource identity `163256b08b97a347f806ac06955202cc63e7ff7100390f92a5002dc0c97622d2`. Studio app/server stayed running. No install, restart, push, tag or publication. Main integration and audited worktree cleanup are next. The earlier status sections below are historical.

# CUA beta.5 integration checkpoint

## Active root and authorized scope

- Active product tree: `PrimeAgentGUI-cua-beta5`, branch `feat/cua-beta5`.
- Exact published base: `v3.10.0-beta.4`, commit `c78f30f3a6375c9581ccb04c3b9cf8357fcb5aad`.
- Old `PrimeAgentGUI-computer-use` is frozen/read-only. Its complete tracked/unignored source was archived with hashes and duplicated into Main `test-results/cua-beta5-migration/`. Useful ignored artifacts still need full preservation before cleanup.
- Target local build: `v3.10.0-beta.5`. Versions deliberately remain beta.4 until acceptance.
- After validation/build: integrate onto `main`, preserving useful local work; then remove only audited unnecessary worktrees. No push, tag, publication, installation or Studio restart authorized. Roon is deferred by the user.

## Completed migration and new-root checks

- Selective CUA source transfer, not a project overwrite. HTML/translations merged from the verified beta.2 staged baseline. Final diffs there are additive CUA controls/strings only. Package metadata/dependencies retained, only three scripts updated.
- Fourteen previously missing released integrations plus `lib/agent.mjs` retained exactly. Independent migration review confirms model, Anthropic OAuth identity floor and prerelease-update support.
- Public docs retain the released development-only footer, not old links into absent planning files.
- `npm ci --ignore-scripts --no-audit --no-fund`: exit 0. Pinned CUA archive verified and sidecar prepared in new root without execution.
- Targeted beta.4 preservation tests: 91/91. Static: 1747 FR/EN messages, 16 documentation pairs, 268 links.
- UI unit script passed; actual-app fixture 9 checks passed; unchanged prerelease-settings UI script passed FR/EN. Fresh styled fixtures remain fake-desktop evidence only.
- Manager 44 pass plus one intentional Windows skip; routes 23 pass.
- Actual manager/bridge/adapter fake-process integration: 5/5 including default Windows pipe and adoption nonce assertions.
- Real engine 0.9.5 isolated fake-desktop proofs passed: six native tools headless/RPC, history image filtering, inspect/element/pixel/partial outcomes. No personal desktop input/capture.

## Lifecycle work and review

- Initial private pipe, adoption nonce, pending launch and concurrent close bugs corrected.
- Additional status/guardian acquisition races corrected: shared acquisition, terminal fences, bounded join, late arrivals closed or exact failed handles retained for retry.
- Windows Job proof now includes real Node-parented positive and compatible nested adoption, verified owned tree termination, no desktop/hotkey/mutex initialization. Native driver tests 34/34; pure worker self-test failed=0. Job self-test count reconciliation pending (26 pass lines versus an earlier report of 27).
- Required Windows OS environment baseline added after evidence of unresolved literal `%SystemDrive%` cache paths with stripped environments. Earlier suspended Node failure no longer reproduced; original cause not established.
- Scoped static lifecycle/protocol reviews found no blocking issue before the final readiness change. They are re-reviewing that change now.
- Final startup hardening: daemon private-socket metadata `list` readiness probe, bounded at 8000 ms and cancelled synchronously by Stop/close, before proxy spawn/adopt/handshake. No tool/input replay or shared socket fallback.
- Explicit driver `snapshot_id` accompanies window element tokens. Studio-minted desktop frame identity is local fencing only and never forwarded as driver proof.
- Latest adapter/transport tests: 49/49.
- One obsolete reviewer had blocked on an unbounded old-root test. Its runtime was retired. Exact owned process tree identified before retirement and final CIM check confirmed absent. No accepted report from that reviewer is used.

## In progress / remaining gates

1. Full new-root regression is running: `test-results/cua-integration/beta5-full-regression.log`.
2. Targeted independent re-review of final readiness/snapshot changes. Rerun engine/stack proofs if final implementation changes affect them.
3. Main/other-worktree source and useful-artifact audit is in progress; no Git mutation or cleanup yet.
4. Final resource checks, source freeze, version bump, local beta.5 build and artifact verification only after acceptance.
5. Preserve original Studio processes. No live CUA desktop actions have been performed or claimed.

## Evidence

New `test-results/cua-integration/` contains migration records, `beta4-preservation-tests.log`, UI/app/settings logs, `cua-adapter-validation.log`, integration/native proofs and scoped review reports. `beta4-alignment/comparison.json` describes the OLD tree before migration, not the new tree; current preservation is in `beta4-preserved.json` and the independent migration report.
