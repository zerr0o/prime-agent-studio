import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCuaComputerUseDriver } from '../lib/cua-computer-use-driver.mjs';
import { createComputerUseDriver } from '../lib/computer-use-driver.mjs';
import { createCuaDriverTransport } from '../lib/cua-driver-transport.mjs';

// Synthetic pixels only. No live capture, focus or input. The fake guardian
// implements the REAL native driver shape (request/stop/close) plus the
// ratified job verbs; the adapter addresses it ONLY through request().
// Legacy mapping tests use an injected prestarted fake CUA transport;
// production-path tests use the real transport factory over a fake
// process boundary (proxy-only spawn, adopted before handshake).
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function fakeNativeGuardian(opts = {}) {
  const { mutex = true, flag = true, hotkeyError = null, job = null } = opts;
  // Absent key means unknown registration (fail closed); explicit false
  // means refused. Destructured defaults cannot express the difference.
  const hotkeyRegistered = Object.hasOwn(opts, 'hotkeyRegistered') ? opts.hotkeyRegistered : true;
  const state = {
    arms: [],
    disarms: 0,
    cleanups: [],
    stops: [],
    closes: 0,
    requests: [],
    launched: [],
    adopted: [],
    kills: [],
    reconciles: [],
  };
  const verbs = job ?? {};
  const guardian = {
    state,
    async request(command, opts = {}) {
      state.requests.push(command);
      const method = command?.method;
      const params = command?.params ?? {};
      if (method === 'status') {
        return {
          supported: true,
          platform: 'win32',
          hotkey: 'Ctrl+Alt+Shift+F10',
          hotkeyRegistered,
          ...(hotkeyError === null ? {} : { hotkeyError }),
          mutex,
          externalInputGuard: { supported: flag, armed: state.arms.length > state.disarms },
        };
      }
      if (method === 'arm_external_input') {
        state.arms.push(params);
        return { armed: true };
      }
      if (method === 'disarm_external_input') {
        state.disarms += 1;
        return { disarmed: true };
      }
      if (method === 'cleanup_external_input') {
        if (verbs.cleanupFails) {
          const e = new Error('cleanup did not complete');
          e.code = 'WORKER_ERROR';
          throw e;
        }
        state.cleanups.push(params);
        return { cleaned: true };
      }
      if (method === 'stop') {
        state.stops.push(params);
        return { stopped: true };
      }
      if (method === 'job_launch') {
        if (verbs.noJobVerbs) {
          const e = new Error(`Unknown computer-use method: ${method}.`);
          e.code = 'UNKNOWN_METHOD';
          throw e;
        }
        const pid = 8000 + state.launched.length + 1;
        state.launched.push({ ...params, pid });
        return { launched: true, pid, jobName: `cua-job-${pid}` };
      }
      if (method === 'job_adopt') {
        if (verbs.noJobVerbs) {
          const e = new Error(`Unknown computer-use method: ${method}.`);
          e.code = 'UNKNOWN_METHOD';
          throw e;
        }
        if (verbs.adoptRefused) {
          const e = new Error('adopt refused: identity unverified');
          e.code = 'ADOPT_REFUSED';
          throw e;
        }
        state.adopted.push(params);
        return { adopted: true, pid: params.pid };
      }
      if (method === 'job_kill') {
        if (verbs.noJobVerbs) {
          const e = new Error(`Unknown computer-use method: ${method}.`);
          e.code = 'UNKNOWN_METHOD';
          throw e;
        }
        state.kills.push(params);
        if (verbs.killUnverified) return { treeExited: false, activeProcesses: 2 };
        return { treeExited: true, activeProcesses: 0 };
      }
      if (method === 'job_reconcile') {
        state.reconciles.push(params);
        if (verbs.reconcileLost)
          return { found: false, reconciled: false, treeExited: false, activeProcesses: 0 };
        return { found: true, reconciled: true, treeExited: false, activeProcesses: 1 };
      }
      if (method === 'job_status')
        return { active: true, activeProcesses: 1, daemonPid: 8001, jobName: 'cua-job-8001' };
      const error = new Error(`Unknown computer-use method: ${method}.`);
      error.code = 'UNKNOWN_METHOD';
      throw error;
    },
    async stop(reason) {
      state.stops.push(reason);
      return { stopped: true, reason };
    },
    async close() {
      if (verbs.closeFails) {
        const e = new Error('guardian close failed');
        e.code = 'WORKER_EXIT';
        throw e;
      }
      state.closes += 1;
    },
  };
  return guardian;
}

function fakeCuaTransport({ onCall, stuckPids = null } = {}) {
  // stuckPids wedges the kill once; clearStuck() releases the retry. A
  // legacy stop re-applies the wedge only while it is set.
  const calls = [];
  const transport = {
    daemonPid: 6101,
    proxyPid: 6102,
    started: true,
    generation: 1,
    startCalls: 0,
    stoppedReasons: [],
    closed: false,
    ownedPids: [],
    stuckPids,
    async start() {
      transport.startCalls += 1;
      return { daemonPid: 6101, proxyPid: 6102, generation: 1 };
    },
    async callTool(name, args = {}, opts = {}) {
      calls.push({ name, args });
      if (onCall) return onCall(name, args, opts);
      return { result: { content: [{ type: 'text', text: 'ok' }] }, timing: { durationMs: 1 } };
    },
    async abort(reason) {
      transport.aborted = reason;
      return { aborted: true, reason };
    },
    async stop(reason) {
      transport.stoppedReasons.push(reason);
      if (transport.stuckPids) transport.ownedPids = [...transport.stuckPids];
      return { stopped: true, reason, treeExited: !transport.stuckPids };
    },
    clearStuck() {
      transport.stuckPids = null;
      transport.ownedPids = [];
    },
    async close() {
      transport.closed = true;
    },
  };
  return { transport, calls };
}

function windowStateResult({ width = 800, height = 600, snapshot = 's00000001' } = {}) {
  return {
    result: {
      content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }],
      structuredContent: {
        snapshot_id: snapshot,
        elements: [
          { element_index: 0, element_token: `${snapshot}:0`, role: 'button', label: 'OK' },
          { element_index: 1, element_token: `${snapshot}:1`, role: 'textField', label: 'Name' },
        ],
        screenshot_width: width,
        screenshot_height: height,
        window_bounds: { x: 10, y: 20, width, height },
        screenshot_mime_type: 'image/png',
      },
    },
    timing: { durationMs: 2 },
  };
}

function desktopStateResult({ width = 1920, height = 1080 } = {}) {
  return {
    result: {
      content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }],
      structuredContent: {
        screenshot_width: width,
        screenshot_height: height,
        screen_width: width,
        screen_height: height,
        scale_factor: 1,
        platform: 'windows',
        display: 'primary',
        screenshot_mime_type: 'image/png',
      },
    },
    timing: { durationMs: 2 },
  };
}

function actionOk(effect = 'confirmed', route = 'accessibility') {
  return {
    result: { content: [{ type: 'text', text: 'acted' }], structuredContent: { effect, route } },
    timing: { durationMs: 1 },
  };
}

function legacyDriver(fake, overrides = {}) {
  return createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    sessionLabel: 'test-session',
    transport: fake.transport,
    createGuardian: async () => fake.guardian ?? fakeNativeGuardian(),
    defaultTimeoutMs: 1500,
    stopTimeoutMs: 300,
    ...overrides,
  });
}

// Fake process boundary for the REAL transport factory (job production
// path): the daemon is NEVER spawned here (guardian job_launch owns it);
// only the proxy child speaks MCP stdio.
function fakeProxyBoundary({ proxyPid = 9102 } = {}) {
  const spawns = [];
  function spawn(command, args, options) {
    spawns.push({ command, args: [...args], options });
    const child = new EventEmitter();
    child.pid = proxyPid;
    child.exitCode = null;
    child.signalCode = null;
    const stdin = {
      written: [],
      write(line, encoding, callback) {
        if (typeof encoding === 'function') callback = encoding;
        stdin.written.push(String(line));
        if (callback) setImmediate(() => callback(null));
        setImmediate(() => autoRespond(String(line)));
        return true;
      },
      end() {
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
      if (child.exitCode === null) {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      }
      return true;
    };
    function autoRespond(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.method === 'notifications/initialized' || msg.id === undefined) return;
      const respond = (result) =>
        child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
      if (msg.method === 'initialize')
        respond({ protocolVersion: '2025-06-18', serverInfo: { name: 'cua-driver' } });
      else if (msg.method === 'tools/list') respond({ tools: [{ name: 'get_window_state' }] });
      else if (msg.method === 'tools/call') {
        const name = msg.params?.name;
        const a = msg.params?.arguments ?? {};
        if (name === 'get_window_state') {
          respond({
            content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }],
            structuredContent: {
              snapshot_id: 's00000001',
              elements: [{ element_index: 0, element_token: 's00000001:0', role: 'button' }],
              screenshot_width: 800,
              screenshot_height: 600,
              window_bounds: { x: 10, y: 20, width: 800, height: 600 },
              screenshot_mime_type: 'image/png',
            },
          });
        } else
          respond({
            content: [{ type: 'text', text: `ok:${name}` }],
            structuredContent: { effect: 'confirmed', route: 'accessibility' },
          });
      }
    }
    return child;
  }
  return { spawns, spawn };
}

function jobPathDriver({
  guardianVerbs,
  boundary,
  resolvePath = async () => 'C:\\fake\\cua-driver.exe',
  extra = {},
  readiness,
} = {}) {
  const guardian = fakeNativeGuardian({ job: guardianVerbs });
  const proxy = boundary ?? fakeProxyBoundary();
  const order = [];
  const readyProbe =
    readiness ??
    (async () => {
      order.push('ready');
      return { ready: true };
    });
  const driver = createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    sessionLabel: 'test-session',
    resolveCuaDriverPath: resolvePath,
    createTransport: (opts) => createCuaDriverTransport({ ...opts, spawnProcess: proxy.spawn }),
    createGuardian: async () => guardian,
    waitForDaemonFn: async (info) => {
      order.push('ready');
      return readyProbe(info);
    },
    defaultTimeoutMs: 1500,
    stopTimeoutMs: 300,
    ...extra,
  });
  return { driver, guardian, proxy, order };
}

test('production defaults are private unique per adapter over a fake process boundary', async () => {
  const first = jobPathDriver({});
  const second = jobPathDriver({});
  try {
    const a = await first.driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const b = await second.driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    assert.equal(a.frame.width, 800);
    assert.equal(b.frame.width, 800);
    const serveSpawns = [...first.proxy.spawns, ...second.proxy.spawns].filter((s) =>
      s.args.includes('serve'),
    );
    assert.equal(serveSpawns.length, 0, 'guardian job_launch owns the daemon; Node never spawns serve');
    const mcpA = first.proxy.spawns.find((s) => s.args.includes('mcp'));
    const mcpB = second.proxy.spawns.find((s) => s.args.includes('mcp'));
    assert.ok(mcpA && mcpB);
    const sockA = mcpA.args[mcpA.args.indexOf('--socket') + 1];
    const sockB = mcpB.args[mcpB.args.indexOf('--socket') + 1];
    assert.notEqual(sockA, sockB);
    const BS = String.fromCharCode(92);
    assert.ok(sockA.startsWith(BS + BS + '.' + BS + 'pipe' + BS), `actual Windows pipe prefix, got ${sockA}`);
    assert.ok(!sockA.toLowerCase().endsWith(BS + 'cua-driver'));
    const envA = mcpA.options.env;
    const envB = mcpB.options.env;
    assert.ok(envA.CUA_DRIVER_RS_HOME && envB.CUA_DRIVER_RS_HOME);
    assert.notEqual(envA.CUA_DRIVER_RS_HOME, envB.CUA_DRIVER_RS_HOME);
    assert.equal(envA.CUA_DRIVER_RS_UPDATE_CHECK, '0');
    assert.equal(envA.CUA_DRIVER_RS_TELEMETRY_ENABLED, '0');
    // Guardian launch saw the allowlisted env plus the same private socket.
    assert.equal(first.guardian.state.launched.length, 1);
    assert.deepEqual(first.guardian.state.launched[0].args, ['serve', '--socket', sockA]);
    assert.equal(first.guardian.state.launched[0].env.CUA_DRIVER_RS_HOME, envA.CUA_DRIVER_RS_HOME);
    assert.ok(!('CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS' in (first.guardian.state.launched[0].env || {})));
    assert.equal(first.guardian.state.adopted.length, 1);
    assert.equal(first.guardian.state.adopted[0].socketNonce, first.guardian.state.launched[0].nonce);
    assert.ok(
      sockA.includes(first.guardian.state.launched[0].nonce),
      'owned nonce is inside the spawned --socket string',
    );
  } finally {
    await first.driver.close().catch(() => {});
    await second.driver.close().catch(() => {});
  }
});

test('adopt refusal tears down before any handshake or tool', async () => {
  const { driver, guardian, proxy } = jobPathDriver({ guardianVerbs: { adoptRefused: true } });
  try {
    await assert.rejects(driver.request({ method: 'observe', params: { windowId: '844:10725' } }), {
      code: 'DRIVER_START',
    });
    const inits = proxy.spawns.length ? [] : [];
    void inits;
    assert.equal(guardian.state.kills.length, 1, 'refused adopt kills the launched job');
  } finally {
    await driver.close().catch(() => {});
  }
});

test('status aggregates guardian mutex/guard/hotkey truthfully and never spawns CUA', async () => {
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian({ hotkeyError: 0 }) };
  const driver = legacyDriver(fake);
  try {
    const status = await driver.request({ method: 'status', params: {} });
    assert.equal(status.backend, 'cua');
    assert.equal(status.mutex, true);
    assert.deepEqual(status.externalInputGuard, { supported: true, armed: false });
    assert.equal(status.hotkey, 'Ctrl+Alt+Shift+F10');
    assert.equal(status.hotkeyRegistered, true);
    assert.ok(!('hotkeyError' in status), 'numeric hotkeyError 0 is ignored');
    assert.equal(fake.transport.startCalls, 0);
  } finally {
    await driver.close();
  }
});

test('hotkey preflight fails closed on false or unknown registration', async () => {
  for (const shape of [{ hotkeyRegistered: false }, { hotkeyRegistered: undefined }]) {
    const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian(shape) };
    const driver = legacyDriver(fake);
    try {
      await assert.rejects(driver.request({ method: 'observe', params: {} }), {
        code: 'GUARDIAN_UNAVAILABLE',
      });
      assert.equal(fake.calls.length, 0, 'no CUA tool without a registered emergency hotkey');
    } finally {
      await driver.close();
    }
  }
  const numericZero = {
    ...fakeCuaTransport(),
    guardian: fakeNativeGuardian({ hotkeyRegistered: true, hotkeyError: 0 }),
  };
  const ok = legacyDriver(numericZero);
  numericZero.transport.callTool = async (name) => {
    if (name === 'get_window_state') return windowStateResult();
    return actionOk();
  };
  try {
    const observed = await ok.request({ method: 'observe', params: { windowId: '844:10725' } });
    assert.equal(observed.frame.width, 800);
  } finally {
    await ok.close();
  }
});

test('unsupported OS fails clearly and creates nothing', async () => {
  for (const [platform, arch, code] of [
    ['linux', 'x64', 'UNSUPPORTED_PLATFORM'],
    ['win32', 'arm64', 'UNSUPPORTED_ARCH'],
  ]) {
    let created = 0;
    const fake = fakeCuaTransport();
    const driver = createCuaComputerUseDriver({
      platform,
      arch,
      transport: fake.transport,
      createGuardian: async () => {
        created += 1;
        return fakeNativeGuardian();
      },
    });
    await assert.rejects(driver.request({ method: 'observe', params: {} }), { code });
    assert.equal(created, 0);
    assert.equal(fake.transport.startCalls, 0);
    await driver.close();
  }
});

test('invalid commands are rejected locally with zero guardian/CUA calls', async () => {
  const cases = [
    [{ method: 'dance', params: {} }, 'UNKNOWN_METHOD'],
    [{ method: 'act', params: { actions: [] } }, 'INVALID_PARAMS'],
    [
      { method: 'act', params: { actions: [{ type: 'click', x: 1, y: 1, deliveryMode: 'background' }] } },
      'INVALID_PARAMS',
    ],
    [
      { method: 'act', params: { actions: [{ type: 'click', x: 1, y: 1 }], deliveryMode: 'sideways' } },
      'INVALID_PARAMS',
    ],
    [
      { method: 'act', params: { actions: [{ type: 'click', x: 1, y: 1, modifier: ['ctrl'] }] } },
      'UNSUPPORTED_MODIFIER',
    ],
    [{ method: 'act', params: { actions: [{ type: 'warp', x: 1, y: 2 }] } }, 'INVALID_PARAMS'],
    [{ method: 'act', params: { actions: [{ type: 'click' }] } }, 'INVALID_PARAMS'],
    [
      {
        method: 'act',
        params: {
          actions: [
            {
              type: 'drag',
              x: 1,
              y: 1,
              path: [
                { x: 2, y: 2 },
                { x: 3, y: 3 },
              ],
            },
          ],
        },
      },
      'UNSUPPORTED_DRAG_PATH',
    ],
    [
      { method: 'observe', params: { region: { x: 0, y: 0, width: 10, height: 10 } } },
      'UNSUPPORTED_OBSERVE_REGION',
    ],
    [{ method: 'observe', params: { maxWidth: 8 } }, 'INVALID_PARAMS'],
    [{ method: 'observe', params: { displayId: 'secondary' } }, 'UNSUPPORTED_DISPLAY'],
    [{ method: 'inspect', params: {} }, 'INVALID_PARAMS'],
    [{ method: 'windows', params: { action: 'focus' } }, 'INVALID_PARAMS'],
  ];
  for (const [command, code] of cases) {
    const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
    const driver = legacyDriver(fake);
    await assert.rejects(driver.request(command), { code });
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.guardian.state.requests.length, 0);
    await driver.close();
  }
});

test('missing guardian and missing mutex/flag fail closed before any CUA tool', async () => {
  const missing = fakeCuaTransport();
  const driver = createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    transport: missing.transport,
    createGuardian: async () => null,
  });
  try {
    await assert.rejects(driver.request({ method: 'observe', params: {} }), { code: 'GUARDIAN_MISSING' });
    assert.equal(missing.calls.length, 0);
  } finally {
    await driver.close();
  }
  for (const shape of [
    { mutex: false, flag: true },
    { mutex: true, flag: false },
  ]) {
    const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian(shape) };
    const weak = legacyDriver(fake);
    try {
      await assert.rejects(weak.request({ method: 'observe', params: {} }), {
        code: 'GUARDIAN_CAPABILITY_MISSING',
      });
      assert.equal(fake.calls.length, 0);
    } finally {
      await weak.close();
    }
  }
});

test('real native factory integration: missing worker verbs fail closed, never duck-typed', async () => {
  const received = [];
  const child = new EventEmitter();
  child.pid = 7201;
  child.exitCode = null;
  child.signalCode = null;
  const stdin = {
    write(line, encoding, callback) {
      if (typeof encoding === 'function') callback = encoding;
      try {
        received.push(JSON.parse(String(line)));
      } catch {}
      if (callback) setImmediate(() => callback(null));
      const last = received[received.length - 1];
      setImmediate(() => {
        if (last?.method === 'status')
          child.stdout.emit(
            'data',
            `${JSON.stringify({ id: last.id, result: { supported: true, platform: 'win32' } })}\n`,
          );
        else if (last?.id !== undefined)
          child.stdout.emit('data', `${JSON.stringify({ id: last.id, result: {} })}\n`);
      });
      return true;
    },
    end() {
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
    if (child.exitCode === null) {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    }
    return true;
  };
  const native = createComputerUseDriver({
    platform: 'win32',
    spawnProcess: () => child,
    workerPath: 'C:\\fake\\computer-use-worker.ps1',
    startupTimeoutMs: 500,
    defaultTimeoutMs: 800,
    stopTimeoutMs: 200,
  });
  const fake = fakeCuaTransport();
  const driver = createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    transport: fake.transport,
    createGuardian: async () => native,
    defaultTimeoutMs: 800,
  });
  try {
    setImmediate(() => child.stdout.emit('data', `${JSON.stringify({ event: 'ready', pid: child.pid })}\n`));
    await assert.rejects(driver.request({ method: 'observe', params: {} }), {
      code: 'GUARDIAN_CAPABILITY_MISSING',
    });
    assert.equal(fake.calls.length, 0, 'no CUA tool may run without mutex+guard');
    assert.ok(received.map((line) => line.method).includes('status'), 'guardian addressed via request()');
  } finally {
    await driver.close().catch(() => {});
    await native.close().catch(() => {});
  }
});

test('windows list maps encoded ids; explicit focus uses bring_to_front and clears bindings', async () => {
  const seen = [];
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name, args = {}) => {
    seen.push({ name, args });
    if (name === 'list_windows') {
      return {
        result: {
          structuredContent: {
            windows: [
              {
                pid: 844,
                window_id: 10725,
                title: 'Front',
                app_name: 'App',
                bounds: { x: 0, y: 0, width: 800, height: 600 },
                z_index: 9,
                is_on_screen: true,
              },
              {
                pid: 844,
                window_id: 10726,
                title: 'Back',
                app_name: 'App',
                bounds: { x: 0, y: 0, width: 400, height: 300 },
                z_index: 2,
                is_on_screen: true,
              },
            ],
          },
        },
        timing: { durationMs: 1 },
      };
    }
    if (name === 'bring_to_front') {
      assert.equal(args.pid, 844);
      assert.equal(args.window_id, 10726);
      assert.ok(!('session' in args), 'bring_to_front schema carries no session');
      return {
        result: { structuredContent: { previous_fg_hwnd: 1, now_fg_hwnd: 10726 } },
        timing: { durationMs: 1 },
      };
    }
    if (name === 'get_window_state') return windowStateResult();
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    const listed = await driver.request({ method: 'windows', params: { action: 'list' } });
    assert.equal(listed.windows[0].id, '844:10725');
    assert.equal(listed.windows[0].foreground, true);
    const observed = await driver.request({ method: 'observe', params: { windowId: '844:10726' } });
    const focused = await driver.request({
      method: 'windows',
      params: { action: 'focus', windowId: '844:10726' },
    });
    assert.equal(focused.focused, true);
    assert.equal(focused.foregroundNow, 10726);
    await assert.rejects(
      driver.request({
        method: 'act',
        params: {
          actions: [{ type: 'click', x: 1, y: 1 }],
          expectedFrame: { driverFrame: observed.driverFrame },
        },
      }),
      { code: 'STALE_FRAME' },
    );
  } finally {
    await driver.close();
  }
});

test('observe returns image+frame with TOPLEVEL driverFrame plus bounded elements', async () => {
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name) => {
    if (name === 'get_window_state') return windowStateResult();
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    const observed = await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    assert.equal(observed.image.mimeType, 'image/png');
    assert.equal(observed.frame.width, 800);
    assert.deepEqual(observed.frame.bounds, { x: 10, y: 20, width: 800, height: 600 });
    assert.equal(observed.driverFrame.snapshotId, 's00000001');
    assert.equal(observed.elements[0].elementId, 's00000001:0');
    assert.equal(observed.truncated, false);
    assert.ok(!JSON.stringify(observed).includes('capture_id'));
  } finally {
    await driver.close();
  }
});

test('desktop observe is primary-only; native 4K refuses without rescaling', async () => {
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name) => {
    if (name === 'get_desktop_state') return desktopStateResult({ width: 3840, height: 2160 });
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    await assert.rejects(driver.request({ method: 'observe', params: {} }), { code: 'IMAGE_TOO_LARGE' });
  } finally {
    await driver.close();
  }
  const small = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  small.transport.callTool = async (name) => {
    if (name === 'get_desktop_state') return desktopStateResult();
    return actionOk();
  };
  const driver2 = legacyDriver(small);
  try {
    const observed = await driver2.request({ method: 'observe', params: { maxWidth: 800 } });
    assert.equal(observed.timing.maxWidthHonored, false);
  } finally {
    await driver2.close();
  }
});

test('inspect returns bounded AX without screenshot; same token acts', async () => {
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name, args = {}) => {
    if (name === 'get_window_state') {
      assert.equal(args.include_screenshot, false);
      return {
        result: {
          content: [{ type: 'text', text: 'tree' }],
          structuredContent: {
            snapshot_id: 's00000002',
            elements: [
              { element_index: 0, element_token: 's00000002:0', role: 'button', label: 'Save' },
              { element_index: 1, element_token: 's00000002:1', role: 'textField', label: 'Title' },
            ],
            window_bounds: { x: 0, y: 0, width: 800, height: 600 },
          },
        },
        timing: { durationMs: 1 },
      };
    }
    if (name === 'click') {
      assert.equal(args.element_token, 's00000002:0');
      assert.equal(args.delivery_mode, 'background');
      return actionOk('confirmed', 'accessibility');
    }
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    const inspected = await driver.request({ method: 'inspect', params: { windowId: '844:10725' } });
    assert.equal(inspected.elements[0].elementId, 's00000002:0');
    assert.equal(inspected.driverFrame.kind, 'accessibility');
    assert.ok(!('image' in inspected));
    const acted = await driver.request({
      method: 'act',
      params: {
        actions: [{ type: 'click', elementId: 's00000002:0' }],
        expectedFrame: { driverFrame: inspected.driverFrame },
      },
    });
    assert.equal(acted.executed, 1);
  } finally {
    await driver.close();
  }
});

test('AX-only frames reject pixels; stale tokens fail closed', async () => {
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name, args = {}) => {
    if (name === 'get_window_state') {
      const snap = args.include_screenshot === false ? 's00000003' : 's00000001';
      if (args.include_screenshot === false) {
        return {
          result: {
            content: [{ type: 'text', text: 't' }],
            structuredContent: {
              snapshot_id: snap,
              elements: [{ element_index: 0, element_token: `${snap}:0`, role: 'button' }],
              window_bounds: { x: 0, y: 0, width: 800, height: 600 },
            },
          },
          timing: { durationMs: 1 },
        };
      }
      return windowStateResult({ snapshot: snap });
    }
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    const inspected = await driver.request({ method: 'inspect', params: { windowId: '844:10725' } });
    await assert.rejects(
      driver.request({
        method: 'act',
        params: {
          actions: [{ type: 'click', x: 10, y: 10 }],
          expectedFrame: { driverFrame: inspected.driverFrame },
        },
      }),
      { code: 'AX_ONLY_FRAME' },
    );
    await assert.rejects(
      driver.request({
        method: 'act',
        params: {
          actions: [{ type: 'click', elementId: 's00000099:0' }],
          expectedFrame: { driverFrame: inspected.driverFrame },
        },
      }),
      { code: 'STALE_FRAME' },
    );
  } finally {
    await driver.close();
  }
});

test('act keeps screenshot-local coords and supports elementId plus empty-clear set_value', async () => {
  const seen = [];
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name, args = {}) => {
    seen.push({ name, args });
    if (name === 'get_window_state') return windowStateResult({ snapshot: 's0000000a' });
    if (name === 'click' || name === 'type_text' || name === 'set_value')
      return actionOk('confirmed', 'accessibility');
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    const observed = await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const acted = await driver.request({
      method: 'act',
      params: {
        actions: [
          { type: 'click', x: 400, y: 300 },
          { type: 'type', text: 'hello', elementId: 's0000000a:1' },
          { type: 'set_value', elementId: 's0000000a:1', value: '' },
        ],
        expectedFrame: { driverFrame: observed.driverFrame },
      },
    });
    assert.equal(acted.executed, 3);
    const click = seen.find((c) => c.name === 'click');
    assert.equal(click.args.x, 400);
    assert.equal(click.args.y, 300);
    assert.equal(click.args.delivery_mode, 'foreground');
    assert.equal(click.args.scope, 'window');
    const typeCall = seen.find((c) => c.name === 'type_text');
    assert.equal(typeCall.args.element_token, 's0000000a:1');
    assert.equal(
      typeCall.args.snapshot_id,
      's0000000a',
      'explicit snapshot_id rides with element_token per pinned schema',
    );
    const setValue = seen.find((c) => c.name === 'set_value');
    assert.equal(setValue.args.value, '');
    assert.ok(!('delivery_mode' in setValue.args), 'set_value schema takes no delivery knob');
  } finally {
    await driver.close();
  }
});

test('batch deliveryMode overrides defaults for applicable tools', async () => {
  const seen = [];
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name, args = {}) => {
    seen.push({ name, args });
    if (name === 'get_window_state') return windowStateResult({ snapshot: 's0000000b' });
    return actionOk('confirmed', 'accessibility');
  };
  const driver = legacyDriver(fake);
  try {
    const observed = await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    await driver.request({
      method: 'act',
      params: {
        actions: [{ type: 'click', x: 1, y: 1 }],
        deliveryMode: 'background',
        expectedFrame: { driverFrame: observed.driverFrame },
      },
    });
    assert.equal(seen.find((c) => c.name === 'click').args.delivery_mode, 'background');
  } finally {
    await driver.close();
  }
});

test('keypress/type/drag/scroll/wait map to verified tools; guardian arms exact held sets', async () => {
  const seen = [];
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name, args = {}) => {
    seen.push({ name, args });
    if (name === 'get_window_state') return windowStateResult({ snapshot: 's0000000b' });
    return actionOk('confirmed', 'accessibility');
  };
  const driver = legacyDriver(fake);
  try {
    const observed = await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const acted = await driver.request({
      method: 'act',
      params: {
        actions: [
          { type: 'keypress', keys: ['Enter'] },
          { type: 'keypress', keys: ['Control', 'c'] },
          { type: 'type', text: 'abc' },
          { type: 'set_value', elementId: 's0000000b:1', value: 'v' },
          { type: 'wait', ms: 5 },
          { type: 'drag', x: 10, y: 10, button: 'middle', path: [{ x: 20, y: 20 }] },
          { type: 'scroll', deltaY: -3, x: 100, y: 100 },
        ],
        expectedFrame: { driverFrame: observed.driverFrame },
      },
    });
    assert.equal(acted.executed, 7);
    assert.ok(seen.some((c) => c.name === 'press_key'));
    assert.ok(seen.some((c) => c.name === 'hotkey'));
    const drag = seen.find((c) => c.name === 'drag');
    assert.equal(drag.args.to_x, 20);
    const arms = fake.guardian.state.arms;
    // ponytail beta.7: hold-nothing actions (type/scroll/set_value) skip the
    // arm and ride the verified mutex; the native guard refuses empty arms.
    assert.equal(arms.length, 3, 'only held actions arm before dispatch');
    assert.deepEqual(arms[1], { buttons: [], keys: ['Control', 'c'] });
    assert.deepEqual(
      arms[2],
      { buttons: ['middle'], keys: [] },
      'drag arms its button (any button injects DOWN)',
    );
    assert.equal(fake.guardian.state.disarms, 3, 'every armed confirmed action disarms');
  } finally {
    await driver.close();
  }
});

test('first non-confirmed action stops the batch partial and preserves the arm', async () => {
  const seen = [];
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name, args = {}) => {
    seen.push({ name, args });
    if (name === 'get_window_state') return windowStateResult({ snapshot: 's0000000b' });
    if (name === 'click') {
      const n = seen.filter((c) => c.name === 'click').length;
      return n === 1 ? actionOk('confirmed', 'accessibility') : actionOk('unverifiable', 'accessibility');
    }
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    const observed = await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const acted = await driver.request({
      method: 'act',
      params: {
        actions: [
          { type: 'click', x: 1, y: 1 },
          { type: 'click', x: 2, y: 2 },
          { type: 'click', x: 3, y: 3 },
        ],
        expectedFrame: { driverFrame: observed.driverFrame },
      },
    });
    assert.equal(acted.partial, true);
    assert.equal(acted.executed, 1);
    assert.equal(acted.error.code, 'CUA_UNVERIFIABLE');
    assert.equal(seen.filter((c) => c.name === 'click').length, 2, 'third action never dispatched');
    assert.ok(
      fake.guardian.state.disarms < fake.guardian.state.arms.length,
      'arm preserved for cleanup after partial',
    );
  } finally {
    await driver.close();
  }
});

test('dual-axis scroll fans out; a second-dispatch failure returns partial', async () => {
  const seen = [];
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name, args = {}) => {
    seen.push({ name, args });
    if (name === 'get_window_state') return windowStateResult({ snapshot: 's0000000b' });
    if (name === 'scroll') {
      const n = seen.filter((c) => c.name === 'scroll').length;
      if (n === 1) return actionOk('confirmed', 'accessibility');
      return {
        result: {
          content: [{ type: 'text', text: 'no' }],
          isError: true,
          structuredContent: { code: 'background_unavailable' },
        },
        timing: { durationMs: 1 },
      };
    }
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    const observed = await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const acted = await driver.request({
      method: 'act',
      params: {
        actions: [{ type: 'scroll', deltaX: 4, deltaY: -3, x: 100, y: 100 }],
        expectedFrame: { driverFrame: observed.driverFrame },
      },
    });
    assert.equal(acted.partial, true);
    assert.equal(acted.executed, 0);
    assert.equal(acted.error.code, 'BACKGROUND_UNAVAILABLE');
    assert.equal(seen.filter((c) => c.name === 'scroll').length, 2);
  } finally {
    await driver.close();
  }
});

test('refused actions stop the batch without inventing executed', async () => {
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  let calls = 0;
  fake.transport.callTool = async (name) => {
    if (name === 'get_window_state') return windowStateResult({ snapshot: 's0000000c' });
    calls += 1;
    if (calls === 1) return actionOk('confirmed', 'accessibility');
    return {
      result: {
        content: [{ type: 'text', text: 'no' }],
        structuredContent: { effect: 'refused', route: 'accessibility' },
      },
      timing: { durationMs: 1 },
    };
  };
  const driver = legacyDriver(fake);
  try {
    const observed = await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const acted = await driver.request({
      method: 'act',
      params: {
        actions: [
          { type: 'click', x: 1, y: 1 },
          { type: 'click', x: 2, y: 2 },
          { type: 'click', x: 3, y: 3 },
        ],
        expectedFrame: { driverFrame: observed.driverFrame },
      },
    });
    assert.equal(acted.executed, 1);
    assert.equal(acted.partial, true);
    assert.equal(acted.error.code, 'CUA_REFUSED');
  } finally {
    await driver.close();
  }
});

test('window-frame move is refused; desktop move drives the real pointer', async () => {
  const seen = [];
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name, args = {}) => {
    seen.push({ name, args });
    if (name === 'get_window_state') return windowStateResult({ snapshot: 's0000000b' });
    if (name === 'get_desktop_state') return desktopStateResult();
    if (name === 'move_cursor') {
      assert.equal(args.scope, 'desktop');
      return actionOk('confirmed', 'global_input');
    }
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    const windowObserved = await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const before = seen.length;
    await assert.rejects(
      driver.request({
        method: 'act',
        params: {
          actions: [{ type: 'move', x: 10, y: 20 }],
          expectedFrame: { driverFrame: windowObserved.driverFrame },
        },
      }),
      { code: 'UNSUPPORTED_MOVE' },
    );
    assert.equal(seen.length, before, 'prevalidation fires before any dispatch');
    const desktopObserved = await driver.request({ method: 'observe', params: {} });
    const moved = await driver.request({
      method: 'act',
      params: {
        actions: [{ type: 'move', x: 100, y: 120 }],
        expectedFrame: { driverFrame: desktopObserved.driverFrame },
      },
    });
    assert.equal(moved.executed, 1);
  } finally {
    await driver.close();
  }
});

test('stop latches terminally: sync onStop, verified exit, single cleanup, no restart', async () => {
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name) => {
    if (name === 'get_window_state') return windowStateResult();
    return actionOk();
  };
  const order = [];
  let syncNotified = false;
  const driver = legacyDriver(fake, {
    onStop: () => {
      syncNotified = true;
      order.push('onStop');
    },
  });
  try {
    await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const first = driver.stop('user-test');
    assert.equal(syncNotified, true, 'manager notification lands synchronously before tree-exit await');
    const [a, b] = await Promise.all([first, driver.stop('user-test')]);
    assert.equal(a.stopped, true);
    assert.equal(a.treeExited, true);
    assert.equal(b.treeExited, true);
    assert.equal(
      fake.guardian.state.cleanups.length,
      1,
      'exactly-once cleanup shared across concurrent stops',
    );
    assert.deepEqual(fake.transport.stoppedReasons, ['user-test']);
    order.push('stopped');
    await assert.rejects(driver.request({ method: 'observe', params: { windowId: '844:10725' } }), {
      code: 'DRIVER_STOPPED',
    });
    assert.deepEqual(order, ['onStop', 'stopped']);
  } finally {
    await driver.close();
    assert.equal(fake.guardian.state.closes, 1, 'owned guardian closes after verified death+cleanup');
  }
});

test('unverified tree exit fails closed: guardian kept, uncertainty reported, retry works', async () => {
  const fake = { ...fakeCuaTransport({ stuckPids: [6301] }), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name) => {
    if (name === 'get_window_state') return windowStateResult();
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    // Guardian must exist for cleanup to be meaningful: observe first.
    await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const first = await driver.stop('stuck-test');
    assert.equal(first.stopped, false);
    assert.equal(first.treeExited, false);
    assert.equal(first.error.code, 'CUA_TREE_EXIT_FAILED');
    assert.equal(fake.guardian.state.cleanups.length, 0, 'no cleanup while CUA may be live');
    assert.equal(fake.guardian.state.closes, 0, 'guardian and mutex kept');
    fake.transport.clearStuck();
    const second = await driver.stop('stuck-test');
    assert.equal(second.stopped, true);
    assert.equal(second.treeExited, true);
    assert.equal(fake.guardian.state.cleanups.length, 1);
  } finally {
    await driver.close();
  }
});

test('close retries a failed kill and only then finishes guardian teardown', async () => {
  const fake = { ...fakeCuaTransport({ stuckPids: [6401] }), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name) => {
    if (name === 'get_window_state') return windowStateResult();
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    await assert.rejects(driver.close(), { code: 'CUA_TREE_EXIT_FAILED' });
    assert.equal(fake.guardian.state.closes, 0, 'no guardian close on unverified exit');
    await assert.rejects(
      driver.request({ method: 'observe', params: { windowId: '844:10725' } }),
      (error) => {
        assert.ok(['DRIVER_CLOSED', 'DRIVER_STOPPED'].includes(error.code));
        return true;
      },
    );
    fake.transport.clearStuck();
    await driver.close();
    assert.equal(fake.guardian.state.closes, 1);
  } finally {
    await driver.close().catch(() => {});
  }
});

test('failed guardian cleanup propagates: mutex kept, retry reruns cleanup', async () => {
  const guardian = fakeNativeGuardian();
  let attempts = 0;
  const realRequest = guardian.request.bind(guardian);
  guardian.request = async (command, opts) => {
    if (command?.method === 'cleanup_external_input') {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('cleanup did not complete');
        error.code = 'WORKER_ERROR';
        throw error;
      }
    }
    return realRequest(command, opts);
  };
  const fake = { ...fakeCuaTransport(), guardian };
  fake.transport.callTool = async (name) => {
    if (name === 'get_window_state') return windowStateResult();
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const first = await driver.stop('cleanup-test');
    assert.equal(first.stopped, false);
    assert.equal(first.error.code, 'WORKER_ERROR');
    assert.equal(guardian.state.closes, 0, 'guardian and mutex kept on unverified cleanup');
    const second = await driver.stop('cleanup-test');
    assert.equal(second.stopped, true, 'retry reruns the cleanup and verifies');
    assert.equal(second.treeExited, true);
    assert.equal(guardian.state.cleanups.length, 1);
  } finally {
    await driver.close().catch(() => {});
  }
});

test('guardian hotkey stop shares the shutdown path and reports the manager stop', async () => {
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name) => {
    if (name === 'get_window_state') return windowStateResult();
    return actionOk();
  };
  let seen = null;
  const driver = legacyDriver(fake, {
    onStop: (reason, event) => {
      seen = { reason, event };
    },
  });
  try {
    await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const result = await driver.handleSupervisorStop('guardian:hotkey');
    assert.equal(result.stopped, true);
    assert.equal(result.treeExited, true);
    assert.equal(seen.reason, 'guardian:hotkey');
    assert.equal(fake.guardian.state.cleanups.length, 1);
  } finally {
    await driver.close();
  }
});

test('job reconcile loss latches uncertainty: no fresh pair until proven', async () => {
  const { driver, guardian } = jobPathDriver({ guardianVerbs: { reconcileLost: true } });
  try {
    await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    await assert.rejects(driver.reconcile(), { code: 'JOB_UNCERTAIN' });
    assert.equal(guardian.state.reconciles.length, 1);
  } finally {
    await driver.close().catch(() => {});
  }
});

test('operation timing is exposed without speedup claims', async () => {
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name) => {
    if (name === 'get_window_state') return windowStateResult({ snapshot: 's0000000e' });
    if (name === 'click') return actionOk('confirmed', 'synthetic_events');
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    const observed = await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    assert.ok(observed.timing.durationMs >= 0);
    assert.ok(!JSON.stringify(observed).match(/speedup|faster/i));
    const acted = await driver.request({
      method: 'act',
      params: {
        actions: [{ type: 'click', x: 1, y: 1 }],
        expectedFrame: { driverFrame: observed.driverFrame },
      },
    });
    assert.ok(acted.timing.durationMs >= 0);
    assert.ok(!JSON.stringify(acted).match(/speedup|faster/i));
  } finally {
    await driver.close();
  }
});

test('C+D regression: stop during pending job_launch joins, kills, and never resurrects', async () => {
  const order = [];
  let resolveLaunch;
  let notifyEntered;
  const entered = new Promise((r) => {
    notifyEntered = r;
  });
  const gate = new Promise((r) => {
    resolveLaunch = r;
  });
  const guardian = fakeNativeGuardian();
  const realRequest = guardian.request.bind(guardian);
  let liveJob = false;
  guardian.request = async (command, opts) => {
    if (command?.method === 'job_launch') {
      notifyEntered();
      await gate;
      liveJob = true;
      order.push('launch-resolved');
      return realRequest(command, opts);
    }
    if (command?.method === 'job_kill') {
      const out = await realRequest(command, opts);
      liveJob = false;
      order.push('kill');
      return out;
    }
    if (command?.method === 'cleanup_external_input') {
      order.push('cleanup');
      return realRequest(command, opts);
    }
    return realRequest(command, opts);
  };
  guardian.close = async () => {
    order.push('guardian-close');
  };
  const driver = createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    sessionLabel: 'test-session',
    resolveCuaDriverPath: async () => 'C:\\fake\\cua-driver.exe',
    createTransport: () => {
      throw new Error('must not reach transport while launch pends');
    },
    createGuardian: async () => guardian,
    defaultTimeoutMs: 1500,
    stopTimeoutMs: 300,
  });
  try {
    const pending = driver.request({ method: 'windows', params: { action: 'list' } }).catch((e) => e.code);
    await entered;
    const stopping = driver.stop('probe');
    // Let the latch land and the shutdown join the in-flight launch, then
    // open the gate LATE: the launch must resolve into a stopping world.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    resolveLaunch();
    const stopped = await stopping;
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.treeExited, true);
    assert.equal(await pending, 'STOPPED');
    await driver.close();
    assert.equal(liveJob, false, 'no resurrection: the late launch was killed');
    assert.ok(order.includes('kill'), `kill ran, order=${order}`);
    assert.ok(order.includes('cleanup'), `cleanup ran after tree0, order=${order}`);
    assert.ok(order.indexOf('kill') < order.indexOf('cleanup'), `kill before cleanup, order=${order}`);
    assert.ok(
      order.indexOf('cleanup') < order.indexOf('guardian-close'),
      `guardian closes last, order=${order}`,
    );
    assert.ok(
      order.indexOf('launch-resolved') < order.indexOf('kill'),
      `no close before launch settles, order=${order}`,
    );
  } finally {
    resolveLaunch();
    await driver.close().catch(() => {});
  }
});

test('C variant: delayed factory failure tears down verified without resurrection', async () => {
  const guardian = fakeNativeGuardian();
  const driver = createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    sessionLabel: 'test-session',
    resolveCuaDriverPath: async () => 'C:\\fake\\cua-driver.exe',
    createTransport: () => {
      throw new Error('delayed factory boom');
    },
    createGuardian: async () => guardian,
    defaultTimeoutMs: 1500,
    stopTimeoutMs: 300,
  });
  // Hold the launch so the factory throw lands while a stop is in flight.
  const realRequest = guardian.request.bind(guardian);
  let gateLaunch;
  const launchGate = new Promise((r) => {
    gateLaunch = r;
  });
  guardian.request = async (command, opts) => {
    if (command?.method === 'job_launch') {
      await launchGate;
    }
    return realRequest(command, opts);
  };
  try {
    const pending = driver.request({ method: 'windows', params: { action: 'list' } }).catch((e) => e.code);
    await new Promise((r) => setTimeout(r, 20));
    const stopping = driver.stop('probe');
    gateLaunch();
    const stopped = await stopping;
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.treeExited, true);
    assert.equal(await pending, 'STOPPED');
    await driver.close();
    assert.equal(guardian.state.kills.length, 1, 'exactly one verified kill owns the teardown');
  } finally {
    gateLaunch();
    await driver.close().catch(() => {});
  }
});

test('D regression: concurrent closes after stop finalize exactly once', async () => {
  const counts = { transportClose: 0, guardianClose: 0 };
  const fake = fakeCuaTransport();
  const guardian = fakeNativeGuardian();
  const realClose = guardian.close.bind(guardian);
  guardian.close = async () => {
    counts.guardianClose += 1;
    return realClose();
  };
  const origClose = fake.transport.close.bind(fake.transport);
  fake.transport.close = async () => {
    counts.transportClose += 1;
    return origClose();
  };
  fake.transport.callTool = async (name) => {
    if (name === 'get_window_state') return windowStateResult();
    return actionOk();
  };
  const driver = createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    sessionLabel: 'test-session',
    transport: fake.transport,
    createGuardian: async () => guardian,
    defaultTimeoutMs: 1500,
    stopTimeoutMs: 300,
  });
  try {
    await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    await driver.stop('probe');
    await Promise.all([driver.close(), driver.close()]);
    assert.equal(counts.transportClose, 1, 'transport finalized exactly once');
    assert.equal(counts.guardianClose, 1, 'guardian finalized exactly once');
  } finally {
    await driver.close().catch(() => {});
  }
});

test('guardian acquisition is shared: parallel status creates once and closes once', async () => {
  let created = 0;
  const closed = [];
  const guardian = {
    state: { status: 0 },
    async request(command) {
      if (command?.method === 'status') {
        guardian.state.status += 1;
        return {
          supported: true,
          platform: 'win32',
          hotkey: 'h',
          hotkeyRegistered: true,
          mutex: true,
          externalInputGuard: { supported: true, armed: false },
        };
      }
      return {};
    },
    async stop(reason) {
      return { stopped: true, reason };
    },
    async close() {
      closed.push(++created === 1 ? 1 : 2);
    },
  };
  void created;
  let creations = 0;
  const driver = createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    sessionLabel: 'test-session',
    transport: fakeCuaTransport().transport,
    createGuardian: async () => {
      creations += 1;
      return guardian;
    },
    defaultTimeoutMs: 1500,
    stopTimeoutMs: 100,
  });
  try {
    const [a, b] = await Promise.all([
      driver.request({ method: 'status', params: {} }),
      driver.request({ method: 'status', params: {} }),
    ]);
    assert.equal(a.backend, 'cua');
    assert.equal(b.backend, 'cua');
    assert.equal(creations, 1, 'one shared acquisition for concurrent status');
    await driver.close();
    assert.equal(closed.length, 1, 'shared guardian closed exactly once');
  } finally {
    await driver.close().catch(() => {});
  }
});

test('late guardian arrival after stop+close is closed immediately, never dispatched', async () => {
  let release;
  let notifyEntered;
  const entered = new Promise((r) => {
    notifyEntered = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  const counts = { created: 0, status: 0, closed: [] };
  const lateGuardian = {
    async request(command) {
      if (command?.method === 'status') {
        counts.status += 1;
        return { mutex: true, externalInputGuard: true, hotkeyRegistered: true };
      }
      return {};
    },
    async close() {
      counts.closed.push('late');
    },
  };
  const driver = createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    sessionLabel: 'test-session',
    transport: fakeCuaTransport().transport,
    createGuardian: async () => {
      counts.created += 1;
      notifyEntered();
      await gate;
      return lateGuardian;
    },
    defaultTimeoutMs: 1500,
    stopTimeoutMs: 100,
  });
  try {
    // Status is read-only diagnostics outside the abortable active map:
    // it resolves late with truthful post-stop data instead of rejecting.
    const pending = driver.request({ method: 'status', params: {} }).catch((e) => e.code);
    await entered;
    const stopped = await driver.stop('test');
    assert.equal(stopped.stopped, true);
    await driver.close();
    const before = { created: counts.created, status: counts.status, closed: [...counts.closed] };
    release();
    const late = await pending;
    assert.equal(
      typeof late,
      'object',
      'in-flight status resolves truthfully, it is not fenced like mutations',
    );
    assert.equal(late.hotkeyNote, 'guardian-not-started');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(counts.created, 1);
    assert.equal(counts.status, 0, 'never dispatched on the late guardian');
    assert.deepEqual(counts.closed, ['late'], 'late arrival closed immediately');
    assert.deepEqual(before.closed, [], 'nothing closed before the late arrival');
    // No post-stop lazy creation even via status: count stays put.
    const after = await driver.request({ method: 'status', params: {} }).catch((e) => e.code);
    void after;
    assert.equal(counts.created, 1, 'status after stop creates nothing');
  } finally {
    release();
    await driver.close().catch(() => {});
  }
});

test('late arrival whose immediate close fails is retained and close stays retryable', async () => {
  let release;
  let notifyEntered;
  const entered = new Promise((r) => {
    notifyEntered = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  const counts = { created: 0, closes: 0, status: 0 };
  let closeFails = true;
  const lateGuardian = {
    async request(command) {
      if (command?.method === 'status') {
        counts.status += 1;
        return { mutex: true, externalInputGuard: true, hotkeyRegistered: true };
      }
      return {};
    },
    async close() {
      counts.closes += 1;
      if (closeFails) {
        const error = new Error('late close failed');
        error.code = 'WORKER_EXIT';
        throw error;
      }
    },
  };
  const driver = createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    sessionLabel: 'test-session',
    transport: fakeCuaTransport().transport,
    createGuardian: async () => {
      counts.created += 1;
      notifyEntered();
      await gate;
      return lateGuardian;
    },
    defaultTimeoutMs: 1500,
    stopTimeoutMs: 100,
  });
  try {
    const pending = driver.request({ method: 'status', params: {} }).catch((e) => e.code);
    await entered;
    await driver.stop('test');
    await driver.close().catch(() => {});
    release();
    await pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(counts.created, 1, 'no fresh guardian behind the poisoned join');
    assert.equal(counts.status, 0, 'never dispatched on the late guardian');
    assert.equal(counts.closes, 1, 'immediate close attempted exactly once');
    // The failed handle is retained, not lost: retry the close after repair.
    closeFails = false;
    await driver.close();
    assert.equal(counts.closes, 2, 'retry re-closes the retained instance');
  } finally {
    release();
    await driver.close().catch(() => {});
  }
});

test('status maps non-terminal acquisition failure distinctly, never masking', async () => {
  const driver = createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    sessionLabel: 'test-session',
    transport: fakeCuaTransport().transport,
    createGuardian: async () => {
      throw new Error('factory boom');
    },
    defaultTimeoutMs: 1500,
    stopTimeoutMs: 100,
  });
  try {
    const status = await driver.request({ method: 'status', params: {} });
    assert.equal(status.hotkeyRegistered, false);
    assert.equal(status.hotkeyNote, 'guardian-unavailable', 'not collapsed into guardian-not-started');
  } finally {
    await driver.close().catch(() => {});
  }
});

test('readiness runs launch < ready < spawn < adopt before handshake and first tool', async () => {
  const order = [];
  const guardian = fakeNativeGuardian();
  const realRequest = guardian.request.bind(guardian);
  guardian.request = async (command, opts) => {
    if (command?.method === 'job_launch') order.push('launch');
    if (command?.method === 'job_adopt') order.push('adopt');
    return realRequest(command, opts);
  };
  const proxy = fakeProxyBoundary();
  const origSpawn = proxy.spawn;
  proxy.spawn = (...args) => {
    order.push('spawn');
    return origSpawn(...args);
  };
  const driver = createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    sessionLabel: 'test-session',
    resolveCuaDriverPath: async () => 'C:\\fake\\cua-driver.exe',
    createTransport: (opts) => createCuaDriverTransport({ ...opts, spawnProcess: proxy.spawn }),
    createGuardian: async () => guardian,
    waitForDaemonFn: async () => {
      order.push('ready');
      return { ready: true };
    },
    defaultTimeoutMs: 1500,
    stopTimeoutMs: 300,
  });
  try {
    const observed = await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    assert.equal(observed.frame.width, 800, 'handshake then first tool completed');
    assert.deepEqual(order, ['launch', 'ready', 'spawn', 'adopt']);
  } finally {
    await driver.close().catch(() => {});
  }
});

test('stop during readiness aborts the wait and closes the proven job, never handshakes', async () => {
  let releaseReady;
  const readyGate = new Promise((r) => {
    releaseReady = r;
  });
  const seen = { handshake: 0, tools: 0 };
  const guardian = fakeNativeGuardian();
  const proxy = fakeProxyBoundary();
  const driver = createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    sessionLabel: 'test-session',
    resolveCuaDriverPath: async () => 'C:\\fake\\cua-driver.exe',
    createTransport: (opts) => {
      const t = createCuaDriverTransport({ ...opts, spawnProcess: proxy.spawn });
      const origHandshake = t.handshake.bind(t);
      t.handshake = async (...a) => {
        seen.handshake += 1;
        return origHandshake(...a);
      };
      const origCall = t.callTool.bind(t);
      t.callTool = async (...a) => {
        seen.tools += 1;
        return origCall(...a);
      };
      return t;
    },
    createGuardian: async () => guardian,
    waitForDaemonFn: async () => {
      await readyGate;
      return { ready: true };
    },
    defaultTimeoutMs: 1500,
    stopTimeoutMs: 300,
  });
  try {
    const pending = driver.request({ method: 'windows', params: { action: 'list' } }).catch((e) => e.code);
    await new Promise((r) => setTimeout(r, 30));
    const stopping = driver.stop('probe');
    await new Promise((r) => setImmediate(r));
    releaseReady();
    const stopped = await stopping;
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.treeExited, true);
    assert.equal(seen.handshake, 0, 'no handshake after an aborted readiness wait');
    assert.equal(seen.tools, 0, 'no tool dispatch after an aborted readiness wait');
    assert.equal(guardian.state.kills.length, 1, 'aborted readiness still closes the proven job');
    assert.equal(await pending, 'STOPPED');
    await driver.close();
  } finally {
    releaseReady();
    await driver.close().catch(() => {});
  }
});

test('beta.7 real native guard refuses empty held sets without spawning', async () => {
  // Real public boundary (no hand-rolled validator, no worker): actual
  // validateCommand rejects the empty arm locally, so nothing spawns.
  let spawns = 0;
  const native = createComputerUseDriver({
    platform: 'win32',
    spawnProcess: () => {
      spawns += 1;
      throw new Error('invalid arm must never spawn a worker');
    },
    workerPath: 'C:\\fake\\computer-use-worker.ps1',
    startupTimeoutMs: 500,
    defaultTimeoutMs: 500,
    stopTimeoutMs: 200,
  });
  try {
    await assert.rejects(
      native.request({ method: 'arm_external_input', params: { buttons: [], keys: [] } }),
      { code: 'INVALID_PARAMS' },
    );
    assert.equal(spawns, 0, 'empty arm rejected before any worker spawn');
  } finally {
    await native.close();
  }
});

test('beta.7 hold-nothing actions send no arm and still dispatch', async () => {
  // Adapter side of the same regression: type/scroll/set_value hold nothing,
  // so no arm is sent at all (the proof above shows an empty one would fail).
  const seen = [];
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name, args = {}) => {
    seen.push({ name, args });
    if (name === 'get_window_state') return windowStateResult({ snapshot: 's0000000c' });
    return actionOk('confirmed', 'accessibility');
  };
  const driver = legacyDriver(fake);
  try {
    const observed = await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const acted = await driver.request({
      method: 'act',
      params: {
        actions: [
          { type: 'type', text: 'Oxmo Puccino' },
          { type: 'scroll', deltaY: 4, x: 100, y: 100 },
          { type: 'set_value', elementId: 's0000000c:1', value: 'v' },
        ],
        expectedFrame: { driverFrame: observed.driverFrame },
      },
    });
    assert.equal(acted.executed, 3, 'hold-nothing batch dispatches without an arm');
    assert.equal(fake.guardian.state.arms.length, 0, 'no arm sent for hold-nothing actions');
    assert.ok(seen.some((c) => c.name === 'type_text'));
    assert.ok(seen.some((c) => c.name === 'scroll'));
    assert.ok(seen.some((c) => c.name === 'set_value'));
  } finally {
    await driver.close();
  }
});

test('beta.7 missing vendor effect stays fail-closed unverifiable, never confirmed', async () => {
  // Synthetic safety-net case only: observed sessions DO contain effect.
  // A response with no effect string must default fail-closed unverifiable
  // (stop the batch, no blind replay) and never upgrade to confirmed.
  const seen = [];
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name, args = {}) => {
    seen.push({ name, args });
    if (name === 'get_window_state') return windowStateResult({ snapshot: 's0000000d' });
    if (name === 'click') {
      return {
        result: {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { route: 'global_input', delivery: { mode: 'foreground' } },
        },
        timing: { durationMs: 1 },
      };
    }
    return actionOk();
  };
  const driver = legacyDriver(fake);
  try {
    const observed = await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const acted = await driver.request({
      method: 'act',
      params: {
        actions: [
          { type: 'click', x: 1, y: 1 },
          { type: 'click', x: 2, y: 2 },
        ],
        expectedFrame: { driverFrame: observed.driverFrame },
      },
    });
    assert.equal(acted.executed, 0);
    assert.equal(acted.partial, true);
    assert.equal(acted.error.code, 'CUA_UNVERIFIABLE');
    assert.equal(acted.results[0].effect, 'unverifiable');
    assert.equal(seen.filter((c) => c.name === 'click').length, 1, 'second action never dispatched');
  } finally {
    await driver.close();
  }
});

test('beta.7 skipped empty arm never clears a stale preserved arm', async () => {
  // Parent boundary: a hold-nothing confirmed action must not disarm a
  // previous uncertain arm; stale held inputs stay owned by stop/close
  // cleanup. Batch 1 leaves action[1] unverifiable with its arm preserved;
  // batch 2 (hold-nothing, confirmed) must leave arms/disarms untouched.
  const seen = [];
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name, args = {}) => {
    seen.push({ name, args });
    if (name === 'get_window_state') return windowStateResult({ snapshot: 's0000000e' });
    if (name === 'click') {
      const n = seen.filter((c) => c.name === 'click').length;
      return n === 1 ? actionOk('confirmed', 'accessibility') : actionOk('unverifiable', 'accessibility');
    }
    return actionOk('confirmed', 'accessibility');
  };
  const driver = legacyDriver(fake);
  try {
    const observed = await driver.request({ method: 'observe', params: { windowId: '844:10725' } });
    const first = await driver.request({
      method: 'act',
      params: {
        actions: [
          { type: 'click', x: 1, y: 1 },
          { type: 'click', x: 2, y: 2 },
        ],
        expectedFrame: { driverFrame: observed.driverFrame },
      },
    });
    assert.equal(first.partial, true);
    assert.equal(fake.guardian.state.arms.length, 2);
    assert.equal(fake.guardian.state.disarms, 1, 'second arm preserved after unverifiable');
    const second = await driver.request({
      method: 'act',
      params: {
        actions: [{ type: 'type', text: 'abc' }],
        expectedFrame: { driverFrame: observed.driverFrame },
      },
    });
    assert.equal(second.executed, 1);
    assert.equal(fake.guardian.state.arms.length, 2, 'skipped arm sends nothing new');
    assert.equal(fake.guardian.state.disarms, 1, 'stale preserved arm is not cleared');
  } finally {
    await driver.close();
  }
});

test('desktop actions never carry snapshot_id; the Studio-minted id is local binding only', async () => {
  const seen = [];
  const fake = { ...fakeCuaTransport(), guardian: fakeNativeGuardian() };
  fake.transport.callTool = async (name, args = {}) => {
    seen.push({ name, args });
    if (name === 'get_desktop_state') return desktopStateResult();
    return actionOk('confirmed', 'global_input');
  };
  const driver = legacyDriver(fake);
  try {
    const observed = await driver.request({ method: 'observe', params: {} });
    assert.ok(observed.driverFrame.snapshotId, 'local binding token exists for fencing');
    const acted = await driver.request({
      method: 'act',
      params: {
        actions: [{ type: 'click', x: 10, y: 10 }],
        expectedFrame: { driverFrame: observed.driverFrame },
      },
    });
    assert.equal(acted.executed, 1);
    const click = seen.find((c) => c.name === 'click');
    assert.ok(!('snapshot_id' in click.args), 'no driver-proof claim on desktop pixels');
    assert.ok(!('element_token' in click.args));
  } finally {
    await driver.close();
  }
});
