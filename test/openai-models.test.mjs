import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// Official release values, verified 2026-09-23:
// https://developers.openai.com/api/docs/models/gpt-6-sol
// https://developers.openai.com/api/docs/models/gpt-6-luna
// https://github.com/openai/codex/releases/tag/rust-v0.156.1
const sol = (models) => models.find((model) => model.id === 'gpt-6-sol');
const luna = (models) => models.find((model) => model.id === 'gpt-6-luna');

test('OpenAI GPT-6 API metadata matches official release values', () => {
  assert.equal(OPENAI_GPT6_MODELS.length, 2);
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

test('Codex GPT-6 metadata uses subscription transport with 272000 context', () => {
  assert.equal(OPENAI_CODEX_GPT6_MODELS.length, 2);
  for (const model of [sol(OPENAI_CODEX_GPT6_MODELS), luna(OPENAI_CODEX_GPT6_MODELS)]) {
    assert.equal(model.api, 'openai-codex-responses');
    assert.equal(model.provider, 'openai-codex');
    assert.equal(model.baseUrl, 'https://chatgpt.com/backend-api');
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: null, xhigh: 'xhigh', max: 'max' });
    assert.equal(model.contextWindow, 272000);
    assert.equal(model.maxTokens, 128000);
  }
  assert.deepEqual(sol(OPENAI_CODEX_GPT6_MODELS).cost, sol(OPENAI_GPT6_MODELS).cost);
  assert.deepEqual(luna(OPENAI_CODEX_GPT6_MODELS).cost, luna(OPENAI_GPT6_MODELS).cost);
});

test('STUDIO_MODELS bundles all five and pins the Codex floor version', () => {
  assert.equal(STUDIO_MODELS.length, 5);
  assert.deepEqual(STUDIO_MODELS.map((model) => `${model.provider}/${model.id}`).sort(), [
    'anthropic/claude-opus-5-5',
    'openai-codex/gpt-6-luna',
    'openai-codex/gpt-6-sol',
    'openai/gpt-6-luna',
    'openai/gpt-6-sol',
  ]);
  assert.ok(STUDIO_MODELS.includes(ANTHROPIC_OPUS_55));
  assert.equal(CODEX_CATALOG_CLIENT_VERSION, '0.156.1');
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
`;

test('registry client version floor updates older and preserves higher', () => {
  const older = versionFixture('var', '0.153.4');
  const bumped = transformStudioModelSupport(older, { registry: true });
  assert.match(bumped, /(?:const|var)\s+OPENAI_CODEX_CLIENT_VERSION\s*=\s*"0\.156\.1"/);
  assert.equal(transformStudioModelSupport(bumped, { registry: true }), bumped);
  const olderConst = versionFixture('const', '0.100.0');
  assert.match(transformStudioModelSupport(olderConst, { registry: true }), /"0\.156\.1"/);
  const newer = versionFixture('const', '0.200.0');
  assert.equal(transformStudioModelSupport(newer, { registry: true }), newer);
  const equal = versionFixture('const', CODEX_CATALOG_CLIENT_VERSION);
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

test('OpenAI API effort mapping: off sends none, minimal clamps, low..max pass through', async (t) => {
  const providers = await openaiProviders(t);
  if (!providers) return;
  for (const model of OPENAI_GPT6_MODELS) {
    const off = await capturePayload(t, providers.responses.streamSimpleOpenAIResponses, model, {
      reasoning: 'off',
    });
    assert.equal(off.reasoning?.effort, 'none');
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

test('mocked Codex catalog fetch pins client_version 0.156.1 and retains Sol/Luna', async (t) => {
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
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        models: [{ slug: 'gpt-6-sol' }, { slug: 'gpt-6-luna' }, { slug: 'gpt-5.6-luna' }],
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
  assert.equal(fetched.searchParams.get('client_version'), '0.156.1');
  assert.equal(seen[0].init.headers['chatgpt-account-id'], 'studio-test-account');
  const codexIds = new Set(
    executable.filter((model) => model.provider === 'openai-codex').map((model) => model.id),
  );
  assert.ok(codexIds.has('gpt-6-sol'));
  assert.ok(codexIds.has('gpt-6-luna'));
  assert.ok(!codexIds.has('gpt-6-stale-fixture'));
});
