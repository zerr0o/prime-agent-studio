// Real Studio UI and admission paths, with isolated resources and a local fake runtime.
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server.mjs';
import { commandCatalog } from '../lib/commands.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-chip-ui-'));
const cwd = join(root, 'project'),
  agentHome = join(root, 'agent'),
  sessionDir = join(root, 'sessions');
await Promise.all([cwd, agentHome, sessionDir].map((path) => mkdir(path)));
await writeFile(
  join(sessionDir, 'test.jsonl'),
  [
    { type: 'session', id: 'chip-session', cwd, timestamp: new Date().toISOString() },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'Test des chips' } },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);
const longName = 'skill:design-accessible-pour-des-interfaces-mobiles-et-bureau';
const catalog = commandCatalog({
  builtins: [{ name: 'goal', description: 'Objectif' }],
  commands: [
    { name: longName, source: 'skill', description: 'Concevoir une interface accessible' },
    { name: 'review', source: 'prompt', description: 'Relire un fichier' },
    ...Array.from({ length: 800 }, (_, i) => ({
      name: `skill:fixture-${String(i).padStart(3, '0')}`,
      source: 'skill',
      description: `Ressource de démonstration ${i}`,
    })),
  ],
});
const controls = [],
  sends = [],
  errors = [],
  checks = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/luna', name: 'Luna', provider: 'fixture', input: ['text', 'image'] }],
    default: { model: 'fixture/luna' },
  }),
  async start(input) {
    let finish;
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    const handle = {
      input,
      done,
      cancel: async () => handle.finish(),
      finish() {
        input.onEvent({ kind: 'done', status: 'completed', code: 0 });
        finish({ status: 'completed', code: 0 });
      },
    };
    controls.push(handle);
    return handle;
  },
  async close() {
    for (const c of controls) c.finish();
  },
};
const snapshot = { available: true, steering: [], followUps: [] };
const liveClient = {
  getSnapshot: async () => snapshot,
  send: async (id, cwd, input) => {
    sends.push(input);
    return { accepted: true, snapshot };
  },
};
const app = createApp({
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir: join(root, 'data'),
  runtime,
  liveClient,
  commands: { list: async () => catalog },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch(
    !process.env.PRIME_STUDIO_TEST_BROWSER || process.env.PRIME_STUDIO_TEST_BROWSER === 'chromium'
      ? { headless: true }
      : { channel: process.env.PRIME_STUDIO_TEST_BROWSER, headless: true },
  );
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      locale: 'fr-FR',
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    let release,
      requests = 0;
    const requestUrls = [];
    const gate = new Promise((done) => {
      release = done;
    });
    await page.route('**/api/commands?**', async (route) => {
      requests++;
      requestUrls.push(route.request().url());
      await gate;
      await route.continue().catch(() => {});
    });
    await page.goto(`http://127.0.0.1:${app.server.address().port}`);
    if (mobile) await page.locator('#toggle-sidebar').click();
    await page.locator('.session-select').click();
    const input = page.locator('#composer'),
      chip = page.locator('#composer-command');
    await input.fill('/');
    await expect(page.locator('#command-suggestions')).toBeVisible({ timeout: 500 });
    await expect(page.locator('.command-suggestion').filter({ hasText: '/model' })).toBeVisible();
    await expect(page.locator('.command-loading')).toContainText('Chargement');
    await input.fill('/skill:design');
    await expect(page.locator('.command-loading')).toBeVisible({ timeout: 500 });
    release();
    await expect(page.locator('.command-suggestion')).toContainText(longName);
    await input.press('Tab');
    await expect(chip).toHaveAttribute('data-kind', 'skill');
    await expect(input).toHaveValue('');
    await input.fill('Crée une page\nGarde les accents : été.');
    await expect(page.locator('#send-button')).toBeEnabled();
    expect(new Set(requestUrls).size).toBe(requests);
    await page.reload();
    await expect(chip).toBeVisible();
    await expect(input).toHaveValue('Crée une page\nGarde les accents : été.');
    await input.press('Control+Home');
    await input.press('Backspace');
    await expect(chip).toBeHidden();
    await expect(input).toHaveValue('Crée une page\nGarde les accents : été.');
    async function choose(name) {
      await page.locator('#open-commands').click();
      await page.locator('.command-search').fill(`/${name}`);
      await page.locator('.command-item').first().click();
      await expect(chip).toBeVisible();
    }
    await choose('review');
    await expect(chip).toHaveAttribute('data-kind', 'prompt');
    await input.press('Control+a');
    const copied = await input.evaluate((el) => {
      const clipboardData = new DataTransfer();
      el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
      return clipboardData.getData('text/plain');
    });
    expect(copied).toBe('/review Crée une page\nGarde les accents : été.');
    await input.evaluate((el) =>
      el.dispatchEvent(
        new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }),
      ),
    );
    await expect(chip).toBeHidden();
    await expect(input).toHaveValue('');
    await choose('goal');
    await expect(chip).toHaveAttribute('data-kind', 'command');
    for (const width of mobile ? [320, 390] : [780, 1024, 1081, 1920, 1440]) {
      await page.setViewportSize({ width, height: mobile ? 844 : 960 });
      const labelSize = await page.locator('#composer-command-label').evaluate((el) => ({
        visible: el.clientWidth,
        text: el.scrollWidth,
      }));
      expect(labelSize.text, `/goal must be fully visible at ${width}px`).toBeLessThanOrEqual(
        labelSize.visible + 1,
      );
    }
    await page.locator('#composer-form').screenshot({
      path: join(process.cwd(), '.local', `command-goal-${mobile ? 'mobile' : 'desktop'}.png`),
    });
    await input.fill('status');
    await input.press('Control+a');
    await input.press('x');
    await expect(chip).toBeHidden();
    await expect(input).toHaveValue('x');
    await input.fill('');
    await page.locator('#open-commands').click();
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    await expect(page.locator('.command-item')).toHaveCount(30);
    await page.locator('.command-list').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(() => page.locator('.command-item').count()).toBeGreaterThan(30);
    expect(await page.locator('.command-item').count()).toBeLessThan(100);
    await page.locator('.command-search').fill('fixture-799');
    await expect(page.locator('.command-item')).toHaveCount(1);
    await page.locator('.command-item').click();
    await page.locator('#remove-command').click();
    await choose(longName);
    await input.fill('Analyse ce document et cette image.');
    await page
      .locator('#attachment-files')
      .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Document de test') });
    await expect(page.locator('.image-draft')).toHaveCount(1);
    await input.evaluate((el) => {
      const bytes = Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=='),
        (c) => c.charCodeAt(0),
      );
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    });
    await expect(page.locator('.image-draft')).toHaveCount(2);
    await expect(chip).toHaveAttribute('data-kind', 'skill');
    for (const viewport of mobile
      ? [
          { width: 390, height: 844 },
          { width: 320, height: 568 },
          { width: 390, height: 470 },
        ]
      : [{ width: 1440, height: 960 }]) {
      await page.setViewportSize(viewport);
      await expect
        .poll(async () => {
          const box = await page.locator('#composer-form').boundingBox();
          return box.y + box.height;
        })
        .toBeLessThanOrEqual(viewport.height);
      const form = await page.locator('#composer-form').boundingBox();
      const rect = await chip.boundingBox();
      expect(rect.x).toBeGreaterThanOrEqual(form.x);
      expect(rect.x + rect.width).toBeLessThanOrEqual(form.x + form.width + 1);
      expect(form.y + form.height).toBeLessThanOrEqual(viewport.height);
    }
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 });
    await page.screenshot({
      path: join(process.cwd(), '.local', `command-chip-${mobile ? 'mobile' : 'desktop'}.png`),
    });
    const prior = controls.length;
    await page.locator('#send-button').click();
    await expect.poll(() => controls.length).toBe(prior + 1);
    expect(controls.at(-1).input.message).toMatch(new RegExp(`^/${longName} Analyse`));
    expect(controls.at(-1).input.images).toHaveLength(1);
    expect(controls.at(-1).input.message).toContain('notes.txt');
    await expect(chip).toBeHidden();
    await choose('review');
    await input.fill('"fichier avec espaces.js"');
    await expect(page.locator('#send-button')).toBeEnabled();
    await page.locator('#send-button').click();
    await expect.poll(() => sends.length).toBe(prior + 1);
    expect(sends.at(-1).message).toBe('/review "fichier avec espaces.js"');
    await expect(chip).toBeHidden();
    await expect(input).toHaveValue('');
    controls.at(-1).finish();
    checks.push(
      `${mobile ? 'Mobile' : 'PC'} : menu immédiat avant la réponse réseau, cache, pagination de 801 skills, chips, brouillons, copie/coupe, pièces jointes et envoi en cours de tour`,
    );
    await context.close();
  }
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser?.close();
  await app.close();
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
    throw new Error('Fixture path outside temporary directory');
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
