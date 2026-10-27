import test from 'node:test';
import assert from 'node:assert/strict';
import { createComputerUse } from '../public/computer-use.js';
import { t as tr } from '../public/i18n.js';

function element() {
  const attributes = new Map();
  return {
    nodeType: 1,
    childNodes: [],
    dataset: {},
    hidden: false,
    classList: { toggle() {} },
    get firstChild() {
      return this.childNodes[0];
    },
    get textContent() {
      return this.childNodes.map((node) => node.data).join('');
    },
    replaceChildren(...nodes) {
      this.childNodes = nodes;
      for (const node of nodes) node.parentNode = this;
    },
    setAttribute(key, value) {
      attributes.set(key, String(value));
    },
    getAttribute(key) {
      return attributes.get(key) ?? null;
    },
  };
}
const detailIds = [
  'computer-use-details',
  'computer-use-warning',
  'computer-use-owner',
  'computer-use-action',
  'computer-use-hotkey',
];
const scope = (ids) => {
  const nodes = new Map(ids.map((id) => [id, element()]));
  return (id) => nodes.get(id) || null;
};

test('one Computer Use controller paints independent Session details without rerouting controls', async (t) => {
  const main = scope(['computer-use', 'allow-computer-use', 'computer-use-toggle', 'computer-use-status']);
  const a = scope(detailIds),
    b = scope(detailIds);
  const previous = globalThis.document;
  globalThis.document = {
    hidden: false,
    getElementById: main,
    createTextNode: (data) => ({ nodeType: 3, data, parentNode: null }),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const globalContext = { projectCwd: '/B', sessionId: 'sess-b', online: true, readOnly: false };
  const contextA = { projectCwd: '/A', sessionId: 'sess-a', online: true, readOnly: false };
  const contextB = { ...globalContext };
  const requests = [];
  const status = {
    supported: true,
    enabled: false,
    owner: { sessionId: 'sess-a', name: 'Alpha' },
    lastAction: 'Fixture action',
    hotkey: 'Esc',
  };
  const ui = createComputerUse({
    api: async (path, options) => {
      requests.push({ path, method: options?.method || 'GET' });
      return status;
    },
    toast: () => assert.fail('No action or error toast expected'),
    getContext: () => globalContext,
    getDetailTargets: () => [
      { getElement: a, getContext: () => contextA },
      { getElement: b, getContext: () => contextB },
    ],
  });
  t.after(() => ui.destroy());
  await ui.refresh();
  assert.equal(requests.length, 1);
  assert.equal(a('computer-use-details').hidden, false);
  assert.equal(b('computer-use-details').hidden, false);
  assert.equal(a('computer-use-owner').textContent, tr('computer.ownerMine'));
  assert.equal(b('computer-use-owner').textContent, 'Alpha');
  assert.equal(a('computer-use-action').textContent, 'Fixture action');
  assert.equal(b('computer-use-hotkey').textContent, 'Esc');
  assert.equal(main('allow-computer-use').checked, false, 'Toolbar still belongs to focused B');
  globalContext.projectOverview = true;
  ui.update();
  assert.equal(main('computer-use').hidden, true);
  assert.equal(
    a('computer-use-details').hidden,
    false,
    'Pinned A stays visible over another project overview',
  );
  status.owner = { sessionId: 'sess-b', name: 'Beta' };
  await ui.refresh();
  assert.equal(a('computer-use-owner').textContent, 'Beta');
  assert.equal(b('computer-use-owner').textContent, tr('computer.ownerMine'));
  contextA.unavailable = true;
  ui.update();
  assert.equal(a('computer-use-details').hidden, true);
  globalContext.readOnly = true;
  assert.equal(await ui.setEnabled(true), false);
  assert.ok(
    requests.every((request) => request.method === 'GET'),
    'Detail targets never create native actions or writes',
  );
});

test('visible pinned details keep exactly one existing status poller alive', async (t) => {
  const main = scope(['computer-use']);
  const a = scope(detailIds);
  const previous = globalThis.document;
  globalThis.document = {
    hidden: false,
    getElementById: main,
    createTextNode: (data) => ({ nodeType: 3, data, parentNode: null }),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  let tick,
    calls = 0,
    visible = true;
  const intervals = t.mock.method(globalThis, 'setInterval', (callback) => {
    tick = callback;
    return 42;
  });
  const clears = t.mock.method(globalThis, 'clearInterval', () => {});
  const ui = createComputerUse({
    api: async () => {
      calls++;
      return { supported: true };
    },
    toast() {},
    getContext: () => ({ projectCwd: '/B', projectOverview: true, online: true }),
    getDetailTargets: () =>
      visible ? [{ getElement: a, getContext: () => ({ projectCwd: '/A', sessionId: 'a' }) }] : [],
  });
  ui.start();
  ui.start();
  await Promise.resolve();
  assert.equal(intervals.mock.callCount(), 1);
  assert.equal(calls, 1);
  tick();
  await Promise.resolve();
  assert.equal(calls, 2, 'Visible pin refreshes shared status while focused toolbar is hidden');
  visible = false;
  tick();
  await Promise.resolve();
  assert.equal(calls, 2, 'No visible desktop surface means no background requests');
  ui.destroy();
  assert.equal(clears.mock.callCount(), 1);
});

test('conversation changes retain desktop details but invalidate scoped controls and stale replies', async (t) => {
  const main = scope(['computer-use', 'allow-computer-use', 'computer-use-toggle', 'computer-use-status']);
  const pinned = scope(detailIds),
    following = scope(detailIds);
  const previous = globalThis.document;
  globalThis.document = {
    hidden: false,
    getElementById: main,
    createTextNode: (data) => ({ nodeType: 3, data, parentNode: null }),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const active = { projectCwd: '/A', sessionId: 'sess-a', online: true, readOnly: false };
  const locked = { ...active };
  const requests = [],
    pending = [];
  const ui = createComputerUse({
    api: (path, options = {}) => {
      requests.push({ path, method: options.method || 'GET', signal: options.signal });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    toast: () => assert.fail('No writes or action errors expected'),
    getContext: () => active,
    getDetailTargets: () => [
      { getElement: pinned, getContext: () => locked },
      { getElement: following, getContext: () => active },
    ],
  });
  t.after(() => ui.destroy());
  ui.update();
  assert.equal(pinned('computer-use-warning').textContent, tr('computer.loading'));
  assert.equal(pinned('computer-use-owner').textContent, '-');
  const snapshot = {
    supported: true,
    enabled: true,
    owner: { sessionId: 'sess-a', name: 'Alpha' },
    lastAction: 'Known action',
    hotkey: 'Esc',
  };
  const initial = ui.refresh();
  pending.shift().resolve(snapshot);
  await initial;
  assert.equal(ui.shouldIncludeInRun(), true);
  const texts = () => detailIds.slice(1).map((id) => pinned(id).textContent);
  const textBefore = texts();
  const nodesBefore = detailIds.map((id) => pinned(id).firstChild);

  active.sessionId = 'sess-b';
  ui.onSessionChange();
  const bRequest = pending.shift();
  assert.deepEqual(texts(), textBefore, 'Pinned details must not flash Loading or dashes');
  detailIds.forEach((id, i) => assert.equal(pinned(id).firstChild, nodesBefore[i]));
  assert.equal(following('computer-use-owner').textContent, 'Alpha', 'Unlocked owner label follows B');
  assert.equal(ui.status, null, 'Desktop display is not a scoped authorization cache');
  assert.equal(ui.shouldIncludeInRun(), false);
  assert.equal(main('allow-computer-use').checked, false);
  assert.equal(main('computer-use-toggle').disabled, true);
  assert.equal(await ui.setEnabled(true), false);
  assert.equal(await ui.stopComputer(), false);

  active.sessionId = 'sess-c';
  ui.onSessionChange();
  const cRequest = pending.shift();
  assert.equal(requests[1].signal.aborted, true);
  bRequest.resolve({ ...snapshot, owner: { sessionId: 'sess-b', name: 'Obsolete B' } });
  await Promise.resolve();
  assert.deepEqual(texts(), textBefore, 'Obsolete response cannot replace desktop details');
  assert.equal(ui.status, null);
  cRequest.reject(new Error('offline fixture'));
  await Promise.resolve();
  assert.equal(pinned('computer-use-warning').textContent, tr('computer.statusError'));
  assert.equal(pinned('computer-use-owner').textContent, tr('computer.ownerMine'));
  assert.equal(pinned('computer-use-action').textContent, 'Known action');
  assert.equal(pinned('computer-use-hotkey').textContent, 'Esc');
  assert.equal(main('computer-use-toggle').disabled, true);
  assert.equal(ui.shouldIncludeInRun(), false);

  const recovered = ui.refresh();
  pending.shift().resolve({
    ...snapshot,
    enabled: false,
    owner: { sessionId: 'sess-c', name: 'Gamma' },
    lastAction: 'New action',
  });
  await recovered;
  assert.equal(pinned('computer-use-owner').textContent, 'Gamma');
  assert.equal(following('computer-use-owner').textContent, tr('computer.ownerMine'));
  assert.equal(pinned('computer-use-action').textContent, 'New action');
  assert.equal(main('allow-computer-use').checked, false);
  assert.equal(ui.shouldIncludeInRun(), false);
  locked.readOnly = active.readOnly = true;
  ui.update();
  assert.equal(pinned('computer-use-warning').textContent, tr('computer.readonlyNote'));
  assert.equal(await ui.setEnabled(true), false);
  assert.equal(await ui.stopComputer(), false);
  locked.unavailable = true;
  ui.update();
  assert.equal(pinned('computer-use-details').hidden, true, 'Unavailable target never inherits another');
  assert.ok(requests.every((request) => request.method === 'GET'));
  assert.equal(requests.length, 4, 'Navigation keeps the single existing fetch path');
});

test('scoped permission stays independent when another session holds the desktop', async (t) => {
  const main = scope(['computer-use', 'allow-computer-use', 'computer-use-toggle', 'computer-use-status']);
  const previous = globalThis.document;
  globalThis.document = {
    hidden: false,
    getElementById: main,
    createTextNode: (data) => ({ nodeType: 3, data, parentNode: null }),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const ctx = { projectCwd: '/A', sessionId: 'sess-a', online: true, readOnly: false };
  const requests = [];
  // Own session allowed, but the desktop is held by another root's child.
  let current = {
    supported: true,
    enabled: true,
    owner: { sessionId: 'sess-other', agentSessionId: 'agent-9', agentId: 'child-9', name: 'Other child' },
    busy: false,
    hotkey: 'Esc',
  };
  const ui = createComputerUse({
    api: async (path, options = {}) => {
      const method = options?.method || 'GET';
      requests.push({ path, method, body: options?.body });
      if (method === 'POST') {
        if (options?.body?.enabled === true) current = { ...current, enabled: true };
        else current = { ...current, enabled: false };
        return { ...current };
      }
      return { ...current };
    },
    toast: () => assert.fail('No toast expected for permission-only toggle'),
    getContext: () => ctx,
  });
  t.after(() => ui.destroy());
  await ui.refresh();
  assert.equal(ui.shouldIncludeInRun(), true, 'Own scoped flag arms the run even with a foreign holder');
  assert.equal(
    main('allow-computer-use').checked,
    true,
    'Toggle reflects own permission, not the foreign owner',
  );
  // Disabling the own flag is always allowed and never steals the other owner.
  assert.equal(await ui.setEnabled(false), false, 'Disabling clears the own flag (enabled false)');
  assert.equal(requests.filter((r) => r.method === 'POST').length, 1, 'Own permission change must POST');
  assert.equal(current.owner?.sessionId, 'sess-other', 'Other holder is never stolen by permission change');
  assert.equal(ui.shouldIncludeInRun(), false);
  // Re-enabling while the other holder is still active is also allowed (no takeover confirmation).
  assert.equal(await ui.setEnabled(true), true);
  assert.equal(requests.filter((r) => r.method === 'POST').length, 2);
  assert.equal(current.owner?.sessionId, 'sess-other');
  assert.equal(ui.shouldIncludeInRun(), true);
});

test('busy desktop shows working and owner keeps the executing child identity', async (t) => {
  const { normalizeComputerStatus, ownerDisplayName } = await import('../public/computer-use.js');
  const status = normalizeComputerStatus({
    supported: true,
    enabled: true,
    owner: {
      sessionId: 'sess-a',
      runId: 'run-a',
      agentSessionId: 'agent-1',
      agentId: 'child-1',
      name: 'Desktop child',
    },
    busy: true,
  });
  assert.equal(status.owner?.sessionId, 'sess-a', 'Root session stays the root conversation');
  assert.equal(status.owner?.agentSessionId, 'agent-1', 'Agent session identifies the executing child');
  assert.equal(status.owner?.agentId, 'child-1');
  assert.equal(status.owner?.name, 'Desktop child');
  assert.equal(ownerDisplayName(status.owner), 'Desktop child', 'Child name is displayed when present');
  assert.equal(
    ownerDisplayName({ agentSessionId: 'agent-abcdef123456' }),
    '#agent-ab',
    'Agent session falls back to a short id',
  );

  const main = scope(['computer-use', 'allow-computer-use', 'computer-use-toggle', 'computer-use-status']);
  const previous = globalThis.document;
  globalThis.document = {
    hidden: false,
    getElementById: main,
    createTextNode: (data) => ({ nodeType: 3, data, parentNode: null }),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const ctx = { projectCwd: '/A', sessionId: 'sess-a', online: true, readOnly: false };
  const ui = createComputerUse({
    api: async () => ({
      supported: true,
      enabled: true,
      owner: { sessionId: 'sess-other', name: 'Other child' },
      busy: true,
      hotkey: 'Esc',
    }),
    toast() {},
    getContext: () => ctx,
  });
  t.after(() => ui.destroy());
  await ui.refresh();
  assert.equal(ui.shouldIncludeInRun(), true, 'Busy foreign holder never blocks own permission');
  assert.equal(
    main('computer-use-status').textContent,
    tr('computer.working'),
    'Global busy shows working even with independent permission',
  );
});

test('main send keeps the origin conversation model (Computer Use is permission only)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(
    source.includes('originTriple?.model'),
    'sendMessage must keep the origin conversation triple as the main model',
  );
  assert.ok(
    !source.includes('globalComputerModel'),
    'sendMessage must not override the main model with the global Computer Use preference',
  );
});
