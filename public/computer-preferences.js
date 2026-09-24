import { t as tr, bindText, bindAttribute, translateKnown, onLanguageChange } from './i18n.js';

export const COMPUTER_BACKEND_NATIVE = 'native';
export const COMPUTER_BACKEND_CUA = 'cua';

export function normalizeComputerBackend(value) {
  return value === COMPUTER_BACKEND_CUA ? COMPUTER_BACKEND_CUA : COMPUTER_BACKEND_NATIVE;
}

// Global Computer Use preferences (Preferences > Tools, one global setting
// persisted server-side via /api/studio-preferences). The desktop engine radio
// group and the Computer Use model live here, not in the Computer Use
// header. Changes apply only when the desktop is off and not owned; the
// backend default is native with no silent fallback.
export function createComputerPreferences({ api, getContext = () => ({}), getModels, openModelPicker } = {}) {
  const $ = (id) => document.getElementById(id);
  let backend = COMPUTER_BACKEND_NATIVE;
  let model = '';
  let thinking = '';
  let backends = null;
  let status = null;
  let supported = true;
  let known = false;
  let busy = false;
  let generation = 0;

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

  function computerOn() {
    if (!status) return false;
    if (status.enabled === true) return true;
    return Boolean(status.owner);
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

  // The model row reuses the shared Studio model picker (openModelPicker,
  // the same menu as the conversation model). No filtering happens here:
  // image support is validated server-side (400 for text-only models).
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

  function start() {
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
      onLanguageChange(() => render());
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

  return {
    start,
    refresh,
    update: render,
    saveBackend,
    saveModel,
    saveThinking,
    getBackend: () => backend,
    getModel: () => model,
    getThinking: () => thinking,
    get backend() {
      return backend;
    },
    get computerModel() {
      return model;
    },
  };
}
