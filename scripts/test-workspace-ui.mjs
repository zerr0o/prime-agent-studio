// Isolated PC/mobile acceptance: no real project, account, provider or agent is changed.
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApp } from '../server.mjs';
import { createMcpService } from '../lib/mcp-service.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';
import { captureEnglishDocumentation } from './documentation-capture.mjs';
const root = await mkdtemp(join(tmpdir(), 'prime-studio-workspace-ui-'));
const agentHome = join(root, 'agent'),
  cwd = join(root, 'Atelier'),
  other = join(root, 'Documents'),
  sessionDir = join(root, 'sessions');
await Promise.all([agentHome, cwd, other, sessionDir].map((path) => mkdir(path)));
const history =
  [
    { type: 'session', id: 'ui-session', cwd, timestamp: new Date().toISOString() },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'Préparer le projet' } },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Le projet est prêt. Quel est le prochain objectif ?' }],
      },
    },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n';
await writeFile(join(sessionDir, 'session.jsonl'), history);
const opened = [],
  controls = [],
  errors = [],
  checks = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/luna', name: 'Luna', provider: 'fixture' }],
    default: { model: 'fixture/luna' },
  }),
  async start(input) {
    let finish;
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    const control = {
      done,
      cancelCalls: 0,
      async cancel() {
        this.cancelCalls++;
        finish({ status: 'stopped', code: 130 });
      },
      finish() {
        input.onEvent({ kind: 'done', status: 'completed', code: 0 });
        finish({ status: 'completed', code: 0 });
      },
    };
    controls.push(control);
    return control;
  },
  async close() {
    for (const control of controls) await control.cancel();
  },
};
const nativeMcp = createMcpService({ agentHome });
const mcp = {
  ...nativeMcp,
  probe: async () => ({
    total: 1,
    tools: [
      {
        name: 'rechercher',
        description: '<script>untrusted()</script>Recherche une entrée.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ],
  }),
};
const app = createApp({
  agentHome,
  sessionDir,
  dataDir: join(root, 'data'),
  initialCwd: cwd,
  runtime,
  mcp,
  openDirectory: async (path) => {
    opened.push(path);
    return { opened: true };
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
await app.store.project({ cwd, pinned: false }, true);
await app.store.project({ cwd: other, pinned: false });
const code = '49283175',
  salt = 'e54d6dd09bb15f7c347b38b671472aa9';
const gateway = createLanGateway({
  upstreamPort: app.server.address().port,
  host: '127.0.0.1',
  port: 0,
  config: { salt, codeHash: hashAccessCode(code, salt), readOnly: false },
});
await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${gateway.address().port}`;
let browser, page;
async function settings() {
  await page.locator('#toggle-sidebar').click();
  if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
}
async function boxInside(selector, width, height) {
  // Mobile viewport dimensions are applied on the next animation frame.
  await expect
    .poll(async () => {
      const current = await page.locator(selector).boundingBox();
      return (
        !!current &&
        current.x >= 0 &&
        current.y >= 0 &&
        current.x + current.width <= width + 1 &&
        current.y + current.height <= height + 1
      );
    })
    .toBe(true);
  const box = await page.locator(selector).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
  return box;
}
try {
  browser = await launchStudioBrowser();
  page = await browser.newPage({
    locale: 'fr-FR',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator('#code').fill(code);
  await page.getByRole('button', { name: 'Ouvrir le studio' }).click();
  await expect(page.locator('#connection-label')).toContainText('connecté');
  await page.locator('#toggle-sidebar').click();
  await page.locator('#project-list .project-row').filter({ hasText: 'Atelier' }).click();
  await page.locator('#project-session-list').getByText('Préparer le projet', { exact: true }).click();
  await page.locator('#session-menu-button').tap();
  await expect(page.locator('#session-menu')).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('resize'));
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('#session-menu')).toBeVisible();
  await boxInside('#session-menu', 390, 844);
  await page.locator('#session-menu [data-action="rename"]').tap();
  await expect(page.locator('#rename-dialog')).toBeVisible();
  await page.locator('#rename-dialog [data-close-dialog]').first().click();
  checks.push('Menu de session mobile tactile, stable au redimensionnement et utilisable');
  await page.locator('#toggle-sidebar').click();
  const projectMore = page.getByRole('button', { name: 'Options du projet Atelier', exact: true });
  await projectMore.tap();
  await expect(page.locator('#project-menu')).toBeVisible();
  await boxInside('#project-menu', 390, 844);
  await page.locator('#project-menu [data-project-action="open"]').tap();
  await expect.poll(() => opened).toEqual([cwd]);
  await projectMore.tap();
  await page.locator('#project-menu [data-project-action="pin"]').tap();
  await expect(
    page.locator('#project-list .project-row').filter({ hasText: 'Atelier' }).locator('.project-pin'),
  ).toBeVisible();
  await projectMore.tap();
  await expect(page.locator('#project-pin-label')).toHaveText('Désépingler');
  await page.locator('#project-menu [data-project-action="remove"]').tap();
  await expect(page.locator('#remove-project-dialog')).toContainText(
    'Le dossier et les sessions restent sur le PC.',
  );
  await page.locator('#remove-project-dialog [data-close-dialog]').click();
  expect((await (await page.request.get(url + '/api/overview')).json()).projects).toHaveLength(2);
  await projectMore.tap();
  await page.locator('#project-menu [data-project-action="remove"]').tap();
  await page.locator('#remove-project-form [type="submit"]').click();
  await expect(page.locator('#remove-project-dialog')).toBeHidden();
  await expect(page.locator('#project-list .project-row')).toHaveCount(1);
  expect(await readFile(join(sessionDir, 'session.jsonl'), 'utf8')).toBe(history);
  await page.reload();
  await expect(page.locator('#project-list .project-row')).toHaveCount(1);
  await page.request.post(url + '/api/projects', { data: { cwd } });
  await page.reload();
  checks.push(
    'Menu projet mobile au-dessus du volet, ouverture sur PC, épingle et confirmation de retrait persistant',
  );
  await settings();
  const logout = await boxInside('#logout-button', 390, 844),
    done = await page.locator('#settings-dialog .settings-actions [data-close-dialog]').boundingBox();
  expect(logout.x + logout.width).toBeLessThan(done.x);
  expect(Math.abs(logout.y - done.y)).toBeLessThan(14);
  await expect(page.locator('#logout-button')).toHaveCSS('color', 'rgb(232, 162, 162)');
  await page.locator('#settings-tab-tools').click();

  await page.locator('#open-mcp-settings').click();
  await expect(page.locator('.mcp-card')).toHaveCount(2);
  await expect(page.locator('#mcp-search')).toHaveCSS('font-size', '16px');
  await page.locator('#mcp-add').click();
  await page.locator('#mcp-name').fill('documentation');
  await page.locator('#mcp-url').fill('https://docs.example.test/mcp');
  await page.locator('.mcp-advanced summary').click();
  await page.locator('#mcp-headers').fill('{"Authorization":"fixture-private-header"}');
  await page.locator('#mcp-save').click();
  await expect(page.locator('#mcp-form')).toBeHidden();
  const card = page.locator('.mcp-card[data-name="documentation"]');
  await expect(card).toContainText('Configuré');
  await card.getByRole('button', { name: 'Modifier', exact: true }).click();
  await expect(page.locator('#mcp-headers')).toHaveValue('{\n  "Authorization": null\n}');
  await page.locator('#mcp-tools-mode').selectOption('selected');
  await page.locator('#mcp-enabled-tools').fill('rechercher');
  await page.locator('#mcp-save').click();
  await card.getByRole('button', { name: 'Tester', exact: true }).click();
  await expect(page.locator('#mcp-test-status')).toContainText('Connexion réussie');
  await page.locator('.mcp-tool summary').click();
  await expect(page.locator('.mcp-tool')).toContainText('<script>untrusted()</script>');
  expect(await page.locator('.mcp-tool script').count()).toBe(0);
  await page.locator('#mcp-test-back').click();
  await card.getByRole('button', { name: 'Désactiver', exact: true }).click();
  await expect(card).toContainText('Désactivé');
  await card.getByRole('button', { name: 'Activer', exact: true }).click();
  await expect(card).toContainText('Configuré');
  await page.locator('#mcp-search').fill('document');
  await expect(page.locator('.mcp-card')).toHaveCount(1);
  await page.locator('#mcp-search').fill('');
  await mkdir(resolve('test-results'), { recursive: true });
  await page.screenshot({ path: resolve('test-results/mcp-mobile.png'), animations: 'disabled' });
  await boxInside('#mcp-dialog', 390, 844);
  await page.setViewportSize({ width: 844, height: 390 });
  await boxInside('#mcp-dialog', 844, 390);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: resolve('test-results/mcp-desktop.png'), animations: 'disabled' });
  await captureEnglishDocumentation(page, 'desktop-mcp.png', page.locator('#mcp-dialog'));
  if (process.argv.includes('--capture-docs')) {
    await mkdir(resolve('docs/screenshots'), { recursive: true });
    await page
      .locator('#mcp-dialog')
      .screenshot({ path: resolve('docs/screenshots/desktop-mcp.png'), animations: 'disabled' });
  }
  await card.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await page.locator('#mcp-remove-cancel').click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await page.locator('#mcp-remove-confirm').click();
  await expect(card).toHaveCount(0);
  checks.push(
    'Gestion MCP sur mobile/PC : ajout, édition, secrets masqués, outils, recherche, activation et suppression confirmée',
  );
  await page.locator('#mcp-close').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('#settings-dialog .settings-actions [data-close-dialog]').click();
  await page.locator('#project-list .project-row').filter({ hasText: 'Atelier' }).click({ button: 'right' });
  await expect(page.locator('#project-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  const started = await page.request.post(url + '/api/runs', {
    data: { cwd, sessionId: 'ui-session', message: 'Fixture active during logout', model: 'fixture/luna' },
  });
  expect(started.status()).toBe(201);
  await settings();
  await page.locator('#logout-button').click();
  await expect(page.locator('#code')).toBeVisible();
  expect((await page.request.get(url + '/api/bootstrap')).status()).toBe(401);
  expect(controls[0].cancelCalls).toBe(0);
  expect(
    (await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/runs`)).json()).runs,
  ).toHaveLength(1);
  controls[0].finish();
  expect(errors).toEqual([]);
  checks.push('Déconnexion mobile rouge à gauche, accès révoqué, session active conservée');
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} catch (error) {
  if (page) {
    await mkdir(resolve('test-results'), { recursive: true });
    await page.screenshot({ path: resolve('test-results/workspace-failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  await app.close();
  expect(dirname(root)).toBe(resolve(tmpdir()));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
