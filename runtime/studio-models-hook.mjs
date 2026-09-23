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
const thinkingMarker = '/* Studio: Claude Opus 5.5 always-on thinking. */';

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
  if (!source.includes(thinkingMarker)) {
    if (source.includes(alwaysOn)) {
      if (source.split(alwaysOn).length !== 2)
        throw new Error('Studio Anthropic thinking adapter requires an update.');
      source = source.replace(
        alwaysOn,
        `${alwaysOn}
  ${thinkingMarker}
  if (modelId === "claude-opus-5-5") return true;`,
      );
      // Always-on models can return empty, signed thinking blocks. Keep their
      // signatures in tool loops instead of dropping them as empty content.
      source = source.replace(
        'if (block.thinking.trim().length === 0)',
        'if (block.thinking.trim().length === 0 && !(model.id === "claude-opus-5-5" && block.thinkingSignature))',
      );
    } else if (adapter) {
      throw new Error('Studio Anthropic thinking adapter requires an update.');
    }
  }
  // Anthropic gates newer models on the OAuth adapter's Claude Code identity.
  // Updating a separate CLI does not change this constant in the native engine.
  // Leave native auth, API-key requests and explicit user header overrides alone.
  const claudeVersionPattern = /\b(?:const|var)\s+claudeCodeVersion\s*=\s*(["'])(\d+\.\d+\.\d+)\1/g;
  const claudeVersions = [...source.matchAll(claudeVersionPattern)];
  if (claudeVersions.length > 1 || ((adapter || source.includes(alwaysOn)) && claudeVersions.length !== 1))
    throw new Error('Studio Claude Code version adapter requires an update.');
  if (claudeVersions.length === 1) {
    const current = claudeVersions[0][2].split('.').map(Number);
    const required = ANTHROPIC_CLAUDE_CODE_CLIENT_VERSION.split('.').map(Number);
    const different = current.findIndex((part, index) => part !== required[index]);
    if (different >= 0 && current[different] < required[different])
      source = source.replace(
        claudeVersions[0][0],
        claudeVersions[0][0].replace(claudeVersions[0][2], ANTHROPIC_CLAUDE_CODE_CLIENT_VERSION),
      );
  }
  // Codex filters executable models by a versioned server catalog. Raise only
  // older engine client versions, never downgrade an upstream engine update.
  const versionPattern = /\b(?:const|var)\s+OPENAI_CODEX_CLIENT_VERSION\s*=\s*(["'])(\d+\.\d+\.\d+)\1/g;
  const versions = [...source.matchAll(versionPattern)];
  if (versions.length > 1 || (registry && versions.length !== 1))
    throw new Error('Studio Codex catalog adapter requires an update.');
  if (versions.length === 1) {
    const current = versions[0][2].split('.').map(Number);
    const required = CODEX_CATALOG_CLIENT_VERSION.split('.').map(Number);
    const different = current.findIndex((part, index) => part !== required[index]);
    if (different >= 0 && current[different] < required[different])
      source = source.replace(
        versions[0][0],
        versions[0][0].replace(versions[0][2], CODEX_CATALOG_CLIENT_VERSION),
      );
  }
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
