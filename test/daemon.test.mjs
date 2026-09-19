import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOwnedDaemon } from '../lib/daemon.mjs';

function fixture(overrides = {}) {
  const children = [];
  const launches = [];
  const commands = [];
  const terminated = [];
  const diagnostics = [];
  const sockets = [];
  const finish = (child, code = 0) => {
    child.exitCode = code;
    child.emit('exit', code, null);
    child.emit('close', code, null);
  };
  class Client {
    constructor(socketPath) {
      sockets.push(socketPath);
    }
    async connect() {
      if (overrides.unavailable || (!overrides.replacementPid && children.at(-1)?.exitCode !== null)) {
        throw new Error('Not ready');
      }
    }
    async waitForHello() {
      return { supervisorPid: overrides.wrongPid ? 7 : (overrides.replacementPid ?? children.at(-1).pid) };
    }
    async request(command) {
      commands.push(command);
      if (!overrides.hung) {
        if (overrides.replacementPid) overrides.replacementPid = undefined;
        else finish(children.at(-1));
      }
      return { success: true };
    }
    close() {}
  }
  const daemon = createOwnedDaemon(
    {
      cli: { packageDir: '/fake/package', path: '/fake/package/cli.js', node: true },
      env: {
        NODE_OPTIONS: '--require=gui-hidden.cjs',
        PRIME_GUI_SILENT: '1',
        PRIME_AGENT_INTERNAL_DAEMON_WORKER: '1',
        PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: 'old-worker-secret',
        PRIME_AGENT_INTERNAL_DAEMON_CATALOG: '1',
        PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET: 'other-daemon',
        PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID: 'other-owner',
        PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL: 'other-journal',
        PRIME_GUI_CONTROL: '1',
        PRIME_AGENT_SESSION_DIR: '/fake/sessions',
      },
      startupTimeout: overrides.startupTimeout ?? 1000,
      closeTimeout: 10,
      onDiagnostic: (event) => diagnostics.push(event),
      async terminateProcess(child) {
        if (child && child.exitCode === null) {
          terminated.push(child.pid);
          finish(child, -1);
        }
      },
    },
    {
      loadClient: async () => Client,
      spawnProcess(command, args, options) {
        const child = Object.assign(new EventEmitter(), {
          pid: 51000 + children.length,
          exitCode: null,
          signalCode: null,
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
        });
        children.push(child);
        launches.push({ command, args, options });
        return child;
      },
    },
  );
  return { daemon, children, launches, commands, terminated, diagnostics, sockets, finish };
}

test('unused runtimes allocate distinct private sockets and never start a daemon during close', async () => {
  const first = fixture();
  const second = fixture();
  assert.notEqual(first.daemon.socketPath, second.daemon.socketPath);
  assert.match(first.daemon.socketPath, /prime-studio-.*[a-f0-9-]{36}/);
  await Promise.all([first.daemon.close(), second.daemon.close()]);
  assert.equal(first.launches.length + second.launches.length, 0);
});

test('concurrent runs share one directly owned hidden daemon without inheriting foreign worker roles', async () => {
  const f = fixture();
  const results = await Promise.all([f.daemon.ensureReady(), f.daemon.ensureReady()]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.launches[0].args, [
    '/fake/package/cli.js',
    '--mode',
    'daemon',
    '--daemon-socket',
    f.daemon.socketPath,
  ]);
  const options = f.launches[0].options;
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, false);
  assert.equal(options.env.NODE_OPTIONS, '--require=gui-hidden.cjs');
  assert.equal(options.env.PRIME_AGENT_SESSION_DIR, '/fake/sessions');
  assert.equal(options.env.PRIME_GUI_SILENT, '1');
  assert.equal(options.env.PRIME_GUI_CONTROL, undefined);
  assert.deepEqual(
    Object.keys(options.env).filter((name) => name.startsWith('PRIME_AGENT_INTERNAL_')),
    [],
  );
  await f.daemon.close();
  assert.deepEqual(f.commands, [{ type: 'shutdown', force: true }]);
  assert.ok(f.sockets.every((socket) => socket === f.daemon.socketPath));
  assert.deepEqual(f.terminated, []);
  await assert.rejects(f.daemon.ensureReady(), /arrêt/);
});

test('startup refuses a different supervisor and terminates only its own child', async () => {
  const f = fixture({ wrongPid: true });
  await assert.rejects(f.daemon.ensureReady(), /ne correspond pas/);
  assert.deepEqual(f.terminated, [51000]);
  await f.daemon.close();
  assert.deepEqual(f.commands, []);
});

test('a startup timeout cleans up the owned process and remains retryable', async () => {
  const f = fixture({ unavailable: true, startupTimeout: 10 });
  await assert.rejects(f.daemon.ensureReady(), /ne répond pas/);
  assert.deepEqual(f.terminated, [51000]);
  await assert.rejects(f.daemon.ensureReady(), /ne répond pas/);
  assert.deepEqual(f.terminated, [51000, 51001]);
});

test('shutdown has a bounded fallback for the owned child when the supervisor hangs', async () => {
  const f = fixture({ hung: true });
  await f.daemon.ensureReady();
  await Promise.all([f.daemon.close(), f.daemon.close()]);
  assert.equal(f.commands.length, 1);
  assert.deepEqual(f.terminated, [51000]);
});

test('closing during startup prevents a ready result and cleans up the pending child', async () => {
  const f = fixture({ unavailable: true });
  const pending = assert.rejects(f.daemon.ensureReady(), /arrêt/);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.daemon.close();
  await pending;
  assert.deepEqual(f.terminated, [51000]);
});

test('a supervisor exit allows a fresh owned generation in the same private namespace', async () => {
  const f = fixture();
  const first = await f.daemon.ensureReady();
  f.finish(f.children[0], 1);
  const second = await f.daemon.ensureReady();
  assert.notEqual(first.pid, second.pid);
  assert.equal(first.socketPath, second.socketPath);
  assert.equal(f.diagnostics[0].kind, 'daemon_exit');
  await f.daemon.close();
});

test('a verified private namespace adopts a native successor without spawning a competitor', async () => {
  const controls = {};
  const f = fixture(controls);
  const first = await f.daemon.ensureReady();
  f.finish(f.children[0], 1);
  controls.replacementPid = 61000;
  const recovered = await Promise.all([f.daemon.ensureReady(), f.daemon.ensureReady()]);
  assert.deepEqual(recovered, [
    { pid: 61000, socketPath: first.socketPath },
    { pid: 61000, socketPath: first.socketPath },
  ]);
  assert.equal(f.daemon.pid, 61000);
  assert.equal(f.launches.length, 1);
  await f.daemon.close();
  assert.deepEqual(f.commands, [{ type: 'shutdown', force: true }]);
  assert.deepEqual(f.terminated, []);
  assert.ok(f.sockets.every((socket) => socket === first.socketPath));
});

test('bridge launches use the direct node entry while keeping the public path for receipts', async () => {
  const f = fixture();
  f.daemon.close();
  const { EventEmitter } = await import('node:events');
  const launches = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 52000,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  class Client {
    async connect() {}
    async waitForHello() {
      return { supervisorPid: 52000 };
    }
    async request() {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      return { success: true };
    }
    close() {}
  }
  const { createOwnedDaemon } = await import('../lib/daemon.mjs');
  const daemon = createOwnedDaemon(
    {
      cli: {
        packageDir: '/fake/package',
        path: '/fake/package/dist/bundle/cli.js',
        launchPath: '/fake/package/dist/bundle/cli-node.js',
        node: true,
      },
      env: {},
      startupTimeout: 1000,
      closeTimeout: 10,
      async terminateProcess(c) {
        if (c && c.exitCode === null) {
          c.exitCode = -1;
          c.emit('exit', -1, null);
        }
      },
    },
    {
      loadClient: async () => Client,
      spawnProcess(command, args, options) {
        launches.push({ command, args, options });
        return child;
      },
    },
  );
  const ready = await daemon.ensureReady();
  assert.equal(ready.pid, 52000);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, process.execPath);
  assert.deepEqual(launches[0].args.slice(0, 1), ['/fake/package/dist/bundle/cli-node.js']);
  assert.ok(!launches[0].args.includes('/fake/package/dist/bundle/cli.js'));
  await daemon.close();
});

test('a native successor is probed again and replaced by an owned child after it disappears', async () => {
  const controls = {};
  const f = fixture(controls);
  await f.daemon.ensureReady();
  f.finish(f.children[0], 1);
  controls.replacementPid = 61001;
  assert.equal((await f.daemon.ensureReady()).pid, 61001);
  controls.replacementPid = undefined;
  assert.equal((await f.daemon.ensureReady()).pid, 51001);
  assert.equal(f.launches.length, 2);
  await f.daemon.close();
  assert.deepEqual(f.terminated, []);
});
