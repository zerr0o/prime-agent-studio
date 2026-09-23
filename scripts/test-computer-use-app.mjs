// True app integration smoke for Computer Use. Real createApp plus fake runtime and fake driver.
// Temp dirs and ephemeral port only. No real desktop driver, no installed daemon.
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-computer-use-app-'));
const sessionDir = join(temp, 'sessions'),
  cwd = join(temp, 'Atelier'),
  dataDir = join(temp, 'data'),
  agentHome = join(temp, 'agent');
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
await writeFile(
  join(sessionDir, 'session-b.jsonl'),
  [
    { type: 'session', id: 'session-b', version: 3, cwd, timestamp: stamp },
    { type: 'message', id: 'b-u1', parentId: null, message: { role: 'user', content: 'Session B' } },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);

const driverCalls = [];
const fakeDriver = () => ({
  request: async (command) => {
    driverCalls.push(command);
    return { ok: true };
  },
  stop: async () => {},
  close: async () => {},
});

const runBodies = [];
let serial = 0;
const handles = new Set();
const runtime = {
  getStatus: async () => ({ version: 'fixture', available: true, cli: 'fixture' }),
  async getModels() {
    return {
      models: [{ id: 'test/vision', name: 'Vision Fixture', provider: 'test', input: ['text', 'image'] }],
      default: { model: 'test/vision', thinking: 'low' },
    };
  },
  async start(input) {
    const index = ++serial;
    const id = input.sessionId || `session-app-${index}`;
    const file = join(sessionDir, `${id}.jsonl`);
    try {
      await readFile(file, 'utf8');
    } catch {
      await writeFile(
        file,
        JSON.stringify({
          type: 'session',
          id,
          version: 3,
          cwd: input.cwd,
          timestamp: new Date().toISOString(),
        }) + '\n',
      );
    }
    await appendFile(
      file,
      JSON.stringify({
        type: 'message',
        id: `user-${index}`,
        parentId: null,
        message: { role: 'user', content: input.message, timestamp: Date.now() },
      }) + '\n',
    );
    let complete;
    let finished = false;
    const done = new Promise((r) => (complete = r));
    const timers = [];
    const send = (e) => {
      if (!finished) input.onEvent(e);
    };
    const finish = async (status) => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      const result = { kind: 'done', sessionId: id, status, code: status === 'completed' ? 0 : null };
      input.onEvent(result);
      complete(result);
      handles.delete(handle);
    };
    const handle = { sessionId: id, done, cancel: () => finish('stopped') };
    handles.add(handle);
    timers.push(setTimeout(() => send({ kind: 'session', sessionId: id, cwd: input.cwd }), 40));
    timers.push(setTimeout(() => send({ kind: 'message_start', role: 'assistant' }), 120));
    timers.push(setTimeout(() => send({ kind: 'text', delta: 'Working with the desktop. ' }), 300));
    timers.push(setTimeout(() => void finish('completed'), 4000));
    return handle;
  },
  async close() {
    await Promise.all([...handles].map((h) => h.cancel()));
  },
};

const app = createApp({
  runtime,
  agentHome,
  sessionDir,
  dataDir,
  initialCwd: cwd,
  computerDriver: fakeDriver,
});
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${app.server.address().port}`;
const shotDir = resolve('test-results', 'computer-use');
await mkdir(shotDir, { recursive: true });
let browser;
const report = [];
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1512, height: 982 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const computerStopCalls = [];
  await page.route('**/api/runs', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      try {
        runBodies.push(JSON.parse(req.postData() || '{}'));
      } catch {}
    }
    await route.continue();
  });
  await page.route('**/api/computer-use/stop', async (route) => {
    computerStopCalls.push({ method: route.request().method() });
    await route.continue();
  });
  await page.goto(url);
  await expect(page.locator('#connection-label')).not.toHaveText('Connexion…');
  await expect(page.locator('#project-list')).toContainText('Atelier');
  await expect(page.locator('#computer-use')).toBeVisible();
  await expect(page.locator('#computer-use-toggle')).toBeEnabled();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  report.push('Real header control visible, default off');

  // Draft activation on a new session sends computerUse true on the real route.
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#allow-computer-use')).not.toBeChecked();
  await expect(page.locator('label:has(#allow-computer-use)')).toContainText('Autoriser le Computer Use');
  await page.locator('#allow-computer-use').click();
  await expect(page.locator('#allow-computer-use')).toBeChecked();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#computer-use-status')).toHaveText('Actif au prochain envoi');
  await page.locator('#composer').fill('Please use the desktop.');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  const draftBody = runBodies[runBodies.length - 1];
  if (draftBody?.computerUse !== true) throw new Error('draft send must carry computerUse true');
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#computer-use-stop')).toBeVisible();
  report.push('Draft activation carries computerUse true on POST /api/runs');
  await page.screenshot({
    path: join(shotDir, 'computer-use-app-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });

  // Computer stop is separate from agent cancellation.
  await page.locator('#computer-use-stop').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#computer-use-stop')).toBeHidden();
  if (!computerStopCalls.length) throw new Error('computer stop must call dedicated stop route');
  await expect(page.locator('#stop-button')).toBeVisible();
  report.push('Computer stop separate from agent stop');
  await page.locator('#stop-button').click();
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 10000 });

  // Existing session toggle uses the mode route, then switching never leaks.
  await page.locator('#session-list').getByText('Session A', { exact: true }).click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#computer-use-toggle').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#computer-use-status')).toHaveText('Actif sur cette session');
  await page.locator('#session-list').getByText('Session B', { exact: true }).click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#allow-computer-use')).not.toBeChecked();
  await expect(page.locator('#computer-use-status')).toContainText('autre session');
  await page.locator('#composer').fill('Plain message without desktop.');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  const plainBody = runBodies[runBodies.length - 1];
  if (plainBody?.computerUse === true) throw new Error('session switch must not leak computerUse');
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  report.push('Session switch never leaks computerUse into next run');
  await page.locator('#stop-button').click();
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 10000 });

  // New session after a switch carries no stale opt-in.
  await page.keyboard.press('Control+n');
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  report.push('No stale opt-in across sessions');

  const roSalt = 'd'.repeat(32);
  const roCode = '12345678';
  const gateway = createLanGateway({
    host: '127.0.0.1',
    upstreamPort: app.server.address().port,
    config: { salt: roSalt, codeHash: hashAccessCode(roCode, roSalt), readOnly: true },
  });
  await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
  const roContext = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 800 } });
  const roPage = await roContext.newPage();
  roPage.setDefaultTimeout(15000);
  await roPage.goto(`http://127.0.0.1:${gateway.address().port}`);
  await roPage.locator('#code').fill(roCode);
  await roPage.getByRole('button', { name: 'Ouvrir le studio' }).click();
  await roPage.locator('#session-list').getByText('Session A', { exact: true }).click();
  await expect(roPage.locator('#computer-use')).toBeVisible();
  await expect(roPage.locator('#allow-computer-use')).toBeDisabled();
  await expect(roPage.locator('#computer-use-toggle')).toBeDisabled();
  await expect(roPage.locator('#computer-use-warning')).toContainText('Consultation seule');
  await roContext.close();
  await new Promise((done) => gateway.close(done));
  report.push('Read only consultation never mutates');
  if (driverCalls.length) throw new Error('smoke must not drive the real desktop');
  await page.locator('#session-list').getByText('Session A', { exact: true }).click();
  await expect(page.locator('#computer-use-toggle')).toBeEnabled();
  if ((await page.locator('#computer-use-toggle').getAttribute('aria-pressed')) !== 'true')
    await page.locator('#computer-use-toggle').click();
  await expect(page.locator('#allow-computer-use')).toBeChecked();
  await expect(page.locator('#computer-use-stop')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#mobile-backdrop')).toBeHidden();
  await expect(page.locator('#toasts .toast')).toHaveCount(0);
  await expect(page.locator('#computer-use-toggle')).toBeVisible();
  await expect(page.locator('#computer-use-stop')).toBeVisible();
  await expect(page.locator('#allow-computer-use')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const gutterCheck = () =>
    page.evaluate(() => {
      const form = document.getElementById('composer-form');
      const formRect = form.getBoundingClientRect();
      const style = getComputedStyle(form);
      const contentL = formRect.left + (parseFloat(style.paddingLeft) || 0);
      const contentR = formRect.right - (parseFloat(style.paddingRight) || 0);
      return [...document.querySelectorAll('.model-controls .questions-toggle')].map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left - contentL, right: contentR - r.right };
      });
    });
  for (const g of await gutterCheck()) {
    if (g.left < -1 || g.right < -1) throw new Error(`checkbox crosses composer gutter ${JSON.stringify(g)}`);
  }
  await page.screenshot({
    path: join(shotDir, 'computer-use-app-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.locator('#computer-use-toggle')).toBeVisible();
  await expect(page.locator('#computer-use-stop')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  for (const g of await gutterCheck()) {
    if (g.left < -1 || g.right < -1) throw new Error(`320px checkbox crosses gutter ${JSON.stringify(g)}`);
  }
  await page.screenshot({
    path: join(shotDir, 'computer-use-app-mobile-320.png'),
    fullPage: true,
    animations: 'disabled',
  });
  report.push('Desktop and mobile screenshots captured');
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks: report }, null, 2));
} catch (error) {
  console.error(error);
  if (browser) {
    const trouble = browser.contexts()[0]?.pages()[0];
    if (trouble) {
      await mkdir(resolve('test-results'), { recursive: true });
      await trouble
        .screenshot({
          path: resolve('test-results', 'computer-use', 'computer-use-app-failure.png'),
          fullPage: true,
          animations: 'disabled',
        })
        .catch(() => {});
    }
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
  const cleanupPath = resolve(temp);
  const tempRoot = resolve(tmpdir());
  if (!cleanupPath.startsWith(tempRoot + sep) || !basename(cleanupPath).startsWith('prime-computer-use-app-'))
    throw new Error('Unrecognized test directory, cleanup refused.');
  await rm(cleanupPath, { recursive: true, force: true });
}
