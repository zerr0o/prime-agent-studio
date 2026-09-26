import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
// Single-window shell: Repair -> no implicit restart -> confirmed Restart.
// Controlled snapshots only, no real app, no live Studio.
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
  channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome',
  headless: true,
});
await mkdir('.local/components-ui', { recursive: true });
const READY_COMPONENTS = {
  engine: {
    status: 'ready',
    version: '0.9.6',
    path: 'C:\\Donn\u00e9es Studio\\engine\\cli.js',
    provenance: 'https://official.example/prime-agent-0.9.6.tgz',
  },
  python: { status: 'ready' },
  bash: { status: 'ready' },
  uv: { status: 'ready', version: '0.8.22' },
};
try {
  for (const locale of ['fr-FR', 'en-US']) {
    const fr = locale.startsWith('fr');
    const context = await browser.newContext({
      locale,
      colorScheme: fr ? 'dark' : 'light',
      viewport: { width: 660, height: 850 },
    });
    await context.addInitScript(() => {
      window.calls = [];
      window.restartCalls = [];
      window.phase = 'initial';
      window.runs = 0;
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
            if (name === 'desktop_start') {
              if (args?.allowUnconfigured) return { port: 3088 };
              throw new Error('components_required:missing');
            }
            if (name === 'desktop_components') {
              if (args.action === 'diagnose') {
                if (window.phase === 'ready')
                  return {
                    ready: true,
                    needsRestart: true,
                    requiredEngine: '0.9.6',
                    components: window.readyComponents,
                  };
                return {
                  ready: false,
                  components: {
                    engine: { status: 'missing' },
                    uv: { status: 'missing' },
                    python: { status: 'pending' },
                  },
                };
              }
              if (args.action === 'prepare') {
                window.componentProgress({
                  payload: { component: 'engine', stage: 'download', received: 16384, total: 32768 },
                });
                return new Promise((done) => {
                  window.finishPrepare = done;
                });
              }
              return { ready: false, components: {} };
            }
            if (name === 'desktop_components_cancel')
              window.finishPrepare({ failure: { component: 'engine', error: 'cancelled' } });
            if (name === 'desktop_update_status')
              return {
                managed: true,
                running: true,
                activeRuns: window.runs,
                version: '3.2.7',
                canRestart: true,
                restartReason: null,
                operation: null,
              };
            if (name === 'desktop_update_operation') return { operation: window.testOperation || null, log: [] };
            if (name === 'desktop_update_cancel') return { operation: null, log: [] };
            if (name === 'desktop_server_restart') {
              window.restartCalls.push({ args });
              return { restarted: true, version: '3.2.7' };
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
    // Warm-first: strict desktop_start first (throws components_required),
    // then full diagnose shows components with Later. No auto repair.
    await expect
      .poll(() => page.evaluate(() => window.calls.some((c) => c.name === 'desktop_start')))
      .toBe(true);
    await expect(page.locator('#components')).toBeVisible();
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.args?.action === 'prepare')), false);
    await expect(page.locator('#start')).toContainText(fr ? 'Plus tard' : 'Later');
    // Repair shows byte progress (translated, no percent yet for this event).
    await page.locator('#components-install').click();
    await expect(page.locator('#components-status')).toContainText(
      fr ? 'octets re\u00e7us' : 'bytes received',
    );
    // Cancel interrupts and preserves retry.
    await page.locator('#components-cancel').click();
    await expect(page.locator('#components-status')).toContainText(fr ? 'annul\u00e9e' : 'cancelled');
    await expect(page.locator('#components-install')).toBeVisible();
    // Diagnostic error keeps details and retry, no restart, no Studio open.
    await page.locator('#components-install').click();
    await page.evaluate(() =>
      window.finishPrepare({ failure: { component: 'engine', error: 'validation_failed' } }),
    );
    await expect(page.locator('#components-status')).toContainText('validation');
    await expect(page.locator('#components-install')).toBeVisible();
    // Ready repair proposes the single Restart now: no implicit restart.
    await page.locator('#components-install').click();
    await page.evaluate(() => {
      window.phase = 'ready';
      window.readyComponents = {
        engine: {
          status: 'ready',
          version: '0.9.6',
          path: 'C:\\Donn\u00e9es Studio\\engine\\cli.js',
          provenance: 'https://official.example/prime-agent-0.9.6.tgz',
        },
        python: { status: 'ready' },
        bash: { status: 'ready' },
        uv: { status: 'ready', version: '0.8.22' },
      };
      window.finishPrepare({
        ready: true,
        needsRestart: true,
        requiredEngine: '0.9.6',
        components: window.readyComponents,
      });
    });
    await expect(page.locator('#components-status')).toContainText(
      fr ? 'Red\u00e9marrez maintenant' : 'Restart now',
    );
    await expect(page.locator('#components-install')).toBeHidden();
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length), 1);
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.args?.action === 'install')), false);
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.args?.action === 'activate')), false);
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.args?.action === 'apply')), false);
    // Folded details carry explicit paths and provenance (overrides evidence).
    await expect(page.locator('#components-details')).toBeHidden();
    await page.locator('#components-toggle').click();
    await expect(page.locator('#components-details')).toBeVisible();
    await expect(page.locator('#components-detail-list')).toContainText(
      'C:\\Donn\u00e9es Studio\\engine\\cli.js',
    );
    await expect(page.locator('#components-toggle')).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: `.local/components-ui/details-${locale}.png`, fullPage: true });
    await page.locator('#components-toggle').click();
    await page.screenshot({ path: `.local/components-ui/${locale}.png`, fullPage: true });
    // Recovery surface: single confirmed Restart now with agents running.
    await page.goto(url + '/?settings');
    await expect(page.locator('#server-restart')).toBeVisible();
    await expect(page.locator('#server-restart')).toContainText(
      fr ? 'Red\u00e9marrer maintenant' : 'Restart now',
    );
    await page.evaluate(() => {
      window.runs = 1;
    });
    await page.locator('#server-restart').click();
    await expect(page.locator('#restart-confirm')).toBeVisible();
    await page.screenshot({ path: `.local/components-ui/restart-confirm-${locale}.png`, fullPage: true });
    await page.locator('#restart-proceed').click();
    await expect.poll(() => page.evaluate(() => window.restartCalls.length)).toBe(1);
    assert.deepEqual(await page.evaluate(() => window.restartCalls[0].args), {
      force: true,
      cancelCurrent: false,
    });
    await expect(page.locator('#server-agents')).toContainText(fr ? 'utilise maintenant' : 'now using');
    await expect(page.locator('#migration-dialog')).toHaveCount(0);
    await expect(page.locator('#components-apply')).toHaveCount(0);
    // Narrow mobile layout: folded details fit without horizontal overflow.
    await page.setViewportSize({ width: 390, height: 850 });
    await page.locator('#components-toggle').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // Independent restart scenario: fresh shell after the preceding simulated restart.
    await page.goto(url + '/?settings');
    await expect(page.locator('#server-restart')).toBeEnabled();
    // The same dialog must not cancel an operation until explicitly accepted.
    await page.evaluate(() => {
      window.runs = 0;
      window.testOperation = { stage: 'download', terminal: false, cancellable: true };
    });
    await page.locator('#server-restart').click();
    await expect(page.locator('#restart-cancel')).toBeFocused();
    await page.locator('#restart-cancel').click();
    await expect(page.locator('#restart-confirm')).not.toBeVisible();
    assert.equal(await page.evaluate(() => window.restartCalls.length), 0);
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.name === 'desktop_update_cancel')), false);
    await page.locator('#server-restart').click();
    await page.locator('#restart-proceed').click();
    await expect.poll(() => page.evaluate(() => window.restartCalls.length)).toBe(1);
    assert.deepEqual(await page.evaluate(() => window.restartCalls[0].args), {
      force: false,
      cancelCurrent: true,
    });
    await page.evaluate(() => { window.testOperation = null; });
    await page.goto(url + '/?background');
    await expect
      .poll(() => page.evaluate(() => window.calls.some((c) => c.name === 'desktop_start')))
      .toBe(true);
    assert.equal(await page.evaluate(() => window.calls.some((c) => c.args?.action === 'prepare')), false);
    assert.deepEqual(errors, []);
    await context.close();
  }
  for (const locale of ['fr-FR', 'en-US']) {
    const fr = locale.startsWith('fr');
    const context = await browser.newContext({ locale, viewport: { width: 660, height: 850 } });
    await context.addInitScript(() => {
      window.calls = [];
      window.restartCalls = [];
      window.phase = 'initial';
      window.runs = 0;
      const guideComponents = {
        engine: { status: 'ready', version: '0.9.6', path: 'C:\\Guide Studio\\engine\\cli.js' },
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
              if (args.action === 'diagnose') {
                if (window.phase === 'ready')
                  return {
                    ready: true,
                    needsRestart: true,
                    requiredEngine: '0.9.6',
                    components: guideComponents,
                  };
                return {
                  ready: false,
                  needsRestart: true,
                  requiredEngine: '0.9.6',
                  components: { engine: { status: 'missing', path: 'C:\Guide Studio\engine\cli.js' } },
                };
              }
              if (args.action === 'prepare') {
                return new Promise((done) => {
                  window.finishPrepare = done;
                });
              }
              if (args.action === 'install') throw new Error('guide_must_not_auto_install');
              return { ready: false, components: {} };
            }
            if (name === 'desktop_update_status')
              return {
                managed: true,
                running: true,
                activeRuns: window.runs,
                version: '3.9.8',
                canRestart: true,
                restartReason: null,
                operation: null,
              };
            if (name === 'desktop_update_operation') return { operation: null, log: [] };
            if (name === 'desktop_update_cancel') return { operation: null, log: [] };
            if (name === 'desktop_server_restart') {
              window.restartCalls.push({ args });
              return { restarted: true, version: '3.9.9' };
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
    await expect(page.locator('#title')).toContainText(
      fr ? 'Terminer la mise \u00e0 jour' : 'Finish the Studio update',
    );
    await expect(page.locator('#description')).toContainText(fr ? 'si besoin' : 'if needed');
    await expect(page.locator('#components-note')).toContainText('0.9.6');
    await expect(page.locator('#components')).toBeVisible();
    await expect(page.locator('#components-install')).toBeVisible();
    await expect(page.locator('#start')).toContainText(fr ? 'Plus tard' : 'Later');
    assert.equal(
      await page.evaluate(() => window.calls.some((c) => c.args && c.args.action === 'install')),
      false,
    );
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length), 1);
    // Later opens Studio without preparing first.
    await page.locator('#start').click();
    await expect
      .poll(() => page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length))
      .toBe(2);
    const laterStart = await page.evaluate(() =>
      window.calls.filter((c) => c.name === 'desktop_start').at(-1),
    );
    assert.equal(laterStart.args.allowUnconfigured, true);
    // Repair failure is preserved with retry, then ready proposes Restart.
    await page.locator('#components-install').click();
    await page.evaluate(() =>
      window.finishPrepare({ failure: { component: 'engine', error: 'server_validation_failed' } }),
    );
    await expect(page.locator('#components-status')).toContainText(fr ? 'autre version' : 'another version');
    await expect(page.locator('#components-detail-list')).toContainText('Guide Studio');
    await expect(page.locator('#components-install')).toBeVisible();
    await page.screenshot({ path: `.local/components-ui/guide-failed-${locale}.png`, fullPage: true });
    await page.locator('#components-install').click();
    await page.evaluate(() => {
      window.phase = 'ready';
      window.finishPrepare({
        ready: true,
        needsRestart: true,
        requiredEngine: '0.9.6',
        components: window.guideReady,
      });
    });
    await page.evaluate(() => {
      window.guideReady = undefined;
    });
    await expect(page.locator('#components-status')).toContainText(
      fr ? 'Red\u00e9marrez maintenant' : 'Restart now',
    );
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.name === 'desktop_start').length), 2);
    assert.equal(
      await page.evaluate(() => window.calls.some((c) => c.args && c.args.action === 'install')),
      false,
    );
    assert.equal(
      await page.evaluate(() =>
        window.calls.some((c) => c.args && ['activate', 'apply'].includes(c.args.action)),
      ),
      false,
    );
    // Single confirmed restart from the recovery surface, no second activation.
    await page.goto(url + '/?settings');
    await expect(page.locator('#server-restart')).toBeVisible();
    await page.evaluate(() => {
      window.runs = 1;
    });
    await page.locator('#server-restart').click();
    await expect(page.locator('#restart-confirm')).toBeVisible();
    await page.locator('#restart-proceed').click();
    await expect.poll(() => page.evaluate(() => window.restartCalls.length)).toBe(1);
    assert.equal(await page.evaluate(() => window.restartCalls[0].args.force), true);
    assert.equal(
      await page.evaluate(() =>
        window.calls.some((c) => c.args && ['activate', 'apply'].includes(c.args.action)),
      ),
      false,
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    'Components UI passed in FR/EN: first run, repair bytes, cancellation, diagnostic error preserved, ready without implicit restart, folded details with explicit paths, mobile fit, background without repair, update guide repair then single confirmed restart, no migration dialog and no separate activation.',
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
