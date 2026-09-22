// Worktree UI acceptance on PRODUCTION routes (no proxy, no stubs).
// Real createApp server (landed worktree routes + real lib/worktrees.mjs Git
// service), real temp Git repos, fake no-inference runtime. Ephemeral loopback.
// Run with: PRIME_STUDIO_TEST_BROWSER=chrome node scripts/test-worktrees-ui.mjs
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';

const exec = promisify(execFile);
const SHOTS = join('test-results', 'worktrees-ui');
const GIT_ID = ['-c', 'user.name=Studio Test', '-c', 'user.email=studio-test@example.test', '-c', 'commit.gpgsign=false'];

async function git(cwd, args) {
  return exec('git', [...GIT_ID, ...args], { cwd, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
}
async function closeSoon(promise, ms) {
  await Promise.race([Promise.resolve(promise).catch(() => {}), delay(ms).then(() => {})]);
}

process.env.GIT_CONFIG_GLOBAL = join(tmpdir(), 'prime-studio-wt-empty-gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
await writeFile(process.env.GIT_CONFIG_GLOBAL, '', { flag: 'w' }).catch(() => {});

const root = await mkdtemp(join(tmpdir(), 'prime-studio-worktrees-ui-'));
const agentHome = join(root, 'agent');
const sessionDir = join(root, 'sessions');
const dataDir = join(root, 'data');
const src = join(root, 'Atelier');
await Promise.all([agentHome, sessionDir, dataDir, src].map((path) => mkdir(path, { recursive: true })));
await mkdir(SHOTS, { recursive: true });

await git(root, ['init', '-b', 'main', 'Atelier']);
await writeFile(join(src, 'notes.txt'), 'version 1\n');
await git(src, ['add', 'notes.txt']);
await git(src, ['commit', '-m', 'initial']);
await writeFile(join(src, 'scratch-local.txt'), 'local only, never copied\n');

const runs = [];
const pendingControls = [];
let holdRuns = false;
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/luna', name: 'Luna', provider: 'fixture' }],
    default: { model: 'fixture/luna' },
  }),
  async start(input) {
    // Native runtimes create the session file and emit the session event;
    // the fixture mirrors that deterministically (cwd recorded, no inference).
    let id = input.sessionId || null;
    if (!id) {
      id = randomUUID();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const entries = [
        { type: 'session', id, cwd: input.cwd, timestamp: new Date().toISOString() },
        { type: 'message', id: `${id}-u`, parentId: null, message: { role: 'user', content: input.message } },
        {
          type: 'message',
          id: `${id}-a`,
          parentId: `${id}-u`,
          message: { role: 'assistant', content: [{ type: 'text', text: 'Réponse simulée.' }] },
        },
      ];
      await writeFile(join(sessionDir, `${stamp}_${id}.jsonl`), `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
      try {
        input.onEvent({ kind: 'session', sessionId: id });
      } catch {}
    }
    runs.push({ cwd: input.cwd, message: input.message, sessionId: id, model: input.model });
    let finish;
    const done = new Promise((resolveDone) => {
      finish = resolveDone;
    });
    const control = {
      done,
      async cancel() {
        finish({ status: 'stopped', code: 130 });
      },
      finishNow() {
        try {
          input.onEvent({ kind: 'done', status: 'completed', code: 0 });
        } catch {}
        finish({ status: 'completed', code: 0 });
      },
    };
    pendingControls.push(control);
    if (!holdRuns) setImmediate(() => control.finishNow());
    return control;
  },
  async close() {},
};

const app = createApp({ agentHome, sessionDir, dataDir, initialCwd: src, runtime });
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
await app.store.project({ cwd: src, pinned: false }, true);
const url = `http://127.0.0.1:${app.server.address().port}`;
const errors = [];
let browser;
let failed = null;
const pages = [];
const track = (page) => {
  pages.push(page);
  page.on('pageerror', (error) => errors.push(error.message));
  return page;
};
const projectRows = (page) => page.locator('#project-list .project-row');
async function loadedPanel(page) {
  // Diff panel fully loaded: real branch, target and base, no placeholder.
  await expect.poll(async () => page.locator('#wt-meta-branch').textContent()).not.toBe('');
  await expect.poll(async () => page.locator('#wt-meta-source').textContent()).not.toBe('');
  await expect.poll(async () => page.locator('#wt-meta-base').textContent()).not.toBe('');
  await expect.poll(async () => page.locator('#wt-meta-state').textContent()).not.toBe('');
}

try {
  browser = await chromium.launch({ channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome', headless: true });
  const page = track(await browser.newPage({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } }));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connect', { timeout: 15000 });
  await projectRows(page).filter({ hasText: 'Atelier' }).click();
  await expect(page.locator('#new-task')).toBeVisible();
  expect(await projectRows(page).count()).toBe(1);

  // New conversation dialog: current project by default, name only for worktree.
  await page.locator('#new-task').click();
  await expect(page.locator('#worktree-dialog')).toBeVisible();
  await expect.poll(async () => page.evaluate(() => document.activeElement?.value)).toBe('current');
  await expect(page.locator('#worktree-name-field')).toBeHidden();
  await page.locator('#worktree-form input[name="worktree-mode"][value="isolated"]').check();
  await expect(page.locator('#worktree-name-field')).toBeVisible();
  await page.locator('#worktree-name').click();
  await expect.poll(async () => page.evaluate(() => document.activeElement?.id)).toBe('worktree-name');
  await page.locator('#worktree-name').fill('corriger le panier');
  await page.screenshot({ path: join(SHOTS, '01-create-dialog-1440.png') });
  await page.locator('#worktree-submit').click();

  // Banner shows branch on one line and folder on the next; no separate project.
  try {
    await expect(page.locator('#worktree-banner')).toBeVisible({ timeout: 15000 });
  } catch (error) {
    const dump = await page.evaluate(() => ({
      createError: document.getElementById('worktree-error')?.textContent || '',
      createOpen: document.getElementById('worktree-dialog')?.open || false,
      bannerHidden: document.getElementById('worktree-banner')?.hidden,
    }));
    console.log('BANNER-DUMP:', JSON.stringify(dump).slice(0, 600));
    throw error;
  }
  await expect(page.locator('#worktree-banner-branch')).toContainText('studio/wt-');
  const taskPath = (await page.locator('#worktree-banner-path').textContent()).trim();
  expect(taskPath).toContain('worktrees');
  expect(await projectRows(page).count()).toBe(1);
  expect((await readFile(join(src, 'scratch-local.txt'), 'utf8')).trim()).toBe('local only, never copied');
  await page.screenshot({ path: join(SHOTS, '02-banner-after-create-1440.png') });
  await rm(join(src, 'scratch-local.txt'), { force: true });

  // Ordinary composer send runs in the worktree cwd, session grouped at owner.
  await page.locator('#composer').fill('Bonjour le worktree');
  await page.locator('#send-button').click();
  await expect.poll(() => runs.length, { timeout: 15000 }).toBeGreaterThan(0);
  expect(resolve(runs.at(-1).cwd)).toBe(resolve(taskPath));
  await page.locator('#header-project').click();
  await expect(page.locator('#project-session-list .project-session-card')).toHaveCount(1, { timeout: 15000 });
  expect(await projectRows(page).count()).toBe(1);
  await page.locator('#project-session-list .project-session-card').first().click();
  await expect(page.locator('#conversation-scroll')).toContainText('Bonjour le worktree', { timeout: 15000 });

  // Reload, resume the same session from the sidebar, second send stays in task.
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText('connect', { timeout: 15000 });
  await projectRows(page).filter({ hasText: 'Atelier' }).click();
  await expect(page.locator('#project-session-list .project-session-card')).toHaveCount(1, { timeout: 15000 });
  await page.locator('#project-session-list .project-session-card').first().click();
  await expect(page.locator('#conversation-scroll')).toContainText('Bonjour le worktree', { timeout: 15000 });
  await expect(page.locator('#composer')).toBeEnabled({ timeout: 15000 });
  await page.locator('#composer').fill('Deuxieme message');
  await page.locator('#send-button').click();
  await expect.poll(() => runs.length, { timeout: 15000 }).toBeGreaterThan(1);
  expect(resolve(runs.at(-1).cwd)).toBe(resolve(taskPath));
  await expect(page.locator('#toasts.error')).toBeHidden();

  // Diff panel: commit in the worktree, inspect payload and files.
  await page.locator('#worktree-banner-button').click();
  await expect(page.locator('#worktree-task-dialog')).toBeVisible();
  await loadedPanel(page);
  await writeFile(join(taskPath, 'tache.txt'), 'bonjour le worktree\n');
  await git(taskPath, ['add', 'tache.txt']);
  await git(taskPath, ['commit', '-m', 'task change']);
  await page.locator('#wt-refresh-button').click();
  await expect(page.locator('#wt-files li').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#wt-diff')).toContainText('bonjour le worktree');
  await page.locator('#wt-files button').first().click();
  await expect(page.locator('#wt-diff')).not.toBeEmpty();
  await page.screenshot({ path: join(SHOTS, '03-task-panel-diff-1440.png') });

  // Dirty worktree offers merge preparation with the agent in the task folder.
  await writeFile(join(taskPath, 'tache.txt'), 'bonjour le worktree\nencore\n');
  await page.locator('#wt-refresh-button').click();
  await expect(page.locator('#wt-prepare-box')).toBeVisible({ timeout: 15000 });
  holdRuns = true;
  await page.locator('#wt-prepare-confirm').check();
  await page.locator('#wt-prepare-button').click();
  await expect(page.locator('#toasts')).toContainText('Préparation du merge', { timeout: 15000 });
  expect(resolve(runs.at(-1).cwd)).toBe(resolve(taskPath));
  expect(runs.at(-1).message).toContain('merge');
  try {
    await expect(page.locator('#wt-prepare-open')).toBeVisible({ timeout: 15000 });
  } catch (error) {
    const dump = await page.evaluate(() => ({
      taskError: document.getElementById('worktree-task-error')?.textContent || '',
      session: document.getElementById('wt-prepare-open')?.hidden,
      prepareBox: document.getElementById('wt-prepare-box')?.hidden,
    }));
    console.log('PREPARE-OPEN-DUMP:', JSON.stringify(dump).slice(0, 600));
    throw error;
  }

  // Commit while the agent runs: clean task under load blocks merge as busy.
  await git(taskPath, ['add', 'tache.txt']);
  await git(taskPath, ['commit', '-m', 'task follow-up']);
  await page.locator('#wt-refresh-button').click();
  await expect(page.locator('#wt-prepare-box')).toBeHidden({ timeout: 15000 });
  await page.evaluate(() => {
    document.getElementById('wt-integrate-box').open = true;
  });
  await page.locator('#wt-integrate-confirm').check();
  await page.locator('#wt-integrate-button').click();
  await expect(page.locator('#worktree-task-error')).toContainText('cours', { timeout: 15000 });
  const headBefore = (await git(src, ['rev-parse', 'HEAD'])).stdout.trim();
  await page.screenshot({ path: join(SHOTS, '04-busy-blocked-1440.png') });
  for (const control of pendingControls.splice(0)) control.finishNow();
  holdRuns = false;

  // Calm worktree merges fast-forward into the original branch.
  await page.locator('#wt-refresh-button').click();
  await loadedPanel(page);
  await page.evaluate(() => {
    document.getElementById('wt-integrate-box').open = true;
  });
  await page.locator('#wt-integrate-confirm').check();
  await expect(page.locator('#wt-integrate-button')).toBeEnabled({ timeout: 15000 });
  await page.locator('#wt-integrate-button').click();
  try {
    await expect(page.locator('#toasts')).toContainText('Merge fast-forward effectué', { timeout: 15000 });
  } catch (error) {
    const dump = await page.evaluate(() => ({
      taskError: document.getElementById('worktree-task-error')?.textContent || '',
      toasts: document.getElementById('toasts')?.textContent?.slice(0, 400) || '',
      metaState: document.getElementById('wt-meta-state')?.textContent || '',
    }));
    console.log('INTEGRATE-DUMP:', JSON.stringify(dump).slice(0, 900));
    throw error;
  }
  expect((await git(src, ['show', 'HEAD:tache.txt'])).stdout).toContain('encore');
  expect((await git(src, ['rev-parse', 'HEAD'])).stdout.trim()).not.toBe(headBefore);
  await page.screenshot({ path: join(SHOTS, '05-after-integrate-1440.png') });

  // Explicit removal keeps the branch and deletes only the managed folder.
  const branch = (await page.locator('#wt-meta-branch').textContent()).trim();
  await page.evaluate(() => {
    document.getElementById('wt-remove-box').open = true;
  });
  await page.locator('#wt-remove-confirm').check();
  await page.locator('#wt-remove-button').click();
  await expect(page.locator('#toasts')).toContainText('supprim', { timeout: 15000 });
  await expect(page.locator('#worktree-banner')).toBeHidden();
  expect((await git(src, ['branch', '--list', branch])).stdout).toContain(branch);
  await page.screenshot({ path: join(SHOTS, '06-after-remove-1440.png') });

  // Kept worktrees reopen from the owner dialog list without any session.
  await page.locator('#new-task').click();
  await page.locator('#worktree-form input[name="worktree-mode"][value="isolated"]').check();
  await page.locator('#worktree-name').fill('second chantier');
  await page.locator('#worktree-submit').click();
  try {
    await expect(page.locator('#worktree-banner')).toBeVisible({ timeout: 15000 });
  } catch (error) {
    const dump = await page.evaluate(() => ({
      createError: document.getElementById('worktree-error')?.textContent || '',
      createOpen: document.getElementById('worktree-dialog')?.open || false,
    }));
    console.log('BANNER2-DUMP:', JSON.stringify(dump).slice(0, 600));
    throw error;
  }
  await page.locator('#new-task').click();
  await expect(page.locator('#worktree-list li').first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: join(SHOTS, '07-kept-list-1440.png') });
  await page.locator('#worktree-list button').first().click();
  await expect(page.locator('#worktree-task-dialog')).toBeVisible();
  await loadedPanel(page);
  await page.keyboard.press('Escape');

  // Narrow layout keeps banner and panel usable with loaded state.
  const narrow = track(await browser.newPage({ locale: 'fr-FR', viewport: { width: 720, height: 960 } }));
  await narrow.goto(url);
  await expect(narrow.locator('#connection-label')).toContainText('connect', { timeout: 15000 });
  await narrow.locator('#toggle-sidebar').click();
  await projectRows(narrow).filter({ hasText: 'Atelier' }).click();
  await narrow.locator('#new-task').click();
  await narrow.locator('#worktree-form input[name="worktree-mode"][value="isolated"]').check();
  await narrow.locator('#worktree-name').fill('tache etroite');
  await narrow.locator('#worktree-submit').click();
  await expect(narrow.locator('#worktree-banner')).toBeVisible({ timeout: 15000 });
  await narrow.screenshot({ path: join(SHOTS, '08-banner-720.png') });
  await narrow.locator('#worktree-banner-button').click();
  await expect(narrow.locator('#worktree-task-dialog')).toBeVisible();
  await loadedPanel(narrow);
  await narrow.waitForTimeout(800);
  await loadedPanel(narrow);
  const narrowState = await narrow.locator('#wt-meta-state').textContent();
  console.log('NARROW-STATE:', JSON.stringify(narrowState));
  await narrow.screenshot({ path: join(SHOTS, '09-task-panel-720.png') });

  // English labels render without fallback gaps.
  const english = track(await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 960 } }));
  await english.goto(url);
  await expect(english.locator('#connection-label')).toContainText('connect', { timeout: 15000 });
  await projectRows(english).filter({ hasText: 'Atelier' }).click();
  await english.locator('#new-task').click();
  await expect(english.locator('#worktree-title')).toContainText('New conversation');
  await expect(english.locator('#new-task')).toContainText('New worktree');
  await english.screenshot({ path: join(SHOTS, '10-create-dialog-en-1440.png') });

  expect(errors).toEqual([]);
  console.log(`worktrees UI ok, ${runs.length} fake runs, shots in ${SHOTS}`);
} catch (error) {
  failed = error;
  throw error;
} finally {
  for (const p of pages.splice(0)) await closeSoon(p.close(), 5000);
  await closeSoon(browser?.close(), 15000);
  await closeSoon(app.close(), 20000);
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.log('cleanup kept temp dir:', root, error.message);
  }
  if (!failed) process.exitCode = 0;
}
