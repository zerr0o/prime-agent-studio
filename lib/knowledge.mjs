import { createHash, randomUUID } from 'node:crypto';
import {
  open,
  readFile,
  readdir,
  stat,
  lstat,
  realpath,
  mkdir,
  writeFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { HttpError, cwdKey, textOf, validId } from './store.mjs';
import { formatMessage as tr } from '../public/i18n-core.js';

const VERSION = 1;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_BODY = 64_000;
const MAX_SOURCES = 20_000;
const HARNESS_KINDS = ['memory', 'prompt', 'skill', 'subagent'];
const KINDS = ['history', ...HARNESS_KINDS, 'refinement'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const string = (value, max = MAX_BODY) => (typeof value === 'string' ? value.slice(0, max) : '');
const fold = (value) =>
  string(value, MAX_BODY * 2)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
const stamp = (value) => {
  const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const pointer = (value) => string(value, 300).replaceAll('~', '~0').replaceAll('/', '~1');

function selectedBranch(entries) {
  const nodes = new Map(entries.filter((e) => e.id && e.type !== 'session').map((e) => [e.id, e]));
  const last = entries.findLast((e) => e.id && e.type !== 'session' && Object.hasOwn(e, 'parentId'));
  if (!last) return entries;
  const branch = [],
    visited = new Set();
  let current = last;
  while (current && !visited.has(current.id)) {
    branch.push(current);
    visited.add(current.id);
    current = nodes.get(current.parentId);
  }
  return branch.reverse();
}

function snapshot(entry) {
  if (!object(entry)) return null;
  return {
    id: string(entry.id, 300),
    title: string(entry.title, 300),
    content: string(entry.content, 4096),
    truncated: typeof entry.content === 'string' && entry.content.length > 4096,
    version: Number.isFinite(entry.version) ? entry.version : null,
    date: stamp(entry.updated_at || entry.created_at),
  };
}

function refinement(data) {
  if (!object(data) || typeof data.id !== 'string' || !Array.isArray(data.appliedEdits)) return null;
  const scopes = new Set(
    data.appliedEdits.map((edit) => edit?.after?.scope || edit?.before?.scope).filter(Boolean),
  );
  return {
    id: string(data.id, 300),
    summary: string(data.summary, 1000),
    rationale: string(data.rationale),
    expectedOutcome: string(data.expectedOutcome),
    scope:
      data.scope === 'global' || (!data.scope && scopes.size === 1 && scopes.has('global'))
        ? 'global'
        : 'session',
    rollbackOf: string(data.rollbackOf, 300) || null,
    changesTruncated: data.appliedEdits.length > 50,
    changes: data.appliedEdits
      .slice(0, 50)
      .filter(object)
      .map((edit) => ({
        id: string(edit.id, 300),
        action: string(edit.action, 30),
        kind: string(edit.kind, 30),
        applied: edit.applied === true,
        reason: string(edit.reason, 2000),
        error: string(edit.error, 2000),
        before: snapshot(edit.before),
        after: snapshot(edit.after),
      })),
  };
}

// Only searchable native text and tree metadata are cached. Tool payloads, credentials,
// image data and model reasoning never enter this derived index.
function projectEntry(raw, line) {
  if (!object(raw)) return null;
  const entry = {
    type: string(raw.type, 60),
    id: string(raw.id, 300),
    line,
    timestamp: stamp(raw.timestamp),
  };
  if (Object.hasOwn(raw, 'parentId')) entry.parentId = string(raw.parentId, 300) || null;
  if (raw.type === 'session') {
    if (!validId(raw.id) || typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd)) return null;
    entry.cwd = resolve(raw.cwd);
  } else if (raw.type === 'session_info') entry.name = string(raw.name, 300);
  else if (raw.type === 'message' && ['user', 'assistant'].includes(raw.message?.role)) {
    entry.role = raw.message.role;
    entry.text = string(textOf(raw.message.content));
    entry.timestamp = stamp(raw.message.timestamp) || entry.timestamp;
    entry.truncated = textOf(raw.message.content).length > MAX_BODY;
  } else if (raw.type === 'custom_message' && raw.display) {
    entry.role = 'system';
    entry.text = string(textOf(raw.content));
  } else if (raw.type === 'custom' && raw.customType === 'prime-agent.refinement') {
    entry.refinement = refinement(raw.data);
  } else if (['compaction', 'branch_summary'].includes(raw.type)) {
    entry.role = 'system';
    entry.text = string(raw.summary);
  }
  return entry;
}

function brief(item, tokens = []) {
  const body = item.body || '';
  let start = 0;
  if (tokens.length) {
    const normalized = fold(body),
      found = tokens.map((token) => normalized.indexOf(token)).filter((i) => i >= 0);
    if (found.length) start = Math.max(0, Math.min(...found) - 80);
  }
  const excerpt = `${start ? '…' : ''}${body
    .slice(start, start + 360)
    .replace(/\s+/g, ' ')
    .trim()}${body.length > start + 360 ? '…' : ''}`;
  const { body: _body, changes: _changes, ...result } = item;
  return { ...result, excerpt };
}

/** Read-only native sources, with a disposable per-source cache in Studio's data directory. */
export function createKnowledge({
  store,
  dataDir,
  agentHome,
  sessionDir = join(agentHome, 'sessions'),
  sharedMemories = true,
}) {
  const sessionsRoot = resolve(sessionDir),
    homeRoot = resolve(agentHome);
  const artifactsRoot = resolve(dirname(sessionsRoot), 'session-artifacts');
  const derivedRoot = resolve(dataDir, 'knowledge-index', `v${VERSION}`);
  if ([sessionsRoot, homeRoot, artifactsRoot].some((root) => inside(root, derivedRoot)))
    throw new Error('Knowledge cache must be outside native Prime Agent sources');
  const cache = new Map(),
    headers = new Map(),
    flights = new Map();
  const counters = {
    bytesRead: 0,
    headerBytesRead: 0,
    fullReads: 0,
    appendReads: 0,
    cacheHits: 0,
    diskHits: 0,
  };
  let initialized,
    cacheUnavailable = false;

  async function safeFile(path, roots) {
    const candidate = resolve(path);
    for (const root of roots) {
      if (!inside(root, candidate)) continue;
      const [realRoot, realFile, info] = await Promise.all([
        realpath(root).catch(() => null),
        realpath(candidate).catch(() => null),
        lstat(candidate).catch(() => null),
      ]);
      if (realRoot && realFile && info?.isFile() && !info.isSymbolicLink() && inside(realRoot, realFile))
        return info;
    }
    return null;
  }

  async function prepareCache() {
    if (!initialized)
      initialized = (async () => {
        const nativeRoots = await Promise.all(
          [sessionsRoot, homeRoot, artifactsRoot].map((root) => realpath(root).catch(() => null)),
        );
        let ancestor = resolve(dataDir);
        while (!(await lstat(ancestor).catch(() => null))) {
          const parent = dirname(ancestor);
          if (parent === ancestor) throw new Error('Unavailable knowledge cache parent');
          ancestor = parent;
        }
        const realData = resolve(await realpath(ancestor), relative(ancestor, resolve(dataDir)));
        if (nativeRoots.some((root) => root && inside(root, realData)))
          throw new Error('Unsafe knowledge cache directory');
        await mkdir(resolve(dataDir), { recursive: true });
        // A junction in a derived directory must never redirect cache writes into native state.
        for (const path of [resolve(dataDir, 'knowledge-index'), derivedRoot]) {
          const info = await lstat(path).catch(() => null);
          if (info && (!info.isDirectory() || info.isSymbolicLink()))
            throw new Error('Unsafe knowledge cache directory');
          if (!info) await mkdir(path);
          if (!inside(realData, await realpath(path))) throw new Error('Unsafe knowledge cache directory');
        }
        return true;
      })().catch(() => {
        cacheUnavailable = true;
        return false;
      });
    return initialized;
  }

  async function loadCache(file) {
    if (cache.has(file)) return cache.get(file);
    if (!(await prepareCache())) return null;
    const path = join(derivedRoot, `${hash(file)}.json`);
    if (!(await safeFile(path, [derivedRoot]))) return null;
    try {
      const cached = JSON.parse(await readFile(path, 'utf8'));
      if (
        cached.version !== VERSION ||
        cached.file !== file ||
        !Array.isArray(cached.entries) ||
        !cached.entries.every(object) ||
        !Number.isSafeInteger(cached.offset) ||
        cached.offset < 0 ||
        !Number.isFinite(cached.size) ||
        !Number.isFinite(cached.mtime)
      )
        return null;
      cache.set(file, cached);
      counters.diskHits += 1;
      return cached;
    } catch {
      return null;
    }
  }

  async function saveCache(file, value) {
    cache.set(file, value);
    if (!(await prepareCache())) return;
    const path = join(derivedRoot, `${hash(file)}.json`),
      temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      await rename(temp, path);
    } catch {
      // The cache is disposable: antivirus locks or a read-only data directory must
      // not prevent consulting the authoritative native histories.
      cacheUnavailable = true;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  async function chunk(handle, position, size) {
    const buffer = Buffer.alloc(Math.max(0, size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    counters.bytesRead += bytesRead;
    return buffer.subarray(0, bytesRead);
  }

  async function readSession(file, projectCwd, warnings) {
    const roots = [sessionsRoot, artifactsRoot];
    const info = await safeFile(file, roots);
    if (!info) return null;
    if (info.size > MAX_SOURCE_BYTES) {
      warnings.add('source_too_large');
      return null;
    }
    let handle;
    try {
      let metadata = headers.get(file);
      if (!metadata || metadata.size !== info.size || metadata.mtime !== info.mtimeMs) {
        handle = await open(file, 'r');
        const first = await chunk(handle, 0, Math.min(info.size, 4096));
        counters.headerBytesRead += first.length;
        const newline = first.indexOf(10);
        let header;
        try {
          header = projectEntry(
            JSON.parse(first.subarray(0, newline < 0 ? first.length : newline).toString('utf8')),
            1,
          );
        } catch {
          return null;
        }
        if (header?.type !== 'session' || !header.cwd) return null;
        metadata = {
          header,
          size: info.size,
          mtime: info.mtimeMs,
          prefix: hash(first.subarray(0, Math.min(newline + 1, 4096))),
        };
        headers.set(file, metadata);
      }
      const { header, prefix } = metadata;
      // Establish membership from the small current native header before deserializing
      // any full disk cache. Fresh agent workers must not load other projects' histories.
      if (cwdKey(header.cwd) !== cwdKey(projectCwd)) return { ...metadata, entries: [] };
      const cached = await loadCache(file);
      if (cached && cached.size === info.size && cached.mtime === info.mtimeMs) {
        counters.cacheHits += 1;
        return cached;
      }
      handle ||= await open(file, 'r');
      let append =
        cached?.header?.id === header.id &&
        cached?.prefix === prefix &&
        cached.offset <= info.size &&
        cached.size < info.size &&
        cached.offset > 0;
      if (append) {
        const boundary = await chunk(handle, Math.max(0, cached.offset - 512), Math.min(512, cached.offset));
        append = hash(boundary) === cached.boundary;
      }
      const offset = append ? cached.offset : 0;
      const buffer = await chunk(handle, offset, info.size - offset);
      const end = buffer.lastIndexOf(10) + 1;
      const entries = append ? [...cached.entries] : [];
      let line = append ? cached.lines : 0;
      for (const raw of buffer.subarray(0, end).toString('utf8').split('\n').slice(0, -1)) {
        line += 1;
        try {
          const entry = projectEntry(JSON.parse(raw), line);
          if (entry) entries.push(entry);
        } catch {
          /* A malformed native line must not make other records disappear. */
        }
      }
      if (append) counters.appendReads += 1;
      else counters.fullReads += 1;
      const consumed = offset + end;
      const boundary = await chunk(handle, Math.max(0, consumed - 512), Math.min(512, consumed));
      const value = {
        version: VERSION,
        file,
        header,
        entries,
        lines: line,
        offset: consumed,
        prefix,
        boundary: hash(boundary),
        size: info.size,
        mtime: info.mtimeMs,
      };
      await saveCache(file, value);
      return value;
    } finally {
      await handle?.close();
    }
  }

  async function enumerate(dir, depth = 0) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const paths = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(path);
      else if (entry.isDirectory() && depth < 2) paths.push(...(await enumerate(path, depth + 1)));
      if (paths.length >= MAX_SOURCES) break;
    }
    return paths.slice(0, MAX_SOURCES);
  }

  function makeRecord(kind, nativeId, title, body, context, extra = {}) {
    const source = {
      path: context.file,
      ...(context.line ? { line: context.line } : {}),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...context.source,
    };
    return {
      id: hash(`${kind}\0${context.file}\0${nativeId}`),
      kind,
      title: string(title, 300) || nativeId,
      body: string(body),
      truncated: typeof body === 'string' && body.length > MAX_BODY,
      scope: context.scope || 'session',
      sessionId: context.sessionId || null,
      sessionTitle: context.sessionTitle || null,
      sessionOpenable: !!context.sessionOpenable,
      date: context.date || null,
      source,
      ...extra,
    };
  }

  function refinementRecord(data, context) {
    const body = [data.summary, data.rationale, data.expectedOutcome].filter(Boolean).join('\n\n');
    const date =
      context.date ||
      data.changes
        .map((edit) => edit.after?.date)
        .filter(Boolean)
        .sort()
        .at(-1) ||
      null;
    return makeRecord(
      'refinement',
      data.id,
      data.summary || data.id,
      body,
      { ...context, scope: data.scope, date },
      {
        changes: data.changes,
        changesTruncated: data.changesTruncated,
        truncated:
          data.changesTruncated ||
          data.changes.some((edit) => edit.before?.truncated || edit.after?.truncated) ||
          body.length > MAX_BODY,
        rollbackOf: data.rollbackOf,
        nativeId: data.id,
      },
    );
  }

  async function readHarness(file, context, warnings) {
    const info = await safeFile(file, [homeRoot, sessionsRoot, artifactsRoot]);
    if (!info) return [];
    if (info.size > MAX_SOURCE_BYTES) {
      warnings.add('source_too_large');
      return [];
    }
    let value = cache.get(file);
    if (!value || value.size !== info.size || value.mtime !== info.mtimeMs) {
      try {
        value = { size: info.size, mtime: info.mtimeMs, state: JSON.parse(await readFile(file, 'utf8')) };
      } catch {
        warnings.add('source_unreadable');
        return [];
      }
      cache.set(file, value);
    }
    const entries = value.state?.entries;
    if (!object(entries)) return [];
    return HARNESS_KINDS.flatMap((kind) =>
      Object.entries(object(entries[kind]) ? entries[kind] : {})
        .filter(([, entry]) => object(entry))
        .map(([key, entry]) =>
          makeRecord(
            kind,
            key,
            entry.title || key,
            entry.content,
            {
              ...context,
              file,
              date: stamp(entry.updated_at || entry.created_at),
              source: { pointer: `/entries/${kind}/${pointer(key)}` },
            },
            { nativeId: key, version: Number.isFinite(entry.version) ? entry.version : null },
          ),
        ),
    );
  }

  async function refresh(cwd) {
    const key = cwdKey(cwd);
    if (flights.has(key)) return flights.get(key);
    const job = (async () => {
      const warnings = new Set(),
        records = [],
        seen = new Set();
      const paths = await enumerate(sessionsRoot);
      let visited = 0;
      while (paths.length && visited < MAX_SOURCES) {
        const file = paths.shift();
        if (seen.has(file)) continue;
        seen.add(file);
        visited += 1;
        const parsed = await readSession(file, cwd, warnings).catch(() => {
          warnings.add('source_unreadable');
          return null;
        });
        if (!parsed?.header?.cwd || cwdKey(parsed.header.cwd) !== key) continue;
        const { header, entries } = parsed;
        const branch = selectedBranch(entries);
        const sessionTitle =
          entries.findLast((e) => e.type === 'session_info' && e.name)?.name ||
          branch.find((e) => e.role === 'user' && e.text?.trim())?.text?.slice(0, 100) ||
          header.id;
        const context = {
          file,
          sessionId: header.id,
          sessionTitle,
          scope: 'session',
          sessionOpenable: inside(sessionsRoot, file) && relative(sessionsRoot, file).split(sep).length <= 3,
        };
        for (const entry of branch)
          if (entry.text?.trim())
            records.push(
              makeRecord(
                'history',
                entry.id || `line-${entry.line}`,
                sessionTitle,
                entry.text,
                { ...context, line: entry.line, date: entry.timestamp, source: { messageId: entry.id } },
                { role: entry.role, truncated: !!entry.truncated },
              ),
            );
        // Native refinement rollback history is session-wide, even after a branch switch.
        for (const entry of entries)
          if (entry.refinement)
            records.push(
              refinementRecord(entry.refinement, {
                ...context,
                line: entry.line,
                date: entry.timestamp,
                source: { messageId: entry.id },
              }),
            );
        const artifact = join(dirname(dirname(file)), 'session-artifacts', header.id);
        records.push(
          ...(await readHarness(join(artifact, 'harness', 'harness_state.json'), context, warnings)),
        );
        // Traverse only native subagent directories, never user-generated artifact trees.
        const children = await readdir(artifact, { withFileTypes: true }).catch(() => []);
        for (const child of children)
          if (child.isDirectory() && !child.isSymbolicLink() && /^sub-[A-Za-z0-9_-]+$/.test(child.name)) {
            const childDir = join(artifact, child.name);
            for (const childFile of await readdir(childDir, { withFileTypes: true }).catch(() => []))
              if (childFile.isFile() && !childFile.isSymbolicLink() && childFile.name.endsWith('.jsonl'))
                paths.push(join(childDir, childFile.name));
          }
      }
      if (paths.length) warnings.add('source_limit');
      records.push(
        ...(await readHarness(
          join(homeRoot, 'harness', 'harness_state.json'),
          { scope: 'global' },
          warnings,
        )),
      );
      const globals = join(homeRoot, 'harness', 'refinements.jsonl');
      const info = sharedMemories === true ? await safeFile(globals, [homeRoot]) : null;
      if (info && info.size <= MAX_SOURCE_BYTES) {
        let cached = cache.get(globals);
        if (!cached || cached.size !== info.size || cached.mtime !== info.mtimeMs) {
          const entries = [];
          let line = 0;
          const contents = await readFile(globals, 'utf8').catch(() => {
            warnings.add('source_unreadable');
            return '';
          });
          for (const raw of contents.split('\n')) {
            line += 1;
            try {
              const data = refinement(JSON.parse(raw));
              if (data) entries.push({ data: { ...data, scope: 'global' }, line });
            } catch {}
          }
          cached = { entries, size: info.size, mtime: info.mtimeMs };
          cache.set(globals, cached);
        }
        const associatedGlobals = new Set(
          records.filter((r) => r.kind === 'refinement' && r.scope === 'global').map((r) => r.nativeId),
        );
        const events = cache.get(join(homeRoot, 'harness', 'harness_state.json'))?.state?.refinements;
        for (const { data, line } of cached.entries)
          if (!associatedGlobals.has(data.id))
            records.push(
              refinementRecord(data, {
                file: globals,
                line,
                scope: 'global',
                date: stamp(
                  Array.isArray(events) ? events.find((event) => event?.id === data.id)?.created_at : null,
                ),
              }),
            );
      }
      if (cacheUnavailable) warnings.add('cache_unavailable');
      // The browser may inspect all sources. Agent readers use their conversation's
      // opt-in, including direct detail lookups and global refinements in local logs.
      const visible = records.filter(
        (record) =>
          sharedMemories === true ||
          record.scope !== 'global' ||
          !['memory', 'refinement'].includes(record.kind),
      );
      return { records: visible, warnings: [...warnings], indexedAt: new Date().toISOString() };
    })();
    flights.set(key, job);
    try {
      return await job;
    } finally {
      if (flights.get(key) === job) flights.delete(key);
    }
  }

  async function project(cwd) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 4096)
      throw new HttpError(400, tr('knowledge.invalid_project'));
    const found = await (store.knowledgeProject ? store.knowledgeProject(cwd) : store.findProject(cwd));
    return found.cwd;
  }

  async function search({ cwd, q = '', kind = 'all', limit = 30, cursor } = {}) {
    if (typeof q !== 'string' || q.length > 500 || !['all', 'global', ...KINDS].includes(kind))
      throw new HttpError(400, tr('knowledge.invalid_query'));
    const count = Number(limit);
    if (!Number.isInteger(count) || count < 1 || count > 100)
      throw new HttpError(400, tr('knowledge.invalid_limit'));
    const projectCwd = await project(cwd),
      tokens = fold(q).trim().split(/\s+/).filter(Boolean).slice(0, 20);
    const queryId = hash(`${cwdKey(projectCwd)}\0${q}\0${kind}\0${sharedMemories === true}`);
    let offset = 0;
    if (cursor !== undefined && cursor !== null && cursor !== '') {
      if (typeof cursor !== 'string' || cursor.length > 200)
        throw new HttpError(400, tr('knowledge.invalid_cursor'));
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (
          decoded.query !== queryId ||
          !Number.isSafeInteger(decoded.offset) ||
          decoded.offset < 0 ||
          decoded.offset > 100_000
        )
          throw new Error();
        offset = decoded.offset;
      } catch {
        throw new HttpError(400, tr('knowledge.invalid_cursor'));
      }
    }
    const index = await refresh(projectCwd),
      counts = Object.fromEntries(KINDS.map((type) => [type, 0]));
    const matching = [];
    for (const record of index.records) {
      const title = fold(record.title),
        body = fold(record.body);
      const changes =
        record.changes?.map((c) => `${c.before?.content || ''}\n${c.after?.content || ''}`).join('\n') || '';
      const haystack = `${title}\n${body}\n${fold(changes)}`;
      if (!tokens.every((token) => haystack.includes(token))) continue;
      counts[record.kind] += 1;
      if (kind === 'global' ? record.scope !== 'global' : kind !== 'all' && record.kind !== kind) continue;
      const score = tokens.reduce(
        (sum, token) => sum + (title.includes(token) ? 4 : 0) + (body.includes(token) ? 1 : 0),
        0,
      );
      matching.push({ ...record, score });
    }
    matching.sort(
      (a, b) =>
        b.score - a.score ||
        String(b.date || '').localeCompare(String(a.date || '')) ||
        a.id.localeCompare(b.id),
    );
    return {
      items: matching.slice(offset, offset + count).map((item) => brief(item, tokens)),
      total: matching.length,
      counts,
      nextCursor:
        offset + count < matching.length
          ? Buffer.from(JSON.stringify({ query: queryId, offset: offset + count })).toString('base64url')
          : null,
      indexedAt: index.indexedAt,
      warnings: index.warnings,
    };
  }

  async function detail({ cwd, id } = {}) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      throw new HttpError(400, tr('knowledge.invalid_id'));
    const projectCwd = await project(cwd),
      index = await refresh(projectCwd);
    const record = index.records.find((item) => item.id === id);
    if (!record) throw new HttpError(404, tr('knowledge.not_found'));
    return { ...record };
  }

  return { search, detail, diagnostics: () => ({ ...counters }) };
}
