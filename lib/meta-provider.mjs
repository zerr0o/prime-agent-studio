import { existsSync, readFileSync } from 'node:fs';

// Canonical Meta Model API provider definition for PrimeAgentGUI.
// Single source of truth shared by provider listing, model catalog,
// runtime extension and tests. Never reads credentials or user files.
//
// Protocol (verified 2026-09-21 from https://dev.meta.ai/docs/overview):
// Responses API over https://api.meta.ai/v1 with Bearer MODEL_API_KEY.
// Muse Spark always reasons: never send reasoning none or off (HTTP 400).
// thinkingLevelMap off:null keeps the adapter from emitting none and lets
// the model use its default effort when no explicit level is passed.

export const META_PROVIDER_ID = 'meta';
export const META_PROVIDER_NAME = 'Meta';
export const META_BASE_URL = 'https://api.meta.ai/v1';
export const META_CREDENTIAL_ENV = 'MODEL_API_KEY';
export const META_API = 'openai-responses';
export const META_CONTEXT_WINDOW = 1048576;
export const META_MAX_TOKENS = 131072;

export const META_MODEL_IDS = ['muse-spark-1.3', 'muse-spark-1.3-contributor'];

// Contributor tier permits training on prompts and completions.
// The display name must keep that warning visible wherever models are picked.
export const META_MODELS = [
  {
    id: 'muse-spark-1.3',
    name: 'Muse Spark 1.3',
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
    input: ['text', 'image'],
    cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
    contextWindow: META_CONTEXT_WINDOW,
    maxTokens: META_MAX_TOKENS,
  },
  {
    id: 'muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3 Contributor (training allowed)',
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
    },
    input: ['text', 'image'],
    cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
    contextWindow: META_CONTEXT_WINDOW,
    maxTokens: META_MAX_TOKENS,
  },
];

// Guidance text lives in public translations under providers.meta_guidance
// (Contributor training warning included). This module keeps no copy so UI
// wording stays single-sourced.

// Sources that prove a real credential, as opposed to the registration
// placeholder apiKey value which the native resolver would otherwise treat
// as a literal key.
export const META_REAL_AUTH_SOURCES = new Set(['stored', 'environment', 'runtime']);

export function metaProviderConfig() {
  return {
    name: META_PROVIDER_NAME,
    baseUrl: META_BASE_URL,
    apiKey: META_CREDENTIAL_ENV,
    api: META_API,
    models: META_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      thinkingLevelMap: { ...model.thinkingLevelMap },
      input: [...model.input],
      cost: { ...model.cost },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  };
}

// Minimal JSONC reader for override detection. The repo accepts comments and
// trailing commas in models.json, so a plain JSON.parse would miss a user
// meta entry or crash on comments. Local copy keeps this module free of UI
// imports for worker and extension use.
export function stripMetaJsonComments(input) {
  return String(input)
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ''))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? match);
}

// True when models.json defines ANY providers.meta entry (custom models,
// empty object, name only or baseUrl only). Missing file means no override.
// Unreadable or malformed content fails closed (treated as an override) so
// the canonical definition can never clobber config we cannot see.
export function hasUserMetaConfig(modelsJsonPath) {
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
    const parsed = JSON.parse(stripMetaJsonComments(raw));
    return !!(parsed && typeof parsed === 'object' && parsed.providers && parsed.providers.meta !== undefined);
  } catch {
    return true;
  }
}



// Register the canonical provider unless the user already defined meta.
// Detection is twofold: an explicit hasUserConfig flag (JSONC-aware read of
// models.json, covers custom ids, empty objects and baseUrl-only overrides)
// plus live registry checks for ANY meta model (covers prior registrations).
// The flag is MANDATORY at every caller: model-less overrides leave no trace
// in the registry, so a bare call cannot see them. Returns true only when the
// canonical definition was applied.
export function ensureMetaProvider(registry, { hasUserConfig = false } = {}) {
  if (hasUserConfig === true) return false;
  if (!registry || typeof registry.registerProvider !== 'function') return false;
  try {
    if (typeof registry.getAll === 'function') {
      const all = registry.getAll();
      if (Array.isArray(all) && all.some((model) => model && model.provider === META_PROVIDER_ID))
        return false;
    } else if (typeof registry.find === 'function') {
      for (const id of META_MODEL_IDS) {
        if (registry.find(META_PROVIDER_ID, id)) return false;
      }
    }
  } catch {
    return false;
  }
  try {
    registry.registerProvider(META_PROVIDER_ID, metaProviderConfig());
    return true;
  } catch {
    return false;
  }
}

// True only when the canonical definition is active and no real credential
// backs it. Caller keeps user overrides untouched by checking canonical first.
export function isMetaPlaceholderStatus({ canonical, source, stored, envSet }) {
  return (
    canonical === true &&
    stored !== true &&
    envSet !== true &&
    (source === 'models_json_key' || source === 'models_json_command' || source === 'fallback')
  );
}
