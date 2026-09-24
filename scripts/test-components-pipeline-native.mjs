// Real WebView IPC and restart, exclusively against a separately identified test build.
// Build with: tauri build --debug --no-bundle --config test/fixtures/components-pipeline-tauri.json
// The config must set identifier to com.primeagent.studio.pipeline-test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, expect } from '@playwright/test';
import { startServer } from './start-server.mjs';
import { stopServer } from './stop-server.mjs';
import { probeHealth } from './launcher-common.mjs';

const exe = process.env.PRIME_STUDIO_TEST_EXE;
assert.ok(exe, 'Explicit isolated test executable required');
assert.ok(
  (await readFile(exe)).includes(Buffer.from('com.primeagent.studio.pipeline-test')),
  'Refusing to launch an executable with the production single-instance identity',
);
assert.ok(
  process.env.PRIME_AGENT_CLI && process.env.PRIME_AGENT_KERNEL_PYTHON,
  'Use an already validated isolated engine and Python; this test never downloads components',
);
const root = await mkdtemp(join(tmpdir(), 'studio-components-pipeline-'));
const dataRoot = join(root, 'desktop'),
  dataDir = join(dataRoot, 'data'),
  oldRoot = join(root, 'old');
const agentHome = join(root, 'agent'),
  sessionDir = join(root, 'sessions');
await Promise.all([dataDir, oldRoot, agentHome, sessionDir].map((p) => mkdir(p, { recursive: true })));
const freePort = async () => {
  const s = createServer();
  await new Promise((done) => s.listen(0, '127.0.0.1', done));
  const port = s.address().port;
  await new Promise((done) => s.close(done));
  return port;
};
const port = await freePort(),
  debugPort = await freePort(),
  url = `http://127.0.0.1:${port}`;
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
await writeFile(join(agentHome, 'auth.json'), '{}');
await writeFile(
  join(agentHome, 'settings.json'),
  JSON.stringify({ telemetry: { enabled: false, noticeShown: true } }),
);
await writeFile(
  join(dataDir, 'workspace.json'),
  JSON.stringify({ projects: [], removedProjects: [], sessions: {} }),
);
await writeFile(
  join(oldRoot, 'server.mjs'),
  `
import {createServer} from 'node:http';
let active = true;
createServer((req,res) => {
  res.setHeader('Content-Type','application/json');
  if(req.url === '/api/health') res.end(JSON.stringify({service:'prime-agent-gui',status:'ok',pid:process.pid,instanceId:process.env.PRIME_AGENT_GUI_INSTANCE,version:'3.6.2'}));
  else if(req.url === '/api/runs') res.end(JSON.stringify({runs: active ? [{id:'synthetic',status:'running'}] : []}));
  else if(req.url === '/api/version') res.end(JSON.stringify({available:true,version:'0.9.4'}));
  else if(req.url === '/test-idle') {active=false;res.end('{}');}
  else {res.statusCode=404;res.end('{}');}
}).listen(Number(process.env.PORT),'127.0.0.1');
`,
);
let child, browser;
try {
  const old = await startServer({
    root: oldRoot,
    port,
    env: { ...process.env, PRIME_AGENT_GUI_DATA_DIR: dataDir },
  });
  child = spawn(resolve(exe), ['--background'], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PRIME_STUDIO_DESKTOP_DATA_ROOT: dataRoot,
      PRIME_STUDIO_DESKTOP_PORT: String(port),
      PRIME_AGENT_CODING_AGENT_DIR: agentHome,
      PRIME_AGENT_SESSION_DIR: sessionDir,
      WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
    },
  });
  await expect
    .poll(
      () =>
        fetch(`http://127.0.0.1:${debugPort}/json/version`)
          .then((r) => r.ok)
          .catch(() => false),
      { timeout: 30000 },
    )
    .toBe(true);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const page = browser.contexts()[0].pages()[0];
  // Keep the isolated native window hidden, then exercise the foreground guide
  // through its packaged document rather than bringing a test window to front.
  await expect.poll(() => page.url(), { timeout: 45000 }).toContain(url);
  await page.goto('http://tauri.localhost/index.html?settings');
  await expect(page.locator('#components-apply')).toBeVisible({ timeout: 45000 });
  await page.evaluate(() => start({ background: false }));
  await expect(page.locator('#migration-dialog')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('#migration-dialog')).toContainText('0.9.6');
  assert.equal((await probeHealth(port)).health.pid, old.pid, 'migration explanation never restarts');
  await page.locator('#migration-continue').click();
  await expect(page.locator('#migration-dialog')).toBeHidden();
  await expect(page.locator('#components')).toBeVisible({ timeout: 45000 });
  await expect(page.locator('#description')).toContainText('0.9.6');
  await expect(page.locator('#components-apply')).toBeVisible({ timeout: 45000 });
  assert.equal(
    (await probeHealth(port)).health.pid,
    old.pid,
    'opening the guide never restarts the old server',
  );
  await page.locator('#components-apply').click();
  await expect(page.locator('#components-status')).toContainText(/différée|deferred/, { timeout: 45000 });
  assert.equal((await probeHealth(port)).health.pid, old.pid, 'active runs must defer activation');
  assert.equal(
    JSON.parse(await readFile(join(dataRoot, 'engine/installation.json'), 'utf8')).components.engine.version,
    '0.9.6',
  );
  await fetch(url + '/test-idle');
  await page.locator('#components-apply').click();
  await expect.poll(async () => (await probeHealth(port)).health?.version, { timeout: 60000 }).toBe(version);
  await expect
    .poll(() => page.evaluate(() => window.__PRIME_STUDIO_COMPONENTS_PANEL__), { timeout: 45000 })
    .toBe(true);
  await page.evaluate(() => window.__TAURI__.core.invoke('desktop_components_open'));
  await expect(page.locator('#studio-update-components')).toBeVisible({ timeout: 45000 });
  const proof = await page.evaluate(async () => {
    // Join the real panel/banner bootstrap status call before starting a second
    // native operation; update_busy is a required mutual-exclusion guard.
    const { readComponentsStatus } = await import('/public/desktop-components.js');
    await readComponentsStatus();
    const phases = [];
    const onProgress = new window.__TAURI__.core.Channel();
    onProgress.onmessage = (p) => phases.push(p.stage);
    const result = await window.__TAURI__.core.invoke('desktop_components', {
      action: 'diagnose',
      component: null,
      onProgress,
    });
    return { result, phases };
  });
  assert.equal(proof.result.ready, true);
  assert.equal(proof.result.requiredEngine, '0.9.6');
  assert.equal(proof.result.needsRestart, false);
  assert.ok(proof.phases.includes('validation'), 'real main-WebView progress Channel is delivered');
  await page.evaluate(() => document.querySelector('#settings-dialog').close());
  await page.evaluate(() => window.__TAURI__.core.invoke('desktop_components_open'));
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#settings-tab-updates')).toHaveAttribute('aria-selected', 'true');
  assert.equal(browser.contexts()[0].pages().length, 1, 'normal settings never opens a duplicate window');
  // The advanced model controls must use the common stacked dialog in WebView2,
  // not only in the Chromium mock. Escape changes no model or setting.
  await page.locator('#settings-tab-models').click();
  await page.locator('#open-model-config').click();
  const picker = page.locator('#engine-providerBackupModel');
  await expect(picker).toBeEnabled({ timeout: 45000 });
  const draft = await picker.evaluate((node) => node.value);
  await picker.click();
  await expect(page.locator('#model-dialog')).toBeVisible();
  await expect(page.locator('#model-search')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#model-dialog')).toBeHidden();
  await expect(page.locator('#model-config-dialog')).toBeVisible();
  assert.equal(await picker.evaluate((node) => node.value), draft);
  await page.evaluate(() => document.querySelector('#model-config-dialog').close());
  await page.locator('#settings-tab-updates').click();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/components-native-pipeline.png' });
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        'manual-update guide with engine version',
        'busy activation deferred',
        'idle activation to installed server',
        'real main-WebView components IPC and progress',
        'one settings surface',
        'shared advanced model picker and Escape preserving draft',
      ],
      root,
    }),
  );
} catch (error) {
  await mkdir('test-results', { recursive: true });
  const page = browser?.contexts()[0]?.pages()[0];
  const diagnostic = {
    error: String(error.message),
    page: page?.url(),
    status: await page
      ?.locator('#components-status')
      .textContent()
      .catch(() => null),
    installation: await readFile(join(dataRoot, 'engine/installation.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null),
    log: await readFile(join(dataRoot, 'engine/logs/components.log'), 'utf8').catch(() => null),
  };
  await writeFile('test-results/components-native-failure.json', JSON.stringify(diagnostic, null, 2));
  throw error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => child.once('exit', done));
    child.kill();
    await exited;
  }
  await browser?.close().catch(() => {});
  await stopServer({ root: oldRoot, dataDir });
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
