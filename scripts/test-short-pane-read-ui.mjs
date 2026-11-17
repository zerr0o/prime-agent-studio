// Lean focused regression: short secondary pane read.
// Covers: short 4-msg secondary zero-overflow open clears unread (POST correct
// answer); hidden secondary NOT read on periodic refresh; long secondary above
// bottom stays unread until bottom; manual markUnread persists until actual
// reopen (especially with
// another pane visible); primary/classic preserved. Also: requests coalesced +
// read id/answer correct (no other unseen view acked); distinct answers so a
// same-id/source-only check cannot give false confidence.
// Isolated fixture only: temp dirs + loopback + inert runtime (start throws).
// Never reads user sessions, never starts agents, never edits product sources.
// Logs: .local/study/unread-fix/proof-short-pane-*.json (git-ignored .local).
// Usage: node scripts/test-short-pane-read-ui.mjs [proofOut.json]
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createApp } from '../server.mjs';
import { createDefaultLayout } from '../public/docking-layout.js';

const proofOut =
  process.argv[2] ||
  join('.local', 'study', 'unread-fix', `proof-short-pane-${Date.now()}.json`);
const proof = { meta: {}, answersDistinct: null, phases: {}, errors: [] };
const errors = [];
const failures = [];
function fail(name, detail) {
  failures.push(name);
  proof.phases[name] = { ...(proof.phases[name] || {}), passed: false, detail };
}

const temp = await mkdtemp(join(tmpdir(), 'prime-short-pane-read-'));
const cwd = join(temp, 'Atelier');
const sessionDir = join(temp, 'sessions');
const agentHome = join(temp, 'agent');
const dataDir = join(temp, 'data');
for (const dir of [cwd, sessionDir, agentHome, dataDir]) await mkdir(dir, { recursive: true });

async function seedShort(id, title) {
  const at = Date.UTC(2026, 10, 12, 9, 0, 0);
  const records = [{ type: 'session', id, cwd, version: 3, timestamp: new Date(at).toISOString() }];
  const texts = [
    ['user', `${title} — question 1`],
    ['assistant', `${title} — reponse une courte.`],
    ['user', `${title} — question 2`],
    ['assistant', `${title} — reponse deux courte.`],
  ];
  let parent = null;
  texts.forEach(([role, text], i) => {
    const entry = {
      type: 'message', id: `${id}-m${i}`, parentId: parent,
      message: { role, content: text, timestamp: at + i * 1000, stopReason: role === 'assistant' ? 'stop' : undefined },
    };
    records.push(entry);
    parent = entry.id;
  });
  await writeFile(join(sessionDir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
async function seedLong(id, title, minute) {
  const at = Date.UTC(2026, 10, 12, 10, minute, 0);
  const records = [{ type: 'session', id, cwd, version: 3, timestamp: new Date(at).toISOString() }];
  let parent = null;
  for (let i = 0; i < 30; i += 1) {
    const user = {
      type: 'message', id: `${id}-u${i}`, parentId: parent,
      message: { role: 'user', content: i ? `${title} — suite ${i}` : `${title} — debut`, timestamp: at + i * 2000 },
    };
    const reply = {
      type: 'message', id: `${id}-a${i}`, parentId: user.id,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `${title} — reponse ${i + 1}. ` + 'Paragraphe de remplissage pour faire defiler. '.repeat(8) }],
        timestamp: at + i * 2000 + 1000,
      },
    };
    records.push(user, reply);
    parent = reply.id;
  }
  await writeFile(join(sessionDir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
await seedLong('boot-long', 'Boot longue', 0);
await seedShort('short-a', 'Courte A');
await seedLong('long-b', 'Longue B', 5);
await seedShort('classic-c', 'Classique C');
await seedShort('short-v', 'Visible courte');
await seedLong('long-f', 'Focus longue', 8);

const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/m', name: 'Fixture', provider: 'fixture' }],
    default: { model: 'fixture/m' },
  }),
  async start() { throw new Error('no runs in short-pane-read fixture'); },
  async close() {},
};
const app = createApp({ runtime, agentHome, sessionDir, dataDir, initialCwd: cwd });
await app.store.project({ cwd });
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
proof.meta = { url: 'loopback-only', viewport: { width: 1440, height: 900 }, isolatedFixture: true };
proof.meta.sourceFocusedPaintAck = await readFile(resolve('public/conversation-views.js'), 'utf-8')
  .then((s) => s.includes('Acknowledge the focused'))
  .catch(() => null);

const browser = await launchStudioBrowser({ channel: 'chrome' });
const posts = [];
let page;
const dotOf = (id) => page.locator(`.session-row[data-session-id="${id}"]`).getAttribute('data-activity');
const readStateOf = (id) =>
  page.evaluate(async (sid) => {
    const res = await fetch(`/api/history?id=${encodeURIComponent(sid)}`);
    const json = await res.json().catch(() => ({}));
    return { answer: json?.readState?.answer || '', read: json?.readState?.read || '', revision: json?.readState?.revision ?? null };
  }, id);
const readPostsFor = (id) => posts.filter((p) => p.op === 'read' && p.id === id);
const unreadPostsFor = (id) => posts.filter((p) => p.op === 'unread' && p.id === id);
const clearPosts = () => { posts.length = 0; };
function recordPosts(pg) {
  pg.on('request', (req) => {
    try {
      if (!req.url().includes('/api/sessions/')) return;
      if (req.method() !== 'POST') return;
      let body = null;
      try { body = req.postDataJSON(); } catch { body = null; }
      const op = req.url().includes('/sessions/read') ? 'read' : req.url().includes('/sessions/unread') ? 'unread' : null;
      if (!op) return;
      posts.push({ op, id: body?.id || null, answer: body?.answer || null });
    } catch {}
  });
}
const markUnreadViaMenu = async (id) => {
  await page.locator(`.session-row[data-session-id="${id}"]`).hover();
  await page.locator(`.session-row[data-session-id="${id}"] .session-more`).click();
  await expect(page.locator('#session-menu')).toBeVisible({ timeout: 10000 });
  await page.locator('#session-menu button[data-action="unread"]').click();
};
const refreshOnline = () => page.evaluate(() => window.dispatchEvent(new Event('online')));
async function focusedSecondaryId() {
  return page.evaluate(() => document.querySelector('.dock-tab.is-conversation.is-focused')?.dataset.dockTab);
}
async function scrollerMetrics(viewId) {
  return page.locator(`.cvw-shell[data-view="${viewId}"] .cvw-scroller`).evaluate((n) => ({
    scrollHeight: n.scrollHeight, clientHeight: n.clientHeight,
    scrollTop: n.scrollTop, overflow: n.scrollHeight - n.clientHeight,
  }));
}
async function manualDrag(from, to) {
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  let previewSeen = false;
  for (let i = 1; i <= 10; i += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / 10,
      from.y + ((to.y - from.y) * i) / 10,
      { steps: 2 },
    );
    if (i === 5) {
      previewSeen = await page.locator('.dock-drop-preview').isVisible().catch(() => false);
    }
  }
  await page.mouse.move(to.x, to.y);
  await page.mouse.move(to.x, to.y);
  previewSeen = previewSeen || (await page.locator('.dock-drop-preview').isVisible().catch(() => false));
  await page.mouse.up();
  return previewSeen;
}
async function dockSignature() {
  return page.evaluate(() => ({
    groups: [...document.querySelectorAll('.dock-group[data-dock-group]')].map((group) => ({
      id: group.dataset.dockGroup,
      tabs: [...group.querySelectorAll('button[data-dock-tab]')].map((tab) => tab.dataset.dockTab),
      active: group.querySelector('button[data-dock-tab][aria-selected="true"]')?.dataset.dockTab ?? null,
    })),
    splits: [...document.querySelectorAll('.dock-splitter[data-dock-split]')].map((s) => s.dataset.dockSplit),
    focused: document.querySelector('.dock-tab.is-conversation.is-focused')?.dataset.dockTab ?? null,
  }));
}
async function shellVisible(viewId) {
  return page.locator(`.cvw-shell[data-view="${viewId}"] .cvw-bg`).evaluate((n) => !n.hidden).catch(() => false);
}

try {
  // ---------- Context A: docked ----------
  const ctxA = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
  await ctxA.addInitScript(
    ({ cwd, layout }) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId: 'boot-long', projectOverview: false }));
      localStorage.setItem('prime-studio.docking.layout', JSON.stringify({ ...layout, enabled: true }));
    },
    { cwd, layout: createDefaultLayout() },
  );
  page = await ctxA.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(String(e?.message || e)));
  recordPosts(page);
  await page.goto(url);
  await expect(page.locator('#dock-workspace')).toBeVisible({ timeout: 25000 });
  await expect(page.locator('#session-list')).toBeVisible();
  await expect(page.locator('#messages')).toContainText('Boot longue', { timeout: 25000 });
  await page.waitForTimeout(1200);

  // Distinct-answer guard: no false confidence from same ids/source only.
  const stBoot = await readStateOf('boot-long');
  const stShort = await readStateOf('short-a');
  const stLong = await readStateOf('long-b');
  const stClassic = await readStateOf('classic-c');
  const stVisible = await readStateOf('short-v');
  const stFocus = await readStateOf('long-f');
  const answers = [stBoot.answer, stShort.answer, stLong.answer, stClassic.answer, stVisible.answer, stFocus.answer];
  proof.answersDistinct = {
    answers: { 'boot-long': stBoot.answer, 'short-a': stShort.answer, 'long-b': stLong.answer, 'classic-c': stClassic.answer, 'short-v': stVisible.answer, 'long-f': stFocus.answer },
    allNonEmpty: answers.every(Boolean),
    pairwiseDistinct: new Set(answers).size === answers.length,
  };
  if (!proof.answersDistinct.allNonEmpty || !proof.answersDistinct.pairwiseDistinct) {
    fail('answersDistinct', `answers must be non-empty and distinct, got ${JSON.stringify(proof.answersDistinct)}`);
  }

  // ---- Phase 1: short secondary zero-overflow open clears unread ----
  try {
    await markUnreadViaMenu('short-a');
    await expect.poll(() => dotOf('short-a'), { timeout: 20000 }).toBe('unread');
    const historyBefore = await readStateOf('short-a');
    clearPosts();
    await page.locator('.session-row[data-session-id="short-a"] .session-select').click();
    const prevFocused = await focusedSecondaryId().catch(() => null);
    const viewId = await expect
      .poll(() => focusedSecondaryId(), { timeout: 20000 })
      .not.toBe('conversation')
      .then(() => focusedSecondaryId());
    void prevFocused;
    const shell = page.locator(`.cvw-shell[data-view="${viewId}"]`);
    const scroller = shell.locator('.cvw-scroller');
    await expect(shell.locator('.cvw-messages')).toContainText('reponse deux courte.', { timeout: 20000 });
    await page.waitForTimeout(1500);
    const metrics = await scrollerMetrics(viewId);
    const dotAfter = await dotOf('short-a');
    const readAfter = await readStateOf('short-a');
    const mine = readPostsFor('short-a');
    const others = posts.filter((p) => p.op === 'read' && p.id !== 'short-a');
    const zeroOverflow = (metrics.overflow ?? 999) <= 50;
    const ok = zeroOverflow && mine.length === 1 && mine[0]?.answer === historyBefore.answer
      && dotAfter === 'idle' && readAfter.read === historyBefore.answer && others.length === 0;
    proof.phases.shortOpen = {
      passed: ok, viewId, metrics, zeroOverflow,
      historyBefore, dotAfter, readAfter,
      readPosts: mine, otherReadPosts: others,
      expect: 'zero-overflow open => exactly 1 POST /sessions/read {id:short-a, answer} + dot idle, no other view acked',
    };
    if (!ok) failures.push('shortOpen');
  } catch (e) {
    fail('shortOpen', String(e?.message || e).slice(0, 1200));
  }

  // ---- Phase 2: hidden secondary NOT read on periodic refresh ----
  try {
    // long-b has never been opened as a secondary yet: mark unread while hidden.
    await markUnreadViaMenu('long-b');
    await expect.poll(() => dotOf('long-b'), { timeout: 20000 }).toBe('unread');
    clearPosts();
    await refreshOnline();
    await page.waitForTimeout(1500);
    const dotHidden = await dotOf('long-b');
    const mine = readPostsFor('long-b');
    const ok = dotHidden === 'unread' && mine.length === 0;
    proof.phases.hiddenRefresh = {
      passed: ok, dotHidden, readPostsForHidden: mine, allPosts: [...posts],
      expect: 'hidden unread secondary => 0 POST /sessions/read on periodic refresh + dot stays unread',
    };
    if (!ok) failures.push('hiddenRefresh');
  } catch (e) {
    fail('hiddenRefresh', String(e?.message || e).slice(0, 1200));
  }

  // ---- Phase 2b: VISIBLE unfocused secondary keeps manual unread across refresh ----
  // Design root: paint ACK is focused-only at end renderBg, so an explicit
  // markUnread on a visible-but-unfocused secondary must survive repaints and
  // periodic refresh (periodic sync retries the focused owner only). Scroll
  // ACK stays valid for any visible pane at bottom regardless of focus.
  try {
    await page.locator('.session-row[data-session-id="short-v"] .session-select').click();
    await expect.poll(() => focusedSecondaryId(), { timeout: 20000 }).not.toBe('conversation');
    const viewV = await focusedSecondaryId();
    await expect(page.locator(`.cvw-shell[data-view="${viewV}"] .cvw-messages`)).toContainText('Visible courte', { timeout: 20000 });
    await page.locator('.session-row[data-session-id="long-f"] .session-select').click();
    await expect.poll(() => focusedSecondaryId(), { timeout: 20000 }).not.toBe(viewV);
    const viewF = await focusedSecondaryId();
    await expect(page.locator(`.cvw-shell[data-view="${viewF}"] .cvw-messages`)).toContainText('Focus longue', { timeout: 20000 });
    // Side-by-side split: drag short-v tab to the right edge of its group (drag-only relocation).
    await page.locator(`button[data-dock-tab="${viewV}"]`).scrollIntoViewIfNeeded();
    const tabBox = await page.locator(`button[data-dock-tab="${viewV}"]`).boundingBox();
    const groupBox = await page.evaluate((vid) => {
      const tab = document.querySelector(`button[data-dock-tab="${vid}"]`);
      const group = tab?.closest('.dock-group');
      const box = group?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    }, viewV);
    let split = null;
    if (tabBox && groupBox) {
      await manualDrag(
        { x: tabBox.x, y: tabBox.y, width: tabBox.width, height: tabBox.height },
        { x: groupBox.x + groupBox.width - 8, y: groupBox.y + groupBox.height / 2, width: 4, height: 4 },
      );
      split = await dockSignature();
    }
    const sideBySide = !!split && split.groups.some((g) => g.tabs.includes(viewV)) &&
      split.groups.some((g) => g.tabs.includes(viewF)) &&
      !split.groups.some((g) => g.tabs.includes(viewV) && g.tabs.includes(viewF));
    // Focus the holder; the target stays VISIBLE but unfocused.
    await page.locator(`button[data-dock-tab="${viewF}"]`).click();
    await expect.poll(() => focusedSecondaryId(), { timeout: 20000 }).toBe(viewF);
    const targetVisible = await shellVisible(viewV);
    await markUnreadViaMenu('short-v');
    await expect.poll(() => dotOf('short-v'), { timeout: 20000 }).toBe('unread');
    const historyBefore = await readStateOf('short-v');
    clearPosts();
    await refreshOnline();
    await page.waitForTimeout(1500);
    const dotPersist = await dotOf('short-v');
    const postsPersist = readPostsFor('short-v');
    const persists = sideBySide && targetVisible && dotPersist === 'unread' && postsPersist.length === 0;
    // Actual focus => exactly one correct read, no other view acked.
    clearPosts();
    await page.locator('.session-row[data-session-id="short-v"] .session-select').click();
    await expect.poll(() => focusedSecondaryId(), { timeout: 20000 }).toBe(viewV);
    await page.waitForTimeout(1500);
    const dotReopen = await dotOf('short-v');
    const readAfter = await readStateOf('short-v');
    const mine = readPostsFor('short-v');
    const others = posts.filter((p) => p.op === 'read' && p.id !== 'short-v');
    const reopens = mine.length === 1 && mine[0]?.answer === historyBefore.answer
      && dotReopen === 'idle' && readAfter.read === historyBefore.answer && others.length === 0;
    const ok = persists && reopens;
    proof.phases.visibleUnfocused = {
      passed: ok, viewV, viewF, split, sideBySide, targetVisible,
      historyBefore, dotPersist, postsPersist,
      dotReopen, readAfter, readPosts: mine, otherReadPosts: others,
      expect: 'visible unfocused secondary: manual unread survives refresh (0 POST); focus => exactly 1 correct POST + idle',
    };
    if (!ok) failures.push('visibleUnfocused');
  } catch (e) {
    fail('visibleUnfocused', String(e?.message || e).slice(0, 1200));
  }

  // ---- Phase 3: long secondary above bottom stays unread until bottom ----
  try {
    const historyLong = await readStateOf('long-b');
    clearPosts();
    await page.locator('.session-row[data-session-id="long-b"] .session-select').click();
    const viewId = await expect
      .poll(() => focusedSecondaryId(), { timeout: 20000 })
      .not.toBe(await focusedSecondaryId().catch(() => null))
      .then(() => focusedSecondaryId())
      .catch(() => focusedSecondaryId());
    const shell = page.locator(`.cvw-shell[data-view="${viewId}"]`);
    const scroller = shell.locator('.cvw-scroller');
    await expect(shell.locator('.cvw-messages')).toContainText('Longue B', { timeout: 20000 });
    await page.waitForTimeout(600);
    // Move above bottom BEFORE forcing unread, so the unread state starts above bottom.
    await scroller.evaluate((n) => n.scrollTo({ top: 0 }));
    await scroller.hover().catch(() => {});
    await page.mouse.wheel(0, -400).catch(() => {});
    await page.waitForTimeout(400);
    // Force server unread while the pane stays open above bottom, then let the client learn it.
    await page.evaluate(async (sid) => {
      await fetch('/api/sessions/unread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid }) });
    }, 'long-b');
    await refreshOnline();
    await expect.poll(() => dotOf('long-b'), { timeout: 20000 }).toBe('unread');
    const above = await scrollerMetrics(viewId);
    clearPosts();
    await page.waitForTimeout(1500);
    const dotAbove = await dotOf('long-b');
    const postsAbove = readPostsFor('long-b');
    const staysUnread = dotAbove === 'unread' && postsAbove.length === 0 && (above.overflow ?? 0) > 100;
    // Now go to bottom => must read exactly once with the correct answer.
    await scroller.evaluate((n) => n.scrollTo({ top: n.scrollHeight }));
    await scroller.hover().catch(() => {});
    await page.mouse.wheel(0, 800).catch(() => {});
    await page.waitForTimeout(1500);
    const after = await scrollerMetrics(viewId);
    const dotBottom = await dotOf('long-b');
    const readAfter = await readStateOf('long-b');
    const mine = readPostsFor('long-b');
    const others = posts.filter((p) => p.op === 'read' && p.id !== 'long-b');
    const readsAtBottom = mine.length === 1 && mine[0]?.answer === historyLong.answer
      && dotBottom === 'idle' && readAfter.read === historyLong.answer && others.length === 0;
    const ok = staysUnread && readsAtBottom;
    proof.phases.longAboveBottom = {
      passed: ok, viewId, above, dotAbove, postsAbove,
      after, dotBottom, readAfter, readPosts: mine, otherReadPosts: others,
      expect: 'above bottom => 0 POST + unread; at bottom => exactly 1 POST {id:long-b, answer} + idle',
    };
    if (!ok) failures.push('longAboveBottom');
  } catch (e) {
    fail('longAboveBottom', String(e?.message || e).slice(0, 1200));
  }

  // ---- Phase 5: manual markUnread persists until actual reopen (other pane visible) ----
  try {
    // Focus long-b so short-a is a background tab, then mark short-a unread while hidden.
    await page.locator('.session-row[data-session-id="long-b"] .session-select').click().catch(() => {});
    await page.waitForTimeout(800);
    await markUnreadViaMenu('short-a');
    await expect.poll(() => dotOf('short-a'), { timeout: 20000 }).toBe('unread');
    const historyBefore = await readStateOf('short-a');
    clearPosts();
    await refreshOnline();
    await page.waitForTimeout(1500);
    const dotPersist = await dotOf('short-a');
    const postsPersist = readPostsFor('short-a');
    const persists = dotPersist === 'unread' && postsPersist.length === 0;
    // Actual reopen => exactly one correct read, no other view acked.
    clearPosts();
    await page.locator('.session-row[data-session-id="short-a"] .session-select').click();
    await expect.poll(() => focusedSecondaryId(), { timeout: 20000 });
    await page.waitForTimeout(1500);
    const dotReopen = await dotOf('short-a');
    const readAfter = await readStateOf('short-a');
    const mine = readPostsFor('short-a');
    const others = posts.filter((p) => p.op === 'read' && p.id !== 'short-a');
    const reopens = mine.length === 1 && mine[0]?.answer === historyBefore.answer
      && dotReopen === 'idle' && readAfter.read === historyBefore.answer && others.length === 0;
    const ok = persists && reopens;
    proof.phases.manualUnread = {
      passed: ok, historyBefore, dotPersist, postsPersist,
      dotReopen, readAfter, readPosts: mine, otherReadPosts: others,
      expect: 'unread persists across refresh while another pane focused; reopen => exactly 1 correct POST + idle',
    };
    if (!ok) failures.push('manualUnread');
  } catch (e) {
    fail('manualUnread', String(e?.message || e).slice(0, 1200));
  }

  await ctxA.close();

  // ---------- Context B: classic (no docking) ----------
  try {
    clearPosts();
    const ctxB = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    await ctxB.addInitScript(
      ({ cwd }) => {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId: 'boot-long', projectOverview: false }));
        localStorage.setItem('prime-studio.docking.layout', JSON.stringify({ enabled: false }));
      },
      { cwd },
    );
    page = await ctxB.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', (e) => errors.push(String(e?.message || e)));
    recordPosts(page);
    await page.goto(url);
    await expect(page.locator('#messages')).toContainText('Boot longue', { timeout: 25000 });
    await page.waitForTimeout(1200);
    await markUnreadViaMenu('classic-c');
    await expect.poll(() => dotOf('classic-c'), { timeout: 20000 }).toBe('unread');
    const historyBefore = await readStateOf('classic-c');
    clearPosts();
    await page.locator('.session-row[data-session-id="classic-c"] .session-select').click();
    await expect(page.locator('#messages')).toContainText('reponse deux courte.', { timeout: 20000 });
    await page.waitForTimeout(1800);
    const metrics = await page.locator('#conversation-scroll').evaluate((n) => ({
      scrollHeight: n.scrollHeight, clientHeight: n.clientHeight,
      scrollTop: n.scrollTop, overflow: n.scrollHeight - n.clientHeight,
    }));
    const dotAfter = await dotOf('classic-c');
    const readAfter = await readStateOf('classic-c');
    const mine = readPostsFor('classic-c');
    const others = posts.filter((p) => p.op === 'read' && p.id !== 'classic-c');
    const ok = mine.length === 1 && mine[0]?.answer === historyBefore.answer
      && dotAfter === 'idle' && readAfter.read === historyBefore.answer && others.length === 0;
    proof.phases.classic = {
      passed: ok, metrics, historyBefore, dotAfter, readAfter,
      readPosts: mine, otherReadPosts: others,
      expect: 'classic short open => POST {id:classic-c, answer} + idle (host behavior preserved)',
    };
    if (!ok) failures.push('classic');
    await ctxB.close();
  } catch (e) {
    fail('classic', String(e?.message || e).slice(0, 1200));
  }
} finally {
  await browser.close().catch(() => {});
  await app.close().catch(() => {});
  if (dirname(temp) === resolve(tmpdir())) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
proof.errors = errors;
proof.failures = [...new Set(failures)];
proof.coverage = {
  cases: ['shortOpen', 'hiddenRefresh', 'visibleUnfocused', 'longAboveBottom', 'manualUnread', 'classic'],
  coalescing: 'each read phase asserts exactly 1 POST; other-view acks must be 0',
  unitOnly: 'running/loading guards are exercised by test/visible-pane-read.test.mjs, not this inert-runtime browser fixture',
  noFalseConfidence: 'distinct answers per session asserted; POST answer must equal that session history answer',
};
proof.verdict = {
  passed: proof.failures.length === 0 && errors.length === 0,
  summary: 'expected-correct-behavior baseline: shortOpen/manualUnread/visibleUnfocused reopen FAIL until focused paint read lands; hiddenRefresh/visibleUnfocused-persist/longAboveBottom/classic guard regressions (focused-only paint ACK; scroll ACK at visible bottom any focus; periodic sync retries focused owner)',
};
await mkdir(dirname(resolve(proofOut)), { recursive: true }).catch(() => {});
await writeFile(proofOut, JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ proofOut, verdict: proof.verdict, failures: proof.failures, phases: proof.phases, coverage: proof.coverage, errors }, null, 2));
if (!proof.verdict.passed) process.exitCode = 1;
