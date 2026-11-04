import { HttpError, cwdKey, validId } from './store.mjs';
import { canResumeGoal, publicGoal } from './goal-state.mjs';
import { isClearedGoal } from './saved-goal-client.mjs';
import { isAbsolute } from 'node:path';

export function validateGoalControl(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !['cwd', 'goalId', 'expectedObjective'].includes(key)) ||
    typeof body.cwd !== 'string' ||
    !isAbsolute(body.cwd) ||
    body.cwd.includes('\0') ||
    body.cwd.length > 32768 ||
    !validId(body.goalId) ||
    typeof body.expectedObjective !== 'string' ||
    !body.expectedObjective.trim() ||
    body.expectedObjective.includes('\0') ||
    [...body.expectedObjective].length > 4000
  )
    throw new HttpError(400, 'Invalid goal action. Reload the goal and try again.');
  return { ...body };
}

/** Read-only compare-and-set check before admitting a new visible run. */
export function validateGoalResume(history, input) {
  const goal = publicGoal(history?.goal);
  if (!history?.cwd || cwdKey(input.cwd) !== cwdKey(history.cwd))
    throw new HttpError(409, 'This goal belongs to another project.');
  if (
    !canResumeGoal(history?.goal) ||
    !goal ||
    goal.goalId !== input.goalId ||
    goal.objective !== input.expectedObjective
  )
    throw new HttpError(409, 'The goal changed or cannot be resumed. Reload the goal.');
  return goal;
}

export function validateGoalEdit(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !['cwd', 'goalId', 'expectedObjective', 'objective'].includes(key)) ||
    typeof body.cwd !== 'string' ||
    !isAbsolute(body.cwd) ||
    body.cwd.includes('\0') ||
    body.cwd.length > 32768 ||
    !validId(body.goalId) ||
    typeof body.expectedObjective !== 'string' ||
    !body.expectedObjective.trim() ||
    typeof body.objective !== 'string' ||
    !body.objective.trim() ||
    body.objective.includes('\0') ||
    [...body.objective].length > 4000 ||
    [...body.expectedObjective].length > 4000
  )
    throw new HttpError(400, 'Enter a goal of 1–4000 characters.');
  return { ...body, objective: body.objective.trim() };
}

/** Goal state belongs to the native session; Studio never writes its JSONL. */
export function createSessionGoals({
  store,
  getRuns,
  getClient,
  getSavedCapabilities,
  editSavedGoal,
  controlSavedGoal,
  stopRun,
  isAdmitting = () => false,
}) {
  const pending = new Set();
  const runFor = (id) =>
    getRuns().findLast((run) => run.sessionId === id && ['running', 'stopping'].includes(run.status));
  const resumeAvailability = (id, goal, capabilities) => {
    if (!canResumeGoal(goal) || capabilities?.resumable !== true) return {};
    const run = runFor(id);
    if (run) return { resumeBlocked: run.status };
    if (isAdmitting(id)) return { resumeBlocked: 'busy' };
    return { resumable: true };
  };
  async function get(id) {
    const history = await store.history(id);
    const persisted = publicGoal(history.goal);
    const caps =
      persisted && typeof getSavedCapabilities === 'function' ? await getSavedCapabilities() : null;
    const run = runFor(id);
    if (!run) {
      return {
        goal: persisted,
        editable:
          !!persisted && !isAdmitting(id) && caps?.editable === true && typeof editSavedGoal === 'function',
        ...(persisted &&
          !isAdmitting(id) &&
          caps?.controllable === true &&
          typeof controlSavedGoal === 'function' && { controllable: true }),
        ...resumeAvailability(id, history.goal, caps),
      };
    }
    if (run.status !== 'running')
      return {
        goal: persisted,
        editable: false,
        ...resumeAvailability(id, history.goal, caps),
      };
    const client = getClient();
    try {
      if (!client?.getGoal)
        return {
          goal: persisted,
          editable: false,
          ...resumeAvailability(id, history.goal, caps),
        };
      const snapshot = await client.getGoal(id, history.cwd);
      const goal = publicGoal(snapshot.goal);
      return {
        goal,
        editable: !!goal && snapshot.editable === true,
        ...(goal && snapshot.controllable === true && { controllable: true }),
        ...resumeAvailability(id, snapshot.goal, caps),
      };
    } catch (error) {
      if ([404, 409, 503].includes(error.status))
        return {
          goal: persisted,
          editable: false,
          ...resumeAvailability(id, history.goal, caps),
        };
      throw error;
    } finally {
      client?.close?.();
    }
  }
  async function update(id, body) {
    const input = validateGoalEdit(body);
    if (!validId(id)) throw new HttpError(400, 'Invalid session.');
    if (pending.has(id) || isAdmitting(id)) throw new HttpError(409, 'This session is changing. Try again.');
    pending.add(id);
    try {
      const history = await store.history(id);
      if (typeof history.cwd !== 'string' || cwdKey(input.cwd) !== cwdKey(history.cwd))
        throw new HttpError(409, 'This goal belongs to another project.');
      const run = runFor(id);
      if (run?.status === 'stopping')
        throw new HttpError(409, 'The agent is stopping. Try again when it has stopped.');
      let result, caps;
      if (run) {
        const client = getClient();
        try {
          if (!client?.editGoal) throw new HttpError(503, 'Goal editing is unavailable in this engine.');
          caps = await client.getGoal?.(id, history.cwd);
          result = await client.editGoal(id, history.cwd, input);
        } finally {
          client?.close?.();
        }
      } else {
        if (typeof editSavedGoal !== 'function')
          throw new HttpError(503, 'Goal editing is unavailable in this engine.');
        result = await editSavedGoal({
          ...input,
          sessionId: id,
          sessionFile: history.file,
          cwd: history.cwd,
        });
      }
      const goal = publicGoal(result);
      if (!goal || goal.goalId !== input.goalId || goal.objective !== input.objective)
        throw new HttpError(
          503,
          'The engine did not confirm the goal edit. Reload the goal before retrying.',
        );
      if (!run && typeof getSavedCapabilities === 'function') caps = await getSavedCapabilities();
      return {
        goal,
        editable: true,
        ...(caps?.controllable === true && { controllable: true }),
        ...resumeAvailability(id, result, caps),
      };
    } finally {
      pending.delete(id);
    }
  }
  async function control(id, action, body) {
    if (!['stop', 'clear'].includes(action) || !validId(id)) throw new HttpError(400, 'Invalid goal action.');
    const input = validateGoalControl(body);
    if (pending.has(id) || isAdmitting(id)) throw new HttpError(409, 'This session is changing. Try again.');
    pending.add(id);
    try {
      const history = await store.history(id);
      if (typeof history.cwd !== 'string' || cwdKey(input.cwd) !== cwdKey(history.cwd))
        throw new HttpError(409, 'This goal belongs to another project.');
      const run = runFor(id);
      if (run?.status === 'stopping')
        throw new HttpError(409, 'The agent is stopping. Try again when it has stopped.');
      const command = { ...input, action: action === 'stop' ? 'pause' : 'clear' };
      let result;
      if (run) {
        const client = getClient();
        try {
          if (!client?.controlGoal) throw new HttpError(503, 'Goal controls are unavailable in this engine.');
          result = await client.controlGoal(id, history.cwd, command);
        } finally {
          client?.close?.();
        }
      } else {
        if (typeof controlSavedGoal !== 'function')
          throw new HttpError(503, 'Goal controls are unavailable in this engine.');
        result = await controlSavedGoal({
          ...command,
          sessionId: id,
          sessionFile: history.file,
          cwd: history.cwd,
        });
      }
      const goal = publicGoal(result);
      if (
        action === 'clear'
          ? !isClearedGoal(result)
          : !goal ||
            goal.goalId !== input.goalId ||
            goal.objective !== input.expectedObjective ||
            goal.status !== 'paused'
      )
        throw new HttpError(503, 'The engine did not confirm the goal change. Reload before retrying.');
      // Persist the goal change before stopping its turn, so restart/resume cannot
      // bring back the old active goal. A rejected stale dialog never cancels a run.
      if (run && stopRun) await stopRun(run);
      const caps = goal && typeof getSavedCapabilities === 'function' ? await getSavedCapabilities() : null;
      return {
        goal,
        editable: !!goal && caps?.editable === true,
        controllable: !!goal && caps?.controllable === true,
        ...resumeAvailability(id, result, caps),
      };
    } finally {
      pending.delete(id);
    }
  }
  return { get, update, control, busy: (id) => pending.has(id) };
}
