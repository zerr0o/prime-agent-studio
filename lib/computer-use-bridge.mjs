// Computer Use native bridge: private named-pipe capability for agent tools.
// Mirrors the roadmap bridge pattern: bearer token, native identity resolved
// from the real ledger (never model supplied), per-owner lease checks.
// Image payloads only travel inside computer_observe tool results as
// ImageContent. Routine status never carries pixels.

import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { open, realpath, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { COMPUTER_USE_MAX_IMAGE_BYTES } from './computer-use.mjs';
import { MAX_IMAGE_DIMENSION, getImageDimensions } from '../runtime/computer-use-image-safety.mjs';

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const bodyLimit = 128 * 1024;
const REQUEST_TIMEOUT_MS = 30000;

const fail = (status, message, code = 'computer_use_failed') =>
  Object.assign(new Error(message), { status, code });

function validCaller(caller) {
  return (
    record(caller) &&
    typeof caller.sessionId === 'string' &&
    typeof caller.rootSessionId === 'string' &&
    typeof caller.ownerId === 'string' &&
    typeof caller.cwd === 'string'
  );
}

function cleanNumber(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function validateObserveParams(params) {
  const out = {};
  if (params.windowId !== undefined) {
    if (typeof params.windowId !== 'string' || !params.windowId || params.windowId.length > 500)
      throw fail(400, 'Invalid windowId for computer observe.', 'computer_use_invalid');
    out.windowId = params.windowId;
  }
  if (params.region !== undefined) {
    if (!record(params.region))
      throw fail(400, 'Invalid region for computer observe.', 'computer_use_invalid');
    const { x, y, width, height } = params.region;
    if (
      ![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value)) ||
      width <= 0 ||
      height <= 0 ||
      width > 8192 ||
      height > 8192
    )
      throw fail(400, 'Invalid region for computer observe.', 'computer_use_invalid');
    out.region = { x, y, width, height };
  }
  if (params.maxWidth !== undefined) {
    if (!Number.isSafeInteger(params.maxWidth) || params.maxWidth < 16 || params.maxWidth > 4096)
      throw fail(400, 'Observe maxWidth must be an integer between 16 and 4096.', 'computer_use_invalid');
    out.maxWidth = params.maxWidth;
  }
  return out;
}

const ACTION_TYPES = new Set([
  'click',
  'double_click',
  'move',
  'drag',
  'scroll',
  'keypress',
  'type',
  'wait',
  'set_value',
]);

function validFrameDimensions(frame) {
  return (
    record(frame) &&
    Number.isFinite(frame.width) &&
    Number.isFinite(frame.height) &&
    frame.width >= 1 &&
    frame.height >= 1 &&
    frame.width <= 8192 &&
    frame.height <= 8192
  );
}

function validFrameBounds(frame) {
  const bounds = frame?.bounds;
  if (!record(bounds)) return false;
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width >= 1 &&
    bounds.height >= 1 &&
    bounds.width <= 8192 &&
    bounds.height <= 8192
  );
}

function validateActParams(params, frame, backend = 'native') {
  if (!record(params)) throw fail(400, 'Computer act needs an action batch.', 'computer_use_invalid');
  if (typeof params.frameId !== 'string' || !params.frameId)
    throw fail(400, 'Computer act needs a fresh frameId from computer observe.', 'computer_use_stale_frame');
  if (!Array.isArray(params.actions) || params.actions.length < 1 || params.actions.length > 12)
    throw fail(400, 'Computer act accepts 1 to 12 actions per batch.', 'computer_use_invalid');
  if (!validFrameDimensions(frame))
    throw fail(
      409,
      'This screenshot is stale. Observe again for a fresh frame before acting.',
      'computer_use_stale_frame',
    );
  // Screenshot pixels are addressed 0 <= x < width, 0 <= y < height. The
  // upper edge maps outside the captured image, so it is rejected.
  const width = Math.floor(frame.width);
  const height = Math.floor(frame.height);
  const actions = params.actions.map((action) => {
    if (!record(action) || !ACTION_TYPES.has(action.type))
      throw fail(400, 'Unknown computer action type.', 'computer_use_invalid');
    const out = { type: action.type };
    if (action.elementId !== undefined) {
      if (backend !== 'cua')
        throw fail(400, 'Element actions require the CUA backend.', 'computer_use_invalid');
      if (typeof action.elementId !== 'string' || !action.elementId || action.elementId.length > 256)
        throw fail(400, 'Invalid CUA elementId.', 'computer_use_invalid');
      if (!['click', 'double_click', 'scroll', 'keypress', 'type', 'set_value'].includes(action.type))
        throw fail(400, 'This action cannot target an elementId.', 'computer_use_invalid');
      if (action.x !== undefined || action.y !== undefined || action.path !== undefined)
        throw fail(400, 'Use either elementId or pixel coordinates, not both.', 'computer_use_invalid');
      out.elementId = action.elementId;
    }
    if (action.type === 'set_value') {
      if (
        backend !== 'cua' ||
        !out.elementId ||
        typeof action.value !== 'string' ||
        action.value.length > 2000
      )
        throw fail(
          400,
          'set_value needs CUA, a fresh elementId and a value of at most 2000 characters.',
          'computer_use_invalid',
        );
      out.value = action.value;
    } else if (action.value !== undefined) {
      throw fail(400, 'value is only valid for set_value.', 'computer_use_invalid');
    }
    if (
      frame.kind === 'accessibility' &&
      (action.x !== undefined || action.y !== undefined || action.path !== undefined)
    )
      throw fail(
        400,
        'Accessibility-only frames have no pixel coordinates. Use elementId or take a screenshot.',
        'computer_use_invalid',
      );
    if (action.x !== undefined || action.y !== undefined) {
      const x = cleanNumber(action.x, 0, width - 1);
      const y = cleanNumber(action.y, 0, height - 1);
      if (x === null || y === null)
        throw fail(400, 'Action coordinates are outside the observed frame.', 'computer_use_invalid');
      out.x = x;
      out.y = y;
    }
    if (action.button !== undefined) {
      if (!['left', 'right', 'middle'].includes(action.button))
        throw fail(400, 'Invalid mouse button.', 'computer_use_invalid');
      out.button = action.button;
    }
    if (action.text !== undefined) {
      if (typeof action.text !== 'string' || !action.text || action.text.length > 2000)
        throw fail(400, 'Invalid text for computer act.', 'computer_use_invalid');
      out.text = action.text;
    }
    if (action.keys !== undefined) {
      if (!Array.isArray(action.keys) || action.keys.length < 1 || action.keys.length > 8)
        throw fail(400, 'Computer act accepts 1 to 8 keys per press.', 'computer_use_invalid');
      for (const key of action.keys) {
        if (typeof key !== 'string' || !key.trim() || key.length > 32)
          throw fail(400, 'Key names must be 1 to 32 characters.', 'computer_use_invalid');
      }
      out.keys = [...action.keys];
    }
    for (const field of ['deltaX', 'deltaY']) {
      if (action[field] !== undefined) {
        const value = cleanNumber(action[field], -100, 100);
        if (value === null || !Number.isInteger(value))
          throw fail(400, 'Scroll deltas accept integer -100 to 100 wheel ticks.', 'computer_use_invalid');
        out[field] = value;
      }
    }
    if (action.path !== undefined) {
      if (!Array.isArray(action.path) || action.path.length > 20)
        throw fail(400, 'Drag path accepts up to 20 points.', 'computer_use_invalid');
      out.path = action.path.map((point) => {
        if (!record(point)) throw fail(400, 'Invalid drag path.', 'computer_use_invalid');
        const x = cleanNumber(point.x, 0, width - 1);
        const y = cleanNumber(point.y, 0, height - 1);
        if (x === null || y === null)
          throw fail(400, 'Drag path is outside the observed frame.', 'computer_use_invalid');
        return { x, y };
      });
    }
    if (action.ms !== undefined) {
      if (!Number.isSafeInteger(action.ms) || action.ms < 1 || action.ms > 5000)
        throw fail(400, 'Wait must be an integer between 1 and 5000 ms.', 'computer_use_invalid');
      out.ms = action.ms;
    }
    return out;
  });
  for (const action of actions) {
    if (
      ['click', 'double_click', 'move', 'drag'].includes(action.type) &&
      !action.elementId &&
      action.x === undefined
    )
      throw fail(400, 'Pointer actions need x/y or a CUA elementId.', 'computer_use_invalid');
    if (action.type === 'drag' && !action.path?.length)
      throw fail(400, 'Drag needs a nonempty path.', 'computer_use_invalid');
    if (action.type === 'type' && !action.text) throw fail(400, 'Type needs text.', 'computer_use_invalid');
    if (action.type === 'keypress' && !action.keys?.length)
      throw fail(400, 'Keypress needs keys.', 'computer_use_invalid');
    if (action.type === 'wait' && action.ms === undefined)
      throw fail(400, 'Wait needs ms.', 'computer_use_invalid');
    if (action.type === 'scroll' && (action.deltaX ?? 0) === 0 && (action.deltaY ?? 0) === 0)
      throw fail(400, 'Scroll needs a nonzero deltaX or deltaY.', 'computer_use_invalid');
  }
  const observeAfter = params.observeAfter === undefined ? false : params.observeAfter;
  if (typeof observeAfter !== 'boolean')
    throw fail(400, 'Invalid observeAfter flag.', 'computer_use_invalid');
  let observeOptions;
  if (params.observeOptions !== undefined) {
    if (!observeAfter || !record(params.observeOptions))
      throw fail(400, 'observeOptions requires observeAfter: true and an object.', 'computer_use_invalid');
    observeOptions = validateObserveParams(params.observeOptions);
  }
  const deliveryMode = params.deliveryMode;
  if (
    deliveryMode !== undefined &&
    (!['foreground', 'background'].includes(deliveryMode) || backend !== 'cua')
  )
    throw fail(
      400,
      'deliveryMode is foreground or background and requires the CUA backend.',
      'computer_use_invalid',
    );
  return { frameId: params.frameId, actions, observeAfter, observeOptions, deliveryMode };
}

function publicFrame(frame) {
  if (!frame) return frame;
  const { driverFrame: _private, ...visible } = frame;
  return visible;
}

function cuaFrameBinding(response, kind) {
  const binding = response?.driverFrame;
  if (
    !record(binding) ||
    binding.backend !== 'cua' ||
    binding.kind !== kind ||
    JSON.stringify(binding).length > 8192
  )
    throw fail(
      502,
      'CUA returned an invalid snapshot binding. Inspect or observe again.',
      'computer_use_failed',
    );
  return structuredClone(binding);
}

function accessibilityOf(response) {
  const source = Array.isArray(response?.elements) ? response.elements : [];
  const elements = [];
  let budget = 96000;
  let truncated = response?.truncated === true || source.length > 200;
  for (const entry of source.slice(0, 200)) {
    if (
      !record(entry) ||
      typeof entry.elementId !== 'string' ||
      !entry.elementId ||
      entry.elementId.length > 256
    )
      continue;
    const element = { elementId: entry.elementId };
    if (Number.isSafeInteger(entry.elementIndex) && entry.elementIndex >= 0)
      element.elementIndex = entry.elementIndex;
    for (const key of ['role', 'label', 'value']) {
      if (typeof entry[key] === 'string') {
        const max = key === 'role' ? 128 : 1000;
        element[key] = entry[key].slice(0, max);
        if (entry[key].length > max) truncated = true;
      }
    }
    if (typeof entry.enabled === 'boolean') element.enabled = entry.enabled;
    if (
      record(entry.frame) &&
      ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(entry.frame[key]))
    ) {
      element.frame = Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, entry.frame[key]]));
    }
    budget -= JSON.stringify(element).length;
    if (budget < 0) {
      truncated = true;
      break;
    }
    elements.push(element);
  }
  return { elements, truncated };
}

function validateWindowWait(params) {
  const filters = {};
  for (const key of ['windowId', 'processName', 'title']) {
    if (params[key] === undefined) continue;
    if (typeof params[key] !== 'string' || !params[key].trim() || params[key].length > 500)
      throw fail(400, `Invalid ${key} for window wait.`, 'computer_use_invalid');
    filters[key] = params[key].trim();
  }
  if (!Object.keys(filters).length)
    throw fail(400, 'Window wait needs windowId, processName or title.', 'computer_use_invalid');
  if (filters.processName && !filters.processName.replace(/\.exe$/i, '').trim())
    throw fail(400, 'Invalid processName for window wait.', 'computer_use_invalid');
  const timeoutMs = params.timeoutMs === undefined ? 10000 : params.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 20000)
    throw fail(400, 'Window wait timeoutMs must be an integer from 100 to 20000.', 'computer_use_invalid');
  return { filters, timeoutMs };
}

function matchesWindow(window, filters) {
  if (!record(window) || typeof window.id !== 'string' || !window.id) return false;
  const processName = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/\.exe$/, '');
  return (
    (!filters.windowId || window.id === filters.windowId) &&
    (!filters.processName || processName(window.processName) === processName(filters.processName)) &&
    (!filters.title ||
      String(window.title || '')
        .toLowerCase()
        .includes(filters.title.toLowerCase()))
  );
}

// Race only the read-only result, not the native request itself. Cancelling a
// wait must not preempt unrelated input or send a stop to the shared worker.
function waitPulse(pending, ms, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () =>
      finish(fail(409, 'Window wait was cancelled. Refresh before acting.', 'computer_use_wait_cancelled'));
    timer = setTimeout(() => finish(null, null), Math.max(1, Math.ceil(ms)));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    pending?.then(
      (value) => finish(null, value),
      (error) => finish(error),
    );
  });
}

// Screenshot pixels to physical screen pixels using the captured frame bounds.
export function toPhysicalCoordinates(action, frame) {
  if (
    !frame ||
    typeof frame.width !== 'number' ||
    typeof frame.height !== 'number' ||
    !frame.width ||
    !frame.height
  )
    return action;
  const bounds = frame.bounds || { x: 0, y: 0, width: frame.width, height: frame.height };
  const scaleX = bounds.width / frame.width;
  const scaleY = bounds.height / frame.height;
  // Fractional screenshot pixels near the far edge can round one physical
  // pixel past the captured bounds, so mapped input is clamped inside them.
  const maxX = bounds.x + bounds.width - 1;
  const maxY = bounds.y + bounds.height - 1;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const map = (x, y) => ({
    x: clamp(Math.round(bounds.x + x * scaleX), bounds.x, maxX),
    y: clamp(Math.round(bounds.y + y * scaleY), bounds.y, maxY),
  });
  const out = { ...action };
  if (typeof action.x === 'number' && typeof action.y === 'number')
    Object.assign(out, map(action.x, action.y));
  if (Array.isArray(action.path)) out.path = action.path.map((point) => map(point.x, point.y));
  return out;
}

/** Native capability bridge for one Computer Use lease manager. */
export function createComputerUseBridge({
  manager,
  resolveCaller,
  isOwnerActive = () => true,
  now = Date.now,
} = {}) {
  if (!manager) throw new Error('Computer Use bridge needs a lease manager.');
  if (typeof resolveCaller !== 'function')
    throw new Error('Computer Use bridge needs a native caller resolver.');
  const instanceId = randomUUID();
  const token = randomBytes(32).toString('hex');
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\prime-studio-computer-${instanceId}`
      : join(tmpdir(), `prime-computer-${instanceId}.sock`);
  let closed = false;
  let releaseRevision = 0;
  const pendingWaits = new Set();

  const denied = () => fail(403, 'This agent no longer owns an active Studio session.');
  const disabled = () =>
    fail(
      409,
      'Computer Use is off. Enable it in Studio with the Computer Use toggle before using desktop tools. Tools cannot enable it themselves.',
      'computer_use_disabled',
    );

  // Native driver failures map to bridge errors: worker parameter mistakes
  // are the model's fault (400), geometry races are stale frames (409),
  // timeouts are ambiguous (504), and a dead worker is dropped so the next
  // request spawns a fresh one.
  function mapDriverError(error, timeoutMessage) {
    if (
      typeof error?.code === 'string' &&
      error.code.startsWith('computer_use_') &&
      Number.isInteger(error.status)
    )
      throw error;
    if (error?.code === 'INVALID_PARAMS')
      throw fail(400, error.message || 'Invalid Computer Use parameters.', 'computer_use_invalid');
    if (error?.code === 'FOCUS_REFUSED') {
      manager.clearFrames();
      throw fail(
        409,
        error.message ||
          'Windows refused focus. Refresh the window list and observe before choosing another action.',
        'computer_use_focus_refused',
      );
    }
    if (/^(UNSUPPORTED_|AX_ONLY_FRAME|GUARDIAN_UNAVAILABLE)/.test(error?.code || ''))
      throw fail(
        409,
        error.message || 'This operation is not available with the selected backend.',
        'computer_use_unsupported',
      );
    if (
      [
        'STALE_FRAME',
        'STALE_GENERATION',
        'STOPPED',
        'WINDOW_MINIMIZED',
        'WINDOW_NOT_FOUND',
        'FOCUS_CHANGED',
      ].includes(error?.code)
    ) {
      manager.clearFrames();
      throw fail(
        409,
        `${error.message || 'The desktop changed.'} Observe again for a fresh frame before acting.`,
        'computer_use_stale_frame',
      );
    }
    if (
      error?.code === 'TIMEOUT' ||
      error?.name === 'AbortError' ||
      /timed out|timeout/i.test(error?.message || '')
    ) {
      manager.clearFrames();
      manager.setError(error?.message || 'Computer operation timed out.');
      throw fail(504, timeoutMessage, 'computer_use_timeout');
    }
    if (error?.code === 'WORKER_EXIT')
      throw fail(
        502,
        error.message || 'The desktop worker exited. Retry the operation.',
        'computer_use_unavailable',
      );
    manager.setError(error?.message || 'Computer operation failed.');
    throw fail(error?.status || 502, error?.message || 'Computer operation failed.');
  }

  async function ownerFor(caller) {
    if (!validCaller(caller)) throw denied();
    const owner = typeof manager.ownerInfo === 'function' ? manager.ownerInfo() : manager.status().owner;
    if (!owner || !owner.runId) throw disabled();
    if (caller.ownerId !== owner.runId) throw disabled();
    if (caller.sessionId !== owner.sessionId && caller.rootSessionId !== owner.sessionId) throw denied();
    if (!isOwnerActive(owner.runId)) throw denied();
    return owner;
  }

  async function withDriver(
    command,
    params,
    { timeoutMs = REQUEST_TIMEOUT_MS, signal, frameOp = false, shouldRequest, admissionCheck } = {},
  ) {
    admissionCheck?.();
    if (shouldRequest && !shouldRequest()) return null;
    // A stop or owner switch may land while driver creation awaits. Recheck
    // afterwards so a new request can never ride on a dead lease.
    const beforeOwner = manager.ownerInfo()?.runId || null;
    const beforeGeneration = manager.generation;
    const instance = await manager.driver();
    admissionCheck?.();
    if ((manager.ownerInfo()?.runId || null) !== beforeOwner)
      throw fail(
        409,
        'Computer Use stopped or switched owner before the request reached the desktop. Observe again only if still enabled.',
        'computer_use_stale_frame',
      );
    if (frameOp && manager.generation !== beforeGeneration)
      throw fail(
        409,
        'Computer Use frames were invalidated before the request reached the desktop. Observe again for a fresh frame.',
        'computer_use_stale_frame',
      );
    if (!instance || typeof instance.request !== 'function')
      throw fail(409, 'Computer Use driver is unavailable.', 'computer_use_unavailable');
    if (shouldRequest && !shouldRequest()) return null;
    const run = manager.track(instance.request({ method: command, params }, { timeoutMs, signal }));
    // A dead worker is dropped by exact instance so the next request mints
    // fresh; a newer replacement cached meanwhile is left untouched.
    run.catch((error) => {
      if (error?.code === 'WORKER_EXIT') manager.dropDriverInstance(instance);
    });
    return run;
  }

  // Single controller also serializes concurrent root/child batches: one act
  // runs at a time so mouse and keyboard input can never interleave.
  let actQueue = Promise.resolve();
  function enqueueAct(task) {
    const run = actQueue.catch(() => {}).then(task);
    actQueue = run.catch(() => {});
    return run;
  }

  async function verifyFrameFocus(frame, gate = {}) {
    if (!frame || typeof frame.windowId !== 'string' || !frame.windowId) return;
    let listing;
    try {
      listing = await withDriver('windows', { action: 'list' }, { ...gate, timeoutMs: 5000 });
    } catch (error) {
      manager.clearFrames();
      throw fail(
        409,
        'The desktop state could not be verified before acting. Observe again for a fresh frame.',
        'computer_use_stale_frame',
      );
    }
    const current = (listing?.windows || []).find((entry) => entry?.id === frame.windowId);
    if (!current) {
      manager.clearFrames();
      throw fail(
        409,
        'The observed window is gone. Observe again for a fresh frame before acting.',
        'computer_use_stale_frame',
      );
    }
    if (current.foreground === false) {
      manager.clearFrames();
      throw fail(
        409,
        'The observed window is no longer focused. Observe again for a fresh frame before acting.',
        'computer_use_stale_frame',
      );
    }
  }

  async function waitForWindow(caller, params, requestSignal) {
    const { filters, timeoutMs } = validateWindowWait(params);
    const generation = manager.generation;
    const started = performance.now();
    const deadline = started + timeoutMs;
    const controller = new AbortController();
    const signal = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
    pendingWaits.add(controller);
    const check = async () => {
      if (closed || signal.aborted)
        throw fail(409, 'Window wait was cancelled. Refresh before acting.', 'computer_use_wait_cancelled');
      await ownerFor(caller);
      if (generation !== manager.generation)
        throw fail(
          409,
          'The desktop changed during window wait. Refresh before acting.',
          'computer_use_stale_frame',
        );
    };
    const result = (windows) => ({
      found: windows.length > 0,
      timedOut: windows.length === 0,
      windows,
      ...(windows.length ? { window: windows.find((entry) => entry.foreground) || windows[0] } : {}),
      elapsedMs: Math.round(performance.now() - started),
      note: windows.length
        ? 'A matching window exists. Focus if needed and observe it before claiming task completion; window presence does not confirm application readiness.'
        : 'No matching window was observed within this wait. Launch may still finish. Refresh before retrying or switching methods; this is not proof of launch failure.',
    });
    try {
      let pending = null;
      let nextPollAt = started;
      while (true) {
        await check();
        let remaining = deadline - performance.now();
        if (remaining <= 0) return result([]);
        // Timers can wake early. Recheck the monotonic poll boundary before
        // starting another listing, not just the overall wait deadline.
        const pollRemaining = nextPollAt - performance.now();
        if (!pending && pollRemaining > 0) {
          await waitPulse(null, Math.min(remaining, pollRemaining), signal);
          continue;
        }
        // Retain one outstanding listing, including across deadline pulses.
        // A late result after cancellation/timeout is handled but never used.
        pending ??= withDriver(
          'windows',
          { action: 'list' },
          {
            frameOp: true,
            shouldRequest: () => !closed && !signal.aborted && performance.now() < deadline,
          },
        ).then((listing) => ({ listing }));
        const response = await waitPulse(pending, Math.min(250, remaining), signal);
        await check();
        remaining = deadline - performance.now();
        if (remaining <= 0) return result([]);
        if (!response) continue;
        pending = null;
        const windows = (Array.isArray(response.listing?.windows) ? response.listing.windows : []).filter(
          (entry) => matchesWindow(entry, filters),
        );
        if (windows.length) return result(windows);
        nextPollAt = Math.min(deadline, performance.now() + 250);
      }
    } finally {
      pendingWaits.delete(controller);
    }
  }

  async function observeFor(caller, params, gate = {}) {
    gate.admissionCheck?.();
    const owner = await ownerFor(caller);
    if (owner.imageCapable === false)
      throw fail(
        409,
        'The current model does not support images. Choose an image capable model to use Computer Observe.',
        'computer_use_no_image_model',
      );
    const clean = validateObserveParams(params || {});
    if (owner.backend === 'cua' && clean.region)
      throw fail(
        409,
        'CUA region captures are unsupported in this beta. Select a windowId for a full-window capture; the original backend supports regions.',
        'computer_use_unsupported',
      );
    const generation = manager.generation;
    let response;
    try {
      response = await withDriver('observe', clean, { ...gate, frameOp: true });
    } catch (error) {
      throw mapDriverError(error, 'Computer observe timed out. Take a fresh screenshot before acting.');
    }
    if (generation !== manager.generation)
      throw fail(
        409,
        'Computer Use stopped during observe. Take a fresh screenshot only if still enabled.',
        'computer_use_stale_frame',
      );
    const image = response?.image;
    const frame = response?.frame;
    if (!image || typeof image.data !== 'string' || !validFrameDimensions(frame) || !validFrameBounds(frame))
      throw fail(502, 'Computer driver returned an invalid screenshot.', 'computer_use_failed');
    if (!['image/jpeg', 'image/png'].includes(image.mimeType))
      throw fail(502, 'Computer driver returned an unsupported image format.', 'computer_use_failed');
    if (image.data.length > Math.ceil(COMPUTER_USE_MAX_IMAGE_BYTES / 3) * 4)
      throw fail(
        413,
        'Computer screenshot exceeds the size limit. Retry with a smaller region.',
        'computer_use_too_large',
      );
    const pixels = getImageDimensions(image);
    if (
      frame.width > MAX_IMAGE_DIMENSION ||
      frame.height > MAX_IMAGE_DIMENSION ||
      (pixels && (pixels.width > MAX_IMAGE_DIMENSION || pixels.height > MAX_IMAGE_DIMENSION))
    )
      throw fail(
        413,
        'Computer screenshots must fit within 2000 pixels on both axes. Request a smaller capture.',
        'computer_use_too_large',
      );
    if (pixels && (pixels.width !== frame.width || pixels.height !== frame.height))
      throw fail(
        502,
        'Screenshot pixels do not match frame dimensions. Do not act on this image.',
        'computer_use_failed',
      );
    const driverFrame = owner.backend === 'cua' ? cuaFrameBinding(response, 'screenshot') : null;
    if (driverFrame) manager.clearFrames();
    // Native observation metadata lives beside `frame`. Also accept the
    // nested shape used by older adapters so the stored guard stays complete.
    const desktopBounds = record(response.desktopBounds) ? response.desktopBounds : frame.desktopBounds;
    const foregroundWindowId =
      typeof response.foregroundWindowId === 'string'
        ? response.foregroundWindowId
        : frame.foregroundWindowId;
    const frameId = manager.setFrame({
      ...(driverFrame ? { driverFrame, backend: 'cua', kind: 'screenshot' } : {}),
      captureOptions: clean,
      width: frame.width,
      height: frame.height,
      bounds: record(frame.bounds) ? frame.bounds : { x: 0, y: 0, width: frame.width, height: frame.height },
      capturedAt: typeof frame.capturedAt === 'string' ? frame.capturedAt : new Date(now()).toISOString(),
      ...(typeof frame.windowId === 'string' ? { windowId: frame.windowId } : {}),
      ...(clean.windowId ? { windowId: clean.windowId } : {}),
      // Native geometry binding: the worker verifies these before input.
      ...(record(desktopBounds) ? { desktopBounds } : {}),
      ...(typeof foregroundWindowId === 'string' && foregroundWindowId ? { foregroundWindowId } : {}),
    });
    const stored = manager.takeFrame(frameId);
    manager.recordAction({
      type: 'observe',
      frameId,
      ...(clean.windowId ? { windowId: clean.windowId } : {}),
    });
    return {
      image: { data: image.data, mimeType: image.mimeType },
      frame: publicFrame(stored),
      ...(driverFrame ? accessibilityOf(response) : {}),
      ...(record(response.timing) ? { timing: response.timing } : {}),
    };
  }

  async function inspectFor(caller, params, gate = {}) {
    gate.admissionCheck?.();
    const owner = await ownerFor(caller);
    if (owner.backend !== 'cua')
      throw fail(
        409,
        'Accessibility inspection requires CUA mode. The original backend uses screenshots.',
        'computer_use_unsupported',
      );
    if (typeof params.windowId !== 'string' || !params.windowId || params.windowId.length > 500)
      throw fail(400, 'Computer inspect requires a windowId from computer_windows.', 'computer_use_invalid');
    const generation = manager.generation;
    let response;
    try {
      response = await withDriver('inspect', { windowId: params.windowId }, { ...gate, frameOp: true });
    } catch (error) {
      throw mapDriverError(error, 'Computer inspect timed out. Inspect again before acting.');
    }
    if (generation !== manager.generation)
      throw fail(409, 'Computer Use stopped during inspection.', 'computer_use_stale_frame');
    if (!validFrameDimensions(response?.frame) || !validFrameBounds(response?.frame))
      throw fail(502, 'CUA returned an invalid inspection frame.', 'computer_use_failed');
    const driverFrame = cuaFrameBinding(response, 'accessibility');
    manager.clearFrames();
    const frameId = manager.setFrame({
      width: response.frame.width,
      height: response.frame.height,
      bounds: response.frame.bounds,
      windowId: params.windowId,
      captureOptions: { windowId: params.windowId },
      capturedAt: response.frame.capturedAt || new Date(now()).toISOString(),
      driverFrame,
      backend: 'cua',
      kind: 'accessibility',
    });
    manager.recordAction({ type: 'inspect', frameId, windowId: params.windowId });
    return {
      frame: publicFrame(manager.takeFrame(frameId)),
      ...accessibilityOf(response),
      ...(record(response.timing) ? { timing: response.timing } : {}),
      note: 'Accessibility state is point-in-time, not proof of task completion. Use elementId from this frame, never pixel coordinates. Inspect or observe again after acting.',
    };
  }

  async function doAct(caller, params, gate = {}) {
    gate.admissionCheck?.();
    // Revalidate after queueing: a stop, focus change or earlier batch may
    // have invalidated the lease while this batch waited its turn.
    const owner = await ownerFor(caller);
    if (owner.imageCapable === false)
      throw fail(
        409,
        'The current model does not support images. Choose an image capable model to use Computer Act.',
        'computer_use_no_image_model',
      );
    const stored = typeof params.frameId === 'string' ? manager.takeFrame(params.frameId) : null;
    if (!stored || stored.generation !== manager.generation)
      throw fail(
        409,
        'This screenshot is stale. Observe again for a fresh frame before acting.',
        'computer_use_stale_frame',
      );
    const cua = owner.backend === 'cua';
    if (cua && stored.driverFrame?.backend !== 'cua')
      throw fail(
        409,
        'The CUA snapshot binding is stale. Inspect or observe again.',
        'computer_use_stale_frame',
      );
    const clean = validateActParams(params, stored, owner.backend || 'native');
    // CUA binds each target to its own window/snapshot and may deliver in the
    // background. The original driver requires the observed foreground window.
    if (!cua) await verifyFrameFocus(stored, gate);
    await ownerFor(caller);
    if (stored.generation !== manager.generation)
      throw fail(
        409,
        'Computer Use changed before input. Inspect or observe again.',
        'computer_use_stale_frame',
      );
    const physical = cua
      ? clean.actions
      : clean.actions.map((action) => toPhysicalCoordinates(action, stored));
    // The worker revalidates screen layout, window geometry and focus
    // natively before sending any input. Keyboard input additionally
    // requires the observed foreground window to still be focused.
    const needsFocus = clean.actions.some((action) => action.type === 'keypress' || action.type === 'type');
    const expectedFrame = {
      ...(typeof stored.windowId === 'string' ? { windowId: stored.windowId } : {}),
      ...(record(stored.bounds) ? { bounds: stored.bounds } : {}),
      ...(record(stored.desktopBounds) ? { desktopBounds: stored.desktopBounds } : {}),
      ...(typeof stored.foregroundWindowId === 'string'
        ? { foregroundWindowId: stored.foregroundWindowId }
        : {}),
      requireForeground: needsFocus,
      ...(cua ? { driverFrame: stored.driverFrame } : {}),
    };
    const generation = manager.generation;
    let result;
    try {
      result = await withDriver(
        'act',
        {
          actions: physical,
          expectedFrame,
          ...(clean.deliveryMode ? { deliveryMode: clean.deliveryMode } : {}),
        },
        { ...gate, frameOp: true },
      );
    } catch (error) {
      // The driver may have sent some input before an error. Never preserve
      // a reusable screenshot after dispatch, including unknown failures.
      manager.clearFrames();
      throw mapDriverError(
        error,
        'Computer act timed out with an ambiguous result. Observe again; never replay the same batch blindly.',
      );
    }
    if (generation !== manager.generation)
      throw fail(
        409,
        'Computer Use stopped during the action. Observe again only if still enabled.',
        'computer_use_stale_frame',
      );
    // Acting invalidates every previous frame: geometry may have changed, so
    // older screenshots must never drive later batches.
    manager.clearFrames();
    const executed =
      Number.isSafeInteger(result?.executed) &&
      result.executed >= 0 &&
      result.executed <= clean.actions.length
        ? result.executed
        : cua
          ? null
          : clean.actions.length;
    manager.recordAction({
      type: 'act',
      executed,
      frameId: params.frameId,
    });
    const completed = {
      ...result,
      executed,
      ...(executed === null ? { partial: true, inputState: 'unknown' } : {}),
      applicationState: 'unverified',
    };
    if (clean.observeAfter) {
      // Keep the exact observation scope and resolution, unless explicitly
      // overridden. A newly launched app may require observing another window.
      const options = clean.observeOptions ??
        stored.captureOptions ?? {
          ...(stored.windowId ? { windowId: stored.windowId } : { region: stored.bounds }),
          maxWidth: Math.min(4096, Math.floor(stored.width)),
        };
      try {
        const next = await observeFor(caller, options, gate);
        return { ...completed, observe: next };
      } catch (error) {
        // Input already completed. A failed follow-up capture must never look
        // like a failed click that is safe to repeat.
        return {
          ...completed,
          observationError: {
            code: error.code || 'computer_use_failed',
            message: `Input completed, but verification capture failed. Do not replay the batch; refresh or wait for the expected window. ${String(error.message || 'Capture unavailable.').slice(0, 500)}`,
          },
        };
      }
    }
    return completed;
  }

  async function dispatch(input, requestSignal) {
    if (closed) throw denied();
    if (!record(input) || !record(input.identity) || !record(input.params || {}))
      throw fail(400, 'Invalid Computer Use request.', 'computer_use_invalid');
    const admittedControl = manager.status().controlRevision;
    const admittedRelease = releaseRevision;
    const admissionCheck = () => {
      if (
        closed ||
        requestSignal?.aborted ||
        admittedRelease !== releaseRevision ||
        admittedControl !== manager.status().controlRevision
      )
        throw fail(
          409,
          'Computer Use control changed or this request was cancelled before dispatch. Take a fresh observation only if still enabled.',
          'computer_use_stale_frame',
        );
    };
    const gate = { signal: requestSignal, admissionCheck };
    const caller = await resolveCaller(input.identity).catch(() => {
      throw denied();
    });

    if (input.action === 'status') {
      await manager.refreshBackends?.();
      // Status is truthful while off: it never spawns the worker, captures,
      // or moves input. Only the current owner also gets live driver state.
      const owner = manager.ownerInfo();
      let mine =
        !!owner &&
        !!owner.runId &&
        caller.ownerId === owner.runId &&
        (caller.sessionId === owner.sessionId || caller.rootSessionId === owner.sessionId) &&
        isOwnerActive(owner.runId);
      let driverStatus = null;
      if (mine) {
        try {
          driverStatus = await withDriver('status', {}, { timeoutMs: 10000, signal: requestSignal });
          const live = manager.ownerInfo();
          mine =
            !!live &&
            !!live.runId &&
            caller.ownerId === live.runId &&
            (caller.sessionId === live.sessionId || caller.rootSessionId === live.sessionId) &&
            isOwnerActive(live.runId);
          if (!mine || manager.status().controlRevision !== admittedControl) driverStatus = null;
          // Truthful emergency shortcut: the worker reports whether the
          // global stop hotkey actually registered (hotkeyRegistered boolean,
          // optional hotkeyError string). Cached for HTTP status polling.
          if (driverStatus && typeof driverStatus === 'object') {
            const hotkeyError = driverStatus.hotkeyError;
            const failed = driverStatus.hotkeyRegistered === false || !!hotkeyError;
            if (failed || driverStatus.hotkeyRegistered === true || driverStatus.hotkey === null) {
              manager.setHotkeyState({
                registered: !failed && driverStatus.hotkeyRegistered === true,
                error: typeof hotkeyError === 'string' && hotkeyError ? hotkeyError : null,
              });
            }
          }
        } catch (error) {
          driverStatus = { supported: true, error: String(error?.message || error).slice(0, 500) };
        }
      }
      const liveOwner = manager.ownerInfo();
      mine =
        !!liveOwner &&
        !!liveOwner.runId &&
        caller.ownerId === liveOwner.runId &&
        (caller.sessionId === liveOwner.sessionId || caller.rootSessionId === liveOwner.sessionId) &&
        isOwnerActive(liveOwner.runId);
      if (!mine || manager.status().controlRevision !== admittedControl) driverStatus = null;
      const state = manager.status();
      return { ...state, mine, driver: driverStatus, owner: state.owner };
    }

    admissionCheck();
    if (input.action === 'windows') {
      await ownerFor(caller);
      const params = record(input.params) ? input.params : {};
      const action = params.action === undefined ? 'list' : params.action;
      if (!['list', 'focus', 'wait'].includes(action))
        throw fail(400, 'Unknown windows action.', 'computer_use_invalid');
      if (action === 'focus' && (typeof params.windowId !== 'string' || !params.windowId))
        throw fail(400, 'Focusing a window needs a windowId.', 'computer_use_invalid');
      try {
        if (action === 'wait') return await manager.track(waitForWindow(caller, params, requestSignal));
        const run = async () => {
          admissionCheck();
          await ownerFor(caller);
          admissionCheck();
          if (action === 'focus') manager.clearFrames();
          return withDriver(
            'windows',
            { action, ...(params.windowId ? { windowId: params.windowId } : {}) },
            { ...gate, frameOp: action === 'focus' },
          );
        };
        return action === 'focus' ? await enqueueAct(run) : await run();
      } catch (error) {
        throw mapDriverError(error, 'Computer windows timed out. Retry the listing.');
      }
    }

    if (input.action === 'observe') {
      return enqueueAct(() => observeFor(caller, input.params || {}, gate));
    }
    if (input.action === 'inspect') {
      return enqueueAct(() => inspectFor(caller, input.params || {}, gate));
    }

    if (input.action === 'act') {
      const owner = await ownerFor(caller);
      if (owner.imageCapable === false)
        throw fail(
          409,
          'The current model does not support images. Choose an image capable model to use Computer Act.',
          'computer_use_no_image_model',
        );
      const params = record(input.params) ? input.params : {};
      return enqueueAct(() => doAct(caller, params, gate));
    }

    if (input.action === 'release') {
      // Truthful release: stop any in-flight desktop input and discard every
      // frame. The lease itself stays enabled.
      await ownerFor(caller);
      admissionCheck();
      releaseRevision += 1;
      await manager.releaseInput();
      return { released: true };
    }

    throw fail(400, 'Unknown Computer Use operation.', 'computer_use_invalid');
  }

  const server = createServer(async (req, res) => {
    const respond = (status, data) => {
      if (!res.destroyed) {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      }
    };
    const supplied = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return respond(403, { error: 'Computer Use capability is unavailable.', code: 'computer_use_denied' });
    if (req.method !== 'POST' || req.url !== '/')
      return respond(404, { error: 'Unknown Computer Use endpoint.' });
    const controller = new AbortController();
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', disconnected);
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > bodyLimit)
          throw fail(413, 'Computer Use request exceeds 128 KiB.', 'computer_use_too_large');
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw fail(400, 'Invalid Computer Use JSON request.', 'computer_use_invalid');
      }
      respond(200, await dispatch(input, controller.signal));
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      respond(status, {
        // Operational failures (4xx plus gateway timeouts) carry curated
        // guidance such as never replaying an ambiguous batch. Only
        // unexpected internal errors are masked.
        error: status <= 504 ? error.message : 'Computer Use operation failed.',
        code: error.code || 'computer_use_failed',
      });
    } finally {
      res.off('close', disconnected);
    }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 15000;
  const ready = new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolveReady);
  });
  ready.catch(() => {});

  return {
    config: Object.freeze({ socketPath, token, instanceId }),
    ready,
    async revokeOwner(ownerId) {
      try {
        await manager.releaseRun(ownerId);
      } catch {
        /* Revocation never fails run teardown. */
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of pendingWaits) controller.abort();
      await ready.catch(() => {});
      await new Promise((resolveClose) => {
        server.closeAllConnections?.();
        server.close(resolveClose);
      });
      if (process.platform !== 'win32') await unlink(socketPath).catch(() => {});
    },
  };
}
