import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { preferencesFixture } from './preview-preferences.mjs';

const fixture = await preferencesFixture();
let browser;
try {
  browser = await launchStudioBrowser();
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fixture.url);
  await expect(page.locator('#connection-label')).toContainText('connecté');
  await page.locator('#open-settings').click();
  await expect(page.getByRole('tabpanel', { name: 'Apparence', exact: true })).toBeVisible();
  await page.locator('#settings-tab-appearance').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#settings-tab-models')).toBeFocused();
  await expect(page.locator('#model-config-settings')).toBeVisible();
  await expect(page.locator('#provider-settings')).toBeVisible();
  assert.equal(await page.locator('#provider-settings').evaluate((providers) =>
    Boolean(providers.compareDocumentPosition(document.getElementById('model-config-settings')) & Node.DOCUMENT_POSITION_FOLLOWING),
  ), true, 'Providers precede models in DOM and keyboard order');
  await page.keyboard.press('End');
  await expect(page.locator('#settings-tab-updates')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#studio-update-browser')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#settings-tab-system')).toHaveAttribute('aria-selected', 'true');
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await expect(page.locator('#settings-system-info')).toContainText(version);
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#computer-backend-label')).toHaveText('Computer Use');
  await expect(page.locator('[data-i18n="computer.toolsNote"]')).toContainText('avec votre autorisation');
  await expect(page.locator('#computer-use-label')).toHaveText('Computer Use');
  await page.locator('#settings-skills').click();
  await expect(page.locator('#commands-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-skills')).toBeFocused();
  await page.locator('#settings-tab-remote').click();
  await expect(page.locator('#network-lan')).not.toBeChecked();
  await page.locator('#network-lan').click();
  await expect(page.locator('#network-lan')).toBeChecked();
  await expect(page.locator('#network-generated-code')).toHaveText(/^[0-9]{8}$/);
  await expect(page.locator('#toasts .toast')).toBeVisible();
  assert.equal(await page.locator('#toasts').evaluate((stack) => stack.matches(':popover-open')), true);
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#network-copy-code')).toBeFocused();
  await mkdir('test-results/remarks', { recursive: true });
  await page.screenshot({ path: 'test-results/remarks/toast-over-preferences.png', animations: 'disabled' });
  const pin = await page.locator('#network-generated-code').innerText();
  await expect(page.locator('#network-content .network-url')).toHaveText('http://192.168.1.42:3089');
  await page.locator('#network-dismiss-code').click();
  await expect(page.locator('#network-generated-code')).toBeEmpty();
  await page.locator('#network-tailscale').click();
  await expect(page.locator('#network-tailscale')).toBeChecked();
  await page.getByRole('button', { name: 'QR code', exact: true }).first().click();
  await expect(page.locator('#settings-qr-dialog img')).toBeVisible();
  await expect(page.locator('#settings-qr-dialog .network-url')).toHaveText('http://192.168.1.42:3089');
  await expect
    .poll(() => page.locator('#settings-qr-dialog img').evaluate((img) => img.naturalWidth))
    .toBe(256);
  assert.ok(!(await page.locator('#settings-qr-dialog').innerText()).includes(pin));
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('#network-lan').click();
  await expect(page.locator('#network-lan')).not.toBeChecked();
  await expect(page.locator('#network-tailscale')).toBeChecked();
  await page.locator('#network-lan').click();
  await expect(page.locator('#network-lan')).toBeChecked();
  await expect(page.locator('#network-new-code')).toBeHidden();
  const before = (await fixture.app.remoteAccess.readConfig()).config;
  await page.locator('#network-read-only').selectOption('true');
  await expect(page.locator('#network-read-only')).toHaveValue('true');
  assert.equal((await fixture.app.remoteAccess.readConfig()).config.codeHash, before.codeHash);
  await page.locator('#open-remote-access').click();
  await expect(page.locator('#remote-code')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('#open-remote-access')).toBeFocused();
  const advanced = page.locator('details[data-channel="lan"]');
  await advanced.locator('summary').click();
  await page.locator('#network-port-lan').fill('4055');
  await advanced.getByRole('button', { name: 'Appliquer' }).click();
  await expect(page.locator('.network-url').first()).toHaveText('http://192.168.1.42:4055');
  await expect(page.locator('.network-url').nth(1)).toHaveText('http://100.91.42.10:4055');
  await page.locator('#settings-tab-appearance').click();
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('#settings-title')).toHaveText('Preferences');
  await page.locator('#settings-tab-remote').click();
  await expect(page.locator('#settings-tab-remote')).toHaveText('Remote access');
  await expect(page.locator('.network-description').first()).toHaveText(
    'On the same Wi-Fi or Ethernet network.',
  );
  await page.locator('#network-port-lan').fill('4056');
  const peer = await page.context().newPage();
  await peer.goto(fixture.url);
  await peer.locator('#open-settings').click();
  await peer.locator('#language-select').selectOption('fr');
  await expect(page.locator('#settings-title')).toHaveText('Préférences');
  await expect(page.locator('#network-port-lan')).toHaveValue('4056');
  await peer.locator('#language-select').selectOption('en');
  await expect(page.locator('#settings-title')).toHaveText('Preferences');
  await expect(page.locator('#network-port-lan')).toHaveValue('4056');
  await peer.close();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const category of ['appearance', 'models', 'tools', 'remote', 'system']) {
      await page.locator('#settings-tab-' + category).click();
      const bounds = await page.locator('#settings-dialog').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.equal(
        await page.locator('.settings-panels').evaluate((el) => el.scrollWidth <= el.clientWidth),
        true,
        category + ' must not overflow',
      );
      const done = page.locator('#settings-dialog .settings-actions [data-close-dialog]');
      await expect(done).toBeInViewport();
    }
  }
  await page.locator('#settings-tab-remote').click();
  await page.route('**/api/remote-access/network', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Test: connection change failed' }),
        })
      : route.continue(),
  );
  await page.locator('#network-lan').click();
  await expect(page.locator('#network-error')).toHaveText('Test: connection change failed');
  await expect(page.locator('#network-lan')).toBeChecked();
  await expect(page.locator('#network-tailscale')).toBeChecked();
  await page.unroute('**/api/remote-access/network');
  await page.route('**/api/remote-access/network', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        configured: false,
        revision: null,
        readOnly: true,
        channels: ['lan', 'tailscale'].map((kind) => ({
          kind,
          enabled: false,
          status: 'disabled',
          port: 3089,
          host: '',
          addresses: [],
        })),
      }),
    }),
  );
  await page.locator('#network-refresh').click();
  await expect(page.locator('#network-lan')).toBeDisabled();
  await expect(page.locator('#network-tailscale')).toBeDisabled();
  await expect(page.locator('.network-hint').last()).toContainText('Connect Tailscale');
  await page.unroute('**/api/remote-access/network');
  assert.ok(
    !(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes(pin),
  );
  assert.deepEqual(errors, []);
  console.log(
    'Preferences UI passed: categories, keyboard, return focus, LAN/Tailscale, PIN preservation, QR, permissions, shared port, FR/EN, 390/320 px.',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
