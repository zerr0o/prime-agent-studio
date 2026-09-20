import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { runComponents, recordComponentFailure } from '../scripts/desktop-components.mjs';
import { COMPONENT_POLICY } from '../lib/desktop-components.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-pipeline-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 4 });
  });
  const dataRoot = join(root, 'user');
  const resourceDir = join(root, 'resources');
  await mkdir(join(dataRoot, 'engine'), { recursive: true });
  await mkdir(join(resourceDir, 'studio'), { recursive: true });
  return { root, dataRoot, resourceDir };
}

async function writeInstallation(dataRoot, opts) {
  const engineVersion = (opts && opts.engineVersion) || COMPONENT_POLICY.engine;
  const shellValidated = !opts || opts.shellValidated !== false;
  const enginePath = join(dataRoot, 'engine', 'prime-agent', 'cli.js');
  const pythonPath = join(dataRoot, 'engine', 'python', 'python.exe');
  const value = {
    schema: 1,
    validatedAt: new Date().toISOString(),
    shellValidated,
    components: {
      engine: { path: enginePath, packageDir: join(dataRoot, 'engine', 'prime-agent'), version: engineVersion },
      python: { path: pythonPath },
    },
  };
  await writeFile(join(dataRoot, 'engine', 'installation.json'), JSON.stringify(value));
  return value;
}

async function writeResource(resourceDir, opts) {
  const version = (opts && opts.version) || '9.9.9';
  const identity = (opts && opts.identity) || 'a'.repeat(64);
  await writeFile(join(resourceDir, 'desktop-resource.json'), JSON.stringify({ version, identity }));
}

function readyDiagnose(dataRoot, engineVersion) {
  const v = engineVersion || COMPONENT_POLICY.engine;
  const enginePath = join(dataRoot, 'engine', 'prime-agent', 'cli.js');
  const pythonPath = join(dataRoot, 'engine', 'python', 'python.exe');
  return {
    ready: true,
    components: {
      engine: { status: 'ready', path: enginePath, packageDir: join(dataRoot, 'engine', 'prime-agent'), version: v },
      python: { status: 'ready', path: pythonPath },
      bash: { status: 'ready', path: 'C:\\Program Files\\Git\\bin\\bash.exe' },
    },
  };
}

const fetchRuntime = (version, available) => async () => ({
  ok: true,
  json: async () => ({ available: available !== false, version }),
});

const fetchNotOk = () => async () => ({ ok: false, json: async () => ({}) });

function seqServerStatus(queue, calls) {
  return async (options) => {
    calls.push({ dataRoot: options.dataRoot, port: options.port });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return { ...next };
  };
}
test('status is read-only: quickReceipt plus disk plus server plus version only, never prepare or diagnose', async (t) => {
  const f = await fixture(t);
  const installed = await writeInstallation(f.dataRoot, {});
  await writeResource(f.resourceDir, { version: '9.9.9' });
  const calls = { prepare: 0, diagnose: 0, fetches: [] };
  const serverStatusCalls = [];
  const deps = {
    prepare: async () => { calls.prepare++; throw new Error('must_not_prepare'); },
    diagnose: async () => { calls.diagnose++; throw new Error('must_not_diagnose'); },
    quickReceipt: async (options) => {
      assert.equal(options.dataRoot, f.dataRoot);
      return { ok: true };
    },
    serverStatus: seqServerStatus(
      [{ running: true, managed: true, activeRuns: 0, version: '9.9.9' }],
      serverStatusCalls,
    ),
    fetch: async (url, init) => {
      calls.fetches.push(url);
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/api\/version$/);
      assert.ok(init && init.signal, 'version fetch is bounded');
      return { ok: true, json: async () => ({ available: true, version: COMPONENT_POLICY.engine }) };
    },
  };
  const options = { action: 'status', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32101 };
  const result = await runComponents(options, {}, deps);
  assert.equal(calls.prepare, 0);
  assert.equal(calls.diagnose, 0);
  assert.equal(result.ready, true);
  assert.equal(result.requiredEngine, COMPONENT_POLICY.engine);
  assert.equal(result.installedEngine, installed.components.engine.version);
  assert.equal(result.appVersion, '9.9.9');
  assert.equal(result.needsUpdate, false);
  assert.equal(result.server.engineVersion, COMPONENT_POLICY.engine);
  assert.equal(result.server.engineAvailable, true);
  assert.equal(result.serverUpdatePending, false);
  assert.equal(result.needsRestart, false);
  for (const info of Object.values(result.components)) assert.equal(info.status, 'ready');
  assert.ok(serverStatusCalls.length >= 1, 'status checks the live server');
  assert.equal(calls.fetches.length, 1);
});

test('status reports pending plus needsUpdate when the receipt is stale; no version fetch when down', async (t) => {
  const f = await fixture(t);
  await writeInstallation(f.dataRoot, { engineVersion: '0.9.4' });
  await writeResource(f.resourceDir, { version: '9.9.9' });
  let fetches = 0;
  const deps = {
    prepare: async () => { throw new Error('must_not_prepare'); },
    diagnose: async () => { throw new Error('must_not_diagnose'); },
    quickReceipt: async () => ({ ok: false, reason: 'version_changed' }),
    serverStatus: async () => ({ running: false, managed: true, activeRuns: 0 }),
    fetch: async () => { fetches++; throw new Error('must_not_fetch_when_down'); },
  };
  const result = await runComponents(
    { action: 'status', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32102 },
    {},
    deps,
  );
  assert.equal(result.ready, false);
  assert.equal(result.receiptReason, 'version_changed');
  assert.equal(result.needsUpdate, true);
  assert.equal(result.installedEngine, '0.9.4');
  assert.equal(result.requiredEngine, COMPONENT_POLICY.engine);
  assert.equal(result.needsRestart, false);
  for (const info of Object.values(result.components)) assert.equal(info.status, 'pending');
  assert.equal(fetches, 0);
});

test('install with old live runtime engine fails activation and keeps ready components', async (t) => {
  const f = await fixture(t);
  await writeInstallation(f.dataRoot, {});
  await writeResource(f.resourceDir, { version: '9.9.9' });
  const progress = [];
  const serverStatusCalls = [];
  let restarts = 0;
  const deps = {
    prepare: async () => readyDiagnose(f.dataRoot),
    diagnose: async () => { throw new Error('install_must_use_prepare'); },
    serverStatus: seqServerStatus(
      [
        { running: true, managed: true, activeRuns: 0, version: '9.9.9' },
        { running: true, managed: true, activeRuns: 0, version: '9.9.9' },
        { running: true, managed: true, activeRuns: 0, version: '9.9.9' },
        { running: true, managed: true, activeRuns: 0, version: '9.9.9' },
      ],
      serverStatusCalls,
    ),
    restart: async (options) => {
      restarts++;
      assert.equal(options.force, false);
      return { restarted: true };
    },
    fetch: fetchRuntime('0.9.4', true),
  };
  const result = await runComponents(
    { action: 'install', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32103 },
    { onProgress: (e) => progress.push(e) },
    deps,
  );
  assert.equal(result.ready, true);
  assert.ok(result.components.engine, 'validated details preserved');
  assert.equal(result.activation, 'failed');
  assert.equal(result.activationError, 'server_validation_failed');
  assert.ok(progress.some((e) => e.component === 'studio' && e.stage === 'error' && e.error === 'server_validation_failed'));
  assert.equal(restarts, 1);
  assert.ok(serverStatusCalls.length >= 3, 'server rechecked around activation');
});

test('install fails closed when the runtime engine is unavailable', async (t) => {
  const f = await fixture(t);
  await writeInstallation(f.dataRoot, {});
  await writeResource(f.resourceDir, { version: '9.9.9' });
  const deps = {
    prepare: async () => readyDiagnose(f.dataRoot),
    serverStatus: async () => ({ running: true, managed: true, activeRuns: 0, version: '9.9.9' }),
    restart: async () => ({ restarted: true }),
    fetch: fetchRuntime(COMPONENT_POLICY.engine, false),
  };
  const result = await runComponents(
    { action: 'install', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32104 },
    {},
    deps,
  );
  assert.equal(result.ready, true);
  assert.equal(result.activation, 'failed');
  assert.equal(result.activationError, 'server_validation_failed');
});

test('install requires an exact runtime engine match', async (t) => {
  const f = await fixture(t);
  await writeInstallation(f.dataRoot, {});
  await writeResource(f.resourceDir, { version: '9.9.9' });
  const deps = {
    prepare: async () => readyDiagnose(f.dataRoot),
    serverStatus: async () => ({ running: true, managed: true, activeRuns: 0, version: '9.9.9' }),
    restart: async () => ({ restarted: true }),
    fetch: fetchRuntime(COMPONENT_POLICY.engine + '-hotfix', true),
  };
  const result = await runComponents(
    { action: 'install', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32105 },
    {},
    deps,
  );
  assert.equal(result.activation, 'failed');
  assert.equal(result.activationError, 'server_validation_failed');
});
test('restart version mismatch returns failed activation, never a masked install failure', async (t) => {
  const f = await fixture(t);
  await writeInstallation(f.dataRoot, {});
  await writeResource(f.resourceDir, { version: '9.9.9' });
  const progress = [];
  const deps = {
    prepare: async () => readyDiagnose(f.dataRoot),
    serverStatus: async () => ({ running: true, managed: true, activeRuns: 0, version: '9.9.8' }),
    restart: async () => { throw new Error('server_version_mismatch'); },
    fetch: fetchRuntime(COMPONENT_POLICY.engine, true),
  };
  const result = await runComponents(
    { action: 'install', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32106 },
    { onProgress: (e) => progress.push(e) },
    deps,
  );
  assert.equal(result.ready, true);
  assert.equal(result.activation, 'failed');
  assert.equal(result.activationError, 'server_version_mismatch');
  assert.ok(progress.some((e) => e.component === 'studio' && e.stage === 'error'));
});

test('agents starting between prepare and activation defer without stopping the server', async (t) => {
  const f = await fixture(t);
  await writeInstallation(f.dataRoot, {});
  await writeResource(f.resourceDir, { version: '9.9.9' });
  const serverStatusCalls = [];
  let restarts = 0;
  const queue = [
    { running: true, managed: true, activeRuns: 0, version: '9.9.9' },
    { running: true, managed: true, activeRuns: 0, version: '9.9.9' },
    { running: true, managed: true, activeRuns: 2, version: '9.9.9' },
    { running: true, managed: true, activeRuns: 2, version: '9.9.9' },
  ];
  const deps = {
    prepare: async () => readyDiagnose(f.dataRoot),
    serverStatus: seqServerStatus(queue, serverStatusCalls),
    restart: async () => { restarts++; return { restarted: true }; },
    fetch: fetchRuntime(COMPONENT_POLICY.engine, true),
  };
  const result = await runComponents(
    { action: 'install', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32107 },
    {},
    deps,
  );
  assert.equal(result.ready, true);
  assert.equal(result.activation, 'deferred');
  assert.equal(result.activationReason, 'agents_running');
  assert.equal(restarts, 0);
  assert.ok(serverStatusCalls.length >= 3, 'ownership plus activity rechecked after prepare');
});

test('restart deferring on agents_running preserves ready components', async (t) => {
  const f = await fixture(t);
  await writeInstallation(f.dataRoot, {});
  await writeResource(f.resourceDir, { version: '9.9.9' });
  const deps = {
    prepare: async () => readyDiagnose(f.dataRoot),
    serverStatus: async () => ({ running: true, managed: true, activeRuns: 0, version: '9.9.9' }),
    restart: async () => ({ restarted: false, reason: 'agents_running' }),
    fetch: fetchRuntime(COMPONENT_POLICY.engine, true),
  };
  const result = await runComponents(
    { action: 'install', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32108 },
    {},
    deps,
  );
  assert.equal(result.ready, true);
  assert.equal(result.activation, 'deferred');
  assert.equal(result.activationReason, 'agents_running');
});

test('unmanaged live server defers activation and never restarts', async (t) => {
  const f = await fixture(t);
  await writeInstallation(f.dataRoot, {});
  await writeResource(f.resourceDir, { version: '9.9.9' });
  let restarts = 0;
  const deps = {
    prepare: async () => readyDiagnose(f.dataRoot),
    serverStatus: async () => ({ running: true, managed: false, activeRuns: 0, version: '9.9.9' }),
    restart: async () => { restarts++; return { restarted: true }; },
    fetch: fetchRuntime(COMPONENT_POLICY.engine, true),
  };
  const result = await runComponents(
    { action: 'install', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32109 },
    {},
    deps,
  );
  assert.equal(result.ready, true);
  assert.equal(result.activation, 'deferred');
  assert.equal(result.activationReason, 'server_not_managed');
  assert.equal(restarts, 0);
});

test('explicit force true is overridden to force false for activation restarts', async (t) => {
  const f = await fixture(t);
  await writeInstallation(f.dataRoot, {});
  await writeResource(f.resourceDir, { version: '9.9.9' });
  let seenForce;
  const deps = {
    prepare: async () => readyDiagnose(f.dataRoot),
    serverStatus: async () => ({ running: true, managed: true, activeRuns: 0, version: '9.9.9' }),
    restart: async (options) => {
      seenForce = options.force;
      return { restarted: true };
    },
    fetch: fetchRuntime(COMPONENT_POLICY.engine, true),
  };
  const result = await runComponents(
    { action: 'install', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32110, force: true },
    {},
    deps,
  );
  assert.equal(seenForce, false);
  assert.equal(result.activation, 'active');
  assert.equal(result.needsRestart, false);
});

test('install preparation failure throws unmasked with no restart', async (t) => {
  const f = await fixture(t);
  await writeInstallation(f.dataRoot, {});
  await writeResource(f.resourceDir, { version: '9.9.9' });
  let restarts = 0;
  const deps = {
    prepare: async () => { throw new Error('disk_full'); },
    serverStatus: async () => { throw new Error('must_not_check_server_after_prepare_throw'); },
    restart: async () => { restarts++; return { restarted: true }; },
    fetch: async () => { throw new Error('must_not_validate_after_prepare_throw'); },
  };
  await assert.rejects(
    runComponents(
      { action: 'install', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32111 },
      {},
      deps,
    ),
    /disk_full/,
  );
  assert.equal(restarts, 0);
});
test('legacy activate records a validated choice and never restarts, even with a stale server', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.dataRoot, 'engine', 'installation.json'),
    JSON.stringify({
      schema: 1,
      validatedAt: '2020-01-01T00:00:00.000Z',
      shellValidated: false,
      components: { engine: { path: 'old', version: '0.9.4' }, python: { path: 'old-python' } },
    }),
  );
  await writeResource(f.resourceDir, { version: '9.9.9' });
  const fresh = readyDiagnose(f.dataRoot);
  let restarts = 0;
  const deps = {
    diagnose: async () => ({ ...fresh }),
    prepare: async () => { throw new Error('activate_must_not_prepare'); },
    serverStatus: async () => ({ running: true, managed: true, activeRuns: 0, version: '9.9.8' }),
    restart: async () => { restarts++; return { restarted: true }; },
    fetch: fetchRuntime('0.9.4', true),
  };
  const result = await runComponents(
    { action: 'activate', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32112 },
    {},
    deps,
  );
  assert.equal(result.ready, true);
  assert.equal(result.activation, undefined);
  assert.equal(restarts, 0);
  assert.equal(result.serverUpdatePending, true);
  assert.equal(result.needsRestart, true);
  const recorded = JSON.parse(await readFile(join(f.dataRoot, 'engine', 'installation.json'), 'utf8'));
  assert.equal(recorded.shellValidated, true);
  assert.equal(recorded.components.engine.path, fresh.components.engine.path);
  assert.equal(recorded.components.python.path, fresh.components.python.path);
  assert.equal(recorded.schema, 1);
});

test('activate skips the receipt rewrite when the recorded choice already matches', async (t) => {
  const f = await fixture(t);
  const fresh = readyDiagnose(f.dataRoot);
  await writeFile(
    join(f.dataRoot, 'engine', 'installation.json'),
    JSON.stringify({
      schema: 1,
      validatedAt: '2024-05-05T05:05:05.000Z',
      shellValidated: true,
      components: {
        engine: { path: fresh.components.engine.path, version: COMPONENT_POLICY.engine },
        python: { path: fresh.components.python.path },
      },
    }),
  );
  await writeResource(f.resourceDir, { version: '9.9.9' });
  const deps = {
    diagnose: async () => ({ ...fresh }),
    serverStatus: async () => ({ running: false, managed: true, activeRuns: 0 }),
    restart: async () => { throw new Error('activate_must_not_restart'); },
    fetch: async () => { throw new Error('must_not_fetch_when_down'); },
  };
  const before = await readFile(join(f.dataRoot, 'engine', 'installation.json'), 'utf8');
  const result = await runComponents(
    { action: 'activate', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32113 },
    {},
    deps,
  );
  assert.equal(result.ready, true);
  assert.equal(await readFile(join(f.dataRoot, 'engine', 'installation.json'), 'utf8'), before);
});

test('apply retries validation without redownload, then activates', async (t) => {
  const f = await fixture(t);
  await writeInstallation(f.dataRoot, {});
  await writeResource(f.resourceDir, { version: '9.9.9' });
  const progress = [];
  let prepares = 0;
  let diagnoses = 0;
  const deps = {
    prepare: async () => { prepares++; throw new Error('apply_must_not_redownload'); },
    diagnose: async () => { diagnoses++; return readyDiagnose(f.dataRoot); },
    serverStatus: async () => ({ running: true, managed: true, activeRuns: 0, version: '9.9.9' }),
    restart: async (options) => {
      assert.equal(options.force, false);
      return { restarted: true };
    },
    fetch: fetchRuntime(COMPONENT_POLICY.engine, true),
  };
  const result = await runComponents(
    { action: 'apply', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32114 },
    { onProgress: (e) => progress.push(e) },
    deps,
  );
  assert.equal(prepares, 0);
  assert.equal(diagnoses, 1);
  assert.equal(result.ready, true);
  assert.equal(result.activation, 'active');
  assert.equal(result.needsRestart, false);
  assert.ok(progress.some((e) => e.component === 'studio' && e.stage === 'opening'));
});

test('install surfaces a pending server update before a long preparation', async (t) => {
  const f = await fixture(t);
  await writeInstallation(f.dataRoot, { engineVersion: '0.9.4' });
  await writeResource(f.resourceDir, { version: '9.9.9' });
  const progress = [];
  const deps = {
    prepare: async () => readyDiagnose(f.dataRoot),
    serverStatus: async () => ({ running: true, managed: true, activeRuns: 0, version: '9.9.8' }),
    restart: async () => ({ restarted: true }),
    fetch: fetchRuntime(COMPONENT_POLICY.engine, true),
  };
  const result = await runComponents(
    { action: 'install', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32115 },
    { onProgress: (e) => progress.push(e) },
    deps,
  );
  assert.ok(progress.some((e) => e.component === 'studio' && e.stage === 'server_update_pending'));
  assert.equal(result.serverUpdatePending, true);
  assert.equal(result.appVersion, '9.9.9');
  assert.equal(result.activation, 'active');
});

test('unreadable version endpoint degrades the server detail instead of failing the status', async (t) => {
  const f = await fixture(t);
  await writeInstallation(f.dataRoot, {});
  await writeResource(f.resourceDir, { version: '9.9.9' });
  const deps = {
    quickReceipt: async () => ({ ok: true }),
    serverStatus: async () => ({ running: true, managed: true, activeRuns: 0, version: '9.9.9' }),
    fetch: fetchNotOk(),
  };
  const result = await runComponents(
    { action: 'status', dataRoot: f.dataRoot, resourceDir: f.resourceDir, port: 32116 },
    {},
    deps,
  );
  assert.equal(result.ready, true);
  assert.equal(result.server.error, 'server_validation_failed');
});

test('recordComponentFailure persists only allowlisted fields and never leaks stacks or secrets', async (t) => {
  const f = await fixture(t);
  await recordComponentFailure(f.dataRoot, { component: 'engine', error: 'disk_full', phase: 'preparation' });
  await recordComponentFailure(f.dataRoot, { component: 'evil;rm -rf', error: 'BOOM!! not-snake', phase: 'weird' });
  await recordComponentFailure(f.dataRoot, { component: 'studio', error: 'server_validation_failed', phase: 'activation' });
  const lines = (await readFile(join(f.dataRoot, 'engine/logs/components.log'), 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  const parsed = lines.map((line) => JSON.parse(line));
  const first = parsed[0];
  const second = parsed[1];
  const third = parsed[2];
  assert.equal(first.component, 'engine');
  assert.equal(first.error, 'disk_full');
  assert.equal(first.stage, 'error');
  assert.equal(first.phase, 'preparation');
  assert.ok(first.at && !Number.isNaN(Date.parse(first.at)));
  assert.deepEqual(Object.keys(first).sort(), ['at', 'component', 'error', 'phase', 'stage']);
  assert.equal(second.component, 'studio');
  assert.equal(second.error, 'preparation_failed');
  assert.equal(second.phase, 'preparation');
  assert.equal(third.phase, 'activation');
  assert.equal(third.error, 'server_validation_failed');
  const raw = lines.join('\n');
  assert.ok(!/Error:|secret|token|Bearer|PATH=/i.test(raw));
});
