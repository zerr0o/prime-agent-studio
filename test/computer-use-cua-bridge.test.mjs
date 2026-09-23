import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createComputerUseManager } from '../lib/computer-use.mjs';
import { createComputerUseBridge } from '../lib/computer-use-bridge.mjs';

const caller = { cwd: '/tmp/p', sessionId: 's', rootSessionId: 's', ownerId: 'r' };
function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}
function deferred(t) {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  const timer = setTimeout(() => resolve(), 2000);
  t.after(() => {
    clearTimeout(timer);
    resolve();
  });
  return {
    promise,
    resolve: () => {
      clearTimeout(timer);
      resolve();
    },
  };
}
async function fixture(t, { backend = 'cua', onRequest, onResolve } = {}) {
  const calls = [];
  let seq = 0;
  const driver = {
    async request(command) {
      calls.push(command);
      const override = await onRequest?.(command);
      if (override !== undefined) return override;
      if (command.method === 'status') return { supported: true, hotkeyRegistered: true, hotkeyError: 0 };
      if (command.method === 'windows') return { windows: [{ id: '432:198738', foreground: false }] };
      if (['observe', 'inspect'].includes(command.method)) {
        seq++;
        const snapshotId = 's' + seq.toString(16).padStart(8, '0');
        const kind = command.method === 'inspect' ? 'accessibility' : 'screenshot';
        return {
          ...(kind === 'screenshot' ? { image: { mimeType: 'image/png', data: pngHeader(800, 450) } } : {}),
          frame: {
            width: 800,
            height: 450,
            windowId: command.params.windowId,
            bounds: { x: -1600, y: 100, width: 1600, height: 900 },
          },
          driverFrame: {
            backend: 'cua',
            kind,
            pid: 432,
            windowId: 198738,
            snapshotId,
            sessionLabel: 'private',
          },
          elements: [{ elementId: snapshotId + ':1', role: 'button', label: 'Play', enabled: true }],
          timing: { driverMs: 2 },
        };
      }
      if (command.method === 'act')
        return {
          executed: command.params.actions.length,
          results: [{ index: 0, effect: 'confirmed', route: 'uia' }],
        };
      throw new Error(command.method);
    },
    async stop() {},
    async close() {},
  };
  const manager = createComputerUseManager({
    isSupported: true,
    createDriver: () => driver,
    cuaAvailability: { available: true, supported: true },
  });
  const bridge = createComputerUseBridge({
    manager,
    resolveCaller: async (identity) => {
      await onResolve?.(identity);
      return caller;
    },
  });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  await manager.enable({ sessionId: 's', runId: 'r', cwd: '/tmp/p', backend });
  return { manager, bridge, calls };
}
function call(bridge, action, params = {}) {
  return new Promise((resolve, reject) => {
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
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      },
    );
    req.setTimeout(4000, () => req.destroy(new Error('test request deadline')));
    req.on('error', reject);
    req.end(JSON.stringify({ identity: { sessionId: 's', testAction: action }, action, params }));
  });
}
const windowId = '432:198738';

test('CUA snapshot pixels stay local, binding stays private, and non-foreground target is supported', async (t) => {
  const { bridge, manager, calls } = await fixture(t);
  const shot = await call(bridge, 'observe', { windowId });
  assert.equal(shot.status, 200);
  assert.equal(shot.body.frame.backend, 'cua');
  assert.equal(shot.body.frame.driverFrame, undefined);
  assert.equal(manager.status().lastFrame.driverFrame, undefined);
  assert.ok(manager.takeFrame(shot.body.frame.frameId).driverFrame);
  assert.equal(shot.body.elements[0].label, 'Play');
  const result = await call(bridge, 'act', {
    frameId: shot.body.frame.frameId,
    actions: [{ type: 'click', x: 400, y: 200 }],
    deliveryMode: 'foreground',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.applicationState, 'unverified');
  const act = calls.find((c) => c.method === 'act');
  assert.deepEqual(act.params.actions[0], { type: 'click', x: 400, y: 200 });
  assert.equal(act.params.expectedFrame.driverFrame.snapshotId, 's00000001');
  assert.equal(act.params.deliveryMode, 'foreground');
  assert.equal(calls.filter((c) => c.method === 'windows').length, 0);
});

test('CUA inspection returns no pixels and supports element actions', async (t) => {
  const { bridge, calls } = await fixture(t);
  const inspected = await call(bridge, 'inspect', { windowId });
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.image, undefined);
  assert.equal(inspected.body.frame.kind, 'accessibility');
  const frameId = inspected.body.frame.frameId,
    elementId = inspected.body.elements[0].elementId;
  const invalid = await call(bridge, 'act', { frameId, actions: [{ type: 'click', x: 2, y: 3 }] });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /Accessibility-only/);
  const result = await call(bridge, 'act', {
    frameId,
    actions: [{ type: 'set_value', elementId, value: '' }],
    deliveryMode: 'background',
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.find((c) => c.method === 'act').params.actions, [
    { type: 'set_value', elementId, value: '' },
  ]);
});

test('inspection refuses native backend and ambiguous target without touching driver', async (t) => {
  const native = await fixture(t, { backend: 'native' });
  assert.equal((await call(native.bridge, 'inspect', { windowId })).status, 409);
  assert.equal(native.calls.length, 0);
  const cua = await fixture(t);
  assert.equal((await call(cua.bridge, 'inspect')).status, 400);
  assert.equal(cua.calls.length, 0);
});

test('new CUA snapshot invalidates prior snapshots', async (t) => {
  const { bridge } = await fixture(t);
  const first = await call(bridge, 'inspect', { windowId });
  await call(bridge, 'observe', { windowId });
  const old = await call(bridge, 'act', {
    frameId: first.body.frame.frameId,
    actions: [{ type: 'click', elementId: first.body.elements[0].elementId }],
  });
  assert.equal(old.status, 409);
});

test('element and pixel targets cannot mix and invalid batches do not consume the frame', async (t) => {
  const { bridge, manager, calls } = await fixture(t);
  const shot = await call(bridge, 'observe', { windowId });
  const frameId = shot.body.frame.frameId,
    elementId = shot.body.elements[0].elementId;
  for (const action of [
    { type: 'click', elementId, x: 1, y: 2 },
    { type: 'set_value', value: 'x' },
    { type: 'scroll', deltaY: 0.2 },
    { type: 'move', elementId },
    { type: 'type' },
  ])
    assert.equal((await call(bridge, 'act', { frameId, actions: [action] })).status, 400);
  assert.ok(manager.takeFrame(frameId));
  assert.equal(calls.filter((c) => c.method === 'act').length, 0);
});

test('original backend rejects CUA action fields before dispatch', async (t) => {
  const { bridge, calls } = await fixture(t, { backend: 'native' });
  const shot = await call(bridge, 'observe');
  const frameId = shot.body.frame.frameId;
  assert.equal(
    (await call(bridge, 'act', { frameId, actions: [{ type: 'click', elementId: 's00000001:1' }] })).status,
    400,
  );
  assert.equal(
    (await call(bridge, 'act', { frameId, actions: [{ type: 'wait', ms: 1 }], deliveryMode: 'background' }))
      .status,
    400,
  );
  assert.equal(calls.filter((c) => c.method === 'act').length, 0);
});

test('CUA partial result survives same-call verification without invented success', async (t) => {
  const { bridge } = await fixture(t, {
    onRequest: (c) =>
      c.method === 'act'
        ? { executed: 0, partial: true, results: [{ effect: 'refused', route: 'none' }] }
        : undefined,
  });
  const shot = await call(bridge, 'observe', { windowId });
  const result = await call(bridge, 'act', {
    frameId: shot.body.frame.frameId,
    actions: [{ type: 'click', x: 1, y: 1 }],
    observeAfter: true,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.executed, 0);
  assert.equal(result.body.partial, true);
  assert.equal(result.body.results[0].effect, 'refused');
  assert.equal(result.body.applicationState, 'unverified');
  assert.ok(result.body.observe.image);
});

test('CUA missing completion count is unknown rather than defaulting to batch length', async (t) => {
  const { bridge } = await fixture(t, {
    onRequest: (c) => (c.method === 'act' ? { results: [] } : undefined),
  });
  const shot = await call(bridge, 'observe', { windowId });
  const result = await call(bridge, 'act', {
    frameId: shot.body.frame.frameId,
    actions: [{ type: 'wait', ms: 1 }],
  });
  assert.equal(result.body.executed, null);
  assert.equal(result.body.inputState, 'unknown');
});

test('driver errors after dispatch consume frames, including generic errors', async (t) => {
  const { bridge, manager } = await fixture(t, {
    onRequest: (c) => {
      if (c.method === 'act') throw new Error('Injected after dispatch');
    },
  });
  const shot = await call(bridge, 'observe', { windowId });
  assert.equal(
    (await call(bridge, 'act', { frameId: shot.body.frame.frameId, actions: [{ type: 'wait', ms: 1 }] }))
      .status,
    502,
  );
  assert.equal(manager.status().lastFrame, null);
});

for (const [width, height] of [
  [2001, 100],
  [100, 2001],
]) {
  test(`capture safety rejects actual ${width}x${height} pixels even if metadata claims smaller`, async (t) => {
    const { bridge, manager } = await fixture(t, {
      backend: 'native',
      onRequest: (c) =>
        c.method === 'observe'
          ? {
              image: { data: pngHeader(width, height), mimeType: 'image/png' },
              frame: { width: 100, height: 100, bounds: { x: 0, y: 0, width, height } },
            }
          : undefined,
    });
    const result = await call(bridge, 'observe');
    assert.equal(result.status, 413);
    assert.match(result.body.error, /both axes/);
    assert.equal(manager.status().lastFrame, null);
  });
}

test('capture safety rejects pixel and coordinate metadata mismatch', async (t) => {
  const { bridge } = await fixture(t, {
    backend: 'native',
    onRequest: (c) =>
      c.method === 'observe'
        ? {
            image: { data: pngHeader(640, 480), mimeType: 'image/png' },
            frame: { width: 100, height: 100, bounds: { x: 0, y: 0, width: 640, height: 480 } },
          }
        : undefined,
  });
  const result = await call(bridge, 'observe');
  assert.equal(result.status, 502);
  assert.match(result.body.error, /do not match/);
});

test('native hotkey success with error zero is not reported as unavailable', async (t) => {
  const { bridge } = await fixture(t, { backend: 'native' });
  const result = await call(bridge, 'status');
  assert.equal(result.status, 200);
  assert.equal(result.body.hotkeyError, null);
});

test('native focus refusal stays explicit and discards old frames', async (t) => {
  const { bridge, manager } = await fixture(t, {
    backend: 'native',
    onRequest: (c) => {
      if (c.method === 'windows')
        throw Object.assign(new Error('Roon focus denied, Chrome is foreground.'), { code: 'FOCUS_REFUSED' });
    },
  });
  await call(bridge, 'observe');
  const result = await call(bridge, 'windows', { action: 'focus', windowId: '198738' });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'computer_use_focus_refused');
  assert.match(result.body.error, /Chrome/);
  assert.equal(manager.status().lastFrame, null);
});

test('snapshot capture cannot interleave an in-flight CUA batch', async (t) => {
  const entered = deferred(t),
    proceed = deferred(t);
  const { bridge, calls } = await fixture(t, {
    onRequest: async (c) => {
      if (c.method === 'act') {
        entered.resolve();
        await proceed.promise;
        return { executed: 1 };
      }
    },
  });
  const shot = await call(bridge, 'observe', { windowId });
  const act = call(bridge, 'act', { frameId: shot.body.frame.frameId, actions: [{ type: 'wait', ms: 1 }] });
  await entered.promise;
  const second = call(bridge, 'inspect', { windowId });
  try {
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.filter((c) => c.method === 'inspect').length, 0);
  } finally {
    proceed.resolve();
  }
  assert.equal((await act).status, 200);
  assert.equal((await second).status, 200);
});

test('stop and same-owner re-enable during native focus preflight cannot revive old input', async (t) => {
  const entered = deferred(t),
    proceed = deferred(t);
  const { bridge, manager, calls } = await fixture(t, {
    backend: 'native',
    onRequest: async (c) => {
      if (c.method === 'windows') {
        entered.resolve();
        await proceed.promise;
        return { windows: [{ id: windowId, foreground: true }] };
      }
    },
  });
  const shot = await call(bridge, 'observe', { windowId });
  const act = call(bridge, 'act', {
    frameId: shot.body.frame.frameId,
    actions: [{ type: 'click', x: 1, y: 1 }],
  });
  await entered.promise;
  try {
    await manager.stop();
    await manager.enable({ sessionId: 's', runId: 'r', cwd: '/tmp/p' });
  } finally {
    proceed.resolve();
  }
  assert.equal((await act).status, 409);
  assert.equal(calls.filter((c) => c.method === 'act').length, 0);
});

for (const action of ['windows', 'observe', 'inspect']) {
  test(`queued ${action} cannot survive stop and same-owner re-enable`, async (t) => {
    const entered = deferred(t),
      proceed = deferred(t),
      queued = deferred(t);
    let watching = false;
    const { bridge, manager, calls } = await fixture(t, {
      backend: action === 'inspect' ? 'cua' : 'native',
      onResolve: (identity) => {
        if (watching && identity.testAction === action) queued.resolve();
      },
      onRequest: async (c) => {
        if (c.method === 'act') {
          entered.resolve();
          await proceed.promise;
          return { executed: 1 };
        }
      },
    });
    const shot = await call(bridge, 'observe');
    const inflight = call(bridge, 'act', {
      frameId: shot.body.frame.frameId,
      actions: [{ type: 'wait', ms: 1 }],
    });
    await entered.promise;
    watching = true;
    const old = call(bridge, action, action === 'windows' ? { action: 'focus', windowId } : { windowId });
    await queued.promise;
    await new Promise((r) => setImmediate(r));
    const before = calls.length;
    try {
      await manager.stop();
      await manager.enable({
        sessionId: 's',
        runId: 'r',
        cwd: '/tmp/p',
        backend: action === 'inspect' ? 'cua' : 'native',
      });
    } finally {
      proceed.resolve();
    }
    assert.equal((await inflight).status, 409);
    assert.equal((await old).status, 409);
    assert.equal(calls.length, before, 'no queued request reaches replacement driver');
  });
}

test('worker stale generation is a fresh-frame conflict, not a gateway failure', async (t) => {
  const { bridge } = await fixture(t, {
    backend: 'native',
    onRequest: (c) => {
      if (c.method === 'windows')
        throw Object.assign(new Error('Worker generation changed.'), { code: 'STALE_GENERATION' });
    },
  });
  const result = await call(bridge, 'windows', { action: 'focus', windowId });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'computer_use_stale_frame');
});

test('off bridge status waits for availability refresh without creating a driver', async (t) => {
  let created = 0;
  let refreshed = 0;
  const manager = createComputerUseManager({
    isSupported: true,
    cuaAvailability: { available: false, supported: true },
    createDriver: () => {
      created++;
      throw new Error('off status must not create a driver');
    },
  });
  const gate = deferred(t),
    entered = deferred(t);
  const realRefresh = manager.refreshBackends;
  manager.refreshBackends = async () => {
    refreshed++;
    entered.resolve();
    await gate.promise;
    return realRefresh();
  };
  const bridge = createComputerUseBridge({ manager, resolveCaller: async () => caller });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  let settled = false;
  const pending = call(bridge, 'status').finally(() => {
    settled = true;
  });
  try {
    await entered.promise;
    assert.equal(refreshed, 1);
    assert.equal(settled, false);
  } finally {
    gate.resolve();
  }
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(result.body.enabled, false);
  assert.equal(result.body.mine, false);
  assert.equal(result.body.driver, null);
  assert.equal(created, 0);
});

test('late failed driver status cannot claim a replacement foreign owner or cache its hotkey state', async (t) => {
  const gate = deferred(t),
    entered = deferred(t);
  const { bridge, manager } = await fixture(t, {
    onRequest: async (command) => {
      if (command.method !== 'status') return;
      entered.resolve();
      await gate.promise;
      throw new Error('late old driver failure');
    },
  });
  const pending = call(bridge, 'status');
  try {
    await entered.promise;
    await manager.enable({
      sessionId: 'foreign',
      runId: 'foreign-run',
      cwd: '/tmp/other',
      backend: 'native',
    });
  } finally {
    gate.resolve();
  }
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(result.body.mine, false);
  assert.equal(result.body.driver, null);
  assert.equal(result.body.owner.runId, 'foreign-run');
});
