/**
 * pastudio-container — versioned `.pastudio` ZIP container (in-memory only).
 *
 * Single-owner module. Frozen: parent owns manifest digest + routes + merge.
 * This module owns ONLY the byte container: strict writer + strict parser.
 *
 * Format: standard ZIP (stored/deflated for writes and reads; deflate only
 * when smaller, stored otherwise) with whitelist:
 *   - `manifest.json` (required, exactly once)
 *   - `roadmap.json` (optional, at most once)
 *   - `sessions/<safe-id>.jsonl` (zero or more)
 * where `<safe-id>` matches /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.
 *
 * Security properties:
 * - No filesystem writes, no execution, no session transformation.
 *   Payload bytes are opaque (`Buffer` copies); only filenames + sizes + CRC
 *   are interpreted.
 * - Fail closed on: bad magics, multi-disk, ZIP64, encryption, data-descriptor,
 *   unsupported method, symlink mode, directory names, absolute/traversal names,
 *   duplicates (exact + case-insensitive), size/cap violations, CRC mismatch,
 *   central/local inconsistency, overlapping ranges, trailing data.
 * - Bounded inflate via `inflateRawSync(..., { maxOutputLength })`.
 *
 * Caps (fail closed):
 * - ZIP bytes (compressed) <= 128 MiB
 * - total uncompressed <= 256 MiB
 * - entries 1..1000, each uncompressed 1..128 MiB
 * - manifest.json 1..256 KiB, roadmap.json 1..4 MiB (when present)
 *
 * Writer (`encodePastudio`) emits deterministic ZIP (method 0 stored or 8
 * deflated per entry, deflate only when smaller): sorted names, flags 0x0800
 * (UTF-8), no extra, no comment, fixed DOS date, deflate level 6.
 *
 * Digest (`digestPastudioFiles`) is canonical over sorted entries EXCLUDING
 * `manifest.json` to avoid circularity. Parent service owns the manifest
 * digest field: compute digest over other files, embed into manifest, then
 * encode. On import, recompute over decoded files (minus manifest) and compare.
 *
 * @module lib/pastudio-container.mjs
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants (frozen)
// ---------------------------------------------------------------------------

/** Container format version (writer emits this; parser does not enforce JSON schema). */
export const PASTUDIO_CONTAINER_VERSION = 1;
/** Max ZIP file bytes (compressed). */
export const PASTUDIO_COMPRESSED_MAX = 128 * 1024 * 1024;
/** Max sum of uncompressed entry sizes. */
export const PASTUDIO_UNCOMPRESSED_MAX = 256 * 1024 * 1024;
/** Max entries per archive (also min 1; manifest required). */
export const PASTUDIO_ENTRIES_MAX = 1000;
/** Max uncompressed bytes per entry. */
export const PASTUDIO_ENTRY_MAX = 128 * 1024 * 1024;
/** Max manifest.json uncompressed bytes. */
export const PASTUDIO_MANIFEST_MAX = 256 * 1024;
/** Max roadmap.json uncompressed bytes. */
export const PASTUDIO_ROADMAP_MAX = 4 * 1024 * 1024;
/** Exact manifest filename. */
export const PASTUDIO_MANIFEST_NAME = 'manifest.json';
/** Exact roadmap filename (optional). */
export const PASTUDIO_ROADMAP_NAME = 'roadmap.json';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SESSION_PREFIX = 'sessions/';
const SESSION_SUFFIX = '.jsonl';
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const FLAG_UTF8 = 0x0800;
const FLAG_ALLOWED_MASK = 0x0806; // UTF-8 + deflate option bits 1..2 only
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 0x0314; // Unix, v2.0
const EXT_ATTRS_REGULAR = 0x81a40000; // (0o100644 << 16) regular file
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021; // 1980-01-01
const EXTRA_MAX = 1024;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Container error with stable machine-readable `code`.
 * Codes: pastudio_invalid | pastudio_too_large | pastudio_too_many_entries |
 * pastudio_duplicate | pastudio_unsafe_name | pastudio_unsupported |
 * pastudio_mismatch | pastudio_missing_manifest
 */
export class PastudioError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PastudioError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new PastudioError(code, message);
};

// ---------------------------------------------------------------------------
// Filename whitelist
// ---------------------------------------------------------------------------

function isWhitelistedName(name) {
  if (typeof name !== 'string' || !name || name.length > 256) return false;
  if (name === PASTUDIO_MANIFEST_NAME || name === PASTUDIO_ROADMAP_NAME) return true;
  if (!name.startsWith(SESSION_PREFIX) || !name.endsWith(SESSION_SUFFIX)) return false;
  const id = name.slice(SESSION_PREFIX.length, -SESSION_SUFFIX.length);
  return SAFE_ID.test(id);
}

function assertWhitelistedName(name) {
  if (typeof name !== 'string' || !name) fail('pastudio_unsafe_name', 'pastudio: empty entry name.');
  if (name.length > 256) fail('pastudio_unsafe_name', `pastudio: entry name too long: ${name.slice(0, 80)}`);
  // Defense in depth: whitelist already excludes these, but reject explicitly.
  if (
    name.includes('\\') ||
    name.includes(':') ||
    name.includes('\0') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.includes('//') ||
    /(^|\/)\.\.?(\/|$)/.test(name)
  )
    fail('pastudio_unsafe_name', `pastudio: unsafe entry name: ${name.slice(0, 120)}`);
  if (!isWhitelistedName(name))
    fail('pastudio_unsafe_name', `pastudio: name not whitelisted: ${name.slice(0, 120)}`);
}

function capForName(name) {
  if (name === PASTUDIO_MANIFEST_NAME) return PASTUDIO_MANIFEST_MAX;
  if (name === PASTUDIO_ROADMAP_NAME) return PASTUDIO_ROADMAP_MAX;
  return PASTUDIO_ENTRY_MAX;
}

// ---------------------------------------------------------------------------
// encodePastudio(entries) -> Buffer (ZIP bytes, method 0, sorted)
// ---------------------------------------------------------------------------

/**
 * Encode a `.pastudio` ZIP archive in memory (stored/deflated, deterministic).
 *
 * @param {Map<string, Buffer|Uint8Array|string> | Array<[string, Buffer|Uint8Array|string]> | Array<{name:string,data:Buffer|Uint8Array|string}>} entries
 *   Entry collection. Names must satisfy the whitelist; payloads are opaque.
 * @returns {Buffer} ZIP file bytes (<= 128 MiB).
 * @throws {PastudioError} on whitelist/duplicate/cap violations.
 *
 * Notes:
 * - Accepts `Map` or array-of-pairs or array-of-{name,data}. Plain objects
 *   are rejected (prototype-pollution fail closed).
 * - `string` payloads are encoded as UTF-8. All payloads are copied.
 * - Output entries are sorted ascending by filename for determinism.
 * - Per entry: method 8 (deflated, raw, level 6) only when the compressed
 *   bytes are strictly smaller than the stored bytes; otherwise method 0
 *   (stored). CRC32 and uncompressed sizes always describe the original
 *   bytes. No encryption, no extra, no comment.
 * - Compression runs sequentially (one entry at a time) to bound CPU and
 *   avoid parallel giant allocations; deflate failure falls back to stored.
 */
export function encodePastudio(entries) {
  let list;
  if (entries instanceof Map) {
    list = [...entries.entries()].map(([name, data]) => ({ name, data }));
  } else if (Array.isArray(entries)) {
    if (!entries.length) fail('pastudio_invalid', 'pastudio: no entries.');
    if (Array.isArray(entries[0])) list = entries.map(([name, data]) => ({ name, data }));
    else if (entries[0] && typeof entries[0] === 'object' && 'name' in entries[0])
      list = entries.map((e) => ({ name: e.name, data: e.data }));
    else fail('pastudio_invalid', 'pastudio: entries array must hold pairs or {name,data}.');
  } else {
    fail('pastudio_invalid', 'pastudio: entries must be a Map or an array.');
  }

  if (list.length < 1 || list.length > PASTUDIO_ENTRIES_MAX)
    fail('pastudio_too_many_entries', `pastudio: entries ${list.length} outside 1..${PASTUDIO_ENTRIES_MAX}.`);

  const seen = new Set();
  const seenLower = new Set();
  const normalized = [];
  let totalUncompressed = 0;

  for (const { name, data } of list) {
    assertWhitelistedName(name);
    if (seen.has(name)) fail('pastudio_duplicate', `pastudio: duplicate entry: ${name}`);
    const lower = name.toLowerCase();
    if (seenLower.has(lower)) fail('pastudio_duplicate', `pastudio: case-insensitive duplicate: ${name}`);
    seen.add(name);
    seenLower.add(lower);

    let buf;
    if (typeof data === 'string') buf = Buffer.from(data, 'utf8');
    else if (Buffer.isBuffer(data)) buf = Buffer.from(data);
    else if (data instanceof Uint8Array) buf = Buffer.from(data);
    else fail('pastudio_invalid', `pastudio: bad payload type for ${name}.`);

    const cap = capForName(name);
    if (buf.length < 1 || buf.length > cap)
      fail(
        'pastudio_too_large',
        `pastudio: ${name} size ${buf.length} outside 1..${cap}.`,
      );
    if (buf.length > PASTUDIO_ENTRY_MAX)
      fail('pastudio_too_large', `pastudio: ${name} exceeds per-entry cap.`);
    totalUncompressed += buf.length;
    if (totalUncompressed > PASTUDIO_UNCOMPRESSED_MAX)
      fail('pastudio_too_large', 'pastudio: total uncompressed exceeds 256 MiB.');
    normalized.push({ name, data: buf });
  }

  if (!seen.has(PASTUDIO_MANIFEST_NAME))
    fail('pastudio_missing_manifest', 'pastudio: manifest.json is required.');

  normalized.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const nameBytesList = normalized.map((e) => Buffer.from(e.name, 'utf8'));
  for (const nb of nameBytesList) {
    if (!nb.length || nb.length > 256) fail('pastudio_unsafe_name', 'pastudio: bad filename bytes.');
  }

  // Selective deflate: compress sequentially, keep deflated bytes only when
  // strictly smaller. CRC and uncompressed sizes always describe the original
  // bytes. Sequential to bound CPU and avoid parallel giant allocations;
  // deflate failure falls back to stored (optimization only, never a cap bypass).
  const prepared = [];
  for (let i = 0; i < normalized.length; i++) {
    const { name, data } = normalized[i];
    let method = METHOD_STORED;
    let payload = data;
    if (data.length >= 256) {
      try {
        const comp = deflateRawSync(data, { level: 6 });
        if (comp.length > 0 && comp.length < data.length && comp.length <= PASTUDIO_COMPRESSED_MAX) {
          method = METHOD_DEFLATED;
          payload = Buffer.from(comp);
        }
      } catch {
        method = METHOD_STORED;
        payload = data;
      }
    }
    const crc = crc32(data);
    prepared.push({ name, data, payload, method, crc });
  }

  let localSize = 0;
  let centralSize = 0;
  for (let i = 0; i < prepared.length; i++) {
    localSize += 30 + nameBytesList[i].length + prepared[i].payload.length;
    centralSize += 46 + nameBytesList[i].length;
  }
  const totalSize = localSize + centralSize + 22;
  if (totalSize > PASTUDIO_COMPRESSED_MAX)
    fail('pastudio_too_large', `pastudio: encoded ZIP ${totalSize} bytes exceeds 128 MiB.`);

  const out = Buffer.allocUnsafe(totalSize);
  let p = 0;
  const centralOffsets = [];

  for (let i = 0; i < prepared.length; i++) {
    const { data, payload, method } = prepared[i];
    const nb = nameBytesList[i];
    const crc = prepared[i].crc;
    const localOffset = p;
    centralOffsets.push({ localOffset, crc, method });
    out.writeUInt32LE(SIG_LOCAL, p + 0);
    out.writeUInt16LE(VERSION_NEEDED, p + 4);
    out.writeUInt16LE(FLAG_UTF8, p + 6);
    out.writeUInt16LE(method, p + 8);
    out.writeUInt16LE(DOS_TIME, p + 10);
    out.writeUInt16LE(DOS_DATE, p + 12);
    out.writeUInt32LE(crc >>> 0, p + 14);
    out.writeUInt32LE(payload.length >>> 0, p + 18);
    out.writeUInt32LE(data.length >>> 0, p + 22);
    out.writeUInt16LE(nb.length, p + 26);
    out.writeUInt16LE(0, p + 28);
    nb.copy(out, p + 30);
    payload.copy(out, p + 30 + nb.length);
    p += 30 + nb.length + payload.length;
  }

  const cdOffset = p;
  for (let i = 0; i < prepared.length; i++) {
    const { data, payload, method } = prepared[i];
    const nb = nameBytesList[i];
    const { localOffset, crc } = centralOffsets[i];
    out.writeUInt32LE(SIG_CENTRAL, p + 0);
    out.writeUInt16LE(VERSION_MADE_BY, p + 4);
    out.writeUInt16LE(VERSION_NEEDED, p + 6);
    out.writeUInt16LE(FLAG_UTF8, p + 8);
    out.writeUInt16LE(method, p + 10);
    out.writeUInt16LE(DOS_TIME, p + 12);
    out.writeUInt16LE(DOS_DATE, p + 14);
    out.writeUInt32LE(crc >>> 0, p + 16);
    out.writeUInt32LE(payload.length >>> 0, p + 20);
    out.writeUInt32LE(data.length >>> 0, p + 24);
    out.writeUInt16LE(nb.length, p + 28);
    out.writeUInt16LE(0, p + 30);
    out.writeUInt16LE(0, p + 32);
    out.writeUInt16LE(0, p + 34);
    out.writeUInt16LE(0, p + 36);
    out.writeUInt32LE(EXT_ATTRS_REGULAR >>> 0, p + 38);
    out.writeUInt32LE(localOffset >>> 0, p + 42);
    nb.copy(out, p + 46);
    p += 46 + nb.length;
  }

  const cdSize = p - cdOffset;
  out.writeUInt32LE(SIG_EOCD, p + 0);
  out.writeUInt16LE(0, p + 4);
  out.writeUInt16LE(0, p + 6);
  out.writeUInt16LE(normalized.length, p + 8);
  out.writeUInt16LE(normalized.length, p + 10);
  out.writeUInt32LE(cdSize >>> 0, p + 12);
  out.writeUInt32LE(cdOffset >>> 0, p + 16);
  out.writeUInt16LE(0, p + 20);
  p += 22;

  if (p !== totalSize) fail('pastudio_invalid', 'pastudio: internal encode length mismatch.');
  return out;
}

// ---------------------------------------------------------------------------
// decodePastudio(buffer) -> Map<string, Buffer>
// ---------------------------------------------------------------------------

function readU16(buf, off) {
  if (off < 0 || off + 2 > buf.length) fail('pastudio_invalid', 'pastudio: truncated header.');
  return buf.readUInt16LE(off);
}
function readU32(buf, off) {
  if (off < 0 || off + 4 > buf.length) fail('pastudio_invalid', 'pastudio: truncated header.');
  return buf.readUInt32LE(off);
}

const filenameDecoder = new TextDecoder('utf-8', { fatal: true });
function decodeName(bytes) {
  try {
    return filenameDecoder.decode(bytes);
  } catch {
    fail('pastudio_unsafe_name', 'pastudio: entry name is not valid UTF-8.');
  }
}

function checkNoZip64Extra(extra, where) {
  let o = 0;
  while (o + 4 <= extra.length) {
    const id = extra.readUInt16LE(o);
    const sz = extra.readUInt16LE(o + 2);
    if (o + 4 + sz > extra.length) fail('pastudio_invalid', `pastudio: malformed extra field in ${where}.`);
    if (id === 0x0001) fail('pastudio_unsupported', 'pastudio: ZIP64 is not supported.');
    o += 4 + sz;
  }
  if (o !== extra.length) fail('pastudio_invalid', `pastudio: malformed extra field in ${where}.`);
}

/**
 * Decode and strictly validate a `.pastudio` ZIP archive in memory.
 *
 * @param {Buffer|Uint8Array} buffer ZIP file bytes (<= 128 MiB).
 * @returns {Map<string, Buffer>} filename -> opaque payload copy, sorted ascending.
 * @throws {PastudioError} fail-closed on any inconsistency or cap violation.
 *
 * Checks (non-exhaustive): EOCD magic + comment-length exactness, no multi-disk,
 * no ZIP64 sentinels/locator, central size/offset exactness (`cdOffset+cdSize===eocd`),
 * per-entry magics, version/method/flags allowlist (methods {0,8}; flags subset
 * of UTF-8 + deflate options; rejects encryption + data-descriptor), name-length
 * bounds, UTF-8 strict filenames, whitelist, duplicates (exact + lowercase),
 * per-file + total caps, extra-field ZIP64 scan, symlink-mode + directory-name
 * rejection, central/local field equality (flags/method/crc/sizes/name),
 * data ranges inside `[0, cdOffset)` without overlap, bounded inflate,
 * CRC32 + length verification, `manifest.json` presence.
 */
export function decodePastudio(buffer) {
  let buf;
  if (Buffer.isBuffer(buffer)) buf = buffer;
  else if (buffer instanceof Uint8Array) buf = Buffer.from(buffer);
  else fail('pastudio_invalid', 'pastudio: buffer must be a Buffer or Uint8Array.');

  if (buf.length < 22) fail('pastudio_invalid', 'pastudio: file too small to be a ZIP.');
  if (buf.length > PASTUDIO_COMPRESSED_MAX)
    fail('pastudio_too_large', 'pastudio: ZIP exceeds 128 MiB.');

  // EOCD: last occurrence whose comment length exactly reaches EOF.
  const lo = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let end = buf.length - 22; end >= lo; end--) {
    if (buf.readUInt32LE(end) === SIG_EOCD) {
      const commentLen = buf.readUInt16LE(end + 20);
      if (end + 22 + commentLen === buf.length) {
        eocd = end;
        break;
      }
    }
  }
  if (eocd < 0) fail('pastudio_invalid', 'pastudio: end-of-central-directory not found.');

  const disk = readU16(buf, eocd + 4);
  const cdDisk = readU16(buf, eocd + 6);
  const countThis = readU16(buf, eocd + 8);
  const count = readU16(buf, eocd + 10);
  const cdSize = readU32(buf, eocd + 12);
  const cdOffset = readU32(buf, eocd + 16);

  if (disk !== 0 || cdDisk !== 0) fail('pastudio_unsupported', 'pastudio: multi-disk ZIP is not supported.');
  if (countThis !== count) fail('pastudio_invalid', 'pastudio: split central directory.');
  if (count < 1 || count > PASTUDIO_ENTRIES_MAX)
    fail('pastudio_too_many_entries', `pastudio: entries ${count} outside 1..${PASTUDIO_ENTRIES_MAX}.`);
  if (
    count === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  )
    fail('pastudio_unsupported', 'pastudio: ZIP64 is not supported.');
  // ZIP64 locator immediately precedes EOCD when present (20 bytes).
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR)
    fail('pastudio_unsupported', 'pastudio: ZIP64 is not supported.');
  if (cdOffset + cdSize !== eocd)
    fail('pastudio_invalid', 'pastudio: central directory does not end at EOCD.');
  if (cdOffset >= eocd || cdSize < count * 46)
    fail('pastudio_invalid', 'pastudio: bad central directory bounds.');

  const centrals = [];
  const seen = new Set();
  const seenLower = new Set();
  let totalUncompressed = 0;
  let off = cdOffset;

  for (let i = 0; i < count; i++) {
    if (off + 46 > eocd) fail('pastudio_invalid', 'pastudio: truncated central entry.');
    if (readU32(buf, off) !== SIG_CENTRAL) fail('pastudio_invalid', 'pastudio: bad central magic.');
    const madeBy = readU16(buf, off + 4);
    void madeBy;
    const need = readU16(buf, off + 6);
    const flags = readU16(buf, off + 8);
    const method = readU16(buf, off + 10);
    const crc = readU32(buf, off + 16);
    const compSize = readU32(buf, off + 20);
    const uncompSize = readU32(buf, off + 24);
    const nameLen = readU16(buf, off + 28);
    const extraLen = readU16(buf, off + 30);
    const commentLen = readU16(buf, off + 32);
    const diskStart = readU16(buf, off + 34);
    const intAttrs = readU16(buf, off + 36);
    const extAttrs = readU32(buf, off + 38);
    const localOffset = readU32(buf, off + 42);

    if ((need & 0xff) > VERSION_NEEDED || (need >>> 8) !== 0)
      fail('pastudio_unsupported', 'pastudio: unsupported version needed.');
    if (method !== METHOD_STORED && method !== METHOD_DEFLATED)
      fail('pastudio_unsupported', `pastudio: unsupported method ${method}.`);
    if ((flags & ~FLAG_ALLOWED_MASK) !== 0)
      fail('pastudio_unsupported', 'pastudio: unsupported header flags (encryption/descriptor/other).');
    if (method === METHOD_STORED && (flags & 0x0006) !== 0)
      fail('pastudio_unsupported', 'pastudio: bad flags for stored entry.');
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff)
      fail('pastudio_unsupported', 'pastudio: ZIP64 is not supported.');
    if (nameLen < 1 || nameLen > 256) fail('pastudio_unsafe_name', 'pastudio: bad filename length.');
    if (extraLen > EXTRA_MAX) fail('pastudio_invalid', 'pastudio: extra field too large.');
    if (commentLen !== 0) fail('pastudio_invalid', 'pastudio: per-entry comments are not allowed.');
    if (diskStart !== 0) fail('pastudio_unsupported', 'pastudio: multi-disk ZIP is not supported.');
    if (intAttrs !== 0) fail('pastudio_invalid', 'pastudio: bad internal attributes.');
    if (off + 46 + nameLen + extraLen > eocd)
      fail('pastudio_invalid', 'pastudio: truncated central entry name.');

    const nameBytes = buf.subarray(off + 46, off + 46 + nameLen);
    const extra = buf.subarray(off + 46 + nameLen, off + 46 + nameLen + extraLen);
    checkNoZip64Extra(extra, 'central');
    const name = decodeName(nameBytes);
    assertWhitelistedName(name);
    if (seen.has(name)) fail('pastudio_duplicate', `pastudio: duplicate entry: ${name}`);
    const lower = name.toLowerCase();
    if (seenLower.has(lower)) fail('pastudio_duplicate', `pastudio: case-insensitive duplicate: ${name}`);
    seen.add(name);
    seenLower.add(lower);

    const cap = capForName(name);
    if (uncompSize < 1 || uncompSize > cap)
      fail('pastudio_too_large', `pastudio: ${name} size ${uncompSize} outside 1..${cap}.`);
    if (uncompSize > PASTUDIO_ENTRY_MAX)
      fail('pastudio_too_large', `pastudio: ${name} exceeds per-entry cap.`);
    if (method === METHOD_STORED && compSize !== uncompSize)
      fail('pastudio_mismatch', `pastudio: stored sizes differ for ${name}.`);
    if (method === METHOD_DEFLATED) {
      if (compSize < 1 || compSize > PASTUDIO_COMPRESSED_MAX)
        fail('pastudio_too_large', `pastudio: bad compressed size for ${name}.`);
      if (compSize > uncompSize + 65536)
        fail('pastudio_mismatch', `pastudio: bad compression bound for ${name}.`);
    }
    totalUncompressed += uncompSize;
    if (totalUncompressed > PASTUDIO_UNCOMPRESSED_MAX)
      fail('pastudio_too_large', 'pastudio: total uncompressed exceeds 256 MiB.');

    // Allowlist: regular file (0x8000) or mode 0 (common foreign ZIP with no
    // Unix mode). Reject dir/symlink/FIFO/socket/device types even though
    // payloads stay opaque.
    const ftype = (extAttrs >>> 16) & 0xf000;
    if (ftype !== 0x0000 && ftype !== 0x8000)
      fail('pastudio_unsupported', `pastudio: non-regular file type not allowed: ${name}.`);

    centrals.push({ name, flags, method, crc, compSize, uncompSize, localOffset, nameBytes });
    off += 46 + nameLen + extraLen;
  }
  if (off !== eocd) fail('pastudio_invalid', 'pastudio: central directory size mismatch.');
  if (!seen.has(PASTUDIO_MANIFEST_NAME))
    fail('pastudio_missing_manifest', 'pastudio: manifest.json is required.');

  // Second pass: local consistency + extraction (no overlap, bounded inflate, CRC).
  const ranges = [];
  const out = new Map();

  // Sort a copy for deterministic overlap checks; keep central order for reads.
  for (const c of centrals) {
    if (c.localOffset + 30 > cdOffset) fail('pastudio_invalid', `pastudio: bad local offset for ${c.name}.`);
    if (readU32(buf, c.localOffset) !== SIG_LOCAL)
      fail('pastudio_invalid', `pastudio: bad local magic for ${c.name}.`);
    const lNeed = readU16(buf, c.localOffset + 4);
    const lFlags = readU16(buf, c.localOffset + 6);
    const lMethod = readU16(buf, c.localOffset + 8);
    const lCrc = readU32(buf, c.localOffset + 14);
    const lComp = readU32(buf, c.localOffset + 18);
    const lUncomp = readU32(buf, c.localOffset + 22);
    const lNameLen = readU16(buf, c.localOffset + 26);
    const lExtraLen = readU16(buf, c.localOffset + 28);
    if (lExtraLen > EXTRA_MAX) fail('pastudio_invalid', `pastudio: local extra too large for ${c.name}.`);
    const dataStart = c.localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + c.compSize > cdOffset || dataStart < c.localOffset + 30)
      fail('pastudio_invalid', `pastudio: local data out of bounds for ${c.name}.`);

    if (lFlags !== c.flags) fail('pastudio_mismatch', `pastudio: flags differ for ${c.name}.`);
    if (lMethod !== c.method) fail('pastudio_mismatch', `pastudio: method differs for ${c.name}.`);
    if (lCrc !== c.crc) fail('pastudio_mismatch', `pastudio: CRC differs for ${c.name}.`);
    if (lComp !== c.compSize || lUncomp !== c.uncompSize)
      fail('pastudio_mismatch', `pastudio: sizes differ for ${c.name}.`);
    if ((lNeed & 0xff) > VERSION_NEEDED || (lNeed >>> 8) !== 0)
      fail('pastudio_unsupported', `pastudio: unsupported local version for ${c.name}.`);
    if (lNameLen !== c.nameBytes.length)
      fail('pastudio_mismatch', `pastudio: filename length differs for ${c.name}.`);
    const lNameBytes = buf.subarray(c.localOffset + 30, c.localOffset + 30 + lNameLen);
    if (!lNameBytes.equals(c.nameBytes))
      fail('pastudio_mismatch', `pastudio: filename differs for ${c.name}.`);
    const lExtra = buf.subarray(c.localOffset + 30 + lNameLen, dataStart);
    checkNoZip64Extra(lExtra, 'local');

    ranges.push({ start: c.localOffset, end: dataStart, name: c.name });
    ranges.push({ start: dataStart, end: dataStart + c.compSize, name: c.name });
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (r.start < 0 || r.end > cdOffset || r.end < r.start)
      fail('pastudio_invalid', `pastudio: range out of bounds for ${r.name}.`);
    if (i > 0 && r.start < ranges[i - 1].end)
      fail('pastudio_invalid', `pastudio: overlapping ranges (${ranges[i - 1].name}, ${r.name}).`);
  }

  for (const c of centrals) {
    // Recompute dataStart (validated above).
    const lNameLen = readU16(buf, c.localOffset + 26);
    const lExtraLen = readU16(buf, c.localOffset + 28);
    const dataStart = c.localOffset + 30 + lNameLen + lExtraLen;
    const packed = buf.subarray(dataStart, dataStart + c.compSize);
    let data;
    if (c.method === METHOD_STORED) {
      if (packed.length !== c.uncompSize)
        fail('pastudio_mismatch', `pastudio: stored length differs for ${c.name}.`);
      data = Buffer.from(packed);
    } else {
      let inflated;
      try {
        inflated = inflateRawSync(packed, { maxOutputLength: Math.max(1, c.uncompSize) });
      } catch {
        fail('pastudio_mismatch', `pastudio: inflate failed for ${c.name}.`);
      }
      if (inflated.length !== c.uncompSize)
        fail('pastudio_mismatch', `pastudio: inflated length differs for ${c.name}.`);
      data = Buffer.from(inflated);
    }
    if (data.length !== c.uncompSize)
      fail('pastudio_mismatch', `pastudio: size mismatch for ${c.name}.`);
    if (crc32(data) !== (c.crc >>> 0))
      fail('pastudio_mismatch', `pastudio: CRC mismatch for ${c.name}.`);
    out.set(c.name, data);
  }

  // Canonical sorted order.
  return new Map([...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

// ---------------------------------------------------------------------------
// digestPastudioFiles(files) -> sha256 hex (excludes manifest.json)
// ---------------------------------------------------------------------------

function u32be(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}
function u64be(n) {
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}

/**
 * Canonical digest over entry files, EXCLUDING `manifest.json`.
 *
 * Parent service owns the manifest digest field (no circularity): compute this
 * digest over all other files, embed the hex into `manifest.json`, then
 * `encodePastudio`. On import, recompute over decoded files minus manifest and
 * compare to the manifest field.
 *
 * Canonical form: `pastudio-container-v1\0` + count BE32 + for each entry
 * sorted ascending by filename: nameLen BE32 + nameBytes + dataLen BE64 + data.
 *
 * @param {Map<string, Buffer|Uint8Array>} files filename -> opaque bytes.
 * @returns {string} lowercase sha256 hex.
 */
export function digestPastudioFiles(files) {
  if (!(files instanceof Map)) fail('pastudio_invalid', 'pastudio: files must be a Map.');
  const items = [];
  for (const [name, data] of files) {
    if (typeof name !== 'string') fail('pastudio_invalid', 'pastudio: bad filename for digest.');
    if (name === PASTUDIO_MANIFEST_NAME) continue;
    let buf;
    if (Buffer.isBuffer(data)) buf = data;
    else if (data instanceof Uint8Array) buf = Buffer.from(data);
    else fail('pastudio_invalid', `pastudio: bad payload for digest: ${name}.`);
    items.push([name, buf]);
  }
  items.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = createHash('sha256');
  h.update('pastudio-container-v1\0', 'utf8');
  h.update(u32be(items.length));
  for (const [name, buf] of items) {
    const nb = Buffer.from(name, 'utf8');
    h.update(u32be(nb.length));
    h.update(nb);
    h.update(u64be(buf.length));
    h.update(buf);
  }
  return h.digest('hex');
}
