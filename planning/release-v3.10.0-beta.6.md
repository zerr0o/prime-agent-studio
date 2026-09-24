# v3.10.0-beta.6

- Fix Windows CUA startup failing with `proxy adoption: assign-failed (win32 5)`.
- Avoid the extra Node/libuv child Job for the MCP proxy while retaining CUA Job supervision, managed stdio and verified process cleanup.
- Preserve the original backend and all beta.5 features.

Validation: real pinned-binary failure reproduced before the fix; adoption, protocol handshake and process cleanup passed after the fix. Full suite: 842 passed, one intentional skip. No desktop input was performed by the reproduction.

## Local delivery

Build completed with `npm run desktop:build`. Installer, updater signature, manifest and SHA256SUMS are in `.local/desktop-release/v3.10.0-beta.6/`. Signature and trusted comment verified cryptographically; staged transport is byte-identical to the fixed source. Resource identity: `865fed08b7f65a98dcfa00946ec326cf74e0a7375ea2261294fa34811933582f`.

The real-process reproduction uses a dev-only worker copy without desktop initialization. It is not an installed-Studio desktop interaction test. First full-suite attempt used an old Python environment and failed one unrelated import; the managed-environment rerun passed 842 tests with one intentional skip. Raw failed logs are retained.

Beta.5 artifacts retained. No publication, push, installation or Studio restart. Evidence: `test-results/cua-live-startup-fix/` and `test-results/build-v3.10.0-beta.6/`.
