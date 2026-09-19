import {
  t as tr,
  bindText,
  bindAttribute,
  translatedOption,
  onLanguageChange,
  translateKnown,
} from './i18n.js';
import { thinkingLabels } from './reasoning.js';

export function createSubagentSettings({
  api,
  root,
  getModels,
  openModelPicker,
  icon,
  toast,
  project = false,
}) {
  const prefix = project ? 'project-subagent' : 'default-subagent';
  let data = null,
    cwd = '',
    busy = false,
    generation = 0,
    needsLoad = true;
  let context = {},
    draft = { model: '', thinking: '' };
  root.innerHTML = `
    <form class="subagent-form">
      <div class="subagent-heading">
        <h3>${project ? tr('ui.sous_agents_du_projet') : tr('agents.subagents')}</h3>
        ${
          project
            ? '<select class="subagent-scope" aria-label="Réglages des sous-agents du projet" data-i18n-aria-label="ui.reglages_des_sous_agents_du_projet"><option value="global" data-i18n="agents.global">Globaux</option><option value="project" data-i18n="ui.ce_projet">Ce projet</option></select>'
            : '<button id="save-subagent-defaults" class="primary-button" type="submit" data-i18n="ui.enregistrer">Enregistrer</button>'
        }
      </div>
      <fieldset class="subagent-fields">
        <div class="subagent-controls">
          <div class="subagent-model-field"><label id="${prefix}-model-label" data-i18n="ui.modele">Modèle</label>
            <button id="${prefix}-model" class="model-picker-button" type="button" aria-haspopup="dialog" aria-controls="model-dialog" aria-expanded="false">
              <span class="subagent-model-icon"></span>
              <span class="model-picker-selection"><span class="model-picker-name"></span><span class="model-picker-provider"></span></span>
              <span class="model-picker-chevron"></span>
            </button>
          </div>
          <div class="subagent-thinking-field">
            <label for="${prefix}-thinking" data-i18n="ui.reflexion_3">Réflexion</label>
            <select id="${prefix}-thinking"></select>
          </div>
        </div>
      </fieldset>
      <p class="subagent-status" role="status"></p>
      ${project ? '' : '<p class="model-defaults-note" data-i18n="ui.valeurs_par_defaut_pour_tous_les_projets_les_reglages_propres_a_u">Valeurs par défaut pour tous les projets. Les réglages propres à un projet se trouvent dans l’onglet Agents d’une session. Les choix explicites restent prioritaires ; les sous-agents déjà créés conservent leurs réglages.</p>'}
      <p class="subagent-error form-error" role="alert" hidden></p>
      <button class="subagent-reload inspector-refresh" type="button" hidden data-i18n="ui.recharger_les_reglages">Recharger les réglages</button>
    </form>`;
  const $ = (selector) => root.querySelector(selector);
  bindText($('.subagent-heading h3'), () => tr(project ? 'ui.sous_agents_du_projet' : 'agents.subagents'));
  const modelButton = $(`#${prefix}-model`),
    thinkingSelect = $(`#${prefix}-thinking`);
  $('.subagent-model-icon').append(icon('model'));
  $('.model-picker-chevron').append(icon('chevron'));
  $(`#${prefix}-model-label`).setAttribute('for', modelButton.id);
  const option = (value, label) => translatedOption(label, value);

  function error(message = '') {
    bindText($('.subagent-error'), () => translateKnown(message));
    $('.subagent-error').hidden = !message;
  }
  function controls() {
    const disabled = busy || !data || (project && (context.readOnly || !context.online));
    $('.subagent-fields').hidden = project && (!data || $('.subagent-scope').value === 'global');
    $('.subagent-fields').disabled = disabled;
    if (project) $('.subagent-scope').disabled = disabled;
    else $('#save-subagent-defaults').disabled = disabled;
  }
  function render(preserve = true) {
    const model = getModels().find((m) => m.id === draft.model);
    const name =
      model?.name ||
      (draft.model ? tr('common.unavailable', { value1: draft.model }) : tr('ui.defaut_du_moteur'));
    modelButton.value = draft.model;
    bindText($('.model-picker-name'), () => name);
    bindText(
      $('.model-picker-provider'),
      () => model?.provider || (draft.model ? tr('ui.modele_indisponible') : tr('ui.modele_natif_sinon_parent')),
    );
    bindAttribute(modelButton, 'title', () => draft.model || tr('ui.modele_natif_sinon_parent'));
    bindAttribute(modelButton, 'aria-label', () =>
      tr('ui.modele_des_sous_agents', { value1: name, value2: model ? ', ' + model.id : '' }),
    );
    const levels = model
      ? model.thinkingLevels || (model.reasoning ? Object.keys(thinkingLabels) : ['off'])
      : Object.keys(thinkingLabels);
    thinkingSelect.replaceChildren(option('', () => tr('ui.niveau_parent')));
    for (const level of levels) thinkingSelect.append(option(level, thinkingLabels[level] || level));
    if (draft.thinking && !levels.includes(draft.thinking)) {
      if (preserve) {
        const missing = option(draft.thinking, () =>
          tr('common.unavailable', { value1: thinkingLabels[draft.thinking] || draft.thinking }),
        );
        missing.disabled = true;
        thinkingSelect.append(missing);
      } else draft.thinking = '';
    }
    thinkingSelect.value = draft.thinking;
    if (project) $('.subagent-scope').value = data?.project === null ? 'global' : 'project';
    controls();
  }
  function status(message) {
    bindText($('.subagent-status'), () => message);
  }
  function savedStatus() {
    status(() =>
      project
        ? tr('ui.prochaines_delegations_2', {
            value1: data.project === null ? tr('ui.reglages_globaux') : tr('ui.reglages_du_projet'),
          })
        : tr('ui.applique_aux_prochaines_delegations_dans_tous_les_projets'),
    );
  }
  const endpoint = () =>
    project ? `/api/project-subagent-defaults?cwd=${encodeURIComponent(cwd)}` : '/api/subagent-defaults';
  async function load() {
    const turn = ++generation;
    busy = true;
    needsLoad = false;
    error();
    status(() => tr('ui.chargement_des_reglages'));
    controls();
    try {
      const response = await api(endpoint());
      if (turn !== generation) return;
      data = response;
      draft = { ...(project ? data.effective : data.global) };
      $('.subagent-reload').hidden = true;
      render();
      savedStatus();
    } catch (e) {
      if (turn !== generation) return;
      data = null;
      status(() => tr('ui.reglages_indisponibles'));
      error(() =>
        e.status === 404
          ? tr('ui.rechargez_le_studio_apres_sa_mise_a_jour_pour_acceder_a_ces_regla')
          : translateKnown(e.message),
      );
      $('.subagent-reload').hidden = false;
    } finally {
      if (turn === generation) {
        busy = false;
        controls();
      }
    }
  }
  async function save(policy = { ...draft }) {
    if (busy || !data || (project && (context.readOnly || !context.online))) return;
    const turn = ++generation;
    const body = { revision: data.revision, policy, ...(project ? { cwd } : {}) };
    busy = true;
    controls();
    error();
    status(() => tr('common.saving'));
    try {
      const saved = await api(endpoint(), { method: 'POST', body });
      if (turn !== generation) return;
      data = saved;
      draft = { ...(project ? data.effective : data.global) };
      $('.subagent-reload').hidden = true;
      render();
      savedStatus();
      document.dispatchEvent(
        new CustomEvent('subagent-defaults-changed', { detail: { source: root, cwd: project ? cwd : null } }),
      );
      if (!project) toast(() => tr('ui.reglages_des_sous_agents_enregistres'));
    } catch (e) {
      if (turn !== generation) return;
      status(() => tr('ui.modification_non_enregistree'));
      if (project) $('.subagent-scope').value = data.project === null ? 'global' : 'project';
      error(translateKnown(e.message));
      $('.subagent-reload').hidden = false;
    } finally {
      if (turn === generation) {
        busy = false;
        controls();
      }
    }
  }
  modelButton.onclick = () => {
    render();
    const turn = generation;
    openModelPicker({
      button: modelButton,
      value: draft.model,
      get title() {
        return tr('ui.modele_des_sous_agents_2');
      },
      get defaultLabel() {
        return tr('ui.defaut_du_moteur');
      },
      get defaultDetail() {
        return tr('ui.modele_natif_sinon_parent');
      },
      onSelect(model) {
        if (turn !== generation || busy || !data) return;
        draft.model = model;
        render(false);
        if (project) void save();
      },
    });
  };
  thinkingSelect.onchange = () => {
    draft.thinking = thinkingSelect.value;
    if (project) void save();
  };
  if (project)
    $('.subagent-scope').onchange = () => {
      void save($('.subagent-scope').value === 'global' ? null : { ...draft });
    };
  $('.subagent-form').onsubmit = (event) => {
    event.preventDefault();
    void save();
  };
  $('.subagent-reload').onclick = () => void load();
  function update(next = context) {
    context = next;
    if (!project) return;
    const nextCwd = context.enabled ? context.cwd || '' : '';
    if (cwd !== nextCwd) {
      generation++;
      cwd = nextCwd;
      data = null;
      busy = false;
      needsLoad = true;
      error();
      draft = { model: '', thinking: '' };
      render();
    }
    root.hidden = !cwd;
    controls();
    if (cwd && context.active && context.online && needsLoad && !busy) void load();
  }
  document.addEventListener('subagent-defaults-changed', (event) => {
    if (!project || event.detail.source === root || (event.detail.cwd && event.detail.cwd !== cwd)) return;
    needsLoad = true;
    update();
  });
  onLanguageChange(() => {
    render();
    if (data && !busy) savedStatus();
  });
  render();
  return { open: load, update };
}
