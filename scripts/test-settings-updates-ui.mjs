import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createStabilityFixture } from './fixtures/session-stability.mjs';
import { mockDesktopUpdates } from './fixtures/desktop-updates.mjs';

const TITLES = {
  install: { 'fr-FR': 'Mettre à jour Studio ?', 'en-US': 'Update Studio?' },
  restart: { 'fr-FR': 'Redémarrer complètement le serveur ?', 'en-US': 'Fully restart the server?' },
  quit: { 'fr-FR': 'Arrêter le serveur et quitter Studio ?', 'en-US': 'Stop the server and quit Studio?' },
};

const fixture = await createStabilityFixture();
const browser = await chromium.launch({
  channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome',
  headless: true,
});
const calls = (page, command) =>
  page.evaluate(
    (command) => window.updateFixture.calls.filter((c) => c.command === command),
    command,
  );
// Mirror a backend event into both the live channel and the polled snapshot.
const emit = (page, event) =>
  page.evaluate((event) => {
    const now = Date.now();
    const op = {
      id: 'op-install',
      kind: 'install',
      startedAt: now - 2000,
      updatedAt: now,
      done: false,
      terminal: false,
      ...event,
      updatedAt: now,
    };
    window.updateFixture.operation = op;
    window.updateFixture.channel?.onmessage({ ...event });
  }, event);
const setOperation = (page, operation) =>
  page.evaluate((operation) => {
    window.updateFixture.operation = operation;
  }, operation);
const openPanel = async (page, url) => {
  await page.goto(url + '/?settings=updates');
};
const reopenPanel = async (page) => {
  await page.evaluate(() => document.getElementById('settings-dialog').close());
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-updates').click();
};
// Isolated prerelease adapter with exact IPC echo. Never runs a real installer.
const mockPrereleaseUpdates = async (context, seed = {}) => {
  await context.addInitScript((seed) => {
    window.__PRIME_STUDIO_DESKTOP__ = true;
    window.__PRIME_STUDIO_COMPONENTS__ = true;
    window.updateFixture = {
      activeRuns: seed.activeRuns ?? 2,
      ownership: seed.ownership ?? 'managed',
      running: seed.running ?? true,
      mode: seed.mode ?? 'available',
      operation: seed.operation ?? null,
      componentsReady: seed.componentsReady ?? true,
      oldNative: seed.oldNative === true,
      checkChannel: null,
      calls: [],
      channel: null,
    };
    const snapshot = () => {
      const f = window.updateFixture;
      const managed = f.ownership === 'managed';
      const can = f.running && (f.ownership === 'managed' || f.ownership === 'recoverable');
      return {
        appVersion: '2.9.3',
        version: '2.9.2',
        running: f.running,
        managed,
        ownership: f.running ? f.ownership : 'absent',
        source: !f.running ? 'none' : managed ? 'owner-file' : 'os-verified',
        pid: f.running ? 26480 : null,
        canRestart: can,
        restartReason: can ? null : 'server_not_managed',
        canStop: can,
        stopReason: can ? null : 'server_not_managed',
        activeRuns: f.activeRuns,
      };
    };
    const downloadingSnapshot = () => {
      const now = Date.now();
      return {
        id: 'op-install',
        kind: 'install',
        stage: 'downloading',
        startedAt: now - 2000,
        updatedAt: now,
        receivedBytes: 420,
        totalBytes: 1000,
        percent: 42,
        detail: '',
        cancellable: true,
        done: false,
        terminal: false,
      };
    };
    window.__TAURI__ = {
      core: {
        Channel: class {},
        invoke: async (command, args) => {
          const f = window.updateFixture;
          f.calls.push({
            command,
            force: args?.force,
            restartServer: args?.restartServer,
            cancelCurrent: args?.cancelCurrent,
            version: args?.version,
            action: args?.action,
            includePrereleases: args?.includePrereleases,
          });
          if (command === 'desktop_update_status') return snapshot();
          if (command === 'desktop_update_operation') return { operation: f.operation };
          if (command === 'desktop_components') {
            const action = args?.action;
            if (action === 'status') {
              if (f.componentsReady)
                return { ready: true, components: { engine: { version: '9', status: 'ready' } } };
              return { ready: false, components: { engine: { version: '9', status: 'missing' } } };
            }
            f.componentsReady = true;
            return { ready: true, components: { engine: { version: '9', status: 'ready' } } };
          }
          if (command === 'desktop_components_cancel') return true;
          if (command === 'desktop_update_check') {
            if (
              f.mode === 'prerelease_metadata_failed' ||
              f.mode === 'prerelease_manifest_failed' ||
              f.mode === 'prerelease_version_mismatch'
            )
              throw f.mode;
            if (f.mode === 'offline') throw 'check_failed';
            if (f.oldNative) {
              const available = f.mode !== 'current';
              return { available, version: '2.9.4', notes: available ? 'Stable notes.' : '' };
            }
            const want = args?.includePrereleases === true;
            const available = f.mode !== 'current';
            f.checkChannel = want;
            return {
              available,
              version: want ? '3.10.0-beta.4' : '2.9.4',
              notes: available ? (want ? 'Beta notes experimental.' : 'Stable notes.') : '',
              includePrereleases: want,
            };
          }
          if (command === 'desktop_update_install') {
            if (f.mode === 'invalid') throw 'download_failed';
            if (f.mode === 'channel-changed') throw 'update_channel_changed';
            const want = args?.includePrereleases === true;
            if (!f.oldNative && f.checkChannel !== null && want !== f.checkChannel)
              throw 'update_channel_changed';
            f.channel = args.onEvent;
            f.operation = downloadingSnapshot();
            try {
              args.onEvent.onmessage({ ...downloadingSnapshot() });
            } catch {}
            return new Promise(() => {});
          }
          if (command === 'desktop_server_restart') {
            f.operation = null;
            return { restarted: true, version: '2.9.3' };
          }
          if (command === 'desktop_quit') {
            if (!f.running) return { stopped: false, reason: 'already-stopped' };
            f.running = false;
            f.operation = null;
            return { stopped: true };
          }
          if (command === 'desktop_update_cancel') return true;
          throw new Error('Unexpected fixture command: ' + command);
        },
      },
    };
  }, seed);
};
try {
  await mkdir('test-results', { recursive: true });
  for (const locale of ['fr-FR', 'en-US']) {
    // Main flow: versions, 3 buttons, details, confirmations, download persistence.
    const context = await browser.newContext({ locale, viewport: { width: 1440, height: 960 } });
    await mockDesktopUpdates(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await expect(page.locator('#settings-tab-updates')).toHaveAttribute('aria-selected', 'true');
    await expect($('app-version')).toHaveText('2.9.3');
    await expect($('server-version')).toHaveText('2.9.2');
    await expect($('check')).toBeVisible();
    await expect($('restart')).toBeVisible();
    await expect($('install')).toBeHidden();
    await expect($('repair')).toBeHidden();
    await expect($('details')).not.toHaveAttribute('open');
    // Check reveals update; notes are sanitized markdown, never raw HTML.
    await $('check').click();
    await expect($('install')).toBeVisible();
    await expect($('notes-body').locator('img')).toHaveCount(0);
    await expect($('notes-body')).toContainText('Amélioration');
    await page.screenshot({ path: `test-results/settings-updates-${locale}.png` });
    // Update always confirms, even with agents; cancel never installs.
    await $('install').click();
    await expect($('confirm')).toBeVisible();
    await expect($('confirm-title')).toHaveText(TITLES.install[locale]);
    await expect($('cancel')).toBeFocused();
    await page.screenshot({ path: `test-results/settings-updates-warning-${locale}.png` });
    await $('cancel').click();
    assert.equal((await calls(page, 'desktop_update_install')).length, 0);
    // Proceed starts the download; restart stays available during download.
    await $('install').click();
    await $('proceed').click();
    await expect($('progress')).toHaveAttribute('value', '42');
    await expect($('check')).toBeDisabled();
    assert.equal((await calls(page, 'desktop_update_install')).at(-1).restartServer, true);
    await expect($('restart')).toBeEnabled();
    await $('restart').click();
    await expect($('confirm-title')).toHaveText(TITLES.restart[locale]);
    await page.keyboard.press('Escape');
    assert.equal((await calls(page, 'desktop_server_restart')).length, 0);
    // Closing and reopening the panel during download keeps the progress.
    await reopenPanel(page);
    await expect($('progress')).toHaveAttribute('value', '42');
    // Verifying drops the determinate bar; installing locks restart and cancel.
    await emit(page, { stage: 'verifying' });
    await expect($('progress')).not.toHaveAttribute('value');
    await emit(page, { stage: 'installing', cancellable: false });
    await expect($('restart')).toBeDisabled();
    await expect($('stop-operation')).toBeHidden();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Cancel during download: visible, single call, then disabled.
  {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
    await mockDesktopUpdates(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await $('check').click();
    await $('install').click();
    await $('proceed').click();
    await expect($('progress')).toHaveAttribute('value', '42');
    await expect($('stop-operation')).toBeVisible();
    await $('stop-operation').click();
    assert.equal((await calls(page, 'desktop_update_cancel')).length, 1);
    await expect($('stop-operation')).toBeDisabled();
    const now = Date.now();
    await setOperation(page, {
      id: 'op-install', kind: 'install', stage: 'cancelled', startedAt: now - 3000,
      updatedAt: now, receivedBytes: 420, totalBytes: 1000, percent: 42, cancellable: false,
      done: false, terminal: false,
    });
    await expect($('stop-operation')).toBeHidden();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Bytes with known total, then unknown total, via polled snapshots only.
  {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
    await mockDesktopUpdates(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    const now = Date.now();
    await setOperation(page, {
      id: 'op-dl', kind: 'install', stage: 'downloading', startedAt: now - 2000,
      updatedAt: Date.now(), receivedBytes: 420, totalBytes: 1000, percent: 42,
      cancellable: true, done: false, terminal: false,
    });
    await expect($('progress')).toHaveAttribute('value', '42');
    await expect($('progress-detail')).not.toBeEmpty();
    await setOperation(page, {
      id: 'op-dl', kind: 'install', stage: 'downloading', startedAt: now - 2000,
      updatedAt: Date.now(), receivedBytes: 420, cancellable: true, done: false, terminal: false,
    });
    await expect($('progress')).not.toHaveAttribute('value');
    await expect($('progress-detail')).not.toBeEmpty();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Error retry keeps the previous version for retry after network failure.
  {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
    await mockDesktopUpdates(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await page.evaluate(() => {
      window.updateFixture.mode = 'invalid';
    });
    await $('check').click();
    await $('install').click();
    await $('proceed').click();
    await expect($('error')).toBeVisible();
    await expect($('install')).toBeEnabled();
    await page.evaluate(() => {
      window.updateFixture.mode = 'available';
    });
    await $('check').click();
    await expect($('install')).toBeVisible();
    await page.evaluate(() => {
      window.updateFixture.mode = 'offline';
    });
    await $('check').click();
    await expect($('error')).toBeVisible();
    await expect($('install')).toBeHidden();
    await expect($('notes')).toBeHidden();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Restart race, idle restart confirmation, quit cancel and force.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockDesktopUpdates(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    const restarts = () => calls(page, 'desktop_server_restart');
    const quits = () => calls(page, 'desktop_quit');
    await openPanel(page, fixture.url);
    await expect($('restart')).toBeVisible();
    await page.evaluate(() => {
      window.updateFixture.mode = 'race';
    });
    await $('restart').click();
    await expect($('confirm')).toBeVisible();
    await $('proceed').click();
    await expect($('error')).toBeVisible();
    // Idle restart still confirms; cancel first, then proceed without force.
    await page.evaluate(() => {
      window.updateFixture.mode = 'available';
      window.updateFixture.activeRuns = 0;
    });
    const beforeIdle = (await restarts()).length;
    await $('restart').click();
    await expect($('confirm-title')).toHaveText(TITLES.restart['en-US']);
    await $('cancel').click();
    assert.equal((await restarts()).length, beforeIdle);
    await $('restart').click();
    await $('proceed').click();
    await expect.poll(async () => (await restarts()).length).toBe(beforeIdle + 1);
    assert.equal((await restarts()).at(-1).force, false);
    // Idle quit needs no confirmation and carries no force.
    await page.evaluate(() => {
      window.updateFixture.operation = null;
    });
    await page.evaluate(() => window.dispatchEvent(new Event('studio:quit-request')));
    await expect.poll(async () => (await quits()).length).toBe(1);
    assert.equal((await quits())[0].force, false);
    assert.equal(await $('confirm').isVisible(), false);
    // Quit with agents confirms; cancel then force.
    await page.evaluate(() => {
      window.updateFixture.running = true;
      window.updateFixture.activeRuns = 2;
      window.updateFixture.mode = 'available';
    });
    const quitAndConfirm = () =>
      expect.poll(async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('studio:quit-request')));
        return await $('confirm').isVisible();
      }).toBe(true);
    await quitAndConfirm();
    await expect($('confirm-title')).toHaveText(TITLES.quit['en-US']);
    await $('cancel').click();
    assert.equal((await quits()).length, 1);
    await quitAndConfirm();
    await $('proceed').click();
    await expect.poll(async () => (await quits()).length).toBe(2);
    assert.equal((await quits())[1].force, true);
    // Already-stopped quit is a success for the shell: no error shown.
    await page.evaluate(() => {
      window.updateFixture.running = false;
      window.updateFixture.activeRuns = 0;
      window.updateFixture.mode = 'available';
    });
    await page.evaluate(() => window.dispatchEvent(new Event('studio:quit-request')));
    await expect.poll(async () => (await quits()).length).toBe(3);
    await expect($('error')).toBeHidden();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Central proof: confirmed restart during download supersedes the install.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockDesktopUpdates(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    const mutating = () =>
      page.evaluate(() =>
        window.updateFixture.calls.filter((c) =>
          ['desktop_update_install', 'desktop_server_restart', 'desktop_quit', 'desktop_update_check'].includes(c.command),
        ).length,
      );
    const opPolls = () =>
      page.evaluate(() => window.updateFixture.calls.filter((c) => c.command === 'desktop_update_operation').length);
    await openPanel(page, fixture.url);
    await $('check').click();
    await $('install').click();
    await $('proceed').click();
    await expect($('progress')).toHaveAttribute('value', '42');
    await page.evaluate(() => {
      window.updateFixture.mode = 'hang-restart';
    });
    await $('restart').click();
    await expect($('confirm-title')).toHaveText(TITLES.restart['en-US']);
    await $('proceed').click();
    await expect.poll(async () => (await calls(page, 'desktop_server_restart')).length).toBe(1);
    assert.equal((await calls(page, 'desktop_server_restart'))[0].cancelCurrent, true);
    // The superseded install settles late: no stale error, busy kept, no new command.
    const before = await mutating();
    const pollsBefore = await opPolls();
    await page.evaluate(() => window.updateFixture.rejectInstall('download_failed'));
    await expect.poll(opPolls, { timeout: 8000 }).toBeGreaterThan(pollsBefore);
    await expect($('error')).toBeHidden();
    await expect($('native')).toHaveAttribute('aria-busy', 'true');
    assert.equal(await mutating(), before);
    await page.evaluate(() => window.updateFixture.resolveRestart({ restarted: true, version: '2.9.3' }));
    await expect($('native')).toHaveAttribute('aria-busy', 'false');
    await expect($('error')).toBeHidden();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Cancelled prepare then restart: stale prepare settlement never fails.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockDesktopUpdates(context, { componentsReady: false });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await expect($('repair')).toBeVisible();
    await page.evaluate(() => {
      window.updateFixture.prepareHang = true;
    });
    await $('repair').click();
    await expect($('native')).toHaveAttribute('aria-busy', 'true');
    await $('restart').click();
    await expect($('confirm-title')).toHaveText(TITLES.restart['en-US']);
    await $('proceed').click();
    await expect.poll(async () => (await calls(page, 'desktop_server_restart')).length).toBe(1);
    assert.equal((await calls(page, 'desktop_server_restart'))[0].cancelCurrent, true);
    await page.evaluate(() => window.updateFixture.resolvePrepare({ ready: true, components: {} }));
    await expect($('error')).toBeHidden();
    await expect($('native')).toHaveAttribute('aria-busy', 'false');
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Quit during the noncancellable handoff is refused; failed stop never claims closure.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockDesktopUpdates(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await $('check').click();
    await $('install').click();
    await $('proceed').click();
    await expect($('progress')).toHaveAttribute('value', '42');
    await emit(page, { stage: 'installing', cancellable: false });
    await page.evaluate(() => window.dispatchEvent(new Event('studio:quit-request')));
    await expect($('error')).toBeVisible();
    assert.equal((await calls(page, 'desktop_quit')).length, 0);
    assert.deepEqual(errors, []);
    await context.close();
    const failed = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockDesktopUpdates(failed, { activeRuns: 0 });
    const stopPage = await failed.newPage();
    const stopErrors = [];
    stopPage.on('pageerror', (error) => stopErrors.push(error.message));
    const $$ = (id) => stopPage.locator('#studio-update-' + id);
    await openPanel(stopPage, fixture.url);
    await stopPage.evaluate(() => {
      window.updateFixture.mode = 'quit-fail';
    });
    await stopPage.evaluate(() => window.dispatchEvent(new Event('studio:quit-request')));
    await expect($$('error')).toBeVisible();
    assert.equal((await calls(stopPage, 'desktop_quit')).length, 1);
    assert.deepEqual(stopErrors, []);
    await failed.close();
  }
  // Ownership: recoverable stays controllable, foreign never kills.
  {
    const recoverable = await browser.newContext({ locale: 'en-US' });
    await mockDesktopUpdates(recoverable, { ownership: 'recoverable', activeRuns: 0 });
    const page = await recoverable.newPage();
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await expect($('provenance')).toContainText('26480');
    await expect($('restart')).toBeEnabled();
    await page.screenshot({ path: 'test-results/settings-updates-recoverable-en.png' });
    await recoverable.close();
    const foreign = await browser.newContext({ locale: 'en-US' });
    await mockDesktopUpdates(foreign, { ownership: 'foreign', activeRuns: 0 });
    const stranger = await foreign.newPage();
    const $$ = (id) => stranger.locator('#studio-update-' + id);
    await openPanel(stranger, fixture.url);
    await expect($$('restart')).toBeDisabled();
    assert.equal(
      await stranger.evaluate(() => window.updateFixture.calls.filter((c) => c.command === 'desktop_server_restart').length),
      0,
    );
    await foreign.close();
  }
  // Repair appears only when components need it.
  {
    const context = await browser.newContext({ locale: 'fr-FR' });
    await mockDesktopUpdates(context, { componentsReady: false });
    const page = await context.newPage();
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await expect($('repair')).toBeVisible();
    await $('repair').click();
    await expect($('repair')).toBeHidden();
    await context.close();
  }
  // Prerelease opt-in: default off, explicit channel, persistence, stale clear, busy guards, old native fallback.
  for (const locale of ['fr-FR', 'en-US']) {
    const context = await browser.newContext({ locale, viewport: { width: 1440, height: 960 } });
    await mockPrereleaseUpdates(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await expect($('native')).toBeVisible();
    await expect($('prereleases')).toBeVisible();
    await expect($('prereleases')).not.toBeChecked();
    await expect($('prereleases')).toBeEnabled();
    await $('prereleases').check();
    await expect($('prereleases')).toBeChecked();
    assert.equal((await calls(page, 'desktop_update_check')).length, 0);
    assert.equal((await calls(page, 'desktop_update_install')).length, 0);
    assert.equal(
      await page.evaluate(() => localStorage.getItem('prime-studio.updates.includePrereleases')),
      'true',
    );
    await $('prereleases').uncheck();
    await $('check').click();
    await expect($('install')).toBeVisible();
    await expect($('action-note')).toContainText('2.9.4');
    assert.equal((await calls(page, 'desktop_update_check')).at(-1).includePrereleases, false);
    await $('prereleases').check();
    await expect($('install')).toBeHidden();
    await expect($('notes')).toBeHidden();
    assert.equal((await calls(page, 'desktop_update_install')).length, 0);
    await $('check').click();
    await expect($('install')).toBeVisible();
    await expect($('action-note')).toContainText('3.10.0-beta.4');
    assert.equal((await calls(page, 'desktop_update_check')).at(-1).includePrereleases, true);
    await page.screenshot({ path: `test-results/settings-updates-prereleases-${locale}.png` });
    await $('prereleases').uncheck();
    await expect($('install')).toBeHidden();
    await expect($('notes')).toBeHidden();
    assert.equal(
      await page.evaluate(() => localStorage.getItem('prime-studio.updates.includePrereleases')),
      'false',
    );
    await $('prereleases').check();
    await $('check').click();
    await expect($('install')).toBeVisible();
    await $('install').click();
    await expect($('confirm')).toBeVisible();
    await $('cancel').click();
    assert.equal((await calls(page, 'desktop_update_install')).length, 0);
    await expect($('install')).toBeVisible();
    await $('install').click();
    await $('proceed').click();
    await expect($('progress')).toHaveAttribute('value', '42');
    {
      const installCalls = await calls(page, 'desktop_update_install');
      assert.equal(installCalls.at(-1).includePrereleases, true);
      assert.equal(installCalls.at(-1).version, '3.10.0-beta.4');
    }
    await expect($('prereleases')).toBeDisabled();
    await expect($('check')).toBeDisabled();
    await reopenPanel(page);
    await expect($('prereleases')).toBeChecked();
    await expect($('progress')).toHaveAttribute('value', '42');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`prerelease opt-in ${locale}: default off, explicit channel, persistence, stale clear, confirm, busy guard OK`);
  }
  // Prerelease channel mismatch surfaces a useful error and keeps retry available.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockPrereleaseUpdates(context, { mode: 'channel-changed' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await $('prereleases').check();
    await $('check').click();
    await expect($('install')).toBeVisible();
    await $('install').click();
    await $('proceed').click();
    await expect($('error')).toBeVisible();
    await expect($('error')).toContainText('channel');
    await expect($('install')).toBeEnabled();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Old native without prerelease echo shows unsupported instead of a stable result.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockPrereleaseUpdates(context, { oldNative: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await $('prereleases').check();
    await $('check').click();
    await expect($('error')).toBeVisible();
    await expect($('install')).toBeHidden();
    await $('prereleases').uncheck();
    await $('check').click();
    await expect($('install')).toBeVisible();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Beta and stable failure paths: specific errors, single check, stale cleared, busy guard.
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockPrereleaseUpdates(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await $('check').click();
    await expect($('install')).toBeVisible();
    const before = (await calls(page, 'desktop_update_check')).length;
    await page.evaluate(() => {
      window.updateFixture.mode = 'offline';
    });
    await $('check').click();
    await expect($('error')).toBeVisible();
    await expect($('error')).toContainText('Could not check');
    await expect($('install')).toBeHidden();
    await expect($('notes')).toBeHidden();
    assert.equal((await calls(page, 'desktop_update_check')).length, before + 1);
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockPrereleaseUpdates(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await $('prereleases').check();
    await $('check').click();
    await expect($('action-note')).toContainText('3.10.0-beta.4');
    await page.evaluate(() => {
      window.updateFixture.mode = 'offline';
    });
    await $('check').click();
    await expect($('error')).toBeVisible();
    await expect($('error')).toContainText('Could not check');
    const text = (await $('error').textContent()) || '';
    assert.equal(text.includes('prerelease'), false);
    assert.equal(text.includes('prereleases'), false);
    await expect($('install')).toBeHidden();
    await expect($('notes')).toBeHidden();
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const cases = [
      ['prerelease_metadata_failed', 'Could not load the beta'],
      ['prerelease_manifest_failed', 'signed beta'],
      ['prerelease_version_mismatch', 'does not match'],
    ];
    for (const [mode, text] of cases) {
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
      await mockPrereleaseUpdates(context, { mode });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const $ = (id) => page.locator('#studio-update-' + id);
      await openPanel(page, fixture.url);
      await $('prereleases').check();
      await $('check').click();
      await expect($('error')).toBeVisible();
      await expect($('error')).toContainText(text);
      await expect($('install')).toBeHidden();
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 960 } });
    await mockPrereleaseUpdates(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await $('prereleases').check();
    await $('check').click();
    await expect($('install')).toBeVisible();
    await $('install').click();
    await $('proceed').click();
    await expect($('progress')).toHaveAttribute('value', '42');
    const checksBefore = (await calls(page, 'desktop_update_check')).length;
    const installsBefore = (await calls(page, 'desktop_update_install')).length;
    await page.evaluate(() => {
      const box = document.getElementById('studio-update-prereleases');
      box.checked = !box.checked;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect($('prereleases')).toBeChecked();
    assert.equal(
      await page.evaluate(() => localStorage.getItem('prime-studio.updates.includePrereleases')),
      'true',
    );
    assert.equal((await calls(page, 'desktop_update_check')).length, checksBefore);
    assert.equal((await calls(page, 'desktop_update_install')).length, installsBefore);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Read-only native desktop keeps the prerelease switch and check disabled.
  {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
    await mockPrereleaseUpdates(context);
    const page = await context.newPage();
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, preferences: { ...body.preferences, readOnly: true } },
      });
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const $ = (id) => page.locator('#studio-update-' + id);
    await openPanel(page, fixture.url);
    await expect($('native')).toBeHidden();
    await expect($('prereleases')).toBeHidden();
    await expect($('remote')).toBeVisible();
    assert.equal((await calls(page, 'desktop_update_check')).length, 0);
    assert.equal((await calls(page, 'desktop_update_install')).length, 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Mobile captures.
  for (const locale of ['fr-FR', 'en-US']) {
    const mobile = await browser.newContext({
      locale,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await mockDesktopUpdates(mobile);
    const page = await mobile.newPage();
    await openPanel(page, fixture.url);
    await expect(page.locator('#settings-tab-updates')).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: `test-results/settings-updates-mobile-${locale}.png` });
    await mobile.close();
  }
  // Web fallback without native bridge.
  const web = await browser.newPage();
  await web.goto(fixture.url + '/?settings=updates');
  await expect(web.locator('#studio-update-native')).toBeHidden();
  await expect(web.locator('#studio-update-prereleases')).toBeHidden();
  await expect(web.locator('#studio-update-browser')).toBeVisible();
  await web.close();
  console.log(
    'Updates preferences passed in FR/EN: versions, 3 buttons, repair, collapsed details, confirmations, idle restart, restart-during-download cancelCurrent plus stale install settlement, prepare-then-restart, quit noncancellable refusal, quit failure without closure claim, quit cancel/force/already-stopped, race refusal, progress, cancel, bytes, errors, recoverable vs foreign, sanitized notes, mobile captures, browser fallback.',
  );
} finally {
  await browser.close();
  await fixture.close();
}
