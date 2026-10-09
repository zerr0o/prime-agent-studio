import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { preferencesFixture } from './preview-preferences.mjs';
const f = await preferencesFixture();
let browser;
try {
  browser = await launchStudioBrowser();
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 860 } });
  await context.addInitScript(() =>
    Object.defineProperty(window, '__PRIME_STUDIO_DESKTOP__', { value: true }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(f.url);
  await expect(page.locator('#pwa-install')).toBeHidden();
  await page.locator('#open-settings').click();
  await expect(page.locator('[data-i18n="settings.scope_desktop"]')).toContainText('Pour cette application');
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('[data-i18n="settings.scope_desktop"]')).toContainText('This application');
  assert.deepEqual(errors, []);
  console.log('Desktop presentation passed: PWA action hidden and preference scope correct in FR/EN.');
} finally {
  await browser?.close();
  await f.close();
}
