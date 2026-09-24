import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-engine-settings-ui-'));
const cwd = join(temp, 'Projet de demonstration');
const agentHome = join(temp, 'agent');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
await Promise.all([cwd, agentHome, sessionDir, dataDir].map((path) => mkdir(path, { recursive: true })));
// Seed a stored model that is now unavailable: the UI must preserve it
// untouched when the user only edits budgets (partial save).
await writeFile(
  join(agentHome, 'settings.json'),
  JSON.stringify({ auxiliaryModel: 'stale/old-model' }),
  'utf8',
);

const catalog = {
  models: [
    {
      id: 'openai/gpt-5.4',
      name: 'GPT 5.4',
      provider: 'openai',
      availability: 'available',
      input: ['text', 'image'],
    },
    {
      id: 'anthropic/claude-opus-4-7',
      name: 'Claude Opus',
      provider: 'anthropic',
      availability: 'available',
      input: ['text'],
    },
    { id: 'openrouter/moonshotai/kimi-k2.6', name: 'Kimi', provider: 'openrouter', availability: 'unknown' },
    { id: 'stale/old-model', name: 'Old model', provider: 'stale', availability: 'unavailable' },
  ],
  configuredProviders: ['openai', 'anthropic', 'openrouter'],
  refreshing: false,
  default: { model: 'anthropic/claude-opus-4-7', thinking: 'medium' },
};

const app = createApp({
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir,
  runtime: {
    getStatus: async () => ({ available: true, version: '0.9.6 · test' }),
    getModels: async () => catalog,
    start: async () => {
      throw new Error('Isolated engine-settings fixture cannot start agents');
    },
    close: async () => {},
  },
  openDirectory: async () => {},
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
await mkdir(resolve('test-results/engine-0.9.6'), { recursive: true });
let browser;
const buttonValue = (locator) => locator.evaluate((el) => el.value ?? '');
async function pickEngineModel(page, engine, field, modelId) {
  await engine.locator(`#engine-${field}`).click();
  await expect(page.locator('#model-dialog')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#model-search')).toBeFocused();
  await page.locator('.model-choice[data-model-id="' + modelId + '"]').click();
  await expect(page.locator('#model-dialog')).toBeHidden({ timeout: 10000 });
}
async function saveWithInFlightCatalog(page, engine, imageModel, previousRoute) {
  // Hold a real GET started before the settings write. Reusing it after save
  // would leave the composer on the old route until reload.
  await expect(page.locator('#model-refresh')).toBeEnabled();
  let release,
    complete,
    stale,
    claimed = false;
  const gate = new Promise((done) => {
    release = done;
  });
  const handled = new Promise((done) => {
    complete = done;
  });
  const deadline = setTimeout(() => release(), 15000);
  const handler = async (route) => {
    if (claimed) return route.continue();
    claimed = true;
    try {
      const response = await route.fetch();
      stale = await response.json();
      await gate;
      await route.fulfill({ response, json: stale });
    } finally {
      complete();
    }
  };
  await page.route('**/api/models', handler);
  try {
    await pickEngineModel(page, engine, 'imageModel', imageModel);
    await expect.poll(() => Boolean(stale), { timeout: 10000 }).toBe(true);
    assert.equal(stale.imageModel, previousRoute);
    const saved = page.waitForResponse(
      (response) => response.url().endsWith('/api/engine-settings') && response.request().method() === 'POST',
    );
    await engine.locator('#save-engine-settings').click();
    assert.equal((await saved).status(), 200);
  } finally {
    release();
    clearTimeout(deadline);
    if (claimed) await handled;
    await page.unroute('**/api/models', handler);
  }
}
try {
  const channel = process.env.PRIME_STUDIO_TEST_BROWSER || undefined;
  browser = await chromium.launch(channel ? { headless: true, channel } : { headless: true });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText(/connect|moteur/i, { timeout: 15000 });
  await page.locator('#new-session').click();
  await expect(page.locator('#attach-images')).toBeEnabled();
  await page.locator('#image-files').setInputFiles({
    name: 'route.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  await expect(page.locator('#image-draft-tray .image-draft')).toHaveCount(1);
  await expect(page.locator('#send-button')).toBeDisabled();
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-models').click();
  await page.locator('#open-model-config').click();
  const engine = page.locator('#engine-settings');
  await expect(engine).toBeVisible({ timeout: 15000 });
  await expect(engine.locator('#engine-auxiliaryModel')).toBeEnabled();
  // Native defaults must never change the conversation-selected model.
  const initialConversationModel = await page.locator('#model-select').inputValue();
  const initialConversationPicker = await page.locator('#model-picker-button').textContent();
  // Shared picker, not native selects: same UX/a11y as other Studio selectors.
  assert.equal(await engine.locator('select[data-engine-model]').count(), 0);
  assert.equal(await engine.locator('button[data-engine-model]').count(), 4);
  for (const field of ['auxiliaryModel', 'imageModel', 'providerBackupModel', 'nativeSubagentDefaultModel']) {
    const button = engine.locator(`#engine-${field}`);
    await expect(button).toHaveClass(/model-picker-button/);
    await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(button).toHaveAttribute('aria-controls', 'model-dialog');
    await expect(button.locator('.model-picker-name')).toBeVisible();
    await expect(button.locator('.model-picker-provider')).toBeVisible();
  }
  // Stale stored value resolves to its catalog name; empty fields read as engine default.
  await expect(engine.locator('#engine-auxiliaryModel .model-picker-name')).toContainText(/Old model|stale/i);
  await expect(engine.locator('#engine-providerBackupModel .model-picker-name')).toContainText(
    /Défaut du moteur/,
  );
  await expect(engine.locator('#engine-nativeSubagentDefaultModel .model-picker-name')).toContainText(
    /Défaut du moteur/,
  );
  assert.equal(await buttonValue(engine.locator('#engine-auxiliaryModel')), 'stale/old-model');
  assert.equal(await buttonValue(engine.locator('#engine-providerBackupModel')), '');
  await expect(engine.locator('#save-engine-settings')).toBeDisabled();
  // Studio subagent empty choice still reads as engine default, not parent.
  await expect(page.locator('#subagent-settings .model-picker-name')).toContainText('Défaut du moteur');
  // Shared dialog: search, providers, model info, unavailable disabled, engine default row.
  await engine.locator('#engine-auxiliaryModel').click();
  await expect(page.locator('#model-dialog')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#model-search')).toBeFocused();
  await expect(page.locator('#model-dialog-title')).not.toBeEmpty();
  await page.locator('#model-search').fill('gpt');
  await expect(page.locator('#model-list')).toContainText('GPT 5.4');
  await page.locator('#model-search').fill('');
  await expect(page.locator('#model-list')).toContainText('openai');
  await expect(page.locator('#model-list')).toContainText('anthropic');
  const staleChoice = page.locator('.model-row[data-model-id="stale/old-model"] .model-choice');
  await expect(staleChoice).toBeDisabled();
  await expect(page.locator('.model-row[data-model-id="stale/old-model"]')).toContainText(/Indisponible/i);
  await page.locator('#model-search').fill('Défaut');
  await expect(page.locator('#model-list')).toContainText(/Défaut du moteur/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#model-dialog')).toBeHidden();
  // Escape abandons the dialog without touching the draft.
  assert.equal(await buttonValue(engine.locator('#engine-auxiliaryModel')), 'stale/old-model');
  await expect(engine.locator('#save-engine-settings')).toBeDisabled();
  await page.screenshot({
    path: resolve('test-results/engine-picker-buttons-fr.png'),
    animations: 'disabled',
  });
  // Partial save: only the budget is sent, the stale model is preserved.
  await engine.locator('#engine-maxContinuations').fill('5');
  await expect(engine.locator('#save-engine-settings')).toBeEnabled();
  await engine.locator('#save-engine-settings').click();
  await expect(engine.locator('.engine-status')).toContainText(/enregistr|saved/i, { timeout: 10000 });
  const partial = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal(partial.auxiliaryModel, 'stale/old-model');
  assert.equal(partial.autonomous.maxContinuations, 5);
  await expect(engine.locator('#save-engine-settings')).toBeDisabled();
  assert.equal('imageModel' in partial, false);
  assert.equal('defaultServiceTier' in partial, false);
  await expect(engine.locator('#engine-defaultServiceTier')).toHaveValue('default');
  // Full save with authenticated models via the shared picker.
  await pickEngineModel(page, engine, 'imageModel', 'openai/gpt-5.4');
  await engine.locator('#engine-defaultServiceTier').selectOption('priority');
  await pickEngineModel(page, engine, 'auxiliaryModel', 'openai/gpt-5.4');
  await expect(engine.locator('#engine-auxiliaryModel .model-picker-name')).toContainText('GPT 5.4');
  await pickEngineModel(page, engine, 'providerBackupModel', 'anthropic/claude-opus-4-7');
  await pickEngineModel(page, engine, 'nativeSubagentDefaultModel', 'openrouter/moonshotai/kimi-k2.6');
  await expect(engine.locator('#engine-nativeSubagentDefaultModel .model-picker-name')).toContainText('Kimi');
  await engine.locator('#engine-maxTurns').fill('');
  await engine.locator('[data-engine-unlimited="maxTokens"]').check();
  await engine.locator('#engine-timeoutMs').fill('60000');
  await page.screenshot({
    path: resolve('test-results/engine-picker-selected-fr.png'),
    animations: 'disabled',
  });
  await saveWithInFlightCatalog(page, engine, 'openai/gpt-5.4', null);
  await expect(engine.locator('.engine-status')).toContainText(/enregistr|saved/i, { timeout: 10000 });
  await expect(page.locator('#send-button')).toBeEnabled();
  await expect(page.locator('#image-draft-tray .image-draft')).toHaveCount(1);
  const saved = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal(await page.locator('#model-select').inputValue(), initialConversationModel);
  assert.equal(await page.locator('#model-picker-button').textContent(), initialConversationPicker);
  assert.equal(saved.imageModel, 'openai/gpt-5.4');
  assert.equal(saved.defaultServiceTier, 'priority');
  assert.equal(saved.auxiliaryModel, 'openai/gpt-5.4');
  assert.equal(saved.providerBackupModel, 'anthropic/claude-opus-4-7');
  assert.equal(saved.subagentDefaultModel, 'openrouter/moonshotai/kimi-k2.6');
  assert.equal(saved.autonomous.maxContinuations, 5);
  assert.equal(saved.autonomous.maxTokens, 'unlimited');
  assert.equal(saved.autonomous.timeoutMs, 60000);
  assert.equal('maxTurns' in (saved.autonomous || {}), false);
  // Invalid budget stays local with a coherent error.
  await engine.locator('#engine-maxTurns').fill('0');
  await engine.locator('#save-engine-settings').click();
  await expect(engine.locator('.engine-error')).toContainText(/Budget|budget/i);
  const untouched = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal('maxTurns' in (untouched.autonomous || {}), false);
  await engine.locator('#engine-maxTurns').fill('');
  await engine.locator('#engine-defaultServiceTier').selectOption('flex');
  // Draft preservation: unsaved picker + budget edits survive a FR->EN switch
  // issued from a peer tab (same origin storage sync), labels localize.
  await pickEngineModel(page, engine, 'providerBackupModel', 'openrouter/moonshotai/kimi-k2.6');
  await engine.locator('#engine-maxTurns').fill('7');
  const peer = await context.newPage();
  await peer.goto(url);
  await peer.locator('#open-settings').click();
  await peer.locator('#language-select').selectOption('en');
  await expect(
    engine.getByRole('heading', { name: 'Advanced models (Prime Agent 0.9.6)', exact: true }),
  ).toContainText('Advanced models', {
    timeout: 10000,
  });
  assert.equal(
    await buttonValue(engine.locator('#engine-providerBackupModel')),
    'openrouter/moonshotai/kimi-k2.6',
  );
  assert.equal(await engine.locator('#engine-maxTurns').inputValue(), '7');
  assert.equal(await buttonValue(engine.locator('#engine-auxiliaryModel')), 'openai/gpt-5.4');
  await expect(engine.locator('#engine-providerBackupModel .model-picker-name')).toContainText('Kimi');
  await peer.locator('#language-select').selectOption('fr');
  await expect(
    engine.getByRole('heading', { name: 'Modèles avancés (Prime Agent 0.9.6)', exact: true }),
  ).toContainText(/Modèles avancés/, {
    timeout: 10000,
  });
  assert.equal(await engine.locator('#engine-maxTurns').inputValue(), '7');
  assert.equal(await buttonValue(engine.locator('#engine-imageModel')), 'openai/gpt-5.4');
  await expect(engine.locator('#engine-defaultServiceTier')).toHaveValue('flex');
  await peer.close();
  await engine.locator('#save-engine-settings').click();
  await expect(engine.locator('.engine-status')).toContainText(/enregistr/i, { timeout: 10000 });
  const drafted = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal(drafted.providerBackupModel, 'openrouter/moonshotai/kimi-k2.6');
  assert.equal(drafted.autonomous.maxTurns, 7);
  assert.equal(drafted.defaultServiceTier, 'flex');
  assert.equal(drafted.imageModel, 'openai/gpt-5.4');
  // Clear means native engine default (null): picking the default row clears the field.
  await engine.locator('#engine-auxiliaryModel').click();
  await expect(page.locator('#model-dialog')).toBeVisible({ timeout: 10000 });
  await page.locator('#model-search').fill('Défaut');
  await page.locator('.model-choice[data-model-id=""]').click();
  await expect(page.locator('#model-dialog')).toBeHidden();
  assert.equal(await buttonValue(engine.locator('#engine-auxiliaryModel')), '');
  await expect(engine.locator('#engine-auxiliaryModel .model-picker-name')).toContainText(/Défaut du moteur/);
  await engine.locator('#save-engine-settings').click();
  await expect(engine.locator('.engine-status')).toContainText(/enregistr/i, { timeout: 10000 });
  const cleared = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal(await page.locator('#model-select').inputValue(), initialConversationModel);
  assert.equal('auxiliaryModel' in cleared, false);
  await engine.locator('#engine-defaultServiceTier').selectOption('default');
  await saveWithInFlightCatalog(page, engine, '', 'openai/gpt-5.4');
  await expect(engine.locator('.engine-status')).toContainText(/enregistr/i, { timeout: 10000 });
  await expect(page.locator('#send-button')).toBeDisabled();
  await expect(page.locator('#image-draft-tray .image-draft')).toHaveCount(1);
  assert.equal(await page.locator('#model-select').inputValue(), initialConversationModel);
  const cleared096 = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal('imageModel' in cleared096, false);
  assert.equal('defaultServiceTier' in cleared096, false);
  // Restore auxiliary for the reload checks below.
  await pickEngineModel(page, engine, 'auxiliaryModel', 'openai/gpt-5.4');
  await engine.locator('#save-engine-settings').click();
  await expect(engine.locator('.engine-status')).toContainText(/enregistr/i, { timeout: 10000 });
  // Closing abandons nothing saved, reopening reloads fresh (needsLoad strategy).
  await page.keyboard.press('Escape');
  await expect(page.locator('#model-config-dialog')).toBeHidden();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('#settings-tab-appearance').click();
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('#settings-title')).toHaveText('Preferences');
  await page.locator('#settings-tab-models').click();
  await page.locator('#open-model-config').click();
  const reopened = page.locator('#engine-settings');
  await expect(reopened).toBeVisible({ timeout: 15000 });
  assert.equal(await reopened.locator('#engine-maxTurns').inputValue(), '7');
  assert.equal(
    await buttonValue(reopened.locator('#engine-providerBackupModel')),
    'openrouter/moonshotai/kimi-k2.6',
  );
  await page.keyboard.press('Escape');
  await page.locator('#settings-tab-appearance').click();
  await page.locator('#language-select').selectOption('fr');
  await expect(page.locator('#settings-title')).toHaveText(/Préférences/);
  await page.locator('#settings-tab-models').click();
  await page.locator('#open-model-config').click();
  await expect(page.locator('#engine-settings')).toBeVisible({ timeout: 15000 });
  // Mobile: no horizontal overflow; dirty tracking enables save on edit.
  const engineReopened = page.locator('#engine-settings');
  await expect(engineReopened.locator('#engine-maxTurns')).toBeEnabled({ timeout: 15000 });
  await expect(engineReopened.locator('#save-engine-settings')).toBeDisabled();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    // Resizing settles asynchronously in Chromium. Check the settled layout.
    await expect
      .poll(() => engineReopened.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), {
        message: `engine card must not overflow at ${width}px`,
        timeout: 3000,
      })
      .toBe(true)
      .catch(async (failure) => {
        await page.screenshot({
          path: `test-results/engine-0.9.6/settings-overflow-${width}.png`,
          animations: 'disabled',
        });
        console.error(
          await engineReopened.evaluate((el) => ({
            width: el.clientWidth,
            scroll: el.scrollWidth,
            children: [...el.querySelectorAll('*')]
              .filter((child) => child.getBoundingClientRect().right > el.getBoundingClientRect().right + 1)
              .map((child) => ({
                tag: child.tagName,
                id: child.id,
                class: child.className,
                width: child.getBoundingClientRect().width,
              })),
          })),
        );
        throw failure;
      });

    await engineReopened.locator('#engine-maxTurns').fill('8');
    const saveBtn = engineReopened.locator('#save-engine-settings');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.scrollIntoViewIfNeeded();
    await expect(saveBtn).toBeVisible();
    await engineReopened.locator('#engine-maxTurns').fill('7');
    if (width === 390) {
      await engineReopened.locator('#engine-auxiliaryModel').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: resolve('test-results/engine-picker-mobile-390.png'),
        animations: 'disabled',
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  // 409 contract: a stale revision is rejected and the server serializes the
  // current hash revision (string, not just integers).
  const settingsUrl = `${url}/api/engine-settings`;
  const before = await (await fetch(settingsUrl)).json();
  assert.match(before.revision, /^[a-f0-9]{64}$/);
  const tampered = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  tampered.theme = 'engine-409-probe';
  await writeFile(join(agentHome, 'settings.json'), JSON.stringify(tampered, null, 2) + '\n', 'utf8');
  const conflict = await fetch(settingsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: before.revision, autonomous: { maxTurns: 11 } }),
  });
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json();
  assert.match(conflictBody.currentRevision, /^[a-f0-9]{64}$/);
  assert.notEqual(conflictBody.currentRevision, before.revision);
  const kept = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal(kept.theme, 'engine-409-probe');
  assert.equal(kept.autonomous.maxTurns, 7);
  // Outage: a down catalog must not block settings or budget-only writes.
  const temp2 = await mkdtemp(join(tmpdir(), 'prime-engine-outage-'));
  const agentHome2 = join(temp2, 'agent');
  await Promise.all(
    [join(temp2, 'cwd'), agentHome2, join(temp2, 'sessions'), join(temp2, 'data')].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const app2 = createApp({
    initialCwd: join(temp2, 'cwd'),
    agentHome: agentHome2,
    sessionDir: join(temp2, 'sessions'),
    dataDir: join(temp2, 'data'),
    runtime: {
      getStatus: async () => ({ available: true, version: '0.9.6 · outage' }),
      getModels: async () => {
        throw new Error('catalog down');
      },
      start: async () => {
        throw new Error('Isolated outage fixture cannot start agents');
      },
      close: async () => {},
    },
    openDirectory: async () => {},
  });
  await new Promise((done) => app2.server.listen(0, '127.0.0.1', done));
  try {
    const context2 = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    const outage = await context2.newPage();
    const outageErrors = [];
    outage.on('pageerror', (e) => outageErrors.push(e.message));
    await outage.goto(`http://127.0.0.1:${app2.server.address().port}`);
    await outage.locator('#open-settings').click();
    await outage.locator('#settings-tab-models').click();
    await outage.locator('#open-model-config').click();
    const outageEngine = outage.locator('#engine-settings');
    await expect(outageEngine).toBeVisible({ timeout: 15000 });
    await expect(outageEngine.locator('.engine-status')).toContainText(/indisponible|unavailable/i, {
      timeout: 15000,
    });
    // Picker buttons stay usable with engine defaults when the catalog is down.
    assert.equal(await outageEngine.locator('button[data-engine-model]').count(), 4);
    await expect(outageEngine.locator('#engine-auxiliaryModel .model-picker-name')).toContainText(
      /Défaut du moteur/,
    );
    await outageEngine.locator('#engine-maxTurns').fill('4');
    await outageEngine.locator('#save-engine-settings').click();
    await expect(outageEngine.locator('.engine-status')).toContainText(/enregistr|saved/i, {
      timeout: 10000,
    });
    const outageSaved = JSON.parse(await readFile(join(agentHome2, 'settings.json'), 'utf8'));
    assert.equal(outageSaved.autonomous.maxTurns, 4);
    assert.equal('auxiliaryModel' in outageSaved, false);
    assert.deepEqual(outageErrors, []);
    await context2.close();
  } finally {
    await app2.close();
    await rm(temp2, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  assert.deepEqual(errors, []);
  console.log(
    'Engine settings UI passed: shared picker (search/providers/unavailable/default), stale preservation, partial save, validation, draft i18n, imageModel save/clear with an in-flight stale catalog and preserved attachment/model, clear-to-default, reload, mobile, 409 contract, catalog outage, no page errors.',
  );
} finally {
  await browser?.close();
  await app.close();
  if (dirname(temp) !== resolve(tmpdir())) throw new Error('Unexpected fixture directory');
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
