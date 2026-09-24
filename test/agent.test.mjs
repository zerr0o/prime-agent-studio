import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime, normalizeEvent, discoverCli, agentEnvironment } from '../lib/agent.mjs';
import { createModelAvailability } from '../lib/model-availability.mjs';

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/agent-cli.mjs', import.meta.url));
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prime-gui-runtime-'));
  const runtime = createAgentRuntime({
    agentHome: join(dir, 'agent'),
    sessionDir: join(dir, 'sessions'),
    cliPath: fixture,
    env: {},
  });
  t.after(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(runtime.agentHome, { recursive: true });
  return { dir, runtime };
}

test('CLI status and JSON streaming preserve Unicode and separate text, reasoning and tool deltas', async (t) => {
  const { dir, runtime } = await setup(t);
  assert.equal((await runtime.getStatus()).version, '0.0.0-test');
  const events = [];
  const handle = await runtime.start({
    cwd: dir,
    message: 'Bonjour',
    onEvent: (event) => events.push(event),
  });
  assert.equal((await handle.done).status, 'completed');
  assert.equal(handle.sessionId, 'test-session');
  assert.deepEqual(
    events.filter((e) => e.kind === 'text').map((e) => e.delta),
    ['Bonjour ☀️'],
  );
  assert.deepEqual(
    events.filter((e) => e.kind === 'thinking').map((e) => e.delta),
    ['Plan'],
  );
  assert.equal(events.find((e) => e.kind === 'tool_end').result.content[0].text, '2');
  assert.equal(events.find((e) => e.kind === 'message').message.usage.totalTokens, 5);
  assert.equal(events.filter((e) => e.kind === 'done').length, 1);
});

test('provider errors are failures even when the CLI exits successfully', async (t) => {
  const { dir, runtime } = await setup(t);
  const handle = await runtime.start({ cwd: dir, message: '[fail]' });
  assert.equal((await handle.done).status, 'failed');
});

test('a successful native retry clears the transient provider failure', async (t) => {
  const { dir, runtime } = await setup(t);
  const handle = await runtime.start({ cwd: dir, message: '[recovered]' });
  assert.equal((await handle.done).status, 'completed');
});

test('model catalogue returns a positive allowlist and never credential-bearing config', async (t) => {
  const { runtime } = await setup(t);
  const secret = 'SECRET_MUST_NOT_LEAVE_SERVER';
  await writeFile(
    join(runtime.agentHome, 'models.json'),
    JSON.stringify({
      providers: {
        custom: {
          apiKey: secret,
          baseUrl: `https://host.invalid/?token=${secret}`,
          headers: { Authorization: secret },
          models: [
            {
              id: 'test-model',
              name: 'Test Model',
              reasoning: true,
              contextWindow: 8192,
              headers: { token: secret },
              apiKey: secret,
              compat: { customSecret: secret },
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(runtime.agentHome, 'auth.json'),
    JSON.stringify({ custom: { token: secret, refresh: secret } }),
  );
  await writeFile(
    join(runtime.agentHome, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'custom',
      defaultModel: 'test-model',
      defaultThinkingLevel: 'low',
      apiKey: secret,
    }),
  );
  const catalog = await runtime.getModels();
  assert.equal(catalog.models.length, 1);
  assert.deepEqual(catalog.configuredProviders, ['custom']);
  assert.equal(catalog.default.model, 'custom/test-model');
  assert.equal(catalog.models[0].contextWindow, 8192);
  assert.equal(JSON.stringify(catalog).includes(secret), false);
});

test('a remembered model does not imply a configured provider', async (t) => {
  const { runtime } = await setup(t);
  await writeFile(
    join(runtime.agentHome, 'settings.json'),
    JSON.stringify({ defaultProvider: 'past', defaultModel: 'remembered', recentModels: ['previous/model'] }),
  );
  const catalog = await runtime.getModels();
  assert.equal(catalog.default.model, 'past/remembered');
  assert.deepEqual(catalog.configuredProviders, []);
});

test('model picker uses native available models, keeps missing recent/default choices unavailable and projects safe fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-native-catalog-'));
  const requests = [];
  let refreshing = false;
  const runtime = createAgentRuntime({
    agentHome: root,
    sessionDir: join(root, 'sessions'),
    cliPath: fixture,
    env: {},
    nativeModelCatalog: {
      read: async (options) => {
        requests.push(options);
        return {
          refreshing,
          models: [
            {
              id: 'new-model',
              provider: 'prime-inference',
              name: 'Live model',
              reasoning: true,
              thinkingLevels: ['low', 'high', 'malicious'],
              input: ['text'],
              contextWindow: 32000,
              headers: { Authorization: 'never expose me' },
              apiKey: 'never expose me',
            },
          ],
        };
      },
      close: async () => {},
    },
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    join(root, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'prime-inference',
      defaultModel: 'retired',
      recentModels: ['prime-inference/internal/no-longer-authorized'],
    }),
  );
  // Native validation is authoritative: raw custom overrides cannot re-add unavailable private models.
  await writeFile(
    join(root, 'models.json'),
    JSON.stringify({ providers: { 'prime-inference': { models: [{ id: 'internal/hidden' }] } } }),
  );
  const result = await runtime.getModels({ refresh: true });
  assert.equal(requests[0].refresh, true);
  assert.equal(result.refreshing, false);
  assert.equal(result.default.model, 'prime-inference/retired');
  assert.equal(result.models.find((m) => m.id.endsWith('/retired')).availability, 'unavailable');
  assert.equal(result.models.find((m) => m.id.endsWith('/no-longer-authorized')).availability, 'unavailable');
  assert.equal(
    result.models.some((m) => m.id.endsWith('/hidden')),
    false,
  );
  assert.deepEqual(result.models.find((m) => m.name === 'Live model').thinkingLevels, ['low', 'high']);
  assert.equal(JSON.stringify(result).includes('never expose me'), false);
  refreshing = true;
  assert.equal(
    (await runtime.getModels()).models.find((m) => m.id.endsWith('/retired')).availability,
    'unknown',
  );
});

test('native endpoint provenance and legacy JSONC per-model endpoints stay outside the public check', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-model-endpoint-'));
  const modelAvailability = createModelAvailability({
    fetchImpl: async () => Response.json({ data: [{ id: 'minimax/minimax-m3' }] }),
  });
  let legacy = false;
  const runtime = createAgentRuntime({
    agentHome: root,
    cliPath: fixture,
    env: {},
    modelAvailability,
    nativeModelCatalog: {
      read: async () => {
        if (legacy) throw new Error('Legacy engine');
        return {
          refreshing: false,
          models: [
            { provider: 'openrouter', id: 'private/local', openRouterPublic: false },
            { provider: 'openrouter', id: 'minimax/minimax-m3:free', openRouterPublic: true },
          ],
        };
      },
      close: async () => {},
    },
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.getModels();
  await new Promise((done) => setImmediate(done));
  let result = await runtime.getModels();
  assert.equal(result.models.find((m) => m.id.endsWith('/local')).availability, undefined);
  assert.equal(result.models.find((m) => m.id.endsWith(':free')).availability, 'unavailable');
  assert.equal(JSON.stringify(result).includes('openRouterPublic'), false);
  legacy = true;
  await writeFile(
    join(root, 'models.json'),
    `{
    // Native configuration may contain comments and trailing commas.
    "providers": {"openrouter": {"baseUrl": "https://openrouter.ai/api/v1", "models": [
      {"id": "private/local", "baseUrl": "http://127.0.0.1:1234/v1"},
      {"id": "minimax/minimax-m3:free"},
    ]}},
  }`,
  );
  result = await runtime.getModels();
  assert.equal(result.models.find((m) => m.id.endsWith('/local')).availability, undefined);
  assert.equal(result.models.find((m) => m.id.endsWith(':free')).availability, 'unavailable');
  assert.equal(JSON.stringify(result).includes('127.0.0.1:1234'), false);
});

test('cancelling a run terminates its child process tree', { timeout: 20000 }, async (t) => {
  const { dir, runtime } = await setup(t);
  let ready;
  const childReady = new Promise((resolvePromise) => {
    ready = resolvePromise;
  });
  const handle = await runtime.start({
    cwd: dir,
    message: '[linger]',
    onEvent(event) {
      if (event.kind === 'tool_start') ready(event.args.pid);
    },
  });
  const childPid = await childReady;
  assert.ok(childPid);
  await handle.cancel();
  assert.equal((await handle.done).status, 'stopped');
  let alive = true;
  for (let attempt = 0; attempt < 20 && alive; attempt++) {
    try {
      process.kill(childPid, 0);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `descendant ${childPid} should have exited`);
});

test('malformed options are rejected before creating processes', async (t) => {
  const { dir, runtime } = await setup(t);
  await assert.rejects(runtime.start({ cwd: dir, message: 'ok', thinking: '--unsafe' }), /réflexion/);
  await assert.rejects(runtime.start({ cwd: dir, message: 'ok', sessionId: '../outside' }), /Identifiant/);
  assert.equal(discoverCli(join(dir, 'missing.js')), null);
  assert.deepEqual(
    normalizeEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', delta: 'args' },
    }),
    [],
  );
});

test('closing runtime prevents pending or subsequent starts from creating agents', async (t) => {
  const { dir, runtime } = await setup(t);
  const pending = runtime.start({ cwd: dir, message: 'must not run' });
  const rejected = assert.rejects(pending, /arrêt/);
  await runtime.close();
  await rejected;
  await assert.rejects(runtime.start({ cwd: dir, message: 'closed' }), /arrêt/);
});

test(
  'Windows Node preload enforces hidden creation and propagation at native spawn boundary',
  { skip: process.platform !== 'win32' },
  async () => {
    const source = `
    const cp = require('node:child_process');
    const binding = process.binding('process_wrap');
    const original = binding.Process.prototype.spawn;
    const observed = [];
    binding.Process.prototype.spawn = function(...args) {
      // Node 24 passes positional native arguments; Node 22 passes options.
      const hidden = typeof args[0] === 'object' ? args[0].windowsHide : args[5] !== 0;
      const env = typeof args[0] === 'object' ? args[0].envPairs : args[3];
      observed.push({hidden,env:env.filter(p=>/^(NODE_OPTIONS|PYTHONPATH|PRIME_GUI_SILENT)=/.test(p))});
      return original.apply(this,args);
    };
    const child=cp.spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:false,env:{NODE_OPTIONS:'--no-warnings'},stdio:'ignore'});
    child.on('close',()=>console.log(JSON.stringify(observed)));
  `;
    const { stdout } = await exec(process.execPath, ['-e', source], {
      env: agentEnvironment(),
      windowsHide: true,
      timeout: 10000,
    });
    const observed = JSON.parse(stdout);
    assert.equal(observed[0].hidden, true);
    assert.ok(observed[0].env.some((value) => value.includes('windows-hidden.cjs')));
    assert.ok(observed[0].env.includes('PRIME_GUI_SILENT=1'));
  },
);

const localPython = resolve('.local/kernel-venv/Scripts/python.exe');
const kernelPython =
  process.env.PRIME_AGENT_KERNEL_PYTHON ||
  (existsSync(localPython)
    ? localPython
    : join(homedir(), '.prime', 'agent', 'kernel-venv', 'Scripts', 'python.exe'));
test(
  'Windows Python kernel subprocesses receive CREATE_NO_WINDOW and SW_HIDE',
  { skip: process.platform !== 'win32' || !existsSync(kernelPython) },
  async () => {
    const source = `import json, subprocess, sys, _winapi\noriginal = _winapi.CreateProcess\nseen = []\ndef capture(*args):\n    seen.append({'flags': args[5], 'show': args[8].wShowWindow, 'startup': args[8].dwFlags})\n    return original(*args)\n_winapi.CreateProcess = capture\nsubprocess.run([sys.executable, '-c', 'pass'], check=True, creationflags=subprocess.CREATE_NEW_CONSOLE)\nprint(json.dumps(seen))`;
    const { stdout, stderr } = await exec(kernelPython, ['-c', source], {
      env: agentEnvironment(),
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(stderr, '');
    const observed = JSON.parse(stdout)[0];
    assert.ok(observed.flags & 0x08000000, 'CREATE_NO_WINDOW');
    assert.equal(observed.flags & 0x00000010, 0, 'CREATE_NEW_CONSOLE cleared');
    assert.equal(observed.show, 0, 'SW_HIDE');
    assert.ok(observed.startup & 1, 'STARTF_USESHOWWINDOW');
  },
);

test(
  'Windows rlm.bash Job Object launch stays hidden at CreateProcessW boundary',
  { skip: process.platform !== 'win32' || !existsSync(kernelPython) },
  async () => {
    const source = `
import json, ctypes, sys, os
import rlm._winjob as job
native = job._kernel32()
seen = []
class Proxy:
    def __getattr__(self, name):
        return getattr(native, name)
    def CreateProcessW(self, *args):
        startup = ctypes.cast(args[8], ctypes.POINTER(job._STARTUPINFOEXW)).contents.StartupInfo
        seen.append({'flags': args[5], 'startup': startup.dwFlags, 'show': startup.wShowWindow})
        return native.CreateProcessW(*args)
job._kernel32_cache = Proxy()
handle = job.create_job()
assert handle
child = job.spawn_in_job(handle, [sys.executable, '-c', 'print("ready")'], cwd=os.getcwd(), env=dict(os.environ))
assert child.resume()
assert child.stdout.read().strip() == b'ready'
assert child.wait() == 0
child.close()
job.close(handle)
print(json.dumps(seen))
`;
    const { stdout, stderr } = await exec(kernelPython, ['-c', source], {
      env: agentEnvironment(),
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(stderr, '');
    const observed = JSON.parse(stdout)[0];
    assert.ok(observed.flags & 0x08000000, 'CREATE_NO_WINDOW');
    assert.equal(observed.show, 0, 'SW_HIDE');
    assert.ok(observed.startup & 1, 'STARTF_USESHOWWINDOW');
  },
);

test('agent environment strips foreign Studio loader imports but keeps user flags', () => {
  const foreign =
    '--import="file:///C:/Other/studio/runtime/kernel-loader.mjs" --import="file:///C:/Other/studio/runtime/subagent-loader.mjs" --max-old-space-size=4096';
  const env = agentEnvironment({ env: { ...process.env, NODE_OPTIONS: foreign } });
  assert.ok(!env.NODE_OPTIONS.includes('C:/Other'), 'foreign loaders removed');
  assert.ok(env.NODE_OPTIONS.includes('--max-old-space-size=4096'), 'user flags kept');
  assert.ok(env.NODE_OPTIONS.includes('windows-hidden.cjs'), 'repo preload present');
});

test('agent environment strips only foreign Studio loaders, byte-preserving the rest', () => {
  const ownLoader = `file:///${fileURLToPath(new URL('../runtime/kernel-loader.mjs', import.meta.url))
    .replaceAll('\\', '/')
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)}`;
  const nodeOptions = [
    '--import="file:///C:/Other/studio/runtime/kernel-loader.mjs"',
    "--import='C:\\FOREIGN\\STUDIO\\RUNTIME\\SUBAGENT-LOADER.MJS'",
    `--import="${ownLoader}"`,
    '--import="file:///C:/tools/a  b/my-loader.mjs"',
    '--max-old-space-size=4096',
  ].join(' ');
  const env = agentEnvironment({ env: { ...process.env, NODE_OPTIONS: nodeOptions } });
  assert.ok(!env.NODE_OPTIONS.includes('C:/Other'), 'foreign file-URL loader removed');
  assert.ok(!env.NODE_OPTIONS.includes('FOREIGN'), 'foreign backslash uppercase loader removed');
  assert.ok(env.NODE_OPTIONS.includes(ownLoader), 'own loader preserved byte-identical');
  assert.ok(env.NODE_OPTIONS.includes('a  b'), 'quoted double spaces elsewhere untouched');
  assert.ok(env.NODE_OPTIONS.includes('--max-old-space-size=4096'), 'user flags kept');
  assert.ok(env.NODE_OPTIONS.includes('windows-hidden.cjs'), 'repo preload present');
});
