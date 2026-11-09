// Context details and explicit compaction confirmation.
// Owner-bound by root: every callback closes over the OWNER pane, never the
// globally focused one. No backend, no automatic compaction, no draft access.
// Root dispatches POST /api/runs { message: "/compact" } on the captured
// target through the existing sendMessage pipeline (draft/attachments and
// model/thinking flags preserved by root); this module only calls
// onCompact(target) after explicit user confirm.
// Gauge wiring stays in renderComposerGauge(element, data, { onOpen }) — this
// module never touches global DOM or focus except restoring its own opener.
// Strings live in the translations catalog (contextDetails.*); plain tr().
import { t as tr, getLanguage, onLanguageChange, translateKnown } from './i18n.js';

const msg = (key, params) => tr(`contextDetails.${key}`, params);
function fmt(n) {
  if (!Number.isFinite(n)) return tr('contextDetails.unknown');
  try {
    return new Intl.NumberFormat(getLanguage() === 'en' ? 'en-US' : 'fr-FR').format(n);
  } catch {
    return String(n);
  }
}

// Structured snapshot for root/tests — never parse localized gauge text.
// Unknown stays unknown (never 0); cache miss is null, never an error.
export function getContextSummary(data) {
  const context = data?.contextUsage ?? data?.session?.contextUsage;
  const known =
    Number.isFinite(context?.tokens) &&
    context.tokens >= 0 &&
    Number.isFinite(context?.contextWindow) &&
    context.contextWindow > 0;
  if (!known)
    return {
      known: false,
      tokens: null,
      contextWindow: null,
      percent: null,
      level: null,
      live: false,
      approx: false,
      cache: null,
      lastRequest: false,
    };
  const fill = (context.tokens / context.contextWindow) * 100;
  const percent = Math.min(100, Math.max(0, Math.round(fill)));
  const last = data?.session?.lastRequestUsage;
  const ratio = Number.isFinite(last?.cacheHitRatio) ? last.cacheHitRatio : null;
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  const hasCache =
    ratio !== null ||
    last?.cacheRead != null ||
    last?.cacheWrite != null ||
    last?.input != null ||
    last?.output != null;
  return {
    known: true,
    tokens: context.tokens,
    contextWindow: context.contextWindow,
    percent,
    level: fill >= 95 ? 'danger' : fill >= 80 ? 'warning' : 'normal',
    live: !data?.lastRequest,
    approx: !!data?.lastRequest,
    lastRequest: !!data?.lastRequest,
    cache: !hasCache
      ? null
      : {
          hitRatio: ratio,
          hitPercent: ratio === null ? null : Math.round(ratio * 100),
          input: num(last?.input),
          output: num(last?.output),
          read: num(last?.cacheRead),
          write: num(last?.cacheWrite),
        },
  };
}

const el = (doc, tag, cls = '', text = '') => {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
};

// Minimal UI API for root (wire gauge onClick via root, not global DOM hacks):
//   const details = createContextDetails({ getSnapshot, getState, onCompact });
//   gauge onClick (owner-bound) => details.open(openerElement)
// getSnapshot: () => same shape as renderComposerGauge data (owner pane only).
// getState: () => ({ readOnly, running, hasSession, sessionId, cwd, key,
//   blockedReason?: string }) — blockedReason carries an owner-scoped
//   unavailable reason (offline/loading/generationPending/runtime); shown as-is.
// onCompact: (target) => Promise<boolean|void> — root sends /compact via the
//   existing pipeline on the captured target, preserving draft/attachments and
//   model/thinking flags. false (or a caught failure) keeps the dialog open;
//   confirm() itself never rejects, so fire-and-forget clicks stay pageerror-free.
export function createContextDetails({ getSnapshot, getState, onCompact, doc } = {}) {
  const d = doc || globalThis.document;
  const snapshotOf = typeof getSnapshot === 'function' ? getSnapshot : () => null;
  const stateOf = typeof getState === 'function' ? getState : () => ({});
  const compact = typeof onCompact === 'function' ? onCompact : async () => {};

  let dialog = null,
    opener = null,
    target = null,
    summary = { known: false };
  let pending = false,
    reasonNode = null,
    confirmBtn = null,
    cancelBtn = null,
    bodyNode = null;
  let titleNode = null,
    closeBtn = null,
    errorNode = null,
    confirmError = '';
  let unsubscribe = null,
    closed = false;

  function state() {
    try {
      return stateOf() || {};
    } catch {
      return {};
    }
  }
  function targetKey(s) {
    return [s?.cwd ?? '', s?.sessionId ?? '', s?.key ?? ''].join('\0');
  }
  function disabledReason(s) {
    if (pending) return msg('reasonPending');
    if (target && targetKey(state()) !== target.key) return msg('reasonStale');
    if (typeof s?.blockedReason === 'string' && s.blockedReason.trim()) return s.blockedReason;
    if (!s?.hasSession && !s?.sessionId) return msg('reasonNoSession');
    if (s?.readOnly) return msg('reasonReadonly');
    if (s?.running) return msg('reasonRunning');
    return '';
  }
  function copySnapshot(value) {
    try {
      return value == null ? null : JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
  function restoreFocus() {
    const back = opener;
    opener = null;
    if (!back || back.isConnected === false || typeof back.focus !== 'function') return;
    try {
      if (target && targetKey(state()) !== target.key) return;
    } catch {
      return;
    }
    try {
      back.focus({ preventScroll: true });
    } catch {}
  }
  function render() {
    if (!dialog || closed) return;
    const s = state();
    summary = getContextSummary(target?.snapshot);
    bodyNode.replaceChildren();
    if (!summary.known) {
      const p = el(d, 'p', 'context-details-unknown', msg('unknownDetail'));
      p.setAttribute('role', 'status');
      bodyNode.append(p);
    } else {
      const badge = el(d, 'p', 'context-details-badge', summary.live ? msg('live') : msg('lastRequest'));
      badge.setAttribute('role', 'status');
      bodyNode.append(badge);
      const list = el(d, 'dl', 'context-details-stats');
      const row = (term, value) => {
        const div = el(d, 'div');
        div.append(el(d, 'dt', '', term), el(d, 'dd', '', value));
        list.append(div);
      };
      row(msg('used'), `${fmt(summary.tokens)} / ${fmt(summary.contextWindow)} (${summary.percent} %)`);
      if (summary.approx) bodyNode.append(el(d, 'p', 'context-details-note', msg('estimateNote')));
      const track = el(d, 'div', 'quota-bar');
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(summary.percent));
      const fill = el(d, 'div', 'quota-bar-fill');
      fill.style.width = `${summary.percent}%`;
      track.append(fill);
      bodyNode.append(list, track);
      const cacheTitle = el(d, 'h3', 'context-details-sub', `${msg('cacheTitle')}`);
      bodyNode.append(cacheTitle);
      if (!summary.cache) {
        const p = el(d, 'p', 'context-details-note', msg('cacheUnknown'));
        bodyNode.append(p);
      } else {
        const clist = el(d, 'dl', 'context-details-stats');
        const c = summary.cache;
        const cell = (v) => (v === null ? msg('unknown') : fmt(v));
        if (c.hitPercent !== null) {
          const div = el(d, 'div');
          div.append(el(d, 'dt', '', msg('cacheHitRate')), el(d, 'dd', '', `${c.hitPercent} %`));
          clist.append(div);
        }
        const crow = (term, v) => {
          const div = el(d, 'div');
          div.append(el(d, 'dt', '', term), el(d, 'dd', '', cell(v)));
          clist.append(div);
        };
        crow(msg('cacheInput'), c.input);
        crow(msg('cacheRead'), c.read);
        crow(msg('cacheWrite'), c.write);
        crow(msg('cacheOutput'), c.output);
        bodyNode.append(clist);
      }
    }
    bodyNode.append(el(d, 'p', 'context-details-note', msg('replaceNote')));
    bodyNode.append(el(d, 'p', 'context-details-note', msg('costNote')));
    try {
      dialog.setAttribute('aria-label', msg('title'));
    } catch {}
    try {
      if (titleNode) titleNode.textContent = msg('title');
    } catch {}
    try {
      if (closeBtn) closeBtn.setAttribute('aria-label', msg('close'));
    } catch {}
    const reason = disabledReason(s);
    const canCompact = summary.known && !reason;
    confirmBtn.disabled = !canCompact;
    confirmBtn.textContent = msg('confirm');
    reasonNode.textContent = canCompact ? '' : reason;
    reasonNode.hidden = canCompact;
    cancelBtn.textContent = msg('cancel');
    if (errorNode) {
      errorNode.textContent = confirmError || '';
      errorNode.hidden = !confirmError;
    }
  }
  function ensure() {
    if (dialog) return dialog;
    dialog = el(d, 'dialog', 'modal context-details-dialog');
    try {
      dialog.setAttribute('aria-label', msg('title'));
    } catch {}
    const head = el(d, 'div', 'modal-heading');
    titleNode = el(d, 'h2', '', msg('title'));
    closeBtn = el(d, 'button', 'icon-button', '\u00d7');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', msg('close'));
    closeBtn.onclick = () => api.close();
    head.append(titleNode, closeBtn);
    bodyNode = el(d, 'div', 'context-details-body');
    reasonNode = el(d, 'p', 'context-details-reason');
    reasonNode.setAttribute('role', 'status');
    errorNode = el(d, 'p', 'context-details-error');
    errorNode.setAttribute('role', 'alert');
    errorNode.hidden = true;
    const actions = el(d, 'div', 'modal-actions');
    cancelBtn = el(d, 'button', 'secondary-button');
    cancelBtn.type = 'button';
    cancelBtn.onclick = () => api.close();
    confirmBtn = el(d, 'button', 'primary-button');
    confirmBtn.type = 'button';
    // confirm() never rejects (failures report inside the dialog), so this
    // fire-and-forget click cannot produce an unhandled rejection/pageerror.
    confirmBtn.onclick = () => {
      void api.confirm();
    };
    actions.append(cancelBtn, confirmBtn);
    dialog.append(head, bodyNode, reasonNode, errorNode, actions);
    dialog.addEventListener('close', () => {
      pending = false;
      confirmError = '';
      restoreFocus();
    });
    try {
      unsubscribe = onLanguageChange(() => {
        if (dialog?.open && !closed) render();
      });
    } catch {
      unsubscribe = null;
    }
    return dialog;
  }
  const api = {
    dialog: null,
    open(openerElement) {
      const root = ensure();
      if (!root.isConnected) {
        try {
          (d.body || d.documentElement).append(root);
        } catch {}
      }
      // Capture OWNER target now; later focus moves never rebind it.
      opener = openerElement || null;
      const s = state();
      const snap = copySnapshot(snapshotOf());
      target = { sessionId: s?.sessionId || null, cwd: s?.cwd || null, key: targetKey(s), snapshot: snap };
      pending = false;
      confirmError = '';
      render();
      try {
        if (!root.open) root.showModal();
      } catch {
        try {
          root.open = true;
        } catch {}
      }
      // Focus the safe option: opening with Space moves focus here while the
      // key is still down, and a keyup on the confirm button must never
      // compact by accident. Keyboard users Tab once to confirm.
      try {
        cancelBtn?.focus({ preventScroll: true });
      } catch {}
      return target;
    },
    update() {
      if (dialog?.open && !closed) render();
    },
    close() {
      try {
        if (dialog?.open) dialog.close();
        else dialog.open = false;
      } catch {}
      pending = false;
      restoreFocus();
    },
    async confirm() {
      if (pending || !dialog?.open) return false;
      const s = state();
      const reason = disabledReason(s);
      render();
      if (reason || !summary.known) return false;
      pending = true;
      confirmError = '';
      render();
      let result;
      try {
        result = await compact({
          sessionId: target.sessionId,
          cwd: target.cwd,
          key: target.key,
          snapshot: target.snapshot,
          summary,
        });
      } catch (error) {
        // Report inside the dialog and keep it open for retry; root toasts
        // through its own pipeline. Never rejects: no pageerror from clicks.
        pending = false;
        try {
          confirmError = translateKnown(error?.message) || String(error?.message ?? error);
        } catch {
          try {
            confirmError = String(error?.message ?? error);
          } catch {
            confirmError = 'Error';
          }
        }
        render();
        return false;
      }
      pending = false;
      if (result === false) {
        // Root declined (it reports the cause itself): stay open, no success.
        confirmError = '';
        render();
        return false;
      }
      confirmError = '';
      api.close();
      return true;
    },
    getLastSummary() {
      return summary;
    },
    getTarget() {
      return target ? { ...target } : null;
    },
    get dialogNode() {
      return dialog;
    },
    destroy() {
      closed = true;
      try {
        unsubscribe?.();
      } catch {}
      try {
        dialog?.remove();
      } catch {}
      dialog = null;
    },
  };
  Object.defineProperty(api, 'dialog', { get: () => ensure() });
  return api;
}
