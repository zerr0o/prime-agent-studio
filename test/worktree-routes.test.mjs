import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';
import { createWorktrees } from '../lib/worktrees.mjs';
import { createWorktreeRoutes } from '../lib/worktree-routes.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const exec = promisify(execFile);

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

async function git(cwd, args) {
  const { stdout } = await exec('git', args, {
    cwd,
    windowsHide: true,
    shell: false,
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
    env: gitEnv(),
  });
  return String(stdout);
}

async function initRepo(dir) {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.name', 'wt-routes-test']);
  await git(dir, ['config', 'user.email', 'wt-routes@test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await git(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(dir, 'app.txt'), 'v1\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'initial']);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

async function commitAll(cwd, message) {
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', message]);
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

async function expectCode(promise, code, status) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error?.code, code, `expected code ${code}, got ${error?.code}: ${error?.message}`);
    if (status !== undefined) assert.equal(error?.status, status, `expected status ${status}, got ${error?.status}`);
    return error;
  }
  assert.fail(`expected error code ${code}`);
}

async function expectStatus(promise, status) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error?.status, status, `expected status ${status}, got ${error?.status}: ${error?.message}`);
    return error;
  }
  assert.fail(`expected error status ${status}`);
}

function validSessionId() {
  return `s${randomUUID().replace(/-/g, '').slice(0, 15)}`;
}

async function writeSessionFile(sessionDir, id, cwd) {
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `${id}.jsonl`),
    `${JSON.stringify({ type: 'session', id, cwd, timestamp: new Date().toISOString() })}\n`,
    'utf8',
  );
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-wt-routes-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  const source = join(root, 'proj');
  const sessionDir = join(root, 'sessions');
  const dataDir = join(root, 'data');
  const agentHome = join(root, 'agent');
  await Promise.all([mkdir(source, { recursive: true }), mkdir(sessionDir, { recursive: true }), mkdir(dataDir, { recursive: true }), mkdir(agentHome, { recursive: true })]);
  const head = await initRepo(source);

  // Fake runtime for createApp: captures nothing real, no external APIs.
  const runtimeControls = [];
  const runtime = {
    async getStatus() {
      return { available: true, version: 'fixture', nodeVersion: process.versions.node };
    },
    async getModels() {
      return { models: [{ id: 'fixture/model', provider: 'fixture' }], default: { model: 'fixture/model' } };
    },
    async start(input) {
      const control = { input, events: [], cancelCalls: 0 };
      runtimeControls.push(control);
      return control;
    },
    async close() {},
  };

  const app = createApp({ agentHome, sessionDir, dataDir, initialCwd: source, runtime });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  await app.store.project({ cwd: source });

  // Production service + production routes adapter, shared dataDir/store.
  // Busy is controllable per test without stubbing the routes themselves.
  let busyService = false;
  const runsList = [];
  const busySessions = new Set();
  const launches = [];
  const worktrees = createWorktrees({ dataDir, isBusy: async () => busyService });
  async function fakeLaunch(input) {
    launches.push({ ...input });
    const sid = typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : validSessionId();
    if (!input.sessionId) {
      await writeSessionFile(sessionDir, sid, input.cwd);
    }
    // Simulate the runtime receiving the isolated task cwd + prompt.
    runtimeControls.push({ input: { cwd: input.cwd, message: input.message, model: input.model, sessionId: sid }, events: [] });
    return { id: `run-${sid.slice(0, 8)}`, sessionId: sid, cwd: input.cwd, status: 'running', message: input.message, model: input.model };
  }
  const routes = createWorktreeRoutes({
    store: app.store,
    worktrees,
    dataDir,
    activeRuns: () => [...runsList],
    sessionBusy: (id) => busySessions.has(id),
    startRun: fakeLaunch,
  });

  const gateways = [];
  async function gateway() {
    const salt = 'b'.repeat(32);
    const code = '12345678';
    const server = createLanGateway({
      host: '127.0.0.1',
      upstreamPort: port,
      config: { salt, codeHash: hashAccessCode(code, salt), readOnly: false },
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    gateways.push(server);
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${endpoint}/lan/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: endpoint },
      body: `code=${code}`,
      redirect: 'manual',
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return { endpoint, cookie };
  }

  async function http(path, { method = 'GET', body, cookie, endpoint = base } = {}) {
    const response = await fetch(`${endpoint}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, json, text };
  }

  t.after(async () => {
    for (const gatewayServer of gateways) {
      try {
        gatewayServer.closeAllConnections();
        await new Promise((done) => gatewayServer.close(done));
      } catch {}
    }
    await app.close().catch(() => {});
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  return {
    root, source, head, sessionDir, dataDir, agentHome,
    app, routes, worktrees, launches, runsList, busySessions, runtimeControls,
    gateway, http, base,
    setServiceBusy: (value) => { busyService = value; },
  };
}

async function freshHeads(routes, id, cwd) {
  const seen = await routes.inspect({ id, cwd });
  assert.equal(seen.orphaned, false);
  assert.ok(seen.main?.head);
  assert.ok(seen.task?.head);
  return { expectedSourceHead: seen.main.head, expectedWorktreeHead: seen.task.head, seen };
}

test('create/list/inspect on registered cwd stays local-only, no task project', async (t) => {
  const f = await fixture(t);
  const created = await f.routes.create({ cwd: f.source, name: 'Local task' });
  assert.ok(created.worktree?.id);
  assert.match(created.worktree.id, /^wt-[0-9a-f]{12}$/);
  assert.ok(created.worktree.revision);
  assert.equal(created.baseCommit, f.head);
  const taskPath = created.worktree.path;
  assert.ok(resolve(taskPath).startsWith(resolve(join(f.dataDir, 'worktrees'))));
  assert.ok((await stat(taskPath)).isDirectory());

  const listed = await f.routes.list(f.source);
  assert.equal(listed.worktrees.length, 1);
  assert.equal(listed.worktrees[0].id, created.worktree.id);

  const seen = await f.routes.inspect({ id: created.worktree.id, cwd: f.source });
  assert.equal(seen.orphaned, false);
  assert.equal(seen.main.head, f.head);
  assert.equal(seen.task.head, f.head);
  assert.equal(seen.baseCommit, f.head);

  // Task path is never a registered project: local-only grouping.
  await expectStatus(f.app.store.findProject(taskPath), 404);
  const overview = await f.app.store.overview();
  assert.ok(overview.projects.some((p) => resolve(p.cwd) === resolve(f.source)));
  assert.equal(overview.projects.some((p) => resolve(p.cwd) === resolve(taskPath)), false);

  // LAN gateway never exposes worktree HTTP surface (local-only).
  const gw = await f.gateway();
  for (const path of ['/api/worktrees', `/api/worktrees/${created.worktree.id}`]) {
    const viaGateway = await f.http(`${path}?cwd=${encodeURIComponent(f.source)}`, { cookie: gw.cookie, endpoint: gw.endpoint });
    assert.equal(viaGateway.status, 404, `gateway must stay 404 for ${path}`);
  }
});

test('spoofed cwd/id rejected without mutation', async (t) => {
  const f = await fixture(t);
  const created = await f.routes.create({ cwd: f.source, name: 'Owner check' });
  const id = created.worktree.id;
  const rootHeadBefore = (await git(f.source, ['rev-parse', 'HEAD'])).trim();

  // Unknown cwd is not a registered project.
  const unknown = join(f.root, 'no-such-project');
  await mkdir(unknown, { recursive: true });
  await expectStatus(f.routes.list(unknown), 404);
  await expectStatus(f.routes.create({ cwd: unknown, name: 'x' }), 404);
  await expectStatus(f.routes.inspect({ id, cwd: unknown }), 404);

  // Other registered project cannot inspect this worktree.
  const other = join(f.root, 'other');
  await mkdir(other, { recursive: true });
  await f.app.store.project({ cwd: other });
  const spoofed = await f.routes.inspect({ id, cwd: other }).catch((e) => e);
  assert.equal(spoofed?.status, 404);
  assert.equal(spoofed?.code, 'worktree_missing');

  // Malformed and unknown ids.
  await expectCode(f.routes.inspect({ id: 'wt-deadbeefcafe', cwd: f.source }), 'worktree_missing');
  await expectCode(f.routes.inspect({ id: 'not-an-id', cwd: f.source }), 'worktree_missing');

  // Root preserved.
  assert.equal((await git(f.source, ['rev-parse', 'HEAD'])).trim(), rootHeadBefore);
  assert.equal((await f.routes.list(f.source)).worktrees.length, 1);
});

test('spoofed session rejected, no launch', async (t) => {
  const f = await fixture(t);
  const first = await f.routes.create({ cwd: f.source, name: 'First' });
  const second = await f.routes.create({ cwd: f.source, name: 'Second' });
  const heads = await freshHeads(f.routes, first.worktree.id, f.source);

  // Bind a real session to the second worktree.
  const otherSession = validSessionId();
  const secondDetail = await f.routes.inspect({ id: second.worktree.id, cwd: f.source });
  await writeSessionFile(f.sessionDir, otherSession, secondDetail.task.path);
  await f.app.store.bindSessionWorktree({ id: otherSession, worktreeId: second.worktree.id, projectCwd: f.source });

  // Session from another worktree cannot prepare this worktree.
  await expectCode(
    f.routes.prepare({
      id: first.worktree.id, cwd: f.source, revision: first.worktree.revision, confirm: true,
      ...heads, sessionId: otherSession,
    }),
    'worktree_conflict',
  );

  // Session in another folder cannot prepare this worktree.
  const foreignDir = join(f.root, 'foreign');
  await mkdir(foreignDir, { recursive: true });
  const foreignSession = validSessionId();
  await writeSessionFile(f.sessionDir, foreignSession, foreignDir);
  await expectCode(
    f.routes.prepare({
      id: first.worktree.id, cwd: f.source, revision: first.worktree.revision, confirm: true,
      ...heads, sessionId: foreignSession,
    }),
    'worktree_conflict',
  );

  // Unknown session id.
  await expectCode(
    f.routes.prepare({
      id: first.worktree.id, cwd: f.source, revision: first.worktree.revision, confirm: true,
      ...heads, sessionId: validSessionId(),
    }),
    'worktree_missing',
  );

  assert.equal(f.launches.length, 0);
});

test('prepare launches isolated run in task cwd with scoped prompt, isolated history, root untouched', async (t) => {
  const f = await fixture(t);
  const created = await f.routes.create({ cwd: f.source, name: 'Prepare me' });
  const id = created.worktree.id;
  const heads = await freshHeads(f.routes, id, f.source);
  const detailBefore = await f.routes.inspect({ id, cwd: f.source });
  const taskPath = detailBefore.task.path;
  const rootHeadBefore = (await git(f.source, ['rev-parse', 'HEAD'])).trim();
  const rootContentBefore = await readFile(join(f.source, 'app.txt'), 'utf8');

  const run = await f.routes.prepare({
    id, cwd: f.source, revision: created.worktree.revision, confirm: true,
    ...heads, message: 'Please tidy the task.',
  });
  assert.ok(run?.sessionId);
  assert.equal(resolve(run.cwd), resolve(taskPath));
  assert.equal(f.launches.length, 1);
  assert.equal(resolve(f.launches[0].cwd), resolve(taskPath));
  // Actual runtime received the isolated task cwd, never the source checkout.
  assert.equal(resolve(f.runtimeControls.at(-1).input.cwd), resolve(taskPath));
  assert.notEqual(resolve(f.launches[0].cwd), resolve(f.source));

  const prompt = String(f.launches[0].message || run.message);
  assert.ok(prompt.includes(taskPath), 'prompt carries task worktree path');
  assert.ok(prompt.includes(detailBefore.worktree.branch), 'prompt carries task branch');
  assert.ok(prompt.includes(heads.expectedSourceHead), 'prompt carries recorded source HEAD');
  assert.match(prompt, /never/i, 'prompt scopes to task worktree only');
  assert.ok(prompt.includes(detailBefore.worktree.sourcePath), 'prompt names the original checkout to avoid');

  // Session file persists with the isolated cwd. Authoritative store binding
  // plus original project grouping plus enriched sessionId are proven by the
  // HTTP prepare tests through production startRun, not by this fake launch.
  const history = await f.app.store.history(run.sessionId);
  assert.equal(resolve(history.cwd), resolve(taskPath));

  // No root mutation from prepare.
  assert.equal((await git(f.source, ['rev-parse', 'HEAD'])).trim(), rootHeadBefore);
  assert.equal(await readFile(join(f.source, 'app.txt'), 'utf8'), rootContentBefore);
});

test('prepare requires explicit confirm, revision match and fresh full heads', async (t) => {
  const f = await fixture(t);
  const created = await f.routes.create({ cwd: f.source, name: 'Guarded' });
  const id = created.worktree.id;
  const heads = await freshHeads(f.routes, id, f.source);
  const rootHeadBefore = (await git(f.source, ['rev-parse', 'HEAD'])).trim();

  await expectCode(
    f.routes.prepare({ id, cwd: f.source, revision: created.worktree.revision, confirm: false, ...heads }),
    'worktree_invalid',
  );
  await expectCode(
    f.routes.prepare({ id, cwd: f.source, revision: created.worktree.revision, confirm: true, expectedSourceHead: heads.expectedSourceHead.slice(0, 7), expectedWorktreeHead: heads.expectedWorktreeHead }),
    'worktree_invalid',
  );
  await expectCode(
    f.routes.prepare({ id, cwd: f.source, revision: created.worktree.revision, confirm: true }),
    'worktree_invalid',
  );
  await expectCode(
    f.routes.prepare({ id, cwd: f.source, confirm: true, ...heads }),
    'worktree_conflict',
  );
  // Stale revision never launches.
  await expectCode(
    f.routes.prepare({ id, cwd: f.source, revision: 'stale-revision', confirm: true, ...heads }),
    'worktree_conflict',
  );
  // Stale heads never launch.
  await expectCode(
    f.routes.prepare({
      id, cwd: f.source, revision: created.worktree.revision, confirm: true,
      expectedSourceHead: '0'.repeat(40), expectedWorktreeHead: heads.expectedWorktreeHead,
    }),
    'worktree_conflict',
  );
  assert.equal(f.launches.length, 0);
  assert.equal((await git(f.source, ['rev-parse', 'HEAD'])).trim(), rootHeadBefore);
});

test('busy blocks prepare/integrate/remove and preserves root', async (t) => {
  const f = await fixture(t);
  const created = await f.routes.create({ cwd: f.source, name: 'Busy task' });
  const id = created.worktree.id;
  await writeFile(join(created.worktree.path, 'app.txt'), 'v2\n', 'utf8');
  await commitAll(created.worktree.path, 'task change');
  const heads = await freshHeads(f.routes, id, f.source);
  const detail = await f.routes.inspect({ id, cwd: f.source });
  const rootHeadBefore = (await git(f.source, ['rev-parse', 'HEAD'])).trim();

  // Simulate a running agent in the task worktree.
  f.runsList.push({ cwd: detail.task.path, status: 'running' });
  f.setServiceBusy(true);
  await expectCode(
    f.routes.prepare({ id, cwd: f.source, revision: detail.worktree.revision, confirm: true, ...heads }),
    'worktree_busy',
  );
  await expectCode(
    f.routes.integrate({ id, cwd: f.source, revision: detail.worktree.revision, confirm: true, ...heads }),
    'worktree_busy',
  );
  await expectCode(
    f.routes.remove({ id, cwd: f.source, revision: detail.worktree.revision, confirm: true }),
    'worktree_busy',
  );
  assert.equal(f.launches.length, 0);
  assert.equal((await git(f.source, ['rev-parse', 'HEAD'])).trim(), rootHeadBefore);

  // Releasing busy lets a fresh prepare launch again (proves the guard, not a dead lock).
  f.runsList.length = 0;
  f.setServiceBusy(false);
  const after = await freshHeads(f.routes, id, f.source);
  const afterDetail = await f.routes.inspect({ id, cwd: f.source });
  const run = await f.routes.prepare({
    id, cwd: f.source, revision: afterDetail.worktree.revision, confirm: true, ...after,
  });
  assert.ok(run?.sessionId);
  assert.equal(f.launches.length, 1);
});

test('removed path never launches and branch is retained', async (t) => {
  const f = await fixture(t);
  const created = await f.routes.create({ cwd: f.source, name: 'Remove me' });
  const id = created.worktree.id;
  const taskPath = created.worktree.path;
  const branch = created.worktree.branch;
  const removed = await f.routes.remove({ id, cwd: f.source, revision: created.worktree.revision, confirm: true });
  assert.equal(removed.removed, true);
  assert.equal(await stat(taskPath).then(() => true).catch(() => false), false);
  assert.match((await git(f.source, ['branch', '--list', branch])).trim(), new RegExp(branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const heads = { expectedSourceHead: f.head, expectedWorktreeHead: f.head };
  await expectCode(
    f.routes.prepare({ id, cwd: f.source, revision: created.worktree.revision, confirm: true, ...heads }),
    'worktree_missing',
  );
  await expectCode(f.routes.inspect({ id, cwd: f.source }), 'worktree_missing');
  assert.equal(f.launches.length, 0);
});

test('clean commit fast-forwards root and old revision goes stale', async (t) => {
  const f = await fixture(t);
  const created = await f.routes.create({ cwd: f.source, name: 'Ship it' });
  const id = created.worktree.id;
  await writeFile(join(created.worktree.path, 'app.txt'), 'v2\n', 'utf8');
  const taskHead = await commitAll(created.worktree.path, 'task change');
  const heads = await freshHeads(f.routes, id, f.source);
  assert.equal(heads.expectedWorktreeHead, taskHead);

  const done = await f.routes.integrate({
    id, cwd: f.source, revision: created.worktree.revision, confirm: true, ...heads,
  });
  assert.equal(done.integrated, true);
  assert.equal(done.alreadyUpToDate, false);
  assert.equal((await git(f.source, ['rev-parse', 'HEAD'])).trim(), taskHead);
  assert.equal(await readFile(join(f.source, 'app.txt'), 'utf8'), 'v2\n');

  // Already up to date stays idempotent with the fresh revision.
  const after = await f.routes.inspect({ id, cwd: f.source });
  const heads2 = await freshHeads(f.routes, id, f.source);
  const second = await f.routes.integrate({
    id, cwd: f.source, revision: after.worktree.revision, confirm: true, ...heads2,
  });
  assert.equal(second.alreadyUpToDate, true);

  // Old revision is stale.
  await expectCode(
    f.routes.integrate({ id, cwd: f.source, revision: created.worktree.revision, confirm: true, ...heads2 }),
    'worktree_conflict',
  );
});

test('stale heads, corrupt registry, tampered path and gateway preserve root', async (t) => {
  const f = await fixture(t);
  const created = await f.routes.create({ cwd: f.source, name: 'Guards' });
  const id = created.worktree.id;
  await writeFile(join(created.worktree.path, 'app.txt'), 'v2\n', 'utf8');
  await commitAll(created.worktree.path, 'task change');
  const heads = await freshHeads(f.routes, id, f.source);
  const rootHeadBefore = (await git(f.source, ['rev-parse', 'HEAD'])).trim();
  const registryFile = join(f.dataDir, 'worktrees.json');
  const registryRaw = await readFile(registryFile, 'utf8');

  // Stale source head.
  await expectCode(
    f.routes.integrate({
      id, cwd: f.source, revision: created.worktree.revision, confirm: true,
      expectedSourceHead: '0'.repeat(40), expectedWorktreeHead: heads.expectedWorktreeHead,
    }),
    'worktree_conflict',
  );
  // Missing confirm.
  await expectCode(
    f.routes.integrate({ id, cwd: f.source, revision: created.worktree.revision, ...heads }),
    'worktree_invalid',
  );
  assert.equal((await git(f.source, ['rev-parse', 'HEAD'])).trim(), rootHeadBefore);

  // Corrupt registry fails closed with data retained.
  await writeFile(registryFile, '{ corrupt json', 'utf8');
  const corruptList = await f.routes.list(f.source).catch((e) => e);
  assert.equal(corruptList?.code, 'worktree_corrupt');
  const corruptInspect = await f.routes.inspect({ id, cwd: f.source }).catch((e) => e);
  assert.equal(corruptInspect?.code, 'worktree_corrupt');
  assert.equal(await readFile(registryFile, 'utf8'), '{ corrupt json');
  await writeFile(registryFile, registryRaw, 'utf8');
  assert.equal((await f.routes.list(f.source)).worktrees.length, 1);
  assert.equal((await git(f.source, ['rev-parse', 'HEAD'])).trim(), rootHeadBefore);

  // Tampered path outside managed ownership cannot integrate.
  const tampered = JSON.parse(registryRaw);
  tampered.worktrees.find((e) => e.id === id).path = join(f.root, 'evil-escape');
  await writeFile(registryFile, JSON.stringify(tampered, null, 2), 'utf8');
  const tamperedIntegrate = await f.routes.integrate({
    id, cwd: f.source, revision: created.worktree.revision, confirm: true, ...heads,
  }).catch((e) => e);
  assert.ok(['worktree_ownership', 'worktree_missing', 'worktree_conflict'].includes(tamperedIntegrate?.code), `unexpected ${tamperedIntegrate?.code}`);
  assert.equal((await git(f.source, ['rev-parse', 'HEAD'])).trim(), rootHeadBefore);
  await writeFile(registryFile, registryRaw, 'utf8');

  // Remote gateway stays local-only.
  const gw = await f.gateway();
  const viaGateway = await f.http(`/api/worktrees/${id}?cwd=${encodeURIComponent(f.source)}`, { cookie: gw.cookie, endpoint: gw.endpoint });
  assert.equal(viaGateway.status, 404);
  assert.equal((await git(f.source, ['rev-parse', 'HEAD'])).trim(), rootHeadBefore);
});

// Production HTTP section: fetch against createApp production routes.
// Uses the production startRun to the fake runtime (cwd/message/model capture
// plus onEvent session), real temp git repos, ephemeral port. No separate
// adapter, no fakeLaunch. Fails until server.mjs wires /api/worktrees.

async function httpFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-wt-http-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  const source = join(root, 'proj');
  const sessionDir = join(root, 'sessions');
  const dataDir = join(root, 'data');
  const agentHome = join(root, 'agent');
  await Promise.all([
    mkdir(source, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(agentHome, { recursive: true }),
  ]);
  const head = await initRepo(source);
  const controls = [];
  const runtime = {
    async getStatus() {
      return { available: true, version: 'fixture', nodeVersion: process.versions.node };
    },
    async getModels() {
      return { models: [{ id: 'fixture/model', provider: 'fixture' }], default: { model: 'fixture/model' } };
    },
    async start(input) {
      const sessionId = input.sessionId || validSessionId();
      if (!input.sessionId) {
        await writeSessionFile(sessionDir, sessionId, input.cwd);
      }
      let complete;
      const done = new Promise((resolve) => { complete = resolve; });
      const control = {
        input: { ...input, sessionId },
        sessionId,
        done,
        complete,
        async cancel() {
          complete({ status: 'stopped', code: 130 });
          return done;
        },
      };
      controls.push(control);
      input.onEvent({ kind: 'session', sessionId });
      return control;
    },
    async close() {
      await Promise.all(controls.map((control) => control.cancel().catch(() => {})));
    },
  };
  const app = createApp({ agentHome, sessionDir, dataDir, initialCwd: source, runtime });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const gateways = [];
  async function api(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, json, text };
  }
  async function gateway() {
    const salt = 'c'.repeat(32);
    const code = '12345678';
    const server = createLanGateway({
      host: '127.0.0.1',
      upstreamPort: app.server.address().port,
      config: { salt, codeHash: hashAccessCode(code, salt), readOnly: false },
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    gateways.push(server);
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${endpoint}/lan/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: endpoint },
      body: `code=${code}`,
      redirect: 'manual',
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return { endpoint, cookie };
  }
  t.after(async () => {
    for (const gatewayServer of gateways) {
      try {
        gatewayServer.closeAllConnections();
        await new Promise((done) => gatewayServer.close(done));
      } catch {}
    }
    await app.close().catch(() => {});
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return { root, source, head, sessionDir, dataDir, app, controls, api, gateway, base };
}

test('HTTP create/list/inspect happy path via production routes, gateway stays local only', async (t) => {
  const f = await httpFixture(t);
  const registered = await f.api('/api/projects', { cwd: f.source });
  assert.equal(registered.status, 201);

  const created = await f.api('/api/worktrees', { cwd: f.source, name: 'HTTP task' });
  assert.equal(created.status, 201, created.text);
  assert.match(created.json.worktree.id, /^wt-[0-9a-f]{12}$/);
  assert.ok(created.json.worktree.revision);
  assert.equal(created.json.baseCommit, f.head);
  assert.equal(created.json.sourceDirty, false);
  const id = created.json.worktree.id;
  const taskPath = created.json.worktree.path;

  const listed = await f.api(`/api/worktrees?cwd=${encodeURIComponent(f.source)}`);
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.worktrees.length, 1);
  assert.equal(listed.json.worktrees[0].id, id);

  const seen = await f.api(`/api/worktrees/${id}?cwd=${encodeURIComponent(f.source)}`);
  assert.equal(seen.status, 200, seen.text);
  assert.equal(seen.json.orphaned, false);
  assert.equal(seen.json.main.head, f.head);
  assert.equal(seen.json.task.head, f.head);
  assert.equal(seen.json.baseCommit, f.head);

  // Local 200 first proves the route exists, so gateway 404 proves local only.
  const gw = await f.gateway();
  const gwList = await fetch(`${gw.endpoint}/api/worktrees?cwd=${encodeURIComponent(f.source)}`, {
    headers: { Cookie: gw.cookie },
  });
  assert.equal(gwList.status, 404);
  const gwSeen = await fetch(`${gw.endpoint}/api/worktrees/${id}?cwd=${encodeURIComponent(f.source)}`, {
    headers: { Cookie: gw.cookie },
  });
  assert.equal(gwSeen.status, 404);
  assert.equal(resolve(taskPath).startsWith(resolve(join(f.dataDir, 'worktrees'))), true);
});

test('HTTP prepare uses production startRun in task cwd with scoped prompt and grouping', async (t) => {
  const f = await httpFixture(t);
  const created = await f.api('/api/worktrees', { cwd: f.source, name: 'HTTP prepare' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.worktree.id;
  const revision = created.json.worktree.revision;
  const seen = await f.api(`/api/worktrees/${id}?cwd=${encodeURIComponent(f.source)}`);
  assert.equal(seen.status, 200, seen.text);
  const taskPath = seen.json.task.path;
  const branch = seen.json.worktree.branch;
  const sourceHead = seen.json.main.head;
  const taskHead = seen.json.task.head;
  const rootHeadBefore = (await git(f.source, ['rev-parse', 'HEAD'])).trim();

  const prepared = await f.api(`/api/worktrees/${id}/prepare`, {
    cwd: f.source, revision, confirm: true,
    expectedSourceHead: sourceHead, expectedWorktreeHead: taskHead,
    message: 'Please tidy the task.',
  });
  assert.equal(prepared.status, 201, prepared.text);
  assert.ok(prepared.json.sessionId);
  assert.equal(resolve(prepared.json.cwd), resolve(taskPath));

  // Production startRun reached the fake runtime with the isolated task cwd.
  assert.equal(f.controls.length, 1);
  assert.equal(resolve(f.controls[0].input.cwd), resolve(taskPath));
  assert.notEqual(resolve(f.controls[0].input.cwd), resolve(f.source));
  const prompt = String(f.controls[0].input.message);
  assert.ok(prompt.includes(taskPath));
  assert.ok(prompt.includes(branch));
  assert.ok(prompt.includes(sourceHead));
  assert.match(prompt, /never/i);

  // Session persists with isolated cwd but groups under the original project.
  const history = await f.api(`/api/history?id=${encodeURIComponent(prepared.json.sessionId)}`);
  assert.equal(history.status, 200, history.text);
  assert.equal(resolve(history.json.cwd), resolve(taskPath));
  const overview = await f.api('/api/overview');
  assert.equal(overview.status, 200);
  const owner = overview.json.projects.find((p) => resolve(p.cwd) === resolve(f.source));
  assert.ok(owner.sessions.some((s) => s.id === prepared.json.sessionId));
  assert.equal(overview.json.projects.some((p) => resolve(p.cwd) === resolve(taskPath)), false);

  // Active run is visible via production /api/runs and no root mutation happened.
  const runs = await f.api('/api/runs');
  assert.equal(runs.status, 200);
  assert.ok(runs.json.runs.some((r) => r.sessionId === prepared.json.sessionId));
  assert.equal((await git(f.source, ['rev-parse', 'HEAD'])).trim(), rootHeadBefore);
});

test('HTTP integrate fast-forwards root, stale revision and spoofed cwd carry worktree codes', async (t) => {
  const f = await httpFixture(t);
  const created = await f.api('/api/worktrees', { cwd: f.source, name: 'HTTP ship' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.worktree.id;
  const revision = created.json.worktree.revision;
  const taskPath = created.json.worktree.path;
  await writeFile(join(taskPath, 'app.txt'), 'v2\n', 'utf8');
  const taskHead = await commitAll(taskPath, 'task change');
  const seen = await f.api(`/api/worktrees/${id}?cwd=${encodeURIComponent(f.source)}`);
  assert.equal(seen.status, 200, seen.text);

  const done = await f.api(`/api/worktrees/${id}/integrate`, {
    cwd: f.source, revision, confirm: true,
    expectedSourceHead: seen.json.main.head, expectedWorktreeHead: taskHead,
  });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.integrated, true);
  assert.equal((await git(f.source, ['rev-parse', 'HEAD'])).trim(), taskHead);
  assert.equal(await readFile(join(f.source, 'app.txt'), 'utf8'), 'v2\n');

  // Stale revision fails with structured worktree code, root preserved.
  const stale = await f.api(`/api/worktrees/${id}/integrate`, {
    cwd: f.source, revision, confirm: true,
    expectedSourceHead: seen.json.main.head, expectedWorktreeHead: taskHead,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'worktree_conflict');
  assert.ok(typeof stale.json.error === 'string' && stale.json.error.length > 0);

  // Spoofed cwd fails as missing worktree with code.
  const other = join(f.root, 'other');
  await mkdir(other, { recursive: true });
  await f.api('/api/projects', { cwd: other });
  const spoofed = await f.api(`/api/worktrees/${id}?cwd=${encodeURIComponent(other)}`);
  assert.equal(spoofed.status, 404);
  assert.equal(spoofed.json.code, 'worktree_missing');
  assert.equal((await git(f.source, ['rev-parse', 'HEAD'])).trim(), taskHead);
});

test('HTTP remove deletes task path, retains branch, removed id never launches', async (t) => {
  const f = await httpFixture(t);
  const created = await f.api('/api/worktrees', { cwd: f.source, name: 'HTTP remove' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.worktree.id;
  const revision = created.json.worktree.revision;
  const taskPath = created.json.worktree.path;
  const branch = created.json.worktree.branch;

  const removed = await f.api(`/api/worktrees/${id}/remove`, {
    cwd: f.source, revision, confirm: true,
  });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.json.removed, true);
  assert.equal(await stat(taskPath).then(() => true).catch(() => false), false);
  assert.match((await git(f.source, ['branch', '--list', branch])).trim(), new RegExp(branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const heads = { expectedSourceHead: f.head, expectedWorktreeHead: f.head };
  const relaunched = await f.api(`/api/worktrees/${id}/prepare`, {
    cwd: f.source, revision, confirm: true, ...heads,
  });
  assert.equal(relaunched.status, 404);
  assert.equal(relaunched.json.code, 'worktree_missing');
  assert.equal(f.controls.length, 0);
});

// Delayed session section: proves authoritative binding on async onEvent.
// The fake runtime defers the session event until the test emits it, so any
// binding that only works for synchronous emits is exposed. No manual store
// binding and no pre created session files on the delayed path.

async function httpDelayedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-wt-delay-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  const source = join(root, 'proj');
  const sessionDir = join(root, 'sessions');
  const dataDir = join(root, 'data');
  const agentHome = join(root, 'agent');
  await Promise.all([
    mkdir(source, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(agentHome, { recursive: true }),
  ]);
  const head = await initRepo(source);
  const controls = [];
  const runtime = {
    async getStatus() {
      return { available: true, version: 'fixture', nodeVersion: process.versions.node };
    },
    async getModels() {
      return { models: [{ id: 'fixture/model', provider: 'fixture' }], default: { model: 'fixture/model' } };
    },
    async start(input) {
      const sessionId = input.sessionId || validSessionId();
      let complete;
      const done = new Promise((resolve) => { complete = resolve; });
      const control = {
        input: { ...input, sessionId },
        sessionId,
        done,
        complete,
        emitSession: async () => {
          await writeSessionFile(sessionDir, sessionId, input.cwd);
          input.onEvent({ kind: 'session', sessionId });
        },
        async cancel() {
          complete({ status: 'stopped', code: 130 });
          return done;
        },
      };
      controls.push(control);
      return control;
    },
    async close() {
      await Promise.all(controls.map((control) => control.cancel().catch(() => {})));
    },
  };
  const app = createApp({ agentHome, sessionDir, dataDir, initialCwd: source, runtime });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, json, text };
  }
  t.after(async () => {
    await app.close().catch(() => {});
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return { root, source, head, sessionDir, dataDir, agentHome, app, controls, api, base };
}

async function untilGrouped({ api, sessionId, source, taskPath, timeoutMs = 8000 }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const overview = await api('/api/overview');
    assert.equal(overview.status, 200);
    const owner = overview.json.projects.find((p) => resolve(p.cwd) === resolve(source));
    const grouped = owner?.sessions?.some((s) => s.id === sessionId);
    const separate = overview.json.projects.some((p) => resolve(p.cwd) === resolve(taskPath));
    last = { grouped: !!grouped, separate };
    if (grouped && !separate) return last;
    await new Promise((done) => setTimeout(done, 50));
  }
  return last;
}

test('HTTP direct runs in task cwd with delayed session keeps original grouping, no separate project', async (t) => {
  const f = await httpDelayedFixture(t);
  const created = await f.api('/api/worktrees', { cwd: f.source, name: 'Direct run' });
  assert.equal(created.status, 201, created.text);
  const taskPath = created.json.worktree.path;
  const worktreeId = created.json.worktree.id;

  const started = await f.api('/api/runs', { cwd: taskPath, message: 'Work in the task worktree.' });
  assert.equal(started.status, 201, started.text);
  assert.equal(resolve(started.json.cwd), resolve(taskPath));
  assert.equal(started.json.worktreeId, worktreeId);
  assert.equal(resolve(started.json.projectCwd), resolve(f.source));
  assert.equal(f.controls.length, 1);
  assert.equal(resolve(f.controls[0].input.cwd), resolve(taskPath));
  assert.equal(started.json.sessionId, null);

  await f.controls[0].emitSession();
  const sessionId = f.controls[0].sessionId;
  const history = await f.api(`/api/history?id=${encodeURIComponent(sessionId)}`);
  assert.equal(history.status, 200, history.text);
  assert.equal(resolve(history.json.cwd), resolve(taskPath));

  const state = await untilGrouped({ api: f.api, sessionId, source: f.source, taskPath });
  assert.equal(state.grouped, true, 'delayed direct run session groups under the original project');
  assert.equal(state.separate, false, 'task path never becomes a separate registered project');

  const listed = await f.api(`/api/worktrees?cwd=${encodeURIComponent(f.source)}`);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.worktrees.find((w) => w.id === worktreeId)?.sessionId, sessionId);
});

test('HTTP prepare with delayed session keeps original grouping, no separate project', async (t) => {
  const f = await httpDelayedFixture(t);
  const created = await f.api('/api/worktrees', { cwd: f.source, name: 'Delayed prepare' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.worktree.id;
  const revision = created.json.worktree.revision;
  const seen = await f.api(`/api/worktrees/${id}?cwd=${encodeURIComponent(f.source)}`);
  assert.equal(seen.status, 200, seen.text);
  const taskPath = seen.json.task.path;
  const rootHeadBefore = (await git(f.source, ['rev-parse', 'HEAD'])).trim();

  const prepared = await f.api(`/api/worktrees/${id}/prepare`, {
    cwd: f.source, revision, confirm: true,
    expectedSourceHead: seen.json.main.head, expectedWorktreeHead: seen.json.task.head,
    message: 'Delayed tidy.',
  });
  assert.equal(prepared.status, 201, prepared.text);
  assert.equal(resolve(prepared.json.cwd), resolve(taskPath));
  assert.equal(prepared.json.worktreeId, id);
  assert.equal(resolve(prepared.json.projectCwd), resolve(f.source));
  assert.equal(f.controls.length, 1);
  assert.equal(resolve(f.controls[0].input.cwd), resolve(taskPath));
  assert.equal(prepared.json.sessionId, null);

  await f.controls[0].emitSession();
  const sessionId = f.controls[0].sessionId;
  const prompt = String(f.controls[0].input.message);
  assert.ok(prompt.includes(taskPath));
  assert.match(prompt, /never/i);

  const state = await untilGrouped({ api: f.api, sessionId, source: f.source, taskPath });
  assert.equal(state.grouped, true, 'delayed prepare session groups under the original project');
  assert.equal(state.separate, false, 'task path never becomes a separate registered project');
  assert.equal((await git(f.source, ['rev-parse', 'HEAD'])).trim(), rootHeadBefore);
});

test('HTTP worktree survives app and store restart', async (t) => {
  const f = await httpFixture(t);
  const created = await f.api('/api/worktrees', { cwd: f.source, name: 'Restart me' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.worktree.id;
  const taskPath = created.json.worktree.path;
  await f.app.close().catch(() => {});

  const controls = [];
  const runtime = {
    async getStatus() {
      return { available: true, version: 'fixture', nodeVersion: process.versions.node };
    },
    async getModels() {
      return { models: [{ id: 'fixture/model', provider: 'fixture' }], default: { model: 'fixture/model' } };
    },
    async start(input) {
      const control = { input, async cancel() {} };
      controls.push(control);
      return control;
    },
    async close() {},
  };
  const app2 = createApp({ agentHome: f.agentHome, sessionDir: f.sessionDir, dataDir: f.dataDir, initialCwd: f.source, runtime });
  await new Promise((done) => app2.server.listen(0, '127.0.0.1', done));
  try {
    const base2 = `http://127.0.0.1:${app2.server.address().port}`;
    async function api2(path, body) {
      const response = await fetch(`${base2}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); } catch {}
      return { status: response.status, json, text };
    }
    const listed = await api2(`/api/worktrees?cwd=${encodeURIComponent(f.source)}`);
    assert.equal(listed.status, 200, listed.text);
    assert.ok(listed.json.worktrees.some((w) => w.id === id));
    const seen = await api2(`/api/worktrees/${id}?cwd=${encodeURIComponent(f.source)}`);
    assert.equal(seen.status, 200, seen.text);
    assert.equal(resolve(seen.json.task.path), resolve(taskPath));
    assert.equal(seen.json.orphaned, false);
  } finally {
    await app2.close().catch(() => {});
  }
});

// Task file reads section: narrow taskProjectFiles computes the authoritative
// managed task root with owner registration on every call. Ordinary
// protectedRoots stay unchanged. All tests below use real HTTP.

test('HTTP task preview and diff serve the task root, source preview unaffected', async (t) => {
  const f = await httpFixture(t);
  const created = await f.api('/api/worktrees', { cwd: f.source, name: 'Task files' });
  assert.equal(created.status, 201, created.text);
  const taskPath = created.json.worktree.path;
  await writeFile(join(taskPath, 'task-note.txt'), 'hello task\nsecond line\n', 'utf8');

  const preview = await f.api(`/api/project-files/preview?cwd=${encodeURIComponent(taskPath)}&path=${encodeURIComponent('task-note.txt')}`);
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.type, 'text');
  assert.ok(preview.json.text.includes('hello task'));

  const diff = await f.api(`/api/project-files/diff?cwd=${encodeURIComponent(taskPath)}&path=${encodeURIComponent('task-note.txt')}`);
  assert.equal(diff.status, 200, diff.text);
  assert.equal(diff.json.newFile, true);
  assert.ok(diff.json.text.includes('+hello task'));

  const sourcePreview = await f.api(`/api/project-files/preview?cwd=${encodeURIComponent(f.source)}&path=${encodeURIComponent('app.txt')}`);
  assert.equal(sourcePreview.status, 200, sourcePreview.text);
  assert.equal(sourcePreview.json.type, 'text');
  assert.ok(sourcePreview.json.text.includes('v1'));
});

test('HTTP task file reads deny traversal and symlink escape', async (t) => {
  const f = await httpFixture(t);
  const created = await f.api('/api/worktrees', { cwd: f.source, name: 'Task escape' });
  assert.equal(created.status, 201, created.text);
  const taskPath = created.json.worktree.path;
  await writeFile(join(taskPath, 'ok.txt'), 'ok\n', 'utf8');

  const traversal = await f.api(`/api/project-files/preview?cwd=${encodeURIComponent(taskPath)}&path=${encodeURIComponent('../app.txt')}`);
  assert.equal(traversal.status, 403, traversal.text);

  await symlink(join(f.source, 'app.txt'), join(taskPath, 'link.txt'), 'file');
  const escaped = await f.api(`/api/project-files/preview?cwd=${encodeURIComponent(taskPath)}&path=${encodeURIComponent('link.txt')}`);
  assert.equal(escaped.status, 403, escaped.text);
});

test('HTTP task file reads deny unknown managed and unregistered paths, protect dataDir secrets', async (t) => {
  const f = await httpFixture(t);
  const created = await f.api('/api/worktrees', { cwd: f.source, name: 'Task guard' });
  assert.equal(created.status, 201, created.text);
  const taskPath = created.json.worktree.path;

  const unknownManaged = join(f.dataDir, 'worktrees', 'wt-missing-0123456789ab');
  const unknown = await f.api(`/api/project-files/preview?cwd=${encodeURIComponent(unknownManaged)}&path=${encodeURIComponent('app.txt')}`);
  assert.equal(unknown.status, 404, unknown.text);
  assert.equal(unknown.json.code, 'worktree_missing');

  const plain = join(f.root, 'plain');
  await mkdir(plain, { recursive: true });
  await writeFile(join(plain, 'note.txt'), 'plain\n', 'utf8');
  const unregistered = await f.api(`/api/project-files/preview?cwd=${encodeURIComponent(plain)}&path=${encodeURIComponent('note.txt')}`);
  assert.equal(unregistered.status, 404, unregistered.text);

  const secret = await f.api(`/api/project-files/preview?cwd=${encodeURIComponent(taskPath)}&path=${encodeURIComponent('../../worktrees.json')}`);
  assert.equal(secret.status, 403, secret.text);
});
