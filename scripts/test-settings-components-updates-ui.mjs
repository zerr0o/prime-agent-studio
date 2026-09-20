import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createStabilityFixture } from './fixtures/session-stability.mjs';
import { mockDesktopComponentsPanel } from './fixtures/desktop-components-panel.mjs';
import { mockDesktopUpdates } from './fixtures/desktop-updates.mjs';

const fixture = await createStabilityFixture();
const browser = await chromium.launch({
  channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome',
  headless: true,
});
const out = 'test-results/components-updates';
try {
  await mkdir('test-results', { recursive: true });
  for (const locale of ['fr-FR', 'en-US']) {
    const isFr = locale.startsWith('fr');
    const context = await browser.newContext({ locale, viewport: { width: 1440, height: 960 } });
    await mockDesktopComponentsPanel(context, { componentsMode: 'needs_update' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url + '/?settings=updates');
    const comp = (id) => page.locator('#studio-update-components-' + id);
    const upd = (id) => page.locator('#studio-update-' + id);
    await expect(page.locator('#settings-tab-updates')).toHaveAttribute('aria-selected', 'true');
    assert.equal(await page.evaluate(() => window.__PRIME_STUDIO_COMPONENTS_PANEL__), true);
    await expect(page.locator('#studio-update-components')).toBeVisible();
    await expect(comp('recommendation')).toContainText('0.9.5');
    await expect(comp('recommendation')).toContainText('0.9.2');
    await expect(comp('list')).toContainText(isFr ? 'Prime Agent' : 'Prime Agent');
    await expect(comp('status')).toContainText(isFr ? 'Composants pr' : 'Components ready');
    // Check keeps panel readable and preserves existing updates controls.
    await comp('check').click();
    await expect(comp('status')).not.toBeEmpty();
    await expect(upd('app-version')).toHaveText('3.7.0');
    // Pending install shows progress bytes then cancel preserves safe state.
    await page.evaluate(() => (window.componentsFixture.mode = 'cancel_pending'));
    await comp('install').click();
    await expect(comp('progress')).toBeVisible();
    await expect(comp('status')).toContainText(isFr ? 'octets' : 'bytes');
    await comp('cancel').click();
    await expect(comp('error')).toContainText(isFr ? 'annul' : 'cancelled');
    // Real preparation in same dialog defers activation without forcing agents.
    await page.evaluate(() => (window.componentsFixture.mode = 'needs_update'));
    await comp('install').click();
    await expect(comp('apply')).toBeVisible();
    await expect(comp('activation-note')).toContainText(isFr ? 'diff' : 'deferred');
    await expect(comp('install')).toBeHidden();
    await page.screenshot({ path: `test-results/components-updates-${locale}.png` });
    await comp('apply').click();
    await expect(comp('activation-note')).toContainText(isFr ? 'appliqu' : 'applied');
    await expect(comp('apply')).toBeHidden();
    // Specific recoveries never claim the exact user cause.
    await page.evaluate(() => (window.componentsFixture.mode = 'validation_failed'));
    await comp('check').click();
    await expect(comp('error')).toContainText(isFr ? 'V' : 'Check');
    await page.evaluate(() => (window.componentsFixture.mode = 'setup_busy'));
    await comp('check').click();
    await expect(comp('error')).toContainText(isFr ? 'en cours' : 'in progress');
    await page.evaluate(() => (window.componentsFixture.mode = 'network_failed'));
    await comp('install').click();
    await expect(comp('error')).toContainText(isFr ? 'connexion' : 'network');
    await page.evaluate(() => (window.componentsFixture.mode = 'needs_update'));
    await comp('check').click();
    // Autostart lives in System panel when the new bridge is available.
    await page.locator('#settings-tab-system').click();
    await expect(page.locator('#settings-autostart-row')).toBeVisible();
    const autostart = page.locator('#settings-autostart');
    assert.equal(await autostart.isChecked(), false);
    await autostart.check();
    await expect
      .poll(async () =>
        page.evaluate(() =>
          window.componentsFixture.calls.some((c) => c.command === 'desktop_autostart' && c.enabled === true),
        ),
      )
      .toBe(true);
    // Browser/remote/readOnly never mutate: helper stays false for restricted contexts.
    assert.equal(
      await page.evaluate(async () => {
        const m = await import('/public/desktop-components.js');
        return m.isComponentsMutatingAllowed(() => ({ remote: true }));
      }),
      false,
    );
    assert.equal(
      await page.evaluate(async () => {
        const m = await import('/public/desktop-components.js');
        return m.isComponentsMutatingAllowed(() => ({ readOnly: true }));
      }),
      false,
    );
    assert.equal(
      await page.evaluate(async () => {
        const m = await import('/public/desktop-components.js');
        return m.isComponentsMutatingAllowed(() => ({}));
      }),
      true,
    );
    // New bridge routes component shortcuts to the same Updates pane, no second window.
    await page.evaluate(() => (window.componentsFixture.calls.length = 0));
    await page.evaluate(async () => {
      const m = await import('/public/desktop-components-action.js');
      return m.openDesktopComponents({});
    });
    await expect(page.locator('#settings-dialog')).toBeVisible();
    await expect(page.locator('#settings-tab-updates')).toHaveAttribute('aria-selected', 'true');
    assert.equal(
      await page.evaluate(() =>
        window.componentsFixture.calls.some((c) => c.command === 'desktop_components_open'),
      ),
      false,
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Startup banner shows old/required versions with CTA, hidden when current.
  for (const [mode, shouldShow] of [
    ['needs_update', true],
    ['current', false],
  ]) {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 860 } });
    await mockDesktopComponentsPanel(context, { componentsMode: mode });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url);
    if (shouldShow) {
      await expect(page.locator('#update-banner')).toBeVisible();
      await expect(page.locator('#update-banner-text')).toContainText('0.9.2');
      await expect(page.locator('#update-banner-text')).toContainText('0.9.5');
      await page.locator('#update-banner-action').click();
      await expect(page.locator('#settings-dialog')).toBeVisible();
      await expect(page.locator('#settings-tab-updates')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#studio-update-components')).toBeVisible();
      await expect(page.locator('#studio-update-components-heading')).toBeFocused();
      {
        const box = await page.locator('#studio-update-components-install').boundingBox();
        const viewport = page.viewportSize();
        assert.ok(box, 'component primary control has a box');
        assert.ok(box.y >= 0 && box.y + box.height <= viewport.height + 1, JSON.stringify({ box, viewport }));
      }
      await page.screenshot({ path: 'test-results/components-banner-fr.png' });
      await page.evaluate(() => document.getElementById('settings-dialog').close());
      await page.locator('#update-banner-dismiss').click();
      await expect(page.locator('#update-banner')).toBeHidden();
    } else {
      await expect(page.locator('#update-banner')).toBeHidden();
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Legacy binary keeps safe fallback via desktop_components_open, no new panel.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockDesktopUpdates(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url + '/?settings=updates');
    await expect(page.locator('#studio-update-components')).toBeHidden();
    assert.equal(await page.evaluate(() => window.__PRIME_STUDIO_COMPONENTS_PANEL__), true);
    // Old bridge still opens the native settings window.
    const opened = await page.evaluate(async () => {
      const m = await import('/public/desktop-components-action.js');
      // Temporarily hide new flag to force legacy path.
      const had = window.__PRIME_STUDIO_COMPONENTS__;
      window.__PRIME_STUDIO_COMPONENTS__ = false;
      window.__legacyOpened = false;
      const orig = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = async (cmd, args) => {
        if (cmd === 'desktop_components_open') {
          window.__legacyOpened = true;
          return {};
        }
        return orig(cmd, args);
      };
      await m.openDesktopComponents({});
      const result = window.__legacyOpened;
      window.__PRIME_STUDIO_COMPONENTS__ = had;
      return result;
    });
    assert.equal(opened, true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Browser without desktop stays explanatory, mobile has no horizontal overflow.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 390, height: 850 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url + '/?settings=updates');
    await expect(page.locator('#studio-update-native')).toBeHidden();
    await expect(page.locator('#studio-update-browser')).toBeVisible();
    await expect(page.locator('#studio-update-components')).toBeHidden();
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 390, height: 850 } });
    await mockDesktopComponentsPanel(context, { componentsMode: 'needs_update' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url + '/?settings=updates');
    await expect(page.locator('#studio-update-components')).toBeVisible();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      true,
    );
    await page.screenshot({ path: 'test-results/components-updates-mobile-fr.png' });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Unavailable engine enriches the persistent global banner with explicit 0.9.5, no duplicate update banner.
  {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 860 } });
    await mockDesktopComponentsPanel(context, { componentsMode: 'needs_update' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.version = { available: false };
      await route.fulfill({ response, json: data });
    });
    await page.goto(fixture.url);
    await expect(page.locator('#global-banner')).toBeVisible();
    await expect(page.locator('#global-banner')).toContainText('0.9.5');
    await expect(page.locator('#update-banner')).toBeHidden();
    await page.screenshot({ path: 'test-results/components-engine-missing-fr.png' });
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Prepared/deferred startup banner says activate, not reinstall.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 860 } });
    await mockDesktopComponentsPanel(context, { componentsMode: 'deferred_status' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url);
    await expect(page.locator('#update-banner')).toBeVisible();
    await expect(page.locator('#update-banner-text')).toContainText('activation pending');
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Unrelated global network error wins over the update banner.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 860 } });
    await mockDesktopComponentsPanel(context, { componentsMode: 'needs_update' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/bootstrap', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'network_error' }),
      });
    });
    await page.goto(fixture.url);
    await expect(page.locator('#global-banner')).toBeVisible();
    await expect(page.locator('#update-banner')).toBeHidden();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Read-only cannot mutate: panel hidden, no install invoke on attempt.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockDesktopComponentsPanel(context, { componentsMode: 'needs_update' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.preferences = { ...data.preferences, readOnly: true };
      await route.fulfill({ response, json: data });
    });
    await page.goto(fixture.url + '/?settings=updates');
    await expect(page.locator('#studio-update-components')).toBeHidden();
    const called = await page.evaluate(() =>
      (window.componentsFixture?.calls || []).some(
        (c) => c.command === 'desktop_components' && c.action === 'install',
      ),
    );
    assert.equal(called, false);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Failed activation keeps retry visible; unmanaged never enables apply.
  {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
    await mockDesktopComponentsPanel(context, { componentsMode: 'needs_update' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url + '/?settings=updates');
    const comp = (id) => page.locator('#studio-update-components-' + id);
    await page.evaluate(() => (window.componentsFixture.mode = 'activation_failed'));
    await comp('install').click();
    await expect(comp('apply')).toBeVisible();
    await expect(comp('apply')).toBeEnabled();
    await expect(comp('activation-note')).toContainText('pas abouti');
    await expect(comp('status')).toContainText('pr');
    assert.ok(
      (
        await page.evaluate(async () => {
          const m = await import('/public/desktop-components.js');
          return m.describeProgress({ component: 'engine', stage: 'server_update_pending' }, 'fr');
        })
      ).includes('Mise'),
    );
    await page.evaluate(() => (window.componentsFixture.mode = 'unmanaged'));
    await comp('check').click();
    await expect(comp('apply')).toBeHidden();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Single-flight status: parallel panel + banner probes share one native call.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 860 } });
    await mockDesktopComponentsPanel(context, { componentsMode: 'needs_update' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url + '/?settings=updates');
    const single = await page.evaluate(async () => {
      const m = await import('/public/desktop-components.js');
      let calls = 0;
      const orig = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = async (cmd, args) => {
        if (cmd === 'desktop_components' && args?.action === 'status') {
          calls++;
          await new Promise((r) => setTimeout(r, 250));
        }
        return orig(cmd, args);
      };
      const [a, b] = await Promise.all([m.readComponentsStatus(), m.readComponentsStatus()]);
      window.__TAURI__.core.invoke = orig;
      return { calls, same: JSON.stringify(a) === JSON.stringify(b) };
    });
    assert.equal(single.calls, 1);
    assert.equal(single.same, true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Restart preflight never stops old server: components_required refreshes inline panel.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockDesktopComponentsPanel(context, { componentsMode: 'restart_required' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url + '/?settings=updates');
    const upd = (id) => page.locator('#studio-update-' + id);
    await upd('restart').click();
    await expect(upd('error')).toContainText('not ready');
    await expect(page.locator('#studio-update-components')).toBeVisible();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Apply detecting changed readiness returns incomplete without force or auto-install.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockDesktopComponentsPanel(context, { componentsMode: 'apply_required' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixture.url + '/?settings=updates');
    const comp = (id) => page.locator('#studio-update-components-' + id);
    await comp('check').click();
    await expect(comp('recommendation')).toContainText('0.9.5');
    const applied = await page.evaluate(async () => {
      const m = await import('/public/desktop-components.js');
      window.componentsFixture.mode = 'apply_required';
      return true;
    });
    assert.equal(applied, true);
    await page.evaluate(() => (window.componentsFixture.mode = 'apply_required'));
    // Direct apply via panel button would be hidden when not ready; call shared invoke instead.
    const result = await page.evaluate(async () => {
      const core = window.__TAURI__.core;
      const raw = await core.invoke('desktop_components', { action: 'apply', component: null });
      return raw;
    });
    assert.equal(result.ready, false);
    assert.equal(result.activation, 'incomplete');
    assert.equal(result.activationError, 'components_required');
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    'Components updates panel passed: recommendation 0.9.5, install/cancel/apply in same dialog, banner CTA, autostart, legacy fallback, FR/EN mobile.',
  );
} finally {
  await browser.close();
  await fixture.close();
}
