import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createComputerUseManager } from '../lib/computer-use.mjs';
import { createComputerUseBridge } from '../lib/computer-use-bridge.mjs';

// Delegation bridge: permission only via enable/noteRunStarted, exact native
// child holds the desktop. No real desktop, no paid API, fake driver only.

const IMAGE = Buffer.from('fake-screenshot-bytes').toString('base64');
const CONFIGURED_MODEL = 'test-provider/test-cu-model';
const CONFIGURED_THINKING = 'high';
const ROOT_SESSION = 'root-sess-1';
const ROOT_RUN = 'run-1';
const CHILD_AGENT = 'agent-child-1';
const CHILD_SESSION = 'child-sess-1';
const SIBLING_AGENT = 'agent-child-2';
const SIBLING_SESSION = 'child-sess-2';

function legitChild(overrides = {}) {
  return {
    cwd: '/tmp/p',
    sessionId: CHILD_SESSION,
    rootSessionId: ROOT_SESSION,
    ownerId: ROOT_RUN,
    agentId: CHILD_AGENT,
    name: 'CU helper',
    model: CONFIGURED_MODEL,
    imageCapable: true,
    ...overrides,
  };
}

function siblingChild(overrides = {}) {
  return {
    cwd: '/tmp/p',
    sessionId: SIBLING_SESSION,
    rootSessionId: ROOT_SESSION,
    ownerId: ROOT_RUN,
    agentId: SIBLING_AGENT,
    name: 'CU sibling',
    model: CONFIGURED_MODEL,
    imageCapable: true,
    ...overrides,
  };
}

function rootCaller(overrides = {}) {
  return {
    cwd: '/tmp/p',
    sessionId: ROOT_SESSION,
    rootSessionId: ROOT_SESSION,
    ownerId: ROOT_RUN,
    name: 'Prime Agent',
    ...overrides,
  };
}

// Wire identity is hints only, never authorization. Trusted model and
// image capability come from resolveCaller (native resolver).
function legitIdentity(overrides = {}) {
  return {
    cwd: '/tmp/p',
    sessionId: CHILD_SESSION,
    ...overrides,
  };
}

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

async function fixture(t, { driver = fakeDriver(), current = legitChild() } = {}) {
  let box = current;
  const manager = createComputerUseManager({ createDriver: () => driver, isSupported: true });
  const bridge = createComputerUseBridge({
    manager,
    resolveCaller: async () => box,
    isOwnerActive: () => true,
  });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  return {
    manager,
    bridge,
    driver,
    setCaller(next) {
      box = next;
    },
  };
}

async function enablePermission(manager, overrides = {}) {
  return manager.enable({
    sessionId: ROOT_SESSION,
    runId: ROOT_RUN,
    cwd: '/tmp/p',
    computerModel: CONFIGURED_MODEL,
    computerThinking: CONFIGURED_THINKING,
    ...overrides,
  });
}

function call(bridge, action, params = {}, extras = {}) {
  const { token = bridge.config.token, identity = legitIdentity() } = extras;
  return new Promise((resolve, reject) => {
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
    req.end(JSON.stringify({ identity, action, params }));
  });
}

test('enable grants permission only, no holder and no worker', async (t) => {
  const { manager, driver } = await fixture(t);
  await enablePermission(manager);
  assert.equal(manager.ownerInfo(), null);
  assert.equal(driver.calls.length, 0);
  const permission = manager.permissionFor({ ownerId: ROOT_RUN, rootSessionId: ROOT_SESSION });
  assert.equal(permission.computerModel, CONFIGURED_MODEL);
  assert.equal(permission.computerThinking, CONFIGURED_THINKING);
});

test('noteRunStarted grants permission only with routing', async (t) => {
  const { manager, driver } = await fixture(t);
  await manager.enable({
    sessionId: ROOT_SESSION,
    cwd: '/tmp/p',
    computerModel: CONFIGURED_MODEL,
    computerThinking: CONFIGURED_THINKING,
  });
  await manager.noteRunStarted({
    runId: ROOT_RUN,
    sessionId: ROOT_SESSION,
    cwd: '/tmp/p',
  });
  assert.equal(manager.ownerInfo(), null);
  assert.equal(driver.calls.length, 0);
  const permission = manager.permissionFor({ ownerId: ROOT_RUN, rootSessionId: ROOT_SESSION });
  assert.equal(permission.computerModel, CONFIGURED_MODEL);
  assert.equal(permission.computerThinking, CONFIGURED_THINKING);
});

test('main without agentId gets delegate_required on every desktop tool without worker', async (t) => {
  const { bridge, manager, driver, setCaller } = await fixture(t);
  await enablePermission(manager);
  setCaller(rootCaller());
  for (const [action, params] of [
    ['windows', { action: 'list' }],
    ['observe', {}],
    ['act', { frameId: 'f1', actions: [{ type: 'wait', ms: 1 }] }],
  ]) {
    // Even forged wire with a valid model cannot authorize the main.
    const result = await call(bridge, action, params, {
      identity: { cwd: '/tmp/p', sessionId: ROOT_SESSION, model: CONFIGURED_MODEL, imageCapable: true },
    });
    assert.equal(result.status, 409, JSON.stringify({ action, result }));
    assert.equal(result.body.code, 'computer_use_delegate_required', JSON.stringify({ action, result }));
  }
  assert.equal(driver.calls.length, 0);
});

test('wrong configured model is denied without starting a worker', async (t) => {
  const { bridge, manager, driver, setCaller } = await fixture(t);
  await enablePermission(manager);
  setCaller(legitChild({ model: 'other/wrong-model' }));
  const result = await call(bridge, 'observe', {});
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'computer_use_delegate_model');
  assert.equal(driver.calls.length, 0);
});

test('forged wire model cannot override the trusted resolver', async (t) => {
  const { bridge, manager, driver, setCaller } = await fixture(t);
  await enablePermission(manager);
  // Trusted resolver says wrong model; wire forges the configured one.
  setCaller(legitChild({ model: 'other/wrong-model' }));
  const forged = await call(
    bridge,
    'observe',
    {},
    {
      identity: { cwd: '/tmp/p', sessionId: CHILD_SESSION, model: CONFIGURED_MODEL, imageCapable: true },
    },
  );
  assert.equal(forged.status, 409);
  assert.equal(forged.body.code, 'computer_use_delegate_model');
  assert.equal(driver.calls.length, 0);
  // Trusted correct; wire forges a wrong model. Wire is hints only, so it still succeeds.
  setCaller(legitChild());
  const ignored = await call(
    bridge,
    'observe',
    {},
    {
      identity: { cwd: '/tmp/p', sessionId: CHILD_SESSION, model: 'other/wrong-model', imageCapable: false },
    },
  );
  assert.equal(ignored.status, 200);
});

test('model without image support is denied without starting a worker', async (t) => {
  const { bridge, manager, driver, setCaller } = await fixture(t);
  await enablePermission(manager);
  setCaller(legitChild({ imageCapable: false }));
  const result = await call(bridge, 'observe', {});
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'computer_use_no_image_model');
  assert.equal(driver.calls.length, 0);
});

test('forged wire imageCapable cannot override the trusted resolver', async (t) => {
  const { bridge, manager, driver, setCaller } = await fixture(t);
  await enablePermission(manager);
  setCaller(legitChild({ imageCapable: false }));
  const forged = await call(
    bridge,
    'observe',
    {},
    {
      identity: { cwd: '/tmp/p', sessionId: CHILD_SESSION, model: CONFIGURED_MODEL, imageCapable: true },
    },
  );
  assert.equal(forged.status, 409);
  assert.equal(forged.body.code, 'computer_use_no_image_model');
  assert.equal(driver.calls.length, 0);
});

test('two enabled conversations stay free until real desktop use', async (t) => {
  const driver = fakeDriver();
  let factories = 0;
  const manager = createComputerUseManager({
    createDriver: () => {
      factories += 1;
      return driver;
    },
    isSupported: true,
  });
  let box = legitChild();
  const bridge = createComputerUseBridge({
    manager,
    resolveCaller: async () => box,
    isOwnerActive: () => true,
  });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  await manager.enable({
    sessionId: ROOT_SESSION,
    runId: ROOT_RUN,
    cwd: '/tmp/p',
    computerModel: CONFIGURED_MODEL,
    computerThinking: CONFIGURED_THINKING,
  });
  await manager.enable({
    sessionId: 'root-sess-2',
    runId: 'run-2',
    cwd: '/tmp/p',
    computerModel: CONFIGURED_MODEL,
    computerThinking: CONFIGURED_THINKING,
  });
  assert.equal(manager.ownerInfo(), null);
  const first = await call(bridge, 'status');
  assert.equal(first.status, 200);
  assert.equal(first.body.enabled, true);
  box = {
    cwd: '/tmp/p',
    sessionId: 'child-sess-9',
    rootSessionId: 'root-sess-2',
    ownerId: 'run-2',
    agentId: 'agent-child-9',
    model: CONFIGURED_MODEL,
    imageCapable: true,
  };
  const second = await call(
    bridge,
    'status',
    {},
    {
      identity: { cwd: '/tmp/p', sessionId: 'child-sess-9', model: CONFIGURED_MODEL, imageCapable: true },
    },
  );
  assert.equal(second.status, 200);
  assert.equal(second.body.enabled, true);
  assert.equal(manager.ownerInfo(), null);
  assert.equal(factories, 0);
  assert.equal(driver.calls.length, 0);
});

test('status never acquires and returns routing, delegated and mine', async (t) => {
  const { bridge, manager, driver } = await fixture(t);
  await enablePermission(manager);
  const idle = await call(bridge, 'status');
  assert.equal(idle.status, 200);
  assert.equal(idle.body.enabled, true);
  assert.equal(idle.body.delegated, true);
  assert.equal(idle.body.mine, false);
  assert.deepEqual(idle.body.routing, { model: CONFIGURED_MODEL, thinking: CONFIGURED_THINKING });
  assert.equal(idle.body.driver, null);
  assert.equal(idle.body.lastFrame, null);
  assert.equal(driver.calls.length, 0);
  assert.equal(manager.ownerInfo(), null);
  const seen = await call(bridge, 'observe', {});
  assert.equal(seen.status, 200);
  const held = await call(bridge, 'status');
  assert.equal(held.body.mine, true);
  assert.equal(held.body.delegated, true);
  assert.ok(held.body.driver);
});

test('sibling of the same run never shares the holder', async (t) => {
  const { bridge, manager, setCaller } = await fixture(t);
  await enablePermission(manager);
  const first = await call(bridge, 'observe', {});
  assert.equal(first.status, 200);
  const holder = manager.ownerInfo();
  assert.equal(holder.agentId, CHILD_AGENT);
  assert.equal(holder.agentSessionId, CHILD_SESSION);
  setCaller(siblingChild());
  for (const [action, params, identity] of [
    ['observe', {}, legitIdentity({ sessionId: SIBLING_SESSION })],
    ['windows', { action: 'list' }, legitIdentity({ sessionId: SIBLING_SESSION })],
    [
      'act',
      { frameId: first.body.frame.frameId, actions: [{ type: 'wait', ms: 1 }] },
      legitIdentity({ sessionId: SIBLING_SESSION }),
    ],
  ]) {
    const denied = await call(bridge, action, params, { identity });
    assert.equal(denied.status, 409, JSON.stringify({ action, denied }));
    assert.equal(denied.body.code, 'computer_use_busy', JSON.stringify({ action, denied }));
  }
  // Exact holder still owns its frame.
  assert.equal(manager.ownerInfo().agentId, CHILD_AGENT);
  setCaller(legitChild());
  const acted = await call(bridge, 'act', {
    frameId: first.body.frame.frameId,
    actions: [{ type: 'wait', ms: 1 }],
  });
  assert.equal(acted.status, 200);
});

test('foreign release is a noop and preserves the holder frame', async (t) => {
  const { bridge, manager, setCaller } = await fixture(t);
  await enablePermission(manager);
  const seen = await call(bridge, 'observe', {});
  assert.equal(seen.status, 200);
  setCaller(siblingChild());
  const foreign = await call(
    bridge,
    'release',
    {},
    { identity: legitIdentity({ sessionId: SIBLING_SESSION }) },
  );
  assert.equal(foreign.status, 200);
  assert.equal(foreign.body.released, false);
  assert.equal(manager.ownerInfo().agentId, CHILD_AGENT);
  setCaller(legitChild());
  const acted = await call(bridge, 'act', {
    frameId: seen.body.frame.frameId,
    actions: [{ type: 'wait', ms: 1 }],
  });
  assert.equal(acted.status, 200, JSON.stringify(acted.body));
});

test('exact holder release relinquishes the lease but keeps permission', async (t) => {
  const { bridge, manager } = await fixture(t);
  await enablePermission(manager);
  const seen = await call(bridge, 'observe', {});
  assert.equal(seen.status, 200);
  const released = await call(bridge, 'release', {});
  assert.equal(released.status, 200);
  assert.equal(released.body.released, true);
  assert.equal(manager.ownerInfo(), null);
  assert.equal(manager.status({ runId: ROOT_RUN }).enabled, true);
  assert.equal(manager.status().lastFrame, null);
  const replay = await call(bridge, 'act', {
    frameId: seen.body.frame.frameId,
    actions: [{ type: 'wait', ms: 1 }],
  });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, 'computer_use_stale_frame');
});

test('a new agent can acquire after release but must observe fresh', async (t) => {
  const { bridge, manager, setCaller } = await fixture(t);
  await enablePermission(manager);
  const first = await call(bridge, 'observe', {});
  assert.equal(first.status, 200);
  assert.equal((await call(bridge, 'release', {})).body.released, true);
  setCaller(siblingChild());
  const stale = await call(
    bridge,
    'act',
    {
      frameId: first.body.frame.frameId,
      actions: [{ type: 'wait', ms: 1 }],
    },
    { identity: legitIdentity({ sessionId: SIBLING_SESSION }) },
  );
  assert.equal(stale.status, 409);
  const fresh = await call(
    bridge,
    'observe',
    {},
    { identity: legitIdentity({ sessionId: SIBLING_SESSION }) },
  );
  assert.equal(fresh.status, 200);
  assert.equal(manager.ownerInfo().agentId, SIBLING_AGENT);
  const acted = await call(
    bridge,
    'act',
    {
      frameId: fresh.body.frame.frameId,
      actions: [{ type: 'wait', ms: 1 }],
    },
    { identity: legitIdentity({ sessionId: SIBLING_SESSION }) },
  );
  assert.equal(acted.status, 200);
});

test('the same agent can reacquire after release with a fresh frame', async (t) => {
  const { bridge, manager } = await fixture(t);
  await enablePermission(manager);
  const first = await call(bridge, 'observe', {});
  assert.equal(first.status, 200);
  assert.equal((await call(bridge, 'release', {})).body.released, true);
  const stale = await call(bridge, 'act', {
    frameId: first.body.frame.frameId,
    actions: [{ type: 'wait', ms: 1 }],
  });
  assert.equal(stale.status, 409);
  const fresh = await call(bridge, 'observe', {});
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.frame.frameId, first.body.frame.frameId);
  assert.equal(manager.ownerInfo().agentId, CHILD_AGENT);
  assert.equal(
    (
      await call(bridge, 'act', {
        frameId: fresh.body.frame.frameId,
        actions: [{ type: 'wait', ms: 1 }],
      })
    ).status,
    200,
  );
});

test('windows list requires the exact holder', async (t) => {
  const { bridge, manager, setCaller } = await fixture(t);
  await enablePermission(manager);
  setCaller(rootCaller());
  const denied = await call(
    bridge,
    'windows',
    { action: 'list' },
    {
      identity: { cwd: '/tmp/p', sessionId: ROOT_SESSION, model: CONFIGURED_MODEL, imageCapable: true },
    },
  );
  assert.equal(denied.status, 409);
  assert.equal(denied.body.code, 'computer_use_delegate_required');
  setCaller(legitChild());
  assert.equal((await call(bridge, 'windows', { action: 'list' })).status, 200);
  assert.equal(manager.ownerInfo().agentId, CHILD_AGENT);
});
