import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { GOOGLE_GEMINI4_MODELS, registerStudioModelSupport } from '../lib/studio-models.mjs';
import { transformStudioModelSupport, studioModelSourceKind } from '../runtime/studio-models-hook.mjs';
import { discoverCli } from '../lib/agent.mjs';

// Gemini 4 generateContent transport compatibility.
// Official thinking levels (verified 2026-11-19):
// - Carbon: low, medium, high, default medium.
//   https://aistudio.google.com/docs/whats-new-gemini-4-carbon
// - Neon/Hydrogen: low, medium, high, xhigh, default high.
//   https://aistudio.google.com/docs/whats-new-gemini-4-hydrogen
//   https://aistudio.google.com/docs/thinking
// Installed runtime: prime-agent 0.9.8 simple Google adapter
// (node_modules/@earendil-works/pi-ai/dist/providers/google.js) routes unknown
// models through numeric thinking budgets and has no xhigh mapping. The XHIGH
// wire value matches the official ThinkingLevel enum shipped in newer
// @google/genai releases (3.6.1: XHIGH = "XHIGH"); the installed 1.52.0 SDK
// only declares up to HIGH, so xhigh beyond that is passed through as the
// documented enum value, never invented per-model budgets.
// Model metadata (ids, pricing, windows, thinkingLevelMap) is owned by
// lib/studio-models.mjs; this file covers only the runtime transport.

const WIRE_LEVEL = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', xhigh: 'XHIGH' };
// Official per-model defaults used as the default probes below.
const OFFICIAL_DEFAULT = { 'gemini-4-carbon': 'medium', 'gemini-4-neon': 'high', 'gemini-4-hydrogen': 'high' };

test('studioModelSourceKind scopes the Google adapter alongside Anthropic', () => {
  assert.deepEqual(studioModelSourceKind('node_modules/@earendil-works/pi-ai/dist/providers/google.js'), {
    catalog: false,
    adapter: true,
    registry: false,
    bundle: false,
  });
  assert.deepEqual(
    studioModelSourceKind('node_modules/@mariozechner/pi-ai/dist/providers/google.js'),
    {
      catalog: false,
      adapter: true,
      registry: false,
      bundle: false,
    },
  );
  // The shared converter needs no transform; only the adapter entry point does.
  assert.deepEqual(
    studioModelSourceKind('node_modules/@earendil-works/pi-ai/dist/providers/google-shared.js'),
    {
      catalog: false,
      adapter: false,
      registry: false,
      bundle: false,
    },
  );
});

const googleFixture = () => `function streamSimpleGoogle() {
  return getGoogleThinkingBudget();
}
function getGoogleThinkingBudget() {
  return -1;
}
export const streamSimple = (googleModel) => {
  if (isGemini3ProModel(googleModel) || isGemini3FlashModel(googleModel) || isGemma4Model(googleModel)) {
    return { level: getThinkingLevel('high', googleModel) };
  }
  return { budgetTokens: 1 };
};
function isGemma4Model(model) {
  return model.id.startsWith('gemma-4');
}
function isGemini3ProModel(model) {
  return model.id.startsWith('gemini-3-pro');
}
function isGemini3FlashModel(model) {
  return model.id.startsWith('gemini-3-flash');
}
function getDisabledThinkingConfig(model) {
  if (isGemini3ProModel(model)) {
    return { thinkingLevel: 'LOW' };
  }
  if (isGemini3FlashModel(model)) {
    return { thinkingLevel: 'MINIMAL' };
  }
  if (isGemma4Model(model)) {
    return { thinkingLevel: 'MINIMAL' };
  }
  // Gemini 2.x supports disabling via thinkingBudget = 0.
  return { thinkingBudget: 0 };
}
function getThinkingLevel(effort, model) {
  return effort;
}
globalThis.fixture = { getThinkingLevel, getDisabledThinkingConfig };
`;

test('Google adapter transform is additive, idempotent and bundle-safe', () => {
  const source = googleFixture().replace('export const streamSimple =', 'const streamSimple =');
  for (const kind of [{ adapter: true }, { bundle: true }, {}]) {
    const transformed = transformStudioModelSupport(source, kind);
    assert.ok(transformed.includes('/* Studio: Gemini 4 generateContent thinking levels. */'));
    assert.ok(transformed.includes('isGemini4Model(googleModel) || isGemini3ProModel'));
    assert.ok(transformed.includes('case "xhigh":'));
    assert.ok(transformed.includes('return "XHIGH";'));
    assert.ok(transformed.includes('/* Studio: Gemini 4 has no off level;'));
    assert.equal(transformStudioModelSupport(transformed, kind), transformed);
  }
  const context = {};
  runInNewContext(transformStudioModelSupport(source, { adapter: true }), context);
  const gemini4 = (id) => ({ id });
  assert.equal(context.fixture.getThinkingLevel('low', gemini4('gemini-4-carbon')), 'LOW');
  assert.equal(context.fixture.getThinkingLevel('medium', gemini4('gemini-4-carbon')), 'MEDIUM');
  assert.equal(context.fixture.getThinkingLevel('high', gemini4('gemini-4-neon')), 'HIGH');
  assert.equal(context.fixture.getThinkingLevel('xhigh', gemini4('gemini-4-hydrogen')), 'XHIGH');
  // runInNewContext objects live in another VM realm; compare by value.
  const vmValue = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(vmValue(context.fixture.getDisabledThinkingConfig(gemini4('gemini-4-carbon'))), {
    thinkingLevel: 'LOW',
  });
  // Future or custom models must not inherit an unverified mapping.
  assert.equal(context.fixture.getThinkingLevel('high', gemini4('gemini-4-future')), 'high');
  // Existing models keep their native behavior through the same code path.
  assert.equal(context.fixture.getThinkingLevel('high', gemini4('gemini-2.5-flash')), 'high');
  assert.deepEqual(vmValue(context.fixture.getDisabledThinkingConfig(gemini4('gemini-2.5-flash'))), {
    thinkingBudget: 0,
  });
});

test('Google adapter transform fails closed on upstream shape changes', () => {
  const source = googleFixture().replace('export const streamSimple =', 'const streamSimple =');
  const anchors = [
    'if (isGemini3ProModel(googleModel) || isGemini3FlashModel(googleModel) || isGemma4Model(googleModel)) {',
    'function getThinkingLevel(effort, model) {',
    'return { thinkingBudget: 0 };',
    'function isGemini3FlashModel(model) {',
  ];
  for (const anchor of anchors) {
    assert.throws(
      () => transformStudioModelSupport(source.replace(anchor, '/* upstream-changed */'), { adapter: true }),
      /Studio Google thinking adapter requires an update/,
      anchor,
    );
  }
  assert.throws(
    () => transformStudioModelSupport(`${source}\n${anchors[0]}`, { adapter: true }),
    /Studio Google thinking adapter requires an update/,
  );
  // Non-Google sources keep the existing fail-closed contract.
  assert.throws(() => transformStudioModelSupport('unknown', { adapter: true }), /requires an update/);
});

async function googleTransport(t) {
  const cli = discoverCli();
  if (!cli?.packageDir) {
    t.skip('Prime Agent integration requires the installed runtime');
    return null;
  }
  registerStudioModelSupport(cli.packageDir);
  const providerUrl = pathToFileURL(
    join(cli.packageDir, 'node_modules/@earendil-works/pi-ai/dist/providers/google.js'),
  ).href;
  const catalogUrl = pathToFileURL(join(cli.packageDir, 'node_modules/@earendil-works/pi-ai/dist/models.js'))
    .href;
  const [providers, catalog] = await Promise.all([import(providerUrl), import(catalogUrl)]);
  assert.equal(typeof providers.streamSimpleGoogle, 'function');
  const dir = cli.packageDir;
  const realSource = await readFile(join(dir, 'node_modules/@earendil-works/pi-ai/dist/providers/google.js'), 'utf8');
  const transformed = transformStudioModelSupport(realSource, { adapter: true });
  assert.ok(transformed.includes('/* Studio: Gemini 4 generateContent thinking levels. */'));
  assert.equal(transformStudioModelSupport(transformed, { adapter: true }), transformed);
  assert.equal(transformStudioModelSupport(transformed, { bundle: true }), transformed);
  // The Anthropic adapter keeps its own patch; the Google patch never fires there.
  const anthropicSource = await readFile(
    join(dir, 'node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js'),
    'utf8',
  );
  const anthropicTransformed = transformStudioModelSupport(anthropicSource, { adapter: true });
  assert.ok(anthropicTransformed.includes('/* Studio: Claude Opus 5.5 and Fable 5.2 always-on thinking. */'));
  assert.ok(!anthropicTransformed.includes('Gemini 4 generateContent'));
  return { streamSimpleGoogle: providers.streamSimpleGoogle, getModels: catalog.getModels };
}

const payloadSentinel = new Error('studio-test-payload-captured');

async function captureGenerateContent(streamSimpleGoogle, model, options, context) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Network is disabled in this fixture');
  };
  try {
    let captured;
    const stream = streamSimpleGoogle(model, context, {
      apiKey: 'fixture-key',
      sessionId: 'studio-google-transport-test',
      ...options,
      onPayload: async (params) => {
        captured = params;
        throw payloadSentinel;
      },
    });
    const result = await stream.result();
    assert.match(result.errorMessage || '', /studio-test-payload-captured/);
    assert.ok(captured);
    return captured;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const fixtureContext = (model) => ({
  systemPrompt: 'You are a test fixture.',
  messages: [{ role: 'user', content: 'Say ok.' }],
});

// Mirrors the native getSupportedThinkingLevels rule: low/medium/high are
// supported unless explicitly nulled; xhigh needs an explicit mapping.
const studioSupportedLevels = (model) =>
  ['low', 'medium', 'high', 'xhigh'].filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh') return mapped !== undefined;
    return true;
  });

test('Gemini 4 payloads use thinking levels, never numeric budgets', async (t) => {
  const transport = await googleTransport(t);
  if (!transport) return;
  assert.equal(GOOGLE_GEMINI4_MODELS.length, 3);
  for (const model of GOOGLE_GEMINI4_MODELS) {
    const supported = studioSupportedLevels(model);
    assert.deepEqual(
      supported,
      model.id === 'gemini-4-carbon' ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh'],
      model.id,
    );
    for (const effort of supported) {
      const payload = await captureGenerateContent(
        transport.streamSimpleGoogle,
        model,
        { reasoning: effort },
        fixtureContext(model),
      );
      assert.equal(payload.model, model.id);
      assert.deepEqual(payload.config.thinkingConfig, {
        includeThoughts: true,
        thinkingLevel: WIRE_LEVEL[effort],
      });
    }
    // Official defaults resolve to the documented level.
    const official = await captureGenerateContent(
      transport.streamSimpleGoogle,
      model,
      { reasoning: OFFICIAL_DEFAULT[model.id] },
      fixtureContext(model),
    );
    assert.equal(official.config.thinkingConfig.thinkingLevel, WIRE_LEVEL[OFFICIAL_DEFAULT[model.id]]);
    assert.ok(!('thinkingBudget' in official.config.thinkingConfig));
    // Carbon clamps xhigh to high through the native thinking-level map.
    if (model.id === 'gemini-4-carbon') {
      const clamped = await captureGenerateContent(
        transport.streamSimpleGoogle,
        model,
        { reasoning: 'xhigh' },
        fixtureContext(model),
      );
      assert.deepEqual(clamped.config.thinkingConfig, { includeThoughts: true, thinkingLevel: 'HIGH' });
    }
  }
});

test('Gemini 4 disabled thinking uses the lowest level, never a budget', async (t) => {
  const transport = await googleTransport(t);
  if (!transport) return;
  // The official tables define no off level for Gemini 4, so the disabled
  // marker maps to the lowest supported level (LOW), mirroring the native
  // Gemini 3 handling in the same adapter function.
  for (const model of GOOGLE_GEMINI4_MODELS) {
    for (const reasoning of [undefined, 'off']) {
      const payload = await captureGenerateContent(
        transport.streamSimpleGoogle,
        model,
        { reasoning },
        fixtureContext(model),
      );
      assert.equal(payload.model, model.id);
      assert.deepEqual(payload.config.thinkingConfig, { thinkingLevel: 'LOW' });
    }
  }
});

test('Gemini 4 tool and thought-signature round-trip', async (t) => {
  const transport = await googleTransport(t);
  if (!transport) return;
  const signature = Buffer.from('fixture-thought-signature-01').toString('base64');
  for (const model of GOOGLE_GEMINI4_MODELS) {
    const context = {
      systemPrompt: 'You are a test fixture.',
      tools: [
        {
          name: 'fixture_tool',
          description: 'Offline fixture tool.',
          parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        },
      ],
      messages: [
        { role: 'user', content: 'Look up q.', timestamp: 1 },
        {
          role: 'assistant',
          provider: 'google',
          api: 'google-generative-ai',
          model: model.id,
          content: [
            { type: 'thinking', thinking: 'Fixture plan.', thinkingSignature: signature },
            {
              type: 'toolCall',
              id: 'fixture_call_1',
              name: 'fixture_tool',
              arguments: { q: 'ok' },
              thoughtSignature: signature,
            },
          ],
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'fixture_call_1',
          toolName: 'fixture_tool',
          content: [{ type: 'text', text: 'fixture-result' }],
          isError: false,
          timestamp: 3,
        },
        { role: 'user', content: 'Continue.', timestamp: 4 },
      ],
    };
    const before = structuredClone(context);
    const payload = await captureGenerateContent(
      transport.streamSimpleGoogle,
      model,
      { reasoning: 'high' },
      context,
    );
    assert.deepEqual(context, before);
    assert.equal(payload.model, model.id);
    const declarations = payload.config.tools[0].functionDeclarations;
    assert.equal(declarations[0].name, 'fixture_tool');
    assert.deepEqual(declarations[0].parametersJsonSchema, context.tools[0].parameters);
    const contents = payload.contents.filter((entry) => entry.role === 'model');
    assert.ok(contents.length >= 1);
    const modelParts = contents.flatMap((entry) => entry.parts);
    const thinking = modelParts.find((part) => part.thought === true);
    assert.equal(thinking.text, 'Fixture plan.');
    assert.equal(thinking.thoughtSignature, signature);
    const call = modelParts.find((part) => part.functionCall);
    assert.equal(call.functionCall.name, 'fixture_tool');
    assert.deepEqual(call.functionCall.args, { q: 'ok' });
    assert.equal(call.thoughtSignature, signature);
    assert.ok(!('id' in call.functionCall), 'Gemini 4 carries no fabricated call id');
    const responses = payload.contents
      .filter((entry) => entry.role === 'user')
      .flatMap((entry) => entry.parts)
      .filter((part) => part.functionResponse);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].functionResponse.name, 'fixture_tool');
    assert.deepEqual(responses[0].functionResponse.response, { output: 'fixture-result' });
    assert.ok(!('id' in responses[0].functionResponse), 'Gemini 4 carries no fabricated return id');
    assert.ok(!('thinkingBudget' in payload.config.thinkingConfig));
  }
});

test('Existing Gemini models keep numeric budgets without levels', async (t) => {
  const transport = await googleTransport(t);
  if (!transport) return;
  const flash = transport.getModels('google').find((entry) => entry.id === 'gemini-2.5-flash');
  assert.ok(flash, 'native catalog still exposes gemini-2.5-flash');
  for (const [effort, budget] of [['low', 2048], ['medium', 8192]]) {
    const payload = await captureGenerateContent(
      transport.streamSimpleGoogle,
      flash,
      { reasoning: effort },
      fixtureContext(flash),
    );
    assert.equal(payload.model, 'gemini-2.5-flash');
    assert.deepEqual(payload.config.thinkingConfig, { includeThoughts: true, thinkingBudget: budget });
  }
});
