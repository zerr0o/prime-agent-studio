// lib/public-api-files.mjs
//
// Generic linked-file listing and download for external API clients.
//
// Parent responsibilities (NOT done here): authentication, token scopes,
// session/project authorization, route wiring, machine identity (supplied as
// `machineId`), and deciding which receipt directory to use. This module never
// reads synchronization state and never treats sync metadata as proof that
// this machine holds any file bytes.
//
// Provenance model:
// - Markdown links, local Markdown image references and inline code spans in
//   persisted conversation text form the only linkable references. Fenced code
//   blocks, plain prose paths, HTML, remote/data URLs, tool arguments/results
//   and thinking output are never links.
// - A linked path is servable only with per-reference LOCAL provenance: the
//   parent calls recordLocal() from actual native run message events, which
//   persists that message's validated link fingerprints (hashes only, never
//   bytes or text) under dataDir. list()/download() require both the persisted
//   conversation history AND the local receipt for that reference. Unknown
//   legacy or synced references stay unavailable (fail closed); a session that
//   resumes on another host never blanket-grants its old references there.
// - Native inline image attachments (embedded bytes) stay metadata-only in
//   v1: they are listed from stored attachment metadata but no blob fetch is
//   offered. UUID-addressed attachment bytes already stored in attachmentDir
//   are servable by id; linked paths under private dataDir/agentHome-style
//   protected roots stay refused.
// - Nothing is ever copied to another store or proxied from another machine.
// - Validation is per request, not an immutable in-flight guarantee: files are
//   opened, identity-checked (device + inode before open, on the open handle,
//   and on the re-resolved path after open) and streamed from the open handle,
//   but no snapshot copy is built. A local writer racing the open can still
//   change bytes mid-stream; validators (ETag with device/inode/size/mtime/
//   change-time) let strict clients detect it on resume instead.
// - Where the runtime offers them (POSIX), files open with O_NONBLOCK |
//   O_NOFOLLOW so a reference swapped to a FIFO cannot hang the open and a
//   trailing symlink swapped in at open time fails closed. On Windows those
//   constants do not exist: named-pipe `//./` style targets are rejected as
//   network namespaces and regular-file + identity checks still apply.
//   This is a trust boundary against confused references, not a sandbox
//   against arbitrary local code (parent scope warning retained).
//
// Errors thrown before streaming carry { status, code, message } for the
// parent to map to its error format. Nothing is written to `res` then.

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, readFile, realpath, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const fail = (status, code, message) => {
  throw Object.assign(new Error(message), { status, code });
};

const ATTACHMENT_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ATTACHMENT_SUFFIX = /^\.[a-zA-Z0-9]{1,12}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const DRIVE_ABSOLUTE = /^[a-z]:\//i;
const MAX_REFERENCE_CHARS = 4096;
const MAX_RESOLVED_CHARS = 32767;
const MAX_RECEIPT_REFS = 1000;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_RECORD_MESSAGES = 200;
const MAX_SCANNED_TEXT = 200000;
const RECEIPT_SUBDIR = 'public-api-file-receipts';
const MAX_META_BYTES = 65536;

// O_NONBLOCK keeps a swapped-in FIFO from hanging the open; O_NOFOLLOW makes
// a trailing symlink swapped in at open time fail with ELOOP instead of
// following it. Both exist on POSIX only: on Windows the constants are
// undefined and opening falls back to plain read mode, with namespace and
// device/inode identity checks still enforced below.
const OPEN_FLAGS =
  typeof fsConstants.O_NONBLOCK === 'number' && typeof fsConstants.O_NOFOLLOW === 'number'
    ? fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW
    : 'r';

// Local-namespace predicate for resolved targets: even when the persisted
// reference looks local, a symlink/junction underneath may point at a network
// share, a device or an alternate data stream. Resolved paths must stay in
// the local file namespace.
export function isLocalNamespace(value) {
  if (typeof value !== 'string' || !value) return false;
  const path = value.replaceAll('\\', '/');
  if (path.startsWith('//')) return false;
  const lower = path.toLowerCase();
  if (lower === '/dev/null' || lower.startsWith('/dev/')) return false;
  const withoutDrive = DRIVE_ABSOLUTE.test(path) ? path.slice(2) : path;
  if (withoutDrive.includes(':')) return false;
  return true;
}

function assertLocalNamespace(actual) {
  const path = String(actual).replaceAll('\\', '/');
  if (path.startsWith('//')) fail(400, 'network_path', 'Network paths are never served.');
  const lower = path.toLowerCase();
  if (lower === '/dev/null' || lower.startsWith('/dev/'))
    fail(400, 'device_path', 'Device paths are never served.');
  const withoutDrive = DRIVE_ABSOLUTE.test(path) ? path.slice(2) : path;
  if (withoutDrive.includes(':')) fail(400, 'unsafe_path', 'Unsafe file target (stream namespace).');
}

// Viewer parity predicate (public/file-links.js isFileReference): decides which
// Markdown href / code-span strings count as file references. Deliberately
// dependency-free so this module never pulls browser-only code.
export function isLocalFileReference(value) {
  if (typeof value !== 'string' || value.length > MAX_REFERENCE_CHARS || /[\x00-\x1f]/.test(value))
    return false;
  const path = value.trim();
  if (!path || path.startsWith('#') || /^\/\//.test(path)) return false;
  if (/^[a-z][\w+.-]*:/i.test(path) && !/^(?:file:|[a-z]:[\\/])/i.test(path)) return false;
  const stripped = path.replace(/(?:#L?\d+(?:[-:]L?\d+)?|:\d+(?::\d+)?)$/, '');
  if (!stripped) return false;
  if (/^file:/i.test(stripped) || /^[a-z]:[\\/]/i.test(stripped)) return true;
  if (/[\\/]/.test(stripped)) return true;
  return /\.[A-Za-z0-9]{1,10}$/.test(stripped);
}

function walkInlineTokens(nodes, push) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if ((node.type === 'link' || node.type === 'image') && typeof node.href === 'string') push(node.href);
    else if (node.type === 'codespan' && typeof node.text === 'string') push(node.text);
    if (Array.isArray(node.tokens)) walkInlineTokens(node.tokens, push);
    if (Array.isArray(node.items)) walkInlineTokens(node.items, push);
    if (node.type === 'table') {
      const cells = [...(node.header || []), ...(node.rows || []).flat()];
      for (const cell of cells) {
        if (cell && Array.isArray(cell.tokens)) walkInlineTokens(cell.tokens, push);
      }
    }
  }
}

// Ordered, deduplicated linkable references from persisted message text:
// Markdown link hrefs, local Markdown image hrefs and inline code spans that
// pass isLocalFileReference. Fenced code, remote/data URLs, plain prose and
// HTML never qualify.
export function extractLinkedReferences(messages) {
  const refs = [];
  const seen = new Set();
  const push = (value) => {
    if (typeof value !== 'string') return;
    const reference = value.trim();
    if (!reference || seen.has(reference) || !isLocalFileReference(reference)) return;
    seen.add(reference);
    refs.push(reference);
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message.text !== 'string' || !message.text) continue;
    let tokens;
    try {
      tokens = marked.lexer(message.text.slice(0, MAX_SCANNED_TEXT));
    } catch {
      continue;
    }
    walkInlineTokens(tokens, push);
  }
  return refs;
}

// Stored file attachment references ({ type: 'file', id, name, size }) from
// message metadata. Image entries with embedded bytes stay metadata-only and
// are not collected here.
export function extractAttachmentRefs(messages) {
  const refs = [];
  const seen = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    const list = message?.attachments;
    if (!Array.isArray(list)) continue;
    for (const attachment of list) {
      if (!attachment || attachment.type !== 'file') continue;
      if (typeof attachment.id !== 'string' || seen.has(attachment.id)) continue;
      if (!ATTACHMENT_ID.test(attachment.id)) continue;
      seen.add(attachment.id);
      refs.push({
        attachId: attachment.id,
        name: typeof attachment.name === 'string' ? attachment.name : '',
        size: Number.isSafeInteger(attachment.size) ? attachment.size : null,
      });
    }
  }
  return refs;
}

// Opaque deterministic file identifier: sha256 hex (truncated to 128 bits) over
// machine + session + kind + persisted reference. Recomputable on every
// request, so no ticket store is needed; session-scoped, so the same reference
// in another session yields another id. Never encodes a path.
export function buildFileId(machineId, sessionId, kind, key) {
  return createHash('sha256')
    .update(`${machineId}\0${sessionId}\0${kind}\0${key}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export function sanitizeDownloadName(name) {
  let base = String(name ?? '').replaceAll('\\', '/');
  base = base.split('/').pop() ?? '';
  base = base
    .replace(/[\x00-\x1f\x7f\"]+/g, '')
    .trim()
    .replace(/[. ]+$/, '');
  if (!base || base === '.' || base === '..') base = 'file';
  return base.slice(0, 200);
}

function contentDisposition(name) {
  const clean = sanitizeDownloadName(name).toWellFormed();
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '') || 'file';
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (v) => `%${v.charCodeAt(0).toString(16)}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function buildEtag({ size, mtimeMs, ino, dev, ctimeMs, mtimeNs, ctimeNs }) {
  const num = (value) => (typeof value === 'bigint' || Number.isFinite(value) ? String(value) : '0');
  return `"${num(dev)}-${num(ino)}-${num(size)}-${num(mtimeNs ?? mtimeMs)}-${num(ctimeNs ?? ctimeMs)}"`;
}

// Parses a single HTTP Range header against a known size (full Number
// precision, safe past 4 GiB). Returns null when absent, { start, end }
// (inclusive) for one satisfiable range, or { error } where both 'invalid'
// (malformed or multi-range: this API rejects guessing which bytes were meant)
// and 'unsatisfiable' (well-formed but out of range) mean the caller serves
// 416. Only a missing Range header serves 200 full.
export function parseHttpRange(header, size) {
  if (header === undefined || header === null) return null;
  if (!Number.isSafeInteger(size) || size < 0) return { error: 'invalid' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return { error: 'invalid' };
  const [, first, last] = match;
  if (first === '' && last === '') return { error: 'invalid' };
  if (first === '') {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { error: 'invalid' };
    if (size === 0) return { error: 'unsatisfiable' };
    if (suffix >= size) return { start: 0, end: size - 1 };
    return { start: size - suffix, end: size - 1 };
  }
  const start = Number(first);
  if (!Number.isSafeInteger(start) || start < 0) return { error: 'invalid' };
  if (start >= size) return { error: 'unsatisfiable' };
  if (last === '') return { start, end: size - 1 };
  const end = Number(last);
  if (!Number.isSafeInteger(end) || end < 0) return { error: 'invalid' };
  if (end < start) return { error: 'invalid' };
  return { start, end: Math.min(end, size - 1) };
}

function etagListMatches(header, etag) {
  for (const part of String(header).split(',')) {
    const token = part.trim();
    if (token === '*') return true;
    const bare = token.startsWith('W/') ? token.slice(2) : token;
    if (bare === etag) return true;
  }
  return false;
}

function httpDateSeconds(value) {
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : Math.floor(millis / 1000);
}

// Streams an open file handle to a response with backpressure. Owns handle
// closure: closes it on finish, source error and res 'close'. Rejects with
// { code: 'client_aborted' } when the connection closes first (the parent
// destroys `res` on token revoke/disable).
export async function streamFileToResponse(res, handle, { start, end }) {
  if (res.destroyed || res.writableEnded) {
    await handle.close().catch(() => {});
    throw Object.assign(new Error('Download interrupted: connection closed.'), { code: 'client_aborted' });
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const src = handle.createReadStream({ start, end });
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      res.removeListener('close', onClose);
      res.removeListener('finish', onFinish);
      src.removeListener('error', onSourceError);
      fn(value);
    };
    const onClose = () => {
      settle(
        rejectPromise,
        Object.assign(new Error('Download interrupted: connection closed.'), { code: 'client_aborted' }),
      );
      src.destroy();
      handle.close().catch(() => {});
    };
    const onFinish = () => {
      settle(resolvePromise, { bytesSent: end - start + 1 });
      handle.close().catch(() => {});
    };
    const onSourceError = (error) => {
      settle(rejectPromise, error);
      src.destroy();
      handle.close().catch(() => {});
      try {
        res.destroy(error);
      } catch {}
    };
    res.on('close', onClose);
    res.on('finish', onFinish);
    src.on('error', onSourceError);
    src.pipe(res);
  });
}

function checkSegments(absolute) {
  const parts = absolute.split('/');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part === '.' || part === '..') continue;
    if (i === 0 && /^[a-z]:$/i.test(part)) continue;
    if (/[. ]$/.test(part)) return 'unsafe trailing dot or space';
    if (/[*?"<>|:\x00-\x1f\x7f]/.test(part)) return 'unsafe characters';
    if (RESERVED_NAME.test(part)) return 'reserved device name';
    if (part.length > 255) return 'segment too long';
  }
  return null;
}

function fallbackName(reference) {
  const stripped = String(reference || '')
    .replace(/(?:#L?\d+(?:[-:]L?\d+)?|:\d+(?::\d+)?)$/, '')
    .replaceAll('\\', '/');
  return sanitizeDownloadName(stripped.split('/').pop() || 'file');
}

export function createPublicApiFiles({
  machineId,
  protectedRoots = [],
  attachmentDir = null,
  dataDir = null,
  getLocalOrigin = null,
} = {}) {
  if (typeof machineId !== 'string' || !machineId)
    throw new TypeError('createPublicApiFiles requires a non-empty machineId string.');
  const roots = [...protectedRoots].map((root) => {
    if (typeof root !== 'string' || !root || !isAbsolute(root))
      throw new TypeError('protectedRoots entries must be absolute path strings.');
    return root;
  });
  if (attachmentDir !== null && attachmentDir !== undefined) {
    if (typeof attachmentDir !== 'string' || !attachmentDir || !isAbsolute(attachmentDir))
      throw new TypeError('attachmentDir must be an absolute path string when provided.');
  }
  if (dataDir !== null && dataDir !== undefined) {
    if (typeof dataDir !== 'string' || !dataDir || !isAbsolute(dataDir))
      throw new TypeError('dataDir must be an absolute path string when provided.');
  }
  const attachments = attachmentDir || null;
  const receiptsDir = dataDir ? join(dataDir, RECEIPT_SUBDIR) : null;
  const hook = typeof getLocalOrigin === 'function' ? getLocalOrigin : null;

  const keyOf = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
  const within = (root, path) => {
    const candidate = keyOf(path);
    const base = keyOf(root);
    return candidate === base || candidate.startsWith(base + sep);
  };
  const isProtected = async (actual, source) => {
    for (const root of roots) {
      if (within(root, source) || within(root, actual)) return true;
      const canonical = await realpath(root).catch(() => root);
      if (within(canonical, actual)) return true;
    }
    return false;
  };

  const receipts = new Map();
  const inFlight = new Set();
  let writeQueue = Promise.resolve();
  let closed = false;
  const receiptPath = (sessionId) => join(receiptsDir, `${sessionId}.json`);

  async function loadReceipts(sessionId) {
    if (receipts.has(sessionId)) return receipts.get(sessionId);
    const known = new Set();
    receipts.set(sessionId, known);
    if (!receiptsDir || !SESSION_ID.test(sessionId)) return known;
    try {
      const info = await stat(receiptPath(sessionId)).catch(() => null);
      if (!info || !info.isFile() || info.size > MAX_RECEIPT_BYTES) return known;
      const parsed = JSON.parse(await readFile(receiptPath(sessionId), 'utf8'));
      const list = parsed && typeof parsed === 'object' && Array.isArray(parsed.refs) ? parsed.refs : [];
      for (const id of list.slice(0, MAX_RECEIPT_REFS)) {
        if (typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)) known.add(id);
      }
    } catch {
      // Corrupt or unreadable receipts fail closed as unknown provenance.
    }
    return known;
  }

  async function writeReceiptFile(sessionId) {
    const known = receipts.get(sessionId) ?? new Set();
    const body = JSON.stringify({
      version: 1,
      machineId,
      sessionId,
      updatedAt: new Date().toISOString(),
      refs: [...known].slice(0, MAX_RECEIPT_REFS),
    });
    await mkdir(receiptsDir, { recursive: true });
    const tmp = join(receiptsDir, `${sessionId}.${process.pid}.tmp`);
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, receiptPath(sessionId));
  }

  function queuePersist(sessionId) {
    if (!receiptsDir) return Promise.resolve(false);
    const task = writeQueue.then(() => writeReceiptFile(sessionId));
    writeQueue = task.catch(() => {});
    return task.then(() => true);
  }

  function normalizeReference(reference, cwd) {
    if (typeof reference !== 'string') fail(400, 'invalid_reference', 'Invalid file reference.');
    let input = reference.trim();
    if (!input || input.length > MAX_REFERENCE_CHARS || /[\x00-\x1f\x7f]/.test(input))
      fail(400, 'invalid_reference', 'Invalid file reference.');
    if (/^file:/i.test(input)) {
      let url = null;
      try {
        url = new URL(input);
      } catch {
        url = null;
      }
      if (!url) fail(400, 'invalid_reference', 'Invalid file reference.');
      if (url.hostname && url.hostname !== 'localhost')
        fail(400, 'remote_url', 'Remote file URLs are never served.');
      try {
        input = fileURLToPath(url);
      } catch {
        fail(400, 'invalid_reference', 'Invalid file reference.');
      }
    } else {
      try {
        input = decodeURIComponent(input);
      } catch {
        fail(400, 'invalid_reference', 'Invalid file reference.');
      }
    }
    input = input.replace(/(?:#L?\d+(?:[-:]L?\d+)?|:\d+(?::\d+)?)$/, '').replaceAll('\\', '/');
    if (!input) fail(400, 'invalid_reference', 'Invalid file reference.');
    if (/^[a-z][\w+.-]*:/i.test(input) && !DRIVE_ABSOLUTE.test(input))
      fail(400, 'remote_url', 'Remote URLs are never served.');
    if (input.startsWith('//')) fail(400, 'network_path', 'Network paths are never served.');
    if (/^\/[a-z]:\//i.test(input)) input = input.slice(1);
    const lower = input.toLowerCase();
    if (lower === '/dev/null' || lower.startsWith('/dev/'))
      fail(400, 'device_path', 'Device paths are never served.');
    let absolute;
    if (DRIVE_ABSOLUTE.test(input)) absolute = input.replace(/\/{2,}/g, '/');
    else if (input.startsWith('/')) absolute = resolve(input);
    else absolute = resolve(cwd, input);
    if (absolute.length > MAX_RESOLVED_CHARS) fail(400, 'invalid_reference', 'Invalid file reference.');
    const problem = checkSegments(absolute.replaceAll('\\', '/'));
    if (problem) fail(400, 'unsafe_path', `Unsafe file reference (${problem}).`);
    return absolute;
  }

  // Resolves one link hop chain to a local-namespace target inside the given
  // container (UUID attachment bytes) or anywhere local (explicit links),
  // honoring protected roots for links. String equality of realpaths is NOT
  // trusted: callers compare device + inode identity around the open.
  async function resolveActual(absolute, { containerDir = null, checkProtected = false } = {}) {
    const actual = await realpath(absolute).catch(() =>
      fail(404, 'file_missing', 'Linked file is not available on this machine.'),
    );
    assertLocalNamespace(actual);
    const shapeProblem = checkSegments(String(actual).replaceAll('\\', '/'));
    if (shapeProblem) fail(400, 'unsafe_path', `Unsafe file target (${shapeProblem}).`);
    if (containerDir) {
      const container = await realpath(containerDir).catch(() => null);
      if (!container || !within(container, actual))
        fail(404, 'container_escape', 'Linked file is not available on this machine.');
    }
    if (checkProtected && (await isProtected(actual, absolute)))
      fail(403, 'path_protected', 'Linked file is in a protected location.');
    return actual;
  }

  // Opens a verified regular file: namespace + container + protected checks on
  // the resolved target, regular-file stat before open, device/inode identity
  // between pre-open stat and the open handle, then re-resolution with the
  // same checks plus identity between the handle and the current target. A
  // junction/symlink swap-then-restore around the open changes one of the
  // identities and fails closed with file_changed.
  async function openVerifiedFile(absolute, { containerDir = null, checkProtected = false } = {}) {
    const actual = await resolveActual(absolute, { containerDir, checkProtected });
    const pre = await stat(actual, { bigint: true }).catch(() =>
      fail(404, 'file_missing', 'Linked file is not available on this machine.'),
    );
    if (!pre.isFile()) fail(400, 'not_a_file', 'Linked reference is not a regular file.');
    let handle;
    try {
      handle = await open(actual, OPEN_FLAGS);
    } catch (error) {
      if (error && error.code === 'ELOOP')
        fail(409, 'file_changed', 'Linked file changed while opening; retry the listing.');
      fail(404, 'file_missing', 'Linked file is not available on this machine.');
    }
    try {
      const post = await handle.stat({ bigint: true });
      if (!post.isFile()) fail(400, 'not_a_file', 'Linked reference is not a regular file.');
      if (post.dev !== pre.dev || post.ino !== pre.ino)
        fail(409, 'file_changed', 'Linked file changed while opening; retry the listing.');
      const fresh = await resolveActual(absolute, { containerDir, checkProtected });
      const current = await stat(fresh, { bigint: true }).catch(() =>
        fail(409, 'file_changed', 'Linked file changed while opening; retry the listing.'),
      );
      if (current.dev !== post.dev || current.ino !== post.ino)
        fail(409, 'file_changed', 'Linked file changed while opening; retry the listing.');
      return {
        actual: fresh,
        handle,
        size: Number(post.size),
        mtime: post.mtime,
        mtimeMs: Number(post.mtimeMs),
        ctimeMs: Number(post.ctimeMs),
        mtimeNs: post.mtimeNs,
        ctimeNs: post.ctimeNs,
        dev: post.dev,
        ino: post.ino,
        name: basename(fresh),
      };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  // Bounded read of a small contained file (attachment metadata) through the
  // same verified open, so a blob symlink escape cannot smuggle content in.
  async function readContainedFile(absolute, { containerDir, maxBytes }) {
    const opened = await openVerifiedFile(absolute, { containerDir });
    try {
      if (opened.size > maxBytes) fail(400, 'not_a_file', 'Linked reference is not a regular file.');
      const data = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await opened.handle.read(data, offset, data.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== data.length)
        fail(409, 'file_changed', 'Linked file changed while opening; retry the listing.');
      return data.toString('utf8');
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }

  async function probeLink(reference, cwd) {
    const absolute = normalizeReference(reference, cwd);
    const actual = await resolveActual(absolute, { checkProtected: true });
    const info = await stat(actual).catch(() =>
      fail(404, 'file_missing', 'Linked file is not available on this machine.'),
    );
    if (!info.isFile()) fail(400, 'not_a_file', 'Linked reference is not a regular file.');
    return { actual, size: info.size, name: basename(actual) };
  }

  async function openLink(reference, cwd) {
    return openVerifiedFile(normalizeReference(reference, cwd), { checkProtected: true });
  }

  async function readAttachmentMeta(attachId) {
    if (!ATTACHMENT_ID.test(attachId)) fail(404, 'unknown_file', 'Unknown file for this conversation.');
    if (!attachments) fail(404, 'file_missing', 'Attachments are not available on this machine.');
    let record = null;
    try {
      const raw = await readContainedFile(join(attachments, `${attachId}.meta.json`), {
        containerDir: attachments,
        maxBytes: MAX_META_BYTES,
      });
      record = JSON.parse(raw);
    } catch (error) {
      if (error && (error.status === 400 || error.status === 409)) throw error;
      record = null;
    }
    if (!record || typeof record !== 'object' || !ATTACHMENT_SUFFIX.test(record.suffix))
      fail(404, 'file_missing', 'Attachment is not available on this machine.');
    return {
      suffix: record.suffix,
      name: typeof record.name === 'string' && record.name ? record.name : 'file',
    };
  }

  async function probeAttachment(attachId) {
    const meta = await readAttachmentMeta(attachId);
    const opened = await openVerifiedFile(join(attachments, attachId + meta.suffix), {
      containerDir: attachments,
    });
    await opened.handle.close().catch(() => {});
    return { size: opened.size, name: meta.name };
  }

  async function openAttachment(attachId) {
    const meta = await readAttachmentMeta(attachId);
    const opened = await openVerifiedFile(join(attachments, attachId + meta.suffix), {
      containerDir: attachments,
    });
    return { ...opened, name: meta.name };
  }

  async function isProven({ sessionId, cwd, kind, key, fileId }) {
    const known = await loadReceipts(sessionId);
    if (known.has(fileId)) return true;
    if (hook) {
      try {
        const owner = await hook({ sessionId, cwd, kind, reference: kind === 'link' ? key : null });
        if (typeof owner === 'string' && owner && owner === machineId) return true;
      } catch {
        // A failing hook fails closed.
      }
    }
    return false;
  }

  function assertListingInput(sessionId, cwd, messages) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256)
      fail(400, 'invalid_session', 'A session identifier is required.');
    if (typeof cwd !== 'string' || !cwd || !isAbsolute(cwd))
      fail(400, 'invalid_cwd', 'An absolute working directory is required.');
    if (!Array.isArray(messages)) fail(500, 'invalid_messages', 'Conversation messages are required.');
  }

  async function list({ sessionId, cwd, messages } = {}) {
    assertListingInput(sessionId, cwd, messages);
    await writeQueue.catch(() => {});
    const out = [];
    for (const reference of extractLinkedReferences(messages)) {
      const id = buildFileId(machineId, sessionId, 'link', reference);
      const entry = {
        id,
        kind: 'link',
        name: fallbackName(reference),
        size: null,
        available: false,
        machineId,
        originMachineId: null,
      };
      if (await isProven({ sessionId, cwd, kind: 'link', key: reference, fileId: id })) {
        entry.originMachineId = machineId;
        try {
          const probe = await probeLink(reference, cwd);
          entry.available = true;
          entry.size = probe.size;
          entry.name = sanitizeDownloadName(probe.name);
        } catch {
          // Provenance known but bytes currently unservable: stay unavailable.
        }
      }
      out.push(entry);
    }
    for (const attachment of extractAttachmentRefs(messages)) {
      const id = buildFileId(machineId, sessionId, 'attachment', attachment.attachId);
      const entry = {
        id,
        kind: 'attachment',
        name: sanitizeDownloadName(attachment.name || 'file'),
        size: null,
        available: false,
        machineId,
        originMachineId: null,
      };
      if (attachments) {
        try {
          const probe = await probeAttachment(attachment.attachId);
          entry.available = true;
          entry.size = probe.size;
          entry.name = sanitizeDownloadName(probe.name);
          entry.originMachineId = machineId;
        } catch {
          // Metadata without local bytes stays unavailable.
        }
      }
      out.push(entry);
    }
    return out;
  }

  async function download(req, res, { sessionId, cwd, messages, fileId } = {}) {
    const method = String(req?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD')
      fail(405, 'method_not_allowed', 'Only GET and HEAD are supported.');
    assertListingInput(sessionId, cwd, messages);
    if (typeof fileId !== 'string' || !fileId) fail(400, 'invalid_file_id', 'A file identifier is required.');
    await writeQueue.catch(() => {});
    const rawHeaders = (req && typeof req.headers === 'object' && req.headers) || {};
    const headers = {};
    for (const [name, value] of Object.entries(rawHeaders)) headers[String(name).toLowerCase()] = value;
    let entry = null;
    for (const reference of extractLinkedReferences(messages)) {
      if (buildFileId(machineId, sessionId, 'link', reference) === fileId) {
        entry = { kind: 'link', reference };
        break;
      }
    }
    if (!entry) {
      for (const attachment of extractAttachmentRefs(messages)) {
        if (buildFileId(machineId, sessionId, 'attachment', attachment.attachId) === fileId) {
          entry = { kind: 'attachment', attachId: attachment.attachId };
          break;
        }
      }
    }
    if (!entry) fail(404, 'unknown_file', 'Unknown file for this conversation.');
    let target;
    if (entry.kind === 'attachment') {
      target = await openAttachment(entry.attachId);
    } else {
      if (!(await isProven({ sessionId, cwd, kind: 'link', key: entry.reference, fileId })))
        fail(409, 'origin_unknown', 'No local provenance for this reference on this machine.');
      target = await openLink(entry.reference, cwd);
    }
    if (res.destroyed || res.writableEnded) {
      await target.handle.close().catch(() => {});
      fail(409, 'client_aborted', 'Download interrupted: connection closed.');
    }
    const name = sanitizeDownloadName(target.name);
    const etag = buildEtag(target);
    const preconditionFailed = (code) => {
      target.handle.close().catch(() => {});
      res.writeHead(412, {
        ETag: etag,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end();
      return { id: fileId, name, status: 412, bytesSent: 0, totalSize: target.size, etag, code };
    };
    // RFC 9110 section 13.2.2 precedence: If-Match first, then
    // If-Unmodified-Since (only without If-Match), then If-None-Match, then
    // If-Modified-Since (only without If-None-Match). A failed precondition
    // answers 412 before any Range handling or bytes.
    if (headers['if-match'] !== undefined) {
      const raw = Array.isArray(headers['if-match']) ? headers['if-match'][0] : headers['if-match'];
      const tokens = String(raw)
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean);
      // Strong comparison: only an exact match with this strong validator
      // passes; '*' passes for any current representation (the open file).
      const matched = tokens.some((token) => token === '*' || token === etag);
      if (!matched) return preconditionFailed('if_match');
    } else if (headers['if-unmodified-since'] !== undefined) {
      const since = httpDateSeconds(headers['if-unmodified-since']);
      if (since !== null && Math.floor(target.mtimeMs / 1000) > since)
        return preconditionFailed('if_unmodified_since');
    }
    const baseHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(name),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ETag: etag,
      'Last-Modified': target.mtime.toUTCString(),
    };
    const settleNoBody = (status, extra = {}) => {
      target.handle.close().catch(() => {});
      res.writeHead(status, { ...baseHeaders, ...extra });
      res.end();
      return { id: fileId, name, status, bytesSent: 0, totalSize: target.size, etag };
    };
    if (headers['if-none-match'] !== undefined && etagListMatches(headers['if-none-match'], etag)) {
      target.handle.close().catch(() => {});
      res.writeHead(304, {
        ETag: etag,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end();
      return { id: fileId, name, status: 304, bytesSent: 0, totalSize: target.size, etag };
    }
    if (headers['if-none-match'] === undefined && headers['if-modified-since'] !== undefined) {
      const since = httpDateSeconds(headers['if-modified-since']);
      if (since !== null && Math.floor(target.mtimeMs / 1000) <= since) {
        target.handle.close().catch(() => {});
        res.writeHead(304, {
          ETag: etag,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end();
        return { id: fileId, name, status: 304, bytesSent: 0, totalSize: target.size, etag };
      }
    }
    let start = 0;
    let end = target.size - 1;
    let status = 200;
    if (method === 'GET' && headers.range !== undefined) {
      let honor = true;
      if (headers['if-range'] !== undefined) {
        const validator = String(headers['if-range']).trim();
        const date = httpDateSeconds(validator);
        honor = validator === etag || (date !== null && Math.floor(target.mtimeMs / 1000) <= date);
      }
      // If-Range is evaluated before Range, including when the file shrank.
      if (honor) {
        const rangeValue = Array.isArray(headers.range) ? headers.range[0] : headers.range;
        const parsed = parseHttpRange(rangeValue, target.size);
        if (parsed?.error) return settleNoBody(416, { 'Content-Range': `bytes */${target.size}` });
        if (parsed) {
          start = parsed.start;
          end = parsed.end;
          status = 206;
        }
      }
    }
    const bodyLength = status === 206 ? end - start + 1 : target.size;
    if (method === 'HEAD' || target.size === 0) {
      target.handle.close().catch(() => {});
      res.writeHead(status, { ...baseHeaders, 'Content-Length': String(bodyLength) });
      res.end();
      return { id: fileId, name, status, bytesSent: 0, totalSize: target.size, etag };
    }
    const responseHeaders = { ...baseHeaders, 'Content-Length': String(bodyLength) };
    if (status === 206) responseHeaders['Content-Range'] = `bytes ${start}-${end}/${target.size}`;
    res.writeHead(status, responseHeaders);
    await streamFileToResponse(res, target.handle, { start, end });
    return { id: fileId, name, status, bytesSent: bodyLength, totalSize: target.size, etag };
  }

  function asMessageList(input) {
    if (Array.isArray(input)) return input.slice(0, MAX_RECORD_MESSAGES);
    if (input && typeof input === 'object') return [input];
    return [];
  }

  async function recordLocal({ sessionId, cwd, messages, message } = {}) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId))
      fail(400, 'invalid_session', 'A session identifier is required.');
    if (typeof cwd !== 'string' || !cwd || !isAbsolute(cwd))
      fail(400, 'invalid_cwd', 'An absolute working directory is required.');
    const refs = extractLinkedReferences(
      message !== undefined ? asMessageList(message) : asMessageList(messages),
    );
    if (!refs.length) return { recorded: 0, sessionId };
    // Persistence is decided at call time: records already in flight when
    // close() runs still flush; records started after close stay memory-only.
    const persist = !closed && !!receiptsDir;
    const task = (async () => {
      const known = await loadReceipts(sessionId);
      let added = 0;
      for (const reference of refs) {
        const id = buildFileId(machineId, sessionId, 'link', reference);
        if (known.has(id)) continue;
        try {
          await probeLink(reference, cwd);
        } catch {
          continue;
        }
        if (known.size >= MAX_RECEIPT_REFS) break;
        known.add(id);
        added++;
      }
      if (added > 0 && persist) await queuePersist(sessionId);
      return { recorded: added, sessionId };
    })();
    inFlight.add(task);
    try {
      return await task;
    } finally {
      inFlight.delete(task);
    }
  }

  async function close() {
    closed = true;
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    await writeQueue.catch(() => {});
    return { closed: true };
  }

  return { machineId, list, download, recordLocal, close };
}
