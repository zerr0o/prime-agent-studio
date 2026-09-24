import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:https';
import { createMcpConfigStore, builtinCatalog, mcpOAuthIdentity, mcpRevision } from '../lib/mcp-config.mjs';
import { discoverCli } from '../lib/agent.mjs';
import { localKernelPython } from '../lib/kernel.mjs';

// Configured target engine with the 0.9.6 MCP surface (service catalog +
// provider factory). Null on older/unsupported installs: native proof skips.
function targetEngine096() {
  const cli = discoverCli();
  if (!cli?.packageDir) return null;
  if (
    !existsSync(join(cli.packageDir, 'dist', 'core', 'mcp', 'service-catalog.js')) ||
    !existsSync(join(cli.packageDir, 'node_modules', '@earendil-works', 'pi-ai'))
  )
    return null;
  return cli.packageDir;
}
const python =
  process.env.PRIME_AGENT_KERNEL_PYTHON || localKernelPython(process.env.PRIME_AGENT_GUI_KERNEL_ROOT);

function stubNative(authData = new Map(), catalog = []) {
  return async () => ({
    BUILTIN_MCP_CATALOG: catalog,
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

async function fixture(t, settings = {}, env = {}, catalog = []) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-mcp096-'));
  const agentHome = join(root, 'agent');
  await mkdir(agentHome, { recursive: true });
  await writeFile(join(agentHome, 'settings.json'), JSON.stringify(settings));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const store = createMcpConfigStore({ agentHome, native: stubNative(new Map(), catalog), env });
  return { root, agentHome, store };
}

test('catalog contract stays truthful: unresolvable catalog is an incompatible-engine error', async (t) => {
  assert.throws(() => builtinCatalog({}), { status: 503 });
  assert.throws(() => builtinCatalog(null), { status: 503 });
  assert.throws(() => builtinCatalog({ BUILTIN_MCP_CATALOG: 'x' }), { status: 503 });
  assert.deepEqual(
    builtinCatalog({ BUILTIN_MCP_CATALOG: [{ server: 'x', url: 'https://x.test/' }] }).length,
    1,
  );
  // Missing native capability is never replaced with a silent empty catalog.
  const f = await fixture(t, {}, {}, []);
  await f.store.upsert({
    name: 'custom',
    config: { type: 'http', url: 'https://fixture.test/mcp', oauth: true },
  });
  const row = (await f.store.list()).servers.find((s) => s.name === 'custom');
  assert.equal(row.status, 'login-required');
});

test('0.9.6 per-server OAuth identity fields validate, persist and redact safely', async (t) => {
  const f = await fixture(t);
  const base = { type: 'http', url: 'https://service.test/mcp', oauth: true };
  await f.store.upsert({
    name: 'conf',
    config: {
      ...base,
      oauthClientId: 'my-client',
      oauthClientSecretEnvVar: 'MCP_TEST_SECRET',
      oauthClientMetadataUrl: 'https://client.test/meta.json',
      oauthScopes: ['read', 'write'],
    },
  });
  const row = (await f.store.list()).servers.find((s) => s.name === 'conf');
  assert.equal(row.config.oauthClientId, 'my-client');
  assert.equal(row.config.oauthClientSecretEnvVar, 'MCP_TEST_SECRET');
  assert.equal(row.config.oauthClientMetadataUrl, 'https://client.test/meta.json');
  assert.deepEqual(row.config.oauthScopes, ['read', 'write']);
  assert.doesNotMatch(JSON.stringify(row), /fixture-private/);
  for (const bad of [
    { oauthClientId: '' },
    { oauthClientSecretEnvVar: 'bad-name!' },
    { oauthClientSecretEnvVar: 'sbp_faketoken0123456789abcdef' },
    { oauthClientMetadataUrl: 'http://plain.test/meta' },
    { oauthClientMetadataUrl: 'https://client.test/' },
    { oauthScopes: [] },
    { oauthScopes: 'read' },
    { oauthScopes: ['ok', ''] },
    { oauthScopes: ['read write'] },
    { oauthScopes: ['ok\u0007'] },
    { oauthClientId: 'bad\u0001id' },
  ])
    await assert.rejects(f.store.upsert({ name: 'conf2', config: { ...base, ...bad } }), { status: 400 });
});

test('0.9.6 confidential identity mirrors native shape and never persists secrets', async (t) => {
  // Native contract: missing/empty secret env resolves to explicit "" and the
  // engine fails closed before any network request (no stale fallback).
  const httpBase = { type: 'http', url: 'https://s.test/mcp' };
  assert.deepEqual(mcpOAuthIdentity({ type: 'stdio', command: 'x' }, {}), {});
  assert.equal(
    mcpOAuthIdentity({ ...httpBase, oauthClientSecretEnvVar: 'MISSING_XYZ' }, {}).clientSecret,
    '',
  );
  assert.equal(
    mcpOAuthIdentity({ ...httpBase, oauthClientSecretEnvVar: 'MISSING_XYZ' }, { MISSING_XYZ: '   ' })
      .clientSecret,
    '',
  );
  const id = mcpOAuthIdentity(
    {
      type: 'http',
      url: 'https://s.test/mcp',
      oauthClientId: 'cid',
      oauthClientSecretEnvVar: 'S',
      oauthClientMetadataUrl: 'https://c.test/m.json',
      oauthScopes: ['a'],
    },
    { S: 'shh' },
  );
  assert.equal(id.clientSecret, 'shh');
  assert.equal(id.clientId, 'cid');
  assert.deepEqual(id.scopes, ['a']);
  const f = await fixture(t);
  await f.store.upsert({
    name: 's',
    config: { type: 'http', url: 'https://service.test/mcp', oauth: true, oauthClientSecretEnvVar: 'S' },
  });
  const raw = JSON.parse(await readFile(join(f.agentHome, 'settings.json'), 'utf8'));
  assert.equal(raw.mcpServers.s.oauthClientSecretEnvVar, 'S');
  assert.ok(!JSON.stringify(raw).includes('shh'));
});

test('0.9.6 catalog mapping: legacy built-ins plus user settings only, no picker reimplementation', async (t) => {
  const native = async () => ({
    ...(await stubNative(new Map(), [
      { server: 'legacy', label: 'Legacy', url: 'https://legacy.test/mcp', oauth: { kind: 'oauth' } },
    ])()),
    resolveMcpServiceCatalog: () => {
      throw new Error('The panel must not load the full service catalog');
    },
  });
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-mcp096map-'));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const agentHome = join(root, 'agent');
  await mkdir(agentHome, { recursive: true });
  await writeFile(
    join(agentHome, 'settings.json'),
    JSON.stringify({ mcpServers: { mine: { type: 'http', url: 'https://mine.test/mcp', oauth: true } } }),
  );
  const store = createMcpConfigStore({ agentHome, native, env: {} });
  const list = await store.list();
  // Minimal boundary: the legacy built-in plus the existing user server list.
  // Uninstalled catalog services (oauther, keyed) are NOT surfaced here; the
  // engine serves them via its generic MCP route, not this panel.
  for (const name of ['legacy', 'mine'])
    assert.ok(
      list.servers.some((s) => s.name === name),
      `missing ${name}`,
    );
  assert.ok(!list.servers.some((s) => s.name === 'oauther'), 'catalog picker leak');
  assert.ok(!list.servers.some((s) => s.name === 'keyed'), 'catalog picker leak');
  assert.equal(list.servers.find((s) => s.name === 'legacy').config.oauth, true);
  // Existing settings survive untouched.
  assert.equal(
    JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8')).mcpServers.mine.url,
    'https://mine.test/mcp',
  );
  // Legacy names stay reserved.
  await assert.rejects(store.upsert({ name: 'legacy', config: { type: 'stdio', command: 'node' } }), {
    status: 400,
  });
  // A user config may freely reuse a non-legacy catalog service name: it is a
  // plain custom entry with no builtin metadata attached.
  await store.upsert({
    name: 'oauther',
    config: { type: 'http', url: 'https://custom.test/mcp', oauth: true },
  });
  const gotten = await store.get('oauther');
  assert.equal(gotten.config.url, 'https://custom.test/mcp');
  assert.equal(gotten.builtin, undefined);
  // Changing that user endpoint drops its old stored credential (no catalog
  // name may shield a stale grant).
  const authData = new Map([
    ['mcp:oauther', { type: 'oauth', access: 'old', endpoint: 'https://custom.test/mcp' }],
  ]);
  const store2 = createMcpConfigStore({
    agentHome,
    native: async () => ({
      ...(await native()),
      AuthStorage: {
        create: () => ({
          get: (key) => authData.get(key),
          set: (key, value) => authData.set(key, value),
          removeVerified: (key) => authData.delete(key),
        }),
      },
    }),
    env: {},
  });
  const row = (await store2.list()).servers.find((s) => s.name === 'oauther');
  await store2.upsert({
    name: 'oauther',
    revision: row.revision,
    config: { type: 'http', url: 'https://moved.test/mcp', oauth: true },
  });
  assert.equal(authData.has('mcp:oauther'), false);
  // Secret env names drive missing-env status without leaking values.
  const secRow = {
    type: 'http',
    url: 'https://s.test/mcp',
    oauth: true,
    oauthClientSecretEnvVar: 'MCP096_MISSING',
  };
  await store.upsert({ name: 'secmode', config: secRow });
  const listed = (await store.list()).servers.find((s) => s.name === 'secmode');
  assert.deepEqual(listed.missingEnv, ['MCP096_MISSING']);
  assert.equal(listed.status, 'missing-env');
  assert.doesNotMatch(JSON.stringify(listed), /MCP096_VALUE/);
});

const engine096 = targetEngine096();
test('actual 0.9.6 preserves the native Linear/Notion catalog export', { skip: !engine096 }, async () => {
  const { loadPrimeNative } = await import('../lib/prime-native.mjs');
  const native = await loadPrimeNative();
  assert.equal(native.cli.packageDir, engine096);
  const catalog = builtinCatalog(native);
  assert.equal(catalog, native.BUILTIN_MCP_CATALOG);
  assert.deepEqual(catalog.map(({ server }) => server).sort(), ['linear', 'notion']);
});
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(fn, { tries = 200, interval = 100, label = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await wait(interval);
  }
  throw new Error(`${label} timed out`);
}

test(
  'native 0.9.6 DCR confidential login AND refresh send client_secret (real engine)',
  { timeout: 90000, skip: !engine096 && '0.9.6 engine unavailable' },
  async (t) => {
    const { execFile, spawn } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const root = await mkdtemp(join(tmpdir(), 'prime-studio-mcp096dcr-'));
    t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    if (!existsSync(python)) return t.skip('interpreter unavailable for fixtures');
    try {
      await run(python, [resolve('test/fixtures/mcp-certificate.py'), root], {
        windowsHide: true,
        timeout: 30000,
      });
    } catch {
      return t.skip('fixture python cannot create certificates');
    }
    const child = spawn(
      process.execPath,
      [resolve('scripts/mcp-096-dcr-proof.mjs'), engine096, join(root, 'cert.pem'), join(root, 'key.pem')],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, 'cert.pem') },
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let childError;
    child.once('error', (error) => {
      childError = error;
    });
    t.after(() => {
      try {
        child.kill();
      } catch {}
    });
    let output = '';
    child.stdout.on('data', (c) => {
      output += c;
    });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    const code = await new Promise((done) => {
      const kill = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        done(124);
      }, 60000);
      kill.unref?.();
      child.once('close', (c) => {
        clearTimeout(kill);
        done(c ?? 1);
      });
    });
    assert.equal(childError, undefined);
    const summary = JSON.parse(output.trim().split('\n').pop());
    assert.equal(code, 0, `DCR proof failed: ${output.slice(-1000)} ${stderr.slice(-500)}`);
    assert.equal(summary.identityStable, true);
    assert.equal(summary.publicIdentity, true);
    assert.equal(summary.exchangeSecret, true);
    assert.equal(summary.loginAccess, true);
    assert.equal(summary.refreshSecret, true);
    assert.equal(summary.refreshAccess, true);
    assert.equal(summary.dcrSecretPersisted, true);
    assert.equal(summary.grantUsable, true);
    assert.equal(summary.preNetworkFail, true);
    assert.equal(summary.ok, true);
  },
);

test(
  'native 0.9.6 configured secret identity matches Studio mirror (real engine)',
  { timeout: 30000, skip: !engine096 && '0.9.6 engine unavailable' },
  async (t) => {
    const { pathToFileURL } = await import('node:url');
    const sc = await import(pathToFileURL(join(engine096, 'dist', 'core', 'mcp', 'service-catalog.js')).href);
    const config = {
      type: 'http',
      url: 'https://conf.test/mcp',
      oauthClientId: 'cid',
      oauthClientSecretEnvVar: 'MCP096_MIRROR_CHECK',
      oauthClientMetadataUrl: 'https://c.test/m.json',
      oauthScopes: ['a', 'b'],
    };
    const native = sc.resolveMcpOAuthIdentity({ ...config });
    const previous = process.env.MCP096_MIRROR_CHECK;
    process.env.MCP096_MIRROR_CHECK = 'mirror-secret';
    try {
      const nativeSet = sc.resolveMcpOAuthIdentity({ ...config });
      const mirror = mcpOAuthIdentity({ ...config }, process.env);
      assert.deepEqual(mirror, nativeSet);
    } finally {
      if (previous === undefined) delete process.env.MCP096_MIRROR_CHECK;
      else process.env.MCP096_MIRROR_CHECK = previous;
    }
    assert.equal(native.clientSecret, '');
  },
);

test(
  'Studio worker plumbing: service login, manual complete, stored grant, worker refresh (real engine)',
  { timeout: 120000, skip: !engine096 && '0.9.6 engine unavailable' },
  async (t) => {
    if (!existsSync(python)) return t.skip('interpreter unavailable for fixtures');
    const { createMcpService } = await import('../lib/mcp-service.mjs');
    const { execFile, spawn } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const root = await mkdtemp(join(tmpdir(), 'prime-studio-mcp096worker-'));
    const agentHome = join(root, 'agent');
    await mkdir(agentHome, { recursive: true });
    await writeFile(join(agentHome, 'settings.json'), '{}');
    const previousCli = process.env.PRIME_AGENT_CLI;
    const previousCa = process.env.NODE_EXTRA_CA_CERTS;
    t.after(async () => {
      if (previousCli === undefined) delete process.env.PRIME_AGENT_CLI;
      else process.env.PRIME_AGENT_CLI = previousCli;
      if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = previousCa;
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    try {
      await run(python, [resolve('test/fixtures/mcp-certificate.py'), root], {
        windowsHide: true,
        timeout: 30000,
      });
    } catch {
      return t.skip('fixture python cannot create certificates');
    }
    process.env.PRIME_AGENT_CLI = join(engine096, 'dist', 'bundle', 'cli.js');
    process.env.NODE_EXTRA_CA_CERTS = join(root, 'cert.pem');
    const seen = [];
    let registration;
    const server = createServer(
      { key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) },
      async (req, res) => {
        let raw = '';
        for await (const c of req) raw += c;
        const url = new URL(req.url, 'https://localhost');
        const json = (st, d) => {
          res.writeHead(st, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(d));
        };
        const origin = `https://localhost:${server.address().port}`;
        if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
          return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        if (url.pathname === '/.well-known/oauth-authorization-server')
          return json(200, {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['client_secret_basic'],
          });
        if (url.pathname === '/register') {
          let requested = {};
          try {
            requested = JSON.parse(raw);
          } catch {}
          registration = {
            client_id: 'worker-proof-id',
            client_secret: 'worker-proof-secret',
            redirect_uris: requested.redirect_uris || ['http://localhost:53700/callback'],
            token_endpoint_auth_method: 'client_secret_basic',
          };
          return json(201, registration);
        }
        if (url.pathname === '/authorize') {
          const code = `code-${Math.random().toString(36).slice(2)}`;
          res.writeHead(302, {
            Location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}`,
          });
          return res.end();
        }
        if (url.pathname === '/token') {
          const form = new URLSearchParams(raw);
          const header = req.headers.authorization || '';
          let secret;
          if (header.startsWith('Basic '))
            secret = Buffer.from(header.slice(6), 'base64').toString().split(':')[1];
          else secret = form.get('client_secret');
          const authed = secret === registration?.client_secret;
          seen.push({ grant: form.get('grant_type'), authed });
          if (!authed) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'invalid_client' }));
          }
          if (form.get('grant_type') === 'authorization_code')
            return json(200, {
              access_token: 'worker-access-1',
              refresh_token: 'worker-refresh-1',
              token_type: 'Bearer',
              expires_in: 3600,
            });
          if (form.get('grant_type') === 'refresh_token')
            return json(200, {
              access_token: 'worker-access-2',
              refresh_token: 'worker-refresh-2',
              token_type: 'Bearer',
              expires_in: 3600,
            });
          return json(400, { error: 'unsupported_grant_type' });
        }
        res.writeHead(404);
        res.end();
      },
    );
    // Local HTTPS fake only; never a real browser or account.
    await new Promise((done) => server.listen(0, 'localhost', done));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    });
    const origin = `https://localhost:${server.address().port}`;
    const service = createMcpService({ agentHome });
    t.after(() => service.close());
    await service.upsert({
      name: 'workerproof',
      config: { type: 'http', url: `${origin}/mcp`, oauth: true },
    });
    const row = (await service.list()).servers.find((s) => s.name === 'workerproof');
    const started = await service.login({ name: 'workerproof', revision: row.revision });
    const waiting = await until(
      async () => {
        const snapshot = service.job(started.id);
        return snapshot.status === 'waiting' ? snapshot : null;
      },
      { tries: 150, label: 'oauth waiting url' },
    );
    assert.ok(!JSON.stringify(waiting).includes('worker-proof-secret'));
    // The test process started before NODE_EXTRA_CA_CERTS was set, so the
    // single TLS hop runs in a child that starts with the CA already trusted.
    const { stdout: landing } = await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'const r = await fetch(process.argv[1], { redirect: "manual" }); console.log(`${r.status} ${r.headers.get("location")}`);',
        waiting.url,
      ],
      { windowsHide: true, timeout: 30000, env: { ...process.env } },
    );
    const [authStatus, landingUrl] = landing.trim().split(' ');
    assert.equal(authStatus, '302');
    service.complete({ id: started.id, url: landingUrl });
    await until(async () => (service.job(started.id).status === 'complete' ? true : null), {
      tries: 200,
      label: 'oauth complete',
    });
    assert.equal((await service.list()).servers.find((s) => s.name === 'workerproof').authenticated, true);
    const stored = JSON.parse(await readFile(join(agentHome, 'auth.json'), 'utf8'))['mcp:workerproof'];
    assert.equal(stored.endpoint, `${origin}/mcp`);
    assert.ok(stored.access && stored.refresh);
    assert.ok(seen.some((s) => s.grant === 'authorization_code' && s.authed));
    // Expire the grant, then drive the real probe worker: its refresh plumbing
    // must fetch a new access token before the (unimplemented-by-fake) probe.
    stored.expires = Date.now() - 1000;
    const authFile = JSON.parse(await readFile(join(agentHome, 'auth.json'), 'utf8'));
    authFile['mcp:workerproof'] = stored;
    await writeFile(join(agentHome, 'auth.json'), JSON.stringify(authFile));
    const probe = spawn(process.execPath, [resolve('scripts/mcp-probe-worker.mjs')], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let probeError;
    probe.once('error', (error) => {
      probeError = error;
    });
    t.after(() => {
      try {
        probe.kill();
      } catch {}
    });
    probe.stdin.on('error', () => {});
    probe.stdin.end(
      JSON.stringify({
        agentHome,
        name: 'workerproof',
        revision: row.revision,
        python: join(root, 'no-python-here'),
      }),
    );
    let probeOutput = '';
    probe.stdout.on('data', (c) => {
      probeOutput += c;
    });
    const probeCode = await new Promise((done) => {
      const kill = setTimeout(() => {
        try {
          probe.kill();
        } catch {}
        done(124);
      }, 30000);
      kill.unref?.();
      probe.once('close', (c) => {
        clearTimeout(kill);
        done(c ?? 1);
      });
    });
    assert.equal(probeError, undefined);
    assert.equal(probeCode, 1, `probe worker without transport fails closed: ${probeOutput.slice(-500)}`);
    const refreshed = JSON.parse(await readFile(join(agentHome, 'auth.json'), 'utf8'))['mcp:workerproof'];
    assert.equal(refreshed.access, 'worker-access-2');
    assert.ok(seen.some((s) => s.grant === 'refresh_token' && s.authed));
  },
);

test('legacy factory fails closed on secret/metadata identity, preserves public flow', async (t) => {
  const { buildMcpOAuthProvider } = await import('../lib/mcp-config.mjs');
  const seen = [];
  const legacyLoaded = {
    createMcpOAuthProvider: (options) => {
      seen.push(options);
      return { id: `mcp:${options.server}` };
    },
  };
  const base = { type: 'http', url: 'https://s.test/mcp', oauth: true };
  // Public flow unchanged: client id + scopes pass through to the old factory.
  const publicProvider = buildMcpOAuthProvider(legacyLoaded, {
    name: 'pub',
    label: 'pub',
    url: base.url,
    builtin: undefined,
    config: { ...base, oauthClientId: 'cid', oauthScopes: ['read'] },
  });
  assert.equal(publicProvider.id, 'mcp:pub');
  assert.equal(seen[0].clientId, 'cid');
  assert.equal(seen[0].scopes, 'read');
  assert.equal(seen[0].clientSecret, undefined);
  // Newer identity fields fail closed instead of being silently ignored.
  for (const config of [
    { ...base, oauthClientSecretEnvVar: 'MCP096_LEGACY_MISSING' },
    { ...base, oauthClientMetadataUrl: 'https://c.test/m.json' },
  ])
    assert.throws(
      () =>
        buildMcpOAuthProvider(legacyLoaded, {
          name: 'x',
          label: 'x',
          url: base.url,
          builtin: undefined,
          config,
        }),
      /0\.9\.6/,
    );
  assert.equal(seen.length, 1);
  // Missing secret env is also explicit, not a silent public downgrade.
  assert.throws(
    () =>
      buildMcpOAuthProvider(legacyLoaded, {
        name: 'x',
        label: 'x',
        url: base.url,
        builtin: undefined,
        config: { ...base, oauthClientSecretEnvVar: 'MCP096_LEGACY_MISSING' },
      }),
    /0\.9\.6|missing|secret/i,
  );
});
