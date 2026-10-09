import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-folder-ui-'));
const cwd = join(root, 'Atelier'),
  selected = join(root, "Projet é & [notes], l'atelier");
await Promise.all([cwd, selected, '.local'].map((path) => mkdir(path, { recursive: true })));
const httpCalls = [];
const app = createApp({
  initialCwd: cwd,
  agentHome: join(root, 'agent'),
  sessionDir: join(root, 'sessions'),
  dataDir: join(root, 'data'),
  runtime: {
    getStatus: async () => ({ available: true }),
    getModels: async () => ({ models: [] }),
    close: async () => {},
  },
  directoryPicker: {
    pick: async (input) =>
      new Promise((done, reject) => {
        const call = { ...input, done, reject, aborted: false };
        httpCalls.push(call);
        input.signal?.addEventListener(
          'abort',
          () => {
            call.aborted = true;
            done({ cwd: null });
          },
          { once: true },
        );
      }),
    close: () => httpCalls.forEach((call) => call.done({ cwd: null })),
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
let browser;
const errors = [];

async function newPage({ desktop = false, capability = false, remote = false } = {}) {
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  await context.addInitScript(
    ({ desktop, capability }) => {
      window.__folderPickerFixture = { calls: [], pending: [] };
      if (desktop) window.__PRIME_STUDIO_DESKTOP__ = true;
      if (capability) window.__PRIME_STUDIO_DIRECTORY_PICKER__ = true;
      window.__TAURI__ = {
        core: {
          invoke: (command, input) => {
            const fixture = window.__folderPickerFixture;
            fixture.calls.push({ command, input });
            return new Promise((done, reject) => fixture.pending.push({ done, reject }));
          },
        },
      };
    },
    { desktop, capability },
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  if (remote) {
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.preferences = { ...data.preferences, remote: true, readOnly: false };
      await route.fulfill({ response, json: data });
    });
  }
  await page.goto(url);
  await page.locator('#add-project').click();
  await expect(page.locator('#project-dialog')).toBeVisible();
  return page;
}

async function fillProject(page) {
  await page.locator('#project-cwd').fill(cwd);
  await page.locator('#project-name').fill('Mon nom personnalisé');
}

async function expectBusy(page, busy) {
  const browse = page.locator('#project-browse');
  const submit = page.locator('#project-submit');
  if (busy) {
    await expect(browse).toBeDisabled();
    await expect(browse).toHaveAttribute('aria-busy', 'true');
    await expect(submit).toBeDisabled();
  } else {
    await expect(browse).toBeEnabled();
    await expect(browse).not.toHaveAttribute('aria-busy', 'true');
    await expect(submit).toBeEnabled();
  }
}

async function closeAndReopen(page) {
  await page.locator('#project-dialog [data-close-dialog]').first().click();
  await expect(page.locator('#project-dialog')).toBeHidden();
  await page.locator('#add-project').click();
  await fillProject(page);
  await expectBusy(page, false);
}

async function completeNative(page, index, { value = null, error } = {}) {
  await page.evaluate(
    async ({ index, value, error }) => {
      const request = window.__folderPickerFixture.pending[index];
      if (error) request.reject(error);
      else request.done(value);
      // Let the real event handler finish its promise chain before checking stale state.
      await new Promise((done) => requestAnimationFrame(() => done()));
    },
    { index, value, error },
  );
}

const nativeCalls = (page) => page.evaluate(() => window.__folderPickerFixture.calls);

try {
  browser = await launchStudioBrowser({ channel: 'chrome' });

  const page = await newPage();
  await expect(page.locator('#project-browse')).toBeVisible();
  await fillProject(page);
  await page.locator('#project-browse').click();
  await expect.poll(() => httpCalls.length).toBe(1);
  await expectBusy(page, true);
  await page.locator('#project-browse').dispatchEvent('click');
  httpCalls[0].done({ cwd: null });
  await expectBusy(page, false);
  expect(httpCalls.length).toBe(1);
  await expect(page.locator('#project-cwd')).toHaveValue(cwd);
  await expect(page.locator('#project-name')).toHaveValue('Mon nom personnalisé');

  await page.locator('#project-browse').click();
  await expect.poll(() => httpCalls.length).toBe(2);
  httpCalls[1].done({ cwd: selected });
  await expect(page.locator('#project-cwd')).toHaveValue(selected);
  await expect(page.locator('#project-name')).toHaveValue('Mon nom personnalisé');
  await page.screenshot({ path: '.local/project-folder-desktop.png' });

  await page.locator('#project-browse').click();
  await expect.poll(() => httpCalls.length).toBe(3);
  httpCalls[2].reject(
    Object.assign(
      new Error('Impossible de sélectionner le dossier sur le PC. Réessayez ou saisissez son chemin.'),
      {
        status: 502,
      },
    ),
  );
  await expect(page.locator('#project-error')).toBeVisible();
  await expectBusy(page, false);
  await page.locator('#project-browse').click();
  await expect.poll(() => httpCalls.length).toBe(4);
  await closeAndReopen(page);
  await expect.poll(() => httpCalls[3].aborted).toBe(true);
  await expect(page.locator('#project-error')).toBeHidden();
  await page.locator('#project-browse').click();
  await expect.poll(() => httpCalls.length).toBe(5);
  await expectBusy(page, true);
  httpCalls[4].done({ cwd: null });
  await expectBusy(page, false);
  await expect(page.locator('#project-cwd')).toHaveValue(cwd);
  expect(await nativeCalls(page)).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.local/project-folder-narrow.png' });
  const dialog = await page.locator('#project-dialog').boundingBox();
  const button = await page.locator('#project-browse').boundingBox();
  expect(button.x + button.width).toBeLessThanOrEqual(dialog.x + dialog.width);
  await page.locator('#project-name').fill('Nouveau projet');
  await page.locator('#project-cwd').fill(selected);
  await page.locator('#project-submit').click();
  await expect(page.locator('#project-dialog')).toBeHidden();
  expect((await app.store.findProject(selected)).name).toBe('Nouveau projet');
  await page.close();

  const native = await newPage({ desktop: true, capability: true });
  const httpBeforeNative = httpCalls.length;
  await fillProject(native);
  await native.locator('#project-browse').click();
  await expect.poll(async () => (await nativeCalls(native)).length).toBe(1);
  const [firstNative] = await nativeCalls(native);
  expect(firstNative.command).toBe('desktop_pick_directory');
  expect(firstNative.input.cwd).toBe(cwd);
  expect(typeof firstNative.input.title).toBe('string');
  expect(firstNative.input.title.length).toBeGreaterThan(0);
  await expectBusy(native, true);
  await native.locator('#project-browse').dispatchEvent('click');
  expect((await nativeCalls(native)).length).toBe(1);
  await completeNative(native, 0);
  await expectBusy(native, false);
  await expect(native.locator('#project-cwd')).toHaveValue(cwd);
  await expect(native.locator('#project-name')).toHaveValue('Mon nom personnalisé');

  await native.locator('#project-browse').click();
  await completeNative(native, 1, { error: 'picker_failed' });
  await expect(native.locator('#project-error')).toBeVisible();
  await expect(native.locator('#project-error')).not.toContainText('picker_failed');
  await expectBusy(native, false);
  expect(httpCalls.length).toBe(httpBeforeNative);
  await native.locator('#project-browse').click();
  await completeNative(native, 2, { value: selected });
  await expect(native.locator('#project-cwd')).toHaveValue(selected);
  await expect(native.locator('#project-name')).toHaveValue('Mon nom personnalisé');
  await expectBusy(native, false);

  for (const stale of [{ value: selected }, { error: 'picker_failed' }]) {
    const oldIndex = (await nativeCalls(native)).length;
    await native.locator('#project-browse').click();
    await closeAndReopen(native);
    await native.locator('#project-browse').click();
    await expectBusy(native, true);
    await completeNative(native, oldIndex, stale);
    await expect(native.locator('#project-cwd')).toHaveValue(cwd);
    await expect(native.locator('#project-error')).toBeHidden();
    await expectBusy(native, true);
    await completeNative(native, oldIndex + 1);
    await expectBusy(native, false);
  }
  expect(httpCalls.length).toBe(httpBeforeNative);
  await native.close();

  const legacy = await newPage({ desktop: true });
  await fillProject(legacy);
  await legacy.locator('#project-browse').click();
  await expect.poll(() => httpCalls.length).toBe(httpBeforeNative + 1);
  httpCalls.at(-1).done({ cwd: selected });
  await expect(legacy.locator('#project-cwd')).toHaveValue(selected);
  expect(await nativeCalls(legacy)).toEqual([]);
  await legacy.close();

  const remote = await newPage({ desktop: true, capability: true, remote: true });
  await expect(remote.locator('#project-browse')).toBeHidden();
  await remote.locator('#project-browse').dispatchEvent('click');
  expect(await nativeCalls(remote)).toEqual([]);
  expect(httpCalls.length).toBe(httpBeforeNative + 1);
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      passed: true,
      httpCancellation: true,
      immediateReopen: true,
      nativeIpcSelection: true,
      duplicateClickIgnored: true,
      staleResultAndFinallyIgnored: true,
      errorRecoveryWithoutHttpFallback: true,
      legacyDesktopHttpFallback: true,
      remoteIpcBlocked: true,
      projectAdded: true,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
  if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Unexpected fixture path');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
