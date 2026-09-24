import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDirectoryOpener } from '../lib/open-directory.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-folder-unit-'));
  const folder = join(root, "dossier é & [notes], l'atelier (1)");
  await mkdir(folder);
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, folder };
}

test('Windows opens through a hidden helper with a literal Unicode path and requires foreground Explorer confirmation', async (t) => {
  const { folder } = await fixture(t);
  let launch;
  const open = createDirectoryOpener({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', PRIME_GUI_SILENT: '1' },
    run: async (...args) => {
      launch = args;
      return { stdout: '{"opened":true,"visible":true,"foreground":true}\r\n' };
    },
  });
  assert.deepEqual(await open(folder), { opened: true });
  const [command, args, options] = launch;
  assert.match(command, /powershell\.exe$/);
  assert.match(args.at(-1), /open-directory\.ps1$/);
  assert.equal(args.includes(folder), false);
  assert.equal(args.includes('-Command'), false);
  assert.equal(options.env.PRIME_STUDIO_OPEN_DIRECTORY, folder);
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, false);
  assert.ok(options.timeout > 0 && options.timeout <= 15000);
});

test('failed, timed out, or unconfirmed Explorer launches never report success and can be retried', async (t) => {
  const { folder } = await fixture(t);
  let outcome;
  const open = createDirectoryOpener({
    platform: 'win32',
    run: async () => {
      if (outcome instanceof Error) throw outcome;
      return { stdout: outcome };
    },
  });
  for (outcome of [
    new Error('launch failed'),
    new Error('timeout'),
    '',
    '{"opened":true}',
    '{"opened":true,"visible":false}',
    '{"opened":true,"visible":true}',
    '{"opened":true,"visible":true,"foreground":false}',
    'not-json',
  ]) {
    await assert.rejects(open(folder), { status: 502 });
  }
  outcome = '{"opened":true,"visible":true,"foreground":true}';
  assert.deepEqual(await open(folder), { opened: true });
});

test('rapid requests for one folder share a launch and invalid folders never start a helper', async (t) => {
  const { root, folder } = await fixture(t);
  let complete,
    launches = 0;
  const open = createDirectoryOpener({
    platform: 'win32',
    run: () => {
      launches++;
      return new Promise((done) => {
        complete = done;
      });
    },
  });
  const jobs = [open(folder), open(folder), open(folder)];
  while (!complete) await new Promise((done) => setTimeout(done, 5));
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(launches, 1);
  complete({ stdout: '{"opened":true,"visible":true,"foreground":true}' });
  assert.deepEqual(await Promise.all(jobs), [{ opened: true }, { opened: true }, { opened: true }]);
  const file = join(root, 'not-a-folder.txt');
  await writeFile(file, 'fixture');
  for (const path of [file, join(root, 'missing'), 'relative-path', null])
    await assert.rejects(open(path), { status: 400 });
  assert.equal(launches, 1);
});

test('other desktop openers report nonzero command failures instead of treating process creation as success', async (t) => {
  const { folder } = await fixture(t);
  for (const platform of ['darwin', 'linux']) {
    let fail = false;
    const open = createDirectoryOpener({
      platform,
      run: async (command, args, options) => {
        assert.equal(command, platform === 'darwin' ? 'open' : 'xdg-open');
        assert.deepEqual(args, [folder]);
        assert.equal(options.shell, false);
        if (fail) throw new Error('exit 1');
        return { stdout: '' };
      },
    });
    assert.deepEqual(await open(folder), { opened: true });
    fail = true;
    await assert.rejects(open(folder), { status: 502 });
  }
});
