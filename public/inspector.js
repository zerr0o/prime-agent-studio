import { t as tr, bindText, bindAttribute, translateKnown, getLanguage, onLanguageChange } from './i18n.js';
import { filePresentation, defaultFileView, parentFolder } from './file-presentation.js';
import { placeViewportMenu } from './file-links.js';
import { thinkingLabel } from './reasoning.js';
import { createSubagentSettings } from './subagent-settings.js';

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
const count = (number) =>
  new Intl.NumberFormat('fr-FR', {
    notation: number >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(number);
const statusNode = (status) =>
  node('span', `inspector-status is-${status}`, () => labels[status] || labels.unknown);

export function createInspector({
  api,
  getContext,
  markdown,
  onClose,
  getModels,
  openModelPicker,
  icon,
  toast,
}) {
  let tab = 'session',
    fileMode = 'changes',
    directory = '',
    contextKey = '',
    generation = 0;
  // Dock split state. Null = classic/mobile singleton (unchanged behavior).
  // Docked = { visible: Set<unitId>, show: (id) => bool }. #details-panel stays
  // the classic home; docking owns every move/restore, so no markers here.
  let docked = null;
  let current = {},
    agentData = null,
    fileData = null,
    agentsAt = 0,
    filesAt = 0,
    lastAgents = '',
    gitData = null,
    gitAt = 0,
    gitAction = null,
    suggestBusy = false;
  const pending = new Map();
  const panel = $('details-panel');
  const subagentSettings = createSubagentSettings({
    api,
    root: $('project-subagent-settings'),
    getModels,
    openModelPicker,
    icon,
    toast,
    project: true,
  });
  let mobileModal = false;
  const background = [...document.querySelectorAll('#sidebar, .workspace-header, .conversation-column')];
  const previousInert = new Map();
  function syncMobilePanel() {
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
  viewer.id = 'inspector-viewer';
  viewer.setAttribute('aria-labelledby', 'inspector-view-title');
  const header = node('div', 'inspector-view-header'),
    title = node('h2');
  title.id = 'inspector-view-title';
  const close = node('button', 'secondary-button', () => tr('ui.fermer'));
  close.type = 'button';
  close.onclick = () => viewer.close();
  const controls = node('div', 'inspector-view-controls'),
    body = node('div', 'inspector-view-body');
  body.id = 'inspector-view-body';
  header.append(title, close);
  viewer.append(header, controls, body);
  document.body.append(viewer);
  let viewVersion = 0,
    opener;
  const visible = () => !panel.hidden && (innerWidth > 1080 || panel.classList.contains('mobile-open'));
  const unitNode = (key) => document.getElementById(`inspector-${key}`);
  function unitVisible(key) {
    const node = unitNode(key);
    if (!node || !node.isConnected) return false;
    if (docked) return docked.visible.has(key) && node.getClientRects().length > 0;
    return visible() && tab === key;
  }
  const query = (values) => new URLSearchParams({ cwd: current.cwd, ...values }).toString();
  const filesUrl = (action, values = {}) =>
    `/api/project-files${action ? '/' + action : ''}?${query(values)}`;
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
  function showUsage() {
    const usage = agentData?.session?.usage;
    const section = $('inspector-usage');
    section.hidden = !usage;
    if (!usage) return;
    section.replaceChildren(node('div', 'context-label', () => tr('ui.consommation_de_la_session')));
    const dl = node('dl', 'session-properties');
    for (const [name, value] of [
      [tr('ui.tokens_entrants'), usage.input],
      [tr('ui.tokens_sortants'), usage.output],
      [tr('ui.tokens_en_cache'), usage.cache],
    ]) {
      const row = node('div');
      row.append(
        node('dt', '', () => name),
        node('dd', '', () => count(value)),
      );
      dl.append(row);
    }
    if (usage.cost !== null) {
      const row = node('div');
      row.append(
        node('dt', '', () => tr('ui.cout_estime')),
        node('dd', '', () =>
          new Intl.NumberFormat('fr-FR', {
            style: 'currency',
            currency: 'USD',
            maximumFractionDigits: 4,
          }).format(usage.cost),
        ),
      );
      dl.append(row);
    }
    section.append(
      dl,
      node('p', 'inspector-note', () =>
        tr('ui.donnees_du_moteur_pour_cet_agent_le_cout_indique_ne_represente_pa'),
      ),
    );
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
  setInterval(() => {
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
    if (quotaSection && contextSection) return;
    const host = $('inspector-session');
    const sessionBlock = $('detail-status')?.closest('.context-section');
    quotaSection = document.createElement('section');
    quotaSection.id = 'inspector-quota';
    quotaSection.className = 'context-section';
    quotaSection.hidden = true;
    contextSection = document.createElement('section');
    contextSection.id = 'inspector-context';
    contextSection.className = 'context-section';
    contextSection.hidden = true;
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
    ensureSessionExtras();
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
    ensureSessionExtras();
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
  function renderAgents() {
    const data = agentData,
      list = $('inspector-agent-list');
    if (!data?.session) {
      empty(list, () => tr('ui.ouvrez_une_session_pour_retrouver_son_agent_et_ses_delegations'));
      return;
    }
    const total = data.agents.filter((agent) => !agent.root).length;
    bindText($('inspector-agent-count'), () => total);
    $('inspector-agent-count').hidden = !total;
    const running = data.agents.filter((agent) => busy.has(agent.status)).length;
    bindText($('inspector-agent-summary'), () =>
      tr('count.subagents', {
        count: total,
        activity: running ? tr('ui.en_activite', { value1: running }) : '',
      }),
    );
    bindText(
      $('inspector-agent-note'),
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
      if (agentData.session) $('detail-status').replaceChildren(statusNode(agentData.session.status));
    } catch (error) {
      if (error.name !== 'AbortError')
        bindText($('inspector-agent-note'), () => translateKnown(error.message));
    }
  }
  function setTab(value, focus = false) {
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
  for (const key of ['session', 'agents', 'files']) {
    const button = $(`inspector-tab-${key}`);
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
  $('close-inspector').onclick = onClose;
  $('refresh-agents').onclick = () => {
    void loadAgents(true);
    if (current.cwd) void subagentSettings.open();
  };

  function renderFiles(append = false) {
    closeFileMenu();
    const list = $('inspector-file-list'),
      crumb = $('inspector-file-breadcrumb');
    const focusedPath = document.activeElement?.closest('[data-file-path]')?.dataset.filePath;
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
        const code = file.untracked ? '+' : file.deleted ? '−' : file.status.includes('R') ? 'R' : 'M';
        row.append(
          node(
            'span',
            `inspector-file-status ${file.deleted ? 'is-deleted' : file.untracked ? 'is-added' : ''}`,
            () => code,
          ),
          node('span', 'inspector-file-path', () => file.path),
        );
        bindAttribute(row, 'title', () =>
          [
            file.previousPath ? `${file.previousPath} → ${file.path}` : file.path,
            file.staged ? tr('ui.contient_des_modifications_indexees') : tr('ui.non_indexe'),
          ].join(' · '),
        );
        row.onclick = () => openFile(file, defaultFileView(file));
        attachFileMenu(row, file);
        if (gitData?.git && !current.readOnly) {
          const wrap = node('div', 'inspector-file-row');
          const check = document.createElement('input');
          check.type = 'checkbox';
          check.className = 'git-file-check';
          check.checked = true;
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
    if (!current.enabled || !current.cwd || pending.has('files') || (!force && Date.now() - filesAt < 6000))
      return;
    filesAt = Date.now();
    if (!fileData) bindText($('inspector-file-note'), () => tr('ui.chargement_des_fichiers'));
    const mode = fileMode;
    try {
      fileData = await request(
        'files',
        mode === 'changes' ? filesUrl('changes') : filesUrl('', { path: directory, offset }),
      );
      renderFiles(offset > 0);
    } catch (error) {
      if (error.name !== 'AbortError') {
        bindText($('inspector-file-note'), () => translateKnown(error.message));
        if (!fileData) empty($('inspector-file-list'), () => tr('ui.reessayez_avec_le_bouton_actualiser'));
      }
    }
  }
  function browse(path) {
    cancel('files');
    directory = path;
    fileData = null;
    fileMode = 'all';
    syncGitBar();
    syncCommitBox();
    void loadFiles(true);
  }
  function changeFiles(mode) {
    cancel('files');
    fileMode = mode;
    fileData = null;
    filesAt = 0;
    $('files-changes').setAttribute('aria-pressed', String(mode === 'changes'));
    $('files-all').setAttribute('aria-pressed', String(mode === 'all'));
    $('inspector-file-list').replaceChildren();
    syncGitBar();
    syncCommitBox();
    void loadFiles(true);
    void loadGit();
  }
  $('files-changes').onclick = () => changeFiles('changes');
  $('files-all').onclick = () => changeFiles('all');
  $('refresh-files').onclick = () => {
    void loadFiles(true);
    void loadGit(true);
  };
  // Git controls in the Files tab: branch switcher, fetch/pull/push and commit.
  const gitBusy = () => Boolean(agentData?.session && busy.has(agentData.session.status));
  const gitShortHead = () =>
    typeof gitData?.head === 'string' && gitData.head ? gitData.head.slice(0, 7) : '';
  function gitSelectedPaths() {
    return [...document.querySelectorAll('#inspector-file-list .git-file-check')]
      .filter((box) => box.checked)
      .map((box) => box.dataset.gitPath)
      .filter(Boolean);
  }
  function syncGitBar() {
    const bar = $('inspector-git-bar');
    if (!bar) return;
    const show = Boolean(current.cwd && gitData?.git);
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
    for (const id of ['git-fetch-button', 'git-pull-button', 'git-push-button']) $(id).hidden = readOnly;
    if (readOnly) return;
    const branchButton = $('git-branch-button');
    branchButton.disabled = inFlight || runBusy;
    branchButton.setAttribute('title', runBusy ? tr('git.align_busy') : tr('git.panel_branches'));
    const fetchButton = $('git-fetch-button');
    fetchButton.disabled = inFlight || noRemote || !current.online;
    fetchButton.setAttribute('title', noRemote ? tr('git.panel_no_remote') : tr('git.panel_fetch'));
    const pullButton = $('git-pull-button');
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
    const box = $('inspector-git-commit');
    if (!box) return;
    const show = Boolean(
      current.cwd && !current.readOnly && fileMode === 'changes' && gitData?.git && fileData?.git,
    );
    box.hidden = !show;
    if (!show) return;
    const message = $('git-commit-message').value.trim(),
      selected = gitSelectedPaths(),
      button = $('git-commit-button'),
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
    }
  }
  async function loadGit(force = false) {
    if (!current.enabled || !current.cwd) {
      syncGitBar();
      return;
    }
    if (pending.has('git') || (!force && Date.now() - gitAt < 60000)) {
      syncGitBar();
      return;
    }
    gitAt = Date.now();
    try {
      gitData = await request('git', `/api/project-git?${query()}`);
    } catch (error) {
      if (error.name === 'AbortError') return;
      gitData = null;
    }
    syncGitBar();
    syncCommitBox();
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
    if (!current.cwd || gitAction) return;
    const cwd = current.cwd,
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
      gitAction = null;
      if (generation === token) {
        syncGitBar();
        syncCommitBox();
      }
    }
  }
  async function gitSuggest() {
    const field = $('git-commit-message');
    const paths = gitSelectedPaths();
    if (!paths.length) {
      toast(() => tr('git.panel_no_selection'), true);
      return;
    }
    if (!current.cwd || gitAction || suggestBusy) return;
    const cwd = current.cwd,
      token = generation;
    suggestBusy = true;
    syncCommitBox();
    const suggestButton = $('git-suggest-button');
    const previousLabel = suggestButton ? suggestButton.textContent : '';
    if (suggestButton) suggestButton.textContent = '…';
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
      suggestBusy = false;
      if (suggestButton) suggestButton.textContent = previousLabel;
      if (generation === token) syncCommitBox();
    }
  }
  async function gitCommit() {
    const field = $('git-commit-message'),
      message = field.value.trim();
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
    if (!current.cwd || gitAction) return;
    const cwd = current.cwd,
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
      gitAction = null;
      if (generation === token) {
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
  gitDialog.id = 'git-branch-dialog';
  gitDialog.className = 'modal compact';
  const gitDialogTitle = node('h2', '', () => tr('git.panel_create_title')),
    gitDialogLabel = node('label', '', () => tr('git.panel_branch_name'));
  const gitDialogInput = document.createElement('input');
  gitDialogInput.type = 'text';
  gitDialogInput.autocomplete = 'off';
  gitDialogInput.maxLength = 200;
  gitDialogInput.id = 'git-branch-name';
  gitDialogLabel.setAttribute('for', 'git-branch-name');
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
  $('git-branch-button').onclick = (event) => {
    if (event.currentTarget.disabled) return;
    if (gitMenu.hidden) openGitMenu(event.currentTarget);
    else closeGitMenu();
  };
  $('git-fetch-button').onclick = (event) => {
    if (event.currentTarget.disabled) return;
    void gitRun('fetch', {}, 'git.panel_fetched', null, false);
  };
  $('git-pull-button').onclick = (event) => {
    if (event.currentTarget.disabled) return;
    void gitRun('pull', {}, 'git.panel_pulled');
  };
  $('git-push-button').onclick = (event) => {
    if (event.currentTarget.disabled) return;
    void gitRun('push', {}, 'git.panel_pushed', null, false);
  };
  $('git-commit-message').oninput = () => syncCommitBox();
  // Ctrl+Enter commits from the multi-line message; Enter adds a line.
  $('git-commit-message').onkeydown = (event) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (!$('git-commit-button').disabled) void gitCommit();
  };
  $('git-commit-button').onclick = (event) => {
    if (event.currentTarget.disabled) return;
    void gitCommit();
  };
  const suggestButton = $('git-suggest-button');
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
  const openProjectFolder = $('open-project-folder');
  function syncProjectFolderButton() {
    bindText($('open-project-folder-label'), () =>
      current.remote ? tr('ui.ouvrir_le_dossier_sur_le_pc') : tr('ui.ouvrir_le_dossier'),
    );
    openProjectFolder.hidden = !current.enabled || current.readOnly || !current.nativeFileOpen;
    openProjectFolder.disabled =
      openProjectFolder.hidden || !current.cwd || !current.online || openingProjectFolder;
  }
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
          else openFile(target, defaultFileView(target));
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
              body: { cwd: current.cwd, path: target.directory ? target.path : parentFolder(target.path) },
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
            const separator = current.cwd.includes('\\') ? '\\' : '/';
            const path =
              current.cwd.replace(/[\\/]$/, '') + separator + target.path.replaceAll('/', separator);
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
  function renderFileText(file, text) {
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
        const document = markdown(text, { cwd: current.cwd, basePath: file.path });
        document.classList.add('inspector-document');
        body.append(document);
      } else {
        const pre = node('pre', 'inspector-code inspector-file-source', () =>
          source ? text : presentation.text,
        );
        pre.tabIndex = 0;
        bindAttribute(pre, 'aria-label', () =>
          source ? tr('ui.source_du_fichier') : tr('ui.contenu_du_fichier'),
        );
        body.append(pre);
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
  async function openFile(file, mode) {
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
        button.onclick = () => openFile(file, value);
        controls.append(button);
      }
    }
    if (!file.deleted && !current.readOnly && current.nativeFileOpen) {
      const cwd = current.cwd;
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
      const data = await request('viewer', filesUrl(mode, { path: file.path }));
      if (token !== viewVersion) return;
      body.replaceChildren();
      if (data.image) {
        const image = node('img', 'inspector-preview-image');
        image.src = data.image;
        bindAttribute(image, 'alt', () => file.path);
        body.append(image);
      } else if (typeof data.text === 'string' && data.text) {
        if (mode !== 'diff') {
          renderFileText(file, data.text);
          return;
        }
        const pre = node('pre', mode === 'diff' ? 'inspector-diff' : 'inspector-code');
        if (mode === 'diff') {
          for (const line of data.text.split('\n'))
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
  async function openDocument(reference, { cwd, basePath = '' } = {}) {
    update();
    if (cwd !== current.cwd) return;
    beginView(reference.split(/[\\/]/).at(-1));
    try {
      const result = await request('viewer', filesUrl('resolve', { reference, basePath }));
      if (result.path || result.directory) {
        await openFile({ path: result.path, ...(result.directory ? { directory: true } : {}) }, 'preview');
        return;
      }
      empty(body, () => tr('ui.plusieurs_documents_portent_ce_nom_choisissez_le_fichier_a_consul'));
      for (const match of result.matches || []) {
        const button = node('button', 'inspector-file', () => match.path);
        button.type = 'button';
        button.onclick = () => openFile(match, 'preview');
        body.append(button);
      }
    } catch (error) {
      if (error.name !== 'AbortError') empty(body, translateKnown(error.message));
    }
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
      for (const message of data.messages) {
        if (!message.text && !message.tools?.length) continue;
        const article = node('article', 'inspector-message');
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
        for (const tool of message.tools || []) {
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
          article.append(details);
        }
        body.append(article);
      }
      if (!body.childElementCount) empty(body, () => tr('ui.aucun_message_enregistre_pour_le_moment'));
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
    return { session: unitNode('session'), agents: unitNode('agents'), files: unitNode('files') };
  }

  /**
   * Dock wiring (§6): active toggles dock mode, visiblePanels lists dock-visible
   * unit ids, showPanel reveals one unit (dock openPanel or classic setTab).
   * Classic/mobile (active falsy) restores original roles/labels; fetching
   * re-gates on the next update() immediately.
   */
  function setDocked(active, visiblePanels, showPanel) {
    docked = active
      ? { visible: new Set(Array.isArray(visiblePanels) ? visiblePanels : []), show: showPanel }
      : null;
    applyUnitAria();
    update();
  }

  function update() {
    current = getContext();
    syncProjectFolderButton();
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
      closeFileMenu();
      closeGitMenu();
      if ($('inspector-git-bar')) $('inspector-git-bar').hidden = true;
      if ($('inspector-git-commit')) $('inspector-git-commit').hidden = true;
      if (viewer.open) viewer.close();
      $('inspector-agent-count').hidden = true;
      $('inspector-usage').hidden = true;
      bindText($('inspector-agent-note'), () => '');
      bindText($('inspector-agent-summary'), () =>
        current.sessionId ? tr('ui.delegations_de_la_session') : tr('ui.prochaines_delegations'),
      );
      bindText($('inspector-file-note'), () => '');
      $('inspector-file-breadcrumb').replaceChildren();
      empty($('inspector-agent-list'), () =>
        current.sessionId
          ? tr('ui.chargement_des_agents')
          : current.cwd
            ? tr('ui.les_agents_apparaitront_apres_le_premier_message')
            : tr('ui.choisissez_un_projet_pour_preparer_ses_sous_agents'),
      );
      empty($('inspector-file-list'), () =>
        current.cwd
          ? tr('ui.chargement_des_fichiers')
          : tr('ui.choisissez_un_projet_pour_parcourir_ses_fichiers'),
      );
    }
    if (agentData?.session) $('detail-status').replaceChildren(statusNode(agentData.session.status));
    $('inspector-tab-agents').disabled = !current.enabled;
    $('inspector-tab-files').disabled = !current.enabled;
    const plan = inspectorFetchPlan({
      session: unitVisible('session'),
      agents: unitVisible('agents'),
      files: unitVisible('files'),
    });
    subagentSettings.update({ ...current, active: unitVisible('agents') && !document.hidden });
    // Session quota depends on the selected main model even without an open session.
    // Refresh it on model/cwd change; context needs live agent data.
    try {
      ensureSessionExtras();
      // Deferred async fetch; requestQuota dispatches only for a visible
      // session unit and advances the probe key solely on dispatch.
      requestQuota();
      if (!current.enabled) {
        quotaSection.hidden = true;
        contextSection.hidden = true;
      }
      renderContext();
    } catch {}
    if (!current.enabled) {
      if ($('inspector-git-bar')) $('inspector-git-bar').hidden = true;
      if ($('inspector-git-commit')) $('inspector-git-commit').hidden = true;
      return;
    }
    if (!plan.any || document.hidden || !current.online) return;
    if (plan.files) {
      if (fileMode === 'changes' || !fileData) void loadFiles();
      syncGitBar();
      syncCommitBox();
      void loadGit();
    }
    if (plan.agents) void loadAgents();
  }
  const timer = setInterval(update, 2500);
  document.addEventListener('visibilitychange', update);
  window.addEventListener('resize', update);
  return {
    update,
    setTab,
    roots,
    setDocked,
    openDocument,
    async openAgentById(id) {
      if (docked) docked.show?.('agents');
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
      for (const key of [...pending.keys()]) cancel(key);
      stopGitLanguage();
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
    },
  };
}
