import { formatMessage as tr } from '../public/i18n-core.js';
import { nativeAgentMessage } from '../public/agent-messages.js';
import { lastAnswer } from '../public/session-activity.js';
import { readFile, readdir, stat, mkdir, writeFile, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { imageAttachments, imageMessageText } from './images.mjs';
import { splitFileMessage } from './files.mjs';
import { basename, join, resolve, isAbsolute } from 'node:path';

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

function sessionMessages(entries, branch = selectedBranch(entries)) {
  const messages = [],
    calls = new Map();
  for (const e of branch) {
    const m = e.message;
    if (e.type === 'compaction' || e.type === 'branch_summary') {
      messages.push({ id: e.id, role: 'system', text: e.summary || '', timestamp: e.timestamp, tools: [] });
    }
    if (e.type === 'custom_message' && e.display) {
      messages.push({
        ...(nativeAgentMessage(e) ? { agentMessage: nativeAgentMessage(e) } : {}),
        id: e.id,
        role: e.customType === 'session_slash_command' ? 'user' : 'system',
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
      messages.push({
        ...(nativeAgentMessage(m) ? { agentMessage: nativeAgentMessage(m) } : {}),
        id: e.id,
        role: m.customType === 'session_slash_command' ? 'user' : 'system',
        text: textOf(m.content),
        tools: [],
        timestamp: e.timestamp,
      });
    }
  }
  for (const e of entries)
    if (e.type === 'child_usage_attributed' && e.aggregateUsage) {
      const target = messages.find((m) => m.id === e.targetId);
      if (target) target.usage = e.aggregateUsage;
    }
  return messages;
}

export function createStore({ sessionDir, dataDir, initialCwd }) {
  const stateFile = join(dataDir, 'workspace.json');
  let state,
    writes = Promise.resolve(),
    preferenceWrites = Promise.resolve(),
    orderWrites = Promise.resolve();
  const cache = new Map();
  async function init() {
    if (state) return;
    try {
      state = JSON.parse(await readFile(stateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(tr('server.impossible_de_lire_les_preferences_locales') + error.message);
      state = { projects: [], sessions: {} };
    }
    state.projects = Array.isArray(state.projects) ? state.projects : [];
    state.sessions = state.sessions && typeof state.sessions === 'object' ? state.sessions : {};
    state.removedProjects = Array.isArray(state.removedProjects) ? state.removedProjects : [];
    if (!state.sessionOrder || typeof state.sessionOrder !== 'object' || Array.isArray(state.sessionOrder))
      state.sessionOrder = {};
    if (!state.projects.length && initialCwd && !state.removedProjects.includes(cwdKey(initialCwd)))
      state.projects.push({ cwd: resolve(initialCwd), name: basename(initialCwd), pinned: true });
  }
  async function save() {
    const contents = JSON.stringify(state, null, 2) + '\n';
    const write = writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dataDir, { recursive: true });
        const temp = stateFile + '.tmp';
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
  async function scan(file) {
    const info = await stat(file).catch(() => null);
    if (!info) return null;
    const existing = cache.get(file);
    if (existing?.size === info.size && existing?.mtime === info.mtimeMs) return existing.value;
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
      messages,
    };
    cache.set(file, { size: info.size, mtime: info.mtimeMs, value });
    return value;
  }
  async function all() {
    await init();
    const paths = await files();
    for (const key of cache.keys()) if (!paths.includes(key)) cache.delete(key);
    const sessions = [];
    for (let i = 0; i < paths.length; i += 12)
      sessions.push(...(await Promise.all(paths.slice(i, i + 12).map(scan))));
    const found = sessions.filter(Boolean).map((s) => ({ ...s, ...state.sessions[s.id] }));
    if (!state.readReceipts) {
      // One shared starting point for existing history, instead of a backlog on each new device.
      state.readReceipts = Object.fromEntries(found.map((s) => [s.id, lastAnswer(s.messages)?.id || '']));
      state.receiptRevision = 1;
      await save();
    } else {
      // Imported auto-READ (no blue dot): initialize once at import visibility.
      // Only fills MISSING receipts so future replies still turn unread.
      // Never overwrites an existing receipt (recovery must not reset after
      // user messages). Uses the actual selected-branch lastAnswer.
      let initialized = false;
      for (const s of found) {
        if (s?.pastudioImported === true && state.readReceipts[s.id] === undefined) {
          state.readReceipts[s.id] = lastAnswer(s.messages)?.id || '';
          initialized = true;
        }
      }
      if (initialized) await save();
    }
    return found.map((s) => ({ ...s, readState: activity(s) }));
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
          receiptChanged = true;
        }
      }
    }
    if (receiptChanged || openedChanged) await save();
    const refreshed = openedChanged ? await history(id).catch(() => session) : session;
    return { id, readState: activity(refreshed) };
  }
  async function history(id) {
    if (!validId(id)) throw new HttpError(400, tr('server.identifiant_de_session_invalide'));
    const found = (await all()).find((s) => s.id === id);
    if (!found) throw new HttpError(404, tr('server.session_introuvable'));
    return found;
  }
  async function overview() {
    const sessions = await all();
    const removed = new Set(state.removedProjects);
    const projects = new Map(
      state.projects
        .filter((p) => !removed.has(cwdKey(p.cwd)))
        .map((p) => [cwdKey(p.cwd), { ...p, sessions: [] }]),
    );
    for (const s of sessions) {
      if (!s.cwd) continue;
      const key = cwdKey(s.cwd);
      if (removed.has(key)) continue;
      if (!projects.has(key))
        projects.set(key, { cwd: s.cwd, name: basename(s.cwd), pinned: false, sessions: [] });
      const { messages, file, ...summary } = s;
      projects.get(key).sessions.push(summary);
    }
    let sessionOrderChanged = false;
    for (const p of projects.values()) {
      p.exists = !!(await stat(p.cwd).catch(() => null))?.isDirectory();
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
      const to = anchored
        ? ordered.findIndex((s) => s.id === targetId)
        : from + direction;
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
      if (fromGroup < 0 || toGroup < 0 || !group[toGroup]) throw new HttpError(409, tr('sessions.invalid_order'));
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
    let entry = state.projects.find((p) => cwdKey(p.cwd) === key);
    if (!entry) {
      entry = { cwd, name: basename(cwd), pinned: !update };
      state.projects.push(entry);
    }
    Object.assign(entry, patch);
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
  return {
    init,
    async getStudioPreferences() {
      await init();
      return {
        allowQuestionsByDefault: state.preferences?.allowQuestionsByDefault !== false,
        revision: state.preferencesRevision || 0,
      };
    },
    async setStudioPreferences(patch) {
      if (
        !patch ||
        typeof patch !== 'object' ||
        Array.isArray(patch) ||
        Object.keys(patch).length !== 1 ||
        typeof patch.allowQuestionsByDefault !== 'boolean'
      )
        throw new HttpError(400, tr('server.demande_invalide'));
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
          return {
            allowQuestionsByDefault: state.preferences.allowQuestionsByDefault,
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
    patchSession,
    markRead,
    markPastudioOpened,
    moveProject,
    moveSession,
    sessionDir,
    inspectFile: scan,
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
        const { pastudioImported, pastudioNeedsModel, pastudioArchiveId, pastudioImportedAt, pastudioOpenedAt, ...rest } =
          state.sessions[sessionId];
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
      if (!validId(id) || typeof model !== 'string' || !model || model.length > 500) return { initialized: false };
      const current = state.sessions[id];
      if (typeof current?.generationSettings?.model === 'string' && current.generationSettings.model) return { initialized: false, skipped: 'user-model-present' };
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
