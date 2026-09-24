import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-terminal-ui-'));
const cwd = join(root, 'Atelier');
const selected = join(root, 'Projet annexe');
await Promise.all([cwd, selected].map((path) => mkdir(path, { recursive: true })));
const opened = [];
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
  openTerminal: async (path) => {
    opened.push(path);
    return { opened: true };
  },
});
await app.store.project({ cwd: selected, name: 'Annexe' });
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
let browser;
const errors = [];

async function newPage({ windows = true } = {}) {
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  if (!windows) {
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.preferences = { ...data.preferences, openTerminal: false };
      await route.fulfill({ response, json: data });
    });
  }
  await page.goto(url);
  await expect(page.locator('.project-more').first()).toBeVisible();
  return page;
}

async function waitForOpened(count) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (opened.length >= count) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`Timed out waiting for ${count} terminal request(s).`);
}

try {
  browser = await chromium.launch({
    channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome',
    headless: true,
  });

  const page = await newPage();
  await page.locator('.project-header', { hasText: 'Annexe' }).locator('.project-more').click();
  await expect(page.locator('#project-menu')).toBeVisible();
  const terminal = page.locator('#project-menu [data-project-action="terminal"]');
  await expect(terminal).toBeVisible();
  await expect(terminal).toContainText('Ouvrir PowerShell ici');
  await page.screenshot({ path: '.local/terminal-powershell-menu.png' });
  await terminal.click();
  await waitForOpened(1);
  expect(opened).toEqual([selected]);
  await expect(page.locator('#toasts')).toContainText('PowerShell ouvert sur le PC.');
  await page.close();

  const other = await newPage();
  await other.locator('.project-header', { hasText: 'Atelier' }).locator('.project-more').click();
  await expect(other.locator('#project-menu')).toBeVisible();
  await other.locator('#project-menu [data-project-action="terminal"]').click();
  await waitForOpened(2);
  expect(opened).toEqual([selected, cwd]);
  await other.close();

  const legacy = await newPage({ windows: false });
  await legacy.locator('.project-header', { hasText: 'Atelier' }).locator('.project-more').click();
  await expect(legacy.locator('#project-menu')).toBeVisible();
  await expect(legacy.locator('#project-menu [data-project-action="terminal"]')).toBeHidden();
  await legacy.close();

  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, windowsMenu: true, postedCwd: true, nonWindowsHidden: true }));
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
