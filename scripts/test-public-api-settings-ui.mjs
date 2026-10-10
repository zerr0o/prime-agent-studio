// Generic API preferences UI proof with mocked admin endpoints.
// Real HTTP shell with isolated profile; /api/public-api* mocked in page.
// Covers: generic wording, disabled-by-default switch, endpoints display,
// sensitive warnings, token create/list/revoke, one-time secret handling,
// revision conflict reload without retry, validation, FR+EN, 1440 and 390
// widths, remote view without token controls, no secret in web storage.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { createApp } from '../server.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-public-api-ui-'));
const cwd = join(temp, 'Atelier');
const agentHome = join(temp, 'agent');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
await Promise.all([cwd, agentHome, sessionDir, dataDir].map((path) => mkdir(path, { recursive: true })));

const PROJECT_A = `p_${'a'.repeat(32)}`;
const PROJECT_B = `p_${'b'.repeat(32)}`;
const VALID_SCOPES = new Set(['read', 'runs:write', 'roadmaps:write', 'files:download']);
const PROJECT_PATTERN = /^p_[0-9a-fA-F]{32}$/;
const banned = new RegExp(['mo', 'bile'].join(''), 'i');

const adminState = {
  enabled: false,
  revision: 1,
  machineId: 'machine-fixture-01',
  tokens: [],
  projects: [
    { id: PROJECT_A, name: 'Atelier demo', cwd },
    { id: PROJECT_B, name: 'Second projet' },
  ],
  endpoints: [],
};
let tokenSeq = 0;
const snapshot = () => JSON.parse(JSON.stringify(adminState));

const app = createApp({
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir,
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({ models: [], default: {} }),
    start: async () => {
      throw new Error('Isolated API fixture cannot start agents');
    },
    close: async () => {},
  },
  openDirectory: async () => {},
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;

let browser;
const deadline = setTimeout(() => {
  void browser?.close();
  void app.close();
}, 180000);

async function mockAdmin(route) {
  const requestUrl = new URL(route.request().url());
  const { pathname } = requestUrl;
  const method = route.request().method();
  const conflict = () =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Revision conflict: reload and retry deliberately.',
        code: 'revision_conflict',
        currentRevision: adminState.revision,
      }),
    });
  if (pathname === '/api/public-api' && method === 'GET') {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot()) });
    return;
  }
  if (pathname === '/api/public-api' && method === 'PATCH') {
    const body = route.request().postDataJSON() || {};
    if (body.revision !== adminState.revision) {
      await conflict();
      return;
    }
    adminState.enabled = body.enabled === true;
    adminState.revision += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot()) });
    return;
  }
  if (pathname === '/api/public-api/tokens' && method === 'POST') {
    const body = route.request().postDataJSON() || {};
    if (body.revision !== adminState.revision) {
      await conflict();
      return;
    }
    const name = String(body.name || '').trim();
    const scopes = Array.isArray(body.scopes) ? body.scopes : null;
    const projectIds = Array.isArray(body.projectIds) ? body.projectIds : null;
    const { expiresAt = null } = body;
    const bad = (message) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: message }),
      });
    if (!name || name.length > 60) {
      await bad('Invalid integration name.');
      return;
    }
    if (
      !scopes ||
      !scopes.length ||
      !scopes.includes('read') ||
      !scopes.every((scope) => VALID_SCOPES.has(scope))
    ) {
      await bad('Invalid scopes.');
      return;
    }
    const projectsOk =
      projectIds &&
      projectIds.length > 0 &&
      (projectIds.length === 1 && projectIds[0] === '*'
        ? true
        : projectIds.every((id) => PROJECT_PATTERN.test(id)));
    if (!projectsOk) {
      await bad('Explicit project selection is required.');
      return;
    }
    if (expiresAt !== null && !(Date.parse(expiresAt) > Date.now())) {
      await bad('Invalid expiry.');
      return;
    }
    tokenSeq += 1;
    const token = {
      id: `tok-${tokenSeq}`,
      name,
      scopes,
      projectIds,
      createdAt: new Date().toISOString(),
      expiresAt,
    };
    adminState.tokens.push(token);
    adminState.revision += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ token, credential: `pa_fixture_${token.id}`, state: snapshot() }),
    });
    return;
  }
  if (pathname.startsWith('/api/public-api/tokens/') && method === 'DELETE') {
    const body = route.request().postDataJSON() || {};
    if (body.revision !== adminState.revision) {
      await conflict();
      return;
    }
    const id = decodeURIComponent(pathname.slice('/api/public-api/tokens/'.length));
    const index = adminState.tokens.findIndex((entry) => entry.id === id);
    if (index < 0) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unknown token.' }),
      });
      return;
    }
    adminState.tokens.splice(index, 1);
    adminState.revision += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot()) });
    return;
  }
  await route.continue();
}

const storageHas = (dump, values) => values.some((value) => value && dump.includes(value));

try {
  browser = await launchStudioBrowser();
  const context = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 1440, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/public-api**', mockAdmin);
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connecté');

  const bootRaw = await page.evaluate(async () =>
    (await fetch('/api/bootstrap')).json().then((d) => JSON.stringify(d)),
  );
  assert.ok(!bootRaw.includes('secret-fixture'), 'bootstrap carries no token secret');
  assert.ok(!bootRaw.includes('tok-'), 'bootstrap carries no token inventory');

  const openApi = async () => {
    if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
    await page.locator('#settings-tab-api').click();
    await expect(page.locator('#settings-panel-api')).toBeVisible();
  };
  await openApi();
  const docsLink = page.locator('#public-api-docs');
  await expect(docsLink).toHaveAttribute('href', '/api-docs');
  await expect(docsLink).toContainText('Documentation interactive');
  const [docsPage] = await Promise.all([context.waitForEvent('page'), docsLink.click()]);
  await docsPage.waitForURL(url + '/api-docs');
  await expect(docsPage.locator('details[data-operation-id]')).toHaveCount(18);
  await expect(docsPage.locator('#api-docs-token')).toHaveValue('');
  await docsPage.close();
  await expect(page.locator('#settings-panel-api')).toContainText('outils externes');
  await expect(page.locator('#settings-panel-api')).toContainText('code via des agents');
  await expect(page.locator('#settings-panel-api')).toContainText('hors du dossier du projet');
  await expect(page.locator('#public-api-enabled')).not.toBeChecked();
  await expect(page.locator('#public-api-tokens-empty')).toBeVisible();
  await expect(page.locator('#public-api-no-endpoint')).toBeVisible();
  await expect(page.locator('#public-api-machine-id')).toHaveText('machine-fixture-01');
  const panelText = await page.locator('#settings-panel-api').innerText();
  assert.ok(!banned.test(panelText), 'panel keeps generic wording');

  await page.locator('#public-api-enabled').click();
  await expect(page.locator('#toasts .toast').filter({ hasText: 'Réglage API enregistré' })).toBeVisible();
  await expect(page.locator('#public-api-enabled')).toBeChecked();

  await page.locator('#public-api-name').fill('Script d’automatisation');
  await page.locator('#public-api-scope-runs-write').check();
  await page.locator(`#public-api-project-options input[value="${PROJECT_A}"]`).check();
  await page.locator('#public-api-create').click();
  await expect(page.locator('#public-api-secret')).toBeVisible();
  await expect(page.locator('#public-api-credential')).toHaveText('pa_fixture_tok-1');
  await expect(page.locator('#public-api-token-list')).toContainText('Script d’automatisation');
  await expect(page.locator('#public-api-token-list')).toContainText('Exécution');
  await expect(page.locator('#toasts .toast').filter({ hasText: 'Copiez le secret' })).toBeVisible();
  const dumpAfterCreate = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  assert.ok(!storageHas(dumpAfterCreate, ['pa_fixture_tok-1']), 'secret never reaches web storage');

  await page.locator('#public-api-copy-secret').click();
  await expect(page.locator('#toasts .toast').first()).toBeVisible();
  await page.locator('#public-api-dismiss-secret').click();
  await expect(page.locator('#public-api-secret')).toBeHidden();
  await expect(page.locator('#public-api-credential')).toBeEmpty();

  await page.locator('#public-api-name').fill('Dashboard sync');
  await page.locator('#public-api-all-projects').check();
  await page.locator('#public-api-expiry').fill('2030-05-01');
  await page.locator('#public-api-create').click();
  await expect(page.locator('#public-api-credential')).toHaveText('pa_fixture_tok-2');
  await expect(page.locator('#public-api-token-list')).toContainText('Tous les projets');
  await expect(page.locator('#public-api-token-list')).toContainText('Expire le');
  await page.locator('#public-api-dismiss-secret').click();

  await page.reload();
  await expect(page.locator('#connection-label')).toContainText('connecté');
  await openApi();
  await expect(page.locator('#public-api-secret')).toBeHidden();
  await expect(page.locator('#public-api-token-list')).toContainText('Script d’automatisation');
  await expect(page.locator('#public-api-token-list')).toContainText('Dashboard sync');

  await page.locator('#public-api-enabled').click();
  await expect(page.locator('#toasts .toast').filter({ hasText: 'Réglage API enregistré' })).toBeVisible();
  await expect(page.locator('#public-api-enabled')).not.toBeChecked();
  await expect(page.locator('#public-api-token-list')).toContainText('Script d’automatisation');
  await expect(page.locator('#public-api-create')).toBeDisabled();
  await page.locator('#public-api-enabled').click();
  await expect(page.locator('#public-api-enabled')).toBeChecked();

  await page.locator('#public-api-name').fill('Sync journalière');
  await page.locator(`#public-api-project-options input[value="${PROJECT_B}"]`).check();
  await page.locator('#public-api-create').click();
  await expect(page.locator('#public-api-credential')).toHaveText('pa_fixture_tok-3');
  await page
    .locator('#public-api-token-list article', { hasText: 'Sync journalière' })
    .getByRole('button', { name: 'Révoquer' })
    .click();
  await expect(page.locator('#public-api-secret')).toBeHidden();
  await expect(page.locator('#public-api-token-list')).not.toContainText('Sync journalière');
  await expect(page.locator('#toasts .toast').filter({ hasText: 'Jeton révoqué' })).toBeVisible();

  adminState.revision += 1;
  await page.locator('#public-api-enabled').click();
  await expect(page.locator('#public-api-error')).toContainText('rechargées');
  await expect(page.locator('#public-api-enabled')).toBeChecked();

  await page.locator('#public-api-name').fill('');
  await page.locator('#public-api-all-projects').check();
  await page.locator('#public-api-create').click();
  await expect(page.locator('#public-api-form-error')).toContainText('Nommez');
  await page.locator('#public-api-name').fill('Sans projet');
  await page.locator('#public-api-all-projects').uncheck();
  await page.locator('#public-api-create').click();
  await expect(page.locator('#public-api-form-error')).toContainText('au moins un projet');
  await page.locator(`#public-api-project-options input[value="${PROJECT_A}"]`).check();
  await page.locator('#public-api-expiry').fill('2001-02-03');
  await page.locator('#public-api-create').click();
  await expect(page.locator('#public-api-form-error')).toContainText('futur');
  await page.locator('#public-api-expiry').fill('');
  assert.equal(adminState.tokens.length, 2, 'invalid forms create nothing');

  adminState.endpoints = [{ kind: 'lan', url: 'http://192.168.1.42:3089' }];
  await page.locator('#public-api-refresh').click();
  await expect(page.locator('#public-api-endpoints')).toContainText('http://192.168.1.42:3089');
  await expect(page.locator('#public-api-no-endpoint')).toBeHidden();
  adminState.endpoints = [];
  await page.locator('#public-api-refresh').click();
  await expect(page.locator('#public-api-no-endpoint')).toBeVisible();

  await page.locator('#settings-tab-appearance').click();
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('#settings-title')).toHaveText('Preferences');
  await openApi();
  await expect(page.locator('#settings-panel-api')).toContainText('external tools');
  await expect(page.locator('#settings-panel-api')).toContainText('execute code through agents');
  await expect(page.locator('#settings-panel-api')).toContainText('outside the project folder');
  const panelEn = await page.locator('#settings-panel-api').innerText();
  assert.ok(!banned.test(panelEn), 'panel keeps generic wording in English');

  await page.setViewportSize({ width: 390, height: 844 });
  await openApi();
  assert.equal(
    await page.locator('.settings-panels').evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
    'api panel fits narrow widths',
  );
  await expect(page.locator('#settings-dialog .settings-actions [data-close-dialog]')).toBeInViewport();

  const remotePage = await context.newPage();
  remotePage.on('pageerror', (error) => errors.push(error.message));
  await remotePage.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.preferences = { ...(data.preferences || {}), readOnly: true, remote: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await remotePage.goto(url);
  await remotePage.locator('#open-settings').click();
  await expect(remotePage.locator('#settings-tab-api')).toBeHidden();

  const fullControlPage = await context.newPage();
  fullControlPage.on('pageerror', (error) => errors.push(error.message));
  await fullControlPage.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.preferences = { ...(data.preferences || {}), readOnly: false, remote: true };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await fullControlPage.goto(url);
  await fullControlPage.locator('#open-settings').click();
  await expect(fullControlPage.locator('#settings-tab-api')).toBeHidden();
  await fullControlPage.close();

  // ---- Real wired admin endpoints: isolated temp profile, fake runtime only ----
  const realTemp = await mkdtemp(join(tmpdir(), 'prime-public-api-real-'));
  const realCwd = join(realTemp, 'Atelier');
  const realAgent = join(realTemp, 'agent');
  const realSessions = join(realTemp, 'sessions');
  const realData = join(realTemp, 'data');
  await Promise.all(
    [realCwd, realAgent, realSessions, realData].map((path) => mkdir(path, { recursive: true })),
  );
  const realApp = createApp({
    initialCwd: realCwd,
    agentHome: realAgent,
    sessionDir: realSessions,
    dataDir: realData,
    runtime: {
      getStatus: async () => ({ available: true, version: 'fixture' }),
      getModels: async () => ({ models: [], default: {} }),
      start: async () => {
        throw new Error('Isolated API fixture cannot start agents');
      },
      close: async () => {},
    },
    openDirectory: async () => {},
  });
  await new Promise((done) => realApp.server.listen(0, '127.0.0.1', done));
  const realUrl = `http://127.0.0.1:${realApp.server.address().port}`;
  const realChecks = [];
  try {
    const admin = async (path, options) => {
      const response = await fetch(realUrl + path, {
        ...options,
        headers: {
          ...(options?.headers || {}),
          ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options?.body ? JSON.stringify(options.body) : undefined,
      });
      let data = null;
      try {
        data = await response.json();
      } catch {}
      return { status: response.status, data };
    };
    const first = await admin('/api/public-api');
    assert.equal(first.status, 200);
    assert.equal(first.data.enabled, false, 'real API disabled by default');
    assert.ok(Array.isArray(first.data.projects) && first.data.projects.length >= 1);
    assert.match(first.data.projects[0].id, /^p_[0-9a-f]{32}$/);
    assert.equal(first.data.machineId && typeof first.data.machineId, 'string');
    realChecks.push('real disabled by default with project ids and machine id');
    const realBoot = JSON.stringify(await (await fetch(`${realUrl}/api/bootstrap`)).json());
    assert.ok(!realBoot.includes('"credential"'), 'bootstrap carries no credential');
    const realPage = await context.newPage();
    realPage.on('pageerror', (error) => errors.push(error.message));
    await realPage.goto(realUrl);
    await expect(realPage.locator('#connection-label')).toContainText('connecté');
    const openRealApi = async () => {
      if (!(await realPage.locator('#settings-dialog').isVisible()))
        await realPage.locator('#open-settings').click();
      await realPage.locator('#settings-tab-api').click();
      await expect(realPage.locator('#settings-panel-api')).toBeVisible();
    };
    await openRealApi();
    await expect(realPage.locator('#public-api-enabled')).not.toBeChecked();
    await realPage.locator('#public-api-enabled').click();
    await expect(
      realPage.locator('#toasts .toast').filter({ hasText: 'Réglage API enregistré' }),
    ).toBeVisible();
    realChecks.push('real toggle on through UI');
    const listedId = first.data.projects[0].id;
    await realPage.locator('#public-api-name').fill('Real check integration');
    await realPage.locator(`#public-api-project-options input[value="${listedId}"]`).check();
    await realPage.locator('#public-api-create').click();
    await expect(realPage.locator('#public-api-secret')).toBeVisible();
    let firstCredential = await realPage.locator('#public-api-credential').innerText();
    assert.ok(firstCredential.startsWith('pa_'), 'real credential is opaque');
    assert.ok(
      !(
        await realPage.evaluate(
          () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
        )
      ).includes(firstCredential),
      'real secret never reaches web storage',
    );
    const withToken = (credential) => ({ Authorization: `Bearer ${credential}` });
    const machineRes = await admin('/api/v1/machine', { headers: withToken(firstCredential) });
    assert.equal(machineRes.status, 200);
    assert.equal(machineRes.data.machineId, first.data.machineId);
    const projectsRes = await admin('/api/v1/projects', { headers: withToken(firstCredential) });
    assert.equal(projectsRes.status, 200);
    assert.ok(Array.isArray(projectsRes.data.items));
    await expect(realPage.locator('#public-api-token-list')).toContainText('Real check integration');
    realChecks.push('real create plus versioned reads with credential');
    await realPage.locator('#public-api-dismiss-secret').click();
    await realPage.locator('#public-api-name').fill('Second real integration');
    await realPage.locator('#public-api-all-projects').check();
    await realPage.locator('#public-api-create').click();
    await expect(realPage.locator('#public-api-credential')).toBeVisible();
    const secondCredential = await realPage.locator('#public-api-credential').innerText();
    assert.ok(secondCredential.startsWith('pa_') && secondCredential !== firstCredential);
    await realPage.locator('#public-api-dismiss-secret').click();
    await expect(realPage.locator('#public-api-secret')).toBeHidden();
    realChecks.push('real second token with explicit all-projects scope');
    await realPage
      .locator('#public-api-token-list article', { hasText: 'Real check integration' })
      .getByRole('button', { name: 'Révoquer' })
      .click();
    await expect(realPage.locator('#toasts .toast').filter({ hasText: 'Jeton révoqué' })).toBeVisible();
    assert.equal((await admin('/api/v1/machine', { headers: withToken(firstCredential) })).status, 401);
    realChecks.push('real revoke cuts versioned access with 401');
    firstCredential = null;
    await realPage.locator('#public-api-enabled').click();
    await expect(realPage.locator('#public-api-enabled')).not.toBeChecked();
    await expect(realPage.locator('#public-api-token-list')).toContainText('Second real integration');
    assert.equal((await admin('/api/v1/machine', { headers: withToken(secondCredential) })).status, 404);
    assert.equal((await admin('/api/v1/projects', { headers: withToken(secondCredential) })).status, 404);
    realChecks.push('real disable preserves tokens and closes versioned reads with 404');
    await realPage
      .waitForFunction(() => !document.querySelector('#toasts .toast'), null, { timeout: 10000 })
      .catch(() => {});
    await realPage.locator('#settings-dialog').screenshot({
      path: '.local/public-api-preferences.png',
      animations: 'disabled',
    });
    realChecks.push('redacted preferences screenshot saved');
    await realPage.close();
  } finally {
    await realApp.close();
    assert.equal(dirname(realTemp), resolve(tmpdir()));
    await rm(realTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const moduleSource = await readFile(new URL('../public/api-settings.js', import.meta.url), 'utf8');
  assert.ok(!banned.test(moduleSource), 'API module keeps generic wording');
  const cssSource = await readFile(new URL('../public/settings.css', import.meta.url), 'utf8');
  assert.ok(!banned.test(cssSource.split('.public-api-card')[1] || ''), 'API styles keep generic wording');
  const dumpFinal = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  assert.ok(
    !storageHas(
      dumpFinal,
      adminState.tokens.flatMap((t) => [`pa_fixture_${t.id}`]),
    ),
    'no secret persists',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'generic wording FR+EN',
        'disabled by default with preserved tokens',
        'endpoints and machine display',
        'sensitive run and file warnings',
        'token create list revoke',
        'one-time secret with copy and clear',
        'revision conflict reload',
        'explicit project validation',
        'remote view without token controls',
        'full-control remote view without token controls',
        'no secret in storage',
        ...realChecks,
      ],
    }),
  );
} finally {
  clearTimeout(deadline);
  await browser?.close();
  await app.close();
  assert.equal(dirname(temp), resolve(tmpdir()));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
