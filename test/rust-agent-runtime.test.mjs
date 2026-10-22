import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { createAgentRuntime, createEventProjection } from '../lib/agent.mjs';
import { createRustAgentRuntime, createNativeOnlyTools, parseRustModelList } from '../lib/rust-agent-runtime.mjs';

test('Rust catalogue uses the executable available-model list, excluding JS-only registrations', async () => {
  assert.deepEqual(
    parseRustModelList('No models available. Use /login to log into a provider via OAuth or API key.'),
    [],
  );
  assert.throws(() => parseRustModelList('provider model context'), /Invalid Rust model catalogue/);
  const native = parseRustModelList(
    'provider       model        context  max-out  thinking  images\n' +
      'openai         supported    128K     16K      yes       yes   \n' +
      'custom         native-only  64K      8K       no        no    \n' +
      'custom         reasoning    64K      8K       yes       no    \n',
  );
  let configuredDefault = 'meta/js-only';
  const metadata = {
    agentHome: tmpdir(),
    sessionDir: join(tmpdir(), 'sessions'),
    close: async () => {},
    getModels: async () => ({
      models: [
        { id: 'meta/js-only', provider: 'meta', name: 'JS only' },
        { id: 'openai/supported', provider: 'openai', name: 'Supported', input: ['text'] },
      ],
      default: { model: configuredDefault, thinking: 'low' },
    }),
  };
  let listings = 0;
  const runtime = createRustAgentRuntime(
    { rustCliPath: join(tmpdir(), 'prime-agent') },
    {
      metadata,
      cli: { packageDir: tmpdir() },
      listNativeModels: async () => {
        listings++;
        return native;
      },
    },
  );
  try {
    const catalog = await runtime.getModels();
    assert.deepEqual(
      catalog.models.map((model) => model.id),
      ['openai/supported', 'custom/native-only', 'custom/reasoning'],
    );
    assert.deepEqual(catalog.models[0].input, ['text', 'image']);
    assert.equal(catalog.default.model, null);
    assert.equal(Object.hasOwn(catalog.models[2], 'thinkingLevels'), false);
    assert.deepEqual(catalog.configuredProviders, ['openai', 'custom']);
    await runtime.getModels();
    assert.equal(listings, 1);
    configuredDefault = 'openai/supported';
    const refreshed = await runtime.getModels({ refresh: true });
    assert.equal(refreshed.default.model, 'openai/supported');
    assert.equal(listings, 2);
  } finally {
    await runtime.close();
  }
});

test('native tool updates and ends retain names from interleaved starts', () => {
  const project = createEventProjection();
  assert.equal(
    project({ type: 'tool_execution_start', toolCallId: 'call-a', toolName: 'python_repl', args: {} })[0]
      .name,
    'python_repl',
  );
  assert.equal(
    project({ type: 'tool_execution_start', toolCallId: 'call-b', toolName: 'other', args: {} })[0].name,
    'other',
  );
  assert.equal(
    project({ type: 'tool_execution_update', toolCallId: 'call-a', partialResult: { content: [] } })[0].name,
    'python_repl',
  );
  assert.deepEqual(
    project({ type: 'tool_execution_end', toolCallId: 'call-b', result: { content: [] }, isError: true })[0],
    {
      kind: 'tool_end',
      id: 'call-b',
      name: 'other',
      result: { content: [] },
      isError: true,
    },
  );
  assert.deepEqual(
    project({
      type: 'tool_execution_end',
      toolCallId: 'call-a',
      result: { content: [{ type: 'text', text: 'marker' }] },
      isError: false,
    })[0],
    {
      kind: 'tool_end',
      id: 'call-a',
      name: 'python_repl',
      result: { content: [{ type: 'text', text: 'marker' }] },
      isError: false,
    },
  );
  assert.equal(
    project({ type: 'tool_execution_update', toolCallId: 'call-a', partialResult: { content: [] } })[0].name,
    '',
  );
});

test('Rust opt-in requires the JavaScript metadata package and rejects JS-only policy', () => {
  assert.throws(
    () =>
      createAgentRuntime({
        rustCliPath: join(tmpdir(), 'prime-agent'),
        cliPath: join(tmpdir(), 'missing-prime-agent-cli.js'),
      }),
    /JavaScript package for Studio model metadata/,
  );
  assert.throws(
    () =>
      createRustAgentRuntime(
        { rustCliPath: join(tmpdir(), 'prime-agent'), subagentPolicyFile: join(tmpdir(), 'policy.json') },
        {
          metadata: { agentHome: tmpdir(), sessionDir: join(tmpdir(), 'sessions') },
          cli: { packageDir: tmpdir() },
        },
      ),
    /cannot enforce Studio’s JavaScript subagent policy/,
  );
});

async function fixture(
  t,
  { completion = { enabled: false }, holdPrompt = false, cleanupError = false, endTurn, nativeOnly = false, realBridge = false } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), 'prime-rust-runtime-'));
  const events = [],
    commands = [],
    clients = [];
  let launch,
    toolsConfig,
    ended = 0,
    closed = 0;
  class Client {
    protocolClientId = 'test-owner';
    async connect() {
      clients.push(this);
    }
    async waitForHello() {
      return {
        supervisorPid: 123,
        serverCapabilities: [
          'client_owned_sessions',
          'event_sequence',
          'rlm_quiescence_barrier',
          'queue_message_mutation',
        ],
      };
    }
    onMessage(fn) {
      this.message = fn;
      return () => {
        this.message = undefined;
      };
    }
    onClose(fn) {
      this.disconnected = fn;
      return () => {
        this.disconnected = undefined;
      };
    }
    close() {
      this.closed = true;
      this.rejectPrompt?.(new Error('closed'));
    }
    async request(command) {
      commands.push(command);
      if (command.type === 'create')
        return {
          success: true,
          data: {
            activeSessionId: 'active-1',
            sessionId: 'session-1',
            cwd,
            sessionFile: join(cwd, 'session-1.jsonl'),
            workerPid: 124,
          },
        };
      if (command.type === 'prompt' && holdPrompt)
        return new Promise((resolve, reject) => {
          this.rejectPrompt = reject;
        });
      if (command.type === 'wait_for_headless_completion') return { success: true, data: completion };
      if (command.type === 'list')
        return {
          success: true,
          data: {
            sessions: [
              {
                sessionId: 'session-1',
                activeSessionId: 'active-1',
                cwd,
                sessionFile: join(cwd, 'session-1.jsonl'),
                rlmDepth: 0,
              },
              {
                sessionId: 'child-1',
                activeSessionId: 'child-active',
                cwd,
                sessionFile: join(cwd, 'child-1.jsonl'),
                rlmDepth: 1,
                parentSessionPath: join(cwd, 'session-1.jsonl'),
                parentSessionId: 'session-1',
                parentActiveSessionId: 'active-1',
              },
            ],
          },
        };
      return { success: true, data: {} };
    }
  }
  const runtime = createRustAgentRuntime(
    {
      rustCliPath: join(cwd, 'prime-agent'),
      env: { NODE_OPTIONS: 'legacy-hook', PRIME_AGENT_KERNEL_PYTHON: 'old-python' },
    },
    {
      metadata: {
        agentHome: cwd,
        sessionDir: join(cwd, 'sessions'),
        close: async () => {},
        getModels: async () => [],
      },
      cli: { packageDir: cwd },
      Client,
      projectEvents: () => (event) => [event],
      makeDaemon: (options) => {
        launch = options;
        return {
          socketPath: 'test',
          pid: 123,
          ensureReady: async () => ({ pid: 123 }),
          close: async () => {},
        };
      },
      makeTools: nativeOnly ? createNativeOnlyTools : realBridge ? undefined : (config) => {
        toolsConfig = config;
        return {
          ready: Promise.resolve(),
          appendSystemPrompt: (s) => s,
          bindSession() {},
          beginTurn: async () => {},
          respond() {},
          endTurn: async () => {
            ended++;
            await endTurn?.();
          },
          close: async () => {
            closed++;
            if (cleanupError) throw new Error('cleanup failed');
          },
        };
      },
    },
  );
  t.after(async () => {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const run = await runtime.start({ cwd, message: 'test', ...(realBridge ? { allowQuestions: true } : {}), onEvent: (e) => events.push(e) });
  return {
    runtime,
    run,
    events,
    commands,
    clients,
    launch,
    get toolsConfig() {
      return toolsConfig;
    },
    get closed() {
      return closed;
    },
    get ended() {
      return ended;
    },
  };
}

test('native completion keeps isolated runtime env and releases the owned worker', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run.done).status, 'completed');
  assert.equal(f.launch.env.DO_NOT_TRACK, '1');
  assert.equal(f.launch.env.PRIME_STUDIO_SESSION_PREFERENCES, '1');
  assert.equal(f.launch.env.NODE_OPTIONS, undefined);
  assert.equal(f.launch.env.PRIME_AGENT_KERNEL_PYTHON, undefined);
  assert.match(f.launch.env.PRIME_AGENT_KERNEL_VENV, /kernel-venv-rust$/);
  assert.equal(f.launch.env.PRIME_STUDIO_SUBAGENT_POLICY, undefined);
  assert.equal(f.commands.filter((c) => c.type === 'complete_owned_session').length, 1);
  assert.equal(f.commands.find((c) => c.type === 'wait_for_headless_completion').waitForRlmQuiescence, true);
  assert(Array.isArray(f.commands.find((c) => c.type === 'create').config.appendSystemPrompt));
  assert.equal(f.closed, 1);
  assert.equal(f.runtime.getLiveEndpoint().resolveOwner('session-1'), undefined);
});

test('child helper identity comes from the supervisor-owned session roster', async (t) => {
  const f = await fixture(t, { holdPrompt: true });
  const root = {
    cwd: f.runtime.agentHome,
    sessionId: 'session-1',
    sessionFile: join(f.runtime.agentHome, 'session-1.jsonl'),
  };
  const child = await f.toolsConfig.resolveContext({ root, callerSessionId: 'child-1' });
  assert.equal(child.sessionId, 'child-1');
  assert.equal(child.sessionFile, join(f.runtime.agentHome, 'child-1.jsonl'));
  assert.deepEqual(
    f.commands.find((command) => command.type === 'list'),
    { type: 'list', all: false, includeClientOwned: true },
  );
  await assert.rejects(f.toolsConfig.resolveContext({ root, callerSessionId: 'forged' }), {
    code: 'studio_session_identity',
  });
  await f.run.cancel();
});

test('unsupported Rust-only gaps fail before creating a native session', async (t) => {
  const f = await fixture(t);
  await f.run.done;
  const before = f.commands.filter((command) => command.type === 'create').length;
  await assert.rejects(
    f.runtime.start({ cwd: f.runtime.agentHome, message: 'test', computerUse: true }),
    /Computer Use is unavailable/,
  );
  await assert.rejects(
    f.runtime.start({ cwd: f.runtime.agentHome, message: 'test', files: [{ name: 'a.txt' }] }),
    /file attachments are unavailable/i,
  );
  await assert.rejects(
    f.runtime.start({ cwd: f.runtime.agentHome, message: 'test', model: 'meta/muse-spark-1.3' }),
    /Meta provider is unavailable/,
  );
  assert.equal(f.commands.filter((command) => command.type === 'create').length, before);
});

test('native autonomous gate failure and ungated budget exhaustion cannot report success', async (t) => {
  for (const completion of [
    { enabled: true, gates: { commands: ['test'] }, lastGateFailure: { exitText: 'failed' } },
    { enabled: true, gates: { commands: [] }, limits: { maxTurns: 3 }, turnsUsed: 3 },
  ]) {
    const f = await fixture(t, { completion });
    assert.equal((await f.run.done).status, 'failed');
    assert.match((await f.run.done).error, /autonomous verification/);
  }
});

test('cleanup failure still resolves done and removes the worker owner', async (t) => {
  const f = await fixture(t, { cleanupError: true });
  assert.equal((await f.run.done).status, 'failed');
  assert.equal(f.clients[0].closed, true);
  assert.equal(f.runtime.getLiveEndpoint().resolveOwner('session-1'), undefined);
});

test('cancel aborts a pending native turn and produces one stopped terminal event', async (t) => {
  const f = await fixture(t, { holdPrompt: true });
  await nextTick();
  assert.equal(f.runtime.getLiveEndpoint().resolveOwner('session-1').ownerClientId, 'test-owner');
  await f.run.cancel();
  assert.equal((await f.run.done).status, 'stopped');
  assert(f.commands.some((c) => c.type === 'abort_and_clear_queue'));
  assert.equal(f.events.filter((e) => e.kind === 'done').length, 1);
});

test('transport loss fails the run instead of hanging forever', async (t) => {
  const f = await fixture(t, { holdPrompt: true });
  await nextTick();
  f.clients[0].disconnected(new Error('connection lost'));
  assert.equal((await f.run.done).status, 'failed');
  assert.match((await f.run.done).error, /connection lost/);
});

test('cancellation aborts and revokes live commands before slow bridge cleanup', async (t) => {
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, { holdPrompt: true, endTurn: () => slow });
  await nextTick();
  const cancelling = f.run.cancel();
  const duplicate = f.run.cancel();
  assert.equal(f.commands.filter((c) => c.type === 'abort_and_clear_queue').length, 1);
  assert.equal(f.runtime.getLiveEndpoint().resolveOwner('session-1'), undefined);
  release();
  await Promise.all([cancelling, duplicate]);
  assert.equal((await f.run.done).status, 'stopped');
});


test('Rust core refuses unsupported Studio 4.4 contracts before creating a session', async (t) => {
  const f = await fixture(t, { nativeOnly: true });
  await f.run.done;
  const before = f.commands.filter((command) => command.type === 'create').length;
  for (const [input, message] of [
    [{ budget: { tokens: 1000 } }, /budgets are unavailable/],
    [{ codeContext: { enabled: true } }, /indexed code context is unavailable/],
    [{ quotaAuthorization: {} }, /quota fallback is unavailable/],
    [{ goalRecovery: { goalId: 'goal-1' } }, /recovery is not enabled/],
    [{ allowQuestions: true }, /separate Rust tools bridge/],
  ]) {
    await assert.rejects(f.runtime.start({ cwd: f.runtime.agentHome, message: 'test', ...input }), message);
  }
  assert.equal(f.commands.filter((command) => command.type === 'create').length, before);
  assert.equal(f.runtime.canRecoverGoals, false);
});


test('default Rust bridge is wired into native create and allows Studio questions', async (t) => {
  const f = await fixture(t, { realBridge: true });
  assert.equal((await f.run.done).status, 'completed');
  const prompt = f.commands.find((command) => command.type === 'create').config.appendSystemPrompt.join('\n');
  assert.match(prompt, /Studio helpers for this active turn/);
  assert.match(prompt, /question, knowledge_search/);
  assert.equal(f.commands.filter((command) => command.type === 'prompt').length, 1);
  assert.equal(f.runtime.canRecoverGoals, false);
});
