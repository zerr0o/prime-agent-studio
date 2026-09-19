import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { discoverCli } from '../lib/agent.mjs';

async function packageFixture(t, { bin = 'dist/bundle/cli.js', withSibling = true, version = '0.9.5' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-cli-discovery-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const packageDir = join(root, 'prime-agent');
  await mkdir(join(packageDir, 'dist', 'bundle'), { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: 'prime-agent', version, bin: { 'prime-agent': bin } }),
  );
  await writeFile(join(packageDir, 'dist', 'bundle', 'cli.js'), '#!/usr/bin/env node\n// bridge');
  if (withSibling)
    await writeFile(join(packageDir, 'dist', 'bundle', 'cli-node.js'), '#!/usr/bin/env node\n// direct');
  return { root, packageDir };
}

test('public bundle bridge resolves a direct sibling node entry', async (t) => {
  const { packageDir } = await packageFixture(t);
  const cli = discoverCli(packageDir);
  assert.ok(cli);
  assert.equal(cli.path, join(packageDir, 'dist', 'bundle', 'cli.js'));
  assert.equal(cli.launchPath, join(packageDir, 'dist', 'bundle', 'cli-node.js'));
  assert.equal(cli.node, true);
  assert.equal(cli.packageDir, packageDir);
});

test('missing sibling falls back to the public path (0.9.4 layout)', async (t) => {
  const { packageDir } = await packageFixture(t, { withSibling: false });
  const cli = discoverCli(packageDir);
  assert.ok(cli);
  assert.equal(cli.path, join(packageDir, 'dist', 'bundle', 'cli.js'));
  assert.equal(cli.launchPath, cli.path);
});

test('direct node entry stays direct and legacy layouts stay on path', async (t) => {
  const { packageDir } = await packageFixture(t);
  const direct = discoverCli(join(packageDir, 'dist', 'bundle', 'cli-node.js'));
  assert.equal(direct.path, join(packageDir, 'dist', 'bundle', 'cli-node.js'));
  assert.equal(direct.launchPath, direct.path);
  const legacyDir = join(packageDir, 'legacy');
  await mkdir(join(legacyDir, 'dist'), { recursive: true });
  await writeFile(join(legacyDir, 'package.json'), JSON.stringify({ name: 'prime-agent', version: '0.9.4' }));
  await writeFile(join(legacyDir, 'dist', 'cli.js'), '// legacy');
  const legacy = discoverCli(join(legacyDir, 'dist', 'cli.js'));
  assert.equal(legacy.launchPath, legacy.path);
});

test('unknown paths still resolve to null', async (t) => {
  const { root } = await packageFixture(t);
  assert.equal(discoverCli(join(root, 'missing.js')), null);
});
