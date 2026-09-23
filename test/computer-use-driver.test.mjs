import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createComputerUseDriver } from '../lib/computer-use-driver.mjs';

// Injected fake worker process: no real PowerShell, no screen, no input.
// stdin.end() simulates the clean EOF exit of the real worker.
function createFakeProcess() {
  const received = [];
  const child = new EventEmitter();
  child.pid = 70000 + Math.floor(Math.random() * 1000);
  child.exitCode = null;
  child.signalCode = null;
  const stdin = {
    written: [],
    ended: false,
    write(line, encoding, callback) {
      if (typeof encoding === 'function') callback = encoding;
      stdin.written.push(String(line));
      try {
        received.push(JSON.parse(String(line)));
      } catch {
        /* record raw only */
      }
      if (callback) setImmediate(() => callback(null));
      return true;
    },
    end() {
      stdin.ended = true;
      if (api.stuckStdin) return; // Simulate a worker ignoring EOF: close must kill it.
      setImmediate(() => {
        if (child.exitCode === null) {
          child.exitCode = 0;
          child.emit('exit', 0, null);
        }
      });
    },
  };
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.killSignal = signal;
    if (child.exitCode === null) {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    }
    return true;
  };
  const api = {
    child,
    received,
    stdin,
    spawns: [],
    stuckStdin: false,
    spawn(command, args, options) {
      api.spawns.push({ command, args, options });
      return child;
    },
    ready(extra = {}) {
      child.stdout.emit('data', `${JSON.stringify({ event: 'ready', pid: child.pid, ...extra })}\n`);
    },
    respond(id, result) {
      child.stdout.emit('data', `${JSON.stringify({ id, result })}\n`);
    },
    fail(id, code, message) {
      child.stdout.emit('data', `${JSON.stringify({ id, error: { code, message } })}\n`);
    },
    notify(event) {
      child.stdout.emit('data', `${JSON.stringify(event)}\n`);
    },
    stderrLine(text) {
      child.stderr.emit('data', Buffer.from(text));
    },
    exit(code = 0) {
      if (child.exitCode === null) {
        child.exitCode = code;
        child.emit('exit', code, null);
      }
    },
  };
  return api;
}

function autoDriver(fake, options = {}) {
  return createComputerUseDriver({
    platform: 'win32',
    spawnProcess: fake.spawn,
    workerPath: 'C:\\fake\\computer-use-worker.ps1',
    startupTimeoutMs: 2000,
    defaultTimeoutMs: 1000,
    stopTimeoutMs: 300,
    ...options,
  });
}

async function tick(count = 1) {
  for (let i = 0; i < count; i++) await new Promise((done) => setImmediate(done));
}

async function waitForLine(fake, previous = 0, what = 'worker line') {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (fake.received.length > previous) return fake.received[fake.received.length - 1];
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error(`timeout waiting for ${what}`);
}

// Start a request, complete the ready handshake, wait for the written line.
async function sendRequest(fake, driver, command, options) {
  const pending = driver.request(command, options);
  await tick();
  fake.ready();
  const line = await waitForLine(fake);
  return { pending, line };
}

test('constructor is lazy: nothing spawns until the first request', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake);
  assert.equal(fake.spawns.length, 0);
  assert.equal(driver.started, false);
  const pending = driver.request({ method: 'status', params: {} });
  await tick();
  assert.equal(fake.spawns.length, 1);
  assert.equal(fake.received.length, 0);
  fake.ready();
  const line = await waitForLine(fake);
  assert.equal(line.method, 'status');
  fake.respond(line.id, { supported: true });
  assert.deepEqual(await pending, { supported: true });
  await driver.close();
});

test('spawn uses a hidden helper with -File and never -Command', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake);
  const { pending, line } = await sendRequest(fake, driver, { method: 'status', params: {} });
  const [command, args, options] = [fake.spawns[0].command, fake.spawns[0].args, fake.spawns[0].options];
  assert.match(command, /powershell\.exe$/);
  assert.ok(args.includes('-File'));
  assert.equal(args.includes('-Command'), false);
  assert.equal(args.includes('C:\\fake\\computer-use-worker.ps1'), true);
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, false);
  assert.equal(line.method, 'status');
  fake.respond(line.id, { supported: true });
  await pending;
  await driver.close();
});

test('concurrent requests wait for ready and keep call order', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake);
  const first = driver.request({ method: 'status', params: {} });
  const second = driver.request({ method: 'windows', params: { action: 'list' } });
  await tick(3);
  assert.equal(fake.received.length, 0);
  fake.ready();
  await tick(3);
  assert.equal(fake.received.length, 2);
  assert.equal(fake.received[0].method, 'status');
  assert.equal(fake.received[1].method, 'windows');
  assert.notEqual(fake.received[0].id, fake.received[1].id);
  fake.respond(fake.received[1].id, { windows: [] });
  fake.respond(fake.received[0].id, { supported: true });
  assert.deepEqual(await first, { supported: true });
  assert.deepEqual(await second, { windows: [] });
  await driver.close();
});

test('unsupported platform fails clearly and never spawns', async () => {
  for (const platform of ['linux', 'darwin']) {
    const fake = createFakeProcess();
    const driver = createComputerUseDriver({ platform, spawnProcess: fake.spawn });
    await assert.rejects(driver.request({ method: 'status', params: {} }), (error) => {
      assert.equal(error.code, 'UNSUPPORTED_PLATFORM');
      assert.match(error.message, /Windows/);
      return true;
    });
    assert.equal(fake.spawns.length, 0);
    assert.deepEqual(await driver.stop('user'), { stopped: true, reason: 'user', idle: true });
    await driver.close();
  }
});

test('invalid commands are rejected locally without spawning', async () => {
  const cases = [
    { method: 'dance', params: {} },
    { method: 'act', params: { actions: [] } },
    { method: 'act', params: { actions: Array.from({ length: 21 }, () => ({ type: 'wait', ms: 10 })) } },
    { method: 'act', params: { actions: [{ type: 'click' }] } },
    { method: 'act', params: { actions: [{ type: 'warp', x: 1, y: 2 }] } },
    { method: 'act', params: { actions: [{ type: 'type', text: 'x'.repeat(2001) }] } },
    { method: 'act', params: { actions: [{ type: 'wait', ms: 6000 }] } },
    { method: 'act', params: { actions: [{ type: 'keypress', keys: [] }] } },
    { method: 'act', params: { actions: [{ type: 'scroll' }] } },
    { method: 'act', params: { actions: [{ type: 'scroll', deltaY: 101 }] } },
    {
      method: 'act',
      params: {
        actions: [{ type: 'drag', x: 1, y: 1, path: Array.from({ length: 21 }, () => ({ x: 1, y: 1 })) }],
      },
    },
    {
      method: 'act',
      params: { actions: [{ type: 'wait', ms: 5 }], expectedFrame: { requireForeground: 'yes' } },
    },
    { method: 'act', params: { actions: [{ type: 'wait', ms: 5 }], expectedFrame: { bounds: 'nope' } } },
    { method: 'observe', params: { region: { x: 0, y: 0, width: 0, height: 10 } } },
    { method: 'observe', params: { maxWidth: 8 } },
    { method: 'windows', params: { action: 'focus' } },
  ];
  for (const command of cases) {
    const fake = createFakeProcess();
    const driver = autoDriver(fake);
    await assert.rejects(driver.request(command), (error) => {
      assert.ok(['INVALID_PARAMS', 'UNKNOWN_METHOD'].includes(error.code), error.code);
      return true;
    });
    assert.equal(fake.spawns.length, 0);
    await driver.close();
  }
});

test('expectedFrame passes through on the wire when well formed', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake);
  const frame = {
    windowId: '12346',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    desktopBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    foregroundWindowId: '12346',
    requireForeground: true,
  };
  const { pending, line } = await sendRequest(fake, driver, {
    method: 'act',
    params: { actions: [{ type: 'wait', ms: 5 }], expectedFrame: frame },
  });
  assert.deepEqual(line.params.expectedFrame, frame);
  fake.respond(line.id, { executed: 1 });
  assert.deepEqual(await pending, { executed: 1 });
  await driver.close();
});

test('worker freshness codes surface with their code', async () => {
  for (const code of [
    'STALE_FRAME',
    'FOCUS_CHANGED',
    'STALE_GENERATION',
    'WINDOW_MINIMIZED',
    'CONTROLLER_BUSY',
  ]) {
    const fake = createFakeProcess();
    const driver = autoDriver(fake);
    const { pending, line } = await sendRequest(fake, driver, {
      method: 'act',
      params: { actions: [{ type: 'wait', ms: 5 }] },
    });
    fake.fail(line.id, code, `${code} detail`);
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, code);
      return true;
    });
    await driver.close();
  }
});

test('observe and status results pass through untouched', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake);
  const frame = {
    width: 800,
    height: 600,
    bounds: { x: 10, y: 20, width: 1600, height: 1200 },
    capturedAt: '2026-09-22T10:00:00.000Z',
  };
  const { pending, line } = await sendRequest(fake, driver, { method: 'observe', params: { maxWidth: 800 } });
  const payload = {
    image: { data: 'ZmFrZQ==', mimeType: 'image/jpeg' },
    frame,
    desktopBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    foregroundWindowId: '12346',
  };
  fake.respond(line.id, payload);
  assert.deepEqual(await pending, payload);
  await driver.close();
});

test('a hanging worker triggers TIMEOUT and late answers are ignored', async () => {
  const fake = createFakeProcess();
  const events = [];
  const driver = autoDriver(fake, { defaultTimeoutMs: 40, onEvent: (event) => events.push(event) });
  const pending = driver.request({ method: 'status', params: {} });
  await tick();
  fake.ready();
  const line = await waitForLine(fake);
  await assert.rejects(pending, { code: 'TIMEOUT' });
  fake.respond(line.id, { supported: true });
  await tick(2);
  assert.ok(events.some((event) => event.kind === 'worker_timeout'));
  await driver.close();
});

test('abort signal rejects the wait without killing the worker', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake);
  const controller = new AbortController();
  const pending = driver.request(
    { method: 'act', params: { actions: [{ type: 'wait', ms: 100 }] } },
    { signal: controller.signal },
  );
  await tick();
  fake.ready();
  const line = await waitForLine(fake);
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  assert.equal(fake.child.killed, false);
  fake.respond(line.id, { executed: 1 });
  await tick(2);
  await driver.close();
});

test('stop preempts: it writes immediately without waiting for act', async () => {
  const fake = createFakeProcess();
  const stops = [];
  const driver = autoDriver(fake, { onStop: (reason) => stops.push(reason) });
  const acting = driver.request({ method: 'act', params: { actions: [{ type: 'wait', ms: 5000 }] } });
  acting.catch(() => {});
  await tick();
  fake.ready();
  const actLine = await waitForLine(fake);
  assert.equal(actLine.method, 'act');
  assert.equal(actLine.generation, 1);
  const stopping = driver.stop('hotkey-test');
  const stopLine = await waitForLine(fake, 1, 'stop line');
  assert.equal(stopLine.method, 'stop');
  assert.ok(stopLine.generation > actLine.generation);
  fake.fail(actLine.id, 'STOPPED', 'Batch stopped (hotkey-test).');
  fake.respond(stopLine.id, { stopped: true, reason: 'hotkey-test' });
  await assert.rejects(acting, { code: 'STOPPED' });
  assert.deepEqual(await stopping, { stopped: true, reason: 'hotkey-test' });
  assert.ok(stops.includes('hotkey-test'));
  // Work after the stop carries the fresh generation.
  const next = driver.request({ method: 'status', params: {} });
  const nextLine = await waitForLine(fake, 2, 'post-stop line');
  assert.equal(nextLine.generation, stopLine.generation);
  fake.respond(nextLine.id, { supported: true });
  await next;
  await driver.close();
});

test('stop on a never-started driver stays idle without spawning', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake);
  assert.deepEqual(await driver.stop('user'), { stopped: true, reason: 'user', idle: true });
  assert.equal(fake.spawns.length, 0);
  await driver.close();
});

test('global hotkey notification reaches onStop and advances the generation', async () => {
  const fake = createFakeProcess();
  const stops = [];
  const driver = autoDriver(fake, { onStop: (reason) => stops.push(reason) });
  const { pending, line } = await sendRequest(fake, driver, { method: 'status', params: {} });
  const before = driver.generation;
  fake.notify({ event: 'stopped', reason: 'hotkey', source: 'idle', stopGeneration: before + 1 });
  fake.respond(line.id, { supported: true });
  await pending;
  assert.deepEqual(stops, ['hotkey']);
  assert.equal(driver.generation, before + 1);
  const next = driver.request({ method: 'status', params: {} });
  const nextLine = await waitForLine(fake, 1, 'post-hotkey line');
  assert.equal(nextLine.generation, before + 1);
  fake.respond(nextLine.id, { supported: true });
  await next;
  await driver.close();
});

test('malformed stdout lines are ignored, stderr stays diagnostic', async () => {
  const fake = createFakeProcess();
  const events = [];
  const driver = autoDriver(fake, { onEvent: (event) => events.push(event) });
  const { pending, line } = await sendRequest(fake, driver, { method: 'status', params: {} });
  fake.child.stdout.emit('data', 'not-json\n');
  fake.stderrLine('worker diagnostic');
  fake.respond(line.id, { supported: true });
  assert.deepEqual(await pending, { supported: true });
  assert.ok(events.some((event) => event.kind === 'worker_stderr'));
  await driver.close();
});

test('worker exit fails pending work with WORKER_EXIT', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake);
  const pending = driver.request({ method: 'status', params: {} });
  pending.catch(() => {});
  await tick();
  fake.ready();
  await waitForLine(fake);
  fake.exit(1);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'WORKER_EXIT');
    return true;
  });
  await driver.close();
});

test('close ends only its own recorded worker and rejects pending work', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake);
  const pending = driver.request({ method: 'status', params: {} });
  pending.catch(() => {});
  await tick();
  fake.ready();
  await waitForLine(fake);
  const ownPid = driver.pid;
  assert.ok(Number.isInteger(ownPid));
  await driver.close();
  assert.equal(fake.stdin.ended, true);
  await assert.rejects(pending, { code: 'DRIVER_CLOSED' });
  await assert.rejects(driver.request({ method: 'status', params: {} }), { code: 'DRIVER_CLOSED' });
  await driver.close();
});

test('close kills only its own stuck worker after the EOF grace period', async () => {
  const fake = createFakeProcess();
  fake.stuckStdin = true;
  const driver = autoDriver(fake);
  const { pending, line } = await sendRequest(fake, driver, { method: 'status', params: {} });
  pending.catch(() => {});
  const ownPid = driver.pid;
  await driver.close();
  assert.equal(fake.stdin.ended, true);
  assert.equal(fake.child.killed, true);
  assert.equal(typeof ownPid, 'number');
  await assert.rejects(pending, { code: 'DRIVER_CLOSED' });
});

test('string shorthand request form works', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake);
  const { pending, line } = await sendRequest(fake, driver, 'status');
  assert.equal(line.method, 'status');
  fake.respond(line.id, { supported: true });
  assert.deepEqual(await pending, { supported: true });
  await driver.close();
});

test('act validation accepts a full bounded batch', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake);
  const batch = {
    actions: [
      { type: 'move', x: -1920, y: 100 },
      { type: 'click', x: 100, y: 200, button: 'left' },
      { type: 'double_click', x: 100, y: 200 },
      { type: 'drag', x: 300, y: 300, path: [{ x: 150, y: 150 }] },
      { type: 'scroll', deltaY: 3 },
      { type: 'scroll', deltaX: -2 },
      { type: 'keypress', keys: ['ctrl', 'c'] },
      { type: 'type', text: 'h\u00e9llo w\u00f6rld' },
      { type: 'wait', ms: 250 },
    ],
  };
  const { pending, line } = await sendRequest(fake, driver, { method: 'act', params: batch });
  assert.equal(line.method, 'act');
  fake.respond(line.id, { executed: 9 });
  assert.deepEqual(await pending, { executed: 9 });
  await driver.close();
});

test('abort before dispatch writes nothing to the worker', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake);
  const controller = new AbortController();
  const pending = driver.request(
    { method: 'act', params: { actions: [{ type: 'wait', ms: 50 }] } },
    { signal: controller.signal },
  );
  pending.catch(() => {});
  await tick();
  controller.abort();
  fake.ready();
  await tick(3);
  assert.equal(fake.received.length, 0);
  await assert.rejects(pending, { code: 'ABORTED' });
  await driver.close();
});

test('act timeout auto-stops native input with a fresh generation', async () => {
  const fake = createFakeProcess();
  const events = [];
  const driver = autoDriver(fake, { onEvent: (event) => events.push(event) });
  const pending = driver.request(
    { method: 'act', params: { actions: [{ type: 'wait', ms: 5000 }] } },
    { timeoutMs: 40 },
  );
  pending.catch(() => {});
  await tick();
  fake.ready();
  const actLine = await waitForLine(fake);
  assert.equal(actLine.method, 'act');
  await assert.rejects(pending, { code: 'TIMEOUT' });
  const stopLine = await waitForLine(fake, 1, 'auto-stop line');
  assert.equal(stopLine.method, 'stop');
  assert.equal(stopLine.params.reason, 'timeout');
  assert.ok(stopLine.generation > actLine.generation);
  assert.ok(events.some((event) => event.kind === 'worker_auto_stop'));
  // Orphan answers for the timed-out batch are ignored, not resumed.
  fake.fail(actLine.id, 'STOPPED', 'Batch stopped (timeout).');
  await tick(2);
  const next = driver.request({ method: 'status', params: {} });
  const nextLine = await waitForLine(fake, 2, 'post-timeout line');
  assert.equal(nextLine.generation, stopLine.generation);
  fake.respond(nextLine.id, { supported: true });
  await next;
  await driver.close();
});

test('act abort after send auto-stops native input', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake);
  const controller = new AbortController();
  const pending = driver.request(
    { method: 'act', params: { actions: [{ type: 'wait', ms: 5000 }] } },
    { signal: controller.signal },
  );
  pending.catch(() => {});
  await tick();
  fake.ready();
  const actLine = await waitForLine(fake);
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  const stopLine = await waitForLine(fake, 1, 'abort stop line');
  assert.equal(stopLine.method, 'stop');
  assert.equal(stopLine.params.reason, 'aborted');
  assert.ok(stopLine.generation > actLine.generation);
  await driver.close();
});

test('read-only timeout sends no auto-stop', async () => {
  const fake = createFakeProcess();
  const events = [];
  const driver = autoDriver(fake, { onEvent: (event) => events.push(event) });
  const pending = driver.request({ method: 'status', params: {} }, { timeoutMs: 40 });
  pending.catch(() => {});
  await tick();
  fake.ready();
  await waitForLine(fake);
  await assert.rejects(pending, { code: 'TIMEOUT' });
  await tick(3);
  assert.equal(fake.received.length, 1);
  assert.ok(!events.some((event) => event.kind === 'worker_auto_stop'));
  await driver.close();
});

test('stop during startup cancels the queued request before any write', async () => {
  const fake = createFakeProcess();
  const stops = [];
  const driver = autoDriver(fake, { onStop: (reason) => stops.push(reason) });
  const queued = driver.request({ method: 'act', params: { actions: [{ type: 'wait', ms: 50 }] } });
  queued.catch(() => {});
  await tick();
  const stopping = driver.stop('startup-stop');
  await tick(2);
  fake.ready();
  await tick(3);
  await assert.rejects(queued, { code: 'STOPPED' });
  const stopLine = fake.received.find((line) => line.method === 'stop');
  assert.ok(stopLine, 'stop must be written after ready');
  assert.equal(fake.received.filter((line) => line.method === 'act').length, 0);
  fake.respond(stopLine.id, { stopped: true, reason: 'startup-stop' });
  assert.deepEqual(await stopping, { stopped: true, reason: 'startup-stop' });
  assert.ok(stops.includes('startup-stop'));
  await driver.close();
});

test('stop resolves locally when the worker never answers', async () => {
  const fake = createFakeProcess();
  const driver = autoDriver(fake, { stopTimeoutMs: 40 });
  const acting = driver.request({ method: 'act', params: { actions: [{ type: 'wait', ms: 5000 }] } });
  acting.catch(() => {});
  await tick();
  fake.ready();
  await waitForLine(fake);
  const result = await driver.stop('impatient');
  assert.equal(result.stopped, true);
  assert.equal(result.reason, 'impatient');
  await assert.rejects(acting, { code: 'STOPPED' });
  await driver.close();
});

test('windows focus is mutating: timeout and abort auto-stop native input', async () => {
  for (const mode of ['timeout', 'abort']) {
    const fake = createFakeProcess();
    const driver = autoDriver(fake);
    const controller = new AbortController();
    const options = mode === 'timeout' ? { timeoutMs: 40 } : { signal: controller.signal };
    const pending = driver.request(
      { method: 'windows', params: { action: 'focus', windowId: '12345' } },
      options,
    );
    pending.catch(() => {});
    await tick();
    fake.ready();
    const focusLine = await waitForLine(fake);
    assert.equal(focusLine.method, 'windows');
    assert.equal(focusLine.params.action, 'focus');
    if (mode === 'abort') controller.abort();
    await assert.rejects(pending, { code: mode === 'timeout' ? 'TIMEOUT' : 'ABORTED' });
    const stopLine = await waitForLine(fake, 1, 'focus auto-stop line');
    assert.equal(stopLine.method, 'stop');
    assert.equal(stopLine.params.reason, mode === 'timeout' ? 'timeout' : 'aborted');
    assert.ok(stopLine.generation > focusLine.generation);
    await driver.close();
  }
});

test('windows list timeout sends no auto-stop', async () => {
  const fake = createFakeProcess();
  const events = [];
  const driver = autoDriver(fake, { onEvent: (event) => events.push(event) });
  const pending = driver.request({ method: 'windows', params: { action: 'list' } }, { timeoutMs: 40 });
  pending.catch(() => {});
  await tick();
  fake.ready();
  await waitForLine(fake);
  await assert.rejects(pending, { code: 'TIMEOUT' });
  await tick(3);
  assert.equal(fake.received.length, 1);
  assert.ok(!events.some((event) => event.kind === 'worker_auto_stop'));
  await driver.close();
});
