// Opt-in Windows desktop test. Opens and closes only its own PowerShell child.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTerminalOpener } from '../lib/open-terminal.mjs';
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'prime-terminal-native-'));
const folder = join(root, "dossier é & [notes], l'atelier (1); $test");
await mkdir(folder);
let helperPid;
try {
  const open = createTerminalOpener({
    run: (file, args, options) =>
      new Promise((resolve, reject) => {
        const child = execFile(file, args, options, (error, stdout, stderr) =>
          error ? reject(error) : resolve({ stdout, stderr }),
        );
        helperPid = child.pid;
      }),
  });
  assert.deepEqual(await open(folder), { opened: true });
  const result = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'test/fixtures/terminal-window.ps1',
      '-HelperPid',
      String(helperPid),
    ],
    {
      env: { ...process.env, PRIME_STUDIO_OPEN_TERMINAL: folder },
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf8',
    },
  );
  console.log(result.stdout);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
