// Isolated browser check for Computer Use toolbar. Fake API only, no live Studio server.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = join(root, 'test-results', 'computer-use');
await mkdir(shotDir, { recursive: true });

const fixture = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="/public/computer-use.css" />
</head>
<body>
<div id="computer-use" class="computer-use" hidden>
<button id="computer-use-toggle" class="computer-use-toggle" type="button" aria-pressed="false">
<span id="computer-use-dot" class="computer-use-dot" aria-hidden="true"></span><span id="computer-use-label">Bureau expert</span>
</button>
<span id="computer-use-status" class="computer-use-status" role="status"></span>
<button id="computer-use-stop" class="computer-use-stop" type="button" hidden>Arreter le bureau</button>
</div>
<label class="questions-toggle"><input id="allow-computer-use" type="checkbox" /><span>Computer</span></label>
<section id="computer-use-details" class="computer-use-details" hidden>
<p id="computer-use-warning" class="computer-use-note"></p>
<section id="tools-panel">
<span id="computer-backend-label" data-i18n="computer.backendLabel">Moteur de bureau</span>
<label><input type="radio" name="computer-backend-global" id="computer-backend-native" value="native" checked /><span id="computer-backend-native-label" data-i18n="computer.backendNative">Original</span></label>
<label><input type="radio" name="computer-backend-global" id="computer-backend-cua" value="cua" /><span id="computer-backend-cua-label" data-i18n="computer.backendCua">Cua</span></label>
<p id="computer-backend-hint"></p>
<button id="computer-model-button" type="button"><span id="computer-model-name"></span><span id="computer-model-provider"></span></button>
<p id="computer-prefs-error" hidden></p>
</section>
<dl><div><dt>Controller</dt><dd id="computer-use-owner">-</dd></div>
<div><dt>Action</dt><dd id="computer-use-action">-</dd></div>
<div><dt>Hotkey</dt><dd id="computer-use-hotkey">-</dd></div></dl>
</section>
<script type="module">
import { createComputerUse, normalizeComputerStatus, summarizeComputerAction, ownerDisplayName } from '/public/computer-use.js';
import { createComputerPreferences } from '/public/computer-preferences.js';
import { setLanguage, translateDOM } from '/public/i18n.js';
window.__ctx = {
  sessionId: null,
  runId: null,
  cwd: 'C:\\\\Test\\\\Project',
  projectCwd: 'C:\\\\Test\\\\Project',
  projectOverview: false,
  readOnly: false,
  online: true,
};
window.__mock = {
  calls: [],
  toasts: [],
  delayMs: 0,
  failGet: false,
  supported: true,
  busy: false,
  hotkey: 'Ctrl+Alt+Shift+F10',
  hotkeyError: null,
  lastAction: null,
  controller: null,
  enabledSessions: {},
  backend: 'native',
  backends: null,
  omitBackendFields: false,
  cleanupPending: false,
  cleanupFailed: false,
  prefs: { computerBackend: 'native', computerModel: '' },
  models: [
    { id: 'test/vision', name: 'Vision', provider: 'test', input: ['text', 'image'] },
    { id: 'test/vision-2', name: 'Vision Two', provider: 'test', input: ['text', 'image'] },
    { id: 'test/text-only', name: 'Text Only', provider: 'test', input: ['text'] },
  ],
  failPrefs: false,
};
window.__setController = (owner) => {
  window.__mock.controller = owner ? JSON.parse(JSON.stringify(owner)) : null;
};
window.__setSessionEnabled = (sessionId, enabled) => {
  if (!sessionId) return;
  if (enabled) window.__mock.enabledSessions[sessionId] = true;
  else delete window.__mock.enabledSessions[sessionId];
};
window.__resetMock = () => {
  window.__mock.calls = [];
  window.__mock.toasts = [];
  window.__mock.delayMs = 0;
  window.__mock.failGet = false;
  window.__mock.supported = true;
  window.__mock.busy = false;
  window.__mock.hotkeyError = null;
  window.__mock.lastAction = null;
  window.__mock.controller = null;
  window.__mock.enabledSessions = {};
  window.__mock.backend = 'native';
  window.__mock.backends = null;
  window.__mock.omitBackendFields = false;
  window.__mock.cleanupPending = false;
  window.__mock.cleanupFailed = false;
  window.__mock.prefs = { computerBackend: 'native', computerModel: '' };
  window.__mock.models = [
    { id: 'test/vision', name: 'Vision', provider: 'test', input: ['text', 'image'] },
    { id: 'test/vision-2', name: 'Vision Two', provider: 'test', input: ['text', 'image'] },
    { id: 'test/text-only', name: 'Text Only', provider: 'test', input: ['text'] },
  ];
  window.__mock.failPrefs = false;
  window.__pickerSelections = [];
};
window.__setBackends = (backends) => {
  window.__mock.backends = backends ? JSON.parse(JSON.stringify(backends)) : null;
};
window.__setBackendFields = (backend, backends, omit) => {
  if (backend) window.__mock.backend = backend;
  window.__mock.backends = backends ? JSON.parse(JSON.stringify(backends)) : null;
  window.__mock.omitBackendFields = omit === true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessionOf = (path) => {
  try {
    return new URL(path, 'http://fake').searchParams.get('sessionId');
  } catch {
    return null;
  }
};
const defaultBackends = () => [
  { id: 'native', supported: window.__mock.supported !== false, available: window.__mock.supported !== false },
  { id: 'cua', supported: true, available: true, reason: null },
];
const snapshotFor = (sessionId) => {
  const base = {
    supported: window.__mock.supported,
    enabled: sessionId ? window.__mock.enabledSessions[sessionId] === true : false,
    owner: window.__mock.controller ? JSON.parse(JSON.stringify(window.__mock.controller)) : null,
    busy: window.__mock.busy,
    hotkey: window.__mock.hotkey,
    hotkeyError: window.__mock.hotkeyError,
    lastAction: window.__mock.lastAction,
    lastFrame: null,
    error: null,
    cleanupPending: window.__mock.cleanupPending === true,
    cleanupFailed: window.__mock.cleanupFailed === true,
  };
  if (window.__mock.omitBackendFields) return base;
  return {
    ...base,
    backend: window.__mock.backend || 'native',
    backends: window.__mock.backends
      ? JSON.parse(JSON.stringify(window.__mock.backends))
      : defaultBackends(),
  };
};
const api = async (path, { method = 'GET', body } = {}) => {
  window.__mock.calls.push({ path, method, body: body ? JSON.parse(JSON.stringify(body)) : undefined });
  if (window.__mock.delayMs) await sleep(window.__mock.delayMs);
  const isGet = method === 'GET' && path.startsWith('/api/computer-use');
  if (isGet && window.__mock.failGet) {
    const error = new Error('fake fetch failed');
    error.status = 500;
    throw error;
  }
  if (isGet) return snapshotFor(sessionOf(path));
  if (path === '/api/studio-preferences' && method === 'GET') {
    if (window.__mock.failPrefs) {
      const error = new Error('fake prefs failed');
      error.status = 500;
      throw error;
    }
    return JSON.parse(JSON.stringify(window.__mock.prefs));
  }
  if (path === '/api/studio-preferences' && method === 'PATCH') {
    const patch = body && typeof body === 'object' ? body : {};
    if ('computerBackend' in patch) {
      const wanted = patch.computerBackend;
      if (wanted !== 'native' && wanted !== 'cua') {
        const error = new Error('Invalid Computer Use backend.');
        error.status = 400;
        throw error;
      }
      if (window.__mock.controller) {
        const error = new Error('Turn off desktop to change the engine.');
        error.status = 409;
        throw error;
      }
      const entries = window.__mock.backends ? window.__mock.backends : defaultBackends();
      const entry = entries.find((candidate) => candidate?.id === wanted);
      if (!entry?.available) {
        const error = new Error(entry?.reason || 'The requested Computer Use backend is unavailable.');
        error.status = 409;
        throw error;
      }
      window.__mock.prefs.computerBackend = wanted;
    }
    if ('computerModel' in patch) {
      const wanted = patch.computerModel;
      if (typeof wanted !== 'string' || wanted.length > 500) {
        const error = new Error('Invalid Computer Use model.');
        error.status = 400;
        throw error;
      }
      if (wanted) {
        const found = window.__mock.models.find((model) => model?.id === wanted);
        if (!found) {
          const error = new Error('Unknown Computer Use model.');
          error.status = 400;
          throw error;
        }
        if (Array.isArray(found.input) && !found.input.includes('image')) {
          const error = new Error('This model does not support images. Choose an image capable model.');
          error.status = 400;
          throw error;
        }
        window.__mock.prefs.computerModel = wanted;
      } else {
        window.__mock.prefs.computerModel = '';
      }
    }
    return JSON.parse(JSON.stringify(window.__mock.prefs));
  }
  if (path === '/api/computer-use' && method === 'POST') {
    const enabled = body?.enabled === true;
    const sid = body?.sessionId || null;
    if (window.__mock.supported === false) {
      const error = new Error('unsupported');
      error.status = 400;
      throw error;
    }
    if (sid) {
      if (enabled) {
        if (body?.backend === 'cua' || body?.backend === 'native') window.__mock.backend = body.backend;
        window.__mock.enabledSessions[sid] = true;
        window.__mock.controller = { sessionId: sid, runId: body?.runId || null, cwd: body?.cwd || null, name: 'Test Session' };
      } else {
        delete window.__mock.enabledSessions[sid];
        if (window.__mock.controller?.sessionId === sid) window.__mock.controller = null;
      }
      return snapshotFor(sid);
    }
    return snapshotFor(null);
  }
  if (path === '/api/computer-use/stop' && method === 'POST') {
    window.__mock.controller = null;
    window.__mock.busy = false;
    window.__mock.lastAction = null;
    window.__mock.enabledSessions = {};
    window.__mock.cleanupPending = false;
    window.__mock.cleanupFailed = false;
    return snapshotFor(sessionOf(path));
  }
  const error = new Error('unknown fake route');
  error.status = 404;
  throw error;
};
const toast = (message) => {
  window.__mock.toasts.push(String(typeof message === 'function' ? message() : message));
};
window.__api = api;
window.__pickerSelections = [];
window.__pickModel = (id) => {
  const target = window.__pickerSelections[window.__pickerSelections.length - 1];
  if (!target) throw new Error('no open model picker');
  target.onSelect(id);
};
window.__cu = createComputerUse({ api, getContext: () => window.__ctx, toast });
window.__cp = createComputerPreferences({
  api,
  getContext: () => window.__ctx,
  getModels: () => window.__mock.models,
  openModelPicker: (target) => {
    window.__pickerSelections.push(target);
  },
});
window.__helpers = { normalizeComputerStatus, summarizeComputerAction, ownerDisplayName };
window.__setLanguage = setLanguage;
window.__cu.start();
window.__cp.start();
translateDOM(document.body);
</script>
</body>
</html>`;

const files = {
  '/public/computer-use.js': { path: 'public/computer-use.js', type: 'text/javascript' },
  '/public/computer-preferences.js': { path: 'public/computer-preferences.js', type: 'text/javascript' },
  '/public/i18n.js': { path: 'public/i18n.js', type: 'text/javascript' },
  '/public/i18n-core.js': { path: 'public/i18n-core.js', type: 'text/javascript' },
  '/public/translations.js': { path: 'public/translations.js', type: 'text/javascript' },
  '/public/computer-use.css': { path: 'public/computer-use.css', type: 'text/css' },
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fixture);
      return;
    }
    const entry = files[url.pathname];
    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('missing');
      return;
    }
    const data = await readFile(join(root, entry.path));
    res.writeHead(200, { 'content-type': entry.type, 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('error');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('#computer-use')).toBeVisible();
  await expect(page.locator('#computer-use-toggle')).toBeEnabled();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#computer-use-status')).toHaveText('Inactif');
  await expect(page.locator('#computer-use-stop')).toBeHidden();
  await expect(page.locator('#allow-computer-use')).not.toBeChecked();
  await expect(page.locator('#allow-computer-use')).toBeEnabled();
  await page.screenshot({ path: join(shotDir, 'computer-use-off.png') });

  const postCount = () => page.evaluate(() => window.__mock.calls.filter((c) => c.method === 'POST').length);

  // Draft opt-in without session issues no POST.
  const beforeDraft = await postCount();
  await page.locator('#computer-use-toggle').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#computer-use-status')).toHaveText('Actif au prochain envoi');
  if ((await postCount()) !== beforeDraft) throw new Error('draft toggle must not POST');
  if ((await page.evaluate(() => window.__cu.shouldIncludeInRun())) !== true)
    throw new Error('draft should feed POST /api/runs');
  await expect(page.locator('#allow-computer-use')).toBeChecked();
  await page.locator('#allow-computer-use').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#allow-computer-use')).not.toBeChecked();
  if ((await postCount()) !== beforeDraft) throw new Error('draft checkbox must not POST');
  if ((await page.evaluate(() => window.__cu.shouldIncludeInRun())) !== false)
    throw new Error('cleared draft must not feed runs');
  await page.locator('#allow-computer-use').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: join(shotDir, 'computer-use-draft.png') });

  // Session switch clears stale enabled state, no leak into the new session.
  await page.evaluate(() => {
    window.__ctx.sessionId = 'sess-A';
    window.__setSessionEnabled('sess-A', true);
    window.__setController({ sessionId: 'sess-A', name: 'Test Session' });
    window.__mock.calls = [];
    window.__mock.delayMs = 0;
  });
  await page.evaluate(() => window.__cu.refresh());
  await expect(page.locator('#computer-use-status')).toHaveText('Actif sur cette session');
  await page.evaluate(() => {
    window.__ctx.sessionId = 'sess-B';
    window.__mock.delayMs = 250;
    window.__mock.calls = [];
    window.__cu.onSessionChange();
  });
  const duringSwitch = await page.evaluate(() => ({
    status: window.__cu.status,
    include: window.__cu.shouldIncludeInRun(),
  }));
  if (duringSwitch.status !== null) throw new Error('switch must clear scoped status');
  if (duringSwitch.include !== false) throw new Error('no stale permission reuse during reload');
  await expect(page.locator('#computer-use-status')).toHaveText('Chargement');
  await expect(page.locator('#computer-use-status')).toContainText('autre session', { timeout: 10000 });
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#allow-computer-use')).not.toBeChecked();
  if ((await page.evaluate(() => window.__cu.shouldIncludeInRun())) !== false)
    throw new Error('new session must not reuse old permission');
  await page.evaluate(() => {
    window.__mock.delayMs = 0;
  });

  // Slow POST discarded after navigation.
  await page.evaluate(() => {
    window.__ctx.sessionId = 'sess-A';
    window.__setSessionEnabled('sess-A', false);
    window.__setController(null);
    window.__mock.delayMs = 0;
    window.__mock.calls = [];
  });
  await page.evaluate(() => window.__cu.refresh());
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => {
    window.__mock.delayMs = 400;
    window.__cu.setEnabled(true);
  });
  await page.waitForTimeout(60);
  await page.evaluate(() => {
    window.__ctx.sessionId = 'sess-B';
    window.__cu.onSessionChange();
    window.__mock.delayMs = 0;
  });
  await page.waitForTimeout(800);
  const afterRace = await page.evaluate(() => ({
    enabled: window.__cu.status?.enabled,
    ownerSession: window.__cu.status?.owner?.sessionId,
    include: window.__cu.shouldIncludeInRun(),
    sessB: window.__mock.enabledSessions['sess-B'] === true,
  }));
  if (afterRace.enabled === true) throw new Error('stale POST must not arm new session');
  if (afterRace.sessB !== false) throw new Error('new session flag must stay off');
  if (afterRace.include !== false) throw new Error('new session must not reuse stale permission');
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#computer-use-status')).toContainText('autre session');

  // Existing session enable uses POST mode route.
  await page.evaluate(() => {
    window.__ctx.sessionId = 'sess-A';
    window.__setSessionEnabled('sess-A', false);
    window.__setController(null);
    window.__mock.delayMs = 0;
    window.__mock.calls = [];
    window.__cu.onSessionChange();
  });
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  if ((await page.evaluate(() => window.__cu.draftEnabled)) !== false)
    throw new Error('session switch must clear draft');
  await page.locator('#computer-use-toggle').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#computer-use-status')).toHaveText('Actif sur cette session');
  await expect(page.locator('#allow-computer-use')).toBeChecked();
  await expect(page.locator('#computer-use-stop')).toBeVisible();
  const modeCall = await page.evaluate(() =>
    window.__mock.calls.find((c) => c.path === '/api/computer-use' && c.method === 'POST'),
  );
  if (!modeCall || modeCall.body?.enabled !== true || modeCall.body?.sessionId !== 'sess-A')
    throw new Error('existing session must POST mode with sessionId');
  await page.screenshot({ path: join(shotDir, 'computer-use-mine.png') });

  // Stop preempts a slow toggle and never stops the agent run.
  await page.evaluate(() => {
    window.__mock.delayMs = 500;
  });
  await page.evaluate(() => {
    window.__cu.setEnabled(false);
  });
  await page.waitForTimeout(80);
  if ((await page.evaluate(() => window.__cu.stopComputer())) !== true)
    throw new Error('stop must preempt slow toggle');
  await page.evaluate(() => {
    window.__mock.delayMs = 0;
  });
  await page.waitForTimeout(900);
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  if (!(await page.evaluate(() => window.__mock.calls.some((c) => c.path === '/api/computer-use/stop'))))
    throw new Error('stop must call dedicated stop route');
  if (await page.evaluate(() => window.__mock.calls.some((c) => String(c.path || '').includes('/api/runs/'))))
    throw new Error('computer stop must not stop the agent run');

  // Other owner keeps a visible global emergency stop.
  await page.evaluate(() => {
    window.__mock.calls = [];
    window.__mock.delayMs = 0;
    window.__mock.busy = true;
    window.__mock.lastAction = { type: 'click', x: 10, y: 20 };
    window.__setController({ sessionId: 'other-999', name: 'Other session' });
  });
  await page.evaluate(() => window.__cu.refresh());
  await expect(page.locator('#computer-use-status')).toContainText('Other session');
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#computer-use-stop')).toBeVisible();
  await expect(page.locator('#computer-use-stop')).toBeEnabled();
  await page.screenshot({ path: join(shotDir, 'computer-use-other.png') });
  const beforeOther = await postCount();
  if ((await page.evaluate(() => window.__cu.setEnabled(false))) !== false)
    throw new Error('must not disable another owner');
  if ((await postCount()) !== beforeOther) throw new Error('other owner must not POST on disable');
  await page.locator('#computer-use-stop').click();
  await expect(page.locator('#computer-use-stop')).toBeHidden();
  if (!(await page.evaluate(() => window.__mock.calls.some((c) => c.path === '/api/computer-use/stop'))))
    throw new Error('global stop must work from another session');

  // Read only consultation never mutates.
  await page.evaluate(() => {
    window.__ctx.sessionId = 'sess-A';
    window.__resetMock();
    window.__ctx.sessionId = 'sess-A';
    window.__ctx.readOnly = true;
    window.__cu.onSessionChange();
  });
  await expect(page.locator('#computer-use-toggle')).toBeDisabled();
  await expect(page.locator('#allow-computer-use')).toBeDisabled();
  await expect(page.locator('#computer-use-stop')).toBeHidden();
  if ((await page.evaluate(() => window.__cu.setEnabled(true))) !== false)
    throw new Error('read only must not enable');
  if ((await page.evaluate(() => window.__cu.stopComputer())) !== false)
    throw new Error('read only must not stop');
  if ((await postCount()) !== 0) throw new Error('read only must issue no POST');
  await expect(page.locator('#computer-use-warning')).toContainText('Consultation seule');
  await page.evaluate(() => {
    window.__ctx.readOnly = false;
    window.__cu.onSessionChange();
  });
  await expect(page.locator('#computer-use-toggle')).toBeEnabled();

  // Failed fetch shows an error, not a ready control.
  await page.evaluate(() => {
    window.__mock.failGet = true;
    window.__mock.calls = [];
    window.__cu.onSessionChange();
  });
  await expect(page.locator('#computer-use-status')).toHaveText('Etat indisponible');
  await expect(page.locator('#computer-use-toggle')).toBeDisabled();
  await expect(page.locator('#allow-computer-use')).toBeDisabled();
  if ((await page.evaluate(() => window.__cu.shouldIncludeInRun())) !== false)
    throw new Error('unknown status must not arm a run');
  await page.evaluate(() => {
    window.__mock.failGet = false;
    window.__cu.onSessionChange();
  });
  await expect(page.locator('#computer-use-status')).toHaveText('Inactif');

  // Unsupported system is handled without crash.
  await page.evaluate(() => {
    window.__mock.supported = false;
  });
  await page.evaluate(() => window.__cu.refresh());
  await expect(page.locator('#computer-use-toggle')).toBeDisabled();
  await expect(page.locator('#computer-use-warning')).toContainText('indisponible');

  // Failed shortcut registration warns without blocking activation.
  await page.evaluate(() => {
    window.__mock.supported = true;
    window.__mock.hotkeyError = 'fake registration failed';
    window.__setController(null);
  });
  await page.evaluate(() => window.__cu.refresh());
  await expect(page.locator('#computer-use-toggle')).toBeEnabled();
  await expect(page.locator('#computer-use-hotkey')).toContainText('indisponible');
  await expect(page.locator('#computer-use-hotkey')).not.toContainText('F10');
  if ((await page.evaluate(() => window.__cu.status?.hotkeyError)) !== 'fake registration failed')
    throw new Error('hotkeyError must be retained in status');
  await page.evaluate(() => {
    window.__mock.hotkeyError = null;
  });
  await page.evaluate(() => window.__cu.refresh());
  await expect(page.locator('#computer-use-hotkey')).toHaveText('Ctrl+Alt+Shift+F10');

  // FR and EN translations.
  await page.evaluate(() => {
    window.__mock.supported = true;
    window.__setController(null);
    window.__ctx.sessionId = null;
    window.__mock.calls = [];
  });
  await page.evaluate(() => window.__cu.onSessionChange());
  await expect(page.locator('#computer-use-toggle')).toBeEnabled();
  await page.evaluate(() => window.__setLanguage('en'));
  await expect(page.locator('#computer-use-label')).toHaveText('Expert desktop');
  await expect(page.locator('#computer-use-status')).toHaveText('Off');
  await page.evaluate(() => window.__setLanguage('fr'));
  await expect(page.locator('#computer-use-label')).toHaveText('Bureau expert');
  await expect(page.locator('#computer-use-status')).toHaveText('Inactif');

  // Global engine in Preferences > Tools: names, one global PATCH, lock while on.
  await page.evaluate(() => {
    window.__resetMock();
    window.__ctx.sessionId = null;
    window.__ctx.readOnly = false;
    window.__ctx.online = true;
    window.__cu.onSessionChange();
  });
  await page.evaluate(() => window.__cp.refresh());
  await expect(page.locator('#computer-backend-native')).toBeVisible();
  await expect(page.locator('#computer-backend-cua')).toBeVisible();
  await expect(page.locator('#computer-backend-native')).toBeChecked();
  await expect(page.locator('#computer-backend-native-label')).toContainText('ration');
  await expect(page.locator('#computer-backend-cua-label')).toContainText('Cua Driver (beta)');
  await expect(page.locator('#computer-backend-hint')).toContainText('Windows x64');
  await expect(page.locator('#computer-model-name')).toContainText('Identique');
  await page.evaluate(() => window.__setLanguage('en'));
  await expect(page.locator('#computer-backend-native-label')).toContainText('Original integration');
  await expect(page.locator('#computer-backend-label')).toHaveText('Desktop engine');
  await expect(page.locator('#computer-model-name')).toContainText('Same as conversation');
  await expect(page.locator('#computer-backend-hint')).toContainText('Beta for Windows x64');
  await page.evaluate(() => window.__setLanguage('fr'));
  await expect(page.locator('#computer-backend-label')).toHaveText('Moteur de bureau');
  await expect(page.locator('#computer-backend-native-label')).toContainText('ration originale');

  // The header toggle carries no backend choice anymore.
  await expect(page.locator('#computer-use-backend-native')).toHaveCount(0);
  if ((await page.evaluate(() => window.__cu.shouldIncludeInRun())) !== false)
    throw new Error('neutral header must not arm a run');

  // Selecting CUA while off PATCHes the global preference once, never the computer-use route.
  await expect(page.locator('#computer-backend-cua')).toBeEnabled();
  await expect(page.locator('#computer-use-toggle')).toBeEnabled();
  const prefsPatchCount = () =>
    page.evaluate(
      () =>
        window.__mock.calls.filter(
          (c) => c.path === '/api/studio-preferences' && c.method === 'PATCH',
        ).length,
    );
  const cuPostCount = () =>
    page.evaluate(
      () =>
        window.__mock.calls.filter((c) => c.path === '/api/computer-use' && c.method === 'POST').length,
    );
  const beforePrefs = await prefsPatchCount();
  const beforeCu = await cuPostCount();
  await page.locator('#computer-backend-cua').click();
  await expect(page.locator('#computer-backend-cua')).toBeChecked();
  if ((await prefsPatchCount()) !== beforePrefs + 1)
    throw new Error('backend select must PATCH the global preference exactly once');
  if ((await cuPostCount()) !== beforeCu)
    throw new Error('backend select must not POST to the computer-use route');
  const patchedBackend = await page.evaluate(
    () =>
      window.__mock.calls
        .filter((c) => c.path === '/api/studio-preferences' && c.method === 'PATCH')
        .pop()?.body,
  );
  if (patchedBackend?.computerBackend !== 'cua')
    throw new Error('global PATCH must carry computerBackend cua');
  if ((await page.evaluate(() => window.__cp.getBackend())) !== 'cua')
    throw new Error('global backend getter must be cua');
  await expect(page.locator('#computer-backend-hint')).toContainText('Windows x64');

  // Polling preserves the global choice; a draft header toggle arms no backend payload.
  await page.evaluate(() => window.__cp.refresh());
  await expect(page.locator('#computer-backend-cua')).toBeChecked();
  await page.locator('#computer-use-toggle').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');
  if ((await page.evaluate(() => window.__cu.shouldIncludeInRun())) !== true)
    throw new Error('draft toggle must arm a run');
  if ((await cuPostCount()) !== beforeCu) throw new Error('draft toggle must not POST');
  await page.locator('#computer-use-toggle').click();
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'false');

  // While another owner holds the desktop the global engine locks with a reason.
  await page.evaluate(() => {
    window.__setController({ sessionId: 'other-1', name: 'Other' });
    window.__cp.refresh();
  });
  await expect(page.locator('#computer-backend-native')).toBeDisabled();
  await expect(page.locator('#computer-backend-cua')).toBeDisabled();
  await expect(page.locator('#computer-backend-hint')).toContainText('Désactivez');
  const beforeLocked = await prefsPatchCount();
  if ((await page.evaluate(() => window.__cp.saveBackend('native'))) !== false)
    throw new Error('locked engine save must refuse');
  if ((await prefsPatchCount()) !== beforeLocked) throw new Error('locked engine must not PATCH');
  if ((await page.evaluate(() => window.__cp.getBackend())) !== 'cua')
    throw new Error('locked engine must keep the stored choice');
  const lockedPatch = await page.evaluate(() =>
    window
      .__api('/api/studio-preferences', { method: 'PATCH', body: { computerBackend: 'native' } })
      .then(() => 'ok', (error) => `fail:${error.status}`),
  );
  if (lockedPatch !== 'fail:409') throw new Error('owned desktop must refuse backend PATCH with 409');
  await page.evaluate(() => {
    window.__setController(null);
    window.__cp.refresh();
  });
  await expect(page.locator('#computer-backend-cua')).toBeEnabled();

  // An unavailable CUA shows its reason and stays disabled; native remains usable.
  await page.evaluate(() => {
    window.__setBackends([
      { id: 'native', supported: true, available: true },
      { id: 'cua', supported: true, available: false, reason: 'Install Cua Driver beta for Windows x64.' },
    ]);
    window.__cp.refresh();
  });
  await expect(page.locator('#computer-backend-hint')).toContainText('Install Cua Driver');
  await expect(page.locator('#computer-backend-cua')).toBeDisabled();
  await expect(page.locator('#computer-backend-native')).toBeEnabled();
  const unavailablePatch = await page.evaluate(() =>
    window
      .__api('/api/studio-preferences', { method: 'PATCH', body: { computerBackend: 'cua' } })
      .then(() => 'ok', (error) => `fail:${error.status}:${error.message}`),
  );
  if (!unavailablePatch.startsWith('fail:409:Install Cua Driver'))
    throw new Error('unavailable backend must fail closed with its reason');
  await page.evaluate(() => {
    window.__resetMock();
    window.__cp.refresh();
  });
  await expect(page.locator('#computer-backend-native')).toBeChecked();
  await expect(page.locator('#computer-backend-native')).toBeEnabled();
  await expect(page.locator('#computer-backend-hint')).toContainText('Windows x64');

  // Computer Use model defaults to the conversation model with image guidance.
  await expect(page.locator('#computer-model-button')).toBeEnabled();
  await expect(page.locator('#computer-model-name')).toContainText('Identique');
  await page.locator('#computer-model-button').click();
  if ((await page.evaluate(() => window.__pickerSelections.length)) !== 1)
    throw new Error('model button must open the shared model picker');
  await page.evaluate(() => window.__pickModel('test/vision-2'));
  await expect(page.locator('#computer-model-name')).toContainText('Vision Two');
  if ((await page.evaluate(() => window.__cp.getModel())) !== 'test/vision-2')
    throw new Error('global model getter must follow the picker');
  const patchedModel = await page.evaluate(
    () =>
      window.__mock.calls
        .filter((c) => c.path === '/api/studio-preferences' && c.method === 'PATCH')
        .pop()?.body,
  );
  if (patchedModel?.computerModel !== 'test/vision-2')
    throw new Error('model choice must PATCH computerModel globally');

  // A model without images is refused with a clear error, never silently kept.
  await page.locator('#computer-model-button').click();
  await page.evaluate(() => window.__pickModel('test/text-only'));
  await expect(page.locator('#computer-prefs-error')).toBeVisible();
  await expect(page.locator('#computer-prefs-error')).toContainText('images');
  if ((await page.evaluate(() => window.__cp.getModel())) !== 'test/vision-2')
    throw new Error('refused model must not replace the stored choice');

  // Unknown models are refused too.
  const unknownPatch = await page.evaluate(() =>
    window
      .__api('/api/studio-preferences', { method: 'PATCH', body: { computerModel: 'nope/missing' } })
      .then(() => 'ok', (error) => `fail:${error.status}`),
  );
  if (unknownPatch !== 'fail:400') throw new Error('unknown model must fail with 400');

  // Back to Same as conversation through the picker default row.
  await page.locator('#computer-model-button').click();
  await page.evaluate(() => window.__pickModel(''));
  await expect(page.locator('#computer-model-name')).toContainText('Identique');
  if ((await page.evaluate(() => window.__cp.getModel())) !== '')
    throw new Error('empty choice must restore Same as conversation');

  // Read only locks the global controls; a failed prefs fetch disables them.
  await page.evaluate(() => {
    window.__ctx.readOnly = true;
    window.__cp.refresh();
  });
  await expect(page.locator('#computer-backend-native')).toBeDisabled();
  await expect(page.locator('#computer-backend-cua')).toBeDisabled();
  await expect(page.locator('#computer-model-button')).toBeDisabled();
  await page.evaluate(() => {
    window.__ctx.readOnly = false;
    window.__cp.refresh();
  });
  await expect(page.locator('#computer-backend-native')).toBeEnabled();
  await expect(page.locator('#computer-model-button')).toBeEnabled();
  await page.evaluate(() => {
    window.__mock.failPrefs = true;
    window.__cp.refresh();
  });
  await expect(page.locator('#computer-backend-native')).toBeDisabled();
  await expect(page.locator('#computer-model-button')).toBeDisabled();
  await page.evaluate(() => {
    window.__mock.failPrefs = false;
    window.__cp.refresh();
  });
  await expect(page.locator('#computer-backend-native')).toBeEnabled();

  // Back to neutral draft state for the remaining checks.
  await page.evaluate(() => {
    window.__resetMock();
    window.__ctx.sessionId = null;
    window.__ctx.readOnly = false;
    window.__ctx.online = true;
    window.__cu.onSessionChange();
    window.__cp.refresh();
  });

  // Pure helpers stay bounded and safe.
  const helperCheck = await page.evaluate(() => {
    const long = 'x'.repeat(500);
    const summary = window.__helpers.summarizeComputerAction({ type: 'type', text: long });
    const name = window.__helpers.ownerDisplayName({ cwd: 'C:\\Users\\test\\Project' });
    const normalized = window.__helpers.normalizeComputerStatus(null);
    return {
      summaryLength: summary.length,
      name,
      supported: normalized.supported,
      enabled: normalized.enabled,
    };
  });
  if (helperCheck.summaryLength > 130) throw new Error('action summary must stay bounded');
  if (helperCheck.name !== 'Project') throw new Error('owner name must use folder base');
  if (helperCheck.supported !== true || helperCheck.enabled !== false)
    throw new Error('normalize must default safely');

  // Keyboard access: toggle remains a focusable button with pressed state.
  await page.locator('#computer-use-toggle').focus();
  await expect(page.locator('#computer-use-toggle')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#computer-use-toggle')).toHaveAttribute('aria-pressed', 'true');

  await page.evaluate(() => window.__cu.destroy());
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ').slice(0, 800)}`);
  console.log('computer-use UI checks passed');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
