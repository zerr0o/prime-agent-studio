// Computer Use permission + single-holder lease: one shared real desktop
// controller per server. Opt-in per session/run, off by default. Grants
// (sessionPrefs + runGrants) record permission only and never drive input.
// The holder (owner) is exactly one native sub-agent and owns the driver.
// The bridge owns native call routing and acquires the exact child on every
// desktop tool call. Never capture or drive the real desktop in tests:
// inject a fake driver.
//
// Safety rules:
// - Releasing the holder, run end, scoped disable of the holder scope and
//   shutdown preempt native input through a direct driver.stop call, never
//   behind an action queue.
// - Permission grants never invalidate another holder's frames, cancel its
//   request, tear down its worker or steal the holder.
// - stop() clears every grant and preference so nothing silently re-enables.
// - The native hotkey/unexpected stop callback resets the whole lease.
// - The driver worker is closed and reset on full stop and shutdown so no
//   stale native queue can resume after a later re-enable.

export const COMPUTER_USE_HOTKEY = 'Ctrl+Alt+Shift+F10';
export const COMPUTER_USE_MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const cleanId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value) ? value : null;
const cleanText = (value, limit = 4096) =>
  typeof value === 'string' && value.length <= limit ? value : null;
const cleanRunId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value) ? value : null;

function fail(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

// Backend ids shared with the CUA integration contract and the HTTP API.
// Native stays the compatibility default; cua is an explicitly selected beta
// option, never a silent fallback.
export const COMPUTER_USE_BACKENDS = ['native', 'cua'];
export const COMPUTER_USE_DEFAULT_BACKEND = 'native';

const cleanBackend = (value) => (value === 'native' || value === 'cua' ? value : null);

// CUA beta support gate: Windows x64 only, under the native supervisor
// safety rules. Pure availability (installed artifacts, version) comes from
// lib/cua-driver-runtime.mjs once the packaging worker lands it; the path it
// reports is never exposed in public status.
const cuaSupportedDefault = () => process.platform === 'win32' && process.arch === 'x64';

function cleanBackendReason(value) {
  return typeof value === 'string' && value ? value.slice(0, 500) : undefined;
}

function normalizeCuaDescriptor(input, fallbackSupported) {
  const source = input && typeof input === 'object' ? input : {};
  const supported = typeof source.supported === 'boolean' ? source.supported : !!fallbackSupported;
  const available = supported && source.available === true;
  const out = { supported, available };
  const reason = cleanBackendReason(source.reason);
  if (reason) out.reason = reason;
  else if (!supported) out.reason = 'The CUA beta driver needs Windows x64.';
  else if (!available) out.reason = 'The CUA driver is not installed in this checkout.';
  if (typeof source.version === 'string' && source.version) out.version = source.version.slice(0, 100);
  return out;
}

async function loadRealDriver(backend, onStop) {
  if (backend === 'cua') {
    try {
      const module = await import('./cua-computer-use-driver.mjs');
      if (typeof module.createCuaComputerUseDriver === 'function')
        return module.createCuaComputerUseDriver({ onStop });
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
    throw fail(
      409,
      'The CUA driver is unavailable. The CUA desktop worker is not installed in this checkout.',
      'computer_use_backend_unavailable',
    );
  }
  try {
    const module = await import('./computer-use-driver.mjs');
    if (typeof module.createComputerUseDriver === 'function')
      return module.createComputerUseDriver({ onStop });
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  throw fail(
    409,
    'Computer Use driver is unavailable. The native desktop worker is not installed in this checkout.',
    'computer_use_unavailable',
  );
}

/**
 * Single real desktop lease.
 * options: { createDriver, isSupported, now, cuaAvailability,
 *   getCuaAvailability, backends }
 * - createDriver: (options) => driver | Promise<driver>. Receives { backend,
 *   onStop }: backend is immutable per driver instance ('native'|'cua') and
 *   onStop reports hotkey/native unexpected stops. Lazy: first real request
 *   only. Never falls back across backends.
 * - isSupported: boolean override for tests. Default is win32 only. Gates the
 *   native backend; the CUA beta has its own Windows x64 gate.
 * - cuaAvailability: static CUA descriptor { available, supported?, reason?,
 *   version? } for offline unit tests. Never carries a path.
 * - getCuaAvailability: () => descriptor | Promise<descriptor>, same shape as
 *   getCuaDriverAvailability from lib/cua-driver-runtime.mjs. Preferred over
 *   importing that module in tests.
 * - backends: full static [{ id, supported, available, reason?, version? }]
 *   override for offline unit tests.
 * - availabilityTtlMs: cache window for refreshBackends (default 5000).
 *   refreshBackends({ force: true }) bypasses it.
 */
export function createComputerUseManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const supportedOverride =
    typeof options.isSupported === 'boolean' ? options.isSupported : process.platform === 'win32';
  // The default factory forwards the backend and the token-scoped callback
  // like any injected factory: driver() supplies both for the current lease.
  const factory =
    typeof options.createDriver === 'function'
      ? options.createDriver
      : (opts) => loadRealDriver(opts?.backend ?? COMPUTER_USE_DEFAULT_BACKEND, opts?.onStop);
  const staticBackends = Array.isArray(options.backends)
    ? options.backends.filter((entry) => entry && cleanBackend(entry.id))
    : null;
  function readSyncCuaAvailability(source) {
    if (typeof source !== 'function') return null;
    try {
      const result = source();
      if (result && typeof result.then === 'function') {
        // Async source: keep the offline default until refreshBackends()
        // resolves it. Late resolutions update the cache for later status.
        result.then(
          (resolved) => {
            cuaAvailability = normalizeCuaDescriptor(resolved, cuaSupportedDefault());
          },
          () => {},
        );
        return null;
      }
      return result;
    } catch {
      return null;
    }
  }

  // Cached CUA availability. status() stays synchronous; refreshBackends()
  // re-queries the injected source or lib/cua-driver-runtime.mjs. An
  // explicitly injected descriptor is authoritative: offline unit tests must
  // never be overridden by the real runtime module landing mid-session.
  const cuaStatic = options.cuaAvailability ?? staticBackends?.find((entry) => entry.id === 'cua') ?? null;
  let cuaAvailability = normalizeCuaDescriptor(
    options.cuaAvailability ??
      staticBackends?.find((entry) => entry.id === 'cua') ??
      readSyncCuaAvailability(
        typeof options.getCuaAvailability === 'function' ? options.getCuaAvailability : null,
      ),
    cuaSupportedDefault(),
  );

  function nativeDescriptor() {
    const entry = staticBackends?.find((entry) => entry.id === 'native');
    if (entry)
      return {
        id: 'native',
        supported: entry.supported !== false,
        available: entry.available === true,
        ...(cleanBackendReason(entry.reason) ? { reason: cleanBackendReason(entry.reason) } : {}),
      };
    const out = { id: 'native', supported: supportedOverride, available: supportedOverride };
    if (!supportedOverride)
      out.reason = 'Computer Use needs Windows with the native desktop worker installed.';
    return out;
  }

  function cuaDescriptor() {
    const out = { id: 'cua', supported: cuaAvailability.supported, available: cuaAvailability.available };
    if (cuaAvailability.reason) out.reason = cuaAvailability.reason;
    if (cuaAvailability.version) out.version = cuaAvailability.version;
    return out;
  }

  function publicBackends() {
    return [nativeDescriptor(), cuaDescriptor()];
  }

  // Re-query CUA availability without spawning any desktop worker. Uses the
  // injected source when present, otherwise the packaging worker module
  // lib/cua-driver-runtime.mjs when it exists. Never exposes its path.
  // TTL-gated so frequent status polls stay responsive; pass { force: true }
  // to bypass the cache. The clock honors options.now for tests.
  const availabilityTtlMs =
    typeof options.availabilityTtlMs === 'number' && options.availabilityTtlMs >= 0
      ? options.availabilityTtlMs
      : 5000;
  let backendsCacheAt = 0;
  async function refreshBackends(input = {}) {
    if (cuaStatic) return publicBackends();
    if (!input.force && now() - backendsCacheAt < availabilityTtlMs) return publicBackends();
    // Stamp before querying so failures also cool down instead of hot-looping.
    backendsCacheAt = now();
    if (typeof options.getCuaAvailability === 'function') {
      try {
        cuaAvailability = normalizeCuaDescriptor(await options.getCuaAvailability(), cuaSupportedDefault());
      } catch (error) {
        cuaAvailability = normalizeCuaDescriptor(
          {
            supported: cuaSupportedDefault(),
            available: false,
            reason: String(error?.message || error).slice(0, 500),
          },
          cuaSupportedDefault(),
        );
      }
      return publicBackends();
    }
    try {
      const module = await import('./cua-driver-runtime.mjs');
      if (typeof module.getCuaDriverAvailability === 'function') {
        const reported = await module.getCuaDriverAvailability({});
        cuaAvailability = normalizeCuaDescriptor(reported, reported?.supported ?? cuaSupportedDefault());
      }
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      // Module not landed yet: keep the offline default (unavailable).
    }
    return publicBackends();
  }

  // Backend request validation. Throws before any lease mutation so an
  // unavailable backend never takes another owner offline.
  function resolveRequestedBackend(input = {}) {
    const raw = input.backend ?? input.computerUseBackend;
    if (raw === undefined) return null;
    const cleaned = cleanBackend(raw);
    if (!cleaned)
      throw fail(400, 'Unknown Computer Use backend. Send native or cua.', 'computer_use_invalid_backend');
    return cleaned;
  }

  function requireBackendAvailable(id) {
    if (id === 'cua') {
      const entry = cuaDescriptor();
      if (!entry.supported)
        throw fail(
          409,
          entry.reason || 'The CUA beta driver needs Windows x64.',
          'computer_use_backend_unsupported',
        );
      if (!entry.available)
        throw fail(409, entry.reason || 'The CUA driver is unavailable.', 'computer_use_backend_unavailable');
      return;
    }
    const entry = nativeDescriptor();
    if (!entry.supported)
      throw fail(
        409,
        'Computer Use needs Windows with the native desktop worker installed.',
        'computer_use_unsupported',
      );
    if (!entry.available)
      throw fail(409, entry.reason || 'The native driver is unavailable.', 'computer_use_unavailable');
  }

  // Holder: exactly one native sub-agent or null. Shape:
  // { sessionId (root session for UI), runId (root owner/run id),
  //   agentId, agentSessionId (verified child session), cwd?, name?,
  //   backend, imageCapable?, model?, computerModel?, computerThinking? }.
  let owner = null;
  // Permission grants. Session prefs survive run end; run grants cover
  // unbound drafts until noteRunSession binds them to a root session.
  // Grant shape: { runId?, sessionId?, cwd?, name?, backend,
  //   imageCapable?, model?, computerModel?, computerThinking? }.
  const sessionPrefs = new Map();
  const runGrants = new Map();
  let driverPromise = null;
  let generation = 0;
  let frameSeq = 0;
  let currentFrameId = null;
  const frames = new Map();
  let lastAction = null;
  let lastError = null;
  let hotkeyError = null;
  let inflight = 0;
  let explicitStopping = false;
  let driverToken = null;
  // Orphaned workers whose close failed and may still be alive (CUA tree
  // and/or guardian lock; the adapter holds the native mutex while the tree
  // exists). driver() refuses to mint while any remain. Only an explicit
  // stop retries their close (one bounded attempt each, no indefinite waits,
  // no process-wide kills) and only verified successes clear. Lease resets
  // and enables never clear this uncertainty. Owned instance references,
  // never PID globals.
  const orphanedWorkers = new Map();
  // Honest in-flight teardown accounting for status: incremented around
  // every teardown/orphan-close pass (explicit teardown work, the
  // native-stop close chain, the stop retry pass) so polls during the work
  // see cleanupPending true. Never fakes lease state; counts only.
  let teardownInflight = 0;

  async function joinTeardown(work) {
    teardownInflight += 1;
    try {
      await work;
    } finally {
      teardownInflight = Math.max(0, teardownInflight - 1);
    }
  }
  // Mutation epoch: every lease change bumps it. Awaited handoffs verify it
  // afterwards so a concurrent stop cannot be silently overridden.
  let leaseEpoch = 0;
  const bumpEpoch = () => {
    leaseEpoch += 1;
  };
  // Control revision: bumped only when input is turned off or taken away
  // (disable, stop, run release, takeover removal, native stop). HTTP
  // admission captures it before slow preflight awaits and refuses to grant
  // afterwards when it moved, so a stop racing enable never loses.
  let stopEpoch = 0;
  const bumpStopEpoch = () => {
    stopEpoch += 1;
  };

  // Public holder: root session/run for UI plus the actual native agent.
  function publicOwner() {
    if (!owner) return null;
    const out = {};
    if (owner.sessionId) out.sessionId = owner.sessionId;
    if (owner.runId) out.runId = owner.runId;
    if (owner.agentId) out.agentId = owner.agentId;
    if (owner.agentSessionId) out.agentSessionId = owner.agentSessionId;
    if (owner.cwd) out.cwd = owner.cwd;
    if (owner.name) out.name = owner.name;
    if (owner.backend) out.backend = owner.backend;
    return out;
  }

  function ownerInfo() {
    if (!owner) return null;
    return structuredClone(owner);
  }

  // Grant routing helpers. computerModel/computerThinking are optional
  // routing stored by enable/noteRunStarted and returned by permissionFor.
  function cleanRouting(value, limit) {
    return typeof value === 'string' && value.length <= limit ? value : undefined;
  }

  function grantRouting(input = {}) {
    const out = {};
    const computerModel = cleanRouting(input.computerModel, 500);
    if (computerModel !== undefined) out.computerModel = computerModel;
    const computerThinking = cleanRouting(input.computerThinking, 50);
    if (computerThinking !== undefined) out.computerThinking = computerThinking;
    return out;
  }

  function grantsEqual(a, b) {
    if (!a || !b) return false;
    return (
      (a.enabled ?? true) === (b.enabled ?? true) &&
      (a.backend ?? null) === (b.backend ?? null) &&
      (a.sessionId ?? null) === (b.sessionId ?? null) &&
      (a.cwd ?? null) === (b.cwd ?? null) &&
      (a.name ?? null) === (b.name ?? null) &&
      (a.computerModel ?? null) === (b.computerModel ?? null) &&
      (a.computerThinking ?? null) === (b.computerThinking ?? null) &&
      (a.imageCapable ?? null) === (b.imageCapable ?? null) &&
      (a.model ?? null) === (b.model ?? null)
    );
  }

  function grantDescriptor(grant, runId, sessionId) {
    if (!grant) return null;
    const out = { backend: grant.backend ?? COMPUTER_USE_DEFAULT_BACKEND };
    if (runId) out.runId = runId;
    else if (grant.runId) out.runId = grant.runId;
    const sid = sessionId ?? grant.sessionId ?? null;
    if (sid) out.sessionId = sid;
    if (grant.cwd) out.cwd = grant.cwd;
    if (grant.name) out.name = grant.name;
    if (grant.computerModel !== undefined) out.computerModel = grant.computerModel;
    if (grant.computerThinking !== undefined) out.computerThinking = grant.computerThinking;
    if (grant.imageCapable !== undefined) out.imageCapable = grant.imageCapable;
    if (grant.model !== undefined) out.model = grant.model;
    return out;
  }

  // Resolve the permission grant for a verified caller identity
  // { ownerId (root run), rootSessionId }. Run grants win over the bound
  // session preference; a bound run grant whose session disagrees grants
  // nothing. Unbound drafts (sessionId null) grant by run id alone.
  function grantForCaller(caller = {}) {
    const ownerId = cleanRunId(caller.ownerId);
    const rootSessionId = cleanId(caller.rootSessionId);
    if (ownerId && runGrants.has(ownerId)) {
      const grant = runGrants.get(ownerId);
      if (grant.sessionId && rootSessionId && grant.sessionId !== rootSessionId) return null;
      return { grant, runId: ownerId, sessionId: grant.sessionId ?? rootSessionId ?? null };
    }
    if (rootSessionId && sessionPrefs.get(rootSessionId)?.enabled === true) {
      return { grant: sessionPrefs.get(rootSessionId), runId: ownerId ?? null, sessionId: rootSessionId };
    }
    return null;
  }

  // Permission query used by the bridge before acquiring. Returns the grant
  // routing (backend + computerModel/computerThinking) or null when the
  // caller has no permission. Never touches holder, frames or epochs.
  function permissionFor(caller = {}) {
    const found = grantForCaller(caller);
    if (!found) return null;
    return grantDescriptor(found.grant, found.runId, found.sessionId);
  }

  function publicFrame() {
    if (!currentFrameId) return null;
    const frame = frames.get(currentFrameId);
    if (!frame) return null;
    // Pixels stay in takeFrame storage only. driverFrame is opaque bridge
    // transport internals (pid/window/snapshot/sessionLabel) and never
    // leaves the lease; backend/kind stay visible when present.
    const { imageData: _pixels, driverFrame: _transport, ...meta } = frame;
    return structuredClone(meta);
  }

  function invalidateFrames() {
    generation += 1;
    currentFrameId = null;
    frames.clear();
  }

  // Lease resets never clear cleanup uncertainty: while an orphaned worker
  // may still be alive the failure stays surfaced and driver() stays closed.
  function clearLeaseError() {
    if (!orphanedWorkers.size) lastError = null;
  }

  function noteOrphanedWorker(instance, error, context) {
    if (!instance) return;
    const detail = String(error?.message || error).slice(0, 500) || `${context} worker cleanup failed.`;
    orphanedWorkers.set(instance, detail);
    setError(`Computer Use cleanup failed: ${detail} Use Stop to retry before re-enabling.`);
  }

  function orphanedMessage() {
    const next = orphanedWorkers.values().next();
    return next.done ? null : next.value;
  }

  // Bounded retry for explicit stops: one close attempt per retained worker.
  // Verified successes clear; repeated failures stay poisoned with the latest
  // message.
  async function retryOrphanedCleanups() {
    if (!orphanedWorkers.size) return;
    teardownInflight += 1;
    try {
      await retryOrphanedPass();
    } finally {
      teardownInflight = Math.max(0, teardownInflight - 1);
    }
  }

  async function retryOrphanedPass() {
    for (const instance of [...orphanedWorkers.keys()]) {
      try {
        await instance.close?.();
        orphanedWorkers.delete(instance);
      } catch (error) {
        orphanedWorkers.set(
          instance,
          String(error?.message || error).slice(0, 500) || 'Cleanup retry failed.',
        );
      }
    }
    if (orphanedWorkers.size) {
      setError(`Computer Use cleanup failed: ${orphanedMessage()} Use Stop to retry before re-enabling.`);
    } else {
      lastError = null;
    }
  }

  function fullReset(reason) {
    owner = null;
    sessionPrefs.clear();
    runGrants.clear();
    invalidateFrames();
    clearLeaseError();
    hotkeyError = null;
    lastAction = { type: 'stop', reason, at: new Date(now()).toISOString() };
    bumpEpoch();
    bumpStopEpoch();
  }

  // Native hotkey or unexpected worker stop: the desktop is no longer driven,
  // so the whole lease resets. Never calls back into the driver, which
  // already stopped, so explicit stop() cannot recurse here.
  function handleNativeStop(reason) {
    if (explicitStopping) return;
    const pending = driverPromise;
    driverPromise = null;
    driverToken = null;
    driverInstance = null;
    // Synchronous invalidation first: lease, frames and preferences reset
    // before any CUA tree kill or guardian close settles.
    fullReset(typeof reason === 'string' && reason ? reason.slice(0, 100) : 'native-stop');
    // A natively stopped worker already stopped itself, so it is only
    // closed, never .stop()ed (which would recurse through onStop; the
    // detached token above already ignores late callbacks). The close joins
    // the shared teardown barrier instead of a detached fire-and-forget, so
    // a re-enable mints its replacement only after this cleanup settles.
    if (pending) {
      const work = teardownChain
        .catch(() => {})
        .then(async () => {
          const instance = await pending.catch(() => null);
          if (!instance) return;
          try {
            await instance.close?.();
          } catch (error) {
            // Fail closed: the tree may still exist, so the lease must not
            // silently mint a replacement. The orphan is retained for an
            // explicit stop to retry; driver() stays poisoned meanwhile.
            noteOrphanedWorker(instance, error, 'native-stop');
          }
        });
      teardownChain = work.catch(() => {});
      // Tracked honestly: polls during the kill/guardian close see pending.
      void joinTeardown(teardownChain);
    }
  }

  // Shared teardown barrier. Every teardown synchronously detaches the
  // cached worker and its token, clears frames, then stops AND closes that
  // exact instance: stopped helpers are never preserved, so no stop-latched
  // worker, mutex or hotkey can leak into a later lease. driver() mints a
  // replacement only after in-flight cleanup settles.
  let teardownChain = Promise.resolve();
  let mintLock = Promise.resolve();
  let driverInstance = null;

  // Bootstrap the CUA verdict in the background (pure file check, never a
  // worker spawn): the runtime helper is async I/O, so the synchronous
  // default stays unavailable until this settles. Static descriptors and
  // injected async sources already seed the cache above and skip this.
  if (!cuaStatic && typeof options.getCuaAvailability !== 'function')
    void refreshBackends({ force: true }).catch(() => {});

  async function driver() {
    // No anonymous driving: a permission alone never mints a worker. The
    // bridge acquires the exact child holder before every desktop tool call.
    // The holder tuple + control revision are captured at entry and
    // rechecked after every await and before any cached-promise return or
    // mint: a release in the gap must reject the old request instead of
    // minting a default worker for nobody (or handing back another agent's
    // worker). Permission-only churn (lease revision) never cancels a mint.
    if (!owner)
      throw fail(
        409,
        'Computer Use is enabled but no agent holds the desktop. Acquire it before driving.',
        'computer_use_disabled',
      );
    const admittedOwner = {
      runId: owner.runId,
      agentId: owner.agentId,
      agentSessionId: owner.agentSessionId,
      backend: owner.backend,
    };
    const admittedControl = stopEpoch;
    const assertHolderFresh = () => {
      if (admittedControl !== stopEpoch)
        throw fail(
          409,
          'Computer Use changed during driver startup. Acquire again if still enabled.',
          'computer_use_conflict',
        );
      if (
        !owner ||
        owner.runId !== admittedOwner.runId ||
        owner.agentId !== admittedOwner.agentId ||
        owner.agentSessionId !== admittedOwner.agentSessionId
      ) {
        if (!owner)
          throw fail(
            409,
            'Computer Use is enabled but no agent holds the desktop. Acquire it before driving.',
            'computer_use_disabled',
          );
        throw fail(
          409,
          'Computer Use is already held by another agent. Only one native agent drives the desktop at a time.',
          'computer_use_busy',
        );
      }
    };
    if (driverPromise) {
      assertHolderFresh();
      return driverPromise;
    }
    let releaseMint;
    const gate = new Promise((resolve) => (releaseMint = resolve));
    const prior = mintLock;
    mintLock = gate;
    await prior.catch(() => {});
    try {
      assertHolderFresh();
      if (driverPromise) return driverPromise;
      await teardownChain.catch(() => {});
      // Fail-closed orphaning: a retained worker may still hold the native
      // mutex, so no replacement is minted until an explicit stop verifies
      // every retained close.
      assertHolderFresh();
      if (orphanedWorkers.size)
        throw fail(
          409,
          `Computer Use cleanup failed: ${orphanedMessage()} Use Stop to retry before re-enabling.`,
          'computer_use_cleanup_failed',
        );
      if (driverPromise) return driverPromise;
      assertHolderFresh();
      const token = {};
      driverToken = token;
      // The backend is frozen for this driver instance: the current holder's
      // backend at mint time. A later release tears this worker down first
      // (pending factories are captured by teardown), so input can never
      // cross backends.
      const mintedBackend = owner.backend ?? COMPUTER_USE_DEFAULT_BACKEND;
      const created = Promise.resolve().then(() =>
        factory({
          backend: mintedBackend,
          onStop: (reason) => {
            // Late callbacks from a detached worker are ignored so they can
            // never reset a newer lease.
            if (driverToken === token) handleNativeStop(reason);
          },
        }),
      );
      driverPromise = created;
      created.then(
        (instance) => {
          if (driverPromise === created) driverInstance = instance;
        },
        () => {
          if (driverToken === token) driverToken = null;
          if (driverPromise === created) {
            driverPromise = null;
            driverInstance = null;
          }
        },
      );
      return created;
    } finally {
      releaseMint();
    }
  }

  async function teardownDriver(reason) {
    const pending = driverPromise;
    driverPromise = null;
    driverToken = null;
    driverInstance = null;
    invalidateFrames();
    if (!pending) return;
    const work = teardownChain
      .catch(() => {})
      .then(async () => {
        explicitStopping = true;
        try {
          const instance = await pending.catch(() => null);
          if (instance) {
            try {
              await instance.stop?.(reason || 'teardown');
            } catch {
              /* A dying worker never fails lease bookkeeping. */
            }
            try {
              await instance.close?.();
            } catch (error) {
              // Same fail-closed propagation as the native-stop barrier: a
              // worker that refuses to close may still be alive, so it is
              // retained for an explicit stop to retry instead of being
              // swallowed while the lease reopens.
              noteOrphanedWorker(instance, error, 'teardown');
            }
          }
        } finally {
          explicitStopping = false;
        }
      });
    teardownChain = work.catch(() => {});
    await joinTeardown(work);
  }

  // Drop one exact dead worker (for example after WORKER_EXIT) without
  // touching a newer replacement that may already be cached.
  function dropDriverInstance(instance) {
    if (instance && driverInstance === instance) {
      driverPromise = null;
      driverToken = null;
      driverInstance = null;
    }
  }

  // Release current input hold without dropping the lease: tear down the
  // worker, then discard every frame so nothing can replay. The next tool
  // call mints a fresh worker.
  async function releaseInput() {
    await teardownDriver('release');
    recordAction({ type: 'release' });
  }

  function requireSupported() {
    if (!supportedOverride)
      throw fail(
        409,
        'Computer Use needs Windows with the native desktop worker installed.',
        'computer_use_unsupported',
      );
  }

  // Permission-first status: enabled reflects grants (session prefs + run
  // grants), never the holder. The holder (owner) is reported separately and
  // never leaks another scope's backend into a scoped query.
  function grantForScope(sessionId, runId) {
    if (runId && runGrants.has(runId)) {
      const grant = runGrants.get(runId);
      if (!sessionId || !grant.sessionId || grant.sessionId === sessionId)
        return { grant, runId, sessionId: grant.sessionId ?? sessionId ?? null };
    }
    if (sessionId) {
      const pref = sessionPrefs.get(sessionId);
      if (pref?.enabled === true) return { grant: pref, runId: runId ?? null, sessionId };
      for (const [id, grant] of runGrants) {
        if (grant.sessionId === sessionId) return { grant, runId: id, sessionId };
      }
    }
    return null;
  }

  function status(query = {}) {
    const sessionId = cleanId(query.sessionId);
    const runId = cleanRunId(query.runId);
    let enabled;
    let backend = null;
    if (sessionId || runId) {
      const found = grantForScope(sessionId, runId);
      enabled = !!found;
      if (found) backend = found.grant.backend ?? COMPUTER_USE_DEFAULT_BACKEND;
    } else {
      enabled = [...sessionPrefs.values()].some((pref) => pref?.enabled === true) || runGrants.size > 0;
      backend = owner?.backend ?? null;
    }
    return {
      supported: supportedOverride,
      enabled,
      backend,
      backends: publicBackends(),
      owner: publicOwner(),
      busy: inflight > 0,
      // Cleanup uncertainty for the Stop control: pending while any teardown
      // or orphan-close work is in flight, failed while a retained orphan
      // may still be alive. Booleans only, never handles or paths. False in
      // ordinary native operation.
      cleanupPending: teardownInflight > 0,
      cleanupFailed: orphanedWorkers.size > 0,
      hotkey: COMPUTER_USE_HOTKEY,
      hotkeyError,
      controlRevision: stopEpoch,
      lastAction: lastAction ? structuredClone(lastAction) : null,
      lastFrame: publicFrame(),
      error: lastError,
    };
  }

  function assertLeaseRevision(expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== leaseEpoch)
      throw Object.assign(
        fail(409, 'Computer Use changed. Read its state before retrying.', 'computer_use_conflict'),
        {
          currentRevision: leaseEpoch,
        },
      );
  }

  // Permission grants never touch holder, frames, epochs or the worker.
  // Multiple sessions/runs can hold permission at once; the single holder
  // is reserved separately via acquire().
  async function enable(input = {}, { authorize, expectedRevision } = {}) {
    const admission = expectedRevision ?? leaseEpoch;
    assertLeaseRevision(admission);
    const sessionId = cleanId(input.sessionId);
    const runId = cleanRunId(input.runId);
    if (!sessionId && !runId)
      throw fail(
        400,
        'Computer Use needs a selected session or the current run to enable.',
        'computer_use_invalid',
      );
    const requested = resolveRequestedBackend(input);
    const cwd = typeof input.cwd === 'string' && input.cwd.length <= 4096 ? input.cwd : undefined;
    const name = cleanText(input.name, 200);
    const routing = grantRouting(input);
    const imageCapable = typeof input.imageCapable === 'boolean' ? input.imageCapable : undefined;
    const model = typeof input.model === 'string' && input.model.length <= 500 ? input.model : undefined;
    // Availability is validated before any grant mutation, so a request for
    // an unavailable backend never revokes another scope's permission.
    let effective = requested ?? COMPUTER_USE_DEFAULT_BACKEND;
    if (!requested) {
      if (runId && runGrants.has(runId))
        effective = runGrants.get(runId).backend ?? COMPUTER_USE_DEFAULT_BACKEND;
      else if (sessionId && sessionPrefs.get(sessionId)?.enabled === true)
        effective = sessionPrefs.get(sessionId).backend ?? COMPUTER_USE_DEFAULT_BACKEND;
    }
    if (effective === 'cua') await refreshBackends().catch(() => {});
    if (authorize) await authorize();
    assertLeaseRevision(admission);
    requireBackendAvailable(effective);
    // Permission mutations bump the lease revision so a concurrent grant or
    // revoke with a captured admission fails instead of resurrecting. Never
    // the stop revision, never frames/generation, never the worker: an
    // unrelated holder keeps driving on its valid frames.
    let mutated = false;
    if (sessionId) {
      const prev = sessionPrefs.get(sessionId);
      if (requested && prev?.enabled === true && prev.backend && prev.backend !== requested)
        throw fail(
          409,
          'Computer Use is already enabled with another backend. Disable it first, then enable with the new backend.',
          'computer_use_backend_change',
        );
      const next = { enabled: true, backend: effective };
      if (cwd !== undefined) next.cwd = cwd;
      else if (prev?.cwd) next.cwd = prev.cwd;
      if (name) next.name = name;
      else if (prev?.name) next.name = prev.name;
      Object.assign(next, routing);
      if (imageCapable !== undefined) next.imageCapable = imageCapable;
      else if (prev?.imageCapable !== undefined) next.imageCapable = prev.imageCapable;
      if (model !== undefined) next.model = model;
      else if (prev?.model !== undefined) next.model = prev.model;
      if (!prev || !grantsEqual(prev, next)) {
        sessionPrefs.set(sessionId, next);
        mutated = true;
      }
    }
    if (runId) {
      const prev = runGrants.get(runId) || null;
      if (requested && prev && prev.backend && prev.backend !== requested)
        throw fail(
          409,
          'Computer Use is already enabled with another backend. Disable it first, then enable with the new backend.',
          'computer_use_backend_change',
        );
      const next = {
        backend: effective,
        sessionId: sessionId ?? prev?.sessionId ?? null,
      };
      if (cwd !== undefined) next.cwd = cwd;
      else if (prev?.cwd) next.cwd = prev.cwd;
      if (name) next.name = name;
      else if (prev?.name) next.name = prev.name;
      Object.assign(next, routing);
      // Inherit stored routing from the session preference when the run
      // grant does not carry its own.
      if (sessionId) {
        const pref = sessionPrefs.get(sessionId);
        if (pref) {
          if (next.computerModel === undefined && pref.computerModel !== undefined)
            next.computerModel = pref.computerModel;
          if (next.computerThinking === undefined && pref.computerThinking !== undefined)
            next.computerThinking = pref.computerThinking;
        }
      }
      if (imageCapable !== undefined) next.imageCapable = imageCapable;
      else if (prev?.imageCapable !== undefined) next.imageCapable = prev.imageCapable;
      if (model !== undefined) next.model = model;
      else if (prev?.model !== undefined) next.model = prev.model;
      if (!prev || !grantsEqual(prev, next)) {
        runGrants.set(runId, next);
        mutated = true;
      }
    }
    if (mutated) bumpEpoch();
    return status(sessionId ? { sessionId } : { runId });
  }

  async function disable(input = {}, { authorize, expectedRevision } = {}) {
    const admission = expectedRevision ?? leaseEpoch;
    const sessionId = cleanId(input.sessionId);
    const runId = cleanRunId(input.runId);
    if (authorize) await authorize();
    assertLeaseRevision(admission);
    // Unscoped disable revokes everything and releases any holder. A true
    // no-op (no grants, no holder) leaves revisions untouched.
    if (!sessionId && !runId) {
      const hadGrants = sessionPrefs.size > 0 || runGrants.size > 0;
      const hadOwner = !!owner;
      if (!hadGrants && !hadOwner) return status();
      sessionPrefs.clear();
      runGrants.clear();
      if (owner) {
        owner = null;
        invalidateFrames();
        bumpEpoch();
        bumpStopEpoch();
        await teardownDriver('disable');
      } else {
        invalidateFrames();
        bumpEpoch();
        bumpStopEpoch();
      }
      return status();
    }
    // Scoped revoke is always a permission barrier: it bumps the lease
    // revision even when the grant does not exist yet, so a pending first
    // enable for the same scope with a captured admission fails instead of
    // inserting. Never the stop revision, never frames/generation, never
    // another holder's worker; holder release below already bumps both.
    if (sessionId) sessionPrefs.delete(sessionId);
    if (runId) {
      const grant = runGrants.get(runId);
      if (!sessionId || !grant || !grant.sessionId || grant.sessionId === sessionId) runGrants.delete(runId);
    } else if (sessionId) {
      for (const [id, grant] of [...runGrants]) {
        if (grant.sessionId === sessionId) runGrants.delete(id);
      }
    }
    if (owner) {
      const matchSession = sessionId ? owner.sessionId === sessionId : false;
      const matchRun = runId ? owner.runId === runId : false;
      const release =
        (sessionId && runId && matchSession && matchRun) ||
        (sessionId && !runId && matchSession) ||
        (!sessionId && runId && matchRun);
      if (release) {
        owner = null;
        invalidateFrames();
        bumpEpoch();
        bumpStopEpoch();
        await teardownDriver('disable');
        return status(sessionId ? { sessionId } : { runId });
      }
    }
    bumpEpoch();
    return status(sessionId ? { sessionId } : { runId });
  }

  async function stop(reason = 'user') {
    const label = typeof reason === 'string' && reason.length <= 100 ? reason : 'user';
    explicitStopping = true;
    try {
      fullReset(label);
      await teardownDriver(label);
      // The explicit retry: every retained close is attempted once more and
      // only verified successes clear. Repeated failures stay poisoned.
      await retryOrphanedCleanups();
    } finally {
      explicitStopping = false;
    }
    return status();
  }

  // Run lifecycle only grants permission, never reserves the holder. Brand
  // new runs with computerUse:true create a run grant (unbound until
  // noteRunSession binds it); runs resuming on an enabled session inherit
  // that session's grant. No frames, epochs, holder or worker are touched.
  async function noteRunStarted(input = {}) {
    const runId = cleanRunId(input.runId);
    if (!runId) throw fail(400, 'Computer Use run binding needs a run id.', 'computer_use_invalid');
    const sessionId = cleanId(input.sessionId);
    if (input.computerUse === true) return enable({ ...input, runId, sessionId });
    if (sessionId && sessionPrefs.get(sessionId)?.enabled === true && !runGrants.has(runId)) {
      const pref = sessionPrefs.get(sessionId);
      const requested = resolveRequestedBackend(input);
      const effective = requested ?? pref?.backend ?? COMPUTER_USE_DEFAULT_BACKEND;
      if (effective === 'cua') await refreshBackends().catch(() => {});
      requireBackendAvailable(effective);
      const next = { backend: effective, sessionId };
      if (typeof input.cwd === 'string' && input.cwd.length <= 4096) next.cwd = input.cwd;
      else if (pref?.cwd) next.cwd = pref.cwd;
      if (pref?.name) next.name = pref.name;
      const routing = grantRouting(input);
      Object.assign(next, routing);
      if (next.computerModel === undefined && pref?.computerModel !== undefined)
        next.computerModel = pref.computerModel;
      if (next.computerThinking === undefined && pref?.computerThinking !== undefined)
        next.computerThinking = pref.computerThinking;
      if (typeof input.imageCapable === 'boolean') next.imageCapable = input.imageCapable;
      else if (pref?.imageCapable !== undefined) next.imageCapable = pref.imageCapable;
      if (typeof input.model === 'string' && input.model.length <= 500) next.model = input.model;
      else if (pref?.model !== undefined) next.model = pref.model;
      runGrants.set(runId, next);
      // Inherited run grants are permission mutations: move the lease
      // revision without touching stop revision, frames or any holder.
      bumpEpoch();
    }
    return status(sessionId ? { sessionId } : { runId });
  }

  // Bind an unbound run draft to its root session. Ensures the session
  // preference so later runs resume. Never invalidates frames or steals the
  // holder; when the holder belongs to this run its display session follows.
  function noteRunSession(runId, sessionId) {
    const clean = cleanId(sessionId);
    if (!runId || !clean) return;
    let mutated = false;
    const grant = runGrants.get(runId);
    if (grant) {
      if (grant.sessionId !== clean) {
        grant.sessionId = clean;
        mutated = true;
      }
      if (!sessionPrefs.has(clean)) {
        sessionPrefs.set(clean, {
          enabled: true,
          ...(grant.cwd ? { cwd: grant.cwd } : {}),
          ...(grant.name ? { name: grant.name } : {}),
          backend: grant.backend ?? COMPUTER_USE_DEFAULT_BACKEND,
          ...(grant.computerModel !== undefined ? { computerModel: grant.computerModel } : {}),
          ...(grant.computerThinking !== undefined ? { computerThinking: grant.computerThinking } : {}),
          ...(grant.imageCapable !== undefined ? { imageCapable: grant.imageCapable } : {}),
          ...(grant.model !== undefined ? { model: grant.model } : {}),
        });
        mutated = true;
      }
    }
    if (owner && owner.runId === runId && owner.sessionId !== clean) {
      owner.sessionId = clean;
      bumpEpoch();
      return;
    }
    // Binding is a permission mutation: lease revision only, never the
    // stop revision, frames or an unrelated holder.
    if (mutated) bumpEpoch();
  }

  // Reserve the single holder for a verified native sub-agent. Async but
  // reservation stays synchronous: no await runs before the busy check and
  // the owner assignment, so concurrent siblings can never both succeed.
  // caller: { ownerId (root run), rootSessionId, sessionId (child session),
  //   agentId, name?, cwd? }. agentId is required; the root (main) agent
  // never holds. Uses the grant backend/routing. Idempotent for the exact
  // same agentId+sessionId+runId; any other agent (including a sibling of
  // the same run) gets 409 computer_use_busy without stealing.
  async function acquire(caller = {}) {
    const runId = cleanRunId(caller.ownerId ?? caller.runId);
    const rootSessionId = cleanId(caller.rootSessionId);
    const agentSessionId = cleanId(caller.sessionId);
    const agentId = cleanId(caller.agentId);
    if (!runId) throw fail(400, 'Computer Use acquire needs a run id.', 'computer_use_invalid');
    if (!agentId)
      throw fail(403, 'Only a native sub-agent can hold the Computer Use desktop.', 'computer_use_denied');
    if (!agentSessionId)
      throw fail(400, 'Computer Use acquire needs the holder session id.', 'computer_use_invalid');
    const found = grantForCaller({ ownerId: runId, rootSessionId });
    if (!found)
      throw fail(
        409,
        'Computer Use is off. Enable it in Studio with the Computer Use toggle before using desktop tools. Tools cannot enable it themselves.',
        'computer_use_disabled',
      );
    if (owner) {
      if (owner.runId === runId && owner.agentId === agentId && owner.agentSessionId === agentSessionId)
        return structuredClone(owner);
      throw fail(
        409,
        'Computer Use is already held by another agent. Only one native agent drives the desktop at a time.',
        'computer_use_busy',
      );
    }
    const { grant } = found;
    if (grant.backend === 'cua') {
      const entry = cuaDescriptor();
      if (!entry.supported)
        throw fail(
          409,
          entry.reason || 'The CUA beta driver needs Windows x64.',
          'computer_use_backend_unsupported',
        );
      if (!entry.available)
        throw fail(409, entry.reason || 'The CUA driver is unavailable.', 'computer_use_backend_unavailable');
    }
    const holder = {
      sessionId: rootSessionId ?? found.sessionId ?? agentSessionId,
      runId,
      agentId,
      agentSessionId,
      backend: grant.backend ?? COMPUTER_USE_DEFAULT_BACKEND,
    };
    const cwd = typeof caller.cwd === 'string' && caller.cwd.length <= 4096 ? caller.cwd : grant.cwd;
    if (cwd) holder.cwd = cwd;
    const name = cleanText(caller.name, 200) ?? grant.name;
    if (name) holder.name = name;
    if (grant.computerModel !== undefined) holder.computerModel = grant.computerModel;
    if (grant.computerThinking !== undefined) holder.computerThinking = grant.computerThinking;
    if (grant.imageCapable !== undefined) holder.imageCapable = grant.imageCapable;
    if (grant.model !== undefined) holder.model = grant.model;
    if (typeof caller.imageCapable === 'boolean') holder.imageCapable = caller.imageCapable;
    if (typeof caller.model === 'string' && caller.model.length <= 500) holder.model = caller.model;
    owner = holder;
    bumpEpoch();
    return structuredClone(owner);
  }

  // Release exactly one native holder. Only the matching run/agent (and the
  // matching child session when given) releases: the holder flips
  // synchronously with frame/epoch invalidation before the driver round
  // trip, permission grants survive. Foreign or repeated releases are
  // no-ops: no epoch bump, no invalidation, no teardown, no revision change.
  async function releaseAgent(runId, agentId, agentSessionId) {
    const cleanRun = cleanRunId(runId);
    const cleanAgent = cleanId(agentId);
    const cleanSession = agentSessionId === undefined ? null : cleanId(agentSessionId);
    if (!cleanRun || !cleanAgent) return status();
    if (!owner || owner.runId !== cleanRun || owner.agentId !== cleanAgent) return status();
    if (cleanSession && owner.agentSessionId !== cleanSession) return status();
    owner = null;
    invalidateFrames();
    bumpEpoch();
    bumpStopEpoch();
    await teardownDriver('release');
    return status();
  }

  // Run cancel/end deletes the run grant and releases a matching holder,
  // but keeps the session preference for the next turn. Holder release is
  // synchronous (null + invalidate + epoch bumps) with only the driver
  // round trip in flight. Deleting a grant without a matching holder never
  // touches another holder's frames, epochs or worker.
  async function releaseRun(runId) {
    const cleanRun = cleanRunId(runId);
    if (!cleanRun) return status();
    const hadGrant = runGrants.delete(cleanRun);
    if (!owner || owner.runId !== cleanRun) {
      // Grant-only revoke is still a permission mutation: lease revision
      // only, never stop revision/frames/worker of another holder.
      if (hadGrant) bumpEpoch();
      return status();
    }
    owner = null;
    invalidateFrames();
    bumpEpoch();
    bumpStopEpoch();
    await teardownDriver('run-end');
    return status();
  }

  function revokeOwner(runId) {
    return releaseRun(runId);
  }

  function setFrame(meta) {
    frameSeq += 1;
    const frameId = `f${frameSeq}`;
    const frame = { ...meta, frameId, generation };
    frames.set(frameId, frame);
    while (frames.size > 4) frames.delete(frames.keys().next().value);
    currentFrameId = frameId;
    return frameId;
  }

  function takeFrame(frameId) {
    return frames.get(frameId) || null;
  }

  function clearFrames() {
    invalidateFrames();
  }

  function recordAction(action) {
    lastAction = { ...action, at: new Date(now()).toISOString() };
  }

  function setError(message) {
    lastError = typeof message === 'string' ? message.slice(0, 1000) : null;
  }

  // Driver-reported emergency hotkey availability. Null means unknown or ok;
  // a string warns the UI not to advertise a shortcut that will not fire.
  function setHotkeyState(input = {}) {
    if (input.registered === false) {
      hotkeyError =
        typeof input.error === 'string' && input.error
          ? input.error.slice(0, 500)
          : 'The desktop stop hotkey is unavailable on this worker.';
    } else {
      hotkeyError = null;
    }
  }

  function track(promise) {
    inflight += 1;
    return Promise.resolve(promise).finally(() => {
      inflight = Math.max(0, inflight - 1);
    });
  }

  async function close() {
    fullReset('shutdown');
    await teardownDriver('shutdown');
    await retryOrphanedCleanups();
  }

  return {
    get generation() {
      return generation;
    },
    get revision() {
      return leaseEpoch;
    },
    status,
    enable,
    disable,
    stop,
    noteRunStarted,
    noteRunSession,
    releaseRun,
    revokeOwner,
    permissionFor,
    acquire,
    releaseAgent,
    ownerInfo,
    releaseInput,
    dropDriverInstance,
    setFrame,
    takeFrame,
    clearFrames,
    recordAction,
    setError,
    setHotkeyState,
    track,
    driver,
    refreshBackends,
    close,
    _debug: () => ({
      owner: publicOwner(),
      prefs: [...sessionPrefs.keys()],
      grants: [...runGrants.keys()],
      generation,
      leaseEpoch,
      currentFrameId,
    }),
  };
}

export function modelSupportsImages(model, catalog) {
  if (!model) return true;
  const entry = (catalog?.models || []).find((item) => item?.id === model);
  if (!entry) return true;
  if (!Array.isArray(entry.input)) return true;
  return entry.input.includes('image');
}
