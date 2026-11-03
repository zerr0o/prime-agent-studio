import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

let packageRoot;
export function initialize(data) {
  packageRoot = resolve(data.packageRoot);
}

export const BUDGET_MARKER = '/* Studio: model output budget follows model.maxTokens. */';
const PATCHED_FRAGMENT = 'options?.maxTokens ?? (model.maxTokens > 0 ? model.maxTokens : void 0)';
const LEGACY_PATTERN =
  /maxTokens:\s*options\?\.maxTokens\s*\?\?\s*\(model\.maxTokens\s*>\s*0\s*\?\s*Math\.min\(model\.maxTokens\s*,\s*(?:32e3|32000)\s*\)\s*:\s*(?:void 0|undefined)\s*\)/g;

// Beta scope: the implicit generation default follows the model limit instead
// of min(model.maxTokens, 32000). Explicit options.maxTokens (including 512)
// and unknown/nonpositive model limits are untouched.
export function transformModelOutputBudget(source, { required = false } = {}) {
  const legacy = [...source.matchAll(LEGACY_PATTERN)];
  const patched = source.includes(PATCHED_FRAGMENT);
  const marked = source.includes(BUDGET_MARKER);
  if (legacy.length === 1) {
    if (marked) throw new Error('Model output budget layout changed; update the Studio adapter.');
    const replacement =
      'maxTokens: options?.maxTokens ?? (model.maxTokens > 0 ? model.maxTokens : void 0) ' + BUDGET_MARKER;
    return { changed: true, source: source.replace(legacy[0][0], replacement) };
  }
  if (legacy.length > 1) throw new Error('Model output budget layout changed; update the Studio adapter.');
  if (patched && marked) return { source, changed: false };
  if (!source.includes('buildBaseOptions') && !required) return { source, changed: false };
  throw new Error('Model output budget layout changed; update the Studio adapter.');
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!packageRoot || !url.startsWith('file:') || result.format !== 'module') return result;
  const rel = relative(packageRoot, fileURLToPath(url));
  // Containment first: a foreign simple-options.js (../) or another drive
  // must never match the unbundled shape below.
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return result;
  const path = rel.replaceAll('\\', '/');
  const unbundled = path.endsWith('ai/src/providers/simple-options.ts') || path.endsWith('simple-options.js');
  if (!unbundled && !/^dist\/bundle\/[^/]+\.m?js$/.test(path)) return result;
  const source =
    typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  // Only the shared helper module defines buildBaseOptions; provider bundles
  // merely import it.
  if (!unbundled && !source.includes('function buildBaseOptions(')) return result;
  const change = transformModelOutputBudget(source, { required: unbundled });
  return change.changed ? { ...result, source: change.source } : result;
}
