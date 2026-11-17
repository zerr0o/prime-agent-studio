import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createSessionActivity } from '../public/session-activity.js';

test('paged read receipts acknowledge only the tail snapshot actually viewed', async () => {
  const storage = new Map(),
    reads = [];
  const activity = createSessionActivity({
    read: (key, fallback) => (storage.has(key) ? storage.get(key) : fallback),
    write: (key, value) => storage.set(key, value),
    loadHistory: async () => {
      throw Error('unexpected history load');
    },
    saveRead: async (id, answer) => {
      reads.push({ id, answer });
      return { readState: { answer, read: answer, revision: 3 } };
    },
  });
  const history = {
    id: 's',
    updatedAt: '2026-10-12T00:00:00Z',
    messageCount: 1200,
    messages: [{ id: 'tool', role: 'assistant', tools: [{ name: 'read' }] }],
    readState: { answer: 'done-before-page', read: 'earlier', revision: 2 },
  };
  activity.observe(history);
  assert.equal(activity.isUnread('s'), true);
  assert.equal(
    activity.markRead('s', history.messages),
    false,
    'no fabricated final answer from tool-only page',
  );
  assert.equal(
    activity.markRead('s', history.messages, 'older-snapshot'),
    false,
    'stale fetched receipt never acknowledges newer activity',
  );
  assert.equal(activity.markRead('s', history.messages, history.readState.answer), true);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(reads, [{ id: 's', answer: 'done-before-page' }]);
  assert.equal(activity.isUnread('s'), false);
});

test('optimistic completed run uses its displayed answer, not the stale pre-run page receipt', async () => {
  const activity = createSessionActivity({
    read: (_key, fallback) => fallback,
    write: () => {},
    loadHistory: async () => {
      throw Error('unexpected history load');
    },
  });
  const final = { id: 'new-final', role: 'assistant', text: 'Current completed answer', tools: [] };
  activity.observe({
    id: 's',
    messages: [final],
    messageCount: 100,
    updatedAt: '2026-10-12T00:00:00Z',
    readState: { answer: 'new-final', read: 'previous-final', revision: 2 },
  });
  const view = { id: 'conversation', sessionId: 's', loading: false, history: [] };
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = source.slice(
    source.indexOf('function markVisibleSessionRead('),
    source.indexOf('// Host-scroller routing'),
  );
  const context = {
    state: { projectOverview: false },
    document: { hidden: false, querySelector: () => null },
    dockingUI: { active: true, visiblePanels: () => ['conversation'] },
    $: () => ({
      scrollHeight: 200,
      scrollTop: 0,
      clientHeight: 200,
      clientWidth: 500,
      getClientRects: () => [{}],
    }),
    PRIMARY_VIEW_ID: 'conversation',
    convViews: { composerLive: () => true, byId: () => view },
    runForView: () => ({ initialized: true, status: 'completed', base: [], messages: [final] }),
    isRunning: () => false,
    historyPageFor: () => ({ meta: { hasBefore: true }, receipt: 'previous-final' }),
    sessionActivity: activity,
    renderProjects() {},
    renderSessions() {},
    renderProjectOverview() {},
  };
  vm.createContext(context);
  vm.runInContext(fn, context);
  context.markVisibleSessionRead(view);
  assert.equal(activity.isUnread('s'), false);
});
