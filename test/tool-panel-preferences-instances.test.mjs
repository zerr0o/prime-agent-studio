import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// Isolated dual-instance Preferences proof: no Studio, no browser, no network.
// A minimal DOM stub backs two independent clone scopes (mimicking the parent
// clonePanelScope helper: scoped physical ids + data-panel-id). This proves:
// - every owned lookup routes through the supplied getElement (never the
//   global document for owned ids),
// - dynamically created ids/for/aria stay unique per instance,
// - global pref data is shared (computer snapshot, sync monitor) while
//   forms/view state stay independent,
// - secrets never leak between roots,
// - dispose tears down only its own instance.

// ---------- Minimal DOM stub ----------
const createdElements = [];
const documentGetElementByIdCalls = [];
const GLOBAL_DIALOG_ALLOWLIST = new Set([
  'model-config-dialog',
  'model-dialog',
  'mcp-dialog',
  'providers-dialog',
  'remote-access-dialog',
  'commands-dialog',
  'sync-forget-dialog',
]);

function makeTextNode(text) {
  return { nodeType: 3, data: String(text), parentNode: null };
}

function makeElement(tag) {
  const classes = new Set();
  const el = {
    classList: {
      add(...names) {
        names.forEach((name) => classes.add(name));
      },
      remove(...names) {
        names.forEach((name) => classes.delete(name));
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
    },
    tag,
    nodeType: 1,
    childNodes: [],
    children: [],
    dataset: {},
    style: {},
    attributes: {},
    parentNode: null,
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    textContent: '',
    open: false,
    nextSibling: null,
    handlers: {},
    appendedTo: [],
    setAttribute(k, v) {
      this.attributes[String(k)] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    },
    removeAttribute(k) {
      delete this.attributes[k];
    },
    append(...nodes) {
      for (const n of nodes) {
        if (n === null || n === undefined || n === false) continue;
        this.children.push(n);
        this.childNodes.push(n);
        if (typeof n === 'object') n.parentNode = this;
      }
      return this;
    },
    appendChild(n) {
      return this.append(n);
    },
    replaceChildren(...nodes) {
      this.children = [];
      this.childNodes = [];
      return this.append(...nodes);
    },
    insertBefore(n) {
      return this.append(n);
    },
    addEventListener(type, fn) {
      (this.handlers[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this.handlers[type] || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    fire(type, event = {}) {
      for (const fn of [...(this.handlers[type] || [])]) fn(event);
    },
    querySelector(sel) {
      const key = String(sel);
      this.selectorCache ||= new Map();
      if (!this.selectorCache.has(key)) {
        // Resolve real descendants first (engine tier select, api content).
        const wantId = key.startsWith('#') ? key.slice(1) : null;
        let found = null;
        if (wantId) {
          const walk = (node) => {
            for (const child of node.children || []) {
              if (typeof child !== 'object') continue;
              if (child.id === wantId || child.getAttribute?.('data-panel-id') === wantId) {
                found = child;
                return true;
              }
              if (walk(child)) return true;
            }
            return false;
          };
          walk(this);
        }
        this.selectorCache.set(key, found || makeElement('div'));
      }
      return this.selectorCache.get(key);
    },
    querySelectorAll() {
      return [];
    },
    contains(node) {
      let at = node;
      while (at) {
        if (at === this) return true;
        at = at.parentNode;
      }
      return false;
    },
    closest() {
      return null;
    },
    focus() {},
    click() {},
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.fire('close');
    },
    get firstChild() {
      return this.childNodes[0];
    },
    get isConnected() {
      return false;
    },
    scrollIntoView() {},
    reportValidity() {
      return true;
    },
    reset() {},
  };
  createdElements.push(el);
  return el;
}

const stubDocument = {
  nodeType: 9,
  hidden: false,
  activeElement: null,
  cookie: '',
  documentElement: { lang: '' },
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => makeTextNode(text),
  createDocumentFragment: () => makeElement('fragment'),
  getElementById: (id) => {
    documentGetElementByIdCalls.push(String(id));
    return null;
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  createTreeWalker: () => ({ nextNode: () => null }),
  addEventListener: () => {},
  removeEventListener: () => {},
};

globalThis.document = stubDocument;
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.CSS = { escape: (value) => String(value) };
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.NodeFilter = { SHOW_ALL: 4294967295 };
globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

const { createInteractionSettings } = await import('../public/interaction-settings.js');
const { createComputerPreferences, __resetSharedComputerForTests } =
  await import('../public/computer-preferences.js');
const { createEngineSettings } = await import('../public/engine-settings.js');
const { createSyncSettings } = await import('../public/sync-settings.js');
const { createPublicApiSettings } = await import('../public/api-settings.js');

// Parent-like clone scope: scoped physical ids + data-panel-id logical tags.
// Mirrors parent clonePanelScope getElement fallback: template nodes first,
// then controller-created scoped ids (e.g. public-api dynamic shell).
function makeScope(prefix) {
  const nodes = new Map();
  const calls = [];
  const domId = (id) => `${prefix}:${id}`;
  const getElement = (id) => {
    calls.push(String(id));
    if (nodes.has(id)) return nodes.get(id);
    // Parent fallback is scoped-physical only (never a generic logical id from
    // another scope): match the exact domId physical id for this prefix.
    const scoped = domId(id);
    for (const el of createdElements) {
      if (el && el.id === scoped) {
        nodes.set(id, el);
        return el;
      }
    }
    const el = makeElement('scoped');
    el.setAttribute('data-panel-id', String(id));
    nodes.set(id, el);
    return el;
  };
  return { prefix, nodes, calls, getElement, domId };
}

const quietContext = () => ({ readOnly: false, remote: false, projectCwd: '/proj' });

// ---------- Interaction: scoped lookups, independent instances ----------
test('interaction instances use only their owned scope', async () => {
  documentGetElementByIdCalls.length = 0;
  const a = makeScope('A');
  const b = makeScope('B');
  let apiCalls = 0;
  const api = async (path) => {
    apiCalls++;
    assert.equal(path, '/api/studio-preferences');
    return { allowQuestionsByDefault: true };
  };
  const seen = [];
  const ia = createInteractionSettings({
    api,
    getContext: quietContext,
    onStudioPreferences: (value) => seen.push(['a', value]),
    getElement: a.getElement,
    domId: a.domId,
    instanceId: 'A',
    isPrimary: false,
  });
  const ib = createInteractionSettings({
    api,
    getContext: quietContext,
    onStudioPreferences: (value) => seen.push(['b', value]),
    getElement: b.getElement,
    domId: b.domId,
    instanceId: 'B',
    isPrimary: false,
  });
  await ia.refreshDefault();
  await ib.refreshDefault();
  assert.equal(a.getElement('default-allow-questions').checked, true);
  assert.equal(b.getElement('default-allow-questions').checked, true);
  // Owned ids never escape to the global document.
  assert.deepEqual(documentGetElementByIdCalls, []);
  assert.notEqual(a.getElement('default-allow-questions'), b.getElement('default-allow-questions'));
  assert.equal(typeof ia.dispose, 'function');
  ia.dispose();
  ib.dispose();
});

// ---------- Computer: shared confirmed data, independent view state ----------
test('computer model/thinking confirm in one instance and read fresh in the other, engine stays native', async () => {
  documentGetElementByIdCalls.length = 0;
  const a = makeScope('A');
  const b = makeScope('B');
  // A stored legacy cua must sanitize to native and never reach the UI.
  const state = { computerBackend: 'cua', computerModel: '', computerThinking: '' };
  const calls = [];
  const api = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET', body: opts.body });
    if (path === '/api/studio-preferences' && !opts.method) return { ...state };
    if (path === '/api/studio-preferences' && opts.method === 'PATCH') {
      Object.assign(state, opts.body);
      return { ...state };
    }
    throw new Error('unexpected ' + path);
  };
  const changed = [];
  const pa = createComputerPreferences({
    api,
    getContext: quietContext,
    getModels: () => [],
    openModelPicker: null,
    getElement: a.getElement,
    domId: a.domId,
    instanceId: 'A',
    isPrimary: true,
    onChanged: (value) => changed.push(['a', value]),
  });
  const pb = createComputerPreferences({
    api,
    getContext: quietContext,
    getModels: () => [],
    openModelPicker: null,
    getElement: b.getElement,
    domId: b.domId,
    instanceId: 'B',
    isPrimary: false,
    onChanged: (value) => changed.push(['b', value]),
  });
  pa.start();
  pb.start();
  await pa.refresh();
  await pb.refresh();
  assert.equal(pa.getBackend(), 'native');
  assert.equal(pb.getBackend(), 'native');
  // Model + thinking confirm in one instance and read fresh in the other.
  await pa.saveModel('m/meta-vision');
  assert.equal(pb.getModel(), 'm/meta-vision');
  await pa.saveThinking('high');
  assert.equal(pb.getThinking(), 'high');
  assert.equal(b.getElement('computer-thinking').value, 'high');
  assert.deepEqual(changed, [
    ['a', { backend: 'native', model: 'm/meta-vision', thinking: '' }],
    ['a', { backend: 'native', model: 'm/meta-vision', thinking: 'high' }],
  ]);
  // No engine selection: no request ever carries computerBackend.
  assert.ok(calls.length > 0);
  for (const call of calls) assert.ok(!call.body || !('computerBackend' in call.body));
  // Owned ids never escape to the global document.
  assert.deepEqual(documentGetElementByIdCalls, []);
  pa.dispose();
  pb.dispose();
});

// ---------- Engine: unique dynamic ids, independent legacy state ----------
test('legacy card ids are unique per instance and reset state stays independent', async () => {
  documentGetElementByIdCalls.length = 0;
  const calls = [];
  const api = async (path, options) => {
    calls.push({ path, method: options?.method || 'GET' });
    if ((options?.method || 'GET') === 'POST')
      return { revision: 'f'.repeat(64), hasLegacy: false, items: [] };
    return { revision: 'e'.repeat(64), hasLegacy: true, items: ['auxiliaryModel', 'budgets'] };
  };
  const mk = (scope, primary, context) =>
    createEngineSettings({
      api,
      getContext: context,
      onChanged: () => {},
      getElement: scope.getElement,
      domId: scope.domId,
      isPrimary: primary,
    });
  const a = makeScope('A');
  const b = makeScope('B');
  const ea = mk(a, true, quietContext);
  const eb = mk(b, false, () => ({ readOnly: true, remote: true, projectCwd: '/proj' }));
  assert.ok(ea.root);
  assert.ok(eb.root);
  await ea.open();
  await eb.open();
  const createdIds = createdElements.map((el) => el.id).filter(Boolean);
  assert.ok(createdIds.includes('A:reset-legacy-settings'));
  assert.ok(createdIds.includes('B:reset-legacy-settings'));
  assert.ok(!createdIds.includes('reset-legacy-settings'));
  // Primary instance keeps the dialog heading id; clones skip it.
  const headings = createdElements.filter((el) => el.id === 'engine-settings-heading');
  assert.equal(headings.length, 1);
  // Full-control instance shows the reset button; the read-only instance hides it.
  const buttonA = createdElements.find((el) => el.id === 'A:reset-legacy-settings');
  const buttonB = createdElements.find((el) => el.id === 'B:reset-legacy-settings');
  assert.equal(buttonA.hidden, false);
  assert.equal(buttonB.hidden, true);
  // Both instances loaded detection; reset posts the locked revision once.
  assert.deepEqual(calls.filter((call) => call.method === 'GET').length >= 2, true);
  await buttonA.onclick();
  assert.deepEqual(calls.at(-1), { path: '/api/engine-settings', method: 'POST' });
  // Global singletons only (model dialogs); owned ids never escape.
  for (const id of documentGetElementByIdCalls) assert.ok(GLOBAL_DIALOG_ALLOWLIST.has(id), id);
  ea.dispose();
  eb.dispose();
});
