import { formatMessage as tr } from '../public/i18n-core.js';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverCli } from './agent.mjs';
import { HttpError } from './store.mjs';
import { META_PROVIDER_ID, ensureMetaProvider, hasUserMetaConfig, isMetaPlaceholderStatus } from './meta-provider.mjs';
import { fetchCodexUsage, parseCodexUsageBody, toPublicSnapshot } from './codex-usage.mjs';

const clean = (value, limit = 160) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
export const credentialRevision = (value) =>
  createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');
export function providerId(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value) ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  )
    throw new HttpError(400, tr('server.fournisseur_invalide'));
  return value;
}
// NOTE: the prime-inference guidance text is owned by public/translations.js.
// With Prime Agent 0.9.5 only PRIME_API_KEY (env) then auth.json apply in ordinary
// resolution; the CLI sentence is stale and should be reworded by the settings owner.
const guidance = {
  'prime-inference': tr('server.la_variable_prime_api_key_et_la_configuration_prime_cli_sont_pri'),
  'amazon-bedrock': tr('server.utilisez_un_profil_aws_ou_les_variables_aws_du_pc_ces_reglages_r'),
  'google-vertex': tr('server.configurez_les_identifiants_google_cloud_le_projet_et_la_region_'),
  'azure-openai-responses': tr('server.la_cle_peut_etre_enregistree_ici_l_adresse_azure_et_les_deploiem'),
  'cloudflare-ai-gateway': tr('server.la_cle_peut_etre_enregistree_ici_le_compte_et_la_passerelle_clou'),
  'cloudflare-workers-ai': tr('server.la_cle_peut_etre_enregistree_ici_le_compte_cloudflare_se_regle_d'),
  // Meta Model API guidance (translations key, Contributor warning included).
  [META_PROVIDER_ID]: tr('providers.meta_guidance'),
};
export async function createProviderAuth({ agentHome, native } = {}) {
  for (const name of ['auth.json', 'models.json']) {
    const info = await lstat(join(agentHome, name)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024))
      throw new HttpError(409, tr('server.le_fichier_de_configuration_doit_etre_un_fichier_local_de_taille'));
  }
  if (!native) {
    const cli = discoverCli();
    if (!cli?.packageDir)
      throw new HttpError(503, tr('server.installez_prime_agent_pour_gerer_les_fournisseurs'));
    const importNative = (path) => import(pathToFileURL(join(cli.packageDir, path)).href);
    const [auth, models] = await Promise.all([
      importNative('dist/core/auth-storage.js'),
      importNative('dist/core/model-registry.js'),
    ]);
    native = { ...auth, ...models };
  }
  const backend = new native.FileAuthStorageBackend(join(agentHome, 'auth.json'));
  backend.withLock((current) => {
    const content = JSON.parse(current || '{}');
    if (!content || Array.isArray(content) || typeof content !== 'object')
      throw new HttpError(409, tr('server.le_fichier_auth_json_est_invalide_les_connexions_existantes_ont_'));
    return { result: undefined };
  });
  const auth = native.AuthStorage.fromStorage(backend);
  if (auth.drainErrors().length)
    throw new HttpError(409, tr('server.impossible_de_lire_les_connexions_existantes_corrigez_auth_json_'));
  const registry = native.ModelRegistry.create(auth, join(agentHome, 'models.json'));
  // Canonical Meta provider overlay: appear in manage connections without any
  // manual custom setup. Credentials stay in native auth storage (auth.json or
  // MODEL_API_KEY env). ANY user models.json meta entry (custom models, empty
  // object, name or baseUrl only, JSONC comments included) wins; malformed
  // content fails closed and also skips the canonical registration.
  let metaCanonical = false;
  try {
    metaCanonical = ensureMetaProvider(registry, {
      hasUserConfig: hasUserMetaConfig(join(agentHome, 'models.json')),
    });
  } catch {
    metaCanonical = false;
  }
  // OAuth flows follow the native registry (Prime Agent 0.9.5 adds xAI/Grok as `xai`);
  // Studio keeps no frozen OAuth list. The same `xai` id supports both subscription
  // (OAuth) and API-key credentials natively.
  const oauth = new Map(
    auth
      .getOAuthProviders()
      .filter((p) => !p.id.startsWith('mcp:'))
      .map((p) => [p.id, p]),
  );
  const counts = new Map();
  for (const model of registry.getAll()) counts.set(model.provider, (counts.get(model.provider) || 0) + 1);
  const ids = new Set([
    ...counts.keys(),
    ...oauth.keys(),
    ...auth.list().filter((id) => !id.startsWith('mcp:') && id !== 'serper' && id !== 'prime-agent-traces'),
  ]);
  function item(id) {
    providerId(id);
    if (!ids.has(id))
      throw new HttpError(404, tr('server.fournisseur_inconnu_ajoutez_d_abord_ses_modeles_dans_le_configur'));
    const status = registry.getProviderAuthStatus(id),
      stored = auth.get(id);
    const methods = [];
    if (oauth.has(id)) methods.push('oauth');
    // Only subscription-only or externally-configured providers hide the API-key
    // form. Every other registry entry (including xAI/Grok `xai`) keeps it, so an
    // existing API key stays usable without opening a real external login.
    if (!['amazon-bedrock', 'google-vertex', 'openai-codex', 'github-copilot'].includes(id))
      methods.push('api_key');
    // The canonical Meta registration carries apiKey MODEL_API_KEY as a native
    // placeholder. Without a stored key or env value that placeholder source
    // must not read as configured.
    const placeholder =
      id === META_PROVIDER_ID &&
      isMetaPlaceholderStatus({
        canonical: metaCanonical,
        source: status.source,
        stored: !!stored,
        envSet: !!process.env.MODEL_API_KEY,
      });
    return {
      id,
      name: clean(oauth.get(id)?.name || registry.getProviderDisplayName(id) || id),
      methods,
      configured: placeholder ? false : !!status.source && status.source !== 'stale',
      // `prime_cli` is kept for older engines only. Prime Agent 0.9.5 ordinary
      // resolution is Prime env then auth.json; the CLI config is reused only
      // during an explicit upstream login and never appears here otherwise.
      source: [
        'stored',
        'environment',
        'prime_cli',
        'models_json_key',
        'models_json_command',
        'stale',
        'fallback',
        'runtime',
      ].includes(status.source)
        ? status.source
        : null,
      stored: !!stored,
      credentialType: stored?.type === 'oauth' ? 'oauth' : stored ? 'api_key' : null,
      revision: credentialRevision(stored),
      models: counts.get(id) || 0,
      guidance: guidance[id] || '',
    };
  }
  function selected(body) {
    const entry = item(body.provider);
    if (body.revision !== entry.revision)
      throw new HttpError(409, tr('server.cette_connexion_a_change_actualisez_la_liste_avant_de_reessayer'));
    return entry;
  }
  function persist(body, credential) {
    selected(body);
    // Apply the revision check inside Prime Agent's own file lock. Another
    // provider or MCP may change concurrently; its credentials are preserved.
    const guarded = {
      withLock: (fn) =>
        backend.withLock((current) => {
          const result = fn(current);
          if (
            result.next !== undefined &&
            credentialRevision(JSON.parse(current || '{}')[body.provider]) !== body.revision
          )
            throw new HttpError(
              409,
              tr('server.cette_connexion_a_change_actualisez_la_liste_avant_de_reessayer'),
            );
          return result;
        }),
      withLockAsync: (fn) => backend.withLockAsync(fn),
    };
    // Never import Prime CLI credentials silently: ordinary writes stay Agent-owned.
    const writer = native.AuthStorage.fromStorage(guarded, { usePrimeCliConfig: false });
    if (writer.drainErrors().length)
      throw new HttpError(409, tr('server.impossible_de_lire_les_connexions_existantes'));
    if (credential) writer.set(body.provider, credential);
    else writer.removeVerified(body.provider);
    const errors = writer.drainErrors();
    if (errors.length)
      throw (
        errors.find((error) => error.status) ||
        new HttpError(500, tr('server.la_connexion_n_a_pas_pu_etre_enregistree'))
      );
    auth.reload();
    return { provider: body.provider, saved: true };
  }
  return {
    entry: selected,
    list: () => ({
      providers: [...ids]
        .filter(
          (id) =>
            /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id) &&
            !['constructor', 'prototype', '__proto__'].includes(id),
        )
        .map(item)
        .sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name)),
      warning: registry.getError()
        ? tr('server.certaines_definitions_de_modeles_ne_peuvent_pas_etre_chargees_ve')
        : null,
    }),
    async save(body) {
      const entry = selected(body);
      if (!entry.methods.includes('api_key'))
        throw new HttpError(400, tr('server.ce_fournisseur_utilise_un_autre_mode_de_connexion'));
      const value = typeof body.value === 'string' ? body.value.trim() : '';
      if (!value || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value) || value.startsWith('!'))
        throw new HttpError(400, tr('server.saisissez_une_cle_valide_sans_espaces_ni_commande'));
      if (!['key', 'environment'].includes(body.kind))
        throw new HttpError(400, tr('server.mode_de_cle_invalide'));
      if (body.kind === 'environment' && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(value))
        throw new HttpError(400, tr('server.nom_de_variable_invalide'));
      if (body.kind === 'environment' && !process.env[value])
        throw new HttpError(
          400,
          tr('server.cette_variable_est_absente_ou_vide_dans_l_environnement_du_studi'),
        );
      if (body.kind === 'key' && process.env[value] !== undefined)
        throw new HttpError(
          400,
          tr('server.cette_valeur_correspond_a_une_variable_du_pc_choisissez_le_mode_'),
        );
      return persist(body, { type: 'api_key', key: value });
    },
    remove(body) {
      if (!selected(body).stored)
        throw new HttpError(400, tr('server.cette_connexion_est_geree_en_dehors_du_studio'));
      return persist(body, null);
    },
    async login(body, callbacks, beforeSave = async () => {}) {
      const entry = selected(body),
        provider = oauth.get(entry.id);
      if (!provider)
        throw new HttpError(
          400,
          tr('server.la_connexion_par_compte_n_est_pas_disponible_pour_ce_fournisseur'),
        );
      const credentials = await provider.login(callbacks);
      await beforeSave(entry);
      return persist(body, { ...credentials, type: 'oauth' });
    },
    codexLink() {
      // Minimal safe linkage metadata for mobile/remote quota.
      // No secrets, no full provider list. Only linked flag + revision hash.
      let entry = null;
      try {
        entry = item('openai-codex');
      } catch {
        return { provider: 'openai-codex', linked: false, revision: credentialRevision(null) };
      }
      const linked = entry.credentialType === 'oauth' && entry.stored === true;
      return { provider: 'openai-codex', linked, revision: entry.revision };
    },
    async codexUsage(body) {
      if (!body || body.provider !== 'openai-codex') throw new HttpError(400, tr('server.fournisseur_invalide'));
      const entry = selected(body);
      const fetchedAt = Date.now();
      // Read-only: no network unless a stored OAuth credential exists.
      // API-key-only and unlinked states stay local and neutral.
      if (entry.id !== 'openai-codex' || entry.credentialType !== 'oauth' || !entry.stored)
        return { available: false, reason: 'unlinked', provider: 'openai-codex', fetchedAt, cached: false };
      const stored = auth.get('openai-codex');
      if (!stored || stored.type !== 'oauth')
        return { available: false, reason: 'unlinked', provider: 'openai-codex', fetchedAt, cached: false };
      let access;
      try {
        // Native refresh with file locking when the OAuth token is expired.
        access = await auth.getApiKey('openai-codex');
      } catch {
        return { available: false, reason: 'unavailable', provider: 'openai-codex', fetchedAt, cached: false };
      }
      if (typeof access !== 'string' || !access)
        return { available: false, reason: 'unavailable', provider: 'openai-codex', fetchedAt, cached: false };
      const current = auth.get('openai-codex');
      const accountId =
        current && typeof current.accountId === 'string' && current.accountId ? current.accountId : stored.accountId;
      let raw;
      try {
        raw = await fetchCodexUsage({ accessToken: access, accountId });
      } catch (error) {
        if (error?.status === 401 || error?.status === 403)
          return { available: false, reason: 'auth', provider: 'openai-codex', fetchedAt, cached: false };
        return { available: false, reason: 'unavailable', provider: 'openai-codex', fetchedAt, cached: false };
      }
      const parsed = parseCodexUsageBody(raw, fetchedAt);
      if (!parsed)
        return { available: false, reason: 'unavailable', provider: 'openai-codex', fetchedAt, cached: false };
      return toPublicSnapshot(parsed, { fetchedAt, cached: false });
    },
  };
}
