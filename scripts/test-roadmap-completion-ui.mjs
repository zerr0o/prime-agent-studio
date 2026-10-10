import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { createRoadmapFixture } from './fixtures/roadmap.mjs';

const fixture = await createRoadmapFixture();
let browser;
const errors = [];
const checks = [];
const deadline = setTimeout(() => {
  void browser?.close();
  void fixture.close();
}, 90000);
try {
  browser = await launchStudioBrowser();
  const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((cwd) => {
    localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId: 'calibration-demo' }));
    localStorage.setItem('prime-studio.language', 'fr');
  }, fixture.cwd);
  await page.goto(fixture.url);
  await page.locator('#open-roadmap').click();
  const panel = page.locator('#roadmap-panel');
  await panel.getByRole('button', { name: 'Fiabiliser le parcours de mesure', exact: true }).click();
  const check = panel.getByRole('checkbox', { name: 'Mesurer le canal droit', exact: true });
  const row = check.locator('xpath=ancestor::li[1]');
  const sent = page.waitForRequest(
    (request) => request.url().endsWith('/api/roadmap') && request.method() === 'POST',
  );
  await check.check();
  assert.equal((await sent).postDataJSON().sessionId, 'calibration-demo');
  const completion = row.locator('[data-completion-step]');
  await expect(completion).toHaveCount(1);
  await completion.locator('summary').click();
  await expect(completion).toHaveAttribute('open', '');
  await expect(completion).toContainText('calibration-demo');
  await expect(completion).toContainText('Machine');
  const document = await fixture.app.roadmap.read(fixture.cwd);
  const flatten = (steps) => steps.flatMap((step) => [step, ...flatten(step.children)]);
  const checked = document.plans
    .flatMap((plan) => flatten(plan.steps))
    .find((step) => step.text === 'Mesurer le canal droit');
  assert.equal(checked.completion.sessionId, 'calibration-demo');
  assert.ok(checked.completion.machineId);
  await expect(completion).toContainText(checked.completion.machineId);
  checks.push('manual check records selected conversation and shows server machine/session/time');
  const initial = structuredClone(checked.completion);
  await fixture.app.roadmap.mutate(fixture.cwd, {
    action: 'step.edit',
    expectedRevision: document.revision,
    planId: document.plans[0].id,
    stepId: checked.id,
    note: 'Completion must survive an unrelated edit.',
  });
  await expect(row).toContainText('Completion must survive an unrelated edit.');
  await expect(completion).toHaveAttribute('open', '');
  await expect(panel.locator('.rm-completion[open]')).toHaveCount(1);
  const afterEdit = await fixture.app.roadmap.read(fixture.cwd);
  assert.deepEqual(
    afterEdit.plans.flatMap((plan) => flatten(plan.steps)).find((step) => step.id === checked.id).completion,
    initial,
  );
  checks.push('completion and expanded disclosure survive unrelated refresh');
  await page.evaluate(async () => (await import('/public/i18n.js')).setLanguage('en'));
  await expect(completion.locator('summary')).toHaveText('Completion');
  await expect(completion).toContainText('Conversation');
  await expect(panel.locator('.rm-completion[open]')).toHaveCount(1);
  await mkdir('.local', { recursive: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await completion.scrollIntoViewIfNeeded();
    const bounds = await panel.evaluate((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth,
    }));
    assert.ok(bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
    await page.screenshot({ path: `.local/roadmap-completion-${width}.png`, animations: 'disabled' });
  }
  checks.push('FR/EN completion details fit 390px and 320px panels');
  await page.evaluate(async () => (await import('/public/i18n.js')).setLanguage('fr'));
  await page.setViewportSize({ width: 390, height: 844 });
  await completion.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.local/roadmap-completion-fr-390.png', animations: 'disabled' });
  await completion.locator('.rm-completion-link').click();
  await expect(panel).toBeHidden();
  assert.equal(fixture.calls.length, 0);
  await page.locator('#open-roadmap').click();
  await check.uncheck();
  await expect(completion).toHaveCount(0);
  const reopened = await fixture.app.roadmap.read(fixture.cwd);
  assert.equal(
    reopened.plans.flatMap((plan) => flatten(plan.steps)).find((step) => step.id === checked.id).completion,
    null,
  );
  checks.push('conversation opens without agent execution; reopening clears attribution');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  clearTimeout(deadline);
  await browser?.close();
  await fixture.close();
}
