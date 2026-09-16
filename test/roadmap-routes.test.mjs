import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-roadmap-http-'));
  const cwd = join(root, 'project'),
    sessionDir = join(root, 'sessions'),
    dataDir = join(root, 'data'),
    agentHome = join(root, 'agent');
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(dataDir), mkdir(agentHome)]);
  const controls = [],
    sends = [];
  const runtime = {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({
      models: [{ id: 'fixture/model', provider: 'fixture' }],
      default: { model: 'fixture/model' },
    }),
    async start(input) {
      let complete;
      const done = new Promise((resolve) => {
        complete = resolve;
      });
      const sessionId = input.sessionId || randomUUID();
      if (!input.sessionId)
        await writeFile(
          join(sessionDir, `${sessionId}.jsonl`),
          `${JSON.stringify({ type: 'session', id: sessionId, cwd: input.cwd, timestamp: new Date().toISOString() })}\n`,
        );
      const control = {
        input,
        sessionId,
        done,
        emitSession: () => input.onEvent({ kind: 'session', sessionId }),
        async cancel() {
          complete({ status: 'stopped' });
        },
      };
      controls.push(control);
      if (!options.delayedSession) control.emitSession();
      return control;
    },
    async close() {
      await Promise.all(controls.map((control) => control.cancel()));
    },
  };
  const liveClient = {
    async send(sessionId, project, input) {
      sends.push({ sessionId, cwd: project, ...input });
      return { accepted: true, snapshot: { followUps: [input.message] } };
    },
  };
  const app = createApp({ cwd, initialCwd: cwd, dataDir, agentHome, sessionDir, runtime, liveClient });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const gateways = [];
  t.after(async () => {
    for (const gateway of gateways) {
      gateway.closeAllConnections();
      await new Promise((done) => gateway.close(done));
    }
    await app.close();
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  async function api(path, body, endpoint = base, cookie) {
    const response = await fetch(`${endpoint}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, json, text, headers: response.headers };
  }
  const get = () => api(`/api/roadmap?cwd=${encodeURIComponent(cwd)}`);
  async function change(action, extra = {}) {
    return api('/api/roadmap', { cwd, expectedRevision: (await get()).json.revision, action, ...extra });
  }
  async function gateway(readOnly) {
    const salt = 'a'.repeat(32),
      code = '12345678';
    const server = createLanGateway({
      host: '127.0.0.1',
      upstreamPort: app.server.address().port,
      config: { salt, codeHash: hashAccessCode(code, salt), readOnly },
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    gateways.push(server);
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${endpoint}/lan/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: endpoint },
      body: `code=${code}`,
      redirect: 'manual',
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return (path, body) => api(path, body, endpoint, cookie);
  }
  return { root, cwd, sessionDir, app, controls, sends, api, get, change, gateway };
}

test('Roadmap HTTP reads and export are inert; two devices get an explicit conflict DTO', async (t) => {
  const f = await fixture(t);
  let response = await f.get();
  assert.equal(response.status, 200);
  assert.equal(response.json.initialized, false);
  assert.equal(typeof response.json.instanceId, 'string');
  assert.deepEqual(response.json.activity, []);
  assert.equal(f.controls.length, 0);
  response = await f.change('init');
  assert.equal(response.json.revision, 1);
  const [pc, phone] = await Promise.all([
    f.api('/api/roadmap', { cwd: f.cwd, action: 'vision', expectedRevision: 1, text: 'PC' }),
    f.api('/api/roadmap', { cwd: f.cwd, action: 'vision', expectedRevision: 1, text: 'Téléphone' }),
  ]);
  assert.deepEqual([pc.status, phone.status].sort(), [200, 409]);
  const conflict = [pc, phone].find((result) => result.status === 409);
  assert.equal(conflict.json.code, 'roadmap_conflict');
  assert.equal(conflict.json.currentRevision, 2);
  const exported = await f.api(`/api/roadmap/export?cwd=${encodeURIComponent(f.cwd)}`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /text\/markdown/);
  assert.match(exported.text, /Révision : 2/);
  assert.equal(f.controls.length, 0);
});

test('work validates the entire selection and revision before starting a run', async (t) => {
  const f = await fixture(t);
  await f.change('init');
  const document = (await f.change('plan.create', { title: 'Plan', steps: [{ text: 'Vérifier' }] })).json;
  const input = {
    cwd: f.cwd,
    expectedRevision: document.revision,
    targets: [{ kind: 'plan', planId: document.plans[0].id }],
    requestId: randomUUID(),
  };
  const stale = await f.api('/api/roadmap/work', { ...input, expectedRevision: 1 });
  assert.equal(stale.status, 409);
  const missing = await f.api('/api/roadmap/work', {
    ...input,
    requestId: randomUUID(),
    targets: [...input.targets, { kind: 'backlog', number: 999 }],
  });
  assert.equal(missing.status, 404);
  assert.equal(f.controls.length, 0);
  assert.equal((await f.get()).json.revision, document.revision);
});

test('work rejects invalid additional instructions before dispatch and leaves the roadmap unchanged', async (t) => {
  const f = await fixture(t);
  await f.change('init');
  const document = (await f.change('plan.create', { title: 'Plan' })).json;
  for (const instructions of [42, {}, null, 'x'.repeat(4001), 'test\0suite']) {
    const result = await f.api('/api/roadmap/work', {
      cwd: f.cwd,
      expectedRevision: document.revision,
      targets: [{ kind: 'plan', planId: document.plans[0].id }],
      requestId: randomUUID(),
      instructions,
    });
    assert.equal(result.status, 400);
    assert.equal(result.json.code, 'roadmap_invalid');
  }
  assert.equal(f.controls.length, 0);
  assert.equal((await f.get()).json.revision, document.revision);
});

test('work is idempotent across concurrent retries and attaches the actual session to every selected task', async (t) => {
  const f = await fixture(t);
  await f.change('init');
  let document = (await f.change('plan.create', { title: 'Livrer', steps: [{ text: 'Contrôle final' }] }))
    .json;
  const planId = document.plans[0].id;
  document = (await f.change('backlog.add', { items: [{ text: 'Vérifier la documentation' }] })).json;
  const input = {
    cwd: f.cwd,
    expectedRevision: document.revision,
    targets: [
      { kind: 'plan', planId },
      { kind: 'backlog', number: 1 },
    ],
    requestId: randomUUID(),
    model: 'fixture/model',
    thinking: 'high',
    instructions: 'Vérifier aussi le mode hors ligne.\nNe pas publier de version.',
  };
  const results = await Promise.all([f.api('/api/roadmap/work', input), f.api('/api/roadmap/work', input)]);
  assert.deepEqual(
    results.map((value) => value.status),
    [201, 201],
  );
  assert.equal(f.controls.length, 1);
  assert.equal(results[0].json.run.id, results[1].json.run.id);
  assert.equal(results[0].json.sessionId, f.controls[0].sessionId);
  assert.equal(f.controls[0].input.model, 'fixture/model');
  assert.equal(f.controls[0].input.thinking, 'high');
  assert.match(f.controls[0].input.message, /roadmap_read/);
  assert.match(f.controls[0].input.message, /Vérifier la documentation/);
  assert.ok(f.controls[0].input.message.includes(input.instructions));
  const changedInstructions = await f.api('/api/roadmap/work', {
    ...input,
    instructions: 'Autres précisions',
  });
  assert.equal(changedInstructions.status, 409);
  assert.equal(changedInstructions.json.code, 'roadmap_request_conflict');
  const invalidRetry = await f.api('/api/roadmap/work', { ...input, instructions: {} });
  assert.equal(invalidRetry.status, 400);
  assert.equal(invalidRetry.json.code, 'roadmap_invalid');
  document = (await f.get()).json;
  assert.deepEqual(document.plans[0].sessions, [f.controls[0].sessionId]);
  assert.deepEqual(document.backlog.items[0].sessions, [f.controls[0].sessionId]);
  const changed = await f.api('/api/roadmap/work', { ...input, thinking: 'low' });
  assert.equal(changed.status, 409);
  assert.equal(changed.json.code, 'roadmap_request_conflict');
  assert.equal(f.controls.length, 1);
});

test('empty instructions remain optional and invalid retries cannot reuse an accepted empty request', async (t) => {
  const f = await fixture(t);
  await f.change('init');
  const document = (await f.change('plan.create', { title: 'Plan sans précisions' })).json;
  const input = {
    cwd: f.cwd,
    expectedRevision: document.revision,
    targets: [{ kind: 'plan', planId: document.plans[0].id }],
    requestId: randomUUID(),
  };
  const accepted = await f.api('/api/roadmap/work', input);
  assert.equal(accepted.status, 201);
  assert.doesNotMatch(f.controls[0].input.message, /Instructions complémentaires/);
  assert.equal((await f.api('/api/roadmap/work', { ...input, instructions: '  \n ' })).status, 201);
  assert.equal((await f.api('/api/roadmap/work', { ...input, instructions: {} })).status, 400);
  assert.equal(f.controls.length, 1);
});

test('a session emitted after startup is linked without relaunching the accepted task', async (t) => {
  const f = await fixture(t, { delayedSession: true });
  await f.change('init');
  const document = (await f.change('plan.create', { title: 'Démarrage différé' })).json;
  const result = await f.api('/api/roadmap/work', {
    cwd: f.cwd,
    expectedRevision: document.revision,
    targets: [{ kind: 'plan', planId: document.plans[0].id }],
    requestId: randomUUID(),
  });
  assert.equal(result.status, 201);
  assert.equal(result.json.sessionId, null);
  f.controls[0].emitSession();
  let value;
  for (let index = 0; index < 50; index++) {
    value = (await f.get()).json;
    if (value.plans[0].sessions.length) break;
    await delay(10);
  }
  assert.deepEqual(value.plans[0].sessions, [f.controls[0].sessionId]);
  assert.equal(f.controls.length, 1);
});

test('failed delayed links stay visible and explicit retries link every task without resending work', async (t) => {
  const f = await fixture(t, { delayedSession: true });
  await f.change('init');
  let document = (await f.change('plan.create', { title: 'Premier travail' })).json;
  document = (await f.change('plan.create', { title: 'Deuxième travail' })).json;
  const original = f.app.roadmap.mutate;
  let failAttach = true,
    attempts = 0;
  f.app.roadmap.mutate = async (...args) => {
    if (args[1].action === 'work.attach') {
      attempts++;
      if (failAttach)
        throw Object.assign(new Error('Temporary write failure'), {
          status: 500,
          code: 'roadmap_write_failed',
        });
    }
    return original(...args);
  };
  const first = await f.api('/api/roadmap/work', {
    cwd: f.cwd,
    expectedRevision: document.revision,
    targets: [{ kind: 'plan', planId: document.plans[0].id }],
    requestId: randomUUID(),
  });
  assert.equal(first.json.accepted, true);
  f.controls[0].emitSession();
  for (let index = 0; index < 50; index++) {
    document = (await f.get()).json;
    if (document.linkWarnings.length) break;
    await delay(10);
  }
  assert.deepEqual(document.linkWarnings, [{ runId: first.json.run.id, sessionId: f.controls[0].sessionId }]);
  const second = await f.api('/api/roadmap/work', {
    cwd: f.cwd,
    expectedRevision: document.revision,
    targets: [{ kind: 'plan', planId: document.plans[1].id }],
    sessionId: f.controls[0].sessionId,
    requestId: randomUUID(),
  });
  assert.equal(second.json.linkWarning, true);
  assert.equal(
    (await f.get()).json.linkWarnings.length,
    2,
    'Two accepted selections on the same run retain both pending links',
  );
  const failedRetry = await f.api('/api/roadmap/retry-links', { cwd: f.cwd });
  assert.equal(failedRetry.status, 200);
  assert.equal(failedRetry.json.linkWarnings.length, 2);
  assert.equal(f.controls.length, 1);
  assert.equal(f.sends.length, 1);
  failAttach = false;
  const beforeRetry = (await f.get()).json.revision;
  const results = await Promise.all([
    f.api('/api/roadmap/retry-links', { cwd: f.cwd }),
    f.api('/api/roadmap/retry-links', { cwd: f.cwd }),
  ]);
  assert.ok(results.every((result) => result.status === 200));
  document = (await f.get()).json;
  assert.deepEqual(document.linkWarnings, []);
  assert.ok(document.plans.every((plan) => plan.sessions.includes(f.controls[0].sessionId)));
  assert.equal(document.revision, beforeRetry + 2);
  const completedAttempts = attempts;
  assert.equal((await f.api('/api/roadmap/retry-links', { cwd: f.cwd })).json.revision, document.revision);
  assert.equal(attempts, completedAttempts);
  assert.equal(f.controls.length, 1);
  assert.equal(f.sends.length, 1);
});

test('work sent to an active session enters the existing follow-up queue exactly once', async (t) => {
  const f = await fixture(t);
  await f.change('init');
  let document = (await f.change('plan.create', { title: 'Travail' })).json;
  const first = await f.api('/api/roadmap/work', {
    cwd: f.cwd,
    expectedRevision: document.revision,
    targets: [{ kind: 'plan', planId: document.plans[0].id }],
    requestId: randomUUID(),
  });
  document = (await f.get()).json;
  const input = {
    cwd: f.cwd,
    expectedRevision: document.revision,
    targets: [{ kind: 'plan', planId: document.plans[0].id }],
    sessionId: first.json.sessionId,
    requestId: randomUUID(),
    instructions: 'Contrôler le téléphone avant de terminer.',
  };
  const results = await Promise.all([f.api('/api/roadmap/work', input), f.api('/api/roadmap/work', input)]);
  assert.ok(results.every((value) => value.status === 201 && value.json.queued));
  assert.equal(f.controls.length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].mode, 'follow_up');
  assert.ok(f.sends[0].message.includes(input.instructions));
});

test('LAN read-only access reads Roadmap and export but cannot initialize, mutate or dispatch work', async (t) => {
  const f = await fixture(t);
  const view = await f.gateway(true);
  const edit = await f.gateway(false);
  const query = `?cwd=${encodeURIComponent(f.cwd)}`;
  assert.equal((await view(`/api/roadmap${query}`)).status, 200);
  assert.equal((await view(`/api/roadmap/export${query}`)).status, 200);
  const input = { cwd: f.cwd, action: 'init', expectedRevision: 0 };
  assert.equal((await view('/api/roadmap', input)).status, 405);
  assert.equal(
    (await view('/api/roadmap/work', { cwd: f.cwd, requestId: randomUUID(), targets: [] })).status,
    405,
  );
  assert.equal((await view('/api/roadmap/retry-links', { cwd: f.cwd })).status, 405);
  assert.equal((await f.get()).json.initialized, false);
  assert.equal((await edit('/api/roadmap', input)).status, 200);
  assert.equal((await view(`/api/roadmap${query}`)).json.revision, 1);
  assert.equal(f.controls.length, 0);
});

test('HTTP mutations cannot forge author or attach an unrelated project conversation', async (t) => {
  const f = await fixture(t);
  await f.change('init');
  const document = (await f.change('plan.create', { title: 'Plan', by: 'agent', sessionId: 'forged' })).json;
  assert.equal(document.lastEdit.by, 'user');
  assert.equal(document.lastEdit.sessionId, undefined);
  const other = join(f.root, 'other');
  await mkdir(other);
  await writeFile(
    join(f.sessionDir, 'other.jsonl'),
    `${JSON.stringify({ type: 'session', id: 'other-session', cwd: other, timestamp: new Date().toISOString() })}\n`,
  );
  assert.equal(
    (await f.change('plan.attach', { planId: document.plans[0].id, sessionId: 'other-session' })).status,
    409,
  );
  assert.equal(
    (await f.change('work.attach', { planIds: [document.plans[0].id], sessionId: 'other-session' })).status,
    400,
  );
  assert.deepEqual((await f.get()).json.plans[0].sessions, []);
  assert.equal(f.controls.length, 0);
});
