// New-session cwd regression: pinned "_TESTS" project, first send from a fresh conversation.
// Covers the reported path first: click the PROJECT TITLE to open the listing view,
// then the top-right listing button, then send. Also covers the sidebar button.
// Shared root cause was `$('...').onclick = newSession` passing a MouseEvent as
// execCwd, so the POST body carried cwd={"isTrusted":true} and the server
// answered 400 "Indiquez le chemin absolu d'un dossier existant."
// Run with: PRIME_STUDIO_TEST_BROWSER=chromium node scripts/test-new-session-cwd-ui.mjs
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-studio-new-session-cwd-'));
const testsDir = join(root, '_TESTS');
const otherDir = join(root, 'Other');
await Promise.all(
  [testsDir, otherDir, join(root, 'sessions'), join(root, 'data'), join(root, 'agent')].map((p) =>
    mkdir(p, { recursive: true }),
  ),
);
const evidenceDir = resolve('test-results/new-session-cwd');
await mkdir(evidenceDir, { recursive: true });

const startedRuns = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/luna', name: 'Luna', provider: 'fixture' }],
    default: { model: 'fixture/luna' },
  }),
  async start(input) {
    startedRuns.push({ cwd: input.cwd, message: input.message });
    let finish;
    const done = new Promise((resolveDone) => {
      finish = resolveDone;
    });
    return {
      done,
      async cancel() {
        finish({ status: 'stopped', code: 130 });
      },
    };
  },
  async close() {},
};

const app = createApp({
  runtime,
  sessionDir: join(root, 'sessions'),
  dataDir: join(root, 'data'),
  agentHome: join(root, 'agent'),
  initialCwd: testsDir,
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
await app.store.project({ cwd: testsDir, pinned: true, color: '#a99ac9' }, true);
await app.store.project({ cwd: otherDir, pinned: false });
const url = `http://127.0.0.1:${app.server.address().port}`;

const errors = [];
const checks = [];
const posted = [];
let browser;
try {
  const channel = process.env.PRIME_STUDIO_TEST_BROWSER || '';
  browser =
    channel && channel !== 'chromium'
      ? await chromium.launch({ channel, headless: true })
      : await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (error) => errors.push(String(error?.message || error)));
  await page.route('**/api/runs', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      try {
        posted.push(JSON.parse(request.postData() || '{}'));
      } catch {
        posted.push({ unparsable: request.postData() });
      }
    }
    await route.continue();
  });
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText(/connect/i, { timeout: 15000 });

  const projectRow = (name) =>
    page.locator('#project-list .project-row').filter({ hasText: name });

  // Reported path first: PROJECT TITLE opens the listing view, top-right button starts the conversation.
  await projectRow('_TESTS').click();
  await expect(page.locator('#header-project')).toContainText('_TESTS');
  await expect(page.locator('#project-overview')).toBeVisible();
  await page.locator('#project-new-session').click();
  await expect(page.locator('#header-session')).toHaveText('Nouvelle session');
  await expect(page.locator('#composer')).toBeFocused();
  await page.locator('#composer').fill('Premier message depuis la listing _TESTS');
  await page.locator('#send-button').click();
  await expect
    .poll(() => startedRuns.length, { timeout: 15000 })
    .toBeGreaterThanOrEqual(1);
  expect(resolve(startedRuns.at(-1).cwd)).toBe(resolve(testsDir));
  expect(posted.at(-1).cwd).toBe(startedRuns.at(-1).cwd);
  expect(typeof posted.at(-1).cwd).toBe('string');
  await expect(page.locator('#toasts')).not.toContainText('Indiquez le chemin absolu');
  checks.push('Listing _TESTS epingle: titre projet puis bouton haut droite, premier envoi avec cwd absolu exact (201)');

  await page.screenshot({ path: join(evidenceDir, '01-listing-new-session.png'), animations: 'disabled' });

  // Sidebar path shares the same routing point: top "Nouvelle session" button.
  await projectRow('_TESTS').click();
  await page.locator('#new-session').click();
  await expect(page.locator('#header-session')).toHaveText('Nouvelle session');
  await page.locator('#composer').fill('Premier message depuis la sidebar _TESTS');
  await page.locator('#send-button').click();
  await expect.poll(() => startedRuns.length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  expect(resolve(startedRuns.at(-1).cwd)).toBe(resolve(testsDir));
  expect(typeof posted.at(-1).cwd).toBe('string');
  await expect(page.locator('#toasts')).not.toContainText('Indiquez le chemin absolu');
  checks.push('Sidebar Nouvelle session sur _TESTS epingle: premier envoi avec cwd absolu exact (201)');

  await page.screenshot({ path: join(evidenceDir, '02-sidebar-new-session.png'), animations: 'disabled' });

  // Client guard message is verified by the unit test in both languages.
  checks.push('Garde client: envoi refuse sans cwd valide, message conversation.missing_project (voir test unitaire)');

  expect(errors).toEqual([]);
  await writeFile(
    join(evidenceDir, 'results.json'),
    JSON.stringify({ passed: true, url: 'local-fixture', testsDir: 'redacted', checks, posted: posted.map((p) => ({ cwdType: typeof p.cwd, hasMessage: Boolean(p.message) })) }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
