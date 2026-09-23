import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCuaDriverTransport } from '../lib/cua-driver-transport.mjs';

// Fake spawn: no real processes, no desktop actions. Records argv/env and
// emulates a minimal MCP proxy (initialize + tools/list + tools/call).
function createFakeSpawn({ daemonPid = 5101, proxyPid = 5102 } = {}) {
  const spawns = [];
  const state = { daemon: null, proxy: null, shortLived: [] };
  function makeChild(pid) {
    const child = new EventEmitter();
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    const stdin = {
      written: [],
      ended: false,
      write(line, encoding, callback) {
        if (typeof encoding === 'function') callback = encoding;
        stdin.written.push(String(line));
        if (callback) setImmediate(() => callback(null));
        // Auto-respond for the proxy child only.
        if (child === state.proxy) setImmediate(() => autoRespond(String(line)));
        return true;
      },
      end() {
        stdin.ended = true;
        setImmediate(() => {
          if (child.exitCode === null) {
            child.exitCode = 0;
            child.emit('exit', 0, null);
          }
        });
      },
    };
    child.stdin = stdin;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.killed = true;
      if (child.exitCode === null) {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      }
      return true;
    };
    return child;
  }
  function autoRespond(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === 'notifications/initialized') return; // notification
    const id = msg.id;
    const respond = (result) => {
      state.proxy.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    };
    if (msg.method === 'initialize') {
      respond({ protocolVersion: '2025-06-18', serverInfo: { name: 'cua-driver', version: '0.28.2' } });
    } else if (msg.method === 'tools/list') {
      respond({ tools: [{ name: 'get_window_state' }, { name: 'click' }, { name: 'list_windows' }] });
    } else if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      if (name === 'hangprobe') return; // never answer: exercises caller timeout
      if (name === 'rpcerror') {
        state.proxy.stdout.emit(
          'data',
          `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool' } })}\n`,
        );
        return;
      }
      respond({ content: [{ type: 'text', text: `ok:${name}` }], isError: false });
    }
  }
  function spawn(command, args, options) {
    spawns.push({ command, args: [...args], options });
    if (args.includes('serve')) {
      const child = makeChild(daemonPid);
      state.daemon = child;
      return child;
    }
    if (args.includes('mcp')) {
      const child = makeChild(proxyPid);
      state.proxy = child;
      return child;
    }
    // Short-lived helper (--version, stop, status): answer without a proxy.
    const child = makeChild(9000 + spawns.length);
    state.shortLived.push(child);
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('cua-driver 0.28.2\n'));
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });
    return child;
  }
  return { spawns, state, spawn };
}

function autoTransport(fake, overrides = {}) {
  return createCuaDriverTransport({
    driverPath: 'C:\\fake\\cua-driver.exe',
    socketPath: '\\\\.\\pipe\\prime-studio-cua-test-1',
    homeDir: 'C:\\fake\\studio-cua-home',
    sessionLabel: 'test-session',
    spawnProcess: fake.spawn,
    env: {},
    startupTimeoutMs: 500,
    requestTimeoutMs: 800,
    stopTimeoutMs: 300,
    ...overrides,
  });
}

test('private socket and isolated home are required; shared daemon is refused', async () => {
  const fake = createFakeSpawn();
  for (const socketPath of ['\\\\.\\pipe\\cua-driver', '\\\\.\\pipe\\cua-driver-local', '']) {
    const transport = autoTransport(fake, { socketPath: socketPath || '' });
    await assert.rejects(transport.start(), (error) => {
      assert.ok(['SHARED_DAEMON_FORBIDDEN', 'INVALID_SOCKET'].includes(error.code), error.code);
      return true;
    });
    await transport.close().catch(() => {});
  }
  const noHome = autoTransport(fake, { homeDir: '' });
  await assert.rejects(noHome.start(), { code: 'INVALID_HOME' });
  await noHome.close().catch(() => {});
});

test('spawn uses private --socket pair with isolated env and no forbidden flags', async (t) => {
  const fake = createFakeSpawn();
  const transport = autoTransport(fake);
  t.after(() => transport.close().catch(() => {}));
  await transport.start();
  const serve = fake.spawns.find((s) => s.args.includes('serve'));
  const mcp = fake.spawns.find((s) => s.args.includes('mcp'));
  assert.ok(serve && mcp);
  assert.deepEqual(serve.args.slice(0, 3), ['serve', '--socket', '\\\\.\\pipe\\prime-studio-cua-test-1']);
  assert.deepEqual(mcp.args.slice(0, 3), ['mcp', '--socket', '\\\\.\\pipe\\prime-studio-cua-test-1']);
  for (const entry of fake.spawns) {
    for (const forbidden of [
      '--direct',
      '--dangerously-bypass-approvals',
      'autostart',
      'install',
      'update',
    ]) {
      assert.ok(!entry.args.includes(forbidden), `forbidden ${forbidden}`);
    }
  }
  assert.equal(serve.options.env.CUA_DRIVER_RS_HOME, 'C:\\fake\\studio-cua-home');
  assert.equal(serve.options.env.CUA_DRIVER_RS_UPDATE_CHECK, '0');
  assert.equal(serve.options.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, '0');
  assert.equal(mcp.options.env.CUA_DRIVER_RS_HOME, 'C:\\fake\\studio-cua-home');
  assert.equal(serve.options.windowsHide, true);
  assert.equal(serve.options.shell, false);
  assert.deepEqual(transport.ownedPids.sort(), [5101, 5102]);
});

test('legacy initialize handshake proves readiness; tools/list works', async (t) => {
  const fake = createFakeSpawn();
  const transport = autoTransport(fake);
  t.after(() => transport.close().catch(() => {}));
  await transport.start();
  const initLine = fake.state.proxy.stdin.written.find((line) => line.includes('"initialize"'));
  assert.ok(initLine);
  assert.ok(initLine.includes('2025-06-18'));
  const listed = await transport.listTools();
  assert.ok(Array.isArray(listed.tools));
  assert.ok(listed.tools.some((tool) => tool.name === 'get_window_state'));
});

test('tools/call rejects bad names locally; rpc errors surface with code', async (t) => {
  const fake = createFakeSpawn();
  const transport = autoTransport(fake);
  t.after(() => transport.close().catch(() => {}));
  await assert.rejects(transport.callTool('_private', {}), { code: 'INVALID_TOOL' });
  await assert.rejects(transport.callTool('has space', {}), { code: 'INVALID_TOOL' });
  await assert.rejects(transport.callTool('rpcerror', {}), (error) => {
    assert.equal(error.code, 'CUA_RPC_ERROR');
    return true;
  });
});

test('timeout is caller-side only and late answers are ignored by id', async (t) => {
  const fake = createFakeSpawn();
  const events = [];
  const transport = autoTransport(fake, { requestTimeoutMs: 40, onEvent: (e) => events.push(e) });
  t.after(() => transport.close().catch(() => {}));
  await transport.start();
  await assert.rejects(transport.callTool('hangprobe', {}), { code: 'TIMEOUT' });
  assert.ok(events.some((e) => e.kind === 'cua_timeout'));
  // A late answer to the abandoned id must not resolve anything or crash.
  fake.state.proxy.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 999999, result: {} })}\n`);
  const ok = await transport.callTool('list_windows', {});
  assert.ok(ok.result);
});

test('abort rejects locally without daemon cancel; stop advances generation and kills owned only', async (t) => {
  const fake = createFakeSpawn();
  const transport = autoTransport(fake);
  t.after(() => transport.close().catch(() => {}));
  await transport.start();
  const controller = new AbortController();
  const pending = transport.callTool('hangprobe', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  const gen = transport.generation;
  const stopped = await transport.stop('test-stop');
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.treeExited, true);
  assert.ok(transport.generation > gen);
  // Owned daemon+proxy were signalled; no generic-name kill was issued.
  assert.ok(fake.state.daemon.killed || fake.state.daemon.stdin.ended !== undefined);
  assert.ok(fake.state.proxy.killed || fake.state.proxy.stdin.ended);
  for (const entry of fake.spawns) {
    assert.ok(!entry.args.includes('taskkill'), 'no raw taskkill in fake path');
  }
});

test('metadata smoke runs only --version on the exact owned binary', async (t) => {
  const fake = createFakeSpawn();
  const transport = autoTransport(fake);
  t.after(() => transport.close().catch(() => {}));
  const smoke = await transport.smokeMetadata();
  assert.match(smoke.version, /0\.28\.2/);
  const helperCalls = fake.spawns.filter((s) => s.args.includes('--version'));
  assert.equal(helperCalls.length, 1);
  assert.equal(helperCalls[0].command, 'C:\\fake\\cua-driver.exe');
});

test('close retries a failed drain instead of reporting a false verified close', async (t) => {
  const fake = createFakeSpawn();
  const transport = autoTransport(fake);
  t.after(() => transport.close().catch(() => {}));
  await transport.start();
  // Wedge the daemon: kill becomes a no-op so the drain cannot verify.
  const daemon = fake.state.daemon;
  daemon.killed = false;
  daemon.kill = () => {
    daemon.killed = true;
    return true; // pretend to signal, but the process never exits
  };
  await assert.rejects(transport.close(), (error) => {
    assert.equal(error.code, 'TRANSPORT_CLOSE_FAILED');
    return true;
  });
  // Handles are retained for the retry; nothing was released.
  assert.ok(transport.ownedPids.length > 0);
  // Release the wedge: the retry re-kills and verifies.
  daemon.exitCode = 0;
  daemon.emit('exit', 0, null);
  await transport.close();
  assert.equal(transport.ownedPids.length, 0);
});

test('processHost seam delegates owned-root kill/verify when set', async (t) => {
  const fake = createFakeSpawn();
  const killed = [];
  const processHost = {
    async killTree(pids, opts) {
      killed.push([...pids]);
      for (const pid of pids) {
        const child = [fake.state.daemon, fake.state.proxy].find((c) => c && c.pid === pid);
        if (child && child.exitCode === null) {
          child.exitCode = 0;
          child.emit('exit', 0, null);
        }
      }
    },
    async verifyExit(pids, opts) {
      void opts;
      return pids.every((pid) => {
        const child = [fake.state.daemon, fake.state.proxy].find((c) => c && c.pid === pid);
        return !child || child.exitCode !== null;
      });
    },
  };
  const transport = autoTransport(fake, { processHost });
  t.after(() => transport.close().catch(() => {}));
  await transport.start();
  const stopped = await transport.stop('host-test');
  assert.equal(stopped.stopped, true);
  assert.deepEqual(killed, [[5101, 5102]], 'only owned roots, never broad');
});

test('waitForDaemon resolves after delayed readiness without arbitrary sleep', async () => {
  const fake = createFakeSpawn();
  let probes = 0;
  const { createCuaDriverTransport } = await import('../lib/cua-driver-transport.mjs');
  const transport = createCuaDriverTransport({
    driverPath: 'C:\\fake\\cua-driver.exe',
    socketPath: '\\\\.\\pipe\\prime-studio-cua-readiness-1',
    homeDir: 'C:\\fake\\studio-cua-home',
    spawnProcess: fake.spawn,
    env: {},
    daemonProbe: async () => (++probes <= 2 ? false : true),
  });
  try {
    const out = await transport.waitForDaemon({ timeoutMs: 2000, intervalMs: 10, perProbeMs: 20 });
    assert.equal(out.ready, true);
    assert.equal(probes, 3);
  } finally {
    await transport.close().catch(() => {});
  }
});

test('waitForDaemon times out never-ready with DAEMON_NOT_READY, metadata only', async () => {
  const fake = createFakeSpawn();
  const { createCuaDriverTransport } = await import('../lib/cua-driver-transport.mjs');
  const transport = createCuaDriverTransport({
    driverPath: 'C:\\fake\\cua-driver.exe',
    socketPath: '\\\\.\\pipe\\prime-studio-cua-readiness-2',
    homeDir: 'C:\\fake\\studio-cua-home',
    spawnProcess: fake.spawn,
    env: {},
    daemonProbe: async () => false,
  });
  try {
    await assert.rejects(transport.waitForDaemon({ timeoutMs: 120, intervalMs: 10, perProbeMs: 20 }), {
      code: 'DAEMON_NOT_READY',
    });
    assert.equal(fake.spawns.length, 0, 'readiness never spawns, never dispatches tools');
  } finally {
    await transport.close().catch(() => {});
  }
});

test('waitForDaemon aborts immediately on stop signal without further probes', async () => {
  const fake = createFakeSpawn();
  const { createCuaDriverTransport } = await import('../lib/cua-driver-transport.mjs');
  let probes = 0;
  const transport = createCuaDriverTransport({
    driverPath: 'C:\\fake\\cua-driver.exe',
    socketPath: '\\\\.\\pipe\\prime-studio-cua-readiness-3',
    homeDir: 'C:\\fake\\studio-cua-home',
    spawnProcess: fake.spawn,
    env: {},
    daemonProbe: async () => {
      probes += 1;
      await new Promise((r) => setTimeout(r, 30));
      return false;
    },
  });
  try {
    const controller = new AbortController();
    const pending = transport.waitForDaemon({
      timeoutMs: 5000,
      intervalMs: 10,
      perProbeMs: 20,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 25));
    controller.abort();
    await assert.rejects(pending, { code: 'ABORTED' });
    const frozen = probes;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(probes, frozen, 'no probe starts after abort');
  } finally {
    await transport.close().catch(() => {});
  }
});

test('waitForDaemon rejects the shared pipe before any probe packet', async () => {
  const fake = createFakeSpawn();
  const { createCuaDriverTransport } = await import('../lib/cua-driver-transport.mjs');
  let probes = 0;
  const transport = createCuaDriverTransport({
    driverPath: 'C:\\fake\\cua-driver.exe',
    socketPath: '\\\\.\\pipe\\cua-driver',
    homeDir: 'C:\\fake\\studio-cua-home',
    spawnProcess: fake.spawn,
    env: {},
    daemonProbe: async () => {
      probes += 1;
      return true;
    },
  });
  try {
    await assert.rejects(transport.waitForDaemon({ timeoutMs: 300 }), (error) => {
      assert.equal(error.code, 'SHARED_DAEMON_FORBIDDEN');
      return true;
    });
    assert.equal(probes, 0, 'no probe packet ever leaves for the shared daemon');
    assert.equal(fake.spawns.length, 0);
  } finally {
    await transport.close().catch(() => {});
  }
});

test('default probe accepts a healthy real-size Windows list answer over 64KiB', async (t) => {
  const { createServer } = await import('node:net');
  const { randomUUID } = await import('node:crypto');
  const pipe = `\\\\.\\pipe\\prime-test-probe-${randomUUID()}`;
  const server = createServer((socket) => {
    socket.on('data', () => {
      // Full-ToolDefs-shaped answer (~70KB, like a real Windows daemon
      // `list` with double_click/set_value/etc): strict one-JSON-line,
      // must resolve ready.
      const tools = [{ name: 'list_windows', description: 'L'.repeat(69000) }];
      const payload = `${JSON.stringify({ ok: true, result: { tools } })}` + '\n';
      if (!(payload.length > 65536 && payload.length < 1048576)) throw new Error('bad fixture size');
      socket.write(payload);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const fake = createFakeSpawn();
  const { createCuaDriverTransport } = await import('../lib/cua-driver-transport.mjs');
  const transport = createCuaDriverTransport({
    driverPath: 'C:\\fake\\cua-driver.exe',
    socketPath: pipe,
    homeDir: 'C:\\fake\\studio-cua-home',
    spawnProcess: fake.spawn,
    env: {},
  });
  try {
    const out = await transport.waitForDaemon({ timeoutMs: 2000, intervalMs: 50, perProbeMs: 500 });
    assert.equal(out.ready, true);
  } finally {
    await transport.close().catch(() => {});
  }
});

test('default probe fails packets over 1MiB within bounds', async (t) => {
  const { createServer } = await import('node:net');
  const { randomUUID } = await import('node:crypto');
  const BS = String.fromCharCode(92);
  const pipe = BS + BS + '.' + BS + 'pipe' + BS + `prime-test-probe-oversize-${randomUUID()}`;
  const server = createServer((socket) => {
    socket.on('data', () => {
      // 1.1MB newline-less garbage: must fail the round, not accumulate.
      socket.write('x'.repeat(1100000));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const fake = createFakeSpawn();
  const { createCuaDriverTransport } = await import('../lib/cua-driver-transport.mjs');
  const transport = createCuaDriverTransport({
    driverPath: 'C:' + BS + 'fake' + BS + 'cua-driver.exe',
    socketPath: pipe,
    homeDir: 'C:' + BS + 'fake' + BS + 'studio-cua-home',
    spawnProcess: fake.spawn,
    env: {},
  });
  try {
    await assert.rejects(transport.waitForDaemon({ timeoutMs: 600, intervalMs: 50, perProbeMs: 200 }), {
      code: 'DAEMON_NOT_READY',
    });
    assert.equal(fake.spawns.length, 0, 'readiness never spawns');
  } finally {
    await transport.close().catch(() => {});
  }
});
