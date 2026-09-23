/**
 * Windows Computer Use driver (Node side).
 *
 * Owns ONLY the transport to the hidden persistent PowerShell/.NET worker
 * at runtime/computer-use-worker.ps1. No screen capture or input happens
 * in this file; it only validates, frames JSON-lines requests over stdin,
 * routes responses from stdout, and enforces preemptive stop semantics.
 *
 * Protocol (JSON lines):
 *   request  { id, method, params }  (methods: status, windows, observe, act, stop)
 *   response { id, result } | { id, error: { code, message } }
 *   notify   { event: 'ready' | 'stopped', ... }  (no id)
 *
 * Coordinates in act requests are SCREEN PHYSICAL pixels. This driver does
 * no frame transform; the backend bridge maps model coordinates to physical
 * pixels before calling here.
 *
 * Freshness and single-controller generation binding:
 * - Every outgoing request line carries a numeric `generation`. stop() and
 *   close() advance it, so the worker (and any later reader) can reject
 *   queued commands from before the stop with STALE_GENERATION. Late answers
 *   to already settled requests are ignored by id.
 * - Aborted-before-send requests never reach the wire, and a stop that lands
 *   during startup cancels requests that entered before it (generation
 *   barrier). Mutating timeouts and post-send aborts (act input and windows
 *   focus) also fire a best-effort native stop with a fresh generation so
 *   orphan input cannot continue and its generation can never resume.
 * - act accepts params.expectedFrame { windowId?, bounds?, desktopBounds?,
 *   foregroundWindowId?, requireForeground? }. The worker verifies screen
 *   layout and window geometry before sending any input and re-checks the
 *   focus guard before keyboard actions; mismatches fail with STALE_FRAME,
 *   WINDOW_MINIMIZED or FOCUS_CHANGED and send no input.
 * - observe/status results carry desktopBounds and foregroundWindowId so the
 *   backend can bind frames to the geometry they were captured with.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMPUTER_USE_HOTKEY = 'Ctrl+Alt+Shift+F10';
export const COMPUTER_USE_METHODS = ['status', 'windows', 'observe', 'act', 'stop'];
const METHOD_SET = new Set(COMPUTER_USE_METHODS);

const WORKER_PATH = fileURLToPath(new URL('../runtime/computer-use-worker.ps1', import.meta.url));

const MAX_ACTIONS = 20;
const MAX_TEXT_LENGTH = 2000;
const MAX_WAIT_MS = 5000;
const MAX_KEYS_PER_PRESS = 8;
const MAX_PATH_POINTS = 20;
const MAX_SCROLL_DELTA = 100;
const MAX_REASON_LENGTH = 200;
const DEFAULT_TIMEOUT_MS = 30000;
const STARTUP_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 3000;
const CLOSE_TIMEOUT_MS = 3000;

function driverError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function checkCoord(value, name) {
  if (!isInt(value) || value < -20000 || value > 20000)
    throw driverError('INVALID_PARAMS', `${name} must be an integer pixel in [-20000, 20000].`);
}

function normalizeParams(params) {
  if (params === undefined) return {};
  if (params && typeof params === 'object' && !Array.isArray(params)) return params;
  throw driverError('INVALID_PARAMS', 'params must be an object.');
}

function validateAction(action, index) {
  if (!action || typeof action !== 'object' || Array.isArray(action))
    throw driverError('INVALID_PARAMS', `actions[${index}] must be an object.`);
  const { type } = action;
  switch (type) {
    case 'click':
    case 'double_click': {
      checkCoord(action.x, `actions[${index}].x`);
      checkCoord(action.y, `actions[${index}].y`);
      if (action.button !== undefined && !['left', 'right', 'middle'].includes(action.button))
        throw driverError('INVALID_PARAMS', `actions[${index}].button must be left, right or middle.`);
      break;
    }
    case 'move': {
      checkCoord(action.x, `actions[${index}].x`);
      checkCoord(action.y, `actions[${index}].y`);
      break;
    }
    case 'drag': {
      checkCoord(action.x, `actions[${index}].x`);
      checkCoord(action.y, `actions[${index}].y`);
      if (action.button !== undefined && !['left', 'right', 'middle'].includes(action.button))
        throw driverError('INVALID_PARAMS', `actions[${index}].button must be left, right or middle.`);
      if (action.path !== undefined) {
        if (!Array.isArray(action.path) || action.path.length > MAX_PATH_POINTS)
          throw driverError(
            'INVALID_PARAMS',
            `actions[${index}].path must have at most ${MAX_PATH_POINTS} points.`,
          );
        action.path.forEach((point, pointIndex) => {
          if (!point || typeof point !== 'object')
            throw driverError('INVALID_PARAMS', `actions[${index}].path[${pointIndex}] must be an object.`);
          checkCoord(point.x, `actions[${index}].path[${pointIndex}].x`);
          checkCoord(point.y, `actions[${index}].path[${pointIndex}].y`);
        });
      }
      break;
    }
    case 'scroll': {
      if (action.x !== undefined) checkCoord(action.x, `actions[${index}].x`);
      if (action.y !== undefined) checkCoord(action.y, `actions[${index}].y`);
      const { deltaX = 0, deltaY = 0 } = action;
      if (
        !isInt(deltaX) ||
        Math.abs(deltaX) > MAX_SCROLL_DELTA ||
        !isInt(deltaY) ||
        Math.abs(deltaY) > MAX_SCROLL_DELTA
      )
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}] scroll deltas must be integers within ±${MAX_SCROLL_DELTA}.`,
        );
      if (deltaX === 0 && deltaY === 0)
        throw driverError('INVALID_PARAMS', `actions[${index}] scroll needs a nonzero deltaX or deltaY.`);
      break;
    }
    case 'keypress': {
      if (!Array.isArray(action.keys) || action.keys.length < 1 || action.keys.length > MAX_KEYS_PER_PRESS)
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}].keys must list 1 to ${MAX_KEYS_PER_PRESS} keys.`,
        );
      for (const key of action.keys) {
        if (typeof key !== 'string' || !key.trim() || key.length > 32)
          throw driverError('INVALID_PARAMS', `actions[${index}].keys must be non-empty key names.`);
      }
      break;
    }
    case 'type': {
      if (typeof action.text !== 'string' || !action.text || action.text.length > MAX_TEXT_LENGTH)
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}].text must be 1 to ${MAX_TEXT_LENGTH} characters.`,
        );
      break;
    }
    case 'wait': {
      if (!isInt(action.ms) || action.ms < 1 || action.ms > MAX_WAIT_MS)
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}].ms must be an integer in [1, ${MAX_WAIT_MS}].`,
        );
      break;
    }
    default:
      throw driverError(
        'INVALID_PARAMS',
        `actions[${index}].type must be click, double_click, move, drag, scroll, keypress, type or wait.`,
      );
  }
}

function validateCommand(command) {
  let method;
  let params;
  let shorthandParams;
  if (typeof command === 'string') {
    method = command;
    shorthandParams = undefined;
  } else if (command && typeof command === 'object' && !Array.isArray(command)) {
    method = command.method ?? command.type;
    params = command.params;
    if (params === undefined && command.actions !== undefined && (method === 'act' || method === undefined)) {
      method = 'act';
      params = { actions: command.actions };
    }
  } else {
    throw driverError('INVALID_PARAMS', 'command must be { method, params } or a method name.');
  }
  if (typeof method !== 'string' || !METHOD_SET.has(method))
    throw driverError('UNKNOWN_METHOD', `Unknown computer-use method: ${String(method)}.`);
  const resolved = normalizeParams(params ?? shorthandParams);
  switch (method) {
    case 'status':
      break;
    case 'windows': {
      const action = resolved.action ?? 'list';
      if (action !== 'list' && action !== 'focus')
        throw driverError('INVALID_PARAMS', "windows.action must be 'list' or 'focus'.");
      if (action === 'focus' && (typeof resolved.windowId !== 'string' || !resolved.windowId))
        throw driverError('INVALID_PARAMS', 'windows focus needs a windowId string.');
      break;
    }
    case 'observe': {
      if (resolved.windowId !== undefined && (typeof resolved.windowId !== 'string' || !resolved.windowId))
        throw driverError('INVALID_PARAMS', 'observe.windowId must be a non-empty string.');
      if (resolved.region !== undefined) {
        const { x, y, width, height } = resolved.region;
        checkCoord(x, 'observe.region.x');
        checkCoord(y, 'observe.region.y');
        if (!isInt(width) || width < 1 || width > 8192 || !isInt(height) || height < 1 || height > 8192)
          throw driverError('INVALID_PARAMS', 'observe.region width/height must be integers in [1, 8192].');
      }
      if (
        resolved.maxWidth !== undefined &&
        (!isInt(resolved.maxWidth) || resolved.maxWidth < 16 || resolved.maxWidth > 4096)
      )
        throw driverError('INVALID_PARAMS', 'observe.maxWidth must be an integer in [16, 4096].');
      break;
    }
    case 'act': {
      if (
        !Array.isArray(resolved.actions) ||
        resolved.actions.length < 1 ||
        resolved.actions.length > MAX_ACTIONS
      )
        throw driverError('INVALID_PARAMS', `act.actions must list 1 to ${MAX_ACTIONS} actions.`);
      resolved.actions.forEach(validateAction);
      validateExpectedFrame(resolved.expectedFrame);
      break;
    }
    case 'stop': {
      if (
        resolved.reason !== undefined &&
        (typeof resolved.reason !== 'string' ||
          !resolved.reason ||
          resolved.reason.length > MAX_REASON_LENGTH)
      )
        throw driverError('INVALID_PARAMS', 'stop.reason must be a short non-empty string.');
      break;
    }
  }
  return { method, params: resolved };
}

function checkRect(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw driverError('INVALID_PARAMS', `${name} must be { x, y, width, height }.`);
  checkCoord(value.x, `${name}.x`);
  checkCoord(value.y, `${name}.y`);
  if (
    !isInt(value.width) ||
    value.width < 1 ||
    value.width > 8192 ||
    !isInt(value.height) ||
    value.height < 1 ||
    value.height > 8192
  )
    throw driverError('INVALID_PARAMS', `${name} width/height must be integers in [1, 8192].`);
}

function validateExpectedFrame(value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw driverError('INVALID_PARAMS', 'act.expectedFrame must be an object.');
  if (value.windowId !== undefined && (typeof value.windowId !== 'string' || !value.windowId))
    throw driverError('INVALID_PARAMS', 'act.expectedFrame.windowId must be a non-empty string.');
  if (
    value.foregroundWindowId !== undefined &&
    (typeof value.foregroundWindowId !== 'string' || !value.foregroundWindowId)
  )
    throw driverError('INVALID_PARAMS', 'act.expectedFrame.foregroundWindowId must be a non-empty string.');
  if (value.requireForeground !== undefined && typeof value.requireForeground !== 'boolean')
    throw driverError('INVALID_PARAMS', 'act.expectedFrame.requireForeground must be a boolean.');
  if (value.bounds !== undefined) checkRect(value.bounds, 'act.expectedFrame.bounds');
  if (value.desktopBounds !== undefined) checkRect(value.desktopBounds, 'act.expectedFrame.desktopBounds');
}

// Focus changes input routing, so it is mutating like act. Everything else
// (status, windows list, observe) is read-only and never auto-stops.
function isMutatingCommand(method, params) {
  if (method === 'act') return true;
  if (method === 'windows' && params && typeof params === 'object' && params.action === 'focus') return true;
  return false;
}

function powershellPath(env) {
  return join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Create the Windows Computer Use driver.
 *
 * options:
 *   platform           OS override for tests (default process.platform).
 *   spawnProcess       child_process.spawn injection (default spawn).
 *   workerPath         worker .ps1 path (default runtime/computer-use-worker.ps1).
 *   powershellPath     powershell.exe override.
 *   env                environment for the worker (default process.env).
 *   cwd                working directory for the worker.
 *   startupTimeoutMs   wait for the worker ready event (default 15000).
 *   defaultTimeoutMs   per-request timeout (default 30000).
 *   stopTimeoutMs      bound for stop() worker round-trip (default 3000).
 *   onStop(reason, event)  global hotkey or stop notification callback.
 *   onEvent(event)     diagnostics callback (ready, stderr, timeouts).
 */
export function createComputerUseDriver(options = {}) {
  const {
    platform = process.platform,
    spawnProcess = spawn,
    workerPath = WORKER_PATH,
    powershellPath: powershellOverride,
    env = process.env,
    cwd,
    startupTimeoutMs = STARTUP_TIMEOUT_MS,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    stopTimeoutMs = STOP_TIMEOUT_MS,
    onStop,
    onEvent,
  } = options;

  let child = null;
  let startPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let readySettled = false;
  let nextId = 1;
  let buffer = '';
  let closed = false;
  let exitRecord = null;
  let readyOk = false;
  let generation = 1;
  const pending = new Map();

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
      entry.reject(driverError(code, `${message} (request ${entry.method}#${id})`));
    }
  }

  function settleReadyOk(info) {
    if (readySettled) return;
    readySettled = true;
    readyOk = true;
    readyResolve?.(info);
  }

  function settleReadyFail(error) {
    if (readySettled) return;
    readySettled = true;
    readyOk = false;
    readyReject?.(error);
  }

  function handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      emit({ kind: 'worker_protocol', warning: 'ignored malformed worker line' });
      return;
    }
    if (message && typeof message === 'object' && message.id !== undefined && message.id !== null) {
      const entry = pending.get(message.id);
      if (!entry) return; // Late response after timeout/abort/stop: ignore.
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error && typeof message.error === 'object')
        entry.reject(
          driverError(
            message.error.code || 'WORKER_ERROR',
            message.error.message || 'Worker request failed.',
          ),
        );
      else entry.resolve(message.result ?? {});
      return;
    }
    if (message && typeof message === 'object' && typeof message.event === 'string') {
      if (message.event === 'ready') {
        settleReadyOk(message);
        emit({ kind: 'worker_ready', ...message });
      } else if (message.event === 'stopped') {
        // Adopt worker-advanced generations (hotkey/idle stops): commands we
        // queued before that stop are stale even if our own stop() never ran.
        if (Number.isInteger(message.stopGeneration) && message.stopGeneration > generation)
          generation = message.stopGeneration;
        try {
          onStop?.(message.reason || 'stopped', message);
        } catch {
          // Caller callbacks must never break the transport.
        }
        emit({ kind: 'worker_stopped', ...message });
      } else {
        emit({ kind: 'worker_event', ...message });
      }
      return;
    }
    emit({ kind: 'worker_protocol', warning: 'ignored worker line without id or event' });
  }

  function onData(chunk) {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      handleLine(line.replace(/\r$/, ''));
    }
  }

  /**
   * Generation-bound native preemption: when an act batch times out or is
   * aborted after dispatch, the worker may still be sending input. Bump the
   * generation and deliver a best-effort stop so the orphan batch aborts and
   * its generation can never resume. Read-only methods never auto-stop.
   */
  function autoStopNative(reason) {
    try {
      if (platform !== 'win32' || closed || !child?.stdin) return;
      generation += 1;
      const line = { id: nextId++, method: 'stop', params: { reason }, generation };
      emit({ kind: 'worker_auto_stop', reason, generation });
      writeLine(line).catch(() => {});
    } catch {
      // Best effort: the caller already has its TIMEOUT/ABORTED error.
    }
  }

  function terminateOwned() {
    const target = child;
    child = null;
    if (!target) return;
    try {
      if (target.exitCode === null && target.signalCode === null) target.kill();
    } catch {
      // Best effort: the worker also exits on stdin EOF.
    }
  }

  function ensureStarted() {
    if (closed) throw driverError('DRIVER_CLOSED', 'Computer-use driver is closed.');
    if (platform !== 'win32')
      throw driverError(
        'UNSUPPORTED_PLATFORM',
        `Computer use needs Windows, current platform is ${platform}.`,
      );
    // Never hand out the worker before its ready event: early writes would
    // reorder concurrent requests and bypass worker-side startup checks.
    if (child && readyOk) return Promise.resolve(child);
    if (startPromise) return startPromise;
    readySettled = false;
    startPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
      let current;
      try {
        const command = powershellOverride || powershellPath(env);
        const args = [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          workerPath,
        ];
        current = spawnProcess(command, args, {
          cwd,
          env: { ...env },
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        settleReadyFail(
          driverError('WORKER_SPAWN', `Cannot start the computer-use worker: ${error.message}`),
        );
        return;
      }
      child = current;
      const startupTimer = setTimeout(() => {
        const error = driverError(
          'WORKER_STARTUP_TIMEOUT',
          'The computer-use worker did not report ready in time.',
        );
        settleReadyFail(error);
        failPending('WORKER_STARTUP_TIMEOUT', 'The computer-use worker did not report ready in time.');
        terminateOwned();
      }, startupTimeoutMs);
      if (typeof startupTimer.unref === 'function') startupTimer.unref();
      const clearStartupTimer = () => clearTimeout(startupTimer);
      readyResolve = ((inner) => (info) => {
        clearStartupTimer();
        inner(info);
      })(readyResolve);
      const previousReject = readyReject;
      readyReject = (error) => {
        clearStartupTimer();
        previousReject(error);
      };
      try {
        current.stdout?.on('data', onData);
        current.stderr?.on('data', (chunk) => {
          emit({ kind: 'worker_stderr', message: String(chunk.toString('utf8')).slice(-2000) });
        });
        current.on('error', (error) => {
          exitRecord = { error: error.message };
          settleReadyFail(
            driverError('WORKER_SPAWN', `Computer-use worker failed to start: ${error.message}`),
          );
          failPending('WORKER_EXIT', 'The computer-use worker exited before answering.');
          emit({ kind: 'worker_exit', message: error.message });
        });
        const onGone = (code, signal) => {
          exitRecord = { code, signal };
          readyOk = false;
          settleReadyFail(
            driverError('WORKER_EXIT', 'The computer-use worker exited before reporting ready.'),
          );
          failPending('WORKER_EXIT', 'The computer-use worker exited before answering.');
          emit({ kind: 'worker_exit', code, signal });
        };
        current.on('exit', onGone);
      } catch (error) {
        settleReadyFail(
          driverError('WORKER_SPAWN', `Cannot observe the computer-use worker: ${error.message}`),
        );
      }
    }).then(
      () => child,
      (error) => {
        startPromise = null;
        throw error;
      },
    );
    return startPromise;
  }

  function writeLine(payload) {
    const target = child;
    if (!target?.stdin) throw driverError('WORKER_EXIT', 'The computer-use worker is not running.');
    return new Promise((resolve, reject) => {
      try {
        target.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (error) => {
          if (error)
            reject(driverError('WORKER_WRITE', `Cannot send to the computer-use worker: ${error.message}`));
          else resolve();
        });
      } catch (error) {
        reject(driverError('WORKER_WRITE', `Cannot send to the computer-use worker: ${error.message}`));
      }
    });
  }

  async function request(command, { signal, timeoutMs } = {}) {
    const { method, params } = validateCommand(command);
    if (closed) throw driverError('DRIVER_CLOSED', 'Computer-use driver is closed.');
    if (platform !== 'win32')
      throw driverError(
        'UNSUPPORTED_PLATFORM',
        `Computer use needs Windows, current platform is ${platform}.`,
      );
    if (signal?.aborted) throw driverError('ABORTED', `Computer-use ${method} was aborted before sending.`);
    const genAtEntry = generation;
    await ensureStarted();
    if (closed) throw driverError('DRIVER_CLOSED', 'Computer-use driver is closed.');
    // A stop/close that landed while starting invalidates this request: never
    // submit pre-stop work to the fresh worker.
    if (generation !== genAtEntry)
      throw driverError('STOPPED', `Computer-use ${method} was stopped before sending.`);
    if (signal?.aborted) throw driverError('ABORTED', `Computer-use ${method} was aborted before sending.`);
    const id = nextId++;
    const gen = generation;
    const mutating = isMutatingCommand(method, params);
    const deadline = timeoutMs ?? defaultTimeoutMs;
    let timer;
    let sent = false;
    const answer = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        emit({ kind: 'worker_timeout', method, id });
        if (mutating) autoStopNative('timeout');
        reject(driverError('TIMEOUT', `Computer-use ${method} timed out after ${deadline}ms.`));
      }, deadline);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, { resolve, reject, timer, method, gen, mutating });
    });
    if (signal) {
      const abort = () => {
        const entry = pending.get(id);
        if (entry) {
          pending.delete(id);
          clearTimeout(entry.timer);
          if (entry.mutating && sent) autoStopNative('aborted');
          entry.reject(driverError('ABORTED', `Computer-use ${method} was aborted while waiting.`));
        }
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      answer.finally(() => signal.removeEventListener?.('abort', abort)).catch(() => {});
    }
    try {
      await writeLine({ id, method, params, generation: gen });
      sent = true;
    } catch (error) {
      if (pending.has(id)) {
        pending.delete(id);
        clearTimeout(timer);
      }
      throw error;
    }
    return answer;
  }

  /**
   * Preemptive stop: writes directly to the worker without waiting for the
   * current request, then bounds the round-trip. Never queues behind act.
   */
  async function stop(reason = 'user') {
    const label = typeof reason === 'string' && reason ? reason : 'user';
    // Advance the generation before sending: anything queued from before
    // this stop is stale and must never resume, even if the worker already
    // buffered it. The stop line itself carries the fresh generation.
    generation += 1;
    const gen = generation;
    if (platform !== 'win32' || closed || (!child && !startPromise))
      return { stopped: true, reason: label, idle: true };
    try {
      await ensureStarted().catch(() => null);
      if (!child?.stdin) {
        try {
          onStop?.(label, { event: 'stopped', reason: label, local: true });
        } catch {}
        return { stopped: true, reason: label };
      }
      const id = nextId++;
      const answer = new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) emit({ kind: 'worker_timeout', method: 'stop', id });
          resolve({ stopped: true, reason: label, timeout: true });
        }, stopTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        pending.set(id, {
          method: 'stop',
          gen,
          timer,
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result ?? { stopped: true, reason: label });
          },
          reject: () => {
            clearTimeout(timer);
            resolve({ stopped: true, reason: label });
          },
        });
      });
      try {
        await writeLine({ id, method: 'stop', params: { reason: label }, generation: gen });
      } catch {
        pending.delete(id);
      }
      const result = await answer;
      failPendingExceptStop(label, gen);
      try {
        onStop?.(label, { event: 'stopped', reason: label, local: true });
      } catch {}
      emit({ kind: 'worker_stopped', event: 'stopped', reason: label, local: true });
      return result;
    } catch {
      try {
        onStop?.(label, { event: 'stopped', reason: label, local: true });
      } catch {}
      return { stopped: true, reason: label };
    }
  }

  function failPendingExceptStop(reason, gen) {
    for (const [id, entry] of [...pending]) {
      if (entry.method === 'stop') continue;
      // Never cancel newer work started after this stop began.
      if (entry.gen !== undefined && gen !== undefined && entry.gen > gen) continue;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(driverError('STOPPED', `Computer-use ${entry.method} was stopped (${reason}).`));
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    generation += 1;
    readyOk = false;
    failPending('DRIVER_CLOSED', 'Computer-use driver was closed.');
    settleReadyFail(driverError('DRIVER_CLOSED', 'Computer-use driver was closed.'));
    const target = child;
    if (!target) {
      startPromise = null;
      return;
    }
    try {
      target.stdin?.end?.();
    } catch {}
    // Short grace for the clean EOF exit, then terminate only our own child.
    // The worker unregisters the global hotkey and releases held inputs and
    // the singleton mutex on EOF or on termination.
    const exited = () =>
      target.exitCode !== null && target.exitCode !== undefined
        ? true
        : target.signalCode !== null && target.signalCode !== undefined;
    const waitForExit = (ms) =>
      new Promise((resolve) => {
        if (exited()) return resolve();
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === 'function') timer.unref();
        target.on?.('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    await waitForExit(Math.min(500, CLOSE_TIMEOUT_MS));
    terminateOwned();
    await waitForExit(CLOSE_TIMEOUT_MS);
    startPromise = null;
  }

  return {
    request,
    stop,
    close,
    get started() {
      return Boolean(child);
    },
    get pid() {
      return child?.pid;
    },
    get closedFlag() {
      return closed;
    },
    get generation() {
      return generation;
    },
  };
}
