import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const views = await readFile(new URL('../public/conversation-views.js', import.meta.url), 'utf8');
function part(source, start, end) {
  const a = source.indexOf(start),
    b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `production function ${start}`);
  return source.slice(a, b);
}
const routing = [
  part(app, 'function applyRunEvent(', 'function subscribe('),
  part(app, 'function scheduleMessages(', 'function renderMessages('),
  part(views, 'function scheduleBg(', 'function persist('),
  part(views, 'function notifyRunEvent(', 'function markDirty('),
].join('\n');
for (const variant of ['background', 'hidden', 'focused', 'primary']) {
  test(`stream burst is coalesced without losing deltas: ${variant}`, () => {
    const frames = [],
      counts = { immediate: 0, background: 0, global: 0 };
    const id = variant === 'primary' ? 'conversation' : 'conv:heavy';
    const focused = variant === 'focused';
    const owner = { id, sessionId: 'S', kind: 'session', viewRunId: 'R' };
    const run = { id: 'R', sessionId: 'S', lastSeq: 0, currentMessage: { text: '' } };
    let inFrame = false;
    const context = createContext({
      PRIMARY_VIEW_ID: 'conversation',
      views: new Map([[id, owner]]),
      visibleIds: variant === 'hidden' ? [] : [id],
      dockedActive: true,
      focusedId: focused ? id : 'another',
      renderScheduled: false,
      state: { viewRunId: focused ? 'R' : 'other' },
      requestAnimationFrame(fn) {
        frames.push(fn);
      },
      noteActivity() {},
      tr: (s) => s,
      ensureAssistant: (r) => r.currentMessage,
      refreshTitles() {},
      renderDetails() {},
      updateComposer() {},
      renderMessages() {
        counts.global++;
      },
      renderBg(view) {
        if (view.id !== 'conversation') counts[inFrame ? 'background' : 'immediate']++;
      },
      renderHostPrimary() {
        counts.immediate++;
      },
      convViews: {
        composerLive: () => true,
        byRun: () => owner,
        bySession: () => owner,
        isFocused: () => focused,
        renderViewNow() {
          counts.immediate++;
        },
        notifyRunEvent: (...args) => context.notifyRunEvent(...args),
      },
    });
    runInContext(routing, context);
    for (let seq = 1; seq <= 100; seq++) context.applyRunEvent(run, { seq, kind: 'text', delta: 'x' });
    assert.equal(counts.immediate, 0);
    assert.ok(frames.length <= 2, 'one owner frame and one global frame at most');
    inFrame = true;
    while (frames.length) frames.shift()();
    assert.equal(counts.background, variant === 'background' ? 1 : 0);
    assert.equal(counts.global, 1);
    assert.equal(run.currentMessage.text, 'x'.repeat(100));
  });
}

test('queued background render does not paint or measure a pane hidden before the frame', () => {
  const render = part(views, 'function renderBg(', 'function scheduleBg(');
  const view = { id: 'conv:hidden', shell: { messages: { isConnected: true } } };
  const context = createContext({ PRIMARY_VIEW_ID: 'conversation', dockedActive: true, visibleIds: [] });
  runInContext(render, context);
  assert.doesNotThrow(() => context.renderBg(view));
});

test('all visible restored sessions hydrate once without changing focus or loading hidden views', () => {
  const hydrate = part(app, 'function hydrateVisibleSessionViews(', 'async function viewsSelectSession(');
  const entries = new Map([
    ['conversation', { sessionId: 'A', history: [], loading: false }],
    ['conv:b', { sessionId: 'B', history: [], loading: false, viewRunId: 'active-run' }],
    ['conv:empty', { sessionId: 'C', history: [], historyMeta: {}, loading: false }],
    ['conv:dirty', { sessionId: 'D', history: [{ text: 'old' }], historyMeta: {}, dirty: true }],
    ['conv:gone', { sessionId: 'E', history: [], unavailable: true }],
    ['conv:hidden', { sessionId: 'F', history: [], loading: false }],
    ['conv:new', { sessionId: null, history: [] }],
  ]);
  const loaded = [];
  const state = { initialized: true, sessionId: 'B', projectCwd: 'owner-B' };
  const context = createContext({
    state,
    dockingUI: {
      active: true,
      visiblePanels: () => [...entries.keys()].filter((id) => id !== 'conv:hidden'),
    },
    convViews: { byId: (id) => entries.get(id) },
    loadSessionIntoView(view) {
      view.loading = true;
      loaded.push(view.sessionId);
    },
  });
  runInContext(hydrate, context);
  context.hydrateVisibleSessionViews();
  context.hydrateVisibleSessionViews();
  assert.deepEqual(loaded, ['A', 'B', 'D']);
  assert.deepEqual(state, { initialized: true, sessionId: 'B', projectCwd: 'owner-B' });
  assert.equal(entries.get('conv:dirty').dirty, false);
});

test('independent composer owns running status; shell retains loading and unavailable notices', () => {
  const refresh = part(views, 'function refreshShellText(', 'function readDraftKey(');
  const context = createContext({
    titleOf: () => 'Test',
    getRun: () => ({ status: 'running' }),
    isRunActive: () => true,
    tr: (key) => key,
  });
  runInContext(refresh, context);
  const view = {
    id: 'conv:test',
    viewRunId: 'R',
    composerNodes: {},
    shell: { root: { setAttribute() {} }, runline: {} },
  };
  context.refreshShellText(view);
  assert.equal(view.shell.runline.hidden, true);
  view.loading = true;
  context.refreshShellText(view);
  assert.equal(view.shell.runline.hidden, false);
  assert.equal(view.shell.runline.textContent, 'conversation_view.loading_session');
  view.loading = false;
  view.unavailable = true;
  context.refreshShellText(view);
  assert.equal(view.shell.runline.textContent, 'conversation_view.unavailable');
  view.unavailable = false;
  view.composerNodes = null;
  context.refreshShellText(view);
  assert.equal(view.shell.runline.textContent, 'conversation_view.agent_working');
});
