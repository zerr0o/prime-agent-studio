/**
 * Stop reasons and manual continuation presentation helpers.
 *
 * Pure logic + one small injected-deps DOM builder. No provider calls, no
 * auto-retry, no draft/focus side effects. The renderer (conversation.js)
 * owns placement; the owner (app.js / conversation-views.js) owns gating
 * (read-only, active run, session binding) and the safe send path.
 *
 * Stop kinds:
 * - "length": output cut by a length limit (thinking-only variants included).
 * - "aborted": user-side interruption (aborted / cancelled spellings).
 * - "error": provider returned an error (generic; detail preserved as-is).
 * - "error-network": transport-level failure (honestly classified only).
 * - null: success / tool-use in progress / streaming / unknown — no notice.
 */

const LENGTH_REASONS = new Set([
  'length',
  'truncated',
  'truncate',
  'output_limit',
  'max_tokens',
  'too_long',
  'max-tokens',
  'output-limit',
]);

const ABORTED_REASONS = new Set([
  'aborted',
  'abort',
  'cancelled',
  'canceled',
  'cancel',
  'interrupt',
  'interrupted',
  'stopped',
  'stop_requested',
  'user_cancelled',
  'user-cancelled',
]);

// Transport-level signals only. HTTP statuses and HTTP reason phrases (502 /
// 503 / 504, bad gateway, service unavailable, gateway timeout) are provider
// errors, not proof of transport failure, so they stay generic — as do quota
// and overload bodies without transport wording. The bare word timeout stays
// a transport signal, except after the word gateway (HTTP reason phrase).
const NETWORK_PATTERN =
  /network|fetch failed|failed to fetch|socket hang up|(?<!gateway )timed?[ -]?out|etimedout|econnreset|econnrefused|econnaborted|enotfound|eai_again|ehostunreach|enetunreach|eai_fail|offline/i;

const SUCCESS_REASONS = new Set([
  '',
  'stop',
  'end_turn',
  'complete',
  'completed',
  'success',
  'tool_use',
  'tool_use_or_stop',
  'stop_or_tool_use',
]);

function cleanReason(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/** Raw error text of a GUI message (never throws, never invents detail). */
export function errorTextOf(message) {
  if (!message || typeof message !== 'object') return '';
  const error = message.error;
  if (typeof error === 'string') return error;
  return '';
}

/** True only for transport-level failures; provider errors stay generic. */
export function isNetworkErrorText(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return NETWORK_PATTERN.test(text);
}

/**
 * Explicit stop kind of a GUI message, or null when no notice applies.
 * Streaming and tool-use-in-progress never produce a notice: the turn is
 * still alive. Success stops never produce one either.
 */
export function stopKindOf(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.streaming) return null;
  if (message.error) {
    // Preserve the old truthy-error grouping: any error flag is a failure.
    // Only string detail is classified; non-string flags stay generic.
    const errorText = errorTextOf(message);
    if (!errorText) return 'error';
    return isNetworkErrorText(errorText) ? 'error-network' : 'error';
  }
  const reason = cleanReason(message.stopReason);
  if (!reason || SUCCESS_REASONS.has(reason)) {
    // Tool calls without an error mean the turn continues via tool results.
    // A bare success stop (or missing reason) is not a failure: no notice.
    return null;
  }
  if (LENGTH_REASONS.has(reason)) return 'length';
  if (ABORTED_REASONS.has(reason)) return 'aborted';
  if (reason === 'error') return 'error';
  // Never invent a failure for unknown native reasons: stay silent.
  return null;
}

/** Notice-worthy stop (excludes streaming / tool-use / success). */
export function shouldShowStopNotice(message) {
  return stopKindOf(message) !== null;
}

/** i18n key for the notice line. Aborted reuses the existing key. */
export function noticeKeyFor(kind) {
  switch (kind) {
    case 'length':
      return 'ui.stop_reponse_tronquee';
    case 'aborted':
      return 'ui.reponse_interrompue';
    case 'error-network':
      return 'ui.stop_erreur_reseau';
    case 'error':
      return 'ui.stop_erreur_fournisseur';
    default:
      return null;
  }
}

/**
 * Latest resumable assistant message id in order, or null.
 * A newer user message (new turn pending) or a later live/successful
 * assistant message (turn alive or superseded) rejects older stops:
 * only a trailing failed assistant turn is ever resumable. System and
 * technical messages after it are ignored.
 */
export function findLatestResumableId(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user') return null;
    if (message.role !== 'assistant') continue;
    if (message.streaming) return null;
    if (stopKindOf(message)) return message.id || null;
    // A later assistant message without a stop kind means the turn moved
    // on (answered, tool result, empty completion): older stops are done.
    return null;
  }
  return null;
}

function gateAllows(gate, messageId, message) {
  if (!gate || typeof gate.canContinue !== 'function') return true;
  try {
    return gate.canContinue(messageId, message) === true;
  } catch {
    // Owner gate failure must never surface a CTA that could hit the wrong
    // session or run: deny the button, keep the notice.
    return false;
  }
}

/**
 * Owner-eligible Continue target for one render list, or null.
 * - Only the latest resumable assistant message is ever eligible (old
 *   failure history keeps its notice but never its CTA).
 * - gate.resumableId (owner-scoped current-conversation id) wins when
 *   provided: only that id is eligible, and only if it is still resumable
 *   in this list (disappeared binding -> null, never a stale id).
 * - gate.hidden, missing onContinue, or a denying canContinue hide the CTA.
 * The notice itself is unaffected: denial hides the button, never the text.
 */
export function resolveContinueTarget(messages, gate = {}) {
  if (!gate || typeof gate.onContinue !== 'function') return null;
  if (gate.hidden === true) return null;
  const list = Array.isArray(messages) ? messages : [];
  // Trailing failure decides: a newer user turn, a later success, or a
  // disappeared binding all yield no CTA (stale ids never invoke another
  // session). An owner-scoped resumableId is eligible only while it is
  // still that trailing failure.
  const latestId = findLatestResumableId(list);
  if (!latestId) return null;
  if (typeof gate.resumableId === 'string' && gate.resumableId && gate.resumableId !== latestId) {
    return null;
  }
  const message = list.find((entry) => entry?.id === latestId);
  const kind = stopKindOf(message);
  if (!kind) return null;
  if (!gateAllows(gate, latestId, message)) return null;
  return { messageId: latestId, kind };
}

/**
 * Visible stop notice node. Built with injected renderer deps only
 * ({ el, icon, tr }) so unit tests can stub them without a browser.
 * Returns null when the message has no explicit stop kind.
 *
 * Layout: notice line always, Continue button only when opts.showContinue
 * is true. Clicking dispatches opts.onContinue(message.id) and nothing
 * else: no retry, no focus move, no draft access.
 */
export function buildStopNotice(deps, message, kind, opts = {}) {
  if (!kind || !deps || typeof deps.el !== 'function') return null;
  const key = noticeKeyFor(kind);
  if (!key) return null;
  const { el, icon, tr } = deps;
  const node = el('div', 'stop-notice');
  try {
    node.dataset.stopKind = kind;
  } catch {
    // Non-DOM test doubles without dataset: keep the node usable.
  }
  if (typeof icon === 'function') {
    try {
      const badge = el('span', 'stop-notice-icon');
      badge.append(icon(kind === 'aborted' ? 'stop' : 'alert'));
      node.append(badge);
    } catch {
      // Icon failure must never drop the visible notice text.
    }
  }
  node.append(el('span', 'stop-notice-text', () => tr(key)));
  if (opts.showContinue === true && typeof opts.onContinue === 'function' && message?.id) {
    const button = el('button', 'conv-window-retry stop-continue');
    try {
      button.type = 'button';
    } catch {}
    try {
      button.setAttribute('data-continue-for', String(message.id));
    } catch {}
    button.append(el('span', '', () => tr('ui.continuer')));
    button.onclick = () => {
      // Owner gate re-checked on click too: read-only / running / binding
      // may have changed since render. Denial swallows the click; the
      // notice stays, nothing is sent, focus never moves.
      if (typeof opts.canContinue === 'function') {
        let allowed = false;
        try {
          allowed = opts.canContinue(message.id, message) === true;
        } catch {
          allowed = false;
        }
        if (!allowed) return;
      }
      opts.onContinue(message.id);
    };
    node.append(button);
  }
  return node;
}
