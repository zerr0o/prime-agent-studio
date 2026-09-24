/**
 * CUA Computer Use driver (Node side) for tag cua-driver-rs-v0.28.2
 * (commit fc188250b4ca8549b8e61f937fdb1fb560770e86).
 *
 * Owns ONLY the mapping between the Studio driver contract
 * (status, windows, observe, act, stop, inspect) and the pinned Windows CUA
 * tool surface over an injected transport (default: owned daemon+proxy pair
 * in lib/cua-driver-transport.mjs). No screen capture or input happens here;
 * it validates, binds snapshot tokens, forwards screenshot-local coords
 * WITHOUT physical rescaling, and enforces generation fencing plus a
 * terminal stop latch with verified shutdown.
 *
 * Pinned sources (read-only research, executed nowhere here):
 *   test-results/cua-integration/research-api/
 *     tag_libs__cua-driver__contract__manifest.json (contract 0.8.0)
 *     tag_libs__cua-driver__rust__Skills__cua-driver__SKILL.md + WINDOWS.md
 *     tag_libs__cua-driver__docs__action-result-contract.md
 *     tag_libs__cua-driver__docs__mcp-protocol-and-skills.md
 *     tag_libs__cua-driver__rust__crates__cua-driver-core__src__*.rs
 *     tag_libs__cua-driver__rust__crates__platform-windows__src__capture.rs
 *     tag_libs__cua-driver__rust__crates__platform-windows__src__tools__stubs.rs
 *     tag_libs__cua-driver__rust__crates__platform-windows__src__tools__impl_.rs
 *       (fetched raw at the pinned commit; exact Windows input schemas)
 *   planning/cua-driver-distribution-research.md
 *
 * Verified Windows (impl_.rs) facts used below, not assumed:
 * - Click/Scroll/Drag/TypeText/PressKey/Hotkey take legacy flat
 *   pid/window_id/x/y/element_token/snapshot_id plus scope (window/desktop)
 *   plus delivery_mode, plus session. DoubleClick has no scope field and
 *   requires pid (desktop double-click is refused). SetValue requires
 *   pid+value with optional window_id/token and NO delivery_mode or x/y.
 * - Scroll requires direction; amount 1..50; element_index is a parity
 *   no-op on Windows, so only element_token is ever sent (never a bare
 *   index). Drag is a single segment (from/to; steps/duration omitted so
 *   defaults apply); caption/resize drags refuse background_unavailable.
 * - MoveCursor scope window moves ONLY the agent overlay; scope desktop
 *   moves the real OS pointer (SetCursorPos). Window-frame moves are
 *   refused rather than misrepresented.
 * - GetWindowState requires pid+window_id (HWND must belong to pid);
 *   include_screenshot/include_accessibility_tree default true (both false
 *   is an error); query/max_elements/max_depth/max_dimension supported.
 *   Output carries window_bounds (physical, same response), screenshot
 *   width/height/mime, snapshot_id, element_token rows, degraded flags.
 * - GetDesktopState takes only session; captures the FULL primary display
 *   at NATIVE size with no downscale. A 4K desktop therefore refuses
 *   IMAGE_TOO_LARGE in beta (both axes must stay at or under 2000); the
 *   adapter never downscales or fakes a frame transform.
 * - ListWindows rows carry window_id (HWND u64), pid, app_name, title,
 *   bounds, is_on_screen, z_index (higher is closer; null unobservable).
 * - BringToFront requires pid (+optional window_id), deliberately breaks
 *   the no-foreground contract, and is NOT part of the normal input ladder.
 *   The adapter calls it ONLY for an explicit user-initiated windows focus
 *   request (bridge never sends focus automatically); the raw
 *   previous/now foreground outcome is surfaced with no force parity.
 * - Minimized windows refuse window_minimized; the adapter surfaces it and
 *   never restores (that would need bring_to_front outside user intent).
 *
 * Snapshot identity: snapshot_id (sXXXXXXXX) + element_token
 * (sXXXXXXXX:index). NOT capture_id. Bare element_index is rejected.
 * Window coords are window-local screenshot pixels (same space as the PNG).
 * Default PNG long-edge cap 1568 (max_dimension tighter-wins ceiling).
 * Desktop primary display only.
 *
 * Delivery (Studio decision): the bridge sends BATCH-LEVEL
 * params.deliveryMode (foreground/background). Pixel actions default to
 * foreground (Studio opt-in real input), element AX actions default to
 * background (the UIA path guarantees its own target and never fronts);
 * an explicit batch mode overrides both, except move/set_value/wait which
 * take no delivery knob. The adapter NEVER auto-escalates on refusal and
 * never smuggles modifier state (background clicks cannot carry it on
 * Windows; a modifier field is refused explicitly).
 *
 * Guardian ownership (ratified): root does NOT pass a shared supervisor.
 * This adapter CREATES and OWNS a private native guardian through the real
 * native driver factory (lib/computer-use-driver.mjs
 * createComputerUseDriver), lazily before any capture or input, wiring its
 * onStop to the same shutdown path as a hotkey stop. The guardian is
 * addressed ONLY through its public request/stop/close interface (a thin
 * wrapper adapts arm/disarm/cleanup/status to request calls); direct worker
 * access is never assumed. Missing mutex (status.mutex true) or capability
 * (status.externalInputGuard.supported true) fails closed before any CUA
 * tool call. Native stop/hotkey never closes the helper, so post-kill
 * cleanup stays possible; this adapter closes its owned guardian by
 * default on close(), after verified CUA death plus cleanup. Disable or
 * backend switch creates a fresh adapter (no sharing with the native
 * backend).
 *
 * Stop semantics: stop() latches a terminal stopped flag synchronously
 * (with generation fencing, in-flight failure, and the onStop manager
 * notification) BEFORE awaiting tree exit, so no new request can restart
 * the transport mid-kill. One shutdown promise is shared across
 * stop/hotkey/close with exactly-once cleanup after VERIFIED tree exit.
 * An unverified exit fails closed: the guardian and mutex are kept while
 * CUA may be live, cleanup is skipped, and uncertainty is reported
 * (stopped:false) instead of a false stopped:true.
 */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  createCuaDriverTransport,
  CUA_DRIVER_TAG,
  CUA_DRIVER_COMMIT,
  CUA_CONTRACT_VERSION,
} from './cua-driver-transport.mjs';

export const CUA_BACKEND_ID = 'cua';
export const CUA_DRIVER_METHODS = ['status', 'windows', 'observe', 'act', 'stop', 'inspect'];
const METHOD_SET = new Set(CUA_DRIVER_METHODS);

/**
 * Guardian contract, read through the native driver's public interface.
 * The native worker reports both flags in status once its support lands;
 * until then the wrapper fails closed (never a no-op arm).
 */
export const GUARDIAN_STATUS_MUTEX = 'mutex';
export const GUARDIAN_STATUS_FLAG = 'externalInputGuard';
export const GUARDIAN_VERBS = ['arm_external_input', 'disarm_external_input', 'cleanup_external_input'];

const MAX_ACTIONS = 12;
const MAX_TEXT_LENGTH = 2000;
const MAX_WAIT_MS = 5000;
const MAX_KEYS_PER_PRESS = 8;
const MAX_PATH_POINTS = 20;
const MAX_SCROLL_DELTA = 100;
const MAX_REASON_LENGTH = 200;
const MAX_ELEMENTS_DEFAULT = 200;
const MAX_ELEMENTS_HARD = 500;
const MAX_IMAGE_DIM = 2000;
const DEFAULT_TIMEOUT_MS = 30000;
const STARTUP_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 3000;
const EXIT_VERIFY_MS = 1500;
const GUARDIAN_TIMEOUT_MS = 5000;
const EFFECTS = new Set(['confirmed', 'partial', 'unverifiable', 'suspected_noop', 'refused']);

function driverError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function checkCoord(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw driverError('INVALID_PARAMS', `${name} must be a finite screenshot-local pixel.`);
  }
}

function checkFrameCoord(value, max, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= max) {
    throw driverError('INVALID_PARAMS', `${name} is outside the observed frame (0 to ${max - 1}).`);
  }
}

function normalizeParams(params) {
  if (params === undefined) return {};
  if (params && typeof params === 'object' && !Array.isArray(params)) return params;
  throw driverError('INVALID_PARAMS', 'params must be an object.');
}

// Owned identity: ONE uuid per adapter becomes BOTH the private pipe name
// and the guardian job nonce, so the native command-line check (nonce
// present in the spawned proxy --socket string) can always succeed on the
// generated default. Explicit socketPath overrides stay a test-only combo:
// a real helper would refuse an unrelated nonce, which fails closed here.
function defaultPrivatePipe(id) {
  if (process.platform === 'win32') {
    // Built from char codes on purpose: hand-counted backslash escapes
    // previously produced an invalid prefix. Rendered value MUST be
    // \\.\pipe\prime-studio-cua-<uuid> so the native
    // command-line check sees the job nonce inside --socket.
    const BS = String.fromCharCode(92);
    return BS + BS + '.' + BS + 'pipe' + BS + `prime-studio-cua-${id}`;
  }
  return join(tmpdir(), `prime-studio-cua-${id}.sock`);
}

function assertPrivateSocket(socketPath) {
  const lowered = String(socketPath).toLowerCase();
  if (lowered.endsWith('\cua-driver') || lowered.endsWith('\cua-driver-local')) {
    throw driverError(
      'SHARED_DAEMON_FORBIDDEN',
      'CUA transport must never attach to the shared default daemon pipe. Use the owned private default.',
    );
  }
}

function parseWindowKey(windowId) {
  if (typeof windowId !== 'string' || !windowId) {
    throw driverError(
      'INVALID_PARAMS',
      'CUA windowId must be the "pid:window_id" string from windows list, observe or inspect.',
    );
  }
  const parts = windowId.split(':');
  if (parts.length !== 2) {
    throw driverError(
      'INVALID_PARAMS',
      'CUA windowId must look like "pid:window_id" (for example "844:10725").',
    );
  }
  const pid = Number(parts[0]);
  const window_id = Number(parts[1]);
  if (!Number.isInteger(pid) || pid < 1 || pid > 4294967295) {
    throw driverError('INVALID_PARAMS', 'CUA pid must be an integer in [1, 4294967295].');
  }
  if (!Number.isInteger(window_id) || window_id < 1) {
    throw driverError('INVALID_PARAMS', 'CUA window_id must be a positive integer (HWND).');
  }
  return { pid, window_id, windowKey: `${pid}:${window_id}` };
}

function parseToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split(':');
  if (parts.length !== 2) return null;
  const handle = parts[0];
  if (!/^s[0-9a-fA-F]{8}$/.test(handle)) return null;
  if (!/^\d+$/.test(parts[1])) return null;
  return { snapshotId: handle.toLowerCase(), index: Number(parts[1]) };
}

function validateAction(action, index) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw driverError('INVALID_PARAMS', `actions[${index}] must be an object.`);
  }
  if (action.deliveryMode !== undefined) {
    // Root schema carries deliveryMode at batch level (params.deliveryMode),
    // never per action. Reject it here so a misplaced knob cannot drift.
    throw driverError(
      'INVALID_PARAMS',
      `actions[${index}].deliveryMode is not per-action; use batch params.deliveryMode.`,
    );
  }
  if (action.modifier !== undefined || action.modifiers !== undefined) {
    // Verified residual (WINDOWS.md): a background click cannot carry live
    // modifier state on Windows. Never smuggle it; refuse explicitly.
    throw driverError(
      'UNSUPPORTED_MODIFIER',
      `actions[${index}] modifier clicks are unsupported on the CUA backend in beta.`,
    );
  }
  const { type } = action;
  switch (type) {
    case 'click':
    case 'double_click': {
      const hasElement = action.elementId !== undefined;
      const hasCoords = action.x !== undefined || action.y !== undefined;
      if (hasElement) {
        if (typeof action.elementId !== 'string' || !parseToken(action.elementId)) {
          throw driverError(
            'INVALID_PARAMS',
            `actions[${index}].elementId must be an element_token "sXXXXXXXX:index".`,
          );
        }
        if (hasCoords) {
          throw driverError(
            'INVALID_PARAMS',
            `actions[${index}] takes elementId OR x/y, not both (ax vs px rung).`,
          );
        }
      } else if (!hasCoords) {
        throw driverError('INVALID_PARAMS', `actions[${index}] needs elementId or x/y.`);
      }
      if (hasCoords) {
        checkCoord(action.x, `actions[${index}].x`);
        checkCoord(action.y, `actions[${index}].y`);
      }
      if (action.button !== undefined && !['left', 'right', 'middle'].includes(action.button)) {
        throw driverError('INVALID_PARAMS', `actions[${index}].button must be left, right or middle.`);
      }
      break;
    }
    case 'move': {
      if (action.x === undefined || action.y === undefined) {
        throw driverError('INVALID_PARAMS', `actions[${index}] move needs x and y.`);
      }
      checkCoord(action.x, `actions[${index}].x`);
      checkCoord(action.y, `actions[${index}].y`);
      if (action.elementId !== undefined) {
        throw driverError('INVALID_PARAMS', `actions[${index}] move takes pixels, not elementId.`);
      }
      break;
    }
    case 'drag': {
      checkCoord(action.x, `actions[${index}].x`);
      checkCoord(action.y, `actions[${index}].y`);
      if (action.button !== undefined && !['left', 'right', 'middle'].includes(action.button)) {
        throw driverError('INVALID_PARAMS', `actions[${index}].button must be left, right or middle.`);
      }
      if (action.elementId !== undefined) {
        throw driverError('INVALID_PARAMS', `actions[${index}] drag takes pixels, not elementId.`);
      }
      if (action.path !== undefined) {
        if (!Array.isArray(action.path) || action.path.length > MAX_PATH_POINTS) {
          throw driverError(
            'INVALID_PARAMS',
            `actions[${index}].path must have at most ${MAX_PATH_POINTS} points.`,
          );
        }
        action.path.forEach((point, pointIndex) => {
          if (!point || typeof point !== 'object') {
            throw driverError('INVALID_PARAMS', `actions[${index}].path[${pointIndex}] must be an object.`);
          }
          checkCoord(point.x, `actions[${index}].path[${pointIndex}].x`);
          checkCoord(point.y, `actions[${index}].path[${pointIndex}].y`);
        });
        if (action.path.length > 1) {
          // Verified: CUA drag has from/to plus steps/duration knobs, not a
          // free path array. Multi-point paths are refused explicitly.
          throw driverError(
            'UNSUPPORTED_DRAG_PATH',
            `actions[${index}] multi-point drag path is unsupported in beta (single segment only: x/y to the last point).`,
          );
        }
      }
      break;
    }
    case 'scroll': {
      if (action.x !== undefined) checkCoord(action.x, `actions[${index}].x`);
      if (action.y !== undefined) checkCoord(action.y, `actions[${index}].y`);
      if ((action.x !== undefined) !== (action.y !== undefined)) {
        throw driverError('INVALID_PARAMS', `actions[${index}] x and y must be given together.`);
      }
      if (action.elementId !== undefined) {
        if (typeof action.elementId !== 'string' || !parseToken(action.elementId)) {
          throw driverError(
            'INVALID_PARAMS',
            `actions[${index}].elementId must be an element_token "sXXXXXXXX:index".`,
          );
        }
      }
      const { deltaX = 0, deltaY = 0 } = action;
      if (
        !isInt(deltaX) ||
        Math.abs(deltaX) > MAX_SCROLL_DELTA ||
        !isInt(deltaY) ||
        Math.abs(deltaY) > MAX_SCROLL_DELTA
      ) {
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}] scroll deltas must be integers within ±${MAX_SCROLL_DELTA}.`,
        );
      }
      if (deltaX === 0 && deltaY === 0) {
        throw driverError('INVALID_PARAMS', `actions[${index}] scroll needs a nonzero deltaX or deltaY.`);
      }
      break;
    }
    case 'keypress': {
      if (!Array.isArray(action.keys) || action.keys.length < 1 || action.keys.length > MAX_KEYS_PER_PRESS) {
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}].keys must list 1 to ${MAX_KEYS_PER_PRESS} keys.`,
        );
      }
      for (const key of action.keys) {
        if (typeof key !== 'string' || !key.trim() || key.length > 32) {
          throw driverError('INVALID_PARAMS', `actions[${index}].keys must be non-empty key names.`);
        }
      }
      if (
        action.elementId !== undefined &&
        (typeof action.elementId !== 'string' || !parseToken(action.elementId))
      ) {
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}].elementId must be an element_token "sXXXXXXXX:index".`,
        );
      }
      if ((action.x !== undefined) !== (action.y !== undefined)) {
        throw driverError('INVALID_PARAMS', `actions[${index}] x and y must be given together.`);
      }
      if (action.x !== undefined) {
        checkCoord(action.x, `actions[${index}].x`);
        checkCoord(action.y, `actions[${index}].y`);
        if (action.elementId !== undefined) {
          throw driverError('INVALID_PARAMS', `actions[${index}] takes elementId OR x/y, not both.`);
        }
      }
      break;
    }
    case 'type': {
      if (typeof action.text !== 'string' || !action.text || action.text.length > MAX_TEXT_LENGTH) {
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}].text must be 1 to ${MAX_TEXT_LENGTH} characters.`,
        );
      }
      if (
        action.elementId !== undefined &&
        (typeof action.elementId !== 'string' || !parseToken(action.elementId))
      ) {
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}].elementId must be an element_token "sXXXXXXXX:index".`,
        );
      }
      if (action.x !== undefined || action.y !== undefined) {
        checkCoord(action.x, `actions[${index}].x`);
        checkCoord(action.y, `actions[${index}].y`);
        if (action.elementId !== undefined) {
          throw driverError('INVALID_PARAMS', `actions[${index}] takes elementId OR x/y, not both.`);
        }
      }
      break;
    }
    case 'set_value': {
      if (typeof action.elementId !== 'string' || !parseToken(action.elementId)) {
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}].elementId must be an element_token "sXXXXXXXX:index".`,
        );
      }
      // Root tool schema: value is typeof string with length <= 2000
      // INCLUDING empty (empty clears the control). Do not require 1..2000.
      if (typeof action.value !== 'string' || action.value.length > MAX_TEXT_LENGTH) {
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}].value must be a string of at most ${MAX_TEXT_LENGTH} characters (empty clears).`,
        );
      }
      if (action.x !== undefined || action.y !== undefined) {
        throw driverError('INVALID_PARAMS', `actions[${index}] set_value is AX-only and takes no x/y.`);
      }
      break;
    }
    case 'wait': {
      if (!isInt(action.ms) || action.ms < 1 || action.ms > MAX_WAIT_MS) {
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}].ms must be an integer in [1, ${MAX_WAIT_MS}].`,
        );
      }
      break;
    }
    default:
      throw driverError(
        'INVALID_PARAMS',
        `actions[${index}].type must be click, double_click, move, drag, scroll, keypress, type, set_value or wait.`,
      );
  }
}

function validateCommand(command) {
  let method;
  let params;
  if (typeof command === 'string') {
    method = command;
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
  if (typeof method !== 'string' || !METHOD_SET.has(method)) {
    throw driverError('UNKNOWN_METHOD', `Unknown CUA computer-use method: ${String(method)}.`);
  }
  const resolved = normalizeParams(params);
  switch (method) {
    case 'status':
      break;
    case 'windows': {
      const action = resolved.action ?? 'list';
      if (action !== 'list' && action !== 'focus') {
        throw driverError('INVALID_PARAMS', "windows.action must be 'list' or 'focus'.");
      }
      // Focus is user-explicit only (bridge never sends it automatically):
      // validated here, executed via bring_to_front in doWindowsFocus.
      if (action === 'focus' && (typeof resolved.windowId !== 'string' || !resolved.windowId)) {
        throw driverError('INVALID_PARAMS', 'windows focus needs a windowId "pid:window_id" string.');
      }
      if (resolved.windowId !== undefined && (typeof resolved.windowId !== 'string' || !resolved.windowId)) {
        throw driverError('INVALID_PARAMS', 'windows.windowId must be a non-empty string.');
      }
      break;
    }
    case 'observe': {
      if (resolved.windowId !== undefined && (typeof resolved.windowId !== 'string' || !resolved.windowId)) {
        throw driverError('INVALID_PARAMS', 'observe.windowId must be a non-empty string.');
      }
      if (resolved.region !== undefined) {
        throw driverError(
          'UNSUPPORTED_OBSERVE_REGION',
          'observe.region is unsupported on the CUA backend in beta (full window or full primary desktop only). CUA pixels must not be hand-cropped because the window-local coordinate system would break.',
        );
      }
      if (
        resolved.maxWidth !== undefined &&
        (!isInt(resolved.maxWidth) || resolved.maxWidth < 16 || resolved.maxWidth > 4096)
      ) {
        throw driverError('INVALID_PARAMS', 'observe.maxWidth must be an integer in [16, 4096].');
      }
      if (resolved.displayId !== undefined && resolved.displayId !== 'primary') {
        throw driverError(
          'UNSUPPORTED_DISPLAY',
          'Only the primary display is supported on the CUA backend in beta (display_id primary).',
        );
      }
      break;
    }
    case 'inspect': {
      // Bridge computer_inspect always carries a windowId string: desktop AX
      // without a window is ambiguous and is refused, never guessed.
      if (typeof resolved.windowId !== 'string' || !resolved.windowId) {
        throw driverError('INVALID_PARAMS', 'inspect.windowId must be a non-empty "pid:window_id" string.');
      }
      if (
        resolved.query !== undefined &&
        (typeof resolved.query !== 'string' || !resolved.query || resolved.query.length > 500)
      ) {
        throw driverError('INVALID_PARAMS', 'inspect.query must be a short non-empty string.');
      }
      if (
        resolved.maxElements !== undefined &&
        (!isInt(resolved.maxElements) || resolved.maxElements < 1 || resolved.maxElements > MAX_ELEMENTS_HARD)
      ) {
        throw driverError(
          'INVALID_PARAMS',
          `inspect.maxElements must be an integer in [1, ${MAX_ELEMENTS_HARD}].`,
        );
      }
      break;
    }
    case 'act': {
      if (
        !Array.isArray(resolved.actions) ||
        resolved.actions.length < 1 ||
        resolved.actions.length > MAX_ACTIONS
      ) {
        throw driverError('INVALID_PARAMS', `act.actions must list 1 to ${MAX_ACTIONS} actions.`);
      }
      resolved.actions.forEach(validateAction);
      // Batch-level delivery mode (bridge tool schema). Pixel actions
      // default foreground, element AX actions default background; an
      // explicit batch mode overrides both (move/set_value/wait ignore it).
      if (
        resolved.deliveryMode !== undefined &&
        resolved.deliveryMode !== 'foreground' &&
        resolved.deliveryMode !== 'background'
      ) {
        throw driverError('INVALID_PARAMS', 'act.deliveryMode must be foreground or background.');
      }
      if (resolved.expectedFrame !== undefined) {
        if (
          !resolved.expectedFrame ||
          typeof resolved.expectedFrame !== 'object' ||
          Array.isArray(resolved.expectedFrame)
        ) {
          throw driverError('INVALID_PARAMS', 'act.expectedFrame must be an object.');
        }
        const { driverFrame } = resolved.expectedFrame;
        if (driverFrame !== undefined && (!driverFrame || typeof driverFrame !== 'object')) {
          throw driverError('INVALID_PARAMS', 'act.expectedFrame.driverFrame must be an object.');
        }
      }
      break;
    }
    case 'stop': {
      if (
        resolved.reason !== undefined &&
        (typeof resolved.reason !== 'string' ||
          !resolved.reason ||
          resolved.reason.length > MAX_REASON_LENGTH)
      ) {
        throw driverError('INVALID_PARAMS', 'stop.reason must be a short non-empty string.');
      }
      break;
    }
  }
  return { method, params: resolved };
}

function throwIfCuaError(envelope, tool) {
  const { result } = envelope;
  if (result && typeof result === 'object' && result.isError === true) {
    const structured =
      result.structuredContent && typeof result.structuredContent === 'object'
        ? result.structuredContent
        : {};
    const text = Array.isArray(result.content)
      ? result.content
          .filter((c) => c && c.type === 'text')
          .map((c) => c.text)
          .join('\n')
      : '';
    const code =
      typeof structured.code === 'string' && structured.code
        ? structured.code
        : typeof structured.refusal?.code === 'string' && structured.refusal.code
          ? structured.refusal.code
          : 'CUA_TOOL_ERROR';
    const message =
      (typeof structured.message === 'string' && structured.message) ||
      (typeof structured.refusal?.message === 'string' && structured.refusal.message) ||
      text ||
      `${tool} reported an error.`;
    if (code === 'ambiguous_window_target') {
      throw driverError('AMBIGUOUS_WINDOW_TARGET', message.slice(0, 800), { tool, structured });
    }
    if (code === 'window_target_not_found') {
      throw driverError('WINDOW_NOT_FOUND', message.slice(0, 800), { tool, structured });
    }
    if (
      [
        'invalid_element_token',
        'conflicting_element_target',
        'element_index_required',
        'snapshot_id_required',
        'invalid_snapshot_id',
      ].includes(code) ||
      /stale/i.test(message)
    ) {
      throw driverError(
        'STALE_FRAME',
        `Snapshot binding is stale. Observe or inspect again for a fresh frame. (${message.slice(0, 300)})`,
        { tool, structured },
      );
    }
    if (code === 'background_unavailable' || code === 'background_occluded') {
      throw driverError(
        'BACKGROUND_UNAVAILABLE',
        `${message.slice(0, 500)} No automatic foreground retry: re-issue only this action with batch deliveryMode foreground when the user authorized visible control.`,
        { tool, structured },
      );
    }
    if (code === 'background_uipi_blocked') {
      throw driverError(
        'UIP_BLOCKED',
        `${message.slice(0, 500)} The Medium-integrity Studio daemon cannot drive this elevated or AppContainer target.`,
        { tool, structured },
      );
    }
    if (
      [
        'window_minimized',
        'desktop_coordinate_scope_required',
        'invalid_action_target',
        'invalid_arguments',
      ].includes(code)
    ) {
      throw driverError(code.toUpperCase(), message.slice(0, 800), { tool, structured });
    }
    throw driverError('CUA_TOOL_ERROR', `${tool}: ${message.slice(0, 800)}`, { tool, structured });
  }
}

function pickImageContent(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content.find((c) => c && c.type === 'image' && typeof c.data === 'string') || null;
}

function structuredOf(result) {
  if (result && typeof result.structuredContent === 'object' && result.structuredContent) {
    return result.structuredContent;
  }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result;
  }
  return {};
}

function summarizeElement(el) {
  return {
    elementId: typeof el.element_token === 'string' ? el.element_token : null,
    elementIndex: el.element_index ?? null,
    role: typeof el.role === 'string' ? el.role : 'unknown',
    ...(typeof el.label === 'string' ? { label: el.label.slice(0, 300) } : {}),
    ...(typeof el.value === 'string' ? { value: el.value.slice(0, 500) } : {}),
    ...(typeof el.enabled === 'boolean' ? { enabled: el.enabled } : {}),
    ...(el.frame && typeof el.frame === 'object' ? { frame: el.frame } : {}),
  };
}

/**
 * Create the CUA Computer Use driver.
 *
 * options:
 *   platform, arch       OS gating (default process.platform/process.arch).
 *   driverPath           cua-driver binary (else resolveCuaDriverPath helper).
 *   socketPath           private pipe for serve/mcp --socket (required).
 *   homeDir              isolated CUA_DRIVER_RS_HOME (required).
 *   sessionLabel         public session label repeated on calls.
 *   transport            injected started transport (tests).
 *   createTransport      factory injection (default createCuaDriverTransport).
 *   resolveCuaDriverPath () => string|{driverPath} (packaging shape).
 *   getCuaDriverAvailability (opts) => {available, backend, path, version,
 *                        reason, supported} (packaging shape).
 *   guardian             injected native-shaped instance {request,stop,close}
 *                        (test seam only; never used in production).
 *   createGuardian       factory injection for the OWNED native guardian
 *                        (tests inject a native-shaped fake {request,stop,
 *                        close}; production default lazily imports the real
 *                        lib/computer-use-driver.mjs createComputerUseDriver
 *                        and wires its onStop to the shared shutdown path).
 *                        A directly injected native-shaped instance is a
 *                        test seam only; production always mints a fresh
 *                        owned guardian (disable/switch mint fresh too).
 *   spawnProcess, env, startupTimeoutMs, defaultTimeoutMs, stopTimeoutMs,
 *   onStop(reason, event), onEvent(event), now.
 */
export function createCuaComputerUseDriver(options = {}) {
  const {
    platform = process.platform,
    arch = process.arch,
    driverPath: driverPathOption,
    socketPath,
    homeDir,
    sessionLabel = 'studio-cua',
    transport: injectedTransport,
    createTransport = createCuaDriverTransport,
    resolveCuaDriverPath,
    getCuaDriverAvailability,
    guardian: injectedGuardian,
    createGuardian,
    spawnProcess,
    env = process.env,
    startupTimeoutMs = STARTUP_TIMEOUT_MS,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    stopTimeoutMs = STOP_TIMEOUT_MS,
    daemonReadyTimeoutMs = 8000,
    waitForDaemonFn = null,
    onStop,
    onEvent,
    now = Date.now,
  } = options;

  let transport = injectedTransport || null;
  const injectedTestTransport = Boolean(injectedTransport);
  // Direct instance seams (tests only: the probe and unit fakes inject
  // native-shaped {request,stop,close} instances and prestarted transports).
  // Production never passes these: the manager factory supplies only
  // {onStop}, so creation always flows through createGuardian (real native
  // factory) and the job road below. Nothing here can spawn the native
  // helper unless a test hands one in.
  let guardian = injectedGuardian || null;
  let closed = false;
  let stopped = false;
  let generation = 1;
  let nextRequestId = 1;
  let guardianVerifiedForGeneration = 0;
  let lastCleanupGeneration = 0;
  let cleanupInFlight = null;
  let shutdownPromise = null;
  let shutdownResult = null;
  let guardianArmed = false;
  const active = new Map();
  const frameBindings = new Map();
  let cachedDriverPath = driverPathOption || null;
  let snapshotCounter = 0;
  // Owned production defaults (manager factory passes only {onStop}): one
  // unique private pipe plus one owned temp home per adapter instance,
  // minted lazily on first transport start, never shared.
  let ownedSocket = null;
  let ownedHome = null;
  let ownedHomeCreated = false;
  let ownedNonce = null;
  // Job-verb production launch identity (set by the job path only).
  let activeNonce = null;
  let activeJob = null;
  let jobUncertain = false;

  function emit(event) {
    try {
      onEvent?.(event);
    } catch {
      // Diagnostics must never break the driver.
    }
  }

  function failActive(code, message) {
    for (const [id, entry] of [...active]) {
      active.delete(id);
      clearTimeout(entry.timer);
      entry.reject(driverError(code, `${message} (${entry.method}#${id})`));
    }
  }

  function ensurePlatform() {
    if (platform !== 'win32') {
      throw driverError(
        'UNSUPPORTED_PLATFORM',
        `CUA computer use needs Windows, current platform is ${platform}.`,
      );
    }
    if (arch !== 'x64') {
      throw driverError(
        'UNSUPPORTED_ARCH',
        `CUA computer use beta needs Windows x64, current arch is ${arch}. The native supervisor safety case is x64-only.`,
      );
    }
  }

  async function defaultCreateGuardian() {
    // The owned guardian is the REAL native driver: single controller,
    // hidden persistent worker, global hotkey, generation fencing. Its
    // onStop (hotkey or native stop) re-enters the shared shutdown path.
    const native = await import('./computer-use-driver.mjs');
    return native.createComputerUseDriver({
      platform: 'win32',
      spawnProcess,
      env,
      startupTimeoutMs,
      defaultTimeoutMs,
      stopTimeoutMs,
      onStop: (reason) => {
        void handleSupervisorStop(`guardian:${reason || 'stopped'}`);
      },
      onEvent: (event) => emit({ ...event, source: 'cua-guardian' }),
    });
  }

  // Shared acquisition: concurrent callers (including concurrent status
  // requests, which are lifecycle work, not an escape) share ONE
  // createGuardian() call. Terminal fences apply here too: no post-stop or
  // post-close lazy creation, even via status. A late arrival after a
  // terminal state is closed immediately instead of adopted.
  let guardianPromise = null;
  let acquisitionPoisoned = false;
  // A late arrival whose immediate close FAILED is retained (never lost):
  // only finishClose may release it, and its failure stays retryable.
  let retainedGuardian = null;
  async function ensureGuardianInstance() {
    if (guardian) return guardian;
    ensurePlatform();
    if (acquisitionPoisoned) {
      // A poisoned join timed out: never mint a fresh guardian behind it
      // and never release latched uncertainty through a new instance.
      throw driverError(
        'GUARDIAN_UNAVAILABLE',
        'CUA guardian acquisition was poisoned by a bounded-join timeout; reconcile or close before any fresh guardian.',
      );
    }
    if (stopped)
      throw driverError(
        'DRIVER_STOPPED',
        'CUA computer-use driver was stopped. Create a fresh adapter after stop.',
      );
    if (closed) throw driverError('DRIVER_CLOSED', 'CUA computer-use driver is closed.');
    if (!guardianPromise) {
      guardianPromise = (async () => {
        const instance =
          typeof createGuardian === 'function'
            ? await createGuardian({
                onStop: (reason) => handleSupervisorStop(`guardian:${reason || 'stopped'}`),
              })
            : await defaultCreateGuardian();
        if (!instance || typeof instance.request !== 'function') {
          throw driverError(
            'GUARDIAN_MISSING',
            'CUA computer use needs its owned native guardian (global mutex/hotkey/cleanup). Creation returned nothing usable; refusing before any mutation.',
          );
        }
        return instance;
      })().then(
        async (instance) => {
          guardianPromise = null;
          if (acquisitionPoisoned || stopped || closed) {
            // Late arrival after a terminal state (or a poisoned join):
            // never adopt, never dispatch on it. Claim the exact handle
            // FIRST (synchronously, reopening finalization), then attempt
            // its immediate close: success releases it, failure retains it
            // so close stays retryable. Either way nothing is lost.
            retainedGuardian = instance;
            fullyClosed = false;
            try {
              await instance.close?.();
            } catch (error) {
              emit({
                kind: 'cua_guardian',
                warning: `late guardian close failed, instance retained: ${String(error?.message || error).slice(0, 200)}`,
              });
              throw stopped
                ? driverError(
                    'DRIVER_STOPPED',
                    'CUA computer-use driver was stopped. Create a fresh adapter after stop.',
                  )
                : driverError('DRIVER_CLOSED', 'CUA computer-use driver is closed.');
            }
            retainedGuardian = null;
            throw stopped
              ? driverError(
                  'DRIVER_STOPPED',
                  'CUA computer-use driver was stopped. Create a fresh adapter after stop.',
                )
              : driverError('DRIVER_CLOSED', 'CUA computer-use driver is closed.');
          }
          guardian = instance;
          return instance;
        },
        (error) => {
          guardianPromise = null;
          throw error;
        },
      );
    }
    return guardianPromise;
  }

  // Bounded join for shutdown: retain and join a delayed acquisition, but
  // poison on timeout so a hung factory can never stall teardown forever.
  // A poisoned late arrival closes itself on settlement (see above).
  async function joinGuardianAcquisition(timeoutMs) {
    if (!guardianPromise) return 'settled';
    const verdict = await Promise.race([
      guardianPromise.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ]);
    if (verdict === 'timeout') acquisitionPoisoned = true;
    return verdict;
  }

  // Thin wrapper: the guardian is addressed ONLY through the native
  // driver's public request/stop/close interface. New guardian verbs
  // (arm/disarm/cleanup) travel as worker requests; an UNKNOWN_METHOD
  // answer means the worker support has not landed, which fails closed.
  async function guardianRequest(method, params, { timeoutMs = GUARDIAN_TIMEOUT_MS } = {}) {
    const instance = await ensureGuardianInstance();
    try {
      return await instance.request({ method, params }, { timeoutMs });
    } catch (error) {
      if (error && (error.code === 'UNKNOWN_METHOD' || /unknown.*method/i.test(error.message || ''))) {
        throw driverError(
          'GUARDIAN_CAPABILITY_MISSING',
          `CUA guardian lacks the ${method} worker verb (native support pending); refusing before any mutation.`,
        );
      }
      throw error;
    }
  }

  async function verifyGuardianCapability({ timeoutMs = GUARDIAN_TIMEOUT_MS } = {}) {
    if (guardianVerifiedForGeneration === generation) return true;
    const instance = await ensureGuardianInstance();
    let status = null;
    try {
      status = await instance.request({ method: 'status', params: {} }, { timeoutMs });
    } catch (error) {
      throw driverError(
        'GUARDIAN_CAPABILITY_MISSING',
        `CUA guardian status is unreadable (${String(error?.message || error).slice(0, 200)}); refusing before any mutation.`,
      );
    }
    // Both flags are mandatory: the startup mutex and the external-input
    // guard capability. Either missing fails closed before any CUA tool.
    if (status?.[GUARDIAN_STATUS_MUTEX] !== true) {
      throw driverError(
        'GUARDIAN_CAPABILITY_MISSING',
        `CUA guardian mutex is not claimed (status.${GUARDIAN_STATUS_MUTEX} !== true); refusing before any mutation.`,
        { statusKeys: status && typeof status === 'object' ? Object.keys(status).slice(0, 24) : [] },
      );
    }
    // Independent emergency hotkey is mandatory: CUA itself cannot
    // cancel in-flight input. Capability support or hotkeyError:0 alone is
    // never registration; only hotkeyRegistered===true proceeds.
    if (status?.hotkeyRegistered !== true) {
      throw driverError(
        'GUARDIAN_UNAVAILABLE',
        'CUA guardian emergency hotkey is not registered (hotkeyRegistered !== true); refusing before any mutation. This is a guard requirement, not a user confirmation gate.',
      );
    }
    const flag = status?.[GUARDIAN_STATUS_FLAG];
    if (!(flag === true || (flag && typeof flag === 'object' && flag.supported === true))) {
      throw driverError(
        'GUARDIAN_CAPABILITY_MISSING',
        `CUA guardian lacks a verified ${GUARDIAN_STATUS_FLAG}.supported status flag; refusing before any mutation. Native worker must expose status.${GUARDIAN_STATUS_FLAG} = { supported: true, armed }.`,
        { statusKeys: status && typeof status === 'object' ? Object.keys(status).slice(0, 24) : [] },
      );
    }
    guardianVerifiedForGeneration = generation;
    return true;
  }

  async function resolvePath() {
    if (cachedDriverPath) return cachedDriverPath;
    if (typeof resolveCuaDriverPath === 'function') {
      const found = await resolveCuaDriverPath({});
      const path = typeof found === 'string' ? found : found && (found.driverPath || found.path);
      if (typeof path === 'string' && path) {
        cachedDriverPath = path;
        return path;
      }
      throw driverError(
        'DRIVER_UNAVAILABLE',
        'CUA driver binary is not installed for Windows x64 (resolveCuaDriverPath found nothing).',
      );
    }
    try {
      const runtime = await import('./cua-driver-runtime.mjs');
      if (typeof runtime.resolveCuaDriverPath === 'function') {
        const found = await runtime.resolveCuaDriverPath({});
        const path = typeof found === 'string' ? found : found && (found.driverPath || found.path);
        if (typeof path === 'string' && path) {
          cachedDriverPath = path;
          return path;
        }
      }
    } catch {}
    if (injectedTestTransport) return null;
    throw driverError(
      'DRIVER_UNAVAILABLE',
      'CUA driver binary is not installed for Windows x64 (packaging helper lib/cua-driver-runtime.mjs unavailable).',
    );
  }

  async function availability() {
    if (typeof getCuaDriverAvailability === 'function') {
      const info = await getCuaDriverAvailability({});
      if (info && typeof info === 'object') return info;
      return { available: false, backend: 'cua', reason: 'Availability helper returned nothing usable.' };
    }
    try {
      const runtime = await import('./cua-driver-runtime.mjs');
      if (typeof runtime.getCuaDriverAvailability === 'function') {
        return await runtime.getCuaDriverAvailability({});
      }
    } catch {}
    if (injectedTestTransport)
      return { available: true, backend: 'cua', path: null, version: null, supported: true };
    return { available: false, backend: 'cua', reason: 'CUA driver packaging helper is unavailable.' };
  }

  async function ownedDefaults() {
    if (!ownedNonce) ownedNonce = randomUUID();
    if (!ownedSocket) ownedSocket = socketPath ?? defaultPrivatePipe(ownedNonce);
    if (socketPath) assertPrivateSocket(socketPath);
    if (socketPath) assertPrivateSocket(socketPath);
    if (!ownedHome) {
      if (homeDir) {
        ownedHome = homeDir;
      } else {
        ownedHome = await mkdtemp(join(tmpdir(), 'prime-studio-cua-home-'));
        ownedHomeCreated = true;
      }
    }
    return { socket: ownedSocket, home: ownedHome, nonce: ownedNonce };
  }

  function lateAbortCheck() {
    if (stopped)
      throw driverError(
        'DRIVER_STOPPED',
        'CUA computer-use driver was stopped. Create a fresh adapter after stop.',
      );
    if (closed) throw driverError('DRIVER_CLOSED', 'CUA computer-use driver is closed.');
  }

  // Job allowlist for the guardian-spawned daemon environment block: the
  // native guardian env is NOT the CUA home. Only these keys cross over.
  function cuaJobEnv(home) {
    return {
      CUA_DRIVER_RS_HOME: home,
      CUA_DRIVER_RS_UPDATE_CHECK: '0',
      CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
      CUA_LOG: 'WARN',
    };
  }

  async function persistJobIdentity(record) {
    // Nonce/pid persist ONLY in the owned temp dir (never global state),
    // so job_reconcile can re-prove the pair after uncertainty.
    try {
      await writeFile(join(ownedHome, `job-${record.nonce}.json`), JSON.stringify(record), 'utf8');
    } catch (error) {
      emit({
        kind: 'cua_job',
        warning: `job identity persist failed: ${String(error?.message || error).slice(0, 200)}`,
      });
    }
  }

  async function startJobPair(path, socket, home, nonce) {
    // Production launch: the guardian spawns the daemon SUSPENDED into the
    // Job, Node spawns the proxy with direct stdio, the guardian adopts the
    // SAME opened identity-verified proxy handle, and only then does the
    // MCP handshake run. No raw direct-spawn fallback exists here: a
    // guardian without the verbs fails closed via GUARDIAN_CAPABILITY.
    // The job claim is taken immediately after launch, so EVERY later
    // failure tears down through failJobStart (verified kill or uncertainty
    // latch) and no fresh pair may start while one is unresolved.
    // Ownership is claimed BEFORE the async launch so a stop/close racing
    // the launch joins the in-flight acquisition instead of treating an
    // absent transport as no owned job. A launch throw clears the claim
    // (no job exists yet) and propagates.
    activeNonce = nonce;
    activeJob = { daemonPid: null, jobName: null };
    const serveArgs = ['serve', '--socket', socket];
    let launched = null;
    try {
      launched = await guardianRequest('job_launch', {
        exe: path,
        args: serveArgs,
        nonce,
        env: cuaJobEnv(home),
      });
    } catch (error) {
      activeNonce = null;
      activeJob = null;
      throw error;
    }
    if (!launched || !Number.isInteger(launched.pid)) {
      activeNonce = null;
      activeJob = null;
      throw driverError('DRIVER_START', 'CUA guardian job_launch returned no daemon pid.');
    }
    activeJob = { daemonPid: launched.pid, jobName: launched.jobName ?? null };
    const pairTransport = createTransport({
      driverPath: path,
      socketPath: socket,
      homeDir: home,
      sessionLabel,
      spawnProcess,
      env,
      startupTimeoutMs,
      requestTimeoutMs: defaultTimeoutMs,
      stopTimeoutMs,
      onEvent: (event) => emit({ ...event, source: 'cua-transport' }),
    });
    if (
      !pairTransport ||
      typeof pairTransport.spawnProxy !== 'function' ||
      typeof pairTransport.handshake !== 'function' ||
      typeof pairTransport.waitForDaemon !== 'function'
    ) {
      throw driverError(
        'DRIVER_START',
        'CUA job road needs a proxy-only transport (spawnProxy/waitForDaemon/handshake); the created transport lacks them.',
      );
    }
    startupController = new AbortController();
    try {
      lateAbortCheck();
      // Bounded pre-handshake readiness on the EXACT private socket
      // (metadata-only daemon probe, stop-cancellable) BEFORE spawning the
      // proxy, so its fail-fast startup check cannot race a pipe that is
      // not bound yet. No arbitrary sleep, no replay, no shared pipe.
      if (typeof waitForDaemonFn === 'function') {
        await waitForDaemonFn({
          transport: pairTransport,
          socket,
          timeoutMs: daemonReadyTimeoutMs,
          signal: startupController.signal,
        });
      } else {
        await pairTransport.waitForDaemon({
          timeoutMs: daemonReadyTimeoutMs,
          signal: startupController.signal,
        });
      }
      const proxy = await pairTransport.spawnProxy();
      lateAbortCheck();
      // Adopt is identity proof: refusal fails the whole start before any
      // handshake or tool request.
      let adopted = null;
      try {
        adopted = await guardianRequest('job_adopt', {
          pid: proxy.proxyPid,
          exe: path,
          parentPid: process.pid,
          birthMs: proxy.birthMs,
          socketNonce: nonce,
        });
      } catch (error) {
        if (error && error.code === 'GUARDIAN_CAPABILITY_MISSING') throw error;
        throw driverError(
          'DRIVER_START',
          `CUA guardian refused proxy adoption (${String(error?.message || error).slice(0, 200)}).`,
        );
      }
      if (!adopted || adopted.adopted !== true) {
        throw driverError('DRIVER_START', 'CUA guardian refused proxy adoption (identity unverified).');
      }
      await persistJobIdentity({
        nonce,
        daemonPid: launched.pid,
        proxyPid: proxy.proxyPid,
        jobName: launched.jobName ?? null,
        socket,
      });
      lateAbortCheck();
      await pairTransport.handshake();
      pairTransport.markJobReady?.();
      lateAbortCheck();
    } catch (error) {
      if (typeof pairTransport.abort === 'function') {
        await pairTransport.abort('startup-teardown').catch(() => {});
      }
      await failJobStart(error);
    } finally {
      startupController = null;
    }
    return pairTransport;
  }

  async function failJobStart(originalError) {
    // Only a VERIFIED tree0 releases the job claim (fresh retries allowed).
    // Anything else latches uncertainty: no fresh pair, guardian kept.
    let verified = false;
    try {
      const verdict = await guardianRequest('job_kill', { timeoutMs: Math.min(5000, stopTimeoutMs) });
      verified = !!(verdict && verdict.treeExited === true && (verdict.activeProcesses ?? 0) === 0);
    } catch {
      verified = false;
    }
    if (verified) {
      activeNonce = null;
      activeJob = null;
      throw originalError;
    }
    jobUncertain = true;
    throw driverError(
      'JOB_UNCERTAIN',
      `CUA job startup failed and its teardown is unverified (${String(originalError?.message || originalError).slice(0, 200)}). Guardian kept; reconcile or close before any fresh pair.`,
    );
  }

  // In-flight acquisition handle: shutdown joins it instead of treating
  // an absent transport as no owned job, and concurrent mutations share
  // one launch instead of minting duplicates.
  let startingPromise = null;
  // Startup abort: stop()/close() abort the in-flight readiness wait
  // synchronously in the latch, so waiting ends immediately and the
  // startup teardown closes the proven job.
  let startupController = null;
  async function ensureTransport() {
    if (transport) return transport;
    ensurePlatform();
    if (stopped)
      throw driverError(
        'DRIVER_STOPPED',
        'CUA computer-use driver was stopped. Create a fresh adapter after stop.',
      );
    if (jobUncertain)
      throw driverError(
        'JOB_UNCERTAIN',
        'CUA job proof was lost (reconcile found nothing). No fresh pair may start while uncertainty remains.',
      );
    if (startingPromise) {
      await startingPromise;
      lateAbortCheck();
      if (transport) return transport;
      throw driverError('DRIVER_START', 'CUA startup did not produce a transport.');
    }
    await verifyGuardianCapability();
    lateAbortCheck();
    if (closed) throw driverError('DRIVER_CLOSED', 'CUA computer-use driver is closed.');
    const path = await resolvePath();
    lateAbortCheck();
    if (!path) throw driverError('DRIVER_UNAVAILABLE', 'CUA driver binary is not installed for Windows x64.');
    const { socket, home, nonce } = await ownedDefaults();
    lateAbortCheck();
    startingPromise = startJobPair(path, socket, home, nonce).then(
      (ready) => {
        transport = ready;
        startingPromise = null;
        return ready;
      },
      (error) => {
        startingPromise = null;
        throw error;
      },
    );
    const ready = await startingPromise;
    lateAbortCheck();
    return ready;
  }

  /**
   * Re-prove the owned pair after doubt (e.g. a lost exit observation).
   * found:false MUST NOT imply treeExited:true: uncertainty latches and no
   * fresh pair may start until a reconcile proves otherwise.
   */
  async function reconcile() {
    if (!activeNonce) return { reconciled: false, reason: 'no-job' };
    const result = await guardianRequest('job_reconcile', { nonce: activeNonce });
    if (!result || result.found !== true) {
      jobUncertain = true;
      throw driverError(
        'JOB_UNCERTAIN',
        'CUA job_reconcile found nothing: proof was lost and tree exit is unproven. No fresh pair may start; guardian and mutex are kept.',
      );
    }
    jobUncertain = false;
    return result;
  }

  // Exact held sets per action, armed BEFORE that action's CUA dispatch.
  // Keypress/hotkey hold their keys; drag holds its button; text insertion
  // and pure-UIA set_value hold nothing but still ride the asserted mutex.
  function heldFor(action) {
    if (action.type === 'keypress' || action.type === 'hotkey') {
      return { buttons: [], keys: [...action.keys] };
    }
    // Pointer DOWN injects on click/double_click/drag for any button
    // (left/middle/right): arm it before dispatch.
    if (action.type === 'click' || action.type === 'double_click' || action.type === 'drag') {
      return { buttons: [action.button ?? 'left'], keys: [] };
    }
    // type_text holds nothing verifiable: pinned Windows impl_.rs shows
    // character-by-character PostMessage(WM_CHAR) or atomic UIA
    // ValuePattern (XAML hosts), delay_ms spacing only. No clipboard or
    // Ctrl+V path exists in the source, so no keys are declared here.
    return { buttons: [], keys: [] };
  }

  async function guardianArm(held) {
    await guardianRequest('arm_external_input', { buttons: held.buttons, keys: held.keys });
    guardianArmed = true;
  }

  async function guardianDisarm() {
    if (!guardianArmed) return;
    guardianArmed = false;
    try {
      await guardianRequest('disarm_external_input', {});
    } catch (error) {
      guardianArmed = true;
      emit({
        kind: 'cua_supervisor',
        warning: `guardian disarm failed: ${String(error?.message || error).slice(0, 300)}`,
      });
      throw error;
    }
  }

  function cleanupOnce(context) {
    if (lastCleanupGeneration === generation && !cleanupInFlight) return Promise.resolve();
    if (cleanupInFlight && lastCleanupGeneration === generation) return cleanupInFlight;
    lastCleanupGeneration = generation;
    // A failed cleanup MUST propagate: its error keeps the shutdown
    // unverified, preserves the held plan/guardian/handles, and stays
    // retryable. Swallowing it would release the mutex on uncertainty.
    cleanupInFlight = (async () => {
      try {
        await guardianRequest('cleanup_external_input', { context });
      } catch (error) {
        lastCleanupGeneration = 0;
        emit({
          kind: 'cua_supervisor',
          warning: `guardian cleanup failed: ${String(error?.message || error).slice(0, 300)}`,
        });
        throw error;
      } finally {
        cleanupInFlight = null;
      }
    })();
    return cleanupInFlight;
  }

  async function guardianHotkeyState({ timeoutMs = GUARDIAN_TIMEOUT_MS } = {}) {
    // Bridge contract: hotkeyRegistered boolean is authoritative; a numeric
    // hotkeyError 0 is ignored; never assume registered without the boolean.
    // The actual mutex/guard flags ride along so status proves readiness.
    // Only terminal-fence throws map to guardian-not-started; any other
    // acquisition/request failure is reported distinctly (and emitted) so a
    // status note can never mask a pending cleanup failure underneath.
    try {
      await ensureGuardianInstance();
    } catch (error) {
      const terminal = error && (error.code === 'DRIVER_STOPPED' || error.code === 'DRIVER_CLOSED');
      if (!terminal)
        emit({
          kind: 'cua_guardian',
          warning: `guardian acquisition failed for status: ${String(error?.message || error).slice(0, 200)}`,
        });
      return {
        hotkey: null,
        hotkeyRegistered: false,
        hotkeyNote: terminal ? 'guardian-not-started' : 'guardian-unavailable',
      };
    }
    let status = null;
    try {
      status = await guardian.request({ method: 'status', params: {} }, { timeoutMs });
    } catch (error) {
      emit({
        kind: 'cua_guardian',
        warning: `guardian status failed: ${String(error?.message || error).slice(0, 200)}`,
      });
      return { hotkey: null, hotkeyRegistered: false, hotkeyNote: 'guardian-unreachable' };
    }
    return {
      hotkey: typeof status?.hotkey === 'string' ? status.hotkey : null,
      hotkeyRegistered: status?.hotkeyRegistered === true,
      ...(typeof status?.hotkeyError === 'string' && status.hotkeyError
        ? { hotkeyError: status.hotkeyError }
        : {}),
      ...(status?.[GUARDIAN_STATUS_MUTEX] === true ? { mutex: true } : { mutex: false }),
      ...(status?.[GUARDIAN_STATUS_FLAG] !== undefined
        ? { [GUARDIAN_STATUS_FLAG]: status[GUARDIAN_STATUS_FLAG] }
        : {}),
    };
  }

  function frameKeyFor(driverFrame) {
    if (!driverFrame || driverFrame.backend !== 'cua') return null;
    if (driverFrame.windowKey) return driverFrame.windowKey;
    if (driverFrame.pid == null) return 'desktop:primary';
    return null;
  }

  function checkDriverFrameBinding(driverFrame) {
    if (!driverFrame || typeof driverFrame !== 'object') {
      throw driverError(
        'STALE_FRAME',
        'This action needs a fresh frame. Observe or inspect again before acting.',
      );
    }
    if (driverFrame.backend !== 'cua') {
      throw driverError(
        'STALE_FRAME',
        'This frame belongs to another backend. Observe again on the CUA backend.',
      );
    }
    const key = frameKeyFor(driverFrame);
    if (!key)
      throw driverError(
        'INVALID_PARAMS',
        'expectedFrame.driverFrame must carry backend, windowKey or desktop binding, and snapshotId.',
      );
    if (typeof driverFrame.snapshotId !== 'string' || !/^s[0-9a-f]{8}$/i.test(driverFrame.snapshotId)) {
      throw driverError('INVALID_PARAMS', 'expectedFrame.driverFrame.snapshotId must look like sXXXXXXXX.');
    }
    const stored = frameBindings.get(key);
    if (!stored) {
      throw driverError(
        'STALE_FRAME',
        'No fresh CUA snapshot is bound in this driver session. Observe or inspect again before acting.',
      );
    }
    if (stored.generation !== generation) {
      throw driverError(
        'STALE_FRAME',
        'The CUA snapshot was invalidated by a stop. Observe or inspect again before acting.',
      );
    }
    if (stored.snapshotId.toLowerCase() !== String(driverFrame.snapshotId).toLowerCase()) {
      throw driverError(
        'STALE_FRAME',
        'This CUA snapshot is superseded. Observe or inspect again for a fresh frame before acting.',
      );
    }
    return { key, stored };
  }

  function mintDriverFrame({
    kind,
    pid,
    window_id,
    windowKey,
    snapshotId,
    screenshotWidth,
    screenshotHeight,
    scaleFactor,
  }) {
    const capturedAt = new Date(now()).toISOString();
    return {
      backend: 'cua',
      kind,
      pid: pid ?? null,
      windowId: window_id ?? null,
      windowKey: windowKey ?? null,
      snapshotId,
      screenshotWidth: screenshotWidth ?? null,
      screenshotHeight: screenshotHeight ?? null,
      ...(scaleFactor !== undefined ? { scaleFactor } : {}),
      sessionLabel,
      capturedAt,
      transport: 'daemon+proxy',
      ...(transport?.daemonPid ? { daemonPid: transport.daemonPid } : {}),
      ...(transport?.proxyPid ? { proxyPid: transport.proxyPid } : {}),
    };
  }

  function rememberBinding(driverFrame, width, height) {
    const key = frameKeyFor(driverFrame);
    if (!key) return;
    // A new snapshot supersedes the older binding for its key: the bridge
    // invalidates older CUA frames after every new snapshot.
    frameBindings.set(key, {
      snapshotId: driverFrame.snapshotId,
      kind: driverFrame.kind,
      width,
      height,
      generation,
    });
  }

  async function doStatus() {
    const startedAt = now();
    ensurePlatform();
    const info = await availability().catch((error) => ({
      available: false,
      backend: 'cua',
      reason: String(error?.message || error).slice(0, 300),
    }));
    const hot = await guardianHotkeyState();
    const endedAt = now();
    return {
      supported: true,
      platform: 'win32',
      arch: 'x64',
      backend: 'cua',
      available: Boolean(info.available),
      ...(info.path || info.driverPath ? { driverPath: info.path || info.driverPath } : {}),
      ...(info.version || info.driverVersion
        ? { driverVersion: String(info.version || info.driverVersion).slice(0, 100) }
        : {}),
      ...(info.reason ? { reason: String(info.reason).slice(0, 500) } : {}),
      driverTag: CUA_DRIVER_TAG,
      driverCommit: CUA_DRIVER_COMMIT,
      contractVersion: CUA_CONTRACT_VERSION,
      transport: 'daemon+proxy',
      hotkey: hot.hotkey,
      hotkeyRegistered: hot.hotkeyRegistered,
      ...(hot.hotkeyError ? { hotkeyError: hot.hotkeyError } : {}),
      ...(hot.hotkeyNote ? { hotkeyNote: hot.hotkeyNote } : {}),
      guardian: guardian ? 'owned-native-worker' : 'none',
      ...(hot.mutex !== undefined ? { mutex: hot.mutex } : {}),
      ...(hot[GUARDIAN_STATUS_FLAG] !== undefined
        ? { [GUARDIAN_STATUS_FLAG]: hot[GUARDIAN_STATUS_FLAG] }
        : {}),
      timing: {
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs: endedAt - startedAt,
      },
    };
  }

  async function doWindowsList(params, { signal, timeoutMs }) {
    await verifyGuardianCapability();
    const activeTransport = await ensureTransport();
    const startedAt = now();
    const { result, timing } = await activeTransport.callTool(
      'list_windows',
      { session: sessionLabel },
      { signal, timeoutMs },
    );
    throwIfCuaError({ result }, 'list_windows');
    const structured = structuredOf(result);
    const rows = Array.isArray(structured.windows)
      ? structured.windows
      : Array.isArray(result.windows)
        ? result.windows
        : [];
    let bestZ = null;
    for (const row of rows) {
      if (row && typeof row.z_index === 'number' && (bestZ === null || row.z_index > bestZ))
        bestZ = row.z_index;
    }
    const windows = rows
      .filter((row) => row && Number.isInteger(row.window_id) && Number.isInteger(row.pid))
      .map((row) => {
        const bounds =
          row.bounds && typeof row.bounds === 'object' && Number.isFinite(row.bounds.width)
            ? {
                x: Math.round(row.bounds.x),
                y: Math.round(row.bounds.y),
                width: Math.round(row.bounds.width),
                height: Math.round(row.bounds.height),
              }
            : undefined;
        return {
          id: `${row.pid}:${row.window_id}`,
          title: typeof row.title === 'string' ? row.title : '',
          processId: row.pid,
          ...(typeof row.app_name === 'string' ? { processName: row.app_name } : {}),
          ...(bounds ? { bounds } : {}),
          foreground: typeof row.z_index === 'number' ? row.z_index === bestZ : undefined,
        };
      });
    const endedAt = now();
    return {
      windows,
      timing: {
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs: endedAt - startedAt,
        tools: [{ tool: 'list_windows', durationMs: timing.durationMs }],
      },
    };
  }

  async function doWindowsFocus(params, { signal, timeoutMs }) {
    // User-explicit focus only: the bridge never sends focus as an
    // automatic fallback. Verified bring_to_front contract (impl_.rs):
    // requires pid, optional window_id (HWND), deliberately foregrounds,
    // returns previous/now foreground HWNDs. Surfaced with no force
    // parity: a foreground-lock refusal is an explicit error, never a
    // silent no-op. Focusing may restack windows, so every binding clears.
    await verifyGuardianCapability();
    const activeTransport = await ensureTransport();
    const { pid, window_id } = parseWindowKey(params.windowId);
    const startedAt = now();
    const { result, timing } = await activeTransport.callTool(
      'bring_to_front',
      { pid, window_id },
      { signal, timeoutMs },
    );
    throwIfCuaError({ result }, 'bring_to_front');
    frameBindings.clear();
    const structured = structuredOf(result);
    const endedAt = now();
    return {
      focused: true,
      windowId: `${pid}:${window_id}`,
      ...(structured.previous_fg_hwnd !== undefined
        ? { previousForeground: structured.previous_fg_hwnd }
        : {}),
      ...(structured.now_fg_hwnd !== undefined ? { foregroundNow: structured.now_fg_hwnd } : {}),
      timing: {
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs: endedAt - startedAt,
        tools: [{ tool: 'bring_to_front', durationMs: timing.durationMs }],
      },
    };
  }

  function snapshotIdFrom(structured, elements) {
    if (
      structured &&
      typeof structured.snapshot_id === 'string' &&
      /^s[0-9a-f]{8}$/i.test(structured.snapshot_id)
    ) {
      return structured.snapshot_id.toLowerCase();
    }
    if (
      structured &&
      typeof structured.snapshotId === 'string' &&
      /^s[0-9a-f]{8}$/i.test(structured.snapshotId)
    ) {
      return structured.snapshotId.toLowerCase();
    }
    const tokens = (elements || []).map((el) => el && el.element_token).filter((t) => typeof t === 'string');
    const parsed = tokens.map(parseToken).filter(Boolean);
    if (parsed.length && parsed.every((p) => p.snapshotId === parsed[0].snapshotId))
      return parsed[0].snapshotId;
    throw driverError('CUA_IMAGE_MISSING', 'get_window_state omitted the snapshot_id binding.');
  }

  async function doObserve(params, { signal, timeoutMs }) {
    await verifyGuardianCapability();
    const activeTransport = await ensureTransport();
    const startedAt = now();
    const toolTimings = [];
    if (params.windowId !== undefined) {
      const { pid, window_id, windowKey } = parseWindowKey(params.windowId);
      const args = { pid, window_id, include_screenshot: true, session: sessionLabel };
      if (params.maxWidth !== undefined) args.max_dimension = params.maxWidth;
      const { result, timing } = await activeTransport.callTool('get_window_state', args, {
        signal,
        timeoutMs,
      });
      toolTimings.push({ tool: 'get_window_state', durationMs: timing.durationMs });
      throwIfCuaError({ result }, 'get_window_state');
      const structured = structuredOf(result);
      const imageNode = pickImageContent(result);
      if (!imageNode)
        throw driverError('CUA_IMAGE_MISSING', 'get_window_state returned no screenshot image.');
      const width = structured.screenshot_width ?? null;
      const height = structured.screenshot_height ?? null;
      if (!isInt(width) || !isInt(height) || width < 1 || height < 1) {
        throw driverError('CUA_IMAGE_MISSING', 'get_window_state omitted screenshot dimensions.');
      }
      if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
        throw driverError(
          'IMAGE_TOO_LARGE',
          `CUA screenshot is ${width}x${height}; both sides must stay at or under ${MAX_IMAGE_DIM}. Upstream default long-edge 1568 fits; this target needs a narrower window capture.`,
        );
      }
      const elements = Array.isArray(structured.elements) ? structured.elements : [];
      const snapshotId = snapshotIdFrom(structured, elements);
      // Physical bounds from the SAME verified response (window_bounds).
      const wb =
        structured.window_bounds && typeof structured.window_bounds === 'object'
          ? structured.window_bounds
          : null;
      const bounds =
        wb && Number.isFinite(wb.width) && Number.isFinite(wb.height)
          ? {
              x: Math.round(wb.x),
              y: Math.round(wb.y),
              width: Math.round(wb.width),
              height: Math.round(wb.height),
            }
          : { x: 0, y: 0, width, height };
      const scale = typeof structured.screenshot_scale === 'number' ? structured.screenshot_scale : undefined;
      const capturedAt = new Date(now()).toISOString();
      const driverFrame = mintDriverFrame({
        kind: 'screenshot',
        pid,
        window_id,
        windowKey,
        snapshotId,
        screenshotWidth: width,
        screenshotHeight: height,
        scaleFactor: scale,
      });
      rememberBinding(driverFrame, width, height);
      // The AX tree rides along for free when get_window_state walks it:
      // return it bounded so the bridge can skip a follow-up inspect loop.
      const bounded = elements.slice(0, MAX_ELEMENTS_HARD).map(summarizeElement);
      const endedAt = now();
      return {
        image: { data: imageNode.data, mimeType: imageNode.mime_type || imageNode.mimeType || 'image/png' },
        frame: { width, height, bounds, capturedAt, windowId: windowKey },
        driverFrame,
        elements: bounded,
        truncated:
          elements.length > bounded.length ||
          structured.truncated === true ||
          structured.elements_complete === false,
        elementCount: structured.total_element_count ?? structured.returned_element_count ?? elements.length,
        timing: {
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          durationMs: endedAt - startedAt,
          tools: toolTimings,
          maxWidthHonored: params.maxWidth === undefined ? null : true,
        },
      };
    }
    // Desktop primary display only. Verified: no max_dimension knob here;
    // the PNG is native size, so maxWidth is reported, never faked. A 4K
    // desktop refuses IMAGE_TOO_LARGE: select a window in beta.
    const { result, timing } = await activeTransport.callTool(
      'get_desktop_state',
      { session: sessionLabel },
      { signal, timeoutMs },
    );
    toolTimings.push({ tool: 'get_desktop_state', durationMs: timing.durationMs });
    throwIfCuaError({ result }, 'get_desktop_state');
    const structured = structuredOf(result);
    const imageNode = pickImageContent(result);
    if (!imageNode) throw driverError('CUA_IMAGE_MISSING', 'get_desktop_state returned no screenshot image.');
    const width = structured.screenshot_width ?? null;
    const height = structured.screenshot_height ?? null;
    if (!isInt(width) || !isInt(height) || width < 1 || height < 1) {
      throw driverError('CUA_IMAGE_MISSING', 'get_desktop_state omitted screenshot dimensions.');
    }
    if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
      throw driverError(
        'IMAGE_TOO_LARGE',
        `CUA desktop screenshot is ${width}x${height}; both sides must stay at or under ${MAX_IMAGE_DIM}. Capture a window instead in beta; no downscale or frame transform is applied.`,
      );
    }
    const capturedAt = new Date(now()).toISOString();
    snapshotCounter = (snapshotCounter + 1) % 0xffffffff;
    const snapshotId = `s${(Math.floor(now() % 0xffffffff) + snapshotCounter).toString(16).padStart(8, '0').slice(-8)}`;
    const driverFrame = mintDriverFrame({
      kind: 'screenshot',
      pid: null,
      window_id: null,
      windowKey: null,
      snapshotId,
      screenshotWidth: width,
      screenshotHeight: height,
      scaleFactor: structured.scale_factor,
    });
    rememberBinding(driverFrame, width, height);
    const endedAt = now();
    const screenWidth = structured.screen_width ?? width;
    const screenHeight = structured.screen_height ?? height;
    return {
      image: { data: imageNode.data, mimeType: 'image/png' },
      frame: {
        width,
        height,
        bounds: { x: 0, y: 0, width: screenWidth | 0, height: screenHeight | 0 },
        capturedAt,
      },
      driverFrame,
      desktopBounds: { x: 0, y: 0, width: screenWidth | 0, height: screenHeight | 0 },
      timing: {
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs: endedAt - startedAt,
        tools: toolTimings,
        maxWidthHonored: params.maxWidth === undefined ? null : false,
        ...(params.maxWidth !== undefined ? { maxWidthRequested: params.maxWidth } : {}),
      },
    };
  }

  async function doInspect(params, { signal, timeoutMs }) {
    await verifyGuardianCapability();
    const activeTransport = await ensureTransport();
    const startedAt = now();
    const toolTimings = [];
    const maxElements = params.maxElements ?? MAX_ELEMENTS_DEFAULT;
    const { pid, window_id, windowKey } = parseWindowKey(params.windowId);
    const args = {
      pid,
      window_id,
      include_screenshot: false,
      max_elements: maxElements,
      session: sessionLabel,
    };
    if (params.query !== undefined) args.query = params.query;
    const { result, timing } = await activeTransport.callTool('get_window_state', args, {
      signal,
      timeoutMs,
    });
    toolTimings.push({ tool: 'get_window_state', durationMs: timing.durationMs });
    throwIfCuaError({ result }, 'get_window_state');
    const structured = structuredOf(result);
    const all = Array.isArray(structured.elements) ? structured.elements : [];
    const snapshotId = snapshotIdFrom(structured, all);
    const sliced = all.slice(0, maxElements).map(summarizeElement);
    const wb =
      structured.window_bounds && typeof structured.window_bounds === 'object'
        ? structured.window_bounds
        : null;
    const bounds =
      wb && Number.isFinite(wb.width) && Number.isFinite(wb.height)
        ? {
            x: Math.round(wb.x),
            y: Math.round(wb.y),
            width: Math.round(wb.width),
            height: Math.round(wb.height),
          }
        : { x: 0, y: 0, width: 800, height: 600 };
    const capturedAt = new Date(now()).toISOString();
    const driverFrame = mintDriverFrame({
      kind: 'accessibility',
      pid,
      window_id,
      windowKey,
      snapshotId,
      screenshotWidth: bounds.width,
      screenshotHeight: bounds.height,
    });
    rememberBinding(driverFrame, bounds.width, bounds.height);
    const endedAt = now();
    return {
      elements: sliced,
      truncated: all.length > sliced.length,
      elementCount: all.length,
      frame: { width: bounds.width, height: bounds.height, bounds, capturedAt, windowId: windowKey },
      driverFrame,
      timing: {
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs: endedAt - startedAt,
        tools: toolTimings,
      },
    };
  }

  function scrollPlan(action) {
    const plans = [];
    const { deltaX = 0, deltaY = 0 } = action;
    if (deltaY !== 0)
      plans.push({ direction: deltaY > 0 ? 'down' : 'up', amount: Math.min(50, Math.abs(deltaY)) });
    if (deltaX !== 0)
      plans.push({ direction: deltaX > 0 ? 'right' : 'left', amount: Math.min(50, Math.abs(deltaX)) });
    return plans;
  }

  function partialResult(startedAt, toolTimings, results, executed, error) {
    const endedAt = now();
    return {
      executed,
      results,
      partial: true,
      error,
      timing: {
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs: endedAt - startedAt,
        tools: toolTimings,
      },
    };
  }

  async function doAct(params, { signal, timeoutMs }) {
    const driverFrame = params.expectedFrame?.driverFrame;
    const batchMode = params.deliveryMode;
    const hasInput = params.actions.some((a) => a.type !== 'wait');
    let binding = null;
    if (hasInput) {
      binding = checkDriverFrameBinding(driverFrame);
      if (
        binding.stored.kind === 'accessibility' &&
        params.actions.some((a) => a.x !== undefined || a.y !== undefined || a.path !== undefined)
      ) {
        throw driverError(
          'AX_ONLY_FRAME',
          'This frame is AX-only (inspect without screenshot). Pixel x/y actions are rejected; observe again for screenshot pixels or act with elementId.',
        );
      }
      for (let i = 0; i < params.actions.length; i++) {
        const action = params.actions[i];
        if (action.elementId !== undefined) {
          const parsed = parseToken(action.elementId);
          if (!parsed || parsed.snapshotId !== binding.stored.snapshotId.toLowerCase()) {
            throw driverError(
              'STALE_FRAME',
              `actions[${i}].elementId is from a superseded snapshot. Observe or inspect again for a fresh elementId.`,
            );
          }
        }
      }
      for (let i = 0; i < params.actions.length; i++) {
        const action = params.actions[i];
        if (action.x !== undefined) {
          checkFrameCoord(action.x, binding.stored.width, `actions[${i}].x`);
          checkFrameCoord(action.y, binding.stored.height, `actions[${i}].y`);
        }
        if (Array.isArray(action.path)) {
          action.path.forEach((point, pointIndex) => {
            checkFrameCoord(point.x, binding.stored.width, `actions[${i}].path[${pointIndex}].x`);
            checkFrameCoord(point.y, binding.stored.height, `actions[${i}].path[${pointIndex}].y`);
          });
        }
      }
    }
    const isDesktop = !binding || binding.key === 'desktop:primary';
    const pid = driverFrame?.pid ?? null;
    const window_id = driverFrame?.windowId ?? null;
    const session = sessionLabel;
    // Whole-batch prevalidation BEFORE the first dispatch: no CUA call and
    // no guardian arm may go out when a later action is already known
    // unsupported. A rejected batch leaves the binding untouched.
    for (let index = 0; index < params.actions.length; index++) {
      const action = params.actions[index];
      if (action.type === 'move' && !isDesktop) {
        throw driverError(
          'UNSUPPORTED_MOVE',
          `actions[${index}] move on a window frame is unsupported in beta: CUA window-scope move animates only the agent overlay and never moves the real pointer. Observe the desktop and move there (scope desktop moves the real pointer), or click/type to focus instead.`,
        );
      }
      if (action.type === 'double_click' && isDesktop) {
        throw driverError(
          'UNSUPPORTED_OPERATION',
          `actions[${index}] desktop double_click is unsupported in beta (DoubleClick requires pid). Send two click actions instead.`,
        );
      }
      if (action.type === 'set_value' && isDesktop) {
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}] set_value is window AX-only and cannot target the desktop.`,
        );
      }
      if (
        isDesktop &&
        action.elementId !== undefined &&
        (action.type === 'click' || action.type === 'type')
      ) {
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}] desktop ${action.type} takes pixels, not elementId.`,
        );
      }
      if (action.type === 'scroll' && isDesktop && action.x === undefined) {
        throw driverError(
          'INVALID_PARAMS',
          `actions[${index}] desktop scroll needs an x/y anchor in frame pixels.`,
        );
      }
    }
    await verifyGuardianCapability();
    const activeTransport = await ensureTransport();
    const startedAt = now();
    const toolTimings = [];
    const results = [];
    let executed = 0;

    // Batch delivery: explicit batch mode wins; otherwise element AX rides
    // background (own-target UIA, never fronts) and pixel/desktop rides
    // foreground (Studio opt-in real input). Move/set_value/wait take none.
    const deliveryFor = (action) => {
      if (batchMode) return batchMode;
      if (action.elementId !== undefined || action.type === 'set_value') return 'background';
      return 'foreground';
    };

    const callOne = async (tool, toolArgs) => {
      const { result, timing } = await activeTransport.callTool(tool, toolArgs, { signal, timeoutMs });
      toolTimings.push({ tool, durationMs: timing.durationMs });
      throwIfCuaError({ result }, tool);
      const structured = structuredOf(result);
      const effect =
        typeof structured.effect === 'string' && EFFECTS.has(structured.effect)
          ? structured.effect
          : 'unverifiable';
      const route = typeof structured.route === 'string' ? structured.route : 'unknown';
      return {
        effect,
        route,
        delivery: structured.delivery,
        evidence: structured.evidence,
        escalation: structured.escalation,
      };
    };

    for (let index = 0; index < params.actions.length; index++) {
      if (signal?.aborted) throw driverError('ABORTED', `CUA act was aborted at action ${index}.`);
      const action = params.actions[index];
      if (action.type === 'wait') {
        const waitStart = now();
        await new Promise((done) => setTimeout(done, action.ms));
        toolTimings.push({ tool: 'wait', durationMs: now() - waitStart });
        results.push({ index, type: 'wait', tool: 'wait', effect: 'confirmed', route: 'not_applicable' });
        executed += 1;
        continue;
      }
      // Arm the guardian with this action's exact held set BEFORE any CUA
      // dispatch. The arm is released (disarmed) only when the action
      // completes confirmed; on partial/unknown/refused/error the arm is
      // preserved until stop/close cleanup so held input can never leak.
      // Hold-nothing actions skip the arm the native guard would refuse and
      // only an action that armed may disarm, so a skip never clears a stale arm.
      let armedHere = false;
      if (action.type !== 'move') {
        const held = heldFor(action);
        if (held.buttons.length > 0 || held.keys.length > 0) {
          await guardianArm(held);
          armedHere = true;
        }
      }
      if (action.type === 'move') {
        // Prevalidated desktop-only: scope desktop moves the real OS
        // pointer (verified SetCursorPos path).
        try {
          const outcome = await callOne('move_cursor', {
            scope: 'desktop',
            x: action.x,
            y: action.y,
            session,
          });
          if (outcome.effect !== 'confirmed') {
            results.push({ index, type: 'move', tool: 'move_cursor', ...outcome });
            const code =
              outcome.effect === 'refused'
                ? 'CUA_REFUSED'
                : outcome.effect === 'partial'
                  ? 'CUA_PARTIAL'
                  : outcome.effect === 'suspected_noop'
                    ? 'CUA_SUSPECTED_NOOP'
                    : 'CUA_UNVERIFIABLE';
            return partialResult(startedAt, toolTimings, results, executed, {
              code,
              message: `move_cursor returned ${outcome.effect}; stopping the batch without claiming further actions.`,
            });
          }
          executed += 1;
          results.push({ index, type: 'move', tool: 'move_cursor', ...outcome });
        } catch (error) {
          if (
            error &&
            (error.code === 'TIMEOUT' ||
              error.code === 'ABORTED' ||
              error.code === 'DRIVER_CLOSED' ||
              error.code === 'TRANSPORT_CLOSED' ||
              error.code === 'TRANSPORT_EXIT' ||
              error.code === 'TRANSPORT_NOT_STARTED')
          )
            throw error;
          if (
            error &&
            (error.code === 'STALE_FRAME' ||
              error.code === 'INVALID_PARAMS' ||
              error.code === 'AX_ONLY_FRAME' ||
              error.code === 'GUARDIAN_MISSING' ||
              error.code === 'GUARDIAN_CAPABILITY_MISSING' ||
              error.code === 'DRIVER_STOPPED')
          )
            throw error;
          return partialResult(startedAt, toolTimings, results, executed, {
            code: error.code || 'CUA_TOOL_ERROR',
            message: String(error.message || error).slice(0, 500),
          });
        }
        continue;
      }
      const calls = [];
      if (action.type === 'click') {
        if (isDesktop) {
          calls.push([
            'click',
            {
              x: action.x,
              y: action.y,
              scope: 'desktop',
              session,
              ...(action.button ? { button: action.button } : {}),
            },
          ]);
        } else if (action.elementId !== undefined) {
          calls.push([
            'click',
            {
              pid,
              window_id,
              scope: 'window',
              element_token: action.elementId,
              snapshot_id: binding.stored.snapshotId,
              delivery_mode: deliveryFor(action),
              session,
              ...(action.button ? { button: action.button } : {}),
            },
          ]);
        } else {
          calls.push([
            'click',
            {
              pid,
              window_id,
              scope: 'window',
              x: action.x,
              y: action.y,
              delivery_mode: deliveryFor(action),
              session,
              ...(action.button ? { button: action.button } : {}),
            },
          ]);
        }
      } else if (action.type === 'double_click') {
        if (action.elementId !== undefined) {
          calls.push([
            'double_click',
            {
              pid,
              window_id,
              element_token: action.elementId,
              snapshot_id: binding.stored.snapshotId,
              delivery_mode: deliveryFor(action),
              session,
            },
          ]);
        } else {
          calls.push([
            'double_click',
            { pid, window_id, x: action.x, y: action.y, delivery_mode: deliveryFor(action), session },
          ]);
        }
      } else if (action.type === 'drag') {
        const to =
          action.path && action.path.length
            ? action.path[action.path.length - 1]
            : { x: action.x, y: action.y };
        if (isDesktop) {
          calls.push([
            'drag',
            {
              scope: 'desktop',
              from_x: action.x,
              from_y: action.y,
              to_x: to.x,
              to_y: to.y,
              session,
              ...(action.button ? { button: action.button } : {}),
            },
          ]);
        } else {
          calls.push([
            'drag',
            {
              pid,
              window_id,
              scope: 'window',
              from_x: action.x,
              from_y: action.y,
              to_x: to.x,
              to_y: to.y,
              delivery_mode: deliveryFor(action),
              session,
              ...(action.button ? { button: action.button } : {}),
            },
          ]);
        }
      } else if (action.type === 'scroll') {
        // Dual-axis scroll fans out to two verified single-axis dispatches
        // under ONE native action. A second-dispatch failure returns
        // partial (first dispatch stands, current action uncounted).
        const plans = scrollPlan(action);
        for (const plan of plans) {
          if (isDesktop) {
            calls.push([
              'scroll',
              {
                x: action.x,
                y: action.y,
                scope: 'desktop',
                direction: plan.direction,
                amount: plan.amount,
                by: 'line',
                session,
              },
            ]);
          } else {
            const base = {
              pid,
              window_id,
              scope: 'window',
              direction: plan.direction,
              amount: plan.amount,
              by: 'line',
              delivery_mode: deliveryFor(action),
              session,
            };
            if (action.elementId !== undefined) {
              base.element_token = action.elementId;
              base.snapshot_id = binding.stored.snapshotId;
            } else if (action.x !== undefined) {
              base.x = action.x;
              base.y = action.y;
            }
            calls.push(['scroll', base]);
          }
        }
      } else if (action.type === 'keypress') {
        if (action.keys.length === 1) {
          const base = isDesktop
            ? { scope: 'desktop', key: action.keys[0], session }
            : {
                pid,
                window_id,
                scope: 'window',
                key: action.keys[0],
                delivery_mode: deliveryFor(action),
                session,
              };
          if (!isDesktop && action.elementId !== undefined) {
            base.element_token = action.elementId;
            base.snapshot_id = binding.stored.snapshotId;
          }
          if (action.x !== undefined) {
            base.x = action.x;
            base.y = action.y;
          }
          calls.push(['press_key', base]);
        } else {
          const base = isDesktop
            ? { scope: 'desktop', keys: action.keys, session }
            : {
                pid,
                window_id,
                scope: 'window',
                keys: action.keys,
                delivery_mode: deliveryFor(action),
                session,
              };
          if (!isDesktop && action.elementId !== undefined) {
            base.element_token = action.elementId;
            base.snapshot_id = binding.stored.snapshotId;
          }
          if (action.x !== undefined) {
            base.x = action.x;
            base.y = action.y;
          }
          calls.push(['hotkey', base]);
        }
      } else if (action.type === 'type') {
        if (isDesktop) {
          calls.push(['type_text', { scope: 'desktop', text: action.text, session }]);
        } else {
          const base = {
            pid,
            window_id,
            scope: 'window',
            text: action.text,
            delivery_mode: deliveryFor(action),
            session,
          };
          if (action.elementId !== undefined) {
            base.element_token = action.elementId;
            base.snapshot_id = binding.stored.snapshotId;
          } else if (action.x !== undefined) {
            base.x = action.x;
            base.y = action.y;
          }
          calls.push(['type_text', base]);
        }
      } else if (action.type === 'set_value') {
        calls.push([
          'set_value',
          {
            pid,
            window_id,
            element_token: action.elementId,
            snapshot_id: binding.stored.snapshotId,
            value: action.value,
            session,
          },
        ]);
      }
      // First unknown/partial/refused dispatch stops the batch with
      // structured partial/results/executed. executed counts only confirmed
      // native actions; the stopping action is reported but uncounted. The
      // guardian arm is preserved (no disarm) so stop/close cleanup owns it.
      const actionToolNames = calls.map((c) => c[0]).join('+');
      const dispatchOutcomes = [];
      try {
        for (const [tool, toolArgs] of calls) {
          const outcome = await callOne(tool, toolArgs);
          dispatchOutcomes.push({ tool, ...outcome });
          if (outcome.effect !== 'confirmed') break;
        }
      } catch (error) {
        if (
          error &&
          (error.code === 'TIMEOUT' ||
            error.code === 'ABORTED' ||
            error.code === 'DRIVER_CLOSED' ||
            error.code === 'TRANSPORT_CLOSED' ||
            error.code === 'TRANSPORT_EXIT' ||
            error.code === 'TRANSPORT_NOT_STARTED')
        )
          throw error;
        if (
          error &&
          (error.code === 'STALE_FRAME' ||
            error.code === 'INVALID_PARAMS' ||
            error.code === 'AX_ONLY_FRAME' ||
            error.code === 'GUARDIAN_MISSING' ||
            error.code === 'GUARDIAN_CAPABILITY_MISSING' ||
            error.code === 'DRIVER_STOPPED')
        )
          throw error;
        return partialResult(startedAt, toolTimings, results, executed, {
          code: error.code || 'CUA_TOOL_ERROR',
          message: String(error.message || error).slice(0, 500),
        });
      }
      const stopper = dispatchOutcomes.find((d) => d.effect !== 'confirmed');
      if (stopper) {
        const code =
          stopper.effect === 'refused'
            ? 'CUA_REFUSED'
            : stopper.effect === 'partial'
              ? 'CUA_PARTIAL'
              : stopper.effect === 'suspected_noop'
                ? 'CUA_SUSPECTED_NOOP'
                : 'CUA_UNVERIFIABLE';
        results.push({
          index,
          type: action.type,
          tool: actionToolNames,
          ...stopper,
          ...(dispatchOutcomes.length > 1 ? { dispatches: dispatchOutcomes } : {}),
        });
        return partialResult(startedAt, toolTimings, results, executed, {
          code,
          message: `${stopper.tool} returned ${stopper.effect} at actions[${index}]; stopping the batch. Observe again; never replay blindly.`,
        });
      }
      executed += 1;
      results.push({
        index,
        type: action.type,
        tool: actionToolNames,
        ...dispatchOutcomes[dispatchOutcomes.length - 1],
      });
      // Disarm only when this action armed and confirmed. Anything else
      // preserves the arm for stop/close cleanup (process-death ownership),
      // including a skipped empty arm which must not clear a stale plan.
      if (!armedHere) continue;
      try {
        await guardianDisarm();
      } catch {
        // Disarm failure keeps the safe side (arm held for cleanup); the
        // batch already earned its confirmed count. Report, do not revoke.
        emit({
          kind: 'cua_supervisor',
          warning: `guardian disarm failed after confirmed actions[${index}]; arm preserved for cleanup`,
        });
      }
    }
    const endedAt = now();
    return {
      executed,
      results,
      timing: {
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs: endedAt - startedAt,
        tools: toolTimings,
      },
    };
  }

  async function request(command, { signal, timeoutMs } = {}) {
    const { method, params } = validateCommand(command);
    if (closed) throw driverError('DRIVER_CLOSED', 'CUA computer-use driver is closed.');
    if (method === 'status') return doStatus();
    ensurePlatform();
    if (stopped) {
      if (method === 'stop') return stop('user');
      throw driverError(
        'DRIVER_STOPPED',
        'CUA computer-use driver was stopped. Create a fresh adapter after stop.',
      );
    }
    if (jobUncertain && method !== 'stop') {
      throw driverError(
        'JOB_UNCERTAIN',
        'CUA job proof was lost. No fresh pair may start while uncertainty remains; reconcile or close.',
      );
    }
    if (signal?.aborted) throw driverError('ABORTED', `CUA ${method} was aborted before sending.`);
    const genAtEntry = generation;
    const id = nextRequestId++;
    const deadline = timeoutMs ?? defaultTimeoutMs;
    let timer;
    const gate = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (!active.has(id)) return;
        active.delete(id);
        reject(driverError('TIMEOUT', `CUA ${method} timed out after ${deadline}ms.`));
      }, deadline);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const run = (async () => {
      const entry = { reject: () => {}, method };
      active.set(id, entry);
      const tracked = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      const work = (async () => {
        if (closed) throw driverError('DRIVER_CLOSED', 'CUA computer-use driver is closed.');
        if (stopped) throw driverError('DRIVER_STOPPED', 'CUA computer-use driver was stopped.');
        if (generation !== genAtEntry)
          throw driverError('STOPPED', `CUA ${method} was stopped before sending.`);
        let result;
        if (method === 'windows') {
          result =
            params.action === 'focus'
              ? await doWindowsFocus(params, { signal, timeoutMs: deadline })
              : await doWindowsList(params, { signal, timeoutMs: deadline });
        } else if (method === 'observe') result = await doObserve(params, { signal, timeoutMs: deadline });
        else if (method === 'inspect') result = await doInspect(params, { signal, timeoutMs: deadline });
        else if (method === 'act') result = await doAct(params, { signal, timeoutMs: deadline });
        else if (method === 'stop') {
          const stoppedResult = await stop(params.reason || 'user');
          result = {
            stopped: stoppedResult.stopped,
            reason: stoppedResult.reason,
            treeExited: stoppedResult.treeExited,
          };
        }
        if (generation !== genAtEntry)
          throw driverError('STOPPED', `CUA ${method} was stopped during the call.`);
        return result;
      })();
      work.then(
        (value) => {
          if (active.has(id)) {
            active.delete(id);
            clearTimeout(timer);
            entry.resolve(value);
          }
        },
        (error) => {
          if (active.has(id)) {
            active.delete(id);
            clearTimeout(timer);
            entry.reject(error);
          }
        },
      );
      return tracked;
    })();
    try {
      return await Promise.race([run, gate]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function verifyOwnedExit() {
    const deadline = Date.now() + EXIT_VERIFY_MS;
    while (Date.now() < deadline) {
      const owned = Array.isArray(transport?.ownedPids) ? transport.ownedPids : [];
      if (!owned.length) return true;
      await new Promise((done) => setTimeout(done, 50));
    }
    const owned = Array.isArray(transport?.ownedPids) ? transport.ownedPids : [];
    return owned.length === 0;
  }

  async function runShutdown(label) {
    // Join delayed work FIRST (bounded): a pending guardian acquisition is
    // retained and joined (poisoned on timeout so its late arrival closes
    // itself), then any in-flight pair acquisition. An absent transport
    // with a claimed nonce is still an owned job. Only then branch.
    await joinGuardianAcquisition(Math.max(500, stopTimeoutMs));
    if (startingPromise) {
      try {
        await startingPromise;
      } catch {
        // Startup failure already tore down through failJobStart (verified
        // kill or uncertainty latch); continue to the fence below.
      }
    }
    // Owned CUA tree kill first; exit VERIFIED (tree0) before any cleanup.
    // An early best-effort signal is never proof. A cleanup failure also
    // rejects: the mutex must not release on unverified input state.
    if (activeNonce) {
      const verdict = await guardianRequest('job_kill', { timeoutMs: Math.min(5000, stopTimeoutMs) });
      try {
        await transport?.abort?.(label);
      } catch {}
      if (!verdict || verdict.treeExited !== true || (verdict.activeProcesses ?? 0) !== 0) {
        throw driverError(
          'CUA_TREE_EXIT_FAILED',
          `CUA job kill unverified for stop (${label}): treeExited/activeProcesses not proven zero. Guardian and mutex kept; retry stop or close; reconcile on doubt.`,
          { label },
        );
      }
    } else {
      try {
        await transport?.stop(label);
      } catch {}
      const exited = transport ? await verifyOwnedExit() : true;
      if (!exited) {
        throw driverError(
          'CUA_TREE_EXIT_FAILED',
          `CUA owned processes did not exit for stop (${label}). The guardian and mutex are kept; retry stop or close.`,
          { label },
        );
      }
    }
    // Exactly-once retained cleanup after verified death, shared across
    // concurrent stop/hotkey/close callers for this generation. Only
    // cleanup is allowed after stop: disarm is deliberately never called
    // here (the native stopped latch refuses it, and the retained plan
    // must survive until cleanup proves).
    if (guardian) await cleanupOnce(`cua-stop:${label}`);
    activeNonce = null;
    activeJob = null;
    return { stopped: true, reason: label, generation, treeExited: true };
  }

  function ensureShutdown(label) {
    if (shutdownResult) return Promise.resolve(shutdownResult);
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = runShutdown(label).then(
      (result) => {
        shutdownResult = result;
        shutdownPromise = null;
        return result;
      },
      (error) => {
        // Retryable: clear the in-flight marker so a later stop/close can
        // re-attempt the kill. Generation and latch stay terminal.
        shutdownPromise = null;
        throw error;
      },
    );
    return shutdownPromise;
  }

  /**
   * Preemptive stop. The terminal latch (stopped flag, generation fence,
   * in-flight failure, synchronous onStop manager notification) lands
   * BEFORE any await, so a request racing the kill can never restart the
   * transport. Cleanup runs exactly once after VERIFIED tree exit; an
   * unverified exit fails closed (guardian kept, stopped:false reported).
   * A guardian hotkey stop enters through handleSupervisorStop and shares
   * the same shutdown promise.
   */
  async function stop(reason = 'user') {
    const label = typeof reason === 'string' && reason ? reason : 'user';
    if (!stopped) {
      try {
        startupController?.abort();
      } catch {}
      stopped = true;
      generation += 1;
      frameBindings.clear();
      guardianVerifiedForGeneration = 0;
      failActive('STOPPED', `CUA operation was stopped (${label}).`);
      try {
        onStop?.(label, { event: 'stopped', reason: label, backend: 'cua', generation });
      } catch {}
      emit({ kind: 'cua_stopping', reason: label, generation });
    }
    try {
      const result = await ensureShutdown(label);
      emit({ kind: 'cua_stopped', reason: result.reason, generation, treeExited: true });
      return result;
    } catch (error) {
      emit({ kind: 'cua_stop_unverified', reason: label, code: error.code });
      return {
        stopped: false,
        reason: label,
        generation,
        treeExited: false,
        error: {
          code: error.code || 'CUA_TREE_EXIT_FAILED',
          message: String(error.message || error).slice(0, 500),
        },
      };
    }
  }

  let fullyClosed = false;
  let finishPromise = null;
  async function close() {
    // Retryable shared finalization: ONLY a fully finished close (verified
    // tree0 + cleanup + guardian close) is terminal. A stop success leaves
    // the guardian OPEN, so `if (shutdownResult) return` would be wrong
    // here. A failed finish stays retryable; concurrent closes share one.
    // The terminal closed flag still blocks every new request meanwhile.
    if (fullyClosed) return;
    if (finishPromise) {
      await finishPromise;
      return;
    }
    closed = true;
    try {
      startupController?.abort();
    } catch {}
    if (!stopped) {
      stopped = true;
      generation += 1;
      frameBindings.clear();
      guardianVerifiedForGeneration = 0;
      failActive('DRIVER_CLOSED', 'CUA computer-use driver was closed.');
      try {
        onStop?.('close', { event: 'stopped', reason: 'close', backend: 'cua', generation });
      } catch {}
    }
    // The WHOLE attempt is shared: finishPromise is assigned before any
    // await below, so concurrent closes join one finalization instead of
    // each running transport.close/guardian.close (double finalization).
    finishPromise = (async () => {
      try {
        await ensureShutdown('close');
      } catch (error) {
        // Fail closed: keep the owned guardian (mutex held) and stay
        // retryable; never report a dead tree that may be live.
        throw driverError(
          'CUA_TREE_EXIT_FAILED',
          `CUA close could not verify owned-process exit (${String(error.message || error).slice(0, 300)}). Guardian kept; retry close.`,
        );
      }
      // Verified death plus cleanup first, then finish: release the
      // transport handle and close the OWNED guardian (production default:
      // disable/switch mints a fresh adapter, nothing is shared). No disarm
      // here: after a native stop the latch refuses disarm and the retained
      // plan must survive for cleanup, which already ran above.
      await finishClose();
    })().then(
      () => {
        fullyClosed = true;
        finishPromise = null;
      },
      (error) => {
        finishPromise = null;
        throw error;
      },
    );
    await finishPromise;
  }

  // Finish after a VERIFIED shutdown only. Every failure propagates so a
  // failed close keeps all handles for its retry (never a false verified
  // close). Guardian and transport handles null only on their own success.
  async function finishClose() {
    if (transport) {
      await transport.close();
      transport = null;
    }
    // The retained late-arrival instance (whose immediate close failed)
    // is finalized here too: its failure propagates and stays retryable.
    if (retainedGuardian && typeof retainedGuardian.close === 'function') {
      try {
        await retainedGuardian.close();
      } catch (error) {
        throw driverError(
          'GUARDIAN_CLOSE_FAILED',
          `CUA retained guardian did not close (${String(error.message || error).slice(0, 300)}). Handle kept; retry close.`,
        );
      }
      retainedGuardian = null;
    }
    if (guardian && typeof guardian.close === 'function') {
      try {
        await guardian.close();
      } catch (error) {
        throw driverError(
          'GUARDIAN_CLOSE_FAILED',
          `CUA owned guardian did not close (${String(error.message || error).slice(0, 300)}). Mutex may still be held; retry close.`,
        );
      }
      guardian = null;
    }
    if (ownedHomeCreated && ownedHome) {
      try {
        await rm(ownedHome, { recursive: true, force: true });
      } catch (error) {
        emit({
          kind: 'cua_home',
          warning: `owned home cleanup failed: ${String(error?.message || error).slice(0, 200)}`,
        });
      }
      ownedHomeCreated = false;
    }
  }

  /**
   * Guardian hotkey wiring: the owned native driver calls this from its
   * onStop (global hotkey or native stop) so an external stop fences
   * in-flight CUA work, kills the owned tree, runs the retained cleanup,
   * and reports the manager stop through the same shared shutdown promise.
   */
  async function handleSupervisorStop(reason = 'supervisor') {
    return stop(reason);
  }

  // Disarm helper used after confirmed actions (arm preserved otherwise).
  return {
    request,
    stop,
    close,
    reconcile,
    handleSupervisorStop,
    get started() {
      return Boolean(transport?.started);
    },
    get pid() {
      return transport?.proxyPid ?? null;
    },
    get daemonPid() {
      return transport?.daemonPid ?? null;
    },
    get closedFlag() {
      return closed;
    },
    get stoppedFlag() {
      return stopped;
    },
    get generation() {
      return generation;
    },
    get backend() {
      return 'cua';
    },
  };
}
