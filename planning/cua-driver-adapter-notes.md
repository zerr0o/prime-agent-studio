# CUA driver adapter: design notes (tag cua-driver-rs-v0.28.2 / fc188250)

Files owned here ONLY (no edits to bridge/manager/PS/UI/packaging):

- `lib/cua-computer-use-driver.mjs` (`createCuaComputerUseDriver`)
- `lib/cua-driver-transport.mjs` (`createCuaDriverTransport`)
- `test/cua-computer-use-driver.test.mjs`, `test/cua-driver-transport.test.mjs`

Pinned research (read-only, never executed live):
`test-results/cua-integration/research-api/*` (contract manifest 0.8.0,
SKILL/WINDOWS/BROWSER skills, action-result-contract, mcp-protocol,
core action_target/element_token/window_target/daemon/protocol/tool_schema/
tool_args, windows capture.rs, stubs.rs, and `tools__impl_.rs` fetched raw
at the pinned commit for exact Windows input schemas) plus
`planning/cua-driver-distribution-research.md`. Tool schemas below follow
those sources; nothing is invented. No live capture/focus/input or other
desktop action ran in validation; only metadata smoke
(`--version`/`--help`/initialize/tools-list) on exact owned processes, and
all behavior tests use injected fakes with synthetic pixels.

## Interface (same shape as the native driver)

`createCuaComputerUseDriver(options)` -> `{ request, stop, close,
reconcile, handleSupervisorStop, started, pid, daemonPid, closedFlag,
stoppedFlag, generation, backend }`.
`request({method,params},{signal,timeoutMs})`, `stop(reason)`, `close()`,
`onStop` callback option. Methods: `status`, `windows`, `observe`, `act`,
`stop`, plus `inspect` (bounded AX tree + frame + driverFrame, NO image).

## Snapshot binding (bridge contract)

- Identity is `snapshot_id` (`sXXXXXXXX`) + `element_token`
  (`sXXXXXXXX:index`); NOT `capture_id`. Bare `element_index` is rejected;
  stale/superseded tokens fail closed (`STALE_FRAME`).
- Coords are CUA screenshot-local pixels (same resolution as the PNG the
  bridge already sees). The bridge sends them WITHOUT physical scaling and
  the adapter never rescales: `toPhysicalCoordinates` MUST NOT run for CUA.
- `observe` returns `{ image, frame, driverFrame (TOPLEVEL), elements
  (bounded when the AX walk rode along), truncated, elementCount, timing }`.
  `frame.bounds` is physical (from verified `window_bounds` in the SAME
  `get_window_state` response), `width`/`height` are actual screenshot
  pixels, both axes enforced at or under 2000. `inspect` returns the same
  minus the image with `driverFrame.kind === 'accessibility'`; the same
  token drives `act`, whose `expectedFrame.driverFrame` (opaque,
  backend+windowKey+snapshotId compared) is required. AX-only frames reject
  pixel actions (`AX_ONLY_FRAME`). A new snapshot supersedes the older
  binding for its key (bridge invalidates older frames after each snapshot).

## Tool mapping (verified Windows impl_.rs unless noted)

| Native act | CUA tool (+ scope/delivery/session) | Notes |
|---|---|---|
| click px | `click {pid,window_id,scope:window,x,y,button?,delivery_mode,session}` | window-local pixels, paired x/y |
| click ax | `click {...,element_token,...}` (no x/y) | token carries window; stale fails closed |
| click desktop | `click {x,y,scope:desktop,session,button?}` | no pid; delivery dropped by verified parser |
| double_click | `double_click {pid,window_id,...}` (no scope field in schema) | desktop refused (pid required) |
| move desktop | `move_cursor {scope:desktop,x,y,session}` | REAL pointer (verified SetCursorPos) |
| move window | refused `UNSUPPORTED_MOVE` | window scope is overlay-only; never misrepresented |
| drag | `drag {pid?,window_id?,scope,from_x/y,to_x/y,button?,delivery_mode?,session}` | single segment only; multi-point path refused |
| scroll | `scroll {direction,amount,by:line,...}` + optional anchor/token | dual-axis fans out to two verified dispatches; second failure is partial with `dispatches` detail |
| keypress 1 key | `press_key {key,...}` | element or px-focus forms per schema |
| keypress 2+ keys | `hotkey {keys,...}` (minItems 2 verified) | same forms |
| type | `type_text {text,...}` | px form focus-clicks then types (Chromium fix) |
| set_value | `set_value {pid,window_id,element_token,value,session}` | AX-only, no delivery knob, no x/y; value typeof string length<=2000 INCLUDING empty (empty clears) |
| wait | local timer only | never a CUA call |

- Delivery: batch `params.deliveryMode` (bridge tool schema) honored;
  per-action `deliveryMode` is rejected (schema is batch-level). Defaults:
  pixel/desktop `foreground` (Studio opt-in real input), element AX
  `background` (own-target UIA, never fronts). Documented divergence from
  the upstream background-first skill ladder, with rationale. NEVER
  auto-escalates on refusal; `BACKGROUND_UNAVAILABLE`/`UIP_BLOCKED` surface
  explicitly. `modifier` fields are refused (`UNSUPPORTED_MODIFIER`):
  background clicks cannot carry live modifier state on Windows.
- `set_value`/`move_cursor` take no delivery knob (verified schemas).
- `bring_to_front` (verified: requires pid, optional window_id, returns
  previous/now foreground, deliberately off-ladder) is called ONLY for an
  explicit user-initiated `windows focus` request; the raw outcome is
  surfaced with no force parity and every binding clears. The bridge never
  sends focus automatically.
- Verified refusals that stop input: `window_minimized` (surfaced, never
  auto-restored), `ambiguous_window_target` (+candidates),
  `window_target_not_found`, `background_uipi_blocked` (Medium-integrity
  UWP/AppContainer), desktop-scope shape errors.
- `scroll` `element_index` is a parity no-op on Windows: only
  `element_token` is ever sent.
- `type_text` holds nothing verifiable (PostMessage WM_CHAR char-by-char
  or atomic UIA ValuePattern; no clipboard/Ctrl+V path in source), so its
  arm set is empty but mutex-asserted like everything else.

## Act batch discipline (bridge-ratified)

- Whole-batch prevalidation BEFORE the first dispatch AND before the
  first guardian arm: a rejected batch dispatches nothing and keeps the
  binding for a corrected retry.
- First `partial`/`unverifiable`/`suspected_noop`/`refused` dispatch stops
  the batch: `{ executed (confirmed only), results, partial:true, error,
  timing }`. Unknown is never promoted. `executed` counts confirmed
  native actions only; the stopping action is reported but uncounted.
- `wait` is local and always counts when reached.

## Guardian ownership and shutdown (ratified wiring)

- Root passes NO shared supervisor. The adapter CREATES and OWNS a
  private native guardian via the real `lib/computer-use-driver.mjs`
  factory (lazy, before any capture/input), addressed ONLY through
  `request/stop/close` (arm/disarm/cleanup/status travel as worker
  requests; `UNKNOWN_METHOD` fails closed). Tests inject `createGuardian`
  fakes of that exact shape; the obsolete direct-supervisor injection is
  gone, so fake-only tests can never accidentally spawn the native helper.
- Mutation gate (all mandatory, fail closed): `status.mutex === true`,
  `status.externalInputGuard.supported === true`,
  `status.hotkeyRegistered === true` (boolean only; capability support or
  numeric `hotkeyError: 0` never counts). The native backend is untouched.
- Per-action arm carries exact held sets (keypress/hotkey keys; drag and
  click/double_click buttons incl. middle/right; everything else empty but
  mutex-asserted). Disarm runs ONLY after a confirmed action; partial and
  unknown preserve the arm for stop/close cleanup. No disarm runs after a
  native stop (the stopped latch refuses it); only cleanup is allowed and
  it retains the plan.
- Stop: synchronous terminal latch (stopped flag, generation fence,
  in-flight failure, manager `onStop` notice) BEFORE any await, so no
  request can restart the transport mid-kill. One shutdown promise shared
  across stop/hotkey/close with exactly-once cleanup AFTER verified tree0
  (`job_kill treeExited && activeProcesses === 0`; legacy injected path:
  owned-exit verification). A cleanup failure propagates (never swallowed):
  the mutex stays held and the attempt stays retryable. Unverified exit
  fails closed (`stopped:false`, guardian kept, uncertainty reported).
- Close: `fullyClosed` is set ONLY after verified tree0 + cleanup +
  guardian close. A failed close retries kill/cleanup (never reuses a
  settled failure, never reports a dead tree that may be live); concurrent
  closes share one finish. Owned temp home is removed best-effort last.
- `job_reconcile found:false` latches `JOB_UNCERTAIN`: no fresh pair may
  start while uncertainty remains; stop/close/reconcile stay available.

## Production launch (guardian Job verbs; helper implementation pending)

`verify (mutex+flag+hotkey)` -> mint owned defaults (unique private pipe
`prime-studio-cua-<uuid>`, owned `prime-studio-cua-home-*` temp dir) ->
resolve driver path -> guardian `job_launch {exe,args,nonce,env
allowlist}` (daemon suspended into the Job) -> Node spawns the proxy with
direct stdio -> guardian `job_adopt {pid,exe,parentPid==guardian Node
parent,bithMs,socketNonce}` on the SAME opened handle -> persist
`job-<nonce>.json` in the owned home ONLY -> MCP handshake (legacy
2025-06-18) -> tools. Every await boundary re-checks the terminal latch
and tears down partial state (abort + job_kill) instead of leaking it.
`job_status`/`job_reconcile` stay available after stop; launch/adopt are
latch-gated. Until the helper lands, a guardian without the verbs fails
closed (no raw-spawn fallback in production). The transport keeps a
`processHost {killTree,verifyExit}` delegation seam for owned roots only
(default null: direct children, explicitly NOT tree proof; no taskkill
band-aid anywhere).

## Image and scope limits (beta)

- Both axes at or under 2000 on every returned pixel surface AND on frame
  metadata; upstream window default long-edge 1568 fits. No downscale, no
  crop, no frame transform, ever: oversize refuses (`IMAGE_TOO_LARGE`).
- Desktop `get_desktop_state` is native-size with NO `max_dimension` knob
  (verified), so a >2000px primary display (common QHD/4K) MUST select a
  window in beta; `maxWidthHonored:false` is reported honestly.
- `observe.region` is refused (window-local coordinate safety); region
  preflight belongs at the bridge before the adapter round trip.
- Primary display only (`display_id primary`); anything else is refused.

## Timing (evaluation, no speedup claims)

Every observe/inspect/act/windows result carries
`{startedAt, endedAt, durationMs, tools:[{tool,durationMs}]}`. No claim
about model speed is made anywhere.

## Known gaps (not masked)

1. Daemon descendants (notably `cua-driver-uia.exe`) outlive direct-child
   supervision: no tree proof exists until the guardian Job verbs land.
   Reported, never papered over; production fails closed without them.
2. `scroll` element-token efficacy is schema-verified but behaviorally
   unproven on Windows (`element_index` is a documented no-op there).
3. Foreground-lock edge: `bring_to_front`/`foreground` delivery can be
   rejected by Windows from Medium integrity; surfaced, not retried.
4. Desktop moves use screen-absolute pixels from the native-size capture;
   if a future desktop path ever downscales, the mapping must be re-proven.
5. Desktop `snapshotId` mixes clock + monotonic counter (no collision under
   mocked time); window snapshots come from the driver.

## Root integration fields (final)

- `observe` -> `{image, frame{width,height,bounds,capturedAt,windowId?},
  driverFrame{TOPLEVEL}, elements?, truncated?, elementCount?, timing}`.
- `inspect {windowId!}` -> `{elements, truncated, elementCount, frame
  (kind accessibility), driverFrame, timing}` (no image).
- `act {actions, deliveryMode?, expectedFrame:{driverFrame}}` ->
  `{executed, results, partial?, error?, timing}`.
- `windows {action:list}` -> `{windows:[{id pid:hwnd,...}], timing}`;
  `{action:focus, windowId}` (explicit only) -> `{focused,
  previousForeground?, foregroundNow?, timing}`.
- `status` -> `{supported, backend:'cua', available, driverPath?,
  driverVersion?, reason?, transport:'daemon+proxy', hotkey|null,
  hotkeyRegistered:boolean, mutex?, externalInputGuard?, timing}`.
- Shutdown verbs shared: `stop` -> `{stopped, reason, generation,
  treeExited, error?}`; `close()` verified-or-throws; `reconcile()`.
