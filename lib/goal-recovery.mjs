import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { cwdKey, validId } from './store.mjs';
import { publicGoal } from './goal-state.mjs';

export function validateRecoveryHistory(history, expected) {
  const goal = publicGoal(history?.goal);
  if (
    !history ||
    history.id !== expected.sessionId ||
    history.archived ||
    history.parentSession ||
    history.parentSessionId ||
    history.isChild ||
    (history.rootSessionId && history.rootSessionId !== history.id) ||
    !isAbsolute(history.file || '') ||
    cwdKey(history.file) !== cwdKey(expected.file) ||
    !isAbsolute(history.cwd || '') ||
    cwdKey(history.cwd) !== cwdKey(expected.cwd) ||
    (expected.goalId === null
      ? history.goal != null ||
        history.goalEverKnown === true ||
        history.messages?.findLast((m) => m.role === 'user')?.id !== expected.userId
      : !goal?.active || goal.goalId !== expected.goalId)
  )
    throw Object.assign(new Error('The saved task changed during recovery admission.'), {
      status: 409,
      code: 'goal_recovery_ineligible',
    });
}

/** Durable run intent, not a scan that revives historical active goals. */
export function createGoalRecovery({ dataDir, store, startRun, isBusy, onError = () => {} }) {
  const file = join(dataDir, 'goal-recovery.json');
  let entries = Object.create(null);
  let initialized = false;
  let corrupt;
  let closed = false;
  let writes = Promise.resolve();
  let recovery;
  const suppressed = new Set();
  const attempted = new Set();
  const report = (error) => {
    try {
      onError(error);
    } catch {}
  };
  function validEntry(value) {
    return (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      validId(value.sessionId) &&
      typeof value.cwd === 'string' &&
      value.cwd.length <= 32768 &&
      !/[\x00-\x1f]/.test(value.cwd) &&
      isAbsolute(value.cwd) &&
      validId(value.revision) &&
      (value.model == null ||
        (typeof value.model === 'string' && value.model.length <= 500 && !/[\x00-\x1f]/.test(value.model))) &&
      (value.thinking == null ||
        ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.thinking)) &&
      (value.goalId == null || validId(value.goalId)) &&
      (!Object.hasOwn(value, 'previousUserId') ||
        value.previousUserId == null ||
        validId(value.previousUserId)) &&
      (!Object.hasOwn(value, 'acceptedUserId') ||
        value.acceptedUserId == null ||
        validId(value.acceptedUserId)) &&
      typeof value.allowQuestions === 'boolean' &&
      Object.keys(value).every((key) =>
        [
          'sessionId',
          'cwd',
          'model',
          'thinking',
          'allowQuestions',
          'revision',
          'goalId',
          'previousUserId',
          'acceptedUserId',
        ].includes(key),
      )
    );
  }
  async function init() {
    if (initialized) {
      if (corrupt) throw corrupt;
      return;
    }
    initialized = true;
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (
        value?.version !== 1 ||
        !value.entries ||
        typeof value.entries !== 'object' ||
        Array.isArray(value.entries) ||
        Object.keys(value).some((key) => !['version', 'entries'].includes(key)) ||
        Object.entries(value.entries).some(([id, entry]) => id !== entry?.sessionId || !validEntry(entry))
      )
        throw new Error('Invalid goal recovery journal; automatic recovery is disabled.');
      entries = Object.assign(Object.create(null), value.entries);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      corrupt = new Error('Goal recovery journal is unreadable; automatic recovery is disabled.', {
        cause: error,
      });
      report(corrupt);
      throw corrupt;
    }
  }
  function queue(task) {
    const result = writes.then(async () => {
      await init();
      return task();
    });
    writes = result.catch(() => {});
    return result;
  }
  async function save() {
    await mkdir(dataDir, { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, entries }) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async function remove(entry) {
    return queue(async () => {
      if (entries[entry.sessionId]?.revision !== entry.revision) return;
      delete entries[entry.sessionId];
      try {
        await save();
      } catch (error) {
        entries[entry.sessionId] = entry;
        throw error;
      }
    });
  }
  const eligibleGoal = (raw) => {
    const goal = publicGoal(raw);
    if (
      !goal?.active ||
      goal.status !== 'active' ||
      (raw?.tokenBudget != null &&
        (!Number.isSafeInteger(raw.tokenBudget) ||
          raw.tokenBudget <= 0 ||
          goal.tokensUsed >= raw.tokenBudget)) ||
      (raw?.noProgressStreak != null &&
        (!Number.isSafeInteger(raw.noProgressStreak) ||
          raw.noProgressStreak < 0 ||
          raw.noProgressStreak >= 3))
    )
      return null;
    return goal;
  };
  async function candidate(entry) {
    const overview = await store.overview();
    const owner = overview.projects?.find(
      (project) =>
        project.exists === true &&
        project.sessions?.some((session) => session.id === entry.sessionId && !session.archived),
    );
    if (!owner) return null;
    const summary = owner.sessions.find((session) => session.id === entry.sessionId);
    if (
      summary.parentSession ||
      summary.parentSessionId ||
      (summary.rootSessionId && summary.rootSessionId !== entry.sessionId) ||
      summary.isChild === true
    )
      return null;
    const history = await store.history(entry.sessionId);
    if (
      history.id !== entry.sessionId ||
      !isAbsolute(history.file || '') ||
      !isAbsolute(history.cwd || '') ||
      cwdKey(history.cwd) !== cwdKey(entry.cwd) ||
      history.archived ||
      history.parentSession ||
      history.parentSessionId ||
      (history.rootSessionId && history.rootSessionId !== entry.sessionId) ||
      history.isChild === true
    )
      return null;
    if (history.goal == null) {
      if (entry.goalId != null || history.goalEverKnown === true) return null;
      const userId = history.messages?.findLast((message) => message.role === 'user')?.id;
      if (!validId(userId)) return null;
      // A bridge-ready receipt may precede the actual prompt's durable user
      // entry. Recover only the accepted task, never its predecessor.
      if (
        entry.acceptedUserId != null
          ? userId !== entry.acceptedUserId
          : !Object.hasOwn(entry, 'previousUserId') || userId === entry.previousUserId
      )
        return null;
      return { history, goal: null, userId };
    }
    const goal = eligibleGoal(history.goal);
    return goal && (entry.goalId == null || goal.goalId === entry.goalId) ? { history, goal } : null;
  }
  async function recoverInner() {
    let snapshot;
    try {
      snapshot = await queue(() => Object.values(entries));
    } catch {
      return { started: 0, skipped: 0 };
    }
    let started = 0,
      skipped = 0;
    for (const entry of snapshot) {
      if (closed) break;
      if (suppressed.has(entry.sessionId) || attempted.has(entry.sessionId)) {
        skipped++;
        continue;
      }
      try {
        const initial = await candidate(entry);
        if (!initial) {
          await remove(entry);
          skipped++;
          continue;
        }
        if (
          closed ||
          suppressed.has(entry.sessionId) ||
          entries[entry.sessionId]?.revision !== entry.revision
        ) {
          skipped++;
          continue;
        }
        if (await isBusy(entry.sessionId)) {
          skipped++;
          continue;
        }
        // Re-read after asynchronous discovery: branch goal or ownership may
        // have changed, while a manual stop blocks immediately before its write.
        const fresh = await candidate(entry);
        if (
          !fresh ||
          fresh.goal?.goalId !== initial.goal?.goalId ||
          (fresh.goal == null && fresh.userId !== initial.userId)
        ) {
          await remove(entry);
          skipped++;
          continue;
        }
        await writes;
        if (
          closed ||
          suppressed.has(entry.sessionId) ||
          attempted.has(entry.sessionId) ||
          entries[entry.sessionId]?.revision !== entry.revision ||
          (await isBusy(entry.sessionId))
        ) {
          skipped++;
          continue;
        }
        if (
          closed ||
          suppressed.has(entry.sessionId) ||
          entries[entry.sessionId]?.revision !== entry.revision
        ) {
          skipped++;
          continue;
        }
        attempted.add(entry.sessionId);
        // Current saved settings, validated by server admission, win over an
        // old run's model/reasoning choices after a restart.
        const input = { sessionId: entry.sessionId, cwd: entry.cwd, allowQuestions: entry.allowQuestions };
        await startRun(input, fresh.goal, {
          sessionId: entry.sessionId,
          cwd: entry.cwd,
          file: fresh.history.file,
          goalId: fresh.goal?.goalId ?? null,
          userId: fresh.userId ?? null,
        });
        started++;
      } catch (error) {
        report(error);
        skipped++;
      }
    }
    return { started, skipped };
  }
  return {
    recordRun(input) {
      const entry = {
        sessionId: input.sessionId,
        cwd: input.cwd,
        model: input.model ?? null,
        thinking: input.thinking ?? null,
        allowQuestions: input.allowQuestions === true,
        revision: input.runId,
        goalId: input.goalId ?? null,
        ...(Object.hasOwn(input, 'previousUserId') ? { previousUserId: input.previousUserId } : {}),
        ...(Object.hasOwn(input, 'acceptedUserId') ? { acceptedUserId: input.acceptedUserId } : {}),
      };
      if (!validEntry(entry)) return Promise.reject(new Error('Invalid recoverable run identity.'));
      return queue(async () => {
        if (closed) throw new Error('Goal recovery is closed.');
        const prior = entries[entry.sessionId];
        entries[entry.sessionId] = entry;
        try {
          await save();
          suppressed.delete(entry.sessionId);
        } catch (error) {
          if (prior) entries[entry.sessionId] = prior;
          else delete entries[entry.sessionId];
          throw error;
        }
      });
    },
    updateGoal({ sessionId, runId, goalId }) {
      if (!validId(sessionId) || !validId(runId) || !validId(goalId))
        return Promise.reject(new Error('Invalid recoverable goal identity.'));
      return queue(async () => {
        const prior = entries[sessionId];
        if (closed || suppressed.has(sessionId) || !prior || prior.revision !== runId) return false;
        if (prior.goalId === goalId) return true;
        entries[sessionId] = { ...prior, goalId };
        try {
          await save();
        } catch (error) {
          entries[sessionId] = prior;
          throw error;
        }
        return true;
      });
    },
    retire(sessionId, runId) {
      if (!validId(sessionId) || !validId(runId))
        return Promise.reject(new Error('Invalid completed run identity.'));
      // Completion is not a manual stop. Delete only this exact run's intent,
      // so late completion of an older run cannot retire its successor.
      return remove({ sessionId, revision: runId });
    },
    suppress(sessionId) {
      if (!validId(sessionId)) return Promise.reject(new Error('Invalid session identity.'));
      suppressed.add(sessionId);
      return queue(async () => {
        const prior = entries[sessionId];
        delete entries[sessionId];
        try {
          await save();
        } catch (error) {
          if (prior) entries[sessionId] = prior;
          throw error;
        }
      });
    },
    recover() {
      if (closed) return Promise.resolve({ started: 0, skipped: 0 });
      if (!recovery)
        recovery = recoverInner().finally(() => {
          recovery = null;
        });
      return recovery;
    },
    flush: () => writes,
    async close() {
      closed = true;
      await writes;
      await recovery;
    },
  };
}
