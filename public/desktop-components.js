import { t, bindText, onLanguageChange } from './i18n.js';
export function isNewComponentsBridgeAvailable() {
  return (
    window.__PRIME_STUDIO_COMPONENTS__ === true &&
    window.__PRIME_STUDIO_DESKTOP__ === true &&
    typeof window.__TAURI__?.core?.invoke === 'function'
  );
}
function core() {
  return window.__TAURI__?.core;
}
export function isComponentsMutatingAllowed(getContext) {
  try {
    const context = typeof getContext === 'function' ? getContext() : getContext || {};
    if (context?.remote === true || context?.readOnly === true) return false;
  } catch {
    return false;
  }
  return isNewComponentsBridgeAvailable();
}
export function normalizeComponentsResult(raw) {
  if (!raw || typeof raw !== 'object') return { ready: false, components: {} };
  if (raw.cancelled === true) return { cancelled: true, ready: false, components: {} };
  if (raw.failure && typeof raw.failure === 'object') {
    return {
      failure: {
        error: String(raw.failure.error || raw.failure.type || 'preparation_failed'),
        component: raw.failure.component ? String(raw.failure.component) : null,
      },
      ready: false,
      components: raw.components && typeof raw.components === 'object' ? raw.components : {},
    };
  }
  const components = raw.components && typeof raw.components === 'object' ? raw.components : {};
  const server = raw.server && typeof raw.server === 'object' ? raw.server : null;
  return {
    ready: raw.ready === true,
    components,
    activation: typeof raw.activation === 'string' ? raw.activation : undefined,
    activationReason: typeof raw.activationReason === 'string' ? raw.activationReason : undefined,
    activationError: typeof raw.activationError === 'string' ? raw.activationError : undefined,
    requiredEngine: typeof raw.requiredEngine === 'string' ? raw.requiredEngine : undefined,
    installedEngine:
      typeof raw.installedEngine === 'string'
        ? raw.installedEngine
        : raw.installedEngine === null
          ? null
          : undefined,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : undefined,
    server,
    needsUpdate: typeof raw.needsUpdate === 'boolean' ? raw.needsUpdate : undefined,
    needsRestart: typeof raw.needsRestart === 'boolean' ? raw.needsRestart : undefined,
    serverUpdatePending: typeof raw.serverUpdatePending === 'boolean' ? raw.serverUpdatePending : undefined,
  };
}
export async function invokeComponents(action, opts) {
  const o = opts || {};
  const c = core();
  if (!c || typeof c.invoke !== 'function') throw new Error('components_unavailable');
  const args = { action, component: o.component ?? null };
  if (o.onProgress) args.onProgress = o.onProgress;
  return c.invoke('desktop_components', args);
}
let statusFlight = null;
export function readComponentsStatus() {
  if (statusFlight) return statusFlight;
  statusFlight = invokeComponents('status', { component: null })
    .then((raw) => normalizeComponentsResult(raw))
    .finally(() => {
      statusFlight = null;
    });
  return statusFlight;
}
export async function diagnoseComponentsPanel() {
  const result = await invokeComponents('diagnose', { component: null });
  return normalizeComponentsResult(result);
}
export async function cancelComponentsInstall() {
  const c = core();
  if (!c || typeof c.invoke !== 'function') return false;
  try {
    await c.invoke('desktop_components_cancel');
    return true;
  } catch {
    return false;
  }
}
const COMPONENT_NAMES = {
  engine: 'components.name_engine',
  uv: 'components.name_uv',
  python: 'components.name_python',
  node: 'components.name_node',
  npm: 'components.name_npm',
  bash: 'components.name_bash',
  studio: 'components.name_studio',
};
export function componentDisplayName(key) {
  return COMPONENT_NAMES[key] || key;
}
export function componentsErrorKey(code) {
  const value = String(code || '');
  const map = {
    validation_failed: 'components.error_validation_failed',
    server_validation_failed: 'components.error_server_validation_failed',
    version_mismatch: 'components.error_version_mismatch',
    not_managed: 'components.error_not_managed',
    port_occupied: 'components.error_port_occupied',
    setup_busy: 'components.error_setup_busy',
    download_failed: 'components.error_network',
    network_failed: 'components.error_network',
    network_error: 'components.error_network',
    checksum_mismatch: 'components.error_checksum',
    checksum_missing: 'components.error_checksum',
    unsafe_archive: 'components.error_checksum',
    disk_full: 'components.error_disk',
    write_denied: 'components.error_write',
    explicit_invalid: 'components.error_explicit',
    selection_invalid: 'components.error_explicit',
    bash_missing: 'components.error_bash',
    architecture_unsupported: 'components.error_unsupported',
    node_incompatible: 'components.error_unsupported',
    engine_incompatible: 'components.error_engine_version',
    cancelled: 'components.error_cancelled',
    preparation_failed: 'components.error_preparation',
    action_invalid: 'components.error_preparation',
    server_not_managed: 'components.error_not_managed',
    server_port_occupied: 'components.error_port_occupied',
    server_version_mismatch: 'components.error_version_mismatch',
    server_activation_failed: 'components.activation_failed',
    server_status_failed: 'components.activation_failed',
    server_restart_failed: 'components.activation_failed',
    components_required: 'components.error_components_required',
    update_busy: 'components.error_setup_busy',
  };
  return map[value] || 'components.error_preparation';
}
export function componentsActivationKey(result) {
  if (!result) return null;
  if (result.activation === 'active') return 'components.activation_active';
  if (result.activation === 'deferred') return 'components.activation_deferred';
  if (result.activation === 'failed') return 'components.activation_failed';
  return null;
}
function formatBytes(value, language) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  try {
    return n.toLocaleString(language.startsWith('fr') ? 'fr-FR' : 'en-US');
  } catch {
    return String(Math.round(n));
  }
}
export function describeProgress(payload, language) {
  const lang = language || 'fr';
  if (!payload || typeof payload !== 'object') return '';
  const nameKey = COMPONENT_NAMES[payload.component] || null;
  const name = nameKey ? t(nameKey) : String(payload.component || '');
  const stageMap = {
    download: 'components.stage_download',
    verify: 'components.stage_verify',
    install: 'components.stage_install',
    python: 'components.stage_python',
    validation: 'components.stage_validation',
    opening: 'components.stage_opening',
    server_update_pending: 'components.stage_server_update_pending',
    error: 'components.stage_error',
  };
  const stageKey = stageMap[String(payload.stage || '')] || null;
  const stage = stageKey ? t(stageKey) : String(payload.stage || '');
  const bytes = payload.bytes ?? payload.received;
  const total = payload.total;
  let suffix = '';
  if (bytes !== undefined && bytes !== null && bytes !== '') {
    const received = formatBytes(bytes, lang);
    suffix = total ? ' - ' + received + ' / ' + formatBytes(total, lang) : ' - ' + received;
    suffix += ' ' + t('components.progress_bytes');
  } else if (typeof payload.percent === 'number') {
    suffix = ' - ' + Math.round(payload.percent) + ' %';
  }
  const head = [name, stage].filter(Boolean).join(' - ');
  return head + suffix;
}
export function needsComponentsUpdate(result) {
  if (!result || result.cancelled || result.failure) return false;
  if (typeof result.needsUpdate === 'boolean') return result.needsUpdate;
  if (result.requiredEngine && result.installedEngine !== undefined) {
    return result.installedEngine !== result.requiredEngine;
  }
  if (
    result.requiredEngine &&
    result.components &&
    result.components.engine &&
    result.components.engine.version
  ) {
    return String(result.components.engine.version) !== String(result.requiredEngine);
  }
  return false;
}
export function createDesktopComponentsPanel(opts) {
  const getContext = opts && opts.getContext;
  const byId = (id) => document.getElementById('studio-update-components-' + id);
  const root = document.getElementById('studio-update-components');
  try {
    if (root) window.__PRIME_STUDIO_COMPONENTS_PANEL__ = true;
  } catch {}
  if (!root) return { refresh: async () => null, kind: 'missing' };
  const getCore = () => window.__TAURI__?.core;
  let busy = false;
  let currentOp = null;
  let lastResult = null;
  let lastFailure = null;
  const contextAllowsMutate = () => {
    try {
      const context = typeof getContext === 'function' ? getContext() : {};
      return context?.remote !== true && context?.readOnly !== true;
    } catch {
      return false;
    }
  };
  const setBusy = (value, op) => {
    busy = value;
    if (value) currentOp = op || 'busy';
    else currentOp = null;
    for (const id of ['check', 'install', 'apply']) {
      const button = byId(id);
      if (button) button.disabled = value || !contextAllowsMutate();
    }
    const cancel = byId('cancel');
    if (cancel) {
      const showCancel = Boolean(value) && currentOp === 'install';
      cancel.hidden = !showCancel;
      cancel.disabled = !showCancel;
    }
    root.setAttribute('aria-busy', String(value));
  };
  const showError = (failureOrCode) => {
    const node = byId('error');
    if (!node) return;
    if (!failureOrCode) {
      node.hidden = true;
      bindText(node, () => '');
      return;
    }
    const code = typeof failureOrCode === 'string' ? failureOrCode : failureOrCode.error;
    const component = typeof failureOrCode === 'object' ? failureOrCode.component : null;
    const key = componentsErrorKey(code);
    node.hidden = false;
    bindText(node, () => {
      const base = t(key);
      if (component) {
        const nameKey = COMPONENT_NAMES[component];
        const name = nameKey ? t(nameKey) : String(component);
        return name + ' : ' + base;
      }
      return base;
    });
  };
  function renderList(result) {
    const list = byId('list');
    const details = byId('detail-list');
    if (list) list.replaceChildren();
    if (details) details.replaceChildren();
    if (!result || !result.components) return;
    for (const entry of Object.entries(result.components)) {
      const key = entry[0];
      const info = entry[1] || {};
      const status = info.status || 'missing';
      const version = info.version ? ' ' + info.version : '';
      const stateMap = {
        ready: 'components.state_ready',
        missing: 'components.state_missing',
        error: 'components.state_error',
        pending: 'components.state_pending',
        not_required: 'components.state_not_required',
      };
      const stateKey = stateMap[status] || null;
      const stateLabel = stateKey ? t(stateKey) : String(status);
      const nameKey = COMPONENT_NAMES[key];
      const displayName = nameKey ? t(nameKey) : String(key);
      if (list) {
        const chip = document.createElement('li');
        chip.className = 'component-chip';
        chip.dataset.state = String(status);
        const label = displayName + version + (status !== 'ready' ? ' - ' + stateLabel : '');
        chip.textContent = label;
        chip.title = stateLabel;
        chip.setAttribute('aria-label', label + ' - ' + stateLabel);
        list.append(chip);
      }
      if (details) {
        const row = document.createElement('li');
        row.textContent = displayName + ' - ' + stateLabel + (version ? ' - ' + String(info.version) : '');
        if (info.path) {
          const path = document.createElement('small');
          path.textContent = String(info.path);
          row.append(path);
        }
        if (info.provenance) {
          const source = document.createElement('small');
          source.textContent = String(info.provenance);
          row.append(source);
        }
        if (info.error && info.error !== 'missing') {
          const problem = document.createElement('small');
          problem.className = 'component-detail-error';
          const code = info.explicit ? 'explicit_invalid' : String(info.error);
          problem.textContent = t(componentsErrorKey(code));
          row.append(problem);
        }
        details.append(row);
      }
    }
  }
  function renderRecommendation(result) {
    const node = byId('recommendation');
    if (!node) return;
    if (!result || result.cancelled || result.failure) {
      bindText(node, () => t('components.recommendation_check'));
      return;
    }
    const required =
      result.requiredEngine ||
      (result.components && result.components.engine && result.components.engine.version);
    const installed =
      result.installedEngine !== undefined
        ? result.installedEngine
        : result.components && result.components.engine && result.components.engine.version;
    if (required && installed && String(installed) !== String(required)) {
      bindText(node, () =>
        t('components.recommendation_update', { required: String(required), installed: String(installed) }),
      );
    } else if (required) {
      if (result.ready && !needsComponentsUpdate(result)) {
        bindText(node, () => t('components.recommendation_current', { required: String(required) }));
      } else {
        bindText(node, () => t('components.recommendation_required', { required: String(required) }));
      }
    } else {
      bindText(node, () => t('components.recommendation_check'));
    }
  }
  function renderActivation(result) {
    const note = byId('activation-note');
    const apply = byId('apply');
    if (!note) return;
    if (!result || result.cancelled || result.failure) {
      bindText(note, () => t('components.activation_hint'));
      if (apply) apply.hidden = true;
      return;
    }
    const server = result.server || null;
    const unmanaged = server ? server.managed === false : false;
    const needsRestart =
      result.needsRestart === true ||
      result.serverUpdatePending === true ||
      result.activation === 'deferred' ||
      result.activation === 'failed';
    if (apply) {
      apply.hidden = !(result.ready && (needsRestart || result.activation === 'failed'));
      apply.disabled = busy || !contextAllowsMutate() || unmanaged;
    }
    if (result.activation === 'deferred') {
      bindText(note, () => t('components.activation_deferred'));
    } else if (result.activation === 'failed' || result.activation === 'incomplete') {
      const key = componentsErrorKey(result.activationError || 'preparation_failed');
      bindText(note, () => t('components.activation_failed') + ' ' + t(key));
    } else if (result.activation === 'active') {
      bindText(note, () => t('components.activation_active'));
    } else if (server && typeof server.activeRuns === 'number' && server.activeRuns > 0) {
      bindText(note, () => t('components.activation_busy', { count: server.activeRuns }));
    } else if (needsRestart) {
      bindText(note, () => t('components.activation_restart_needed'));
    } else {
      bindText(note, () => t('components.activation_hint'));
    }
    const serverNote = byId('server-note');
    if (serverNote && server) {
      bindText(serverNote, () => {
        if (server.error) return t(componentsErrorKey(server.error));
        const parts = [];
        if (server.version) parts.push(t('components.server_version', { version: String(server.version) }));
        if (server.engineVersion)
          parts.push(t('components.active_engine', { version: String(server.engineVersion) }));
        if (typeof server.activeRuns === 'number') {
          parts.push(
            server.activeRuns > 0
              ? t('components.server_busy', { count: server.activeRuns })
              : t('components.server_idle'),
          );
        }
        if (server.managed === false) parts.push(t('components.error_not_managed'));
        return parts.join(' - ');
      });
    }
  }
  function renderStatus(kind) {
    const node = byId('status');
    if (!node) return;
    const key =
      kind === 'checking'
        ? 'components.status_checking'
        : kind === 'diagnosing'
          ? 'components.status_diagnosing'
          : kind === 'installing'
            ? 'components.status_installing'
            : kind === 'applying'
              ? 'components.status_applying'
              : kind === 'ready'
                ? 'components.status_ready'
                : kind === 'not_ready'
                  ? 'components.status_not_ready'
                  : kind === 'cancelled'
                    ? 'components.error_cancelled'
                    : 'components.status_idle';
    bindText(node, () => t(key));
  }
  function refreshButtons() {
    const allowed = contextAllowsMutate();
    const unmanaged = lastResult && lastResult.server ? lastResult.server.managed === false : false;
    for (const id of ['check', 'install']) {
      const button = byId(id);
      if (button) button.disabled = busy || !allowed;
    }
    const applyBtn = byId('apply');
    if (applyBtn) applyBtn.disabled = busy || !allowed || unmanaged;
    const install = byId('install');
    if (install && lastResult && lastResult.ready && !needsComponentsUpdate(lastResult))
      install.hidden = true;
    if (install && lastResult && !lastResult.ready) install.hidden = false;
    const cancel = byId('cancel');
    if (cancel) {
      const showCancel = busy && currentOp === 'install';
      cancel.hidden = !showCancel;
      cancel.disabled = !showCancel;
    }
  }
  function setProgressVisible(visible) {
    const progress = byId('progress');
    if (!progress) return;
    progress.hidden = !visible;
    if (visible) progress.removeAttribute('value');
  }
  function onProgressMessage(payload) {
    const node = byId('status');
    if (node) {
      const language = document.documentElement.lang || 'fr';
      bindText(node, () => describeProgress(payload, language));
    }
    const progress = byId('progress');
    if (progress && payload && typeof payload === 'object') {
      let percent = null;
      if (typeof payload.percent === 'number') percent = payload.percent;
      else if (payload.bytes !== undefined && payload.total)
        percent = (Number(payload.bytes) / Number(payload.total)) * 100;
      else if (payload.received !== undefined && payload.total)
        percent = (Number(payload.received) / Number(payload.total)) * 100;
      if (percent !== null && Number.isFinite(percent)) {
        progress.value = Math.max(0, Math.min(100, percent));
      } else {
        progress.removeAttribute('value');
      }
    }
  }
  async function withChannel(fn) {
    const c = getCore();
    let channel = null;
    if (c && typeof c.Channel === 'function') {
      try {
        channel = new c.Channel();
        channel.onmessage = (payload) => onProgressMessage(payload);
      } catch {
        channel = null;
      }
    }
    let unlisten = null;
    try {
      if (!channel && c && window.__TAURI__?.event?.listen) {
        unlisten = await window.__TAURI__.event.listen('components-progress', (event) =>
          onProgressMessage(event?.payload ?? event),
        );
      }
    } catch {
      unlisten = null;
    }
    try {
      return await fn(channel);
    } finally {
      if (typeof unlisten === 'function') {
        try {
          unlisten();
        } catch {}
      }
    }
  }
  function applyResult(result, kind) {
    lastResult = result;
    lastFailure = result && result.failure ? result.failure : null;
    renderList(result);
    renderRecommendation(result);
    renderActivation(result);
    const progress = byId('progress');
    if (progress) progress.hidden = true;
    if (result && result.failure) {
      showError(result.failure);
      renderStatus('not_ready');
    } else if (result && result.cancelled) {
      showError('cancelled');
      renderStatus('cancelled');
    } else if (result && result.ready) {
      showError(null);
      renderStatus('ready');
      const install = byId('install');
      if (install) install.hidden = !needsComponentsUpdate(result) && result.ready;
    } else {
      showError(null);
      renderStatus('not_ready');
    }
    setBusy(false);
    refreshButtons();
  }
  async function refresh(opts) {
    const silent = opts && opts.silent;
    if (!isNewComponentsBridgeAvailable()) {
      root.hidden = true;
      return null;
    }
    let context = {};
    try {
      context = typeof getContext === 'function' ? getContext() : {};
    } catch {
      context = {};
    }
    const native = window.__PRIME_STUDIO_DESKTOP__ === true && !context?.remote;
    root.hidden = !native;
    if (!native) return null;
    if (busy) return lastResult;
    setBusy(true, 'status');
    showError(null);
    if (!silent) renderStatus('checking');
    try {
      const result = await readComponentsStatus();
      applyResult(result, 'status');
      return result;
    } catch (error) {
      lastResult = null;
      showError(String((error && error.message) || error) || 'preparation_failed');
      renderStatus('not_ready');
      setBusy(false);
      refreshButtons();
      return null;
    }
  }
  async function diagnose() {
    if (busy || !contextAllowsMutate()) return null;
    setBusy(true, 'diagnose');
    showError(null);
    renderStatus('diagnosing');
    setProgressVisible(true);
    try {
      const result = await withChannel(async (channel) =>
        invokeComponents('diagnose', { component: null, onProgress: channel || undefined }),
      );
      const normalized = normalizeComponentsResult(result);
      applyResult(normalized, 'diagnose');
      return normalized;
    } catch (error) {
      showError(String((error && error.message) || error) || 'preparation_failed');
      renderStatus('not_ready');
      setBusy(false);
      refreshButtons();
      setProgressVisible(false);
      return null;
    }
  }
  async function install() {
    if (busy || !contextAllowsMutate()) return null;
    setBusy(true, 'install');
    showError(null);
    renderStatus('installing');
    setProgressVisible(true);
    try {
      const result = await withChannel(async (channel) =>
        invokeComponents('install', { component: null, onProgress: channel || undefined }),
      );
      const normalized = normalizeComponentsResult(result);
      applyResult(normalized, 'install');
      return normalized;
    } catch (error) {
      const code = String((error && error.message) || error) || 'preparation_failed';
      if (code === 'cancelled' || /cancel/i.test(code)) {
        applyResult({ cancelled: true }, 'install');
      } else {
        showError(code);
        renderStatus('not_ready');
        setBusy(false);
        refreshButtons();
      }
      setProgressVisible(false);
      return null;
    }
  }
  async function apply() {
    if (busy || !contextAllowsMutate()) return null;
    const lastManagedFalse = lastResult && lastResult.server ? lastResult.server.managed === false : false;
    if (lastManagedFalse) return null;
    setBusy(true, 'apply');
    showError(null);
    renderStatus('applying');
    try {
      const raw = await withChannel(async (channel) =>
        invokeComponents('apply', { component: null, onProgress: channel || undefined }),
      );
      const result = normalizeComponentsResult(raw);
      if (result.failure) {
        showError(result.failure);
        renderStatus('not_ready');
        setBusy(false);
        refreshButtons();
        return result;
      }
      const merged = Object.assign({}, lastResult || {}, result);
      if (!result.components || !Object.keys(result.components).length) {
        merged.components = (lastResult && lastResult.components) || {};
      }
      if (result.ready === undefined) merged.ready = (lastResult && lastResult.ready) || false;
      applyResult(merged, 'apply');
      return merged;
    } catch (error) {
      showError(String((error && error.message) || error) || 'preparation_failed');
      renderStatus('not_ready');
      setBusy(false);
      refreshButtons();
      return null;
    }
  }
  async function cancel() {
    if (!busy || currentOp !== 'install') return;
    await cancelComponentsInstall();
    setProgressVisible(false);
  }
  const checkButton = byId('check');
  const installButton = byId('install');
  const cancelButton = byId('cancel');
  const applyButton = byId('apply');
  const toggle = byId('toggle');
  const details = byId('details');
  if (checkButton) checkButton.onclick = () => void diagnose();
  if (installButton) installButton.onclick = () => void install();
  if (cancelButton) cancelButton.onclick = () => void cancel();
  if (applyButton) applyButton.onclick = () => void apply();
  if (toggle && details) {
    toggle.onclick = () => {
      const expanded = details.hidden;
      details.hidden = !expanded;
      toggle.setAttribute('aria-expanded', String(expanded));
      bindText(toggle, () => t(expanded ? 'components.hide_details' : 'components.show_details'));
    };
    bindText(toggle, () => t(details.hidden ? 'components.show_details' : 'components.hide_details'));
  }
  onLanguageChange(() => {
    if (root.hidden) return;
    if (lastFailure) showError(lastFailure);
    renderList(lastResult);
    renderRecommendation(lastResult);
    renderActivation(lastResult);
    refreshButtons();
  });
  refreshButtons();
  return { refresh, diagnose, install, apply, cancel, getLast: () => lastResult };
}
