import { t as tr, bindText, bindAttribute, translateKnown, onLanguageChange } from './i18n.js';

const AUTONOMOUS_FIELDS = ['maxContinuations', 'maxTurns', 'maxTokens', 'timeoutMs'];
const MODEL_FIELDS = ['auxiliaryModel', 'providerBackupModel', 'nativeSubagentDefaultModel'];

function fieldLabel(field) {
  if (field === 'auxiliaryModel') return 'engine.auxiliary_label';
  if (field === 'providerBackupModel') return 'engine.backup_label';
  return 'engine.native_subagent_label';
}

function fieldNote(field) {
  if (field === 'auxiliaryModel') return 'engine.auxiliary_note';
  if (field === 'providerBackupModel') return 'engine.backup_note';
  return 'engine.native_subagent_note';
}

function budgetLabel(field) {
  if (field === 'maxContinuations') return 'engine.max_continuations';
  if (field === 'maxTurns') return 'engine.max_turns';
  if (field === 'maxTokens') return 'engine.max_tokens';
  return 'engine.timeout_ms';
}

// Advanced engine models use the shared Studio model picker (#model-dialog
// with search, providers and model info), exactly like the subagent and
// main-model selectors. There is no native <select> fallback: the host
// (app.js via settings.js) always wires getModels/openModelPicker/icon.
// Empty ("Défaut du moteur") means native engine default and is sent as
// null on save; drafts are never auto-filled and no autonomous mode is
// implied.
export function createEngineSettings({ api, getContext = () => ({}), getModels, openModelPicker, icon }) {
  const root = document.getElementById('engine-settings');
  if (!root) return { open: async () => {}, update: () => {} };
  let data = null;
  let catalog = [];
  let busy = false;
  let generation = 0;
  let needsLoad = true;
  // Unsaved model choices. '' stays '' (clear = native engine default).
  const drafts = { auxiliaryModel: '', providerBackupModel: '', nativeSubagentDefaultModel: '' };

  root.innerHTML = `
    <div class="model-defaults-heading">
      <div>
        <h3 id="engine-settings-heading" data-i18n="engine.advanced_models">Modèles avancés (Prime Agent 0.9.5)</h3>
      </div>
      <button id="save-engine-settings" class="primary-button" type="button" data-i18n="engine.save_engine">Enregistrer les réglages moteur</button>
    </div>
    <p class="model-defaults-note" data-i18n="engine.advanced_models_note"></p>
    <div class="engine-model-grid"></div>
    <div class="model-config-section-heading"><div><h3 data-i18n="engine.autonomous_title"></h3></div></div>
    <p class="model-defaults-note" data-i18n="engine.autonomous_note"></p>
    <div class="engine-budget-grid"></div>
    <p class="engine-status subagent-status" role="status"></p>
    <p class="engine-error form-error" role="alert" hidden></p>
    <div class="engine-actions">
      <button id="reload-engine-settings" class="secondary-button inspector-refresh" type="button" data-i18n="engine.reload_engine"></button>
    </div>`;

  const $ = (selector) => root.querySelector(selector);
  const saveButton = $('#save-engine-settings');
  const reloadButton = $('#reload-engine-settings');
  const modelGrid = $('.engine-model-grid');
  const budgetGrid = $('.engine-budget-grid');

  const pickerButtons = new Map();
  const budgetInputs = new Map();
  const budgetChecks = new Map();

  function liveModels() {
    try {
      const next = typeof getModels === 'function' ? getModels() : null;
      if (Array.isArray(next) && next.length) return next;
    } catch {}
    return catalog.length ? catalog : [];
  }

  function pickerDisplay(field, models) {
    const draft = drafts[field] || '';
    const model = models.find((entry) => entry?.id === draft);
    const name =
      model?.name || (draft ? tr('common.unavailable', { value1: draft }) : tr('ui.defaut_du_moteur'));
    const provider =
      model?.provider || (draft ? tr('ui.modele_indisponible') : tr('engine.advanced_models_note'));
    return { draft, model, name, provider };
  }

  function renderPickerModels() {
    const models = liveModels();
    for (const field of MODEL_FIELDS) {
      const entry = pickerButtons.get(field);
      if (!entry) continue;
      const { draft, model, name, provider } = pickerDisplay(field, models);
      entry.button.value = draft;
      bindText(entry.nameEl, () => pickerDisplay(field, liveModels()).name);
      bindText(entry.providerEl, () => pickerDisplay(field, liveModels()).provider);
      // Immediate text for the current language (bindText refreshes later
      // language changes without touching drafts).
      entry.nameEl.textContent = name;
      entry.providerEl.textContent = provider;
      bindAttribute(entry.button, 'title', () => draft || tr(fieldNote(field)));
      bindAttribute(
        entry.button,
        'aria-label',
        () =>
          `${tr(fieldLabel(field))}: ${pickerDisplay(field, liveModels()).name}${
            pickerDisplay(field, liveModels()).model ? `, ${draft}` : ''
          }`,
      );
      entry.button.setAttribute('title', draft || tr(fieldNote(field)));
      entry.button.setAttribute(
        'aria-label',
        `${tr(fieldLabel(field))}: ${name}${model ? `, ${draft}` : ''}`,
      );
    }
  }

  function openPicker(field) {
    if (busy || !data || readOnly()) return;
    if (typeof openModelPicker !== 'function') return;
    renderPickerModels();
    const turn = generation;
    const entry = pickerButtons.get(field);
    if (!entry) return;
    openModelPicker({
      button: entry.button,
      value: drafts[field] || '',
      get title() {
        return tr(fieldLabel(field));
      },
      get defaultLabel() {
        return tr('ui.defaut_du_moteur');
      },
      get defaultDetail() {
        return tr('engine.advanced_models_note');
      },
      onSelect(model) {
        if (turn !== generation || busy || !data) return;
        drafts[field] = model || '';
        renderPickerModels();
        refreshSave();
      },
    });
  }

  for (const field of MODEL_FIELDS) {
    const wrap = document.createElement('div');
    wrap.className = 'engine-field';
    const label = document.createElement('label');
    label.htmlFor = `engine-${field}`;
    label.dataset.i18n = fieldLabel(field);
    label.textContent = tr(fieldLabel(field));
    const button = document.createElement('button');
    button.id = `engine-${field}`;
    button.type = 'button';
    button.className = 'model-picker-button';
    button.dataset.engineModel = field;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'model-dialog');
    button.setAttribute('aria-expanded', 'false');
    const iconWrap = document.createElement('span');
    iconWrap.className = 'subagent-model-icon';
    iconWrap.setAttribute('aria-hidden', 'true');
    if (typeof icon === 'function') {
      try {
        iconWrap.append(icon('model'));
      } catch {}
    }
    const selection = document.createElement('span');
    selection.className = 'model-picker-selection';
    const nameEl = document.createElement('span');
    nameEl.className = 'model-picker-name';
    const providerEl = document.createElement('span');
    providerEl.className = 'model-picker-provider';
    selection.append(nameEl, providerEl);
    const chevron = document.createElement('span');
    chevron.className = 'model-picker-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    if (typeof icon === 'function') {
      try {
        chevron.append(icon('chevron'));
      } catch {}
    } else {
      chevron.textContent = '›';
    }
    button.append(iconWrap, selection, chevron);
    const note = document.createElement('p');
    note.className = 'model-defaults-note';
    note.dataset.i18n = fieldNote(field);
    note.textContent = tr(fieldNote(field));
    wrap.append(label, button, note);
    modelGrid.append(wrap);
    pickerButtons.set(field, { button, nameEl, providerEl });
    button.onclick = () => openPicker(field);
  }

  for (const field of AUTONOMOUS_FIELDS) {
    const wrap = document.createElement('div');
    wrap.className = 'engine-budget';
    const label = document.createElement('label');
    label.htmlFor = `engine-${field}`;
    label.dataset.i18n = budgetLabel(field);
    const row = document.createElement('div');
    row.className = 'engine-budget-row';
    const input = document.createElement('input');
    input.id = `engine-${field}`;
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.inputMode = 'numeric';
    input.placeholder = '';
    const checkWrap = document.createElement('label');
    checkWrap.className = 'engine-unlimited';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.dataset.engineUnlimited = field;
    const checkText = document.createElement('span');
    checkText.dataset.i18n = 'engine.unlimited';
    checkWrap.append(check, checkText);
    row.append(input, checkWrap);
    const hint = document.createElement('p');
    hint.className = 'model-defaults-note engine-default-hint';
    hint.dataset.engineDefault = field;
    wrap.append(label, row, hint);
    budgetGrid.append(wrap);
    budgetInputs.set(field, input);
    budgetChecks.set(field, check);
    const sync = () => {
      input.disabled = check.checked || busy || !data;
      refreshSave();
    };
    input.oninput = sync;
    check.onchange = sync;
  }

  function translateStatic() {
    for (const element of root.querySelectorAll('[data-i18n]')) {
      const key = element.dataset.i18n;
      if (!key) continue;
      bindText(element, () => tr(key));
    }
  }
  translateStatic();

  function error(message = '') {
    const box = $('.engine-error');
    bindText(box, () => (message ? translateKnown(message) : ''));
    box.hidden = !message;
  }

  function status(messageKey) {
    bindText($('.engine-status'), () => (messageKey ? tr(messageKey) : ''));
  }

  function readOnly() {
    const context = getContext();
    return !!(context.remote || context.readOnly);
  }

  // Dirty tracking: the server treats absent fields as unchanged, so save()
  // only sends modified fields. A stale catalog entry (stored model missing
  // or unavailable) is therefore preserved untouched when the user only
  // edits budgets.
  function storedModel(field) {
    return data?.[field] || '';
  }
  function modelDirty(field) {
    return (drafts[field] || '') !== storedModel(field);
  }
  function budgetDraft(field) {
    if (budgetChecks.get(field).checked) return 'unlimited';
    const raw = budgetInputs.get(field).value.trim();
    return raw ? Number(raw) : null;
  }
  function budgetStored(field) {
    return data?.autonomous?.[field] ?? null;
  }
  function budgetDirty(field) {
    return budgetDraft(field) !== budgetStored(field);
  }
  function isDirty() {
    return !!data && (MODEL_FIELDS.some(modelDirty) || AUTONOMOUS_FIELDS.some(budgetDirty));
  }
  function refreshSave() {
    saveButton.disabled = busy || !data || readOnly() || !isDirty();
  }

  function applyReadOnly() {
    const locked = readOnly() || busy || !data;
    for (const entry of pickerButtons.values()) entry.button.disabled = locked;
    for (const field of AUTONOMOUS_FIELDS) {
      budgetInputs.get(field).disabled = locked || budgetChecks.get(field).checked;
      budgetChecks.get(field).disabled = locked;
    }
    refreshSave();
    saveButton.hidden = readOnly();
    if (readOnly() && data) status('engine.disabled_remote');
  }

  function syncDraftsFromData() {
    for (const field of MODEL_FIELDS) drafts[field] = data?.[field] || '';
  }

  function fillBudgets() {
    for (const field of AUTONOMOUS_FIELDS) {
      const stored = data?.autonomous?.[field] ?? null;
      const input = budgetInputs.get(field);
      const check = budgetChecks.get(field);
      if (stored === 'unlimited') {
        check.checked = true;
        input.value = '';
      } else if (typeof stored === 'number') {
        check.checked = false;
        input.value = String(stored);
      } else {
        check.checked = false;
        input.value = '';
      }
      const hint = root.querySelector(`[data-engine-default="${field}"]`);
      const fallback = data?.defaults?.autonomous?.[field];
      bindText(hint, () =>
        tr('engine.default_value', { value1: fallback === undefined ? '—' : String(fallback) }),
      );
      // Show native default as placeholder for empty (revert-to-default) fields.
      input.placeholder = fallback === undefined ? '' : String(fallback);
    }
  }

  function render() {
    if (!data) return;
    renderPickerModels();
    fillBudgets();
    applyReadOnly();
  }

  async function load() {
    const turn = ++generation;
    busy = true;
    needsLoad = false;
    error();
    status('engine.loading_engine');
    applyReadOnly();
    try {
      // Shared catalog lives in the host (app.js state.models, refreshed
      // when the picker dialog opens). Only engine settings are fetched
      // here so a down catalog never blocks budgets; buttons fall back to
      // automatic + stored stale value with an "unavailable" label.
      const settings = await api('/api/engine-settings');
      if (turn !== generation) return;
      data = settings;
      try {
        const shared = typeof getModels === 'function' ? getModels() : null;
        catalog = Array.isArray(shared) ? shared : [];
      } catch {
        catalog = [];
      }
      status(catalog.length ? '' : 'engine.models_unavailable');
      error();
      syncDraftsFromData();
      render();
      if (readOnly()) status('engine.disabled_remote');
    } catch (e) {
      if (turn !== generation) return;
      data = null;
      catalog = [];
      status('engine.unavailable_engine');
      error(
        e.status === 404
          ? tr('ui.rechargez_le_studio_apres_sa_mise_a_jour_pour_acceder_a_ces_regla')
          : translateKnown(e.message),
      );
    } finally {
      if (turn === generation) {
        busy = false;
        applyReadOnly();
      }
    }
  }

  async function save() {
    if (busy || !data || readOnly()) return;
    const turn = ++generation;
    busy = true;
    applyReadOnly();
    error();
    status('common.saving');
    if (!isDirty()) {
      busy = false;
      applyReadOnly();
      return;
    }
    const body = { revision: data.revision };
    for (const field of MODEL_FIELDS) if (modelDirty(field)) body[field] = drafts[field] || null;
    const autonomous = {};
    try {
      for (const field of AUTONOMOUS_FIELDS) {
        if (!budgetDirty(field)) continue;
        const check = budgetChecks.get(field);
        const input = budgetInputs.get(field);
        if (check.checked) {
          autonomous[field] = 'unlimited';
          continue;
        }
        const raw = input.value.trim();
        if (!raw) {
          autonomous[field] = null;
          continue;
        }
        if (!/^\d+$/.test(raw)) throw new Error(tr('server.budget_autonome_invalide'));
        const parsed = Number(raw);
        if (!Number.isSafeInteger(parsed) || parsed < 1)
          throw new Error(tr('server.budget_autonome_invalide'));
        autonomous[field] = parsed;
      }
    } catch (e) {
      busy = false;
      applyReadOnly();
      status('engine.unsaved_engine');
      error(translateKnown(e.message));
      return;
    }
    if (Object.keys(autonomous).length) body.autonomous = autonomous;
    try {
      const saved = await api('/api/engine-settings', { method: 'POST', body });
      if (turn !== generation) return;
      data = saved;
      syncDraftsFromData();
      render();
      status('engine.saved_engine');
      error();
    } catch (e) {
      if (turn !== generation) return;
      status('engine.unsaved_engine');
      error(translateKnown(e.message));
      if (e.status === 409) {
        // Advise CAS retry: reload before the next deliberate save.
        needsLoad = true;
      }
    } finally {
      if (turn === generation) {
        busy = false;
        applyReadOnly();
      }
    }
  }

  saveButton.onclick = () => void save();
  reloadButton.onclick = () => void load();

  // The model-config dialog is owned by app.js.
  // Strategy: closing abandons the unsaved draft; every opening reloads
  // fresh settings (also picking up other tabs' saves). In-flight loads are
  // never cancelled on close: cancelling would skip the busy reset and wedge
  // the form disabled. A stale completion is discarded by the generation
  // guard and simply leaves needsLoad=true for the next opening.
  const dialog = document.getElementById('model-config-dialog');
  if (dialog) {
    new MutationObserver(() => {
      if (dialog.open) {
        if (needsLoad && !busy) void load();
      } else {
        needsLoad = true;
      }
    }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
    if (dialog.open && needsLoad) void load();
  }

  // Shared catalog can refresh while the picker dialog is open (app.js
  // refreshModelCatalog). Re-render button labels on dialog close so a stale
  // draft that just became available shows its real name; drafts are kept.
  // Engine drafts never touch the conversation model: picking only edits the
  // local draft; only an explicit engine save POSTs.
  const modelDialog = document.getElementById('model-dialog');
  if (modelDialog) {
    modelDialog.addEventListener('close', () => {
      if (data && !busy) {
        try {
          const shared = typeof getModels === 'function' ? getModels() : null;
          catalog = Array.isArray(shared) ? shared : catalog;
        } catch {}
        renderPickerModels();
        refreshSave();
      }
    });
  }

  onLanguageChange(() => {
    translateStatic();
    // Draft-preserving: bound texts refresh through bindText automatically;
    // control values are never refilled here so unsaved budgets and picker
    // drafts survive FR<->EN. Picker labels re-render from drafts.
    if (data) renderPickerModels();
  });

  return {
    open: load,
    update: () => {
      if (data) {
        try {
          const shared = typeof getModels === 'function' ? getModels() : null;
          if (Array.isArray(shared)) catalog = shared;
        } catch {}
        renderPickerModels();
      }
      applyReadOnly();
    },
  };
}
