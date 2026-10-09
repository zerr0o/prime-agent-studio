import { formatMessage as tr } from '../public/i18n-core.js';
import { chmod, copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HttpError } from './store.mjs';
import { stripJsonComments } from './jsonc.mjs';

export const MODEL_APIS = [
  'openai-responses',
  'openai-completions',
  'anthropic-messages',
  'google-generative-ai',
];

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const MODEL_ID = /^[^\s\x00-\x1f\x7f]{1,300}$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const BUILTIN_PROVIDERS = new Set([
  'amazon-bedrock',
  'anthropic',
  'azure-openai-responses',
  'cerebras',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'deepseek',
  'fireworks',
  'github-copilot',
  'google',
  'google-vertex',
  'groq',
  'huggingface',
  'kimi-coding',
  'minimax',
  'minimax-cn',
  'mistral',
  'moonshotai',
  'moonshotai-cn',
  'openai',
  'openai-codex',
  'opencode',
  'opencode-go',
  'openrouter',
  'prime-inference',
  'vercel-ai-gateway',
  'xai',
  'xiaomi',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'zai',
]);
const MODEL_BODY_KEYS = new Set([
  'provider',
  'providerName',
  'id',
  'name',
  'api',
  'baseUrl',
  'credentialEnv',
  'reasoning',
  'input',
  'contextWindow',
  'maxTokens',
  'original',
]);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

function cleanProvider(value, label = tr('ui.fournisseur')) {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value.trim()) || FORBIDDEN_KEYS.has(value.trim()))
    throw new HttpError(400, `${label} invalide.`);
  return value.trim();
}

function cleanModelId(value, label = tr('ui.identifiant_du_modele')) {
  if (typeof value !== 'string' || !MODEL_ID.test(value.trim()))
    throw new HttpError(400, `${label} invalide.`);
  return value.trim();
}

function cleanName(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value))
    throw new HttpError(400, tr('server.nom_du_modele_invalide'));
  return value.trim();
}

function cleanProviderName(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/.test(value))
    throw new HttpError(400, tr('server.nom_du_fournisseur_invalide'));
  return value.trim();
}

function cleanApi(value) {
  if (!MODEL_APIS.includes(value)) throw new HttpError(400, tr('server.api_de_modele_non_prise_en_charge'));
  return value;
}

function cleanUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value))
    throw new HttpError(400, tr('server.adresse_api_invalide'));
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HttpError(400, tr('server.adresse_api_invalide'));
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new HttpError(400, tr('server.utilisez_une_adresse_http_s_sans_identifiants_parametres_ni_frag'));
  const hostname = url.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase(),
    loopback =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '::1' ||
      hostname.startsWith('127.');
  if (url.protocol === 'http:' && !loopback)
    throw new HttpError(400, 'HTTPS est requis, sauf pour un service local sur cet ordinateur.');
  return url.toString().replace(/\/$/, '');
}

function publicUrl(value) {
  try {
    return cleanUrl(value);
  } catch {
    return '';
  }
}

function cleanCredentialEnv(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || !ENV_NAME.test(value.trim()))
    throw new HttpError(400, tr('server.la_reference_de_cle_doit_etre_un_nom_de_variable_d_environnement'));
  return value.trim();
}

function positiveInteger(value, label, maximum = 16_777_216) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new HttpError(
      400,
      tr('server.doit_etre_un_entier_positif_inferieur_ou_egal_a', { value1: label, value2: maximum }),
    );
  return value;
}

function cleanInput(value) {
  if (!Array.isArray(value) || !value.length || value.some((type) => !['text', 'image'].includes(type)))
    throw new HttpError(400, tr('server.types_d_entree_invalides'));
  return [...new Set(['text', ...value])].filter((type) => ['text', 'image'].includes(type));
}

function cleanIdentity(value, prefix = '') {
  if (!record(value) || Object.keys(value).some((key) => !['provider', 'id'].includes(key)))
    throw new HttpError(400, `${prefix || tr('server.identite')} invalide.`);
  return {
    provider: cleanProvider(value.provider, `${prefix} fournisseur`.trim()),
    id: cleanModelId(value.id, `${prefix} identifiant`.trim()),
  };
}

function validateModelBody(body) {
  if (!record(body) || Object.keys(body).some((key) => !MODEL_BODY_KEYS.has(key)))
    throw new HttpError(400, tr('server.configuration_de_modele_invalide'));
  const provider = cleanProvider(body.provider),
    id = cleanModelId(body.id),
    contextWindow = positiveInteger(body.contextWindow, tr('server.la_fenetre_de_contexte')),
    maxTokens = positiveInteger(body.maxTokens, tr('server.la_sortie_maximale'));
  if (maxTokens > contextWindow)
    throw new HttpError(400, tr('server.la_sortie_maximale_ne_peut_pas_depasser_la_fenetre_de_contexte'));
  if (typeof body.reasoning !== 'boolean')
    throw new HttpError(400, tr('server.option_de_raisonnement_invalide'));
  return {
    provider,
    id,
    name: cleanName(body.name, id),
    providerName: cleanProviderName(body.providerName, provider),
    api: cleanApi(body.api),
    baseUrl: cleanUrl(body.baseUrl),
    credentialEnv: cleanCredentialEnv(body.credentialEnv),
    reasoning: body.reasoning,
    input: cleanInput(body.input),
    contextWindow,
    maxTokens,
    ...(body.original == null
      ? {}
      : { original: cleanIdentity(body.original, tr('server.modele_original')) }),
  };
}

function validateConfigShape(config) {
  if (!record(config) || !record(config.providers))
    throw new HttpError(500, tr('server.le_fichier_models_json_ne_contient_pas_une_configuration_valide'));
  for (const [provider, value] of Object.entries(config.providers)) {
    if (!record(value))
      throw new HttpError(
        500,
        tr('server.la_configuration_du_fournisseur_est_invalide', { value1: provider }),
      );
    if (value.models !== undefined && !Array.isArray(value.models))
      throw new HttpError(
        500,
        tr('server.la_liste_de_modeles_du_fournisseur_est_invalide', { value1: provider }),
      );
    for (const model of value.models || [])
      if (!record(model) || typeof model.id !== 'string' || !model.id)
        throw new HttpError(500, tr('server.un_modele_du_fournisseur_est_invalide', { value1: provider }));
  }
  return config;
}

function enforceCredentialEndpoint(config, value, source, sourceProvider, authProviders) {
  const targetProvider = config.providers[value.provider];
  if (!targetProvider) {
    if (BUILTIN_PROVIDERS.has(value.provider) || authProviders.has(value.provider))
      throw new HttpError(400, tr('server.ce_fournisseur_integre_ou_deja_authentifie_ne_peut_etre_ajoute_q'));
    return;
  }
  const hasCredential =
    BUILTIN_PROVIDERS.has(value.provider) ||
    authProviders.has(value.provider) ||
    !!targetProvider.apiKey ||
    !!targetProvider.headers ||
    !!source?.headers;
  if (!hasCredential) return;
  const sameProvider = value.original?.provider === value.provider,
    previousUrl = sameProvider ? (source?.baseUrl ?? sourceProvider?.baseUrl) : targetProvider.baseUrl,
    expected = publicUrl(previousUrl);
  if (!expected || expected !== value.baseUrl)
    throw new HttpError(400, tr('server.l_adresse_d_un_fournisseur_identifie_ne_peut_pas_etre_changee_ic'));
}

function cleanEmptyProvider(config, provider) {
  const value = config.providers[provider];
  if (!value || value.models?.length) return;
  if (!value.baseUrl && !value.headers && !value.compat && !value.modelOverrides)
    delete config.providers[provider];
}

function safeModel(provider, providerConfig, model) {
  const baseUrl = model.baseUrl ?? providerConfig.baseUrl,
    api = model.api ?? providerConfig.api,
    credential = providerConfig.apiKey,
    credentialEnv = typeof credential === 'string' && ENV_NAME.test(credential) ? credential : '';
  return {
    provider,
    id: String(model.id),
    name: typeof model.name === 'string' ? model.name : String(model.id),
    providerName: typeof providerConfig.name === 'string' ? providerConfig.name : provider,
    api: MODEL_APIS.includes(api) ? api : '',
    baseUrl: publicUrl(baseUrl),
    endpointConfigured: typeof baseUrl === 'string' && !!baseUrl,
    credentialEnv,
    credentialConfigured: typeof credential === 'string' && !!credential,
    reasoning: model.reasoning === true,
    input: Array.isArray(model.input) && model.input.includes('image') ? ['text', 'image'] : ['text'],
    contextWindow: Number.isSafeInteger(model.contextWindow) ? model.contextWindow : 128000,
    maxTokens: Number.isSafeInteger(model.maxTokens) ? model.maxTokens : 16384,
    advanced: !!(model.compat || model.headers || model.thinkingLevelMap),
    editable: !!publicUrl(baseUrl) && MODEL_APIS.includes(api),
  };
}

export function createModelConfigStore({ agentHome, env = process.env } = {}) {
  if (!agentHome) throw new TypeError('agentHome est requis.');
  const file = join(agentHome, 'models.json'),
    backupFile = join(agentHome, 'models.json.prime-studio.bak');
  let writes = Promise.resolve();

  async function readConfig() {
    let contents;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES)
        throw new HttpError(
          500,
          tr('server.le_fichier_models_json_est_absent_inaccessible_ou_trop_volumineu'),
        );
      contents = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { providers: {} };
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, tr('server.impossible_de_lire_le_fichier_models_json'));
    }
    try {
      return validateConfigShape(JSON.parse(stripJsonComments(contents)));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, tr('server.le_fichier_models_json_contient_un_json_invalide_corrigez_le_ava'));
    }
  }

  async function authenticationProviders() {
    const providers = new Set();
    try {
      const authFile = join(agentHome, 'auth.json'),
        info = await lstat(authFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) return providers;
      const auth = JSON.parse(await readFile(authFile, 'utf8'));
      if (record(auth)) for (const provider of Object.keys(auth)) providers.add(provider);
    } catch {}
    return providers;
  }

  async function saveConfig(config) {
    validateConfigShape(config);
    await mkdir(agentHome, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const existing = await lstat(file).catch(() => null);
      if (existing && (!existing.isFile() || existing.isSymbolicLink()))
        throw new HttpError(500, tr('server.le_fichier_models_json_doit_etre_un_fichier_normal'));
      if (existing) {
        const backup = await lstat(backupFile).catch(() => null);
        if (backup && (!backup.isFile() || backup.isSymbolicLink()))
          throw new HttpError(500, tr('server.la_sauvegarde_models_json_doit_etre_un_fichier_normal'));
        await copyFile(file, backupFile);
        await chmod(backupFile, 0o600).catch(() => {});
      }
      await writeFile(temp, JSON.stringify(config, null, 2) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temp, file);
      await chmod(file, 0o600).catch(() => {});
    } catch (error) {
      await unlink(temp).catch(() => {});
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, tr('server.impossible_d_enregistrer_models_json_la_configuration_precedente'));
    }
  }

  function mutate(operation) {
    const job = writes
      .catch(() => {})
      .then(async () => {
        const config = await readConfig(),
          result = await operation(config);
        await saveConfig(config);
        return result;
      });
    writes = job;
    return job;
  }

  async function list() {
    await writes.catch(() => {});
    const config = await readConfig(),
      authProviders = await authenticationProviders(),
      models = [];
    for (const [provider, providerConfig] of Object.entries(config.providers))
      for (const model of providerConfig.models || []) {
        const item = safeModel(provider, providerConfig, model),
          environmentCredential = item.credentialEnv && !!env[item.credentialEnv],
          literalCredential = item.credentialConfigured && !item.credentialEnv;
        item.authenticationAvailable =
          authProviders.has(provider) || environmentCredential || literalCredential;
        models.push(item);
      }
    models.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    return {
      models,
      apis: MODEL_APIS.map((id) => ({
        id,
        name:
          id === 'openai-responses'
            ? 'OpenAI Responses'
            : id === 'openai-completions'
              ? 'OpenAI Chat Completions'
              : id === 'anthropic-messages'
                ? 'Anthropic Messages'
                : 'Google Generative AI',
      })),
    };
  }

  async function upsert(body) {
    const value = validateModelBody(body),
      authProviders = await authenticationProviders();
    await mutate((config) => {
      let source,
        sourceProvider,
        sourceIndex = -1;
      if (value.original) {
        sourceProvider = config.providers[value.original.provider];
        sourceIndex = sourceProvider?.models?.findIndex((model) => model.id === value.original.id) ?? -1;
        if (sourceIndex < 0) throw new HttpError(404, tr('server.le_modele_a_modifier_est_introuvable'));
        source = sourceProvider.models[sourceIndex];
        const changesIdentity = value.original.provider !== value.provider || value.original.id !== value.id;
        if (
          changesIdentity &&
          config.providers[value.provider]?.models?.some((model) => model.id === value.id)
        )
          throw new HttpError(409, tr('server.un_modele_utilise_deja_cet_identifiant_pour_ce_fournisseur'));
      } else if (config.providers[value.provider]?.models?.some((model) => model.id === value.id)) {
        throw new HttpError(409, tr('server.ce_modele_est_deja_configure_utilisez_modifier'));
      }
      enforceCredentialEndpoint(config, value, source, sourceProvider, authProviders);
      if (!source && Object.keys(config.providers).length >= 64 && !config.providers[value.provider])
        throw new HttpError(400, tr('server.la_limite_de_64_fournisseurs_est_atteinte'));
      if (!source && (config.providers[value.provider]?.models?.length || 0) >= 128)
        throw new HttpError(400, tr('server.la_limite_de_128_modeles_pour_ce_fournisseur_est_atteinte'));
      if (
        !source &&
        Object.values(config.providers).reduce(
          (count, provider) => count + (provider.models?.length || 0),
          0,
        ) >= 512
      )
        throw new HttpError(400, tr('server.la_limite_totale_de_512_modeles_personnalises_est_atteinte'));
      if (source) {
        sourceProvider.models.splice(sourceIndex, 1);
        if (value.original.provider !== value.provider) cleanEmptyProvider(config, value.original.provider);
      }
      let providerConfig = config.providers[value.provider];
      if (!providerConfig) {
        if (!value.credentialEnv)
          throw new HttpError(
            400,
            tr('server.indiquez_la_variable_d_environnement_contenant_la_cle_du_fournis'),
          );
        providerConfig = {
          name: value.providerName,
          baseUrl: value.baseUrl,
          api: value.api,
          apiKey: value.credentialEnv,
          models: [],
        };
        config.providers[value.provider] = providerConfig;
      }
      providerConfig.models = Array.isArray(providerConfig.models) ? providerConfig.models : [];
      if (value.credentialEnv) providerConfig.apiKey = value.credentialEnv;
      const model = {
        ...(source || {}),
        id: value.id,
        name: value.name,
        api: value.api,
        baseUrl: value.baseUrl,
        reasoning: value.reasoning,
        input: value.input,
        contextWindow: value.contextWindow,
        maxTokens: value.maxTokens,
        cost: source?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      if (!value.reasoning) delete model.thinkingLevelMap;
      providerConfig.models.push(model);
    });
    return list();
  }

  async function remove(body) {
    const identity = cleanIdentity(body);
    await mutate((config) => {
      const providerConfig = config.providers[identity.provider],
        index = providerConfig?.models?.findIndex((model) => model.id === identity.id) ?? -1;
      if (index < 0) throw new HttpError(404, tr('server.modele_personnalise_introuvable'));
      providerConfig.models.splice(index, 1);
      cleanEmptyProvider(config, identity.provider);
    });
    return list();
  }

  return { file, backupFile, list, upsert, remove };
}
