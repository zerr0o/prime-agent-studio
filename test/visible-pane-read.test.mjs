import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const views = await readFile(new URL('../public/conversation-views.js', import.meta.url), 'utf8');
const readFunction = app.slice(
  app.indexOf('function markVisibleSessionRead('),
  app.indexOf('// Host-scroller routing'),
);
const paintFunction = views.slice(
  views.indexOf('  function renderBg('),
  views.indexOf('  function scheduleBg('),
);

function fixture() {
  const scroller = {
    scrollHeight: 200,
    scrollTop: 0,
    clientHeight: 200,
    clientWidth: 500,
    getClientRects: () => [{}],
  };
  const host = { ...scroller };
  const view = {
    id: 'conv:short',
    sessionId: 'short',
    loading: false,
    history: [{ id: 'final', role: 'assistant', text: 'Short answer' }],
    shell: { scroller, bg: { hidden: false } },
  };
  const primary = { ...view, id: 'conversation', sessionId: 'primary' };
  const reads = [];
  const context = vm.createContext({
    PRIMARY_VIEW_ID: 'conversation',
    state: { projectOverview: false },
    document: { hidden: false, querySelector: () => null },
    dockingUI: { active: true, visiblePanels: () => [view.id, primary.id] },
    convViews: { composerLive: () => true, byId: () => primary, focused: () => view },
    $: () => host,
    runForView: () => null,
    isRunning: (run) => ['running', 'stopping'].includes(run?.status),
    historyPageFor: () => ({ meta: {}, receipt: 'final' }),
    sessionActivity: {
      markRead: (...args) => {
        reads.push(args);
        return true;
      },
    },
    renderProjects() {},
    renderSessions() {},
    renderProjectOverview() {},
  });
  vm.runInContext(readFunction, context);
  return { context, view, primary, scroller, host, reads };
}

test('short visible pane acknowledges its captured history receipt without any scroll', () => {
  const f = fixture();
  f.context.markVisibleSessionRead(f.view);
  assert.deepEqual(f.reads, [['short', f.view.history, 'final']]);
});

for (const [name, change] of [
  [
    'hidden document',
    (f) => {
      f.context.document.hidden = true;
    },
  ],
  [
    'loading history',
    (f) => {
      f.view.loading = true;
    },
  ],
  [
    'project overview',
    (f) => {
      f.context.state.projectOverview = true;
    },
  ],
  [
    'hidden tab',
    (f) => {
      f.context.dockingUI.visiblePanels = () => ['conversation'];
    },
  ],
  [
    'hidden shell',
    (f) => {
      f.view.shell.bg.hidden = true;
    },
  ],
  [
    'parked DOM',
    (f) => {
      f.scroller.getClientRects = () => [];
    },
  ],
  [
    'zero height',
    (f) => {
      f.scroller.clientHeight = 0;
    },
  ],
  [
    'zero width',
    (f) => {
      f.scroller.clientWidth = 0;
    },
  ],
  [
    'detached from bottom',
    (f) => {
      f.scroller.scrollHeight = 500;
    },
  ],
  [
    'modal or mobile overlay',
    (f) => {
      f.context.document.querySelector = () => ({});
    },
  ],
  [
    'running response',
    (f) => {
      f.context.runForView = () => ({ status: 'running' });
    },
  ],
  [
    'stopping response',
    (f) => {
      f.context.runForView = () => ({ status: 'stopping' });
    },
  ],
]) {
  test(`read gate rejects ${name}`, () => {
    const f = fixture();
    change(f);
    f.context.markVisibleSessionRead(f.view);
    assert.deepEqual(f.reads, []);
  });
}

test('switching from live docking to classic acknowledges the focused host, not the primary or parked shell', () => {
  const f = fixture();
  f.context.dockingUI.active = false;
  f.view.shell.bg.hidden = true;
  f.scroller.getClientRects = () => [];
  f.context.markVisibleSessionRead();
  assert.deepEqual(f.reads, [['short', f.view.history, 'final']]);
  f.reads.length = 0;
  f.context.markVisibleSessionRead(f.primary);
  assert.deepEqual(f.reads, [], 'an old parked-view callback must not acknowledge the displayed host');
});

test('host refresh retains the existing near-bottom threshold instead of bypassing it', () => {
  const f = fixture();
  f.host.scrollHeight = 500;
  f.context.markVisibleSessionRead();
  assert.deepEqual(f.reads, []);
  f.host.scrollTop = 201;
  f.context.markVisibleSessionRead();
  assert.deepEqual(f.reads, [['primary', f.primary.history, 'final']]);
});

for (const [name, docked, visible, focused, expected] of [
  ['focused short pane', true, true, true, 1],
  ['unfocused visible pane keeps explicit unread', true, true, false, 0],
  ['hidden pane', true, false, true, 0],
  ['parked classic shell', false, false, true, 0],
]) {
  test(`pane paint: ${name}`, () => {
    const f = fixture();
    let requests = 0;
    Object.assign(f.view, { follow: true, scrollTop: 0, renderer: { render: () => null } });
    Object.assign(f.view.shell, { messages: { isConnected: true }, pill: { hidden: false } });
    const context = vm.createContext({
      PRIMARY_VIEW_ID: 'conversation',
      dockedActive: docked,
      visibleIds: visible ? [f.view.id] : [],
      focusedId: focused ? f.view.id : 'conversation',
      paintViewChrome() {},
      viewMessages: (view) => view.history,
      historyRenderOptions: () => ({}),
      refreshShellText() {},
      markSessionRead: (view) => {
        assert.equal(view, f.view);
        requests++;
      },
    });
    vm.runInContext(paintFunction, context);
    context.renderBg(f.view);
    assert.equal(requests, expected);
  });
}
