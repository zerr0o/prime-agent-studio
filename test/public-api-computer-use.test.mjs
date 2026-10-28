import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createComputerUseManager } from '../lib/computer-use.mjs';

// Real HTTP and lease manager, isolated storage, fake runtime and drivers only.
const ENDPOINT = '/api/v1/computer-use';
const SCOPES = ['read', 'runs:write', 'computer:write'];
const BACKENDS = ['native'].map((id) => ({ id, supported: true, available: true }));
const CONFIGURED_MODEL = 'openai/gpt-5.6-luna';

// Fake verified native child: permission-only grants never create a holder,
// only an explicit acquire does.
function fakeChild({
  sessionId = 'session-a',
  runId = 'fixture-run',
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

async function fixture(t, { supported = true, textOnly = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-public-computer-'));
  const cwd = join(root, 'project');
  const foreignCwd = join(root, 'foreign');
  const sessionDir = join(root, 'sessions');
  const agentHome = join(root, 'agent');
  await Promise.all([cwd, foreignCwd, sessionDir, agentHome].map((p) => mkdir(p)));
  for (const [id, project] of [
    ['session-a', cwd],
    ['session-b', cwd],
    ['foreign-session', foreignCwd],
  ]) {
    await writeFile(
      join(sessionDir, `${id}.jsonl`),
      [
        { type: 'session', id, cwd: project, timestamp: '2026-09-04T00:00:00.000Z' },
        { type: 'message', id: `${id}-m`, message: { role: 'user', content: 'Fixture' } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );
  }
  const effects = [];
  const computer = createComputerUseManager({
    isSupported: supported,
    backends: BACKENDS.map((b) => ({
      ...b,
      supported,
      available: supported,
      reason: 'PRIVATE backend path',
    })),
    createDriver() {
      effects.push('start');
      return {
        async request(command) {
          effects.push(command);
          throw new Error('No desktop calls expected');
        },
        async stop() {
          effects.push('stop');
        },
        async close() {
          effects.push('close');
        },
      };
    },
  });
  const runtime = fakeRuntime();
  if (textOnly)
    runtime.getModels = async () => ({
      models: [{ id: 'text/only', input: ['text'] }],
      default: { model: 'text/only' },
    });
  const app = createApp({
    agentHome,
    sessionDir,
    dataDir: join(root, 'data'),
    initialCwd: cwd,
    runtime,
    computer,
  });
  t.after(async () => {
    try {
      await app.close();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, { method = 'GET', body, credential } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, json: await response.json() };
  }
  const enabled = await api('/api/public-api', { method: 'PATCH', body: { enabled: true, revision: 0 } });
  assert.equal(enabled.status, 200);
  async function token(scopes = SCOPES, projectIds = ['*']) {
    const state = await api('/api/public-api');
    const result = await api('/api/public-api/tokens', {
      method: 'POST',
      body: {
        name: 'computer fixture',
        scopes,
        projectIds,
        revision: state.json.revision,
      },
    });
    assert.equal(result.status, 201, JSON.stringify(result.json));
    return result.json;
  }
  const auth = await token();
  const credential = auth.credential;
  const get = (query = '', key = credential) => api(ENDPOINT + query, { credential: key });
  const set = (body, key = credential) => api(ENDPOINT, { method: 'POST', body, credential: key });
  async function start(sessionId) {
    const result = await api('/api/runs', {
      method: 'POST',
      body: { cwd, message: 'Fixture run', ...(sessionId ? { sessionId } : {}) },
    });
    assert.equal(result.status, 201, JSON.stringify(result.json));
    return result.json;
  }
  return {
    app,
    api,
    get,
    set,
    token,
    auth,
    start,
    computer,
    effects,
    runtime,
    cwd,
    foreignCwd,
    projects: enabled.json.projects,
    machineId: enabled.json.machineId,
  };
}

const DTO_KEYS = [
  'machineId',
  'revision',
  'supported',
  'enabled',
  'busy',
  'backend',
  'backends',
  'owner',
  'ownerHidden',
  'cleanupPending',
  'cleanupFailed',
  'hotkey',
  'hotkeyAvailable',
  'target',
].sort();
function cleanDto(dto) {
  assert.deepEqual(Object.keys(dto).sort(), DTO_KEYS);
  assert.ok(Number.isSafeInteger(dto.revision) && dto.revision >= 0);
  for (const key of [
    'supported',
    'enabled',
    'busy',
    'ownerHidden',
    'cleanupPending',
    'cleanupFailed',
    'hotkeyAvailable',
  ])
    assert.equal(typeof dto[key], 'boolean', key);
  for (const backend of dto.backends)
    assert.deepEqual(Object.keys(backend).sort(), ['available', 'id', 'supported']);
  for (const target of [dto.owner, dto.target].filter(Boolean)) {
    assert.ok(target.projectId);
    assert.ok(Object.keys(target).every((key) => ['sessionId', 'runId', 'projectId'].includes(key)));
  }
  assert.doesNotMatch(JSON.stringify(dto), /PRIVATE|lastAction|lastFrame|hotkeyError/);
}

test('computer API read DTO is safe, strict, passive and works unsupported', async (t) => {
  for (const supported of [true, false]) {
    const f = await fixture(t, { supported });
    const result = await f.get();
    assert.equal(result.status, 200);
    cleanDto(result.json);
    assert.equal(result.json.machineId, f.machineId);
    assert.equal(result.json.supported, supported);
    assert.equal(result.json.enabled, false);
    assert.equal(result.json.target, null);
    assert.equal(result.json.owner, null);
    for (const query of [
      '?sessionId=',
      '?runId=',
      '?sessionId=session-a&runId=x',
      '?sessionId=session-a&sessionId=session-a',
      '?unknown=x',
      '?sessionId=%2Fbad',
    ])
      assert.equal((await f.get(query)).status, 400, query);
    assert.equal((await f.get('?sessionId=missing')).status, 404);
    assert.equal((await f.get('?runId=missing')).status, 404);
    if (!supported)
      assert.equal(
        (await f.set({ enabled: true, expectedRevision: result.json.revision, sessionId: 'session-a' }))
          .status,
        409,
      );
    assert.deepEqual(f.effects, []);
    assert.equal(f.runtime.controls.length, 0);
  }
});

test('computer authorization, exact body validation and stale CAS have no effects', async (t) => {
  const f = await fixture(t);
  const revision = (await f.get()).json.revision;
  const valid = { enabled: true, expectedRevision: revision, sessionId: 'session-a' };
  for (const scopes of [['read'], ['read', 'runs:write']]) {
    const key = (await f.token(scopes)).credential;
    assert.equal((await f.set(valid, key)).status, 403);
  }
  for (const body of [
    {},
    { enabled: true, expectedRevision: revision },
    { ...valid, enabled: 'true' },
    { ...valid, expectedRevision: -1 },
    { ...valid, expectedRevision: 0.1 },
    { ...valid, expectedRevision: '0' },
    { ...valid, runId: 'run' },
    { ...valid, sessionId: '' },
    { enabled: true, sessionId: 'session-a' },
    ...['backend', 'cwd', 'model', 'takeover'].map((key) => ({ ...valid, [key]: 'PRIVATE' })),
  ])
    assert.equal((await f.set(body)).status, 400, JSON.stringify(body));
  const stale = await f.set({ ...valid, expectedRevision: revision + 999 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.currentRevision, revision);
  assert.equal((await f.get()).json.revision, revision);
  assert.deepEqual(f.effects, []);
});

test('session and unbound run grants revoke without native work or stopping runs', async (t) => {
  const f = await fixture(t);
  for (const target of [{ sessionId: 'session-a' }, { runId: (await f.start()).id }]) {
    const before = await f.get();
    const granted = await f.set({ enabled: true, expectedRevision: before.json.revision, ...target });
    assert.equal(granted.status, 200, JSON.stringify(granted.json));
    cleanDto(granted.json);
    assert.equal(granted.json.enabled, true);
    // Permission only: grants never create a holder.
    assert.equal(granted.json.owner, null);
    assert.ok(granted.json.revision > before.json.revision);
    const revoked = await f.set({ enabled: false, expectedRevision: granted.json.revision, ...target });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.json.enabled, false);
    assert.ok(revoked.json.revision > granted.json.revision);
  }
  assert.equal(f.runtime.controls.length, 1);
  assert.equal(f.runtime.controls[0].cancelCalls, 0);
  assert.deepEqual(f.effects, []);
});

test('same-project controllers cannot take over or disable each other', async (t) => {
  const f = await fixture(t);
  const run = await f.start('session-a');
  const granted = await f.set({
    enabled: true,
    expectedRevision: (await f.get()).json.revision,
    sessionId: 'session-a',
  });
  assert.equal(granted.status, 200);
  // Permission only: no holder yet.
  assert.equal(granted.json.owner, null);
  // Two sessions may grant concurrently.
  const other = await f.set({
    enabled: true,
    expectedRevision: granted.json.revision,
    sessionId: 'session-b',
  });
  assert.equal(other.status, 200);
  assert.equal(other.json.owner, null);
  // Only one native holder: explicit acquire wins, sibling is busy.
  const holder = await f.computer.acquire(
    fakeChild({ sessionId: 'session-a', runId: run.id, childSession: 'child-a-1', agentId: 'agent-a-1' }),
  );
  assert.equal(holder.runId, run.id);
  await assert.rejects(
    f.computer.acquire(
      fakeChild({
        sessionId: 'session-b',
        runId: 'other-run',
        childSession: 'child-b-1',
        agentId: 'agent-b-1',
      }),
    ),
    /already held/i,
  );
  await f.computer.releaseAgent(holder.runId, holder.agentId, holder.agentSessionId);
  const revoked = await f.set({
    enabled: false,
    expectedRevision: (await f.get()).json.revision,
    runId: run.id,
  });
  assert.equal(revoked.status, 200);
  assert.equal(f.runtime.controls[0].cancelCalls, 0);
  assert.deepEqual(f.effects, []);
});

test('foreign owner and stale frame/action metadata are redacted across handoff and release', async (t) => {
  const f = await fixture(t);
  const projectId = f.projects.find((p) => p.cwd === f.cwd).id;
  const key = (await f.token(['read', 'computer:write'], [projectId])).credential;
  await f.computer.enable({ sessionId: 'foreign-session', cwd: f.foreignCwd, name: 'PRIVATE name' });
  await f.computer.acquire({
    ownerId: 'foreign-run',
    rootSessionId: 'foreign-session',
    sessionId: 'foreign-child-1',
    agentSessionId: 'foreign-child-1',
    agentId: 'foreign-agent-1',
    cwd: f.foreignCwd,
    name: 'PRIVATE name',
    model: CONFIGURED_MODEL,
    imageCapable: true,
  });
  f.computer.setFrame({ width: 100, height: 100, title: 'PRIVATE frame' });
  f.computer.recordAction({ text: 'PRIVATE action' });
  f.computer.setError('PRIVATE error');
  f.computer.setHotkeyState({ registered: false, error: 'PRIVATE hotkey' });
  const global = await f.get('', key);
  assert.equal(global.status, 200);
  cleanDto(global.json);
  assert.equal(global.json.owner, null);
  assert.equal(global.json.ownerHidden, true);
  assert.equal(global.json.hotkeyAvailable, false);
  assert.equal((await f.get('?sessionId=foreign-session', key)).status, 404);
  for (const enabled of [true, false]) {
    assert.equal(
      (
        await f.set(
          { enabled, expectedRevision: (await f.get('', key)).json.revision, sessionId: 'foreign-session' },
          key,
        )
      ).status,
      404,
    );
    // Concurrent grants allowed: session-a may grant/revoke while foreign holds.
    assert.equal(
      (
        await f.set(
          { enabled, expectedRevision: (await f.get('', key)).json.revision, sessionId: 'session-a' },
          key,
        )
      ).status,
      200,
    );
  }
  // Re-grant session-a for handoff (loop ends revoked).
  assert.equal(
    (
      await f.set(
        { enabled: true, expectedRevision: (await f.get('', key)).json.revision, sessionId: 'session-a' },
        key,
      )
    ).status,
    200,
  );
  // Handoff via explicit acquire, not permission alone.
  await f.computer.releaseAgent('foreign-run', 'foreign-agent-1', 'foreign-child-1');
  await f.computer.enable({ sessionId: 'session-a', runId: 'fixture-run', cwd: f.cwd });
  await f.computer.acquire(
    fakeChild({
      sessionId: 'session-a',
      runId: 'fixture-run',
      childSession: 'child-handoff-1',
      agentId: 'agent-handoff-1',
    }),
  );
  cleanDto((await f.get('', key)).json);
  await f.computer.releaseRun('fixture-run');
  const released = await f.get('?sessionId=session-a', key);
  cleanDto(released.json);
  assert.equal(released.json.owner, null);
  assert.equal(released.json.ownerHidden, false);
  assert.deepEqual(f.effects, []);
});

test('active text-only runs may grant Computer Use permission (acquire still needs an image-capable child)', async (t) => {
  // Delegation: the text main may grant permission; image capability is
  // enforced at acquire time by the native child.
  const f = await fixture(t, { textOnly: true });
  const run = await f.start();
  const result = await f.set({
    enabled: true,
    expectedRevision: (await f.get()).json.revision,
    runId: run.id,
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.enabled, true);
  assert.equal(result.json.owner, null);
  assert.equal((await f.get()).json.enabled, true);
  assert.equal((await f.get()).json.owner, null);
  assert.equal(f.runtime.controls[0].cancelCalls, 0);
  assert.deepEqual(f.effects, []);
});

for (const method of ['preferences', 'session']) {
  for (const change of ['stop', 'foreign-owner', 'revoke-token']) {
    test(`delayed ${method} lookup rechecks ${change} before granting`, { timeout: 10000 }, async (t) => {
      const f = await fixture(t);
      if (method === 'preferences') await f.start('session-a');
      const revision = (await f.get()).json.revision;
      // Gate the actual awaited work: studio preferences vs session lookup.
      // Hold it through the concurrent change so the grant cannot slip through.
      const gate = gateMethod(f.app.store, method === 'preferences' ? 'getStudioPreferences' : 'history');
      const enabling = f.set({ enabled: true, expectedRevision: revision, sessionId: 'session-a' });
      // Revocation may close an already authenticated request: that is an unknown outcome, not success.
      enabling.catch(() => {});
      try {
        await gate.wait();
        if (change === 'stop') await f.computer.stop('fixture');
        if (change === 'foreign-owner') await f.computer.enable({ sessionId: 'session-b', cwd: f.cwd });
        if (change === 'revoke-token') {
          const state = await f.api('/api/public-api');
          assert.equal(
            (
              await f.api(`/api/public-api/tokens/${f.auth.token.id}`, {
                method: 'DELETE',
                body: { revision: state.json.revision },
              })
            ).status,
            200,
          );
        }
        gate.release();
        const refused = await enabling.catch((error) => {
          if (change !== 'revoke-token' || error.cause?.code !== 'UND_ERR_SOCKET') throw error;
          return null;
        });
        if (refused)
          assert.equal(refused.status, change === 'revoke-token' ? 401 : 409, JSON.stringify(refused.json));
        if (change === 'revoke-token') {
          const freshKey = (await f.token(['read'])).credential;
          assert.equal((await f.get('', freshKey)).json.enabled, false);
        }
        // Permission only: concurrent grants never create a holder.
        assert.equal(f.computer.status().owner, null);
        assert.deepEqual(f.effects, []);
        assert.equal(f.runtime.controls.length, method === 'preferences' ? 1 : 0);
        for (const control of f.runtime.controls) assert.equal(control.cancelCalls, 0);
      } finally {
        gate.release();
        await enabling.catch(() => {});
      }
    });
  }
}

test('explicit cua is rejected while native grants stay passive', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.api('/api/studio-preferences', {
        method: 'PATCH',
        body: { computerBackend: 'cua' },
      })
    ).status,
    400,
  );
  assert.equal((await f.get()).json.backend, null);
  const granted = await f.set({
    enabled: true,
    expectedRevision: (await f.get()).json.revision,
    sessionId: 'session-a',
  });
  assert.equal(granted.status, 200);
  assert.equal(granted.json.backend, 'native');
  assert.deepEqual(
    granted.json.backends.map((entry) => entry.id),
    ['native'],
  );
  cleanDto(granted.json);
  assert.deepEqual(f.effects, []);
});

test('cleanup uncertainty blocks grants and reports safe lifecycle booleans', async (t) => {
  const f = await fixture(t);
  await f.computer.enable({ sessionId: 'session-a', cwd: f.cwd });
  await f.computer.acquire(
    fakeChild({ sessionId: 'session-a', runId: 'cleanup-run', childSession: 'child-cleanup-1' }),
  );
  const driver = await f.computer.driver(); // Injected fake only: simulate an unconfirmed worker close.
  driver.close = async () => {
    throw new Error('PRIVATE cleanup failure');
  };
  await f.computer.stop('fixture');
  const before = await f.get();
  cleanDto(before.json);
  assert.equal(before.json.cleanupFailed, true);
  const effectsBefore = f.effects.length;
  const refused = await f.set({
    enabled: true,
    expectedRevision: before.json.revision,
    sessionId: 'session-a',
  });
  assert.equal(refused.status, 409);
  assert.doesNotMatch(JSON.stringify(refused.json), /PRIVATE/);
  assert.equal(f.computer.status().enabled, false);
  assert.equal(f.effects.length, effectsBefore);
  driver.close = async () => {};
});

test('busy is global even for an unrelated authorized target', async (t) => {
  const f = await fixture(t);
  await f.computer.enable({ sessionId: 'session-b', cwd: f.cwd });
  const gate = deferredGate();
  const busy = f.computer.track(gate.pause());
  try {
    const state = await f.get('?sessionId=session-a');
    cleanDto(state.json);
    assert.equal(state.json.enabled, false);
    assert.equal(state.json.busy, true);
    assert.equal(state.json.target.sessionId, 'session-a');
    // Permission only: no holder, busy is global inflight.
    assert.equal(state.json.owner, null);
  } finally {
    gate.release();
    await busy;
  }
  assert.equal((await f.get()).json.busy, false);
  assert.deepEqual(f.effects, []);
});

test('runs:write alone cannot inherit a session Computer Use grant; explicit scope can', async (t) => {
  const f = await fixture(t);
  const projectId = f.projects.find((p) => p.cwd === f.cwd).id;
  const oldKey = (await f.token(['read', 'runs:write'])).credential;
  const granted = await f.set({
    enabled: true,
    expectedRevision: (await f.get()).json.revision,
    sessionId: 'session-a',
  });
  assert.equal(granted.status, 200);
  const body = { requestId: 'computer-resume-old-0001', sessionId: 'session-a', message: 'Resume' };
  const denied = await f.api(`/api/v1/projects/${projectId}/runs`, {
    method: 'POST',
    credential: oldKey,
    body,
  });
  assert.equal(denied.status, 403);
  assert.equal(f.runtime.controls.length, 0);
  assert.equal((await f.get()).json.revision, granted.json.revision);
  const allowed = await f.api(`/api/v1/projects/${projectId}/runs`, {
    method: 'POST',
    credential: f.auth.credential,
    body: { ...body, requestId: 'computer-resume-full-0001' },
  });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.json));
  assert.equal(f.runtime.controls.length, 1);
  // Permission granted for the resumed run; no holder yet, no worker.
  assert.equal(f.computer.status({ runId: allowed.json.id, sessionId: 'session-a' }).enabled, true);
  assert.equal(f.computer.status().owner, null);
  assert.deepEqual(f.effects, []);
});

test('idempotent lease grants preserve revision and do not invalidate frames', async (t) => {
  const f = await fixture(t);
  const granted = await f.set({
    enabled: true,
    expectedRevision: (await f.get()).json.revision,
    sessionId: 'session-a',
  });
  assert.equal(granted.status, 200);
  const frame = f.computer.setFrame({ width: 100, height: 100 });
  const repeated = await f.set({
    enabled: true,
    expectedRevision: granted.json.revision,
    sessionId: 'session-a',
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.json.revision, granted.json.revision);
  assert.ok(f.computer.takeFrame(frame));
  assert.deepEqual(f.effects, []);
});

test('finished runs remain readable but cannot acquire a lease', async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  const granted = await f.set({
    enabled: true,
    expectedRevision: (await f.get()).json.revision,
    runId: run.id,
  });
  assert.equal(granted.status, 200);
  f.runtime.controls[0].finish();
  const finished = await f.get(`?runId=${run.id}`);
  assert.equal(finished.status, 200);
  cleanDto(finished.json);
  assert.equal(finished.json.enabled, false);
  assert.equal(finished.json.target.runId, run.id);
  const refused = await f.set({ enabled: true, expectedRevision: finished.json.revision, runId: run.id });
  assert.equal(refused.status, 409);
  assert.deepEqual(f.effects, []);
});

test('session target is re-resolved after the final authentication await', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const before = await f.get('?sessionId=session-a');
  const access = f.app.publicApiAccess;
  const authenticate = access.authenticate;
  const gate = deferredGate();
  let checks = 0;
  access.authenticate = async function (req) {
    const principal = await authenticate.call(this, req);
    if (req.method === 'POST' && req.url === ENDPOINT) {
      checks++;
      // handle admission, common authorize, then the two authorizeTarget checks.
      // Pause the LAST await: the session is still idle and its lease epoch is unchanged.
      if (checks === 4) await gate.pause();
    }
    return principal;
  };
  const enabling = f.set({ enabled: true, expectedRevision: before.json.revision, sessionId: 'session-a' });
  enabling.catch(() => {});
  try {
    await gate.wait();
    assert.equal(checks, 4);
    const run = await f.start('session-a');
    assert.equal(
      f.computer.revision,
      before.json.revision,
      'starting an unauthorized run cannot change the lease',
    );
    gate.release();
    const refused = await enabling;
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    const after = await f.get('?sessionId=session-a');
    assert.equal(after.json.enabled, false);
    assert.equal(after.json.owner, null);
    assert.equal(after.json.revision, before.json.revision);
    const running = await f.api(`/api/v1/runs/${run.id}`, { credential: f.auth.credential });
    assert.equal(running.status, 200);
    assert.equal(running.json.status, 'running');
    assert.equal(f.runtime.controls[0].cancelCalls, 0);
    assert.deepEqual(f.effects, []);
  } finally {
    gate.release();
    access.authenticate = authenticate;
    await enabling.catch(() => {});
  }
});
