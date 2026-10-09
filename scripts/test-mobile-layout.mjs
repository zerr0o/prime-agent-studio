// Isolated long conversation: no native agent, account or user session is touched.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const dir = await mkdtemp(join(tmpdir(), 'prime-mobile-layout-'));
const sessionDir = join(dir, 'sessions'),
  agentHome = join(dir, 'agent');
await Promise.all([mkdir(sessionDir), mkdir(agentHome), mkdir('test-results', { recursive: true })]);
await writeFile(
  join(sessionDir, 'layout.jsonl'),
  [
    { type: 'session', id: 'mobile-layout', cwd: dir, timestamp: new Date().toISOString(), version: 3 },
    {
      type: 'message',
      id: 'u1',
      parentId: null,
      message: { role: 'user', content: 'Une conversation sur mobile' },
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text:
              'Le Studio reste disponible depuis votre téléphone.\n\n'.repeat(24) +
              'Fin du message de démonstration.',
          },
        ],
      },
    },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);
const app = createApp({
  sessionDir,
  agentHome,
  dataDir: join(dir, 'data'),
  initialCwd: dir,
  runtime: {
    async getStatus() {
      return { available: true, version: 'fixture' };
    },
    async getModels() {
      return {
        models: [
          { id: 'openai-codex/gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai-codex', reasoning: true },
        ],
        default: { model: 'openai-codex/gpt-5.6-sol', thinking: 'max' },
      };
    },
    async start() {
      throw new Error('No agent should start in a layout test.');
    },
    async close() {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const code = '12345678',
  salt = 'b'.repeat(32);
const gateway = createLanGateway({
  host: '127.0.0.1',
  upstreamPort: app.server.address().port,
  config: { salt, codeHash: hashAccessCode(code, salt), readOnly: false },
});
await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${gateway.address().port}`;
const browser = await launchStudioBrowser({ channel: 'chrome' });
const page = await browser.newPage({
  locale: 'fr-FR',
  viewport: { width: 412, height: 840 },
  isMobile: true,
  hasTouch: true,
});
page.setDefaultTimeout(10000);
const errors = [],
  measurements = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => {
  // Desktop automation has no OS keyboard or gesture bar. Emulate their viewport geometry.
  const view = visualViewport;
  for (const property of ['height', 'offsetTop', 'scale']) {
    const getter = Object.getOwnPropertyDescriptor(VisualViewport.prototype, property).get;
    Object.defineProperty(view, property, { get: () => window.__viewport?.[property] ?? getter.call(view) });
  }
});
async function visibleViewport(values) {
  await page.evaluate((values) => {
    window.__viewport = values;
    visualViewport.dispatchEvent(new Event('resize'));
    visualViewport.dispatchEvent(new Event('scroll'));
  }, values);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}
async function measure(label) {
  const result = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
    return {
      innerHeight,
      viewportHeight: visualViewport.height,
      viewportTop: visualViewport.offsetTop,
      shell: box('.app-shell'),
      column: box('.conversation-column'),
      scroll: box('#conversation-scroll'),
      area: box('.composer-area'),
      form: box('#composer-form'),
      send: box('#send-button'),
      textarea: box('#composer'),
      safeBottom:
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--studio-safe-bottom')) || 0,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  measurements.push({ label, ...result });
  assert.ok(result.form.top >= result.column.top - 1, `${label}: composer should fit below the header`);
  assert.ok(
    result.form.bottom <= result.viewportTop + result.viewportHeight - result.safeBottom - 11,
    `${label}: whole card must stay above the bottom inset`,
  );
  assert.ok(result.send.bottom < result.form.bottom, `${label}: send must stay inside the card`);
  assert.ok(result.scroll.height >= 40, `${label}: conversation must remain usable`);
  assert.ok(result.documentWidth <= page.viewportSize().width + 1, `${label}: no horizontal overflow`);
  return result;
}
try {
  await page.goto(url);
  await page.locator('#code').fill(code);
  await page.getByRole('button', { name: 'Ouvrir le studio' }).click();
  await expect(page.locator('#connection-label')).toHaveText('Moteur connecté');
  await page.locator('#toggle-sidebar').click();
  await page
    .locator('#session-list .session-select')
    .filter({ hasText: 'Une conversation sur mobile' })
    .click();
  await expect(page.locator('#messages')).toContainText('Fin du message de démonstration.');
  await page.locator('#conversation-scroll').evaluate((node) => (node.scrollTop = node.scrollHeight));
  await measure('portrait');
  await page.screenshot({ path: 'test-results/mobile-layout-portrait.png', animations: 'disabled' });
  await visibleViewport({ height: 750 });
  await measure('visible area shorter than layout viewport');
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--studio-safe-bottom', '34px');
    document.documentElement.style.setProperty('--studio-safe-top', '24px');
  });
  await measure('installed PWA with system insets');
  await page.screenshot({ path: 'test-results/mobile-layout-pwa.png', animations: 'disabled' });
  await page.locator('#composer').fill('Un long brouillon pour vérifier la saisie.\n'.repeat(24));
  await visibleViewport({ height: 460 });
  await measure('keyboard open with long draft');
  await page.screenshot({
    path: 'test-results/mobile-layout-keyboard.png',
    animations: 'disabled',
    clip: { x: 0, y: 0, width: 412, height: 460 },
  });
  await visibleViewport({ height: 460, offsetTop: 38 });
  await measure('keyboard pans visible viewport');
  const shellHeight = await page
    .locator('.app-shell')
    .evaluate((node) => node.getBoundingClientRect().height);
  await visibleViewport({ height: 230, scale: 2, offsetTop: 60 });
  assert.equal(
    await page.locator('.app-shell').evaluate((node) => node.getBoundingClientRect().height),
    shellHeight,
    'Pinch zoom must not resize the layout',
  );
  await visibleViewport({});
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--studio-safe-bottom');
    document.documentElement.style.removeProperty('--studio-safe-top');
  });
  await page.locator('#composer').fill('');
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() => page.locator('.app-shell').evaluate((node) => node.getBoundingClientRect().height))
      .toBe(viewport.height);
    await measure(`${viewport.width} × ${viewport.height}`);
  }
  await page.setViewportSize({ width: 412, height: 840 });
  await expect
    .poll(() => page.locator('.app-shell').evaluate((node) => node.getBoundingClientRect().height))
    .toBe(840);
  await measure('back to portrait after keyboard closes');
  await page.locator('#conversation-scroll').evaluate((node) => (node.scrollTop = 0));
  await expect(page.locator('#composer-form')).toBeInViewport({ ratio: 1 });
  const report = { passed: true, measurements, simulatedSystemInsetsAndKeyboard: true };
  await writeFile('test-results/mobile-layout.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, checks: measurements.map((item) => item.label) }, null, 2));
  assert.deepEqual(errors, []);
} catch (error) {
  await page.screenshot({ path: 'test-results/mobile-layout-failure.png' });
  console.error(JSON.stringify({ measurements, errors }));
  throw error;
} finally {
  await browser.close();
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  await app.close();
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
