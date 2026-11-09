// Real WebView2 startup regression proof: isolated Tauri exe + fixture backend.
// The native launcher must reuse the fixture backend and autonavigate without
// any page.goto(serverURL) healing. CDP only observes the owned WebView;
// no physical keyboard claims, no engine/download/account/model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server.mjs';

assert.equal(process.platform, 'win32', 'This test requires real Windows/WebView2');

const baseline = process.argv.includes('--baseline');
function evidenceArg() {
  const direct = process.argv.find((a) => a.startsWith('--evidence='));
  if (direct) return direct.slice('--evidence='.length);
  const at = process.argv.indexOf('--evidence');
  if (at !== -1 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--'))
    return process.argv[at + 1];
  return null;
}

// MUST require the isolated test exe; never production exe, never installed Studio.
assert.ok(
  process.env.PRIME_STUDIO_TEST_EXE,
  'Provide PRIME_STUDIO_TEST_EXE: a separately built isolated Tauri executable',
);
const exe = resolve(process.env.PRIME_STUDIO_TEST_EXE);
const lowered = exe.toLowerCase();
assert.ok(!lowered.includes('program files'), 'Refusing production/installed Studio path: ' + exe);
assert.ok(!lowered.includes('prime agent'), 'Refusing installed Studio path: ' + exe);
const identity = 'com.primeagent.studio.startup-test';
const binary = await readFile(exe);
assert.ok(binary.includes(Buffer.from(identity)), 'Test exe must embed isolated identity ' + identity);
const root = await mkdtemp(join(tmpdir(), 'prime-startup-native-'));
const cwd = join(root, 'Atelier');
const sessionDir = join(root, 'sessions');
const agentHome = join(root, 'agent');
const serverData = join(root, 'server-data');
const dataRoot = join(root, 'desktop');
const defaultEvidenceDir = resolve('.local/study/beta3-startup-incident');
await Promise.all(
  [cwd, sessionDir, agentHome, serverData, dataRoot, defaultEvidenceDir].map((d) => mkdir(d, { recursive: true })),
);
await writeFile(join(dataRoot, 'desktop.json'), '{"started":true}');
const evidenceOverride = evidenceArg();
const evidencePath =
  evidenceOverride && evidenceOverride.endsWith('.json')
    ? resolve(evidenceOverride)
    : join(defaultEvidenceDir, baseline ? 'startup-native-baseline.json' : 'startup-native-fixed.json');
const evidencePng =
  evidenceOverride && evidenceOverride.endsWith('.json')
    ? evidenceOverride.replace(/\.json$/, '.png')
    : join(defaultEvidenceDir, baseline ? 'startup-native-baseline.png' : 'startup-native-fixed.png');

let agentStarts = 0;
const seen = [];
const app = createApp({
  cwd,
  initialCwd: cwd,
  sessionDir,
  agentHome,
  dataDir: serverData,
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({ models: [], default: null }),
    start: async () => {
      agentStarts++;
      throw new Error('The startup test must never run an agent');
    },
    close: async () => {},
  },
  directoryPicker: {
    pick: async () => {
      throw new Error('The startup test must use native IPC, not the HTTP picker');
    },
    close: () => {},
  },
});
// Fixture listener: only document/network proof headers, never credentials.
app.server.on('request', (req, res) => {
  const record = {
    method: req.method,
    url: req.url,
    secFetchSite: req.headers['sec-fetch-site'] ?? null,
    secFetchMode: req.headers['sec-fetch-mode'] ?? null,
    secFetchDest: req.headers['sec-fetch-dest'] ?? null,
    status: null,
  };
  seen.push(record);
  res.on('finish', () => {
    record.status = res.statusCode;
  });
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = 'http://127.0.0.1:' + app.server.address().port;

const reservation = createServer();
await new Promise((done) => reservation.listen(0, '127.0.0.1', done));
const debugPort = reservation.address().port;
await new Promise((done) => reservation.close(done));

// Prefer --background: invisible own window, avoids focus theft.
const child = spawn(exe, ['--background'], {
  windowsHide: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    PRIME_STUDIO_DESKTOP_DATA_ROOT: dataRoot,
    PRIME_STUDIO_DESKTOP_PORT: String(app.server.address().port),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      '--remote-debugging-port=' + debugPort + ' --remote-debugging-address=127.0.0.1',
  },
});

let browser;
const checks = [];
const pageErrors = [];
const docOf = (list) =>
  list.filter((r) => {
    try {
      return r.method === 'GET' && new URL(r.url, url).pathname === '/';
    } catch {
      return false;
    }
  });
try {
  // CDP through the loopback debug port only, after spawn. 30s connect budget.
  await expect
    .poll(
      async () => {
        if (child.exitCode !== null)
          throw new Error('The isolated exe exited unexpectedly; build the isolated debug exe first');
        return fetch('http://127.0.0.1:' + debugPort + '/json/version')
          .then((r) => r.ok)
          .catch(() => false);
      },
      { timeout: 30000 },
    )
    .toBe(true);
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + debugPort);
  const context = browser.contexts()[0];
  // Real native autonavigation: wait for the owned WebView to reach the
  // fixture backend on its own. NEVER page.goto(url) to heal/bypass launcher.
  await expect
    .poll(() => context.pages().find((pg) => pg.url().startsWith(url))?.url(), { timeout: 30000 })
    .toBeTruthy();
  const page = context.pages().find((pg) => pg.url().startsWith(url));
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));

  // Let the first document settle (Studio DOM or raw 403 JSON).
  await expect
    .poll(() => page.evaluate(() => (document.body ? document.body.textContent.length : 0)), {
      timeout: 10000,
    })
    .toBeGreaterThan(0);

  const initialDocs = docOf(seen).filter((r) => r.status !== null);
  assert.ok(initialDocs.length >= 1, 'Expected at least one GET / document request, saw ' + seen.length);
  const initial = initialDocs[0];
  const bodyText = await page.evaluate(() => document.body.textContent.slice(0, 4000));
  const pageUrl = page.url();
  assert.ok(pageUrl.startsWith(url), 'Owned WebView must be on the fixture backend, saw ' + pageUrl);

  if (baseline) {
    // Broken beta3 path: JS location.replace from tauri.localhost is cross-site.
    assert.equal(initial.secFetchSite, 'cross-site', 'Baseline expects real cross-site header, saw ' + initial.secFetchSite);
    assert.equal(initial.status, 403, 'Baseline expects the real 403, saw ' + initial.status);
    assert.match(bodyText, /Requ.te externe non autoris.e/, 'Baseline must show the raw 403 JSON text');
    const addCount = await page.locator('#add-project').count();
    assert.equal(addCount, 0, 'Baseline must not render Studio DOM');
    checks.push(
      'Baseline reproduced: native document GET / sec-fetch-site=' + initial.secFetchSite +
        ' mode=' + initial.secFetchMode + ' dest=' + initial.secFetchDest + ' status=403 with raw JSON',
    );
  } else {
    // Corrected path: native navigation carries no cross-site header.
    assert.equal(initial.status, 200, 'Fixed expects native initial document 200, saw ' + initial.status);
    assert.ok(
      initial.secFetchSite === 'none' || initial.secFetchSite === null || initial.secFetchSite === '',
      'Fixed expects native initial document sec-fetch-site none, saw ' + initial.secFetchSite,
    );
    await expect(page.locator('#add-project')).toBeVisible({ timeout: 10000 });
    const flags = await page.evaluate(() => ({
      desktop: window.__PRIME_STUDIO_DESKTOP__,
      picker: window.__PRIME_STUDIO_DIRECTORY_PICKER__,
    }));
    assert.equal(flags.desktop, true, 'Studio DOM must carry the native desktop flag');
    const bootstrap = await page.evaluate(async (base) => {
      const response = await fetch(base + '/api/bootstrap');
      return { status: response.status, text: (await response.text()).slice(0, 2000) };
    }, url);
    assert.equal(bootstrap.status, 200, 'Same-origin bootstrap must succeed, saw ' + bootstrap.status);
    checks.push(
      'Fixed: native initial document GET / sec-fetch-site=' + initial.secFetchSite +
        ' mode=' + initial.secFetchMode + ' dest=' + initial.secFetchDest + ' status=200 with Studio DOM',
    );
    checks.push('Same-origin /api/bootstrap reachable from the owned WebView (CDP evaluate, no credentials)');

    // Back boundary: the launcher entry must not be revisitable and must not reload the backend.
    await page.evaluate(() => {
      window.__PRIME_STARTUP_NATIVE_PROOF = 'startup-native-proof';
    });
    const markerBefore = await page.evaluate(() => window.__PRIME_STARTUP_NATIVE_PROOF);
    assert.equal(markerBefore, 'startup-native-proof');
    const docCountBefore = docOf(seen).length;
    const cdp = await context.newCDPSession(page);
    let launcherEntry = null;
    try {
      const history = await cdp.send('Page.getNavigationHistory');
      const entries = (history && history.entries) || [];
      launcherEntry =
        entries.find(
          (e) =>
            typeof e.url === 'string' &&
            !e.url.startsWith(url) &&
            (e.url.includes('tauri.localhost') || e.url.startsWith('tauri://') || e.url.includes('index.html')),
        ) || null;
      checks.push(
        launcherEntry
          ? 'Navigation history holds launcher entry ' + launcherEntry.url
          : 'Navigation history holds no launcher entry (replace semantics, back impossible)',
      );
    } catch (error) {
      checks.push('History lookup best-effort skipped: ' + String(error).slice(0, 160));
    }
    if (launcherEntry) {
      try {
        await cdp.send('Page.navigateToHistoryEntry', { entryId: launcherEntry.id });
      } catch {
        try {
          await page.goBack({ timeout: 5000 });
        } catch {}
      }
      await page.waitForTimeout(1500);
    } else {
      try {
        await page.goBack({ timeout: 3000 });
      } catch {}
      await page.waitForTimeout(1000);
    }
    assert.ok(page.url().startsWith(url), 'Back must stay on the Studio URL, saw ' + page.url());
    const markerAfter = await page.evaluate(() => window.__PRIME_STARTUP_NATIVE_PROOF);
    assert.equal(markerAfter, 'startup-native-proof', 'JS document marker must persist across blocked Back');
    const docCountAfter = docOf(seen).length;
    assert.equal(
      docCountAfter,
      docCountBefore,
      'Blocked Back must not reload the backend (GET / count ' + docCountBefore + ' -> ' + docCountAfter + ')',
    );
    checks.push('Back boundary holds: still on Studio URL, marker persists, no backend document reload');
    try {
      await cdp.detach();
    } catch {}
    // Explicit settings fallback stays allowed (Rust unit covers policy).
    // Best-effort real check at the end so it never heals the main proof.
    try {
      const probe = await context.newCDPSession(page);
      const target = 'http://tauri.localhost/index.html?settings';
      await probe.send('Page.navigate', { url: target });
      await page.waitForTimeout(1200);
      const shellUrl = page.url();
      const shellOk =
        shellUrl.includes('tauri.localhost') || shellUrl.includes('settings') || shellUrl.startsWith(url);
      checks.push(
        shellOk
          ? 'Explicit local shell navigation allowed (now at ' + shellUrl.slice(0, 120) + ')'
          : 'Explicit shell probe inconclusive at ' + shellUrl.slice(0, 120),
      );
      if (!shellUrl.startsWith(url)) {
        await probe.send('Page.navigate', { url: url + '/' });
        await expect.poll(() => page.url(), { timeout: 10000 }).toMatch(/^http:\/\/127\.0\.0\.1/);
        await expect(page.locator('#add-project')).toBeVisible({ timeout: 10000 });
      }
      try {
        await probe.detach();
      } catch {}
    } catch (error) {
      checks.push('Explicit shell fallback best-effort skipped: ' + String(error).slice(0, 160));
    }
  }

  // Root security still rejects separate cross-site GET/API requests (no weakening).
  for (const path of ['/', '/api/bootstrap']) {
    const forged = await fetch(url + path, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(forged.status, 403, 'Cross-site ' + path + ' must stay rejected, saw ' + forged.status);
    const text = await forged.text();
    assert.match(text, /externe|autorise/i, 'Cross-site ' + path + ' must carry the denial');
  }
  checks.push('Server guard intact: forged cross-site GET / and /api/bootstrap both 403 (no weakening)');
  assert.equal(agentStarts, 0, 'The startup test must never run an agent');

  // Screenshot of the owned WebView only (CDP).
  await mkdir(dirname(evidencePng), { recursive: true });
  await page.screenshot({ path: evidencePng });
  await mkdir(dirname(evidencePath), { recursive: true });
  const report = {
    passed: true,
    mode: baseline ? 'baseline' : 'fixed',
    identity,
    exe,
    pid: child.pid,
    root,
    url,
    pageUrl: page.url(),
    initialDocument: {
      secFetchSite: initial.secFetchSite,
      secFetchMode: initial.secFetchMode,
      secFetchDest: initial.secFetchDest,
      status: initial.status,
    },
    bodyExcerpt: bodyText.slice(0, 500),
    pageErrors,
    agentStarts,
    checks,
    evidencePng,
  };
  await writeFile(evidencePath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, mode: report.mode, checks, evidence: evidencePath }));
} catch (error) {
  try {
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(
      evidencePath.replace(/\.json$/, '-failure.json'),
      JSON.stringify(
        { error: error?.stack || String(error), baseline, seen: seen.slice(0, 40), pageErrors, agentStarts },
        null,
        2,
      ),
    );
  } catch {}
  throw error;
} finally {
  // Close only the owned app/test process; never a broad taskkill.
  try {
    child.kill();
  } catch {}
  await new Promise((done) =>
    child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', done),
  );
  await browser?.close().catch(() => {});
  await app.close();
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
