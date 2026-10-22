import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { createSessionGoals, validateGoalControl } from '../lib/session-goals.mjs';
import { controlSavedGoal } from '../lib/saved-goal-client.mjs';
import { createLiveSessionClient } from '../lib/live-session-client.mjs';

const cwd = resolve('test/goal-controls-project');
const sessionFile = resolve('test/goal-controls-session.jsonl');
const activeGoal = {
  goalId: 'goal-1',
  objective: 'Finish this task',
  status: 'active',
  active: true,
  tokensUsed: 12,
  timeUsedSeconds: 3,
  continuationsUsed: 1,
};
const pausedGoal = { ...activeGoal, status: 'paused', active: false };
const body = {
  cwd,
  goalId: activeGoal.goalId,
  expectedObjective: activeGoal.objective,
};

function serviceFixture(overrides = {}) {
  const calls = [];
  const run = { sessionId: 'session-1', status: 'running' };
  const service = createSessionGoals({
    store: {
      history: async (id) => ({ id, cwd, file: sessionFile, goal: activeGoal }),
    },
    getRuns: () => [],
    getClient: () => null,
    getSavedCapabilities: async () => ({ editable: true, controllable: true }),
    controlSavedGoal: async (input) => {
      calls.push(['saved', input]);
      return input.action === 'clear' ? null : pausedGoal;
    },
    stopRun: async (value) => calls.push(['stopRun', value]),
    ...overrides,
  });
  return { service, calls, run };
}

test('goal control validates the CAS body and rejects extra fields', () => {
  assert.deepEqual(validateGoalControl(body), body);
  for (const invalid of [
    null,
    { ...body, objective: 'replacement' },
    { ...body, goalId: '' },
    { ...body, cwd: 'relative/project' },
    { ...body, expectedObjective: ' ' },
    { ...body, expectedObjective: 'x\0y' },
    { ...body, expectedObjective: 'x'.repeat(4001) },
  ])
    assert.throws(() => validateGoalControl(invalid), { status: 400 });
});

test('idle Stop pauses and Clear removes only the canonical session goal', async () => {
  const f = serviceFixture();
  assert.equal((await f.service.get('session-1')).controllable, true);
  const stopped = await f.service.control('session-1', 'stop', body);
  assert.equal(stopped.goal.status, 'paused');
  assert.deepEqual(f.calls[0], [
    'saved',
    { ...body, action: 'pause', sessionId: 'session-1', sessionFile, cwd },
  ]);
  const cleared = await f.service.control('session-1', 'clear', body);
  assert.deepEqual(cleared, {
    goal: null,
    editable: false,
    controllable: false,
  });
  assert.deepEqual(f.calls[1], [
    'saved',
    { ...body, action: 'clear', sessionId: 'session-1', sessionFile, cwd },
  ]);
  assert.equal(
    f.calls.some(([name]) => name === 'stopRun'),
    false,
  );
  await assert.rejects(
    f.service.control('session-1', 'stop', {
      ...body,
      cwd: resolve('elsewhere'),
    }),
    { status: 409 },
  );
  assert.equal(f.calls.length, 2);
});

test('live control stops a run only after native confirmation; stale CAS never stops it', async () => {
  const f = serviceFixture({
    getRuns: () => [{ sessionId: 'session-1', status: 'running' }],
    getClient: () => ({
      getGoal: async () => ({
        goal: activeGoal,
        editable: true,
        controllable: true,
      }),
      controlGoal: async (id, directory, command) => {
        f.calls.push(['native', id, directory, command]);
        return command.action === 'clear' ? null : pausedGoal;
      },
      close: () => f.calls.push(['close']),
    }),
  });
  assert.equal((await f.service.get('session-1')).controllable, true);
  f.calls.length = 0;
  assert.equal((await f.service.control('session-1', 'stop', body)).goal.status, 'paused');
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ['native', 'close', 'stopRun'],
  );
  assert.deepEqual(f.calls[0], ['native', 'session-1', cwd, { ...body, action: 'pause' }]);
  f.calls.length = 0;
  assert.equal((await f.service.control('session-1', 'clear', body)).goal, null);
  assert.deepEqual(
    f.calls.map(([name]) => name),
    ['native', 'close', 'stopRun'],
  );
  assert.equal(f.calls[0][3].action, 'clear');

  const stale = serviceFixture({
    getRuns: () => [{ sessionId: 'session-1', status: 'running' }],
    getClient: () => ({
      controlGoal: async () => {
        throw Object.assign(new Error('stale'), { status: 409 });
      },
      close: () => stale.calls.push(['close']),
    }),
  });
  await assert.rejects(stale.service.control('session-1', 'stop', body), {
    status: 409,
  });
  assert.deepEqual(
    stale.calls.map(([name]) => name),
    ['close'],
  );
  assert.equal(stale.service.busy('session-1'), false);
});

test('unconfirmed native result, concurrent mutation and admission block control safely', async () => {
  for (const result of [activeGoal, { ...pausedGoal, objective: 'Changed elsewhere' }, undefined]) {
    const f = serviceFixture({
      getRuns: () => [{ sessionId: 'session-1', status: 'running' }],
      getClient: () => ({ controlGoal: async () => result, close() {} }),
    });
    await assert.rejects(f.service.control('session-1', 'stop', body), {
      status: 503,
    });
    assert.equal(f.calls.length, 0, 'unconfirmed mutation must not stop a run');
  }
  let release, entered;
  const started = new Promise((resolveStarted) => {
    entered = resolveStarted;
  });
  const f = serviceFixture({
    controlSavedGoal: async () => {
      entered();
      return new Promise((resolveResult) => {
        release = resolveResult;
      });
    },
  });
  const first = f.service.control('session-1', 'stop', body);
  await started;
  assert.equal(f.service.busy('session-1'), true);
  await assert.rejects(f.service.control('session-1', 'clear', body), {
    status: 409,
  });
  release(pausedGoal);
  await first;
  assert.equal(f.service.busy('session-1'), false);
  await assert.rejects(
    serviceFixture({ isAdmitting: () => true }).service.control('session-1', 'stop', body),
    { status: 409 },
  );
  await assert.rejects(
    serviceFixture({
      getRuns: () => [{ sessionId: 'session-1', status: 'stopping' }],
    }).service.control('session-1', 'stop', body),
    { status: 409 },
  );
});

const options = {
  packageDir: resolve('test/native-package'),
  socketPath: resolve('test/native.sock'),
  supervisorPid: 4812,
  agentDir: resolve('test/agent'),
  sessionDir: resolve('test/sessions'),
};
const savedInput = { ...body, sessionId: 'session-1', sessionFile };
const activeSessionId = 'owned-1';
const identity = { sessionId: 'session-1', activeSessionId, cwd, sessionFile };

function savedFixture({ capabilities = ['client_owned_sessions', 'goal_lifecycle_control'], reply } = {}) {
  const commands = [];
  const instances = [];
  class Client {
    requestId = 0;
    closed = false;
    constructor(socket) {
      assert.equal(socket, options.socketPath);
      instances.push(this);
    }
    async connect() {}
    async waitForHello() {
      return {
        supervisorPid: options.supervisorPid,
        socketPath: options.socketPath,
      };
    }
    supportsServerCapability(capability) {
      return capabilities.includes(capability);
    }
    async request(command, timeout, requestOptions) {
      assert.equal(requestOptions.recoverable, false);
      assert.ok(timeout >= 1000);
      commands.push(command);
      if (reply) return reply(command, commands);
      if (command.type === 'create') return { success: true, data: identity };
      if (command.type === 'get_connection_state')
        return {
          success: true,
          data: {
            ...identity,
            goal: commands.some((item) => item.type === 'control_goal') ? pausedGoal : activeGoal,
          },
        };
      if (command.type === 'control_goal') return { success: true, data: pausedGoal };
      if (command.type === 'complete_owned_session') return { success: true };
      throw new Error(`Unexpected command ${command.type}`);
    }
    close() {
      this.closed = true;
    }
  }
  return {
    dependencies: { loadClient: async () => Client },
    commands,
    instances,
  };
}

test('saved Stop uses a short-lived owned worker with readback, cleanup and no model turn', async () => {
  const f = savedFixture();
  assert.deepEqual(
    await controlSavedGoal(options, { ...savedInput, action: 'pause' }, f.dependencies),
    pausedGoal,
  );
  assert.deepEqual(
    f.commands.map(({ type }) => type),
    ['create', 'get_connection_state', 'control_goal', 'get_connection_state', 'complete_owned_session'],
  );
  assert.equal(f.commands[0].lifecycle, 'client_owned');
  assert.equal(f.commands[0].sessionPath, sessionFile);
  for (const key of [
    'noTools',
    'noBuiltinTools',
    'noExtensions',
    'noSkills',
    'noPromptTemplates',
    'noThemes',
    'noContextFiles',
  ])
    assert.equal(f.commands[0].config[key], true);
  assert.equal('prompt' in f.commands[0], false);
  assert.deepEqual(f.commands[2], {
    type: 'control_goal',
    activeSessionId,
    goalId: body.goalId,
    expectedObjective: body.expectedObjective,
    action: 'pause',
  });
  assert.deepEqual(f.commands.at(-1), {
    type: 'complete_owned_session',
    activeSessionId,
  });
  assert.equal(f.instances[0].closed, true);
  assert.equal(
    f.commands.some(({ type }) => ['send', 'prompt', 'edit_goal_objective'].includes(type)),
    false,
  );
});

test('saved Clear accepts null or idle readback and returns null after cleanup', async () => {
  for (const readback of [null, { status: 'idle', objective: null }]) {
    const f = savedFixture({
      reply: (command, commands) => {
        if (command.type === 'create') return { success: true, data: identity };
        if (command.type === 'get_connection_state')
          return {
            success: true,
            data: {
              ...identity,
              goal: commands.some(({ type }) => type === 'control_goal') ? readback : activeGoal,
            },
          };
        if (command.type === 'control_goal') return { success: true, data: null };
        if (command.type === 'complete_owned_session') return { success: true };
        throw new Error(`Unexpected command ${command.type}`);
      },
    });
    assert.equal(await controlSavedGoal(options, { ...savedInput, action: 'clear' }, f.dependencies), null);
    assert.equal(f.commands[2].action, 'clear');
    assert.equal(f.commands.at(-1).type, 'complete_owned_session');
    assert.equal(f.instances[0].closed, true);
  }
});

test('saved capability, session activity, stale CAS and uncertain delivery never succeed', async () => {
  const unsupported = savedFixture({ capabilities: ['client_owned_sessions'] });
  await assert.rejects(
    controlSavedGoal(options, { ...savedInput, action: 'pause' }, unsupported.dependencies),
    { status: 503, code: 'native_unavailable' },
  );
  assert.deepEqual(unsupported.commands, []);
  for (const variant of ['active', 'stale', 'uncertain']) {
    const f = savedFixture({
      reply: (command) => {
        if (command.type === 'create') return { success: true, data: identity };
        if (command.type === 'get_connection_state')
          return {
            success: true,
            data: {
              ...identity,
              goal: activeGoal,
              isStreaming: variant === 'active',
            },
          };
        if (command.type === 'control_goal') {
          if (variant === 'stale') return { success: false, error: 'Goal changed' };
          if (variant === 'uncertain') throw new Error('Reply lost');
        }
        if (command.type === 'complete_owned_session') return { success: true };
        throw new Error(`Unexpected command ${command.type}`);
      },
    });
    await assert.rejects(
      controlSavedGoal(options, { ...savedInput, action: 'pause' }, f.dependencies),
      variant === 'active'
        ? { status: 409, code: 'goal_conflict' }
        : variant === 'stale'
          ? { status: 409, code: 'native_rejected' }
          : { status: 503, code: 'delivery_uncertain' },
    );
    assert.equal(f.commands.at(-1).type, 'complete_owned_session');
    assert.equal(f.instances[0].closed, true);
    assert.equal(
      f.commands.filter(({ type }) => type === 'control_goal').length,
      variant === 'active' ? 0 : 1,
    );
  }
});

test('saved control requires confirming readback even after a successful native reply', async () => {
  const f = savedFixture({
    reply: (command) => {
      if (command.type === 'create') return { success: true, data: identity };
      if (command.type === 'get_connection_state')
        return { success: true, data: { ...identity, goal: activeGoal } };
      if (command.type === 'control_goal') return { success: true, data: pausedGoal };
      if (command.type === 'complete_owned_session') return { success: true };
      throw new Error(`Unexpected command ${command.type}`);
    },
  });
  await assert.rejects(controlSavedGoal(options, { ...savedInput, action: 'pause' }, f.dependencies), {
    status: 503,
    code: 'delivery_uncertain',
  });
  assert.deepEqual(
    f.commands.map(({ type }) => type),
    ['create', 'get_connection_state', 'control_goal', 'get_connection_state', 'complete_owned_session'],
  );
  assert.equal(f.instances[0].closed, true);
});

test('live control checks capability, targets its verified owner and keeps CAS values', async () => {
  const commands = [];
  class Client {
    requestId = 0;
    closed = false;
    async connect() {}
    async waitForHello() {
      return { supervisorPid: 17, socketPath: options.socketPath };
    }
    supportsServerCapability(name) {
      return name === 'goal_lifecycle_control';
    }
    async request(command) {
      commands.push(command);
      if (command.type === 'get_state')
        return {
          success: true,
          data: {
            sessionId: 'session-1',
            activeSessionId,
            cwd,
            sessionFile,
          },
        };
      if (command.type === 'get_session_header')
        return {
          success: true,
          data: {
            header: { type: 'session', id: 'session-1', cwd },
          },
        };
      if (command.type === 'get_connection_state') return { success: true, data: { goal: activeGoal } };
      if (command.type === 'control_goal') return { success: true, data: pausedGoal };
      throw new Error(`Unexpected command ${command.type}`);
    }
    close() {
      this.closed = true;
    }
  }
  const live = createLiveSessionClient(
    {
      packageDir: options.packageDir,
      socketPath: options.socketPath,
      supervisorPid: 17,
      resolveOwner: async () => ({ ...identity, ownerClientId: 'owner-1' }),
    },
    { loadClient: async () => Client },
  );
  assert.equal((await live.getGoal('session-1', cwd)).controllable, true);
  assert.deepEqual(await live.controlGoal('session-1', cwd, { ...body, action: 'pause' }), pausedGoal);
  const command = commands.find(({ type }) => type === 'control_goal');
  assert.deepEqual(command, {
    type: 'control_goal',
    activeSessionId,
    goalId: body.goalId,
    expectedObjective: body.expectedObjective,
    action: 'pause',
  });
  assert.equal(
    commands.some(({ type }) => type === 'prompt'),
    false,
  );
  assert.throws(() => live.controlGoal('session-1', cwd, { ...body, action: 'delete' }), { status: 400 });
  class Unsupported extends Client {
    supportsServerCapability() {
      return false;
    }
  }
  const blocked = createLiveSessionClient(
    {
      packageDir: options.packageDir,
      socketPath: options.socketPath,
      supervisorPid: 17,
      resolveOwner: async () => ({ ...identity, ownerClientId: 'owner-1' }),
    },
    { loadClient: async () => Unsupported },
  );
  const controlsBefore = commands.filter(({ type }) => type === 'control_goal').length;
  await assert.rejects(blocked.controlGoal('session-1', cwd, { ...body, action: 'pause' }), {
    status: 503,
    code: 'goal_control_unsupported',
  });
  assert.equal(commands.filter(({ type }) => type === 'control_goal').length, controlsBefore);
});
