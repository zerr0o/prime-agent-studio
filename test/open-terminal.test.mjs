import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createTerminalOpener } from '../lib/open-terminal.mjs';
import { createApp } from '../server.mjs';
import { messages } from '../public/translations.js';
import { desktopRuntimeScripts } from '../scripts/desktop-runtime-resources.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

test('terminal helper validates the folder before launching anything', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-terminal-'));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let calls = 0;
  const open = createTerminalOpener({
    platform: 'win32',
    run: async () => {
      calls++;
      return { stdout: '{"opened":true}' };
    },
  });
  await assert.rejects(open('relative/path'), { status: 400 });
  await assert.rejects(open(join(root, 'missing')), { status: 400 });
  assert.equal(calls, 0);
});

test('terminal helper is Windows only', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-terminal-'));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let calls = 0;
  const open = createTerminalOpener({
    platform: 'darwin',
    run: async () => {
      calls++;
      return { stdout: '{}' };
    },
  });
  const error = await open(root).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(error);
  assert.equal(error.status, 404);
  assert.equal(calls, 0);
});

test('terminal helper hides only itself and keeps the folder out of command text', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-terminal-'));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const seen = [];
  const open = createTerminalOpener({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    run: async (exe, args, options) => {
      seen.push({ exe, args, options });
      return { stdout: '{"opened":true}' };
    },
  });
  assert.deepEqual(await open(root), { opened: true });
  assert.equal(seen.length, 1);
  const [call] = seen;
  assert.match(call.exe, /powershell\.exe$/i);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.ok(call.args.includes('-File'));
  assert.ok(call.args.some((arg) => String(arg).endsWith('open-terminal.ps1')));
  assert.equal(call.options.env.PRIME_STUDIO_OPEN_TERMINAL, root);
  assert.ok(!call.args.some((arg) => String(arg).includes(root)), 'folder must not be in argv');
});

test('terminal helper reports failures without leaking details and dedupes concurrent calls', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-terminal-'));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let calls = 0;
  const failing = createTerminalOpener({
    platform: 'win32',
    run: async () => {
      calls++;
      await delay(30);
      return { stdout: 'not json' };
    },
  });
  const [first, second] = await Promise.allSettled([failing(root), failing(root)]);
  assert.equal(first.status, 'rejected');
  assert.equal(second.status, 'rejected');
  assert.equal(first.reason.status, 502);
  assert.equal(calls, 1);
});

test('terminal helper script requests a visible PowerShell at the folder', async () => {
  const script = await readFile(new URL('../scripts/open-terminal.ps1', import.meta.url), 'utf8');
  assert.match(script, /ShellExecuteW/);
  assert.match(script, /-NoExit -Command/);
  assert.ok(script.includes('Set-Location -LiteralPath $env:PRIME_STUDIO_OPEN_TERMINAL'));
  assert.match(script, /, 1\)/);
  assert.match(script, /Test-Path -LiteralPath/);
  assert.ok(!script.includes('Invoke-Expression'));
});

test('terminal translations, menu, and packaged helper stay in sync', async () => {
  for (const key of [
    'ui.ouvrir_powershell_ici',
    'ui.powershell_ouvert_sur_le_pc',
    'server.powershell_uniquement_sur_windows',
    'server.impossible_d_ouvrir_powershell_reessayez',
  ]) {
    assert.ok(messages[key]?.fr?.trim(), key);
    assert.ok(messages[key]?.en?.trim(), key);
  }
  const menu = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(menu, /data-project-action="terminal"/);
  assert.match(menu, /ui\.ouvrir_powershell_ici/);
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\/api\/projects\/open-terminal/);
  assert.match(app, /ui\.powershell_ouvert_sur_le_pc/);
  const lan = await readFile(new URL('../lib/lan.mjs', import.meta.url), 'utf8');
  assert.ok(lan.includes("'/api/projects/open-terminal'"));
  assert.ok(desktopRuntimeScripts.includes('open-terminal.ps1'));
  await readFile(new URL('../scripts/open-terminal.ps1', import.meta.url), 'utf8');
});

function fakeRuntime() {
  return {
    async getStatus() {
      return { available: true, version: 'fixture', nodeVersion: process.versions.node };
    },
    async getModels() {
      return { models: [], default: {} };
    },
    async start() {
      throw new Error('no runs in this fixture');
    },
    async close() {},
  };
}

async function fixture(t, extraOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-terminal-server-'));
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  const app = createApp({
    agentHome: join(root, 'agent'),
    sessionDir: join(root, 'sessions'),
    dataDir: join(root, 'data'),
    initialCwd: cwd,
    runtime: fakeRuntime(),
    ...extraOptions,
  });
  await mkdir(join(root, 'sessions'), { recursive: true });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function api(path, { method = 'GET', body } = {}) {
    return new Promise((done, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            text += chunk;
          });
          response.on('end', () => {
            let json;
            try {
              json = JSON.parse(text);
            } catch {}
            done({ status: response.statusCode, json, text });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }
  return { app, api, cwd, root };
}

test('project terminal route opens the registered workspace folder', async (t) => {
  const opened = [];
  const f = await fixture(t, {
    openTerminal: async (path) => {
      opened.push(path);
      return { opened: true };
    },
  });
  const ok = await f.api('/api/projects/open-terminal', { method: 'POST', body: { cwd: f.cwd } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { opened: true });
  assert.deepEqual(opened, [f.cwd]);
  assert.equal(
    (await f.api('/api/projects/open-terminal', { method: 'POST', body: { cwd: 'relative' } })).status,
    400,
  );
  assert.equal(
    (await f.api('/api/projects/open-terminal', { method: 'POST', body: { cwd: join(f.root, 'unknown') } }))
      .status,
    404,
  );
  assert.deepEqual(opened, [f.cwd]);
});

test('project terminal route surfaces helper failures as 502', async (t) => {
  const f = await fixture(t, {
    openTerminal: async () => {
      const error = new Error('nope');
      error.status = 502;
      throw error;
    },
  });
  assert.equal(
    (await f.api('/api/projects/open-terminal', { method: 'POST', body: { cwd: f.cwd } })).status,
    502,
  );
});
