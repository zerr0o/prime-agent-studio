// Isolated folder-color acceptance: six swatches, per-project tint, persist, reset, keyboard, read-only.
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'prime-studio-folder-color-ui-'));
const first = join(root, 'Atelier');
const second = join(root, 'Documents');
const sessionDir = join(root, 'sessions');
await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
const stamp = new Date().toISOString();
await writeFile(
  join(sessionDir, 'seed.jsonl'),
  [
    { type: 'session', id: 'seed-session', cwd: first, timestamp: stamp },
    { type: 'message', id: 'seed-u', parentId: null, timestamp: stamp, message: { role: 'user', content: 'Seed' } },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n') + '\n',
);

const { createApp } = await import('../server.mjs');
const app = createApp({
  initialCwd: first,
  agentHome: join(root, 'agent'),
  sessionDir,
  dataDir: join(root, 'data'),
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({
      models: [{ id: 'fixture/demo', name: 'Demo', provider: 'fixture' }],
      default: { model: 'fixture/demo' },
    }),
    async close() {},
  },
});
await app.store.project({ cwd: first }, true);
await app.store.project({ cwd: second });
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;

const errors = [];
const checks = [];
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome', headless: true });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  let readOnly = false;
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.preferences = { ...body.preferences, readOnly };
    await route.fulfill({ response, json: body });
  });
  await page.goto(url);
  const row = (name) => page.locator('.project-entry').filter({ has: page.locator('.project-label', { hasText: name }) }).locator('.project-row');
  const menu = page.locator('#project-menu');
  const swatches = menu.locator('[data-project-color]');
  await expect(row('Atelier')).toBeVisible();
  await expect(row('Documents')).toBeVisible();

  // Right-click the non-selected project: menu opens with six swatches, transparent first.
  await row('Documents').click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(swatches).toHaveCount(6);
  await expect(swatches.nth(0)).toHaveAttribute('data-project-color', 'transparent');
  await expect(menu.locator('[data-project-action="terminal"]')).toBeVisible();
  await expect(swatches.nth(0)).toHaveAttribute('aria-checked', 'true');
  const overflow = await page.evaluate(() => {
    const rowEl = document.querySelector('.project-color-row');
    return rowEl ? rowEl.scrollWidth - rowEl.clientWidth : 999;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  checks.push('Six swatches transparent first, terminal preserved, no row overflow');

  // Select a swatch: only that project icon is tinted.
  await menu.locator('[data-project-color="#8fb49e"]').click();
  await expect(menu).toBeHidden();
  await expect(row('Documents')).toHaveAttribute('data-project-color', '#8fb49e');
  await expect(row('Atelier')).toHaveAttribute('data-project-color', 'transparent');
  const tint = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.project-row')];
    const get = (label) => rows.find((r) => r.textContent.includes(label));
    return {
      second: get('Documents').querySelector('.project-folder-icon')?.style.color || '',
      first: get('Atelier').querySelector('.project-folder-icon')?.style.color || '',
    };
  });
  expect(tint.second).not.toBe('');
  expect(tint.first).toBe('');
  checks.push('Swatch tints only the targeted folder icon');

  // Persist across reload.
  await page.reload();
  await expect(row('Documents')).toHaveAttribute('data-project-color', '#8fb49e');
  await expect(row('Atelier')).toHaveAttribute('data-project-color', 'transparent');
  checks.push('Tint persists across reload');

  // Reset restores the default icon.
  await row('Documents').click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-project-color="#8fb49e"]')).toHaveAttribute('aria-checked', 'true');
  await menu.locator('[data-project-color="transparent"]').click();
  await expect(menu).toBeHidden();
  await expect(row('Documents')).toHaveAttribute('data-project-color', 'transparent');
  checks.push('Transparent reset restores the default icon');

  // Keyboard: arrows move through every visible item including swatches, Enter selects.
  await row('Documents').locator('..').locator('.project-more').click();
  await expect(menu).toBeVisible();
  const focused = [];
  await page.keyboard.press('Home');
  for (let step = 0; step < 20; step++) {
    focused.push(await page.evaluate(() => document.activeElement?.dataset?.projectColor || document.activeElement?.dataset?.projectAction || 'other'));
    await page.keyboard.press('ArrowDown');
  }
  expect(focused.some((key) => key === '#7fa6c9' || key === 'transparent')).toBe(true);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  const wrapped = await page.evaluate(() => document.activeElement?.dataset?.projectAction || document.activeElement?.dataset?.projectColor || 'other');
  expect(wrapped).not.toBe('other');
  // Simulate a non-Windows menu (terminal hidden): arrows never stick on hidden items.
  await page.evaluate(() => {
    document.querySelector('[data-project-action="terminal"]')?.setAttribute('hidden', '');
  });
  await page.keyboard.press('Home');
  for (let step = 0; step < 20; step++) {
    const state = await page.evaluate(() => {
      const active = document.activeElement;
      return { hidden: active?.hasAttribute('hidden') || false, rects: active?.getClientRects().length || 0 };
    });
    expect(state.hidden).toBe(false);
    expect(state.rects).toBeGreaterThan(0);
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await row('Documents').click({ button: 'right' });
  await expect(menu).toBeVisible();
  await menu.locator('[data-project-color="#7fa6c9"]').focus();
  await page.keyboard.press('Enter');
  await expect(row('Documents')).toHaveAttribute('data-project-color', '#7fa6c9');
  checks.push('Keyboard arrows and Enter select a swatch without sticking on hidden items');

  // Screenshot with the tinted icon and open menu.
  await row('Documents').click({ button: 'right' });
  await expect(menu).toBeVisible();
  await mkdir(resolve('.local'), { recursive: true });
  await page.screenshot({ path: resolve('.local/project-folder-colors.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');

  // Read-only: color group hidden, menu stays usable.
  readOnly = true;
  await page.reload();
  await row('Atelier').locator('..').locator('.project-more').click();
  await expect(menu).toBeVisible();
  await expect(page.locator('#project-color-group')).toBeHidden();
  await expect(menu.getByRole('menuitem', { name: 'Connaissances du projet' })).toBeVisible();
  checks.push('Read-only hides the color group');

  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
