import test from 'node:test';
import assert from 'node:assert/strict';
import { createComputerUseManager, modelSupportsImages, COMPUTER_USE_HOTKEY } from '../lib/computer-use.mjs';

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
  assert.deepEqual(computer.status().owner, { sessionId: 'sess-1', cwd: '/tmp/proj' });
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
  assert.deepEqual(computer.status().owner, { sessionId: 'sess-b', runId: 'run-b' });
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
  assert.deepEqual(computer.status().owner, { sessionId: 'sess-new', runId: 'run-new', cwd: '/tmp/p' });
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
  assert.deepEqual(computer.status().owner, { sessionId: 'sess-1', runId: 'run-1' });
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
