import { chromium, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRoadmapFixture } from './fixtures/roadmap.mjs';

const fixture = await createRoadmapFixture();
const browser = await chromium.launch({
  channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome',
  headless: true,
});
const errors = [];
const out = resolve('test-results/roadmap-remaining');
await mkdir(out, { recursive: true });
const stored = () => readFile(join(fixture.cwd, '.prime/studio/roadmap.json'), 'utf8');
let doc = await fixture.app.roadmap.read(fixture.cwd);
const change = async (action, params) => {
  doc = await fixture.app.roadmap.mutate(fixture.cwd, { action, expectedRevision: doc.revision, ...params });
};
await change('plan.create', {
  title: 'Plan entièrement terminé',
  steps: [{ text: 'Livraison terminée', done: true }],
});
await change('plan.create', { title: 'Plan sans tâches' });
await change('backlog.set', { numbers: [doc.backlog.items[0].number], done: true });
try {
  const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    (cwd) =>
      localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId: 'calibration-demo' })),
    fixture.cwd,
  );
  await page.goto(fixture.url);
  await page.locator('#open-roadmap').click();
  const panel = page.locator('#roadmap-panel');
  await panel.getByRole('button', { name: 'Fiabiliser le parcours de mesure', exact: true }).click();
  const first = panel.locator('.rm-plan').filter({ hasText: 'Fiabiliser le parcours de mesure' });
  await expect(first.locator('.rm-plan-percent')).toHaveText('50%');
  const done = panel.getByRole('checkbox', { name: 'Préparer le protocole de mesure', exact: true });
  const mixed = panel.getByRole('checkbox', { name: 'Vérifier les canaux audio', exact: true });
  await expect(done).toBeChecked();
  await expect(mixed).toHaveJSProperty('indeterminate', true);
  const color = (el) => el.evaluate((box) => getComputedStyle(box).accentColor);
  expect(await color(done)).not.toBe(await color(mixed));
  const initial = await stored();
  const filter = panel.getByRole('button', { name: 'Reste à faire uniquement', exact: true });
  await filter.click();
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(done).toHaveCount(0);
  await expect(panel.getByRole('checkbox', { name: 'Mesurer le canal gauche', exact: true })).toHaveCount(0);
  await expect(mixed).toBeVisible();
  await expect(panel.getByRole('checkbox', { name: 'Mesurer le canal droit', exact: true })).toBeVisible();
  await expect(first.locator('.rm-plan-percent')).toHaveText('50%');
  const parent = mixed.locator('xpath=ancestor::li[1]');
  const collapse = parent.locator(':scope > .rm-step-row .rm-step-toggle');
  await collapse.click();
  await expect(collapse).toHaveAttribute('aria-expanded', 'false');
  await expect(parent.locator(':scope > .rm-steps')).toBeHidden();
  await collapse.click();
  await expect(parent.locator(':scope > .rm-steps')).toBeVisible();
  await page.screenshot({ path: join(out, 'remaining-desktop.png') });
  await panel.getByRole('button', { name: 'Session', exact: true }).click();
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(done).toHaveCount(0);
  await panel.getByRole('button', { name: 'Backlog', exact: true }).click();
  await expect(
    panel.locator('.rm-backlog-row').filter({ hasText: 'Comparer deux profils de calibration' }),
  ).toHaveCount(0);
  await expect(
    panel.locator('.rm-backlog-row').filter({ hasText: 'Tester le parcours depuis un téléphone' }),
  ).toBeVisible();
  await filter.click();
  await expect(
    panel.locator('.rm-backlog-row').filter({ hasText: 'Comparer deux profils de calibration' }),
  ).toBeVisible();
  const completedBacklog = panel
    .locator('.rm-backlog-row')
    .filter({ hasText: 'Comparer deux profils de calibration' });
  await completedBacklog.getByRole('button', { name: 'Sélectionner', exact: true }).click();
  await expect(panel.locator('.rm-selection')).toBeVisible();
  await filter.click();
  await expect(panel.locator('.rm-selection')).toHaveCount(0);
  await filter.click();
  await panel.getByRole('button', { name: 'Projet', exact: true }).click();
  await expect(done).toBeVisible();
  expect(await stored()).toBe(initial);
  expect(fixture.calls).toEqual([]);
  for (const width of [320, 393]) {
    await page.setViewportSize({ width, height: 852 });
    await filter.click();
    expect(await panel.evaluate((el) => el.scrollWidth <= innerWidth)).toBe(true);
    expect(await panel.locator('.rm-content').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: join(out, `remaining-${width}.png`) });
    await filter.click();
  }
  expect(errors).toEqual([]);
  console.log(
    'Roadmap remaining UI PASS: percentages, mixed/complete colors, recursive filtering, tabs, reversible read-only view, mobile width',
  );
} finally {
  await browser.close();
  await fixture.close();
}
