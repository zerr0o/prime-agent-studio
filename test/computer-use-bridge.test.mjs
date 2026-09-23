import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createComputerUseManager } from '../lib/computer-use.mjs';
import { createComputerUseBridge, toPhysicalCoordinates } from '../lib/computer-use-bridge.mjs';

const IMAGE = Buffer.from('fake-screenshot-bytes').toString('base64');

function fakeDriver(hooks = {}) {
  const calls = [];
  const driver = {
    calls,
    stopped: [],
    async request(command) {
      calls.push(command);
      if (hooks.onRequest) return hooks.onRequest(command, calls);
      if (command.method === 'status')
        return { supported: true, platform: 'win32', hotkey: 'Ctrl+Alt+Shift+F10' };
      if (command.method === 'windows') return { windows: [] };
      if (command.method === 'observe')
        return {
          image: { data: IMAGE, mimeType: 'image/png' },
          frame: {
            width: 800,
            height: 600,
            bounds: { x: 0, y: 0, width: 1600, height: 1200 },
            capturedAt: '2026-09-22T00:00:00.000Z',
          },
        };
      if (command.method === 'act') return { executed: command.params.actions.length };
      throw new Error(`unexpected ${command.method}`);
    },
    async stop(reason) {
      driver.stopped.push(reason || 'user');
    },
    async close() {},
  };
  return driver;
}

const caller = {
  cwd: '/tmp/p',
  sessionId: 'sess-1',
  rootSessionId: 'sess-1',
  ownerId: 'run-1',
  name: 'Prime Agent',
};

async function fixture(t, { driver = fakeDriver(), resolveCaller = async () => caller } = {}) {
  const manager = createComputerUseManager({ createDriver: () => driver, isSupported: true });
  const bridge = createComputerUseBridge({ manager, resolveCaller, isOwnerActive: () => true });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  return { manager, bridge, driver };
}

function call(bridge, action, params = {}, extras = {}) {
  return new Promise((resolve, reject) => {
    const { token = bridge.config.token, identity = { cwd: '/tmp/p', sessionId: 'sess-1' } } = extras;
    const req = request(
      {
        socketPath: bridge.config.socketPath,
        method: 'POST',
        path: '/',
        agent: false,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ identity, action, params, epoch: 'epoch-1' }));
  });
}

test('bridge rejects bad tokens and tools stay disabled with an enable hint', async (t) => {
  const { bridge } = await fixture(t);
  assert.equal((await call(bridge, 'status', {}, { token: 'wrong' })).status, 403);
  const observe = await call(bridge, 'observe', {});
  assert.equal(observe.status, 409);
  assert.match(observe.body.error, /Enable it in Studio/);
  assert.equal(observe.body.code, 'computer_use_disabled');
});

test('observe assigns a frame and act maps screenshot pixels to physical pixels', async (t) => {
  const { bridge, driver, manager } = await fixture(t);
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const seen = await call(bridge, 'observe', {});
  assert.equal(seen.status, 200);
  assert.equal(seen.body.image.mimeType, 'image/png');
  assert.ok(seen.body.frame.frameId);
  assert.equal(seen.body.frame.width, 800);
  const acted = await call(bridge, 'act', {
    frameId: seen.body.frame.frameId,
    actions: [{ type: 'click', x: 400, y: 300, button: 'left' }],
  });
  assert.equal(acted.status, 200);
  assert.equal(acted.body.executed, 1);
  const sent = driver.calls.find((item) => item.method === 'act');
  assert.deepEqual({ x: sent.params.actions[0].x, y: sent.params.actions[0].y }, { x: 800, y: 600 });
});

test('act consumes its frame and rejects stale or ambiguous replays', async (t) => {
  const { bridge, manager } = await fixture(t);
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const seen = await call(bridge, 'observe', {});
  const frameId = seen.body.frame.frameId;
  assert.equal((await call(bridge, 'act', { frameId, actions: [{ type: 'wait', ms: 10 }] })).status, 200);
  const replay = await call(bridge, 'act', { frameId, actions: [{ type: 'wait', ms: 10 }] });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, 'computer_use_stale_frame');
  const unknown = await call(bridge, 'act', { frameId: 'f999', actions: [{ type: 'wait', ms: 10 }] });
  assert.equal(unknown.status, 409);
});

test('timed out actions invalidate frames instead of replaying', async (t) => {
  const driver = fakeDriver({
    onRequest(command) {
      if (command.method === 'observe')
        return {
          image: { data: IMAGE, mimeType: 'image/png' },
          frame: {
            width: 100,
            height: 100,
            bounds: { x: 0, y: 0, width: 100, height: 100 },
            capturedAt: 't',
          },
        };
      if (command.method === 'act') throw Object.assign(new Error('Driver timed out'), { status: 504 });
      return { supported: true };
    },
  });
  const { bridge, manager } = await fixture(t, { driver });
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const seen = await call(bridge, 'observe', {});
  const failed = await call(bridge, 'act', {
    frameId: seen.body.frame.frameId,
    actions: [{ type: 'click', x: 1, y: 1 }],
  });
  assert.equal(failed.status, 504);
  assert.match(failed.body.error, /never replay/i);
  assert.equal(manager.status().lastFrame, null);
});

test('child agents share the lease through native lineage, strangers are denied', async (t) => {
  let current = {
    cwd: '/tmp/p',
    sessionId: 'child-1',
    rootSessionId: 'sess-1',
    ownerId: 'run-1',
    name: 'helper',
  };
  const { bridge, manager } = await fixture(t, { resolveCaller: async () => current });
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  assert.equal((await call(bridge, 'windows', { action: 'list' })).status, 200);
  current = { ...current, rootSessionId: 'unrelated', sessionId: 'stranger' };
  assert.equal((await call(bridge, 'windows', { action: 'list' })).status, 403);
  current = {
    cwd: '/tmp/p',
    sessionId: 'sess-1',
    rootSessionId: 'sess-1',
    ownerId: 'other-run',
    name: 'helper',
  };
  assert.equal((await call(bridge, 'windows', { action: 'list' })).status, 409);
});

test('models without image support get a descriptive observe error', async (t) => {
  const { bridge, manager } = await fixture(t);
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p', imageCapable: false });
  const seen = await call(bridge, 'observe', {});
  assert.equal(seen.status, 409);
  assert.equal(seen.body.code, 'computer_use_no_image_model');
});

test('release discards frames while keeping the lease', async (t) => {
  const { bridge, manager } = await fixture(t);
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const seen = await call(bridge, 'observe', {});
  assert.equal((await call(bridge, 'release', {})).status, 200);
  assert.equal(manager.status().lastFrame, null);
  assert.equal(manager.status({ runId: 'run-1' }).enabled, true);
});

test('coordinates on the far image edge are rejected', async (t) => {
  const { bridge, manager } = await fixture(t);
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const seen = await call(bridge, 'observe', {});
  const frameId = seen.body.frame.frameId;
  assert.equal(
    (await call(bridge, 'act', { frameId, actions: [{ type: 'click', x: 800, y: 10 }] })).status,
    400,
  );
  assert.equal(
    (await call(bridge, 'act', { frameId, actions: [{ type: 'click', x: 10, y: 600 }] })).status,
    400,
  );
  assert.equal(
    (await call(bridge, 'act', { frameId, actions: [{ type: 'click', x: 799, y: 599 }] })).status,
    200,
  );
});

test('acting invalidates every previous frame, not just the used one', async (t) => {
  const { bridge, manager } = await fixture(t);
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const first = await call(bridge, 'observe', {});
  const second = await call(bridge, 'observe', {});
  assert.notEqual(first.body.frame.frameId, second.body.frame.frameId);
  assert.equal(
    (await call(bridge, 'act', { frameId: second.body.frame.frameId, actions: [{ type: 'wait', ms: 1 }] }))
      .status,
    200,
  );
  assert.equal(
    (await call(bridge, 'act', { frameId: first.body.frame.frameId, actions: [{ type: 'wait', ms: 1 }] }))
      .body.code,
    'computer_use_stale_frame',
  );
});

test('focusing a window discards older screenshots', async (t) => {
  const { bridge, manager } = await fixture(t);
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const seen = await call(bridge, 'observe', {});
  assert.equal((await call(bridge, 'windows', { action: 'focus', windowId: 'w1' })).status, 200);
  assert.equal(
    (
      await call(bridge, 'act', {
        frameId: seen.body.frame.frameId,
        actions: [{ type: 'wait', ms: 1 }],
      })
    ).body.code,
    'computer_use_stale_frame',
  );
});

test('acting verifies the observed window is still present and focused', async (t) => {
  let windows = [
    { id: 'w1', title: 'App', foreground: true, bounds: { x: 0, y: 0, width: 800, height: 600 } },
  ];
  const driver = fakeDriver({
    onRequest(command) {
      if (command.method === 'observe')
        return {
          image: { data: IMAGE, mimeType: 'image/png' },
          frame: {
            width: 800,
            height: 600,
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            capturedAt: 't',
            windowId: 'w1',
          },
        };
      if (command.method === 'act') return { executed: 1 };
      if (command.method === 'windows') return { windows };
      throw new Error(`unexpected ${command.method}`);
    },
  });
  const { bridge, manager } = await fixture(t, { driver });
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const seen = await call(bridge, 'observe', { windowId: 'w1' });
  assert.equal(
    (await call(bridge, 'act', { frameId: seen.body.frame.frameId, actions: [{ type: 'wait', ms: 1 }] }))
      .status,
    200,
  );
  const moved = await call(bridge, 'observe', { windowId: 'w1' });
  windows = [{ id: 'w2', title: 'Other', foreground: true, bounds: { x: 0, y: 0, width: 100, height: 100 } }];
  const gone = await call(bridge, 'act', {
    frameId: moved.body.frame.frameId,
    actions: [{ type: 'wait', ms: 1 }],
  });
  assert.equal(gone.status, 409);
  assert.match(gone.body.error, /gone|focused|verified/i);
  const refocused = await call(bridge, 'observe', { windowId: 'w1' });
  windows = [{ id: 'w1', title: 'App', foreground: false, bounds: { x: 0, y: 0, width: 800, height: 600 } }];
  const blurred = await call(bridge, 'act', {
    frameId: refocused.body.frame.frameId,
    actions: [{ type: 'wait', ms: 1 }],
  });
  assert.equal(blurred.status, 409);
  assert.match(blurred.body.error, /focused/i);
});

test('concurrent root and child batches run one at a time', async (t) => {
  const order = [];
  const driver = fakeDriver({
    onRequest(command) {
      if (command.method === 'observe')
        return {
          image: { data: IMAGE, mimeType: 'image/png' },
          frame: { width: 50, height: 50, bounds: { x: 0, y: 0, width: 50, height: 50 }, capturedAt: 't' },
        };
      throw new Error(`unexpected ${command.method}`);
    },
  });
  const realRequest = driver.request.bind(driver);
  driver.request = async (command, options) => {
    if (command.method !== 'act') return realRequest(command, options);
    order.push(`start-${command.params.actions[0].ms}`);
    await new Promise((done) => setTimeout(done, 30));
    order.push(`end-${command.params.actions[0].ms}`);
    return { executed: 1 };
  };
  let current = {
    cwd: '/tmp/p',
    sessionId: 'sess-1',
    rootSessionId: 'sess-1',
    ownerId: 'run-1',
    name: 'Prime Agent',
  };
  const { bridge, manager } = await fixture(t, { driver, resolveCaller: async () => current });
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const first = await call(bridge, 'observe', {});
  const second = await call(bridge, 'observe', {});
  const pending = [
    call(bridge, 'act', { frameId: first.body.frame.frameId, actions: [{ type: 'wait', ms: 1 }] }),
    (async () => {
      current = {
        cwd: '/tmp/p',
        sessionId: 'child-1',
        rootSessionId: 'sess-1',
        ownerId: 'run-1',
        name: 'helper',
      };
      return call(bridge, 'act', { frameId: second.body.frame.frameId, actions: [{ type: 'wait', ms: 2 }] });
    })(),
  ];
  const [a, b] = await Promise.all(pending);
  assert.equal(a.status, 200);
  // The second batch waited: its frame was consumed by the first batch, so it
  // fails stale instead of interleaving native input.
  assert.equal(b.body.code, 'computer_use_stale_frame');
  assert.deepEqual(order, ['start-1', 'end-1']);
});

test('release stops in-flight input and keeps the lease', async (t) => {
  const { bridge, manager, driver } = await fixture(t);
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  await manager.driver();
  assert.equal((await call(bridge, 'release', {})).status, 200);
  assert.deepEqual(driver.stopped, ['release']);
  assert.equal(manager.status({ runId: 'run-1' }).enabled, true);
});

test('a stop racing driver creation cannot leak into new input', async (t) => {
  let releaseFactory;
  const gate = new Promise((resolve) => (releaseFactory = resolve));
  const inner = fakeDriver();
  const { createComputerUseManager: createManager } = await import('../lib/computer-use.mjs');
  const { createComputerUseBridge: createBridge } = await import('../lib/computer-use-bridge.mjs');
  const computer = createManager({ createDriver: () => gate.then(() => inner), isSupported: true });
  const bridge = createBridge({ manager: computer, resolveCaller: async () => caller });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => computer.close());
  await computer.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const watched = new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: bridge.config.socketPath,
        method: 'POST',
        path: '/',
        agent: false,
        headers: { Authorization: `Bearer ${bridge.config.token}`, 'Content-Type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      },
    );
    req.on('error', reject);
    req.end(
      JSON.stringify({
        identity: { cwd: '/tmp/p', sessionId: 'sess-1' },
        action: 'windows',
        params: { action: 'list' },
        epoch: 'e',
      }),
    );
  });
  await computer.stop('race');
  releaseFactory();
  const result = await watched;
  assert.ok([409, 403].includes(result.status), `expected stale lease, got ${result.status}`);
});

test('act forwards stored native geometry as expectedFrame', async (t) => {
  let actParams = null;
  const driver = fakeDriver({
    onRequest(command) {
      if (command.method === 'observe')
        return {
          image: { data: IMAGE, mimeType: 'image/png' },
          frame: {
            width: 800,
            height: 600,
            bounds: { x: 100, y: 100, width: 800, height: 600 },
            capturedAt: 't',
            windowId: 'w1',
            desktopBounds: { x: 0, y: 0, width: 1920, height: 1080 },
            foregroundWindowId: 'w1',
          },
        };
      if (command.method === 'act') {
        actParams = command.params;
        return { executed: 1 };
      }
      if (command.method === 'windows') return { windows: [{ id: 'w1', title: 'App', foreground: true }] };
      throw new Error(`unexpected ${command.method}`);
    },
  });
  const { bridge, manager } = await fixture(t, { driver });
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const seen = await call(bridge, 'observe', { windowId: 'w1' });
  assert.deepEqual(seen.body.frame.desktopBounds, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(seen.body.frame.foregroundWindowId, 'w1');
  assert.equal(
    (
      await call(bridge, 'act', {
        frameId: seen.body.frame.frameId,
        actions: [{ type: 'click', x: 10, y: 10 }],
      })
    ).status,
    200,
  );
  assert.deepEqual(actParams.expectedFrame, {
    windowId: 'w1',
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    desktopBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    foregroundWindowId: 'w1',
    requireForeground: false,
  });
  const typed = await call(bridge, 'observe', { windowId: 'w1' });
  assert.equal(
    (
      await call(bridge, 'act', {
        frameId: typed.body.frame.frameId,
        actions: [{ type: 'type', text: 'hi' }],
      })
    ).status,
    200,
  );
  assert.equal(actParams.expectedFrame.requireForeground, true);
});

test('native worker errors map to model-actionable statuses', async (t) => {
  const failures = {
    act: Object.assign(new Error('actions[0].ms must be an integer in [1, 5000].'), {
      code: 'INVALID_PARAMS',
    }),
  };
  const driver = fakeDriver({
    onRequest(command) {
      if (command.method === 'observe')
        return {
          image: { data: IMAGE, mimeType: 'image/png' },
          frame: { width: 60, height: 60, bounds: { x: 0, y: 0, width: 60, height: 60 }, capturedAt: 't' },
        };
      if (command.method === 'act') throw failures.act;
      throw new Error(`unexpected ${command.method}`);
    },
  });
  const { bridge, manager } = await fixture(t, { driver });
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const seen = await call(bridge, 'observe', {});
  const invalid = await call(bridge, 'act', {
    frameId: seen.body.frame.frameId,
    actions: [{ type: 'wait', ms: 5 }],
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /1, 5000/);
  failures.act = Object.assign(new Error('Screen layout changed.'), { code: 'STALE_FRAME' });
  const fresh = await call(bridge, 'observe', {});
  const stale = await call(bridge, 'act', {
    frameId: fresh.body.frame.frameId,
    actions: [{ type: 'wait', ms: 5 }],
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'computer_use_stale_frame');
  assert.equal(manager.status().lastFrame, null);
});

test('a dead worker is dropped so the next request spawns fresh', async (t) => {
  let creations = 0;
  const inner = fakeDriver({
    onRequest(command) {
      if (command.method === 'observe')
        return {
          image: { data: IMAGE, mimeType: 'image/png' },
          frame: { width: 60, height: 60, bounds: { x: 0, y: 0, width: 60, height: 60 }, capturedAt: 't' },
        };
      if (command.method === 'act')
        throw Object.assign(new Error('Worker is gone.'), { code: 'WORKER_EXIT' });
      throw new Error(`unexpected ${command.method}`);
    },
  });
  const { bridge, manager } = await fixture(t, {
    driver: Object.assign(inner, {}),
  });
  void creations;
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const seen = await call(bridge, 'observe', {});
  assert.equal(seen.status, 200);
  const dead = await call(bridge, 'act', {
    frameId: seen.body.frame.frameId,
    actions: [{ type: 'wait', ms: 5 }],
  });
  assert.equal(dead.status, 502);
  const revived = await call(bridge, 'observe', {});
  assert.equal(revived.status, 200);
});

test('bridge rejects zero waits, long key names and empty scrolls', async (t) => {
  const { bridge, manager } = await fixture(t);
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const seen = await call(bridge, 'observe', {});
  const frameId = seen.body.frame.frameId;
  assert.equal((await call(bridge, 'act', { frameId, actions: [{ type: 'wait', ms: 0 }] })).status, 400);
  assert.equal(
    (await call(bridge, 'act', { frameId, actions: [{ type: 'keypress', keys: [`k${'y'.repeat(32)}`] }] }))
      .status,
    400,
  );
  assert.equal((await call(bridge, 'act', { frameId, actions: [{ type: 'scroll' }] })).status, 400);
  assert.equal(
    (await call(bridge, 'act', { frameId, actions: [{ type: 'scroll', deltaX: 0, deltaY: 0 }] })).status,
    400,
  );
});

test('fractional edge pixels clamp inside the physical bounds', () => {
  const frame = { width: 800, height: 600, bounds: { x: 0, y: 0, width: 1600, height: 1200 } };
  assert.deepEqual(toPhysicalCoordinates({ type: 'click', x: 799.9, y: 599.9 }, frame), {
    type: 'click',
    x: 1599,
    y: 1199,
  });
  assert.deepEqual(
    toPhysicalCoordinates({ type: 'drag', x: 0.2, y: 0.2, path: [{ x: 799.9, y: 0 }] }, frame).path,
    [{ x: 1599, y: 0 }],
  );
});

test('driver hotkey availability reaches routine status polling', async (t) => {
  let hotkeyRegistered = true;
  const driver = fakeDriver({
    onRequest(command) {
      if (command.method === 'status')
        return {
          supported: true,
          platform: 'win32',
          hotkeyRegistered,
          hotkeyError: hotkeyRegistered ? null : 'Denied.',
        };
      if (command.method === 'observe')
        return {
          image: { data: IMAGE, mimeType: 'image/png' },
          frame: { width: 40, height: 40, bounds: { x: 0, y: 0, width: 40, height: 40 }, capturedAt: 't' },
        };
      throw new Error(`unexpected ${command.method}`);
    },
  });
  const { bridge, manager } = await fixture(t, { driver });
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  assert.equal((await call(bridge, 'status', {})).status, 200);
  assert.equal(manager.status().hotkeyError, null);
  hotkeyRegistered = false;
  assert.equal((await call(bridge, 'status', {})).status, 200);
  assert.equal(manager.status().hotkeyError, 'Denied.');
});

test('release during an in-flight act fails the batch instead of replaying it', async (t) => {
  let releaseAct;
  const actGate = new Promise((resolve) => (releaseAct = resolve));
  const driver = fakeDriver({
    onRequest(command) {
      if (command.method === 'observe')
        return {
          image: { data: IMAGE, mimeType: 'image/png' },
          frame: { width: 60, height: 60, bounds: { x: 0, y: 0, width: 60, height: 60 }, capturedAt: 't' },
        };
      if (command.method === 'act') return actGate.then(() => ({ executed: 1 }));
      throw new Error(`unexpected ${command.method}`);
    },
  });
  const { bridge, manager } = await fixture(t, { driver });
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const seen = await call(bridge, 'observe', {});
  const acting = call(bridge, 'act', {
    frameId: seen.body.frame.frameId,
    actions: [{ type: 'wait', ms: 5 }],
  });
  assert.equal((await call(bridge, 'release', {})).status, 200);
  releaseAct();
  const result = await acting;
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'computer_use_stale_frame');
  assert.deepEqual(driver.stopped, ['release']);
});

for (const windowCapture of [false, true]) {
  test(`actual native observation metadata guards ${windowCapture ? 'window' : 'desktop'} keyboard input`, async (t) => {
    const desktopBounds = { x: -1920, y: 0, width: 3840, height: 1080 };
    const foregroundWindowId = '76543';
    const bounds = windowCapture ? { x: -1800, y: 80, width: 800, height: 600 } : desktopBounds;
    const driver = fakeDriver({
      onRequest(command) {
        if (command.method === 'observe')
          return {
            image: { data: IMAGE, mimeType: 'image/jpeg' },
            frame: {
              width: windowCapture ? 400 : 960,
              height: windowCapture ? 300 : 270,
              bounds,
              capturedAt: '2026-09-22T16:07:36.638Z',
              ...(windowCapture ? { windowId: foregroundWindowId } : {}),
            },
            // Exact worker shape: these are NOT nested in frame.
            desktopBounds,
            foregroundWindowId,
          };
        if (command.method === 'windows')
          return {
            windows: [{ id: foregroundWindowId, bounds, foreground: true }],
          };
        if (command.method === 'act') return { executed: command.params.actions.length };
        throw new Error(`unexpected ${command.method}`);
      },
    });
    const { bridge, manager } = await fixture(t, { driver });
    await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
    const seen = await call(bridge, 'observe', windowCapture ? { windowId: foregroundWindowId } : {});
    assert.equal(seen.status, 200);
    assert.deepEqual(seen.body.frame.desktopBounds, desktopBounds);
    assert.equal(seen.body.frame.foregroundWindowId, foregroundWindowId);
    const acted = await call(bridge, 'act', {
      frameId: seen.body.frame.frameId,
      actions: [{ type: 'keypress', keys: ['CTRL', 'T'] }],
    });
    assert.equal(acted.status, 200, JSON.stringify(acted.body));
    const sent = driver.calls.find((command) => command.method === 'act');
    assert.deepEqual(sent.params.expectedFrame.desktopBounds, desktopBounds);
    assert.equal(sent.params.expectedFrame.foregroundWindowId, foregroundWindowId);
    assert.equal(sent.params.expectedFrame.requireForeground, true);
    if (windowCapture) assert.equal(sent.params.expectedFrame.windowId, foregroundWindowId);
  });
}
