import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRoadmapFixture } from './fixtures/roadmap.mjs';

const fixture = await createRoadmapFixture();
const browser = await chromium.launch({
  channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome',
  headless: true,
});
const errors = [];
const out = resolve('test-results/roadmap-archive');
await mkdir(out, { recursive: true });
const panel = (page) => page.locator('#roadmap-panel');
const planByTitle = (page, title) => panel(page).locator('.rm-plan').filter({ hasText: title }).first();
async function openMenu(plan) {
  const menu = plan.locator('.rm-menu').first();
  const summary = menu.locator('summary').first();
  if (await menu.evaluate((el) => !el.open)) await summary.click();
  return menu;
}
try {
  const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    (cwd) => localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId: 'calibration-demo' })),
    fixture.cwd,
  );
  await page.goto(fixture.url);
  await page.locator('#open-roadmap').click();
  await expect(panel(page)).toContainText('Fiabiliser le parcours de mesure');
  await expect(panel(page).getByRole('button', { name: /Archivés \(\d+\)/ })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Archivés (0)' })).toBeVisible();

  const first = planByTitle(page, 'Fiabiliser le parcours de mesure');
  await expect(first).toBeVisible();
  const menu = await openMenu(first);
  await expect(menu.getByRole('button', { name: 'Archiver', exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(out, 'menu-archiver.png') });

  await menu.getByRole('button', { name: 'Archiver', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Archivés (1)' })).toBeVisible({ timeout: 10000 });
  await expect(planByTitle(page, 'Fiabiliser le parcours de mesure')).toHaveCount(0);

  let doc = await fixture.app.roadmap.read(fixture.cwd);
  const archived = doc.plans.find((entry) => entry.title === 'Fiabiliser le parcours de mesure');
  expect(archived.archived).toBe(true);
  expect(Number.isSafeInteger(archived.archivedAt)).toBe(true);

  await panel(page).getByRole('button', { name: 'Archivés (1)' }).click();
  await expect(panel(page)).toContainText('Les plans archivés sont en lecture seule');
  await expect(planByTitle(page, 'Fiabiliser le parcours de mesure')).toBeVisible();
  await expect(panel(page)).toContainText('Archivé');
  await page.screenshot({ path: resolve(out, 'archived-tab.png') });

  const archivedPlan = planByTitle(page, 'Fiabiliser le parcours de mesure');
  const archivedMenu = await openMenu(archivedPlan);
  await expect(archivedMenu.getByRole('button', { name: 'Restaurer', exact: true })).toBeVisible();
  await expect(archivedMenu.getByRole('button', { name: 'Restaurer', exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(out, 'menu-restore.png') });

  await archivedMenu.getByRole('button', { name: 'Restaurer', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Archivés (0)' })).toBeVisible({ timeout: 10000 });
  doc = await fixture.app.roadmap.read(fixture.cwd);
  expect(doc.plans.find((entry) => entry.title === 'Fiabiliser le parcours de mesure').archived).toBe(false);

  await panel(page).getByRole('button', { name: 'Projet', exact: true }).click();
  await expect(planByTitle(page, 'Fiabiliser le parcours de mesure')).toBeVisible();
  const back = planByTitle(page, 'Fiabiliser le parcours de mesure');
  const backMenu = await openMenu(back);
  await backMenu.getByRole('button', { name: 'Archiver', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: /Archivés \(1\)/ })).toBeVisible({ timeout: 10000 });
  await panel(page).getByRole('button', { name: 'Archivés (1)' }).click();
  const doomed = planByTitle(page, 'Fiabiliser le parcours de mesure');
  const doomedMenu = await openMenu(doomed);
  await doomedMenu.getByRole('button', { name: 'Supprimer', exact: true }).click();
  const editor = page.locator('.rm-editor');
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect(panel(page)).toContainText('Aucun plan archivé');
  doc = await fixture.app.roadmap.read(fixture.cwd);
  expect(doc.plans.some((entry) => entry.title === 'Fiabiliser le parcours de mesure')).toBe(false);

  expect(errors).toEqual([]);
  console.log('Roadmap archive UI PASS: menu Archiver, tab Archives avec compteur, lecture seule, restauration et suppression.');
} finally {
  await browser.close();
  await fixture.close();
}
