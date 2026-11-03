// Real HTTP/store with isolated conversations. Live engine command is recorded;
// smoke-live-messages --thinking separately exercises the real native engine.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const root = await mkdtemp(join(tmpdir(), 'studio-conversation-settings-'));
const cwd = join(root, 'Project'),
  sessionDir = join(root, 'sessions'),
  dataDir = join(root, 'data');
await Promise.all(
  [cwd, sessionDir, dataDir, 'test-results/conversation-settings'].map((dir) =>
    mkdir(dir, { recursive: true }),
  ),
);
for (const [id, model, thinking] of [
  ['alpha', 'a', 'high'],
  ['beta', 'b', 'low'],
]) {
  const entries = [
    { type: 'session', id, version: 3, cwd, timestamp: '2026-09-10T09:00:00Z' },
    { type: 'model_change', id: 'model', parentId: null, provider: 'fixture', modelId: model },
    { type: 'thinking_level_change', id: 'thinking', parentId: 'model', thinkingLevel: thinking },
    {
      type: 'message',
      id: 'user',
      parentId: 'thinking',
      message: { role: 'user', content: `${id} conversation` },
    },
    {
      type: 'message',
      id: 'answer',
      parentId: 'user',
      message: {
        role: 'assistant',
        provider: 'fixture',
        model,
        content: [{ type: 'text', text: 'A saved response.' }],
      },
    },
  ];
  await writeFile(join(sessionDir, id + '.jsonl'), entries.map(JSON.stringify).join('\n'));
}
const originals = await Promise.all(
  ['alpha', 'beta'].map((id) => readFile(join(sessionDir, id + '.jsonl'), 'utf8')),
);
const starts = [],
  live = [],
  completions = [];
let rejectThinking = false,
  browser,
  gateway;
const app = createApp({
  initialCwd: cwd,
  sessionDir,
  dataDir,
  agentHome: join(root, 'agent'),
  liveClient: {
    async setThinking(id, project, level) {
      live.push({ id, cwd: project, level });
      if (rejectThinking)
        throw Object.assign(new Error('Réflexion indisponible pour ce test'), { status: 503 });
      return level;
    },
  },
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({
      default: { model: 'fixture/a', thinking: 'medium' },
      models: ['a', 'b'].map((id) => ({
        id: 'fixture/' + id,
        name: 'Modèle ' + id.toUpperCase(),
        provider: 'fixture',
        reasoning: true,
        thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      })),
    }),
    start: async (input) => {
      starts.push(input);
      let finish;
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      completions.push(finish);
      return { sessionId: input.sessionId, done, cancel: async () => finish({ status: 'stopped' }) };
    },
    close: async () => completions.forEach((done) => done({ status: 'completed' })),
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
const checks = [],
  errors = [],
  releases = [];
const deadline = setTimeout(() => {
  console.error('Conversation settings UI test exceeded 120 seconds.');
  process.exitCode = 1;
  for (const release of releases) release();
  void browser?.close();
  app.server.closeAllConnections();
}, 120_000);
deadline.unref();
const patch = async (body) =>
  fetch(url + '/api/conversation-settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify(body),
  });
// Legacy response-order cases exercise the single composer below the docking breakpoint.
async function pageFor(width = 1024, locale = 'fr-FR') {
  const context = await browser.newContext({ locale, viewport: { width, height: 960 } });
  await context.addInitScript(
    ({ cwd, language }) => {
      if (!localStorage.getItem('prime-studio.selection'))
        localStorage.setItem(
          'prime-studio.selection',
          JSON.stringify({ cwd, sessionId: 'alpha', projectOverview: false }),
        );
      localStorage.setItem('prime-studio.language', language);
    },
    { cwd, language: String(locale).toLowerCase().startsWith('en') ? 'en' : 'fr' },
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('#thinking-select')).toBeEnabled();
  return page;
}
async function select(page, id) {
  if (await page.locator('#toggle-sidebar').isVisible()) await page.locator('#toggle-sidebar').click();
  await page.locator(`[data-navigation-key="session:${id}"]`).click();
  if (id === 'beta' && page.viewportSize().width >= 1080) {
    await expect(thinkingFor(page, 'beta')).toBeEnabled();
  } else {
    await expect(page.locator('#thinking-select')).toBeEnabled();
  }
}
// History predicate: matches /api/history?id=<id> in any parameter position,
// including paged (&limit/&before) requests. Playwright passes a URL object to
// route/unroute predicates; wrap response URLs for waitForResponse.
const historyUrlIs = (id) => (value) => {
  try {
    const parsed = value instanceof URL ? value : new URL(String(value));
    return parsed.searchParams.get('id') === id;
  } catch {
    return false;
  }
};
const historyIsAlpha = historyUrlIs('alpha');
function betaPanel(page) {
  return page.getByRole('tabpanel', { name: 'beta conversation' });
}
function thinkingFor(page, id) {
  return page.viewportSize().width >= 1080 && id === 'beta'
    ? betaPanel(page).locator('[data-cvw="thinking"]')
    : page.locator('#thinking-select');
}
async function selectSingle(page, id) {
  await page.evaluate(
    ({ cwd, sessionId }) => {
      try {
        localStorage.removeItem('prime-studio.docking.conversations');
      } catch {}
      localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId, projectOverview: false }));
    },
    { cwd, sessionId: id },
  );
  await page.reload();
  await expect(page.locator('#thinking-select')).toBeEnabled();
}
try {
  browser = await launchStudioBrowser({ channel: 'chrome' });
  const page = await pageFor();
  await expect(page.locator('#model-select')).toHaveValue('fixture/a');
  await expect(page.locator('#thinking-select')).toHaveValue('high');
  await page.locator('#model-picker-button').click();
  await page.locator('.model-choice[data-model-id="fixture/b"]').click();
  await expect(page.locator('#thinking-select')).toBeEnabled();
  await page.locator('#thinking-select').selectOption('xhigh');
  await expect(page.locator('#thinking-select')).toBeEnabled();
  await select(page, 'beta');
  await expect(page.locator('#model-select')).toHaveValue('fixture/b');
  await expect(thinkingFor(page, 'beta')).toHaveValue('low');
  await select(page, 'alpha');
  await expect(page.locator('#model-select')).toHaveValue('fixture/b');
  await expect(page.locator('#thinking-select')).toHaveValue('xhigh');
  await page.reload();
  await expect(page.locator('#thinking-select')).toHaveValue('xhigh');
  const other = await pageFor();
  await expect(other.locator('#model-select')).toHaveValue('fixture/b');
  await expect(other.locator('#thinking-select')).toHaveValue('xhigh');
  checks.push('Independent model/thinking per conversation, persisted across reload and another device.');
  await page.locator('#composer').fill('Continue this conversation');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].model, 'fixture/b');
  assert.equal(starts[0].thinking, 'xhigh');
  await expect(page.locator('#model-picker-button')).toBeDisabled();
  await expect(page.locator('#thinking-select')).toBeEnabled();
  await page.locator('#thinking-select').selectOption('medium');
  await expect(page.locator('#toasts')).toContainText('prochains appels du modèle');
  assert.deepEqual(live.at(-1), { id: 'alpha', cwd, level: 'medium' });
  assert.equal(starts.length, 1, 'Changing thinking never starts another run');
  await expect(page.locator('#stop-button')).toBeVisible();
  await select(page, 'beta');
  await expect(thinkingFor(page, 'beta')).toHaveValue('low');
  await select(page, 'alpha');
  await expect(page.locator('#thinking-select')).toHaveValue('medium');
  await page.screenshot({ path: 'test-results/conversation-settings/desktop-live.png' });
  rejectThinking = true;
  await page.locator('#thinking-select').selectOption('max');
  await expect(page.locator('#toasts .error')).toContainText('Réflexion indisponible');
  await expect(page.locator('#thinking-select')).toHaveValue('medium');
  rejectThinking = false;
  checks.push(
    'Live thinking command targets only the active conversation; no restart; rejection restores selection.',
  );
  for (const settings of [{ thinking: 'invalid' }, { model: 'fixture/a' }])
    assert.ok([400, 409].includes((await patch({ id: 'alpha', cwd, settings })).status));
  assert.equal((await patch({ id: 'beta', cwd: root, settings: { thinking: 'high' } })).status, 409);
  const salt = 'c'.repeat(32),
    code = '12345678';
  gateway = createLanGateway({
    host: '127.0.0.1',
    upstreamPort: app.server.address().port,
    config: { salt, codeHash: hashAccessCode(code, salt), readOnly: true },
  });
  await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
  const remote = `http://127.0.0.1:${gateway.address().port}`;
  const ro = await browser.newPage();
  await ro.goto(remote);
  await ro.locator('#code').fill(code);
  await ro.getByRole('button', { name: 'Ouvrir le studio' }).click();
  assert.equal(
    (
      await ro.request.patch(remote + '/api/conversation-settings', {
        data: { id: 'beta', cwd, settings: { thinking: 'high' } },
      })
    ).status(),
    405,
  );
  checks.push('Invalid levels, cross-project edits, live model changes and read-only writes rejected.');
  const phone = await pageFor(390);
  await expect(phone.locator('#thinking-select')).toHaveValue('medium');
  await expect(phone.locator('#thinking-select')).toBeEnabled();
  await phone.locator('#thinking-select').selectOption('high');
  await expect(phone.locator('#toasts')).toContainText('prochains appels du modèle');
  await phone.screenshot({ path: 'test-results/conversation-settings/mobile-live.png' });
  assert.deepEqual(
    await Promise.all(['alpha', 'beta'].map((id) => readFile(join(sessionDir, id + '.jsonl'), 'utf8'))),
    originals,
    'UI preferences must not rewrite native transcripts',
  );
  const metadata = JSON.parse(await readFile(join(dataDir, 'workspace.json'), 'utf8'));
  assert.equal(metadata.sessions.alpha.generationSettings.thinking, 'high');
  assert.equal(metadata.sessions.beta?.generationSettings, undefined);
  completions.at(-1)({ status: 'completed' });
  await expect(page.locator('#stop-button')).toBeHidden();
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    releases.push(resolve);
    return { promise, resolve };
  };
  // Return an old history across navigation while a settings save is pending.
  // Exercise both response orders, both selectors, and rejected saves; assert
  // the actual next runtime input, not only the optimistic value on screen.
  for (const field of ['thinking', 'model']) {
    for (const historyFirst of [false, true]) {
      for (const rejected of [false, true]) {
        const before = { model: 'fixture/a', thinking: 'high', sharedMemories: false };
        const desired = field === 'thinking' ? 'medium' : 'fixture/b';
        const expected = { ...before, ...(!rejected && { [field]: desired }) };
        const reset = await patch({ id: 'alpha', cwd, settings: before });
        assert.equal(reset.status, 200);
        const resetResult = await reset.json();
        const racePage = await pageFor();
        const patchGate = deferred(),
          patchSeen = deferred(),
          historyGate = deferred(),
          historyFetched = deferred();
        await racePage.route('**/api/conversation-settings', async (route) => {
          patchSeen.resolve();
          await patchGate.promise;
          if (rejected) {
            await route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'Settings save rejected for this test' }),
            });
          } else await route.continue();
        });
        if (field === 'thinking') await racePage.locator('#thinking-select').selectOption(desired);
        else {
          await racePage.locator('#model-picker-button').click();
          await racePage.locator(`.model-choice[data-model-id="${desired}"]`).click();
        }
        await patchSeen.promise;
        await select(racePage, 'beta');
        await expect(thinkingFor(racePage, 'beta')).toHaveValue('low');
        await racePage.route(historyIsAlpha, async (route) => {
          const response = await route.fetch();
          historyFetched.resolve(await response.json());
          await historyGate.promise;
          await route.fulfill({ response });
        });
        await racePage.locator('[data-navigation-key="session:alpha"]').click();
        const oldHistory = await historyFetched.promise;
        assert.equal(oldHistory.generationRevision, resetResult.revision);
        const patchResponse = racePage.waitForResponse((response) =>
          response.url().endsWith('/api/conversation-settings'),
        );
        if (historyFirst) {
          const historyResponse = racePage.waitForResponse((response) => historyIsAlpha(response.url()));
          historyGate.resolve();
          await historyResponse;
          await expect(racePage.locator(`#${field}-select`)).toHaveValue(desired);
        }
        patchGate.resolve();
        const saved = await patchResponse;
        assert.equal(saved.status(), rejected ? 503 : 200);
        await expect(racePage.locator(`#${field}-select`)).toHaveValue(expected[field]);
        historyGate.resolve();
        await expect(racePage.locator('#thinking-select')).toBeEnabled();
        await expect(racePage.locator('#model-select')).toHaveValue(expected.model);
        await expect(racePage.locator('#thinking-select')).toHaveValue(expected.thinking);
        const persisted = await (await fetch(url + '/api/history?id=alpha')).json();
        assert.deepEqual(persisted.generationSettings, expected);
        assert.equal(persisted.generationRevision, resetResult.revision + (rejected ? 0 : 1));
        const previousStarts = starts.length;
        await racePage.locator('#composer').fill('Continue after navigating during a settings save');
        await racePage.locator('#send-button').click();
        await expect(racePage.locator('#stop-button')).toBeVisible();
        assert.equal(starts.length, previousStarts + 1);
        assert.equal(starts.at(-1).model, expected.model);
        assert.equal(starts.at(-1).thinking, expected.thinking);
        completions.at(-1)({ status: 'completed' });
        await expect(racePage.locator('#stop-button')).toBeHidden();
        await racePage.unroute(historyIsAlpha);
        // A newer save from another device must still supersede the cache.
        const external = await patch({ id: 'alpha', cwd, settings: { thinking: 'low' } });
        assert.equal(external.status, 200);
        await select(racePage, 'beta');
        await select(racePage, 'alpha');
        await expect(racePage.locator('#thinking-select')).toHaveValue('low');
        await racePage.context().close();
      }
    }
  }
  checks.push(
    'Delayed histories cannot undo confirmed model/thinking saves or change the next run; both response orders, rejections and newer device revisions verified.',
  );
  const sharedPage = await pageFor(1440);
  // Shared memories opt-in: per-conversation, off by default, first send carries it.
  // Help text stays concise, shares global memories, and never claims isolation.
  await selectSingle(sharedPage, 'alpha');
  const sharedBox = sharedPage.locator('#allow-shared-memories');
  await expect(sharedBox).toBeEnabled();
  await expect(sharedBox).not.toBeChecked();
  await expect(sharedBox).toHaveAttribute('aria-label', 'Injecter les mémoires partagées');
  const sharedTitle = await sharedBox.evaluate((el) => el.closest('label')?.title || '');
  assert.ok(sharedTitle.includes('Partage les mémoires globales'), 'help shares global memories');
  assert.ok(
    sharedTitle.includes('Ne restreint pas'),
    'help states file/MCP and history limits',
  );
  assert.ok(
    !/isolation|isolement|cloison/i.test(sharedTitle),
    'must not claim complete project isolation',
  );
  // Fresh-off first send carries false.
  const alphaStarts = starts.length;
  await sharedPage.locator('#composer').fill('Alpha without shared memories');
  await sharedPage.locator('#send-button').click();
  await expect(sharedPage.locator('#stop-button')).toBeVisible();
  assert.equal(starts.length, alphaStarts + 1);
  assert.equal(starts.at(-1).sessionId, 'alpha');
  assert.equal(starts.at(-1).sharedMemories, false);
  completions.at(-1)({ status: 'completed' });
  await expect(sharedPage.locator('#stop-button')).toBeHidden();
  // Explicit-on first send on beta carries its own flag; disabled while active.
  await selectSingle(sharedPage, 'beta');
  await expect(sharedPage.locator('#allow-shared-memories')).not.toBeChecked();
  const betaSave = sharedPage.waitForResponse((response) => response.url().endsWith('/api/conversation-settings'));
  await sharedPage.locator('#allow-shared-memories').check();
  await expect(sharedPage.locator('#allow-shared-memories')).toBeChecked();
  const betaSaved = await betaSave;
  assert.equal(betaSaved.request().postDataJSON().id, 'beta', 'Checkbox writes its own conversation');
  const betaHistoryOn = await (await fetch(url + '/api/history?id=beta')).json();
  assert.equal(betaHistoryOn.generationSettings?.sharedMemories, true);
  const betaStarts = starts.length;
  await sharedPage.locator('#composer').fill('Beta with shared memories');
  await sharedPage.locator('#send-button').click();
  await expect(sharedPage.locator('#stop-button')).toBeVisible();
  assert.equal(starts.length, betaStarts + 1);
  assert.equal(starts.at(-1).sessionId, 'beta');
  assert.equal(starts.at(-1).sharedMemories, true);
  await expect(sharedPage.locator('#allow-shared-memories')).toBeDisabled();
  completions.at(-1)({ status: 'completed' });
  await expect(sharedPage.locator('#stop-button')).toBeHidden();
  await expect(sharedPage.locator('#allow-shared-memories')).toBeEnabled();
  // Desktop and narrow screenshots of the actual control (mock runtime, single-view).
  await sharedPage.locator('.composer-toolbar').screenshot({ path: 'test-results/conversation-settings/shared-desktop.png' });
  const narrowShared = await pageFor(390);
  await selectSingle(narrowShared, 'beta');
  await expect(narrowShared.locator('#allow-shared-memories')).toBeChecked();
  await narrowShared.locator('.composer-toolbar').screenshot({ path: 'test-results/conversation-settings/shared-narrow.png' });
  await narrowShared.context().close();
  // Resume persistence and no cross-tab/draft leak (single-view reloads, no dock tabs).
  await sharedPage.reload();
  await expect(sharedPage.locator('#thinking-select')).toBeEnabled();
  await expect(sharedPage.locator('#allow-shared-memories')).toBeChecked();
  await selectSingle(sharedPage, 'alpha');
  await expect(sharedPage.locator('#allow-shared-memories')).not.toBeChecked();
  const otherShared = await pageFor(1440);
  await expect(otherShared.locator('#allow-shared-memories')).not.toBeChecked();
  await selectSingle(otherShared, 'beta');
  await expect(otherShared.locator('#allow-shared-memories')).toBeChecked();
  // New draft has no last-used global opt-in (docked dynamic, host hidden).
  await otherShared.locator('#new-session').click();
  await expect(otherShared.locator('[data-cvw="allow-shared-memories"]:visible')).not.toBeChecked();
  await otherShared.locator('[data-cvw="allow-shared-memories"]:visible').check();
  const freshStarts = starts.length;
  await otherShared.locator('[data-cvw="composer"]:visible').fill('First message with shared memories');
  await otherShared.locator('[data-cvw="send"]:visible').click();
  await expect.poll(() => starts.length).toBe(freshStarts + 1);
  assert.equal(starts.at(-1).sessionId ?? null, null);
  assert.equal(starts.at(-1).sharedMemories, true, 'A session-less draft carries its explicit opt-in');
  completions.at(-1)({ status: 'completed' });
  await expect(otherShared.locator('[data-cvw="stop"]:visible')).toHaveCount(0);
  await otherShared.locator('#new-session').click();
  await expect(otherShared.locator('[data-cvw="allow-shared-memories"]:visible')).not.toBeChecked();
  await otherShared.context().close();
  // Read-only consultation must not mutate.
  await expect(ro.locator('#allow-shared-memories')).toBeDisabled();
  assert.equal(
    (
      await ro.request.patch(remote + '/api/conversation-settings', {
        data: { id: 'beta', cwd, settings: { sharedMemories: false } },
      })
    ).status(),
    405,
  );
  const betaStill = await (await fetch(url + '/api/history?id=beta')).json();
  assert.equal(betaStill.generationSettings?.sharedMemories, true);
  // Malformed legacy/cloud values stay off (strict === true, backend treats them as false).
  await app.store.setConversationSettings('alpha', { sharedMemories: 'true' });
  await selectSingle(sharedPage, 'alpha');
  await expect(sharedPage.locator('#allow-shared-memories')).not.toBeChecked();
  const malStarts = starts.length;
  await sharedPage.locator('#composer').fill('Malformed stays off');
  await sharedPage.locator('#send-button').click();
  await expect(sharedPage.locator('#stop-button')).toBeVisible();
  assert.equal(starts.at(-1).sharedMemories, false);
  completions.at(-1)({ status: 'completed' });
  await expect(sharedPage.locator('#stop-button')).toBeHidden();
  await app.store.setConversationSettings('alpha', { sharedMemories: false });
  checks.push(
    'Shared memories fresh-off, explicit-on first send, resume persistence, no cross-tab/draft leak, and disable/read-only behavior verified.',
  );
  // Switching sessions while a sharedMemories save is in flight never leaks.
  const resetAlpha = await patch({ id: 'alpha', cwd, settings: { sharedMemories: false } });
  assert.equal(resetAlpha.status, 200);
  const resetBeta = await patch({ id: 'beta', cwd, settings: { sharedMemories: false } });
  assert.equal(resetBeta.status, 200);
  const raceShared = await pageFor(1440);
  await select(raceShared, 'alpha');
  await expect(raceShared.locator('#allow-shared-memories')).not.toBeChecked();
  await select(raceShared, 'beta');
  await expect(betaPanel(raceShared).locator('[data-cvw="allow-shared-memories"]')).not.toBeChecked();
  await raceShared.locator('[data-navigation-key="session:alpha"]').click();
  let releaseShared;
  const sharedGate = new Promise((resolve) => (releaseShared = resolve));
  releases.push(releaseShared);
  await raceShared.route('**/api/conversation-settings', async (route) => {
    await sharedGate;
    await route.continue();
  });
  await raceShared.locator('#allow-shared-memories').check();
  await raceShared.locator('[data-navigation-key="session:beta"]').click();
  await expect(betaPanel(raceShared).locator('[data-cvw="allow-shared-memories"]')).not.toBeChecked();
  releaseShared();
  await raceShared.waitForResponse((response) => response.url().endsWith('/api/conversation-settings'));
  await expect(betaPanel(raceShared).locator('[data-cvw="allow-shared-memories"]')).not.toBeChecked();
  await raceShared.locator('[data-navigation-key="session:alpha"]').click();
  await expect(raceShared.locator('#allow-shared-memories')).toBeChecked();
  const persistedShared = await (await fetch(url + '/api/history?id=alpha')).json();
  assert.equal(persistedShared.generationSettings?.sharedMemories, true);
  const sharedStarts = starts.length;
  await raceShared.locator('#composer').fill('Alpha after shared save race');
  await raceShared.locator('#send-button').click();
  await expect(raceShared.locator('#stop-button')).toBeVisible();
  assert.equal(starts.length, sharedStarts + 1);
  assert.equal(starts.at(-1).sharedMemories, true);
  completions.at(-1)({ status: 'completed' });
  await expect(raceShared.locator('#stop-button')).toBeHidden();
  await raceShared.unroute('**/api/conversation-settings');
  await raceShared.context().close();
  checks.push('Switching sessions while a sharedMemories save is in flight never leaks the pending value.');
  // One horizontal permissions row: Questions, Mémoires/Memories and Computer
  // Use share a single row on narrow viewports (French and English, static and
  // docked dynamic), with no clipping or horizontal overflow, while desktop
  // semantics stay unchanged.
  const staticPermissionInputs = ['#allow-questions', '#allow-shared-memories', '#allow-computer-use'];
  const dynamicPermissionInputs = [
    '[data-cvw="allow-questions"]',
    '[data-cvw="allow-shared-memories"]',
    '[data-cvw="allow-computer-use"]',
  ];
  async function permissionsReport(page, { inputs, toolbar }) {
    return page.evaluate(
      ({ inputs, toolbar }) => {
        const labels = inputs.map((sel) => {
          const input = document.querySelector(sel);
          const label = input ? input.closest('label') : null;
          if (!label) return null;
          const rect = label.getBoundingClientRect();
          const full = label.querySelector('.toggle-full');
          const short = label.querySelector('.toggle-short');
          const style = getComputedStyle(label);
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            fontSize: style.fontSize,
            fullDisplay: full ? getComputedStyle(full).display : 'missing',
            shortText: short ? short.textContent.trim() : null,
          };
        });
        let bar = toolbar ? document.querySelector(toolbar) : null;
        if (!bar) {
          const first = document.querySelector(inputs[0]);
          const form = first ? first.closest('.cv-composer-form, form') : null;
          bar = form ? form.querySelector('.composer-toolbar') || form : null;
        }
        const barRect = bar ? bar.getBoundingClientRect() : null;
        return {
          labels,
          toolbar: bar
            ? { width: barRect.width, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth }
            : null,
          pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      },
      { inputs, toolbar },
    );
  }
  function expectPermissionsRow(report, { context, short }) {
    assert.equal(report.labels.length, 3, `${context}: three permission labels`);
    report.labels.forEach((label, index) => {
      assert.ok(label && label.width > 0 && label.height > 0, `${context}: label ${index} visible`);
    });
    const tops = report.labels.map((label) => label.top);
    assert.ok(
      Math.max(...tops) - Math.min(...tops) <= 2,
      `${context}: one row (tops ${tops.map((top) => top.toFixed(1)).join(', ')})`,
    );
    const ordered = [...report.labels].sort((a, b) => a.left - b.left);
    for (let i = 1; i < ordered.length; i++)
      assert.ok(ordered[i].left + 1 >= ordered[i - 1].right, `${context}: labels do not overlap`);
    assert.ok(report.toolbar, `${context}: toolbar found`);
    assert.ok(
      report.toolbar.scrollWidth <= report.toolbar.clientWidth + 1,
      `${context}: toolbar fits without horizontal scroll`,
    );
    assert.ok(report.pageOverflowX <= 1, `${context}: no page horizontal overflow`);
    report.labels.forEach((label, index) => {
      assert.ok(
        parseFloat(label.fontSize) >= 10,
        `${context}: label ${index} type not shrunk (${label.fontSize})`,
      );
      if (short) assert.equal(label.fullDisplay, 'none', `${context}: short labels on narrow`);
    });
  }
  for (const width of [320, 390, 760]) {
    const narrow = await pageFor(width);
    const report = await permissionsReport(narrow, {
      inputs: staticPermissionInputs,
      toolbar: '#composer-form .composer-toolbar',
    });
    expectPermissionsRow(report, { context: `static French ${width}px`, short: true });
    if (width === 390) {
      assert.deepEqual(
        report.labels.map((label) => label.shortText),
        ['Questions', 'Mémoires', 'Computer Use'],
      );
      await narrow
        .locator('.composer-area')
        .screenshot({ path: 'test-results/conversation-settings/permissions-390-context.png' });
      await narrow
        .locator('.composer-toolbar')
        .screenshot({ path: 'test-results/conversation-settings/permissions-390-toolbar.png' });
    }
    if (width === 320)
      await narrow
        .locator('.composer-toolbar')
        .screenshot({ path: 'test-results/conversation-settings/permissions-320-toolbar.png' });
    await narrow.context().close();
  }
  checks.push(
    'Narrow static composer keeps Questions, Mémoires and Computer Use on one row (320/390/760px) with no clipping or overflow.',
  );
  {
    const english = await pageFor(390, 'en-US');
    const report = await permissionsReport(english, {
      inputs: staticPermissionInputs,
      toolbar: '#composer-form .composer-toolbar',
    });
    expectPermissionsRow(report, { context: 'static English 390px', short: true });
    assert.deepEqual(
      report.labels.map((label) => label.shortText),
      ['Questions', 'Memories', 'Computer Use'],
    );
    await english.context().close();
    checks.push('English short labels share the same single row.');
  }
  {
    // Narrow docked pane: the dynamic (data-cvw) composer keeps one row.
    const docked = await pageFor(1440);
    await docked.locator('#new-session').click();
    await expect(docked.locator('[data-cvw="allow-shared-memories"]:visible')).toBeEnabled();
    assert.equal(
      await docked.evaluate(() => {
        const input = document.querySelector('[data-cvw="allow-shared-memories"]');
        const wrap = input ? input.closest('.composer-permissions') : null;
        return wrap ? getComputedStyle(wrap).display : 'missing';
      }),
      'contents',
      'wide dynamic wrapper stays display:contents',
    );
    await docked.evaluate(() => {
      const input = document.querySelector('[data-cvw="allow-shared-memories"]');
      const frame = input ? input.closest('.dock-panel-frame') : null;
      if (frame) {
        frame.style.flex = '0 0 300px';
        frame.style.maxWidth = '300px';
      }
    });
    const dockedReport = await permissionsReport(docked, { inputs: dynamicPermissionInputs });
    expectPermissionsRow(dockedReport, { context: 'docked dynamic 300px pane', short: true });
    await docked
      .locator('.cv-composer-form .composer-toolbar')
      .screenshot({ path: 'test-results/conversation-settings/permissions-docked-toolbar.png' });
    await docked.context().close();
    checks.push('Narrow docked pane keeps the dynamic permissions on one row.');
  }
  {
    // Desktop semantics unchanged: wrapper is display:contents (labels keep
    // participating in .model-controls directly), copy is untouched, and each
    // label shows exactly one variant per the pre-existing full/short rules
    // (a <=800px dock pane still shows short labels at wide viewports).
    const desktop = await pageFor(1440);
    const semantics = await desktop.evaluate(() => ({
      wrap: getComputedStyle(document.querySelector('#composer-form .composer-permissions')).display,
      labels: ['allow-questions', 'allow-shared-memories', 'allow-computer-use'].map((id) => {
        const label = document.getElementById(id)?.closest('label');
        const full = label?.querySelector('.toggle-full');
        const short = label?.querySelector('.toggle-short');
        return {
          full: full ? getComputedStyle(full).display : 'missing',
          short: short ? getComputedStyle(short).display : 'missing',
          fullText: full ? full.textContent.trim() : null,
          shortText: short ? short.textContent.trim() : null,
        };
      }),
    }));
    assert.equal(semantics.wrap, 'contents');
    assert.deepEqual(
      semantics.labels.map((label) => label.fullText),
      ['Autoriser les questions', 'Injecter les mémoires partagées', 'Autoriser le Computer Use'],
    );
    assert.deepEqual(
      semantics.labels.map((label) => label.shortText),
      ['Questions', 'Mémoires', 'Computer Use'],
    );
    for (const label of semantics.labels)
      assert.notEqual(
        label.full === 'none',
        label.short === 'none',
        'exactly one label variant visible',
      );
    await desktop.context().close();
    checks.push('Desktop keeps a display:contents wrapper with unchanged permission labels.');
  }
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/conversation-settings/report.json',
    JSON.stringify({ passed: true, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  console.error(error);
  throw error;
} finally {
  clearTimeout(deadline);
  for (const release of releases) release();
  await browser?.close();
  if (gateway) {
    gateway.closeAllConnections();
    await new Promise((done) => gateway.close(done));
  }
  await app.close();
  assert.equal(dirname(root), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true, maxRetries: 4 });
}
