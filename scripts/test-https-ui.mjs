import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { preferencesFixture } from './preview-preferences.mjs';

const fixture = await preferencesFixture();
let browser;
try {
  browser = await launchStudioBrowser();
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(fixture.url);
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-remote').click();
  await expect(page.locator('#network-https')).toBeVisible();
  fixture.tailscale.setMode('dns');
  await page.locator('#network-https').click();
  await expect(page.locator('.https-guidance a')).toHaveAttribute(
    'href',
    'https://login.tailscale.com/admin/dns',
  );
  await expect(page.locator('#network-error')).toContainText('MagicDNS');
  await expect(page.locator('#network-https')).not.toBeChecked();
  fixture.tailscale.setMode('approval');
  await page.locator('.https-guidance button').click();
  await expect(page.locator('.https-guidance a')).toHaveAttribute(
    'href',
    'https://login.tailscale.com/f/serve?node=demo',
  );
  await expect(page.locator('#network-error')).toContainText('autorisation');
  await expect(page.locator('#network-https')).not.toBeChecked();
  fixture.tailscale.setMode('ready');
  let resume;
  const hold = new Promise((done) => (resume = done));
  await page.route('**/api/remote-access/network', async (route) => {
    if (route.request().method() === 'POST') await hold;
    await route.continue();
  });
  await page.locator('.https-guidance button').click();
  await expect(page.locator('.https-progress')).toBeVisible();
  await expect(page.locator('#network-https')).toBeDisabled();
  await expect(page.locator('#network-lan')).toBeDisabled();
  resume();
  await expect(page.locator('#network-https')).toBeChecked();
  await expect(page.locator('#network-generated-code')).toHaveText(/^[0-9]{8}$/);
  await expect(page.locator('#network-copy-code')).toBeFocused();
  await expect(page.locator('.https-guidance')).toHaveCount(0);
  await expect(page.locator('.https-progress')).toHaveCount(0);
  await page.unroute('**/api/remote-access/network');
  const original = (await fixture.app.remoteAccess.readConfig()).config;
  await page.locator('#network-dismiss-code').click();
  const card = page.locator('.network-card').filter({ has: page.locator('#network-https') });
  await expect(card.locator('.network-url')).toHaveText(fixture.tailscale.origin);
  await card.getByRole('button', { name: 'QR code', exact: true }).click();
  await expect(page.locator('#settings-qr-dialog .network-url')).toHaveText(fixture.tailscale.origin);
  await expect
    .poll(() => page.locator('#settings-qr-dialog img').evaluate((image) => image.naturalWidth))
    .toBe(256);
  await page.keyboard.press('Escape');
  await page.locator('#network-https').click();
  await expect(page.locator('#network-https')).not.toBeChecked();
  await expect(card.locator('.network-url')).toHaveCount(0);
  await page.locator('#network-https').click();
  await expect(page.locator('#network-https')).toBeChecked();
  assert.equal((await fixture.app.remoteAccess.readConfig()).config.codeHash, original.codeHash);
  await expect(page.locator('#network-new-code')).toBeHidden();
  await card.locator('summary').click();
  await page.locator('#network-port-https').fill('4190');
  await card.getByRole('button', { name: 'Appliquer' }).click();
  await expect
    .poll(async () => (await fixture.app.remoteAccess.readConfig()).config.tailscale.https.port)
    .toBe(4190);
  await page.locator('#settings-tab-appearance').click();
  await page.locator('#language-select').selectOption('en');
  await page.locator('#settings-tab-remote').click();
  await expect(card.locator('.network-description')).toHaveText('Install Studio on your phone.');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('#network-https').scrollIntoViewIfNeeded();
    assert.equal(
      await page.locator('.settings-panels').evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
    );
    await expect(page.locator('#settings-dialog .settings-actions [data-close-dialog]')).toBeInViewport();
  }
  assert.deepEqual(errors, []);
  console.log(
    'HTTPS UI passed: MagicDNS, approval, progress, retry, PIN focus/preservation, enable/disable, QR, port change, EN/mobile.',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
