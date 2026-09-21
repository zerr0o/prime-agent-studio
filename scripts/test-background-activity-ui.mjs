// Isolated background activity check: turn end stays nonterminal, tool and
// text resume activity, then done finishes. No real user session or process.
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createApp } from '../server.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-studio-background-'));
const cwd = join(root, 'Atelier');
const sessionDir = join(root, 'sessions');
const agentHome = join(root, 'agent');
await Promise.all([cwd, sessionDir, agentHome].map((path) => mkdir(path, { recursive: true })));
await writeFile(
  join(sessionDir, 'background-session.jsonl'),
  [
    { type: 'session', id: 'background-session', cwd, timestamp: new Date().toISOString() },
    {
      type: 'message',
      id: 'u1',
      parentId: null,
      message: { role: 'user', content: 'Verifier le travail de fond' },
    },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);

const controls = new Map();
let liveState = { isStreaming: true, isSessionActive: true };
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/luna', name: 'Luna', provider: 'fixture' }],
    default: { model: 'fixture/luna' },
  }),
  async start(input) {
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const control = {
      done,
      emit: (event) => input.onEvent(event),
      async finish(status = 'completed', text = 'Reponse finale.') {
        if (status === 'completed') {
          await appendFile(
            join(sessionDir, `${input.sessionId}.jsonl`),
            JSON.stringify({
              type: 'message',
              id: `a-final-${Date.now()}`,
              parentId: 'u1',
              message: { role: 'assistant', content: text, stopReason: 'stop' },
            }) + '\n',
          );
          input.onEvent({
            kind: 'message',
            message: { role: 'assistant', text, tools: [], stopReason: 'stop' },
          });
        }
        const event = { kind: 'done', sessionId: input.sessionId, status, code: 0 };
        input.onEvent(event);
        resolveDone(event);
      },
      cancel() {
        const event = { kind: 'done', sessionId: input.sessionId, status: 'stopped', code: 130 };
        input.onEvent(event);
        resolveDone(event);
      },
    };
    controls.set(input.sessionId, control);
    input.onEvent({ kind: 'session', sessionId: input.sessionId, cwd: input.cwd });
    input.onEvent({ kind: 'message_start', role: 'assistant' });
    input.onEvent({ kind: 'text', delta: 'Travail en cours. ' });
    return control;
  },
  async close() {},
};

const app = createApp({
  runtime,
  sessionDir,
  agentHome,
  dataDir: join(root, 'data'),
  initialCwd: cwd,
  readInspectorEdges: async () => [],
  inspectorClient: {
    async getInspector() {
      return { state: { ...liveState }, children: [] };
    },
    close() {},
  },
});
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const errors = [];
const checks = [];
let browser;
let page;

async function refresh() {
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

async function startRun() {
  const response = await fetch(url + '/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ cwd, sessionId: 'background-session', message: 'Continuer le travail' }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  await refresh();
  await openSession();
  return controls.get('background-session');
}

async function openSession() {
  await page.locator('#session-list .session-select').filter({ hasText: 'Verifier' }).click();
  await expect(page.locator('#messages')).toBeVisible();
  await expect(page.locator('#conversation-loading')).toBeHidden();
}

async function openInspector() {
  if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
  await expect(page.locator('#detail-status')).toBeVisible();
}

async function refreshAgents() {
  // Inspector polls live status on its own interval. Force the agents tab
  // visible so the manual refresh control can be used, then return to session.
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.locator('#refresh-agents').click();
  await page.getByRole('tab', { name: 'Session', exact: true }).click();
}

async function setLive(state) {
  liveState = state;
  // Server inspector caches snapshots briefly. Wait past the cache window
  // before forcing a refresh so the new snapshot is observed.
  await page.waitForTimeout(2300);
  await refreshAgents();
}

async function setLanguage(value) {
  if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
  await page.locator('#settings-tab-appearance').click();
  await page.locator('#language-select').selectOption(value);
  await page.locator('#settings-dialog [data-close-dialog]').first().click();
}

try {
  browser = await chromium.launch({
    channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome',
    headless: true,
  });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connect');
  await openSession();

  const control = await startRun();
  await expect(page.locator('#run-status')).toBeVisible();
  await expect(page.locator('#stop-button')).toBeVisible();
  await expect(page.locator('#send-button')).toBeHidden();
  await expect(page.locator('#run-status-label')).toContainText('travaille');
  checks.push('Run demarre en travail, arret disponible');

  liveState = { isSessionActive: true };
  control.emit({ kind: 'status', status: 'turn_end' });
  await expect(page.locator('#run-status-label')).toContainText('Fin de tour');
  await expect(page.locator('#run-status-label')).not.toContainText('Termin');
  await expect(page.locator('#stop-button')).toBeVisible();
  await expect(page.locator('#send-button')).toBeHidden();
  await openInspector();
  await setLive({ isSessionActive: true });
  await expect(page.locator('#detail-status')).toContainText('En arrière-plan', { timeout: 15000 });
  checks.push('Fin de tour nonterminale, arret conserve, inspector en arriere-plan');

  await setLive({});
  await expect(page.locator('#detail-status')).toContainText('En attente', { timeout: 15000 });
  await expect(page.locator('#run-status-label')).toContainText('Fin de tour');
  await expect(page.locator('#stop-button')).toBeVisible();
  checks.push('Moteur idle avec run maintenu affiche attente, pas termine');

  await context.setOffline(true);
  // An established SSE stream can survive a short offline window until the
  // next heartbeat fails. Accept either the reconnect notice or the kept
  // turn ended label here. The strict assertion is the restored state below.
  try {
    await expect(page.locator('#run-status-label')).toContainText('Reconnexion', { timeout: 20000 });
  } catch {
    await expect(page.locator('#run-status-label')).toContainText('Fin de tour');
  }
  await context.setOffline(false);
  await expect(page.locator('#run-status-label')).toContainText('Fin de tour', { timeout: 20000 });
  await expect(page.locator('#run-status-label')).not.toContainText('Termin');
  await expect(page.locator('#stop-button')).toBeVisible();
  const restored = await page.evaluate(async () => {
    const module = await import('/public/runtime-status.js');
    const run = { activityStatus: 'turn_end' };
    module.applyRuntimeStatus(run, { status: run.activityStatus || 'running' }, (key) => key);
    const resumed = { activityStatus: 'background' };
    module.noteActivity(resumed, (key) => key);
    return { label: run.statusLabel, resumedLabel: resumed.statusLabel };
  });
  expect(restored.label).toBe('ui.fin_de_tour');
  expect(restored.resumedLabel).toBe(undefined);
  checks.push('Deconnexion SSE puis reconnexion restaure fin de tour, pas de stale');

  await page.reload();
  await openSession();
  await expect(page.locator('#run-status')).toBeVisible();
  await expect(page.locator('#run-status-label')).toContainText('Fin de tour');
  await expect(page.locator('#stop-button')).toBeVisible();
  checks.push('Reconnexion apres rechargement conserve fin de tour nonterminale');

  await setLive({ isBashRunning: true, isSessionActive: true });
  control.emit({ kind: 'tool_start', id: 'tool-1', name: 'bash', args: {} });
  control.emit({ kind: 'text', delta: 'Reprise du travail. ' });
  await expect(page.locator('#run-status-label')).toContainText('travaille');
  await openInspector();
  await expect(page.locator('#detail-status')).toContainText('Exécute un outil', { timeout: 15000 });
  checks.push('Reprise outil et texte reactive le travail');

  await setLanguage('en');
  control.emit({ kind: 'status', status: 'turn_end' });
  await expect(page.locator('#run-status-label')).toContainText('Turn ended');
  await openInspector();
  await setLive({ isSessionActive: true });
  await expect(page.locator('#detail-status')).toContainText('In background', { timeout: 15000 });
  await setLive({});
  await expect(page.locator('#detail-status')).toContainText('Waiting', { timeout: 15000 });
  await setLive({ isStreaming: true, isSessionActive: true });
  control.emit({ kind: 'text', delta: 'Working again. ' });
  await expect(page.locator('#run-status-label')).toContainText('working');
  checks.push('Labels anglais turn ended et background verifies, reprise active');
  await setLanguage('fr');

  const mobile = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const small = await mobile.newPage();
  small.on('pageerror', (error) => errors.push(error.message));
  await small.goto(url);
  await small.locator('#toggle-sidebar').click();
  await small.locator('#session-list .session-select').filter({ hasText: 'Verifier' }).click();
  await expect(small.locator('#run-status-label')).toContainText('travaille');
  liveState = { isSessionActive: true };
  control.emit({ kind: 'status', status: 'turn_end' });
  await expect(small.locator('#run-status-label')).toContainText('Fin de tour');
  await expect(small.locator('#stop-button')).toBeVisible();
  liveState = { isStreaming: true, isSessionActive: true };
  control.emit({ kind: 'text', delta: 'Reprise mobile. ' });
  await expect(small.locator('#run-status-label')).toContainText('travaille');
  await small.close();
  await mobile.close();
  checks.push('Mobile conserve fin de tour nonterminale et reprise');

  await control.finish('completed', 'Reponse finale.');
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#messages')).toContainText('Reponse finale.', { timeout: 15000 });
  checks.push('Done final termine normalement apres liberation');

  await mkdir(resolve('test-results'), { recursive: true });
  await page.screenshot({ path: resolve('test-results/background-activity.png'), animations: 'disabled' });
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  console.error(error);
  await mkdir(resolve('test-results'), { recursive: true });
  await page
    ?.screenshot({ path: resolve('test-results/background-activity-failure.png'), animations: 'disabled' })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('prime-studio-background-'))
    throw new Error('Repertoire de nettoyage inattendu.');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
