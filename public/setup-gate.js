import { t as tr, bindText } from './i18n.js';

// First-message gate. A conversation needs a connected provider plus main
// agent and subagent default models served by a connected provider: the
// engine's built-in default model fails with a 401 without credentials.
// Pure on purpose so the rule is unit-tested without a browser.
export function setupState({
  configuredProviders,
  models,
  mainModel,
  subagentModel,
  subagentDefaultsSupported = true,
}) {
  // Older servers did not report connected providers: never block them.
  if (!Array.isArray(configuredProviders)) return { complete: true, unknown: true };
  const connected = new Set(configuredProviders);
  // A provider counts once it serves a usable model (web search alone does not).
  const usable = models.filter(
    (model) => connected.has(model.provider) && model.availability !== 'unavailable',
  );
  const servable = (id) => Boolean(id) && usable.some((model) => model.id === id);
  const providers = [...new Set(usable.map((model) => model.provider))];
  const provider = providers.length > 0,
    main = provider && servable(mainModel),
    subagent = main && (subagentDefaultsSupported === false || servable(subagentModel));
  return { provider, main, subagent, providers, complete: provider && main && subagent };
}

const STEPS = ['provider', 'main', 'subagent'];

// The checklist shown in place of the starter cards in every welcome view
// (host and docked panes clone the same markup). It reads the shared state
// and only triggers the existing provider dialog and model pickers.
export function createSetupGate({
  getState,
  connectProvider,
  chooseMainModel,
  chooseSubagentModel,
  useMainForSubagents,
}) {
  const actions = {
    provider: connectProvider,
    main: chooseMainModel,
    subagent: chooseSubagentModel,
    'subagent-same': useMainForSubagents,
  };
  document.addEventListener('click', (event) => {
    const button = event.target.closest('.setup-gate [data-setup-action]');
    if (!button || button.disabled) return;
    void actions[button.dataset.setupAction]?.(button);
  });
  function modelName(id) {
    const model = getState().models.find((item) => item.id === id);
    return model ? `${model.name || model.id} · ${model.provider}` : '';
  }
  function renderInto(gate, view) {
    const { setup, mainModel, subagentModel, readOnly, providersAvailable } = view;
    const firstOpen = STEPS.find((id) => !setup[id]);
    const details = {
      provider: setup.provider
        ? tr('setup.provider_done', { value1: setup.providers.join(', ') })
        : tr('setup.provider_note'),
      main: setup.main ? modelName(mainModel) : tr('setup.main_note'),
      subagent: setup.subagent ? modelName(subagentModel) : tr('setup.subagent_note'),
    };
    for (const id of STEPS) {
      const row = gate.querySelector(`[data-setup-step="${id}"]`);
      if (!row) continue;
      row.hidden = id === 'subagent' && view.subagentDefaultsSupported === false;
      if (row.hidden) continue;
      const done = Boolean(setup[id]),
        current = id === firstOpen;
      row.dataset.state = done ? 'done' : current ? 'current' : 'pending';
      if (current) row.setAttribute('aria-current', 'step');
      else row.removeAttribute('aria-current');
      bindText(row.querySelector('.setup-gate-detail'), () => details[id]);
      for (const button of row.querySelectorAll('[data-setup-action]')) {
        const action = button.dataset.setupAction;
        // "Same as main" only helps when the main model is ready.
        button.hidden = action === 'subagent-same' ? !setup.main || done || !mainModel : false;
        button.disabled = readOnly || (!done && !current) || (action === 'provider' && !providersAvailable);
        button.className = current && action !== 'subagent' ? 'primary-button' : 'secondary-button';
        bindText(button, () =>
          action === 'subagent-same'
            ? tr('setup.same_as_main')
            : done
              ? tr(action === 'provider' ? 'setup.manage' : 'setup.change')
              : tr(action === 'provider' ? 'setup.connect' : 'setup.choose'),
        );
      }
    }
  }
  function render() {
    const state = getState();
    const incomplete = state.setup.complete === false;
    document.documentElement.toggleAttribute('data-setup-required', incomplete);
    for (const gate of document.querySelectorAll('.setup-gate')) {
      gate.hidden = !incomplete;
      if (incomplete) renderInto(gate, state);
    }
  }
  return { render };
}
