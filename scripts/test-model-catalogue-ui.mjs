import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createModelCatalogueFixture, modelCatalogue } from './fixtures/model-catalogue.mjs';

// Inert Anthropic Claude Fable 5.2 fixture for UI-only verification.
// No credentials, no paid calls, no agent start: pure catalogue metadata.
// Matches native studio-models metadata (verified 2026-11-11):
// context 1M, maxTokens 128K, image+text, effort minimal/low/medium/high/xhigh/max, no off.
const FABLE_ID = 'anthropic/claude-fable-5-2';
const FABLE_THINKING = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const FABLE_FIXTURE = {
  id: FABLE_ID,
  name: 'Claude Fable 5.2',
  provider: 'anthropic',
  availability: 'available',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: 1000000,
  maxTokens: 128000,
  thinkingLevels: [...FABLE_THINKING],
};

function catalogueWithFable(options) {
  const base = modelCatalogue(options);
  if (!base.models.some((model) => model.id === FABLE_ID)) {
    base.models = [
      ...base.models,
      {
        ...FABLE_FIXTURE,
        input: [...FABLE_FIXTURE.input],
        thinkingLevels: [...FABLE_THINKING],
      },
    ];
  }
  return base;
}

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
  let autoRefreshGate = null;
  let autoRefreshRelease = null;
  autoRefreshGate = new Promise((resolve) => {
    autoRefreshRelease = resolve;
  });
  await page.route('**/api/models{,/refresh}', async (route) => {
    if (route.request().method() === 'POST') {
      posts += 1;
      await new Promise((resolve) => {
        manualResponse = resolve;
      });
      return route.fulfill({ json: catalogueWithFable() });
    }
    reads += 1;
    if (reads === 2) {
      // Deterministic automatic refresh: hold the dialog-triggered refresh until
      // the test has observed the refreshing status, so the assertion cannot race
      // the mocked network round-trip. Release happens right after the status check.
      await autoRefreshGate;
      return route.fulfill({ json: catalogueWithFable({ retired: true, refreshing: false }) });
    }
    return route.fulfill({ json: catalogueWithFable({ retired: reads > 1, refreshing: reads === 1 }) });
  });
  await page.goto(fixture.url);
  const freeId = 'openrouter/minimax/minimax-m3:free';
  const freeRow = page.locator(`.model-row[data-model-id="${freeId}"]`);
  await expect(page.locator('#model-select')).toHaveValue(freeId);
  await page.locator('#thinking-select').selectOption('high');
  await page.locator('#model-picker-button').click();
  await expect(page.locator('#model-results-status')).toHaveText('Actualisation des modèles…');
  autoRefreshRelease();
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

  // Anthropic Claude Fable 5.2: picker/search exposes the inert fixture,
  // selection persists, and every documented effort level persists (off excluded).
  await page.locator('#model-picker-button').click();
  await page.locator('#model-search').fill('fable');
  const fableRow = page.locator(`.model-row[data-model-id="${FABLE_ID}"]`);
  await expect(fableRow).toBeVisible();
  await expect(fableRow.locator('.model-choice')).toBeEnabled();
  await expect(fableRow).toContainText('Claude Fable 5.2');
  await expect(fableRow).toContainText(FABLE_ID);
  await expect(page.locator('.model-row')).toHaveCount(1);
  await expect(page.locator('#model-results-status')).toHaveText('1 résultat');
  await expect(page.locator('#model-search')).toHaveValue('fable');
  await mkdir(resolve('.local/study/claude-fable-52'), { recursive: true });
  await page.screenshot({
    path: resolve('.local/study/claude-fable-52/model-catalogue-fable-52.png'),
    animations: 'disabled',
  });
  await fableRow.locator('.model-choice').click();
  await expect(page.locator('#model-select')).toHaveValue(FABLE_ID);
  // The composer keeps generic requested preferences. Native clamping of
  // unsupported levels (including off) is covered by anthropic-models.test.mjs.
  for (const level of FABLE_THINKING) {
    await page.locator('#thinking-select').selectOption(level);
    await expect(page.locator('#thinking-select')).toHaveValue(level);
    await expect(page.locator('#model-select')).toHaveValue(FABLE_ID);
  }
  // Native UI evidence via the real Studio HTTP route (mocked inert catalogue):
  // metadata matches studio-models (context 1M, 128K output, vision, effort set, no off).
  const fableCatalog = await page.evaluate(async () => await (await fetch('/api/models')).json());
  const fableEntry = fableCatalog.models.find((model) => model.id === FABLE_ID);
  expect(fableEntry).toBeTruthy();
  expect(fableEntry.provider).toBe('anthropic');
  expect(fableEntry.availability).toBe('available');
  expect(fableEntry.contextWindow).toBe(1000000);
  expect(fableEntry.maxTokens).toBe(128000);
  expect(fableEntry.input).toEqual(['text', 'image']);
  expect(fableEntry.thinkingLevels).toEqual(FABLE_THINKING);
  expect(fableEntry.thinkingLevels).not.toContain('off');
  // Other providers remain alongside anthropic (regression).
  const providers = [...new Set(fableCatalog.models.map((model) => model.provider))].sort();
  expect(providers).toContain('anthropic');
  expect(providers).toContain('openrouter');
  expect(providers).toContain('prime-inference');
  checks.push(
    'Anthropic Claude Fable 5.2 is searchable, selectable, and retains every supported effort level, with native capability metadata excluding off and including vision/context; other providers remain.',
  );

  const mobile = await browser.newPage({ locale: 'en-US', viewport: { width: 390, height: 844 } });
  mobile.on('pageerror', (error) => errors.push(error.message));
  await mobile.route('**/api/models', (route) => route.fulfill({ json: catalogueWithFable() }));
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
  let offlineRefreshRelease = null;
  const offlineRefreshGate = new Promise((resolve) => {
    offlineRefreshRelease = resolve;
  });
  await offline.route('**/api/models', async (route) => {
    offlineReads += 1;
    if (offlineReads === 1) return route.fulfill({ json: catalogueWithFable({ refreshing: true }) });
    // Deterministic offline interrupt: hold the dialog-triggered refresh until the
    // test has gone offline, so the continued network attempt must fail while offline.
    await offlineRefreshGate;
    return route.continue();
  });
  await offline.goto(fixture.url);
  await offline.locator('#composer').fill('Brouillon conservé hors connexion');
  await offline.locator('#thinking-select').selectOption('high');
  await offline.locator('#model-picker-button').click();
  await expect(offline.locator('#model-results-status')).toHaveText('Actualisation des modèles…');
  await offline.locator('#model-search').fill('minimax');
  await offline.context().setOffline(true);
  offlineRefreshRelease();
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
