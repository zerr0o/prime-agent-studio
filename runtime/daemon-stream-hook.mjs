import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let packageRoot;
export function initialize(data) {
  packageRoot = resolve(data.packageRoot);
}

/** Keep the authenticated worker→supervisor link lossless, not snapshot-based.
 * Node write(false) means queued, not rejected. Preserve its return value for
 * snapshot producers that await drain, but do not drop subsequent live frames.
 * Bound Node's queue explicitly; an overloaded link fails rather than truncates.
 */
function transformWorkerStream(source, { required = false } = {}) {
  const signature = 'writeSerialized(client, line, message, payloadEncoding = "jsonl", snapshotPurpose) {';
  if (!source.includes(signature) && !source.includes('broadcastToSession(state, message) {') && !required)
    return { source, changed: false };
  const methods = [
    ...source.matchAll(
      /^( +)writeSerialized\(client, line, message, payloadEncoding = "jsonl", snapshotPurpose\) \{[\s\S]*?^\1\}/gm,
    ),
  ];
  const unsupported = () => new Error('Prime Agent daemon stream layout changed; update the Studio adapter.');
  if (methods.length !== 1) throw unsupported();
  const method = methods[0];
  const target =
    /const accepted = client\.socket\.write\(wireData\);\s*if \(!accepted\) \{\s*client\.backpressured = true;\s*\}\s*return accepted;/g;
  if ([...method[0].matchAll(target)].length !== 1) throw unsupported();
  const replacement = `const studioReliableRelay = client.transport === "private-framed" && client.authenticationRole === "supervisor";
        if (studioReliableRelay && client.socket.writableLength + wireData.byteLength > 16 * 1024 * 1024) {
            client.socket.destroy(new Error("Studio worker relay exceeded its 16 MiB queue limit"));
            return false;
        }
        const accepted = client.socket.write(wireData);
        if (!accepted && !studioReliableRelay) {
            client.backpressured = true;
        }
        return studioReliableRelay && !message.type.startsWith("session_snapshot_") ? true : accepted;`;
  const body = method[0].replace(target, replacement);
  return {
    changed: true,
    source: source.slice(0, method.index) + body + source.slice(method.index + method[0].length),
  };
}

function transformSupervisorStream(source, { required = false } = {}) {
  if (!source.includes('handleWorkerFrame(worker, frame, source) {') && !required)
    return { source, changed: false };
  const methods = [...source.matchAll(/^( +)writeSerialized\(client, line\) \{[\s\S]*?^\1\}/gm)];
  const drain = 'this.writeSerialized(client, buffer)';
  if (methods.length !== 1 || source.split(drain).length !== 2)
    throw new Error('Prime Agent supervisor stream layout changed; update the Studio adapter.');
  const method = methods[0];
  const expected =
    /const accepted = client\.socket\.write\(line\);\s*if \(!accepted\) \{\s*client\.backpressured = true;\s*\}\s*return accepted;/;
  if (!expected.test(method[0]))
    throw new Error('Prime Agent supervisor stream layout changed; update the Studio adapter.');
  const body = method[0]
    .replace('writeSerialized(client, line)', 'writeSerialized(client, line, studioSnapshot = false)')
    .replace(
      expected,
      `if (client.socket.writableLength + Buffer.byteLength(line) > 16 * 1024 * 1024) {
            client.socket.destroy(new Error("Studio client relay exceeded its 16 MiB queue limit"));
            return false;
        }
        const accepted = client.socket.write(line);
        return studioSnapshot ? accepted : true;`,
    );
  return {
    changed: true,
    source: (source.slice(0, method.index) + body + source.slice(method.index + method[0].length)).replace(
      drain,
      'this.writeSerialized(client, buffer, true)',
    ),
  };
}

export function transformDaemonStream(source, { required = false, supervisorRequired = false } = {}) {
  const worker = transformWorkerStream(source, { required });
  const supervisor = transformSupervisorStream(worker.source, { required: supervisorRequired });
  return { source: supervisor.source, changed: worker.changed || supervisor.changed };
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!packageRoot || !url.startsWith('file:') || result.format !== 'module') return result;
  const path = relative(packageRoot, fileURLToPath(url)).replaceAll('\\', '/');
  const unbundled = path === 'dist/modes/daemon/daemon-mode.js';
  const supervisor = path === 'dist/modes/daemon/daemon-supervisor.js';
  if (!unbundled && !supervisor && !/^dist\/bundle\/[^/]+\.m?js$/.test(path)) return result;
  const source =
    typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  const transformed = transformDaemonStream(source, { required: unbundled, supervisorRequired: supervisor });
  return transformed.changed ? { ...result, source: transformed.source } : result;
}
