import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  CUA_DRIVER_ASSET,
  CUA_DRIVER_ASSET_BYTES,
  CUA_DRIVER_ASSET_SHA256,
  CUA_DRIVER_COMMIT,
  CUA_DRIVER_EXE,
  CUA_DRIVER_REPO,
  CUA_DRIVER_TAG,
  CUA_DRIVER_UIA_EXE,
  CUA_DRIVER_VERSION,
} from '../lib/cua-driver-runtime.mjs';
import {
  CUA_DRIVER_SIDECAR_FILES,
  defaultPreparePaths,
  downloadArchive,
  legacyResearchArchivePath,
  prepareCuaDriver,
  validateArchiveEntries,
  verifyArchive,
  verifyCuaDriverSidecar,
} from '../scripts/prepare-cua-driver.mjs';

const FAKE_LICENSE = 'MIT License fake for prepare tests.\n';
const fakeDriver = Buffer.from('fake-cua-driver-exe-bytes-0123456789');
const fakeUia = Buffer.from('fake-cua-driver-uia-bytes-abcdef');

// Minimal stored (uncompressed) zip writer: dependency-free fake archives.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function writeStoredZip(path, entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(buf), 14);
    header.writeUInt32LE(buf.length, 18);
    header.writeUInt32LE(buf.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0x5821, 12);
    parts.push(header, nameBuf, buf);
    central.push({ nameBuf, crc: crc32(buf), size: buf.length, offset });
    offset += 30 + nameBuf.length + buf.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x5821, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.size, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.nameBuf.length, 28);
    header.writeUInt32LE(entry.offset, 42);
    parts.push(header, entry.nameBuf);
    cdSize += 46 + entry.nameBuf.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  parts.push(end);
  await writeFile(path, Buffer.concat(parts));
}

async function makeTemp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cua-prepare-test-'));
  t.after(async () => {
    assert.equal(dirname(dir), resolve(tmpdir()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return dir;
}

function fakeEntries(extra = []) {
  return [
    { name: CUA_DRIVER_EXE, data: fakeDriver },
    { name: CUA_DRIVER_UIA_EXE, data: fakeUia },
    { name: 'cua-cursor-theme.exe', data: Buffer.from('decoy-cursor') },
    { name: 'cua_driver_sdk.dll', data: Buffer.from('decoy-dll') },
    { name: 'cua_driver_node_runtime.node', data: Buffer.from('decoy-node') },
    { name: 'cua_driver_abi.h', data: Buffer.from('decoy-header') },
    { name: 'nested/deep.txt', data: Buffer.from('decoy-nested') },
    ...extra,
  ];
}

async function fakeArchive(dir, extra = []) {
  const archive = join(dir, 'fake-cua-driver.zip');
  await writeStoredZip(archive, fakeEntries(extra));
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  const bytes = (await stat(archive)).size;
  return { archive, sha256, bytes };
}

function hasPowershell() {
  if (process.platform === 'win32') return true;
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$true'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return probe.status === 0;
}

const needPowershell = { skip: !hasPowershell() ? 'PowerShell is required for archive extraction' : false };

test('fake archive stages only the two exes plus manifests', needPowershell, async (t) => {
  const dir = await makeTemp(t);
  await writeFile(join(dir, 'sentinel.txt'), 'untouched');
  const { archive, sha256, bytes } = await fakeArchive(dir);
  const outputDir = join(dir, 'out');
  const stageDir = join(dir, 'stage');
  const result = await prepareCuaDriver({
    archive,
    outputDir,
    stageDir,
    expectedSha256: sha256,
    expectedBytes: bytes,
    assetUrl: 'https://example.invalid/fake.zip',
    licenseText: FAKE_LICENSE,
  });
  assert.deepEqual(
    result.files.map((file) => file.name),
    [CUA_DRIVER_EXE, CUA_DRIVER_UIA_EXE],
  );
  assert.deepEqual((await readdir(outputDir)).sort(), [...CUA_DRIVER_SIDECAR_FILES].sort());
  assert.deepEqual((await readdir(stageDir)).sort(), [...CUA_DRIVER_SIDECAR_FILES].sort());
  assert.deepEqual(await readFile(join(outputDir, CUA_DRIVER_EXE)), fakeDriver);
  assert.deepEqual(await readFile(join(outputDir, CUA_DRIVER_UIA_EXE)), fakeUia);
  assert.equal(await readFile(join(outputDir, 'VERSION'), 'utf8'), `${CUA_DRIVER_VERSION}\n`);
  assert.equal(await readFile(join(outputDir, 'LICENSE.cua-driver.md'), 'utf8'), FAKE_LICENSE);
  const source = JSON.parse(await readFile(join(outputDir, 'source.json'), 'utf8'));
  assert.equal(source.repo, CUA_DRIVER_REPO);
  assert.equal(source.tag, CUA_DRIVER_TAG);
  assert.equal(source.commit, CUA_DRIVER_COMMIT);
  assert.equal(source.version, CUA_DRIVER_VERSION);
  assert.equal(source.assetSha256, sha256);
  assert.equal(source.assetBytes, bytes);
  assert.equal(source.target, 'win32-x64');
  await verifyCuaDriverSidecar(outputDir, { assetSha256: sha256 });
  await verifyCuaDriverSidecar(stageDir, { assetSha256: sha256 });
  // Nothing but the archive, the sentinel and the two staged dirs was written here.
  assert.deepEqual((await readdir(dir)).sort(), ['fake-cua-driver.zip', 'out', 'sentinel.txt', 'stage']);
  assert.equal(await readFile(join(dir, 'sentinel.txt'), 'utf8'), 'untouched');
});

test('entry validation accepts flat entries and skips directory decoys', async () => {
  const picked = validateArchiveEntries([
    CUA_DRIVER_EXE,
    CUA_DRIVER_UIA_EXE,
    'cua-cursor-theme.exe',
    'nested/deep.txt',
    'docs/',
  ]);
  assert.deepEqual(picked, [
    { name: CUA_DRIVER_EXE, entry: CUA_DRIVER_EXE },
    { name: CUA_DRIVER_UIA_EXE, entry: CUA_DRIVER_UIA_EXE },
  ]);
});

test('entry validation rejects unsafe and duplicate names before extraction', async () => {
  for (const evil of [
    '../evil.txt',
    '..\\evil.txt',
    'sub/../../evil.txt',
    '/abs-evil.txt',
    '\\server\\share\\evil.txt',
    'C:/evil.txt',
    'C:\\evil.txt',
    '',
  ]) {
    assert.throws(
      () => validateArchiveEntries([CUA_DRIVER_EXE, CUA_DRIVER_UIA_EXE, evil]),
      /unsafe archive entry/,
    );
  }
  assert.throws(
    () => validateArchiveEntries([CUA_DRIVER_EXE, CUA_DRIVER_EXE, CUA_DRIVER_UIA_EXE]),
    /duplicate archive entry/,
  );
  assert.throws(() => validateArchiveEntries([CUA_DRIVER_EXE]), /has no/);
});

async function fakeMaliciousArchive(t, evilNames) {
  const dir = await makeTemp(t);
  await writeFile(join(dir, 'sentinel.txt'), 'untouched');
  const archive = join(dir, 'evil.zip');
  await writeStoredZip(archive, [
    { name: CUA_DRIVER_EXE, data: fakeDriver },
    { name: CUA_DRIVER_UIA_EXE, data: fakeUia },
    ...evilNames.map((name) => ({ name, data: Buffer.from('must never escape') })),
  ]);
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  const bytes = (await stat(archive)).size;
  return { dir, archive, sha256, bytes };
}

async function assertRejectedClean(t, evilNames, pattern) {
  const { dir, archive, sha256, bytes } = await fakeMaliciousArchive(t, evilNames);
  await assert.rejects(
    prepareCuaDriver({
      archive,
      outputDir: join(dir, 'out'),
      stageDir: join(dir, 'stage'),
      expectedSha256: sha256,
      expectedBytes: bytes,
      licenseText: FAKE_LICENSE,
    }),
    pattern,
  );
  // Validation runs before any extraction or staging: outputs absent,
  // sentinel unmodified, no payload file anywhere in the test dir.
  await assert.rejects(stat(join(dir, 'out')), /ENOENT/);
  await assert.rejects(stat(join(dir, 'stage')), /ENOENT/);
  assert.equal(await readFile(join(dir, 'sentinel.txt'), 'utf8'), 'untouched');
  assert.deepEqual((await readdir(dir)).sort(), ['evil.zip', 'sentinel.txt']);
}

test('traversal entries are rejected with no outside writes', needPowershell, async (t) => {
  await assertRejectedClean(t, ['../evil.txt'], /traversal/);
});

test('backslash traversal entries are rejected with no outside writes', needPowershell, async (t) => {
  await assertRejectedClean(t, ['..\\evil.txt'], /traversal/);
});

test('absolute entries are rejected with no outside writes', needPowershell, async (t) => {
  await assertRejectedClean(t, ['/abs-evil.txt'], /absolute/);
});

test('drive-letter entries are rejected with no outside writes', needPowershell, async (t) => {
  await assertRejectedClean(t, ['C:/evil.txt'], /drive-letter/);
});

test('duplicate entries are rejected with no outside writes', needPowershell, async (t) => {
  const dir = await makeTemp(t);
  await writeFile(join(dir, 'sentinel.txt'), 'untouched');
  const archive = join(dir, 'evil.zip');
  await writeStoredZip(archive, [
    { name: CUA_DRIVER_EXE, data: fakeDriver },
    { name: CUA_DRIVER_EXE, data: Buffer.from('second copy') },
    { name: CUA_DRIVER_UIA_EXE, data: fakeUia },
  ]);
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  const bytes = (await stat(archive)).size;
  await assert.rejects(
    prepareCuaDriver({
      archive,
      outputDir: join(dir, 'out'),
      stageDir: join(dir, 'stage'),
      expectedSha256: sha256,
      expectedBytes: bytes,
      licenseText: FAKE_LICENSE,
    }),
    /duplicate archive entry/,
  );
  assert.equal(await readFile(join(dir, 'sentinel.txt'), 'utf8'), 'untouched');
  assert.deepEqual((await readdir(dir)).sort(), ['evil.zip', 'sentinel.txt']);
});

test('archive checksum mismatch fails closed without staging', needPowershell, async (t) => {
  const dir = await makeTemp(t);
  const { archive, bytes } = await fakeArchive(dir);
  await assert.rejects(
    prepareCuaDriver({
      archive,
      outputDir: join(dir, 'out'),
      stageDir: join(dir, 'stage'),
      expectedSha256: '0'.repeat(64),
      expectedBytes: bytes,
      licenseText: FAKE_LICENSE,
    }),
    /checksum-mismatch/,
  );
  await assert.rejects(stat(join(dir, 'out')), /ENOENT/);
});

test('archive size mismatch fails closed without staging', needPowershell, async (t) => {
  const dir = await makeTemp(t);
  const { archive, sha256 } = await fakeArchive(dir);
  await assert.rejects(
    prepareCuaDriver({
      archive,
      outputDir: join(dir, 'out'),
      stageDir: join(dir, 'stage'),
      expectedSha256: sha256,
      expectedBytes: 1,
      licenseText: FAKE_LICENSE,
    }),
    /checksum-mismatch/,
  );
});

test('archive without the UIA sibling fails explicitly', needPowershell, async (t) => {
  const dir = await makeTemp(t);
  const archive = join(dir, 'no-uia.zip');
  await writeStoredZip(archive, [{ name: CUA_DRIVER_EXE, data: fakeDriver }]);
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  const bytes = (await stat(archive)).size;
  await assert.rejects(
    prepareCuaDriver({
      archive,
      outputDir: join(dir, 'out'),
      stageDir: join(dir, 'stage'),
      expectedSha256: sha256,
      expectedBytes: bytes,
      licenseText: FAKE_LICENSE,
    }),
    /cua-driver-uia/,
  );
});

test('ambiguous duplicate driver entries fail closed', needPowershell, async (t) => {
  const dir = await makeTemp(t);
  const archive = join(dir, 'dup.zip');
  await writeStoredZip(archive, [
    { name: CUA_DRIVER_EXE, data: fakeDriver },
    { name: `nested/${CUA_DRIVER_EXE}`, data: fakeDriver },
    { name: CUA_DRIVER_UIA_EXE, data: fakeUia },
  ]);
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  const bytes = (await stat(archive)).size;
  await assert.rejects(
    prepareCuaDriver({
      archive,
      outputDir: join(dir, 'out'),
      stageDir: join(dir, 'stage'),
      expectedSha256: sha256,
      expectedBytes: bytes,
      licenseText: FAKE_LICENSE,
    }),
    /ambiguous/,
  );
});

test('empty license fails explicitly', needPowershell, async (t) => {
  const dir = await makeTemp(t);
  const { archive, sha256, bytes } = await fakeArchive(dir);
  await assert.rejects(
    prepareCuaDriver({
      archive,
      outputDir: join(dir, 'out'),
      stageDir: join(dir, 'stage'),
      expectedSha256: sha256,
      expectedBytes: bytes,
      licenseText: '   \n',
    }),
    /license/i,
  );
});

test('noStage leaves the staging dir untouched', needPowershell, async (t) => {
  const dir = await makeTemp(t);
  const { archive, sha256, bytes } = await fakeArchive(dir);
  const result = await prepareCuaDriver({
    archive,
    outputDir: join(dir, 'out'),
    stageDir: join(dir, 'stage'),
    noStage: true,
    expectedSha256: sha256,
    expectedBytes: bytes,
    licenseText: FAKE_LICENSE,
  });
  assert.equal(result.stageDir, null);
  await assert.rejects(stat(join(dir, 'stage')), /ENOENT/);
});

test('staged sidecar verification detects later tampering', needPowershell, async (t) => {
  const dir = await makeTemp(t);
  const { archive, sha256, bytes } = await fakeArchive(dir);
  const outputDir = join(dir, 'out');
  await prepareCuaDriver({
    archive,
    outputDir,
    stageDir: join(dir, 'stage'),
    expectedSha256: sha256,
    expectedBytes: bytes,
    licenseText: FAKE_LICENSE,
  });
  await verifyCuaDriverSidecar(outputDir, { assetSha256: sha256 });
  await writeFile(join(outputDir, CUA_DRIVER_EXE), Buffer.concat([fakeDriver, Buffer.from('tamper')]));
  await assert.rejects(verifyCuaDriverSidecar(outputDir, { assetSha256: sha256 }), /checksum-mismatch/);
});

test('default archive is the .local cache, not the research path', async () => {
  const defaults = defaultPreparePaths(join(sep, 'studio-root'));
  assert.ok(!defaults.archive.includes('test-results'));
  assert.equal(defaults.archive, join(sep, 'studio-root', '.local', 'cua-driver', 'cache', CUA_DRIVER_ASSET));
  assert.ok(defaults.archive.endsWith(CUA_DRIVER_ASSET));
});

function mockFetch(payload, { status = 200, declaredLength = null } = {}) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return async () => ({
    ok: status === 200,
    status,
    headers: {
      get: (name) => (name === 'content-length' && declaredLength !== null ? declaredLength : null),
    },
    body: [bytes],
  });
}

function throwingFetch() {
  return async () => {
    throw new Error('network must not be used');
  };
}

test('mock download writes the exact bytes with no .part leftovers', async (t) => {
  const dir = await makeTemp(t);
  const payload = Buffer.from('mock-pinned-payload-0123456789');
  const dest = join(dir, 'cache', 'asset.zip');
  const result = await downloadArchive(dest, {
    expectedBytes: payload.length,
    expectedSha256: createHash('sha256').update(payload).digest('hex'),
    timeoutMs: 5000,
    fetchImpl: mockFetch(payload, { declaredLength: String(payload.length) }),
  });
  assert.equal(result.bytes, payload.length);
  assert.deepEqual(await readFile(dest), payload);
  await assert.rejects(stat(`${dest}.part`), /ENOENT/);
});

test('mock download fails closed on bad status, size, cap, hash, and URL', async (t) => {
  const dir = await makeTemp(t);
  const payload = Buffer.from('mock-payload');
  const goodSha = createHash('sha256').update(payload).digest('hex');
  const base = { expectedBytes: payload.length, expectedSha256: goodSha, timeoutMs: 5000 };
  const destFor = (name) => join(dir, name);
  await assert.rejects(
    downloadArchive(destFor('a.zip'), { ...base, fetchImpl: mockFetch(payload, { status: 404 }) }),
    /HTTP 404/,
  );
  await assert.rejects(
    downloadArchive(destFor('b.zip'), { ...base, fetchImpl: mockFetch(payload, { declaredLength: '1' }) }),
    /declared size/,
  );
  await assert.rejects(
    downloadArchive(destFor('c.zip'), {
      ...base,
      expectedBytes: 2,
      fetchImpl: mockFetch(payload, { declaredLength: '2' }),
    }),
    /byte limit exceeded/,
  );
  await assert.rejects(
    downloadArchive(destFor('d.zip'), {
      ...base,
      expectedSha256: '0'.repeat(64),
      fetchImpl: mockFetch(payload),
    }),
    /downloaded SHA256/,
  );
  await assert.rejects(
    downloadArchive(destFor('e.zip'), {
      ...base,
      url: 'https://example.invalid/evil.zip',
      fetchImpl: throwingFetch(),
    }),
    /non-pinned URL/,
  );
  for (const name of ['a.zip', 'b.zip', 'c.zip', 'd.zip', 'e.zip']) {
    await assert.rejects(stat(destFor(name)), /ENOENT/);
    await assert.rejects(stat(`${destFor(name)}.part`), /ENOENT/);
  }
});

test('mock download aborts on timeout', async (t) => {
  const dir = await makeTemp(t);
  const hangingFetch = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')));
    });
  await assert.rejects(
    downloadArchive(join(dir, 't.zip'), {
      expectedBytes: 10,
      expectedSha256: '0'.repeat(64),
      timeoutMs: 50,
      fetchImpl: hangingFetch,
    }),
    /abort/,
  );
  await assert.rejects(stat(join(dir, 't.zip')), /ENOENT/);
  await assert.rejects(stat(join(dir, 't.zip.part')), /ENOENT/);
});

async function seedZip(dir, name) {
  const archive = join(dir, name);
  await writeStoredZip(archive, [
    { name: CUA_DRIVER_EXE, data: fakeDriver },
    { name: CUA_DRIVER_UIA_EXE, data: fakeUia },
  ]);
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  return { archive, sha256, bytes: (await stat(archive)).size };
}

test('legacy research seed is reused without redownload', async (t) => {
  const studioRoot = await makeTemp(t);
  const seedDir = join(studioRoot, 'test-results', 'cua-integration', 'research-distribution');
  await mkdir(seedDir, { recursive: true });
  const seed = await seedZip(seedDir, CUA_DRIVER_ASSET);
  assert.equal(legacyResearchArchivePath(studioRoot), seed.archive);
  const result = await prepareCuaDriver({
    studioRoot,
    outputDir: join(studioRoot, 'out'),
    stageDir: join(studioRoot, 'stage'),
    expectedSha256: seed.sha256,
    expectedBytes: seed.bytes,
    licenseText: FAKE_LICENSE,
    fetchImpl: throwingFetch(),
  });
  assert.deepEqual(
    result.files.map((file) => file.name),
    [CUA_DRIVER_EXE, CUA_DRIVER_UIA_EXE],
  );
  assert.deepEqual(await readFile(defaultPreparePaths(studioRoot).archive), await readFile(seed.archive));
});

test('present cache archive is used with no network', async (t) => {
  const studioRoot = await makeTemp(t);
  const cacheDir = join(studioRoot, '.local', 'cua-driver', 'cache');
  await mkdir(cacheDir, { recursive: true });
  const seed = await seedZip(cacheDir, CUA_DRIVER_ASSET);
  const result = await prepareCuaDriver({
    studioRoot,
    outputDir: join(studioRoot, 'out'),
    stageDir: join(studioRoot, 'stage'),
    expectedSha256: seed.sha256,
    expectedBytes: seed.bytes,
    licenseText: FAKE_LICENSE,
    fetchImpl: throwingFetch(),
  });
  assert.equal(result.files.length, 2);
});

test('explicit --archive path that is missing fails instead of fetching', async (t) => {
  const dir = await makeTemp(t);
  let fetched = false;
  await assert.rejects(
    prepareCuaDriver({
      archive: join(dir, 'does-not-exist.zip'),
      outputDir: join(dir, 'out'),
      stageDir: join(dir, 'stage'),
      licenseText: FAKE_LICENSE,
      fetchImpl: async () => {
        fetched = true;
        throw new Error('must not fetch');
      },
    }),
    /archive not found/,
  );
  assert.equal(fetched, false);
  await assert.rejects(stat(join(dir, 'out')), /ENOENT/);
});

test('real pinned asset verifies by hash and listing, never executes', async (t) => {
  // A prepared checkout uses the supported cache, not the old research worktree.
  // Keep ordinary unit runs offline when this optional real-asset fixture is absent.
  let archive;
  for (const candidate of [defaultPreparePaths().archive, legacyResearchArchivePath()]) {
    try {
      if ((await stat(candidate)).isFile()) {
        archive = candidate;
        break;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!archive) {
    t.skip('Run npm run cua:prepare to enable the optional real pinned archive check.');
    return;
  }
  assert.equal((await stat(archive)).size, CUA_DRIVER_ASSET_BYTES);
  const verified = await verifyArchive(archive);
  assert.equal(verified.sha256, CUA_DRIVER_ASSET_SHA256);
  if (!hasPowershell()) {
    t.skip('PowerShell is required to list the real archive');
    return;
  }
  const script =
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
    `$zip = [System.IO.Compression.ZipFile]::OpenRead(${JSON.stringify(archive)}); ` +
    '$zip.Entries | ForEach-Object { $_.FullName }; $zip.Dispose()';
  const listed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(listed.status, 0);
  const names = String(listed.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(names.includes(CUA_DRIVER_EXE));
  assert.ok(names.includes(CUA_DRIVER_UIA_EXE));
  assert.equal(names.length, 6);
  // No license file ships inside the zip; the prepare step adds the pinned MIT text.
  assert.ok(!names.some((name) => /license/i.test(name)));
});
