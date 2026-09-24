import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createStore } from '../lib/store.mjs';

const IMAGE = Buffer.from('prefs-screenshot').toString('base64');

function fakeComputerDriver() {
  const driver = {
    async request(command) {
      if (command.method === 'status') return { supported: true, platform: 'win32' };
      if (command.method === 'windows') return { windows: [] };
      if (command.method === 'observe')
        return {
          image: { data: IMAGE, mimeType: 'image/png' },
          frame: { width: 200, height: 150, bounds: { x: 0, y: 0, width: 200, height: 150 }, capturedAt: 't' },
        };
      if (command.method === 'act') return { executed: command.params.actions.length };
      throw new Error(`unexpected ${command.method}`);
    },
    async stop() {},
    async close() {},
  };
  return driver;
}

function fakeRuntime(models = null) {
  const controls = [];
  const catalog =
    models ||
    ({
      models: [
        { id: 'openai/gpt-5.6-luna', name: 'Luna', provider: 'openai', input: ['text', 'image'] },
        { id: 'openai/other-vision', name: 'Other', provider: 'openai', input: ['text', 'image'] },
      ],
      default: { model: 'openai/gpt-5.6-luna', thinking: 'medium' },
    });
  return {
    controls,
    async getStatus() {
      return { available: true, version: 'fixture', nodeVersion: process.versions.node };
    },
    async getModels() {
      return catalog;
    },
    async start(input) {
      let finishDone;
      const done = new Promise((resolveDone) => {
        finishDone = resolveDone;
      });
      const control = {
        input,
        done,
        finish(result = { status: 'completed', code: 0 }) {
          input.onEvent({ kind: 'done', ...result });
          finishDone(result);
        },
        async cancel() {
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
  const root = await mkdtemp(join(tmpdir(), 'prime-computer-prefs-'));
  const cwd = join(root, 'project');
  const sessionDir = join(root, 'sessions');
  const dataDir = join(root, 'local');
  const agentHome = join(root, 'agent');
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(agentHome)]);
  const runtime = extraOptions.runtime || fakeRuntime();
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
  function api(path, { method = 'GET', body } = {}) {
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
            } catch {}
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

async function storeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-prefs-store-'));
  const options = {
    sessionDir: join(root, 'sessions'),
    dataDir: join(root, 'local'),
    initialCwd: join(root, 'project'),
  };
  await Promise.all([mkdir(options.sessionDir), mkdir(options.initialCwd)]);
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return createStore(options);
}

test('studio preferences default to the native engine and the conversation model', async (t) => {
  const store = await storeFixture(t);
  const prefs = await store.getStudioPreferences();
  assert.equal(prefs.computerBackend, 'native');
  assert.equal(prefs.computerModel, '');
  assert.equal(prefs.allowQuestionsByDefault, true);
});

test('studio preferences store partial backend and model patches', async (t) => {
  const store = await storeFixture(t);
  const first = await store.setStudioPreferences({ computerBackend: 'cua' });
  assert.equal(first.computerBackend, 'cua');
  assert.equal(first.allowQuestionsByDefault, true);
  const second = await store.setStudioPreferences({ computerModel: 'openai/other-vision' });
  assert.equal(second.computerModel, 'openai/other-vision');
  assert.equal(second.computerBackend, 'cua');
  const third = await store.setStudioPreferences({ allowQuestionsByDefault: false });
  assert.equal(third.allowQuestionsByDefault, false);
  assert.equal(third.computerBackend, 'cua');
});

test('studio preferences reject invalid backend and model values', async (t) => {
  const store = await storeFixture(t);
  await assert.rejects(() => store.setStudioPreferences({ computerBackend: 'remote' }), { status: 400 });
  await assert.rejects(() => store.setStudioPreferences({ computerModel: 42 }), { status: 400 });
  await assert.rejects(() => store.setStudioPreferences({ unknown: true }), { status: 400 });
  await assert.rejects(() => store.setStudioPreferences({}), { status: 400 });
});

test('PATCH native backend succeeds and unknown backends fail', async (t) => {
  const { api } = await fixture(t);
  const ok = await api('/api/studio-preferences', { method: 'PATCH', body: { computerBackend: 'native' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.computerBackend, 'native');
  const bad = await api('/api/studio-preferences', { method: 'PATCH', body: { computerBackend: 'remote' } });
  assert.equal(bad.status, 400);
});

test('PATCH cua without an available driver fails closed', async (t) => {
  const { api } = await fixture(t, {
    computerBackends: [
      { id: 'native', supported: true, available: true },
      { id: 'cua', supported: true, available: false, reason: 'Missing test driver.' },
    ],
  });
  const res = await api('/api/studio-preferences', { method: 'PATCH', body: { computerBackend: 'cua' } });
  assert.equal(res.status, 409);
  assert.equal((await api('/api/studio-preferences')).json.computerBackend, 'native');
});

test('PATCH cua succeeds when the backend is available', async (t) => {
  const { api } = await fixture(
    t,
    {
      computerBackends: [
        { id: 'native', supported: true, available: true },
        { id: 'cua', supported: true, available: true },
      ],
    },
  );
  const res = await api('/api/studio-preferences', { method: 'PATCH', body: { computerBackend: 'cua' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.computerBackend, 'cua');
});

test('PATCH computer model validates catalog, availability and images', async (t) => {
  const { api } = await fixture(t);
  const empty = await api('/api/studio-preferences', { method: 'PATCH', body: { computerModel: '' } });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.computerModel, '');
  const unknown = await api('/api/studio-preferences', {
    method: 'PATCH',
    body: { computerModel: 'nope/missing' },
  });
  assert.equal(unknown.status, 400);
  const vision = await api('/api/studio-preferences', {
    method: 'PATCH',
    body: { computerModel: 'openai/other-vision' },
  });
  assert.equal(vision.status, 200);
  assert.equal(vision.json.computerModel, 'openai/other-vision');
});

test('PATCH computer model refuses text-only models', async (t) => {
  const runtime = fakeRuntime({
    models: [
      { id: 'text/only', name: 'Only', provider: 'text', input: ['text'] },
      { id: 'openai/gpt-5.6-luna', name: 'Luna', provider: 'openai', input: ['text', 'image'] },
    ],
    default: { model: 'openai/gpt-5.6-luna', thinking: 'medium' },
  });
  const { api } = await fixture(t, { runtime });
  const res = await api('/api/studio-preferences', { method: 'PATCH', body: { computerModel: 'text/only' } });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /image/i);
});

test('runs with desktop authorized use the global computer model', async (t) => {
  const { api, runtime, cwd } = await fixture(t);
  const saved = await api('/api/studio-preferences', {
    method: 'PATCH',
    body: { computerModel: 'openai/other-vision' },
  });
  assert.equal(saved.status, 200);
  const started = await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi', computerUse: true } });
  assert.equal(started.status, 201);
  assert.equal(started.json.model, 'openai/other-vision');
  assert.equal(started.json.computerUse, true);
  assert.equal(runtime.controls[0].input.model, 'openai/other-vision');
  runtime.controls[0].finish();
});

test('runs without desktop keep the conversation model', async (t) => {
  const { api, runtime, cwd } = await fixture(t);
  await api('/api/studio-preferences', { method: 'PATCH', body: { computerModel: 'openai/other-vision' } });
  const started = await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi' } });
  assert.equal(started.status, 201);
  assert.equal(started.json.model, 'openai/gpt-5.6-luna');
  runtime.controls[0].finish();
});

test('enabling without a backend uses the global engine', async (t) => {
  const { api, cwd } = await fixture(
    t,
    {
      computerBackends: [
        { id: 'native', supported: true, available: true },
        { id: 'cua', supported: true, available: true },
      ],
    },
  );
  const saved = await api('/api/studio-preferences', { method: 'PATCH', body: { computerBackend: 'cua' } });
  assert.equal(saved.status, 200);
  const started = await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi', computerUse: true } });
  assert.equal(started.status, 201);
  const status = await api(`/api/computer-use?runId=${started.json.id}`);
  assert.equal(status.json.backend, 'cua');
});

test('a stored text-only computer model fails the run with a clear error, never a silent switch', async (t) => {
  const runtime = fakeRuntime({
    models: [
      { id: 'text/only', name: 'Only', provider: 'text', input: ['text'] },
      { id: 'openai/gpt-5.6-luna', name: 'Luna', provider: 'openai', input: ['text', 'image'] },
    ],
    default: { model: 'openai/gpt-5.6-luna', thinking: 'medium' },
  });
  const { app, api, cwd } = await fixture(t, { runtime });
  await app.store.setStudioPreferences({ computerModel: 'text/only' });
  const started = await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi', computerUse: true } });
  assert.equal(started.status, 400);
  assert.match(started.json.error, /image/i);
  assert.equal(runtime.controls.length, 0);
});

test('a stored unknown computer model fails the run instead of falling back', async (t) => {
  const { app, api, cwd } = await fixture(t);
  await app.store.setStudioPreferences({ computerModel: 'nope/missing' });
  const started = await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi', computerUse: true } });
  assert.equal(started.status, 400);
  const plain = await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi' } });
  assert.equal(plain.status, 201);
  assert.equal(plain.json.model, 'openai/gpt-5.6-luna');
});

test('a stored unavailable computer model fails the run with 409', async (t) => {
  const runtime = fakeRuntime({
    models: [
      { id: 'gone/model', name: 'Gone', provider: 'gone', input: ['text', 'image'], availability: 'unavailable' },
      { id: 'openai/gpt-5.6-luna', name: 'Luna', provider: 'openai', input: ['text', 'image'] },
    ],
    default: { model: 'openai/gpt-5.6-luna', thinking: 'medium' },
  });
  const { app, api, cwd } = await fixture(t, { runtime });
  await app.store.setStudioPreferences({ computerModel: 'gone/model' });
  const started = await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi', computerUse: true } });
  assert.equal(started.status, 409);
  assert.equal(runtime.controls.length, 0);
});

test('backend changes are refused while the desktop is owned', async (t) => {
  const { api, runtime, cwd } = await fixture(
    t,
    {
      computerBackends: [
        { id: 'native', supported: true, available: true },
        { id: 'cua', supported: true, available: true },
      ],
    },
  );
  const started = await api('/api/runs', { method: 'POST', body: { cwd, message: 'hi', computerUse: true } });
  assert.equal(started.status, 201);
  const refused = await api('/api/studio-preferences', {
    method: 'PATCH',
    body: { computerBackend: 'cua' },
  });
  assert.equal(refused.status, 409);
  runtime.controls[0].finish();
  const after = await api('/api/studio-preferences', {
    method: 'PATCH',
    body: { computerBackend: 'cua' },
  });
  assert.equal(after.status, 200);
});
