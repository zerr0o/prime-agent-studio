// Muse Code subscription provider gate (Studio wiring owned).
// Separate experimental OAuth-only provider id muse-code,
// distinct from the paid Meta Model API provider meta.
// No protocol, no credentials, no network calls in this module.

// The real OAuth adapter lives in lib/muse-oauth-provider.mjs (protocol
// worker owned) and is loaded only through loadMuseCodeConfig. When that
// module is missing or invalid, every caller must hide the provider: no
// stub registration, no API key form, no environment fallback.
import { existsSync, readFileSync } from 'node:fs';

export const MUSE_CODE_PROVIDER_ID = 'muse-code';
export const MUSE_CODE_GUIDANCE_KEY = 'providers.muse_code_guidance';
export const MUSE_CODE_ACK_KEY = 'providers.muse_code_ack';
export const MUSE_CODE_API = 'openai-responses';

// Only a stored OAuth credential counts. No environment variable, no
// fallback resolver, no paid meta key reuse for this id.
export const MUSE_CODE_REAL_AUTH_SOURCES = new Set(['stored']);

export function isMuseCodeId(id) {
  return id === MUSE_CODE_PROVIDER_ID;
}

export function stripMuseCodeJsonComments(input) {
  return String(input)
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ''))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, t) => t ?? m);
}

// True when models.json defines ANY providers muse-code entry. Missing file
// means no override. Unreadable or malformed content fails closed so the
// canonical definition can never clobber config we cannot see.
export function hasUserMuseCodeConfig(modelsJsonPath) {
  try {
    if (typeof modelsJsonPath !== 'string' || !modelsJsonPath) return false;
    if (!existsSync(modelsJsonPath)) return false;
    let raw;
    try {
      raw = readFileSync(modelsJsonPath, 'utf8');
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
      return true;
    }
    const parsed = JSON.parse(stripMuseCodeJsonComments(raw));
    return !!(
      parsed &&
      typeof parsed === 'object' &&
      parsed.providers &&
      parsed.providers[MUSE_CODE_PROVIDER_ID] !== undefined
    );
  } catch {
    return true;
  }
}

function cleanText(value, limit = 200) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
}

function cleanHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return '';
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
  return url.toString().replace(/\/$/, '');
}

function asModule(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const mod = candidate.default && typeof candidate.default === 'object' ? candidate.default : candidate;
  return mod && typeof mod === 'object' ? mod : null;
}

export function resolveMuseCodeAdapterId(candidate) {
  const mod = asModule(candidate);
  if (!mod) return '';
  const id = mod.MUSE_OAUTH_PROVIDER_ID ?? mod.MUSE_CODE_PROVIDER_ID;
  return typeof id === 'string' ? id : '';
}

export function resolveMuseCodeOAuth(candidate) {
  const mod = asModule(candidate);
  if (!mod) return null;
  return mod.museCodeOAuthAdapter ?? mod.MUSE_OAUTH_ADAPTER ?? mod.oauth ?? null;
}

export function resolveMuseCodeRawModels(candidate) {
  const mod = asModule(candidate);
  if (!mod) return null;
  if (Array.isArray(mod.MUSE_CODE_MODELS)) return mod.MUSE_CODE_MODELS;
  if (Array.isArray(mod.MODELS)) return mod.MODELS;
  if (typeof mod.museCodeModels === 'function') {
    try {
      const models = mod.museCodeModels();
      return Array.isArray(models) ? models : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function resolveMuseCodeBaseUrl(candidate) {
  const mod = asModule(candidate);
  if (!mod) return '';
  const raw = mod.MUSE_BASE_URL ?? mod.MUSE_CODE_BASE_URL;
  return typeof raw === 'string' ? raw : '';
}

function cleanMuseCodeModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
  const id = cleanText(model.id, 300);
  if (!id || /\s/.test(id)) return null;
  const name = cleanText(model.name, 200) || id;
  const reasoning = model.reasoning === true;
  const input = Array.isArray(model.input)
    ? [...new Set(['text', ...model.input])].filter((k) => ['text', 'image'].includes(k))
    : ['text'];
  const contextWindow =
    Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : 0;
  const maxTokens = Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : 0;
  if (!contextWindow || !maxTokens || maxTokens > contextWindow) return null;
  const cost = model.cost && typeof model.cost === 'object' ? model.cost : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const cleaned = {
    id,
    name,
    reasoning,
    input,
    cost: { input: num(cost.input), output: num(cost.output), cacheRead: num(cost.cacheRead), cacheWrite: num(cost.cacheWrite) },
    contextWindow,
    maxTokens,
  };
  if (model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object' && !Array.isArray(model.thinkingLevelMap)) {
    // Null disables a level natively (getSupportedThinkingLevels drops it).
    // off:null is REQUIRED: without it off stays supported and the Responses
    // streamer emits reasoning none, which Muse rejects with HTTP 400.
    const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    const mappedValues = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    const map = {};
    for (const [level, mapped] of Object.entries(model.thinkingLevelMap)) {
      if (!levels.has(level)) continue;
      if (mapped === null) map[level] = null;
      else if (typeof mapped === 'string' && mappedValues.has(mapped)) map[level] = mapped;
    }
    if (Object.keys(map).length) cleaned.thinkingLevelMap = map;
  }
  return cleaned;
}

// Strict shape check. True only for a usable real adapter. Never throws,
// never touches the network, never reads credentials.
export function validateMuseCodeAdapter(candidate) {
  const mod = asModule(candidate);
  if (!mod) return false;
  if (resolveMuseCodeAdapterId(mod) !== MUSE_CODE_PROVIDER_ID) return false;
  if (!cleanHttpsUrl(resolveMuseCodeBaseUrl(mod))) return false;
  const oauth = resolveMuseCodeOAuth(mod);
  if (!oauth || typeof oauth !== 'object') return false;
  if (typeof oauth.login !== 'function') return false;
  if (typeof oauth.refreshToken !== 'function') return false;
  if (typeof oauth.getApiKey !== 'function') return false;
  if (typeof oauth.name !== 'string' || !oauth.name.trim()) return false;
  const rawModels = resolveMuseCodeRawModels(mod);
  if (!Array.isArray(rawModels) || !rawModels.length || rawModels.length > 100) return false;
  return rawModels.every((model) => cleanMuseCodeModel(model) !== null);
}

// Resolve the static API version header from the adapter, defaulting to
// 1.0.0. The value is strict validated so it can never inject headers.
export function resolveMuseCodeApiVersion(candidate) {
  const mod = asModule(candidate);
  const raw = mod ? (mod.MUSE_API_VERSION ?? mod.MUSE_CODE_API_VERSION) : undefined;
  if (typeof raw === 'string' && /^[A-Za-z0-9._-]{1,20}$/.test(raw.trim())) return raw.trim();
  return '1.0.0';
}

// Compose the native ProviderConfig from a validated adapter. Returns null
// when invalid. Never includes apiKey: stored OAuth is the only credential
// source, so paid meta keys or env vars cannot leak in. Applies the static
// x-api-version header (the buildInferenceHeaders helper alone never reaches
// native inference requests). Costs are zeroed: subscription billing is per
// subscription, and picker per-token estimates must not imply paygo billing
// (the UI warning says so explicitly).
export function museCodeProviderConfigFromAdapter(candidate) {
  if (!validateMuseCodeAdapter(candidate)) return null;
  const mod = asModule(candidate);
  const oauth = resolveMuseCodeOAuth(mod);
  const baseUrl = cleanHttpsUrl(resolveMuseCodeBaseUrl(mod));
  const models = resolveMuseCodeRawModels(mod).map(cleanMuseCodeModel).filter(Boolean);
  if (!models.length) return null;
  const name = cleanText(oauth.name, 120) || 'Muse (subscription, experimental)';
  const config = {
    name,
    baseUrl,
    api: MUSE_CODE_API,
    headers: { 'x-api-version': resolveMuseCodeApiVersion(mod) },
    models: models.map((model) => ({
      ...model,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  };
  config.oauth = {
    name,
    login: oauth.login,
    refreshToken: oauth.refreshToken,
    getApiKey: oauth.getApiKey,
  };
  if (typeof oauth.modifyModels === 'function') config.oauth.modifyModels = oauth.modifyModels;
  return config;
}

// Load the protocol owned adapter through a caller supplied importer so each
// caller keeps its correct relative path. Resolves to { adapter, config } or
// null when the module is missing or invalid. Callers must skip registration,
// listing overlay and picker fallback on null: the provider stays invisible.
export async function loadMuseCodeConfig(importer) {
  try {
    if (typeof importer !== 'function') return null;
    const loaded = await importer();
    const adapter = asModule(loaded);
    const config = museCodeProviderConfigFromAdapter(adapter);
    if (!config) return null;
    return { adapter, config };
  } catch {
    return null;
  }
}

// Register the gated provider unless the user already defined muse-code.
// The flag is MANDATORY at every caller: model less overrides leave no trace
// in the registry. Returns true only when the gated definition was applied.
export function ensureMuseCodeProvider(registry, providerConfig, { hasUserConfig = false } = {}) {
  if (hasUserConfig === true) return false;
  if (!providerConfig || typeof providerConfig !== 'object') return false;
  const oauth = providerConfig.oauth;
  if (!oauth || typeof oauth.login !== 'function') return false;
  if (!registry || typeof registry.registerProvider !== 'function') return false;
  try {
    if (typeof registry.getAll === 'function') {
      const all = registry.getAll();
      if (Array.isArray(all) && all.some((m) => m && m.provider === MUSE_CODE_PROVIDER_ID)) return false;
    } else if (typeof registry.find === 'function') {
      const models = Array.isArray(providerConfig.models) ? providerConfig.models : [];
      for (const model of models) {
        if (model && model.id && registry.find(MUSE_CODE_PROVIDER_ID, model.id)) return false;
      }
      if (!models.length && registry.find(MUSE_CODE_PROVIDER_ID, 'x')) return false;
    }
  } catch {
    return false;
  }
  try {
    const rest = { ...providerConfig };
    const oauthConfig = { ...rest.oauth };
    delete rest.oauth;
    registry.registerProvider(MUSE_CODE_PROVIDER_ID, { ...rest, oauth: oauthConfig });
    return true;
  } catch {
    return false;
  }
}

// Typed stored credential check. Only a well formed OAuth credential counts:
// { type: 'oauth', access: <non empty string>, refresh: <non empty string> }.
// An api_key entry (or any malformed value) under this id must never read as
// configured. Never throws, never touches the network.
export function isMuseCodeStoredOAuth(stored) {
  return (
    !!stored &&
    typeof stored === 'object' &&
    stored.type === 'oauth' &&
    typeof stored.access === 'string' &&
    stored.access.length > 0 &&
    typeof stored.refresh === 'string' &&
    stored.refresh.length > 0
  );
}

// True only when the gated definition is active and no real stored OAuth
// credential backs it. No env or fallback source exists for this id, and a
// wrong-typed stored entry (for example api_key) still reads as placeholder.
export function isMuseCodePlaceholderStatus({ canonical, source, storedIsOAuth }) {
  return canonical === true && !(storedIsOAuth === true && source === 'stored');
}

// Picker prune helper: hide gated models until a stored OAuth credential
// exists. No environment variable can satisfy this id, and malformed or
// non-oauth stored entries stay hidden too.
export function shouldPruneMuseCodeModels({ museCanonical, source, storedIsOAuth }) {
  return museCanonical === true && !(storedIsOAuth === true && source === 'stored');
}

// True when a Muse subscription run must refuse to start: an engine
// fallback model is configured, and the native retry path would silently
// switch billing (any paid provider) or models on quota or outage. There is
// no per-run native override for the global backup, so Studio fails closed
// with a clear instruction instead: clear the engine fallback model before
// running Muse. Empty backup means native no-switch behavior and proceeds.
export function isBlockedMuseCodeBackup({ primaryProvider, backupRef }) {
  const primary = typeof primaryProvider === 'string' ? primaryProvider.trim() : '';
  if (primary !== MUSE_CODE_PROVIDER_ID) return false;
  const backup = typeof backupRef === 'string' ? backupRef.trim() : '';
  return backup !== '';
}


