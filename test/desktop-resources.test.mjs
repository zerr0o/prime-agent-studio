import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import {
  desktopRuntimeScripts,
  desktop280Identity,
  repairDesktop280Resources,
  verifyDesktopRuntimeResources,
} from '../scripts/desktop-runtime-resources.mjs';
import { startDesktop } from '../scripts/desktop-start.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-resource-test-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const resourceDir = join(root, 'resources'),
    studio = join(resourceDir, 'studio'),
    dataRoot = join(root, 'data');
  await mkdir(join(studio, 'scripts'), { recursive: true });
  for (const name of desktopRuntimeScripts) await cp(resolve('scripts', name), join(studio, 'scripts', name));
  return { root, resourceDir, studio, dataRoot };
}
test('packaging validates workers, transitive modules and future file references', async (t) => {
  const f = await fixture(t);
  for (const name of ['server.mjs', 'lib', 'public', 'runtime'])
    await cp(resolve(name), join(f.studio, name), { recursive: true });
  await verifyDesktopRuntimeResources(f.studio);
  await writeFile(
    join(f.studio, 'lib', 'future.mjs'),
    "new URL('../scripts/future-worker.mjs', import.meta.url);",
  );
  await assert.rejects(verifyDesktopRuntimeResources(f.studio), /future-worker/);
  await writeFile(join(f.studio, 'scripts', 'future-worker.mjs'), '// future runtime helper');
  await verifyDesktopRuntimeResources(f.studio);
  await rm(join(f.studio, 'scripts', 'native-skill-resources.mjs'));
  await assert.rejects(verifyDesktopRuntimeResources(f.studio), /native-skill-resources/);
});
test('upgrading 2.8.0 repairs missing helpers while preserving the active server and existing files', async (t) => {
  const f = await fixture(t),
    generation = join(f.dataRoot, 'versions', desktop280Identity),
    scripts = join(generation, 'studio', 'scripts');
  await mkdir(scripts, { recursive: true });
  await writeFile(
    join(generation, 'ready.json'),
    JSON.stringify({ identity: desktop280Identity, version: '2.8.0' }),
  );
  await writeFile(join(scripts, 'provider-auth-worker.mjs'), 'preserved existing worker');
  const result = await startDesktop(f, {
    probe: async () => ({ state: 'ready', health: { pid: 123, version: '2.8.0' } }),
    start: () => {
      throw new Error('Must not restart an active server');
    },
  });
  assert.equal(result.pid, 123);
  assert.equal(result.reused, true);
  assert.equal(
    await readFile(join(scripts, 'provider-auth-worker.mjs'), 'utf8'),
    'preserved existing worker',
  );
  assert.equal(
    await readFile(join(scripts, 'kernel-catalog-worker.mjs'), 'utf8'),
    await readFile(resolve('scripts/kernel-catalog-worker.mjs'), 'utf8'),
  );
  assert.deepEqual(await repairDesktop280Resources(f.resourceDir, f.dataRoot), []);
});
test('legacy repair does not follow directory links', async (t) => {
  const f = await fixture(t),
    outside = join(f.root, 'outside');
  await mkdir(outside);
  await mkdir(f.dataRoot);
  await symlink(outside, join(f.dataRoot, 'versions'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(repairDesktop280Resources(f.resourceDir, f.dataRoot), /Invalid legacy/);
});

test('legacy repair ignores other resource generations', async (t) => {
  const f = await fixture(t);
  const scripts = join(f.dataRoot, 'versions', 'other-build', 'studio', 'scripts');
  await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, 'keep.txt'), 'unchanged');
  assert.deepEqual(await repairDesktop280Resources(f.resourceDir, f.dataRoot), []);
  assert.equal(await readFile(join(scripts, 'keep.txt'), 'utf8'), 'unchanged');
  await assert.rejects(readFile(join(scripts, 'kernel-catalog-worker.mjs')), { code: 'ENOENT' });
});

test('concurrent legacy repairs publish complete helpers without overwriting', async (t) => {
  const f = await fixture(t);
  const generation = join(f.dataRoot, 'versions', desktop280Identity);
  await mkdir(join(generation, 'studio', 'scripts'), { recursive: true });
  await writeFile(
    join(generation, 'ready.json'),
    JSON.stringify({ identity: desktop280Identity, version: '2.8.0' }),
  );
  const results = await Promise.all([
    repairDesktop280Resources(f.resourceDir, f.dataRoot),
    repairDesktop280Resources(f.resourceDir, f.dataRoot),
  ]);
  assert.equal(results.flat().length, 12);
  assert.ok(results.flat().includes('model-catalog-worker.mjs'));
  for (const name of results.flat()) {
    assert.equal(
      await readFile(join(generation, 'studio', 'scripts', name), 'utf8'),
      await readFile(join(f.studio, 'scripts', name), 'utf8'),
    );
  }
});
