// Internal Back/Forward between conversation/project selections.
// Content-free bounded metadata only (ids + scroll, never draft text).
// Browser history uses meaningful pushState/replaceState + popstate; no dummy traps.

export const NAV_HISTORY_LIMIT = 50;
const NAV_FLAG = '__primeNav';

export function entryKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.kind === 'session' && entry.sessionId) return `s:${entry.sessionId}`;
  if (entry.kind === 'run' && entry.runId) return `r:${entry.runId}`;
  if (entry.kind === 'project') return `p:${String(entry.projectCwd || '').toLowerCase()}`;
  if (entry.kind === 'new') return `n:${entry.nonce || entry.viewId || 'new'}`;
  return `${entry.kind || '?'}:${entry.sessionId || entry.runId || entry.projectCwd || entry.viewId || ''}`;
}

export function sameEntry(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  return entryKey(a) === entryKey(b);
}

function cloneEntry(entry) {
  if (!entry) return null;
  return {
    kind: entry.kind || 'new',
    sessionId: entry.sessionId || null,
    runId: entry.runId || null,
    projectCwd: entry.projectCwd || null,
    viewId: entry.viewId || null,
    nonce: entry.nonce || null,
    scrollTop: Math.max(0, Number(entry.scrollTop) || 0),
    follow: entry.follow !== false,
    navId: entry.navId || null,
  };
}

let navSeq = 0;
const freshNavId = () =>
  `nav${Date.now().toString(36)}${(navSeq += 1).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

export function createNavigationHistory(opts = {}) {
  const max = Math.max(2, Math.min(100, Number(opts.max) || NAV_HISTORY_LIMIT));
  let entries = [];
  let index = -1;
  let seq = 0;
  let browserWired = false;
  const listeners = new Set();

  const getHist = () => {
    try {
      if (typeof history === 'undefined') return null;
      return history;
    } catch {
      return null;
    }
  };
  const getLoc = () => {
    try {
      if (typeof location === 'undefined') return null;
      return location;
    } catch {
      return null;
    }
  };

  function notify() {
    const snap = snapshot();
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch {}
    }
  }

  function snapshot() {
    return {
      entries: entries.map(cloneEntry),
      index,
      canBack: index > 0,
      canForward: index >= 0 && index < entries.length - 1,
      seq,
      current: cloneEntry(entries[index] || null),
    };
  }

  function stateFor(entry) {
    return {
      [NAV_FLAG]: true,
      navId: entry.navId,
      key: entryKey(entry),
      kind: entry.kind,
      sessionId: entry.sessionId || null,
      runId: entry.runId || null,
      projectCwd: entry.projectCwd || null,
      viewId: entry.viewId || null,
      nonce: entry.nonce || null,
      scrollTop: Math.max(0, Number(entry.scrollTop) || 0),
      follow: entry.follow !== false,
    };
  }

  function tryReplace(entry) {
    const h = getHist();
    if (!h || typeof h.replaceState !== 'function') return;
    try {
      const url = getLoc()?.href || undefined;
      h.replaceState(stateFor(entry), '', url);
      browserWired = true;
    } catch {}
  }

  function tryPush(entry) {
    const h = getHist();
    if (!h || typeof h.pushState !== 'function') return false;
    try {
      const url = getLoc()?.href || undefined;
      h.pushState(stateFor(entry), '', url);
      browserWired = true;
      return true;
    } catch {
      return false;
    }
  }

  function replaceInitial(entry) {
    const clean = cloneEntry(entry);
    if (!clean) return null;
    clean.navId ||= freshNavId();
    entries = [clean];
    index = 0;
    tryReplace(clean);
    notify();
    return cloneEntry(clean);
  }

  function currentScrollPatch(patch) {
    if (index < 0 || !entries[index]) return;
    if (!patch || typeof patch !== 'object') return;
    if (Number.isFinite(Number(patch.scrollTop)))
      entries[index].scrollTop = Math.max(0, Number(patch.scrollTop));
    if (typeof patch.follow === 'boolean') entries[index].follow = patch.follow;
  }

  // Push ONLY for meaningful USER selections. Duplicates add nothing.
  // Clears forward. Every distinct push invalidates pending history restores
  // via seq, so a slow history load can never overwrite a newer USER choice.
  // Returns { pushed:boolean, entry }.
  function push(entry) {
    const clean = cloneEntry(entry);
    if (!clean) return { pushed: false, entry: null };
    clean.navId ||= freshNavId();
    if (index >= 0 && sameEntry(entries[index], clean)) {
      // Same target: keep single entry, refresh ids for reopen fidelity.
      entries[index] = {
        ...entries[index],
        viewId: clean.viewId || entries[index].viewId,
        nonce: clean.nonce || entries[index].nonce,
      };
      tryReplace(entries[index]);
      notify();
      return { pushed: false, entry: cloneEntry(entries[index]) };
    }
    // New navigation truncates forward (browser pushState does the same).
    if (index < entries.length - 1) entries = entries.slice(0, index + 1);
    entries.push(clean);
    index = entries.length - 1;
    while (entries.length > max) {
      entries.shift();
      index -= 1;
    }
    seq += 1;
    tryPush(clean);
    notify();
    return { pushed: true, entry: cloneEntry(clean) };
  }

  function peekBack() {
    return index > 0 ? cloneEntry(entries[index - 1]) : null;
  }
  function peekForward() {
    return index >= 0 && index < entries.length - 1 ? cloneEntry(entries[index + 1]) : null;
  }

  // Move pointer WITHOUT pushing. Caller performs the async navigate, then
  // confirms with afterNavigate(ok). On refusal/missing the caller decides
  // fallback; pointer stays on target so toolbar stays consistent.
  function beginBack() {
    if (index <= 0) return null;
    seq += 1;
    index -= 1;
    notify();
    return { entry: cloneEntry(entries[index]), seq };
  }
  function beginForward() {
    if (index < 0 || index >= entries.length - 1) return null;
    seq += 1;
    index += 1;
    notify();
    return { entry: cloneEntry(entries[index]), seq };
  }
  function isCurrent(s) {
    return s === seq;
  }

  // popstate: meaningful Studio states navigate internally; outside roots
  // (null / non-flag) are left to the browser (real back, never trapped).
  // Unknown Studio states (e.g., after reload with in-memory lost) rebuild a
  // bounded entry from the content-free state descriptor, so the toolbar
  // position and the UI never silently disagree.
  function handlePopState(event) {
    const st = event?.state;
    if (!st || st[NAV_FLAG] !== true) return { handled: false, reason: 'outside' };
    const navId = st.navId;
    const at = entries.findIndex((e) => e.navId === navId);
    if (at < 0) {
      if (!st.kind) return { handled: false, reason: 'unknown' };
      const rebuilt = cloneEntry({
        kind: st.kind,
        sessionId: st.sessionId || null,
        runId: st.runId || null,
        projectCwd: st.projectCwd || null,
        viewId: st.viewId || null,
        nonce: st.nonce || null,
        scrollTop: st.scrollTop || 0,
        follow: st.follow !== false,
        navId: st.navId || freshNavId(),
      });
      if (index < entries.length - 1) entries = entries.slice(0, index + 1);
      entries.push(rebuilt);
      index = entries.length - 1;
      while (entries.length > max) {
        entries.shift();
        index -= 1;
      }
      seq += 1;
      notify();
      return { handled: true, reason: 'reload', entry: cloneEntry(rebuilt), seq };
    }
    if (at === index) return { handled: true, reason: 'same', entry: cloneEntry(entries[at]), seq };
    const from = index;
    seq += 1;
    index = at;
    notify();
    return { handled: true, reason: at < from ? 'back' : 'forward', entry: cloneEntry(entries[at]), seq };
  }

  // Immediate user-intent invalidation BEFORE any await: a new explicit
  // user selection must stale any pending history restore at entry, not only
  // after its own load/push completes.
  function resolveDraft({ nonce, runId, sessionId }) {
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!(
        (nonce && entry.kind === 'new' && entry.nonce === nonce) ||
        (runId && entry.kind === 'run' && entry.runId === runId)
      ))
        continue;
      entries[i] = {
        ...entry,
        kind: sessionId ? 'session' : 'run',
        sessionId: sessionId || null,
        runId: runId || entry.runId || null,
      };
    }
    notify();
  }

  function invalidate() {
    seq += 1;
    notify();
    return seq;
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    replaceInitial,
    push,
    peekBack,
    peekForward,
    beginBack,
    beginForward,
    currentScrollPatch,
    resolveDraft,
    invalidate,
    handlePopState,
    onChange,
    snapshot,
    canBack: () => index > 0,
    canForward: () => index >= 0 && index < entries.length - 1,
    isCurrent,
    get seq() {
      return seq;
    },
    get browserWired() {
      return browserWired;
    },
  };
}
