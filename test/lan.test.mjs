import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRequest, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { metricsProjectId } from '../lib/metrics.mjs';
import { createLanGateway, hashAccessCode, isPrivateIPv4 } from '../lib/lan.mjs';

const ACCESS_CODE = '49283175';
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

test('voice uploads require authenticated full control and preserve bounded binary audio', async (t) => {
  const timeouts = [];
  const originalSetTimeout = ClientRequest.prototype.setTimeout;
  t.mock.method(ClientRequest.prototype, 'setTimeout', function (ms, callback) {
    timeouts.push({ path: this.path, ms });
    return originalSetTimeout.call(this, ms, callback);
  });
  for (const readOnly of [false, true]) {
    const calls = [];
    const voiceDir = await mkdtemp(join(tmpdir(), 'studio-voice-lan-'));
    t.after(() => rm(voiceDir, { recursive: true, force: true }));
    await writeFile(join(voiceDir, 'voice.json'), JSON.stringify({ provider: 'whisper', timeoutMs: 600000 }));
    const f = await fixture(
      t,
      { readOnly },
      {
        voice: {
          dataDir: voiceDir,
          env: {},
          fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return Response.json({ text: 'A synthetic voice prompt.' });
          },
        },
      },
    );
    const body = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32)]);
    const headers = { 'Content-Type': 'audio/ogg;codecs=opus' };
    assert.equal((await f.api('/api/voice/transcribe', { method: 'POST', body, headers })).status, 401);
    const Cookie = await f.authenticate();
    const status = await f.api('/api/voice', { headers: { Cookie } });
    assert.equal(status.status, 200);
    assert.equal(status.json.provider, 'whisper');
    assert.doesNotMatch(status.text, /127\.0\.0\.1|inference/);
    // Settings (with the Whisper URL) are full control only, like other Preferences.
    const settings = await f.api('/api/voice/settings', { headers: { Cookie } });
    assert.equal(settings.status, readOnly ? 404 : 200, settings.text);
    const patch = await f.api('/api/voice/settings', {
      method: 'PATCH',
      body: JSON.stringify({ timeoutMs: 600000 }),
      headers: { Cookie, 'Content-Type': 'application/json' },
    });
    assert.equal(patch.status, readOnly ? 405 : 200, patch.text);
    const response = await f.api('/api/voice/transcribe', {
      method: 'POST',
      body,
      headers: { ...headers, Cookie },
    });
    assert.equal(response.status, readOnly ? 405 : 200, response.text);
    if (!readOnly) {
      assert.deepEqual(response.json, { text: 'A synthetic voice prompt.' });
      assert.ok(
        timeouts.find(({ path }) => path === '/api/voice/transcribe')?.ms > status.json.timeoutMs,
        'The remote proxy must allow the full configured transcription deadline',
      );
      assert.equal(timeouts.find(({ path }) => path === '/api/voice')?.ms, 35000);
      assert.deepEqual(Buffer.from(await calls[0].init.body.get('file').arrayBuffer()), body);
      assert.equal(calls[0].init.headers, undefined, 'Local Whisper receives no provider credential');
      for (const [extra, status] of [
        [{ 'Content-Type': 'text/plain' }, 415],
        [{ 'Content-Length': 10 * 1024 * 1024 + 1 }, 413],
        [{ Origin: 'https://untrusted.example' }, 403],
      ]) {
        const result = await f.api('/api/voice/transcribe', {
          method: 'POST',
          body,
          headers: { ...headers, Cookie, ...extra },
        });
        assert.equal(result.status, status, result.text);
      }
      assert.equal((await f.api('/api/voice/transcribe', { headers: { Cookie } })).status, 404);
    }
    assert.equal(calls.length, readOnly ? 0 : 1);
    assert.equal(f.runtime.controls.length, 0);
  }
});

async function until(check, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for the expected LAN gateway state.');
}

function fakeRuntime() {
  const controls = [];
  return {
    controls,
    async getStatus() {
      return { available: true, version: 'fixture', nodeVersion: process.versions.node };
    },
    async getModels() {
      return { models: [], default: { model: 'fixture/no-provider' } };
    },
    async start(input) {
      let resolveDone;
      let finished = false;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      const control = {
        input,
        done,
        cancelCalls: 0,
        emit(event) {
          input.onEvent(event);
        },
        finish(result = { status: 'completed', code: 0 }) {
          if (finished) return;
          finished = true;
          input.onEvent({ kind: 'done', ...result });
          resolveDone(result);
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

function http(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, reject) => {
    const outgoing = {
      ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      ...headers,
    };
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: outgoing }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
      });
      response.on('error', (error) =>
        reject(new Error(`${method} ${path}: ${error.message}`, { cause: error })),
      );
      response.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          /* HTML, static assets, or SSE. */
        }
        done({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.on('error', (error) => reject(new Error(`${method} ${path}: ${error.message}`, { cause: error })));
    req.end(body);
  });
}

async function fixture(t, permissions = {}, extraOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-lan-'));
  const cwd = join(root, 'project');
  const sessionDir = join(root, 'sessions');
  await Promise.all([mkdir(cwd), mkdir(sessionDir)]);
  await writeFile(
    join(sessionDir, 'native-session.jsonl'),
    [
      { type: 'session', id: 'native-session', cwd, timestamp: '2026-09-04T00:00:00.000Z' },
      {
        type: 'message',
        id: 'initial-message',
        parentId: null,
        message: { role: 'user', content: 'Existing conversation' },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n',
  );
  const runtime = fakeRuntime();
  const app = createApp({
    agentHome: join(root, 'agent'),
    sessionDir,
    dataDir: join(root, 'data'),
    initialCwd: cwd,
    runtime,
    ...extraOptions,
  });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const upstreamPort = app.server.address().port;
  const salt = 'e54d6dd09bb15f7c347b38b671472aa9';
  const config = { salt, codeHash: hashAccessCode(ACCESS_CODE, salt), ...permissions };
  const gateway = createLanGateway({ host: '127.0.0.1', port: 0, upstreamPort, config });
  await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
  const port = gateway.address().port;
  t.after(async () => {
    gateway.closeAllConnections();
    await new Promise((done, reject) => gateway.close((error) => (error ? reject(error) : done())));
    await app.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = (path, options) => http(port, path, options);
  const local = (path, options) => http(upstreamPort, path, options);
  const login = (code = ACCESS_CODE, headers = {}) =>
    api('/lan/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ code }).toString(),
    });
  async function authenticate() {
    const response = await login();
    assert.equal(response.status, 303, response.text);
    return response.headers['set-cookie'][0].split(';')[0];
  }
  return { api, local, login, authenticate, runtime, app, cwd, sessionDir, port, config };
}

test('catalogue refresh follows authenticated mobile control permissions and never starts an agent', async (t) => {
  for (const readOnly of [true, false]) {
    const f = await fixture(t, { readOnly });
    const result = await f.api('/api/models/refresh', {
      method: 'POST',
      body: '{}',
      headers: {
        Cookie: await f.authenticate(),
        Origin: `http://127.0.0.1:${f.port}`,
        'Content-Type': 'application/json',
      },
    });
    assert.equal(result.status, readOnly ? 405 : 200);
    assert.equal(f.runtime.controls.length, 0);
  }
});

test('authenticated phone receipts synchronize in consultation mode without allowing project changes', async (t) => {
  const f = await fixture(t, { readOnly: true });
  await f.app.store.overview();
  await appendFile(
    join(f.sessionDir, 'native-session.jsonl'),
    JSON.stringify({
      type: 'message',
      id: 'new-answer',
      parentId: 'initial-message',
      message: { role: 'assistant', content: 'Completed answer', stopReason: 'stop' },
    }) + '\n',
  );
  const body = JSON.stringify({ id: 'native-session', answer: 'new-answer' });
  const headers = { 'Content-Type': 'application/json' };
  assert.equal((await f.api('/api/sessions/read', { method: 'POST', headers, body })).status, 401);
  headers.Cookie = await f.authenticate();
  const response = await f.api('/api/sessions/read', { method: 'POST', headers, body });
  assert.equal(response.status, 200, response.text);
  assert.equal((await f.local('/api/history?id=native-session')).json.readState.read, 'new-answer');
  const unreadBody = JSON.stringify({ id: 'native-session' });
  assert.equal(
    (
      await f.api('/api/sessions/unread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: unreadBody,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.api('/api/sessions/unread', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://attacker.example' },
        body: unreadBody,
      })
    ).status,
    403,
  );
  const unread = await f.api('/api/sessions/unread', { method: 'POST', headers, body: unreadBody });
  assert.equal(unread.status, 200, unread.text);
  assert.equal((await f.local('/api/history?id=native-session')).json.readState.read, '');
  assert.equal(
    (
      await f.api('/api/projects/move', {
        method: 'POST',
        headers,
        body: JSON.stringify({ cwd: f.cwd, direction: 1 }),
      })
    ).status,
    405,
  );
  assert.equal(
    (
      await f.api('/api/sessions/read', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: 'native-session', answer: 'initial-message' }),
      })
    ).status,
    400,
  );
});

test('logout revokes this browser and its SSE, keeps another browser connected, and leaves the agent running', async (t) => {
  for (const readOnly of [true, false]) {
    const f = await fixture(t, { readOnly });
    const cookie = await f.authenticate(),
      otherCookie = await f.authenticate();
    const started = await f.local('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: f.cwd, message: 'Running fixture' }),
    });
    const stream = await new Promise((done, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: f.port,
          path: `/api/runs/${started.json.id}/events`,
          headers: { Cookie: cookie },
        },
        (response) => {
          response.resume();
          response.on('error', () => {});
          done(response);
        },
      );
      req.on('error', reject);
      req.end();
    });
    let streamClosed = false;
    stream.on('close', () => {
      streamClosed = true;
    });
    const loggedOut = await f.api('/lan/logout', { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.headers['set-cookie'][0], /Max-Age=0/);
    await until(() => streamClosed);
    assert.equal((await f.api('/api/bootstrap', { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await f.api('/api/bootstrap', { headers: { Cookie: otherCookie } })).status, 200);
    assert.equal(f.runtime.controls[0].cancelCalls, 0);
    assert.equal((await f.local('/api/runs')).json.runs.length, 1);
    assert.equal((await f.api('/lan/logout', { method: 'POST' })).status, 401);
    f.runtime.controls[0].finish();
  }
});

test('MCP management passes only authenticated control routes and stays unavailable to read-only clients', async (t) => {
  const calls = [];
  const methods = [
    'list',
    'upsert',
    'toggle',
    'remove',
    'probe',
    'login',
    'disconnect',
    'complete',
    'job',
    'cancel',
  ];
  const mcp = Object.fromEntries(
    methods.map((name) => [
      name,
      (body) => {
        calls.push({ name, body });
        return { ok: true };
      },
    ]),
  );
  const f = await fixture(t, { readOnly: false }, { mcp });
  const headers = { Cookie: await f.authenticate(), 'Content-Type': 'application/json' };
  const id = '12345678-1234-1234-1234-123456789012';
  const routes = [
    ['GET', '/api/mcp'],
    ['POST', '/api/mcp'],
    ['PATCH', '/api/mcp'],
    ['DELETE', '/api/mcp'],
    ['POST', '/api/mcp/test'],
    ['POST', '/api/mcp/login'],
    ['POST', '/api/mcp/disconnect'],
    ['POST', '/api/mcp/login/complete'],
    ['GET', `/api/mcp/login/${id}`],
    ['DELETE', `/api/mcp/login/${id}`],
  ];
  for (const [method, path] of routes) {
    const body = method === 'GET' ? undefined : JSON.stringify({ name: 'fixture', revision: 'r1' });
    assert.equal(
      (await f.api(path, { method, headers: { 'Content-Type': 'application/json' }, body })).status,
      401,
    );
    assert.equal((await f.api(path, { method, headers, body })).status, 200);
  }
  assert.deepEqual(
    calls.map((c) => c.name),
    methods,
  );
  assert.equal(
    (
      await f.api('/api/mcp', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://attacker.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  const ro = await fixture(t, { readOnly: true }, { mcp });
  const readHeaders = { Cookie: await ro.authenticate(), 'Content-Type': 'application/json' };
  assert.equal((await ro.api('/api/mcp', { headers: readHeaders })).status, 404);
  assert.equal((await ro.api('/api/mcp', { method: 'POST', headers: readHeaders, body: '{}' })).status, 405);
  assert.equal(calls.length, 10);
});

test('LAN address selection accepts only valid RFC1918 IPv4 addresses', () => {
  for (const ip of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.1.25'])
    assert.equal(isPrivateIPv4(ip), true, ip);
  for (const ip of [
    '127.0.0.1',
    '0.0.0.0',
    '169.254.1.2',
    '172.15.0.1',
    '172.32.0.1',
    '192.169.0.1',
    '8.8.8.8',
    '192.168.1.256',
    '192.168.1',
    '192.168..1',
    '192.168. 1.1',
    ' 192.168.1.1',
    '::1',
    'localhost',
    '192.168.1.1.evil',
  ])
    assert.equal(isPrivateIPv4(ip), false, ip);
});

test('LAN access requires login and never exposes health metadata or access credentials', async (t) => {
  const { api, authenticate, config } = await fixture(t);
  const root = await api('/');
  assert.equal(root.status, 200);
  assert.match(root.headers['content-type'], /text\/html/);
  assert.match(root.text, /\/lan\/login/);
  for (const path of ['/api/bootstrap', '/api/history?id=native-session', '/api/runs']) {
    const response = await api(path);
    assert.equal(response.status, 401, path);
    assert.equal(response.text.includes('Existing conversation'), false);
  }
  const health = await api('/api/health');
  assert.equal(health.status, 401);
  const authorizedHealth = await api('/api/health', { headers: { Cookie: await authenticate() } });
  assert.equal(authorizedHealth.status, 404);
  for (const response of [root, health, authorizedHealth]) {
    for (const secret of [ACCESS_CODE, config.salt, config.codeHash])
      assert.equal(response.text.includes(secret), false);
  }
  assert.equal('pid' in health.json, false);
  assert.equal('instanceId' in health.json, false);
});

test('successful LAN login issues an opaque HttpOnly cookie and enables read-only history', async (t) => {
  const { api, login } = await fixture(t);
  assert.equal((await login('00000000')).status, 401);
  const signedIn = await login();
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.location, '/');
  const setCookie = signedIn.headers['set-cookie'][0];
  assert.match(setCookie, /^prime_studio_lan=/);
  assert.match(setCookie, /;\s*HttpOnly/i);
  assert.match(setCookie, /;\s*SameSite=Strict/i);
  assert.equal(setCookie.includes(ACCESS_CODE), false);
  const headers = { Cookie: setCookie.split(';')[0] };
  const bootstrap = await api('/api/bootstrap', { headers });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.json.preferences.readOnly, true);
  assert.equal(bootstrap.json.preferences.remote, true);
  const history = await api('/api/history?id=native-session', { headers });
  assert.equal(history.status, 200);
  assert.match(history.text, /Existing conversation/);
  assert.equal((await api('/api/bootstrap', { headers: { Cookie: 'prime_studio_lan=forged' } })).status, 401);
});

test('LAN goal controls reach Studio only with full control; consultation can read the goal', async (t) => {
  for (const readOnly of [false, true]) {
    const calls = [];
    const goalService = {
      get: async (id) => {
        calls.push(['get', id]);
        return { goal: { id: 'goal-1', objective: 'Finish' }, editable: !readOnly };
      },
      update: async (id, body) => {
        calls.push(['update', id, body]);
        return { goal: { id: 'goal-1', objective: body.objective }, editable: true };
      },
      control: async (id, action, body) => {
        calls.push(['control', id, action, body]);
        return { goal: null, editable: true };
      },
      busy: () => false,
    };
    const f = await fixture(t, { readOnly }, { goalService });
    const path = '/api/sessions/native-session/goal';
    const body = { cwd: f.cwd, goalId: 'goal-1', expectedObjective: 'Finish' };
    const headers = { Cookie: await f.authenticate(), 'Content-Type': 'application/json' };

    assert.equal((await f.api(path)).status, 401);
    const current = await f.api(path, { headers });
    assert.equal(current.status, 200);
    assert.equal(current.json.goal.objective, 'Finish');
    assert.deepEqual(calls, [['get', 'native-session']]);

    for (const [method, suffix, data] of [
      ['PATCH', '', { ...body, objective: 'Ship' }],
      ['POST', '/stop', body],
      ['POST', '/clear', body],
    ]) {
      const response = await f.api(path + suffix, { method, headers, body: JSON.stringify(data) });
      assert.equal(response.status, readOnly ? 405 : 200, `${method} ${path + suffix}`);
    }
    const retry = await f.api(path + '/resume', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(retry.status, readOnly ? 405 : 409, 'A read-only phone cannot retry a goal');
    assert.deepEqual(
      calls,
      readOnly
        ? [['get', 'native-session']]
        : [
            ['get', 'native-session'],
            ['update', 'native-session', { ...body, objective: 'Ship' }],
            ['control', 'native-session', 'stop', body],
            ['control', 'native-session', 'clear', body],
            ['get', 'native-session'],
          ],
    );
    assert.equal((await f.api(path + '/unknown', { headers })).status, 404);
    assert.equal((await f.api(path + '/stop', { headers })).status, 404);
  }
});

test('LAN login throttles repeated failed codes', async (t) => {
  const { login } = await fixture(t);
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await login(String(attempt).padStart(8, '0'));
    assert.equal(response.status, 401, `Failure ${attempt + 1}`);
  }
  const limited = await login();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
});

test('LAN rejects invalid or oversized login bodies and accepts subsequent valid requests', async (t) => {
  const { api, login } = await fixture(t);
  assert.equal((await login(ACCESS_CODE, { 'Content-Type': 'text/plain' })).status, 415);
  const oversized = await api('/lan/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `code=${'1'.repeat(1025)}`,
  });
  assert.equal(oversized.status, 413);
  assert.equal((await login()).status, 303);
});

test('authenticated LAN clients cannot launch, stop, edit, or probe folders', async (t) => {
  const { api, authenticate, runtime } = await fixture(t);
  const headers = { Cookie: await authenticate(), 'Content-Type': 'application/json' };
  for (const [method, path] of [
    ['POST', '/api/runs'],
    ['POST', '/api/runs/00000000-0000-0000-0000-000000000000/stop'],
    ['PATCH', '/api/sessions'],
    ['POST', '/api/projects'],
    ['PATCH', '/api/projects'],
    ['DELETE', '/api/sessions'],
  ]) {
    assert.equal((await api(path, { method, headers, body: '{}' })).status, 405, `${method} ${path}`);
  }
  assert.equal(runtime.controls.length, 0);
  assert.equal((await api('/server.mjs', { headers })).status, 404);
  assert.equal((await api('/.local/lan.json', { headers })).status, 404);
  assert.equal((await api('/api/check-cwd?cwd=C%3A%5C', { headers })).status, 404);
  assert.equal((await api('/api/model-config', { headers })).status, 404);
  assert.equal((await api('/api/model-defaults', { headers })).status, 404);
});

test('LAN gateway validates Host, Origin and browser cross-site context', async (t) => {
  const { api, login, authenticate, port } = await fixture(t);
  const cookie = await authenticate();
  for (const invalid of [
    { Host: 'attacker.example' },
    { Host: '127.0.0.1.attacker.example' },
    { Origin: 'https://attacker.example' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    assert.equal((await api('/api/bootstrap', { headers: { Cookie: cookie, ...invalid } })).status, 403);
    assert.equal((await login(ACCESS_CODE, invalid)).status, 403);
  }
  assert.equal(
    (
      await api('/api/bootstrap', {
        headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
      })
    ).status,
    200,
  );
});

test('a phone can open the login page from an external chat link without allowing cross-site API reads', async (t) => {
  const { api } = await fixture(t);
  const headers = {
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document',
  };
  assert.equal((await api('/', { headers })).status, 200);
  assert.equal((await api('/api/bootstrap', { headers })).status, 403);
  assert.equal((await api('/', { headers: { ...headers, 'Sec-Fetch-Dest': 'iframe' } })).status, 403);
});

test('service-worker navigation can reload the landing page without exempting APIs or commands', async (t) => {
  const { api, authenticate, login } = await fixture(t);
  const headers = {
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'empty',
  };
  for (const path of ['/', '/index.html', '/?installed=true']) {
    const landing = await api(path, { headers });
    assert.equal(landing.status, 200);
    assert.match(landing.text, /Code d’accès/);
  }
  const cookie = await authenticate();
  for (const path of ['/api/bootstrap', '/api/history?id=private', '/api/runs', '/public/app.js'])
    assert.equal((await api(path, { headers: { ...headers, Cookie: cookie } })).status, 403);
  for (const invalid of [
    { Host: 'attacker.example' },
    { Origin: 'https://attacker.example' },
    { Origin: 'null' },
    { 'Sec-Fetch-Mode': 'cors' },
    { 'Sec-Fetch-Mode': 'no-cors' },
    { 'Sec-Fetch-Dest': 'iframe' },
    { 'Sec-Fetch-Dest': 'image' },
  ])
    assert.equal((await api('/', { headers: { ...headers, ...invalid } })).status, 403);
  assert.equal((await login(ACCESS_CODE, headers)).status, 403);
  assert.equal(
    (
      await api('/api/runs', {
        method: 'POST',
        headers: { ...headers, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Rejected' }),
      })
    ).status,
    403,
  );
});

test('LAN SSE streams promptly, resumes with Last-Event-ID, and disconnect preserves execution', async (t) => {
  const { api, local, authenticate, cwd, port, app, runtime } = await fixture(t);
  const cookie = await authenticate();
  const started = await local('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, message: 'No provider calls: fake runtime only' }),
  });
  assert.equal(started.status, 201);
  const runId = started.json.id;
  const control = runtime.controls[0];
  const chunks = [];
  const stream = await new Promise((done, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path: `/api/runs/${runId}/events`, headers: { Cookie: cookie } },
      (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', () => {});
        done({ req, response });
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(stream.response.statusCode, 200);
  assert.match(stream.response.headers['content-type'], /text\/event-stream/);
  control.emit({ kind: 'text', delta: 'Before disconnect' });
  await until(() => chunks.join('').includes('Before disconnect'));
  stream.req.destroy();
  await until(() => app.runs.get(runId).clients.size === 0);
  assert.equal(control.cancelCalls, 0);
  assert.equal(app.runs.get(runId).status, 'running');
  control.emit({ kind: 'text', delta: 'After disconnect' });
  control.finish();
  const replay = await api(`/api/runs/${runId}/events`, {
    headers: { Cookie: cookie, 'Last-Event-ID': '1' },
  });
  assert.equal(replay.status, 200);
  const events = replay.text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(
    events.map(({ seq, kind }) => [seq, kind]),
    [
      [2, 'text'],
      [3, 'done'],
    ],
  );
  assert.equal(control.cancelCalls, 0);
});

test('LAN control can create, resume, stream and stop runs with the original JSON payload', async (t) => {
  const { api, authenticate, cwd, port, runtime } = await fixture(t, { readOnly: false });
  const headers = {
    Cookie: await authenticate(),
    Origin: `http://127.0.0.1:${port}`,
    'Content-Type': 'application/json; charset=utf-8',
  };
  const bootstrap = await api('/api/bootstrap', { headers });
  assert.equal(bootstrap.json.preferences.readOnly, false);
  assert.equal(bootstrap.json.preferences.remote, true);
  // Full control keeps the PC folder picker (the dialog opens on the PC screen).
  assert.equal(bootstrap.json.preferences.directoryPicker, process.platform === 'win32');
  // pick-directory is exercised with a stubbed picker in the full-control inventory test below.
  const page = await api('/', { headers });
  assert.equal(page.headers['referrer-policy'], 'same-origin');
  for (const sessionId of [undefined, 'native-session']) {
    const message = 'Un message depuis le téléphone : éà & "citations"\nDeuxième ligne.';
    const started = await api('/api/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ cwd, message, sessionId, model: 'fixture/no-provider', thinking: 'low' }),
    });
    assert.equal(started.status, 201, started.text);
    const control = runtime.controls.at(-1);
    assert.equal(control.input.message, message);
    assert.equal(control.input.cwd, cwd);
    assert.equal(control.input.sessionId, sessionId);
    assert.equal(control.input.model, 'fixture/no-provider');
    assert.equal(control.input.thinking, 'low');
    if (sessionId) assert.match(control.input.sessionFile, /native-session\.jsonl$/);
    control.emit({ kind: 'text', delta: 'Réponse mobile' });
    const stopped = await api(`/api/runs/${started.json.id}/stop`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(stopped.status, 200, stopped.text);
    assert.equal(stopped.json.status, 'stopped');
    assert.equal(control.cancelCalls, 1);
    const replay = await api(`/api/runs/${started.json.id}/events`, { headers });
    assert.equal(replay.status, 200);
    assert.match(replay.text, /Réponse mobile/);
    assert.match(replay.text, /"status":"stopped"/);
  }
});

test('LAN control can manage project and session metadata and check a project folder', async (t) => {
  const { api, authenticate, cwd } = await fixture(t, { readOnly: false });
  const headers = { Cookie: await authenticate(), 'Content-Type': 'application/json' };
  const directory = await api(`/api/check-cwd?cwd=${encodeURIComponent(cwd)}`, { headers });
  assert.equal(directory.status, 200);
  assert.equal(directory.json.exists, true);
  for (const method of ['POST', 'PATCH']) {
    const project = await api('/api/projects', {
      method,
      headers,
      body: JSON.stringify({ cwd, name: 'Atelier mobile', pinned: true }),
    });
    assert.equal(project.status, method === 'POST' ? 201 : 200, project.text);
  }
  const edited = await api('/api/sessions', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      id: 'native-session',
      title: 'Session du téléphone',
      pinned: true,
      archived: true,
    }),
  });
  assert.equal(edited.status, 200, edited.text);
  const overview = (await api('/api/overview', { headers })).json;
  const project = overview.projects.find((p) => p.cwd === cwd);
  assert.equal(project.name, 'Atelier mobile');
  assert.equal(project.pinned, true);
  assert.equal(project.sessions[0].title, 'Session du téléphone');
  assert.equal(project.sessions[0].pinned, true);
  assert.equal(project.sessions[0].archived, true);
});

test('mobile subagent defaults are limited to a known project and preserve global settings and running agents', async (t) => {
  for (const readOnly of [false, true]) {
    const f = await fixture(t, { readOnly });
    await f.local('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: f.cwd, message: 'Keep working during settings changes' }),
    });
    await until(() => f.runtime.controls.length === 1);
    const cookie = await f.authenticate();
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    const path = `/api/project-subagent-defaults?cwd=${encodeURIComponent(f.cwd)}`;
    assert.equal((await f.api(path)).status, 401);
    assert.equal((await f.api('/api/project-subagent-defaults', { headers })).status, 400);
    assert.equal(
      (
        await f.api(`/api/project-subagent-defaults?cwd=${encodeURIComponent(join(f.cwd, 'unknown'))}`, {
          headers,
        })
      ).status,
      404,
    );
    const initial = (await f.api(path, { headers })).json;
    const saved = await f.api(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ revision: initial.revision, policy: { model: '', thinking: 'low' } }),
    });
    assert.equal(saved.status, readOnly ? 405 : 200);
    if (!readOnly) {
      assert.deepEqual(saved.json.project, { model: '', thinking: 'low' });
      assert.deepEqual(saved.json.global, initial.global);
      assert.equal(
        (
          await f.api('/api/project-subagent-defaults', {
            method: 'POST',
            headers,
            body: JSON.stringify({ revision: saved.json.revision, policy: { model: '', thinking: 'high' } }),
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await f.api(path, {
            method: 'POST',
            headers,
            body: JSON.stringify({ revision: initial.revision, policy: null }),
          })
        ).status,
        409,
      );
      const reset = await f.api(path, {
        method: 'POST',
        headers,
        body: JSON.stringify({ revision: saved.json.revision, policy: null }),
      });
      assert.equal(reset.status, 200);
      assert.equal(reset.json.project, null);
      assert.deepEqual(reset.json.effective, initial.global);
    }
    // Global subagent defaults: full control reaches them, consultation stays hidden.
    assert.equal((await f.api('/api/subagent-defaults', { headers })).status, readOnly ? 404 : 200);
    assert.equal(f.runtime.controls[0].cancelCalls, 0);
    assert.equal((await f.local('/api/runs')).json.runs.length, 1);
  }
});

test('LAN control authenticates and validates writes before reaching the agent', async (t) => {
  const { api, authenticate, runtime, cwd } = await fixture(t, { readOnly: false });
  const cookie = await authenticate();
  const valid = { Cookie: cookie, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ cwd, message: 'Must not run' });
  for (const [headers, status] of [
    [{ 'Content-Type': 'application/json' }, 401],
    [{ ...valid, Cookie: 'prime_studio_lan=forged' }, 401],
    [{ ...valid, Host: 'attacker.example' }, 403],
    [{ ...valid, Origin: 'null' }, 403],
    [{ ...valid, Origin: 'https://attacker.example' }, 403],
    [{ ...valid, 'Sec-Fetch-Site': 'cross-site' }, 403],
    [{ ...valid, 'Content-Type': 'text/plain' }, 415],
    [{ ...valid, 'Content-Type': 'application/x-www-form-urlencoded' }, 415],
    [{ ...valid, 'Content-Type': 'application/jsonp' }, 415],
  ]) {
    assert.equal((await api('/api/runs', { method: 'POST', headers, body })).status, status);
  }
  for (const invalid of ['{broken', '[]', 'null', '"hello"']) {
    assert.equal((await api('/api/runs', { method: 'POST', headers: valid, body: invalid })).status, 400);
  }
  const large = JSON.stringify({ cwd, message: 'x'.repeat(512 * 1024) });
  assert.equal((await api('/api/runs', { method: 'POST', headers: valid, body: large })).status, 413);
  // Unknown routes and lifecycle/health endpoints stay private even for full control.
  for (const [method, path] of [
    ['POST', '/api/health'],
    ['GET', '/api/health'],
    ['POST', '/api/bootstrap'],
    ['DELETE', '/api/sessions'],
    ['PATCH', '/api/runs'],
    ['POST', '/public/app.js'],
    ['GET', '/.local/lan-access.json'],
  ]) {
    assert.equal(
      (await api(path, { method, headers: valid, ...(method !== 'GET' ? { body: '{}' } : {}) })).status,
      404,
    );
  }
  // Full control now reaches former local-only routes (never 404 here; validation runs first).
  for (const [method, path, bodyOverride] of [
    ['GET', '/api/model-config'],
    ['POST', '/api/model-config', '{}'],
    ['DELETE', '/api/model-config', '{}'],
    ['GET', '/api/model-defaults'],
    ['POST', '/api/model-defaults', '{}'],
    ['GET', '/api/subagent-defaults'],
    ['POST', '/api/subagent-defaults', '{}'],
    ['GET', '/api/engine-settings'],
    ['GET', '/api/studio-preferences'],
    ['GET', '/api/desktop-notifications'],
    ['GET', '/api/system'],
    ['GET', '/api/remote-access'],
    ['GET', '/api/remote-access/network'],
    ['GET', '/api/sync'],
    ['GET', '/api/worktrees'],
  ]) {
    const probed = await api(path, {
      method,
      headers: valid,
      ...(method !== 'GET' ? { body: bodyOverride || '{}' } : {}),
    });
    assert.notEqual(probed.status, 404, `${method} ${path}`);
  }
  assert.equal(runtime.controls.length, 0);
  assert.equal((await api('/api/bootstrap', { headers: valid })).status, 200);
});

test('LAN full control reaches former local-only routes, consultation stays blocked, secrets never leak', async (t) => {
  const full = await fixture(
    t,
    { readOnly: false },
    {
      directoryPicker: { pick: async () => ({ cwd: null }), close: () => {} },
      openDirectory: async () => ({ opened: true }),
      openTerminal: async () => ({ opened: true }),
      openFile: async () => ({ opened: true }),
    },
  );
  const ro = await fixture(t, { readOnly: true });
  const fullHeaders = { Cookie: await full.authenticate(), 'Content-Type': 'application/json' };
  const roHeaders = { Cookie: await ro.authenticate(), 'Content-Type': 'application/json' };
  const noSecrets = (value) => {
    const text = JSON.stringify(value || {});
    for (const secret of [ACCESS_CODE, full.config.salt, full.config.codeHash])
      assert.equal(text.includes(secret), false);
    // Stored keys are never echoed: only names, revisions and presence flags.
    assert.equal(
      /secretAccessKey|secret_access|api_key\s*[:=]\s*[A-Za-z0-9]{8}|passphrase/i.test(text) &&
        text.includes('secretAccessKey":"'),
      false,
    );
    assert.equal(text.includes('sk-'), false);
  };
  // Reads allowed for full control.
  for (const path of [
    '/api/providers',
    '/api/model-config',
    '/api/model-defaults',
    '/api/subagent-defaults',
    `/api/subagent-defaults?cwd=${encodeURIComponent(full.cwd)}`,
    '/api/engine-settings',
    '/api/studio-preferences',
    '/api/desktop-notifications',
    '/api/system',
    '/api/remote-access',
    '/api/remote-access/network',
    '/api/sync',
    `/api/worktrees?cwd=${encodeURIComponent(full.cwd)}`,
  ]) {
    const response = await full.api(path, { headers: fullHeaders });
    assert.notEqual(response.status, 404, `full GET ${path}`);
    noSecrets(response.json ?? response.text);
  }
  // Context is available on authenticated phones with full control only.
  const contextPath = `/api/projects/${metricsProjectId(full.cwd)}/context`;
  assert.equal((await full.api(contextPath, { headers: fullHeaders })).status, 200);
  for (const [method, suffix, body] of [
    ['PATCH', '', '{"enabled":false}'],
    ['POST', '/search', '{"q":"fixture"}'],
    ['POST', '/rebuild', '{}'],
  ]) {
    const response = await full.api(contextPath + suffix, { method, headers: fullHeaders, body });
    assert.ok((suffix === '/rebuild' ? [409] : [200, 202]).includes(response.status), `${method} ${suffix}: ${response.text}`);
  }
  const roContext = `/api/projects/${metricsProjectId(ro.cwd)}/context`;
  assert.equal((await ro.api(roContext, { headers: roHeaders })).status, 404);
  assert.equal((await ro.api(roContext + '/events', { headers: roHeaders })).status, 404);
  assert.equal((await ro.api(roContext, { method: 'PATCH', headers: roHeaders, body: '{"enabled":false}' })).status, 405);
  // Providers list exposes metadata only, never stored keys.
  const providers = (await full.api('/api/providers', { headers: fullHeaders })).json;
  assert.ok(Array.isArray(providers.providers));
  noSecrets(providers);
  for (const entry of providers.providers) {
    assert.equal('key' in entry, false);
    assert.equal('apiKey' in entry, false);
  }
  // Sync status exposes presence flags only.
  const sync = (await full.api('/api/sync', { headers: fullHeaders })).json;
  assert.equal('secretAccessKey' in sync, false);
  assert.equal('passphrase' in sync, false);
  noSecrets(sync);
  // Archives export proves gateway routing (fixture data may fail validation with 500, never gateway 404).
  const validExport = await full.api(`/api/project-archives/export?cwd=${encodeURIComponent(full.cwd)}`, {
    headers: fullHeaders,
  });
  assert.notEqual(validExport.status, 404, validExport.text.slice(0, 300));
  noSecrets(validExport.text.slice(0, 2000));
  // Octet-stream preview rejects JSON bodies and empty uploads without routing gaps.
  const previewJson = await full.api('/api/project-archives/preview', {
    method: 'POST',
    headers: fullHeaders,
    body: '{}',
  });
  assert.equal(previewJson.status, 415);
  // Writes allowed for full control (validation first, never 404).
  for (const [method, path, body] of [
    ['POST', '/api/providers/key', '{}'],
    ['POST', '/api/providers/disconnect', '{}'],
    ['POST', '/api/providers/login', '{}'],
    ['POST', '/api/model-config', '{}'],
    ['DELETE', '/api/model-config', '{}'],
    ['POST', '/api/model-defaults', '{}'],
    ['POST', '/api/subagent-defaults', '{}'],
    ['POST', '/api/engine-settings', '{}'],
    ['PATCH', '/api/studio-preferences', '{}'],
    ['POST', '/api/passkeys/revoke', '{}'],
    ['POST', '/api/remote-access/code', '{}'],
    ['POST', '/api/remote-access/network', '{}'],
    ['PUT', '/api/sync', '{}'],
    ['DELETE', '/api/sync', undefined],
    ['POST', '/api/sync/session', '{}'],
    ['POST', '/api/sync/run', '{}'],
    ['POST', '/api/projects/pick-directory', '{}'],
    ['POST', '/api/projects/git-align', '{}'],
    ['POST', '/api/system/logs', '{}'],
    ['POST', '/api/worktrees', '{}'],
  ]) {
    const response = await full.api(path, {
      method,
      headers: fullHeaders,
      ...(body !== undefined ? { body } : {}),
    });
    assert.notEqual(response.status, 404, `full ${method} ${path}`);
    noSecrets(response.json ?? response.text);
  }
  // PC-screen actions succeed through stubs (they open on the PC).
  assert.equal(
    (await full.api('/api/projects/pick-directory', { method: 'POST', headers: fullHeaders, body: '{}' }))
      .status,
    200,
  );
  assert.equal(
    (await full.api('/api/system/logs', { method: 'POST', headers: fullHeaders, body: '{}' })).status,
    200,
  );
  // Provider OAuth job lifecycle stays reachable for full control.
  const loginJob = await full.api('/api/providers/login', {
    method: 'POST',
    headers: fullHeaders,
    body: '{}',
  });
  assert.notEqual(loginJob.status, 404);
  // Consultation stays read-only exactly as before: writes blocked, former local routes hidden.
  for (const [method, path, body] of [
    ['GET', '/api/providers', undefined],
    ['GET', '/api/model-config', undefined],
    ['GET', '/api/model-defaults', undefined],
    ['GET', '/api/subagent-defaults', undefined],
    ['GET', '/api/engine-settings', undefined],
    ['GET', '/api/studio-preferences', undefined],
    ['GET', '/api/desktop-notifications', undefined],
    ['GET', '/api/system', undefined],
    ['GET', '/api/remote-access', undefined],
    ['GET', '/api/remote-access/network', undefined],
    ['GET', '/api/sync', undefined],
    ['GET', '/api/worktrees', undefined],
    ['POST', '/api/providers/key', '{}'],
    ['POST', '/api/model-config', '{}'],
    ['POST', '/api/engine-settings', '{}'],
    ['PATCH', '/api/studio-preferences', '{}'],
    ['PUT', '/api/sync', '{}'],
    ['POST', '/api/sync/run', '{}'],
    ['POST', '/api/projects/pick-directory', '{}'],
    ['POST', '/api/system/logs', '{}'],
    ['POST', '/api/worktrees', '{}'],
  ]) {
    const response = await ro.api(path, {
      method,
      headers: roHeaders,
      ...(body !== undefined ? { body } : {}),
    });
    assert.ok([404, 405].includes(response.status), `consultation ${method} ${path} got ${response.status}`);
  }
  // Health metadata never leaves the PC, even for full control.
  assert.equal((await full.api('/api/health', { headers: fullHeaders })).status, 404);
});

test('goal and voice writes retain independent authenticated full-control and origin gates', async (t) => {
  for (const readOnly of [false, true]) {
    const mutations = [];
    const f = await fixture(
      t,
      { readOnly },
      {
        goalService: {
          get: async () => ({ goal: null, editable: false }),
          update: async (_id, body) => {
            mutations.push(body);
            return { goal: null };
          },
          busy: () => false,
        },
      },
    );
    const headers = { Cookie: await f.authenticate(), 'Content-Type': 'application/json' };
    const routes = [
      ['/api/sessions/native-session/goal', { objective: 'Synthetic goal draft' }],
      ['/api/voice/settings', { timeoutMs: 600000 }],
    ];
    for (const [path, data] of routes) {
      const body = JSON.stringify(data);
      assert.equal(
        (await f.api(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }))
          .status,
        401,
      );
      assert.equal(
        (
          await f.api(path, {
            method: 'PATCH',
            headers: { ...headers, Origin: 'https://untrusted.example' },
            body,
          })
        ).status,
        403,
      );
      assert.equal((await f.api(path, { method: 'PATCH', headers, body })).status, readOnly ? 405 : 200);
    }
    assert.equal(mutations.length, readOnly ? 0 : 1);
    const voice = await f.local('/api/voice/settings');
    assert.equal(voice.status, 200);
    assert.equal(voice.json.timeoutMs, readOnly ? 90000 : 600000);
    assert.equal(f.runtime.controls.length, 0, 'Settings and goal edits never start a model turn');
  }
});

test('routing and budget preferences require authenticated full control over LAN', async (t) => {
  for (const readOnly of [false, true]) {
    const f = await fixture(t, { readOnly });
    const Cookie = await f.authenticate();
    for (const path of ['/api/quota-fallback', '/api/budgets']) {
      assert.equal((await f.api(path)).status, 401);
      const state = await f.api(path, { headers: { Cookie } });
      assert.equal(state.status, readOnly ? 404 : 200, state.text);
      const write = await f.api(path, { method: 'PUT', body: JSON.stringify(state.json),
        headers: { Cookie, 'Content-Type': 'application/json' } });
      assert.equal(write.status, readOnly ? 405 : 200, write.text);
    }
    const retry = await f.api('/api/runs/00000000-0000-0000-0000-000000000000/quota-retry', {
      method: 'POST', body: JSON.stringify({ model: 'test/model' }),
      headers: { Cookie, 'Content-Type': 'application/json' },
    });
    assert.equal(retry.status, readOnly ? 405 : 404);
  }
});
