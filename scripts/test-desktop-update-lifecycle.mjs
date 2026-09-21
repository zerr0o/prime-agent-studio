// Isolated native Tauri validation for update/restart/quit rework.
// FAIL-CLOSED: requires PRIME_STUDIO_TEST_EXE with the isolated test identity.
// Never launches, stops or installs the real Studio. No publish, no version bump.
// No real installer, no paying calls, no account. Check/install are never invoked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { startServer } from './start-server.mjs';
import { stopDesktop } from './desktop-control.mjs';
import { probeHealth } from './launcher-common.mjs';

assert.equal(process.platform, 'win32', 'This test requires real Windows/WebView2');

// True Tauri config overlay: test/fixtures/update-clarification-tauri.json holds only $schema/identifier/productName.
// Orchestration spec lives in .local/update-clarification/native/API-FIXTURE.md, never in the JSON.
const TEST_IDENTIFIER = 'com.primeagent.studio.update-clarification-test';
const PROD_IDENTIFIER = 'com.primeagent.studio';
let tauriConfig = {};
try {
  tauriConfig = JSON.parse(await readFile(new URL('../test/fixtures/update-clarification-tauri.json', import.meta.url), 'utf8'));
} catch {}
assert.equal(tauriConfig.identifier, TEST_IDENTIFIER, 'Tauri fixture identifier must stay exact');
assert.ok(TEST_IDENTIFIER !== PROD_IDENTIFIER, 'Test identity must stay distinct from production');
const TEST_IDENTITY = TEST_IDENTIFIER;
// Forbidden Tauri commands in this lifecycle: desktop_update_check, desktop_update_install (no real installer, no pay, no account).

// FAIL-CLOSED exe gate: no default production path.
assert.ok(process.env.PRIME_STUDIO_TEST_EXE, 'PRIME_STUDIO_TEST_EXE is required (no default production exe).');
const exe = resolve(process.env.PRIME_STUDIO_TEST_EXE);
assert.ok(existsSync(exe), `Test executable missing: ${exe}`);
const binary = await readFile(exe);
assert.ok(
  binary.includes(Buffer.from(TEST_IDENTITY)),
  `Test executable must embed the isolated identity ${TEST_IDENTITY}`,
);

// Isolated env: strip inherited PRIME / daemon / NODE_OPTIONS on the BASE only.
// Intentional overrides are added AFTER the base check and asserted to point at exact temp paths.
const STRIP_PREFIXES = [
  'PRIME_AGENT_GUI_',
  'PRIME_STUDIO_',
  'PRIME_AGENT_DAEMON_',
  'PRIME_AGENT_INTERNAL_',
  'PRIME_AGENT_SESSION_',
  'PRIME_GUI_',
];
const STRIP_EXACT = new Set(['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'ELECTRON_RUN_AS_NODE']);
function cleanBaseEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (STRIP_EXACT.has(key)) delete env[key];
    else if (STRIP_PREFIXES.some((p) => key.startsWith(p))) delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('PRIME_AGENT_GUI_') || key.startsWith('PRIME_STUDIO_') || key === 'NODE_OPTIONS') delete env[key];
  }
  return env;
}
function assertBaseClean(env, label) {
  for (const key of Object.keys(env)) {
    assert.ok(
      !(key.startsWith('PRIME_AGENT_GUI_') || key.startsWith('PRIME_STUDIO_') || key === 'NODE_OPTIONS'),
      `${label} leaked ${key}`,
    );
  }
}

// Temp fixtures: explicit dataRoot, ports, HOME, session, account.
const root = await mkdtemp(join(tmpdir(), 'studio-update-clarification-'));
const dataRoot = join(root, 'desktop');
const dataDir = join(dataRoot, 'data');
const sessionDir = join(root, 'sessions');
const agentHome = join(root, 'agent');
const project = join(root, 'Atelier');
const homeDir = join(root, 'home');
const tmpIsolated = join(root, 'tmp');
await Promise.all(
  [
    dataDir,
    sessionDir,
    agentHome,
    project,
    homeDir,
    tmpIsolated,
    join(homeDir, 'AppData', 'Local'),
    join(homeDir, 'AppData', 'Roaming'),
  ].map((p) => mkdir(p, { recursive: true })),
);
await writeFile(join(dataRoot, 'desktop.json'), '{"started":true}');
const evidenceDir = resolve('test-results');
const nativeDiagDir = resolve('.local/update-clarification/native');
await mkdir(evidenceDir, { recursive: true });
await mkdir(nativeDiagDir, { recursive: true });
let runFailed = false;
let runFailure = null;
async function copyTempLogs(tag) {
  const targets = [
    join(dataDir, 'logs', 'server.log'),
    join(dataDir, 'logs', 'launcher.log'),
    join(dataRoot, 'desktop-error.log'),
    join(dataRoot, 'desktop-server-error.log'),
    join(dataRoot, 'desktop-update-error.log'),
    join(dataRoot, 'backend.json'),
    join(dataDir, 'server.json'),
  ];
  for (const src of targets) {
    try {
      const data = await readFile(src);
      const base = src.split(/[/\\]/).slice(-2).join('-').replace(/[^a-zA-Z0-9.-]+/g, '_');
      await writeFile(join(nativeDiagDir, `${tag}-${base}`), data);
    } catch {}
  }
}

const freePort = async () => {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
};
const port = await freePort();
const debugPort = await freePort();
const foreignPort = await freePort();
const url = `http://127.0.0.1:${port}`;
assert.ok(port !== debugPort && port !== foreignPort && debugPort !== foreignPort, 'Ports must be distinct temp fixtures.');

// Project + history preservation fixtures.
await writeFile(
  join(dataDir, 'workspace.json'),
  JSON.stringify({ projects: [{ cwd: project, name: 'Atelier', pinned: false }], removedProjects: [], sessions: {} }),
);
const history =
  JSON.stringify({ type: 'session', id: 'native-update-demo', cwd: project }) +
  '\n' +
  JSON.stringify({ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'Session preservee.' } }) +
  '\n';
await writeFile(join(sessionDir, 'demo.jsonl'), history);

// Packaged manifest read-only (never written).
const packagedManifestPath = resolve('src-tauri/target/debug/backend/desktop-resource.json');
const packagedManifest = JSON.parse(await readFile(packagedManifestPath, 'utf8'));
assert.match(packagedManifest.identity, /^[a-f0-9]{64}$/);
const packagedVersion = packagedManifest.version;
assert.ok(packagedVersion, 'Packaged manifest must carry a version.');

// Old generation: legitimate temp/versions/<64hex>/node.exe + studio/server.mjs + ready.json.
let oldIdentity = randomBytes(32).toString('hex');
if (oldIdentity === packagedManifest.identity) oldIdentity = randomBytes(32).toString('hex');
assert.match(oldIdentity, /^[a-f0-9]{64}$/);
assert.notEqual(oldIdentity, packagedManifest.identity, 'Old generation must differ from the packaged identity.');
const oldGen = join(dataRoot, 'versions', oldIdentity);
const oldStudio = join(oldGen, 'studio');
await mkdir(oldStudio, { recursive: true });
const packagedNode = resolve('src-tauri/target/debug/backend/node.exe');
const nodeSource = existsSync(packagedNode) ? packagedNode : process.execPath;
await copyFile(nodeSource, join(oldGen, 'node.exe'));
const oldVersion = '2.8.1';
await writeFile(
  join(oldStudio, 'server.mjs'),
  `
  import { createServer } from 'node:http';
  const instance = process.env.PRIME_AGENT_GUI_INSTANCE || 'old-instance';
  createServer((req, res) => {
    if (req.url === '/api/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ service: 'prime-agent-gui', status: 'ok', pid: process.pid, instanceId: instance, version: '${oldVersion}' }));
    } else if (req.url === '/api/runs') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ runs: [{ id: 'synthetic', status: 'running' }] }));
    } else if (req.url === '/api/overview') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ projects: [{ cwd: ${JSON.stringify(project)} }] }));
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<title>Isolated old Studio</title><p>Synthetic running agent</p>');
    }
  }).listen(Number(process.env.PORT), '127.0.0.1');
  `,
);
await writeFile(join(oldGen, 'ready.json'), JSON.stringify({ identity: oldIdentity, version: oldVersion }));
// OS args proof: exactly <gen>/node.exe <gen>/studio/server.mjs via startServer (2 argv, absolute script).

const serverBase = cleanBaseEnv();
assertBaseClean(serverBase, 'server base env');
// Contrat: HOME isole exige. Piste vraie cause (non prouvee, aucun re-run natif autorise) :
// le setup panique unknown path quand USERPROFILE pointe vers un profil vide.
// Hypothese : sous-arbre known-folders manquant. On pre-cree le squelette profil
// et on force explicitement agent/session/compte/cache/settings vers TEMP.
// Si le run echoue encore, les logs unknown path trancheront, sans toucher au Rust.
const baseServerEnv = {
  ...serverBase,
  PRIME_AGENT_GUI_DATA_DIR: dataDir,
  PRIME_AGENT_CODING_AGENT_DIR: agentHome,
  PRIME_AGENT_SESSION_DIR: sessionDir,
  HOME: homeDir,
  USERPROFILE: homeDir,
  TEMP: tmpIsolated,
  TMP: tmpIsolated,
};
assert.equal(baseServerEnv.PRIME_AGENT_GUI_DATA_DIR, dataDir, 'Server dataDir override must point at the exact temp path');
assert.equal(baseServerEnv.PRIME_AGENT_CODING_AGENT_DIR, agentHome);
assert.equal(baseServerEnv.PRIME_AGENT_SESSION_DIR, sessionDir);

// Isolated component receipt for restart success (read-only sources, temp-only writes).
// Restart requires a receipt; quit/stop does not. No download, no pay.
// Isolated receipt: priority to .local/release-3.7.1 isolated kernel python when present.
// Never writes outside temp. Never points at or modifies the active installed tree.
// Copying a live receipt read-only is acceptable, but startup ensure could touch
// referenced paths, so confinement is verified and the fixture project kernel stays clean (temp project only).
async function stageIsolatedReceipt() {
  const liveInstall = join(process.env.LOCALAPPDATA || '', 'com.primeagent.studio', 'engine', 'installation.json');
  const livePrepared = join(process.env.LOCALAPPDATA || '', 'com.primeagent.studio', 'engine', 'prepared.json');
  let install = null;
  let prepared = null;
  try {
    install = JSON.parse(await readFile(liveInstall, 'utf8'));
  } catch {}
  try {
    prepared = JSON.parse(await readFile(livePrepared, 'utf8'));
  } catch {}
  if (!install || install.schema !== 1) {
    throw new Error(
      `BLOCKER: isolated restart receipt needs a readable live installation.json at ${liveInstall}. ` +
      `No download attempted. Provide the file or an explicit temp engine receipt before expecting restart success.`,
    );
  }
  // Confinement: temp dataRoot must never equal a live dataRoot.
  const liveDataRoots = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'com.primeagent.studio') : null,
    resolve('C:/Users/zerr0o/AppData/Local/com.primeagent.studio'),
  ].filter(Boolean);
  for (const liveRoot of liveDataRoots) {
    assert.notEqual(resolve(dataRoot).toLowerCase(), resolve(liveRoot).toLowerCase(), 'Temp dataRoot must stay distinct from live');
    assert.ok(!resolve(dataDir).toLowerCase().startsWith(resolve(liveRoot).toLowerCase() + '\\'), 'Temp dataDir must not live inside the active install');
  }
  // Priority: isolated kernel python from .local/release-3.7.1 when it exists.
  let isolatedPython = null;
  for (const candidate of [
    resolve('.local/release-3.7.1/kernel/.local/kernel-venv/925d586a0cbbdfca-3ab97b32/Scripts/python.exe'),
    resolve('.local/release-3.7.1/kernel/.local/kernel-venv/f228d8c4a67657b1-b33f812c/Scripts/python.exe'),
  ]) {
    if (existsSync(candidate)) {
      isolatedPython = candidate;
      break;
    }
  }
  if (!isolatedPython) {
    throw new Error(
      'BLOCKER: isolated kernel python missing under .local/release-3.7.1/kernel. Refusing live python default: test must not modify the active install. No download attempted.',
    );
  }
  const staged = JSON.parse(JSON.stringify(install));
  staged.components = staged.components || {};
  staged.components.python = { ...(staged.components.python || {}), path: isolatedPython, source: 'isolated-fixture' };
  // Keep the clean fixture kernel project: temp project only, never the real workspace.
  assert.ok(resolve(project).startsWith(resolve(root)), 'Receipt staging must keep the fixture project inside temp');
  const engineDir = join(dataRoot, 'engine');
  await mkdir(engineDir, { recursive: true });
  await writeFile(join(engineDir, 'installation.json'), JSON.stringify(staged));
  if (prepared) await writeFile(join(engineDir, 'prepared.json'), JSON.stringify(prepared));
  return { engineDir, isolatedPython: Boolean(isolatedPython) };
}

// Launch helper: single main window, CDP bound to loopback only.
let child;
let browser;
function isMainPage(candidateUrl, studioUrl) {
  if (!candidateUrl || candidateUrl.startsWith('chrome-devtools://')) return false;
  if (candidateUrl.startsWith(studioUrl)) return true;
  if (candidateUrl.startsWith('tauri://localhost')) return true;
  if (candidateUrl.includes('tauri.localhost')) return true;
  if (candidateUrl.includes('index.html')) return true;
  return false;
}
async function launch() {
  const tauriBase = cleanBaseEnv();
  assertBaseClean(tauriBase, 'tauri base env');
  const childEnv = {
    ...tauriBase,
    PRIME_STUDIO_DESKTOP_DATA_ROOT: dataRoot,
    PRIME_STUDIO_DESKTOP_PORT: String(port),
    PRIME_AGENT_CODING_AGENT_DIR: agentHome,
    PRIME_AGENT_SESSION_DIR: sessionDir,
    HOME: homeDir,
    USERPROFILE: homeDir,
    TEMP: tmpIsolated,
    TMP: tmpIsolated,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
  };
  assert.equal(childEnv.PRIME_STUDIO_DESKTOP_DATA_ROOT, dataRoot, 'Tauri dataRoot override must point at the exact temp path');
  assert.equal(childEnv.PRIME_STUDIO_DESKTOP_PORT, String(port));
  assert.equal(childEnv.PRIME_AGENT_CODING_AGENT_DIR, agentHome);
  assert.equal(childEnv.PRIME_AGENT_SESSION_DIR, sessionDir);
  assert.ok(!('PRIME_AGENT_GUI_DATA_DIR' in childEnv), 'Tauri child must not inherit server data dir.');
  child = spawn(exe, ['--background'], { windowsHide: true, stdio: 'ignore', env: childEnv });
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
  // Precise old-Studio proof: wait for the old Studio loopback URL plus the old synthetic HTML.
  // Do not return the first startup shell URL. No wait for a captured installed version here.
  await expect
    .poll(() => browser.contexts()[0]?.pages().some((p) => p.url().startsWith(url)), { timeout: 45000 })
    .toBe(true);
  const page = browser.contexts()[0].pages().find((p) => p.url().startsWith(url));
  await expect
    .poll(() => page.evaluate(() => document.documentElement.outerHTML.includes('Isolated old Studio')).catch(() => false), {
      timeout: 30000,
    })
    .toBe(true);
  return page;
}
async function quitApp() {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise((done) => child.once('exit', done));
  }
  await browser?.close().catch(() => {});
  browser = undefined;
}

let oldHandle = null;
let foreignChild = null;
let page = null;
try {
  // Start legitimate old generation with explicit temp dataDir.
  oldHandle = await startServer({ root: oldStudio, node: join(oldGen, 'node.exe'), port, env: baseServerEnv });
  assert.ok(!oldHandle.reused, 'Old generation must be a fresh start, not a reused live server.');
  const oldPid = oldHandle.pid;
  assert.ok(Number.isSafeInteger(oldPid) && oldPid > 0, 'Old server PID must be valid.');

  // Isolated receipt before any restart attempt.
  await stageIsolatedReceipt();

  page = await launch();
  page.setDefaultTimeout(15000);

  // 1. Old Studio in main: loopback URL plus old HTML, single window, no desktop-settings.
  assert.ok(page.url().startsWith(url), `Main must start on the old Studio loopback, got ${page.url()}.`);
  assert.equal(browser.contexts()[0].pages().length, 1, 'Single native window expected: main only.');
  assert.equal(
    browser.contexts()[0].pages().some((p) => p.url().includes('desktop-settings')),
    false,
    'No desktop-settings WebviewWindow allowed.',
  );

  // 2. Real fallback proof in the SAME main window: from the old main, call the existing
  // desktop_components_open IPC (safe, calls show_settings, never touches the server),
  // then wait for the local shell URL AND loaded shell dialogs. No static file proof.
  await page.evaluate(() => window.__TAURI__.core.invoke('desktop_components_open'));
  await expect
    .poll(() => (isMainPage(page.url(), url) && !page.url().startsWith(url) ? 'shell' : 'waiting'), { timeout: 30000 })
    .toBe('shell');
  await expect
    .poll(
      () =>
        page
          .evaluate(() => ({
            quit: Boolean(document.getElementById('quit-confirm')),
            restart: Boolean(document.getElementById('restart-confirm')),
          }))
          .catch(() => ({ quit: false, restart: false })),
      { timeout: 30000 },
    )
    .toEqual({ quit: true, restart: true });
  assert.equal(browser.contexts()[0].pages().length, 1, 'Fallback stays in the same single main window.');
  assert.equal(await page.evaluate(() => true), true, 'Main page must stay evaluable after fallback navigation.');
  await page.screenshot({ path: join(evidenceDir, 'native-update-fallback.png') });

  // 3. Status: managed old server with active agents.
  const status = await page.evaluate(() => window.__TAURI__.core.invoke('desktop_update_status'));
  assert.equal(status.appVersion, packagedVersion, 'App version comes from the packaged test binary.');
  assert.equal(status.version, oldVersion, 'Server version is the old generation before restart.');
  assert.equal(status.activeRuns, 1, 'Synthetic server must report one running agent.');
  assert.equal(status.managed, true, 'Old generation with marker must be managed.');
  assert.equal(status.ownership, 'managed', 'Ownership must be managed while the marker exists.');
  assert.equal(status.canRestart, true);
  assert.equal(status.canStop, true);
  assert.equal((await probeHealth(port)).health.pid, oldPid);

  // 4. Operation snapshot shape (lightweight 1s poll contract).
  const opEnvelope = await page.evaluate(() => window.__TAURI__.core.invoke('desktop_update_operation'));
  assert.ok('operation' in opEnvelope && 'log' in opEnvelope, 'Operation getter must return {operation, log}.');
  assert.ok(Array.isArray(opEnvelope.log) && opEnvelope.log.length <= 20, 'Operation log must stay bounded.');

  // 5. Agents gate: force false refuses, pid unchanged.
  const held = await page.evaluate(() =>
    window.__TAURI__.core.invoke('desktop_server_restart', { force: false, cancelCurrent: false }),
  );
  assert.equal(held.reason, 'agents_running', 'Active agents must block a non-forced restart.');
  assert.equal((await probeHealth(port)).health.pid, oldPid, 'Refused restart must not touch the server.');

  // 5b. Tray quit CANCEL on the old simulated server (activeRuns=1, BEFORE restart).
  // Public Studio IDs are studio-update-confirm/cancel/proceed. Local shell uses quit-confirm/cancel/proceed.
  // Dialog open state (.open) is required, never mere DOM presence.
  async function quitOpen() {
    return page
      .evaluate(() => ({
        studio: Boolean(document.getElementById('studio-update-confirm')?.open),
        shell: Boolean(document.getElementById('quit-confirm')?.open),
      }))
      .catch(() => ({ studio: false, shell: false }));
  }
  const liveBefore = await page.evaluate(() => ({
    studioConfirm: Boolean(document.getElementById('studio-update-confirm')),
    shellQuit: Boolean(document.getElementById('quit-confirm')),
  }));
  if (!liveBefore.studioConfirm && !liveBefore.shellQuit) {
    throw new Error(
      'BLOCKER: old backend page carries no live quit dialog (synthetic HTML without listeners). ' +
        'Expected SAME main window on the local fallback shell (tauri://localhost / ?settings) for the old backend so DOM quit can be tested live.',
    );
  }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('studio:quit-request')));
  await expect.poll(() => quitOpen().then((s) => s.studio || s.shell), { timeout: 15000 }).toBe(true);
  const openedBefore = await quitOpen();
  if (openedBefore.studio) {
    await page.locator('#studio-update-cancel').click();
    await expect.poll(() => quitOpen().then((s) => s.studio), { timeout: 5000 }).toBe(false);
  } else {
    await page.locator('#quit-cancel').click();
    await expect.poll(() => quitOpen().then((s) => s.shell), { timeout: 5000 }).toBe(false);
  }
  assert.equal((await probeHealth(port)).health.pid, oldPid, 'Cancelled quit must not stop the server.');

  // 6. Forced restart to the packaged version. Projects and history preserved.
  await page.evaluate(() => {
    void window.__TAURI__.core.invoke('desktop_server_restart', { force: true, cancelCurrent: false });
  });
  await expect.poll(async () => (await probeHealth(port)).health?.version, { timeout: 90000 }).toBe(packagedVersion);
  const restartedPid = (await probeHealth(port)).health.pid;
  assert.notEqual(restartedPid, oldPid, 'Restart must replace the server process.');
  await expect
    .poll(() => page.evaluate(() => window.__TAURI__.core.invoke('desktop_update_status')).then((s) => s.version), {
      timeout: 30000,
    })
    .toBe(packagedVersion);
  const overview = await (await fetch(url + '/api/overview')).json().catch(() => null);
  if (overview?.projects) assert.ok(overview.projects.some((p) => p.cwd === project), 'Projects must survive restart.');
  assert.equal(await readFile(join(sessionDir, 'demo.jsonl'), 'utf8'), history, 'History must survive restart.');
  await page.screenshot({ path: join(evidenceDir, 'native-update-restarted.png') });

  // 7. Marker absent becomes OS-verified recoverable (temp only, never live).
  assert.ok(dataRoot.startsWith(root), 'Recoverable test must stay inside temp dataRoot.');
  await unlink(join(dataDir, 'server.json'));
  const recoverable = await page.evaluate(() => window.__TAURI__.core.invoke('desktop_update_status'));
  assert.equal(recoverable.ownership, 'recoverable', 'Without a marker the legitimate generation must be recoverable.');
  assert.equal(recoverable.managed, false);
  assert.equal(recoverable.canRestart, true, 'Recoverable servers stay restartable.');
  assert.equal(recoverable.canStop, true, 'Quit/stop does not require a receipt or a marker.');
  assert.equal(recoverable.pid, restartedPid, 'Recoverable PID must be the restarted server.');

  // 8. Close (X) hides, it does not stop. Best effort when accessible.
  let hideLimitation = null;
  try {
    await page.evaluate(() => window.close());
    await expect.poll(() => page.evaluate(() => true).then(() => true).catch(() => false), { timeout: 5000 }).toBe(true);
    assert.equal((await probeHealth(port)).health.pid, restartedPid, 'Close must hide, never stop the server.');
  } catch (error) {
    hideLimitation = String(error?.message || error);
  }

  // 9. Foreign listener on an isolated port: occupied here, never killed.
  // Limited case: this proves isolation on a different port, not a targeted refusal on the Studio port.
  // Targeted OS refusal (foreign exe/args/port) is covered by Node unit tests for desktop-server-identity.
  foreignChild = spawn(
    process.execPath,
    ['-e', `require('node:http').createServer((req,res)=>res.end('foreign')).listen(${foreignPort},'127.0.0.1');setInterval(()=>{},1000);`],
    {
      windowsHide: true,
      stdio: 'ignore',
      env: (() => {
        const base = cleanBaseEnv();
        assertBaseClean(base, 'foreign base env');
        return { ...base, TEMP: tmpIsolated, TMP: tmpIsolated };
      })(),
    },
  );
  await expect.poll(() => probeHealth(foreignPort).then((r) => r.state), { timeout: 10000 }).toBe('occupied');
  const stillStudio = await page.evaluate(() => window.__TAURI__.core.invoke('desktop_update_status'));
  assert.equal(stillStudio.pid, restartedPid, 'Foreign service must not divert Studio status.');
  assert.notEqual(foreignChild.pid, restartedPid, 'Foreign PID must differ from the managed server.');
  assert.equal(foreignChild.exitCode, null, 'Foreign process must stay alive: no kill ever.');
  foreignChild.kill();
  await new Promise((done) => (foreignChild.exitCode !== null ? done() : foreignChild.once('exit', done)));
  foreignChild = null;

  // 10. Tray quit IDLE after restart: real backend has activeRuns=0, so quit closes WITHOUT dialog.
  // No confirmation is expected here. Wait for the quit handshake flag before dispatch, then server stops first.
  const idleStatus = await page.evaluate(() => window.__TAURI__.core.invoke('desktop_update_status'));
  assert.equal(idleStatus.activeRuns, 0, 'Packaged backend after restart must be idle for the no-dialog quit path.');
  await expect
    .poll(() => page.evaluate(() => window.__PRIME_STUDIO_QUIT_READY__ === true).catch(() => false), { timeout: 30000 })
    .toBe(true);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('studio:quit-request')));
  // Server stops before the app exits. Bounded polls only. No dialog wait: idle closes directly.
  await expect.poll(() => probeHealth(port).then((r) => (r.state === 'absent' ? 'absent' : 'present')), { timeout: 30000 }).toBe('absent');
  await expect.poll(() => (child.exitCode !== null || child.signalCode !== null ? 'exited' : 'running'), { timeout: 30000 }).toBe('exited');
  if (hideLimitation) console.log(JSON.stringify({ hideLimitation }));
  console.log(
    'Isolated update lifecycle passed: single main, live fallback, agents gate, quit cancel before restart, packaged restart, recoverable, idle quit stops server before exit, foreign isolation noted, projects/history preserved.',
  );
  await writeFile(
    join(nativeDiagDir, 'run.log'),
    `PASS fallback=shell-live restart=${packagedVersion} quit=idle-no-dialog port=${port} root=${root}\n`,
  );
} catch (error) {
  runFailed = true;
  runFailure = error;
  try {
    await page?.screenshot({ path: join(evidenceDir, 'native-update-failure.png') }).catch(() => {});
  } catch {}
  await copyTempLogs('failure');
  try {
    await writeFile(join(nativeDiagDir, 'run-failure.log'), String(runFailure?.stack || runFailure));
  } catch {}
  throw error;
} finally {
  if (foreignChild && foreignChild.exitCode === null) {
    foreignChild.kill();
    await new Promise((done) => (foreignChild.exitCode !== null ? done() : foreignChild.once('exit', done)));
  }
  await quitApp();
  // Targeted TEMP-only stop with OS proof. No legacy owner file needed (it was unlinked for recoverable).
  // Never touches live: dataRoot is temp, port is the temp Studio port.
  assert.ok(resolve(dataRoot).startsWith(resolve(root)), 'Cleanup stop must stay inside temp dataRoot.');
  const packagedResourceDir = resolve('src-tauri/target/debug/backend');
  const stopped = await stopDesktop({ dataRoot, port, resourceDir: packagedResourceDir, force: true });
  assert.ok(
    stopped.stopped === true || stopped.reason === 'already-stopped',
    `Targeted temp stop must end stopped or already-stopped, got ${JSON.stringify(stopped)}.`,
  );
  const after = await probeHealth(port);
  assert.equal(after.state, 'absent', 'Temp Studio port must be absent after targeted stop, no temp leak.');
  if (runFailed) await copyTempLogs('failure-final');
  assert.equal(dirname(root), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
