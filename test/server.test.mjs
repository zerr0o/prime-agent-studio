import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG_BASE64 } from '../scripts/fixtures/pixel.mjs';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { commandCatalog } from '../lib/commands.mjs';
import { cwdKey } from '../lib/store.mjs';

const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

test('voice routes keep origin protections, read Preferences and never start a model turn', async (t) => {
  const calls = [];
  const voiceDir = await mkdtemp(join(tmpdir(), 'studio-voice-server-'));
  t.after(() => rm(voiceDir, { recursive: true, force: true }));
  await writeFile(
    join(voiceDir, 'auth.json'),
    JSON.stringify({ groq: { type: 'api_key', key: 'voice-fixture-secret' } }),
  );
  const f = await fixture(t, {
    voice: {
      dataDir: voiceDir,
      agentHome: voiceDir,
      env: {},
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return Response.json({ text: 'A synthetic voice prompt.' });
      },
    },
  });
  assert.equal((await f.api('/api/voice')).json.enabled, false);
  const settings = await f.api('/api/voice/settings', { method: 'PATCH', body: { provider: 'groq' } });
  assert.equal(settings.status, 200, settings.text);
  assert.equal(settings.json.keySource, 'providers');
  assert.equal(
    (await f.api('/api/voice/settings', { method: 'PATCH', body: { provider: 'x' } })).status,
    400,
  );
  const status = await f.api('/api/voice');
  assert.equal(status.status, 200);
  assert.equal(status.json.enabled, true);
  assert.doesNotMatch(status.text + settings.text, /voice-fixture-secret|api\.groq\.com/);
  const rawBody = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32)]);
  const request = { method: 'POST', rawBody, headers: { 'Content-Type': 'audio/ogg' } };
  for (const headers of [
    { Origin: 'https://untrusted.example' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { Host: 'untrusted.example' },
  ]) {
    assert.equal(
      (await f.api('/api/voice/transcribe', { ...request, headers: { ...request.headers, ...headers } }))
        .status,
      403,
    );
    assert.equal(
      (await f.api('/api/voice/settings', { method: 'PATCH', body: { provider: '' }, headers })).status,
      403,
    );
  }
  assert.equal(calls.length, 0);
  assert.equal((await f.api('/api/voice/transcribe')).status, 405);
  const response = await f.api('/api/voice/transcribe', request);
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, { text: 'A synthetic voice prompt.' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer voice-fixture-secret');
  assert.equal(f.runtime.controls.length, 0);
  assert.equal((await f.api('/api/voice/transcribe/other', request)).status, 404);
});

test('server health and system settings report the packaged release version', async (t) => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const { api } = await fixture(t);
  assert.equal((await api('/api/health')).json.version, version);
  assert.equal((await api('/api/system')).json.studio, version);
});

test('retired model choices are rejected for messages and defaults without switching to a paid model', async (t) => {
  const runtime = fakeRuntime();
  runtime.getModels = async () => ({
    models: [
      { id: 'openrouter/minimax/minimax-m3:free', provider: 'openrouter', availability: 'unavailable' },
      { id: 'openrouter/minimax/minimax-m3', provider: 'openrouter', availability: 'available' },
    ],
    default: { model: 'openrouter/minimax/minimax-m3:free' },
  });
  const f = await fixture(t, { runtime });
  for (const model of ['', 'openrouter/minimax/minimax-m3:free']) {
    const result = await f.api('/api/runs', { method: 'POST', body: { cwd: f.cwd, message: 'Test', model } });
    assert.equal(result.status, 409);
    assert.equal(runtime.controls.length, 0);
  }
  const changed = await f.api('/api/model-defaults', {
    method: 'POST',
    body: { model: 'openrouter/minimax/minimax-m3:free' },
  });
  assert.equal(changed.status, 409);
  const data = (await f.api('/api/subagent-defaults')).json;
  const child = await f.api('/api/subagent-defaults', {
    method: 'POST',
    body: {
      revision: data.revision,
      policy: { model: 'openrouter/minimax/minimax-m3:free', thinking: '' },
    },
  });
  assert.equal(child.status, 409);
  const paid = await f.api('/api/runs', {
    method: 'POST',
    body: { cwd: f.cwd, message: 'Explicit paid choice', model: 'openrouter/minimax/minimax-m3' },
  });
  assert.equal(paid.status, 201);
  assert.equal(runtime.controls[0].input.model, 'openrouter/minimax/minimax-m3');
});

test('native image settings reject text-only and unavailable models without changing Computer Use', async (t) => {
  const runtime = fakeRuntime();
  runtime.getModels = async () => ({
    models: [
      { id: 'test/vision', input: ['text', 'image'], availability: 'available' },
      { id: 'test/text', input: ['text'], availability: 'available' },
      { id: 'test/unavailable', input: ['image'], availability: 'unavailable' },
    ],
  });
  const f = await fixture(t, { runtime });
  for (const [imageModel, status] of [
    ['test/text', 400],
    ['text', 400],
    ['test/missing', 400],
    ['test/unavailable', 409],
  ]) {
    const result = await f.api('/api/engine-settings', { method: 'POST', body: { imageModel } });
    assert.equal(result.status, status, result.text);
  }
  const empty = (await f.api('/api/engine-settings')).json;
  assert.equal(empty.revision, null);
  const saved = await f.api('/api/engine-settings', {
    method: 'POST',
    body: {
      revision: empty.revision,
      imageModel: 'test/vision',
      defaultServiceTier: 'flex',
    },
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.imageModel, 'test/vision');
  assert.equal(saved.json.defaultServiceTier, 'flex');
  assert.equal(runtime.controls.length, 0, 'Saving defaults does not start a run');
  const raw = JSON.parse(await readFile(join(f.agentHome, 'settings.json'), 'utf8'));
  assert.equal('computerModel' in raw, false);
  assert.equal('computerImageModel' in raw, false);
  const cleared = await f.api('/api/engine-settings', {
    method: 'POST',
    body: {
      revision: saved.json.revision,
      imageModel: null,
      defaultServiceTier: null,
    },
  });
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal(cleared.json.imageModel, '');
  assert.equal(cleared.json.defaultServiceTier, 'default');
});

test('image turns ride a usable native imageModel without replacing the conversation model', async (t) => {
  const png = PNG_BASE64;
  const textId = 'test/text',
    visionId = 'test/vision';
  const runtime = fakeRuntime();
  runtime.getModels = async () => ({
    models: [
      { id: visionId, input: ['text', 'image'], availability: 'available' },
      { id: textId, input: ['text'], availability: 'available' },
    ],
    default: { model: textId },
  });
  const f = await fixture(t, { runtime });
  const images = [{ type: 'image', mimeType: 'image/png', data: png }];
  const refused = await f.run({ model: textId, message: 'Look', images });
  assert.equal(refused.status, 400);
  assert.equal(runtime.controls.length, 0, 'Refused images start no run');
  assert.equal((await f.api('/api/models')).json.imageModel, null);
  const saved = await f.api('/api/engine-settings', { method: 'POST', body: { imageModel: visionId } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await f.api('/api/models')).json.imageModel, visionId);
  const admitted = await f.run({ model: textId, message: 'Look', images });
  assert.equal(admitted.status, 201, admitted.text);
  assert.equal(runtime.controls.length, 1);
  assert.equal(runtime.controls[0].input.model, textId, 'Conversation model is preserved');
  assert.deepEqual(runtime.controls[0].input.images, images, 'Image payload is preserved');
  // Stale config: the vision model leaves the catalog, so the route closes again.
  runtime.getModels = async () => ({
    models: [{ id: textId, input: ['text'], availability: 'available' }],
    default: { model: textId },
  });
  assert.equal((await f.api('/api/models/refresh', { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.api('/api/models')).json.imageModel, null);
  const stale = await f.run({ model: textId, message: 'Look', images });
  assert.equal(stale.status, 400);
  assert.equal(runtime.controls.length, 1, 'Stale config starts no run and the native error stays visible');
});

test('Rust admission saves files and allows a configured native image route', async (t) => {
  const runtime = fakeRuntime();
  runtime.engine = 'rust';
  runtime.getModels = async () => ({
    models: [
      { id: 'test/text', provider: 'test', input: ['text'], availability: 'available' },
      { id: 'test/vision', provider: 'test', input: ['text', 'image'], availability: 'available' },
    ],
    default: { model: 'test/text', thinking: 'low' },
  });
  const f = await fixture(t, { runtime });
  const file = await f.run({
    message: 'Read the attachment',
    files: [{ name: 'notes.txt', data: Buffer.from('A bounded test attachment').toString('base64') }],
  });
  assert.equal(file.status, 201, file.text);
  const match = runtime.controls[0].input.message.match(
    /<prime_studio_files>\n([^\n]+)\n<\/prime_studio_files>/,
  );
  assert.ok(match);
  const [saved] = JSON.parse(match[1]);
  assert.equal(saved.name, 'notes.txt');
  assert.equal(saved.size, 25);
  assert.equal(await readFile(saved.path, 'utf8'), 'A bounded test attachment');
  const images = [{ type: 'image', mimeType: 'image/png', data: PNG_BASE64 }];
  assert.equal((await f.run({ model: 'test/text', message: 'Look', images })).status, 400);
  assert.equal(
    (await f.api('/api/engine-settings', { method: 'POST', body: { imageModel: 'test/vision' } })).status,
    200,
  );
  const routed = await f.run({ model: 'test/text', message: 'Look', images });
  assert.equal(routed.status, 201, routed.text);
  assert.equal(runtime.controls[1].input.model, 'test/text');
  assert.deepEqual(runtime.controls[1].input.images, images);
});

test('service-tier-only settings do not depend on the model catalog', async (t) => {
  const runtime = fakeRuntime();
  runtime.getModels = async () => {
    throw new Error('catalog offline');
  };
  const f = await fixture(t, { runtime });
  const saved = await f.api('/api/engine-settings', { method: 'POST', body: { defaultServiceTier: 'auto' } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.defaultServiceTier, 'auto');
});

test('manual catalogue refresh and provider model failures invalidate the cached list', async (t) => {
  const runtime = fakeRuntime(),
    requests = [];
  const original = runtime.getModels;
  runtime.getModels = async (options) => {
    requests.push(options);
    return original();
  };
  const f = await fixture(t, { runtime });
  await f.api('/api/models');
  await f.api('/api/models');
  assert.equal(requests.length, 1);
  assert.equal((await f.api('/api/models/refresh', { method: 'POST', body: {} })).status, 200);
  assert.equal(requests.at(-1).refresh, true);
  const result = await f.api('/api/runs', { method: 'POST', body: { cwd: f.cwd, message: 'Test' } });
  assert.equal(result.status, 201);
  const before = requests.length;
  runtime.controls[0].finish({ status: 'failed', error: '404 This model is unavailable for free.' });
  await until(() => requests.length > before);
  assert.equal(requests.at(-1).refresh, true);
  assert.equal(runtime.controls.length, 1, 'No automatic retry with another model');
});

test('resource folders use the chosen scope and reject unknown sources, scopes and projects', async (t) => {
  const opened = [];
  const f = await fixture(t, {
    openDirectory: async (path) => {
      opened.push(path);
      return { opened: true };
    },
  });
  for (const source of ['skill', 'prompt'])
    for (const scope of ['global', 'project']) {
      const result = await f.api('/api/commands/open-directory', {
        method: 'POST',
        body: { cwd: f.cwd, source, scope, path: f.root },
      });
      assert.equal(result.status, 200, result.text);
      const path = join(
        scope === 'global' ? f.agentHome : join(f.cwd, '.prime', 'agent'),
        source === 'skill' ? 'skills' : 'prompts',
      );
      assert.equal(opened.at(-1), path);
      assert.deepEqual(await readdir(path), []);
    }
  for (const body of [
    { cwd: f.cwd, source: '../secrets', scope: 'global' },
    { cwd: f.cwd, source: 'skill', scope: '../other' },
    { cwd: f.root, source: 'skill', scope: 'project' },
  ])
    assert.ok((await f.api('/api/commands/open-directory', { method: 'POST', body })).status >= 400);
  assert.equal(opened.length, 4);
});

test('project picker returns a selection or cancellation without adding a project', async (t) => {
  let selection = null,
    picked;
  const f = await fixture(t, {
    directoryPicker: {
      pick: async (input) => {
        picked = input;
        return { cwd: selection };
      },
    },
  });
  const before = await f.app.store.overview();
  for (selection of [null, f.root]) {
    const result = await f.api('/api/projects/pick-directory', {
      method: 'POST',
      body: { cwd: f.cwd },
      headers: { 'Accept-Language': 'en' },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { cwd: selection });
    assert.equal(picked.cwd, f.cwd);
    assert.equal(picked.title, 'Choose the project folder');
    assert.ok(picked.signal instanceof AbortSignal);
    assert.equal(picked.signal.aborted, false, 'A completed response must not cancel its picker');
  }
  assert.deepEqual((await f.app.store.overview()).projects, before.projects);
});

test('disconnecting a project picker request cancels its helper and allows another request', async (t) => {
  const calls = [];
  const f = await fixture(t, {
    directoryPicker: {
      pick: async (input) => {
        calls.push(input);
        if (calls.length > 1) return { cwd: null };
        return new Promise((done) => {
          input.signal?.addEventListener('abort', () => done({ cwd: null }), { once: true });
        });
      },
    },
  });
  const payload = JSON.stringify({ cwd: f.cwd });
  const client = request({
    hostname: '127.0.0.1',
    port: f.port,
    path: '/api/projects/pick-directory',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  });
  client.on('error', () => {});
  t.after(() => client.destroy());
  client.end(payload);
  await until(() => calls.length === 1);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(calls[0].signal.aborted, false, 'Reading the request body must not cancel the picker');
  client.destroy();
  await until(() => calls[0].signal.aborted);
  const retry = await f.api('/api/projects/pick-directory', { method: 'POST', body: { cwd: f.cwd } });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.json, { cwd: null });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].signal, calls[1].signal);
  assert.equal(calls[1].signal.aborted, false);
});
async function until(check, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for the expected server state.');
}

function fakeRuntime() {
  const controls = [];
  let releaseStartup;
  const runtime = {
    controls,
    closeCalls: 0,
    modelCalls: 0,
    failNext: false,
    deferNext: false,
    async getStatus() {
      return { available: true, version: 'fixture', nodeVersion: process.versions.node };
    },
    async getModels() {
      runtime.modelCalls++;
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
      if (runtime.failNext) {
        runtime.failNext = false;
        throw new Error('Fixture startup failure');
      }
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
      if (runtime.deferNext) {
        runtime.deferNext = false;
        await new Promise((done) => {
          releaseStartup = done;
        });
      }
      return control;
    },
    releaseStartup() {
      releaseStartup?.();
    },
    async close() {
      runtime.closeCalls++;
      runtime.releaseStartup();
      await Promise.all(controls.map((control) => control.cancel()));
    },
  };
  return runtime;
}

async function fixture(t, extraOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-server-'));
  const cwd = join(root, 'project é');
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
        id: 'initial-message',
        parentId: null,
        message: { role: 'user', content: 'Existing conversation' },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
  );
  const runtime = extraOptions.runtime || fakeRuntime();
  const app = createApp({ agentHome, sessionDir, dataDir, initialCwd: cwd, runtime, ...extraOptions });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  let closed = false;
  async function close() {
    if (!closed) {
      closed = true;
      await app.close();
    }
  }
  t.after(async () => {
    await close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function api(path, { method = 'GET', body, rawBody, headers = {} } = {}) {
    return new Promise((done, reject) => {
      const payload = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
      const outgoing = {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      };
      const req = request({ hostname: '127.0.0.1', port, path, method, headers: outgoing }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('error', reject);
        response.on('end', () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            /* Static/SSE response. */
          }
          done({ status: response.statusCode, headers: response.headers, text, json });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  async function run(body = {}) {
    return api('/api/runs', { method: 'POST', body: { cwd, message: 'Fixture prompt', ...body } });
  }
  async function sse(runId) {
    return new Promise((done, reject) => {
      const events = [];
      const req = request({ hostname: '127.0.0.1', port, path: `/api/runs/${runId}/events` }, (response) => {
        let pending = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          pending += chunk;
          let boundary;
          while ((boundary = pending.indexOf('\n\n')) !== -1) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const data = frame.split('\n').find((line) => line.startsWith('data: '));
            if (data) events.push(JSON.parse(data.slice(6)));
          }
        });
        response.on('error', () => {});
        done({ req, response, events });
      });
      req.on('error', reject);
      req.end();
    });
  }
  return { root, cwd, agentHome, sessionDir, runtime, app, port, api, run, sse, close };
}

function decodeEvents(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

test('slash API rejects terminal, unknown and malformed commands before a runtime can start', async (t) => {
  const catalog = commandCatalog({
    builtins: [{ name: 'goal' }, { name: 'share' }],
    commands: [{ name: 'skill:example', source: 'skill' }],
  });
  const f = await fixture(t, { commands: { list: async () => catalog } });
  assert.deepEqual(
    (await f.api(`/api/commands?cwd=${encodeURIComponent(f.cwd)}`)).json,
    JSON.parse(JSON.stringify(catalog)),
  );
  for (const message of ['/share', '/unknown', '/settings', '/goal status\nextra']) {
    assert.equal((await f.run({ message })).status, 400);
  }
  assert.equal(f.runtime.controls.length, 0);
  assert.equal((await f.run({ message: '/goal status' })).status, 201);
  assert.equal(f.runtime.controls[0].input.message, '/goal status');
});

test('native folder opening accepts unregistered folders and removal never stops an active agent', async (t) => {
  const opened = [];
  const f = await fixture(t, {
    openDirectory: async (cwd) => {
      opened.push(cwd);
      return { opened: true };
    },
  });
  assert.equal((await f.api('/api/projects/open', { method: 'POST', body: { cwd: f.root } })).status, 200);
  assert.deepEqual(opened, [await realpath(f.root)]);
  assert.equal((await f.api('/api/projects/open', { method: 'POST', body: { cwd: f.cwd } })).status, 200);
  assert.deepEqual(opened, [await realpath(f.root), await realpath(f.cwd)]);
  await f.run();
  assert.equal((await f.api('/api/projects', { method: 'DELETE', body: { cwd: f.cwd } })).status, 409);
  assert.equal(f.runtime.controls[0].cancelCalls, 0);
  f.runtime.controls[0].finish();
  assert.equal((await f.api('/api/runs')).json.runs.length, 0);
  assert.equal((await f.api('/api/projects', { method: 'DELETE', body: { cwd: f.cwd } })).status, 200);
  assert.equal((await f.api('/api/overview')).json.projects.length, 0);
  assert.equal((await f.api('/api/history?id=native-session')).status, 200);
});

test('native folder reveal works inside worktrees without requiring registration and rejects missing paths', async (t) => {
  const opened = [];
  const worktrees = {};
  const f = await fixture(t, {
    openDirectory: async (path) => {
      opened.push(path);
      return { opened: true };
    },
    worktrees,
  });
  const taskPath = join(f.root, 'managed', 'task-1');
  await mkdir(join(taskPath, 'docs'), { recursive: true });
  Object.assign(worktrees, {
    managedRoot: join(f.root, 'managed'),
    findByPath: async ({ path }) => (cwdKey(path) === cwdKey(taskPath) ? { id: 'task-1' } : null),
    inspect: async () => ({ worktree: { path: taskPath, projectCwd: f.cwd }, task: { id: 'task-1' } }),
  });
  assert.equal(
    (await f.api('/api/projects/open', { method: 'POST', body: { cwd: taskPath, path: 'docs' } })).status,
    200,
  );
  assert.deepEqual(opened, [await realpath(join(taskPath, 'docs'))]);
  assert.equal((await f.api('/api/projects/open', { method: 'POST', body: { cwd: taskPath } })).status, 200);
  assert.deepEqual(opened, [await realpath(join(taskPath, 'docs')), await realpath(taskPath)]);
  // Missing folders still fail without launching anything.
  assert.equal(
    (
      await f.api('/api/projects/open', {
        method: 'POST',
        body: { cwd: join(f.root, 'unknown'), path: 'docs' },
      })
    ).status,
    404,
  );
  assert.equal(opened.length, 2);
});

test('SSE disconnect preserves execution and Last-Event-ID replays only unseen events', async (t) => {
  const { app, runtime, api, run, sse } = await fixture(t);
  const started = await run();
  assert.equal(started.status, 201);
  const id = started.json.id;
  const control = runtime.controls[0];
  const stream = await sse(id);
  control.emit({ kind: 'session', sessionId: 'new-native-session' });
  control.emit({ kind: 'text', delta: 'First chunk' });
  await until(() => stream.events.length === 2);
  stream.req.destroy();
  await until(() => app.runs.get(id).clients.size === 0);
  assert.equal(control.cancelCalls, 0);
  assert.equal((await api('/api/runs')).json.runs[0].status, 'running');
  control.emit({ kind: 'text', delta: 'After disconnect' });
  control.finish();
  const replay = await api(`/api/runs/${id}/events`, { headers: { 'Last-Event-ID': '2' } });
  assert.match(replay.headers['content-type'], /text\/event-stream/);
  assert.deepEqual(
    decodeEvents(replay.text).map((event) => [event.seq, event.kind]),
    [
      [3, 'text'],
      [4, 'done'],
    ],
  );
  assert.equal((await api('/api/runs')).json.runs.length, 0);
  assert.equal(app.runs.get(id).status, 'completed');
  assert.equal(app.runs.get(id).clients.size, 0);
});

test('simultaneous resumes lock one native session and terminal completion releases it', async (t) => {
  const { runtime, api, run } = await fixture(t);
  const attempts = await Promise.all([
    run({ sessionId: 'native-session' }),
    run({ sessionId: 'native-session' }),
  ]);
  assert.deepEqual(attempts.map((result) => result.status).sort(), [201, 409]);
  assert.equal(runtime.controls.length, 1);
  assert.match(runtime.controls[0].input.sessionFile, /2026-native-session\.jsonl$/);
  runtime.controls[0].finish({ status: 'failed', code: 1, error: 'Fixture provider error' });
  assert.equal((await api('/api/runs')).json.runs.length, 0);
  assert.equal((await run({ sessionId: 'native-session' })).status, 201);
});

test('startup failure releases session ownership and done results finish a run without an emitted terminal event', async (t) => {
  const { app, runtime, run } = await fixture(t);
  runtime.failNext = true;
  const failed = await run({ sessionId: 'native-session' });
  assert.equal(failed.status, 503);
  assert.match(failed.json.error, /Fixture startup failure/);
  assert.equal(app.runs.size, 0);
  const retry = await run({ sessionId: 'native-session' });
  assert.equal(retry.status, 201);
  runtime.controls[0].finish({ status: 'failed', code: 1, error: 'Failure through done' }, false);
  await until(() => app.runs.get(retry.json.id).finished);
  assert.equal(app.runs.get(retry.json.id).error, 'Failure through done');
  assert.equal((await run({ sessionId: 'native-session' })).status, 201);
});

test('concurrent new-session requests cannot bypass the eight active run limit', async (t) => {
  const { runtime, run } = await fixture(t);
  const attempts = await Promise.all(Array.from({ length: 10 }, () => run()));
  assert.equal(attempts.filter((result) => result.status === 201).length, 8);
  assert.equal(attempts.filter((result) => result.status === 429).length, 2);
  assert.equal(runtime.controls.length, 8);
});

test('stop requested during asynchronous startup is honored once the handle is available', async (t) => {
  const { app, runtime, api, run } = await fixture(t);
  runtime.deferNext = true;
  const pending = run();
  await until(() => runtime.controls.length === 1);
  const id = [...app.runs.keys()][0];
  const stopping = api(`/api/runs/${id}/stop`, { method: 'POST' });
  await until(() => app.runs.get(id).status === 'stopping');
  runtime.releaseStartup();
  assert.equal((await pending).status, 201);
  assert.equal((await stopping).status, 200);
  await until(() => app.runs.get(id).finished);
  assert.equal(runtime.controls[0].cancelCalls, 1);
  assert.equal(app.runs.get(id).status, 'stopped');
});

test('request validation rejects incorrect types, traversal and a session from another folder', async (t) => {
  const { root, cwd, runtime, run, api } = await fixture(t);
  const invalid = [
    { cwd: 'relative' },
    { cwd: 2 },
    { cwd: join(root, 'missing') },
    { message: false },
    { message: '   ' },
    { model: {} },
    { model: 'bad\nmodel' },
    { thinking: {} },
    { thinking: false },
    { sessionId: '../secrets' },
    { sessionId: false },
    { sessionId: 0 },
  ];
  for (const body of invalid) assert.equal((await run(body)).status, 400, JSON.stringify(body));
  const other = join(root, 'other');
  await mkdir(other);
  assert.equal((await run({ cwd: other, sessionId: 'native-session' })).status, 409);
  assert.equal(runtime.controls.length, 0);
  assert.equal((await api('/api/history?id=..%2Fsecrets')).status, 400);
  assert.equal(
    (
      await api('/api/runs', {
        method: 'POST',
        rawBody: '[]',
        headers: { 'Content-Type': 'application/json' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api('/api/runs', {
        method: 'POST',
        rawBody: 'bad json',
        headers: { 'Content-Type': 'application/json' },
      })
    ).status,
    400,
  );
  assert.equal(
    (await api('/api/runs', { method: 'POST', rawBody: 'text', headers: { 'Content-Type': 'text/plain' } }))
      .status,
    415,
  );
  assert.equal(
    (await api('/api/runs', { method: 'POST', body: { cwd, message: 'x'.repeat(530000) } })).status,
    413,
  );
  assert.equal((await api('/api/projects', { method: 'POST', body: { cwd, pinned: 'yes' } })).status, 400);
});

test('model configuration and native main-agent default stay local, hide credentials and refresh the catalog', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/models')).status, 200);
  assert.equal(f.runtime.modelCalls, 1);

  const initial = await f.api('/api/model-config');
  assert.equal(initial.status, 200);
  assert.equal(initial.json.models.length, 0);
  assert.equal('presets' in initial.json, false);

  const configured = await f.api('/api/model-config', {
    method: 'POST',
    body: {
      provider: 'fixture-provider',
      providerName: 'Fixture provider',
      id: 'fixture-model',
      name: 'Fixture model',
      api: 'openai-responses',
      baseUrl: 'https://models.example.test/v1',
      credentialEnv: 'FIXTURE_API_KEY',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 128000,
      maxTokens: 16384,
    },
  });
  assert.equal(configured.status, 200);
  assert.equal(configured.json.models[0].id, 'fixture-model');
  assert.doesNotMatch(configured.text, /apiKey|fixture-secret/);
  assert.equal(f.runtime.modelCalls, 2);
  const modelsFile = JSON.parse(await readFile(join(f.agentHome, 'models.json'), 'utf8'));
  assert.equal(modelsFile.providers['fixture-provider'].apiKey, 'FIXTURE_API_KEY');

  const removed = await f.api('/api/model-config', {
    method: 'DELETE',
    body: { provider: 'fixture-provider', id: 'fixture-model' },
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.models.length, 0);
  assert.equal(f.runtime.modelCalls, 3);

  const defaults = await f.api('/api/model-defaults');
  assert.deepEqual(defaults.json, {
    mainModel: '',
    subagents: { mode: 'inherit', configurable: false },
  });
  const changed = await f.api('/api/model-defaults', {
    method: 'POST',
    body: { model: 'openai/gpt-5.6-luna' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.mainModel, 'openai/gpt-5.6-luna');
  assert.deepEqual(changed.json.subagents, { mode: 'inherit', configurable: false });
  assert.equal(f.runtime.modelCalls, 4);
  const settings = JSON.parse(await readFile(join(f.agentHome, 'settings.json'), 'utf8'));
  assert.equal(settings.defaultProvider, 'openai');
  assert.equal(settings.defaultModel, 'gpt-5.6-luna');

  const unavailable = await f.api('/api/model-defaults', {
    method: 'POST',
    body: { model: 'invented/not-real' },
  });
  assert.equal(unavailable.status, 400);

  const unsafe = await f.api('/api/model-config', {
    method: 'POST',
    body: {
      provider: 'unsafe',
      id: 'model',
      name: 'Unsafe',
      api: 'openai-responses',
      baseUrl: 'https://user:secret@example.test/v1',
      credentialEnv: 'UNSAFE_API_KEY',
      reasoning: false,
      input: ['text'],
      contextWindow: 1000,
      maxTokens: 100,
    },
  });
  assert.equal(unsafe.status, 400);
});

test('subagent settings validate catalog, thinking and project scope without changing native settings or stopping runs', async (t) => {
  const f = await fixture(t);
  const original = await readFile(join(f.agentHome, 'settings.json')).catch(() => null);
  let data = (await f.api('/api/subagent-defaults')).json;
  const request = (policy, extra = {}) =>
    f.api('/api/subagent-defaults', { method: 'POST', body: { revision: data.revision, policy, ...extra } });
  const policy = { model: 'openai/gpt-5.6-luna', thinking: 'high' };
  const changed = await request(policy);
  assert.equal(changed.status, 200);
  data = changed.json;
  assert.deepEqual(data.global, policy);
  assert.equal((await request({ ...policy, thinking: 'xhigh' })).status, 400);
  assert.equal((await request({ ...policy, model: 'unavailable/model' })).status, 400);
  assert.equal((await request(policy, { cwd: 12 })).status, 400);
  assert.equal((await request(policy, { cwd: join(f.cwd, 'unknown') })).status, 404);
  const custom = await request({ model: '', thinking: 'low' }, { cwd: f.cwd });
  assert.equal(custom.status, 200);
  data = custom.json;
  assert.deepEqual(data.effective, { model: '', thinking: 'low' });
  const clear = await request(null, { cwd: f.cwd });
  assert.deepEqual(clear.json.effective, policy);
  assert.equal(clear.json.project, null);
  assert.deepEqual(await readFile(join(f.agentHome, 'settings.json')).catch(() => null), original);
  assert.equal(f.runtime.controls.length, 0);
});

test('local API rejects hostile Host, Origin and cross-site requests while allowing its own origin', async (t) => {
  const { api, port } = await fixture(t);
  for (const headers of [
    { Host: 'attacker.example' },
    { Host: 'localhost.attacker.example' },
    { Origin: 'https://attacker.example' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { Host: `127.0.0.1:${port}`, Origin: 'null' },
  ])
    assert.equal((await api('/api/health', { headers })).status, 403);
  const valid = await api('/api/health', { headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(valid.status, 200);
  assert.equal(valid.json.service, 'prime-agent-gui');
  assert.equal(valid.headers['x-frame-options'], 'DENY');
  assert.match(valid.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('static allowlist keeps server code, settings and traversal targets private', async (t) => {
  const { api } = await fixture(t);
  for (const path of [
    '/server.mjs',
    '/lib/store.mjs',
    '/.local/workspace.json',
    '/scripts/start-server.mjs',
    '/node_modules/dompurify/package.json',
    '/public/%2e%2e%2fserver.mjs',
    '/public/..%5cserver.mjs',
    '/public/%00',
  ]) {
    assert.equal((await api(path)).status, 404, path);
  }
  const history = await api('/api/history?id=native-session');
  assert.equal(history.status, 200);
  assert.equal('file' in history.json, false);
  const head = await api('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
});

test('server close cancels owned executions and closes open SSE clients', async (t) => {
  const { runtime, app, run, sse, close } = await fixture(t);
  const started = await run();
  const stream = await sse(started.json.id);
  await close();
  assert.equal(runtime.closeCalls, 1);
  assert.equal(runtime.controls[0].cancelCalls, 1);
  assert.equal(app.runs.get(started.json.id).status, 'stopped');
  assert.equal(app.server.listening, false);
  await until(() => stream.response.destroyed || stream.response.complete);
});

test('commit message suggestion reaches the real worker over stdin and returns its text', async (t) => {
  // Fake engine package: same module paths the worker imports, no network, no key leak.
  const root = await mkdtemp(join(tmpdir(), 'studio-suggest-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, text) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  await write('package.json', '{"name":"prime-agent","version":"0.9.8"}');
  await write('dist/bundle/cli.js', '');
  await write('dist/core/auth-storage.js', 'export const AuthStorage = { create: () => ({}) };');
  await write(
    'dist/core/model-registry.js',
    `export const ModelRegistry = { create: () => ({
      getAvailable: () => [{ provider: 'fixture', id: 'writer' }],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'fixture-key', headers: {} }),
    }) };`,
  );
  await write(
    'node_modules/@earendil-works/pi-ai/dist/stream.js',
    `export async function completeSimple(model, context) {
      const sawDiff = context.messages[0].content[0].text.includes('package.json');
      return { stopReason: 'stop', content: [{ type: 'text', text: sawDiff ? 'chore: met à jour la version' : 'missing diff' }] };
    }`,
  );
  const previous = process.env.PRIME_AGENT_CLI;
  process.env.PRIME_AGENT_CLI = join(root, 'dist/bundle/cli.js');
  t.after(() => {
    if (previous === undefined) delete process.env.PRIME_AGENT_CLI;
    else process.env.PRIME_AGENT_CLI = previous;
  });
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'package.json'), '{"version":"1.0.0"}\n');
  const git = (args) =>
    new Promise((done, fail) =>
      execFile('git', args, { cwd: f.cwd, windowsHide: true }, (error) => (error ? fail(error) : done())),
    );
  await git(['init', '-q']);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const result = await f.api('/api/project-git/suggest-message', {
    method: 'POST',
    body: { cwd: f.cwd, paths: ['package.json'] },
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.message, 'chore: met à jour la version');
});

test('message folder reveal accepts outside references without widening content reads or bearer access', async (t) => {
  const opened = [];
  const f = await fixture(t, {
    openDirectory: async (path) => {
      opened.push(path);
      return { opened: true };
    },
  });
  const outside = join(f.root, 'outside notes');
  await mkdir(outside);
  const file = join(outside, 'private.txt');
  await writeFile(file, 'Outside content must not be served');
  for (const reference of [outside, file, '../outside notes/private.txt', f.agentHome]) {
    const result = await f.api('/api/projects/open', { method: 'POST', body: { cwd: f.cwd, reference } });
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.json, { opened: true });
  }
  assert.deepEqual(opened, [
    await realpath(outside),
    await realpath(outside),
    await realpath(outside),
    await realpath(f.agentHome),
  ]);
  const missing = await f.api('/api/projects/open', {
    method: 'POST',
    body: { reference: join(outside, 'absent') },
  });
  assert.equal(missing.status, 404);
  const resolved = await f.api(
    '/api/project-files/resolve?' + new URLSearchParams({ cwd: f.cwd, reference: file }),
  );
  assert.equal(resolved.status, 403);
  const preview = await f.api(
    '/api/project-files/preview?' + new URLSearchParams({ cwd: f.cwd, path: '../outside notes/private.txt' }),
  );
  assert.equal(preview.status, 403);
  const bearer = await f.api('/api/projects/open', {
    method: 'POST',
    headers: { Authorization: 'Bearer invalid-fixture-token' },
    body: { reference: file },
  });
  assert.equal(bearer.status, 401);
  assert.equal(opened.length, 4);
  assert.equal(f.runtime.controls.length, 0);
});

test('subagent general defaults validate model availability and thinking; legacy roles are stripped', async (t) => {
  const f = await fixture(t);
  const state = (await f.api('/api/subagent-defaults')).json;
  // General defaults are still validated.
  for (const policy of [
    { model: 'missing/model', thinking: '' },
    { model: 'openai/gpt-5.6-luna', thinking: 'xhigh' },
  ]) {
    const result = await f.api('/api/subagent-defaults', { method: 'POST', body: {
      revision: state.revision, policy,
    } });
    assert.equal(result.status, 400, result.text);
    assert.equal((await f.api('/api/subagent-defaults')).json.revision, state.revision);
  }
  // Legacy roles are accepted for compatibility but stripped on write and never applied.
  const legacy = await f.api('/api/subagent-defaults', { method: 'POST', body: {
    revision: state.revision,
    policy: { model: '', thinking: '', roles: { review: { model: 'missing/model' } } },
  } });
  assert.equal(legacy.status, 200, legacy.text);
  assert.deepEqual(legacy.json.global, { model: '', thinking: '' });
  assert.deepEqual(legacy.json.effective, { model: '', thinking: '' });
});

test('quota fallback preferences are validated and revision protected without starting a run', async (t) => {
  const f = await fixture(t);
  const initial = await f.api('/api/quota-fallback');
  assert.equal(initial.status, 200, initial.text);
  assert.equal(initial.json.automatic, false);
  const saved = await f.api('/api/quota-fallback', { method: 'PUT', body: {
    ...initial.json, models: ['openai/gpt-5.6-luna'], automatic: true,
  } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await f.api('/api/quota-fallback', { method: 'PUT', body: initial.json })).status, 409);
  assert.equal((await f.api('/api/quota-fallback', { method: 'PUT', body: {
    ...saved.json, models: ['missing/model'],
  } })).status, 400);
  assert.equal(f.runtime.controls.length, 0);
});

test('quota retry is an explicit new run in the same conversation, with no loop model mutation', async (t) => {
  const runtime = fakeRuntime();
  runtime.getModels = async () => ({ models: [
    { id: 'openai/source', thinkingLevels: ['off'] },
    { id: 'openai/gpt-5.6-luna', thinkingLevels: ['off'] },
  ], default: { model: 'openai/source' } });
  const f = await fixture(t, { runtime });
  const settings = (await f.api('/api/quota-fallback')).json;
  assert.equal((await f.api('/api/quota-fallback', { method: 'PUT', body: {
    ...settings, models: ['openai/gpt-5.6-luna'],
  } })).status, 200);
  const started = await f.run({ sessionId: 'native-session' });
  assert.equal(started.status, 201, started.text);
  runtime.controls[0].finish({ status: 'failed', code: 1, error: 'Quota exceeded', quota: {
    kind: 'usage_limit', resetAt: '2099-01-01T00:00:00.000Z',
    candidates: [{ model: 'openai/gpt-5.6-luna', automaticEligible: false }], automaticModel: null,
  } });
  const unconfirmed = await f.api(`/api/runs/${started.json.id}/quota-retry`, {
    method: 'POST', body: { model: 'openai/gpt-5.6-luna' },
  });
  assert.equal(unconfirmed.status, 409, unconfirmed.text);
  assert.equal(runtime.controls.length, 1, 'unknown billing requires explicit consent');
  const retry = await f.api(`/api/runs/${started.json.id}/quota-retry`, {
    method: 'POST', body: { model: 'openai/gpt-5.6-luna', confirmBillingChange: true },
  });
  assert.equal(retry.status, 201, retry.text);
  assert.notEqual(retry.json.id, started.json.id);
  assert.equal(retry.json.sessionId, 'native-session');
  assert.equal(runtime.controls.length, 2);
  assert.equal(runtime.controls[1].input.model, 'openai/gpt-5.6-luna');
  assert.equal((await f.api(`/api/runs/${started.json.id}/quota-retry`, {
    method: 'POST', body: { model: 'openai/gpt-5.6-luna' },
  })).status, 409);
});

test('automatic quota retry rechecks stored account and opt-in, and hands off the session lock', async (t) => {
  const runtime = fakeRuntime();
  runtime.getModels = async () => ({ models: [
    { id: 'openai-codex/source', thinkingLevels: ['off'] },
    { id: 'openai-codex/fallback', thinkingLevels: ['off'] },
  ], default: { model: 'openai-codex/source' } });
  const f = await fixture(t, { runtime });
  await writeFile(join(f.agentHome, 'auth.json'), JSON.stringify({
    'openai-codex': { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh' },
  }));
  const initial = (await f.api('/api/quota-fallback')).json;
  assert.equal((await f.api('/api/quota-fallback', { method: 'PUT', body: {
    ...initial, automatic: true, models: ['openai-codex/fallback'],
  } })).status, 200);
  const started = await f.run({ sessionId: 'native-session', model: 'openai-codex/source' });
  assert.equal(started.status, 201, started.text);
  const stream = await f.sse(started.json.id);
  runtime.controls[0].finish({ status: 'failed', code: 1, error: 'Quota exceeded', quota: {
    kind: 'usage_limit', candidates: [{ model: 'openai-codex/fallback', automaticEligible: true }],
    automaticModel: 'openai-codex/fallback',
  } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('quota stream did not finish')), 5000);
    stream.response.once('end', () => { clearTimeout(timer); resolve(); });
  });
  const done = stream.events.find((event) => event.kind === 'done');
  assert.ok(done.quota.retryRunId);
  assert.equal(runtime.controls.length, 2);
  assert.equal(runtime.controls[1].input.sessionId, 'native-session');
  assert.equal(runtime.controls[1].input.quotaAuthorization.targetModel, 'openai-codex/fallback');
  assert.equal((await f.run({ sessionId: 'native-session' })).status, 409, 'new run retains session lock');
});

test('automatic quota retry never trusts event eligibility without a proven account', async (t) => {
  const runtime = fakeRuntime();
  runtime.getModels = async () => ({ models: [
    { id: 'openai/source', thinkingLevels: ['off'] },
    { id: 'openai/paid', thinkingLevels: ['off'] },
  ], default: { model: 'openai/source' } });
  const f = await fixture(t, { runtime });
  const settings = (await f.api('/api/quota-fallback')).json;
  await f.api('/api/quota-fallback', { method: 'PUT', body: {
    ...settings, automatic: true, models: ['openai/paid'],
  } });
  const started = await f.run({ sessionId: 'native-session', model: 'openai/source' });
  const stream = await f.sse(started.json.id);
  runtime.controls[0].finish({ status: 'failed', code: 1, quota: {
    kind: 'usage_limit', automaticModel: 'openai/paid',
  } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('quota stream did not finish')), 5000);
    stream.response.once('end', () => { clearTimeout(timer); resolve(); });
  });
  assert.equal(runtime.controls.length, 1);
  const done = stream.events.find((event) => event.kind === 'done');
  assert.match(done.quota.retryError, /not authorized/);
  assert.equal(done.quota.retryRunId, undefined);
});

test('budgets settings require revision, registered projects and explicit daily scope', async (t) => {
  const f = await fixture(t);
  const state = await f.api('/api/budgets');
  assert.equal(state.status, 200, state.text);
  assert.equal(state.json.period, 'day');
  const saved = await f.api('/api/budgets', { method: 'PUT', body: {
    ...state.json, run: { tokens: 1000, estimatedCost: null },
    projects: { [f.cwd]: { tokens: 5000, estimatedCost: null } },
  } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await f.api('/api/budgets', { method: 'PUT', body: state.json })).status, 409);
  const invalid = await f.api('/api/budgets', { method: 'PUT', body: {
    ...saved.json, projects: { [join(f.root, 'unregistered')]: { tokens: 5000 } },
  } });
  assert.equal(invalid.status, 404, invalid.text);
  assert.equal(f.runtime.controls.length, 0);
  const run = await f.run({ allowQuestions: false });
  assert.equal(run.status, 201, run.text);
  assert.equal(f.runtime.controls[0].input.budget.tokens, 1000);
  assert.equal(f.runtime.controls[0].input.budget.project.tokens, 5000);
  assert.equal(f.runtime.controls[0].input.budget.allowQuestions, false);
});

test('quota retry cannot replace the failing run account snapshot during admission', async (t) => {
  const runtime = fakeRuntime();
  runtime.getModels = async () => ({ models: [
    { id: 'openai-codex/source', thinkingLevels: ['off'] },
    { id: 'openai-codex/fallback', thinkingLevels: ['off'] },
  ], default: { model: 'openai-codex/source' } });
  const f = await fixture(t, { runtime });
  await writeFile(join(f.agentHome, 'auth.json'), JSON.stringify({
    'openai-codex': { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh' },
  }));
  const initial = (await f.api('/api/quota-fallback')).json;
  assert.equal((await f.api('/api/quota-fallback', { method: 'PUT', body: {
    ...initial, automatic: true, models: ['openai-codex/fallback'],
  } })).status, 200);
  const started = await f.run({ sessionId: 'native-session', model: 'openai-codex/source' });
  assert.equal(started.status, 201, started.text);
  const stream = await f.sse(started.json.id);
  // The terminal event was prepared for account A. Deliver it after account B
  // is stored, as can happen between native completion and server admission.
  await writeFile(join(f.agentHome, 'auth.json'), JSON.stringify({
    'openai-codex': { type: 'oauth', access: 'OTHER-ACCOUNT', refresh: 'OTHER-REFRESH' },
  }));
  runtime.controls[0].finish({ status: 'failed', code: 1, error: 'Quota exceeded', quota: {
    kind: 'usage_limit', candidates: [{ model: 'openai-codex/fallback', automaticEligible: true }],
    automaticModel: 'openai-codex/fallback',
  } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('quota stream did not finish')), 5000);
    stream.response.once('end', () => { clearTimeout(timer); resolve(); });
  });
  const done = stream.events.find((event) => event.kind === 'done');
  assert.equal(runtime.controls.length, 1, 'must refuse account rotation after failure');
  assert.equal(started.json.quotaIdentity, undefined, 'identity proof remains private');
  const refused = await f.api(`/api/runs/${started.json.id}/quota-retry`, {
    method: 'POST', body: { model: 'openai-codex/fallback' },
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'quota_confirmation_required');
  assert.equal(runtime.controls.length, 1);
  const confirmed = await f.api(`/api/runs/${started.json.id}/quota-retry`, {
    method: 'POST', body: { model: 'openai-codex/fallback', confirmBillingChange: true },
  });
  assert.equal(confirmed.status, 201, confirmed.text);
  assert.equal(runtime.controls.length, 2);
  assert.equal(runtime.controls[1].input.quotaAuthorization, undefined, 'explicit cross-account consent is not an automatic identity grant');
});

test('quota retry refuses a model override instead of silently replacing the selected fallback', async (t) => {
  const runtime = fakeRuntime();
  runtime.getModels = async () => ({ models: [
    { id: 'openai/source', thinkingLevels: ['off'] },
    { id: 'openai/target', thinkingLevels: ['off'] },
    { id: 'openai/other', thinkingLevels: ['off'] },
  ], default: { model: 'openai/source' } });
  let replacement = null;
  const projectArchives = {
    recoverPending: async () => {},
    checkPastudioModelGate: async () => ({ gated: false, model: replacement }),
  };
  const f = await fixture(t, { runtime, projectArchives });
  const state = (await f.api('/api/quota-fallback')).json;
  await f.api('/api/quota-fallback', { method: 'PUT', body: { ...state, models: ['openai/target'] } });
  const started = await f.run({ sessionId: 'native-session', model: 'openai/source' });
  assert.equal(started.status, 201, started.text);
  runtime.controls[0].finish({ status: 'failed', code: 1, quota: { kind: 'usage_limit' } });
  replacement = 'openai/other';
  const retry = await f.api(`/api/runs/${started.json.id}/quota-retry`, { method: 'POST',
    body: { model: 'openai/target', confirmBillingChange: true },
  });
  assert.equal(retry.status, 409, retry.text);
  assert.equal(runtime.controls.length, 1, 'never start an unselected fallback');
});


test('Rust Computer Use status advertises its unsupported boundary without enabling control', async (t) => {
  const runtime = fakeRuntime();
  runtime.engine = 'rust';
  const f = await fixture(t, { runtime });
  const status = await f.api('/api/computer-use');
  assert.equal(status.status, 200, status.text);
  assert.equal(status.json.supported, false);
  assert.match(status.json.unsupportedReason, /official Rust daemon/);
  const grant = await f.api('/api/computer-use', { method: 'POST', body: { enabled: true } });
  assert.equal(grant.status, 409, grant.text);
  assert.equal(runtime.controls.length, 0);
});
