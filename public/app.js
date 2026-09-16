import {
  t as tr,
  getLanguage,
  bindText,
  bindAttribute,
  textNode,
  onLanguageChange,
  translateKnown,
} from './i18n.js';
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { createConversationRenderer } from './conversation.js';
import { reasoningMode } from './reasoning.js';
import { createSubagentSettings } from './subagent-settings.js';
import { createRemoteAccessSettings } from './remote-access.js';
import { createSettings } from './settings.js';
import { createLiveMessages } from './live-messages.js';
import { createImageComposer, renderImages } from './images.js';
import { createMcpSettings } from './mcp.js';
import { createProviderSettings } from './providers.js';
import { createCommands } from './commands.js';
import { composerText, setComposerText, composerCommand } from './composer.js';
import { createInspector } from './inspector.js';
import { fileLinkRenderer, bindFileLinks } from './file-links.js';
import { createSessionActivity } from './session-activity.js';
import { parseAgentEnvelope } from './agent-messages.js';
import { createProjectSorting } from './project-sorting.js';
import { createSessionSorting } from './session-sorting.js';
import { createProjectNavigation, hasPendingQuestion } from './project-navigation.js';
import { createKnowledgeBrowser } from './knowledge.js';
import { createProjectArchives } from './project-archives.js';
import { createRoadmap } from './roadmap.js';
import { bindInlineImages } from './inline-images.js';
import { createPasskeySettings } from './passkeys.js';
import { createQuestions } from './questions.js';
import { createPushSettings } from './push.js';
import {
  isDesktopComponentsAvailable,
  openDesktopComponents,
} from './desktop-components-action.js';
let questionsUI;
let imageComposer;
let projectSorting;
let sessionSorting;
let projectNavigation;
let liveMessagesUI;
let commandsUI;
let inspectorUI;
let roadmapUI;
let archivesUI;
let roadmapNavigationSequence = 0;
let modelPickerTarget = null;
let modelCatalogRequest = null;
let modelCatalogPoll = null;
let modelCatalogPollsRemaining = 0;
const $ = (id) => document.getElementById(id);
const icons = {
  plus: 'M12 5v14M5 12h14',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4',
  search: 'm21 21-4.4-4.4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0',
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  'folder-plus': 'M3 7V5h6l2 2h10v13H3V7Zm9 3v7m-3-3.5h6',
  archive: 'M4 8h16v12H4V8ZM3 3h18v5H3V3Zm7 9h4',
  settings:
    'm10 3-.5 2-2 .9-1.8-.6-2 3.4L5.2 10v2l-1.5 1.3 2 3.4 1.8-.6 2 .9.5 2h4l.5-2 2-.9 1.8.6 2-3.4-1.5-1.3v-2l1.5-1.3-2-3.4-1.8.6-2-.9L14 3h-4ZM15 11a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  menu: 'M4 6h16M4 12h16M4 18h16',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
  panel: 'M3 4h18v16H3V4Zm12 0v16',
  map: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15',
  compass: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM16 8l-2 6-6 2 2-6 6-2Z',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16',
  bug: 'M8 7V5a4 4 0 0 1 8 0v2M6 7h12v8a6 6 0 0 1-12 0V7Zm6 0v14M2 9h4m12 0h4M2 15h4m12 0h4M4 21l3-3m10 0 3 3',
  sparkles: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Zm8-1v4m-2-2h4',
  'arrow-up-right': 'M6 18 18 6M6 6h12v12',
  'arrow-up': 'M12 19V5m-6 6 6-6 6 6',
  'arrow-down': 'M12 5v14m-6-6 6 6 6-6',
  model: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  stop: 'M6 6h12v12H6V6',
  shield: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Zm-4 9 3 3 5-6',
  copy: 'M9 9h12v12H9V9ZM5 15H3V3h12v2',
  download: 'M12 3v12m-5-5 5 5 5-5M3 16v5h18v-5',
  upload: 'M12 21V9m-5 5 5-5 5 5M3 16v5h18v-5',
  terminal: 'm4 5 6 6-6 6m8 0h8',
  pencil: 'm16 3 5 5L8 21H3v-5L16 3Zm-2 2 5 5',
  pin: 'm9 3 12 12-3 3-5-2-4 4-5-5 4-4-2-5 3-3Zm-3 15-4 4',
  star: 'm12 2.8 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.5 6.3-.9L12 2.8Z',
  x: 'm6 6 12 12M6 18 18 6',
  moon: 'M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 1v2m0 18v2M1 12h2m18 0h2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  monitor: 'M2 3h20v14H2V3Zm10 14v4m-5 0h10',
  chat: 'M21 4H3v13h5l4 4 4-4h5V4Z',
  chevron: 'm9 5 7 7-7 7',
  check: 'm5 12 4 4L19 6',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 17.9 17',
  alert: 'm12 3 10 18H2L12 3Zm0 5v6m0 3v.01',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-3a8 5 0 0 1 16 0v3',
  brain: 'M12 4C8 0 4 4 5 7c-5 1-4 7-1 8-1 5 5 8 8 4 3 4 9 1 8-4 3-1 4-7-1-8 1-3-3-7-7-3Zm0 0v15',
  tool: 'M21 3a6 6 0 0 1-8 8L5 21l-3-3 9-9a6 6 0 0 1 8-8l-4 4 3 3 3-5Z',
};
function icon(name, className = '') {
  const s = document.createElement('span');
  if (className) s.className = className;
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${icons[name] || icons.chat}"/></svg>`;
  return s;
}
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((n) => n.replaceChildren(icon(n.dataset.icon)));
}
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) bindText(n, () => text);
  return n;
}
function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`prime-studio.${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeStorage(key, value) {
  try {
    localStorage.setItem(`prime-studio.${key}`, JSON.stringify(value));
  } catch {}
}
function storedPreferences() {
  const stored = readStorage('preferences', {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}
function savePreferences(patch) {
  Object.assign(prefs, storedPreferences(), patch);
  writeStorage('preferences', prefs);
}
const prefs = {
  theme: 'dark',
  enterToSend: true,
  reasoningMode: reasoningMode(storedPreferences()),
  details: true,
  modelFavorites: [],
  ...readStorage('preferences', {}),
};
const state = {
  projects: [],
  projectCwd: null,
  sessionId: null,
  viewRunId: null,
  history: [],
  runs: new Map(),
  models: [],
  version: null,
  online: false,
  loading: false,
  sending: false,
  archived: false,
  requestId: 0,
  initialized: false,
  readOnly: false,
  remote: false,
  projectOverview: false,
  menuSessionId: null,
  modelFavoritesOnly: false,
  modelConfig: null,
  modelConfigOriginal: null,
  modelDefaults: null,
  modelCatalogDefault: '',
  modelCatalogRefreshing: false,
  modelCatalogNotice: '',
};
const selection = readStorage('selection', {});
const sessionActivity = createSessionActivity({
  read: readStorage,
  write: writeStorage,
  loadHistory: (id) => api(`/api/history?id=${encodeURIComponent(id)}`),
  saveRead: (id, answer) => api('/api/sessions/read', { method: 'POST', body: { id, answer } }),
  onChange: () => {
    renderProjects();
    renderSessions();
    renderProjectOverview();
  },
});
const normalizedPath = (p) =>
  String(p || '')
    .replaceAll('\\', '/')
    .replace(/\/$/, '')
    .toLowerCase();
const samePath = (a, b) => normalizedPath(a) === normalizedPath(b);
const project = () => state.projects.find((p) => samePath(p.cwd, state.projectCwd));
const allSessions = () =>
  state.projects.flatMap((p) => (p.sessions || []).map((s) => ({ ...s, cwd: s.cwd || p.cwd })));
const session = (id) => allSessions().find((s) => s.id === (id || state.sessionId));
const isRunning = (run) => run && ['running', 'stopping'].includes(run.status);
const activeRun = () =>
  state.runs.get(state.viewRunId) ||
  [...state.runs.values()].find((r) => r.sessionId && r.sessionId === state.sessionId && isRunning(r));
const activeMessages = () => {
  const r = activeRun();
  return r?.initialized ? [...r.base, ...r.messages] : state.history;
};
const toTime = (v) => {
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
};
const dateLabel = (v) => {
  const time = toTime(v);
  if (!time) return '—';
  const d = new Date(time);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(getLanguage(), { day: 'numeric', month: 'short' });
};
const normalizeModelSearch = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase(getLanguage())
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
function favoriteModelIds() {
  const latest = storedPreferences(),
    stored = Array.isArray(latest.modelFavorites)
      ? latest.modelFavorites
      : Array.isArray(prefs.modelFavorites)
        ? prefs.modelFavorites
        : [],
    sanitized = stored.filter((id) => typeof id === 'string' && id.length <= 500);
  prefs.modelFavorites = sanitized;
  return new Set(sanitized);
}
function modelDisplayName(id) {
  return (
    state.models.find((model) => model.id === id)?.name || id?.split('/').pop() || tr('ui.modele_par_defaut')
  );
}
const generationPending = new Map();
const generationDrafts = new Map();
const generationConfirmed = new Map();
let selectedGeneration = {};
function applyStudioPreferences(preferences) {
  if (!preferences || (preferences.revision || 0) < (state.studioPreferences?.revision || 0)) return;
  const changed = preferences.allowQuestionsByDefault !== state.studioPreferences?.allowQuestionsByDefault;
  state.studioPreferences = preferences;
  if (changed) restoreGenerationSettings();
}
function rememberGenerationSettings(id, settings, revision = 0) {
  const known = generationConfirmed.get(id);
  // A delayed history/overview must not undo an acknowledged save. Revisions
  // also let a newer preference from another device replace the cached value.
  if (id && settings && (!known || revision >= known.revision)) {
    generationConfirmed.set(id, { settings: { ...settings }, revision });
  }
  return generationConfirmed.get(id);
}
function restoreGenerationSettings(history = session(), run = activeRun()) {
  const defaults = {
    model: state.modelCatalogDefault || '',
    thinking: state.modelCatalogThinking || '',
    allowQuestions: state.studioPreferences?.allowQuestionsByDefault !== false,
  };
  const saved =
    rememberGenerationSettings(state.sessionId, history?.generationSettings, history?.generationRevision)
      ?.settings || {};
  const pending = generationPending.get(state.sessionId);
  const draft = generationDrafts.get(normalizedPath(state.projectCwd));
  const settings =
    state.sessionId || run
      ? {
          model: saved.model ?? run?.model ?? history?.model ?? defaults.model,
          thinking: saved.thinking ?? run?.thinking ?? history?.thinking ?? defaults.thinking,
          allowQuestions: saved.allowQuestions ?? run?.allowQuestions ?? defaults.allowQuestions,
        }
      : { ...defaults, ...draft };
  selectedGeneration = { ...settings, ...pending?.settings };
  setSelectedModel(selectedGeneration.model, false);
  $('thinking-select').value = selectedGeneration.thinking;
  $('allow-questions').checked = !!selectedGeneration.allowQuestions;
}
async function saveGenerationSettings(patch) {
  const id = state.sessionId,
    cwd = state.projectCwd,
    previous = { ...selectedGeneration };
  if (state.readOnly || state.loading || state.sending || generationPending.has(id)) {
    restoreGenerationSettings();
    return;
  }
  const run = activeRun();
  if (isRunning(run) && ('model' in patch || 'allowQuestions' in patch || !id || run.status !== 'running')) {
    restoreGenerationSettings();
    return;
  }
  selectedGeneration = { ...selectedGeneration, ...patch };
  if (!id) {
    generationDrafts.set(normalizedPath(cwd), { ...generationDrafts.get(normalizedPath(cwd)), ...patch });
    return;
  }
  const entry = { settings: { ...selectedGeneration } };
  generationPending.set(id, entry);
  updateComposer();
  try {
    const result = await api('/api/conversation-settings', {
      method: 'PATCH',
      body: { id, cwd, settings: patch },
    });
    const confirmed = rememberGenerationSettings(id, result.settings, result.revision);
    for (const project of state.projects) {
      const target = project.sessions?.find((s) => s.id === id);
      if (target) {
        target.generationSettings = confirmed.settings;
        target.generationRevision = confirmed.revision;
      }
    }
    if (result.appliedToRun && run) run.thinking = confirmed.settings.thinking;
    if (state.sessionId === id) {
      selectedGeneration = { ...previous, ...confirmed.settings };
      setSelectedModel(selectedGeneration.model);
      $('thinking-select').value = selectedGeneration.thinking;
      if (result.appliedToRun) toast(() => tr('conversation.thinkingApplied'));
    }
  } catch (error) {
    if (state.sessionId === id) {
      selectedGeneration = previous;
      setSelectedModel(previous.model);
      $('thinking-select').value = previous.thinking;
      toast(translateKnown(error.message), true);
    }
  } finally {
    generationPending.delete(id);
    if (state.sessionId === id) restoreGenerationSettings();
    updateComposer();
  }
}
function setSelectedModel(value, persist = false, render = true) {
  const id = typeof value === 'string' ? value : '',
    select = $('model-select');
  if (id && ![...select.options].some((option) => option.value === id)) {
    const option = el('option', '', () => id);
    option.value = id;
    select.append(option);
  }
  select.value = id;
  const name = modelDisplayName(id),
    button = $('model-picker-button'),
    model = state.models.find((item) => item.id === id),
    provider =
      model?.provider ||
      (id.includes('/')
        ? id.slice(0, id.indexOf('/'))
        : id
          ? tr('ui.modele_personnalise')
          : tr('ui.configuration_prime_agent'));
  bindText($('model-picker-label'), () => name);
  bindText($('model-picker-provider'), () => provider);
  bindAttribute(button, 'title', () => (id ? `${name} · ${model?.id || id}` : name));
  bindAttribute(button, 'aria-label', () =>
    tr('ui.choisir_le_modele_selection_actuelle', { value1: id ? `${name}, ${model?.id || id}` : name }),
  );
  if (persist) void saveGenerationSettings({ model: id });
  if (render && $('model-dialog').open) renderModelList();
  renderConfigurationWarning();
}
function renderConfigurationWarning() {
  const providerMissing = Array.isArray(state.configuredProviders) && state.configuredProviders.length === 0;
  const modelMissing = !($('model-select').value || state.modelCatalogDefault);
  const visible =
    state.initialized &&
    state.online &&
    state.version?.available !== false &&
    (providerMissing || modelMissing);
  $('configuration-warning').hidden = !visible;
  if (!visible) return;
  const key =
    providerMissing && modelMissing ? 'bothMissing' : providerMissing ? 'providerMissing' : 'modelMissing';
  bindText($('configuration-warning-text'), () => tr(`configuration.${key}`));
  // Missing provider keeps its direct target (provider config). Engine
  // components use the separate app-settings target below.
  $('configuration-provider-action').hidden =
    !providerMissing || state.remote || !state.providersAvailable || state.readOnly;
  $('configuration-model-action').hidden = !modelMissing || state.readOnly;
  // Desktop-only shortcut to the app component settings. Browser/mobile stays
  // hidden: no broken invoke. Opening never auto-installs.
  const componentsAction = $('configuration-components-action');
  if (componentsAction)
    componentsAction.hidden =
      state.remote || state.readOnly || !isDesktopComponentsAvailable();
}
$('configuration-provider-action').onclick = () => $('open-provider-settings').click();
$('configuration-model-action').onclick = () => $('model-picker-button').click();
if ($('configuration-components-action'))
  $('configuration-components-action').onclick = () => void openDesktopComponents({ toast });
if ($('global-banner-components'))
  $('global-banner-components').onclick = () => void openDesktopComponents({ toast });
function modelRow(model, favorite = false) {
  const id = model.id || '',
    defaultChoice = !id,
    unavailable = model.availability === 'unavailable',
    name = model.name || modelDisplayName(id),
    selected = (modelPickerTarget?.value ?? $('model-select').value) === id,
    accessibleName = defaultChoice ? name : `${name}, ${model.id}`,
    row = el('div', `model-row${selected ? ' selected' : ''}${unavailable ? ' unavailable' : ''}`),
    choice = el('button', 'model-choice'),
    copy = el('span', 'model-choice-copy'),
    favoriteButton = defaultChoice ? null : el('button', 'model-favorite');
  row.dataset.modelId = id;
  row.setAttribute('role', 'listitem');
  choice.type = 'button';
  choice.disabled = unavailable;
  choice.dataset.modelId = id;
  bindAttribute(choice, 'aria-label', () =>
    unavailable
      ? tr('common.unavailable', { value1: accessibleName })
      : tr('model.use', { value1: accessibleName }),
  );
  if (selected) choice.setAttribute('aria-current', 'true');
  copy.append(
    el('span', 'model-choice-name', () => name),
    el('span', 'model-choice-detail', () =>
      defaultChoice ? modelPickerTarget?.defaultDetail || tr('ui.configuration_de_prime_agent') : model.id,
    ),
  );
  choice.append(copy);
  if (unavailable) choice.append(el('span', 'model-choice-availability', () => tr('model.unavailable')));
  if (selected) choice.append(icon('check', 'model-choice-check'));
  row.append(choice);
  if (favoriteButton) {
    favoriteButton.type = 'button';
    favoriteButton.dataset.modelId = id;
    favoriteButton.setAttribute('aria-pressed', String(favorite));
    bindAttribute(favoriteButton, 'aria-label', () =>
      tr(favorite ? 'model.removeFavorite' : 'model.addFavorite', { name: accessibleName }),
    );
    bindAttribute(favoriteButton, 'title', () =>
      favorite ? tr('ui.retirer_des_favoris') : tr('ui.ajouter_aux_favoris'),
    );
    favoriteButton.append(icon('star'));
    row.append(favoriteButton);
  }
  return row;
}
function appendModelGroup(title, models, favorites) {
  if (!models.length) return;
  const section = el('section', 'model-group'),
    heading = el('h3', 'model-group-title', () => title),
    list = el('div', 'model-group-list');
  bindAttribute(section, 'aria-label', () => title);
  list.setAttribute('role', 'list');
  for (const model of models) list.append(modelRow(model, favorites.has(model.id)));
  section.append(heading, list);
  $('model-list').append(section);
}
function renderModelList({ focusFavorite, preserveFocus = false } = {}) {
  const root = $('model-list'),
    focused = preserveFocus && root.contains(document.activeElement) ? document.activeElement : null,
    scrollTop = root.scrollTop,
    query = normalizeModelSearch($('model-search').value),
    favorites = favoriteModelIds(),
    matching = state.models.filter((model) =>
      normalizeModelSearch(`${model.name || ''} ${model.provider || ''} ${model.id || ''}`).includes(query),
    ),
    favoriteModels = matching.filter((model) => favorites.has(model.id)),
    otherModels = state.modelFavoritesOnly ? [] : matching.filter((model) => !favorites.has(model.id)),
    defaultMatches = normalizeModelSearch(
      modelPickerTarget?.defaultLabel || tr('ui.modele_par_defaut_configuration_prime_agent'),
    ).includes(query),
    showDefault = !state.modelFavoritesOnly && defaultMatches,
    visibleCount = favoriteModels.length + otherModels.length + Number(showDefault),
    availableFavoriteCount = state.models.filter((model) => favorites.has(model.id)).length;
  root.replaceChildren();
  $('model-favorites-filter').setAttribute('aria-pressed', String(state.modelFavoritesOnly));
  bindText($('model-favorites-label'), () =>
    availableFavoriteCount
      ? tr('model.favoritesCount', { value1: availableFavoriteCount })
      : tr('ui.favoris'),
  );
  bindText($('model-results-status'), () =>
    state.modelCatalogRefreshing
      ? tr('model.refreshing')
      : state.modelCatalogNotice
        ? tr(state.modelCatalogNotice)
        : query || state.modelFavoritesOnly
          ? tr('count.results', { count: visibleCount })
          : tr('count.choices', { count: visibleCount }),
  );
  appendModelGroup(() => tr('ui.favoris'), favoriteModels, favorites);
  if (showDefault)
    appendModelGroup(
      tr('common.configuration'),
      [{ id: '', name: modelPickerTarget?.defaultLabel || tr('ui.modele_par_defaut'), provider: '' }],
      favorites,
    );
  if (!state.modelFavoritesOnly) {
    const providers = new Map();
    for (const model of otherModels) {
      const provider = model.provider || tr('common.other');
      if (!providers.has(provider)) providers.set(provider, []);
      providers.get(provider).push(model);
    }
    for (const [provider, models] of providers) appendModelGroup(provider, models, favorites);
  }
  if (!visibleCount) {
    const empty = el('div', 'model-list-empty');
    empty.append(
      icon(state.modelFavoritesOnly ? 'star' : 'search'),
      el('strong', '', () =>
        state.modelFavoritesOnly ? tr('ui.aucun_favori_trouve') : tr('ui.aucun_modele_trouve'),
      ),
      el('span', '', () =>
        state.modelFavoritesOnly
          ? tr('ui.ajoutez_un_favori_ou_modifiez_votre_recherche')
          : tr('ui.essayez_un_autre_nom_fournisseur_ou_identifiant'),
      ),
    );
    root.append(empty);
  }
  if (focusFavorite) {
    requestAnimationFrame(() => {
      const target = [...root.querySelectorAll('.model-favorite')].find(
        (button) => button.dataset.modelId === focusFavorite,
      );
      (target || $('model-favorites-filter')).focus();
    });
  } else if (preserveFocus) {
    const replacement =
      focused &&
      [
        ...root.querySelectorAll(focused.matches('.model-favorite') ? '.model-favorite' : '.model-choice'),
      ].find((button) => button.dataset.modelId === focused.dataset.modelId);
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
    else if (focused) $('model-search').focus({ preventScroll: true });
    root.scrollTop = scrollTop;
  }
}
function renderModelRefresh() {
  const button = $('model-refresh');
  const busy = Boolean(modelCatalogRequest) || state.modelCatalogRefreshing;
  button.disabled = Boolean(modelCatalogRequest) || state.readOnly;
  button.setAttribute('aria-busy', String(busy));
  bindAttribute(button, 'aria-label', () => tr(busy ? 'model.refreshing' : 'model.refresh'));
  bindAttribute(button, 'title', () => tr(busy ? 'model.refreshing' : 'model.refresh'));
}
async function refreshModelCatalog({ force = false, manual = false, poll = false } = {}) {
  if (modelCatalogRequest) return modelCatalogRequest;
  clearTimeout(modelCatalogPoll);
  if (!poll) {
    modelCatalogPollsRemaining = 10;
    state.modelCatalogNotice = '';
  }
  modelCatalogRequest = api(force ? '/api/models/refresh' : '/api/models', {
    method: force ? 'POST' : 'GET',
    ...(force ? { body: {} } : {}),
  })
    .then((catalog) => {
      populateModels(catalog, { preserveSelection: true });
    })
    .catch((error) => {
      state.modelCatalogRefreshing = false;
      state.modelCatalogNotice = 'model.refreshInterrupted';
      modelCatalogPollsRemaining = 0;
      renderConfigurationWarning();
      if (manual) toast(() => tr('model.refreshFailed', { value1: translateKnown(error.message) }), true);
    })
    .finally(() => {
      modelCatalogRequest = null;
      if ($('model-dialog').open && state.modelCatalogRefreshing && modelCatalogPollsRemaining === 0) {
        state.modelCatalogRefreshing = false;
        state.modelCatalogNotice = 'model.refreshDelayed';
      }
      if ($('model-dialog').open && state.modelCatalogNotice) renderModelList({ preserveFocus: true });
      renderModelRefresh();
      if ($('model-dialog').open && state.modelCatalogRefreshing && modelCatalogPollsRemaining > 0) {
        modelCatalogPollsRemaining -= 1;
        modelCatalogPoll = setTimeout(() => void refreshModelCatalog({ poll: true }), 2000);
      }
    });
  renderModelRefresh();
  return modelCatalogRequest;
}
function toggleModelFavorite(id) {
  if (!state.models.some((model) => model.id === id)) return;
  const favorites = favoriteModelIds(),
    removing = favorites.delete(id);
  if (!removing) favorites.add(id);
  savePreferences({ modelFavorites: [...favorites] });
  renderModelList({ focusFavorite: state.modelFavoritesOnly && removing ? undefined : id });
  if (state.modelFavoritesOnly && removing) requestAnimationFrame(() => $('model-favorites-filter').focus());
}
function openModelDialog() {
  openModelPicker({
    button: $('model-picker-button'),
    value: $('model-select').value,
    onSelect: (id) => setSelectedModel(id, true),
  });
}
function openModelPicker(target) {
  if (target.button.disabled || target.button.matches(':disabled')) return;
  modelPickerTarget = target;
  bindText($('model-dialog-title'), () => target.title || tr('ui.choisir_un_modele'));
  state.modelFavoritesOnly = false;
  $('model-search').value = '';
  renderModelList();
  $('model-dialog').showModal();
  target.button.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => {
    $('model-search').focus();
    $('model-list').querySelector('.model-row.selected')?.scrollIntoView({ block: 'center' });
  });
  void refreshModelCatalog();
}
function toast(message, error = false) {
  const n = el('div', `toast${error ? ' error' : ''}`);
  n.append(
    icon(error ? 'alert' : 'check'),
    el('span', '', () => translateKnown(message)),
  );
  $('toasts').append(n);
  setTimeout(() => n.remove(), error ? 6500 : 3200);
}
function banner(message, error = false) {
  const text = $('global-banner-text') || $('global-banner');
  bindText(text, () => translateKnown(message || ''));
  $('global-banner').hidden = !message;
  $('global-banner').classList.toggle('error', error);
  renderEngineComponentsAction();
}
function renderEngineComponentsAction() {
  const action = $('global-banner-components');
  if (!action) return;
  // Engine components target: desktop native only. Browser/mobile stays
  // explanatory with no broken invoke. Opening never auto-installs.
  const engineMissing = state.version?.available === false;
  action.hidden =
    $('global-banner').hidden ||
    !engineMissing ||
    state.remote ||
    state.readOnly ||
    !isDesktopComponentsAvailable();
}
async function api(path, { method = 'GET', body, signal } = {}) {
  const pushWrite = path === '/api/push/subscriptions' || path === '/api/push/focus';
  if (
    state.readOnly &&
    method.toUpperCase() !== 'GET' &&
    !(method.toUpperCase() === 'POST' && path === '/api/sessions/read') &&
    !pushWrite
  )
    throw new Error(tr('ui.cette_connexion_permet_de_consulter_les_sessions'));
  const r = await fetch(path, {
    method,
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error(tr('ui.le_serveur_a_renvoye_une_reponse_illisible'));
  }
  if (!r.ok) {
    const e = new Error(translateKnown(data.error) || tr('common.httpError', { value1: r.status }));
    e.status = r.status;
    e.code = data.code;
    if (path === '/api/remote-access/network') e.setupUrl = data.setupUrl;
    throw e;
  }
  return data;
}
function setConnection(online) {
  state.online = online;
  $('connection-dot').className = `status-dot${online ? '' : ' offline'}`;
  bindText($('connection-label'), () =>
    online
      ? state.version?.available === false
        ? tr('ui.prime_agent_indisponible')
        : tr('ui.moteur_connecte')
      : tr('ui.reconnexion_au_serveur'),
  );
  if (online && state.version?.available === false) $('connection-dot').className = 'status-dot waiting';
  updateComposer();
}
function applyPreferences() {
  document.documentElement.dataset.theme =
    prefs.theme === 'system'
      ? matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : prefs.theme;
  $('enter-to-send').checked = prefs.enterToSend;
  document.querySelectorAll('[name="reasoning-mode"]').forEach((input) => {
    input.checked = input.value === reasoningMode(prefs);
  });
  document
    .querySelectorAll('[data-theme-choice]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === prefs.theme)));
  bindText($('send-hint'), () =>
    prefs.enterToSend
      ? tr('ui.entree_pour_envoyer_maj_entree_pour_un_saut_de_ligne')
      : tr('ui.ctrl_entree_pour_envoyer'),
  );
  if (innerWidth > 1080) {
    $('details-panel').hidden = !prefs.details;
    $('toggle-details').setAttribute('aria-pressed', String(prefs.details));
  } else {
    $('details-panel').hidden = false;
    $('toggle-details').setAttribute(
      'aria-pressed',
      String($('details-panel').classList.contains('mobile-open')),
    );
  }
  const open = $('toggle-details').getAttribute('aria-pressed') === 'true';
  bindAttribute($('toggle-details'), 'title', () =>
    open ? tr('ui.masquer_le_panneau') : tr('ui.afficher_le_panneau_session_agents_et_fichiers'),
  );
  bindAttribute($('toggle-details'), 'aria-label', () => $('toggle-details').title);
  inspectorUI?.update();
}
function applyAccessMode() {
  document.documentElement.dataset.readOnly = String(state.readOnly);
  document.documentElement.dataset.remote = String(state.remote);
  $('remote-view-banner').hidden = !state.remote;
  bindText($('remote-view-label'), () =>
    state.readOnly ? tr('ui.consultation_a_distance') : tr('ui.studio_a_distance'),
  );
  bindText($('remote-view-detail'), () =>
    state.readOnly ? tr('ui.lecture_seule') : tr('ui.controle_complet'),
  );

  $('composer').disabled = state.readOnly;
  $('enter-to-send').closest('.settings-row').hidden = state.readOnly;
  $('model-config-settings').hidden = state.remote;
  $('remote-access-settings').hidden = state.remote;
  $('provider-settings').hidden = state.remote || !state.providersAvailable;
  $('logout-button').hidden = !state.remote;
  $('mcp-settings').hidden = state.readOnly;
  const skipLink = document.querySelector('.skip-link');
  skipLink.href = state.readOnly ? '#conversation-scroll' : '#composer';
  bindText(skipLink, () => (state.readOnly ? tr('ui.aller_a_la_conversation') : tr('ui.aller_au_message')));
  bindText(document.querySelector('.local-pill'), () => (state.remote ? tr('ui.distant') : 'LOCAL'));
  bindText(document.querySelector('.settings-shortcut'), () =>
    state.remote ? tr('ui.cet_appareil') : tr('ui.studio_local'),
  );
  if (state.readOnly) {
    closeSessionMenu();
    bindText(document.querySelector('#welcome h1'), () => tr('ui.vos_projets_a_portee_de_main'));
    bindText(document.querySelector('.welcome-description'), () =>
      tr('ui.choisissez_un_projet_pour_retrouver_ses_sessions_et_suivre_l_agen'),
    );
    bindText(document.querySelector('.welcome-eyebrow').lastChild, () => tr('ui.votre_studio_a_distance'));
  }
}
function draftKey() {
  return state.sessionId ? `session:${state.sessionId}` : `project:${normalizedPath(state.projectCwd)}`;
}
function saveDraft() {
  if (state.readOnly) return;
  const drafts = readStorage('drafts', {}),
    key = draftKey();
  if (composerText()) drafts[key] = composerText();
  else delete drafts[key];
  writeStorage('drafts', drafts);
}
function acceptDraft(key, text) {
  // An accepted send belongs to its original conversation, even after navigation.
  // Only discard the submitted text; a newer draft must remain intact.
  const drafts = readStorage('drafts', {});
  if (drafts[key] === text) {
    delete drafts[key];
    writeStorage('drafts', drafts);
  }
  if (draftKey() === key && composerText() === text) {
    setComposerText('');
    saveDraft();
    resizeComposer();
  }
}
function restoreDraft() {
  setComposerText(state.readOnly ? '' : readStorage('drafts', {})[draftKey()] || '', {
    retainCommand: false,
  });
  commandsUI?.restoreDraft();
  resizeComposer();
}
function saveSelection() {
  writeStorage('selection', {
    cwd: state.projectCwd,
    sessionId: state.sessionId,
    runId: state.viewRunId,
    projectOverview: state.projectOverview,
  });
}
function resizeComposer() {
  const a = $('composer');
  const style = getComputedStyle(a);
  const minHeight = parseFloat(style.minHeight) || 40;
  const maxHeight = parseFloat(style.maxHeight) || 200;
  a.style.height = '0px';
  a.style.height = `${Math.min(maxHeight, Math.max(minHeight, a.scrollHeight))}px`;
  updateComposer();
}
function updateComposer() {
  renderConfigurationWarning();
  imageComposer?.update();
  commandsUI?.update();
  const running = isRunning(activeRun());
  $('send-button').hidden = running;
  $('stop-button').hidden = !running;
  $('stop-button').disabled = state.readOnly || activeRun()?.status === 'stopping';
  $('send-button').disabled =
    state.readOnly ||
    state.projectOverview ||
    (!composerText().trim() && !imageComposer?.hasImages()) ||
    imageComposer?.blocked() ||
    !state.projectCwd ||
    state.sending ||
    generationPending.has(state.sessionId) ||
    state.loading ||
    running ||
    !state.online ||
    state.version?.available === false ||
    project()?.exists === false;
  const settingsDisabled =
    state.readOnly ||
    !state.online ||
    state.loading ||
    state.sending ||
    generationPending.has(state.sessionId);
  $('model-select').disabled = settingsDisabled || running;
  $('model-picker-button').disabled = settingsDisabled || running;
  $('allow-questions').disabled = settingsDisabled || running;
  questionsUI?.update();
  $('thinking-select').disabled =
    settingsDisabled || (running && (!state.sessionId || activeRun()?.status !== 'running'));
  bindAttribute($('thinking-select'), 'title', () =>
    running ? tr('conversation.thinkingNextCall') : tr('conversation.scope'),
  );
  $('run-status').hidden = !running;
  bindText($('run-status-label'), () =>
    activeRun()?.status === 'stopping'
      ? tr('ui.arret_de_l_agent')
      : activeRun()?.interactions?.some((item) => item.status === 'pending')
        ? tr('questions.waiting')
        : activeRun()?.statusLabel || tr('ui.l_agent_travaille'),
  );
  bindAttribute($('composer'), 'placeholder', () =>
    composerCommand()
      ? tr('ui.ajoutez_vos_consignes')
      : state.projectCwd
        ? running
          ? tr('ui.preparez_votre_prochain_message')
          : tr('ui.que_souhaitez_vous_construire')
        : tr('ui.ajoutez_un_projet_pour_commencer'),
  );
  liveMessagesUI?.update();
}
function renderProjects() {
  const pendingQuestionRuns = [...state.runs.values()].filter(hasPendingQuestion);
  $('workspace-question-alert').hidden = !pendingQuestionRuns.length;
  bindAttribute($('workspace-question-alert'), 'aria-label', () =>
    tr('passkeys.pendingQuestions', { count: pendingQuestionRuns.length }),
  );
  bindAttribute($('workspace-question-alert'), 'title', () =>
    tr('passkeys.pendingQuestions', { count: pendingQuestionRuns.length }),
  );
  $('workspace-question-alert').onclick = () => {
    const run = pendingQuestionRuns[0];
    if (run?.sessionId) void selectSession(run.sessionId, run.cwd);
  };
  if (projectSorting?.active || sessionSorting?.active || !projectNavigation) return;
  const query = $('session-search').value.trim();
  bindText($('session-list-label'), () =>
    state.archived
      ? tr('ui.sessions_archivees')
      : query
        ? tr('ui.resultats_de_recherche')
        : tr('ui.espace_de_travail_2'),
  );
  $('show-archived').setAttribute('aria-pressed', String(state.archived));
  bindAttribute($('show-archived'), 'title', () =>
    state.archived ? tr('ui.afficher_les_sessions_recentes') : tr('ui.afficher_les_sessions_archivees'),
  );
  bindAttribute($('show-archived'), 'aria-label', () => $('show-archived').title);
  projectNavigation.render({
    projects: state.projects,
    projectCwd: state.projectCwd,
    sessionId: state.sessionId,
    viewRunId: state.viewRunId,
    archived: state.archived,
    query,
    readOnly: state.readOnly,
    runs: [...state.runs.values()],
    unreadIds: allSessions()
      .filter((s) => sessionActivity.isUnread(s.id))
      .map((s) => s.id),
  });
}
function activityDot(status, project = false) {
  const dot = el('span', `${status}-dot${project ? ' project-activity-dot' : ''}`);
  if (status === 'question') dot.textContent = '?';
  const label =
    status === 'question'
      ? tr('questions.pending')
      : status === 'running'
        ? tr('ui.agent_en_cours')
        : tr('ui.reponse_terminee_non_lue');
  bindAttribute(dot, 'title', () => translateKnown(label));
  dot.setAttribute('role', 'img');
  bindAttribute(dot, 'aria-label', () => translateKnown(label));
  return dot;
}
function renderSessions() {
  renderProjects();
}
let projectListSignature = '';
function renderProjectOverview() {
  const p = project();
  const visible = state.projectOverview && Boolean(p);
  $('project-overview').hidden = !visible;
  document.documentElement.dataset.projectOverview = String(visible);
  const skipLink = document.querySelector('.skip-link');
  skipLink.href = visible || state.readOnly ? '#conversation-scroll' : '#composer';
  bindText(skipLink, () =>
    visible
      ? tr('ui.aller_aux_sessions_du_projet')
      : state.readOnly
        ? tr('ui.aller_a_la_conversation')
        : tr('ui.aller_au_message'),
  );
  if (!visible) return;
  bindText($('project-overview-title'), () => p.name || tr('ui.sessions_du_projet'));
  $('project-new-session').hidden = state.readOnly;
  $('project-new-session').disabled = p.exists === false;
  const sessions = (p.sessions || []).map((s) => ({ ...s, cwd: s.cwd || p.cwd }));
  const pendingRuns = [...state.runs.values()].filter(
    (r) => samePath(r.cwd, p.cwd) && isRunning(r) && !sessions.some((s) => s.id === r.sessionId),
  );
  const count = sessions.filter((s) => !s.archived).length + pendingRuns.length;
  bindText($('project-session-count'), () => tr('count.sessions', { count: count }));
  $('project-show-recent').setAttribute('aria-pressed', String(!state.archived));
  $('project-show-archived').setAttribute('aria-pressed', String(state.archived));
  bindText(document.querySelector('.project-overview-description'), () =>
    state.readOnly
      ? tr('ui.ouvrez_une_conversation_pour_consulter_ses_echanges_et_suivre_l_a')
      : tr('ui.retrouvez_une_conversation_et_reprenez_la_ou_vous_en_etiez'),
  );
  const query = $('project-session-search').value.trim().toLocaleLowerCase(getLanguage());
  // Server sessions arrive in stable manual order; preserve it. Ephemeral runs
  // join the top of unpinned until persisted. Activity never reorders.
  const ephemeralRuns = pendingRuns
    .filter((r) => !sessions.some((s) => s.id && s.id === r.sessionId))
    .map((r) => ({
      id: r.sessionId,
      runId: r.id,
      title: r.prompt?.slice(0, 100) || tr('ui.nouvelle_session'),
      cwd: r.cwd,
      updatedAt: r.startedAt,
    }));
  const ordered = [
    ...sessions.filter((s) => s.pinned),
    ...ephemeralRuns,
    ...sessions.filter((s) => !s.pinned),
  ];
  const items = ordered.filter(
    (s) =>
      Boolean(s.archived) === state.archived &&
      (!query || (s.title || '').toLocaleLowerCase(getLanguage()).includes(query)),
  );
  const runningIds = new Set([...state.runs.values()].filter(isRunning).map((r) => r.sessionId));
  const questionRuns = [...state.runs.values()].filter(hasPendingQuestion);
  const unreadIds = items.filter((s) => sessionActivity.isUnread(s.id)).map((s) => s.id);
  const signature = JSON.stringify([
    p.cwd,
    state.readOnly,
    state.archived,
    query,
    items,
    [...runningIds],
    questionRuns.map((run) => [run.id, run.sessionId]),
    unreadIds,
  ]);
  if (signature === projectListSignature) return;
  projectListSignature = signature;
  const root = $('project-session-list');
  root.replaceChildren();
  for (const s of items) {
    const running = Boolean(s.runId || (s.id && runningIds.has(s.id)));
    const waiting = questionRuns.some(
      (run) => (s.runId && run.id === s.runId) || (s.id && run.sessionId === s.id),
    );
    const unread = unreadIds.includes(s.id);
    const card = el('button', `project-session-card${running && !waiting ? ' is-running' : ''}`);
    card.dataset.activity = waiting ? 'question' : running ? 'running' : unread ? 'unread' : 'idle';
    card.type = 'button';
    if (s.id) card.dataset.sessionId = s.id;
    if (s.runId) card.dataset.runId = s.runId;
    card.append(icon(s.archived ? 'archive' : s.pinned ? 'pin' : 'chat', 'project-session-icon'));
    const content = el('span', 'project-session-content');
    content.append(el('span', 'project-session-title', () => s.title || tr('ui.nouvelle_session')));
    const meta = el('span', 'project-session-meta');
    if (waiting) {
      const status = el('span', 'project-session-question');
      status.append(
        activityDot('question'),
        textNode(() => tr('questions.pending')),
      );
      meta.append(status);
    } else if (running) {
      const status = el('span', 'project-session-running');
      status.append(
        el('span', 'running-dot'),
        textNode(() => tr('ui.agent_en_cours')),
      );
      meta.append(status);
    } else if (unread) {
      const status = el('span', 'project-session-unread');
      status.append(
        activityDot('unread'),
        textNode(() => tr('ui.reponse_non_lue')),
      );
      meta.append(status);
    } else if (s.pinned) meta.append(el('span', '', () => tr('ui.epinglee')));
    if (Number.isFinite(s.messageCount))
      meta.append(el('span', '', () => tr('count.messages', { count: s.messageCount })));
    const date = el('time', '', () => dateLabel(s.updatedAt));
    if (toTime(s.updatedAt)) {
      date.dateTime = new Date(toTime(s.updatedAt)).toISOString();
      bindAttribute(date, 'title', () => new Date(toTime(s.updatedAt)).toLocaleString(getLanguage()));
    }
    meta.append(date);
    content.append(meta);
    card.append(content, icon('chevron', 'project-session-chevron'));
    card.onclick = () => {
      if (s.runId) void selectRun(state.runs.get(s.runId));
      else void selectSession(s.id, s.cwd);
    };
    root.append(card);
  }
  if (!items.length) {
    const empty = el('div', 'project-sessions-empty');
    empty.append(
      icon(query ? 'search' : state.archived ? 'archive' : 'chat'),
      el('h2', '', () =>
        query
          ? tr('ui.aucun_resultat')
          : state.archived
            ? tr('ui.aucune_session_archivee_2')
            : tr('ui.votre_premiere_session'),
      ),
      el('p', '', () =>
        query
          ? tr('ui.essayez_un_autre_mot_pour_retrouver_votre_conversation')
          : state.archived
            ? tr('ui.les_conversations_archivees_de_ce_projet_apparaitront_ici')
            : state.readOnly
              ? tr('ui.ce_projet_ne_contient_pas_encore_de_conversation')
              : tr('ui.creez_une_session_pour_commencer_a_travailler_avec_prime_agent'),
      ),
    );
    root.append(empty);
  }
}
function renderDetails() {
  const p = project(),
    s = session(),
    run = activeRun();
  bindText($('header-project'), () => p?.name || tr('ui.espace_de_travail'));
  bindAttribute($('header-project'), 'title', () => p?.cwd || '');
  $('header-project').disabled = !p;
  bindAttribute($('header-project'), 'aria-label', () =>
    p ? tr('ui.afficher_les_sessions_de', { value1: p.name }) : tr('ui.espace_de_travail'),
  );
  bindText(
    $('header-session'),
    () =>
      s?.title ||
      (run
        ? tr('ui.session_en_cours')
        : state.projectOverview
          ? tr('ui.sessions')
          : state.readOnly
            ? tr('ui.consultation_des_sessions')
            : tr('ui.nouvelle_session')),
  );
  bindAttribute($('header-session'), 'title', () => $('header-session').textContent);
  bindAttribute(document, 'title', () =>
    s?.title ? `${s.title} · Prime Agent Studio` : 'Prime Agent Studio',
  );
  bindText(
    $('detail-project-name'),
    () => p?.name || (state.readOnly ? tr('ui.vos_projets') : tr('ui.votre_prochain_projet')),
  );
  bindText(
    $('detail-project-path'),
    () =>
      p?.cwd ||
      (state.readOnly
        ? tr('ui.les_projets_du_studio_sont_accessibles_depuis_le_menu')
        : tr('ui.connectez_un_dossier_local_pour_donner_du_contexte_a_votre_agent')),
  );
  $('copy-project-path').hidden = !p;
  $('detail-project-knowledge').hidden = !p;
  bindText($('welcome-project').lastElementChild, () =>
    p
      ? p.exists === false
        ? tr('ui.dossier_introuvable_2', { value1: p.name })
        : p.name
      : state.readOnly
        ? tr('ui.vos_sessions_apparaitront_ici')
        : tr('ui.ajoutez_un_projet_pour_commencer_2'),
  );
  const status = isRunning(run)
    ? run.status === 'stopping'
      ? tr('ui.arret_en_cours')
      : tr('ui.en_cours')
    : s?.archived
      ? tr('ui.archivee')
      : s
        ? tr('ui.disponible')
        : state.readOnly
          ? tr('ui.consultation')
          : tr('ui.prete_a_demarrer');
  $('detail-status').replaceChildren(
    el('span', `status-dot${s?.archived ? ' waiting' : ''}`),
    textNode(() => translateKnown(status)),
  );
  bindText($('detail-message-count'), () =>
    s || run
      ? String(activeMessages().filter((m) => m.role === 'user' || m.role === 'assistant').length)
      : '—',
  );
  bindText($('detail-updated'), () => dateLabel(s?.updatedAt || run?.startedAt));
  $('detail-session-id').hidden = !state.sessionId;
  bindText($('detail-session-id'), () => (state.sessionId ? `ID ${state.sessionId}` : ''));
  bindAttribute($('detail-session-id'), 'title', () => state.sessionId || '');
  $('session-menu-button').disabled = !state.sessionId;
  $('export-session').hidden = !state.sessionId;
  $('session-state').hidden = !isRunning(run);
  bindText($('session-state'), () => tr('ui.agent_en_cours'));
  const runs = [...state.runs.values()].filter(isRunning);
  $('active-runs-section').hidden = !runs.length;
  $('active-runs').replaceChildren();
  for (const r of runs) {
    const b = el('button', 'active-run');
    b.append(
      el('span', 'spinner'),
      el(
        'span',
        'active-run-label',
        () => session(r.sessionId)?.title || r.prompt?.slice(0, 55) || tr('ui.nouvelle_session'),
      ),
    );
    b.onclick = () => selectRun(r);
    $('active-runs').append(b);
  }
  if (state.online && state.version?.available !== false) {
    if (p?.exists === false)
      banner(
        () =>
          state.readOnly
            ? tr('ui.le_dossier_de_ce_projet_est_introuvable_ses_conversations_restent')
            : tr('ui.le_dossier_de_ce_projet_est_introuvable_ajoutez_son_nouvel_emplac'),
        true,
      );
    else if ($('global-banner').dataset.persistent !== 'true') banner('');
  }
  inspectorUI?.update();
}
function renderNavigation() {
  renderProjects();
  renderSessions();
  renderProjectOverview();
  renderDetails();
  archivesUI?.update();
  updateComposer();
  if ($('open-roadmap')) $('open-roadmap').disabled = !state.projectCwd;
  if ($('detail-project-roadmap')) $('detail-project-roadmap').hidden = !state.projectCwd;
  roadmapUI?.update();
}
marked.setOptions({ gfm: true, breaks: false });
function markdown(text, { cwd = state.projectCwd, basePath = '', imageRoot } = {}) {
  const n = el('div', 'markdown');
  const references = [],
    images = [];
  n.dataset.i18nIgnore = '';
  n.innerHTML = DOMPurify.sanitize(
    marked.parse(String(text || ''), { renderer: fileLinkRenderer(marked, references, images) }),
    {
      USE_PROFILES: { html: true },
      FORBID_TAGS: [
        'style',
        'img',
        'picture',
        'source',
        'form',
        'input',
        'button',
        'textarea',
        'select',
        'iframe',
        'video',
        'audio',
        'object',
        'embed',
        'svg',
        'math',
      ],
      FORBID_ATTR: ['style', 'id', 'name', 'target'],
      ALLOW_DATA_ATTR: false,
      ADD_ATTR: ['data-studio-file', 'data-studio-image'],
    },
  );
  bindFileLinks(n, references, (reference) => inspectorUI?.openDocument(reference, { cwd, basePath }));
  bindInlineImages(n, images, { cwd, basePath, imageRoot });
  n.querySelectorAll('a').forEach((a) => {
    if (a.classList.contains('document-link')) return;
    const href = a.getAttribute('href') || '';
    if (!/^(https?:|mailto:|#|\/)/i.test(href)) {
      a.removeAttribute('href');
      bindAttribute(a, 'title', () => href);
    } else if (/^https?:/i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  });
  n.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    if (!code) return;
    const bar = el('div', 'code-bar'),
      lang = (code.className.match(/language-([\w+#.-]+)/) || [])[1] || 'code';
    bar.append(el('span', '', () => lang));
    const b = el('button', 'copy-code');
    b.type = 'button';
    b.append(
      icon('copy'),
      textNode(() => tr('ui.copier')),
    );
    b.onclick = () => copyText(code.textContent, () => tr('ui.code_copie'));
    bar.append(b);
    pre.prepend(bar);
  });
  return n;
}
function stringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v.content))
    return v.content
      .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[Image]' : JSON.stringify(c)))
      .join('\n');
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
const openDetails = new Map();
function makeDetails(className, key, defaultOpen = false) {
  const d = el('details', className);
  d.open = openDetails.get(key) ?? defaultOpen;
  d.addEventListener('toggle', () => {
    if (d.isConnected) openDetails.set(key, d.open);
  });
  return d;
}
function renderTool(t, messageId) {
  const d = makeDetails('tool-block', `tool:${t.id || messageId}`),
    summary = el('summary');
  const status =
    t.status === 'running'
      ? tr('ui.en_cours')
      : t.isError
        ? tr('common.error')
        : t.status === 'pending'
          ? tr('ui.preparation')
          : tr('ui.termine');
  summary.append(
    icon(t.status === 'running' ? 'terminal' : 'tool'),
    el('span', 'tool-name', () => t.name || tr('common.tool')),
    el('span', `tool-status${t.isError ? ' error' : ''}`, () => translateKnown(status)),
    icon('chevron', 'chevron'),
  );
  d.append(summary);
  const content = el('div', 'tool-content');
  if (t.name === 'question') {
    let result;
    try {
      result = JSON.parse(t.result);
    } catch {
      /* Pending native result. */
    }
    content.append(el('p', '', () => result?.question || t.args?.question || tr('questions.title')));
    content.append(
      el('p', '', () =>
        result
          ? result.answer
            ? `${tr('questions.answered')} ${result.answer}`
            : tr('questions.closed')
          : tr('questions.waiting'),
      ),
    );
    d.append(content);
    return d;
  }
  if (t.args != null)
    content.append(
      el('h4', '', () => tr('ui.parametres')),
      el('pre', '', () => stringify(t.args)),
    );
  if (t.result != null)
    content.append(
      el('h4', '', () => tr('ui.resultat_2')),
      el('pre', '', () => stringify(t.result)),
    );
  if (!content.childNodes.length) content.append(el('pre', '', () => tr('ui.en_attente_du_resultat')));
  d.append(content);
  return d;
}
const messageNodes = new Map();
function renderMessage(m, index) {
  const id = m.id || `history-${index}`,
    signature = JSON.stringify(m),
    old = messageNodes.get(id);
  if (old?.signature === signature) return old.node;
  const agent = m.agentMessage || (m.role === 'system' ? parseAgentEnvelope(m.text) : null);
  if (agent) {
    const card = el('article', 'message system agent-message');
    card.dataset.messageId = id;
    const disclosure = makeDetails('agent-message-disclosure', `agent-message:${id}`);
    const summary = el('summary', 'agent-message-summary');
    const header = el('span', 'agent-message-heading');
    header.append(
      el('span', 'agent-message-author', () => agent.name || tr('agents.message_title')),
      el('span', 'agent-message-badge', () =>
        tr(
          agent.relationship === 'child'
            ? 'agents.message_child'
            : agent.relationship === 'parent'
              ? 'agents.parent'
              : 'agents.message_title',
        ),
      ),
      el('span', 'message-time', () => dateLabel(m.timestamp)),
    );
    const body = el('div', 'agent-message-body');
    const content = markdown(agent.text);
    const preview = el('span', 'agent-message-preview', () =>
      content.textContent.replace(/\s+/g, ' ').trim(),
    );
    summary.append(icon('chevron', 'agent-message-chevron'), header, preview);
    body.append(content);
    const details = makeDetails('agent-message-details', `agent-source:${id}`);
    details.append(el('summary', '', () => tr('agents.details')));
    const metadata = el('dl');
    for (const [label, value] of [
      ['agents.sender', agent.sender],
      ['agents.recipient', agent.target],
      ['agents.identifier', agent.id],
    ]) {
      if (value)
        metadata.append(
          el('dt', '', () => tr(label)),
          el('dd', '', () => value),
        );
    }
    details.append(metadata);
    body.append(details);
    disclosure.append(summary, body);
    card.append(disclosure);
    messageNodes.set(id, { node: card, signature });
    return card;
  }
  const n = el('article', `message ${['assistant', 'user'].includes(m.role) ? m.role : 'system'}`);
  n.dataset.messageId = id;
  const heading = el('div', 'message-heading'),
    avatar = el('span', 'message-avatar');
  avatar.append(m.role === 'user' ? icon('user') : icon('model'));
  heading.append(
    avatar,
    el('span', 'message-author', () =>
      m.role === 'user' ? tr('ui.vous') : m.role === 'assistant' ? 'Prime Agent' : tr('ui.contexte'),
    ),
  );
  if (m.model) {
    const model = el('span', 'message-model', () => String(m.model).split('/').pop());
    bindAttribute(model, 'title', () => String(m.model));
    heading.append(model);
  }
  heading.append(el('span', 'message-time', () => dateLabel(m.timestamp)));
  n.append(heading);
  const body = el('div', 'message-body');
  if (m.role === 'user') bindText(body, () => m.text || '');
  else {
    if (m.thinking) {
      const d = makeDetails('thinking-block', `thinking:${id}`, reasoningMode(prefs) === 'expanded'),
        s = el('summary');
      s.append(
        icon('brain'),
        el('span', '', () => (m.streaming ? tr('ui.reflexion_en_cours') : tr('ui.raisonnement'))),
        icon('chevron', 'chevron'),
      );
      const content = el('div', 'thinking-content reasoning-markdown');
      content.append(markdown(m.thinking));
      d.hidden = reasoningMode(prefs) === 'hidden';
      d.append(s, content);
      body.append(d);
    }
    if (m.text) body.append(markdown(m.text));
    for (const tool of m.tools || []) body.append(renderTool(tool, id));
    if (translateKnown(m.error)) body.append(el('div', 'message-error', () => translateKnown(m.error)));
    if (m.streaming) body.append(el('span', 'stream-caret'));
    if (!m.text && !m.thinking && !m.tools?.length && !translateKnown(m.error) && !m.streaming)
      body.append(
        el('span', '', () =>
          m.stopReason === 'aborted' ? tr('ui.reponse_interrompue') : tr('ui.aucun_contenu_textuel'),
        ),
      );
  }
  if (m.attachments?.length) body.append(renderImages(m.attachments));
  n.append(body);
  if (m.text) {
    const actions = el('div', 'message-actions'),
      b = el('button', '');
    b.append(
      icon('copy'),
      textNode(() => tr('ui.copier')),
    );
    b.onclick = () => copyText(m.text, () => tr('ui.message_copie'));
    actions.append(b);
    n.append(actions);
  }
  messageNodes.set(id, { node: n, signature });
  return n;
}
const conversationRenderer = createConversationRenderer({
  renderInteractions: (message) => questionsUI?.partsFor(message) || [],
  el,
  icon,
  markdown,
  renderTool,
  makeDetails,
  dateLabel,
  copyText,
  reasoningMode: () => reasoningMode(prefs),
  renderMessage,
});
function nearBottom() {
  const s = $('conversation-scroll');
  return s.scrollHeight - s.scrollTop - s.clientHeight < 110;
}
// True only at the actual bottom. Follow mode reattaches exclusively here, so even a
// small upward gesture inside the generous nearBottom() band still detaches.
function atConversationBottom() {
  const s = $('conversation-scroll');
  return s.scrollHeight - s.scrollTop - s.clientHeight < 3;
}
function markVisibleSessionRead() {
  if (
    document.hidden ||
    state.loading ||
    state.projectOverview ||
    !state.sessionId ||
    isRunning(activeRun()) ||
    !nearBottom() ||
    document.querySelector('dialog[open], #sidebar.mobile-open, #details-panel.mobile-open')
  )
    return;
  if (sessionActivity.markRead(state.sessionId, activeMessages())) {
    renderProjects();
    renderSessions();
    renderProjectOverview();
  }
}
async function syncSessionActivity() {
  const token = state.requestId;
  const histories = await sessionActivity.sync(allSessions(), [...state.runs.values()]);
  const current = histories.find((history) => history.id === state.sessionId);
  if (current && token === state.requestId && !state.loading && !state.viewRunId && !isRunning(activeRun())) {
    state.history = current.messages || [];
    renderMessages();
  }
  markVisibleSessionRead();
  renderProjects();
  renderSessions();
  renderProjectOverview();
}
function scrollBottom(smooth = false) {
  cancelAnimationFrame(bottomScrollFrame);
  bottomScrollFrame = 0;
  followConversation = true;
  $('conversation-scroll').scrollTo({
    top: $('conversation-scroll').scrollHeight,
    behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant',
  });
  $('scroll-bottom').hidden = true;
  markVisibleSessionRead();
}
function detachConversation() {
  followConversation = false;
  cancelAnimationFrame(bottomScrollFrame);
  bottomScrollFrame = 0;
  lastConversationTop = $('conversation-scroll').scrollTop;
  $('scroll-bottom').hidden = state.projectOverview || atConversationBottom();
}
let renderScheduled = false;
let bottomScrollFrame = 0;
let followConversation = true;
let lastConversationTop = 0;
function scheduleMessages() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderMessages();
    renderDetails();
    updateComposer();
  });
}
function renderMessages(forceScroll = false) {
  cancelAnimationFrame(bottomScrollFrame);
  bottomScrollFrame = 0;
  if (forceScroll) {
    // Explicit navigation / new-run switches always restart from the bottom.
    followConversation = true;
  }
  const stick = forceScroll || followConversation,
    messages = activeMessages();
  $('welcome').hidden = state.projectOverview || messages.length > 0 || state.loading;
  $('conversation-loading').hidden = !state.loading;
  $('messages').hidden = state.projectOverview || state.loading;
  const root = $('messages'),
    keep = new Set();
  questionsUI?.update();
  conversationRenderer.render(root, messages);
  messages.forEach((m, i) => keep.add(m.id || `history-${i}`));
  for (const key of messageNodes.keys()) if (!keep.has(key)) messageNodes.delete(key);
  if (!messages.length && !state.loading) {
    $('conversation-scroll').scrollTop = 0;
    $('scroll-bottom').hidden = true;
  } else if (stick)
    // Re-check followConversation when the frame fires: the user may have scrolled up
    // between render and paint, and scrollBottom() itself would otherwise reattach.
    bottomScrollFrame = requestAnimationFrame(() => {
      bottomScrollFrame = 0;
      if (followConversation) scrollBottom();
    });
  else $('scroll-bottom').hidden = state.projectOverview || atConversationBottom();
}
function closeSidebar() {
  $('sidebar').classList.remove('mobile-open');
  $('mobile-backdrop').hidden = true;
}
function openSidebar() {
  $('sidebar').classList.add('mobile-open');
  $('mobile-backdrop').hidden = false;
}
function resetView() {
  state.history = [];
  state.viewRunId = null;
  state.sessionId = null;
  state.loading = false;
  state.projectOverview = false;
  state.requestId++;
  messageNodes.clear();
}
function newSession() {
  if (state.readOnly) return;
  saveDraft();
  resetView();
  selectNewConversationModel();
  state.archived = false;
  saveSelection();
  restoreDraft();
  renderNavigation();
  renderMessages(true);
  closeSidebar();
  if (!state.projectCwd) openProjectDialog();
  else $('composer').focus();
}
function selectProject(cwd) {
  saveDraft();
  resetView();
  state.projectCwd = cwd;
  restoreGenerationSettings(null, null);
  projectNavigation?.reveal(cwd);
  state.projectOverview = true;
  state.archived = false;
  $('session-search').value = '';
  $('project-session-search').value = '';
  saveSelection();
  restoreDraft();
  renderNavigation();
  renderMessages(true);
  closeSidebar();
  $('project-overview-title').focus({ preventScroll: true });
}
function historyBeforeRun(messages, run) {
  const start = toTime(run.startedAt);
  let i = messages.findIndex(
    (m) => m.role === 'user' && m.text?.trim() === run.prompt?.trim() && toTime(m.timestamp) >= start - 1000,
  );
  if (i < 0) i = messages.findIndex((m) => toTime(m.timestamp) >= start);
  return i < 0 ? messages : messages.slice(0, i);
}
async function selectSession(id, cwd) {
  saveDraft();
  const token = ++state.requestId;
  state.sessionId = id;
  state.projectOverview = false;
  state.projectCwd = cwd || session(id)?.cwd || state.projectCwd;
  projectNavigation?.reveal(state.projectCwd);
  state.viewRunId = null;
  state.history = [];
  state.loading = true;
  restoreGenerationSettings(
    session(id),
    [...state.runs.values()].find((r) => r.sessionId === id && isRunning(r)),
  );
  messageNodes.clear();
  closeSidebar();
  saveSelection();
  restoreDraft();
  renderNavigation();
  renderMessages(true);
  const running = [...state.runs.values()].find((r) => r.sessionId === id && isRunning(r));
  try {
    let h;
    try {
      h = await api(`/api/history?id=${encodeURIComponent(id)}`);
    } catch (e) {
      if (e.status === 404 && running) h = { messages: [] };
      else throw e;
    }
    if (token !== state.requestId) return;
    state.history = h.messages || [];
    if (h.id && !running) sessionActivity.observe(h);
    if (running) {
      state.viewRunId = running.id;
      if (!running.initialized) initializeRun(running, state.history);
      subscribe(running);
    }
    restoreGenerationSettings(h, running);
    state.loading = false;
    renderNavigation();
    renderMessages(true);
    saveSelection();
  } catch (e) {
    if (token !== state.requestId) return;
    state.loading = false;
    renderMessages();
    banner(translateKnown(e.message), true);
    toast(translateKnown(e.message), true);
  }
}
async function selectRun(run) {
  if (run.sessionId) return selectSession(run.sessionId, run.cwd);
  saveDraft();
  resetView();
  state.projectCwd = run.cwd;
  projectNavigation?.reveal(run.cwd);
  state.viewRunId = run.id;
  restoreGenerationSettings(null, run);
  if (!run.initialized) initializeRun(run, []);
  subscribe(run);
  restoreDraft();
  saveSelection();
  renderNavigation();
  renderMessages(true);
  closeSidebar();
}
function initializeRun(run, history) {
  run.initialized = true;
  run.base = historyBeforeRun(history, run);
  run.messages = [
    { id: `${run.id}-user`, role: 'user', text: run.prompt || '', timestamp: run.startedAt, tools: [] },
  ];
  run.lastSeq = 0;
  run.currentMessage = null;
  run.initialUserEchoSeen = false;
}
function upsertSession(id, run) {
  if (!id) return;
  let p = state.projects.find((p) => samePath(p.cwd, run.cwd));
  if (!p) {
    p = { cwd: run.cwd, name: run.cwd.split(/[\\/]/).pop(), exists: true, sessions: [] };
    state.projects.push(p);
  }
  if (!p.sessions.some((s) => s.id === id)) {
    // Transient optimistic row matches server top-of-unpinned until refresh.
    const entry = {
      id,
      cwd: run.cwd,
      title: run.prompt?.replace(/\s+/g, ' ').slice(0, 100) || tr('ui.nouvelle_session'),
      createdAt: run.startedAt,
      updatedAt: run.startedAt,
    };
    const pinnedCount = p.sessions.filter((s) => s.pinned).length;
    p.sessions.splice(pinnedCount, 0, entry);
  }
}
function ensureAssistant(run, seq) {
  if (!run.currentMessage || !run.currentMessage.streaming) {
    const m = {
      id: `${run.id}-${seq}`,
      role: 'assistant',
      text: '',
      thinking: '',
      tools: [],
      timestamp: new Date().toISOString(),
      streaming: true,
    };
    run.messages.push(m);
    run.currentMessage = m;
  }
  return run.currentMessage;
}
function findTool(run, id) {
  for (let i = run.messages.length - 1; i >= 0; i--) {
    const t = run.messages[i].tools?.find((t) => t.id === id);
    if (t) return t;
  }
  return null;
}
function applyRunEvent(run, e) {
  if (e.seq && e.seq <= run.lastSeq) return;
  if (e.seq) run.lastSeq = e.seq;
  switch (e.kind) {
    case 'interaction': {
      run.interactions ||= [];
      const index = run.interactions.findIndex((item) => item.id === e.request.id);
      if (index < 0) run.interactions.push(e.request);
      else run.interactions[index] = e.request;
      renderNavigation();
      break;
    }
    case 'session':
      run.sessionId = e.sessionId;
      upsertSession(e.sessionId, run);
      if (state.viewRunId === run.id) {
        saveDraft();
        state.sessionId = e.sessionId;
        saveSelection();
        saveDraft();
      }
      renderNavigation();
      break;
    case 'message_start':
      if (e.role === 'assistant') {
        if (run.currentMessage) run.currentMessage.streaming = false;
        ensureAssistant(run, e.seq);
      }
      break;
    case 'text':
      ensureAssistant(run, e.seq).text += e.delta || '';
      break;
    case 'thinking':
      ensureAssistant(run, e.seq).thinking += e.delta || '';
      break;
    case 'message': {
      const incoming = translateKnown(e.message) || {};
      if (incoming.role === 'assistant') {
        const m = ensureAssistant(run, e.seq),
          known = new Map((m.tools || []).map((t) => [t.id, t]));
        Object.assign(m, incoming, {
          id: m.id,
          streaming: false,
          tools: (incoming.tools || []).map((t) => ({ ...t, ...known.get(t.id) })),
        });
        run.currentMessage = null;
      } else if (incoming.role === 'user') {
        const user = run.messages.find((m) => m.role === 'user');
        if (!run.initialUserEchoSeen && user) {
          Object.assign(user, incoming, { id: user.id });
        } else {
          if (run.currentMessage) run.currentMessage.streaming = false;
          run.currentMessage = null;
          run.messages.push({ ...incoming, id: `${run.id}-user-${e.seq}` });
        }
        run.initialUserEchoSeen = true;
      } else if (incoming.role === 'system') {
        run.messages.push({ ...incoming, id: `${run.id}-system-${e.seq}`, tools: [] });
      } else if (incoming.role === 'toolResult') {
        const t = findTool(run, incoming.toolCallId);
        if (t)
          Object.assign(t, {
            result: incoming.text,
            isError: incoming.isError,
            status: incoming.isError ? 'error' : 'done',
          });
      }
      break;
    }
    case 'tool_start': {
      let t = findTool(run, e.id);
      if (!t) {
        let m = run.messages.findLast((m) => m.role === 'assistant');
        if (!m) m = ensureAssistant(run, e.seq);
        t = { id: e.id };
        m.tools.push(t);
      }
      Object.assign(t, { name: e.name, args: e.args, status: 'running' });
      break;
    }
    case 'tool_update':
    case 'tool_end': {
      const t = findTool(run, e.id);
      if (t)
        Object.assign(t, {
          result: e.result,
          isError: e.isError,
          status: e.kind === 'tool_end' ? (e.isError ? 'error' : 'done') : 'running',
        });
      break;
    }
    case 'runtime':
    case 'status':
      run.statusLabel =
        e.status === 'compacting'
          ? tr('ui.optimisation_du_contexte')
          : e.status === 'retrying'
            ? tr('ui.nouvelle_tentative_en_cours')
            : tr('ui.l_agent_travaille');
      break;
    case 'replay_truncated':
      if (state.viewRunId === run.id)
        toast(() => tr('ui.le_debut_de_cette_execution_sera_recharge_depuis_l_historique_a_l'));
      break;
    case 'done':
      void finishRun(run, e);
      break;
  }
  if (state.viewRunId === run.id) scheduleMessages();
}
function subscribe(run) {
  if (run.source || run.replayedDone) return;
  if (!run.initialized) initializeRun(run, []);
  const source = new EventSource(`/api/runs/${encodeURIComponent(run.id)}/events?after=${run.lastSeq || 0}`);
  run.source = source;
  source.onmessage = (e) => {
    try {
      applyRunEvent(run, JSON.parse(e.data));
    } catch (error) {
      translateKnown(console.error)(tr('ui.evenement_prime_agent_invalide'), error);
    }
  };
  source.onopen = () => {
    if (run.disconnected) run.statusLabel = tr('ui.l_agent_travaille');
    run.disconnected = false;
    if (state.viewRunId === run.id) updateComposer();
  };
  source.onerror = () => {
    if (!isRunning(run)) {
      source.close();
      run.source = null;
      return;
    }
    run.disconnected = true;
    run.statusLabel = tr('ui.reconnexion_a_l_agent');
    if (state.viewRunId === run.id) updateComposer();
    void refreshOverview();
  };
}
async function finishRun(run, e) {
  run.replayedDone = true;
  run.status = e.status || 'completed';
  if (run.status === 'failed') void refreshModelCatalog();
  run.endedAt = new Date().toISOString();
  run.source?.close();
  run.source = null;
  for (const m of run.messages) m.streaming = false;
  if (e.sessionId) {
    run.sessionId = e.sessionId;
    upsertSession(e.sessionId, run);
  }
  if (translateKnown(e.error)) {
    run.messages.push({
      id: `${run.id}-error`,
      role: 'system',
      text: e.error,
      tools: [],
      timestamp: run.endedAt,
    });
    toast(translateKnown(e.error), true);
  } else if (e.status === 'stopped' || e.status === 'cancelled') toast(() => tr('ui.l_agent_a_ete_arrete'));
  if (state.viewRunId === run.id) {
    state.sessionId = run.sessionId || state.sessionId;
    state.history = [...run.base, ...run.messages];
    saveSelection();
    scheduleMessages();
    if (run.sessionId) {
      try {
        const h = await api(`/api/history?id=${encodeURIComponent(run.sessionId)}`);
        sessionActivity.observe(h);
        if (state.viewRunId === run.id && h.messages?.length) {
          state.history = h.messages;
          if (translateKnown(e.error))
            state.history.push({
              id: `${run.id}-error`,
              role: 'system',
              text: e.error,
              tools: [],
              timestamp: run.endedAt,
            });
          state.viewRunId = null;
          scheduleMessages();
        }
      } catch {}
    }
  }
  await refreshOverview();
  renderNavigation();
}
async function sendMessage(event) {
  event?.preventDefault();
  if (state.readOnly || state.sending) return;
  if (await commandsUI?.intercept()) return;
  if (isRunning(activeRun())) return liveMessagesUI?.submitDraft();
  if (state.readOnly || $('send-button').disabled || state.sending) return;
  const imageDraft = imageComposer?.snapshot();
  const images = imageDraft?.images || [];
  const files = imageDraft?.files || [];
  const originalDraft = composerText(),
    originalDraftKey = draftKey();
  const message =
      originalDraft.trim() || (images.length || files.length ? tr('ui.analyse_les_pieces_jointes') : ''),
    cwd = state.projectCwd,
    sessionId = state.sessionId,
    base = [...activeMessages()],
    token = state.requestId;
  state.sending = true;
  updateComposer();
  try {
    const run = await api('/api/runs', {
      method: 'POST',
      body: {
        cwd,
        message,
        ...(images.length ? { images } : {}),
        ...(files.length ? { files } : {}),
        ...(sessionId ? { sessionId } : {}),
        model: $('model-select').value || state.modelCatalogDefault || '',
        thinking: $('thinking-select').value || state.modelCatalogThinking || '',
        allowQuestions: $('allow-questions').checked,
      },
    });
    Object.assign(run, {
      initialized: true,
      base,
      messages: [
        {
          id: `${run.id}-user`,
          role: 'user',
          text: message,
          attachments: [...images, ...(run.attachments || [])],
          tools: [],
          timestamp: run.startedAt,
        },
      ],
      lastSeq: 0,
      currentMessage: null,
    });
    state.runs.set(run.id, run);
    generationDrafts.delete(normalizedPath(cwd));
    if (imageDraft) imageComposer.accepted(imageDraft);
    if (run.sessionId) upsertSession(run.sessionId, run);
    acceptDraft(originalDraftKey, originalDraft);
    if (token === state.requestId) {
      state.viewRunId = run.id;
      state.sessionId = run.sessionId || sessionId;
      saveSelection();
      resizeComposer();
      renderMessages(true);
    }
    subscribe(run);
    renderNavigation();
  } catch (e) {
    toast(translateKnown(e.message), true);
  } finally {
    state.sending = false;
    updateComposer();
  }
}
async function stopRun() {
  if (state.readOnly) return;
  const r = activeRun();
  if (!isRunning(r) || r.status === 'stopping') return;
  r.status = 'stopping';
  renderNavigation();
  updateComposer();
  renderDetails();
  try {
    await api(`/api/runs/${encodeURIComponent(r.id)}/stop`, { method: 'POST', body: {} });
  } catch (e) {
    r.status = 'running';
    renderNavigation();
    toast(translateKnown(e.message), true);
    updateComposer();
  }
}
let overviewPromise = null,
  overviewQueued = false;
function refreshOverview() {
  if (overviewPromise) {
    overviewQueued = true;
    return overviewPromise;
  }
  overviewPromise = (async () => {
    do {
      overviewQueued = false;
      try {
        const data = await api('/api/overview');
        applyStudioPreferences(data.studioPreferences);
        state.projects = data.projects || [];
        const remoteRuns = data.runs || [];
        for (const remote of remoteRuns) {
          const existing = state.runs.get(remote.id);
          if (existing) Object.assign(existing, remote);
          else state.runs.set(remote.id, remote);
        }
        for (const run of state.runs.values()) {
          if (
            isRunning(run) &&
            !remoteRuns.some((r) => r.id === run.id) &&
            (!run.source || run.disconnected)
          ) {
            run.status = 'interrupted';
            run.source?.close();
            run.source = null;
            for (const m of run.messages || []) m.streaming = false;
            if (state.viewRunId === run.id) {
              toast(() => tr('ui.cette_execution_n_est_plus_active_l_historique_enregistre_a_ete_c'), true);
              if (run.sessionId) void selectSession(run.sessionId, run.cwd);
              else scheduleMessages();
            }
          }
        }
        setConnection(true);
        renderNavigation();
        await syncSessionActivity();
      } catch {
        setConnection(false);
      }
    } while (overviewQueued);
  })().finally(() => {
    overviewPromise = null;
  });
  return overviewPromise;
}
function modelConfigNumber(value) {
  return new Intl.NumberFormat('fr-FR').format(value || 0);
}
function updateModelsAfterConfiguration(data, removedId = '') {
  if (!data?.catalog) return;
  const selected = $('model-select').value;
  populateModels(data.catalog);
  if (selected && selected !== removedId && state.models.some((model) => model.id === selected))
    setSelectedModel(selected);
  renderModelDefaults();
}
function renderModelDefaults() {
  selectDefaultModel(state.modelDefaults?.mainModel || '');
}
function selectDefaultModel(id) {
  const button = $('default-main-model'),
    model = state.models.find((item) => item.id === id),
    name = model?.name || (id ? tr('common.unavailable', { value1: id }) : tr('ui.choix_automatique'));
  button.value = id;
  bindText(button.querySelector('.model-picker-name'), () => name);
  bindText(
    button.querySelector('.model-picker-provider'),
    () => model?.provider || (id ? tr('ui.modele_indisponible') : tr('ui.configuration_prime_agent')),
  );
  bindAttribute(button, 'title', () => id || tr('ui.choix_automatique_de_prime_agent'));
  bindAttribute(button, 'aria-label', () =>
    tr('ui.modele_principal_par_defaut', { value1: name, value2: model ? ', ' + model.id : '' }),
  );
  $('save-default-model').disabled = id === (state.modelDefaults?.mainModel || '');
}
function renderModelConfig() {
  const configuration = state.modelConfig || { models: [] },
    models = configuration.models || [],
    list = $('custom-model-list');
  bindText($('model-config-count'), () =>
    models.length ? tr('count.models', { count: models.length }) : tr('ui.aucun_modele_configure'),
  );
  $('model-config-empty').hidden = models.length > 0;
  list.replaceChildren();
  const apiNames = new Map((configuration.apis || []).map((item) => [item.id, item.name]));
  models.forEach((model, index) => {
    const card = el('article', 'custom-model-card'),
      symbol = el('div', 'custom-model-symbol'),
      copy = el('div', 'custom-model-copy'),
      title = el('div', 'custom-model-title'),
      badges = el('div', 'custom-model-badges'),
      actions = el('div', 'custom-model-actions'),
      editButton = el('button', 'secondary-button', () => ''),
      deleteButton = el('button', 'model-config-delete', () => '');
    symbol.append(icon('model'));
    title.append(
      el('strong', '', () => model.name),
      el('code', '', () => `${model.provider}/${model.id}`),
    );
    badges.append(
      el('span', '', () => apiNames.get(model.api) || model.api || tr('ui.api_heritee')),
      el('span', '', () => tr('model.tokens', { value1: modelConfigNumber(model.contextWindow) })),
    );
    if (model.reasoning) badges.append(el('span', '', () => tr('ui.raisonnement')));
    if (model.input?.includes('image')) badges.append(el('span', '', () => tr('ui.images')));
    if (!model.authenticationAvailable)
      badges.append(el('span', 'warning', () => tr('ui.identification_a_verifier')));
    if (!model.editable)
      badges.append(el('span', 'warning', () => tr('ui.options_avancees_en_lecture_seule')));
    copy.append(title, badges);
    editButton.type = 'button';
    editButton.dataset.editModel = String(index);
    editButton.disabled = !model.editable;
    bindAttribute(editButton, 'aria-label', () => tr('common.editName', { value1: model.name }));
    editButton.append(
      icon('pencil'),
      textNode(() => tr('ui.modifier')),
    );
    deleteButton.type = 'button';
    deleteButton.dataset.deleteModel = String(index);
    bindAttribute(deleteButton, 'aria-label', () => tr('common.deleteName', { value1: model.name }));
    deleteButton.append(
      icon('x'),
      textNode(() => tr('ui.supprimer')),
    );
    actions.append(editButton, deleteButton);
    card.append(symbol, copy, actions);
    list.append(card);
  });
}
function showModelConfigList(focus = false) {
  $('model-config-form').hidden = true;
  $('model-config-list-view').hidden = false;
  state.modelConfigOriginal = null;
  if (focus) $('add-custom-model').focus();
}
function showModelConfigForm(model = null) {
  state.modelConfigOriginal = model ? { provider: model.provider, id: model.id } : null;
  $('model-config-list-view').hidden = true;
  $('model-config-form').hidden = false;
  bindText($('model-config-form-title'), () =>
    model ? tr('ui.modifier_le_modele') : tr('ui.ajouter_un_modele'),
  );
  $('custom-model-provider').value = model?.provider || '';
  $('custom-model-id').value = model?.id || '';
  $('custom-model-name').value = model?.name || '';
  $('custom-model-api').value = model?.api || 'openai-responses';
  $('custom-model-url').value = model?.baseUrl || '';
  $('custom-model-credential').value = model?.credentialEnv || '';
  bindAttribute($('custom-model-credential'), 'placeholder', () =>
    model?.credentialConfigured ? tr('ui.identification_existante_conservee') : tr('example.keyVariable'),
  );
  $('custom-model-context').value = String(model?.contextWindow || 128000);
  $('custom-model-output').value = String(model?.maxTokens || 16384);
  $('custom-model-reasoning').checked = model?.reasoning === true;
  $('custom-model-image').checked = model?.input?.includes('image') === true;
  $('model-config-error').hidden = true;
  requestAnimationFrame(() => $(model ? 'custom-model-name' : 'custom-model-provider').focus());
}
async function openModelConfig() {
  if (state.remote) {
    toast(() => tr('ui.la_configuration_des_modeles_est_disponible_uniquement_sur_l_ordi'), true);
    return;
  }
  $('settings-dialog').close();
  $('model-config-loading').hidden = false;
  bindText($('model-config-loading'), () => tr('ui.chargement_de_la_configuration'));
  $('model-config-content').hidden = true;
  $('model-config-dialog').showModal();
  try {
    [state.modelConfig, state.modelDefaults] = await Promise.all([
      api('/api/model-config'),
      api('/api/model-defaults'),
    ]);
    renderModelConfig();
    renderModelDefaults();
    void subagentSettings.open();
    showModelConfigList();
    $('model-config-loading').hidden = true;
    $('model-config-content').hidden = false;
    requestAnimationFrame(() => $('default-main-model').focus());
  } catch (error) {
    const message =
      error.status === 404
        ? tr('ui.le_serveur_en_cours_doit_etre_redemarre_pour_activer_le_configura')
        : tr('ui.impossible_de_charger_la_configuration', { value1: translateKnown(error.message) });
    bindText($('model-config-loading'), () => message);
    toast(message, true);
  }
}
async function saveDefaultModel() {
  const button = $('save-default-model'),
    model = $('default-main-model').value;
  button.disabled = true;
  $('default-main-model').disabled = true;
  try {
    const data = await api('/api/model-defaults', { method: 'POST', body: { model } });
    state.modelDefaults = {
      mainModel: data.mainModel,
      subagents: data.subagents,
    };
    if (data.catalog) populateModels(data.catalog);
    renderModelDefaults();
    toast(() =>
      data.mainModel
        ? tr('ui.le_modele_par_defaut_de_l_agent_principal_a_ete_enregistre')
        : tr('ui.prime_agent_choisira_automatiquement_le_modele_principal'),
    );
  } catch (error) {
    button.disabled = false;
    toast(
      () => tr('ui.impossible_d_enregistrer_le_modele_par_defaut', { value1: translateKnown(error.message) }),
      true,
    );
  } finally {
    $('default-main-model').disabled = false;
  }
}

async function saveModelConfiguration(event) {
  event.preventDefault();
  const form = $('model-config-form');
  if (!form.reportValidity()) return;
  const button = $('save-model-config'),
    body = {
      provider: $('custom-model-provider').value.trim().toLowerCase(),
      id: $('custom-model-id').value.trim(),
      name: $('custom-model-name').value.trim(),
      api: $('custom-model-api').value,
      baseUrl: $('custom-model-url').value.trim(),
      credentialEnv: $('custom-model-credential').value.trim(),
      reasoning: $('custom-model-reasoning').checked,
      input: $('custom-model-image').checked ? ['text', 'image'] : ['text'],
      contextWindow: Number($('custom-model-context').value),
      maxTokens: Number($('custom-model-output').value),
      ...(state.modelConfigOriginal ? { original: state.modelConfigOriginal } : {}),
    };
  button.disabled = true;
  $('model-config-error').hidden = true;
  try {
    const data = await api('/api/model-config', { method: 'POST', body });
    state.modelConfig = data;
    updateModelsAfterConfiguration(data);
    renderModelConfig();
    showModelConfigList(true);
    toast(() => tr('ui.a_ete_enregistre', { value1: body.name }));
  } catch (error) {
    bindText($('model-config-error'), () => translateKnown(error.message));
    $('model-config-error').hidden = false;
  } finally {
    button.disabled = false;
  }
}
async function deleteModelConfiguration(index) {
  const model = state.modelConfig?.models?.[index];
  if (!model || !confirm(tr('ui.supprimer_de_prime_agent', { value1: model.name }))) return;
  try {
    const data = await api('/api/model-config', {
      method: 'DELETE',
      body: { provider: model.provider, id: model.id },
    });
    state.modelConfig = data;
    updateModelsAfterConfiguration(data, `${model.provider}/${model.id}`);
    renderModelConfig();
    toast(() => tr('ui.a_ete_supprime', { value1: model.name }));
  } catch (error) {
    toast(() => tr('ui.impossible_de_supprimer_ce_modele', { value1: translateKnown(error.message) }), true);
  }
}
function populateModels(catalog, { preserveSelection = false } = {}) {
  const selected = $('model-select').value,
    thinking = $('thinking-select').value;
  state.models = Array.isArray(catalog?.models) ? catalog.models : [];
  state.configuredProviders = Array.isArray(catalog?.configuredProviders)
    ? catalog.configuredProviders
    : null;
  state.modelCatalogDefault = typeof catalog?.default?.model === 'string' ? catalog.default.model : '';
  state.modelCatalogThinking = catalog?.default?.thinking || '';
  state.modelCatalogRefreshing = catalog?.refreshing === true;
  state.modelCatalogNotice = '';
  const select = $('model-select');
  select.replaceChildren();
  const option = el('option', '', () => tr('ui.modele_par_defaut'));
  option.value = '';
  select.append(option);
  const groups = new Map();
  for (const model of state.models) {
    if (!groups.has(model.provider)) {
      const group = el('optgroup');
      group.label = model.provider;
      groups.set(model.provider, group);
      select.append(group);
    }
    const item = el('option', '', () => model.name || model.id);
    item.value = model.id;
    item.disabled = model.availability === 'unavailable';
    groups.get(model.provider).append(item);
  }
  if (preserveSelection) setSelectedModel(selected, false, false);
  else restoreGenerationSettings();
  if (preserveSelection) $('thinking-select').value = thinking;
  if ($('model-dialog').open) renderModelList({ preserveFocus: true });
  renderModelRefresh();
  renderConfigurationWarning();
}
function selectNewConversationModel() {
  restoreGenerationSettings(null, null);
}
async function bootstrap() {
  try {
    const data = await api('/api/bootstrap');
    state.studioPreferences = data.studioPreferences;
    state.attachmentsAvailable = data.preferences?.attachments === true;
    state.inspectorAvailable = data.preferences?.inspector === true;
    state.nativeFileOpen = data.preferences?.nativeFileOpen === true;
    state.providersAvailable = data.preferences?.providers === true;
    state.directoryPickerAvailable = data.preferences?.directoryPicker === true && !data.preferences?.remote;
    state.readOnly = data.preferences?.readOnly === true;
    state.remote = data.preferences?.remote === true || state.readOnly;
    applyAccessMode();
    state.projects = data.projects || [];
    sessionActivity.initialize(allSessions());
    state.version = data.version || {};
    for (const run of data.runs || []) state.runs.set(run.id, run);
    populateModels(data.models);
    state.projectCwd =
      state.projects.find((p) => samePath(p.cwd, selection.cwd))?.cwd || state.projects[0]?.cwd || null;
    state.projectOverview = Boolean(state.projectCwd && (selection.projectOverview ?? state.remote));
    state.initialized = true;
    setConnection(true);
    bindText($('cli-version'), () => (state.version.version ? `v${state.version.version}` : ''));
    bindText($('settings-runtime'), () =>
      state.version.available === false
        ? tr('ui.prime_agent_introuvable_sur_cet_ordinateur')
        : tr('ui.prime_agent_sessions_natives_conservees', { value1: state.version.version || '' }),
    );
    if (state.version.available === false) {
      banner(() => tr('ui.prime_agent_est_introuvable_installez_ou_configurez_le_cli_puis_r'), true);
      $('global-banner').dataset.persistent = 'true';
    }
    renderNavigation();
    const lastRun = state.runs.get(selection.runId);
    if (lastRun && isRunning(lastRun)) await selectRun(lastRun);
    else if (selection.sessionId && session(selection.sessionId))
      await selectSession(selection.sessionId, session(selection.sessionId).cwd);
    else {
      restoreDraft();
      renderMessages();
    }
    saveSelection();
    void syncSessionActivity();
  } catch (e) {
    setConnection(false);
    banner(() => tr('ui.impossible_de_joindre_le_serveur', { value1: translateKnown(e.message) }), true);
    projectNavigation?.invalidate();
    $('session-list').replaceChildren(
      el('div', 'sidebar-empty', () => tr('ui.le_serveur_local_est_indisponible_reconnexion_automatique')),
    );
    setTimeout(bootstrap, 5000);
  }
}
function openProjectDialog() {
  if (state.readOnly) return;
  $('project-form').reset();
  $('project-error').hidden = true;
  $('project-browse').hidden = !state.directoryPickerAvailable;
  $('project-dialog').showModal();
  $('project-cwd').focus();
}
let projectPickerGeneration = 0;
let projectPickerController;
function cancelProjectDirectoryPicker() {
  projectPickerGeneration++;
  projectPickerController?.abort();
  projectPickerController = undefined;
  $('project-browse').disabled = false;
  $('project-browse').removeAttribute('aria-busy');
  $('project-submit').disabled = false;
}
async function browseProjectDirectory() {
  if (state.readOnly || !state.directoryPickerAvailable || projectPickerController) return;
  const generation = ++projectPickerGeneration;
  const controller = new AbortController();
  projectPickerController = controller;
  const button = $('project-browse');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  $('project-submit').disabled = true;
  $('project-error').hidden = true;
  try {
    const cwd = $('project-cwd').value.trim();
    const nativePicker =
      !state.remote &&
      window.__PRIME_STUDIO_DESKTOP__ === true &&
      window.__PRIME_STUDIO_DIRECTORY_PICKER__ === true &&
      typeof window.__TAURI__?.core?.invoke === 'function';
    const result = nativePicker
      ? {
          cwd: await window.__TAURI__.core.invoke('desktop_pick_directory', {
            cwd,
            title: tr('folders.choose'),
          }),
        }
      : await api('/api/projects/pick-directory', {
          method: 'POST',
          body: { cwd },
          signal: controller.signal,
        });
    if (generation === projectPickerGeneration && $('project-dialog').open && result.cwd) {
      $('project-cwd').value = result.cwd;
      $('project-cwd').focus();
    }
  } catch (error) {
    if (!controller.signal.aborted && generation === projectPickerGeneration && $('project-dialog').open) {
      const key =
        String(error) === 'picker_busy'
          ? 'folders.already_open'
          : ['picker_failed', 'picker_forbidden'].includes(String(error))
            ? 'folders.picker_failed'
            : null;
      bindText($('project-error'), () => (key ? tr(key) : translateKnown(error.message || String(error))));
      $('project-error').hidden = false;
    }
  } finally {
    if (generation === projectPickerGeneration) {
      projectPickerController = undefined;
      button.disabled = false;
      button.removeAttribute('aria-busy');
      $('project-submit').disabled = false;
    }
  }
}
async function addProject(e) {
  e.preventDefault();
  const b = $('project-submit');
  b.disabled = true;
  $('project-error').hidden = true;
  try {
    const p = await api('/api/projects', {
      method: 'POST',
      body: { cwd: $('project-cwd').value.trim(), name: $('project-name').value.trim() || undefined },
    });
    await refreshOverview();
    $('project-dialog').close();
    selectProject(p.cwd || $('project-cwd').value.trim());
    toast(() => tr('ui.projet_ajoute_a_votre_espace_de_travail'));
  } catch (e) {
    bindText($('project-error'), () => translateKnown(e.message));
    $('project-error').hidden = false;
  } finally {
    b.disabled = false;
  }
}
let sessionMenuAnchor, projectMenuAnchor, menuProjectCwd;
function positionMenu(menu, anchor) {
  if (menu.hidden || !anchor) return;
  const v = window.visualViewport,
    left = v?.offsetLeft || 0,
    top = v?.offsetTop || 0,
    width = v?.width || innerWidth,
    height = v?.height || innerHeight;
  const r = anchor.getBoundingClientRect();
  menu.style.maxHeight = `${Math.max(80, height - 24)}px`;
  menu.style.left = `${Math.max(left + 12, Math.min(left + width - menu.offsetWidth - 12, r.right - menu.offsetWidth))}px`;
  menu.style.top = `${Math.max(top + 12, Math.min(top + height - menu.offsetHeight - 12, r.bottom + 5))}px`;
}
function positionMenus() {
  positionMenu($('session-menu'), sessionMenuAnchor);
  positionMenu($('project-menu'), projectMenuAnchor);
}
function closeProjectMenu() {
  $('project-menu').hidden = true;
  projectMenuAnchor?.setAttribute('aria-expanded', 'false');
}
function openProjectMenu(cwd, anchor) {
  closeSessionMenu();
  closeProjectMenu();
  const p = state.projects.find((p) => samePath(p.cwd, cwd));
  if (!p) return;
  menuProjectCwd = cwd;
  projectMenuAnchor = anchor;
  for (const item of $('project-menu').querySelectorAll('[data-project-action]'))
    item.hidden = state.readOnly && item.dataset.projectAction !== 'knowledge';
  for (const divider of $('project-menu').querySelectorAll('.menu-divider')) divider.hidden = state.readOnly;
  bindText($('project-pin-label'), () => (p.pinned ? tr('ui.desepingler') : tr('ui.epingler')));
  $('project-menu').querySelector('[data-project-action="open"]').disabled = p.exists === false;
  const projectIndex = state.projects.indexOf(p);
  for (const [action, direction] of [
    ['up', -1],
    ['down', 1],
  ]) {
    const next = state.projects[projectIndex + direction];
    $('project-menu').querySelector(`[data-project-action="${action}"]`).disabled =
      state.archived || !!$('session-search').value.trim() || !next || !!next.pinned !== !!p.pinned;
  }
  $('project-menu').hidden = false;
  anchor.setAttribute('aria-expanded', 'true');
  positionMenus();
  $('project-menu').querySelector('button:not(:disabled):not([hidden])').focus({ preventScroll: true });
}
async function projectMenuAction(action) {
  const p = state.projects.find((p) => samePath(p.cwd, menuProjectCwd));
  closeProjectMenu();
  if (!p) return;
  if (action === 'knowledge') return knowledgeUI.open(p, projectMenuAnchor);
  if (action === 'archive-export') return archivesUI?.openExport(p);
  if (action === 'archive-import') return archivesUI?.openImport(p);
  if (state.readOnly) return;
  try {
    if (action === 'open') {
      await api('/api/projects/open', { method: 'POST', body: { cwd: p.cwd } });
      toast(() => tr('ui.dossier_ouvert_sur_le_pc'));
    } else if (action === 'pin') {
      await api('/api/projects', { method: 'PATCH', body: { cwd: p.cwd, pinned: !p.pinned } });
      await refreshOverview();
    } else if (action === 'up' || action === 'down') {
      await api('/api/projects/move', {
        method: 'POST',
        body: { cwd: p.cwd, direction: action === 'up' ? -1 : 1 },
      });
      await refreshOverview();
    } else if (action === 'remove') {
      bindText($('remove-project-name'), () => p.name);
      $('remove-project-dialog').dataset.cwd = p.cwd;
      $('remove-project-error').hidden = true;
      $('remove-project-dialog').showModal();
    }
  } catch (error) {
    toast(translateKnown(error.message), true);
  }
}
async function removeProject(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]'),
    cwd = $('remove-project-dialog').dataset.cwd;
  button.disabled = true;
  try {
    await api('/api/projects', { method: 'DELETE', body: { cwd } });
    const wasSelected = samePath(cwd, state.projectCwd);
    await refreshOverview();
    $('remove-project-dialog').close();
    if (wasSelected) {
      saveDraft();
      resetView();
      state.projectCwd = state.projects[0]?.cwd || null;
      selectNewConversationModel();
      saveSelection();
      restoreDraft();
      renderNavigation();
      renderMessages(true);
    }
    toast(() => tr('ui.projet_retire_du_studio'));
  } catch (error) {
    bindText($('remove-project-error'), () => translateKnown(error.message));
    $('remove-project-error').hidden = false;
  } finally {
    button.disabled = false;
  }
}
async function logout() {
  const button = $('logout-button');
  button.disabled = true;
  try {
    saveDraft();
    const response = await fetch('/lan/logout', { method: 'POST' });
    if (!response.ok && response.status !== 401) throw new Error(tr('ui.la_deconnexion_a_echoue_reessayez'));
    location.replace('/');
  } catch (error) {
    toast(translateKnown(error.message), true);
    button.disabled = false;
  }
}
function closeSessionMenu() {
  $('session-menu').hidden = true;
  sessionMenuAnchor?.setAttribute('aria-expanded', 'false');
  $('session-menu-button').setAttribute('aria-expanded', 'false');
}
function openSessionMenu(id, anchor) {
  if (state.readOnly) return;
  closeProjectMenu();
  sessionMenuAnchor = anchor;
  state.menuSessionId = id;
  const s = session(id);
  if (!s) return;
  const menu = $('session-menu');
  bindText($('pin-label'), () => (s.pinned ? tr('ui.desepingler') : tr('ui.epingler')));
  bindText($('archive-label'), () => (s.archived ? tr('ui.desarchiver') : tr('ui.archiver')));
  const siblings = (
    (s.cwd ? state.projects.find((p) => samePath(p.cwd, s.cwd))?.sessions : null) || []
  ).filter(
    (entry) => Boolean(entry.archived) === Boolean(s.archived) && !!entry.pinned === !!s.pinned,
  );
  const index = siblings.findIndex((entry) => entry.id === id);
  for (const [action, direction] of [
    ['up', -1],
    ['down', 1],
  ]) {
    const button = menu.querySelector(`[data-action="${action}"]`);
    if (button) button.disabled = !siblings[index + direction] || Boolean($('session-search').value.trim());
  }
  menu.hidden = false;
  positionMenus();
  anchor.setAttribute('aria-expanded', 'true');
  $('session-menu-button').setAttribute('aria-expanded', 'true');
  menu.querySelector('button:not(:disabled):not([hidden])')?.focus({ preventScroll: true });
}
async function patchSession(id, patch) {
  await api('/api/sessions', { method: 'PATCH', body: { id, ...patch } });
  await refreshOverview();
}
async function menuAction(action) {
  if (state.readOnly && action !== 'export') return;
  const id = state.menuSessionId,
    s = session(id);
  closeSessionMenu();
  if (!s) return;
  try {
    if (action === 'rename') {
      $('session-title').value = s.title || '';
      $('rename-error').hidden = true;
      $('rename-dialog').dataset.sessionId = id;
      $('rename-dialog').showModal();
      $('session-title').select();
    } else if (action === 'pin') {
      await patchSession(id, { pinned: !s.pinned });
      toast(() => (s.pinned ? tr('ui.session_desepinglee') : tr('ui.session_epinglee')));
    } else if (action === 'archive') {
      await patchSession(id, { archived: !s.archived });
      toast(() => (s.archived ? tr('ui.session_restauree') : tr('ui.session_archivee')));
      if (s.id === state.sessionId && !s.archived) newSession();
    } else if (action === 'up' || action === 'down') {
      await api('/api/sessions/move', {
        method: 'POST',
        body: { id, direction: action === 'up' ? -1 : 1 },
      });
      await refreshOverview();
    } else if (action === 'export') await exportSession(id);
  } catch (e) {
    toast(translateKnown(e.message), true);
  }
}
async function renameSession(e) {
  e.preventDefault();
  const b = e.currentTarget.querySelector('[type=submit]');
  b.disabled = true;
  try {
    await patchSession($('rename-dialog').dataset.sessionId, { title: $('session-title').value.trim() });
    $('rename-dialog').close();
    toast(() => tr('ui.session_renommee'));
  } catch (e) {
    bindText($('rename-error'), () => translateKnown(e.message));
    $('rename-error').hidden = false;
  } finally {
    b.disabled = false;
  }
}
async function copyText(text, label = tr('ui.copie')) {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    const area = el('textarea', 'sr-only');
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (ok) toast(label);
    else toast(() => tr('ui.le_navigateur_ne_permet_pas_la_copie_selectionnez_le_texte_manuel'), true);
  }
}
function fence(text) {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length)),
    ticks = '`'.repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}
async function exportSession(id = state.sessionId) {
  if (!id) return;
  try {
    const h = await api(`/api/history?id=${encodeURIComponent(id)}`),
      parts = [
        `# ${h.title || tr('ui.conversation_prime_agent')}`,
        tr('export.project', { value1: h.cwd || '' }),
        tr('export.session', { value1: h.id }),
      ];
    for (const m of h.messages || []) {
      parts.push(
        `## ${m.role === 'user' ? tr('ui.vous') : m.role === 'assistant' ? 'Prime Agent' : tr('ui.contexte')}`,
        m.text || '',
      );
      if (m.thinking)
        parts.push(
          '<details><summary data-i18n="ui.raisonnement">Raisonnement</summary>',
          '',
          m.thinking,
          '',
          '</details>',
        );
      for (const t of m.tools || [])
        parts.push(
          `### Outil : ${t.name || 'outil'}`,
          tr('ui.parametres_2', { value1: fence(stringify(t.args)) }),
          tr('ui.resultat_3', { value1: fence(stringify(t.result)) }),
        );
    }
    const url = URL.createObjectURL(
        new Blob([parts.join('\n\n') + '\n'], { type: 'text/markdown;charset=utf-8' }),
      ),
      a = el('a');
    a.href = url;
    a.download = `${(h.title || 'prime-agent-session').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 90)}.md`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(() => tr('ui.conversation_exportee_en_markdown'));
  } catch (e) {
    toast(translateKnown(e.message), true);
  }
}

hydrateIcons();
const knowledgeUI = createKnowledgeBrowser({
  api,
  onOpenSession: async ({ sessionId, cwd, messageId }) => {
    await selectSession(sessionId, cwd);
    if (!messageId) return;
    const message = [...$('messages').querySelectorAll('[data-message-id]')].findLast(
      (node) => node.dataset.messageId === messageId,
    );
    if (message) {
      // Jump-to-message navigation detaches auto-follow so streaming keeps the reading position.
      detachConversation();
      for (
        let ancestor = message.parentElement;
        ancestor && ancestor !== $('messages');
        ancestor = ancestor.parentElement
      )
        if (ancestor.tagName === 'DETAILS') ancestor.open = true;
      message.scrollIntoView({ block: 'start', behavior: 'instant' });
      message.setAttribute('tabindex', '-1');
      message.focus({ preventScroll: true });
      lastConversationTop = $('conversation-scroll').scrollTop;
      $('scroll-bottom').hidden = state.projectOverview || atConversationBottom();
    }
  },
});
for (const id of ['project-knowledge', 'detail-project-knowledge'])
  $(id).onclick = (event) => {
    const selected = project();
    if (selected) knowledgeUI.open(selected, event.currentTarget);
  };
inspectorUI = createInspector({
  api,
  markdown,
  getModels: () => state.models,
  openModelPicker,
  icon,
  toast,
  getContext: () => ({
    cwd: state.projectCwd,
    sessionId: state.sessionId || activeRun()?.sessionId,
    enabled: state.inspectorAvailable === true,
    readOnly: state.readOnly,
    remote: state.remote,
    nativeFileOpen: state.nativeFileOpen,
    online: state.online,
    mainModel: $('model-select').value || state.modelCatalogDefault || '',
  }),
  onClose: () => {
    $('toggle-details').click();
    $('toggle-details').focus();
  },
});
roadmapUI = createRoadmap({
  onSummary: (doc) => {
    const percent =
      doc?.initialized && Number.isFinite(doc?.progress?.percent)
        ? Math.max(0, Math.min(100, Math.round(doc.progress.percent)))
        : null;
    $('roadmap-progress').hidden = percent === null;
    $('roadmap-progress').textContent = percent === null ? '' : `${percent} %`;
    bindAttribute($('open-roadmap'), 'aria-label', () =>
      percent === null ? tr('roadmap.open') : tr('roadmap.toolbarProgress', { percent }),
    );
    bindAttribute($('open-roadmap'), 'title', () =>
      percent === null ? tr('roadmap.open') : tr('roadmap.toolbarProgress', { percent }),
    );
  },
  api,
  toast,
  getContext: () => ({
    cwd: state.projectCwd,
    name: project()?.name,
    sessions: project()?.sessions || [],
    sessionId: state.sessionId || activeRun()?.sessionId,
    model: $('model-select').value || state.modelCatalogDefault,
    thinking: $('thinking-select').value,
    readOnly: state.readOnly,
    online: state.online,
  }),
  onKnowledge: () => {
    if (project()) knowledgeUI.open(project(), $('open-roadmap'));
  },
  onOpenSession: async (link) => {
    const navigation = ++roadmapNavigationSequence;
    const priorRequest = state.requestId;
    const resolved = await api(
      `/api/roadmap/session?${new URLSearchParams({ cwd: link.cwd, sessionId: link.sessionId, ...(link.rootSessionId ? { rootSessionId: link.rootSessionId } : {}) })}`,
    );
    if (navigation !== roadmapNavigationSequence || priorRequest !== state.requestId) return;
    const rootSessionId = resolved.rootSessionId || resolved.sessionId;
    await selectSession(rootSessionId, link.cwd);
    if (
      navigation !== roadmapNavigationSequence ||
      !samePath(state.projectCwd, link.cwd) ||
      state.sessionId !== rootSessionId
    )
      return;
    if (resolved.agentId) await inspectorUI.openAgentById(resolved.agentId);
  },
  onWork: async (result) => {
    if (result.run) {
      const existing = state.runs.get(result.run.id);
      const run = existing || result.run;
      if (!existing) state.runs.set(run.id, run);
      await selectRun(run);
    } else if (result.sessionId) await selectSession(result.sessionId, state.projectCwd);
    if (result.linkWarning) toast(() => tr('roadmap.linkWarning'), true);
  },
});
for (const id of ['open-roadmap', 'project-roadmap', 'detail-project-roadmap'])
  $(id).onclick = (event) => roadmapUI.open(event.currentTarget);
archivesUI = createProjectArchives({
  toast,
  getContext: () => ({
    remote: state.remote,
    readOnly: state.readOnly,
    online: state.online,
    sessionId: state.sessionId,
    session: session(),
    projects: state.projects,
  }),
  refreshOverview,
  openModelPicker: () => openModelDialog(),
});
imageComposer = createImageComposer({
  getContext: () => ({
    key: draftKey(),
    available: state.attachmentsAvailable === true,
    disabled: state.readOnly || state.projectOverview || state.sending || !state.projectCwd,
    input: state.models.find((model) => model.id === ($('model-select').value || state.modelCatalogDefault))
      ?.input,
  }),
  onChange: () => updateComposer(),
  onError: (error) => toast(translateKnown(error.message) || String(error), true),
});
commandsUI = createCommands({
  api,
  getContext: () => ({
    cwd: state.projectCwd,
    sessionId: activeRun()?.sessionId || state.sessionId,
    running: isRunning(activeRun()),
    readOnly: state.readOnly,
    loading: state.loading || state.projectOverview,
    remote: state.remote,
  }),
  hasAttachments: () => imageComposer.hasImages(),
  onChange: () => {
    saveDraft();
    resizeComposer();
  },
  onError: (error) => toast(translateKnown(error.message), true),
  action: async (name, args) => {
    if (!['model', 'effort', 'name'].includes(name) && args)
      throw new Error(tr('ui.ce_raccourci_du_studio_s_utilise_sans_argument'));
    if (['model', 'effort'].includes(name) && isRunning(activeRun()))
      throw new Error(tr('ui.le_modele_et_son_effort_se_choisissent_entre_deux_tours'));
    if (['name', 'session', 'export', 'copy'].includes(name) && !state.sessionId)
      throw new Error(tr('ui.ouvrez_d_abord_une_session'));
    switch (name) {
      case 'roadmap':
      case 'backlog':
        return roadmapUI.open($('open-roadmap'), name === 'backlog' ? 'backlog' : 'project');
      case 'help':
        return commandsUI.open();
      case 'skills':
        return commandsUI.open('skill');
      case 'settings':
        $('settings-dialog').showModal();
        break;
      case 'mcp':
        $('open-mcp-settings').click();
        break;
      case 'model':
        openModelDialog();
        if (args) {
          $('model-search').value = args;
          renderModelList();
        }
        break;
      case 'effort':
        if (args) {
          if (![...$('thinking-select').options].some((option) => option.value === args))
            throw new Error(tr('ui.niveau_attendu_off_minimal_low_medium_high_xhigh_ou_max'));
          $('thinking-select').value = args;
          $('thinking-select').dispatchEvent(new Event('change'));
          toast(() => tr('ui.effort_de_raisonnement_modifie'));
        } else {
          $('thinking-select').focus();
          try {
            $('thinking-select').showPicker?.();
          } catch {}
        }
        break;
      case 'new':
        newSession();
        break;
      case 'name':
        if (args) await patchSession(state.sessionId, { title: args });
        else {
          state.menuSessionId = state.sessionId;
          await menuAction('rename');
        }
        break;
      case 'session':
        inspectorUI.setTab('session');
        if (innerWidth <= 1080) $('details-panel').classList.add('mobile-open');
        else {
          prefs.details = true;
          savePreferences({ details: true });
          applyPreferences();
        }
        renderDetails();
        break;
      case 'copy': {
        const last = [...activeMessages()]
          .reverse()
          .find((message) => message.role === 'assistant' && message.text);
        if (!last) throw new Error(tr('ui.aucune_reponse_a_copier'));
        await copyText(last.text, () => tr('ui.derniere_reponse_copiee'));
        break;
      }
      case 'export':
        await exportSession();
        break;
      case 'resume':
        openSidebar();
        $('session-search').focus();
        break;
    }
  },
});
liveMessagesUI = createLiveMessages({
  api,
  imageComposer,
  getContext: () => {
    const run = activeRun();
    return {
      draftKey: draftKey(),
      runId: run?.id,
      sessionId: run?.sessionId || state.sessionId,
      cwd: state.projectCwd,
      running: isRunning(run),
      stopping: run?.status === 'stopping',
      readOnly: state.readOnly,
      online: state.online,
    };
  },
  onAccepted: ({ key, text }) => acceptDraft(key, text),
  onSent: () => {
    saveDraft();
    resizeComposer();
  },
  onError: (error) => toast(translateKnown(error.message) || String(error), true),
});
projectNavigation = createProjectNavigation({
  root: $('session-list'),
  scroller: $('project-list'),
  el,
  icon,
  activityDot,
  read: readStorage,
  write: writeStorage,
  selectProject,
  selectSession,
  selectRun,
  openProjectMenu,
  openSessionMenu,
  addProject: openProjectDialog,
});
applyPreferences();
$('new-session').onclick = newSession;
$('project-new-session').onclick = newSession;
$('header-project').onclick = () => {
  if (state.projectCwd) selectProject(state.projectCwd);
};
$('project-session-search').oninput = renderProjectOverview;
$('project-show-recent').onclick = () => {
  state.archived = false;
  renderSessions();
  renderProjectOverview();
};
$('project-show-archived').onclick = () => {
  state.archived = true;
  renderSessions();
  renderProjectOverview();
};
$('add-project').onclick = openProjectDialog;
$('project-form').onsubmit = addProject;
$('project-browse').onclick = browseProjectDirectory;
$('project-dialog').addEventListener('close', cancelProjectDirectoryPicker);
$('rename-form').onsubmit = renameSession;
$('composer-form').onsubmit = sendMessage;
$('stop-button').onclick = stopRun;
$('session-search').oninput = renderSessions;
$('show-archived').onclick = () => {
  state.archived = !state.archived;
  renderSessions();
  renderProjectOverview();
};
$('session-menu-button').onclick = (e) => {
  if ($('session-menu').hidden) openSessionMenu(state.sessionId, e.currentTarget);
  else closeSessionMenu();
};
$('session-menu').onclick = (e) => {
  const b = e.target.closest('[data-action]');
  if (b) void menuAction(b.dataset.action);
};
$('export-session').onclick = () => exportSession();
$('copy-project-path').onclick = () => copyText(state.projectCwd, () => tr('ui.chemin_du_projet_copie'));
$('open-settings').onclick = () => $('settings-dialog').showModal();
createRemoteAccessSettings({ api, isRemote: () => state.remote, toast });
$('project-menu').onclick = (e) => {
  const button = e.target.closest('[data-project-action]');
  if (button) void projectMenuAction(button.dataset.projectAction);
};
projectSorting = createProjectSorting({
  root: $('project-list'),
  canSort: () => !state.readOnly && !state.archived && !$('session-search').value.trim(),
  move: (body) => api('/api/projects/move', { method: 'POST', body }),
  refresh: refreshOverview,
  render: renderProjects,
  reportError: (error) => toast(translateKnown(error.message), true),
});
sessionSorting = createSessionSorting({
  root: $('session-list'),
  scroller: $('project-list'),
  canSort: () => !state.readOnly && !$('session-search').value.trim(),
  move: (body) => api('/api/sessions/move', { method: 'POST', body }),
  refresh: refreshOverview,
  render: renderProjects,
  reportError: (error) => toast(translateKnown(error.message), true),
});
$('remove-project-form').onsubmit = removeProject;
$('logout-button').onclick = logout;
const subagentSettings = createSubagentSettings({
  api,
  root: $('subagent-settings'),
  getModels: () => state.models,
  openModelPicker,
  icon,
  toast,
});
$('open-model-config').onclick = () => void openModelConfig();
$('default-main-model').onclick = () => {
  openModelPicker({
    button: $('default-main-model'),
    value: $('default-main-model').value,
    get title() {
      return tr('ui.modele_principal_par_defaut_2');
    },
    get defaultLabel() {
      return tr('ui.choix_automatique_de_prime_agent');
    },
    get defaultDetail() {
      return tr('ui.laisser_prime_agent_choisir_le_modele_principal');
    },
    onSelect: selectDefaultModel,
  });
};
$('save-default-model').onclick = () => void saveDefaultModel();
$('add-custom-model').onclick = () => showModelConfigForm();
$('cancel-model-config').onclick = () => showModelConfigList(true);
$('cancel-model-config-bottom').onclick = () => showModelConfigList(true);
$('model-config-form').onsubmit = saveModelConfiguration;
$('custom-model-list').onclick = (event) => {
  const editButton = event.target.closest('[data-edit-model]'),
    deleteButton = event.target.closest('[data-delete-model]');
  if (editButton) showModelConfigForm(state.modelConfig?.models?.[Number(editButton.dataset.editModel)]);
  else if (deleteButton) void deleteModelConfiguration(Number(deleteButton.dataset.deleteModel));
};
$('toggle-sidebar').onclick = openSidebar;
$('mobile-backdrop').onclick = closeSidebar;
$('toggle-details').onclick = () => {
  if (innerWidth <= 1080) $('details-panel').classList.toggle('mobile-open');
  else prefs.details = !prefs.details;
  savePreferences({ details: prefs.details });
  applyPreferences();
};
$('scroll-bottom').onclick = () => scrollBottom(true);
$('conversation-scroll').onscroll = () => {
  const top = $('conversation-scroll').scrollTop;
  // Any meaningful upward move detaches, even inside the generous nearBottom() band.
  // Only the actual bottom reattaches. Downward moves that stop short keep the current
  // mode, so our own smooth scrollBottom frames are never mistaken for user intent and
  // no gesture listeners or timers are needed.
  const movedUp = top < lastConversationTop - 2,
    atBottom = atConversationBottom();
  lastConversationTop = top;
  if (atBottom) followConversation = true;
  else if (movedUp) {
    followConversation = false;
    // Drop any queued auto-follow so streaming cannot yank the view back.
    cancelAnimationFrame(bottomScrollFrame);
    bottomScrollFrame = 0;
  }
  $('scroll-bottom').hidden = state.projectOverview || atBottom;
  markVisibleSessionRead();
};
// Images and native questions can grow after the transcript render has finished.
// Preserve the user's reading position, or keep following the latest content.
const conversationSizeObserver = new ResizeObserver(() => {
  if (state.projectOverview) return;
  if (followConversation) scrollBottom();
  else $('scroll-bottom').hidden = atConversationBottom();
});
conversationSizeObserver.observe($('messages'));
conversationSizeObserver.observe($('interactive-questions'));
$('composer').oninput = () => {
  saveDraft();
  resizeComposer();
};
$('composer').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    const send = prefs.enterToSend ? !e.shiftKey : e.ctrlKey || e.metaKey;
    if (send) {
      e.preventDefault();
      void sendMessage();
    }
  }
};
$('model-picker-button').onclick = openModelDialog;
$('model-refresh').onclick = () => void refreshModelCatalog({ force: true, manual: true });
$('model-select').onchange = () => setSelectedModel($('model-select').value, true);
$('model-search').oninput = () => renderModelList();
$('model-favorites-filter').onclick = () => {
  state.modelFavoritesOnly = !state.modelFavoritesOnly;
  renderModelList();
  $('model-favorites-filter').focus();
};
$('model-list').onclick = (event) => {
  const favorite = event.target.closest('.model-favorite');
  if (favorite) {
    toggleModelFavorite(favorite.dataset.modelId);
    return;
  }
  const choice = event.target.closest('.model-choice');
  if (!choice || choice.disabled) return;
  const target = modelPickerTarget;
  $('model-dialog').close();
  target?.onSelect(choice.dataset.modelId);
};
$('model-search').onkeydown = (event) => {
  if (event.key !== 'ArrowDown') return;
  const first = $('model-list').querySelector('.model-choice:not(:disabled)');
  if (first) {
    event.preventDefault();
    first.focus();
  }
};
$('model-list').onkeydown = (event) => {
  if (!event.target.matches('.model-choice') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
    return;
  event.preventDefault();
  const choices = [...$('model-list').querySelectorAll('.model-choice:not(:disabled)')],
    current = choices.indexOf(event.target),
    index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? choices.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
  choices[index]?.focus();
};
$('model-dialog').addEventListener('close', () => {
  clearTimeout(modelCatalogPoll);
  modelCatalogPollsRemaining = 0;
  modelPickerTarget?.button.setAttribute('aria-expanded', 'false');
  modelPickerTarget = null;
});
$('model-dialog').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  $('model-dialog').close();
});
$('thinking-select').onchange = () => {
  void saveGenerationSettings({ thinking: $('thinking-select').value });
};
createPasskeySettings({ getContext: () => ({ remote: state.remote, readOnly: state.readOnly }) });
$('allow-questions').onchange = () =>
  void saveGenerationSettings({ allowQuestions: $('allow-questions').checked });
questionsUI = createQuestions({
  root: $('interactive-questions'),
  api,
  getContext: () => ({
    run: activeRun(),
    readOnly: state.readOnly || !state.online,
    hidden: state.projectOverview || state.loading,
  }),
});
$('enter-to-send').onchange = (e) => {
  savePreferences({ enterToSend: e.target.checked });
  applyPreferences();
};
document.querySelectorAll('[name="reasoning-mode"]').forEach((input) => {
  input.onchange = () => {
    savePreferences({ reasoningMode: input.value });
    messageNodes.clear();
    renderMessages();
  };
});
document.querySelectorAll('[data-theme-choice]').forEach(
  (b) =>
    (b.onclick = () => {
      savePreferences({ theme: b.dataset.themeChoice });
      applyPreferences();
    }),
);
document
  .querySelectorAll('[data-close-dialog]')
  .forEach((b) => (b.onclick = () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((d) =>
  d.addEventListener('click', (e) => {
    if (e.target === d) {
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    }
  }),
);
document.querySelectorAll('[data-prompt]').forEach(
  (b) =>
    (b.onclick = () => {
      setComposerText(b.dataset.prompt);
      saveDraft();
      resizeComposer();
      $('composer').focus();
      if (!state.projectCwd) openProjectDialog();
    }),
);
document.addEventListener('click', (e) => {
  if (!e.target.closest('#project-menu') && !e.target.closest('.project-more')) closeProjectMenu();
  if (
    !e.target.closest('#session-menu') &&
    !e.target.closest('#session-menu-button') &&
    !e.target.closest('.session-more')
  )
    closeSessionMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('inspector-viewer').open || $('knowledge-dialog').open) return;
    closeProjectMenu();
    closeSessionMenu();
    closeSidebar();
    $('details-panel').classList.remove('mobile-open');
    applyPreferences();
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
    if (e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (innerWidth <= 760) openSidebar();
      $('session-search').focus();
      $('session-search').select();
    }
    if (e.key.toLowerCase() === 'n') {
      e.preventDefault();
      if (!document.querySelector('dialog[open]')) newSession();
    }
  }
  const openMenu = [$('session-menu'), $('project-menu')].find((menu) => !menu.hidden);
  if (openMenu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const items = [...openMenu.querySelectorAll('button:not(:disabled)')];
    let i = items.indexOf(document.activeElement);
    i =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[i].focus();
  }
});
window.addEventListener('resize', () => {
  applyPreferences();
  positionMenus();
  resizeComposer();
});
window.visualViewport?.addEventListener('resize', positionMenus);
window.visualViewport?.addEventListener('scroll', positionMenus);
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyPreferences);
window.addEventListener('storage', (event) => {
  if (event.key?.startsWith('prime-studio.session-activity.')) {
    renderProjects();
    renderSessions();
    renderProjectOverview();
    return;
  }
  if (event.key !== 'prime-studio.preferences') return;
  const latest = storedPreferences();
  prefs.modelFavorites = Array.isArray(latest.modelFavorites) ? latest.modelFavorites : [];
  if ($('model-dialog').open) renderModelList();
});
window.addEventListener('beforeunload', saveDraft);
onLanguageChange(() => {
  if (!state.initialized) return;
  applyAccessMode();
  applyPreferences();
  setConnection(state.online);
  renderNavigation();
  setSelectedModel($('model-select').value);
  renderModelDefaults();
  resizeComposer();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.initialized) void refreshOverview();
});
window.addEventListener('online', () => {
  if (state.initialized) void refreshOverview();
});
setInterval(() => {
  const r = activeRun();
  if (isRunning(r)) {
    const s = Math.max(0, Math.floor((Date.now() - toTime(r.startedAt)) / 1000));
    bindText($('run-elapsed'), () => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`));
  }
}, 1000);
setInterval(() => {
  if (state.initialized && !document.hidden) void refreshOverview();
}, 10000);
createMcpSettings({ api, toast });
createProviderSettings({
  api,
  toast,
  allowed: () => !state.remote && state.providersAvailable,
  onChanged: async () => {
    const catalog = await api('/api/models');
    updateModelsAfterConfiguration({ catalog });
  },
});
createSettings({
  api,
  onStudioPreferences: applyStudioPreferences,
  getContext: () => ({
    remote: state.remote,
    readOnly: state.readOnly,
    projectCwd: state.projectCwd,
    version: state.version,
  }),
  openResources: (source) => commandsUI.open(source),
  copyText,
  toast,
});
const pushSettings = createPushSettings();
pushSettings.listenMessages((sessionId) => selectSession(sessionId));
$('settings-tab-notifications')?.addEventListener('click', () => void pushSettings.refresh().catch(() => {}));
void pushSettings.refresh().catch(() => {});
void pushSettings.consumeDeepLink((sessionId) => selectSession(sessionId)).catch(() => {});
void bootstrap();
