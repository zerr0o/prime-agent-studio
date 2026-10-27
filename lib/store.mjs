import { formatMessage as tr } from '../public/i18n-core.js';
import { nativeAgentMessage } from '../public/agent-messages.js';
import { lastAnswer } from '../public/session-activity.js';
import { readFile, readdir, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { imageAttachments, imageMessageText } from './images.mjs';
import { splitFileMessage } from './files.mjs';
import { basename, join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cachedGitHead } from './git-head.mjs';
import { branchGoal } from './goal-state.mjs';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((c) => c?.type === 'text')
          .map((c) => c.text || '')
          .join('\n')
      : '';
export const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id);
export const cwdKey = (cwd) => (process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd));
// Project folder tint palette. Exactly six choices, first is transparent (reset to default).
// Vivid swatches for folder and pin tints. Persisted per project via PATCH /api/projects.
export const PROJECT_FOLDER_COLORS = ['transparent', '#3b82f6', '#16a34a', '#d97706', '#dc2626', '#8b5cf6'];
// Legacy pastel assignments migrate to the vivid family. Accepted as input, always stored/displayed vivid.
export const LEGACY_PROJECT_FOLDER_MAP = {
  '#7fa6c9': '#3b82f6',
  '#8fb49e': '#16a34a',
  '#d0a75e': '#d97706',
  '#c98a7d': '#dc2626',
  '#a99ac9': '#8b5cf6',
};
export const LEGACY_PROJECT_FOLDER_COLORS = Object.keys(LEGACY_PROJECT_FOLDER_MAP);
// Trust boundary validator. Returns '' for default, vivid hex for a swatch or migrated legacy,
// null for an invalid value, undefined when the key is absent.
export function normalizeProjectColor(value) {
  if (value === undefined) return undefined;
  if (value === '' || value === 'transparent') return '';
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  if (PROJECT_FOLDER_COLORS.slice(1).includes(normalized)) return normalized;
  if (Object.hasOwn(LEGACY_PROJECT_FOLDER_MAP, normalized)) return LEGACY_PROJECT_FOLDER_MAP[normalized];
  return null;
}
// Imported-conversation badge TTL (3 minutes). Shared with lib/project-archives.mjs
// (PASTUDIO_BADGE_TTL_MS) and public/project-archives.js (ARCHIVE_BADGE_TTL_MS).
// Badge visible until FIRST user open (persisted pastudioOpenedAt via POST
// /api/sessions/read) or TTL expiry from pastudioImportedAt, whichever first.
export const PASTUDIO_BADGE_TTL_MS = 3 * 60 * 1000;
export function isPastudioBadgeVisible(summary, nowMs = Date.now()) {
  if (!summary || summary.pastudioImported !== true) return false;
  if (summary.pastudioOpenedAt) return false;
  const at = Number(summary.pastudioImportedAt);
  if (!Number.isSafeInteger(at)) return true;
  return Number(nowMs) - at < PASTUDIO_BADGE_TTL_MS;
}

export async function validateDirectory(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.length > 4096 || !isAbsolute(cwd))
    throw new HttpError(400, tr('server.indiquez_le_chemin_absolu_d_un_dossier_existant'));
  const path = resolve(cwd.trim());
  if (!(await stat(path).catch(() => null))?.isDirectory())
    throw new HttpError(400, tr('server.ce_dossier_est_introuvable_ou_inaccessible'));
  return path;
}

function selectedBranch(entries) {
  // Native entries form a tree: retain the currently selected branch.
  const nodes = new Map(entries.filter((e) => e.id && e.type !== 'session').map((e) => [e.id, e]));
  const last = entries.findLast((e) => e.id && e.type !== 'session' && Object.hasOwn(e, 'parentId'));
  let branch = entries;
  if (last) {
    branch = [];
    const visited = new Set();
    let current = last;
    while (current && !visited.has(current.id)) {
      branch.push(current);
      visited.add(current.id);
      current = nodes.get(current.parentId);
    }
    branch.reverse();
  }
  return branch;
}

// Presentation metadata only. contextKind is forwarded solely for goal_context
// notices with an allowlisted details.kind; native details are never exposed.
const CONTEXT_KINDS = new Set(['continuation', 'budget_limit', 'objective_updated']);
const contextKindOf = (holder) => {
  const kind = holder?.details?.kind;
  return typeof kind === 'string' && CONTEXT_KINDS.has(kind) ? kind : undefined;
};

function sessionMessages(entries, branch = selectedBranch(entries)) {
  const messages = [],
    calls = new Map();
  for (const e of branch) {
    const m = e.message;
    if (e.type === 'compaction' || e.type === 'branch_summary') {
      messages.push({
        id: e.id,
        role: 'system',
        customType: e.type,
        text: e.summary || '',
        timestamp: e.timestamp,
        tools: [],
      });
    }
    if (e.type === 'custom_message' && e.display) {
      const contextKind = e.customType === 'goal_context' ? contextKindOf(e) : undefined;
      messages.push({
        ...(nativeAgentMessage(e) ? { agentMessage: nativeAgentMessage(e) } : {}),
        id: e.id,
        role: e.customType === 'session_slash_command' ? 'user' : 'system',
        ...(typeof e.customType === 'string' ? { customType: e.customType.slice(0, 100) } : {}),
        ...(contextKind ? { contextKind } : {}),
        text: textOf(e.content),
        tools: [],
        timestamp: e.timestamp,
      });
    }
    if (e.type !== 'message' || !m) continue;
    if (m.role === 'user' || m.role === 'assistant') {
      const content = Array.isArray(m.content) ? m.content.filter((c) => c && typeof c === 'object') : [];
      const tools = content
        .filter((c) => c.type === 'toolCall')
        .map((c) => {
          const tool = { id: c.id, name: c.name, args: c.arguments, status: 'pending' };
          calls.set(c.id, tool);
          return tool;
        });
      messages.push({
        id: e.id,
        role: m.role,
        text: splitFileMessage(imageMessageText(textOf(m.content))).text,
        thinking: content
          .filter((c) => c.type === 'thinking')
          .map((c) => c.thinking || '')
          .join('\n'),
        tools,
        timestamp: m.timestamp || e.timestamp,
        usage: m.usage,
        model: m.model,
        provider: m.provider,
        error: m.errorMessage,
        stopReason: m.stopReason,
        attachments: [
          ...imageAttachments(content),
          ...splitFileMessage(imageMessageText(textOf(m.content))).attachments,
        ],
      });
    } else if (m.role === 'toolResult') {
      let tool = calls.get(m.toolCallId);
      if (!tool) {
        tool = { id: m.toolCallId, name: m.toolName };
        messages.push({ id: e.id, role: 'assistant', text: '', tools: [tool], timestamp: e.timestamp });
      }
      Object.assign(tool, {
        result: textOf(m.content),
        isError: !!m.isError,
        status: m.isError ? 'error' : 'done',
      });
    } else if (m.role === 'bashExecution') {
      messages.push({
        id: e.id,
        role: 'assistant',
        text: '',
        tools: [
          {
            id: e.id,
            name: 'shell',
            args: { command: m.command },
            result: m.output,
            status: m.exitCode ? 'error' : 'done',
            isError: !!m.exitCode,
          },
        ],
        timestamp: e.timestamp,
      });
    } else if (m.role === 'custom' && m.display) {
      const contextKind = m.customType === 'goal_context' ? contextKindOf(m) : undefined;
      messages.push({
        ...(nativeAgentMessage(m) ? { agentMessage: nativeAgentMessage(m) } : {}),
        id: e.id,
        role: m.customType === 'session_slash_command' ? 'user' : 'system',
        ...(typeof m.customType === 'string' ? { customType: m.customType.slice(0, 100) } : {}),
        ...(contextKind ? { contextKind } : {}),
        text: textOf(m.content),
        tools: [],
        timestamp: e.timestamp,
      });
    }
  }
  for (const e of entries)
    if (e.type === 'child_usage_attributed' && e.aggregateUsage) {
      const target = messages.find((m) => m.id === e.targetId);
      if (target) {
        // Raw JSONL message rows retain the exact own request usage. Preserve it
        // before cumulative child overlays, for context/cache and tree rollups.
        if (!Object.hasOwn(target, 'ownUsage')) target.ownUsage = target.usage;
        target.usage = e.aggregateUsage;
      }
    }
  return messages;
}

const SYNC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function createStore({ sessionDir, dataDir, initialCwd }) {
  const stateFile = join(dataDir, 'workspace.json');
  let state,
    initializing,
    writes = Promise.resolve(),
    preferenceWrites = Promise.resolve(),
    orderWrites = Promise.resolve();
  const cache = new Map();
  const inspectedCache = new Map();
  // Persistent lightweight SUMMARY index (cold-start optimization). First ever
  // run still scans every session once to build it; warm processes only
  // stat() unchanged files and never open their JSONL payloads. Keyed by
  // absolute file path with size/mtime/schema guards; the JSONL sources stay
  // immutable and authoritative, so a missing/corrupt/stale index simply
  // rebuilds from them. Summaries never hold message contents.
  const INDEX_VERSION = 1;
  const INDEX_MAX_ENTRIES = 50000; // sanity cap: a bloated/corrupt index rebuilds instead of slowing bootstrap
  const indexFile = join(dataDir, 'session-index.json');
  let indexed = null; // null until loadIndex() runs; {} means loaded-but-empty
  let indexLoading = null; // single-flight: concurrent callers share one validated load
  let indexWrites = Promise.resolve();
  let indexDirtyGen = 0;
  let indexSavedGen = 0;
  let overviewRefresh = null; // single-flight shared by overlapping overviews
  const pendingParses = new Map(); // single-flight shared by concurrent scans of the same file
  let receiptsSeeded = false; // true once readReceipts covered every known session
  async function init() {
    if (state) return;
    if (initializing) return initializing;
    initializing = (async () => {
      let loaded;
      try {
        loaded = JSON.parse(await readFile(stateFile, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT')
          throw new Error(tr('server.impossible_de_lire_les_preferences_locales') + error.message);
        loaded = { projects: [], sessions: {} };
      }
      loaded.projects = Array.isArray(loaded.projects) ? loaded.projects : [];
      loaded.sessions = loaded.sessions && typeof loaded.sessions === 'object' ? loaded.sessions : {};
      receiptsSeeded = !!loaded.readReceipts;
      loaded.removedProjects = Array.isArray(loaded.removedProjects) ? loaded.removedProjects : [];
      if (!loaded.sessionOrder || typeof loaded.sessionOrder !== 'object' || Array.isArray(loaded.sessionOrder))
        loaded.sessionOrder = {};
      if (!loaded.projects.length && initialCwd && !loaded.removedProjects.includes(cwdKey(initialCwd)))
        loaded.projects.push({ cwd: resolve(initialCwd), name: basename(initialCwd), pinned: true });
      state = loaded;
    })();
    try { await initializing; } finally { initializing = null; }
  }
  async function save() {
    const contents = JSON.stringify(state, null, 2) + '\n';
    const write = writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dataDir, { recursive: true });
        const temp = stateFile + '.' + randomUUID() + '.tmp';
        await writeFile(temp, contents, 'utf8');
        await rename(temp, stateFile);
      });
    writes = write;
    await write;
  }
  async function files(dir = sessionDir, depth = 0) {
    const items = await readdir(dir, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const lists = await Promise.all(
      items.map((item) =>
        item.isFile() && item.name.endsWith('.jsonl')
          ? [join(dir, item.name)]
          : item.isDirectory() && depth < 2
            ? files(join(dir, item.name), depth + 1)
            : [],
      ),
    );
    return lists.flat();
  }
  // Full parse of one JSONL file. Stats the file itself so the cached stat
  // always predates the content it describes: a later append can only cause a
  // reparse, never a stale hit.
  async function parseFile(file) {
    const info = await stat(file).catch(() => null);
    if (!info) return null;
    const entries = [];
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
        } catch {}
      }
    } catch {
      return null;
    }
    const header = entries.find((e) => e.type === 'session');
    if (!header || !validId(header.id)) return null;
    const branch = selectedBranch(entries),
      messages = sessionMessages(entries, branch);
    const first = messages.find((m) => m.role === 'user' && m.text.trim());
    const named = entries.findLast((e) => e.type === 'session_info' && e.name);
    // Native context applies model changes and assistant model metadata in branch order.
    const modelEntry = branch.findLast(
      (e) =>
        e.type === 'model_change' ||
        (e.type === 'message' && e.message?.role === 'assistant' && e.message.model),
    );
    const model =
      modelEntry?.type === 'model_change'
        ? { provider: modelEntry.provider, id: modelEntry.modelId }
        : modelEntry
          ? { provider: modelEntry.message.provider, id: modelEntry.message.model }
          : null;
    const value = {
      id: header.id,
      file,
      cwd: header.cwd || null,
      title: named?.name || first?.text.replace(/\s+/g, ' ').slice(0, 100) || tr('ui.nouvelle_session'),
      createdAt: header.timestamp || info.birthtime.toISOString(),
      updatedAt: info.mtime.toISOString(),
      model: model ? [model.provider, model.id].filter(Boolean).join('/') : null,
      thinking: branch.findLast((e) => e.type === 'thinking_level_change')?.thinkingLevel ?? null,
      messageCount: messages.filter((m) => m.role === 'user' || m.role === 'assistant').length,
      git: sessionGit(header, branch),
      goal: branchGoal(branch),
      goalEverKnown: branch.some((e) => e.type === 'custom' && e.customType === 'thread_goal_state'),
      ...(header.parentSession && { parentSession: header.parentSession }),
      messages,
    };
    return { value, size: info.size, mtimeMs: info.mtimeMs };
  }
  async function scan(file, historyCache = cache) {
    const info = await stat(file).catch(() => null);
    if (!info) return null;
    const existing = historyCache.get(file);
    if (existing?.size === info.size && existing?.mtime === info.mtimeMs) {
      historyCache.delete(file);
      historyCache.set(file, existing);
      return existing.value;
    }
    // Concurrent overview/history callers parsing the same file share one read.
    let flight = pendingParses.get(file);
    if (!flight) {
      flight = parseFile(file);
      pendingParses.set(file, flight);
      const release = () => {
        if (pendingParses.get(file) === flight) pendingParses.delete(file);
      };
      flight.then(release, release);
    }
    const parsed = await flight;
    if (!parsed) return null;
    historyCache.set(file, { size: parsed.size, mtime: parsed.mtimeMs, value: parsed.value });
    // Artifact histories are outside allSummaries()' directory scan. Keep a bounded LRU
    // so gauge refreshes reuse parsed children without retaining them forever.
    if (historyCache === inspectedCache && historyCache.size > 200)
      historyCache.delete(historyCache.keys().next().value);
    return parsed.value;
  }
  // Git context recorded by the engine for this conversation (informative).
  function sessionGit(header, branch) {
    const entry = branch.findLast((e) => e.type === 'git_state' && e.git);
    const git = entry?.git || header.git;
    if (!git || typeof git !== 'object') return null;
    const text = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : null);
    const repo = text(git.repoUrl, 300)?.replace(/\/\/[^/@]*@/, '//') || null;
    const result = {
      branch: text(git.branch, 200),
      commit: text(git.commit, 64),
      repo,
      at: entry?.timestamp || header.timestamp || null,
    };
    return result.branch || result.commit ? result : null;
  }
  // Allowlist of summary fields consumers depend on (overview projections,
  // receipts, worktree binding). Anything else — messages, file, unknown keys,
  // or mistyped values from a damaged row — is stripped, and rows with an
  // unusable shape are dropped so the file reparses from source. Never throws:
  // returns the clean summary or null.
  function sanitizeSummary(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.id !== 'string' || !validId(raw.id)) return null;
    if (typeof raw.title !== 'string' || typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string')
      return null;
    const strOrNull = (value) =>
      typeof value === 'string' ? value : value === null || value === undefined ? null : undefined;
    const cwd = strOrNull(raw.cwd);
    const model = strOrNull(raw.model);
    const thinking = strOrNull(raw.thinking);
    if (cwd === undefined || model === undefined || thinking === undefined) return null;
    if (typeof raw.messageCount !== 'number' || !Number.isFinite(raw.messageCount)) return null;
    let git = null;
    if (raw.git !== null && raw.git !== undefined) {
      if (!raw.git || typeof raw.git !== 'object' || Array.isArray(raw.git)) return null;
      const text = (value) => (typeof value === 'string' ? value : null);
      git = {
        branch: text(raw.git.branch),
        commit: text(raw.git.commit),
        repo: text(raw.git.repo),
        at: text(raw.git.at),
      };
    }
    return {
      id: raw.id,
      cwd,
      title: raw.title,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      model,
      thinking,
      messageCount: raw.messageCount,
      git,
    };
  }
  function sanitizeIndexRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    if (typeof row.size !== 'number' || !Number.isFinite(row.size)) return null;
    if (typeof row.mtimeMs !== 'number' || !Number.isFinite(row.mtimeMs)) return null;
    const summary = sanitizeSummary(row.summary);
    if (!summary) return null;
    const answer = row.answer === undefined ? '' : row.answer;
    if (typeof answer !== 'string') return null;
    return { size: row.size, mtimeMs: row.mtimeMs, summary, answer };
  }
  async function loadIndex() {
    if (indexed) return indexed;
    if (!indexLoading) {
      indexLoading = (async () => {
        const table = {};
        try {
          const raw = JSON.parse(await readFile(indexFile, 'utf8'));
          const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.entries : null;
          if (
            raw?.version === INDEX_VERSION &&
            entries &&
            typeof entries === 'object' &&
            !Array.isArray(entries) &&
            Object.keys(entries).length <= INDEX_MAX_ENTRIES
          )
            for (const key of Object.keys(entries)) {
              // One bad row must not break bootstrap: validate each entry alone.
              try {
                if (typeof key !== 'string' || !key) continue;
                const clean = sanitizeIndexRow(entries[key]);
                if (clean) table[key] = clean;
              } catch {}
            }
        } catch {
          // Missing/corrupt index: rebuild from the JSONL sources below.
        }
        indexed = table; // publish only after validation completes
        return indexed;
      })().then(
        (value) => {
          indexLoading = null;
          return value;
        },
        () => {
          indexLoading = null;
          indexed = {};
          return indexed;
        },
      );
    }
    return indexLoading;
  }
  // Optimization only, never the source of truth: a failed atomic write stays
  // retryable and never blocks the valid reads returned regardless.
  async function persistIndex() {
    if (!indexed || indexSavedGen >= indexDirtyGen) return;
    const write = indexWrites.catch(() => {}).then(async () => {
      if (indexSavedGen >= indexDirtyGen) return;
      const gen = indexDirtyGen;
      await mkdir(dataDir, { recursive: true });
      const temp = indexFile + '.tmp';
      await writeFile(temp, JSON.stringify({ version: INDEX_VERSION, entries: indexed }), 'utf8');
      await rename(temp, indexFile);
      indexSavedGen = gen;
    });
    indexWrites = write.catch(() => {});
    try {
      await write;
    } catch {
      // Keep indexDirtyGen ahead so a later refresh retries; reads already succeeded.
    }
  }
  function noteParsed(file) {
    if (!indexed) return;
    const mem = cache.get(file);
    if (!mem?.value) return;
    const { messages, file: _file, ...summary } = mem.value;
    indexed[file] = {
      size: mem.size,
      mtimeMs: mem.mtime,
      summary,
      answer: lastAnswer(messages)?.id || '',
    };
    indexDirtyGen++;
  }
  function activityFromAnswer(answer, id) {
    return {
      answer: answer || '',
      read: state.readReceipts?.[id] || '',
      revision: state.receiptRevision || 1,
    };
  }
  // Single-flight full refresh shared by overlapping overviews: list + stat
  // every file (cheap), reuse valid summaries without opening payloads, parse
  // each changed file exactly once. Returns pairs ordered like files().
  async function refreshSummaries() {
    if (overviewRefresh) return overviewRefresh;
    overviewRefresh = (async () => {
      await init();
      const table = await loadIndex();
      const paths = await files();
      const seen = new Set(paths);
      for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
      for (const key of Object.keys(table))
        if (!seen.has(key)) {
          delete table[key];
          indexDirtyGen++;
        }
      const byFile = new Map();
      const misses = [];
      const infos = await Promise.all(
        paths.map(async (file) => ({ file, info: await stat(file).catch(() => null) })),
      );
      for (const { file, info } of infos) {
        if (!info) continue;
        const mem = cache.get(file);
        if (mem?.value && mem.size === info.size && mem.mtime === info.mtimeMs) {
          const { messages, file: _file, ...summary } = mem.value;
          const answer = lastAnswer(messages)?.id || '';
          byFile.set(file, { file, summary, answer });
          const row = table[file];
          if (!row || row.size !== info.size || row.mtimeMs !== info.mtimeMs) {
            table[file] = { size: info.size, mtimeMs: info.mtimeMs, summary, answer };
            indexDirtyGen++;
          }
          continue;
        }
        const row = table[file];
        if (row && row.size === info.size && row.mtimeMs === info.mtimeMs) {
          byFile.set(file, { file, summary: row.summary, answer: row.answer || '' });
          continue;
        }
        misses.push(file);
      }
      for (let i = 0; i < misses.length; i += 12)
        await Promise.all(
          misses.slice(i, i + 12).map(async (file) => {
            const value = await scan(file);
            if (!value) {
              if (table[file]) {
                delete table[file];
                indexDirtyGen++;
              }
              return;
            }
            noteParsed(file);
            const { messages, file: _file, ...summary } = value;
            byFile.set(file, { file, summary, answer: lastAnswer(messages)?.id || '' });
          }),
        );
      await persistIndex();
      return paths.map((file) => byFile.get(file)).filter(Boolean);
    })();
    try {
      return await overviewRefresh;
    } finally {
      overviewRefresh = null;
    }
  }
  async function allSummaries() {
    const pairs = await refreshSummaries();
    const found = pairs.map(({ file, summary, answer }) => ({
      ...summary,
      file,
      ...state.sessions[summary.id],
      answer,
    }));
    if (!state.readReceipts || !receiptsSeeded) {
      // One shared starting point for existing history, instead of a backlog on each new device.
      // Preserves explicit partial receipts (history/markRead/markUnread before the
      // first overview) and only seeds sessions that are still missing.
      if (!state.readReceipts || typeof state.readReceipts !== 'object' || Array.isArray(state.readReceipts))
        state.readReceipts = {};
      for (const s of found)
        if (state.readReceipts[s.id] === undefined) state.readReceipts[s.id] = s.answer || '';
      state.receiptRevision = state.receiptRevision || 1;
      receiptsSeeded = true;
      await save();
    } else {
      // Imported auto-READ (no blue dot) at import visibility.
      // Only fills MISSING receipts so future replies still turn unread.
      // Never overwrites an existing receipt (recovery must not reset after
      // user messages). Uses the actual selected-branch lastAnswer.
      let initialized = false;
      for (const s of found) {
        if (s?.pastudioImported === true && state.readReceipts[s.id] === undefined) {
          state.readReceipts[s.id] = s.answer || '';
          initialized = true;
        }
      }
      if (initialized) await save();
    }
    return found.map((s) => {
      const { answer: _answer, ...rest } = s;
      return { ...rest, readState: activityFromAnswer(_answer, s.id) };
    });
  }
  function activity(session) {
    return {
      answer: lastAnswer(session.messages)?.id || '',
      read: state.readReceipts?.[session.id] || '',
      revision: state.receiptRevision || 1,
    };
  }
  async function markPastudioOpened(id) {
    await init();
    if (!validId(id)) throw new HttpError(400, tr('server.identifiant_de_session_invalide'));
    const current = state.sessions[id];
    if (!current?.pastudioImported || current.pastudioOpenedAt) return { opened: false };
    // Spread preserves sibling sessionOrder and all other local fields.
    state.sessions[id] = { ...current, pastudioOpenedAt: Date.now() };
    await save();
    return { opened: true };
  }
  async function markRead({ id, answer }) {
    const session = await history(id);
    let receiptChanged = false;
    let openedChanged = false;
    // Badge opened flag: actual user selection via this read endpoint only.
    // Never set from GET /api/history (background inspector/knowledge/prefetch
    // also fetch history and must not clear the badge).
    if (session.pastudioImported === true && !state.sessions[session.id]?.pastudioOpenedAt) {
      state.sessions[session.id] = { ...state.sessions[session.id], pastudioOpenedAt: Date.now() };
      openedChanged = true;
    }
    if (answer === undefined && !openedChanged) throw new HttpError(400, tr('activity.invalid_receipt'));
    if (answer !== undefined) {
      const target = session.messages.findIndex((m) => m.id === answer && lastAnswer([m]));
      if (target < 0) {
        // Opened-only progress must not fail on an already-read/missing answer,
        // but an explicit invalid receipt for a non-imported session still fails.
        if (!(session.pastudioImported === true && openedChanged)) {
          if (openedChanged) await save();
          throw new HttpError(400, tr('activity.invalid_receipt'));
        }
      } else {
        const previous = session.messages.findIndex((m) => m.id === state.readReceipts[id]);
        if (target > previous) {
          state.readReceipts[id] = answer;
          state.receiptRevision = (state.receiptRevision || 1) + 1;
          (state.readAt ??= {})[id] = Date.now();
          receiptChanged = true;
        }
      }
    }
    if (receiptChanged || openedChanged) await save();
    const refreshed = openedChanged ? await history(id).catch(() => session) : session;
    return { id, readState: activity(refreshed) };
  }
  async function markUnread({ id }) {
    const session = await history(id);
    const answer = lastAnswer(session.messages)?.id || '';
    if (!answer || state.readReceipts?.[id] !== answer) return { id, readState: activity(session) };
    state.readReceipts[id] = '';
    state.receiptRevision = (state.receiptRevision || 1) + 1;
    (state.readAt ??= {})[id] = Date.now();
    await save();
    const refreshed = await history(id).catch(() => session);
    return { id, readState: activity(refreshed) };
  }
  async function withReceipts(value) {
    const merged = { ...value, ...state.sessions[value.id] };
    const answer = lastAnswer(merged.messages)?.id || '';
    if ((!state.readReceipts || !receiptsSeeded) && state.readReceipts?.[merged.id] === undefined) {
      if (!state.readReceipts) state.readReceipts = {};
      state.readReceipts[merged.id] = answer;
      await save();
    } else if (merged?.pastudioImported === true && state.readReceipts[merged.id] === undefined) {
      state.readReceipts[merged.id] = answer;
      await save();
    }
    return { ...merged, readState: activity(merged) };
  }
  async function history(id) {
    if (!validId(id)) throw new HttpError(400, tr('server.identifiant_de_session_invalide'));
    await init();
    await loadIndex();
    // The index is a cache, never authority for paths: only trust entries for
    // files discovered in the configured sessionDir (same rules as files()),
    // and always verify the parsed header id before exposing anything.
    const paths = await files();
    const known = new Set(paths);
    let file = null;
    for (const key of cache.keys())
      if (known.has(key) && cache.get(key)?.value?.id === id) {
        file = key;
        break;
      }
    if (!file) {
      const row = Object.entries(indexed).find(([, entry]) => entry.summary?.id === id);
      if (row && known.has(row[0])) {
        const info = await stat(row[0]).catch(() => null);
        if (info && row[1].size === info.size && row[1].mtimeMs === info.mtimeMs) file = row[0];
        else {
          delete indexed[row[0]];
          indexDirtyGen++;
        }
      }
    }
    if (file) {
      const value = await scan(file);
      if (value?.id === id) {
        noteParsed(file);
        await persistIndex();
        return withReceipts(value);
      }
      file = null;
    }
    // Cold index (first run) or new/renamed file: parse one file at a time and
    // stop at the match instead of scanning every session up front. Every
    // parsed file still feeds the index, so repeats keep getting faster.
    for (const candidate of paths) {
      const value = await scan(candidate);
      if (!value) continue;
      noteParsed(candidate);
      if (value.id === id) {
        await persistIndex();
        return withReceipts(value);
      }
    }
    await persistIndex();
    throw new HttpError(404, tr('server.session_introuvable'));
  }
  const WORKTREE_ID_RE = /^wt-[0-9a-f]{12}$/;
  function sessionWorktreeMeta(id) {
    const meta = state.sessions?.[id];
    if (!meta || typeof meta.worktreeId !== 'string' || !WORKTREE_ID_RE.test(meta.worktreeId)) return null;
    if (typeof meta.worktreeProjectCwd !== 'string' || !isAbsolute(meta.worktreeProjectCwd)) return null;
    return { worktreeId: meta.worktreeId, projectCwd: resolve(meta.worktreeProjectCwd) };
  }
  async function bindSessionWorktree({ id, worktreeId, projectCwd }) {
    await init();
    if (!validId(id)) throw new HttpError(400, tr('server.identifiant_de_session_invalide'));
    if (typeof worktreeId !== 'string' || !WORKTREE_ID_RE.test(worktreeId))
      throw new HttpError(400, tr('server.demande_invalide'));
    if (typeof projectCwd !== 'string' || !isAbsolute(projectCwd))
      throw new HttpError(400, tr('server.projet_invalide'));
    const resolvedProject = resolve(projectCwd);
    state.sessions[id] = { ...state.sessions[id], worktreeId, worktreeProjectCwd: resolvedProject };
    const session = await history(id).catch(() => null);
    if (session?.cwd) {
      const taskKey = cwdKey(session.cwd);
      const projectKey = cwdKey(resolvedProject);
      if (taskKey !== projectKey) {
        state.projects = (state.projects || []).filter((p) => cwdKey(p.cwd) !== taskKey);
        if (state.sessionOrder && Array.isArray(state.sessionOrder[taskKey]))
          delete state.sessionOrder[taskKey];
      }
    }
    await save();
    return { bound: true, id, worktreeId, projectCwd: resolvedProject };
  }
  function getSessionWorktree(id) {
    if (!validId(id)) return null;
    return sessionWorktreeMeta(id);
  }
  async function worktreeSessions(worktreeId) {
    await init();
    if (typeof worktreeId !== 'string' || !WORKTREE_ID_RE.test(worktreeId))
      throw new HttpError(400, tr('server.demande_invalide'));
    const sessions = await allSummaries();
    return sessions
      .filter((s) => state.sessions?.[s.id]?.worktreeId === worktreeId)
      .map((s) => {
        const { messages, file, ...summary } = s;
        return summary;
      })
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  async function forgetWorktreeProject(taskPath) {
    await init();
    if (typeof taskPath !== 'string' || !isAbsolute(taskPath)) return { forgotten: false };
    const key = cwdKey(taskPath);
    const before = (state.projects || []).length;
    state.projects = (state.projects || []).filter((p) => cwdKey(p.cwd) !== key);
    if (state.sessionOrder && Array.isArray(state.sessionOrder[key])) delete state.sessionOrder[key];
    if (state.projects.length !== before) await save();
    return { forgotten: before !== state.projects.length };
  }
  async function overview() {
    const sessions = await allSummaries();
    const removed = new Set(state.removedProjects);
    const projects = new Map(
      state.projects
        .filter((p) => !removed.has(cwdKey(p.cwd)))
        .map((p) => [cwdKey(p.cwd), { ...p, sessions: [] }]),
    );
    for (const s of sessions) {
      if (!s.cwd) continue;
      const meta = sessionWorktreeMeta(s.id);
      const ownerCwd = meta ? meta.projectCwd : s.cwd;
      const key = cwdKey(ownerCwd);
      if (removed.has(key)) continue;
      if (!projects.has(key)) {
        const base = meta ? ownerCwd : s.cwd;
        projects.set(key, { cwd: base, name: basename(base), pinned: false, sessions: [] });
      }
      const { messages, file, ...summary } = s;
      projects.get(key).sessions.push(summary);
    }
    let sessionOrderChanged = false;
    for (const p of projects.values()) {
      p.exists = !!(await stat(p.cwd).catch(() => null))?.isDirectory();
      p.gitHead = p.exists ? await cachedGitHead(p.cwd) : null;
      if (p.color !== undefined) {
        const scrubbed = normalizeProjectColor(p.color);
        if (!scrubbed) delete p.color;
        else p.color = scrubbed;
      }
      // Stable conversation order: pinned stay top, manual order persists.
      // New activity/messages never reorder. New ids join the top of their
      // pinned group; pin moves to top of pinned, unpin to top of unpinned.
      // Migration freezes the current sensible order once (pinned, updatedAt).
      if (!state.sessionOrder || typeof state.sessionOrder !== 'object') state.sessionOrder = {};
      const key = cwdKey(p.cwd);
      if (!Array.isArray(state.sessionOrder[key])) {
        const frozen = [...p.sessions].sort(
          (a, b) =>
            Number(!!b.pinned) - Number(!!a.pinned) ||
            String(b.updatedAt).localeCompare(String(a.updatedAt)) ||
            String(a.id).localeCompare(String(b.id)),
        );
        state.sessionOrder[key] = frozen.map((s) => s.id);
        if (frozen.length) sessionOrderChanged = true;
      } else {
        const seen = new Set();
        state.sessionOrder[key] = state.sessionOrder[key].filter(
          (id) => typeof id === 'string' && validId(id) && !seen.has(id) && (seen.add(id), true),
        );
        const known = new Set(state.sessionOrder[key]);
        const unknown = p.sessions.filter((s) => !known.has(s.id));
        if (unknown.length) {
          unknown.sort(
            (a, b) =>
              Number(!!b.pinned) - Number(!!a.pinned) ||
              String(b.updatedAt).localeCompare(String(a.updatedAt)) ||
              String(a.id).localeCompare(String(b.id)),
          );
          const order = state.sessionOrder[key];
          const byId = new Map(p.sessions.map((s) => [s.id, s]));
          const pinnedIds = unknown.filter((s) => s.pinned).map((s) => s.id);
          const unpinnedIds = unknown.filter((s) => !s.pinned).map((s) => s.id);
          // Orphaned ids (deleted sessions) stay in place, never pruned here,
          // so a stale scan cannot drop a concurrent insert (self-healing).
          if (pinnedIds.length) order.unshift(...pinnedIds);
          if (unpinnedIds.length) {
            let insertAt = 0;
            for (const id of order) {
              if (byId.get(id)?.pinned) insertAt++;
              else break;
            }
            order.splice(insertAt, 0, ...unpinnedIds);
          }
          sessionOrderChanged = true;
        }
      }
      const rank = new Map(state.sessionOrder[key].map((id, index) => [id, index]));
      p.sessions.sort(
        (a, b) =>
          Number(!!b.pinned) - Number(!!a.pinned) ||
          (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
          String(b.updatedAt).localeCompare(String(a.updatedAt)) ||
          String(a.id).localeCompare(String(b.id)),
      );
    }
    if (sessionOrderChanged) await save();
    return {
      projects: [...projects.values()].sort(
        (a, b) =>
          Number(!!b.pinned) - Number(!!a.pinned) ||
          projectRank(a.cwd) - projectRank(b.cwd) ||
          a.name.localeCompare(b.name),
      ),
      totalSessions: sessions.length,
    };
  }
  function projectRank(cwd) {
    const index = (state.projectOrder || []).indexOf(cwdKey(cwd));
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  }
  async function moveProject({ cwd, direction, targetCwd, position }) {
    return queueOrderOperation(async () => {
      const anchored = targetCwd !== undefined;
      if (
        typeof cwd !== 'string' ||
        !isAbsolute(cwd) ||
        (anchored
          ? typeof targetCwd !== 'string' || !isAbsolute(targetCwd) || !['before', 'after'].includes(position)
          : ![-1, 1].includes(direction))
      )
        throw new HttpError(400, tr('projects.invalid_order'));
      const { projects } = await overview();
      const index = projects.findIndex((p) => cwdKey(p.cwd) === cwdKey(cwd));
      const next = anchored
        ? projects.findIndex((p) => cwdKey(p.cwd) === cwdKey(targetCwd))
        : index + direction;
      if (index < 0 || !projects[next] || !!projects[index].pinned !== !!projects[next].pinned)
        throw new HttpError(409, tr('projects.invalid_order'));
      if (index === next) return { moved: false };
      if (anchored) {
        const target = projects[next];
        const [moving] = projects.splice(index, 1);
        projects.splice(projects.indexOf(target) + (position === 'after' ? 1 : 0), 0, moving);
      } else [projects[index], projects[next]] = [projects[next], projects[index]];
      state.projectOrder = projects.map((p) => cwdKey(p.cwd));
      await save();
      return { moved: true };
    });
  }
  function queueOrderOperation(operation) {
    const task = orderWrites.catch(() => {}).then(operation);
    orderWrites = task.catch(() => {});
    return task;
  }
  function repositionSessionInOrder(projectKey, id, pinned) {
    if (!state.sessionOrder || typeof state.sessionOrder !== 'object') state.sessionOrder = {};
    if (!Array.isArray(state.sessionOrder[projectKey])) state.sessionOrder[projectKey] = [];
    const order = state.sessionOrder[projectKey].filter((entry) => entry !== id);
    if (pinned) {
      order.unshift(id);
    } else {
      // Top of unpinned: just after the leading pinned segment. Pinned here
      // mirrors the overview display (state.sessions holds the new value).
      let at = 0;
      while (at < order.length && state.sessions[order[at]]?.pinned) at++;
      order.splice(at, 0, id);
    }
    state.sessionOrder[projectKey] = order;
  }
  async function moveSession({ id, direction, targetId, position }) {
    return queueOrderOperation(async () => {
      if (!validId(id)) throw new HttpError(400, tr('sessions.invalid_order'));
      const anchored = targetId !== undefined;
      if (
        anchored
          ? !validId(targetId) || !['before', 'after'].includes(position)
          : ![-1, 1].includes(direction)
      )
        throw new HttpError(400, tr('sessions.invalid_order'));
      if (anchored && targetId === id) return { moved: false };
      const { projects } = await overview();
      let owner = null;
      for (const p of projects) {
        const found = p.sessions.find((s) => s.id === id);
        if (found) {
          owner = p;
          break;
        }
      }
      if (!owner) throw new HttpError(409, tr('sessions.invalid_order'));
      const key = cwdKey(owner.cwd);
      const ordered = owner.sessions;
      const from = ordered.findIndex((s) => s.id === id);
      const to = anchored ? ordered.findIndex((s) => s.id === targetId) : from + direction;
      const moving = ordered[from];
      const target = ordered[to];
      // Deterministic by ids: same project, same pinned group, same archived
      // bucket. Conversations never move projects on drag. Stale targets
      // (disappeared or group-changed) return 409 so the client refreshes.
      if (
        !moving ||
        !target ||
        !!moving.pinned !== !!target.pinned ||
        !!moving.archived !== !!target.archived
      )
        throw new HttpError(409, tr('sessions.invalid_order'));
      if (from === to) return { moved: false };
      const group = ordered.filter(
        (s) => !!s.pinned === !!moving.pinned && !!s.archived === !!moving.archived,
      );
      const fromGroup = group.findIndex((s) => s.id === id);
      const toGroup = anchored ? group.findIndex((s) => s.id === targetId) : fromGroup + direction;
      if (fromGroup < 0 || toGroup < 0 || !group[toGroup])
        throw new HttpError(409, tr('sessions.invalid_order'));
      if (fromGroup === toGroup) return { moved: false };
      const [item] = group.splice(fromGroup, 1);
      const insertIndex = anchored
        ? group.findIndex((entry) => entry.id === targetId) + (position === 'after' ? 1 : 0)
        : toGroup;
      group.splice(insertIndex, 0, item);
      // Rewrite only this project's array. Remove the moved group ids from
      // the stored array, then reinsert the group block at the first group
      // position so unrelated groups and orphaned ids keep their order
      // (never drop concurrent inserts; missing current ids are appended).
      const groupSet = new Set(group.map((s) => s.id));
      const stored = Array.isArray(state.sessionOrder[key]) ? [...state.sessionOrder[key]] : [];
      let insertAt = stored.findIndex((sid) => groupSet.has(sid));
      const without = stored.filter((sid) => !groupSet.has(sid));
      if (insertAt < 0) {
        insertAt = without.length;
        if (!moving.pinned) {
          let leading = 0;
          while (leading < without.length && state.sessions[without[leading]]?.pinned) leading++;
          insertAt = leading;
        } else {
          insertAt = 0;
        }
      } else if (insertAt > without.length) {
        insertAt = without.length;
      }
      without.splice(insertAt, 0, ...group.map((s) => s.id));
      for (const sid of ordered.map((s) => s.id)) if (!without.includes(sid)) without.push(sid);
      state.sessionOrder[key] = without;
      await save();
      return { moved: true };
    });
  }
  async function project(body, update = false) {
    await init();
    const cwd = await validateDirectory(body.cwd);
    const key = cwdKey(cwd);
    const patch = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100)
        throw new HttpError(400, tr('server.le_nom_doit_contenir_entre_1_et_100_caracteres'));
      patch.name = body.name.trim();
    }
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== 'boolean') throw new HttpError(400, tr('server.epinglage_invalide'));
      patch.pinned = body.pinned;
    }
    // Conversation sync is on by default; only an explicit false opts out.
    if (body.sync !== undefined) {
      if (typeof body.sync !== 'boolean') throw new HttpError(400, tr('server.valeur_invalide'));
      patch.sync = body.sync;
    }
    // Explicit link to a synced project across PCs ('new' starts a separate one).
    let syncReset = false;
    if (body.syncId !== undefined) {
      if (body.syncId === null) syncReset = true;
      else if (body.syncId === 'new') Object.assign(patch, { syncId: randomUUID(), syncManual: true });
      else if (typeof body.syncId === 'string' && SYNC_ID_RE.test(body.syncId))
        Object.assign(patch, { syncId: body.syncId, syncManual: true });
      else throw new HttpError(400, tr('server.valeur_invalide'));
    }
    let colorReset = false;
    if (body.color !== undefined) {
      const normalized = normalizeProjectColor(body.color);
      if (normalized === null) throw new HttpError(400, tr('server.valeur_invalide'));
      if (normalized === '') colorReset = true;
      else patch.color = normalized;
      // Project color changes carry a timestamp so sync can apply newest wins.
      patch.colorAt = Date.now();
    }
    let entry = state.projects.find((p) => cwdKey(p.cwd) === key);
    if (!entry) {
      entry = { cwd, name: basename(cwd), pinned: !update };
      state.projects.push(entry);
    }
    Object.assign(entry, patch);
    if (colorReset) delete entry.color;
    if (syncReset) {
      delete entry.syncId;
      delete entry.syncManual;
    }
    state.removedProjects = state.removedProjects.filter((value) => value !== key);
    await save();
    return { ...entry, exists: true, sessions: [] };
  }
  async function findProject(cwd) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new HttpError(400, tr('server.projet_invalide'));
    const found = (await overview()).projects.find((p) => cwdKey(p.cwd) === cwdKey(cwd));
    if (!found) throw new HttpError(404, tr('server.projet_introuvable'));
    return found;
  }
  async function knowledgeProject(cwd) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new HttpError(400, tr('server.projet_invalide'));
    await init();
    const key = cwdKey(cwd);
    if (state.removedProjects.includes(key)) throw new HttpError(404, tr('server.projet_introuvable'));
    // Explicit workspace membership does not require reparsing every conversation.
    const saved = state.projects.find((project) => cwdKey(project.cwd) === key);
    return saved || findProject(cwd);
  }
  async function removeProject(cwd) {
    const found = await findProject(cwd),
      key = cwdKey(found.cwd);
    state.projects = state.projects.filter((p) => cwdKey(p.cwd) !== key);
    state.removedProjects = [...new Set([...state.removedProjects, key])];
    await save();
    return { removed: true, cwd: found.cwd };
  }
  async function patchSession(body) {
    return queueOrderOperation(async () => {
      await history(body.id);
      const patch = {};
      if (body.title !== undefined) {
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200)
          throw new HttpError(400, tr('server.le_titre_doit_contenir_entre_1_et_200_caracteres'));
        patch.title = body.title.trim();
      }
      for (const key of ['pinned', 'archived'])
        if (body[key] !== undefined) {
          if (typeof body[key] !== 'boolean') throw new HttpError(400, tr('server.valeur_invalide'));
          patch[key] = body[key];
        }
      const pinnedBefore = !!state.sessions[body.id]?.pinned;
      // Synced metadata (title/pin/archive): newest change wins across PCs.
      if (Object.keys(patch).length) patch.metaAt = Date.now();
      state.sessions[body.id] = { ...state.sessions[body.id], ...patch };
      if (body.pinned !== undefined && !!body.pinned !== pinnedBefore) {
        // Predictable pin/unpin: pinned to top of pinned, unpinned to top
        // of unpinned. Archived bucket unchanged; order stays stable otherwise.
        const { projects } = await overview();
        const owner = projects.find((p) => p.sessions.some((s) => s.id === body.id));
        if (owner) repositionSessionInOrder(cwdKey(owner.cwd), body.id, !!body.pinned);
      }
      await save();
      const { file, ...result } = await history(body.id);
      return result;
    });
  }
  // Sync engine: applies a project color received from another PC (newest wins).
  // ColorAt travels with the color; a reset (empty color) still carries its time.
  async function applyProjectColor(cwd, color, colorAt) {
    await init();
    const at = Number(colorAt) || 0;
    const key = cwdKey(cwd);
    const entry = state.projects.find((p) => cwdKey(p.cwd) === key);
    if (!entry) return false;
    if (at <= (Number(entry.colorAt) || 0)) return false;
    if (color === '' || color === undefined || color === null) delete entry.color;
    else {
      const normalized = normalizeProjectColor(color);
      if (normalized === null || normalized === '') return false;
      entry.color = normalized;
    }
    entry.colorAt = at;
    await save();
    return true;
  }
  // Sync engine: records an automatically resolved project id (not a manual link).
  async function setProjectSyncId(cwd, syncId) {
    await init();
    if (!SYNC_ID_RE.test(syncId)) throw new HttpError(400, tr('server.valeur_invalide'));
    const key = cwdKey(cwd);
    let entry = state.projects.find((p) => cwdKey(p.cwd) === key);
    if (!entry) {
      entry = { cwd: resolve(cwd), name: basename(cwd), pinned: false };
      state.projects.push(entry);
    }
    if (entry.syncId === syncId) return;
    entry.syncId = syncId;
    delete entry.syncManual;
    await save();
  }
  function sessionMeta(id) {
    const { title, pinned, archived, metaAt } = state.sessions?.[id] || {};
    const read = state.readReceipts?.[id];
    return {
      ...(title ? { title } : {}),
      pinned: !!pinned,
      archived: !!archived,
      metaAt: metaAt || 0,
      ...(typeof read === 'string' ? { read, readAt: state.readAt?.[id] || 0 } : {}),
    };
  }
  // Applies newer metadata received from another PC, keeping its timestamp.
  async function applySessionMeta(id, meta) {
    return queueOrderOperation(async () => {
      await init();
      if (!meta) return false;
      const current = state.sessions[id] || {};
      let changed = false;
      if (meta.metaAt > (current.metaAt || 0)) {
        const next = { ...current, pinned: !!meta.pinned, archived: !!meta.archived, metaAt: meta.metaAt };
        if (typeof meta.title === 'string' && meta.title.trim() && meta.title.length <= 200)
          next.title = meta.title;
        else delete next.title;
        state.sessions[id] = next;
        if (!!current.pinned !== !!next.pinned) {
          const { projects } = await overview();
          const owner = projects.find((p) => p.sessions.some((s) => s.id === id));
          if (owner) repositionSessionInOrder(cwdKey(owner.cwd), id, !!next.pinned);
        }
        changed = true;
      }
      // Read state: the latest read or "mark unread" wins across PCs.
      const local = state.readReceipts?.[id];
      if (typeof meta.read === 'string' && meta.read.length <= 200 && meta.read !== local) {
        const localAt = state.readAt?.[id] || 0,
          remoteAt = meta.readAt || 0;
        let take = remoteAt > localAt;
        if (!take && !localAt && !remoteAt && meta.read) {
          // Receipts from older builds carry no time: only move forward.
          const messages = (await history(id).catch(() => null))?.messages || [];
          const at = (answer) => messages.findIndex((m) => m.id === answer);
          take = at(meta.read) > at(local);
        }
        if (take && state.readReceipts) {
          state.readReceipts[id] = meta.read;
          (state.readAt ??= {})[id] = remoteAt;
          state.receiptRevision = (state.receiptRevision || 1) + 1;
          changed = true;
        }
      }
      if (changed) await save();
      return changed;
    });
  }
  return {
    init,
    async flush() {
      await preferenceWrites;
      await orderWrites;
      await writes;
    },
    sessionMeta,
    applySessionMeta,
    applyProjectColor,
    setProjectSyncId,
    async getStudioPreferences() {
      await init();
      const stored = state.preferences && typeof state.preferences === 'object' ? state.preferences : {};
      const backend = stored.computerBackend === 'cua' ? 'cua' : 'native';
      const model =
        typeof stored.computerModel === 'string' && stored.computerModel.length <= 500
          ? stored.computerModel
          : '';
      const thinking =
        typeof stored.computerThinking === 'string' && stored.computerThinking.length <= 20
          ? stored.computerThinking
          : '';
      return {
        allowQuestionsByDefault: stored.allowQuestionsByDefault !== false,
        computerBackend: backend,
        computerModel: model,
        computerThinking: thinking,
        revision: state.preferencesRevision || 0,
      };
    },
    async setStudioPreferences(patch) {
      const allowed = new Set([
        'allowQuestionsByDefault',
        'computerBackend',
        'computerModel',
        'computerThinking',
      ]);
      const keys = patch && typeof patch === 'object' && !Array.isArray(patch) ? Object.keys(patch) : [];
      const valid =
        keys.length >= 1 &&
        keys.length <= allowed.size &&
        keys.every((key) => allowed.has(key) && key !== '__proto__');
      if (!valid) throw new HttpError(400, tr('server.demande_invalide'));
      if ('allowQuestionsByDefault' in patch && typeof patch.allowQuestionsByDefault !== 'boolean')
        throw new HttpError(400, tr('server.demande_invalide'));
      if ('computerBackend' in patch && patch.computerBackend !== 'native' && patch.computerBackend !== 'cua')
        throw new HttpError(400, tr('server.demande_invalide'));
      if ('computerModel' in patch) {
        const model = patch.computerModel;
        if (typeof model !== 'string' || model.length > 500 || /[\x00-\x1f]/.test(model))
          throw new HttpError(400, tr('server.modele_invalide'));
      }
      for (const field of ['computerThinking']) {
        if (field in patch) {
          const level = patch[field];
          if (typeof level !== 'string' || level.length > 20 || /[\x00-\x1f]/.test(level))
            throw new HttpError(400, tr('server.niveau_de_reflexion_invalide'));
        }
      }
      const operation = preferenceWrites
        .catch(() => {})
        .then(async () => {
          await init();
          const previous = state.preferences,
            previousRevision = state.preferencesRevision || 0;
          state.preferences = { ...previous, ...patch };
          state.preferencesRevision = previousRevision + 1;
          try {
            await save();
          } catch (error) {
            state.preferences = previous;
            state.preferencesRevision = previousRevision;
            throw error;
          }
          const stored = state.preferences && typeof state.preferences === 'object' ? state.preferences : {};
          return {
            allowQuestionsByDefault: stored.allowQuestionsByDefault !== false,
            computerBackend: stored.computerBackend === 'cua' ? 'cua' : 'native',
            computerModel:
              typeof stored.computerModel === 'string' && stored.computerModel.length <= 500
                ? stored.computerModel
                : '',
            computerThinking:
              typeof stored.computerThinking === 'string' && stored.computerThinking.length <= 20
                ? stored.computerThinking
                : '',
            revision: state.preferencesRevision,
          };
        });
      preferenceWrites = operation;
      return operation;
    },
    async setConversationSettings(id, patch) {
      await history(id);
      const settings = { ...state.sessions[id]?.generationSettings, ...patch };
      const revision = (state.sessions[id]?.generationRevision || 0) + 1;
      state.sessions[id] = {
        ...state.sessions[id],
        generationSettings: settings,
        generationRevision: revision,
      };
      await save();
      return { settings, revision };
    },
    overview,
    history,
    project,
    findProject,
    knowledgeProject,
    removeProject,
    bindSessionWorktree,
    getSessionWorktree,
    worktreeSessions,
    forgetWorktreeProject,
    patchSession,
    markRead,
    markUnread,
    markPastudioOpened,
    moveProject,
    moveSession,
    sessionDir,
    inspectFile: (file) => scan(file, cache.has(file) ? cache : inspectedCache),
    // Additive .pastudio import marks (v1). New session IDs only; never overwrites existing local fields.
    // New imports auto-resolve the effective model (see project-archives
    // resolveEffectiveModel) so pastudioNeedsModel stays false; the legacy flag
    // remains only for pre-change imports and is honored by the gate only when
    // no usable effective model exists. Spreads preserve sibling sessionOrder.
    async markPastudioImported(ids, info = {}) {
      await init();
      const at = Number.isSafeInteger(info.importedAt) ? info.importedAt : Date.now();
      const archiveId = typeof info.archiveId === 'string' ? info.archiveId.slice(0, 200) : '';
      let changed = false;
      for (const sessionId of ids) {
        if (!validId(sessionId)) continue;
        const existing = state.sessions[sessionId];
        if (existing?.pastudioImported) continue;
        state.sessions[sessionId] = {
          ...existing,
          pastudioImported: true,
          pastudioNeedsModel: false,
          pastudioArchiveId: archiveId,
          pastudioImportedAt: at,
          pastudioOpenedAt: null,
        };
        changed = true;
      }
      if (changed) await save();
      // Auto-READ is initialized lazily in all() (missing receipts only) so the
      // selected-branch lastAnswer is used and future replies still unread.
      return { marked: true };
    },
    async unmarkPastudioImported(ids) {
      await init();
      let changed = false;
      for (const sessionId of ids) {
        if (!validId(sessionId)) continue;
        if (!state.sessions[sessionId]?.pastudioImported) continue;
        const {
          pastudioImported,
          pastudioNeedsModel,
          pastudioArchiveId,
          pastudioImportedAt,
          pastudioOpenedAt,
          ...rest
        } = state.sessions[sessionId];
        if (Object.keys(rest).length) state.sessions[sessionId] = rest;
        else delete state.sessions[sessionId];
        changed = true;
      }
      if (changed) await save();
      return { unmarked: true };
    },
    async consumePastudioModelGate(sessionId) {
      await init();
      if (!validId(sessionId)) return { consumed: false };
      if (!state.sessions[sessionId]?.pastudioNeedsModel) return { consumed: false };
      state.sessions[sessionId] = { ...state.sessions[sessionId], pastudioNeedsModel: false };
      await save();
      return { consumed: true };
    },
    // Atomic effective-model init (no overwrite of user PATCH, aligns with
    // conversation-settings locking): sets generationSettings.model ONLY when
    // no user model is present. Recovery replays call this, so concurrent user
    // edits after import are never last-writer-lost. Spread preserves sibling
    // sessionOrder and all pastudio* fields.
    async initPastudioEffectiveModel(id, model) {
      await init();
      if (!validId(id) || typeof model !== 'string' || !model || model.length > 500)
        return { initialized: false };
      const current = state.sessions[id];
      if (typeof current?.generationSettings?.model === 'string' && current.generationSettings.model)
        return { initialized: false, skipped: 'user-model-present' };
      state.sessions[id] = {
        ...current,
        generationSettings: { ...current?.generationSettings, model },
        generationRevision: (current?.generationRevision || 0) + 1,
      };
      await save();
      return { initialized: true };
    },
    pastudioNeedsModel(sessionId) {
      return !!state.sessions?.[sessionId]?.pastudioNeedsModel;
    },
  };
}
