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
  errors = [];
const patch = async (body) =>
  fetch(url + '/api/conversation-settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify(body),
  });
async function pageFor(width = 1440) {
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width, height: 960 } });
  await context.addInitScript(
    (cwd) =>
      localStorage.setItem(
        'prime-studio.selection',
        JSON.stringify({ cwd, sessionId: 'alpha', projectOverview: false }),
      ),
    cwd,
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('#thinking-select')).toBeEnabled();
  return page;
}
async function select(page, id) {
  if (page.viewportSize().width < 1080) await page.locator('#toggle-sidebar').click();
  await page.locator(`[data-navigation-key="session:${id}"]`).click();
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
  await expect(page.locator('#thinking-select')).toHaveValue('low');
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
  await expect(page.locator('#thinking-select')).toHaveValue('low');
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
    return { promise, resolve };
  };
  // Return an old history across navigation while a settings save is pending.
  // Exercise both response orders, both selectors, and rejected saves; assert
  // the actual next runtime input, not only the optimistic value on screen.
  for (const field of ['thinking', 'model']) {
    for (const historyFirst of [false, true]) {
      for (const rejected of [false, true]) {
        const before = { model: 'fixture/a', thinking: 'high' };
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
        await expect(racePage.locator('#thinking-select')).toHaveValue('low');
        await racePage.route('**/api/history?id=alpha', async (route) => {
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
          const historyResponse = racePage.waitForResponse((response) =>
            response.url().endsWith('/api/history?id=alpha'),
          );
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
        await racePage.unroute('**/api/history?id=alpha');
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
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/conversation-settings/report.json',
    JSON.stringify({ passed: true, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser?.close();
  if (gateway) {
    gateway.closeAllConnections();
    await new Promise((done) => gateway.close(done));
  }
  await app.close();
  assert.equal(dirname(root), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true, maxRetries: 4 });
}
