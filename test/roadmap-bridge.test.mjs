import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createStore } from '../lib/store.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoadmapBridge, createRoadmapCallerResolver } from '../lib/roadmap-bridge.mjs';

const cwd = process.cwd();
const identity = { cwd, sessionId: 'root', sessionFile: join(cwd, 'root.jsonl') };
const caller = { cwd, sessionId: 'root', rootSessionId: 'root', name: 'Prime Agent', ownerId: 'run-1' };
const document = () => ({
  revision: 0,
  vision: 'Ship',
  plans: [{ id: 'p1', title: 'Plan', status: 'active', steps: [{ id: 's1', text: 'Verify', done: false }] }],
  milestones: [{ id: 'm1', title: 'Milestone' }],
  backlog: { items: [{ number: 1, text: 'Backlog' }] },
});
function call(bridge, action, params = {}, extras = {}) {
  return new Promise((resolve, reject) => {
    const { token = bridge.config.token, ...input } = extras;
    const req = request(
      {
        socketPath: bridge.config.socketPath,
        method: 'POST',
        path: '/',
        agent: false,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ identity, action, params, epoch: 'epoch-1', ...input }));
  });
}
async function fixture(t, options = {}) {
  let dto = document();
  const mutations = [];
  const bridge = createRoadmapBridge({
    service: {
      read: async () => structuredClone(dto),
      mutate: async (_cwd, command, actor) => {
        if (command.expectedRevision !== dto.revision)
          throw Object.assign(new Error('Document changed.'), {
            status: 409,
            code: 'roadmap_conflict',
            currentRevision: dto.revision,
          });
        mutations.push({ command, actor });
        dto = { ...dto, revision: dto.revision + 1 };
        return dto;
      },
    },
    resolveCaller: async (value) => {
      if (value.sessionId !== 'root') throw Object.assign(new Error('Unknown session.'), { status: 403 });
      return caller;
    },
    ...options,
  });
  await bridge.ready;
  t.after(() => bridge.close());
  return { bridge, mutations };
}

test('private socket authenticates native context, never model supplied identity or actor', async (t) => {
  const { bridge, mutations } = await fixture(t);
  assert.equal((await call(bridge, 'read', {}, { token: 'not-a-capability' })).status, 403);
  assert.equal(
    (await call(bridge, 'read', {}, { identity: { ...identity, sessionId: 'other' } })).status,
    403,
  );
  assert.equal(
    (await call(bridge, 'read', {}, { identity: { ...identity, cwd: join(cwd, 'other') } })).status,
    403,
  );
  const response = await call(bridge, 'mutate', {
    action: 'plan.patch',
    expectedRevision: 0,
    planId: 'p1',
    title: 'Changed',
    actor: { sessionId: 'spoof' },
  });
  assert.equal(response.status, 200);
  assert.equal(mutations[0].actor.sessionId, 'root');
  assert.equal(mutations[0].actor.by, 'agent');
  assert.ok(!JSON.stringify(response.body).includes(bridge.config.token));
});

test('reads expose stable references and mutations reject stale revisions without replay', async (t) => {
  const { bridge, mutations } = await fixture(t);
  const plan = await call(bridge, 'read', { target: 'plan', planId: 'p1' });
  assert.equal(plan.body.plan.steps[0].id, 's1');
  assert.equal((await call(bridge, 'read', { target: 'plan', planId: 'missing' })).status, 404);
  const command = { action: 'step.check', expectedRevision: 0, planId: 'p1', stepId: 's1', done: true };
  const results = await Promise.all([call(bridge, 'mutate', command), call(bridge, 'mutate', command)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(results.find((result) => result.status === 409).body.currentRevision, 1);
  assert.equal(mutations.length, 1);
  assert.equal((await call(bridge, 'mutate', { ...command, expectedRevision: undefined })).status, 400);
  assert.equal(
    (
      await call(bridge, 'mutate', {
        action: 'plan.attach',
        expectedRevision: 1,
        planId: 'p1',
        sessionId: 'other-project-session',
      })
    ).status,
    403,
  );
});

test('large plans and backlog remain readable in bounded pages with stable references', async (t) => {
  const dto = document();
  dto.plans[0].steps = Array.from({ length: 100 }, (_, i) => ({
    id: `step-${i}`,
    text: '任'.repeat(8000),
    note: '意'.repeat(8000),
    children: [],
    done: false,
  }));
  dto.backlog.items = Array.from({ length: 100 }, (_, i) => ({
    number: i + 1,
    text: '証'.repeat(8000),
    note: '明'.repeat(8000),
    done: false,
  }));
  const { bridge } = await fixture(t, { service: { read: async () => dto } });
  const first = await call(bridge, 'read', { target: 'plan', planId: 'p1', limit: 50 });
  assert.equal(first.status, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(first.body)) < 128 * 1024);
  assert.equal(first.body.flatSteps[0].id, 'step-0');
  assert.ok(first.body.textTruncated);
  assert.ok(first.body.nextOffset > 0);
  const next = await call(bridge, 'read', { target: 'plan', planId: 'p1', offset: first.body.nextOffset });
  assert.equal(next.body.flatSteps[0].id, `step-${first.body.nextOffset}`);
  const backlog = await call(bridge, 'read', { target: 'backlog', limit: 50 });
  assert.equal(backlog.status, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(backlog.body)) < 128 * 1024);
  assert.ok(backlog.body.nextOffset > 0);
  assert.equal(backlog.body.totalItems, 100);
});

test('activity is ephemeral, validates targets and cannot return after agent end or owner revoke', async (t) => {
  let clock = 0;
  const { bridge } = await fixture(t, { now: () => clock, ttl: 100 });
  const targets = [{ kind: 'plan', planId: 'p1', stepId: 's1' }];
  assert.equal((await call(bridge, 'work', { targets: [{ kind: 'plan', planId: 'no' }] })).status, 404);
  assert.equal((await call(bridge, 'work', { targets })).status, 200);
  const first = bridge.snapshot(cwd);
  assert.equal(first.activity.length, 1);
  assert.equal(first.activity[0].sessionId, 'root');
  assert.equal(first.activity[0].epoch, undefined);
  assert.equal((await call(bridge, 'heartbeat')).status, 200);
  assert.equal(bridge.snapshot(cwd).activityRevision, first.activityRevision);
  await call(bridge, 'clear');
  assert.equal(bridge.snapshot(cwd).activity.length, 0);
  assert.equal((await call(bridge, 'work', { targets })).status, 409);
  await call(bridge, 'work', { targets }, { epoch: 'next-turn' });
  assert.equal(bridge.snapshot(cwd).activity.length, 1);
  clock = 101;
  assert.equal((await call(bridge, 'heartbeat', {}, { epoch: 'next-turn' })).status, 409);
  assert.equal(bridge.snapshot(cwd).activity.length, 0);
  await call(bridge, 'work', { targets }, { epoch: 'third-turn' });
  bridge.revokeOwner('run-1');
  assert.equal(bridge.snapshot(cwd).activity.length, 0);
  assert.equal((await call(bridge, 'work', { targets }, { epoch: 'fourth-turn' })).status, 403);
  assert.equal(
    (await call(bridge, 'mutate', { action: 'vision.set', expectedRevision: 0, text: 'Late' })).status,
    403,
  );
});

test('an in-flight work read cannot resurrect activity after ending or revocation', async (t) => {
  let release;
  const pending = new Promise((resolve) => (release = resolve));
  const { bridge } = await fixture(t, { service: { read: () => pending } });
  const work = call(bridge, 'work', { targets: [{ kind: 'plan', planId: 'p1' }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await call(bridge, 'clear');
  release(document());
  assert.equal((await work).status, 403);
  assert.equal(bridge.snapshot(cwd).activity.length, 0);
});

test('owner activity loss clears badges without keeping a persistent plan active', async (t) => {
  let active = true;
  const { bridge } = await fixture(t, { isOwnerActive: () => active });
  await call(bridge, 'work', { targets: [{ kind: 'milestone', milestoneId: 'm1' }] });
  active = false;
  assert.equal(bridge.snapshot(cwd).activity.length, 0);
  assert.equal((await call(bridge, 'read')).status, 403);
});

test('native resolver verifies root and deep child lineage, exact project and live run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-native-identity-'));
  const project = join(root, 'project'),
    agentHome = join(root, 'agent'),
    sessionDir = join(agentHome, 'sessions');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
  const files = {};
  for (const id of ['root', 'child', 'grandchild', 'unrelated']) {
    files[id] = join(sessionDir, `${id}.jsonl`);
    await writeFile(files[id], JSON.stringify({ type: 'session', id, cwd: project }) + '\n');
  }
  const before = await readFile(files.grandchild, 'utf8');
  const run = { id: 'run-verified', sessionId: 'root', cwd: project, status: 'running' };
  const edges = [
    { parent: files.root, child: files.child, childId: 'child-handle', name: 'builder' },
    { parent: files.child, child: files.grandchild, childId: 'grandchild-handle', name: 'tester' },
  ];
  const resolveCaller = createRoadmapCallerResolver({
    getRuns: () => [run],
    store: { findProject: async (cwd) => ({ cwd }) },
    agentHome,
    sessionDir,
    readEdges: async () => edges,
  });
  const native = (id) => ({ cwd: project, sessionId: id, sessionFile: files[id] });
  assert.equal((await resolveCaller(native('root'))).ownerId, 'run-verified');
  const child = await resolveCaller(native('grandchild'));
  assert.equal(child.sessionId, 'grandchild');
  assert.equal(child.parentSessionId, 'child');
  assert.equal(child.rootSessionId, 'root');
  assert.equal(child.agentId, 'grandchild-handle');
  assert.equal(child.name, 'tester');
  await assert.rejects(resolveCaller(native('unrelated')), { status: 403 });
  await assert.rejects(resolveCaller({ ...native('child'), cwd: root }), { status: 403 });
  await assert.rejects(resolveCaller({ ...native('child'), sessionId: 'root' }), { status: 403 });
  run.status = 'stopping';
  await assert.rejects(resolveCaller(native('grandchild')), { status: 403 });
  assert.equal(await readFile(files.grandchild, 'utf8'), before);
});

test('CU model provenance follows the verified native selected branch, never wire hints', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cu-model-identity-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = join(root, 'project'),
    agentHome = join(root, 'agent'),
    sessionDir = join(agentHome, 'sessions');
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
  const parent = join(sessionDir, 'parent.jsonl'),
    child = join(sessionDir, 'child.jsonl');
  await writeFile(parent, JSON.stringify({ type: 'session', id: 'parent', cwd }) + '\n');
  const entries = [
    { type: 'session', id: 'child', cwd },
    { type: 'model_change', id: 'm1', parentId: null, provider: 'fixture', modelId: 'vision' },
    { type: 'model_change', id: 'abandoned', parentId: 'm1', provider: 'fixture', modelId: 'wrong-branch' },
    { type: 'thinking_level_change', id: 't1', parentId: 'm1', thinkingLevel: 'low' },
  ];
  await writeFile(child, entries.map(JSON.stringify).join('\n') + '\n');
  const store = createStore({ dataDir: join(root, 'data'), agentHome, sessionDir });
  const seen = [];
  const resolver = createRoadmapCallerResolver({
    getRuns: () => [{ id: 'run', sessionId: 'parent', cwd, status: 'running' }],
    store: {
      findProject: async () => ({ cwd }),
      inspectFile: async (file) => {
        seen.push(file);
        return store.inspectFile(file);
      },
    },
    agentHome,
    sessionDir,
    includeModel: true,
    readEdges: async () => [{ parent, child, childId: 'native-child', name: 'worker' }],
  });
  const identity = { cwd, sessionId: 'child', sessionFile: child, model: 'forged/model', imageCapable: true };
  assert.equal((await resolver(identity)).model, 'fixture/vision');
  assert.equal(seen.length, 1);
  entries.push({ type: 'model_change', id: 'm2', parentId: 't1', provider: 'fixture', modelId: 'other' });
  await writeFile(child, entries.map(JSON.stringify).join('\n') + '\n');
  assert.equal((await resolver(identity)).model, 'fixture/other');
  const reads = seen.length;
  await assert.rejects(resolver({ ...identity, sessionId: 'spoofed' }), { status: 403 });
  assert.equal(seen.length, reads, 'unverified identity cannot trigger transcript reads');
});
