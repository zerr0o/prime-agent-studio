import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRoadmapFixture } from './fixtures/roadmap.mjs';

// Isolated real routes/storage: no user's projects, live server or provider is accessed.
const fixture = await createRoadmapFixture();
const out = resolve('test-results/roadmap-compact');
await mkdir(out, { recursive: true });
const checks = [],
  errors = [],
  writes = [];
const panel = (page) => page.locator('#roadmap-panel');
const roadmapFile = join(fixture.cwd, '.prime', 'studio', 'roadmap.json');
const stored = () => readFile(roadmapFile, 'utf8');
const change = async (action, params = {}) => {
  const doc = await fixture.app.roadmap.read(fixture.cwd);
  return fixture.app.roadmap.mutate(fixture.cwd, { action, expectedRevision: doc.revision, ...params });
};
let doc = await fixture.app.roadmap.read(fixture.cwd);
const firstPlanId = doc.plans[0].id;
const parentId = doc.plans[0].steps[1].id;
const rightId = doc.plans[0].steps[1].children[1].id;
await change('step.edit', {
  planId: firstPlanId,
  stepId: parentId,
  note: 'Comparer les deux canaux avant de valider le groupe.',
});
const deepTitle =
  'Vérifier une configuration de calibration avec plusieurs interfaces et conserver toutes les mesures de référence';
doc = await change('plan.create', {
  title: 'Contrôles détaillés sur un petit écran',
  summary: 'Une description détaillée du plan qui reste consultable sans encombrer la checklist.',
  milestone: doc.overview.milestones[1].id,
  steps: [
    {
      text: deepTitle,
      note: 'ConfigurationAvecUnIdentifiantLongSansEspacePourVérifierLeRetourÀLaLigne'.repeat(3),
      children: [
        {
          text: 'Comparer la réponse impulsionnelle et vérifier les paramètres des deux interfaces audio',
          note: 'Conserver les paramètres et les résultats de chaque vérification.',
          children: [
            {
              text: 'MesureDeRéférenceAvecUnIdentifiantExtrêmementLongSansEspace'.repeat(2),
              done: true,
              note: 'Valeur attendue : une réponse stable.',
            },
            {
              text: 'Reproduire la mesure depuis le téléphone avec le même microphone et la même fréquence de référence',
              note: 'Ne pas modifier le niveau sonore entre deux mesures.',
            },
          ],
        },
      ],
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      text: `Contrôle complémentaire ${index + 1} pour vérifier le défilement`,
      note: 'Cette description est masquée par défaut.',
    })),
  ],
});
const deepPlanId = doc.plans.at(-1).id;
const deepParentId = doc.plans.at(-1).steps[0].id;
const deepChildId = doc.plans.at(-1).steps[0].children[0].id;
for (let index = 0; index < 5; index++) {
  await change('plan.create', {
    title: `Vérification complémentaire ${index + 1}`,
    steps: [{ text: 'Conserver un résultat vérifiable' }],
  });
}
const browser = await launchStudioBrowser({ channel: 'chrome' });
const pages = [];
async function open({ locale = 'fr-FR', width = 1600, mobile = false, readOnly = false } = {}) {
  const page = await browser.newPage({
    locale,
    viewport: { width, height: 960 },
    isMobile: mobile,
    hasTouch: mobile,
  });
  pages.push(page);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname.startsWith('/api/roadmap') &&
      !['GET', 'HEAD'].includes(request.method())
    )
      writes.push({ method: request.method(), path: new URL(request.url()).pathname });
  });
  await page.addInitScript((cwd) => {
    localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId: 'calibration-demo' }));
  }, fixture.cwd);
  if (readOnly) {
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch();
      const overview = await response.json();
      overview.preferences = { ...overview.preferences, readOnly: true, remote: true };
      await route.fulfill({ response, json: overview });
    });
  }
  await page.goto(fixture.url);
  await page.locator('#open-roadmap').click();
  await expect(panel(page)).toContainText('Fiabiliser le parcours de mesure');
  return page;
}
const plan = (page, id = firstPlanId) => panel(page).locator(`.rm-plan[data-plan-id="${id}"]`);
const step = (page, id, planId = firstPlanId) => plan(page, planId).locator(`.rm-step[data-step-id="${id}"]`);
const description = (scope, key) =>
  scope.locator(`.rm-description-disclosure[data-description-key="${key}"]`);
const count = (scope, head) => scope.locator(head).locator('.rm-inline-count');
async function openPlan(page, id = firstPlanId) {
  const toggle = plan(page, id).locator(':scope > .rm-plan-head > .rm-plan-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}
async function assertNoOverflow(page) {
  const metrics = await panel(page).evaluate((el) => {
    const content = el.querySelector('.rm-content');
    return {
      viewport: innerWidth,
      panel: el.scrollWidth,
      content: content.scrollWidth,
      available: content.clientWidth,
      document: document.documentElement.scrollWidth,
    };
  });
  expect(metrics.panel, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.content, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.available + 1);
  expect(metrics.document, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport);
}
try {
  const initial = await stored();
  const page = await open();
  await openPlan(page);
  const summary = description(plan(page), `plan:${firstPlanId}`);
  await expect(summary.locator('.rm-description-toggle')).toHaveText('Afficher la description');
  await expect(summary.locator('.rm-description')).toBeHidden();
  await summary.locator('.rm-description-toggle').click();
  await expect(summary.locator('.rm-description')).toBeVisible();
  await expect(summary.locator('.rm-description-toggle')).toHaveText('Masquer la description');
  const note = description(plan(page), `step:${firstPlanId}:${parentId}`);
  await expect(note.locator('.rm-description')).toBeHidden();
  await note.locator('.rm-description-toggle').click();
  await expect(note.locator('.rm-description')).toBeVisible();
  await plan(page).locator('.rm-plan-toggle').click();
  await openPlan(page);
  await expect(summary.locator('.rm-description')).toBeVisible();
  await expect(note.locator('.rm-description')).toBeVisible();
  expect(await stored()).toBe(initial);
  checks.push(
    'Plan and task descriptions start collapsed; explicit choices survive plan collapse/reopen without changing persisted data.',
  );

  const parent = step(page, parentId);
  const parentToggle = parent.locator(':scope > .rm-step-row .rm-step-toggle');
  await expect(parentToggle).toHaveAttribute('aria-expanded', 'true');
  await parentToggle.click();
  await expect(parentToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(parent.locator(':scope > .rm-steps')).toBeHidden();
  await expect(count(parent, ':scope > .rm-step-row')).toHaveText('1/2');
  await expect(count(parent, ':scope > .rm-step-row')).toBeVisible();
  expect(await stored()).toBe(initial);
  await change('step.check', { planId: firstPlanId, stepId: rightId, done: true });
  await expect(count(parent, ':scope > .rm-step-row')).toHaveText('2/2', { timeout: 10000 });
  await expect(parentToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(summary.locator('.rm-description')).toBeVisible();
  await expect(note.locator('.rm-description')).toBeVisible();
  await expect(count(plan(page), ':scope > .rm-plan-head')).toHaveText('3/4');
  checks.push(
    'A folded parent shows leaf-only completion counts; a second-device mutation refreshes its count without reopening it or resetting descriptions.',
  );

  const afterExternal = await stored();
  await panel(page).getByRole('button', { name: 'Fermer la roadmap', exact: true }).click();
  await page.locator('#open-roadmap').click();
  await expect(parentToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(summary.locator('.rm-description')).toBeVisible();
  await summary.locator('.rm-description-toggle').click();
  await note.locator('.rm-description-toggle').click();
  await expect(summary.locator('.rm-description')).toBeHidden();
  await expect(note.locator('.rm-description')).toBeHidden();

  const milestone = panel(page).locator('.rm-milestone').first();
  await milestone.locator(':scope > .rm-section-head .rm-milestone-toggle').click();
  const ungrouped = panel(page).locator('.rm-ungrouped-group');
  await ungrouped.locator('.rm-group-toggle').click();
  await expect(ungrouped.locator('.rm-group-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(count(ungrouped, ':scope > .rm-section-head')).toHaveText('0/5');
  await ungrouped.locator('.rm-group-toggle').click();
  await expect(milestone.locator(':scope > .rm-section-head .rm-milestone-toggle')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(count(milestone, ':scope > .rm-section-head')).toHaveText('3/6');
  await expect(count(milestone, ':scope > .rm-section-head')).toBeVisible();
  await milestone.locator(':scope > .rm-section-head .rm-milestone-toggle').click();
  checks.push(
    'Milestones, plans and nested parents expose compact completion totals; closing and reopening the panel keeps presentation choices.',
  );

  await openPlan(page, deepPlanId);
  const scroll = panel(page).locator('.rm-content');
  await scroll.evaluate((el) => {
    el.scrollTop = 120;
  });
  const scrollBefore = await scroll.evaluate((el) => el.scrollTop);
  expect(scrollBefore).toBeGreaterThan(50);
  await panel(page).getByRole('button', { name: 'Agrandir la roadmap', exact: true }).click();
  await expect(page.locator('body')).toHaveClass(/roadmap-expanded/);
  await expect(panel(page)).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.app-shell')).toHaveAttribute('inert', '');
  const expandedBox = await panel(page).boundingBox();
  expect(expandedBox.width).toBeGreaterThan(1000);
  await page.screenshot({ path: resolve(out, 'desktop-expanded.png') });
  await page.keyboard.press('Shift+Tab');
  expect(await panel(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  await expect(panel(page).getByRole('button', { name: 'Réduire la roadmap', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/roadmap-expanded/);
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '');
  await expect(panel(page).getByRole('button', { name: 'Agrandir la roadmap', exact: true })).toBeFocused();
  expect(Math.abs((await scroll.evaluate((el) => el.scrollTop)) - scrollBefore)).toBeLessThanOrEqual(2);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#open-roadmap')).toBeFocused();
  expect(await stored()).toBe(afterExternal);
  checks.push(
    'Expanded desktop view is modal; Escape first reduces, then closes, preserving scroll and restoring focus with no document writes.',
  );

  await page.locator('#open-roadmap').click();
  await panel(page).getByRole('button', { name: 'Agrandir la roadmap', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Ajouter un plan', exact: true }).click();
  await expect(page.locator('.rm-editor')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.rm-editor')).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/roadmap-expanded/);
  await panel(page).getByRole('button', { name: 'Réduire la roadmap', exact: true }).click();
  checks.push(
    'Keyboard focus stays inside the expanded view; cancelling an editor leaves the underlying expanded roadmap open.',
  );
  await panel(page).getByRole('button', { name: 'Backlog', exact: true }).click();
  const tasks = panel(page).locator('.rm-backlog-group[data-backlog-kind="item"]');
  const firstTask = tasks.locator('.rm-backlog-row').first();
  const taskDescription = firstTask.locator('.rm-description-disclosure');
  await expect(taskDescription.locator('.rm-description')).toBeHidden();
  await taskDescription.locator('.rm-description-toggle').click();
  await expect(taskDescription.locator('.rm-description')).toBeVisible();
  await tasks.locator('.rm-group-toggle').click();
  await expect(tasks.locator('.rm-backlog-items')).toBeHidden();
  await expect(count(tasks, ':scope > .rm-section-head')).toHaveText('0/2');
  await tasks.locator('.rm-group-toggle').click();
  await expect(taskDescription.locator('.rm-description')).toBeVisible();
  const intentions = panel(page).locator('.rm-backlog-group[data-backlog-kind="note"]');
  await expect(intentions.locator('.rm-description')).toBeHidden();
  await intentions.locator('.rm-description-toggle').click();
  await expect(intentions.locator('.rm-description')).toBeVisible();
  await page.screenshot({ path: resolve(out, 'backlog-descriptions.png') });
  expect(await stored()).toBe(afterExternal);
  checks.push(
    'Backlog groups fold and retain their completion total; task and intention notes are explicitly expandable and preserve their state.',
  );

  const readOnly = await open({ readOnly: true, width: 1280 });
  await expect(panel(readOnly)).toContainText('Consultation seule');
  await openPlan(readOnly);
  await expect(plan(readOnly).getByRole('checkbox').first()).toBeDisabled();
  await description(plan(readOnly), `plan:${firstPlanId}`).locator('.rm-description-toggle').click();
  await expect(description(plan(readOnly), `plan:${firstPlanId}`).locator('.rm-description')).toBeVisible();
  await step(readOnly, parentId).locator(':scope > .rm-step-row .rm-step-toggle').click();
  await expect(step(readOnly, parentId).locator(':scope > .rm-steps')).toBeHidden();
  await panel(readOnly).getByRole('button', { name: 'Agrandir la roadmap', exact: true }).click();
  await expect(panel(readOnly)).toHaveAttribute('aria-modal', 'true');
  expect(await stored()).toBe(afterExternal);
  checks.push(
    'Read-only clients retain expand, collapse and description controls while mutation controls stay disabled.',
  );

  for (const width of [320, 393]) {
    const mobile = await open({ width, mobile: true });
    await expect(panel(mobile).locator('.rm-expand')).toBeHidden();
    await expect(panel(mobile)).toHaveAttribute('aria-modal', 'true');
    await openPlan(mobile, deepPlanId);
    await assertNoOverflow(mobile);
    const root = step(mobile, deepParentId, deepPlanId);
    const nested = step(mobile, deepChildId, deepPlanId);
    const foldAll = plan(mobile, deepPlanId).locator('.rm-task-tools button');
    const beforeFolding = await stored();
    await foldAll.tap();
    await expect(foldAll).toHaveText('Tout déplier');
    await expect(root).toBeVisible();
    await expect(nested).toBeHidden();
    await expect(plan(mobile, deepPlanId).locator('.rm-plan-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await foldAll.tap();
    await expect(foldAll).toHaveText('Tout replier');
    await expect(nested).toBeVisible();
    await expect(nested.locator(':scope > .rm-steps')).toBeVisible();
    expect(await stored()).toBe(beforeFolding);
    await mobile.screenshot({ path: resolve(out, `all-tasks-${width}.png`) });
    checks.push(
      `Plan-local fold/unfold at ${width}px keeps root tasks, counts and plan visible, without writes.`,
    );
    await expect(count(root, ':scope > .rm-step-row')).toHaveText('1/2');
    await expect(count(nested, ':scope > .rm-step-row')).toHaveText('1/2');
    await description(plan(mobile, deepPlanId), `step:${deepPlanId}:${deepParentId}`)
      .locator('.rm-description-toggle')
      .tap();
    await assertNoOverflow(mobile);
    const tapToggle = root.locator(':scope > .rm-step-row .rm-step-toggle');
    const box = await tapToggle.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(43);
    expect(box.height).toBeGreaterThanOrEqual(43);
    await tapToggle.tap();
    await expect(root.locator(':scope > .rm-steps')).toBeHidden();
    await expect(count(root, ':scope > .rm-step-row')).toHaveText('1/2');
    await tapToggle.tap();
    await expect(root.locator(':scope > .rm-steps')).toBeVisible();
    await assertNoOverflow(mobile);
    await mobile.screenshot({ path: resolve(out, `mobile-${width}.png`) });
    await panel(mobile).getByRole('button', { name: 'Fermer la roadmap', exact: true }).click();
    await expect(mobile.locator('.app-shell')).not.toHaveAttribute('inert', '');
  }
  checks.push(
    '320px and 393px touch layouts remain full screen without overflow for three levels, long labels and expanded notes; group controls provide 44px touch targets.',
  );

  const english = await open({ locale: 'en-US', width: 1366 });
  await openPlan(english);
  const enSummary = description(plan(english), `plan:${firstPlanId}`);
  await expect(enSummary.locator('.rm-description-toggle')).toHaveText('Show description');
  await enSummary.locator('.rm-description-toggle').click();
  await expect(enSummary.locator('.rm-description-toggle')).toHaveText('Hide description');
  await panel(english).getByRole('button', { name: 'Expand roadmap', exact: true }).click();
  await expect(panel(english).getByRole('button', { name: 'Reduce roadmap', exact: true })).toBeVisible();
  await english.screenshot({ path: resolve(out, 'desktop-expanded-en.png') });
  expect(await stored()).toBe(afterExternal);
  expect(writes).toEqual([]);
  expect(fixture.calls).toEqual([]);
  expect(errors).toEqual([]);
  checks.push(
    'French and English controls are translated; all presentation interactions issue zero roadmap mutations and zero model calls.',
  );
  await writeFile(
    resolve(out, 'proof.json'),
    JSON.stringify({ checks, errors, writes, modelCalls: fixture.calls.length }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors, writes, modelCalls: fixture.calls.length }, null, 2));
} catch (error) {
  for (const [index, page] of pages.entries())
    await page.screenshot({ path: resolve(out, `failure-${index}.png`) }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await fixture.close();
}
