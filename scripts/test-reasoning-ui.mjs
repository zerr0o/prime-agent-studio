import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createApp } from '../server.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-reasoning-ui-'));
const cwd = join(temp, 'Atelier'),
  agentHome = join(temp, 'agent'),
  sessionDir = join(agentHome, 'sessions');
await mkdir(cwd);
await mkdir(sessionDir, { recursive: true });
await mkdir('test-results', { recursive: true });
const tail =
  'Ancien début de réflexion.\n\nDeuxième ligne ancienne.\n\nTroisième ligne ancienne.\n\nAvant-dernière ligne.\n\n**Dernière ligne formatée.**';
await writeFile(
  join(sessionDir, 'fixture.jsonl'),
  [
    { type: 'session', id: 'reasoning-fixture', cwd, version: 3, timestamp: new Date().toISOString() },
    { type: 'thinking_level_change', id: 'level', parentId: null, thinkingLevel: 'xhigh' },
    {
      type: 'message',
      id: 'user',
      parentId: 'level',
      message: { role: 'user', content: 'Vérifier les réflexions' },
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'user',
      message: {
        role: 'assistant',
        model: 'parent',
        provider: 'fixture',
        content: [{ type: 'thinking', thinking: 'Une réflexion précédente.' }],
      },
    },
    {
      type: 'message',
      id: 'a2',
      parentId: 'a1',
      message: {
        role: 'assistant',
        model: 'parent',
        provider: 'fixture',
        content: [{ type: 'thinking', thinking: tail }],
      },
    },
    {
      type: 'message',
      id: 'a3',
      parentId: 'a2',
      message: {
        role: 'assistant',
        model: 'parent',
        provider: 'fixture',
        content: [{ type: 'text', text: 'Vérification terminée.' }],
      },
    },
  ]
    .map(JSON.stringify)
    .join('\n'),
);
let input, finish;
const app = createApp({
  cwd,
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir: join(temp, 'data'),
  readInspectorEdges: async () => [],
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({
      models: [
        {
          id: 'fixture/parent',
          name: 'Principal',
          provider: 'fixture',
          reasoning: true,
          thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
        },
        {
          id: 'fixture/child',
          name: 'Sous-agent',
          provider: 'fixture',
          reasoning: true,
          thinkingLevels: ['off', 'low', 'high'],
        },
        {
          id: 'fixture/simple',
          name: 'Sans réflexion',
          provider: 'fixture',
          reasoning: false,
          thinkingLevels: ['off'],
        },
      ],
      default: { model: 'fixture/parent', thinking: 'high' },
    }),
    async start(value) {
      input = value;
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      return { sessionId: 'reasoning-fixture', done, cancel: () => finish({ status: 'stopped', code: 130 }) };
    },
    close: async () => {
      finish?.({ status: 'stopped', code: 130 });
    },
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await launchStudioBrowser();
const context = await browser.newContext({
  locale: 'fr-FR',
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
async function mode(label) {
  if (
    page.viewportSize().width <= 1080 &&
    !(await page.locator('#sidebar').evaluate((n) => n.classList.contains('mobile-open')))
  )
    await page.locator('#toggle-sidebar').click();
  if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
  await page.locator('#settings-tab-appearance').click();
  await page.locator('.reasoning-selector').getByText(label, { exact: true }).click();
  await page.locator('#settings-dialog').getByRole('button', { name: 'Terminé' }).click();
}
async function tailVisible(preview) {
  await expect
    .poll(() => preview.evaluate((n) => Math.abs(n.scrollHeight - n.clientHeight - n.scrollTop)))
    .toBeLessThanOrEqual(1);
  const box = await preview.evaluate((n) => ({
    height: n.getBoundingClientRect().height,
    line: parseFloat(getComputedStyle(n).lineHeight),
  }));
  expect(box.height).toBeLessThanOrEqual(box.line * 2 + 1);
}
try {
  await page.goto(url);
  // Project defaults are available before a native session or run exists.
  const draftSettings = page.locator('#project-subagent-settings');
  await page.locator('#inspector-tab-agents').click();
  await expect(draftSettings).toBeVisible();
  await expect(page.locator('#detail-session-id')).toBeHidden();
  await expect(draftSettings.locator('.subagent-scope')).toHaveValue('global');
  await draftSettings.locator('.subagent-scope').selectOption('project');
  await page.locator('#project-subagent-model').click();
  await page.locator('#model-search').fill('fixture child');
  await page.locator('[data-model-id="fixture/child"] .model-choice').click();
  await page.locator('#project-subagent-thinking').selectOption('low');
  const draftProjectUrl = `${url}/api/project-subagent-defaults?cwd=${encodeURIComponent(cwd)}`;
  await expect
    .poll(async () => (await (await fetch(draftProjectUrl)).json()).project)
    .toEqual({ model: 'fixture/child', thinking: 'low' });
  await page.keyboard.press('Control+n');
  await expect(draftSettings).toBeVisible();
  await expect(page.locator('#project-subagent-thinking')).toHaveValue('low');
  await expect(page.locator('#inspector-agent-summary')).toHaveText('Prochaines délégations');
  await expect(page.locator('#inspector-agent-list')).toContainText('après le premier message');
  await expect(page.locator('#detail-session-id')).toBeHidden();
  expect(input).toBeUndefined();
  await page.screenshot({ path: 'test-results/new-conversation-agents-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#toggle-details').click();
  await expect(draftSettings).toBeVisible();
  await page.screenshot({ path: 'test-results/new-conversation-agents-mobile.png' });
  await draftSettings.locator('.subagent-scope').selectOption('global');
  await expect.poll(async () => (await (await fetch(draftProjectUrl)).json()).project).toBeNull();
  await expect(draftSettings.locator('.subagent-fields')).toBeHidden();
  await page.locator('#close-inspector').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#session-list').getByText('Vérifier les réflexions', { exact: true }).click();
  const group = page.locator('#messages .activity-stack').first();
  const preview = group.locator('.activity-reasoning-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('strong')).toHaveText('Dernière ligne formatée.');
  await expect(preview).not.toContainText('Une réflexion précédente.');
  await tailVisible(preview);
  const clipping = await preview.evaluate((n) => ({
    top: n.getBoundingClientRect().top,
    first: n.querySelector('p').getBoundingClientRect().bottom,
    end: n.querySelector('strong').getBoundingClientRect().bottom,
    bottom: n.getBoundingClientRect().bottom,
  }));
  expect(clipping.first).toBeLessThan(clipping.top);
  expect(clipping.end).toBeLessThanOrEqual(clipping.bottom + 1);
  await mode('Masqué');
  await expect(preview).toBeHidden();
  await expect(group.locator('.thinking-block')).toHaveCount(0);
  await mode('Détaillé');
  await expect(group).toHaveAttribute('open', '');
  await expect(group.locator('.thinking-block[open]')).toHaveCount(2);
  await expect(group.locator('.thinking-content strong')).toBeVisible();
  await mode('Aperçu');
  await expect(group).not.toHaveAttribute('open', '');
  await tailVisible(preview);
  await page.reload();
  await expect(preview).toBeVisible();
  await tailVisible(preview);
  await page.locator('#inspector-tab-agents').click();
  await expect(page.locator('.inspector-agent-thinking')).toContainText('Très élevée');

  if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
  await page.locator('#settings-tab-models').click();

  await page.locator('#open-model-config').click();
  await expect(page.locator('#save-subagent-defaults')).toBeEnabled();
  const controlStyle = await page.evaluate(() => {
    const model = document.querySelector('#default-subagent-model');
    const thinking = document.querySelector('#default-subagent-thinking');
    return {
      modelY: model.getBoundingClientRect().top,
      thinkingY: thinking.getBoundingClientRect().top,
      modelColor: getComputedStyle(model).backgroundColor,
      thinkingColor: getComputedStyle(thinking).backgroundColor,
    };
  });
  expect(Math.abs(controlStyle.modelY - controlStyle.thinkingY)).toBeLessThanOrEqual(1);
  expect(controlStyle.thinkingColor).toBe(controlStyle.modelColor);
  await page.screenshot({ path: 'test-results/model-settings-alignment.png' });
  await expect(page.locator('#subagent-model-search, #subagent-scope')).toHaveCount(0);
  const mainModel = await page.locator('#model-select').inputValue();
  await page.locator('#default-subagent-model').click();
  const subagentCatalog = await page.locator('#model-list .model-choice').evaluateAll((nodes) =>
    nodes
      .map((n) => n.dataset.modelId)
      .filter(Boolean)
      .sort(),
  );
  await expect(page.locator('#model-search')).toBeFocused();
  await page.locator('#model-search').fill('Sous-agent');
  await page.locator('[data-model-id="fixture/child"] .model-favorite').click();
  await page.locator('[data-model-id="fixture/child"] .model-choice').click();
  await expect(page.locator('#default-subagent-thinking option')).toHaveCount(4);
  await page.locator('#default-subagent-thinking').selectOption('high');
  await page.locator('#save-subagent-defaults').click();
  await expect
    .poll(async () => (await (await fetch(`${url}/api/subagent-defaults`)).json()).global)
    .toEqual({ model: 'fixture/child', thinking: 'high' });
  await page.locator('#model-config-dialog [data-close-dialog]').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('#settings-dialog .settings-actions [data-close-dialog]').click();
  await expect(page.locator('#model-select')).toHaveValue(mainModel);
  await page.locator('#model-picker-button').click();
  expect(
    await page.locator('#model-list .model-choice').evaluateAll((nodes) =>
      nodes
        .map((n) => n.dataset.modelId)
        .filter(Boolean)
        .sort(),
    ),
  ).toEqual(subagentCatalog);
  await expect(page.locator('[data-model-id="fixture/child"] .model-favorite')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.locator('#model-dialog [data-close-dialog]').click();
  const settings = page.locator('#project-subagent-settings');
  await expect(settings.locator('.subagent-scope')).toHaveValue('global');
  await expect(page.locator('#project-subagent-model')).toHaveAttribute('value', 'fixture/child');
  await expect(settings.locator('.subagent-fields')).toBeHidden();
  await settings.locator('.subagent-scope').selectOption('project');
  await expect(settings.locator('.subagent-fields')).toBeVisible();
  await page.locator('#project-subagent-model').click();
  await expect(page.locator('#model-list .model-choice')).toHaveCount(4);
  await page.locator('#model-search').fill('sans reflexion');
  await page.locator('[data-model-id="fixture/simple"] .model-choice').click();
  await expect(page.locator('#project-subagent-thinking')).toHaveValue('');
  await expect(page.locator('#project-subagent-thinking option')).toHaveCount(2);
  await page.locator('#project-subagent-thinking').selectOption('off');
  const projectUrl = `${url}/api/project-subagent-defaults?cwd=${encodeURIComponent(cwd)}`;
  await expect
    .poll(async () => (await (await fetch(projectUrl)).json()).project)
    .toEqual({ model: 'fixture/simple', thinking: 'off' });
  await expect(settings.locator('.subagent-scope')).toHaveValue('project');
  await expect(page.locator('#model-select')).toHaveValue(mainModel);
  await page.screenshot({ path: 'test-results/subagent-settings-desktop.png' });
  // A stale tab must surface the conflict instead of overwriting the other editor.
  const current = await (await fetch(projectUrl)).json();
  await fetch(`${url}/api/subagent-defaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      revision: current.revision,
      policy: { model: 'fixture/parent', thinking: 'low' },
    }),
  });
  await settings.locator('.subagent-scope').selectOption('global');
  await expect(settings.locator('.subagent-error')).toContainText('autre fenêtre');
  await expect(settings.locator('.subagent-scope')).toHaveValue('project');
  await expect(settings.locator('.subagent-fields')).toBeVisible();
  await settings.locator('.subagent-reload').click();
  await expect(settings.locator('.subagent-scope')).toBeEnabled();
  await settings.locator('.subagent-scope').selectOption('global');
  await expect.poll(async () => (await (await fetch(projectUrl)).json()).project).toBeNull();
  await expect(settings.locator('.subagent-fields')).toBeHidden();
  expect((await (await fetch(projectUrl)).json()).effective).toEqual({
    model: 'fixture/parent',
    thinking: 'low',
  });

  await page.locator('#composer').fill('Réflexion en direct');
  await page.locator('#send-button').click();
  await expect.poll(() => !!input).toBe(true);
  input.onEvent({ kind: 'session', sessionId: 'reasoning-fixture', cwd });
  input.onEvent({ kind: 'thinking', delta: tail });
  const livePreview = page.locator('#messages .activity-stack').last().locator('.activity-reasoning-preview');
  await expect(livePreview).toBeVisible();
  await tailVisible(livePreview);
  input.onEvent({
    kind: 'thinking',
    delta:
      '\n\nSuite ajoutée en direct.\n\n**Tout dernier ajout.**\n\n<script>window.__reasoningXss = true</script>',
  });
  await expect(livePreview).toContainText('Tout dernier ajout.');
  await tailVisible(livePreview);
  expect(await page.evaluate(() => window.__reasoningXss)).toBeUndefined();
  await page.locator('.toast').last().waitFor({ state: 'hidden' });
  await page.screenshot({ path: 'test-results/reasoning-tail-desktop.png', animations: 'disabled' });
  for (const width of [390, 320, 760]) {
    await page.setViewportSize({ width, height: 844 });
    await tailVisible(livePreview);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#toggle-details').click();
  await page.locator('#inspector-tab-agents').click();
  await expect(settings).toBeVisible();
  await expect(settings.locator('.subagent-fields')).toBeHidden();
  await settings.locator('.subagent-scope').selectOption('project');
  await expect(settings.locator('.subagent-fields')).toBeVisible();
  await page.locator('#project-subagent-model').click();
  await expect(page.locator('#model-search')).toBeFocused();
  await page.locator('#model-search').fill('fixture child');
  await expect(page.locator('#model-list .model-choice')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#model-dialog')).toBeHidden();
  await expect(page.locator('#project-subagent-model')).toBeFocused();
  await expect(settings).toBeVisible();
  await settings.locator('.subagent-scope').selectOption('global');
  await expect(settings.locator('.subagent-fields')).toBeHidden();
  await page.screenshot({ path: 'test-results/subagent-settings-mobile.png' });
  await page.locator('#close-inspector').click();
  await page.locator('#conversation-scroll').evaluate((n) => {
    n.scrollTop = n.scrollHeight;
  });
  await expect(livePreview).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: 'test-results/reasoning-tail-mobile.png', animations: 'disabled' });
  await mode('Masqué');
  await expect(livePreview).toBeHidden();
  await mode('Aperçu');
  await tailVisible(livePreview);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'three modes and persistence',
        'last two rendered lines follow streaming and resize',
        'Markdown sanitization',
        'actual inspector thinking',
        'model search and compatible thinking',
        'global/project defaults and stale-save protection',
        'mobile layout',
      ],
    }),
  );
} finally {
  await browser.close();
  await app.close();
  assert.equal(dirname(temp), resolve(tmpdir()));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
