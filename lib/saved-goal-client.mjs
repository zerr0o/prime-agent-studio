import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const samePath = (left, right) =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  (process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right));

export class SavedGoalError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const unavailable = () =>
  new SavedGoalError(503, 'The native goal editor is unavailable.', 'native_unavailable');
const conflict = () =>
  new SavedGoalError(409, 'The saved goal changed or its session is active.', 'goal_conflict');
const uncertain = () =>
  new SavedGoalError(
    503,
    'The native goal edit could not be confirmed. Refresh before retrying.',
    'delivery_uncertain',
  );

/** A read-only hello probe. Older engines remain visible but never gain edit buttons. */
export async function savedGoalCapabilities(options, dependencies = {}) {
  if (
    !record(options) ||
    !isAbsolute(options.packageDir || '') ||
    typeof options.socketPath !== 'string' ||
    !options.socketPath ||
    !Number.isSafeInteger(options.supervisorPid) ||
    options.supervisorPid <= 0
  )
    return { editable: false, controllable: false };
  let client;
  try {
    const DaemonClient = await (
      dependencies.loadClient ||
      (async () =>
        (await import(pathToFileURL(join(options.packageDir, 'dist/modes/daemon/daemon-client.js')).href))
          .DaemonClient)
    )();
    client = new DaemonClient(options.socketPath);
    if (typeof client.requestId !== 'number') return { editable: false, controllable: false };
    await client.connect(2000);
    const hello = await client.waitForHello(3000);
    if (
      hello?.supervisorPid !== options.supervisorPid ||
      (typeof hello.socketPath === 'string' && !samePath(hello.socketPath, options.socketPath)) ||
      !client.supportsServerCapability('client_owned_sessions')
    )
      return { editable: false, controllable: false };
    return {
      editable: client.supportsServerCapability('goal_objective_edit'),
      controllable: client.supportsServerCapability('goal_lifecycle_control'),
      ...(client.supportsServerCapability('goal_error_resume') && { resumable: true }),
    };
  } catch {
    return { editable: false, controllable: false };
  } finally {
    client?.close();
  }
}

function validate(options, input, action) {
  if (
    !record(options) ||
    !isAbsolute(options.packageDir || '') ||
    typeof options.socketPath !== 'string' ||
    !options.socketPath ||
    options.socketPath.includes('\0') ||
    !Number.isSafeInteger(options.supervisorPid) ||
    options.supervisorPid <= 0 ||
    !isAbsolute(options.agentDir || '') ||
    !isAbsolute(options.sessionDir || '') ||
    (options.timeout !== undefined && (!Number.isSafeInteger(options.timeout) || options.timeout < 1000)) ||
    !record(input) ||
    typeof input.sessionId !== 'string' ||
    !sessionIdPattern.test(input.sessionId) ||
    !isAbsolute(input.sessionFile || '') ||
    !isAbsolute(input.cwd || '') ||
    typeof input.goalId !== 'string' ||
    !input.goalId ||
    typeof input.expectedObjective !== 'string' ||
    !input.expectedObjective.trim() ||
    (!action &&
      (typeof input.objective !== 'string' ||
        !input.objective.trim() ||
        [...input.objective.trim()].length > 4000))
  )
    throw new SavedGoalError(400, 'Invalid saved goal edit request.', 'invalid_goal_edit');
}

function matchesSession(value, input, activeSessionId) {
  return (
    record(value) &&
    value.sessionId === input.sessionId &&
    value.activeSessionId === activeSessionId &&
    samePath(value.cwd, input.cwd) &&
    samePath(value.sessionFile, input.sessionFile)
  );
}

function matchesGoal(goal, input, objective) {
  return record(goal) && goal.goalId === input.goalId && goal.objective === objective;
}

/** Open one short-lived, client-owned native worker to edit an inactive saved goal. */
export async function editSavedGoal(options, input, dependencies = {}) {
  return mutateSavedGoal(options, input, dependencies);
}

export async function controlSavedGoal(options, input, dependencies = {}) {
  if (!['pause', 'clear'].includes(input?.action))
    throw new SavedGoalError(400, 'Invalid goal action.', 'invalid_goal_action');
  return mutateSavedGoal(options, input, dependencies, input.action);
}

export function isClearedGoal(goal) {
  return goal === null || (record(goal) && goal.status === 'idle' && goal.objective == null);
}

async function mutateSavedGoal(options, input, dependencies, action) {
  validate(options, input, action);
  const timeout = options.timeout ?? 30000;
  const loadClient =
    dependencies.loadClient ||
    (async () =>
      (await import(pathToFileURL(join(options.packageDir, 'dist/modes/daemon/daemon-client.js')).href))
        .DaemonClient);
  let client;
  let ownedActiveSessionId;
  let failure;
  let result;

  async function request(command, { mutation = false } = {}) {
    let response;
    try {
      response = await client.request(command, timeout, { recoverable: false });
    } catch {
      throw mutation ? uncertain() : unavailable();
    }
    if (!response?.success)
      throw new SavedGoalError(409, 'The native engine rejected the goal edit.', 'native_rejected');
    return response.data;
  }

  try {
    const DaemonClient = await loadClient();
    client = new DaemonClient(options.socketPath);
    if (typeof client.requestId !== 'number') throw unavailable();
    await client.connect(Math.min(timeout, 2000));
    const hello = await client.waitForHello(Math.min(timeout, 3000));
    if (
      hello?.supervisorPid !== options.supervisorPid ||
      (typeof hello.socketPath === 'string' && !samePath(hello.socketPath, options.socketPath)) ||
      !client.supportsServerCapability('client_owned_sessions') ||
      !client.supportsServerCapability(action ? 'goal_lifecycle_control' : 'goal_objective_edit')
    )
      throw unavailable();

    const created = await request(
      {
        type: 'create',
        sessionPath: input.sessionFile,
        lifecycle: 'client_owned',
        config: {
          cwd: input.cwd,
          agentDir: options.agentDir,
          sessionDir: options.sessionDir,
          noTools: true,
          noBuiltinTools: true,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      },
      { mutation: true },
    );
    const activeSessionId = created?.activeSessionId;
    if (typeof activeSessionId !== 'string' || !sessionIdPattern.test(activeSessionId)) throw uncertain();
    // A successful client-owned create is the only authority to complete this worker.
    ownedActiveSessionId = activeSessionId;
    if (!matchesSession(created, input, activeSessionId)) throw conflict();

    const before = await request({ type: 'get_connection_state', activeSessionId });
    if (
      !matchesSession(before, input, activeSessionId) ||
      before.isStreaming ||
      before.sessionActions?.active ||
      (before.sessionActions?.queuedCount ?? 0) > 0
    )
      throw conflict();

    const matchesResult = (goal) =>
      action === 'clear'
        ? isClearedGoal(goal)
        : matchesGoal(goal, input, action ? input.expectedObjective : input.objective.trim()) &&
          (!action || goal.status === 'paused');
    const edited = await request(
      {
        type: action ? 'control_goal' : 'edit_goal_objective',
        activeSessionId,
        goalId: input.goalId,
        expectedObjective: input.expectedObjective,
        ...(action ? { action } : { objective: input.objective.trim() }),
      },
      { mutation: true },
    );
    if (!matchesResult(edited)) throw uncertain();
    const after = await request({ type: 'get_connection_state', activeSessionId });
    if (!matchesSession(after, input, activeSessionId) || !matchesResult(after.goal)) throw uncertain();
    result = action === 'clear' ? null : after.goal;
  } catch (error) {
    failure = error instanceof SavedGoalError ? error : unavailable();
  } finally {
    if (ownedActiveSessionId && client) {
      try {
        await request(
          { type: 'complete_owned_session', activeSessionId: ownedActiveSessionId },
          { mutation: true },
        );
      } catch {
        // Completion failure after mutation may leave the persisted result uncertain.
        if (!failure || failure.code === 'delivery_uncertain') failure = uncertain();
      }
    }
    client?.close();
  }
  if (failure) throw failure;
  return result;
}
