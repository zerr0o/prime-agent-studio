import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RustDaemonClient } from '../lib/rust-daemon-client.mjs';
import { terminateProcessTree } from '../lib/agent.mjs';

const binary = process.argv[2];
assert(isAbsolute(binary || ''), 'Pass an absolute Rust executable path');
const root = await mkdtemp(join(tmpdir(), 'prime-rust-wire-'));
const agentDir = join(root, 'agent');
const cwd = join(root, 'project');
const sessionDir = join(agentDir, 'sessions');
const home = join(root, 'home');
const appData = join(root, 'appdata');
const temp = join(root, 'temp');
await Promise.all([
  mkdir(sessionDir, { recursive: true }),
  mkdir(cwd),
  mkdir(home),
  mkdir(appData),
  mkdir(temp),
]);
const socketPath =
  process.platform === 'win32' ? `\\\\.\\pipe\\prime-rust-wire-` + process.pid : join(root, 'daemon.sock');
const env = {
  PATH: process.env.PATH || '',
  DO_NOT_TRACK: '1',
  PRIME_AGENT_CODING_AGENT_DIR: agentDir,
  PRIME_AGENT_SESSION_DIR: sessionDir,
  HOME: home,
  USERPROFILE: home,
  APPDATA: appData,
  LOCALAPPDATA: appData,
  TEMP: temp,
  TMP: temp,
};
for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'])
  if (process.env[key]) env[key] = process.env[key];
const child = spawn(binary, ['--mode', 'daemon', '--daemon-socket', socketPath, '--offline'], {
  cwd: root,
  env,
  windowsHide: true,
  shell: false,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'ignore', 'pipe'],
});
const childExited = new Promise((resolveExit) => {
  child.once('exit', resolveExit);
  child.once('error', resolveExit);
});
let diagnostic = '';
child.stderr.on('data', (b) => {
  diagnostic = (diagnostic + b).slice(-3000);
});
let spawnError;
child.on('error', (error) => {
  spawnError = error;
});
let client;
let owned;
let completionAttempted = false;
try {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    client = new RustDaemonClient(socketPath, { expectedIdentity: { supervisorPid: child.pid } });
    try {
      await client.connect(500);
      await client.waitForHello(1000);
      break;
    } catch (e) {
      client.close();
      client = undefined;
      if (child.exitCode != null) throw new Error(diagnostic);
      await delay(100);
    }
  }
  assert(client, `Daemon not ready: ${diagnostic}`);
  const hello = await client.waitForHello();
  console.log(
    JSON.stringify({
      check: 'hello',
      protocol: hello.protocol,
      schemaRevision: hello.schemaRevision,
      runtimeBuild: hello.runtimeBuild,
      capabilities: hello.serverCapabilities,
    }),
  );
  const created = await client.request(
    {
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
    },
    30000,
  );
  assert.equal(created.success, true, created.error);
  owned = created.data.activeSessionId;
  assert(owned);
  console.log(JSON.stringify({ check: 'create', data: created.data }));
  if (!process.argv.includes('--no-attach')) {
    const attached = await client.request({
      type: 'attach',
      activeSessionId: owned,
      clientId: client.protocolClientId,
      capabilities: [],
    });
    assert.equal(attached.success, true, attached.error);
  }
  const state = await client.request({ type: 'get_state', activeSessionId: owned });
  assert.equal(state.success, true, state.error);
  assert.equal(state.data.sessionId, created.data.sessionId);
  const commands = await client.request({ type: 'get_commands', activeSessionId: owned });
  assert.equal(commands.success, true, commands.error);
  const header = await client.request({ type: 'get_session_header', activeSessionId: owned });
  assert.equal(header.success, true, header.error);
  console.log(
    JSON.stringify({
      check: 'native-state-and-commands',
      sessionId: state.data.sessionId,
      headerMatches: header.data.header.id === state.data.sessionId,
      commandCount: commands.data?.commands?.length,
    }),
  );
  completionAttempted = true;
  const completed = await client.request({ type: 'complete_owned_session', activeSessionId: owned }, 65000);
  assert.equal(completed.success, true, completed.error);
  owned = undefined;
  console.log(JSON.stringify({ status: 'passed', modelCalls: 0, liveStateMounted: false }));
} finally {
  if (owned && !completionAttempted)
    await client?.request({ type: 'complete_owned_session', activeSessionId: owned }, 65000).catch(() => {});
  // taskkill /T must run while the Windows supervisor still owns its worker tree.
  if (process.platform === 'win32') await terminateProcessTree(child);
  else await client?.request({ type: 'shutdown', force: true }, 3000).catch(() => {});
  client?.close();
  await Promise.race([childExited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) await terminateProcessTree(child);
  await Promise.race([childExited, delay(3000)]);
  let cleaned = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      cleaned = true;
      break;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      await delay(100);
    }
  }
  assert(cleaned, 'Synthetic canary state remains locked after daemon shutdown');
}
