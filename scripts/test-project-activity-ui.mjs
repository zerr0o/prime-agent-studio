// Isolated histories and manually completed runs; no real Prime Agent is started.
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-studio-activity-'));
const cwd = join(root, 'Atelier'),
  other = join(root, 'Documents');
const sessionDir = join(root, 'sessions'),
  agentHome = join(root, 'agent');
await Promise.all([cwd, other, sessionDir, agentHome].map((path) => mkdir(path)));
const entries = new Map(),
  controls = new Map(),
  checks = [],
  errors = [];
let serial = 0;
async function message(id, role, text, extra = {}) {
  const entry = {
    type: 'message',
    id: `message-${++serial}`,
    parentId: entries.get(id) || null,
    message: { role, content: text, timestamp: Date.now(), ...extra },
  };
  entries.set(id, entry.id);
  await appendFile(join(sessionDir, id + '.jsonl'), JSON.stringify(entry) + '\n');
  return entry.message;
}
async function session(id, directory, title) {
  await writeFile(
    join(sessionDir, id + '.jsonl'),
    JSON.stringify({
      type: 'session',
      id,
      cwd: directory,
      timestamp: new Date().toISOString(),
    }) + '\n',
  );
  await message(id, 'user', title);
  await message(id, 'assistant', 'Réponse déjà présente.', { stopReason: 'stop' });
}
await session('first', cwd, 'Première conversation');
await session('second', cwd, 'Deuxième conversation');
await session('other', other, 'Autre projet');
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/luna', name: 'Luna', provider: 'fixture' }],
    default: { model: 'fixture/luna' },
  }),
  async start(input) {
    const id = input.sessionId;
    await message(id, 'user', input.message);
    let resolveDone,
      finished = false;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const control = {
      done,
      async finish(status = 'completed', text = 'Nouvelle réponse terminée.') {
        if (finished) return;
        finished = true;
        if (status === 'completed') {
          const answer = await message(id, 'assistant', text, { stopReason: 'stop' });
          input.onEvent({ kind: 'message', message: answer });
        }
        const event = { kind: 'done', sessionId: id, status, code: status === 'completed' ? 0 : 130 };
        input.onEvent(event);
        resolveDone(event);
      },
      cancel() {
        return this.finish('stopped');
      },
    };
    controls.set(id, control);
    return control;
  },
  async close() {
    for (const control of controls.values()) await control.cancel();
  },
};
const app = createApp({ runtime, sessionDir, agentHome, dataDir: join(root, 'data'), initialCwd: cwd });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const code = '49283175',
  salt = 'e54d6dd09bb15f7c347b38b671472aa9';
const gateway = createLanGateway({
  host: '127.0.0.1',
  port: 0,
  upstreamPort: app.server.address().port,
  config: { readOnly: true, salt, codeHash: hashAccessCode(code, salt) },
});
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
const phoneUrl = `http://127.0.0.1:${gateway.address().port}`;
let browser, page;
const project = (name = 'Atelier', target = page) => target.locator('.project-row').filter({ hasText: name });
async function refresh(target = page) {
  await target.evaluate(() => window.dispatchEvent(new Event('online')));
}
async function run(id) {
  const response = await fetch(url + '/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({
      cwd: id === 'other' ? other : cwd,
      sessionId: id,
      message: `Travail de test ${serial}`,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  await refresh();
  await expect(project(id === 'other' ? 'Documents' : 'Atelier')).toHaveAttribute('data-activity', 'running');
  return controls.get(id);
}
async function openSession(id, target = page) {
  const row = project(id === 'other' ? 'Documents' : 'Atelier', target);
  if (target.viewportSize().width <= 760) {
    if (!(await target.locator('#sidebar').evaluate((node) => node.classList.contains('mobile-open'))))
      await target.locator('#toggle-sidebar').click();
    // Mobile project rows expand the group; select the conversation inside the drawer.
    const session = target.locator(`.session-row[data-session-id="${id}"] .session-select`);
    if (!(await session.isVisible())) await row.click();
    await session.click();
  } else {
    await row.click();
    await target.locator(`.project-session-card[data-session-id="${id}"]`).click();
  }
  await expect(target.locator('#messages')).toBeVisible();
  await expect(target.locator('#conversation-loading')).toBeHidden();
}
try {
  browser = await launchStudioBrowser({ channel: 'chrome' });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connecté');
  await expect(project()).toHaveAttribute('data-activity', 'idle');
  checks.push('Les anciennes conversations commencent sans faux non-lus');

  const first = await run('first');
  await expect(project().locator('.running-dot')).toBeVisible();
  await expect(project().locator('svg')).toHaveCount(2); // Folder and pin stay visible; activity uses a dot.
  await first.finish();
  await refresh();
  await expect(project()).toHaveAttribute('data-activity', 'unread');
  await expect(project().locator('.unread-dot')).toHaveAttribute('aria-label', 'Réponse terminée non lue');
  await project().click();
  await expect(project()).toHaveAttribute('data-activity', 'unread');
  await expect(page.locator('.project-session-card[data-session-id="first"]')).toContainText(
    'Réponse non lue',
  );
  await mkdir(resolve('test-results'), { recursive: true });
  await page.screenshot({
    path: resolve('test-results/project-activity-desktop.png'),
    animations: 'disabled',
  });
  checks.push(
    'Vert pendant le travail, bleu après la réponse ; ouvrir le projet ne marque pas la réponse comme lue',
  );

  await page.reload();
  await expect(project()).toHaveAttribute('data-activity', 'unread');
  const second = await run('second');
  await expect(project().locator('.unread-dot')).toHaveCount(0);
  await second.finish();
  await refresh();
  await expect(project()).toHaveAttribute('data-activity', 'unread');
  await openSession('first');
  await expect(page.locator('.session-row.active')).toHaveAttribute('data-activity', 'idle');
  await expect(project()).toHaveAttribute('data-activity', 'unread');
  await openSession('second');
  await expect(project()).toHaveAttribute('data-activity', 'idle');
  checks.push(
    'Persistance après rechargement, priorité du vert et plusieurs réponses non lues dans un projet',
  );

  await app.store.patchSession({ id: 'first', title: 'Conversation renommée', pinned: true });
  await refresh();
  await expect(project()).toHaveAttribute('data-activity', 'idle');
  const stopped = await run('first');
  await message(
    'first',
    'assistant',
    [
      { type: 'thinking', thinking: 'Analyse' },
      { type: 'toolCall', id: 'tool', name: 'ipython', arguments: {} },
    ],
    { stopReason: 'toolUse' },
  );
  await stopped.finish('stopped');
  await refresh();
  await expect(project()).toHaveAttribute('data-activity', 'idle');
  checks.push('Les réglages, renommages et outils interrompus ne créent pas de point bleu');

  const live = await run('second');
  await openSession('second');
  await live.finish();
  await expect(page.locator('#messages')).toContainText('Nouvelle réponse terminée.');
  await expect(project()).toHaveAttribute('data-activity', 'idle');
  checks.push('Une réponse suivie en direct reste lue');

  // Complete while the browser is hidden, then check without making the page visible.
  const hiddenRun = await run('second');
  await openSession('second');
  await page.evaluate(() =>
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }),
  );
  await hiddenRun.finish();
  await refresh();
  await expect(project()).toHaveAttribute('data-activity', 'unread');
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(project()).toHaveAttribute('data-activity', 'idle');
  checks.push('Une conversation dans un onglet masqué reste non lue jusqu’au retour');

  // A long final answer is not read while the user is viewing earlier messages.
  await message(
    'first',
    'assistant',
    Array.from({ length: 60 }, (_, i) => `Paragraphe ${i + 1}.`).join('\n\n'),
    { stopReason: 'stop' },
  );
  await refresh();
  await openSession('first');
  await expect(project()).toHaveAttribute('data-activity', 'idle');
  const reading = await run('first');
  await openSession('first');
  await expect(page.locator('#messages')).toContainText('Paragraphe 60.');
  await expect
    .poll(() => page.locator('#conversation-scroll').evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await page.locator('#conversation-scroll').evaluate((node) => {
    node.scrollTop = 0;
  });
  await reading.finish();
  await refresh();
  await expect(project()).toHaveAttribute('data-activity', 'unread');
  await page.locator('#scroll-bottom').click();
  await expect(project()).toHaveAttribute('data-activity', 'idle');
  checks.push('Le point bleu reste affiché lorsque la dernière réponse est hors écran');

  await project('Documents').click();
  const tabRun = await run('first');
  await tabRun.finish();
  await refresh();
  await expect(project()).toHaveAttribute('data-activity', 'unread');
  const independentDevice = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 390, height: 844 },
  });
  const tab = await independentDevice.newPage();
  tab.on('pageerror', (error) => errors.push(error.message));
  await independentDevice.request.post(phoneUrl + '/lan/login', { form: { code } });
  await tab.goto(phoneUrl);
  await expect(tab.locator('html')).toHaveAttribute('data-read-only', 'true');
  await openSession('first', tab);
  await expect(project('Atelier', tab)).toHaveAttribute('data-activity', 'idle');
  // Other devices poll every 10 seconds; no shared localStorage or manual refresh.
  await expect(project()).toHaveAttribute('data-activity', 'idle', { timeout: 15000 });
  await tab.close();
  await independentDevice.close();
  checks.push('La lecture sur téléphone en consultation est partagée avec le PC, stockages indépendants');

  await project('Documents').click();
  const offline = await run('first');
  await page.close();
  await offline.finish();
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(project()).toHaveAttribute('data-activity', 'unread');
  await openSession('first');
  await expect(project()).toHaveAttribute('data-activity', 'idle');
  checks.push('Une réponse terminée pendant la fermeture du Studio est signalée au retour');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#toggle-sidebar').click();
  const mobileRun = await run('second');
  await mobileRun.finish();
  await refresh();
  await expect(project().locator('.unread-dot')).toBeVisible();
  await page.screenshot({
    path: resolve('test-results/project-activity-mobile.png'),
    animations: 'disabled',
  });
  await expect(page.locator('.session-row[data-session-id="second"]')).toHaveAttribute(
    'data-activity',
    'unread',
  );
  await openSession('second');
  await expect(project()).toHaveAttribute('data-activity', 'idle');
  await page.locator('#toggle-sidebar').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  checks.push('Navigation mobile, absence de débordement et effacement après lecture');
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  console.error(error);
  await mkdir(resolve('test-results'), { recursive: true });
  await page
    ?.screenshot({ path: resolve('test-results/project-activity-failure.png'), animations: 'disabled' })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
  await app.close();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('prime-studio-activity-'))
    throw new Error('Répertoire de nettoyage inattendu.');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
