// True app integration smoke for Computer Use. Real createApp plus fake runtime and fake driver.
// Temp dirs and ephemeral port only. No real desktop driver, no installed daemon.
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-computer-use-app-'));
const sessionDir = join(temp, 'sessions'),
  cwd = join(temp, 'Atelier'),
  dataDir = join(temp, 'data'),
  agentHome = join(temp, 'agent');
await Promise.all([
  mkdir(sessionDir, { recursive: true }),
  mkdir(cwd, { recursive: true }),
  mkdir(agentHome, { recursive: true }),
]);

const stamp = new Date().toISOString();
await writeFile(
  join(sessionDir, 'session-a.jsonl'),
  [
    { type: 'session', id: 'session-a', version: 3, cwd, timestamp: stamp },
    { type: 'message', id: 'a-u1', parentId: null, message: { role: 'user', content: 'Session A' } },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);
await writeFile(
  join(sessionDir, 'session-b.jsonl'),
  [
    { type: 'session', id: 'session-b', version: 3, cwd, timestamp: stamp },
    { type: 'message', id: 'b-u1', parentId: null, message: { role: 'user', content: 'Session B' } },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);

const driverCalls = [];
const fakeDriver = () => ({
  request: async (command) => {
    driverCalls.push(command);
    return { ok: true };
  },
  stop: async () => {},
  close: async () => {},
});

const runBodies = [];
let serial = 0;
const handles = new Set();
const runtime = {
  getStatus: async () => ({ version: 'fixture', available: true, cli: 'fixture' }),
  async getModels() {
    return {
      models: [
        { id: 'test/vision', name: 'Vision Fixture', provider: 'test', input: ['text', 'image'] },
        { id: 'test/vision-2', name: 'Vision Two', provider: 'test', input: ['text', 'image'] },
        { id: 'test/text-only', name: 'Text Only', provider: 'test', input: ['text'] },
      ],
      default: { model: 'test/vision', thinking: 'low' },
    };
  },
  async start(input) {
    const index = ++serial;
    const id = input.sessionId || `session-app-${index}`;
    const file = join(sessionDir, `${id}.jsonl`);
    try {
      await readFile(file, 'utf8');
    } catch {
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
    }
    await appendFile(
      file,
      JSON.stringify({
        type: 'message',
        id: `user-${index}`,
        parentId: null,
        message: { role: 'user', content: input.message, timestamp: Date.now() },
      }) + '\n',
    );
    let complete;
    let finished = false;
    const done = new Promise((r) => (complete = r));
    const timers = [];
    const send = (e) => {
      if (!finished) input.onEvent(e);
    };
    const finish = async (status) => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      const result = { kind: 'done', sessionId: id, status, code: status === 'completed' ? 0 : null };
      input.onEvent(result);
      complete(result);
      handles.delete(handle);
    };
    const handle = { sessionId: id, done, cancel: () => finish('stopped') };
    handles.add(handle);
    timers.push(setTimeout(() => send({ kind: 'session', sessionId: id, cwd: input.cwd }), 40));
    timers.push(setTimeout(() => send({ kind: 'message_start', role: 'assistant' }), 120));
    timers.push(setTimeout(() => send({ kind: 'text', delta: 'Working with the desktop. ' }), 300));
    timers.push(setTimeout(() => void finish('completed'), 4000));
    return handle;
  },
  async close() {
    await Promise.all([...handles].map((h) => h.cancel()));
  },
};

const app = createApp({
  runtime,
  agentHome,
  sessionDir,
  dataDir,
  initialCwd: cwd,
  computerDriver: fakeDriver,
});
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${app.server.address().port}`;
const shotDir = resolve('test-results', 'computer-use');
await mkdir(shotDir, { recursive: true });
let browser;
const report = [];
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1512, height: 982 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const computerStopCalls = [];
  await page.route('**/api/runs', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      try {
        runBodies.push(JSON.parse(req.postData() || '{}'));
      } catch {}
    }
    await route.continue();
  });
  await page.route('**/api/computer-use/stop', async (route) => {
    computerStopCalls.push({ method: route.request().method() });
    await route.continue();
  });
  await page.goto(url);
  await expect(page.locator('#connection-label')).not.toHaveText('Connexion…');
  await expect(page.locator('#project-list')).toContainText('Atelier');
  await expect(page.locator('#computer-use')).toBeVisible();
  await expect(page.locator('#computer-use-toggle')).toBeEnabled();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#computer-use-status')).toHaveCount(0);
  report.push('Real header control visible, default off');

  // Draft activation on a new session sends computerUse true on the real route.
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#allow-computer-use')).not.toBeChecked();
  await expect(page.locator('label:has(#allow-computer-use)')).toContainText('Autoriser le Computer Use');
  await page.locator('#allow-computer-use').click();
  await expect(page.locator('#allow-computer-use')).toBeChecked();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('title', 'Désactiver le bureau expert');
  await page.locator('#composer').fill('Please use the desktop.');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  const draftBody = runBodies[runBodies.length - 1];
  if (draftBody?.computerUse !== true) throw new Error('draft send must carry computerUse true');
  if (draftBody?.computerUseBackend !== undefined)
    throw new Error('draft send must not carry a per-run backend, the server applies the global engine');
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#computer-use-stop')).toBeVisible();
  await expect(page.locator('#computer-use-backend-native')).toHaveCount(0);
  report.push('Draft activation carries computerUse true with no per-run backend on POST /api/runs');
  await page.screenshot({
    path: join(shotDir, 'computer-use-app-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });

  // Computer stop is separate from agent cancellation.
  await page.locator('#computer-use-stop').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#computer-use-stop')).toBeHidden();
  if (!computerStopCalls.length) throw new Error('computer stop must call dedicated stop route');
  await expect(page.locator('#stop-button')).toBeVisible();
  report.push('Computer stop separate from agent stop');
  await page.locator('#stop-button').click();
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 10000 });

  // Existing session toggle uses the mode route, then switching never leaks.
  await page.locator('#session-list').getByText('Session A', { exact: true }).click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#computer-use-backend-native')).toHaveCount(0);
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#computer-backend-native')).toBeVisible();
  await expect(page.locator('#computer-backend-cua')).toBeVisible();
  await expect(page.locator('#computer-backend-native')).toBeChecked();
  await expect(page.locator('#computer-backend-hint')).not.toBeEmpty();
  {
    const cuaAvailable = await page.evaluate(() =>
      fetch('/api/computer-use')
        .then((r) => r.json())
        .then((s) => s?.backends?.find((b) => b?.id === 'cua')?.available === true)
        .catch(() => false),
    );
    if (cuaAvailable) {
      await expect(page.locator('#computer-backend-cua')).toBeEnabled();
      await expect(page.locator('#computer-backend-hint')).toContainText('Windows x64');
    } else {
      await expect(page.locator('#computer-backend-cua')).toBeDisabled();
    }
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden();
  const enableCalls = [];
  await page.route('**/api/computer-use', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      try {
        enableCalls.push(JSON.parse(req.postData() || '{}'));
      } catch {}
    }
    await route.continue();
  });
  await page.locator('#computer-use-toggle').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#computer-use-owner')).toHaveText('Cette session');
  if (!enableCalls.length) throw new Error('session enable must POST to the mode route');
  if (enableCalls[enableCalls.length - 1]?.backend !== undefined)
    throw new Error('session enable must not POST a per-session backend, the server applies the global engine');
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#computer-backend-native')).toBeDisabled();
  await expect(page.locator('#computer-backend-cua')).toBeDisabled();
  await expect(page.locator('#computer-backend-hint')).toContainText('Désactivez');
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await expect(page.locator('#computer-use-stop')).toBeEnabled();
  report.push('Session enable posts no backend and locks the global engine while on');
  await page.locator('#session-list').getByText('Session B', { exact: true }).click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#allow-computer-use')).not.toBeChecked();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('title', 'Activer le bureau expert');
  await page.locator('#composer').fill('Plain message without desktop.');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  const plainBody = runBodies[runBodies.length - 1];
  if (plainBody?.computerUse === true) throw new Error('session switch must not leak computerUse');
  if (plainBody?.computerUseBackend) throw new Error('session switch must not leak backend');
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#computer-use-backend-native')).toHaveCount(0);
  report.push('Session switch never leaks computerUse into next run');
  await page.locator('#stop-button').click();
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 10000 });

  // Pref survives run end with no owner: returning restores the backend while locked.
  await page.locator('#session-list').getByText('Session A', { exact: true }).click();
  await expect(page.locator('#computer-use-toggle')).toBeEnabled();
  if ((await page.locator('#computer-use-toggle').getAttribute('aria-pressed')) !== 'true')
    await page.locator('#computer-use-toggle').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#computer-use-owner')).toHaveText('Cette session');
  await expect(page.locator('#computer-use-backend-native')).toHaveCount(0);
  await page.locator('#composer').fill('Run with desktop pref.');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  const prefBody = runBodies[runBodies.length - 1];
  if (prefBody?.computerUse !== true) throw new Error('pref run must carry computerUse true');
  if (prefBody?.computerUseBackend !== undefined)
    throw new Error('pref run must not carry a per-run backend, the server applies the global engine');
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#computer-use-backend-native')).toHaveCount(0);
  await page.locator('#session-list').getByText('Plain message without desktop.', { exact: true }).click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#session-list').getByText('Run with desktop pref.', { exact: true }).click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#composer').fill('Next send after return.');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  const afterReturnBody = runBodies[runBodies.length - 1];
  if (afterReturnBody?.computerUse !== true) throw new Error('returning must keep computerUse armed');
  if (afterReturnBody?.computerUseBackend !== undefined)
    throw new Error('returning must not send a per-run backend, the server applies the global engine');
  await page.locator('#stop-button').click();
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 10000 });
  report.push('Session pref with no owner restores backend on return');

  // New session after a switch carries no stale opt-in.
  await page.keyboard.press('Control+n');
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  report.push('No stale opt-in across sessions');

  const roSalt = 'd'.repeat(32);
  const roCode = '12345678';
  const gateway = createLanGateway({
    host: '127.0.0.1',
    upstreamPort: app.server.address().port,
    config: { salt: roSalt, codeHash: hashAccessCode(roCode, roSalt), readOnly: true },
  });
  await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
  const roContext = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 800 } });
  const roPage = await roContext.newPage();
  roPage.setDefaultTimeout(15000);
  await roPage.goto(`http://127.0.0.1:${gateway.address().port}`);
  await roPage.locator('#code').fill(roCode);
  await roPage.getByRole('button', { name: 'Ouvrir le studio' }).click();
  await roPage.locator('#session-list').getByText('Next send after return.', { exact: true }).click();
  await expect(roPage.locator('#computer-use')).toBeVisible();
  await expect(roPage.locator('#allow-computer-use')).toBeDisabled();
  await expect(roPage.locator('#computer-use-toggle')).toBeDisabled();
  await expect(roPage.locator('#computer-use-warning')).toContainText('Consultation seule');
  await expect(roPage.locator('#computer-use-backend-native')).toHaveCount(0);
  await roContext.close();
  await new Promise((done) => gateway.close(done));
  report.push('Read only consultation never mutates');

  // Global engine and model live in Preferences > Tools, one setting for every run.
  await page.locator('#session-list').getByText('Next send after return.', { exact: true }).click();
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#computer-backend-native')).toBeVisible();
  await expect(page.locator('#computer-backend-cua')).toBeVisible();
  await expect(page.locator('#computer-model-button')).toBeVisible();
  await expect(page.locator('#computer-model-name')).toContainText('Identique');
  {
    const cuaAvailable = await page.evaluate(() =>
      fetch('/api/computer-use')
        .then((r) => r.json())
        .then((s) => s?.backends?.find((b) => b?.id === 'cua')?.available === true)
        .catch(() => false),
    );
    const patched = await page.evaluate(async (wantCua) => {
      const setBackend = await fetch('/api/studio-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computerBackend: wantCua ? 'cua' : 'native' }),
      }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
      const badModel = await fetch('/api/studio-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computerModel: 'nope/missing' }),
      }).then((r) => r.status);
      const textModel = await fetch('/api/studio-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computerModel: 'test/text-only' }),
      }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
      return { setBackend, badModel, textModel };
    }, cuaAvailable);
    if (cuaAvailable) {
      if (patched.setBackend.status !== 200 || patched.setBackend.json?.computerBackend !== 'cua')
        throw new Error('available CUA backend must PATCH globally');
    } else if (patched.setBackend.status !== 409) {
      throw new Error('unavailable CUA backend must fail closed with 409');
    }
    if (patched.badModel !== 400) throw new Error('unknown Computer Use model must fail with 400');
    if (patched.textModel.status !== 400 || !/image/i.test(patched.textModel.json?.error || ''))
      throw new Error('text-only Computer Use model must fail with a clear image error, never a silent switch');
    await page.reload();
    await expect(page.locator('#connection-label')).not.toHaveText('Connexion…');
    await page.locator('#session-list').getByText('Next send after return.', { exact: true }).click();
    await page.locator('#open-settings').click();
    await page.locator('#settings-tab-tools').click();
    const stored = await page.evaluate(() =>
      fetch('/api/studio-preferences')
        .then((r) => r.json())
        .catch(() => null),
    );
    if (cuaAvailable && stored?.computerBackend !== 'cua')
      throw new Error('global backend PATCH must persist server-side');
    if (!cuaAvailable && stored?.computerBackend !== 'native')
      throw new Error('refused backend PATCH must not change the stored engine');
    if (stored?.computerModel !== '') throw new Error('refused model PATCHes must not change the stored model');
    const badThinking = await page.evaluate(() =>
      fetch('/api/studio-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computerThinking: 'ultra' }),
      }).then((r) => r.status),
    );
    if (badThinking !== 400) throw new Error('unknown thinking levels must fail with 400');
    const setThinking = await page.evaluate(() =>
      fetch('/api/studio-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computerThinking: 'high' }),
      }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) })),
    );
    if (setThinking.status !== 200 || setThinking.json?.computerThinking !== 'high')
      throw new Error('decision thinking must PATCH globally');
    const storedThinking = await page.evaluate(() =>
      fetch('/api/studio-preferences')
        .then((r) => r.json())
        .catch(() => null),
    );
    if (storedThinking?.computerThinking !== 'high')
      throw new Error('thinking PATCH must persist server-side');
    await page.reload();
    await expect(page.locator('#connection-label')).not.toHaveText('Connexion…');
    await page.locator('#session-list').getByText('Next send after return.', { exact: true }).click();
    await page.locator('#open-settings').click();
    await page.locator('#settings-tab-tools').click();
    await expect(page.locator('#computer-thinking')).toHaveValue('high');
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-dialog')).toBeHidden();
  }
  report.push('Global engine and model PATCH validation fails closed with clear errors');
  {
    const setModel = await page.evaluate(() =>
      fetch('/api/studio-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computerModel: 'test/vision-2' }),
      }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) })),
    );
    if (setModel.status !== 200 || setModel.json?.computerModel !== 'test/vision-2')
      throw new Error('image-capable Computer Use model must PATCH globally');
  }
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-tools').click();
  await expect(page.locator('#computer-model-name')).toContainText('Vision Two');
  const computerModelButton = page.locator('#computer-model-button');
  await expect(computerModelButton).not.toHaveClass(/secondary-button/);
  await expect(computerModelButton.locator('.subagent-model-icon svg')).toBeVisible();
  await expect(computerModelButton.locator('.model-picker-chevron svg')).toBeVisible();
  const pickerStyle = await computerModelButton.evaluate((button) => {
    const css = getComputedStyle(button);
    return { border: css.borderTopWidth, radius: css.borderRadius, height: css.minHeight };
  });
  expect(pickerStyle).toEqual({ border: '1px', radius: '8px', height: '43px' });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await computerModelButton.scrollIntoViewIfNeeded();
    await expect(computerModelButton.locator('.model-picker-chevron svg')).toBeVisible();
    expect(await computerModelButton.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    })).toBe(true);
    await page.screenshot({ path: join(shotDir, `computer-model-picker-${width}.png`), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await computerModelButton.click();
  await expect(page.locator('#model-dialog')).toBeVisible();
  await expect(computerModelButton).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#model-dialog')).toBeHidden();
  await expect(computerModelButton).toHaveAttribute('aria-expanded', 'false');
  await expect(computerModelButton).toBeFocused();
  report.push('Computer Use model reuses the shared selector styling, icons and dialog on desktop and mobile');
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden();
  if ((await page.locator('#computer-use-toggle').getAttribute('aria-pressed')) !== 'true')
    await page.locator('#computer-use-toggle').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#composer').fill('Run with the global Computer Use model.');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  {
    const overrideBody = runBodies[runBodies.length - 1];
    if (overrideBody?.computerUse !== true) throw new Error('override run must carry computerUse true');
    if (overrideBody?.model !== 'test/vision-2')
      throw new Error('authorized runs must use the global Computer Use model');
  }
  await page.locator('#stop-button').click();
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 10000 });
  await page.locator('#computer-use-stop').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#composer').fill('Plain run without desktop keeps its own model.');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  {
    const plainModelBody = runBodies[runBodies.length - 1];
    if (plainModelBody?.computerUse === true)
      throw new Error('unauthorized runs must never take the global Computer Use model');
    if (plainModelBody?.model !== 'test/vision')
      throw new Error('unauthorized runs must keep the conversation model');
  }
  await page.locator('#stop-button').click();
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 10000 });
  {
    const cleared = await page.evaluate(() =>
      fetch('/api/studio-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computerModel: '', computerThinking: '', computerBackend: 'native' }),
      }).then((r) => r.status),
    );
    if (cleared !== 200) throw new Error('clearing the global Computer Use settings must succeed');
  }
  report.push('Authorized runs use the global model, plain runs keep their own');
  if (driverCalls.length) throw new Error('smoke must not drive the real desktop');
  await page
    .locator('#session-list')
    .getByText('Plain run without desktop keeps its own model.', { exact: true })
    .click();
  await expect(page.locator('#computer-use-toggle')).toBeEnabled();
  if ((await page.locator('#computer-use-toggle').getAttribute('aria-pressed')) !== 'true')
    await page.locator('#computer-use-toggle').click();
  await expect(page.locator('#allow-computer-use')).toBeChecked();
  await expect(page.locator('#computer-use-stop')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#mobile-backdrop')).toBeHidden();
  await expect(page.locator('#toasts .toast')).toHaveCount(0);
  await expect(page.locator('#computer-use-toggle')).toBeVisible();
  await expect(page.locator('#computer-use-stop')).toBeVisible();
  await expect(page.locator('#allow-computer-use')).toBeVisible();
  await expect(page.locator('#computer-use-backend')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const gutterCheck = () =>
    page.evaluate(() => {
      const form = document.getElementById('composer-form');
      const formRect = form.getBoundingClientRect();
      const style = getComputedStyle(form);
      const contentL = formRect.left + (parseFloat(style.paddingLeft) || 0);
      const contentR = formRect.right - (parseFloat(style.paddingRight) || 0);
      return [...document.querySelectorAll('.model-controls .questions-toggle')].map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left - contentL, right: contentR - r.right };
      });
    });
  for (const g of await gutterCheck()) {
    if (g.left < -1 || g.right < -1) throw new Error(`checkbox crosses composer gutter ${JSON.stringify(g)}`);
  }
  await page.screenshot({
    path: join(shotDir, 'computer-use-app-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.locator('#computer-use-toggle')).toBeVisible();
  await expect(page.locator('#computer-use-stop')).toBeVisible();
  await expect(page.locator('#computer-use-backend')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  for (const g of await gutterCheck()) {
    if (g.left < -1 || g.right < -1) throw new Error(`320px checkbox crosses gutter ${JSON.stringify(g)}`);
  }
  await page.screenshot({
    path: join(shotDir, 'computer-use-app-mobile-320.png'),
    fullPage: true,
    animations: 'disabled',
  });
  report.push('Desktop and mobile screenshots captured');
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks: report }, null, 2));
} catch (error) {
  console.error(error);
  if (browser) {
    const trouble = browser.contexts()[0]?.pages()[0];
    if (trouble) {
      await mkdir(resolve('test-results'), { recursive: true });
      await trouble
        .screenshot({
          path: resolve('test-results', 'computer-use', 'computer-use-app-failure.png'),
          fullPage: true,
          animations: 'disabled',
        })
        .catch(() => {});
    }
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
  const cleanupPath = resolve(temp);
  const tempRoot = resolve(tmpdir());
  if (!cleanupPath.startsWith(tempRoot + sep) || !basename(cleanupPath).startsWith('prime-computer-use-app-'))
    throw new Error('Unrecognized test directory, cleanup refused.');
  await rm(cleanupPath, { recursive: true, force: true });
}
