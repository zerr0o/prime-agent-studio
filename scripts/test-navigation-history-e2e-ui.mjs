// E2E: classic+docked back/forward preserves drafts/scroll, no reload, truncation, Backspace, dock tabs.
// Own seeded fixture (2 long sessions). Bounded 120s. Headless only.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { createApp } from '../server.mjs';
import { createDefaultLayout } from '../public/docking-layout.js';
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';

const timer = setTimeout(() => {
  console.error(JSON.stringify({ passed: false, reason: 'deadline' }));
  process.exit(2);
}, 120000);
timer.unref?.();
let browser, app, root, activePage;
const checks = [];
const errors = [];
try {
  root = await mkdtemp(join(tmpdir(), 'prime-navhist-e2e-'));
  const cwd = join(root, 'Atelier');
  const sessionDir = join(root, 'sessions');
  const dataDir = join(root, 'data');
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const entry = (id, role, content) => ({
    type: 'message',
    id,
    parentId: null,
    message: { role, content, timestamp: Date.now() },
  });
  async function seed(file, id, projectCwd, title, n) {
    const records = [
      { type: 'session', id, cwd: projectCwd, version: 3, timestamp: new Date().toISOString() },
    ];
    let parentId = null;
    const append = (key, role, text) => {
      records.push({
        type: 'message',
        id: key,
        parentId,
        message: { role, content: [{ type: 'text', text }], timestamp: Date.now() },
      });
      parentId = key;
    };
    append(`${id}-u0`, 'user', title);
    for (let i = 0; i < n; i++) {
      append(
        `${id}-a${i}`,
        'assistant',
        `Paragraphe ${i + 1} de ${id} : ` + 'contenu long pour défilement. '.repeat(30),
      );
      append(`${id}-u${i + 1}`, 'user', `Suite ${i + 1} ?`);
    }
    await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
  }
  await seed(join(sessionDir, 'nav-a.jsonl'), 'nav-a', cwd, 'Session A longue', 16);
  await seed(join(sessionDir, 'nav-b.jsonl'), 'nav-b', cwd, 'Session B longue', 16);
  const starts = [];
  const runtime = {
    getStatus: async () => ({ available: true, version: 'e2e' }),
    getModels: async () => ({
      models: [{ id: 'e2e/model', name: 'e2e', provider: 'e2e' }],
      default: { model: 'e2e/model' },
    }),
    async start(input) {
      const id = `created-nav-${starts.length + 1}`;
      starts.push({ id, message: input.message });
      await seed(join(sessionDir, `${id}.jsonl`), id, cwd, input.message, 1);
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      const finish = () => {
        const event = { kind: 'done', sessionId: id, status: 'completed', code: 0 };
        input.onEvent(event);
        resolveDone(event);
        return done;
      };
      input.onEvent({ kind: 'session', sessionId: id, cwd });
      setTimeout(finish, 100);
      return { done, cancel: finish };
    },
    close: async () => {},
  };
  app = createApp({ runtime, sessionDir, dataDir, initialCwd: cwd });
  await app.store.project({ cwd });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  browser = await launchStudioBrowser();
  for (const mode of ['classic', 'docked']) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'fr-FR',
      reducedMotion: 'reduce',
    });
    await ctx.addInitScript(
      ({ cwd, layout }) => {
        localStorage.setItem(
          'prime-studio.selection',
          JSON.stringify({ cwd, sessionId: 'nav-a', projectOverview: false }),
        );
        localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
      },
      { cwd, layout: { ...createDefaultLayout(), enabled: mode === 'docked' } },
    );
    const page = await ctx.newPage();
    activePage = page;
    page.setDefaultTimeout(10000);
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    const input = () =>
      page.locator('textarea#composer:visible, textarea[data-cvw="composer"]:visible').last();
    const scroll = () => page.locator('#conversation-scroll:visible, .cvw-scroller:visible').last();
    const ready = async (id) =>
      await expect(page.getByText(new RegExp(`^Paragraphe \\d+ de ${id}`)).first()).toBeVisible();
    const open = async (id) => {
      await page
        .locator(
          `#session-list [data-session-id="${id}"] .session-select, #session-list .session-select[data-session-id="${id}"]`,
        )
        .first()
        .click();
      await ready(id);
    };
    await page.goto(url);
    await ready('nav-a');
    await page.evaluate(() => (window.__navDocumentMarker = 'same document'));
    await expect(page.locator('#nav-back')).toBeDisabled();
    await input().fill('Brouillon A intact');
    const topA = await scroll().evaluate(async (el) => {
      el.scrollTop = 320;
      await new Promise(requestAnimationFrame);
      return el.scrollTop;
    });
    assert.ok(topA > 0, `${mode}: real scroll required`);
    await open('nav-b');
    await input().fill('Brouillon B intact');
    await expect(page.locator('#nav-back')).toBeEnabled();
    await page.locator('#nav-back').click();
    await ready('nav-a');
    await expect(input()).toHaveValue('Brouillon A intact');
    await expect.poll(() => scroll().evaluate((el) => el.scrollTop)).toBeCloseTo(topA, 0);
    await page.locator('#nav-forward').click();
    await ready('nav-b');
    await expect(input()).toHaveValue('Brouillon B intact');
    await page.goBack();
    await ready('nav-a');
    await expect(input()).toHaveValue('Brouillon A intact');
    await input().press('End');
    await input().press('X');
    await input().press('Backspace');
    await expect(input()).toHaveValue('Brouillon A intact');
    // User navigation after Back removes the old forward branch.
    await open('nav-b');
    await expect(page.locator('#nav-forward')).toBeDisabled();
    await page.locator('#new-session').click();
    await expect(input()).toHaveValue('');
    await input().fill('Brouillon neuf sans session');
    await open('nav-a');
    await page.locator('#nav-back').click();
    await expect(input()).toHaveValue('Brouillon neuf sans session');
    await page.locator('#nav-forward').click();
    await ready('nav-a');
    await expect(input()).toHaveValue('Brouillon A intact');
    if (mode === 'docked') {
      await page.locator('.dock-tab.is-conversation').filter({ hasText: 'Session B longue' }).first().click();
      await ready('nav-b');
      await expect(input()).toHaveValue('Brouillon B intact');
      await page.locator('#nav-back').click();
      await ready('nav-a');
      await expect(input()).toHaveValue('Brouillon A intact');
    }
    if (mode === 'classic') {
      await open('nav-b');
      const held = new Map();
      await page.route('**/api/history?*', async (route) => {
        const id = new URL(route.request().url()).searchParams.get('id');
        if (!['nav-a', 'nav-b'].includes(id)) return route.continue();
        const response = await route.fetch();
        held.set(id, { route, response });
      });
      try {
        await page.locator('#nav-back').click();
        await expect.poll(() => held.has('nav-a')).toBe(true);
        await page.locator('#session-list [data-session-id="nav-b"] .session-select').click();
        await expect.poll(() => held.has('nav-b')).toBe(true);
        const a = held.get('nav-a');
        held.delete('nav-a');
        await a.route.fulfill({ response: a.response });
        await expect(page.locator('#header-session')).toHaveText('Session B longue');
        const b = held.get('nav-b');
        held.delete('nav-b');
        await b.route.fulfill({ response: b.response });
        await ready('nav-b');
        await expect(input()).toHaveValue('Brouillon B intact');
      } finally {
        await Promise.allSettled(
          [...held.values()].map(({ route, response }) => route.fulfill({ response })),
        );
        await page.unroute('**/api/history?*');
      }
      checks.push('classic: late Back response cannot replace a newer selection still loading');
    }
    const startsBefore = starts.length;
    await page.locator('#new-session').click();
    await input().fill(`Conversation créée en ${mode}`);
    await input().press('Enter');
    await expect.poll(() => starts.length).toBe(startsBefore + 1);
    const created = starts.at(-1).id;
    await ready(created);
    await input().fill('Brouillon de la conversation créée');
    await open('nav-a');
    await page.locator('#nav-back').click();
    await ready(created);
    await expect(input()).toHaveValue('Brouillon de la conversation créée');
    assert.equal(starts.length, startsBefore + 1, 'history navigation never starts another run');
    checks.push(`${mode}: a sent new draft becomes its saved conversation in history`);
    assert.equal(await page.evaluate(() => window.__navDocumentMarker), 'same document');
    await page.screenshot({ path: `.local/study/v448-usability/navigation-${mode}.png` });
    checks.push(
      `${mode}: real Back/Forward, browser Back, saved/new drafts, scroll, editing, truncation, no reload`,
    );
    await ctx.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }));
} catch (e) {
  if (activePage) {
    console.error((await activePage.locator('body').innerText()).slice(0, 5500));
    await activePage.screenshot({ path: '.local/study/v448-usability/navigation-failure.png' });
  }
  console.error(JSON.stringify({ passed: false, reason: String(e.message || e), checks, errors }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app?.close();
  if (root) await rm(root, { recursive: true, force: true });
  clearTimeout(timer);
}
