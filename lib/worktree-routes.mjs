// Worktree HTTP adapter V1 for Prime Agent Studio.
// Service lib/worktrees.mjs owns Git mutations and worktrees.json locks/CAS.
// Store owns session metadata worktreeId+projectCwd (no registry sessionId writes here).
// Uses Git terms: worktree, branch, commit, diff, merge, fast-forward.
import { HttpError, cwdKey, validId } from './store.mjs';
import { isAbsolute, resolve, sep } from 'node:path';

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const ID_RE = /^wt-[0-9a-f]{12}$/;

const fail = (status, code, message) => Object.assign(new HttpError(status, message), { code });

function keyOf(value) {
  return process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
}

function isWithin(root, value) {
  try {
    const r = keyOf(root);
    const v = keyOf(value);
    return v === r || v.startsWith(r + sep);
  } catch {
    return false;
  }
}

function checkName(name) {
  if (name === undefined) return 'task';
  if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\0\r\n]/.test(name))
    throw fail(400, 'worktree_invalid', 'Task name must be 1 to 64 characters.');
  return name.trim().slice(0, 64);
}

function requireFullSha(value, field) {
  if (typeof value !== 'string' || !FULL_SHA_RE.test(value.trim()))
    throw fail(400, 'worktree_invalid', `${field} must be a full 40-hex commit SHA.`);
  return value.trim().toLowerCase();
}

export function createWorktreeRoutes({ store, worktrees, dataDir, activeRuns, sessionBusy, startRun }) {
  if (!store || !worktrees) throw new Error('worktree routes need store and worktrees service.');
  const runs = typeof activeRuns === 'function' ? activeRuns : () => [];
  const busySession = typeof sessionBusy === 'function' ? sessionBusy : () => false;
  const launch = typeof startRun === 'function' ? startRun : null;

  async function registeredProject(cwd) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw fail(400, 'worktree_invalid', 'cwd must be an absolute path.');
    return store.findProject(cwd);
  }

  function matchOwner(requestCwd, entry) {
    try {
      const q = keyOf(requestCwd);
      return q === keyOf(entry.projectCwd) || q === keyOf(entry.sourcePath);
    } catch {
      return false;
    }
  }

  async function enrich(entry) {
    let sessionId = typeof entry.sessionId === 'string' && validId(entry.sessionId) ? entry.sessionId : null;
    try {
      const bound = await store.worktreeSessions(entry.id);
      if (Array.isArray(bound) && bound.length && validId(bound[0].id)) sessionId = bound[0].id;
    } catch {}
    return { ...entry, sessionId };
  }

  async function enrichInspect(detail) {
    const worktree = await enrich(detail.worktree);
    return { ...detail, worktree };
  }

  async function loadOwned({ id, cwd }) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw fail(404, 'worktree_missing', 'Worktree not found.');
    const project = await registeredProject(cwd);
    const detail = await worktrees.inspect({ id });
    const entry = detail.worktree;
    if (!matchOwner(project.cwd, entry) && !matchOwner(cwd, entry))
      throw fail(404, 'worktree_missing', 'Worktree not found.');
    return { project, detail, entry };
  }

  async function findByPath(taskPath) {
    try {
      if (typeof worktrees.findByPath === 'function') return await worktrees.findByPath({ path: taskPath });
      return null;
    } catch (error) {
      if (error?.status) throw error;
      return null;
    }
  }

  function taskBusy(taskPath, sessionId) {
    if (sessionId && busySession(sessionId)) return true;
    return runs().some((run) => {
      try {
        return keyOf(run.cwd) === keyOf(taskPath) && (run.status === 'running' || run.status === 'stopping');
      } catch {
        return false;
      }
    });
  }

  function buildPreparePrompt({ entry, expectedSourceHead, expectedWorktreeHead, custom }) {
    const base = typeof custom === 'string' && custom.trim() ? custom.trim().slice(0, 8000) : '';
    const guide =
      `Prepare the Git worktree merge. Work only in the task worktree, never edit the original checkout.\n` +
      `Task worktree: ${entry.path} (branch ${entry.branch}). Original checkout: ${entry.sourcePath} (branch ${entry.sourceBranch}).\n` +
      `Recorded source HEAD ${expectedSourceHead}, recorded task HEAD ${expectedWorktreeHead}.\n` +
      `1) Inspect git status and the bounded diff. 2) Commit only intended task files with git add plus git commit; skip secrets, .env, ignored files and unrelated edits; never commit in the original checkout. ` +
      `3) Merge the recorded source SHA into the task branch with git merge ${expectedSourceHead}, resolve conflicts in the task worktree, run relevant checks. ` +
      `4) Report functional ambiguities. Never touch the original checkout directly, never push, never fast-forward the original branch here. The final fast-forward merge needs explicit user confirmation.`;
    return base ? `${base}\n\n${guide}` : guide;
  }

  return {
    managedRoot: worktrees.managedRoot,
    findByPath,
    isTaskPath(value) {
      try {
        return !!worktrees.managedRoot && isWithin(worktrees.managedRoot, resolve(String(value)));
      } catch {
        return false;
      }
    },
    async list(cwd) {
      const project = await registeredProject(cwd);
      const result = await worktrees.list({ projectCwd: project.cwd });
      const enriched = [];
      for (const entry of result.worktrees || []) enriched.push(await enrich(entry));
      return { worktrees: enriched };
    },
    async create({ cwd, name }) {
      const project = await registeredProject(cwd);
      const label = checkName(name);
      const result = await worktrees.create({ projectCwd: project.cwd, name: label });
      try {
        await store.forgetWorktreeProject(result.worktree.path);
      } catch {}
      const worktree = await enrich(result.worktree);
      return { worktree, sourceDirty: !!result.sourceDirty, baseCommit: result.baseCommit };
    },
    async inspect({ id, cwd }) {
      const { detail } = await loadOwned({ id, cwd });
      return enrichInspect(detail);
    },
    async integrate({ id, cwd, revision, confirm, expectedSourceHead, expectedWorktreeHead }) {
      const { entry } = await loadOwned({ id, cwd });
      if (typeof revision !== 'string' || !revision)
        throw fail(409, 'worktree_conflict', 'Revision is required, re-inspect the worktree diff and retry.');
      if (revision !== entry.revision)
        throw fail(409, 'worktree_conflict', 'Worktree changed, re-inspect the worktree diff and retry.');
      if (confirm !== true) throw fail(400, 'worktree_invalid', 'Fast-forward merge requires explicit confirmation.');
      const sourceHead = requireFullSha(expectedSourceHead, 'expectedSourceHead');
      const taskHead = requireFullSha(expectedWorktreeHead, 'expectedWorktreeHead');
      try {
        return await worktrees.integrate({ id: entry.id, revision, confirm: true, expectedSourceHead: sourceHead, expectedWorktreeHead: taskHead });
      } catch (error) {
        if (error?.code === 'worktree_dirty' && /Source checkout/i.test(error.message || ''))
          throw Object.assign(
            new HttpError(error.status || 409, `${error.message} You can ask the normal project agent to handle the original checkout separately; Studio never commits the original checkout automatically.`),
            { code: 'worktree_dirty' },
          );
        throw error;
      }
    },
    async remove({ id, cwd, revision, confirm, discard }) {
      const { entry } = await loadOwned({ id, cwd });
      if (typeof revision !== 'string' || !revision)
        throw fail(409, 'worktree_conflict', 'Revision is required, re-inspect and retry.');
      if (revision !== entry.revision)
        throw fail(409, 'worktree_conflict', 'Worktree changed, re-inspect and retry.');
      if (confirm !== true) throw fail(400, 'worktree_invalid', 'Worktree removal requires explicit confirmation.');
      return worktrees.remove({ id: entry.id, revision, confirm: true, discard });
    },
    async prepare({ id, cwd, revision, confirm, expectedSourceHead, expectedWorktreeHead, message, model, sessionId }) {
      if (!launch) throw fail(500, 'worktree_invalid', 'Agent runtime is unavailable.');
      const { detail, entry } = await loadOwned({ id, cwd });
      if (typeof revision !== 'string' || !revision)
        throw fail(409, 'worktree_conflict', 'Revision is required, re-inspect the worktree diff and retry.');
      if (revision !== entry.revision)
        throw fail(409, 'worktree_conflict', 'Worktree changed, re-inspect the worktree diff and retry.');
      if (confirm !== true) throw fail(400, 'worktree_invalid', 'Agent preparation requires explicit confirmation.');
      const sourceHead = requireFullSha(expectedSourceHead, 'expectedSourceHead');
      const taskHead = requireFullSha(expectedWorktreeHead, 'expectedWorktreeHead');
      if (detail.orphaned || !detail.main || !detail.task)
        throw fail(409, 'worktree_missing', 'Worktree is orphaned, cannot start the agent.');
      if (detail.main.branch && detail.main.branch !== entry.sourceBranch)
        throw fail(409, 'worktree_conflict', `Original branch switched to "${detail.main.branch}", expected "${entry.sourceBranch}".`);
      if (detail.main.head && detail.main.head.toLowerCase() !== sourceHead.toLowerCase())
        throw fail(409, 'worktree_conflict', 'Original commit changed since viewing the diff, re-inspect and retry.');
      if (detail.task.head && detail.task.head.toLowerCase() !== taskHead.toLowerCase())
        throw fail(409, 'worktree_conflict', 'Task commit changed since viewing the diff, re-inspect and retry.');
      let targetSession = null;
      if (sessionId !== undefined && sessionId !== null && sessionId !== '') {
        if (!validId(sessionId)) throw fail(400, 'worktree_invalid', 'Invalid sessionId.');
        const meta = await store.getSessionWorktree(sessionId);
        if (meta && meta.worktreeId !== entry.id)
          throw fail(409, 'worktree_conflict', 'Session belongs to another worktree.');
        const history = await store.history(sessionId).catch(() => null);
        if (!history) throw fail(404, 'worktree_missing', 'Session not found.');
        try {
          if (keyOf(history.cwd) !== keyOf(entry.path))
            throw fail(409, 'worktree_conflict', 'Session belongs to another folder.');
        } catch (e) {
          if (e?.status) throw e;
          throw fail(409, 'worktree_conflict', 'Session belongs to another folder.');
        }
        targetSession = sessionId;
      } else {
        try {
          const bound = await store.worktreeSessions(entry.id);
          if (Array.isArray(bound) && bound.length && validId(bound[0].id)) targetSession = bound[0].id;
        } catch {}
        if (!targetSession && typeof entry.sessionId === 'string' && validId(entry.sessionId)) targetSession = entry.sessionId;
      }
      if (taskBusy(entry.path, targetSession))
        throw fail(409, 'worktree_busy', 'Task worktree agent is already running.');
      const prompt = buildPreparePrompt({ entry, expectedSourceHead: sourceHead, expectedWorktreeHead: taskHead, custom: message });
      return launch({ cwd: entry.path, ...(targetSession ? { sessionId: targetSession } : {}), message: prompt, ...(typeof model === 'string' && model ? { model } : {}) });
    },
  };
}
