// Isolated settings/UI proof. No OAuth login, MCP probe or agent is started.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect as baseExpect } from '@playwright/test';
import { createApp } from '../server.mjs';
const expect = baseExpect.configure({ timeout: 10000 });
const temp = await mkdtemp(join(tmpdir(), 'studio-mcp-settings-'));
const agentHome = join(temp, 'agent');
const cwd = join(temp, 'project');
const sessionDir = join(temp, 'sessions');
await Promise.all([agentHome, cwd, sessionDir].map((path) => mkdir(path)));
const app = createApp({
  agentHome,
  sessionDir,
  initialCwd: cwd,
  dataDir: join(temp, 'data'),
  runtime: {
    getStatus: async () => ({ available: true, version: '0.9.6 fixture' }),
    getModels: async () => ({ models: [], default: {} }),
    start: async () => {
      throw new Error('No agent may start');
    },
    close: async () => {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
let browser;
const deadline = setTimeout(() => {
  void browser?.close();
  void app.close();
}, 90000);
try {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chromium',
  });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [],
    forbiddenRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/mcp/**', async (route) => {
    forbiddenRequests.push(route.request().url());
    await route.abort();
  });
  await page.goto(url);
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-tools').click();
  await page.locator('#open-mcp-settings').click();
  await expect(page.locator('#mcp-dialog')).toBeVisible();
  await page.locator('#mcp-add').click();
  await page.locator('#mcp-name').fill('IdentityFixture');
  await page.locator('#mcp-url').fill('https://mcp.example.invalid/mcp');
  await page.locator('#mcp-auth').selectOption('oauth');
  await page.locator('.mcp-advanced summary').click();
  await expect(page.locator('#mcp-oauth-identity')).toBeVisible();
  const fields = {
    oauthClientId: ['mcp-oauth-client-id', 'fixture-public-client-id'],
    oauthClientSecretEnvVar: ['mcp-oauth-client-secret-env', 'MCP_UI_CLIENT_SECRET'],
    oauthClientMetadataUrl: ['mcp-oauth-metadata-url', 'https://client.example.invalid/client.json'],
    oauthScopes: ['mcp-oauth-scopes', 'read\nwrite'],
  };
  for (const [id, value] of Object.values(fields))
    await page.locator(`#${id}`).fill(value.replaceAll('\\n', '\n'));
  await page.locator('#mcp-save').click();
  const card = page.locator('.mcp-card[data-name="IdentityFixture"]');
  await expect(card).toBeVisible();
  const readConfig = async () =>
    JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8')).mcpServers.IdentityFixture;
  const config = await readConfig();
  assert.equal(config.oauthClientId, 'fixture-public-client-id');
  assert.equal(config.oauthClientSecretEnvVar, 'MCP_UI_CLIENT_SECRET');
  assert.equal(config.oauthClientMetadataUrl, 'https://client.example.invalid/client.json');
  assert.deepEqual(config.oauthScopes, ['read', 'write']);
  await card.getByRole('button', { name: 'Modifier', exact: true }).click();
  for (const [id, value] of Object.values(fields))
    await expect(page.locator(`#${id}`)).toHaveValue(value.replaceAll('\\n', '\n'));
  await page.locator('#mcp-timeout').fill('45000');
  await page.locator('#mcp-save').click();
  await expect(card).toBeVisible();
  assert.deepEqual(await readConfig(), { ...config, callTimeoutMs: 45000 });
  await card.getByRole('button', { name: 'Modifier', exact: true }).click();
  await mkdir('test-results/engine-0.9.6', { recursive: true });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('#mcp-oauth-client-id').scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.locator('#mcp-form').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
      .toBe(true);
    await page.screenshot({
      path: `test-results/engine-0.9.6/mcp-identity-${width}.png`,
      animations: 'disabled',
    });
  }
  // Reset fields explicitly. A budget-only edit above must not erase them.
  for (const [id] of Object.values(fields)) await page.locator(`#${id}`).fill('');
  await page.locator('#mcp-save').click();
  await expect(card).toBeVisible();
  const cleared = await readConfig();
  for (const key of Object.keys(fields)) assert.equal(key in cleared, false);
  assert.equal(cleared.oauth, true);
  assert.equal(cleared.callTimeoutMs, 45000);
  assert.deepEqual(forbiddenRequests, [], 'No login or probe is sent while editing');
  assert.deepEqual(errors, []);
  console.log(
    'MCP OAuth settings UI passed: four native fields, edit preservation, clear, 320/390/1440 layout, no login/probe.',
  );
} finally {
  clearTimeout(deadline);
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
