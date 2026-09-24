# v3.10.0-beta.8

- Fix non-ASCII text typed by the original Windows Computer Use backend (accents, symbols and emoji no longer turn into OEM mojibake).
- Prevent provider 400 errors from images above 2000 px: oversized attachments are downscaled for provider context only; oversized Computer Use screenshots are still dropped to keep coordinates safe. Stored sessions are never rewritten.
- Move the desktop engine choice to Preferences > Tools as one global setting.
- Add a global Computer Use model setting (default: same as conversation), applied only to runs with Computer Use authorized; text-only or unavailable models are refused explicitly.
- Retain the beta.6 CUA startup fix and the beta.7 CUA input-guard fix.

## Verification

870 tests passed, one intentional skip, zero failures; `npm run check` passes. Computer Use UI/app and settings UI scripts pass on Chromium. Worker SelfTest: 66 checks passed, including UTF-8 console checks. Real engine resizer proof: 1080x4703 to 459x2000. Staged resources byte-identical to source for all changed runtime files. Updater signature and trusted comment verified; Authenticode NotSigned.

Installer: `.local/desktop-release/v3.10.0-beta.8/`. Evidence: `test-results/build-v3.10.0-beta.8/`, `test-results/beta8-*`. No live typing test of accents yet. Engine 0.9.5 cannot delegate only image analysis to a second model; the Computer Use model applies to the whole authorized run. No installation, restart, push or publication.
