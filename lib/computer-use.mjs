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

async function loadRealDriver(onStop) {
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
 * options: { createDriver, isSupported, now }
 * - createDriver: (options) => driver | Promise<driver>. Receives onStop for
 *   hotkey/native unexpected stops. Lazy: first real request only.
 * - isSupported: boolean override for tests. Default is win32 only.
 */
export function createComputerUseManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const supportedOverride =
    typeof options.isSupported === 'boolean' ? options.isSupported : process.platform === 'win32';
  // The default factory forwards the token-scoped callback like any injected
  // factory: driver() supplies the onStop that belongs to the current worker.
  const factory =
    typeof options.createDriver === 'function'
      ? options.createDriver
      : (opts) => loadRealDriver(opts?.onStop);

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
    const { imageData: _dropped, ...meta } = frame;
    return structuredClone(meta);
  }

  function invalidateFrames() {
    generation += 1;
    currentFrameId = null;
    frames.clear();
  }

  function fullReset(reason) {
    owner = null;
    sessionPrefs.clear();
    invalidateFrames();
    lastError = null;
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
    fullReset(typeof reason === 'string' && reason ? reason.slice(0, 100) : 'native-stop');
    // A natively stopped worker is closed so it cannot leak its process,
    // action mutex or hotkey registration.
    if (pending)
      void Promise.resolve(pending)
        .then((instance) => instance?.close?.())
        .catch(() => {});
  }

  // Shared teardown barrier. Every teardown synchronously detaches the
  // cached worker and its token, clears frames, then stops AND closes that
  // exact instance: stopped helpers are never preserved, so no stop-latched
  // worker, mutex or hotkey can leak into a later lease. driver() mints a
  // replacement only after in-flight cleanup settles.
  let teardownChain = Promise.resolve();
  let mintLock = Promise.resolve();
  let driverInstance = null;

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
      if (driverPromise) return driverPromise;
      const token = {};
      driverToken = token;
      const created = Promise.resolve().then(() =>
        factory({
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
            } catch {
              /* Closing a stopped worker never fails lease bookkeeping. */
            }
          }
        } finally {
          explicitStopping = false;
        }
      });
    teardownChain = work.catch(() => {});
    await work;
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
    let enabled;
    if (sessionId || runId) {
      enabled = !!owner;
      if (enabled && sessionId && owner.sessionId !== sessionId) enabled = false;
      if (enabled && runId && owner.runId !== runId) enabled = false;
      if (!owner && sessionId && sessionPrefs.get(sessionId)?.enabled === true) enabled = true;
    } else {
      enabled = !!owner;
    }
    return {
      supported: supportedOverride,
      enabled,
      owner: publicOwner(),
      busy: inflight > 0,
      hotkey: COMPUTER_USE_HOTKEY,
      hotkeyError,
      controlRevision: stopEpoch,
      lastAction: lastAction ? structuredClone(lastAction) : null,
      lastFrame: publicFrame(),
      error: lastError,
    };
  }

  async function enable(input = {}) {
    requireSupported();
    const sessionId = cleanId(input.sessionId);
    const runId = cleanRunId(input.runId);
    if (!sessionId && !runId)
      throw fail(
        400,
        'Computer Use needs a selected session or the current run to enable.',
        'computer_use_invalid',
      );
    const cwd = typeof input.cwd === 'string' && input.cwd.length <= 4096 ? input.cwd : undefined;
    const name = cleanText(input.name, 200);
    const sameOwner =
      !!owner &&
      (sessionId ? owner.sessionId === sessionId : !owner.sessionId) &&
      (runId ? owner.runId === runId : !owner.runId);
    const grant = () => {
      invalidateFrames();
      lastError = null;
      if (sessionId) sessionPrefs.set(sessionId, { enabled: true, cwd, name });
      owner = {
        ...(sessionId ? { sessionId } : {}),
        ...(runId ? { runId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(name ? { name } : {}),
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
      lastError = null;
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
      lastError = null;
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
        sessionPrefs.set(clean, { enabled: true, cwd: owner.cwd, name: owner.name });
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
