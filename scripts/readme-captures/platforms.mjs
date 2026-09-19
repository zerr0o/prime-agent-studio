// Fresh README platform captures: mobile + desktop app UI, FR + EN.
// Standalone: node scripts/readme-captures/platforms.mjs [--output <dir>] [--lang fr|en]
// Defaults: .local/readme-refresh/platforms, both languages.
// Layout: <output>/<lang>/<base>.png with the exact mission base names
// (mobile-conversation.png, desktop-remote-access.png, mobile-notifications.png,
// desktop-startup.png, desktop-updates.png), plus <output>/report.json.
// Isolated fixtures only: temp dirs, loopback random ports, stub runtime, demo
// access code, stubbed network interfaces. No native agent, no provider network,
// no user server restart, no real PIN/remote/install/update changes.
// The Tauri bridge is mocked at the boundary (window.__TAURI__ invoke) to render
// the REAL desktop assistant / preferences UI; the result documents
// "capture UI with simulated native bridge", never a packaged app.
// No overlay, banner or DOM forcing is injected into screenshots; fixture scope
// is documented in report.json and README captions, not in the UI.
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { createServer } from 'node:http';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../../server.mjs';
import { createLanGateway, hashAccessCode } from '../../lib/lan.mjs';
import { preferencesFixture } from '../preview-preferences.mjs';
import { createStabilityFixture } from '../fixtures/session-stability.mjs';
import { mockDesktopUpdates } from '../fixtures/desktop-updates.mjs';

const DEMO_CODE = '73194628';
const DEMO_SALT = 'c'.repeat(32);
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

const STRINGS = {
  fr: {
    locale: 'fr-FR',
    project: 'Atelier mobile',
    sessionUser: 'Comment suivre l’avancement depuis mon téléphone ?',
    sessionAssistant: 'Démo isolée : l’historique s’affiche et le composeur reste disponible.',
    modelName: 'Claude mobile',
    laterButton: 'Plus tard',
  },
  en: {
    locale: 'en-US',
    project: 'Mobile studio',
    sessionUser: 'How do I follow progress from my phone?',
    sessionAssistant: 'Isolated demo: history renders and the composer stays available.',
    modelName: 'Mobile Claude',
    laterButton: 'Later',
  },
};

function parseArgs(argv) {
  let output = join('.local', 'readme-refresh', 'platforms');
  let langs = ['fr', 'en'];
  let langTouched = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output' && argv[i + 1]) output = argv[++i];
    else if (arg.startsWith('--output=')) output = arg.slice('--output='.length);
    else if (arg === '--lang' && argv[i + 1]) {
      if (!langTouched) {
        langs = [];
        langTouched = true;
      }
      langs.push(argv[++i]);
    } else if (arg.startsWith('--lang=')) {
      if (!langTouched) {
        langs = [];
        langTouched = true;
      }
      langs.push(arg.slice('--lang='.length));
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/readme-captures/platforms.mjs [--output <dir>] [--lang fr|en]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  langs = [...new Set(langs)];
  for (const lang of langs) {
    if (lang !== 'fr' && lang !== 'en') throw new Error(`Unsupported --lang: ${lang}`);
  }
  return { output: resolve(output), langs };
}

function launchOptions() {
  const channel = process.env.PRIME_STUDIO_BROWSER;
  if (channel) return { channel, headless: true };
  return { headless: true };
}

async function checkedTemp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const resolved = resolve(dir);
  if (!resolved.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected temp directory');
  return resolved;
}

async function removeTemp(dir, prefix) {
  const resolved = resolve(dir);
  if (!resolved.startsWith(resolve(tmpdir()) + sep) || !basename(resolved).startsWith(prefix)) {
    throw new Error('Refused cleanup of unrecognized directory: ' + resolved);
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function closeGateway(gateway) {
  if (!gateway) return;
  try {
    gateway.closeAllConnections();
  } catch {}
  if (gateway.listening) await new Promise((done) => gateway.close(done));
}

async function stubRuntime(modelName) {
  return {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({
      models: [{ id: 'fixture/readme-platforms', name: modelName, provider: 'fixture', reasoning: true }],
      default: { model: 'fixture/readme-platforms' },
    }),
    start: async () => {
      throw new Error('Capture fixture must not start agents.');
    },
    close: async () => {},
  };
}

async function ensureLanguage(page, lang) {
  // Real UI control only: the preferences language selector.
  await page.evaluate(() => document.getElementById('open-settings')?.click());
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.locator('#language-select').selectOption(lang);
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden();
}

async function shot(page, path, fullPage = false) {
  await page.screenshot({ path, animations: 'disabled', fullPage });
  const info = await stat(path);
  if (info.size === 0) throw new Error('Empty screenshot: ' + path);
  return info.size;
}

async function langDir(outDir, lang) {
  const dir = join(outDir, lang);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function captureMobileConversation(browser, outDir, lang) {
  const strings = STRINGS[lang];
  const temp = await checkedTemp('prime-readme-mobile-');
  let app;
  let gateway;
  let context;
  const errors = [];
  const assertions = [];
  try {
    const cwd = join(temp, strings.project);
    const sessionDir = join(temp, 'sessions');
    const agentHome = join(temp, 'agent');
    const dataDir = join(temp, 'data');
    await Promise.all([cwd, sessionDir, agentHome, dataDir].map((p) => mkdir(p, { recursive: true })));
    const sessionId = 'readme-mobile-session';
    await writeFile(
      join(sessionDir, 'readme-mobile.jsonl'),
      [
        { type: 'session', id: sessionId, cwd, timestamp: new Date().toISOString() },
        {
          type: 'message',
          id: 'readme-u0',
          parentId: null,
          message: { role: 'user', content: strings.sessionUser },
        },
        {
          type: 'message',
          id: 'readme-a0',
          parentId: 'readme-u0',
          message: { role: 'assistant', content: [{ type: 'text', text: strings.sessionAssistant }] },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );
    app = createApp({
      runtime: await stubRuntime(strings.modelName),
      agentHome,
      sessionDir,
      dataDir,
      initialCwd: cwd,
    });
    await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
    gateway = createLanGateway({
      host: '127.0.0.1',
      upstreamPort: app.server.address().port,
      config: { readOnly: false, salt: DEMO_SALT, codeHash: hashAccessCode(DEMO_CODE, DEMO_SALT) },
    });
    await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${gateway.address().port}`;
    context = await browser.newContext({
      locale: strings.locale,
      viewport: MOBILE_VIEWPORT,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator('#code').fill(DEMO_CODE);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#connection-label')).toContainText(/connecté|connected/i, {
      timeout: 15000,
    });
    assertions.push('demo access-code login reaches the studio over loopback');
    if (lang === 'en') {
      await ensureLanguage(page, 'en');
      assertions.push('interface language switched through the real language selector');
    }
    // The isolated app lands on the current project overview with the phone drawer closed.
    // Only use the drawer when the overview or its session list is not already there.
    const cards = page.locator('#project-session-list .project-session-card');
    if ((await page.locator('#project-overview').isVisible()) && (await cards.count()) > 0) {
      assertions.push('project overview already open on the demo project after login');
    } else {
      await page.locator('#toggle-sidebar').click();
      await page.locator('#project-list .project-row').filter({ hasText: strings.project }).click();
      await expect(page.locator('#project-overview')).toBeVisible();
      const sidebar = page.locator('#sidebar');
      if (await sidebar.evaluate((node) => node.classList.contains('mobile-open'))) {
        // Real user gesture: Escape closes the phone drawer (closeSidebar).
        await page.keyboard.press('Escape');
        await expect
          .poll(() => sidebar.evaluate((node) => node.classList.contains('mobile-open')))
          .toBe(false);
      }
      assertions.push('project opened through the phone drawer');
    }
    await expect(cards.first()).toBeVisible();
    await cards.first().click();
    await expect(page.locator('#messages')).toContainText(strings.sessionAssistant);
    await expect(page.locator('#composer')).toBeVisible();
    assertions.push('fixture conversation renders with the composer available');
    if (errors.length > 0) throw new Error('pageerror: ' + errors.join(' | '));
    assertions.push('zero pageerror during the scenario');
    const file = 'mobile-conversation.png';
    const dir = await langDir(outDir, lang);
    const bytes = await shot(page, join(dir, file));
    return {
      file,
      width: MOBILE_VIEWPORT.width,
      height: MOBILE_VIEWPORT.height,
      bytes,
      lang,
      scenario: 'mobile-conversation',
      provenance:
        'Real studio UI behind an isolated LAN gateway (loopback, random port, fictional demo code, stub runtime, synthetic fixture conversation). No agent started, no real session, no provider call.',
      assertions,
      pageerrors: 0,
    };
  } finally {
    await context?.close().catch(() => {});
    await closeGateway(gateway);
    await app?.close().catch(() => {});
    await removeTemp(temp, 'prime-readme-mobile-');
  }
}

async function captureDesktopRemoteAccess(browser, outDir, lang) {
  const strings = STRINGS[lang];
  const fixture = await preferencesFixture();
  let context;
  const errors = [];
  const assertions = [];
  try {
    context = await browser.newContext({ locale: strings.locale, viewport: DESKTOP_VIEWPORT });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(fixture.url);
    await expect(page.locator('#connection-label')).toContainText(/connecté|connected/i, {
      timeout: 15000,
    });
    assertions.push('isolated studio loads with the engine connected');
    await page.locator('#open-settings').click();
    await expect(page.locator('#settings-dialog')).toBeVisible();
    if (lang === 'en') {
      await page.locator('#language-select').selectOption('en');
      await expect(page.locator('#settings-title')).toHaveText('Preferences');
      assertions.push('interface language switched through the real language selector');
    }
    await page.locator('#settings-tab-remote').click();
    await expect(page.locator('#settings-panel-remote')).toBeVisible();
    // Real switches on the isolated fixture (loopback-only gateway, temp data dir):
    // enabling LAN generates a throwaway demo code, dismissed right away so no PIN
    // ever appears in the shot.
    await page.locator('#network-lan').click();
    await expect(page.locator('#network-generated-code')).toHaveText(/^[0-9]{8}$/, { timeout: 15000 });
    assertions.push('demo LAN channel enabled through the real switch (code generated, then dismissed)');
    await expect(page.locator('#network-content .network-url').first()).toContainText(/192\.168\.1\.42/, {
      timeout: 15000,
    });
    await page.locator('#network-dismiss-code').click();
    await expect(page.locator('#network-generated-code')).toBeEmpty();
    await page.locator('#network-tailscale').click();
    await expect
      .poll(
        async () =>
          (await page.locator('#network-content .network-url').allInnerTexts()).some((text) =>
            text.includes('100.91.42.10'),
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    const urls = await page.locator('#network-content .network-url').allInnerTexts();
    assertions.push('LAN + Tailscale demo configuration visible: ' + urls.join(' ; '));
    await expect(page.locator('#settings-panel-remote')).toContainText(/HTTPS/i);
    assertions.push('HTTPS choice row visible alongside LAN and Tailscale');
    await expect(page.locator('#network-generated-code')).toBeEmpty();
    assertions.push('no access code displayed (demo PIN never shown or persisted)');
    // Frame the shot on the LAN demo configuration (the panels container scrolls).
    await page.locator('#network-lan').scrollIntoViewIfNeeded();
    await expect(page.locator('#network-content .network-url').first()).toBeVisible();
    if (errors.length > 0) throw new Error('pageerror: ' + errors.join(' | '));
    assertions.push('zero pageerror during the scenario');
    const file = 'desktop-remote-access.png';
    const dir = await langDir(outDir, lang);
    const bytes = await shot(page, join(dir, file));
    return {
      file,
      width: DESKTOP_VIEWPORT.width,
      height: DESKTOP_VIEWPORT.height,
      bytes,
      lang,
      scenario: 'desktop-remote-access',
      provenance:
        'Real Preferences > Remote access UI on an isolated app; network layer stubbed by the preferences fixture (fake interfaces 192.168.1.42 / 192.168.10.42 / 100.91.42.10, fake Tailscale, loopback-only gateway factory). Demo addresses only; no real PIN, no remote change.',
      assertions,
      pageerrors: 0,
    };
  } finally {
    await context?.close().catch(() => {});
    await fixture.close();
  }
}

async function captureMobileNotifications(browser, outDir, lang) {
  const strings = STRINGS[lang];
  const temp = await checkedTemp('prime-readme-notify-');
  let app;
  let context;
  const errors = [];
  const assertions = [];
  try {
    const cwd = join(temp, 'demo');
    const sessionDir = join(temp, 'sessions');
    const agentHome = join(temp, 'agent');
    const dataDir = join(temp, 'data');
    await Promise.all([cwd, sessionDir, agentHome, dataDir].map((p) => mkdir(p, { recursive: true })));
    app = createApp({
      runtime: await stubRuntime(strings.modelName),
      agentHome,
      sessionDir,
      dataDir,
      initialCwd: cwd,
    });
    await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    context = await browser.newContext({
      locale: strings.locale,
      viewport: MOBILE_VIEWPORT,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await expect(page.locator('#connection-label')).toContainText(/connecté|connected/i, {
      timeout: 15000,
    });
    assertions.push('isolated studio loads with the engine connected');
    // Sidebar is a closed drawer on phone widths: use the real settings button.
    await page.evaluate(() => document.getElementById('open-settings')?.click());
    await expect(page.locator('#settings-dialog')).toBeVisible();
    if (lang === 'en') {
      await page.locator('#language-select').selectOption('en');
      await expect(page.locator('#settings-title')).toHaveText('Preferences');
      assertions.push('interface language switched through the real language selector');
    }
    await page.locator('#settings-tab-notifications').click();
    await expect(page.locator('#settings-panel-notifications')).toBeVisible();
    const state = await page.evaluate(() => ({
      pushOptions: document.getElementById('push-options')?.hidden === false ? 'visible' : 'hidden',
      pushUnsupported: document.getElementById('push-unsupported')?.hidden === false ? 'visible' : 'hidden',
      desktopOptions:
        document.getElementById('notification-options')?.hidden === false ? 'visible' : 'hidden',
      pushEnable: document.getElementById('push-enable')?.checked === true ? 'on' : 'off',
    }));
    assertions.push('real notification settings state, no DOM forcing: ' + JSON.stringify(state));
    if (state.pushOptions === state.pushUnsupported) {
      throw new Error('Unexpected push section state: ' + JSON.stringify(state));
    }
    if (errors.length > 0) throw new Error('pageerror: ' + errors.join(' | '));
    assertions.push('zero pageerror during the scenario');
    const file = 'mobile-notifications.png';
    const dir = await langDir(outDir, lang);
    const bytes = await shot(page, join(dir, file));
    return {
      file,
      width: MOBILE_VIEWPORT.width,
      height: MOBILE_VIEWPORT.height,
      bytes,
      lang,
      scenario: 'mobile-notifications',
      provenance:
        'Real Preferences > Notifications state on an isolated app (no DOM forcing, no push subscription created). The shot shows the genuine empty/unsupported state documented in assertions: ' +
        JSON.stringify(state),
      assertions,
      pageerrors: 0,
    };
  } finally {
    await context?.close().catch(() => {});
    await app?.close().catch(() => {});
    await removeTemp(temp, 'prime-readme-notify-');
  }
}

async function captureDesktopStartup(browser, outDir, lang) {
  const strings = STRINGS[lang];
  let context;
  const errors = [];
  const assertions = [];
  const server = createServer(async (req, res) => {
    try {
      const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
      if (!['index.html', 'desktop.js', 'desktop.css', 'icon.png'].includes(name)) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader(
        'Content-Type',
        name.endsWith('.js')
          ? 'text/javascript'
          : name.endsWith('.css')
            ? 'text/css'
            : name.endsWith('.png')
              ? 'image/png'
              : 'text/html',
      );
      res.end(await readFile(join('desktop', name)));
    } catch {
      res.writeHead(500).end();
    }
  });
  try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.address().port}`;
    context = await browser.newContext({
      locale: strings.locale,
      viewport: DESKTOP_VIEWPORT,
      colorScheme: 'dark',
    });
    await context.addInitScript(() => {
      window.calls = [];
      window.__TAURI__ = {
        event: {
          listen: async () => {},
        },
        core: {
          invoke: async (name, args) => {
            window.calls.push({ name, args });
            if (name === 'desktop_state')
              return { version: '3.6.1', started: false, imported: false, autostart: false };
            if (name === 'desktop_start') {
              if (args?.allowUnconfigured) return { port: 3088 };
              throw new Error('components_required:missing');
            }
            if (name === 'desktop_components') {
              if (args?.action === 'install') return new Promise(() => {});
              return {
                ready: false,
                components: {
                  engine: { status: 'missing' },
                  uv: { status: 'missing' },
                  python: { status: 'pending' },
                },
              };
            }
            if (name === 'desktop_components_cancel') return {};
            if (name === 'desktop_update_status')
              return { managed: true, running: false, activeRuns: 0, version: '3.6.1' };
            return {};
          },
        },
      };
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await expect(page.locator('#components')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#components-install')).toBeVisible();
    await expect(page.locator('#start')).toContainText(strings.laterButton);
    const installed = await page.evaluate(() => window.calls.some((call) => call.args?.action === 'install'));
    if (installed) throw new Error('Component install must not start during capture.');
    assertions.push('real desktop assistant shows missing components with an explicit install action');
    assertions.push('no component download or install was triggered');
    if (errors.length > 0) throw new Error('pageerror: ' + errors.join(' | '));
    assertions.push('zero pageerror during the scenario');
    const file = 'desktop-startup.png';
    const dir = await langDir(outDir, lang);
    const bytes = await shot(page, join(dir, file));
    return {
      file,
      width: DESKTOP_VIEWPORT.width,
      height: DESKTOP_VIEWPORT.height,
      bytes,
      lang,
      scenario: 'desktop-startup',
      provenance:
        'Real Windows assistant UI (desktop/index.html) served locally; Tauri native bridge simulated at the boundary (mock __TAURI__ invoke: missing engine/uv, pending Python). Capture UI with simulated native bridge, not a packaged app; nothing installed.',
      assertions,
      pageerrors: 0,
    };
  } finally {
    await context?.close().catch(() => {});
    if (server.listening) await new Promise((done) => server.close(done));
  }
}

async function captureDesktopUpdates(browser, outDir, lang) {
  const strings = STRINGS[lang];
  const fixture = await createStabilityFixture();
  let context;
  const errors = [];
  const assertions = [];
  try {
    context = await browser.newContext({ locale: strings.locale, viewport: DESKTOP_VIEWPORT });
    await mockDesktopUpdates(context);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(fixture.url + '/?settings=updates');
    await expect(page.locator('#settings-tab-updates')).toHaveAttribute('aria-selected', 'true', {
      timeout: 15000,
    });
    if (lang === 'en') {
      await page.locator('#settings-tab-appearance').click();
      await page.locator('#language-select').selectOption('en');
      await page.locator('#settings-tab-updates').click();
      await expect(page.locator('#settings-tab-updates')).toHaveAttribute('aria-selected', 'true');
      assertions.push('interface language switched through the real language selector');
    }
    await expect(page.locator('#studio-update-app-version')).toHaveText('2.9.3');
    await expect(page.locator('#studio-update-server-version')).toHaveText('2.9.2');
    assertions.push('fixture app/server versions displayed (2.9.3 / 2.9.2)');
    await page.locator('#studio-update-check').click();
    await expect(page.locator('#studio-update-install')).toBeVisible();
    await expect(page.locator('#studio-update-notes-body').locator('img')).toHaveCount(0);
    assertions.push('update check offers install with literal release notes (markup stripped)');
    const notes = page.locator('#studio-update-notes');
    try {
      if (await notes.isVisible()) {
        await notes.locator('summary').click();
        await expect(page.locator('#studio-update-notes-body')).toBeVisible();
        assertions.push('release notes expanded through the real disclosure control');
      }
    } catch {}
    if (errors.length > 0) throw new Error('pageerror: ' + errors.join(' | '));
    assertions.push('zero pageerror during the scenario');
    const file = 'desktop-updates.png';
    const dir = await langDir(outDir, lang);
    const bytes = await shot(page, join(dir, file));
    return {
      file,
      width: DESKTOP_VIEWPORT.width,
      height: DESKTOP_VIEWPORT.height,
      bytes,
      lang,
      scenario: 'desktop-updates',
      provenance:
        'Real Preferences > Updates UI on an isolated app; Tauri native bridge simulated at the boundary (mockDesktopUpdates: fixture versions, literal notes, no download/install/restart). Capture UI with simulated native bridge, not a packaged app.',
      assertions,
      pageerrors: 0,
    };
  } finally {
    await context?.close().catch(() => {});
    await fixture.close();
  }
}

const SCENARIOS = [
  ['mobile-conversation', captureMobileConversation],
  ['desktop-remote-access', captureDesktopRemoteAccess],
  ['mobile-notifications', captureMobileNotifications],
  ['desktop-startup', captureDesktopStartup],
  ['desktop-updates', captureDesktopUpdates],
];

const { output, langs } = parseArgs(process.argv.slice(2));
await mkdir(output, { recursive: true });
const browser = await chromium.launch(launchOptions());
const captures = [];
try {
  for (const lang of langs) {
    for (const [name, run] of SCENARIOS) {
      console.log(`capture ${name} (${lang})`);
      captures.push(await run(browser, output, lang));
      console.log(`saved ${captures.at(-1).file}`);
    }
  }
} finally {
  await browser.close().catch(() => {});
}
for (const entry of captures) entry.path = `${entry.lang}/${entry.file}`;
const report = {
  tool: 'scripts/readme-captures/platforms.mjs',
  generatedAt: new Date().toISOString(),
  browser: process.env.PRIME_STUDIO_BROWSER || 'chromium (playwright default, Edge absent)',
  output,
  langs,
  noOverlayNote:
    'No SIMULÉ banner or DOM forcing in any shot; fixture scope lives in this manifest and README captions.',
  captures,
};
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ saved: captures.map((c) => c.file), report: join(output, 'report.json') }));
