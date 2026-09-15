import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { desktopServerStatus, restartDesktop } from '../scripts/desktop-control.mjs';
import { startDesktop } from '../scripts/desktop-start.mjs';
import { stopServer } from '../scripts/stop-server.mjs';
import { probeHealth } from '../scripts/launcher-common.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-restart-'));
  const cleanup = {};
  t.after(async () => {
    await cleanup.before?.();
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  // Real detached restart tests restart mechanics, not the cheap receipt gate:
  // bypass components_required explicitly (like Later/background).
  const options = {
    dataRoot: join(root, 'user'),
    resourceDir: join(root, 'resources'),
    port: 9999,
    allowUnconfigured: true,
  };
  await mkdir(join(options.dataRoot, 'data'), { recursive: true });
  await mkdir(join(options.resourceDir, 'studio', 'scripts'), { recursive: true });
  await Promise.all(
    ['node.exe', 'studio/server.mjs', 'studio/scripts/desktop-start.mjs'].map((path) =>
      writeFile(join(options.resourceDir, path), 'fixture'),
    ),
  );
  await writeFile(
    join(options.resourceDir, 'desktop-resource.json'),
    JSON.stringify({ version: '2.9.3', identity: 'b'.repeat(64) }),
  );
  const health = { pid: 1234, instanceId: 'owned-instance', version: '2.9.2' };
  await writeFile(
    join(options.dataRoot, 'data', 'server.json'),
    JSON.stringify({ ...health, port: options.port }),
  );
  let active = 0,
    stopped = 0,
    started = 0;
  const deps = {
    probe: async () => ({ state: 'ready', health }),
    activity: async () => active,
    stop: async (input) => {
      assert.equal(input.dataDir, join(options.dataRoot, 'data'));
      assert.equal(input.expectedInstanceId, health.instanceId);
      await input.beforeStop(health);
      stopped++;
      return { stopped: true };
    },
    start: async () => {
      started++;
      health.version = '2.9.3';
      return { reused: false };
    },
  };
  return { options, deps, health, cleanup, setActive: (n) => (active = n), counts: () => [stopped, started] };
}
test('desktop restart changes the owned idle server to the bundled version', async (t) => {
  const f = await fixture(t);
  assert.equal((await desktopServerStatus(f.options, f.deps)).managed, true);
  assert.equal((await restartDesktop(f.options, f.deps)).version, '2.9.3');
  assert.deepEqual(f.counts(), [1, 1]);
});
test('busy agents need confirmation and are rechecked immediately before stop', async (t) => {
  const f = await fixture(t);
  f.setActive(1);
  assert.equal((await restartDesktop(f.options, f.deps)).reason, 'agents_running');
  assert.deepEqual(f.counts(), [0, 0]);
  f.setActive(0);
  let checks = 0;
  f.deps.activity = async () => (checks++ ? 1 : 0);
  assert.equal((await restartDesktop(f.options, f.deps)).reason, 'agents_running');
  assert.deepEqual(f.counts(), [0, 0]);
  assert.equal((await restartDesktop({ ...f.options, force: true }, f.deps)).restarted, true);
  assert.deepEqual(f.counts(), [1, 1]);
});
test('ownership changes and unreadable activity never authorize a stop', async (t) => {
  const f = await fixture(t);
  f.health.instanceId = 'different-instance';
  await assert.rejects(restartDesktop({ ...f.options, force: true }, f.deps), /server_not_managed/);
  f.health.instanceId = 'owned-instance';
  f.deps.activity = async () => {
    throw new Error('unavailable');
  };
  await assert.rejects(restartDesktop({ ...f.options, force: true }, f.deps), /unavailable/);
  assert.deepEqual(f.counts(), [0, 0]);
});
test('restart does not accept a reused or incorrect server as success', async (t) => {
  const f = await fixture(t);
  f.deps.start = async () => ({ reused: true });
  await assert.rejects(restartDesktop(f.options, f.deps), /server_version_mismatch/);
});

test('real detached restart preserves workspace data and changes resource generation', async (t) => {
  const f = await fixture(t),
    reservation = createServer();
  await new Promise((done) => reservation.listen(0, '127.0.0.1', done));
  f.options.port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const dataDir = join(f.options.dataRoot, 'data');
  f.cleanup.before = async () => {
    await stopServer({ root: join(f.options.resourceDir, 'studio'), dataDir });
  };
  const workspace = '{"projects":[{"cwd":"C:/fixture"}],"readReceipts":{"session":"answer"}}';
  await writeFile(join(dataDir, 'workspace.json'), workspace);
  await copyFile(process.execPath, join(f.options.resourceDir, 'node.exe'));
  const prepare = async (version, identity) => {
    await writeFile(
      join(f.options.resourceDir, 'desktop-resource.json'),
      JSON.stringify({ version, identity: identity.repeat(64) }),
    );
    await writeFile(
      join(f.options.resourceDir, 'studio', 'server.mjs'),
      `
      import { createServer } from 'node:http';
      import { existsSync } from 'node:fs';
      import { join } from 'node:path';
      createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url === '/api/runs'
          ? { runs: existsSync(join(process.env.PRIME_AGENT_GUI_DATA_DIR, 'busy')) ? [{status:'running'}] : [] }
          : { service:'prime-agent-gui', status:'ok', version:${JSON.stringify(version)}, pid:process.pid, instanceId:process.env.PRIME_AGENT_GUI_INSTANCE }));
      }).listen(Number(process.env.PORT), '127.0.0.1');
    `,
    );
  };
  await prepare('2.9.2', 'c');
  await startDesktop(f.options);
  const before = await probeHealth(f.options.port);
  await prepare('2.9.3', 'd');
  await writeFile(join(dataDir, 'busy'), 'synthetic run');
  assert.equal((await restartDesktop(f.options)).reason, 'agents_running');
  assert.equal((await probeHealth(f.options.port)).health.pid, before.health.pid);
  const result = await restartDesktop({ ...f.options, force: true });
  assert.equal(result.version, '2.9.3');
  assert.notEqual((await probeHealth(f.options.port)).health.pid, before.health.pid);
  assert.equal(await readFile(join(dataDir, 'workspace.json'), 'utf8'), workspace);
});
