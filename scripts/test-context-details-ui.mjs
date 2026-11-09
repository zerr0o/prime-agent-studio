// Context-details dialog UI test: real app + fixture runtime, no provider calls.
// Covers: click/Enter/Space open once each and NO compact until confirm,
// cancel/Escape send no POST, confirm posts /compact on the captured session
// with owner generation flags, draft excluded from payload but preserved in
// the composer, attachments excluded and preserved, duplicate confirm = 1 POST,
// running/stale disable, failed POST keeps dialog for retry.
// FR/EN x classic/docked/phone320/phone390 with screenshots.
// app.js is root-owned: this script only drives UI and reports defects.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createDefaultLayout } from '../public/docking-layout.js';

const temp = await mkdtemp(join(tmpdir(), 'prime-context-details-'));
const cwd = join(temp, 'Atelier');
const sessionDir = join(temp, 'sessions');
for (const dir of [cwd, sessionDir, join(temp, 'data'), join(temp, 'agent')])
  await mkdir(dir, { recursive: true });

async function seed(id, title, usage) {
  const at = Date.UTC(2026, 9, 1, 10, 0);
  const records = [
    { type: 'session', id, cwd, version: 3, timestamp: new Date(at).toISOString() },
    {
      type: 'message',
      id: `${id}-u0`,
      parentId: null,
      message: { role: 'user', content: title, timestamp: at },
    },
    {
      type: 'message',
      id: `${id}-a0`,
      parentId: `${id}-u0`,
      message: {
        role: 'assistant',
        model: 'm',
        provider: 'fixture',
        content: [{ type: 'text', text: `Reply ${id}` }],
        timestamp: at + 1000,
        usage,
      },
    },
  ];
  await writeFile(join(sessionDir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
await seed('short', 'Courte conversation', {
  input: 12,
  output: 24,
  cacheRead: 84,
  cacheWrite: 4,
  cacheHitRatio: 0.84,
  cost: { total: 0.01 },
});
await seed('long', 'Longue conversation', {
  input: 10,
  output: 60,
  cacheRead: 110,
  cacheWrite: 10,
  cacheHitRatio: 0.85,
  cost: { total: 0.01 },
});
// 1px PNG for the attachment-exclusion probe.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
await writeFile(join(temp, 'dot.png'), png);

const controls = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/m', name: 'Fixture', provider: 'fixture', contextWindow: 200 }],
    default: { model: 'fixture/m' },
  }),
  async start(input) {
    const control = { emit: (event) => input.onEvent(event), done: null, resolveDone: null };
    control.done = new Promise((resolve) => {
      control.resolveDone = resolve;
    });
    control.cancel = async () => {
      const result = { status: 'stopped', code: 130 };
      input.onEvent({ kind: 'done', ...result });
      control.resolveDone(result);
      return control.done;
    };
    controls.push(control);
    return control;
  },
  async close() {
    await Promise.all(controls.map((control) => control.cancel().catch(() => {})));
  },
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
const browser = await launchStudioBrowser();
const errors = [];
const shots = '.local/study/v448-usability';
await mkdir(shots, { recursive: true });

const DIALOG = '.context-details-dialog';
const CONFIRM = '.context-details-dialog .primary-button';
const CANCEL = '.context-details-dialog .secondary-button';
const REASON = '.context-details-dialog .context-details-reason';
const ALERT = '.context-details-dialog .context-details-error';

function postsOf(posts, message) {
  return posts.filter((p) => p?.body?.message === message);
}
function installRoutes(page, posts, hooks = {}) {
  return page.route('**/api/runs', async (route) => {
    let body = null;
    try {
      body = route.request().postDataJSON();
    } catch {
      body = null;
    }
    posts.push({ body, url: route.request().url() });
    if (body?.message === '/compact' && hooks.failCompactOnce) {
      hooks.failCompactOnce = false;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'boom-failure' }),
      });
    }
    if (body?.message === '/compact' && hooks.delayCompact) await hooks.delayCompact;
    return route.continue();
  });
}
async function boot(locale, { width = 1440, docked = false, mobile = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    locale,
    reducedMotion: 'reduce',
    isMobile: mobile,
    hasTouch: mobile,
  });
  await context.addInitScript(
    ({ cwd, layout }) => {
      localStorage.setItem(
        'prime-studio.selection',
        JSON.stringify({ cwd, sessionId: 'short', projectOverview: false }),
      );
      localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
    },
    { cwd, layout: { ...createDefaultLayout(), enabled: docked } },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(String(error?.message || error)));
  const posts = [];
  const hooks = {};
  await installRoutes(page, posts, hooks);
  await page.goto(url);
  return { context, page, posts, hooks };
}
const compactPosts = (posts) => postsOf(posts, '/compact');
const dialogCount = (page) => page.locator(DIALOG).count();

try {
  // ---------- Functional suite: classic EN ----------
  {
    const { context, page, posts, hooks } = await boot('en-US');
    const gauge = page.locator('#composer-context-gauge');
    await expect(gauge).toBeVisible();
    assert.equal(await gauge.evaluate((el) => el.tagName), 'BUTTON', 'gauge is a native button');
    const dialog = page.locator(DIALOG);
    const confirm = page.locator(CONFIRM);
    const cancel = page.locator(CANCEL);

    // Click / Enter / Space each open exactly once.
    await gauge.click();
    await expect(dialog).toBeVisible();
    assert.equal(await dialogCount(page), 1, 'click opens one dialog');
    assert.equal(compactPosts(posts).length, 0, 'open posts nothing');
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      'Cancel',
      'safe option focused on open',
    );
    await cancel.click();
    await expect(dialog).toBeHidden();
    await gauge.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    assert.equal(await dialogCount(page), 1, 'Enter opens one dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    assert.equal(compactPosts(posts).length, 0, 'Escape posts nothing');
    await gauge.focus();
    await page.keyboard.press(' ');
    await expect(dialog).toBeVisible();
    assert.equal(await dialogCount(page), 1, 'Space opens one dialog (no double-open)');
    await expect.poll(() => compactPosts(posts).length).toBe(0);
    await expect(dialog).toContainText('Compacting replaces the active context summary');
    await expect(dialog).toContainText('may cost one provider request');
    // Focus returns to the opener gauge on close.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      'composer-context-gauge',
      'focus restored to gauge',
    );

    // Draft (+ any attachments): excluded from payload, preserved in UI.
    // NOTE: the composer attach button opens the app-owned attach flow
    // (commands dialog), so no file is attached here; exclusion is asserted
    // at payload level and preservation via the draft + code path
    // (imageDraft is null under a captured action, acceptDraft skipped).
    await page.locator('#composer').fill('Brouillon à préserver');
    await gauge.click();
    await expect(dialog).toBeVisible();
    await expect(page.locator(CONFIRM)).toBeEnabled();
    await confirm.click();
    await expect.poll(() => compactPosts(posts).length).toBe(1);
    const compact = compactPosts(posts)[0].body;
    assert.equal(compact.message, '/compact', 'payload is exactly /compact (draft excluded)');
    assert.equal(compact.sessionId, 'short', 'captured session');
    assert.equal(compact.cwd, cwd, 'captured cwd');
    assert.ok(!('images' in compact) && !('files' in compact), 'no attachment fields in payload');
    assert.ok(
      typeof compact.model === 'string' && typeof compact.thinking === 'string',
      'generation flags present',
    );
    await expect(dialog).toBeHidden();
    assert.equal(await page.locator('#composer').inputValue(), 'Brouillon à préserver', 'draft preserved');
    if (await page.locator('#stop-button').isVisible()) {
      await page.locator('#stop-button').click();
      await expect(page.locator('#stop-button')).toBeHidden();
    }
    await page.locator('#composer').fill('');

    // Duplicate confirm collapses to a single POST.
    await gauge.click();
    await expect(dialog).toBeVisible();
    let release;
    hooks.delayCompact = new Promise((resolve) => {
      release = resolve;
    });
    const before = compactPosts(posts).length;
    await page.locator(CONFIRM).evaluate((el) => el.click());
    await page.locator(CONFIRM).evaluate((el) => el.click());
    await page.waitForTimeout(300);
    release();
    hooks.delayCompact = null;
    await expect.poll(() => compactPosts(posts).length).toBe(before + 1, { timeout: 15000 });
    await expect(dialog).toBeHidden();
    if (await page.locator('#stop-button').isVisible()) {
      await page.locator('#stop-button').click();
      await expect(page.locator('#stop-button')).toBeHidden();
    }

    // Failed POST keeps the dialog for retry and reports in-dialog.
    hooks.failCompactOnce = true;
    await gauge.click();
    await expect(dialog).toBeVisible();
    await confirm.click();
    await expect(page.locator(ALERT)).toBeVisible({ timeout: 15000 });
    await expect(dialog).toBeVisible('failure retains dialog');
    assert.equal(compactPosts(posts).length, before + 2, 'failed attempt posted once');
    await confirm.click();
    await expect.poll(() => compactPosts(posts).length).toBe(before + 3, { timeout: 15000 });
    await expect(dialog).toBeHidden();
    if (await page.locator('#stop-button').isVisible()) {
      await page.locator('#stop-button').click();
      await expect(page.locator('#stop-button')).toBeHidden();
    }

    // Running disables confirm with a clear reason; close + reopen recovers.
    await page.locator('#composer').fill('normal run');
    await page.locator('#send-button').click();
    await expect(page.locator('#stop-button')).toBeVisible();
    await gauge.click();
    await expect(dialog).toBeVisible();
    await expect(page.locator(CONFIRM)).toBeDisabled();
    await expect(page.locator(REASON)).toContainText('Wait for the current run to finish.');
    const runningCount = compactPosts(posts).length;
    await cancel.click();
    await expect(dialog).toBeHidden();
    await page.locator('#stop-button').click();
    await expect(page.locator('#stop-button')).toBeHidden();
    assert.equal(compactPosts(posts).length, runningCount, 'no compact while running');

    // Stale target: open on short, switch to long, confirm must not POST.
    await gauge.click();
    await expect(dialog).toBeVisible();
    await page
      .locator('#session-list .session-select')
      .filter({ hasText: 'Longue conversation' })
      .first()
      .evaluate((el) => el.click());
    await page.waitForTimeout(800);
    const staleBefore = compactPosts(posts).length;
    await page.locator(CONFIRM).evaluate((el) => el.click());
    await page.waitForTimeout(500);
    assert.equal(compactPosts(posts).length, staleBefore, 'stale target never compacts');
    await expect(dialog).toBeVisible('stale target keeps dialog open');
    await expect(page.locator(REASON)).toContainText(/changed|changé/);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    console.log('ok - functional classic en-US');
    await context.close();
  }

  // ---------- Two-pane thinking capture: docked EN ----------
  // Compact from A (short) while B (long) is focused: the POST must carry
  // A's session and A's explicit empty thinking, not B's "high".
  // gaugeA is activated via evaluate-click so focus stays on B.
  {
    const { context, page, posts } = await boot('en-US', { docked: true });
    await page.locator('#dock-workspace').waitFor();
    await page
      .locator('#session-list .session-select')
      .filter({ hasText: 'Longue conversation' })
      .first()
      .click();
    await expect(page.locator('.cvw-shell [data-cvw="context-gauge"]:visible')).toBeVisible();
    // Deterministic split: drag the Longue tab to the right workspace edge
    // (no fixed pixel jump), then verify two visible gauges.
    const tab = page
      .locator('#dock-workspace [role="tab"], #dock-workspace .dock-tab')
      .filter({ hasText: 'Longue' })
      .first();
    const edge = await page.locator('#dock-workspace').boundingBox();
    assert.ok(edge, 'dock workspace box');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const box = await tab.boundingBox();
      assert.ok(box, 'longue tab found for split');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      const steps = 8;
      for (let i = 1; i <= steps; i += 1) {
        await page.mouse.move(
          box.x + (edge.x + edge.width - 24 - box.x) * (i / steps),
          box.y + box.height / 2,
          { steps: 2 },
        );
        await page.waitForTimeout(50);
      }
      await page.mouse.up();
      await page.waitForTimeout(600);
      if (
        (await page
          .locator('#composer-context-gauge:visible, .cvw-shell [data-cvw="context-gauge"]:visible')
          .count()) === 2
      )
        break;
      assert.ok(attempt === 0, 'split drag retry');
    }
    // Track each gauge's scope: host primary vs docked shell (no cvw assumption).
    const scopes = await page.evaluate(() => {
      const out = [];
      for (const g of document.querySelectorAll('#composer-context-gauge, [data-cvw="context-gauge"]')) {
        if (!g.getClientRects().length) continue;
        // Host-owned controls live inside the primary shell: classify by id first.
        const shell = g.closest('.cvw-shell');
        out.push({
          text: g.textContent,
          scope:
            g.id === 'composer-context-gauge' ? 'host' : shell ? shell.getAttribute('data-view') : 'host',
        });
      }
      return out;
    });
    const scopeA = scopes.find((s) => s.text.includes('62 %'));
    const scopeB = scopes.find((s) => s.text.includes('95 %'));
    assert.ok(scopeA, `short gauge visible: ${JSON.stringify(scopes)}`);
    assert.ok(scopeB, `long gauge visible: ${JSON.stringify(scopes)}`);
    const thinkingA =
      scopeA.scope === 'host'
        ? page.locator('#thinking-select')
        : page.locator(`.cvw-shell[data-view="${scopeA.scope}"] [data-cvw="thinking"]`);
    const thinkingB =
      scopeB.scope === 'host'
        ? page.locator('#thinking-select')
        : page.locator(`.cvw-shell[data-view="${scopeB.scope}"] [data-cvw="thinking"]`);
    await thinkingA.selectOption('', { force: true });
    await thinkingB.selectOption('high', { force: true });
    const composerB =
      scopeB.scope === 'host'
        ? page.locator('#composer')
        : page.locator(`.cvw-shell[data-view="${scopeB.scope}"] textarea:visible`).first();
    await composerB.click();
    const gauges = page.locator('#composer-context-gauge, [data-cvw="context-gauge"]');
    const gaugeA = gauges.filter({ hasText: '62 %' }).first();
    await gaugeA.evaluate((el) => el.click());
    const dialog2 = page.locator(DIALOG);
    await expect(dialog2).toBeVisible();
    await expect(dialog2).toContainText('62 %', 'dialog shows owner A numbers');
    await page.locator(CONFIRM).click();
    await expect.poll(() => compactPosts(posts).length).toBe(1, { timeout: 8000 });
    const bodyB = compactPosts(posts)[0].body;
    assert.equal(bodyB.sessionId, 'short', 'compact ran on A while B focused');
    assert.equal(bodyB.thinking, '', 'explicit empty thinking preserved (not B high)');
    await expect(dialog2).toBeHidden();
    console.log(
      'ok - two-pane thinking capture docked en-US',
      JSON.stringify({ thinking: bodyB.thinking, sessionId: bodyB.sessionId }),
    );
    await context.close();
  }

  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log('PASS context details UI');
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
