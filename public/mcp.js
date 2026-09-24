import { t as tr, bindAttribute, bindText, translateKnown } from './i18n.js';
const node = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) bindText(item, () => text);
  return item;
};
const statusLabel = {
  get invalid() {
    return tr('ui.configuration_a_corriger');
  },
  get configured() {
    return tr('ui.configure');
  },
  get disabled() {
    return tr('ui.desactive');
  },
  get 'missing-env'() {
    return tr('ui.variable_manquante');
  },
  get 'login-required'() {
    return tr('ui.connexion_requise');
  },
  get reserved() {
    return tr('ui.nom_natif_reserve');
  },
};
export function createMcpSettings({ api, toast }) {
  const dialog = node('dialog', 'modal mcp-modal');
  dialog.id = 'mcp-dialog';
  dialog.setAttribute('aria-labelledby', 'mcp-title');
  dialog.innerHTML = `
    <header class="mcp-heading"><div><span class="mcp-eyebrow" data-i18n="ui.outils_et_services">OUTILS ET SERVICES</span><h2 id="mcp-title" data-i18n="ui.connexions_mcp">Connexions MCP</h2></div><button id="mcp-close" class="icon-button" aria-label="Fermer les connexions MCP" data-i18n-aria-label="ui.fermer_les_connexions_mcp">×</button></header>
    <div class="mcp-content">
      <p class="mcp-intro" data-i18n="ui.reliez_prime_agent_a_vos_services_et_a_vos_outils_locaux_la_confi">Reliez Prime Agent à vos services et à vos outils locaux. La configuration est partagée par les projets sur ce PC.</p>
      <div id="mcp-error" class="form-error" role="alert" hidden></div>
      <section id="mcp-list-view"><div class="mcp-list-toolbar"><label class="sr-only" for="mcp-search" data-i18n="ui.rechercher_un_mcp">Rechercher un MCP</label><input id="mcp-search" type="search" placeholder="Rechercher une connexion…" data-i18n-placeholder="ui.rechercher_une_connexion"><button id="mcp-add" class="primary-button" data-i18n="ui.ajouter_un_mcp">Ajouter un MCP</button></div><div id="mcp-list" aria-live="polite"></div></section>
      <form id="mcp-form" hidden>
        <div class="mcp-form-heading"><h3 id="mcp-form-title" data-i18n="ui.ajouter_un_mcp">Ajouter un MCP</h3><button type="button" id="mcp-back" class="secondary-button" data-i18n="ui.retour">Retour</button></div>
        <div class="mcp-form-grid">
          <label><span data-i18n="ui.nom_du_serveur">Nom du serveur</span><input id="mcp-name" required maxlength="64" placeholder="mon-service" data-i18n-placeholder="example.mcpName" autocomplete="off"></label>
          <label>Connexion<select id="mcp-type"><option value="http" data-i18n="ui.http_service_distant">HTTP · service distant</option><option value="stdio" data-i18n="ui.stdio_processus_sur_le_pc">stdio · processus sur le PC</option></select></label>
          <div id="mcp-http" class="mcp-wide mcp-form-grid">
            <label class="mcp-wide"><span data-i18n="ui.adresse_du_serveur">Adresse du serveur</span><input id="mcp-url" type="url" placeholder="https://exemple.fr/mcp" data-i18n-placeholder="example.mcpUrl" autocomplete="off"></label>
            <label><span data-i18n="mcp.auth">Authentification</span><select id="mcp-auth"><option value="none" data-i18n="ui.aucune">Aucune</option><option value="token" data-i18n="ui.jeton_direct">Jeton direct (secret)</option><option value="bearer" data-i18n="ui.jeton_par_variable_d_environnement">Jeton par variable d’environnement</option><option value="oauth" data-i18n="ui.connexion_oauth">Connexion OAuth</option></select></label>
            <label id="mcp-token-row" hidden><span id="mcp-token-label" data-i18n="ui.variable_contenant_le_jeton">Variable contenant le jeton</span><input id="mcp-token" placeholder="MON_SERVICE_TOKEN" data-i18n-placeholder="example.tokenVariable" autocomplete="off"><small id="mcp-token-hint" class="mcp-note" hidden></small></label>
          </div>
          <div id="mcp-stdio" class="mcp-wide mcp-form-grid" hidden>
            <label class="mcp-wide"><span data-i18n="ui.executable_sur_le_pc">Exécutable sur le PC</span><input id="mcp-command" placeholder="node" autocomplete="off"></label>
            <label class="mcp-wide"><span data-i18n="ui.arguments_un_argument_par_ligne">Arguments · un argument par ligne</span><textarea id="mcp-args" rows="3" placeholder="C:\\outils\\serveur.js&#10;--stdio" spellcheck="false"></textarea></label>
            <label class="mcp-wide"><span data-i18n="ui.dossier_de_travail_facultatif">Dossier de travail · facultatif</span><input id="mcp-cwd" placeholder="C:\\mes-outils" autocomplete="off"></label>
            <label class="mcp-wide"><span data-i18n="mcp.envMapping">Variables · NOM_ENFANT=NOM_VARIABLE_DU_PC</span><textarea id="mcp-env" rows="2" placeholder="TOKEN=MON_SERVICE_TOKEN" spellcheck="false"></textarea></label>
          </div>
        </div>
        <details class="mcp-advanced"><summary data-i18n="ui.options_avancees">Options avancées</summary>
          <div class="mcp-form-grid">
            <label><span data-i18n="ui.delai_de_demarrage_ms">Délai de démarrage · ms</span><input id="mcp-startup" type="number" min="1000" max="300000" step="1000" value="20000"></label>
            <label><span data-i18n="ui.delai_par_appel_ms">Délai par appel · ms</span><input id="mcp-timeout" type="number" min="1000" max="300000" step="1000" value="60000"></label>
            <label><span data-i18n="ui.acces_aux_outils">Accès aux outils</span><select id="mcp-tools-mode"><option value="all" data-i18n="ui.tous_sauf_les_outils_interdits">Tous sauf les outils interdits</option><option value="selected" data-i18n="ui.seulement_la_liste_autorisee">Seulement la liste autorisée</option></select><textarea id="mcp-enabled-tools" aria-label="Outils autorisés, un par ligne" data-i18n-aria-label="ui.outils_autorises_un_par_ligne" rows="3" placeholder="Un outil par ligne" data-i18n-placeholder="ui.un_outil_par_ligne" spellcheck="false" hidden></textarea><small id="mcp-tools-note" hidden data-i18n="ui.une_liste_vide_n_autorise_aucun_outil">Une liste vide n’autorise aucun outil.</small></label>
            <label><span data-i18n="ui.outils_interdits_un_par_ligne">Outils interdits · un par ligne</span><textarea id="mcp-disabled-tools" rows="3" spellcheck="false"></textarea></label>
            <div id="mcp-oauth-identity" class="mcp-wide mcp-form-grid" hidden>
              <label><span data-i18n="mcp.oauthClientId">Client OAuth ID</span><input id="mcp-oauth-client-id" maxlength="512" autocomplete="off" spellcheck="false"></label>
              <label><span data-i18n="mcp.oauthClientSecretEnv">Variable du secret client</span><input id="mcp-oauth-client-secret-env" maxlength="128" autocomplete="off" spellcheck="false" placeholder="MY_OAUTH_CLIENT_SECRET"></label>
              <label class="mcp-wide"><span data-i18n="mcp.oauthMetadataUrl">URL des métadonnées client</span><input id="mcp-oauth-metadata-url" type="url" autocomplete="off" spellcheck="false" placeholder="https://example.com/client.json"></label>
              <label class="mcp-wide"><span data-i18n="mcp.oauthScopes">Scopes OAuth, un par ligne</span><textarea id="mcp-oauth-scopes" rows="2" spellcheck="false"></textarea></label>
              <p class="mcp-wide mcp-note" data-i18n="mcp.oauthIdentityNote"></p>
            </div>
            <label id="mcp-headers-row" class="mcp-wide"><span data-i18n="ui.en_tetes_http_objet_json">En-têtes HTTP · objet JSON</span><textarea id="mcp-headers" rows="3" spellcheck="false" placeholder='{"X-Service": "valeur"}' data-i18n-placeholder="example.mcpHeaders"></textarea><small data-i18n="ui.une_valeur_null_conserve_l_en_tete_prive_existant_les_valeurs_enr">Une valeur null conserve l’en-tête privé existant. Les valeurs enregistrées ne sont pas renvoyées au navigateur.</small></label>
          </div>
        </details>
        <p id="mcp-private-url-note" class="mcp-note" hidden data-i18n="ui.les_parametres_prives_de_l_adresse_sont_conserves_tant_que_vous_n">Les paramètres privés de l’adresse sont conservés tant que vous ne changez pas celle-ci.</p>
        <p class="mcp-note" data-i18n="ui.enregistrer_prepare_la_connexion_tester_demarre_une_connexion_sep">Enregistrer prépare la connexion. « Tester » démarre une connexion séparée pour découvrir ses outils ; aucun outil métier n’est exécuté.</p>
        <div id="mcp-form-error" class="form-error" role="alert" hidden></div>
        <div class="modal-actions"><button id="mcp-save" class="primary-button" type="submit" data-i18n="ui.enregistrer">Enregistrer</button></div>
      </form>
      <section id="mcp-test-view" hidden><div class="mcp-form-heading"><h3 id="mcp-test-title" data-i18n="ui.test_de_connexion">Test de connexion</h3><button id="mcp-test-back" class="secondary-button" data-i18n="ui.retour">Retour</button></div><p id="mcp-test-status" role="status"></p><div id="mcp-tools"></div></section>
      <section id="mcp-oauth-view" hidden><h3 id="mcp-oauth-title" data-i18n="ui.connexion_oauth">Connexion OAuth</h3><p id="mcp-oauth-status" role="status"></p><a id="mcp-oauth-link" class="primary-button" target="_blank" rel="noopener noreferrer" hidden data-i18n="ui.autoriser_dans_le_navigateur">Autoriser dans le navigateur</a><p class="mcp-note" data-i18n="ui.sur_mobile_apres_autorisation_le_navigateur_peut_afficher_une_adr">Sur mobile, après autorisation, le navigateur peut afficher une adresse localhost inaccessible. Copiez cette adresse complète et collez-la ici. Sur le PC, le retour est automatique.</p><form id="mcp-oauth-form"><label for="mcp-oauth-return" data-i18n="ui.adresse_complete_de_retour">Adresse complète de retour</label><input id="mcp-oauth-return" type="url" autocomplete="off" spellcheck="false" placeholder="http://localhost:53700/callback?…" required><div class="modal-actions"><button id="mcp-oauth-cancel" type="button" class="secondary-button" data-i18n="ui.annuler">Annuler</button><button type="submit" class="primary-button" data-i18n="ui.valider_le_retour">Valider le retour</button></div></form></section>
      <section id="mcp-remove-view" hidden><h3 id="mcp-remove-title" data-i18n="ui.supprimer_cette_connexion">Supprimer cette connexion ?</h3><p data-i18n="ui.la_configuration_de_ce_serveur_et_ses_identifiants_mcp_enregistre">La configuration de ce serveur et ses identifiants MCP enregistrés seront retirés. Les autres connexions et les comptes de modèles sont conservés.</p><div class="modal-actions"><button id="mcp-remove-cancel" class="secondary-button" data-i18n="ui.annuler">Annuler</button><button id="mcp-remove-confirm" class="primary-button danger-button" data-i18n="ui.supprimer">Supprimer</button></div></section>
    </div><footer class="mcp-footer" data-i18n="ui.les_nouveaux_reglages_s_appliquent_aux_nouvelles_sessions_les_ses">Les nouveaux réglages s’appliquent aux nouvelles sessions. Les sessions déjà en cours continuent avec leurs connexions actuelles.</footer>`;
  document.body.append(dialog);
  const $ = (id) => dialog.querySelector('#' + id);
  let servers = [],
    editing,
    editingTokenMode = false,
    removing,
    oauthJob,
    pollTimer,
    generation = 0;
  function error(message, id = 'mcp-error') {
    bindText($(id), () => translateKnown(message || ''));
    $(id).hidden = !message;
  }
  function view(name) {
    for (const part of ['list-view', 'form', 'test-view', 'oauth-view', 'remove-view'])
      $('mcp-' + part).hidden = part !== name;
    error('');
    dialog.querySelector('.mcp-content').scrollTop = 0;
  }
  async function load() {
    const data = await api('/api/mcp');
    servers = data.servers || [];
    render();
  }
  function action(label, handler, className = 'secondary-button') {
    const button = node('button', className, () => translateKnown(label));
    button.type = 'button';
    button.onclick = async () => {
      button.disabled = true;
      try {
        await handler();
      } catch (e) {
        error(translateKnown(e.message));
      } finally {
        button.disabled = false;
      }
    };
    return button;
  }
  function render() {
    const root = $('mcp-list');
    root.replaceChildren();
    const query = $('mcp-search').value.toLocaleLowerCase();
    for (const server of servers.filter((s) => `${s.label} ${s.name}`.toLocaleLowerCase().includes(query))) {
      const card = node('article', 'mcp-card');
      card.dataset.name = server.name;
      const heading = node('div', 'mcp-card-heading'),
        title = node('div');
      title.append(
        node('h3', '', () => server.label),
        node('p', 'mcp-transport', () =>
          server.builtin
            ? tr('ui.integration_native_oauth')
            : server.config.type === 'stdio'
              ? tr('ui.processus_local_stdio')
              : tr('ui.service_distant_http'),
        ),
      );
      heading.append(
        title,
        node('span', `mcp-status ${server.status}`, () =>
          server.authenticated && server.status === 'configured'
            ? tr('ui.authentifie')
            : statusLabel[server.status] || server.status,
        ),
      );
      card.append(
        heading,
        node(
          'p',
          'mcp-endpoint',
          () => server.config.url || server.config.command || tr('ui.configuration_invalide'),
        ),
      );
      if (server.missingEnv.length)
        card.append(
          node('p', 'mcp-warning', () => tr('ui.a_definir_sur_le_pc') + server.missingEnv.join(', ')),
        );
      const buttons = node('div', 'mcp-card-actions');
      if (!['invalid', 'reserved', 'disabled', 'login-required', 'missing-env'].includes(server.status))
        buttons.append(
          action(
            () => tr('ui.tester'),
            () => test(server),
          ),
        );
      if (server.config.oauth && !['invalid', 'reserved', 'disabled'].includes(server.status))
        buttons.append(
          action(
            () => (server.authenticated ? tr('ui.reconnecter') : tr('ui.connecter')),
            () => login(server),
          ),
        );
      if (server.authenticated)
        buttons.append(
          action(
            () => tr('ui.deconnecter'),
            async () => {
              await api('/api/mcp/disconnect', {
                method: 'POST',
                body: { name: server.name, revision: server.revision },
              });
              await load();
            },
          ),
        );
      if (!server.builtin) {
        buttons.append(
          action(
            () => tr('ui.modifier'),
            () => edit(server),
          ),
          action(
            () => (server.config.enabled === false ? tr('ui.activer') : tr('ui.desactiver')),
            async () => {
              await api('/api/mcp', {
                method: 'PATCH',
                body: {
                  name: server.name,
                  revision: server.revision,
                  enabled: server.config.enabled === false,
                },
              });
              await load();
            },
          ),
          action(
            () => tr('ui.supprimer'),
            () => {
              removing = server;
              bindText($('mcp-remove-title'), () => tr('mcp.removeConfirm', { value1: server.name }));
              view('remove-view');
            },
            'danger-text',
          ),
        );
      }
      card.append(buttons);
      root.append(card);
    }
    if (!root.children.length)
      root.append(
        node('p', 'mcp-empty', () =>
          query
            ? tr('ui.aucune_connexion_ne_correspond_a_votre_recherche')
            : tr('ui.ajoutez_votre_premiere_connexion_mcp'),
        ),
      );
  }
  // Pasted secrets fail the variable name pattern. Same rule as the server
  // (lib/mcp-oauth-errors.mjs): known token prefixes, JWT shape, or long
  // mixed secrets without a conventional ENV_NAME shape mean a token.
  const TOKEN_PREFIXES = [
    'sbp_v0_',
    'sbp_',
    'ghp_',
    'gho_',
    'github_pat_',
    'glpat-',
    'sk_live_',
    'sk-',
    'xoxb-',
    'xoxp-',
  ];
  const looksLikeToken = (value) => {
    const text = String(value || '').trim();
    if (!text) return false;
    const lower = text.toLowerCase();
    for (const prefix of TOKEN_PREFIXES) if (lower.startsWith(prefix)) return true;
    if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) return true;
    if (/^[A-Z_][A-Z0-9_]*$/.test(text)) return false;
    if (text.length >= 32 && /[a-z]/.test(text) && /[0-9]/.test(text)) return true;
    if (/[^A-Za-z0-9_]/.test(text) && text.length >= 12) return true;
    return text.length > 64;
  };
  function tokenHint() {
    const mode = $('mcp-auth').value;
    if (mode === 'token') {
      const kept = !!editing?.config.headers && Object.hasOwn(editing.config.headers, 'Authorization');
      return kept ? tr('ui.secret_enregistre_laissez_vide_pour_conserver') : tr('ui.collez_le_jeton_secret');
    }
    if (mode === 'bearer' && looksLikeToken($('mcp-token').value))
      return tr('ui.cela_ressemble_a_un_jeton_basculez');
    if (mode === 'bearer') return tr('ui.nom_de_variable_exemple_jeton_direct');
    return '';
  }
  function transport() {
    const http = $('mcp-type').value === 'http';
    const mode = $('mcp-auth').value;
    const showToken = http && (mode === 'bearer' || mode === 'token');
    $('mcp-http').hidden = !http;
    $('mcp-stdio').hidden = http;
    $('mcp-headers-row').hidden = !http;
    $('mcp-oauth-identity').hidden = !http || mode !== 'oauth';
    $('mcp-token-row').hidden = !showToken;
    const keptSecret =
      mode === 'token' && !!editing?.config.headers && Object.hasOwn(editing.config.headers, 'Authorization');
    $('mcp-token').required = showToken && !(mode === 'token' && keptSecret);
    // Mask pasted secrets. Variable names stay readable.
    $('mcp-token').type = mode === 'token' ? 'password' : 'text';
    $('mcp-token').autocomplete = mode === 'token' ? 'new-password' : 'off';
    bindText($('mcp-token-label'), () =>
      mode === 'token' ? tr('ui.jeton_secret') : tr('ui.variable_contenant_le_jeton'),
    );
    bindAttribute($('mcp-token'), 'placeholder', () =>
      mode === 'token' ? tr('example.tokenSecret') : tr('example.tokenVariable'),
    );
    bindText($('mcp-token-hint'), tokenHint);
    $('mcp-token-hint').hidden = !tokenHint();
    $('mcp-url').required = http;
    $('mcp-command').required = !http;
  }
  function edit(server) {
    editing = server;
    $('mcp-form').reset();
    const c = server?.config || {};
    $('mcp-name').value = server?.name || '';
    $('mcp-name').disabled = !!server;
    bindText($('mcp-form-title'), () =>
      server ? tr('common.editName', { value1: server.name }) : tr('ui.ajouter_un_mcp'),
    );
    $('mcp-type').value = c.type === 'stdio' ? 'stdio' : 'http';
    $('mcp-url').value = c.url || '';
    $('mcp-command').value = c.command || '';
    $('mcp-args').value = (c.args || []).join('\n');
    $('mcp-cwd').value = c.cwd || '';
    $('mcp-env').value = Object.entries(c.env || {})
      .map(([key, ref]) => `${key}=${ref.env}`)
      .join('\n');
    // A saved private Authorization header means Token mode. Its value is never
    // returned to the browser: an empty field keeps it, a new value replaces it.
    const hasPrivateAuth =
      !!c.headers && typeof c.headers === 'object' && Object.hasOwn(c.headers, 'Authorization');
    $('mcp-auth').value = c.oauth
      ? 'oauth'
      : c.bearerTokenEnvVar
        ? 'bearer'
        : hasPrivateAuth
          ? 'token'
          : 'none';
    editingTokenMode = $('mcp-auth').value === 'token';
    $('mcp-token').value = c.bearerTokenEnvVar || '';
    $('mcp-oauth-client-id').value = c.oauthClientId || '';
    $('mcp-oauth-client-secret-env').value = c.oauthClientSecretEnvVar || '';
    $('mcp-oauth-metadata-url').value = c.oauthClientMetadataUrl || '';
    $('mcp-oauth-scopes').value = (c.oauthScopes || []).join('\n');
    $('mcp-startup').value = c.startupTimeoutMs ?? 20000;
    $('mcp-timeout').value = c.callTimeoutMs ?? 60000;
    $('mcp-enabled-tools').value = (c.enabledTools || []).join('\n');
    $('mcp-tools-mode').value = Array.isArray(c.enabledTools) ? 'selected' : 'all';
    toolsMode();
    $('mcp-disabled-tools').value = (c.disabledTools || []).join('\n');
    $('mcp-headers').value = c.headers ? JSON.stringify(c.headers, null, 2) : '';
    $('mcp-private-url-note').hidden = !c.privateUrlParameters;
    error('', 'mcp-form-error');
    transport();
    view('form');
    $('mcp-name').disabled ? $('mcp-type').focus() : $('mcp-name').focus();
  }
  const lines = (id) =>
    $(id)
      .value.split(/\r?\n/)
      .filter((line) => line.trim());
  $('mcp-form').onsubmit = async (event) => {
    event.preventDefault();
    const button = $('mcp-save');
    button.disabled = true;
    error('', 'mcp-form-error');
    try {
      const config = {
        type: $('mcp-type').value,
        enabled: editing?.config.enabled !== false,
        startupTimeoutMs: Number($('mcp-startup').value),
        callTimeoutMs: Number($('mcp-timeout').value),
      };
      if ($('mcp-tools-mode').value === 'selected') config.enabledTools = lines('mcp-enabled-tools');
      if (lines('mcp-disabled-tools').length) config.disabledTools = lines('mcp-disabled-tools');
      if (config.type === 'http') {
        config.url = $('mcp-url').value.trim();
        const mode = $('mcp-auth').value;
        let headers;
        if ($('mcp-headers').value.trim()) {
          try {
            headers = JSON.parse($('mcp-headers').value);
          } catch {
            throw new Error(tr('ui.les_en_tetes_doivent_etre_un_objet_json_valide'));
          }
        }
        if (mode === 'oauth') {
          config.oauth = true;
          for (const [key, id] of [
            ['oauthClientId', 'mcp-oauth-client-id'],
            ['oauthClientSecretEnvVar', 'mcp-oauth-client-secret-env'],
            ['oauthClientMetadataUrl', 'mcp-oauth-metadata-url'],
          ]) {
            const value = $(id).value.trim();
            if (value) config[key] = value;
          }
          const scopes = lines('mcp-oauth-scopes').map((value) => value.trim());
          if (scopes.length) config.oauthScopes = scopes;
        }
        if (mode === 'bearer') {
          const name = $('mcp-token').value.trim();
          if (name && looksLikeToken(name)) throw new Error(tr('ui.cela_ressemble_a_un_jeton_basculez'));
          config.bearerTokenEnvVar = name;
        }
        if (mode === 'token') {
          // Direct secret, stored as a private Authorization header. The value
          // is never returned to the browser and never logged.
          const secret = $('mcp-token').value.trim();
          const kept = !!editing?.config.headers && Object.hasOwn(editing.config.headers, 'Authorization');
          if (!secret) {
            if (!kept) throw new Error(tr('ui.indiquez_le_jeton_secret'));
          } else {
            if (/\s/.test(secret) || secret.length > 4096)
              throw new Error(tr('ui.jeton_invalide_espaces_interdits'));
            if (headers && headers.Authorization != null && String(headers.Authorization).trim() !== '')
              throw new Error(tr('ui.retirez_authorization_des_en_tetes'));
          }
          headers = headers && typeof headers === 'object' ? headers : {};
          if (secret) headers.Authorization = 'Bearer ' + secret;
          else if (kept) headers.Authorization = null;
          else delete headers.Authorization;
        } else if (editingTokenMode && headers && headers.Authorization == null) {
          // Leaving Token mode: the null placeholder rendered by the form must
          // drop the old secret, not keep it behind the new auth mode. An
          // explicitly typed value stays user-managed.
          delete headers.Authorization;
        }
        if (headers && Object.keys(headers).length) config.headers = headers;
      } else {
        config.command = $('mcp-command').value.trim();
        config.args = lines('mcp-args');
        if ($('mcp-cwd').value.trim()) config.cwd = $('mcp-cwd').value.trim();
        config.env = Object.create(null);
        for (const line of lines('mcp-env')) {
          const index = line.indexOf('=');
          if (index < 1) throw new Error(tr('ui.chaque_variable_utilise_nom_enfant_nom_variable_du_pc'));
          const key = line.slice(0, index).trim();
          if (Object.hasOwn(config.env, key))
            throw new Error(tr('ui.une_variable_est_declaree_plusieurs_fois'));
          config.env[key] = { env: line.slice(index + 1).trim() };
        }
      }
      await api('/api/mcp', {
        method: 'POST',
        body: { name: $('mcp-name').value.trim(), revision: editing?.revision, config },
      });
      await load();
      view('list-view');
      toast(() => tr('ui.configuration_mcp_enregistree'));
    } catch (e) {
      error(translateKnown(e.message), 'mcp-form-error');
    } finally {
      button.disabled = false;
    }
  };
  async function test(server) {
    view('test-view');
    const current = ++generation;
    bindText($('mcp-test-title'), () => tr('mcp.testName', { value1: server.name }));
    bindText($('mcp-test-status'), () => tr('ui.connexion_et_decouverte_des_outils'));
    $('mcp-tools').replaceChildren();
    try {
      const result = await api('/api/mcp/test', {
        method: 'POST',
        body: { name: server.name, revision: server.revision },
      });
      if (current !== generation || !dialog.open) return;
      bindText($('mcp-test-status'), () => tr('count.toolsAvailable', { count: result.total }));
      for (const tool of result.tools || []) {
        const item = node('details', 'mcp-tool');
        item.append(
          node('summary', '', () => tool.name),
          node('p', '', () => translateKnown(tool.description) || tr('ui.aucune_description')),
          node('pre', '', () => JSON.stringify(tool.inputSchema, null, 2)),
        );
        $('mcp-tools').append(item);
      }
    } catch (e) {
      if (current === generation && dialog.open)
        bindText($('mcp-test-status'), () => translateKnown(e.message));
    }
  }
  async function cancelLogin() {
    generation++;
    clearTimeout(pollTimer);
    if (oauthJob) {
      const id = oauthJob.id;
      oauthJob = undefined;
      await api('/api/mcp/login/' + id, { method: 'DELETE' }).catch(() => {});
    }
  }
  async function login(server) {
    await cancelLogin();
    const current = generation;
    view('oauth-view');
    bindText($('mcp-oauth-title'), () => tr('mcp.connectName', { value1: server.label }));
    bindText($('mcp-oauth-status'), () => tr('ui.preparation_de_la_connexion'));
    $('mcp-oauth-link').hidden = true;
    $('mcp-oauth-form').hidden = false;
    $('mcp-oauth-form').reset();
    try {
      const job = await api('/api/mcp/login', {
        method: 'POST',
        body: { name: server.name, revision: server.revision },
      });
      if (current !== generation || !dialog.open) {
        await api('/api/mcp/login/' + job.id, { method: 'DELETE' }).catch(() => {});
        return;
      }
      oauthJob = job;
      await poll();
    } catch (e) {
      error(translateKnown(e.message));
    }
  }
  async function poll() {
    if (!oauthJob || !dialog.open) return;
    const id = oauthJob.id;
    try {
      const data = await api('/api/mcp/login/' + id);
      if (oauthJob?.id !== id) return;
      oauthJob = data;
      if (data.status === 'waiting') {
        bindText($('mcp-oauth-status'), () => tr('ui.autorisez_prime_agent_dans_le_navigateur'));
        $('mcp-oauth-link').href = data.url;
        $('mcp-oauth-link').hidden = false;
      }
      if (data.status === 'complete') {
        oauthJob = undefined;
        await load();
        view('list-view');
        toast(() => tr('ui.connexion_mcp_autorisee'));
        return;
      }
      if (['error', 'cancelled'].includes(data.status)) {
        oauthJob = undefined;
        $('mcp-oauth-link').hidden = true;
        // The job is dead. Hide the paste form so a late return URL cannot hit
        // a confusing mismatch error. Relaunch the connection to retry.
        $('mcp-oauth-form').hidden = true;
        error(() => translateKnown(data.error) || tr('ui.connexion_annulee'));
        bindText($('mcp-oauth-status'), () => tr('ui.la_connexion_n_a_pas_abouti'));
        return;
      }
      pollTimer = setTimeout(poll, 1000);
    } catch (e) {
      error(translateKnown(e.message));
    }
  }
  $('mcp-oauth-form').onsubmit = async (event) => {
    event.preventDefault();
    if (!oauthJob) return;
    try {
      await api('/api/mcp/login/complete', {
        method: 'POST',
        body: { id: oauthJob.id, url: $('mcp-oauth-return').value },
      });
      $('mcp-oauth-return').value = '';
      error('');
    } catch (e) {
      error(translateKnown(e.message));
    }
  };
  $('mcp-oauth-cancel').onclick = async () => {
    await cancelLogin();
    view('list-view');
  };
  $('mcp-remove-confirm').onclick = async () => {
    const button = $('mcp-remove-confirm');
    button.disabled = true;
    try {
      await api('/api/mcp', { method: 'DELETE', body: { name: removing.name, revision: removing.revision } });
      await load();
      view('list-view');
    } catch (e) {
      error(translateKnown(e.message));
    } finally {
      button.disabled = false;
    }
  };
  $('mcp-remove-cancel').onclick = $('mcp-back').onclick = () => view('list-view');
  $('mcp-test-back').onclick = () => {
    generation++;
    view('list-view');
  };
  $('mcp-add').onclick = () => edit();
  $('mcp-search').oninput = render;
  $('mcp-type').onchange = $('mcp-auth').onchange = transport;
  $('mcp-token').oninput = () => {
    bindText($('mcp-token-hint'), tokenHint);
    $('mcp-token-hint').hidden = !tokenHint();
  };
  function toolsMode() {
    const limited = $('mcp-tools-mode').value === 'selected';
    $('mcp-enabled-tools').hidden = !limited;
    $('mcp-tools-note').hidden = !limited;
  }
  $('mcp-tools-mode').onchange = toolsMode;
  $('mcp-close').onclick = () => dialog.close();
  dialog.onclose = () => {
    generation++;
    void cancelLogin();
    document.getElementById('open-settings').focus({ preventScroll: true });
  };
  document.getElementById('open-mcp-settings').onclick = async () => {
    document.getElementById('settings-dialog').close();
    dialog.showModal();
    view('list-view');
    bindText($('mcp-list'), () => tr('ui.chargement_des_connexions'));
    try {
      await load();
    } catch (e) {
      error(translateKnown(e.message));
    }
  };
}
