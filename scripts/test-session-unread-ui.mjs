// Focused UI regression for Mark as unread: short active conversation,
// background conversation, persistence across reload, sidebar + wheel.
// Isolated fixture only. No real Prime Agent is started.
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-studio-unread-ui-'));
const cwd = join(root, 'Atelier');
const sessionDir = join(root, 'sessions');
const agentHome = join(root, 'agent');
await Promise.all([cwd, sessionDir, agentHome].map((p) => mkdir(p, { recursive: true })));
const entries = new Map();
let serial = 0;
async function message(id, role, text) {
  const entry = {
    type: 'message',
    id: `m-${++serial}`,
    parentId: entries.get(id) || null,
    message: {
      role,
      content: text,
      timestamp: Date.now(),
      stopReason: role === 'assistant' ? 'stop' : undefined,
    },
  };
  entries.set(id, entry.id);
  await appendFile(join(sessionDir, id + '.jsonl'), JSON.stringify(entry) + '\n');
}
async function session(id, title, answer) {
  await writeFile(
    join(sessionDir, id + '.jsonl'),
    JSON.stringify({ type: 'session', id, cwd, timestamp: new Date().toISOString() }) + '\n',
  );
  await message(id, 'user', title);
  await message(id, 'assistant', answer);
}
await session('active-short', 'Courte active', 'Reponse courte.');
await session('background', 'Arriere plan', 'Autre reponse courte.');

const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/luna', name: 'Luna', provider: 'fixture' }],
    default: { model: 'fixture/luna' },
  }),
  async start() {
    throw new Error('no runs in unread fixture');
  },
  async close() {},
};
const app = createApp({ runtime, sessionDir, agentHome, dataDir: join(root, 'data'), initialCwd: cwd });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const errors = [];
const checks = [];
let browser;
let page;
async function refresh() {
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}
async function openSidebarSession(id) {
  await page.locator(`.session-row[data-session-id="${id}"] .session-select`).click();
  await expect(page.locator('#messages')).toBeVisible();
  await expect(page.locator('#conversation-loading')).toBeHidden();
}
async function markUnreadViaMenu(id) {
  await page.locator(`.session-row[data-session-id="${id}"]`).hover();
  const more = page.locator(`.session-row[data-session-id="${id}"] .session-more`);
  await more.click();
  await expect(page.locator('#session-menu')).toBeVisible();
  await page.locator('#session-menu button[data-action="unread"]').click();
}
try {
  browser = await launchStudioBrowser({ channel: 'chrome' });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connect');
  await openSidebarSession('active-short');
  const scrollable = await page
    .locator('#conversation-scroll')
    .evaluate((n) => n.scrollHeight - n.clientHeight);
  checks.push(
    `Short active conversation scrollable overflow: ${scrollable}px (must stay unread without scrolling)`,
  );
  await expect(page.locator('.session-row[data-session-id="active-short"]')).toHaveAttribute(
    'data-activity',
    'idle',
  );
  await page.locator('#composer').fill('Brouillon a conserver');
  await markUnreadViaMenu('active-short');
  await expect(page.locator('#project-overview')).toBeVisible();
  await expect(page.locator('.session-row[data-session-id="active-short"]')).toHaveAttribute(
    'data-activity',
    'unread',
  );
  checks.push(
    'Short active conversation stays unread after menu action and leaves reading view via project overview',
  );
  const drafts = await page.evaluate(() => JSON.parse(localStorage.getItem('prime-studio.drafts') || '{}'));
  expect(JSON.stringify(drafts)).toContain('Brouillon a conserver');
  checks.push('Composer draft preserved across overview navigation');
  await refresh();
  await expect(page.locator('.session-row[data-session-id="active-short"]')).toHaveAttribute(
    'data-activity',
    'unread',
  );
  checks.push('Background refresh does not re-read the active-marked conversation');
  const overviewVisible = await page.locator('#project-overview').isVisible();
  expect(overviewVisible).toBe(true);
  await markUnreadViaMenu('background');
  await expect(page.locator('#project-overview')).toBeVisible();
  await expect(page.locator('.session-row[data-session-id="background"]')).toHaveAttribute(
    'data-activity',
    'unread',
  );
  checks.push('Background conversation marks unread without navigating away from overview');
  await page.keyboard.down('Alt');
  await expect(page.locator('#session-wheel')).toBeVisible();
  await expect(page.locator('.session-wheel-item[data-session-id="active-short"]')).toHaveAttribute(
    'data-activity',
    'unread',
  );
  await expect(page.locator('.session-wheel-item[data-session-id="background"]')).toHaveAttribute(
    'data-activity',
    'unread',
  );
  checks.push('Sidebar and Alt wheel share the same unread state');
  await page.keyboard.up('Alt');
  await page.reload();
  await expect(page.locator('.session-row[data-session-id="active-short"]')).toHaveAttribute(
    'data-activity',
    'unread',
  );
  await expect(page.locator('.session-row[data-session-id="background"]')).toHaveAttribute(
    'data-activity',
    'unread',
  );
  checks.push('Unread persists across reload for both conversations');
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  console.error(error);
  await mkdir(resolve('test-results'), { recursive: true }).catch(() => {});
  await page
    ?.screenshot({ path: resolve('test-results/session-unread-failure.png'), animations: 'disabled' })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('prime-studio-unread-ui-'))
    throw new Error('Unexpected cleanup dir.');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
