// Real fixture histories, no provider calls: host, docked and mobile context gauges.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createDefaultLayout } from '../public/docking-layout.js';

const temp = await mkdtemp(join(tmpdir(), 'prime-context-gauge-'));
const cwd = join(temp, 'Atelier');
const sessionDir = join(temp, 'sessions');
for (const dir of [cwd, sessionDir, join(temp, 'data'), join(temp, 'agent')])
  await mkdir(dir, { recursive: true });
async function seed(id, title, count, minute) {
  const at = Date.UTC(2026, 9, 1, 10, minute);
  const records = [{ type: 'session', id, cwd, version: 3, timestamp: new Date(at).toISOString() }];
  let parent = null;
  for (let i = 0; i < count; i += 1) {
    const user = {
      type: 'message',
      id: `${id}-u${i}`,
      parentId: parent,
      message: { role: 'user', content: i ? `Suite ${i}` : title, timestamp: at + i * 2000 },
    };
    const text =
      `Réponse ${i + 1}. ` + 'Paragraphe de remplissage pour faire défiler la conversation. '.repeat(8);
    const reply = {
      type: 'message',
      id: `${id}-a${i}`,
      parentId: user.id,
      message: {
        role: 'assistant',
        model: 'm',
        provider: 'fixture',
        content: [{ type: 'text', text }],
        timestamp: at + i * 2000 + 1000,
        usage: {
          input: id === 'long' ? 10 : 12,
          output: id === 'long' ? 60 : 24,
          cacheRead: id === 'long' ? 110 : 84,
          cacheWrite: id === 'long' ? 10 : 4,
          cost: { total: 0.01 },
        },
      },
    };
    records.push(user, reply);
    parent = reply.id;
  }
  await writeFile(join(sessionDir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
await seed('short', 'Courte conversation', 1, 0);
await seed('long', 'Longue conversation', 3, 1);
const controls = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/m', name: 'Fixture', provider: 'fixture', contextWindow: 200 }],
    default: { model: 'fixture/m' },
  }),
  async start(input) {
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const control = {
      done,
      emit: (event) => input.onEvent(event),
      async cancel() {
        const result = { status: 'stopped', code: 130 };
        input.onEvent({ kind: 'done', ...result });
        resolveDone(result);
        return done;
      },
    };
    controls.push(control);
    return control;
  },
  async close() {
    await Promise.all(controls.map((control) => control.cancel()));
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
try {
  await mkdir('test-results/context-gauge', { recursive: true });
  for (const locale of ['fr-FR', 'en-US']) {
    for (const mode of ['classic', 'docked', 'phone']) {
      const context = await browser.newContext({
        viewport: { width: mode === 'phone' ? 390 : 1440, height: 900 },
        locale,
        reducedMotion: 'reduce',
        isMobile: mode === 'phone',
        hasTouch: mode === 'phone',
      });
      await context.addInitScript(
        ({ cwd, layout }) => {
          localStorage.setItem(
            'prime-studio.selection',
            JSON.stringify({ cwd, sessionId: 'short', projectOverview: false }),
          );
          localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
        },
        { cwd, layout: { ...createDefaultLayout(), enabled: mode === 'docked' } },
      );
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => errors.push(String(error?.message || error)));
      let reads = 0, actionPosts = 0;
      page.on('request', (request) => {
        if (request.url().includes('/api/inspector?')) reads++;
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs') actionPosts++;
      });
      await page.goto(url);
      let gauge = page.locator('#composer-context-gauge');
      if (mode === 'docked') {
        await expect(page.locator('#dock-workspace')).toBeVisible();
        await page
          .locator('#session-list .session-select')
          .filter({ hasText: 'Longue conversation' })
          .first()
          .click();
        gauge = page.locator('.cvw-shell [data-cvw="context-gauge"]:visible');
        await expect(gauge).toBeVisible();
        await expect(gauge).toHaveText(`${locale === 'fr-FR' ? 'Contexte' : 'Context'} 95 % · Cache 85 %`);
        await expect(gauge).toHaveAttribute('data-level', 'danger');
      } else {
        await expect(gauge).toBeVisible();
        await expect(gauge).toHaveText(`${locale === 'fr-FR' ? 'Contexte' : 'Context'} 62 % · Cache 84 %`);
      }
      await expect(gauge).toHaveAttribute(
        'title',
        locale === 'fr-FR' ? /dernière requête \(pas en direct\)/ : /Last request context \(not live\)/,
      );
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `${locale} ${mode}: no horizontal overflow`);
      await page.screenshot({ path: `test-results/context-gauge/${mode}-${locale}.png`, fullPage: true });
      // Opening details is read-only: even keyboard activation never compacts.
      if (mode === 'phone') await page.setViewportSize({width:320,height:900});
      await gauge.focus();
      await page.keyboard.press('Enter');
      const details = page.locator('dialog.context-details-dialog');
      await expect(details).toBeVisible();
      await expect(details).toContainText(locale === 'fr-FR' ? 'Détails du contexte' : 'Context details');
      await expect(details.getByRole('button', {name: locale === 'fr-FR' ? 'Compacter maintenant' : 'Compact now', exact:true})).toBeEnabled();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:`.local/study/v448-usability/context-${mode}-${locale}.png`});
      await page.keyboard.press('Escape');
      await expect(details).toBeHidden();
      assert.equal(actionPosts,0,'opening/closing details sends no provider request');

      if (mode === 'classic') {
        await expect(page.locator('#inspector-usage')).toContainText(
          locale === 'fr-FR' ? 'Cache lu' : 'Cache read',
        );
        await expect(page.locator('#inspector-usage')).toContainText(
          locale === 'fr-FR' ? 'Cache écrit' : 'Cache write',
        );
        await expect(page.locator('#inspector-usage')).toContainText('84 %');
        // Exercise the same renderer's thresholds and unknown handling with
        // content-free data, without changing the conversation ownership.
        await page.evaluate(async () => {
          const { renderComposerGauge } = await import('/public/inspector.js');
          const element = document.getElementById('composer-context-gauge');
          renderComposerGauge(element, { contextUsage: { tokens: 160, contextWindow: 200 } });
        });
        await expect(gauge).toHaveAttribute('data-level', 'warning');
        await page.evaluate(async () => {
          const { renderComposerGauge } = await import('/public/inspector.js');
          renderComposerGauge(document.getElementById('composer-context-gauge'), null);
        });
        await expect(gauge).toBeHidden();
      }
      console.log(`ok - ${locale} ${mode} gauge (${reads} inspector reads from visible tools)`);
      await context.close();
    }
  }
  // Running phone: the Session panel stays closed. Only run events request
  // authoritative context; the existing inspector interval must not poll it.
  const liveContext = await browser.newContext({
    viewport: { width: 390, height: 900 },
    locale: 'en-US',
    isMobile: true,
    hasTouch: true,
  });
  await liveContext.addInitScript(
    ({ cwd, layout }) => {
      localStorage.setItem(
        'prime-studio.selection',
        JSON.stringify({ cwd, sessionId: 'short', projectOverview: false }),
      );
      localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
    },
    { cwd, layout: { ...createDefaultLayout(), enabled: false } },
  );
  const livePage = await liveContext.newPage();
  livePage.on('pageerror', (error) => errors.push(error.message));
  let liveReads = 0,
    liveTokens = 80,
    holdRead = false,
    releaseRead;
  await livePage.route('**/api/inspector?**', async (route) => {
    liveReads++;
    const tokens = liveTokens;
    if (holdRead) {
      holdRead = false;
      await new Promise((resolve) => { releaseRead = resolve; });
    }
    return route.fulfill({
      json: {
        session: {
          id: 'short',
          lastRequestUsage: { input: 12, output: 24, cacheRead: 84, cacheWrite: 4, cacheHitRatio: 0.84 },
        },
        agents: [],
        live: true,
        contextUsage: {
          tokens,
          contextWindow: 200,
          percent: tokens === null ? null : tokens / 2,
        },
      },
    });
  });
  await livePage.goto(url);
  const liveGauge = livePage.locator('#composer-context-gauge');
  await expect(liveGauge).toContainText('Context 62 %');
  assert.equal(liveReads, 0, 'idle phone reads no inspector data');
  await livePage.locator('#composer').fill('Fixture-only run');
  await livePage.locator('#send-button').click();
  await expect(livePage.locator('#stop-button')).toBeVisible();
  await expect(liveGauge).toContainText('Context 40 %');
  assert.equal(liveReads, 1);
  await livePage.waitForTimeout(5500);
  assert.equal(liveReads, 1, 'no periodic gauge polling');
  const control = controls.at(-1);
  const answer = {
    role: 'assistant',
    text: 'Fixture response',
    provider: 'fixture',
    model: 'm',
    usage: { input: 12, output: 24, cacheRead: 84, cacheWrite: 4 },
    tools: [],
  };
  liveTokens = 160;
  control.emit({ kind: 'message', message: answer });
  await expect(liveGauge).toContainText('Context 80 %');
  await expect(liveGauge).toHaveAttribute('data-level', 'warning');
  assert.equal(liveReads, 2);
  // An old read completes during the next event's debounce. Its completion
  // time must not consume that revision or paint its stale context.
  holdRead = true;
  liveTokens = 180;
  control.emit({ kind: 'message', message: answer });
  await expect.poll(() => liveReads).toBe(3);
  liveTokens = 120;
  control.emit({ kind: 'message', message: answer });
  const staleResponse = livePage.waitForResponse('**/api/inspector?**');
  releaseRead();
  await staleResponse;
  await expect(liveGauge).not.toContainText('Context 90 %');
  await expect(liveGauge).toContainText('Context 60 %');
  assert.equal(liveReads, 4, 'event arriving during an in-flight read schedules a fresh read');
  liveTokens = null;
  control.emit({
    kind: 'message',
    message: { role: 'system', customType: 'compaction', text: 'Fixture compaction' },
  });
  await expect(liveGauge).toBeHidden();
  liveTokens = 190;
  control.emit({ kind: 'message', message: answer });
  await expect(liveGauge).toContainText('Context 95 %');
  await expect(liveGauge).toHaveAttribute('data-level', 'danger');
  await livePage.screenshot({ path: 'test-results/context-gauge/live-phone-en-US.png', fullPage: true });
  await livePage.locator('#stop-button').click();
  await expect(livePage.locator('#stop-button')).toBeHidden();
  await expect(liveGauge).toHaveAttribute('title', /Last request context \(not live\)/);
  holdRead = true;
  releaseRead = null;
  liveTokens = 100;
  await livePage.locator('#composer').fill('Second fixture-only run');
  await livePage.locator('#send-button').click();
  await expect(livePage.locator('#stop-button')).toBeVisible();
  await expect.poll(() => typeof releaseRead).toBe('function');
  await expect(liveGauge).toContainText('Context 62 %');
  await expect(liveGauge).toHaveAttribute('title', /Last request context \(not live\)/);
  releaseRead();
  await expect(liveGauge).toContainText('Context 50 %');
  await livePage.locator('#stop-button').click();
  await expect(livePage.locator('#stop-button')).toBeHidden();
  await liveContext.close();
  assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  console.log('PASS context gauges');
} finally {
  await browser.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
