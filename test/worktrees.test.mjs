import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createWorktrees } from '../lib/worktrees.mjs';

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
  await git(dir, ['config', 'user.name', 'wt-test']);
  await git(dir, ['config', 'user.email', 'wt@test']);
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

async function fixture(t, { busy = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-wt-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  const dataDir = join(root, 'data');
  const source = join(root, 'proj');
  const head = await initRepo(source);
  let busyFlag = busy;
  const service = createWorktrees({ dataDir, isBusy: () => busyFlag });
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return {
    root,
    dataDir,
    source,
    head,
    service,
    setBusy: (value) => { busyFlag = value; },
    refresh: () => createWorktrees({ dataDir, isBusy: () => busyFlag }),
  };
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error?.code, code, `expected code ${code}, got ${error?.code}: ${error?.message}`);
    return error;
  }
  assert.fail(`expected error code ${code}`);
}

async function freshHeads(service, id) {
  const seen = await service.inspect({ id });
  assert.equal(seen.orphaned, false);
  return { expectedSourceHead: seen.main.head, expectedWorktreeHead: seen.task.head };
}

test('create from clean repo starts at HEAD with generated branch and path', async (t) => {
  const { service, source, head, dataDir } = await fixture(t);
  const { worktree, sourceDirty, baseCommit } = await service.create({ projectCwd: source, name: 'My Task' });
  assert.equal(sourceDirty, false);
  assert.equal(baseCommit, head);
  assert.match(worktree.id, /^wt-[0-9a-f]{12}$/);
  assert.ok(worktree.revision);
  assert.ok(worktree.branch.startsWith('studio/wt-my-task-'));
  assert.ok(resolve(worktree.path).startsWith(resolve(join(dataDir, 'worktrees'))));
  const info = await stat(worktree.path);
  assert.ok(info.isDirectory());
  assert.equal((await git(worktree.path, ['rev-parse', 'HEAD'])).trim(), head);
  const listed = await service.list({ projectCwd: source });
  assert.equal(listed.worktrees.length, 1);
  const seen = await service.inspect({ id: worktree.id });
  assert.equal(seen.orphaned, false);
  assert.equal(seen.main.head, head);
  assert.equal(seen.task.head, head);
  assert.equal(seen.ahead, 0);
  assert.equal(seen.behind, 0);
  assert.equal(seen.diff.patch, '');
  assert.equal(seen.diff.truncated, false);
});

test('create with dirty source never copies dirty edits and preserves them', async (t) => {
  const { service, source, head } = await fixture(t);
  await writeFile(join(source, 'app.txt'), 'dirty-edit\n', 'utf8');
  const { worktree, sourceDirty } = await service.create({ projectCwd: source, name: 'dirty case' });
  assert.equal(sourceDirty, true);
  assert.equal(worktree.sourceDirtyAtCreate, true);
  assert.equal(await readFile(join(worktree.path, 'app.txt'), 'utf8'), 'v1\n');
  assert.equal(await readFile(join(source, 'app.txt'), 'utf8'), 'dirty-edit\n');
  assert.equal((await git(worktree.path, ['rev-parse', 'HEAD'])).trim(), head);
});

test('inspect shows working changes and names untracked without reading them', async (t) => {
  const { service, source } = await fixture(t);
  const { worktree } = await service.create({ projectCwd: source, name: 'inspect me' });
  await writeFile(join(worktree.path, 'app.txt'), 'v2-work\n', 'utf8');
  await writeFile(join(worktree.path, 'secret-notes.txt'), 's3cr3t-content\n', 'utf8');
  const seen = await service.inspect({ id: worktree.id });
  assert.equal(seen.task.clean, false);
  assert.ok(seen.files.some((f) => f.path === 'app.txt'));
  assert.ok(seen.untracked.includes('secret-notes.txt'));
  assert.ok(seen.diff.workingPatch.includes('v2-work'));
  assert.ok(!seen.diff.workingPatch.includes('s3cr3t-content'));
  assert.equal(seen.diff.patch, '');
  assert.equal(seen.diff.untrackedIncluded, false);
  assert.ok(seen.diff.note.length > 10);
});

test('integrate fast-forwards committed task work and is idempotent', async (t) => {
  const { service, source } = await fixture(t);
  const { worktree } = await service.create({ projectCwd: source, name: 'ship it' });
  await writeFile(join(worktree.path, 'app.txt'), 'v2\n', 'utf8');
  const taskHead = await commitAll(worktree.path, 'task change');
  const before = await service.inspect({ id: worktree.id });
  assert.equal(before.ahead, 1);
  assert.ok(before.diff.patch.includes('v2'));
  assert.ok(before.diff.committedFiles.includes('app.txt'));
  const first = await service.integrate({
    id: worktree.id,
    revision: worktree.revision,
    confirm: true,
    expectedSourceHead: before.main.head,
    expectedWorktreeHead: taskHead,
  });
  assert.equal(first.integrated, true);
  assert.equal(first.alreadyUpToDate, false);
  assert.equal((await git(source, ['rev-parse', 'HEAD'])).trim(), taskHead);
  const afterInspect = await service.inspect({ id: worktree.id });
  assert.equal(afterInspect.ahead, 0);
  const heads2 = await freshHeads(service, worktree.id);
  const second = await service.integrate({
    id: afterInspect.worktree.id,
    revision: afterInspect.worktree.revision,
    confirm: true,
    ...heads2,
  });
  assert.equal(second.alreadyUpToDate, true);
  await expectCode(
    service.integrate({ id: worktree.id, revision: worktree.revision, confirm: true, ...heads2 }),
    'worktree_conflict',
  );
});

test('integrate requires fresh full expected heads', async (t) => {
  const { service, source } = await fixture(t);
  const { worktree } = await service.create({ projectCwd: source, name: 'heads' });
  await writeFile(join(worktree.path, 'app.txt'), 'v2\n', 'utf8');
  await commitAll(worktree.path, 'task change');
  const heads = await freshHeads(service, worktree.id);
  await expectCode(
    service.integrate({ id: worktree.id, revision: worktree.revision, confirm: true }),
    'worktree_invalid',
  );
  await expectCode(
    service.integrate({
      id: worktree.id,
      revision: worktree.revision,
      confirm: true,
      expectedSourceHead: heads.expectedSourceHead.slice(0, 7),
      expectedWorktreeHead: heads.expectedWorktreeHead,
    }),
    'worktree_invalid',
  );
  const done = await service.integrate({
    id: worktree.id,
    revision: worktree.revision,
    confirm: true,
    ...heads,
  });
  assert.equal(done.integrated, true);
});

test('integrate blocks on dirty task, dirty source, stale state, divergence and busy', async (t) => {
  const { service, source, setBusy } = await fixture(t);
  const { worktree } = await service.create({ projectCwd: source, name: 'blocked' });
  await writeFile(join(worktree.path, 'app.txt'), 'uncommitted\n', 'utf8');
  const sourceHead = (await git(source, ['rev-parse', 'HEAD'])).trim();
  const dirtyHeads = await freshHeads(service, worktree.id);
  await expectCode(
    service.integrate({ id: worktree.id, revision: worktree.revision, confirm: true, ...dirtyHeads }),
    'worktree_dirty',
  );
  assert.equal((await git(source, ['rev-parse', 'HEAD'])).trim(), sourceHead);
  await git(worktree.path, ['checkout', '--', 'app.txt']);
  await writeFile(join(source, 'app.txt'), 'source-dirty\n', 'utf8');
  await writeFile(join(worktree.path, 'app.txt'), 'v2\n', 'utf8');
  await commitAll(worktree.path, 'task change');
  const cleanHeads = await freshHeads(service, worktree.id);
  await expectCode(
    service.integrate({ id: worktree.id, revision: 'wrong-revision', confirm: true, ...cleanHeads }),
    'worktree_conflict',
  );
  await expectCode(
    service.integrate({ id: worktree.id, revision: worktree.revision, ...cleanHeads }),
    'worktree_invalid',
  );
  await expectCode(
    service.integrate({
      id: worktree.id,
      revision: worktree.revision,
      confirm: true,
      expectedSourceHead: '0'.repeat(40),
      expectedWorktreeHead: cleanHeads.expectedWorktreeHead,
    }),
    'worktree_conflict',
  );
  await expectCode(
    service.integrate({ id: worktree.id, revision: worktree.revision, confirm: true, ...cleanHeads }),
    'worktree_dirty',
  );
  assert.equal((await git(source, ['rev-parse', 'HEAD'])).trim(), sourceHead);
  await git(source, ['checkout', '--', 'app.txt']);
  await writeFile(join(source, 'app.txt'), 'source-commit\n', 'utf8');
  await commitAll(source, 'source moved on');
  const divergedHead = (await git(source, ['rev-parse', 'HEAD'])).trim();
  const divergedHeads = await freshHeads(service, worktree.id);
  await expectCode(
    service.integrate({ id: worktree.id, revision: worktree.revision, confirm: true, ...divergedHeads }),
    'worktree_not_fast_forward',
  );
  assert.equal((await git(source, ['rev-parse', 'HEAD'])).trim(), divergedHead);
  setBusy(true);
  await expectCode(
    service.integrate({ id: worktree.id, revision: worktree.revision, confirm: true, ...divergedHeads }),
    'worktree_busy',
  );
  setBusy(false);
});

test('diverged task can merge target branch task-side then final FF succeeds', async (t) => {
  const { service, source } = await fixture(t);
  const { worktree } = await service.create({ projectCwd: source, name: 'merge flow' });
  await writeFile(join(worktree.path, 'app.txt'), 'task-line\n', 'utf8');
  await commitAll(worktree.path, 'task edit');
  await writeFile(join(source, 'other.txt'), 'main-line\n', 'utf8');
  await commitAll(source, 'main edit');
  const divHeads = await freshHeads(service, worktree.id);
  await expectCode(
    service.integrate({ id: worktree.id, revision: worktree.revision, confirm: true, ...divHeads }),
    'worktree_not_fast_forward',
  );
  await git(worktree.path, ['merge', worktree.sourceBranch, '-m', 'merge main into task']);
  const resolvedHead = (await git(worktree.path, ['rev-parse', 'HEAD'])).trim();
  const fresh = await service.inspect({ id: worktree.id });
  assert.equal(fresh.task.clean, true);
  const done = await service.integrate({
    id: worktree.id,
    revision: worktree.revision,
    confirm: true,
    expectedSourceHead: fresh.main.head,
    expectedWorktreeHead: resolvedHead,
  });
  assert.equal(done.integrated, true);
  assert.equal((await git(source, ['rev-parse', 'HEAD'])).trim(), resolvedHead);
  assert.equal(await readFile(join(source, 'app.txt'), 'utf8'), 'task-line\n');
});

test('remove of clean worktree deletes managed path and retains branch', async (t) => {
  const { service, source } = await fixture(t);
  const { worktree } = await service.create({ projectCwd: source, name: 'bye' });
  await writeFile(join(worktree.path, 'app.txt'), 'v9\n', 'utf8');
  await commitAll(worktree.path, 'task work');
  const byeHeads = await freshHeads(service, worktree.id);
  await service.integrate({ id: worktree.id, revision: worktree.revision, confirm: true, ...byeHeads });
  const current = await service.inspect({ id: worktree.id });
  const out = await service.remove({ id: worktree.id, revision: current.worktree.revision, confirm: true });
  assert.equal(out.removed, true);
  assert.equal(out.branchRetained, worktree.branch);
  assert.equal(await stat(worktree.path).then(() => true).catch(() => false), false);
  const branches = await git(source, ['branch', '--list', worktree.branch]);
  assert.ok(branches.includes(worktree.branch.replace('studio/', '')) || branches.includes(worktree.branch));
  assert.equal((await service.list({ projectCwd: source })).worktrees.length, 0);
});

test('remove requires discard for dirty or unmerged work and never deletes branch', async (t) => {
  const { service, source } = await fixture(t);
  const { worktree } = await service.create({ projectCwd: source, name: 'keep safe' });
  await writeFile(join(worktree.path, 'app.txt'), 'dirty\n', 'utf8');
  await expectCode(service.remove({ id: worktree.id, revision: worktree.revision, confirm: true }), 'worktree_dirty');
  assert.ok(await stat(worktree.path).then(() => true));
  const removed = await service.remove({ id: worktree.id, revision: worktree.revision, confirm: true, discard: true });
  assert.equal(removed.removed, true);
  const second = await service.create({ projectCwd: source, name: 'keep safe 2' });
  await writeFile(join(second.worktree.path, 'app.txt'), 'committed-ahead\n', 'utf8');
  await commitAll(second.worktree.path, 'ahead commit');
  await expectCode(
    service.remove({ id: second.worktree.id, revision: second.worktree.revision, confirm: true }),
    'worktree_unmerged',
  );
  const removed2 = await service.remove({
    id: second.worktree.id,
    revision: second.worktree.revision,
    confirm: true,
    discard: true,
  });
  assert.equal(removed2.removed, true);
  assert.equal(removed2.branchRetained, second.worktree.branch);
  const branches = await git(source, ['branch', '--list']);
  assert.ok(branches.includes(second.worktree.branch));
});

test('path traversal names stay managed and tampered entries cannot escape', async (t) => {
  const { service, source, dataDir } = await fixture(t);
  const { worktree } = await service.create({ projectCwd: source, name: '../../evil-escape' });
  assert.ok(resolve(worktree.path).startsWith(resolve(join(dataDir, 'worktrees'))));
  await expectCode(service.inspect({ id: 'wt-notfound12' }), 'worktree_missing');
  const travHeads = await freshHeads(service, worktree.id);
  await expectCode(
    service.integrate({ id: worktree.id, revision: 'stale', confirm: true, ...travHeads }),
    'worktree_conflict',
  );
  const outside = join(source, 'outside-marker.txt');
  await writeFile(outside, 'do-not-touch\n', 'utf8');
  const fs = await import('node:fs/promises');
  const registryFile = join(dataDir, 'worktrees.json');
  const raw = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  raw.worktrees[0].path = outside;
  await fs.writeFile(registryFile, JSON.stringify(raw), 'utf8');
  await expectCode(
    service.remove({ id: worktree.id, revision: worktree.revision, confirm: true, discard: true }),
    'worktree_ownership',
  );
  assert.equal(await readFile(outside, 'utf8'), 'do-not-touch\n');
});

test('repository with an assigned smudge filter driver is rejected explicitly', async (t) => {
  const { service, source } = await fixture(t);
  await git(source, ['config', 'filter.fakedrv.smudge', 'cat']);
  await writeFile(join(source, '.gitattributes'), '*.bin filter=fakedrv\n', 'utf8');
  await writeFile(join(source, 'blob.bin'), 'binary-ish\n', 'utf8');
  await commitAll(source, 'add filtered file');
  const error = await expectCode(service.create({ projectCwd: source, name: 'filtered' }), 'worktree_unsupported');
  assert.ok(error.message.includes('fakedrv'));
  assert.equal((await service.list({ projectCwd: source })).worktrees.length, 0);
});

test('non-git and unborn repositories fail safely', async (t) => {
  const { service, root } = await fixture(t);
  const plain = join(root, 'plain');
  await mkdir(plain, { recursive: true });
  await expectCode(service.create({ projectCwd: plain, name: 'nope' }), 'worktree_invalid');
  const unborn = join(root, 'unborn');
  await mkdir(unborn, { recursive: true });
  await git(unborn, ['init', '-b', 'main']);
  await expectCode(service.create({ projectCwd: unborn, name: 'nope' }), 'worktree_invalid');
});

test('registry persists across reload and corrupt files fail closed with data retained', async (t) => {
  const { service, source, dataDir, refresh } = await fixture(t);
  const { worktree } = await service.create({ projectCwd: source, name: 'persist' });
  const again = refresh();
  const listed = await again.list({ projectCwd: source });
  assert.equal(listed.worktrees.length, 1);
  assert.equal(listed.worktrees[0].id, worktree.id);
  assert.equal(listed.worktrees[0].sessionId, null);
  const fs = await import('node:fs/promises');
  const registryFile = join(dataDir, 'worktrees.json');
  const good = await fs.readFile(registryFile, 'utf8');
  await fs.writeFile(registryFile, '{corrupt json', 'utf8');
  const broken = refresh();
  await expectCode(broken.list({ projectCwd: source }), 'worktree_corrupt');
  await expectCode(broken.create({ projectCwd: source, name: 'nope' }), 'worktree_corrupt');
  assert.equal(await fs.readFile(registryFile, 'utf8'), '{corrupt json');
  await fs.writeFile(registryFile, good, 'utf8');
  assert.equal((await broken.list({ projectCwd: source })).worktrees.length, 1);
});

test('contaminated hook guard fails closed without deleting anything', async (t) => {
  const { service, source, dataDir } = await fixture(t);
  const fs = await import('node:fs/promises');
  const guard = join(dataDir, 'worktrees-nohooks');
  await fs.mkdir(guard, { recursive: true });
  await fs.writeFile(join(guard, 'stray.txt'), 'do-not-delete\n', 'utf8');
  const error = await expectCode(service.create({ projectCwd: source, name: 'guarded' }), 'worktree_invalid');
  assert.ok(error.message.includes('Hook guard'));
  assert.equal(await fs.readFile(join(guard, 'stray.txt'), 'utf8'), 'do-not-delete\n');
  assert.equal((await service.list({ projectCwd: source })).worktrees.length, 0);
});

test('exact-name and macro filter rules are rejected explicitly', async (t) => {
  const { service, source } = await fixture(t);
  await git(source, ['config', 'filter.fakedrv.smudge', 'cat']);
  await writeFile(join(source, '.gitattributes'), 'exact.bin filter=fakedrv\n', 'utf8');
  await writeFile(join(source, 'exact.bin'), 'exact\n', 'utf8');
  await commitAll(source, 'add exact filtered file');
  const error = await expectCode(service.create({ projectCwd: source, name: 'exact' }), 'worktree_unsupported');
  assert.ok(error.message.includes('fakedrv'));
  const { service: service2, source: source2 } = await fixture(t);
  await git(source2, ['config', 'filter.fakedrv.smudge', 'cat']);
  await writeFile(join(source2, '.gitattributes'), '[attr]datamacro filter=fakedrv\n*.dat datamacro\n', 'utf8');
  await writeFile(join(source2, 'file.dat'), 'data\n', 'utf8');
  await commitAll(source2, 'add macro filtered file');
  const error2 = await expectCode(service2.create({ projectCwd: source2, name: 'macro' }), 'worktree_unsupported');
  assert.ok(error2.message.includes('fakedrv'));
});

test('rename in worktree reports the destination path', async (t) => {
  const { service, source } = await fixture(t);
  const { worktree } = await service.create({ projectCwd: source, name: 'renamer' });
  await git(worktree.path, ['mv', 'app.txt', 'renamed.txt']);
  const seen = await service.inspect({ id: worktree.id });
  assert.ok(seen.files.some((f) => f.path === 'renamed.txt'), JSON.stringify(seen.files));
  assert.ok(!seen.files.some((f) => f.path === 'app.txt'));
});

test('large patch truncates within byte cap and stays valid utf8', async (t) => {
  const { service, source } = await fixture(t);
  const { worktree } = await service.create({ projectCwd: source, name: 'big' });
  await writeFile(join(worktree.path, 'app.txt'), `${'line-\u00e9-padding\n'.repeat(45000)}`, 'utf8');
  await commitAll(worktree.path, 'big change');
  const seen = await service.inspect({ id: worktree.id });
  assert.equal(seen.diff.truncated, true);
  assert.ok(seen.diff.bytes <= 262144 + 100, `bytes=${seen.diff.bytes}`);
  assert.equal(Buffer.byteLength(seen.diff.patch, 'utf8'), seen.diff.bytes);
  assert.ok(seen.diff.patch.includes('line-\u00e9'));
});

test('symlinked worktree path cannot escape managed ownership on remove', async (t) => {
  const { service, source, dataDir } = await fixture(t);
  const fs = await import('node:fs/promises');
  const { worktree } = await service.create({ projectCwd: source, name: 'linked' });
  const target = join(source, 'real-target');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(join(target, 'keep.txt'), 'keep\n', 'utf8');
  const link = join(dataDir, 'worktrees', 'evil-link');
  try {
    await fs.symlink(target, link, 'junction');
  } catch {
    t.skip('symlinks need privileges on this machine');
    return;
  }
  const registryFile = join(dataDir, 'worktrees.json');
  const raw = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  raw.worktrees[0].path = link;
  await fs.writeFile(registryFile, JSON.stringify(raw), 'utf8');
  await expectCode(
    service.remove({ id: worktree.id, revision: worktree.revision, confirm: true, discard: true }),
    'worktree_ownership',
  );
  assert.equal(await fs.readFile(join(target, 'keep.txt'), 'utf8'), 'keep\n');
});

test('findByPath returns entry, null on miss, corrupt fails closed', async (t) => {
  const { service, source, dataDir, refresh } = await fixture(t);
  const { worktree } = await service.create({ projectCwd: source, name: 'found' });
  const hit = await service.findByPath({ path: worktree.path });
  assert.equal(hit?.id, worktree.id);
  assert.equal(hit?.branch, worktree.branch);
  assert.equal(await service.findByPath({ path: join(dataDir, 'worktrees', 'nope') }), null);
  await expectCode(service.findByPath({ path: 'relative/path' }), 'worktree_invalid');
  const fs = await import('node:fs/promises');
  const registryFile = join(dataDir, 'worktrees.json');
  const good = await fs.readFile(registryFile, 'utf8');
  await fs.writeFile(registryFile, '{corrupt json', 'utf8');
  await expectCode(refresh().findByPath({ path: worktree.path }), 'worktree_corrupt');
  await fs.writeFile(registryFile, good, 'utf8');
  assert.equal((await service.findByPath({ path: worktree.path }))?.id, worktree.id);
});

test('bindSession stores nullable session id with CAS revision', async (t) => {
  const { service, source, refresh } = await fixture(t);
  const { worktree } = await service.create({ projectCwd: source, name: 'bound' });
  assert.equal(worktree.sessionId, null);
  const bound = await service.bindSession({ id: worktree.id, revision: worktree.revision, sessionId: 'sess_abc-123' });
  assert.equal(bound.worktree.sessionId, 'sess_abc-123');
  assert.notEqual(bound.worktree.revision, worktree.revision);
  await expectCode(
    service.bindSession({ id: worktree.id, revision: worktree.revision, sessionId: 'sess_other' }),
    'worktree_conflict',
  );
  await expectCode(
    service.bindSession({ id: worktree.id, revision: bound.worktree.revision, sessionId: 'bad id!' }),
    'worktree_invalid',
  );
  const seen = await service.inspect({ id: worktree.id });
  assert.equal(seen.worktree.sessionId, 'sess_abc-123');
  assert.equal((await refresh().list({ projectCwd: source })).worktrees[0].sessionId, 'sess_abc-123');
  const unbound = await service.bindSession({ id: worktree.id, revision: bound.worktree.revision, sessionId: null });
  assert.equal(unbound.worktree.sessionId, null);
});
