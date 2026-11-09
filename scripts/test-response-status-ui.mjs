// Feature1 stop/Continue UI evidence: real headless browser against an
// isolated createApp fixture with an inert runtime (no provider calls).
// Covers: thinking-only length notice visible while reasoning is collapsed
// or hidden, tool-use/success silence, trailing-only Continue, real Continue
// click POSTing /api/runs exactly once (owner session, no draft/attachment
// leak, drafts preserved), secondary-pane owner scope, no CTA while running
// or read-only, error failure keeping its draft. FR + EN, classic + docked +
// phone 320/390. Screenshots land in .local/study/v448-usability/.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { createDefaultLayout } from '../public/docking-layout.js';

const SHOTS = resolve('.local', 'study', 'v448-usability');
await mkdir(SHOTS, { recursive: true });

const temp = await mkdtemp(join(tmpdir(), 'prime-response-status-'));
const cwd = join(temp, 'Atelier');
const sessionDir = join(temp, 'sessions');
for (const dir of [cwd, sessionDir, join(temp, 'data'), join(temp, 'agent')])
  await mkdir(dir, { recursive: true });
// Complete setup so sending is allowed (same as the composer fixture).
await writeFile(
  join(temp, 'data', 'subagent-defaults.json'),
  JSON.stringify({
    version: 1,
    revision: 'fixture',
    global: { model: 'fixture/m', thinking: '' },
    projects: {},
  }),
);

const T = (base, i) => new Date(base + i * 2000).toISOString();
async function seed(id, records) {
  const base = Date.UTC(2026, 9, 2, 10, 0);
  const rows = [{ type: 'session', id, cwd, version: 3, timestamp: T(base, 0) }];
  let parent = null;
  records.forEach(([kind, msg], i) => {
    const row = { type: 'message', id: `${id}-${kind}${i}`, parentId: parent, message: msg };
    rows.push(row);
    parent = row.id;
  });
  await writeFile(join(sessionDir, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
// Thinking-only length stop: the original bug (notice hid inside collapsed reasoning).
await seed('stop-length', [
  ['u', { role: 'user', content: 'Budget overrun case', timestamp: T(0, 1) }],
  [
    'a',
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Trace interne a garder masquee.' }],
      stopReason: 'length',
      timestamp: T(0, 2),
    },
  ],
]);
// Provider error stop (HTTP wording stays generic per review).
await seed('stop-error', [
  ['u', { role: 'user', content: 'Provider error case', timestamp: T(0, 1) }],
  [
    'a',
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Beginning of an answer.' }],
      stopReason: 'error',
      errorMessage: 'HTTP 503: overloaded',
      timestamp: T(0, 2),
    },
  ],
]);
// Normal tool use + success: no notice at all.
await seed('stop-tools', [
  ['u', { role: 'user', content: 'Tool use success case', timestamp: T(0, 1) }],
  [
    'a',
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking the files.' },
        { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'x' } },
      ],
      stopReason: 'stop',
      timestamp: T(0, 2),
    },
  ],
]);
// Old failure superseded by a later full answer: notice kept, CTA gone.
await seed('stop-old', [
  ['u', { role: 'user', content: 'Old failure superseded case', timestamp: T(0, 1) }],
  [
    'a',
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Cut off.' }],
      stopReason: 'length',
      timestamp: T(0, 2),
    },
  ],
  ['u', { role: 'user', content: 'Go on please', timestamp: T(0, 3) }],
  [
    'a',
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Full answer here.' }],
      stopReason: 'stop',
      timestamp: T(0, 4),
    },
  ],
]);
// Held run target: aborted stop, used for the running-hides-CTA phase.
await seed('stop-run', [
  ['u', { role: 'user', content: 'Running hides CTA case', timestamp: T(0, 1) }],
  [
    'a',
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Interrupted draft.' }],
      stopReason: 'aborted',
      timestamp: T(0, 2),
    },
  ],
]);

const starts = [];
const held = [];
let holdNext = false;
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/m', name: 'Fixture', provider: 'fixture', reasoning: true }],
    configuredProviders: ['fixture'],
    default: { model: 'fixture/m', thinking: 'medium' },
  }),
  async start(input) {
    starts.push({ sessionId: input.sessionId, message: input.message, model: input.model });
    let resolveDone;
    const done = new Promise((resolve) => (resolveDone = resolve));
    const control = {
      done,
      finish() {
        input.onEvent({
          kind: 'message',
          message: { role: 'assistant', text: 'Suite sans repetition.', tools: [], stopReason: 'stop' },
        });
        const event = { kind: 'done', sessionId: input.sessionId, status: 'completed', code: 0 };
        input.onEvent(event);
        resolveDone(event);
      },
      cancel() {
        const event = { kind: 'done', sessionId: input.sessionId, status: 'stopped', code: 130 };
        input.onEvent(event);
        resolveDone(event);
        return done;
      },
    };
    if (holdNext) {
      holdNext = false;
      held.push(control);
    } else {
      setTimeout(() => control.finish(), 400);
    }
    input.onEvent({ kind: 'session', sessionId: input.sessionId, cwd: input.cwd });
    input.onEvent({ kind: 'message_start', role: 'assistant' });
    return control;
  },
  async close() {},
};
const app = createApp({
  runtime,
  agentHome: join(temp, 'agent'),
  sessionDir,
  dataDir: join(temp, 'data'),
  initialCwd: cwd,
});
await app.store.project({ cwd });
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;

const FR = {
  length: 'Réponse tronquée : la limite de longueur a été atteinte.',
  error: 'Le fournisseur a renvoyé une erreur.',
  go: 'Continuer',
  prompt: 'Continue là où tu t’es arrêté, sans répéter la réponse précédente.',
};
const EN = {
  length: 'Response cut off: the length limit was reached.',
  error: 'The provider returned an error.',
  go: 'Continue',
  prompt: 'Continue where you stopped, without repeating the previous response.',
};

const browser = await launchStudioBrowser();
const errors = [];
const runPosts = [];
function watchRuns(page) {
  runPosts.length = 0;
  page.on('request', (request) => {
    // Create-run endpoint only: the stop control POSTs /api/runs/<id>/stop.
    if (request.method() !== 'POST') return;
    try {
      if (new URL(request.url()).pathname !== '/api/runs') return;
    } catch {
      return;
    }
    runPosts.push(request.postDataJSON());
  });
}
async function openSession(page, title) {
  // On narrow viewports the session list lives behind a drawer: only click
  // when the entry is actionable, otherwise rely on the preselected session.
  const entry = page.locator('#session-list .session-select').filter({ hasText: title }).first();
  // Narrow viewports keep the list behind a drawer (visible yet outside the
  // viewport): never wait long there. The preselected session plus the
  // content asserts below prove the right conversation is showing.
  if (await entry.isVisible().catch(() => false)) await entry.click({ timeout: 4000 }).catch(() => {});
  await expect(page.locator('#conversation-loading')).toBeHidden({ timeout: 20000 });
}
async function newContext({ locale, width, docked, prefs, readOnly } = {}) {
  const context = await browser.newContext({
    locale,
    viewport: { width, height: 900 },
    reducedMotion: 'reduce',
    isMobile: width < 600,
    hasTouch: width < 600,
  });
  await context.addInitScript(
    ({ cwd, layout, prefs }) => {
      localStorage.setItem(
        'prime-studio.selection',
        JSON.stringify({ cwd, sessionId: 'stop-length', projectOverview: false }),
      );
      localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
      if (prefs) localStorage.setItem('prime-studio.preferences', JSON.stringify(prefs));
    },
    { cwd, layout: { ...createDefaultLayout(), enabled: docked }, prefs: prefs || null },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(String(error?.message || error)));
  if (readOnly) {
    await page.route('**/api/bootstrap*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, preferences: { ...body.preferences, readOnly: true } },
      });
    });
  }
  watchRuns(page);
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText(
    locale.startsWith('fr') ? 'connecté' : 'connected',
  );
  return { context, page };
}
async function noOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, `${label}: no horizontal overflow`);
}
async function headerCompact(page, label) {
  // Root nav polish: index buttons grouped inside the breadcrumb (28px
  // compact). Each-own-row regressions stack the header tall: catch them.
  const height = await page
    .locator('header.workspace-header')
    .evaluate((node) => node.getBoundingClientRect().height);
  assert.ok(height > 0 && height < 110, `${label}: compact header (<110px), got ${height}px`);
}

try {
  // ---- Classic FR: length notice + CTA, tools silence, old failure w/o CTA.
  {
    const { context, page } = await newContext({ locale: 'fr-FR', width: 1440, docked: false });
    await openSession(page, 'Budget overrun case');
    const notice = page.locator('#messages .stop-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(FR.length);
    const cta = page.locator('#messages .stop-continue');
    await expect(cta).toBeVisible();
    await expect(cta).toContainText(FR.go);
    await headerCompact(page, 'classic fr');
    // Collapsed reasoning stays collapsed: close the activity stack, the notice must persist.
    const stack = page.locator('#messages .activity-stack');
    if ((await stack.count()) > 0) {
      await stack.locator('summary').first().click();
      await expect(stack.first()).not.toHaveClass(/open/);
    }
    await expect(notice).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'ui-classic-fr-length.png') });
    await openSession(page, 'Tool use success case');
    await expect(page.locator('#messages .stop-notice')).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, 'ui-classic-fr-tools-silent.png') });
    await openSession(page, 'Old failure superseded case');
    await expect(page.locator('#messages .stop-notice').first()).toBeVisible();
    await expect(page.locator('#messages .stop-notice').first()).toContainText(FR.length);
    await expect(page.locator('#messages .stop-continue')).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, 'ui-classic-fr-old-no-cta.png') });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // ---- Hidden reasoning FR: no thinking block at all, notice still visible.
  {
    const { context, page } = await newContext({
      locale: 'fr-FR',
      width: 1440,
      docked: false,
      prefs: { reasoningMode: 'hidden' },
    });
    await openSession(page, 'Budget overrun case');
    const notice = page.locator('#messages .stop-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(FR.length);
    await expect(page.locator('#messages .stop-continue')).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'ui-classic-fr-length-hidden.png') });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // ---- EN classic: translated notice + button, error case text.
  {
    const { context, page } = await newContext({ locale: 'en-US', width: 1440, docked: false });
    await openSession(page, 'Budget overrun case');
    await expect(page.locator('#messages .stop-notice')).toContainText(EN.length);
    await expect(page.locator('#messages .stop-continue')).toContainText(EN.go);
    await openSession(page, 'Provider error case');
    await expect(page.locator('#messages .stop-notice')).toContainText(EN.error);
    await page.screenshot({ path: join(SHOTS, 'ui-classic-en-notices.png') });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // ---- Click FR (draft + attachment): exactly one POST, owner scope, drafts kept.
  {
    const { context, page } = await newContext({ locale: 'fr-FR', width: 1440, docked: false });
    await openSession(page, 'Budget overrun case');
    const draft = 'Brouillon à préserver intact';
    await page.locator('#composer').fill(draft);
    const png = join(temp, 'dot.png');
    await writeFile(
      png,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('#attach-images').click(),
    ]);
    await chooser.setFiles([png]);
    await expect(page.locator('.image-draft')).toHaveCount(1);
    runPosts.length = 0;
    await page.locator('#messages .stop-continue').click();
    await expect.poll(() => runPosts.length, { timeout: 10000 }).toBe(1);
    const body = runPosts[0];
    assert.equal(body.sessionId, 'stop-length');
    assert.equal(body.message, FR.prompt);
    assert.ok(!String(body.message).includes('Brouillon'), 'draft text never sent');
    assert.ok(!('images' in body), 'attachments never sent with Continue');
    assert.ok(!('computerUse' in body), 'no stale permission grant');
    assert.ok(typeof body.model === 'string' && body.model.length > 0, 'model carried');
    assert.ok(typeof body.thinking === 'string', 'thinking carried');
    assert.equal(typeof body.allowQuestions, 'boolean');
    assert.equal(typeof body.sharedMemories, 'boolean');
    // Draft + attachment preserved, focus untouched by the renderer.
    await expect(page.locator('#composer')).toHaveValue(draft);
    await expect(page.locator('.image-draft')).toHaveCount(1);
    // Exactly once even after the run settles (button left with the new turn).
    await expect.poll(() => runPosts.length, { timeout: 5000 }).toBe(1);
    await page.screenshot({ path: join(SHOTS, 'ui-classic-fr-continue-sent.png') });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // ---- Error click keeps its draft too.
  {
    const { context, page } = await newContext({ locale: 'fr-FR', width: 1440, docked: false });
    await openSession(page, 'Provider error case');
    const draft = 'Brouillon erreur à garder';
    await page.locator('#composer').fill(draft);
    runPosts.length = 0;
    await page.locator('#messages .stop-continue').click();
    await expect.poll(() => runPosts.length, { timeout: 10000 }).toBe(1);
    assert.equal(runPosts[0].sessionId, 'stop-error');
    assert.equal(runPosts[0].message, FR.prompt);
    await expect(page.locator('#composer')).toHaveValue(draft);
    await page.screenshot({ path: join(SHOTS, 'ui-classic-fr-error-sent.png') });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // ---- Docked owner scope: host CTA posts host session while secondary focused.
  {
    const { context, page } = await newContext({ locale: 'fr-FR', width: 1440, docked: true });
    await expect(page.locator('#dock-workspace')).toBeVisible({ timeout: 20000 });
    await openSession(page, 'Budget overrun case');
    await page
      .locator('#session-list .session-select')
      .filter({ hasText: 'Provider error case' })
      .first()
      .click();
    const viewId = await page
      .waitForFunction(() => {
        const id = document.querySelector('.dock-tab.is-conversation.is-focused')?.dataset.dockTab;
        return id && id !== 'conversation' ? id : null;
      })
      .then((handle) => handle.jsonValue());
    const shell = page.locator(`.cvw-shell[data-view="${viewId}"]`);
    await expect(shell.locator('.cvw-messages .stop-notice')).toContainText(FR.error);
    runPosts.length = 0;
    await shell.locator('.cvw-messages .stop-continue').click();
    await expect.poll(() => runPosts.length, { timeout: 10000 }).toBe(1);
    assert.equal(runPosts[0].sessionId, 'stop-error', 'secondary pane posts its own session');
    // Host CTA from the host tab: still the host session (each pane posts its owner).
    await page.locator('.dock-tab.is-conversation').filter({ hasText: 'Budget overrun case' }).click();
    await expect(page.locator('#messages .stop-continue')).toBeVisible();
    const before = runPosts.length;
    await page.locator('#messages .stop-continue').click();
    await expect.poll(() => runPosts.length, { timeout: 10000 }).toBe(before + 1);
    assert.equal(runPosts[runPosts.length - 1].sessionId, 'stop-length', 'host pane posts its own session');
    await headerCompact(page, 'docked fr');
    await page.screenshot({ path: join(SHOTS, 'ui-docked-fr-owner.png') });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // ---- Running hides the CTA (held run), notice stays, cancel keeps draft.
  {
    const { context, page } = await newContext({ locale: 'fr-FR', width: 1440, docked: false });
    await openSession(page, 'Running hides CTA case');
    await expect(page.locator('#messages .stop-continue')).toBeVisible();
    holdNext = true;
    const draft = 'Brouillon pendant exécution';
    await page.locator('#composer').fill(draft);
    runPosts.length = 0;
    await page.locator('#messages .stop-continue').click();
    await expect.poll(() => runPosts.length, { timeout: 10000 }).toBe(1);
    await expect(page.locator('#stop-button')).toBeVisible();
    await expect(page.locator('#messages .stop-continue')).toHaveCount(0);
    await expect(page.locator('#messages .stop-notice')).toBeVisible();
    await page.locator('#stop-button').click();
    await expect(page.locator('#stop-button')).toBeHidden({ timeout: 10000 });
    await expect.poll(() => runPosts.length, { timeout: 5000 }).toBe(1);
    await expect(page.locator('#composer')).toHaveValue(draft);
    await expect(page.locator('#messages .stop-notice')).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'ui-classic-fr-running-no-cta.png') });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // ---- Read-only: notice visible, no CTA anywhere.
  {
    const { context, page } = await newContext({
      locale: 'fr-FR',
      width: 1440,
      docked: false,
      readOnly: true,
    });
    await openSession(page, 'Budget overrun case');
    await expect(page.locator('#messages .stop-notice')).toBeVisible();
    await expect(page.locator('#messages .stop-continue')).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, 'ui-classic-fr-readonly-no-cta.png') });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // ---- Phones 390 (FR) + 320 (EN): no overflow, notice + CTA visible.
  for (const [width, locale, strings] of [
    [390, 'fr-FR', FR],
    [320, 'en-US', EN],
  ]) {
    const { context, page } = await newContext({ locale, width, docked: false });
    await openSession(page, 'Budget overrun case');
    const notice = page.locator('#messages .stop-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(strings.length);
    await expect(page.locator('#messages .stop-continue')).toBeVisible();
    await noOverflow(page, `phone ${width} ${locale}`);
    await headerCompact(page, `phone ${width} ${locale}`);
    await page.screenshot({ path: join(SHOTS, `ui-phone-${width}-${locale.slice(0, 2)}.png`) });
    assert.deepEqual(errors, []);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS response-status UI (notices, trailing-only Continue, owner POST, gates, FR/EN, phones).');
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
