import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createStabilityFixture } from './fixtures/session-stability.mjs';

const fixture = await createStabilityFixture();
let browser;
const errors = [],
  checks = [];
try {
  browser = await launchStudioBrowser({ channel: 'chrome' });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(fixture.url);
  const project = (name) => page.locator('.project-row').filter({ hasText: name });
  await project('SoundsPerfect').click();
  await page.locator('[data-session-id="stability-demo"].project-session-card').click();
  const cards = page.locator('.agent-message');
  await expect(cards).toHaveCount(2);
  await expect(page.locator('#messages')).not.toContainText('Aucun contenu textuel');
  await expect(cards.first()).toContainText('native-ui-test-driver');
  await expect(cards.first()).toContainText('UI Automation');
  await expect(cards.first().locator('.agent-message-badge')).toHaveText('Sous-agent');
  await expect(cards.first().locator('.agent-message-body')).not.toBeVisible();
  await expect(cards.first().locator('.agent-message-preview')).toBeVisible();
  await expect(cards.first()).not.toContainText('Native envelope');
  await cards.first().locator('.agent-message-summary').focus();
  await page.keyboard.press('Enter');
  await expect(cards.first().locator('.agent-message-body')).toBeVisible();
  await cards.first().locator('.agent-message-details > summary').click();
  await expect(cards.first().locator('dd').first()).toContainText('01a082a2');
  await cards.first().locator('.agent-message-summary').click();
  await expect(cards.first().locator('.agent-message-body')).not.toBeVisible();
  await page.locator('.live-queue > summary').click();
  const protectedRows = page.locator('.live-queue-agent');
  await expect(protectedRows).toHaveCount(2);
  await expect(protectedRows.locator('button,textarea')).toHaveCount(0);
  await expect(protectedRows.first()).toContainText('protégé');
  await expect(page.locator('.live-queue-item:not(.live-queue-agent) button')).toHaveCount(5);
  const protectedResponse = await context.request.post(
    fixture.url + '/api/live/sessions/stability-demo/queue',
    {
      data: {
        cwd: fixture.cwd,
        lane: 'steering',
        index: 0,
        expectedText: 'Agent message received: test',
        mutation: { type: 'delete' },
      },
    },
  );
  expect(protectedResponse.status()).toBe(409);
  checks.push(
    'Messages d’agents compacts, dépliables au clavier, file automatique protégée dans l’interface et par l’API',
  );
  await page.locator('.live-queue-item:not(.live-queue-agent) button').last().click();
  await expect(page.locator('.live-queue-item:not(.live-queue-agent)')).toHaveCount(0);
  checks.push('La suppression des messages humains reste fonctionnelle');
  const order = () => page.locator('.project-row').allTextContents();
  const before = await order();
  const source = await project('SoundsPerfect').boundingBox();
  const target = await project('Atelier').boundingBox();
  await page.mouse.move(source.x + 80, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 80, target.y + 5, { steps: 12 });
  await expect(page.locator('[data-drop="before"]')).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(order).not.toEqual(before);
  await expect.poll(async () => (await order())[0]).toContain('SoundsPerfect');
  const moved = await order();
  await page.reload();
  await expect.poll(order).toEqual(moved);
  checks.push('Glisser-déposer direct au-delà d’un voisin, ordre conservé après rechargement');
  // Escape cancels a drag, and the handle remains usable without a pointer.
  const first = await project('SoundsPerfect').boundingBox();
  const last = await project('Documentation').boundingBox();
  await page.mouse.move(first.x + 80, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + 80, last.y + last.height - 4, { steps: 12 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(order).toEqual(moved);
  const handle = page
    .locator('.project-entry')
    .filter({ hasText: 'SoundsPerfect' })
    .locator('.project-drag-handle');
  await handle.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await order())[1]).toContain('SoundsPerfect');
  await expect(handle).toBeFocused();
  checks.push('Annulation du déplacement par Échap et alternative clavier sur la poignée');
  await mkdir(resolve('test-results'), { recursive: true });
  await page.screenshot({
    path: resolve('test-results/session-stability-desktop.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: resolve('test-results/session-stability-mobile.png'),
    animations: 'disabled',
  });
  checks.push('Absence de débordement horizontal à 390 px');
  const mobile = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phone = await mobile.newPage();
  phone.on('pageerror', (error) => errors.push(error.message));
  await phone.goto(fixture.url);
  await phone.locator('#toggle-sidebar').click();
  await expect(phone.locator('#sidebar')).toBeVisible();
  await expect.poll(async () => Math.round((await phone.locator('#sidebar').boundingBox()).x)).toBe(0);
  const phoneOrder = () => phone.locator('.project-row').allTextContents();
  const touchHandle = phone
    .locator('.project-entry')
    .filter({ hasText: 'SoundsPerfect' })
    .locator('.project-drag-handle');
  const touchSource = await touchHandle.boundingBox();
  const touchTarget = await phone.locator('.project-entry').filter({ hasText: 'Atelier' }).boundingBox();
  const cdp = await mobile.newCDPSession(phone);
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  await touch('touchStart', touchSource.x + touchSource.width / 2, touchSource.y + touchSource.height / 2);
  await touch('touchMove', touchSource.x + touchSource.width / 2, touchTarget.y + 3);
  await expect(phone.locator('[data-drop="before"]')).toHaveCount(1);
  await touch('touchEnd');
  await expect.poll(async () => (await phoneOrder())[0]).toContain('SoundsPerfect');
  await phone.reload();
  await expect.poll(async () => (await phoneOrder())[0]).toContain('SoundsPerfect');
  checks.push('Glisser-déposer tactile réel via la poignée, ordre partagé et persistant');
  await mobile.close();
  for (let index = 1; index <= 12; index++) {
    const cwd = resolve(fixture.root, `Projet ${String(index).padStart(2, '0')}`);
    await mkdir(cwd);
    await fixture.app.store.project({ cwd });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await expect(project('Projet 12')).toHaveCount(1);
  await expect(page.locator('#project-list')).toContainText('Projet 12');
  await project('Projet 12').scrollIntoViewIfNeeded();
  const lastProject = await project('Projet 12').boundingBox();
  const listBounds = await page.locator('#project-list').boundingBox();
  await page.mouse.move(lastProject.x + 70, lastProject.y + lastProject.height / 2);
  await page.mouse.down();
  await page.mouse.move(listBounds.x + 70, listBounds.y + 5, { steps: 12 });
  await expect.poll(() => page.locator('#project-list').evaluate((list) => list.scrollTop)).toBe(0);
  await page.mouse.up();
  await expect.poll(async () => (await order())[0]).toContain('Projet 12');
  checks.push('Défilement automatique : un projet en bas d’une longue liste se déplace en tête');
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser?.close();
  await fixture.close();
}
