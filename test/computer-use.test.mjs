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

// Permission/lease split: enable() grants permission only (never a holder).
// Fake native sub-agents acquire the single holder before driving.
function childCaller({ runId, sessionId, agentId = 'agent-1', childSession, name, cwd }) {
  return {
    ownerId: runId,
    rootSessionId: sessionId,
    sessionId: childSession ?? `child-${agentId}-${runId ?? sessionId ?? 'x'}`,
    agentId,
    ...(name ? { name } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function acquireChild(computer, opts) {
  return computer.acquire(childCaller(opts));
}

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
  // Permission only: enabled, but no holder until a child acquires.
  assert.equal(computer.status().enabled, true);
  assert.equal(computer.status().owner, null);
  assert.equal(computer.status({ sessionId: 'sess-1' }).enabled, true);
  assert.equal(computer.status({ sessionId: 'sess-1' }).backend, 'native');
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
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
  await computer.driver();
  await computer.stop('test-reason');
  assert.equal(computer.status().enabled, false);
  assert.equal(computer.status({ sessionId: 'sess-1' }).enabled, false);
  assert.deepEqual(driver.stopped, ['test-reason']);
  assert.equal(driver.closed, 1);
  assert.equal(computer.status().lastAction.type, 'stop');
});

test('a second permission never steals the holder or stops its input', async () => {
  const driver = fakeDriver();
  const computer = createComputerUseManager({ createDriver: () => driver, isSupported: true });
  await computer.enable({ sessionId: 'sess-a', runId: 'run-a' });
  acquireChild(computer, { runId: 'run-a', sessionId: 'sess-a', agentId: 'agent-a' });
  await computer.driver();
  // Second scope grants permission only: no teardown, no holder steal.
  await computer.enable({ sessionId: 'sess-b', runId: 'run-b' });
  assert.deepEqual(driver.stopped, []);
  assert.deepEqual(computer.status().owner, {
    sessionId: 'sess-a',
    runId: 'run-a',
    agentId: 'agent-a',
    agentSessionId: 'child-agent-a-run-a',
    backend: 'native',
  });
  assert.equal(computer.status({ sessionId: 'sess-a' }).enabled, true);
  assert.equal(computer.status({ sessionId: 'sess-b' }).enabled, true);
  assert.equal(computer.status({ runId: 'run-b' }).enabled, true);
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
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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
  acquireChild(computer, { runId: 'run-9', sessionId: 'sess-9' });
  await computer.driver();
  await computer.releaseRun('run-9');
  assert.deepEqual(driver.stopped, ['run-end']);
  // The run grant is gone but the session preference survives, so unscoped
  // permission stays on while the holder is released.
  assert.equal(computer.status().owner, null);
  assert.equal(computer.status().enabled, true);
  assert.equal(computer.status({ sessionId: 'sess-9' }).enabled, true);
  assert.equal(computer.status({ runId: 'run-9' }).enabled, false);
  await computer.noteRunStarted({ sessionId: 'sess-9', runId: 'run-10', cwd: '/tmp/p' });
  assert.equal(computer.status({ runId: 'run-10' }).enabled, true);
});

test('brand new runs bind before the native session id arrives', async () => {
  const computer = manager();
  await computer.noteRunStarted({ sessionId: null, runId: 'run-new', cwd: '/tmp/p', computerUse: true });
  assert.equal(computer.status({ runId: 'run-new' }).enabled, true);
  // Binding is permission-only: no holder until a child acquires.
  assert.equal(computer.status().owner, null);
  computer.noteRunSession('run-new', 'sess-new');
  assert.equal(computer.status().owner, null);
  assert.equal(computer.status({ runId: 'run-new' }).enabled, true);
  assert.equal(computer.status({ sessionId: 'sess-new' }).enabled, true);
  assert.equal(computer.status({ sessionId: 'sess-new' }).backend, 'native');
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
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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

test('a stop racing a permission grant clears everything instead of resurrecting input', async () => {
  const driver = gatedDriver();
  const computer = createComputerUseManager({ createDriver: () => driver, isSupported: true });
  await computer.enable({ sessionId: 'sess-a', runId: 'run-a' });
  acquireChild(computer, { runId: 'run-a', sessionId: 'sess-a', agentId: 'agent-a' });
  await computer.driver();
  // A second permission never tears down the first holder.
  await computer.enable({ sessionId: 'sess-b', runId: 'run-b' });
  const stopping = computer.stop('user');
  driver.releaseStop();
  assert.equal((await stopping).enabled, false);
  assert.equal(computer.status().owner, null);
  assert.equal(computer.status({ sessionId: 'sess-a' }).enabled, false);
  assert.equal(computer.status({ sessionId: 'sess-b' }).enabled, false);
  // The stop preempts the single holder worker exactly once.
  assert.deepEqual(driver.stopped, ['user']);
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
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
  const first = await computer.driver();
  assert.equal(typeof workers[0].scopedOnStop, 'function');
  computer.dropDriverInstance(first);
  await computer.driver();
  assert.equal(workers.length, 2);
  workers[0].scopedOnStop('late');
  assert.deepEqual(computer.status().owner, {
    sessionId: 'sess-1',
    runId: 'run-1',
    agentId: 'agent-1',
    agentSessionId: 'child-agent-1-run-1',
    backend: 'native',
  });
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
    acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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

test('a new holder sends no input until prior teardown settles', async () => {
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
  acquireChild(computer, { runId: 'run-a', sessionId: 'sess-a', agentId: 'agent-a' });
  await computer.driver();
  assert.equal(creations, 1);
  // Scoped disable releases the holder; the gated stop stays in flight.
  const disabling = computer.disable({ sessionId: 'sess-a' });
  await computer.enable({ sessionId: 'sess-b', runId: 'run-b' });
  // The previous holder is already gone synchronously, so the next child
  // can reserve immediately, but its worker must wait for the barrier.
  acquireChild(computer, { runId: 'run-b', sessionId: 'sess-b', agentId: 'agent-b' });
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

test('scoped disable of another scope never stops the holder', { timeout: 5000 }, async () => {
  const driver = gatedDriver();
  const computer = createComputerUseManager({ createDriver: () => driver, isSupported: true });
  try {
    await computer.enable({ sessionId: 'sess-a', runId: 'run-a' });
    acquireChild(computer, { runId: 'run-a', sessionId: 'sess-a', agentId: 'agent-a' });
    await computer.driver();
    // Second permission is independent of the holder.
    await computer.enable({ sessionId: 'sess-b', runId: 'run-b' });
    assert.equal(computer.status({ sessionId: 'sess-b' }).enabled, true);
    // Revoking the other scope must not touch the holder or its worker.
    await computer.disable({ sessionId: 'sess-b' });
    assert.equal(computer.status({ sessionId: 'sess-b' }).enabled, false);
    assert.equal(computer.status({ sessionId: 'sess-a' }).enabled, true);
    assert.deepEqual(computer.status().owner, {
      sessionId: 'sess-a',
      runId: 'run-a',
      agentId: 'agent-a',
      agentSessionId: 'child-agent-a-run-a',
      backend: 'native',
    });
    assert.deepEqual(driver.stopped, []);
    assert.equal(driver.closed, 0);
    driver.releaseStop();
  } finally {
    driver.releaseStop();
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
  // Permission only: no holder until a child acquires.
  assert.equal(state.owner, null);
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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
  assert.equal(state.owner, null);
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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
  acquireChild(computer, { runId: 'run-a', sessionId: 'sess-a', agentId: 'agent-a' });
  await computer.driver();
  await assert.rejects(
    computer.enable({ sessionId: 'sess-b', runId: 'run-b', backend: 'cua' }),
    /CUA artifacts missing/,
  );
  assert.deepEqual(driver.stopped, []);
  assert.deepEqual(computer.status().owner, {
    sessionId: 'sess-a',
    runId: 'run-a',
    agentId: 'agent-a',
    agentSessionId: 'child-agent-a-run-a',
    backend: 'native',
  });
  assert.equal(computer.status({ sessionId: 'sess-a' }).backend, 'native');
});

test('the active backend cannot change without an explicit disable first', async () => {
  const driver = fakeDriver();
  const computer = createComputerUseManager({
    createDriver: () => driver,
    isSupported: true,
    cuaAvailability: cuaAvailable(),
  });
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
  await computer.driver();
  await assert.rejects(
    computer.enable({ sessionId: 'sess-1', runId: 'run-1', backend: 'cua' }),
    /Disable it first/,
  );
  assert.equal(computer.status({ sessionId: 'sess-1' }).backend, 'native');
  assert.deepEqual(driver.stopped, []);
  await computer.disable({ sessionId: 'sess-1' });
  const state = await computer.enable({ sessionId: 'sess-1', runId: 'run-1', backend: 'cua' });
  assert.equal(state.backend, 'cua');
});

test('a second scope waits for release, then drives with its own backend', async () => {
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
  acquireChild(computer, { runId: 'run-a', sessionId: 'sess-a', agentId: 'agent-a' });
  await computer.driver();
  const state = await computer.enable({ sessionId: 'sess-b', runId: 'run-b', backend: 'cua' });
  assert.equal(state.backend, 'cua');
  // No steal: the first holder keeps the desktop and its worker.
  await assert.rejects(
    computer.acquire(childCaller({ runId: 'run-b', sessionId: 'sess-b', agentId: 'agent-b' })),
    { code: 'computer_use_busy' },
  );
  assert.deepEqual(first.stopped, []);
  assert.deepEqual(computer.status().owner?.agentId, 'agent-a');
  // After an explicit release the next child drives with its own backend.
  // The factory is lazy: the new backend worker mints on first real request.
  await computer.releaseAgent('run-a', 'agent-a');
  assert.deepEqual(first.stopped, ['release']);
  acquireChild(computer, { runId: 'run-b', sessionId: 'sess-b', agentId: 'agent-b' });
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
  acquireChild(computer, { runId: 'run-9', sessionId: 'sess-9' });
  assert.equal(computer.status({ sessionId: 'sess-9' }).backend, 'cua');
  await computer.releaseRun('run-9');
  // Holder released, session preference (cua) survives; unscoped has no holder.
  assert.equal(computer.status().owner, null);
  assert.equal(computer.status().backend, null);
  assert.equal(computer.status({ sessionId: 'sess-9' }).backend, 'cua');
  await computer.noteRunStarted({ sessionId: 'sess-9', runId: 'run-10', cwd: '/tmp/p' });
  assert.equal(computer.status({ sessionId: 'sess-9' }).backend, 'cua');
  acquireChild(computer, { runId: 'run-10', sessionId: 'sess-9' });
  assert.equal(computer.status().owner?.backend, 'cua');
  assert.equal(computer.status().owner?.runId, 'run-10');
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
  assert.equal(computer.status({ runId: 'run-1' }).backend, 'cua');
  await computer.releaseRun('run-1');
  await computer.noteRunStarted({ sessionId: 'sess-1', runId: 'run-2', cwd: '/tmp/p' });
  assert.equal(computer.status({ sessionId: 'sess-1' }).backend, 'cua');
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
  assert.equal(computer.status({ runId: 'run-new' }).backend, 'cua');
  await computer.releaseRun('run-new');
  assert.equal(computer.status({ sessionId: 'sess-new' }).enabled, true);
  await computer.noteRunStarted({ sessionId: 'sess-new', runId: 'run-next', cwd: '/tmp/p' });
  assert.equal(computer.status({ sessionId: 'sess-new' }).backend, 'cua');
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
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1', backend: 'cua' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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
    acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
    await computer.driver();
    assert.deepEqual(seen, ['native']);
    onStop('hotkey');
    // Synchronous invalidation: lease and frames drop immediately.
    assert.equal(computer.status().enabled, false);
    assert.equal(computer.status().lastAction.reason, 'hotkey');
    // Re-enable on the same backend while the old close is still pending:
    // the replacement must not mint until the barrier settles.
    await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
    acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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
    acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
  await computer.driver();
  onStop('hotkey');
  assert.equal(computer.status().enabled, false);
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
  // The retained close failed, so minting refuses while safety is unknown.
  await assert.rejects(computer.driver(), /cleanup failed/);
  assert.match(computer.status().error, /cleanup failed/i);
  // The explicit stop retries the retained instance and verifies success.
  await computer.stop('user');
  assert.equal(closes, 2);
  assert.equal(computer.status().error, null);
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
  await computer.driver();
  onStop('hotkey');
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
  await assert.rejects(computer.driver(), /cleanup failed/);
  // An explicit stop retries but the worker still refuses: poison remains,
  // and the re-enable must not clear the uncertainty.
  await computer.stop('user');
  assert.equal(closes, 2);
  // Stop clears grants, so the poison check needs a fresh permission.
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
  await assert.rejects(computer.driver(), /cleanup failed/);
  assert.match(computer.status().error, /guardian locked/);
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  assert.match(computer.status().error, /guardian locked/);
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
  await assert.rejects(computer.driver(), /cleanup failed/);
  // A second stop retries again instead of wedging silently.
  await computer.stop('user');
  assert.equal(closes, 3);
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
  await computer.driver();
  // The explicit disable tears down, but its close fails: the worker may
  // still be alive, so the next lease must not mint.
  await computer.disable({ sessionId: 'sess-1' });
  assert.equal(computer.status().enabled, false);
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
  await assert.rejects(computer.driver(), /cleanup failed/);
  // The explicit stop retries the retained instance and verifies success.
  await computer.stop('user');
  assert.equal(closes, 2);
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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
  acquireChild(computer, { runId: 'run-9', sessionId: 'sess-9' });
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
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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
    await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
    acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
    await computer.driver();
    onStop('hotkey');
    assert.equal(computer.status().enabled, false);
    assert.equal(computer.status().cleanupPending, true);
    releaseClose();
    await new Promise((done) => setTimeout(done, 20));
    await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
    acquireChild(computer, { runId: 'run-1', sessionId: 'sess-1' });
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

test('slow CUA enable cannot resurrect a lease stopped during availability preflight', async () => {
  let release,
    hold = false;
  const computer = manager({
    getCuaAvailability: () =>
      hold
        ? new Promise((resolve) => {
            release = resolve;
          })
        : { supported: true, available: true },
    availabilityTtlMs: 0,
  });
  await computer.enable({ sessionId: 'first', backend: 'native' });
  hold = true;
  const pending = computer.enable({ sessionId: 'first', backend: 'cua' });
  assert.equal(typeof release, 'function');
  const rejected = assert.rejects(pending, (error) => error.code === 'computer_use_conflict');
  await computer.stop();
  release({ supported: true, available: true });
  await rejected;
  assert.equal(computer.status().owner, null);
  assert.equal(computer.status({ sessionId: 'first' }).enabled, false);
  await computer.close();
});

test('guarded control checks the holder after authorization, siblings never steal', async () => {
  const computer = manager();
  await computer.enable({ sessionId: 'first', runId: 'run-first' });
  computer.setFrame({ width: 10, height: 10 });
  acquireChild(computer, { runId: 'run-first', sessionId: 'first', agentId: 'agent-1' });
  const before = computer._debug();
  // A sibling of the same run and a foreign agent both fail without
  // touching the holder, frames, grants or epochs.
  await assert.rejects(
    computer.acquire(childCaller({ runId: 'run-first', sessionId: 'first', agentId: 'agent-2' })),
    { code: 'computer_use_busy' },
  );
  await assert.rejects(
    computer.acquire(childCaller({ runId: 'run-other', sessionId: 'other', agentId: 'agent-2' })),
    { code: 'computer_use_disabled' },
  );
  // The exact same child re-acquires idempotently.
  assert.deepEqual(
    await computer.acquire(childCaller({ runId: 'run-first', sessionId: 'first', agentId: 'agent-1' })),
    computer.ownerInfo(),
  );
  assert.deepEqual(
    computer._debug(),
    before,
    'Rejected sibling acquires preserve holder, frames, grants and epochs',
  );
  // A grant racing a stop still voids on the revision fence.
  const guard = { expectedRevision: computer.revision };
  const delayed = {
    ...guard,
    authorize: async () => {
      await computer.stop();
    },
  };
  await assert.rejects(computer.enable({ sessionId: 'first', runId: 'run-first' }, delayed), {
    code: 'computer_use_conflict',
  });
  assert.equal(computer.status().owner, null);
  await computer.close();
});

// ---- Permission/lease split: grants vs single native holder ----

test('two permissions share no worker until a child acquires', async () => {
  let creations = 0;
  const computer = createComputerUseManager({
    createDriver: () => {
      creations += 1;
      return fakeDriver();
    },
    isSupported: true,
  });
  await computer.enable({ sessionId: 'sess-a', runId: 'run-a' });
  await computer.enable({ sessionId: 'sess-b', runId: 'run-b' });
  assert.equal(computer.status({ sessionId: 'sess-a' }).enabled, true);
  assert.equal(computer.status({ sessionId: 'sess-b' }).enabled, true);
  assert.equal(computer.status({ runId: 'run-a' }).enabled, true);
  assert.equal(computer.status({ runId: 'run-b' }).enabled, true);
  assert.equal(computer.status().owner, null);
  assert.equal(creations, 0);
  // No holder, so no anonymous driving even though permission is on.
  await assert.rejects(computer.driver(), /no agent holds/);
  assert.equal(creations, 0);
  await computer.close();
});

test('sibling agents never share the holder; exact child re-acquires', async () => {
  const computer = manager();
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  const first = await computer.acquire(
    childCaller({ runId: 'run-1', sessionId: 'sess-1', agentId: 'agent-a' }),
  );
  assert.equal(first.agentId, 'agent-a');
  assert.equal(first.agentSessionId, 'child-agent-a-run-1');
  assert.equal(first.sessionId, 'sess-1');
  assert.equal(first.runId, 'run-1');
  const revision = computer.revision;
  // Idempotent for the exact same agent/session/run: no bump, same holder.
  assert.deepEqual(
    await computer.acquire(childCaller({ runId: 'run-1', sessionId: 'sess-1', agentId: 'agent-a' })),
    first,
  );
  assert.equal(computer.revision, revision);
  // Sibling of the same run is busy, never steals.
  computer.setFrame({ width: 10, height: 10 });
  const framesBefore = computer.status().lastFrame?.frameId;
  await assert.rejects(
    computer.acquire(childCaller({ runId: 'run-1', sessionId: 'sess-1', agentId: 'agent-b' })),
    { code: 'computer_use_busy' },
  );
  assert.equal(computer.ownerInfo().agentId, 'agent-a');
  assert.equal(computer.status().lastFrame?.frameId, framesBefore);
  await computer.close();
});

test('permissionFor exposes grant routing without touching the holder', async () => {
  const computer = manager();
  await computer.enable({
    sessionId: 'sess-1',
    runId: 'run-1',
    backend: 'native',
    computerModel: 'provider/model-x',
    computerThinking: 'high',
  });
  const grant = computer.permissionFor({ ownerId: 'run-1', rootSessionId: 'sess-1' });
  assert.equal(grant.backend, 'native');
  assert.equal(grant.computerModel, 'provider/model-x');
  assert.equal(grant.computerThinking, 'high');
  assert.equal(grant.runId, 'run-1');
  assert.equal(computer.status().owner, null);
  assert.equal(computer.status().lastFrame, null);
  // Unknown run/session has no grant.
  assert.equal(computer.permissionFor({ ownerId: 'run-nope', rootSessionId: 'sess-nope' }), null);
  await computer.close();
});

test('the root main agent without agentId can never hold', async () => {
  const computer = manager();
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  await assert.rejects(
    computer.acquire({ ownerId: 'run-1', rootSessionId: 'sess-1', sessionId: 'child-main' }),
    { code: 'computer_use_denied' },
  );
  await assert.rejects(
    computer.acquire({ ownerId: 'run-1', rootSessionId: 'sess-1', sessionId: 'child-main', agentId: '' }),
    { code: 'computer_use_denied' },
  );
  assert.equal(computer.status().owner, null);
  await computer.close();
});

test('acquire without permission fails disabled and never mints', async () => {
  let creations = 0;
  const computer = createComputerUseManager({
    createDriver: () => {
      creations += 1;
      return fakeDriver();
    },
    isSupported: true,
  });
  await assert.rejects(computer.acquire(childCaller({ runId: 'run-x', sessionId: 'sess-x' })), {
    code: 'computer_use_disabled',
  });
  assert.equal(creations, 0);
  assert.equal(computer.status().owner, null);
  await computer.close();
});

test('releaseAgent frees for reuse; foreign release is a no-op', async () => {
  const driver = gatedDriver();
  const computer = createComputerUseManager({ createDriver: () => driver, isSupported: true });
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  await computer.acquire(childCaller({ runId: 'run-1', sessionId: 'sess-1', agentId: 'agent-a' }));
  await computer.driver();
  computer.setFrame({ width: 20, height: 20 });
  const revision = computer.revision;
  const framesBefore = computer.status().lastFrame?.frameId;
  assert.ok(framesBefore);
  // Foreign agent/session/run releases change nothing: no bump, no frames drop.
  await computer.releaseAgent('run-1', 'agent-b');
  await computer.releaseAgent('run-1', 'agent-a', 'child-wrong');
  await computer.releaseAgent('run-other', 'agent-a');
  assert.equal(computer.revision, revision);
  assert.equal(computer.status().lastFrame?.frameId, framesBefore);
  assert.equal(computer.ownerInfo().agentId, 'agent-a');
  assert.deepEqual(driver.stopped, []);
  // Matching release drops the holder synchronously, keeps permission.
  const releasing = computer.releaseAgent('run-1', 'agent-a');
  assert.equal(computer.status().owner, null);
  assert.equal(computer.status().lastFrame, null);
  assert.equal(computer.status({ sessionId: 'sess-1' }).enabled, true);
  driver.releaseStop();
  await releasing;
  assert.deepEqual(driver.stopped, ['release']);
  // A fresh agent can now hold with the surviving grant.
  const next = await computer.acquire(
    childCaller({ runId: 'run-1', sessionId: 'sess-1', agentId: 'agent-b' }),
  );
  assert.equal(next.agentId, 'agent-b');
  await computer.close();
});

test('releaseRun deletes the run grant but keeps the session pref; stop clears all', async () => {
  const computer = manager();
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1' });
  await computer.acquire(childCaller({ runId: 'run-1', sessionId: 'sess-1' }));
  await computer.releaseRun('run-1');
  assert.equal(computer.status().owner, null);
  assert.equal(computer.status({ runId: 'run-1' }).enabled, false);
  assert.equal(computer.status({ sessionId: 'sess-1' }).enabled, true);
  await computer.stop();
  assert.equal(computer.status().enabled, false);
  assert.equal(computer.status({ sessionId: 'sess-1' }).enabled, false);
  assert.equal(computer.permissionFor({ ownerId: 'run-1', rootSessionId: 'sess-1' }), null);
  await computer.close();
});

test('scoped status never leaks another scope backend; unscoped off means off', async () => {
  const computer = createComputerUseManager({
    createDriver: fakeDriver,
    isSupported: true,
    cuaAvailability: cuaAvailable(),
  });
  await computer.enable({ sessionId: 'sess-a', runId: 'run-a', backend: 'cua' });
  await computer.enable({ sessionId: 'sess-b', runId: 'run-b', backend: 'native' });
  await computer.acquire(childCaller({ runId: 'run-a', sessionId: 'sess-a', agentId: 'agent-a' }));
  assert.equal(computer.status({ sessionId: 'sess-a' }).backend, 'cua');
  assert.equal(computer.status({ sessionId: 'sess-b' }).backend, 'native');
  assert.equal(computer.status({ runId: 'run-b' }).backend, 'native');
  // Releasing the holder clears the unscoped backend but keeps both grants.
  await computer.releaseAgent('run-a', 'agent-a');
  assert.equal(computer.status().owner, null);
  assert.equal(computer.status().backend, null);
  assert.equal(computer.status({ sessionId: 'sess-a' }).enabled, true);
  assert.equal(computer.status({ sessionId: 'sess-b' }).enabled, true);
  await computer.stop();
  assert.equal(computer.status().enabled, false);
  assert.equal(computer.status().backend, null);
  assert.equal(computer.status({ sessionId: 'sess-a' }).enabled, false);
  await computer.close();
});

test('pending grant loses to a scoped revoke; other holder frames stay valid', async () => {
  const computer = manager();
  await computer.enable({ sessionId: 'sess-a', runId: 'run-a' });
  await computer.acquire(childCaller({ runId: 'run-a', sessionId: 'sess-a', agentId: 'agent-a' }));
  const frameId = computer.setFrame({ width: 800, height: 600 });
  assert.ok(computer.takeFrame(frameId));
  const revHolder = computer.revision;
  // Unrelated permission mutation moves the lease revision but keeps the
  // holder and its frames (lease only, never stop revision/generation).
  await computer.enable({ sessionId: 'sess-b', runId: 'run-b' });
  assert.notEqual(computer.revision, revHolder);
  assert.equal(computer.ownerInfo().agentId, 'agent-a');
  assert.ok(computer.takeFrame(frameId));
  assert.equal(computer.status().lastFrame?.frameId, frameId);
  const revGranted = computer.revision;
  // A grant stuck in authorize must fail when a scoped revoke lands first.
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const pending = computer.enable(
    { sessionId: 'sess-c', runId: 'run-c' },
    { authorize: () => gate, expectedRevision: revGranted },
  );
  const rejected = assert.rejects(pending, { code: 'computer_use_conflict' });
  await computer.disable({ sessionId: 'sess-b' });
  assert.notEqual(computer.revision, revGranted);
  releaseGate();
  await rejected;
  // The revoke did not touch the unrelated holder or its frames.
  assert.equal(computer.status({ sessionId: 'sess-b' }).enabled, false);
  assert.equal(computer.ownerInfo().agentId, 'agent-a');
  assert.ok(computer.takeFrame(frameId));
  assert.equal(computer.status({ sessionId: 'sess-a' }).enabled, true);
  await computer.close();
});

test('pending first enable loses to a scoped disable of the same missing scope', async () => {
  const computer = manager();
  assert.equal(computer.status({ sessionId: 'sess-new' }).enabled, false);
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const pending = computer.enable({ sessionId: 'sess-new', runId: 'run-new' }, { authorize: () => gate });
  // Grant not inserted yet; the explicit revoke is still a barrier.
  await computer.disable({ sessionId: 'sess-new' });
  releaseGate();
  await assert.rejects(pending, { code: 'computer_use_conflict' });
  assert.equal(computer.status({ sessionId: 'sess-new' }).enabled, false);
  assert.equal(computer.status({ runId: 'run-new' }).enabled, false);
  await computer.close();
});

test('release before mint cancels the suspended driver without creating a worker', async () => {
  let creations = 0;
  const computer = createComputerUseManager({
    createDriver: () => {
      creations += 1;
      return fakeDriver();
    },
    isSupported: true,
  });
  await computer.enable({ sessionId: 'sess-a', runId: 'run-a' });
  await computer.acquire(childCaller({ runId: 'run-a', sessionId: 'sess-a', agentId: 'agent-a' }));
  // Suspend the mint at the lock, then release before driverPromise exists:
  // teardown sees nothing, so only the freshness recheck can stop the mint.
  const pending = computer.driver();
  const releasing = computer.releaseAgent('run-a', 'agent-a');
  await assert.rejects(pending, (error) => error?.status === 409 && typeof error?.message === 'string');
  await releasing;
  assert.equal(creations, 0);
  assert.equal(computer.status().owner, null);
  assert.equal(computer.status({ sessionId: 'sess-a' }).enabled, true);
  await computer.close();
});

test('a released native mint never leaks into the next cua holder', async () => {
  const seen = [];
  const computer = createComputerUseManager({
    createDriver: (options) => {
      seen.push(options?.backend);
      return fakeDriver();
    },
    isSupported: true,
    cuaAvailability: cuaAvailable(),
  });
  await computer.enable({ sessionId: 'sess-a', runId: 'run-a', backend: 'native' });
  await computer.enable({ sessionId: 'sess-b', runId: 'run-b', backend: 'cua' });
  await computer.acquire(childCaller({ runId: 'run-a', sessionId: 'sess-a', agentId: 'agent-a' }));
  const stale = computer.driver();
  await computer.releaseAgent('run-a', 'agent-a');
  await computer.acquire(childCaller({ runId: 'run-b', sessionId: 'sess-b', agentId: 'agent-b' }));
  await assert.rejects(stale, (error) => error?.status === 409 && typeof error?.message === 'string');
  assert.deepEqual(seen, []);
  const inst = await computer.driver();
  assert.ok(inst);
  assert.deepEqual(seen, ['cua']);
  assert.equal(computer.status().owner?.agentId, 'agent-b');
  assert.equal(computer.status().owner?.backend, 'cua');
  await computer.close();
});
