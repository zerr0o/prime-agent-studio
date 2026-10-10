import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';
import { createPublicApiAccess } from '../lib/public-api-access.mjs';

const ACCESS_CODE = '49283175';
const SALT = 'e54d6dd09bb15f7c347b38b671472aa9';
const CONFIG = { salt: SALT, codeHash: hashAccessCode(ACCESS_CODE, SALT), readOnly: false };
const PROJECT = `p_${'c'.repeat(32)}`;

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prime-api-gateway-'));
  t.after(async () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function http(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        done({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function startUpstream(t, handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return server;
}

async function startGateway(t, { host = '127.0.0.1', publicOrigin, publicApiAccess, upstreamPort }) {
  const gateway = createLanGateway({ host, upstreamPort, config: CONFIG, publicOrigin, publicApiAccess });
  await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
  t.after(async () => {
    gateway.closeAllConnections();
    await new Promise((done, reject) => gateway.close((error) => (error ? reject(error) : done())));
  });
  return gateway;
}

async function enableApi(t) {
  const dataDir = await tempDir(t);
  const api = createPublicApiAccess({ dataDir });
  t.after(() => api.close());
  await api.configure({ enabled: true, revision: 0 });
  const created = await api.createToken({
    name: 'integration',
    scopes: ['read'],
    projectIds: [PROJECT],
    revision: 1,
  });
  return { api, credential: created.credential, tokenId: created.token.id };
}

function gatewayHeaders(gateway, host) {
  const port = gateway.address().port;
  const logical = host || '127.0.0.1';
  return { Host: `${logical}:${port}` };
}

async function loginCookie(port, hostHeader) {
  const res = await http(port, '/lan/login', {
    method: 'POST',
    headers: { ...hostHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: ACCESS_CODE }).toString(),
  });
  assert.equal(res.status, 303);
  return res.headers['set-cookie'][0].split(';')[0];
}

test('versioned path forwards authorization, range headers and query to the same path', async (t) => {
  const seen = {};
  const upstream = await startUpstream(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.authorization = req.headers.authorization;
      seen.range = req.headers.range;
      seen['if-range'] = req.headers['if-range'];
      seen['if-match'] = req.headers['if-match'];
      seen['if-unmodified-since'] = req.headers['if-unmodified-since'];
      seen['if-none-match'] = req.headers['if-none-match'];
      seen['if-modified-since'] = req.headers['if-modified-since'];
      seen['last-event-id'] = req.headers['last-event-id'];
      seen.cookie = req.headers.cookie;
      if (req.headers['if-none-match'] === '*') {
        res.writeHead(304, { ETag: '"cached"' });
        res.end();
        return;
      }
      if (req.url.startsWith('/api/v1/sessions/s1/files/f1')) {
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Range': 'bytes 0-3/10',
          'Accept-Ranges': 'bytes',
        });
        res.end('0123');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const { api, credential } = await enableApi(t);
  const gateway = await startGateway(t, { publicApiAccess: api, upstreamPort: upstream.address().port });
  const port = gateway.address().port;
  const hostHeader = gatewayHeaders(gateway);
  const res = await http(port, '/api/v1/sessions/s1/files/f1?machine=local', {
    headers: {
      ...hostHeader,
      Authorization: `Bearer ${credential}`,
      Range: 'bytes=0-3',
      'If-Range': 'etag-1',
      'If-Match': 'etag-1',
      'If-Unmodified-Since': 'Wed, 01 Jan 2025 00:00:00 GMT',
      'If-None-Match': 'etag-2',
      'If-Modified-Since': 'Tue, 31 Dec 2024 00:00:00 GMT',
      Accept: 'application/octet-stream',
    },
  });
  assert.equal(res.status, 206);
  assert.equal(res.text, '0123');
  assert.equal(res.headers['content-range'], 'bytes 0-3/10');
  assert.equal(seen.method, 'GET');
  assert.equal(seen.url, '/api/v1/sessions/s1/files/f1?machine=local');
  assert.equal(seen.authorization, `Bearer ${credential}`);
  assert.equal(seen.range, 'bytes=0-3');
  assert.equal(seen['if-range'], 'etag-1');
  assert.equal(seen['if-match'], 'etag-1');
  assert.equal(seen['if-unmodified-since'], 'Wed, 01 Jan 2025 00:00:00 GMT');
  assert.equal(seen['if-none-match'], 'etag-2');
  assert.equal(seen['if-modified-since'], 'Tue, 31 Dec 2024 00:00:00 GMT');
  assert.equal(seen.cookie, undefined);
  const conditional = await http(port, '/api/v1/sessions/s1/files/f1', {
    headers: {
      ...hostHeader,
      Authorization: `Bearer ${credential}`,
      'If-None-Match': '*',
    },
  });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.text, '');
  assert.equal(conditional.headers.etag, '"cached"');
  await http(port, '/api/v1/sessions/s1/files/f1', {
    headers: {
      ...hostHeader,
      Authorization: `Bearer ${credential}`,
      Range: '',
      'If-Match': '',
      'If-Range': '',
    },
  });
  assert.equal(seen.range, '');
  assert.equal(seen['if-match'], '');
  assert.equal(seen['if-range'], '');
  // Strict prefix only: neighboring paths are not treated as versioned.
  const evil = await http(port, '/api/v10/projects', {
    headers: { ...hostHeader, Authorization: `Bearer ${credential}` },
  });
  assert.equal(evil.status, 401);
});

test('versioned path streams response chunks without gateway buffering', async (t) => {
  const upstream = await startUpstream(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write('data: one\n\n');
    setTimeout(() => {
      res.write('data: two\n\n');
      setTimeout(() => res.end('data: done\n\n'), 20);
    }, 20);
  });
  const { api, credential } = await enableApi(t);
  const gateway = await startGateway(t, { publicApiAccess: api, upstreamPort: upstream.address().port });
  const port = gateway.address().port;
  const hostHeader = gatewayHeaders(gateway);
  const chunks = [];
  await new Promise((done, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/v1/runs/r1/events',
        headers: { ...hostHeader, Authorization: `Bearer ${credential}`, Accept: 'text/event-stream' },
      },
      (res) => {
        assert.equal(res.statusCode, 200);
        res.setEncoding('utf8');
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', done);
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.match(chunks.join(''), /data: one[\s\S]*data: two[\s\S]*data: done/);
});

test('versioned path needs a bearer even with a valid cookie, and cookie paths need no bearer', async (t) => {
  const upstream = await startUpstream(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/api/bootstrap') {
      res.end(JSON.stringify({ ok: true, preferences: { directoryPicker: true } }));
      return;
    }
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  const { api, credential } = await enableApi(t);
  const gateway = await startGateway(t, { publicApiAccess: api, upstreamPort: upstream.address().port });
  const port = gateway.address().port;
  const hostHeader = gatewayHeaders(gateway);
  const cookie = await loginCookie(port, hostHeader);
  assert.equal((await http(port, '/api/v1/projects', { headers: hostHeader })).status, 401);
  assert.equal(
    (await http(port, '/api/v1/projects', { headers: { ...hostHeader, Cookie: cookie } })).status,
    401,
  );
  assert.equal(
    (
      await http(port, '/api/v1/projects', {
        headers: { ...hostHeader, Cookie: cookie, Authorization: `Bearer ${credential}` },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await http(port, '/api/v1/projects', {
        headers: { ...hostHeader, Authorization: `Bearer ${credential}` },
      })
    ).status,
    200,
  );
  assert.equal(
    (await http(port, '/api/bootstrap', { headers: { ...hostHeader, Cookie: cookie } })).status,
    200,
  );
});

test('bearer on legacy paths is rejected even with a valid cookie and never falls back', async (t) => {
  const upstream = await startUpstream(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const { api, credential } = await enableApi(t);
  const gateway = await startGateway(t, { publicApiAccess: api, upstreamPort: upstream.address().port });
  const port = gateway.address().port;
  const hostHeader = gatewayHeaders(gateway);
  const cookie = await loginCookie(port, hostHeader);
  assert.equal(
    (
      await http(port, '/api/bootstrap', {
        headers: { ...hostHeader, Cookie: cookie, Authorization: `Bearer ${credential}` },
      })
    ).json.error,
    'api_token_not_accepted',
  );
  assert.equal(
    (
      await http(port, '/api/bootstrap', {
        headers: { ...hostHeader, Cookie: cookie, Authorization: `Bearer ${credential}` },
      })
    ).json.code,
    'api_token_not_accepted',
  );
  assert.equal(
    (
      await http(port, '/api/bootstrap', {
        headers: { ...hostHeader, Cookie: cookie, Authorization: `Bearer ${credential}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (await http(port, '/api/runs', { headers: { ...hostHeader, Authorization: `Bearer ${credential}` } }))
      .status,
    401,
  );
  assert.equal(
    (
      await http(port, '/public/pwa.js', {
        headers: { ...hostHeader, Authorization: `Bearer ${credential}` },
      })
    ).status,
    401,
  );
});

test('plaintext local gateway refuses versioned access while encrypted bindings allow it', async (t) => {
  const upstream = await startUpstream(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const { api, credential } = await enableApi(t);
  const lan = await startGateway(t, {
    host: '192.168.1.10',
    publicApiAccess: api,
    upstreamPort: upstream.address().port,
  });
  const lanPort = lan.address().port;
  const lanHeaders = gatewayHeaders(lan, '192.168.1.10');
  const refused = await http(lanPort, '/api/v1/projects', {
    headers: { ...lanHeaders, Authorization: `Bearer ${credential}` },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error, 'api_requires_encrypted_transport');
  const tail = await startGateway(t, {
    host: '100.64.0.1',
    publicApiAccess: api,
    upstreamPort: upstream.address().port,
  });
  const tailPort = tail.address().port;
  assert.equal(
    (
      await http(tailPort, '/api/v1/projects', {
        headers: { ...gatewayHeaders(tail, '100.64.0.1'), Authorization: `Bearer ${credential}` },
      })
    ).status,
    200,
  );
  const loopback = await startGateway(t, {
    host: '127.0.0.1',
    publicApiAccess: api,
    upstreamPort: upstream.address().port,
  });
  assert.equal(
    (
      await http(loopback.address().port, '/api/v1/projects', {
        headers: { ...gatewayHeaders(loopback), Authorization: `Bearer ${credential}` },
      })
    ).status,
    200,
  );
});

test('disabled access answers 404 and missing bearer answers 401', async (t) => {
  const upstream = await startUpstream(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const dataDir = await tempDir(t);
  const api = createPublicApiAccess({ dataDir });
  t.after(() => api.close());
  const gateway = await startGateway(t, { publicApiAccess: api, upstreamPort: upstream.address().port });
  const port = gateway.address().port;
  const hostHeader = gatewayHeaders(gateway);
  assert.equal((await http(port, '/api/v1/projects', { headers: hostHeader })).json.error, 'api_disabled');
  assert.equal(
    (await http(port, '/api/v1/projects', { headers: { ...hostHeader, Authorization: 'Bearer pa_wrong' } }))
      .json.error,
    'api_disabled',
  );
  await api.configure({ enabled: true, revision: 0 });
  const created = await api.createToken({
    name: 'one',
    scopes: ['read'],
    projectIds: [PROJECT],
    revision: 1,
  });
  assert.equal(
    (await http(port, '/api/v1/projects', { headers: hostHeader })).json.error,
    'api_unauthorized',
  );
  assert.equal(
    (
      await http(port, '/api/v1/projects', {
        headers: { ...hostHeader, Authorization: `Bearer ${created.credential}` },
      })
    ).status,
    200,
  );
  const live = await api.get();
  await api.configure({ enabled: false, revision: live.revision });
  assert.equal(
    (
      await http(port, '/api/v1/projects', {
        headers: { ...hostHeader, Authorization: `Bearer ${created.credential}` },
      })
    ).json.error,
    'api_disabled',
  );
});

test('versioned JSON bodies are capped and validated', async (t) => {
  const seen = {};
  const upstream = await startUpstream(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.body = body;
      seen.contentType = req.headers['content-type'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const { api, credential } = await enableApi(t);
  const gateway = await startGateway(t, { publicApiAccess: api, upstreamPort: upstream.address().port });
  const port = gateway.address().port;
  const hostHeader = gatewayHeaders(gateway);
  const auth = { ...hostHeader, Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' };
  assert.equal(
    (
      await http(port, '/api/v1/projects/p1/roadmap/mutations', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ op: 'noop' }),
      })
    ).status,
    200,
  );
  assert.equal(JSON.parse(seen.body).op, 'noop');
  assert.equal(
    (
      await http(port, '/api/v1/projects/p1/roadmap/mutations', {
        method: 'POST',
        headers: auth,
        body: 'not-json',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await http(port, '/api/v1/projects/p1/roadmap/mutations', {
        method: 'POST',
        headers: { ...hostHeader, Authorization: `Bearer ${credential}`, 'Content-Type': 'text/plain' },
        body: '{}',
      })
    ).status,
    415,
  );
  const big = JSON.stringify({ data: 'x'.repeat(600 * 1024) });
  assert.equal(
    (await http(port, '/api/v1/projects/p1/roadmap/mutations', { method: 'POST', headers: auth, body: big }))
      .status,
    413,
  );
});

test('host and origin checks still guard versioned paths', async (t) => {
  const upstream = await startUpstream(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const { api, credential } = await enableApi(t);
  const gateway = await startGateway(t, { publicApiAccess: api, upstreamPort: upstream.address().port });
  const port = gateway.address().port;
  const good = gatewayHeaders(gateway);
  assert.equal(
    (
      await http(port, '/api/v1/projects', {
        headers: { Authorization: `Bearer ${credential}`, Host: 'evil.example:1' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await http(port, '/api/v1/projects', {
        headers: { ...good, Authorization: `Bearer ${credential}`, Origin: 'https://attacker.example' },
      })
    ).status,
    403,
  );
});

test('revoke and disable close versioned streams only and keep cookie streams', async (t) => {
  const holders = new Set();
  const upstream = await startUpstream(t, (req, res) => {
    if (req.url.startsWith('/api/v1/') || req.url.match(/^\/api\/runs\//)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(': open\n\n');
      holders.add(res);
      req.on('close', () => holders.delete(res));
      res.on('close', () => holders.delete(res));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const { api, credential, tokenId } = await enableApi(t);
  const gateway = await startGateway(t, { publicApiAccess: api, upstreamPort: upstream.address().port });
  const port = gateway.address().port;
  const hostHeader = gatewayHeaders(gateway);
  const cookie = await loginCookie(port, hostHeader);
  function openStream(path, headers) {
    return new Promise((done, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, headers }, (res) => {
        res.once('data', () => done(res));
        res.on('error', () => {});
      });
      req.on('error', reject);
      req.end();
    });
  }
  const apiStream = await openStream('/api/v1/runs/r1/events', {
    ...hostHeader,
    Authorization: `Bearer ${credential}`,
    Accept: 'text/event-stream',
  });
  const cookieStream = await openStream('/api/runs/12345678-1234-1234-1234-123456789012/events', {
    ...hostHeader,
    Cookie: cookie,
    Accept: 'text/event-stream',
  });
  let apiClosed = false;
  let cookieClosed = false;
  apiStream.on('close', () => (apiClosed = true));
  cookieStream.on('close', () => (cookieClosed = true));
  const live = await api.get();
  await api.revoke({ id: tokenId, revision: live.revision });
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(apiClosed, true);
  assert.equal(cookieClosed, false);
  // A second token keeps streaming across an unrelated revoke, then closes on global disable.
  const second = await api.createToken({
    name: 'second',
    scopes: ['read'],
    projectIds: [PROJECT],
    revision: (await api.get()).revision,
  });
  const apiStream2 = await openStream('/api/v1/runs/r1/events', {
    ...hostHeader,
    Authorization: `Bearer ${second.credential}`,
    Accept: 'text/event-stream',
  });
  let secondClosed = false;
  apiStream2.on('close', () => (secondClosed = true));
  await new Promise((done) => setTimeout(done, 50));
  await api.configure({ enabled: false, revision: (await api.get()).revision });
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(secondClosed, true);
  assert.equal(cookieClosed, false);
  cookieStream.destroy();
});

test('versioned errors use contract error/code while legacy keeps its format', async (t) => {
  const upstream = await startUpstream(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, preferences: { directoryPicker: true } }));
  });
  const { api, credential } = await enableApi(t);
  const gateway = await startGateway(t, { publicApiAccess: api, upstreamPort: upstream.address().port });
  const port = gateway.address().port;
  const hostHeader = gatewayHeaders(gateway);
  // Disabled/missing/invalid/plaintext/body failures all carry code.
  const live = await api.get();
  await api.configure({ enabled: false, revision: live.revision });
  const disabled = await http(port, '/api/v1/projects', {
    headers: { ...hostHeader, Authorization: `Bearer ${credential}` },
  });
  assert.equal(disabled.status, 404);
  assert.equal(disabled.json.error, 'api_disabled');
  assert.equal(disabled.json.code, 'api_disabled');
  const reenabled = await api.configure({ enabled: true, revision: (await api.get()).revision });
  assert.equal(reenabled.enabled, true);
  const missing = await http(port, '/api/v1/projects', { headers: hostHeader });
  assert.equal(missing.status, 401);
  assert.equal(missing.json.error, 'api_unauthorized');
  assert.equal(missing.json.code, 'api_unauthorized');
  const badBody = await http(port, '/api/v1/projects/p1/roadmap/mutations', {
    method: 'POST',
    headers: { ...hostHeader, Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
    body: 'not-json',
  });
  assert.equal(badBody.status, 400);
  assert.equal(badBody.json.code, 'api_invalid_json');
  // Early Host/Origin checks on the versioned path use the contract too.
  const badHost = await http(port, '/api/v1/projects', {
    headers: { Authorization: `Bearer ${credential}`, Host: 'evil.example:1' },
  });
  assert.equal(badHost.status, 403);
  assert.equal(badHost.json.code, 'api_forbidden');
  const badOrigin = await http(port, '/api/v1/projects', {
    headers: { ...hostHeader, Authorization: `Bearer ${credential}`, Origin: 'https://attacker.example' },
  });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.json.code, 'api_forbidden');
  // Legacy format stays untouched: no code field on cookie-path failures.
  const legacyHost = await http(port, '/api/bootstrap', { headers: { Host: 'evil.example:1' } });
  assert.equal(legacyHost.status, 403);
  assert.ok(!('code' in (legacyHost.json || {})));
  // Plaintext transport on the versioned path uses the contract too.
  const plain = await startGateway(t, {
    host: '192.168.1.10',
    publicApiAccess: api,
    upstreamPort: upstream.address().port,
  });
  const plainRes = await http(plain.address().port, '/api/v1/projects', {
    headers: { ...gatewayHeaders(plain, '192.168.1.10'), Authorization: `Bearer ${credential}` },
  });
  assert.equal(plainRes.status, 403);
  assert.equal(plainRes.json.code, 'api_requires_encrypted_transport');
  // Upstream failure on the versioned path uses the contract too.
  const dead = await startGateway(t, { publicApiAccess: api, upstreamPort: 1 });
  const deadRes = await http(dead.address().port, '/api/v1/projects', {
    headers: { ...gatewayHeaders(dead), Authorization: `Bearer ${credential}` },
  });
  assert.equal(deadRes.status, 502);
  assert.equal(deadRes.json.code, 'api_bad_gateway');
});

test('gateway reauthenticates after the body and never forwards stale credentials', async (t) => {
  let forwarded = false;
  const upstream = await startUpstream(t, (req, res) => {
    forwarded = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  let authCalls = 0;
  const tracked = [];
  const stub = {
    async authenticate(req) {
      authCalls += 1;
      if (authCalls === 1) return { id: 't1', scopes: ['read'], projectIds: ['*'], expiresAt: null };
      const error = new Error('api_unauthorized');
      error.status = 401;
      throw error;
    },
    track(principal, res) {
      tracked.push(principal.id);
    },
  };
  const gateway = await startGateway(t, { publicApiAccess: stub, upstreamPort: upstream.address().port });
  const port = gateway.address().port;
  const hostHeader = gatewayHeaders(gateway);
  const res = await http(port, '/api/v1/projects/p1/roadmap/mutations', {
    method: 'POST',
    headers: { ...hostHeader, Authorization: 'Bearer pa_stale', 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'noop' }),
  });
  assert.equal(authCalls, 2);
  assert.equal(forwarded, false);
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'api_unauthorized');
  assert.equal(res.json.code, 'api_unauthorized');
  assert.deepEqual(tracked, ['t1']);
  assert.equal(tracked.length, 1);
});

test('revoke during a slow body never reaches upstream', async (t) => {
  let forwarded = false;
  const upstream = await startUpstream(t, (req, res) => {
    forwarded = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const { api, credential, tokenId } = await enableApi(t);
  const gateway = await startGateway(t, { publicApiAccess: api, upstreamPort: upstream.address().port });
  const port = gateway.address().port;
  const hostHeader = gatewayHeaders(gateway);
  const outcome = await new Promise((done) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/v1/projects/p1/roadmap/mutations',
        method: 'POST',
        headers: { ...hostHeader, Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          done({ status: res.statusCode, json, closed: false });
        });
        res.on('error', () => done({ closed: true }));
      },
    );
    req.on('error', () => done({ closed: true }));
    req.write('{"op":"');
    setTimeout(async () => {
      const live = await api.get();
      await api.revoke({ id: tokenId, revision: live.revision });
      req.end('noop"}');
    }, 60);
  });
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(forwarded, false);
  // Either a contract 401/404 or a destroyed socket proves no forward under stale credentials.
  if (!outcome.closed) {
    assert.ok([401, 404].includes(outcome.status));
    assert.equal(outcome.json.code, outcome.json.error);
  }
});
