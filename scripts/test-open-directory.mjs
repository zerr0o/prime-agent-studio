// Opt-in Windows desktop test: opens and closes only a disposable fixture folder.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { agentEnvironment } from '../lib/agent.mjs';

if (process.platform !== 'win32') throw new Error('Ce scénario nécessite le bureau Windows.');
const run = promisify(execFile),
  workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(tmpdir(), 'prime-studio-explorer-'));
const folder = join(root, "dossier é & [notes], l'atelier (1); $test");
await mkdir(folder);
const env = { ...agentEnvironment(), PRIME_STUDIO_TEST_FOLDER: folder };
const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe',
);
async function windows(mode = 'inspect') {
  const { stdout } = await run(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(workspace, 'test/fixtures/explorer-window.ps1'),
      '-Mode',
      mode,
    ],
    { env, windowsHide: true, timeout: 12000 },
  );
  return JSON.parse(stdout.trim());
}
async function openFromHiddenProcess() {
  const { stdout } = await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { openDirectory } from './lib/open-directory.mjs'; const path = process.env.PRIME_STUDIO_TEST_FOLDER; console.log(JSON.stringify(await Promise.all([openDirectory(path), openDirectory(path)])));",
    ],
    { cwd: workspace, env, windowsHide: true, shell: false, timeout: 20000 },
  );
  assert.deepEqual(JSON.parse(stdout.trim()), [{ opened: true }, { opened: true }]);
}
try {
  assert.deepEqual(await windows(), []);
  await openFromHiddenProcess();
  const first = await windows();
  assert.equal(first.length, 1);
  assert.equal(first[0].visible, true);
  assert.equal(first[0].minimized, false);
  assert.equal(first[0].foreground, true, 'Explorer must be in the foreground, not just visible.');
  assert.equal((await windows('hide'))[0].visible, false);
  await openFromHiddenProcess();
  assert.deepEqual(
    await windows(),
    first,
    'An old hidden Explorer window must be restored without creating another one.',
  );
  assert.equal((await windows('minimize'))[0].minimized, true);
  await openFromHiddenProcess();
  assert.deepEqual(await windows(), first, 'A minimized folder must be restored to the foreground.');
  await openFromHiddenProcess();
  assert.deepEqual(await windows(), first, 'An already visible folder must be reused.');
  console.log(
    JSON.stringify({
      passed: true,
      realExplorer: true,
      hiddenLauncher: true,
      unicodeAndLiteralPath: true,
      restoredHiddenWindow: true,
      restoredMinimizedWindow: true,
      foregroundVerified: true,
      reusedExistingWindow: true,
      agentSessionsTouched: 0,
    }),
  );
} finally {
  await windows('close');
  for (let i = 0; i < 10 && (await windows()).length; i++) await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual(
    await windows(),
    [],
    'The fixture Explorer window must be closed before deleting its directory.',
  );
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(root.startsWith(join(tmpdir(), 'prime-studio-explorer-')));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
