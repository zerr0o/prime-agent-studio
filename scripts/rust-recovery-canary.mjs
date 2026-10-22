// Isolated real-daemon check of asynchronous saved-goal adoption. No credentials or model call.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RustDaemonClient } from '../lib/rust-daemon-client.mjs';
import { createRustAgentRuntime } from '../lib/rust-agent-runtime.mjs';
import { terminateProcessTree } from '../lib/agent.mjs';

const binary = process.argv[2];
assert(isAbsolute(binary || ''), 'Pass an absolute official Rust executable path');
const root = await mkdtemp(join(tmpdir(), 'prime-rust-recovery-'));
const agentDir = join(root, 'agent'),
  cwd = join(root, 'project'),
  sessionDir = join(agentDir, 'sessions');
const home = join(root, 'home'),
  appData = join(root, 'appdata'),
  temp = join(root, 'temp');
await Promise.all([
  mkdir(sessionDir, { recursive: true }),
  mkdir(cwd),
  mkdir(home),
  mkdir(appData),
  mkdir(temp),
]);
const env = {
  PATH: process.env.PATH || '',
  DO_NOT_TRACK: '1',
  PRIME_AGENT_CODING_AGENT_DIR: agentDir,
  PRIME_AGENT_SESSION_DIR: sessionDir,
  PI_PACKAGE_DIR: dirname(binary),
  HOME: home,
  USERPROFILE: home,
  APPDATA: appData,
  LOCALAPPDATA: appData,
  TEMP: temp,
  TMP: temp,
};
for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'])
  if (process.env[key]) env[key] = process.env[key];
const socketPath =
  process.platform === 'win32' ? `\\\\.\\pipe\\prime-recovery-${randomUUID()}` : join(root, 'seed.sock');
const child = spawn(binary, ['--mode', 'daemon', '--daemon-socket', socketPath, '--offline'], {
  cwd: root,
  env,
  windowsHide: true,
  detached: process.platform !== 'win32',
  stdio: 'ignore',
});
const exited = new Promise((resolve) => {
  child.once('exit', resolve);
  child.once('error', resolve);
});
let client, runtime, owned;
const rpc = async (cmd) => {
  const r = await client.request(cmd, 65000);
  assert(r.success, r.error);
  return r.data;
};
try {
  for (let i = 0; i < 100; i++) {
    client = new RustDaemonClient(socketPath, { expectedIdentity: { supervisorPid: child.pid } });
    try {
      await client.connect(200);
      await client.waitForHello(1000);
      break;
    } catch {
      client.close();
      client = null;
      await delay(100);
    }
  }
  assert(client, 'Isolated daemon did not start');
  const hello = await client.waitForHello();
  const first = await rpc({
    type: 'create',
    lifecycle: 'client_owned',
    telemetryDisabled: true,
    config: {
      cwd,
      agentDir,
      sessionDir,
      noTools: true,
      noBuiltinTools: true,
      noSkills: true,
      noContextFiles: true,
    },
  });
  owned = first.activeSessionId;
  await rpc({ type: 'complete_owned_session', activeSessionId: owned });
  owned = null;
  const rows = (await readFile(first.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
  let parent = rows.at(-1)?.id ?? null;
  for (let i = 0; i < 4000; i++) {
    const id = randomUUID();
    rows.push({
      type: 'message',
      id,
      parentId: parent,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'Synthetic fixture record ' + i }] },
    });
    parent = id;
  }
  const goal = {
    goalId: 'fixture-goal',
    objective: 'Isolated fixture; do not perform external work.',
    active: true,
    status: 'active',
    tokensUsed: 856164,
    timeUsedSeconds: 1117,
    continuationsUsed: 115,
    noProgressStreak: 0,
  };
  rows.push({
    type: 'custom',
    id: randomUUID(),
    parentId: parent,
    timestamp: new Date().toISOString(),
    customType: 'thread_goal_state',
    data: goal,
  });
  await writeFile(first.sessionFile, rows.map(JSON.stringify).join('\n') + '\n');
  await rpc({ type: 'shutdown', force: true });
  client.close();
  client = null;
  await Promise.race([exited, delay(2000)]);
  const reads = [],
    prompts = [];
  class ProbeClient extends RustDaemonClient {
    async request(command, timeout) {
      if (command.type === 'prompt') {
        prompts.push(command);
        // Stop at the real prompt boundary. The actual restored snapshot has
        // already passed the adapter's two checks; never contact a provider.
        return { success: false, error: 'Fixture stops before inference' };
      }
      const result = await super.request(command, timeout);
      if (command.type === 'get_connection_state')
        reads.push({
          status: result.data?.goal?.status,
          goalId: result.data?.goal?.goalId,
          tokensUsed: result.data?.goal?.tokensUsed,
        });
      return result;
    }
  }
  runtime = createRustAgentRuntime(
    { rustCliPath: binary, env, kernelRoot: cwd },
    {
      metadata: {
        agentHome: agentDir,
        sessionDir,
        getModels: async () => ({ models: [] }),
        close: async () => {},
      },
      cli: { packageDir: dirname(binary) },
      Client: ProbeClient,
      projectEvents: () => () => [],
      terminateProcess: terminateProcessTree,
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
  const handle = await runtime.start({
    cwd,
    sessionId: first.sessionId,
    sessionFile: first.sessionFile,
    message: 'Never replay this user prompt',
    goalRecovery: { goalId: goal.goalId, recoveryId: 'fixture-recovery' },
  });
  const result = await handle.done;
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'Fixture stops before inference');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].customMessage.customType, 'studio_goal_recovery');
  assert(reads.some((r) => r.goalId === goal.goalId && r.tokensUsed === goal.tokensUsed));
  const persisted = (await readFile(first.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
  const after = persisted.findLast((r) => r.type === 'custom' && r.customType === 'thread_goal_state').data;
  assert.deepEqual(after, goal);
  console.log(
    JSON.stringify({
      passed: true,
      platform: process.platform,
      runtimeBuild: hello.runtimeBuild,
      historyRows: 4000,
      reads,
      promptCount: prompts.length,
      modelCalls: 0,
      countersPreserved: true,
    }),
  );
} finally {
  await runtime?.close().catch(() => {});
  if (owned)
    await client?.request({ type: 'complete_owned_session', activeSessionId: owned }, 1000).catch(() => {});
  await client?.request({ type: 'shutdown', force: true }, 1000).catch(() => {});
  client?.close();
  if (child.exitCode == null) await terminateProcessTree(child.pid).catch(() => {});
  await exited;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
