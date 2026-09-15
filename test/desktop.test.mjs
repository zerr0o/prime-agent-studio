import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startDesktop, importLegacyData } from '../scripts/desktop-start.mjs';
import { pathsFor } from '../scripts/launcher-common.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-desktop-test-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 4 });
  });
  const resources = join(root, 'resources'),
    dataRoot = join(root, 'user'),
    legacyRoot = join(root, 'ancien Studio é');
  await mkdir(join(resources, 'studio'), { recursive: true });
  await writeFile(join(resources, 'studio', 'server.mjs'), '// fake server');
  await writeFile(join(resources, 'node.exe'), 'fake node');
  await writeFile(join(resources, 'desktop-resource.json'), JSON.stringify({ identity: 'a'.repeat(64) }));
  await mkdir(join(legacyRoot, '.local'), { recursive: true });
  await writeFile(join(legacyRoot, 'server.mjs'), '// old');
  await writeFile(join(legacyRoot, '.local', 'workspace.json'), '{"projects":[]}');
  await writeFile(join(legacyRoot, '.local', 'lan-access.json'), '{"codeHash":"same-hash"}');
  await writeFile(join(legacyRoot, '.local', 'server.json'), 'old ownership');
  return { root, resourceDir: resources, dataRoot, legacyRoot };
}
test('Tauri receives the high-resolution ICO frame first and Windows retains small sizes', async () => {
  const ico = await readFile(new URL('../src-tauri/icons/icon.ico', import.meta.url));
  assert.equal(ico[6] || 256, 256);
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256);
  for (const size of [16, 24, 32, 48, 64, 256]) assert.ok(sizes.includes(size));
});
test(
  'Windows extended paths from native launchers still execute the entrypoint',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await fixture(t),
      script = join(f.root, 'entry.mjs');
    await writeFile(
      script,
      `import { isDirectInvocation } from ${JSON.stringify(pathToFileURL(resolve('scripts/launcher-common.mjs')).href)}; process.stdout.write(String(isDirectInvocation(import.meta.url)));`,
    );
    const result = await promisify(execFile)(process.execPath, [toNamespacedPath(script)], {
      windowsHide: true,
    });
    assert.equal(result.stdout, 'true');
  },
);
test('desktop reuses a running server without importing data or invoking a launcher', async (t) => {
  const f = await fixture(t);
  const result = await startDesktop(f, {
    probe: async () => ({ state: 'ready', health: { pid: 42, version: '2.7.0' } }),
    start: () => {
      throw new Error('must not start');
    },
  });
  assert.equal(result.pid, 42);
  assert.equal(result.reused, true);
  await assert.rejects(readdir(f.dataRoot), { code: 'ENOENT' });
});
test('desktop refuses an occupied port before changing data', async (t) => {
  const f = await fixture(t);
  await assert.rejects(startDesktop(f, { probe: async () => ({ state: 'occupied' }) }), /occupied/);
  await assert.rejects(readdir(f.dataRoot), { code: 'ENOENT' });
});
test('desktop cold start without receipt requires diagnose unless explicitly allowed', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    startDesktop(f, { probe: async () => ({ state: 'absent' }) }),
    /components_required/,
  );
  let options;
  const allowed = await startDesktop(
    { ...f, allowUnconfigured: true, env: { PATH: 'original' } },
    {
      probe: async () => ({ state: 'absent' }),
      start: async (args) => {
        options = args;
        return { port: 3088 };
      },
    },
  );
  assert.equal(allowed.port, 3088);
  assert.equal(options.env.PRIME_AGENT_GUI_DATA_DIR, join(f.dataRoot, 'data'));
});
test('desktop cold start preserves migration data and separates persistent data, kernel, and immutable runtime', async (t) => {
  const f = await fixture(t);
  let options;
  await startDesktop(
    { ...f, allowUnconfigured: true, env: { PATH: 'original' } },
    {
      probe: async () => ({ state: 'absent' }),
      start: async (args) => {
        options = args;
        return { port: 3088 };
      },
    },
  );
  assert.equal(options.env.PRIME_AGENT_GUI_DATA_DIR, join(f.dataRoot, 'data'));
  assert.equal(options.env.PRIME_AGENT_GUI_KERNEL_ROOT, f.dataRoot);
  assert.match(options.root, /versions/);
  assert.match(options.node, /node.exe$/);
  assert.equal(
    await readFile(join(f.dataRoot, 'data', 'lan-access.json'), 'utf8'),
    '{"codeHash":"same-hash"}',
  );
  assert.equal(await readFile(join(f.legacyRoot, '.local', 'server.json'), 'utf8'), 'old ownership');
  await assert.rejects(readFile(join(f.dataRoot, 'data', 'server.json')), { code: 'ENOENT' });
  const firstRoot = options.root;
  await writeFile(join(f.dataRoot, 'data', 'workspace.json'), 'new user data');
  await writeFile(join(f.resourceDir, 'desktop-resource.json'), JSON.stringify({ identity: 'b'.repeat(64) }));
  await startDesktop({ ...f, allowUnconfigured: true }, {
    probe: async () => ({ state: 'absent' }),
    start: async (args) => {
      options = args;
      return {};
    },
  });
  assert.notEqual(firstRoot, options.root);
  assert.equal(await readFile(join(firstRoot, 'server.mjs'), 'utf8'), '// fake server');
  assert.equal(await readFile(join(f.dataRoot, 'data', 'workspace.json'), 'utf8'), 'new user data');
});
test('migration errors do not leave partial data or replace an existing destination', async (t) => {
  const f = await fixture(t),
    destination = join(f.root, 'data');
  await mkdir(destination);
  await writeFile(join(destination, 'workspace.json'), 'keep');
  await assert.rejects(importLegacyData(f.legacyRoot, destination));
  assert.equal(await readFile(join(destination, 'workspace.json'), 'utf8'), 'keep');
  assert.ok(!(await readdir(f.root)).some((x) => x.startsWith('data.import-')));
});
test('migration rejects directory links and does not copy their targets', async (t) => {
  const f = await fixture(t),
    outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'untouched');
  await symlink(
    outside,
    join(f.legacyRoot, '.local', 'attachments'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(importLegacyData(f.legacyRoot, join(f.root, 'data')), /symbolic/);
  await assert.rejects(readdir(join(f.root, 'data')), { code: 'ENOENT' });
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'untouched');
});
test('invalid generation names cannot escape the persistent runtime directory', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.resourceDir, 'desktop-resource.json'), JSON.stringify({ identity: '../escape' }));
  await assert.rejects(
    startDesktop({ ...f, allowUnconfigured: true }, { probe: async () => ({ state: 'absent' }) }),
    /manifest/,
  );
  assert.equal(pathsFor('C:/installation', f.dataRoot).ownership, join(f.dataRoot, 'server.json'));
});
