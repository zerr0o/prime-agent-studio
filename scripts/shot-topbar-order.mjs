// Top bar order screenshots (FR): real Studio app, fake runtime/driver.
// Usage: node scripts/shot-topbar-order.mjs --server <path-to-server.mjs> --tag before|after
// Saves full page + header crops to test-results/topbar-order/ (desktop 1512px, mobile 390px).
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const serverPath = args.get('--server');
const tag = args.get('--tag') || 'after';
if (!serverPath) throw new Error('missing --server <path-to-server.mjs>');
const { createApp } = await import(pathToFileURL(serverPath).href);

const temp = await mkdtemp(join(tmpdir(), 'prime-topbar-order-'));
const sessionDir = join(temp, 'sessions');
const cwd = join(temp, 'Atelier');
const dataDir = join(temp, 'data');
const agentHome = join(temp, 'agent');
await Promise.all([
  mkdir(sessionDir, { recursive: true }),
  mkdir(cwd, { recursive: true }),
  mkdir(agentHome, { recursive: true }),
]);
const stamp = new Date().toISOString();
await writeFile(
  join(sessionDir, 'session-a.jsonl'),
  [
    { type: 'session', id: 'session-a', version: 3, cwd, timestamp: stamp },
    { type: 'message', id: 'a-u1', parentId: null, message: { role: 'user', content: 'Session A' } },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);

const runtime = {
  getStatus: async () => ({ version: 'fixture', available: true, cli: 'fixture' }),
  async getModels() {
    return {
      models: [{ id: 'test/vision', name: 'Vision Fixture', provider: 'test', input: ['text', 'image'] }],
      default: { model: 'test/vision', thinking: 'low' },
    };
  },
  async start() {
    return { sessionId: 'session-a', done: new Promise(() => {}), cancel: () => {} };
  },
  async close() {},
};
const fakeDriver = () => ({ request: async () => ({ ok: true }), stop: async () => {}, close: async () => {} });

const app = createApp({ runtime, agentHome, sessionDir, dataDir, initialCwd: cwd, computerDriver: fakeDriver });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${app.server.address().port}`;
const outDir = resolve('test-results', 'topbar-order');
await mkdir(outDir, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1512, height: 982 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(url);
  await expect(page.locator('#connection-label')).not.toHaveText('Connexion…');
  await page.locator('#session-list').getByText('Session A', { exact: true }).click();
  await expect(page.locator('#computer-use')).toBeVisible();
  await expect(page.locator('#open-roadmap')).toBeEnabled();
  await page.locator('#computer-use-toggle').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => {
    const state = document.getElementById('session-state');
    if (state) {
      state.hidden = false;
      state.textContent = 'Agent en cours';
    }
  });
  const order = await page.evaluate(() =>
    [...document.querySelector('.header-actions').children].map((el) => el.id || el.className),
  );
  const overflowDesktop = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.locator('.workspace-header').screenshot({ path: join(outDir, `${tag}-topbar-desktop-header.png`) });
  await page.screenshot({ path: join(outDir, `${tag}-topbar-desktop.png`), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflowMobile = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.locator('.workspace-header').screenshot({ path: join(outDir, `${tag}-topbar-mobile-header.png`) });
  await page.screenshot({ path: join(outDir, `${tag}-topbar-mobile.png`), animations: 'disabled' });
  console.log(JSON.stringify({ tag, order, overflowDesktop, overflowMobile }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close().catch(() => {});
  const cleanupPath = resolve(temp);
  const tempRoot = resolve(tmpdir());
  if (!cleanupPath.startsWith(tempRoot + sep) || !basename(cleanupPath).startsWith('prime-topbar-order-'))
    throw new Error('Unrecognized test directory, cleanup refused.');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(cleanupPath, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
