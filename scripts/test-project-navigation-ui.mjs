import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createNavigationFixture } from './fixtures/project-navigation.mjs';

const fixture = await createNavigationFixture();
const errors = [],
  checks = [];
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome',
    headless: true,
  });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(fixture.url);
  const project = (name) =>
    page.locator('.project-entry').filter({ has: page.locator('.project-label', { hasText: name }) });
  const sound = project('SoundsPerfect');
  await expect(sound.locator('.session-row')).toHaveCount(5);
  await expect(page.locator('.project-group-label')).toHaveText(['Épinglés', 'Projets']);
  await expect(project('Documentation').locator('.project-toggle')).toHaveAttribute('aria-expanded', 'false');
  await sound.locator('.project-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(sound.locator('.project-toggle')).toBeFocused();
  await expect(sound.locator('.project-conversations')).toBeHidden();
  await page.reload();
  await expect(sound.locator('.project-conversations')).toBeHidden();
  await sound.locator('.project-toggle').click();
  await sound.getByRole('button', { name: 'Afficher plus de conversations dans SoundsPerfect' }).click();
  await expect(sound.locator('.session-row')).toHaveCount(8);
  await sound.locator('[data-session-id="soundsperfect-5"] .session-select').click();
  await expect(page.locator('#header-session')).toContainText('Une ancienne conversation');
  await page.locator('#composer').fill('Brouillon à conserver');
  await sound.getByRole('button', { name: 'Afficher moins', exact: true }).click();
  await expect(sound.locator('[data-session-id="soundsperfect-5"].active')).toBeVisible();
  await expect(sound.locator('.session-row')).toHaveCount(6);
  await sound.locator('.project-toggle').click();
  await expect(page.locator('#composer')).toHaveValue('Brouillon à conserver');
  await expect(page.locator('#header-session')).toContainText('Une ancienne conversation');
  await sound.locator('.project-toggle').click();
  checks.push(
    'Hiérarchie, groupes épinglés, pagination, clavier et repli persistants sans changer la conversation ni son brouillon',
  );
  await page.locator('#session-search').fill('Documentation');
  await expect(page.locator('.project-entry')).toHaveCount(1);
  await expect(page.locator('.session-row')).toHaveCount(1);
  await expect(project('Documentation').locator('.project-conversations')).toBeVisible();
  await expect(page.locator('.project-drag-handle')).toHaveCount(0);
  await page.locator('#session-search').fill('aucune correspondance xyz');
  await expect(page.locator('#project-list')).toContainText('Aucune session ne correspond');
  await page.locator('#session-search').fill('');
  await page.locator('#show-archived').click();
  await expect(page.locator('.project-entry')).toHaveCount(1);
  await expect(page.locator('.session-row')).toHaveCount(1);
  await expect(page.locator('.session-row')).toHaveAttribute('data-session-id', 'documentation-1');
  await page.locator('#show-archived').click();
  checks.push(
    'Recherche interprojets et archives avec contexte du projet, aucune réorganisation pendant un filtre',
  );
  await expect(sound.locator('.project-row')).toHaveAttribute('data-activity', 'running');
  await expect(sound.locator('[data-session-id="stability-demo"]')).toHaveAttribute(
    'data-activity',
    'running',
  );
  await expect(project('Atelier').locator('.project-row')).toHaveAttribute('data-activity', 'unread');
  await expect(page.locator('[aria-current="page"].session-select')).toHaveCount(1);
  await expect.poll(async () => (await (await fetch(fixture.url + '/api/runs')).json()).runs.length).toBe(1);
  checks.push(
    'Activité et non-lus visibles à deux niveaux, un seul élément sélectionné, agent conservé en cours',
  );
  await page.locator('#composer').click();
  await mkdir(resolve('test-results'), { recursive: true });
  await page.screenshot({
    path: resolve('test-results/project-navigation-desktop.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('#sidebar')).toHaveClass(/mobile-open/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: resolve('test-results/project-navigation-mobile.png'),
    animations: 'disabled',
  });
  await project('Atelier').locator('.session-select').first().click();
  await expect(page.locator('#sidebar')).not.toHaveClass(/mobile-open/);
  await expect(page.locator('#header-project')).toContainText('Atelier');
  checks.push('Navigation mobile sans débordement, ouverture de la conversation refermant le volet');
  // The project menu targets its own project, not the currently selected one.
  await page.locator('#composer').fill('Brouillon Atelier à conserver');
  await page.locator('#toggle-sidebar').click();
  await sound.locator('.project-more').click();
  const menu = page.locator('#project-menu');
  await expect(menu.locator('[data-project-action]').first()).toHaveAttribute('data-project-action', 'new-session');
  await expect(menu.locator('[data-project-action]').nth(1)).toHaveAttribute('data-project-action', 'knowledge');
  await menu.getByRole('menuitem', { name: 'Nouvelle conversation', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#sidebar')).not.toHaveClass(/mobile-open/);
  await expect(page.locator('#header-project')).toContainText('SoundsPerfect');
  await expect(page.locator('#header-session')).toHaveText('Nouvelle session');
  await expect(page.locator('#composer')).toBeFocused();
  await expect(page.locator('#composer')).toHaveValue('');
  await expect(page.locator('.session-row.active')).toHaveCount(0);
  await expect.poll(async () => (await (await fetch(fixture.url + '/api/runs')).json()).runs.length).toBe(1);
  await page.locator('#toggle-sidebar').click();
  await project('Atelier').locator('.session-select').first().click();
  await expect(page.locator('#composer')).toHaveValue('Brouillon Atelier à conserver');
  await page.setViewportSize({ width: 1440, height: 960 });
  await sound.locator('.project-row').click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Nouvelle conversation', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#header-project')).toContainText('SoundsPerfect');
  await expect(page.locator('#composer')).toBeFocused();
  checks.push('Nouvelle conversation en tête du menu projet, bon projet sur mobile et au clavier, brouillon et agent en cours conservés');
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser?.close();
  await fixture.close();
}
