// Computer Use session lease: one shared real desktop controller per server.
// Opt-in per session, off by default. The manager owns the lease, frame
// generations and driver lifetime. The bridge owns native call routing.
// Never capture or drive the real desktop in tests: inject a fake driver.
//
// Safety rules:
// - Disabling, run end, owner change and shutdown preempt native input
//   through a direct driver.stop call, never behind an action queue.
// - stop() clears every session preference so nothing silently re-enables.
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

  let owner = null;
  const sessionPrefs = new Map();
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

  function publicOwner() {
    if (!owner) return null;
    const out = {};
    if (owner.sessionId) out.sessionId = owner.sessionId;
    if (owner.runId) out.runId = owner.runId;
    if (owner.cwd) out.cwd = owner.cwd;
    if (owner.name) out.name = owner.name;
    if (owner.backend) out.backend = owner.backend;
    return out;
  }

  function ownerInfo() {
    if (!owner) return null;
    return structuredClone(owner);
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
    if (driverPromise) return driverPromise;
    let releaseMint;
    const gate = new Promise((resolve) => (releaseMint = resolve));
    const prior = mintLock;
    mintLock = gate;
    await prior.catch(() => {});
    try {
      if (driverPromise) return driverPromise;
      await teardownChain.catch(() => {});
      // Fail-closed orphaning: a retained worker may still hold the native
      // mutex, so no replacement is minted until an explicit stop verifies
      // every retained close.
      if (orphanedWorkers.size)
        throw fail(
          409,
          `Computer Use cleanup failed: ${orphanedMessage()} Use Stop to retry before re-enabling.`,
          'computer_use_cleanup_failed',
        );
      if (driverPromise) return driverPromise;
      const token = {};
      driverToken = token;
      // The backend is frozen for this driver instance: the lease backend at
      // mint time. A later takeover tears this worker down first, so input
      // can never cross backends.
      const mintedBackend = owner?.backend ?? COMPUTER_USE_DEFAULT_BACKEND;
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

  function status(query = {}) {
    const sessionId = cleanId(query.sessionId);
    const runId = cleanRunId(query.runId);
    const pref = sessionId ? sessionPrefs.get(sessionId) : undefined;
    let enabled;
    if (sessionId || runId) {
      enabled = !!owner;
      if (enabled && sessionId && owner.sessionId !== sessionId) enabled = false;
      if (enabled && runId && owner.runId !== runId) enabled = false;
      if (!owner && pref?.enabled === true) enabled = true;
    } else {
      enabled = !!owner;
    }
    // Between runs (run end releases the owner but keeps the session
    // preference) a scoped query still reports the stored backend so the UI
    // restores CUA instead of silently falling back to native. Truly off
    // stays null, and unscoped queries never expose another session's pref.
    let backend = owner?.backend ?? null;
    if (!owner && pref?.enabled === true) backend = pref.backend ?? COMPUTER_USE_DEFAULT_BACKEND;
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

  async function enable(input = {}) {
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
    const sameOwner =
      !!owner &&
      (sessionId ? owner.sessionId === sessionId : !owner.sessionId) &&
      (runId ? owner.runId === runId : !owner.runId);
    // Availability is validated before any lease mutation, so a request for
    // an unavailable backend never takes another owner offline. An async
    // CUA source is re-queried here; the sync cache already covers static
    // descriptors and the offline default.
    const effective =
      requested ??
      (sameOwner ? (owner.backend ?? COMPUTER_USE_DEFAULT_BACKEND) : COMPUTER_USE_DEFAULT_BACKEND);
    if (effective === 'cua') await refreshBackends().catch(() => {});
    requireBackendAvailable(effective);
    if (sameOwner && requested && requested !== (owner.backend ?? COMPUTER_USE_DEFAULT_BACKEND))
      throw fail(
        409,
        'Computer Use is already enabled with another backend. Disable it first, then enable with the new backend.',
        'computer_use_backend_change',
      );
    const grant = () => {
      invalidateFrames();
      clearLeaseError();
      if (sessionId) sessionPrefs.set(sessionId, { enabled: true, cwd, name, backend: effective });
      owner = {
        ...(sessionId ? { sessionId } : {}),
        ...(runId ? { runId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(name ? { name } : {}),
        backend: effective,
      };
      if (typeof input.imageCapable === 'boolean') owner.imageCapable = input.imageCapable;
      if (typeof input.model === 'string' && input.model.length <= 500) owner.model = input.model;
      bumpEpoch();
    };
    if (owner && !sameOwner) {
      // Single controller handoff: remove the old owner and reserve the
      // epoch first, tear down its worker, then grant only if nothing else
      // (for example a concurrent stop) moved the lease meanwhile. A stop
      // racing the handoff therefore never regrants input.
      const dropped = owner.sessionId;
      if (dropped) sessionPrefs.delete(dropped);
      owner = null;
      invalidateFrames();
      clearLeaseError();
      bumpEpoch();
      bumpStopEpoch();
      const reserved = leaseEpoch;
      await teardownDriver('takeover');
      if (leaseEpoch !== reserved)
        throw fail(
          409,
          'Computer Use changed during handoff. The desktop is off; enable again if still needed.',
          'computer_use_stale_frame',
        );
      grant();
      return status(sessionId ? { sessionId } : runId ? { runId } : {});
    }
    grant();
    return status(sessionId ? { sessionId } : runId ? { runId } : {});
  }

  async function disable(input = {}) {
    const sessionId = cleanId(input.sessionId);
    const runId = cleanRunId(input.runId);
    // Revocation also cancels a pending admission before it has an owner.
    // Do not stop another owner's live driver for a scoped disable.
    bumpEpoch();
    bumpStopEpoch();
    // Lease state flips synchronously so fire-and-forget revocation never
    // leaves owned input behind; only the driver round trip stays in flight.
    const clear = () => {
      const dropped = owner?.sessionId;
      if (dropped) sessionPrefs.delete(dropped);
      owner = null;
      invalidateFrames();
      clearLeaseError();
    };
    if (!sessionId && !runId) {
      clear();
      await teardownDriver('disable');
      return status();
    }
    if (owner) {
      const matchSession = sessionId && owner.sessionId === sessionId;
      const matchRun = runId && owner.runId === runId;
      if (
        (sessionId && !runId && matchSession) ||
        (runId && !sessionId && matchRun) ||
        (sessionId && runId && matchSession && matchRun)
      ) {
        clear();
        await teardownDriver('disable');
      }
    }
    if (sessionId) sessionPrefs.delete(sessionId);
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

  async function noteRunStarted(input = {}) {
    const runId = cleanRunId(input.runId);
    if (!runId) throw fail(400, 'Computer Use run binding needs a run id.', 'computer_use_invalid');
    const sessionId = cleanId(input.sessionId);
    if (input.computerUse === true) return enable({ ...input, runId, sessionId });
    if (sessionId && owner && owner.sessionId === sessionId && !owner.runId) {
      owner.runId = runId;
      if (typeof input.cwd === 'string' && input.cwd.length <= 4096) owner.cwd = input.cwd;
      if (typeof input.imageCapable === 'boolean') owner.imageCapable = input.imageCapable;
      if (typeof input.model === 'string' && input.model.length <= 500) owner.model = input.model;
      bumpEpoch();
      return status({ sessionId });
    }
    if (sessionId && sessionPrefs.get(sessionId)?.enabled === true && !owner) {
      const pref = sessionPrefs.get(sessionId);
      invalidateFrames();
      bumpEpoch();
      owner = {
        sessionId,
        runId,
        ...(pref?.cwd ? { cwd: pref.cwd } : {}),
        ...(typeof input.cwd === 'string' && input.cwd.length <= 4096 ? { cwd: input.cwd } : {}),
        ...(pref?.name ? { name: pref.name } : {}),
        // The lease backend survives run release/resume through the session
        // preference; an explicit request overrides it.
        backend: resolveRequestedBackend(input) ?? pref?.backend ?? COMPUTER_USE_DEFAULT_BACKEND,
      };
      if (typeof input.imageCapable === 'boolean') owner.imageCapable = input.imageCapable;
      if (typeof input.model === 'string' && input.model.length <= 500) owner.model = input.model;
    }
    return status(sessionId ? { sessionId } : { runId });
  }

  function noteRunSession(runId, sessionId) {
    const clean = cleanId(sessionId);
    if (!runId || !clean) return;
    if (owner && owner.runId === runId && !owner.sessionId) {
      owner.sessionId = clean;
      if (!sessionPrefs.has(clean))
        sessionPrefs.set(clean, {
          enabled: true,
          cwd: owner.cwd,
          name: owner.name,
          backend: owner.backend ?? COMPUTER_USE_DEFAULT_BACKEND,
        });
      bumpEpoch();
    }
  }

  async function releaseRun(runId) {
    if (!runId || !owner || owner.runId !== runId) return status();
    // Run cancel/end releases the active controller and preempts its input,
    // but keeps the ephemeral session preference for the next turn. The
    // owner flips synchronously; only the driver round trip stays in flight.
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
    status,
    enable,
    disable,
    stop,
    noteRunStarted,
    noteRunSession,
    releaseRun,
    revokeOwner,
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
