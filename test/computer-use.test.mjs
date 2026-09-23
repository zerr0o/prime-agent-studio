import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createComputerUseManager,
  modelSupportsImages,
  COMPUTER_USE_HOTKEY,
  COMPUTER_USE_BACKENDS,
  COMPUTER_USE_DEFAULT_BACKEND,
} from '../lib/computer-use.mjs';

function fakeDriver(captured = {}) {
  const calls = [];
  const driver = {
    calls,
    stopped: [],
    closed: 0,
    async request(command) {
      calls.push(command);
      if (command.method === 'status')
        return { supported: true, platform: 'win32', hotkey: COMPUTER_USE_HOTKEY };
      throw new Error(`unexpected ${command.method}`);
    },
    async stop(reason) {
      driver.stopped.push(reason || 'user');
    },
    async close() {
      driver.closed++;
    },
  };
  if (captured) captured.driver = driver;
  return driver;
}

const manager = (overrides = {}) =>
  createComputerUseManager({ createDriver: fakeDriver, isSupported: true, ...overrides });

test('computer lease is off by default with a stable status shape', () => {
  const state = manager().status();
  assert.equal(state.supported, true);
  assert.equal(state.enabled, false);
  assert.equal(state.owner, null);
  assert.equal(state.busy, false);
  assert.equal(state.hotkey, COMPUTER_USE_HOTKEY);
  assert.equal(state.lastAction, null);
  assert.equal(state.lastFrame, null);
  assert.equal(state.error, null);
});

test('enabling needs a session or run and reports per query', async () => {
  const computer = manager();
  await assert.rejects(computer.enable({}), /selected session or the current run/);
  await computer.enable({ sessionId: 'sess-1', cwd: '/tmp/proj' });
  assert.equal(computer.status().enabled, true);
  assert.deepEqual(computer.status().owner, { sessionId: 'sess-1', cwd: '/tmp/proj', backend: 'native' });
  assert.equal(computer.status({ sessionId: 'sess-1' }).enabled, true);
  assert.equal(computer.status({ sessionId: 'other' }).enabled, false);
  assert.equal(computer.status({ runId: 'nope' }).enabled, false);
});

test('unsupported platform fails enable with a clear error', async () => {
  const computer = createComputerUseManager({ createDriver: fakeDriver, isSupported: false });
  assert.equal(computer.status().supported, false);
  await assert.rejects(computer.enable({ sessionId: 'sess-1' }), /Windows/);
});

test('disable preempts native input without cancelling anything else', async () => {
  const driver = fakeDriver();
  const computer = createComputerUseManager({ createDriver: () => driver, isSupported: true });
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  await computer.driver();
  await computer.disable({ sessionId: 'sess-1' });
  assert.equal(computer.status().enabled, false);
  assert.deepEqual(driver.stopped, ['disable']);
  assert.equal(driver.closed, 1);
});

test('stop clears every session preference and resets the worker', async () => {
  const driver = fakeDriver();
  const computer = createComputerUseManager({ createDriver: () => driver, isSupported: true });
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  await computer.driver();
  await computer.stop('test-reason');
  assert.equal(computer.status().enabled, false);
  assert.equal(computer.status({ sessionId: 'sess-1' }).enabled, false);
  assert.deepEqual(driver.stopped, ['test-reason']);
  assert.equal(driver.closed, 1);
  assert.equal(computer.status().lastAction.type, 'stop');
});

test('switching owner stops prior input before any new input', async () => {
  const driver = fakeDriver();
  const computer = createComputerUseManager({ createDriver: () => driver, isSupported: true });
  await computer.enable({ sessionId: 'sess-a', runId: 'run-a' });
  await computer.driver();
  await computer.enable({ sessionId: 'sess-b', runId: 'run-b' });
  assert.deepEqual(driver.stopped, ['takeover']);
  assert.deepEqual(computer.status().owner, { sessionId: 'sess-b', runId: 'run-b', backend: 'native' });
});

test('native hotkey stop resets owner, frames and every preference', async () => {
  let onStop = null;
  const driver = fakeDriver();
  const computer = createComputerUseManager({
    createDriver: (options) => {
      onStop = options.onStop;
      return driver;
    },
    isSupported: true,
  });
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  await computer.driver();
  assert.equal(typeof onStop, 'function');
  computer.setFrame({
    width: 10,
    height: 10,
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    capturedAt: 't',
  });
  onStop('hotkey');
  assert.equal(computer.status().enabled, false);
  assert.equal(computer.status({ sessionId: 'sess-1' }).enabled, false);
  assert.equal(computer.status().lastFrame, null);
  assert.equal(computer.status().lastAction.reason, 'hotkey');
  assert.deepEqual(driver.stopped, []);
});

test('explicit stop acknowledgement cannot recurse into a reset', async () => {
  const driver = fakeDriver();
  let onStop = null;
  const computer = createComputerUseManager({
    createDriver: (options) => {
      onStop = options.onStop;
      return driver;
    },
    isSupported: true,
  });
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  await computer.driver();
  const stopping = computer.stop('user');
  onStop('late-ack');
  await stopping;
  assert.equal(computer.status().enabled, false);
  assert.deepEqual(driver.stopped, ['user']);
});

test('run end preempts input but keeps the session preference', async () => {
  const driver = fakeDriver();
  const computer = createComputerUseManager({ createDriver: () => driver, isSupported: true });
  await computer.enable({ sessionId: 'sess-9', cwd: '/tmp/p' });
  await computer.noteRunStarted({ sessionId: 'sess-9', runId: 'run-9', cwd: '/tmp/p' });
  assert.equal(computer.status({ runId: 'run-9' }).enabled, true);
  await computer.driver();
  await computer.releaseRun('run-9');
  assert.deepEqual(driver.stopped, ['run-end']);
  assert.equal(computer.status().enabled, false);
  assert.equal(computer.status({ sessionId: 'sess-9' }).enabled, true);
  await computer.noteRunStarted({ sessionId: 'sess-9', runId: 'run-10', cwd: '/tmp/p' });
  assert.equal(computer.status({ runId: 'run-10' }).enabled, true);
});

test('brand new runs bind before the native session id arrives', async () => {
  const computer = manager();
  await computer.noteRunStarted({ sessionId: null, runId: 'run-new', cwd: '/tmp/p', computerUse: true });
  assert.equal(computer.status({ runId: 'run-new' }).enabled, true);
  computer.noteRunSession('run-new', 'sess-new');
  assert.deepEqual(computer.status().owner, {
    sessionId: 'sess-new',
    runId: 'run-new',
    cwd: '/tmp/p',
    backend: 'native',
  });
  await computer.releaseRun('run-new');
  assert.equal(computer.status({ sessionId: 'sess-new' }).enabled, true);
});

test('stop clears the session preference so nothing re-enables implicitly', async () => {
  const computer = manager();
  await computer.enable({ sessionId: 'sess-1', cwd: '/tmp/p' });
  await computer.stop();
  assert.equal(computer.status({ sessionId: 'sess-1' }).enabled, false);
  await computer.noteRunStarted({ sessionId: 'sess-1', runId: 'run-x', cwd: '/tmp/p' });
  assert.equal(computer.status({ runId: 'run-x' }).enabled, false);
});

test('frames invalidate across generations and carry no pixels in status', async () => {
  const computer = manager();
  await computer.enable({ sessionId: 'sess-1' });
  const id = computer.setFrame({
    width: 800,
    height: 600,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    capturedAt: 't',
  });
  assert.ok(computer.takeFrame(id));
  assert.ok(computer.status().lastFrame && !('imageData' in computer.status().lastFrame));
  computer.clearFrames();
  assert.equal(computer.takeFrame(id), null);
  assert.equal(computer.status().lastFrame, null);
});

test('model image capability treats unknown catalog entries as capable', () => {
  assert.equal(modelSupportsImages('openai/gpt-x', { models: [] }), true);
  assert.equal(modelSupportsImages(null, null), true);
  assert.equal(modelSupportsImages('m/a', { models: [{ id: 'm/a', input: ['text', 'image'] }] }), true);
  assert.equal(modelSupportsImages('m/a', { models: [{ id: 'm/a', input: ['text'] }] }), false);
});

function gatedDriver() {
  const driver = fakeDriver();
  let release;
  driver.stopGate = new Promise((resolve) => (release = resolve));
  driver.releaseStop = release;
  const inner = driver.stop.bind(driver);
  driver.stop = async (reason) => {
    await driver.stopGate;
    return inner(reason);
  };
  return driver;
}

test('release flips the lease synchronously before the preempt round trip', async () => {
  const driver = gatedDriver();
  const computer = createComputerUseManager({ createDriver: () => driver, isSupported: true });
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  await computer.driver();
  computer.setFrame({
    width: 10,
    height: 10,
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    capturedAt: 't',
  });
  const pending = computer.releaseRun('run-1');
  assert.equal(computer.status().owner, null);
  assert.equal(computer.status().lastFrame, null);
  assert.equal(computer.status({ sessionId: 'sess-1' }).enabled, true);
  driver.releaseStop();
  await pending;
  assert.deepEqual(driver.stopped, ['run-end']);
});

test('a stop racing a takeover voids the grant instead of resurrecting input', async () => {
  const driver = gatedDriver();
  const computer = createComputerUseManager({ createDriver: () => driver, isSupported: true });
  await computer.enable({ sessionId: 'sess-a', runId: 'run-a' });
  await computer.driver();
  const takeover = computer.enable({ sessionId: 'sess-b', runId: 'run-b' });
  const stopping = computer.stop('user');
  driver.releaseStop();
  await assert.rejects(takeover, /changed during handoff/);
  assert.equal((await stopping).enabled, false);
  assert.equal(computer.status().owner, null);
  // The takeover teardown already stops and closes the detached worker, so
  // the racing stop has nothing left to preempt and must never regrant.
  assert.deepEqual(driver.stopped, ['takeover']);
  assert.equal(driver.closed, 1);
});

test('late stop callbacks from a replaced worker are ignored', async () => {
  const workers = [];
  const computer = createComputerUseManager({
    createDriver: (options) => {
      const worker = fakeDriver();
      worker.scopedOnStop = options?.onStop;
      workers.push(worker);
      return worker;
    },
    isSupported: true,
  });
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  const first = await computer.driver();
  assert.equal(typeof workers[0].scopedOnStop, 'function');
  computer.dropDriverInstance(first);
  await computer.driver();
  assert.equal(workers.length, 2);
  workers[0].scopedOnStop('late');
  assert.deepEqual(computer.status().owner, { sessionId: 'sess-1', runId: 'run-1', backend: 'native' });
  workers[1].scopedOnStop('hotkey');
  assert.equal(computer.status().enabled, false);
  assert.equal(computer.status().lastAction.reason, 'hotkey');
});

test(
  'default factory forwards the scoped stop callback to the real driver',
  { skip: process.platform === 'win32' },
  async (t) => {
    const computer = createComputerUseManager({ isSupported: true });
    t.after(() => computer.close());
    await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
    const real = await computer.driver();
    assert.equal(typeof real.stop, 'function');
    await real.stop('probe');
    assert.equal(computer.status().enabled, false);
    assert.equal(computer.status().lastAction.reason, 'probe');
  },
);

test('emergency hotkey availability is reported without changing the shortcut', async () => {
  const computer = manager();
  assert.equal(computer.status().hotkey, COMPUTER_USE_HOTKEY);
  assert.equal(computer.status().hotkeyError, null);
  computer.setHotkeyState({ registered: false, error: 'Registration denied.' });
  assert.equal(computer.status().hotkeyError, 'Registration denied.');
  computer.setHotkeyState({ registered: false });
  assert.match(computer.status().hotkeyError, /unavailable/);
  computer.setHotkeyState({ registered: true });
  assert.equal(computer.status().hotkeyError, null);
});

test('a new owner sends no input until prior teardown settles', async () => {
  let creations = 0;
  const driver = gatedDriver();
  const computer = createComputerUseManager({
    createDriver: () => {
      creations++;
      return driver;
    },
    isSupported: true,
  });
  await computer.enable({ sessionId: 'sess-a', runId: 'run-a' });
  await computer.driver();
  assert.equal(creations, 1);
  const disabling = computer.disable({ sessionId: 'sess-a' });
  await computer.enable({ sessionId: 'sess-b', runId: 'run-b' });
  let settled = false;
  const waiting = computer.driver().then((instance) => {
    settled = true;
    return instance;
  });
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(settled, false);
  assert.equal(creations, 1);
  driver.releaseStop();
  await disabling;
  const instance = await waiting;
  assert.equal(settled, true);
  assert.equal(creations, 2);
  assert.ok(instance);
});

test('scoped disable cancels a takeover whose new owner is still pending', { timeout: 5000 }, async () => {
  const driver = gatedDriver();
  const computer = createComputerUseManager({ createDriver: () => driver, isSupported: true });
  await computer.enable({ sessionId: 'sess-a', runId: 'run-a' });
  await computer.driver();
  const takeover = computer.enable({ sessionId: 'sess-b', runId: 'run-b' });
  const rejected = assert.rejects(takeover, /changed during handoff/);
  try {
    assert.equal(computer.status().owner, null);
    await computer.disable({ sessionId: 'sess-b' });
    driver.releaseStop();
    await rejected;
    assert.equal(computer.status().owner, null);
    assert.equal(computer.status({ sessionId: 'sess-b' }).enabled, false);
    assert.equal(driver.closed, 1);
  } finally {
    driver.releaseStop();
    await takeover.catch(() => {});
    await computer.close();
  }
});

// ---- Backend selection: native default, cua beta opt-in, no silent fallback ----

const cuaAvailable = () => ({ available: true, supported: true, version: '0.28.2' });
const cuaMissing = () => ({ available: false, supported: true, reason: 'CUA artifacts missing.' });

test('backend contract constants stay stable for integrators', () => {
  assert.deepEqual(COMPUTER_USE_BACKENDS, ['native', 'cua']);
  assert.equal(COMPUTER_USE_DEFAULT_BACKEND, 'native');
});

test('status reports the active backend and per-backend availability without paths', () => {
  const computer = createComputerUseManager({
    createDriver: fakeDriver,
    isSupported: true,
    cuaAvailability: { available: true, supported: true, version: '0.28.2', path: 'C:\\secret\\cua' },
  });
  const state = computer.status();
  assert.equal(state.backend, null);
  assert.deepEqual(state.backends, [
    { id: 'native', supported: true, available: true },
    { id: 'cua', supported: true, available: true, version: '0.28.2' },
  ]);
  assert.ok(!JSON.stringify(state).includes('secret'));
});

test('native stays the compatibility default and reaches the factory', async () => {
  const seen = [];
  const computer = createComputerUseManager({
    createDriver: (options) => {
      seen.push(options?.backend);
      return fakeDriver();
    },
    isSupported: true,
  });
  const state = await computer.enable({ sessionId: 'sess-1' });
  assert.equal(state.backend, 'native');
  assert.deepEqual(state.owner, { sessionId: 'sess-1', backend: 'native' });
  await computer.driver();
  assert.deepEqual(seen, ['native']);
});

test('explicit cua enable binds the lease backend and freezes it for the driver', async () => {
  const seen = [];
  const computer = createComputerUseManager({
    createDriver: (options) => {
      seen.push(options?.backend);
      return fakeDriver();
    },
    isSupported: true,
    cuaAvailability: cuaAvailable(),
  });
  const state = await computer.enable({ sessionId: 'sess-1', runId: 'run-1', backend: 'cua' });
  assert.equal(state.backend, 'cua');
  assert.deepEqual(state.owner, { sessionId: 'sess-1', runId: 'run-1', backend: 'cua' });
  assert.ok(await computer.driver());
  assert.deepEqual(seen, ['cua']);
});

test('unknown backends fail fast with a validation error', async () => {
  const computer = manager();
  await assert.rejects(
    computer.enable({ sessionId: 'sess-1', backend: 'quantum' }),
    /Unknown Computer Use backend/,
  );
  assert.equal(computer.status().enabled, false);
});

test('unavailable cua never takes another owner offline', async () => {
  const driver = fakeDriver();
  const computer = createComputerUseManager({
    createDriver: () => driver,
    isSupported: true,
    cuaAvailability: cuaMissing(),
  });
  await computer.enable({ sessionId: 'sess-a', runId: 'run-a' });
  await computer.driver();
  await assert.rejects(
    computer.enable({ sessionId: 'sess-b', runId: 'run-b', backend: 'cua' }),
    /CUA artifacts missing/,
  );
  assert.deepEqual(driver.stopped, []);
  assert.deepEqual(computer.status().owner, { sessionId: 'sess-a', runId: 'run-a', backend: 'native' });
  assert.equal(computer.status().backend, 'native');
});

test('the active backend cannot change without an explicit disable first', async () => {
  const driver = fakeDriver();
  const computer = createComputerUseManager({
    createDriver: () => driver,
    isSupported: true,
    cuaAvailability: cuaAvailable(),
  });
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  await computer.driver();
  await assert.rejects(
    computer.enable({ sessionId: 'sess-1', runId: 'run-1', backend: 'cua' }),
    /Disable it first/,
  );
  assert.equal(computer.status().backend, 'native');
  assert.deepEqual(driver.stopped, []);
  await computer.disable({ sessionId: 'sess-1' });
  const state = await computer.enable({ sessionId: 'sess-1', runId: 'run-1', backend: 'cua' });
  assert.equal(state.backend, 'cua');
});

test('a new owner can take over with an available backend through the epoch fence', async () => {
  const seen = [];
  const first = fakeDriver();
  const second = fakeDriver();
  let creations = 0;
  const computer = createComputerUseManager({
    createDriver: (options) => {
      seen.push(options?.backend);
      creations += 1;
      return creations === 1 ? first : second;
    },
    isSupported: true,
    cuaAvailability: cuaAvailable(),
  });
  await computer.enable({ sessionId: 'sess-a', runId: 'run-a' });
  await computer.driver();
  const state = await computer.enable({ sessionId: 'sess-b', runId: 'run-b', backend: 'cua' });
  assert.equal(state.backend, 'cua');
  assert.deepEqual(first.stopped, ['takeover']);
  // The factory is lazy: the new backend worker mints on first real request.
  const current = await computer.driver();
  assert.equal(current, second);
  assert.deepEqual(seen, ['native', 'cua']);
});

test('the backend survives run release and resume, stop clears it', async () => {
  const computer = createComputerUseManager({
    createDriver: fakeDriver,
    isSupported: true,
    cuaAvailability: cuaAvailable(),
  });
  await computer.enable({ sessionId: 'sess-9', cwd: '/tmp/p', backend: 'cua' });
  await computer.noteRunStarted({ sessionId: 'sess-9', runId: 'run-9', cwd: '/tmp/p' });
  assert.equal(computer.status().backend, 'cua');
  await computer.releaseRun('run-9');
  assert.equal(computer.status().backend, null);
  await computer.noteRunStarted({ sessionId: 'sess-9', runId: 'run-10', cwd: '/tmp/p' });
  assert.equal(computer.status().backend, 'cua');
  assert.deepEqual(computer.status().owner, {
    sessionId: 'sess-9',
    runId: 'run-10',
    cwd: '/tmp/p',
    backend: 'cua',
  });
  await computer.stop();
  assert.equal(computer.status({ sessionId: 'sess-9' }).enabled, false);
  assert.equal(computer.status().backend, null);
});

test('run binding accepts computerUseBackend and inherits the preference when omitted', async () => {
  const computer = createComputerUseManager({
    createDriver: fakeDriver,
    isSupported: true,
    cuaAvailability: cuaAvailable(),
  });
  await computer.noteRunStarted({
    sessionId: 'sess-1',
    runId: 'run-1',
    cwd: '/tmp/p',
    computerUse: true,
    computerUseBackend: 'cua',
  });
  assert.equal(computer.status().backend, 'cua');
  await computer.releaseRun('run-1');
  await computer.noteRunStarted({ sessionId: 'sess-1', runId: 'run-2', cwd: '/tmp/p' });
  assert.equal(computer.status().backend, 'cua');
});

test('run session binding preserves the lease backend', async () => {
  const computer = createComputerUseManager({
    createDriver: fakeDriver,
    isSupported: true,
    cuaAvailability: cuaAvailable(),
  });
  await computer.noteRunStarted({
    sessionId: null,
    runId: 'run-new',
    cwd: '/tmp/p',
    computerUse: true,
    backend: 'cua',
  });
  computer.noteRunSession('run-new', 'sess-new');
  assert.equal(computer.status().backend, 'cua');
  await computer.releaseRun('run-new');
  assert.equal(computer.status({ sessionId: 'sess-new' }).enabled, true);
  await computer.noteRunStarted({ sessionId: 'sess-new', runId: 'run-next', cwd: '/tmp/p' });
  assert.equal(computer.status().backend, 'cua');
});

test('unsupported cua reports the x64 gate without touching the lease', async () => {
  const computer = createComputerUseManager({
    createDriver: fakeDriver,
    isSupported: true,
    cuaAvailability: { available: false, supported: false },
  });
  await assert.rejects(computer.enable({ sessionId: 'sess-1', backend: 'cua' }), /x64/);
  assert.equal(computer.status().enabled, false);
});

test('async availability sources resolve through refresh without spawning workers', async () => {
  const computer = createComputerUseManager({
    createDriver: fakeDriver,
    isSupported: true,
    getCuaAvailability: async () => ({
      available: true,
      supported: true,
      backend: 'cua',
      path: '/hidden/cua',
      version: '0.28.2',
    }),
  });
  const backends = await computer.refreshBackends();
  assert.deepEqual(backends, [
    { id: 'native', supported: true, available: true },
    { id: 'cua', supported: true, available: true, version: '0.28.2' },
  ]);
  const state = await computer.enable({ sessionId: 'sess-1', backend: 'cua' });
  assert.equal(state.backend, 'cua');
});

test('full static backend descriptors override both entries for offline tests', async () => {
  const computer = createComputerUseManager({
    createDriver: fakeDriver,
    isSupported: true,
    backends: [
      { id: 'native', supported: true, available: true },
      { id: 'cua', supported: true, available: true, reason: 'Beta pool.', version: '9.9' },
    ],
  });
  assert.deepEqual(computer.status().backends[1], {
    id: 'cua',
    supported: true,
    available: true,
    reason: 'Beta pool.',
    version: '9.9',
  });
  assert.equal((await computer.enable({ sessionId: 'sess-1', backend: 'cua' })).backend, 'cua');
});

test('a failing cua factory never replays on native', async (t) => {
  const calls = [];
  const nativeDriver = fakeDriver();
  const computer = createComputerUseManager({
    createDriver: (options) => {
      calls.push(options?.backend);
      if (options?.backend === 'cua') throw Object.assign(new Error('cua worker down'), { status: 409 });
      return nativeDriver;
    },
    isSupported: true,
    cuaAvailability: cuaAvailable(),
  });
  t.after(() => computer.close());
  await computer.enable({ sessionId: 'sess-1', backend: 'cua' });
  await assert.rejects(computer.driver(), /cua worker down/);
  // Only the requested backend was attempted: no implicit native replay.
  assert.deepEqual(calls, ['cua']);
  assert.equal(computer.status().backend, 'cua');
});

test('public frames omit opaque driverFrame but keep backend and kind', async () => {
  const computer = createComputerUseManager({
    createDriver: fakeDriver,
    isSupported: true,
    cuaAvailability: cuaAvailable(),
  });
  await computer.enable({ sessionId: 'sess-1', backend: 'cua' });
  const id = computer.setFrame({
    width: 800,
    height: 600,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    capturedAt: 't',
    backend: 'cua',
    kind: 'cua',
    driverFrame: { pid: 1234, window: 'hwnd-9', snapshot: 'raw', sessionLabel: 'secret' },
    imageData: 'pixels',
  });
  const stored = computer.takeFrame(id);
  assert.deepEqual(stored.driverFrame, {
    pid: 1234,
    window: 'hwnd-9',
    snapshot: 'raw',
    sessionLabel: 'secret',
  });
  const meta = computer.status().lastFrame;
  assert.equal(meta.backend, 'cua');
  assert.equal(meta.kind, 'cua');
  assert.ok(!('driverFrame' in meta));
  assert.ok(!('imageData' in meta));
  assert.ok(!JSON.stringify(meta).includes('secret'));
});

test('a natively stopped worker closes on the teardown barrier before any remint', async (t) => {
  let onStop = null;
  let releaseClose;
  const closeGate = new Promise((resolve) => {
    releaseClose = resolve;
  });
  const seen = [];
  let closeCalls = 0;
  const worker = fakeDriver();
  worker.close = async () => {
    closeCalls += 1;
    await closeGate;
  };
  const computer = createComputerUseManager({
    createDriver: (options) => {
      onStop = options.onStop;
      seen.push(options?.backend);
      return worker;
    },
    isSupported: true,
    cuaAvailability: cuaAvailable(),
  });
  try {
    await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
    await computer.driver();
    assert.deepEqual(seen, ['native']);
    onStop('hotkey');
    // Synchronous invalidation: lease and frames drop immediately.
    assert.equal(computer.status().enabled, false);
    assert.equal(computer.status().lastAction.reason, 'hotkey');
    // Re-enable on the same backend while the old close is still pending:
    // the replacement must not mint until the barrier settles.
    await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
    let minted = false;
    const waiting = computer.driver().then((instance) => {
      minted = true;
      return instance;
    });
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(minted, false);
    assert.equal(closeCalls, 1);
    releaseClose();
    assert.ok(await waiting);
    assert.equal(minted, true);
    assert.deepEqual(seen, ['native', 'native']);
    // Same guarantee when switching backends after an explicit disable.
    await computer.disable({ sessionId: 'sess-1' });
    await computer.enable({ sessionId: 'sess-1', runId: 'run-1', backend: 'cua' });
    assert.ok(await computer.driver());
    assert.deepEqual(seen, ['native', 'native', 'cua']);
    assert.equal(closeCalls, 2);
  } finally {
    releaseClose();
    await computer.close();
  }
});

test('an explicit stop retries a failed close and clears on verified success', async (t) => {
  let onStop = null;
  let closes = 0;
  const worker = fakeDriver();
  worker.close = async () => {
    closes += 1;
    if (closes === 1) throw new Error('tree still alive');
  };
  const computer = createComputerUseManager({
    createDriver: (options) => {
      onStop = options.onStop;
      return worker;
    },
    isSupported: true,
  });
  t.after(() => computer.close());
  await computer.enable({ sessionId: 'sess-1' });
  await computer.driver();
  onStop('hotkey');
  assert.equal(computer.status().enabled, false);
  await computer.enable({ sessionId: 'sess-1' });
  // The retained close failed, so minting refuses while safety is unknown.
  await assert.rejects(computer.driver(), /cleanup failed/);
  assert.match(computer.status().error, /cleanup failed/i);
  // The explicit stop retries the retained instance and verifies success.
  await computer.stop('user');
  assert.equal(closes, 2);
  assert.equal(computer.status().error, null);
  await computer.enable({ sessionId: 'sess-1' });
  assert.ok(await computer.driver());
  assert.equal(closes, 2);
});

test('repeated cleanup failures stay poisoned across stops and enables', async (t) => {
  let onStop = null;
  let closes = 0;
  const worker = fakeDriver();
  worker.close = async () => {
    closes += 1;
    throw new Error('guardian locked');
  };
  const computer = createComputerUseManager({
    createDriver: (options) => {
      onStop = options.onStop;
      return worker;
    },
    isSupported: true,
  });
  t.after(() => computer.close());
  await computer.enable({ sessionId: 'sess-1' });
  await computer.driver();
  onStop('hotkey');
  await computer.enable({ sessionId: 'sess-1' });
  await assert.rejects(computer.driver(), /cleanup failed/);
  // An explicit stop retries but the worker still refuses: poison remains,
  // and the re-enable must not clear the uncertainty.
  await computer.stop('user');
  assert.equal(closes, 2);
  await assert.rejects(computer.driver(), /cleanup failed/);
  assert.match(computer.status().error, /guardian locked/);
  await computer.enable({ sessionId: 'sess-1' });
  assert.match(computer.status().error, /guardian locked/);
  await assert.rejects(computer.driver(), /cleanup failed/);
  // A second stop retries again instead of wedging silently.
  await computer.stop('user');
  assert.equal(closes, 3);
  await assert.rejects(computer.driver(), /cleanup failed/);
});

test('a failed teardown close is retained until an explicit stop verifies', async (t) => {
  let closes = 0;
  const worker = fakeDriver();
  worker.close = async () => {
    closes += 1;
    if (closes === 1) throw new Error('teardown close refused');
  };
  const computer = createComputerUseManager({
    createDriver: () => worker,
    isSupported: true,
  });
  t.after(() => computer.close());
  await computer.enable({ sessionId: 'sess-1' });
  await computer.driver();
  // The explicit disable tears down, but its close fails: the worker may
  // still be alive, so the next lease must not mint.
  await computer.disable({ sessionId: 'sess-1' });
  assert.equal(computer.status().enabled, false);
  await computer.enable({ sessionId: 'sess-1' });
  await assert.rejects(computer.driver(), /cleanup failed/);
  // The explicit stop retries the retained instance and verifies success.
  await computer.stop('user');
  assert.equal(closes, 2);
  await computer.enable({ sessionId: 'sess-1' });
  assert.ok(await computer.driver());
});

test('scoped status exposes the preference backend after run end, null when truly off', async () => {
  const computer = createComputerUseManager({
    createDriver: fakeDriver,
    isSupported: true,
    cuaAvailability: cuaAvailable(),
  });
  await computer.enable({ sessionId: 'sess-9', cwd: '/tmp/p', backend: 'cua' });
  await computer.noteRunStarted({ sessionId: 'sess-9', runId: 'run-9', cwd: '/tmp/p' });
  await computer.driver();
  await computer.releaseRun('run-9');
  const scoped = computer.status({ sessionId: 'sess-9' });
  assert.equal(scoped.enabled, true);
  assert.equal(scoped.backend, 'cua');
  // Unscoped and foreign-scoped queries never leak the stored preference.
  assert.equal(computer.status().backend, null);
  assert.equal(computer.status({ sessionId: 'other' }).backend, null);
  await computer.stop();
  const off = computer.status({ sessionId: 'sess-9' });
  assert.equal(off.enabled, false);
  assert.equal(off.backend, null);
});

test('backend availability refresh is TTL-gated and forceable', async () => {
  let calls = 0;
  let tick = 1000;
  const computer = createComputerUseManager({
    createDriver: fakeDriver,
    isSupported: true,
    // Async sources are called once synchronously at construction to seed.
    getCuaAvailability: async () => {
      calls += 1;
      return { available: true, supported: true };
    },
    availabilityTtlMs: 100,
    now: () => tick,
  });
  assert.equal(calls, 1);
  await computer.refreshBackends();
  assert.equal(calls, 2);
  await computer.refreshBackends();
  assert.equal(calls, 2);
  tick += 150;
  await computer.refreshBackends();
  assert.equal(calls, 3);
  await computer.refreshBackends({ force: true });
  assert.equal(calls, 4);
});

test('a failed teardown close surfaces cleanup flags without faking lease state', async (t) => {
  const worker = fakeDriver();
  worker.close = async () => {
    throw new Error('teardown close refused');
  };
  const computer = createComputerUseManager({ createDriver: () => worker, isSupported: true });
  t.after(() => computer.close());
  const idle = computer.status();
  assert.equal(idle.cleanupPending, false);
  assert.equal(idle.cleanupFailed, false);
  await computer.enable({ sessionId: 'sess-1' });
  await computer.driver();
  await computer.disable({ sessionId: 'sess-1' });
  const failed = computer.status();
  assert.equal(failed.enabled, false);
  assert.equal(failed.owner, null);
  assert.equal(failed.busy, false);
  assert.equal(failed.cleanupPending, false);
  assert.equal(failed.cleanupFailed, true);
});

test('a verified stop retry closes the same instance and clears cleanup flags', async (t) => {
  let closes = 0;
  const worker = fakeDriver();
  worker.close = async () => {
    closes += 1;
    if (closes === 1) throw new Error('first close refused');
  };
  const computer = createComputerUseManager({ createDriver: () => worker, isSupported: true });
  t.after(() => computer.close());
  await computer.enable({ sessionId: 'sess-1' });
  assert.equal(await computer.driver(), worker);
  await computer.disable({ sessionId: 'sess-1' });
  assert.equal(computer.status().cleanupFailed, true);
  await computer.stop('user');
  assert.equal(closes, 2);
  const cleared = computer.status();
  assert.equal(cleared.cleanupFailed, false);
  assert.equal(cleared.cleanupPending, false);
});

test('an in-flight native-stop close surfaces cleanupPending', async (t) => {
  let onStop = null;
  let releaseClose;
  const closeGate = new Promise((resolve) => {
    releaseClose = resolve;
  });
  const worker = fakeDriver();
  worker.close = async () => {
    await closeGate;
  };
  const computer = createComputerUseManager({
    createDriver: (options) => {
      onStop = options.onStop;
      return worker;
    },
    isSupported: true,
  });
  try {
    await computer.enable({ sessionId: 'sess-1' });
    await computer.driver();
    onStop('hotkey');
    assert.equal(computer.status().enabled, false);
    assert.equal(computer.status().cleanupPending, true);
    releaseClose();
    assert.ok(await computer.driver());
    await new Promise((done) => setTimeout(done, 20));
    const settled = computer.status();
    assert.equal(settled.cleanupPending, false);
    assert.equal(settled.cleanupFailed, false);
  } finally {
    releaseClose();
    await computer.close();
  }
});
