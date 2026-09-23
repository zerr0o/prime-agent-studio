# CUA owned-process Job supervision: guardian verb schema (finalized for relay)

Owner: native worker implements; CUA adapter/transport integrates only.
Neither side edits the other's files. Raw child.kill direct-child exit is
NOT tree proof in production and MUST NOT be used as such.

Pinned base: cua-driver-rs-v0.28.2 / fc188250. The private `mcp --socket`
surface has NO UIA/shared fallback (the WINDOWS.md sentence about UIA is
operator guidance, not routing), and the Studio bridge never exposes
`launch_application`, so killing CUA-owned descendants cannot take down
apps the agent launches externally.

## Verbs (all via guardian.request, worker-side implementation)

### job_launch { exe, args, nonce, env } -> { launched, pid, jobName }

- `exe`: absolute cua-driver path (packaging sidecar). `args` is exactly
  `['serve', '--socket', <Studio-private pipe>]`.
- `nonce`: adapter uuid, also persisted by the ADAPTER as
  `<owned-temp-home>/job-<nonce>.json` (nonce/pid persisted ONLY in the
  owned temp dir, never global state).
- `env`: STRICT allowlist object built by the adapter:
  `CUA_DRIVER_RS_HOME` (owned temp home), `CUA_DRIVER_RS_UPDATE_CHECK`
  (`'0'`), `CUA_DRIVER_RS_TELEMETRY_ENABLED` (`'0'`), `CUA_LOG`
  (`'WARN'` default), plus only explicit safe permission settings the
  release requires. The native guardian env is NOT the CUA home. The
  worker builds the CreateProcess Unicode environment block from exactly
  this object plus the system entries it names in its implementation doc.
  The driver sees the private home and no global config/default state.
- Behavior: spawn SUSPENDED, create the Job, assign, resume. Returns the
  daemon pid plus the job name for later status/kill/reconcile proof.
- Latch-gated: refused after the guardian stop latch.

### job_adopt { pid, exe, parentPid, birthMs, socketNonce } -> { adopted, pid }

- Adopts the SAME opened proxy handle the Node side spawned with direct
  stdio. Validation (all required, no PID-only commandline proof):
  `parentPid` MUST equal the guardian's actual Node parent PID (checked
  against the live process tree, not trusted from the caller); the opened
  handle's image path MUST equal `exe`; handle creation time MUST match
  `birthMs` within the documented tolerance; the process MUST be alive;
  its private `--socket` argument MUST match the pipe recorded for
  `socketNonce` (which links to the `job_launch` nonce).
- Latch-gated: refused after the guardian stop latch.
- The adapter runs adoption BEFORE any MCP handshake or tool request.

### job_status {} -> { active, activeProcesses, daemonPid, jobName }

- Permitted after stop (diagnostics). `activeProcesses` is the Job
  ActiveProcesses count: the proof input, not handle liveness alone.

### job_kill { timeoutMs <= 5000 } -> { treeExited, activeProcesses }

- Bounded tree kill with verified wait. `treeExited` is true ONLY when
  ActiveProcesses reaches zero and handles are reaped; the final
  `activeProcesses` count always rides along.
- Permitted after stop. Node emits the terminal stop notice BEFORE this
  bounded wait (authorization revokes immediately); the final stop result
  and diagnostics carry the job verdict after the wait.

### job_reconcile { nonce } -> { found, reconciled, treeExited, activeProcesses }

- Permitted after stop. `found:false` MUST NOT imply `treeExited:true`:
  lost proof is uncertainty, and the adapter latches JOB_UNCERTAIN, keeps
  the guardian and mutex, and starts NO fresh pair while it remains.

## Nesting (correction 3)

Do NOT require `IsProcessInJob(..., NULL) == false`. Studio/RLM may
already run inside a Job and Windows supports nested jobs. Reject only
re-entry into OUR OWN job or incompatible `AssignProcessToJobObject`
errors; allow successful nested assignment. No breakaway flag. Test with
a benign outer job. (The earlier fail-closed rule covered nested-job
REFUSAL, never a blanket rejection of all nested jobs.)

## Adapter sequence (normative, implemented)

1. Verify guardian: `status.mutex === true`,
   `status.externalInputGuard.supported === true`,
   `status.hotkeyRegistered === true` (boolean only; capability support
   or numeric `hotkeyError: 0` never counts). Anything else fails closed
   before any CUA tool.
2. Mint owned defaults (unique private pipe + owned temp home), resolve
   the driver path, `job_launch`, spawn the proxy direct, `job_adopt`,
   persist `job-<nonce>.json`, then MCP handshake. Late stop aborts and
   tears down at every await boundary.
3. Mutations arm the guardian per action with exact held sets and disarm
   only on confirmed completion; partial/unknown/refused preserve the arm
   for stop/close cleanup.
4. Shutdown: synchronous terminal latch + manager notice FIRST, then
   `job_kill` (bounded), require `treeExited && activeProcesses === 0`,
   then repeat the retained cleanup AFTER tree0 (an early best-effort
   signal is never proof), then close the guardian. No disarm after a
   native stop (the stopped latch refuses it deliberately); cleanup stays
   allowed and retains the plan. Unverified exit fails closed with
   uncertainty reported; retry re-runs kill+cleanup.
5. `job_reconcile` on doubt; `found:false` latches uncertainty.

## Test seams (fake only, no real processes)

- Adapter unit tests inject `createGuardian` (native-shaped fakes with
  the five verbs) and either prestarted fake transports (legacy mapping
  path) or the real transport factory over a fake proxy-only spawn
  boundary (job path: daemon never spawned by Node, adopt before
  handshake asserted).
- Transport unit tests cover direct spawn/handshake/abort plus the
  `processHost` delegation seam (`killTree`/`verifyExit` on owned roots
  only when explicitly set; default null documents non-tree-proof).
- No `taskkill /T` band-aid anywhere: production tree proof arrives only
  through these verbs.

## Native implementation record (worker owner, reconciled beta5)

The adapter contract above is normative and unchanged by this section,
which records native-side implementation facts.

### Struct sizes (empirically verified, x64)
- `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`: 144 bytes accepted.
  LimitFlags lives at offset 16 (BasicLimitInformation leads with two
  LARGE_INTEGERs), NOT offset 0: an early build wrote KILL_ON_JOB_CLOSE
  to offset 0 and the limit silently did not apply (query-back read 0).
- `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`: 48 bytes, ActiveProcesses at
  offset 40 (not 36). Both sizes probed live against the API, not assumed.
- KILL_ON_JOB_CLOSE is mandatory; no breakaway flag is ever set. The
  holder-loss path (close last job handle, no explicit kill) demonstrably
  terminates the tree: `job-loss-autokill` proves it.

### Spawn path
Suspended `CreateProcessW` -> assign -> resume. Assign/resume failure
terminates the still-suspended child before any return: no orphan. Daemon
stdio is stdin/stdout NUL with stderr piped and line-relayed to guardian
stderr as `cua-daemon:` diagnostics. The resume return is checked
(`uint.MaxValue` fails closed with the child terminated).

### Environment (OS baseline)
Allowlist: the seven caller CUA keys exactly as contracted, plus
caller-suppliable `SYSTEMDRIVE`, `SYSTEMROOT`, `WINDIR`, `TEMP`, `TMP`,
`PROGRAMDATA`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `HOMEDRIVE`,
`HOMEPATH`, `OS` (each validated). Missing entries are worker-injected
from the guardian env: `SYSTEMROOT` and `SYSTEMDRIVE` mandatory (drive
derived from SYSTEMROOT when absent), `WINDIR` defaults to SYSTEMROOT,
the rest injected when the guardian has them. These are OS identity,
never CUA config. `PATH`, `COMSPEC` and `PATHEXT` stay out by design:
absolute paths plus KnownDLLs only, no DLL-planting surface.
Frozen evidence required this: a stripped-env child resolved a cache
path with a literal unexpanded `%SystemDrive%` into the cwd
(`%SystemDrive%\ProgramData\Microsoft\Windows\Caches\*.db`, font/cache
format, timestamped during probe runs, archived not migrated). A bare
SYSTEMROOT+TEMP block is NOT enough if Windows COM/native components
expand SystemDrive/ProgramData/USERPROFILE.

### Adopt check order (all required)
Exact image path -> birth boundary (5000 ms) -> membership in OUR job
(`already-in-job` refusal, self-test reachable on our own daemon) ->
live parent equals live guardian parent -> optional caller `parentPid`
cross-check (claim verified, never trusted) -> CIM command-line nonce ->
assign on the SAME opened handle -> alive recheck. Refusal closes the
handle; only success keeps it until verified tree zero.

### Stop integration (worker)
Latch first, terminal `stopped` notice BEFORE the bounded kill wait
(~1200 ms protects the stop round-trip), early best-effort external
release, kill+verify, then final retained release AFTER verified zero.
Stop results and queued stop answers carry `job { treeExited,
activeProcesses }`; notices carry the pre-kill summary. No job means
byte-identical behavior to today. Uncertainty retains handles and is
reported, never cleared. Shutdown path kills bounded and relies on
`KILL_ON_JOB_CLOSE` for the remainder; freshness beyond process death is
adapter poison plus persisted-nonce reconcile.

### Status and ready
`externalInputGuard: { supported: true }` (object form, per adapter
seam), `jobGuard: { supported: true }`, existing boolean `mutex` owner
flag, `job` summary, `externalHeld` counts.

### Reconcile truthfulness
`found:false` carries NO `treeExited` key. A same-nonce live holder
reports current verified state instead of double-opening.

## Fixture record and node evidence
- `node.exe` (Studio build) aborted under the suspended+NUL spawn path
  during the beta4-cycle window with EVERY env variant including full
  inherited env (CSPRNG init abort, exit never captured; normal spawn and
  in-job life verified fine in the same window; the job proven innocent
  by direct CIM spawn plus assign). Later, with zero product-code delta,
  node ran alive under the same path across old-baseline, plus-drive and
  full-13 env variants, and a deterministic Win32 87 at CreateProcess
  (3/3 in one probe) no longer reproduces (later 1/2/4/long env bisect
  all stage 4). Root cause for both the abort and the 87 is UNPROVEN:
  load/AV/sandbox state changed between windows (npm ci ran through part
  of it) but no causal variable was isolated, so neither is classified as
  transient load nor as a launcher defect. Exact variants and outputs are
  logged in the probe notes of this thread; the current positive results
  stand on their own logs. The production binary is a Rust exe with no
  node init path; adapter metadata smoke remains the backstop regardless.
- Mechanical fixtures therefore use inbox `timeout.exe` /
  `powershell.exe` (absolute paths, nonce inside the script since trailing
  argv after powershell `-Command` joins the script text). Adopt checks
  are exe-agnostic (exact image path). A positive full adopt and a nested
  SUCCESS both need a Node-parented child, unobtainable in self-test; the
  Node-harness probe below covers them.
- Positive-adopt harness (new root): a small Node script spawns the
  fixture AND the worker `-JobAdoptProbe` mode, so fixture parent equals
  worker parent (both are the harness Node): real Node-parented positive
  adopt plus nested success through production `Add-CuaJobAdopt`. No
  hotkey, no real mutex, no desktop/input/focus/capture. Outer job for
  the nested case is created inside the probe (assign needs no parent
  check). Bounded with finally cleanup; only exact recorded pids touched.

## Proof log (beta5 root, Windows)
- `runtime/computer-use-worker.ps1 -SelfTest`: failed=0 (guard objects,
  job validation/gating incl. sysenv case, reconcile-absent with no
  `treeExited` key, zero SendInput by construction).
- `runtime/computer-use-worker.ps1 -JobSelfTest`: 26/26 exit 0 (26 JobCheck calls in source, 26 TEST-PASS lines in jobselftest-beta5.log, 0 fail)
  (suspended ownership, orphaned-grandchild kill to zero, retry, four
  refusal factors, already-in-job, benign-outer-job tolerance with
  scoped kill leaving the outer member provably alive, holder-loss
  auto-kill plus reconcile-clean, unknown-nonce absent).
- `-JobAdoptProbe` via Node harness: positive Node-parented adopt plus
  nested success through production validation (see harness log). Tracked
  portable copy: `scripts/test-cua-job-adoption.mjs` (`--mode=direct`,
  `--mode=nested`, `--mode=both` default both; dev validation only, no
  package or build-script change, not in any resource allowlist).
  Re-ran portable `--mode=both` green: direct and nested all PASS with
  fixtures reaped by the verified kill; evidence at
  `test-results/cua-integration/adopt-harness-direct.log` and
  `adopt-harness-nested.log` (earlier ignored proofs kept alongside).
- `node --test test/computer-use-driver.test.mjs`: 34/34.
- Post-run CIM sweep for fixture tags: zero strays, zero PS jobs.
- No CUA runtime, no UI/input/focus/capture, no hotkey, no real mutex in
  any test. Only exact recorded private pids ever signalled.
