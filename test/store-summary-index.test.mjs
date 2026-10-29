import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { pageHistoryMessages } from '../lib/history-page.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-index-'));
  const options = {
    sessionDir: join(root, 'sessions'),
    dataDir: join(root, 'local'),
    initialCwd: join(root, 'projet'),
  };
  await Promise.all([mkdir(options.sessionDir, { recursive: true }), mkdir(options.initialCwd)]);
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function native(id, entries) {
    const directory = join(options.sessionDir, 'native-project');
    await mkdir(directory, { recursive: true });
    const file = join(directory, `2026-09-04T00-00-00_${id}.jsonl`);
    const header = { type: 'session', id, cwd: options.initialCwd, timestamp: '2026-09-04T00:00:00.000Z' };
    await writeFile(file, [header, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n');
    return file;
  }
  return { root, options, native };
}

const message = (id, parentId, role, content, extra = {}) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-09-04T00:01:00.000Z',
  message: { role, content, ...extra },
});

// Counts JSONL payload reads (createReadStream is only used for those).
function countPayloadOpens() {
  const counts = new Map();
  const orig = fs.createReadStream;
  fs.createReadStream = function (path, ...rest) {
    if (typeof path === 'string' && path.endsWith('.jsonl')) counts.set(path, (counts.get(path) || 0) + 1);
    return orig.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  return {
    total: () => [...counts.values()].reduce((a, b) => a + b, 0),
    forFile: (file) => counts.get(file) || 0,
    reset: () => counts.clear(),
    restore() {
      fs.createReadStream = orig;
      syncBuiltinESMExports();
    },
  };
}

// Representative session: named title, branch switch, model change, thinking,
// git state, so summary parity covers branch/title/model/count/git semantics.
function richEntries(tag, { named = true } = {}) {
  const entries = [
    message(`root-${tag}`, null, 'user', `Task ${tag}`),
    message(`old-${tag}`, `root-${tag}`, 'assistant', `Abandoned ${tag}`, {
      provider: 'anthropic',
      model: 'claude-old',
    }),
    message(`use-${tag}`, `root-${tag}`, 'user', `Use this branch ${tag}`),
    {
      type: 'thinking_level_change',
      id: `think-${tag}`,
      parentId: `use-${tag}`,
      thinkingLevel: 'high',
      timestamp: '2026-09-04T00:02:00.000Z',
    },
    {
      type: 'model_change',
      id: `model-${tag}`,
      parentId: `think-${tag}`,
      provider: 'anthropic',
      modelId: 'claude-new',
      timestamp: '2026-09-04T00:03:00.000Z',
    },
    message(`answer-${tag}`, `model-${tag}`, 'assistant', `Final ${tag}`, {
      provider: 'anthropic',
      model: 'claude-new',
    }),
    {
      type: 'git_state',
      id: `git-${tag}`,
      parentId: `answer-${tag}`,
      git: { branch: `feat/${tag}`, commit: 'abc123', repoUrl: 'https://example.com/repo.git' },
      timestamp: '2026-09-04T00:04:00.000Z',
    },
  ];
  if (named)
    entries.push({
      type: 'session_info',
      id: `name-${tag}`,
      parentId: `git-${tag}`,
      name: `Renamed ${tag}`,
      timestamp: '2026-09-04T00:05:00.000Z',
    });
  return entries;
}

test('the summary index omits Goal contents while selected history retains the native Goal', async (t) => {
  const { options, native } = await fixture(t);
  const goal = {
    goalId: 'goal-index',
    objective: 'Keep the private objective in native session history',
    status: 'paused',
    tokensUsed: 12,
    tokenBudget: 100,
    timeUsedSeconds: 4,
    continuationsUsed: 1,
  };
  await native('goal-index', [
    message('root-goal-index', null, 'user', 'Continue this work'),
    {
      type: 'custom',
      id: 'goal-state-index',
      parentId: 'root-goal-index',
      customType: 'thread_goal_state',
      data: goal,
    },
  ]);
  const store = createStore(options);
  await store.overview();
  const index = JSON.parse(await readFile(join(options.dataDir, 'session-index.json'), 'utf8'));
  const row = Object.values(index.entries)[0];
  assert.ok(row);
  assert.equal(Object.hasOwn(row.summary, 'goal'), false);
  assert.equal(JSON.stringify(index).includes(goal.objective), false);
  assert.equal((await createStore(options).history('goal-index')).goal.objective, goal.objective);
});

function stripSessions(overview) {
  return {
    totalSessions: overview.totalSessions,
    projects: overview.projects.map((p) => ({
      cwd: p.cwd,
      sessions: p.sessions.map((s) => ({ ...s })),
    })),
  };
}

test('indexed second-process overview opens no JSONL payloads and matches parity', async (t) => {
  const { options, native } = await fixture(t);
  const ids = Array.from({ length: 12 }, (_, i) => `session-${i}`);
  for (const id of ids) await native(id, richEntries(id));
  const store1 = createStore(options);
  const opens = countPayloadOpens();
  t.after(() => opens.restore());
  const first = await store1.overview();
  assert.equal(opens.total(), ids.length);
  const indexRaw = await readFile(join(options.dataDir, 'session-index.json'), 'utf8');
  const index = JSON.parse(indexRaw);
  assert.equal(index.version, 1);
  assert.equal(Object.keys(index.entries).length, ids.length);
  assert.ok(!indexRaw.includes('Abandoned session-0'), 'index stores no message contents');

  // Second process: same data dirs, fresh store.
  const store2 = createStore(options);
  opens.reset();
  const second = await store2.overview();
  assert.equal(opens.total(), 0);
  assert.deepEqual(stripSessions(second), stripSessions(first));

  // Third process via history-first, then overview: same parity.
  const store3 = createStore(options);
  const single = await store3.history('session-3');
  assert.equal(single.title, 'Renamed session-3');
  assert.equal(single.messageCount, 3);
  assert.equal(single.model, 'anthropic/claude-new');
  assert.equal(single.thinking, 'high');
  assert.equal(single.git.branch, 'feat/session-3');
  opens.reset();
  const third = await store3.overview();
  assert.deepEqual(stripSessions(third), stripSessions(first));
});

test('changed file reparses only it; selected history opens only its file', async (t) => {
  const { options, native } = await fixture(t);
  const ids = Array.from({ length: 8 }, (_, i) => `s-${i}`);
  for (const id of ids) await native(id, richEntries(id));
  const seed = createStore(options);
  await seed.overview();
  const opens = countPayloadOpens();
  t.after(() => opens.restore());

  // Append to one session: next process reparses exactly that file.
  const targetFile = join(options.sessionDir, 'native-project', '2026-09-04T00-00-00_s-5.jsonl');
  await appendFile(
    targetFile,
    JSON.stringify(message('follow-5', 'answer-s-5', 'user', 'Follow-up')) +
      '\n' +
      JSON.stringify(message('answer2-5', 'follow-5', 'assistant', 'Done')) +
      '\n',
  );
  const store2 = createStore(options);
  opens.reset();
  const ov = await store2.overview();
  assert.equal(opens.total(), 1);
  assert.equal(opens.forFile(targetFile), 1);
  const changed = ov.projects.flatMap((p) => p.sessions).find((s) => s.id === 's-5');
  assert.equal(changed.messageCount, 5);

  // Selected history touches only its own file.
  const store3 = createStore(options);
  opens.reset();
  const h = await store3.history('s-2');
  assert.equal(opens.total(), 1);
  assert.equal(h.messages.map((m) => m.id).join(','), 'root-s-2,use-s-2,answer-s-2');
  assert.ok(!h.messages.some((m) => (m.text || '').includes('Abandoned')), 'abandoned branch excluded');
  // historyPage works on the single-loaded history.
  const page = pageHistoryMessages(h, { limit: 1 });
  assert.equal(page.messages.length, 1);
  assert.equal(page.historyPage.total, 3);
  // Repeat read is served from memory without reopening.
  opens.reset();
  await store3.history('s-2');
  assert.equal(opens.total(), 0);
});

test('concurrent overviews and history share one parse, not one scan per caller', async (t) => {
  const { options, native } = await fixture(t);
  for (let i = 0; i < 6; i++) await native(`c-${i}`, richEntries(`c-${i}`));
  const store = createStore(options);
  const opens = countPayloadOpens();
  t.after(() => opens.restore());
  const [a, b, h] = await Promise.all([store.overview(), store.overview(), store.history('c-4')]);
  assert.equal(opens.total(), 6);
  assert.equal(a.totalSessions, 6);
  assert.deepEqual(
    a.projects.flatMap((p) => p.sessions.map((s) => s.id)).sort(),
    b.projects.flatMap((p) => p.sessions.map((s) => s.id)).sort(),
  );
  assert.equal(h.id, 'c-4');
});

test('corrupt, version-mismatched and row-damaged index rebuilds safely', async (t) => {
  const { options, native } = await fixture(t);
  for (let i = 0; i < 4; i++) await native(`k-${i}`, richEntries(`k-${i}`));
  const seed = createStore(options);
  const expected = stripSessions(await seed.overview());
  const opens = countPayloadOpens();
  t.after(() => opens.restore());
  const indexPath = join(options.dataDir, 'session-index.json');

  for (const damage of ['not-json{{{', JSON.stringify({ version: 999, entries: {} })]) {
    await writeFile(indexPath, damage);
    const store = createStore(options);
    opens.reset();
    const ov = await store.overview();
    assert.equal(opens.total(), 4);
    assert.deepEqual(stripSessions(ov), expected);
  }

  // Row-level damage: garbage row, wrong-id row, external-path row.
  const good = JSON.parse(await readFile(indexPath, 'utf8'));
  const files = Object.keys(good.entries);
  good.entries[files[0]] = 42;
  good.entries[files[1]] = { size: 1, mtimeMs: 2, summary: { id: 'k-2' }, answer: '' };
  good.entries[join(tmpdir(), 'outside.jsonl')] = {
    size: 10,
    mtimeMs: 20,
    summary: { id: 'ghost', title: 'Ghost' },
    answer: '',
  };
  await writeFile(indexPath, JSON.stringify(good));
  const store2 = createStore(options);
  opens.reset();
  const ov2 = await store2.overview();
  assert.deepEqual(stripSessions(ov2), expected);
  const healed = JSON.parse(await readFile(indexPath, 'utf8'));
  assert.ok(!Object.keys(healed.entries).some((k) => k.includes('outside.jsonl')));
});

test('valid-id rows with poisoned shapes are sanitized or rebuilt', async (t) => {
  const { options, native } = await fixture(t);
  for (let i = 0; i < 3; i++) await native(`p-${i}`, richEntries(`p-${i}`));
  const seed = createStore(options);
  const expected = stripSessions(await seed.overview());
  const indexPath = join(options.dataDir, 'session-index.json');
  const poisoned = JSON.parse(await readFile(indexPath, 'utf8'));
  const files = Object.keys(poisoned.entries);
  // Same valid ids, unusable shapes: object cwd/title, injected messages/file,
  // mistyped count/git/answer, and unknown keys. Must not break bootstrap.
  poisoned.entries[files[0]].summary.cwd = { evil: true };
  poisoned.entries[files[1]].summary.title = { evil: true };
  poisoned.entries[files[1]].summary.messages = [{ id: 'x' }];
  poisoned.entries[files[1]].summary.file = files[1];
  poisoned.entries[files[1]].summary.bonus = 'nope';
  poisoned.entries[files[2]].summary.messageCount = 'many';
  poisoned.entries[files[2]].summary.git = 'broken';
  poisoned.entries[files[2]].answer = 42;
  await writeFile(indexPath, JSON.stringify(poisoned));
  const opens = countPayloadOpens();
  t.after(() => opens.restore());
  const store2 = createStore(options);
  const ov = await store2.overview();
  assert.deepEqual(stripSessions(ov), expected);
  const healed = JSON.parse(await readFile(indexPath, 'utf8'));
  const allowed = [
    'id',
    'cwd',
    'title',
    'createdAt',
    'updatedAt',
    'model',
    'thinking',
    'messageCount',
    'git',
  ].sort();
  for (const row of Object.values(healed.entries)) {
    assert.deepEqual(Object.keys(row.summary).sort(), allowed);
    assert.equal(typeof row.summary.messageCount, 'number');
    assert.ok(typeof row.summary.title === 'string');
    assert.ok(row.summary.cwd === null || typeof row.summary.cwd === 'string');
    assert.ok(row.summary.git === null || typeof row.summary.git === 'object');
    assert.equal(typeof row.answer, 'string');
  }
  assert.ok(!JSON.stringify(healed).includes('"messages"'));
});

test('history then markUnread/markRead before first overview survives seeding', async (t) => {
  const { options, native } = await fixture(t);
  await native('u-0', richEntries('u-0'));
  await native('u-1', richEntries('u-1'));
  const store1 = createStore(options);
  await store1.history('u-0');
  const unread = await store1.markUnread({ id: 'u-0' });
  assert.equal(unread.readState.read, '');
  await store1.history('u-1');
  const read = await store1.markRead({ id: 'u-1', answer: 'answer-u-1' });
  assert.equal(read.readState.read, 'answer-u-1');
  // First overview seeds missing receipts but must preserve explicit ones.
  const ov = await store1.overview();
  const byId = Object.fromEntries(ov.projects.flatMap((p) => p.sessions).map((s) => [s.id, s.readState]));
  assert.equal(byId['u-0'].read, '');
  assert.equal(byId['u-0'].answer, 'answer-u-0');
  assert.equal(byId['u-1'].read, 'answer-u-1');
  const store2 = createStore(options);
  assert.deepEqual(stripSessions(await store2.overview()), stripSessions(ov));
});

test('receipts, branches and read state keep parity across processes', async (t) => {
  const { options, native } = await fixture(t);
  for (let i = 0; i < 3; i++) await native(`r-${i}`, richEntries(`r-${i}`));
  const store1 = createStore(options);
  await store1.overview();
  const read = await store1.markRead({ id: 'r-0', answer: 'answer-r-0' });
  assert.equal(read.readState.answer, 'answer-r-0');
  const unread = await store1.markUnread({ id: 'r-1' });
  assert.equal(unread.readState.read, '');

  const store2 = createStore(options);
  const ov1 = stripSessions(await store1.overview());
  const ov2 = stripSessions(await store2.overview());
  assert.deepEqual(ov2, ov1);
  const h1 = await store1.history('r-0');
  const h2 = await store2.history('r-0');
  assert.deepEqual(h2, h1);
});

test('append, rename and delete converge without stale summaries', async (t) => {
  const { options, native } = await fixture(t);
  await native('a-0', richEntries('a-0'));
  const file0 = join(options.sessionDir, 'native-project', '2026-09-04T00-00-00_a-0.jsonl');
  await native('a-1', richEntries('a-1'));
  const seed = createStore(options);
  await seed.overview();
  const opens = countPayloadOpens();
  t.after(() => opens.restore());

  // Rename: same session under a new file, no duplicate, one reparse.
  const renamed = join(options.sessionDir, 'native-project', '2026-09-04T00-00-00_a-0-moved.jsonl');
  await rename(file0, renamed);
  const store2 = createStore(options);
  opens.reset();
  const ov = await store2.overview();
  assert.equal(opens.total(), 1);
  const ids = ov.projects.flatMap((p) => p.sessions.map((s) => s.id)).sort();
  assert.deepEqual(ids, ['a-0', 'a-1']);
  const healed = JSON.parse(await readFile(join(options.dataDir, 'session-index.json'), 'utf8'));
  assert.ok(!Object.keys(healed.entries).includes(file0));

  // Delete: session disappears and history 404s.
  const { rm: remove } = await import('node:fs/promises');
  await remove(join(options.sessionDir, 'native-project', '2026-09-04T00-00-00_a-1.jsonl'));
  const store3 = createStore(options);
  const ov3 = await store3.overview();
  assert.deepEqual(
    ov3.projects.flatMap((p) => p.sessions.map((s) => s.id)),
    ['a-0'],
  );
  await assert.rejects(store3.history('a-1'), { status: 404 });
});

test('index entries outside sessionDir are never trusted', async (t) => {
  const { options, native } = await fixture(t);
  await native('inside', richEntries('inside'));
  const seed = createStore(options);
  await seed.overview();
  const indexPath = join(options.dataDir, 'session-index.json');

  // Attacker plants an external session file and a matching index row.
  const outsideDir = await mkdtemp(join(tmpdir(), 'prime-studio-outside-'));
  t.after(async () => rm(outsideDir, { recursive: true, force: true }));
  const outsideFile = join(outsideDir, 'evil.jsonl');
  await writeFile(
    outsideFile,
    JSON.stringify({
      type: 'session',
      id: 'ghost',
      cwd: options.initialCwd,
      timestamp: '2026-09-04T00:00:00.000Z',
    }) +
      '\n' +
      JSON.stringify(message('g', null, 'user', 'Ghost content')) +
      '\n',
  );
  const poisoned = JSON.parse(await readFile(indexPath, 'utf8'));
  poisoned.entries[outsideFile] = {
    size: 10,
    mtimeMs: 20,
    summary: { id: 'ghost', title: 'Ghost', messageCount: 1 },
    answer: '',
  };
  await writeFile(indexPath, JSON.stringify(poisoned));

  const opens = countPayloadOpens();
  t.after(() => opens.restore());
  const store2 = createStore(options);
  opens.reset();
  await assert.rejects(store2.history('ghost'), { status: 404 });
  assert.equal(opens.forFile(outsideFile), 0);
  const ov = await store2.overview();
  assert.ok(!ov.projects.flatMap((p) => p.sessions).some((s) => s.id === 'ghost'));
});

test('benchmark: synthetic sample reports first-run vs indexed costs', async (t) => {
  const { options, native } = await fixture(t);
  const N = 25;
  for (let i = 0; i < N; i++) {
    const entries = [];
    let parent = null;
    for (let m = 0; m < 40; m++) {
      const role = m % 2 === 0 ? 'user' : 'assistant';
      const id = `b-${i}-${m}`;
      entries.push(
        message(id, parent, role, `Bench ${i} message ${m} with some payload text to enlarge the file`),
      );
      parent = id;
    }
    await native(`bench-${i}`, entries);
  }
  const cold = createStore(options);
  const t0 = Date.now();
  const ov1 = await cold.overview();
  const coldMs = Date.now() - t0;
  assert.equal(ov1.totalSessions, N);
  const warm = createStore(options);
  const t1 = Date.now();
  const opens = countPayloadOpens();
  t.after(() => opens.restore());
  const ov2 = await warm.overview();
  const warmMs = Date.now() - t1;
  assert.equal(opens.total(), 0);
  assert.equal(ov2.totalSessions, N);
  console.log(
    `index-benchmark sessions=${N} cold_ms=${coldMs} indexed_ms=${warmMs} cold_opens=${N} indexed_opens=0`,
  );
});
