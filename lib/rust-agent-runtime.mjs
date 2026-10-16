import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, resolve, join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createOwnedDaemon } from './daemon.mjs';
import { RustDaemonClient } from './rust-daemon-client.mjs';
import { validateImages } from './images.mjs';
import { createRustStudioTools } from './rust-studio-tools.mjs';
import { resolveRustSessionContext } from './rust-session-context.mjs';
import { publicGoal } from './goal-state.mjs';

const execute = promisify(execFile);
const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DAY = 24 * 60 * 60 * 1000;
const OWNED_CLEANUP_TIMEOUT = 65000;
const GOAL_RECOVERY_MESSAGE =
  'Studio restarted. Continue the existing active goal from saved state. First reconcile any in-flight work; do not repeat completed or ambiguous side effects. Preserve original goal limits and authorizations.';
const RUN_RECOVERY_MESSAGE =
  'Studio restarted. Continue the interrupted work from saved session state. First reconcile any in-flight work; do not repeat completed or ambiguous side effects. Preserve original task limits and authorizations.';
const emptyGoal = (goal) =>
  goal != null &&
  goal.status === 'idle' &&
  goal.active === false &&
  goal.goalId == null &&
  goal.objective == null &&
  goal.tokensUsed === 0 &&
  goal.timeUsedSeconds === 0 &&
  goal.continuationsUsed === 0 &&
  goal.tokenBudget == null &&
  goal.noProgressStreak == null;
const requiredCapabilities = [
  'client_owned_sessions',
  'event_sequence',
  'rlm_quiescence_barrier',
  'queue_message_mutation',
];

/** Parse the official CLI's available-model table; malformed output must not advertise JS-only models. */
export function parseRustModelList(output) {
  if (typeof output !== 'string') throw new Error('Invalid Rust model catalogue.');
  if (/^No models available\./m.test(output)) return [];
  const lines = output.trim().split(/\r?\n/);
  const header = lines.findIndex((line) =>
    /^provider\s{2,}model\s{2,}context\s{2,}max-out\s{2,}thinking\s{2,}images\s*$/.test(line),
  );
  if (header < 0 || header === lines.length - 1) throw new Error('Invalid Rust model catalogue.');
  const models = [];
  const seen = new Set();
  for (const line of lines.slice(header + 1)) {
    const cells = line.trim().split(/\s{2,}/);
    if (
      cells.length !== 6 ||
      !/^[^\s/]+$/.test(cells[0]) ||
      !/^[^\s]+$/.test(cells[1]) ||
      !['yes', 'no'].includes(cells[4]) ||
      !['yes', 'no'].includes(cells[5])
    )
      throw new Error('Invalid Rust model catalogue.');
    const id = `${cells[0]}/${cells[1]}`;
    if (seen.has(id)) throw new Error('Duplicate Rust model catalogue entry.');
    seen.add(id);
    models.push({
      id,
      provider: cells[0],
      name: cells[1],
      reasoning: cells[4] === 'yes',
      input: cells[5] === 'yes' ? ['text', 'image'] : ['text'],
    });
  }
  return models;
}

/** Studio's run contract backed by native Rust workers, with JS metadata helpers only. */
export function createRustAgentRuntime(
  options,
  {
    metadata,
    cli,
    projectEvents,
    terminateProcess,
    makeDaemon = createOwnedDaemon,
    Client = RustDaemonClient,
    makeTools = createRustStudioTools,
    listNativeModels = async (binary, env, refresh) => {
      const { stdout } = await execute(binary, ['model', 'list', ...(!refresh ? ['--offline'] : [])], {
        env,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      return parseRustModelList(stdout);
    },
  },
) {
  const agentHome = metadata.agentHome;
  const sessionDir = metadata.sessionDir;
  const env = {
    ...(options.env || process.env),
    PRIME_AGENT_CODING_AGENT_DIR: agentHome,
    PRIME_AGENT_SESSION_DIR: sessionDir,
    DO_NOT_TRACK: '1',
    PRIME_STUDIO_SESSION_PREFERENCES: '1',
  };
  // The native executable cannot consume JS loader hooks or the old Python kernel override.
  delete env.NODE_OPTIONS;
  delete env.PRIME_AGENT_KERNEL_PYTHON;
  const binary = options.rustCliPath || env.PRIME_STUDIO_RUST_CLI;
  if (!isAbsolute(binary || ''))
    throw new Error('PRIME_STUDIO_RUST_CLI must be an absolute executable path.');
  env.PI_PACKAGE_DIR = dirname(binary);
  env.PRIME_AGENT_KERNEL_VENV ||= join(agentHome, 'kernel-venv-rust');
  if (options.subagentPolicyFile)
    throw new Error(
      'Rust opt-in cannot enforce Studio’s JavaScript subagent policy. Disable that policy explicitly before using Rust.',
    );
  const packageDir = cli?.packageDir;
  if (!packageDir) throw new Error('Studio metadata package is unavailable.');
  let daemon;
  let closing = false;
  const pending = new Set();
  const active = new Set();
  const owners = new Map();
  let statusPromise;
  let catalogPromise;
  let catalogAt = 0;

  async function getModels({ refresh = false } = {}) {
    if (!refresh && catalogPromise && Date.now() - catalogAt < 60000) return catalogPromise;
    const request = Promise.all([
      metadata.getModels({ refresh }),
      listNativeModels(binary, env, refresh),
    ]).then(([metadataCatalog, nativeModels]) => {
      const details = new Map((metadataCatalog.models || []).map((model) => [model.id, model]));
      const models = nativeModels.map((native) => {
        const detail = details.get(native.id);
        const { thinkingLevels, ...display } = detail || {};
        return {
          ...display,
          ...native,
          name: detail?.name || native.name,
          ...(native.reasoning
            ? Array.isArray(thinkingLevels) && thinkingLevels.length
              ? { thinkingLevels }
              : {}
            : { thinkingLevels: ['off'] }),
          availability: 'available',
        };
      });
      const ids = new Set(models.map((model) => model.id));
      return {
        models,
        configuredProviders: [...new Set(models.map((model) => model.provider))],
        refreshing: false,
        default: {
          model: ids.has(metadataCatalog.default?.model) ? metadataCatalog.default.model : null,
          thinking: metadataCatalog.default?.thinking || 'medium',
        },
      };
    });
    catalogPromise = request;
    catalogAt = Date.now();
    request.catch(() => {
      if (catalogPromise === request) catalogPromise = undefined;
    });
    return request;
  }

  async function getStatus() {
    statusPromise ||= execute(binary, ['--version'], {
      env,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 16384,
    })
      .then(({ stdout }) => ({
        available: true,
        version: stdout.trim(),
        cli: binary,
        engine: 'rust',
        nodeVersion: process.versions.node,
        metadataVersion: cli.version || null,
      }))
      .catch((error) => {
        statusPromise = undefined;
        return { available: false, engine: 'rust', cli: binary, error: error.message };
      });
    return statusPromise;
  }

  async function readyDaemon() {
    if (closing) throw new Error('The runtime is stopping.');
    daemon ||= makeDaemon(
      {
        cli: { path: binary, node: false, packageDir },
        env,
        cwd: options.kernelRoot || process.cwd(),
        terminateProcess,
        startupTimeout: 30000,
      },
      { loadClient: async () => Client },
    );
    const ready = await daemon.ensureReady();
    if (closing) throw new Error('The runtime is stopping.');
    return ready;
  }

  async function openClient(ready) {
    const client = new Client(daemon.socketPath, { expectedIdentity: { supervisorPid: ready.pid } });
    try {
      await client.connect();
      const hello = await client.waitForHello();
      const missing = requiredCapabilities.filter(
        (capability) => !hello.serverCapabilities?.includes(capability),
      );
      if (missing.length)
        throw new Error(`Official Rust daemon lacks required capabilities: ${missing.join(', ')}.`);
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async function request(client, command, timeout = 30000) {
    const response = await client.request(command, timeout);
    if (!response?.success)
      throw Object.assign(new Error(response?.error || 'Native engine rejected the command.'), {
        code: response?.errorInfo?.code || 'native_rejected',
      });
    return response.data;
  }

  async function startInner(input) {
    if (closing) throw new Error('The runtime is stopping.');
    if (!input || typeof input !== 'object') throw new Error('The run request is invalid.');
    if (input.computerUse)
      throw new Error(
        'Studio Computer Use is unavailable with the official Rust daemon. Disable Computer Use for this run.',
      );
    if (input.files?.length)
      throw new Error('Studio file attachments are unavailable with the official Rust daemon.');
    if (!input || !isAbsolute(input.cwd || '') || !(await stat(input.cwd).catch(() => null))?.isDirectory())
      throw new Error('The project folder is unavailable.');
    const recovery = input.goalRecovery;
    if (
      recovery &&
      (!input.sessionId ||
        !input.sessionFile ||
        (recovery.goalId !== null &&
          (typeof recovery.goalId !== 'string' ||
            !sessionIdPattern.test(recovery.goalId) ||
            recovery.goalId.length > 200)) ||
        (recovery.recoveryId != null &&
          (typeof recovery.recoveryId !== 'string' ||
            !sessionIdPattern.test(recovery.recoveryId) ||
            recovery.recoveryId.length > 200)))
    )
      throw new Error('Goal recovery requires an exact saved session and goal identity.');
    const recoveryMessage = recovery?.goalId === null ? RUN_RECOVERY_MESSAGE : GOAL_RECOVERY_MESSAGE;
    if (typeof input.message !== 'string' || Buffer.byteLength(input.message) > 512 * 1024)
      throw new Error('The message must be text no larger than 512 KiB.');
    const images = validateImages(input.images || []);
    if (recovery && images.length) throw new Error('Goal recovery cannot replay image attachments.');
    if (!recovery && !input.message.trim() && !images.length) throw new Error('The message is empty.');
    if (input.thinking && !thinkingLevels.has(input.thinking)) throw new Error('Invalid reasoning level.');
    if (input.sessionId && !sessionIdPattern.test(input.sessionId))
      throw new Error('Invalid session identity.');
    if (
      input.sessionFile &&
      (!isAbsolute(input.sessionFile) || !(await stat(input.sessionFile).catch(() => null))?.isFile())
    )
      throw new Error('The saved session is unavailable.');
    if (input.sessionId && !input.sessionFile)
      throw new Error('A saved session must be resolved to its exact file before Rust resume.');
    for (const field of ['model', 'provider'])
      if (
        input[field] != null &&
        (typeof input[field] !== 'string' || input[field].length > 500 || /[\x00-\x1f]/.test(input[field]))
      )
        throw new Error(`Invalid ${field}.`);
    if (input.provider === 'meta' || input.model?.startsWith('meta/'))
      throw new Error('Studio’s JavaScript Meta provider is unavailable with the official Rust daemon.');
    await mkdir(sessionDir, { recursive: true });
    const ready = await readyDaemon();
    const client = await openClient(ready);
    const emit = (event) => {
      try {
        input.onEvent?.(event);
      } catch {
        /* Observer errors do not terminate a run. */
      }
    };
    const tools = makeTools({
      cwd: input.cwd,
      knowledgeConfig: options.knowledge?.dataDir
        ? { dataDir: options.knowledge.dataDir, agentHome, sessionDir }
        : undefined,
      roadmapConfig: options.roadmap?.config,
      onEvent: emit,
      allowQuestions: input.allowQuestions === true,
      resolveContext: async ({ root, callerSessionId }) => {
        const listing = await request(client, { type: 'list', all: false, includeClientOwned: true });
        return resolveRustSessionContext({ root, callerSessionId, sessions: listing?.sessions });
      },
    });
    let created;
    const validateRecovery = async (waitForRestore = false) => {
      let state;
      const expectedGoalId = recovery?.goalId;
      const deadline = Date.now() + 30000;
      do {
        state = await request(client, {
          type: 'get_connection_state',
          activeSessionId: created.activeSessionId,
        });
        // Native create acknowledges before background adoption restores the goal.
        // Only the canonical empty placeholder may settle; a changed/paused goal
        // is a real conflict and must never be waited away.
        if (
          !waitForRestore ||
          !expectedGoalId ||
          !emptyGoal(state?.goal) ||
          state.sessionId !== created.sessionId ||
          state.activeSessionId !== created.activeSessionId ||
          state.isStreaming !== false ||
          state.isCompacting !== false ||
          state.isBashRunning === true ||
          state.sessionActions?.queuedCount !== 0 ||
          state.sessionActions?.active != null ||
          state.sessionActions?.steering?.length ||
          state.sessionActions?.followUps?.length ||
          Date.now() >= deadline ||
          closing
        )
          break;
        await delay(100);
      } while (true);
      const goal = state?.goal;
      const actions = state?.sessionActions;
      // Rust serializes empty_goal_state() instead of null when no goal exists.
      // Accept only that exact empty state; paused/error/new goals remain fenced.
      const noGoal = goal == null || emptyGoal(goal);
      const eligibleGoal =
        recovery.goalId === null
          ? noGoal
          : goal?.status === 'active' &&
            goal.goalId === recovery.goalId &&
            (goal.active == null || goal.active === true) &&
            Number.isSafeInteger(goal.tokensUsed) &&
            goal.tokensUsed >= 0 &&
            (goal.tokenBudget == null ||
              (Number.isSafeInteger(goal.tokenBudget) && goal.tokensUsed < goal.tokenBudget)) &&
            (goal.noProgressStreak == null ||
              (Number.isSafeInteger(goal.noProgressStreak) &&
                goal.noProgressStreak >= 0 &&
                goal.noProgressStreak < 3));
      const failed = Object.entries({
        identity: state?.sessionId === created.sessionId && state.activeSessionId === created.activeSessionId,
        project: isAbsolute(state.cwd || '') && resolve(state.cwd) === resolve(input.cwd),
        file:
          isAbsolute(state.sessionFile || '') && resolve(state.sessionFile) === resolve(input.sessionFile),
        idle: state.isStreaming === false && state.isCompacting === false && state.isBashRunning !== true,
        queue:
          !!actions &&
          actions.queuedCount === 0 &&
          actions.active == null &&
          !(Array.isArray(actions.steering) && actions.steering.length) &&
          !(Array.isArray(actions.followUps) && actions.followUps.length),
        goal: eligibleGoal,
      })
        .filter(([, ok]) => !ok)
        .map(([key]) => key);
      if (failed.length)
        throw Object.assign(
          new Error(`The saved goal is no longer eligible for recovery (${failed.join(', ')}).`),
          { code: 'goal_recovery_ineligible', status: 409 },
        );
      return state;
    };
    try {
      await tools.ready;
      let provider = input.provider;
      let model = input.model;
      if (!provider && model?.includes('/')) {
        const slash = model.indexOf('/');
        provider = model.slice(0, slash);
        model = model.slice(slash + 1);
      }
      const config = {
        cwd: resolve(input.cwd),
        agentDir: agentHome,
        sessionDir,
        appendSystemPrompt: [
          tools.appendSystemPrompt(
            'Studio can display existing project images inline. Use Markdown ![caption](project-relative/path.png) for PNG, JPEG, GIF or WebP files that exist inside the current project. Do not embed base64 or use localhost/file URLs. The image is read from its original location, not archived; removed files display an unavailable placeholder.',
          ),
        ],
        ...(provider && { provider }),
        ...(model && { model }),
        ...(input.thinking && { thinking: input.thinking }),
      };
      created = await request(
        client,
        {
          type: 'create',
          lifecycle: 'client_owned',
          telemetryDisabled: true,
          ...(input.sessionFile && { sessionPath: input.sessionFile }),
          config,
        },
        60000,
      );
      if (
        !sessionIdPattern.test(created?.activeSessionId || '') ||
        !sessionIdPattern.test(created?.sessionId || '') ||
        resolve(created.cwd || '') !== resolve(input.cwd) ||
        !isAbsolute(created.sessionFile || '') ||
        (input.sessionId && created.sessionId !== input.sessionId) ||
        (input.sessionFile && resolve(created.sessionFile) !== resolve(input.sessionFile))
      )
        throw new Error('Native session identity does not match the requested project/session.');
      tools.bindSession({ cwd: input.cwd, sessionId: created.sessionId, sessionFile: created.sessionFile });
      // This worker-routed read awaits native session adoption. Snapshot reads
      // alone can expose the empty prewarm placeholder, including for no-goal
      // recovery. Discard the system prompt; it is never journaled or logged.
      if (recovery)
        await request(client, { type: 'get_system_prompt', activeSessionId: created.activeSessionId });
      if (recovery) await validateRecovery(true);
      if (input.onReady) await input.onReady({ ...created });
      await tools.beginTurn();
      if (closing) throw new Error('The runtime is stopping.');
    } catch (error) {
      if (created?.activeSessionId)
        await request(
          client,
          { type: 'complete_owned_session', activeSessionId: created.activeSessionId },
          OWNED_CLEANUP_TIMEOUT,
        ).catch(() => {});
      await tools.close().catch(() => {});
      client.close();
      throw error;
    }
    const activeSessionId = created.activeSessionId;
    const sessionId = created.sessionId;
    owners.set(sessionId, {
      sessionId,
      cwd: resolve(input.cwd),
      sessionFile: created.sessionFile,
      activeSessionId,
      ownerClientId: client.protocolClientId,
    });
    const project = projectEvents();
    let providerFailure;
    let stopped = false;
    let finished = false;
    let settling;
    let cancelling;
    let resolveDone;
    const done = new Promise((resolvePromise) => {
      resolveDone = resolvePromise;
    });
    const removeMessage = client.onMessage((frame) => {
      if (frame.type !== 'session_event' || frame.activeSessionId !== activeSessionId) return;
      const event = frame.event;
      if (!event || typeof event !== 'object') return;
      if (event.type === 'goal_update') emit({ kind: 'goal', goal: publicGoal(event.goal) });
      if (
        event.type === 'message_end' &&
        event.message?.role === 'assistant' &&
        event.message.stopReason === 'error'
      )
        providerFailure = event.message.errorMessage || 'The model provider returned an error.';
      if (event.type === 'auto_retry_end' && event.success === true) providerFailure = undefined;
      for (const normalized of project(event)) emit(normalized);
    });
    const finish = (error) => {
      settling ||= (async () => {
        if (finished) return done;
        finished = true;
        owners.delete(sessionId);
        removeMessage();
        removeClose();
        let cleanupFailure;
        try {
          await tools.endTurn();
        } catch (e) {
          cleanupFailure = e.message;
        }
        try {
          await request(client, { type: 'complete_owned_session', activeSessionId }, OWNED_CLEANUP_TIMEOUT);
        } catch (e) {
          cleanupFailure ||= e.message;
        }
        try {
          await tools.close();
        } catch (e) {
          cleanupFailure ||= e.message;
        } finally {
          client.close();
          owners.delete(sessionId);
          active.delete(handle);
        }
        const failure = error?.message || providerFailure || cleanupFailure;
        const event = {
          kind: 'done',
          sessionId,
          status: stopped ? 'stopped' : failure ? 'failed' : 'completed',
          code: failure ? 1 : 0,
          ...(failure && !stopped && { error: failure }),
        };
        emit(event);
        resolveDone(event);
        return event;
      })();
      return settling;
    };
    const removeClose = client.onClose((error) => {
      if (!finished) void finish(error || new Error('Native engine disconnected.'));
    });
    const handle = {
      pid: created.workerPid,
      daemonPid: ready.pid,
      sessionId,
      done,
      respond: (id, response) => tools.respond(id, response),
      async cancel() {
        if (finished) return done;
        cancelling ||= (async () => {
          stopped = true;
          owners.delete(sessionId);
          // Send abort before bridge cleanup can release a question or wait on Roadmap.
          const abort = request(client, { type: 'abort_and_clear_queue', activeSessionId }, 15000);
          try {
            await Promise.all([abort, tools.endTurn()]);
          } catch (error) {
            return finish(error);
          }
          return finish();
        })();
        return cancelling;
      },
    };
    active.add(handle);
    emit({ kind: 'session', sessionId, cwd: resolve(input.cwd) });
    // Return the handle before processing the prompt, so HTTP cancellation owns the run.
    queueMicrotask(async () => {
      try {
        if (stopped || finished) return;
        await request(
          client,
          { type: 'attach', activeSessionId, clientId: client.protocolClientId, capabilities: [] },
          30000,
        );
        if (stopped || finished) return;
        if (recovery) await validateRecovery();
        if (stopped || finished) return;
        await request(
          client,
          {
            type: 'prompt',
            activeSessionId,
            message: recovery ? recoveryMessage : input.message.trim() || 'Describe the attached images.',
            ...(recovery
              ? {
                  customMessage: {
                    role: 'custom',
                    customType: recovery.goalId === null ? 'studio_run_recovery' : 'studio_goal_recovery',
                    content: recoveryMessage,
                    display: true,
                    timestamp: Date.now(),
                    details: {
                      goalId: recovery.goalId,
                      ...(recovery.recoveryId && { recoveryId: recovery.recoveryId }),
                    },
                  },
                }
              : images.length
                ? { images }
                : {}),
          },
          DAY,
        );
        if (stopped || finished) return;
        const autonomous = await request(
          client,
          { type: 'wait_for_headless_completion', activeSessionId, waitForRlmQuiescence: true },
          DAY,
        );
        if (autonomous?.enabled) {
          const hasGates = (autonomous.gates?.commands?.length || 0) > 0;
          const limits = autonomous.limits || {};
          const exhausted =
            autonomous.continuationsUsed >= limits.maxContinuations ||
            autonomous.turnsUsed >= limits.maxTurns ||
            autonomous.tokensUsed >= limits.maxTokens ||
            (autonomous.startedAt != null && Date.now() - autonomous.startedAt >= limits.timeoutMs);
          if ((hasGates && autonomous.lastGateFailure) || (!hasGates && exhausted))
            throw new Error('The autonomous verification did not complete successfully.');
        }
        await finish();
      } catch (error) {
        await finish(error);
      }
    });
    return handle;
  }

  return {
    engine: 'rust',
    agentHome,
    sessionDir,
    getStatus,
    getModels,
    canEditSavedGoals: false,
    canRecoverGoals: true,
    start(input) {
      const operation = startInner(input);
      pending.add(operation);
      operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    },
    getLiveEndpoint() {
      return daemon
        ? {
            packageDir,
            engine: 'rust',
            socketPath: daemon.socketPath,
            agentDir: agentHome,
            supervisorPid: daemon.pid,
            resolveOwner: (sessionId) => owners.get(sessionId),
          }
        : null;
    },
    async close() {
      closing = true;
      await Promise.allSettled([...pending]);
      await Promise.allSettled([...active].map((handle) => handle.cancel()));
      await daemon?.close();
      await metadata.close();
    },
  };
}
