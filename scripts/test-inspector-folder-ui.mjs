// Isolated browser fixture: the native opener is recorded, no user folder or session is touched.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-inspector-folder-ui-'));
const cwd = join(temp, 'Atelier'),
  otherCwd = join(temp, "Projet é & [notes], l'atelier");
await Promise.all([cwd, otherCwd, 'test-results'].map((path) => mkdir(path, { recursive: true })));
await writeFile(join(cwd, 'notes.md'), '# Notes du projet\n');
const opened = [],
  errors = [];
let completeOpen = async () => ({ opened: true });
const app = createApp({
  initialCwd: cwd,
  agentHome: join(temp, 'agent'),
  sessionDir: join(temp, 'sessions'),
  dataDir: join(temp, 'data'),
  openDirectory: async (path) => {
    opened.push(path);
    return completeOpen();
  },
  runtime: {
    getStatus: async () => ({ available: true }),
    getModels: async () => ({ models: [] }),
    close: async () => {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const local = `http://127.0.0.1:${app.server.address().port}`;
assert.equal(
  (
    await fetch(local + '/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: local },
      body: JSON.stringify({ cwd: otherCwd, name: 'Projet suivant' }),
    })
  ).status,
  201,
);
const gateways = [],
  code = '12345678',
  salt = 'd'.repeat(32);
let browser, page;

async function openPage({ width = 1440, url = local, preferences, noProject = false } = {}) {
  const context = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width, height: width < 1080 ? 844 : 960 },
    isMobile: width < 1080,
    hasTouch: width < 1080,
  });
  await context.addInitScript((cwd) => {
    localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd }));
  }, cwd);
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  if (preferences || noProject)
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      if (preferences) Object.assign(data.preferences, preferences);
      if (noProject) data.projects = [];
      await route.fulfill({ response, json: data });
    });
  await page.goto(url);
  if (url !== local) {
    await page.locator('#code').fill(code);
    await page.getByRole('button', { name: 'Ouvrir le studio' }).click();
  }
  await expect(page.locator('#connection-label')).toHaveText('Moteur connecté');
  if (width <= 1080) await page.locator('#toggle-details').click();
  await page.locator('#inspector-tab-files').click();
  await expect(page.locator('#inspector-files')).toBeVisible();
  return context;
}

async function assertFits() {
  const dimensions = await page.locator('.inspector-files-toolbar').evaluate((toolbar) => ({
    width: toolbar.clientWidth,
    content: toolbar.scrollWidth,
    buttons: [...toolbar.querySelectorAll('button')]
      .filter((button) => !button.hidden)
      .map((button) => {
        const box = button.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }),
  }));
  assert.ok(dimensions.content <= dimensions.width + 1, JSON.stringify(dimensions));
  for (const button of dimensions.buttons)
    assert.ok(button.left >= 0 && button.right <= page.viewportSize().width, JSON.stringify(dimensions));
}

try {
  browser = await launchStudioBrowser({ channel: 'chrome' });
  for (const width of [1440, 390, 320]) {
    const context = await openPage({ width });
    const button = page.locator('#open-project-folder');
    await expect(button).toHaveAccessibleName('Ouvrir le dossier');
    await expect(button).toBeEnabled();
    await expect(button.locator('svg')).toHaveCount(1);
    await assertFits();
    const before = opened.length;
    await button.click();
    await expect(page.locator('#toasts')).toContainText('Ouverture demandée sur le PC');
    assert.deepEqual(opened.slice(before), [cwd]);
    await page.screenshot({ path: `test-results/inspector-folder-${width}.png`, animations: 'disabled' });
    if (width === 1440) {
      await page.locator('#toasts').evaluate((element) => element.replaceChildren());
      let release;
      completeOpen = () => new Promise((done) => (release = done));
      await button.click();
      await expect(button).toBeDisabled();
      await expect.poll(() => typeof release).toBe('function');
      await button.evaluate((element) => element.click());
      assert.equal(opened.length, before + 2, 'Pending opens must not be duplicated');
      await page.locator('.project-row').filter({ hasText: 'Projet suivant' }).click();
      await expect(page.locator('#detail-project-name')).toHaveText('Projet suivant');
      release({ opened: true });
      await expect(button).toBeEnabled();
      assert.equal(await page.locator('#toasts .toast').count(), 0, 'Ignore feedback for the former project');
      completeOpen = async () => ({ opened: true });
      await button.click();
      await expect(page.locator('#toasts')).toContainText('Ouverture demandée sur le PC');
      assert.equal(opened.at(-1), otherCwd, 'Open the newly selected project');
      completeOpen = async () => {
        throw new Error('Ouverture impossible pour ce dossier');
      };
      await button.click();
      await expect(page.locator('#toasts .toast.error')).toContainText('Ouverture impossible');
      await expect(button).toBeEnabled();
      completeOpen = async () => ({ opened: true });
      await page.evaluate(async () => (await import('/public/i18n.js')).setLanguage('en'));
      await expect(button).toHaveAccessibleName('Open folder');
      await assertFits();
    }
    await context.close();
  }
  for (const readOnly of [false, true]) {
    const gateway = createLanGateway({
      host: '127.0.0.1',
      upstreamPort: app.server.address().port,
      config: { salt, codeHash: hashAccessCode(code, salt), readOnly },
    });
    gateways.push(gateway);
    await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${gateway.address().port}`;
    const context = await openPage({ width: 320, url });
    const button = page.locator('#open-project-folder');
    const before = opened.length;
    if (readOnly) {
      await expect(button).toBeHidden();
      assert.equal((await context.request.post(url + '/api/projects/open', { data: { cwd } })).status(), 405);
      assert.equal(opened.length, before);
    } else {
      await expect(button).toHaveAccessibleName('Ouvrir le dossier sur le PC');
      await assertFits();
      await button.click();
      await expect(page.locator('#toasts')).toContainText('Ouverture demandée sur le PC');
      assert.deepEqual(opened.slice(before), [cwd]);
      await page.screenshot({ path: 'test-results/inspector-folder-remote-320.png', animations: 'disabled' });
    }
    await context.close();
  }
  for (const options of [{ preferences: { nativeFileOpen: false } }, { noProject: true }]) {
    const context = await openPage(options);
    const button = page.locator('#open-project-folder');
    const before = opened.length;
    if (options.noProject) await expect(button).toBeDisabled();
    else await expect(button).toBeHidden();
    await button.evaluate((element) => element.click());
    assert.equal(opened.length, before);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      widths: [1440, 390, 320],
      local: true,
      remote: true,
      readOnly: true,
      navigation: true,
      duplicateClicks: true,
      errors: true,
      noProject: true,
    }),
  );
} catch (error) {
  await page?.screenshot({ path: 'test-results/inspector-folder-failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  for (const gateway of gateways) {
    gateway.closeAllConnections();
    await new Promise((done) => gateway.close(done));
  }
  await app.close();
  assert.equal(dirname(temp), resolve(tmpdir()));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
