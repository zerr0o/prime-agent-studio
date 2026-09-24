import test from 'node:test';
import assert from 'node:assert/strict';
import studioImages from '../runtime/studio-image-extension.mjs';

const plain = { provider: 'fixture', id: 'plain', input: ['text'] };
const vision = { provider: 'fixture', id: 'vision', input: ['text', 'image'] };
function fixture({ model = plain, served = vision, trailing = [] } = {}) {
  const handlers = new Map();
  studioImages({ on: (name, handler) => handlers.set(name, handler) });
  const assistant = {
    type: 'message',
    message: {
      role: 'assistant',
      provider: served?.provider,
      model: served?.id,
      content: [{ type: 'text', text: 'Image answer' }],
    },
  };
  const branch = [
    { type: 'model_change', provider: model?.provider, modelId: model?.id },
    assistant,
    ...trailing,
  ];
  const appended = [];
  const ctx = {
    model,
    modelRegistry: {
      find: (provider, id) => [plain, vision].find((entry) => entry.provider === provider && entry.id === id),
    },
    sessionManager: {
      getBranch: () => branch,
      appendModelChange(provider, modelId) {
        const entry = { type: 'model_change', provider, modelId };
        branch.push(entry);
        appended.push(entry);
      },
    },
  };
  return {
    handlers,
    ctx,
    branch,
    assistant,
    appended,
    end: (messages = []) => handlers.get('agent_end')({ messages }, ctx),
  };
}

test('image extension retains inline-image guidance and registers completion handler', async () => {
  const f = fixture();
  const prompt = await f.handlers.get('before_agent_start')({ systemPrompt: 'Original' });
  assert.ok(prompt.systemPrompt.startsWith('Original\n\n'));
  assert.match(prompt.systemPrompt, /project-relative\/path\.png/);
  assert.equal(typeof f.handlers.get('agent_end'), 'function');
});

test('routed image completion appends configured model once without rewriting messages', () => {
  const f = fixture({ trailing: [{ type: 'custom', data: 'unrelated metadata' }] });
  const before = structuredClone(f.branch);
  // Retry continuations can have no new image prompt in agent_end.messages.
  f.end();
  assert.deepEqual(f.branch.slice(0, before.length), before);
  assert.equal(f.branch[1], f.assistant);
  assert.deepEqual(f.appended, [{ type: 'model_change', provider: 'fixture', modelId: 'plain' }]);
  f.end();
  assert.equal(f.appended.length, 1, 'completion replay appends no duplicate provenance');
});

test('native image models, matching models and explicit switches stay unchanged', () => {
  for (const options of [
    { model: vision },
    { served: plain },
    { model: null },
    { served: { provider: 'fixture', id: 'unknown' } },
    { trailing: [{ type: 'model_change', provider: 'fixture', modelId: 'vision' }] },
  ]) {
    const f = fixture(options);
    f.end();
    assert.equal(f.appended.length, 0, JSON.stringify(options));
  }
  const noAssistant = fixture();
  noAssistant.branch.splice(1);
  noAssistant.end();
  assert.equal(noAssistant.appended.length, 0);
});

test('missing persistence API or failed append is reported, not silently accepted', () => {
  const absent = fixture();
  delete absent.ctx.sessionManager.appendModelChange;
  assert.throws(() => absent.end(), /image routing persistence adapter requires an update/);
  const failed = fixture();
  failed.ctx.sessionManager.appendModelChange = () => {
    throw new Error('fixture write refused');
  };
  assert.throws(() => failed.end(), /fixture write refused/);
  assert.equal(failed.appended.length, 0);
});
