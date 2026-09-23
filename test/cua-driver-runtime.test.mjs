import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  CUA_DRIVER_ASSET_SHA256,
  CUA_DRIVER_COMMIT,
  CUA_DRIVER_EXE,
  CUA_DRIVER_REPO,
  CUA_DRIVER_TAG,
  CUA_DRIVER_UIA_EXE,
  CUA_DRIVER_VERSION,
  clearCuaDriverCache,
  defaultStudioRoot,
  getCuaDriverAvailability,
  resolveCuaDriverPath,
} from '../lib/cua-driver-runtime.mjs';

function shaHex(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function makeSidecar(dir, overrides = {}) {
  const driver = overrides.driver ?? Buffer.from('fake-cua-driver-exe-bytes');
  const uia = overrides.uia === undefined ? Buffer.from('fake-cua-driver-uia-bytes') : overrides.uia;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, CUA_DRIVER_EXE), driver);
  if (uia !== null) await writeFile(join(dir, CUA_DRIVER_UIA_EXE), uia);
  await writeFile(join(dir, 'LICENSE.cua-driver.md'), 'MIT License fake for tests.\n');
  await writeFile(join(dir, 'VERSION'), `${overrides.version ?? CUA_DRIVER_VERSION}\n`);
  const sums = [`${shaHex(driver)}  ${CUA_DRIVER_EXE}`];
  if (uia !== null) sums.push(`${shaHex(uia)}  ${CUA_DRIVER_UIA_EXE}`);
  await writeFile(join(dir, 'SHA256SUMS'), `${(overrides.sums ?? sums).join('\n')}\n`);
  await writeFile(
    join(dir, 'source.json'),
    JSON.stringify({
      repo: overrides.repo ?? CUA_DRIVER_REPO,
      tag: overrides.tag ?? CUA_DRIVER_TAG,
      commit: overrides.commit ?? CUA_DRIVER_COMMIT,
      version: overrides.version ?? CUA_DRIVER_VERSION,
      releaseId: 389486122,
      asset: 'fake-test.zip',
      assetUrl: 'https://example.invalid/fake.zip',
      assetSha256: overrides.assetSha256 ?? CUA_DRIVER_ASSET_SHA256,
      assetBytes: 123,
      target: 'win32-x64',
      license: 'LICENSE.cua-driver.md',
      files: [],
    }),
  );
  return dir;
}

async function makeStudio(t, { packaged = true, cached = false, ...sidecar } = {}) {
  const studioRoot = await mkdtemp(join(tmpdir(), 'cua-runtime-test-'));
  t.after(async () => {
    clearCuaDriverCache();
    assert.equal(dirname(studioRoot), resolve(tmpdir()));
    await rm(studioRoot, { recursive: true, force: true, maxRetries: 5 });
  });
  clearCuaDriverCache();
  if (packaged) await makeSidecar(join(studioRoot, 'runtime', 'cua-driver'), sidecar);
  if (cached)
    await makeSidecar(join(studioRoot, '.local', 'cua-driver', CUA_DRIVER_VERSION, 'win32-x64'), sidecar);
  return studioRoot;
}

test('platform gate: only Windows x64 is supported, no other claims', async (t) => {
  const studioRoot = await makeStudio(t);
  for (const [platform, arch] of [
    ['linux', 'x64'],
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'arm64'],
    ['win32', 'ia32'],
  ]) {
    const status = getCuaDriverAvailability({ studioRoot, platform, arch });
    assert.equal(status.available, false);
    assert.equal(status.backend, 'cua');
    assert.equal(status.path, null);
    assert.equal(status.version, CUA_DRIVER_VERSION);
    assert.equal(status.supported, false);
    assert.match(status.reason, /Windows x64 only/);
  }
});

test('missing artifacts fail closed with staging guidance', async (t) => {
  const studioRoot = await makeStudio(t, { packaged: false });
  assert.equal(resolveCuaDriverPath({ studioRoot }), null);
  const status = getCuaDriverAvailability({ studioRoot, platform: 'win32', arch: 'x64' });
  assert.deepEqual(Object.keys(status).sort(), [
    'available',
    'backend',
    'path',
    'reason',
    'supported',
    'version',
  ]);
  assert.equal(status.available, false);
  assert.equal(status.supported, true);
  assert.equal(status.path, null);
  assert.match(status.reason, /missing-artifacts/);
  assert.match(status.reason, /prepare-cua-driver/);
});

test('packaged sidecar resolves first and reports available', async (t) => {
  const studioRoot = await makeStudio(t, { cached: true });
  const expected = join(studioRoot, 'runtime', 'cua-driver', CUA_DRIVER_EXE);
  assert.equal(resolveCuaDriverPath({ studioRoot }), expected);
  const status = getCuaDriverAvailability({ studioRoot, platform: 'win32', arch: 'x64' });
  assert.equal(status.available, true);
  assert.equal(status.backend, 'cua');
  assert.equal(status.path, expected);
  assert.equal(status.version, CUA_DRIVER_VERSION);
  assert.equal(status.reason, null);
  assert.equal(status.supported, true);
  // Repeat poll reuses the validated identity cache without rehashing.
  assert.deepEqual(getCuaDriverAvailability({ studioRoot, platform: 'win32', arch: 'x64' }), status);
});

test('dev cache is used when no packaged sidecar exists', async (t) => {
  const studioRoot = await makeStudio(t, { packaged: false, cached: true });
  const expected = join(studioRoot, '.local', 'cua-driver', CUA_DRIVER_VERSION, 'win32-x64', CUA_DRIVER_EXE);
  assert.equal(resolveCuaDriverPath({ studioRoot }), expected);
  const status = getCuaDriverAvailability({ studioRoot, platform: 'win32', arch: 'x64' });
  assert.equal(status.available, true);
  assert.equal(status.path, expected);
});

test('missing UIA sibling fails closed', async (t) => {
  const studioRoot = await makeStudio(t, { uia: null });
  const status = getCuaDriverAvailability({ studioRoot, platform: 'win32', arch: 'x64' });
  assert.equal(status.available, false);
  assert.equal(status.path, null);
  assert.equal(status.supported, true);
  assert.match(status.reason, /uia/i);
});

test('VERSION drift fails closed', async (t) => {
  const studioRoot = await makeStudio(t, { version: '0.0.0-test' });
  const status = getCuaDriverAvailability({ studioRoot, platform: 'win32', arch: 'x64' });
  assert.equal(status.available, false);
  assert.equal(status.path, null);
  assert.match(status.reason, /VERSION/);
});

test('source.json provenance drift fails closed', async (t) => {
  const studioRoot = await makeStudio(t, { commit: 'deadbeef'.repeat(5).slice(0, 40) });
  const status = getCuaDriverAvailability({ studioRoot, platform: 'win32', arch: 'x64' });
  assert.equal(status.available, false);
  assert.equal(status.path, null);
  assert.match(status.reason, /provenance/);
});

test('corrupted exe fails closed and never hands out the tampered path', async (t) => {
  const studioRoot = await makeStudio(t);
  const before = getCuaDriverAvailability({ studioRoot, platform: 'win32', arch: 'x64' });
  assert.equal(before.available, true);
  await appendFile(join(studioRoot, 'runtime', 'cua-driver', CUA_DRIVER_EXE), Buffer.from('tamper'));
  const after = getCuaDriverAvailability({ studioRoot, platform: 'win32', arch: 'x64' });
  assert.equal(after.available, false);
  assert.equal(after.path, null);
  assert.match(after.reason, /checksum-mismatch/);
});

test('default root comes from import.meta, never the caller cwd', async (t) => {
  const decoy = await mkdtemp(join(tmpdir(), 'cua-cwd-decoy-'));
  t.after(async () => {
    process.chdir(previous);
    await rm(decoy, { recursive: true, force: true, maxRetries: 5 });
  });
  await makeSidecar(join(decoy, 'runtime', 'cua-driver'));
  const previous = process.cwd();
  process.chdir(decoy);
  try {
    assert.ok(defaultStudioRoot().length > 0);
    const resolved = resolveCuaDriverPath();
    assert.ok(resolved === null || !resolve(resolved).startsWith(resolve(decoy)));
    const status = getCuaDriverAvailability({ platform: 'win32', arch: 'x64' });
    assert.ok(status.path === null || !resolve(status.path).startsWith(resolve(decoy)));
    assert.equal(status.backend, 'cua');
  } finally {
    process.chdir(previous);
  }
});

test('real staged sidecar, when present, verifies without executing', async (t) => {
  const exePath = resolveCuaDriverPath();
  if (!exePath) {
    t.skip('no staged sidecar in this checkout');
    return;
  }
  const status = getCuaDriverAvailability({ platform: 'win32', arch: 'x64' });
  assert.equal(status.available, true);
  assert.equal(status.path, exePath);
  assert.equal(await readFile(status.path).then((data) => data.length > 0), true);
});
