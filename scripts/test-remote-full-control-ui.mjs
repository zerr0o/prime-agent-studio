import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

// Full-control remote UI: previously hidden settings must appear on a 390px phone (FR).
// Fixture server only, no agent starts, no build, no running Studio touched.
const dir = await mkdtemp(join(tmpdir(), 'prime-remote-full-ui-'));
const sessionDir = join(dir, 'sessions');
const agentHome = join(dir, 'agent');
const dataDir = join(dir, 'data');
await Promise.all([mkdir(sessionDir, { recursive: true }), mkdir(agentHome, { recursive: true }), mkdir(dataDir, { recursive: true }), mkdir('test-results', { recursive: true })]);
const projectCwd = join(dir, 'Atelier');
await mkdir(projectCwd, { recursive: true });
await writeFile(
  join(sessionDir, 'remote-ui.jsonl'),
  [
    { type: 'session', id: 'remote-ui', cwd: projectCwd, timestamp: new Date().toISOString(), version: 3 },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'Bonjour' } },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n') + '\n',
);
const app = createApp({
  sessionDir,
  agentHome,
  dataDir,
  initialCwd: projectCwd,
  runtime: {
    async getStatus() {
      return { available: true, version: 'fixture' };
    },
    async getModels() {
      return { models: [], default: {} };
    },
    async start() {
      throw new Error('No agent should start in a UI test.');
    },
    async close() {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const code = '87654321';
const salt = 'c'.repeat(32);
const fullGateway = createLanGateway({
  host: '127.0.0.1',
  upstreamPort: app.server.address().port,
  config: { salt, codeHash: hashAccessCode(code, salt), readOnly: false },
});
await new Promise((done) => fullGateway.listen(0, '127.0.0.1', done));
const roGateway = createLanGateway({
  host: '127.0.0.1',
  upstreamPort: app.server.address().port,
  config: { salt, codeHash: hashAccessCode(code, salt), readOnly: true },
});
await new Promise((done) => roGateway.listen(0, '127.0.0.1', done));
const fullUrl = `http://127.0.0.1:${fullGateway.address().port}`;
const roUrl = `http://127.0.0.1:${roGateway.address().port}`;
const browser = await launchStudioBrowser({ channel: 'chrome' });
const errors = [];
async function login(page, url) {
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator('#code').fill(code);
  await page.getByRole('button', { name: 'Ouvrir le studio' }).click();
  await expect(page.locator('#connection-label')).toContainText('connecté');
}
try {
  const full = await browser.newPage({
    locale: 'fr-FR',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await login(full, fullUrl);
  // Settings rows previously hidden for remote are visible in full control (hidden flag, not panel visibility).
  assert.equal(await full.evaluate(() => document.getElementById('model-config-settings').hidden), false);
  assert.equal(await full.evaluate(() => document.getElementById('provider-settings').hidden), false);
  assert.equal(await full.evaluate(() => document.getElementById('remote-access-settings').hidden), false);
  // Gateway now serves former local-only reads.
  assert.equal(await full.evaluate(async () => (await fetch('/api/engine-settings')).status), 200);
  assert.equal(await full.evaluate(async () => (await fetch('/api/studio-preferences')).status), 200);
  assert.equal(await full.evaluate(async () => (await fetch('/api/system')).status), 200);
  assert.equal(await full.evaluate(async () => (await fetch('/api/sync')).status), 200);
  await full.evaluate(() => document.getElementById('open-settings')?.click());
  await expect(full.locator('#settings-dialog')).toBeVisible();
  assert.equal(await full.locator('#settings-tab-models').isHidden(), false);
  assert.equal(await full.locator('#settings-tab-sync').isHidden(), false);
  await full.locator('#settings-tab-models').click();
  await expect(full.locator('#model-config-settings')).toBeVisible();
  await full.screenshot({ path: 'test-results/remote-full-control-fr.png', animations: 'disabled' });
  await full.close();

  const ro = await browser.newPage({
    locale: 'fr-FR',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await login(ro, roUrl);
  // Consultation stays exactly as before: configuration rows hidden.
  assert.equal(await ro.evaluate(() => document.getElementById('model-config-settings').hidden), true);
  assert.equal(await ro.evaluate(() => document.getElementById('provider-settings').hidden), true);
  assert.equal(await ro.evaluate(() => document.getElementById('remote-access-settings').hidden), true);
  assert.equal(await ro.evaluate(async () => (await fetch('/api/engine-settings')).status), 404);
  assert.equal(await ro.evaluate(async () => (await fetch('/api/system')).status), 404);
  await ro.evaluate(() => document.getElementById('open-settings')?.click());
  await expect(ro.locator('#settings-dialog')).toBeVisible();
  assert.equal(await ro.locator('#settings-tab-models').isHidden(), true);
  assert.equal(await ro.locator('#settings-tab-sync').isHidden(), true);
  await ro.screenshot({ path: 'test-results/remote-consultation-fr.png', animations: 'disabled' });
  await ro.close();

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['full-control settings visible', 'consultation stays hidden', 'gateway reads', '390px FR screenshots'] }));
} finally {
  await browser.close();
  fullGateway.closeAllConnections();
  roGateway.closeAllConnections();
  await new Promise((done) => fullGateway.close(done));
  await new Promise((done) => roGateway.close(done));
  await app.close();
  assert.equal(dirname(dir), resolve(tmpdir()));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
