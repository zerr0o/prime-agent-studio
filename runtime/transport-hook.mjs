import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformNativeUiTransport } from './native-ui-transport.mjs';
import { studioModelSourceKind, transformStudioModelSupport } from './studio-models-hook.mjs';
let packageRoot;
export function initialize(data) {
  packageRoot = resolve(data.packageRoot);
}

// OpenAI connections expire after 60 minutes. Rotate only an idle connection,
// before the next request, keeping native full-context replay and retry handling.
export function transformCodexTransport(source) {
  const replaceOnce = (before, after) => {
    if (source.split(before).length !== 2)
      throw new Error('Prime Agent transport adapter requires an update: unsupported WebSocket lifecycle.');
    source = source.replace(before, after);
  };
  replaceOnce(
    'const entry = { socket, busy: true };',
    'const entry = { socket, busy: true, studioOpenedAt: Date.now() };',
  );
  replaceOnce(
    '!cached.busy && isWebSocketReusable(cached.socket)',
    '!cached.busy && isWebSocketReusable(cached.socket) && !studioSocketExpired(cached)',
  );
  replaceOnce(
    'if (!isWebSocketReusable(cached.socket))',
    'if (!isWebSocketReusable(cached.socket) || studioSocketExpired(cached))',
  );
  replaceOnce(
    'if (!keep || !isWebSocketReusable(cached.socket))',
    'if (!keep || !isWebSocketReusable(cached.socket) || studioSocketExpired(cached))',
  );
  replaceOnce(
    'if (!keep || !isWebSocketReusable(entry.socket))',
    'if (!keep || !isWebSocketReusable(entry.socket) || studioSocketExpired(entry))',
  );
  return `function studioSocketExpired(entry) { return Date.now() - entry.studioOpenedAt >= 50 * 60 * 1000; }\n${source}`;
}
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!packageRoot || !url.startsWith('file:') || result.format !== 'module') return result;
  const path = relative(packageRoot, fileURLToPath(url)).replaceAll('\\', '/');
  const codex =
    /^dist\/bundle\/openai-codex-responses-[^/]+\.js$/.test(path) ||
    path === 'node_modules/@earendil-works/pi-ai/dist/providers/openai-codex-responses.js';
  const nativeUi =
    path === 'dist/modes/daemon/daemon-mode.js'
      ? 'worker'
      : path === 'dist/modes/daemon/daemon-supervisor.js'
        ? 'supervisor'
        : undefined;
  const modelSupport = studioModelSourceKind(path);
  if (
    !codex &&
    !nativeUi &&
    !modelSupport.catalog &&
    !modelSupport.adapter &&
    !modelSupport.registry &&
    !modelSupport.bundle
  )
    return result;
  const original =
    typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  const source = transformStudioModelSupport(original, modelSupport);
  if (codex) return { ...result, source: transformCodexTransport(source) };
  const transformed = transformNativeUiTransport(source, { required: nativeUi });
  return transformed.changed || source !== original ? { ...result, source: transformed.source } : result;
}
