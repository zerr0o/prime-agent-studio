import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { request } from 'node:http';
import { createApp } from '../server.mjs';
import { validateConversationSettings } from '../lib/conversation-settings.mjs';
import { validatePublicApiBody } from '../lib/public-api-contract.mjs';

// Mock-only coverage for per-conversation sharedMemories (default false).
// No provider, desktop, or user-memory reads. Real HTTP createApp with an
// isolated dataDir/sessionDir/agentHome and a fake runtime.

function fakeRuntime() {
  const controls = [];
  const runtime = {
    controls,
    async getStatus() {
      return { available: true, version: 'fixture', nodeVersion: process.versions.node };
    },
    async getModels() {
      return {
        models: [
          {
            id: 'openai/gpt-5.6-luna',
            name: 'Luna',
            provider: 'openai',
            thinkingLevels: ['off', 'low', 'high'],
          },
        ],
        default: { model: 'openai/gpt-5.6-luna', thinking: 'medium' },
      };
    },
    async start(input) {
      let finishDone;
      let finished = false;
      const done = new Promise((resolveDone) => {
        finishDone = resolveDone;
      });
      const control = {
        input,
        cancelCalls: 0,
        done,
        emit(event) {
          input.onEvent(event);
        },
        finish(result = { status: 'completed', code: 0 }, emit = true) {
          if (finished) return;
          finished = true;
          if (emit) input.onEvent({ kind: 'done', ...result });
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
      await Promise.all(controls.map((c) => c.cancel().catch(() => {})));
    },
  };
  return runtime;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-shared-mem-'));
  const cwd = join(root, 'project');
  const sessionDir = join(root, 'sessions');
  const dataDir = join(root, 'local');
  const agentHome = join(root, 'agent');
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
    mkdir(agentHome, { recursive: true }),
  ]);
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
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  );
  const runtime = fakeRuntime();
  const app = createApp({ agentHome, sessionDir, dataDir, initialCwd: cwd, runtime });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
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
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            text += c;
          });
          res.on('error', reject);
          res.on('end', () => {
            let json;
            try {
              json = JSON.parse(text);
            } catch {}
            done({ status: res.statusCode, text, json });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }
  async function run(body = {}) {
    return api('/api/runs', { method: 'POST', body: { cwd, message: 'Fixture prompt', ...body } });
  }
  return { root, cwd, sessionDir, dataDir, agentHome, runtime, app, port, api, run };
}

test('conversation settings validate sharedMemories strictly and keep per-conversation scope', () => {
  for (const value of [
    { sharedMemories: 'true' },
    { sharedMemories: 'yes' },
    { sharedMemories: 1 },
    { sharedMemories: 0 },
    { sharedMemories: null },
  ])
    assert.throws(() => validateConversationSettings(value), { status: 400 });
  assert.deepEqual(validateConversationSettings({ sharedMemories: true }), { sharedMemories: true });
  assert.deepEqual(validateConversationSettings({ sharedMemories: false }), { sharedMemories: false });
  // Unknown fields still rejected; no global default is introduced here.
  assert.throws(() => validateConversationSettings({ sharedMemories: true, global: true }), { status: 400 });
});

test('public API contract validates sharedMemories strictly on createRun only', () => {
  const okTrue = validatePublicApiBody('createRun', {
    requestId: 'shared-mem-00000001',
    message: 'Hi',
    sharedMemories: true,
  });
  assert.equal(okTrue.ok, true);
  const okFalse = validatePublicApiBody('createRun', {
    requestId: 'shared-mem-00000002',
    message: 'Hi',
    sharedMemories: false,
  });
  assert.equal(okFalse.ok, true);
  const okMissing = validatePublicApiBody('createRun', { requestId: 'shared-mem-00000003', message: 'Hi' });
  assert.equal(okMissing.ok, true);
  for (const bad of ['yes', 1, 0, null]) {
    const checked = validatePublicApiBody('createRun', {
      requestId: 'shared-mem-00000004',
      message: 'Hi',
      sharedMemories: bad,
    });
    assert.equal(checked.ok, false);
    assert.equal(checked.status, 400);
  }
});

test('fresh runs default to false and runtime.start receives the authoritative flag', async (t) => {
  const f = await fixture(t);
  // Default: missing flag means false, no global default.
  const started = await f.run({});
  assert.equal(started.status, 201, started.text);
  assert.equal(started.json.sharedMemories, false);
  assert.equal(f.runtime.controls[0].input.sharedMemories, false);
  f.runtime.controls[0].finish();

  // Explicit opt-in and opt-out both flow through.
  const optedIn = await f.run({ message: 'opt in', sharedMemories: true });
  assert.equal(optedIn.status, 201, optedIn.text);
  assert.equal(optedIn.json.sharedMemories, true);
  assert.equal(f.runtime.controls[1].input.sharedMemories, true);
  f.runtime.controls[1].finish();

  const optedOut = await f.run({ message: 'opt out', sharedMemories: false });
  assert.equal(optedOut.status, 201, optedOut.text);
  assert.equal(optedOut.json.sharedMemories, false);
  assert.equal(f.runtime.controls[2].input.sharedMemories, false);
  f.runtime.controls[2].finish();

  // Strict booleans on the internal surface.
  for (const bad of ['yes', 1, null]) {
    const refused = await f.run({ message: 'bad', sharedMemories: bad });
    assert.equal(refused.status, 400, JSON.stringify(bad));
  }
  assert.equal(f.runtime.controls.length, 3);
  const listed = await f.api('/api/runs');
  assert.equal(listed.status, 200);
  // Active runs list is empty after finishes; DTO shape already covered above.
});

test('native session binding persists the choice and resume inherits unless overridden', async (t) => {
  const f = await fixture(t);
  const started = await f.run({ sessionId: 'native-session', message: 'first', sharedMemories: true });
  assert.equal(started.status, 201, started.text);
  assert.equal(f.runtime.controls[0].input.sharedMemories, true);
  // Native binding event persists the effective choice on that conversation.
  f.runtime.controls[0].emit({ kind: 'session', sessionId: 'native-session' });
  await new Promise((d) => setTimeout(d, 50));
  const history = await f.api('/api/history?id=native-session');
  assert.equal(history.status, 200, history.text);
  assert.equal(history.json.generationSettings?.sharedMemories, true);
  f.runtime.controls[0].finish();
  await new Promise((d) => setTimeout(d, 50));

  // Resume without an explicit flag inherits the stored true.
  const resumed = await f.run({ sessionId: 'native-session', message: 'second' });
  assert.equal(resumed.status, 201, resumed.text);
  assert.equal(resumed.json.sharedMemories, true);
  assert.equal(f.runtime.controls[1].input.sharedMemories, true);
  f.runtime.controls[1].finish();
  await new Promise((d) => setTimeout(d, 50));

  // Explicit override wins and is then stored.
  const overridden = await f.run({ sessionId: 'native-session', message: 'third', sharedMemories: false });
  assert.equal(overridden.status, 201, overridden.text);
  assert.equal(f.runtime.controls[2].input.sharedMemories, false);
  f.runtime.controls[2].emit({ kind: 'session', sessionId: 'native-session' });
  await new Promise((d) => setTimeout(d, 50));
  const after = await f.api('/api/history?id=native-session');
  assert.equal(after.json.generationSettings?.sharedMemories, false);
  f.runtime.controls[2].finish();
});

test('sharedMemories policy changes 409 while running or stopping like model and allowQuestions', async (t) => {
  const f = await fixture(t);
  const started = await f.run({ sessionId: 'native-session', message: 'live' });
  assert.equal(started.status, 201, started.text);
  // Mid-turn change must not create ambiguity: 409 while the conversation runs.
  const refused = await f.api('/api/conversation-settings', {
    method: 'PATCH',
    body: { id: 'native-session', cwd: f.cwd, settings: { sharedMemories: true } },
  });
  assert.equal(refused.status, 409, refused.text);
  // Same for the existing guarded fields while the run is active.
  const refusedModel = await f.api('/api/conversation-settings', {
    method: 'PATCH',
    body: { id: 'native-session', cwd: f.cwd, settings: { model: 'openai/gpt-5.6-luna' } },
  });
  assert.equal(refusedModel.status, 409);
  f.runtime.controls[0].finish();
  await new Promise((d) => setTimeout(d, 50));
  const ok = await f.api('/api/conversation-settings', {
    method: 'PATCH',
    body: { id: 'native-session', cwd: f.cwd, settings: { sharedMemories: true } },
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.settings?.sharedMemories, true);
});

test('legacy conversations without the flag read as false', async (t) => {
  const f = await fixture(t);
  const history = await f.api('/api/history?id=native-session');
  assert.equal(history.status, 200, history.text);
  // No stored flag yet: readers treat missing as false.
  assert.equal(history.json.generationSettings?.sharedMemories ?? false, false);
  const started = await f.run({ sessionId: 'native-session', message: 'legacy resume' });
  assert.equal(started.status, 201, started.text);
  assert.equal(started.json.sharedMemories, false);
  assert.equal(f.runtime.controls[0].input.sharedMemories, false);
  f.runtime.controls[0].finish();
});

test('public API createRun accepts sharedMemories with existing scopes and reflects it', async (t) => {
  const f = await fixture(t);
  const initial = await f.api('/api/public-api');
  assert.equal(initial.status, 200);
  const enabled = await f.api('/api/public-api', {
    method: 'PATCH',
    body: { enabled: true, revision: initial.json.revision },
  });
  assert.equal(enabled.status, 200);
  const created = await f.api('/api/public-api/tokens', {
    method: 'POST',
    body: {
      name: 'shared-mem',
      scopes: ['read', 'runs:write'],
      projectIds: ['*'],
      revision: enabled.json.revision,
    },
  });
  assert.equal(created.status, 201, created.text);
  const auth = { Authorization: `Bearer ${created.json.credential}` };
  const projectId = enabled.json.projects.find((p) => p.cwd === f.cwd).id;
  const bad = await f.api(`/api/v1/projects/${projectId}/runs`, {
    method: 'POST',
    headers: auth,
    body: { requestId: 'shared-mem-pub-00001', message: 'Hi', sharedMemories: 'yes' },
  });
  assert.equal(bad.status, 400, bad.text);
  const started = await f.api(`/api/v1/projects/${projectId}/runs`, {
    method: 'POST',
    headers: auth,
    body: { requestId: 'shared-mem-pub-00002', message: 'Public opt-in', sharedMemories: true },
  });
  assert.equal(started.status, 201, started.text);
  assert.equal(started.json.sharedMemories, true);
  assert.equal(f.runtime.controls[0].input.sharedMemories, true);
  // Default over the public boundary is also false.
  const plain = await f.api(`/api/v1/projects/${projectId}/runs`, {
    method: 'POST',
    headers: auth,
    body: { requestId: 'shared-mem-pub-00003', message: 'Public default' },
  });
  assert.equal(plain.status, 201, plain.text);
  assert.equal(plain.json.sharedMemories, false);
  assert.equal(f.runtime.controls[1].input.sharedMemories, false);
  // Run DTO over GET reflects the same flag with no new scope.
  const fetched = await f.api(`/api/v1/runs/${started.json.id}`, { headers: auth });
  assert.equal(fetched.status, 200, fetched.text);
  assert.equal(fetched.json.sharedMemories, true);
  f.runtime.controls[0].finish();
  f.runtime.controls[1].finish();
});

test('explicit resume override persists without a native session event', async (t) => {
  const f = await fixture(t);
  // Seed true via settings, then resume with explicit false but emit no
  // session event (native reuse without session_start/init).
  const seeded = await f.api('/api/conversation-settings', {
    method: 'PATCH',
    body: { id: 'native-session', cwd: f.cwd, settings: { sharedMemories: true } },
  });
  assert.equal(seeded.status, 200, seeded.text);
  const started = await f.run({
    sessionId: 'native-session',
    message: 'explicit off, no event',
    sharedMemories: false,
  });
  assert.equal(started.status, 201, started.text);
  assert.equal(started.json.sharedMemories, false);
  assert.equal(f.runtime.controls[0].input.sharedMemories, false);
  // No session event emitted on purpose. The explicit choice must still be
  // authoritative for the next resume.
  f.runtime.controls[0].finish();
  await new Promise((d) => setTimeout(d, 50));
  const after = await f.api('/api/history?id=native-session');
  assert.equal(after.status, 200, after.text);
  assert.equal(after.json.generationSettings?.sharedMemories, false);
  const resumed = await f.run({ sessionId: 'native-session', message: 'next resume' });
  assert.equal(resumed.status, 201, resumed.text);
  assert.equal(resumed.json.sharedMemories, false);
  assert.equal(f.runtime.controls[1].input.sharedMemories, false);
  f.runtime.controls[1].finish();
});

test('slow binding cannot silently revert a later opt-out (serialized settings)', async (t) => {
  const f = await fixture(t);
  const store = f.app.store;
  assert.equal(typeof store.flushConversationSettings, 'function');
  // Queue a failing missing-id write first: the global queue must recover
  // and preserve call order (fail, true, false). No flood needed; history
  // plus atomic save are already asynchronous.
  const order = [];
  const pFail = store.setConversationSettings('missing-slow-binding', { sharedMemories: true }).then(
    () => order.push('fail-ok'),
    (error) => {
      order.push('fail-err');
      assert.equal(error.status, 404);
    },
  );
  const pTrue = store
    .setConversationSettings('native-session', { sharedMemories: true })
    .then(() => order.push('true'));
  const pFalse = store
    .setConversationSettings('native-session', { sharedMemories: false })
    .then(() => order.push('false'));
  await Promise.allSettled([pFail, pTrue, pFalse]);
  await store.flushConversationSettings();
  assert.deepEqual(order, ['fail-err', 'true', 'false']);
  const history = await f.api('/api/history?id=native-session');
  assert.equal(history.status, 200, history.text);
  assert.equal(history.json.generationSettings?.sharedMemories, false);
  const resumed = await f.run({ sessionId: 'native-session', message: 'after race' });
  assert.equal(resumed.status, 201, resumed.text);
  assert.equal(resumed.json.sharedMemories, false);
  f.runtime.controls[0].finish();
});

test('flush waits for in-flight binding writes', async (t) => {
  const f = await fixture(t);
  const store = f.app.store;
  let settled = false;
  const write = store.setConversationSettings('native-session', { sharedMemories: true }).then((value) => {
    settled = true;
    return value;
  });
  await store.flushConversationSettings();
  // A no-op flush would leave the real write still pending; the real flush
  // waits, with no wallclock bound and no extra I/O here.
  assert.equal(settled, true);
  await write;
  const history = await f.api('/api/history?id=native-session');
  assert.equal(history.json.generationSettings?.sharedMemories, true);
});
