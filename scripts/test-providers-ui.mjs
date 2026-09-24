// All credentials, settings and sessions are temporary. OAuth UI is simulated;
// native persistence and HTTP authorization use the real implementation.
import { chromium, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';
import { captureEnglishDocumentation } from './documentation-capture.mjs';
const expect = baseExpect.configure({ timeout: 15000 });
const root = await mkdtemp(join(tmpdir(), 'prime-studio-providers-ui-'));
const agentHome = join(root, 'agent'),
  sessionDir = join(root, 'sessions'),
  cwd = join(root, 'Atelier');
await Promise.all([agentHome, sessionDir, cwd].map((p) => mkdir(p)));
const authPath = join(agentHome, 'auth.json');
const initial = {
  openai: { type: 'api_key', key: 'private-fixture-openai' },
  'mcp:demo': { type: 'api_key', key: 'private-fixture-mcp' },
};
await writeFile(authPath, JSON.stringify(initial));
await writeFile(join(agentHome, 'models.json'), '{"providers":{}}');
await writeFile(join(agentHome, 'settings.json'), '{}');
const app = createApp({
  agentHome,
  sessionDir,
  dataDir: join(root, 'data'),
  initialCwd: cwd,
  runtime: {
    getStatus: async () => ({ available: true, version: '0.9.2' }),
    getModels: async () => ({
      models: Object.keys(JSON.parse(await readFile(authPath)))
        .filter((id) => !id.startsWith('mcp:'))
        .map((id) => ({ id: `${id}/demo`, name: `${id} Demo`, provider: id })),
      default: {},
    }),
    start: async () => {
      throw Error('No agent should start');
    },
    close: async () => {},
  },
});
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const code = '49283175',
  salt = 'e54d6dd09bb15f7c347b38b671472aa9';
const gateway = createLanGateway({
  upstreamPort: app.server.address().port,
  host: '127.0.0.1',
  port: 0,
  config: { salt, codeHash: hashAccessCode(code, salt), readOnly: false },
});
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
const remote = `http://127.0.0.1:${gateway.address().port}`;
let browser;
const errors = [];
try {
  browser = await chromium.launch({
    channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'msedge',
    headless: true,
  });
  const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.locator('#new-session').click();
  await page.locator('#composer').fill('Brouillon conservé pendant la connexion');
  if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
  await page.locator('#settings-tab-models').click();

  await page.locator('#open-provider-settings').click();
  await expect(page.locator('.provider-card')).not.toHaveCount(0);
  await expect(page.locator('[data-provider="openai"]')).toContainText('Configuré');
  await expect(page.locator('[data-provider="openai-codex"]')).toContainText('Connecter un compte');
  await mkdir('test-results/engine-0.9.6', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop-providers.png', animations: 'disabled' });
  await captureEnglishDocumentation(page, 'desktop-providers.png');
  assert.doesNotMatch(await page.locator('#providers-dialog').textContent(), /private-fixture/);
  const search = page.getByRole('searchbox', { name: 'Rechercher un fournisseur' });
  await search.fill('deepseek');
  await expect(page.locator('.provider-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Ajouter une clé API', exact: true }).click();
  const field = page.getByLabel('Clé API', { exact: true });
  await field.fill('private-fixture-deepseek');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.locator('[data-provider="deepseek"]')).toContainText('Configuré');
  assert.equal(JSON.parse(await readFile(authPath)).deepseek.key, 'private-fixture-deepseek');
  await expect(page.locator('#model-select option[value="deepseek/demo"]')).toHaveCount(1);
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /private-fixture-deepseek/);
  await page.locator('[data-provider="deepseek"]').getByRole('button', { name: 'Remplacer la clé' }).click();
  await expect(page.getByLabel('Clé API', { exact: true })).toHaveValue('');
  await page.getByLabel('Clé API', { exact: true }).fill('discard-this-draft');
  await page.locator('#providers-close').click();
  await expect(page.locator('#open-provider-settings')).toBeFocused();
  await page.locator('#settings-tab-models').click();

  await page.locator('#open-provider-settings').click();
  await expect(page.locator('[data-provider="deepseek"]')).toBeVisible();
  assert.doesNotMatch(await page.locator('#providers-dialog').innerHTML(), /discard-this-draft/);
  await page
    .locator('[data-provider="deepseek"]')
    .getByRole('button', { name: 'Déconnecter', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Déconnecter DeepSeek ?' })).toBeVisible();
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  assert.equal(JSON.parse(await readFile(authPath)).deepseek.key, 'private-fixture-deepseek');
  await page
    .locator('[data-provider="deepseek"]')
    .getByRole('button', { name: 'Déconnecter', exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirmer la déconnexion' }).click();
  await expect(page.locator('[data-provider="deepseek"]')).toContainText('Non configuré');
  assert.deepEqual(JSON.parse(await readFile(authPath)), initial);
  // Meta is available without a custom models.json entry. Use only a dummy key.
  await search.fill('Meta');
  const metaCard = page.locator('[data-provider="meta"]');
  await expect(metaCard).toBeVisible();
  await expect(metaCard).toContainText('Non configuré');
  await expect(metaCard.getByRole('button', { name: 'Connecter un compte', exact: true })).toHaveCount(0);
  await metaCard.getByRole('button', { name: 'Ajouter une clé API', exact: true }).click();
  await page.getByLabel('Clé API', { exact: true }).fill('private-fixture-meta');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(metaCard).toContainText('Configuré');
  assert.equal(JSON.parse(await readFile(authPath)).meta.key, 'private-fixture-meta');
  assert.doesNotMatch(await page.locator('#providers-dialog').innerHTML(), /private-fixture-meta/);
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /private-fixture-meta/);
  await metaCard.getByRole('button', { name: 'Déconnecter', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmer la déconnexion' }).click();
  await expect(metaCard).toContainText('Non configuré');
  assert.deepEqual(JSON.parse(await readFile(authPath)), initial);
  assert.equal(await readFile(join(agentHome, 'models.json'), 'utf8'), '{"providers":{}}');
  // Subscription login is separate from Meta API and requires explicit consent.
  await search.fill('muse');
  const museCard = page.locator('[data-provider="muse-code"]');
  await expect(museCard).toBeVisible();
  await expect(museCard).toContainText('Non configuré');
  await expect(museCard.getByRole('button', { name: 'Ajouter une clé API', exact: true })).toHaveCount(0);
  await museCard.getByRole('button', { name: 'Connecter un compte', exact: true }).click();
  const museConsent = page.locator('#providers-dialog input[type="checkbox"]');
  const museConnect = page.getByRole('button', { name: 'Connecter un compte', exact: true });
  await expect(museConsent).not.toBeChecked();
  const consentLabel = page.locator('.provider-consent');
  const consentText = consentLabel.locator('span');
  await expect(consentText).toHaveCSS('font-size', '13px');
  for (const width of [1440, 720]) {
    await page.setViewportSize({ width, height: 960 });
    const box = await museConsent.boundingBox();
    const textBox = await consentText.boundingBox();
    assert.ok(box && textBox);
    assert.ok(box.width <= 20 && box.height <= 20, 'checkbox stays compact');
    assert.ok(box.x + box.width <= textBox.x, 'checkbox sits before consent text');
    assert.ok(Math.abs(box.y - textBox.y) <= 5, 'checkbox aligns with first line');
    await page.screenshot({ path: `test-results/muse-consent-${width}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(museConnect).toBeDisabled();
  await museConsent.check();
  await expect(museConnect).toBeEnabled();
  // Do not submit: this UI check must never initiate a real Meta login.
  await page.getByRole('button', { name: 'Retour', exact: true }).click();
  assert.deepEqual(JSON.parse(await readFile(authPath)), initial);
  // Anthropic subscription risk is visible before a login request. API keys
  // keep their ordinary form and do not request subscription consent.
  await search.fill('anthropic');
  const anthropicCard = page.locator('[data-provider="anthropic"]');
  await anthropicCard.getByRole('button', { name: 'Connecter un compte', exact: true }).click();
  const anthropicConsent = page.locator('#providers-dialog input[type="checkbox"]');
  await expect(page.locator('#providers-view')).toContainText('Claude Code');
  await expect(page.locator('#providers-view')).toContainText('bannissement');
  await expect(anthropicConsent).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Connecter un compte', exact: true })).toBeDisabled();
  await anthropicConsent.check();
  await expect(page.getByRole('button', { name: 'Connecter un compte', exact: true })).toBeEnabled();
  await page.screenshot({
    path: 'test-results/engine-0.9.6/anthropic-consent-fr.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Retour', exact: true }).click();
  await anthropicCard.getByRole('button', { name: 'Ajouter une clé API', exact: true }).click();
  await expect(page.getByLabel('Clé API', { exact: true })).toBeVisible();
  await expect(page.locator('.provider-consent')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retour', exact: true }).click();
  assert.deepEqual(JSON.parse(await readFile(authPath)), initial);
  // OAuth form events are replayed without connecting any real account.
  let job = {
    id: '12345678-abcd-1234-abcd-123456789012',
    provider: 'openai-codex',
    status: 'waiting',
    url: 'https://auth.openai.com/authorize?fixture=true',
    instructions: 'Autorisez votre compte de démonstration.',
    prompts: [
      {
        id: '22345678-abcd-1234-abcd-123456789012',
        kind: 'manual',
        message: 'Code de retour',
        allowEmpty: false,
      },
    ],
  };
  await page.route('**/api/providers/login**', async (route) => {
    const request = route.request();
    if (request.method() === 'DELETE') job = { ...job, status: 'cancelled', url: undefined, prompts: [] };
    else if (request.method() === 'POST' && request.url().endsWith(job.id)) {
      assert.equal(request.postDataJSON().value, 'demo-code');
      job = { ...job, status: 'complete', url: undefined, prompts: [] };
    }
    await route.fulfill({ json: job });
  });
  await search.fill('codex');
  await page.getByRole('button', { name: 'Connecter un compte', exact: true }).click();
  await expect(page.locator('#provider-auth-link')).toHaveAttribute('href', job.url);
  await page.getByLabel('Code de retour').fill('demo-code');
  await page.getByRole('button', { name: 'Valider', exact: true }).click();
  await expect(page.locator('[data-provider="openai-codex"]')).toBeVisible();
  await page.locator('#providers-done').click();
  await page.locator('#settings-dialog .primary-button[data-close-dialog]').click();
  await expect(page.locator('#composer')).toHaveValue('Brouillon conservé pendant la connexion');
  assert.equal(
    (await fetch(url + '/api/providers', { headers: { Origin: 'https://outside.invalid' } })).status,
    403,
  );
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 960 },
  ]) {
    const mobile = await browser.newPage({ locale: 'fr-FR', viewport });
    await mobile.goto(remote);
    await mobile.locator('#code').fill(code);
    await mobile.getByRole('button', { name: 'Ouvrir le studio' }).click();
    await expect(mobile.locator('#connection-label')).toContainText('connecté');
    if (viewport.width < 700) await mobile.locator('#toggle-sidebar').click();
    if (!(await mobile.locator('#settings-dialog').isVisible()))
      await mobile.locator('#open-settings').click();
    await expect(mobile.locator('#provider-settings')).toBeHidden();
    for (const [path, method] of [
      ['/api/providers', 'GET'],
      ['/api/providers/key', 'POST'],
      ['/api/providers/disconnect', 'POST'],
      ['/api/providers/login', 'POST'],
      [`/api/providers/login/${job.id}`, 'GET'],
      [`/api/providers/login/${job.id}`, 'POST'],
      [`/api/providers/login/${job.id}`, 'DELETE'],
    ]) {
      const response = await mobile.request.fetch(remote + path, {
        method,
        headers: { Origin: remote, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { data: {} } : {}),
      });
      assert.equal(response.status(), 404, `${method} ${path} must be local-only`);
    }
    await mobile.close();
  }
  assert.deepEqual(JSON.parse(await readFile(authPath)), initial);
  assert.equal(await readFile(join(agentHome, 'models.json'), 'utf8'), '{"providers":{}}');
  assert.equal(await readFile(join(agentHome, 'settings.json'), 'utf8'), '{}');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      nativeCredentials: true,
      oauthUi: true,
      remoteBlocked: true,
      draftPreserved: true,
    }),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => gateway.close(resolve));
  await app.close();
  await rm(root, { recursive: true, force: true });
}
