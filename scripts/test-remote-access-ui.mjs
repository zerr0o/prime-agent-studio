import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-remote-pin-ui-'));
const cwd = join(temp, 'Atelier'),
  dataDir = join(temp, 'data'),
  sessionDir = join(temp, 'sessions');
await Promise.all([cwd, dataDir, sessionDir, 'test-results'].map((p) => mkdir(p, { recursive: true })));
const oldCode = '49283175',
  code = '01234567';
const config = {
  enabled: true,
  host: '127.0.0.1',
  port: 3089,
  readOnly: false,
  salt: 'b'.repeat(32),
  codeHash: hashAccessCode(oldCode, 'b'.repeat(32)),
  tailscale: {
    enabled: true,
    host: '100.80.1.2',
    https: { enabled: true, origin: 'https://example.ts.net', port: 3090 },
  },
};
await writeFile(join(dataDir, 'lan-access.json'), JSON.stringify(config));
const app = createApp({
  dataDir,
  sessionDir,
  initialCwd: cwd,
  agentHome: join(temp, 'agent'),
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({ models: [], default: {} }),
    start: async () => {
      throw new Error('No agent should be started');
    },
    close: async () => {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const local = `http://127.0.0.1:${app.server.address().port}`;
const gateway = createLanGateway({ host: '127.0.0.1', upstreamPort: app.server.address().port, config });
await app.remoteAccess.registerGateway(gateway);
await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
const remote = `http://127.0.0.1:${gateway.address().port}`;
const browser = await launchStudioBrowser();
const pc = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1440, height: 1000 } });
const phone = await browser.newPage({
  locale: 'fr-FR',
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const errors = [];
for (const page of [pc, phone]) page.on('pageerror', (error) => errors.push(error.message));
const post = async (body) =>
  (
    await fetch(local + '/api/remote-access/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json();
async function open() {
  if (!(await pc.locator('#settings-dialog').isVisible())) await pc.locator('#open-settings').click();
  await pc.locator('#settings-tab-remote').click();

  await pc.locator('#open-remote-access').click();
  await expect(pc.locator('#remote-code')).toBeEnabled();
}
try {
  await pc.goto(local);
  await expect(pc.locator('#connection-label')).toContainText('connecté');
  await phone.goto(remote);
  await phone.locator('#code').fill(oldCode);
  await phone.getByRole('button', { name: 'Ouvrir le studio' }).click();
  await expect(phone.locator('#connection-label')).toContainText('connecté');
  await expect(phone.locator('#remote-access-settings')).toBeHidden();
  await open();
  await expect(pc.locator('#save-remote-code')).toBeDisabled();
  await pc.locator('#remote-code').fill(code);
  await pc.locator('#remote-code-confirmation').fill(oldCode);
  await pc.locator('#save-remote-code').click();
  await expect(pc.locator('#remote-code-error')).toHaveText('Les deux codes ne correspondent pas.');
  await pc.locator('#remote-code-confirmation').fill(code);
  await pc.locator('#show-remote-code').check();
  await expect(pc.locator('#remote-code')).toHaveAttribute('type', 'text');
  await expect(pc.locator('#remote-code-confirmation')).toHaveAttribute('type', 'text');
  await pc.locator('#show-remote-code').uncheck();
  await pc.screenshot({ path: 'test-results/remote-pin-desktop.png', animations: 'disabled' });
  await pc.locator('#save-remote-code').click();
  await expect(pc.locator('#remote-access-dialog')).toBeHidden();
  await expect(pc.locator('#remote-code')).toHaveValue('');
  await expect(pc.locator('#remote-code-confirmation')).toHaveValue('');
  assert.ok(!(await readFile(join(dataDir, 'lan-access.json'), 'utf8')).includes(code));
  assert.ok(
    !(
      await pc.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
    ).includes(code),
  );
  assert.equal(await phone.evaluate(async () => (await fetch('/api/runs')).status), 401);
  await phone.reload();
  await expect(phone.locator('#code')).toBeVisible();
  await phone.locator('#code').fill(oldCode);
  await phone.getByRole('button', { name: 'Ouvrir le studio' }).click();
  await expect(phone.locator('.error')).toContainText('Code incorrect');
  await phone.locator('#code').fill(code);
  await phone.getByRole('button', { name: 'Ouvrir le studio' }).click();
  await expect(phone.locator('#connection-label')).toContainText('connecté');
  await open();
  const state = await (await fetch(local + '/api/remote-access')).json();
  await post({ revision: state.revision, code: oldCode, confirmation: oldCode });
  await pc.locator('#remote-code').fill(code);
  await pc.locator('#remote-code-confirmation').fill(code);
  await pc.locator('#save-remote-code').click();
  await expect(pc.locator('#remote-code-error')).toContainText('autre fenêtre');
  await pc.locator('#remote-access-dialog').getByRole('button', { name: 'Annuler' }).click();
  await expect(pc.locator('#settings-dialog')).toBeVisible();
  await open();
  await expect(pc.locator('#remote-code')).toHaveValue('');
  await pc.locator('#remote-code').fill(code);
  await pc.locator('#remote-access-dialog').getByRole('button', { name: 'Annuler' }).click();
  const saved = JSON.parse(await readFile(join(dataDir, 'lan-access.json'), 'utf8'));
  assert.equal(saved.codeHash, hashAccessCode(oldCode, saved.salt));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'PC-only preferences',
        'confirmation and visibility',
        'leading zero preserved',
        'immediate remote reconnection',
        'no plaintext persistence',
        'stale edits and cancel',
      ],
    }),
  );
} finally {
  await browser.close();
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  await app.close();
  assert.equal(dirname(temp), resolve(tmpdir()));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
