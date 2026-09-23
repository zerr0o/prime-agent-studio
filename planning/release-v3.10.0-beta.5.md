# v3.10.0-beta.5: local Windows x64 build

## Release notes

- Add an opt-in Cua Driver backend beside the original Windows integration. Keep the native agent and model loop.
- Add accessibility inspection and snapshot-bound element actions, with truthful partial outcomes and no automatic input replay.
- Supervise private CUA processes with Windows Jobs, verified teardown, independent Stop and visible cleanup retry state.
- Limit Computer Use images to 2000 pixels on both axes. Filter oversized historical images only in provider context, without rewriting sessions.
- Improve bounded native window activation and refusal diagnostics.
- Retain beta.4 model support, Anthropic OAuth compatibility and prerelease-update opt-in.

## Validation

- Final versioned suite: 842 passing tests, one intentional Windows skip, zero failures (843 total).
- Rust unit tests: 42 passing. A deterministic early-timer window-wait regression is included; focused bridge checks: 66 passing.
- Actual engine 0.9.5, headless/RPC and CUA flows: isolated fake desktops and a deterministic local provider.
- Windows Job validation: 26 checks, real Node-parented direct and nested adoption, input-free fixtures. Native driver tests: 34 passing.
- UI and real-app fixtures, prerelease settings in FR/EN, scoped independent lifecycle/protocol reviews.
- No live CUA desktop action or Roon validation claimed. No speed claim. Windows x64 only.

## Technical cost and bounds

- Pinned CUA archive: 29,085,823 bytes. Two executables: 52,127,392 bytes before installer compression, plus license/provenance files.
- Adds private daemon/proxy processes behind the existing native guardian. Actual application CPU/RAM/input latency was not benchmarked.
- Startup readiness is metadata-only, private-socket scoped and bounded to 8000 ms; Stop cancels it.

## Distribution scope

Local Windows x64 build completed. The 40,784,259-byte installer and its updater signature were verified. Resource fingerprint: `163256b08b97a347f806ac06955202cc63e7ff7100390f92a5002dc0c97622d2`. The installer has no Windows Authenticode signature; the updater signature is verified separately. No publication, push, tag, installation or Studio restart authorized. The validated code is merged into `main`. Three obsolete worktrees were removed after verified backups; `workrteetest` and all branches were retained.
