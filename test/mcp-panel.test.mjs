import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createMcpConfigStore, mcpRevision } from '../lib/mcp-config.mjs';
import { createMcpService } from '../lib/mcp-service.mjs';
import {
  isCancelError,
  isConfidentialClientError,
  looksLikePastedToken,
  oauthErrorMessage,
  sanitizeOAuthDetail,
} from '../lib/mcp-oauth-errors.mjs';

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (value) return value;
    await wait(50);
  }
  assert.fail('condition timed out');
}

// File-backed native stub: same withLock contract as the engine storage, no
// engine install needed. Auth credentials stay in memory, secrets never logged.
function stubNative(authData = new Map()) {
  return async () => ({
    BUILTIN_MCP_CATALOG: [],
    FileSettingsStorage: class {
      constructor(first, second) {
        this.file = join(second || first, 'settings.json');
      }
      withLock(scope, fn) {
        const current = existsSync(this.file) ? readFileSync(this.file, 'utf8') : undefined;
        const next = fn(current);
        if (next !== undefined) writeFileSync(this.file, next, { mode: 0o600 });
      }
    },
    AuthStorage: {
      create: () => ({
        get: (key) => authData.get(key),
        set: (key, value) => authData.set(key, value),
        removeVerified: (key) => authData.delete(key),
      }),
    },
  });
}

async function fixture(t, settings = {}, env = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-mcp-panel-'));
  const agentHome = join(root, 'agent');
  await mkdir(agentHome, { recursive: true });
  await writeFile(join(agentHome, 'settings.json'), JSON.stringify(settings));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const store = createMcpConfigStore({ agentHome, native: stubNative(), env });
  const read = async () => JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  return { root, agentHome, store, read };
}

test('OAuth error detail is sanitized and never carries codes or secrets', () => {
  const dirty =
    'Token request to https://auth.test/token failed: 422 for http://localhost:53700/callback?code=abc123&state=xyz client_secret=sba_topsecret refresh_token=r123 access_token=a456';
  const clean = sanitizeOAuthDetail(new Error(dirty));
  assert.ok(clean.includes('failed: 422'));
  assert.ok(clean.includes('http://localhost:53700/callback'));
  assert.ok(!clean.includes('abc123') && !clean.includes('sba_topsecret'));
  assert.ok(!clean.includes('r123') && !clean.includes('a456'));
  assert.ok(!clean.includes('state=xyz'));
  assert.ok(sanitizeOAuthDetail(new Error('x'.repeat(900))).length <= 502);
  assert.ok(!/[\r\n]/.test(sanitizeOAuthDetail('line one\nline two')));
});

test('OAuth errors stay truthful: real detail, confidential hint, clean cancel', () => {
  const generic = oauthErrorMessage(new Error('Token request to https://auth.test/token failed: 400'));
  assert.match(generic, /Connexion OAuth impossible/);
  assert.ok(generic.includes('failed: 400'));
  const confidential = oauthErrorMessage(
    new Error('Token request to https://api.supabase.com/v1/oauth/token failed: 422'),
  );
  assert.match(confidential, /identité du client OAuth/);
  assert.ok(confidential.includes('failed: 422'));
  assert.ok(
    isConfidentialClientError('invalid_client: missing client_secret') &&
      !isConfidentialClientError('Token request to https://x/token failed: 400'),
  );
  assert.ok(isCancelError(new Error('Login cancelled')) && isCancelError('Cancelled'));
  assert.match(oauthErrorMessage(new Error('Login cancelled')), /annulée/);
});

test('pasted tokens are told apart from variable names', () => {
  assert.equal(looksLikePastedToken('MON_SERVICE_TOKEN'), false);
  assert.equal(looksLikePastedToken('A1'.repeat(40)), false);
  assert.equal(looksLikePastedToken('my_token'), false);
  assert.equal(looksLikePastedToken('9bad'), false);
  // Invalid test fixture with the recognized Supabase prefix, not a usable PAT.
  assert.equal(looksLikePastedToken('sbp_not-a-real-token-test-fixture'), true);
  assert.equal(looksLikePastedToken('sbp_short'), true);
  assert.equal(looksLikePastedToken('sbp_v0_fake0123456789abcdef'), true);
  assert.equal(looksLikePastedToken('ghp_faketoken0123456789abcdef'), true);
  assert.equal(looksLikePastedToken('github_pat_faketoken0123456789ab'), true);
  assert.equal(looksLikePastedToken('glpat-faketoken0123456789'), true);
  assert.equal(looksLikePastedToken('sk-live-faketoken0123456789abcdef'), true);
  assert.equal(looksLikePastedToken('xoxb-fake0123456789token'), true);
  assert.equal(looksLikePastedToken('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2ln'), true);
  assert.equal(looksLikePastedToken('ghp_1234567890abcdef with spaces'), true);
  assert.equal(looksLikePastedToken('sbp_' + 'a'.repeat(70)), true);
  assert.equal(looksLikePastedToken('k1'.repeat(20)), true);
  assert.equal(looksLikePastedToken(''), false);
  assert.equal(looksLikePastedToken(undefined), false);
});

test('env var field rejects pasted tokens with a Token mode hint', async (t) => {
  const f = await fixture(t);
  const base = { type: 'http', url: 'https://service.test/mcp' };
  await assert.rejects(
    f.store.upsert({ name: 'jwt', config: { ...base, bearerTokenEnvVar: 'eyJhbGciOi.test.sig' } }),
    /mode Jeton/,
  );
  await assert.rejects(
    f.store.upsert({
      name: 'spaced',
      config: { ...base, bearerTokenEnvVar: 'this is clearly a pasted secret value' },
    }),
    /mode Jeton/,
  );
  await assert.rejects(
    f.store.upsert({
      name: 'supabase',
      config: {
        ...base,
        bearerTokenEnvVar: 'sbp_not-a-real-token-test-fixture',
      },
    }),
    /mode Jeton/,
  );
  await assert.rejects(
    f.store.upsert({ name: 'plain', config: { ...base, bearerTokenEnvVar: '9bad' } }),
    /nom de la variable/,
  );
  await f.store.upsert({ name: 'ok', config: { ...base, bearerTokenEnvVar: 'MON_SERVICE_TOKEN' } });
  assert.equal((await f.read()).mcpServers.ok.bearerTokenEnvVar, 'MON_SERVICE_TOKEN');
});

test('direct token is stored as a private header, redacted, and kept on edit', async (t) => {
  const f = await fixture(t);
  const secret = `fixture-secret-${randomBytes(8).toString('hex')}`;
  await f.store.upsert({
    name: 'direct',
    config: { type: 'http', url: 'https://service.test/mcp', headers: { Authorization: `Bearer ${secret}` } },
  });
  const list = await f.store.list();
  assert.ok(!JSON.stringify(list).includes(secret));
  const row = list.servers.find((s) => s.name === 'direct');
  assert.equal(row.config.headers.Authorization, null);
  assert.equal(row.status, 'configured');
  assert.equal((await f.read()).mcpServers.direct.headers.Authorization, `Bearer ${secret}`);
  // Edit with a null Authorization keeps the saved secret when the URL is unchanged.
  const { privateUrlParameters, ...publicConfig } = row.config;
  assert.equal(privateUrlParameters, undefined);
  await f.store.upsert({ name: 'direct', revision: row.revision, config: publicConfig });
  assert.equal((await f.read()).mcpServers.direct.headers.Authorization, `Bearer ${secret}`);
  // A new URL with a retained null header is rejected instead of leaking or dropping.
  const moved = await f.store.list();
  const current = moved.servers.find((s) => s.name === 'direct');
  await assert.rejects(
    f.store.upsert({
      name: 'direct',
      revision: current.revision,
      config: { ...publicConfig, url: 'https://other.test/mcp' },
    }),
    /en-têtes privés/,
  );
});

test('missing env names still drive missing-env status while direct tokens stay configured', async (t) => {
  const f = await fixture(t, {}, {});
  await f.store.upsert({
    name: 'envmode',
    config: { type: 'http', url: 'https://service.test/mcp', bearerTokenEnvVar: 'MISSING_TOKEN_NAME' },
  });
  assert.equal((await f.store.list()).servers.find((s) => s.name === 'envmode').status, 'missing-env');
  const g = await fixture(t, {}, { MISSING_TOKEN_NAME: 'set' });
  await g.store.upsert({
    name: 'envmode',
    config: { type: 'http', url: 'https://service.test/mcp', bearerTokenEnvVar: 'MISSING_TOKEN_NAME' },
  });
  assert.equal((await g.store.list()).servers.find((s) => s.name === 'envmode').status, 'configured');
});

function fakeOAuthChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writes = [];
  child.stdin.write = (data) => child.stdin.writes.push(String(data));
  return child;
}

test('pasting a return URL after failure shows the stored provider error', async (t) => {
  const f = await fixture(t);
  await f.store.upsert({
    name: 'confidential',
    config: { type: 'http', url: 'https://mcp.test/mcp', oauth: true },
  });
  const row = (await f.store.list()).servers.find((s) => s.name === 'confidential');
  let child;
  const service = createMcpService({
    agentHome: f.agentHome,
    store: f.store,
    spawnProcess: () => (child = fakeOAuthChild()),
  });
  t.after(() => service.close());
  const first = await service.login({ name: 'confidential', revision: row.revision });
  const authUrl = new URL('https://auth.test/authorize?state=abc');
  const redirect = 'http://localhost:53700/callback';
  child.stdout.emit(
    'data',
    JSON.stringify({ status: 'waiting', url: `${authUrl}&redirect_uri=${encodeURIComponent(redirect)}` }) + '\n',
  );
  const job = await until(() => {
    const snapshot = service.job(first.id);
    return snapshot.status === 'waiting' && snapshot;
  });
  assert.ok(job.url.includes('redirect_uri='));
  // The worker reports the real exchange failure instead of a generic sentence.
  const providerError = 'Token request to https://auth.test/token failed: 422';
  child.stdout.emit('data', JSON.stringify({ status: 'error', error: providerError }) + '\n');
  await until(() => service.job(first.id).status === 'error');
  // A late manual paste now surfaces that stored error, not a mismatch message.
  const pasted = `${redirect}?code=late-code&state=abc`;
  assert.throws(() => service.complete({ id: first.id, url: pasted }), /failed: 422/);
  service.cancel(first.id);
  // A provider refusal pasted from the browser reports its own reason.
  const second = await service.login({ name: 'confidential', revision: row.revision });
  child.stdout.emit(
    'data',
    JSON.stringify({ status: 'waiting', url: `${authUrl}&redirect_uri=${encodeURIComponent(redirect)}` }) + '\n',
  );
  await until(() => service.job(second.id).status === 'waiting');
  assert.throws(
    () =>
      service.complete({
        id: second.id,
        url: `${redirect}?error=access_denied&error_description=nope&state=abc`,
      }),
    /refusé.*access_denied/,
  );
  service.cancel(second.id);
});

test('fake confidential OAuth server: discovery, DCR, PKCE, redirect, exchange', async (t) => {
  const codes = new Map();
  let registration;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake.test');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
      return json(200, { resource: 'http://fake.test/mcp', authorization_servers: ['http://fake.test'] });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(200, {
        issuer: 'http://fake.test',
        authorization_endpoint: 'http://fake.test/authorize',
        token_endpoint: 'http://fake.test/token',
        registration_endpoint: 'http://fake.test/register',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    if (url.pathname === '/register') {
      const body = JSON.parse(raw);
      if (!Array.isArray(body.redirect_uris) || !body.redirect_uris.every((u) => u.startsWith('http://localhost:5370')))
        return json(400, { error: 'invalid_redirect_uri' });
      registration = { client_id: 'fake-client', client_secret: 'fake-secret' };
      return json(201, registration);
    }
    if (url.pathname === '/authorize') {
      if (url.searchParams.get('code_challenge_method') !== 'S256') return json(400, { error: 'pkce_required' });
      if (url.searchParams.get('resource') !== 'http://fake.test/mcp') return json(400, { error: 'bad_resource' });
      if (!url.searchParams.get('redirect_uri')?.startsWith('http://localhost:5370'))
        return json(400, { error: 'bad_redirect' });
      const code = 'code-' + randomBytes(6).toString('hex');
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge'),
        redirect: url.searchParams.get('redirect_uri'),
        client: url.searchParams.get('client_id'),
      });
      res.writeHead(302, {
        Location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}`,
      });
      return res.end();
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(raw);
      if (!form.get('client_secret')) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Required parameter: client_secret' }));
      }
      if (form.get('client_secret') !== registration.client_secret) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_client' }));
      }
      if (form.get('grant_type') === 'authorization_code') {
        const record = codes.get(form.get('code'));
        const digest = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        if (!record || digest !== record.challenge || form.get('redirect_uri') !== record.redirect)
          return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600 });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const response = await fetch(origin + path, { redirect: 'error' });
    return { status: response.status, body: await response.json() };
  };
  // Protected resource metadata points at the authorization server.
  const prm = await get('/.well-known/oauth-protected-resource/mcp');
  assert.equal(prm.status, 200);
  const resource = prm.body.resource.replace('http://fake.test', origin);
  assert.deepEqual(prm.body.authorization_servers, ['http://fake.test']);
  // Authorization server metadata advertises secret-based token auth only.
  const meta = await get('/.well-known/oauth-authorization-server');
  assert.equal(meta.body.issuer, 'http://fake.test');
  assert.ok(!meta.body.token_endpoint_auth_methods_supported.includes('none'));
  // Dynamic client registration returns a secret the public engine flow drops.
  const register = await fetch(origin + '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Prime Agent (test)',
      redirect_uris: ['http://localhost:53700/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(register.status, 201);
  const client = await register.json();
  assert.ok(client.client_id && client.client_secret);
  // PKCE S256 authorize round trip with resource and exact redirect match.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  const authorize = new URL(origin + '/authorize');
  for (const [key, value] of [
    ['client_id', client.client_id],
    ['response_type', 'code'],
    ['redirect_uri', 'http://localhost:53700/callback'],
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
    ['state', state],
    ['resource', 'http://fake.test/mcp'],
  ])
    authorize.searchParams.set(key, value);
  const redirect = await fetch(authorize, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  const landing = new URL(redirect.headers.get('location'));
  assert.equal(landing.origin + landing.pathname, 'http://localhost:53700/callback');
  assert.equal(landing.searchParams.get('state'), state);
  // Exchange without the secret fails exactly like Supabase: HTTP 422.
  const exchange = (body) =>
    fetch(origin + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      redirect: 'error',
    });
  const missing = await exchange({
    grant_type: 'authorization_code',
    code: landing.searchParams.get('code'),
    redirect_uri: 'http://localhost:53700/callback',
    client_id: client.client_id,
    code_verifier: verifier,
    resource: 'http://fake.test/mcp',
  });
  assert.equal(missing.status, 422);
  assert.match(
    oauthErrorMessage(new Error(`Token request to ${origin}/token failed: 422`)),
    /identité du client OAuth/,
  );
  assert.ok(
    !JSON.stringify(oauthErrorMessage(new Error(`Token request to ${origin}/token failed: 422`))).includes(
      client.client_secret,
    ),
  );
  // With the secret the same code exchanges cleanly.
  const ok = await exchange({
    grant_type: 'authorization_code',
    code: landing.searchParams.get('code'),
    redirect_uri: 'http://localhost:53700/callback',
    client_id: client.client_id,
    client_secret: client.client_secret,
    code_verifier: verifier,
    resource: 'http://fake.test/mcp',
  });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).access_token);
});
