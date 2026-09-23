/**
 * Pinned CUA driver runtime resolver (beta, Windows x64 only).
 *
 * Trusted roots only: the Studio root derived from import.meta (this file
 * lives in <studioRoot>/lib) or an explicit options.studioRoot test
 * injection. This module never reads the user project cwd, never searches
 * PATH, and never executes the driver. It only resolves paths and reports
 * availability for the backend manager to consume.
 *
 * Lookup order for cua-driver.exe:
 *   1. <studioRoot>/runtime/cua-driver/cua-driver.exe (packaged sidecar)
 *   2. <studioRoot>/.local/cua-driver/0.28.2/win32-x64/cua-driver.exe (dev cache)
 *
 * Sidecar layout (both locations):
 *   cua-driver.exe, cua-driver-uia.exe, LICENSE.cua-driver.md,
 *   VERSION, SHA256SUMS, source.json
 *
 * Integrity policy (no 50MB hash on every status poll):
 * File identity (byte size plus mtime of both exes, plus the expected
 * hashes) is cached in process after a full SHA256 verification against
 * SHA256SUMS. Repeated polls with unchanged identity reuse the cached
 * verdict without rehashing. Any identity change triggers a fresh hash and
 * fails closed (unavailable) on mismatch, as do missing manifests, VERSION
 * drift, or provenance drift in source.json. The prepare script
 * (scripts/prepare-cua-driver.mjs) is the only writer; it verifies the
 * pinned zip SHA256 before extracting.
 *
 * Integrity chain (pinned asset to running backend):
 *   1. Release asset: the -binary.zip is pinned by URL, byte size and
 *      SHA256 (constants below), verified by scripts/prepare-cua-driver.mjs
 *      before anything is extracted.
 *   2. Staged manifests: prepare records each extracted exe (name, bytes,
 *      SHA256) in SHA256SUMS and source.json next to the exes.
 *   3. Build gate: scripts/build-desktop-resources.mjs re-verifies the
 *      staging dir with a full hash before copying it under
 *      .desktop-build/studio/runtime/cua-driver for fingerprinting.
 *   4. Runtime status: this module rechecks manifests and provenance on
 *      first sight per file identity, then caches the verdict and only
 *      rehashes when the identity changes; any mismatch fails closed.
 * A standalone runtime/cua-driver dir is accepted only with valid
 * manifests; bare exes without VERSION, source.json and SHA256SUMS are
 * reported unavailable, never trusted.
 *
 * Beta scope: Windows x64 only. Every other platform reports
 * { available: false, supported: false } with an explicit reason. No macOS
 * or Linux behavior is claimed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CUA_DRIVER_BACKEND = 'cua';
export const CUA_DRIVER_VERSION = '0.28.2';
export const CUA_DRIVER_TAG = 'cua-driver-rs-v0.28.2';
export const CUA_DRIVER_COMMIT = 'fc188250b4ca8549b8e61f937fdb1fb560770e86';
export const CUA_DRIVER_REPO = 'trycua/cua';
export const CUA_DRIVER_RELEASE_ID = 389486122;
export const CUA_DRIVER_ASSET = 'cua-driver-rs-0.28.2-windows-x86_64-binary.zip';
export const CUA_DRIVER_ASSET_URL = `https://github.com/trycua/cua/releases/download/${CUA_DRIVER_TAG}/${CUA_DRIVER_ASSET}`;
export const CUA_DRIVER_ASSET_SHA256 = '1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba';
export const CUA_DRIVER_ASSET_BYTES = 29085823;
export const CUA_DRIVER_EXE = 'cua-driver.exe';
export const CUA_DRIVER_UIA_EXE = 'cua-driver-uia.exe';
export const CUA_DRIVER_LICENSE = 'LICENSE.cua-driver.md';

const verifiedByDir = new Map();

export function defaultStudioRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function asStudioRoot(options) {
  return resolve(options?.studioRoot ?? defaultStudioRoot());
}

export function clearCuaDriverCache() {
  verifiedByDir.clear();
}

/**
 * Resolve the driver exe path without verification or execution.
 * Returns the absolute path, or null when no sidecar is staged.
 */
export function resolveCuaDriverPath(options = {}) {
  const studioRoot = asStudioRoot(options);
  const packaged = join(studioRoot, 'runtime', 'cua-driver', CUA_DRIVER_EXE);
  if (existsSync(packaged)) return packaged;
  const cached = join(studioRoot, '.local', 'cua-driver', CUA_DRIVER_VERSION, 'win32-x64', CUA_DRIVER_EXE);
  if (existsSync(cached)) return cached;
  return null;
}

function fail(supported, reason) {
  return {
    available: false,
    backend: CUA_DRIVER_BACKEND,
    path: null,
    version: CUA_DRIVER_VERSION,
    reason,
    supported,
  };
}

function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(trimmed);
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

function sha256FileSync(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Describe CUA backend availability. Never throws, never executes anything.
 * Test injections allowed: { studioRoot, platform, arch }.
 */
export function getCuaDriverAvailability(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== 'win32' || arch !== 'x64')
    return fail(
      false,
      `unsupported-platform: CUA driver beta supports Windows x64 only (got ${platform}-${arch}).`,
    );
  const studioRoot = asStudioRoot(options);
  const exePath = resolveCuaDriverPath({ studioRoot });
  if (!exePath)
    return fail(
      true,
      `missing-artifacts: stage ${CUA_DRIVER_VERSION} with node scripts/prepare-cua-driver.mjs ` +
        `(looked in runtime/cua-driver and .local/cua-driver/${CUA_DRIVER_VERSION}/win32-x64 under the Studio root).`,
    );
  const dir = dirname(exePath);
  const uiaPath = join(dir, CUA_DRIVER_UIA_EXE);
  try {
    const exeStat = statSync(exePath);
    if (!exeStat.isFile() || exeStat.size <= 0)
      return fail(true, 'checksum-mismatch: cua-driver.exe is missing or empty.');
    let uiaStat;
    try {
      uiaStat = statSync(uiaPath);
    } catch {
      return fail(true, 'missing-artifacts: cua-driver-uia.exe must sit beside cua-driver.exe.');
    }
    if (!uiaStat.isFile() || uiaStat.size <= 0)
      return fail(true, 'checksum-mismatch: cua-driver-uia.exe is missing or empty.');
    const version = readFileSync(join(dir, 'VERSION'), 'utf8').trim();
    if (version !== CUA_DRIVER_VERSION)
      return fail(true, `checksum-mismatch: VERSION reports ${version}, expected ${CUA_DRIVER_VERSION}.`);
    const source = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8'));
    if (
      source.version !== CUA_DRIVER_VERSION ||
      source.tag !== CUA_DRIVER_TAG ||
      source.commit !== CUA_DRIVER_COMMIT ||
      source.assetSha256 !== CUA_DRIVER_ASSET_SHA256 ||
      source.repo !== CUA_DRIVER_REPO
    ) {
      verifiedByDir.delete(dir);
      return fail(
        true,
        'checksum-mismatch: source.json provenance drift; re-run scripts/prepare-cua-driver.mjs.',
      );
    }
    const sums = parseSha256Sums(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'));
    const expectedExe = sums.get(CUA_DRIVER_EXE);
    const expectedUia = sums.get(CUA_DRIVER_UIA_EXE);
    if (!expectedExe || !expectedUia)
      return fail(
        true,
        'checksum-mismatch: SHA256SUMS must list both cua-driver.exe and cua-driver-uia.exe.',
      );
    const identity = `${exeStat.size}:${exeStat.mtimeMs}:${uiaStat.size}:${uiaStat.mtimeMs}:${expectedExe}:${expectedUia}`;
    const cached = verifiedByDir.get(dir);
    if (cached?.key === identity && cached.ok)
      return {
        available: true,
        backend: CUA_DRIVER_BACKEND,
        path: exePath,
        version: CUA_DRIVER_VERSION,
        reason: null,
        supported: true,
      };
    if (sha256FileSync(exePath) !== expectedExe || sha256FileSync(uiaPath) !== expectedUia) {
      verifiedByDir.delete(dir);
      return fail(
        true,
        'checksum-mismatch: driver hash does not match SHA256SUMS; re-run scripts/prepare-cua-driver.mjs.',
      );
    }
    verifiedByDir.set(dir, { key: identity, ok: true });
    return {
      available: true,
      backend: CUA_DRIVER_BACKEND,
      path: exePath,
      version: CUA_DRIVER_VERSION,
      reason: null,
      supported: true,
    };
  } catch (error) {
    verifiedByDir.delete(dir);
    const code = error?.code === 'ENOENT' ? 'missing-artifacts' : 'checksum-mismatch';
    return fail(true, `${code}: ${error?.message ?? error} (re-run node scripts/prepare-cua-driver.mjs).`);
  }
}
