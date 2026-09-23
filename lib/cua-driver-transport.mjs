/**
 * CUA driver transport (Node side).
 *
 * Owns ONLY the private CUA process pair for tag cua-driver-rs-v0.28.2
 * (commit fc188250b4ca8549b8e61f937fdb1fb560770e86):
 *   cua-driver serve --socket <private-pipe>   (daemon, line-delimited JSON)
 *   cua-driver mcp --socket <private-pipe>     (persistent stdio JSON-RPC proxy)
 *
 * Never attaches to the shared default daemon pipe. Never uses --direct,
 * --dangerously-bypass-approvals, autostart, install, cloud, VM or model
 * flags. No capture, focus or input happens in this file; it only frames
 * MCP JSON-RPC over the owned proxy stdin/stdout and supervises the two
 * owned processes with generation fencing.
 *
 * Isolation env for both children (Studio-owned values only):
 *   CUA_DRIVER_RS_HOME=<isolated dir> (required)
 *   CUA_DRIVER_RS_UPDATE_CHECK=0
 *   CUA_DRIVER_RS_TELEMETRY_ENABLED=0
 *   CUA_LOG=WARN
 * No PATH mutation, no scheduled task, no skills install.
 *
 * MCP profile: legacy initialize (protocolVersion 2025-06-18) then
 * notifications/initialized, then tools/list and tools/call. Modern
 * server/discover (2026-07-28) is intentionally not required here.
 *
 * Abort/timeout semantics: caller-side only. An aborted or timed-out call
 * rejects locally (ABORTED/TIMEOUT) and its late answer is ignored by id.
 * No cancel is sent to the daemon because CUA has no per-action cancel;
 * the daemon finishes or fails on its own. stop()/close() are the only
 * lifecycle verbs and they advance the generation.
 *
 * Only metadata smoke (--version, --help, initialize, tools/list) is ever
 * run against a real binary. All behavior tests use injected spawnProcess
 * fakes and synthetic payloads.
 */
import { spawn as defaultSpawn } from 'node:child_process';
import { connect as netConnect } from 'node:net';

export const CUA_DRIVER_TAG = 'cua-driver-rs-v0.28.2';
export const CUA_DRIVER_COMMIT = 'fc188250b4ca8549b8e61f937fdb1fb560770e86';
export const CUA_CONTRACT_VERSION = '0.8.0';
export const CUA_MCP_LEGACY_VERSION = '2025-06-18';
export const CUA_CLIENT_NAME = 'prime-agent-studio';

const DEFAULT_PIPES = new Set(['\\\\.\\pipe\\cua-driver', '\\\\.\\pipe\\cua-driver-local']);
const FORBIDDEN_ARGV = [
  '--direct',
  '--dangerously-bypass-approvals',
  '--no-permissions-gate',
  '--experimental-history',
  '--claude-code-computer-use-compat',
  'autostart',
  'install',
  'update',
];
const STARTUP_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 5000;

function transportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPrivateSocket(socketPath) {
  if (typeof socketPath !== 'string' || !socketPath) {
    throw transportError('INVALID_SOCKET', 'CUA transport needs a private --socket pipe path.');
  }
  const lowered = socketPath.toLowerCase();
  if (
    DEFAULT_PIPES.has(lowered) ||
    lowered.endsWith('\\cua-driver') ||
    lowered.endsWith('\\cua-driver-local')
  ) {
    throw transportError(
      'SHARED_DAEMON_FORBIDDEN',
      'CUA transport must never attach to the shared default daemon pipe. Pass a Studio-private --socket path.',
    );
  }
  if (
    !lowered.includes('pipe') &&
    !lowered.includes('.sock') &&
    !lowered.includes('cua-studio') &&
    !lowered.includes('prime')
  ) {
    // Soft guard: private Studio pipes carry an instance marker. Allow tmp
    // test pipes explicitly so fakes stay simple.
    if (!lowered.includes('tmp') && !lowered.includes('test')) {
      throw transportError(
        'INVALID_SOCKET',
        'CUA socket path does not look like a Studio-private pipe. Refusing to guess.',
      );
    }
  }
}

function assertIsolatedHome(homeDir) {
  if (typeof homeDir !== 'string' || !homeDir) {
    throw transportError('INVALID_HOME', 'CUA transport needs an isolated CUA_DRIVER_RS_HOME directory.');
  }
}

function childEnv(baseEnv, homeDir) {
  return {
    ...baseEnv,
    CUA_DRIVER_RS_HOME: homeDir,
    CUA_DRIVER_RS_UPDATE_CHECK: '0',
    CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
    CUA_LOG: 'WARN',
  };
}

// Hardened child env subset, shared with the adapter's guardian job_launch
// block (the native guardian env is NOT the CUA home).
export function cuaChildEnv(baseEnv, homeDir) {
  return childEnv(baseEnv, homeDir);
}

function checkForbiddenArgv(args) {
  for (const token of args) {
    if (FORBIDDEN_ARGV.includes(String(token))) {
      throw transportError(
        'FORBIDDEN_FLAG',
        `CUA transport forbids argv token ${String(token)} in Studio beta.`,
      );
    }
  }
}

/**
 * Create the owned daemon+proxy transport.
 *
 * options:
 *   driverPath       absolute cua-driver(.exe) path (required for start).
 *   socketPath       private pipe path for serve/mcp --socket (required).
 *   homeDir          isolated CUA_DRIVER_RS_HOME (required).
 *   sessionLabel     public lifecycle label repeated on calls (default studio-cua).
 *   spawnProcess     child_process.spawn injection (default spawn).
 *   env              base environment (default process.env).
 *   startupTimeoutMs (default 15000), requestTimeoutMs (default 30000),
 *   stopTimeoutMs    (default 5000).
 *   daemonProbe      async (socketPath, perProbeMs) => boolean injection for
 *                    readiness checks (tests). Default opens the EXACT
 *                    private socket only and issues one metadata-only
 *                    daemon `list` request (mirrors the upstream
 *                    is_daemon_listening probe: read-only, no tools/call,
 *                    no capture, no input). Never the shared pipe.
 *   processHost      reserved seam for the forthcoming Windows Job Object
 *                    owned-process host ({ killTree(pids, opts),
 *                    verifyExit(pids, opts) }). Default null: direct-child
 *                    supervision only, which is NOT tree proof for daemon
 *                    descendants (e.g. cua-driver-uia). No taskkill band-aid:
 *                    production tree proof arrives via the guardian job
 *                    verbs; this seam only delegates when explicitly set.
 *   onEvent(event)   diagnostics callback, never throws into transport.
 */
export function createCuaDriverTransport(options = {}) {
  const {
    driverPath,
    socketPath,
    homeDir,
    sessionLabel = 'studio-cua',
    spawnProcess = defaultSpawn,
    env = process.env,
    daemonProbe = null,
    processHost = null,
    startupTimeoutMs = STARTUP_TIMEOUT_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    stopTimeoutMs = STOP_TIMEOUT_MS,
    onEvent,
  } = options;

  let daemon = null;
  let proxy = null;
  let proxyBuffer = '';
  let nextId = 1;
  let started = false;
  let closed = false;
  let generation = 1;
  const pending = new Map();
  const owned = new Map(); // pid -> child handle (daemon/proxy only)
  let daemonPid = null;
  let proxyPid = null;

  function emit(event) {
    try {
      onEvent?.(event);
    } catch {
      // Diagnostics must never break the transport.
    }
  }

  function failPending(code, message) {
    for (const [id, entry] of [...pending]) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(transportError(code, `${message} (mcp ${entry.method}#${id})`));
    }
  }

  function handleProxyLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      emit({ kind: 'cua_protocol', warning: 'ignored malformed proxy line' });
      return;
    }
    if (message && typeof message === 'object' && message.id !== undefined && message.id !== null) {
      const key = String(message.id);
      const entry = pending.get(key);
      if (!entry) return; // Late answer after timeout/abort/stop: ignore.
      pending.delete(key);
      clearTimeout(entry.timer);
      entry.settledAt = Date.now();
      if (message.error && typeof message.error === 'object') {
        const err = transportError(
          'CUA_RPC_ERROR',
          String(message.error.message || 'CUA proxy request failed.'),
        );
        err.data = message.error;
        err.timing = {
          startedAt: entry.startedAt,
          endedAt: entry.settledAt,
          durationMs: entry.settledAt - entry.startedAt,
        };
        entry.reject(err);
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    emit({ kind: 'cua_notify', message });
  }

  function onProxyData(chunk) {
    proxyBuffer += chunk.toString('utf8');
    let index;
    while ((index = proxyBuffer.indexOf('\n')) >= 0) {
      const line = proxyBuffer.slice(0, index);
      proxyBuffer = proxyBuffer.slice(index + 1);
      handleProxyLine(line.replace(/\r$/, ''));
    }
  }

  function trackOwned(label, child) {
    const pid = child?.pid;
    if (Number.isInteger(pid)) {
      owned.set(pid, child);
      if (label === 'daemon') daemonPid = pid;
      if (label === 'proxy') proxyPid = pid;
    }
  }

  function untrackOwned(child) {
    for (const [pid, handle] of [...owned]) {
      if (handle === child) owned.delete(pid);
    }
  }

  function writeProxy(payload) {
    if (!proxy?.stdin) throw transportError('TRANSPORT_CLOSED', 'CUA proxy is not running.');
    return new Promise((resolve, reject) => {
      try {
        proxy.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (error) => {
          if (error) reject(transportError('TRANSPORT_WRITE', `Cannot send to CUA proxy: ${error.message}`));
          else resolve();
        });
      } catch (error) {
        reject(transportError('TRANSPORT_WRITE', `Cannot send to CUA proxy: ${error.message}`));
      }
    });
  }

  async function jsonRpc(method, params, { signal, timeoutMs } = {}) {
    if (closed) throw transportError('TRANSPORT_CLOSED', 'CUA transport is closed.');
    if (!proxy) throw transportError('TRANSPORT_NOT_STARTED', 'CUA transport is not started.');
    if (signal?.aborted) throw transportError('ABORTED', `CUA ${method} was aborted before sending.`);
    const id = String(nextId++);
    const deadline = timeoutMs ?? requestTimeoutMs;
    const startedAt = Date.now();
    let timer;
    const answer = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        emit({ kind: 'cua_timeout', method, id });
        // Caller-side only: no daemon cancel exists. Late answer ignored by id.
        reject(transportError('TIMEOUT', `CUA ${method} timed out after ${deadline}ms.`));
      }, deadline);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, { resolve, reject, timer, method, startedAt });
    });
    if (signal) {
      const abort = () => {
        const entry = pending.get(id);
        if (entry) {
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(transportError('ABORTED', `CUA ${method} was aborted while waiting.`));
        }
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      answer.finally(() => signal.removeEventListener?.('abort', abort)).catch(() => {});
    }
    // Generation fence: a stop/close that landed before send invalidates.
    const genAtSend = generation;
    try {
      await writeProxy({
        jsonrpc: '2.0',
        id: Number.isSafeInteger(Number(id)) ? Number(id) : id,
        method,
        params,
      });
    } catch (error) {
      if (pending.has(id)) {
        pending.delete(id);
        clearTimeout(timer);
      }
      throw error;
    }
    if (genAtSend !== generation) {
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        clearTimeout(entry.timer);
        throw transportError('STOPPED', `CUA ${method} was stopped before sending.`);
      }
    }
    return answer;
  }

  async function runShortLived(args, { timeoutMs = 10000 } = {}) {
    if (!driverPath) throw transportError('DRIVER_UNAVAILABLE', 'CUA driver binary path is unknown.');
    checkForbiddenArgv(args);
    const child = spawnProcess(driverPath, args, {
      env: childEnv(env, homeDir),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child?.pid;
    if (Number.isInteger(pid)) owned.set(pid, child);
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 65536) output = output.slice(-65536);
    });
    child.stderr?.on('data', () => {});
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      child.on?.('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.on?.('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill?.();
    } catch {}
    if (Number.isInteger(pid)) owned.delete(pid);
    return { exitCode, output: output.slice(0, 8000) };
  }

  async function start() {
    if (closed) throw transportError('TRANSPORT_CLOSED', 'CUA transport is closed.');
    if (started && proxy && (daemon || jobMode)) return { daemonPid, proxyPid, generation };
    if (!driverPath) throw transportError('DRIVER_UNAVAILABLE', 'CUA driver binary path is unknown.');
    assertPrivateSocket(socketPath);
    assertIsolatedHome(homeDir);
    const launchEnv = childEnv(env, homeDir);
    if (launchEnv.CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS === '1') {
      throw transportError('FORBIDDEN_FLAG', 'CUA transport forbids the dangerous bypass env in beta.');
    }

    const serveArgs = ['serve', '--socket', socketPath];
    checkForbiddenArgv(serveArgs);
    daemon = spawnProcess(driverPath, serveArgs, {
      env: launchEnv,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!daemon) throw transportError('DAEMON_SPAWN', 'Cannot spawn the CUA daemon.');
    trackOwned('daemon', daemon);
    emit({ kind: 'cua_daemon_spawn', pid: daemonPid, socketPath });
    daemon.stderr?.on('data', (chunk) => {
      emit({ kind: 'cua_daemon_stderr', message: String(chunk.toString('utf8')).slice(-2000) });
    });
    daemon.on?.('error', (error) => {
      emit({ kind: 'cua_daemon_exit', message: error.message });
    });
    const daemonGone = new Promise((resolve) => {
      daemon.on?.('exit', (code, signal) => {
        untrackOwned(daemon);
        emit({ kind: 'cua_daemon_exit', code, signal });
        resolve({ code, signal });
      });
    });

    // Give the daemon a bounded window to bind the private pipe before the
    // proxy handshake proves readiness. The proxy itself fails fast when the
    // daemon is unreachable, so this delay is only a scheduling courtesy.
    const readyDelay = Math.min(400, Math.max(50, startupTimeoutMs >= 15000 ? 300 : 50));
    await new Promise((done) => setTimeout(done, readyDelay));
    if (daemon.exitCode !== null && daemon.exitCode !== undefined) {
      throw transportError('DAEMON_EXIT', 'The CUA daemon exited before the proxy handshake.');
    }

    await spawnProxy();
    const raced = await Promise.race([
      handshake(),
      daemonGone.then(() => {
        throw transportError('DAEMON_EXIT', 'The CUA daemon exited during the proxy handshake.');
      }),
    ]).catch((error) => {
      try {
        proxy?.kill?.();
      } catch {}
      try {
        daemon?.kill?.();
      } catch {}
      proxy = null;
      daemon = null;
      throw error;
    });
    void raced;
    started = true;
    return { daemonPid, proxyPid, generation };
  }

  // Job mode: the daemon is guardian-launched, never spawned here. Once
  // the adopted proxy handshook, legacy start() must stay dormant.
  let jobMode = false;
  function markJobReady() {
    jobMode = true;
    started = true;
  }

  // Metadata-only readiness probe for the EXACT private daemon socket.
  // Mirrors the upstream is_daemon_listening check: one read-only daemon
  // `list` request over a short-lived pipe connection. No tools/call, no
  // capture, no input, never the shared pipe. The probe is injectable so
  // tests never touch real pipes.
  function defaultDaemonProbe(targetSocket, perProbeMs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        try {
          client.destroy();
        } catch {}
        resolve(ok === true);
      };
      let client = null;
      try {
        client = netConnect(targetSocket);
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => done(false), perProbeMs);
      if (typeof timer.unref === 'function') timer.unref();
      client.on('connect', () => {
        try {
          client.write(`${JSON.stringify({ method: 'list' })}\n`, 'utf8');
        } catch {
          done(false);
        }
      });
      // Bounded output: the daemon `list` answer carries FULL ToolDefs
      // (the pinned portable manifest alone compacts to 56,646 bytes, and
      // Windows adds double_click/set_value/etc), so the cap sits at 1MiB:
      // far above any healthy startup, far below unbounded growth.
      // Malformed or overlarge packets fail the round instead.
      const MAX_PROBE_BYTES = 1048576;
      let buffer = '';
      let bytes = 0;
      client.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_PROBE_BYTES) {
          clearTimeout(timer);
          done(false);
          return;
        }
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          const message = JSON.parse(buffer.slice(0, newline));
          done(message && message.ok === true);
        } catch {
          done(false);
        }
      });
      client.on('error', () => {
        clearTimeout(timer);
        done(false);
      });
      client.on('close', () => done(false));
    });
  }

  // Bounded pre-handshake readiness for the exact private socket, with
  // stop cancellation. Polls the metadata-only probe until the daemon
  // answers, the budget expires (DAEMON_NOT_READY), or the signal aborts
  // (ABORTED, no further probes). No arbitrary sleep: every wait is a
  // bounded probe round or an abortable interval.
  async function waitForDaemon({ timeoutMs = 8000, intervalMs = 200, perProbeMs = 500, signal } = {}) {
    // Shared-pipe guard FIRST: no probe packet ever leaves for the default
    // daemon, even a metadata-only one.
    assertPrivateSocket(socketPath);
    const probe = typeof daemonProbe === 'function' ? daemonProbe : defaultDaemonProbe;
    const deadline = Date.now() + Math.max(1, timeoutMs);
    for (;;) {
      if (signal?.aborted) throw transportError('ABORTED', 'CUA daemon readiness wait was aborted.');
      let ready = false;
      try {
        ready = await probe(socketPath, perProbeMs);
      } catch {
        ready = false;
      }
      if (ready) {
        emit({ kind: 'cua_daemon_ready', socketPath });
        return { ready: true };
      }
      if (Date.now() >= deadline) {
        throw transportError(
          'DAEMON_NOT_READY',
          `CUA daemon did not answer on the private socket within ${timeoutMs}ms.`,
        );
      }
      await new Promise((resolve, reject) => {
        const remaining = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
        const timer = setTimeout(resolve, remaining);
        if (typeof timer.unref === 'function') timer.unref();
        if (signal) {
          const abort = () => {
            clearTimeout(timer);
            reject(transportError('ABORTED', 'CUA daemon readiness wait was aborted.'));
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        }
      });
    }
  }

  // Direct proxy spawn with Studio stdio (job mode): the guardian adopts
  // the SAME opened handle (identity-verified) before any handshake or
  // tool request runs. Returns the birth proof the adopt call checks.
  async function spawnProxy() {
    if (closed) throw transportError('TRANSPORT_CLOSED', 'CUA transport is closed.');
    if (!driverPath) throw transportError('DRIVER_UNAVAILABLE', 'CUA driver binary path is unknown.');
    assertPrivateSocket(socketPath);
    assertIsolatedHome(homeDir);
    const launchEnv = childEnv(env, homeDir);
    if (launchEnv.CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS === '1') {
      throw transportError('FORBIDDEN_FLAG', 'CUA transport forbids the dangerous bypass env in beta.');
    }
    const mcpArgs = ['mcp', '--socket', socketPath];
    checkForbiddenArgv(mcpArgs);
    proxy = spawnProcess(driverPath, mcpArgs, {
      env: launchEnv,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!proxy) throw transportError('PROXY_SPAWN', 'Cannot spawn the CUA MCP proxy.');
    trackOwned('proxy', proxy);
    emit({ kind: 'cua_proxy_spawn', pid: proxyPid, socketPath });
    proxy.stdout?.on('data', onProxyData);
    proxy.stderr?.on('data', (chunk) => {
      emit({ kind: 'cua_proxy_stderr', message: String(chunk.toString('utf8')).slice(-2000) });
    });
    proxy.on?.('exit', (code, signal) => {
      untrackOwned(proxy);
      emit({ kind: 'cua_proxy_exit', code, signal });
      failPending('TRANSPORT_EXIT', 'The CUA proxy exited before answering.');
    });
    proxy.on?.('error', (error) => {
      emit({ kind: 'cua_proxy_exit', message: error.message });
    });
    return { proxyPid, birthMs: Date.now(), socketPath };
  }

  // Legacy initialize handshake (2025-06-18). No capture, no input. Runs
  // only after the guardian adopted the proxy handle in job mode.
  async function handshake({ timeoutMs } = {}) {
    const startedAt = Date.now();
    const result = await jsonRpc(
      'initialize',
      {
        protocolVersion: CUA_MCP_LEGACY_VERSION,
        capabilities: {},
        clientInfo: { name: CUA_CLIENT_NAME, version: '3.10.0-beta.2' },
      },
      { timeoutMs: timeoutMs ?? startupTimeoutMs },
    );
    // Initialized notification (no id, no response expected).
    try {
      await writeProxy({ jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch {}
    emit({ kind: 'cua_handshake', durationMs: Date.now() - startedAt });
    return result;
  }

  // Light abort for job mode: fail pending callers and EOF the proxy
  // without killing (the guardian job_kill owns tree death and its proof).
  async function abort(reason = 'aborted') {
    const label = typeof reason === 'string' && reason ? reason : 'aborted';
    generation += 1;
    failPending('TRANSPORT_ABORTED', `CUA transport aborted (${label}).`);
    try {
      proxy?.stdin?.end?.();
    } catch {}
    emit({ kind: 'cua_aborted', reason: label, generation });
    return { aborted: true, reason: label, generation };
  }

  async function listTools({ signal, timeoutMs } = {}) {
    await start();
    const startedAt = Date.now();
    const result = await jsonRpc('tools/list', {}, { signal, timeoutMs });
    return { ...result, timing: { startedAt, endedAt: Date.now(), durationMs: Date.now() - startedAt } };
  }

  async function callTool(name, args = {}, { signal, timeoutMs } = {}) {
    if (typeof name !== 'string' || !name || name.length > 120) {
      throw transportError('INVALID_TOOL', 'CUA tool name must be a short non-empty string.');
    }
    if (name.startsWith('_') || name.includes('/') || name.includes(' ')) {
      throw transportError('INVALID_TOOL', `CUA tool name is not callable here: ${name}.`);
    }
    await start();
    const startedAt = Date.now();
    const result = await jsonRpc('tools/call', { name, arguments: args ?? {} }, { signal, timeoutMs });
    const endedAt = Date.now();
    return { result, timing: { startedAt, endedAt, durationMs: endedAt - startedAt } };
  }

  /** Metadata-only smoke on the exact owned binary. No capture or input. */
  async function smokeMetadata({ timeoutMs = 10000 } = {}) {
    const version = await runShortLived(['--version'], { timeoutMs });
    return { version: version.output.trim().slice(0, 500), exitCode: version.exitCode };
  }

  async function ownedDrained(timeoutMs = 800) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let alive = false;
      for (const [, child] of owned) {
        if (child && child.exitCode === null && child.signalCode === null && !child.killed) {
          alive = true;
          break;
        }
        if (child && child.exitCode === null && child.signalCode === null && child.killed) continue;
      }
      if (!alive) {
        for (const [pid, child] of [...owned]) {
          if (child && child.exitCode !== null) owned.delete(pid);
        }
        if (!owned.size) return true;
      }
      await new Promise((done) => setTimeout(done, 25));
    }
    for (const [pid, child] of [...owned]) {
      if (child && child.exitCode !== null) owned.delete(pid);
    }
    return owned.size === 0;
  }

  async function stop(reason = 'user') {
    const label = typeof reason === 'string' && reason ? reason : 'user';
    generation += 1;
    const gen = generation;
    failPendingExcept('STOPPED', `CUA transport stopped (${label}).`, gen);
    // PID-bound daemon shutdown on the private socket only. Never touches a
    // shared daemon: --expected-pid refuses a foreign owner.
    try {
      if (driverPath && socketPath && daemonPid) {
        await runShortLived(['stop', '--socket', socketPath, '--expected-pid', String(daemonPid)], {
          timeoutMs: stopTimeoutMs,
        }).catch(() => {});
      }
    } catch {}
    try {
      proxy?.stdin?.end?.();
    } catch {}
    await killOwned(`stop:${label}`);
    const exited = await verifyOwnedDrained(800);
    emit({ kind: 'cua_stopped', reason: label, generation: gen, treeExited: exited });
    return { stopped: true, reason: label, generation: gen, treeExited: exited };
  }

  function failPendingExcept(code, message, gen) {
    for (const [id, entry] of [...pending]) {
      if (entry.gen !== undefined && entry.gen > gen) continue;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(transportError(code, `${message} (mcp ${entry.method}#${id})`));
    }
  }

  function ownedRootPids() {
    return [...owned.keys()];
  }

  async function killOwned(context) {
    // Bounded kill of OWNED processes only (daemon + proxy + short-lived
    // helpers already reaped). Never by generic name or port, never the
    // shared runtime, never a taskkill band-aid here.
    const pids = ownedRootPids();
    if (processHost && typeof processHost.killTree === 'function' && pids.length) {
      emit({ kind: 'cua_kill_host', pids, context });
      await processHost.killTree(pids, { context });
      return;
    }
    for (const [pid, child] of [...owned]) {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill?.();
        emit({ kind: 'cua_kill_owned', pid, context });
      } catch {}
    }
  }

  async function verifyOwnedDrained(timeoutMs) {
    if (processHost && typeof processHost.verifyExit === 'function') {
      const pids = ownedRootPids();
      if (!pids.length) return true;
      return processHost.verifyExit(pids, { timeoutMs });
    }
    return ownedDrained(timeoutMs);
  }

  let closeVerified = false;
  async function close() {
    // Retryable verified close: an earlier FAILED close re-attempts the
    // drain instead of returning early; retained live handles are re-killed.
    // Only a verified drain releases handles (no false verified close).
    if (closeVerified) return;
    closed = true;
    generation += 1;
    failPending('TRANSPORT_CLOSED', 'CUA transport was closed.');
    try {
      proxy?.stdin?.end?.();
    } catch {}
    // Short grace for clean EOF exit, then terminate owned children only.
    await new Promise((done) => setTimeout(done, 120));
    await killOwned('close');
    const drained = await verifyOwnedDrained(500);
    if (!drained) {
      throw transportError(
        'TRANSPORT_CLOSE_FAILED',
        'CUA transport close could not verify owned-process exit. Handles retained; retry close.',
      );
    }
    daemon = null;
    proxy = null;
    owned.clear();
    closeVerified = true;
  }

  return {
    start,
    spawnProxy,
    waitForDaemon,
    handshake,
    markJobReady,
    abort,
    listTools,
    callTool,
    smokeMetadata,
    stop,
    close,
    get started() {
      return started && Boolean(proxy) && (Boolean(daemon) || jobMode);
    },
    get daemonPid() {
      return daemonPid;
    },
    get proxyPid() {
      return proxyPid;
    },
    get ownedPids() {
      return [...owned.keys()];
    },
    get generation() {
      return generation;
    },
    get socketPath() {
      return socketPath;
    },
  };
}
