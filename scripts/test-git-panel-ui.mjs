// Git panel UI: mocked /api/project-git endpoints, real server for the rest.
// Never touches user repos: temp git fixture only. No build, no commit.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';
import { messages } from '../public/translations.js';

const exec = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), 'prime-git-panel-ui-'));
const cwd = join(temp, 'Atelier');
await mkdir(cwd, { recursive: true });
await mkdir('test-results/git-panel', { recursive: true });
const git = (...args) => exec('git', ['-C', cwd, ...args], { windowsHide: true });
await git('init', '-q', '-b', 'main');
await git('config', 'user.name', 'Fixture');
await git('config', 'user.email', 'fixture@example.test');
await writeFile(join(cwd, 'app.js'), 'const title = "Avant";\n');
await writeFile(join(cwd, 'notes.txt'), 'notes\n');
await git('add', '.');
await git('commit', '-qm', 'Initial');
await writeFile(join(cwd, 'app.js'), 'const title = "Après";\n');
await writeFile(join(cwd, 'new.txt'), 'nouveau fichier\n');

const app = createApp({
  initialCwd: cwd,
  agentHome: join(temp, 'agent'),
  sessionDir: join(temp, 'sessions'),
  dataDir: join(temp, 'data'),
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({ models: [], default: {} }),
    close: async () => {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;

// Mocked Git API state (the contract the real backend implements).
const gitState = {
  branch: 'main',
  head: 'a'.repeat(40),
  upstream: 'origin/main',
  ahead: 2,
  behind: 1,
  remote: true,
  dirty: true,
  branches: { local: ['main', 'feature'], remote: ['feature', 'hotfix'] },
};
const calls = [];
let failNext = null;
const status = () => ({ git: true, ...gitState });
const fr = (key) => messages[key].fr;
async function mockGit(route) {
  const request = route.request();
  const requestUrl = new URL(request.url());
  const tail = requestUrl.pathname.replace('/api/project-git', '') || '/';
  let body = {};
  try {
    body = request.postDataJSON() || {};
  } catch {
    body = {};
  }
  calls.push({ method: request.method(), route: tail, body, cwd: requestUrl.searchParams.get('cwd') });
  const reply = (code, payload) =>
    route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(payload) });
  if (failNext && failNext.route === tail) {
    const failure = failNext;
    failNext = null;
    return reply(failure.status, { error: failure.error });
  }
  if (request.method() === 'GET' && tail === '/') return reply(200, status());
  if (request.method() === 'POST' && tail === '/fetch') return reply(200, status());
  if (request.method() === 'POST' && tail === '/switch') {
    const { branch, create } = body;
    if (!branch || /[\s]/.test(branch)) return reply(400, { error: fr('git.panel_bad_branch') });
    if (create) {
      if (!gitState.branches.local.includes(branch)) gitState.branches.local.push(branch);
      gitState.branch = branch;
      gitState.upstream = null;
      gitState.ahead = 0;
      gitState.behind = 0;
    } else if (gitState.branches.local.includes(branch)) gitState.branch = branch;
    else if (gitState.branches.remote.includes(branch)) {
      gitState.branches.local.push(branch);
      gitState.branch = branch;
      gitState.upstream = `origin/${branch}`;
    } else return reply(404, { error: fr('git.panel_bad_branch') });
    return reply(200, status());
  }
  if (request.method() === 'POST' && tail === '/commit') {
    if (!String(body.message || '').trim()) return reply(400, { error: fr('git.panel_commit_message') });
    if (!Array.isArray(body.paths) || !body.paths.length)
      return reply(400, { error: fr('git.panel_commit_paths') });
    return reply(200, {
      ok: true,
      commit: 'f'.repeat(40),
      summary: '1 file changed',
      status: { ...gitState, dirty: false },
    });
  }
  if (request.method() === 'POST' && tail === '/suggest-message') {
    if (!Array.isArray(body.paths) || !body.paths.length)
      return reply(400, { error: fr('git.panel_commit_paths') });
    return reply(200, { message: 'fix: corrige le titre depuis le diff' });
  }
  if (request.method() === 'POST' && tail === '/pull') {
    gitState.behind = 0;
    return reply(200, status());
  }
  if (request.method() === 'POST' && tail === '/push') {
    gitState.ahead = 0;
    if (!gitState.upstream) gitState.upstream = `origin/${gitState.branch}`;
    return reply(200, status());
  }
  return reply(404, { error: 'unknown git route' });
}

let browser;
const errors = [];
async function openFilesTab({ width, language, readOnly = false }) {
  const context = await browser.newContext({
    locale: language === 'en' ? 'en-US' : 'fr-FR',
    viewport: { width, height: width < 1080 ? 844 : 960 },
    isMobile: width < 1080,
    hasTouch: width < 1080,
  });
  await context.addInitScript(
    ({ cwd, language }) => {
      localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd }));
      if (language) localStorage.setItem('prime-studio.language', language);
    },
    { cwd, language },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/project-git**', mockGit);
  if (readOnly)
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.preferences = { ...data.preferences, readOnly: true };
      await route.fulfill({ response, json: data });
    });
  await page.goto(url);
  await expect(page.locator('#connection-label')).toHaveText(
    language === 'en' ? 'Engine connected' : 'Moteur connecté',
  );
  if (width <= 1080 && !(await page.locator('#details-panel').isVisible()))
    await page.locator('#toggle-details').click();
  await page.locator('#inspector-tab-files').click();
  await expect(page.locator('#inspector-git-bar')).toBeVisible();
  return { context, page };
}

try {
  browser = await launchStudioBrowser({ channel: 'chrome' });
  // French desktop: full flow on 1440 px.
  {
    const { context, page } = await openFilesTab({ width: 1440 });
    await expect(page.locator('#git-branch-label')).toHaveText('main');
    await expect(page.locator('#git-sync-counts')).toHaveText('↑2 ↓1');
    await expect(page.locator('.git-file-check')).toHaveCount(2);
    await expect(page.locator('#git-commit-button')).toBeDisabled();
    await page
      .locator('#git-commit-message')
      .fill('Ajoute la fonctionnalité\n\nDétail sur plusieurs lignes.');
    await expect(page.locator('#git-commit-button')).toBeEnabled();
    await page.screenshot({ path: 'test-results/git-panel/status-1440.png', animations: 'disabled' });
    await page.locator('#git-commit-message').fill('');
    // Branch menu: local branches, then remote-only branches, plus creation.
    await page.locator('#git-branch-button').click();
    const menu = page.locator('.git-branch-menu');
    await expect(menu).toBeVisible();
    await page.screenshot({ path: 'test-results/git-panel/branch-menu-1440.png', animations: 'disabled' });
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), [
      'main',
      'feature',
      'hotfix',
      'Nouvelle branche…',
    ]);
    await page.locator('.git-branch-search').fill('hot');
    await expect(menu.getByRole('menuitem')).toHaveText(['hotfix', 'Nouvelle branche…']);
    await page.locator('.git-branch-search').fill('');
    await menu.getByRole('menuitem', { name: 'hotfix', exact: true }).click();
    const switchCall = calls.find((call) => call.route === '/switch');
    assert.deepEqual(switchCall.body, { cwd, branch: 'hotfix' });
    await expect(page.locator('#toasts')).toContainText('Branche hotfix active.');
    await expect(page.locator('#git-branch-label')).toHaveText('hotfix');
    // Create branch dialog.
    await page.locator('#git-branch-button').click();
    await menu.getByRole('menuitem', { name: 'Nouvelle branche…', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Créer une branche');
    await page.screenshot({ path: 'test-results/git-panel/branch-dialog-1440.png', animations: 'disabled' });
    await page.locator('#git-branch-name').fill('mauvaise branche');
    await dialog.getByRole('button', { name: 'Créer', exact: true }).click();
    await expect(dialog.locator('.form-error')).toBeVisible();
    await page.locator('#git-branch-name').fill('feature-2');
    await dialog.getByRole('button', { name: 'Créer', exact: true }).click();
    const createCall = calls.filter((call) => call.route === '/switch').at(-1);
    assert.deepEqual(createCall.body, { cwd, branch: 'feature-2', create: true });
    await expect(page.locator('#git-branch-label')).toHaveText('feature-2');
    await page.screenshot({ path: 'test-results/git-panel/switch-1440.png', animations: 'disabled' });
    // A new branch has no upstream: pull disabled, push enabled (push -u case).
    await expect(page.locator('#git-pull-button')).toBeDisabled();
    await expect(page.locator('#git-pull-button')).toHaveAttribute('title', 'Aucune branche amont.');
    await expect(page.locator('#git-push-button')).toBeEnabled();
    // Commit with a subset of files sends exactly those paths.
    await page.locator('#git-commit-message').fill('Corrige le titre');
    await page.locator('.git-file-check[data-git-path="new.txt"]').uncheck();
    await page.locator('#git-commit-button').click();
    const commitCall = calls.find((call) => call.route === '/commit');
    assert.deepEqual(commitCall.body, { cwd, message: 'Corrige le titre', paths: ['app.js'] });
    await expect(page.locator('#toasts')).toContainText('Commit ffffff');
    await expect(page.locator('#git-commit-message')).toHaveValue('');
    // Push sets the upstream; then nothing is left to push.
    await page.locator('#git-push-button').click();
    assert.ok(calls.some((call) => call.route === '/push'));
    await expect(page.locator('#git-push-button')).toBeDisabled();
    await expect(page.locator('#git-push-button')).toHaveAttribute('title', 'Rien à pousser.');
    // Fetch refreshes the remote state; pull fast-forwards.
    gitState.behind = 1;
    await page.locator('#git-fetch-button').click();
    assert.ok(calls.some((call) => call.route === '/fetch'));
    await expect(page.locator('#git-sync-counts')).toHaveText('↓1');
    await page.locator('#git-pull-button').click();
    assert.ok(calls.some((call) => call.route === '/pull'));
    await expect(page.locator('#git-sync-counts')).toHaveText('À jour');
    // A 409 surfaces as an error toast.
    gitState.behind = 1;
    await page.locator('#git-fetch-button').click();
    await expect(page.locator('#git-sync-counts')).toHaveText('↓1');
    failNext = { route: '/pull', status: 409, error: fr('git.panel_pull_diverged') };
    await page.locator('#git-pull-button').click();
    await expect(page.locator('#toasts')).toContainText('Les branches ont divergé.');
    // Suggest fills the field from the checked paths; errors surface as toasts.
    // The 409 reloads the file list; the commit box returns once it is loaded.
    await expect(page.locator('#git-suggest-button')).toBeVisible({ timeout: 15000 });
    await page.locator('.git-file-check[data-git-path="app.js"]').check();
    await page.locator('.git-file-check[data-git-path="new.txt"]').check();
    await page.locator('#git-commit-message').fill('');
    await page.locator('#git-suggest-button').click();
    await expect(page.locator('#git-commit-message')).toHaveValue('fix: corrige le titre depuis le diff');
    const suggestCall = calls.filter((call) => call.route === '/suggest-message').at(-1);
    assert.deepEqual(suggestCall.body, { cwd, paths: ['app.js', 'new.txt'] });
    failNext = { route: '/suggest-message', status: 409, error: fr('git.suggest_no_model') };
    await page.locator('#git-commit-message').fill('');
    await page.locator('#git-suggest-button').click();
    await expect(page.locator('#toasts')).toContainText('Aucun modèle utilisable');
    await expect(page.locator('#git-commit-message')).toHaveValue('');
    await page.screenshot({ path: 'test-results/git-panel/actions-1440.png', animations: 'disabled' });
    assert.ok(calls.some((call) => call.method === 'GET' && call.cwd === cwd));
    await context.close();
  }
  // French mobile: compact bar fits 390 px.
  {
    const { context, page } = await openFilesTab({ width: 390 });
    await expect(page.locator('#git-branch-label')).not.toBeEmpty();
    const box = await page.locator('#inspector-git-bar').boundingBox();
    assert.ok(box && box.x >= -1 && box.x + box.width <= 391, JSON.stringify(box));
    await page.locator('#git-branch-button').click();
    await expect(page.locator('.git-branch-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.git-branch-menu')).toBeHidden();
    await page.screenshot({ path: 'test-results/git-panel/status-390.png', animations: 'disabled' });
    await context.close();
  }
  // Read-only consultation: state stays visible, actions are hidden.
  {
    const { context, page } = await openFilesTab({ width: 1440, readOnly: true });
    await expect(page.locator('#git-branch-label')).not.toBeEmpty();
    await expect(page.locator('#git-sync-counts')).not.toBeEmpty();
    await expect(page.locator('#git-fetch-button')).toBeHidden();
    await expect(page.locator('#git-pull-button')).toBeHidden();
    await expect(page.locator('#git-push-button')).toBeHidden();
    await expect(page.locator('#inspector-git-commit')).toBeHidden();
    await expect(page.locator('.git-file-check')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/git-panel/readonly-1440.png', animations: 'disabled' });
    await context.close();
  }
  // English smoke: translated labels on 1440 px.
  {
    const { context, page } = await openFilesTab({ width: 1440, language: 'en' });
    await expect(page.locator('#git-fetch-button')).toHaveText('Fetch');
    await expect(page.locator('#git-push-button')).toHaveText('Push');
    await expect(page.locator('#git-commit-button')).toHaveText('Commit');
    await expect(page.locator('#git-suggest-button')).toHaveText('Suggest a message');
    await page.locator('#git-branch-button').click();
    await expect(page.locator('.git-branch-menu')).toContainText('New branch…');
    await page.screenshot({ path: 'test-results/git-panel/status-en-1440.png', animations: 'disabled' });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    'Git panel UI PASS: status, switch, create dialog, subset commit, pull/push, 409 toast, read-only, EN, 1440 + 390',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
