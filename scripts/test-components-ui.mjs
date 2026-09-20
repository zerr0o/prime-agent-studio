import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const server = createServer(async (req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!['index.html', 'desktop.js', 'desktop.css', 'icon.png'].includes(name))
    return res.writeHead(404).end();
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
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({
  channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'msedge',
  headless: true,
});
await mkdir('.local/components-ui', { recursive: true });
try {
  for (const locale of ['fr-FR', 'en-US']) {
    const context = await browser.newContext({
      locale,
      colorScheme: locale.startsWith('fr') ? 'dark' : 'light',
      viewport: { width: 660, height: 850 },
    });
    await context.addInitScript(() => {
      window.calls = [];
      window.__TAURI__ = {
        event: {
          listen: async (_, fn) => {
            window.componentProgress = fn;
          },
        },
        core: {
          invoke: async (name, args) => {
            window.calls.push({ name, args });
            if (name === 'desktop_state') return { version: '3.2.7', started: true, imported: true };
            // Warm-first: foreground tries desktop_start before diagnose.
            // Strict first call requires setup; bypass (Later/background) opens anyway.
            if (name === 'desktop_start') {
              if (args?.allowUnconfigured) return { port: 3088 };
              throw new Error('components_required:missing');
            }
            if (name === 'desktop_components') {
              if (args.action === 'install') {
                window.componentProgress({
                  payload: { component: 'engine', stage: 'download', received: 16384, total: 32768 },
                });
                return new Promise((done) => {
                  window.finishInstall = done;
                });
              }
              return {
                ready: false,
                components: {
                  engine: { status: 'missing' },
                  uv: { status: 'missing' },
                  python: { status: 'pending' },
                },
              };
            }
            if (name === 'desktop_components_cancel')
              window.finishInstall({ failure: { component: 'engine', error: 'cancelled' } });
            if (name === 'desktop_update_status')
              return { managed: true, running: true, activeRuns: 0, version: '3.2.7' };
            return {};
          },
        },
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    // Warm-first: strict desktop_start first (throws components_required),
    // then full diagnose shows components with Later. No auto-install.
    await expect
      .poll(() => page.evaluate(() => window.calls.some((c) => c.name === 'desktop_start')))
      .toBe(true);
    await expect(page.locator('#components')).toBeVisible();
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.args?.action === 'install')), false);
    await expect(page.locator('#start')).toContainText(locale.startsWith('fr') ? 'Plus tard' : 'Later');
    await page.locator('#components-install').click();
    await expect(page.locator('#components-status')).toContainText(
      locale.startsWith('fr') ? 'octets reçus' : 'bytes received',
    );
    await expect(page.locator('#components-status')).not.toContainText('%');
    await page.locator('#components-cancel').click();
    await expect(page.locator('#components-status')).toContainText(
      locale.startsWith('fr') ? 'annulée' : 'cancelled',
    );
    await page.locator('#components-install').click();
    await page.evaluate(() =>
      window.finishInstall({
        ready: true,
        activation: 'deferred',
        components: {
          engine: {
            status: 'ready',
            version: '0.9.5',
            path: 'C:\\Données Studio\\engine\\cli.js',
            provenance: 'https://official.example/prime-agent-0.9.5.tgz',
          },
          python: { status: 'ready' },
          bash: { status: 'ready' },
          uv: { status: 'ready', version: '0.8.22' },
        },
      }),
    );
    await expect(page.locator('#components-status')).toContainText(
      locale.startsWith('fr') ? 'différée' : 'deferred',
    );
    // Deferred activation must not open Studio: only the initial strict
    // desktop_start (which required setup) has run so far.
    assert.equal(
      await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length),
      1,
    );
    await expect(page.locator('#components-details')).toBeHidden();
    await expect(page.locator('#components-install')).toBeHidden();
    await page.locator('#components-toggle').click();
    await expect(page.locator('#components-details')).toBeVisible();
    await expect(page.locator('#components-detail-list')).toContainText('C:\\Données Studio\\engine\\cli.js');
    await expect(page.locator('#components-toggle')).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: `.local/components-ui/details-${locale}.png`, fullPage: true });
    await page.locator('#components-toggle').click();
    await page.screenshot({ path: `.local/components-ui/${locale}.png`, fullPage: true });
    await page.goto(url + '/?settings');
    await expect(page.locator('#components')).toBeVisible();
    await page.evaluate(() =>
      renderComponents({
        ready: true,
        components: {
          engine: {
            status: 'ready',
            version: '0.9.5',
            path: 'C:\\Données Studio\\engine\\prime-agent\\0.9.5-12345678\\dist\\bundle\\cli.js',
          },
          node: { status: 'ready', version: '24.21.0' },
          python: { status: 'ready', path: 'C:\\Données Studio\\.local\\kernel-venv\\python.exe' },
          uv: { status: 'ready', version: '0.8.22' },
          bash: { status: 'ready' },
        },
      }),
    );
    await expect(page.locator('#components-details')).toBeHidden();
    assert.ok((await page.locator('#components').boundingBox()).height < 190);
    await page.screenshot({ path: `.local/components-ui/settings-${locale}.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 850 });
    await page.locator('#components-toggle').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goto(url + '/?background');
    await expect
      .poll(() => page.evaluate(() => window.calls.some((c) => c.name === 'desktop_start')))
      .toBe(true);
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.args?.action === 'install')), false);
    assert.deepEqual(errors, []);
    await context.close();
  }
  for (const locale of ['fr-FR', 'en-US']) {
    const fr = locale.startsWith('fr');
    const context = await browser.newContext({ locale, viewport: { width: 660, height: 850 } });
    await context.addInitScript(() => {
      window.calls = [];
      window.applyCalls = 0;
      const guideComponents = {
        engine: { status: 'ready', version: '0.9.5', path: 'C:\\Guide Studio\\engine\\cli.js' },
        python: { status: 'ready' },
        bash: { status: 'ready' },
        uv: { status: 'ready', version: '0.8.22' },
      };
      const guideDiagnose = () => ({
        ready: true,
        needsRestart: true,
        requiredEngine: '0.9.5',
        server: { managed: true, running: true, activeRuns: 0, version: '3.9.8' },
        components: guideComponents,
      });
      window.__TAURI__ = {
        event: { listen: async () => () => {} },
        core: {
          invoke: async (name, args) => {
            window.calls.push({ name, args });
            if (name === 'desktop_state') return { version: '3.9.9', started: true, imported: true };
            if (name === 'desktop_start') {
              if (args && args.allowUnconfigured) return { port: 3088 };
              return { showUpdates: true };
            }
            if (name === 'desktop_components') {
              if (args.action === 'diagnose') return guideDiagnose();
              if (args.action === 'activate') return guideDiagnose();
              if (args.action === 'apply') {
                window.applyCalls++;
                if (window.applyCalls === 1)
                  return {
                    ready: true, activation: 'failed', activationError: 'server_validation_failed',
                    needsRestart: true, requiredEngine: '0.9.5',
                    server: { managed: true, running: true, activeRuns: 0, version: '3.9.8' },
                    components: guideComponents,
                  };
                if (window.applyCalls === 2)
                  return {
                    ready: true, activation: 'deferred', activationReason: 'agents_running',
                    needsRestart: true, requiredEngine: '0.9.5',
                    server: { managed: true, running: true, activeRuns: 1, version: '3.9.8' },
                    components: guideComponents,
                  };
                return {
                  ready: true, activation: 'active', needsRestart: false, requiredEngine: '0.9.5',
                  server: { managed: true, running: true, activeRuns: 0, version: '3.9.9' },
                  components: guideComponents,
                };
              }
              if (args.action === 'install') throw new Error('guide_must_not_auto_install');
              return { ready: false, components: {} };
            }
            return {};
          },
        },
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    await expect
      .poll(() => page.evaluate(() => window.calls.some((c) => c.name === 'desktop_start')))
      .toBe(true);
    await expect(page.locator('#title')).toContainText(fr ? 'Terminer la mise à jour' : 'Finish the Studio update');
    await expect(page.locator('#description')).toContainText('0.9.5');
    await expect(page.locator('#components')).toBeVisible();
    await expect(page.locator('#components-note')).toContainText('0.9.5');
    await expect(page.locator('#components-apply')).toBeVisible();
    await expect(page.locator('#components-apply')).toContainText(fr ? 'Activer' : 'Activate');
    await expect(page.locator('#components-install')).toBeHidden();
    await expect(page.locator('#start')).toContainText(fr ? 'Plus tard' : 'Later');
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.args && c.args.action === 'install')), false);
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length), 1);
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.args && c.args.action === 'diagnose').length), 1);
    await page.locator('#start').click();
    await expect
      .poll(() => page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length))
      .toBe(2);
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.args && c.args.action === 'activate')), true);
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.args && c.args.action === 'apply')), false);
    const laterStart = await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').at(-1));
    assert.equal(laterStart.args.allowUnconfigured, true);
    await page.locator('#components-apply').click();
    await expect.poll(() => page.evaluate(() => window.applyCalls)).toBe(1);
    await expect(page.locator('#components-status')).toContainText(fr ? 'aucun téléchargement' : 'no further download');
    await expect(page.locator('#components-status')).toContainText(fr ? 'autre version' : 'another version');
    await expect(page.locator('#components-list')).toContainText('0.9.5');
    await expect(page.locator('#components-detail-list')).toContainText('C:\\Guide Studio\\engine\\cli.js');
    await expect(page.locator('#logs')).toBeVisible();
    await expect(page.locator('#components-apply')).toBeVisible();
    await expect(page.locator('#components-install')).toBeHidden();
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length), 2);
    await page.screenshot({ path: `.local/components-ui/guide-failed-${locale}.png`, fullPage: true });
    await page.locator('#components-apply').click();
    await expect.poll(() => page.evaluate(() => window.applyCalls)).toBe(2);
    await expect(page.locator('#components-status')).toContainText(fr ? 'différée' : 'deferred');
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length), 2);
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.args && c.args.action === 'install')), false);
    await page.locator('#components-apply').click();
    await expect.poll(() => page.evaluate(() => window.applyCalls)).toBe(3);
    await expect
      .poll(() => page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length))
      .toBe(3);
    const activeStart = await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').at(-1));
    assert.equal(activeStart.args.allowUnconfigured, true);
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.args && c.args.action === 'install')), false);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // One-time 0.9.5/3.7 migration notice: narrow in-window dialog, never a
  // second window and never an install/apply/start side effect.
  // fr proves the old-server branch, en the old-installed-engine branch.
  for (const locale of ['fr-FR', 'en-US']) {
    const fr = locale.startsWith('fr');
    const serverVersion = fr ? '3.6.2' : '3.9.9';
    const installedEngine = fr ? '0.9.5' : '0.9.4';
    const ready = fr;
    const context = await browser.newContext({ locale, viewport: { width: 660, height: 850 } });
    await context.addInitScript(
      ({ legacyServer, legacyInstalled, legacyReady }) => {
        window.calls = [];
        const components = {
          engine: legacyReady
            ? { status: 'ready', version: '0.9.5', path: 'C:\\Migration Studio\\engine\\cli.js' }
            : { status: 'missing' },
          python: { status: 'ready' },
          bash: { status: 'ready' },
          uv: { status: 'ready', version: '0.8.22' },
        };
        window.__TAURI__ = {
          event: { listen: async () => () => {} },
          core: {
            invoke: async (name, args) => {
              window.calls.push({ name, args });
              if (name === 'desktop_state') return { version: '3.9.9', started: true, imported: true };
              if (name === 'desktop_start') {
                if (args && args.allowUnconfigured) return { port: 3088 };
                return { showUpdates: true };
              }
              if (name === 'desktop_components') {
                if (args.action === 'install' || args.action === 'apply')
                  throw new Error('migration_notice_must_not_act');
                return {
                  ready: legacyReady,
                  needsUpdate: !legacyReady,
                  needsRestart: legacyReady,
                  serverUpdatePending: true,
                  requiredEngine: '0.9.5',
                  installedEngine: legacyInstalled,
                  appVersion: '3.9.9',
                  server: {
                    managed: true,
                    running: true,
                    activeRuns: 0,
                    version: legacyServer,
                    engineVersion: legacyReady ? '0.9.5' : '0.9.4',
                    engineAvailable: true,
                  },
                  components,
                };
              }
              return {};
            },
          },
        };
      },
      { legacyServer: serverVersion, legacyInstalled: installedEngine, legacyReady: ready },
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    await expect
      .poll(() => page.evaluate(() => window.calls.some((c) => c.name === 'desktop_start')))
      .toBe(true);
    await expect(page.locator('#title')).toContainText(fr ? 'Terminer la mise à jour' : 'Finish the Studio update');
    const dialog = page.locator('#migration-dialog');
    await expect.poll(() => page.evaluate(() => document.querySelector('#migration-dialog')?.open)).toBe(true);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-labelledby', 'migration-title');
    await expect(dialog).toHaveAttribute('aria-describedby', 'migration-desc');
    await expect(page.locator('#migration-title')).toContainText('0.9.5');
    await expect(page.locator('#migration-desc')).toContainText('0.9.5');
    await expect(page.locator('#migration-desc')).toContainText(fr ? 'composants' : 'components');
    await expect(page.locator('#migration-desc')).toContainText(fr ? 'conserv' : 'kept');
    await expect(page.locator('#migration-desc')).toContainText(fr ? 'comptes' : 'accounts');
    await expect(page.locator('#migration-desc')).toContainText(fr ? 'sessions' : 'sessions');
    await expect(page.locator('#migration-continue')).toContainText(fr ? 'composants' : 'components');
    await expect(page.locator('#migration-later')).toContainText(fr ? 'Plus tard' : 'Later');
    await expect(page.locator('#migration-continue')).toBeFocused();
    // The notice itself never installs, applies, or opens Studio.
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length), 1);
    assert.equal(
      await page.evaluate(() => window.calls.some((c) => c.args && ['install', 'apply'].includes(c.args.action))),
      false,
    );
    await page.screenshot({ path: `.local/components-ui/migration-${locale}.png`, fullPage: true });
    // Primary only reveals/focuses the existing component control.
    await page.locator('#migration-continue').click();
    await expect.poll(() => page.evaluate(() => document.querySelector('#migration-dialog')?.open)).toBe(false);
    await expect(page.locator('#components')).toBeVisible();
    await expect(page.locator(ready ? '#components-apply' : '#components-install')).toBeFocused();
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length), 1);
    assert.equal(
      await page.evaluate(() => window.calls.some((c) => c.args && ['install', 'apply'].includes(c.args.action))),
      false,
    );
    assert.equal(await page.evaluate(() => localStorage.getItem('prime-studio.migration-095-dismissed')), '1');
    // Dismissal is remembered across reload: the guide returns, the notice does not.
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => window.calls.some((c) => c.name === 'desktop_start')))
      .toBe(true);
    await expect(page.locator('#title')).toContainText(fr ? 'Terminer la mise à jour' : 'Finish the Studio update');
    await expect(page.locator('#components')).toBeVisible();
    assert.equal(await page.evaluate(() => document.querySelector('#migration-dialog')?.open ?? false), false);
    assert.equal(
      await page.evaluate(() => window.calls.some((c) => c.args && ['install', 'apply'].includes(c.args.action))),
      false,
    );
    // Escape also dismisses and is remembered.
    await page.evaluate(() => localStorage.removeItem('prime-studio.migration-095-dismissed'));
    await page.reload();
    await expect.poll(() => page.evaluate(() => document.querySelector('#migration-dialog')?.open)).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => document.querySelector('#migration-dialog')?.open)).toBe(false);
    assert.equal(await page.evaluate(() => localStorage.getItem('prime-studio.migration-095-dismissed')), '1');
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length), 1);
    await page.reload();
    await expect(page.locator('#components')).toBeVisible();
    assert.equal(await page.evaluate(() => document.querySelector('#migration-dialog')?.open ?? false), false);
    // Narrow mobile layout: the dialog fits and the secondary button only dismisses.
    await page.setViewportSize({ width: 390, height: 850 });
    await page.evaluate(() => localStorage.removeItem('prime-studio.migration-095-dismissed'));
    await page.reload();
    await expect.poll(() => page.evaluate(() => document.querySelector('#migration-dialog')?.open)).toBe(true);
    await expect(page.locator('#migration-later')).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `.local/components-ui/migration-mobile-${locale}.png`, fullPage: true });
    const startsBefore = await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length);
    await page.locator('#migration-later').click();
    await expect.poll(() => page.evaluate(() => document.querySelector('#migration-dialog')?.open)).toBe(false);
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length), startsBefore);
    assert.equal(
      await page.evaluate(() => window.calls.some((c) => c.args && ['install', 'apply'].includes(c.args.action))),
      false,
    );
    assert.equal(await page.evaluate(() => localStorage.getItem('prime-studio.migration-095-dismissed')), '1');
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Cold foreground boot with a known older engine receipt and no running
  // server: the boot components_required catch must still explain the step.
  {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 660, height: 850 } });
    await context.addInitScript(() => {
      window.calls = [];
      window.__TAURI__ = {
        event: { listen: async () => {} },
        core: {
          invoke: async (name, args) => {
            window.calls.push({ name, args });
            if (name === 'desktop_state') return { version: '3.9.9', started: false, imported: true };
            if (name === 'desktop_start') {
              if (args && args.allowUnconfigured) return { port: 3088 };
              throw new Error('components_required:missing');
            }
            if (name === 'desktop_components') {
              if (args.action === 'install' || args.action === 'apply')
                throw new Error('migration_notice_must_not_act');
              return {
                ready: false,
                needsUpdate: true,
                requiredEngine: '0.9.5',
                installedEngine: '0.9.4',
                appVersion: '3.9.9',
                server: { managed: true, running: false, activeRuns: 0 },
                components: {
                  engine: { status: 'missing' },
                  uv: { status: 'ready', version: '0.8.22' },
                  python: { status: 'pending' },
                },
              };
            }
            return {};
          },
        },
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    await expect(page.locator('#components')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.querySelector('#migration-dialog')?.open)).toBe(true);
    await expect(page.locator('#migration-title')).toContainText('0.9.5');
    await expect(page.locator('#migration-desc')).toContainText('0.9.5');
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length), 1);
    assert.equal(
      await page.evaluate(() => window.calls.some((c) => c.args && ['install', 'apply'].includes(c.args.action))),
      false,
    );
    await page.screenshot({ path: '.local/components-ui/migration-cold-fr-FR.png', fullPage: true });
    await page.locator('#migration-continue').click();
    await expect.poll(() => page.evaluate(() => document.querySelector('#migration-dialog')?.open)).toBe(false);
    await expect(page.locator('#components-install')).toBeFocused();
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length), 1);
    assert.equal(
      await page.evaluate(() => window.calls.some((c) => c.args && ['install', 'apply'].includes(c.args.action))),
      false,
    );
    await page.reload();
    await expect(page.locator('#components')).toBeVisible();
    assert.equal(await page.evaluate(() => document.querySelector('#migration-dialog')?.open ?? false), false);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Explicit recovery surface (?settings) with an old server still running:
  // the notice appears on load, Escape dismisses and is remembered.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 660, height: 850 } });
    await context.addInitScript(() => {
      window.calls = [];
      window.__TAURI__ = {
        event: { listen: async () => {} },
        core: {
          invoke: async (name, args) => {
            window.calls.push({ name, args });
            if (name === 'desktop_state') return { version: '3.9.9', started: true, imported: true };
            if (name === 'desktop_update_status')
              return { managed: true, running: true, activeRuns: 0, version: '3.6.2' };
            if (name === 'desktop_start') return { port: 3088 };
            if (name === 'desktop_components') {
              if (args.action === 'install' || args.action === 'apply')
                throw new Error('migration_notice_must_not_act');
              return {
                ready: true,
                needsRestart: true,
                requiredEngine: '0.9.5',
                installedEngine: '0.9.5',
                appVersion: '3.9.9',
                server: {
                  managed: true,
                  running: true,
                  activeRuns: 0,
                  version: '3.6.2',
                  engineVersion: '0.9.4',
                  engineAvailable: true,
                },
                components: {
                  engine: { status: 'ready', version: '0.9.5', path: 'C:\\Migration Studio\\engine\\cli.js' },
                  python: { status: 'ready' },
                  bash: { status: 'ready' },
                  uv: { status: 'ready', version: '0.8.22' },
                },
              };
            }
            return {};
          },
        },
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url + '/?settings');
    await expect(page.locator('#components')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.querySelector('#migration-dialog')?.open)).toBe(true);
    await expect(page.locator('#migration-desc')).toContainText('0.9.5');
    await expect(page.locator('#migration-desc')).toContainText('components');
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.name === 'desktop_start')), false);
    assert.equal(
      await page.evaluate(() => window.calls.some((c) => c.args && ['install', 'apply'].includes(c.args.action))),
      false,
    );
    await page.screenshot({ path: '.local/components-ui/migration-settings-en-US.png', fullPage: true });
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => document.querySelector('#migration-dialog')?.open)).toBe(false);
    assert.equal(await page.evaluate(() => localStorage.getItem('prime-studio.migration-095-dismissed')), '1');
    assert.equal(
      await page.evaluate(() => window.calls.some((c) => c.args && ['install', 'apply'].includes(c.args.action))),
      false,
    );
    await page.reload();
    await expect(page.locator('#components')).toBeVisible();
    assert.equal(await page.evaluate(() => document.querySelector('#migration-dialog')?.open ?? false), false);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // No notice when the migration is already satisfied (current server/engine).
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 660, height: 850 } });
    await context.addInitScript(() => {
      window.calls = [];
      window.__TAURI__ = {
        event: { listen: async () => () => {} },
        core: {
          invoke: async (name, args) => {
            window.calls.push({ name, args });
            if (name === 'desktop_state') return { version: '3.9.9', started: true, imported: true };
            if (name === 'desktop_start') {
              if (args && args.allowUnconfigured) return { port: 3088 };
              return { showUpdates: true };
            }
            if (name === 'desktop_components')
              return {
                ready: true,
                needsRestart: false,
                requiredEngine: '0.9.5',
                installedEngine: '0.9.5',
                server: { managed: true, running: true, activeRuns: 0, version: '3.9.9' },
                components: { engine: { status: 'ready', version: '0.9.5' } },
              };
            return {};
          },
        },
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    await expect(page.locator('#components')).toBeVisible();
    assert.equal(await page.evaluate(() => document.querySelector('#migration-dialog')?.open ?? false), false);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // No notice on a clean fresh install without legacy evidence.
  {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 660, height: 850 } });
    await context.addInitScript(() => {
      window.calls = [];
      window.__TAURI__ = {
        event: { listen: async () => {} },
        core: {
          invoke: async (name, args) => {
            window.calls.push({ name, args });
            if (name === 'desktop_state') return { version: '3.9.9', started: false, imported: false };
            if (name === 'desktop_start') throw new Error('components_required:missing');
            if (name === 'desktop_components')
              return { ready: false, components: { engine: { status: 'missing' } } };
            return {};
          },
        },
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    await expect(page.locator('#components')).toBeVisible();
    assert.equal(await page.evaluate(() => document.querySelector('#migration-dialog')?.open ?? false), false);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // No notice on background autostart, even with legacy evidence present.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 660, height: 850 } });
    await context.addInitScript(() => {
      window.calls = [];
      window.__TAURI__ = {
        event: { listen: async () => {} },
        core: {
          invoke: async (name, args) => {
            window.calls.push({ name, args });
            if (name === 'desktop_state') return { version: '3.9.9', started: true, imported: true };
            if (name === 'desktop_start') return { port: 3088 };
            if (name === 'desktop_components')
              return {
                ready: false,
                needsUpdate: true,
                requiredEngine: '0.9.5',
                installedEngine: '0.9.4',
                server: { managed: true, running: true, activeRuns: 0, version: '3.6.2' },
                components: { engine: { status: 'missing' } },
              };
            return {};
          },
        },
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url + '/?background');
    await expect
      .poll(() => page.evaluate(() => window.calls.some((c) => c.name === 'desktop_start')))
      .toBe(true);
    assert.equal(await page.evaluate(() => document.querySelector('#migration-dialog')?.open ?? false), false);
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.args?.action === 'install')), false);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    'PASS: FR/EN first run, settings, explicit install, bytes, cancellation, deferred activation, background without installation, boot update guide, Later allowUnconfigured, failed activation preserved, apply retry, engine version, one-time 0.9.5 migration notice without side effects.',
  );
} finally {
  await browser.close();
  server.close();
}
