// Exercise production paging orchestration with deferred I/O, not a second implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { historyPageUrl, fetchRecentHistory, prependHistoryPage } from '../public/history-pages.js';
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(
  app.indexOf('function historyOwner('),
  app.indexOf('// Focused navigation restores controls'),
);
assert.ok(source.includes('function loadOlderViewHistory('));
const msg = (id) => ({ id, role: 'user', text: id });
const history = (id, ids, cursor = 'older', start = 80) => ({
  id,
  messages: ids.map(msg),
  historyPage: {
    total: start + ids.length,
    limit: 80,
    start,
    end: start + ids.length,
    hasBefore: !!cursor,
    beforeCursor: cursor,
  },
  readState: { answer: `answer-${id}` },
});
function fixture() {
  const a = { id: 'conversation', sessionId: 'a', token: 1, history: [], scrollTop: 0, follow: false },
    b = { id: 'conv:b', sessionId: 'b', token: 1, history: [], scrollTop: 0, follow: false };
  const views = new Map([
      [a.id, a],
      [b.id, b],
    ]),
    requests = [],
    paints = [],
    toasts = [],
    runs = new Map();
  let focused = b;
  const state = { sessionId: b.sessionId, history: b.history };
  const sandbox = {
    state,
    viewHistoryPages: new WeakMap(),
    PRIMARY_VIEW_ID: 'conversation',
    followConversation: false,
    dockingUI: { active: true },
    historyPageUrl,
    fetchRecentHistory,
    prependHistoryPage,
    convViews: {
      bySession: (id) => [...views.values()].find((v) => v.sessionId === id),
      byId: (id) => views.get(id),
      composerLive: () => true,
      isFocused: (id) => id === focused.id,
      focused: () => focused,
      renderViewNow: (id) => paints.push(id),
    },
    renderHostPrimary: (_force, v) => paints.push(v.id),
    renderMessages: () => paints.push(focused.id),
    runForView: (v) => runs.get(v.id),
    // Action admission is tested separately; paging still renders its owner.
    navHistory: { resolveDraft() {} },
    captureConversationAction: (view) => ({ view }),
    actionMessages: (view) => view?.history || [],
    findLatestResumableId: () => null,
    conversationActionBlocked: () => 'unavailable in paging fixture',
    historyBeforeRun: (messages) => messages.filter((m) => !m.id.startsWith('live-')),
    $: () => ({ scrollTop: 0 }),
    tr: (key) => key,
    toast: (fn) => toasts.push(fn()),
    api: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  sandbox.acceptViewHistory(a, history('a', ['a80', 'a81'], 'a-before'));
  sandbox.acceptViewHistory(b, history('b', ['b80', 'b81'], 'b-before'));
  state.history = b.history;
  return {
    ...sandbox,
    a,
    b,
    requests,
    paints,
    toasts,
    runs,
    state,
    focus: (v) => {
      focused = v;
      state.sessionId = v.sessionId;
      state.history = v.history;
    },
  };
}

test('older responses update their owner only, keep other pane focus/data, and update live base only', async () => {
  const f = fixture(),
    stream = [msg('live-1')];
  f.runs.set(f.a.id, { initialized: true, base: f.a.history, messages: stream });
  const saved = f.b.history,
    previous = f.a.history,
    job = f.loadOlderViewHistory(f.a);
  assert.equal(f.requests.length, 1);
  assert.equal(new URL(f.requests[0].url, 'http://fixture').searchParams.get('before'), 'a-before');
  assert.equal(f.historyRenderOptions(f.a).loadingOlder, true);
  assert.equal(f.loadOlderViewHistory(f.a), job, 'duplicate caller shares the in-flight promise');
  assert.equal(f.requests.length, 1, 'duplicate in-flight call is blocked');
  f.requests[0].resolve(history('a', ['a0', 'a80'], null, 0));
  await job;
  assert.deepEqual(
    f.a.history.map((m) => m.id),
    ['a0', 'a80', 'a81'],
  );
  assert.equal(f.b.history, saved);
  assert.equal(f.state.history, saved);
  assert.deepEqual(
    previous.map((m) => m.id),
    ['a80', 'a81'],
  );
  assert.deepEqual(
    f.runs.get(f.a.id).base.map((m) => m.id),
    ['a0', 'a80', 'a81'],
  );
  assert.equal(f.runs.get(f.a.id).messages, stream);
  assert.equal(f.historyRenderOptions(f.a).loadingOlder, false);
  assert.equal(f.historyRenderOptions(f.a).hasOlder, false);
  assert.ok(f.paints.every((id) => id === f.a.id));
});

test('rebind while older page is pending cannot contaminate the new session or its cursor', async () => {
  const f = fixture(),
    job = f.loadOlderViewHistory(f.a);
  f.a.sessionId = 'new';
  f.a.token++;
  f.acceptViewHistory(f.a, history('new', ['new80'], 'new-before'));
  f.requests[0].resolve(history('a', ['old'], null, 0));
  await job;
  assert.deepEqual(
    f.a.history.map((m) => m.id),
    ['new80'],
  );
  const next = f.loadOlderViewHistory(f.a);
  assert.equal(new URL(f.requests[1].url, 'http://fixture').searchParams.get('before'), 'new-before');
  f.requests[1].resolve(history('new', ['new0'], null, 0));
  await next;
  assert.deepEqual(
    f.a.history.map((m) => m.id),
    ['new0', 'new80'],
  );
});

test('a newer snapshot wins over an older-page response already in flight', async () => {
  const f = fixture(),
    job = f.loadOlderViewHistory(f.a),
    fresh = history('a', ['changed80', 'changed81'], 'fresh-boundary');
  f.acceptViewHistory(f.a, fresh);
  f.requests[0].resolve(history('a', ['stale0'], null, 0));
  await job;
  assert.equal(f.a.history, fresh.messages);
  assert.equal(f.historyRenderOptions(f.a).loadingOlder, false);
});

test('network errors retain data, expose retry, and a retry prepends without duplicates', async () => {
  const f = fixture(),
    before = f.a.history,
    job = f.loadOlderViewHistory(f.a);
  f.requests[0].reject(Object.assign(Error('offline'), { status: 503 }));
  await job;
  assert.equal(f.a.history, before);
  assert.equal(f.historyRenderOptions(f.a).olderError, 'conversation_window.load_failed');
  assert.equal(f.historyRenderOptions(f.a).loadingOlder, false);
  const retry = f.loadOlderViewHistory(f.a);
  assert.equal(f.requests[1].url, f.requests[0].url);
  f.requests[1].resolve(history('a', ['a0', 'a80'], null, 0));
  await retry;
  assert.deepEqual(
    f.a.history.map((m) => m.id),
    ['a0', 'a80', 'a81'],
  );
  assert.equal(f.historyRenderOptions(f.a).olderError, null);
});

test('409 cursor replacement reloads the latest bounded page without mixing old data', async () => {
  const f = fixture(),
    job = f.loadOlderViewHistory(f.a);
  f.requests[0].reject(Object.assign(Error('source changed'), { status: 409 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests.length, 2);
  const freshUrl = new URL(f.requests[1].url, 'http://fixture');
  assert.equal(freshUrl.searchParams.get('limit'), '80');
  assert.equal(freshUrl.searchParams.has('before'), false);
  f.requests[1].resolve(history('a', ['replacement'], null, 0));
  await job;
  assert.deepEqual(
    f.a.history.map((m) => m.id),
    ['replacement'],
  );
  assert.deepEqual(f.toasts, ['conversation_window.history_changed']);
});

test('navigation during 409 recovery cannot publish its stale second response', async () => {
  const f = fixture(),
    job = f.loadOlderViewHistory(f.a);
  f.requests[0].reject(Object.assign(Error('source changed'), { status: 409 }));
  await new Promise((resolve) => setImmediate(resolve));
  f.a.sessionId = 'new';
  f.a.token++;
  f.acceptViewHistory(f.a, history('new', ['new80'], 'new-before'));
  f.requests[1].resolve(history('a', ['replacement'], null, 0));
  await job;
  assert.deepEqual(
    f.a.history.map((m) => m.id),
    ['new80'],
  );
  assert.deepEqual(f.toasts, []);
});

function completionFixture() {
  const f = fixture();
  Object.assign(f, {
    translateKnown: (x) => x,
    upsertSession() {},
    saveSelection() {},
    scheduleMessages() {},
    refreshModelCatalog() {},
    refreshOverview: async () => {},
    renderNavigation() {},
    composerUpdates: [],
    updateComposer(view) { f.composerUpdates.push(view?.id); },
    computerUseUI: null,
    sessionActivity: { observe() {} },
  });
  f.convViews.refreshView = (id) => f.paints.push(id);
  f.convViews.refreshTitles = () => {};
  const run = {
    id: 'run-old',
    sessionId: 'a',
    initialized: true,
    base: [msg('a80')],
    messages: [{ id: 'live-answer', role: 'assistant', text: 'completed answer', tools: [] }],
  };
  f.a.viewRunId = run.id;
  f.convViews.byRun = (id) => (id === run.id ? f.a : null);
  vm.createContext(f);
  vm.runInContext(
    app.slice(app.indexOf('async function finishRun('), app.indexOf('async function sendMessage(')),
    f,
  );
  return { f, run };
}

test('background completion canonicalizes its pane and current globals after focus changes mid-fetch', async () => {
  const { f, run } = completionFixture();
  const done = f.finishRun(run, { status: 'completed', sessionId: 'a' });
  f.focus(f.a);
  f.state.viewRunId = run.id;
  f.requests[0].resolve(history('a', ['a80', 'canonical-answer'], null, 0));
  await done;
  assert.equal(f.a.viewRunId, null);
  assert.equal(f.state.viewRunId, null);
  assert.deepEqual(
    f.a.history.map((m) => m.id),
    ['a80', 'canonical-answer'],
  );
  assert.equal(f.state.history, f.a.history);
  assert.deepEqual(f.composerUpdates, [f.a.id], 'finished run updates only its origin composer');
  assert.ok(
    f.paints.filter((id) => id === f.a.id).length >= 2,
    'primary host repaints even if completion began in background',
  );
});

test('late completion cannot replace or clear a newer run in the same session', async () => {
  const { f, run } = completionFixture();
  const done = f.finishRun(run, { status: 'completed', sessionId: 'a' });
  f.a.viewRunId = 'run-new';
  f.focus(f.a);
  f.state.viewRunId = 'run-new';
  const current = f.a.history;
  f.requests[0].resolve(history('a', ['old-result'], null, 0));
  await done;
  assert.equal(f.a.viewRunId, 'run-new');
  assert.equal(f.state.viewRunId, 'run-new');
  assert.equal(f.a.history, current);
});

function jumpFixture() {
  const f = fixture(),
    revealed = [];
  f.b.shell = { messages: {}, scroller: { scrollTop: 123 } };
  f.b.renderer = {
    reveal: (root, id) => {
      revealed.push({ root, id });
      return {};
    },
  };
  return { f, revealed };
}

test('history jump awaits an existing older-page request and reveals only its owner target', async () => {
  const { f, revealed } = jumpFixture(),
    other = f.a.history;
  const page = f.loadOlderViewHistory(f.b);
  const jump = f.revealHistoryMessage('b0');
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(history('b', ['b0'], null, 0));
  await Promise.all([page, jump]);
  assert.equal(revealed.length, 1);
  assert.equal(revealed[0].id, 'b0');
  assert.equal(revealed[0].root, f.b.shell.messages);
  assert.equal(f.b.scrollTop, 123);
  assert.equal(f.a.history, other);
});

test('history jump cannot steal focus after navigation during its page fetch', async () => {
  const { f, revealed } = jumpFixture();
  const jump = f.revealHistoryMessage('b0');
  f.focus(f.a);
  f.requests[0].resolve(history('b', ['b0'], null, 0));
  await jump;
  assert.equal(revealed.length, 0);
  assert.equal(f.convViews.focused(), f.a);
});

test('history jump stops on page failure and exposes a retry notice', async () => {
  const { f, revealed } = jumpFixture();
  f.b.renderer.reveal = () => null;
  const jump = f.revealHistoryMessage('b0');
  f.requests[0].reject(new Error('offline'));
  await jump;
  assert.equal(f.requests.length, 1);
  assert.equal(revealed.length, 0);
  assert.ok(f.toasts.includes('conversation_window.message_unavailable'));
  assert.equal(f.historyRenderOptions(f.b).olderError, 'conversation_window.load_failed');
});
