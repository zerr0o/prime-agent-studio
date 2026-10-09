import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createModelCatalogueFixture, modelCatalogue } from './fixtures/model-catalogue.mjs';

const fixture = await createModelCatalogueFixture({ retired: false });
const errors = [],
  checks = [];
let browser;
try {
  browser = await launchStudioBrowser({ channel: 'chrome' });
  const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (error) => errors.push(error.message));
  let reads = 0,
    posts = 0,
    manualResponse;
  await page.route('**/api/models{,/refresh}', async (route) => {
    if (route.request().method() === 'POST') {
      posts += 1;
      await new Promise((resolve) => {
        manualResponse = resolve;
      });
      return route.fulfill({ json: modelCatalogue() });
    }
    reads += 1;
    return route.fulfill({ json: modelCatalogue({ retired: reads > 1, refreshing: reads === 1 }) });
  });
  await page.goto(fixture.url);
  const freeId = 'openrouter/minimax/minimax-m3:free';
  const freeRow = page.locator(`.model-row[data-model-id="${freeId}"]`);
  await expect(page.locator('#model-select')).toHaveValue(freeId);
  await page.locator('#thinking-select').selectOption('high');
  await page.locator('#model-picker-button').click();
  await expect(page.locator('#model-results-status')).toHaveText('Actualisation des modèles…');
  await page.locator('#model-search').fill('minimax');
  await freeRow.locator('.model-favorite').click();
  await expect(freeRow.locator('.model-favorite')).toBeFocused();
  await expect(freeRow.locator('.model-choice')).toBeDisabled();
  await expect(freeRow.locator('.model-favorite')).toBeFocused();
  await expect(freeRow).toContainText('Indisponible');
  await expect(page.locator('#model-select')).toHaveValue(freeId);
  await expect(page.locator(`#model-select option[value="${freeId}"]`)).toBeDisabled();
  await expect(page.locator('#thinking-select')).toHaveValue('high');
  await expect(page.locator('#model-search')).toHaveValue('minimax');
  await freeRow.locator('.model-choice').dispatchEvent('click');
  await expect(page.locator('#model-dialog')).toBeVisible();
  await expect(page.locator('#model-select')).toHaveValue(freeId);
  checks.push(
    'Automatic refresh disables a withdrawn model without changing selection, reasoning, search or keyboard focus.',
  );

  await page.locator('#model-favorites-filter').click();
  await expect(page.locator('.model-row')).toHaveCount(1);
  await expect(freeRow.locator('.model-favorite')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#model-favorites-filter').click();
  await page.locator('#model-refresh').click();
  await expect.poll(() => posts).toBe(1);
  await page.locator('#model-search').fill('minimax m3');
  manualResponse();
  await expect(page.locator('#model-refresh')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#model-search')).toBeFocused();
  await expect(page.locator('#model-search')).toHaveValue('minimax m3');
  await expect(page.locator('#model-select')).toHaveValue(freeId);
  await page.locator('#model-search').press('ArrowDown');
  await expect(page.locator('.model-choice:focus')).toBeEnabled();
  checks.push(
    'Retired favorites remain searchable; explicit refresh preserves in-progress input; keyboard navigation skips unavailable choices.',
  );

  await page.locator('#model-search').fill('');
  await mkdir(resolve('test-results'), { recursive: true });
  await page.screenshot({
    path: resolve('test-results/model-catalogue-desktop.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  const previousReads = reads;
  await page.locator('#model-picker-button').click();
  await expect.poll(() => reads).toBeGreaterThan(previousReads);
  await page.locator('.model-choice[data-model-id="openrouter/minimax/minimax-m3"]').click();
  await expect(page.locator('#model-select')).toHaveValue('openrouter/minimax/minimax-m3');
  checks.push('Reopening rechecks the catalogue; switching to a paid model requires an explicit selection.');

  const mobile = await browser.newPage({ locale: 'en-US', viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (error) => errors.push(error.message));
  await mobile.route('**/api/models', (route) => route.fulfill({ json: modelCatalogue() }));
  await mobile.goto(fixture.url);
  await mobile.locator('#model-picker-button').click();
  await expect(mobile.locator('.model-choice-availability')).toHaveText('Unavailable');
  await expect(mobile.locator('#model-refresh')).toHaveAccessibleName('Refresh models');
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await mobile.locator('#model-dialog').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
    true,
  );
  await mobile.screenshot({
    path: resolve('test-results/model-catalogue-mobile-en.png'),
    animations: 'disabled',
  });
  checks.push('English mobile picker remains readable and fits the viewport.');
  const actualRefresh = mobile.waitForResponse(
    (response) => response.url().endsWith('/api/models/refresh') && response.request().method() === 'POST',
  );
  await mobile.locator('#model-refresh').click();
  expect((await actualRefresh).status()).toBe(200);
  checks.push('Manual refresh reaches the real Studio HTTP route with a valid JSON request.');

  const offline = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  offline.on('pageerror', (error) => errors.push(error.message));
  let offlineReads = 0;
  await offline.route('**/api/models', (route) => {
    offlineReads += 1;
    return offlineReads === 1
      ? route.fulfill({ json: modelCatalogue({ refreshing: true }) })
      : route.continue();
  });
  await offline.goto(fixture.url);
  await offline.locator('#composer').fill('Brouillon conservé hors connexion');
  await offline.locator('#thinking-select').selectOption('high');
  await offline.locator('#model-picker-button').click();
  await expect(offline.locator('#model-results-status')).toHaveText('Actualisation des modèles…');
  await offline.locator('#model-search').fill('minimax');
  await offline.context().setOffline(true);
  await expect(offline.locator('#model-results-status')).toHaveText(
    'Actualisation interrompue. Catalogue conservé.',
  );
  await expect(offline.locator('#model-refresh')).toHaveAttribute('aria-busy', 'false');
  await expect(offline.locator('#model-refresh')).toBeEnabled();
  await expect(offline.locator('#model-search')).toBeFocused();
  await expect(offline.locator('#model-search')).toHaveValue('minimax');
  await expect(offline.locator('#model-select')).toHaveValue(freeId);
  await expect(offline.locator('#thinking-select')).toHaveValue('high');
  await expect(offline.locator('#composer')).toHaveValue('Brouillon conservé hors connexion');
  await expect(offline.locator(`.model-row[data-model-id="${freeId}"] .model-choice`)).toBeDisabled();
  await offline.screenshot({
    path: resolve('test-results/model-catalogue-offline.png'),
    animations: 'disabled',
  });
  await offline.context().setOffline(false);
  const recoveredRefresh = offline.waitForResponse((response) =>
    response.url().endsWith('/api/models/refresh'),
  );
  await offline.locator('#model-refresh').click();
  expect((await recoveredRefresh).status()).toBe(200);
  await expect(offline.locator('#model-results-status')).toHaveText('3 résultats');
  await expect(offline.locator('#model-refresh')).toHaveAttribute('aria-busy', 'false');
  await expect(offline.locator('#model-select')).toHaveValue(freeId);
  await expect(offline.locator('#thinking-select')).toHaveValue('high');
  checks.push(
    'Real browser offline ends refresh with a retained catalogue and preserved input; manual refresh recovers after reconnecting.',
  );
  expect(errors).toEqual([]);
  await writeFile(
    resolve('test-results/model-catalogue-ui-report.json'),
    JSON.stringify({ passed: true, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fixture.close();
}
