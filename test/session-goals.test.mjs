import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createSessionGoals, validateGoalEdit, validateGoalResume } from '../lib/session-goals.mjs';
import { canResumeGoal, publicGoal } from '../lib/goal-state.mjs';
import { normalizeEvent } from '../lib/agent.mjs';

const cwd = resolve('test/goal-project');
const original = {
  goalId: 'goal-1',
  objective: 'Finish the project',
  status: 'active',
  active: true,
  tokensUsed: 200,
  tokenBudget: 1000,
  timeUsedSeconds: 10,
  continuationsUsed: 2,
};
const edit = {
  cwd,
  goalId: original.goalId,
  expectedObjective: original.objective,
  objective: 'Ship the project',
};
function fixture(extra = {}) {
  const calls = [];
  const service = createSessionGoals({
    store: { history: async (id) => ({ id, cwd, file: resolve('test/session.jsonl'), goal: original }) },
    getRuns: () => [],
    getClient: () => null,
    getSavedCapabilities: async () => ({ editable: true, controllable: false }),
    editSavedGoal: async (input) => {
      calls.push(input);
      return { ...original, objective: input.objective };
    },
    ...extra,
  });
  return { service, calls };
}

test('idle goal read is passive; edits are scoped to the canonical session file', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.get('thread-1'), { goal: original, editable: true });
  assert.equal(f.calls.length, 0);
  const saved = await f.service.update('thread-1', edit);
  assert.equal(saved.goal.objective, edit.objective);
  assert.equal(saved.goal.tokensUsed, 200);
  assert.equal(f.calls[0].sessionId, 'thread-1');
  assert.equal(f.calls[0].sessionFile, resolve('test/session.jsonl'));
  await assert.rejects(f.service.update('thread-1', { ...edit, cwd: resolve('different') }), { status: 409 });
  assert.equal(f.calls.length, 1);
});

test('an engine without advertised capabilities shows its saved goal read-only', async () => {
  const f = fixture({ getSavedCapabilities: async () => ({ editable: false, controllable: false }) });
  assert.deepEqual(await f.service.get('thread-1'), { goal: original, editable: false });
  assert.equal(f.calls.length, 0);
});

test('Error, paused, and budget-limited goals require native resume support and remaining budget', async () => {
  const errored = { ...original, status: 'error', active: false };
  const supported = fixture({
    store: { history: async () => ({ cwd, goal: errored }) },
    getSavedCapabilities: async () => ({ editable: true, resumable: true }),
  });
  assert.equal((await supported.service.get('thread-1')).resumable, true);
  assert.equal(
    (
      await fixture({
        store: { history: async () => ({ cwd, goal: errored }) },
        getSavedCapabilities: async () => ({ editable: true }),
      }).service.get('thread-1')
    ).resumable,
    undefined,
  );
  assert.equal(
    (
      await fixture({
        store: { history: async () => ({ cwd, goal: { ...errored, tokensUsed: 1000 } }) },
        getSavedCapabilities: async () => ({ resumable: true }),
      }).service.get('thread-1')
    ).resumable,
    undefined,
  );
  assert.equal(
    (
      await fixture({
        store: { history: async () => ({ cwd, goal: errored }) },
        getRuns: () => [{ sessionId: 'thread-1', status: 'running' }],
        getSavedCapabilities: async () => ({ resumable: true }),
      }).service.get('thread-1')
    ).resumable,
    undefined,
  );
  for (const status of ['error', 'paused', 'budget_limited']) {
    const resumable = { ...errored, status };
    assert.equal(canResumeGoal(resumable), true);
    assert.equal(validateGoalResume({ cwd, goal: resumable }, edit).goalId, original.goalId);
  }
  for (const changed of [
    { ...errored, objective: 'Changed elsewhere' },
    { ...errored, goalId: 'another-goal' },
    { ...errored, status: 'active' },
    { ...errored, status: 'complete' },
    { ...errored, tokensUsed: 1000 },
    { ...errored, tokenBudget: 0 },
    { ...errored, tokenBudget: Number.MAX_SAFE_INTEGER + 1 },
    { ...errored, tokensUsed: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.throws(() => validateGoalResume({ cwd, goal: changed }, edit), { status: 409 });
});

test('live edits use the existing worker and keep maintenance calls out of active sessions', async () => {
  let closed = 0,
    changed = 0;
  const f = fixture({
    getRuns: () => [{ sessionId: 'thread-1', status: 'running' }],
    getClient: () => ({
      getGoal: async () => ({ goal: { ...original, tokensUsed: 245 }, editable: true }),
      editGoal: async (id, directory, input) => {
        assert.equal(id, 'thread-1');
        assert.equal(directory, cwd);
        changed++;
        return { ...original, objective: input.objective };
      },
      close: () => closed++,
    }),
  });
  assert.equal((await f.service.get('thread-1')).goal.tokensUsed, 245);
  assert.equal((await f.service.update('thread-1', edit)).goal.objective, edit.objective);
  assert.equal(changed, 1);
  assert.equal(closed, 2);
  assert.equal(f.calls.length, 0);
});

test('live edit preserves the connected engine control capability in its response', async () => {
  for (const controllable of [true, false]) {
    const f = fixture({
      getRuns: () => [{ sessionId: 'thread-1', status: 'running' }],
      getSavedCapabilities: () => assert.fail('A live edit must not probe an idle engine'),
      getClient: () => ({
        getGoal: async () => ({ goal: original, editable: true, controllable }),
        editGoal: async () => ({ ...original, objective: edit.objective }),
        close() {},
      }),
    });
    assert.deepEqual(await f.service.update('thread-1', edit), {
      goal: { ...original, objective: edit.objective },
      editable: true,
      ...(controllable && { controllable: true }),
    });
  }
});

test('concurrent edits and run admission cannot race a maintenance edit', async () => {
  let settle, entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const f = fixture({
    editSavedGoal: async () => {
      entered();
      return new Promise((done) => {
        settle = done;
      });
    },
  });
  const first = f.service.update('thread-1', edit);
  await started;
  assert.equal(f.service.busy('thread-1'), true);
  await assert.rejects(f.service.update('thread-1', edit), { status: 409 });
  settle({ ...original, objective: edit.objective });
  await first;
  assert.equal(f.service.busy('thread-1'), false);
  await assert.rejects(fixture({ isAdmitting: () => true }).service.update('thread-1', edit), {
    status: 409,
  });
});

test('conflicts and unconfirmed edits never become a success or a blind retry', async () => {
  let calls = 0;
  const f = fixture({
    editSavedGoal: async () => {
      calls++;
      throw Object.assign(new Error('Changed on another device'), { status: 409 });
    },
  });
  await assert.rejects(f.service.update('thread-1', edit), { status: 409 });
  assert.equal(calls, 1);
  assert.equal(f.service.busy('thread-1'), false);
  await assert.rejects(fixture({ editSavedGoal: async () => original }).service.update('thread-1', edit), {
    status: 503,
  });
});

test('validation accepts Unicode characters and forbids budget/status mutation', () => {
  assert.equal([...validateGoalEdit({ ...edit, objective: '🪐'.repeat(4000) }).objective].length, 4000);
  for (const body of [
    null,
    { ...edit, objective: ' ' },
    { ...edit, objective: 'x'.repeat(4001) },
    { ...edit, objective: 'x\0y' },
    { ...edit, tokenBudget: 10000 },
    { ...edit, status: 'active' },
  ])
    assert.throws(() => validateGoalEdit(body), { status: 400 });
  assert.equal(publicGoal({ ...original, status: 'idle' }), null);
  assert.equal(publicGoal({ ...original, tokensUsed: NaN }), null);
  assert.deepEqual(normalizeEvent({ type: 'goal_update', goal: { ...original, privateKey: 'not-public' } }), [
    { kind: 'goal', goal: original },
  ]);
});

test('paused goals explain a running/stopping/admitting blocker and become resumable when idle', async () => {
  const paused = { ...original, status: 'paused', active: false };
  let runs = [{ sessionId: 'thread-1', status: 'running' }];
  let admitting = false;
  const f = fixture({
    getSavedCapabilities: async () => ({ resumable: true }),
    store: { history: async (id) => ({ id, cwd, goal: paused }) },
    getRuns: () => runs,
    isAdmitting: () => admitting,
    getClient: () => ({
      getGoal: async () => ({ goal: paused, editable: true, controllable: true }),
      close() {},
    }),
  });
  assert.equal((await f.service.get('thread-1')).resumeBlocked, 'running');
  assert.notEqual((await f.service.get('thread-1')).resumable, true);
  runs[0].status = 'stopping';
  assert.equal((await f.service.get('thread-1')).resumeBlocked, 'stopping');
  runs = [];
  admitting = true;
  assert.equal((await f.service.get('thread-1')).resumeBlocked, 'busy');
  admitting = false;
  const idle = await f.service.get('thread-1');
  assert.equal(idle.resumable, true);
  assert.equal(idle.resumeBlocked, undefined);
  assert.deepEqual(idle.goal, paused, 'GET never resumes or resets accounting');
  assert.equal(f.calls.length, 0);
});

test('Stop returns Resume capability immediately after the live run finishes', async () => {
  const paused = { ...original, status: 'paused', active: false };
  let runs = [{ sessionId: 'thread-1', status: 'running' }];
  let stopped = 0;
  const f = fixture({
    getSavedCapabilities: async () => ({ resumable: true, controllable: true }),
    getRuns: () => runs,
    getClient: () => ({ controlGoal: async () => paused, close() {} }),
    stopRun: async () => {
      stopped++;
      runs = [];
    },
  });
  const result = await f.service.control('thread-1', 'stop', {
    cwd,
    goalId: original.goalId,
    expectedObjective: original.objective,
  });
  assert.equal(stopped, 1);
  assert.equal(result.resumable, true, 'the POST response must not lose the Resume button');
  assert.equal(result.resumeBlocked, undefined);
  assert.deepEqual(result.goal, paused);
});

test('unsupported engines never advertise Resume blockers, including while busy', async () => {
  for (const status of ['running', 'stopping', 'busy']) {
    const paused = { ...original, status: 'paused', active: false };
    const f = fixture({
      store: { history: async () => ({ cwd, goal: paused }) },
      getSavedCapabilities: async () => ({ editable: false, resumable: false }),
      getRuns: () => (status === 'busy' ? [] : [{ sessionId: 'thread-1', status }]),
      isAdmitting: () => status === 'busy',
    });
    const result = await f.service.get('thread-1');
    assert.equal(result.resumable, undefined);
    assert.equal(result.resumeBlocked, undefined);
    assert.equal(result.editable, false);
  }
});

test('editing a paused goal preserves resume capability, while unsupported/exhausted goals remain fenced', async () => {
  const paused = { ...original, status: 'paused', active: false };
  const f = fixture({
    getSavedCapabilities: async () => ({ resumable: true, editable: true }),
    editSavedGoal: async ({ objective }) => ({ ...paused, objective }),
  });
  assert.equal((await f.service.update('thread-1', edit)).resumable, true);
  for (const [supported, goal] of [
    [false, paused],
    [true, { ...paused, tokensUsed: 1000 }],
  ]) {
    const limited = fixture({
      getSavedCapabilities: async () => ({ resumable: supported }),
      store: { history: async (id) => ({ id, cwd, goal }) },
    });
    const result = await limited.service.get('thread-1');
    assert.equal(result.resumable, undefined);
    assert.equal(result.resumeBlocked, undefined);
  }
});
