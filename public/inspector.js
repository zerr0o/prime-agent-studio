import { t as tr, bindText, bindAttribute, translateKnown, getLanguage, onLanguageChange } from './i18n.js';
import { filePresentation, defaultFileView, parentFolder } from './file-presentation.js';
import { getAllowOutsidePreview } from './file-preview-settings.js';
import {
  HISTORY_PAGE_SIZE,
  historyUrl,
  commitUrl,
  commitDiffUrl,
  worktreesUrl,
  normalizeHistory,
  normalizeCommit,
  normalizeCommitDiff,
  normalizeWorktrees,
  sameFilesPath,
  isSupportedFilesWorktree,
  filterCommits,
  formatCommitDate,
  formatFileStat,
} from './files-workspace.js';
import { placeViewportMenu } from './file-links.js';
import { thinkingLabel } from './reasoning.js';
import { languageForPath, enhanceFileBlock } from './code-highlight.js';
import { createSubagentSettings } from './subagent-settings.js';

export function shouldAttemptExternalPreview(error, { readOnly = false, allowOutside = true } = {}) {
  if (readOnly) return false;
  if (allowOutside !== true) return false;
  if (!error || error.name === 'AbortError') return false;
  return error?.status === 403 || error?.outside === true || error?.code === 'outside';
}

const $ = (id) => document.getElementById(id);
const node = (tag, className = '', text = '') => {
  const el = document.createElement(tag);
  el.className = className;
  bindText(el, () => text);
  return el;
};
const labels = {
  get working() {
    return tr('ui.travaille');
  },
  get tool() {
    return tr('ui.execute_un_outil');
  },
  get children() {
    return tr('ui.attend_ses_sous_agents');
  },
  get waiting() {
    return tr('ui.en_attente');
  },
  get background() {
    return tr('ui.en_arriere_plan');
  },
  get turn_end() {
    return tr('ui.fin_de_tour');
  },
  get queued() {
    return tr('ui.dans_la_file');
  },
  get compacting() {
    return tr('ui.resume_le_contexte');
  },
  get completed() {
    return tr('ui.termine');
  },
  get idle() {
    return tr('ui.disponible');
  },
  get saved() {
    return tr('ui.historique');
  },
  failed: tr('common.error'),
  get stopped() {
    return tr('ui.arrete');
  },
  get stopping() {
    return tr('ui.arret_en_cours');
  },
  get unknown() {
    return tr('ui.etat_inconnu');
  },
};
const busy = new Set([
  'working',
  'tool',
  'children',
  'waiting',
  'background',
  'turn_end',
  'queued',
  'compacting',
]);

const INSPECTOR_UNIT_IDS = Object.freeze(['session', 'agents', 'files']);
// Mirror of lib/run-file.mjs RUNNABLE_SCRIPT_EXTENSIONS (button visibility
// only; the server re-checks). Parity is unit-tested in test/run-file.test.mjs.
const RUNNABLE_SCRIPT_EXTENSIONS = new Set(
  'bat cmd ps1 py pyw js mjs cjs sh bash vbs vbe wsf jse rb pl php lua'.split(' '),
);
function isRunnableScriptPath(path) {
  return RUNNABLE_SCRIPT_EXTENSIONS.has(String(path).split('.').at(-1)?.toLowerCase() || '');
}

/**
 * Visible-datasets-only fetch matrix (pure, unit-tested).
 * Session consumes the agents dataset (status/usage/context); agents needs it;
 * files needs it for the git bar. Files/git datasets and quota are narrower.
 */
function inspectorFetchPlan({ session = false, agents = false, files = false } = {}) {
  const s = !!session,
    a = !!agents,
    f = !!files;
  return { agents: s || a || f, files: f, git: f, quota: s, any: s || a || f };
}

/**
 * ARIA descriptor per unit (pure, unit-tested). Docked units live inside the
 * dock frame's own tabpanel, so they must not nest a duplicate tabpanel role;
 * classic restores the exact original role + label.
 */
function inspectorUnitAria(key, docked) {
  if (!INSPECTOR_UNIT_IDS.includes(key)) return null;
  if (docked) return { role: null, labelledby: null };
  return { role: 'tabpanel', labelledby: `inspector-tab-${key}` };
}
export { inspectorFetchPlan, inspectorUnitAria, INSPECTOR_UNIT_IDS };
/**
 * Pure unit-visibility decision (geometry-aware, DOM-free inputs).
 * Locked != visible: hidden/parked units keep their target but must not poll.
 * - disconnected/hidden -> false always
 * - docked -> visible only with dock membership AND nonempty rects
 * - classic -> visible only when selected AND nonempty rects
 */
export function inspectorUnitVisible(
  { connected = false, hidden = false, rects = 0, docked = false, dockMember = false, classicSelected = false } = {},
) {
  if (!connected || hidden) return false;
  if (docked) return !!dockMember && rects > 0;
  return !!classicSelected && rects > 0;
}
function isInspectorUnit(value) {
  return value === 'session' || value === 'agents' || value === 'files';
}
// Physical IDs created at runtime must go through domId() so clones stay
// unique. Static template IDs resolve through getElement() (parent scope).
// Primary-facade children share the original host for sections but still need
// unique viewer/git-dialog IDs; section IDs stay identical.
const SCOPED_DYNAMIC_IDS = Object.freeze([
  'inspector-viewer',
  'inspector-view-title',
  'inspector-view-body',
  'git-branch-dialog',
  'git-branch-name',
]);
function primaryUnitDomId(unit) {
  return (id) => (SCOPED_DYNAMIC_IDS.includes(id) ? `${id}--${unit}` : id);
}
function resolveUnitContext(getContext, unit) {
  if (typeof getContext === 'function') return getContext;
  if (getContext && typeof getContext === 'object' && typeof getContext[unit] === 'function')
    return getContext[unit];
  return () => ({});
}
const count = (number) =>
  new Intl.NumberFormat('fr-FR', {
    notation: number >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(number);
const statusNode = (status) =>
  node('span', `inspector-status is-${status}`, () => labels[status] || labels.unknown);

// Composer rendering is shared by host/mobile and every visible docked pane.
// The caller supplies the current session only; no history or message text enters this UI.
export function renderComposerGauge(element, data, options) {
  const setButton = (handler) => {
    const prev = element?._gaugeOpen;
    if (prev && (!handler || prev.fn !== handler)) {
      try { element.removeEventListener('click', prev.click); } catch {}
      try { element.removeEventListener('keydown', prev.key); } catch {}
      element._gaugeOpen = null;
    }
    const active = typeof handler === 'function' ? handler : null;
    if (!active) {
      try { element.removeAttribute('role'); } catch {}
      try { element.removeAttribute('tabindex'); } catch {}
      try { element.removeAttribute('aria-haspopup'); } catch {}
      try { delete element.dataset.gaugeButton; } catch {}
      return;
    }
    if (prev && prev.fn === active) return;
    const click = (event) => { try { event?.preventDefault?.(); } catch {} active(element._contextSummary || null, element); };
    const key = (event) => {
      if (event?.key !== 'Enter' && event?.key !== ' ' && event?.key !== 'Spacebar') return;
      try { event?.preventDefault?.(); } catch {}
      active(element._contextSummary || null, element);
    };
    element._gaugeOpen = { fn: active, click, key };
    // Native <button> already synthesizes click for Enter/Space: a custom
    // keydown would double-open on Space and could land the keyup on the
    // freshly focused confirm button. Spans keep the manual key handler.
    const nativeButton = element?.tagName === 'BUTTON';
    if (nativeButton) {
      try { element.removeAttribute('role'); } catch {}
    } else {
      try { element.setAttribute('role', 'button'); } catch {}
    }
    try { element.tabIndex = 0; } catch {}
    try { element.setAttribute('aria-haspopup', 'dialog'); } catch {}
    try { element.dataset.gaugeButton = 'true'; } catch {}
    try {
      element.addEventListener('click', click);
      if (!nativeButton) element.addEventListener('keydown', key);
    } catch {}
  };
  if (!element) return;
  const context = data?.contextUsage ?? data?.session?.contextUsage;
  const known = Number.isFinite(context?.tokens) && context.tokens >= 0 &&
    Number.isFinite(context?.contextWindow) && context.contextWindow > 0;
  element.hidden = !known;
  if (!known) {
    element.textContent = '';
    element.removeAttribute('title');
    delete element.dataset.level;
    element._contextSummary = { known: false, tokens: null, contextWindow: null, percent: null, level: null, live: false, approx: false, cache: null, lastRequest: false };
    setButton(null);
    return;
  }
  const fill = context.tokens / context.contextWindow * 100;
  const percent = Math.min(100, Math.max(0, Math.round(fill)));
  const last = data?.session?.lastRequestUsage;
  const cache = Number.isFinite(last?.cacheHitRatio) ? Math.round(last.cacheHitRatio * 100) : null;
  bindText(element, () => tr('metrics.contextGauge', { percent }) +
    (cache === null ? '' : ` · ${tr('metrics.cacheGauge', { percent: cache })}`));
  bindAttribute(element, 'title', () => tr(data.lastRequest ? 'metrics.lastContextDetail' : 'metrics.contextDetail', {
    tokens: new Intl.NumberFormat(getLanguage()).format(context.tokens),
    window: new Intl.NumberFormat(getLanguage()).format(context.contextWindow),
  }) + (last ? `
${tr('metrics.lastRequest', {
    input: count(last.input), read: count(last.cacheRead), write: count(last.cacheWrite),
  })}` : ''));
  element.dataset.level = fill >= 95 ? 'danger' : fill >= 80 ? 'warning' : 'normal';
  element._contextSummary = {
    known: true,
    tokens: context.tokens,
    contextWindow: context.contextWindow,
    percent,
    level: fill >= 95 ? 'danger' : fill >= 80 ? 'warning' : 'normal',
    live: !data?.lastRequest,
    approx: !!data?.lastRequest,
    lastRequest: !!data?.lastRequest,
    cacheHitRatio: Number.isFinite(last?.cacheHitRatio) ? last.cacheHitRatio : null,
    cache: (last == null ? null : {
      hitRatio: Number.isFinite(last?.cacheHitRatio) ? last.cacheHitRatio : null,
      input: Number.isFinite(last?.input) ? last.input : null,
      output: Number.isFinite(last?.output) ? last.output : null,
      read: Number.isFinite(last?.cacheRead) ? last.cacheRead : null,
      write: Number.isFinite(last?.cacheWrite) ? last.cacheWrite : null,
    }),
  };
  setButton(typeof options === 'function' ? options : options?.onOpen);
}

export function createInspector({
  api,
  getContext,
  markdown,
  onClose,
  getModels,
  openModelPicker,
  icon,
  toast,
  getElement,
  domId,
  unit,
  instanceId,
  root,
  renderTool,
}) {
  // Multi-instance scope (parent clonePanelScope). Primary legacy omits all
  // three and keeps original IDs/behavior. Clones pass unit + scoped
  // getElement/domId; dynamic IDs always go through mapId().
  const isSingle = isInspectorUnit(unit);
  const owned = isSingle ? unit : null;
  const owns = (key) => !isSingle || unit === key;
  const getEl =
    typeof getElement === 'function' ? getElement : (id) => document.getElementById(id);
  const mapId = typeof domId === 'function' ? domId : (id) => id;
  const instance = instanceId || (isSingle ? `tool:${unit}` : 'primary');
  void root;
  // Scoped `$` shadows the module helper so every existing lookup below stays
  // scoped with zero body churn (vm-sliced quota/agent flows keep working).
  const $ = (id) => getEl(id);
  // Primary facade with per-unit context map: true per-unit state through the
  // async chain, no shared-current swaps. Delegates sections to three isolated
  // single-unit children sharing the original host; facade keeps chrome only.
  if (!isSingle && getContext && typeof getContext === 'object' && !Array.isArray(getContext)) {
    const hasMap = ['session', 'agents', 'files'].some(
      (key) => typeof getContext[key] === 'function',
    );
    if (hasMap) return createMappedPrimaryFacade();
  }
  function createMappedPrimaryFacade() {
    const children = {};
    for (const key of INSPECTOR_UNIT_IDS) {
      const childDomId = primaryUnitDomId(key);
      const childGet = (id) => document.getElementById(childDomId(id));
      children[key] = createInspector({
        api,
        getContext: resolveUnitContext(getContext, key),
        markdown,
        onClose,
        getModels,
        openModelPicker,
        icon,
        toast,
        renderTool,
        getElement: childGet,
        domId: childDomId,
        unit: key,
        instanceId: `primary-${key}`,
      });
    }
    const tabButtons = {
      session: document.getElementById('inspector-tab-session'),
      agents: document.getElementById('inspector-tab-agents'),
      files: document.getElementById('inspector-tab-files'),
    };
    let currentTab = 'session';
    function facadeSetTab(value, focus = false) {
      if (!isInspectorUnit(value)) return;
      currentTab = value;
      for (const key of INSPECTOR_UNIT_IDS) {
        const button = tabButtons[key];
        if (button) {
          button.setAttribute('aria-selected', String(key === currentTab));
          button.tabIndex = key === currentTab ? 0 : -1;
        }
        const section = document.getElementById(`inspector-${key}`);
        if (section) section.hidden = key !== currentTab;
      }
      if (focus) tabButtons[currentTab]?.focus();
      if (value === 'files') children.files?.update?.();
      else children[value]?.update?.();
    }
    for (const key of INSPECTOR_UNIT_IDS) {
      const button = tabButtons[key];
      if (!button || button.dataset.inspectorBound) continue;
      button.dataset.inspectorBound = 'true';
      button.onclick = () => facadeSetTab(key);
      button.onkeydown = (event) => {
        const keys = INSPECTOR_UNIT_IDS.filter((item) => !tabButtons[item]?.disabled);
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        facadeSetTab(
          event.key === 'Home'
            ? keys[0]
            : event.key === 'End'
              ? keys.at(-1)
              : keys[(keys.indexOf(currentTab) + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length],
          true,
        );
      };
    }
    const closeButton = document.getElementById('close-inspector');
    if (closeButton && !closeButton.dataset.inspectorBound) {
      closeButton.dataset.inspectorBound = 'true';
      closeButton.onclick = onClose;
    }
    // Facade-owned mobile shell (exactly once; children never do this).
    // Mirrors the legacy classic contract: role=dialog + aria-modal, inert
    // background, focus trap, Escape->onClose, return focus.
    const facadeBackground = [
      ...document.querySelectorAll('#sidebar, .workspace-header, .conversation-column'),
    ];
    const facadeInert = new Map();
    let facadeMobileModal = false;
    const facadePanelOf = () => document.getElementById('details-panel');
    const facadeViewerOpen = () => !!document.querySelector('.inspector-viewer[open]');
    function syncFacadeMobile() {
      const panel = facadePanelOf();
      if (!panel) return;
      const open = innerWidth <= 1080 && panel.classList.contains('mobile-open') && !panel.hidden;
      if (open === facadeMobileModal) return;
      facadeMobileModal = open;
      if (open) {
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        for (const element of facadeBackground) {
          if (!facadeInert.has(element)) facadeInert.set(element, element.inert);
          element.inert = true;
        }
        if (!facadeViewerOpen()) document.getElementById('close-inspector')?.focus({ preventScroll: true });
      } else {
        panel.removeAttribute('role');
        panel.removeAttribute('aria-modal');
        for (const [element, value] of facadeInert) {
          try {
            element.inert = value;
          } catch {}
        }
        facadeInert.clear();
        if (innerWidth <= 1080)
          document.getElementById('toggle-details')?.focus({ preventScroll: true });
      }
    }
    function onFacadePanelKey(event) {
      const panel = facadePanelOf();
      if (!facadeMobileModal || !panel) return;
      if (facadeViewerOpen() || document.querySelector('#model-dialog[open]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll('button, select, input, a[href], [tabindex="0"]')].filter(
        (element) => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length,
      );
      const first = focusable[0],
        last = focusable.at(-1);
      if (
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    }
    {
      const panel = facadePanelOf();
      if (panel && !panel.dataset.inspectorMobileBound) {
        panel.dataset.inspectorMobileBound = 'true';
        panel.addEventListener('keydown', onFacadePanelKey);
      }
    }
    // Facade-owned tab gating: per-unit enabled (legacy disabled agents/files
    // tabs when the context is not enabled; children skip tab buttons).
    function syncFacadeTabs() {
      for (const key of ['agents', 'files']) {
        const button = tabButtons[key];
        if (!button) continue;
        let enabled = false;
        try {
          enabled = resolveUnitContext(getContext, key)()?.enabled === true;
        } catch {
          enabled = false;
        }
        button.disabled = !enabled;
      }
    }
    function facadeUpdate() {
      syncFacadeMobile();
      syncFacadeTabs();
      for (const key of INSPECTOR_UNIT_IDS) children[key]?.update?.();
    }
    const facadeTimer = setInterval(facadeUpdate, 2500);
    const onFacadeVisible = () => facadeUpdate();
    const onFacadeResize = () => syncFacadeMobile();
    document.addEventListener('visibilitychange', onFacadeVisible);
    window.addEventListener('resize', onFacadeResize);
    syncFacadeMobile();
    syncFacadeTabs();
    return {
      instanceId: 'primary',
      unit: null,
      update: facadeUpdate,
      setTab: facadeSetTab,
      roots() {
        const out = {};
        for (const key of INSPECTOR_UNIT_IDS) Object.assign(out, children[key]?.roots?.() || {});
        return out;
      },
      setDocked(active, visiblePanels, showPanel) {
        for (const key of INSPECTOR_UNIT_IDS) children[key]?.setDocked?.(active, visiblePanels, showPanel);
      },
      // Explicit-cwd document route: never retargets the Files pin. Uses the
      // files child's viewer with the passed cwd, not the pinned context.
      openDocument(reference, { cwd, basePath = '' } = {}) {
        return children.files?.openDocument?.(reference, { cwd, basePath });
      },
      openAgent(agent) {
        return children.agents?.openAgent?.(agent);
      },
      openAgentById(id) {
        return children.agents?.openAgentById?.(id);
      },
      destroy() {
        try {
          clearInterval(facadeTimer);
        } catch {}
        document.removeEventListener('visibilitychange', onFacadeVisible);
        window.removeEventListener('resize', onFacadeResize);
        try {
          facadePanelOf()?.removeEventListener('keydown', onFacadePanelKey);
          delete facadePanelOf()?.dataset.inspectorMobileBound;
        } catch {}
        try {
          for (const [element, value] of facadeInert) element.inert = value;
          facadeInert.clear();
        } catch {}
        facadeMobileModal = false;
        for (const key of INSPECTOR_UNIT_IDS) children[key]?.destroy?.();
      },
    };
  }
  let tab = 'session',
    fileMode = 'changes',
    directory = '',
    contextKey = '',
    generation = 0;
  // Files workspace: which of the 4 subtabs is shown ('changes' reuses
  // fileMode 'changes', 'browse' reuses fileMode 'all').
  let filesView = 'changes';
  // Files-context worktree override: null = project cwd. Switching worktrees
  // only retargets Files requests, never the conversation project.
  let filesCwdOverride = null;
  // History tab state (bounded pagination, client-side search over pages).
  let historyState = {
    commits: [],
    hasMore: false,
    ref: 'HEAD',
    offset: 0,
    loading: false,
    error: '',
    selected: '',
    search: '',
    tagsOnly: false,
  };
  let historyDetail = { hash: '', commit: null, loading: false, error: '' };
  // Worktrees tab state (read-only list; mutations stay in worktrees.js).
  let worktreeState = { list: [], currentPath: '', loading: false, error: '', loadedFor: '' };
  // Dock split state. Null = classic/mobile singleton (unchanged behavior).
  // Docked = { visible: Set<unitId>, show: (id) => bool }. #details-panel stays
  // the classic home; docking owns every move/restore, so no markers here.
  let docked = null;
  let current = {},
    agentData = null,
    fileData = null,
    fileReadError = false,
    agentsAt = 0,
    filesAt = 0,
    lastAgents = '',
    gitData = null,
    gitAt = 0,
    gitAction = null,
    suggestBusy = false;
  // Guards the non-abortable suggest call: only the latest turn may release
  // the busy flag, restore the button label or sync the commit box.
  let suggestTurn = 0;
  const pending = new Map();
  // Normalize single-unit map contexts: clones normally pass a function, but
  // accept a map for uniformity (pick owned resolver, never a shared swap).
  if (isSingle && getContext && typeof getContext !== 'function') {
    getContext = resolveUnitContext(getContext, unit);
  }
  const panel = isSingle ? null : getEl('details-panel');
  const subagentScopeRoot = getEl('project-subagent-settings');
  const subagentSettings =
    (!isSingle || unit === 'agents') && subagentScopeRoot
      ? createSubagentSettings({
          api,
          root: subagentScopeRoot,
          getModels,
          openModelPicker,
          icon,
          toast,
          project: true,
          // Prefix derives from the mapped logical id: primaryUnitDomId keeps
          // 'project-subagent' identity so original inner ids stay exact;
          // clone domId maps it to the physical panel prefix (CSS.escape
          // covers any panel-prefix colons at query time).
          prefix: mapId('project-subagent'),
          instanceId: instance,
        })
      : null;
  let mobileModal = false;
  const background = isSingle
    ? []
    : [...document.querySelectorAll('#sidebar, .workspace-header, .conversation-column')];
  const previousInert = new Map();
  function syncMobilePanel() {
    // Single-unit dock tabs never drive the classic mobile panel.
    if (isSingle || !panel) return;
    const open = innerWidth <= 1080 && panel.classList.contains('mobile-open') && !panel.hidden;
    if (open === mobileModal) return;
    mobileModal = open;
    if (open) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      for (const element of background) {
        previousInert.set(element, element.inert);
        element.inert = true;
      }
      if (!viewer.open) $('close-inspector').focus({ preventScroll: true });
    } else {
      panel.removeAttribute('role');
      panel.removeAttribute('aria-modal');
      for (const [element, value] of previousInert) element.inert = value;
      previousInert.clear();
      if (innerWidth <= 1080) $('toggle-details').focus({ preventScroll: true });
    }
  }
  if (panel)
    panel.addEventListener('keydown', (event) => {
    if (!mobileModal || viewer.open || document.querySelector('#model-dialog[open]')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll('button, select, input, a[href], [tabindex="0"]')].filter(
      (element) => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length,
    );
    const first = focusable[0],
      last = focusable.at(-1);
    if (
      (event.shiftKey && document.activeElement === first) ||
      (!event.shiftKey && document.activeElement === last)
    ) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  });
  const viewer = node('dialog', 'modal inspector-viewer');
  viewer.id = mapId('inspector-viewer');
  viewer.setAttribute('aria-labelledby', mapId('inspector-view-title'));
  viewer.dataset.inspectorInstance = instance;
  if (isSingle) viewer.dataset.inspectorUnit = unit;
  const header = node('div', 'inspector-view-header'),
    title = node('h2');
  title.id = mapId('inspector-view-title');
  const close = node('button', 'secondary-button', () => tr('ui.fermer'));
  close.type = 'button';
  close.onclick = () => viewer.close();
  const controls = node('div', 'inspector-view-controls'),
    body = node('div', 'inspector-view-body');
  body.id = mapId('inspector-view-body');
  header.append(title, close);
  viewer.append(header, controls, body);
  document.body.append(viewer);
  let viewVersion = 0,
    opener;
  const visible = () =>
    isSingle || !panel ? true : !panel.hidden && (innerWidth > 1080 || panel.classList.contains('mobile-open'));
  const unitNode = (key) => getEl(`inspector-${key}`);
  function unitVisible(key) {
    // Single-unit instances never poll/render sibling units, even when the
    // parent supplies a full scoped host containing them. Locked != visible:
    // hidden/parked units keep their target (contextKey preserved) but only
    // poll while truly visible (nonempty rects + membership/selection).
    if (isSingle && key !== unit) return false;
    const node = unitNode(key);
    if (!node) return false;
    const vis = docked ? docked.visible : null;
    return inspectorUnitVisible({
      connected: node.isConnected === true,
      hidden: node.hidden === true,
      rects: node.getClientRects().length,
      docked: !!docked,
      dockMember:
        vis instanceof Set ? vis.has(key) : Array.isArray(vis) ? vis.includes(key) : !!vis,
      classicSelected: isSingle ? true : visible() && tab === key,
    });
  }
  const query = (values) => new URLSearchParams({ cwd: current.cwd, ...values }).toString();
  // Files-context cwd: a selected worktree retargets Files/Git reads and
  // writes without touching the conversation project.
  const filesCwd = () => filesCwdOverride || current.cwd;
  const filesQuery = (values) => new URLSearchParams({ cwd: filesCwd(), ...values }).toString();
  const filesUrl = (action, values = {}) =>
    `/api/project-files${action ? '/' + action : ''}?${filesQuery(values)}`;
  // Explicit-cwd routes (viewer/openDocument): fetch with the passed document
  // cwd so a locked Files pin is never retargeted by cross-context links.
  const queryFor = (cwd, values) => new URLSearchParams({ cwd, ...values }).toString();
  const filesUrlFor = (cwd, action, values = {}) =>
    `/api/project-files${action ? '/' + action : ''}?${queryFor(cwd, values)}`;
  const empty = (element, message) => element.replaceChildren(node('p', 'inspector-empty', () => message));
  const cancel = (key) => {
    pending.get(key)?.abort();
    pending.delete(key);
  };
  async function request(key, url) {
    cancel(key);
    const controller = new AbortController(),
      token = generation;
    pending.set(key, controller);
    try {
      const data = await api(url, { signal: controller.signal });
      if (token !== generation || controller.signal.aborted)
        throw new DOMException(tr('ui.vue_remplacee'), 'AbortError');
      return data;
    } finally {
      if (pending.get(key) === controller) pending.delete(key);
    }
  }
  // Keep disclosure nodes (and their focused summaries) alive during refreshes.
  // State belongs to the rendered session, not the next async request's context.
  const usageDisclosures = new Map();
  let usageContext = '';
  function showUsage() {
    if (!owns('session')) return;
    const session = agentData?.session;
    const usage = session?.totalUsage ?? session?.usage;
    const section = $('inspector-usage');
    if (!section) return;
    section.hidden = !usage;
    if (!usage) return;
    const previous = [...section.querySelectorAll('details')];
    if (usageContext) usageDisclosures.set(usageContext, previous.map((item) => item.open));
    if (usageDisclosures.size > 200) usageDisclosures.delete(usageDisclosures.keys().next().value);
    const sameContext = usageContext === contextKey;
    usageContext = contextKey;
    const content = document.createElement('div');
    content.append(node('div', 'context-label', () => tr('ui.consommation_de_la_session')));
    function properties(value) {
      const dl = node('dl', 'session-properties');
      for (const [key, amount] of [
        ['metrics.input', count(value.input)],
        ['ui.tokens_sortants', count(value.output)],
        ['metrics.cacheRead', count(value.cacheRead ?? 0)],
        ['metrics.cacheWrite', count(value.cacheWrite ?? 0)],
        ['metrics.cacheRate', Number.isFinite(value.cacheHitRatio) ? `${Math.round(value.cacheHitRatio * 100)} %` : tr('metrics.unknown')],
        ['ui.cout_estime', Number.isFinite(value.cost) ? new Intl.NumberFormat(getLanguage(), {
          style: 'currency', currency: 'USD', maximumFractionDigits: 4,
        }).format(value.cost) : tr('metrics.unknown')],
      ]) {
        const row = node('div');
        row.append(node('dt', '', () => tr(key)), node('dd', '', () => amount));
        dl.append(row);
      }
      return dl;
    }
    content.append(properties(usage));
    if (session.subagentCount > 0) {
      content.append(node('p', 'inspector-note', () => tr('metrics.includingSubagents', { count: session.subagentCount })));
      if (session.usage) {
        const main = node('details', 'inspector-main-usage');
        main.append(node('summary', '', () => tr('metrics.mainAgent')), properties(session.usage));
        content.append(main);
      }
    }
    if (session.usageIncomplete)
      content.append(node('p', 'inspector-note', () => tr('metrics.partial')));
    content.append(node('p', 'inspector-note', () => tr('metrics.costNote')));
    for (const [index, detail] of [...content.querySelectorAll('details')].entries()) {
      const retained = sameContext && previous[index];
      if (retained) {
        // The summary is not replaced, so keyboard focus and native toggling survive.
        for (const child of [...retained.children].slice(1)) child.remove();
        retained.append(...[...detail.children].slice(1));
        detail.retainedDisclosure = retained;
      } else detail.open = usageDisclosures.get(usageContext)?.[index] || false;
    }
    const next = [...content.children].map((item) => item.retainedDisclosure || item);
    for (const [index, child] of next.entries()) {
      const existing = section.children[index];
      if (existing === child) continue;
      if (existing) existing.replaceWith(child);
      else section.append(child);
    }
    while (section.children.length > next.length) section.lastElementChild.remove();
  }
  // Session quota (Codex subscription vs API) + live Prime Agent context.
  // Quota shows only for OpenAI family models; Codex needs linked OAuth, never API usage.
  // Context uses live contextUsage (current vs window), never cumulative totals. Hidden when unavailable.
  let quotaSection = null;
  let contextSection = null;
  let quotaSnapshots = {};
  let quotaStates = {};
  const providerCache = {};
  let subagentCache = { cwd: '', at: 0, model: '' };
  let lastQuotaKey = '';
  let lastQuotaProbeKey = '';
  let quotaGeneration = 0;
  // Quota refreshes on its own: on first display, then every 5 minutes while visible.
  const QUOTA_REFRESH_MS = 5 * 60_000;
  const quotaFetchedAt = {};
  const quotaTimer = setInterval(() => {
    if (!owns('session')) return;
    if (document.hidden || !quotaSection || quotaSection.hidden || !unitVisible('session')) return;
    for (const button of quotaSection.querySelectorAll('.session-quota-refresh')) button.click();
  }, QUOTA_REFRESH_MS);
  function requestQuota(force = false) {
    // Central quota dispatch: the session unit must be visible in an enabled,
    // online context. The probe key advances ONLY on dispatch, so hidden
    // periods leave it stale and a reveal with unchanged model/cwd still
    // dispatches when nothing was ever fetched; renderQuota's own
    // key/snapshot/5-minute guards keep repeat dispatches cheap, and its
    // generation checks keep stale replies off a changed context.
    if (!current.enabled || !current.online || document.hidden || !unitVisible('session')) return;
    const quotaKey = `${mainModelId()}\0${current.cwd || ''}`;
    if (!force && quotaKey === lastQuotaProbeKey) return;
    lastQuotaProbeKey = quotaKey;
    void renderQuota();
  }
  function ensureSessionExtras() {
    if (!owns('session')) return;
    if (quotaSection && contextSection) return;
    const host = $('inspector-session');
    if (!host) return;
    const sessionBlock = $('detail-status')?.closest('.context-section');
    quotaSection = document.createElement('section');
    quotaSection.id = mapId('inspector-quota');
    quotaSection.className = 'context-section';
    quotaSection.hidden = true;
    if (!quotaSection.dataset.panelId) quotaSection.dataset.panelId = 'inspector-quota';
    contextSection = document.createElement('section');
    contextSection.id = mapId('inspector-context');
    contextSection.className = 'context-section';
    contextSection.hidden = true;
    if (!contextSection.dataset.panelId) contextSection.dataset.panelId = 'inspector-context';
    // Quota sits right under the session block; live context stays at the end.
    if (sessionBlock) sessionBlock.after(quotaSection);
    else host.append(quotaSection);
    host.append(contextSection);
  }
  function providerOf(modelId) {
    if (typeof modelId !== 'string' || !modelId) return '';
    try {
      const found = getModels().find((item) => item.id === modelId);
      if (found?.provider) return found.provider;
    } catch {}
    const slash = modelId.indexOf('/');
    if (slash > 0) return modelId.slice(0, slash);
    return '';
  }
  function mainModelId() {
    return (current.mainModel || current.model || '').trim();
  }
  async function effectiveSubagentModel(cwd) {
    if (!cwd) return '';
    const now = Date.now();
    if (subagentCache.cwd === cwd && now - subagentCache.at < 15000) return subagentCache.model;
    try {
      const data = await api(`/api/project-subagent-defaults?cwd=${encodeURIComponent(cwd)}`);
      const model = typeof data?.effective?.model === 'string' ? data.effective.model : '';
      subagentCache = { cwd, at: now, model };
      return model;
    } catch {
      subagentCache = { cwd, at: now, model: '' };
      return '';
    }
  }
  async function codexEntry(provider) {
    const now = Date.now();
    const hit = providerCache[provider];
    if (hit && now - hit.at < 30000) return hit;
    try {
      // Minimal safe linkage metadata: works local + mobile/remote via authenticated gateway.
      // Never fetches the broad /api/providers list from mobile. Usage is fetched only when linked.
      const link = await api(`/api/providers/codex-link?${new URLSearchParams({ provider })}`);
      const revision =
        typeof link?.revision === 'string' && /^[a-f0-9]{64}$/.test(link.revision) ? link.revision : '';
      const linked = link?.linked === true && revision !== '';
      const entry =
        link && typeof link === 'object' && revision
          ? { credentialType: linked ? 'oauth' : null, stored: linked, revision }
          : null;
      return (providerCache[provider] = { at: now, entry });
    } catch {
      return (providerCache[provider] = { at: now, entry: null });
    }
  }
  function quotaDate(value) {
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) return '';
    const locale = getLanguage() === 'en' ? 'en-US' : 'fr-FR';
    try {
      return time.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
    } catch {
      return time.toLocaleString();
    }
  }
  function quotaTime(value) {
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) return '';
    const locale = getLanguage() === 'en' ? 'en-US' : 'fr-FR';
    try {
      return time.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }
  function validQuotaWindow(window) {
    return (
      window &&
      typeof window.usedPercent === 'number' &&
      Number.isFinite(window.usedPercent) &&
      typeof window.remainingPercent === 'number' &&
      Number.isFinite(window.remainingPercent)
    );
  }
  function validQuotaResult(result) {
    return (
      result &&
      result.available === true &&
      (validQuotaWindow(result.short) || validQuotaWindow(result.weekly))
    );
  }
  function validContextUsage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const contextWindow = value.contextWindow;
    if (
      typeof contextWindow !== 'number' ||
      !Number.isFinite(contextWindow) ||
      contextWindow <= 0 ||
      contextWindow > 100_000_000
    )
      return undefined;
    const tokens =
      value.tokens === null
        ? null
        : typeof value.tokens === 'number' && Number.isFinite(value.tokens) && value.tokens >= 0
          ? Math.round(value.tokens)
          : undefined;
    const percent =
      value.percent === null
        ? null
        : typeof value.percent === 'number' && Number.isFinite(value.percent)
          ? Math.min(100, Math.max(0, Math.round(value.percent * 10) / 10))
          : undefined;
    if (tokens === undefined && percent === undefined) return undefined;
    if (tokens === null || percent === null) return undefined;
    return { tokens, contextWindow: Math.round(contextWindow), percent };
  }
  function quotaBar(label, usedPercent) {
    const row = document.createElement('div');
    row.className = 'session-quota-row';
    const head = document.createElement('div');
    head.className = 'session-quota-head';
    const name = document.createElement('span');
    bindText(name, label);
    const value = document.createElement('span');
    bindText(value, () => `${usedPercent}%`);
    head.append(name, value);
    const track = document.createElement('div');
    track.className = 'quota-bar';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(usedPercent));
    bindAttribute(track, 'aria-label', label);
    const fill = document.createElement('div');
    fill.className = 'quota-bar-fill';
    fill.style.width = `${Math.min(100, Math.max(0, usedPercent))}%`;
    track.append(fill);
    row.append(head, track);
    return row;
  }
  function renderQuotaBars(container, result) {
    container.replaceChildren();
    if (!validQuotaResult(result)) return;
    for (const [window, label] of [
      [result.short, () => tr('ui.quota_short_label')],
      [result.weekly, () => tr('ui.quota_weekly_label')],
    ]) {
      if (!validQuotaWindow(window)) continue;
      const used = Math.min(100, Math.max(0, Math.round(window.usedPercent * 10) / 10));
      container.append(quotaBar(label, used));
    }
  }
  function formatQuotaText(result) {
    if (!validQuotaResult(result)) return tr('ui.quota_indisponible');
    const parts = [];
    if (typeof result.plan === 'string' && result.plan)
      parts.push(tr('ui.quota_plan', { plan: result.plan }));
    for (const [window, key] of [
      [result.short, 'ui.quota_courte'],
      [result.weekly, 'ui.quota_hebdo'],
    ]) {
      if (!validQuotaWindow(window)) continue;
      const reset =
        typeof window.resetAt === 'number' && Number.isFinite(window.resetAt)
          ? tr('ui.quota_reinitialisation', { date: quotaDate(window.resetAt) })
          : '';
      parts.push(tr(key, { used: window.usedPercent, remaining: window.remainingPercent, reset }));
    }
    if (!parts.length) return tr('ui.quota_indisponible');
    if (typeof result.fetchedAt === 'number' && Number.isFinite(result.fetchedAt)) {
      const time = quotaTime(result.fetchedAt);
      if (time) parts.push(tr('ui.quota_actualisee', { time }));
    }
    return parts.join('\n');
  }
  function renderContext() {
    if (!owns('session')) return;
    ensureSessionExtras();
    if (!contextSection) return;
    if (!current.enabled) {
      contextSection.hidden = true;
      contextSection.replaceChildren();
      return;
    }
    const raw = agentData?.contextUsage ?? agentData?.session?.contextUsage;
    const usage = validContextUsage(raw);
    if (!usage) {
      // Honest unknown UI: keep the section visible instead of disappearing.
      // Idle/no native data -> idle message; null placeholders -> generic pending
      // (compaction-specific text only with proven compaction, never inferred here).
      // Never fabricate a stale snapshot; numeric display stays live-only.
      contextSection.hidden = false;
      contextSection.replaceChildren();
      const label = document.createElement('div');
      label.className = 'context-label';
      bindText(label, () => tr('ui.session_context_title'));
      contextSection.append(label);
      const windowSize =
        raw &&
        typeof raw === 'object' &&
        typeof raw.contextWindow === 'number' &&
        Number.isFinite(raw.contextWindow) &&
        raw.contextWindow > 0 &&
        raw.contextWindow <= 100_000_000
          ? Math.round(raw.contextWindow)
          : undefined;
      if (windowSize !== undefined) {
        const windowLine = document.createElement('p');
        windowLine.className = 'session-context-line';
        bindText(windowLine, () => {
          try {
            const total = new Intl.NumberFormat(getLanguage() === 'en' ? 'en-US' : 'fr-FR').format(
              windowSize,
            );
            return `${tr('ui.fenetre_de_contexte')} : ${total}`;
          } catch {
            return `${windowSize}`;
          }
        });
        contextSection.append(windowLine);
      }
      const hasNullPlaceholder =
        raw && typeof raw === 'object' && (raw.tokens === null || raw.percent === null);
      const line = document.createElement('p');
      line.className = 'session-context-line';
      bindText(line, () => tr(hasNullPlaceholder ? 'ui.session_context_pending' : 'ui.session_context_idle'));
      line.setAttribute('role', 'status');
      const note = document.createElement('p');
      note.className = 'inspector-note';
      bindText(note, () => tr('ui.session_context_note'));
      contextSection.append(line, note);
      return;
    }
    contextSection.hidden = false;
    contextSection.replaceChildren();
    const label = document.createElement('div');
    label.className = 'context-label';
    bindText(label, () => tr('ui.session_context_title'));
    const locale = getLanguage() === 'en' ? 'en-US' : 'fr-FR';
    let formatted = '';
    try {
      const number = (value) => new Intl.NumberFormat(locale).format(value);
      formatted = tr('ui.session_context_detail', {
        used: number(usage.tokens),
        total: number(usage.contextWindow),
        percent: usage.percent,
      });
    } catch {
      formatted = `${usage.tokens} / ${usage.contextWindow} (${usage.percent}%)`;
    }
    const line = document.createElement('p');
    line.className = 'session-context-line';
    bindText(line, () => {
      try {
        const number = (value) =>
          new Intl.NumberFormat(getLanguage() === 'en' ? 'en-US' : 'fr-FR').format(value);
        return tr('ui.session_context_detail', {
          used: number(usage.tokens),
          total: number(usage.contextWindow),
          percent: usage.percent,
        });
      } catch {
        return `${usage.tokens} / ${usage.contextWindow} (${usage.percent}%)`;
      }
    });
    line.setAttribute('role', 'status');
    const track = document.createElement('div');
    track.className = 'quota-bar';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(usage.percent));
    bindAttribute(track, 'aria-label', () => tr('ui.session_context_title'));
    const fill = document.createElement('div');
    fill.className = 'quota-bar-fill';
    fill.style.width = `${Math.min(100, Math.max(0, usage.percent))}%`;
    track.append(fill);
    const note = document.createElement('p');
    note.className = 'inspector-note';
    bindText(note, () => tr('ui.session_context_note'));
    contextSection.append(label, line, track, note);
  }
  async function renderQuota() {
    if (!owns('session')) return;
    ensureSessionExtras();
    if (!quotaSection || !contextSection) return;
    const token = ++quotaGeneration;
    const mainId = mainModelId();
    const renderCwd = current.cwd;
    const renderMain = mainId;
    const mainProvider = providerOf(mainId);
    let subModel = '';
    if (current.cwd) {
      try {
        subModel = await effectiveSubagentModel(current.cwd);
      } catch {
        subModel = '';
      }
    }
    if (token !== quotaGeneration) return;
    if (current.cwd !== renderCwd || mainModelId() !== renderMain) return;
    const effectiveId = subModel || mainId;
    const effectiveProvider = providerOf(effectiveId);
    const uses = (id) => mainProvider === id || effectiveProvider === id;
    // Main agent and subagents may use different subscriptions: one block per provider used.
    // OpenAI API keys (no subscription) only get a neutral note.
    const usages = ['openai-codex', 'anthropic'].filter(uses);
    const apiOnly = !uses('openai-codex') && uses('openai');
    const key = `${mainId}\0${effectiveId}\0${current.cwd || ''}`;
    if (key !== lastQuotaKey) {
      lastQuotaKey = key;
      quotaSnapshots = {};
      quotaStates = {};
    }
    if (!usages.length && !apiOnly) {
      quotaSection.hidden = true;
      quotaSection.replaceChildren();
      return;
    }
    const titles = {
      'openai-codex': 'ui.session_quota_codex_title',
      anthropic: 'ui.session_quota_claude_title',
    };
    const heading = (text) => node('div', 'context-label', () => tr(text));
    const note = (text) => node('p', 'inspector-note', () => tr(text));
    // Subscription path: require linked OAuth; refresh on display, every 5 min, or manually.
    // Works local + mobile/remote via sanitized read-only endpoints behind existing PIN auth.
    const links = await Promise.all(usages.map((usage) => codexEntry(usage)));
    if (token !== quotaGeneration) return;
    if (current.cwd !== renderCwd || mainModelId() !== renderMain) return;
    const nodes = [];
    if (apiOnly) nodes.push(heading('ui.session_quota_api_title'), note('ui.session_quota_api_note'));
    usages.forEach((usage, index) => {
      const claude = usage === 'anthropic';
      const entry = links[index].entry;
      nodes.push(heading(titles[usage]));
      if (!(entry && entry.credentialType === 'oauth' && entry.stored)) {
        nodes.push(note(claude ? 'ui.session_quota_claude_unlinked' : 'ui.session_quota_unlinked'));
        return;
      }
      const line = document.createElement('p');
      line.className = 'session-quota-line';
      line.setAttribute('role', 'status');
      const bars = document.createElement('div');
      bars.className = 'quota-bars';
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'secondary-button session-quota-refresh';
      bindText(refresh, () => tr('ui.quota_actualiser'));
      const paint = () => {
        const snapshot = quotaSnapshots[usage];
        const state = quotaStates[usage] || 'idle';
        bindText(line, () => {
          if (snapshot && validQuotaResult(snapshot)) return formatQuotaText(snapshot);
          if (state === 'loading') return tr('ui.quota_chargement');
          if (state === 'auth') return tr(claude ? 'ui.session_quota_claude_auth' : 'ui.session_quota_auth');
          if (state === 'error') return tr('ui.quota_indisponible');
          return tr('ui.quota_non_consulte');
        });
        renderQuotaBars(bars, snapshot);
        bars.hidden = !bars.childElementCount;
      };
      paint();
      refresh.onclick = async () => {
        if (refresh.disabled) return;
        refresh.disabled = true;
        quotaFetchedAt[usage] = Date.now();
        quotaStates[usage] = 'loading';
        paint();
        try {
          const params = new URLSearchParams({ provider: usage, revision: entry.revision || '' });
          const result = await api(`/api/providers/codex-usage?${params}`);
          // Never falsely attribute another provider's usage to this block.
          if (validQuotaResult(result) && result.provider === usage) {
            quotaSnapshots[usage] = result;
            quotaStates[usage] = 'done';
          } else {
            quotaSnapshots[usage] = null;
            quotaStates[usage] = result?.available === false && result.reason === 'auth' ? 'auth' : 'error';
          }
        } catch {
          quotaSnapshots[usage] = null;
          quotaStates[usage] = 'error';
        } finally {
          refresh.disabled = false;
          paint();
        }
      };
      nodes.push(line, bars, refresh);
      if (Date.now() - (quotaFetchedAt[usage] || 0) >= QUOTA_REFRESH_MS) void refresh.onclick();
    });
    // Replace the section content only once it is complete: a cache expiry must not blank it.
    quotaSection.hidden = false;
    quotaSection.replaceChildren(...nodes);
  }
  function syncDetailStatus() {
    if (!owns('session')) return;
    const target = $('detail-status');
    if (!target) return;
    if (agentData?.session) target.replaceChildren(statusNode(agentData.session.status));
  }
  function renderAgents() {
    if (!owns('agents')) return;
    const data = agentData,
      list = $('inspector-agent-list');
    if (!list) return;
    if (!data?.session) {
      empty(list, () => tr('ui.ouvrez_une_session_pour_retrouver_son_agent_et_ses_delegations'));
      return;
    }
    const total = data.agents.filter((agent) => !agent.root).length;
    const agentCount = $('inspector-agent-count');
    if (agentCount) {
      bindText(agentCount, () => total);
      agentCount.hidden = !total;
    }
    const running = data.agents.filter((agent) => busy.has(agent.status)).length;
    const agentSummary = $('inspector-agent-summary');
    if (agentSummary)
      bindText(agentSummary, () =>
        tr('count.subagents', {
          count: total,
          activity: running ? tr('ui.en_activite', { value1: running }) : '',
        }),
      );
    const agentNote = $('inspector-agent-note');
    if (agentNote)
      bindText(
        agentNote,
        () =>
          (data.notes || []).map(translateKnown).join(' ') ||
          (data.live ? tr('ui.suivi_en_direct') : tr('ui.delegations_conservees_par_prime_agent')),
      );
    const fingerprint = JSON.stringify(data);
    if (fingerprint === lastAgents) return;
    lastAgents = fingerprint;
    const focusedId = document.activeElement?.closest('[data-agent-id]')?.dataset.agentId;
    list.replaceChildren();
    const seen = new Set();
    function add(agent, depth = 0) {
      if (seen.has(agent.id)) return;
      seen.add(agent.id);
      const card = node('button', 'inspector-agent');
      card.type = 'button';
      card.dataset.agentId = agent.id;
      card.style.setProperty('--agent-depth', Math.min(depth, 4));
      card.append(
        node('span', 'inspector-agent-kind', () =>
          agent.root
            ? tr('ui.agent_principal')
            : tr('agents.child', { value1: depth > 1 ? tr('agents.level', { value1: depth }) : '' }),
        ),
        node('strong', 'inspector-agent-name', () => agent.name),
        statusNode(agent.status),
      );
      if (agent.model) card.append(node('span', 'inspector-agent-model', () => agent.model));
      card.append(
        node('span', 'inspector-agent-thinking', () =>
          tr('ui.reflexion_2', { value1: thinkingLabel(agent.thinking) }),
        ),
      );
      if (agent.progressNote)
        card.append(
          node('span', 'inspector-agent-progress', () => tr('agents.progress', { note: agent.progressNote })),
        );
      if (Number.isFinite(agent.lastActivityAt)) {
        const activity = node('span', 'inspector-note inspector-agent-activity', () => {
          if (Number.isFinite(agent.activityStaleMs)) {
            const minutes = agent.activityStaleMs >= 60000;
            return tr(minutes ? 'agents.activityMinutes' : 'agents.activitySeconds', {
              value: Math.floor(agent.activityStaleMs / (minutes ? 60000 : 1000)),
            });
          }
          return tr('agents.lastActivity', {
            time: new Date(agent.lastActivityAt).toLocaleTimeString(getLanguage()),
          });
        });
        bindAttribute(activity, 'title', () =>
          tr('agents.lastActivity', {
            time: new Date(agent.lastActivityAt).toLocaleString(getLanguage()),
          }),
        );
        card.append(activity);
      }
      if (agent.preview || translateKnown(agent.error))
        card.append(
          node('span', 'inspector-agent-preview', () => translateKnown(agent.error) || agent.preview),
        );
      if (agent.toolUseCount)
        card.append(node('span', 'inspector-note', () => tr('count.tools', { count: agent.toolUseCount })));
      bindAttribute(card, 'aria-label', () =>
        tr('ui.voir_les_details', { value1: agent.name, value2: labels[agent.status] || labels.unknown }),
      );
      card.onclick = () => openAgent(agent);
      list.append(card);
      for (const child of data.agents.filter((child) => child.parentId === agent.id)) add(child, depth + 1);
    }
    for (const agent of data.agents.filter((agent) => agent.root)) add(agent);
    for (const agent of data.agents) if (!seen.has(agent.id)) add(agent, 1);
    if (!total)
      list.append(
        node('p', 'inspector-empty', () => tr('ui.aucun_sous_agent_enregistre_pour_cette_session')),
      );
    if (data.truncated)
      list.append(node('p', 'inspector-note', () => tr('ui.les_200_premiers_sous_agents_sont_affiches')));
    if (focusedId)
      [...list.children]
        .find((element) => element.dataset.agentId === focusedId)
        ?.focus({ preventScroll: true });
  }
  async function loadAgents(force = false) {
    if (
      !current.enabled ||
      !current.cwd ||
      !current.sessionId ||
      pending.has('agents') ||
      (!force && Date.now() - agentsAt < 4000)
    )
      return;
    agentsAt = Date.now();
    if (!agentData) bindText($('inspector-agent-note'), () => tr('ui.chargement_des_agents'));
    try {
      agentData = await request('agents', `/api/inspector?${query({ sessionId: current.sessionId })}`);
      renderAgents();
      syncGitBar();
      showUsage();
      renderContext();
      // Recheck expiring defaults/link metadata even with the same model/cwd.
      // The central visibility gate and renderQuota caches still apply.
      requestQuota(true);
      if (agentData.session) syncDetailStatus();
    } catch (error) {
      if (error.name !== 'AbortError') {
        const note = $('inspector-agent-note');
        if (note && owns('agents')) bindText(note, () => translateKnown(error.message));
      }
    }
  }
  function setTab(value, focus = false) {
    if (isSingle) {
      // Single-unit tabs are owned by the parent/dock. Only react when the
      // request targets the owned unit; never hide sibling sections here.
      if (value !== unit) return;
      if (docked) docked.show?.(value);
      else update();
      if (focus) $(`inspector-tab-${unit}`)?.focus?.();
      return;
    }
    if (docked) {
      if (INSPECTOR_UNIT_IDS.includes(value)) docked.show?.(value);
      return;
    }
    tab = value;
    for (const key of ['session', 'agents', 'files']) {
      const button = $(`inspector-tab-${key}`);
      button.setAttribute('aria-selected', String(key === tab));
      button.tabIndex = key === tab ? 0 : -1;
      $(`inspector-${key}`).hidden = key !== tab;
    }
    if (focus) $(`inspector-tab-${tab}`).focus();
    if (value === 'files') void loadGit();
    update();
  }
  if (!isSingle)
    for (const key of ['session', 'agents', 'files']) {
    const button = $(`inspector-tab-${key}`);
    if (!button) continue;
    button.onclick = () => setTab(key);
    button.onkeydown = (event) => {
      const keys = ['session', 'agents', 'files'].filter((key) => !$(`inspector-tab-${key}`).disabled);
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      setTab(
        event.key === 'Home'
          ? keys[0]
          : event.key === 'End'
            ? keys.at(-1)
            : keys[(keys.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length],
        true,
      );
    };
  }
  if (!isSingle) {
    const closeButton = $('close-inspector');
    if (closeButton) closeButton.onclick = onClose;
  }
  if (owns('agents')) {
    const refreshAgents = $('refresh-agents');
    if (refreshAgents)
      refreshAgents.onclick = () => {
        void loadAgents(true);
        if (current.cwd) void subagentSettings?.open();
      };
  }

  function fileStatusIcon(file) {
    const status = String(file.status || '');
    const kind = file.deleted || status.includes('D') ? 'deleted'
      : file.untracked || status.includes('A') || status === '??' ? 'added' : 'modified';
    const badge = node('span', `git-file-status is-${kind}`, () => ({ added: '+', deleted: '−', modified: '•' })[kind]);
    badge.setAttribute('role', 'img');
    bindAttribute(badge, 'aria-label', () => tr(`files.status_${kind}`));
    bindAttribute(badge, 'title', () => tr(`files.status_${kind}`));
    return badge;
  }
  function renderFiles(append = false) {
    if (!owns('files')) return;
    closeFileMenu();
    const list = $('inspector-file-list'),
      crumb = $('inspector-file-breadcrumb');
    if (!list || !crumb) return;
    const focusedPath = document.activeElement?.closest('[data-file-path]')?.dataset.filePath;
    const selection = new Map([...list.querySelectorAll('.git-file-check')].map((box) => [box.dataset.gitPath, box.checked]));
    if (!append) list.replaceChildren();
    crumb.replaceChildren();
    const note = $('inspector-file-note');
    if (fileMode === 'changes') {
      bindText(note, () =>
        fileData.git
          ? tr('count.filesChanged', { branch: fileData.branch, count: fileData.total })
          : translateKnown(fileData.reason),
      );
      for (const file of fileData.entries) {
        const row = node('button', 'inspector-file');
        row.type = 'button';
        row.dataset.filePath = file.path;
        row.append(fileStatusIcon(file), node('span', 'inspector-file-path', () => file.path));
        bindAttribute(row, 'title', () =>
          [
            file.previousPath ? `${file.previousPath} → ${file.path}` : file.path,
            file.staged ? tr('ui.contient_des_modifications_indexees') : tr('ui.non_indexe'),
          ].join(' · '),
        );
        row.onclick = () => openFile(file, defaultFileView(file), filesCwd());
        attachFileMenu(row, file);
        if (fileData.git && !current.readOnly) {
          const wrap = node('div', 'inspector-file-row');
          const check = document.createElement('input');
          check.type = 'checkbox';
          check.className = 'git-file-check';
          check.checked = selection.get(file.path) ?? true;
          check.dataset.gitPath = file.path;
          bindAttribute(check, 'aria-label', () => `${tr('git.panel_select_files')} : ${file.path}`);
          check.onchange = () => syncCommitBox();
          wrap.append(check, row);
          list.append(wrap);
        } else list.append(row);
      }
      if (!fileData.entries.length)
        empty(list, () =>
          fileData.git
            ? tr('ui.aucune_modification_dans_ce_projet')
            : tr('ui.utilisez_parcourir_pour_consulter_ses_fichiers'),
        );
      if (fileData.truncated)
        list.append(
          node('p', 'inspector-note', () => tr('ui.les_1_000_premieres_modifications_sont_affichees')),
        );
    } else {
      bindText(note, () => tr('ui.lecture_seule_dossiers_techniques_masques'));
      const root = node('button', '', () => tr('ui.projet'));
      root.type = 'button';
      root.onclick = () => browse('');
      crumb.append(root);
      const parts = directory.split('/').filter(Boolean);
      parts.forEach((part, index) => {
        const button = node('button', '', () => part);
        button.type = 'button';
        button.onclick = () => browse(parts.slice(0, index + 1).join('/'));
        crumb.append(
          node('span', '', () => '/'),
          button,
        );
      });
      for (const file of fileData.entries) {
        const row = node('button', 'inspector-file');
        row.type = 'button';
        row.dataset.filePath = file.path;
        row.append(
          node('span', 'inspector-file-symbol', () => (file.directory ? '▸' : '·')),
          node('span', 'inspector-file-path', () => file.name),
        );
        bindAttribute(
          row,
          'aria-label',
          () => `${file.directory ? tr('ui.ouvrir_le_dossier') : tr('common.view')} ${file.name}`,
        );
        row.onclick = () => (file.directory ? browse(file.path) : openFile(file, 'preview'));
        attachFileMenu(row, file);
        list.append(row);
      }
      if (!fileData.total) empty(list, () => tr('ui.ce_dossier_est_vide'));
      if (fileData.nextOffset !== null) {
        const more = node('button', 'inspector-more', () => tr('ui.afficher_la_suite'));
        more.type = 'button';
        more.onclick = () => {
          more.remove();
          void loadFiles(true, fileData.nextOffset);
        };
        list.append(more);
      }
    }
    if (focusedPath)
      list.querySelector(`[data-file-path="${CSS.escape(focusedPath)}"]`)?.focus({ preventScroll: true });
    syncCommitBox();
  }
  async function loadFiles(force = false, offset = 0) {
    if (!owns('files')) return;
    if (!current.enabled || !filesCwd() || pending.has('files') || (!force && Date.now() - filesAt < 6000))
      return;
    filesAt = Date.now();
    if (!fileData) bindText($('inspector-file-note'), () => tr('ui.chargement_des_fichiers'));
    const mode = fileMode;
    try {
      const data = await request(
        'files',
        mode === 'changes' ? filesUrl('changes') : filesUrl('', { path: directory, offset }),
      );
      // Background reads must not replace unchanged rows, selection or scroll position.
      if (!fileReadError && offset === 0 && JSON.stringify(data) === JSON.stringify(fileData)) return;
      fileReadError = false;
      fileData = data;
      renderFiles(offset > 0);
    } catch (error) {
      if (error.name !== 'AbortError') {
        fileReadError = true;
        bindText($('inspector-file-note'), () => translateKnown(error.message));
        if (!fileData) empty($('inspector-file-list'), () => tr('ui.reessayez_avec_le_bouton_actualiser'));
      }
    }
  }
  function browse(path) {
    if (!owns('files')) return;
    cancel('files');
    directory = path;
    fileData = null;
    fileMode = 'all';
    filesView = 'browse';
    syncFilesView();
    syncGitBar();
    syncCommitBox();
    void loadFiles(true);
  }
  function changeFiles(mode) {
    setFilesView(mode === 'all' ? 'browse' : 'changes');
  }
  // Files workspace sub-tabs: Modifications / Historique / Worktrees /
  // Parcourir. History and worktrees are lazy: they fetch on first show.
  function setFilesView(view) {
    if (!owns('files')) return;
    const next = view === 'history' || view === 'worktrees' || view === 'browse' ? view : 'changes';
    filesView = next;
    if (next === 'changes' || next === 'browse') {
      const mode = next === 'browse' ? 'all' : 'changes';
      if (fileMode !== mode) {
        cancel('files');
        fileMode = mode;
        fileData = null;
        filesAt = 0;
        $('inspector-file-list')?.replaceChildren();
      }
    }
    syncFilesView();
    if (next === 'changes' || next === 'browse') {
      syncGitBar();
      syncCommitBox();
      void loadFiles(true);
      void loadGit();
    } else if (next === 'history') {
      void loadGit();
      void loadHistory(true);
    } else if (next === 'worktrees') {
      void loadGit();
      void loadWorktrees(true);
    }
  }
  function syncFilesView() {
    if (!owns('files')) return;
    const host = $('inspector-files');
    if (host) host.dataset.filesView = filesView;
    for (const [id, view] of [
      ['files-changes', 'changes'],
      ['files-history', 'history'],
      ['files-worktrees', 'worktrees'],
      ['files-all', 'browse'],
    ])
      $(id)?.setAttribute('aria-pressed', String(filesView === view));
    const split = $('files-changes-split'),
      history = $('files-pane-history'),
      worktrees = $('files-pane-worktrees');
    if (split) split.hidden = filesView !== 'changes' && filesView !== 'browse';
    if (history) history.hidden = filesView !== 'history';
    if (worktrees) worktrees.hidden = filesView !== 'worktrees';
    syncFilesContext();
    syncCommitBox();
  }
  function syncFilesContext() {
    if (!owns('files')) return;
    const reset = $('files-context-reset');
    if (reset) reset.hidden = !filesCwdOverride;
    $('git-branch-button')?.setAttribute('title', filesCwd() || '');
  }
  function setFilesCwdOverride(path) {
    if (!owns('files')) return;
    // A Files context switch is a generation transition (same semantics as the
    // project switch in update()): in-flight Git writes block the switch, all
    // pending reads are cancelled, drafts and selections are cleared, and the
    // generation advances so a late old-root response can never populate the
    // new view, draft or commit paths. Plain suggest calls are not abortable
    // but already check the generation before writing.
    if (gitAction) {
      toast(() => tr('git.panel_busy'), true);
      return;
    }
    generation++;
    for (const key of [...pending.keys()]) cancel(key);
    suggestBusy = false;
    suggestTurn++;
    if ($('git-suggest-button')) $('git-suggest-button').textContent = tr('git.panel_suggest');
    filesCwdOverride = path || null;
    fileData = null;
    gitData = null;
    gitAt = 0;
    filesAt = 0;
    directory = '';
    const draft = $('git-commit-message');
    if (draft) draft.value = '';
    closeFileMenu();
    closeGitMenu();
    if (viewer.open) viewer.close();
    historyState = {
      commits: [],
      hasMore: false,
      ref: 'HEAD',
      offset: 0,
      loading: false,
      error: '',
      selected: '',
      search: historyState.search,
      tagsOnly: historyState.tagsOnly,
    };
    historyDetail = { hash: '', commit: null, loading: false, error: '' };
    worktreeState = { list: [], currentPath: '', loading: false, error: '', loadedFor: '' };
    syncFilesContext();
    syncFilesView();
    syncGitBar();
    syncCommitBox();
    void loadFiles(true);
    void loadGit(true);
    if (filesView === 'history') void loadHistory(true);
    if (filesView === 'worktrees') void loadWorktrees(true);
  }
  // Shared patch renderer (same rules as the file viewer diff mode).
  function appendPatchLines(pre, text) {
    for (const line of String(text).split('\n'))
      pre.append(
        node(
          'span',
          line.startsWith('@@')
            ? 'diff-hunk'
            : line.startsWith('+') && !line.startsWith('+++')
              ? 'diff-add'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'diff-remove'
                : '',
          () => line || ' ',
        ),
      );
  }
  // Shared patch rendering for working-tree and commit viewers.
  // ---- Historique ----
  async function loadHistory(reset = false) {
    if (!owns('files') || filesView !== 'history') return;
    if (!filesCwd()) return;
    if (gitData && !gitData.git) {
      historyState.loading = false;
      historyState.error = '';
      renderHistory();
      return;
    }
    if (historyState.loading) return;
    if (reset) {
      cancel('history');
      historyState = {
        ...historyState,
        commits: [],
        hasMore: false,
        ref: 'HEAD',
        offset: 0,
        loading: false,
        error: '',
        selected: '',
      };
      historyDetail = { hash: '', commit: null, loading: false, error: '' };
    }
    historyState.loading = true;
    historyState.error = '';
    renderHistory();
    const token = generation,
      offset = reset ? 0 : historyState.offset;
    try {
      const data = await request('history', historyUrl(filesCwd(), { offset, limit: HISTORY_PAGE_SIZE }));
      if (token !== generation) return;
      const normalized = normalizeHistory(data);
      historyState.commits = reset ? normalized.commits : [...historyState.commits, ...normalized.commits];
      historyState.hasMore = normalized.hasMore && normalized.commits.length > 0;
      historyState.ref = normalized.ref || 'HEAD';
      historyState.offset = offset + normalized.commits.length;
      if (reset) {
        historyState.selected = normalized.commits[0]?.hash || '';
        if (historyState.selected) void loadCommitDetail();
        else renderHistoryDetail();
      }
    } catch (error) {
      if (error.name === 'AbortError' || token !== generation) return;
      historyState.error = translateKnown(error.message);
    } finally {
      if (token !== generation) return;
      historyState.loading = false;
      renderHistory();
      renderHistoryDetail();
    }
  }
  function renderHistory() {
    if (!owns('files')) return;
    const list = $('files-history-list');
    if (!list) return;
    const scrollTop = list.scrollTop;
    const focusedHash = list.contains(document.activeElement) ? document.activeElement.dataset.commitHash : null;
    list.setAttribute('aria-busy', String(historyState.loading));
    const errorBox = $('files-history-error');
    if (errorBox) {
      errorBox.hidden = !historyState.error;
      if (historyState.error) {
        errorBox.replaceChildren();
        const text = document.createElement('span');
        text.textContent = `${tr('files.history_load_error')} ${historyState.error}`;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = tr('files.history_retry');
        retry.onclick = () => void loadHistory(historyState.commits.length === 0);
        errorBox.append(text, retry);
      }
    }
    list.replaceChildren();
    if (historyState.loading && !historyState.commits.length) {
      const item = document.createElement('p');
      item.className = 'inspector-note';
      item.textContent = tr('files.history_loading');
      list.append(item);
    } else if (gitData && !gitData.git) {
      const item = document.createElement('p');
      item.className = 'inspector-note';
      item.textContent = tr('files.no_git_history');
      list.append(item);
    } else {
      const visible = filterCommits(historyState.commits, {
        search: historyState.search,
        tagsOnly: historyState.tagsOnly,
      });
      if (!visible.length) {
        const item = document.createElement('p');
        item.className = 'inspector-note';
        item.textContent = historyState.commits.length
          ? tr('files.history_empty_search')
          : tr('files.history_empty_repo');
        list.append(item);
      }
      for (const commit of visible) {
        const row = document.createElement('button');
        row.type = 'button';
        row.setAttribute('role', 'option');
        row.dataset.commitHash = commit.hash;
        if (commit.hash === historyState.selected) row.setAttribute('aria-current', 'true');
        const subject = document.createElement('span');
        subject.className = 'files-row-subject';
        subject.textContent = commit.subject || commit.hash;
        const meta = document.createElement('span');
        meta.className = 'files-row-meta';
        meta.textContent = [commit.shortHash, commit.authorName, formatCommitDate(commit.date, getLanguage())]
          .filter(Boolean)
          .join(' · ');
        row.append(subject, meta);
        for (const tag of commit.tags) {
          const chip = document.createElement('span');
          chip.className = 'files-tag';
          chip.textContent = tag;
          row.append(chip);
        }
        row.onclick = () => selectCommit(commit.hash);
        list.append(row);
      }
    }
    if (historyState.loading && historyState.commits.length)
      list.append(node('p', 'inspector-note', () => tr('files.history_loading')));
    list.scrollTop = scrollTop;
    if (focusedHash) list.querySelector(`[data-commit-hash="${CSS.escape(focusedHash)}"]`)?.focus({ preventScroll: true });
  }
  function selectCommit(hash) {
    if (!owns('files') || !hash || historyState.selected === hash) {
      if (historyState.selected === hash && !historyDetail.commit && !historyDetail.loading)
        void loadCommitDetail();
      return;
    }
    historyState.selected = hash;
    historyDetail = { hash, commit: null, loading: false, error: '' };
    for (const row of $('files-history-list')?.querySelectorAll('[data-commit-hash]') || []) {
      if (row.dataset.commitHash === hash) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
    void loadCommitDetail();
  }
  async function loadCommitDetail() {
    if (!owns('files')) return;
    const hash = historyState.selected;
    if (!hash || !filesCwd()) return;
    if (historyDetail.hash === hash && (historyDetail.commit || historyDetail.loading)) {
      renderHistoryDetail();
      return;
    }
    cancel('commit');
    cancel('commitDiff');
    historyDetail = { hash, commit: null, loading: true, error: '' };
    renderHistoryDetail();
    const token = generation;
    try {
      const data = await request('commit', commitUrl(filesCwd(), hash));
      if (token !== generation) return;
      const commit = normalizeCommit(data);
      historyDetail.commit = commit;
    } catch (error) {
      if (error.name === 'AbortError' || token !== generation) return;
      historyDetail.error = translateKnown(error.message);
    } finally {
      if (token !== generation || historyDetail.hash !== hash) return;
      historyDetail.loading = false;
      renderHistoryDetail();
    }
  }
  function renderHistoryDetail() {
    if (!owns('files')) return;
    const panel = $('files-history-detail');
    if (!panel) return;
    panel.hidden = !historyState.selected;
    panel.replaceChildren();
    if (!historyState.selected) return;
    const detail = historyDetail;
    if (detail.loading) {
      empty(panel, () => tr('files.history_loading'));
      return;
    }
    if (detail.error) {
      empty(panel, () => `${tr('files.history_load_error')} ${detail.error}`);
      const retry = node('button', 'inspector-refresh', () => tr('files.history_retry'));
      retry.type = 'button';
      retry.onclick = () => void loadCommitDetail();
      panel.append(retry);
      return;
    }
    if (!detail.commit) return;
    panel.append(node('h3', '', () => tr('files.changed_files')));
    if (!detail.commit.files.length) {
      empty(panel, () => tr('files.history_no_files'));
      return;
    }
    const files = document.createElement('ul');
    files.className = 'files-commit-files';
    for (const entry of detail.commit.files) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.append(
        fileStatusIcon(entry),
        node('span', 'files-path', () => entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path),
      );
      const stats = node('span', 'files-line-stats');
      if (entry.binary) stats.textContent = formatFileStat(entry);
      else if (typeof entry.additions === 'number' && typeof entry.deletions === 'number') {
        stats.append(node('span', 'git-additions', () => `+${entry.additions}`),
          node('span', 'git-deletions', () => `−${entry.deletions}`));
      }
      button.append(stats);
      button.onclick = () => void openCommitDiffViewer(entry);
      item.append(button);
      files.append(item);
    }
    panel.append(files);
  }
  async function openCommitDiffViewer(entry) {
    if (!owns('files') || !historyDetail.commit) return;
    const commit = historyDetail.commit;
    const cwd = filesCwd();
    beginView(`${commit.hash.slice(0, 7)} · ${entry.path}`);
    const token = viewVersion;
    try {
      const data = normalizeCommitDiff(await request('viewer', commitDiffUrl(cwd, commit.hash, entry.path)));
      if (token !== viewVersion) return;
      body.replaceChildren();
      if (data.binary) empty(body, () => tr('files.history_binary'));
      else if (data.patch) {
        const pre = node('pre', 'inspector-diff');
        appendPatchLines(pre, data.patch);
        body.append(pre);
      } else empty(body, () => tr('files.diff_empty'));
      if (data.truncated) body.append(node('p', 'inspector-note', () => tr('files.history_truncated')));
    } catch (error) {
      if (error.name !== 'AbortError' && token === viewVersion)
        empty(body, () => translateKnown(error.message));
    }
  }
  // ---- Worktrees (read-only list; create/inspect/integrate/remove reuse
  // the existing managed dialogs from worktrees.js) ----
  async function loadWorktrees(force = false) {
    if (!owns('files') || !filesCwd()) return;
    if (!force && worktreeState.loadedFor === filesCwd()) {
      renderWorktrees();
      return;
    }
    if (worktreeState.loading) return;
    worktreeState.loading = true;
    worktreeState.error = '';
    renderWorktrees();
    const token = generation,
      cwd = filesCwd();
    try {
      const data = await request('worktrees', worktreesUrl(cwd));
      if (token !== generation) return;
      const normalized = normalizeWorktrees(data);
      worktreeState.list = normalized.worktrees;
      worktreeState.currentPath = normalized.currentPath;
      worktreeState.loadedFor = cwd;
    } catch (error) {
      if (error.name === 'AbortError' || token !== generation) return;
      worktreeState.error = translateKnown(error.message);
    } finally {
      if (token !== generation) return;
      worktreeState.loading = false;
      renderWorktrees();
      syncFilesContext();
    }
  }
  function renderWorktrees() {
    if (!owns('files')) return;
    const tab = $('files-worktrees');
    if (tab) bindText(tab, () => `${tr('files.worktrees_tab')}${worktreeState.list.length > 1 ? ` (${worktreeState.list.length})` : ''}`);
    const list = $('files-worktree-list');
    if (!list) return;
    const errorBox = $('files-worktrees-error');
    if (errorBox) {
      errorBox.hidden = !worktreeState.error;
      if (worktreeState.error) {
        errorBox.replaceChildren();
        const text = document.createElement('span');
        text.textContent = `${tr('files.worktrees_load_error')} ${worktreeState.error}`;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = tr('files.history_retry');
        retry.onclick = () => void loadWorktrees(true);
        errorBox.append(text, retry);
      }
    }
    list.replaceChildren();
    if (worktreeState.loading && !worktreeState.list.length) {
      const item = document.createElement('p');
      item.className = 'inspector-note';
      item.textContent = tr('files.history_loading');
      list.append(item);
    } else if (!worktreeState.list.length) {
      const item = document.createElement('p');
      item.className = 'inspector-note';
      item.textContent = tr('files.worktrees_empty');
      list.append(item);
    }
    const bridge = window.__primeWorktreesUI;
    // Management dialogs act on the bridge's global project. When this pane is
    // pinned to another project, management stands down with an explanation;
    // Files-local actions (open context, folder reveal) stay available.
    const bridgeOwner = typeof bridge?.ownerCwd === 'function' ? bridge.ownerCwd() : '';
    const ownerMismatch =
      Boolean(bridgeOwner) && Boolean(current.cwd) && !sameFilesPath(bridgeOwner, current.cwd);
    const newButton = $('files-worktree-new');
    if (newButton) newButton.hidden = Boolean(current.readOnly) || !bridge?.openCreate || ownerMismatch;
    const headNote = $('files-worktrees-owner-note');
    if (headNote) {
      headNote.hidden = !ownerMismatch;
      if (ownerMismatch) headNote.textContent = tr('files.worktrees_owner_mismatch');
    }
    for (const entry of worktreeState.list) {
      const row = document.createElement('div');
      row.className = 'files-wt-row';
      const isCurrent = sameFilesPath(entry.path, filesCwd());
      if (isCurrent) row.classList.add('is-current');
      const name = document.createElement('strong');
      name.textContent = entry.branch || tr('files.worktree_detached');
      if (entry.bare) name.textContent = tr('files.worktree_bare');
      const meta = document.createElement('div');
      meta.className = 'files-detail-meta';
      const path = document.createElement('div');
      path.className = 'files-wt-path';
      path.textContent = entry.path;
      path.title = entry.path;
      const status = document.createElement('div');
      status.className = 'files-wt-status';
      if (isCurrent) status.append(node('span', 'files-wt-current', () => tr('files.worktree_current')));
      // Missing dirty metadata means unknown, never clean.
      const states = [entry.dirty === true ? tr('files.worktree_dirty')
        : entry.dirty === false ? tr('files.worktree_clean') : tr('files.worktree_unknown')];
      if (entry.detached && entry.branch) states.push(tr('files.worktree_detached'));
      status.append(node('span', 'files-wt-state', () => states.join(' · ')));
      meta.append(path, status);
      const actions = document.createElement('div');
      actions.className = 'files-wt-actions';
      // Ouvrir switches the Files context only. Unsupported native contexts
      // (unmanaged foreign worktrees) would fail every follow-up Files/Git
      // call, so only managed entries and the registered project root stay
      // selectable; going back to the root is always allowed.
      const supported = isSupportedFilesWorktree(entry, current.cwd);
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = tr('files.worktree_open');
      open.disabled = !supported || sameFilesPath(entry.path, filesCwd());
      if (!supported) open.title = tr('files.worktree_open_unavailable');
      if (!open.disabled) open.onclick = () => setFilesCwdOverride(entry.path);
      actions.append(open);
      if (!current.readOnly && current.nativeFileOpen && current.online) {
        const folder = document.createElement('button');
        folder.type = 'button';
        folder.textContent = tr('files.worktree_folder');
        folder.onclick = () => void openWorktreeFolder(entry.path, folder);
        actions.append(folder);
      }
      const managed = entry.managed && entry.id;
      const inspect = document.createElement('button');
      inspect.type = 'button';
      inspect.textContent = tr('files.worktree_inspect');
      inspect.disabled = !managed || !bridge?.openTask || ownerMismatch;
      if (ownerMismatch && managed) inspect.title = tr('files.worktrees_owner_mismatch');
      if (!inspect.disabled)
        inspect.onclick = (event) => {
          try {
            bridge.openTask(entry.id, event.currentTarget);
          } catch (error) {
            toast(() => translateKnown(error.message), true);
          }
        };
      actions.append(inspect);
      row.append(name, meta, actions);
      // The unsupported warning fires only for genuinely unopenable contexts,
      // never for the supported registered root (already current or not).
      if (!supported && !sameFilesPath(entry.path, filesCwd())) {
        const note = document.createElement('div');
        note.className = 'files-wt-note';
        note.textContent = tr('files.worktree_unmanaged_note');
        row.append(note);
      }
      list.append(row);
    }
  }
  async function openWorktreeFolder(path, button) {
    if (!owns('files') || !path || !current.nativeFileOpen || current.readOnly) return;
    button.disabled = true;
    try {
      await api('/api/projects/open', { method: 'POST', body: { cwd: filesCwd(), reference: path } });
      toast(() => tr('ui.ouverture_demandee_sur_le_pc'));
    } catch (error) {
      toast(() => translateKnown(error.message), true);
    } finally {
      button.disabled = false;
    }
  }
  if (owns('files')) {
    const filesChanges = $('files-changes'),
      filesHistory = $('files-history'),
      filesWorktrees = $('files-worktrees'),
      filesAll = $('files-all'),
      refreshFiles = $('refresh-files');
    if (filesChanges) filesChanges.onclick = () => setFilesView('changes');
    if (filesHistory) filesHistory.onclick = () => setFilesView('history');
    if (filesWorktrees) filesWorktrees.onclick = () => setFilesView('worktrees');
    if (filesAll) filesAll.onclick = () => setFilesView('browse');
    if (refreshFiles)
      refreshFiles.onclick = () => {
        if (filesView === 'history') {
          void loadGit(true);
          void loadHistory(true);
        } else if (filesView === 'worktrees') {
          void loadGit(true);
          void loadWorktrees(true);
        } else {
          void loadFiles(true);
          void loadGit(true);
        }
      };
    const historySearch = $('files-history-search');
    if (historySearch)
      historySearch.oninput = () => {
        historyState.search = historySearch.value;
        renderHistory();
      };
    const historyTags = $('files-history-tags');
    if (historyTags)
      historyTags.onclick = () => {
        historyState.tagsOnly = !historyState.tagsOnly;
        historyTags.setAttribute('aria-pressed', String(historyState.tagsOnly));
        renderHistory();
      };
    const historyList = $('files-history-list');
    if (historyList) historyList.onscroll = () => {
      if (filesView === 'history' && historyState.hasMore && !historyState.loading && !historyState.error &&
          historyList.scrollTop + historyList.clientHeight >= historyList.scrollHeight - 48)
        void loadHistory();
    };
    const contextReset = $('files-context-reset');
    if (contextReset) contextReset.onclick = () => setFilesCwdOverride(null);
    const worktreeNew = $('files-worktree-new');
    if (worktreeNew)
      worktreeNew.onclick = (event) => {
        try {
          if (window.__primeWorktreesUI?.openCreate) window.__primeWorktreesUI.openCreate(event.currentTarget);
          else $('new-task')?.click();
        } catch (error) {
          toast(() => translateKnown(error.message), true);
        }
      };
    onLanguageChange(() => {
      renderHistory();
      renderHistoryDetail();
      renderWorktrees();
    });
  }
  // Git controls in the Files tab: branch switcher, fetch/pull/push and commit.
  const gitBusy = () => Boolean(agentData?.session && busy.has(agentData.session.status));
  const gitShortHead = () =>
    typeof gitData?.head === 'string' && gitData.head ? gitData.head.slice(0, 7) : '';
  function gitSelectedPaths() {
    const scopeList = $('inspector-file-list');
    const boxes = scopeList ? scopeList.querySelectorAll('.git-file-check') : [];
    return [...boxes]
      .filter((box) => box.checked)
      .map((box) => box.dataset.gitPath)
      .filter(Boolean);
  }
  function syncGitBar() {
    if (!owns('files')) return;
    const bar = $('inspector-git-bar');
    if (!bar) return;
    const show = Boolean(filesCwd() && gitData?.git);
    bar.hidden = !show;
    if (!show) return;
    $('git-branch-label').textContent = gitData.branch || tr('git.panel_detached', { head: gitShortHead() });
    const counts = $('git-sync-counts');
    const ahead = Number(gitData.ahead) || 0,
      behind = Number(gitData.behind) || 0;
    if (!gitData.upstream) counts.textContent = tr('git.panel_upstream_missing');
    else if (!ahead && !behind) counts.textContent = tr('git.panel_up_to_date');
    else counts.textContent = [...(ahead ? [`↑${ahead}`] : []), ...(behind ? [`↓${behind}`] : [])].join(' ');
    if (gitData.upstream)
      counts.setAttribute('title', tr('git.panel_sync_title', { ahead, behind, upstream: gitData.upstream }));
    else counts.removeAttribute('title');
    const readOnly = Boolean(current.readOnly),
      inFlight = gitAction !== null,
      noRemote = !gitData.remote,
      noUpstream = !gitData.upstream,
      runBusy = gitBusy();
    for (const id of ['git-fetch-button', 'git-pull-button', 'git-push-button']) {
      const actionButton = $(id);
      if (actionButton) actionButton.hidden = readOnly;
    }
    if (readOnly) return;
    const branchButton = $('git-branch-button');
    if (!branchButton) return;
    branchButton.disabled = inFlight || runBusy;
    branchButton.setAttribute('title', runBusy ? tr('git.align_busy') : tr('git.panel_branches'));
    const fetchButton = $('git-fetch-button');
    if (fetchButton) {
      fetchButton.disabled = inFlight || noRemote || !current.online;
      fetchButton.setAttribute('title', noRemote ? tr('git.panel_no_remote') : tr('git.panel_fetch'));
    }
    const pullButton = $('git-pull-button');
    if (!pullButton) return;
    pullButton.disabled = inFlight || runBusy || noUpstream || noRemote;
    pullButton.setAttribute(
      'title',
      runBusy
        ? tr('git.align_busy')
        : noRemote
          ? tr('git.panel_no_remote')
          : noUpstream
            ? tr('git.panel_upstream_missing')
            : tr('git.panel_pull'),
    );
    const pushButton = $('git-push-button');
    if (!pushButton) return;
    const nothingToPush = Boolean(gitData.upstream) && !ahead;
    pushButton.disabled = inFlight || noRemote || nothingToPush;
    pushButton.setAttribute(
      'title',
      noRemote
        ? tr('git.panel_no_remote')
        : nothingToPush
          ? tr('git.panel_nothing_to_push')
          : tr('git.panel_push'),
    );
  }
  function syncCommitBox() {
    if (!owns('files')) return;
    const box = $('inspector-git-commit');
    if (!box) return;
    const show = Boolean(
      filesCwd() && !current.readOnly && filesView === 'changes' && gitData?.git && fileData?.git,
    );
    box.hidden = !show;
    if (!show) return;
    const messageField = $('git-commit-message'),
      button = $('git-commit-button');
    if (!messageField || !button) return;
    const message = messageField.value.trim(),
      selected = gitSelectedPaths(),
      suggest = $('git-suggest-button');
    button.disabled = gitAction !== null || suggestBusy || !message || !selected.length;
    if (!message) button.setAttribute('title', tr('git.panel_no_message'));
    else if (!selected.length) button.setAttribute('title', tr('git.panel_no_selection'));
    else button.removeAttribute('title');
    if (suggest) {
      suggest.disabled = gitAction !== null || suggestBusy || !selected.length;
      if (!selected.length) suggest.setAttribute('title', tr('git.panel_no_selection'));
      else suggest.removeAttribute('title');
      suggest.setAttribute('aria-busy', String(suggestBusy));
      suggest.textContent = suggestBusy ? '…' : tr('git.panel_suggest');
    }
  }
  async function loadGit(force = false) {
    if (!owns('files')) return;
    if (!current.enabled || !filesCwd()) {
      syncGitBar();
      return;
    }
    if (pending.has('git') || (!force && Date.now() - gitAt < 60000)) {
      syncGitBar();
      return;
    }
    gitAt = Date.now();
    try {
      gitData = await request('git', `/api/project-git?${filesQuery()}`);
    } catch (error) {
      if (error.name === 'AbortError') return;
      gitData = null;
    }
    syncGitBar();
    syncCommitBox();
    if (gitData?.git) void loadWorktrees(true);
  }
  // POST responses carry the bare status shape (no git flag); normalize it.
  function applyGitStatus(result) {
    const status = result?.status || result;
    if (status && typeof status.branch !== 'undefined') {
      gitData = { git: true, ...status };
      gitAt = Date.now();
      return true;
    }
    return false;
  }
  async function gitRun(action, body, successKey, successParams, reloadFiles = true) {
    // Writes keep the originating Files-context cwd across await and never run read-only.
    if (!owns('files') || !filesCwd() || current.readOnly || gitAction) return;
    const cwd = filesCwd(),
      token = generation;
    if (reloadFiles) cancel('files');
    gitAction = action;
    syncGitBar();
    syncCommitBox();
    try {
      const result = await api(`/api/project-git/${action}`, {
        method: 'POST',
        body: { cwd, ...body },
      });
      if (generation !== token) return;
      if (!applyGitStatus(result)) await loadGit(true);
      if (successKey) toast(() => tr(successKey, successParams || {}));
      if (generation === token && reloadFiles) {
        fileData = null;
        void loadFiles(true);
      }
    } catch (error) {
      if (error.name !== 'AbortError' && generation === token)
        toast(() => translateKnown(error.message), true);
    } finally {
      if (generation === token) {
        gitAction = null;
        syncGitBar();
        syncCommitBox();
      }
    }
  }
  async function gitSuggest() {
    if (!owns('files')) return;
    const field = $('git-commit-message');
    if (!field) return;
    const paths = gitSelectedPaths();
    if (!paths.length) {
      toast(() => tr('git.panel_no_selection'), true);
      return;
    }
    if (!owns('files') || !filesCwd() || current.readOnly || gitAction || suggestBusy) return;
    const cwd = filesCwd(),
      token = generation,
      myTurn = ++suggestTurn;
    suggestBusy = true;
    syncCommitBox();

    try {
      const result = await api('/api/project-git/suggest-message', {
        method: 'POST',
        body: { cwd, paths },
      });
      const message = typeof result?.message === 'string' ? result.message : '';
      if (!message.trim()) throw new Error(tr('git.suggest_failed'));
      if (generation === token) {
        field.value = message;
        field.focus();
        syncCommitBox();
      }
    } catch (error) {
      if (error.name !== 'AbortError' && generation === token)
        toast(() => translateKnown(error.message), true);
    } finally {
      // A stale completion (older turn or older generation) releases nothing:
      // the reset already cleared the flag and the newer turn owns the UI.
      if (suggestTurn !== myTurn || generation !== token) return;
      suggestBusy = false;
      syncCommitBox();
    }
  }
  async function gitCommit() {
    if (!owns('files')) return;
    const field = $('git-commit-message');
    if (!field) return;
    const message = field.value.trim();
    if (!message) {
      toast(() => tr('git.panel_no_message'), true);
      field.focus();
      return;
    }
    const paths = gitSelectedPaths();
    if (!paths.length) {
      toast(() => tr('git.panel_no_selection'), true);
      return;
    }
    if (!owns('files') || !filesCwd() || current.readOnly || gitAction) return;
    const cwd = filesCwd(),
      token = generation;
    cancel('files');
    gitAction = 'commit';
    syncGitBar();
    syncCommitBox();
    try {
      const result = await api('/api/project-git/commit', {
        method: 'POST',
        body: { cwd, message, paths },
      });
      if (generation !== token) return;
      if (!applyGitStatus(result)) await loadGit(true);
      toast(() => tr('git.panel_committed', { head: String(result?.commit || '').slice(0, 7) }));
      if (generation === token) {
        field.value = '';
        fileData = null;
        void loadFiles(true);
      }
    } catch (error) {
      if (error.name !== 'AbortError' && generation === token)
        toast(() => translateKnown(error.message), true);
    } finally {
      if (generation === token) {
        gitAction = null;
        syncGitBar();
        syncCommitBox();
      }
    }
  }
  // Branch switcher menu: local branches, then remote-only branches, plus creation.
  const gitMenu = document.createElement('div');
  gitMenu.className = 'popover-menu git-branch-menu';
  gitMenu.setAttribute('role', 'menu');
  gitMenu.hidden = true;
  gitMenu.dataset.inspectorInstance = instance;
  document.body.append(gitMenu);
  let gitMenuAnchor = null;
  function closeGitMenu(focusAnchor = false) {
    if (gitMenu.hidden) return;
    gitMenu.hidden = true;
    const anchor = gitMenuAnchor;
    gitMenuAnchor = null;
    if (focusAnchor) anchor?.focus({ preventScroll: true });
  }
  function openGitMenu(anchor) {
    if (!gitData?.git) return;
    gitMenuAnchor = anchor;
    gitMenu.replaceChildren();
    gitMenu.setAttribute('aria-label', tr('git.panel_branches'));
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'git-branch-search';
    search.placeholder = tr('git.panel_search_branches');
    search.setAttribute('aria-label', tr('git.panel_search_branches'));
    const results = document.createElement('div');
    gitMenu.append(search, results);
    const renderMenu = () => {
      results.replaceChildren();
      const needle = search.value.trim().toLowerCase(),
        match = (name) => !needle || name.toLowerCase().includes(needle);
      const local = (gitData.branches?.local || []).filter(match),
        remote = (gitData.branches?.remote || [])
          .filter((name) => !(gitData.branches?.local || []).includes(name))
          .filter(match);
      for (const [title, names, remoteOnly] of [
        [tr('git.panel_local'), local, false],
        [tr('git.panel_remote_only'), remote, true],
      ]) {
        if (!names.length) continue;
        const heading = document.createElement('p');
        heading.className = 'git-branch-heading';
        heading.textContent = title;
        results.append(heading);
        for (const name of names) {
          const item = document.createElement('button');
          item.type = 'button';
          item.setAttribute('role', 'menuitem');
          item.textContent = name;
          if (remoteOnly) item.setAttribute('title', `origin/${name}`);
          if (name === gitData.branch) {
            item.classList.add('is-current');
            item.setAttribute('aria-current', 'true');
          }
          item.onclick = () => {
            closeGitMenu();
            void gitRun('switch', { branch: name }, 'git.panel_switched', { branch: name });
          };
          results.append(item);
        }
      }
      if (!local.length && !remote.length) {
        const empty = document.createElement('p');
        empty.className = 'git-branch-empty';
        empty.textContent = tr('ui.aucun_resultat');
        results.append(empty);
      }
      const create = document.createElement('button');
      create.type = 'button';
      create.setAttribute('role', 'menuitem');
      create.textContent = tr('git.panel_new_branch');
      create.onclick = () => {
        const initial = search.value.trim();
        closeGitMenu();
        openGitDialog(initial);
      };
      results.append(create);
    };
    search.oninput = renderMenu;
    renderMenu();
    gitMenu.hidden = false;
    const rect = anchor.getBoundingClientRect();
    placeViewportMenu(gitMenu, rect.left, rect.bottom + 4);
    search.focus({ preventScroll: true });
  }
  const closeGitMenuOnPointer = (event) => {
    if (
      !gitMenu.hidden &&
      !event.target.closest('.git-branch-menu') &&
      event.target !== gitMenuAnchor &&
      !gitMenuAnchor?.contains(event.target)
    )
      closeGitMenu();
  };
  const closeGitMenuOnKey = (event) => {
    if (gitMenu.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeGitMenu(true);
    }
  };
  document.addEventListener('click', closeGitMenuOnPointer);
  document.addEventListener('keydown', closeGitMenuOnKey, true);
  // In-app dialog for branch creation (never window.confirm).
  const gitDialog = document.createElement('dialog');
  gitDialog.id = mapId('git-branch-dialog');
  gitDialog.className = 'modal compact';
  gitDialog.dataset.inspectorInstance = instance;
  const gitDialogTitle = node('h2', '', () => tr('git.panel_create_title')),
    gitDialogLabel = node('label', '', () => tr('git.panel_branch_name'));
  const gitDialogInput = document.createElement('input');
  gitDialogInput.type = 'text';
  gitDialogInput.autocomplete = 'off';
  gitDialogInput.maxLength = 200;
  gitDialogInput.id = mapId('git-branch-name');
  gitDialogLabel.setAttribute('for', mapId('git-branch-name'));
  bindAttribute(gitDialogInput, 'aria-label', () => tr('git.panel_branch_name'));
  const gitDialogError = node('p', 'form-error', () => tr('git.panel_invalid_branch'));
  gitDialogError.setAttribute('role', 'alert');
  gitDialogError.hidden = true;
  const gitDialogActions = node('div', 'modal-actions'),
    gitDialogCancel = node('button', 'secondary-button', () => tr('ui.annuler')),
    gitDialogCreate = node('button', 'primary-button', () => tr('git.panel_create'));
  gitDialogCancel.type = 'button';
  gitDialogCancel.onclick = () => gitDialog.close();
  gitDialogCreate.type = 'submit';
  gitDialogActions.append(gitDialogCancel, gitDialogCreate);
  const gitDialogForm = document.createElement('form');
  gitDialogForm.append(gitDialogTitle, gitDialogLabel, gitDialogInput, gitDialogError, gitDialogActions);
  gitDialogForm.onsubmit = (event) => {
    event.preventDefault();
    const name = gitDialogInput.value.trim();
    if (!validBranchName(name)) {
      gitDialogError.hidden = false;
      gitDialogInput.focus();
      return;
    }
    gitDialog.close();
    void gitRun('switch', { branch: name, create: true }, 'git.panel_switched', { branch: name });
  };
  gitDialog.append(gitDialogForm);
  document.body.append(gitDialog);
  function validBranchName(name) {
    if (!name || name.length > 200 || /[\s~^:?*[\]]/.test(name)) return false;
    if (name.includes('..') || name.includes('@{') || /[\x00-\x1f\x7f]/.test(name)) return false;
    if (/^[./-]/.test(name) || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock'))
      return false;
    return true;
  }
  function openGitDialog(initial = '') {
    gitDialogInput.value = initial;
    gitDialogError.hidden = true;
    if (!gitDialog.open) gitDialog.showModal();
    gitDialogInput.focus();
  }
  gitDialog.onclose = () => {
    if ($('git-branch-button')?.isConnected && !$('inspector-git-bar').hidden)
      $('git-branch-button').focus({ preventScroll: true });
  };
  if (owns('files')) {
    const gitBranchButton = $('git-branch-button');
    if (gitBranchButton)
      gitBranchButton.onclick = (event) => {
        if (event.currentTarget.disabled) return;
        if (gitMenu.hidden) openGitMenu(event.currentTarget);
        else closeGitMenu();
      };
    const gitFetchButton = $('git-fetch-button');
    if (gitFetchButton)
      gitFetchButton.onclick = (event) => {
        if (event.currentTarget.disabled) return;
        void gitRun('fetch', {}, 'git.panel_fetched', null, false);
      };
    const gitPullButton = $('git-pull-button');
    if (gitPullButton)
      gitPullButton.onclick = (event) => {
        if (event.currentTarget.disabled) return;
        void gitRun('pull', {}, 'git.panel_pulled');
      };
    const gitPushButton = $('git-push-button');
    if (gitPushButton)
      gitPushButton.onclick = (event) => {
        if (event.currentTarget.disabled) return;
        void gitRun('push', {}, 'git.panel_pushed', null, false);
      };
    const gitCommitMessage = $('git-commit-message');
    if (gitCommitMessage) gitCommitMessage.oninput = () => syncCommitBox();
  }
  // Ctrl+Enter commits from the multi-line message; Enter adds a line.
  if (owns('files')) {
    const gitCommitMessageBox = $('git-commit-message');
    if (gitCommitMessageBox)
      gitCommitMessageBox.onkeydown = (event) => {
        if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        if (!$('git-commit-button')?.disabled) void gitCommit();
      };
    const gitCommitButton = $('git-commit-button');
    if (gitCommitButton)
      gitCommitButton.onclick = (event) => {
        if (event.currentTarget.disabled) return;
        void gitCommit();
      };
  }
  const suggestButton = owns('files') ? $('git-suggest-button') : null;
  if (suggestButton)
    suggestButton.onclick = (event) => {
      if (event.currentTarget.disabled) return;
      void gitSuggest();
    };
  const stopGitLanguage = onLanguageChange(() => {
    syncGitBar();
    syncCommitBox();
  });
  let openingProjectFolder = false;
  const openProjectFolder = owns('files') ? $('open-project-folder') : null;
  function syncProjectFolderButton() {
    if (!owns('files') || !openProjectFolder) return;
    const label = $('open-project-folder-label');
    if (label)
      bindText(label, () =>
        current.remote ? tr('ui.ouvrir_le_dossier_sur_le_pc') : tr('ui.ouvrir_le_dossier'),
      );
    openProjectFolder.hidden = !current.enabled || current.readOnly || !current.nativeFileOpen;
    openProjectFolder.disabled =
      openProjectFolder.hidden || !current.cwd || !current.online || openingProjectFolder;
  }
  if (openProjectFolder)
    openProjectFolder.onclick = async () => {
    // Navigation may have changed the selected project since the last inspector refresh.
    update();
    if (openProjectFolder.disabled) return;
    const cwd = current.cwd,
      token = generation;
    openingProjectFolder = true;
    syncProjectFolderButton();
    const stillCurrent = () => generation === token && getContext().cwd === cwd;
    try {
      await api('/api/projects/open', { method: 'POST', body: { cwd } });
      if (stillCurrent()) toast(() => tr('ui.ouverture_demandee_sur_le_pc'));
    } catch (error) {
      if (stillCurrent()) toast(translateKnown(error.message), true);
    } finally {
      openingProjectFolder = false;
      update();
    }
  };

  // File actions share the viewer and the permission-gated PC folder opener.
  const fileMenu = document.createElement('div');
  fileMenu.className = 'popover-menu inspector-file-menu';
  fileMenu.setAttribute('role', 'menu');
  fileMenu.hidden = true;
  fileMenu.dataset.inspectorInstance = instance;
  document.body.append(fileMenu);
  let menuFile = null,
    menuRow = null;
  function closeFileMenu() {
    if (fileMenu.hidden) return;
    fileMenu.hidden = true;
    menuFile = null;
    menuRow = null;
  }
  async function copyFilePath(path) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(path);
      else throw new Error('clipboard');
    } catch {
      const area = document.createElement('textarea');
      area.value = path;
      area.setAttribute('aria-hidden', 'true');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
      if (!ok) {
        toast(() => tr('ui.le_navigateur_ne_permet_pas_la_copie_selectionnez_le_texte_manuel'), true);
        return;
      }
    }
    toast(() => tr('ui.copie'));
  }
  function openFileMenu(file, row, x, y) {
    menuFile = file;
    menuRow = row;
    fileMenu.replaceChildren();
    fileMenu.setAttribute('aria-label', file.path);
    const actions = [
      [
        () => tr('ui.ouvrir'),
        () => {
          const target = menuFile,
            anchor = menuRow;
          closeFileMenu();
          anchor?.focus({ preventScroll: true });
          if (!target) return;
          if (target.directory) browse(target.path);
          else openFile(target, defaultFileView(target), filesCwd());
        },
      ],
      [
        () => (current.remote ? tr('ui.ouvrir_le_dossier_sur_le_pc') : tr('ui.ouvrir_le_dossier')),
        async () => {
          const target = menuFile,
            anchor = menuRow;
          closeFileMenu();
          anchor?.focus({ preventScroll: true });
          if (!target || !current.enabled || current.readOnly || !current.nativeFileOpen || !current.online)
            return;
          try {
            await api('/api/projects/open', {
              method: 'POST',
              body: { cwd: filesCwd(), path: target.directory ? target.path : parentFolder(target.path) },
            });
            toast(() => tr('ui.ouverture_demandee_sur_le_pc'));
          } catch (error) {
            toast(translateKnown(error.message), true);
          }
        },
        !current.enabled || current.readOnly || !current.nativeFileOpen || !current.online,
      ],
      [
        () => tr('ui.copier_le_chemin'),
        () => {
          const target = menuFile,
            anchor = menuRow;
          closeFileMenu();
          anchor?.focus({ preventScroll: true });
          if (target) {
            const separator = filesCwd().includes('\\') ? '\\' : '/';
            const path =
              filesCwd().replace(/[\\/]$/, '') + separator + target.path.replaceAll('/', separator);
            void copyFilePath(path);
          }
        },
      ],
    ];
    for (const [label, run, disabled] of actions) {
      const item = node('button', '', label);
      item.type = 'button';
      item.disabled = Boolean(disabled);
      item.setAttribute('role', 'menuitem');
      item.onclick = run;
      fileMenu.append(item);
    }
    fileMenu.hidden = false;
    placeViewportMenu(fileMenu, x, y);
    fileMenu.querySelector('button')?.focus({ preventScroll: true });
  }
  function attachFileMenu(row, file) {
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openFileMenu(file, row, event.clientX, event.clientY);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        const rect = row.getBoundingClientRect();
        openFileMenu(file, row, rect.left + 16, rect.bottom + 4);
      }
    });
  }
  const closeFileMenuOnPointer = (event) => {
    if (!fileMenu.hidden && !event.target.closest('.inspector-file-menu')) closeFileMenu();
  };
  const closeFileMenuOnScroll = () => closeFileMenu();
  const closeFileMenuOnKey = (event) => {
    if (fileMenu.hidden) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      const anchor = menuRow;
      closeFileMenu();
      anchor?.focus({ preventScroll: true });
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const items = [...fileMenu.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
    }
  };
  document.addEventListener('click', closeFileMenuOnPointer);
  document.addEventListener('scroll', closeFileMenuOnScroll, true);
  document.addEventListener('keydown', closeFileMenuOnKey, true);
  window.addEventListener('resize', closeFileMenuOnScroll);
  window.visualViewport?.addEventListener('resize', closeFileMenuOnScroll);
  window.visualViewport?.addEventListener('scroll', closeFileMenuOnScroll);

  function beginView(name) {
    cancel('viewer');
    viewVersion++;
    if (!viewer.open) opener = document.activeElement;
    bindText(title, () => name);
    controls.replaceChildren();
    empty(body, () => tr('common.loading'));
    if (!viewer.open) viewer.showModal();
  }
  function renderFileText(file, text, cwd) {
    const presentation = filePresentation(file.path, text);
    let source = false;
    const options = node('div', 'inspector-text-options');
    options.setAttribute('role', 'group');
    bindAttribute(options, 'aria-label', () => tr('ui.presentation_du_fichier'));
    const buttons = [];
    function render() {
      body.replaceChildren();
      for (const [button, value] of buttons) button.setAttribute('aria-pressed', String(value === source));
      if (!source && presentation.kind === 'markdown') {
        const document = markdown(text, { cwd: cwd || current.cwd, basePath: file.path });
        document.classList.add('inspector-document');
        body.append(document);
      } else {
        const shown = source ? text : presentation.text;
        const pre = node('pre', 'inspector-code inspector-file-source', () => shown);
        pre.tabIndex = 0;
        bindAttribute(pre, 'aria-label', () =>
          source ? tr('ui.source_du_fichier') : tr('ui.contenu_du_fichier'),
        );
        body.append(pre);
        // Plain text first (tests compare textContent), then paint numbered
        // highlighted lines in place when the file maps to a known language.
        enhanceFileBlock(pre, {
          language: languageForPath(file.path),
          text: shown,
        });
      }
      body.scrollTop = 0;
    }
    if (presentation.kind !== 'text') {
      for (const [value, label] of [
        [false, tr('ui.apercu')],
        [true, tr('ui.source')],
      ]) {
        const button = node('button', '', () => translateKnown(label));
        button.type = 'button';
        button.onclick = () => {
          source = value;
          render();
        };
        buttons.push([button, value]);
        options.append(button);
      }
      controls.insertBefore(options, controls.querySelector('.inspector-open'));
    }
    render();
  }
  function confirmScriptRun(file, cwd) {
    document.querySelector('.script-run-dialog')?.remove();
    const name = file.path.split(/[\\/]/).at(-1);
    const dialog = node('dialog', 'modal script-run-dialog');
    dialog.setAttribute('aria-labelledby', 'script-run-title');
    const heading = node('div', 'modal-heading');
    const title = node('h2', '', () => tr('ui.executer_ce_script'));
    title.id = 'script-run-title';
    heading.append(title);
    const fileName = node('p', 'script-run-file', name);
    // The folder matters only when the script is not at the project root.
    const filePath = node('p', 'script-run-path');
    const code = document.createElement('code');
    code.textContent = file.path;
    filePath.append(code);
    filePath.hidden = file.path === name;
    const warning = node('p', 'script-run-warning', () =>
      tr('ui.le_script_va_s_executer_sur_votre_pc_dans_une_fenetre_visible'),
    );
    const feedback = node('p', 'inspector-note script-run-feedback');
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;
    const actions = node('div', 'script-run-actions');
    const cancel = node('button', 'secondary-button', () => tr('ui.annuler'));
    cancel.type = 'button';
    cancel.autofocus = true;
    const confirm = node('button', 'primary-button', () =>
      current.remote ? tr('ui.executer_sur_le_pc') : tr('ui.executer'),
    );
    confirm.type = 'button';
    actions.append(cancel, confirm);
    dialog.append(heading, fileName, filePath, warning, feedback, actions);
    dialog.addEventListener('close', () => dialog.remove());
    cancel.onclick = () => dialog.close();
    confirm.onclick = async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      feedback.hidden = false;
      bindText(feedback, () => tr('ui.execution_sur_le_pc'));
      try {
        await api('/api/project-files/run', { method: 'POST', body: { cwd, path: file.path } });
        dialog.close();
        const done =
          controls.querySelector('.inspector-open-feedback') ||
          node('span', 'inspector-note inspector-open-feedback');
        done.setAttribute('role', 'status');
        bindText(done, () => tr('ui.execution_demandee_sur_le_pc'));
        controls.append(done);
      } catch (error) {
        bindText(feedback, () => translateKnown(error.message));
        confirm.disabled = false;
        cancel.disabled = false;
        cancel.focus();
      }
    };
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  }
  async function openFile(file, mode, explicitCwd) {
    const viewCwd = explicitCwd || filesCwd();
    beginView(file.path);
    const token = viewVersion;
    if (file.status) {
      for (const [value, label] of [
        ['diff', tr('ui.modifications')],
        ['preview', tr('files.content')],
      ]) {
        if (value === 'preview' && file.deleted) continue;
        const button = node('button', '', () => translateKnown(label));
        button.type = 'button';
        button.setAttribute('aria-pressed', String(value === mode));
        button.onclick = () => openFile(file, value, explicitCwd);
        controls.append(button);
      }
    }
    if (!file.deleted && !current.readOnly && current.nativeFileOpen) {
      const cwd = viewCwd;
      // Folders have no file content: the file endpoint would only refuse
      // them, so directories keep the folder reveal action exclusively.
      if (!file.directory) {
        const open = node('button', 'inspector-open', () =>
          current.remote ? tr('ui.ouvrir_sur_le_pc') : tr('ui.ouvrir'),
        );
        open.type = 'button';
        bindAttribute(open, 'title', () => tr('ui.ouvrir_dans_l_application_du_pc'));
        open.onclick = async () => {
          open.disabled = true;
          const feedback =
            controls.querySelector('.inspector-open-feedback') ||
            node('span', 'inspector-note inspector-open-feedback');
          feedback.setAttribute('role', 'status');
          bindText(feedback, () => tr('ui.ouverture_sur_le_pc'));
          controls.append(feedback);
          try {
            await api('/api/project-files/open', { method: 'POST', body: { cwd, path: file.path } });
            bindText(feedback, () => tr('ui.ouverture_demandee_sur_le_pc'));
          } catch (error) {
            bindText(feedback, () => translateKnown(error.message));
          } finally {
            open.disabled = false;
          }
        };
        controls.append(open);
        if (isRunnableScriptPath(file.path)) {
          const run = node('button', 'inspector-run', () =>
            current.remote ? tr('ui.executer_sur_le_pc') : tr('ui.executer'),
          );
          run.type = 'button';
          bindAttribute(run, 'title', () => tr('ui.executer_dans_une_console_du_pc'));
          run.onclick = () => confirmScriptRun(file, cwd);
          controls.append(run);
        }
      }
      const folder = node('button', 'inspector-open-folder', () =>
        current.remote ? tr('ui.ouvrir_le_dossier_sur_le_pc') : tr('ui.ouvrir_le_dossier'),
      );
      folder.type = 'button';
      folder.onclick = async () => {
        folder.disabled = true;
        const feedback =
          controls.querySelector('.inspector-open-feedback') ||
          node('span', 'inspector-note inspector-open-feedback');
        feedback.setAttribute('role', 'status');
        bindText(feedback, () => tr('ui.ouverture_sur_le_pc'));
        controls.append(feedback);
        try {
          await api('/api/projects/open', {
            method: 'POST',
            body: { cwd, path: file.directory ? file.path : parentFolder(file.path) },
          });
          bindText(feedback, () => tr('ui.ouverture_demandee_sur_le_pc'));
        } catch (error) {
          bindText(feedback, () => translateKnown(error.message));
        } finally {
          folder.disabled = false;
        }
      };
      controls.append(folder);
    }
    if (file.directory) {
      empty(body, () => file.path);
      return;
    }
    try {
      const data = await request(
        'viewer',
        explicitCwd ? filesUrlFor(explicitCwd, mode, { path: file.path }) : filesUrl(mode, { path: file.path }),
      );
      if (token !== viewVersion) return;
      body.replaceChildren();
      if (data.image) {
        const image = node('img', 'inspector-preview-image');
        image.src = data.image;
        bindAttribute(image, 'alt', () => file.path);
        body.append(image);
      } else if (typeof data.text === 'string' && data.text) {
        if (mode !== 'diff') {
          renderFileText(file, data.text, viewCwd);
          return;
        }
        const pre = node('pre', mode === 'diff' ? 'inspector-diff' : 'inspector-code');
        if (mode === 'diff') {
          appendPatchLines(pre, data.text);
          body.append(
            node('p', 'inspector-note', () =>
              tr('ui.etat_actuel_compare_au_dernier_commit_head_index_et_fichiers_de_t'),
            ),
          );
        } else bindText(pre, () => data.text);
        body.append(pre);
      } else empty(body, () => data.message || tr('ui.fichier_vide'));
    } catch (error) {
      if (error.name !== 'AbortError' && token === viewVersion) empty(body, translateKnown(error.message));
    }
  }
  function allowsOutsidePreview() {
    try {
      if (current.readOnly) return false;
      return getAllowOutsidePreview() === true;
    } catch {
      return false;
    }
  }
  function renderOutsideBadge(absolutePath) {
    const badge = node('span', 'inspector-note inspector-outside-badge', () =>
      tr('files.outside_project'),
    );
    badge.setAttribute('data-outside', 'true');
    controls.append(badge);
    if (absolutePath) {
      const pathNote = node('span', 'inspector-note inspector-outside-path', () => String(absolutePath));
      pathNote.setAttribute('data-outside-path', 'true');
      bindAttribute(pathNote, 'title', () => String(absolutePath));
      controls.append(pathNote);
    }
  }
  async function openExternalDocument(reference, { cwd, basePath = '' } = {}) {
    const docCwd = cwd || current.cwd;
    const token = viewVersion;
    try {
      const data = await request(
        'viewer',
        `/api/file-previews/external?${queryFor(docCwd, { reference, basePath })}`,
      );
      if (token !== viewVersion) return;
      const absolutePath = typeof data?.absolutePath === 'string' && data.absolutePath
        ? data.absolutePath
        : typeof data?.path === 'string' && data.path
          ? data.path
          : String(reference);
      beginView(String(absolutePath).split(/[\\/]/).at(-1) || String(reference).split(/[\\/]/).at(-1));
      renderOutsideBadge(absolutePath);
      if (data?.image) {
        const image = node('img', 'inspector-preview-image');
        image.src = data.image;
        bindAttribute(image, 'alt', () => absolutePath);
        body.append(image);
        return;
      }
      if (typeof data?.text === 'string' && data.text) {
        renderFileText({ path: typeof data?.path === 'string' && data.path ? data.path : absolutePath }, data.text);
        return;
      }
      empty(body, () => data?.message || tr('ui.fichier_vide'));
    } catch (error) {
      if (error.name !== 'AbortError' && token === viewVersion)
        empty(body, translateKnown(error.message));
    }
  }
  async function openDocument(reference, { cwd, basePath = '' } = {}) {
    const docCwd = cwd || current.cwd;
    if (!docCwd) return;
    beginView(reference.split(/[\\/]/).at(-1));
    try {
      const result = await request('viewer', filesUrlFor(docCwd, 'resolve', { reference, basePath }));
      if (result.path || result.directory) {
        await openFile(
          { path: result.path, ...(result.directory ? { directory: true } : {}) },
          'preview',
          docCwd,
        );
        return;
      }
      empty(body, () => tr('ui.plusieurs_documents_portent_ce_nom_choisissez_le_fichier_a_consul'));
      for (const match of result.matches || []) {
        const button = node('button', 'inspector-file', () => match.path);
        button.type = 'button';
        button.onclick = () => openFile(match, 'preview', docCwd);
        body.append(button);
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      // Outside-project references resolve with 403: on explicit click, open
      // the read-only external preview when the global preference allows it
      // (never in read-only). Blocked/private paths stay on the project error.
      if (shouldAttemptExternalPreview(error, { readOnly: current.readOnly, allowOutside: getAllowOutsidePreview() })) {
        await openExternalDocument(reference, { cwd: docCwd, basePath });
        return;
      }
      empty(body, translateKnown(error.message));
    }
  }
  // Same reading model as the main conversation: messages stay visible, and
  // the tool calls and reasoning between two messages fold into one
  // "Agent activity" block. Block bodies build only when opened.
  function agentToolBlock(tool, messageId) {
    if (typeof renderTool === 'function') return renderTool(tool, messageId);
    const details = node('details', 'inspector-tool');
    details.append(
      node(
        'summary',
        '',
        () =>
          `${tool.name || tr('common.tool')} · ${tool.status === 'done' ? tr('ui.termine') : tool.status === 'error' ? tr('common.error') : tr('ui.appel_enregistre')}`,
      ),
    );
    details.append(
      node('pre', 'inspector-code', () =>
        typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.args || {}, null, 2),
      ),
    );
    return details;
  }
  function agentActivity(messages) {
    const tools = messages.flatMap((m) => m.tools || []);
    const reasoning = messages.filter((m) => m.thinking?.trim()).length;
    const errors = tools.filter((t) => t.isError || t.status === 'error').length;
    const block = node('details', 'activity-stack inspector-activity');
    block.classList.toggle('has-errors', errors > 0);
    const summary = node('summary');
    const symbol = node('span', 'activity-symbol');
    symbol.dataset.state = errors ? 'error' : 'done';
    if (typeof icon === 'function') symbol.append(icon(errors ? 'alert' : 'terminal'));
    const titles = node('span', 'activity-titles');
    titles.append(
      node('span', 'activity-label', () => tr('ui.activite_de_l_agent')),
      node('span', 'activity-count', () =>
        [
          tools.length ? tr('count.tools', { count: tools.length }) : '',
          reasoning ? tr('count.reflections', { count: reasoning }) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    );
    summary.append(
      symbol,
      titles,
      node('span', 'activity-state', () => (errors ? tr('count.errors', { count: errors }) : tr('ui.termine'))),
    );
    if (typeof icon === 'function') summary.append(icon('chevron', 'activity-chevron'));
    const content = node('div', 'activity-content');
    block.append(summary, content);
    block.addEventListener('toggle', () => {
      if (!block.open || content.childElementCount) return;
      for (const m of messages) {
        const step = node('div', 'activity-step');
        if (m.thinking?.trim()) {
          const thinking = node('details', 'thinking-block');
          const label = node('summary');
          if (typeof icon === 'function') label.append(icon('brain'));
          label.append(node('span', '', () => tr('ui.raisonnement')));
          if (typeof icon === 'function') label.append(icon('chevron', 'chevron'));
          const text = node('div', 'thinking-content reasoning-markdown');
          text.append(markdown(m.thinking));
          thinking.append(label, text);
          step.append(thinking);
        }
        for (const tool of m.tools || []) step.append(agentToolBlock(tool, m.id));
        if (step.childElementCount) content.append(step);
      }
    });
    return block;
  }
  function renderAgentHistory(messages) {
    let activity = [];
    const flush = () => {
      if (activity.length) body.append(agentActivity(activity));
      activity = [];
    };
    for (const message of messages) {
      const work = message.role === 'assistant' && (message.tools?.length || message.thinking?.trim());
      const error = translateKnown(message.error);
      if (!message.text && !error) {
        if (work) activity.push(message);
        continue;
      }
      flush();
      const article = node('article', `inspector-message is-${message.role}`);
      article.append(
        node('strong', '', () =>
          message.role === 'user'
            ? tr('agents.instruction')
            : message.role === 'assistant'
              ? tr('ui.agent')
              : tr('ui.contexte'),
        ),
      );
      if (message.text) article.append(markdown(message.text));
      if (error) article.append(node('div', 'message-error', () => error));
      body.append(article);
      if (work) activity.push(message);
    }
    flush();
  }
  async function openAgent(agent) {
    beginView(agent.name);
    controls.append(statusNode(agent.status));
    if (agent.model) controls.append(node('span', 'inspector-note', () => agent.model));
    controls.append(
      node('span', 'inspector-note', () => tr('ui.reflexion_2', { value1: thinkingLabel(agent.thinking) })),
    );
    if (!agent.history) {
      empty(
        body,
        () => agent.preview || tr('ui.la_conversation_sera_disponible_des_son_enregistrement_par_prime'),
      );
      return;
    }
    const refresh = node('button', '', () => tr('ui.actualiser'));
    refresh.type = 'button';
    refresh.onclick = () => openAgent(agentData?.agents.find((row) => row.id === agent.id) || agent);
    controls.append(refresh);
    try {
      const data = await request(
        'viewer',
        `/api/inspector/history?${query({ sessionId: current.sessionId, agentId: agent.id })}`,
      );
      body.replaceChildren();
      if (data.truncated)
        body.append(node('p', 'inspector-note', () => tr('ui.les_150_derniers_messages_sont_affiches')));
      renderAgentHistory(data.messages);
      if (!body.querySelector('.inspector-message, .inspector-activity')) {
        empty(body, () => tr('ui.aucun_message_enregistre_pour_le_moment'));
        return;
      }
      // Like a chat: open on the latest messages. Once more after layout
      // (markdown images, fonts) so the view really lands at the end.
      const toEnd = () => {
        body.scrollTop = body.scrollHeight;
      };
      toEnd();
      requestAnimationFrame(toEnd);
    } catch (error) {
      if (error.name !== 'AbortError') empty(body, translateKnown(error.message));
    }
  }
  viewer.onclose = () => {
    cancel('viewer');
    viewVersion++;
    opener?.focus({ preventScroll: true });
  };
  viewer.addEventListener('cancel', (event) => event.stopPropagation());

  function applyUnitAria() {
    for (const key of INSPECTOR_UNIT_IDS) {
      if (!owns(key)) continue;
      const node = unitNode(key);
      if (!node) continue;
      const props = inspectorUnitAria(key, !!docked);
      if (props.role) node.setAttribute('role', props.role);
      else node.removeAttribute('role');
      if (props.labelledby) node.setAttribute('aria-labelledby', props.labelledby);
      else node.removeAttribute('aria-labelledby');
    }
  }

  /** Live unit roots for docking registration. Docking owns move/restore. */
  function roots() {
    // No wrapper: parent registers the actual live unit roots directly.
    if (isSingle) return { [unit]: unitNode(unit) };
    return { session: unitNode('session'), agents: unitNode('agents'), files: unitNode('files') };
  }

  /**
   * Dock wiring (§6): active toggles dock mode, visiblePanels lists dock-visible
   * unit ids, showPanel reveals one unit (dock openPanel or classic setTab).
   * Classic/mobile (active falsy) restores original roles/labels; fetching
   * re-gates on the next update() immediately.
   */
  function setDocked(active, visiblePanels, showPanel) {
    // visiblePanels: array/Set (legacy) or boolean (single-unit shorthand).
    const visible =
      visiblePanels instanceof Set
        ? new Set(visiblePanels)
        : Array.isArray(visiblePanels)
          ? new Set(visiblePanels)
          : visiblePanels;
    docked = active ? { visible, show: showPanel } : null;
    applyUnitAria();
    update();
  }

  function update() {
    current = getContext();
    if (owns('files')) syncProjectFolderButton();
    syncMobilePanel();
    const key = `${current.cwd || ''}\0${current.sessionId || ''}`;
    if (key !== contextKey) {
      generation++;
      contextKey = key;
      for (const key of [...pending.keys()]) cancel(key);
      agentsAt = filesAt = 0;
      agentData = fileData = null;
      gitData = null;
      gitAt = 0;
      gitAction = null;
      lastAgents = '';
      directory = '';
      filesCwdOverride = null;
      // Orphan any in-flight suggest: its generation guard already blocks
      // writes, and the turn bump stops it releasing a newer turn's UI.
      // Restore the button text too, or the next turn would snapshot '…'
      // as its previous label and restore it forever.
      suggestBusy = false;
      suggestTurn++;
      if ($('git-suggest-button')) $('git-suggest-button').textContent = tr('git.panel_suggest');
      historyState = {
        commits: [],
        hasMore: false,
        ref: 'HEAD',
        offset: 0,
        loading: false,
        error: '',
        selected: '',
        search: historyState.search,
        tagsOnly: historyState.tagsOnly,
      };
      historyDetail = { hash: '', commit: null, loading: false, error: '' };
      worktreeState = { list: [], currentPath: '', loading: false, error: '', loadedFor: '' };
        if (owns('files')) {
        closeFileMenu();
        closeGitMenu();
      }
      if (owns('files')) {
        if ($('inspector-git-bar')) $('inspector-git-bar').hidden = true;
        if ($('inspector-git-commit')) $('inspector-git-commit').hidden = true;
      }
      if (viewer.open) viewer.close();
      if (owns('agents')) {
        const agentCount = $('inspector-agent-count');
        if (agentCount) agentCount.hidden = true;
        const agentNote = $('inspector-agent-note');
        if (agentNote) bindText(agentNote, () => '');
        const agentSummary = $('inspector-agent-summary');
        if (agentSummary)
          bindText(agentSummary, () =>
            current.sessionId ? tr('ui.delegations_de_la_session') : tr('ui.prochaines_delegations'),
          );
        const agentList = $('inspector-agent-list');
        if (agentList)
          empty(agentList, () =>
            current.sessionId
              ? tr('ui.chargement_des_agents')
              : current.cwd
                ? tr('ui.les_agents_apparaitront_apres_le_premier_message')
                : tr('ui.choisissez_un_projet_pour_preparer_ses_sous_agents'),
          );
      }
      if (owns('session')) {
        const usage = $('inspector-usage');
        if (usage) usage.hidden = true;
      }
      if (owns('files')) {
        const fileNote = $('inspector-file-note');
        if (fileNote) bindText(fileNote, () => '');
        const crumb = $('inspector-file-breadcrumb');
        if (crumb) crumb.replaceChildren();
        const fileList = $('inspector-file-list');
        if (fileList)
          empty(fileList, () =>
            current.cwd
              ? tr('ui.chargement_des_fichiers')
              : tr('ui.choisissez_un_projet_pour_parcourir_ses_fichiers'),
          );
      }
    }
    syncDetailStatus();
    if (!isSingle) {
      const tabAgents = $('inspector-tab-agents'),
        tabFiles = $('inspector-tab-files');
      if (tabAgents) tabAgents.disabled = !current.enabled;
      if (tabFiles) tabFiles.disabled = !current.enabled;
    }
    const plan = inspectorFetchPlan({
      session: unitVisible('session'),
      agents: unitVisible('agents'),
      files: unitVisible('files'),
    });
    if (owns('agents')) subagentSettings?.update({ ...current, active: unitVisible('agents') && !document.hidden });
    // Session quota depends on the selected main model even without an open session.
    // Refresh it on model/cwd change; context needs live agent data.
    if (owns('session')) {
      try {
        ensureSessionExtras();
        // Deferred async fetch; requestQuota dispatches only for a visible
        // session unit and advances the probe key solely on dispatch.
        requestQuota();
        if (!current.enabled) {
          if (quotaSection) quotaSection.hidden = true;
          if (contextSection) contextSection.hidden = true;
        }
        renderContext();
      } catch {}
    }
    if (!current.enabled) {
      if (owns('files')) {
        if ($('inspector-git-bar')) $('inspector-git-bar').hidden = true;
        if ($('inspector-git-commit')) $('inspector-git-commit').hidden = true;
      }
      return;
    }
    if (!plan.any || document.hidden || !current.online) return;
    if (plan.files) {
      if ((filesView === 'changes' || filesView === 'browse') && (fileMode === 'changes' || !fileData))
        void loadFiles();
      syncFilesView();
      syncGitBar();
      syncCommitBox();
      void loadGit();
      // Keep the Files-context row fresh without polling history pages.
      if (gitData?.git && worktreeState.loadedFor !== filesCwd() && !worktreeState.loading)
        void loadWorktrees();
    }
    if (plan.agents) void loadAgents();
  }
  const timer = setInterval(update, 2500);
  document.addEventListener('visibilitychange', update);
  window.addEventListener('resize', update);
  return {
    instanceId: instance,
    unit: owned,
    update,
    setTab,
    roots,
    setDocked,
    openDocument,
    openAgent,
    async openAgentById(id) {
      if (owns('agents') && docked) docked.show?.('agents');
      update();
      const expectedContext = contextKey;
      const expectedGeneration = generation;
      const data = await api(`/api/inspector?${query({ sessionId: current.sessionId })}`);
      if (expectedContext !== contextKey || expectedGeneration !== generation) return;
      const agent = data.agents.find((entry) => entry.id === id);
      if (!agent) throw new Error(tr('ui.la_conversation_sera_disponible_des_son_enregistrement_par_prime'));
      await openAgent(agent);
    },
    destroy() {
      clearInterval(timer);
      try {
        clearInterval(quotaTimer);
      } catch {}
      for (const key of [...pending.keys()]) cancel(key);
      try {
        stopGitLanguage?.();
      } catch {}
      try {
        subagentSettings?.destroy?.();
      } catch {}
      if (viewer.open) {
        try {
          viewer.close();
        } catch {}
      }
      viewer.remove();
      document.removeEventListener('click', closeGitMenuOnPointer);
      document.removeEventListener('keydown', closeGitMenuOnKey, true);
      gitMenu.remove();
      gitDialog.remove();
      document.removeEventListener('click', closeFileMenuOnPointer);
      document.removeEventListener('scroll', closeFileMenuOnScroll, true);
      document.removeEventListener('keydown', closeFileMenuOnKey, true);
      window.removeEventListener('resize', closeFileMenuOnScroll);
      window.visualViewport?.removeEventListener('resize', closeFileMenuOnScroll);
      window.visualViewport?.removeEventListener('scroll', closeFileMenuOnScroll);
      fileMenu.remove();
      try {
        quotaSection?.remove?.();
      } catch {}
      try {
        contextSection?.remove?.();
      } catch {}
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('resize', update);
      if (panel) {
        try {
          for (const [element, value] of previousInert) element.inert = value;
          previousInert.clear();
        } catch {}
      }
    },
  };
}
