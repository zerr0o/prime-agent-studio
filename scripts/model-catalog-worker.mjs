// Native provider registries are process-global; this persistent worker owns its own copy.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  META_PROVIDER_ID,
  META_REAL_AUTH_SOURCES,
  ensureMetaProvider,
  hasUserMetaConfig,
} from '../lib/meta-provider.mjs';

const REFRESH_TTL = 5 * 60_000;
const OBSERVATION_WINDOW = 12_000;
const POLL_INTERVAL = 250;
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const text = (value, limit = 400) => (typeof value === 'string' ? value.slice(0, limit) : '');
const number = (value) => (Number.isFinite(value) && value >= 0 ? value : undefined);
let native;
let thinkingLevels;
let auth;
let modelsPath;
let configPaths;
let state;
let initializing;
let requests = Promise.resolve();

async function initialize({ packageDir, agentHome }) {
  native = await import(pathToFileURL(join(packageDir, 'dist', 'index.js')).href);
  const ai = await import(
    pathToFileURL(join(packageDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'models.js')).href
  );
  if (
    typeof native.AuthStorage?.create !== 'function' ||
    typeof native.ModelRegistry?.create !== 'function' ||
    typeof native.ModelRegistry?.prototype?.refreshAvailableModels !== 'function' ||
    typeof native.ModelRegistry?.prototype?.getAvailable !== 'function' ||
    typeof ai.getSupportedThinkingLevels !== 'function'
  )
    throw new Error('Unsupported native catalogue');
  thinkingLevels = ai.getSupportedThinkingLevels;
  // Prime Agent 0.9.5 ordinary resolution is Prime env then auth.json. The Prime CLI
  // config is reused only during an explicit upstream login, never as an ordinary
  // candidate and never silently: keep it disabled here and do not watch its file.
  auth = native.AuthStorage.create(join(agentHome, 'auth.json'), { usePrimeCliConfig: false });
  if (auth.drainErrors?.().length) throw new Error('Native auth could not be read');
  modelsPath = join(agentHome, 'models.json');
  // Later CLI login, logout, URL or team changes do not affect Agent, so only the
  // Studio-owned files can invalidate this catalogue.
  configPaths = [join(agentHome, 'auth.json'), modelsPath, join(agentHome, 'settings.json')];
}

async function fingerprint() {
  return JSON.stringify(
    await Promise.all(
      configPaths.map(async (path) => {
        try {
          const info = await stat(path, { bigint: true });
          return [path, `${info.mtimeNs}:${info.ctimeNs}:${info.size}:${info.ino}`];
        } catch (error) {
          if (error.code !== 'ENOENT') throw new Error('Native configuration could not be inspected');
          return [path, 'missing'];
        }
      }),
    ),
  );
}

function snapshot(registry, { metaCanonical = false } = {}) {
  // Canonical Meta models must only reach the picker with a real credential.
  // The registration placeholder alone (models_json_key without stored key or
  // MODEL_API_KEY env) is pruned here; the provider still lists in manage
  // connections via the provider-auth overlay. User meta overrides are kept.
  let pruneMeta = false;
  if (metaCanonical) {
    try {
      const source = registry.getProviderAuthStatus?.(META_PROVIDER_ID)?.source;
      pruneMeta = !META_REAL_AUTH_SOURCES.has(source) && !process.env.MODEL_API_KEY;
    } catch {
      pruneMeta = false;
    }
  }
  const models = new Map();
  // getAll() includes unauthorized private models. Only this native availability filter may supply UI rows.
  for (const model of registry.getAvailable()) {
    if (!model || typeof model !== 'object') continue;
    const id = text(model.id);
    const provider = text(model.provider, 128);
    if (!id || !provider) continue;
    if (pruneMeta && provider === META_PROVIDER_ID) continue;
    const levels = thinkingLevels(model);
    models.set(`${provider}/${id}`, {
      id,
      provider,
      name: text(model.name) || id,
      reasoning: model.reasoning === true,
      input: Array.isArray(model.input) ? model.input.filter((kind) => ['text', 'image'].includes(kind)) : [],
      contextWindow: number(model.contextWindow),
      maxTokens: number(model.maxTokens),
      ...(provider === 'openrouter'
        ? {
            // Resolved native provenance is needed server-side; never serialize the endpoint itself.
            openRouterPublic:
              typeof model.baseUrl === 'string' &&
              model.baseUrl.replace(/\/+$/, '') === 'https://openrouter.ai/api/v1',
          }
        : {}),
      thinkingLevels: Array.isArray(levels)
        ? [...new Set(levels.filter((level) => THINKING.has(level)))]
        : [],
    });
  }
  return {
    models: [...models.values()],
    configuredProviders: [...new Set([...models.values()].map((m) => m.provider))],
  };
}

function publish(current) {
  if (state !== current) return;
  current.catalog = snapshot(current.registry, { metaCanonical: current.metaCanonical === true });
}

function beginRefresh(current) {
  if (current.refreshing) return;
  current.lastRefresh = Date.now();
  current.refreshing = true;
  // There is no native completion event for the public fetch or a stale private-cache refresh.
  // Sample the native snapshot through both documented timeouts (5s public / 10s private).
  current.timer = setInterval(() => {
    if (state !== current) return clearInterval(current.timer);
    try {
      publish(current);
    } catch {
      current.catalog = { models: [], configuredProviders: [] };
    }
    if (Date.now() - current.lastRefresh >= OBSERVATION_WINDOW) {
      current.refreshing = false;
      clearInterval(current.timer);
    }
  }, POLL_INTERVAL);
  current.timer.unref();
  Promise.resolve()
    .then(() => current.registry.refreshAvailableModels())
    .then(() => {
      if (state === current) publish(current);
    })
    .catch(() => {
      // Keep the native disk/bundled snapshot. Native errors can include credential-bearing config.
    });
}

async function read(message) {
  initializing ??= initialize(message);
  await initializing;
  const stamp = await fingerprint();
  if (!state || stamp !== state.stamp) {
    clearInterval(state?.timer);
    auth.drainErrors?.();
    auth.reload();
    if (auth.drainErrors?.().length) throw new Error('Native auth could not be read');
    // A previous in-flight refresh keeps its own registry, so its result cannot restore an old team.
    const registry = native.ModelRegistry.create(auth, modelsPath);
    // Canonical Meta overlay: picker availability without manual custom setup.
    // ANY user models.json meta entry (JSONC-aware) wins; malformed content
    // fails closed and skips the canonical registration.
    let metaCanonical = false;
    try {
      metaCanonical = ensureMetaProvider(registry, { hasUserConfig: hasUserMetaConfig(modelsPath) });
    } catch {
      metaCanonical = false;
    }
    const current = { registry, stamp, refreshing: false, lastRefresh: 0, metaCanonical };
    state = current;
    publish(current);
  }
  if (message.refresh || Date.now() - state.lastRefresh >= REFRESH_TTL) beginRefresh(state);
  publish(state);
  return { ...state.catalog, refreshing: state.refreshing };
}

process.on('message', (message) => {
  if (message?.type === 'close') process.exit(0);
  if (message?.type !== 'read' || !Number.isInteger(message.id)) return;
  requests = requests.then(async () => {
    try {
      const catalog = await read(message);
      if (process.connected) process.send({ id: message.id, ok: true, catalog }, () => {});
    } catch {
      if (process.connected) process.send({ id: message.id, ok: false }, () => {});
    }
  });
});
process.once('disconnect', () => process.exit(0));
