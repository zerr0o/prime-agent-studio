/**
 * project-archives — .pastudio portable export/import coordinator (v1, local-only).
 *
 * Owns: manifest/roadmap.json assembly, canonical payload digest, preview tokens
 * (TOCTOU binding), atomic staging/rollback across sessions+roadmap+marks,
 * pending-journal recovery, effective-model finalization + badge TTL helpers.
 * Delegates:
 * - lib/pastudio-container.mjs: ZIP encode/decode (Map filename->Buffer), caps.
 * - lib/pastudio-sessions.mjs: native collection, validation, remap, lineage.
 * - lib/roadmap.mjs: readRaw + importPastudio (single lock, single revision++).
 * - lib/store.mjs: markPastudioImported/unmark/consume + read receipts + opened flag.
 *
 * Local-only v1: routes are never added to the LAN gateway allowlist
 * (gateway 404s them); the engine binds 127.0.0.1 only. No remote auth needed.
 * Histories may contain secrets: warned, never sanitized, no credentials files.
 * No auto-run/resume on import; history model records stay verbatim as evidence
 * and the destination effective generationSettings.model is auto-assigned
 * (source historical if configured+available, else destination default if
 * configured+usable, else no-usable-model warning). Never imports provider
 * credentials or subagent global defaults. Imported badge clears on first user
 * open (POST /api/sessions/read) or 3 min TTL, whichever first.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve, basename, sep, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, open, readFile, readdir, rename, rm, unlink, writeFile, lstat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { HttpError, validId, cwdKey } from './store.mjs';

export const PASTUDIO_FORMAT = 'pastudio';
export const PASTUDIO_VERSION = 1;
export const PASTUDIO_NATIVE_VERSION = 3;
export const PASTUDIO_COMPRESSED_MAX = 128 * 1024 * 1024;
export const PASTUDIO_TOKEN_TTL_MS = 15 * 60 * 1000;
export const PASTUDIO_MAX_CONCURRENT = 1;
export const PASTUDIO_PENDING_DIRNAME = 'project-archives-pending';
// Imported badge TTL: disappears on first user open or after 3 min, whichever
// first. Mirrors lib/store.mjs PASTUDIO_BADGE_TTL_MS and frontend
// ARCHIVE_BADGE_TTL_MS. Persistence via pastudioImportedAt + pastudioOpenedAt.
export const PASTUDIO_BADGE_TTL_MS = 3 * 60 * 1000;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

const fail = (status, code, message, extra = {}) => Object.assign(new HttpError(status, message), { code }, extra && typeof extra === 'object' ? extra : {});
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Imported-conversation UX helpers (pure, isolated fixture-testable).
// History bytes stay verbatim; the effective model lives only in
// store.sessions[*].generationSettings.
export function extractSourceModelFromBytes(data) {
  try {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
    let last = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry = null;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type === 'model_change' && typeof entry.provider === 'string' && typeof entry.modelId === 'string') {
        const id = `${entry.provider}/${entry.modelId}`;
        if (id.length <= 500 && id.includes('/')) last = id;
      } else if (entry.type === 'message' && entry.message?.role === 'assistant' && typeof entry.message.model === 'string') {
        const provider = typeof entry.message.provider === 'string' ? entry.message.provider : '';
        const id = provider ? `${provider}/${entry.message.model}` : String(entry.message.model);
        if (id.length <= 500 && id.includes('/')) last = id;
      }
    }
    return last;
  } catch { return null; }
}

// Approved availability rule: provider must be configured AND the model entry
// must exist and be supported. Absent entries, 'unavailable' and 'unknown'
// are never usable. Models without an availability field (custom) are usable
// only when their provider is configured. No new secrets are read here; the
// caller supplies the already-built catalog (models + configuredProviders +
// default). Never guesses a first model.
export function isCatalogModelUsable(catalog, modelId) {
  if (!modelId || typeof modelId !== 'string' || modelId.length > 500) return false;
  const slash = modelId.indexOf('/');
  if (slash <= 0 || slash >= modelId.length - 1) return false;
  const provider = modelId.slice(0, slash);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const entry = models.find((m) => m?.id === modelId);
  if (!entry) return false;
  if (entry.availability === 'unavailable' || entry.availability === 'unknown') return false;
  const configured = Array.isArray(catalog?.configuredProviders) ? catalog.configuredProviders : [];
  if (!configured.includes(provider)) {
    // Built-in entries with explicit 'available' still require configuration;
    // custom entries without availability also require it.
    return false;
  }
  return true;
}

export function resolveEffectiveModel(sourceModelId, catalog) {
  const def = typeof catalog?.default?.model === 'string' ? catalog.default.model : null;
  if (sourceModelId && isCatalogModelUsable(catalog, sourceModelId))
    return { model: sourceModelId, source: 'historical', warning: null };
  if (def && isCatalogModelUsable(catalog, def))
    return { model: def, source: 'default', warning: sourceModelId ? 'source-unavailable-fallback-default' : null };
  return { model: null, source: null, warning: 'no-usable-default' };
}

export function isPastudioBadgeVisible(summary, nowMs = Date.now()) {
  if (!summary || summary.pastudioImported !== true) return false;
  if (summary.pastudioOpenedAt) return false;
  const at = Number(summary.pastudioImportedAt);
  if (!Number.isSafeInteger(at)) return true;
  return Number(nowMs) - at < PASTUDIO_BADGE_TTL_MS;
}

// Canonical topology bound into payloadDigest alongside the container files
// digest (which excludes manifest.json). Excludes volatile archiveId/createdAt
// so repeat exports of identical content dedup; any topology divergence
// (ids/files/roots/agent topology/roadmap counts/source) changes the digest.
export function canonicalTopologyJson(manifest) {
  const sessions = [...(manifest.sessions || [])]
    .map((s) => ({
      oldSessionId: s.oldSessionId,
      file: s.file,
      root: !!s.root,
      rootOldSessionId: s.rootOldSessionId || null,
      agentId: s.agentId || null,
      parentAgentId: s.parentAgentId || null,
      parentOldSessionId: s.parentOldSessionId || null,
      depth: s.depth ?? 0,
      sha256: s.sha256,
      bytes: s.bytes,
      lines: s.lines,
    }))
    .sort((a, b) => (a.oldSessionId < b.oldSessionId ? -1 : 1));
  const r = manifest.roadmap || {};
  const topo = {
    format: PASTUDIO_FORMAT,
    version: PASTUDIO_VERSION,
    nativeVersion: PASTUDIO_NATIVE_VERSION,
    sourceProject: { name: manifest.sourceProject?.name || '', cwd: manifest.sourceProject?.cwd || '' },
    sessions,
    roadmap: {
      file: r.file || 'roadmap.json',
      sha256: r.sha256 || '',
      bytes: r.bytes ?? 0,
      plans: r.plans ?? 0,
      steps: r.steps ?? 0,
      milestones: r.milestones ?? 0,
      backlogItems: r.backlogItems ?? 0,
      backlogNotes: r.backlogNotes ?? 0,
      journalEntries: r.journalEntries ?? 0,
    },
    counts: manifest.counts || {},
  };
  return stableStringify(topo);
}

export function computePayloadDigest(filesMap, manifest, containerDigestFn = null) {
  let filesDigest;
  if (typeof containerDigestFn === 'function') filesDigest = containerDigestFn(filesMap);
  else {
    // Fallback canonical files digest (excludes manifest.json), mirrors container helper.
    const items = [...filesMap.entries()]
      .filter(([name]) => name !== 'manifest.json')
      .map(([name, data]) => [name, Buffer.isBuffer(data) ? data : Buffer.from(data)])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const h = createHash('sha256');
    h.update('pastudio-container-v1\0', 'utf8');
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    h.update(u32(items.length));
    for (const [name, buf] of items) {
      const nb = Buffer.from(name, 'utf8');
      h.update(u32(nb.length)); h.update(nb);
      const lb = Buffer.alloc(8); lb.writeBigUInt64BE(BigInt(buf.length)); h.update(lb); h.update(buf);
    }
    filesDigest = h.digest('hex');
  }
  const topo = canonicalTopologyJson(manifest);
  return sha256Hex(Buffer.concat([Buffer.from(filesDigest, 'utf8'), Buffer.from([0]), Buffer.from(topo, 'utf8')]));
}

function countSteps(steps) {
  let n = 0;
  const visit = (nodes) => { for (const s of nodes || []) { n++; visit(s.children); } };
  visit(steps);
  return n;
}

function roadmapCounts(doc) {
  if (!doc) return { plans: 0, steps: 0, milestones: 0, backlogItems: 0, backlogNotes: 0, journalEntries: 0 };
  let steps = 0, journal = 0;
  for (const p of doc.plans || []) { steps += countSteps(p.steps); journal += (p.journal || []).length; }
  return {
    plans: (doc.plans || []).length,
    steps,
    milestones: (doc.overview?.milestones || []).length,
    backlogItems: (doc.backlog?.items || []).length,
    backlogNotes: (doc.backlog?.notes || []).length,
    journalEntries: journal,
  };
}

function countMessagesInBytes(data) {
  const text = data.toString('utf8');
  let messages = 0, lines = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    lines++;
    try { if (JSON.parse(line)?.type === 'message') messages++; } catch { /* validated elsewhere */ }
  }
  return { messages, lines };
}

async function loadSiblings(overrides = {}) {
  let container = overrides.container || null;
  let sessions = overrides.sessions || null;
  if (!container) {
    try { container = await import('./pastudio-container.mjs'); }
    catch { throw fail(503, 'pastudio_unavailable', 'Archive container indisponible.'); }
  }
  if (!sessions) {
    try { sessions = await import('./pastudio-sessions.mjs'); }
    catch { throw fail(503, 'pastudio_unavailable', 'Collecte des conversations indisponible.'); }
  }
  if (typeof container.encodePastudio !== 'function' || typeof container.decodePastudio !== 'function')
    throw fail(503, 'pastudio_unavailable', 'Module container incompatible.');
  return { container, sessions };
}

export function createProjectArchives(options = {}) {
  const { store, roadmap, sessionDir, dataDir, agentHome, getCatalog } = options;
  if (!store || !roadmap) throw new TypeError('store and roadmap are required');
  if (!sessionDir || !isAbsolute(sessionDir)) throw new TypeError('absolute sessionDir is required');
  if (!dataDir || !isAbsolute(dataDir)) throw new TypeError('absolute dataDir is required');
  if (!agentHome || !isAbsolute(agentHome)) throw new TypeError('absolute agentHome is required');
  const injected = { container: options.container || null, sessions: options.sessions || null, readEdges: options.readEdges };
  const now = options.now || Date.now;
  const pendingDir = join(resolve(dataDir), PASTUDIO_PENDING_DIRNAME);
  const tokens = new Map();
  let activeOps = 0;

  function guardSlot() {
    if (activeOps >= PASTUDIO_MAX_CONCURRENT)
      throw fail(503, 'pastudio_busy', 'Trop d’opérations d’archive simultanées. Réessayez dans un instant.');
    activeOps++;
  }
  function releaseSlot() { activeOps = Math.max(0, activeOps - 1); }
  function purgeTokens() {
    const t = now();
    for (const [k, v] of tokens) if (v.expiresAt <= t) tokens.delete(k);
    if (tokens.size > 64) for (const k of tokens.keys()) { tokens.delete(k); if (tokens.size <= 64) break; }
  }

  const PENDING_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.json$/;
  const PENDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const underRoot = (abs, root) => {
    const a = process.platform === 'win32' ? resolve(abs).toLowerCase() : resolve(abs);
    const r = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
    return a === r || a.startsWith(r + sep);
  };
  const destAllowed = (destFile) =>
    underRoot(destFile, sessionDir) || underRoot(destFile, join(resolve(agentHome), 'session-artifacts'));
  // Hardened live write: containment + realpath'd safe ancestors + wx-only
  // (O_EXCL fails on any pre-existing path incl. symlinks) + O_NOFOLLOW where
  // supported (constants value is 0 where unsupported: identical to wx there).
  async function safeWriteImportFile(destFile, data) {
    if (!isAbsolute(destFile) || !destAllowed(destFile))
      throw fail(500, 'pastudio_unsafe_path', 'Destination d’import hors racines autorisées.');
    const dir = dirname(resolve(destFile));
    await mkdir(dir, { recursive: true });
    let realDir = null;
    try { realDir = await (await import('node:fs/promises')).realpath(dir); } catch { realDir = null; }
    if (!realDir || !destAllowed(realDir))
      throw fail(500, 'pastudio_unsafe_path', 'Dossier de destination redirigé.');
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0);
    let handle = null;
    try {
      handle = await open(destFile, flags, 0o600);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close(); handle = null;
    } catch (e) {
      try { await handle?.close(); } catch {}
      if (e?.code === 'EEXIST' || e?.code === 'ELOOP')
        throw fail(409, 'pastudio_collision', 'Collision d’identifiant. Relancez l’aperçu.');
      throw fail(500, 'pastudio_write_failed', 'Écriture des conversations impossible. Import annulé.');
    }
  }
  // Hardened removal: only our verified file (regular, no symlink, nlink==1,
  // header id match). Anything else is left untouched.
  async function safeRemoveImportFile(destFile, expectedId) {
    try {
      if (!isAbsolute(destFile) || !destAllowed(destFile)) return false;
      const st = await lstat(destFile).catch(() => null);
      if (!st || !st.isFile() || st.isSymbolicLink() || st.nlink !== 1) return false;
      const data = await readFile(destFile).catch(() => null);
      if (!data) return false;
      let header = null;
      try { header = JSON.parse(data.subarray(0, data.indexOf(10)).toString('utf8')); } catch { return false; }
      if (header?.id !== expectedId) return false;
      await rm(destFile, { force: true });
      return true;
    } catch { return false; }
  }
  async function pendingList() {
    let names;
    try { names = await readdir(pendingDir); }
    catch (e) { if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return []; throw e; }
    const out = [];
    for (const name of names) {
      if (!PENDING_NAME_RE.test(name)) continue;
      try {
        const rec = JSON.parse(await readFile(join(pendingDir, name), 'utf8'));
        if (isRecord(rec) && PENDING_ID_RE.test(rec.importId || '')) out.push(rec);
      } catch { /* corrupt pending ignored, cleaned lazily */ }
    }
    return out;
  }

  async function writePending(record) {
    await mkdir(pendingDir, { recursive: true });
    const tmp = join(pendingDir, `.${record.importId}.tmp`);
    await writeFile(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, join(pendingDir, `${record.importId}.json`));
  }
  async function deletePending(importId) {
    if (!UUID_RE.test(importId || '')) return;
    await unlink(join(pendingDir, `${importId}.json`)).catch(() => {});
  }
  const lineageJournalPath = (importId) => (UUID_RE.test(importId || '') ? join(pendingDir, `${importId}.lineage.jsonl`) : null);
  async function clearPending(importId) {
    await deletePending(importId);
    const journal = lineageJournalPath(importId);
    if (journal) await unlink(journal).catch(() => {});
  }

  // Destination effective-model finalization (all imported sessions: roots +
  // resumable children). History bytes stay verbatim; only per-session
  // store.sessions[*].generationSettings.model is set. Source historical model
  // wins when configured+usable, else destination default when
  // configured+usable, else no assignment (caller keeps needs-model-choice
  // warning). Never picks a guessed first model, never reuses an unavailable
  // provider, never touches credentials or subagent global defaults. Returns
  // per-session outcomes for warnings.
  async function finalizeImportedModels(allIds, sourceModels, catalog) {
    const outcomes = {};
    for (const newId of allIds || []) {
      if (!validId(newId)) continue;
      const source = typeof sourceModels?.[newId] === 'string' ? sourceModels[newId] : null;
      const resolved = resolveEffectiveModel(source, catalog);
      outcomes[newId] = resolved;
      if (!resolved.model) continue;
      // Atomic init-only (never overwrites a user PATCH after import; aligns
      // with conversation-settings locking). Children included when resumable;
      // no global subagent defaults are touched (per-session settings only).
      try {
        if (typeof store.initPastudioEffectiveModel === 'function') {
          const r = await store.initPastudioEffectiveModel(newId, resolved.model);
          outcomes[newId] = { ...resolved, persisted: !!r?.initialized, skipped: r?.skipped || undefined };
          // Already-present user model counts as effective (no warning).
          if (r?.skipped === 'user-model-present') outcomes[newId] = { ...resolved, persisted: true, source: resolved.source || 'user' };
        } else if (typeof store.setConversationSettings === 'function') {
          await store.setConversationSettings(newId, { model: resolved.model });
          outcomes[newId] = { ...resolved, persisted: true };
        }
      } catch { outcomes[newId] = { ...resolved, persisted: false }; continue; }
    }
    return outcomes;
  }

  // Transactional boundary (v1): sessions files are pre-committed with wx-only
  // writes + rollback; the roadmap+marker commit (single lock, single revision++)
  // is the ATOMIC boundary; marks + native lineage are post-commit and replayed
  // here until they succeed. Recovery: replay-or-rollback pending imports. Runs
  // before every archive op and should run at server startup and before new runs
  // (see server wiring). Unknown roadmap read errors leave the record pending
  // (never roll back on an ambiguous read); only a definitive absent marker rolls back.
  async function recoverPending() {
    const records = await pendingList();
    for (const rec of records) {
      try {
        if (!isRecord(rec) || !rec.importId || !rec.destCwd) { await deletePending(rec?.importId || 'bad'); continue; }
        let markerPresent = false, ambiguous = false;
        try {
          const dto = await roadmap.read(rec.destCwd);
          markerPresent = (dto.pastudioImports || []).some(
            (e) => e.payloadDigest === rec.payloadDigest || e.archiveId === rec.archiveId,
          );
        } catch (e) {
          if (e?.status === 404 || e?.code === 'roadmap_uninitialized' || e?.code === 'roadmap_missing') markerPresent = false;
          else { ambiguous = true; }
        }
        if (ambiguous) continue;
        if (markerPresent) {
          // Commit survived the crash: replay marks + lineage until BOTH are
          // durable. Unfinished finalization is NEVER dropped: the record stays
          // pending (flags refreshed) so previews/imports keep reporting
          // pending instead of a completed duplicate. Model finalization is
          // replayed best-effort (same resolver as import); receipts are
          // initialized once only (missing entries, never overwritten).
          let marksDone = !rec.marksPending, lineageDone = !(Array.isArray(rec.ledgerEdges) && rec.ledgerEdges.length);
          if (rec.marksPending && Array.isArray(rec.newIds) && rec.newIds.length) {
            try {
              await store.markPastudioImported?.(rec.newIds, { archiveId: rec.archiveId, importedAt: rec.createdAt });
              marksDone = true;
            } catch { marksDone = false; }
          }
          if (marksDone && typeof getCatalog === 'function') {
            const ids = Array.isArray(rec.allModelIds) && rec.allModelIds.length ? rec.allModelIds : (Array.isArray(rec.rootIds) ? rec.rootIds : rec.newIds);
            if (Array.isArray(ids) && ids.length) {
              try { await finalizeImportedModels(ids, rec.sourceModels || {}, await getCatalog().catch(() => null)); }
              catch { /* model finalization retries on next recovery; marks stay done */ }
            }
          }
          if (Array.isArray(rec.ledgerEdges) && rec.ledgerEdges.length) {
            try {
              const { sessions } = await loadSiblings(injected);
              if (typeof sessions.registerImportedLineage === 'function') {
                await sessions.registerImportedLineage({ agentHome, sessionDir, edges: rec.ledgerEdges, journalPath: lineageJournalPath(rec.importId) });
                lineageDone = true;
              } else lineageDone = false;
            } catch { lineageDone = false; }
          }
          if (marksDone && lineageDone) await clearPending(rec.importId);
          else {
            rec.marksPending = !marksDone;
            await writePending(rec);
          }
        } else {
          // No commit: remove exactly the files we created (hardened verify), unmark, clear.
          for (const f of rec.newFiles || []) {
            if (!f || !UUID_RE.test(f.newSessionId || '')) continue;
            await safeRemoveImportFile(f.destFile, f.newSessionId);
          }
          try { if (rec.newIds?.length) await store.unmarkPastudioImported?.(rec.newIds); } catch {}
          await clearPending(rec.importId);
        }
      } catch { /* never fail recovery loudly; next op retries */ }
    }
    return { recovered: records.length };
  }

  function validateManifestShape(manifest, filesMap) {
    if (!isRecord(manifest)) throw fail(422, 'pastudio_invalid', 'Manifest invalide.');
    if (manifest.format !== PASTUDIO_FORMAT || manifest.version !== PASTUDIO_VERSION)
      throw fail(400, 'pastudio_version', 'Version d’archive non prise en charge.');
    if (manifest.nativeVersion !== PASTUDIO_NATIVE_VERSION)
      throw fail(400, 'pastudio_version', 'Version native non prise en charge.');
    const archiveId = typeof manifest.archiveId === 'string' ? manifest.archiveId.trim() : '';
    if (!archiveId || archiveId.length > 200) throw fail(422, 'pastudio_invalid', 'Archive sans identifiant.');
    if (!Array.isArray(manifest.sessions) || manifest.sessions.length > 1000)
      throw fail(422, 'pastudio_invalid', 'Sessions du manifest invalides.');
    const seen = new Set();
    for (const s of manifest.sessions) {
      if (!isRecord(s) || !SAFE_ID_RE.test(s.oldSessionId || ''))
        throw fail(422, 'pastudio_invalid', 'Session du manifest invalide.');
      const expected = `sessions/${s.oldSessionId}.jsonl`;
      if (s.file !== expected) throw fail(422, 'pastudio_invalid', 'Chemin de session inattendu.');
      if (seen.has(expected)) throw fail(422, 'pastudio_invalid', 'Session en double.');
      seen.add(expected);
      const buf = filesMap.get(expected);
      if (!buf) throw fail(422, 'pastudio_invalid', `Session manquante : ${expected}.`);
      if (typeof s.sha256 !== 'string' || !HEX64_RE.test(s.sha256) || sha256Hex(buf) !== s.sha256)
        throw fail(422, 'pastudio_invalid', `Empreinte de session invalide : ${expected}.`);
      if (s.bytes !== buf.length) throw fail(422, 'pastudio_invalid', `Taille de session incohérente : ${expected}.`);
    }
    const r = manifest.roadmap ?? null;
    if (r !== null) {
      if (!isRecord(r) || (r.file || 'roadmap.json') !== 'roadmap.json')
        throw fail(422, 'pastudio_invalid', 'Roadmap du manifest invalide.');
      const buf = filesMap.get('roadmap.json');
      if (!buf) throw fail(422, 'pastudio_invalid', 'roadmap.json manquant.');
      if (typeof r.sha256 !== 'string' || sha256Hex(buf) !== r.sha256)
        throw fail(422, 'pastudio_invalid', 'Empreinte roadmap invalide.');
    }
    return archiveId;
  }

  async function decodeAndValidate(buffer) {
    if (!Buffer.isBuffer(buffer)) throw fail(400, 'pastudio_invalid', 'Archive binaire requise.');
    if (!buffer.length) throw fail(400, 'pastudio_invalid', 'Archive vide.');
    if (buffer.length > PASTUDIO_COMPRESSED_MAX) throw fail(413, 'pastudio_too_large', 'Archive trop volumineuse (128 Mio maximum).');
    const { container, sessions } = await loadSiblings(injected);
    let files;
    try { files = await container.decodePastudio(buffer); }
    catch (e) { throw fail(e?.status || 422, e?.code || 'pastudio_invalid', e?.message || 'Archive illisible.'); }
    if (!(files instanceof Map) || !files.has('manifest.json'))
      throw fail(422, 'pastudio_invalid', 'Manifest manquant.');
    let manifest;
    try { manifest = JSON.parse(files.get('manifest.json').toString('utf8')); }
    catch { throw fail(422, 'pastudio_invalid', 'Manifest illisible.'); }
    const archiveId = validateManifestShape(manifest, files);
    // Validate every JSONL strictly (no silent skips; torn tails fail closed).
    for (const s of manifest.sessions) {
      const buf = files.get(s.file);
      try {
        const checked = sessions.validateSessionBytes
          ? sessions.validateSessionBytes(buf)
          : fallbackValidateSession(buf);
        if (checked.id !== s.oldSessionId)
          throw fail(422, 'pastudio_invalid', `Identifiant incohérent : ${s.file}.`);
      } catch (e) {
        if (e?.status) throw e;
        throw fail(422, 'pastudio_invalid', `Session illisible : ${s.file}.`);
      }
    }
    // Validate roadmap.json as a full raw document (COMPLETE plans/backlog/journal).
    let roadmapDoc = null;
    if (files.has('roadmap.json')) {
      try {
        const raw = JSON.parse(files.get('roadmap.json').toString('utf8'));
        const { validateRoadmapDocument } = await import('./roadmap.mjs');
        roadmapDoc = validateRoadmapDocument(raw);
      } catch (e) {
        if (e?.status) throw e;
        throw fail(422, 'pastudio_invalid', 'roadmap.json invalide.');
      }
    }
    const payloadDigest = computePayloadDigest(files, manifest, container.digestPastudioFiles);
    return { files, manifest, archiveId, roadmapDoc, payloadDigest, container, sessions };
  }

  function fallbackValidateSession(buf) {
    const text = buf.toString('utf8');
    if (!text.endsWith('\n')) throw fail(422, 'pastudio_invalid', 'Session tronquée.');
    const lines = text.split('\n');
    let id = null;
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { throw fail(422, 'pastudio_invalid', 'Session illisible.'); }
      if (i === 0) {
        if (entry?.type !== 'session' || !validId(entry.id)) throw fail(422, 'pastudio_invalid', 'En-tête de session invalide.');
        id = entry.id;
      }
    }
    if (!id) throw fail(422, 'pastudio_invalid', 'Session vide.');
    return { id, lines: lines.length - 1 };
  }

  function buildCounts(manifest, filesMap, roadmapDoc) {
    let messages = 0;
    for (const s of manifest.sessions) messages += countMessagesInBytes(filesMap.get(s.file)).messages;
    const rc = roadmapCounts(roadmapDoc);
    const childSessions = manifest.sessions.filter((s) => !s.root).length;
    return {
      sessions: manifest.sessions.filter((s) => s.root).length,
      childSessions,
      messages,
      roadmapPlans: rc.plans,
      roadmapSteps: rc.steps,
      backlogItems: rc.backlogItems,
      backlogNotes: rc.backlogNotes,
      journalEntries: rc.journalEntries,
      milestones: rc.milestones,
    };
  }

  // Read-only preflight: can this process register native child lineage?
  // Construction/import only, zero ledger operations, zero file writes.
  // Override via options.lineageSupported for isolated checks.
  const lineageSupportedOverride = options.lineageSupported;
  async function lineageSupported() {
    if (typeof lineageSupportedOverride === 'function') return !!(await lineageSupportedOverride());
    try {
      const { discoverCli } = await import('./agent.mjs');
      const cli = discoverCli();
      if (!cli?.packageDir) return false;
      await import(pathToFileURL(join(cli.packageDir, 'dist/modes/daemon/rlm-ledger.js')).href);
      return true;
    } catch { return false; }
  }

  async function pendingLineageFor(payloadDigest) {
    const records = await pendingList();
    return records.some((rec) => isRecord(rec) && rec.payloadDigest === payloadDigest && (rec.ledgerEdges?.length || rec.marksPending));
  }

  async function exportArchive(cwd) {
    guardSlot();
    try {
      await recoverPending();
      const project = await store.knowledgeProject(cwd);
      const { container, sessions } = await loadSiblings(injected);
      // Hide uncommitted pending IDs from this export.
      const pending = await pendingList();
      const hidden = new Set();
      for (const rec of pending) {
        try { if (rec.destCwd && cwdKey(rec.destCwd) === cwdKey(project.cwd)) for (const id of rec.newIds || []) hidden.add(id); } catch {}
      }
      let collected;
      try {
        collected = await sessions.collectProjectSessions({
          store, sessionDir, agentHome, cwd: project.cwd, readEdges: injected.readEdges,
        });
      } catch (e) {
        const msg = String(e?.message || '');
        if (e?.code === 'torn_tail' || /torn|truncat/i.test(msg))
          throw fail(409, 'pastudio_snapshot_conflict', 'Une conversation est en cours d’écriture. Réessayez quand la session est au repos.');
        throw fail(e?.status || 500, e?.code || 'pastudio_collect_failed', e?.message || 'Collecte impossible.');
      }
      const roots = (collected.roots || []).filter((r) => !hidden.has(r.oldSessionId));
      const children = (collected.children || []).filter((c) => !hidden.has(c.oldSessionId));
      // Full raw roadmap (COMPLETE, not link-filtered).
      let roadmapDoc = null;
      try { roadmapDoc = await roadmap.readRaw(project.cwd); }
      catch { roadmapDoc = null; }
      const roadmapText = roadmapDoc ? Buffer.from(JSON.stringify(roadmapDoc, null, 2) + '\n', 'utf8') : null;
      const rc = roadmapCounts(roadmapDoc);
      const hasRoadmapContent = !!(roadmapText && (rc.plans || rc.backlogItems || rc.backlogNotes || rc.milestones || rc.journalEntries || (roadmapDoc?.overview?.vision || '')));
      const entries = [];
      const manifestSessions = [];
      const allSessions = [
        ...roots.map((r) => ({ ...r, root: true })),
        ...children.map((c) => ({ ...c, root: false })),
      ];
      for (const s of allSessions) {
        const name = `sessions/${s.oldSessionId}.jsonl`;
        entries.push({ name, data: s.data });
        manifestSessions.push({
          oldSessionId: s.oldSessionId,
          file: name,
          root: s.root,
          rootOldSessionId: s.rootOldSessionId || (s.root ? s.oldSessionId : null),
          agentId: s.agentId || null,
          parentAgentId: s.parentAgentId || null,
          parentOldSessionId: s.parentOldSessionId || null,
          depth: s.depth ?? (s.root ? 0 : 1),
          sha256: sha256Hex(s.data),
          bytes: s.data.length,
          lines: s.lines,
          snapshotTruncatedTail: false,
        });
      }
      if (roadmapText && hasRoadmapContent) entries.push({ name: 'roadmap.json', data: roadmapText });
      let messages = 0;
      for (const s of allSessions) messages += countMessagesInBytes(s.data).messages;
      const manifest = {
        format: PASTUDIO_FORMAT,
        version: PASTUDIO_VERSION,
        archiveId: randomUUID(),
        createdAt: new Date(now()).toISOString(),
        sourceProject: { name: project.name || basename(project.cwd), cwd: project.cwd },
        nativeVersion: PASTUDIO_NATIVE_VERSION,
        sessions: manifestSessions.sort((a, b) => (a.oldSessionId < b.oldSessionId ? -1 : 1)),
        roadmap: roadmapText && hasRoadmapContent
          ? {
              file: 'roadmap.json', sha256: sha256Hex(roadmapText), bytes: roadmapText.length,
              plans: rc.plans, steps: rc.steps, milestones: rc.milestones,
              backlogItems: rc.backlogItems, backlogNotes: rc.backlogNotes, journalEntries: rc.journalEntries,
            }
          : null,
        counts: {
          sessions: roots.length, childSessions: children.length, messages,
          roadmapPlans: rc.plans, roadmapSteps: rc.steps, backlogItems: rc.backlogItems,
          backlogNotes: rc.backlogNotes, journalEntries: rc.journalEntries, milestones: rc.milestones,
        },
        warnings: ['additive', 'no-overwrite', 'secret-in-history'],
      };
      entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') });
      let buffer;
      try { buffer = await container.encodePastudio(entries); }
      catch (e) {
        // Preserve the container's specific code/message (duplicate, too_large,
        // unsafe_name, ...). Previous generic encode failure hid the real cause.
        // Generic bounded detail only (no hardcoded FR/EN sentence): the
        // existing archives.* translation map owns user wording; the server
        // keeps machine code + numbers. Container messages carry only
        // filenames/sizes, never history contents.
        const code = typeof e?.code === 'string' && e.code.startsWith('pastudio_') ? e.code : 'pastudio_encode_failed';
        const raw = typeof e?.message === 'string' ? e.message.slice(0, 300) : '';
        if (code === 'pastudio_too_large' || code === 'pastudio_too_many_entries') {
          let total = 0;
          try { for (const en of entries) total += en.data?.length ?? 0; } catch {}
          const msg = (`pastudio: encode failed (${total} bytes in, 128 MiB compressed limit).` + (raw ? ` ${raw}` : '')).slice(0, 500);
          throw fail(413, code, msg);
        }
        if (code !== 'pastudio_encode_failed') throw fail(422, code, (`pastudio: encode failed [${code}].` + (raw ? ` ${raw}` : '')).slice(0, 500));
        throw fail(500, code, (`pastudio: encode failed.` + (raw ? ` ${raw}` : '')).slice(0, 500));
      }
      if (buffer.length > PASTUDIO_COMPRESSED_MAX) throw fail(413, 'pastudio_too_large', 'Archive trop volumineuse.');
      const filesMap = new Map(entries.map((e) => [e.name, Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)]));
      const payloadDigest = computePayloadDigest(filesMap, manifest, container.digestPastudioFiles);
      return { buffer, archiveId: manifest.archiveId, payloadDigest, manifest, counts: manifest.counts };
    } finally { releaseSlot(); }
  }

  async function previewArchive(buffer, destCwd) {
    guardSlot();
    try {
      purgeTokens();
      await recoverPending();
      const dest = await store.knowledgeProject(destCwd);
      const decoded = await decodeAndValidate(buffer);
      const counts = buildCounts(decoded.manifest, decoded.files, decoded.roadmapDoc);
      if (!decoded.manifest.sessions.length && !counts.roadmapPlans && !counts.backlogItems && !counts.backlogNotes)
        throw fail(422, 'pastudio_empty', 'Rien à importer dans cette archive.');
      // Pending takes precedence over duplicate: a prior import still finalizing
      // (marks/lineage replay pending) is reported as pending, never as completed.
      const pendRecs = (await pendingList()).filter(
        (rec) => isRecord(rec) && rec.payloadDigest === decoded.payloadDigest && rec.destCwd && cwdKey(rec.destCwd) === cwdKey(dest.cwd),
      );
      if (pendRecs.length)
        return {
          duplicate: false, pending: true, pendingFinalization: true,
          marksPending: pendRecs.some((r) => r.marksPending),
          lineagePending: pendRecs.some((r) => Array.isArray(r.ledgerEdges) && r.ledgerEdges.length > 0),
          archiveChanged: false, archiveId: decoded.archiveId,
          payloadDigest: decoded.payloadDigest, destCwd: dest.cwd,
          sourceProject: decoded.manifest.sourceProject, counts,
          warnings: ['additive', 'no-overwrite', 'secret-in-history'],
          previewToken: null, expiresAt: null,
        };
      const dto = await roadmap.read(dest.cwd).catch(() => ({ pastudioImports: [] }));
      const imports = dto.pastudioImports || [];
      if (imports.some((e) => e.payloadDigest === decoded.payloadDigest))
        return {
          duplicate: true, pending: false, pendingFinalization: false, marksPending: false, lineagePending: false,
          archiveChanged: false, archiveId: decoded.archiveId,
          payloadDigest: decoded.payloadDigest, destCwd: dest.cwd,
          sourceProject: decoded.manifest.sourceProject, counts,
          warnings: ['additive', 'no-overwrite', 'secret-in-history'],
          previewToken: null, expiresAt: null,
        };
      if (imports.some((e) => e.archiveId === decoded.archiveId))
        throw fail(409, 'pastudio_archive_changed', 'Cette archive a déjà été importée avec un contenu différent.');
      // Pre-check roadmap limits without writing.
      const inDoc = decoded.roadmapDoc;
      if (inDoc) {
        if ((dto.plans || []).length + inDoc.plans.length > 200)
          throw fail(409, 'pastudio_limits', 'Trop de plans après import (maximum 200).');
        if ((dto.overview?.milestones || []).length + (inDoc.overview?.milestones || []).length > 200)
          throw fail(409, 'pastudio_limits', 'Trop de jalons après import (maximum 200).');
        const destItems = (dto.backlog?.items || []).length, destNotes = (dto.backlog?.notes || []).length;
        if (destItems + (inDoc.backlog?.items || []).length > 2000 || destNotes + (inDoc.backlog?.notes || []).length + (inDoc.overview?.vision ? 1 : 0) > 2000)
          throw fail(409, 'pastudio_limits', 'Backlog trop volumineux après import.');
      }
      const previewToken = randomUUID();
      tokens.set(previewToken, {
        payloadDigest: decoded.payloadDigest, archiveId: decoded.archiveId,
        destKey: cwdKey(dest.cwd), destCwd: dest.cwd, expiresAt: now() + PASTUDIO_TOKEN_TTL_MS,
      });
      return {
        duplicate: false, archiveChanged: false, archiveId: decoded.archiveId,
        payloadDigest: decoded.payloadDigest, destCwd: dest.cwd,
        sourceProject: decoded.manifest.sourceProject, counts,
        warnings: ['additive', 'no-overwrite', 'secret-in-history'],
        previewToken, expiresAt: new Date(now() + PASTUDIO_TOKEN_TTL_MS).toISOString(),
      };
    } finally { releaseSlot(); }
  }

  async function importArchive(buffer, destCwd, previewToken) {
    guardSlot();
    const importId = randomUUID();
    let writtenFiles = [];
    let plan = null;
    let decoded = null;
    try {
      purgeTokens();
      await recoverPending();
      if (!previewToken || typeof previewToken !== 'string')
        throw fail(409, 'pastudio_preview_required', 'Aperçu requis avant import.');
      const slot = tokens.get(previewToken);
      if (!slot || slot.expiresAt <= now())
        throw fail(409, 'pastudio_preview_expired', 'Aperçu expiré. Relancez l’aperçu puis confirmez.');
      const dest = await store.knowledgeProject(destCwd);
      if (cwdKey(dest.cwd) !== slot.destKey)
        throw fail(409, 'pastudio_preview_mismatch', 'Destination différente de l’aperçu.');
      decoded = await decodeAndValidate(buffer);
      if (decoded.payloadDigest !== slot.payloadDigest || decoded.archiveId !== slot.archiveId)
        throw fail(409, 'pastudio_preview_mismatch', 'Archive différente de l’aperçu.');
      // Pending takes precedence over duplicate: recoverPending already ran at
      // entry; a surviving record means replay failed — report 409 pending, never
      // a completed duplicate.
      const pendRecs = (await pendingList()).filter(
        (rec) => isRecord(rec) && rec.payloadDigest === decoded.payloadDigest && rec.destCwd && cwdKey(rec.destCwd) === cwdKey(dest.cwd),
      );
      if (pendRecs.length)
        throw fail(409, 'pastudio_import_pending', 'Import précédent en cours de finalisation. Relancez l’aperçu : la reprise est automatique, sans doublon.', {
          recoverable: true, pending: true, pendingFinalization: true,
          marksPending: pendRecs.some((r) => r.marksPending),
          lineagePending: pendRecs.some((r) => Array.isArray(r.ledgerEdges) && r.ledgerEdges.length > 0),
          archiveId: decoded.archiveId, payloadDigest: decoded.payloadDigest,
          destinationCwd: dest.cwd,
        });
      // Dedup inside service is authoritative, but fast-path here avoids useless remap.
      const dto = await roadmap.read(dest.cwd).catch(() => ({ pastudioImports: [] }));
      const imports = dto.pastudioImports || [];
      if (imports.some((e) => e.payloadDigest === decoded.payloadDigest)) {
        tokens.delete(previewToken);
        const counts = buildCounts(decoded.manifest, decoded.files, decoded.roadmapDoc);
        return { duplicate: true, pending: false, pendingFinalization: await pendingLineageFor(decoded.payloadDigest), archiveId: decoded.archiveId, payloadDigest: decoded.payloadDigest, destinationCwd: dest.cwd, imported: counts, idMap: {}, nextStep: 'done', warnings: ['additive', 'no-overwrite', 'secret-in-history'], lineagePending: await pendingLineageFor(decoded.payloadDigest) };
      }
      if (imports.some((e) => e.archiveId === decoded.archiveId))
        throw fail(409, 'pastudio_archive_changed', 'Cette archive a déjà été importée avec un contenu différent.');
      const { sessions } = decoded;
      // Build collected shape from archive (authoritative manifest + validated bytes).
      const byId = new Map(decoded.manifest.sessions.map((s) => [s.oldSessionId, s]));
      const roots = [], children = [];
      for (const s of decoded.manifest.sessions) {
        const data = decoded.files.get(s.file);
        if (s.root) roots.push({ oldSessionId: s.oldSessionId, file: s.file, bytes: data.length, lines: s.lines, data });
        else children.push({
          oldSessionId: s.oldSessionId, rootOldSessionId: s.rootOldSessionId, agentId: s.agentId || `sub-${s.oldSessionId.slice(0, 8)}`,
          parentAgentId: s.parentAgentId || null, parentOldSessionId: s.parentOldSessionId || null,
          depth: s.depth ?? 1, file: s.file, bytes: data.length, lines: s.lines, data,
        });
      }
      const edges = children.map((c) => ({
        childOldSessionId: c.oldSessionId, parentOldSessionId: c.parentOldSessionId || c.rootOldSessionId,
        parentFile: null, childAgentId: c.agentId, depth: c.depth, name: c.oldSessionId.slice(0, 64),
      }));
      const collected = { roots, children, edges };
      plan = sessions.planSessionRemap
        ? sessions.planSessionRemap(collected, dest.cwd)
        : fallbackPlanRemap(collected, dest.cwd);
      const idMap = plan.idMap;
      // Remap bytes + resolve final files.
      const newFiles = [];
      const blobsByOld = new Map();
      for (const r of roots) {
        const newId = idMap.get(r.oldSessionId);
        const data = decoded.files.get(`sessions/${r.oldSessionId}.jsonl`);
        const remapped = sessions.remapSessionBytes
          ? sessions.remapSessionBytes(data, { idMap, destCwd: dest.cwd, newId })
          : fallbackRemap(data, r.oldSessionId, newId, dest.cwd);
        const destFile = join(resolve(sessionDir), `${newId}.jsonl`);
        newFiles.push({ oldSessionId: r.oldSessionId, newSessionId: newId, kind: 'root', destFile, data: remapped });
        blobsByOld.set(r.oldSessionId, remapped);
      }
      const childPlan = plan.childPathPlan || [];
      for (const item of childPlan) {
        const src = children.find((c) => c.oldSessionId === item.oldSessionId);
        if (!src) throw fail(422, 'pastudio_invalid', 'Enfant introuvable.');
        const newRootId = idMap.get(src.rootOldSessionId);
        const destFile = join(resolve(agentHome), 'session-artifacts', newRootId, `sub-${item.newAgentId}`, `${item.newSessionId}.jsonl`);
        const data = decoded.files.get(`sessions/${src.oldSessionId}.jsonl`);
        const remapped = sessions.remapSessionBytes
          ? sessions.remapSessionBytes(data, { idMap, destCwd: dest.cwd, newId: item.newSessionId, newDepth: src.depth ?? 1 })
          : fallbackRemap(data, src.oldSessionId, item.newSessionId, dest.cwd);
        newFiles.push({ oldSessionId: src.oldSessionId, newSessionId: item.newSessionId, kind: 'child', destFile, data: remapped, newAgentId: item.newAgentId, newRootId, depth: src.depth ?? 1 });
      }
      // Pending journal BEFORE any live write (crash recovery).
      const ledgerEdges = newFiles
        .filter((f) => f.kind === 'child')
        .map((f) => ({
          childId: f.newAgentId, parent: join(resolve(sessionDir), `${idMap.get(byId.get(f.oldSessionId)?.rootOldSessionId || '') || f.newRootId}.jsonl`),
          child: f.destFile, depth: f.depth || 1, name: (byId.get(f.oldSessionId)?.oldSessionId || f.newSessionId).slice(0, 64),
        }));
      // Preflight (native proof): a family with children is only committable
      // if native lineage registration is supported. Authoritative check is the
      // sibling preflightImportLedger; local native-import probe is fallback.
      // Fail closed BEFORE any live write — never commit sessions+roadmap that
      // would stay invisible to the family view.
      if (ledgerEdges.length) {
        if (typeof lineageSupportedOverride === 'function') {
          if (!(await lineageSupportedOverride()))
            throw fail(503, 'pastudio_lineage_unavailable', 'L’enregistrement des conversations enfants est indisponible. Import annulé avant toute écriture.');
        } else if (typeof sessions.preflightImportLedger === 'function') {
          try {
            await sessions.preflightImportLedger({ agentHome, sessionDir, hasChildren: true });
          } catch (e) {
            throw fail(503, 'pastudio_lineage_unavailable', e?.message || 'L’enregistrement des conversations enfants est indisponible. Import annulé avant toute écriture.');
          }
        } else if (!(await lineageSupported())) {
          throw fail(503, 'pastudio_lineage_unavailable', 'L’enregistrement des conversations enfants est indisponible. Import annulé avant toute écriture.');
        }
      }
      // Source historical models (roots + resumable children, evidence
      // preserved verbatim). No credentials or subagent global defaults read.
      const sourceModels = {};
      for (const f of newFiles) {
        const extracted = extractSourceModelFromBytes(f.data);
        if (extracted) sourceModels[f.newSessionId] = extracted;
      }
      const rootIds = newFiles.filter((f) => f.kind === 'root').map((f) => f.newSessionId);
      const allModelIds = newFiles.map((f) => f.newSessionId);
      const pending = {
        importId, destCwd: dest.cwd, archiveId: decoded.archiveId, payloadDigest: decoded.payloadDigest,
        newIds: newFiles.map((f) => f.newSessionId), newFiles: newFiles.map((f) => ({ newSessionId: f.newSessionId, destFile: f.destFile })),
        ledgerEdges, marksPending: true, createdAt: now(),
        rootIds, allModelIds, sourceModels,
      };
      await writePending(pending);
      // Live writes: hardened wx-only, never overwrite (see safeWriteImportFile).
      writtenFiles = [];
      for (const f of newFiles) {
        await safeWriteImportFile(f.destFile, f.data);
        writtenFiles.push(f);
      }
      // Roadmap atomic append (single lock/revision, marker included).
      const inDoc = decoded.roadmapDoc;
      let remappedDoc = inDoc;
      if (inDoc && sessions.remapRoadmapSessionRefs) {
        try { remappedDoc = sessions.remapRoadmapSessionRefs(inDoc, idMap).document; } catch { remappedDoc = inDoc; }
      } else if (inDoc) remappedDoc = fallbackRemapRoadmapRefs(inDoc, idMap);
      const milestoneIndex = new Map((remappedDoc?.overview?.milestones || []).map((m, i) => [m.id, i]));
      const payload = {
        marker: { archiveId: decoded.archiveId, payloadDigest: decoded.payloadDigest, sourceProject: decoded.manifest.sourceProject },
        milestones: (remappedDoc?.overview?.milestones || []).map((m) => ({ title: m.title, summary: m.summary, status: m.status })),
        plans: (remappedDoc?.plans || []).map((p) => ({
          title: p.title, summary: p.summary, status: p.status,
          milestoneIndex: p.milestone == null ? null : (milestoneIndex.has(p.milestone) ? milestoneIndex.get(p.milestone) : null),
          sessions: p.sessions || [],
          steps: stripStepIds(p.steps || []),
          journal: (p.journal || []).map((j) => ({ at: j.at, text: j.text, by: j.by, sessionId: j.sessionId, rootSessionId: j.rootSessionId, name: j.name })),
        })),
        backlogItems: (remappedDoc?.backlog?.items || []).map((e) => ({ text: e.text, note: e.note })),
        backlogNotes: (remappedDoc?.backlog?.notes || []).map((e) => ({ text: e.text, note: e.note })),
        visionNoteText: remappedDoc?.overview?.vision || '',
      };
      let roadResult;
      try { roadResult = await roadmap.importPastudio(dest.cwd, payload, { by: 'user' }); }
      catch (e) {
        // Rollback exactly our files (hardened verify); never touch local files.
        for (const f of writtenFiles) await safeRemoveImportFile(f.destFile, f.newSessionId);
        await clearPending(importId);
        throw e;
      }
      if (roadResult?.duplicate) {
        for (const f of writtenFiles) await safeRemoveImportFile(f.destFile, f.newSessionId);
        await clearPending(importId);
        tokens.delete(previewToken);
        const counts = buildCounts(decoded.manifest, decoded.files, decoded.roadmapDoc);
        return { duplicate: true, archiveId: decoded.archiveId, payloadDigest: decoded.payloadDigest, destinationCwd: dest.cwd, imported: counts, idMap: {}, nextStep: 'done', warnings: ['additive', 'no-overwrite', 'secret-in-history'] };
      }
      // Post-commit: marks + native lineage must BOTH be durable before success.
      // A family with unregistered children must never report success while its
      // children stay invisible: failures keep the pending journal and return an
      // explicit incomplete (recoverable) status, never success.
      // Pending storage integrity is never bypassed: model finalization runs
      // only after marks+lineage durability is known, and failures keep the
      // pending journal (retry replays, never duplicates).
      const newIds = newFiles.map((f) => f.newSessionId);
      let marksOk = false, lineageOk = true;
      try {
        await store.markPastudioImported?.(newIds, { archiveId: decoded.archiveId, importedAt: now() });
        marksOk = true;
      } catch { marksOk = false; }
      try {
        if (ledgerEdges.length && sessions.registerImportedLineage)
          await sessions.registerImportedLineage({ agentHome, sessionDir, edges: ledgerEdges, journalPath: lineageJournalPath(importId) });
      } catch { lineageOk = false; }
      // Destination effective-model finalization (roots only, best-effort but
      // awaited before success so the first run needs no explicit pick when a
      // usable model exists). History stays verbatim; receipts init once via
      // store.all() on next overview/history (missing only, never overwrite).
      let modelOutcomes = {};
      if (marksOk && lineageOk && typeof getCatalog === 'function') {
        try {
          const catalog = await getCatalog().catch(() => null);
          modelOutcomes = await finalizeImportedModels(allModelIds, sourceModels, catalog);
        } catch { modelOutcomes = {}; }
      }
      const needsModelChoice = allModelIds.some((id) => !modelOutcomes[id]?.model);
      const warnings = needsModelChoice
        ? ['additive', 'no-overwrite', 'secret-in-history', 'needs-model-choice']
        : ['additive', 'no-overwrite', 'secret-in-history'];
      const counts = buildCounts(decoded.manifest, decoded.files, decoded.roadmapDoc);
      const idMapObj = {};
      for (const [k, v] of idMap.entries()) idMapObj[k] = v;
      tokens.delete(previewToken);
      if (marksOk && lineageOk) {
        await clearPending(importId);
        return {
          duplicate: false, pending: false, pendingFinalization: false,
          archiveId: decoded.archiveId, payloadDigest: decoded.payloadDigest,
          destinationCwd: dest.cwd, imported: counts, idMap: idMapObj,
          nextStep: needsModelChoice ? 'choose-model' : 'done', warnings,
          ...(needsModelChoice ? {} : { effectiveModels: Object.fromEntries(Object.entries(modelOutcomes).map(([k, v]) => [k, v.model])) }),
        };
      }
      // Committed but not finalizable right now: sessions+roadmap ARE stored
      // (marker present). This is NOT success: explicit 409 import_pending,
      // recoverable — the next preview/import retry runs recoverPending first
      // (replays marks+lineage, never duplicates) and then reports accurately.
      // The pending journal is kept; the token stays consumed (retry = re-preview).
      throw fail(409, 'pastudio_import_pending', 'Import enregistré mais finalisation en attente. Relancez l’aperçu : la reprise est automatique, sans doublon.', {
        recoverable: true, pending: true, pendingFinalization: true,
        marksPending: !marksOk, lineagePending: !lineageOk,
        archiveId: decoded.archiveId, payloadDigest: decoded.payloadDigest,
        destinationCwd: dest.cwd,
      });
    } catch (e) {
      // Pre-commit failures only: remove files we just created (hardened).
      // A committed marker (or an ambiguous read) keeps files+pending for recovery.
      if (decoded && writtenFiles.length && e?.code !== 'pastudio_import_pending') {
        let committed = true, ambiguous = true;
        try {
          const dto = await roadmap.read(destCwd);
          committed = (dto?.pastudioImports || []).some((x) => x.payloadDigest === decoded.payloadDigest);
          ambiguous = false;
        } catch (readErr) {
          if (readErr?.status === 404 || readErr?.code === 'roadmap_uninitialized' || readErr?.code === 'roadmap_missing') { committed = false; ambiguous = false; }
        }
        if (!ambiguous && !committed)
          for (const f of writtenFiles) await safeRemoveImportFile(f.destFile, f.newSessionId);
      }
      throw e;
    } finally { releaseSlot(); }
  }

  function stripStepIds(steps) {
    return (steps || []).map((s) => ({ text: s.text, note: s.note, done: !!s.done, children: stripStepIds(s.children || []) }));
  }
  function fallbackPlanRemap(collected, destCwd) {
    const allOld = [...collected.roots.map((r) => r.oldSessionId), ...collected.children.map((c) => c.oldSessionId)];
    const idMap = new Map();
    for (const id of allOld) { let fresh = randomUUID(); while ([...idMap.values()].includes(fresh) || allOld.includes(fresh)) fresh = randomUUID(); idMap.set(id, fresh); }
    return { idMap, rootMap: new Map(collected.roots.map((r) => [r.oldSessionId, idMap.get(r.oldSessionId)])), childPathPlan: collected.children.map((c) => ({ oldSessionId: c.oldSessionId, newSessionId: idMap.get(c.oldSessionId), newRootId: idMap.get(c.rootOldSessionId), newAgentId: `sub-${randomUUID().slice(0, 8)}`, oldAgentId: c.agentId, depth: c.depth ?? 1, destFile: null })), destCwd };
  }
  function fallbackRemap(data, oldId, newId, destCwd) {
    const text = data.toString('utf8');
    const lines = text.split('\n');
    const header = JSON.parse(lines[0]);
    header.id = newId; header.cwd = resolve(destCwd);
    delete header.git;
    delete header.parentSession;
    lines[0] = JSON.stringify(header);
    return Buffer.from(lines.join('\n'), 'utf8');
  }
  function fallbackRemapRoadmapRefs(doc, idMap) {
    const clone = JSON.parse(JSON.stringify(doc));
    const remap = (id) => (typeof id === 'string' && idMap.has(id) ? idMap.get(id) : id);
    for (const p of clone.plans || []) {
      if (Array.isArray(p.sessions)) p.sessions = p.sessions.map(remap);
      for (const j of p.journal || []) { if (j.sessionId) j.sessionId = remap(j.sessionId); if (j.rootSessionId) j.rootSessionId = remap(j.rootSessionId); }
    }
    for (const g of ['items', 'notes']) for (const e of clone.backlog?.[g] || []) {
      if (Array.isArray(e.sessions)) e.sessions = e.sessions.map(remap);
      if (e.sessionId) e.sessionId = remap(e.sessionId);
    }
    return clone;
  }

  // Model gate (auto-effective, no mandatory manual pick).
  // Integrity first: store flag OR pending-journal membership gates; total read
  // failure is unknown (caller fails closed, never bypasses pending storage).
  // Then effective-model resolution: an explicit usable pick still validates
  // and persists; otherwise a stored effective (generationSettings), historical
  // (history.model evidence), or destination default allows the run without an
  // explicit body.model. Only when no configured+usable model exists is an
  // explicit choice required (preserved warning, no silent paid substitution
  // beyond the authorized destination default). Availability requires provider
  // configured AND model supported (see isCatalogModelUsable).
  function decidePastudioGate({ needs = false, storeFailed = false, pendingHas = false, pendingFailed = false } = {}) {
    if (needs || pendingHas) return { gated: true };
    if (storeFailed || pendingFailed) return { unknown: true };
    return { gated: false };
  }
  async function checkPastudioModelGate(sessionId, explicitModelId, catalog) {
    let needs = false, storeFailed = false, pendingIds = null, pendingFailed = false;
    try {
      needs = typeof store.pastudioNeedsModel === 'function'
        ? store.pastudioNeedsModel(sessionId)
        : !!store?.sessions?.[sessionId]?.pastudioNeedsModel;
      // New imports set needs=false but keep pastudioImported; treat any
      // imported session as gated-candidate so the effective check below runs.
      // History lookup is the source of truth for imported (not just the flag).
      if (!needs && validId(sessionId || '') && typeof store.history === 'function') {
        try {
          const probe = await store.history(sessionId).catch(() => null);
          if (probe?.pastudioImported === true) needs = true;
        } catch { /* history failure is not integrity failure here; pending check still guards */ }
      }
    } catch { storeFailed = true; }
    if (validId(sessionId || '')) {
      try {
        const records = await pendingList();
        pendingIds = new Set(records.flatMap((rec) => (isRecord(rec) && Array.isArray(rec.newIds) ? rec.newIds : [])));
      } catch { pendingFailed = true; }
    }
    const decision = decidePastudioGate({ needs, storeFailed, pendingHas: !!pendingIds?.has(sessionId), pendingFailed });
    if (decision.unknown)
      throw fail(503, 'pastudio_gate_unknown', 'État d’import indéterminé. Réessayez dans un instant.');
    if (!decision.gated) return { gated: false };
    // Session record once (stored effective + verbatim historical evidence).
    let sessionRecord = null;
    try { sessionRecord = validId(sessionId || '') && typeof store.history === 'function' ? await store.history(sessionId).catch(() => null) : null; }
    catch { sessionRecord = null; }
    const stored = typeof sessionRecord?.generationSettings?.model === 'string' ? sessionRecord.generationSettings.model : null;
    const historical = typeof sessionRecord?.model === 'string' ? sessionRecord.model : null;
    const def = typeof catalog?.default?.model === 'string' ? catalog.default.model : null;
    const storedUsable = stored && isCatalogModelUsable(catalog, stored) ? stored : null;
    const historicalUsable = historical && isCatalogModelUsable(catalog, historical) ? historical : null;
    const defaultUsable = def && isCatalogModelUsable(catalog, def) ? def : null;
    const fallbackUsable = storedUsable || historicalUsable || defaultUsable;
    const explicit = typeof explicitModelId === 'string' ? explicitModelId.trim() : '';
    if (explicit) {
      if (isCatalogModelUsable(catalog, explicit)) return { gated: true, model: explicit, source: 'explicit' };
      // Defensive echo resolution for imported restores: the client always
      // echoes a model (selector restore), so a stale echo equal to the
      // verbatim historical model must not 409 when a usable stored/default
      // fallback exists. A true explicit unavailable pick (not equal to
      // historical) still throws a clear error and never overwrites a valid choice.
      if (historical && explicit === historical && fallbackUsable) return { gated: false, model: fallbackUsable, source: storedUsable ? 'stored-effective' : (historicalUsable ? 'historical' : 'default') };
      throw fail(409, 'pastudio_needs_model', 'Modèle choisi indisponible ou non configuré.');
    }
    // No explicit pick: allow when a stored/historical/default effective model
    // is configured+usable. Never bypass pending integrity (already checked).
    if (storedUsable) return { gated: false, model: storedUsable, source: 'stored-effective' };
    if (historicalUsable) return { gated: false, model: historicalUsable, source: 'historical' };
    if (defaultUsable) return { gated: false, model: defaultUsable, source: 'default' };
    throw fail(409, 'pastudio_needs_model', 'Aucun modèle utilisable configuré pour cette conversation importée. Choisissez un modèle disponible.');
  }

  return { exportArchive, previewArchive, importArchive, recoverPending, checkPastudioModelGate, decidePastudioGate, computePayloadDigest, canonicalTopologyJson, extractSourceModelFromBytes, isCatalogModelUsable, resolveEffectiveModel, isPastudioBadgeVisible };
}
