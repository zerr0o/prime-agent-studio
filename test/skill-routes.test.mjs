import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createLiveMessages } from '../lib/live-messages.mjs';

function fakeRuntime() {
  const controls = [];
  return {
    controls,
    async getStatus() {
      return { available: true, version: 'fixture' };
    },
    async getModels() {
      return {
        models: [{ id: 'fixture/luna', name: 'Luna', provider: 'fixture', input: ['text'] }],
        default: { model: 'fixture/luna' },
      };
    },
    async start(input) {
      const done = Promise.resolve({ status: 'completed', code: 0 });
      const control = {
        input,
        done,
        async cancel() {
          return done;
        },
      };
      controls.push(control);
      return control;
    },
    async close() {},
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-skill-routes-'));
  const cwd = join(root, 'project');
  const sessionDir = join(root, 'sessions');
  const dataDir = join(root, 'local');
  const agentHome = join(root, 'agent');
  const skillDirA = join(cwd, '.prime', 'agent', 'skills', 'alpha');
  const skillDirB = join(cwd, '.prime', 'agent', 'skills', 'beta');
  await Promise.all([
    mkdir(skillDirA, { recursive: true }),
    mkdir(skillDirB, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
    mkdir(agentHome, { recursive: true }),
  ]);
  await writeFile(
    join(skillDirA, 'SKILL.md'),
    '---\nname: alpha\ndescription: Alpha skill\n---\nAlpha instructions.',
  );
  await writeFile(
    join(skillDirB, 'SKILL.md'),
    '---\nname: beta\ndescription: Beta skill\n---\nBeta instructions.',
  );
  const catalog = {
    commands: [
      {
        name: 'skill:alpha',
        source: 'skill',
        supported: true,
        sourceInfo: { path: join(skillDirA, 'SKILL.md') },
      },
      {
        name: 'skill:beta',
        source: 'skill',
        supported: true,
        sourceInfo: { path: join(skillDirB, 'SKILL.md') },
      },
    ],
    diagnostics: [],
    live: false,
  };
  const runtime = fakeRuntime();
  const app = createApp({
    agentHome,
    sessionDir,
    dataDir,
    initialCwd: cwd,
    runtime,
    commands: { list: async () => catalog, close() {} },
  });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  t.after(async () => {
    await app.close();
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
          headers:
            payload !== undefined
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {},
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
      req.setTimeout(5000, () => req.destroy(new Error('timed out')));
      req.end(payload);
    });
  }
  return { api, cwd, runtime, catalog };
}

test('POST /api/runs expands two catalog skills without duplicate leading command', async (t) => {
  const { api, cwd, runtime } = await fixture(t);
  const res = await api('/api/runs', {
    method: 'POST',
    body: { cwd, message: '/skill:alpha /skill:beta Shared request' },
  });
  assert.equal(res.status, 201);
  const sent = runtime.controls.at(-1).input.message;
  assert.ok(sent.includes('<skill name="alpha"'));
  assert.ok(sent.includes('Alpha instructions.'));
  assert.ok(sent.includes('<skill name="beta"'));
  assert.ok(sent.includes('Beta instructions.'));
  assert.ok(sent.endsWith('Shared request'));
  assert.equal(sent.startsWith('/skill:'), false);
  assert.equal((sent.match(/<skill name="alpha"/g) || []).length, 1);
  assert.equal((sent.match(/<skill name="beta"/g) || []).length, 1);
});

test('POST /api/runs leaves a single skill for the engine and rejects unknown multi', async (t) => {
  const { api, cwd, runtime } = await fixture(t);
  const single = await api('/api/runs', { method: 'POST', body: { cwd, message: '/skill:alpha hello' } });
  assert.equal(single.status, 201);
  assert.equal(runtime.controls.at(-1).input.message, '/skill:alpha hello');
  const unknown = await api('/api/runs', {
    method: 'POST',
    body: { cwd, message: '/skill:alpha /skill:gone hello' },
  });
  assert.equal(unknown.status, 400);
});

test('live steering and followUp deliver two expanded blocks', async (t) => {
  const { catalog, cwd } = await fixture(t);
  for (const mode of ['steer', 'follow_up']) {
    const sent = [];
    const service = createLiveMessages({
      getRuns: async () => [{ sessionId: 'live1', cwd, status: 'running' }],
      getClient: async () => ({
        send: async (sessionId, cwdArg, input) => {
          sent.push(input.message);
          return { accepted: true };
        },
      }),
      getCatalog: async () => catalog,
    });
    const result = await service.send('live1', {
      cwd,
      message: '/skill:alpha /skill:beta steer text',
      mode,
      requestId: `req-${mode.replace('_', '')}-0123456789abcdef`,
    });
    assert.equal(result.accepted, true);
    assert.ok(sent[0].includes('<skill name="alpha"'));
    assert.ok(sent[0].includes('<skill name="beta"'));
    assert.ok(sent[0].endsWith('steer text'));
    assert.equal(sent[0].startsWith('/skill:'), false);
  }
});
