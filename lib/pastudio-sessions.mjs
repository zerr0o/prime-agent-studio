/**
 * Portable native session module (.pastudio v1).
 *
 * Purpose: export and import full native Prime Agent conversation histories
 * (roots + RLM children) plus the full project Roadmap, without project
 * files, provider credentials, model preferences, harness secrets, or kernel
 * state.
 *
 * Container layout (flat, no artifact paths inside the archive):
 *   manifest.json
 *   sessions/<oldSessionId>.jsonl   (roots AND children, flat, verbatim)
 *   roadmap.json                    (full project document, verbatim)
 * Topology (parent/child/depth/name) lives ONLY in manifest.json.
 *
 * Coordinator contract (backend worker owns I/O commit + UI gates):
 *   1. Export: collectExport() reads roots + ledger-discovered children and
 *      strict-parses every file. Any malformed line fails the export with a
 *      clear line number. A torn tail (file not ending in "\n") fails with
 *      code "torn_tail" unless { snapshotTornTail: true } is passed, in which
 *      case only complete newline-terminated records are snapshotted and the
 *      manifest marks the blob truncated:true.
 *   2. Stage: planImport() is pure (no I/O). stageImportFiles() writes ONLY
 *      into an isolated staging dir given by the coordinator. This module
 *      never writes into the live sessionDir / session-artifacts.
 *   3. Commit (coordinator): atomically rename staged roots into
 *      <sessionDir>/<newId>.jsonl then children into
 *      <artifacts>/<newRootId>/sub-<newChildId>/<newChildIdSession>.jsonl,
 *      with a recoverable import journal.
 *   3b. Preflight (coordinator, REQUIRED when children exist): call
 *      preflightImportLedger() BEFORE commit. A missing native package with
 *      children present fails the whole import clear (or queues it recoverable
 *      WITHOUT claiming success). Inspector-hidden partial success is not an
 *      acceptable outcome.
 *   4. Register (this module): registerImportedEdges() appends one native
 *      ledger spawn record per child via the exact RlmSpawnLedger.appendSpawn
 *      API (concurrency-safe O_APPEND, no idle requirement). On partial
 *      failure it rolls back the succeeded appends via appendDelete and
 *      rethrows, so the coordinator can also remove committed files or retry
 *      from the journal. Do NOT fabricate legacy sidecars.
 *   5. Resume gate (coordinator, owned by parent): getResumeContract()
 *      declares requiresModelSelection:false (explicit pick only when no
 *      usable model is configured). History keeps model_change records as
 *      evidence; the coordinator auto-assigns the destination effective model
 *      (source historical when configured+available, else destination default
 *      when configured+usable). This module never injects a default model.
 *
 * git_state policy: historical git_state entries are ALWAYS preserved as
 * evidence (the dropGitState experiment was removed: dropping would require
 * relinking parentId/firstKeptEntryId/fromId/targetId chains, and the
 * canonical behaviour keeps everything; passing dropGitState:true fails with
 * code "unsupported"). Stale repo context self-heals on the next run via
 * recordGitStateIfChanged. What IS stripped on import is the stale runtime
 * header: header.git is dropped (or replaced by an explicitly provided fresh
 * value) and header.cwd / header.parentSession / header.rlmDepth are rebuilt
 * for the destination.
 *
 * Remap policy (no blind replacements): only structured header fields
 * (id/cwd/parentSession/rlmDepth) and typed native agent_message identities
 * (details.from.sessionId / details.target.sessionId, including the
 * message.role=custom variant) whose values are in the import idMap are
 * rewritten. Envelope text, tool arguments, tool results, code, and
 * activeSessionId/agentmsg ids are NEVER touched.
 */

import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { validId } from './store.mjs';

export const PASTUDIO_FORMAT = 'pastudio/1';
export const PASTUDIO_SESSION_VERSION = 3;
export const PASTUDIO_MAX_ROADMAP_BYTES = 4 * 1024 * 1024;
export const PASTUDIO_MAX_SESSION_BYTES = 128 * 1024 * 1024;
export const PASTUDIO_CHILD_ID_RE = /^sub-[A-Za-z0-9]{8}$/;
export const PASTUDIO_NEW_CHILD_ID_RE = /^sub-[0-9a-f]{8}$/;

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export class PastudioError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'PastudioError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const fail = (code, message, extra) => {
  throw new PastudioError(code, message, extra);
};

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

export function assertValidSessionId(id, label = 'session id') {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id) || !validId(id))
    fail('invalid_session_id', `Invalid ${label}: must match ${SESSION_ID_RE}.`, { value: String(id).slice(0, 80) });
  return id;
}

export function assertValidChildId(id, label = 'child id') {
  if (typeof id !== 'string' || !PASTUDIO_CHILD_ID_RE.test(id))
    fail('invalid_child_id', `Invalid ${label}: expected sub-XXXXXXXX.`, { value: String(id).slice(0, 80) });
  return id;
}

export function assertAbsolutePath(path, label = 'path') {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 32768)
    fail('invalid_path', `Invalid ${label}: absolute path required.`, { value: String(path).slice(0, 120) });
  return path;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Shared fresh-id generators (single source of truth for planImport and
 * planSessionRemap so the two planners cannot diverge). Session ids are
 * randomUUID v4 (validId; the Studio has no uuid dependency for v7).
 * Child ids follow the native shape sub-XXXXXXXX from randomUUID hex.
 */
export function freshSessionId(exclude = []) {
  const taken = exclude instanceof Set ? exclude : new Set(exclude);
  for (let attempt = 0; attempt < 100; attempt++) {
    const fresh = randomUUID();
    assertValidSessionId(fresh, 'generated session id');
    if (!taken.has(fresh)) return fresh;
  }
  fail('id_collision', 'Failed to generate a collision-free session id after 100 attempts.');
}

export function freshChildId() {
  const fresh = `sub-${randomUUID().slice(0, 8)}`;
  if (!PASTUDIO_NEW_CHILD_ID_RE.test(fresh)) fail('invalid_child_id', 'Generated child id failed validation.', { value: fresh });
  return fresh;
}

/**
 * Shared verbatim-bytes parser (single strict path for validateSessionBytes,
 * collectProjectSessions and any future byte-level caller). Maps the core
 * torn_tail code to pastudio_invalid so byte-level callers share one error
 * contract; the text-level core keeps the granular torn_tail code.
 */
function parseVerbatimBytes(data, label) {
  const text = bufferToText(data, label);
  try {
    return parseSessionText(text, { sourceLabel: label });
  } catch (error) {
    if (error instanceof PastudioError && error.code !== 'pastudio_invalid')
      throw new PastudioError('pastudio_invalid', error.message, { code2: error.code });
    throw error;
  }
}

function claimCanonicalId(seen, header, file) {
  // Native fork tolerance (export, read-only): the canonical session id is
  // header.id; the filename is only the physical path. Native
  // SessionManager.snapshotSessionInfo returns { id: header.id, path: filePath },
  // store.scan returns { id: header.id, file }, and the RLM ledger keeps
  // topology exclusively path-based (parent/child are canonical physical
  // paths; header-claimed parentSession/rlmDepth from forks are stripped, see
  // sessionRow/withPassiveRlmDescendantInfos "a fork can leave the transcript
  // header pointing at a dead ancestor path"). A header/filename mismatch is
  // therefore a legitimate fork/copy: trust the header and keep the physical
  // path separate for ledger child linkage. Only two different physical files
  // claiming the same canonical id are truly ambiguous.
  const prev = seen.get(header.id);
  if (prev && canonFile(prev) !== canonFile(file))
    fail('duplicate_session', `Duplicate canonical session id ${header.id} in ${file} and ${prev}; refusing an ambiguous native fork.`, { sessionId: header.id, file });
  seen.set(header.id, file);
  return header.id;
}
/**
 * Shared native ledger opener (single dynamic-import path for discoverFamily,
 * preflightImportLedger, registerImportedEdges and rollbackRegisteredEdges).
 * Performs no writes; construction alone never mutates the ledger file.
 */
async function openNativeLedger(agentHome, sessionDir) {
  if (!agentHome || typeof agentHome !== 'string' || !isAbsolute(agentHome))
    fail('invalid_path', 'A native ledger operation requires an absolute agentHome.');
  if (!sessionDir || typeof sessionDir !== 'string' || !isAbsolute(sessionDir))
    fail('invalid_path', 'A native ledger operation requires an absolute sessionDir.');
  const { discoverCli } = await import('./agent.mjs');
  const cli = discoverCli();
  if (!cli?.packageDir) fail('ledger_unavailable', 'Native CLI package not found; cannot open the RLM ledger.');
  const { pathToFileURL } = await import('node:url');
  const { RlmSpawnLedger } = await import(pathToFileURL(join(cli.packageDir, 'dist/modes/daemon/rlm-ledger.js')).href);
  return new RlmSpawnLedger(agentHome, sessionDir);
}

/**
 * Strict JSONL parser. Never silently skips malformed lines.
 * Torn tail: a non-empty file not ending in "\n" ends with a potentially
 * torn active record. Default: fail with code "torn_tail". With
 * { snapshotTornTail: true }: snapshot only complete newline-terminated
 * records and report { tornTail: true, truncated: true }.
 */
export function parseSessionText(text, { sourceLabel = '<session>', snapshotTornTail = false } = {}) {
  if (typeof text !== 'string' || !text)
    fail('empty_session', `Empty session text (${sourceLabel}).`, { sourceLabel });
  const tornTail = text.length > 0 && !text.endsWith('\n');
  const payload = tornTail ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
  if (tornTail && !snapshotTornTail)
    fail('torn_tail', `Torn tail in ${sourceLabel}: file does not end with newline; refusing to guess the active record. Re-run with snapshotTornTail:true to snapshot complete records only.`, {
      sourceLabel,
      completeBytes: payload.length,
      totalBytes: text.length,
    });
  if (!payload.trim())
    fail('empty_session', `No complete records in ${sourceLabel} (torn tail only).`, { sourceLabel });
  const rawLines = payload.split('\n');
  // Split leaves a trailing '' after the final newline; drop exactly that one.
  const lines = rawLines.length && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
  const headerLine = lines[0];
  let header;
  try {
    header = JSON.parse(headerLine);
  } catch (error) {
    fail('malformed_jsonl', `Malformed JSON on line 1 of ${sourceLabel}: ${error.message}.`, { sourceLabel, line: 1 });
  }
  if (!isRecord(header) || header.type !== 'session')
    fail('missing_header', `Missing session header on line 1 of ${sourceLabel}.`, { sourceLabel });
  if (typeof header.id !== 'string' || !SESSION_ID_RE.test(header.id) || !validId(header.id))
    fail('invalid_header_id', `Invalid session header id on line 1 of ${sourceLabel}.`, { sourceLabel });
  if (typeof header.cwd !== 'string' || !isAbsolute(header.cwd))
    fail('invalid_header_cwd', `Invalid session header cwd on line 1 of ${sourceLabel}: absolute path required.`, { sourceLabel });
  const entries = [];
  const seen = new Set();
  for (let index = 1; index < lines.length; index++) {
    const raw = lines[index];
    if (!raw.trim())
      fail('malformed_jsonl', `Blank line ${index + 1} of ${sourceLabel}: refusing to silently skip.`, { sourceLabel, line: index + 1 });
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch (error) {
      fail('malformed_jsonl', `Malformed JSON on line ${index + 1} of ${sourceLabel}: ${error.message}.`, { sourceLabel, line: index + 1 });
    }
    if (!isRecord(entry) || typeof entry.type !== 'string' || !entry.type)
      fail('malformed_entry', `Entry on line ${index + 1} of ${sourceLabel} has no type.`, { sourceLabel, line: index + 1 });
    if (typeof entry.id !== 'string' || !ENTRY_ID_RE.test(entry.id))
      fail('malformed_entry', `Entry on line ${index + 1} of ${sourceLabel} has an invalid id.`, { sourceLabel, line: index + 1, type: entry.type });
    if (seen.has(entry.id))
      fail('duplicate_entry_id', `Duplicate entry id "${entry.id}" on line ${index + 1} of ${sourceLabel}.`, { sourceLabel, line: index + 1 });
    seen.add(entry.id);
    if (!Object.hasOwn(entry, 'parentId') || (entry.parentId !== null && typeof entry.parentId !== 'string'))
      fail('malformed_entry', `Entry "${entry.id}" on line ${index + 1} of ${sourceLabel} has an invalid parentId.`, { sourceLabel, line: index + 1 });
    if (typeof entry.timestamp !== 'string' || !entry.timestamp)
      fail('malformed_entry', `Entry "${entry.id}" on line ${index + 1} of ${sourceLabel} has no timestamp.`, { sourceLabel, line: index + 1 });
    entries.push({ entry, line: raw, lineNumber: index + 1 });
  }
  // Branch-chain integrity: every non-null parentId must reference a known id
  // in the same file (header id is NOT a valid parentId target; chains start
  // at null). This preserves resumability of the selected branch.
  const entryIds = new Set(seen);
  for (const { entry } of entries) {
    if (entry.parentId !== null && !entryIds.has(entry.parentId) && entry.parentId !== undefined)
      fail('broken_chain', `Entry "${entry.id}" references unknown parentId "${entry.parentId}" in ${sourceLabel}; refusing to import a broken branch chain.`, {
        sourceLabel,
        entryId: entry.id,
        parentId: entry.parentId,
      });
  }
  return {
    header,
    headerLine,
    entries,
    lineCount: lines.length,
    tornTail,
    truncated: tornTail && snapshotTornTail,
  };
}

export async function readAndValidateSessionFile(file, options = {}) {
  assertAbsolutePath(resolve(file), 'session file');
  const stat = await lstat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink())
    fail('unreadable_session', `Session file is not a regular file: ${file}.`, { file });
  if (stat.size > PASTUDIO_MAX_SESSION_BYTES)
    fail('session_too_large', `Session file exceeds ${PASTUDIO_MAX_SESSION_BYTES} bytes: ${file}.`, { file });
  const text = await readFile(file, 'utf8').catch(() => {
    fail('unreadable_session', `Cannot read session file: ${file}.`, { file });
  });
  return { file, text, ...parseSessionText(text, { sourceLabel: file, snapshotTornTail: options.snapshotTornTail === true }) };
}

function headerName(parsed) {
  const info = parsed.entries.map((item) => item.entry).find((e) => e.type === 'session_info' && typeof e.name === 'string' && e.name);
  return info?.name || null;
}

/**
 * Discover the live family for root ids via the native ledger reader.
 * Accepts an injected readEdges() (preferred, matches session-inspector) or
 * lazily loads RlmSpawnLedger the same way the Studio does. Never fabricates
 * sidecars. Returns live non-deleted edges only.
 */
export async function discoverFamily({ agentHome, sessionDir, readEdges, log = () => {} } = {}) {
  if (!sessionDir || typeof sessionDir !== 'string' || !isAbsolute(sessionDir))
    fail('invalid_path', 'discoverFamily requires an absolute sessionDir.');
  let edges;
  if (readEdges) {
    edges = await readEdges();
  } else {
    const ledger = await openNativeLedger(agentHome, sessionDir);
    edges = await ledger.liveEdges();
  }
  if (!Array.isArray(edges)) fail('ledger_unavailable', 'Ledger reader did not return an edge list.');
  return edges.filter((e) => e && !e.deleted && typeof e.childId === 'string' && typeof e.parent === 'string' && typeof e.child === 'string');
}

function canonFile(file) {
  try {
    return process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file);
  } catch {
    return String(file).toLowerCase();
  }
}

function exportAllowedRoots(sessionDir) {
  const base = resolve(sessionDir);
  return { base, artifacts: resolve(join(dirname(base), 'session-artifacts')) };
}

function lexicalRoot(abs, root) {
  const a = canonFile(abs);
  const r = canonFile(root);
  return a === r || a.startsWith(r + sep);
}

/**
 * F1 containment (realpath + ancestor checks, not lexical prefix alone).
 * Mirrors Studio safePaths (lib/roadmap.mjs): the file itself must be a
 * regular non-symlink file (hardlinks rejected via nlink), every ancestor
 * directory up to and including the allowed root must be a real directory
 * (symlinks rejected), and realpath(file) must equal the lexical path
 * (catches junctions/mount redirections lstat cannot see). Roots are allowed
 * only under sessionDir; children under sessionDir or the sibling
 * session-artifacts root. Fails closed with pastudio_unsafe_path.
 */
async function assertSafeExportFile(file, sessionDir, kind) {
  assertAbsolutePath(resolve(file), 'session file');
  const abs = resolve(file);
  const { base, artifacts } = exportAllowedRoots(sessionDir);
  const roots = kind === 'child' ? [base, artifacts] : [base];
  if (!roots.some((root) => lexicalRoot(abs, root)))
    fail('pastudio_unsafe_path', `Export file escapes the allowed native roots (${kind}): ${file}.`, { file });
  const info = await lstat(abs).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink())
    fail('unreadable_session', `Session file is not a regular file: ${file}.`, { file });
  if (info.nlink > 1)
    fail('pastudio_unsafe_path', `Session file is hardlinked, refusing export: ${file}.`, { file });
  // Walk ancestors up to the matched root: no symlink, must be a directory.
  const root = roots.find((r) => lexicalRoot(abs, r));
  let cursor = dirname(abs);
  for (let depth = 0; depth < 64; depth++) {
    const entry = await lstat(cursor).catch(() => null);
    if (!entry) fail('pastudio_unsafe_path', `Unreadable ancestor directory: ${cursor}.`, { file });
    if (entry.isSymbolicLink() || !entry.isDirectory())
      fail('pastudio_unsafe_path', `Redirected ancestor directory, refusing export: ${cursor}.`, { file, ancestor: cursor });
    if (canonFile(cursor) === canonFile(root)) break;
    const parent = dirname(cursor);
    if (parent === cursor) fail('pastudio_unsafe_path', `Ancestor walk escaped without reaching the allowed root: ${file}.`, { file });
    cursor = parent;
  }
  const real = await realpath(abs).catch(() => null);
  if (!real || canonFile(real) !== canonFile(abs))
    fail('pastudio_unsafe_path', `Session file resolves outside its lexical path (junction/redirect), refusing export: ${file}.`, { file });
  return true;
}

function indexEdgesByParentFile(edges) {
  const byParent = new Map();
  for (const edge of edges) {
    const key = canonFile(edge.parent);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(edge);
  }
  return byParent;
}

/**
 * Collect an export selection. Reads each root file + all ledger-descendant
 * children (BFS, any depth), strict-parses every file, and returns flat blobs
 * plus a topology-only manifest (no artifact paths).
 */
export async function collectExport({
  sessionDir,
  agentHome,
  readEdges,
  rootSessionIds,
  readSessionFile = readAndValidateSessionFile,
  snapshotTornTail = false,
} = {}) {
  if (!sessionDir || !isAbsolute(sessionDir)) fail('invalid_path', 'collectExport requires an absolute sessionDir.');
  if (!Array.isArray(rootSessionIds) || !rootSessionIds.length) fail('invalid_export_selection', 'Select at least one root session id.');
  const roots = [...new Set(rootSessionIds)];
  for (const id of roots) assertValidSessionId(id, 'root session id');
  const edges = await discoverFamily({ agentHome, sessionDir, readEdges });
  const byParent = indexEdgesByParentFile(edges);
  const edgeByChildFile = new Map(edges.map((e) => [canonFile(e.child), e]));
  const blobs = [];
  const manifestSessions = [];
  const visitedFiles = new Set();
  const seenCanonical = new Map();
  const requestedToCanonical = new Map();
  const queue = [];
  for (const rootId of roots) {
    const file = join(resolve(sessionDir), `${rootId}.jsonl`);
    await assertSafeExportFile(file, sessionDir, 'root');
    queue.push({ file, kind: 'root', parentOldSessionId: null, childId: null, depth: 0, edgeName: null, requestedId: rootId });
  }
  while (queue.length) {
    const item = queue.shift();
    const fileKey = canonFile(item.file);
    if (visitedFiles.has(fileKey)) continue;
    visitedFiles.add(fileKey);
    await assertSafeExportFile(item.file, sessionDir, item.kind);
    const parsed = await readSessionFile(item.file, { snapshotTornTail });
    // Fork tolerance: canonical id is header.id; physical path stays separate
    // for ledger child linkage (byParent/edgeByChildFile keyed by canonFile).
    // Only duplicate canonical ids via different physical files are ambiguous.
    const oldSessionId = claimCanonicalId(seenCanonical, parsed.header, item.file);
    if (item.kind === 'root' && item.requestedId && !requestedToCanonical.has(item.requestedId))
      requestedToCanonical.set(item.requestedId, oldSessionId);
    if (item.kind === 'child') {
      const edge = edgeByChildFile.get(fileKey);
      if (!edge)
        fail('missing_ledger_edge', `Child file has no live ledger edge: ${item.file}; refusing to export an orphaned child.`, { file: item.file });
    }
    const name = item.edgeName || headerName(parsed) || oldSessionId;
    blobs.push({
      sessionId: oldSessionId,
      kind: item.kind,
      parentOldSessionId: item.parentOldSessionId,
      childId: item.childId,
      name,
      depth: item.depth,
      lines: parsed.lineCount,
      truncated: !!parsed.truncated,
      sha256: sha256Hex(parsed.headerLine + '\n' + parsed.entries.map((e) => e.line).join('\n') + '\n'),
      text: parsed.headerLine + '\n' + parsed.entries.map((e) => e.line).join('\n') + '\n',
    });
    manifestSessions.push({
      oldSessionId,
      kind: item.kind,
      parentOldSessionId: item.parentOldSessionId,
      childId: item.childId,
      name,
      depth: item.depth,
      lines: parsed.lineCount,
      ...(parsed.truncated ? { truncated: true } : {}),
    });
    for (const edge of byParent.get(fileKey) || []) {
      // Fail fast on a poisoned ledger edge before it enters the queue.
      await assertSafeExportFile(edge.child, sessionDir, 'child');
      queue.push({
        file: resolve(edge.child),
        kind: 'child',
        parentOldSessionId: oldSessionId,
        childId: edge.childId,
        depth: item.depth + 1,
        edgeName: edge.name || null,
      });
    }
  }
  const manifest = {
    format: PASTUDIO_FORMAT,
    createdAt: new Date().toISOString(),
    source: { sessionVersion: PASTUDIO_SESSION_VERSION },
    roots: roots.map((id) => {
      // Fork tolerance: the requested id may be a physical filename whose
      // canonical header.id differs; manifest roots stay canonical so they
      // remain a subset of sessions[].oldSessionId and ZIP entries stay
      // sessions/<canonical>.jsonl. Child linkage stays path-based above.
      const canonical = requestedToCanonical.get(id) || id;
      const found = manifestSessions.find((s) => s.oldSessionId === canonical);
      if (!found) fail('export_incomplete', `Selected root ${id} was not collected.`, { sessionId: id });
      return canonical;
    }),
    sessions: manifestSessions,
  };
  return { manifest, blobs };
}

export function validateExportContainer({ manifest, blobs } = {}) {
  if (!isRecord(manifest) || manifest.format !== PASTUDIO_FORMAT)
    fail('invalid_manifest', 'Manifest format must be pastudio/1.');
  if (!Array.isArray(manifest.sessions) || !manifest.sessions.length)
    fail('invalid_manifest', 'Manifest sessions must be a non-empty array.');
  if (!Array.isArray(blobs) || blobs.length !== manifest.sessions.length)
    fail('invalid_container', 'Blob count must match manifest session count.');
  const byId = new Map(blobs.map((b) => [b.sessionId, b]));
  for (const entry of manifest.sessions) {
    assertValidSessionId(entry.oldSessionId, 'manifest session');
    const blob = byId.get(entry.oldSessionId);
    if (!blob) fail('invalid_container', `Manifest session ${entry.oldSessionId} has no flat blob sessions/<id>.jsonl.`, { sessionId: entry.oldSessionId });
    if (blob.kind !== entry.kind) fail('invalid_container', `Kind mismatch for ${entry.oldSessionId}.`, { sessionId: entry.oldSessionId });
    if (entry.kind === 'child') {
      assertValidChildId(entry.childId, 'manifest child');
      assertValidSessionId(entry.parentOldSessionId, 'manifest parent');
      if (!byId.has(entry.parentOldSessionId))
        fail('invalid_container', `Child ${entry.oldSessionId} references missing parent ${entry.parentOldSessionId}.`, { sessionId: entry.oldSessionId });
      if (typeof entry.depth !== 'number' || entry.depth < 1)
        fail('invalid_manifest', `Invalid depth for child ${entry.oldSessionId}.`, { sessionId: entry.oldSessionId });
    } else if (entry.depth !== 0 || entry.parentOldSessionId !== null || entry.childId !== null) {
      fail('invalid_manifest', `Invalid root entry for ${entry.oldSessionId}.`, { sessionId: entry.oldSessionId });
    }
    // No artifact/ZIP paths allowed in the flat container.
    for (const key of ['file', 'path', 'child', 'parent']) {
      if (entry[key] !== undefined)
        fail('invalid_manifest', `Manifest must be topology-only: forbidden key "${key}" for ${entry.oldSessionId}.`, { sessionId: entry.oldSessionId });
    }
  }
  return true;
}

/**
 * Pure import planner. Generates new session + child ids, recomputes depths
 * from manifest topology. No I/O. Duplicate archives (same archiveSha256)
 * and divergent copies (same old id -> different new id) are detected by the
 * coordinator via the Studio lineage registry (see recordImportProvenance);
 * this planner always maps each old id to exactly one fresh new id per call.
 */
export function planImport(
  manifest,
  { destCwd, generateSessionId, generateChildId, now = () => new Date().toISOString() } = {},
) {
  if (!isRecord(manifest) || manifest.format !== PASTUDIO_FORMAT) fail('invalid_manifest', 'Manifest format must be pastudio/1.');
  if (typeof destCwd !== 'string' || !isAbsolute(destCwd)) fail('invalid_dest_cwd', 'Import requires an absolute destination project cwd.');
  const idMap = new Map();
  const childIdMap = new Map();
  for (const entry of manifest.sessions) {
    assertValidSessionId(entry.oldSessionId, 'manifest session');
    // Default path shares freshSessionId/freshChildId with planSessionRemap;
    // injected generators (tests) keep their own sequence but still pass the
    // same validators, so behaviour cannot silently diverge.
    const fresh = generateSessionId ? generateSessionId() : freshSessionId([...idMap.values()]);
    assertValidSessionId(fresh, 'generated session id');
    if ([...idMap.values()].includes(fresh)) fail('id_collision', 'Generated session id collision; retry with a fresh generator.');
    idMap.set(entry.oldSessionId, fresh);
    if (entry.kind === 'child') {
      const freshChild = generateChildId ? generateChildId() : freshChildId();
      if (!PASTUDIO_NEW_CHILD_ID_RE.test(freshChild))
        fail('invalid_child_id', 'Generated child id must match sub-[0-9a-f]{8}.', { value: freshChild });
      childIdMap.set(entry.oldSessionId, freshChild);
    }
  }
  const importedAt = now();
  const plan = manifest.sessions.map((entry) => ({
    oldSessionId: entry.oldSessionId,
    newSessionId: idMap.get(entry.oldSessionId),
    kind: entry.kind,
    parentOldSessionId: entry.parentOldSessionId,
    parentNewSessionId: entry.parentOldSessionId ? idMap.get(entry.parentOldSessionId) : null,
    newChildId: entry.kind === 'child' ? childIdMap.get(entry.oldSessionId) : null,
    name: entry.name || entry.oldSessionId,
    depth: entry.depth,
    destCwd: resolve(destCwd),
    importedAt,
  }));
  return { idMap, childIdMap, plan, destCwd: resolve(destCwd), importedAt };
}

function remapStructuredIdentities(parsedEntry, idMap, changedPaths) {
  // Typed native agent_message identities only:
  //   custom_message.details.{from.sessionId,target.sessionId}
  //   message.role=custom && customType=agent_message -> message.details.{...}
  // Never touches content text, tool args/results, code, activeSessionId,
  // or agentmsg ids.
  const targets = [];
  if (parsedEntry.type === 'custom_message' && parsedEntry.customType === 'agent_message' && isRecord(parsedEntry.details))
    targets.push({ holder: parsedEntry.details, base: 'details' });
  if (
    parsedEntry.type === 'message' &&
    isRecord(parsedEntry.message) &&
    parsedEntry.message.role === 'custom' &&
    parsedEntry.message.customType === 'agent_message' &&
    isRecord(parsedEntry.message.details)
  )
    targets.push({ holder: parsedEntry.message.details, base: 'message.details' });
  let changed = false;
  for (const { holder, base } of targets) {
    for (const side of ['from', 'target']) {
      const node = holder[side];
      if (isRecord(node) && typeof node.sessionId === 'string' && idMap.has(node.sessionId)) {
        node.sessionId = idMap.get(node.sessionId);
        changed = true;
        changedPaths.push(`${base}.${side}.sessionId`);
      }
    }
  }
  return changed;
}

/**
 * Transform one verbatim source text into its destination text.
 * - Header rebuilt: id=newSessionId, cwd=destCwd, timestamp=now,
 *   rlmDepth=newDepth, parentSession=newParentFile (children) or removed
 *   (roots), git stripped unless freshHeaderGit is explicitly provided.
 * - All history preserved, including git_state entries as evidence (no drop
 *   option: the dropGitState experiment was removed as non-canonical).
 * - Branch-local 8-hex entry ids are preserved. All other lines stay
 *   byte-identical except agent_message lines whose structured sessionId
 *   fields are in idMap.
 */
export function transformSessionText(
  sourceText,
  {
    oldSessionId,
    newSessionId,
    destCwd,
    newParentFile = null,
    newDepth = 0,
    newTimestamp = null,
    freshHeaderGit = undefined,
    idMap = new Map(),
  } = {},
) {
  assertValidSessionId(oldSessionId, 'source session id');
  assertValidSessionId(newSessionId, 'destination session id');
  if (typeof destCwd !== 'string' || !isAbsolute(destCwd)) fail('invalid_dest_cwd', 'transformSessionText requires an absolute destCwd.');
  if (newParentFile !== null) assertAbsolutePath(newParentFile, 'new parent file');
  if (!Number.isSafeInteger(newDepth) || newDepth < 0) fail('invalid_depth', 'newDepth must be an integer >= 0.');
  const parsed = parseSessionText(sourceText, { sourceLabel: oldSessionId });
  if (parsed.header.id !== oldSessionId)
    fail('id_mismatch', `Source header id ${parsed.header.id} does not match expected ${oldSessionId}.`, { oldSessionId });
  // All history is preserved, including git_state entries as evidence.
  // (The dropGitState experiment was removed per scope: dropping entries would
  // require relinking parentId/firstKeptEntryId/fromId/targetId chains, and the
  // canonical behaviour is to keep everything. Stale repo context self-heals
  // on the next run via recordGitStateIfChanged.)
  // Header: preserve unknown future engine fields via spread (evidence), then
  // rebuild exactly the runtime keys (id/cwd/parentSession/rlmDepth/timestamp
  // /git). No free text is generated here, so an allowlist would only risk
  // dropping future evidence.
  const header = { ...parsed.header };
  header.id = newSessionId;
  header.version = PASTUDIO_SESSION_VERSION;
  header.timestamp = newTimestamp || new Date().toISOString();
  header.cwd = resolve(destCwd);
  header.rlmDepth = newDepth;
  if (newParentFile) header.parentSession = newParentFile;
  else delete header.parentSession;
  if (freshHeaderGit === undefined) delete header.git;
  else if (freshHeaderGit === null) delete header.git;
  else header.git = freshHeaderGit;
  const outLines = [JSON.stringify(header)];
  const remappedIdentities = [];
  for (const { entry, line } of parsed.entries) {
    // Deep-clone via JSON round-trip (entries are JSON data only).
    const next = JSON.parse(JSON.stringify(entry));
    let lineChanged = false;
    const paths = [];
    if (remapStructuredIdentities(next, idMap, paths)) {
      lineChanged = true;
      for (const p of paths) remappedIdentities.push({ entryId: next.id, path: p });
    }
    outLines.push(lineChanged ? JSON.stringify(next) : line);
  }
  // Re-validate the transformed text strictly (catches our own bugs, never
  // silently ships a broken chain).
  parseSessionText(outLines.join('\n') + '\n', { sourceLabel: newSessionId });
  return { text: outLines.join('\n') + '\n', remappedIdentities };
}

/**
 * Remap typed Roadmap session references via idMap. Only typed sessions
 * arrays and typed actor ids are rewritten; free text/notes/titles never.
 * Unknown ids (e.g. other owners' links in a full-project export) pass
 * through untouched.
 */
export function remapRoadmapSessionRefs(document, idMap) {
  if (!isRecord(document)) fail('invalid_roadmap', 'Roadmap document must be an object.');
  const map = idMap instanceof Map ? idMap : new Map(Object.entries(idMap || {}));
  const remapId = (id) => (typeof id === 'string' && map.has(id) ? map.get(id) : id);
  const remapped = { sessions: 0, actors: 0 };
  const clone = JSON.parse(JSON.stringify(document));
  const remapActor = (node) => {
    if (!isRecord(node)) return;
    for (const key of ['sessionId', 'rootSessionId']) {
      if (typeof node[key] === 'string' && map.has(node[key])) {
        node[key] = map.get(node[key]);
        remapped.actors++;
      }
    }
  };
  if (clone.lastEdit && isRecord(clone.lastEdit)) remapActor(clone.lastEdit);
  for (const plan of Array.isArray(clone.plans) ? clone.plans : []) {
    if (Array.isArray(plan.sessions)) {
      plan.sessions = plan.sessions.map((id) => {
        const next = remapId(id);
        if (next !== id) remapped.sessions++;
        return next;
      });
    }
    for (const item of Array.isArray(plan.journal) ? plan.journal : []) remapActor(item);
  }
  for (const group of ['items', 'notes']) {
    const entries = clone.backlog?.[group];
    if (!Array.isArray(entries)) continue;
    for (const item of entries) {
      if (Array.isArray(item.sessions)) {
        item.sessions = item.sessions.map((id) => {
          const next = remapId(id);
          if (next !== id) remapped.sessions++;
          return next;
        });
      }
      remapActor(item);
    }
  }
  return { document: clone, remapped };
}

/** Read the FULL project Roadmap for export (no link filtering). */
export async function readFullRoadmap(projectCwd) {
  if (typeof projectCwd !== 'string' || !isAbsolute(projectCwd)) fail('invalid_path', 'readFullRoadmap requires an absolute project cwd.');
  const file = join(resolve(projectCwd), '.prime', 'studio', 'roadmap.json');
  const info = await lstat(file).catch(() => null);
  if (!info) return { file, missing: true, rawText: null, document: null };
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)
    fail('roadmap_unsafe_path', 'Roadmap file must be a regular file without links.', { file });
  if (info.size > PASTUDIO_MAX_ROADMAP_BYTES)
    fail('roadmap_too_large', `Roadmap exceeds ${PASTUDIO_MAX_ROADMAP_BYTES} bytes.`, { file });
  const rawText = await readFile(file, 'utf8');
  let document;
  try {
    document = JSON.parse(rawText);
  } catch (error) {
    fail('roadmap_corrupt', `Roadmap is not valid JSON: ${error.message}.`, { file });
  }
  if (!isRecord(document) || document.schemaVersion !== 1)
    fail('roadmap_corrupt', 'Roadmap schemaVersion must be 1.', { file });
  return { file, missing: false, rawText, document };
}

/**
 * Resume contract: history is evidence; the coordinator auto-assigns the
 * destination effective model. An explicit pick is required only when no
 * usable model is configured. This module never injects or defaults a model.
 */
export function getResumeContract() {
  return {
    requiresModelSelection: false,
    requiresExplicitWhenNoUsableDefault: true,
    modelPolicy: 'auto-effective-source-else-default',
    thinkingPolicy: 'retain-history-do-not-clamp',
    reason: 'Historical model_change/assistant.model records are evidence only; settings.json defaults are never imported. The coordinator auto-assigns the destination effective generationSettings (source historical when configured+available, else destination default when configured+usable, never an old unavailable provider). An explicit available pick is required only when no usable model is configured.',
  };
}

/**
 * Register imported child edges in the NATIVE ledger.
 * Exact native signatures: appendSpawn({childId,parent,child,depth,name}),
 * appendDelete({childId,child,reason}), flush().
 * Concurrency-safe (daemon O_APPEND + internal queue); no idle requirement.
 * Journal (recoverable): when journalPath is given, the full intended edge
 * list is written BEFORE any append; each success appends a done line. A
 * crash can be recovered by replaying the journal: skip edges already
 * present in edges(true), append the remainder. On failure this helper rolls
 * back the edges IT appended in this call via appendDelete reason "user"
 * (explicit operator-initiated removal) and rethrows the original error with
 * { registered, rolledBack }.
 */
export async function registerImportedEdges(
  { agentHome, sessionDir, edges, ledger = null, journalPath = null, log = () => {} } = {},
) {
  if (!Array.isArray(edges) || !edges.length) fail('invalid_edges', 'registerImportedEdges requires a non-empty edge list.');
  if (!sessionDir || !isAbsolute(sessionDir)) fail('invalid_path', 'registerImportedEdges requires an absolute sessionDir.');
  const normalized = edges.map((edge, index) => {
    if (!isRecord(edge)) fail('invalid_edges', `Edge ${index} must be an object.`);
    assertValidChildId(edge.childId, `edges[${index}].childId`);
    assertAbsolutePath(edge.parent, `edges[${index}].parent`);
    assertAbsolutePath(edge.child, `edges[${index}].child`);
    if (!Number.isSafeInteger(edge.depth) || edge.depth < 1)
      fail('invalid_edges', `edges[${index}].depth must be an integer >= 1.`);
    if (typeof edge.name !== 'string' || !edge.name.trim() || edge.name.length > 200)
      fail('invalid_edges', `edges[${index}].name must be 1..200 chars.`);
    return { childId: edge.childId, parent: resolve(edge.parent), child: resolve(edge.child), depth: edge.depth, name: edge.name.slice(0, 200) };
  });
  let active = ledger;
  if (!active) active = await openNativeLedger(agentHome, sessionDir);
  if (journalPath) {
    assertAbsolutePath(resolve(journalPath), 'journal path');
    await mkdir(dirname(resolve(journalPath)), { recursive: true });
    await writeFile(journalPath + '.tmp', JSON.stringify({ startedAt: new Date().toISOString(), edges: normalized }, null, 2) + '\n', 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(journalPath + '.tmp', journalPath);
  }
  const registered = [];
  try {
    for (const edge of normalized) {
      await active.appendSpawn({ childId: edge.childId, parent: edge.parent, child: edge.child, depth: edge.depth, name: edge.name });
      registered.push(edge);
      log(`pastudio: registered ${edge.childId}`);
    }
    await active.flush();
  } catch (error) {
    const rolledBack = [];
    for (const edge of registered) {
      try {
        await active.appendDelete({ childId: edge.childId, child: edge.child, reason: 'user' });
        rolledBack.push(edge.childId);
      } catch (rollbackError) {
        log(`pastudio: rollback failed for ${edge.childId}: ${rollbackError.message}`);
      }
    }
    try {
      await active.flush();
    } catch {}
    throw new PastudioError('ledger_register_failed', `Ledger registration failed after ${registered.length}/${normalized.length} edges; rolled back ${rolledBack.length}. Coordinator must also remove committed files or retry from the journal. Original: ${error.message}.`, {
      cause: error?.message,
      registered: registered.map((e) => e.childId),
      rolledBack,
    });
  }
  return { registered, ledgerPath: active.ledgerPath || null };
}

export async function rollbackRegisteredEdges({ agentHome, sessionDir, registered, ledger = null, reason = 'user' } = {}) {
  if (!Array.isArray(registered) || !registered.length) return { rolledBack: [] };
  if (!['user', 'parent-teardown', 'revoked', 'gc'].includes(reason)) fail('invalid_reason', 'Rollback reason must be a native delete reason.');
  let active = ledger;
  if (!active) active = await openNativeLedger(agentHome, sessionDir);
  const rolledBack = [];
  for (const edge of registered) {
    await active.appendDelete({ childId: edge.childId, child: edge.child, reason });
    rolledBack.push(edge.childId);
  }
  await active.flush();
  return { rolledBack };
}

/**
 * Preflight gate the coordinator MUST call before committing any import that
 * contains children. A missing native package with children present is a hard
 * failure: fail clear BEFORE commit (or queue the whole import as recoverable
 * without claiming success). Inspector-hidden partial success is NOT an
 * acceptable outcome for the scope promise — without ledger edges the
 * imported children are invisible in the inspector family view.
 * No writes are performed here; construction alone never mutates the ledger.
 */
export async function preflightImportLedger({ agentHome, sessionDir, hasChildren, ledger = null } = {}) {
  if (!hasChildren) return { available: false, skipped: 'no-children' };
  if (ledger) return { available: true, injected: true, ledgerPath: ledger.ledgerPath || null };
  const opened = await openNativeLedger(agentHome, sessionDir);
  return { available: true, injected: false, ledgerPath: opened.ledgerPath || null };
}

/**
 * Studio-side lineage registry (supplements the native ledger, which stores
 * no provenance). One JSONL line per import: { archiveSha256, destCwd,
 * importedAt, mapping: [{oldSessionId,newSessionId}] }. Used for same-archive
 * duplicate detection (reject re-import) and divergent-copy policy (same old
 * id previously imported under a different new id => create ANOTHER new copy,
 * never merge).
 */
export async function appendImportProvenance(registryPath, record) {
  assertAbsolutePath(resolve(registryPath), 'lineage registry');
  if (!isRecord(record) || typeof record.archiveSha256 !== 'string' || !record.archiveSha256)
    fail('invalid_provenance', 'Provenance record requires archiveSha256.');
  if (!Array.isArray(record.mapping) || !record.mapping.length)
    fail('invalid_provenance', 'Provenance record requires a non-empty mapping.');
  const { appendFile, mkdir: makeDir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await makeDir(dirname(resolve(registryPath)), { recursive: true });
  await appendFile(resolve(registryPath), JSON.stringify({ ...record, recordedAt: new Date().toISOString() }) + '\n', 'utf8');
  return true;
}

export async function findImportByArchive(registryPath, archiveSha256) {
  const { readFile: readRegistry } = await import('node:fs/promises');
  const text = await readRegistry(resolve(registryPath), 'utf8').catch(() => null);
  if (!text) return [];
  const matches = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.archiveSha256 === archiveSha256) matches.push(record);
    } catch {
      // A malformed provenance line must not hide other imports; skip it.
    }
  }
  return matches;
}

/**
 * Stage transformed import files into an ISOLATED staging dir only.
 * Writes staging/sessions/<newId>.jsonl (flat) + staging/import-journal.json.
 * Never writes into live sessionDir/artifacts. The coordinator owns the
 * atomic commit (rename) + ledger registration + provenance append.
 */
export async function stageImportFiles({ plan, blobsByOldId, stagingDir, sessionDir, idMap, destCwd, transformOptions = {} } = {}) {
  if (transformOptions && (transformOptions.dropGitState === true || transformOptions.keepGitState === false))
    throw new PastudioError('unsupported', 'dropGitState was removed from the canonical path: all history is preserved.');
  if (!Array.isArray(plan) || !plan.length) fail('invalid_plan', 'stageImportFiles requires a non-empty plan.');
  if (!stagingDir || !isAbsolute(stagingDir)) fail('invalid_path', 'stageImportFiles requires an absolute stagingDir.');
  if (!sessionDir || !isAbsolute(sessionDir)) fail('invalid_path', 'stageImportFiles requires an absolute sessionDir to embed final header.parentSession paths.');
  if (!(blobsByOldId instanceof Map)) fail('invalid_blobs', 'blobsByOldId must be a Map oldSessionId -> source text.');
  const staged = [];
  await mkdir(join(resolve(stagingDir), 'sessions'), { recursive: true });
  for (const item of plan) {
    const sourceText = blobsByOldId.get(item.oldSessionId);
    if (typeof sourceText !== 'string') fail('missing_blob', `Missing flat blob for ${item.oldSessionId}.`, { sessionId: item.oldSessionId });
    // header.parentSession must be the FINAL absolute parent file path so the
    // committed child resumes without post-commit rewriting. sessionDir is the
    // live destination sessions dir provided by the coordinator (no writes go
    // there from this module; only the path string is embedded).
    const { text, remappedIdentities, droppedGitState } = transformSessionText(sourceText, {
      oldSessionId: item.oldSessionId,
      newSessionId: item.newSessionId,
      destCwd: item.destCwd || destCwd,
      newParentFile: item.kind === 'child' ? join(resolve(sessionDir), `${item.parentNewSessionId}.jsonl`) : null,
      newDepth: item.depth,
      newTimestamp: item.importedAt,
      idMap: idMap instanceof Map ? idMap : new Map(),
      ...transformOptions,
    });
    const outFile = join(resolve(stagingDir), 'sessions', `${item.newSessionId}.jsonl`);
    const tmpFile = `${outFile}.tmp`;
    await writeFile(tmpFile, text, 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmpFile, outFile);
    staged.push({ ...item, stagedFile: outFile, remappedIdentities });
  }
  const journal = {
    format: PASTUDIO_FORMAT,
    stagedAt: new Date().toISOString(),
    destCwd: resolve(destCwd),
    files: staged.map((s) => ({ oldSessionId: s.oldSessionId, newSessionId: s.newSessionId, kind: s.kind, stagedFile: s.stagedFile })),
  };
  await writeFile(join(resolve(stagingDir), 'import-journal.json'), JSON.stringify(journal, null, 2) + '\n', 'utf8');
  return { staged, journal };
}

/* ============================================================================
 * Frozen coordinator API v1 (for lib/project-archives.mjs).
 * Thin wrappers over the core above. No live sessionDir writes here.
 * All file reads are verbatim bytes; strict validation fails closed.
 * ========================================================================== */

const coordinatorFail = (message, extra) => {
  throw new PastudioError('pastudio_invalid', message, extra);
};

function bufferToText(data, label) {
  if (!Buffer.isBuffer(data)) fail('pastudio_invalid', `Expected a Buffer (${label}).`, { label });
  if (!data.length) fail('pastudio_invalid', `Empty session bytes (${label}).`, { label });
  if (data.length > PASTUDIO_MAX_SESSION_BYTES)
    fail('pastudio_invalid', `Session bytes exceed ${PASTUDIO_MAX_SESSION_BYTES} (${label}).`, { label });
  return data.toString('utf8');
}

/**
 * validateSessionBytes(data: Buffer) -> { id, lines }.
 * Strict: every non-empty line must parse; torn tail (no trailing newline)
 * throws pastudio_invalid (no silent snapshot here; the collector uses
 * snapshotTornTail:false). Use parseSessionText(...,{snapshotTornTail:true})
 * directly only when the caller explicitly wants a truncated snapshot.
 */
export function validateSessionBytes(data) {
  // Single strict path shared with the collectors (see parseVerbatimBytes).
  const parsed = parseVerbatimBytes(data, 'validateSessionBytes');
  return { id: parsed.header.id, lines: parsed.lineCount };
}

function cwdEquals(a, b) {
  try {
    if (process.platform === 'win32') return resolve(a).toLowerCase() === resolve(b).toLowerCase();
    return resolve(a) === resolve(b);
  } catch {
    return false;
  }
}

async function readVerbatimFile(file) {
  const info = await lstat(file).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink())
    coordinatorFail(`Session file is not a regular file: ${file}.`, { file });
  if (info.size > PASTUDIO_MAX_SESSION_BYTES)
    coordinatorFail(`Session file exceeds size cap: ${file}.`, { file });
  const data = await readFile(file).catch(() => {
    coordinatorFail(`Cannot read session file: ${file}.`, { file });
  });
  return { data, bytes: data.length };
}

/**
 * collectProjectSessions({ store, sessionDir, agentHome, cwd, readEdges? })
 * Full project collection: every root in sessionDir whose header.cwd matches
 * cwd, plus all ledger-descendant children (BFS, any depth) via the native
 * ledger reader (injected readEdges preferred; else discoverFamily lazy-loads
 * RlmSpawnLedger like session-inspector). Verbatim bytes, flat blobs, strict
 * fail-closed validation, torn tails rejected (snapshot only via explicit
 * core option, never silently). No harness/kernel/settings/project files.
 */
export async function collectProjectSessions({ store, sessionDir, agentHome, cwd, readEdges } = {}) {
  if (!sessionDir || typeof sessionDir !== 'string' || !isAbsolute(sessionDir))
    coordinatorFail('collectProjectSessions requires an absolute sessionDir.');
  if (!cwd || typeof cwd !== 'string' || !isAbsolute(cwd))
    coordinatorFail('collectProjectSessions requires an absolute project cwd.');
  const projectCwd = resolve(cwd);
  const { readdir } = await import('node:fs/promises');
  const dirEntries = await readdir(resolve(sessionDir), { withFileTypes: true }).catch(() => {
    coordinatorFail(`Cannot list sessionDir: ${sessionDir}.`, { sessionDir });
  });
  const rootFiles = [];
  for (const entry of dirEntries) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    rootFiles.push(join(resolve(sessionDir), entry.name));
  }
  const roots = [];
  const rootIdByFile = new Map();
  const seenCanonical = new Map();
  for (const file of rootFiles) {
    await assertSafeExportFile(file, sessionDir, 'root');
    const { data, bytes } = await readVerbatimFile(file);
    const parsed = parseVerbatimBytes(data, file);
    if (!cwdEquals(parsed.header.cwd, projectCwd)) continue;
    // Fork tolerance: trust canonical header.id, keep physical file separate
    // for ledger child linkage. Only duplicate canonical ids via different
    // physical files fail (ambiguous fork). ZIP entries stay canonical
    // sessions/<oldSessionId>.jsonl downstream.
    try {
      claimCanonicalId(seenCanonical, parsed.header, file);
    } catch (error) {
      coordinatorFail(error.message, { file });
    }
    roots.push({ oldSessionId: parsed.header.id, file, bytes, lines: parsed.lineCount, data });
    rootIdByFile.set(file.toLowerCase(), parsed.header.id);
  }
  const edges = await discoverFamily({ agentHome, sessionDir, readEdges });
  const byParentFile = new Map();
  for (const edge of edges) {
    const key = canonFile(edge.parent);
    if (!byParentFile.has(key)) byParentFile.set(key, []);
    byParentFile.get(key).push(edge);
  }
  const edgeByChildFile = new Map(edges.map((e) => [canonFile(e.child), e]));
  const children = [];
  const outEdges = [];
  const visitedFiles = new Set();
  const rootIds = new Set(roots.map((r) => r.oldSessionId));
  const queue = roots.map((r) => ({ parentFile: r.file, parentOldSessionId: r.oldSessionId, rootOldSessionId: r.oldSessionId, parentAgentId: null, depth: 0 }));
  for (const r of roots) visitedFiles.add(canonFile(r.file));
  while (queue.length) {
    const item = queue.shift();
    const siblings = byParentFile.get(canonFile(item.parentFile)) || [];
    for (const edge of siblings) {
      const childKey = canonFile(edge.child);
      if (visitedFiles.has(childKey)) continue;
      visitedFiles.add(childKey);
      await assertSafeExportFile(edge.child, sessionDir, 'child');
      const { data, bytes } = await readVerbatimFile(edge.child);
      const parsed = parseVerbatimBytes(data, edge.child);
      // Fork tolerance (shared seenCanonical across roots+children keeps
      // ZIP entry names sessions/<canonical>.jsonl unique): trust header.id,
      // keep ledger path-based linkage (byParentFile/parentFile) unchanged.
      try {
        claimCanonicalId(seenCanonical, parsed.header, edge.child);
      } catch (error) {
        coordinatorFail(error.message, { file: edge.child });
      }
      if (!cwdEquals(parsed.header.cwd, projectCwd))
        coordinatorFail(`Child ${parsed.header.id} cwd does not match project cwd; refusing cross-project child.`, { file: edge.child });
      assertValidChildId(edge.childId, 'ledger childId');
      const depth = item.depth + 1;
      children.push({
        oldSessionId: parsed.header.id,
        rootOldSessionId: item.rootOldSessionId,
        agentId: edge.childId,
        parentAgentId: item.parentAgentId,
        parentOldSessionId: item.parentOldSessionId,
        depth,
        file: edge.child,
        bytes,
        lines: parsed.lineCount,
        data,
      });
      outEdges.push({
        childOldSessionId: parsed.header.id,
        parentOldSessionId: item.parentOldSessionId,
        parentFile: item.parentFile,
        childAgentId: edge.childId,
        depth,
        name: edge.name || parsed.header.id,
      });
      queue.push({ parentFile: edge.child, parentOldSessionId: parsed.header.id, rootOldSessionId: item.rootOldSessionId, parentAgentId: edge.childId, depth });
    }
  }
  return { roots, children, edges: outEdges };
}

/**
 * planSessionRemap(collected, destCwd) -> { idMap, rootMap, childPathPlan }.
 * Pure. Fresh uuidv4-validId ids, unique within the plan and never equal to
 * any collected old id. Additive: no dest mutation here; the coordinator's
 * wx-only writes guarantee no overwrite of live sessions.
 */
export function planSessionRemap(collected, destCwd) {
  if (!isRecord(collected) || !Array.isArray(collected.roots) || !Array.isArray(collected.children) || !Array.isArray(collected.edges))
    coordinatorFail('planSessionRemap requires { roots, children, edges } from collectProjectSessions.');
  if (typeof destCwd !== 'string' || !isAbsolute(destCwd))
    coordinatorFail('planSessionRemap requires an absolute destCwd.');
  const dest = resolve(destCwd);
  const allOld = [...collected.roots.map((r) => r.oldSessionId), ...collected.children.map((c) => c.oldSessionId)];
  for (const id of allOld) assertValidSessionId(id, 'collected session');
  const idMap = new Map();
  const taken = new Set(allOld);
  for (const id of allOld) {
    const fresh = freshSessionId(taken);
    taken.add(fresh);
    idMap.set(id, fresh);
  }
  const rootMap = new Map(collected.roots.map((r) => [r.oldSessionId, idMap.get(r.oldSessionId)]));
  const newRootByOld = new Map();
  for (const child of collected.children) newRootByOld.set(child.oldSessionId, idMap.get(child.rootOldSessionId));
  const childPathPlan = collected.children.map((child) => {
    const newSessionId = idMap.get(child.oldSessionId);
    const newRootId = newRootByOld.get(child.oldSessionId);
    const freshAgent = freshChildId();
    return {
      oldSessionId: child.oldSessionId,
      newSessionId,
      newRootId,
      newAgentId: freshAgent,
      oldAgentId: child.agentId,
      depth: child.depth,
      destFile: null,
    };
  });
  return { idMap, rootMap, childPathPlan, destCwd: dest };
}

/**
 * remapSessionBytes(data: Buffer, ctx: { idMap: Map, destCwd: string, newId: string, newParentFile?: string|null, newDepth?: number })
 * Verbatim-preserving transform: header rebuilt (id/cwd/parentSession/
 * rlmDepth/timestamp, header.git stripped), all history including git_state
 * kept as evidence, typed agent_message sessionIds in idMap remapped,
 * everything else byte-identical. Historical model records kept; no model
 * injected (coordinator marks needsModelChoice:true for the resume gate).
 * Passing dropGitState:true fails with code "unsupported" (removed option).
 */
export function remapSessionBytes(data, ctx = {}) {
  const { idMap, destCwd, newId, newParentFile = null, newDepth = 0, dropGitState } = ctx;
  if (dropGitState === true)
    throw new PastudioError('unsupported', 'dropGitState was removed from the canonical path: all history including git_state is preserved as evidence.');
  if (!(idMap instanceof Map)) coordinatorFail('remapSessionBytes requires ctx.idMap: Map<old,new>.');
  if (typeof destCwd !== 'string' || !isAbsolute(destCwd)) coordinatorFail('remapSessionBytes requires absolute ctx.destCwd.');
  assertValidSessionId(newId, 'ctx.newId');
  const probe = parseVerbatimBytes(data, 'remapSessionBytes');
  const text = data.toString('utf8');
  const { text: out } = transformSessionText(text, {
    oldSessionId: probe.header.id,
    newSessionId: newId,
    destCwd: resolve(destCwd),
    newParentFile,
    newDepth,
    idMap,
  });
  return Buffer.from(out, 'utf8');
}

/**
 * registerImportedLineage({ agentHome, sessionDir, edges, ledger?, journalPath?, log? }).
 * Confirmed contract: NATIVE appendSpawn registration is SAFE (engine 0.9.4
 * RlmSpawnLedger.appendSpawn({childId,parent,child,depth,name}) + flush();
 * multi-writer O_APPEND + internal queue, no idle requirement; duplicate
 * child-path per process is advisory). Called AFTER the coordinator's atomic
 * commit; rolls back via appendDelete reason "user" on partial failure.
 * The coordinator ALSO keeps its Studio pending journal + wx file writes and
 * SHOULD append Studio provenance (appendImportProvenance) for
 * same-archive duplicate + divergent-copy detection (ledger stores no
 * provenance). If the native package is unavailable this fails closed with
 * code "ledger_unavailable": the coordinator must have called
 * preflightImportLedger() BEFORE commit when children exist, so this path
 * means fail-clear (or queue recoverable WITHOUT claiming success) — never
 * ship an inspector-hidden partial import as successful.
 */
export async function registerImportedLineage({ agentHome, sessionDir, edges, ledger = null, journalPath = null, log = () => {} } = {}) {
  return registerImportedEdges({ agentHome, sessionDir, edges, ledger, journalPath, log });
}
