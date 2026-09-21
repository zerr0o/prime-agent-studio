import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { desktopServerStatus, restartDesktop, stopDesktop } from '../scripts/desktop-control.mjs';
import {
  resolveOwnership,
  verifyServerProcess,
  verifyPortOwner,
} from '../scripts/desktop-server-identity.mjs';

// Isolation first: snapshot ambient prod marker readonly, then cleanse.
const AMBIENT_DATA_DIR = process.env.PRIME_AGENT_GUI_DATA_DIR;
const ambientPath = AMBIENT_DATA_DIR ? resolve(AMBIENT_DATA_DIR, 'server.json') : null;
let ambientExisted = false;
let ambientContent = null;
try {
  if (ambientPath && existsSync(ambientPath)) {
    ambientExisted = true;
    ambientContent = await readFile(ambientPath, 'utf8');
  }
} catch {}
for (const key of Object.keys(process.env)) {
  if (key.startsWith('PRIME_AGENT_') || key.startsWith('PRIME_STUDIO_') || key === 'NODE_OPTIONS') {
    delete process.env[key];
  }
}

async function assertAmbientUntouched() {
  if (!ambientPath) return;
  assert.equal(existsSync(ambientPath), ambientExisted, 'ambient prod marker untouched');
  if (ambientExisted) assert.equal(await readFile(ambientPath, 'utf8'), ambientContent);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-control-'));
  t.after(async () => {
    await assertAmbientUntouched();
    await rm(root, { recursive: true, force: true });
  });
  const dataRoot = join(root, 'user');
  const resourceDir = join(root, 'resources');
  await mkdir(join(dataRoot, 'data'), { recursive: true });
  await mkdir(join(resourceDir, 'studio', 'scripts'), { recursive: true });
  for (const p of ['node.exe', 'studio/server.mjs', 'studio/scripts/desktop-start.mjs']) {
    await writeFile(join(resourceDir, p), 'fixture');
  }
  await writeFile(
    join(resourceDir, 'desktop-resource.json'),
    JSON.stringify({ version: '2.9.3', identity: 'b'.repeat(64) }),
  );
  return { root, dataRoot, resourceDir, port: 47811 };
}

const HASH = 'c'.repeat(64);
function genFor(dataRoot) {
  return join(dataRoot, 'versions', HASH);
}
function osDepsFor(dataRoot, { portPid = 1234 } = {}) {
  const gen = genFor(dataRoot);
  const exe = join(gen, 'node.exe');
  const args = `"${exe}" "${join(gen, 'studio', 'server.mjs')}"`;
  return {
    processInfo: async () => ({ exe, args, createdAt: 'fixed-start' }),
    portOwner: async () => portPid,
    exists: async () => true,
    readFile: async () => JSON.stringify({ identity: HASH }),
  };
}

test('managed status keeps compat fields and canRestart true', async (t) => {
  const f = await fixture(t);
  const health = { pid: 1234, instanceId: 'owned-instance', version: '2.9.2' };
  await writeFile(join(f.dataRoot, 'data', 'server.json'), JSON.stringify({ ...health, port: f.port }));
  const status = await desktopServerStatus(
    { dataRoot: f.dataRoot, port: f.port },
    {
      probe: async () => ({ state: 'ready', health }),
      activity: async () => 0,
      resourceDir: f.resourceDir,
      ...osDepsFor(f.dataRoot),
    },
  );
  assert.equal(status.running, true);
  assert.equal(status.managed, true);
  assert.equal(status.ownership, 'managed');
  assert.equal(status.source, 'owner-file');
  assert.equal(status.canRestart, true);
  assert.equal(status.restartReason, null);
  assert.equal(status.canStop, true);
  assert.equal(status.stopReason, null);
  assert.equal(status.pid, 1234);
  await assertAmbientUntouched();
});

test('recoverable status when owner file is missing but OS verifies generation', async (t) => {
  const f = await fixture(t);
  const health = { pid: 26480, instanceId: 'live-instance', version: '3.7.0' };
  const status = await desktopServerStatus(
    { dataRoot: f.dataRoot, port: f.port },
    {
      probe: async () => ({ state: 'ready', health }),
      activity: async () => 0,
      owner: null,
      resourceDir: f.resourceDir,
      ...osDepsFor(f.dataRoot, { portPid: 26480 }),
    },
  );
  assert.equal(status.ownership, 'recoverable');
  assert.equal(status.managed, false);
  assert.equal(status.canRestart, true);
  assert.equal(status.restartReason, null);
  assert.equal(status.source, 'os-verified');
  // Status is readonly: no marker file created.
  assert.equal(existsSync(join(f.dataRoot, 'data', 'server.json')), false);
  await assertAmbientUntouched();
});

test('foreign process stays unverified and cannot restart', async (t) => {
  const f = await fixture(t);
  const health = { pid: 9999, instanceId: 'foreign', version: '9.9.9' };
  const status = await desktopServerStatus(
    { dataRoot: f.dataRoot, port: f.port },
    {
      probe: async () => ({ state: 'ready', health }),
      activity: async () => 0,
      owner: null,
      resourceDir: f.resourceDir,
      processInfo: async () => ({ exe: 'C:\\Windows\\System32\\other.exe', args: 'other.exe --serve' }),
      portOwner: async () => 9999,
      exists: async () => false,
    },
  );
  assert.equal(status.ownership, 'unverified');
  assert.equal(status.canRestart, false);
  assert.equal(status.restartReason, 'server_not_managed');
  assert.equal(status.canStop, false);
  await assert.rejects(
    restartDesktop(
      {
        resourceDir: f.resourceDir,
        dataRoot: f.dataRoot,
        port: f.port,
        force: true,
        allowUnconfigured: true,
      },
      {
        probe: async () => ({ state: 'ready', health }),
        activity: async () => 0,
        owner: null,
        resourceDir: f.resourceDir,
        processInfo: async () => ({ exe: 'C:\\Windows\\System32\\other.exe', args: 'other' }),
        portOwner: async () => 9999,
      },
    ),
    /server_not_managed/,
  );
  await assertAmbientUntouched();
});

test('invalid marker never falls back blindly to the health PID', async (t) => {
  const f = await fixture(t);
  const health = { pid: 26480, instanceId: 'live-instance', version: '3.7.0' };
  const badOwner = { pid: 'not-a-pid', port: f.port, instanceId: '' };
  const resolved = await resolveOwnership(
    { health, owner: badOwner, port: f.port, dataRoot: f.dataRoot, resourceDir: f.resourceDir },
    {
      ...osDepsFor(f.dataRoot, { portPid: 26480 }),
    },
  );
  assert.equal(resolved.ownership, 'unverified');
  assert.equal(resolved.source, 'invalid');
  assert.equal(resolved.reason, 'invalid-marker');
  await assertAmbientUntouched();
});

test('TCP port owner mismatch blocks recoverable', async (t) => {
  const f = await fixture(t);
  const health = { pid: 26480, instanceId: 'live-instance', version: '3.7.0' };
  const status = await desktopServerStatus(
    { dataRoot: f.dataRoot, port: f.port },
    {
      probe: async () => ({ state: 'ready', health }),
      activity: async () => 0,
      owner: null,
      resourceDir: f.resourceDir,
      ...osDepsFor(f.dataRoot, { portPid: 1111 }),
    },
  );
  assert.equal(status.ownership, 'unverified');
  assert.equal(status.canRestart, false);
  const check = await verifyPortOwner({ port: f.port, pid: 26480 }, { portOwner: async () => 1111 });
  assert.equal(check.ok, false);
  await assertAmbientUntouched();
});

test('restart recoverable respects agents_running and double checks before kill', async (t) => {
  const f = await fixture(t);
  const health = { pid: 26480, instanceId: 'live-instance', version: '2.9.2' };
  let active = 1;
  let kills = 0;
  let starts = 0;
  let down = false;
  const baseDeps = {
    probe: async () => (down ? { state: 'absent' } : { state: 'ready', health }),
    activity: async () => active,
    owner: null,
    resourceDir: f.resourceDir,
    ...osDepsFor(f.dataRoot, { portPid: 26480 }),
    kill: async (pid) => {
      assert.equal(pid, 26480);
      kills++;
      down = true;
    },
    start: async () => {
      starts++;
      down = false;
      health.version = '2.9.3';
      return { reused: false };
    },
    quickReceipt: async () => ({ ok: true }),
  };
  const held = await restartDesktop(
    { resourceDir: f.resourceDir, dataRoot: f.dataRoot, port: f.port, allowUnconfigured: true },
    baseDeps,
  );
  assert.equal(held.reason, 'agents_running');
  assert.equal(kills, 0);
  assert.equal(starts, 0);
  active = 0;
  const phases = [];
  const done = await restartDesktop(
    { resourceDir: f.resourceDir, dataRoot: f.dataRoot, port: f.port, force: true, allowUnconfigured: true },
    { ...baseDeps, onProgress: (e) => phases.push(e.phase) },
  );
  assert.equal(done.restarted, true);
  assert.equal(done.version, '2.9.3');
  assert.deepEqual(phases, ['checking', 'stopping', 'starting', 'ready']);
  assert.equal(kills, 1);
  assert.equal(starts, 1);
  await assertAmbientUntouched();
});

test('stopDesktop quits managed and recoverable, refuses foreign, keeps agents_running', async (t) => {
  const f = await fixture(t);
  const health = { pid: 4242, instanceId: 'owned-stop', version: '2.9.2' };
  await writeFile(join(f.dataRoot, 'data', 'server.json'), JSON.stringify({ ...health, port: f.port }));
  let stoppedCalls = 0;
  const managedBusy = await stopDesktop(
    { dataRoot: f.dataRoot, port: f.port },
    {
      probe: async () => ({ state: 'ready', health }),
      activity: async () => 2,
      owner: { ...health, port: f.port },
      ...osDepsFor(f.dataRoot, { portPid: health.pid }),
      stop: async (input) => {
        stoppedCalls++;
        await input.beforeStop();
        return { stopped: true };
      },
    },
  );
  assert.equal(managedBusy.stopped, false);
  assert.equal(managedBusy.reason, 'agents_running');
  assert.equal(stoppedCalls, 0);
  const managedOk = await stopDesktop(
    { dataRoot: f.dataRoot, port: f.port, force: true },
    {
      probe: (() => {
        let n = 0;
        return async () => (++n === 1 ? { state: 'ready', health } : { state: 'absent' });
      })(),
      activity: async () => 0,
      owner: { ...health, port: f.port },
      ...osDepsFor(f.dataRoot, { portPid: health.pid }),
      stop: async () => ({ stopped: true }),
    },
  );
  assert.equal(managedOk.stopped, true);
  // Recoverable stop uses targeted kill, no marker write.
  const rHealth = { pid: 26481, instanceId: 'rec-stop', version: '2.9.2' };
  const recPhases = [];
  const rec = await stopDesktop(
    { dataRoot: f.dataRoot, port: f.port + 1, resourceDir: f.resourceDir, force: true },
    {
      probe: (() => {
        let n = 0;
        return async () => (++n <= 3 ? { state: 'ready', health: rHealth } : { state: 'absent' });
      })(),
      activity: async () => 0,
      owner: null,
      resourceDir: f.resourceDir,
      ...osDepsFor(f.dataRoot, { portPid: 26481 }),
      kill: async () => {},
      onProgress: (e) => recPhases.push(e.phase),
    },
  );
  assert.equal(rec.stopped, true);
  assert.deepEqual(recPhases, ['checking', 'stopping', 'stopped']);
  await assert.rejects(
    stopDesktop(
      { dataRoot: f.dataRoot, port: f.port + 2, resourceDir: f.resourceDir, force: true },
      {
        probe: async () => ({ state: 'ready', health: { pid: 1, instanceId: 'x', version: '1' } }),
        activity: async () => 0,
        owner: null,
        resourceDir: f.resourceDir,
        processInfo: async () => ({ exe: '/sbin/init', args: 'init' }),
        portOwner: async () => 1,
      },
    ),
    /server_not_managed/,
  );
  const absent = await stopDesktop(
    { dataRoot: f.dataRoot, port: f.port + 3 },
    {
      probe: async () => ({ state: 'absent' }),
      activity: async () => 0,
    },
  );
  assert.equal(absent.stopped, false);
  assert.equal(absent.reason, 'already-stopped');
  await assertAmbientUntouched();
});

test('managed marker plus foreign OS process never kills', async (t) => {
  const f = await fixture(t);
  const health = { pid: 5555, instanceId: 'owned-5555', version: '2.9.2' };
  const owner = { ...health, port: f.port };
  await writeFile(join(f.dataRoot, 'data', 'server.json'), JSON.stringify(owner));
  const strict = {
    probe: async () => ({ state: 'ready', health }),
    activity: async () => 0,
    owner,
    resourceDir: f.resourceDir,
    processInfo: async () => ({
      exe: 'C:\\Windows\\System32\\evil.exe',
      args: 'evil.exe',
      createdAt: '2026-01-01',
    }),
    portOwner: async () => 5555,
    exists: async () => true,
    readFile: async () => JSON.stringify({ identity: 'c'.repeat(64) }),
  };
  await assert.rejects(
    restartDesktop(
      {
        resourceDir: f.resourceDir,
        dataRoot: f.dataRoot,
        port: f.port,
        force: true,
        allowUnconfigured: true,
      },
      { ...strict, stop: async () => ({ stopped: true }), start: async () => ({ reused: false }) },
    ),
    /server_not_managed/,
  );
  await assert.rejects(
    stopDesktop(
      { dataRoot: f.dataRoot, port: f.port, resourceDir: f.resourceDir, force: true },
      { ...strict, stop: async () => ({ stopped: true }) },
    ),
    /server_not_managed/,
  );
  await assertAmbientUntouched();
});

test('managed marker plus TCP port owner mismatch never kills', async (t) => {
  const f = await fixture(t);
  const health = { pid: 5556, instanceId: 'owned-5556', version: '2.9.2' };
  const owner = { ...health, port: f.port };
  const gen = join(f.dataRoot, 'versions', 'c'.repeat(64));
  const exe = join(gen, 'node.exe');
  const strict = {
    probe: async () => ({ state: 'ready', health }),
    activity: async () => 0,
    owner,
    resourceDir: f.resourceDir,
    processInfo: async () => ({
      exe,
      args: `${exe} ${join(gen, 'studio', 'server.mjs')}`,
      createdAt: '2026-01-01',
    }),
    portOwner: async () => 9999,
    exists: async () => true,
    readFile: async () => JSON.stringify({ identity: 'c'.repeat(64) }),
  };
  await assert.rejects(
    stopDesktop(
      { dataRoot: f.dataRoot, port: f.port, resourceDir: f.resourceDir, force: true },
      { ...strict, stop: async () => ({ stopped: true }) },
    ),
    /server_not_managed/,
  );
  await assertAmbientUntouched();
});

test('PID reuse with identical declaratives but new OS process blocks the kill', async (t) => {
  const f = await fixture(t);
  const health = { pid: 26480, instanceId: 'live-instance', version: '2.9.2' };
  const gen = join(f.dataRoot, 'versions', 'c'.repeat(64));
  const exe = join(gen, 'node.exe');
  let calls = 0;
  const reuseDeps = {
    probe: async () => ({ state: 'ready', health }),
    activity: async () => 0,
    owner: null,
    resourceDir: f.resourceDir,
    processInfo: async () => ({
      exe,
      args: `${exe} ${join(gen, 'studio', 'server.mjs')}`,
      createdAt: `2026-01-0${++calls}`,
    }),
    portOwner: async () => 26480,
    exists: async () => true,
    readFile: async () => JSON.stringify({ identity: 'c'.repeat(64) }),
    kill: async () => {
      throw new Error('kill must not run on reused PID');
    },
    start: async () => ({ reused: false }),
    quickReceipt: async () => ({ ok: true }),
  };
  await assert.rejects(
    restartDesktop(
      {
        resourceDir: f.resourceDir,
        dataRoot: f.dataRoot,
        port: f.port,
        force: true,
        allowUnconfigured: true,
      },
      reuseDeps,
    ),
    /server_not_managed/,
  );
  assert.ok(calls >= 2, 'double OS verification must run');
  await assertAmbientUntouched();
});

test('unreadable activity fails closed, never defaults to zero', async (t) => {
  const f = await fixture(t);
  const health = { pid: 1234, instanceId: 'owned-instance', version: '2.9.2' };
  const owner = { ...health, port: f.port };
  await assert.rejects(
    desktopServerStatus(
      { dataRoot: f.dataRoot, port: f.port },
      {
        probe: async () => ({ state: 'ready', health }),
        activity: async () => {
          throw new Error('unavailable');
        },
        owner,
        resourceDir: f.resourceDir,
      },
    ),
    /unavailable/,
  );
  await assert.rejects(
    restartDesktop(
      {
        resourceDir: f.resourceDir,
        dataRoot: f.dataRoot,
        port: f.port,
        force: true,
        allowUnconfigured: true,
      },
      {
        probe: async () => ({ state: 'ready', health }),
        activity: async () => {
          throw new Error('unavailable');
        },
        owner,
        resourceDir: f.resourceDir,
        stop: async () => ({ stopped: true }),
        start: async () => ({ reused: false }),
      },
    ),
    /unavailable/,
  );
  await assert.rejects(
    stopDesktop(
      { dataRoot: f.dataRoot, port: f.port, force: true },
      {
        probe: async () => ({ state: 'ready', health }),
        activity: async () => {
          throw new Error('unavailable');
        },
        owner,
      },
    ),
    /unavailable/,
  );
  await assertAmbientUntouched();
});

test('invalid marker never kills via restart or stop even when OS looks fine', async (t) => {
  const f = await fixture(t);
  const health = { pid: 26480, instanceId: 'live-instance', version: '2.9.2' };
  const badOwner = { pid: 'not-a-pid', port: f.port, instanceId: '' };
  const deps = {
    probe: async () => ({ state: 'ready', health }),
    activity: async () => 0,
    owner: badOwner,
    resourceDir: f.resourceDir,
    ...osDepsFor(f.dataRoot, { portPid: 26480 }),
    stop: async () => ({ stopped: true }),
    start: async () => ({ reused: false }),
    quickReceipt: async () => ({ ok: true }),
    kill: async () => {
      throw new Error('kill must not run on invalid marker');
    },
  };
  await assert.rejects(
    restartDesktop(
      {
        resourceDir: f.resourceDir,
        dataRoot: f.dataRoot,
        port: f.port,
        force: true,
        allowUnconfigured: true,
      },
      deps,
    ),
    /server_not_managed/,
  );
  await assert.rejects(
    stopDesktop({ dataRoot: f.dataRoot, port: f.port, resourceDir: f.resourceDir, force: true }, deps),
    /server_not_managed/,
  );
  await assertAmbientUntouched();
});

test('absent server stop is not an error: shell may treat already-stopped as Quit success', async (t) => {
  const f = await fixture(t);
  const result = await stopDesktop(
    { dataRoot: f.dataRoot, port: f.port + 9 },
    {
      probe: async () => ({ state: 'absent' }),
      activity: async () => 0,
    },
  );
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'already-stopped');
  assert.equal(result.running, false);
  const shellQuitOk = result.stopped === true || result.reason === 'already-stopped';
  assert.equal(shellQuitOk, true);
  await assertAmbientUntouched();
});

test('unknown TCP ownership never authorizes status or a stop, even with a marker', async (t) => {
  const f = await fixture(t);
  const health = { pid: 1234, instanceId: 'proof', version: '3.7.1' };
  for (const owner of [null, { ...health, port: f.port }]) {
    let killed = false;
    const deps = {
      ...osDepsFor(f.dataRoot),
      owner,
      probe: async () => ({ state: 'ready', health }),
      activity: async () => 0,
      portOwner: async () => null,
      kill: async () => {
        killed = true;
      },
      stop: async () => {
        killed = true;
      },
    };
    const s = await desktopServerStatus(f, deps);
    assert.equal(s.canStop, false);
    assert.equal(s.canRestart, false);
    await assert.rejects(stopDesktop({ ...f, force: true }, deps), /server_not_managed/);
    assert.equal(killed, false);
  }
});
test('an arbitrary script cannot borrow the Studio node executable or script substring', async (t) => {
  const f = await fixture(t);
  const gen = genFor(f.dataRoot),
    exe = join(gen, 'node.exe');
  for (const args of [
    `"${exe}" "C:/foreign/studio/server.mjs"`,
    `"${exe}" --eval "console.log('studio/server.mjs')"`,
    `"${exe}" "${join(gen, 'studio/server.mjs')}.evil"`,
    `"${exe}" "${join(gen, 'studio/server.mjs')}" --foreign`,
  ]) {
    const result = await verifyServerProcess(
      { pid: 1234, ...f },
      {
        ...osDepsFor(f.dataRoot),
        processInfo: async () => ({ exe, args, createdAt: 'fixed' }),
      },
    );
    assert.equal(result.verified, false, args);
  }
});
test('ready receipt must actually match the generation directory', async (t) => {
  const f = await fixture(t);
  const result = await verifyServerProcess(
    { pid: 1234, ...f },
    {
      ...osDepsFor(f.dataRoot),
      readFile: async () => JSON.stringify({ identity: 'a'.repeat(64) }),
    },
  );
  assert.equal(result.verified, false);
});
