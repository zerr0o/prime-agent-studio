import { t as tr, bindText, bindAttribute, translateKnown } from './i18n.js';

const POLL_MS = 5000;
const ACTION_PREVIEW_LIMIT = 120;

function basenameOf(value) {
  const text = String(value || '').replace(/\\/g, '/');
  const parts = text.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : text;
}

function truncate(text, limit = ACTION_PREVIEW_LIMIT) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

export const COMPUTER_USE_BACKEND_NATIVE = 'native';
export const COMPUTER_USE_BACKEND_CUA = 'cua';

export function normalizeBackendId(value) {
  return value === COMPUTER_USE_BACKEND_CUA ? COMPUTER_USE_BACKEND_CUA : COMPUTER_USE_BACKEND_NATIVE;
}

function cleanBackendReason(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().slice(0, 500);
}

export function normalizeComputerBackends(raw, supportedFallback = true) {
  const fallback = supportedFallback !== false;
  const source = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(source.backends) ? source.backends : null;
  if (!list) {
    return [
      { id: COMPUTER_USE_BACKEND_NATIVE, supported: fallback, available: fallback, reason: null },
      { id: COMPUTER_USE_BACKEND_CUA, supported: false, available: false, reason: null },
    ];
  }
  const byId = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.id !== COMPUTER_USE_BACKEND_NATIVE && entry.id !== COMPUTER_USE_BACKEND_CUA) continue;
    if (byId.has(entry.id)) continue;
    byId.set(entry.id, {
      id: entry.id,
      supported: entry.supported !== false,
      available: entry.available === true,
      reason: cleanBackendReason(entry.reason),
    });
  }
  if (!byId.has(COMPUTER_USE_BACKEND_NATIVE))
    byId.set(COMPUTER_USE_BACKEND_NATIVE, {
      id: COMPUTER_USE_BACKEND_NATIVE,
      supported: fallback,
      available: fallback,
      reason: null,
    });
  if (!byId.has(COMPUTER_USE_BACKEND_CUA))
    byId.set(COMPUTER_USE_BACKEND_CUA, {
      id: COMPUTER_USE_BACKEND_CUA,
      supported: false,
      available: false,
      reason: null,
    });
  return [byId.get(COMPUTER_USE_BACKEND_NATIVE), byId.get(COMPUTER_USE_BACKEND_CUA)];
}

export function ownerDisplayName(owner) {
  if (!owner || typeof owner !== 'object') return '';
  if (typeof owner.name === 'string' && owner.name.trim()) return owner.name.trim().slice(0, 60);
  if (typeof owner.sessionId === 'string' && owner.sessionId.trim())
    return `#${owner.sessionId.trim().slice(0, 8)}`;
  if (typeof owner.runId === 'string' && owner.runId.trim()) return `#${owner.runId.trim().slice(0, 8)}`;
  if (typeof owner.cwd === 'string' && owner.cwd.trim()) return basenameOf(owner.cwd).slice(0, 60);
  return '';
}

export function summarizeComputerAction(action) {
  if (action == null) return '';
  if (typeof action === 'string') return truncate(action.trim());
  if (typeof action !== 'object') return truncate(String(action));
  const pick = (...keys) => {
    for (const key of keys) {
      const value = action[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  const label = pick('label', 'summary', 'description');
  if (label) return truncate(label);
  const type = typeof action.type === 'string' ? action.type.trim() : '';
  if (!type) {
    const text = pick('text', 'name', 'kind');
    return truncate(text);
  }
  const detail = pick('text', 'keys', 'button', 'name', 'target', 'window');
  if (detail) return truncate(`${type}: ${detail}`);
  if (Array.isArray(action.keys) && action.keys.length) return truncate(`${type}: ${action.keys.join('+')}`);
  return truncate(type);
}

export function normalizeComputerStatus(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const owner =
    source.owner && typeof source.owner === 'object'
      ? {
          ...(typeof source.owner.sessionId === 'string' ? { sessionId: source.owner.sessionId } : {}),
          ...(typeof source.owner.runId === 'string' ? { runId: source.owner.runId } : {}),
          ...(typeof source.owner.cwd === 'string' ? { cwd: source.owner.cwd } : {}),
          ...(typeof source.owner.name === 'string' ? { name: source.owner.name } : {}),
        }
      : null;
  const supported = source.supported !== false;
  return {
    supported,
    enabled: source.enabled === true,
    owner,
    busy: source.busy === true,
    hotkey: typeof source.hotkey === 'string' ? source.hotkey : '',
    hotkeyError:
      typeof source.hotkeyError === 'string' && source.hotkeyError.trim()
        ? source.hotkeyError.trim().slice(0, 500)
        : null,
    lastAction: Object.hasOwn(source, 'lastAction') ? source.lastAction : null,
    lastFrame: Object.hasOwn(source, 'lastFrame') ? source.lastFrame : null,
    error: typeof source.error === 'string' ? source.error : null,
    backend: normalizeBackendId(source.backend),
    backends: normalizeComputerBackends(source, supported),
    cleanupPending: source.cleanupPending === true,
    cleanupFailed: source.cleanupFailed === true,
  };
}

export function createComputerUse({ api, getContext, toast }) {
  const $ = (id) => document.getElementById(id);
  let draftEnabled = false;
  // The desktop engine is a single global preference (Preferences > Tools,
  // persisted server-side). This module no longer stores a per-session backend
  // choice and never sends one: the server applies the global backend.
  let lastStatus = null;
  let lastFetchError = null;
  let busyAction = false;
  let stopBusy = false;
  let generation = 0;
  let pollTimer = null;
  let inFlight = null;
  let started = false;

  const context = () =>
    getContext() || {
      sessionId: null,
      runId: null,
      cwd: null,
      projectCwd: null,
      projectOverview: false,
      readOnly: false,
      online: true,
    };

  const queryKey = () => {
    const ctx = context();
    return `${ctx.sessionId || ''}|${ctx.runId || ''}`;
  };

  function isMine() {
    const ctx = context();
    const owner = lastStatus?.owner;
    if (!owner) return false;
    if (ctx.sessionId && owner.sessionId) return owner.sessionId === ctx.sessionId;
    if (ctx.runId && owner.runId) return owner.runId === ctx.runId;
    if (ctx.sessionId && owner.runId && ctx.runId) return owner.runId === ctx.runId;
    return false;
  }

  function isOther() {
    return Boolean(lastStatus?.owner) && !isMine();
  }

  function hasController() {
    if (!lastStatus || lastStatus.supported === false) return false;
    return Boolean(
      lastStatus.owner ||
      lastStatus.busy ||
      lastStatus.enabled ||
      lastStatus.cleanupPending === true ||
      lastStatus.cleanupFailed === true,
    );
  }

  function isCleanupBlocked() {
    return lastStatus != null && (lastStatus.cleanupPending === true || lastStatus.cleanupFailed === true);
  }

  function isOn() {
    const ctx = context();
    if (ctx.sessionId || ctx.runId) return lastStatus?.enabled === true;
    return draftEnabled;
  }

  function isVisible() {
    const ctx = context();
    return Boolean(ctx.projectCwd) && ctx.projectOverview !== true;
  }

  function statusText() {
    const ctx = context();
    if (ctx.online === false) return tr('computer.offline');
    if (lastStatus == null) return lastFetchError ? tr('computer.statusError') : tr('computer.loading');
    if (lastStatus.supported === false) return tr('computer.unsupported');
    if (lastStatus.cleanupFailed === true) return tr('computer.cleanupFailed');
    if (stopBusy || busyAction) return tr('computer.working');
    if (lastStatus.cleanupPending === true) return tr('computer.cleanupPending');
    if (lastStatus.busy && isMine()) return tr('computer.working');
    if (isMine()) return tr('computer.onMine');
    if (isOther()) return tr('computer.onOther', { value1: ownerDisplayName(lastStatus.owner) || '?' });
    if (isOn()) return tr('computer.draftOn');
    return tr('computer.off');
  }

  function ownerText() {
    if (lastStatus == null) return '-';
    if (lastStatus.supported === false) return tr('computer.ownerNone');
    if (isMine()) return tr('computer.ownerMine');
    if (isOther()) return ownerDisplayName(lastStatus.owner) || tr('computer.ownerNone');
    return tr('computer.ownerNone');
  }

  function actionText() {
    if (lastStatus == null) return '-';
    const summary = summarizeComputerAction(lastStatus.lastAction);
    return summary || tr('computer.noAction');
  }

  function update() {
    const root = $('computer-use');
    if (!root) return;
    const ctx = context();
    const visible = isVisible();
    root.hidden = !visible;
    const details = $('computer-use-details');
    if (details) details.hidden = !visible;
    if (!visible) return;
    const known = lastStatus != null;
    const supported = known ? lastStatus.supported !== false : true;
    const readOnly = ctx.readOnly === true;
    const online = ctx.online !== false;
    const on = isOn();
    const mine = isMine();
    const controlDisabled =
      readOnly || busyAction || stopBusy || !known || !supported || !online || isCleanupBlocked();
    const box = $('allow-computer-use');
    if (box) {
      if (box.checked !== on) box.checked = on;
      box.disabled = controlDisabled;
    }
    const toggle = $('computer-use-toggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(on));
      toggle.disabled = controlDisabled;
      bindAttribute(toggle, 'title', () => (on ? tr('computer.toggleOff') : tr('computer.toggleOn')));
      bindAttribute(toggle, 'aria-label', () => (on ? tr('computer.toggleOff') : tr('computer.toggleOn')));
      toggle.classList.toggle('is-on', on);
    }
    const label = $('computer-use-label');
    if (label) bindText(label, () => tr('computer.label'));
    const dot = $('computer-use-dot');
    if (dot) {
      dot.classList.toggle('on', on);
      dot.classList.toggle('other', !on && isOther());
    }
    const statusEl = $('computer-use-status');
    if (statusEl) {
      bindText(statusEl, () => statusText());
      statusEl.dataset.state =
        lastStatus == null
          ? 'loading'
          : !supported
            ? 'unsupported'
            : lastStatus.cleanupFailed === true || lastStatus.cleanupPending === true
              ? 'cleanup'
              : mine
                ? 'mine'
                : isOther()
                  ? 'other'
                  : on
                    ? 'draft'
                    : 'off';
    }
    const stopBtn = $('computer-use-stop');
    if (stopBtn) {
      const showStop = supported && known && !readOnly && hasController();
      stopBtn.hidden = !showStop;
      stopBtn.disabled = !showStop || stopBusy || !online;
      bindText(stopBtn, () => tr('computer.stop'));
      bindAttribute(stopBtn, 'title', () => tr('computer.stopHint'));
      bindAttribute(stopBtn, 'aria-label', () => tr('computer.stopHint'));
    }
    const warning = $('computer-use-warning');
    if (warning) {
      if (!known)
        bindText(warning, () => (lastFetchError ? tr('computer.statusError') : tr('computer.loading')));
      else if (!supported) bindText(warning, () => tr('computer.unsupported'));
      else if (lastStatus.cleanupFailed === true) bindText(warning, () => tr('computer.cleanupFailed'));
      else if (lastStatus.cleanupPending === true) bindText(warning, () => tr('computer.cleanupPending'));
      else if (readOnly) bindText(warning, () => tr('computer.readonlyNote'));
      else bindText(warning, () => tr('computer.warning'));
    }
    const ownerEl = $('computer-use-owner');
    if (ownerEl) bindText(ownerEl, () => ownerText());
    const actionEl = $('computer-use-action');
    if (actionEl) bindText(actionEl, () => actionText());
    const hotkeyEl = $('computer-use-hotkey');
    if (hotkeyEl)
      bindText(hotkeyEl, () =>
        lastStatus == null
          ? '-'
          : lastStatus.hotkeyError
            ? tr('computer.hotkeyUnavailable')
            : lastStatus.hotkey || '-',
      );
  }

  function queryUrl() {
    const ctx = context();
    const params = new URLSearchParams();
    if (ctx.sessionId) params.set('sessionId', ctx.sessionId);
    if (ctx.runId) params.set('runId', ctx.runId);
    const query = params.toString();
    return query ? `/api/computer-use?${query}` : '/api/computer-use';
  }

  async function refresh({ silent = true } = {}) {
    const turn = ++generation;
    const key = queryKey();
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    try {
      const data = await api(queryUrl(), { signal: controller.signal });
      if (turn !== generation || controller.signal.aborted || queryKey() !== key) return null;
      const nextStatus = normalizeComputerStatus(data);
      lastStatus = nextStatus;
      lastFetchError = null;
      update();
      return lastStatus;
    } catch (error) {
      if (turn !== generation || controller.signal.aborted || queryKey() !== key) return null;
      if (error && (error.status === 404 || error.code === 'NOT_FOUND')) {
        lastStatus = normalizeComputerStatus({ supported: false, enabled: false });
        lastFetchError = null;
        update();
        return lastStatus;
      }
      if (!silent) throw error;
      if (lastStatus == null) lastFetchError = error;
      update();
      return null;
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  async function setEnabled(next) {
    const ctx = context();
    if (ctx.readOnly === true || busyAction || stopBusy) return false;
    if (isCleanupBlocked()) return false;
    if (!ctx.projectCwd || ctx.projectOverview === true) return false;
    if (!ctx.sessionId && !ctx.runId) {
      if (next !== true) {
        draftEnabled = false;
        update();
        return false;
      }
      if (lastStatus == null || lastStatus.supported === false) return false;
      draftEnabled = true;
      update();
      return true;
    }
    if (lastStatus == null || lastStatus.supported === false) return false;
    if (lastStatus.owner && !isMine() && next === false) return false;
    const turn = ++generation;
    const key = queryKey();
    // No per-session backend: the server applies the global engine from
    // Preferences > Tools. Availability is enforced server-side with no
    // silent fallback.
    const body = {
      enabled: next === true,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
    };
    busyAction = true;
    update();
    try {
      const data = await api('/api/computer-use', { method: 'POST', body });
      if (turn !== generation || queryKey() !== key) return false;
      const nextStatus = normalizeComputerStatus(data);
      lastStatus = nextStatus;
      lastFetchError = null;
      update();
      return lastStatus.enabled === true;
    } catch (error) {
      if (turn === generation && queryKey() === key)
        toast(translateKnown(error?.message || String(error)), true);
      return false;
    } finally {
      if (turn === generation) busyAction = false;
      else busyAction = false;
      update();
      if (turn === generation) void refresh({ silent: true });
    }
  }

  async function stopComputer() {
    const ctx = context();
    if (ctx.readOnly === true || stopBusy) return false;
    if (!ctx.sessionId && !ctx.runId && draftEnabled && !hasController()) {
      draftEnabled = false;
      update();
      return true;
    }
    if (!hasController()) return false;
    const turn = ++generation;
    const key = queryKey();
    inFlight?.abort();
    stopBusy = true;
    update();
    try {
      const data = await api('/api/computer-use/stop', { method: 'POST', body: {} });
      if (turn !== generation || queryKey() !== key) return false;
      lastStatus = normalizeComputerStatus(data);
      lastFetchError = null;
      draftEnabled = false;
      update();
      return true;
    } catch (error) {
      if (turn === generation && queryKey() === key)
        toast(translateKnown(error?.message || String(error)), true);
      return false;
    } finally {
      stopBusy = false;
      update();
      if (turn === generation) void refresh({ silent: true });
    }
  }

  function shouldIncludeInRun() {
    const ctx = context();
    if (ctx.readOnly === true) return false;
    if (lastStatus == null || lastStatus.supported === false) return false;
    if (ctx.sessionId || ctx.runId) return lastStatus.enabled === true && (isMine() || !lastStatus.owner);
    return draftEnabled === true;
  }

  function onSessionChange() {
    draftEnabled = false;
    lastStatus = null;
    lastFetchError = null;
    generation += 1;
    inFlight?.abort();
    inFlight = null;
    update();
    if (isVisible() && context().online !== false) void refresh({ silent: true });
  }

  function notifyRunCreated() {
    if (draftEnabled) draftEnabled = false;
    update();
    if (isVisible()) void refresh({ silent: true });
  }

  function notifyRunFinished() {
    if (isVisible()) void refresh({ silent: true });
    else update();
  }

  function tick() {
    if (document.hidden) return;
    if (!isVisible()) return;
    if (context().online === false) {
      update();
      return;
    }
    void refresh({ silent: true });
  }

  function start() {
    if (started) return;
    started = true;
    const box = $('allow-computer-use');
    if (box) box.onchange = () => void setEnabled(box.checked);
    const toggle = $('computer-use-toggle');
    if (toggle) toggle.onclick = () => void setEnabled(!isOn());
    const stopBtn = $('computer-use-stop');
    if (stopBtn) stopBtn.onclick = () => void stopComputer();
    update();
    void refresh({ silent: true });
    pollTimer = setInterval(tick, POLL_MS);
  }

  function destroy() {
    generation += 1;
    inFlight?.abort();
    inFlight = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    started = false;
  }

  return {
    start,
    destroy,
    update,
    refresh,
    onSessionChange,
    notifyRunCreated,
    notifyRunFinished,
    shouldIncludeInRun,
    setEnabled,
    stopComputer,
    get draftEnabled() {
      return draftEnabled;
    },
    get status() {
      return lastStatus;
    },
    get busy() {
      return busyAction;
    },
    get stopping() {
      return stopBusy;
    },
  };
}
