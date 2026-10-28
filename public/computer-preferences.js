import { t as tr, bindText, bindAttribute, translateKnown, onLanguageChange } from './i18n.js';

// Single desktop engine: the custom native integration only. Any stored
// legacy 'cua' value is sanitized to 'native' and never sent back.
export const COMPUTER_BACKEND_NATIVE = 'native';

export function normalizeComputerBackend(value) {
  return COMPUTER_BACKEND_NATIVE;
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
// persisted server-side via /api/studio-preferences). The single native
// desktop engine needs no picker; only the Computer Use decision
// model+thinking live here, not in the Computer Use header. They apply only
// to the delegated desktop child, never to the main conversation
// model+thinking (main stays unchanged). Empty model means same as
// conversation but still in a separate child (no paid pick is forced).
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
    const button = $('computer-model-button');
    const nameEl = $('computer-model-name');
    const providerEl = $('computer-model-provider');
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
      const prefs = await api('/api/studio-preferences');
      if (turn !== generation) return;
      const incomingRev = revisionNumber(prefs?.revision);
      // Late GET safety: a stale read (older revision than the shared
      // confirmed snapshot) adopts the shared values instead of rolling back
      // this form and the global snapshot. Never invents server writes.
      // Stored legacy 'cua' values sanitize to 'native' via normalize.
      if (incomingRev !== undefined && incomingRev < sharedComputerRevision && sharedComputer) {
        if (typeof sharedComputer.model === 'string') model = sharedComputer.model;
        if (typeof sharedComputer.thinking === 'string') thinking = sharedComputer.thinking;
        backend = COMPUTER_BACKEND_NATIVE;
        known = true;
        showError(false);
      } else {
        backend = normalizeComputerBackend(prefs?.computerBackend);
        model = typeof prefs?.computerModel === 'string' ? prefs.computerModel : '';
        thinking = typeof prefs?.computerThinking === 'string' ? prefs.computerThinking : '';
        known = true;
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
  // The engine is native-only: any shared backend value sanitizes to native.
  function onShared(next) {
    if (!next || busy) return;
    let changed = false;
    if (backend !== COMPUTER_BACKEND_NATIVE) {
      backend = COMPUTER_BACKEND_NATIVE;
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
    saveModel,
    saveThinking,
    // Getters prefer the module-shared confirmed snapshot so the primary
    // (used by sendMessage) never sends a stale global after a clone update.
    // The engine is native-only: always 'native', never restored from storage.
    getBackend: () => COMPUTER_BACKEND_NATIVE,
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
