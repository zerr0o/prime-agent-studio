import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
// Single-window fallback shell: controlled snapshots, no real app, no live Studio.
const server = createServer(async (req, res) => {
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
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome',
  headless: true,
});
const VIEWPORTS = {
  desktop: { width: 1440, height: 960 },
  mobile: { width: 390, height: 844 },
};
const TEXT = {
  'fr-FR': { update: 'Mettre \u00e0 jour Studio', repair: 'R\u00e9parer Studio', restart: 'Red\u00e9marrer maintenant', back: 'Retour au Studio' },
  'en-US': { update: 'Update Studio', repair: 'Repair Studio', restart: 'Restart now', back: 'Back to Studio' },
};
try {
  for (const locale of ['fr-FR', 'en-US']) {
    for (const [device, viewport] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({ locale, viewport });
      await context.addInitScript(() => {
        window.calls = [];
        window.mode = 'available';
        window.__TAURI__ = {
          event: { listen: async () => {} },
          core: {
            Channel: class {},
            invoke: async (command, args) => {
              window.calls.push(command);
              if (command === 'desktop_state')
                return { version: '2.8.0', started: false, imported: true, autostart: false };
              if (command === 'desktop_update_status')
                return { managed: true, running: true, version: '2.8.0', activeRuns: 1, canRestart: true, restartReason: null, ownership: 'managed', operation: null };
              if (command === 'desktop_update_operation') return { operation: null, log: [] };
              if (command === 'desktop_update_cancel') return { operation: null, log: [] };
              if (command === 'desktop_components') return { cancelled: true };
              if (command === 'desktop_components_cancel') return {};
              if (command === 'desktop_update_check') {
                if (window.mode === 'offline') throw 'check_failed';
                return {
                  available: window.mode !== 'current',
                  version: '2.9.0',
                  notes: '<img src=x onerror=alert(1)>',
                };
              }
              if (command === 'desktop_update_install') {
                if (window.mode === 'failed') throw 'download_failed';
                window.updateChannel = args.onEvent;
                args.onEvent.onmessage({ stage: 'downloading', percent: 42 });
                return new Promise(() => {});
              }
            },
          },
        };
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const url = `http://127.0.0.1:${server.address().port}`;
      const t = TEXT[locale];
      await page.goto(url);
      await expect(page.locator('#updates')).toBeHidden();
      await page.goto(url + '/?settings');
      await expect(page.locator('#app-version')).toHaveText('v2.8.0');
      // New single-window DOM: 3 actions + back, folded details, no migration,
      // no separate activation, no restart checkbox, single merged status.
      await expect(page.locator('#update-check')).toBeVisible();
      await expect(page.locator('#update-install')).toBeHidden();
      await expect(page.locator('#update-cancel')).toBeHidden();
      await expect(page.locator('#server-restart')).toBeVisible();
      await expect(page.locator('#server-restart')).toContainText(t.restart);
      await expect(page.locator('#back-studio')).toBeVisible();
      await expect(page.locator('#back-studio')).toContainText(t.back);
      await expect(page.locator('#components-install')).toContainText(t.repair);
      await expect(page.locator('#components-details')).toBeHidden();
      await expect(page.locator('#update-notes')).toBeHidden();
      await expect(page.locator('#migration-dialog')).toHaveCount(0);
      await expect(page.locator('#components-apply')).toHaveCount(0);
      await expect(page.locator('#update-restart-after')).toHaveCount(0);
      await page.screenshot({ path: `test-results/desktop-updates-${locale}-${device}.png`, fullPage: true });
      // Journey: check reveals Update (translated), no premature install, safe notes.
      await page.locator('#update-check').click();
      await expect(page.locator('#update-install')).toBeVisible();
      await expect(page.locator('#update-install')).toContainText(t.update);
      assert.equal((await page.evaluate(() => window.calls)).includes('desktop_update_install'), false);
      await expect(page.locator('#update-notes-body img')).toHaveCount(0);
      await page.evaluate(() => {
        window.mode = 'current';
      });
      await page.locator('#update-check').click();
      await expect(page.locator('#update-install')).toBeHidden();
      await page.evaluate(() => {
        window.mode = 'offline';
      });
      await page.locator('#update-check').click();
      await expect(page.locator('#update-status')).toHaveClass('failed');
      await expect(page.locator('#update-install')).toBeHidden();
      await page.evaluate(() => {
        window.mode = 'failed';
      });
      await page.locator('#update-check').click();
      await page.locator('#update-install').click();
      await expect(page.locator('#update-status')).toHaveClass('failed');
      await expect(page.locator('#update-install')).toBeEnabled();
      await page.evaluate(() => {
        window.mode = 'available';
      });
      await page.locator('#update-install').click();
      await expect(page.locator('#update-progress')).toHaveAttribute('value', '42');
      await page.screenshot({ path: `test-results/desktop-updates-progress-${locale}-${device}.png`, fullPage: true });
      await expect(page.locator('#update-check')).toBeDisabled();
      await expect(page.locator('#update-install')).toBeDisabled();
      await page.evaluate(() => window.updateChannel.onmessage({ stage: 'verifying' }));
      await expect(page.locator('#update-progress')).not.toHaveAttribute('value');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`desktop updates ${locale} ${device}: 3 actions + back, folded details, update journey OK`);
    }
  }
  console.log(
    'Updater UI passed in FR/EN x desktop/mobile: 3 actions + back, translated Update/Repair/Restart, safe notes, no update, offline, failure retry, progress and duplicate prevention.',
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
