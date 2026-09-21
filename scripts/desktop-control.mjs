import { readFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { probeHealth, isDirectInvocation, readJson } from './launcher-common.mjs';
import { stopServer } from './stop-server.mjs';
import { startDesktop } from './desktop-start.mjs';
import {
  resolveOwnership,
  verifyManagedTarget,
  verifyServerProcess,
  verifyPortOwner,
} from './desktop-server-identity.mjs';
import { quickComponentReceipt } from '../lib/desktop-components.mjs';

const execFileAsync = promisify(execFile);

async function activity(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/runs`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error('server_status_failed');
  const { runs } = await response.json();
  if (!Array.isArray(runs)) throw new Error('server_status_failed');
  return runs.filter((run) => ['running', 'stopping', 'queued'].includes(run.status)).length;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function makeEmitter(options, deps) {
  return (phase, extra = {}) => {
    const event = { phase, stage: phase, ...extra };
    if (deps && typeof deps.onProgress === 'function') {
      try {
        deps.onProgress(event);
      } catch {}
    }
    if (options && options.progress === true) {
      process.stdout.write(`${JSON.stringify({ type: 'progress', ...event })}\n`);
    }
  };
}

// Readonly status. Never writes, repairs, or deletes the ownership marker.
export async function desktopServerStatus({ dataRoot, port, resourceDir }, deps = {}) {
  const current = await (deps.probe || probeHealth)(port);
  if (current.state === 'absent') {
    return {
      running: false,
      managed: true,
      ownership: 'absent',
      source: 'none',
      pid: null,
      port,
      instanceId: null,
      version: null,
      activeRuns: 0,
      canRestart: false,
      restartReason: 'server_stopped',
      canStop: false,
      stopReason: 'already-stopped',
    };
  }
  if (current.state !== 'ready') throw new Error('server_port_occupied');
  const owner =
    deps.owner !== undefined ? deps.owner : await readJson(join(resolve(dataRoot), 'data', 'server.json'));
  const resolved = await resolveOwnership(
    { health: current.health, owner, port, dataRoot, resourceDir: resourceDir || deps.resourceDir },
    deps,
  );
  // resourceDir for OS verification can come from status deps (UI passes it)
  // or from the caller options in restart/stop paths below.
  const activeRuns = await (deps.activity || activity)(port);
  const can = resolved.ownership === 'managed' || resolved.ownership === 'recoverable';
  return {
    running: true,
    managed: resolved.ownership === 'managed',
    ownership: resolved.ownership,
    source: resolved.source,
    reason: resolved.reason,
    generationDir: resolved.generationDir,
    identity: resolved.identity,
    portUnknown: resolved.portUnknown,
    pid: current.health.pid,
    port,
    instanceId: current.health.instanceId,
    version: current.health.version,
    activeRuns,
    canRestart: can,
    restartReason: can ? null : 'server_not_managed',
    canStop: can,
    stopReason: can ? null : 'server_not_managed',
  };
}

async function readManifest(resourceDir) {
  const manifest = JSON.parse(await readFile(join(resourceDir, 'desktop-resource.json'), 'utf8'));
  if (!manifest.version || !/^[a-f0-9]{64}$/.test(manifest.identity))
    throw new Error('server_version_mismatch');
  await Promise.all(
    ['node.exe', 'studio/server.mjs', 'studio/scripts/desktop-start.mjs'].map((path) =>
      access(join(resourceDir, path)),
    ),
  );
  return manifest;
}

// Targeted stop for a recoverable server without an ownership marker.
// Double verification immediately before kill: health recheck plus OS
// exe plus args plus generation plus TCP port owner, then a second health
// recheck after the activity gate to close the PID reuse race.
// Never writes or reconstructs data/server.json; startServer recreates it.
async function stopRecoverableServer(
  { port, dataRoot, resourceDir, expectedPid, expectedInstanceId, force },
  deps,
) {
  const probe = deps.probe || probeHealth;
  const first = await probe(port);
  if (first.state === 'absent') return { stopped: false, reason: 'already-stopped' };
  if (
    first.state !== 'ready' ||
    first.health.pid !== expectedPid ||
    first.health.instanceId !== expectedInstanceId
  ) {
    throw new Error('server_not_managed');
  }
  const verified = await verifyServerProcess({ pid: first.health.pid, dataRoot, resourceDir }, deps);
  if (!verified.verified) throw new Error('server_not_managed');
  const portCheck = await verifyPortOwner({ port, pid: first.health.pid }, deps);
  if (!portCheck.ok) throw new Error('server_not_managed');
  // Fail closed when activity is unreachable: any error other than a clean
  // count blocks the kill (never default to zero).
  const active = await (deps.activity || activity)(port);
  if (active && !force) {
    const error = new Error('agents_running');
    error.code = 'agents_running';
    throw error;
  }
  // Immediate second recheck after the activity gate, before any kill.
  const second = await probe(port);
  if (
    second.state !== 'ready' ||
    second.health.pid !== expectedPid ||
    second.health.instanceId !== expectedInstanceId
  ) {
    throw new Error('server_not_managed');
  }
  const reverified = await verifyServerProcess({ pid: second.health.pid, dataRoot, resourceDir }, deps);
  if (!reverified.verified) throw new Error('server_not_managed');
  const portRecheck = await verifyPortOwner({ port, pid: second.health.pid }, deps);
  if (!portRecheck.ok) throw new Error('server_not_managed');
  // PID reuse guard: same declarative pid plus instanceId but a different OS
  // process between the two checks must block the kill.
  if (verified.createdAt && reverified.createdAt && verified.createdAt !== reverified.createdAt) {
    throw new Error('server_not_managed');
  }
  if (typeof deps.kill === 'function') {
    await deps.kill(second.health.pid);
  } else if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(second.health.pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
    });
  } else {
    process.kill(second.health.pid, 'SIGTERM');
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const current = await probe(port, { timeout: 500 });
    if (current.state === 'absent' || current.health?.instanceId !== expectedInstanceId) {
      return { stopped: true };
    }
    await sleep(100);
  }
  throw new Error('server_stop_failed');
}

export async function restartDesktop(options, deps = {}) {
  const emit = makeEmitter(options, deps);
  emit('checking');
  const manifest = await readManifest(options.resourceDir);
  const statusDeps = { ...deps, resourceDir: options.resourceDir };
  const before = await desktopServerStatus(options, statusDeps);
  if (!before.running) {
    // Stopped server: fresh start path, no ownership gate and no stop phase.
    if (!options.allowUnconfigured) {
      const receipt = await (deps.quickReceipt || quickComponentReceipt)(options);
      if (!receipt.ok) return { ...before, restarted: false, reason: 'components_required' };
    }
    emit('starting');
    const started = await (deps.start || startDesktop)(options);
    const after = await (deps.probe || probeHealth)(options.port);
    if (after.state !== 'ready' || after.health.version !== manifest.version || started.reused) {
      throw new Error('server_version_mismatch');
    }
    emit('ready', { version: after.health.version, pid: after.health.pid });
    return { ...started, restarted: true, version: after.health.version };
  }
  if (!before.canRestart) throw new Error('server_not_managed');
  if (before.activeRuns && !options.force) return { ...before, restarted: false, reason: 'agents_running' };
  // Never stop a working server before the newly installed backend has its
  // required engine/Python receipt. Explicit Later remains allowed.
  if (!options.allowUnconfigured) {
    const receipt = await (deps.quickReceipt || quickComponentReceipt)(options);
    if (!receipt.ok) return { ...before, restarted: false, reason: 'components_required' };
  }
  const dataDir = join(resolve(options.dataRoot), 'data');
  emit('stopping', { pid: before.pid, ownership: before.ownership });
  if (before.ownership === 'managed') {
    try {
      const ownerRecord =
        statusDeps.owner !== undefined
          ? statusDeps.owner
          : await readJson(join(resolve(options.dataRoot), 'data', 'server.json'));
      const gate = await verifyManagedTarget(
        {
          health: { pid: before.pid, instanceId: before.instanceId },
          owner: ownerRecord,
          port: options.port,
          dataRoot: options.dataRoot,
          resourceDir: options.resourceDir,
        },
        { ...statusDeps, stop: deps.stop },
      );
      if (!gate.ok) throw new Error('server_not_managed');
      const stopped = await (deps.stop || stopServer)({
        root: join(options.resourceDir, 'studio'),
        dataDir,
        expectedInstanceId: before.instanceId,
        beforeStop: async () => {
          // Fail closed on unreadable activity; re-verify OS plus port plus
          // process creation stability under the lock immediately before kill.
          const active = await (deps.activity || activity)(options.port);
          if (active && !options.force) throw new Error('agents_running');
          const regate = await verifyManagedTarget(
            {
              health: { pid: before.pid, instanceId: before.instanceId },
              owner: ownerRecord,
              port: options.port,
              dataRoot: options.dataRoot,
              resourceDir: options.resourceDir,
            },
            { ...statusDeps, stop: deps.stop },
          );
          if (!regate.ok) throw new Error('server_not_managed');
          if (gate.createdAt && regate.createdAt && gate.createdAt !== regate.createdAt) {
            throw new Error('server_not_managed');
          }
        },
      });
      if (!stopped.stopped && stopped.reason !== 'already-stopped') throw new Error('server_not_managed');
    } catch (error) {
      if (error.message === 'agents_running') return { restarted: false, reason: 'agents_running' };
      throw error;
    }
  } else if (before.ownership === 'recoverable') {
    try {
      await stopRecoverableServer(
        {
          port: options.port,
          dataRoot: options.dataRoot,
          resourceDir: options.resourceDir,
          expectedPid: before.pid,
          expectedInstanceId: before.instanceId,
          force: options.force,
        },
        statusDeps,
      );
    } catch (error) {
      if (error.message === 'agents_running' || error.code === 'agents_running') {
        return { restarted: false, reason: 'agents_running' };
      }
      throw error;
    }
  } else {
    throw new Error('server_not_managed');
  }
  emit('starting');
  const result = await (deps.start || startDesktop)(options);
  const after = await (deps.probe || probeHealth)(options.port);
  if (after.state !== 'ready' || after.health.version !== manifest.version || result.reused) {
    throw new Error('server_version_mismatch');
  }
  emit('ready', { version: after.health.version, pid: after.health.pid });
  return { ...result, restarted: true, version: after.health.version };
}

// Explicit Quit path for the tray menu: stop the verified server before the
// app closes. Same provenance and ownership gates as restart, no replacement
// or component prerequisite (stopping needs nothing ready). Never announces
// success on failure: errors throw, already-stopped and agents_running return
// explicit non success reasons.
export async function stopDesktop(options, deps = {}) {
  const emit = makeEmitter(options, deps);
  emit('checking');
  const statusDeps = { ...deps, resourceDir: options.resourceDir || deps.resourceDir };
  const before = await desktopServerStatus({ dataRoot: options.dataRoot, port: options.port }, statusDeps);
  if (!before.running) return { ...before, stopped: false, reason: 'already-stopped' };
  if (!before.canStop) throw new Error('server_not_managed');
  if (before.activeRuns && !options.force) return { ...before, stopped: false, reason: 'agents_running' };
  emit('stopping', { pid: before.pid, ownership: before.ownership });
  if (before.ownership === 'managed') {
    const dataDir = options.dataDir || join(resolve(options.dataRoot), 'data');
    const root = options.root || (options.resourceDir ? join(options.resourceDir, 'studio') : undefined);
    try {
      const ownerRecord =
        statusDeps.owner !== undefined
          ? statusDeps.owner
          : await readJson(join(resolve(options.dataRoot), 'data', 'server.json'));
      const gate = await verifyManagedTarget(
        {
          health: { pid: before.pid, instanceId: before.instanceId },
          owner: ownerRecord,
          port: options.port,
          dataRoot: options.dataRoot,
          resourceDir: options.resourceDir || statusDeps.resourceDir,
        },
        { ...statusDeps, stop: deps.stop },
      );
      if (!gate.ok) throw new Error('server_not_managed');
      const stopped = await (deps.stop || stopServer)({
        root,
        dataDir,
        expectedInstanceId: before.instanceId,
        beforeStop: async () => {
          const active = await (deps.activity || activity)(options.port);
          if (active && !options.force) throw new Error('agents_running');
          const regate = await verifyManagedTarget(
            {
              health: { pid: before.pid, instanceId: before.instanceId },
              owner: ownerRecord,
              port: options.port,
              dataRoot: options.dataRoot,
              resourceDir: options.resourceDir || statusDeps.resourceDir,
            },
            { ...statusDeps, stop: deps.stop },
          );
          if (!regate.ok) throw new Error('server_not_managed');
          if (gate.createdAt && regate.createdAt && gate.createdAt !== regate.createdAt) {
            throw new Error('server_not_managed');
          }
        },
      });
      if (!stopped.stopped && stopped.reason !== 'already-stopped') throw new Error('server_not_managed');
    } catch (error) {
      if (error.message === 'agents_running') return { stopped: false, reason: 'agents_running' };
      throw error;
    }
  } else if (before.ownership === 'recoverable') {
    try {
      const done = await stopRecoverableServer(
        {
          port: options.port,
          dataRoot: options.dataRoot,
          resourceDir: options.resourceDir || deps.resourceDir,
          expectedPid: before.pid,
          expectedInstanceId: before.instanceId,
          force: options.force,
        },
        statusDeps,
      );
      if (!done.stopped && done.reason !== 'already-stopped') throw new Error('server_not_managed');
    } catch (error) {
      if (error.message === 'agents_running' || error.code === 'agents_running') {
        return { stopped: false, reason: 'agents_running' };
      }
      throw error;
    }
  } else {
    throw new Error('server_not_managed');
  }
  const after = await (deps.probe || probeHealth)(options.port);
  if (after.state !== 'absent' && after.health?.instanceId === before.instanceId) {
    throw new Error('server_stop_failed');
  }
  emit('stopped', { pid: before.pid });
  return { ...before, stopped: true, running: false };
}

if (isDirectInvocation(import.meta.url)) {
  try {
    const options = JSON.parse(process.argv[2]);
    const useProgress = options.progress === true;
    const onProgress = useProgress ? undefined : undefined;
    // Progress lines are emitted inside restart/stop when options.progress is
    // true. The last stdout line is always the single result object so a Rust
    // parent can parse the final line as JSON.
    const result =
      options.action === 'status'
        ? await desktopServerStatus(options)
        : options.action === 'stop'
          ? await stopDesktop(options, { onProgress })
          : await restartDesktop(options, { onProgress });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
}
