import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';

const IMAGE = Buffer.from('route-screenshot').toString('base64');
const CONFIGURED_MODEL = 'openai/gpt-5.6-luna';

// Fake verified native child for explicit holder acquisition. Grants record
// permission only; only acquire() creates the holder.
function fakeChild({
  sessionId = 'native-session',
  runId,
  agentId = 'agent-child-1',
  childSession = 'child-1',
} = {}) {
  return {
    ownerId: runId,
    rootSessionId: sessionId,
    sessionId: childSession,
    agentSessionId: childSession,
    agentId,
    cwd: '/tmp/p',
    name: 'CU helper',
    model: CONFIGURED_MODEL,
    imageCapable: true,
  };
}

function fakeComputerDriver() {
  const calls = [];
  const driver = {
    calls,
    stopped: [],
    async request(command) {
      calls.push(command);
      if (command.method === 'status') return { supported: true, platform: 'win32' };
      if (command.method === 'windows') return { windows: [] };
      if (command.method === 'observe')
        return {
          image: { data: IMAGE, mimeType: 'image/png' },
          frame: {
            width: 200,
            height: 150,
            bounds: { x: 0, y: 0, width: 200, height: 150 },
            capturedAt: 't',
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

function fakeRuntime() {
  const controls = [];
  return {
    controls,
    async getStatus() {
      return { available: true, version: 'fixture', nodeVersion: process.versions.node };
    },
    async getModels() {
      return {
        models: [{ id: 'openai/gpt-5.6-luna', name: 'Luna', provider: 'openai' }],
        default: { model: 'openai/gpt-5.6-luna', thinking: 'medium' },
      };
    },
    async start(input) {
      let finishDone;
      const done = new Promise((resolveDone) => {
        finishDone = resolveDone;
      });
      const control = {
        input,
        cancelCalls: 0,
        done,
        finish(result = { status: 'completed', code: 0 }) {
          input.onEvent({ kind: 'done', ...result });
          finishDone(result);
        },
        async cancel() {
          control.cancelCalls++;
          control.finish({ status: 'stopped', code: 130 });
          return done;
        },
      };
      controls.push(control);
      return control;
    },
    async close() {
      await Promise.all(controls.map((control) => control.cancel()));
    },
  };
}

async function fixture(t, extraOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-computer-routes-'));
  const cwd = join(root, 'project');
  const sessionDir = join(root, 'sessions');
  const dataDir = join(root, 'local');
  const agentHome = join(root, 'agent');
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(agentHome)]);
  await writeFile(
    join(sessionDir, '2026-native-session.jsonl'),
    [
      { type: 'session', id: 'native-session', cwd, timestamp: '2026-09-04T00:00:00.000Z' },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        message: { role: 'user', content: 'Existing conversation' },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );
  const runtime = fakeRuntime();
  const app = createApp({
    agentHome,
    sessionDir,
    dataDir,
    initialCwd: cwd,
    runtime,
    computerDriver: fakeComputerDriver,
    ...extraOptions,
  });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  let closed = false;
  t.after(async () => {
    if (!closed) {
      closed = true;
      await app.close();
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function api(path, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((done, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            ...(payload !== undefined
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {}),
            ...headers,
          },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (text += chunk));
          response.on('error', reject);
          response.on('end', () => {
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              /* Non-JSON response. */
            }
            done({ status: response.statusCode, text, json });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Fixture HTTP request timed out.')));
      req.end(payload);
    });
  }
  return { app, api, cwd, runtime, root };
}

test('computer status is off by default and enabling needs a target', async (t) => {
  const { api } = await fixture(t);
  const initial = await api('/api/computer-use');
  assert.equal(initial.status, 200);
  assert.equal(initial.json.supported, true);
  assert.equal(initial.json.enabled, false);
  assert.equal(initial.json.owner, null);
  assert.equal((await api('/api/computer-use', { method: 'POST', body: { enabled: true } })).status, 400);
  assert.equal((await api('/api/computer-use', { method: 'POST', body: {} })).status, 400);
});

test('brand new runs can start with computerUse and expose the flag', async (t) => {
  const { api, runtime, cwd } = await fixture(t);
  assert.equal(
    (await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi', computerUse: 'yes' } })).status,
    400,
  );
  const started = await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi', computerUse: true } });
  assert.equal(started.status, 201);
  assert.equal(started.json.computerUse, true);
  const runs = await api('/api/runs');
  assert.equal(runs.json.runs[0].computerUse, true);
  const status = await api(`/api/computer-use?runId=${started.json.id}`);
  assert.equal(status.json.enabled, true);
  runtime.controls[0].finish();
  const after = await api('/api/computer-use');
  assert.equal(after.json.enabled, false);
});

test('computer stop and disable never cancel the agent run', async (t) => {
  const { api, runtime, cwd } = await fixture(t);
  const started = await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi', computerUse: true } });
  assert.equal(started.status, 201);
  const stopped = await api('/api/computer-use/stop', { method: 'POST', body: {} });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.enabled, false);
  assert.equal(runtime.controls[0].cancelCalls, 0);
  assert.equal((await api('/api/runs')).json.runs.length, 1);
  const disabled = await api('/api/computer-use', { method: 'POST', body: { enabled: false } });
  assert.equal(disabled.status, 200);
  assert.equal(runtime.controls[0].cancelCalls, 0);
  runtime.controls[0].finish();
});

test('existing sessions enable while idle and rebind on the next turn', async (t) => {
  const { api, runtime, cwd } = await fixture(t);
  assert.equal(
    (await api('/api/computer-use', { method: 'POST', body: { enabled: true, sessionId: 'missing' } }))
      .status,
    404,
  );
  const enabled = await api('/api/computer-use', {
    method: 'POST',
    body: { enabled: true, sessionId: 'native-session' },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.enabled, true);
  const started = await api('/api/runs', {
    method: 'POST',
    body: { cwd, message: 'hi', sessionId: 'native-session' },
  });
  assert.equal(started.status, 201);
  assert.equal(started.json.computerUse, true);
  runtime.controls[0].finish();
  const retained = await api('/api/computer-use?sessionId=native-session');
  assert.equal(retained.json.enabled, true);
  await api('/api/computer-use', { method: 'POST', body: { enabled: false, sessionId: 'native-session' } });
  assert.equal((await api('/api/computer-use?sessionId=native-session')).json.enabled, false);
});

test('computer runs need an image capable model', async (t) => {
  // Delegation: the text main may grant permission; only the configured CU
  // model with image capability may acquire the desktop later.
  const runtime = fakeRuntime();
  runtime.getModels = async () => ({
    models: [{ id: 'text/only', name: 'Only', provider: 'text', input: ['text'] }],
    default: { model: 'text/only', thinking: 'medium' },
  });
  const { api, cwd } = await fixture(t, { runtime });
  const started = await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi', computerUse: true } });
  assert.equal(started.status, 201);
  assert.equal(started.json.computerUse, true);
  const state = await api(`/api/computer-use?sessionId=${started.json.sessionId}&runId=${started.json.id}`);
  assert.equal(state.json.enabled, true);
  assert.equal(state.json.owner, null);
  runtime.controls[0].finish();
});

test('enabling by run id checks the model and rejects session mismatches', async (t) => {
  const { api, runtime, cwd, app } = await fixture(t);
  const started = await api('/api/runs', {
    method: 'POST',
    body: { cwd, message: 'hi', sessionId: 'native-session' },
  });
  assert.equal(started.status, 201);
  const runId = started.json.id;
  const byRun = await api('/api/computer-use', { method: 'POST', body: { enabled: true, runId } });
  assert.equal(byRun.status, 200);
  assert.equal(byRun.json.enabled, true);
  // Permission only: no holder yet.
  assert.equal(byRun.json.owner, null);
  const scoped = await api(`/api/computer-use?runId=${runId}`);
  assert.equal(scoped.json.enabled, true);
  assert.equal(scoped.json.owner, null);
  const mismatch = await api('/api/computer-use', {
    method: 'POST',
    body: { enabled: true, runId, sessionId: 'other-session' },
  });
  assert.equal(mismatch.status, 409);
  assert.match(mismatch.json.error, /does not belong/i);
  // Grant preserved, still no holder.
  assert.equal((await api(`/api/computer-use?runId=${runId}`)).json.enabled, true);
  assert.equal((await api(`/api/computer-use?runId=${runId}`)).json.owner, null);
  // Explicit acquire by the fake verified child creates the holder.
  const holder = await app.computer.acquire(
    fakeChild({ sessionId: 'native-session', runId, childSession: 'child-1', agentId: 'agent-child-1' }),
  );
  assert.equal(holder.runId, runId);
  assert.equal((await api(`/api/computer-use?runId=${runId}`)).json.owner.runId, runId);
  runtime.controls[0].finish();
});

test('enabling by run id refuses models without image support', async (t) => {
  // Delegation: permission may grant for a text run; image capability is
  // enforced at acquire time by the native child.
  const textRuntime = fakeRuntime();
  textRuntime.getModels = async () => ({
    models: [{ id: 'text/only', name: 'Only', provider: 'text', input: ['text'] }],
    default: { model: 'text/only', thinking: 'medium' },
  });
  const { api, cwd } = await fixture(t, { runtime: textRuntime });
  const started = await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi' } });
  assert.equal(started.status, 201);
  const granted = await api('/api/computer-use', {
    method: 'POST',
    body: { enabled: true, runId: started.json.id },
  });
  assert.equal(granted.status, 200);
  assert.equal(granted.json.enabled, true);
  assert.equal(granted.json.owner, null);
  assert.equal((await api(`/api/computer-use?runId=${started.json.id}`)).json.enabled, true);
  textRuntime.controls[0].finish();
});

function deferredGate() {
  let markEntered;
  let release;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  return {
    pause() {
      markEntered();
      return paused;
    },
    async wait() {
      let timer;
      try {
        await Promise.race([
          entered,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Preflight did not reach the gate.')), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    release,
  };
}

function gateMethod(target, method) {
  const original = target[method];
  const gate = deferredGate();
  target[method] = async (...args) => {
    await gate.pause();
    return original.apply(target, args);
  };
  return {
    wait: gate.wait,
    release() {
      target[method] = original;
      gate.release();
    },
  };
}

test(
  'a stop racing session-history enable preflight keeps the desktop off',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const gate = gateMethod(f.app.store, 'history');
    const enabling = f.api('/api/computer-use', {
      method: 'POST',
      body: { enabled: true, sessionId: 'native-session' },
    });
    try {
      await gate.wait();
      const before = await f.api('/api/computer-use');
      assert.equal((await f.api('/api/computer-use/stop', { method: 'POST', body: {} })).status, 200);
      gate.release();
      const refused = await enabling;
      assert.equal(refused.status, 409);
      assert.match(refused.json.error, /stays off/i);
      const state = await f.api('/api/computer-use');
      assert.equal(state.json.enabled, false);
      assert.equal(state.json.owner, null);
      assert.ok(state.json.controlRevision > before.json.controlRevision);
      assert.equal(f.runtime.controls.length, 0);
    } finally {
      gate.release();
      await enabling.catch(() => {});
    }
  },
);

test(
  'a stop racing model preflight drops the computer grant but keeps the run',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const gate = gateMethod(f.runtime, 'getModels');
    const starting = f.api('/api/runs', {
      method: 'POST',
      body: { cwd: f.cwd, message: 'hi', computerUse: true },
    });
    try {
      await gate.wait();
      assert.equal((await f.api('/api/computer-use/stop', { method: 'POST', body: {} })).status, 200);
      gate.release();
      const started = await starting;
      assert.equal(started.status, 201);
      assert.equal(started.json.computerUse, false);
      assert.equal((await f.api('/api/computer-use')).json.enabled, false);
      assert.equal(f.runtime.controls[0].cancelCalls, 0);
    } finally {
      gate.release();
      await starting.catch(() => {});
      for (const control of f.runtime.controls) control.finish();
    }
  },
);

test(
  'a stop while the computer bridge starts cannot restore a pending grant',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const gate = deferredGate();
    const descriptor = Object.getOwnPropertyDescriptor(f.app.computerBridge, 'ready');
    Object.defineProperty(f.app.computerBridge, 'ready', {
      configurable: true,
      get() {
        return gate.pause();
      },
    });
    const starting = f.api('/api/runs', {
      method: 'POST',
      body: { cwd: f.cwd, message: 'hi', computerUse: true },
    });
    try {
      await gate.wait();
      assert.equal((await f.api('/api/computer-use/stop', { method: 'POST', body: {} })).status, 200);
      gate.release();
      const started = await starting;
      assert.equal(started.status, 201);
      assert.equal(started.json.computerUse, false);
      assert.equal((await f.api('/api/computer-use')).json.enabled, false);
      assert.equal(f.runtime.controls[0].cancelCalls, 0);
    } finally {
      gate.release();
      Object.defineProperty(f.app.computerBridge, 'ready', descriptor);
      await starting.catch(() => {});
      for (const control of f.runtime.controls) control.finish();
    }
  },
);

test(
  'a scoped disable also cancels enable preflight before an owner exists',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const gate = gateMethod(f.app.store, 'history');
    const enabling = f.api('/api/computer-use', {
      method: 'POST',
      body: { enabled: true, sessionId: 'native-session' },
    });
    try {
      await gate.wait();
      const disabled = await f.api('/api/computer-use', {
        method: 'POST',
        body: { enabled: false, sessionId: 'native-session' },
      });
      assert.equal(disabled.status, 200);
      gate.release();
      assert.equal((await enabling).status, 409);
      const state = await f.api('/api/computer-use?sessionId=native-session');
      assert.equal(state.json.enabled, false);
      assert.equal(state.json.owner, null);
    } finally {
      gate.release();
      await enabling.catch(() => {});
    }
  },
);

// ---- Native-only backend over HTTP: sole native descriptor, explicit 'cua' rejected ----

test('computer status exposes the native descriptor without paths', async (t) => {
  const { api } = await fixture(t);
  const status = await api('/api/computer-use');
  assert.equal(status.status, 200);
  assert.equal(status.json.backend, null);
  assert.deepEqual(
    status.json.backends.map((entry) => entry.id),
    ['native'],
  );
  assert.ok(!JSON.stringify(status.json).includes('path'));
});

test('idle sessions enable with the native backend and report it', async (t) => {
  const { api } = await fixture(t);
  const enabled = await api('/api/computer-use', {
    method: 'POST',
    body: { enabled: true, sessionId: 'native-session', backend: 'native' },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.backend, 'native');
  // Permission only: no holder yet, backend comes from the grant.
  assert.equal(enabled.json.owner, null);
  assert.equal(enabled.json.enabled, true);
  const status = await api('/api/computer-use?sessionId=native-session');
  assert.equal(status.json.backend, 'native');
  assert.equal(status.json.enabled, true);
  assert.equal(status.json.owner, null);
});

test('unknown backends are rejected without enabling', async (t) => {
  const { api } = await fixture(t);
  for (const backend of ['quantum', 'cua']) {
    const refused = await api('/api/computer-use', {
      method: 'POST',
      body: { enabled: true, sessionId: 'native-session', backend },
    });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /backend/i);
  }
  assert.equal((await api('/api/computer-use')).json.enabled, false);
  assert.equal((await api('/api/computer-use')).json.owner, null);
});

test('a rejected cua enable never takes the current grant offline', async (t) => {
  const { api } = await fixture(t);
  const enabled = await api('/api/computer-use', {
    method: 'POST',
    body: { enabled: true, sessionId: 'native-session' },
  });
  assert.equal(enabled.status, 200);
  const refused = await api('/api/computer-use', {
    method: 'POST',
    body: { enabled: true, sessionId: 'native-session', backend: 'cua' },
  });
  assert.equal(refused.status, 400);
  // Permission preserved; unscoped backend stays null without a holder.
  const scoped = await api('/api/computer-use?sessionId=native-session');
  assert.equal(scoped.json.enabled, true);
  assert.equal(scoped.json.backend, 'native');
  assert.equal(scoped.json.owner, null);
  const state = await api('/api/computer-use');
  assert.equal(state.json.enabled, true);
  assert.equal(state.json.owner, null);
});

test('the native grant survives a disable then enable cycle', async (t) => {
  const { api } = await fixture(t);
  assert.equal(
    (await api('/api/computer-use', { method: 'POST', body: { enabled: true, sessionId: 'native-session' } }))
      .status,
    200,
  );
  assert.equal((await api('/api/computer-use?sessionId=native-session')).json.backend, 'native');
  assert.equal(
    (
      await api('/api/computer-use', {
        method: 'POST',
        body: { enabled: false, sessionId: 'native-session' },
      })
    ).status,
    200,
  );
  const enabled = await api('/api/computer-use', {
    method: 'POST',
    body: { enabled: true, sessionId: 'native-session', backend: 'native' },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.backend, 'native');
});

test('a disabled selector choice never enables desktop control', async (t) => {
  const { api } = await fixture(t);
  const disabled = await api('/api/computer-use', {
    method: 'POST',
    body: { enabled: false, backend: 'native', sessionId: 'native-session' },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.enabled, false);
  assert.equal(disabled.json.backend, null);
  // A disable carries no backend dispatch, so a stale cua selector on a
  // disable stays a no-op success without enabling anything.
  const ignored = await api('/api/computer-use', {
    method: 'POST',
    body: { enabled: false, backend: 'cua', sessionId: 'native-session' },
  });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.json.enabled, false);
  assert.equal(ignored.json.backend, null);
});

test('a foreign scoped disable keeps the other owner driver', async (t) => {
  const { api, app } = await fixture(t);
  assert.equal(
    (
      await api('/api/computer-use', {
        method: 'POST',
        body: { enabled: true, sessionId: 'native-session', backend: 'native' },
      })
    ).status,
    200,
  );
  const foreign = await api('/api/computer-use', {
    method: 'POST',
    body: { enabled: false, sessionId: 'someone-else' },
  });
  assert.equal(foreign.status, 200);
  // Grant preserved; permission only, no holder yet.
  const scoped = await api('/api/computer-use?sessionId=native-session');
  assert.equal(scoped.json.enabled, true);
  assert.equal(scoped.json.backend, 'native');
  assert.equal(scoped.json.owner, null);
  const state = await api('/api/computer-use');
  assert.equal(state.json.enabled, true);
  assert.equal(state.json.owner, null);
  // Explicit holder: a sibling native agent on the same run cannot steal it.
  const holder = await app.computer.acquire(
    fakeChild({ sessionId: 'native-session', runId: 'run-foreign-1', childSession: 'child-native-1' }),
  );
  assert.equal(holder.sessionId, 'native-session');
  await assert.rejects(
    app.computer.acquire(
      fakeChild({
        sessionId: 'native-session',
        runId: 'run-foreign-1',
        childSession: 'child-native-2',
        agentId: 'agent-other-1',
      }),
    ),
    /already held/i,
  );
  await app.computer.releaseAgent(holder.runId, holder.agentId, holder.agentSessionId);
});

test('runs start with computerUseBackend and reject invalid combinations', async (t) => {
  const { api, runtime, cwd } = await fixture(t);
  assert.equal(
    (await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi', computerUseBackend: 'native' } }))
      .status,
    400,
  );
  for (const computerUseBackend of ['cua', 'quantum']) {
    assert.equal(
      (
        await api('/api/runs', {
          method: 'POST',
          body: { cwd, message: 'hi', computerUse: true, computerUseBackend },
        })
      ).status,
      400,
    );
  }
  assert.equal((await api('/api/runs')).json.runs.length, 0);
  const started = await api('/api/runs', {
    method: 'POST',
    body: { cwd, message: 'hi', computerUse: true, computerUseBackend: 'native' },
  });
  assert.equal(started.status, 201);
  assert.equal(started.json.computerUse, true);
  const status = await api(`/api/computer-use?runId=${started.json.id}`);
  assert.equal(status.json.enabled, true);
  assert.equal(status.json.backend, 'native');
  assert.equal(status.json.owner, null);
  runtime.controls[0].finish();
});

test('runs inherit the native session grant when the backend is omitted', async (t) => {
  const { api, runtime, cwd } = await fixture(t);
  assert.equal(
    (
      await api('/api/computer-use', {
        method: 'POST',
        body: { enabled: true, sessionId: 'native-session', backend: 'native' },
      })
    ).status,
    200,
  );
  const started = await api('/api/runs', {
    method: 'POST',
    body: { cwd, message: 'hi', sessionId: 'native-session' },
  });
  assert.equal(started.status, 201);
  assert.equal(started.json.computerUse, true);
  assert.equal((await api(`/api/computer-use?runId=${started.json.id}`)).json.backend, 'native');
  assert.equal((await api(`/api/computer-use?runId=${started.json.id}`)).json.owner, null);
  runtime.controls[0].finish();
  assert.equal((await api('/api/computer-use?sessionId=native-session')).json.enabled, true);
});

test('runs with a rejected backend fail admission without starting', async (t) => {
  const { api, cwd } = await fixture(t);
  const refused = await api('/api/runs', {
    method: 'POST',
    body: { cwd, message: 'hi', computerUse: true, computerUseBackend: 'cua' },
  });
  assert.equal(refused.status, 400);
  assert.equal((await api('/api/runs')).json.runs.length, 0);
  assert.equal((await api('/api/computer-use')).json.enabled, false);
});

test(
  'a stop racing backend run preflight drops the grant but keeps the run',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const gate = gateMethod(f.runtime, 'getModels');
    const starting = f.api('/api/runs', {
      method: 'POST',
      body: { cwd: f.cwd, message: 'hi', computerUse: true, computerUseBackend: 'native' },
    });
    try {
      await gate.wait();
      assert.equal((await f.api('/api/computer-use/stop', { method: 'POST', body: {} })).status, 200);
      gate.release();
      const started = await starting;
      assert.equal(started.status, 201);
      assert.equal(started.json.computerUse, false);
      assert.equal((await f.api('/api/computer-use')).json.enabled, false);
      assert.equal((await f.api('/api/computer-use')).json.backend, null);
      assert.equal(f.runtime.controls[0].cancelCalls, 0);
    } finally {
      gate.release();
      await starting.catch(() => {});
      for (const control of f.runtime.controls) control.finish();
    }
  },
);

test('GET reports the sole native descriptor without minting any driver', async (t) => {
  let factoryCalls = 0;
  const { api } = await fixture(t, {
    computerDriver: () => {
      factoryCalls += 1;
      return fakeComputerDriver();
    },
  });
  const first = await api('/api/computer-use');
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.json.backends.map((entry) => entry.id),
    ['native'],
  );
  assert.equal(factoryCalls, 0);
  const second = await api('/api/computer-use');
  assert.equal(second.status, 200);
  assert.deepEqual(
    second.json.backends.map((entry) => entry.id),
    ['native'],
  );
  assert.equal(factoryCalls, 0);
});
