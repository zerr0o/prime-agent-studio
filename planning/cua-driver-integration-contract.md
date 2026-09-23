# Cua Driver beta.3 integration contract (in progress)

## Scope and constraints

- Work only in the existing `feat/computer-use` worktree. Preserve all prior uncommitted changes and the verified beta.2 installer.
- Keep the Studio agent/model loop, native image results, scoped authorization, exclusive owner, generation fences and independent Stop desktop control. No generic MCP setup bypasses these boundaries.
- Pin upstream `cua-driver-rs-v0.28.2`, a non-nightly prerelease with Windows x64 assets. Research and implementation must use that tag, not assume capabilities from `main`.
- No publication, merge, installation over the active Studio, restart, or real desktop input/capture in automated tests. Use private fake transports and synthetic pixels. Any actual-driver metadata smoke must avoid capture/input and use owned private processes only.

## Shared frontend/backend contract

- Backend IDs: `native` and `cua`. Native remains the compatibility default. CUA is an explicitly selected beta option, not a silent fallback.
- Status adds `backend` and `backends: [{id, supported, available, reason?}]`. Availability does not require spawning a desktop worker.
- `POST /api/computer-use` with `enabled: true` accepts `backend`. The user disables Computer Use before changing their active backend. A new owner can explicitly take over with a chosen available backend.
- `POST /api/runs` accepts `computerUseBackend` alongside `computerUse: true`. Backend choice is bound to the lease/session preference and inherited by native child agents.
- Selecting a driver while off must not enable desktop control. Read-only/offline contexts cannot change authorization. Context changes discard stale UI responses. Stop remains usable during pending operations.
- Missing CUA artifacts produce a clear unavailable status, never an implicit native replay. Unsupported actions and uncertain partial results are surfaced without replay.

## File ownership

- Root: backend manager/routes, bridge and native tool API integration, final validation/build.
- `cua-api-research`: tag-pinned API research report; driver implementation to be assigned after interface review.
- `cua-distribution-research`: artifact/licensing/isolation report; packaging implementation to be assigned after review.
- `cua-frontend-impl`: public/computer-use.js/css, public/app.js, public/translations.js, index.html and two computer-use UI test scripts.

Transport, capture/AX identity, coordinate and native stop contracts are pending the tag-pinned API findings. No implementation should invent these details.
