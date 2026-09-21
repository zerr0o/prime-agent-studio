
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import {
  MUSE_CODE_PROVIDER_ID,
  MUSE_CODE_GUIDANCE_KEY,
  MUSE_CODE_ACK_KEY,
  MUSE_CODE_API,
  MUSE_CODE_REAL_AUTH_SOURCES,
  hasUserMuseCodeConfig,
  validateMuseCodeAdapter,
  museCodeProviderConfigFromAdapter,
  resolveMuseCodeApiVersion,
  ensureMuseCodeProvider,
  isMuseCodePlaceholderStatus,
  shouldPruneMuseCodeModels,
  loadMuseCodeConfig,
} from '../lib/muse-code-gate.mjs';

test('muse-code identity forbids every non stored credential source', () => {
  assert.equal(MUSE_CODE_PROVIDER_ID, 'muse-code');
  assert.equal(MUSE_CODE_GUIDANCE_KEY, 'providers.muse_code_guidance');
  assert.equal(MUSE_CODE_ACK_KEY, 'providers.muse_code_ack');
  assert.equal(MUSE_CODE_API, 'openai-responses');
  assert.ok(MUSE_CODE_REAL_AUTH_SOURCES.has('stored'));
  for (const source of ['environment', 'fallback', 'models_json_key', 'models_json_command', 'prime_cli', 'runtime']) {
    assert.equal(MUSE_CODE_REAL_AUTH_SOURCES.has(source), false);
  }
});

test('user override detection is JSONC aware and fails closed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'prime-studio-musecode-gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'models.json');
  assert.equal(hasUserMuseCodeConfig(join(dir, 'missing.json')), false);
  assert.equal(hasUserMuseCodeConfig(null), false);
  await writeFile(file, JSON.stringify({ providers: { meta: {} } }));
  assert.equal(hasUserMuseCodeConfig(file), false);
  await writeFile(file, JSON.stringify({ providers: { 'muse-code': {} } }));
  assert.equal(hasUserMuseCodeConfig(file), true);
  await writeFile(
    file,
    '{\n// user muse endpoint\n"providers": {\n"muse-code": {\n"baseUrl": "https://custom.invalid/v1",\n},\n},\n}',
  );
  assert.equal(hasUserMuseCodeConfig(file), true);
  await writeFile(file, '{ "providers": {');
  assert.equal(hasUserMuseCodeConfig(file), true);
});

const oauthStub = (overrides = {}) => ({
  name: 'Muse Code (browser login)',
  login: async () => ({}),
  refreshToken: async () => ({}),
  getApiKey: () => 'minted',
  ...overrides,
});
const modelStub = (overrides = {}) => ({
  id: 'muse-spark-1.3',
  name: 'Muse Spark 1.3',
  reasoning: true,
  input: ['text'],
  cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
  contextWindow: 1024,
  maxTokens: 128,
  ...overrides,
});
const validAdapter = () => ({
  MUSE_OAUTH_PROVIDER_ID: 'muse-code',
  MUSE_BASE_URL: 'https://api.meta.ai/v1',
  MUSE_API_VERSION: '1.0.0',
  MUSE_CODE_MODELS: [modelStub()],
  museCodeOAuthAdapter: oauthStub(),
});

test('adapter validation accepts real shape and default interop, rejects stubs', () => {
  assert.equal(validateMuseCodeAdapter(validAdapter()), true);
  assert.equal(validateMuseCodeAdapter({ default: validAdapter() }), true);
  assert.equal(validateMuseCodeAdapter(null), false);
  assert.equal(validateMuseCodeAdapter({}), false);
  assert.equal(
    validateMuseCodeAdapter({ ...validAdapter(), MUSE_OAUTH_PROVIDER_ID: 'meta' }),
    false,
  );
  assert.equal(validateMuseCodeAdapter({ ...validAdapter(), MUSE_BASE_URL: 'http://plain.invalid' }), false);
  assert.equal(
    validateMuseCodeAdapter({ ...validAdapter(), museCodeOAuthAdapter: { name: 'x' } }),
    false,
  );
  assert.equal(validateMuseCodeAdapter({ ...validAdapter(), MUSE_CODE_MODELS: [] }), false);
  assert.equal(
    validateMuseCodeAdapter({ ...validAdapter(), MUSE_CODE_MODELS: [modelStub({ maxTokens: 2048 })] }),
    false,
  );
  assert.equal(resolveMuseCodeApiVersion(validAdapter()), '1.0.0');
  assert.equal(resolveMuseCodeApiVersion({}), '1.0.0');
  assert.equal(resolveMuseCodeApiVersion({ MUSE_API_VERSION: 'bad\nvalue' }), '1.0.0');
});

test('composed config carries version header, zeroed costs and no apiKey', () => {
  const config = museCodeProviderConfigFromAdapter(validAdapter());
  assert.equal(config.name, 'Muse Code (browser login)');
  assert.equal(config.baseUrl, 'https://api.meta.ai/v1');
  assert.equal(config.api, 'openai-responses');
  assert.deepEqual(config.headers, { 'x-api-version': '1.0.0' });
  assert.equal(config.models.length, 1);
  assert.deepEqual(config.models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal('apiKey' in config, false);
  assert.equal(typeof config.oauth.login, 'function');
  assert.equal(typeof config.oauth.refreshToken, 'function');
  assert.equal(typeof config.oauth.getApiKey, 'function');
  config.models[0].id = 'mutated';
  config.headers['x-api-version'] = 'mutated';
  const fresh = museCodeProviderConfigFromAdapter(validAdapter());
  assert.equal(fresh.models[0].id, 'muse-spark-1.3');
  assert.deepEqual(fresh.headers, { 'x-api-version': '1.0.0' });
  assert.equal(museCodeProviderConfigFromAdapter({}), null);
});

function fakeRegistry() {
  const models = [];
  return {
    models,
    getAll: () => [...models],
    registerProvider: (name, config) => {
      models.push(...(config.models || []).map((m) => ({ provider: name, id: m.id })));
    },
  };
}

test('ensure registers once and honors user config without throwing', () => {
  const config = museCodeProviderConfigFromAdapter(validAdapter());
  const registry = fakeRegistry();
  assert.equal(ensureMuseCodeProvider(registry, config, { hasUserConfig: false }), true);
  assert.equal(ensureMuseCodeProvider(registry, config, { hasUserConfig: false }), false);
  assert.equal(ensureMuseCodeProvider(fakeRegistry(), config, { hasUserConfig: true }), false);
  assert.equal(ensureMuseCodeProvider(fakeRegistry(), null), false);
  assert.equal(ensureMuseCodeProvider(fakeRegistry(), { name: 'x' }), false);
  assert.equal(
    ensureMuseCodeProvider(
      { getAll: () => { throw new Error('boom'); }, registerProvider: () => { throw new Error('nope'); } },
      config,
    ),
    false,
  );
});

test('placeholder and prune require typed stored oauth, never env or fallback', () => {
  assert.equal(isMuseCodePlaceholderStatus({ canonical: true, source: 'models_json_key', storedIsOAuth: false }), true);
  assert.equal(isMuseCodePlaceholderStatus({ canonical: true, source: undefined, storedIsOAuth: false }), true);
  assert.equal(isMuseCodePlaceholderStatus({ canonical: true, source: 'stored', storedIsOAuth: true }), false);
  assert.equal(isMuseCodePlaceholderStatus({ canonical: true, source: 'stored', storedIsOAuth: false }), true);
  assert.equal(isMuseCodePlaceholderStatus({ canonical: true, source: 'environment', storedIsOAuth: false }), true);
  assert.equal(isMuseCodePlaceholderStatus({ canonical: false, source: 'stored', storedIsOAuth: true }), false);
  assert.equal(shouldPruneMuseCodeModels({ museCanonical: true, source: 'stored', storedIsOAuth: true }), false);
  assert.equal(shouldPruneMuseCodeModels({ museCanonical: true, source: 'stored', storedIsOAuth: false }), true);
  assert.equal(shouldPruneMuseCodeModels({ museCanonical: true, source: 'environment', storedIsOAuth: false }), true);
  assert.equal(shouldPruneMuseCodeModels({ museCanonical: true, source: undefined, storedIsOAuth: false }), true);
  assert.equal(shouldPruneMuseCodeModels({ museCanonical: false, source: 'stored', storedIsOAuth: true }), false);
});

test('stored oauth check accepts only well formed oauth credentials', async () => {
  const { isMuseCodeStoredOAuth } = await import('../lib/muse-code-gate.mjs');
  assert.equal(isMuseCodeStoredOAuth({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 }), true);
  assert.equal(isMuseCodeStoredOAuth({ type: 'oauth', access: 'a', refresh: 'r' }), true);
  assert.equal(isMuseCodeStoredOAuth({ type: 'api_key', key: 'x' }), false);
  assert.equal(isMuseCodeStoredOAuth({ type: 'oauth', access: '', refresh: 'r' }), false);
  assert.equal(isMuseCodeStoredOAuth({ type: 'oauth', access: 'a' }), false);
  assert.equal(isMuseCodeStoredOAuth({ type: 'oauth' }), false);
  assert.equal(isMuseCodeStoredOAuth(null), false);
  assert.equal(isMuseCodeStoredOAuth(undefined), false);
  assert.equal(isMuseCodeStoredOAuth('oauth'), false);
});

test('thinkingLevelMap preserves null disabling mappings and drops garbage', async () => {
  const { museCodeProviderConfigFromAdapter } = await import('../lib/muse-code-gate.mjs');
  const withMap = {
    MUSE_OAUTH_PROVIDER_ID: 'muse-code',
    MUSE_BASE_URL: 'https://api.meta.ai/v1',
    MUSE_CODE_MODELS: [
      {
        id: 'm1',
        name: 'M1',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1024,
        maxTokens: 128,
        thinkingLevelMap: { off: null, minimal: 'minimal', bogus: 'minimal', low: 42, max: 'ultra' },
      },
    ],
    museCodeOAuthAdapter: { name: 'M', login: async () => ({}), refreshToken: async () => ({}), getApiKey: () => '' },
  };
  const config = museCodeProviderConfigFromAdapter(withMap);
  assert.deepEqual(config.models[0].thinkingLevelMap, { off: null, minimal: 'minimal' });
});

test('muse runs block on any configured fallback, other primaries proceed', async () => {
  const { isBlockedMuseCodeBackup } = await import('../lib/muse-code-gate.mjs');
  assert.equal(isBlockedMuseCodeBackup({ primaryProvider: 'muse-code', backupRef: 'meta/muse-spark-1.3' }), true);
  assert.equal(isBlockedMuseCodeBackup({ primaryProvider: 'muse-code', backupRef: 'openrouter/x/y' }), true);
  assert.equal(isBlockedMuseCodeBackup({ primaryProvider: 'muse-code', backupRef: 'prime-inference/m' }), true);
  assert.equal(isBlockedMuseCodeBackup({ primaryProvider: 'muse-code', backupRef: 'bare-id' }), true);
  assert.equal(isBlockedMuseCodeBackup({ primaryProvider: 'muse-code', backupRef: 'muse-code/other' }), true);
  assert.equal(isBlockedMuseCodeBackup({ primaryProvider: 'muse-code', backupRef: '' }), false);
  assert.equal(isBlockedMuseCodeBackup({ primaryProvider: 'muse-code', backupRef: null }), false);
  assert.equal(isBlockedMuseCodeBackup({ primaryProvider: 'meta', backupRef: 'openrouter/x' }), false);
  assert.equal(isBlockedMuseCodeBackup({ primaryProvider: '', backupRef: 'meta/m' }), false);
});

test('missing or invalid adapter stays invisible without throwing', async () => {
  assert.equal(await loadMuseCodeConfig(() => Promise.reject(new Error('no module'))), null);
  assert.equal(await loadMuseCodeConfig(null), null);
  assert.equal(await loadMuseCodeConfig(() => ({})), null);
  assert.equal(await loadMuseCodeConfig(() => { throw new Error('sync boom'); }), null);
});

function fakeNative({ baseModels = [], oauthIds = [], names = {}, statusMap = {}, data = {} } = {}) {
  const registered = [];
  return {
    FileAuthStorageBackend: class {
      withLock(fn) {
        return fn(JSON.stringify(data)).result;
      }
      async withLockAsync(fn) {
        return (await fn(JSON.stringify(data))).result;
      }
    },
    AuthStorage: {
      fromStorage: () => ({
        drainErrors: () => [],
        reload: () => {},
        getOAuthProviders: () => oauthIds.map((id) => ({ id, name: names[id] || id })),
        list: () => Object.keys(data),
        get: (id) => data[id],
        set: (id, credential) => {
          data[id] = credential;
        },
        removeVerified: (id) => {
          delete data[id];
        },
      }),
    },
    ModelRegistry: {
      create: () => ({
        getAll: () => [...baseModels, ...registered],
        getProviderAuthStatus: (id) => statusMap[id] || {},
        getProviderDisplayName: (id) => names[id] || id,
        getError: () => undefined,
        registerProvider: (name, config) => {
          registered.push(...(config.models || []).map((m) => ({ provider: name, id: m.id })));
        },
      }),
    },
  };
}

async function providerFixture(t) {
  const agentHome = await mkdtemp(join(tmpdir(), 'prime-studio-musecode-auth-'));
  t.after(() => rm(agentHome, { recursive: true, force: true }));
  const { createProviderAuth, credentialRevision } = await import('../lib/provider-auth.mjs');
  return { agentHome, createProviderAuth, credentialRevision };
}

test('real adapter registers gated muse-code as oauth-only without stored key', async (t) => {
  const { agentHome, createProviderAuth, credentialRevision } = await providerFixture(t);
  const store = await createProviderAuth({
    agentHome,
    native: fakeNative({ oauthIds: ['muse-code'], names: { 'muse-code': 'Muse Code (browser login)' } }),
  });
  const list = store.list();
  const entry = list.providers.find((p) => p.id === 'muse-code');
  assert.ok(entry, 'gated provider must list once the real adapter validates');
  assert.deepEqual(entry.methods, ['oauth']);
  assert.equal(entry.configured, false);
  assert.equal(entry.stored, false);
  assert.ok(typeof entry.guidance === 'string' && entry.guidance.includes('muse-code'));
  await assert.rejects(
    store.save({ provider: 'muse-code', revision: credentialRevision(null), kind: 'key', value: 'x' }),
    (e) => e.status === 400,
  );
});

test('stored oauth marks muse-code configured without leaking secrets', async (t) => {
  const { agentHome, createProviderAuth } = await providerFixture(t);
  const stored = { type: 'oauth', access: 'test-opaque-access', refresh: 'test-opaque-refresh', expires: 4102444800000 };
  const store = await createProviderAuth({
    agentHome,
    native: fakeNative({
      oauthIds: ['muse-code'],
      names: { 'muse-code': 'Muse Code (browser login)' },
      statusMap: { 'muse-code': { source: 'stored' } },
      data: { 'muse-code': stored },
    }),
  });
  const entry = store.list().providers.find((p) => p.id === 'muse-code');
  assert.equal(entry.configured, true);
  assert.equal(entry.source, 'stored');
  assert.equal(entry.credentialType, 'oauth');
  assert.equal(entry.stored, true);
  assert.deepEqual(entry.methods, ['oauth']);
  assert.doesNotMatch(JSON.stringify(store.list()), /test-opaque/);
});

test('wrong-typed stored credential under muse-code reads as unconfigured', async (t) => {
  const { agentHome, createProviderAuth } = await providerFixture(t);
  const store = await createProviderAuth({
    agentHome,
    native: fakeNative({
      oauthIds: ['muse-code'],
      names: { 'muse-code': 'Muse Code (browser login)' },
      statusMap: { 'muse-code': { source: 'stored' } },
      data: { 'muse-code': { type: 'api_key', key: 'test-wrong-type-key' } },
    }),
  });
  const entry = store.list().providers.find((p) => p.id === 'muse-code');
  assert.equal(entry.configured, false);
  assert.deepEqual(entry.methods, ['oauth']);
  assert.doesNotMatch(JSON.stringify(store.list()), /test-wrong-type-key/);
});

test('user models.json muse-code entry wins and stays generic without adapter oauth', async (t) => {
  const { agentHome, createProviderAuth } = await providerFixture(t);
  await writeFile(agentHome + '/models.json', JSON.stringify({ providers: { 'muse-code': {} } }));
  const store = await createProviderAuth({
    agentHome,
    native: fakeNative({ baseModels: [{ provider: 'muse-code' }] }),
  });
  const entry = store.list().providers.find((p) => p.id === 'muse-code');
  assert.ok(entry);
  assert.deepEqual(entry.methods, ['api_key']);
  assert.equal(entry.configured, false);
});

test('runtime extension registers gated provider but skips user overrides', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'prime-studio-musecode-ext-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  process.env.PRIME_AGENT_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
    else process.env.PRIME_AGENT_CODING_AGENT_DIR = previous;
  });
  const { default: studioMuseCode } = await import('../runtime/studio-muse-code-extension.mjs');
  const calls = [];
  await studioMuseCode({ registerProvider: (name, config) => calls.push([name, config]) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'muse-code');
  assert.deepEqual(calls[0][1].headers, { 'x-api-version': '1.0.0' });
  assert.equal(typeof calls[0][1].oauth.login, 'function');
  assert.equal('apiKey' in calls[0][1], false);
  await writeFile(join(dir, 'models.json'), JSON.stringify({ providers: { 'muse-code': {} } }));
  const skipped = [];
  await studioMuseCode({ registerProvider: (name, config) => skipped.push(name) });
  assert.equal(skipped.length, 0);
  await studioMuseCode(null);
  await studioMuseCode({});
});

test('muse-code warning, consent and billing texts exist in both languages', async () => {
  const { formatMessage } = await import('../public/i18n-core.js');
  for (const language of ['en', 'fr']) {
    for (const key of ['providers.muse_code_guidance', 'providers.muse_code_ack', 'engine.backup_billing_warning', 'server.muse_backup_run_refused']) {
      const text = formatMessage(key, {}, language);
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 20);
      assert.doesNotMatch(text, /\u2014/);
    }
  }
  assert.match(formatMessage('providers.muse_code_guidance', {}, 'en'), /subscription/);
  assert.match(formatMessage('providers.muse_code_guidance', {}, 'en'), /estimates/);
  assert.match(formatMessage('providers.muse_code_guidance', {}, 'fr'), /abonnement/);
});

test('no environment or builtin fallback can resolve the muse-code id', async () => {
  const { readFile } = await import('node:fs/promises');
  const agentSource = await readFile(new URL('../lib/agent.mjs', import.meta.url), 'utf8');
  const modelEnv = agentSource.slice(agentSource.indexOf('const MODEL_ENV'), agentSource.indexOf('};', agentSource.indexOf('const MODEL_ENV')) + 2);
  assert.doesNotMatch(modelEnv, /muse-code/);
  const configSource = await readFile(new URL('../lib/model-config.mjs', import.meta.url), 'utf8');
  const builtins = configSource.slice(configSource.indexOf('const BUILTIN_PROVIDERS'), configSource.indexOf(']);', configSource.indexOf('const BUILTIN_PROVIDERS')) + 3);
  assert.doesNotMatch(builtins, /muse-code/);
  const authSource = await readFile(new URL('../lib/provider-auth.mjs', import.meta.url), 'utf8');
  assert.match(authSource, /museCodeAvailable/);
});

async function loadNativeMuseParts(t) {
  const { discoverCli } = await import('../lib/agent.mjs');
  const cli = discoverCli();
  if (!cli?.packageDir) {
    t.skip('Prime Agent engine unavailable');
    return null;
  }
  const modelsUrl = pathToFileURL(
    join(cli.packageDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'models.js'),
  ).href;
  const streamerUrl = pathToFileURL(
    join(cli.packageDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'openai-responses.js'),
  ).href;
  const [levels, streamer, gate] = await Promise.all([
    import(modelsUrl),
    import(streamerUrl),
    import('../lib/muse-code-gate.mjs'),
  ]);
  const loaded = await gate.loadMuseCodeConfig(() => import('../lib/muse-oauth-provider.mjs'));
  if (!loaded) {
    t.skip('Muse adapter unavailable');
    return null;
  }
  return { ...levels, streamer, config: loaded.config };
}

function museStreamModel(config, baseUrl, id = 'muse-spark-1.3') {
  const found = config.models.find((m) => m.id === id) || config.models[0];
  return {
    ...found,
    api: 'openai-responses',
    provider: 'muse-code',
    baseUrl,
  };
}

async function captureMuseParams(streamer, model, context, options) {
  let captured;
  const stream = streamer.streamOpenAIResponses(model, context, {
    ...options,
    onPayload: (params) => {
      captured = params;
      return undefined;
    },
  });
  for await (const _event of stream) {
    // Drain until the mocked transport settles; payload is captured first.
  }
  return captured;
}

function mockMuseServer(onBody) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      onBody?.({ url: req.url, body });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock transport' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('composed muse config keeps off:null so native off clamps to minimal', async (t) => {
  const parts = await loadNativeMuseParts(t);
  if (!parts) return;
  const model = museStreamModel(parts.config, 'https://api.meta.ai/v1');
  assert.equal(model.reasoning, true);
  assert.equal(model.thinkingLevelMap.off, null);
  const levels = parts.getSupportedThinkingLevels(model);
  assert.ok(!levels.includes('off'), 'off must stay unsupported so none is never emitted');
  assert.equal(parts.clampThinkingLevel(model, 'off'), 'minimal');
  const withoutNull = { ...model, thinkingLevelMap: { minimal: 'minimal' } };
  assert.ok(parts.getSupportedThinkingLevels(withoutNull).includes('off'));
  assert.equal(parts.clampThinkingLevel(withoutNull, 'off'), 'off');
});

test('composed muse default payload never sends reasoning none', async (t) => {
  const parts = await loadNativeMuseParts(t);
  if (!parts) return;
  let seen = null;
  const server = await mockMuseServer((request) => {
    seen = request;
  });
  t.after(() => server.close());
  const model = museStreamModel(parts.config, `http://127.0.0.1:${server.address().port}/v1`);
  const params = await captureMuseParams(
    parts.streamer,
    model,
    { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] },
    { apiKey: 'test-key' },
  );
  assert.equal(params.reasoning, undefined);
  assert.ok(seen && seen.url.endsWith('/responses'));
  assert.doesNotMatch(seen.body, /none/);
});

test('composed muse medium payload sends effort plus encrypted include', async (t) => {
  const parts = await loadNativeMuseParts(t);
  if (!parts) return;
  const server = await mockMuseServer();
  t.after(() => server.close());
  const model = museStreamModel(parts.config, `http://127.0.0.1:${server.address().port}/v1`);
  const params = await captureMuseParams(
    parts.streamer,
    model,
    { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] },
    { apiKey: 'test-key', reasoningEffort: 'medium' },
  );
  assert.deepEqual(params.reasoning, { effort: 'medium', summary: 'auto' });
  assert.deepEqual(params.include, ['reasoning.encrypted_content']);
});

test('runtime start refuses muse runs while a fallback is configured', async (t) => {
  const { createAgentRuntime } = await import('../lib/agent.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'prime-studio-muse-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = createAgentRuntime({
    agentHome: join(dir, 'agent'),
    sessionDir: join(dir, 'sessions'),
    cliPath: fileURLToPath(new URL('./fixtures/agent-cli.mjs', import.meta.url)),
    env: {},
  });
  t.after(() => runtime.close());
  await mkdir(join(dir, 'agent'), { recursive: true });
  const settingsFile = join(dir, 'agent', 'settings.json');
  await writeFile(settingsFile, JSON.stringify({ providerBackupModel: 'meta/muse-spark-1.3' }));
  await assert.rejects(runtime.start({ cwd: dir, message: 'hi', provider: 'muse-code' }), /Muse/);
  await assert.rejects(runtime.start({ cwd: dir, message: 'hi', model: 'muse-code/muse-spark-1.3' }), /Muse/);
  await writeFile(
    settingsFile,
    JSON.stringify({ defaultProvider: 'muse-code', defaultModel: 'muse-spark-1.3', providerBackupModel: 'openrouter/x' }),
  );
  await assert.rejects(runtime.start({ cwd: dir, message: 'hi' }), /Muse/);
  // Cleared fallback proceeds past the guard and the fixture CLI completes.
  await writeFile(settingsFile, JSON.stringify({}));
  const handle = await runtime.start({ cwd: dir, message: 'Bonjour', provider: 'muse-code' });
  assert.equal((await handle.done).status, 'completed');
});
