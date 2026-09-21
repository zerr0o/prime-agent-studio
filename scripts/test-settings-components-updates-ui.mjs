// Repair belongs to the same update panel and never restarts implicitly.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createStabilityFixture } from './fixtures/session-stability.mjs';
import { mockDesktopUpdates } from './fixtures/desktop-updates.mjs';
const fixture = await createStabilityFixture();
const browser = await chromium.launch({
  channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome',
  headless: true,
});
try {
  await mkdir('test-results', { recursive: true });
  for (const locale of ['fr-FR', 'en-US']) {
    const context = await browser.newContext({ locale, viewport: { width: 1440, height: 960 } });
    await mockDesktopUpdates(context, { componentsReady: false, ownership: 'recoverable' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url + '/?settings=updates');
    const $ = (id) => page.locator('#studio-update-' + id);
    await expect($('repair')).toBeVisible();
    await expect($('status')).toContainText(locale.startsWith('fr') ? 'composants' : 'components');
    await expect($('details')).not.toHaveAttribute('open');
    await expect($('restart')).toBeEnabled();
    await expect(page.locator('#studio-update-components-apply')).toHaveCount(0);
    await $('repair').click();
    await expect($('repair')).toBeHidden();
    await expect($('status')).toContainText(locale.startsWith('fr') ? 'Redémarrez' : 'Restart');
    let calls = await page.evaluate(() => window.updateFixture.calls);
    assert.equal(calls.filter((c) => c.command === 'desktop_components' && c.action === 'prepare').length, 1);
    assert.equal(calls.filter((c) => c.command === 'desktop_server_restart').length, 0);
    assert.equal(
      calls.some((c) => ['install', 'activate', 'apply'].includes(c.action)),
      false,
    );
    await $('details').locator('summary').first().click();
    await expect(page.locator('#studio-update-components-detail-list')).toContainText('9');
    await page.screenshot({ path: `test-results/components-updates-${locale}.png` });
    await $('restart').click();
    await expect($('confirm')).toBeVisible();
    await $('cancel').click();
    calls = await page.evaluate(() => window.updateFixture.calls);
    assert.equal(calls.filter((c) => c.command === 'desktop_server_restart').length, 0);
    await $('restart').click();
    await $('proceed').click();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.updateFixture.calls.filter((c) => c.command === 'desktop_server_restart').length,
        ),
      )
      .toBe(1);
    calls = await page.evaluate(() => window.updateFixture.calls);
    assert.equal(calls.find((c) => c.command === 'desktop_server_restart').force, true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    'Unified repair FR/EN: repair only, preserved components, no implicit restart, one explicit confirmed restart, technical details collapsed.',
  );
} finally {
  await browser.close();
  await fixture.close();
}
