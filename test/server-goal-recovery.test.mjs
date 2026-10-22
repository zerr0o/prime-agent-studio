import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createApp } from '../server.mjs';

const goal = {
  goalId: 'goal-1',
  objective: 'Fixture active goal',
  status: 'active',
  tokensUsed: 4,
  timeUsedSeconds: 2,
  continuationsUsed: 1,
  tokenBudget: 1000,
};
async function fixture(t, { withGoal = true, goalState = goal } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'server-goal-recovery-'));
  const cwd = join(root, 'project'),
    dataDir = join(root, 'studio'),
    sessionDir = join(root, 'sessions'),
    agentHome = join(root, 'agent');
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(agentHome)]);
  const instances = [];
  t.after(async () => {
    for (const instance of instances) await instance.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function runtime() {
    const controls = [];
    return {
      canRecoverGoals: true,
      controls,
      getStatus: async () => ({ available: true, version: 'fixture' }),
      getModels: async () => ({
        models: ['test/model', 'test/new-model'].map((id) => ({
          id,
          provider: 'test',
          thinkingLevels: ['medium', 'high'],
          availability: 'available',
        })),
        default: { model: 'test/model', thinking: 'medium' },
      }),
      async start(input) {
        const sessionId = input.sessionId || 'native-session',
          file = input.sessionFile || join(sessionDir, sessionId + '.jsonl');
        if (!input.sessionId)
          await writeFile(
            file,
            [
              { type: 'session', id: sessionId, cwd, timestamp: '2026-10-14T00:00:00.000Z' },
              {
                type: 'message',
                id: 'user-1',
                parentId: null,
                message: { role: 'user', content: 'Fixture initial task' },
              },
              ...(withGoal
                ? [
                    {
                      type: 'custom',
                      id: 'goal-state-1',
                      parentId: 'user-1',
                      customType: 'thread_goal_state',
                      data: goalState,
                    },
                  ]
                : []),
            ]
              .map((v) => JSON.stringify(v))
              .join('\n') + '\n',
          );
        await input.onReady({ sessionId, sessionFile: file, cwd });
        const journal = JSON.parse(await readFile(join(dataDir, 'goal-recovery.json'), 'utf8'));
        assert.equal(
          journal.entries[sessionId].sessionId,
          sessionId,
          'intent persists before any prompt executes',
        );
        assert.equal(journal.entries[sessionId].thinking, input.thinking);
        let finish;
        const done = new Promise((resolve) => {
          finish = resolve;
        });
        const control = {
          input,
          sessionId,
          file,
          done,
          finish: () => finish({ status: 'completed', code: 0 }),
          cancel: async () => {
            finish({ status: 'stopped', code: 0 });
            return done;
          },
        };
        controls.push(control);
        input.onEvent({ kind: 'session', sessionId, cwd });
        return control;
      },
      async close() {
        await Promise.all(controls.map((c) => c.cancel()));
      },
    };
  }
  async function boot(beforeListen = () => {}) {
    const engine = runtime();
    const app = createApp({ dataDir, sessionDir, agentHome, initialCwd: cwd, runtime: engine });
    let closed = false;
    const instance = {
      app,
      engine,
      close: async () => {
        if (!closed) {
          closed = true;
          await app.close();
        }
      },
    };
    instances.push(instance);
    beforeListen(app);
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + app.server.address().port;
    instance.api = async (path, body) => {
      const response = await fetch(url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json() };
    };
    return instance;
  }
  return { cwd, dataDir, sessionDir, boot };
}

for (const changedRead of [3, 5])
  test(`non-goal admission preserves the accepted user fence through history read ${changedRead}`, async (t) => {
    const f = await fixture(t, { withGoal: false }),
      first = await f.boot();
    assert.equal(
      (await first.api('/api/runs', { cwd: f.cwd, message: 'Original fixture task' })).status,
      201,
    );
    await first.close();
    let reads = 0;
    const second = await f.boot((app) => {
      const history = app.store.history;
      app.store.history = async (id) => {
        const value = await history(id);
        if (++reads >= changedRead)
          return { ...value, messages: [{ id: 'different-user-task', role: 'user', text: 'Changed task' }] };
        return value;
      };
    });
    await second.app.goalRecovery.recover();
    assert.equal(
      second.engine.controls.length,
      0,
      'a different user task must not receive the recovery prompt',
    );
    assert.ok(reads >= changedRead);
  });

test('HTTP new run persists before prompt and fresh Studio resumes its goal once', async (t) => {
  const f = await fixture(t),
    first = await f.boot();
  const initial = await first.api('/api/runs', {
    cwd: f.cwd,
    message: 'Fixture task',
    model: 'test/model',
    thinking: 'high',
    allowQuestions: true,
  });
  assert.equal(initial.status, 201, JSON.stringify(initial.json));
  assert.equal(first.engine.controls.length, 1);
  const sid = first.engine.controls[0].sessionId;
  await first.close();
  const retained = JSON.parse(await readFile(join(f.dataDir, 'goal-recovery.json'), 'utf8'));
  assert.ok(retained.entries[sid], 'server shutdown preserves intent');
  const stateFile = join(f.dataDir, 'workspace.json');
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  saved.sessions[sid].generationSettings = {
    ...saved.sessions[sid].generationSettings,
    model: 'test/new-model',
    thinking: 'medium',
  };
  await writeFile(stateFile, JSON.stringify(saved));
  const second = await f.boot();
  await second.app.goalRecovery.recover();
  assert.equal(second.engine.controls.length, 1);
  const recovered = second.engine.controls[0].input;
  assert.equal(recovered.sessionId, sid);
  assert.equal(recovered.goalRecovery.goalId, goal.goalId);
  assert.equal(recovered.model, 'test/new-model', 'current saved model wins over journal');
  assert.equal(recovered.thinking, 'medium', 'current saved reasoning wins over journal');
  assert.equal(recovered.allowQuestions, true);
  await second.app.goalRecovery.recover();
  assert.equal(second.engine.controls.length, 1);
});

test('normal completed run is retired before another boot can revive it', async (t) => {
  const f = await fixture(t),
    first = await f.boot();
  assert.equal((await first.api('/api/runs', { cwd: f.cwd, message: 'Fixture task' })).status, 201);
  first.engine.controls[0].finish();
  await Promise.resolve();
  await first.close();
  const second = await f.boot();
  await second.app.goalRecovery.recover();
  assert.equal(second.engine.controls.length, 0);
});

test('HTTP manual run stop suppresses persisted intent across restart', async (t) => {
  const f = await fixture(t),
    first = await f.boot();
  const initial = await first.api('/api/runs', { cwd: f.cwd, message: 'Fixture task' });
  assert.equal(initial.status, 201);
  const stopped = await first.api('/api/runs/' + initial.json.id + '/stop', {});
  assert.equal(stopped.status, 200);
  const journal = JSON.parse(await readFile(join(f.dataDir, 'goal-recovery.json'), 'utf8'));
  assert.deepEqual(journal.entries, {});
  await first.close();
  const second = await f.boot();
  await second.app.goalRecovery.recover();
  assert.equal(second.engine.controls.length, 0);
});

test('paused current branch is not resumed after shutdown', async (t) => {
  const f = await fixture(t),
    first = await f.boot();
  assert.equal((await first.api('/api/runs', { cwd: f.cwd, message: 'Fixture task' })).status, 201);
  const file = first.engine.controls[0].file;
  await first.close();
  await appendFile(
    file,
    JSON.stringify({
      type: 'custom',
      id: 'goal-paused',
      parentId: 'goal-state-1',
      customType: 'thread_goal_state',
      data: { ...goal, status: 'paused' },
    }) + '\n',
  );
  const second = await f.boot();
  await second.app.goalRecovery.recover();
  assert.equal(second.engine.controls.length, 0);
});

test('native cleared-goal tombstone cannot be treated as an interrupted non-goal run', async (t) => {
  const f = await fixture(t),
    first = await f.boot();
  assert.equal((await first.api('/api/runs', { cwd: f.cwd, message: 'Fixture task' })).status, 201);
  const control = first.engine.controls[0];
  await first.close();
  // The goal was created during this new run, so admission's journal goalId
  // was unknown. The selected branch tombstone still fences recovery.
  await appendFile(
    control.file,
    JSON.stringify({
      type: 'custom',
      id: 'goal-cleared',
      parentId: 'goal-state-1',
      customType: 'thread_goal_state',
      data: { status: 'idle' },
    }) + '\n',
  );
  const second = await f.boot();
  await second.app.goalRecovery.recover();
  const history = await second.api('/api/history?id=' + control.sessionId);
  assert.equal(history.status, 200);
  assert.equal(history.json.goal, null);
  assert.equal(history.json.goalEverKnown, true);
  assert.equal(second.engine.controls.length, 0);
});

test('user admission racing startup recovery cannot duplicate a native session', async (t) => {
  const f = await fixture(t),
    first = await f.boot();
  await first.api('/api/runs', { cwd: f.cwd, message: 'Fixture task' });
  const sid = first.engine.controls[0].sessionId;
  await first.close();
  const second = await f.boot();
  const user = await second.api('/api/runs', { cwd: f.cwd, sessionId: sid, message: 'Continue fixture' });
  await second.app.goalRecovery.recover();
  assert.ok([201, 409].includes(user.status), JSON.stringify(user.json));
  assert.equal(second.engine.controls.length, 1);
});

test('interrupted non-goal HTTP run resumes once with explicit native null-goal recovery', async (t) => {
  const f = await fixture(t, { withGoal: false }),
    first = await f.boot();
  assert.equal((await first.api('/api/runs', { cwd: f.cwd, message: 'Fixture task' })).status, 201);
  await first.close();
  const second = await f.boot();
  await second.app.goalRecovery.recover();
  assert.equal(second.engine.controls.length, 1);
  assert.equal(second.engine.controls[0].input.goalRecovery.goalId, null);
  await second.app.goalRecovery.recover();
  assert.equal(second.engine.controls.length, 1);
  await second.close();
  const third = await f.boot();
  await third.app.goalRecovery.recover();
  assert.equal(
    third.engine.controls.length,
    1,
    'trusted recovery survives another restart without adding a user message',
  );
  assert.equal(third.engine.controls[0].input.goalRecovery.goalId, null);
});

test('bridge-ready existing task without a newly persisted user prompt cannot resume its predecessor', async (t) => {
  const f = await fixture(t, { withGoal: false }),
    first = await f.boot();
  assert.equal((await first.api('/api/runs', { cwd: f.cwd, message: 'First fixture task' })).status, 201);
  const sid = first.engine.controls[0].sessionId;
  first.engine.controls[0].finish();
  await Promise.resolve();
  // This fake holds the existing-session prompt after onReady, leaving the
  // prior native user-1 untouched: the exact pre-persistence crash window.
  const next = await first.api('/api/runs', {
    cwd: f.cwd,
    sessionId: sid,
    message: 'New task not persisted',
  });
  assert.equal(next.status, 201);
  await first.close();
  const second = await f.boot();
  await second.app.goalRecovery.recover();
  assert.equal(second.engine.controls.length, 0);
});

for (const action of ['complete', 'stop'])
  test(`non-goal HTTP ${action} does not resume after restart`, async (t) => {
    const f = await fixture(t, { withGoal: false }),
      first = await f.boot();
    const initial = await first.api('/api/runs', { cwd: f.cwd, message: 'Fixture task' });
    assert.equal(initial.status, 201);
    if (action === 'complete') {
      first.engine.controls[0].finish();
      await Promise.resolve();
    } else assert.equal((await first.api('/api/runs/' + initial.json.id + '/stop', {})).status, 200);
    await first.close();
    const second = await f.boot();
    await second.app.goalRecovery.recover();
    assert.equal(second.engine.controls.length, 0);
  });
