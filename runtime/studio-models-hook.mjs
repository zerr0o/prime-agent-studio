import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STUDIO_MODELS,
  CODEX_CATALOG_CLIENT_VERSION,
  ANTHROPIC_CLAUDE_CODE_CLIENT_VERSION,
} from '../lib/studio-models.mjs';

const catalogLoop = 'for (const [provider, models] of Object.entries(MODELS)) {';
const alwaysOn = 'function isAlwaysOnAdaptiveThinkingModel(modelId) {';
const catalogMarker = '/* Studio: additive model catalog compatibility. */';
const registryMerge = 'return mergePrimeInferenceModels(bundledModels, livePrimeInferenceModels).map(';
const registryMarker = '/* Studio: additive native registry model compatibility. */';
const thinkingMarker = '/* Studio: Claude Opus 5.5 and Fable 5.2 always-on thinking. */';

function bumpVersion(source, pattern, target, required, message) {
  const versions = [...source.matchAll(pattern)];
  if (versions.length > 1 || (required && versions.length !== 1)) throw new Error(message);
  if (versions.length === 1) {
    const current = versions[0][2].split('.').map(Number);
    const minimum = target.split('.').map(Number);
    const different = current.findIndex((part, index) => part !== minimum[index]);
    if (different >= 0 && current[different] < minimum[different])
      source = source.replace(versions[0][0], versions[0][0].replace(versions[0][2], target));
  }
  return source;
}

// Add built-ins, not replacement providers. Native authentication, existing
// models and models.json overrides keep their normal precedence.
export function transformStudioModelSupport(
  source,
  { catalog = false, adapter = false, registry = false } = {},
) {
  if (!source.includes(catalogMarker)) {
    if (source.includes(catalogLoop)) {
      if (source.split(catalogLoop).length !== 2)
        throw new Error('Studio model catalog adapter requires an update.');
      source = source.replace(
        catalogLoop,
        `${catalogMarker}
for (const studioModel of ${JSON.stringify(STUDIO_MODELS)}) {
  (MODELS[studioModel.provider] ??= {})[studioModel.id] ??= studioModel;
}
${catalogLoop}`,
      );
    } else if (catalog) {
      throw new Error('Studio model catalog adapter requires an update.');
    }
  }
  // Native registries can replace pi-ai's list with a packaged or cached
  // provider catalog. Add missing models before native overrides/auth filters,
  // without mutating that catalog or replacing upstream model definitions.
  if (!source.includes(registryMarker)) {
    if (source.includes(registryMerge)) {
      if (source.split(registryMerge).length !== 2)
        throw new Error('Studio native model registry adapter requires an update.');
      source = source.replace(
        registryMerge,
        `${registryMarker}
return mergePrimeInferenceModels([
  ...bundledModels,
  ...${JSON.stringify(STUDIO_MODELS)}.filter((studioModel) =>
    !bundledModels.some((model) => model.provider === studioModel.provider && model.id === studioModel.id)),
], livePrimeInferenceModels).map(`,
      );
    } else if (registry) {
      throw new Error('Studio native model registry adapter requires an update.');
    }
  }
  if (!source.includes(thinkingMarker)) {
    if (source.includes(alwaysOn)) {
      if (source.split(alwaysOn).length !== 2)
        throw new Error('Studio Anthropic thinking adapter requires an update.');
      source = source.replace(
        alwaysOn,
        `${alwaysOn}
  ${thinkingMarker}
  if (modelId === "claude-opus-5-5" || modelId === "claude-fable-5-2") return true;`,
      );
      // Studio trims old tool results and rebuilds prompts on resume. Fable 5.2
      // checks every account's thinking prefix; let the API drop only invalid
      // blocks instead of failing a long conversation. No local history edits
      // or automatic retries. Explicit user header overrides still win.
      // https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
      const betaFeatures = 'const betaFeatures = [];';
      const toolChoice = 'if (options?.toolChoice) {';
      if (source.split(betaFeatures).length !== 2 || source.split(toolChoice).length !== 2)
        throw new Error('Studio Anthropic thinking-binding adapter requires an update.');
      source = source.replace(
        betaFeatures,
        `${betaFeatures}
    if (model.id === "claude-fable-5-2") betaFeatures.push("thinking-binding-controls-2026-08-01");`,
      );
      source = source.replace(
        toolChoice,
        `if (model.id === "claude-fable-5-2") {
        params.thinking = { ...params.thinking, type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } };
    }
    ${toolChoice}`,
      );
      // Always-on models can return empty, signed thinking blocks. Keep their
      // signatures in tool loops instead of dropping them as empty content.
      const emptyThinking = 'if (block.thinking.trim().length === 0)';
      if (source.split(emptyThinking).length !== 2)
        throw new Error('Studio Anthropic signed-thinking adapter requires an update.');
      source = source.replace(
        emptyThinking,
        'if (block.thinking.trim().length === 0 && !((model.id === "claude-opus-5-5" || model.id === "claude-fable-5-2") && block.thinkingSignature))',
      );
    } else if (adapter) {
      throw new Error('Studio Anthropic thinking adapter requires an update.');
    }
  }
  // Anthropic gates newer models on the OAuth adapter's Claude Code identity.
  // Updating a separate CLI does not change this constant in the native engine.
  // Leave native auth, API-key requests and explicit user header overrides alone.
  const claudeVersionPattern = /\b(?:const|var)\s+claudeCodeVersion\s*=\s*(["'])(\d+\.\d+\.\d+)\1/g;
  source = bumpVersion(
    source,
    claudeVersionPattern,
    ANTHROPIC_CLAUDE_CODE_CLIENT_VERSION,
    adapter || source.includes(alwaysOn),
    'Studio Claude Code version adapter requires an update.',
  );
  // Codex filters executable models by a versioned server catalog. Raise only
  // older engine client versions, never downgrade an upstream engine update.
  const versionPattern = /\b(?:const|var)\s+OPENAI_CODEX_CLIENT_VERSION\s*=\s*(["'])(\d+\.\d+\.\d+)\1/g;
  source = bumpVersion(
    source,
    versionPattern,
    CODEX_CATALOG_CLIENT_VERSION,
    registry,
    'Studio Codex catalog adapter requires an update.',
  );
  return source;
}

let packageRoot;
export function initialize(data) {
  packageRoot = resolve(data.packageRoot);
}

export function studioModelSourceKind(path) {
  return {
    catalog: /^node_modules\/@(?:earendil-works|mariozechner)\/pi-ai\/dist\/models\.js$/.test(path),
    adapter: /^node_modules\/@(?:earendil-works|mariozechner)\/pi-ai\/dist\/providers\/anthropic\.js$/.test(
      path,
    ),
    registry: path === 'dist/core/model-registry.js',
    bundle: /^dist\/bundle\/[^/]+\.m?js$/.test(path),
  };
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!packageRoot || !url.startsWith('file:') || result.format !== 'module') return result;
  const path = relative(packageRoot, fileURLToPath(url)).replaceAll('\\', '/');
  const kind = studioModelSourceKind(path);
  if (!kind.catalog && !kind.adapter && !kind.registry && !kind.bundle) return result;
  const source =
    typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  const transformed = transformStudioModelSupport(source, kind);
  return transformed === source ? result : { ...result, source: transformed };
}
