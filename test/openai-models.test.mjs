import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  ANTHROPIC_OPUS_55,
  OPENAI_GPT6_MODELS,
  OPENAI_CODEX_GPT6_MODELS,
  STUDIO_MODELS,
  CODEX_CATALOG_CLIENT_VERSION,
  registerStudioModelSupport,
} from '../lib/studio-models.mjs';
import { transformStudioModelSupport, studioModelSourceKind } from '../runtime/studio-models-hook.mjs';
import { discoverCli } from '../lib/agent.mjs';
import { createNativeModelCatalog } from '../lib/native-model-catalog.mjs';

// Official release values: GPT-6 verified 2026-09-23; Codex client 2026-09-29:
// https://developers.openai.com/api/docs/models/gpt-6-sol
// https://developers.openai.com/api/docs/models/gpt-6-luna
// https://github.com/openai/codex/releases/tag/rust-v0.159.1
const sol = (models) => models.find((model) => model.id === 'gpt-6-sol');
const luna = (models) => models.find((model) => model.id === 'gpt-6-luna');

test('OpenAI GPT-6 API metadata matches official release values', () => {
  assert.equal(OPENAI_GPT6_MODELS.length, 4);
  for (const model of [sol(OPENAI_GPT6_MODELS), luna(OPENAI_GPT6_MODELS)]) {
    assert.equal(model.api, 'openai-responses');
    assert.equal(model.provider, 'openai');
    assert.equal(model.baseUrl, 'https://api.openai.com/v1');
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.deepEqual(model.thinkingLevelMap, { off: 'none', minimal: null, xhigh: 'xhigh', max: 'max' });
    assert.equal(model.contextWindow, 1050000);
    assert.equal(model.maxTokens, 128000);
  }
  assert.equal(sol(OPENAI_GPT6_MODELS).name, 'GPT-6 Sol');
  assert.deepEqual(sol(OPENAI_GPT6_MODELS).cost, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
  assert.equal(luna(OPENAI_GPT6_MODELS).name, 'GPT-6 Luna');
  assert.deepEqual(luna(OPENAI_GPT6_MODELS).cost, {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
  });
});

test('GPT-6.1 Sol API metadata keeps always-on reasoning and its own cache price', () => {
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol (2026-09-29)
  const model = OPENAI_GPT6_MODELS.find((entry) => entry.id === 'gpt-6.1-sol');
  assert.ok(model, 'GPT-6.1 Sol is registered');
  assert.equal(model.name, 'GPT-6.1 Sol');
  assert.equal(model.api, 'openai-responses');
  assert.equal(model.provider, 'openai');
  assert.equal(model.baseUrl, 'https://api.openai.com/v1');
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ['text', 'image']);
  assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: null, xhigh: 'xhigh', max: 'max' });
  assert.deepEqual(model.cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  assert.equal(model.contextWindow, 1050000);
  assert.equal(model.maxTokens, 128000);
});

test('GPT-6.1 Terra API metadata matches the official model documentation', () => {
  const model = OPENAI_GPT6_MODELS.find((entry) => entry.id === 'gpt-6.1-terra');
  assert.equal(model.name, 'GPT-6.1 Terra');
  assert.equal(model.api, 'openai-responses');
  assert.equal(model.provider, 'openai');
  assert.deepEqual(model.input, ['text', 'image']);
  assert.equal(model.contextWindow, 1050000);
  assert.equal(model.maxTokens, 128000);
  assert.deepEqual(model.cost, { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 });
  assert.deepEqual(model.thinkingLevelMap, { off: 'none', minimal: null, xhigh: 'xhigh', max: 'max' });
});

test('Codex GPT-6 metadata uses subscription transport with per-model context', () => {
  assert.equal(OPENAI_CODEX_GPT6_MODELS.length, 4);
  for (const model of OPENAI_CODEX_GPT6_MODELS) {
    assert.equal(model.api, 'openai-codex-responses');
    assert.equal(model.provider, 'openai-codex');
    assert.equal(model.baseUrl, 'https://chatgpt.com/backend-api');
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: null, xhigh: 'xhigh', max: 'max' });
    assert.equal(model.contextWindow, model.id === 'gpt-6.1-terra' ? 500000 : 272000);
    assert.equal(model.maxTokens, 128000);
  }
  assert.deepEqual(sol(OPENAI_CODEX_GPT6_MODELS).cost, sol(OPENAI_GPT6_MODELS).cost);
  assert.deepEqual(luna(OPENAI_CODEX_GPT6_MODELS).cost, luna(OPENAI_GPT6_MODELS).cost);
  const newer = OPENAI_CODEX_GPT6_MODELS.find((model) => model.id === 'gpt-6.1-sol');
  assert.equal(newer.name, 'GPT-6.1 Sol');
  assert.deepEqual(newer.cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
});

test('STUDIO_MODELS bundles all supported models and pins the Codex client identity', () => {
  assert.equal(STUDIO_MODELS.length, 10);
  assert.deepEqual(STUDIO_MODELS.map((model) => `${model.provider}/${model.id}`).sort(), [
    'anthropic/claude-fable-5-2',
    'anthropic/claude-opus-5-5',
    'openai-codex/gpt-6-luna',
    'openai-codex/gpt-6-sol',
    'openai-codex/gpt-6.1-sol',
    'openai-codex/gpt-6.1-terra',
    'openai/gpt-6-luna',
    'openai/gpt-6-sol',
    'openai/gpt-6.1-sol',
    'openai/gpt-6.1-terra',
  ]);
  assert.ok(STUDIO_MODELS.includes(ANTHROPIC_OPUS_55));
  assert.equal(CODEX_CATALOG_CLIENT_VERSION, '0.159.1');
});

test('studioModelSourceKind scopes catalog, adapter, registry and bundles', () => {
  assert.deepEqual(studioModelSourceKind('node_modules/@earendil-works/pi-ai/dist/models.js'), {
    catalog: true,
    adapter: false,
    registry: false,
    bundle: false,
  });
  assert.deepEqual(studioModelSourceKind('node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js'), {
    catalog: false,
    adapter: true,
    registry: false,
    bundle: false,
  });
  assert.deepEqual(studioModelSourceKind('dist/core/model-registry.js'), {
    catalog: false,
    adapter: false,
    registry: true,
    bundle: false,
  });
  assert.deepEqual(studioModelSourceKind('dist/bundle/openai-codex-responses-ABC123.js'), {
    catalog: false,
    adapter: false,
    registry: false,
    bundle: true,
  });
  assert.deepEqual(studioModelSourceKind('dist/core/auth-storage.js'), {
    catalog: false,
    adapter: false,
    registry: false,
    bundle: false,
  });
});

const catalogLoop = 'for (const [provider, models] of Object.entries(MODELS)) {';
const catalogSource = (models) => `
const MODELS = ${JSON.stringify(models)};
const modelRegistry = new Map();
${catalogLoop}
  modelRegistry.set(provider, new Map(Object.entries(models)));
}
globalThis.result = MODELS;
`;

test('catalog injection is generic, additive and idempotent', () => {
  const legacy = { id: 'gpt-5', name: 'Existing model' };
  const source = catalogSource({ openai: { 'gpt-5': legacy } });
  const transformed = transformStudioModelSupport(source, { catalog: true });
  assert.equal(transformStudioModelSupport(transformed, { catalog: true }), transformed);
  const context = {};
  runInNewContext(transformed, context);
  const result = JSON.parse(JSON.stringify(context.result));
  assert.deepEqual(result.openai['gpt-5'], legacy);
  assert.deepEqual(result.openai['gpt-6-sol'], JSON.parse(JSON.stringify(sol(OPENAI_GPT6_MODELS))));
  assert.deepEqual(result.openai['gpt-6-luna'], JSON.parse(JSON.stringify(luna(OPENAI_GPT6_MODELS))));
  assert.deepEqual(
    result['openai-codex']['gpt-6-sol'],
    JSON.parse(JSON.stringify(sol(OPENAI_CODEX_GPT6_MODELS))),
  );
  for (const model of STUDIO_MODELS)
    assert.deepEqual(result[model.provider][model.id], JSON.parse(JSON.stringify(model)));
  assert.deepEqual(result.anthropic['claude-opus-5-5'], JSON.parse(JSON.stringify(ANTHROPIC_OPUS_55)));
  const upstream = { ...JSON.parse(JSON.stringify(sol(OPENAI_GPT6_MODELS))), name: 'Upstream definition' };
  const updated = {};
  runInNewContext(
    transformStudioModelSupport(catalogSource({ openai: { 'gpt-6-sol': upstream } }), { catalog: true }),
    updated,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(updated.result.openai['gpt-6-sol'])), upstream);
  assert.throws(
    () => transformStudioModelSupport('export const unrelated = true;', { catalog: true }),
    /requires an update/,
  );
  assert.equal(
    transformStudioModelSupport('export const unrelated = true;'),
    'export const unrelated = true;',
  );
});

const versionFixture = (declaration, version) =>
  `const MODELS = {};
${declaration} OPENAI_CODEX_CLIENT_VERSION = "${version}";
function loadBuiltInModels(bundledModels, livePrimeInferenceModels) {
  return mergePrimeInferenceModels(bundledModels, livePrimeInferenceModels).map((model) => model);
}
`;

test('native bundled/cached catalogs gain missing models before user overrides, without replacing upstream', () => {
  const legacy = { provider: 'openai', id: 'gpt-5', name: 'Existing native model' };
  const newer = { provider: 'openai', id: 'gpt-6.1-sol', name: 'Newer upstream metadata', maxTokens: 64000 };
  for (const models of [[legacy], [legacy, newer]]) {
    const fixture = `${versionFixture('const', CODEX_CATALOG_CLIENT_VERSION)}
const original = Object.freeze(${JSON.stringify(models)});
const mergePrimeInferenceModels = (models) => models;
globalThis.result = loadBuiltInModels(original, []);
globalThis.original = original;
`;
    const transformed = transformStudioModelSupport(fixture, { registry: true });
    assert.equal(transformStudioModelSupport(transformed, { registry: true }), transformed);
    const context = {};
    runInNewContext(transformed, context);
    const result = JSON.parse(JSON.stringify(context.result));
    assert.deepEqual(JSON.parse(JSON.stringify(context.original)), models);
    assert.equal(new Set(result.map((model) => `${model.provider}/${model.id}`)).size, result.length);
    assert.deepEqual(
      result.find((model) => model.id === 'gpt-5'),
      legacy,
    );
    assert.deepEqual(
      result.find((model) => model.provider === 'openai' && model.id === 'gpt-6.1-sol'),
      models.includes(newer) ? newer : OPENAI_GPT6_MODELS.find((model) => model.id === 'gpt-6.1-sol'),
    );
    const withOverride = fixture.replace(
      '.map((model) => model)',
      '.map((model) => model.provider === "openai" && model.id === "gpt-6.1-sol" ? { ...model, maxTokens: 512 } : model)',
    );
    const overridden = {};
    runInNewContext(transformStudioModelSupport(withOverride, { registry: true }), overridden);
    assert.equal(
      overridden.result.find((model) => model.provider === 'openai' && model.id === 'gpt-6.1-sol').maxTokens,
      512,
    );
  }
  assert.throws(
    () => transformStudioModelSupport('const OPENAI_CODEX_CLIENT_VERSION = "0.159.1";', { registry: true }),
    /native model registry adapter requires an update/,
  );
});

test('registry client version floor updates older and preserves higher', () => {
  const older = versionFixture('var', '0.153.4');
  const bumped = transformStudioModelSupport(older, { registry: true });
  assert.match(bumped, /(?:const|var)\s+OPENAI_CODEX_CLIENT_VERSION\s*=\s*"0\.159\.1"/);
  assert.equal(transformStudioModelSupport(bumped, { registry: true }), bumped);
  const olderConst = versionFixture('const', '0.100.0');
  assert.match(transformStudioModelSupport(olderConst, { registry: true }), /"0\.159\.1"/);
  const newer = transformStudioModelSupport(versionFixture('const', '0.200.0'), { registry: true });
  assert.match(newer, /OPENAI_CODEX_CLIENT_VERSION = "0\.200\.0"/);
  assert.equal(transformStudioModelSupport(newer, { registry: true }), newer);
  const equal = transformStudioModelSupport(versionFixture('const', CODEX_CATALOG_CLIENT_VERSION), {
    registry: true,
  });
  assert.match(equal, /OPENAI_CODEX_CLIENT_VERSION = "0\.159\.1"/);
  assert.equal(transformStudioModelSupport(equal, { registry: true }), equal);
  assert.throws(
    () => transformStudioModelSupport('export const unrelated = true;', { registry: true }),
    /requires an update/,
  );
  assert.throws(
    () => transformStudioModelSupport(`${older}\n${older}`, { registry: true }),
    /requires an update/,
  );
});

// Synthetic credentials only. ``readOpenAICodexAccountId`` and the Codex
// ``extractAccountId`` helper parse this shape without verifying signatures,
// so an unsigned fixture JWT never touches a real account.
const fixtureJwt = [
  'studio',
  Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'studio-test-account' } }),
  ).toString('base64'),
  'fixture',
].join('.');
const payloadSentinel = new Error('studio-test-payload-captured');
const fixtureContext = () => ({
  messages: [{ role: 'user', content: 'Say ok.' }],
  systemPrompt: 'You are a test fixture.',
});

async function capturePayload(t, streamFn, model, options) {
  const cli = discoverCli();
  if (!cli?.packageDir) return t.skip('Prime Agent integration requires the installed runtime');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Network is disabled in this fixture');
  };
  try {
    let captured;
    const stream = streamFn(model, fixtureContext(), {
      apiKey: 'fixture-key',
      sessionId: 'studio-openai-test',
      ...options,
      onPayload: (payload, seen) => {
        captured = { payload, seen };
        throw payloadSentinel;
      },
    });
    await stream.result();
    assert.ok(captured, 'onPayload must run before any network use');
    return captured.payload;
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function openaiProviders(t) {
  const cli = discoverCli();
  if (!cli?.packageDir) return t.skip('Prime Agent integration requires the installed runtime');
  registerStudioModelSupport(cli.packageDir);
  const providerDir = join(cli.packageDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers');
  const [responses, codex] = await Promise.all([
    import(pathToFileURL(join(providerDir, 'openai-responses.js')).href),
    import(pathToFileURL(join(providerDir, 'openai-codex-responses.js')).href),
  ]);
  return responses && codex
    ? { responses, codex }
    : t.skip('Prime Agent integration requires the installed runtime');
}

test('OpenAI API effort mapping keeps model-specific off handling, minimal clamps, low..max pass through', async (t) => {
  const providers = await openaiProviders(t);
  if (!providers) return;
  for (const model of OPENAI_GPT6_MODELS) {
    const off = await capturePayload(t, providers.responses.streamSimpleOpenAIResponses, model, {
      reasoning: 'off',
    });
    assert.equal(off.reasoning?.effort, model.id === 'gpt-6.1-sol' ? 'low' : 'none');
    assert.equal(off.model, model.id);
    const minimal = await capturePayload(t, providers.responses.streamSimpleOpenAIResponses, model, {
      reasoning: 'minimal',
    });
    assert.equal(minimal.reasoning?.effort, 'low');
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const params = await capturePayload(t, providers.responses.streamSimpleOpenAIResponses, model, {
        reasoning: level,
      });
      assert.equal(params.reasoning?.effort, level, `${model.id} ${level}`);
    }
  }
});

test('Codex effort mapping: off and minimal clamp to low, none guarded, low..max pass through', async (t) => {
  const providers = await openaiProviders(t);
  if (!providers) return;
  for (const model of OPENAI_CODEX_GPT6_MODELS) {
    const off = await capturePayload(t, providers.codex.streamSimpleOpenAICodexResponses, model, {
      apiKey: fixtureJwt,
      reasoning: 'off',
    });
    assert.equal(off.reasoning?.effort, 'low');
    assert.equal(off.model, model.id);
    assert.equal(off.store, false);
    assert.ok(off.instructions);
    const minimal = await capturePayload(t, providers.codex.streamSimpleOpenAICodexResponses, model, {
      apiKey: fixtureJwt,
      reasoning: 'minimal',
    });
    assert.equal(minimal.reasoning?.effort, 'low');
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const body = await capturePayload(t, providers.codex.streamSimpleOpenAICodexResponses, model, {
        apiKey: fixtureJwt,
        reasoning: level,
      });
      assert.equal(body.reasoning?.effort, level, `${model.id} ${level}`);
    }
  }
  const none = await capturePayload(
    t,
    providers.codex.streamOpenAICodexResponses,
    OPENAI_CODEX_GPT6_MODELS[0],
    {
      apiKey: fixtureJwt,
      reasoningEffort: 'none',
    },
  );
  assert.equal(none.reasoning?.effort, 'none');
});

test('native picker catalog exposes GPT-6.1 Sol and Terra with supported efforts, without changing defaults', async (t) => {
  const cli = discoverCli();
  if (!cli?.packageDir) return t.skip('Prime Agent integration requires the installed runtime');
  const dir = await mkdtemp(join(tmpdir(), 'prime-studio-sol61-catalog-'));
  const catalog = createNativeModelCatalog({
    cli,
    agentHome: dir,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PI_OFFLINE: '1' },
  });
  t.after(async () => {
    await catalog.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const secret = 'fixture-openai-key-never-serialized';
  const authText = JSON.stringify({ openai: { type: 'api_key', key: secret } });
  const settingsText = JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-6-sol' });
  await writeFile(join(dir, 'auth.json'), authText);
  await writeFile(join(dir, 'settings.json'), settingsText);
  const result = await catalog.read();
  const model = result.models.find((item) => item.provider === 'openai' && item.id === 'gpt-6.1-sol');
  assert.ok(model);
  assert.equal(model.name, 'GPT-6.1 Sol');
  assert.equal(model.contextWindow, 1050000);
  assert.equal(model.maxTokens, 128000);
  assert.deepEqual(model.input, ['text', 'image']);
  assert.deepEqual(model.thinkingLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  const terra = result.models.find((item) => item.provider === 'openai' && item.id === 'gpt-6.1-terra');
  assert.equal(terra.name, 'GPT-6.1 Terra');
  assert.equal(terra.contextWindow, 1050000);
  assert.deepEqual(terra.thinkingLevels, ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(await readFile(join(dir, 'auth.json'), 'utf8'), authText);
  assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), settingsText);
  await writeFile(join(dir, 'auth.json'), '{}');
  const signedOut = await catalog.read();
  assert.ok(!signedOut.models.some((item) => item.provider === 'openai'));
});

test('mocked Codex catalog uses client 0.159.1 and preserves GPT-6.1 Sol and Terra account access checks', async (t) => {
  const cli = discoverCli();
  if (!cli?.packageDir) return t.skip('Prime Agent integration requires the installed runtime');
  registerStudioModelSupport(cli.packageDir);
  const coreDir = join(cli.packageDir, 'dist', 'core');
  const dir = await mkdtemp(join(tmpdir(), 'prime-studio-openai-registry-'));
  t.after(async () => {
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('prime-studio-openai-registry-'));
    await rm(target, { recursive: true, force: true, maxRetries: 5 });
  });
  await writeFile(
    join(dir, 'models.json'),
    JSON.stringify({
      providers: {
        'openai-codex': {
          models: [
            ...OPENAI_CODEX_GPT6_MODELS,
            {
              id: 'gpt-6-stale-fixture',
              name: 'Stale fixture',
              api: 'openai-codex-responses',
              baseUrl: 'https://chatgpt.com/backend-api',
              reasoning: true,
              input: ['text'],
              contextWindow: 272000,
              maxTokens: 128000,
            },
          ],
        },
      },
    }),
  );
  const { ModelRegistry } = await import(pathToFileURL(join(coreDir, 'model-registry.js')).href);
  const { AuthStorage } = await import(pathToFileURL(join(coreDir, 'auth-storage.js')).href);
  // Exercise native auth subscriptions/reloads rather than a partial storage mock.
  const auth = AuthStorage.inMemory(
    {
      'openai-codex': {
        type: 'oauth',
        access: fixtureJwt,
        refresh: 'fixture-refresh',
        expires: Date.now() + 3600000,
      },
    },
    { usePrimeCliConfig: false },
  );
  const registry = ModelRegistry.create(auth, join(dir, 'models.json'));
  const seen = [];
  const realFetch = globalThis.fetch;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = '1';
  let allowedIds = ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-5.6-luna'];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        models: allowedIds.map((slug) => ({ slug })),
      }),
    };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  });
  const executable = await registry.getExecutableModels();
  assert.equal(seen.length, 1);
  const fetched = new URL(seen[0].url);
  assert.ok(fetched.pathname.endsWith('/codex/models'));
  assert.equal(fetched.searchParams.get('client_version'), '0.159.1');
  assert.equal(seen[0].init.headers['chatgpt-account-id'], 'studio-test-account');
  const codexIds = new Set(
    executable.filter((model) => model.provider === 'openai-codex').map((model) => model.id),
  );
  assert.ok(codexIds.has('gpt-6-sol'));
  assert.ok(codexIds.has('gpt-6-luna'));
  assert.ok(codexIds.has('gpt-6.1-sol'));
  assert.ok(codexIds.has('gpt-6.1-terra'));
  assert.ok(!codexIds.has('gpt-6-stale-fixture'));
  // A fresh native registry must hide the same built-in when the account's
  // server catalog does not grant it. No permissive Studio fallback is added.
  allowedIds = allowedIds.filter((id) => !['gpt-6.1-sol', 'gpt-6.1-terra'].includes(id));
  const restricted = await ModelRegistry.create(auth, join(dir, 'models.json')).getExecutableModels();
  assert.equal(seen.length, 2);
  assert.ok(restricted.some((model) => model.provider === 'openai-codex' && model.id === 'gpt-6-sol'));
  assert.ok(!restricted.some((model) => model.provider === 'openai-codex' && model.id === 'gpt-6.1-sol'));
  assert.ok(!restricted.some((model) => model.provider === 'openai-codex' && model.id === 'gpt-6.1-terra'));
});
