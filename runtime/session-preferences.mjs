// Studio conversations retain native model/thinking entries without changing
// Prime Agent's defaults. Explicit defaults are managed by the Settings API.
const SCOPED_MARKER = '/* Studio: session preference only. */';
const SCOPED_MARKER_PATTERN = /\/\* Studio: session preference only\. \*\//g;

export function transformSessionPreferences(source, { required = false, url = null } = {}) {
  if (!source.includes('setThinkingLevel(level) {') && !required) return { source, changed: false };
  const thinking = 'this.settingsManager.setDefaultThinkingLevel(effectiveLevel);';
  const models =
    /this\.settingsManager\.setDefaultModelAndProvider\((?:model\.provider, model\.id|next\.model\.provider, next\.model\.id|nextModel\.provider, nextModel\.id)\);/g;
  const thinkingCount = source.split(thinking).length - 1;
  const modelCount = [...source.matchAll(models)].length;
  if (thinkingCount === 1 && modelCount === 3)
    return {
      changed: true,
      source: source.replace(thinking, SCOPED_MARKER).replace(models, SCOPED_MARKER),
    };
  // Idempotent when another Studio adapter earlier in the loader chain (for
  // example hooks inherited through NODE_OPTIONS) already scoped this exact
  // module: the four raw global writes are gone and its own scoping markers
  // are present. Global preference writes stay neutralized, so there is
  // nothing left to patch. Any other shape still fails closed below.
  const scopedCount = (source.match(SCOPED_MARKER_PATTERN) || []).length;
  if (thinkingCount === 0 && modelCount === 0 && scopedCount >= 4) return { source, changed: false };
  const where = typeof url === 'string' && url ? ` (${url.slice(-120)})` : '';
  const detail = `thinking=${thinkingCount} models=${modelCount} scoped=${scopedCount}${where}`;
  throw new Error(
    `La portée des réglages de conversation nécessite une mise à jour de l’adaptateur du Studio. ${detail}`,
  );
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!packageRoot || !url.startsWith('file:') || result.format !== 'module') return result;
  const path = relative(packageRoot, fileURLToPath(url)).replaceAll('\\', '/');
  const unbundled = path === 'dist/core/agent-session.js';
  if (!unbundled && !/^dist\/bundle\/[^/]+\.m?js$/.test(path)) return result;
  const source =
    typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  // Other bundles contain unrelated setters; only the native AgentSession owns this method.
  if (!unbundled && !source.includes('async _startRlmChildRun(')) return result;
  const changed = transformSessionPreferences(source, { required: true, url });
  return { ...result, source: changed.source };
}
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
let packageRoot;
export function initialize(data) {
  packageRoot = resolve(data.packageRoot);
}
