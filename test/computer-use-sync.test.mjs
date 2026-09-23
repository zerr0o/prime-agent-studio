import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createComputerUseManager } from '../lib/computer-use.mjs';
import { createComputerUseBridge } from '../lib/computer-use-bridge.mjs';

const caller = { cwd: '/tmp/p', sessionId: 'sess-1', rootSessionId: 'sess-1', ownerId: 'run-1' };
const target = { id: 'qobuz-1', processName: 'Qobuz', title: 'Qobuz - Player', foreground: true };
const image = { data: Buffer.from('synthetic only').toString('base64'), mimeType: 'image/png' };

function gate(t) {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const timer = setTimeout(() => reject(new Error('Test gate deadline')), 2000);
  promise.catch(() => {});
  t.after(() => {
    clearTimeout(timer);
    resolve({ windows: [] });
  });
  return {
    promise,
    resolve: (value) => {
      clearTimeout(timer);
      resolve(value);
    },
  };
}

async function fixture(t, hook = () => undefined, driverGate) {
  const calls = [];
  let factories = 0;
  const driver = {
    async request(command) {
      calls.push(command);
      const custom = await hook(command);
      if (custom !== undefined) return custom;
      if (command.method === 'windows') return { windows: [target] };
      if (command.method === 'act') return { executed: command.params.actions.length };
      if (command.method === 'observe')
        return {
          image,
          frame: {
            width: 800,
            height: 600,
            bounds: command.params.region || { x: -2560, y: 0, width: 1600, height: 1200 },
            ...(command.params.windowId ? { windowId: command.params.windowId } : {}),
          },
        };
      return {};
    },
    async stop() {},
    async close() {},
  };
  const manager = createComputerUseManager({
    createDriver: () => {
      factories++;
      return driverGate ? driverGate.then(() => driver) : driver;
    },
    isSupported: true,
  });
  const bridge = createComputerUseBridge({ manager, resolveCaller: async () => caller });
  await bridge.ready;
  t.after(async () => {
    const cleanup = await Promise.allSettled([bridge.close(), manager.close()]);
    for (const item of cleanup) if (item.status === 'rejected') throw item.reason;
  });
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  return {
    bridge,
    manager,
    calls,
    get factories() {
      return factories;
    },
  };
}

function call(bridge, action, params = {}, signal) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: bridge.config.socketPath,
        method: 'POST',
        path: '/',
        agent: false,
        signal,
        headers: { Authorization: `Bearer ${bridge.config.token}`, 'Content-Type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      },
    );
    req.setTimeout(4000, () => req.destroy(new Error('Test HTTP deadline')));
    req.on('error', reject);
    req.end(JSON.stringify({ identity: { cwd: '/tmp/p', sessionId: 'sess-1' }, action, params }));
  });
}

async function until(predicate) {
  const deadline = performance.now() + 1500;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'bounded condition deadline');
    await delay(10);
  }
}

for (const scope of [
  { windowId: target.id, maxWidth: 1600 },
  { region: { x: -2400, y: 100, width: 1200, height: 800 }, maxWidth: 900 },
  { maxWidth: 2048 },
  {},
]) {
  test(`observeAfter preserves capture scope ${JSON.stringify(scope)}`, async (t) => {
    const { bridge, calls } = await fixture(t);
    const seen = await call(bridge, 'observe', scope);
    const acted = await call(bridge, 'act', {
      frameId: seen.body.frame.frameId,
      actions: [{ type: 'click', x: 10, y: 10 }],
      observeAfter: true,
    });
    assert.equal(acted.status, 200);
    assert.equal(acted.body.executed, 1);
    assert.equal(acted.body.applicationState, 'unverified');
    assert.deepEqual(
      calls.filter((item) => item.method === 'observe').map((item) => item.params),
      [scope, scope],
    );
    assert.deepEqual(acted.body.observe.frame.captureOptions, scope);
    assert.notEqual(acted.body.observe.frame.frameId, seen.body.frame.frameId);
  });
}

for (const override of [{}, { windowId: target.id, maxWidth: 1800 }]) {
  test(`observeOptions explicitly replaces the old crop ${JSON.stringify(override)}`, async (t) => {
    const { bridge, calls } = await fixture(t);
    const seen = await call(bridge, 'observe', {
      region: { x: 0, y: 0, width: 800, height: 600 },
      maxWidth: 800,
    });
    const acted = await call(bridge, 'act', {
      frameId: seen.body.frame.frameId,
      actions: [{ type: 'click', x: 10, y: 10 }],
      observeAfter: true,
      observeOptions: override,
    });
    assert.equal(acted.status, 200);
    assert.deepEqual(calls.filter((item) => item.method === 'observe').at(-1).params, override);
    assert.deepEqual(acted.body.observe.frame.captureOptions, override);
  });
}

test('invalid observeOptions fails before any input or frame consumption', async (t) => {
  const { bridge, calls } = await fixture(t);
  const seen = await call(bridge, 'observe');
  for (const params of [
    { observeOptions: {} },
    { observeAfter: true, observeOptions: null },
    { observeAfter: true, observeOptions: { maxWidth: 99999 } },
    { observeAfter: true, observeOptions: { region: { x: 0, y: 0, width: 0, height: 4 } } },
  ]) {
    const response = await call(bridge, 'act', {
      frameId: seen.body.frame.frameId,
      actions: [{ type: 'click', x: 1, y: 1 }],
      ...params,
    });
    assert.equal(response.status, 400);
  }
  assert.equal(calls.filter((item) => item.method === 'act').length, 0);
  assert.equal(
    (
      await call(bridge, 'act', {
        frameId: seen.body.frame.frameId,
        actions: [{ type: 'click', x: 1, y: 1 }],
      })
    ).status,
    200,
  );
});

test('failed verification preserves completed input and rejects replay of its consumed frame', async (t) => {
  let observations = 0;
  const { bridge, manager, calls } = await fixture(t, (command) => {
    if (command.method === 'observe' && ++observations === 2)
      throw Object.assign(new Error('Window disappeared'), { code: 'STALE_FRAME' });
  });
  const seen = await call(bridge, 'observe');
  const params = {
    frameId: seen.body.frame.frameId,
    actions: [{ type: 'click', x: 1, y: 1 }],
    observeAfter: true,
  };
  const result = await call(bridge, 'act', params);
  assert.equal(result.status, 200);
  assert.equal(result.body.executed, 1);
  assert.equal(result.body.applicationState, 'unverified');
  assert.equal(result.body.observationError.code, 'computer_use_stale_frame');
  assert.match(result.body.observationError.message, /Input completed.*Do not replay/);
  assert.equal(result.body.observe, undefined);
  assert.equal(manager.status().lastFrame, null);
  assert.equal((await call(bridge, 'act', params)).status, 409);
  assert.equal(calls.filter((item) => item.method === 'act').length, 1);
});

test('delayed Qobuz launch waits for the new window then observes it on another monitor', async (t) => {
  let listings = 0;
  const { bridge, calls } = await fixture(t, (command) => {
    if (command.method === 'windows') return { windows: ++listings >= 3 ? [target] : [] };
  });
  const seen = await call(bridge, 'observe', {
    region: { x: 0, y: 1500, width: 1200, height: 800 },
    maxWidth: 800,
  });
  const clicked = await call(bridge, 'act', {
    frameId: seen.body.frame.frameId,
    actions: [{ type: 'click', x: 50, y: 50 }],
    observeAfter: true,
  });
  assert.equal(clicked.body.applicationState, 'unverified');
  const waiting = await call(bridge, 'windows', {
    action: 'wait',
    processName: 'qObUz.ExE',
    title: 'PLAYER',
    timeoutMs: 1500,
  });
  assert.equal(waiting.status, 200);
  assert.equal(waiting.body.found, true);
  assert.equal(waiting.body.timedOut, false);
  assert.equal(waiting.body.window.id, target.id);
  assert.ok(waiting.body.elapsedMs >= 400);
  assert.match(waiting.body.note, /does not confirm application readiness/);
  const actual = await call(bridge, 'observe', { windowId: waiting.body.window.id, maxWidth: 1600 });
  assert.equal(actual.body.frame.bounds.x, -2560);
  assert.equal(actual.body.frame.windowId, target.id);
  assert.equal(calls.filter((item) => item.method === 'act').length, 1);
  assert.ok(calls.filter((item) => item.method === 'windows').every((item) => item.params.action === 'list'));
});

test('window wait combines filters, ignores partial process matches and prefers foreground matches', async (t) => {
  const other = { ...target, id: 'other', processName: 'notQobuz' };
  const background = { ...target, id: 'background', foreground: false };
  const { bridge, calls } = await fixture(t, (command) =>
    command.method === 'windows' ? { windows: [other, background, target] } : undefined,
  );
  const result = await call(bridge, 'windows', {
    action: 'wait',
    processName: 'QOBUZ',
    title: 'qobuz -',
    windowId: target.id,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.windows, [target]);
  const multiple = await call(bridge, 'windows', { action: 'wait', processName: 'QOBUZ' });
  assert.equal(multiple.body.windows.length, 2);
  assert.equal(multiple.body.window.id, target.id);
  assert.ok(calls.every((item) => item.method === 'windows' && item.params.action === 'list'));
});

test('window wait deadline is not reported as application failure', async (t) => {
  const { bridge, calls, manager } = await fixture(t, () => ({ windows: [] }));
  const result = await call(bridge, 'windows', { action: 'wait', title: 'Qobuz', timeoutMs: 100 });
  assert.equal(result.status, 200);
  assert.equal(result.body.found, false);
  assert.equal(result.body.timedOut, true);
  assert.equal(result.body.window, undefined);
  assert.ok(result.body.elapsedMs >= 90 && result.body.elapsedMs < 1500);
  assert.match(result.body.note, /not proof of launch failure/);
  assert.equal(manager.status().lastFrame, null);
  assert.equal(calls.length, 1);
});

test(
  'early timers do not trigger another window listing before the next poll',
  { timeout: 3000 },
  async (t) => {
    const { bridge, calls } = await fixture(t, () => ({ windows: [] }));
    const originalSetTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) =>
      originalSetTimeout(callback, Math.max(1, Number(ms || 0) - 20), ...args),
    );
    const result = await call(bridge, 'windows', { action: 'wait', title: 'Qobuz', timeoutMs: 100 });
    assert.equal(result.status, 200);
    assert.equal(result.body.timedOut, true);
    assert.equal(calls.length, 1);
  },
);

test('window wait rejects invalid filters and deadlines before touching the worker', async (t) => {
  const env = await fixture(t);
  for (const params of [
    {},
    { title: '' },
    { title: '  ' },
    { title: 123 },
    { title: 'a'.repeat(501) },
    { windowId: '' },
    { processName: '.exe' },
    { processName: [] },
    ...[null, 0, 99, 20001, 100.1, '100'].map((timeoutMs) => ({ title: 'Qobuz', timeoutMs })),
  ]) {
    const result = await call(env.bridge, 'windows', { action: 'wait', ...params });
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.equal(result.body.code, 'computer_use_invalid');
  }
  assert.equal(env.factories, 0);
  assert.equal(env.calls.length, 0);
});

test('an in-flight slow listing cannot extend the wait deadline or deliver a late success', async (t) => {
  const pending = gate(t);
  const { bridge, manager, calls } = await fixture(t, () => pending.promise);
  try {
    const result = await call(bridge, 'windows', { action: 'wait', title: 'Qobuz', timeoutMs: 100 });
    assert.equal(result.status, 200);
    assert.equal(result.body.timedOut, true);
    assert.ok(result.body.elapsedMs < 1500);
    pending.resolve({ windows: [target] });
    await until(() => !manager.status().busy);
    assert.equal(calls.length, 1);
    assert.equal(manager.status().lastFrame, null);
  } finally {
    pending.resolve({ windows: [] });
  }
});

for (const transition of ['stop', 'release', 'switch-owner', 'stop-and-reenable']) {
  test(`window wait is fenced by ${transition} even while a listing is pending`, async (t) => {
    const pending = gate(t);
    const entered = gate(t);
    const env = await fixture(t, () => {
      entered.resolve();
      return pending.promise;
    });
    try {
      const waiting = call(env.bridge, 'windows', { action: 'wait', title: 'Qobuz', timeoutMs: 1500 });
      await entered.promise;
      if (transition === 'release') await env.manager.releaseInput();
      else if (transition === 'switch-owner')
        await env.manager.enable({ sessionId: 'sess-2', runId: 'run-2', cwd: '/tmp/p' });
      else {
        await env.manager.stop();
        if (transition === 'stop-and-reenable')
          await env.manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
      }
      const result = await waiting;
      assert.equal(result.status, 409);
      pending.resolve({ windows: [target] });
      await until(() => !env.manager.status().busy);
      assert.equal(env.calls.length, 1);
      assert.equal(env.factories, 1);
      assert.equal(env.manager.status().lastFrame, null);
    } finally {
      pending.resolve({ windows: [] });
      entered.resolve();
    }
  });
}

test('client cancellation ends the wait without more polls or stopping the desktop lease', async (t) => {
  const entered = gate(t);
  const env = await fixture(t, () => {
    entered.resolve();
    return { windows: [] };
  });
  const controller = new AbortController();
  const waiting = call(
    env.bridge,
    'windows',
    { action: 'wait', title: 'Qobuz', timeoutMs: 1500 },
    controller.signal,
  );
  const rejected = assert.rejects(waiting, /aborted/i);
  await entered.promise;
  controller.abort();
  await rejected;
  await until(() => !env.manager.status().busy);
  await delay(300);
  assert.equal(env.calls.length, 1);
  assert.equal(env.manager.ownerInfo().runId, 'run-1');
});

test('closing the bridge cancels a pending wait without waiting for its full deadline', async (t) => {
  const entered = gate(t);
  const pending = gate(t);
  const env = await fixture(t, () => {
    entered.resolve();
    return pending.promise;
  });
  try {
    const waiting = call(env.bridge, 'windows', { action: 'wait', title: 'Qobuz', timeoutMs: 20000 }).catch(
      (error) => error,
    );
    await entered.promise;
    const started = performance.now();
    await env.bridge.close();
    await waiting;
    assert.ok(performance.now() - started < 1500);
    pending.resolve({ windows: [target] });
    await until(() => !env.manager.status().busy);
    assert.equal(env.calls.length, 1);
  } finally {
    pending.resolve({ windows: [] });
    entered.resolve();
  }
});

test('a timed-out wait cannot send a late native request after deferred driver creation', async (t) => {
  const pending = gate(t);
  const env = await fixture(t, () => undefined, pending.promise);
  try {
    const result = await call(env.bridge, 'windows', { action: 'wait', title: 'Qobuz', timeoutMs: 100 });
    assert.equal(result.status, 200);
    assert.equal(result.body.timedOut, true);
    pending.resolve();
    await delay(50);
    assert.equal(env.factories, 1);
    assert.equal(env.calls.length, 0);
  } finally {
    pending.resolve();
  }
});
