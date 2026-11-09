// Focus-ring test for tabindex=-1 conversation scrollers.
// Covers the "black bar above the composer after click + Backspace" bug: the
// UA default `outline: auto` painted at the scroll edge once a keypress flips
// :focus-visible on (BEFORE: light theme = `auto 1px rgb(16,16,16)`, a literal
// black bar). The fix keeps a small inset LEFT accent marker only — no
// top/bottom bar — with a system-outline fallback under forced-colors.
// Asserts in dark+light for:
//   (A) the static host scroller #conversation-scroll with a REAL conversation
//       selected (real element, 1440x900 app, cropped evidence), and
//   (B) a REAL docked secondary-pane .cvw-scroller (real docking layout +
//       seeded session opened in a secondary tab — same pattern as
//       test-pane-scroll-pill-ui.mjs), plus ArrowDown/PageDown scrolling.
// Real app + headless browser, fake runtime; no provider calls.
// Separate from navigation/back-keyguard tests (sibling-owned).
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createDefaultLayout } from '../public/docking-layout.js';

const ACCENT = { dark: 'rgb(183, 178, 231)', light: 'rgb(119, 113, 178)' };

async function seed(sessionDir, cwd, id, title, count, minute) {
  const at = Date.UTC(2026, 9, 1, 10, minute);
  const records = [{ type: 'session', id, cwd, version: 3, timestamp: new Date(at).toISOString() }];
  let parent = null;
  for (let i = 0; i < count; i += 1) {
    const user = {
      type: 'message',
      id: `${id}-u${i}`,
      parentId: parent,
      message: { role: 'user', content: i ? `Suite ${i}` : title, timestamp: at + i * 2000 },
    };
    const text =
      `Réponse ${i + 1}. ` + 'Paragraphe de remplissage pour faire défiler la conversation. '.repeat(8);
    const reply = {
      type: 'message',
      id: `${id}-a${i}`,
      parentId: user.id,
      message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: at + i * 2000 + 1000 },
    };
    records.push(user, reply);
    parent = reply.id;
  }
  await writeFile(join(sessionDir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const snapshot = (page, sel) =>
  page.evaluate((sel) => {
    const s = document.querySelector(sel);
    const cs = getComputedStyle(s);
    return {
      found: !!s,
      active: document.activeElement === s,
      focus: s.matches(':focus'),
      focusVisible: s.matches(':focus-visible'),
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
      boxShadow: cs.boxShadow,
    };
  }, sel);

// Left-only inset marker: no outline anywhere, accent shadow, nothing
// horizontal that could read as a bar above the composer.
function expectLeftMarker(snap, theme) {
  expect(snap.focusVisible).toBe(true);
  expect(snap.outlineStyle).toBe('none');
  expect(snap.boxShadow).toContain('inset');
  expect(snap.boxShadow).toContain(ACCENT[theme]);
}

async function croppedClip(page, scrollerSel, composerSel) {
  const [s, c] = await Promise.all([
    page.locator(scrollerSel).first().boundingBox(),
    page.locator(composerSel).first().boundingBox(),
  ]);
  const y = Math.max(0, s.y + s.height - 220);
  return { x: s.x, y, width: s.width, height: Math.min(900 - y, 220 + c.height + 30) };
}

const root = await mkdtemp(join(tmpdir(), 'studio-focus-ring-'));
const cwd = join(root, 'project');
const sessionDir = join(root, 'sessions');
for (const dir of [cwd, sessionDir, join(root, 'data'), join(root, 'agent')])
  await mkdir(dir, { recursive: true });
await seed(sessionDir, cwd, 'short', 'Courte conversation', 1, 0);
await seed(sessionDir, cwd, 'long', 'Longue conversation', 8, 1);
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/demo', name: 'Demo', provider: 'fixture' }],
    default: { model: 'fixture/demo' },
  }),
  async start() {
    return { done: Promise.resolve({ status: 'completed', code: 0 }), cancel() {} };
  },
  async close() {},
};
const app = createApp({
  runtime,
  initialCwd: cwd,
  sessionDir,
  agentHome: join(root, 'agent'),
  dataDir: join(root, 'data'),
});
await app.store.project({ cwd });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await launchStudioBrowser({ headless: true });
const errors = [];
try {
  for (const theme of ['dark', 'light']) {
    // ---- (A) static host scroller with a REAL conversation ----
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(
        ({ cwd, theme }) => {
          localStorage.setItem(
            'prime-studio.selection',
            JSON.stringify({ cwd, sessionId: 'long', projectOverview: false }),
          );
          localStorage.setItem('prime-studio.preferences', JSON.stringify({ theme }));
        },
        { cwd, theme },
      );
      await page.goto(url);
      await expect(page.locator('#conversation-scroll')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('#messages')).toContainText('Réponse', { timeout: 15000 });
      await page.locator('#conversation-scroll').click({ position: { x: 200, y: 300 } });
      await page.waitForTimeout(300);
      const clicked = await snapshot(page, '#conversation-scroll');
      expect(clicked.active).toBe(true);
      expect(clicked.focusVisible).toBe(false);
      expect(clicked.outlineStyle).toBe('none');
      expect(clicked.boxShadow).toBe('none');
      // Real Backspace keypress (a JS navigation guard may suppress the
      // default, but keyboard modality must still show the left marker).
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);
      const bs = await snapshot(page, '#conversation-scroll');
      expect(bs.active).toBe(true);
      expectLeftMarker(bs, theme);
      await page.screenshot({
        path: `test-results/focus-ring-after-primary-${theme}.png`,
        clip: await croppedClip(page, '#conversation-scroll', '.composer-area'),
      });
      // ArrowDown + PageDown keep scrolling the focused scroller.
      await page.locator('#conversation-scroll').evaluate((n) => n.scrollTo({ top: 0 }));
      await page.waitForTimeout(200);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(300);
      const kb = await snapshot(page, '#conversation-scroll');
      expectLeftMarker(kb, theme);
      const pos = await page.locator('#conversation-scroll').evaluate((n) => ({
        top: n.scrollTop,
        canScroll: n.scrollHeight > n.clientHeight + 5,
      }));
      expect(pos.canScroll).toBe(true);
      expect(pos.top).toBeGreaterThan(0);
      console.log(
        `ok - static #conversation-scroll ${theme}: click=clean backspace/kb=left-marker scroll=ok`,
      );
      await page.close();
    }
    // ---- (B) REAL docked secondary-pane .cvw-scroller ----
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', (e) => errors.push(String(e?.message || e)));
      await context.addInitScript(
        ({ cwd, theme, layout }) => {
          localStorage.setItem(
            'prime-studio.selection',
            JSON.stringify({ cwd, sessionId: 'short', projectOverview: false }),
          );
          localStorage.setItem('prime-studio.preferences', JSON.stringify({ theme }));
          localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
        },
        { cwd, theme, layout: { ...createDefaultLayout(), enabled: true } },
      );
      await page.goto(url);
      await expect(page.locator('#dock-workspace')).toBeVisible({ timeout: 20000 });
      // Open the long conversation in a secondary tab (real docked pane).
      await page
        .locator('#session-list .session-select')
        .filter({ hasText: 'Longue conversation' })
        .first()
        .click();
      const viewId = await expect
        .poll(() =>
          page.evaluate(
            () => document.querySelector('.dock-tab.is-conversation.is-focused')?.dataset.dockTab,
          ),
        )
        .not.toBe('conversation')
        .then(() =>
          page.evaluate(() => document.querySelector('.dock-tab.is-conversation.is-focused').dataset.dockTab),
        );
      const shell = `.cvw-shell[data-view="${viewId}"]`;
      const scrollerSel = `${shell} .cvw-scroller`;
      await expect(page.locator(`${shell} .cvw-messages`)).toContainText('Réponse');
      await page.locator(scrollerSel).click({ position: { x: 200, y: 120 } });
      await page.waitForTimeout(300);
      const clicked = await snapshot(page, scrollerSel);
      expect(clicked.found).toBe(true);
      expect(clicked.active).toBe(true);
      expect(clicked.focusVisible).toBe(false);
      expect(clicked.outlineStyle).toBe('none');
      // Backspace now navigates internally when history exists. A navigation
      // arrow activates keyboard focus without leaving this scroller.
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(300);
      const bs = await snapshot(page, scrollerSel);
      expect(bs.active).toBe(true);
      expectLeftMarker(bs, theme);
      await page.screenshot({
        path: `test-results/focus-ring-after-docked-${theme}.png`,
        clip: await croppedClip(page, scrollerSel, `${shell} .cvw-composer-area`),
      });
      // ArrowDown + PageDown keep scrolling the real docked scroller.
      await page.locator(scrollerSel).evaluate((n) => n.scrollTo({ top: 0 }));
      await page.waitForTimeout(200);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(300);
      const kb = await snapshot(page, scrollerSel);
      expectLeftMarker(kb, theme);
      const pos = await page.locator(scrollerSel).evaluate((n) => ({
        top: n.scrollTop,
        canScroll: n.scrollHeight > n.clientHeight + 5,
      }));
      expect(pos.canScroll).toBe(true);
      expect(pos.top).toBeGreaterThan(0);
      console.log(`ok - real docked .cvw-scroller ${theme}: click=clean backspace/kb=left-marker scroll=ok`);
      await context.close();
    }
    // ---- (C) forced-colors: system outline fallback (box-shadow ignored) ----
    {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        forcedColors: 'active',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', (e) => errors.push(String(e?.message || e)));
      await context.addInitScript(
        ({ cwd, theme }) => {
          localStorage.setItem(
            'prime-studio.selection',
            JSON.stringify({ cwd, sessionId: 'long', projectOverview: false }),
          );
          localStorage.setItem('prime-studio.preferences', JSON.stringify({ theme }));
        },
        { cwd, theme },
      );
      await page.goto(url);
      await expect(page.locator('#conversation-scroll')).toBeVisible({ timeout: 30000 });
      await page.locator('#conversation-scroll').click({ position: { x: 200, y: 300 } });
      await page.waitForTimeout(300);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);
      const bs = await snapshot(page, '#conversation-scroll');
      expect(bs.active).toBe(true);
      expect(bs.focusVisible).toBe(true);
      expect(bs.outlineStyle).toBe('solid');
      expect(bs.outlineWidth).toBe('2px');
      expect(bs.boxShadow).toBe('none');
      console.log(`ok - forced-colors ${theme}: system outline fallback visible`);
      await context.close();
    }
  }
  expect(errors).toEqual([]);
  console.log('PASS conversation focus ring: static + real docked + forced-colors (dark+light)');
} finally {
  await browser.close();
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
