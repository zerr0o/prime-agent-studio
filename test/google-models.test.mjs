import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  GOOGLE_GEMINI4_MODELS,
  geminiCarbonCost,
  STUDIO_MODELS,
  registerStudioModelSupport,
} from '../lib/studio-models.mjs';
import { transformStudioModelSupport } from '../runtime/studio-models-hook.mjs';
import { discoverCli } from '../lib/agent.mjs';
import { createNativeModelCatalog } from '../lib/native-model-catalog.mjs';

const neon = (models = GOOGLE_GEMINI4_MODELS) => models.find((model) => model.id === 'gemini-4-neon');
const carbon = (models = GOOGLE_GEMINI4_MODELS) => models.find((model) => model.id === 'gemini-4-carbon');
const hydrogen = (models = GOOGLE_GEMINI4_MODELS) => models.find((model) => model.id === 'gemini-4-hydrogen');

test('Google Gemini 4 exposes exactly neon/carbon/hydrogen on the google provider', () => {
  assert.equal(GOOGLE_GEMINI4_MODELS.length, 3);
  assert.deepEqual(
    GOOGLE_GEMINI4_MODELS.map((model) => model.id).sort(),
    ['gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-4-neon'],
  );
  for (const model of GOOGLE_GEMINI4_MODELS) {
    assert.equal(model.provider, 'google');
    assert.equal(model.api, 'google-generative-ai');
    assert.equal(model.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.equal(model.contextWindow, 1048576);
    assert.equal(model.maxTokens, 65536);
  }
  assert.ok(STUDIO_MODELS.includes(neon()));
  assert.ok(STUDIO_MODELS.includes(carbon()));
  assert.ok(STUDIO_MODELS.includes(hydrogen()));
});

test('Gemini 4 Neon metadata keeps official limits/prices and xhigh effort', () => {
  const model = neon();
  assert.ok(model);
  assert.equal(model.name, 'Gemini 4 Neon');
  assert.deepEqual(model.cost, { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 });
  assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: null, xhigh: 'xhigh', max: null });
});

test('Gemini 4 Carbon metadata pins dated introductory rates and caps at high', () => {
  const model = carbon();
  assert.ok(model);
  assert.equal(model.name, 'Gemini 4 Carbon');
  // Introductory $2/$10/$0.10 through Nov 30, 2026, then $4/$20/$0.20 from Dec 1, 2026.
  assert.deepEqual(geminiCarbonCost(Date.UTC(2026, 10, 30, 23, 59, 59)), { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 });
  assert.deepEqual(geminiCarbonCost(Date.UTC(2026, 11, 1)), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 });
  assert.deepEqual(model.cost, geminiCarbonCost());
  assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: null, xhigh: null, max: null });
});

test('Gemini 4 Hydrogen metadata keeps official limits/prices and xhigh effort', () => {
  const model = hydrogen();
  assert.ok(model);
  assert.equal(model.name, 'Gemini 4 Hydrogen');
  // $1.50/$7.50/$0.075 flat, implicit caching only, cached rate through Dec 31, 2026.
  assert.deepEqual(model.cost, { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 });
  assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: null, xhigh: 'xhigh', max: null });
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

test('catalog injection adds Gemini 4 without replacing upstream google entries', () => {
  const legacy = { id: 'gemini-2.5-flash', name: 'Existing native model' };
  const source = catalogSource({ google: { 'gemini-2.5-flash': legacy } });
  const transformed = transformStudioModelSupport(source, { catalog: true });
  assert.equal(transformStudioModelSupport(transformed, { catalog: true }), transformed);
  const context = {};
  runInNewContext(transformed, context);
  const result = JSON.parse(JSON.stringify(context.result));
  assert.deepEqual(result.google['gemini-2.5-flash'], legacy);
  for (const model of GOOGLE_GEMINI4_MODELS)
    assert.deepEqual(result.google[model.id], JSON.parse(JSON.stringify(model)));
  const upstream = { ...JSON.parse(JSON.stringify(neon())), name: 'Upstream definition' };
  const updated = {};
  runInNewContext(
    transformStudioModelSupport(catalogSource({ google: { 'gemini-4-neon': upstream } }), { catalog: true }),
    updated,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(updated.result.google['gemini-4-neon'])), upstream);
});

async function nativeParts(t) {
  const cli = discoverCli();
  if (!cli?.packageDir) {
    t.skip('Prime Agent engine unavailable');
    return null;
  }
  registerStudioModelSupport(cli.packageDir);
  const load = (path) => import(pathToFileURL(join(cli.packageDir, path)).href);
  const models = await load('node_modules/@earendil-works/pi-ai/dist/models.js');
  return { cli, ...models };
}

for (const definition of GOOGLE_GEMINI4_MODELS) {
  test(`${definition.name}: native thinking levels clamp to documented efforts`, async (t) => {
    const native = await nativeParts(t);
    if (!native) return;
    // Use the Studio definition directly: native getSupportedThinkingLevels/clamp
    // only read thinkingLevelMap, so no bundled-engine update is required here.
    // Real registry availability (auth + overrides) is covered by the isolated
    // picker test below, which exercises the worker's ModelRegistry.create path.
    assert.equal(definition.provider, 'google');
    assert.equal(definition.api, 'google-generative-ai');
    assert.equal(definition.reasoning, true);
    assert.ok(definition.input.includes('image'));
    assert.equal(definition.contextWindow, 1048576);
    assert.equal(definition.maxTokens, 65536);
    const expectedLevels =
      definition.id === 'gemini-4-carbon'
        ? ['low', 'medium', 'high']
        : ['low', 'medium', 'high', 'xhigh'];
    assert.deepEqual(native.getSupportedThinkingLevels(definition), expectedLevels);
    assert.equal(native.clampThinkingLevel(definition, 'off'), 'low');
    assert.equal(native.clampThinkingLevel(definition, 'minimal'), 'low');
    assert.equal(native.clampThinkingLevel(definition, 'low'), 'low');
    assert.equal(native.clampThinkingLevel(definition, 'medium'), 'medium');
    assert.equal(native.clampThinkingLevel(definition, 'high'), 'high');
    if (definition.id === 'gemini-4-carbon') {
      assert.equal(native.clampThinkingLevel(definition, 'xhigh'), 'high');
      assert.equal(native.clampThinkingLevel(definition, 'max'), 'high');
    } else {
      assert.equal(native.clampThinkingLevel(definition, 'xhigh'), 'xhigh');
      assert.equal(native.clampThinkingLevel(definition, 'max'), 'xhigh');
    }
  });
}

test('registry transform preserves google user overrides without replacing upstream', () => {
  const fixture = `const MODELS = {};
const OPENAI_CODEX_CLIENT_VERSION = "0.166.0";
function loadBuiltInModels(bundledModels, livePrimeInferenceModels) {
  return mergePrimeInferenceModels(bundledModels, livePrimeInferenceModels).map((model) => model);
}
const original = Object.freeze([]);
const mergePrimeInferenceModels = (models) => models;
globalThis.result = loadBuiltInModels(original, []);
`;
  const transformed = transformStudioModelSupport(fixture, { registry: true });
  assert.match(transformed, /gemini-4-neon/);
  assert.match(transformed, /gemini-4-carbon/);
  assert.match(transformed, /gemini-4-hydrogen/);
  assert.equal(transformStudioModelSupport(transformed, { registry: true }), transformed);
  const context = {};
  runInNewContext(transformed, context);
  const result = JSON.parse(JSON.stringify(context.result));
  for (const definition of GOOGLE_GEMINI4_MODELS)
    assert.ok(
      result.some((model) => model.provider === 'google' && model.id === definition.id),
      `registry exposes ${definition.id}`,
    );
  const withOverride = fixture.replace(
    '.map((model) => model)',
    '.map((model) => model.provider === "google" && model.id === "gemini-4-neon" ? { ...model, maxTokens: 512 } : model)',
  );
  const overridden = {};
  runInNewContext(transformStudioModelSupport(withOverride, { registry: true }), overridden);
  assert.equal(
    overridden.result.find((model) => model.provider === 'google' && model.id === 'gemini-4-neon').maxTokens,
    512,
  );
});

test('isolated native picker exposes Gemini 4 without credentials or network', async (t) => {
  const cli = discoverCli();
  if (!cli?.packageDir) return t.skip('Prime Agent engine unavailable');
  const dir = await mkdtemp(join(tmpdir(), 'prime-studio-gemini4-picker-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const secret = 'gemini4-fixture-secret';
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ google: { type: 'api_key', key: secret } }));
  await writeFile(join(dir, 'models.json'), '{"providers":{}}');
  const catalog = createNativeModelCatalog({
    cli,
    agentHome: dir,
    env: {
      SystemRoot: process.env.SystemRoot,
      PATH: process.env.PATH,
      PI_OFFLINE: '1',
    },
  });
  t.after(async () => {
    await catalog.close();
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Network is disabled in this fixture');
  };
  let result;
  try {
    result = await catalog.read();
  } finally {
    globalThis.fetch = realFetch;
  }
  for (const definition of GOOGLE_GEMINI4_MODELS) {
    const model = result.models.find((item) => item.provider === 'google' && item.id === definition.id);
    assert.ok(model, `picker exposes ${definition.id}`);
    assert.equal(model.name, definition.name);
    assert.equal(model.contextWindow, 1048576);
    assert.equal(model.maxTokens, 65536);
    assert.equal(model.reasoning, true);
    assert.ok(model.input.includes('image'));
    if (definition.id === 'gemini-4-carbon') {
      assert.deepEqual(model.thinkingLevels, ['low', 'medium', 'high']);
    } else {
      assert.deepEqual(model.thinkingLevels, ['low', 'medium', 'high', 'xhigh']);
    }
    assert.equal(model.thinkingLevels.includes('off'), false);
    assert.equal(model.thinkingLevels.includes('minimal'), false);
    assert.equal(model.thinkingLevels.includes('max'), false);
  }
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(
    JSON.stringify(result).includes('https://generativelanguage.googleapis.com'),
    false,
  );
  await writeFile(join(dir, 'auth.json'), '{}');
  const signedOut = await catalog.read();
  assert.equal(
    signedOut.models.some((item) => item.provider === 'google'),
    false,
  );
});
