import { t as tr, bindText, translateKnown } from './i18n.js';
export function createRemoteAccessSettings({ api, isRemote, toast }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('remote-access-dialog'),
    form = $('remote-code-form');
  const fields = ['remote-code', 'remote-code-confirmation'];
  let revision,
    configured = false,
    busy = false,
    generation = 0;
  const showError = (message = '') => {
    bindText($('remote-code-error'), () => message);
    $('remote-code-error').hidden = !message;
  };
  function refresh() {
    $('remote-code-fields').disabled = busy || !configured;
    $('save-remote-code').disabled =
      busy || !configured || !/^[0-9]{8}$/.test($(fields[0]).value) || !/^[0-9]{8}$/.test($(fields[1]).value);
    bindText($('save-remote-code'), () => (busy ? tr('common.saving') : tr('ui.changer_le_code')));
  }
  function clear() {
    form.reset();
    for (const id of fields) $(id).type = 'password';
    revision = undefined;
    configured = false;
    showError();
  }
  dialog.addEventListener('close', () => {
    generation++;
    clear();
  });
  $('show-remote-code').onchange = (event) => {
    for (const id of fields) $(id).type = event.target.checked ? 'text' : 'password';
  };
  for (const id of fields)
    $(id).oninput = () => {
      showError();
      refresh();
    };
  $('open-remote-access').onclick = async () => {
    if (isRemote()) return;
    // Docked: the shared settings node stays open underneath (non-modal); the
    // remote-access dialog stacks as a real modal and returns via managers.
    const parent = $('settings-dialog');
    if (parent?.matches?.(':modal')) parent.close();
    clear();
    const turn = ++generation;
    busy = false;
    refresh();
    bindText($('remote-access-status'), () => tr('ui.chargement_de_l_acces_mobile'));
    if (!dialog.open) dialog.showModal();
    try {
      const data = await api('/api/remote-access');
      if (turn !== generation) return;
      revision = data.revision;
      configured = data.configured;
      bindText($('remote-access-status'), () =>
        configured
          ? tr('ui.un_meme_code_pour_le_wi_fi_tailscale_et_la_pwa')
          : tr('ui.l_acces_mobile_n_est_pas_encore_configure_sur_ce_pc'),
      );
      refresh();
      if (configured) $(fields[0]).focus();
    } catch (error) {
      if (turn !== generation) return;
      bindText($('remote-access-status'), () => tr('ui.code_d_acces_indisponible'));
      showError(
        error.status === 404
          ? tr('ui.cette_option_necessite_un_redemarrage_du_studio_apres_la_fin_des')
          : translateKnown(error.message),
      );
    }
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (isRemote() || busy || !configured) return;
    if (!form.reportValidity()) return;
    if ($(fields[0]).value !== $(fields[1]).value) {
      showError(tr('ui.les_deux_codes_ne_correspondent_pas'));
      $(fields[1]).focus();
      return;
    }
    const turn = generation;
    const body = { code: $(fields[0]).value, confirmation: $(fields[1]).value, revision };
    busy = true;
    refresh();
    showError();
    try {
      await api('/api/remote-access/code', { method: 'POST', body });
      if (turn === generation) dialog.close();
      toast(() => tr('ui.code_modifie_reconnectez_vos_appareils_avec_le_nouveau_code'));
    } catch (error) {
      if (turn === generation) showError(translateKnown(error.message));
    } finally {
      body.code = body.confirmation = '';
      if (turn === generation) {
        busy = false;
        refresh();
      }
    }
  };
}
