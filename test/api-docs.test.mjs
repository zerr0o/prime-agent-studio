import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';
import { generateOpenApi } from '../lib/public-api-contract.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prime-api-docs-'));
  const cwd = join(dir, 'project');
  await mkdir(cwd);
  let started = 0;
  const app = createApp({
    initialCwd: cwd,
    dataDir: join(dir, 'data'),
    agentHome: join(dir, 'agent'),
    sessionDir: join(dir, 'sessions'),
    runtime: {
      getStatus: async () => ({ available: true, version: 'fixture' }),
      getModels: async () => ({ models: [], default: {} }),
      start: async () => {
        started++;
        throw new Error('Docs must never start an agent');
      },
      close: async () => {},
    },
  });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return {
    app,
    base: `http://127.0.0.1:${app.server.address().port}`,
    get started() {
      return started;
    },
  };
}

test('published OpenAPI comes from the source contract without enabling the API', async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/openapi-v1.json');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const actual = await response.json();
  assert.deepEqual(actual, generateOpenApi());
  assert.deepEqual(
    actual,
    JSON.parse(await readFile(new URL('../docs/api/openapi-v1.json', import.meta.url), 'utf8')),
  );
  const head = await fetch(f.base + '/openapi-v1.json', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(f.base + '/api/v1/machine')).status, 404);
  assert.equal(f.started, 0);
});

test('documentation assets keep origin, CSP and token boundaries', async (t) => {
  const f = await fixture(t);
  for (const path of ['/api-docs', '/api-docs/', '/public/api-docs.js', '/public/api-docs.css']) {
    const response = await fetch(f.base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.ok((await response.text()).length > 0);
  }
  const html = await fetch(f.base + '/api-docs', { method: 'HEAD' });
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.equal(await html.text(), '');
  for (const path of ['/api-docs', '/openapi-v1.json']) {
    assert.equal(
      (await fetch(f.base + path, { headers: { Origin: 'https://untrusted.invalid' } })).status,
      403,
    );
    assert.equal(
      (await fetch(f.base + path, { headers: { Authorization: 'Bearer test-not-a-key' } })).status,
      401,
    );
    assert.equal((await fetch(f.base + path, { method: 'POST', body: '{}' })).status, 404);
  }
  assert.equal(f.started, 0);
});

test('remote docs keep PIN protection in consultation and never expose API administration', async (t) => {
  const f = await fixture(t);
  const salt = 'e54d6dd09bb15f7c347b38b671472aa9';
  const code = '49283175';
  const gateway = createLanGateway({
    host: '127.0.0.1',
    upstreamPort: f.app.server.address().port,
    config: { salt, codeHash: hashAccessCode(code, salt), readOnly: true },
  });
  await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
  t.after(async () => {
    gateway.closeAllConnections();
    await new Promise((done) => gateway.close(done));
  });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  for (const path of ['/api-docs', '/openapi-v1.json']) assert.equal((await fetch(base + path)).status, 401);
  const login = await fetch(base + '/lan/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const headers = { Cookie: cookie };
  for (const path of [
    '/api-docs',
    '/api-docs/',
    '/openapi-v1.json',
    '/public/api-docs.js',
    '/public/api-docs.css',
  ])
    assert.equal((await fetch(base + path, { headers })).status, 200, path);
  assert.equal((await fetch(base + '/api/public-api', { headers })).status, 404);
  assert.equal((await fetch(base + '/api-docs', { method: 'POST', headers })).status, 405);
  assert.equal(
    (await fetch(base + '/openapi-v1.json', { headers: { ...headers, Authorization: 'Bearer not-a-key' } }))
      .status,
    401,
  );
  assert.equal(f.started, 0);
});
