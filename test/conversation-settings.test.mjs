import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createConversationSettings, validateConversationSettings } from '../lib/conversation-settings.mjs';
import { transformSessionPreferences } from '../runtime/session-preferences.mjs';

const cwd = resolve('test/project');
test('settings validation rejects unknown fields and invalid values before any native action', () => {
  for (const value of [
    null,
    [],
    {},
    { thinking: 'ultra' },
    { model: 12 },
    { model: 'bad\nmodel' },
    { global: true },
  ])
    assert.throws(() => validateConversationSettings(value), { status: 400 });
  assert.deepEqual(validateConversationSettings({ model: '', thinking: '' }), { model: '', thinking: '' });
});

test('live changes are serialized per session, report native clamping and release after failure', async () => {
  const saved = [],
    run = { sessionId: 'alpha', cwd, status: 'running', thinking: 'low' };
  let release,
    reject = false;
  const service = createConversationSettings({
    store: {
      history: async () => ({ cwd }),
      setConversationSettings: async (id, settings) => {
        saved.push({ id, ...settings });
        return { settings, revision: saved.length };
      },
    },
    getRuns: () => [run],
    getModels: async () => ({ default: { thinking: 'medium' } }),
    getClient: () => ({
      setThinking: () =>
        new Promise((resolve, fail) => {
          release = () => (reject ? fail(new Error('Disconnected')) : resolve('high'));
        }),
    }),
  });
  const change = service.update({ id: 'alpha', cwd, settings: { thinking: 'max' } });
  await new Promise((done) => setImmediate(done));
  assert.equal(service.busy('alpha'), true);
  await assert.rejects(service.update({ id: 'alpha', cwd, settings: { thinking: 'low' } }), { status: 409 });
  assert.equal(saved.length, 0);
  release();
  assert.deepEqual(await change, { settings: { thinking: 'high' }, revision: 1, appliedToRun: true });
  assert.equal(run.thinking, 'high');
  assert.equal(service.busy('alpha'), false);
  reject = true;
  const failed = service.update({ id: 'alpha', cwd, settings: { thinking: 'low' } });
  await new Promise((done) => setImmediate(done));
  const rejected = assert.rejects(failed, /Disconnected/);
  release();
  await rejected;
  assert.equal(saved.length, 1);
  assert.equal(run.thinking, 'high');
  assert.equal(service.busy('alpha'), false);
});

test('native scope adapter preserves session records and fails closed on incompatible engine source', () => {
  const source = `class AgentSession {
    setThinkingLevel(level) { const effectiveLevel = level;
      this.agent.state.thinkingLevel = effectiveLevel;
      this.sessionManager.appendThinkingLevelChange(effectiveLevel);
      this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
    }
    a(model) { this.settingsManager.setDefaultModelAndProvider(model.provider, model.id); }
    b(next) { this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id); }
    c(nextModel) { this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id); }
  }`;
  const transformed = transformSessionPreferences(source, { required: true }).source;
  const Session = new Function(transformed + '; return AgentSession;')();
  const session = new Session(),
    entries = [];
  session.agent = { state: {} };
  session.sessionManager = { appendThinkingLevelChange: (level) => entries.push(level) };
  session.settingsManager = {
    setDefaultThinkingLevel: () => assert.fail('global write'),
    setDefaultModelAndProvider: () => assert.fail('global write'),
  };
  session.setThinkingLevel('high');
  session.a({});
  session.b({});
  session.c({});
  assert.deepEqual(entries, ['high']);
  assert.equal(session.agent.state.thinkingLevel, 'high');
  assert.throws(() =>
    transformSessionPreferences(
      source.replace('setDefaultThinkingLevel(effectiveLevel)', 'newSetter(effectiveLevel)'),
      { required: true },
    ),
  );
  assert.equal(transformSessionPreferences('export const unrelated = 1;').changed, false);
});

test('native scope adapter supports the installed 0.9.5 guarded thinking shape', () => {
  const source = `class AgentSession {
    async _startRlmChildRun() {}
    setThinkingLevel(level) { const effectiveLevel = level;
      this.agent.state.thinkingLevel = effectiveLevel;
      this.sessionManager.appendThinkingLevelChange(effectiveLevel);
      if (this.supportsThinking() || effectiveLevel !== "off") {
        this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
      }
    }
    a(model) { this.settingsManager.setDefaultModelAndProvider(model.provider, model.id); }
    b(next) { this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id); }
    c(nextModel) { this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id); }
  }`;
  const transformed = transformSessionPreferences(source, { required: true });
  assert.equal(transformed.changed, true);
  const Session = new Function(transformed.source + '; return AgentSession;')();
  const session = new Session(),
    entries = [];
  session.agent = { state: {} };
  session.supportsThinking = () => true;
  session.sessionManager = { appendThinkingLevelChange: (level) => entries.push(level) };
  session.settingsManager = {
    setDefaultThinkingLevel: () => assert.fail('global write'),
    setDefaultModelAndProvider: () => assert.fail('global write'),
  };
  session.setThinkingLevel('high');
  assert.deepEqual(entries, ['high']);
  assert.equal(session.agent.state.thinkingLevel, 'high');
});

test('native scope adapter is idempotent on already scoped engine modules', () => {
  const raw = `class AgentSession {
    async _startRlmChildRun() {}
    setThinkingLevel(level) { const effectiveLevel = level;
      this.agent.state.thinkingLevel = effectiveLevel;
      this.sessionManager.appendThinkingLevelChange(effectiveLevel);
      this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
    }
    a(model) { this.settingsManager.setDefaultModelAndProvider(model.provider, model.id); }
    b(next) { this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id); }
    c(nextModel) { this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id); }
  }`;
  const once = transformSessionPreferences(raw, { required: true });
  assert.equal(once.changed, true);
  const twice = transformSessionPreferences(once.source, { required: true });
  assert.equal(twice.changed, false);
  assert.equal(twice.source, once.source);
  assert.match(once.source, /session preference only/);
});

test('native scope adapter still fails closed on partial engine shapes', () => {
  const partial = `class AgentSession {
    setThinkingLevel(level) { const effectiveLevel = level;
      this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
    }
    a(model) { this.settingsManager.setDefaultModelAndProvider(model.provider, model.id); }
  }`;
  assert.throws(
    () => transformSessionPreferences(partial, { required: true }),
    /thinking=1 models=1 scoped=0/,
  );
});
