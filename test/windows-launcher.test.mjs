import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { startServer } from '../scripts/start-server.mjs';
import { stopServer } from '../scripts/stop-server.mjs';
import { APP_ROOT, parsePort, probeHealth, pathsFor, readJson } from '../scripts/launcher-common.mjs';

const execFileAsync = promisify(execFile);

// Isolation: snapshot the ambient production owner marker before cleansing,
// then remove inherited launcher env so no test can read or write prod data.
// The ambient file is only read here (readonly CLI) and asserted untouched.
const AMBIENT_DATA_DIR = process.env.PRIME_AGENT_GUI_DATA_DIR;
const ambientOwnershipPath = AMBIENT_DATA_DIR ? resolve(AMBIENT_DATA_DIR, 'server.json') : null;
let ambientExisted = false;
let ambientContent = null;
try {
  if (ambientOwnershipPath && existsSync(ambientOwnershipPath)) {
    ambientExisted = true;
    ambientContent = await readFile(ambientOwnershipPath, 'utf8');
  }
} catch {
  ambientExisted = false;
  ambientContent = null;
}

for (const key of Object.keys(process.env)) {
  if (
    key.startsWith('PRIME_AGENT_') ||
    key.startsWith('PRIME_STUDIO_') ||
    key === 'NODE_OPTIONS'
  ) {
    delete process.env[key];
  }
}
// Session and home dirs must not leak into fixtures either.
for (const key of ['PRIME_AGENT_SESSION_DIR']) {
  delete process.env[key];
}
assert.equal(process.env.PRIME_AGENT_GUI_DATA_DIR, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);

function childEnv(extra = {}) {
  const keep = [
    'PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'TEMP', 'TMP',
    'OS', 'PATHEXT', 'COMSPEC', 'ProgramFiles', 'PROGRAMFILES',
    'ProgramFiles(x86)', 'ProgramData', 'USERPROFILE', 'SystemDrive',
  ];
  const env = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    PRIME_AGENT_GUI_NODE: process.execPath,
    PRIME_AGENT_GUI_NONINTERACTIVE: '1',
    ...extra,
  };
}

function assertIsolatedPath(p, temporary) {
  assert.ok(resolve(p).startsWith(resolve(temporary) + '\\') || resolve(p).startsWith(resolve(temporary) + '/') || resolve(p).startsWith(resolve(temporary)));
  if (ambientOwnershipPath) assert.notEqual(resolve(p), resolve(ambientOwnershipPath));
}

async function assertAmbientUntouched() {
  if (!ambientOwnershipPath) return;
  const nowExists = existsSync(ambientOwnershipPath);
  assert.equal(nowExists, ambientExisted, 'ambient production owner file must stay untouched');
  if (ambientExisted) {
    assert.equal(await readFile(ambientOwnershipPath, 'utf8'), ambientContent);
  }
}

async function listen(server) {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'prime-studio-launcher-'));
  const root = join(temporary, 'dossier avec espaces et accent e');
  const dataDir = join(root, '.local');
  await mkdir(join(root, 'scripts'), { recursive: true });
  const source = `
    import { createServer } from 'node:http';
    import { spawn } from 'node:child_process';
    const children = [];
    const server = createServer((req, res) => {
      if (req.url === '/child') {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          windowsHide: true, stdio: 'ignore', shell: false,
        });
        children.push(child);
        res.end(JSON.stringify({ pid: child.pid }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ service: 'prime-agent-gui', status: 'ok', pid: process.pid,
        instanceId: process.env.PRIME_AGENT_GUI_INSTANCE || null }));
    });
    server.listen(Number(process.env.PORT), '127.0.0.1');
    process.on('SIGTERM', () => {
      for (const child of children) child.kill();
      server.close(() => process.exit(0));
    });
  `;
  await writeFile(join(root, 'server.mjs'), source);
  for (const script of ['launcher-common.mjs', 'start-server.mjs', 'stop-server.mjs']) {
    await copyFile(join(APP_ROOT, 'scripts', script), join(root, 'scripts', script));
  }
  for (const script of ['Lancer Prime Agent.vbs', 'Arreter Prime Agent.vbs']) {
    await copyFile(join(APP_ROOT, script), join(root, script));
  }
  const port = await freePort();
  const env = childEnv({ PRIME_AGENT_GUI_DATA_DIR: dataDir, PORT: String(port) });
  const ownership = pathsFor(root, dataDir).ownership;
  assertIsolatedPath(ownership, temporary);
  t.after(async () => {
    await stopServer({ root, dataDir }).catch(() => {});
    await assertAmbientUntouched();
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(temporary.includes('prime-studio-launcher-'));
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return { root, dataDir, env, port };
}

test('launcher validates ports before creating a process', async (t) => {
  assert.equal(parsePort('3088'), 3088);
  assert.equal(parsePort(65535), 65535);
  for (const invalid of [0, -1, 65536, '3088;calc', '1.5', 'abc', '']) {
    assert.throws(() => parsePort(invalid), /PORT/);
  }
  await assertAmbientUntouched();
});

test('health probe distinguishes Prime Agent Studio, a foreign port and no listener', async (t) => {
  const ours = createServer((_req, response) =>
    response.end(JSON.stringify({ service: 'prime-agent-gui', status: 'ok' })),
  );
  const foreign = createServer((_req, response) => response.end('<html>Another application</html>'));
  const silent = createServer(() => {});
  try {
    const ownPort = await listen(ours);
    const foreignPort = await listen(foreign);
    const silentPort = await listen(silent);
    assert.equal((await probeHealth(ownPort)).state, 'ready');
    assert.equal((await probeHealth(foreignPort)).state, 'occupied');
    assert.equal((await probeHealth(silentPort, { timeout: 50 })).state, 'occupied');
    const unused = await freePort();
    assert.equal((await probeHealth(unused)).state, 'absent');
  } finally {
    await Promise.all([close(ours), close(foreign), close(silent)]);
  }
  await assertAmbientUntouched();
});

test('isolated fixture never touches the ambient production owner file', async (t) => {
  const options = await fixture(t);
  assertIsolatedPath(pathsFor(options.root, options.dataDir).ownership, options.root);
  if (ambientOwnershipPath) assert.notEqual(resolve(pathsFor(options.root, options.dataDir).ownership), resolve(ambientOwnershipPath));
  assert.equal(process.env.PRIME_AGENT_GUI_DATA_DIR, undefined);
  assert.equal(process.env.NODE_OPTIONS, undefined);
  assert.ok(!('PRIME_AGENT_GUI_DATA_DIR' in process.env));
  await assertAmbientUntouched();
});

test('simultaneous launches reuse one detached server in a path with spaces and accents', async (t) => {
  const options = await fixture(t);
  const startOptions = () => ({ root: options.root, port: options.port, env: options.env });
  const [first, second] = await Promise.all([startServer(startOptions()), startServer(startOptions())]);
  assert.equal(first.pid, second.pid);
  assert.equal([first.reused, second.reused].filter(Boolean).length, 1);
  assert.notEqual(first.pid, process.pid);
  const record = await readJson(pathsFor(options.root, options.dataDir).ownership);
  assert.equal(record.pid, first.pid);
  assert.equal(record.port, options.port);
  assert.match(record.instanceId, /^[a-f0-9-]{36}$/);
  assert.equal((await probeHealth(options.port)).health.instanceId, record.instanceId);
  assert.ok((await stat(pathsFor(options.root, options.dataDir).serverLog)).isFile());
  assert.equal((await stopServer({ root: options.root, dataDir: options.dataDir })).stopped, true);
  assert.equal((await probeHealth(options.port)).state, 'absent');
  assert.equal(await readJson(pathsFor(options.root, options.dataDir).ownership), null);
  assert.equal((await stopServer({ root: options.root, dataDir: options.dataDir })).stopped, false);
  await assertAmbientUntouched();
});

test('stop refuses a stale ownership marker even when the PID matches', async (t) => {
  const options = await fixture(t);
  await startServer({ root: options.root, port: options.port, env: options.env });
  const ownership = pathsFor(options.root, options.dataDir).ownership;
  const original = await readFile(ownership, 'utf8');
  const record = JSON.parse(original);
  record.instanceId = 'a-stale-instance-marker';
  await writeFile(ownership, JSON.stringify(record));
  try {
    await assert.rejects(stopServer({ root: options.root, dataDir: options.dataDir }), /ne correspond pas/);
    assert.equal((await probeHealth(options.port)).state, 'ready');
  } finally {
    await writeFile(ownership, original);
  }
  await assertAmbientUntouched();
});

test('start refuses an occupied foreign port without launching a server', async (t) => {
  const options = await fixture(t);
  const foreign = createServer((_req, response) => response.end('foreign application'));
  options.port = await listen(foreign);
  options.env = childEnv({ PRIME_AGENT_GUI_DATA_DIR: options.dataDir, PORT: String(options.port) });
  try {
    await assert.rejects(
      startServer({ root: options.root, port: options.port, env: options.env }),
      /autre application/,
    );
    assert.equal(await readJson(pathsFor(options.root, options.dataDir).ownership), null);
    assert.equal((await probeHealth(options.port)).state, 'occupied');
  } finally {
    await close(foreign);
  }
  await assertAmbientUntouched();
});

test('a startup failure produces a useful log and releases the launch lock', async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.root, 'server.mjs'), 'throw new Error("fixture startup failure");\n');
  await assert.rejects(
    startServer({ root: options.root, port: options.port, env: options.env }),
    /demarrage|démarrage/,
  );
  assert.match(await readFile(pathsFor(options.root, options.dataDir).serverLog, 'utf8'), /fixture startup failure/);
  assert.equal(await readJson(pathsFor(options.root, options.dataDir).lock), null);
  assert.equal((await probeHealth(options.port)).state, 'absent');
  await assertAmbientUntouched();
});

test(
  'Windows VBS starts and stops without a shell, and stop also closes agent descendants',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const options = await fixture(t);
    const env = childEnv({ PORT: String(options.port), PRIME_AGENT_GUI_DATA_DIR: options.dataDir });
    await execFileAsync(
      'cscript.exe',
      ['//NoLogo', join(options.root, 'Lancer Prime Agent.vbs'), '--no-browser'],
      {
        env,
        windowsHide: true,
        timeout: 30000,
      },
    );
    const health = await probeHealth(options.port);
    assert.equal(health.state, 'ready');
    const response = await fetch(`http://127.0.0.1:${options.port}/child`);
    const child = await response.json();
    assert.ok(child.pid > 0);
    await execFileAsync('cscript.exe', ['//NoLogo', join(options.root, 'Arreter Prime Agent.vbs')], {
      env,
      windowsHide: true,
      timeout: 30000,
    });
    assert.equal((await probeHealth(options.port)).state, 'absent');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    await assertAmbientUntouched();
  },
);

test(
  'shortcut installer creates a working launcher shortcut in the requested directory',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const options = await fixture(t);
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(APP_ROOT, 'scripts', 'install-shortcut.ps1'),
        '-Destination',
        options.root,
      ],
      { windowsHide: true },
    );
    const shortcut = join(options.root, 'Prime Agent Studio.lnk');
    assert.ok((await stat(shortcut)).size > 0);
    const script = [
      '$studioShell = New-Object -ComObject WScript.Shell',
      '$studioShortcut = $studioShell.CreateShortcut($env:STUDIO_TEST_SHORTCUT)',
      '@{ target = $studioShortcut.TargetPath; arguments = $studioShortcut.Arguments; cwd = $studioShortcut.WorkingDirectory; icon = $studioShortcut.IconLocation } | ConvertTo-Json -Compress',
    ].join('\n');
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      env: childEnv({ STUDIO_TEST_SHORTCUT: shortcut }),
    });
    const metadata = JSON.parse(result.stdout.replace(/^﻿/, ''));
    assert.match(metadata.target, /wscript\.exe$/i);
    assert.equal(metadata.arguments, `"${join(APP_ROOT, 'Lancer Prime Agent.vbs')}"`);
    assert.equal(metadata.cwd, APP_ROOT);
    assert.equal(metadata.icon, `${join(APP_ROOT, 'assets', 'prime-agent.ico')},0`);
    await assertAmbientUntouched();
  },
);

test('noninteractive VBS failures exit promptly without displaying a dialog',
  { skip: process.platform !== 'win32' }, async (t) => {
    const options = await fixture(t);
    const env = childEnv({ PRIME_AGENT_GUI_DATA_DIR: options.dataDir });
    for (const [script, launcher] of [
      ['start-server.mjs', 'Lancer Prime Agent.vbs'],
      ['stop-server.mjs', 'Arreter Prime Agent.vbs'],
    ]) {
      await writeFile(join(options.root, 'scripts', script), 'process.exit(7);\n');
      await assert.rejects(execFileAsync('cscript.exe',
        ['//NoLogo', join(options.root, launcher), '--no-browser'],
        { env, windowsHide: true, timeout: 3000 }), (error) => error.code === 7 && !error.killed);
    }
    await assertAmbientUntouched();
  });
