import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { editSavedGoal, savedGoalCapabilities } from '../lib/saved-goal-client.mjs';

const base = process.cwd();
const input = {
  sessionId: 'session-1',
  sessionFile: join(base, 'sessions', 'session-1.jsonl'),
  cwd: join(base, 'project'),
  goalId: 'goal-1',
  expectedObjective: 'Original objective',
  objective: 'Revised objective',
};
const options = {
  packageDir: join(base, 'native-package'),
  socketPath: join(base, 'daemon.sock'),
  supervisorPid: 4812,
  agentDir: join(base, 'agent'),
  sessionDir: join(base, 'sessions'),
};
const activeSessionId = 'active-1';
const identity = {
  sessionId: input.sessionId,
  activeSessionId,
  sessionFile: input.sessionFile,
  cwd: input.cwd,
};
const initialGoal = { goalId: input.goalId, objective: input.expectedObjective, status: 'paused' };
const updatedGoal = { ...initialGoal, objective: input.objective, updatedAt: '2026-10-13T00:00:00Z' };

function fixture({ caps = ['client_owned_sessions', 'goal_objective_edit'], hello = {}, reply } = {}) {
  const commands = [];
  const instances = [];
  class Client {
    requestId = 0;
    closed = false;
    constructor(socketPath) {
      assert.equal(socketPath, options.socketPath);
      instances.push(this);
    }
    async connect() {}
    async waitForHello() {
      return { supervisorPid: options.supervisorPid, socketPath: options.socketPath, ...hello };
    }
    supportsServerCapability(capability) {
      return caps.includes(capability);
    }
    async request(command, timeout, requestOptions) {
      assert.equal(requestOptions.recoverable, false);
      assert.ok(timeout >= 1000);
      commands.push(command);
      if (reply) return reply(command, commands.length);
      if (command.type === 'create') return { success: true, data: identity };
      if (command.type === 'get_connection_state')
        return {
          success: true,
          data: {
            ...identity,
            goal: commands.some((item) => item.type === 'edit_goal_objective') ? updatedGoal : initialGoal,
          },
        };
      if (command.type === 'edit_goal_objective') return { success: true, data: updatedGoal };
      if (command.type === 'complete_owned_session') return { success: true };
      throw new Error(`Unexpected command ${command.type}`);
    }
    close() {
      this.closed = true;
    }
  }
  return { dependencies: { loadClient: async () => Client }, commands, instances };
}

test('idle capabilities come from the supervisor hello without creating a worker', async () => {
  const supported = fixture({
    caps: ['client_owned_sessions', 'goal_objective_edit', 'goal_lifecycle_control'],
  });
  assert.deepEqual(await savedGoalCapabilities(options, supported.dependencies), {
    editable: true,
    controllable: true,
  });
  assert.deepEqual(supported.commands, []);
  assert.equal(supported.instances[0].closed, true);
  const resume = fixture({ caps: ['client_owned_sessions', 'goal_error_resume'] });
  assert.deepEqual(await savedGoalCapabilities(options, resume.dependencies), {
    editable: false,
    controllable: false,
    resumable: true,
  });
  assert.deepEqual(resume.commands, []);
  const oldEngine = fixture({ caps: ['client_owned_sessions'] });
  assert.deepEqual(await savedGoalCapabilities(options, oldEngine.dependencies), {
    editable: false,
    controllable: false,
  });
  assert.deepEqual(oldEngine.commands, []);
  const foreign = fixture({ hello: { supervisorPid: 1 } });
  assert.deepEqual(await savedGoalCapabilities(options, foreign.dependencies), {
    editable: false,
    controllable: false,
  });
});

test('edits through a guarded client-owned worker and confirms native readback', async () => {
  const mock = fixture();
  const goal = await editSavedGoal(options, input, mock.dependencies);
  assert.deepEqual(goal, updatedGoal);
  assert.deepEqual(
    mock.commands.map((command) => command.type),
    [
      'create',
      'get_connection_state',
      'edit_goal_objective',
      'get_connection_state',
      'complete_owned_session',
    ],
  );
  const [create, , edit, , complete] = mock.commands;
  assert.equal(create.sessionPath, input.sessionFile);
  assert.equal(create.lifecycle, 'client_owned');
  assert.deepEqual(
    Object.fromEntries(['cwd', 'agentDir', 'sessionDir'].map((key) => [key, create.config[key]])),
    { cwd: input.cwd, agentDir: options.agentDir, sessionDir: options.sessionDir },
  );
  for (const key of [
    'noTools',
    'noBuiltinTools',
    'noExtensions',
    'noSkills',
    'noPromptTemplates',
    'noThemes',
    'noContextFiles',
  ])
    assert.equal(create.config[key], true);
  assert.deepEqual(edit, {
    type: 'edit_goal_objective',
    activeSessionId,
    goalId: input.goalId,
    expectedObjective: input.expectedObjective,
    objective: input.objective,
  });
  assert.deepEqual(complete, { type: 'complete_owned_session', activeSessionId });
  assert.equal(mock.instances[0].closed, true);
});

test('rejects incompatible or foreign supervisor before opening any worker', async () => {
  for (const setup of [
    { caps: ['client_owned_sessions'] },
    { caps: ['goal_objective_edit'] },
    { hello: { supervisorPid: 1 } },
    { hello: { socketPath: join(base, 'foreign.sock') } },
  ]) {
    const mock = fixture(setup);
    await assert.rejects(editSavedGoal(options, input, mock.dependencies), {
      status: 503,
      code: 'native_unavailable',
    });
    assert.deepEqual(mock.commands, []);
    assert.equal(mock.instances[0].closed, true);
  }
});

test('native create conflict never completes or detaches another owner worker', async () => {
  const mock = fixture({ reply: () => ({ success: false, error: 'SessionAlreadyActiveError' }) });
  await assert.rejects(editSavedGoal(options, input, mock.dependencies), {
    status: 409,
    code: 'native_rejected',
  });
  assert.deepEqual(
    mock.commands.map((command) => command.type),
    ['create'],
  );
  assert.equal(mock.instances[0].closed, true);
});

test('idle prewarm snapshot may have no goal; native CAS and readback confirm the edit', async () => {
  let reads = 0;
  const mock = fixture({
    reply: (command) => {
      if (command.type === 'create') return { success: true, data: identity };
      if (command.type === 'get_connection_state')
        return {
          success: true,
          data: { ...identity, status: 'idle', goal: reads++ === 0 ? null : updatedGoal },
        };
      if (command.type === 'edit_goal_objective') return { success: true, data: updatedGoal };
      if (command.type === 'complete_owned_session') return { success: true };
      throw new Error(`Unexpected command ${command.type}`);
    },
  });
  assert.deepEqual(await editSavedGoal(options, input, mock.dependencies), updatedGoal);
  assert.equal(reads, 2);
  assert.deepEqual(
    mock.commands.map((command) => command.type),
    [
      'create',
      'get_connection_state',
      'edit_goal_objective',
      'get_connection_state',
      'complete_owned_session',
    ],
  );
  assert.deepEqual(mock.commands[2], {
    type: 'edit_goal_objective',
    activeSessionId,
    goalId: input.goalId,
    expectedObjective: input.expectedObjective,
    objective: input.objective,
  });
});

test('session identity or activity prevents edit and completes only the created worker', async () => {
  for (const before of [
    { ...identity, cwd: join(base, 'other'), goal: initialGoal },
    { ...identity, goal: initialGoal, isStreaming: true },
    { ...identity, goal: initialGoal, sessionActions: { active: true } },
    { ...identity, goal: initialGoal, sessionActions: { queuedCount: 1 } },
  ]) {
    const mock = fixture({
      reply: (command) => {
        if (command.type === 'create') return { success: true, data: identity };
        if (command.type === 'get_connection_state') return { success: true, data: before };
        if (command.type === 'complete_owned_session') return { success: true };
        throw new Error('Edit must not be sent');
      },
    });
    await assert.rejects(editSavedGoal(options, input, mock.dependencies), {
      status: 409,
      code: 'goal_conflict',
    });
    assert.deepEqual(
      mock.commands.map((command) => command.type),
      ['create', 'get_connection_state', 'complete_owned_session'],
    );
  }
});

test('stale objective reaches authoritative native CAS and cannot succeed optimistically', async () => {
  const mock = fixture({
    reply: (command) => {
      if (command.type === 'create') return { success: true, data: identity };
      if (command.type === 'get_connection_state')
        return {
          success: true,
          data: { ...identity, goal: { ...initialGoal, objective: 'Changed elsewhere' } },
        };
      if (command.type === 'edit_goal_objective') return { success: false, error: 'Goal objective changed' };
      if (command.type === 'complete_owned_session') return { success: true };
      throw new Error(`Unexpected command ${command.type}`);
    },
  });
  await assert.rejects(editSavedGoal(options, input, mock.dependencies), {
    status: 409,
    code: 'native_rejected',
  });
  assert.deepEqual(
    mock.commands.map((command) => command.type),
    ['create', 'get_connection_state', 'edit_goal_objective', 'complete_owned_session'],
  );
  assert.equal(mock.commands[2].expectedObjective, input.expectedObjective);
});

test('lost edit response is uncertain, never retried, and owned worker is completed', async () => {
  const mock = fixture({
    reply: (command) => {
      if (command.type === 'create') return { success: true, data: identity };
      if (command.type === 'get_connection_state')
        return { success: true, data: { ...identity, goal: initialGoal } };
      if (command.type === 'edit_goal_objective') throw new Error('socket lost after write');
      if (command.type === 'complete_owned_session') return { success: true };
    },
  });
  await assert.rejects(editSavedGoal(options, input, mock.dependencies), {
    status: 503,
    code: 'delivery_uncertain',
  });
  assert.deepEqual(
    mock.commands.map((command) => command.type),
    ['create', 'get_connection_state', 'edit_goal_objective', 'complete_owned_session'],
  );
});

test('unconfirmed readback is uncertain even when edit response succeeded', async () => {
  const mock = fixture({
    reply: (command) => {
      if (command.type === 'create') return { success: true, data: identity };
      if (command.type === 'get_connection_state')
        return { success: true, data: { ...identity, goal: initialGoal } };
      if (command.type === 'edit_goal_objective') return { success: true, data: updatedGoal };
      if (command.type === 'complete_owned_session') return { success: true };
    },
  });
  await assert.rejects(editSavedGoal(options, input, mock.dependencies), {
    status: 503,
    code: 'delivery_uncertain',
  });
  assert.equal(mock.commands.at(-1).type, 'complete_owned_session');
});
