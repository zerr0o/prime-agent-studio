#!/usr/bin/env node
/**
 * Stage the pinned CUA driver sidecar. No install, no execution.
 *
 * What it does:
 *   1. Verifies the pinned -binary.zip (size plus streaming SHA256) against
 *      the pinned identity, then extracts ONLY cua-driver.exe and
 *      cua-driver-uia.exe into .local/cua-driver/0.28.2/win32-x64.
 *   2. Writes the pinned MIT license, VERSION, SHA256SUMS and source.json
 *      next to the exes, then mirrors the same verified set into
 *      runtime/cua-driver (build staging, gitignored).
 *
 * What it never does: no install.ps1, no PATH change, no Scheduled Task,
 * no registry write, no global config, no autostart, no daemon launch, and
 * never runs capture/input/focus. The exes are read and hashed, never
 * spawned.
 *
 * Extraction safety: zip entry names are listed with .NET ZipArchive and
 * validated BEFORE anything is extracted (absolute, drive-letter and
 * traversal names rejected, exact duplicates rejected, exactly one entry
 * per allowlisted exe required). Only the two picked entries are then
 * extracted by FullName under canonical names into an owned temp dir, so a
 * malicious local archive accepted via test overrides can never write
 * outside that dir. Everything else in the zip (cursor theme sidecar, SDK
 * dll, node runtime, ABI header) never touches disk. The pinned production
 * hash additionally blocks any non-pinned default archive.
 *
 * Archive sourcing (clean-checkout friendly): the default source zip is the
 * cache at .local/cua-driver/cache/<pinned asset>, never the ignored
 * research path. When the cached zip is absent and no explicit --archive is
 * given, prepare first reuses the already-verified research archive as a
 * legacy seed (verified again before copying), else downloads ONLY the exact
 * pinned URL with size/SHA checks, a timeout, a byte cap, temp .part plus
 * atomic rename, and cleanup. An explicit --archive path must exist and is
 * never fetched. Running this script is the explicit fetch permission; the
 * downloaded bytes are hashed and inspected, never executed.
 *
 * Offline tests may override the archive, expected hash/size and license
 * source via options or CLI flags, and inject a mock fetch via
 * options.fetchImpl. Production defaults stay pinned.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CUA_DRIVER_ASSET,
  CUA_DRIVER_ASSET_BYTES,
  CUA_DRIVER_ASSET_SHA256,
  CUA_DRIVER_ASSET_URL,
  CUA_DRIVER_COMMIT,
  CUA_DRIVER_EXE,
  CUA_DRIVER_LICENSE,
  CUA_DRIVER_RELEASE_ID,
  CUA_DRIVER_REPO,
  CUA_DRIVER_TAG,
  CUA_DRIVER_UIA_EXE,
  CUA_DRIVER_VERSION,
} from '../lib/cua-driver-runtime.mjs';

export const CUA_DRIVER_LICENSE_URL = `https://raw.githubusercontent.com/trycua/cua/${CUA_DRIVER_TAG}/LICENSE.md`;
const REQUIRED_EXES = [CUA_DRIVER_EXE, CUA_DRIVER_UIA_EXE];
export const CUA_DRIVER_SIDECAR_FILES = [
  ...REQUIRED_EXES,
  CUA_DRIVER_LICENSE,
  'VERSION',
  'SHA256SUMS',
  'source.json',
];

export function defaultStudioRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function defaultPreparePaths(studioRoot = defaultStudioRoot()) {
  return {
    archive: join(studioRoot, '.local', 'cua-driver', 'cache', CUA_DRIVER_ASSET),
    outputDir: join(studioRoot, '.local', 'cua-driver', CUA_DRIVER_VERSION, 'win32-x64'),
    stageDir: join(studioRoot, 'runtime', 'cua-driver'),
  };
}

/**
 * Legacy seed from the earlier distribution research worktree path. Reused
 * without redownload when present, but verified again before copying.
 */
export function legacyResearchArchivePath(studioRoot = defaultStudioRoot()) {
  return join(studioRoot, 'test-results', 'cua-integration', 'research-distribution', CUA_DRIVER_ASSET);
}

/**
 * Download ONLY the exact pinned asset URL into dest (temp .part plus
 * atomic rename). Enforces HTTP 200, an optional exact Content-Length
 * match, a hard byte cap, a timeout, and exact size plus SHA256 checks.
 * Cleans the .part file on any failure. fetchImpl is a test injection.
 */
export async function downloadArchive(
  dest,
  {
    url = CUA_DRIVER_ASSET_URL,
    expectedBytes = CUA_DRIVER_ASSET_BYTES,
    expectedSha256 = CUA_DRIVER_ASSET_SHA256,
    timeoutMs = 120000,
    fetchImpl = fetch,
  } = {},
) {
  if (url !== CUA_DRIVER_ASSET_URL)
    throw new Error('prepare-cua-driver: refusing download from a non-pinned URL.');
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('download timeout')), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response || !response.ok || response.status !== 200)
      throw new Error(`prepare-cua-driver: download failed with HTTP ${response?.status ?? 'no response'}.`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (expectedBytes != null && Number.isFinite(declared) && declared > 0 && declared !== expectedBytes)
      throw new Error(
        `prepare-cua-driver: checksum-mismatch: declared size ${declared}, expected ${expectedBytes}.`,
      );
    if (response.body == null) throw new Error('prepare-cua-driver: download returned an empty body.');
    const hash = createHash('sha256');
    let bytes = 0;
    const file = await open(tmp, 'w');
    try {
      for await (const chunk of response.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.length;
        if (expectedBytes != null && bytes > expectedBytes)
          throw new Error(
            `prepare-cua-driver: byte limit exceeded at ${bytes} bytes (expected ${expectedBytes}).`,
          );
        hash.update(buf);
        await file.write(buf);
      }
    } finally {
      await file.close();
    }
    if (expectedBytes != null && bytes !== expectedBytes)
      throw new Error(
        `prepare-cua-driver: checksum-mismatch: got ${bytes} bytes, expected ${expectedBytes}.`,
      );
    const actual = hash.digest('hex');
    if (actual.toLowerCase() !== String(expectedSha256).toLowerCase())
      throw new Error(`prepare-cua-driver: checksum-mismatch: downloaded SHA256 ${actual}.`);
    await rename(tmp, dest);
    return { bytes, sha256: actual.toLowerCase() };
  } finally {
    clearTimeout(timer);
    await rm(tmp, { force: true });
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function findShell() {
  if (process.platform === 'win32') return 'powershell.exe';
  for (const candidate of ['pwsh', 'powershell.exe', 'powershell']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$true'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (probe.status === 0) return candidate;
  }
  throw new Error('prepare-cua-driver: no PowerShell found; extraction needs powershell/pwsh on PATH.');
}

export function sha256Stream(path) {
  return new Promise((accept, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => accept(hash.digest('hex')));
  });
}

export async function verifyArchive(
  archive,
  { expectedSha256 = CUA_DRIVER_ASSET_SHA256, expectedBytes = CUA_DRIVER_ASSET_BYTES } = {},
) {
  const info = await stat(archive).catch(() => null);
  if (!info?.isFile()) throw new Error(`prepare-cua-driver: archive not found: ${archive}`);
  if (expectedBytes != null && info.size !== expectedBytes)
    throw new Error(
      `prepare-cua-driver: checksum-mismatch: archive is ${info.size} bytes, expected ${expectedBytes}.`,
    );
  const actual = await sha256Stream(archive);
  if (actual.toLowerCase() !== String(expectedSha256).toLowerCase())
    throw new Error(
      `prepare-cua-driver: checksum-mismatch: archive SHA256 ${actual}, expected ${expectedSha256}.`,
    );
  return { bytes: info.size, sha256: actual.toLowerCase() };
}

function runShell(script) {
  const result = spawnSync(findShell(), ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error(
      `prepare-cua-driver: powershell failed: ${(result.stderr || result.error?.message || 'unknown error').slice(-2000)}`,
    );
  return result.stdout ?? '';
}

const ZIP_ASSEMBLY = 'Add-Type -AssemblyName System.IO.Compression.FileSystem;';

/**
 * List raw zip entry names without extracting anything.
 */
export function listArchiveEntries(archive) {
  const script =
    `${ZIP_ASSEMBLY}$zip = [System.IO.Compression.ZipFile]::OpenRead(${psQuote(archive)}); ` +
    `$zip.Entries | ForEach-Object { $_.FullName }; $zip.Dispose()`;
  const lines = runShell(script).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function checkEntryName(name) {
  if (!name) return 'empty entry name';
  if (name.includes('\0')) return 'NUL byte in entry name';
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return `absolute entry ${name}`;
  if (/^[a-zA-Z]:/.test(normalized)) return `drive-letter entry ${name}`;
  if (normalized.split('/').some((part) => part === '..')) return `traversal entry ${name}`;
  return null;
}

/**
 * Validate entry names BEFORE anything is extracted, then pick exactly one
 * zip entry per allowlisted exe. Throws on absolute, drive-letter,
 * traversal, duplicate, missing, or ambiguous entries.
 * Returns [{ name, entry }] with canonical dest names and zip FullNames.
 */
export function validateArchiveEntries(names) {
  const seen = new Set();
  const matches = new Map();
  for (const name of names) {
    const problem = checkEntryName(name);
    if (problem)
      throw new Error(`prepare-cua-driver: unsafe archive entry (${problem}); refusing to extract.`);
    if (seen.has(name))
      throw new Error(`prepare-cua-driver: duplicate archive entry ${name}; refusing to extract.`);
    seen.add(name);
    if (name.replace(/\\/g, '/').endsWith('/')) continue;
    const base = basename(name.replace(/\\/g, '/'));
    const wanted = REQUIRED_EXES.find((entry) => entry.toLowerCase() === base.toLowerCase());
    if (!wanted) continue;
    if (!matches.has(wanted)) matches.set(wanted, []);
    matches.get(wanted).push(name);
  }
  const picked = [];
  for (const wanted of REQUIRED_EXES) {
    const hits = matches.get(wanted) ?? [];
    if (!hits.length) throw new Error(`prepare-cua-driver: archive has no ${wanted}.`);
    if (hits.length > 1)
      throw new Error(
        `prepare-cua-driver: archive has ${hits.length} copies of ${wanted}; refusing ambiguous pick.`,
      );
    picked.push({ name: wanted, entry: hits[0] });
  }
  return picked;
}

function extractPickedEntries(archive, picked, tempDir) {
  const steps = picked.map(
    ({ entry, name }) =>
      `$zip.Entries | Where-Object { $_.FullName -ceq ${psQuote(entry)} } | ForEach-Object { ` +
      `[System.IO.Compression.ZipFileExtensions]::ExtractToFile($_, ${psQuote(join(tempDir, name))}, $true) }`,
  );
  runShell(
    `${ZIP_ASSEMBLY}$zip = [System.IO.Compression.ZipFile]::OpenRead(${psQuote(archive)}); ` +
      steps.join('; ') +
      '; $zip.Dispose()',
  );
}

/**
 * Extract only the two allowlisted exes from a verified archive.
 * Entry names are validated first; only the two picked entries are ever
 * written, under canonical names inside the owned temp dir. The exes are
 * read and hashed afterwards, never executed.
 * Returns [{ name, path }] with temp-dir owned copies.
 */
export async function extractNeededExes(archive, tempDir) {
  const picked = validateArchiveEntries(listArchiveEntries(archive));
  extractPickedEntries(archive, picked, tempDir);
  const exes = [];
  for (const { name } of picked) {
    const path = join(tempDir, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || !info.size)
      throw new Error(`prepare-cua-driver: extracted ${name} is missing or empty.`);
    exes.push({ name, path });
  }
  return exes;
}

async function resolveLicenseText({ licenseSrc, licenseText } = {}) {
  if (licenseText != null) return String(licenseText);
  if (licenseSrc) return await readFile(resolve(licenseSrc), 'utf8');
  const response = await fetch(CUA_DRIVER_LICENSE_URL);
  if (!response.ok)
    throw new Error(
      `prepare-cua-driver: cannot fetch pinned license ${CUA_DRIVER_LICENSE_URL} (HTTP ${response.status}); pass --license-src <file>.`,
    );
  return await response.text();
}

/**
 * Verify an already staged sidecar dir (hashes both exes). Used by the
 * desktop resource build before fingerprinting. Throws on any mismatch.
 * The asset hash defaults to the pinned value; offline tests staging fake
 * archives pass their own { assetSha256 }.
 */
export async function verifyCuaDriverSidecar(dir, { assetSha256 = CUA_DRIVER_ASSET_SHA256 } = {}) {
  const missing = [];
  for (const name of CUA_DRIVER_SIDECAR_FILES) {
    if (!(await stat(join(dir, name)).catch(() => null))?.isFile()) missing.push(name);
  }
  if (missing.length)
    throw new Error(
      `CUA driver sidecar incomplete in ${dir} (missing ${missing.join(', ')}); run node scripts/prepare-cua-driver.mjs.`,
    );
  if ((await readFile(join(dir, 'VERSION'), 'utf8')).trim() !== CUA_DRIVER_VERSION)
    throw new Error(`CUA driver VERSION drift in ${dir}; run node scripts/prepare-cua-driver.mjs.`);
  const source = JSON.parse(await readFile(join(dir, 'source.json'), 'utf8'));
  if (
    source.version !== CUA_DRIVER_VERSION ||
    source.tag !== CUA_DRIVER_TAG ||
    source.commit !== CUA_DRIVER_COMMIT ||
    source.assetSha256 !== assetSha256 ||
    source.repo !== CUA_DRIVER_REPO
  )
    throw new Error(
      `CUA driver source.json provenance drift in ${dir}; run node scripts/prepare-cua-driver.mjs.`,
    );
  const sums = new Map();
  for (const line of (await readFile(join(dir, 'SHA256SUMS'), 'utf8')).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  for (const name of REQUIRED_EXES) {
    const expected = sums.get(name);
    if (!expected) throw new Error(`CUA driver SHA256SUMS has no entry for ${name} in ${dir}.`);
    const actual = await sha256Stream(join(dir, name));
    if (actual !== expected)
      throw new Error(
        `CUA driver checksum-mismatch for ${name} in ${dir}; run node scripts/prepare-cua-driver.mjs.`,
      );
  }
  const license = await readFile(join(dir, CUA_DRIVER_LICENSE), 'utf8');
  if (!license.trim()) throw new Error(`CUA driver license is empty in ${dir}.`);
  return { dir, version: CUA_DRIVER_VERSION };
}

/**
 * Full prepare: verify archive, extract two exes, write manifests, mirror
 * to the runtime staging dir. Options allow offline test injection:
 * { studioRoot, archive, outputDir, stageDir, noStage, expectedSha256,
 *   expectedBytes, assetUrl, licenseSrc, licenseText }.
 */
export async function prepareCuaDriver(options = {}) {
  const studioRoot = resolve(options.studioRoot ?? defaultStudioRoot());
  const defaults = defaultPreparePaths(studioRoot);
  const archiveIsDefault = options.archive == null;
  const archive = resolve(options.archive ?? defaults.archive);
  const outputDir = resolve(options.outputDir ?? defaults.outputDir);
  const stageDir = resolve(options.stageDir ?? defaults.stageDir);
  const expectedSha256 = options.expectedSha256 ?? CUA_DRIVER_ASSET_SHA256;
  const expectedBytes = options.expectedBytes ?? CUA_DRIVER_ASSET_BYTES;
  if (archiveIsDefault && !(await stat(archive).catch(() => null))?.isFile()) {
    const seed = legacyResearchArchivePath(studioRoot);
    if ((await stat(seed).catch(() => null))?.isFile()) {
      await verifyArchive(seed, { expectedSha256, expectedBytes });
      await mkdir(dirname(archive), { recursive: true });
      await copyFile(seed, archive);
    } else {
      await downloadArchive(archive, {
        expectedBytes,
        expectedSha256,
        fetchImpl: options.fetchImpl,
      });
    }
  }
  const verified = await verifyArchive(archive, { expectedSha256, expectedBytes });
  const tempDir = await mkdtemp(join(tmpdir(), 'cua-driver-prepare-'));
  try {
    const exes = await extractNeededExes(archive, tempDir);
    const licenseText = await resolveLicenseText(options);
    if (!licenseText.trim()) throw new Error('prepare-cua-driver: license text is empty.');
    const files = [];
    for (const { name, path } of exes) {
      const data = await readFile(path);
      if (!data.length) throw new Error(`prepare-cua-driver: extracted ${name} is empty.`);
      files.push({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), data });
    }
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    for (const file of files) await writeFile(join(outputDir, file.name), file.data);
    await writeFile(join(outputDir, CUA_DRIVER_LICENSE), licenseText);
    await writeFile(join(outputDir, 'VERSION'), `${CUA_DRIVER_VERSION}\n`);
    await writeFile(
      join(outputDir, 'SHA256SUMS'),
      `${files.map((file) => `${file.sha256}  ${file.name}`).join('\n')}\n`,
    );
    await writeFile(
      join(outputDir, 'source.json'),
      `${JSON.stringify(
        {
          repo: CUA_DRIVER_REPO,
          tag: CUA_DRIVER_TAG,
          commit: CUA_DRIVER_COMMIT,
          version: CUA_DRIVER_VERSION,
          releaseId: CUA_DRIVER_RELEASE_ID,
          asset: basename(archive),
          assetUrl: options.assetUrl ?? CUA_DRIVER_ASSET_URL,
          assetSha256: verified.sha256,
          assetBytes: verified.bytes,
          target: 'win32-x64',
          license: CUA_DRIVER_LICENSE,
          files: files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
        },
        null,
        2,
      )}\n`,
    );
    await verifyCuaDriverSidecar(outputDir, { assetSha256: verified.sha256 });
    let staged = null;
    if (!options.noStage) {
      await rm(stageDir, { recursive: true, force: true });
      await mkdir(stageDir, { recursive: true });
      for (const name of CUA_DRIVER_SIDECAR_FILES)
        await copyFile(join(outputDir, name), join(stageDir, name));
      await verifyCuaDriverSidecar(stageDir, { assetSha256: verified.sha256 });
      staged = stageDir;
    }
    return {
      outputDir,
      stageDir: staged,
      files: files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function printHelp() {
  const defaults = defaultPreparePaths();
  console.log(`Stage the pinned CUA driver sidecar (${CUA_DRIVER_VERSION}, Windows x64).

Usage: node scripts/prepare-cua-driver.mjs [options]

Options:
  --archive <path>        Source -binary.zip (default: ${defaults.archive};
                            when absent it is seeded from the research path or
                            downloaded from the exact pinned URL; an explicit
                            path must exist and is never fetched)
  --output-dir <path>     Dev cache dir (default: ${defaults.outputDir})
  --stage-dir <path>      Runtime staging dir (default: ${defaults.stageDir})
  --no-stage              Skip the runtime staging mirror
  --expected-sha256 <hex> Archive hash (default: pinned ${CUA_DRIVER_ASSET_SHA256.slice(0, 12)}...)
  --expected-bytes <n>    Archive size (default: pinned ${CUA_DRIVER_ASSET_BYTES})
  --license-src <path>    Use a local MIT license file instead of fetching the pinned tag
  --verify <dir>          Only verify an already staged sidecar dir
  --help                  Show this help

Never installs, never mutates PATH/tasks/registry, never runs the driver.`);
}

const invokedAsMain = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  try {
    if (args.includes('--help')) {
      printHelp();
    } else if (args.includes('--verify')) {
      const dir = get('--verify') ?? defaultPreparePaths().stageDir;
      await verifyCuaDriverSidecar(resolve(dir));
      console.log(`CUA driver sidecar verified: ${dir}`);
    } else {
      const result = await prepareCuaDriver({
        archive: get('--archive'),
        outputDir: get('--output-dir'),
        stageDir: get('--stage-dir'),
        noStage: args.includes('--no-stage'),
        expectedSha256: get('--expected-sha256'),
        expectedBytes: get('--expected-bytes') == null ? undefined : Number(get('--expected-bytes')),
        licenseSrc: get('--license-src'),
      });
      console.log(`CUA driver ${CUA_DRIVER_VERSION} staged: ${result.outputDir}`);
      for (const file of result.files)
        console.log(`  ${file.sha256.slice(0, 12)}..  ${file.name} (${file.bytes} bytes)`);
      if (result.stageDir) console.log(`Mirrored for build staging: ${result.stageDir}`);
    }
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
