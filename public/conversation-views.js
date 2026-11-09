/**
 * Conversation view manager (Studio multi-conversation, approach B).
 *
 * ONE live host editor (the real `.conversation-column`: composer, tray, queue,
 * questions) plus N independent REAL background renderer views. Background views
 * render the same live run buffers / durable history through their own
 * `createConversationRenderer` instances — never snapshots, never iframes.
 *
 * Ownership in this file ONLY:
 * - view registry (bounded, sidecar-persisted, content-free),
 * - per-view shells (dock panels), host home marker + classic park container,
 * - per-view scroll/follow state, background render scheduling,
 * - canonical per-binding draft keys (`session:<id>`, `conv:<nonce>`, one-time
 *   legacy `project:` adoption), new-chat generation triples.
 *
 * Everything global (runs Map, SSE, backends, host render, draft textarea,
 * image composer, Roadmap/Inspector) stays in app.js and always reflects the
 * FOCUSED view. Background updates never write global selection.
 */
import { t as tr, bindText, bindAttribute } from './i18n.js';
import { createConversationRenderer } from './conversation.js';
import { MAX_CONVERSATIONS } from './docking-layout.js';

export const PRIMARY_VIEW_ID = 'conversation';
export const SIDECAR_VERSION = 1;
export const REGISTRY_HARD_CAP = 24;

const CONV_ID_PATTERN = /^(conversation|conv:[A-Za-z0-9_-]{1,64})$/;
const normalizeCwd = (value) =>
  String(value || '')
    .replaceAll('\\', '/')
    .replace(/\/$/, '')
    .toLowerCase();

// Canonical per-binding draft keys. Session bindings share the long-standing
// `session:<id>` key (view dedupe guarantees a single writer per session).
// Unsent new chats own `conv:<nonce>` keys unique per creation (the nonce is
// sidecar-persisted, so unsent slots survive reload). Rebinding a panel never
// copies text: the old binding's draft stays under its own key, the new
// binding reads its own key. Legacy `project:<cwd>` migration happens once at
// adoption (the legacy key is deleted); no per-input write-through touches a
// shared project key ever again.
export function draftKeyFor(view) {
  if (!view) return null;
  if (view.sessionId) return `session:${view.sessionId}`;
  return `conv:${view.nonce}`;
}

export function imageKeyOf(view) {
  return draftKeyFor(view);
}

// Origin session resolution (pure, regression-tested): an explicit origin
// view always wins — a session-less (new) origin resolves null and must NEVER
// fall through to another session id. Only a missing origin uses the fallback.
export function originSessionId(origin, fallbackSessionId) {
  if (!origin) return fallbackSessionId;
  return origin.sessionId || null;
}

// Pin identity (pure, regression-tested): an EXPLICIT new->session/run rebind
// rotates the view nonce so the original unsent `conv:<nonce>` slot stays
// intact and a nonce pin can never be hijacked by an unrelated selection.
// Automatic send/SSE promotion mutates the view in place and bypasses
// bindFocused, so rebinding the already-adopted run keeps the nonce and the
// pin adopts that session.
export function shouldRotateNonceOnBind(prev, binding) {
  if (!prev || prev.kind !== 'new' || prev.sessionId) return false;
  if (!binding || (!binding.sessionId && !binding.viewRunId)) return false;
  if (binding.viewRunId && binding.viewRunId === prev.viewRunId) return false;
  return true;
}

// Read-only rule as a pure function: a readonly composer has no writable
// draft slot — saves/deletes are prohibited and nothing private is shown.
export function writableDraftKey(view, isReadOnly) {
  if (isReadOnly === true) return null;
  return draftKeyFor(view);
}

export function legacyBackupKey(binding) {
  if (binding.sessionId) return `session:${binding.sessionId}`;
  if (binding.projectCwd) return `project:${normalizeCwd(binding.projectCwd)}`;
  return null;
}

let nonceCounter = 0;
const freshNonce = () => {
  nonceCounter += 1;
  const random = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `v${Date.now().toString(36)}${nonceCounter.toString(36)}${random}`;
};

export function validateSidecar(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.version !== SIDECAR_VERSION) return null;
  if (!Array.isArray(input.entries) || input.entries.length > REGISTRY_HARD_CAP) return null;
  const entries = [];
  const seenIds = new Set();
  const seenNonces = new Set();
  const seenSessions = new Set();
  for (const raw of input.entries) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !CONV_ID_PATTERN.test(raw.id)) return null;
    if (seenIds.has(raw.id)) return null;
    seenIds.add(raw.id);
    // Duplicate nonces would share one unsent `conv:` slot; duplicate
    // sessionIds would run two writers on one `session:` slot. Both break
    // draft single-writer guarantees, so the whole sidecar is rejected and
    // the app falls back to a clean primary view.
    if (seenNonces.has(raw.nonce)) return null;
    seenNonces.add(raw.nonce);
    if (typeof raw.sessionId === 'string' && raw.sessionId) {
      if (seenSessions.has(raw.sessionId)) return null;
      seenSessions.add(raw.sessionId);
    }
    if (raw.kind !== 'session' && raw.kind !== 'new' && raw.kind !== 'run') return null;
    // kind/ref consistency: session views name a session, run views name a run,
    // new chats name neither. Nonces are required: they restore unsent per-creation slots.
    if (raw.kind === 'session' && (typeof raw.sessionId !== 'string' || !raw.sessionId)) return null;
    if (raw.kind === 'run' && (typeof raw.viewRunId !== 'string' || !raw.viewRunId)) return null;
    if (raw.kind === 'new' && (raw.sessionId || raw.viewRunId)) return null;
    if (typeof raw.nonce !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.nonce)) return null;
    for (const field of ['sessionId', 'projectCwd', 'execCwd', 'viewRunId']) {
      if (raw[field] !== null && raw[field] !== undefined && typeof raw[field] !== 'string') return null;
      if (typeof raw[field] === 'string' && raw[field].length > 500) return null;
    }
    let gen = null;
    if (raw.gen !== null && raw.gen !== undefined) {
      if (typeof raw.gen !== 'object' || Array.isArray(raw.gen)) return null;
      const { model, thinking, allowQuestions, sharedMemories } = raw.gen;
      if ((model !== undefined && typeof model !== 'string') || String(model || '').length > 200) return null;
      if ((thinking !== undefined && typeof thinking !== 'string') || String(thinking || '').length > 200)
        return null;
      if (allowQuestions !== undefined && typeof allowQuestions !== 'boolean') return null;
      if (sharedMemories !== undefined && typeof sharedMemories !== 'boolean') return null;
      gen = {
        model: typeof model === 'string' ? model : '',
        thinking: typeof thinking === 'string' ? thinking : '',
        allowQuestions: allowQuestions !== false,
        sharedMemories: sharedMemories === true,
      };
    }
    entries.push({
      id: raw.id,
      kind: raw.kind,
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      projectCwd: typeof raw.projectCwd === 'string' ? raw.projectCwd : null,
      execCwd: typeof raw.execCwd === 'string' ? raw.execCwd : null,
      viewRunId: typeof raw.viewRunId === 'string' ? raw.viewRunId : null,
      nonce: raw.nonce,
      gen,
    });
  }
  if (!entries.some((entry) => entry.id === PRIMARY_VIEW_ID)) return null;
  const activeId =
    typeof input.activeId === 'string' && entries.some((entry) => entry.id === input.activeId)
      ? input.activeId
      : PRIMARY_VIEW_ID;
  return { activeId, entries };
}

export function createConversationViews(deps) {
  const {
    read,
    write,
    getDocking,
    renderer: rendererDeps,
    getRun,
    isRunActive,
    getSessionTitle,
    getHostText,
    setHostText,
    afterTextRestore,
    getControls,
    hostRender,
    historyRenderOptions,
    renderNavigation,
    saveSelection,
    peekImages,
    onToast,
    afterFocus,
    clearHostNodes,
    isReadOnly,
    getHostScrollState,
    restoreHostScrollState,
    paintViewChrome,
    markSessionRead,
    welcomeProjectText,
  } = deps;
  const readonly = () => {
    try {
      return isReadOnly?.() === true;
    } catch {
      return false;
    }
  };

  const host = document.querySelector('.conversation-column');
  if (!host) throw new Error('conversation views: missing .conversation-column host');
  const hostScroller = () => document.getElementById('conversation-scroll');

  const hostHome = document.createComment('cvw-host-home');
  host.before(hostHome);
  try {
    host.dataset.view = PRIMARY_VIEW_ID;
  } catch {}
  const park = document.createElement('div');
  park.id = 'cvw-park';
  park.hidden = true;
  park.setAttribute('aria-hidden', 'true');
  document.body.append(park);

  const views = new Map();
  let focusedId = PRIMARY_VIEW_ID;
  let composerLive = false;
  let dockedActive = false;
  let visibleIds = [];
  let nonceSeed = 1;

  function storageKey() {
    return 'docking.conversations';
  }

  function draftsObject() {
    const stored = read('drafts', {});
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  }

  function buildShell(view) {
    const root = document.createElement('section');
    root.className = 'cvw-shell';
    root.dataset.view = view.id;
    root.setAttribute('aria-label', titleOf(view.id) || view.id);
    const slot = document.createElement('div');
    slot.className = 'cvw-host-slot';
    const bg = document.createElement('div');
    bg.className = 'cvw-bg';
    bg.hidden = true;
    const scroller = document.createElement('div');
    scroller.className = 'cvw-scroller conversation-scroll';
    scroller.tabIndex = -1;
    const welcome = view.id === PRIMARY_VIEW_ID ? null : document.getElementById('welcome').cloneNode(true);
    if (welcome) {
      welcome.removeAttribute('id');
      for (const node of welcome.querySelectorAll('[id]')) node.removeAttribute('id');
      welcome.hidden = true;
      scroller.append(welcome);
    }
    const messages = document.createElement('div');
    messages.className = 'cvw-messages messages';
    messages.setAttribute('aria-live', 'polite');
    messages.setAttribute('aria-relevant', 'additions');
    const questions = document.createElement('div');
    questions.className = 'cvw-questions questions';
    scroller.append(messages, questions);
    const runline = document.createElement('div');
    runline.className = 'cvw-runline';
    runline.hidden = true;
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'cvw-pill scroll-bottom';
    pill.hidden = true;
    // Same pill as the host column: icon and label, centered above this pane's
    // composer by a zero-height anchor at the scroller's bottom edge.
    const pillLabel = document.createElement('span');
    bindText(pillLabel, () => tr('ui.derniers_messages'));
    bindAttribute(pill, 'aria-label', () => tr('ui.aller_au_dernier_message'));
    pill.append(rendererDeps.icon('arrow-down'), pillLabel);
    const pillAnchor = document.createElement('div');
    pillAnchor.className = 'cvw-pill-anchor';
    pillAnchor.append(pill);
    pill.onclick = () => {
      view.follow = true;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
      pill.hidden = true;
    };
    scroller.onscroll = () => {
      const top = scroller.scrollTop;
      const atBottom = scroller.scrollHeight - top - scroller.clientHeight < 3;
      const movedUp = top < view.scrollTop - 2;
      view.scrollTop = top;
      if (atBottom) view.follow = true;
      else if (movedUp) view.follow = false;
      pill.hidden = atBottom;
      if (atBottom && view.sessionId) {
        try {
          markSessionRead?.(view);
        } catch {}
      }
    };
    bg.append(scroller, pillAnchor, runline);
    root.append(slot, bg);
    park.append(root);
    view.shell = { root, slot, bg, scroller, welcome, messages, questions, runline, pill };
    view.renderer = createConversationRenderer({
      ...rendererDeps,
      markdown: (text, opts) =>
        rendererDeps.markdown(text, { cwd: view.execCwd || view.projectCwd || undefined, ...opts }),
      renderMessage: (message, index) =>
        rendererDeps.renderMessage(message, index, view.nodes, view.execCwd || view.projectCwd || undefined),
      // Tool file references must resolve under the owning view's project,
      // never under whichever project is focused. The wrapper closes over the
      // live view object, so rebinding a panel automatically rescopes it.
      renderTool: (tool, messageId) =>
        rendererDeps.renderTool(tool, messageId, view.execCwd || view.projectCwd || undefined),
      renderInteractions: (message) => {
        try {
          return view.units?.questions?.partsFor(message) || [];
        } catch {
          return [];
        }
      },
    });
    if (view.id === PRIMARY_VIEW_ID) {
      view.composerNodes = null;
    }
    // NOTE: composer subtrees mount only via mountComposer() (enable/runtime
    // creation) — never here, so sidecar restore() stays free of DOM moves and
    // never arms the live flag prematurely.
    try {
      bindShellActivation(view);
    } catch {}
    refreshShellText(view);
    return root;
  }

  // Live pane chrome: transient run/loading status + pending-question affordance.
  // Titles, badges and draft previews are gone (dock tab owns them); the pane
  // is transcript + live composer with no proxy header and no gap.
  function refreshShellText(view) {
    const shell = view.shell;
    if (!shell) return;
    shell.root.setAttribute('aria-label', titleOf(view.id) || view.id);
    const projectLabel = shell.welcome?.querySelector('.welcome-project')?.lastElementChild;
    if (projectLabel) bindText(projectLabel, () => welcomeProjectText(view.projectCwd));
    const run = view.viewRunId ? getRun(view.viewRunId) : null;
    const live = run && (isRunActive(run) || run.status === 'stopping');
    if (view.loading) {
      shell.runline.hidden = false;
      shell.runline.textContent = tr('conversation_view.loading_session');
    } else if (view.unavailable) {
      shell.runline.hidden = false;
      shell.runline.textContent = tr('conversation_view.unavailable');
    } else if (live && !view.composerNodes) {
      shell.runline.hidden = false;
      shell.runline.textContent = tr('conversation_view.agent_working');
    } else shell.runline.hidden = true;
  }

  function readDraftKey(key) {
    if (!key) return '';
    const text = draftsObject()[key];
    return typeof text === 'string' ? text : '';
  }

  function titleOf(id) {
    const view = views.get(id);
    if (!view) return null;
    if (view.sessionId) {
      const name = getSessionTitle(view.sessionId);
      if (name) return name;
    }
    if (view.kind === 'new') {
      const project = view.projectCwd ? view.projectCwd.split(/[\/]/).filter(Boolean).pop() : '';
      return project
        ? tr('conversation_view.new_in_project', { project })
        : tr('conversation_view.new_conversation');
    }
    return tr('conversation_view.conversation');
  }

  function viewMessages(view) {
    const run = view.viewRunId ? getRun(view.viewRunId) : null;
    if (run && (isRunActive(run) || (run.messages && run.messages.some((m) => m.streaming)))) {
      const base = Array.isArray(run.base) ? run.base : [];
      const live = Array.isArray(run.messages) ? run.messages : [];
      return [...base, ...live];
    }
    return Array.isArray(view.history) ? view.history : [];
  }

  function renderBg(view, force = false) {
    if (!view.shell || !view.shell.messages.isConnected) return;
    if (dockedActive && (view.id === PRIMARY_VIEW_ID || !visibleIds.includes(view.id))) return;
    if (force) view.follow = true;
    // Visible-pane chrome sync (model options, control triples, unit updates).
    // Classic-parked shells never reach here with paintable visibility.
    if (dockedActive && view.shell.bg && view.shell.bg.hidden === false) {
      try {
        paintViewChrome?.(view);
      } catch {}
    }
    const messages = viewMessages(view);
    if (view.shell.welcome)
      view.shell.welcome.hidden = !!(messages.length || view.loading || view.unavailable);
    const windowInfo = view.renderer.render(view.shell.messages, messages, historyRenderOptions?.(view));
    if (windowInfo?.anchorPreserved) view.scrollTop = windowInfo.scrollTop;
    if (!messages.length && !view.loading) view.shell.scroller.scrollTop = 0;
    else if (view.follow && !windowInfo?.anchorPreserved)
      view.shell.scroller.scrollTop = view.shell.scroller.scrollHeight;
    else view.shell.scroller.scrollTop = view.scrollTop;
    view.shell.pill.hidden = view.follow || !messages.length;
    refreshShellText(view);
  }

  function scheduleBg(view) {
    if (view.scheduled || !dockedActive || !visibleIds.includes(view.id)) return;
    view.scheduled = true;
    requestAnimationFrame(() => {
      view.scheduled = false;
      renderBg(view);
    });
  }

  function persist() {
    const entries = [...views.values()].map((view) => ({
      id: view.id,
      kind: view.kind,
      sessionId: view.sessionId,
      projectCwd: view.projectCwd,
      execCwd: view.execCwd,
      viewRunId: view.viewRunId,
      nonce: view.nonce,
      gen: view.gen,
    }));
    write(storageKey(), { version: SIDECAR_VERSION, activeId: focusedId, entries });
  }

  function collectMounted(doc) {
    const ids = [];
    const stack = [doc?.root];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (node.kind === 'group' && Array.isArray(node.panels)) ids.push(...node.panels);
      if (node.first) stack.push(node.first);
      if (node.second) stack.push(node.second);
    }
    return ids;
  }

  function makeView(binding, id) {
    const view = {
      id,
      kind: binding.kind,
      sessionId: binding.sessionId || null,
      projectCwd: binding.projectCwd || null,
      execCwd: binding.execCwd || binding.projectCwd || null,
      viewRunId: binding.viewRunId || null,
      nonce: binding.nonce || freshNonce(),
      history: [],
      loading: false,
      token: 0,
      gen: binding.gen || null,
      follow: true,
      scrollTop: 0,
      unavailable: false,
      dirty: false,
      nodes: new Map(),
      scheduled: false,
      shell: null,
      renderer: null,
    };
    views.set(id, view);
    buildShell(view);
    return view;
  }

  function restore() {
    let saved = null;
    try {
      saved = validateSidecar(read(storageKey(), null));
    } catch {
      saved = null;
    }
    if (!saved) {
      const primary = makeView({ kind: 'new', nonce: freshNonce() }, PRIMARY_VIEW_ID);
      focusedId = PRIMARY_VIEW_ID;
      return { primary };
    }
    for (const entry of saved.entries.slice(0, REGISTRY_HARD_CAP)) {
      if (views.has(entry.id)) continue;
      makeView(entry, entry.id);
    }
    if (!views.has(PRIMARY_VIEW_ID)) makeView({ kind: 'new', nonce: freshNonce() }, PRIMARY_VIEW_ID);
    focusedId = views.has(saved.activeId) ? saved.activeId : PRIMARY_VIEW_ID;
    return { primary: views.get(PRIMARY_VIEW_ID) };
  }

  function focused() {
    return views.get(focusedId) || views.get(PRIMARY_VIEW_ID);
  }

  function isFocused(id) {
    return id === focusedId;
  }

  // Pane composers are live only while docked. Classic and mobile show the
  // single host editor, even for a view that kept its pane units.
  function liveUnits(view) {
    if (!view?.units) return null;
    return view.id === PRIMARY_VIEW_ID || dockedActive ? view.units : null;
  }

  function readFocusedText() {
    try {
      const units = liveUnits(focused());
      if (units?.text) return units.text.get();
    } catch {}
    try {
      return getHostText?.() || '';
    } catch {
      return '';
    }
  }
  function writeFocusedText(text, opts) {
    try {
      const units = liveUnits(focused());
      if (units?.text) {
        units.text.set(text, opts);
        return;
      }
    } catch {}
    try {
      setHostText?.(text, opts);
    } catch {}
  }
  function saveFocusedDraft() {
    // Read-only mode must never create, overwrite, or delete draft rows —
    // focus/bind/mode transitions all funnel through here.
    const view = focused();
    if (!view) return;
    const key = writableDraftKey(view, readonly());
    if (!key) return;
    const text = readFocusedText();
    const drafts = draftsObject();
    if (text) drafts[key] = text;
    else delete drafts[key];
    write('drafts', drafts);
  }

  function restoreDraftFor(view) {
    if (!view) return;
    const pane = view.id === focusedId ? liveUnits(view) : view.units;
    if (!pane && view.id !== focusedId) return;
    // Read-only shows an empty composer, never another view's stored text.
    const text = readonly() ? '' : readDraftKey(draftKeyFor(view));
    const current = pane ? pane.text.get() : readFocusedText();
    if (current !== text) {
      if (pane) pane.text.set(text, { retainCommand: false });
      else writeFocusedText(text, { retainCommand: false });
    }
    afterTextRestore(view);
  }
  function restoreFocusedDraft() {
    restoreDraftFor(focused());
  }

  function acceptFocusedDraft(key, text) {
    const view = focused();
    if (view) acceptDraftFor(view, key, text);
  }
  // Origin-keyed accept: clears exactly the captured binding key when its stored
  // text still matches the submitted text. A rebinding (same pane showing another
  // conversation, or a focus switch) uses a different key, so even identical text
  // in the new binding is never cleared. The host textarea is cleared only when
  // the origin is still focused under that same key.
  function acceptDraftFor(view, key, text) {
    if (!view || !key) return;
    const drafts = draftsObject();
    if (drafts[key] === text) {
      delete drafts[key];
      write('drafts', drafts);
    }
    const current = focused();
    if (current && current.id === view.id && draftKeyFor(current) === key && readFocusedText() === text) {
      writeFocusedText('');
      saveFocusedDraft();
    }
  }

  function captureHostScroll(view) {
    // Per-view scroll capture. The primary reads the host column; panes read
    // their own scroller. Hidden scrollers report a reset scrollTop, so saved
    // positions are only overwritten while the scroller still has layout.
    if (!view) return;
    let snap = null;
    try {
      snap = getHostScrollState?.();
    } catch {
      snap = null;
    }
    if (!view.shell || view.id === PRIMARY_VIEW_ID) {
      if (snap) {
        const scroller = hostScroller();
        if (scroller && scroller.getClientRects().length) {
          view.follow = snap.follow !== false;
          view.scrollTop = snap.top || 0;
        } else if (scroller) {
          view.follow = snap.follow !== false;
        }
      }
      return;
    }
    // Panes own their scroller: top from layout-guarded read, follow maintained
    // live by the pane scroll handler.
    try {
      const scroller = view.shell.scroller;
      if (scroller && scroller.getClientRects().length) view.scrollTop = scroller.scrollTop;
    } catch {}
  }

  function captureFocusedScroll() {
    const view = focused();
    if (view) captureHostScroll(view);
  }

  // Enable point: mount a live composer subtree into a dynamic shell.
  // Primary keeps the host column (IDs intact). Idempotent per view.
  function mountComposer(id) {
    const view = views.get(id);
    if (!view || view.id === PRIMARY_VIEW_ID || view.composerNodes) return view?.composerNodes || null;
    try {
      const nodes = buildComposerNodes(view);
      view.shell.bg.append(nodes.area);
      composerLive = true;
      return nodes;
    } catch {
      return null;
    }
  }
  // Host column activation (primary view): pointerdown focuses first without
  // consuming, focusin covers keyboard entry. Same contract as shell binding.
  // Guarded: the host must never steal focus it does not own. Undocked, the
  // host can represent a retained focused secondary view; an already-primary
  // focus needs no mirror (whose global write would silently clear
  // projectOverview while the overview DOM stays visible, breaking overview
  // rendering); and #project-overview is a global navigation surface, never
  // conversation activation. A real background primary transcript still
  // activates, deferred past gesture end like shells.
  function hostActivationAllowed(event) {
    if (!dockedActive) return false;
    if (focusedId === PRIMARY_VIEW_ID) return false;
    try {
      if (event?.target?.closest?.('#project-overview')) return false;
    } catch {}
    return true;
  }
  function bindHost() {
    if (host.dataset.cvwActive === 'true') return;
    host.dataset.cvwActive = 'true';
    host.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        if (!hostActivationAllowed(event)) return;
        focusView(PRIMARY_VIEW_ID, { reveal: false, deferRender: true });
      },
      true,
    );
    host.addEventListener('focusin', (event) => {
      if (!hostActivationAllowed(event)) return;
      focusView(PRIMARY_VIEW_ID, { reveal: false });
    });
  }
  function renderViewNow(id, force = false) {
    const view = views.get(id);
    if (!view || !view.shell || (dockedActive && !visibleIds.includes(id))) return;
    renderBg(view, force);
    const scroller = view.shell.scroller;
    if (!scroller) return;
    if (force) view.follow = true;
    if (view.follow) scroller.scrollTop = scroller.scrollHeight;
    else scroller.scrollTop = view.scrollTop || 0;
    if (view.shell.pill) view.shell.pill.hidden = view.follow || !viewMessages(view).length;
  }

  // ------------------------------------------------------------------
  // M2 per-pane live composers (STAGED — not invoked yet).
  //
  // buildComposerNodes(view) mirrors the host composer-area subtree with the
  // same classes (shared class rules apply as-is) plus data-cvw roles and no
  // IDs. Controller instances (composer scope, images, live queue, commands,
  // questions) are created app-side at wiring time against these refs; the
  // shell activation helper focuses the view WITHOUT consuming the event, so
  // the original control action (click, key, selection) always proceeds.
  // ------------------------------------------------------------------
  function cvNode(tag, className, role) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (role) node.setAttribute('data-cvw', role);
    return node;
  }

  function buildComposerNodes(view) {
    if (view.composerNodes) return view.composerNodes;
    const refs = {};
    const area = cvNode('div', 'composer-area cvw-composer-area', 'composer-area');
    const runStatus = cvNode('div', 'run-status', 'run-status');
    runStatus.setAttribute('role', 'status');
    runStatus.hidden = true;
    const spinner = cvNode('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    const runLabel = cvNode('span', '', 'run-label');
    bindText(runLabel, () => tr('ui.l_agent_travaille'));
    const runElapsed = cvNode('span', '', 'run-elapsed');
    runStatus.append(spinner, runLabel, runElapsed);
    refs.runStatus = runStatus;
    refs.runLabel = runLabel;
    refs.runElapsed = runElapsed;
    const form = cvNode('form', 'composer-form cv-composer-form', 'composer-form');
    const inputLabel = cvNode('label', 'sr-only', 'composer-label');
    inputLabel.textContent = tr('ui.votre_message_a_prime_agent');
    const textarea = cvNode('textarea', '', 'composer');
    textarea.rows = 2;
    textarea.spellcheck = true;
    bindAttribute(textarea, 'placeholder', () => tr('ui.que_souhaitez_vous_construire'));
    bindAttribute(textarea, 'aria-label', () => tr('ui.votre_message_a_prime_agent'));
    // Match the classic form: the images controller owns the input row and
    // attachment controls. Pre-wrapping here nests flex rows and squeezes the
    // textarea to zero width when that controller assembles the live pane.
    const toolbar = cvNode('div', 'composer-toolbar', 'toolbar');
    const modelControls = cvNode('div', 'model-controls', 'model-controls');
    const modelIcon = cvNode('span', 'model-icon', 'model-icon');
    try {
      modelIcon.append(rendererDeps.icon('model'));
    } catch {}
    modelIcon.setAttribute('aria-hidden', 'true');
    const modelBtn = cvNode('button', 'model-picker-button', 'model');
    modelBtn.type = 'button';
    modelBtn.setAttribute('aria-haspopup', 'dialog');
    modelBtn.setAttribute('aria-controls', 'model-dialog');
    modelBtn.setAttribute('aria-expanded', 'false');
    const modelSelection = cvNode('span', 'model-picker-selection');
    const modelName = cvNode('span', 'model-picker-name', 'model-name');
    bindText(modelName, () => tr('ui.modele_par_defaut'));
    const modelProvider = cvNode('span', 'model-picker-provider', 'model-provider');
    bindText(modelProvider, () => tr('ui.configuration_prime_agent'));
    modelSelection.append(modelName, modelProvider);
    const modelChevron = cvNode('span', 'model-picker-chevron');
    try {
      modelChevron.append(rendererDeps.icon('chevron'));
    } catch {}
    modelChevron.setAttribute('aria-hidden', 'true');
    modelBtn.append(modelSelection, modelChevron);
    bindAttribute(modelBtn, 'aria-label', () => modelName.textContent || tr('ui.modele_par_defaut'));
    const modelSelect = cvNode('select', '', 'model-select');
    modelSelect.hidden = true;
    modelSelect.tabIndex = -1;
    modelSelect.setAttribute('aria-hidden', 'true');
    const modelDefault = document.createElement('option');
    modelDefault.value = '';
    bindText(modelDefault, () => tr('ui.modele_par_defaut'));
    modelSelect.append(modelDefault);
    const separator = cvNode('span', 'control-separator');
    separator.setAttribute('aria-hidden', 'true');
    const thinkingLabel = cvNode('label', 'sr-only');
    bindText(thinkingLabel, () => tr('ui.effort_de_raisonnement'));
    const thinking = cvNode('select', '', 'thinking');
    bindAttribute(thinking, 'aria-label', () => tr('ui.effort_de_raisonnement'));
    for (const [value, key] of [
      ['', 'ui.effort_par_defaut'],
      ['off', 'ui.sans_raisonnement'],
      ['minimal', 'ui.minimal'],
      ['low', 'ui.leger'],
      ['medium', 'ui.moyen'],
      ['high', 'ui.eleve'],
      ['xhigh', 'ui.tres_eleve'],
      ['max', 'ui.maximum'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      bindText(option, () => tr(key));
      thinking.append(option);
    }
    const allowQ = cvNode('label', 'questions-toggle', 'allow-questions-wrap');
    allowQ.title = tr('questions.scope');
    const allowQInput = cvNode('input', '', 'allow-questions');
    allowQInput.type = 'checkbox';
    allowQInput.checked = true;
    bindAttribute(allowQInput, 'aria-label', () => tr('questions.allow'));
    const allowQFull = cvNode('span', 'toggle-full');
    bindText(allowQFull, () => tr('questions.toggle'));
    const allowQShort = cvNode('span', 'toggle-short');
    bindText(allowQShort, () => tr('questions.toggleShort'));
    allowQ.append(allowQInput, allowQFull, allowQShort);
    const allowSM = cvNode('label', 'questions-toggle', 'allow-shared-wrap');
    bindAttribute(allowSM, 'title', () => tr('sharedMemories.scope'));
    const allowSMInput = cvNode('input', '', 'allow-shared-memories');
    allowSMInput.type = 'checkbox';
    allowSMInput.checked = false;
    bindAttribute(allowSMInput, 'aria-label', () => tr('sharedMemories.toggle'));
    const allowSMFull = cvNode('span', 'toggle-full');
    bindText(allowSMFull, () => tr('sharedMemories.toggle'));
    const allowSMShort = cvNode('span', 'toggle-short');
    bindText(allowSMShort, () => tr('sharedMemories.toggleShort'));
    allowSM.append(allowSMInput, allowSMFull, allowSMShort);
    const allowCU = cvNode('label', 'questions-toggle', 'allow-computer-wrap');
    allowCU.title = tr('questions.scope');
    const allowCUInput = cvNode('input', '', 'allow-computer-use');
    allowCUInput.type = 'checkbox';
    bindAttribute(allowCUInput, 'aria-label', () => tr('computer.allow'));
    const allowCUFull = cvNode('span', 'toggle-full');
    bindText(allowCUFull, () => tr('computer.allow'));
    const allowCUShort = cvNode('span', 'toggle-short');
    bindText(allowCUShort, () => tr('computer.label'));
    allowCU.append(allowCUInput, allowCUFull, allowCUShort);
    // One horizontal permissions row on narrow panes: display:contents on
    // wide rows keeps the three labels participating in .model-controls
    // directly (desktop layout unchanged); narrow CSS turns this wrapper
    // into a full-width flex row independent of model/thinking controls.
    const permissions = cvNode('span', 'composer-permissions', 'permissions');
    permissions.append(allowQ, allowSM, allowCU);
    modelControls.append(
      modelIcon,
      modelBtn,
      modelSelect,
      separator,
      thinkingLabel,
      thinking,
      permissions,
    );
    const stop = cvNode('button', 'stop-button', 'stop');
    stop.type = 'button';
    bindAttribute(stop, 'title', () => tr('ui.arreter_l_agent'));
    bindAttribute(stop, 'aria-label', () => tr('ui.arreter_l_agent'));
    stop.hidden = true;
    try {
      stop.append(rendererDeps.icon('stop'));
    } catch {}
    const send = cvNode('button', 'send-button', 'send');
    send.type = 'submit';
    bindAttribute(send, 'title', () => tr('ui.envoyer_le_message'));
    bindAttribute(send, 'aria-label', () => tr('ui.envoyer_le_message'));
    send.disabled = true;
    try {
      send.append(rendererDeps.icon('arrow-up'));
    } catch {}
    toolbar.append(modelControls, stop, send);
    form.append(inputLabel, textarea, toolbar);
    const footnote = cvNode('div', 'composer-footnote', 'footnote');
    const contextGauge = cvNode('button', 'composer-context-gauge', 'context-gauge');
    contextGauge.type = 'button';
    contextGauge.hidden = true;
    const hint = cvNode('span', '', 'send-hint');
    bindText(hint, () => tr('ui.entree_pour_envoyer_maj_entree_pour_un_saut_de_ligne'));
    footnote.append(contextGauge, hint);
    area.append(runStatus, form, footnote);
    Object.assign(refs, {
      area,
      form,
      textarea,
      toolbar,
      modelBtn,
      modelName,
      modelProvider,
      modelSelect,
      thinking,
      allowQ: allowQInput,
      allowSM: allowSMInput,
      allowCU: allowCUInput,
      send,
      stop,
      footnote,
      contextGauge,
    });
    view.composerNodes = refs;
    return refs;
  }

  // First-click gesture safety: a synchronous transcript re-render between
  // pointerdown and click disturbs the gesture and the browser drops the
  // trusted click (focus lands, the link/image never opens). Pointerdown
  // activation therefore switches all focus STATE synchronously but defers
  // the transcript paint until the gesture ends. No event is prevented,
  // stopped, replayed or synthesized: the original click always runs first
  // on intact DOM with already-correct focus, then the paint flushes on the
  // next task (never a microtask: microtasks can run mid-dispatch, before
  // target/bubble listeners). Drags, cancels and blurs flush the same way,
  // so a queued paint never strands; explicit/programmatic focus stays sync.
  let deferredRender = false;
  let flushArmed = false;
  let flushTimer = 0;
  function clearFlushTimer() {
    if (!flushTimer) return;
    try {
      clearTimeout(flushTimer);
    } catch {}
    flushTimer = 0;
  }
  function disarmRenderFlush() {
    if (!flushArmed) return;
    flushArmed = false;
    try {
      document.removeEventListener('click', laterFlushRender, true);
      window.removeEventListener('pointerup', pointerUpFallback, true);
      window.removeEventListener('pointercancel', laterFlushRender);
      window.removeEventListener('blur', laterFlushRender);
      window.removeEventListener('dragend', laterFlushRender);
    } catch {}
  }
  function pointerUpFallback(event) {
    // End of gesture even when no click/dragend/blur follows (pointer
    // released outside the window, aborted drag). Queued on the next task so
    // it can never run inside click dispatch; a real click collapses it via
    // its own capture listener before the task runs. Non-primary buttons
    // (right/middle) never armed the queue, so they never flush it.
    if (event && event.pointerType === 'mouse' && event.button !== 0) return;
    laterFlushRender();
  }
  function flushDeferredRender() {
    clearFlushTimer();
    disarmRenderFlush();
    if (!deferredRender) return;
    deferredRender = false;
    try {
      hostRender(false);
    } catch {}
  }
  function laterFlushRender() {
    // Gesture-end (click dispatched, drag ended, pointer cancelled or focus
    // lost): paint on the next task, after the full trusted click and its
    // default action finish. Re-queued collapses stacked gesture ends.
    clearFlushTimer();
    try {
      flushTimer = setTimeout(() => {
        flushTimer = 0;
        flushDeferredRender();
      }, 0);
    } catch {}
  }
  function armRenderFlush() {
    disarmRenderFlush();
    flushArmed = true;
    try {
      document.addEventListener('click', laterFlushRender, true);
      window.addEventListener('pointerup', pointerUpFallback, true);
      window.addEventListener('pointercancel', laterFlushRender);
      window.addEventListener('blur', laterFlushRender);
      window.addEventListener('dragend', laterFlushRender);
    } catch {}
  }

  // Shell click/focus-in activation for the wiring phase (STAGED — not bound
  // yet). Focuses the view synchronously and NEVER prevents, stops, or
  // re-dispatches the event: the original control action always proceeds on
  // the now-focused view. Text selection drags and right-clicks pass through
  // untouched (primary button + focus only).
  function bindShellActivation(view) {
    const shell = view.shell?.root;
    if (!shell || shell.dataset.cvwActive === 'true') return;
    shell.dataset.cvwActive = 'true';
    shell.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        focusView(view.id, { reveal: false, deferRender: true });
      },
      true,
    );
    shell.addEventListener('focusin', () => {
      focusView(view.id, { reveal: false });
    });
  }

  // Single focus marker source: exactly one shell carries data-focused.
  // Dock tab styling stays parent-side via isFocusedPanel + refreshTitles.
  function markFocusedShell() {
    for (const view of views.values()) {
      if (view.shell) view.shell.root.dataset.focused = String(view.id === focusedId);
    }
  }

  function refreshView(id) {
    const view = views.get(id);
    if (!view) return;
    scheduleBg(view);
    refreshShellText(view);
  }

  function focusView(id, opts = {}) {
    const view = views.get(id);
    if (!view) return false;
    if (id === focusedId) {
      // Same-id activation is NOT a no-op for globals: re-affirm the mirror
      // (covers boot, where no focus ever ran) and persist the selection.
      // Explicit activation also invalidates old navigation via requestId.
      mirrorFocused(view);
      saveSelection();
      if (opts.reveal) ensureFocusedVisible();
      return true;
    }
    const prev = focused();
    if (prev) {
      saveFocusedDraft();
      captureHostScroll(prev);
      if (prev.kind === 'new') {
        // Scrape the PREVIOUS view's own controls (host shows primary now).
        const prevNodes = liveUnits(prev)?.nodes;
        const controls = prevNodes
          ? {
              model: prev.gen?.model || '',
              thinking: prevNodes.thinking ? prevNodes.thinking.value : '',
              allowQuestions: prevNodes.allowQ ? !!prevNodes.allowQ.checked : true,
              sharedMemories: prevNodes.allowSM ? prevNodes.allowSM.checked === true : false,
            }
          : getControls();
        prev.gen = {
          model: controls.model || '',
          thinking: controls.thinking || '',
          allowQuestions: controls.allowQuestions !== false,
          sharedMemories: controls.sharedMemories === true,
        };
      }
    }
    // A queued gesture paint never strands: an armed flush still owns it and
    // paints the current focus at gesture end, but an orphaned one (sync
    // render already covered it elsewhere) flushes here while no gesture can
    // be in flight to disturb.
    if (deferredRender && !flushArmed) flushDeferredRender();
    // Guard first: programmatic openPanel re-enters via onActivatePanel.
    focusedId = id;
    // Mount before measuring: the shell must have layout for restore to stick.
    if (opts.reveal) ensureFocusedVisible();
    if (
      dockedActive &&
      prev?.shell &&
      prev.id !== PRIMARY_VIEW_ID &&
      prev.id !== id &&
      visibleIds.includes(prev.id)
    ) {
      prev.shell.bg.hidden = false;
      renderBg(prev);
    }
    mirrorFocused(view);
    restoreFocusedDraft();
    // No cache clears on a pure focus switch: message nodes memoize by
    // content signature and revalidate themselves, so the same transcript
    // reconciles to the same DOM. Clearing here would force a gratuitous
    // rebuild that (besides wasted work) detaches nodes under an in-flight
    // gesture — collapsing a text selection the user just formed. Rebinds
    // (bindFocused, new content) still clear explicitly.
    if (view.id === PRIMARY_VIEW_ID) {
      try {
        restoreHostScrollState?.({ top: view.scrollTop || 0, follow: view.follow !== false });
      } catch {}
    }
    // No force-bottom and no DOM moves: detached positions survive in their
    // own scroller; follow mode reattaches by itself. Transcript routing is
    // owned by the app render dispatcher (host shows primary, shells own).
    // Pointerdown-initiated activation defers this paint past gesture end so
    // the first click on a link/image both focuses and opens; every other
    // path renders synchronously exactly as before.
    if (opts.deferRender) {
      deferredRender = true;
      armRenderFlush();
    } else {
      deferredRender = false;
      disarmRenderFlush();
      clearFlushTimer();
      hostRender(false);
    }
    renderNavigation();
    saveSelection();
    persist();
    refreshTitles();
    markFocusedShell();
    try {
      afterFocus?.(view);
    } catch {}
    return true;
  }

  function mirrorFocused(view) {
    deps.mirrorToGlobal(view);
  }

  function bindFocused(binding, opts = {}) {
    const view = focused() || views.get(PRIMARY_VIEW_ID);
    saveFocusedDraft();
    captureHostScroll(view);
    // Sidebar/programmatic rebinds paint synchronously below, which covers
    // any queued gesture paint: drop the queue without painting twice.
    deferredRender = false;
    disarmRenderFlush();
    clearFlushTimer();
    // Capture pre-mutation identity: explicit new->session/run promotion
    // rotates below; in-place automatic promotion never reaches here.
    const rotateNonce = shouldRotateNonceOnBind(view, binding);
    view.kind = binding.kind;
    view.sessionId = binding.sessionId || null;
    view.projectCwd = binding.projectCwd ?? view.projectCwd;
    view.execCwd = binding.execCwd ?? binding.projectCwd ?? view.projectCwd;
    view.viewRunId = binding.viewRunId || null;
    if (binding.nonce) view.nonce = binding.nonce;
    if (binding.kind === 'new' && !binding.keepNonce) view.nonce = freshNonce();
    else if (rotateNonce) view.nonce = freshNonce();
    // Draft gen is single-binding: an explicit gen wins; binding onto a
    // session/run clears any stale new-chat pick (tripleForView additionally
    // ignores gen once session-bound). New-to-new rebinds keep picks, matching
    // the legacy per-project draft continuity.
    if (binding.gen) view.gen = binding.gen;
    else if (binding.sessionId || binding.viewRunId) view.gen = null;
    view.history = [];
    view.historyMeta = null;
    view.nodes.clear();
    view.loading = false;
    view.unavailable = false;
    view.dirty = false;
    view.follow = true;
    view.scrollTop = 0;
    view.token += 1;
    mirrorFocused(view);
    const inherit =
      opts.inheritLegacy !== false && binding.kind === 'new' && !readDraftKey(draftKeyFor(view));
    if (inherit) adoptLegacyBackup(view);
    restoreFocusedDraft();
    if (view.id === PRIMARY_VIEW_ID) {
      try {
        clearHostNodes?.();
      } catch {}
    } else {
      try {
        view.nodes.clear();
      } catch {}
    }
    hostRender(true);
    renderNavigation();
    saveSelection();
    persist();
    refreshTitles();
    markFocusedShell();
    try {
      afterFocus?.(view);
    } catch {}
    return view;
  }

  function adoptLegacyBackup(view) {
    // One-time adoption for session-less views (session rows already use the
    // canonical key). Moves surviving `project:<cwd>` text into the view's
    // canonical key, then deletes the legacy key so repeats are no-ops.
    // Readonly (including pre-bootstrap unknown access mode) adopts nothing.
    if (readonly()) return;
    if (!view || view.sessionId) return;
    const backup = legacyBackupKey(view);
    const target = draftKeyFor(view);
    if (!backup || !target || backup === target) return;
    const drafts = draftsObject();
    const text = drafts[backup];
    if (typeof text !== 'string' || !text) return;
    if (!readDraftKey(target)) drafts[target] = text;
    delete drafts[backup];
    write('drafts', drafts);
  }

  function mountedConversationCount() {
    try {
      const docking = getDocking();
      const doc = docking?.getLayout?.();
      if (doc) {
        return collectMounted(doc).filter((panel) => panel === PRIMARY_VIEW_ID || panel.startsWith('conv:'))
          .length;
      }
    } catch {}
    return 1;
  }
  // Frees the oldest CLOSED view (Map order = creation order) so a full
  // registry never blocks a new conversation. Never evicts the primary, the
  // focused view, a mounted tab, an active run, or a view whose slot still holds
  // an unsent draft or attachments. Session histories are server-side and
  // `session:<id>` drafts stay in storage, so reopening the session restores it.
  function evictOldestClosed() {
    const docking = getDocking();
    const doc = docking?.getLayout?.();
    if (!doc || !docking?.unregisterPanel) return false;
    const mounted = new Set(collectMounted(doc));
    for (const view of views.values()) {
      if (view.id === PRIMARY_VIEW_ID || view.id === focusedId || mounted.has(view.id)) continue;
      if (view.viewRunId && isRunActive?.(getRun?.(view.viewRunId))) continue;
      const key = draftKeyFor(view);
      if (readDraftKey(key)) continue;
      const images = peekImages?.(key);
      if (images && (images.count || images.pending || images.loading)) continue;
      try {
        docking.unregisterPanel(view.id);
      } catch {}
      views.delete(view.id);
      try {
        view.shell?.root?.remove();
      } catch {}
      persist();
      return true;
    }
    return false;
  }

  function createView(binding, opts = {}) {
    // Bound BEFORE any mutation: at the cap, free the oldest safe closed view;
    // refuse only when every closed view still holds work.
    if (views.size >= REGISTRY_HARD_CAP) evictOldestClosed();
    if (views.size >= REGISTRY_HARD_CAP) {
      onToast(tr('conversation_view.registry_full', { count: REGISTRY_HARD_CAP }), true);
      return null;
    }
    if (mountedConversationCount() >= MAX_CONVERSATIONS) {
      onToast(tr('conversation_view.limit_reached'), true);
      return null;
    }
    nonceSeed += 1;
    const id = `conv:v${nonceSeed}${Math.floor(Math.random() * 1296).toString(36)}`;
    if (!CONV_ID_PATTERN.test(id) || views.has(id)) return createViewFallback(binding, opts);
    const view = makeView({ ...binding, nonce: binding.nonce || freshNonce() }, id);
    try {
      getDocking()?.registerPanel?.(view.id, view.shell.root);
    } catch {}
    try {
      mountComposer(view.id);
    } catch {}
    persist();
    refreshTitles();
    return view;
  }

  function createViewFallback(binding, opts) {
    if (views.size >= REGISTRY_HARD_CAP) evictOldestClosed();
    if (views.size >= REGISTRY_HARD_CAP) {
      onToast(tr('conversation_view.registry_full', { count: REGISTRY_HARD_CAP }), true);
      return null;
    }
    for (let n = 1; n < 500; n += 1) {
      const id = `conv:w${n}`;
      if (views.has(id)) continue;
      const view = makeView({ ...binding, nonce: binding.nonce || freshNonce() }, id);
      try {
        getDocking()?.registerPanel?.(view.id, view.shell.root);
      } catch {}
      try {
        mountComposer(view.id);
      } catch {}
      persist();
      refreshTitles();
      return view;
    }
    return null;
  }

  function handleCreateConversation(opts = {}) {
    const current = focused();
    const binding = {
      kind: 'new',
      sessionId: null,
      projectCwd: current?.projectCwd || null,
      execCwd: current?.execCwd || current?.projectCwd || null,
      nonce: freshNonce(),
    };
    const view = createView(binding, { inheritLegacy: false });
    if (!view) return null;
    renderBg(view);
    return view.id;
  }

  function activateFromDock(id) {
    if (!views.has(id)) return false;
    return focusView(id, { reveal: false });
  }

  function ensureFocusedVisible() {
    // Mount/reveal the focused shell exactly once: programmatic openPanel
    // re-enters through onActivatePanel, so an already-active tab must skip
    // or focus ping-pongs forever.
    try {
      const docking = getDocking();
      if (!docking?.active) return;
      if (docking.visiblePanels?.().includes(focusedId)) return;
      docking.openPanel?.(focusedId);
    } catch {}
  }

  function notifyRunEvent(run, kind) {
    if (!run) return;
    // Streaming deltas re-render the bound background view only. Control
    // events (bind/done/questions) additionally refresh titles and badges.
    const quiet = kind === 'text' || kind === 'thinking';
    for (const view of views.values()) {
      if (view.id === focusedId) continue;
      if (view.viewRunId && view.viewRunId === run.id) scheduleBg(view);
      else if (
        !quiet &&
        view.kind === 'session' &&
        view.sessionId &&
        run.sessionId &&
        view.sessionId === run.sessionId &&
        !view.viewRunId
      ) {
        scheduleBg(view);
      }
    }
    if (!quiet) refreshTitles();
  }

  function markDirty(sessionId) {
    for (const view of views.values()) {
      if (view.id !== focusedId && view.sessionId === sessionId) view.dirty = true;
    }
  }

  function setDocked(active, visible) {
    markFocusedShell();
    const wasDocked = dockedActive;
    dockedActive = !!active;
    visibleIds = Array.isArray(visible) ? [...visible] : [];
    if (dockedActive) {
      // Fixed primary ownership: the live column lives in the primary slot
      // whenever docked, regardless of which view is focused. The primary bg
      // transcript stays hidden (the column shows it). No per-focus moves, no
      // hiding, no layout reset.
      const primary = views.get(PRIMARY_VIEW_ID);
      if (primary?.shell && host.parentNode !== primary.shell.slot) {
        try {
          primary.shell.slot.append(host);
        } catch {}
      }
      for (const view of views.values()) {
        if (!view.shell) continue;
        if (view.id === PRIMARY_VIEW_ID) {
          view.shell.bg.hidden = true;
          continue;
        }
        const shown = visibleIds.includes(view.id);
        view.shell.bg.hidden = !shown;
        if (shown) renderBg(view);
      }
    } else {
      if (host.parentNode !== hostHome.parentNode || host.previousSibling !== hostHome) {
        hostHome.after(host);
      }
      for (const view of views.values()) {
        if (view.shell && view.shell.root.parentNode !== park) park.append(view.shell.root);
      }
    }
    // The editor changes with the mode (pane vs host): show the saved draft
    // there, captured just before the switch by captureForModeChange.
    if (wasDocked !== dockedActive) {
      if (dockedActive) {
        for (const view of views.values()) if (view.units && view.id !== PRIMARY_VIEW_ID) restoreDraftFor(view);
      } else restoreDraftFor(focused());
    }
  }

  function captureForModeChange() {
    const view = focused();
    if (!view) return;
    saveFocusedDraft();
    captureHostScroll(view);
  }

  function hostVisible() {
    if (!dockedActive) return true;
    return visibleIds.includes(focusedId);
  }

  function refreshTitles() {
    try {
      getDocking()?.refreshTitles?.();
    } catch {}
    for (const view of views.values()) refreshShellText(view);
  }

  function shellEntries() {
    const entries = {};
    for (const view of views.values()) entries[view.id] = view.shell.root;
    return entries;
  }

  restore();

  return {
    ready: () => true,
    views,
    focusedId: () => focusedId,
    focused,
    isFocused,
    byId: (id) => views.get(id) || null,
    bySession: (sessionId) => {
      if (!sessionId) return null;
      for (const view of views.values()) if (view.sessionId === sessionId) return view;
      return null;
    },
    byRun: (runId) => {
      if (!runId) return null;
      for (const view of views.values()) if (view.viewRunId === runId) return view;
      return null;
    },
    count: () => views.size,
    titleOf,
    draftKeyFor,
    writableDraftKey,
    imageKeyOf,
    legacyBackupKey,
    focusedDraftKey: () => draftKeyFor(focused()),
    focusedImageKey: () => imageKeyOf(focused()),
    saveFocusedDraft,
    restoreDraftFor,
    restoreFocusedDraft,
    acceptFocusedDraft,
    acceptDraftFor,
    refreshView,
    adoptLegacyBackup,
    focusView,
    liveUnits,
    captureFocusedScroll,
    bindHost,
    renderViewNow,
    mountComposer,
    readFocusedText,
    writeFocusedText,
    composerLive: () => composerLive,
    setComposerLive: () => {
      composerLive = true;
    },
    hostNode: () => host,
    bindFocused,
    createView,
    handleCreateConversation,
    activateFromDock,
    ensureFocusedVisible,
    notifyRunEvent,
    markDirty,
    setDocked,
    captureForModeChange,
    hostVisible,
    refreshTitles,
    shellEntries,
    persist,
    isDocked: () => dockedActive,
  };
}
