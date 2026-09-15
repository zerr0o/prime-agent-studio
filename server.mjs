import { formatMessage as tr, requestLanguage } from './public/i18n-core.js';
import { createServer } from 'node:http';
import { isModelAvailabilityError } from './lib/model-availability.mjs';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDirectInvocation } from './scripts/launcher-common.mjs';
import { randomUUID } from 'node:crypto';
import { createStore, HttpError, validateDirectory, cwdKey, validId } from './lib/store.mjs';
import { createAgentRuntime } from './lib/agent.mjs';
import { createRemoteNetwork } from './lib/remote-network.mjs';
import { createRemoteAccess } from './lib/remote-access.mjs';
import { createRemoteUpdates } from './lib/remote-updates.mjs';
import { tailscaleSetupUrl } from './lib/tailscale-https.mjs';
import { createModelConfigStore } from './lib/model-config.mjs';
import { createModelDefaultsStore } from './lib/model-defaults.mjs';
import { createSubagentDefaultsStore } from './lib/subagent-defaults.mjs';
import { validPolicy } from './runtime/subagent-policy.mjs';
import { openDirectory } from './lib/open-directory.mjs';
import { createDirectoryPicker } from './lib/pick-directory.mjs';
import { createMcpService } from './lib/mcp-service.mjs';
import { createProviderService } from './lib/provider-service.mjs';
import { createCommandService, parseCommand, validateCommand } from './lib/commands.mjs';
import { createLiveMessages, routeLiveMessages } from './lib/live-messages.mjs';
import { createLiveSessionClient } from './lib/live-session-client.mjs';
import { createConversationSettings } from './lib/conversation-settings.mjs';
import { createDesktopNotifications } from './lib/desktop-notifications.mjs';
import { createPushService } from './lib/push.mjs';
import { validateImages, imageBodyLimit } from './lib/images.mjs';
import { createFileStore, validateFiles, appendFileMessage, splitFileMessage } from './lib/files.mjs';
import { createProjectFiles } from './lib/project-files.mjs';
import { openFile as openLocalFile, fileLaunchMode } from './lib/open-file.mjs';
import { createSessionInspector } from './lib/session-inspector.mjs';
import { createKnowledge } from './lib/knowledge.mjs';
import { createRoadmapService } from './lib/roadmap.mjs';
import { createRoadmapBridge, createRoadmapCallerResolver } from './lib/roadmap-bridge.mjs';
import { createRoadmapRoutes } from './lib/roadmap-routes.mjs';
import { createRoadmapSessionResolver } from './lib/roadmap-session.mjs';
import { createProjectArchives } from './lib/project-archives.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};
const publicRun = ({
  id,
  sessionId,
  cwd,
  status,
  startedAt,
  endedAt,
  error,
  model,
  thinking,
  allowQuestions,
  interactions,
  prompt,
}) => ({
  id,
  sessionId,
  cwd,
  status,
  startedAt,
  endedAt,
  error,
  model,
  thinking,
  allowQuestions: !!allowQuestions,
  interactions: interactions || [],
  prompt: splitFileMessage(prompt).text,
  attachments: splitFileMessage(prompt).attachments,
});

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
    throw new HttpError(415, tr('server.un_corps_json_est_requis'));
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > imageBodyLimit(req.url.split('?')[0]))
      throw new HttpError(413, tr('server.la_demande_depasse_la_taille_autorisee'));
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    if (length > 512 * 1024 && !body.images?.length && !body.files?.length)
      throw new HttpError(413, tr('server.la_demande_depasse_512_ko'));
    return body;
  } catch (error) {
    if (error.status) throw error;
    throw new HttpError(400, tr('server.la_demande_json_est_invalide'));
  }
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function createApp(options = {}) {
  const agentHome =
    options.agentHome || process.env.PRIME_AGENT_CODING_AGENT_DIR || join(homedir(), '.prime', 'agent');
  const sessionDir = options.sessionDir || process.env.PRIME_AGENT_SESSION_DIR || join(agentHome, 'sessions');
  const dataDir = options.dataDir || process.env.PRIME_AGENT_GUI_DATA_DIR || join(ROOT, '.local');
  const store =
    options.store ||
    createStore({
      sessionDir,
      dataDir,
      initialCwd: options.initialCwd || process.env.PRIME_AGENT_GUI_INITIAL_CWD || ROOT,
    });
  const fileStore = createFileStore(join(dataDir, 'attachments'));
  const remoteAccess = createRemoteAccess({ dataDir });
  const remoteUpdates = createRemoteUpdates({
    dataDir,
    installedVersion: VERSION,
    getActiveRuns: () => activeRuns().length,
  });
  const remoteNetwork = createRemoteNetwork({
    access: remoteAccess,
    upstreamPort: () => server.address()?.port,
    ...options.networkOptions,
  });
  const subagentDefaults = createSubagentDefaultsStore({ dataDir });
  const runs = new Map(),
    sessionLocks = new Set();
  const desktopNotifications = createDesktopNotifications();
  const pushService = options.pushService || createPushService({ dataDir });
  const studioPreferences = () => store.getStudioPreferences?.() || { allowQuestionsByDefault: true };
  const roadmap =
    options.roadmap || createRoadmapService({ resolveProject: (cwd) => store.knowledgeProject(cwd) });
  const roadmapBridge =
    options.roadmapBridge ||
    createRoadmapBridge({
      service: roadmap,
      resolveCaller: createRoadmapCallerResolver({
        getRuns: () => [...runs.values()],
        store,
        agentHome,
        sessionDir,
        readEdges: options.readInspectorEdges,
      }),
      isOwnerActive: (id) => runs.get(id)?.status === 'running',
    });
  const roadmapSession = createRoadmapSessionResolver({
    store,
    agentHome,
    sessionDir,
    readEdges: options.readInspectorEdges,
  });
  // .pastudio portable archives (v1, local-only; never added to the LAN gateway allowlist).
  // getCatalog injects the destination catalog for effective-model finalization
  // (source historical if configured+usable, else destination default if
  // configured+usable). No credentials are read here; models() already returns
  // the sanitized catalog + configuredProviders + default.
  const projectArchives =
    options.projectArchives ||
    createProjectArchives({ store, roadmap, sessionDir, dataDir, agentHome, getCatalog: () => models() });
  async function readRawArchive(req) {
    const type = String(req.headers['content-type'] || '');
    if (!/^application\/octet-stream(?:\s*;|$)/i.test(type))
      throw new HttpError(415, tr('server.un_corps_json_est_requis'));
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > 128 * 1024 * 1024)
      throw new HttpError(413, tr('server.la_demande_depasse_la_taille_autorisee'));
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 128 * 1024 * 1024 + 1)
        throw new HttpError(413, tr('server.la_demande_depasse_la_taille_autorisee'));
      chunks.push(chunk);
    }
    if (!length) throw new HttpError(400, tr('server.la_demande_json_est_invalide'));
    return Buffer.concat(chunks);
  }
  const runtime =
    options.runtime ||
    createAgentRuntime({
      agentHome,
      sessionDir,
      cliPath: process.env.PRIME_AGENT_CLI,
      kernelRoot: process.env.PRIME_AGENT_GUI_KERNEL_ROOT,
      subagentPolicyFile: subagentDefaults.file,
      knowledge: { dataDir },
      roadmap: { config: roadmapBridge.config },
    });
  const modelConfig = options.modelConfig || createModelConfigStore({ agentHome });
  const modelDefaults = options.modelDefaults || createModelDefaultsStore({ agentHome });
  const mcp = options.mcp || createMcpService({ agentHome });
  const directoryPicker = options.directoryPicker || createDirectoryPicker();
  const providers =
    options.providers ||
    createProviderService({
      agentHome,
      isBusy: () => activeRuns().length > 0,
      onChanged: () => invalidateModels(),
    });
  const projectFiles = createProjectFiles({ store, protectedRoots: [agentHome, sessionDir, dataDir] });
  const knowledge = options.knowledge || createKnowledge({ store, dataDir, agentHome, sessionDir });
  const inspector = createSessionInspector({
    store,
    agentHome,
    sessionDir,
    getRun: (id) => [...runs.values()].findLast((run) => run.sessionId === id),
    getClient: () => {
      if (options.inspectorClient) return options.inspectorClient;
      const endpoint = runtime.getLiveEndpoint?.();
      return endpoint ? createLiveSessionClient(endpoint) : null;
    },
    readEdges: options.readInspectorEdges,
  });
  const commands =
    options.commands ||
    createCommandService({
      agentHome,
      getLiveClient: (sessionId, cwd) => {
        if (
          ![...runs.values()].some(
            (run) =>
              run.sessionId === sessionId && cwdKey(run.cwd) === cwdKey(cwd) && run.status === 'running',
          )
        )
          return null;
        const endpoint = runtime.getLiveEndpoint?.();
        return endpoint ? createLiveSessionClient(endpoint) : null;
      },
    });
  const conversationSettings = createConversationSettings({
    store,
    getRuns: () => [...runs.values()],
    getModels: () => models(),
    getClient: () => {
      if (options.liveClient) return options.liveClient;
      const endpoint = runtime.getLiveEndpoint?.();
      return endpoint ? createLiveSessionClient(endpoint) : null;
    },
  });
  const liveMessages = createLiveMessages({
    fileStore,
    validateMessage: async (message, context) => {
      if (parseCommand(message))
        validateCommand(message, await commands.list(context), {
          live: true,
          attachments: context.attachments,
        });
    },
    getRuns: () => [...runs.values()],
    getClient: () => {
      if (options.liveClient) return options.liveClient;
      const endpoint = runtime.getLiveEndpoint?.();
      return endpoint ? createLiveSessionClient(endpoint) : null;
    },
  });
  const roadmapRoutes = createRoadmapRoutes({
    service: roadmap,
    bridge: roadmapBridge,
    store,
    startRun,
    liveMessages,
    getRuns: () => [...runs.values()],
  });
  let closing = false;
  let statusCache,
    modelCache,
    modelRefreshing = false,
    statusAt = 0,
    modelsAt = 0;
  async function status() {
    if (!statusCache || Date.now() - statusAt > 60000) {
      statusCache = Promise.resolve(runtime.getStatus());
      statusAt = Date.now();
    }
    return statusCache;
  }
  async function models({ refresh = false } = {}) {
    if (refresh || !modelCache || Date.now() - modelsAt > (modelRefreshing ? 1000 : 5000)) {
      const request = Promise.resolve(runtime.getModels({ refresh }));
      modelCache = request;
      modelsAt = Date.now();
      request.then(
        (catalog) => {
          if (modelCache === request) modelRefreshing = !!catalog.refreshing;
        },
        () => {
          if (modelCache === request) invalidateModels();
        },
      );
    }
    return modelCache;
  }
  function invalidateModels() {
    modelCache = undefined;
    modelsAt = 0;
  }
  async function configuredModels(operation) {
    const configuration = await operation;
    invalidateModels();
    return { ...configuration, catalog: await models() };
  }
  async function setDefaultModel(body) {
    if (
      !body ||
      Object.keys(body).some((key) => key !== 'model') ||
      typeof body.model !== 'string' ||
      body.model.length > 500
    )
      throw new HttpError(400, tr('server.selection_de_modele_invalide'));
    let selection = null;
    if (body.model) {
      const catalog = await models(),
        selected = catalog.models?.find((model) => model.id === body.model),
        prefix = selected ? `${selected.provider}/` : '';
      if (!selected || !selected.id.startsWith(prefix) || selected.id.length === prefix.length)
        throw new HttpError(400, tr('server.ce_modele_n_est_pas_disponible_dans_prime_agent'));
      if (selected.availability === 'unavailable') throw new HttpError(409, tr('model.unavailableSelection'));
      selection = { provider: selected.provider, id: selected.id.slice(prefix.length) };
    }
    return configuredModels(modelDefaults.set(selection));
  }
  function activeRuns() {
    return [...runs.values()].filter((r) => r.status === 'running' || r.status === 'stopping').map(publicRun);
  }
  function pushEvent(run, event) {
    if (event.kind === 'interaction') {
      run.interactions ||= [];
      const index = run.interactions.findIndex((item) => item.id === event.request.id);
      if (index < 0) run.interactions.push(event.request);
      else run.interactions[index] = event.request;
      if (index < 0 && event.request.status === 'pending') {
        desktopNotifications.publish('question', run, event.request.id);
        void pushService
          .notify('question', { sessionId: run.sessionId, runId: run.id })
          .catch(() => {});
      }
    }
    if (event.kind === 'session' && event.sessionId) {
      run.sessionId = event.sessionId;
      sessionLocks.add(event.sessionId);
      roadmapRoutes.onSession(run);
      if (run.allowQuestions !== undefined)
        void store
          .setConversationSettings(event.sessionId, { allowQuestions: run.allowQuestions })
          .catch(console.error);
    }
    if (event.kind === 'done') {
      if (run.finished) return;
      run.finished = true;
      roadmapBridge.revokeOwner(run.id);
      run.status = event.status || ((event.code ?? 0) === 0 ? 'completed' : 'failed');
      run.error = event.error || null;
      if (run.status === 'failed' && isModelAvailabilityError(run.error))
        void models({ refresh: true }).catch(() => {});
      run.endedAt = new Date().toISOString();
      if (['completed', 'failed'].includes(run.status)) {
        desktopNotifications.publish('turnComplete', run);
        void pushService
          .notify('turnComplete', { sessionId: run.sessionId, runId: run.id })
          .catch(() => {});
      }
      if (run.sessionId) sessionLocks.delete(run.sessionId);
    }
    const item = { ...event, seq: ++run.seq };
    const wire = `id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`;
    run.events.push({ item, wire });
    run.bytes += Buffer.byteLength(wire);
    // Streaming output is bounded per execution; durable native history remains available.
    while (run.bytes > 16 * 1024 * 1024 && run.events.length > 1) {
      const removed = run.events.shift();
      run.bytes -= Buffer.byteLength(removed.wire);
    }
    for (const client of run.clients) {
      if (client.writableLength > 16 * 1024 * 1024) {
        client.destroy();
        run.clients.delete(client);
      } else client.write(wire);
    }
    if (run.finished) {
      for (const client of run.clients) client.end();
      run.clients.clear();
    }
  }
  async function startRun(body) {
    if (closing) throw new HttpError(503, tr('server.le_serveur_est_en_cours_d_arret'));
    await roadmapBridge.ready;
    if (activeRuns().length >= 8)
      throw new HttpError(429, tr('server.huit_sessions_tournent_deja_arretez_en_une_avant_de_continuer'));
    const cwd = await validateDirectory(body.cwd);
    const images = validateImages(body.images);
    const files = validateFiles(body.files);
    if (images.length + files.length > 8)
      throw new HttpError(400, tr('server.ajoutez_au_maximum_8_pieces_jointes'));
    if (typeof body.message !== 'string' || (!body.message.trim() && !images.length && !files.length))
      throw new HttpError(400, tr('server.ecrivez_un_message_avant_de_l_envoyer'));
    if (body.message.length > 200000)
      throw new HttpError(400, tr('server.le_message_depasse_200_000_caracteres'));
    if (parseCommand(body.message))
      validateCommand(body.message, await commands.list({ cwd }), {
        attachments: images.length + files.length > 0,
      });
    if (images.length) {
      const catalog = await models();
      const selected = catalog.models?.find((model) => model.id === (body.model || catalog.default?.model));
      if (selected?.input && !selected.input.includes('image'))
        throw new HttpError(400, tr('ui.ce_modele_ne_prend_pas_en_charge_les_images_choisissez_un_modele'));
    }
    if (
      body.model !== undefined &&
      (typeof body.model !== 'string' || body.model.length > 300 || /[\r\n\0]/.test(body.model))
    )
      throw new HttpError(400, tr('server.modele_invalide'));
    if (
      body.thinking != null &&
      body.thinking !== '' &&
      !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.thinking)
    )
      throw new HttpError(400, tr('server.niveau_de_reflexion_invalide'));
    if (body.sessionId != null && body.sessionId !== '' && !validId(body.sessionId))
      throw new HttpError(400, tr('server.identifiant_de_session_invalide'));
    let existing;
    if (body.sessionId) {
      existing = await store.history(body.sessionId);
      if (!existing.cwd || cwdKey(cwd) !== cwdKey(existing.cwd))
        throw new HttpError(409, tr('server.cette_session_appartient_a_un_autre_dossier'));
    }
    const catalog = await models();
    const settings = existing?.generationSettings;
    // .pastudio gate first (before selectedModel): imported sessions use the
    // auto-assigned destination effective model so the run never executes the
    // old unavailable archived model when a usable fallback exists. Pending
    // storage integrity is never bypassed (fail-closed on unknown). An explicit
    // usable pick still validates and persists; only when no usable model
    // exists is an explicit choice required. The explicit choice is persisted
    // BEFORE spawn so a spawn failure cannot lose it; the flag is consumed only
    // AFTER runtime.start resolves (see below).
    let pastudioGated = false;
    let pastudioResolved = null;
    if (existing?.id) {
      await projectArchives.recoverPending().catch(() => {});
      const check = await projectArchives.checkPastudioModelGate(existing.id, body.model, catalog);
      pastudioGated = check.gated;
      pastudioResolved = typeof check.model === 'string' ? check.model : null;
    }
    // Echo-safe: the client always echoes a model (selector restore), so for
    // imported sessions a stale echo equal to verbatim history must not win
    // over a usable resolved fallback. Gate already resolves echo==historical
    // to stored/default when usable; prefer resolved first for imported.
    // True explicit usable picks equal resolved, so no valid choice is
    // overwritten; true explicit unavailable (not echo) already 409s in gate.
    const selectedModel =
      (pastudioResolved ?? body.model ?? settings?.model ?? existing?.model) || catalog.default?.model;
    const selectedThinking =
      (body.thinking ?? settings?.thinking ?? existing?.thinking) || catalog.default?.thinking;
    if (body.allowQuestions !== undefined && typeof body.allowQuestions !== 'boolean')
      throw new HttpError(400, tr('server.demande_invalide'));
    const allowQuestions =
      body.allowQuestions ?? settings?.allowQuestions ?? (await studioPreferences()).allowQuestionsByDefault;
    if (catalog.models?.find((model) => model.id === selectedModel)?.availability === 'unavailable')
      throw new HttpError(409, tr('model.unavailableSelection'));
    // Check after awaited validation so simultaneous HTTP requests cannot race the lock.
    if (activeRuns().length >= 8)
      throw new HttpError(429, tr('server.huit_sessions_tournent_deja_arretez_en_une_avant_de_continuer'));
    if (existing && (sessionLocks.has(existing.id) || conversationSettings.busy(existing.id)))
      throw new HttpError(409, tr('server.cette_session_travaille_deja'));
    if (existing) sessionLocks.add(existing.id);
    const run = {
      id: randomUUID(),
      sessionId: existing?.id || null,
      cwd,
      status: 'running',
      startedAt: new Date().toISOString(),
      model: selectedModel || null,
      thinking: selectedThinking || null,
      allowQuestions,
      interactions: [],
      prompt: body.message.trim() || tr('ui.analyse_les_pieces_jointes'),
      seq: 0,
      events: [],
      bytes: 0,
      clients: new Set(),
      finished: false,
    };
    runs.set(run.id, run);
    try {
      run.prompt = appendFileMessage(run.prompt, await fileStore.save(files));
      if (pastudioGated && existing?.id && typeof body.model === 'string' && body.model)
        await store.setConversationSettings(existing.id, { model: body.model });
      run.handle = await runtime.start({
        cwd,
        message: run.prompt,
        ...(images.length ? { images } : {}),
        sessionId: existing?.id,
        sessionFile: existing?.file,
        model: selectedModel || undefined,
        thinking: selectedThinking || undefined,
        allowQuestions,
        onEvent: (event) => pushEvent(run, event),
      });
      if (existing?.id) await store.consumePastudioModelGate?.(existing.id).catch(() => {});
      if (run.status === 'stopping') void run.handle.cancel();
      Promise.resolve(run.handle.done).then(
        (result) => {
          if (!run.finished)
            pushEvent(run, {
              kind: 'done',
              sessionId: run.sessionId,
              status: result?.status || 'completed',
              code: result?.code || 0,
              error: result?.error,
            });
        },
        (error) =>
          pushEvent(run, {
            kind: 'done',
            sessionId: run.sessionId,
            status: 'failed',
            code: -1,
            error: error.message,
          }),
      );
    } catch (error) {
      roadmapBridge.revokeOwner(run.id);
      runs.delete(run.id);
      if (existing) sessionLocks.delete(existing.id);
      throw new HttpError(503, error.message);
    }
    return publicRun(run);
  }
  function subscribe(req, res, run, url) {
    let after = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
    if (!Number.isSafeInteger(after) || after < 0) after = 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    if (run.events[0]?.item.seq > after + 1)
      res.write(`data: ${JSON.stringify({ kind: 'replay_truncated', sessionId: run.sessionId })}\n\n`);
    for (const event of run.events) if (event.item.seq > after) res.write(event.wire);
    if (run.finished) {
      res.end();
      return;
    }
    run.clients.add(res);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    heartbeat.unref();
    res.on('close', () => {
      clearInterval(heartbeat);
      run.clients.delete(res);
    });
  }
  const cleanup = setInterval(() => {
    for (const [id, run] of runs)
      if (run.finished && Date.now() - Date.parse(run.endedAt) > 3600000) runs.delete(id);
  }, 60000);
  cleanup.unref();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host))
        throw new HttpError(403, tr('server.hote_non_autorise'));
      if (req.headers.origin && req.headers.origin !== `http://${host}`)
        throw new HttpError(403, tr('server.origine_non_autorisee'));
      if (req.headers['sec-fetch-site'] === 'cross-site')
        throw new HttpError(403, tr('server.requete_externe_non_autorisee'));
      const url = new URL(req.url, `http://${host}`),
        path = url.pathname,
        method = req.method;
      if (method === 'GET' && path === '/api/health')
        return json(res, 200, {
          service: 'prime-agent-gui',
          version: VERSION,
          pid: process.pid,
          status: 'ok',
          instanceId: process.env.PRIME_AGENT_GUI_INSTANCE || null,
        });
      if (method === 'GET' && path === '/api/bootstrap') {
        const [overview, version, catalog] = await Promise.all([store.overview(), status(), models()]);
        return json(res, 200, {
          ...overview,
          version,
          models: catalog,
          studioPreferences: await studioPreferences(),
          runs: activeRuns(),
          preferences: {
            attachments: true,
            inspector: true,
            nativeFileOpen: true,
            providers: true,
            directoryPicker: process.platform === 'win32',
          },
        });
      }
      if (method === 'GET' && path === '/api/version') return json(res, 200, await status());
      if (path === '/api/system' && method === 'GET')
        return json(res, 200, {
          studio: VERSION,
          node: process.versions.node,
          platform: process.platform,
          runtime: await status(),
          activeRuns: activeRuns().length,
        });
      if (path === '/api/system/logs' && method === 'POST') {
        await readBody(req);
        const logs = join(dataDir, 'logs');
        await mkdir(logs, { recursive: true });
        await (options.openDirectory || openDirectory)(logs);
        return json(res, 200, { opened: true });
      }
      if (path === '/api/remote-access/network' && method === 'GET')
        return json(res, 200, await remoteNetwork.get());
      if (path === '/api/remote-access/network' && method === 'POST')
        return json(res, 200, await remoteNetwork.configure(await readBody(req)));
      if (path === '/api/remote-access/qr' && method === 'GET')
        return json(res, 200, await remoteNetwork.qr(url.searchParams.get('channel')));
      if (path === '/api/remote-access' && method === 'GET') return json(res, 200, await remoteAccess.get());
      if (path === '/api/passkeys' && method === 'GET') return json(res, 200, await remoteAccess.listPasskeys());
      if (path === '/api/passkeys/revoke' && method === 'POST') return json(res, 200, await remoteAccess.revokePasskey((await readBody(req)).id));
      if (path === '/api/remote-access/code' && method === 'POST')
        return json(res, 200, await remoteAccess.changeCode(await readBody(req)));
      if (method === 'GET' && path === '/api/updates/metadata')
        return json(res, 200, await remoteUpdates.metadata({ force: url.searchParams.get('refresh') === '1' }));
      if (method === 'POST' && path === '/api/updates/request')
        return json(res, 200, await remoteUpdates.requestUpdate(await readBody(req)));
      if (method === 'GET' && path === '/api/models') return json(res, 200, await models());
      if (method === 'POST' && path === '/api/models/refresh') {
        await readBody(req);
        return json(res, 200, await models({ refresh: true }));
      }
      if (method === 'GET' && path === '/api/inspector')
        return json(
          res,
          200,
          await inspector.inspect(url.searchParams.get('cwd'), url.searchParams.get('sessionId')),
        );
      if (method === 'GET' && path === '/api/inspector/history')
        return json(
          res,
          200,
          await inspector.history(
            url.searchParams.get('cwd'),
            url.searchParams.get('sessionId'),
            url.searchParams.get('agentId'),
          ),
        );
      if (method === 'POST' && path === '/api/project-files/open') {
        const body = await readBody(req);
        const file = await projectFiles.localFile(body.cwd, body.path);
        fileLaunchMode(file);
        return json(res, 200, await (options.openFile || openLocalFile)(file));
      }
      if (['GET', 'HEAD'].includes(method) && path === '/api/project-files/image') {
        const image = await projectFiles.image(
          url.searchParams.get('cwd'),
          url.searchParams.get('reference'),
          url.searchParams.get('basePath') || '',
        );
        res.writeHead(200, {
          'Content-Type': image.type,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Content-Length': image.data.length,
        });
        return res.end(method === 'HEAD' ? undefined : image.data);
      }
      if (method === 'GET' && path.startsWith('/api/project-files')) {
        const cwd = url.searchParams.get('cwd'),
          file = url.searchParams.get('path') || '';
        if (path === '/api/project-files')
          return json(
            res,
            200,
            await projectFiles.list(cwd, file, Number(url.searchParams.get('offset') || 0)),
          );
        if (path === '/api/project-files/changes') return json(res, 200, await projectFiles.changes(cwd));
        if (path === '/api/project-files/preview')
          return json(res, 200, await projectFiles.preview(cwd, file));
        if (path === '/api/project-files/resolve')
          return json(
            res,
            200,
            await projectFiles.resolveReference(
              cwd,
              url.searchParams.get('reference'),
              url.searchParams.get('basePath') || '',
            ),
          );
        if (path === '/api/project-files/diff') return json(res, 200, await projectFiles.diff(cwd, file));
        if (path === '/api/project-files/download') {
          const result = await projectFiles.download(cwd, file);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': result.data.length,
            'Content-Disposition': `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(result.name.toWellFormed()).replace(/['()*]/g, (value) => '%' + value.charCodeAt(0).toString(16))}`,
            'Cache-Control': 'no-store',
          });
          return res.end(result.data);
        }
      }
      if (method === 'GET' && /^\/api\/files\/[a-f0-9-]+$/.test(path)) {
        const file = await fileStore.read(path.slice('/api/files/'.length));
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': file.data.length,
          'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.name.toWellFormed()).replace(/['()*]/g, (value) => '%' + value.charCodeAt(0).toString(16))}`,
          'Cache-Control': 'no-store',
        });
        res.end(file.data);
        return;
      }
      if (method === 'GET' && path === '/api/providers') return json(res, 200, await providers.list());
      // Minimal safe linkage metadata for mobile/remote quota.
      // No credentials, no full provider list. Authenticated gateway may proxy this read-only GET.
      if (method === 'GET' && path === '/api/providers/codex-link')
        return json(res, 200, await providers.codexLink());
      if (method === 'GET' && path === '/api/providers/codex-usage')
        return json(
          res,
          200,
          await providers.codexUsage({
            provider: url.searchParams.get('provider') || 'openai-codex',
            revision: url.searchParams.get('revision') || '',
          }),
        );
      if (method === 'POST' && path === '/api/providers/key')
        return json(res, 200, await providers.save(await readBody(req)));
      if (method === 'POST' && path === '/api/providers/disconnect')
        return json(res, 200, await providers.remove(await readBody(req)));
      if (method === 'POST' && path === '/api/providers/login')
        return json(res, 200, providers.login(await readBody(req)));
      const providerJob = path.match(/^\/api\/providers\/login\/([a-f0-9-]{36})$/);
      if (providerJob && method === 'GET') return json(res, 200, providers.job(providerJob[1]));
      if (providerJob && method === 'POST')
        return json(res, 200, providers.answer(providerJob[1], await readBody(req)));
      if (providerJob && method === 'DELETE') return json(res, 200, providers.cancel(providerJob[1]));
      if (method === 'GET' && path === '/api/model-config') return json(res, 200, await modelConfig.list());
      if (path === '/api/commands' && method === 'GET')
        return json(
          res,
          200,
          await commands.list({
            cwd: url.searchParams.get('cwd'),
            sessionId: url.searchParams.get('sessionId') || undefined,
          }),
        );
      if (path === '/api/commands/open-directory' && method === 'POST') {
        const body = await readBody(req);
        if (!['skill', 'prompt'].includes(body.source) || !['global', 'project'].includes(body.scope))
          throw new HttpError(400, tr('folders.invalid_resource'));
        const project = await store.findProject(body.cwd);
        const base = body.scope === 'global' ? agentHome : join(project.cwd, '.prime', 'agent');
        const folder = join(base, body.source === 'skill' ? 'skills' : 'prompts');
        await mkdir(folder, { recursive: true });
        return json(res, 200, await (options.openDirectory || openDirectory)(folder));
      }
      if (path === '/api/mcp' && method === 'GET') return json(res, 200, await mcp.list());
      if (path === '/api/mcp' && method === 'POST')
        return json(res, 200, await mcp.upsert(await readBody(req)));
      if (path === '/api/mcp' && method === 'PATCH')
        return json(res, 200, await mcp.toggle(await readBody(req)));
      if (path === '/api/mcp' && method === 'DELETE')
        return json(res, 200, await mcp.remove(await readBody(req)));
      if (path === '/api/mcp/test' && method === 'POST')
        return json(res, 200, await mcp.probe(await readBody(req)));
      if (path === '/api/mcp/login' && method === 'POST')
        return json(res, 200, await mcp.login(await readBody(req)));
      if (path === '/api/mcp/disconnect' && method === 'POST')
        return json(res, 200, await mcp.disconnect(await readBody(req)));
      if (path === '/api/mcp/login/complete' && method === 'POST')
        return json(res, 200, await mcp.complete(await readBody(req)));
      const mcpJob = path.match(/^\/api\/mcp\/login\/([a-f0-9-]{36})$/);
      if (mcpJob && method === 'GET') return json(res, 200, mcp.job(mcpJob[1]));
      if (mcpJob && method === 'DELETE') return json(res, 200, mcp.cancel(mcpJob[1]));
      if (method === 'GET' && path === '/api/model-defaults')
        return json(res, 200, await modelDefaults.get());
      if (
        ['/api/subagent-defaults', '/api/project-subagent-defaults'].includes(path) &&
        ['GET', 'POST'].includes(method)
      ) {
        const body = method === 'POST' ? await readBody(req) : {};
        if (Object.keys(body).some((key) => !['cwd', 'policy', 'revision'].includes(key)))
          throw new HttpError(400, tr('server.reglages_des_sous_agents_invalides'));
        if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !body.cwd.trim()))
          throw new HttpError(400, tr('server.projet_invalide'));
        const cwd = body.cwd || url.searchParams.get('cwd') || undefined;
        if (path === '/api/project-subagent-defaults' && !cwd)
          throw new HttpError(400, tr('server.choisissez_un_projet_pour_modifier_ses_sous_agents'));
        if (cwd) await store.findProject(cwd);
        if (method === 'GET') return json(res, 200, await subagentDefaults.get(cwd));
        if (body.policy !== null) {
          if (!validPolicy(body.policy))
            throw new HttpError(400, tr('server.reglages_des_sous_agents_invalides'));
          if (body.policy.model) {
            const model = (await models()).models?.find((m) => m.id === body.policy.model);
            if (!model)
              throw new HttpError(400, tr('server.ce_modele_n_est_pas_disponible_dans_prime_agent'));
            if (model.availability === 'unavailable')
              throw new HttpError(409, tr('model.unavailableSelection'));
            if (body.policy.thinking && !model.thinkingLevels?.includes(body.policy.thinking))
              throw new HttpError(
                400,
                tr('server.ce_niveau_de_reflexion_n_est_pas_compatible_avec_le_modele_chois'),
              );
          }
        }
        return json(res, 200, await subagentDefaults.set({ ...body, cwd }));
      }
      if (method === 'POST' && path === '/api/model-defaults')
        return json(res, 200, await setDefaultModel(await readBody(req)));
      if (method === 'POST' && path === '/api/model-config')
        return json(res, 200, await configuredModels(modelConfig.upsert(await readBody(req))));
      if (method === 'DELETE' && path === '/api/model-config')
        return json(res, 200, await configuredModels(modelConfig.remove(await readBody(req))));
      if (path.startsWith('/api/live/'))
        return json(
          res,
          200,
          await routeLiveMessages({
            service: liveMessages,
            method,
            url,
            readBody: () => readBody(req),
          }),
        );
      if (method === 'GET' && path === '/api/overview')
        return json(res, 200, {
          ...(await store.overview()),
          runs: activeRuns(),
          studioPreferences: await studioPreferences(),
        });
      if (path === '/api/studio-preferences') {
        if (method === 'GET') return json(res, 200, await studioPreferences());
        if (method === 'PATCH') return json(res, 200, await store.setStudioPreferences(await readBody(req)));
      }
      // Deliberately absent from the remote gateway's route allowlist.
      if (method === 'GET' && path === '/api/desktop-notifications')
        return json(
          res,
          200,
          desktopNotifications.snapshot(Number(url.searchParams.get('after')) || 0, runs),
        );
      if (method === 'GET' && path === '/api/push/vapid-key')
        return json(res, 200, { publicKey: await pushService.publicKey() });
      if (method === 'GET' && path === '/api/push/subscriptions')
        return json(res, 200, await pushService.preferences(url.searchParams.get('endpoint') || ''));
      if (method === 'POST' && path === '/api/push/subscriptions') {
        const body = await readBody(req);
        const sub = body.subscription || {};
        return json(
          res,
          201,
          await pushService.subscribe({
            endpoint: sub.endpoint,
            p256dh: sub.keys?.p256dh,
            auth: sub.keys?.auth,
            questions: body.questions,
            turnComplete: body.turnComplete,
            token: body.token,
          }),
        );
      }
      if (method === 'PATCH' && path === '/api/push/subscriptions')
        return json(res, 200, await pushService.update(await readBody(req)));
      if (method === 'DELETE' && path === '/api/push/subscriptions')
        return json(res, 200, await pushService.unsubscribe(await readBody(req)));
      if (method === 'POST' && path === '/api/push/focus')
        return json(res, 200, await pushService.focus(await readBody(req)));
      if (method === 'GET' && path === '/api/roadmap')
        return json(res, 200, await roadmapRoutes.read(url.searchParams.get('cwd')));
      if (method === 'GET' && path === '/api/roadmap/session')
        return json(
          res,
          200,
          await roadmapSession({
            cwd: url.searchParams.get('cwd'),
            sessionId: url.searchParams.get('sessionId'),
            rootSessionId: url.searchParams.get('rootSessionId') || undefined,
          }),
        );
      if (method === 'POST' && path === '/api/roadmap')
        return json(res, 200, await roadmapRoutes.mutate(await readBody(req)));
      if (method === 'POST' && path === '/api/roadmap/work')
        return json(res, 201, await roadmapRoutes.work(await readBody(req)));
      if (method === 'POST' && path === '/api/roadmap/retry-links')
        return json(res, 200, await roadmapRoutes.retryLinks(await readBody(req)));
      if (method === 'GET' && path === '/api/roadmap/export') {
        const markdown = await roadmapRoutes.exportMarkdown(url.searchParams.get('cwd'));
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': 'attachment; filename="roadmap.md"',
          'Cache-Control': 'no-store',
        });
        res.end(markdown);
        return;
      }
      // .pastudio portable archives v1 (local-only; absent from the LAN gateway allowlist).
      // State-changing import is POST only, never GET. Raw octet-stream uploads only.
      if (method === 'GET' && path === '/api/project-archives/export') {
        const result = await projectArchives.exportArchive(url.searchParams.get('cwd'));
        const safeName = String(result.manifest?.sourceProject?.name || 'projet')
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 60) || 'projet';
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': result.buffer.length,
          'Content-Disposition': `attachment; filename="${safeName}-${stamp}.pastudio"`,
          'X-Pastudio-Archive-Id': result.archiveId,
          'X-Pastudio-Digest': result.payloadDigest,
          'X-Pastudio-Warning': 'histories-may-contain-secrets',
          'Cache-Control': 'no-store',
        });
        res.end(result.buffer);
        return;
      }
      if (method === 'POST' && path === '/api/project-archives/preview') {
        const raw = await readRawArchive(req);
        return json(res, 200, await projectArchives.previewArchive(raw, url.searchParams.get('cwd')));
      }
      if (method === 'POST' && path === '/api/project-archives/import') {
        const raw = await readRawArchive(req);
        return json(
          res,
          200,
          await projectArchives.importArchive(raw, url.searchParams.get('cwd'), url.searchParams.get('token')),
        );
      }
      if (method === 'GET' && path === '/api/knowledge')
        return json(
          res,
          200,
          await knowledge.search({
            cwd: url.searchParams.get('cwd'),
            q: url.searchParams.get('q') || '',
            kind: url.searchParams.get('kind') || 'all',
            limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 30,
            cursor: url.searchParams.get('cursor') || undefined,
          }),
        );
      if (method === 'GET' && path === '/api/knowledge/item')
        return json(
          res,
          200,
          await knowledge.detail({ cwd: url.searchParams.get('cwd'), id: url.searchParams.get('id') }),
        );
      if (method === 'GET' && path === '/api/history') {
        const { file, ...history } = await store.history(url.searchParams.get('id'));
        return json(res, 200, history);
      }
      if (method === 'POST' && path === '/api/sessions/read')
        return json(res, 200, await store.markRead(await readBody(req)));
      if (method === 'POST' && path === '/api/projects/move')
        return json(res, 200, await store.moveProject(await readBody(req)));
      if (method === 'POST' && path === '/api/sessions/move')
        return json(res, 200, await store.moveSession(await readBody(req)));
      if (method === 'GET' && path === '/api/check-cwd') {
        try {
          return json(res, 200, { cwd: await validateDirectory(url.searchParams.get('cwd')), exists: true });
        } catch {
          return json(res, 200, { cwd: url.searchParams.get('cwd'), exists: false });
        }
      }
      if ((method === 'POST' || method === 'PATCH') && path === '/api/projects')
        return json(
          res,
          method === 'POST' ? 201 : 200,
          await store.project(await readBody(req), method === 'PATCH'),
        );
      if (method === 'POST' && path === '/api/projects/pick-directory') {
        const body = await readBody(req);
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once('close', abort);
        if (res.destroyed) abort();
        try {
          const result = await directoryPicker.pick({
            cwd: body.cwd,
            title: tr('folders.choose', {}, requestLanguage(req.headers)),
            signal: controller.signal,
          });
          if (!res.destroyed) return json(res, 200, result);
          return;
        } finally {
          res.off('close', abort);
        }
      }
      if (method === 'POST' && path === '/api/projects/open') {
        const project = await store.findProject((await readBody(req)).cwd);
        return json(res, 200, await (options.openDirectory || openDirectory)(project.cwd));
      }
      if (method === 'DELETE' && path === '/api/projects') {
        const project = await store.findProject((await readBody(req)).cwd);
        if (activeRuns().some((run) => cwdKey(run.cwd) === cwdKey(project.cwd)))
          throw new HttpError(
            409,
            tr('server.un_agent_travaille_dans_ce_projet_attendez_sa_fin_avant_de_le_re'),
          );
        return json(res, 200, await store.removeProject(project.cwd));
      }
      if (method === 'PATCH' && path === '/api/conversation-settings')
        return json(res, 200, await conversationSettings.update(await readBody(req)));
      if (method === 'PATCH' && path === '/api/sessions')
        return json(res, 200, await store.patchSession(await readBody(req)));
      if (method === 'GET' && path === '/api/runs') return json(res, 200, { runs: activeRuns() });
      if (method === 'POST' && path === '/api/runs')
        return json(res, 201, await startRun(await readBody(req)));
      const runRoute = path.match(/^\/api\/runs\/([a-f0-9-]+)\/(events|stop|interactions)$/);
      if (runRoute) {
        const run = runs.get(runRoute[1]);
        if (!run) throw new HttpError(404, tr('server.execution_introuvable_rechargez_son_historique'));
        if (method === 'POST' && runRoute[2] === 'interactions') {
          if (run.finished || run.status !== 'running' || !run.handle?.respond)
            throw new HttpError(409, tr('questions.closed'));
          const body = await readBody(req);
          try {
            return json(res, 200, await run.handle.respond(body.id, body.response));
          } catch (error) {
            throw new HttpError(409, error.message);
          }
        }
        if (method === 'GET' && runRoute[2] === 'events') return subscribe(req, res, run, url);
        if (method === 'POST' && runRoute[2] === 'stop') {
          if (!run.finished) {
            run.status = 'stopping';
            roadmapBridge.revokeOwner(run.id);
            await run.handle?.cancel();
          }
          return json(res, 200, { stopped: true, ...publicRun(run) });
        }
      }
      if (method === 'GET' || method === 'HEAD') {
        let file;
        if (path === '/' || path === '/index.html') file = join(ROOT, 'index.html');
        else if (path === '/vendor/marked.js')
          file = join(ROOT, 'node_modules', 'marked', 'lib', 'marked.esm.js');
        else if (path === '/vendor/purify.js')
          file = join(ROOT, 'node_modules', 'dompurify', 'dist', 'purify.es.mjs');
        else if (path === '/vendor/passkeys.js')
          file = join(ROOT, 'node_modules', '@simplewebauthn', 'browser', 'dist', 'bundle', 'index.umd.min.js');
        else if (path === '/favicon.ico') file = join(ROOT, 'assets', 'prime-agent.ico');
        else if (path === '/manifest.webmanifest') {
          const locale = requestLanguage(req.headers, url.searchParams.get('lang'));
          const manifest = JSON.parse(await readFile(join(ROOT, 'public', 'manifest.webmanifest'), 'utf8'));
          manifest.lang = locale;
          manifest.description = tr('pwa.description', {}, locale);
          res.writeHead(200, {
            'Content-Type': 'application/manifest+json',
            'Cache-Control': 'no-cache',
            Vary: 'Accept-Language, Cookie',
          });
          res.end(method === 'HEAD' ? undefined : JSON.stringify(manifest));
          return;
        } else if (path === '/service-worker.js') file = join(ROOT, 'public', 'service-worker.js');
        else if (path.startsWith('/public/')) {
          const base = resolve(ROOT, 'public');
          file = resolve(ROOT, '.' + decodeURIComponent(path));
          if (!file.startsWith(base + sep)) throw new HttpError(404, tr('server.fichier_introuvable'));
        } else if (path.startsWith('/assets/')) {
          const base = resolve(ROOT, 'assets');
          file = resolve(ROOT, '.' + decodeURIComponent(path));
          if (!file.startsWith(base + sep)) throw new HttpError(404, tr('server.fichier_introuvable'));
        }
        if (file) {
          if (!(await stat(file).catch(() => null))?.isFile())
            throw new HttpError(404, tr('server.fichier_introuvable'));
          res.writeHead(200, {
            'Content-Type':
              MIME[extname(file)] ||
              (extname(file) === '.mjs' ? 'text/javascript; charset=utf-8' : 'application/octet-stream'),
            'Cache-Control': 'no-cache',
          });
          res.end(method === 'HEAD' ? undefined : await readFile(file));
          return;
        }
      }
      throw new HttpError(404, tr('server.route_introuvable'));
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, error.status || 500, {
        ...(tailscaleSetupUrl(error.setupUrl) ? { setupUrl: tailscaleSetupUrl(error.setupUrl) } : {}),
        error: error.status ? error.message : tr('server.une_erreur_interne_est_survenue') + error.message,
        ...(typeof error.code === 'string' &&
        (error.code.startsWith('roadmap_') || error.code.startsWith('pastudio_'))
          ? {
              code: error.code,
              // Allowlisted .pastudio pending-contract fields only (server-generated, no secrets).
              ...Object.fromEntries(
                [
                  'recoverable',
                  'pending',
                  'pendingFinalization',
                  'marksPending',
                  'lineagePending',
                  'duplicate',
                  'archiveId',
                  'payloadDigest',
                  'destinationCwd',
                  'destCwd',
                ]
                  .filter((key) => error[key] !== undefined)
                  .map((key) => [key, error[key]]),
              ),
            }
          : {}),
        ...(Number.isSafeInteger(error.currentRevision) ? { currentRevision: error.currentRevision } : {}),
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  async function close() {
    remoteNetwork.close();
    directoryPicker.close?.();
    mcp.close?.();
    providers.close?.();
    commands.close?.();
    closing = true;
    clearInterval(cleanup);
    await roadmapBridge.close();
    await runtime.close();
    await roadmapRoutes.close();
    await roadmap.close();
    for (const run of runs.values()) for (const client of run.clients) client.end();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  return {
    server,
    store,
    runtime,
    modelConfig,
    modelDefaults,
    remoteAccess,
    remoteNetwork,
    roadmap,
    roadmapBridge,
    projectArchives,
    runs,
    pushService,
    close,
  };
}

if (isDirectInvocation(import.meta.url)) {
  const port = Number(process.env.PORT || 3088);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(tr('server.port_doit_etre_compris_entre_1_et_65535'));
  const app = createApp();
  async function startNetwork() {
    try {
      await app.remoteNetwork.start();
      for (const channel of (await app.remoteNetwork.get()).channels) {
        if (channel.url) console.log(tr('server.acces', { value1: channel.kind, value2: channel.url }));
        else if (channel.enabled)
          console.error(tr('server.acces_indisponible', { value1: channel.kind, value2: channel.error }));
      }
    } catch (error) {
      console.error(tr('server.acces_mobile_indisponible', { value1: error.message }));
    }
  }
  app.server.on('error', (error) => {
    console.error(
      error.code === 'EADDRINUSE'
        ? tr('server.le_port_est_deja_utilise_ouvrez_http_127_0_0_1_ou_definissez_por', {
            value1: port,
            value2: port,
          })
        : error.message,
    );
    process.exitCode = 1;
  });
  // B2: replay-or-rollback pending .pastudio imports before accepting traffic.
  await app.projectArchives.recoverPending().catch(() => {});
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`Prime Agent Studio ${VERSION} — http://127.0.0.1:${port}`);
    void startNetwork();
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      const timer = setTimeout(() => process.exit(1), 10000);
      timer.unref();
      app.close().then(() => process.exit(0));
    });
}
