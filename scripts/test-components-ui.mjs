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
  console.log(
    'PASS: FR/EN first run, settings, explicit install, bytes, cancellation, deferred activation, background without installation.',
  );
} finally {
  await browser.close();
  server.close();
}
