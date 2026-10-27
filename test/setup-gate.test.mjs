import test from 'node:test';
import assert from 'node:assert/strict';
import { setupState } from '../public/setup-gate.js';

const models = [
  { id: 'anthropic/sonnet', provider: 'anthropic' },
  { id: 'openai/gpt', provider: 'openai' },
  { id: 'openai/retired', provider: 'openai', availability: 'unavailable' },
  { id: 'groq/llama', provider: 'groq' },
];
const state = (patch) =>
  setupState({
    configuredProviders: ['anthropic', 'openai'],
    models,
    mainModel: '',
    subagentModel: '',
    ...patch,
  });

test('older servers without provider data never block the first message', () => {
  assert.deepEqual(setupState({ configuredProviders: null, models, mainModel: '', subagentModel: '' }), {
    complete: true,
    unknown: true,
  });
});

test('a provider counts only when it serves a usable model', () => {
  assert.equal(state({ configuredProviders: [] }).provider, false);
  // Web search keys (no models) or settings-only providers are not enough.
  assert.equal(state({ configuredProviders: ['serper'] }).provider, false);
  assert.deepEqual(state({}).providers, ['anthropic', 'openai']);
});

test('the main model must come from a connected provider and be available', () => {
  assert.equal(state({ mainModel: '' }).main, false);
  assert.equal(state({ mainModel: 'groq/llama' }).main, false);
  assert.equal(state({ mainModel: 'openai/retired' }).main, false);
  assert.equal(state({ mainModel: 'missing/model' }).main, false);
  assert.equal(state({ mainModel: 'anthropic/sonnet' }).main, true);
});

test('subagents need their own usable model, possibly from another provider', () => {
  const ready = { mainModel: 'anthropic/sonnet' };
  assert.equal(state({ ...ready, subagentModel: '' }).complete, false);
  assert.equal(state({ ...ready, subagentModel: 'groq/llama' }).complete, false);
  assert.equal(state({ ...ready, subagentModel: 'openai/gpt' }).complete, true);
  // Steps stay ordered: no subagent step without a main model.
  assert.equal(state({ subagentModel: 'openai/gpt' }).subagent, false);
});

test('native setup omits unsupported Studio subagent defaults but still requires provider and main model', () => {
  const native = { subagentDefaultsSupported: false };
  assert.equal(state({ ...native, mainModel: 'anthropic/sonnet' }).complete, true);
  assert.equal(state({ ...native, mainModel: 'groq/llama' }).complete, false);
  assert.equal(state({ ...native, mainModel: 'openai/retired' }).complete, false);
  assert.equal(state({ ...native, mainModel: '' }).complete, false);
  assert.equal(state({ ...native, configuredProviders: [], mainModel: 'anthropic/sonnet' }).complete, false);
  assert.equal(state({ subagentDefaultsSupported: null, mainModel: 'anthropic/sonnet' }).complete, false);
});
