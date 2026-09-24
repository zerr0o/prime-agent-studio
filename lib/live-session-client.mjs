import { formatMessage as tr } from '../public/i18n-core.js';
import { queuedAgentMessage } from '../public/agent-messages.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateImages } from './images.mjs';
import { parseCommand, SESSION_COMMANDS } from './commands.mjs';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const laneNames = new Set(['steering', 'followUp']);
const canonical = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
const socketKey = (path) => (process.platform === 'win32' ? path.toLowerCase() : resolve(path));
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

export class LiveSessionError extends Error {
  constructor(status, message, code = 'live_session_unavailable') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const unavailable = () =>
  new LiveSessionError(409, tr('server.cette_session_n_est_plus_disponible_en_direct'));

function validateTarget(sessionId, cwd) {
  if (
    typeof sessionId !== 'string' ||
    !idPattern.test(sessionId) ||
    typeof cwd !== 'string' ||
    !isAbsolute(cwd) ||
    cwd.length > 32768
  ) {
    throw new LiveSessionError(
      400,
      tr('server.la_session_ou_le_dossier_du_projet_est_invalide'),
      'invalid_target',
    );
  }
}

function validateText(text, { blank = false } = {}) {
  if (
    typeof text !== 'string' ||
    (!blank && !text.trim()) ||
    text.includes('\0') ||
    Buffer.byteLength(text) > 512 * 1024
  ) {
    throw new LiveSessionError(400, tr('server.le_message_est_vide_ou_depasse_512_ko'), 'invalid_message');
  }
  return text;
}

function sanitizeContextUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const contextWindow = value.contextWindow;
  if (
    typeof contextWindow !== 'number' ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    contextWindow > 100_000_000
  )
    return undefined;
  const tokens =
    value.tokens === null
      ? null
      : typeof value.tokens === 'number' && Number.isFinite(value.tokens) && value.tokens >= 0
        ? Math.round(value.tokens)
        : undefined;
  const percent =
    value.percent === null
      ? null
      : typeof value.percent === 'number' && Number.isFinite(value.percent)
        ? Math.min(100, Math.max(0, Math.round(value.percent * 10) / 10))
        : undefined;
  if (tokens === undefined && percent === undefined) return undefined;
  return { tokens: tokens ?? null, contextWindow: Math.round(contextWindow), percent: percent ?? null };
}

/** Read only the descriptors belonging to this exact, already-running socket. */
export async function resolveLiveSessionOwner(
  { socketPath, agentDir = join(homedir(), '.prime', 'agent') },
  sessionId,
  cwd,
) {
  validateTarget(sessionId, cwd);
  const key = createHash('sha256').update(socketKey(socketPath)).digest('hex').slice(0, 12);
  const directory = join(agentDir, 'daemon-workers', key);
  const names = await readdir(directory).catch(() => []);
  const matches = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
    const path = join(directory, name);
    try {
      if ((await stat(path)).size > 256 * 1024) continue;
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (
        value.rootSessionId !== sessionId ||
        typeof value.supervisorSocketPath !== 'string' ||
        socketKey(value.supervisorSocketPath) !== socketKey(socketPath)
      )
        continue;
      if (value.lifecycle !== 'ready' || value.stopRequestedAt || !value.ownerClientId) continue;
      matches.push({
        sessionId,
        cwd,
        activeSessionId: value.rootActiveSessionId,
        ownerClientId: value.ownerClientId,
        sessionFile: value.sessionFile,
      });
    } catch {
      // Atomic descriptor replacement can race a read. Never infer ownership.
    }
  }
  if (matches.length !== 1) throw unavailable();
  return matches[0];
}

function commandCounter(identity) {
  const bytes = identity ? createHash('sha256').update(identity).digest().subarray(0, 6) : randomBytes(6);
  // The native CLI starts at zero. Separate observer counters also prevent its
  // command journal from confusing concurrent sockets sharing one owner ID.
  return 2 ** 50 + bytes.readUIntBE(0, 6);
}

/** Commands for an existing GUI-owned session; never creates or resumes one. */
export function createLiveSessionClient(options, dependencies = {}) {
  const { packageDir, socketPath, supervisorPid, supervisorProcessStartId } = options;
  if (
    !isAbsolute(packageDir || '') ||
    typeof socketPath !== 'string' ||
    !socketPath ||
    socketPath.includes('\0')
  ) {
    throw new LiveSessionError(400, tr('server.le_point_d_acces_au_moteur_est_invalide'), 'invalid_endpoint');
  }
  const timeout = options.timeout ?? 10000;
  const resolveOwner = options.resolveOwner || ((id, cwd) => resolveLiveSessionOwner(options, id, cwd));
  let Client;
  let closed = false;
  const clients = new Set();
  const loadClient =
    dependencies.loadClient ||
    (async () => {
      Client ||= (await import(pathToFileURL(join(packageDir, 'dist/modes/daemon/daemon-client.js')).href))
        .DaemonClient;
      return Client;
    });

  async function request(client, command, { mutation = false } = {}) {
    let response;
    try {
      response = await client.request(command, timeout, { recoverable: false });
    } catch {
      throw mutation
        ? new LiveSessionError(
            503,
            tr('server.le_moteur_n_a_pas_confirme_cette_action_verifiez_la_file_avant_de'),
            'delivery_uncertain',
          )
        : unavailable();
    }
    if (!response?.success)
      throw new LiveSessionError(
        409,
        tr('server.le_moteur_a_refuse_cette_action_sur_la_session_active'),
        'native_rejected',
      );
    return response.data;
  }

  async function open(owner) {
    if (closed) throw unavailable();
    let client;
    try {
      const DaemonClient = await loadClient();
      if (closed) throw unavailable();
      client = new DaemonClient(socketPath);
      if (typeof client.requestId !== 'number') throw unavailable();
      client.protocolClientId = owner.ownerClientId;
      client.requestId = commandCounter();
      clients.add(client);
      await client.connect(Math.min(timeout, 2000));
      const hello = await client.waitForHello(Math.min(timeout, 3000));
      if (
        (supervisorPid !== undefined && hello.supervisorPid !== supervisorPid) ||
        (supervisorProcessStartId !== undefined &&
          hello.supervisorProcessStartId !== supervisorProcessStartId) ||
        (typeof hello.socketPath === 'string' && socketKey(hello.socketPath) !== socketKey(socketPath))
      )
        throw unavailable();
      return client;
    } catch {
      client?.close();
      clients.delete(client);
      throw unavailable();
    }
  }

  function validateOwner(owner, sessionId, cwd) {
    if (
      !record(owner) ||
      owner.sessionId !== sessionId ||
      typeof owner.cwd !== 'string' ||
      canonical(owner.cwd) !== canonical(cwd) ||
      typeof owner.activeSessionId !== 'string' ||
      !idPattern.test(owner.activeSessionId) ||
      typeof owner.ownerClientId !== 'string' ||
      !owner.ownerClientId ||
      owner.ownerClientId.length > 300 ||
      /[\x00-\x1f]/.test(owner.ownerClientId)
    )
      throw unavailable();
  }

  async function inspect(client, owner, sessionId, cwd) {
    const state = await request(client, { type: 'get_state', activeSessionId: owner.activeSessionId });
    const { header } =
      (await request(client, { type: 'get_session_header', activeSessionId: owner.activeSessionId })) || {};
    if (
      !record(state) ||
      state.sessionId !== sessionId ||
      (state.activeSessionId ?? state.id) !== owner.activeSessionId ||
      typeof state.cwd !== 'string' ||
      canonical(state.cwd) !== canonical(cwd) ||
      !record(header) ||
      header.type !== 'session' ||
      header.id !== sessionId ||
      typeof header.cwd !== 'string' ||
      canonical(header.cwd) !== canonical(cwd) ||
      (owner.sessionFile &&
        (typeof state.sessionFile !== 'string' ||
          canonical(owner.sessionFile) !== canonical(state.sessionFile)))
    )
      throw unavailable();
    return state;
  }

  async function snapshot(client, owner, sessionId, cwd, knownState) {
    const state = knownState || (await inspect(client, owner, sessionId, cwd));
    const queue = await request(client, { type: 'get_queue', activeSessionId: owner.activeSessionId });
    if (
      !record(queue) ||
      !Array.isArray(queue.steering) ||
      !Array.isArray(queue.followUp) ||
      [...queue.steering, ...queue.followUp].some((text) => typeof text !== 'string')
    )
      throw unavailable();
    const publicState = {};
    for (const name of [
      'isStreaming',
      'isCompacting',
      'isBashRunning',
      'hasRunningRlmChildren',
      'isRunningTools',
      'isSessionActive',
    ]) {
      if (typeof state[name] === 'boolean') publicState[name] = state[name];
    }
    if (Number.isSafeInteger(state.messageCount)) publicState.messageCount = state.messageCount;
    return {
      available: true,
      sessionId,
      activeSessionId: owner.activeSessionId,
      cwd: resolve(cwd),
      steering: queue.steering,
      followUps: queue.followUp,
      state: publicState,
      capabilities: { mutateQueue: client.supportsServerCapability('queue_message_mutation') },
    };
  }

  async function withSession(sessionId, cwd, action) {
    validateTarget(sessionId, cwd);
    let owner;
    try {
      owner = await resolveOwner(sessionId, cwd);
    } catch {
      throw unavailable();
    }
    validateOwner(owner, sessionId, cwd);
    const client = await open(owner);
    try {
      const state = await inspect(client, owner, sessionId, cwd);
      return await action(client, owner, state);
    } finally {
      // No detach/complete_owned_session: another socket still owns this worker.
      client.close();
      clients.delete(client);
    }
  }

  async function afterMutation(client, owner, sessionId, cwd) {
    try {
      return await snapshot(client, owner, sessionId, cwd);
    } catch {
      return null;
    }
  }

  return {
    setThinking(sessionId, cwd, level) {
      if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level))
        throw new LiveSessionError(400, tr('server.niveau_de_reflexion_invalide'));
      return withSession(sessionId, cwd, async (client, owner) => {
        await request(
          client,
          { type: 'set_thinking_level', activeSessionId: owner.activeSessionId, level },
          { mutation: true },
        );
        const state = await inspect(client, owner, sessionId, cwd);
        if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(state.thinkingLevel))
          throw unavailable();
        return state.thinkingLevel;
      });
    },
    getCommands(sessionId, cwd) {
      return withSession(sessionId, cwd, async (client, owner) => {
        const data = await request(client, { type: 'get_commands', activeSessionId: owner.activeSessionId });
        if (!Array.isArray(data?.commands)) throw unavailable();
        return data.commands.map(({ name, description, source, sourceInfo }) => ({
          name,
          description,
          source,
          sourceInfo: sourceInfo ? { scope: sourceInfo.scope, path: sourceInfo.path } : undefined,
        }));
      });
    },
    getSnapshot(sessionId, cwd) {
      return withSession(sessionId, cwd, (client, owner, state) =>
        snapshot(client, owner, sessionId, cwd, state),
      );
    },
    getInspector(sessionId, cwd) {
      return withSession(sessionId, cwd, async (client, owner, state) => {
        const data = await request(client, {
          type: 'get_rlm_children',
          activeSessionId: owner.activeSessionId,
        });
        if (!Array.isArray(data?.children)) throw unavailable();
        const flags = {};
        for (const key of [
          'isStreaming',
          'isCompacting',
          'isBashRunning',
          'isRunningTools',
          'hasRunningRlmChildren',
          'isSessionActive',
        ])
          if (typeof state[key] === 'boolean') flags[key] = state[key];
        // Accurate live context usage comes from get_connection_state only.
        // Never derive it from cumulative token totals. Hide when unavailable.
        let contextUsage;
        try {
          const connection = await request(client, {
            type: 'get_connection_state',
            activeSessionId: owner.activeSessionId,
          });
          contextUsage = sanitizeContextUsage(connection?.contextUsage);
        } catch {
          contextUsage = undefined;
        }
        return {
          state: {
            ...flags,
            model:
              state.model?.provider && state.model?.id
                ? `${state.model.provider}/${state.model.id}`
                : undefined,
            thinkingLevel: state.thinkingLevel,
            ...(contextUsage ? { contextUsage } : {}),
          },
          children: data.children.slice(0, 200).map((child) => ({
            id: child.id,
            parentId: child.parentId,
            sessionName: child.sessionName,
            model: child.model,
            thinkingLevel: child.thinkingLevel,
            label: child.label,
            status: child.status,
            durationMs: child.durationMs,
            answerPreview: child.answerPreview,
            toolUseCount: child.toolUseCount,
            tokenCount: child.tokenCount,
            recap: child.recap,
            progressNote: child.progressNote,
            lastActivityAt: child.lastActivityAt,
            activityStaleMs: child.activityStaleMs,
            activity: child.activity
              ? { kind: child.activity.kind, toolName: child.activity.toolName }
              : undefined,
            error: child.error,
          })),
        };
      });
    },
    async send(sessionId, cwd, input = {}) {
      const images = validateImages(input.images);
      const rawMessage = validateText(input.message);
      const message = parseCommand(rawMessage) ? rawMessage.trim() : rawMessage;
      if (!['steer', 'follow_up'].includes(input.mode))
        throw new LiveSessionError(400, tr('server.le_mode_d_envoi_est_invalide'), 'invalid_mode');
      const requestId = input.requestId ?? randomUUID();
      if (typeof requestId !== 'string' || !idPattern.test(requestId))
        throw new LiveSessionError(400, 'L’identifiant d’envoi est invalide.', 'invalid_request');
      return withSession(sessionId, cwd, async (client, owner, state) => {
        // A usable native imageModel routes the image turn on the engine side;
        // otherwise the explicit refusal stays with its code.
        if (images.length && Array.isArray(state.model?.input) && !state.model.input.includes('image')) {
          const route =
            typeof options.imageRoute === 'function' ? await options.imageRoute().catch(() => null) : null;
          if (!route)
            throw new LiveSessionError(
              400,
              tr('server.ce_modele_ne_prend_pas_en_charge_les_images'),
              'unsupported_images',
            );
        }
        client.requestId = commandCounter(`${owner.ownerClientId}\0${sessionId}\0${requestId}`);
        const sessionCommand = SESSION_COMMANDS.has(parseCommand(message)?.name);
        if (sessionCommand && (images.length || /[\r\n\u2028\u2029]/.test(message)))
          throw new LiveSessionError(
            400,
            tr('server.une_commande_de_session_s_ecrit_sur_une_seule_ligne_sans_image'),
            'invalid_command',
          );
        const data = await request(
          client,
          {
            type: sessionCommand ? 'prompt' : input.mode,
            activeSessionId: owner.activeSessionId,
            message,
            ...(images.length ? { images } : {}),
            ...(sessionCommand
              ? { streamingBehavior: input.mode === 'steer' ? 'steer' : 'followUp', queueIfBusy: true }
              : { queueKey: `prime-studio:${requestId}` }),
          },
          { mutation: true },
        );
        const accepted = input.mode !== 'follow_up' || data?.queued !== false;
        return {
          accepted,
          mode: input.mode,
          requestId,
          snapshot: await afterMutation(client, owner, sessionId, cwd),
        };
      });
    },
    async mutate(sessionId, cwd, input = {}) {
      if (
        !laneNames.has(input.lane) ||
        !Number.isSafeInteger(input.index) ||
        input.index < 0 ||
        input.index > 10000
      )
        throw new LiveSessionError(
          400,
          tr('server.la_position_dans_la_file_est_invalide'),
          'invalid_queue_position',
        );
      const expectedText = validateText(input.expectedText, { blank: true });
      if (queuedAgentMessage(expectedText))
        throw new LiveSessionError(409, tr('agents.message_protected'), 'protected_agent_message');
      const supplied = input.mutation;
      let mutation;
      if (supplied?.type === 'delete') mutation = { type: 'delete' };
      else if (supplied?.type === 'move' && [-1, 1].includes(supplied.direction))
        mutation = { type: 'move', direction: supplied.direction };
      else if (supplied?.type === 'replace' && laneNames.has(supplied.lane))
        mutation = { type: 'replace', text: validateText(supplied.text), lane: supplied.lane };
      else
        throw new LiveSessionError(
          400,
          tr('server.la_modification_de_la_file_est_invalide'),
          'invalid_queue_mutation',
        );
      return withSession(sessionId, cwd, async (client, owner) => {
        if (!client.supportsServerCapability('queue_message_mutation'))
          return { status: 'unsupported', snapshot: await snapshot(client, owner, sessionId, cwd) };
        const data = await request(
          client,
          {
            type: 'mutate_queued_message',
            activeSessionId: owner.activeSessionId,
            lane: input.lane,
            index: input.index,
            expectedText,
            mutation,
          },
          { mutation: true },
        );
        if (!['applied', 'rejected', 'invalid'].includes(data?.status))
          throw new LiveSessionError(
            502,
            tr('server.le_moteur_a_renvoye_une_reponse_de_file_invalide'),
            'invalid_native_response',
          );
        return { status: data.status, snapshot: await afterMutation(client, owner, sessionId, cwd) };
      });
    },
    close() {
      closed = true;
      for (const client of clients) client.close();
      clients.clear();
    },
  };
}
