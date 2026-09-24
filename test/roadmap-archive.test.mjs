import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createRoadmapService, validateRoadmapDocument } from '../lib/roadmap.mjs';
import { createRoadmapBridge } from '../lib/roadmap-bridge.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'prime-roadmap-archive-'));
  const service = createRoadmapService({
    resolveProject: async () => ({ cwd, name: 'Archive test' }),
  });
  t.after(async () => {
    await service.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  const read = () => service.read(cwd);
  const change = async (action, params = {}) =>
    service.mutate(cwd, { action, expectedRevision: (await read()).revision, ...params }, { by: 'user' });
  return { cwd, service, read, change };
}

test('missing archive flag stays visible (migration free) and new plans are not archived', async (t) => {
  const { change, read } = await fixture(t);
  await change('init');
  const created = await change('plan.create', { title: 'Legacy plan', steps: [{ text: 'Keep' }] });
  const plan = created.plans[0];
  assert.equal(plan.archived, false);
  assert.equal(plan.archivedAt, null);
  const raw = {
    schemaVersion: 1,
    revision: 1,
    lastEdit: { by: 'user', at: 1 },
    overview: { vision: '', milestones: [] },
    plans: [
      {
        id: plan.id,
        slug: plan.slug,
        title: 'Legacy plan',
        summary: '',
        status: 'active',
        milestone: null,
        sessions: [],
        steps: [{ id: 'step-1', text: 'Keep', note: '', done: false, children: [] }],
        journal: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    backlog: { items: [], notes: [], nextNumber: 1 },
  };
  const valid = validateRoadmapDocument(raw);
  assert.equal(valid.plans[0].archived, false);
  assert.equal(valid.plans[0].archivedAt, null);
  assert.equal((await read()).plans.some((entry) => entry.archived), false);
});

test('archive and unarchive use revision CAS and allow delete on archived plans', async (t) => {
  const { change, read, service, cwd } = await fixture(t);
  await change('init');
  const created = await change('plan.create', { title: 'Old work', steps: [{ text: 'Done' }] });
  const planId = created.plans[0].id;
  const revision = created.revision;
  const archived = await service.mutate(cwd, { action: 'plan.archive', expectedRevision: revision, planId }, { by: 'user' });
  assert.equal(archived.revision, revision + 1);
  const stored = archived.plans.find((entry) => entry.id === planId);
  assert.equal(stored.archived, true);
  assert.ok(Number.isSafeInteger(stored.archivedAt) && stored.archivedAt > 0);
  await assert.rejects(
    service.mutate(cwd, { action: 'plan.archive', expectedRevision: revision, planId }, { by: 'user' }),
    { code: 'roadmap_conflict' },
  );
  const restored = await change('plan.unarchive', { planId });
  assert.equal(restored.plans.find((entry) => entry.id === planId).archived, false);
  assert.equal(restored.plans.find((entry) => entry.id === planId).archivedAt, null);
  await change('plan.archive', { planId });
  const afterDelete = await change('plan.delete', { planId });
  assert.equal(afterDelete.plans.some((entry) => entry.id === planId), false);
});

test('archived plans leave progress totals and milestone progress but stay in the DTO', async (t) => {
  const { change } = await fixture(t);
  await change('init');
  const milestone = (await change('milestone.create', { title: 'Ship' })).overview.milestones[0];
  await change('plan.create', {
    title: 'Active plan',
    milestone: milestone.id,
    steps: [{ text: 'Todo' }, { text: 'Done', done: true }],
  });
  let doc = await change('plan.create', {
    title: 'Archived plan',
    milestone: milestone.id,
    steps: [{ text: 'Old todo' }, { text: 'Old done', done: true }],
  });
  assert.deepEqual(doc.progress, { done: 2, total: 4, percent: 50 });
  doc = await change('plan.archive', { planId: doc.plans[1].id });
  assert.deepEqual(doc.progress, { done: 1, total: 2, percent: 50 });
  const group = doc.overview.milestones.find((entry) => entry.id === milestone.id);
  assert.deepEqual(group.progress, { done: 1, total: 2, percent: 50 });
  assert.equal(doc.plans.length, 2);
  assert.equal(doc.plans.filter((entry) => entry.archived).length, 1);
  assert.equal(doc.plans.filter((entry) => !entry.archived).length, 1);
});

test('edits targeting an archived plan are refused', async (t) => {
  const { change } = await fixture(t);
  await change('init');
  const created = await change('plan.create', { title: 'Frozen', steps: [{ text: 'Keep' }] });
  const planId = created.plans[0].id;
  const stepId = created.plans[0].steps[0].id;
  await change('plan.archive', { planId });
  await assert.rejects(change('plan.patch', { planId, title: 'Changed' }), { code: 'roadmap_archived' });
  await assert.rejects(change('step.edit', { planId, stepId, text: 'Changed' }), { code: 'roadmap_archived' });
  await assert.rejects(change('step.check', { planId, stepId, done: true }), { code: 'roadmap_archived' });
  await assert.rejects(change('journal.add', { planId, text: 'Note' }), { code: 'roadmap_archived' });
  await assert.rejects(change('plan.attach', { planId, sessionId: 'session-1' }), { code: 'roadmap_archived' });
});

function call(bridge, action, params = {}) {
  const cwd = process.cwd();
  const identity = { cwd, sessionId: 'root', sessionFile: join(cwd, 'root.jsonl') };
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: bridge.config.socketPath,
        method: 'POST',
        path: '/',
        agent: false,
        headers: { Authorization: `Bearer ${bridge.config.token}`, 'Content-Type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ identity, action, params, epoch: 'epoch-1' }));
  });
}

test('agents do not see archived plans and cannot use the archive action', async (t) => {
  const caller = { cwd: process.cwd(), sessionId: 'root', rootSessionId: 'root', name: 'Prime Agent', ownerId: 'run-1' };
  let dto = {
    revision: 2,
    initialized: true,
    vision: 'Ship',
    progress: { done: 1, total: 2, percent: 50 },
    overview: { vision: 'Ship', milestones: [{ id: 'm1', title: 'M', progress: { done: 1, total: 2, percent: 50 } }] },
    plans: [
      { id: 'p-active', title: 'Active', summary: '', status: 'active', milestone: 'm1', sessions: [], progress: { done: 1, total: 2, percent: 50 }, steps: [] },
      { id: 'p-archived', title: 'Old', summary: '', status: 'active', milestone: 'm1', sessions: [], progress: { done: 1, total: 2, percent: 50 }, steps: [], archived: true, archivedAt: 1 },
    ],
    milestones: [{ id: 'm1', title: 'M' }],
    backlog: { items: [], notes: [] },
  };
  const bridge = createRoadmapBridge({
    service: { read: async () => structuredClone(dto) },
    resolveCaller: async () => caller,
  });
  await bridge.ready;
  t.after(() => bridge.close());
  const overview = await call(bridge, 'read', { target: 'overview' });
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.body.plans.map((entry) => entry.id), ['p-active']);
  assert.equal(overview.body.planCount, 1);
  assert.equal((await call(bridge, 'read', { target: 'plan', planId: 'p-archived' })).status, 404);
  assert.equal((await call(bridge, 'work', { targets: [{ kind: 'plan', planId: 'p-archived' }] })).status, 404);
  assert.equal(
    (await call(bridge, 'mutate', { action: 'plan.archive', expectedRevision: 2, planId: 'p-active' })).status,
    400,
  );
  assert.equal(
    (await call(bridge, 'mutate', { action: 'plan.unarchive', expectedRevision: 2, planId: 'p-archived' })).status,
    400,
  );
});
