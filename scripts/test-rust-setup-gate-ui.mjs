// Real HTTP/bootstrap and browser gate with an inert native runtime. No provider calls.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { launchStudioBrowser } from './fixtures/browser.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-rust-setup-'));
const cwd = join(root, 'project');
await mkdir(cwd);
let connected = false;
let mainModel = '';
const starts = [];
const app = createApp({
  initialCwd: cwd,
  agentHome: join(root, 'agent'),
  sessionDir: join(root, 'sessions'),
  dataDir: join(root, 'data'),
  runtime: {
    engine: 'rust',
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({
      models: [{ id: 'test/text', name: 'Fixture model', provider: 'test', input: ['text'] }],
      configuredProviders: connected ? ['test'] : [],
      default: { model: mainModel },
    }),
    start: async (input) => { starts.push(input); throw new Error('inert fixture'); },
    close: async () => {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await launchStudioBrowser();
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 960 } });
    await context.addInitScript(() =>
      localStorage.setItem('prime-studio.docking.layout', JSON.stringify({ enabled: false })),
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const phase of ['provider', 'main', 'ready']) {
      connected = phase !== 'provider';
      mainModel = phase === 'ready' ? 'test/text' : '';
      const refreshed = await fetch(`${url}/api/models/refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(refreshed.status, 200);
      await page.goto(url);
      await expect(page.locator('#cli-version')).toContainText('fixture');
      await page.locator('#composer').fill('A fixture message');
      const gate = page.locator('#welcome .setup-gate');
      if (phase !== 'ready') {
        await expect(gate).toBeVisible();
        await expect(gate.locator('[data-setup-step="subagent"]')).toBeHidden();
        await expect(gate.locator('[aria-current="step"]')).toHaveAttribute('data-setup-step', phase);
        await expect(page.locator('#send-button')).toBeDisabled();
      } else {
        await expect(gate).toBeHidden();
        await expect(page.locator('#send-button')).toBeEnabled();
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  assert.equal(starts.length, 0);
  console.log('Rust setup gate passed at 1440px and 390px: provider and main model required, unsupported subagent step hidden, first send enabled once ready.');
} finally {
  await browser.close();
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
