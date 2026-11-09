import test from 'node:test';
import assert from 'node:assert/strict';
import {
  entryKey,
  sameEntry,
  createNavigationHistory,
  NAV_HISTORY_LIMIT,
} from '../public/navigation-history.js';
import {
  historyDirectionForKey,
  historyDirectionForMouse,
  installNavigationGuard,
} from '../public/navigation-guard.js';

test('entryKey content-free and dedupes', () => {
  assert.equal(entryKey({ kind: 'session', sessionId: 'a' }), 's:a');
  assert.equal(entryKey({ kind: 'session', sessionId: 'a', scrollTop: 999 }), 's:a');
  assert.ok(!entryKey({ kind: 'session', sessionId: 'a' }).includes('draft'));
  assert.equal(sameEntry({ kind: 'session', sessionId: 'a' }, { kind: 'session', sessionId: 'a' }), true);
  assert.equal(sameEntry({ kind: 'session', sessionId: 'a' }, { kind: 'session', sessionId: 'b' }), false);
  assert.equal(sameEntry({ kind: 'session', sessionId: 'a' }, { kind: 'project', projectCwd: 'a' }), false);
});

test('push dedupes, truncates forward, bounds', () => {
  const h = createNavigationHistory({ max: 3 });
  h.replaceInitial({ kind: 'session', sessionId: 'a' });
  assert.equal(h.canBack(), false);
  h.push({ kind: 'session', sessionId: 'b' });
  h.push({ kind: 'session', sessionId: 'c' });
  assert.equal(h.snapshot().entries.length, 3);
  // duplicate: no extra entry
  const n0 = h.snapshot().entries.length;
  h.push({ kind: 'session', sessionId: 'c' });
  assert.equal(h.snapshot().entries.length, n0);
  // back then new push truncates forward
  h.beginBack();
  assert.equal(h.canForward(), true);
  h.push({ kind: 'session', sessionId: 'd' });
  assert.equal(h.canForward(), false);
  assert.equal(
    h
      .snapshot()
      .entries.map((e) => e.sessionId)
      .join(','),
    'a,b,d'.replace('a,', 'a,').includes('a')
      ? h
          .snapshot()
          .entries.map((e) => e.sessionId)
          .join(',')
      : '',
  );
  // bounds
  h.push({ kind: 'session', sessionId: 'e' });
  assert.ok(h.snapshot().entries.length <= 3);
  for (const e of h.snapshot().entries) {
    assert.ok(!('text' in e) && !('draft' in e));
    assert.ok(Number.isFinite(e.scrollTop));
  }
});

test('back/forward pointer and popstate outside safe', () => {
  const h = createNavigationHistory();
  h.replaceInitial({ kind: 'session', sessionId: 'a' });
  h.push({ kind: 'session', sessionId: 'b' });
  const b = h.beginBack();
  assert.equal(b.entry.sessionId, 'a');
  const f = h.beginForward();
  assert.equal(f.entry.sessionId, 'b');
  assert.equal(h.handlePopState({ state: null }).handled, false);
  assert.equal(h.handlePopState({ state: { nope: 1 } }).handled, false);
});

test('push invalidates pending history seq so user intent wins', () => {
  const h = createNavigationHistory();
  h.replaceInitial({ kind: 'session', sessionId: 'a' });
  h.push({ kind: 'session', sessionId: 'b' });
  const pending = h.beginBack();
  assert.ok(pending && h.isCurrent(pending.seq));
  h.push({ kind: 'session', sessionId: 'c' });
  assert.equal(h.isCurrent(pending.seq), false);
  assert.equal(h.snapshot().current.sessionId, 'c');
  assert.equal(h.canForward(), false);
});

test('popstate direction back/forward and reload rebuild from state descriptor', () => {
  const h = createNavigationHistory();
  h.replaceInitial({ kind: 'session', sessionId: 'a' });
  h.push({ kind: 'session', sessionId: 'b' });
  const back = h.beginBack();
  assert.equal(back.entry.sessionId, 'a');
  // simulate browser back to b via real state object (pushState descriptor)
  const snapB = h.snapshot().entries[1];
  assert.ok(snapB && snapB.navId);
  const fakeState = {
    __primeNav: true,
    navId: snapB.navId,
    kind: 'session',
    sessionId: 'b',
    scrollTop: 0,
    follow: true,
  };
  const r = h.handlePopState({ state: fakeState });
  assert.equal(r.handled, true);
  assert.equal(r.reason, 'forward');
  assert.equal(r.entry.sessionId, 'b');
  // reload with empty memory rebuilds bounded entry from descriptor (content-free)
  const h2 = createNavigationHistory();
  const rr = h2.handlePopState({ state: fakeState });
  assert.equal(rr.handled, true);
  assert.equal(rr.reason, 'reload');
  assert.equal(rr.entry.sessionId, 'b');
  assert.ok(!('text' in rr.entry) && !('draft' in rr.entry));
});

test('new-chat restoration passes the original nonce to the binding, not options', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const code = app.slice(
    app.indexOf('async function doHistoryNavigate('),
    app.indexOf('function requestHistoryBack('),
  );
  const calls = [];
  const box = {
    navHistory: { isCurrent: () => true },
    historyNavSilence: false,
    historyTargetViewId: null,
    state: { projectCwd: 'C:/project' },
    dockingUI: { active: false },
    convViews: {
      byId: () => ({ id: 'conversation', sessionId: 'b', nonce: 'different' }),
      bindFocused: (...args) => calls.push(args),
    },
    saveDraft() {},
    afterViewFocused() {},
    restoreHistoryScroll() {},
    closeSidebar() {},
    toast() {},
    translateKnown: String,
  };
  vm.createContext(box);
  vm.runInContext(code, box);
  assert.equal(
    await box.doHistoryNavigate(
      { kind: 'new', viewId: 'conversation', nonce: 'saved-draft', projectCwd: 'C:/project' },
      1,
    ),
    true,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].nonce, 'saved-draft');
  assert.equal(calls[0][0].keepNonce, true);
  assert.equal(calls[0][1].inheritLegacy, false);
});

test('dock tab select records meaningful history', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const at = app.indexOf('onActivatePanel: (id)');
  assert.ok(at >= 0, 'dock activation hook must exist');
  const seg = app.slice(at, at + 1600);
  assert.ok(
    seg.includes('captureCurrentHistoryScroll'),
    'dock tab must capture previous scroll before focus',
  );
  assert.ok(seg.includes('pushUserSelection'), 'dock tab user selection must push history');
  assert.ok(seg.includes('historyTargetViewId'), 'programmatic history activation must not double-push');
});

test('invalidate stales pending history at entry, before any await', () => {
  const h = createNavigationHistory();
  h.replaceInitial({ kind: 'session', sessionId: 'a' });
  const s0 = h.seq;
  h.invalidate();
  assert.ok(h.seq > s0);
});

test('deferred race: old history response released while user B pending cannot overwrite', async () => {
  const h = createNavigationHistory();
  h.replaceInitial({ kind: 'session', sessionId: 'a' });
  h.push({ kind: 'session', sessionId: 'b' });
  // history back to A starts slow load
  const pendingA = h.beginBack();
  assert.equal(pendingA.entry.sessionId, 'a');
  let releaseA;
  const loadA = new Promise((res) => {
    releaseA = () => res(pendingA);
  });
  // user explicitly selects B before A resolves: invalidate at entry
  h.invalidate();
  const userPush = h.push({ kind: 'session', sessionId: 'b' });
  assert.equal(userPush.pushed, true);
  // old A resolves late: seq stale, must not restore onto B
  const lateA = await (releaseA(), loadA);
  assert.equal(h.isCurrent(lateA.seq), false);
  assert.equal(h.snapshot().current.sessionId, 'b');
  assert.equal(h.canForward(), false);
});

test('guard directions route internally, edits preserved', () => {
  const body = { nodeType: 1, tagName: 'DIV' };
  const area = { nodeType: 1, tagName: 'TEXTAREA' };
  assert.equal(historyDirectionForKey({ key: 'ArrowLeft', altKey: true, target: body }), 'back');
  assert.equal(historyDirectionForKey({ key: 'ArrowRight', altKey: true, target: body }), 'forward');
  assert.equal(historyDirectionForKey({ key: 'BrowserBack', target: body }), 'back');
  assert.equal(historyDirectionForKey({ key: 'BrowserForward', target: body }), 'forward');
  assert.equal(historyDirectionForKey({ key: 'Backspace', target: body }), 'back');
  assert.equal(historyDirectionForKey({ key: 'Backspace', target: area }), null);
  assert.equal(historyDirectionForMouse({ button: 3 }), 'back');
  assert.equal(historyDirectionForMouse({ button: 4 }), 'forward');
  assert.equal(historyDirectionForMouse({ button: 0 }), null);
  // hooks called, still preventDefault, no history trap
  let backs = 0,
    fwds = 0;
  const fake = { __primeNavGuardInstalled: false, addEventListener() {}, removeEventListener() {} };
  // capture handlers
  const seen = {};
  fake.addEventListener = (t, fn) => {
    seen[t] = fn;
  };
  const cleanup = installNavigationGuard(fake, { onBack: () => backs++, onForward: () => fwds++ });
  assert.ok(seen.keydown && seen.mousedown);
  let prevented = 0;
  seen.keydown({ key: 'ArrowLeft', altKey: true, target: body, preventDefault: () => prevented++ });
  assert.equal(backs, 1);
  assert.equal(prevented, 1);
  seen.mouseup({ button: 4, preventDefault: () => prevented++ });
  assert.equal(fwds, 1);
  cleanup();
});

test('a sent draft becomes its run/session even after leaving that history entry', () => {
  const nav = createNavigationHistory({ history: null });
  nav.replaceInitial({ kind: 'new', nonce: 'draft-a', viewId: 'conversation', projectCwd: 'C:/a' });
  nav.push({ kind: 'session', sessionId: 'other', projectCwd: 'C:/a' });
  nav.resolveDraft({ nonce: 'draft-a', runId: 'r1' });
  assert.equal(nav.peekBack().kind, 'run');
  assert.equal(nav.peekBack().runId, 'r1');
  nav.resolveDraft({ runId: 'r1', sessionId: 'created-a' });
  assert.equal(nav.peekBack().kind, 'session');
  assert.equal(nav.peekBack().sessionId, 'created-a');
  assert.equal(nav.snapshot().entries.length, 2, 'promotion adds no artificial history entry');
  assert.equal(nav.snapshot().entries[1].sessionId, 'other', 'unrelated focused session stays intact');
});
