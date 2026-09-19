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
    { id: 'openai/gpt-5.4', name: 'GPT 5.4', provider: 'openai', availability: 'available' },
    {
      id: 'anthropic/claude-opus-4-7',
      name: 'Claude Opus',
      provider: 'anthropic',
      availability: 'available',
    },
    { id: 'openrouter/moonshotai/kimi-k2.6', name: 'Kimi', provider: 'openrouter', availability: 'unknown' },
    { id: 'stale/old-model', name: 'Old model', provider: 'stale', availability: 'unavailable' },
  ],
  configuredProviders: ['openai', 'anthropic', 'openrouter'],
  refreshing: false,
  default: { model: null, thinking: 'medium' },
};

const app = createApp({
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir,
  runtime: {
    getStatus: async () => ({ available: true, version: '0.9.5 · test' }),
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
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText(/connect|moteur/i, { timeout: 15000 });
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-models').click();
  await page.locator('#open-model-config').click();
  const engine = page.locator('#engine-settings');
  await expect(engine).toBeVisible({ timeout: 15000 });
  await expect(engine.locator('#engine-auxiliaryModel')).toBeEnabled();
  // Authenticated catalog: unavailable models are not offered as choices.
  const auxOptions = await engine.locator('#engine-auxiliaryModel option').allInnerTexts();
  assert.ok(auxOptions.some((text) => text.includes('openai/gpt-5.4')));
  assert.ok(auxOptions.some((text) => text.includes('anthropic/claude-opus-4-7')));
  assert.ok(
    !auxOptions.some((text) => text.includes('Old model')),
    'unavailable catalog models must not be offered',
  );
  assert.ok(
    auxOptions.some((text) => text.trim() === 'stale/old-model'),
    'the stored stale value stays visible as a disabled entry',
  );
  // The stale stored value is shown (disabled) and the form starts pristine.
  assert.equal(await engine.locator('#engine-auxiliaryModel').inputValue(), 'stale/old-model');
  await expect(engine.locator('#save-engine-settings')).toBeDisabled();
  // Studio subagent empty choice now reads as engine default, not parent.
  await expect(page.locator('#subagent-settings .model-picker-name')).toContainText('Défaut du moteur');
  // Partial save: only the budget is sent, the stale model is preserved.
  await engine.locator('#engine-maxContinuations').fill('5');
  await expect(engine.locator('#save-engine-settings')).toBeEnabled();
  await engine.locator('#save-engine-settings').click();
  await expect(engine.locator('.engine-status')).toContainText(/enregistr|saved/i, { timeout: 10000 });
  const partial = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal(partial.auxiliaryModel, 'stale/old-model');
  assert.equal(partial.autonomous.maxContinuations, 5);
  await expect(engine.locator('#save-engine-settings')).toBeDisabled();
  // Full save with authenticated models.
  await engine.locator('#engine-auxiliaryModel').selectOption('openai/gpt-5.4');
  await engine.locator('#engine-providerBackupModel').selectOption('anthropic/claude-opus-4-7');
  await engine.locator('#engine-nativeSubagentDefaultModel').selectOption('openrouter/moonshotai/kimi-k2.6');
  await engine.locator('#engine-maxTurns').fill('');
  await engine.locator('[data-engine-unlimited="maxTokens"]').check();
  await engine.locator('#engine-timeoutMs').fill('60000');
  await engine.locator('#save-engine-settings').click();
  await expect(engine.locator('.engine-status')).toContainText(/enregistr|saved/i, { timeout: 10000 });
  const saved = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
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
  // Draft preservation: unsaved model+budget edits survive a FR->EN switch
  // issued from a peer tab (same origin storage sync), labels localize.
  await engine.locator('#engine-providerBackupModel').selectOption('openrouter/moonshotai/kimi-k2.6');
  await engine.locator('#engine-maxTurns').fill('7');
  const peer = await context.newPage();
  await peer.goto(url);
  await peer.locator('#open-settings').click();
  await peer.locator('#language-select').selectOption('en');
  await expect(
    engine.getByRole('heading', { name: 'Advanced models (Prime Agent 0.9.5)', exact: true }),
  ).toContainText('Advanced models', {
    timeout: 10000,
  });
  assert.equal(
    await engine.locator('#engine-providerBackupModel').inputValue(),
    'openrouter/moonshotai/kimi-k2.6',
  );
  assert.equal(await engine.locator('#engine-maxTurns').inputValue(), '7');
  assert.equal(await engine.locator('#engine-auxiliaryModel').inputValue(), 'openai/gpt-5.4');
  await peer.locator('#language-select').selectOption('fr');
  await expect(
    engine.getByRole('heading', { name: 'Modèles avancés (Prime Agent 0.9.5)', exact: true }),
  ).toContainText(/Modèles avancés/, {
    timeout: 10000,
  });
  assert.equal(await engine.locator('#engine-maxTurns').inputValue(), '7');
  await peer.close();
  await engine.locator('#save-engine-settings').click();
  await expect(engine.locator('.engine-status')).toContainText(/enregistr/i, { timeout: 10000 });
  const drafted = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal(drafted.providerBackupModel, 'openrouter/moonshotai/kimi-k2.6');
  assert.equal(drafted.autonomous.maxTurns, 7);
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
    await reopened.locator('#engine-providerBackupModel').inputValue(),
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
    const overflow = await engineReopened.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    assert.ok(overflow, `engine card must not overflow at ${width}px`);
    await engineReopened.locator('#engine-maxTurns').fill('8');
    const saveBtn = engineReopened.locator('#save-engine-settings');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.scrollIntoViewIfNeeded();
    await expect(saveBtn).toBeVisible();
    await engineReopened.locator('#engine-maxTurns').fill('7');
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
      getStatus: async () => ({ available: true, version: '0.9.5 · outage' }),
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
    assert.equal(await outageEngine.locator('#engine-auxiliaryModel option').count(), 1);
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
    'Engine settings UI passed: stale preservation, partial save, validation, draft i18n, subagent labels, reload, mobile, 409 contract, catalog outage, no page errors.',
  );
} finally {
  await browser?.close();
  await app.close();
  if (dirname(temp) !== resolve(tmpdir())) throw new Error('Unexpected fixture directory');
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
