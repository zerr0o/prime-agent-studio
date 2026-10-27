import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRustAgentRuntime } from '../lib/rust-agent-runtime.mjs';

async function fixture(t, mutate = () => {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'rust-goal-recovery-'));
  const sessionFile = join(cwd, 'session-1.jsonl');
  await writeFile(sessionFile, 'saved fixture session');
  const commands = [],
    clients = [];
  const state = {
    sessionId: 'session-1',
    activeSessionId: 'active-1',
    cwd,
    sessionFile,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    sessionActions: { queuedCount: 0, steering: [], followUps: [], active: null },
    goal: {
      goalId: 'goal-1',
      active: true,
      status: 'active',
      tokensUsed: 42,
      tokenBudget: 1000,
      continuationsUsed: 7,
      timeUsedSeconds: 19,
      noProgressStreak: 1,
    },
  };
  mutate(state);
  class Client {
    protocolClientId = 'fixture-owner';
    async connect() {
      clients.push(this);
    }
    async waitForHello() {
      return {
        serverCapabilities: [
          'client_owned_sessions',
          'event_sequence',
          'rlm_quiescence_barrier',
          'queue_message_mutation',
        ],
      };
    }
    onMessage() {
      return () => {};
    }
    onClose() {
      return () => {};
    }
    close() {
      this.closed = true;
    }
    async request(command) {
      commands.push(command);
      if (command.type === 'create')
        return {
          success: true,
          data: { sessionId: 'session-1', activeSessionId: 'active-1', cwd, sessionFile, workerPid: 12 },
        };
      if (command.type === 'get_connection_state') return { success: true, data: structuredClone(state) };
      if (command.type === 'wait_for_headless_completion') return { success: true, data: { enabled: false } };
      return { success: true, data: {} };
    }
  }
  const runtime = createRustAgentRuntime(
    { rustCliPath: join(cwd, 'prime-agent') },
    {
      metadata: {
        agentHome: cwd,
        sessionDir: cwd,
        getModels: async () => ({ models: [] }),
        close: async () => {},
      },
      cli: { packageDir: cwd },
      Client,
      projectEvents: () => () => [],
      makeDaemon: () => ({
        socketPath: 'fixture',
        pid: 11,
        ensureReady: async () => ({ pid: 11 }),
        close: async () => {},
      }),
      makeTools: () => ({
        ready: Promise.resolve(),
        appendSystemPrompt: (x) => x,
        bindSession() {},
        beginTurn: async () => {},
        endTurn: async () => {},
        close: async () => {},
      }),
    },
  );
  t.after(async () => {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const input = {
    cwd,
    sessionId: 'session-1',
    sessionFile,
    message: 'DO NOT REPLAY ORIGINAL USER PROMPT',
    goalRecovery: { goalId: 'goal-1', recoveryId: 'recovery-1' },
  };
  return { runtime, state, commands, clients, input, Client };
}

test('large native history may return canonical empty state until goal adoption finishes', async (t) => {
  const f = await fixture(t);
  const request = f.Client.prototype.request;
  let reads = 0;
  f.Client.prototype.request = async function (command) {
    const result = await request.call(this, command);
    if (command.type === 'get_connection_state' && ++reads <= 2)
      result.data.goal = {
        status: 'idle',
        active: false,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        continuationsUsed: 0,
      };
    return result;
  };
  const run = await f.runtime.start(f.input);
  assert.equal((await run.done).status, 'completed');
  assert.equal(reads, 4);
  assert.equal(f.commands.filter((c) => c.type === 'prompt').length, 1);
});

test('active goal recovery sends one service custom row and preserves saved counters', async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.state.goal);
  let ready = 0;
  const run = await f.runtime.start({
    ...f.input,
    onReady: async (identity) => {
      ready++;
      assert.equal(identity.sessionId, 'session-1');
      assert.equal(
        f.commands.some((c) => c.type === 'prompt'),
        false,
      );
    },
  });
  assert.equal((await run.done).status, 'completed');
  assert.equal(f.runtime.canRecoverGoals, true);
  assert.equal(ready, 1);
  const prompts = f.commands.filter((c) => c.type === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].customMessage.role, 'custom');
  assert.equal(prompts[0].customMessage.customType, 'studio_goal_recovery');
  assert.deepEqual(prompts[0].customMessage.details, { goalId: 'goal-1', recoveryId: 'recovery-1' });
  assert.match(prompts[0].message, /reconcile any in-flight work/);
  assert.doesNotMatch(JSON.stringify(prompts[0]), /DO NOT REPLAY/);
  assert.deepEqual(f.state.goal, before);
  assert.equal(f.commands.filter((c) => c.type === 'get_connection_state').length, 2);
  assert.ok(
    f.commands.findIndex((c) => c.type === 'get_system_prompt') <
      f.commands.findIndex((c) => c.type === 'get_connection_state'),
  );
  assert.equal(
    f.commands.some((c) => /goal.*(?:resume|set|create|pause)/.test(c.type)),
    false,
  );
});

test('non-goal recovery waits for native adoption before trusting an empty cached snapshot', async (t) => {
  const f = await fixture(t, (s) => {
    s.goal = null;
  });
  const request = f.Client.prototype.request;
  f.Client.prototype.request = async function (command) {
    if (command.type === 'get_system_prompt')
      f.state.goal = { status: 'paused', active: false, goalId: 'adopted-goal' };
    return request.call(this, command);
  };
  await assert.rejects(f.runtime.start({ ...f.input, goalRecovery: { goalId: null } }), {
    code: 'goal_recovery_ineligible',
  });
  assert.equal(
    f.commands.some((c) => c.type === 'prompt'),
    false,
  );
});
test('changed, inactive, exhausted and busy snapshots reject admission and release owned workers', async (t) => {
  const cases = [
    (s) => {
      s.goal.goalId = 'changed';
    },
    (s) => {
      s.goal.status = 'paused';
    },
    (s) => {
      s.goal.active = false;
    },
    (s) => {
      s.goal.tokensUsed = s.goal.tokenBudget;
    },
    (s) => {
      s.goal.noProgressStreak = 3;
    },
    (s) => {
      s.isStreaming = true;
    },
    (s) => {
      s.sessionActions.queuedCount = 1;
    },
    (s) => {
      s.sessionId = 'other';
    },
  ];
  for (const mutate of cases) {
    const f = await fixture(t, mutate);
    await assert.rejects(f.runtime.start(f.input), { code: 'goal_recovery_ineligible' });
    assert.equal(
      f.commands.some((c) => c.type === 'prompt'),
      false,
    );
    assert.equal(f.commands.filter((c) => c.type === 'complete_owned_session').length, 1);
    assert.equal(f.clients[0].closed, true);
  }
});
test('goal changes during durable onReady tracking are rechecked immediately before prompt', async (t) => {
  const f = await fixture(t);
  const run = await f.runtime.start({
    ...f.input,
    onReady: async () => {
      f.state.goal.status = 'paused';
    },
  });
  assert.equal((await run.done).status, 'failed');
  assert.equal(
    f.commands.some((c) => c.type === 'prompt'),
    false,
  );
  assert.equal(f.clients[0].closed, true);
});
test('onReady journal failure releases worker before admission', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.runtime.start({
      ...f.input,
      onReady: async () => {
        throw new Error('journal unavailable');
      },
    }),
    /journal unavailable/,
  );
  assert.equal(
    f.commands.some((c) => c.type === 'prompt'),
    false,
  );
  assert.equal(f.commands.filter((c) => c.type === 'complete_owned_session').length, 1);
  assert.equal(f.clients[0].closed, true);
});

test('explicit null-goal interrupted run recovery sends one service row without replaying old user text', async (t) => {
  const f = await fixture(t, (state) => {
    state.goal = null;
  });
  const run = await f.runtime.start({
    ...f.input,
    goalRecovery: { goalId: null, recoveryId: 'run-recovery-1' },
  });
  assert.equal((await run.done).status, 'completed');
  const prompts = f.commands.filter((c) => c.type === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].customMessage.role, 'custom');
  assert.equal(prompts[0].customMessage.customType, 'studio_run_recovery');
  assert.deepEqual(prompts[0].customMessage.details, { goalId: null, recoveryId: 'run-recovery-1' });
  assert.match(prompts[0].message, /interrupted work from saved session state/);
  assert.doesNotMatch(JSON.stringify(prompts[0]), /existing active goal|DO NOT REPLAY/);
  assert.equal(f.commands.filter((c) => c.type === 'get_connection_state').length, 2);
});

test('non-goal recovery rejects a new or paused goal and an omitted recovery discriminator', async (t) => {
  for (const status of ['active', 'paused', 'error']) {
    const f = await fixture(t, (state) => {
      state.goal.status = status;
    });
    await assert.rejects(f.runtime.start({ ...f.input, goalRecovery: { goalId: null } }), {
      code: 'goal_recovery_ineligible',
    });
    assert.equal(
      f.commands.some((c) => c.type === 'prompt'),
      false,
    );
  }
  const f = await fixture(t, (state) => {
    state.goal = null;
  });
  await assert.rejects(
    f.runtime.start({ ...f.input, goalRecovery: {} }),
    /exact saved session and goal identity/,
  );
});

test('a goal appearing during non-goal onReady tracking blocks prompt admission', async (t) => {
  const f = await fixture(t, (state) => {
    state.goal = null;
  });
  const run = await f.runtime.start({
    ...f.input,
    goalRecovery: { goalId: null },
    onReady: async () => {
      f.state.goal = { status: 'paused', goalId: 'new-goal' };
    },
  });
  assert.equal((await run.done).status, 'failed');
  assert.equal(
    f.commands.some((c) => c.type === 'prompt'),
    false,
  );
});

test('non-goal recovery accepts only Rust canonical empty state, not a goal-bearing idle object', async (t) => {
  const empty = { status: 'idle', active: false, tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 };
  const f = await fixture(t, (state) => {
    state.goal = { ...empty };
  });
  const run = await f.runtime.start({ ...f.input, goalRecovery: { goalId: null } });
  assert.equal((await run.done).status, 'completed');
  assert.equal(f.commands.filter((c) => c.type === 'prompt').length, 1);
  for (const patch of [
    { goalId: 'old-goal' },
    { objective: 'Existing objective' },
    { tokensUsed: 1 },
    { tokenBudget: 100 },
    { noProgressStreak: 0 },
  ]) {
    const blocked = await fixture(t, (state) => {
      state.goal = { ...empty, ...patch };
    });
    await assert.rejects(blocked.runtime.start({ ...blocked.input, goalRecovery: { goalId: null } }), {
      code: 'goal_recovery_ineligible',
    });
    assert.equal(
      blocked.commands.some((c) => c.type === 'prompt'),
      false,
    );
  }
});
