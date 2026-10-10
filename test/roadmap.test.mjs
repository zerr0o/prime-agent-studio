import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRoadmapService } from '../lib/roadmap.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'prime-roadmap-test-'));
  const changes = [];
  const options = {
    resolveProject: async (requested) => {
      assert.equal(requested, cwd);
      return { cwd, name: 'Projet de test' };
    },
    onChange: (project, value) => changes.push({ project, value }),
  };
  const service = createRoadmapService(options);
  const second = createRoadmapService(options);
  const file = join(cwd, '.prime', 'studio', 'roadmap.json');
  t.after(async () => {
    await service.close();
    await second.close();
    assert.equal(dirname(cwd), resolve(tmpdir()));
    await rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  const change = async (action, params = {}, actor) =>
    service.mutate(cwd, { action, expectedRevision: (await service.read(cwd)).revision, ...params }, actor);
  return { cwd, file, service, second, change, changes };
}

test('Roadmap reads do not create storage; initialization is idempotent and emits only committed changes', async (t) => {
  const { cwd, service, change, changes } = await fixture(t);
  const before = await service.read(cwd);
  assert.equal(before.initialized, false);
  assert.deepEqual(before.progress, { done: 0, total: 0, percent: 0 });
  assert.deepEqual(await readdir(cwd), []);
  assert.match(await service.exportMarkdown(cwd), /non initialisée/);
  assert.deepEqual(await readdir(cwd), []);
  await assert.rejects(change('vision', { text: 'Avant init' }), { code: 'roadmap_uninitialized' });
  assert.deepEqual(await readdir(cwd), []);
  const initial = await change('init');
  assert.equal(initial.initialized, true);
  assert.equal(initial.revision, 1);
  assert.equal((await service.mutate(cwd, { action: 'init' })).revision, 1);
  assert.equal(changes.length, 1);
  const updated = await change('vision', {
    text: 'Une vision\nsur deux lignes',
    by: 'agent',
    sessionId: 'forged',
  });
  assert.equal(updated.overview.vision, 'Une vision\nsur deux lignes');
  assert.equal(updated.lastEdit.by, 'user');
  assert.equal(updated.lastEdit.sessionId, undefined);
  assert.equal(changes[1].value.revision, 2);
});

test('revoked admission cannot commit and releases the roadmap transaction lock', async (t) => {
  const { cwd, service, change, changes } = await fixture(t);
  await change('init');
  const denied = Object.assign(new Error('Revoked'), { status: 401 });
  let checks = 0;
  await assert.rejects(
    service.mutate(
      cwd,
      {
        action: 'vision',
        expectedRevision: 1,
        text: 'Must not commit',
      },
      { by: 'user' },
      {
        authorize: async () => {
          checks++;
          throw denied;
        },
      },
    ),
    { status: 401 },
  );
  assert.equal(checks, 1);
  const unchanged = await service.read(cwd);
  assert.equal(unchanged.revision, 1);
  assert.equal(unchanged.overview.vision, '');
  assert.equal(changes.length, 1);
  assert.equal((await change('vision', { text: 'Authorized' })).revision, 2);
});

test('two service instances refuse stale writes and preserve the winning transaction', async (t) => {
  const { cwd, file, service, second, change } = await fixture(t);
  await change('init');
  const results = await Promise.allSettled([
    service.mutate(cwd, { action: 'vision', expectedRevision: 1, text: 'PC' }),
    second.mutate(cwd, { action: 'vision', expectedRevision: 1, text: 'Téléphone' }),
  ]);
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
  const rejected = results.find((entry) => entry.status === 'rejected').reason;
  assert.equal(rejected.status, 409);
  assert.equal(rejected.code, 'roadmap_conflict');
  assert.equal(rejected.currentRevision, 2);
  assert.equal((await second.read(cwd)).revision, 2);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).revision, 2);
  await assert.rejects(service.mutate(cwd, { action: 'vision', text: 'Sans révision' }), {
    code: 'roadmap_invalid',
  });
});

test('independent processes share a transaction lock rather than only an in-memory queue', async (t) => {
  const { cwd, change, service } = await fixture(t);
  await change('init');
  const childSource = `import { createRoadmapService } from ${JSON.stringify(pathToFileURL(resolve('lib/roadmap.mjs')).href)};
const cwd = process.argv[1];
const service = createRoadmapService({resolveProject: async () => ({cwd, name: 'Test'})});
process.on('message', async () => {
 try { const value = await service.mutate(cwd,{action:'vision',expectedRevision:1,text:String(process.pid)}); process.send({revision:value.revision}); }
 catch(e) { process.send({code:e.code,currentRevision:e.currentRevision}); }
 await service.close(); process.disconnect();
}); process.send({ready:true});`;
  const workers = [0, 1].map(() =>
    fork('--eval', [childSource, cwd], {
      execArgv: ['--input-type=module'],
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }),
  );
  t.after(() =>
    workers.forEach((worker) => {
      if (!worker.killed) worker.kill();
    }),
  );
  await Promise.all(
    workers.map(
      (worker) =>
        new Promise((done, reject) => {
          worker.once('error', reject);
          worker.once('message', (value) =>
            value.ready ? done() : reject(new Error('Unexpected worker state')),
          );
        }),
    ),
  );
  const results = await Promise.all(
    workers.map(
      (worker) =>
        new Promise((done, reject) => {
          worker.once('message', done);
          worker.once('error', reject);
          worker.send({ go: true });
        }),
    ),
  );
  assert.equal(results.filter((entry) => entry.revision === 2).length, 1);
  assert.equal(
    results.filter((entry) => entry.code === 'roadmap_conflict' && entry.currentRevision === 2).length,
    1,
  );
  assert.equal((await service.read(cwd)).revision, 2);
});

test('leaf counts agree at every level, paused plans count, abandoned plans do not, status never forces completion', async (t) => {
  const { change, service, cwd } = await fixture(t);
  await change('init');
  const milestone = (await change('milestone.create', { title: 'Livraison' })).overview.milestones[0];
  let value = await change('plan.create', {
    title: 'Plan A',
    milestone: milestone.id,
    steps: [
      { text: 'Groupe', children: [{ text: 'A', done: true }, { text: 'B' }] },
      { text: 'C', done: true },
    ],
  });
  const first = value.plans[0];
  assert.deepEqual(first.progress, { done: 2, total: 3, percent: 67 });
  assert.equal(first.steps[0].partial, true);
  assert.equal(first.steps[0].done, false);
  value = await change('plan.create', {
    title: 'Plan B',
    milestone: milestone.id,
    status: 'paused',
    steps: [{ text: 'D' }],
  });
  const second = value.plans[1];
  assert.deepEqual(value.progress, { done: 2, total: 4, percent: 50 });
  assert.deepEqual(value.overview.milestones[0].progress, value.progress);
  value = await change('plan.patch', { planId: first.slug, status: 'done' });
  assert.equal(value.progress.percent, 50);
  value = await change('plan.patch', { planId: first.id, status: 'abandoned' });
  assert.deepEqual(value.progress, { done: 0, total: 1, percent: 0 });
  assert.equal(value.plans[0].progress.done, 2);
  assert.equal(value.plans[0].journal.length, 2);
  value = await change('backlog.add', { items: [{ text: 'Hors plan' }] });
  assert.equal(value.progress.total, 1);
  await change('backlog.set', { numbers: [1], done: true });
  value = await change('milestone.delete', { milestoneId: milestone.id });
  assert.equal(value.plans[0].milestone, null);
  assert.equal(value.plans[1].milestone, null);
  assert.equal((await service.read(cwd)).plans.find((entry) => entry.id === second.id).status, 'paused');
});

test('parent check is symmetric, bulk checks are atomic and agent attribution comes from the trusted actor', async (t) => {
  const { change, service, cwd } = await fixture(t);
  await change('init');
  let value = await change('plan.create', {
    title: 'Contrôles',
    steps: [
      { text: 'Groupe', children: [{ text: 'A' }, { text: 'B', children: [{ text: 'B1' }] }] },
      { text: 'C' },
    ],
  });
  const plan = value.plans[0];
  const group = plan.steps[0];
  value = await change(
    'step.check',
    { planId: plan.id, stepId: group.id, done: true, comment: 'Vérifié' },
    { by: 'agent', sessionId: 'child-session', rootSessionId: 'parent-session', name: 'Contrôleur' },
  );
  assert.deepEqual(value.plans[0].progress, { done: 2, total: 3, percent: 67 });
  assert.equal(value.plans[0].steps[0].done, true);
  assert.equal(value.plans[0].steps[0].partial, false);
  assert.equal(value.plans[0].journal[0].sessionId, 'child-session');
  assert.equal(value.lastEdit.rootSessionId, 'parent-session');
  value = await change('step.check', { planId: plan.id, stepId: group.id, done: false });
  assert.equal(value.plans[0].progress.done, 0);
  const revision = value.revision;
  await assert.rejects(
    change('step.check', { planId: plan.id, stepIds: [group.id, 'missing'], done: true }),
    { code: 'roadmap_missing' },
  );
  assert.equal((await service.read(cwd)).revision, revision);
  assert.equal((await service.read(cwd)).progress.done, 0);
  value = await change('step.check', { planId: plan.id, stepIds: [group.id, plan.steps[1].id], done: true });
  assert.equal(value.revision, revision + 1);
  assert.deepEqual(value.progress, { done: 3, total: 3, percent: 100 });
});

test('plan replacement preserves IDs, checks and notes and refuses implicit deletions', async (t) => {
  const { change, cwd, service } = await fixture(t);
  await change('init');
  let value = await change('plan.create', {
    title: 'Même titre',
    steps: [
      { text: 'A', done: true, note: 'Preuve conservée' },
      { text: 'B', children: [{ text: 'B1', note: 'Sous-note' }] },
    ],
  });
  const plan = value.plans[0];
  value = await change('plan.steps', {
    planId: plan.id,
    steps: [{ id: plan.steps[0].id, text: 'A renommée' }, { id: plan.steps[1].id, text: 'B' }, { text: 'C' }],
  });
  assert.equal(value.plans[0].steps[0].done, true);
  assert.equal(value.plans[0].steps[0].note, 'Preuve conservée');
  assert.equal(value.plans[0].steps[1].children[0].note, 'Sous-note');
  assert.equal(value.plans[0].steps[1].children[0].id, plan.steps[1].children[0].id);
  const revision = value.revision;
  await assert.rejects(change('plan.steps', { planId: plan.id, steps: [] }), { code: 'roadmap_invalid' });
  assert.equal((await service.read(cwd)).revision, revision);
  value = await change('plan.patch', { planId: plan.id, title: 'Un autre titre' });
  assert.equal(value.plans[0].slug, plan.slug);
  assert.equal(value.plans[0].id, plan.id);
  value = await change('plan.attach', { planId: plan.id, sessionId: 'session-1' });
  value = await change('plan.attach', { planId: plan.id, sessionId: 'session-1' });
  assert.deepEqual(value.plans[0].sessions, ['session-1']);
  await change('plan.delete', { planId: plan.id });
  value = await change('plan.create', { title: 'Même titre' });
  assert.notEqual(value.plans[0].id, plan.id);
  assert.notEqual(value.plans[0].slug, plan.slug);
});

test('nested drag and keyboard moves preserve whole subtrees and reject cycles or a fourth level', async (t) => {
  const { change, cwd, service } = await fixture(t);
  await change('init');
  let value = await change('plan.create', {
    title: 'Arbre',
    steps: [
      { text: 'A', children: [{ text: 'A1', children: [{ text: 'A11' }] }] },
      { text: 'B' },
      { text: 'C' },
    ],
  });
  const plan = value.plans[0];
  const [a, b, c] = plan.steps;
  const oldRevision = value.revision;
  await assert.rejects(
    change('step.move', { planId: plan.id, stepId: a.id, targetId: a.children[0].id, position: 'inside' }),
    { code: 'roadmap_invalid' },
  );
  await assert.rejects(
    change('step.move', {
      planId: plan.id,
      stepId: b.id,
      targetId: a.children[0].children[0].id,
      position: 'inside',
    }),
    { code: 'roadmap_invalid' },
  );
  assert.equal((await service.read(cwd)).revision, oldRevision);
  value = await change('step.move', { planId: plan.id, stepId: b.id, targetId: a.id, position: 'inside' });
  assert.deepEqual(
    value.plans[0].steps[0].children.map((entry) => entry.text),
    ['A1', 'B'],
  );
  value = await change('step.move', { planId: plan.id, stepId: b.id, direction: 'up' });
  assert.deepEqual(
    value.plans[0].steps[0].children.map((entry) => entry.text),
    ['B', 'A1'],
  );
  value = await change('step.move', { planId: plan.id, stepId: b.id, direction: 'outdent' });
  assert.deepEqual(
    value.plans[0].steps.map((entry) => entry.text),
    ['A', 'B', 'C'],
  );
  value = await change('step.move', { planId: plan.id, stepId: c.id, direction: 'indent' });
  assert.equal(value.plans[0].steps[1].children[0].id, c.id);
  value = await change('step.move', { planId: plan.id, stepId: b.id, targetId: a.id, position: 'before' });
  assert.deepEqual(
    value.plans[0].steps.map((entry) => entry.text),
    ['B', 'A'],
  );
  assert.equal(value.plans[0].steps[1].children[0].children[0].text, 'A11');
});

test('backlog numbers are stable across edits, conversions and deletions; bulk failures roll back', async (t) => {
  const { change, service, cwd } = await fixture(t);
  await change('init');
  let value = await change('backlog.add', {
    items: [{ text: 'A' }, { text: 'B' }],
    notes: [{ text: 'N', note: 'Détails\nmultilignes' }],
  });
  assert.deepEqual(
    value.backlog.items.map((entry) => entry.number),
    [1, 2],
  );
  assert.equal(value.backlog.notes[0].number, 3);
  await assert.rejects(change('backlog.set', { numbers: [1, 3], done: true }), { code: 'roadmap_invalid' });
  assert.equal((await service.read(cwd)).backlog.items[0].done, false);
  value = await change('backlog.convert', { number: 3, kind: 'item' });
  assert.equal(value.backlog.items[2].note, 'Détails\nmultilignes');
  value = await change('backlog.move', { number: 3, targetNumber: 1, position: 'before' });
  assert.deepEqual(
    value.backlog.items.map((entry) => entry.number),
    [3, 1, 2],
  );
  value = await change('backlog.edit', { number: 3, text: 'Note engagée' });
  await change('backlog.remove', { numbers: [3, 2] });
  value = await change('backlog.add', { items: [{ text: 'Suite' }] });
  assert.deepEqual(
    value.backlog.items.map((entry) => entry.number),
    [1, 4],
  );
  assert.equal(value.backlog.nextNumber, 5);
});

test('every read validates the persisted schema; corruption cannot be overwritten by init or edits', async (t) => {
  const { change, cwd, file, service } = await fixture(t);
  await change('init');
  const good = await readFile(file, 'utf8');
  for (const broken of [
    '{bad json',
    JSON.stringify({ ...JSON.parse(good), revision: 0 }),
    JSON.stringify({ ...JSON.parse(good), plans: [{ id: 'plan-invalid' }] }),
  ]) {
    await writeFile(file, broken);
    await assert.rejects(service.read(cwd), { code: 'roadmap_corrupt' });
    await assert.rejects(service.mutate(cwd, { action: 'init', expectedRevision: 0 }), {
      code: 'roadmap_corrupt',
    });
    await assert.rejects(
      service.mutate(cwd, { action: 'vision', expectedRevision: 1, text: 'Ne doit pas écraser' }),
      { code: 'roadmap_corrupt' },
    );
    assert.equal(await readFile(file, 'utf8'), broken);
  }
  await writeFile(file, good);
  assert.equal((await service.read(cwd)).revision, 1);
});

test('write validation failures retain the original bytes and do not notify observers', async (t) => {
  const { change, file, changes } = await fixture(t);
  await change('init');
  const bytes = await readFile(file, 'utf8');
  await assert.rejects(
    change('plan.create', {
      title: 'Profondeur',
      steps: [{ text: '1', children: [{ text: '2', children: [{ text: '3', children: [{ text: '4' }] }] }] }],
    }),
    { code: 'roadmap_invalid' },
  );
  await assert.rejects(change('vision', { text: 'x'.repeat(20001) }), { code: 'roadmap_invalid' });
  await assert.rejects(
    change('plan.create', { title: 'Référence inconnue', milestone: 'milestone-missing' }),
    { code: 'roadmap_missing' },
  );
  assert.equal(await readFile(file, 'utf8'), bytes);
  assert.equal(changes.length, 1);
  assert.deepEqual(
    (await readdir(dirname(file))).filter((entry) => entry.endsWith('.tmp')),
    [],
  );
});

test('a dead PID lock is recovered; a live owner is never stolen', async (t) => {
  const { change, cwd, file, service } = await fixture(t);
  await change('init');
  const lock = join(dirname(file), '.roadmap.lock');
  await mkdir(lock);
  const nonce = randomUUID();
  await writeFile(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: 2147483647, nonce, at: Date.now() - 60000 }),
  );
  await change('vision', { text: 'Après arrêt brutal' });
  assert.equal((await service.read(cwd)).revision, 2);
  assert.equal((await lstat(join(dirname(file), `.roadmap.retired-${nonce}`))).isDirectory(), true);
  await mkdir(lock);
  await writeFile(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: Date.now() - 86400000 }),
  );
  await assert.rejects(change('vision', { text: 'Interdit' }), { code: 'roadmap_busy' });
  assert.equal((await service.read(cwd)).overview.vision, 'Après arrêt brutal');
});

test('project-local links cannot redirect Roadmap storage outside the project', async (t) => {
  const { cwd, service } = await fixture(t);
  const target = join(cwd, 'elsewhere');
  await mkdir(target);
  try {
    await symlink(target, join(cwd, '.prime'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (reason) {
    if (reason.code === 'EPERM') return t.skip('Directory symlinks unavailable');
    throw reason;
  }
  await assert.rejects(service.read(cwd), { code: 'roadmap_unsafe_path' });
  await assert.rejects(service.mutate(cwd, { action: 'init', expectedRevision: 0 }), {
    code: 'roadmap_unsafe_path',
  });
  assert.deepEqual(await readdir(target), []);
});

test('Markdown export is a readable projection with plan links, multiline notes and truthful counts', async (t) => {
  const { change, cwd, service } = await fixture(t);
  await change('init');
  await change('vision', { text: 'Vision courte' });
  let value = await change('plan.create', {
    title: 'Validation',
    summary: 'Résultat attendu',
    sessions: ['root-session'],
    steps: [{ text: 'Contrôle', done: true, note: 'Ligne un\nLigne deux' }],
  });
  await change(
    'journal.add',
    { planId: value.plans[0].id, text: 'Résultat vérifié' },
    { by: 'agent', sessionId: 'child-session', name: 'Testeur' },
  );
  await change('backlog.add', { notes: [{ text: 'À étudier' }] });
  const before = await service.read(cwd);
  const exported = await service.exportMarkdown(cwd);
  assert.match(exported, /1\/1 tâches cochées \(100 %\)/);
  assert.match(exported, /Vision courte/);
  assert.match(exported, /Conversations : root-session/);
  assert.match(exported, /- \[x\] Contrôle\n  > Ligne un\n  > Ligne deux/);
  assert.match(exported, /Testeur · child-session/);
  assert.match(exported, /#1 À étudier/);
  assert.match(exported, /document JSON/);
  assert.equal((await service.read(cwd)).revision, before.revision);
});

test('closed service refuses new operations', async (t) => {
  const { service, cwd } = await fixture(t);
  await service.close();
  await assert.rejects(service.read(cwd), { code: 'roadmap_closed' });
  await assert.rejects(service.mutate(cwd, { action: 'init', expectedRevision: 0 }), {
    code: 'roadmap_closed',
  });
});

test('plan color validates against its palette, patches and resets', async (t) => {
  const { change, service, file } = await fixture(t);
  await change('init');
  let value = await change('plan.create', { title: 'Teinte', color: '#0d9488' });
  assert.equal(value.plans[0].color, '#0d9488');
  const updatedAt = value.plans[0].updatedAt;
  value = await change('plan.patch', { planId: value.plans[0].id, color: '#DB2777' });
  assert.equal(value.plans[0].color, '#db2777');
  assert.ok(value.plans[0].updatedAt >= updatedAt);
  value = await change('plan.patch', { planId: value.plans[0].id, color: '' });
  assert.equal(value.plans[0].color, undefined);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).plans[0].color, undefined);
  await assert.rejects(change('plan.create', { title: 'Refus', color: '#3b82f6' }), {
    code: 'roadmap_invalid',
  });
  await assert.rejects(change('plan.create', { title: 'Refus', color: 'red' }), {
    code: 'roadmap_invalid',
  });
  const existingId = value.plans[0].id;
  await assert.rejects(change('plan.patch', { planId: existingId, color: '#0891b2' }), {
    code: 'roadmap_invalid',
  });
  assert.equal((await service.read(value.cwd)).plans[0].color, undefined);
});

test('backlog entries carry stable ids and updatedAt across edits', async (t) => {
  const { change, service } = await fixture(t);
  await change('init');
  let value = await change('backlog.add', { items: [{ text: 'A' }], notes: [{ text: 'N' }] });
  const itemId = value.backlog.items[0].id;
  const noteId = value.backlog.notes[0].id;
  assert.ok(itemId.startsWith('backlog-'));
  assert.ok(noteId.startsWith('backlog-'));
  assert.ok(value.backlog.items[0].updatedAt > 0);
  value = await change('backlog.edit', { number: 1, text: 'A modifie' });
  assert.equal(value.backlog.items[0].id, itemId);
  assert.ok(value.backlog.items[0].updatedAt >= value.backlog.items[0].addedAt);
  value = await change('backlog.set', { numbers: [1], done: true });
  assert.equal(value.backlog.items[0].id, itemId);
  assert.equal((await service.read(value.cwd)).backlog.items[0].done, true);
});
