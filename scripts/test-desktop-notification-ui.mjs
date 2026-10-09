// Isolated browser regression for Windows notification click activation.
// Synthetic native open events only (same CustomEvent the Rust toast handler
// dispatches). No installed app launch, no user sessions, network or credentials.
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNavigationFixture } from './fixtures/project-navigation.mjs';

const checks = [];
const errors = [];

const fixture = await createNavigationFixture();
await mkdir(resolve('test-results/desktop-notification'), { recursive: true });

// Worktree-shaped case: entry execution cwd differs from the owning project.
// Grouped under Atelier through the store worktree binding, like production.
const wtAtelier = (await (await fetch(`${fixture.url}/api/overview`)).json()).projects.find((p) =>
  String(p.name || '').includes('Atelier'),
);
const wtCwd = join(fixture.root, 'worktree-task');
{
  const timestamp = new Date().toISOString();
  const lines = [
    { type: 'session', id: 'notify-worktree-0', cwd: wtCwd, timestamp },
    {
      type: 'message',
      id: 'notify-worktree-0-u',
      parentId: null,
      timestamp,
      message: { role: 'user', content: 'Tache worktree a rouvrir', timestamp },
    },
    {
      type: 'message',
      id: 'notify-worktree-0-a',
      parentId: 'notify-worktree-0-u',
      timestamp,
      message: { role: 'assistant', content: 'Resultat worktree conserve.', stopReason: 'stop', timestamp },
    },
  ];
  await writeFile(
    join(fixture.root, 'sessions', 'notify-worktree-0.jsonl'),
    lines.map(JSON.stringify).join('\n') + '\n',
  );
  await fixture.app.store.bindSessionWorktree({
    id: 'notify-worktree-0',
    worktreeId: 'wt-abcdef123456',
    projectCwd: wtAtelier.cwd,
  });
}

let browser;
try {
  browser = await launchStudioBrowser({ channel: 'chrome' });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(fixture.url);

  const overview = await (await fetch(`${fixture.url}/api/overview`)).json();
  const projects = overview.projects || [];
  expect(projects.length).toBeGreaterThanOrEqual(2);
  const withSessions = projects.filter((p) => (p.sessions || []).some((s) => s.id && !s.archived));
  expect(withSessions.length).toBeGreaterThanOrEqual(2);
  const first = withSessions[0];
  const second = withSessions[1];
  const prev = first.sessions.find((s) => s.id && !s.archived);
  const target = second.sessions.find((s) => s.id && !s.archived);
  expect(prev?.id).toBeTruthy();
  expect(target?.id).toBeTruthy();
  expect(second.cwd).not.toBe(first.cwd);

  const headerSession = page.locator('#header-session');
  const headerProject = page.locator('#header-project');
  const openEvent = (id) =>
    page.evaluate(
      (sid) =>
        window.dispatchEvent(
          new CustomEvent('prime-desktop-notification-open', { detail: { sessionId: sid } }),
        ),
      id,
    );

  // Baseline: open a session in the first project through the native event path.
  await openEvent(prev.id);
  await expect(headerSession).toContainText(prev.title.slice(0, 24), { timeout: 10000 });
  checks.push('Evenement natif synthetique ouvre la session de reference');

  // Draft on the current conversation, then Settings + held Alt wheel open.
  const draftText = 'Brouillon notification a conserver';
  await page.locator('#composer').fill(draftText);
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.keyboard.down('Alt');
  await expect(page.locator('#session-wheel')).toBeVisible();

  // Cross-project activation: dialogs dismissed, owner project adopted, draft kept.
  await openEvent(target.id);
  await expect(page.locator('#session-wheel')).toBeHidden();
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await expect(headerSession).toContainText(target.title.slice(0, 24), { timeout: 10000 });
  await expect(headerProject).toContainText(second.name || second.cwd.split(/[\\/]/).pop());
  const selection = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('prime-studio.selection') || '{}'),
  );
  expect(selection.sessionId).toBe(target.id);
  const drafts = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('prime-studio.drafts') || '{}');
    } catch {
      return {};
    }
  });
  expect(drafts[`session:${prev.id}`]).toBe(draftText);
  checks.push('Activation interprojets : modales fermees, projet proprietaire, brouillon conserve');

  // No stale Alt hold: a fresh Alt cycle still opens and Escape cancels in place.
  const steadyHeader = await headerSession.innerText();
  await page.keyboard.up('Alt').catch(() => {});
  await page.keyboard.down('Alt');
  await expect(page.locator('#session-wheel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#session-wheel')).toBeHidden();
  await page.keyboard.up('Alt').catch(() => {});
  expect(await headerSession.innerText()).toBe(steadyHeader);
  checks.push('Roue Alt annulee proprement, sans selection persistante');

  // Malformed and missing ids are ignored without touching the UI.
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await openEvent('../evil');
  await openEvent('');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('prime-desktop-notification-open')));
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('prime-desktop-notification-open', { detail: {} })),
  );
  await expect(page.locator('#settings-dialog')).toBeVisible();
  expect(await headerSession.innerText()).toBe(steadyHeader);
  const selectionAfter = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('prime-studio.selection') || '{}'),
  );
  expect(selectionAfter.sessionId).toBe(target.id);
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden();
  checks.push('Ids malformes ou absents ignores, modale et selection inchangees');

  // Worktree session: owner project adopted, execution cwd kept for the run.
  const wtEntry = (await (await fetch(`${fixture.url}/api/overview`)).json()).projects
    .find((p) => String(p.name || '').includes('Atelier'))
    .sessions.find((s) => s.id === 'notify-worktree-0');
  expect(wtEntry?.cwd).toBe(wtCwd);
  await openEvent('notify-worktree-0');
  await expect(headerSession).toContainText('Tache worktree', { timeout: 10000 });
  await expect(headerProject).toContainText('Atelier');
  const wtSelection = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('prime-studio.selection') || '{}'),
  );
  expect(wtSelection.sessionId).toBe('notify-worktree-0');
  expect(wtSelection.cwd).toBe(wtAtelier.cwd);
  checks.push('Session worktree : projet proprietaire adopte, cwd execution conserve');

  // A settings child manager reopened by its own close handler still ends closed.
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('#settings-tab-models').click();
  await page.locator('#open-model-config').click();
  await expect(page.locator('#model-config-dialog')).toBeVisible({ timeout: 10000 });
  await openEvent(prev.id);
  await expect(page.locator('#model-config-dialog')).toBeHidden();
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await expect(headerSession).toContainText(prev.title.slice(0, 24), { timeout: 10000 });
  // No late reopen after the close loop has finished.
  await page.waitForTimeout(500);
  await expect(page.locator('#model-config-dialog')).toBeHidden();
  await expect(page.locator('#settings-dialog')).toBeHidden();
  checks.push('Gestionnaire enfant des reglages referme sans rouvrir les preferences');

  // Update confirm accepted before then reopened: activation resolves cancel.
  const captured = await page.evaluate(
    (sid) =>
      new Promise((resolve) => {
        const dialog = document.getElementById('studio-update-confirm');
        dialog.showModal();
        dialog.close('proceed');
        dialog.showModal();
        dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
        window.dispatchEvent(
          new CustomEvent('prime-desktop-notification-open', { detail: { sessionId: sid } }),
        );
        setTimeout(() => resolve(`timeout:${dialog.returnValue}:${dialog.open}`), 3000);
      }),
    target.id,
  );
  expect(captured).toBe('cancel');
  await expect(page.locator('#studio-update-confirm')).toBeHidden();
  await expect(headerSession).toContainText(target.title.slice(0, 24), { timeout: 10000 });
  checks.push('Confirmation de mise a jour pre-acceptee puis rouverte : annulee, jamais confirmee');

  // The browser may have a stale overview when a background notification arrives.
  // Hide the worktree from cached summaries; its history still supplies the saved owner.
  for (const endpoint of ['bootstrap', 'overview']) {
    await page.route(`**/api/${endpoint}`, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      const overview = data.overview || data;
      for (const project of overview.projects || [])
        project.sessions = (project.sessions || []).filter((s) => s.id !== 'notify-worktree-0');
      await route.fulfill({ response, json: data });
    });
  }
  await page.reload();
  const otherProject = projects.find((p) => p.cwd !== wtAtelier.cwd && p.sessions?.length);
  const otherSession = otherProject.sessions.find((s) => s.id && !s.archived);
  await openEvent(otherSession.id);
  await expect(headerSession).toContainText(otherSession.title.slice(0, 24));
  await openEvent('notify-worktree-0');
  await expect(page.locator('#messages')).toContainText('Resultat worktree conserve.');
  await expect(headerProject).toContainText(wtAtelier.name);
  const recovered = await page.evaluate(() => JSON.parse(localStorage.getItem('prime-studio.selection')));
  expect(recovered.sessionId).toBe('notify-worktree-0');
  expect(recovered.cwd).toBe(wtAtelier.cwd);
  checks.push('Historique hors cache : liaison worktree conserve le projet proprietaire hors prefixe');

  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser?.close();
  await fixture.close();
}
