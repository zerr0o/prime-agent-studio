import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { probeHealth, isDirectInvocation, readJson } from './launcher-common.mjs';
import { stopServer } from './stop-server.mjs';
import { startDesktop } from './desktop-start.mjs';
import { quickComponentReceipt } from '../lib/desktop-components.mjs';

async function activity(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/runs`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error('server_status_failed');
  const { runs } = await response.json();
  if (!Array.isArray(runs)) throw new Error('server_status_failed');
  return runs.filter((run) => ['running', 'stopping', 'queued'].includes(run.status)).length;
}

export async function desktopServerStatus({ dataRoot, port }, deps = {}) {
  const current = await (deps.probe || probeHealth)(port);
  if (current.state === 'absent') return { running: false, managed: true, activeRuns: 0 };
  if (current.state !== 'ready') throw new Error('server_port_occupied');
  const owner = await readJson(join(resolve(dataRoot), 'data', 'server.json'));
  const managed = Boolean(
    owner &&
    owner.pid === current.health.pid &&
    owner.port === port &&
    owner.instanceId &&
    owner.instanceId === current.health.instanceId,
  );
  return {
    running: true,
    managed,
    version: current.health.version,
    instanceId: current.health.instanceId,
    activeRuns: await (deps.activity || activity)(port),
  };
}

export async function restartDesktop(options, deps = {}) {
  // Confirm the replacement is present before stopping a working server.
  const manifest = JSON.parse(await readFile(join(options.resourceDir, 'desktop-resource.json'), 'utf8'));
  if (!manifest.version || !/^[a-f0-9]{64}$/.test(manifest.identity))
    throw new Error('server_version_mismatch');
  await Promise.all(
    ['node.exe', 'studio/server.mjs', 'studio/scripts/desktop-start.mjs'].map((path) =>
      access(join(options.resourceDir, path)),
    ),
  );
  const before = await desktopServerStatus(options, deps);
  if (!before.managed) throw new Error('server_not_managed');
  if (before.activeRuns && !options.force) return { ...before, restarted: false, reason: 'agents_running' };
  // Never stop a working server before the newly installed backend has its
  // required engine/Python receipt. In particular, an app update can require a
  // newer engine that has not been prepared yet. Explicit Later remains allowed.
  if (before.running && !options.allowUnconfigured) {
    const receipt = await (deps.quickReceipt || quickComponentReceipt)(options);
    if (!receipt.ok) return { ...before, restarted: false, reason: 'components_required' };
  }
  const dataDir = join(resolve(options.dataRoot), 'data');
  if (before.running) {
    try {
      const stopped = await (deps.stop || stopServer)({
        root: join(options.resourceDir, 'studio'),
        dataDir,
        expectedInstanceId: before.instanceId,
        beforeStop: async () => {
          const active = await (deps.activity || activity)(options.port);
          if (active && !options.force) throw new Error('agents_running');
        },
      });
      if (!stopped.stopped && stopped.reason !== 'already-stopped') throw new Error('server_not_managed');
    } catch (error) {
      if (error.message === 'agents_running') return { restarted: false, reason: 'agents_running' };
      throw error;
    }
  }
  const result = await (deps.start || startDesktop)(options);
  const after = await (deps.probe || probeHealth)(options.port);
  if (after.state !== 'ready' || after.health.version !== manifest.version || result.reused)
    throw new Error('server_version_mismatch');
  return { ...result, restarted: true, version: after.health.version };
}

if (isDirectInvocation(import.meta.url)) {
  try {
    const options = JSON.parse(process.argv[2]);
    const result =
      options.action === 'status' ? await desktopServerStatus(options) : await restartDesktop(options);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
}
