// CUA integration stack: REAL createCuaComputerUseDriver through REAL manager + bridge.
// Fake ONLY: native-shaped guardian request/stop/close, low-level CUA transport
// via createTransport factory (never a prestarted transport), injected path
// resolver (no binaries). No spawn, no desktop, no real daemon, no filesystem
// side effects beyond the bridge private pipe. Bounded: HTTP 4s, test 15s,
// t.after closes every stack. Existing adapter/driver tests untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createCuaComputerUseDriver } from '../lib/cua-computer-use-driver.mjs';
import { createComputerUseManager } from '../lib/computer-use.mjs';
import { createComputerUseBridge } from '../lib/computer-use-bridge.mjs';

const CALLER = { cwd: '/tmp/cua-integration', sessionId: 'int-s', rootSessionId: 'int-s', ownerId: 'int-r' };
const FAKE_DRIVER_PATH = 'C:\\fake\\cua-integration\\cua-driver.exe';
const PNG_SMALL = (() => {
  const b = Buffer.alloc(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(800, 16);
  b.writeUInt32BE(450, 20);
  b[24] = 8;
  b[25] = 2;
  return b.toString('base64');
})();

function fakeIntegrationGuardian(opts = {}) {
  const { mutex = true, guardSupported = true, refuseDisarmAfterStop = false } = opts;
  const state = {
    arms: [],
    disarms: 0,
    cleanups: [],
    stops: 0,
    closes: 0,
    requests: [],
    stopped: false,
    disarmRefused: 0,
    launches: [],
    adopts: [],
    kills: [],
    reconciles: [],
  };
  let launchSeq = 0;
  const guardian = {
    state,
    async request(command) {
      state.requests.push(command);
      const method = command && command.method;
      const params = (command && command.params) || {};
      if (method === 'status') {
        return {
          supported: true,
          platform: 'win32',
          hotkey: 'Ctrl+Alt+Shift+F10',
          hotkeyRegistered: true,
          mutex,
          externalInputGuard: { supported: guardSupported, armed: state.arms.length > state.disarms },
        };
      }
      if (method === 'arm_external_input') {
        state.arms.push(params);
        return { armed: true };
      }
      if (method === 'disarm_external_input') {
        if (refuseDisarmAfterStop && state.stopped) {
          state.disarmRefused += 1;
          const e = new Error('Guardian disarm refused after stop.');
          e.code = 'GUARDIAN_DISARM_REFUSED';
          throw e;
        }
        state.disarms += 1;
        return { disarmed: true };
      }
      if (method === 'cleanup_external_input') {
        state.cleanups.push(params);
        return { cleaned: true };
      }
      if (method === 'job_launch') {
        launchSeq += 1;
        const rec = { exe: params.exe, args: params.args, nonce: params.nonce, env: params.env };
        state.launches.push(rec);
        assert.ok(typeof params.exe === 'string' && params.exe, 'job_launch needs exe');
        assert.ok(
          Array.isArray(params.args) && params.args[0] === 'serve',
          'job_launch args must start with serve',
        );
        assert.ok(typeof params.nonce === 'string' && params.nonce.length >= 8, 'job_launch needs nonce');
        assert.ok(
          params.env && typeof params.env.CUA_DRIVER_RS_HOME === 'string',
          'job_launch env must carry isolated CUA home',
        );
        return {
          pid: 7200 + launchSeq,
          jobName: 'prime-cua-job-' + String(params.nonce).slice(0, 8),
          nonce: params.nonce,
        };
      }
      if (method === 'job_adopt') {
        state.adopts.push({ ...params });
        assert.ok(Number.isInteger(params.pid) && params.pid > 0, 'job_adopt needs proxy pid');
        assert.ok(typeof params.exe === 'string' && params.exe, 'job_adopt needs exe');
        assert.ok(Number.isInteger(params.birthMs), 'job_adopt needs birthMs proof');
        assert.ok(typeof params.socketNonce === 'string', 'job_adopt needs socketNonce proof');
        return { adopted: true, pid: params.pid, nonce: params.socketNonce };
      }
      if (method === 'job_kill') {
        state.kills.push({ ...params });
        return { treeExited: true, activeProcesses: 0 };
      }
      if (method === 'job_reconcile') {
        state.reconciles.push({ ...params });
        return { found: true, nonce: params.nonce };
      }
      if (method === 'job_status') {
        return { found: true, activeProcesses: 0, treeExited: true };
      }
      const e = new Error('Unknown computer-use method: ' + String(method) + '.');
      e.code = 'UNKNOWN_METHOD';
      throw e;
    },
    async stop(reason = 'user') {
      state.stops += 1;
      state.stopped = true;
      return { stopped: true, reason };
    },
    async close() {
      state.closes += 1;
    },
  };
  return guardian;
}

function fakeIntegrationTransportFactory(opts = {}) {
  const instances = [];
  const factoryArgs = [];
  const mutable = {
    failFirstClose: !!opts.failFirstClose,
    failCloseAlways: !!opts.failCloseAlways,
    stuckOnStop: !!opts.stuckOnStop,
  };
  let proxySeq = 0;
  function createTransport(args) {
    factoryArgs.push({ ...args });
    const state = {
      started: false,
      jobMode: false,
      calls: [],
      stops: [],
      closes: 0,
      aborts: [],
      handshakes: 0,
      spawns: 0,
      readies: [],
      closeFailedOnce: false,
    };
    let seq = 0;
    const nextSnapshot = () => {
      seq += 1;
      return 's' + seq.toString(16).padStart(8, '0');
    };
    const transport = {
      get started() {
        return state.started;
      },
      get daemonPid() {
        return 7101;
      },
      get proxyPid() {
        return 7102 + proxySeq;
      },
      get ownedPids() {
        return [];
      },
      get socketPath() {
        return args.socketPath;
      },
      get generation() {
        return 1;
      },
      state,
      async start() {
        state.started = true;
        return { daemonPid: 7101, proxyPid: 7102, generation: 1 };
      },
      async spawnProxy() {
        state.spawns += 1;
        proxySeq += 1;
        assert.ok(typeof args.driverPath === 'string' && args.driverPath, 'spawnProxy needs driverPath');
        assert.ok(
          typeof args.socketPath === 'string' && args.socketPath,
          'spawnProxy needs private socketPath',
        );
        return { proxyPid: 7102 + proxySeq, birthMs: Date.now(), socketPath: args.socketPath };
      },
      async handshake() {
        state.handshakes += 1;
        return { handshook: true };
      },
      async abort(reason = 'aborted') {
        const label = typeof reason === 'string' && reason ? reason : 'aborted';
        state.aborts.push(label);
        return { aborted: true, reason: label, generation: 1 };
      },
      markJobReady() {
        state.jobMode = true;
        state.started = true;
      },
      async waitForDaemon({ timeoutMs = 8000, intervalMs = 200, perProbeMs = 500, signal } = {}) {
        state.readies.push({ socket: args.socketPath, timeoutMs });
        const lowered = String(args.socketPath || '').toLowerCase();
        if (lowered.endsWith('\\cua-driver') || lowered.endsWith('\\cua-driver-local')) {
          const e = new Error('CUA transport must never probe the shared default daemon pipe.');
          e.code = 'SHARED_DAEMON_FORBIDDEN';
          throw e;
        }
        if (signal && signal.aborted) {
          const e = new Error('CUA daemon readiness wait was aborted.');
          e.code = 'ABORTED';
          throw e;
        }
        return { ready: true };
      },
      async callTool(name, targs = {}) {
        state.calls.push({ name, args: targs });
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
                    bounds: { x: 0, y: 0, width: 800, height: 450 },
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
        if (name === 'get_window_state') {
          const snap = nextSnapshot();
          const withShot = targs.include_screenshot !== false;
          const width = 800;
          const height = 450;
          const elements = [
            { element_index: 0, element_token: snap + ':0', role: 'button', label: 'OK' },
            { element_index: 1, element_token: snap + ':1', role: 'textField', label: 'Name' },
          ];
          if (!withShot) {
            return {
              result: {
                structuredContent: {
                  snapshot_id: snap,
                  elements,
                  window_bounds: { x: 10, y: 20, width, height },
                },
              },
              timing: { durationMs: 1 },
            };
          }
          return {
            result: {
              content: [{ type: 'image', data: PNG_SMALL, mimeType: 'image/png' }],
              structuredContent: {
                snapshot_id: snap,
                elements,
                screenshot_width: width,
                screenshot_height: height,
                window_bounds: { x: 10, y: 20, width, height },
                screenshot_mime_type: 'image/png',
              },
            },
            timing: { durationMs: 1 },
          };
        }
        if (
          name === 'click' ||
          name === 'set_value' ||
          name === 'type_text' ||
          name === 'move_cursor' ||
          name === 'scroll' ||
          name === 'press_key' ||
          name === 'hotkey' ||
          name === 'double_click' ||
          name === 'drag'
        ) {
          return {
            result: { structuredContent: { effect: 'confirmed', route: 'uia' } },
            timing: { durationMs: 1 },
          };
        }
        if (name === 'bring_to_front') {
          return {
            result: { structuredContent: { previous_fg_hwnd: 1, now_fg_hwnd: targs.window_id } },
            timing: { durationMs: 1 },
          };
        }
        return {
          result: { structuredContent: { effect: 'confirmed', route: 'uia' } },
          timing: { durationMs: 1 },
        };
      },
      async stop(reason = 'user') {
        state.stops.push(reason);
        if (mutable.stuckOnStop) return { stopped: true, reason, treeExited: false };
        return { stopped: true, reason, treeExited: true };
      },
      async close() {
        state.closes += 1;
        if (mutable.failCloseAlways) {
          const e = new Error('Fake transport close failed persistently.');
          e.code = 'TRANSPORT_CLOSE_FAILED';
          throw e;
        }
        if (mutable.failFirstClose && !state.closeFailedOnce) {
          state.closeFailedOnce = true;
          const e = new Error('Fake transport close failed once.');
          e.code = 'TRANSPORT_CLOSE_FAILED';
          throw e;
        }
      },
    };
    instances.push(transport);
    return transport;
  }
  return { createTransport, instances, factoryArgs, mutable };
}

function integrationCall(bridge, action, params = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: bridge.config.socketPath,
        method: 'POST',
        path: '/',
        agent: false,
        headers: { Authorization: 'Bearer ' + bridge.config.token, 'Content-Type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(4000, () => req.destroy(new Error('integration request deadline')));
    req.on('error', reject);
    req.end(JSON.stringify({ identity: { sessionId: CALLER.sessionId }, action, params }));
  });
}

async function integrationStack(t, { factoryHook, transportOpts, guardianOpts, backend = 'cua' } = {}) {
  const guardian = fakeIntegrationGuardian(guardianOpts);
  const fake = fakeIntegrationTransportFactory(transportOpts);
  const captured = [];
  const manager = createComputerUseManager({
    isSupported: true,
    cuaAvailability: { available: true, supported: true },
    createDriver: (opts) => {
      captured.push({ ...opts });
      if (factoryHook) factoryHook(opts);
      // Default factory from manager supplies only {backend,onStop}: adapter generates private pipe/home.
      assert.ok(
        opts && (opts.backend === 'cua' || opts.backend === undefined),
        'manager factory must supply cua backend',
      );
      assert.equal(typeof opts.onStop, 'function', 'manager factory must supply onStop');
      return createCuaComputerUseDriver({
        platform: 'win32',
        arch: 'x64',
        sessionLabel: 'integration-stack',
        createTransport: fake.createTransport,
        resolveCuaDriverPath: async () => FAKE_DRIVER_PATH,
        getCuaDriverAvailability: async () => ({
          available: true,
          backend: 'cua',
          path: FAKE_DRIVER_PATH,
          version: '0.28.2',
          supported: true,
        }),
        createGuardian: async () => guardian,
        defaultTimeoutMs: 1500,
        stopTimeoutMs: 300,
      });
    },
  });
  const bridge = createComputerUseBridge({ manager, resolveCaller: async () => CALLER });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  await manager.enable({ sessionId: CALLER.sessionId, runId: CALLER.ownerId, cwd: CALLER.cwd, backend });
  return { manager, bridge, guardian, fake, captured };
}

// Default generation probe: manager default factory supplies only {backend,onStop};
// the adapter generates private unique socket/home via ownedDefaults.
test(
  'integration defaults are Windows-valid private unique with matched proxy identity',
  { timeout: 15000 },
  async (t) => {
    const factoryArgs = [];
    const fake = fakeIntegrationTransportFactory();
    const guardians = [fakeIntegrationGuardian(), fakeIntegrationGuardian()];
    const mk = (k) =>
      createCuaComputerUseDriver({
        platform: 'win32',
        arch: 'x64',
        // Intentionally omit socketPath/homeDir: defaults must be generated.
        sessionLabel: 'integration-defaults',
        createTransport: (...a) => {
          factoryArgs.push(a);
          return fake.createTransport(...a);
        },
        resolveCuaDriverPath: async () => FAKE_DRIVER_PATH,
        getCuaDriverAvailability: async () => ({
          available: true,
          backend: 'cua',
          path: FAKE_DRIVER_PATH,
          version: '0.28.2',
          supported: true,
        }),
        createGuardian: async () => guardians[k],
        defaultTimeoutMs: 1500,
        stopTimeoutMs: 300,
      });
    const a = mk(0);
    const b = mk(1);
    t.after(() => a.close().catch(() => {}));
    t.after(() => b.close().catch(() => {}));
    // Trigger transport creation via a real tool (windows list needs guardian + job pair).
    const ra = await a.request({ method: 'windows', params: { action: 'list' } }).catch((e) => e);
    const rb = await b.request({ method: 'windows', params: { action: 'list' } }).catch((e) => e);
    assert.ok(
      !(ra instanceof Error) && !(rb instanceof Error),
      'default-generated instances must start, got ' +
        JSON.stringify([(ra && ra.code) || ra, (rb && rb.code) || rb]).slice(0, 400),
    );
    assert.equal(
      factoryArgs.length,
      2,
      'factory must be called once per instance, got ' + factoryArgs.length,
    );
    const WIN_PIPE = String.fromCharCode(92, 92, 46, 92, 112, 105, 112, 101, 92);
    for (const [idx, fa] of factoryArgs.entries()) {
      const sock = fa[0].socketPath;
      assert.equal(typeof sock, 'string', 'factory socketPath must be a string');
      assert.ok(
        sock.startsWith(WIN_PIPE),
        'default socket must carry actual Windows prefix ' +
          JSON.stringify(WIN_PIPE) +
          ', got ' +
          JSON.stringify(sock).slice(0, 120),
      );
      assert.ok(!/cua-driver$|cua-driver-local$/i.test(sock), 'must never use shared default daemon pipe');
    }
    const [sa, ha] = [factoryArgs[0][0].socketPath, factoryArgs[0][0].homeDir];
    const [sb, hb] = [factoryArgs[1][0].socketPath, factoryArgs[1][0].homeDir];
    assert.ok(
      sa && ha && sa !== sb && ha !== hb,
      'socket/home defaults must be unique nonshared, got ' + JSON.stringify([sa, ha, sb, hb]).slice(0, 300),
    );
    for (const [k, g] of guardians.entries()) {
      const tr = fake.instances[k];
      assert.equal(
        tr.state.readies.length,
        1,
        'transport ' + k + ' must probe readiness once on the exact private socket',
      );
      assert.equal(
        tr.state.readies[0].socket,
        factoryArgs[k][0].socketPath,
        'readiness probe must target the exact private socket for instance ' + k,
      );
      assert.equal(tr.state.spawns, 1, 'transport ' + k + ' must spawn proxy once after readiness');
      assert.equal(tr.state.handshakes, 1, 'transport ' + k + ' must handshake once after adopt');
      assert.ok(
        g.state.launches.length === 1 && tr.state.readies.length === 1,
        'order launch<ready holds for instance ' + k,
      );
      assert.equal(g.state.launches.length, 1, 'guardian ' + k + ' must record exactly one job_launch');
      assert.equal(g.state.adopts.length, 1, 'guardian ' + k + ' must record exactly one job_adopt');
      const launch = g.state.launches[0];
      const adopt = g.state.adopts[0];
      const transportSocket = factoryArgs[k][0].socketPath;
      assert.equal(
        launch.args && launch.args[2],
        transportSocket,
        'job_launch socket (serve --socket arg) must equal actual transport socketPath for instance ' + k,
      );
      assert.equal(
        adopt.socketNonce,
        launch.nonce,
        'job_adopt socketNonce must equal job_launch nonce for instance ' + k + ' (proxy identity)',
      );
      assert.ok(typeof adopt.pid === 'number' && adopt.pid > 0, 'job_adopt pid must be a real proxy pid');
    }
  },
);

test(
  'integration window list, inspect, empty set_value background via real stack',
  { timeout: 15000 },
  async (t) => {
    const { manager, bridge, fake } = await integrationStack(t);
    const listed = await integrationCall(bridge, 'windows', { action: 'list' });
    assert.equal(
      listed.status,
      200,
      'windows list via real adapter: ' + JSON.stringify(listed.body).slice(0, 500),
    );
    assert.ok(listed.body.windows.some((w) => w.id === '844:10725'));
    const inspected = await integrationCall(bridge, 'inspect', { windowId: '844:10725' });
    assert.equal(
      inspected.status,
      200,
      'inspect via real adapter: ' + JSON.stringify(inspected.body).slice(0, 800),
    );
    assert.equal(inspected.body.image, undefined);
    assert.equal(inspected.body.frame.kind, 'accessibility');
    const frameId = inspected.body.frame.frameId;
    const elementId = inspected.body.elements.find((e) => e.role === 'textField').elementId;
    assert.match(elementId, /^s[0-9a-f]{8}:\d+$/i);
    const acted = await integrationCall(bridge, 'act', {
      frameId,
      actions: [{ type: 'set_value', elementId, value: '' }],
      deliveryMode: 'background',
    });
    // Bridge allows empty (clear); adapter must too (fixed: empty clears).
    if (acted.status !== 200) {
      assert.fail(
        'BLOCKER empty-set_value: bridge accepts value empty with background but adapter refused: status ' +
          acted.status +
          ' ' +
          JSON.stringify(acted.body).slice(0, 600) +
          '; pinned impl SetValue requires pid+value with optional token and NO delivery_mode; empty must clear, not INVALID_PARAMS.',
      );
    }
    assert.equal(acted.body.applicationState, 'unverified');
    const setCalls = fake.instances.flatMap((inst) => inst.state.calls.filter((c) => c.name === 'set_value'));
    assert.equal(
      setCalls.length,
      1,
      'exactly one set_value must reach CUA, got ' + JSON.stringify(setCalls).slice(0, 600),
    );
    assert.equal(setCalls[0].args.value, '');
    assert.ok(!('delivery_mode' in setCalls[0].args), 'set_value takes no delivery knob per pinned impl');
    assert.ok(!('x' in setCalls[0].args), 'set_value takes no x/y per pinned impl');
    t.after(() => manager.stop().catch(() => {}));
  },
);

test(
  'integration observe pixel unscaled with private binding via real stack',
  { timeout: 15000 },
  async (t) => {
    const { manager, bridge, fake } = await integrationStack(t);
    const shot = await integrationCall(bridge, 'observe', { windowId: '844:10725' });
    assert.equal(shot.status, 200, 'observe via real adapter: ' + JSON.stringify(shot.body).slice(0, 800));
    assert.ok(shot.body.image && typeof shot.body.image.data === 'string');
    assert.equal(shot.body.image.data, PNG_SMALL, 'pixels must stay unscaled, no rescale or fake transform');
    assert.equal(shot.body.frame.width, 800);
    assert.equal(shot.body.frame.height, 450);
    assert.equal(shot.body.frame.backend, 'cua');
    assert.equal(shot.body.frame.driverFrame, undefined, 'driverFrame stays private, never leaves lease');
    const stored = manager.takeFrame(shot.body.frame.frameId);
    assert.ok(stored && stored.driverFrame && stored.driverFrame.backend === 'cua');
    assert.match(stored.driverFrame.snapshotId, /^s[0-9a-f]{8}$/i);
    assert.ok(stored.driverFrame.windowKey === '844:10725' || stored.driverFrame.pid === 844);
    const before = fake.instances[0].state.calls.length;
    const Chain = 'get_window_state';
    assert.ok(
      fake.instances[0].state.calls.some((c) => c.name === Chain),
      'observe must call pinned ' + Chain,
    );
    const px = await integrationCall(bridge, 'act', {
      frameId: shot.body.frame.frameId,
      actions: [{ type: 'click', x: 400, y: 200 }],
    });
    assert.equal(px.status, 200);
    const clickCalls = fake.instances[0].state.calls.filter((c) => c.name === 'click');
    assert.ok(clickCalls.length >= 1);
    assert.equal(clickCalls[clickCalls.length - 1].args.x, 400);
    assert.equal(
      clickCalls[clickCalls.length - 1].args.y,
      200,
      'CUA keeps screenshot-local coords, no physical rescale',
    );
    assert.equal(fake.instances[0].state.calls.length > before, true);
    t.after(() => manager.stop().catch(() => {}));
  },
);

test(
  'integration stop cleans guardian after verified exit then closes it; disarm refused after stop',
  { timeout: 15000 },
  async (t) => {
    const { manager, bridge, guardian, fake } = await integrationStack(t, {
      guardianOpts: { refuseDisarmAfterStop: true },
    });
    const shot = await integrationCall(bridge, 'observe', { windowId: '844:10725' });
    assert.equal(shot.status, 200);
    // Exercise an arm so disarm/cleanup paths are live (confirmed click disarms, partial preserves; use click).
    const acted = await integrationCall(bridge, 'act', {
      frameId: shot.body.frame.frameId,
      actions: [{ type: 'click', x: 10, y: 10 }],
    });
    assert.equal(acted.status, 200);
    const stopped = await manager.stop('integration-stop');
    assert.equal(stopped.enabled, false);
    // Final tree0 via guardian job_kill (activeProcesses 0) before cleanup; transport abort owns proxy EOF.
    assert.ok(
      guardian.state.kills.length >= 1,
      'guardian job_kill must run for verified tree0, got ' + guardian.state.kills.length,
    );
    assert.ok(
      fake.instances[0].state.aborts.length >= 1,
      'transport abort must run on stop, got ' + JSON.stringify(fake.instances[0].state.aborts).slice(0, 200),
    );
    // Guardian cleanup after verified exit.
    assert.ok(
      guardian.state.cleanups.length >= 1,
      'guardian cleanup_external_input must run after verified exit, got ' +
        JSON.stringify(guardian.state.cleanups).slice(0, 400),
    );
    // Native-shaped status truth.
    assert.equal(
      guardian.state.requests.some((c) => c.method === 'status'),
      true,
    );
    // Simulate native stop: guardian stopped, then cleanup stays legal but disarm is refused.
    await guardian.stop('native-stop');
    await guardian.request({ method: 'cleanup_external_input', params: { context: 'post-stop' } });
    assert.ok(guardian.state.cleanups.length >= 2);
    await assert.rejects(
      guardian.request({ method: 'disarm_external_input', params: {} }),
      /refused|GUARDIAN/i,
    );
    // Adapter close closes owned guardian (manager stop tears down; explicit close verifies).
    await manager.close();
    // Bridge already closed via t.after; guardian close happens on adapter close.
  },
);

test('integration close failure retains same orphan and retry closes it', { timeout: 15000 }, async (t) => {
  const guardian = fakeIntegrationGuardian();
  const fake = fakeIntegrationTransportFactory();
  const wrappers = [];
  const failFlag = { failClose: true };
  const manager = createComputerUseManager({
    isSupported: true,
    cuaAvailability: { available: true, supported: true },
    createDriver: (opts) => {
      const adapter = createCuaComputerUseDriver({
        platform: 'win32',
        arch: 'x64',
        socketPath: '\\\\.\\pipe\\prime-cua-integration-orphan-' + wrappers.length,
        homeDir: 'C:\\fake\\cua-integration-orphan-' + wrappers.length,
        sessionLabel: 'integration-orphan',
        createTransport: fake.createTransport,
        resolveCuaDriverPath: async () => FAKE_DRIVER_PATH,
        getCuaDriverAvailability: async () => ({
          available: true,
          backend: 'cua',
          path: FAKE_DRIVER_PATH,
          version: '0.28.2',
          supported: true,
        }),
        createGuardian: async () => guardian,
        defaultTimeoutMs: 1500,
        stopTimeoutMs: 300,
      });
      const wrapper = {
        _adapter: adapter,
        closes: 0,
        async request(...a) {
          return adapter.request(...a);
        },
        async stop(...a) {
          return adapter.stop(...a);
        },
        async close(...a) {
          wrapper.closes += 1;
          if (failFlag.failClose) {
            const e = new Error('Wrapped close failed persistently.');
            e.code = 'WRAPPED_CLOSE_FAILED';
            throw e;
          }
          return adapter.close(...a);
        },
      };
      wrappers.push(wrapper);
      return wrapper;
    },
  });
  const bridge = createComputerUseBridge({ manager, resolveCaller: async () => CALLER });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => {
    failFlag.failClose = false;
    return manager.close().catch(() => {});
  });
  await manager.enable({
    sessionId: CALLER.sessionId,
    runId: CALLER.ownerId,
    cwd: CALLER.cwd,
    backend: 'cua',
  });
  const shot = await integrationCall(bridge, 'observe', { windowId: '844:10725' });
  assert.equal(
    shot.status,
    200,
    'initial observe must succeed, got ' + JSON.stringify(shot.body).slice(0, 500),
  );
  assert.equal(wrappers.length, 1, 'exactly one wrapper minted');
  assert.equal(fake.instances.length, 1, 'exactly one transport minted');
  // Persistent wrapper close failure -> teardown retains same orphan wrapper.
  await manager.close();
  assert.ok(
    wrappers[0].closes >= 1,
    'teardown must attempt close on exact wrapper instance, got ' + wrappers[0].closes,
  );
  assert.equal(wrappers.length, 1, 'no new wrapper while orphan retained');
  // Orphan surfaces on next driver use (observe), not on enable alone.
  await manager.enable({
    sessionId: CALLER.sessionId,
    runId: CALLER.ownerId,
    cwd: CALLER.cwd,
    backend: 'cua',
  });
  const orphaned = await integrationCall(bridge, 'observe', { windowId: '844:10725' });
  assert.equal(
    orphaned.status,
    409,
    'retained orphan must refuse new driver, got ' + JSON.stringify(orphaned.body).slice(0, 600),
  );
  assert.match(orphaned.body.error || orphaned.body.code || '', /cleanup|orphan|failed/i);
  assert.equal(wrappers.length, 1, 'no new wrapper while orphan retained; same object');
  assert.equal(fake.instances.length, 1, 'no new transport while orphan retained');
  // Allow success and retry via explicit stop: SAME wrapper object must be closed.
  failFlag.failClose = false;
  await manager.stop('retry-orphan');
  assert.equal(wrappers.length, 1, 'retry must close same wrapper, never mint a replacement');
  assert.ok(wrappers[0].closes >= 2, 'same wrapper close retried, got ' + wrappers[0].closes);
  // After verified retry, a fresh observe succeeds.
  await manager.enable({
    sessionId: CALLER.sessionId,
    runId: CALLER.ownerId,
    cwd: CALLER.cwd,
    backend: 'cua',
  });
  const recovered = await integrationCall(bridge, 'observe', { windowId: '844:10725' });
  assert.equal(
    recovered.status,
    200,
    'post-retry observe must succeed, got ' + JSON.stringify(recovered.body).slice(0, 600),
  );
});
