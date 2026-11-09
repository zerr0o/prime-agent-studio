// Admission uses the production owner-bound helpers, not a second policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const helpers = source.slice(
  source.indexOf('function actionMessages('),
  source.indexOf('function refreshComposerGauges('),
);
function fixture() {
  const a = { id: 'conversation', token: 1, sessionId: 'a', projectCwd: 'C:/a', history: [{ id: 'a1' }] };
  const b = { id: 'conv:b', token: 1, sessionId: 'b', projectCwd: 'C:/b', history: [{ id: 'b1' }] };
  const views = new Map([
      [a.id, a],
      [b.id, b],
    ]),
    runs = new Map();
  const state = { initialized: true, online: true, projects: [], version: { available: true }, requestId: 1 };
  const box = {
    state,
    PRIMARY_VIEW_ID: 'conversation',
    generationPending: new Map(),
    convViews: { focused: () => b, byId: (id) => views.get(id) },
    activeMessages: () => b.history,
    activeRun: () => runs.get('b'),
    runForView: (v) => runs.get(v.sessionId),
    runningForSession: (id) => runs.get(id),
    isRunning: (r) => ['running', 'starting', 'stopping'].includes(r?.status),
    isValidRunCwd: (cwd) => typeof cwd === 'string' && !!cwd,
    tr: (key) => key,
  };
  vm.createContext(box);
  vm.runInContext(helpers, box);
  return { ...box, a, b, views, runs };
}
test('captured actions address their owner, not the focused pane', () => {
  const f = fixture(),
    action = f.captureConversationAction(f.a);
  assert.equal(action.view, f.a);
  assert.equal(action.sessionId, 'a');
  assert.equal(action.cwd, 'C:/a');
  assert.equal(f.conversationActionBlocked(action), '');
  assert.equal(f.actionMessages(f.a), f.a.history);
  f.runs.set('a', { initialized: true, base: f.a.history, messages: [{ id: 'live-a' }] });
  assert.deepEqual(
    Array.from(f.actionMessages(f.a), (m) => m.id),
    ['a1', 'live-a'],
  );
});
test('rebound, removed, or moved owners cannot admit a stale action', () => {
  for (const mutate of [
    (f) => f.a.token++,
    (f) => (f.a.sessionId = 'different'),
    (f) => (f.a.execCwd = 'C:/elsewhere'),
    (f) => f.views.delete(f.a.id),
    (f) => f.views.set(f.a.id, { ...f.a }),
  ]) {
    const f = fixture(),
      action = f.captureConversationAction(f.a);
    mutate(f);
    assert.equal(f.conversationActionBlocked(action), 'contextDetails.reasonStale');
  }
});
test('readonly, run, send, load, network and configuration gates fail closed', () => {
  for (const mutate of [
    (f) => (f.state.readOnly = true),
    (f) => (f.state.initialized = false),
    (f) => (f.state.sending = true),
    (f) => f.runs.set('a', { status: 'running' }),
    (f) => f.runs.set('a', { status: 'stopping' }),
    (f) => (f.a.loading = true),
    (f) => (f.a.unavailable = true),
    (f) => (f.state.online = false),
    (f) => (f.state.modelsLoading = true),
    (f) => (f.state.versionLoading = true),
    (f) => (f.state.version.available = false),
    (f) => f.generationPending.set('a', {}),
    (f) => f.state.projects.push({ cwd: 'C:/a', exists: false }),
    (f) => (f.state.projectOverview = true),
  ]) {
    const f = fixture(),
      action = f.captureConversationAction(f.a);
    mutate(f);
    assert.notEqual(f.conversationActionBlocked(action), '');
  }
});
test('new drafts do not admit session actions and no gate modifies text or files', () => {
  const f = fixture();
  f.a.sessionId = null;
  const draft = { text: 'Keep this text', attachments: ['keep.png'] };
  f.a.draft = draft;
  assert.equal(
    f.conversationActionBlocked(f.captureConversationAction(f.a)),
    'contextDetails.reasonNoSession',
  );
  assert.equal(f.a.draft, draft);
  assert.deepEqual(draft, { text: 'Keep this text', attachments: ['keep.png'] });
});
