import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-i18n-'));
const cwd = join(temp, 'Projet'),
  agentHome = join(temp, 'agent'),
  sessionDir = join(temp, 'sessions');
await Promise.all([mkdir(cwd), mkdir(agentHome), mkdir(sessionDir)]);
const content =
  'Fermer\n\n## Raisonnement\n\nTexte utilisateur inchangé.\n\n```js\nconst label = "Enregistrer";\n```\n\n<span data-i18n="ui.fermer">Texte externe à préserver</span>';
await writeFile(join(cwd, 'README.md'), content);
await writeFile(
  join(sessionDir, 'translation-session.jsonl'),
  [
    { type: 'session', id: 'translation-session', version: 3, cwd, timestamp: new Date().toISOString() },
    { type: 'message', id: 'user-1', message: { role: 'user', content: 'Conversation française' } },
    {
      type: 'message',
      id: 'agent-1',
      message: {
        role: 'assistant',
        model: 'test-model',
        content: [
          { type: 'thinking', thinking: 'Raisonnement original' },
          { type: 'toolCall', id: 'tool-1', name: 'ipython', arguments: { code: 'print("Terminé")' } },
        ],
      },
    },
    {
      type: 'message',
      id: 'tool-result-1',
      message: { role: 'toolResult', toolCallId: 'tool-1', content: [{ type: 'text', text: 'Terminé' }] },
    },
    {
      type: 'message',
      id: 'agent-2',
      message: { role: 'assistant', content: [{ type: 'text', text: content }], stopReason: 'stop' },
    },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);
let finishStream,
  streamInput,
  cancellationCount = 0;
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [
      {
        id: 'test/test-model',
        name: 'Test Model',
        provider: 'test',
        reasoning: true,
        input: ['text', 'image'],
      },
    ],
    default: { model: 'test/test-model', thinking: 'high' },
  }),
  async start(input) {
    streamInput = input;
    const done = new Promise((resolve) => {
      finishStream = () => resolve({ status: 'completed' });
    });
    input.onEvent({ kind: 'session', sessionId: input.sessionId, cwd: input.cwd });
    input.onEvent({ kind: 'message', message: { role: 'user', text: input.message, tools: [] } });
    input.onEvent({ kind: 'message_start', role: 'assistant' });
    input.onEvent({ kind: 'text', delta: 'Réponse en cours, conservée. ' });
    return {
      sessionId: input.sessionId,
      done,
      cancel: () => {
        cancellationCount++;
        finishStream();
      },
    };
  },
  close: async () => finishStream?.(),
};
const providers = {
  list: async () => ({
    providers: [
      {
        id: 'test',
        name: 'Test Provider',
        models: 1,
        methods: ['api_key'],
        configured: false,
        revision: 'test',
      },
    ],
    busy: false,
  }),
  close: async () => {},
};
const mcp = { list: async () => ({ servers: [] }), close: async () => {} };
const app = createApp({
  runtime,
  providers,
  mcp,
  cwd,
  initialCwd: cwd,
  sessionDir,
  agentHome,
  dataDir: join(temp, 'data'),
});
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const salt = 'a'.repeat(32),
  code = '12345678';
const gateway = createLanGateway({
  host: '127.0.0.1',
  upstreamPort: app.server.address().port,
  config: { salt, codeHash: hashAccessCode(code, salt), readOnly: false },
});
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
const remoteUrl = `http://127.0.0.1:${gateway.address().port}`;
const browser = await launchStudioBrowser();
try {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toHaveText('Engine connected');
  if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
  await expect(page.locator('#language-select')).toHaveValue('auto');
  await page.locator('#settings-tab-appearance').click();

  await page.locator('#language-select').selectOption('fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('#connection-label')).toHaveText('Moteur connecté');
  await page.locator('#settings-tab-appearance').click();

  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('#connection-label')).toHaveText('Engine connected');
  await expect(page.locator('#open-model-config')).toHaveText('Configure');
  await expect(page.locator('#thinking-select option[value="medium"]')).toHaveText('Medium');
  await expect(page.locator('#project-dialog label[for="project-cwd"]')).toContainText('required');
  await expect(page.locator('#project-dialog label[for="project-name"]')).toContainText('optional');
  await page.locator('#settings-dialog [data-close-dialog]').first().click();
  await page.locator('.session-select').first().click();
  await expect(page.locator('.message.user')).toContainText('Conversation française');
  await expect(page.locator('.activity-label')).toHaveText('Agent activity');
  await expect(page.locator('.assistant-text')).toContainText('Texte utilisateur inchangé.');
  await expect(page.locator('.assistant-text')).toContainText('Texte externe à préserver');
  await expect(page.locator('.assistant-text .markdown-body [data-i18n]')).toHaveCount(0);
  await page.locator('#composer').fill('Mon brouillon /goal reste en français');
  if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
  await page.locator('#settings-tab-appearance').click();

  await page.locator('#language-select').selectOption('fr');
  await page.locator('#settings-dialog [data-close-dialog]').first().click();
  await expect(page.locator('#composer')).toHaveValue('Mon brouillon /goal reste en français');
  await expect(page.locator('.activity-label')).toHaveText('Activité de l’agent');
  await expect(page.locator('.assistant-text')).toContainText(content.split('\n\n')[2]);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('#composer')).toHaveValue('Mon brouillon /goal reste en français');
  await page.screenshot({ path: join(temp, 'desktop-fr.png'), fullPage: true });

  const peer = await context.newPage();
  peer.on('pageerror', (error) => errors.push(error.message));
  await peer.goto(url);
  if (!(await peer.locator('#settings-dialog').isVisible())) await peer.locator('#open-settings').click();
  if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
  await page.locator('#settings-tab-models').click();

  await page.locator('#open-provider-settings').click();
  await page.getByRole('button', { name: 'Ajouter une clé API', exact: true }).click();
  const secret = page.locator('.provider-form input[type=password]');
  await secret.fill('draft-placeholder-not-a-secret');
  await secret.evaluate((node) => {
    window.savedCredentialInput = node;
  });
  await peer.locator('#settings-tab-appearance').click();

  await peer.locator('#language-select').selectOption('en');
  await expect(page.locator('#providers-dialog')).toContainText('API key');
  await expect(secret).toHaveValue('draft-placeholder-not-a-secret');
  expect(await secret.evaluate((node) => node === window.savedCredentialInput)).toBe(true);
  await page.locator('#providers-done').click();
  await page.locator('#settings-tab-tools').click();

  await page.locator('#open-mcp-settings').click();
  await page.locator('#mcp-add').click();
  await page.locator('#mcp-name').fill('mon-service');
  await page.locator('#mcp-url').fill('https://example.com/mcp');
  await peer.locator('#settings-tab-appearance').click();

  await peer.locator('#language-select').selectOption('fr');
  await expect(page.locator('#mcp-form-title')).toHaveText('Ajouter un MCP');
  await expect(page.locator('#mcp-name')).toHaveValue('mon-service');
  await expect(page.locator('#mcp-url')).toHaveValue('https://example.com/mcp');
  await peer.locator('#settings-tab-appearance').click();

  await peer.locator('#language-select').selectOption('en');
  await expect(page.locator('#mcp-form-title')).toHaveText('Add an MCP');
  await page.locator('#mcp-close').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
  await page.screenshot({ path: join(temp, 'preferences-en.png'), fullPage: true });
  await page.locator('#settings-dialog [data-close-dialog]').first().click();
  await expect(page.locator('.activity-count')).toHaveText('1 tool call · 1 reflection');
  await page.screenshot({ path: join(temp, 'desktop-en.png'), fullPage: true });
  await page.locator('#composer').fill('Test de langue pendant une réponse');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  await page.locator('#composer').fill('Suite du brouillon');
  await page
    .locator('#attachment-files')
    .setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('Document original') });
  await expect(page.locator('#image-draft-tray')).toContainText('note.txt');
  const activeBefore = await (await context.request.get(url + '/api/runs')).json();
  await peer.locator('#settings-tab-appearance').click();

  await peer.locator('#language-select').selectOption('fr');
  await expect(page.locator('#run-status')).toContainText('L’agent travaille');
  await expect(page.locator('#composer')).toHaveValue('Suite du brouillon');
  await expect(page.locator('#image-draft-tray')).toContainText('note.txt');
  await peer.locator('#settings-tab-appearance').click();

  await peer.locator('#language-select').selectOption('en');
  await expect(page.locator('#run-status')).toContainText('The agent is working');
  streamInput.onEvent({ kind: 'text', delta: 'La réponse continue après le changement de langue.' });
  await expect(page.locator('#messages')).toContainText('La réponse continue après le changement de langue.');
  const activeAfter = await (await context.request.get(url + '/api/runs')).json();
  expect(activeAfter.runs[0].id).toBe(activeBefore.runs[0].id);
  expect(cancellationCount).toBe(0);
  finishStream();
  await expect(page.locator('#stop-button')).toBeHidden();
  await context.close();

  const mobileContext = await browser.newContext({
    locale: 'en-GB',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await mobileContext.newPage();
  mobile.on('pageerror', (error) => errors.push(error.message));
  await mobile.goto(remoteUrl);
  await expect(mobile.locator('[data-i18n="login.heading"]')).toHaveText('Your studio, within reach.');
  await mobile.locator('#code').fill('00000000');
  await mobile.getByRole('button', { name: 'Open Studio', exact: true }).click();
  await expect(mobile.locator('.error')).toHaveText('Incorrect code. Please try again.');
  await mobile.locator('#login-language').selectOption('fr');
  await expect(mobile.locator('.error')).toHaveText('Code incorrect. Réessayez.');
  await mobile.locator('#login-language').selectOption('en');
  await mobile.locator('#code').fill(code);
  await mobile.getByRole('button', { name: 'Open Studio', exact: true }).click();
  await expect(mobile.locator('#connection-label')).toHaveText('Engine connected');
  await mobile.locator('#toggle-sidebar').click();
  if (!(await mobile.locator('#settings-dialog').isVisible())) await mobile.locator('#open-settings').click();
  await expect(mobile.locator('#logout-button')).toHaveText('Sign out');
  await mobile.screenshot({ path: join(temp, 'mobile-preferences-en.png'), fullPage: true });
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mobile.locator('#settings-tab-appearance').click();

  await mobile.locator('#language-select').selectOption('fr');
  await expect(mobile.locator('#logout-button')).toHaveText('Se déconnecter');
  await mobile.locator('#settings-tab-appearance').click();

  await mobile.locator('#language-select').selectOption('en');
  await mobile.locator('#logout-button').click();
  await expect(mobile.locator('[data-i18n="login.heading"]')).toHaveText('Your studio, within reach.');
  const manifest = await (
    await mobileContext.request.get(remoteUrl + '/manifest.webmanifest?lang=en')
  ).json();
  expect(manifest.lang).toBe('en');
  expect(manifest.description).toContain('Local workspace');
  await mobile.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => mobile.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await mobileContext.setOffline(true);
  await mobile.reload();
  await expect(mobile.locator('.pwa-offline h1')).toHaveText('Let’s reconnect to your Studio.');
  await expect(mobile.locator('html')).toHaveAttribute('lang', 'en');
  await mobile.screenshot({ path: join(temp, 'offline-en.png'), fullPage: true });
  await mobileContext.close();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    JSON.stringify({
      passed: true,
      temp,
      checks: [
        'automatic English',
        'live switching',
        'draft preservation',
        'original messages preserved',
        'reload preference',
        'provider and MCP drafts preserved across tabs',
        'running stream and attachment draft preserved without cancellation',
        'mobile login and errors',
        'mobile logout',
        'localized manifest',
        'offline PWA',
      ],
    }),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => gateway.close(resolve));
  await app.close();
}
