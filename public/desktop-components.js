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
export function createDesktopComponentsPanel({
  getContext,
  onChange = () => {},
  onProgress = () => {},
} = {}) {
  const root = document.getElementById('studio-update-components');
  window.__PRIME_STUDIO_COMPONENTS_PANEL__ = Boolean(root);
  const $ = (id) => document.getElementById('studio-update-components-' + id);
  let lastResult = null;
  let flight = null;
  function render() {
    if (!root) return;
    root.hidden = !isNewComponentsBridgeAvailable() || getContext?.().remote === true;
    const list = $('detail-list');
    list?.replaceChildren();
    for (const [key, info] of Object.entries(lastResult?.components || {})) {
      const row = document.createElement('li');
      const nameKey = componentDisplayName(key);
      const name = COMPONENT_NAMES[key] ? t(nameKey) : key;
      const state = ['ready', 'missing', 'error', 'pending', 'not_required'].includes(info.status)
        ? t(`components.state_${info.status}`)
        : t('components.state_pending');
      row.textContent = [name, info.version, state].filter(Boolean).join(' · ');
      if (info.path) {
        const path = document.createElement('small');
        path.textContent = info.path;
        row.append(path);
      }
      list?.append(row);
    }
  }
  async function run(action) {
    if (flight) return flight;
    if (!isComponentsMutatingAllowed(getContext)) return null;
    flight = (async () => {
      let channel;
      if (core().Channel) {
        channel = new (core().Channel)();
        channel.onmessage = onProgress;
      }
      const raw =
        action === 'status'
          ? await readComponentsStatus()
          : normalizeComponentsResult(await invokeComponents(action, { onProgress: channel }));
      lastResult = raw;
      render();
      onChange(raw);
      return raw;
    })().finally(() => {
      flight = null;
    });
    return flight;
  }
  onLanguageChange(render);
  return {
    refresh: () => run('status'),
    diagnose: () => run('diagnose'),
    prepare: () => run('prepare'),
    cancel: cancelComponentsInstall,
    getLast: () => lastResult,
  };
}
