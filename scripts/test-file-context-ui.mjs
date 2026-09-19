// Isolated real server; desktop folder launches are captured, never opened.
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';

const root = await mkdtemp(join(tmpdir(), 'studio-file-menu-'));
const cwd = join(root, 'project');
await mkdir(join(cwd, 'docs'), { recursive: true });
await mkdir(join(root, 'outside'));
await writeFile(join(cwd, 'docs', 'notes.txt'), 'Notes');
await writeFile(
  join(cwd, 'docs', 'image.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
    'base64',
  ),
);
await symlink(join(root, 'outside'), join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
await promisify(execFile)('git', ['-C', cwd, 'init', '-q']);
const opened = [];
const app = createApp({
  initialCwd: cwd,
  agentHome: join(root, 'agent'),
  sessionDir: join(root, 'sessions'),
  dataDir: join(root, 'data'),
  openDirectory: async (path) => {
    opened.push(path);
    return { opened: true };
  },
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({
      models: [{ id: 'fixture/demo', name: 'Demo', provider: 'fixture' }],
      default: { model: 'fixture/demo' },
    }),
    async close() {},
  },
});
await app.store.project({ cwd });
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
let browser;
try {
  const post = (path) =>
    fetch(url + '/api/projects/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ cwd, path }),
    });
  // A nested folder is allowed; traversal, private paths and symlinks out are not.
  expect((await post('docs')).status).toBe(200);
  expect(opened.pop()).toBe(await realpath(join(cwd, 'docs')));
  for (const path of ['../outside', '.git', 'escape', '/absolute', 'docs/notes.txt', 'missing']) {
    expect((await post(path)).status).toBeGreaterThanOrEqual(400);
  }
  expect(opened).toEqual([]);
  expect((await post('')).status).toBe(200);
  expect(opened.pop()).toBe(await realpath(cwd));
  browser = await chromium.launch({
    channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome',
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    locale: 'fr-FR',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let readOnly = false;
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.preferences = { ...body.preferences, readOnly, nativeFileOpen: true };
    await route.fulfill({ response, json: body });
  });
  await page.goto(url);
  if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
  await page.getByRole('tab', { name: 'Fichiers', exact: true }).click();
  await page.locator('#files-changes').click();
  const image = page.locator('[data-file-path="docs/image.png"]');
  await expect(image).toBeVisible();
  await image.click();
  await expect(page.locator('#inspector-viewer')).toBeVisible();
  await expect(page.locator('.inspector-preview-image')).toBeVisible();
  await expect(
    page.locator('#inspector-viewer').getByRole('button', { name: 'Contenu', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  const menu = page.locator('.inspector-file-menu');
  await image.click({ button: 'right' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Ouvrir', 'Ouvrir le dossier', 'Copier le chemin']);
  await menu.getByRole('menuitem', { name: 'Copier le chemin', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(join(cwd, 'docs', 'image.png'));
  await image.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Ouvrir le dossier', exact: true }).click();
  await expect.poll(() => opened.length).toBe(1);
  expect(opened.pop()).toBe(await realpath(join(cwd, 'docs')));
  await image.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(image).toBeFocused();
  await expect(page.locator('#details-panel')).toBeVisible();
  await image.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Ouvrir', exact: true }).click();
  await expect(page.locator('.inspector-preview-image')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#files-all').click();
  await page.locator('[data-file-path="docs"]').click();
  await image.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Ouvrir', exact: true }).click();
  await expect(page.locator('.inspector-preview-image')).toBeVisible();
  await page.keyboard.press('Escape');
  // Mobile menu stays inside the viewport, and Escape leaves the panel open.
  await page.setViewportSize({ width: 390, height: 844 });
  if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
  await image.click({ button: 'right' });
  const box = await menu.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  await page.keyboard.press('Escape');
  await expect(page.locator('#details-panel')).toBeVisible();
  // Consultation cannot launch an OS action but can preview/copy a file.
  readOnly = true;
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
  await page.getByRole('tab', { name: 'Fichiers', exact: true }).click();
  await page.locator('#files-changes').click();
  await image.click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Ouvrir le dossier sur le PC', exact: true })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: 'Ouvrir', exact: true })).toBeEnabled();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  expect(errors).toEqual([]);
  console.log(
    'File context menu PASS: image content, native containing folder, copy full path, keyboard, mobile, read-only and safe paths',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
