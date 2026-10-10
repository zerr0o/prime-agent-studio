import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { request } from 'node:http';
import { createRoadmapService } from '../lib/roadmap.mjs';
import { createRoadmapBridge } from '../lib/roadmap-bridge.mjs';
import { createRoadmapRoutes } from '../lib/roadmap-routes.mjs';
import { mergeRoadmaps } from '../lib/roadmap-merge.mjs';

const MACHINE = 'machine-1';
const MACHINE2 = 'machine-2';

async function fixture(t, { machineId = MACHINE } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'prime-roadmap-completion-'));
  const getMachineId = machineId === null ? undefined : async () => machineId;
  const service = createRoadmapService({
    resolveProject: async () => ({ cwd, name: 'Completion' }),
    ...(getMachineId ? { getMachineId } : {}),
  });
  t.after(async () => {
    await service.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  const read = () => service.read(cwd);
  const change = async (action, params = {}, actor) =>
    service.mutate(cwd, { action, expectedRevision: (await read()).revision, ...params }, actor);
  return { cwd, service, read, change };
}

function findStep(steps, id) {
  for (const s of steps) {
    if (s.id === id) return s;
    const f = findStep(s.children, id);
    if (f) return f;
  }
  return null;
}
function allSteps(steps, out = []) {
  for (const s of steps) {
    out.push(s);
    allSteps(s.children, out);
  }
  return out;
}

test('check stamps once, recheck preserves, reopen clears', async (t) => {
  const { change, read, cwd, service } = await fixture(t);
  await change('init');
  let value = await change('plan.create', { title: 'P', steps: [{ text: 'A' }, { text: 'B' }] });
  const plan = value.plans[0];
  const a = plan.steps[0].id;
  const file = join(cwd, '.prime', 'studio', 'roadmap.json');
  // unchecked => null
  assert.equal(plan.steps[0].completion, null);
  // persisted file also null
  assert.equal(findStep(JSON.parse(await readFile(file, 'utf8')).plans[0].steps, a).completion, null);

  value = await change(
    'step.check',
    { planId: plan.id, stepId: a, done: true },
    { by: 'agent', sessionId: 'sess-root' },
  );
  const stamped = value.plans[0].steps[0].completion;
  assert.deepEqual(Object.keys(stamped).sort(), ['completedAt', 'machineId', 'sessionId']);
  assert.equal(stamped.machineId, MACHINE);
  assert.equal(stamped.sessionId, 'sess-root');
  assert.ok(Number.isSafeInteger(stamped.completedAt) && stamped.completedAt > 0);

  // redundant done:true preserves original
  const before = stamped;
  value = await change(
    'step.check',
    { planId: plan.id, stepId: a, done: true },
    { by: 'agent', sessionId: 'sess-other' },
  );
  assert.deepEqual(value.plans[0].steps[0].completion, before);

  // unrelated edit preserves
  value = await change('step.edit', { planId: plan.id, stepId: a, text: 'A renamed' });
  assert.deepEqual(value.plans[0].steps[0].completion, before);

  // reopen clears
  value = await change('step.check', { planId: plan.id, stepId: a, done: false });
  assert.equal(value.plans[0].steps[0].completion, null);
  assert.equal(value.plans[0].steps[0].done, false);

  // re-check after reopen stamps anew (new timestamp >= old)
  value = await change('step.check', { planId: plan.id, stepId: a, done: true }, { by: 'user' });
  const restamped = value.plans[0].steps[0].completion;
  assert.equal(restamped.machineId, MACHINE);
  assert.equal(restamped.sessionId, null);
  assert.ok(restamped.completedAt >= before.completedAt);
  void service;
  void read;
});

test('parent check preserves descendant credits; derived parent records last validator', async (t) => {
  // mutable machine to test last-validator
  let current = MACHINE;
  const cwd = await mkdtemp(join(tmpdir(), 'prime-roadmap-completion-'));
  const service = createRoadmapService({
    resolveProject: async () => ({ cwd, name: 'Completion' }),
    getMachineId: async () => current,
  });
  t.after(async () => {
    await service.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  const read = () => service.read(cwd);
  const change = async (action, params = {}, actor) =>
    service.mutate(cwd, { action, expectedRevision: (await read()).revision, ...params }, actor);
  await change('init');
  let value = await change('plan.create', {
    title: 'P',
    steps: [{ text: 'G', children: [{ text: 'A' }, { text: 'B' }] }],
  });
  const plan = value.plans[0];
  const g = plan.steps[0].id;
  const a = plan.steps[0].children[0].id;
  const b = plan.steps[0].children[1].id;

  // check one child as sess-a
  value = await change(
    'step.check',
    { planId: plan.id, stepId: a, done: true },
    { by: 'agent', sessionId: 'sess-a' },
  );
  const compA = value.plans[0].steps[0].children[0].completion;
  assert.equal(compA.sessionId, 'sess-a');
  // parent still incomplete => null
  assert.equal(value.plans[0].steps[0].completion, null);
  assert.equal(value.plans[0].steps[0].done, false);

  // check parent as sess-b: already-done child keeps credit, other child + parent stamped sess-b
  current = MACHINE2;
  value = await change(
    'step.check',
    { planId: plan.id, stepId: g, done: true },
    { by: 'agent', sessionId: 'sess-b' },
  );
  const after = value.plans[0].steps[0];
  assert.deepEqual(after.children[0].completion, compA);
  assert.equal(after.children[1].completion.sessionId, 'sess-b');
  assert.equal(after.children[1].completion.machineId, MACHINE2);
  assert.equal(after.completion.sessionId, 'sess-b');
  assert.equal(after.completion.machineId, MACHINE2);
  assert.equal(after.done, true);

  // redundant parent check preserves
  const parentComp = after.completion;
  value = await change(
    'step.check',
    { planId: plan.id, stepId: g, done: true },
    { by: 'agent', sessionId: 'sess-c' },
  );
  assert.deepEqual(value.plans[0].steps[0].completion, parentComp);
  assert.deepEqual(value.plans[0].steps[0].children[0].completion, compA);

  // reopen one child clears child + derived parent
  value = await change('step.check', { planId: plan.id, stepId: b, done: false });
  assert.equal(findStep(value.plans[0].steps, b).completion, null);
  assert.equal(findStep(value.plans[0].steps, g).completion, null);
  // sibling keeps credit
  assert.deepEqual(findStep(value.plans[0].steps, a).completion, compA);
  void a;
});

test('plan.create and plan.steps explicit done flags stamp; preservation keeps credits', async (t) => {
  const { change } = await fixture(t);
  await change('init');
  let value = await change(
    'plan.create',
    {
      title: 'P',
      steps: [
        { text: 'A', done: true },
        { text: 'B' },
        { text: 'G', children: [{ text: 'G1', done: true }, { text: 'G2' }] },
      ],
    },
    { by: 'agent', sessionId: 'sess-create' },
  );
  const plan = value.plans[0];
  assert.equal(plan.steps[0].completion.sessionId, 'sess-create');
  assert.equal(plan.steps[1].completion, null);
  // derived parent incomplete => null even though one child done
  assert.equal(plan.steps[2].completion, null);
  assert.equal(plan.steps[2].children[0].completion.sessionId, 'sess-create');

  // plan.steps: preserve A (no done supplied) keeps credit, explicitly check B stamps, unrelated rename preserves
  const aId = plan.steps[0].id;
  const bId = plan.steps[1].id;
  const gId = plan.steps[2].id;
  const g1Id = plan.steps[2].children[0].id;
  const g2Id = plan.steps[2].children[1].id;
  const compA = plan.steps[0].completion;
  value = await change(
    'plan.steps',
    {
      planId: plan.id,
      steps: [
        { id: aId, text: 'A renamed' },
        { id: bId, text: 'B', done: true },
        {
          id: gId,
          text: 'G',
          children: [
            { id: g1Id, text: 'G1' },
            { id: g2Id, text: 'G2', done: true },
          ],
        },
      ],
    },
    { by: 'agent', sessionId: 'sess-steps' },
  );
  assert.deepEqual(findStep(value.plans[0].steps, aId).completion, compA);
  assert.equal(findStep(value.plans[0].steps, bId).completion.sessionId, 'sess-steps');
  // G becomes complete via explicit G2 => derived parent stamped last validator
  assert.equal(findStep(value.plans[0].steps, gId).completion.sessionId, 'sess-steps');
  assert.equal(findStep(value.plans[0].steps, g2Id).completion.sessionId, 'sess-steps');
  // G1 was already done => preserved original
  assert.deepEqual(findStep(value.plans[0].steps, g1Id).completion, plan.steps[2].children[0].completion);

  // plan.steps reopen clears
  value = await change('plan.steps', {
    planId: plan.id,
    steps: [
      { id: aId, text: 'A renamed', done: false },
      { id: bId, text: 'B', done: true },
      {
        id: gId,
        text: 'G',
        children: [
          { id: g1Id, text: 'G1' },
          { id: g2Id, text: 'G2', done: true },
        ],
      },
    ],
  });
  assert.equal(findStep(value.plans[0].steps, aId).completion, null);
});

test('forged completion fields are rejected and never persist', async (t) => {
  const { change } = await fixture(t);
  await change('init');
  await assert.rejects(
    change('plan.create', {
      title: 'P',
      steps: [{ text: 'A', completion: { machineId: 'x', sessionId: null, completedAt: 1 } }],
    }),
    { code: 'roadmap_invalid' },
  );
  let value = await change('plan.create', { title: 'P', steps: [{ text: 'A' }] });
  const plan = value.plans[0];
  await assert.rejects(
    change('plan.steps', { planId: plan.id, steps: [{ id: plan.steps[0].id, text: 'A', completion: null }] }),
    { code: 'roadmap_invalid' },
  );
  await assert.rejects(
    change('step.check', {
      planId: plan.id,
      stepId: plan.steps[0].id,
      done: true,
      completion: { machineId: 'evil', sessionId: null, completedAt: 1 },
    }),
    { code: 'roadmap_invalid' },
  );
  await assert.rejects(
    change('step.check', { planId: plan.id, stepId: plan.steps[0].id, done: true, machineId: 'evil' }),
    { code: 'roadmap_invalid' },
  );
  // failed writes left revision unchanged and no completion invented
  value = await change(
    'step.check',
    { planId: plan.id, stepId: plan.steps[0].id, done: true },
    { by: 'user' },
  );
  assert.equal(value.plans[0].steps[0].completion.machineId, MACHINE);
});

test('without getMachineId legacy fixtures stay null instead of fake ids', async (t) => {
  const { change } = await fixture(t, { machineId: null });
  await change('init');
  let value = await change('plan.create', { title: 'P', steps: [{ text: 'A', done: true }] });
  assert.equal(value.plans[0].steps[0].completion, null);
  assert.equal(value.plans[0].steps[0].done, true);
  value = await change('step.check', {
    planId: value.plans[0].id,
    stepId: value.plans[0].steps[0].id,
    done: false,
  });
  assert.equal(value.plans[0].steps[0].completion, null);
  value = await change(
    'step.check',
    { planId: value.plans[0].id, stepId: value.plans[0].steps[0].id, done: true },
    { by: 'agent', sessionId: 's' },
  );
  assert.equal(value.plans[0].steps[0].completion, null);
});

test('structural remove/move/add never invent credits, but clear newly incomplete parents', async (t) => {
  const { change } = await fixture(t);
  await change('init');
  let value = await change(
    'plan.create',
    {
      title: 'P',
      steps: [{ text: 'G', children: [{ text: 'A', done: true }, { text: 'B' }] }, { text: 'C' }],
    },
    { by: 'agent', sessionId: 's1' },
  );
  const plan = value.plans[0];
  const g = plan.steps[0].id;
  const a = plan.steps[0].children[0].id;
  const b = plan.steps[0].children[1].id;
  // G incomplete => null
  assert.equal(findStep(value.plans[0].steps, g).completion, null);

  // remove the only undone child => G becomes derived-complete but must stay null (no invent)
  value = await change('step.remove', { planId: plan.id, stepId: b });
  const afterRemove = value.plans[0].steps[0];
  assert.equal(afterRemove.done, true);
  assert.equal(afterRemove.completion, null);
  // done child keeps credit
  assert.equal(afterRemove.children[0].completion.sessionId, 's1');

  // add an undone child under the now-complete parent => parent clears (was null, stays null) and stays incomplete
  value = await change('step.add', { planId: plan.id, parentId: g, text: 'New' });
  assert.equal(value.plans[0].steps[0].done, false);
  assert.equal(value.plans[0].steps[0].completion, null);

  // move: complete a parent by moving undone away must not invent
  // Build fresh: G1 [done A, undone B], G2 []
  value = await change(
    'plan.create',
    {
      title: 'Q',
      steps: [{ text: 'G1', children: [{ text: 'A', done: true }, { text: 'B' }] }, { text: 'G2' }],
    },
    { by: 'agent', sessionId: 's2' },
  );
  const q = value.plans.find((p) => p.title === 'Q');
  const g1 = q.steps[0].id;
  const bb = q.steps[0].children[1].id;
  const g2 = q.steps[1].id;
  value = await change('step.move', { planId: q.id, stepId: bb, targetId: g2, position: 'inside' });
  const movedG1 = findStep(value.plans.find((p) => p.id === q.id).steps, g1);
  assert.equal(movedG1.done, true);
  assert.equal(movedG1.completion, null);
  void a;
});

test('stale revision and revoked admission never commit or invent', async (t) => {
  const { change, read, cwd, service } = await fixture(t);
  await change('init');
  let value = await change('plan.create', { title: 'P', steps: [{ text: 'A' }] });
  const plan = value.plans[0];
  const rev = value.revision;
  await assert.rejects(
    service.mutate(
      cwd,
      {
        action: 'step.check',
        expectedRevision: rev - 1,
        planId: plan.id,
        stepId: plan.steps[0].id,
        done: true,
      },
      { by: 'agent', sessionId: 's' },
    ),
    { code: 'roadmap_conflict' },
  );
  assert.equal((await read()).plans[0].steps[0].completion, null);
  const denied = Object.assign(new Error('Revoked'), { status: 401 });
  await assert.rejects(
    service.mutate(
      cwd,
      { action: 'step.check', expectedRevision: rev, planId: plan.id, stepId: plan.steps[0].id, done: true },
      { by: 'agent', sessionId: 's' },
      {
        authorize: async () => {
          throw denied;
        },
      },
    ),
    { status: 401 },
  );
  assert.equal((await read()).revision, rev);
  assert.equal((await read()).plans[0].steps[0].completion, null);
});

test('metadata survives read/raw/restart and sync merge/replaceRaw without re-attribution', async (t) => {
  const { cwd, service, change } = await fixture(t);
  await change('init');
  let value = await change('plan.create', { title: 'P', steps: [{ text: 'A' }] });
  const plan = value.plans[0];
  value = await change(
    'step.check',
    { planId: plan.id, stepId: plan.steps[0].id, done: true },
    { by: 'agent', sessionId: 'sess-x' },
  );
  const stamped = value.plans[0].steps[0].completion;
  assert.ok(stamped);

  // readRaw preserves
  const raw = await service.readRaw(cwd);
  assert.deepEqual(findStep(raw.plans[0].steps, plan.steps[0].id).completion, stamped);

  // restart (new service on same dir without getMachineId still reads, legacy null not retrofitted but existing preserved via validation)
  const second = createRoadmapService({ resolveProject: async () => ({ cwd, name: 'Completion' }) });
  t.after(() => second.close());
  const reread = await second.read(cwd);
  assert.deepEqual(findStep(reread.plans[0].steps, plan.steps[0].id).completion, stamped);

  // sync merge preserves winner completions (newest plan wins carries steps)
  const base = {
    schemaVersion: 1,
    revision: 1,
    lastEdit: { by: 'user', at: 1 },
    overview: { vision: '', milestones: [] },
    plans: [],
    backlog: { items: [], notes: [], nextNumber: 1 },
    pastudioImports: [],
  };
  const localDoc = await service.readRaw(cwd);
  const remoteDoc = structuredClone(localDoc);
  const merged = mergeRoadmaps(base, localDoc, remoteDoc);
  assert.deepEqual(findStep(merged.plans[0].steps, plan.steps[0].id).completion, stamped);

  // replaceRaw preserves without attributing importer
  const beforeRev = (await service.read(cwd)).revision;
  const replaced = await service.replaceRaw(cwd, merged, { by: 'user' });
  assert.equal(replaced.revision, beforeRev + 1);
  assert.deepEqual(findStep(replaced.plans[0].steps, plan.steps[0].id).completion, stamped);

  // importPastudio appends without stamping importer as checker
  const imported = await service.importPastudio(
    cwd,
    {
      marker: { archiveId: 'a'.repeat(10), payloadDigest: 'b'.repeat(64) },
      milestones: [],
      plans: [{ title: 'Imported', steps: [{ text: 'I', done: true }] }],
      backlogItems: [],
      backlogNotes: [],
    },
    { by: 'agent', sessionId: 'importer' },
  );
  const impDto = imported.result ?? imported;
  const impPlan = impDto.plans.find((p) => p.title === 'Imported');
  assert.equal(findStep(impPlan.steps, impPlan.steps[0].id).completion, null);
});

test('bridge uses verified caller session (child, not root) and rejects forged actor', async (t) => {
  const { cwd, service } = await fixture(t);
  await service.mutate(cwd, { action: 'init', expectedRevision: 0 });
  let dto = await service.read(cwd);
  dto = await service.mutate(cwd, {
    action: 'plan.create',
    expectedRevision: dto.revision,
    title: 'P',
    steps: [{ text: 'A' }],
  });
  const planId = dto.plans[0].id;
  const stepId = dto.plans[0].steps[0].id;
  const rev = dto.revision;

  const callerChild = { cwd, sessionId: 'child-1', rootSessionId: 'root-1', name: 'Child', ownerId: 'run-1' };
  const bridge = createRoadmapBridge({
    service,
    resolveCaller: async () => callerChild,
    isOwnerActive: () => true,
  });
  await bridge.ready;
  t.after(() => bridge.close());
  const call = (action, params = {}, extras = {}) =>
    new Promise((resolveCall, reject) => {
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
          res.on('data', (c) => (body += c));
          res.on('end', () => resolveCall({ status: res.statusCode, body: JSON.parse(body) }));
        },
      );
      req.on('error', reject);
      req.end(
        JSON.stringify({
          identity: { cwd, sessionId: 'child-1', sessionFile: '/x' },
          action,
          params,
          epoch: 'e1',
          ...extras,
        }),
      );
    });
  // forged actor in params must be ignored; verified child stamps
  const resp = await call('mutate', {
    action: 'step.check',
    expectedRevision: rev,
    planId,
    stepId,
    done: true,
    actor: { sessionId: 'spoof' },
  });
  assert.equal(resp.status, 200);
  const after = await service.read(cwd);
  assert.equal(findStep(after.plans[0].steps, stepId).completion.sessionId, 'child-1');
  assert.equal(findStep(after.plans[0].steps, stepId).completion.machineId, MACHINE);

  // forged completion rejected
  const bad = await call('mutate', {
    action: 'step.check',
    expectedRevision: after.revision,
    planId,
    stepId,
    done: false,
    completion: { machineId: 'evil', sessionId: null, completedAt: 1 },
  });
  assert.equal(bad.status, 400);

  // stale revision replays 409 without duplicating
  const stale = await call('mutate', {
    action: 'step.check',
    expectedRevision: rev,
    planId,
    stepId,
    done: true,
  });
  assert.equal(stale.status, 409);

  // bounded flatSteps read preserves completion
  const readResp = await call('read', { target: 'plan', planId });
  assert.equal(readResp.status, 200);
  // small plan returns hierarchy with completion
  const step = readResp.body.plan?.steps
    ? findStep(readResp.body.plan.steps, stepId)
    : findStep(readResp.body.flatSteps, stepId);
  assert.equal(step.completion.sessionId, 'child-1');
});

test('routes step.check sessionId verifies same-project and stamps, cross-project rejects', async (t) => {
  const { cwd, service } = await fixture(t);
  await service.mutate(cwd, { action: 'init', expectedRevision: 0 });
  let dto = await service.read(cwd);
  dto = await service.mutate(cwd, {
    action: 'plan.create',
    expectedRevision: dto.revision,
    title: 'P',
    steps: [{ text: 'A' }],
  });
  const planId = dto.plans[0].id;
  const stepId = dto.plans[0].steps[0].id;

  const store = {
    async knowledgeProject() {
      return { cwd, name: 'Completion' };
    },
    async history(sessionId) {
      if (sessionId === 'sess-same') return { id: 'sess-same', cwd };
      if (sessionId === 'sess-other') return { id: 'sess-other', cwd: '/other/project' };
      throw Object.assign(new Error('missing'), { status: 404 });
    },
  };
  const routes = createRoadmapRoutes({
    service,
    bridge: { snapshot: () => ({}) },
    store,
    startRun: async () => ({}),
    liveMessages: {},
    getRuns: () => [],
  });
  t.after(() => routes.close());

  // no session => null
  let out = await routes.mutate({
    cwd,
    action: 'step.check',
    expectedRevision: dto.revision,
    planId,
    stepId,
    done: true,
  });
  assert.equal(findStep(out.plans[0].steps, stepId).completion.sessionId, null);
  assert.equal(findStep(out.plans[0].steps, stepId).completion.machineId, MACHINE);

  // reopen to test same-project session stamping
  out = await routes.mutate({
    cwd,
    action: 'step.check',
    expectedRevision: out.revision,
    planId,
    stepId,
    done: false,
  });
  assert.equal(findStep(out.plans[0].steps, stepId).completion, null);
  out = await routes.mutate({
    cwd,
    action: 'step.check',
    expectedRevision: out.revision,
    planId,
    stepId,
    done: true,
    sessionId: 'sess-same',
  });
  assert.equal(findStep(out.plans[0].steps, stepId).completion.sessionId, 'sess-same');

  // cross-project rejected, no commit
  const revBefore = out.revision;
  await assert.rejects(
    routes.mutate({
      cwd,
      action: 'step.check',
      expectedRevision: revBefore,
      planId,
      stepId,
      done: false,
      sessionId: 'sess-other',
    }),
    (e) => e.code === 'roadmap_wrong_project',
  );
  assert.equal((await service.read(cwd)).revision, revBefore);
});

test('bounded flatSteps fallback preserves completion', async (t) => {
  const { cwd, service } = await fixture(t);
  await service.mutate(cwd, { action: 'init', expectedRevision: 0 });
  let dto = await service.read(cwd);
  const many = Array.from({ length: 60 }, (_, i) => ({ text: `Step ${i} ` + 'x'.repeat(2000) }));
  dto = await service.mutate(cwd, {
    action: 'plan.create',
    expectedRevision: dto.revision,
    title: 'Big',
    steps: many,
  });
  const planId = dto.plans[0].id;
  const stepId = dto.plans[0].steps[0].id;
  dto = await service.mutate(
    cwd,
    { action: 'step.check', expectedRevision: dto.revision, planId, stepId, done: true },
    { by: 'agent', sessionId: 'sess-flat' },
  );
  const expected = findStep(dto.plans[0].steps, stepId).completion;
  assert.equal(expected.sessionId, 'sess-flat');

  const bridge = createRoadmapBridge({
    service,
    resolveCaller: async () => ({
      cwd,
      sessionId: 'sess-flat',
      rootSessionId: 'sess-flat',
      name: 'A',
      ownerId: 'run-1',
    }),
    isOwnerActive: () => true,
  });
  await bridge.ready;
  t.after(() => bridge.close());
  const call = (params = {}) =>
    new Promise((resolveCall, reject) => {
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
          res.on('data', (c) => (body += c));
          res.on('end', () => resolveCall({ status: res.statusCode, body: JSON.parse(body) }));
        },
      );
      req.on('error', reject);
      req.end(
        JSON.stringify({
          identity: { cwd, sessionId: 'sess-flat', sessionFile: '/x' },
          action: 'read',
          params,
          epoch: 'e1',
        }),
      );
    });
  const resp = await call({ target: 'plan', planId, limit: 10 });
  assert.equal(resp.status, 200);
  assert.ok(Array.isArray(resp.body.flatSteps));
  const flat =
    resp.body.flatSteps.find((s) => s.id === stepId) ??
    (await call({ target: 'plan', planId, offset: 0, limit: 50 })).body.flatSteps.find(
      (s) => s.id === stepId,
    );
  // first page contains step 0 since ordered
  const first = resp.body.flatSteps[0];
  assert.equal(first.id, stepId);
  assert.deepEqual(first.completion, expected);
});

test('configured machine-id failure or invalid id rejects only when stamp needed', async (t) => {
  // Undone creation needs no stamp => no provider call, succeeds even with failing provider.
  const cwd = await mkdtemp(join(tmpdir(), 'prime-roadmap-completion-'));
  const failing = createRoadmapService({
    resolveProject: async () => ({ cwd, name: 'Completion' }),
    getMachineId: async () => {
      throw new Error('identity IO boom');
    },
  });
  t.after(async () => {
    await failing.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  await failing.mutate(cwd, { action: 'init', expectedRevision: 0 });
  let dto = await failing.read(cwd);
  // undone plan.create succeeds without identity lookup
  dto = await failing.mutate(cwd, {
    action: 'plan.create',
    expectedRevision: dto.revision,
    title: 'P',
    steps: [{ text: 'A' }],
  });
  assert.equal(dto.plans[0].steps[0].completion, null);
  // done:true needs stamp => provider failure rejects atomically
  await assert.rejects(
    failing.mutate(cwd, {
      action: 'plan.create',
      expectedRevision: dto.revision,
      title: 'Q',
      steps: [{ text: 'B', done: true }],
    }),
  );
  assert.equal((await failing.read(cwd)).revision, dto.revision);

  // invalid id rejects only when stamp needed
  const cwd2 = await mkdtemp(join(tmpdir(), 'prime-roadmap-completion-'));
  const badId = createRoadmapService({
    resolveProject: async () => ({ cwd: cwd2, name: 'Completion' }),
    getMachineId: async () => 'bad id!',
  });
  t.after(async () => {
    await badId.close();
    await rm(cwd2, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  await badId.mutate(cwd2, { action: 'init', expectedRevision: 0 });
  let d2 = await badId.read(cwd2);
  d2 = await badId.mutate(cwd2, {
    action: 'plan.create',
    expectedRevision: d2.revision,
    title: 'P',
    steps: [{ text: 'A' }],
  });
  assert.equal(d2.plans[0].steps[0].completion, null);
  await assert.rejects(
    badId.mutate(cwd2, {
      action: 'plan.create',
      expectedRevision: d2.revision,
      title: 'Q',
      steps: [{ text: 'B', done: true }],
    }),
    { code: 'roadmap_invalid' },
  );
  assert.equal((await badId.read(cwd2)).revision, d2.revision);

  // step.check needing stamp rejects without inventing null
  const cwd3 = await mkdtemp(join(tmpdir(), 'prime-roadmap-completion-'));
  const failCheck = createRoadmapService({
    resolveProject: async () => ({ cwd: cwd3, name: 'Completion' }),
    getMachineId: async () => {
      throw new Error('io');
    },
  });
  t.after(async () => {
    await failCheck.close();
    await rm(cwd3, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  await failCheck.mutate(cwd3, { action: 'init', expectedRevision: 0 });
  const legacy = createRoadmapService({ resolveProject: async () => ({ cwd: cwd3, name: 'Completion' }) });
  t.after(() => legacy.close());
  let base = await legacy.read(cwd3);
  base = await legacy.mutate(cwd3, {
    action: 'plan.create',
    expectedRevision: base.revision,
    title: 'P',
    steps: [{ text: 'A' }],
  });
  const pid = base.plans[0].id;
  const sid = base.plans[0].steps[0].id;
  const revBefore = base.revision;
  await assert.rejects(
    failCheck.mutate(
      cwd3,
      { action: 'step.check', expectedRevision: revBefore, planId: pid, stepId: sid, done: true },
      { by: 'agent', sessionId: 's' },
    ),
  );
  assert.equal((await legacy.read(cwd3)).revision, revBefore);
  assert.equal(findStep((await legacy.read(cwd3)).plans[0].steps, sid).completion, null);
  // redundant/clear-only with failing provider still succeeds (no lookup)
  // first make done via legacy, then reopen via failing (clear needs no stamp)
  let doneBase = await legacy.mutate(
    cwd3,
    { action: 'step.check', expectedRevision: revBefore, planId: pid, stepId: sid, done: true },
    { by: 'user' },
  );
  assert.equal(doneBase.plans[0].steps[0].completion, null);
  const revDone = doneBase.revision;
  const cleared = await failCheck.mutate(cwd3, {
    action: 'step.check',
    expectedRevision: revDone,
    planId: pid,
    stepId: sid,
    done: false,
  });
  assert.equal(cleared.plans[0].steps[0].completion, null);
});

test('revocation during machine-id resolution cannot commit', async (t) => {
  const cwd4 = await mkdtemp(join(tmpdir(), 'prime-roadmap-completion-'));
  t.after(async () => {
    await rm(cwd4, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  let releaseGate;
  const gate = new Promise((r) => {
    releaseGate = r;
  });
  const svc = createRoadmapService({
    resolveProject: async () => ({ cwd: cwd4, name: 'Completion' }),
    getMachineId: async () => {
      await gate;
      return MACHINE;
    },
  });
  t.after(() => svc.close());
  try {
    await svc.mutate(cwd4, { action: 'init', expectedRevision: 0 });
    const leg = createRoadmapService({ resolveProject: async () => ({ cwd: cwd4, name: 'Completion' }) });
    t.after(() => leg.close());
    let cur = await leg.read(cwd4);
    cur = await leg.mutate(cwd4, {
      action: 'plan.create',
      expectedRevision: cur.revision,
      title: 'P',
      steps: [{ text: 'A' }],
    });
    const pid = cur.plans[0].id;
    const sid = cur.plans[0].steps[0].id;
    const rev = cur.revision;
    let calls = 0;
    const pending = svc.mutate(
      cwd4,
      { action: 'step.check', expectedRevision: rev, planId: pid, stepId: sid, done: true },
      { by: 'agent', sessionId: 'child-1' },
      {
        authorize: async () => {
          calls++;
          if (calls > 1) throw Object.assign(new Error('revoked'), { status: 401 });
        },
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    releaseGate();
    await assert.rejects(pending, { status: 401 });
    assert.equal((await leg.read(cwd4)).revision, rev);
    assert.equal(findStep((await leg.read(cwd4)).plans[0].steps, sid).completion, null);
  } finally {
    try {
      releaseGate();
    } catch {}
  }
});

test('importPastudio preserves historical completion with fresh ids, no reattribution', async (t) => {
  const { service, change } = await fixture(t);
  await change('init');
  let value = await change('plan.create', { title: 'Src', steps: [{ text: 'Done' }, { text: 'Todo' }] });
  const srcPlan = value.plans[0];
  value = await change(
    'step.check',
    { planId: srcPlan.id, stepId: srcPlan.steps[0].id, done: true },
    { by: 'agent', sessionId: 'orig-sess' },
  );
  const stamped = findStep(value.plans[0].steps, srcPlan.steps[0].id).completion;
  assert.ok(stamped);
  assert.equal(stamped.sessionId, 'orig-sess');
  const raw = await service.readRaw((await service.read(value.cwd)).cwd);
  const srcSteps = raw.plans.find((p) => p.id === srcPlan.id).steps;
  // Simulate adapter: strip ids but preserve completion (parent adapter behavior)
  const strip = (steps) =>
    steps.map((s) => ({
      text: s.text,
      note: s.note,
      done: s.done,
      completion: s.completion ? { ...s.completion } : null,
      children: strip(s.children || []),
    }));
  const stripped = strip(srcSteps);
  assert.equal(stripped[0].completion.sessionId, 'orig-sess');
  assert.equal(stripped[1].completion, null);
  // Import with fresh ids must preserve historical metadata, not attribute importer
  const beforeRev = (await service.read(value.cwd)).revision;
  const res = await service.importPastudio(
    value.cwd,
    {
      marker: { archiveId: 'c'.repeat(10), payloadDigest: 'd'.repeat(64) },
      milestones: [],
      plans: [{ title: 'Restored', steps: stripped }],
      backlogItems: [],
      backlogNotes: [],
    },
    { by: 'agent', sessionId: 'importer' },
  );
  const dto = res.result ?? res;
  assert.equal(dto.revision, beforeRev + 1);
  const imp = dto.plans.find((p) => p.title === 'Restored');
  assert.ok(imp);
  // fresh ids differ from source
  assert.notEqual(imp.steps[0].id, srcPlan.steps[0].id);
  assert.deepEqual(findStep(imp.steps, imp.steps[0].id).completion, stamped);
  assert.equal(findStep(imp.steps, imp.steps[1].id).completion, null);
  // done preserved, importer not attributed
  assert.equal(imp.steps[0].done, true);
  assert.notEqual(imp.steps[0].completion.sessionId, 'importer');
});
