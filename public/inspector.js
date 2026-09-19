import { t as tr, bindText, bindAttribute, translateKnown, getLanguage } from './i18n.js';
import { filePresentation, defaultFileView, parentFolder } from './file-presentation.js';
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
const busy = new Set(['working', 'tool', 'children', 'waiting', 'queued', 'compacting']);
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
  let current = {},
    agentData = null,
    fileData = null,
    agentsAt = 0,
    filesAt = 0,
    lastAgents = '';
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
  let quotaSnapshot = null;
  let quotaState = 'idle';
  let quotaRevisionCache = '';
  let providerCache = { at: 0, entry: null, remote: false };
  let subagentCache = { cwd: '', at: 0, model: '' };
  let lastQuotaKey = '';
  let lastQuotaProbeKey = '';
  let quotaGeneration = 0;
  function ensureSessionExtras() {
    if (quotaSection && contextSection) return;
    const host = $('inspector-session');
    const bottom = host.querySelector('.context-bottom');
    quotaSection = document.createElement('section');
    quotaSection.id = 'inspector-quota';
    quotaSection.className = 'context-section';
    quotaSection.hidden = true;
    contextSection = document.createElement('section');
    contextSection.id = 'inspector-context';
    contextSection.className = 'context-section';
    contextSection.hidden = true;
    if (bottom) host.insertBefore(contextSection, bottom);
    if (bottom) host.insertBefore(quotaSection, contextSection);
    else host.append(quotaSection, contextSection);
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
  async function codexEntry() {
    const now = Date.now();
    if (now - providerCache.at < 30000 && providerCache.entry !== undefined) return providerCache;
    try {
      // Minimal safe linkage metadata: works local + mobile/remote via authenticated gateway.
      // Never fetches the broad /api/providers list from mobile. Manual refresh only, no auto fetch.
      const link = await api('/api/providers/codex-link');
      const revision =
        typeof link?.revision === 'string' && /^[a-f0-9]{64}$/.test(link.revision) ? link.revision : '';
      const linked = link?.linked === true && revision !== '';
      const entry =
        link && typeof link === 'object' && revision
          ? { credentialType: linked ? 'oauth' : null, stored: linked, revision }
          : null;
      providerCache = { at: now, entry, remote: false };
      return providerCache;
    } catch {
      providerCache = { at: now, entry: null, remote: false };
      return providerCache;
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
    const hasCodex = mainProvider === 'openai-codex' || effectiveProvider === 'openai-codex';
    const hasApi = mainProvider === 'openai' || effectiveProvider === 'openai';
    const key = `${mainId}\0${effectiveId}\0${current.cwd || ''}`;
    if (key !== lastQuotaKey) {
      lastQuotaKey = key;
      quotaSnapshot = null;
      quotaState = 'idle';
    }
    if (!hasCodex && !hasApi) {
      quotaSection.hidden = true;
      quotaSection.replaceChildren();
      return;
    }
    quotaSection.hidden = false;
    quotaSection.replaceChildren();
    const label = document.createElement('div');
    label.className = 'context-label';
    if (hasCodex) bindText(label, () => tr('ui.session_quota_codex_title'));
    else bindText(label, () => tr('ui.session_quota_api_title'));
    quotaSection.append(label);
    if (!hasCodex && hasApi) {
      const note = document.createElement('p');
      note.className = 'inspector-note';
      bindText(note, () => tr('ui.session_quota_api_note'));
      quotaSection.append(note);
      return;
    }
    // Codex subscription path: require linked OAuth, manual refresh only, no fetch when unlinked.
    // Works local + mobile/remote via sanitized read-only endpoints behind existing PIN auth.
    const provider = await codexEntry();
    if (token !== quotaGeneration) return;
    if (current.cwd !== renderCwd || mainModelId() !== renderMain) return;
    const entry = provider.entry;
    const linked = entry && entry.credentialType === 'oauth' && entry.stored;
    if (!linked) {
      const note = document.createElement('p');
      note.className = 'inspector-note';
      bindText(note, () => tr('ui.session_quota_unlinked'));
      quotaSection.append(note);
      return;
    }
    quotaRevisionCache = entry.revision || quotaRevisionCache;
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
      const currentSnapshot = quotaSnapshot;
      const state = quotaState;
      bindText(line, () => {
        if (currentSnapshot && validQuotaResult(currentSnapshot)) return formatQuotaText(currentSnapshot);
        if (state === 'loading') return tr('ui.quota_chargement');
        if (state === 'auth') return tr('ui.session_quota_auth');
        if (state === 'error') return tr('ui.quota_indisponible');
        return tr('ui.quota_non_consulte');
      });
      renderQuotaBars(bars, currentSnapshot);
      bars.hidden = !bars.childElementCount;
    };
    paint();
    refresh.onclick = async () => {
      if (refresh.disabled) return;
      refresh.disabled = true;
      quotaState = 'loading';
      paint();
      try {
        const params = new URLSearchParams({
          provider: 'openai-codex',
          revision: quotaRevisionCache || entry.revision || '',
        });
        const result = await api(`/api/providers/codex-usage?${params}`);
        if (validQuotaResult(result)) {
          quotaSnapshot = result;
          quotaState = 'done';
          if (result && typeof result.provider === 'string') {
            // Never falsely attribute API usage: only Codex provider snapshots apply here.
            if (result.provider !== 'openai-codex') {
              quotaSnapshot = null;
              quotaState = 'error';
            }
          }
        } else if (result && result.available === false && result.reason === 'auth') {
          quotaSnapshot = null;
          quotaState = 'auth';
        } else {
          quotaSnapshot = null;
          quotaState = 'error';
        }
      } catch {
        quotaSnapshot = null;
        quotaState = 'error';
      } finally {
        refresh.disabled = false;
        paint();
      }
    };
    quotaSection.append(line, bars, refresh);
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
      showUsage();
      renderContext();
      void renderQuota();
      if (agentData.session) $('detail-status').replaceChildren(statusNode(agentData.session.status));
    } catch (error) {
      if (error.name !== 'AbortError')
        bindText($('inspector-agent-note'), () => translateKnown(error.message));
    }
  }
  function setTab(value, focus = false) {
    tab = value;
    for (const key of ['session', 'agents', 'files']) {
      const button = $(`inspector-tab-${key}`);
      button.setAttribute('aria-selected', String(key === tab));
      button.tabIndex = key === tab ? 0 : -1;
      $(`inspector-${key}`).hidden = key !== tab;
    }
    if (focus) $(`inspector-tab-${tab}`).focus();
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
        list.append(row);
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
      [...list.children]
        .find((element) => element.dataset.filePath === focusedPath)
        ?.focus({ preventScroll: true });
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
    void loadFiles(true);
  }
  $('files-changes').onclick = () => changeFiles('changes');
  $('files-all').onclick = () => changeFiles('all');
  $('refresh-files').onclick = () => void loadFiles(true);
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
    const viewport = window.visualViewport,
      left = viewport?.offsetLeft || 0,
      top = viewport?.offsetTop || 0,
      width = viewport?.width || innerWidth,
      height = viewport?.height || innerHeight;
    fileMenu.style.maxHeight = `${Math.max(80, height - 24)}px`;
    fileMenu.style.left = `${Math.max(left + 12, Math.min(left + width - fileMenu.offsetWidth - 12, x))}px`;
    fileMenu.style.top = `${Math.max(top + 12, Math.min(top + height - fileMenu.offsetHeight - 12, y))}px`;
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
      const open = node('button', 'inspector-open', () =>
        current.remote ? tr('ui.ouvrir_sur_le_pc') : tr('ui.ouvrir'),
      );
      open.type = 'button';
      bindAttribute(open, 'title', () => tr('ui.ouvrir_dans_l_application_du_pc'));
      const cwd = current.cwd;
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
      if (result.path) {
        await openFile({ path: result.path }, 'preview');
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
      lastAgents = '';
      directory = '';
      closeFileMenu();
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
    subagentSettings.update({ ...current, active: tab === 'agents' && visible() && !document.hidden });
    // Session quota depends on the selected main model even without an open session.
    // Refresh it on model/cwd change; context needs live agent data.
    try {
      ensureSessionExtras();
      const quotaKey = `${mainModelId()}\0${current.cwd || ''}`;
      if (quotaKey !== lastQuotaProbeKey) {
        lastQuotaProbeKey = quotaKey;
        // Defer async fetch; renderQuota guards its own race via lastQuotaKey.
        if (current.enabled && current.online && visible() && !document.hidden && tab === 'session')
          void renderQuota();
      }
      if (!current.enabled) {
        quotaSection.hidden = true;
        contextSection.hidden = true;
      }
      renderContext();
    } catch {}
    if (!current.enabled) return;
    if (!visible() || document.hidden || !current.online) return;
    if (tab === 'files') {
      if (fileMode === 'changes' || !fileData) void loadFiles();
    } else void loadAgents();
  }
  const timer = setInterval(update, 2500);
  document.addEventListener('visibilitychange', update);
  window.addEventListener('resize', update);
  return {
    update,
    setTab,
    openDocument,
    async openAgentById(id) {
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
