import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { createApp } from '../server.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-studio-ui-'));
const sessionDir = join(temp, 'sessions'),
  cwd = join(temp, 'Atelier'),
  dataDir = join(temp, 'data'),
  agentHome = join(temp, 'agent');
await Promise.all([mkdir(sessionDir), mkdir(cwd), mkdir(agentHome)]);
const fixture = [
  { type: 'session', id: 'session-demo', version: 3, cwd, timestamp: new Date().toISOString() },
  {
    type: 'message',
    id: 'u1',
    parentId: null,
    message: { role: 'user', content: 'Conversation de démonstration' },
  },
  {
    type: 'message',
    id: 'a1',
    parentId: 'u1',
    message: {
      role: 'assistant',
      model: 'gpt-5.6-luna',
      provider: 'openai-codex',
      content: [
        {
          type: 'text',
          text: '## Un projet prêt à évoluer\n\nVoici un **résultat vérifié**.\n\n```js\nconst studio = "Prime Agent";\nconsole.log(studio);\n```\n\n<script>window.__xss = true</script><img src=x onerror="window.__xss = true">\n\n| Fichier | État |\n| --- | --- |\n| app.js | Prêt |',
        },
        { type: 'thinking', thinking: 'Vérification de la structure.' },
        { type: 'toolCall', id: 't1', name: 'ipython', arguments: { code: 'print("Analyse terminée")' } },
      ],
    },
  },
  {
    type: 'message',
    id: 'r1',
    parentId: 'a1',
    message: {
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'ipython',
      content: [{ type: 'text', text: 'Analyse terminée' }],
      isError: false,
    },
  },
];
await writeFile(join(sessionDir, 'session-demo.jsonl'), fixture.map(JSON.stringify).join('\n') + '\n');
await writeFile(
  join(agentHome, 'models.json'),
  JSON.stringify(
    {
      providers: {
        opencode: {
          name: 'OpenCode Zen',
          baseUrl: 'https://opencode.ai/zen/v1',
          api: 'openai-responses',
          apiKey: 'public',
          models: [
            {
              id: 'muse-spark-1.3-contributor-free',
              name: 'Muse Spark 1.3 Free',
              api: 'openai-responses',
              baseUrl: 'https://opencode.ai/zen/v1',
              reasoning: true,
              input: ['text', 'image'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1048576,
              maxTokens: 131072,
            },
          ],
        },
      },
    },
    null,
    2,
  ) + '\n',
);
const handles = new Set();
let serial = 0;
const runtime = {
  getStatus: async () => ({ version: '0.9.1', available: true, cli: 'fixture' }),
  async getModels() {
    const models = [
      {
        id: 'anthropic/claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        provider: 'anthropic',
        reasoning: true,
      },
      {
        id: 'prime-inference/claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        provider: 'prime-inference',
        reasoning: true,
      },
      { id: 'google/gemini-3-flash', name: 'Gemini 3 Flash', provider: 'google', reasoning: true },
      { id: 'openai-codex/gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'openai-codex', reasoning: true },
      { id: 'openai-codex/gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai-codex', reasoning: true },
    ];
    try {
      const configured = JSON.parse(await readFile(join(agentHome, 'models.json'), 'utf8'));
      for (const [provider, providerConfig] of Object.entries(configured.providers || {}))
        for (const model of providerConfig.models || [])
          models.push({
            id: `${provider}/${model.id}`,
            name: model.name || model.id,
            provider,
            reasoning: model.reasoning === true,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          });
    } catch {}
    let defaultModel = 'openai-codex/gpt-5.6-luna';
    try {
      const settings = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8')),
        configured = `${settings.defaultProvider}/${settings.defaultModel}`;
      if (models.some((model) => model.id === configured)) defaultModel = configured;
    } catch {}
    return { models, default: { model: defaultModel, thinking: 'low' } };
  },
  async start(input) {
    const index = ++serial,
      id = input.sessionId || `session-ui-${index}`,
      file = join(sessionDir, id + '.jsonl');
    if (input.message === '__late_history__') {
      let resolveDone,
        ended = false;
      const done = new Promise((r) => (resolveDone = r)),
        timers = [];
      const emit = (e) => {
        if (!ended) input.onEvent(e);
      };
      const finish = async (status) => {
        if (ended) return;
        ended = true;
        timers.forEach(clearTimeout);
        if (status === 'completed')
          await writeFile(
            file,
            [
              { type: 'session', id, version: 3, cwd: input.cwd, timestamp: new Date().toISOString() },
              {
                type: 'message',
                id: 'late-user',
                parentId: null,
                message: { role: 'user', content: input.message },
              },
              {
                type: 'message',
                id: 'late-answer',
                parentId: 'late-user',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'Historique tardif récupéré.' }],
                },
              },
            ]
              .map(JSON.stringify)
              .join('\n') + '\n',
          );
        const result = { kind: 'done', sessionId: id, status, code: 0 };
        input.onEvent(result);
        resolveDone(result);
        handles.delete(handle);
      };
      const handle = { sessionId: id, done, cancel: () => finish('stopped') };
      handles.add(handle);
      timers.push(setTimeout(() => emit({ kind: 'session', sessionId: id, cwd: input.cwd }), 20));
      timers.push(setTimeout(() => emit({ kind: 'message_start', role: 'assistant' }), 400));
      timers.push(setTimeout(() => emit({ kind: 'text', delta: 'Historique tardif récupéré.' }), 900));
      timers.push(setTimeout(() => void finish('completed'), 1800));
      return handle;
    }
    if (!input.sessionId)
      await writeFile(
        file,
        JSON.stringify({
          type: 'session',
          id,
          version: 3,
          cwd: input.cwd,
          timestamp: new Date().toISOString(),
        }) + '\n',
      );
    const previous = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
      .findLast((e) => e.type !== 'session');
    const user = {
      type: 'message',
      id: `user-${index}`,
      parentId: previous?.id || null,
      message: { role: 'user', content: input.message, timestamp: Date.now() },
    };
    await appendFile(file, JSON.stringify(user) + '\n');
    let complete,
      finished = false,
      lastEntryId = user.id;
    const done = new Promise((r) => (complete = r)),
      timers = [];
    const send = (e) => {
      if (!finished) input.onEvent(e);
    };
    const finish = async (status) => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      if (status === 'completed')
        await appendFile(
          file,
          JSON.stringify({
            type: 'message',
            id: `assistant-${index}`,
            parentId: lastEntryId,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Réponse de vérification terminée.' }],
              model: 'gpt-5.6-luna',
              provider: 'openai-codex',
              timestamp: Date.now(),
            },
          }) + '\n',
        );
      const result = {
        kind: 'done',
        sessionId: id,
        status,
        code: status === 'completed' ? 0 : null,
        ...(status === 'failed' ? { error: 'Fournisseur indisponible' } : {}),
      };
      input.onEvent(result);
      complete(result);
      handles.delete(handle);
    };
    const handle = { sessionId: id, done, cancel: () => finish('stopped') };
    handles.add(handle);
    const later = (ms, event) => timers.push(setTimeout(() => send(event), ms));
    later(50, { kind: 'session', sessionId: id, cwd: input.cwd });
    later(80, { kind: 'message', message: { role: 'user', text: input.message, tools: [] } });
    later(120, { kind: 'message_start', role: 'assistant' });
    later(200, { kind: 'thinking', delta: 'Analyse de votre demande.' });
    timers.push(
      setTimeout(async () => {
        if (finished) return;
        await appendFile(
          file,
          JSON.stringify({
            type: 'message',
            id: `call-${index}`,
            parentId: user.id,
            message: {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'Analyse de votre demande.' },
                {
                  type: 'toolCall',
                  id: `tool-${index}`,
                  name: 'ipython',
                  arguments: { code: 'print("Outil vérifié")' },
                },
              ],
            },
          }) + '\n',
        );
        lastEntryId = `call-${index}`;
        send({
          kind: 'message',
          message: {
            role: 'assistant',
            text: '',
            thinking: 'Analyse de votre demande.',
            tools: [
              {
                id: `tool-${index}`,
                name: 'ipython',
                args: { code: 'print("Outil vérifié")' },
                status: 'pending',
              },
            ],
          },
        });
      }, 300),
    );
    later(400, {
      kind: 'tool_start',
      id: `tool-${index}`,
      name: 'ipython',
      args: { code: 'print("Outil vérifié")' },
    });
    timers.push(
      setTimeout(async () => {
        if (finished) return;
        await appendFile(
          file,
          JSON.stringify({
            type: 'message',
            id: `result-${index}`,
            parentId: `call-${index}`,
            message: {
              role: 'toolResult',
              toolCallId: `tool-${index}`,
              toolName: 'ipython',
              content: [{ type: 'text', text: 'Outil vérifié' }],
              isError: false,
            },
          }) + '\n',
        );
        lastEntryId = `result-${index}`;
        send({
          kind: 'tool_end',
          id: `tool-${index}`,
          name: 'ipython',
          result: { content: [{ type: 'text', text: 'Outil vérifié' }] },
          isError: false,
        });
      }, 550),
    );
    later(620, { kind: 'message_start', role: 'assistant' });
    later(700, { kind: 'text', delta: 'Réponse de vérification ' });
    later(1600, { kind: 'text', delta: 'terminée.' });
    later(1800, {
      kind: 'message',
      message: {
        role: 'assistant',
        text: 'Réponse de vérification terminée.',
        tools: [],
        timestamp: Date.now(),
      },
    });
    timers.push(
      setTimeout(
        () => void finish(input.message === '__provider_failure__' ? 'failed' : 'completed'),
        input.message === '__provider_failure__' ? 200 : 2100,
      ),
    );
    return handle;
  },
  async close() {
    await Promise.all([...handles].map((h) => h.cancel()));
  },
};
const app = createApp({ runtime, agentHome, sessionDir, dataDir, initialCwd: cwd });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${app.server.address().port}`;
let browser;
const report = [];
try {
  browser = await launchStudioBrowser();
  const context = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 1512, height: 982 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const expectedValidation =
      message.text().includes('400 (Bad Request)') && message.location().url.endsWith('/api/projects');
    const expectedDisconnect =
      message.text().includes('ERR_INCOMPLETE_CHUNKED_ENCODING') &&
      message.location().url.includes('/events');
    if (
      message.type() === 'error' &&
      !message.text().includes('404') &&
      !expectedValidation &&
      !expectedDisconnect
    )
      errors.push(message.text());
  });
  await page.goto(url);
  await expect(page.locator('#connection-label')).not.toHaveText('Connexion…');
  await expect(page.locator('#project-list')).toContainText('Atelier');
  await expect(page.locator('#model-picker-button')).toContainText('GPT-5.6 Luna');
  await expect(page.locator('#model-picker-provider')).toHaveText('openai-codex');
  const peerPage = await page.context().newPage();
  await peerPage.goto(url);
  await expect(peerPage.locator('#connection-label')).not.toHaveText('Connexion…');
  await page.locator('#model-picker-button').click();
  await expect(page.locator('#model-dialog')).toBeVisible();
  await expect(page.locator('#model-search')).toBeFocused();
  await page.locator('#model-search').fill('claude sonnet 4 6');
  await expect(page.locator('#model-list .model-row')).toHaveCount(2);
  const duplicateNames = await page
    .locator('#model-list .model-choice')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  expect(new Set(duplicateNames).size).toBe(2);
  await page.locator('#model-search').fill('ANTHROPIC');
  await expect(page.locator('#model-list .model-row')).toHaveCount(1);
  const desktopClaude = page.locator('#model-list .model-row').filter({ hasText: 'Claude Sonnet 4.6' });
  await desktopClaude.locator('.model-favorite').click();
  await expect(desktopClaude.locator('.model-favorite')).toHaveAttribute('aria-pressed', 'true');
  await peerPage.locator('#model-picker-button').click();
  await peerPage.locator('#model-search').fill('gemini');
  const peerGemini = peerPage.locator('#model-list .model-row').filter({ hasText: 'Gemini 3 Flash' });
  await peerGemini.locator('.model-favorite').click();
  await peerPage.close();
  await page.locator('#model-search').fill('');
  await page.locator('#model-favorites-filter').click();
  await expect(page.locator('#model-list .model-row')).toHaveCount(2);
  await desktopClaude.locator('.model-choice').click();
  await expect(page.locator('#model-dialog')).toBeHidden();
  await expect(page.locator('#model-picker-button')).toContainText('Claude Sonnet 4.6');
  await expect(page.locator('#model-picker-provider')).toHaveText('anthropic');
  report.push('Recherche, sélection et favoris des modèles');
  await page.keyboard.press('Control+n');
  await expect(page.locator('#model-picker-button')).toContainText('GPT-5.6 Luna');
  await expect(page.locator('#detail-session-id')).toBeHidden();
  expect(serial).toBe(0);
  await page.locator('#session-list').getByText('Conversation de démonstration', { exact: true }).click();
  await expect(page.locator('#messages')).toContainText('Un projet prêt à évoluer');
  await expect(page.locator('#messages pre').filter({ hasText: 'const studio' })).toHaveCount(1);
  expect(await page.evaluate(() => !!window.__xss)).toBe(false);
  await page.locator('#messages .copy-code').first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('const studio');
  report.push('Historique natif, Markdown et nettoyage HTML');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-session').click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(await readFile(downloadPath, 'utf8')).toContain('Conversation de démonstration');
  report.push('Export Markdown');
  await mkdir(resolve('test-results'), { recursive: true });
  await page.screenshot({
    path: resolve('test-results', 'desktop-conversation.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.locator('#new-session').click();
  await expect(page.locator('#welcome')).toBeVisible();
  await page.screenshot({
    path: resolve('test-results', 'desktop-welcome.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.locator('#composer').fill('Vérifie la reprise après rechargement.');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  await expect(page.locator('#messages')).toContainText('Réponse de vérification');
  await page.reload();
  await expect(page.locator('#messages')).toContainText('Réponse de vérification terminée.', {
    timeout: 15000,
  });
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 15000 });
  await page.locator('#model-picker-button').click();
  await page.locator('#model-favorites-filter').click();
  await expect(page.locator('#model-list')).toContainText('Claude Sonnet 4.6');
  await expect(page.locator('#model-list')).toContainText('Gemini 3 Flash');
  await expect(page.locator('#model-list .model-row')).toHaveCount(2);
  await page.locator('#model-dialog [data-close-dialog]').click();
  expect(
    await page
      .locator('#messages')
      .getByText('Vérifie la reprise après rechargement.', { exact: true })
      .count(),
  ).toBe(1);
  await expect(page.locator('#messages .tool-block')).toHaveCount(1);
  report.push('Envoi, streaming, rechargement et reprise sans doublon');
  await page.locator('#new-session').click();
  await page.locator('#composer').fill('__late_history__');
  await page.locator('#send-button').click();
  await expect(page.locator('#detail-session-id')).toContainText('session-ui-');
  await page.reload();
  await expect(page.locator('#messages')).toContainText('Historique tardif récupéré.', { timeout: 15000 });
  await expect(page.locator('#stop-button')).toBeHidden();
  report.push('Reprise avant la première écriture de l’historique');
  await page.locator('#composer').fill('Une exécution à interrompre.');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  await page.locator('#stop-button').click();
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 10000 });
  report.push('Arrêt d’une exécution');
  await page.locator('#composer').fill('Reprise après perte du serveur.');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  for (const run of app.runs.values()) for (const client of run.clients) client.destroy();
  app.runs.clear();
  await Promise.all([...handles].map((handle) => handle.cancel()));
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 10000 });
  await expect(page.locator('#messages')).toContainText('Reprise après perte du serveur.');
  report.push('Récupération après la perte d’une exécution côté serveur');
  await page.locator('#composer').fill('__provider_failure__');
  await page.locator('#send-button').click();
  await expect(page.getByText('Fournisseur indisponible', { exact: true }).first()).toBeVisible();
  await expect(page.locator('#stop-button')).toBeHidden();
  report.push('Affichage des erreurs du fournisseur');
  await page.locator('#session-menu-button').click();
  await page.locator('[data-action="rename"]').click();
  await page.locator('#session-title').fill('Session renommée');
  await page.locator('#rename-form').getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.locator('#header-session')).toHaveText('Session renommée');
  await page.locator('#session-menu-button').click();
  await page.locator('[data-action="pin"]').click();
  await page.locator('#session-menu-button').click();
  await page.locator('[data-action="archive"]').click();
  await page.locator('#show-archived').click();
  await expect(page.locator('#session-list')).toContainText('Session renommée');
  report.push('Renommage, épinglage et archivage');
  await page.keyboard.press('Control+k');
  await expect(page.locator('#session-search')).toBeFocused();
  await page.locator('#session-search').fill('introuvable-xyz');
  await expect(page.locator('#session-list')).not.toContainText('Session renommée');
  await page.locator('#session-search').fill('');
  await page.locator('#add-project').click();
  await page.locator('#project-cwd').fill(join(temp, 'missing'));
  await page.locator('#project-submit').click();
  await expect(page.locator('#project-error')).toBeVisible();
  const second = join(temp, 'Second projet');
  await mkdir(second);
  await page.locator('#project-cwd').fill(second);
  await page.locator('#project-name').fill('Nouveau projet');
  await page.locator('#project-submit').click();
  await expect(page.locator('#project-dialog')).not.toBeVisible();
  await expect(page.locator('#project-list')).toContainText('Nouveau projet');
  await expect(page.locator('#project-overview')).toBeVisible();
  await page.locator('#project-new-session').click();
  await page.locator('#composer').fill('Brouillon conservé');
  await page.reload();
  await expect(page.locator('#composer')).toHaveValue('Brouillon conservé');
  report.push('Recherche, validation des dossiers, ajout de projet et brouillons');
  if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
  await page.locator('#settings-tab-models').click();

  await expect(page.locator('#model-config-settings')).toBeVisible();
  await page.locator('#settings-tab-models').click();

  await page.locator('#open-model-config').click();
  await expect(page.locator('#model-config-dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ajouter Muse 1.3' })).toHaveCount(0);
  await expect(page.locator('#default-subagent-model')).toHaveAttribute('value', '');
  await expect(page.locator('#subagent-settings')).toContainText('Les choix explicites restent prioritaires');
  await expect(page.locator('#custom-model-list')).toContainText('muse-spark-1.3-contributor-free');
  await expect(page.locator('#custom-model-list')).toContainText('1 048 576 jetons');
  expect(
    await page.evaluate(() => document.body.innerText + JSON.stringify({ ...localStorage })),
  ).not.toContain('"public"');

  const previousConversationModel = await page.locator('#model-select').inputValue();
  await page.locator('#default-main-model').click();
  await expect(page.locator('#model-search')).toBeFocused();
  await expect(page.locator('#model-dialog-title')).toHaveText('Modèle principal par défaut');
  expect(
    await page.locator('#model-list .model-choice').evaluateAll((nodes) =>
      nodes
        .map((n) => n.dataset.modelId)
        .filter(Boolean)
        .sort(),
    ),
  ).toEqual(
    await page.locator('#model-select option').evaluateAll((nodes) =>
      nodes
        .map((n) => n.value)
        .filter(Boolean)
        .sort(),
    ),
  );
  await expect(page.locator('[data-model-id="anthropic/claude-sonnet-4-6"] .model-favorite')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.locator('#model-search').fill('muse spark 1 3');
  await page.locator('[data-model-id="opencode/muse-spark-1.3-contributor-free"] .model-choice').click();
  await expect(page.locator('#default-main-model')).toContainText('Muse Spark 1.3 Free');
  await expect(page.locator('#model-select')).toHaveValue(previousConversationModel);
  await expect(page.locator('#save-default-model')).toBeEnabled();
  await page.locator('#save-default-model').click();
  await expect(page.locator('#save-default-model')).toBeDisabled();
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8')).defaultModel;
      } catch {
        return null;
      }
    })
    .toBe('muse-spark-1.3-contributor-free');
  const nativeSettings = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  expect(nativeSettings.defaultProvider).toBe('opencode');
  expect(nativeSettings.defaultModel).toBe('muse-spark-1.3-contributor-free');
  await page.screenshot({
    path: resolve('test-results', 'default-model-picker-desktop.png'),
    animations: 'disabled',
  });
  await page.locator('#default-main-model').click();
  await page.locator('#model-search').fill('automatique');
  await page.locator('#model-list .model-choice').click();
  await expect(page.locator('#default-main-model')).toHaveAttribute('value', '');
  await expect(page.locator('#save-default-model')).toBeEnabled();
  await page.locator('#model-config-dialog [data-close-dialog]').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('#settings-dialog .settings-actions [data-close-dialog]').click();
  await expect(page.locator('#model-picker-button')).toContainText('Muse Spark 1.3 Free');
  await page.locator('#model-picker-button').click();
  await page.locator('#model-search').fill('Muse Spark 1.3');
  await expect(page.locator('#model-list .model-row')).toHaveCount(1);
  await page.locator('#model-dialog [data-close-dialog]').click();

  if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
  await page.locator('#settings-tab-models').click();

  await page.locator('#open-model-config').click();
  await expect(page.locator('#custom-model-list')).toContainText('Muse Spark 1.3 Free');
  await page.locator('#custom-model-list [data-edit-model="0"]').click();
  await expect(page.locator('#model-config-form')).toBeVisible();
  await expect(page.locator('#custom-model-url')).toHaveValue('https://opencode.ai/zen/v1');
  await page.locator('#custom-model-name').fill('Muse Spark 1.3 Free configuré');
  await page.locator('#save-model-config').click();
  await expect(page.locator('#model-config-list-view')).toBeVisible();
  await expect(page.locator('#custom-model-list')).toContainText('Muse Spark 1.3 Free configuré');
  await page.locator('#model-config-dialog [data-close-dialog]').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('#settings-dialog .settings-actions [data-close-dialog]').click();
  await expect(page.locator('#model-picker-button')).toContainText('Muse Spark 1.3 Free configuré');
  report.push('Configurateur générique, modèle principal natif et héritage fidèle des sous-agents');

  // History keeps its own model; every entry point for a new conversation restores the configured default.
  await page.locator('#project-list').getByText('Atelier', { exact: true }).click();
  await page
    .locator('#project-session-list')
    .getByText('Conversation de démonstration', { exact: true })
    .click();
  await expect(page.locator('#model-picker-button')).toContainText('GPT-5.6 Luna');
  await page.keyboard.press('Control+n');
  await expect(page.locator('#model-picker-button')).toContainText('Muse Spark 1.3 Free configuré');
  const chooseGemini = async () => {
    await page.locator('#model-picker-button').click();
    await page.locator('#model-search').fill('gemini');
    await page.locator('[data-model-id="google/gemini-3-flash"] .model-choice').click();
    await expect(page.locator('#model-picker-button')).toContainText('Gemini 3 Flash');
  };
  await chooseGemini();
  await page.locator('#new-session').click();
  await expect(page.locator('#model-picker-button')).toContainText('Muse Spark 1.3 Free configuré');
  await chooseGemini();
  await page.reload();
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('#model-picker-button')).toContainText('Muse Spark 1.3 Free configuré');
  report.push(
    'Nouvelles conversations et Ctrl+N utilisent le modèle configuré, sans modifier celui des historiques',
  );

  if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
  await page.locator('#settings-tab-appearance').click();
  await page.locator('[data-theme-choice="light"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#settings-dialog').getByRole('button', { name: 'Terminé' }).click();
  await page.screenshot({
    path: resolve('test-results', 'desktop-light.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.locator('#new-session').click();
  await expect(page.locator('#composer')).toBeVisible();
  await expect.poll(() => page.locator('#conversation-scroll').evaluate((node) => node.scrollTop)).toBe(0);
  await page.screenshot({
    path: resolve('test-results', 'mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  report.push('Thème clair, navigation mobile et absence de débordement');
  expect(errors).toEqual([]);
  await writeFile(
    resolve('test-results', 'ui-report.json'),
    JSON.stringify({ passed: true, checks: report }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks: report }, null, 2));
} catch (error) {
  console.error(error);
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
      await mkdir(resolve('test-results'), { recursive: true });
      await page
        .screenshot({ path: resolve('test-results', 'failure.png'), fullPage: true, animations: 'disabled' })
        .catch(() => {});
    }
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
  const cleanupPath = resolve(temp),
    tempRoot = resolve(tmpdir());
  if (!cleanupPath.startsWith(tempRoot + sep) || !basename(cleanupPath).startsWith('prime-studio-ui-'))
    throw new Error('Répertoire de test non reconnu : nettoyage refusé.');
  await rm(cleanupPath, { recursive: true, force: true });
}
