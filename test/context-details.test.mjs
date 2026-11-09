// Feature2 isolated module tests (no browser, no backend, no model calls).
// Covers getContextSummary + createContextDetails + renderComposerGauge compat.
import test from 'node:test';
import assert from 'node:assert/strict';

function makeTextNode(data = '') {
  return { nodeType: 3, data: String(data), parentNode: null };
}
function makeElement(doc, tag = 'div') {
  const listeners = new Map();
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    dataset: {},
    hidden: false,
    style: {},
    disabled: false,
    open: false,
    isConnected: true,
    tabIndex: -1,
    _attrs: new Map(),
    _focused: false,
    onclick: null,
    get firstChild() {
      return this.childNodes[0] ?? null;
    },
    get textContent() {
      return this.childNodes.map((n) => (n.nodeType === 3 ? n.data : (n.textContent ?? ''))).join('');
    },
    set textContent(v) {
      this.replaceChildren(makeTextNode(v));
    },
    append(...nodes) {
      for (const n of nodes) {
        n.parentNode = this;
        this.childNodes.push(n);
      }
      return this.childNodes.length;
    },
    replaceChildren(...nodes) {
      for (const n of this.childNodes) n.parentNode = null;
      this.childNodes = [];
      for (const n of nodes) {
        n.parentNode = this;
        this.childNodes.push(n);
      }
    },
    setAttribute(k, v) {
      this._attrs.set(k, String(v));
    },
    getAttribute(k) {
      return this._attrs.get(k) ?? null;
    },
    removeAttribute(k) {
      this._attrs.delete(k);
    },
    addEventListener(t, fn) {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t).add(fn);
    },
    removeEventListener(t, fn) {
      if (!fn) listeners.delete(t);
      else listeners.get(t)?.delete(fn);
    },
    fire(t, e = {}) {
      for (const fn of [...(listeners.get(t) || [])]) fn({ preventDefault() {}, ...e });
    },
    focus() {
      this._focused = true;
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.fire('close');
    },
    remove() {
      this.isConnected = false;
      this.childNodes = [];
    },
  };
  void doc;
  return el;
}
function makeDoc() {
  const doc = {
    body: makeElement(null, 'body'),
    activeElement: null,
    createElement(tag) {
      return makeElement(doc, tag);
    },
    createTextNode(data) {
      return makeTextNode(data);
    },
  };
  doc.body.ownerDocument = doc;
  return doc;
}

// Import first WITHOUT document: i18n skips DOM init when no document exists
// (same pattern as computer-use tests, which stub document only around calls).
const { getContextSummary, createContextDetails } = await import('../public/context-details.js');
const { renderComposerGauge } = await import('../public/inspector.js');
const { messages } = await import('../public/translations.js');
const doc = makeDoc();
globalThis.document = doc;
globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_ALL: 0xffffffff };

test('catalog holds contextDetails keys (root merge)', () => {
  for (const k of [
    'contextDetails.title',
    'contextDetails.confirm',
    'contextDetails.cancel',
    'contextDetails.replaceNote',
    'contextDetails.costNote',
    'contextDetails.reasonRunning',
    'contextDetails.cacheUnknown',
    'contextDetails.openDetails',
  ]) {
    assert.ok(messages[k], `missing catalog key ${k}`);
    assert.ok(messages[k].en && messages[k].fr, `key ${k} needs en+fr`);
  }
});

test('getContextSummary: live, approx, unknown, cache-miss-is-null', () => {
  const live = getContextSummary({
    contextUsage: { tokens: 920, contextWindow: 1000 },
    session: {
      lastRequestUsage: { cacheHitRatio: 0.85, input: 10, cacheRead: 80, cacheWrite: 5, output: 7 },
    },
  });
  assert.equal(live.known, true);
  assert.equal(live.percent, 92);
  assert.equal(live.level, 'warning');
  assert.equal(live.live, true);
  assert.equal(live.approx, false);
  assert.equal(live.cache.hitPercent, 85);
  const approx = getContextSummary({ contextUsage: { tokens: 500, contextWindow: 1000 }, lastRequest: true });
  assert.equal(approx.approx, true);
  assert.equal(approx.live, false);
  assert.equal(approx.cache, null, 'no cache fields -> null, not 0');
  for (const bad of [
    {},
    { contextUsage: { tokens: null, contextWindow: 1000 } },
    { contextUsage: { tokens: 10, contextWindow: 0 } },
    { contextUsage: { tokens: -1, contextWindow: 100 } },
  ]) {
    const s = getContextSummary(bad);
    assert.equal(s.known, false, JSON.stringify(bad));
    assert.equal(s.tokens, null);
    assert.equal(s.percent, null);
    assert.equal(s.cache, null);
  }
  const danger = getContextSummary({ contextUsage: { tokens: 990, contextWindow: 1000 } });
  assert.equal(danger.level, 'danger');
  const capped = getContextSummary({ contextUsage: { tokens: 5000, contextWindow: 1000 } });
  assert.equal(capped.percent, 100);
});

test('renderComposerGauge keeps 2-arg behavior (span text/level/hidden)', () => {
  const gauge = makeElement(doc, 'span');
  renderComposerGauge(gauge, {
    contextUsage: { tokens: 920, contextWindow: 1000 },
    session: { lastRequestUsage: { cacheHitRatio: 0.85 } },
  });
  assert.equal(gauge.hidden, false);
  assert.match(gauge.textContent, /92/, 'percent rendered');
  assert.match(gauge.textContent, /85/, 'cache rendered');
  assert.equal(gauge.dataset.level, 'warning');
  assert.equal(gauge._contextSummary.percent, 92);
  assert.equal(gauge.getAttribute('role'), null, 'no button semantics without onOpen');
  const hidden = makeElement(doc, 'span');
  renderComposerGauge(hidden, {});
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.textContent, '');
  assert.equal(hidden._contextSummary.known, false);
});

test('renderComposerGauge with onOpen becomes accessible button (click+keyboard)', () => {
  const gauge = makeElement(doc, 'span');
  let calls = 0;
  const onOpen = () => {
    calls += 1;
  };
  renderComposerGauge(gauge, { contextUsage: { tokens: 500, contextWindow: 1000 } }, { onOpen });
  assert.equal(gauge.getAttribute('role'), 'button');
  assert.equal(gauge.tabIndex, 0);
  assert.equal(gauge.getAttribute('aria-haspopup'), 'dialog');
  gauge.fire('click');
  gauge.fire('keydown', { key: 'Enter' });
  gauge.fire('keydown', { key: 'x' });
  assert.equal(calls, 2, 'click + Enter only');
  renderComposerGauge(gauge, { contextUsage: { tokens: 500, contextWindow: 1000 } });
  assert.equal(gauge.getAttribute('role'), null, 'removal path clears button semantics');
});

test('details dialog: reason gating, double-click guard, stale target, focus restore', async () => {
  const opener = makeElement(doc, 'span');
  let snapshot = { contextUsage: { tokens: 920, contextWindow: 1000 } };
  let state = { readOnly: false, running: false, hasSession: true, sessionId: 's1', cwd: '/p', key: 'k1' };
  let compacts = 0;
  let resolveCompact;
  const ui = createContextDetails({
    doc,
    getSnapshot: () => snapshot,
    getState: () => ({ ...state }),
    onCompact: async () => {
      compacts += 1;
      if (resolveCompact) await resolveCompact;
    },
  });
  ui.open(opener);
  assert.equal(ui.dialogNode.open, true);
  assert.equal(ui.getLastSummary().percent, 92);
  assert.equal(ui.dialogNode.isConnected, true);
  // confirm enabled then double-click collapses to one backend call
  resolveCompact = new Promise((r) => setTimeout(r, 5));
  const p1 = ui.confirm();
  const p2 = ui.confirm();
  await Promise.all([p1, p2]);
  assert.equal(compacts, 1, 'no double compact');
  // readonly disables with reason
  ui.open(opener);
  state.readOnly = true;
  ui.update();
  assert.equal(await ui.confirm(), false);
  assert.equal(compacts, 1);
  // stale session change refuses cross-pane compact
  state.readOnly = false;
  state.sessionId = 's2';
  state.key = 'k2';
  ui.update();
  assert.equal(await ui.confirm(), false);
  assert.equal(compacts, 1, 'no cross-pane compact');
  // focus restoration when pane closes (target still current)
  state.sessionId = 's1';
  state.key = 'k1';
  ui.update();
  opener._focused = false;
  ui.close();
  assert.equal(opener._focused, true, 'opener refocused on close');
  ui.destroy();
});

test('details dialog: unknown metrics show unknown, confirm disabled, no error', async () => {
  const ui = createContextDetails({
    doc,
    getSnapshot: () => ({}),
    getState: () => ({
      readOnly: false,
      running: false,
      hasSession: false,
      sessionId: null,
      cwd: null,
      key: '',
    }),
    onCompact: async () => {
      throw new Error('must not compact');
    },
  });
  ui.open(makeElement(doc, 'span'));
  const summary = ui.getLastSummary();
  assert.equal(summary.known, false);
  assert.equal(summary.cache, null);
  assert.equal(await ui.confirm(), false, 'no compact without session');
  ui.destroy();
});

test('blockedReason disables with owner-scoped reason', async () => {
  const ui = createContextDetails({
    doc,
    getSnapshot: () => ({ contextUsage: { tokens: 100, contextWindow: 1000 } }),
    getState: () => ({
      readOnly: false,
      running: false,
      hasSession: true,
      sessionId: 's1',
      cwd: '/p',
      key: 'k1',
      blockedReason: 'Génération en cours…',
    }),
    onCompact: async () => {
      throw new Error('must not compact while blocked');
    },
  });
  ui.open(makeElement(doc, 'span'));
  assert.equal(await ui.confirm(), false, 'blocked: no compact');
  ui.destroy();
});

test('onCompact false keeps dialog open; failure reports in-dialog and retry works', async () => {
  let mode = 'decline';
  let calls = 0;
  const ui = createContextDetails({
    doc,
    getSnapshot: () => ({ contextUsage: { tokens: 100, contextWindow: 1000 } }),
    getState: () => ({
      readOnly: false,
      running: false,
      hasSession: true,
      sessionId: 's1',
      cwd: '/p',
      key: 'k1',
    }),
    onCompact: async () => {
      calls += 1;
      if (mode === 'decline') return false;
      if (mode === 'fail') throw new Error('boom-failure');
      return true;
    },
  });
  const opener = makeElement(doc, 'span');
  ui.open(opener);
  assert.equal(await ui.confirm(), false, 'declined');
  assert.equal(calls, 1);
  assert.equal(ui.dialogNode.open, true, 'declined: dialog stays open');
  mode = 'fail';
  assert.equal(await ui.confirm(), false, 'failure reports, no throw');
  assert.equal(calls, 2);
  assert.equal(ui.dialogNode.open, true, 'failure: dialog stays open for retry');
  mode = 'ok';
  assert.equal(await ui.confirm(), true, 'retry succeeds');
  assert.equal(calls, 3);
  assert.equal(ui.dialogNode.open, false, 'success closes');
  ui.destroy();
});

test('focus restores only when owner target still current', () => {
  let key = 'k1';
  const ui = createContextDetails({
    doc,
    getSnapshot: () => ({ contextUsage: { tokens: 100, contextWindow: 1000 } }),
    getState: () => ({ readOnly: false, running: false, hasSession: true, sessionId: 's1', cwd: '/p', key }),
    onCompact: async () => true,
  });
  const opener = makeElement(doc, 'span');
  ui.open(opener);
  key = 'k2';
  ui.close();
  assert.equal(opener._focused, false, 'rebound opener is not refocused');
  ui.destroy();
  const ui2 = createContextDetails({
    doc,
    getSnapshot: () => ({ contextUsage: { tokens: 100, contextWindow: 1000 } }),
    getState: () => ({
      readOnly: false,
      running: false,
      hasSession: true,
      sessionId: 's1',
      cwd: '/p',
      key: 'k1',
    }),
    onCompact: async () => true,
  });
  const opener2 = makeElement(doc, 'span');
  ui2.open(opener2);
  ui2.close();
  assert.equal(opener2._focused, true, 'current opener is refocused');
  ui2.destroy();
});

test('dialog chrome (title, aria-label, close label) refreshes on update', async () => {
  const ui = createContextDetails({
    doc,
    getSnapshot: () => ({ contextUsage: { tokens: 100, contextWindow: 1000 } }),
    getState: () => ({
      readOnly: false,
      running: false,
      hasSession: true,
      sessionId: 's1',
      cwd: '/p',
      key: 'k1',
    }),
    onCompact: async () => true,
  });
  ui.open(makeElement(doc, 'span'));
  const before = messages['contextDetails.title'];
  messages['contextDetails.title'] = { fr: 'Titre retouché', en: 'Retouched title' };
  try {
    ui.update();
    const head = ui.dialogNode.childNodes[0];
    const h2 = head.childNodes[0];
    assert.match(h2.textContent, /retouch/i, 'title retranslated on update');
  } finally {
    messages['contextDetails.title'] = before;
    ui.update();
  }
  ui.destroy();
});
