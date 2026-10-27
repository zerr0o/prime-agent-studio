import { t as tr, bindText, bindAttribute, translateKnown, onLanguageChange } from './i18n.js';

export const COMPUTER_BACKEND_NATIVE = 'native';
export const COMPUTER_BACKEND_CUA = 'cua';

export function normalizeComputerBackend(value) {
  return value === COMPUTER_BACKEND_CUA ? COMPUTER_BACKEND_CUA : COMPUTER_BACKEND_NATIVE;
}

// Module-shared confirmed snapshot (global PC setting, not per-root view
// state): whichever instance confirms a save or completes a refresh publishes
// here synchronously, so every other instance's getters (notably the primary
// feeding sendMessage) read the fresh value immediately, before any async
// parent fan-out refresh lands. Forms keep their own busy/generation guards;
// the snapshot only ever holds confirmed server values, never drafts.
let sharedComputer = null;
let sharedComputerRevision = -1;
const sharedComputerListeners = new Set();
function revisionNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function publishComputer(next, revision) {
  const rev = revisionNumber(revision);
  // Server revision ordering: a delayed GET with an older revision must never
  // roll back a newer confirmed PATCH from another instance. Reads without a
  // revision keep the legacy merge path (no ordering).
  if (rev !== undefined) {
    if (rev < sharedComputerRevision) return false;
    if (rev > sharedComputerRevision) sharedComputerRevision = rev;
  }
  sharedComputer = { ...(sharedComputer || {}), ...next };
  for (const fn of [...sharedComputerListeners]) {
    try {
      fn(sharedComputer);
    } catch {}
  }
  return true;
}
export function getSharedComputerPreferences() {
  return sharedComputer ? { ...sharedComputer } : null;
}
export function __resetSharedComputerForTests() {
  sharedComputer = null;
  sharedComputerRevision = -1;
}

// Global Computer Use preferences (Preferences > Tools, one global setting
// persisted server-side via /api/studio-preferences). The desktop engine radio
// group and the Computer Use decision model+thinking live here, not in the
// Computer Use header. They apply only to the delegated desktop child, never
// to the main conversation model+thinking (main stays unchanged). Empty model
// means same as conversation but still in a separate child (no paid pick is
// forced). Changes apply only when the desktop is off and not owned; the
// backend default is native with no silent fallback.
export function createComputerPreferences({
  api,
  getContext = () => ({}),
  getModels,
  openModelPicker,
  getElement = null,
  domId = null,
  instanceId = '',
  isPrimary = true,
  onChanged = () => {},
} = {}) {
  void domId;
  void instanceId;
  void isPrimary;
  const $ = (id) => (typeof getElement === 'function' ? getElement(id) : document.getElementById(id));
  let backend = COMPUTER_BACKEND_NATIVE;
  let model = '';
  let thinking = '';
  let backends = null;
  let status = null;
  let supported = true;
  let known = false;
  let busy = false;
  let generation = 0;
  let offLanguage = null;
  let started = false;

  function readOnly() {
    try {
      const context = getContext();
      return context?.remote === true ? false : context?.readOnly === true;
    } catch {
      return false;
    }
  }

  // Remote consultation stays read-only for desktop control itself, but the
  // global engine choice is a local PC setting. Only read-only locks it here,
  // matching the previous header selector semantics.
  function locked() {
    return readOnly();
  }

  function backendEntry(id) {
    const list = Array.isArray(backends) ? backends : [];
    const found = list.find((entry) => entry?.id === id);
    if (found) return found;
    if (id === COMPUTER_BACKEND_CUA) return { id, supported: false, available: false, reason: null };
    return { id, supported, available: supported, reason: null };
  }

  function isAvailable(id) {
    return backendEntry(id).available === true;
  }

  function reasonOf(id) {
    const reason = backendEntry(id).reason;
    return typeof reason === 'string' && reason ? reason : null;
  }

  // Documented contract: permission snapshots pin the engine. Unscoped
  // `enabled` is true while any session keeps mere permission, so the engine
  // changes only when permissions are OFF and there is no holder/cleanup.
  // This is not desktop ownership: owner/busy add their own lock below.
  function computerOn() {
    if (!status) return false;
    if (status.enabled === true) return true;
    return Boolean(status.owner) || status.busy === true;
  }

  function cleanupBlocked() {
    return status?.cleanupPending === true || status?.cleanupFailed === true;
  }

  function selectorDisabled() {
    if (locked() || busy || !known) return true;
    if (supported === false) return true;
    if (computerOn() || cleanupBlocked()) return true;
    return false;
  }

  function hintText() {
    if (!known) return '';
    if (supported === false) return '';
    if (computerOn() || cleanupBlocked()) return tr('computer.backendChangeNeedsOff');
    const cua = backendEntry(COMPUTER_BACKEND_CUA);
    if (cua.available === true) return tr('computer.backendBetaNote');
    return reasonOf(COMPUTER_BACKEND_CUA) || tr('computer.backendCuaUnavailable');
  }

  function liveModels() {
    try {
      const next = typeof getModels === 'function' ? getModels() : null;
      if (Array.isArray(next) && next.length) return next;
    } catch {}
    return [];
  }

  // The decision model row reuses the shared Studio model picker
  // (openModelPicker, the same menu as the conversation model). No filtering
  // happens here: image support is validated server-side (400 for text-only
  // models) because it belongs to the dedicated image-reading child, not to
  // the main permission toggle.
  function modelDisplay(models, draft, emptyName, emptyDetail) {
    const current = typeof draft === 'string' ? draft : '';
    const found = models.find((entry) => entry?.id === current);
    const imageNote =
      found && Array.isArray(found.input) && !found.input.includes('image')
        ? tr('computer.modelImageNote')
        : '';
    if (!current)
      return { draft: current, found: null, name: tr(emptyName), provider: tr(emptyDetail), imageNote };
    return {
      draft: current,
      found: found || null,
      name: found?.name || tr('common.unavailable', { value1: current }),
      provider: found?.provider || (found ? '' : tr('ui.modele_indisponible')),
      imageNote,
    };
  }
  function decisionDisplay(models) {
    return modelDisplay(models, model, 'computer.sameAsConversation', 'computer.modelNote');
  }

  function showError(message) {
    const box = $('computer-prefs-error');
    if (!box) return;
    box.hidden = !message;
    bindText(box, () => (message ? translateKnown(message) : ''));
    if (message) box.textContent = translateKnown(message);
    else box.textContent = '';
  }

  function render() {
    const native = $('computer-backend-native');
    const cua = $('computer-backend-cua');
    const hint = $('computer-backend-hint');
    const button = $('computer-model-button');
    const nameEl = $('computer-model-name');
    const providerEl = $('computer-model-provider');
    const disabled = selectorDisabled();
    if (native) {
      native.checked = backend === COMPUTER_BACKEND_NATIVE;
      native.disabled = disabled || !isAvailable(COMPUTER_BACKEND_NATIVE);
      bindAttribute(native, 'title', () =>
        disabled && known ? tr('computer.backendChangeNeedsOff') : tr('computer.backendNative'),
      );
      bindAttribute(native, 'aria-label', () => tr('computer.backendNative'));
    }
    if (cua) {
      cua.checked = backend === COMPUTER_BACKEND_CUA;
      cua.disabled = disabled || !isAvailable(COMPUTER_BACKEND_CUA);
      bindAttribute(cua, 'title', () =>
        disabled && known
          ? tr('computer.backendChangeNeedsOff')
          : reasonOf(COMPUTER_BACKEND_CUA) || tr('computer.backendCua'),
      );
      bindAttribute(cua, 'aria-label', () => tr('computer.backendCua'));
    }
    if (hint) bindText(hint, () => hintText());
    if (button) {
      const models = liveModels();
      const display = decisionDisplay(models);
      button.disabled = locked() || busy || !known;
      if (nameEl) bindText(nameEl, () => decisionDisplay(liveModels()).name);
      if (providerEl) bindText(providerEl, () => decisionDisplay(liveModels()).provider);
      if (nameEl) nameEl.textContent = display.name;
      if (providerEl) providerEl.textContent = display.provider;
      bindAttribute(button, 'title', () => display.draft || tr('computer.modelNote'));
      bindAttribute(
        button,
        'aria-label',
        () => `${tr('computer.modelLabel')}: ${decisionDisplay(liveModels()).name}`,
      );
    }
    // The thinking select reuses the standard Studio reasoning levels
    // (same options as the composer selector).
    const thinkingSelect = $('computer-thinking');
    if (thinkingSelect) {
      thinkingSelect.disabled = locked() || busy || !known;
      if (thinkingSelect.value !== thinking) thinkingSelect.value = thinking;
    }
  }

  async function refresh() {
    const turn = ++generation;
    busy = true;
    render();
    try {
      const [prefs, computer] = await Promise.all([
        api('/api/studio-preferences'),
        api('/api/computer-use').catch(() => null),
      ]);
      if (turn !== generation) return;
      const incomingRev = revisionNumber(prefs?.revision);
      // Late GET safety: a stale read (older revision than the shared
      // confirmed snapshot) adopts the shared values instead of rolling back
      // this form and the global snapshot. Never invents server writes.
      if (incomingRev !== undefined && incomingRev < sharedComputerRevision && sharedComputer) {
        if (typeof sharedComputer.backend === 'string')
          backend = normalizeComputerBackend(sharedComputer.backend);
        if (typeof sharedComputer.model === 'string') model = sharedComputer.model;
        if (typeof sharedComputer.thinking === 'string') thinking = sharedComputer.thinking;
        if (computer && typeof computer === 'object') {
          known = true;
          supported = computer.supported !== false;
          status = computer;
          backends = Array.isArray(computer.backends) ? computer.backends : null;
        }
        showError(false);
      } else {
        backend = normalizeComputerBackend(prefs?.computerBackend);
        model = typeof prefs?.computerModel === 'string' ? prefs.computerModel : '';
        thinking = typeof prefs?.computerThinking === 'string' ? prefs.computerThinking : '';
        if (computer && typeof computer === 'object') {
          known = true;
          supported = computer.supported !== false;
          status = computer;
          backends = Array.isArray(computer.backends) ? computer.backends : null;
        } else {
          known = true;
          status = null;
        }
        publishComputer({ backend, model, thinking }, incomingRev);
      }
      showError(false);
    } catch (error) {
      if (turn !== generation) return;
      known = false;
      showError(error?.message || 'computer.preferencesError');
    } finally {
      if (turn === generation) busy = false;
      render();
    }
  }

  async function saveBackend(next) {
    const wanted = normalizeComputerBackend(next);
    if (wanted !== COMPUTER_BACKEND_NATIVE && wanted !== COMPUTER_BACKEND_CUA) return false;
    if (selectorDisabled() || !isAvailable(wanted)) return false;
    if (backend === wanted) {
      render();
      return true;
    }
    const previous = backend;
    backend = wanted;
    busy = true;
    render();
    try {
      const result = await api('/api/studio-preferences', {
        method: 'PATCH',
        body: { computerBackend: wanted },
      });
      backend = normalizeComputerBackend(result?.computerBackend);
      showError(false);
      render();
      publishComputer({ backend }, revisionNumber(result?.revision));
      try {
        await onChanged({ backend, model, thinking });
      } catch {}
      return true;
    } catch (error) {
      backend = previous;
      showError(error?.message || 'computer.preferencesError');
      render();
      return false;
    } finally {
      busy = false;
      render();
    }
  }

  async function saveModel(next) {
    const wanted = typeof next === 'string' ? next : '';
    if (locked() || busy || !known) return false;
    const previous = model;
    model = wanted;
    busy = true;
    render();
    try {
      const result = await api('/api/studio-preferences', {
        method: 'PATCH',
        body: { computerModel: wanted },
      });
      model = typeof result?.computerModel === 'string' ? result.computerModel : '';
      showError(false);
      render();
      publishComputer({ model }, revisionNumber(result?.revision));
      try {
        await onChanged({ backend, model, thinking });
      } catch {}
      return true;
    } catch (error) {
      model = previous;
      showError(error?.message || 'computer.preferencesError');
      render();
      return false;
    } finally {
      busy = false;
      render();
    }
  }

  function openPicker() {
    if (locked() || busy || !known) return;
    if (typeof openModelPicker !== 'function') return;
    const turn = generation;
    const button = $('computer-model-button');
    if (!button) return;
    openModelPicker({
      button,
      value: model || '',
      get title() {
        return tr('computer.modelLabel');
      },
      get defaultLabel() {
        return tr('computer.sameAsConversation');
      },
      get defaultDetail() {
        return tr('computer.modelNote');
      },
      onSelect(next) {
        if (turn !== generation || busy) return;
        void saveModel(next || '');
      },
    });
  }

  // A sibling's confirmed save lands here synchronously: adopt it unless an
  // own save is in flight (its completion publishes and wins instead).
  function onShared(next) {
    if (!next || busy) return;
    let changed = false;
    if (typeof next.backend === 'string' && next.backend !== backend) {
      backend = normalizeComputerBackend(next.backend);
      changed = true;
    }
    if (typeof next.model === 'string' && next.model !== model) {
      model = next.model;
      changed = true;
    }
    if (typeof next.thinking === 'string' && next.thinking !== thinking) {
      thinking = next.thinking;
      changed = true;
    }
    if (changed) render();
  }
  function start() {
    if (started) {
      render();
      return;
    }
    started = true;
    sharedComputerListeners.add(onShared);
    if (sharedComputer) onShared(sharedComputer);
    const native = $('computer-backend-native');
    if (native)
      native.onchange = () => {
        if (native.checked) void saveBackend(COMPUTER_BACKEND_NATIVE);
      };
    const cua = $('computer-backend-cua');
    if (cua)
      cua.onchange = () => {
        if (cua.checked) void saveBackend(COMPUTER_BACKEND_CUA);
      };
    const button = $('computer-model-button');
    if (button) button.onclick = () => openPicker();
    const thinkingSelect = $('computer-thinking');
    if (thinkingSelect)
      thinkingSelect.onchange = () => {
        void saveThinking(thinkingSelect.value || '');
      };
    try {
      offLanguage = onLanguageChange(() => render());
    } catch {}
    render();
  }

  async function saveThinkingPref(field, wanted, apply) {
    if (locked() || busy || !known) return false;
    const previous = apply();
    apply(wanted);
    busy = true;
    render();
    try {
      const result = await api('/api/studio-preferences', {
        method: 'PATCH',
        body: { [field]: wanted },
      });
      apply(typeof result?.[field] === 'string' ? result[field] : '');
      showError(false);
      render();
      publishComputer({ thinking }, revisionNumber(result?.revision));
      try {
        await onChanged({ backend, model, thinking });
      } catch {}
      return true;
    } catch (error) {
      apply(previous);
      showError(error?.message || 'computer.preferencesError');
      render();
      return false;
    } finally {
      busy = false;
      render();
    }
  }
  function saveThinking(next) {
    const wanted = typeof next === 'string' ? next : '';
    return saveThinkingPref('computerThinking', wanted, (value) => {
      if (value === undefined) return thinking;
      thinking = value;
    });
  }

  const ownedRoot = () =>
    typeof getElement === 'function'
      ? getElement('settings-dialog')
      : document.getElementById('settings-dialog');
  return {
    start,
    refresh,
    update: render,
    get root() {
      return ownedRoot();
    },
    dispose: () => {
      generation++;
      started = false;
      sharedComputerListeners.delete(onShared);
      try {
        offLanguage?.();
      } catch {}
      offLanguage = null;
    },
    saveBackend,
    saveModel,
    saveThinking,
    // Getters prefer the module-shared confirmed snapshot so the primary
    // (used by sendMessage) never sends a stale global after a clone update.
    getBackend: () => (typeof sharedComputer?.backend === 'string' ? sharedComputer.backend : backend),
    getModel: () => (typeof sharedComputer?.model === 'string' ? sharedComputer.model : model),
    getThinking: () => (typeof sharedComputer?.thinking === 'string' ? sharedComputer.thinking : thinking),
    get backend() {
      return backend;
    },
    get computerModel() {
      return model;
    },
  };
}
