import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createMcpConfigStore, mcpRevision } from '../lib/mcp-config.mjs';
import { createMcpService } from '../lib/mcp-service.mjs';
import { createModelDefaultsStore } from '../lib/model-defaults.mjs';
import { discoverCli } from '../lib/agent.mjs';
import { localKernelPython } from '../lib/kernel.mjs';

const python =
  process.env.PRIME_AGENT_KERNEL_PYTHON || localKernelPython(process.env.PRIME_AGENT_GUI_KERNEL_ROOT);
const installed = !!discoverCli()?.packageDir;
const nativeOnly = { skip: !installed && 'Prime Agent natif non installé' };
const kernelOnly = { skip: (!installed || !existsSync(python)) && 'Moteur Prime Agent absent' };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(fn) {
  for (let i = 0; i < 160; i++) {
    const value = await fn();
    if (value) return value;
    await wait(100);
  }
  assert.fail('MCP fixture timed out');
}
async function fixture(t, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-mcp-'));
  const agentHome = join(root, 'agent');
  await mkdir(agentHome);
  const file = join(agentHome, 'settings.json');
  await writeFile(file, JSON.stringify(settings));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const store = createMcpConfigStore({ agentHome, env: {} });
  const read = async () => JSON.parse(await readFile(file, 'utf8'));
  const row = async (name) => (await store.list()).servers.find((s) => s.name === name);
  return { root, agentHome, file, store, read, row };
}
test(
  'native MCP settings merge with simultaneous model edits, persist, and redact secrets',
  nativeOnly,
  async (t) => {
    const f = await fixture(t, { theme: 'test', unknown: { keep: 42 } });
    const models = createModelDefaultsStore({ agentHome: f.agentHome });
    await Promise.all([
      f.store.upsert({
        name: 'private',
        config: {
          type: 'http',
          url: 'https://service.test/mcp?key=private-url',
          headers: { Authorization: 'private-header' },
        },
      }),
      models.set({ provider: 'fixture', id: 'luna' }),
      f.store.upsert({
        name: 'local',
        config: { type: 'stdio', command: 'node', env: { TOKEN: { env: 'FIXTURE_TOKEN' } } },
      }),
    ]);
    assert.deepEqual((await f.read()).unknown, { keep: 42 });
    assert.equal((await f.read()).defaultModel, 'luna');
    const row = await f.row('private');
    assert.equal(row.config.url, 'https://service.test/mcp');
    assert.equal(row.config.headers.Authorization, null);
    assert.doesNotMatch(JSON.stringify(await f.store.list()), /private-url|private-header/);
    const { privateUrlParameters, ...config } = row.config;
    assert.equal(privateUrlParameters, true);
    await f.store.upsert({
      name: row.name,
      revision: row.revision,
      config: { ...config, disabledTools: ['delete'] },
    });
    assert.equal((await f.read()).mcpServers.private.headers.Authorization, 'private-header');
    assert.equal((await f.read()).mcpServers.private.url, 'https://service.test/mcp?key=private-url');
    assert.equal((await f.row('local')).status, 'missing-env');
    await assert.rejects(f.store.toggle({ name: row.name, revision: row.revision, enabled: false }), {
      status: 409,
    });
    const updated = await f.row('private');
    await assert.rejects(
      f.store.upsert({
        name: row.name,
        revision: updated.revision,
        config: { ...config, url: 'https://other.test/' },
      }),
      { status: 400 },
    );
    await f.store.toggle({ name: row.name, revision: updated.revision, enabled: false });
    assert.equal((await f.row(row.name)).status, 'disabled');
    assert.equal((await f.read()).mcpServers.private.headers.Authorization, 'private-header');
    const reopened = createMcpConfigStore({ agentHome: f.agentHome });
    assert.equal((await reopened.list()).servers.find((s) => s.name === 'private').status, 'disabled');
  },
);
test(
  'MCP validation rejects malformed input while broken entries remain removable and secrets stay private',
  nativeOnly,
  async (t) => {
    const f = await fixture(t, {
      mcpServers: {
        broken: null,
        legacy: {
          type: 'stdio',
          command: 'node',
          env: { TOKEN: 'private-old-value' },
          unknownSecret: 'private-extra-value',
        },
      },
    });
    const list = await f.store.list();
    assert.equal(list.servers.find((s) => s.name === 'broken').status, 'invalid');
    assert.doesNotMatch(JSON.stringify(list), /private-old|private-extra/);
    await f.store.remove({ name: 'broken', revision: mcpRevision(null) });
    assert.equal(Object.hasOwn((await f.read()).mcpServers, 'broken'), false);
    for (const config of [
      { type: 'sse', url: 'https://example.test/' },
      { type: 'http', url: 'file:///test' },
      { type: 'http', url: 'https://user:password@example.test/' },
      { type: 'http', url: 'http://example.test/', oauth: true },
      { type: 'http', url: 'https://example.test/', bearerTokenEnvVar: true },
      { type: 'http', url: 'https://example.test/', bearerTokenEnvVar: '' },
      { type: 'stdio', command: 'node', env: { TOKEN: {} } },
      { type: 'stdio', command: 'node', env: { TOKEN: { env: 'A', value: 'B' } } },
      { type: 'stdio', command: 'node', env: { TOKEN: 'secret' } },
      { type: 'stdio', command: 'node', cwd: true },
      { type: 'stdio', command: 'node', startupTimeoutMs: 0 },
      { type: 'http', url: 'https://example.test/', headers: { Authorization: 'a\r\nb' } },
    ])
      await assert.rejects(f.store.upsert({ name: 'invalid', config }), { status: 400 });
    await assert.rejects(f.store.upsert({ name: '__proto__', config: { type: 'stdio', command: 'node' } }), {
      status: 400,
    });
    await assert.rejects(f.store.upsert({ name: 'linear', config: { type: 'stdio', command: 'node' } }), {
      status: 400,
    });
    const broken = '{"mcpServers":';
    await writeFile(f.file, broken);
    await assert.rejects(f.store.upsert({ name: 'valid', config: { type: 'stdio', command: 'node' } }), {
      status: 500,
    });
    assert.equal(await readFile(f.file, 'utf8'), broken);
  },
);
test(
  'OAuth credentials follow exact endpoints and removal preserves other accounts and built-in integrations',
  nativeOnly,
  async (t) => {
    const f = await fixture(t);
    await f.store.upsert({
      name: 'custom',
      config: { type: 'http', url: 'https://fixture.test/mcp', oauth: true },
    });
    let row = await f.row('custom');
    const authFile = join(f.agentHome, 'auth.json');
    const other = { type: 'api_key', key: 'untouched-private-account' };
    await writeFile(authFile, JSON.stringify({ fixtureModel: other }));
    await f.store.saveCredential('custom', row.revision, {
      access: 'private-access',
      refresh: 'private-refresh',
      endpoint: row.config.url,
      expires: Date.now() + 600000,
    });
    assert.equal((await f.row('custom')).authenticated, true);
    assert.doesNotMatch(
      JSON.stringify(await f.store.list()),
      /private-access|private-refresh|untouched-private/,
    );
    await f.store.toggle({ name: 'custom', revision: row.revision, enabled: false });
    row = await f.row('custom');
    assert.equal(row.authenticated, true);
    await f.store.upsert({
      name: 'custom',
      revision: row.revision,
      config: { ...row.config, url: 'https://new.test/mcp' },
    });
    assert.equal((await f.row('custom')).authenticated, false);
    assert.deepEqual(JSON.parse(await readFile(authFile, 'utf8')).fixtureModel, other);
    await assert.rejects(
      f.store.saveCredential('custom', row.revision, { access: 'stale', endpoint: row.config.url }),
      { status: 409 },
    );
    const builtin = await f.row('linear');
    await f.store.saveCredential('linear', builtin.revision, {
      access: 'builtin-private',
      endpoint: builtin.config.url,
    });
    const settings = await f.read();
    settings.mcpServers.linear = { type: 'stdio', command: 'node' };
    await writeFile(f.file, JSON.stringify(settings));
    const shadow = await f.row('linear');
    assert.equal(shadow.status, 'reserved');
    await assert.rejects(f.store.get('linear'), { status: 400 });
    await f.store.remove({ name: 'linear', revision: shadow.revision });
    assert.equal((await f.row('linear')).authenticated, true);
    await f.store.disconnect({ name: 'linear', revision: builtin.revision });
    assert.equal((await f.row('linear')).authenticated, false);
  },
);
test(
  'real native stdio probe resolves environment, filters tools and closes only its own hidden processes',
  kernelOnly,
  async (t) => {
    const f = await fixture(t),
      audit = join(f.root, 'audit.jsonl'),
      children = [];
    const service = createMcpService({
      agentHome: f.agentHome,
      python,
      environment: { ...process.env, MCP_TEST_TOKEN: 'fixture-private-token' },
      spawnProcess(command, args, options) {
        assert.equal(options.windowsHide, true);
        assert.equal(options.shell, false);
        const child = spawn(command, args, options);
        children.push(child);
        return child;
      },
    });
    t.after(() => service.close());
    await service.upsert({
      name: 'stdio',
      config: {
        type: 'stdio',
        command: process.execPath,
        args: [resolve('test/fixtures/mcp-server.mjs'), audit],
        cwd: f.root,
        env: { TOKEN: { env: 'MCP_TEST_TOKEN' } },
        disabledTools: ['delete'],
      },
    });
    const row = await f.row('stdio');
    const result = await service.probe({ name: 'stdio', revision: row.revision });
    assert.deepEqual(
      result.tools.map((t) => t.name),
      ['lookup'],
    );
    const records = (await readFile(audit, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records[0].environmentResolved, true);
    assert.equal(records[0].cwd, f.root);
    assert.deepEqual(
      records.slice(1).map((r) => r.method),
      ['initialize', 'notifications/initialized', 'tools/list'],
    );
    for (const child of children) assert.notEqual(child.exitCode, null);
    await until(() => {
      try {
        process.kill(records[0].pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  },
);
test(
  'real native HTTP probe sends private headers, lists tools, closes transport and bounds failures',
  kernelOnly,
  async (t) => {
    const f = await fixture(t),
      methods = [],
      headers = [],
      sockets = new Set();
    const server = createServer(async (req, res) => {
      headers.push(req.headers.authorization);
      if (req.url === '/hang') return;
      if (req.method !== 'POST') {
        res.writeHead(req.method === 'DELETE' ? 200 : 405);
        res.end();
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const message = JSON.parse(raw);
      methods.push(message.method);
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'http-fixture', version: '1' },
            }
          : { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'fixture-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => server.close(done));
    });
    const service = createMcpService({ agentHome: f.agentHome, python });
    t.after(() => service.close());
    const url = `http://127.0.0.1:${server.address().port}`;
    await service.upsert({
      name: 'http',
      config: { type: 'http', url: url + '/mcp', headers: { Authorization: 'Bearer fixture-private-token' } },
    });
    let row = await f.row('http');
    const result = await service.probe({ name: row.name, revision: row.revision });
    assert.equal(result.total, 1);
    assert.equal(methods.includes('tools/call'), false);
    assert.equal(methods.includes('tools/list'), true);
    assert.ok(headers.every((value) => value === 'Bearer fixture-private-token'));
    await service.upsert({
      name: 'http',
      revision: row.revision,
      config: { type: 'http', url: url + '/hang', startupTimeoutMs: 1000 },
    });
    row = await f.row('http');
    const started = Date.now();
    await assert.rejects(
      service.probe({ name: row.name, revision: row.revision }),
      (error) => [502, 504].includes(error.status) && !/fixture-private/.test(error.message),
    );
    assert.ok(Date.now() - started < 9000);
  },
);
test(
  'native HTTPS OAuth uses PKCE, validates mobile return URLs, stores credentials and cancels cleanly',
  kernelOnly,
  async (t) => {
    const f = await fixture(t);
    await promisify(execFile)(python, [resolve('test/fixtures/mcp-certificate.py'), f.root], {
      windowsHide: true,
    });
    let origin,
      challenge,
      exchanges = 0;
    const children = [];
    const server = createHttpsServer(
      { key: await readFile(join(f.root, 'key.pem')), cert: await readFile(join(f.root, 'cert.pem')) },
      async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const json = (data) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        if (req.url === '/.well-known/oauth-protected-resource/mcp')
          return json({ resource: origin + '/mcp', authorization_servers: [origin] });
        if (req.url.startsWith('/.well-known/oauth-authorization-server'))
          return json({
            issuer: origin,
            authorization_endpoint: origin + '/authorize',
            token_endpoint: origin + '/token',
            registration_endpoint: origin + '/register',
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
          });
        if (req.url === '/register') {
          // RFC 7591 + SDK FullSchema require redirect_uris in the response;
          // echo the request's URIs (0.9.6 rejects a bare client_id).
          let requested = {};
          try {
            requested = JSON.parse(raw);
          } catch {}
          return json({
            client_id: 'fixture-client',
            redirect_uris: requested.redirect_uris || ['http://localhost:53700/callback'],
          });
        }
        if (req.url === '/token') {
          exchanges++;
          const form = new URLSearchParams(raw);
          assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), challenge);
          assert.equal(form.get('resource'), origin + '/mcp');
          return json({
            access_token: 'fixture-oauth-access',
            refresh_token: 'fixture-oauth-refresh',
            expires_in: 3600,
            token_type: 'Bearer',
          });
        }
        res.writeHead(401);
        res.end();
      },
    );
    await new Promise((done) => server.listen(0, 'localhost', done));
    origin = `https://localhost:${server.address().port}`;
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    const service = createMcpService({
      agentHome: f.agentHome,
      environment: { ...process.env, NODE_EXTRA_CA_CERTS: join(f.root, 'cert.pem') },
      spawnProcess(...args) {
        const child = spawn(...args);
        children.push(child);
        return child;
      },
    });
    t.after(async () => {
      service.close();
      await until(() => children.every((c) => c.exitCode !== null));
    });
    await service.upsert({ name: 'oauth', config: { type: 'http', url: origin + '/mcp', oauth: true } });
    const row = await f.row('oauth'),
      input = { name: row.name, revision: row.revision };
    const first = await service.login(input);
    const job = await until(() => {
      const s = service.job(first.id);
      assert.notEqual(s.status, 'error', s.error);
      return s.status === 'waiting' && s;
    });
    const authUrl = new URL(job.url);
    challenge = authUrl.searchParams.get('code_challenge');
    assert.ok(challenge);
    assert.notEqual(challenge, authUrl.searchParams.get('state'));
    await assert.rejects(service.login(input), { status: 409 });
    assert.throws(() => service.toggle({ ...input, enabled: false }), { status: 409 });
    const returned = new URL(authUrl.searchParams.get('redirect_uri'));
    returned.searchParams.set('code', 'fixture-code');
    returned.searchParams.set('state', 'wrong');
    assert.throws(() => service.complete({ id: job.id, url: returned.toString() }), { status: 400 });
    assert.throws(() => service.complete({ id: job.id, url: 'fixture-code' }), { status: 400 });
    returned.searchParams.set('state', authUrl.searchParams.get('state'));
    service.complete({ id: job.id, url: returned.toString() });
    await until(() => {
      const s = service.job(job.id);
      assert.notEqual(s.status, 'error', s.error);
      return s.status === 'complete';
    });
    assert.equal(exchanges, 1);
    assert.equal((await f.row('oauth')).authenticated, true);
    assert.doesNotMatch(JSON.stringify(service.job(job.id)), /fixture-oauth/);
    await service.disconnect(input);
    assert.equal((await f.row('oauth')).authenticated, false);
    const cancelled = await service.login(input);
    const waiting = await until(() => {
      const s = service.job(cancelled.id);
      return s.status === 'waiting' && s;
    });
    const callback = new URL(new URL(waiting.url).searchParams.get('redirect_uri'));
    service.cancel(cancelled.id);
    assert.equal(service.job(cancelled.id).status, 'cancelled');
    await until(() => children.every((c) => c.exitCode !== null));
    await assert.rejects(fetch(callback));
    assert.equal(exchanges, 1);
  },
);
