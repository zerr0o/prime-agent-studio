import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createGoalRecovery } from '../lib/goal-recovery.mjs';

const goal = {
  goalId: 'goal-1',
  objective: 'Fixture goal',
  status: 'active',
  tokensUsed: 2,
  timeUsedSeconds: 3,
  continuationsUsed: 1,
  tokenBudget: 100,
};

test('goal replacement binds only the exact tracked run and preserves admission metadata', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun({ ...f.entry, goalId: 'old-goal' });
  assert.equal(
    await recovery.updateGoal({ sessionId: f.entry.sessionId, runId: f.entry.runId, goalId: 'new-goal' }),
    true,
  );
  const entries = JSON.parse(await readFile(join(f.dataDir, 'goal-recovery.json'), 'utf8')).entries;
  assert.deepEqual(entries[f.entry.sessionId], {
    sessionId: f.entry.sessionId,
    cwd: f.entry.cwd,
    model: f.entry.model,
    thinking: f.entry.thinking,
    allowQuestions: true,
    revision: f.entry.runId,
    goalId: 'new-goal',
    previousUserId: null,
  });
  assert.equal(
    await recovery.updateGoal({ sessionId: f.entry.sessionId, runId: 'stale-run', goalId: 'stale-goal' }),
    false,
  );
  assert.equal(
    JSON.parse(await readFile(join(f.dataDir, 'goal-recovery.json'), 'utf8')).entries[f.entry.sessionId]
      .goalId,
    'new-goal',
  );
});

test('late goal updates cannot undo suppression or create untracked run intent', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  assert.equal(
    await recovery.updateGoal({ sessionId: f.entry.sessionId, runId: f.entry.runId, goalId: 'new-goal' }),
    false,
  );
  await recovery.recordRun(f.entry);
  await recovery.suppress(f.entry.sessionId);
  assert.equal(
    await recovery.updateGoal({ sessionId: f.entry.sessionId, runId: f.entry.runId, goalId: 'new-goal' }),
    false,
  );
  assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'goal-recovery.json'), 'utf8')).entries, {});
  await recovery.recover();
  assert.equal(f.calls.length, 0);
});

test('goal binding rejects malformed IDs without changing the journal', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun(f.entry);
  const before = await readFile(join(f.dataDir, 'goal-recovery.json'), 'utf8');
  for (const field of ['sessionId', 'runId', 'goalId'])
    await assert.rejects(
      recovery.updateGoal({
        sessionId: f.entry.sessionId,
        runId: f.entry.runId,
        goalId: 'new-goal',
        [field]: 'bad/identity',
      }),
      /Invalid recoverable goal identity/,
    );
  assert.equal(await readFile(join(f.dataDir, 'goal-recovery.json'), 'utf8'), before);
});
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'goal-recovery-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cwd = join(dataDir, 'project'),
    file = join(dataDir, 'session.jsonl');
  const history = {
    id: 'session-1',
    cwd,
    file,
    goal: { ...goal },
    messages: [{ id: 'user-1', role: 'user' }],
  };
  const overview = { projects: [{ cwd, exists: true, sessions: [{ id: 'session-1' }] }] };
  const calls = [],
    errors = [];
  let busy = false;
  const store = { overview: async () => overview, history: async () => history };
  const options = {
    dataDir,
    store,
    startRun: async (input, g) => calls.push({ input, goal: g }),
    isBusy: () => busy,
    onError: (e) => errors.push(e),
  };
  const entry = {
    sessionId: 'session-1',
    cwd,
    model: 'provider/model',
    thinking: 'high',
    allowQuestions: true,
    runId: 'run-1',
    previousUserId: null,
  };
  return {
    dataDir,
    history,
    overview,
    calls,
    errors,
    store,
    options,
    entry,
    setBusy: (value) => {
      busy = value;
    },
    make: () => createGoalRecovery(options),
  };
}

test('restart recovers only recorded active goal, preserves metadata and private journal', async (t) => {
  const f = await fixture(t),
    before = f.make();
  await before.recordRun(f.entry);
  await before.close();
  assert.equal(f.calls.length, 0, 'recording intent does not launch');
  const body = await readFile(join(f.dataDir, 'goal-recovery.json'), 'utf8');
  assert.ok(!body.includes(goal.objective));
  assert.ok(!body.includes('prompt'));
  if (process.platform !== 'win32')
    assert.equal((await stat(join(f.dataDir, 'goal-recovery.json'))).mode & 0o777, 0o600);
  const after = f.make();
  t.after(() => after.close());
  assert.deepEqual(await after.recover(), { started: 1, skipped: 0 });
  assert.deepEqual(f.calls[0].input, {
    sessionId: f.entry.sessionId,
    cwd: f.entry.cwd,
    allowQuestions: true,
  });
  assert.equal(f.calls[0].goal.goalId, goal.goalId);
  await after.recover();
  assert.equal(f.calls.length, 1, 'same instance never repeats admission');
});

test('manual stop removes intent durably before next boot', async (t) => {
  const f = await fixture(t),
    before = f.make();
  await before.recordRun(f.entry);
  await before.suppress(f.entry.sessionId);
  await before.close();
  const after = f.make();
  t.after(() => after.close());
  await after.recover();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'goal-recovery.json'), 'utf8')).entries, {});
});

test('historical active goals without run intent are never scanned or resumed', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recover();
  assert.equal(f.calls.length, 0);
});

for (const variant of [
  'paused',
  'complete',
  'budget_limited',
  'error',
  'clear',
  'budget',
  'zero-budget',
  'streak',
  'invalid-streak',
  'archived',
  'removed',
  'child',
  'cwd',
  'missing-file',
])
  test(`ineligible ${variant} is not resumed and its intent is removed`, async (t) => {
    const f = await fixture(t),
      recovery = f.make();
    t.after(() => recovery.close());
    await recovery.recordRun(variant === 'clear' ? { ...f.entry, goalId: goal.goalId } : f.entry);
    if (['paused', 'complete', 'budget_limited', 'error'].includes(variant)) f.history.goal.status = variant;
    else if (variant === 'clear') f.history.goal = null;
    else if (variant === 'budget') f.history.goal.tokensUsed = 100;
    else if (variant === 'zero-budget') f.history.goal.tokenBudget = 0;
    else if (variant === 'streak') f.history.goal.noProgressStreak = 3;
    else if (variant === 'invalid-streak') f.history.goal.noProgressStreak = -1;
    else if (variant === 'archived') f.overview.projects[0].sessions[0].archived = true;
    else if (variant === 'removed') f.overview.projects = [];
    else if (variant === 'child') f.history.parentSessionId = 'parent-1';
    else if (variant === 'cwd') f.history.cwd = join(f.dataDir, 'other');
    else if (variant === 'missing-file') f.history.file = null;
    await recovery.recover();
    assert.equal(f.calls.length, 0);
    assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'goal-recovery.json'), 'utf8')).entries, {});
  });

test('duplicate recover calls share one operation; busy run is not duplicated', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun(f.entry);
  f.setBusy(true);
  await Promise.all([recovery.recover(), recovery.recover()]);
  assert.equal(f.calls.length, 0);
  f.setBusy(false);
  await Promise.all([recovery.recover(), recovery.recover()]);
  assert.equal(f.calls.length, 1);
});

test('manual suppression races pending discovery and prevents admission', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun(f.entry);
  let release, entered;
  const reached = new Promise((r) => {
    entered = r;
  });
  f.store.history = async () => {
    entered();
    await new Promise((r) => {
      release = r;
    });
    return f.history;
  };
  const pending = recovery.recover();
  await reached;
  await recovery.suppress(f.entry.sessionId);
  release();
  await pending;
  assert.equal(f.calls.length, 0);
});

test('close while discovery is pending prevents a new start', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  await recovery.recordRun(f.entry);
  let release, entered;
  const reached = new Promise((r) => {
    entered = r;
  });
  f.store.history = async () => {
    entered();
    await new Promise((r) => {
      release = r;
    });
    return f.history;
  };
  const pending = recovery.recover();
  await reached;
  const closing = recovery.close();
  release();
  await pending;
  await closing;
  assert.equal(f.calls.length, 0);
});

test('corrupt journal fails closed without replacing evidence', async (t) => {
  const f = await fixture(t),
    file = join(f.dataDir, 'goal-recovery.json');
  await writeFile(file, '{broken');
  const recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recover();
  assert.equal(f.calls.length, 0);
  assert.equal(f.errors.length, 1);
  await assert.rejects(recovery.recordRun(f.entry), /unreadable/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('changed goal between discovery and admission is never resumed', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun(f.entry);
  let reads = 0;
  f.store.history = async () => ({
    ...f.history,
    goal: { ...goal, goalId: ++reads === 1 ? 'goal-1' : 'goal-2' },
  });
  await recovery.recover();
  assert.equal(f.calls.length, 0);
});

test('transient admission failure stays recorded for another boot, not rapid retry', async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  f.options.startRun = async () => {
    attempts++;
    throw new Error('Admission unavailable');
  };
  const recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun(f.entry);
  await recovery.recover();
  await recovery.recover();
  assert.equal(attempts, 1);
  assert.ok(JSON.parse(await readFile(join(f.dataDir, 'goal-recovery.json'), 'utf8')).entries['session-1']);
});

test('normal completion retires intent without suppressing a later explicit run', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun(f.entry);
  await recovery.retire(f.entry.sessionId, f.entry.runId);
  assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'goal-recovery.json'), 'utf8')).entries, {});
  await recovery.recordRun({ ...f.entry, runId: 'run-2' });
  await recovery.recover();
  assert.equal(f.calls.length, 1);
});

test('late completion of old run preserves newer revision', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun(f.entry);
  await recovery.recordRun({ ...f.entry, runId: 'run-2' });
  await recovery.retire(f.entry.sessionId, f.entry.runId);
  const persisted = JSON.parse(await readFile(join(f.dataDir, 'goal-recovery.json'), 'utf8'));
  assert.equal(persisted.entries[f.entry.sessionId].revision, 'run-2');
});

test('known recorded goal mismatch is not resumed', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun({ ...f.entry, goalId: 'different-goal' });
  await recovery.recover();
  assert.equal(f.calls.length, 0);
});

test('recovery does not override current saved model or reasoning with old run settings', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun({ ...f.entry, goalId: goal.goalId });
  f.history.generationSettings = { model: 'new/model', thinking: 'medium' };
  await recovery.recover();
  assert.equal('model' in f.calls[0].input, false);
  assert.equal('thinking' in f.calls[0].input, false);
});

test('recorded interrupted non-goal run resumes once after restart with an explicit null goal', async (t) => {
  const f = await fixture(t);
  f.history.goal = null;
  const before = f.make();
  await before.recordRun(f.entry);
  await before.close();
  const after = f.make();
  t.after(() => after.close());
  await after.recover();
  await after.recover();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].goal, null);
});

for (const action of ['retire', 'suppress'])
  test(`non-goal ${action} remains stopped after restart`, async (t) => {
    const f = await fixture(t);
    f.history.goal = null;
    const before = f.make();
    await before.recordRun(f.entry);
    if (action === 'retire') await before.retire(f.entry.sessionId, f.entry.runId);
    else await before.suppress(f.entry.sessionId);
    await before.close();
    const after = f.make();
    t.after(() => after.close());
    await after.recover();
    assert.equal(f.calls.length, 0);
  });

test('a goal appearing between two non-goal discovery reads is not admitted', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun(f.entry);
  let reads = 0;
  f.store.history = async () => ({ ...f.history, goal: ++reads === 1 ? null : { ...goal } });
  await recovery.recover();
  assert.equal(f.calls.length, 0);
});

test('unknown journal goal cannot revive a cleared goal tombstone', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun(f.entry);
  f.history.goal = null;
  f.history.goalEverKnown = true;
  await recovery.recover();
  assert.equal(f.calls.length, 0);
});

test('crash before the new user prompt is persisted never resumes the previous task', async (t) => {
  const f = await fixture(t);
  f.history.goal = null;
  const before = f.make();
  await before.recordRun({ ...f.entry, previousUserId: 'user-1' });
  await before.close();
  const after = f.make();
  t.after(() => after.close());
  await after.recover();
  assert.equal(f.calls.length, 0);
});

test('persisted new user ID admits the recorded non-goal task', async (t) => {
  const f = await fixture(t);
  f.history.goal = null;
  const before = f.make();
  await before.recordRun({ ...f.entry, previousUserId: 'prior-user' });
  await before.close();
  const after = f.make();
  t.after(() => after.close());
  await after.recover();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].goal, null);
});

test('trusted recovered user ID can survive a second restart without a new prompt', async (t) => {
  const f = await fixture(t);
  f.history.goal = null;
  const first = f.make();
  await first.recordRun({ ...f.entry, acceptedUserId: 'user-1' });
  await first.close();
  const second = f.make();
  await second.recover();
  assert.equal(f.calls.length, 1);
  await second.recordRun({ ...f.entry, runId: 'run-2', acceptedUserId: 'user-1' });
  await second.close();
  const third = f.make();
  t.after(() => third.close());
  await third.recover();
  assert.equal(f.calls.length, 2);
});

test('stale accepted user ID and legacy unfenced intent both fail closed for non-goal tasks', async (t) => {
  const f = await fixture(t);
  f.history.goal = null;
  const recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun({ ...f.entry, acceptedUserId: 'stale-user' });
  await recovery.recover();
  assert.equal(f.calls.length, 0);
  const { previousUserId, ...legacy } = f.entry;
  await recovery.recordRun({ ...legacy, runId: 'legacy-run' });
  await recovery.recover();
  assert.equal(f.calls.length, 0);
});

test('user ID changed during discovery is not recovered', async (t) => {
  const f = await fixture(t),
    recovery = f.make();
  t.after(() => recovery.close());
  await recovery.recordRun(f.entry);
  let reads = 0;
  f.store.history = async () => ({
    ...f.history,
    goal: null,
    messages: [{ id: ++reads === 1 ? 'user-1' : 'user-2', role: 'user' }],
  });
  await recovery.recover();
  assert.equal(f.calls.length, 0);
});
