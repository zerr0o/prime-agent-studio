import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';

// Independent integration tests for the generic versioned API in
// lib/public-api.mjs plus its local administration surface. Real HTTP
// createApp instances with isolated dataDir/sessionDir/agentHome and a fake
// runtime (no engine, no external calls). This file owns these checks; it
// never changes implementation. Failures go to the project root with an exact
// reproducer. Generic terminology only.

const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
async function until(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(15);
  }
  assert.fail('Timed out waiting for the expected server state.');
}

function fakeRuntime() {
  const controls = [];
  let releaseStartup = null;
  const runtime = {
    controls,
    deferNext: false,
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
        async respond(id, response) {
          return { answered: true, id };
        },
      };
      controls.push(control);
      if (runtime.deferNext) {
        runtime.deferNext = false;
        await new Promise((resolveDeferred) => {
          releaseStartup = resolveDeferred;
        });
      }
      return control;
    },
    releaseStartup() {
      releaseStartup?.();
      releaseStartup = null;
    },
    async close() {
      runtime.releaseStartup();
      await Promise.all(controls.map((control) => control.cancel().catch(() => {})));
    },
  };
  return runtime;
}

function liveStub() {
  const sends = [];
  return {
    sends,
    async send(sessionId, cwd, data) {
      sends.push({ sessionId, cwd, ...data });
      return { accepted: true };
    },
    async getSnapshot() {
      return { available: false, steering: [], followUps: [] };
    },
  };
}

const sessionFile = (id, cwd, texts) =>
  [
    { type: 'session', id, cwd, timestamp: '2026-09-04T00:00:00.000Z' },
    ...texts.map((content, index) => ({
      type: 'message',
      id: `${id}-message-${index + 1}`,
      parentId: index === 0 ? null : `${id}-message-${index}`,
      message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
    })),
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n') + '\n';

async function fixture(t, { secondProject = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-public-api-'));
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
    sessionFile('native-session', cwd, ['Existing conversation']),
  );
  let cwdB = null;
  if (secondProject) {
    cwdB = join(root, 'second-project');
    await mkdir(cwdB, { recursive: true });
    await writeFile(
      join(sessionDir, '2026-second-session.jsonl'),
      sessionFile('second-session', cwdB, ['Second project conversation']),
    );
  }
  const runtime = fakeRuntime();
  const live = liveStub();
  const app = createApp({ agentHome, sessionDir, dataDir, initialCwd: cwd, runtime, liveClient: live });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function api(path, { method = 'GET', body, rawBody, headers = {} } = {}) {
    const payload = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: payload,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString('utf8');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      /* Stream or byte payload. */
    }
    return { status: response.status, headers: response.headers, text, json, buffer };
  }
  return { root, cwd, cwdB, sessionDir, dataDir, agentHome, runtime, live, app, port, base, api };
}

function openSse(port, path, headers) {
  return new Promise((resolvePromise, rejectPromise) => {
    const events = [];
    let pending = '';
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        pending += chunk;
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                events.push(JSON.parse(line.slice(6)));
              } catch {
                /* Comment or heartbeat. */
              }
            }
          }
        }
      });
      res.on('error', () => {});
      resolvePromise({ req, res, events });
    });
    req.on('error', rejectPromise);
    req.end();
  });
}

const bearer = (credential) => ({ Authorization: `Bearer ${credential}` });
const FULL_SCOPES = ['read', 'runs:write', 'roadmaps:write', 'files:download'];

async function enableApi(f, { scopes = FULL_SCOPES, projectIds = ['*'], name = 'integration' } = {}) {
  const initial = await f.api('/api/public-api');
  assert.equal(initial.status, 200);
  assert.equal(initial.json.enabled, false);
  assert.equal(initial.json.revision, 0);
  assert.deepEqual(initial.json.tokens, []);
  assert.deepEqual(initial.json.scopes, FULL_SCOPES);
  const enabled = await f.api('/api/public-api', {
    method: 'PATCH',
    body: { enabled: true, revision: initial.json.revision },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.enabled, true);
  assert.ok(typeof enabled.json.machineId === 'string' && enabled.json.machineId.length > 0);
  const created = await f.api('/api/public-api/tokens', {
    method: 'POST',
    body: { name, scopes, projectIds, revision: enabled.json.revision },
  });
  assert.equal(created.status, 201);
  return {
    credential: created.json.credential,
    token: created.json.token,
    admin: created.json.state,
    machineId: enabled.json.machineId,
    projects: enabled.json.projects,
    created,
  };
}

const projectIdFor = (projects, cwd) => projects.find((entry) => entry.cwd === cwd).id;

test('local administration is off by default, local-only, and follows a JSON revision', async (t) => {
  const f = await fixture(t);
  const initial = await f.api('/api/public-api');
  assert.equal(initial.json.enabled, false);
  assert.equal(initial.json.revision, 0);
  assert.deepEqual(initial.json.tokens, []);
  // A versioned token is useless while the switch is off.
  assert.equal((await f.api('/api/v1/machine')).status, 404);
  assert.equal((await f.api('/api/v1/machine')).json.code, 'api_disabled');
  const wrongMethod = await f.api('/api/public-api', { method: 'PUT' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, PATCH');

  const enabled = await f.api('/api/public-api', {
    method: 'PATCH',
    body: { enabled: true, revision: 0 },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.enabled, true);
  assert.equal(enabled.json.revision, 1);
  assert.ok(Array.isArray(enabled.json.projects) && enabled.json.projects.length >= 1);
  assert.ok(Array.isArray(enabled.json.endpoints) && enabled.json.endpoints.length >= 1);
  assert.equal((await f.api('/api/public-api?limit=1')).status, 400);

  const created = await f.api('/api/public-api/tokens', {
    method: 'POST',
    body: { name: 'integration', scopes: FULL_SCOPES, projectIds: ['*'], revision: 1 },
  });
  assert.equal(created.status, 201);
  assert.match(created.json.credential, /^pa_[A-Za-z0-9_-]{43}$/);
  assert.equal(typeof created.json.token.id, 'string');
  assert.equal(created.json.token.name, 'integration');
  assert.deepEqual(created.json.token.scopes, FULL_SCOPES);
  assert.deepEqual(created.json.token.projectIds, ['*']);
  assert.ok(!('digest' in created.json.token), 'only the digest is stored, never returned');
  assert.ok(!('credential' in created.json.token));
  assert.equal(created.json.state.revision, 2);
  assert.equal(created.json.state.tokens.length, 1);

  const listed = await f.api('/api/public-api');
  assert.equal(listed.json.revision, 2);
  assert.equal(listed.json.tokens.length, 1);
  assert.ok(!('credential' in listed.json.tokens[0]), 'the secret is shown once');

  // Administration never accepts a versioned token, even a valid one.
  for (const target of [
    ['/api/public-api', {}],
    ['/api/public-api/tokens', { name: 'other', scopes: ['read'], projectIds: ['*'], revision: 2 }],
  ]) {
    const refused = await f.api(target[0], {
      method: target[0].endsWith('tokens') ? 'POST' : 'GET',
      ...(target[0].endsWith('tokens') ? { body: target[1] } : {}),
      headers: bearer(created.json.credential),
    });
    assert.equal(refused.status, 401);
    assert.equal(refused.json.code, 'api_token_not_accepted');
  }
  const refusedPatch = await f.api('/api/public-api', {
    method: 'PATCH',
    body: { enabled: false, revision: 2 },
    headers: bearer(created.json.credential),
  });
  assert.equal(refusedPatch.status, 401);

  // Deleting a token takes a JSON revision and reports live conflicts.
  const stale = await f.api(`/api/public-api/tokens/${created.json.token.id}`, {
    method: 'DELETE',
    body: { revision: 1 },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.currentRevision, 2);
  const malformed = await f.api(`/api/public-api/tokens/${created.json.token.id}`, {
    method: 'DELETE',
    body: { revision: 2, unexpected: true },
  });
  assert.equal(malformed.status, 400);
  const removed = await f.api(`/api/public-api/tokens/${created.json.token.id}`, {
    method: 'DELETE',
    body: { revision: 2 },
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.tokens, []);
  assert.equal(removed.json.revision, 3);
  const retired = await f.api('/api/v1/machine', { headers: bearer(created.json.credential) });
  assert.equal(retired.status, 401);
});

test('versioned authorization uses the header only and never opens internal routes', async (t) => {
  const f = await fixture(t);
  const { credential } = await enableApi(f);
  const machine = await f.api('/api/v1/machine', { headers: bearer(credential) });
  assert.equal(machine.status, 200);
  assert.equal(machine.json.apiVersion, 'v1');

  assert.equal((await f.api('/api/v1/machine')).status, 401);
  assert.equal((await f.api('/api/v1/machine')).json.code, 'api_unauthorized');
  assert.match((await f.api('/api/v1/machine')).headers.get('www-authenticate') || '', /Bearer/);
  assert.equal((await f.api('/api/v1/machine', { headers: bearer('pa_missing') })).status, 401);
  // No cookie fallback and no query fallback for the credential.
  assert.equal((await f.api('/api/v1/machine', { headers: { Cookie: `token=${credential}` } })).status, 401);
  assert.equal((await f.api(`/api/v1/machine?token=${credential}`)).status, 401);
  // A versioned token never opens the internal contract.
  for (const path of ['/api/health', '/api/overview', '/api/history?id=native-session']) {
    const refused = await f.api(path, { headers: bearer(credential) });
    assert.equal(refused.status, 401, path);
    assert.equal(refused.json.code, 'api_token_not_accepted');
  }

  // Project scopes use opaque local identifiers, validated against live projects.
  const admin = await f.api('/api/public-api');
  for (const entry of admin.json.projects) {
    assert.match(entry.id, /^p_[0-9a-f]{32}$/);
    assert.ok(typeof entry.cwd === 'string' && entry.cwd.length > 0);
  }
  const unknown = await f.api('/api/public-api/tokens', {
    method: 'POST',
    body: {
      name: 'unknown',
      scopes: ['read'],
      projectIds: [`p_${'9'.repeat(32)}`],
      revision: admin.json.revision,
    },
  });
  assert.equal(unknown.status, 400);
});

test('runtime reads expose stable projections with bounded pagination', async (t) => {
  const f = await fixture(t);
  const { credential, machineId, projects } = await enableApi(f);
  const auth = bearer(credential);
  const projectId = projectIdFor(projects, f.cwd);

  const machine = await f.api('/api/v1/machine', { headers: auth });
  assert.equal(machine.json.machineId, machineId);
  assert.equal(machine.json.apiVersion, 'v1');
  assert.deepEqual(machine.json.capabilities, ['projects', 'conversations', 'runs', 'roadmaps', 'files']);
  assert.deepEqual(machine.json.idempotency, { retentionSeconds: 3600, persistent: false });

  const listed = await f.api('/api/v1/projects', { headers: auth });
  assert.equal(listed.json.items.length, 1);
  assert.equal(listed.json.items[0].id, projectId);
  assert.match(listed.json.items[0].id, /^p_[0-9a-f]{32}$/);
  assert.equal(listed.json.items[0].machineId, machineId);
  assert.equal(listed.json.nextOffset, null);
  assert.equal((await f.api('/api/v1/projects?limit=0', { headers: auth })).status, 400);
  assert.equal((await f.api('/api/v1/projects?unknown=1', { headers: auth })).status, 400);
  assert.equal((await f.api('/api/v1/projects?limit=1&limit=1', { headers: auth })).status, 400);

  const models = await f.api('/api/v1/models', { headers: auth });
  assert.equal(models.json.items[0].id, 'openai/gpt-5.6-luna');

  const sessions = await f.api(`/api/v1/projects/${projectId}/sessions`, { headers: auth });
  assert.equal(sessions.json.items.length, 1);
  assert.equal(sessions.json.items[0].id, 'native-session');
  assert.equal(sessions.json.items[0].projectId, projectId);
  assert.equal(sessions.json.items[0].machineId, machineId);

  const messages = await f.api('/api/v1/sessions/native-session/messages', { headers: auth });
  assert.equal(messages.json.sessionId, 'native-session');
  assert.equal(messages.json.projectId, projectId);
  assert.equal(messages.json.machineId, machineId);
  assert.equal(messages.json.items.length, 1);
  assert.equal(messages.json.items[0].text, 'Existing conversation');

  assert.deepEqual((await f.api('/api/v1/runs', { headers: auth })).json.items, []);
});

test('runs start, report, interact, stream, accept direct messages, and stop', async (t) => {
  const f = await fixture(t);
  const { credential, machineId, projects } = await enableApi(f);
  const auth = bearer(credential);
  const projectId = projectIdFor(projects, f.cwd);

  const started = await f.api(`/api/v1/projects/${projectId}/runs`, {
    method: 'POST',
    body: { requestId: 'run-request-00000001', message: 'Hello integration' },
    headers: auth,
  });
  assert.equal(started.status, 201);
  assert.equal(started.json.projectId, projectId);
  assert.equal(started.json.machineId, machineId);
  assert.equal(started.json.requestId, 'run-request-00000001');
  assert.equal(started.json.sessionId, null);
  assert.equal(f.runtime.controls.length, 1);
  assert.equal(f.runtime.controls[0].input.cwd, f.cwd);
  assert.equal(f.runtime.controls[0].input.computerUse, undefined);
  const runId = started.json.id;

  const control = f.runtime.controls[0];
  control.emit({ kind: 'session', sessionId: 'native-session' });
  control.emit({ kind: 'text', delta: 'Working' });
  await until(
    async () => (await f.api(`/api/v1/runs/${runId}`, { headers: auth })).json.sessionId === 'native-session',
  );
  const run = await f.api(`/api/v1/runs/${runId}`, { headers: auth });
  assert.equal(run.json.status, 'running');

  control.emit({ kind: 'interaction', request: { id: 'question-1', status: 'pending' } });
  const answered = await f.api(`/api/v1/runs/${runId}/interactions`, {
    method: 'POST',
    body: { id: 'question-1', response: { confirmed: true } },
    headers: auth,
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.json.answered, true);
  assert.equal(
    (
      await f.api(`/api/v1/runs/${runId}/interactions`, {
        method: 'POST',
        body: { id: 'question-1', response: { confirmed: 'yes' } },
        headers: auth,
      })
    ).status,
    400,
  );

  const sent = await f.api('/api/v1/sessions/native-session/messages', {
    method: 'POST',
    body: { requestId: 'direct-message-000001', mode: 'follow_up', message: 'Continue' },
    headers: auth,
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.accepted, true);
  assert.equal(f.live.sends.length, 1);

  const stream = await openSse(f.port, `/api/v1/runs/${runId}/events`, {
    Authorization: `Bearer ${credential}`,
    Accept: 'text/event-stream',
  });
  t.after(() => stream.req.destroy());
  control.emit({ kind: 'text', delta: 'Streamed' });
  await until(() => stream.events.some((event) => event.kind === 'text'));
  const projected = stream.events.find((event) => event.kind === 'text');
  assert.equal(projected.machineId, machineId);
  assert.equal(projected.projectId, projectId);
  assert.equal(projected.runId, runId);
  stream.req.destroy();
  assert.equal(control.cancelCalls, 0, 'closing the stream never stops the run');

  const replay = await openSse(f.port, `/api/v1/runs/${runId}/events?after=1`, auth);
  t.after(() => replay.req.destroy());
  assert.equal(replay.res.statusCode, 200);
  assert.match(replay.res.headers['content-type'] || '', /text\/event-stream/);
  await until(() => replay.events.some((event) => event.delta === 'Streamed'));
  assert.ok(replay.events.every((event) => event.seq > 1));
  replay.req.destroy();

  const stopped = await f.api(`/api/v1/runs/${runId}/stop`, { method: 'POST', body: {}, headers: auth });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.stopped, true);
  await until(() => f.app.runs.get(runId)?.finished === true);
  assert.equal(control.cancelCalls, 1);
});

test('request identifiers are idempotent, canonical, and conflict on different input', async (t) => {
  const f = await fixture(t);
  const { credential, projects } = await enableApi(f);
  const auth = bearer(credential);
  const projectId = projectIdFor(projects, f.cwd);
  const path = `/api/v1/projects/${projectId}/runs`;

  const first = await f.api(path, {
    method: 'POST',
    body: { requestId: 'idem-request-00000001', message: 'Same work' },
    headers: auth,
  });
  assert.equal(first.status, 201);
  const same = await f.api(path, {
    method: 'POST',
    body: { requestId: 'idem-request-00000001', message: 'Same work' },
    headers: auth,
  });
  assert.equal(same.status, 201);
  assert.equal(same.json.id, first.json.id);
  assert.equal(f.runtime.controls.length, 1);

  // Property ordering does not change the canonical fingerprint.
  const reordered = await f.api(path, {
    method: 'POST',
    rawBody: JSON.stringify({ message: 'Same work', requestId: 'idem-request-00000001' }),
    headers: auth,
  });
  assert.equal(reordered.status, 201);
  assert.equal(reordered.json.id, first.json.id);
  assert.equal(f.runtime.controls.length, 1);

  const conflict = await f.api(path, {
    method: 'POST',
    body: { requestId: 'idem-request-00000001', message: 'Different work' },
    headers: auth,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 'request_conflict');
  assert.equal(f.runtime.controls.length, 1);
  f.runtime.controls[0].finish();
});

test('tokens only see their own projects, sessions, and runs', async (t) => {
  const f = await fixture(t, { secondProject: true });
  const full = await enableApi(f, { name: 'full' });
  const admin = await f.api('/api/public-api');
  const projectA = projectIdFor(admin.json.projects, f.cwd);
  const projectB = projectIdFor(admin.json.projects, f.cwdB);
  assert.notEqual(projectA, projectB);

  const limited = await f.api('/api/public-api/tokens', {
    method: 'POST',
    body: { name: 'limited', scopes: FULL_SCOPES, projectIds: [projectA], revision: admin.json.revision },
  });
  assert.equal(limited.status, 201);
  const auth = bearer(limited.json.credential);

  assert.equal((await f.api(`/api/v1/projects/${projectB}/sessions`, { headers: auth })).status, 404);
  assert.equal((await f.api('/api/v1/sessions/second-session/messages', { headers: auth })).status, 404);
  assert.equal(
    (
      await f.api(`/api/v1/projects/${projectB}/runs`, {
        method: 'POST',
        body: { requestId: 'other-project-000001', message: 'No access' },
        headers: auth,
      })
    ).status,
    404,
  );
  assert.equal(f.runtime.controls.length, 0);

  const other = await f.api(`/api/v1/projects/${projectB}/runs`, {
    method: 'POST',
    body: { requestId: 'other-project-000002', message: 'Second project work' },
    headers: bearer(full.credential),
  });
  assert.equal(other.status, 201);
  assert.equal((await f.api(`/api/v1/runs/${other.json.id}`, { headers: auth })).status, 404);
  assert.equal((await f.api(`/api/v1/runs/${other.json.id}/events`, { headers: auth })).status, 404);
  const visible = await f.api('/api/v1/runs', { headers: auth });
  assert.deepEqual(visible.json.items, []);
  f.runtime.controls[0].finish();
});

test('unknown body fields are rejected, including location and desktop flags', async (t) => {
  const f = await fixture(t);
  const { credential, projects } = await enableApi(f);
  const auth = bearer(credential);
  const projectId = projectIdFor(projects, f.cwd);
  const runPath = `/api/v1/projects/${projectId}/runs`;

  for (const body of [
    { requestId: 'unknown-field-000001', message: 'Hi', cwd: f.cwd },
    { requestId: 'unknown-field-000002', message: 'Hi', computerUse: true },
    { requestId: 'unknown-field-000003', message: 'Hi', images: [] },
  ]) {
    const refused = await f.api(runPath, { method: 'POST', body, headers: auth });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.match(refused.json.error, /Unknown field/);
  }
  assert.equal(f.runtime.controls.length, 0);

  const started = await f.api(runPath, {
    method: 'POST',
    body: { requestId: 'unknown-field-000004', message: 'Hi' },
    headers: auth,
  });
  assert.equal(started.status, 201);
  const runId = started.json.id;
  assert.equal(
    (await f.api(`/api/v1/runs/${runId}/stop`, { method: 'POST', body: { force: true }, headers: auth }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.api(`/api/v1/runs/${runId}/interactions`, {
        method: 'POST',
        body: { id: 'q1', response: { confirmed: true }, extra: 1 },
        headers: auth,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.api('/api/v1/sessions/native-session/messages', {
        method: 'POST',
        body: { requestId: 'unknown-field-000005', mode: 'follow_up', message: 'Hi', cwd: f.cwd },
        headers: auth,
      })
    ).status,
    400,
  );
  const roadmap = await f.api(`/api/v1/projects/${projectId}/roadmap`, { headers: auth });
  assert.equal(roadmap.status, 200);
  assert.equal(
    (
      await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
        method: 'POST',
        body: { action: 'init', expectedRevision: roadmap.json.roadmap.revision, cwd: f.cwd },
        headers: auth,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.api(`/api/v1/projects/${projectId}/roadmap/work`, {
        method: 'POST',
        body: {
          requestId: 'unknown-field-000006',
          expectedRevision: roadmap.json.roadmap.revision,
          targets: [{ kind: 'plan', planId: 'plan-1' }],
          cwd: f.cwd,
        },
        headers: auth,
      })
    ).status,
    400,
  );
  f.runtime.controls[0].finish();
});

test('a read-only token reads but never writes, messages, or downloads bytes', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, 'docs'), { recursive: true });
  await writeFile(join(f.cwd, 'docs', 'note.md'), '# Note\n');
  const full = await enableApi(f, { name: 'full' });
  const admin = await f.api('/api/public-api');
  const projectId = projectIdFor(admin.json.projects, f.cwd);
  const reader = await f.api('/api/public-api/tokens', {
    method: 'POST',
    body: { name: 'reader', scopes: ['read'], projectIds: [projectId], revision: admin.json.revision },
  });
  assert.equal(reader.status, 201);
  const auth = bearer(reader.json.credential);

  assert.equal((await f.api('/api/v1/projects', { headers: auth })).status, 200);
  assert.equal((await f.api(`/api/v1/projects/${projectId}/sessions`, { headers: auth })).status, 200);
  assert.equal((await f.api('/api/v1/sessions/native-session/files', { headers: auth })).status, 200);

  assert.equal(
    (
      await f.api(`/api/v1/projects/${projectId}/runs`, {
        method: 'POST',
        body: { requestId: 'reader-request-000001', message: 'Denied' },
        headers: auth,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
        method: 'POST',
        body: { action: 'init', expectedRevision: 0 },
        headers: auth,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api(`/api/v1/projects/${projectId}/roadmap/work`, {
        method: 'POST',
        body: { requestId: 'reader-request-000002', expectedRevision: 0, targets: [] },
        headers: auth,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api('/api/v1/sessions/native-session/messages', {
        method: 'POST',
        body: { requestId: 'reader-request-000003', mode: 'follow_up', message: 'Denied' },
        headers: auth,
      })
    ).status,
    403,
  );
  assert.equal(f.runtime.controls.length, 0);

  // Bytes stay separate from listing: the reader lists but never downloads.
  const started = await f.api(`/api/v1/projects/${projectId}/runs`, {
    method: 'POST',
    body: { requestId: 'reader-proof-00000001', message: 'Proof', sessionId: 'native-session' },
    headers: bearer(full.credential),
  });
  assert.equal(started.status, 201);
  f.runtime.controls[0].emit({
    kind: 'message',
    message: { role: 'assistant', text: 'See [note](docs/note.md).' },
  });
  await writeFile(
    join(f.sessionDir, '2026-native-session.jsonl'),
    sessionFile('native-session', f.cwd, ['Existing conversation', 'See [note](docs/note.md).']),
  );
  let fileId = null;
  await until(async () => {
    const listed = await f.api('/api/v1/sessions/native-session/files', {
      headers: bearer(full.credential),
    });
    fileId = listed.json.items[0]?.available ? listed.json.items[0].id : null;
    return fileId !== null;
  });
  assert.equal(
    (await f.api(`/api/v1/sessions/native-session/files/${fileId}`, { headers: auth })).status,
    403,
  );
  assert.equal(
    (await f.api(`/api/v1/sessions/native-session/files/${fileId}`, { headers: auth, method: 'HEAD' }))
      .status,
    403,
  );
  f.runtime.controls[0].finish();
});

test('roadmap mutations use revisions and work dispatches without checking tasks off', async (t) => {
  const f = await fixture(t);
  const { credential, projects } = await enableApi(f);
  const auth = bearer(credential);
  const projectId = projectIdFor(projects, f.cwd);

  let document = (await f.api(`/api/v1/projects/${projectId}/roadmap`, { headers: auth })).json.roadmap;
  assert.equal(document.initialized, false);
  document = (
    await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: { action: 'init', expectedRevision: document.revision },
      headers: auth,
    })
  ).json.roadmap;
  assert.equal(document.revision, 1);

  document = (
    await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: { action: 'plan.create', expectedRevision: document.revision, title: 'Deliver' },
      headers: auth,
    })
  ).json.roadmap;
  const planId = document.plans[0].id;
  document = (
    await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: { action: 'step.add', expectedRevision: document.revision, planId, text: 'Verify' },
      headers: auth,
    })
  ).json.roadmap;
  const stepId = document.plans[0].steps[0].id;
  assert.equal(document.plans[0].steps[0].done, false);

  const stale = await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
    method: 'POST',
    body: { action: 'vision', expectedRevision: 1, text: 'Stale' },
    headers: auth,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.currentRevision, document.revision);

  // First dispatch is idempotent: same input and reordered input share one run.
  const work = {
    requestId: 'roadmap-work-00000001',
    expectedRevision: document.revision,
    targets: [{ kind: 'plan', planId }],
  };
  const accepted = await f.api(`/api/v1/projects/${projectId}/roadmap/work`, {
    method: 'POST',
    body: work,
    headers: auth,
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.json.accepted, true);
  assert.equal(accepted.json.queued, false);
  assert.equal(accepted.json.requestId, work.requestId);
  assert.equal(f.runtime.controls.length, 1);
  const runId = accepted.json.run.id;
  const retried = await f.api(`/api/v1/projects/${projectId}/roadmap/work`, {
    method: 'POST',
    rawBody: JSON.stringify({
      targets: [{ kind: 'plan', planId }],
      expectedRevision: document.revision,
      requestId: work.requestId,
    }),
    headers: auth,
  });
  assert.equal(retried.status, 201);
  assert.equal(retried.json.run.id, runId);
  assert.equal(f.runtime.controls.length, 1);
  const conflicted = await f.api(`/api/v1/projects/${projectId}/roadmap/work`, {
    method: 'POST',
    body: { ...work, instructions: 'Different instructions' },
    headers: auth,
  });
  assert.equal(conflicted.status, 409);
  assert.equal(f.runtime.controls.length, 1);

  // Persist the same native session the runtime announces, as the real engine does.
  await writeFile(
    join(f.sessionDir, '2026-work-session-1.jsonl'),
    sessionFile('work-session-1', f.cwd, ['Roadmap work']),
  );
  // The emitted session links to the plan while the task stays unchecked.
  f.runtime.controls[0].emit({ kind: 'session', sessionId: 'work-session-1' });
  await until(async () => {
    const current = (await f.api(`/api/v1/projects/${projectId}/roadmap`, { headers: auth })).json.roadmap;
    return current.plans[0].sessions.includes('work-session-1');
  });
  document = (await f.api(`/api/v1/projects/${projectId}/roadmap`, { headers: auth })).json.roadmap;
  assert.deepEqual(document.plans[0].sessions, ['work-session-1']);
  assert.equal(document.plans[0].steps.find((step) => step.id === stepId).done, false);

  // Work sent to the active session queues into it instead of starting a run.
  const queued = await f.api(`/api/v1/projects/${projectId}/roadmap/work`, {
    method: 'POST',
    body: {
      requestId: 'roadmap-work-00000002',
      expectedRevision: document.revision,
      targets: [{ kind: 'plan', planId }],
      sessionId: 'work-session-1',
    },
    headers: auth,
  });
  assert.equal(queued.status, 201);
  assert.equal(queued.json.queued, true);
  assert.equal(f.runtime.controls.length, 1);
  assert.equal(f.live.sends.length, 1);
  f.runtime.controls[0].finish();
  await until(() => f.app.runs.get(runId)?.finished);
  const finishedRoadmap = (await f.api(`/api/v1/projects/${projectId}/roadmap`, { headers: auth })).json
    .roadmap;
  assert.equal(finishedRoadmap.plans[0].steps[0].done, false);
});

test('linked files need both persisted history and a native message receipt', async (t) => {
  const f = await fixture(t);
  const { credential, machineId, projects } = await enableApi(f);
  const auth = bearer(credential);
  const projectId = projectIdFor(projects, f.cwd);
  await mkdir(join(f.cwd, 'docs'), { recursive: true });
  await writeFile(join(f.cwd, 'docs', 'note.md'), '# Note\n');
  const linkText = 'See [note](docs/note.md).';

  // History alone never serves bytes: the reference is known but unproven.
  await writeFile(
    join(f.sessionDir, '2026-native-session.jsonl'),
    sessionFile('native-session', f.cwd, ['Existing conversation', linkText]),
  );
  let listed = await f.api('/api/v1/sessions/native-session/files', { headers: auth });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.items.length, 1);
  assert.equal(listed.json.items[0].available, false);
  assert.equal(listed.json.items[0].originMachineId, null);
  const listedId = listed.json.items[0].id;
  assert.equal(
    (await f.api(`/api/v1/sessions/native-session/files/${listedId}`, { headers: auth })).status,
    409,
  );

  // Streaming deltas never mint receipts; only normalized message events do.
  const started = await f.api(`/api/v1/projects/${projectId}/runs`, {
    method: 'POST',
    body: { requestId: 'file-proof-00000001', message: 'Proof', sessionId: 'native-session' },
    headers: auth,
  });
  assert.equal(started.status, 201);
  const control = f.runtime.controls[0];
  control.emit({ kind: 'text', delta: linkText });
  await delay(100);
  listed = await f.api('/api/v1/sessions/native-session/files', { headers: auth });
  assert.equal(listed.json.items[0].available, false);

  control.emit({ kind: 'message', message: { role: 'assistant', text: linkText } });
  await until(async () => {
    const current = await f.api('/api/v1/sessions/native-session/files', { headers: auth });
    return current.json.items[0]?.available === true;
  });
  listed = await f.api('/api/v1/sessions/native-session/files', { headers: auth });
  assert.equal(listed.json.items[0].id, listedId, 'identifiers stay deterministic per session');
  assert.equal(listed.json.items[0].name, 'note.md');
  assert.equal(listed.json.items[0].size, 7);
  assert.equal(listed.json.items[0].machineId, machineId);
  assert.equal(listed.json.items[0].originMachineId, machineId);

  const download = await f.api(`/api/v1/sessions/native-session/files/${listedId}`, { headers: auth });
  assert.equal(download.status, 200);
  assert.equal(download.buffer.toString('utf8'), '# Note\n');
  assert.equal(download.headers.get('accept-ranges'), 'bytes');
  assert.ok((download.headers.get('etag') || '').length > 0);
  const head = await f.api(`/api/v1/sessions/native-session/files/${listedId}`, {
    headers: auth,
    method: 'HEAD',
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '7');
  assert.equal(head.buffer.length, 0);
  const ranged = await f.api(`/api/v1/sessions/native-session/files/${listedId}`, {
    headers: { ...auth, Range: 'bytes=0-5' },
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.buffer.toString('utf8'), '# Note');
  assert.equal(
    (await f.api('/api/v1/sessions/native-session/files/deadbeefdeadbeefdeadbeefdeadbeef', { headers: auth }))
      .status,
    404,
  );
  control.finish();
});

test('revoking a token closes its streams without stopping the run', async (t) => {
  const f = await fixture(t);
  const first = await enableApi(f, { name: 'first' });
  const admin = await f.api('/api/public-api');
  const projectId = projectIdFor(admin.json.projects, f.cwd);
  const second = await f.api('/api/public-api/tokens', {
    method: 'POST',
    body: { name: 'second', scopes: FULL_SCOPES, projectIds: ['*'], revision: admin.json.revision },
  });
  assert.equal(second.status, 201);
  const victim = first.credential;
  const checker = bearer(second.json.credential);

  const started = await f.api(`/api/v1/projects/${projectId}/runs`, {
    method: 'POST',
    body: { requestId: 'revoke-stream-00000001', message: 'Long work' },
    headers: bearer(victim),
  });
  assert.equal(started.status, 201);
  const runId = started.json.id;
  const stream = await openSse(f.port, `/api/v1/runs/${runId}/events`, {
    Authorization: `Bearer ${victim}`,
    Accept: 'text/event-stream',
  });
  t.after(() => stream.req.destroy());
  f.runtime.controls[0].emit({ kind: 'text', delta: 'Before revoke' });
  await until(() => stream.events.length >= 1);
  const closed = new Promise((done) => {
    stream.res.on('close', done);
    setTimeout(done, 3000);
  });
  const revision = (await f.api('/api/public-api')).json.revision;
  const revoked = await f.api(`/api/public-api/tokens/${first.token.id}`, {
    method: 'DELETE',
    body: { revision },
  });
  assert.equal(revoked.status, 200);
  await closed;
  assert.equal((await f.api(`/api/v1/runs/${runId}`, { headers: checker })).json.status, 'running');
  assert.equal(f.runtime.controls.length, 1);
  assert.equal(f.runtime.controls[0].cancelCalls, 0);
  assert.equal(
    (await f.api(`/api/v1/runs/${runId}/stop`, { method: 'POST', body: {}, headers: checker })).status,
    200,
  );
});

test('disabling the switch closes streams without stopping runs', async (t) => {
  const f = await fixture(t);
  const { credential } = await enableApi(f);
  const admin = await f.api('/api/public-api');
  const projectId = projectIdFor(admin.json.projects, f.cwd);
  const started = await f.api(`/api/v1/projects/${projectId}/runs`, {
    method: 'POST',
    body: { requestId: 'disable-stream-000001', message: 'Long work' },
    headers: bearer(credential),
  });
  assert.equal(started.status, 201);
  const runId = started.json.id;
  const stream = await openSse(f.port, `/api/v1/runs/${runId}/events`, {
    Authorization: `Bearer ${credential}`,
    Accept: 'text/event-stream',
  });
  t.after(() => stream.req.destroy());
  f.runtime.controls[0].emit({ kind: 'text', delta: 'Before disable' });
  await until(() => stream.events.length >= 1);
  const closed = new Promise((done) => {
    stream.res.on('close', done);
    setTimeout(done, 3000);
  });
  const revision = (await f.api('/api/public-api')).json.revision;
  assert.equal(
    (await f.api('/api/public-api', { method: 'PATCH', body: { enabled: false, revision } })).status,
    200,
  );
  await closed;
  const refused = await f.api('/api/v1/runs', { headers: bearer(credential) });
  assert.equal(refused.status, 404);
  assert.equal(refused.json.code, 'api_disabled');
  const restored = await f.api('/api/public-api', {
    method: 'PATCH',
    body: { enabled: true, revision: revision + 1 },
  });
  assert.equal(restored.status, 200);
  assert.equal(
    (await f.api(`/api/v1/runs/${runId}`, { headers: bearer(credential) })).json.status,
    'running',
  );
  assert.equal(f.runtime.controls[0].cancelCalls, 0);
  f.runtime.controls[0].finish();
});

test('a retired token cannot start a deferred run and a disabled switch admits nothing', async (t) => {
  const f = await fixture(t);
  const { credential, token } = await enableApi(f);
  const admin = await f.api('/api/public-api');
  const projectId = projectIdFor(admin.json.projects, f.cwd);
  f.runtime.deferNext = true;
  const revision = (await f.api('/api/public-api')).json.revision;
  assert.equal(
    (await f.api(`/api/public-api/tokens/${token.id}`, { method: 'DELETE', body: { revision } })).status,
    200,
  );
  const refused = await f.api(`/api/v1/projects/${projectId}/runs`, {
    method: 'POST',
    body: { requestId: 'deferred-denied-000001', message: 'Denied' },
    headers: bearer(credential),
  });
  assert.equal(refused.status, 401);
  assert.equal(f.runtime.controls.length, 0);
  f.runtime.releaseStartup();

  const current = await f.api('/api/public-api');
  const disabled = await f.api('/api/public-api', {
    method: 'PATCH',
    body: { enabled: false, revision: current.json.revision },
  });
  assert.equal(disabled.status, 200);
  f.runtime.deferNext = true;
  const blocked = await f.api(`/api/v1/projects/${projectId}/runs`, {
    method: 'POST',
    body: { requestId: 'deferred-denied-000002', message: 'Denied' },
    headers: bearer(credential),
  });
  assert.equal(blocked.status, 404);
  assert.equal(f.runtime.controls.length, 0);
  f.runtime.releaseStartup();
  assert.equal(admin.json.projects.length, 1);
});

for (const action of ['revoke', 'disable']) {
  test(
    `${action} interrupts an actual file transfer without stopping its run`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const access = await enableApi(f);
      const auth = bearer(access.credential);
      const projectId = projectIdFor(access.projects, f.cwd);
      const output = join(f.root, 'large-output.bin');
      const size = 32 * 1024 * 1024;
      const file = await open(output, 'w');
      try {
        await file.truncate(size);
      } finally {
        await file.close();
      }
      const text = `[output](${output.replaceAll('\\', '/')})`;
      await writeFile(
        join(f.sessionDir, '2026-native-session.jsonl'),
        sessionFile('native-session', f.cwd, ['Generate an output', text]),
      );
      const started = await f.api(`/api/v1/projects/${projectId}/runs`, {
        method: 'POST',
        headers: auth,
        body: { requestId: `file-${action}-request-0001`, message: 'Continue', sessionId: 'native-session' },
      });
      assert.equal(started.status, 201);
      const control = f.runtime.controls[0];
      control.emit({ kind: 'message', message: { id: 'local-output', role: 'assistant', text } });
      const listing = await f.api('/api/v1/sessions/native-session/files', { headers: auth });
      const linked = listing.json.items.find((entry) => entry.name === 'large-output.bin');
      assert.equal(linked.available, true);
      const path = `/api/v1/sessions/native-session/files/${linked.id}`;
      const transfer = await new Promise((done, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port: f.port, path, headers: auth }, (res) => {
          res.pause();
          res.on('error', () => {});
          done({ req, res });
        });
        req.on('error', reject);
        req.end();
      });
      t.after(() => transfer.req.destroy());
      assert.equal(transfer.res.statusCode, 200);
      assert.equal(Number(transfer.res.headers['content-length']), size);
      const etag = transfer.res.headers.etag;
      let received = 0;
      transfer.res.on('data', (chunk) => {
        received += chunk.length;
      });
      const disconnected = new Promise((done) => transfer.res.once('close', done));
      const state = (await f.api('/api/public-api')).json;
      if (action === 'revoke') {
        assert.equal(
          (
            await f.api(`/api/public-api/tokens/${access.token.id}`, {
              method: 'DELETE',
              body: { revision: state.revision },
            })
          ).status,
          200,
        );
      } else {
        assert.equal(
          (
            await f.api('/api/public-api', {
              method: 'PATCH',
              body: { revision: state.revision, enabled: false },
            })
          ).status,
          200,
        );
      }
      transfer.res.resume();
      await disconnected;
      assert.equal(transfer.res.complete, false);
      assert.ok(received < size);
      assert.equal(control.cancelCalls, 0);
      assert.equal(f.app.runs.get(started.json.id).status, 'running');
      let renewedState = (await f.api('/api/public-api')).json;
      if (!renewedState.enabled)
        renewedState = (
          await f.api('/api/public-api', {
            method: 'PATCH',
            body: { revision: renewedState.revision, enabled: true },
          })
        ).json;
      const renewed = await f.api('/api/public-api/tokens', {
        method: 'POST',
        body: {
          name: 'resumed-transfer',
          scopes: FULL_SCOPES,
          projectIds: ['*'],
          revision: renewedState.revision,
        },
      });
      assert.equal(renewed.status, 201);
      const resumed = await f.api(path, {
        headers: {
          ...bearer(renewed.json.credential),
          Range: `bytes=${received}-${received + 15}`,
          'If-Match': etag,
        },
      });
      assert.equal(resumed.status, 206);
      assert.equal(resumed.buffer.length, 16);
      assert.deepEqual(resumed.buffer, Buffer.alloc(16));
      assert.equal(resumed.headers.get('content-range'), `bytes ${received}-${received + 15}/${size}`);
      control.finish();
    },
  );
}

test('two instances keep distinct machine identities, share an explicit project link, and isolate tokens', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const syncId = '123e4567-e89b-12d3-a456-426614174000';
  for (const f of [first, second]) {
    const patched = await f.api('/api/projects', { method: 'PATCH', body: { cwd: f.cwd, syncId } });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.syncId, syncId);
  }
  const left = await enableApi(first, { name: 'left' });
  const right = await enableApi(second, { name: 'right' });
  assert.notEqual(left.machineId, right.machineId);
  assert.equal(
    (await first.api('/api/v1/machine', { headers: bearer(left.credential) })).json.machineId,
    left.machineId,
  );
  assert.equal(
    (await second.api('/api/v1/machine', { headers: bearer(right.credential) })).json.machineId,
    right.machineId,
  );

  const projectLeft = projectIdFor(left.projects, first.cwd);
  const projectRight = projectIdFor(right.projects, second.cwd);
  assert.notEqual(projectLeft, projectRight, 'opaque routing identifiers stay local to each machine');
  const listedLeft = await first.api('/api/v1/projects', { headers: bearer(left.credential) });
  const listedRight = await second.api('/api/v1/projects', { headers: bearer(right.credential) });
  assert.equal(listedLeft.json.items[0].syncId, syncId);
  assert.equal(listedRight.json.items[0].syncId, syncId);

  const started = await first.api(`/api/v1/projects/${projectLeft}/runs`, {
    method: 'POST',
    body: { requestId: 'selected-instance-00001', message: 'Left work' },
    headers: bearer(left.credential),
  });
  assert.equal(started.status, 201);
  assert.equal(started.json.machineId, left.machineId);
  assert.equal(first.runtime.controls.length, 1);
  assert.equal(second.runtime.controls.length, 0);
  assert.deepEqual((await second.api('/api/v1/runs', { headers: bearer(right.credential) })).json.items, []);
  assert.equal(
    (await second.api(`/api/v1/runs/${started.json.id}`, { headers: bearer(right.credential) })).status,
    404,
  );

  // Credentials never cross over to the other machine.
  assert.equal((await second.api('/api/v1/machine', { headers: bearer(left.credential) })).status, 401);
  assert.equal((await first.api('/api/v1/machine', { headers: bearer(right.credential) })).status, 401);
  // Losing HTTP access does not stop the run or dispatch the work on the other Studio.
  first.app.server.closeAllConnections();
  await new Promise((done) => first.app.server.close(done));
  await assert.rejects(
    fetch(`${first.base}/api/v1/machine`, {
      headers: bearer(left.credential),
      signal: AbortSignal.timeout(1000),
    }),
  );
  assert.equal(first.runtime.controls[0].cancelCalls, 0);
  assert.equal(second.runtime.controls.length, 0);
  await new Promise((done) => first.app.server.listen(first.port, '127.0.0.1', done));
  const retry = await first.api(`/api/v1/projects/${projectLeft}/runs`, {
    method: 'POST',
    headers: bearer(left.credential),
    body: { requestId: 'selected-instance-00001', message: 'Left work' },
  });
  assert.equal(retry.status, 201);
  assert.equal(retry.json.id, started.json.id);
  assert.equal(first.runtime.controls.length, 1);
  assert.equal(second.runtime.controls.length, 0);
  first.runtime.controls[0].finish();
});

test('roadmap changes converge through a shared in-memory object store without cloud calls', async (t) => {
  const calls = { put: 0, get: 0, list: 0 };
  const files = new Map();
  const objectStore = {
    async put(key, body) {
      calls.put++;
      files.set(key, Buffer.from(body));
    },
    async get(key) {
      calls.get++;
      return files.get(key) ?? null;
    },
    async remove(key) {
      files.delete(key);
    },
    async list(prefix) {
      calls.list++;
      return [...files.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
  };
  const { createRoadmapService } = await import('../lib/roadmap.mjs');
  const { createConversationSync } = await import('../lib/conversation-sync.mjs');
  const root = await mkdtemp(join(tmpdir(), 'prime-public-api-sync-'));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const sharedSyncId = '123e4567-e89b-12d3-a456-426614174001';
  async function machine(name) {
    const dataDir = join(root, name, 'data');
    const sessionDir = join(root, name, 'sessions');
    const cwd = join(root, name, 'project');
    await mkdir(cwd, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    const projects = [{ cwd, name: 'project', syncId: sharedSyncId }];
    const store = {
      overview: async () => ({ projects: projects.map((entry) => ({ ...entry, sessions: [] })) }),
      history: async () => {
        throw Object.assign(new Error('missing'), { status: 404 });
      },
      sessionMeta: () => ({ pinned: false, archived: false, metaAt: 0 }),
      applySessionMeta: async () => false,
      setProjectSyncId: async (target, syncIdValue) => {
        projects.find((entry) => entry.cwd === target).syncId = syncIdValue;
      },
      applyProjectColor: async () => false,
    };
    const roadmap = createRoadmapService({
      resolveProject: async (target) => {
        if (target !== cwd) throw Object.assign(new Error('missing'), { status: 404 });
        return { cwd, name: 'project' };
      },
    });
    const sync = createConversationSync({ dataDir, sessionDir, store, objectStore, roadmap });
    return { cwd, roadmap, sync };
  }
  const left = await machine('left');
  const right = await machine('right');
  const config = {
    url: 'https://account.r2.cloudflarestorage.com/bucket',
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    passphrase: 'correct horse battery staple',
  };
  await left.sync.configure({ ...config, device: 'Studio left' });
  await right.sync.configure({ ...config, device: 'Studio right' });
  await left.roadmap.mutate(left.cwd, { action: 'init', expectedRevision: 0 });
  const created = await left.roadmap.mutate(left.cwd, {
    action: 'plan.create',
    expectedRevision: 1,
    title: 'Shared plan',
  });
  const planId = created.plans[0].id;
  const first = await left.sync.run();
  assert.equal(first.lastSync.roadmapsSent, 1);
  await right.sync.run();
  const converged = await right.roadmap.read(right.cwd);
  assert.ok(
    converged.plans.some((plan) => plan.id === planId),
    'the shared plan arrives on the other instance',
  );
  assert.ok(calls.put > 0 && calls.get > 0, 'the exchange used the injected store');
});

test('roadmap step completion attributes the checking Studio and caller conversation', async (t) => {
  const f = await fixture(t);
  const { credential, machineId, projects } = await enableApi(f);
  const auth = bearer(credential);
  const projectId = projectIdFor(projects, f.cwd);

  const machine = await f.api('/api/v1/machine', { headers: auth });
  assert.equal(machine.status, 200);
  assert.equal(machine.json.machineId, machineId);

  let document = (await f.api(`/api/v1/projects/${projectId}/roadmap`, { headers: auth })).json.roadmap;
  document = (
    await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: { action: 'init', expectedRevision: document.revision },
      headers: auth,
    })
  ).json.roadmap;
  document = (
    await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: { action: 'plan.create', expectedRevision: document.revision, title: 'Deliver' },
      headers: auth,
    })
  ).json.roadmap;
  const planId = document.plans[0].id;
  for (const text of ['First task', 'Second task']) {
    document = (
      await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
        method: 'POST',
        body: { action: 'step.add', expectedRevision: document.revision, planId, text },
        headers: auth,
      })
    ).json.roadmap;
  }
  const firstStepId = document.plans[0].steps[0].id;
  const secondStepId = document.plans[0].steps[1].id;

  // Check with a caller conversation: the Studio reports its own machine plus the caller.
  document = (
    await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: {
        action: 'step.check',
        expectedRevision: document.revision,
        planId,
        stepId: firstStepId,
        done: true,
        sessionId: 'native-session',
      },
      headers: auth,
    })
  ).json.roadmap;
  let first = document.plans[0].steps.find((step) => step.id === firstStepId);
  assert.equal(first.done, true);
  assert.ok(first.completion, 'done steps carry server-owned completion');
  assert.equal(first.completion.machineId, machineId);
  assert.equal(first.completion.sessionId, 'native-session');
  assert.ok(Number.isSafeInteger(first.completion.completedAt) && first.completion.completedAt > 0);
  const firstCompletedAt = first.completion.completedAt;

  // Readback returns the same attribution.
  const readback = (await f.api(`/api/v1/projects/${projectId}/roadmap`, { headers: auth })).json.roadmap;
  const readbackFirst = readback.plans[0].steps.find((step) => step.id === firstStepId);
  assert.deepEqual(readbackFirst.completion, first.completion);

  // Persistence across restart: the file holds the same attribution.
  const stored = JSON.parse(await readFile(join(f.cwd, '.prime', 'studio', 'roadmap.json'), 'utf8'));
  const storedPlan = stored.plans.find((plan) => plan.id === planId);
  const storedFirst = storedPlan.steps.find((step) => step.id === firstStepId);
  assert.deepEqual(storedFirst.completion, first.completion);

  // Actual restart with the same directories keeps the attribution.
  await f.app.close();
  const runtime2 = fakeRuntime();
  const live2 = liveStub();
  const app2 = createApp({
    agentHome: f.agentHome,
    sessionDir: f.sessionDir,
    dataDir: f.dataDir,
    initialCwd: f.cwd,
    runtime: runtime2,
    liveClient: live2,
  });
  await new Promise((done) => app2.server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    await app2.close().catch(() => {});
  });
  const port2 = app2.server.address().port;
  const base2 = `http://127.0.0.1:${port2}`;
  async function api2(path, { method = 'GET', body, rawBody, headers = {} } = {}) {
    const payload = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
    const response = await fetch(`${base2}${path}`, {
      method,
      headers: { ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: payload,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString('utf8');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      /* Non-JSON payload. */
    }
    return { status: response.status, headers: response.headers, text, json, buffer };
  }
  const afterRestart = (await api2(`/api/v1/projects/${projectId}/roadmap`, { headers: auth })).json.roadmap;
  const restartedFirst = afterRestart.plans[0].steps.find((step) => step.id === firstStepId);
  assert.deepEqual(restartedFirst.completion, first.completion);
  document = afterRestart;

  // Check without a caller conversation: machine is set, caller stays null.
  document = (
    await api2(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: { action: 'step.check', expectedRevision: document.revision, planId, stepId: secondStepId, done: true },
      headers: auth,
    })
  ).json.roadmap;
  const second = document.plans[0].steps.find((step) => step.id === secondStepId);
  assert.equal(second.done, true);
  assert.equal(second.completion.machineId, machineId);
  assert.equal(second.completion.sessionId, null);
  assert.ok(Number.isSafeInteger(second.completion.completedAt) && second.completion.completedAt > 0);

  // Reopen clears the attribution.
  document = (
    await api2(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: { action: 'step.check', expectedRevision: document.revision, planId, stepId: firstStepId, done: false },
      headers: auth,
    })
  ).json.roadmap;
  first = document.plans[0].steps.find((step) => step.id === firstStepId);
  assert.equal(first.done, false);
  assert.equal(first.completion, null);

  // Recheck creates a fresh attribution.
  document = (
    await api2(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: {
        action: 'step.check',
        expectedRevision: document.revision,
        planId,
        stepId: firstStepId,
        done: true,
        sessionId: 'native-session',
      },
      headers: auth,
    })
  ).json.roadmap;
  first = document.plans[0].steps.find((step) => step.id === firstStepId);
  assert.equal(first.completion.machineId, machineId);
  assert.equal(first.completion.sessionId, 'native-session');
  assert.ok(first.completion.completedAt >= firstCompletedAt);

  // Repeating the same done state preserves the attribution.
  const preserved = first.completion;
  document = (
    await api2(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: {
        action: 'step.check',
        expectedRevision: document.revision,
        planId,
        stepId: firstStepId,
        done: true,
        sessionId: 'native-session',
      },
      headers: auth,
    })
  ).json.roadmap;
  first = document.plans[0].steps.find((step) => step.id === firstStepId);
  assert.deepEqual(first.completion, preserved);
});

test('roadmap step.check validates the caller conversation and rejects forged completion', async (t) => {
  const f = await fixture(t, { secondProject: true });
  const { credential, projects } = await enableApi(f);
  const auth = bearer(credential);
  const projectId = projectIdFor(projects, f.cwd);

  let document = (await f.api(`/api/v1/projects/${projectId}/roadmap`, { headers: auth })).json.roadmap;
  document = (
    await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: { action: 'init', expectedRevision: document.revision },
      headers: auth,
    })
  ).json.roadmap;
  document = (
    await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: { action: 'plan.create', expectedRevision: document.revision, title: 'Deliver' },
      headers: auth,
    })
  ).json.roadmap;
  const planId = document.plans[0].id;
  document = (
    await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: { action: 'step.add', expectedRevision: document.revision, planId, text: 'Verify' },
      headers: auth,
    })
  ).json.roadmap;
  const stepId = document.plans[0].steps[0].id;
  const revision = document.revision;

  // A conversation from another project is rejected.
  const wrongProject = await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
    method: 'POST',
    body: {
      action: 'step.check',
      expectedRevision: revision,
      planId,
      stepId,
      done: true,
      sessionId: 'second-session',
    },
    headers: auth,
  });
  assert.equal(wrongProject.status, 404);

  // Unknown conversations are rejected the same way.
  const unknown = await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
    method: 'POST',
    body: {
      action: 'step.check',
      expectedRevision: revision,
      planId,
      stepId,
      done: true,
      sessionId: 'missing-session-1',
    },
    headers: auth,
  });
  assert.equal(unknown.status, 404);

  // Malformed caller identifiers are rejected as invalid requests.
  const malformed = await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
    method: 'POST',
    body: {
      action: 'step.check',
      expectedRevision: revision,
      planId,
      stepId,
      done: true,
      sessionId: 'bad id!',
    },
    headers: auth,
  });
  assert.equal(malformed.status, 400);

  // sessionId on other actions keeps its existing meaning and stays rejected.
  const misplaced = await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
    method: 'POST',
    body: { action: 'vision', expectedRevision: revision, text: 'v', sessionId: 'native-session' },
    headers: auth,
  });
  assert.equal(misplaced.status, 400);

  // Forged completion, machineId and completedAt are rejected, top-level and nested.
  for (const body of [
    { action: 'step.check', expectedRevision: revision, planId, stepId, done: true, completion: null },
    { action: 'step.check', expectedRevision: revision, planId, stepId, done: true, machineId: 'm' },
    {
      action: 'step.check',
      expectedRevision: revision,
      planId,
      stepId,
      done: true,
      sessionId: 'native-session',
      completion: { machineId: 'm', sessionId: null, completedAt: 1 },
    },
    {
      action: 'plan.create',
      expectedRevision: revision,
      title: 'Spoof',
      steps: [{ text: 'hi', completion: null }],
    },
    {
      action: 'plan.steps',
      expectedRevision: revision,
      planId,
      steps: [{ id: stepId, text: 'hi', done: false, children: [], completedAt: 5 }],
    },
    { action: 'backlog.add', expectedRevision: revision, items: [{ text: 'hi', machineId: 'm' }] },
  ]) {
    const spoofed = await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body,
      headers: auth,
    });
    assert.equal(spoofed.status, 400, JSON.stringify(body));
  }

  // The rejected attempts changed nothing.
  const unchanged = (await f.api(`/api/v1/projects/${projectId}/roadmap`, { headers: auth })).json.roadmap;
  assert.equal(unchanged.revision, revision);
  assert.equal(unchanged.plans[0].steps[0].done, false);
});

test('read-only tokens still read roadmaps but never check steps', async (t) => {
  const f = await fixture(t);
  const full = await enableApi(f, { name: 'full' });
  const admin = await f.api('/api/public-api');
  const projectId = projectIdFor(admin.json.projects, f.cwd);
  const reader = await f.api('/api/public-api/tokens', {
    method: 'POST',
    body: { name: 'reader', scopes: ['read'], projectIds: [projectId], revision: admin.json.revision },
  });
  assert.equal(reader.status, 201);
  const readAuth = bearer(reader.json.credential);
  const writeAuth = bearer(full.credential);

  let document = (await f.api(`/api/v1/projects/${projectId}/roadmap`, { headers: writeAuth })).json.roadmap;
  document = (
    await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: { action: 'init', expectedRevision: document.revision },
      headers: writeAuth,
    })
  ).json.roadmap;
  document = (
    await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: { action: 'plan.create', expectedRevision: document.revision, title: 'Deliver' },
      headers: writeAuth,
    })
  ).json.roadmap;
  const planId = document.plans[0].id;
  document = (
    await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
      method: 'POST',
      body: { action: 'step.add', expectedRevision: document.revision, planId, text: 'Verify' },
      headers: writeAuth,
    })
  ).json.roadmap;
  const stepId = document.plans[0].steps[0].id;

  assert.equal((await f.api(`/api/v1/projects/${projectId}/roadmap`, { headers: readAuth })).status, 200);
  const denied = await f.api(`/api/v1/projects/${projectId}/roadmap/mutations`, {
    method: 'POST',
    body: {
      action: 'step.check',
      expectedRevision: document.revision,
      planId,
      stepId,
      done: true,
      sessionId: 'native-session',
    },
    headers: readAuth,
  });
  assert.equal(denied.status, 403);
  const current = (await f.api(`/api/v1/projects/${projectId}/roadmap`, { headers: writeAuth })).json.roadmap;
  assert.equal(current.plans[0].steps[0].done, false);
});
