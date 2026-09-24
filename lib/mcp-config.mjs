import { formatMessage as tr } from '../public/i18n-core.js';
import { createHash } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { HttpError } from './store.mjs';
import { loadPrimeNative } from './prime-native.mjs';
import { looksLikePastedToken } from './mcp-oauth-errors.mjs';

const record = (v) => v && typeof v === 'object' && !Array.isArray(v);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
// Keep the native legacy panel boundary (Linear/Notion), not the full service
// catalog. The official 0.9.6 pi-ai MCP export preserves this contract.
export function builtinCatalog(loaded) {
  if (!Array.isArray(loaded?.BUILTIN_MCP_CATALOG))
    throw new HttpError(503, tr('server.la_gestion_mcp_necessite_une_version_compatible_de_prime_agent'));
  return loaded.BUILTIN_MCP_CATALOG;
}
// Mirror of the real 0.9.6 McpOAuthIdentity for user servers
// (service-catalog.d.ts): { clientId?, clientSecret?, clientMetadataUrl?,
// scopes?: string[] }. A configured oauthClientSecretEnvVar resolves to the
// env value or the explicit empty string when missing/empty; the engine
// fails closed on "" before any network request and never falls back to a
// stale stored secret. Secret VALUES are never persisted (name only in
// settings). ponytail: shared helper so both OAuth workers resolve identically.
export function mcpOAuthIdentity(config, env = process.env) {
  if (!config || config.type !== 'http') return {};
  const identity = {};
  const clientId = config.oauthClientId?.trim();
  if (clientId) identity.clientId = clientId.slice(0, 512);
  const secretEnvVar = config.oauthClientSecretEnvVar?.trim();
  if (secretEnvVar) identity.clientSecret = env?.[secretEnvVar]?.trim() ?? '';
  const metadataUrl = config.oauthClientMetadataUrl?.trim();
  if (metadataUrl) identity.clientMetadataUrl = metadataUrl;
  if (config.oauthScopes !== undefined && config.oauthScopes.length > 0) {
    identity.scopes = [...config.oauthScopes];
  }
  return identity;
}
// ONE shared OAuth provider builder for both workers (login + probe share
// it so identity can never drift between them; the engine pins identity on
// the stored grant and refuses mismatches at refresh).
export function buildMcpOAuthProvider(loaded, { name, label, url, builtin, config }) {
  const nativeIdentity =
    typeof loaded.resolveMcpOAuthIdentity === 'function' ? loaded.resolveMcpOAuthIdentity(config) : undefined;
  const identity = nativeIdentity ?? mcpOAuthIdentity(config);
  const reviewedScopes = Array.isArray(builtin?.oauth?.scopes)
    ? builtin.oauth.scopes
    : typeof builtin?.oauth?.scopes === 'string' && builtin.oauth.scopes
      ? [builtin.oauth.scopes]
      : undefined;
  if (typeof loaded.createConfiguredMcpProvider === 'function') {
    return loaded.createConfiguredMcpProvider({
      server: name,
      label,
      url,
      identity,
      reviewedScopes,
      clientRegistration: builtin?.oauth?.clientRegistration,
    });
  }
  // Legacy factory (pre-0.9.6) cannot honor secret/metadata identity: fail
  // closed instead of silently ignoring required client authentication. The
  // public flow (client id + scopes only) is preserved unchanged.
  if (identity?.clientSecret !== undefined || identity?.clientMetadataUrl !== undefined)
    throw new HttpError(
      400,
      'This server needs confidential OAuth client settings, which need Prime Agent 0.9.6 or newer.',
    );
  const identityScopes = Array.isArray(identity?.scopes)
    ? identity.scopes.join(' ')
    : typeof identity?.scopes === 'string'
      ? identity.scopes
      : undefined;
  return loaded.createMcpOAuthProvider({
    server: name,
    label,
    url,
    scopes: identityScopes ?? builtin?.oauth?.scopes,
    clientId: identity?.clientId ?? builtin?.oauth?.clientId,
  });
}
export const mcpRevision = (config) => createHash('sha256').update(JSON.stringify(config)).digest('hex');
const nameOf = (value) => {
  if (typeof value !== 'string' || !NAME.test(value) || forbidden.has(value))
    throw new HttpError(400, tr('server.nom_mcp_invalide_1_a_64_lettres_chiffres_tirets_ou_underscores'));
  return value;
};
function text(value, label, maximum = 4096) {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))
    throw new HttpError(400, `${label} invalide.`);
  return value;
}
function list(value, label) {
  if (!Array.isArray(value) || value.length > 256)
    throw new HttpError(400, `${label} : liste de textes attendue.`);
  return value.map((v) => text(v, label));
}
function publicConfig(config) {
  const result = {};
  for (const key of [
    'type',
    'enabled',
    'oauth',
    'enabledTools',
    'disabledTools',
    'startupTimeoutMs',
    'callTimeoutMs',
    'command',
    'args',
    'cwd',
    'url',
    'headers',
  ]) {
    if (record(config) && Object.hasOwn(config, key)) result[key] = structuredClone(config[key]);
  }
  if (typeof config?.bearerTokenEnvVar === 'string' && ENV.test(config.bearerTokenEnvVar))
    result.bearerTokenEnvVar = config.bearerTokenEnvVar;
  if (typeof config?.oauthClientId === 'string' && config.oauthClientId.length <= 512)
    result.oauthClientId = config.oauthClientId;
  if (typeof config?.oauthClientSecretEnvVar === 'string' && ENV.test(config.oauthClientSecretEnvVar))
    result.oauthClientSecretEnvVar = config.oauthClientSecretEnvVar;
  if (typeof config?.oauthClientMetadataUrl === 'string' && config.oauthClientMetadataUrl.length <= 2048)
    result.oauthClientMetadataUrl = config.oauthClientMetadataUrl;
  if (
    Array.isArray(config?.oauthScopes) &&
    config.oauthScopes.length <= 64 &&
    config.oauthScopes.every((s) => typeof s === 'string' && s.length <= 256)
  )
    result.oauthScopes = structuredClone(config.oauthScopes);
  if (record(config?.env))
    result.env = Object.fromEntries(
      Object.entries(config.env)
        .filter(([key, ref]) => ENV.test(key) && typeof ref?.env === 'string' && ENV.test(ref.env))
        .map(([key, ref]) => [key, { env: ref.env }]),
    );
  if (record(result.headers))
    result.headers = Object.fromEntries(Object.keys(result.headers).map((name) => [name, null]));
  else delete result.headers;
  for (const key of ['args', 'enabledTools', 'disabledTools'])
    if (
      result[key] !== undefined &&
      (!Array.isArray(result[key]) || result[key].some((value) => typeof value !== 'string'))
    )
      delete result[key];
  try {
    const url = new URL(result.url);
    url.username = '';
    url.password = '';
    url.hash = '';
    if (url.search) {
      result.privateUrlParameters = true;
      url.search = '';
    }
    result.url = url.toString();
  } catch {
    delete result.url;
  }
  return result;
}
function validateConfig(input, previous) {
  if (!record(input)) throw new HttpError(400, tr('server.configuration_mcp_invalide'));
  const common = ['type', 'enabled', 'enabledTools', 'disabledTools', 'startupTimeoutMs', 'callTimeoutMs'];
  const allowed =
    input.type === 'http'
      ? [
          ...common,
          'url',
          'headers',
          'bearerTokenEnvVar',
          'oauth',
          'oauthClientId',
          'oauthClientSecretEnvVar',
          'oauthClientMetadataUrl',
          'oauthScopes',
        ]
      : [...common, 'command', 'args', 'cwd', 'env'];
  if (Object.keys(input).some((k) => !allowed.includes(k)))
    throw new HttpError(400, tr('server.option_mcp_inconnue'));
  const config = { type: input.type };
  for (const flag of ['enabled', 'oauth'])
    if (input[flag] !== undefined) {
      if (typeof input[flag] !== 'boolean')
        throw new HttpError(400, tr('server.option_invalide', { value1: flag }));
      config[flag] = input[flag];
    }
  for (const key of ['enabledTools', 'disabledTools'])
    if (input[key] !== undefined) config[key] = list(input[key], key);
  for (const key of ['startupTimeoutMs', 'callTimeoutMs'])
    if (input[key] !== undefined) {
      if (!Number.isSafeInteger(input[key]) || input[key] < 1000 || input[key] > 300000)
        throw new HttpError(400, tr('server.les_delais_doivent_etre_compris_entre_1_000_et_300_000_ms'));
      config[key] = input[key];
    }
  if (input.type === 'http') {
    const raw = text(input.url, tr('server.adresse_http'));
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new HttpError(400, tr('server.adresse_http_s_invalide'));
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new HttpError(400, tr('server.utilisez_une_adresse_http_s_sans_identifiants_integres_ni_fragme'));
    if (input.oauth && url.protocol !== 'https:')
      throw new HttpError(400, tr('server.oauth_necessite_https'));
    config.url =
      previous?.url && publicConfig(previous).privateUrlParameters && raw === publicConfig(previous).url
        ? previous.url
        : url.toString();
    if (input.bearerTokenEnvVar !== undefined) {
      // Pasted secrets point to Token mode. Prefix and shape detection runs
      // first: a Supabase PAT (sbp_ plus hex) has a valid name shape but is
      // never a variable name.
      if (looksLikePastedToken(input.bearerTokenEnvVar))
        throw new HttpError(400, tr('server.cela_ressemble_a_un_jeton_utilisez_le_mode_jeton'));
      if (typeof input.bearerTokenEnvVar !== 'string' || !ENV.test(input.bearerTokenEnvVar))
        throw new HttpError(400, tr('server.indiquez_le_nom_de_la_variable_d_environnement_du_jeton'));
      if (input.oauth)
        throw new HttpError(400, tr('server.choisissez_oauth_ou_un_jeton_par_variable_pas_les_deux'));
      config.bearerTokenEnvVar = input.bearerTokenEnvVar;
    }
    if (input.oauthClientId !== undefined) {
      if (
        typeof input.oauthClientId !== 'string' ||
        !input.oauthClientId.trim() ||
        input.oauthClientId.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(input.oauthClientId)
      )
        throw new HttpError(400, tr('server.option_invalide', { value1: 'oauthClientId' }));
      config.oauthClientId = input.oauthClientId.trim();
    }
    if (input.oauthClientSecretEnvVar !== undefined) {
      if (looksLikePastedToken(input.oauthClientSecretEnvVar))
        throw new HttpError(400, tr('server.option_invalide', { value1: 'oauthClientSecretEnvVar' }));
      if (typeof input.oauthClientSecretEnvVar !== 'string' || !ENV.test(input.oauthClientSecretEnvVar))
        throw new HttpError(400, tr('server.option_invalide', { value1: 'oauthClientSecretEnvVar' }));
      config.oauthClientSecretEnvVar = input.oauthClientSecretEnvVar;
    }
    if (input.oauthClientMetadataUrl !== undefined) {
      if (typeof input.oauthClientMetadataUrl !== 'string' || input.oauthClientMetadataUrl.length > 2048)
        throw new HttpError(400, tr('server.option_invalide', { value1: 'oauthClientMetadataUrl' }));
      let metadataUrl;
      try {
        metadataUrl = new URL(text(input.oauthClientMetadataUrl, 'Client metadata URL'));
      } catch {
        throw new HttpError(400, tr('server.option_invalide', { value1: 'oauthClientMetadataUrl' }));
      }
      if (
        metadataUrl.protocol !== 'https:' ||
        metadataUrl.username ||
        metadataUrl.password ||
        metadataUrl.hash ||
        metadataUrl.pathname === '/' ||
        !metadataUrl.pathname
      )
        throw new HttpError(400, tr('server.option_invalide', { value1: 'oauthClientMetadataUrl' }));
      config.oauthClientMetadataUrl = metadataUrl.toString();
    }
    if (input.oauthScopes !== undefined) {
      // Array items are individual scope tokens: no control characters and no
      // whitespace inside a token (use separate entries for multiple scopes).
      if (
        !Array.isArray(input.oauthScopes) ||
        input.oauthScopes.length === 0 ||
        input.oauthScopes.length > 64 ||
        input.oauthScopes.some(
          (s) => typeof s !== 'string' || !s.trim() || s.length > 256 || /[\s\u0000-\u001f\u007f]/.test(s),
        )
      )
        throw new HttpError(400, tr('server.option_invalide', { value1: 'oauthScopes' }));
      config.oauthScopes = input.oauthScopes.map((s) => s.trim());
    }
    if (input.headers !== undefined) {
      if (!record(input.headers) || Object.keys(input.headers).length > 40)
        throw new HttpError(400, tr('server.en_tetes_http_invalides'));
      config.headers = Object.create(null);
      for (const [key, value] of Object.entries(input.headers)) {
        if (
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key) ||
          forbidden.has(key) ||
          ['host', 'connection', 'content-length'].includes(key.toLowerCase())
        )
          throw new HttpError(400, tr('server.nom_d_en_tete_http_invalide'));
        if (value === null && typeof previous?.headers?.[key] === 'string')
          config.headers[key] = previous.headers[key];
        else {
          config.headers[key] = text(value, tr('server.valeur_d_en_tete'));
          if (/[\r\n]/.test(value))
            throw new HttpError(400, tr('server.retour_a_la_ligne_interdit_dans_un_en_tete'));
        }
      }
      if (config.url !== previous?.url && Object.values(input.headers).includes(null))
        throw new HttpError(
          400,
          tr('server.pour_changer_d_adresse_retirez_ou_remplacez_les_en_tetes_prives_'),
        );
    }
  } else if (input.type === 'stdio') {
    config.command = text(input.command, 'Commande').trim();
    if (!config.command || /[\r\n]/.test(config.command))
      throw new HttpError(400, tr('server.indiquez_un_executable_avec_ses_arguments_dans_la_liste_separee'));
    config.args = list(input.args ?? [], 'Arguments');
    if (input.cwd) {
      if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd))
        throw new HttpError(400, tr('server.le_dossier_de_travail_doit_etre_un_chemin_absolu_sur_le_pc'));
      config.cwd = text(input.cwd, 'Dossier');
    }
    if (input.env !== undefined) {
      if (!record(input.env) || Object.keys(input.env).length > 100)
        throw new HttpError(400, tr('server.variables_d_environnement_invalides'));
      config.env = Object.create(null);
      for (const [key, ref] of Object.entries(input.env)) {
        if (
          !ENV.test(key) ||
          forbidden.has(key) ||
          !record(ref) ||
          Object.keys(ref).length !== 1 ||
          typeof ref.env !== 'string' ||
          !ENV.test(ref.env)
        )
          throw new HttpError(400, tr('server.utilisez_des_references_de_variables'));
        config.env[key] = { env: ref.env };
      }
    }
  } else throw new HttpError(400, tr('server.transport_mcp_non_pris_en_charge_choisissez_http_ou_stdio'));
  return config;
}

export function createMcpConfigStore({ agentHome, native = loadPrimeNative, env = process.env }) {
  const file = join(agentHome, 'settings.json');
  let writes = Promise.resolve();
  async function storage(create = false) {
    const loaded = await native();
    await mkdir(agentHome, { recursive: true, mode: 0o700 });
    const info = await lstat(file).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024))
      throw new HttpError(500, tr('server.settings_json_doit_etre_un_fichier_normal_de_moins_de_2_mo'));
    if (create && !info)
      await writeFile(file, '{}\n', { flag: 'wx', mode: 0o600 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
    return { loaded, storage: new loaded.FileSettingsStorage(agentHome, agentHome) };
  }
  function parse(raw) {
    try {
      const data = raw ? JSON.parse(raw) : {};
      if (!record(data) || (data.mcpServers !== undefined && !record(data.mcpServers))) throw new Error();
      return data;
    } catch {
      throw new HttpError(500, tr('server.settings_json_contient_une_configuration_invalide_le_fichier_est'));
    }
  }
  async function read() {
    const { loaded, storage: io } = await storage();
    let settings;
    io.withLock('global', (raw) => {
      settings = parse(raw);
    });
    return { loaded, settings };
  }
  async function get(name) {
    nameOf(name);
    const { loaded, settings } = await read();
    const builtin = builtinCatalog(loaded).find((item) => item.server === name);
    if (builtin && Object.hasOwn(settings.mcpServers || {}, name))
      throw new HttpError(400, tr('server.retirez_la_configuration_qui_masque_cette_integration_native'));
    const config =
      settings.mcpServers?.[name] || (builtin && { type: 'http', url: builtin.url, oauth: true });
    if (!config) throw new HttpError(404, tr('server.serveur_mcp_introuvable'));
    validateConfig(config, config);
    return { name, config, builtin, loaded };
  }
  async function listServers() {
    const { loaded, settings } = await read();
    const auth = loaded.AuthStorage.create(join(agentHome, 'auth.json'));
    const catalog = builtinCatalog(loaded);
    const entries = new Map(
      catalog.map((item) => [
        item.server,
        {
          name: item.server,
          label: item.label,
          builtin: true,
          config: { type: 'http', url: item.url, oauth: true },
        },
      ]),
    );
    for (const [name, config] of Object.entries(settings.mcpServers || {}))
      entries.set(name, {
        name,
        label: name,
        builtin: false,
        reserved: catalog.some((item) => item.server === name),
        config,
      });
    return {
      servers: [...entries.values()].map((item) => {
        const credential = auth.get(`mcp:${item.name}`),
          c = item.config || {};
        let invalid = false;
        try {
          nameOf(item.name);
          validateConfig(item.config, item.config);
        } catch {
          invalid = true;
        }
        const missingEnv = [
          ...new Set(
            [
              c.bearerTokenEnvVar,
              c.oauthClientSecretEnvVar,
              ...Object.values(c.env || {}).map((ref) => ref?.env),
            ].filter((name) => typeof name === 'string' && ENV.test(name) && !env[name]?.trim()),
          ),
        ];
        const connected = !!(
          credential?.type === 'oauth' &&
          credential.access &&
          credential.endpoint === c.url
        );
        return {
          ...item,
          config: publicConfig(c),
          revision: mcpRevision(item.config),
          authenticated: connected,
          missingEnv,
          status: item.reserved
            ? 'reserved'
            : invalid
              ? 'invalid'
              : c.enabled === false
                ? 'disabled'
                : missingEnv.length
                  ? 'missing-env'
                  : c.oauth && !connected
                    ? 'login-required'
                    : 'configured',
        };
      }),
    };
  }
  function mutate(body, operation) {
    const job = writes
      .catch(() => {})
      .then(async () => {
        const name = nameOf(body.name),
          { loaded, storage: io } = await storage(true);
        io.withLock('global', (raw) => {
          const settings = parse(raw),
            existing = settings.mcpServers?.[name];
          if (
            Object.hasOwn(settings.mcpServers || {}, name)
              ? body.revision !== mcpRevision(existing)
              : body.revision != null
          )
            throw new HttpError(
              409,
              tr('server.ce_serveur_a_ete_modifie_ailleurs_rechargez_la_liste_avant_de_re'),
            );
          const catalog = builtinCatalog(loaded);
          const next = operation({
            existing,
            name,
            loaded,
            reserved: catalog.some((item) => item.server === name),
          });
          settings.mcpServers = { ...settings.mcpServers };
          // A changed endpoint OR client identity invalidates the stored grant
          // (the engine pins identity on the credential and refuses mismatches).
          const identityFields = [
            'oauthClientId',
            'oauthClientSecretEnvVar',
            'oauthClientMetadataUrl',
            'oauthScopes',
          ];
          if (
            !catalog.some((item) => item.server === name) &&
            (!next ||
              (existing &&
                (existing.type !== next.type ||
                  existing.url !== next.url ||
                  existing.oauth !== next.oauth ||
                  identityFields.some(
                    (field) => JSON.stringify(existing[field]) !== JSON.stringify(next[field]),
                  ))))
          )
            loaded.AuthStorage.create(join(agentHome, 'auth.json')).removeVerified(`mcp:${name}`);
          if (next) settings.mcpServers[name] = next;
          else delete settings.mcpServers[name];
          return JSON.stringify(settings, null, 2) + '\n';
        });
        return listServers();
      });
    writes = job;
    return job;
  }
  const upsert = (body) =>
    mutate(body, ({ existing, reserved }) => {
      // Engine parity: only legacy built-ins own their name. Non-legacy
      // catalog services accept a shadowing user entry.
      if (reserved)
        throw new HttpError(
          400,
          tr('server.ce_nom_est_reserve_a_une_integration_native_choisissez_un_autre_'),
        );
      return validateConfig(body.config, existing);
    });
  const remove = (body) =>
    mutate(body, ({ existing }) => {
      if (existing === undefined) throw new HttpError(404, tr('server.serveur_mcp_introuvable'));
      return null;
    });
  const toggle = (body) =>
    mutate(body, ({ existing }) => {
      if (!existing || typeof body.enabled !== 'boolean')
        throw new HttpError(400, tr('server.activation_mcp_invalide'));
      return { ...existing, enabled: body.enabled };
    });
  async function disconnect({ name, revision }) {
    const { loaded, config } = await get(name);
    if (revision !== mcpRevision(config))
      throw new HttpError(409, tr('server.rechargez_la_liste_ce_serveur_a_change'));
    loaded.AuthStorage.create(join(agentHome, 'auth.json')).removeVerified(`mcp:${name}`);
    return listServers();
  }
  async function saveCredential(name, revision, credentials) {
    nameOf(name);
    const { loaded, storage: io } = await storage(true);
    io.withLock('global', (raw) => {
      const settings = parse(raw),
        builtin = builtinCatalog(loaded).find((item) => item.server === name);
      const config =
        settings.mcpServers?.[name] || (builtin && { type: 'http', url: builtin.url, oauth: true });
      if (!config || mcpRevision(config) !== revision || !config.oauth || credentials.endpoint !== config.url)
        throw new HttpError(409, tr('server.la_configuration_a_change_pendant_la_connexion'));
      const auth = loaded.AuthStorage.create(join(agentHome, 'auth.json'));
      auth.set(`mcp:${name}`, { ...credentials, type: 'oauth' });
      if (
        loaded.AuthStorage.create(join(agentHome, 'auth.json')).get(`mcp:${name}`)?.access !==
        credentials.access
      )
        throw new HttpError(500, tr('server.impossible_de_conserver_la_connexion_oauth'));
    });
  }
  return { list: listServers, get, upsert, remove, toggle, disconnect, saveCredential, agentHome };
}
