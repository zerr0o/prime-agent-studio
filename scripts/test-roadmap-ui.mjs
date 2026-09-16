import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRoadmapFixture } from './fixtures/roadmap.mjs';

const fixture = await createRoadmapFixture();
const browser = await chromium.launch({
  channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome',
  headless: true,
});
const errors = [],
  checks = [],
  out = resolve('test-results/roadmap');
await mkdir(out, { recursive: true });
const panel = (page) => page.locator('#roadmap-panel');
async function prepare(page) {
  await page.addInitScript(
    (cwd) =>
      localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId: 'calibration-demo' })),
    fixture.cwd,
  );
}
async function open(page) {
  await prepare(page);
  await page.goto(fixture.url);
  await page.locator('#open-roadmap').click();
  await expect(panel(page)).toContainText('Rendre la calibration');
}
try {
  const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await panel(page).getByRole('button', { name: 'Fiabiliser le parcours de mesure', exact: true }).click();
  await expect(
    panel(page).getByRole('checkbox', { name: 'Vérifier les canaux audio', exact: true }),
  ).toHaveJSProperty('indeterminate', true);
  await page.screenshot({ path: resolve(out, 'desktop.png') });
  expect(fixture.calls.length).toBe(0);
  checks.push(
    'Opening and expanding a roadmap makes no model call; native leaf counts and mixed parents are visible.',
  );

  await panel(page).getByRole('checkbox', { name: 'Vérifier les canaux audio', exact: true }).check();
  await expect(
    panel(page).getByRole('checkbox', { name: 'Mesurer le canal droit', exact: true }),
  ).toBeChecked();
  await panel(page).getByRole('checkbox', { name: 'Vérifier les canaux audio', exact: true }).uncheck();
  await expect(
    panel(page).getByRole('checkbox', { name: 'Mesurer le canal gauche', exact: true }),
  ).not.toBeChecked();
  checks.push('Checking and unchecking a group propagates symmetrically to its leaves.');
  let linking = await fixture.app.roadmap.read(fixture.cwd);
  await fixture.app.roadmap.mutate(fixture.cwd, {
    action: 'plan.attach',
    expectedRevision: linking.revision,
    planId: linking.plans[0].id,
    sessionId: 'child-closed',
  });
  const firstPlan = panel(page).locator('.rm-plan').first();
  await expect(firstPlan).toContainText('Conversations · 2');
  await firstPlan.locator('.rm-secondary').first().locator('summary').click();
  await firstPlan.getByRole('button', { name: 'Session · child-closed', exact: true }).click();
  await expect(page.locator('#inspector-viewer')).toBeVisible();
  await expect(page.locator('#inspector-view-body')).toContainText('convolution');
  await page.locator('#inspector-viewer').getByRole('button', { name: 'Fermer', exact: true }).click();
  expect(fixture.calls.length).toBe(0);
  checks.push('A persisted child session link opens the exact inspector transcript without starting a run.');

  const page2 = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
  await open(page2);
  await panel(page).getByRole('button', { name: 'Ajouter un plan', exact: true }).click();
  const editor = page.locator('.rm-editor');
  await editor.getByLabel('Titre', { exact: true }).fill('Brouillon conservé');
  const current = await fixture.app.roadmap.read(fixture.cwd);
  await fixture.app.roadmap.mutate(fixture.cwd, {
    action: 'vision',
    expectedRevision: current.revision,
    text: 'Direction modifiée depuis un autre appareil.',
  });
  await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(editor).toContainText('La roadmap a changé ailleurs');
  await expect(editor.getByLabel('Titre', { exact: true })).toHaveValue('Brouillon conservé');
  await editor.getByRole('button', { name: 'Actualiser et garder ma saisie' }).click();
  await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(panel(page2)).toContainText('Brouillon conservé');
  checks.push(
    'A stale edit is rejected, the draft survives and explicit refresh allows saving; a second device receives it.',
  );
  await panel(page).locator('.rm-vision').getByRole('button', { name: 'Modifier', exact: true }).click();
  await editor.locator('textarea').fill('Ancien brouillon PC');
  await editor.getByRole('button', { name: 'Annuler', exact: true }).click();
  let afterDraft = await fixture.app.roadmap.read(fixture.cwd);
  await fixture.app.roadmap.mutate(fixture.cwd, {
    action: 'vision',
    expectedRevision: afterDraft.revision,
    text: 'Version récente téléphone',
  });
  await expect(panel(page)).toContainText('Version récente téléphone');
  await panel(page).locator('.rm-vision').getByRole('button', { name: 'Modifier', exact: true }).click();
  await expect(editor.locator('textarea')).toHaveValue('Ancien brouillon PC');
  await expect(editor.getByRole('button', { name: 'Enregistrer', exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: 'Actualiser et garder ma saisie' }).click();
  await editor.locator('textarea').fill('Direction modifiée depuis un autre appareil.');
  await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  checks.push(
    'Reopening an old draft preserves its original revision and requires explicit rebase before replacing remote edits.',
  );

  await panel(page).getByRole('button', { name: 'Backlog', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Ajouter au backlog', exact: true }).click();
  await editor.getByLabel('Texte', { exact: true }).fill('Tâche créée depuis le Studio');
  await editor.getByLabel('Note', { exact: true }).fill('Sa note reste disponible après réorganisation.');
  await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(panel(page)).toContainText('Tâche créée depuis le Studio');
  const rows = panel(page).locator('.rm-backlog-row');
  const last = rows.filter({ hasText: 'Tâche créée depuis le Studio' });
  await last.locator('.rm-drag').dragTo(rows.first());
  await expect(rows.first()).toContainText('Tâche créée depuis le Studio');
  checks.push('Backlog task/note creation and real HTML drag reorder persist through the server.');

  await rows.first().getByRole('button', { name: 'Sélectionner', exact: true }).click();
  await panel(page).locator('.rm-selection').getByRole('button', { name: 'Travailler dessus' }).click();
  await editor.getByLabel('Conversation', { exact: true }).selectOption('');
  const instructions = editor.getByLabel('Instructions complémentaires (optionnel)', { exact: true });
  await instructions.fill('Vérifier le mode hors ligne.\nNe pas publier de version.');
  await expect(instructions).toHaveAttribute('maxlength', '4000');
  await page.screenshot({ path: resolve(out, 'handoff-instructions.png') });
  let beforeWork = await fixture.app.roadmap.read(fixture.cwd);
  await fixture.app.roadmap.mutate(fixture.cwd, {
    action: 'journal.add',
    expectedRevision: beforeWork.revision,
    planId: beforeWork.plans[0].id,
    text: 'Modification concurrente avant envoi.',
  });
  await editor.getByRole('button', { name: 'Travailler dessus', exact: true }).click();
  await expect(editor).toContainText('La roadmap a changé ailleurs');
  await expect(instructions).toHaveValue('Vérifier le mode hors ligne.\nNe pas publier de version.');
  expect(fixture.calls.length).toBe(0);
  await editor.getByRole('button', { name: 'Actualiser et garder ma saisie' }).click();
  await editor.getByRole('button', { name: 'Travailler dessus', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect.poll(() => fixture.calls.length).toBe(1);
  expect(fixture.calls[0].message).toContain('Tâche créée depuis le Studio');
  expect(fixture.calls[0].message).toContain('Vérifier le mode hors ligne.\nNe pas publier de version.');
  await expect(rows.first().locator('.rm-session-link')).toBeVisible();
  checks.push(
    'Explicit work creates exactly one normal run with the selected task and a durable conversation link.',
  );
  await panel(page).getByRole('button', { name: 'Fermer la roadmap' }).click();
  await page.locator('#composer').fill('/backlog');
  await page.locator('#send-button').click();
  await expect(panel(page).getByRole('button', { name: 'Backlog', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(fixture.calls.length).toBe(1);
  checks.push('The /backlog shortcut opens the shared backlog without sending a message to the model.');

  for (const width of [320, 375, 393]) {
    const mobile = await browser.newPage({
      locale: 'fr-FR',
      viewport: { width, height: 852 },
      isMobile: true,
      hasTouch: true,
    });
    mobile.on('pageerror', (e) => errors.push(e.message));
    await prepare(mobile);
    await mobile.goto(fixture.url);
    await mobile.locator('#open-roadmap').click();
    await expect(panel(mobile)).toContainText('Direction modifiée');
    await panel(mobile)
      .getByRole('button', { name: 'Fiabiliser le parcours de mesure', exact: true })
      .click();
    expect(await panel(mobile).evaluate((el) => el.scrollWidth <= innerWidth)).toBe(true);
    expect(
      await panel(mobile)
        .locator('.rm-content')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await mobile.screenshot({ path: resolve(out, `mobile-${width}.png`) });
    await panel(mobile).getByRole('button', { name: 'Ajouter un plan', exact: true }).click();
    await expect(mobile.locator('.rm-editor')).toBeVisible();
    await mobile.locator('.rm-editor').getByRole('button', { name: 'Annuler', exact: true }).click();
    await panel(mobile).getByRole('button', { name: 'Fermer la roadmap' }).click();
    await expect(mobile.locator('.app-shell')).not.toHaveAttribute('inert', '');
    await mobile.close();
  }
  checks.push('320/375/393px mobile views have no horizontal overflow; editor and close restore navigation.');
  await page2.close();
  const english = await browser.newPage({ locale: 'en-US', viewport: { width: 1366, height: 900 } });
  await prepare(english);
  await english.goto(fixture.url);
  await english.locator('#open-roadmap').click();
  await expect(panel(english).getByRole('button', { name: 'Project', exact: true })).toBeVisible();
  await panel(english).getByRole('button', { name: 'Backlog', exact: true }).click();
  await expect(panel(english)).toContainText('Ideas and intentions');
  await english.screenshot({ path: resolve(out, 'backlog-en.png') });
  expect(errors).toEqual([]);
  await writeFile(
    resolve(out, 'proof.json'),
    JSON.stringify({ checks, errors, modelCalls: fixture.calls.length }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
  await fixture.close();
}
