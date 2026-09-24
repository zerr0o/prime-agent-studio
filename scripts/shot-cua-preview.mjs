// CUA selector preview screenshots from the ACTUAL styled Studio app (FR).
// Fake runtime + fake desktop driver + fake CUA availability. No real
// desktop input, no enable POST. Selects CUA while off (local only).
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { createApp } from '../server.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-cua-preview-'));
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

const fakeDriver = () => ({
  request: async () => ({ ok: true }),
  stop: async () => {},
  close: async () => {},
});
const runtime = {
  getStatus: async () => ({ version: 'fixture', available: true, cli: 'fixture' }),
  async getModels() {
    return {
      models: [{ id: 'test/vision', name: 'Vision Fixture', provider: 'test', input: ['text', 'image'] }],
      default: { model: 'test/vision', thinking: 'low' },
    };
  },
  async start(input) {
    let finished = false;
    let complete;
    const done = new Promise((r) => (complete = r));
    const finish = async (status) => {
      if (finished) return;
      finished = true;
      const result = { kind: 'done', sessionId: input.sessionId || 'session-a', status, code: 0 };
      input.onEvent(result);
      complete(result);
    };
    setTimeout(
      () => input.onEvent({ kind: 'session', sessionId: input.sessionId || 'session-a', cwd: input.cwd }),
      20,
    );
    setTimeout(() => void finish('completed'), 60000);
    const handle = { sessionId: input.sessionId || 'session-a', done, cancel: () => finish('stopped') };
    return handle;
  },
  async close() {},
};

const app = createApp({
  runtime,
  agentHome,
  sessionDir,
  dataDir,
  initialCwd: cwd,
  computerDriver: fakeDriver,
  cuaAvailability: { available: true, supported: true, version: '0.28.2' },
});
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${app.server.address().port}`;
const outDir = resolve('test-results', 'cua-integration');
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
  await expect(page.locator('#computer-use-backend-cua')).toBeEnabled();
  // Select CUA while off: local choice only, never enables desktop control.
  await page.locator('#computer-use-backend-cua').click();
  await expect(page.locator('#computer-use-backend-cua')).toBeChecked();
  await expect(page.locator('#computer-use-backend-native-label')).toContainText('ration originale');
  await expect(page.locator('#computer-use-backend-cua-label')).toContainText('Cua Driver (beta)');
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({
    path: join(outDir, 'ui-preview-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.locator('#computer-use-details').screenshot({
    path: join(outDir, 'ui-preview-menu.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.locator('#toggle-details').click();
  await expect(page.locator('#computer-use-details')).toBeVisible();
  await expect(page.locator('#computer-use-backend-cua')).toBeChecked();
  await page.screenshot({
    path: join(outDir, 'ui-preview-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  // Orphan cleanup failure: fake only the status payload (no real input).
  // Toggle stays off with an independent Stop plus a truthful retry message.
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.route('**/api/computer-use*', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      const res = await route.fetch();
      const payload = await res.json();
      payload.owner = null;
      payload.enabled = false;
      payload.busy = false;
      payload.cleanupPending = false;
      payload.cleanupFailed = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    } else {
      await route.continue();
    }
  });
  await page.reload();
  await expect(page.locator('#connection-label')).not.toHaveText('Connexion…');
  await page.locator('#session-list').getByText('Session A', { exact: true }).click();
  await expect(page.locator('#computer-use-stop')).toBeVisible();
  await expect(page.locator('#computer-use-stop')).toBeEnabled();
  await expect(page.locator('#computer-use-warning')).toContainText('Nettoyage incomplet');
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({
    path: join(outDir, 'ui-preview-cleanup.png'),
    fullPage: true,
    animations: 'disabled',
  });
  console.log('CUA preview screenshots captured');
} finally {
  await browser?.close();
  await app.close();
  const cleanupPath = resolve(temp);
  const tempRoot = resolve(tmpdir());
  if (!cleanupPath.startsWith(tempRoot + sep) || !basename(cleanupPath).startsWith('prime-cua-preview-'))
    throw new Error('Unrecognized test directory, cleanup refused.');
  await rm(cleanupPath, { recursive: true, force: true });
}
