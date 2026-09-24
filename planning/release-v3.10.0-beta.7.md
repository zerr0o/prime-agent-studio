# v3.10.0-beta.7

- Fix CUA text entry, scrolling and accessibility value updates being rejected by an empty held-input guard plan.
- Preserve uncertain held-input cleanup when a later action does not need to arm the guard.
- Retain the beta.6 Windows CUA startup fix and the original backend.
- Keep genuine CUA `unverifiable` outcomes truthful: observe the resulting state before continuing, without blind replay.

## Verification

Local Windows x64 build completed. 846 tests passed, one intentional skip, zero failures. Native validator rejects empty arms before spawning; adapter regression tests cover type/scroll/set_value and retained stale-arm cleanup. Independent scoped review accepted. No real desktop input performed for this fix.

Installer, updater signature, beta.json and SHA256SUMS: `.local/desktop-release/v3.10.0-beta.7/`. Updater signature/trusted comment, PE version/x64 and byte identity of both staged CUA fixes verified. Windows Authenticode: NotSigned. Evidence: `test-results/build-v3.10.0-beta.7/` and `test-results/cua-beta7-fix/`.

No optimization or speed improvement claimed. Genuine upstream `unverifiable` is not a schema error and remains a partial outcome requiring fresh observation. No installation, restart, push or publication. Prior installers preserved.
