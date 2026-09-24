import { t as tr, bindText, bindAttribute, translatedOption, translateKnown, getLanguage } from './i18n.js';
const node = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) bindText(item, () => text);
  return item;
};
const sources = {
  get stored() {
    return tr('ui.enregistre_sur_ce_pc');
  },
  environment: tr('providers.environment'),
  get prime_cli() {
    return tr('ui.configuration_prime_cli');
  },
  get models_json_key() {
    return tr('ui.configuration_des_modeles');
  },
  get models_json_command() {
    return tr('ui.gestionnaire_de_secrets');
  },
  get fallback() {
    return tr('ui.configuration_externe');
  },
  get stale() {
    return tr('ui.a_reconnecter');
  },
  get runtime() {
    return tr('ui.session_actuelle');
  },
};
export function createProviderSettings({ api, toast, allowed, onChanged }) {
  const dialog = node('dialog', 'modal providers-modal');
  dialog.id = 'providers-dialog';
  dialog.setAttribute('aria-labelledby', 'providers-title');
  dialog.innerHTML = `<header class="providers-heading"><div><span class="providers-eyebrow" data-i18n="ui.comptes_et_cles_api_ce_pc">COMPTES ET CLÉS API · CE PC</span><h2 id="providers-title" data-i18n="ui.fournisseurs">Fournisseurs</h2></div><button type="button" class="icon-button" id="providers-close" aria-label="Fermer les fournisseurs" data-i18n-aria-label="ui.fermer_les_fournisseurs">×</button></header>
    <div class="providers-content"><div id="providers-error" class="form-error" role="alert" hidden></div><div id="providers-view"></div></div>
    <footer class="providers-footer"><span data-i18n="ui.connexions_partagees_avec_prime_agent_sur_ce_pc">Connexions partagées avec Prime Agent sur ce PC.</span><button type="button" class="primary-button" id="providers-done" data-i18n="ui.termine">Terminé</button></footer>`;
  document.body.append(dialog);
  const $ = (id) => dialog.querySelector(`#${id}`),
    view = $('providers-view');
  let data,
    query = '',
    generation = 0,
    jobId,
    timer,
    mode = 'list',
    acting = false;
  const error = (value) => {
    bindText($('providers-error'), () => translateKnown(value || ''));
    $('providers-error').hidden = !value;
  };
  const button = (label, action, style = 'secondary-button') => {
    const item = node('button', style, () => translateKnown(label));
    item.type = 'button';
    item.onclick = action;
    return item;
  };
  function show(child) {
    view.replaceChildren(child);
    error();
    $('providers-content')?.scrollTo(0, 0);
  }
  async function changed() {
    try {
      await onChanged();
    } catch {
      toast(() => tr('ui.connexion_enregistree_le_catalogue_sera_actualise_a_la_prochaine'), true);
    }
  }
  async function load() {
    const current = ++generation;
    mode = 'list';
    clearTimeout(timer);
    show(node('p', 'providers-note', () => tr('ui.chargement_des_fournisseurs')));
    try {
      const next = await api('/api/providers');
      if (!dialog.open || current !== generation) return;
      data = next;
      if (data.activeLogin) {
        jobId = data.activeLogin;
        authView();
        void poll();
        return;
      }
      renderList();
    } catch (e) {
      if (current === generation && dialog.open) {
        show(button(() => tr('ui.reessayer'), load));
        error(translateKnown(e.message));
      }
    }
  }
  function renderList() {
    mode = 'list';
    const section = node('section');
    section.append(
      node('p', 'providers-intro', () =>
        tr('ui.connectez_un_compte_ou_ajoutez_une_cle_api_pour_retrouver_ses_mod'),
      ),
    );
    if (translateKnown(data.warning))
      section.append(node('p', 'provider-notice', () => translateKnown(data.warning)));
    if (data.busy)
      section.append(
        node('p', 'provider-notice', () =>
          tr('ui.des_agents_travaillent_vous_pouvez_ajouter_un_fournisseur_le_remp'),
        ),
      );
    const toolbar = node('div', 'providers-toolbar'),
      search = node('input');
    search.type = 'search';
    bindAttribute(search, 'placeholder', () => tr('ui.rechercher_un_fournisseur'));
    bindAttribute(search, 'aria-label', () => tr('ui.rechercher_un_fournisseur_2'));
    search.value = query;
    const count = node('p', 'providers-count'),
      list = node('div', 'providers-list');
    bindAttribute(list, 'aria-label', () => tr('ui.fournisseurs_disponibles'));
    const draw = () => {
      const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const entries = data.providers.filter((p) =>
        tokens.every((token) => `${p.name} ${p.id}`.toLocaleLowerCase().includes(token)),
      );
      bindText(count, () =>
        tr('count.providers', {
          count: entries.length,
          configured: data.providers.filter((p) => p.configured).length,
        }),
      );
      list.replaceChildren(...entries.map(card));
      if (!entries.length)
        list.append(
          node('p', 'providers-note', () =>
            tr('ui.aucun_fournisseur_trouve_les_fournisseurs_personnalises_se_creent'),
          ),
        );
    };
    search.oninput = () => {
      query = search.value;
      draw();
    };
    toolbar.append(
      search,
      button(() => tr('ui.actualiser'), load),
    );
    section.append(toolbar, count, list);
    show(section);
    draw();
    search.focus();
  }
  function card(entry) {
    const item = node('article', 'provider-card'),
      top = node('div', 'provider-card-top'),
      identity = node('div', 'provider-identity');
    item.dataset.provider = entry.id;
    identity.append(
      node('strong', '', () => entry.name),
      node('div', 'provider-meta', () =>
        tr('ui.modeles', {
          value1: entry.id,
          value2: entry.models,
          value3: entry.source ? ' · ' + (sources[entry.source] || tr('ui.configuration_externe')) : '',
        }),
      ),
    );
    top.append(
      node('span', 'provider-avatar', () => entry.name.slice(0, 1).toUpperCase()),
      identity,
      node('span', `provider-status${entry.configured ? ' configured' : ''}`, () =>
        entry.configured
          ? tr('ui.configure')
          : entry.source === 'stale'
            ? tr('ui.a_reconnecter')
            : tr('ui.non_configure'),
      ),
    );
    item.append(top);
    const actions = node('div', 'provider-actions');
    if (entry.methods.includes('oauth'))
      actions.append(
        button(
          () =>
            entry.credentialType === 'oauth' ? tr('ui.reconnecter_le_compte') : tr('ui.connecter_un_compte'),
          () => providerLogin(entry),
        ),
      );
    if (entry.methods.includes('api_key'))
      actions.append(
        button(
          () =>
            entry.credentialType === 'api_key' ? tr('ui.remplacer_la_cle') : tr('ui.ajouter_une_cle_api'),
          () => keyForm(entry),
        ),
      );
    if (entry.stored)
      actions.append(
        button(
          () => tr('ui.deconnecter'),
          () => removeForm(entry),
          'danger-text',
        ),
      );
    if (data.busy && (entry.stored || entry.configured))
      for (const action of actions.children) {
        action.disabled = true;
        bindAttribute(action, 'title', () => tr('ui.disponible_a_la_fin_des_executions'));
      }
    if (actions.children.length) item.append(actions);
    if (entry.id === 'openai-codex' && entry.credentialType === 'oauth') item.append(quotaBlock(entry));
    if (translateKnown(entry.guidance))
      item.append(node('p', 'provider-guidance', () => translateKnown(entry.guidance)));
    if (entry.source && entry.source !== 'stored')
      item.append(
        node('p', 'provider-guidance', () =>
          tr('ui.les_reglages_externes_restent_geres_a_leur_emplacement_d_origine'),
        ),
      );
    return item;
  }
  function formatQuotaDate(value) {
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) return '';
    const locale = getLanguage() === 'en' ? 'en-US' : 'fr-FR';
    try {
      return time.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
    } catch {
      return time.toLocaleString();
    }
  }
  function formatQuotaTime(value) {
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) return '';
    const locale = getLanguage() === 'en' ? 'en-US' : 'fr-FR';
    try {
      return time.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }
  function formatQuota(result) {
    if (!result || result.available !== true || (!result.short && !result.weekly))
      return tr('ui.quota_indisponible');
    const parts = [];
    if (typeof result.plan === 'string' && result.plan)
      parts.push(tr('ui.quota_plan', { plan: result.plan }));
    for (const [window, key] of [
      [result.short, 'ui.quota_courte'],
      [result.weekly, 'ui.quota_hebdo'],
    ]) {
      if (!window || typeof window.usedPercent !== 'number' || typeof window.remainingPercent !== 'number')
        continue;
      const reset =
        typeof window.resetAt === 'number' && Number.isFinite(window.resetAt)
          ? tr('ui.quota_reinitialisation', { date: formatQuotaDate(window.resetAt) })
          : '';
      parts.push(tr(key, { used: window.usedPercent, remaining: window.remainingPercent, reset }));
    }
    if (!parts.length) return tr('ui.quota_indisponible');
    if (typeof result.fetchedAt === 'number' && Number.isFinite(result.fetchedAt)) {
      const time = formatQuotaTime(result.fetchedAt);
      if (time) parts.push(tr('ui.quota_actualisee', { time }));
    }
    return parts.join('\n');
  }
  function quotaBar(label, usedPercent) {
    const row = document.createElement('div');
    row.className = 'quota-row';
    const head = document.createElement('div');
    head.className = 'quota-row-head';
    const name = document.createElement('span');
    bindText(name, label);
    const value = document.createElement('span');
    bindText(value, () => `${usedPercent}%`);
    head.append(name, value);
    const track = document.createElement('div');
    track.className = 'quota-bar';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(usedPercent));
    bindAttribute(track, 'aria-label', label);
    const fill = document.createElement('div');
    fill.className = 'quota-bar-fill';
    fill.style.width = `${Math.min(100, Math.max(0, usedPercent))}%`;
    track.append(fill);
    row.append(head, track);
    return row;
  }
  function renderQuotaBars(container, result) {
    container.replaceChildren();
    if (!result || result.available !== true) return;
    for (const [window, label] of [
      [result.short, () => tr('ui.quota_short_label')],
      [result.weekly, () => tr('ui.quota_weekly_label')],
    ]) {
      if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue;
      const used = Math.min(100, Math.max(0, Math.round(window.usedPercent * 10) / 10));
      container.append(quotaBar(label, used));
    }
  }
  function quotaBlock(entry) {
    const wrap = node('div', 'provider-quota');
    let snapshot = null;
    let failed = false;
    const line = node('p', 'provider-quota-line', () => {
      if (snapshot) return formatQuota(snapshot);
      if (failed) return tr('ui.quota_indisponible');
      return tr('ui.quota_non_consulte');
    });
    line.setAttribute('role', 'status');
    const bars = document.createElement('div');
    bars.className = 'quota-bars';
    bars.hidden = true;
    const refresh = button(
      () => tr('ui.quota_actualiser'),
      async () => {
        if (refresh.disabled) return;
        refresh.disabled = true;
        bindText(line, () => tr('ui.quota_chargement'));
        bars.hidden = true;
        bars.replaceChildren();
        try {
          const params = new URLSearchParams({ provider: entry.id, revision: entry.revision });
          const result = await api(`/api/providers/codex-usage?${params}`);
          if (result && result.available === true && (result.short || result.weekly)) {
            snapshot = result;
            failed = false;
          } else {
            snapshot = null;
            failed = true;
          }
        } catch {
          snapshot = null;
          failed = true;
        } finally {
          refresh.disabled = false;
          const current = snapshot;
          const wasFailed = failed;
          bindText(line, () => {
            if (current) return formatQuota(current);
            if (wasFailed) return tr('ui.quota_indisponible');
            return tr('ui.quota_non_consulte');
          });
          renderQuotaBars(bars, current);
          bars.hidden = !bars.childElementCount;
        }
      },
      'secondary-button provider-quota-refresh',
    );
    refresh.type = 'button';
    wrap.append(
      node('p', 'provider-quota-label', () => tr('ui.quota_codex_label')),
      line,
      bars,
      refresh,
    );
    return wrap;
  }
  function formShell(title) {
    mode = 'form';
    const form = node('form', 'provider-form');
    form.append(node('h3', '', () => title));
    show(form);
    return form;
  }
  function label(title, control) {
    const item = node('label', '', () => title);
    item.append(control);
    return item;
  }
  function keyForm(entry) {
    const form = formShell(entry.name),
      kind = node('select'),
      value = node('input');
    kind.append(
      translatedOption(() => tr('ui.cle_api'), 'key'),
      translatedOption(() => tr('providers.environment'), 'environment'),
    );
    value.type = 'password';
    value.autocomplete = 'off';
    value.spellcheck = false;
    value.required = true;
    value.maxLength = 8192;
    const valueLabel = label(() => tr('ui.cle_api'), value),
      note = node('p', 'providers-note', () =>
        tr('ui.la_cle_est_conservee_dans_le_stockage_natif_de_prime_agent_sur_ce'),
      );
    kind.onchange = () => {
      value.value = '';
      value.type = kind.value === 'key' ? 'password' : 'text';
      bindText(valueLabel.firstChild, () =>
        kind.value === 'key' ? tr('ui.cle_api') : tr('ui.nom_de_la_variable'),
      );
      bindAttribute(value, 'placeholder', () => (kind.value === 'key' ? '' : 'MON_FOURNISSEUR_API_KEY'));
    };
    form.append(
      label(() => tr('ui.mode_de_connexion'), kind),
      valueLabel,
      note,
    );
    if (entry.stored || entry.configured)
      form.append(
        node('p', 'provider-notice', () =>
          tr('ui.cette_action_remplace_la_connexion_actuelle_de_ce_fournisseur_att'),
        ),
      );
    if (translateKnown(entry.guidance))
      form.append(node('p', 'providers-note', () => translateKnown(entry.guidance)));
    const actions = node('div', 'provider-form-actions'),
      save = button(() => tr('ui.enregistrer'), null, 'primary-button');
    save.type = 'submit';
    actions.append(
      button(() => tr('ui.retour'), renderList),
      save,
    );
    form.append(actions);
    value.focus();
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (acting) return;
      acting = true;
      save.disabled = true;
      error();
      const body = { provider: entry.id, revision: entry.revision, kind: kind.value, value: value.value };
      try {
        await api('/api/providers/key', { method: 'POST', body });
        value.value = '';
        await changed();
        toast(() => tr('ui.connexion_enregistree'));
        if (dialog.open) await load();
      } catch (e) {
        error(translateKnown(e.message));
      } finally {
        body.value = '';
        acting = false;
        save.disabled = false;
      }
    };
  }
  function removeForm(entry) {
    const form = formShell(() => tr('ui.deconnecter_2', { value1: entry.name }));
    form.append(
      node('p', 'providers-note', () =>
        tr('ui.les_identifiants_enregistres_pour_ce_fournisseur_seront_retires_d'),
      ),
    );
    form.append(
      node('p', 'provider-notice', () =>
        tr('ui.cette_connexion_est_partagee_avec_les_agents_lances_hors_du_studi'),
      ),
    );
    const actions = node('div', 'provider-form-actions'),
      remove = button(() => tr('ui.confirmer_la_deconnexion'), null, 'danger-text');
    remove.type = 'submit';
    actions.append(
      button(() => tr('ui.annuler'), renderList),
      remove,
    );
    form.append(actions);
    actions.firstChild.focus();
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (acting) return;
      acting = true;
      remove.disabled = true;
      try {
        await api('/api/providers/disconnect', {
          method: 'POST',
          body: { provider: entry.id, revision: entry.revision },
        });
        await changed();
        toast(() => tr('ui.identifiants_enregistres_retires'));
        if (dialog.open) await load();
      } catch (e) {
        error(translateKnown(e.message));
      } finally {
        acting = false;
        remove.disabled = false;
      }
    };
  }
  // Subscription flows with account risks require acknowledgment before login.
  // API-key entry remains separate and never shows subscription consent.
  function providerLogin(entry) {
    if (entry && ['muse-code', 'anthropic'].includes(entry.id)) subscriptionConsentForm(entry);
    else startLogin(entry);
  }
  function subscriptionConsentForm(entry) {
    const prefix = entry.id === 'anthropic' ? 'providers.anthropic_subscription' : 'providers.muse_code';
    const form = formShell(entry.name);
    form.append(node('p', 'provider-notice', () => tr(`${prefix}_guidance`)));
    const check = node('input');
    check.type = 'checkbox';
    check.checked = false;
    const consent = node('label', 'provider-consent');
    consent.append(
      check,
      node('span', '', () => tr(`${prefix}_ack`)),
    );
    form.append(consent);
    const actions = node('div', 'provider-form-actions'),
      start = button(() => tr('ui.connecter_un_compte'), null, 'primary-button');
    start.type = 'submit';
    start.disabled = true;
    check.onchange = () => {
      start.disabled = !check.checked;
    };
    actions.append(
      button(() => tr('ui.retour'), renderList),
      start,
    );
    form.append(actions);
    check.focus();
    form.onsubmit = (event) => {
      event.preventDefault();
      if (!check.checked || acting) return;
      startLogin(entry);
    };
  }
  async function startLogin(entry) {
    if (acting) return;
    if (
      (entry.stored || entry.configured) &&
      !confirm(
        tr('ui.remplacer_la_connexion_de_attendez_aussi_la_fin_des_agents_lances', { value1: entry.name }),
      )
    )
      return;
    acting = true;
    error();
    try {
      const job = await api('/api/providers/login', {
        method: 'POST',
        body: { provider: entry.id, revision: entry.revision },
      });
      jobId = job.id;
      if (dialog.open) {
        authView();
        updateJob(job);
        void poll();
      }
    } catch (e) {
      error(translateKnown(e.message));
    } finally {
      acting = false;
    }
  }
  function authView() {
    mode = 'auth';
    const section = node('section');
    section.append(node('h3', '', () => tr('ui.connexion_au_fournisseur')));
    section.append(
      node('p', 'providers-note', () =>
        tr('ui.autorisez_la_connexion_sur_le_site_du_fournisseur_revenez_ensuite'),
      ),
    );
    const link = node('a', 'primary-button provider-auth-link', () => tr('ui.ouvrir_la_page_de_connexion'));
    link.id = 'provider-auth-link';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.hidden = true;
    const instructions = node('div', 'provider-instructions');
    instructions.id = 'provider-auth-instructions';
    instructions.hidden = true;
    const status = node('p', 'provider-auth-status', () => tr('ui.preparation_de_la_connexion'));
    status.id = 'provider-auth-status';
    status.setAttribute('role', 'status');
    const prompts = node('div', 'provider-prompts');
    prompts.id = 'provider-auth-prompts';
    const cancel = button(
      () => tr('ui.annuler_la_connexion'),
      async () => {
        cancel.disabled = true;
        try {
          await api(`/api/providers/login/${jobId}`, { method: 'DELETE' });
          clearTimeout(timer);
          jobId = null;
          await load();
        } catch (e) {
          error(translateKnown(e.message));
        } finally {
          cancel.disabled = false;
        }
      },
    );
    cancel.id = 'provider-auth-cancel';
    section.append(status, link, instructions, prompts, cancel);
    show(section);
  }
  function updateJob(job) {
    const link = $('provider-auth-link'),
      status = $('provider-auth-status');
    if (!link) return;
    link.hidden = !job.url;
    if (job.url) link.href = job.url;
    else link.removeAttribute('href');
    bindText($('provider-auth-instructions'), () => job.instructions || '');
    $('provider-auth-instructions').hidden = !job.instructions;
    bindText(
      status,
      () =>
        ({
          get preparing() {
            return tr('ui.preparation_de_la_connexion');
          },
          get waiting() {
            return tr('ui.en_attente_de_votre_autorisation');
          },
          get saving() {
            return tr('ui.enregistrement_de_la_connexion');
          },
        })[job.status] || '',
    );
    $('provider-auth-cancel').disabled = job.status === 'saving';
    const prompts = $('provider-auth-prompts');
    const ids = new Set(job.prompts.map((p) => p.id));
    for (const existing of [...prompts.children]) if (!ids.has(existing.dataset.prompt)) existing.remove();
    for (const prompt of job.prompts) {
      if ([...prompts.children].some((p) => p.dataset.prompt === prompt.id)) continue;
      const form = node('form', 'provider-form');
      form.dataset.prompt = prompt.id;
      const field = node(prompt.kind === 'select' ? 'select' : 'input');
      if (prompt.kind === 'select')
        for (const option of prompt.options) field.append(translatedOption(() => option.label, option.id));
      else {
        field.type = prompt.kind === 'manual' ? 'password' : 'text';
        bindAttribute(field, 'placeholder', () => prompt.placeholder || '');
        field.autocomplete = 'off';
        field.spellcheck = false;
        field.maxLength = 16000;
      }
      field.required = !prompt.allowEmpty;
      const send = button(() => tr('ui.valider'), null);
      send.type = 'submit';
      form.append(label(prompt.message, field), send);
      prompts.append(form);
      form.onsubmit = async (event) => {
        event.preventDefault();
        send.disabled = true;
        error();
        try {
          const next = await api(`/api/providers/login/${jobId}`, {
            method: 'POST',
            body: { promptId: prompt.id, value: field.value },
          });
          field.value = '';
          updateJob(next);
        } catch (e) {
          error(translateKnown(e.message));
        } finally {
          send.disabled = false;
        }
      };
    }
  }
  async function poll() {
    const current = generation,
      id = jobId;
    if (!dialog.open || mode !== 'auth' || !id) return;
    try {
      const job = await api(`/api/providers/login/${id}`);
      if (!dialog.open || current !== generation || jobId !== id || mode !== 'auth') return;
      if (['complete', 'error', 'cancelled'].includes(job.status)) {
        jobId = null;
        if (job.status === 'complete') {
          await changed();
          toast(() => tr('ui.compte_connecte_a_prime_agent'));
          await load();
        } else {
          await load();
          error(() => translateKnown(job.error) || tr('ui.connexion_annulee'));
        }
        return;
      }
      updateJob(job);
    } catch (e) {
      if (!dialog.open || current !== generation) return;
      error(translateKnown(e.message));
    }
    if (dialog.open && current === generation && mode === 'auth') timer = setTimeout(poll, 900);
  }
  dialog.addEventListener('close', () => {
    ++generation;
    clearTimeout(timer);
    view.replaceChildren();
    error();
  });
  $('providers-close').onclick = $('providers-done').onclick = () => dialog.close();
  document.getElementById('open-provider-settings').onclick = () => {
    if (!allowed()) return;
    dialog.showModal();
    void load();
  };
}
