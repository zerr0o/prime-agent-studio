import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { discoverCli } from '../lib/agent.mjs';
import {
  META_PROVIDER_ID,
  META_PROVIDER_NAME,
  META_BASE_URL,
  META_CREDENTIAL_ENV,
  META_API,
  META_CONTEXT_WINDOW,
  META_MAX_TOKENS,
  META_MODEL_IDS,
  META_MODELS,
  META_REAL_AUTH_SOURCES,
  metaProviderConfig,
  ensureMetaProvider,
  hasUserMetaConfig,
  isMetaPlaceholderStatus,
  stripMetaJsonComments,
} from '../lib/meta-provider.mjs';
import { MODEL_APIS } from '../lib/model-config.mjs';
import studioMetaProvider from '../runtime/studio-meta-provider-extension.mjs';

test('canonical Meta spec matches verified Model API contract', async () => {
  assert.equal(META_PROVIDER_ID, 'meta');
  assert.equal(META_BASE_URL, 'https://api.meta.ai/v1');
  assert.equal(META_CREDENTIAL_ENV, 'MODEL_API_KEY');
  assert.ok(MODEL_APIS.includes(META_API), 'canonical api must be Studio-supported');
  assert.deepEqual(META_MODEL_IDS, ['muse-spark-1.3', 'muse-spark-1.3-contributor']);
  assert.equal(META_CONTEXT_WINDOW, 1048576);
  assert.equal(META_MAX_TOKENS, 131072);
  for (const model of META_MODELS) {
    assert.equal(model.reasoning, true);
    // Never map any level to none: Muse Spark rejects reasoning none with HTTP 400.
    assert.ok(!Object.values(model.thinkingLevelMap || {}).includes('none'));
    assert.equal(model.thinkingLevelMap.off, null);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.equal(model.contextWindow, 1048576);
    assert.equal(model.maxTokens, 131072);
  }
  const standard = META_MODELS[0].thinkingLevelMap;
  assert.equal(standard.max, 'max');
  assert.equal(META_MODELS[1].thinkingLevelMap.max, undefined);
  assert.deepEqual(META_MODELS[0].cost, { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 });
  assert.deepEqual(META_MODELS[1].cost, { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 });
  assert.match(META_MODELS[1].name, /training allowed/);
  const { formatMessage } = await import('../public/i18n-core.js');
  for (const language of ['en', 'fr']) {
    const guidance = formatMessage('providers.meta_guidance', {}, language);
    assert.equal(typeof guidance, 'string');
    assert.match(guidance, /MODEL_API_KEY/);
    assert.match(guidance, /Contributor/);
    assert.doesNotMatch(guidance, /\u2014/);
  }
  assert.equal(JSON.stringify(metaProviderConfig()).includes('LLM|'), false);
  assert.ok(META_REAL_AUTH_SOURCES.has('stored'));
  assert.ok(META_REAL_AUTH_SOURCES.has('environment'));
});

test('provider config carries native-required fields with fresh copies', () => {
  const config = metaProviderConfig();
  assert.equal(config.name, META_PROVIDER_NAME);
  assert.equal(config.baseUrl, META_BASE_URL);
  assert.equal(config.apiKey, META_CREDENTIAL_ENV);
  assert.equal(config.api, META_API);
  assert.equal(config.models.length, 2);
  for (const model of config.models) {
    assert.ok(typeof model.id === 'string' && model.id);
    assert.ok(typeof model.name === 'string' && model.name);
    assert.equal(typeof model.reasoning, 'boolean');
    assert.ok(Array.isArray(model.input) && model.input.length > 0);
    assert.ok(model.contextWindow > 0 && model.maxTokens > 0);
  }
  config.models[0].id = 'mutated';
  assert.notEqual(metaProviderConfig().models[0].id, 'mutated');
});

test('ensureMetaProvider registers once and keeps user definitions', () => {
  let registered = null;
  const empty = {
    find: () => undefined,
    registerProvider: (name, config) => {
      registered = { name, config };
    },
  };
  assert.equal(ensureMetaProvider(empty), true);
  assert.equal(registered.name, 'meta');
  assert.equal(registered.config.baseUrl, META_BASE_URL);

  const existing = {
    find: (provider, id) => (provider === 'meta' && id === 'muse-spark-1.3' ? { id } : undefined),
    registerProvider: () => {
      throw new Error('must not override user config');
    },
  };
  assert.equal(ensureMetaProvider(existing), false);

  const viaAll = {
    getAll: () => [{ provider: 'meta', id: 'custom' }],
    registerProvider: () => {
      throw new Error('must not override user config');
    },
  };
  assert.equal(ensureMetaProvider(viaAll), false);
  assert.equal(ensureMetaProvider(null), false);
  assert.equal(ensureMetaProvider({}), false);
});

test('placeholder detection only fires for canonical registration without credential', () => {
  assert.equal(
    isMetaPlaceholderStatus({
      canonical: true,
      source: 'models_json_key',
      stored: false,
      envSet: false,
    }),
    true,
  );
  assert.equal(
    isMetaPlaceholderStatus({ canonical: true, source: 'stored', stored: true, envSet: false }),
    false,
  );
  assert.equal(
    isMetaPlaceholderStatus({
      canonical: true,
      source: 'models_json_key',
      stored: false,
      envSet: true,
    }),
    false,
  );
  assert.equal(
    isMetaPlaceholderStatus({
      canonical: false,
      source: 'models_json_key',
      stored: false,
      envSet: false,
    }),
    false,
  );
});

test('runtime extension registers canonical provider but skips user overrides', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'prime-studio-meta-ext-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  process.env.PRIME_AGENT_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
    else process.env.PRIME_AGENT_CODING_AGENT_DIR = previous;
  });
  let registered = null;
  studioMetaProvider({
    registerProvider: (name, config) => {
      registered = { name, config };
    },
  });
  assert.equal(registered?.name, 'meta');
  assert.equal(registered?.config.models.length, 2);

  await writeFile(
    join(dir, 'models.json'),
    JSON.stringify({ providers: { meta: { baseUrl: 'https://custom.invalid/v1', models: [] } } }),
  );
  registered = null;
  studioMetaProvider({
    registerProvider: () => {
      throw new Error('must not override user models.json');
    },
  });
  assert.equal(registered, null);
});

test('ensureMetaProvider honors any registry meta entry and explicit user flag', () => {
  // Arbitrary custom id visible only through getAll (native registries expose both).
  const customOnly = {
    getAll: () => [{ provider: 'meta', id: 'my-custom' }],
    find: () => undefined,
    registerProvider: () => {
      throw new Error('must not overwrite arbitrary custom meta');
    },
  };
  assert.equal(ensureMetaProvider(customOnly), false);
  assert.equal(ensureMetaProvider(customOnly, { hasUserConfig: false }), false);

  // Explicit models.json flag wins even when the registry looks empty.
  let called = false;
  assert.equal(
    ensureMetaProvider(
      {
        getAll: () => [],
        find: () => undefined,
        registerProvider: () => {
          called = true;
        },
      },
      { hasUserConfig: true },
    ),
    false,
  );
  assert.equal(called, false);

  // Legacy registries without getAll keep the canonical-id check.
  let legacyRegistered = false;
  assert.equal(
    ensureMetaProvider({
      find: (provider, id) => (id === 'muse-spark-1.3-contributor' ? { id } : undefined),
    }),
    false,
  );
  assert.equal(
    ensureMetaProvider({
      find: () => undefined,
      registerProvider: () => {
        legacyRegistered = true;
      },
    }),
    true,
  );
  assert.equal(legacyRegistered, true);
});

test('user override detection is JSONC-aware and fails closed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'prime-studio-meta-jsonc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'models.json');
  assert.equal(hasUserMetaConfig(join(dir, 'missing.json')), false);
  assert.equal(hasUserMetaConfig(null), false);

  // Comments and trailing commas must not hide a user meta entry.
  await writeFile(
    file,
    `{
      // user custom Meta endpoint
      "providers": {
        "meta": {
          "baseUrl": "https://custom.invalid/v1", // trailing comma below
        },
      },
    }`,
  );
  assert.equal(hasUserMetaConfig(file), true);
  // Runtime extension shares the same reader, so it skips too.
  const previous = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  process.env.PRIME_AGENT_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
    else process.env.PRIME_AGENT_CODING_AGENT_DIR = previous;
  });
  studioMetaProvider({
    registerProvider: () => {
      throw new Error('must not override JSONC user config');
    },
  });

  // Empty object and name-only entries also count as overrides.
  await writeFile(file, JSON.stringify({ providers: { meta: {} } }));
  assert.equal(hasUserMetaConfig(file), true);
  await writeFile(file, JSON.stringify({ providers: { openai: {} } }));
  assert.equal(hasUserMetaConfig(file), false);

  // Malformed content fails closed: never let canonical clobber the unknown.
  await writeFile(file, '{ "providers": {');
  assert.equal(hasUserMetaConfig(file), true);
  assert.equal(stripMetaJsonComments('// c\n{"a":1,}').includes('//'), false);
});

async function loadNativeRegistry(t, agentHome) {
  const cli = discoverCli();
  if (!cli?.packageDir) {
    t.skip('Prime Agent engine unavailable');
    return null;
  }
  const localImport = (path) => import(pathToFileURL(join(cli.packageDir, path)).href);
  const [authMod, regMod] = await Promise.all([
    localImport('dist/core/auth-storage.js'),
    localImport('dist/core/model-registry.js'),
  ]);
  const auth = authMod.AuthStorage.create(join(agentHome, 'auth.json'), { usePrimeCliConfig: false });
  const registry = regMod.ModelRegistry.create(auth, join(agentHome, 'models.json'));
  return { auth, registry };
}

const nativeCustomMeta = (baseUrl) => ({
  providers: {
    meta: {
      name: 'Custom Meta',
      baseUrl,
      api: 'openai-responses',
      apiKey: 'CUSTOM_META_ENV',
      models: [
        {
          id: 'my-custom',
          name: 'My Custom',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 64000,
          maxTokens: 4096,
        },
      ],
    },
  },
});

test('real registry keeps arbitrary custom meta and empty overrides', async (t) => {
  const agentHome = await mkdtemp(join(tmpdir(), 'prime-studio-meta-native-'));
  t.after(() => rm(agentHome, { recursive: true, force: true }));
  await writeFile(join(agentHome, 'auth.json'), JSON.stringify({}));
  await writeFile(join(agentHome, 'models.json'), JSON.stringify(nativeCustomMeta('https://custom.invalid/v1')));

  const loaded = await loadNativeRegistry(t, agentHome);
  if (!loaded) return;
  const modelsPath = join(agentHome, 'models.json');
  assert.equal(hasUserMetaConfig(modelsPath), true);
  // Both entry points refuse: explicit flag and live any-meta registry check.
  assert.equal(ensureMetaProvider(loaded.registry, { hasUserConfig: true }), false);
  assert.equal(ensureMetaProvider(loaded.registry), false);
  assert.ok(loaded.registry.find('meta', 'my-custom'));
  assert.equal(loaded.registry.find('meta', 'muse-spark-1.3'), undefined);
  assert.equal(loaded.registry.find('meta', 'muse-spark-1.3-contributor'), undefined);
  assert.ok(
    loaded.registry
      .getAll()
      .filter((model) => model && model.provider === 'meta')
      .every((model) => !META_MODEL_IDS.includes(model.id)),
    'no canonical id may leak into a custom meta provider',
  );

  // Empty/baseUrl-only override: canonical still stays out.
  await writeFile(
    join(agentHome, 'models.json'),
    JSON.stringify({ providers: { meta: { name: 'Custom Meta', baseUrl: 'https://custom.invalid/v1' } } }),
  );
  const reloaded = await loadNativeRegistry(t, agentHome);
  if (!reloaded) return;
  assert.equal(hasUserMetaConfig(modelsPath), true);
  assert.equal(ensureMetaProvider(reloaded.registry, { hasUserConfig: true }), false);
  // A model-less override leaves no trace in the registry itself, so the bare
  // call without the file flag cannot see it. Every production caller must
  // pass hasUserConfig (provider-auth, catalog worker and extension all do).
  // This assertion pins that contract: bare call registers, flagged call refuses.
  const bare = await loadNativeRegistry(t, agentHome);
  if (!bare) return;
  assert.equal(ensureMetaProvider(bare.registry), true);
  assert.ok(bare.registry.find('meta', 'muse-spark-1.3'));
  assert.equal(reloaded.registry.find('meta', 'muse-spark-1.3'), undefined);
});

test('simulated child process resolves the same canonical meta model', async (t) => {
  const agentHome = await mkdtemp(join(tmpdir(), 'prime-studio-meta-child-'));
  t.after(() => rm(agentHome, { recursive: true, force: true }));
  await writeFile(join(agentHome, 'auth.json'), JSON.stringify({}));
  await writeFile(join(agentHome, 'models.json'), JSON.stringify({ providers: {} }));
  const modelsPath = join(agentHome, 'models.json');
  assert.equal(hasUserMetaConfig(modelsPath), false);

  // Parent and child each build their own native registry in their own
  // process and apply the same overlay (no real calls, no secrets).
  const parent = await loadNativeRegistry(t, agentHome);
  if (!parent) return;
  assert.equal(ensureMetaProvider(parent.registry, { hasUserConfig: hasUserMetaConfig(modelsPath) }), true);
  const child = await loadNativeRegistry(t, agentHome);
  if (!child) return;
  assert.equal(ensureMetaProvider(child.registry, { hasUserConfig: hasUserMetaConfig(modelsPath) }), true);
  for (const id of META_MODEL_IDS) {
    const fromParent = parent.registry.find('meta', id);
    const fromChild = child.registry.find('meta', id);
    assert.ok(fromParent && fromChild);
    assert.equal(fromChild.baseUrl, META_BASE_URL);
    assert.equal(fromChild.api, META_API);
    assert.equal(fromParent.baseUrl, fromChild.baseUrl);
  }
  // No credential anywhere: nothing secret backs the resolution.
  assert.equal(parent.registry.getProviderAuthStatus('meta').source !== 'stored', true);
});

test('provider listing and catalog stay consistent on custom meta', async (t) => {
  const cli = discoverCli();
  if (!cli?.packageDir) {
    t.skip('Prime Agent engine unavailable');
    return;
  }
  const { createProviderAuth } = await import('../lib/provider-auth.mjs');
  const agentHome = await mkdtemp(join(tmpdir(), 'prime-studio-meta-consistency-'));
  t.after(() => rm(agentHome, { recursive: true, force: true }));
  const previousEnv = process.env.MODEL_API_KEY;
  delete process.env.MODEL_API_KEY;
  t.after(() => {
    if (previousEnv === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = previousEnv;
  });
  await writeFile(
    join(agentHome, 'auth.json'),
    JSON.stringify({ meta: { type: 'api_key', key: 'user-meta-secret' } }),
  );
  await writeFile(join(agentHome, 'models.json'), JSON.stringify(nativeCustomMeta('https://custom.invalid/v1')));

  const store = await createProviderAuth({ agentHome });
  const meta = store.list().providers.find((entry) => entry.id === 'meta');
  assert.ok(meta);
  assert.equal(meta.models, 1);
  assert.equal(meta.source, 'stored');

  const loaded = await loadNativeRegistry(t, agentHome);
  if (!loaded) return;
  assert.equal(ensureMetaProvider(loaded.registry), false);
  const available = loaded.registry.getAvailable().filter((model) => model.provider === 'meta');
  assert.deepEqual(available.map((model) => model.id), ['my-custom']);
});

test('provider listing exposes Meta with native auth storage and preserves peers', async (t) => {
  const cli = discoverCli();
  if (!cli?.packageDir) {
    t.skip('Prime Agent engine unavailable');
    return;
  }
  const { createProviderAuth } = await import('../lib/provider-auth.mjs');
  const agentHome = await mkdtemp(join(tmpdir(), 'prime-studio-meta-auth-'));
  t.after(() => rm(agentHome, { recursive: true, force: true }));
  const previousEnv = process.env.MODEL_API_KEY;
  delete process.env.MODEL_API_KEY;
  t.after(() => {
    if (previousEnv === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = previousEnv;
  });
  await writeFile(
    join(agentHome, 'auth.json'),
    JSON.stringify({
      'mcp:notes': { type: 'oauth', access: 'mcp-private', refresh: 'r', expires: 0 },
      openai: { type: 'api_key', key: 'peer-secret' },
    }),
  );
  const store = await createProviderAuth({ agentHome });
  const listed = store.list();
  const meta = listed.providers.find((entry) => entry.id === 'meta');
  assert.ok(meta, 'meta must appear without manual custom setup');
  assert.ok(meta.methods.includes('api_key'));
  assert.equal(meta.models, 2);
  assert.equal(meta.configured, false);
  assert.doesNotMatch(JSON.stringify(listed), /peer-secret|mcp-private/);

  const saved = await store.save({
    provider: 'meta',
    revision: meta.revision,
    kind: 'key',
    value: 'test-meta-secret',
  });
  assert.equal(saved.saved, true);
  assert.doesNotMatch(JSON.stringify(saved), /test-meta-secret/);
  const onDisk = JSON.parse(await readFile(join(agentHome, 'auth.json'), 'utf8'));
  assert.equal(onDisk.meta.key, 'test-meta-secret');
  assert.equal(onDisk.openai.key, 'peer-secret');
  assert.deepEqual(onDisk['mcp:notes'].access, 'mcp-private');

  const fresh = await createProviderAuth({ agentHome });
  const configured = fresh.list().providers.find((entry) => entry.id === 'meta');
  assert.equal(configured.configured, true);
  assert.equal(configured.stored, true);
  assert.equal(configured.source, 'stored');

  fresh.remove({ provider: 'meta', revision: configured.revision });
  const after = JSON.parse(await readFile(join(agentHome, 'auth.json'), 'utf8'));
  assert.equal('meta' in after, false);
  assert.equal(after.openai.key, 'peer-secret');
});

async function loadResponsesStreamer(t) {
  const cli = discoverCli();
  if (!cli?.packageDir) {
    t.skip('Prime Agent engine unavailable');
    return null;
  }
  const moduleUrl = pathToFileURL(
    join(cli.packageDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'openai-responses.js'),
  ).href;
  return import(moduleUrl);
}

function metaTestModel(baseUrl, thinkingLevelMap) {
  return {
    id: 'muse-spark-1.3',
    name: 'Muse Spark 1.3',
    api: 'openai-responses',
    provider: 'meta',
    baseUrl,
    reasoning: true,
    thinkingLevelMap,
    input: ['text', 'image'],
    cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 131072,
  };
}

async function captureParams(streamer, model, context, options) {
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

function mockResponsesServer(onBody) {
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

test('outgoing Responses payload uses stateless encrypted replay with tools', async (t) => {
  const streamer = await loadResponsesStreamer(t);
  if (!streamer) return;
  let seen = null;
  const server = await mockResponsesServer((request) => {
    seen = request;
  });
  t.after(() => server.close());
  const port = server.address().port;
  const reasoningItem = {
    type: 'reasoning',
    id: 'rs_encrypted1',
    summary: [],
    encrypted_content: 'opaque-blob',
  };
  const context = {
    systemPrompt: 'Be concise.',
    messages: [
      { role: 'user', content: 'First question', timestamp: Date.now() },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', thinkingSignature: JSON.stringify(reasoningItem) },
          {
            type: 'text',
            text: 'Working on it.',
            textSignature: JSON.stringify({ v: 1, id: 'msg_first', phase: 'commentary' }),
          },
          { type: 'toolCall', id: 'call_1|fc_1', name: 'read_file', arguments: { path: 'a.txt' } },
        ],
        api: 'openai-responses',
        provider: 'meta',
        model: 'muse-spark-1.3',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      },
      {
        role: 'toolResult',
        toolCallId: 'call_1|fc_1',
        content: [{ type: 'text', text: 'file contents' }],
      },
      { role: 'user', content: 'Continue', timestamp: Date.now() },
    ],
    tools: [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
  };
  const model = metaTestModel(
    `http://127.0.0.1:${port}/v1`,
    { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  );
  const params = await captureParams(streamer, model, context, {
    apiKey: 'test-key',
    reasoningEffort: 'high',
    maxTokens: 1024,
  });
  assert.ok(seen && seen.url.endsWith('/responses'));
  assert.equal(params.model, 'muse-spark-1.3');
  assert.equal(params.store, false);
  assert.equal(params.stream, true);
  assert.deepEqual(params.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(params.include, ['reasoning.encrypted_content']);
  assert.ok(!('verbosity' in params), 'verbosity is unsupported and must stay unset');
  assert.deepEqual(params.tools, [
    {
      type: 'function',
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      strict: false,
    },
  ]);
  const replayed = params.input.find(
    (item) => item && item.type === 'reasoning' && item.encrypted_content === 'opaque-blob',
  );
  assert.ok(replayed, 'encrypted reasoning must replay whole');
  const call = params.input.find((item) => item && item.type === 'function_call');
  assert.equal(call?.call_id, 'call_1');
  const output = params.input.find((item) => item && item.type === 'function_call_output');
  assert.equal(output?.call_id, 'call_1');
  // Every reasoning item must be followed before the next user message.
  const lastUser = params.input.map((item) => item.type || item.role).lastIndexOf('user');
  const reasoningIndex = params.input.indexOf(replayed);
  assert.ok(reasoningIndex >= 0 && reasoningIndex < lastUser);
});

test('default payload never sends reasoning none to Muse Spark', async (t) => {
  const streamer = await loadResponsesStreamer(t);
  if (!streamer) return;
  const server = await mockResponsesServer();
  t.after(() => server.close());
  const port = server.address().port;
  const model = metaTestModel(`http://127.0.0.1:${port}/v1`, {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  });
  const params = await captureParams(
    streamer,
    model,
    { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] },
    { apiKey: 'test-key' },
  );
  assert.equal(params.reasoning, undefined);
});

test('medium-default payload sends effort plus encrypted include', async (t) => {
  const streamer = await loadResponsesStreamer(t);
  if (!streamer) return;
  const server = await mockResponsesServer();
  t.after(() => server.close());
  const port = server.address().port;
  const model = metaTestModel(`http://127.0.0.1:${port}/v1`, {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  });
  // Production path: native DEFAULT_THINKING_LEVEL medium resolves to an
  // explicit effort, so encrypted continuity is requested.
  const params = await captureParams(
    streamer,
    model,
    { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] },
    { apiKey: 'test-key', reasoningEffort: 'medium' },
  );
  assert.deepEqual(params.reasoning, { effort: 'medium', summary: 'auto' });
  assert.deepEqual(params.include, ['reasoning.encrypted_content']);
});
