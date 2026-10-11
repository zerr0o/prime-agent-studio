// Focused beta.3 regression: roadmap docked loading after an in-flight
// invalidation (tab flip / project change) + bounded hang recovery.
// Isolated createRoadmapFixture + loopback server + stub runtime: no active
// Studio, no Lab, no real models. Fast by design: 400-600ms route delays,
// hard bounds well under the old 2200ms poll wait. No screenshots, no writes
// outside console output. Watchdog + app.close/browser.close in finally.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRoadmapFixture } from './fixtures/roadmap.mjs';
import { launchStudioBrowser } from './fixtures/browser.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOUND_FLIP_MS = 2000;
const BOUND_PROJECT_MS = 2500;
const BOUND_HANG_MS = 2500;
// Static wiring guard: the fix must keep a bounded queued retry, cancel the
// stale GET through the existing api signal, and bound hung requests.
const source = await readFile(new URL('../public/roadmap.js', import.meta.url), 'utf8');
for (const needle of [
  'queuedRefresh',
  'AbortController',
  'signal',
  'REFRESH_TIMEOUT_MS',
  'abortInflightRefresh',
]) {
  assert.ok(source.includes(needle), `public/roadmap.js must contain ${needle}`);
}
assert.ok(/setTimeout\([\s\S]{0,200}REFRESH_TIMEOUT_MS/.test(source), 'a bounded timeout must abort the GET');

const fixture = await createRoadmapFixture();
// Distinct marker for the other project: proves no stale cross-cwd write.
{
  let doc = await fixture.app.roadmap.read(fixture.otherCwd);
  doc = await fixture.app.roadmap.mutate(fixture.otherCwd, {
    action: 'init',
    expectedRevision: doc.revision,
  });
  await fixture.app.roadmap.mutate(fixture.otherCwd, {
    action: 'vision',
    expectedRevision: doc.revision,
    text: 'OTHER_PROJECT_MARKER rendre la migration du volant simple.',
  });
}

const LAYOUT = {
  version: 3,
  enabled: true,
  root: {
    kind: 'split',
    id: 'main',
    dir: 'row',
    ratio: 0.68,
    first: { kind: 'group', id: 'conversation-group', panels: ['conversation'], active: 'conversation' },
    second: {
      kind: 'group',
      id: 'tools-group',
      panels: ['roadmap', 'session', 'agents', 'files'],
      active: 'session',
    },
  },
};
const instrument = (page, sessionId) =>
  page.addInitScript(
    ({ cwd, sessionId, layout }) => {
      localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, sessionId }));
      localStorage.setItem('prime-studio.docking.layout', JSON.stringify(layout));
      window.__rmReqs = [];
      const origFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const url = String(args[0]);
        if (!url.includes('/api/roadmap') || url.includes('/session') || url.includes('retry')) {
          return origFetch(...args);
        }
        const rec = { url, method: args[1]?.method || 'GET', t0: performance.now(), t1: null, ok: null };
        window.__rmReqs.push(rec);
        try {
          const res = await origFetch(...args);
          rec.t1 = performance.now();
          rec.ok = res.ok;
          return res;
        } catch (e) {
          rec.t1 = performance.now();
          rec.ok = false;
          throw e;
        }
      };
    },
    { cwd: fixture.cwd, sessionId, layout: LAYOUT },
  );
const rmReqs = (page) => page.evaluate(() => window.__rmReqs || []);
const panelHas = (page, marker) =>
  page.evaluate((m) => document.querySelector('#roadmap-panel')?.textContent?.includes(m) ?? false, marker);
async function waitMarker(page, marker, boundMs) {
  const t0 = Date.now();
  for (;;) {
    if (await panelHas(page, marker)) return Date.now() - t0;
    if (Date.now() - t0 > boundMs) return null;
    await sleep(100);
  }
}

let browser;
const watchdog = setTimeout(() => {
  console.error('WATCHDOG: roadmap-loading-ui exceeded 90s');
  void browser?.close();
  void fixture.close();
  process.exit(2);
}, 90000);
const summary = {};
try {
  browser = await launchStudioBrowser({ channel: 'chrome' });

  // A: in-flight GET + tab flip-flop recovers bounded (no 2200ms poll wait).
  {
    const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e?.message || e)));
    await instrument(page, 'calibration-demo');
    let n = 0;
    await page.route('**/api/roadmap?*', async (route) => {
      if (++n === 1) await sleep(600);
      try {
        await route.continue();
      } catch {}
    });
    try {
      await page.goto(fixture.url);
      await page.waitForSelector('[data-dock-tab="roadmap"]', { timeout: 30000 });
      await page.click('[data-dock-tab="roadmap"]');
      await sleep(150); // GET #1 in flight
      await page.click('[data-dock-tab="session"]');
      await sleep(100);
      const t0 = Date.now();
      await page.click('[data-dock-tab="roadmap"]');
      const loadedMs = await waitMarker(page, 'Rendre la calibration', BOUND_FLIP_MS);
      const reqs = await rmReqs(page);
      assert.ok(
        loadedMs !== null,
        `flip recovery must load within ${BOUND_FLIP_MS}ms (got reqs=${reqs.length})`,
      );
      assert.ok(reqs.length >= 2, `flip must refetch after invalidation (got ${reqs.length})`);
      assert.deepEqual(errs.slice(0, 3), []);
      summary.flip = { loadedMs, reqs: reqs.length };
    } finally {
      await page.close();
    }
  }

  // B: in-flight GET + project change loads the NEW project bounded, no stale write.
  {
    const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e?.message || e)));
    await instrument(page, 'calibration-demo');
    let n = 0;
    await page.route('**/api/roadmap?*', async (route) => {
      if (++n === 1) await sleep(600);
      try {
        await route.continue();
      } catch {}
    });
    try {
      await page.goto(fixture.url);
      await page.waitForSelector('[data-dock-tab="roadmap"]', { timeout: 30000 });
      await page.click('[data-dock-tab="roadmap"]');
      await sleep(150); // GET #1 (cwd A) in flight
      const switched = await page.evaluate(() => {
        const els = [
          ...document.querySelectorAll(
            '#project-list button, #project-list a, #project-list [role="button"]',
          ),
        ];
        const hit = els.find((el) => /vtrott/i.test(el.textContent || ''));
        if (hit) {
          hit.click();
          return true;
        }
        return false;
      });
      assert.ok(switched, 'must find the Vtrott project entry to switch projects');
      const t0 = Date.now();
      // Keep the roadmap tab visible after the switch when the layout hides it.
      const tabVisible = await page.evaluate(() => {
        const panel = document.querySelector('#roadmap-panel');
        return !!panel && !panel.hidden;
      });
      if (!tabVisible) await page.click('[data-dock-tab="roadmap"]');
      const loadedMs = await waitMarker(
        page,
        'OTHER_PROJECT_MARKER',
        BOUND_PROJECT_MS - (Date.now() - t0) > 500 ? BOUND_PROJECT_MS - (Date.now() - t0) : 500,
      );
      const reqs = await rmReqs(page);
      const showingOther = await panelHas(page, 'OTHER_PROJECT_MARKER');
      assert.ok(showingOther, `project switch must show the new project doc (reqs=${reqs.length})`);
      assert.ok(loadedMs !== null, `project switch must settle bounded (reqs=${reqs.length})`);
      assert.deepEqual(errs.slice(0, 3), []);
      summary.project = { loadedMs, reqs: reqs.length };
    } finally {
      await page.close();
    }
  }

  // C: hung GET + flip recovers bounded (cancellation); same abort path as the timeout.
  {
    const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e?.message || e)));
    await instrument(page, 'calibration-demo');
    let n = 0;
    await page.route('**/api/roadmap?*', async (route) => {
      if (++n === 1) return; // hang the first GET forever; the flip must cancel it
      try {
        await route.continue();
      } catch {}
    });
    try {
      await page.goto(fixture.url);
      await page.waitForSelector('[data-dock-tab="roadmap"]', { timeout: 30000 });
      await page.click('[data-dock-tab="roadmap"]');
      await sleep(300); // first GET hung in flight
      await page.click('[data-dock-tab="session"]');
      await sleep(100);
      const t0 = Date.now();
      await page.click('[data-dock-tab="roadmap"]');
      const loadedMs = await waitMarker(page, 'Rendre la calibration', BOUND_HANG_MS);
      const reqs = await rmReqs(page);
      assert.ok(loadedMs !== null, `hung GET must be cancelled with bounded recovery (reqs=${reqs.length})`);
      assert.ok(reqs.length >= 2, `hung GET must be replaced by a fresh fetch (got ${reqs.length})`);
      assert.deepEqual(errs.slice(0, 3), []);
      summary.hang = { loadedMs, reqs: reqs.length };
    } finally {
      await page.close();
    }
  }

  // D: editor draft survives an invalidated refetch; no refresh storm afterwards.
  {
    const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e?.message || e)));
    await instrument(page, 'calibration-demo');
    try {
      await page.goto(fixture.url);
      await page.waitForSelector('[data-dock-tab="roadmap"]', { timeout: 30000 });
      await page.click('[data-dock-tab="roadmap"]');
      const loadedMs = await waitMarker(page, 'Rendre la calibration', 10000);
      assert.ok(loadedMs !== null, 'roadmap must load before the draft check');
      const panel = page.locator('#roadmap-panel');
      await panel.getByRole('button', { name: 'Ajouter un plan', exact: true }).click();
      const editor = page.locator('.rm-editor');
      await editor.getByLabel('Titre', { exact: true }).fill('DRAFT_SURVIVES_FLIP');
      // The open modal editor intercepts pointer events over the dock tabs,
      // so flip via DOM clicks (same handlers as real tab clicks).
      await page.evaluate(() => document.querySelector('[data-dock-tab="session"]')?.click());
      await sleep(100);
      await page.evaluate(() => document.querySelector('[data-dock-tab="roadmap"]')?.click());
      await sleep(800); // let any invalidated refetch settle
      assert.ok(await editor.isVisible(), 'open editor must survive the flip refetch');
      assert.equal(await editor.getByLabel('Titre', { exact: true }).inputValue(), 'DRAFT_SURVIVES_FLIP');
      await editor.getByRole('button', { name: 'Annuler', exact: true }).click();
      const before = (await rmReqs(page)).length;
      await sleep(1200); // well under the 2200ms poll: no storm expected
      const after = (await rmReqs(page)).length;
      assert.ok(after - before <= 1, `no refresh storm expected (delta=${after - before})`);
      assert.deepEqual(errs.slice(0, 3), []);
      summary.draft = { preserved: true, extraReqs: after - before };
    } finally {
      await page.close();
    }
  }

  // E: hung GETs hit the real 8s timeout (same abort path as cancellation):
  // visible error + retry button, then a successful fetch after release.
  {
    const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e?.message || e)));
    await instrument(page, 'calibration-demo');
    let hang = true;
    await page.route('**/api/roadmap?*', async (route) => {
      if (hang) return; // hang every GET until the timeout error is observed
      try {
        await route.continue();
      } catch {}
    });
    try {
      await page.goto(fixture.url);
      await page.waitForSelector('[data-dock-tab="roadmap"]', { timeout: 30000 });
      await page.click('[data-dock-tab="roadmap"]');
      const status = page.locator('#roadmap-panel .rm-status');
      let sawError = false;
      for (let i = 0; i < 150; i++) {
        const text = (await status.textContent().catch(() => '')) || '';
        if (text.includes('Connexion interrompue')) {
          sawError = true;
          break;
        }
        await sleep(100);
      }
      assert.ok(sawError, 'hung GETs must surface a visible error after the bounded timeout');
      hang = false;
      await status.getByRole('button', { name: 'Réessayer', exact: true }).click();
      const loadedMs = await waitMarker(page, 'Rendre la calibration', 20000);
      const reqs = await rmReqs(page);
      assert.ok(loadedMs !== null, `retry after timeout must load (reqs=${reqs.length})`);
      assert.ok(reqs.length >= 2, `timeout must be followed by a fresh fetch (got ${reqs.length})`);
      assert.deepEqual(errs.slice(0, 3), []);
      summary.timeout = { retried: true, loadedMs, reqs: reqs.length };
    } finally {
      await page.close();
    }
  }

  console.log(JSON.stringify({ ok: true, summary }));
} finally {
  clearTimeout(watchdog);
  try {
    await browser?.close();
  } catch {}
  await fixture.close();
}
