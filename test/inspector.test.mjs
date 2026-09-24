import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createProjectFiles, projectPath } from '../lib/project-files.mjs';
import { pathToFileURL } from 'node:url';
import { createSessionInspector, agentStatus } from '../lib/session-inspector.mjs';
import { createStore } from '../lib/store.mjs';
const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-inspector-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const store = {
    findProject: async (value) => {
      if (value !== cwd) throw Object.assign(new Error('Projet inconnu'), { status: 404 });
      return { cwd };
    },
  };
  const files = createProjectFiles({ store });
  const git = (...args) => exec('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 10000 });
  return { root, cwd, files, git };
}

test('document references resolve relative/absolute paths, locations and unique basenames inside the project only', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, 'docs'));
  const name = 'plan é.md',
    path = join(f.cwd, 'docs', name);
  await writeFile(path, '# Plan');
  for (const reference of [
    'docs/plan%20%C3%A9.md',
    path,
    pathToFileURL(path).href,
    'docs/plan é.md:45',
    name,
  ]) {
    assert.deepEqual(await f.files.resolveReference(f.cwd, reference), { path: 'docs/plan é.md' });
  }
  await writeFile(join(f.cwd, 'README.md'), '# Readme');
  assert.deepEqual(await f.files.resolveReference(f.cwd, '../README.md', 'docs/plan é.md'), {
    path: 'README.md',
  });
  await mkdir(join(f.cwd, 'duplicate'));
  await writeFile(join(f.cwd, 'duplicate', name), '# Other');
  assert.equal((await f.files.resolveReference(f.cwd, name)).matches.length, 2);
  for (const reference of [
    '../outside.md',
    join(f.root, 'outside.md'),
    '.git/config',
    'https://example.com/a.md',
  ])
    await assert.rejects(f.files.resolveReference(f.cwd, reference));
});
test('project browser bounds paths, ignores technical directories, pages and preserves binary downloads', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, '.local'));
  await writeFile(join(f.cwd, '.local', 'secret.txt'), 'private');
  await Promise.all(
    Array.from({ length: 105 }, (_, i) =>
      writeFile(join(f.cwd, `document-${i}.txt`), 'été <script>unsafe()</script>'),
    ),
  );
  await writeFile(join(f.cwd, 'document.bin'), Buffer.from([0, 255, 0, 3]));
  assert.equal((await f.files.list(f.cwd)).entries.length, 100);
  assert.equal((await f.files.list(f.cwd, '', 100)).entries.length, 6);
  assert.equal((await f.files.preview(f.cwd, 'document-1.txt')).text, 'été <script>unsafe()</script>');
  assert.equal((await f.files.preview(f.cwd, 'document.bin')).type, 'binary');
  assert.deepEqual((await f.files.download(f.cwd, 'document.bin')).data, Buffer.from([0, 255, 0, 3]));
  assert.equal((await f.files.changes(f.cwd)).git, false);
  for (const path of [
    '../secret',
    '.git/config',
    'node_modules/pkg/index.js',
    '/absolute',
    'C:/Windows/file',
    'document.bin:ads',
    'x\\..\\secret',
    'file\0x',
  ])
    assert.throws(() => projectPath(path));
  // Other dot folders resolve like any project path when no protected root covers them.
  assert.equal(projectPath('.local/secret.txt'), '.local/secret.txt');
  await assert.rejects(f.files.preview(f.root, 'secret.txt'), { status: 404 });
  await symlink(f.root, join(f.cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.files.list(f.cwd, 'escape'), { status: 403 });
  await assert.rejects(f.files.diff(f.cwd, 'escape/missing.txt'), { status: 403 });
  await symlink(
    join(f.cwd, '.local'),
    join(f.cwd, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.equal((await f.files.preview(f.cwd, 'alias/secret.txt')).text, 'private');
  await assert.rejects(f.files.preview(f.cwd, '.GIT/config'), { status: 403 });
  const privateRoot = join(f.cwd, 'engine');
  await mkdir(privateRoot);
  await writeFile(join(privateRoot, 'auth.json'), 'private');
  const protectedFiles = createProjectFiles({
    store: { findProject: async () => ({ cwd: f.cwd }) },
    protectedRoots: [privateRoot],
  });
  await assert.rejects(protectedFiles.download(f.cwd, 'engine/auth.json'), { status: 403 });
  assert.ok(!(await protectedFiles.list(f.cwd)).entries.some((entry) => entry.name === 'engine'));
});
test('Git shows the combined staged/working changes, added/deleted files and literal names without writing the index', async (t) => {
  const f = await fixture(t);
  await f.git('init', '-q');
  await f.git('config', 'user.name', 'Fixture');
  await f.git('config', 'user.email', 'fixture@example.test');
  await writeFile(join(f.cwd, 'tracked.txt'), 'before\n');
  await writeFile(join(f.cwd, 'removed.txt'), 'gone\n');
  await f.git('add', '.');
  await f.git('commit', '-qm', 'Fixture');
  await writeFile(join(f.cwd, 'tracked.txt'), 'staged\n');
  await f.git('add', 'tracked.txt');
  await writeFile(join(f.cwd, 'tracked.txt'), 'after\n');
  await rm(join(f.cwd, 'removed.txt'));
  await writeFile(join(f.cwd, 'new [é].txt'), 'nouveau\n');
  const index = await readFile(join(f.cwd, '.git', 'index'));
  const changes = await f.files.changes(f.cwd);
  assert.equal(changes.git, true);
  assert.equal(changes.entries.length, 3);
  assert.equal(changes.entries.find((file) => file.path === 'tracked.txt').status, 'MM');
  assert.match((await f.files.diff(f.cwd, 'tracked.txt')).text, /-before[\s\S]*\+after/);
  assert.match((await f.files.diff(f.cwd, 'removed.txt')).text, /-gone/);
  assert.match((await f.files.diff(f.cwd, 'new [é].txt')).text, /\+nouveau/);
  assert.deepEqual(await readFile(join(f.cwd, '.git', 'index')), index);
  assert.equal(await readFile(join(f.cwd, 'tracked.txt'), 'utf8'), 'after\n');
});
test('Git restricts a project nested in a repository and supports repositories without commits', async (t) => {
  const f = await fixture(t);
  await f.git('init', '-q');
  await writeFile(join(f.cwd, 'first.txt'), 'first\n');
  await f.git('add', '.');
  assert.match((await f.files.diff(f.cwd, 'first.txt')).text, /\+first/);
  const child = join(f.cwd, 'sub');
  await mkdir(child);
  await writeFile(join(child, 'inside.txt'), 'inside');
  const files = createProjectFiles({ store: { findProject: async () => ({ cwd: child }) } });
  assert.deepEqual(
    (await files.changes(child)).entries.map((file) => file.path),
    ['inside.txt'],
  );
  assert.match((await files.diff(child, 'inside.txt')).text, /\+inside/);
});
test('agent hierarchy reads only rooted native edges and overlays live activity without changing session files', async (t) => {
  const f = await fixture(t),
    agentHome = join(f.root, 'agent'),
    sessionDir = join(agentHome, 'sessions');
  await mkdir(sessionDir, { recursive: true });
  const rootId = 'root-test',
    childId = 'child-test',
    grandId = 'grand-test';
  const parentFile = join(sessionDir, 'root.jsonl'),
    childFile = join(agentHome, 'session-artifacts', rootId, 'child', 'child.jsonl'),
    grandFile = join(dirname(childFile), 'grand', 'grand.jsonl');
  const transcript = (id) =>
    [
      { type: 'session', id, cwd: f.cwd, timestamp: new Date().toISOString() },
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'Consigne' } },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Résultat <script>unsafe</script>' }],
          stopReason: 'stop',
          usage: { input: 12, output: 4, cost: { total: 0.02 } },
        },
      },
    ]
      .map(JSON.stringify)
      .join('\n');
  for (const [file, id] of [
    [parentFile, rootId],
    [childFile, 'child-session'],
    [grandFile, 'grand-session'],
  ]) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, transcript(id));
  }
  const store = createStore({ initialCwd: f.cwd, sessionDir, dataDir: join(f.root, 'data') });
  const edges = [
    { parent: parentFile, child: childFile, childId, name: 'Design' },
    { parent: childFile, child: grandFile, childId: grandId, name: 'Audit' },
    { parent: childFile, child: parentFile, childId: 'cycle', name: 'Cycle' },
  ];
  let calls = 0;
  const inspector = createSessionInspector({
    store,
    agentHome,
    sessionDir,
    readEdges: async () => edges,
    getRun: () => ({ status: 'running' }),
    getClient: () => ({
      getInspector: async () => {
        calls++;
        return {
          state: { hasRunningRlmChildren: true },
          children: [
            {
              id: childId,
              status: 'done',
              activity: { kind: 'executing' },
              sessionName: 'Design',
              parentId: rootId,
            },
          ],
        };
      },
      close() {},
    }),
  });
  const data = await inspector.inspect(f.cwd, rootId);
  assert.equal(data.session.status, 'children');
  assert.equal(data.agents.length, 3);
  assert.equal(data.agents.find((row) => row.id === childId).status, 'tool');
  assert.equal(data.agents.find((row) => row.id === grandId).parentId, childId);
  assert.equal(data.session.usage.input, 12);
  assert.equal(data.session.usage.cost, 0.02);
  assert.ok(!Object.hasOwn(data, 'files'));
  const history = await inspector.history(f.cwd, rootId, grandId);
  assert.equal(history.messages.at(-1).text, 'Résultat <script>unsafe</script>');
  await assert.rejects(inspector.history(f.cwd, rootId, 'unrelated'), { status: 404 });
  assert.equal(calls, 1, 'Concurrent views reuse a bounded snapshot');
  assert.equal(
    await readFile(parentFile, 'utf8'),
    transcript(rootId).replace(
      /"timestamp":"[^"]+"/,
      (await readFile(parentFile, 'utf8')).match(/"timestamp":"[^"]+"/)[0],
    ),
  );
  assert.equal(agentStatus({ isCompacting: true, isStreaming: true }), 'compacting');
});

test('0.9.5 child progress uses native monotonic age and never marks an executing tool stale', async () => {
  const root = { id: 'root-progress', cwd: '/fixture', file: '/fixture/session.jsonl', messages: [] };
  async function project(child) {
    const inspector = createSessionInspector({
      store: { findProject: async () => ({ cwd: root.cwd }), history: async () => root },
      agentHome: '/fixture/agent',
      sessionDir: '/fixture/sessions',
      readEdges: async () => [],
      getRun: () => ({ status: 'running' }),
      getClient: () => ({
        getInspector: async () => ({
          state: {},
          children: [{ id: 'child-progress', status: 'running', ...child }],
        }),
        close() {},
      }),
    });
    return (await inspector.inspect(root.cwd, root.id)).agents.find((a) => a.id === 'child-progress');
  }
  const executing = await project({
    activity: { kind: 'executing' },
    progressNote: 'Checking <script>literal</script>',
    lastActivityAt: 1800000000000,
    activityStaleMs: 900000,
  });
  assert.equal(executing.progressNote, 'Checking <script>literal</script>');
  assert.equal(executing.lastActivityAt, 1800000000000);
  assert.equal(executing.activityStaleMs, undefined);
  assert.equal(executing.status, 'tool');
  const waiting = await project({
    activity: { kind: 'waiting' },
    progressNote: 'x'.repeat(700),
    activityStaleMs: 65000,
    lastActivityAt: 1800000000000,
  });
  assert.equal(waiting.progressNote.length, 512);
  assert.equal(waiting.activityStaleMs, 65000);
  assert.equal(waiting.status, 'waiting');
  const invalid = await project({
    progressNote: { secret: true },
    lastActivityAt: Infinity,
    activityStaleMs: -10,
  });
  assert.equal(invalid.progressNote, '');
  assert.equal(invalid.lastActivityAt, undefined);
  assert.equal(invalid.activityStaleMs, undefined);
});
