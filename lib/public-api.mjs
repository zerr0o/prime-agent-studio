import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { cwdKey, HttpError, validId } from './store.mjs';
import { getStudioMachineId } from './studio-identity.mjs';
import { createPublicApiFiles } from './public-api-files.mjs';
import { publicApiOperations, validatePublicApiBody } from './public-api-contract.mjs';

const fail = (status, code, message) => Object.assign(new HttpError(status, message), { code });
const missing = () => fail(404, 'not_found', 'Resource not found.');
const pick = (value, keys) =>
  Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
export const publicProjectId = (cwd) =>
  'p_' + createHash('sha256').update(cwdKey(cwd)).digest('hex').slice(0, 32);
export const isPublicApiPath = (path) => path === '/api/v1' || path.startsWith('/api/v1/');
export const isPublicApiAdminPath = (path) =>
  path === '/api/public-api' || path.startsWith('/api/public-api/');
const operations = publicApiOperations.map((operation) => ({
  ...operation,
  names: [...operation.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]),
  pattern: new RegExp('^' + operation.path.replace(/\{\w+\}/g, '([^/]+)') + '$'),
}));
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
export function publicApiError(res, error) {
  error ??= {};
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy();
  const status =
    Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const defaults = {
    400: 'invalid_request',
    401: 'api_unauthorized',
    403: 'forbidden',
    404: 'not_found',
    405: 'method_not_allowed',
    409: 'conflict',
    413: 'body_too_large',
    415: 'json_required',
    429: 'too_many_requests',
    503: 'unavailable',
  };
  if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="Prime Agent Studio"');
  json(res, status, {
    error: status >= 500 ? 'The operation could not be completed.' : error.message,
    code:
      typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(error.code)
        ? error.code
        : defaults[status] || 'internal_error',
    ...(Number.isSafeInteger(error.currentRevision) ? { currentRevision: error.currentRevision } : {}),
  });
}
function pagination(url, allowed = ['limit', 'offset']) {
  const seen = new Set();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || seen.has(key))
      throw fail(400, 'invalid_query', 'Unknown or repeated query parameter.');
    seen.add(key);
  }
  const integer = (key, fallback, maximum) => {
    const raw = url.searchParams.get(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value > maximum ||
      value < (key === 'limit' ? 1 : 0)
    )
      throw fail(400, 'invalid_query', 'Invalid pagination or event cursor.');
    return value;
  };
  return { limit: integer('limit', 50, 200), offset: integer('offset', 0, Number.MAX_SAFE_INTEGER) };
}
function page(items, { limit, offset }) {
  return {
    items: items.slice(offset, offset + limit),
    nextOffset: offset + limit < items.length ? offset + limit : null,
  };
}
function messageDto(message) {
  return {
    ...pick(message, [
      'id',
      'role',
      'text',
      'thinking',
      'timestamp',
      'usage',
      'model',
      'provider',
      'error',
      'stopReason',
      'customType',
      'contextKind',
      'agentMessage',
    ]),
    tools: (message.tools || []).map((tool) =>
      pick(tool, ['id', 'name', 'args', 'status', 'result', 'isError']),
    ),
    attachments: (message.attachments || []).map((attachment) =>
      pick(attachment, ['type', 'id', 'name', 'size', 'mimeType']),
    ),
  };
}
function eventDto(event, identity) {
  const { cwd, file, ...value } = event;
  if (value.message) value.message = messageDto(value.message);
  return { ...value, ...identity };
}

/** One versioned adapter over existing services; the runtime and roadmap stay shared. */
export function createPublicApi({
  access,
  store,
  dataDir,
  agentHome,
  version,
  models,
  runs,
  startRun,
  stopRun,
  respond,
  subscribe,
  roadmapRoutes,
  liveMessages,
  computer,
  setComputerUse,
  sync,
  readBody,
  getEndpoints,
  onRoadmapRead = () => {},
  now = Date.now,
}) {
  let identity,
    fileService,
    closed = false,
    proofWrites = Promise.resolve();
  const requests = new Map();
  const machineId = () => (identity ||= getStudioMachineId(dataDir));
  const files = () =>
    (fileService ||= machineId().then((id) =>
      createPublicApiFiles({
        machineId: id,
        dataDir,
        protectedRoots: [dataDir, agentHome],
        attachmentDir: join(dataDir, 'attachments'),
      }),
    ));
  const allowed = (principal, project) =>
    principal.projectIds.includes('*') || principal.projectIds.includes(publicProjectId(project.cwd));
  const projectDto = (project, id) => ({
    id: publicProjectId(project.cwd),
    name: project.name,
    syncId: project.syncId || null,
    exists: project.exists === true,
    machineId: id,
  });
  async function projectsFor(principal) {
    const all = (await store.overview()).projects;
    return principal ? all.filter((project) => allowed(principal, project)) : all;
  }
  function runProject(run, projects) {
    if (run.projectCwd) return projects.find((project) => cwdKey(project.cwd) === cwdKey(run.projectCwd));
    return (
      projects.find((project) => cwdKey(project.cwd) === cwdKey(run.projectCwd || run.cwd)) ||
      projects.find((project) => project.sessions.some((session) => session.id === run.sessionId))
    );
  }
  function runDto(run, project, id) {
    return {
      ...pick(run, [
        'id',
        'sessionId',
        'status',
        'startedAt',
        'endedAt',
        'error',
        'model',
        'thinking',
        'allowQuestions',
        'interactions',
      ]),
      sessionId: run.sessionId || null,
      projectId: publicProjectId(project.cwd),
      machineId: id,
      ...(run.apiRequestId ? { requestId: run.apiRequestId } : {}),
    };
  }
  const lastSyncDto = (last) =>
    last && typeof last === 'object'
      ? {
          at: String(last.at || ''),
          ok: last.ok === true,
          sent: Number(last.sent) || 0,
          received: Number(last.received) || 0,
        }
      : null;
  // Bucket errors can carry endpoint URLs or key ids: never forward them.
  const syncFailure = (error) =>
    error?.status === 400
      ? fail(409, 'sync_not_configured', 'Sync is not configured on this Studio.')
      : fail(502, 'sync_failed', 'Sync failed. Check the bucket from Preferences, then retry.');
  async function syncStatus() {
    if (!sync) return { configured: false, running: false, lastSync: null };
    return sync.status();
  }
  function computerTarget(input, projects, { write = false } = {}) {
    const { sessionId, runId } = input;
    if (!sessionId && !runId) return null;
    if (runId) {
      const run = runs.get(runId);
      const project = run && runProject(run, projects);
      if (!run || !project) throw missing();
      if (write && (run.finished || run.status !== 'running'))
        throw fail(409, 'computer_use_conflict', 'The requested run is no longer active.');
      return {
        project,
        run,
        dto: {
          runId,
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          projectId: publicProjectId(project.cwd),
        },
      };
    }
    const project = projects.find((entry) => entry.sessions.some((session) => session.id === sessionId));
    if (!project) throw missing();
    const run = [...runs.values()].find(
      (entry) =>
        entry.sessionId === sessionId && !entry.finished && ['running', 'stopping'].includes(entry.status),
    );
    if (write && run && run.status !== 'running')
      throw fail(409, 'computer_use_conflict', 'The requested run is stopping.');
    if (run && runProject(run, projects) !== project) throw missing();
    return { project, run, dto: { sessionId, projectId: publicProjectId(project.cwd) } };
  }
  function computerDto(selector, projects, id) {
    const target = computerTarget(selector, projects);
    const state = computer.status(selector);
    let owner = null;
    if (state.owner) {
      const run = state.owner.runId ? runs.get(state.owner.runId) : null;
      const project = run
        ? runProject(run, projects)
        : projects.find((entry) => entry.sessions.some((session) => session.id === state.owner.sessionId));
      if (project)
        owner = { ...pick(state.owner, ['sessionId', 'runId']), projectId: publicProjectId(project.cwd) };
    }
    // Only current, non-content-bearing fields cross the public boundary.
    // Action/frame diagnostics can belong to a previous, unauthorized lease.
    return {
      machineId: id,
      revision: computer.revision,
      supported: state.supported === true,
      enabled: state.enabled === true,
      busy: state.busy === true,
      backend: ['native', 'cua'].includes(state.backend) ? state.backend : null,
      backends: (state.backends || [])
        .filter((entry) => ['native', 'cua'].includes(entry.id))
        .map((entry) => ({
          id: entry.id,
          supported: entry.supported === true,
          available: entry.available === true,
        })),
      owner,
      ownerHidden: !!state.owner && !owner,
      cleanupPending: state.cleanupPending === true,
      cleanupFailed: state.cleanupFailed === true,
      hotkey: typeof state.hotkey === 'string' ? state.hotkey : '',
      hotkeyAvailable: !state.hotkeyError,
      target: target?.dto || null,
    };
  }
  function roadmapDto(value, project, id) {
    const { cwd, ...roadmap } = value;
    return { machineId: id, projectId: publicProjectId(project.cwd), roadmap };
  }
  async function sessionFor(id, projects, authorize) {
    if (!validId(id)) throw missing();
    const project = projects.find((entry) => entry.sessions.some((session) => session.id === id));
    if (!project) throw missing();
    await authorize();
    return { project, history: await store.history(id) };
  }
  function once(key, value, action) {
    for (const [id, entry] of requests) if (entry.until <= now()) requests.delete(id);
    const hash = createHash('sha256')
      .update(JSON.stringify(canonical(value)))
      .digest('hex');
    const old = requests.get(key);
    if (old) {
      if (old.hash !== hash)
        throw fail(409, 'request_conflict', 'This requestId was used for different input.');
      return old.result;
    }
    if (requests.size >= 1000) throw fail(429, 'too_many_requests', 'Too many retained requests.');
    // Keep failures too: a lost acceptance reply must not automatically submit work twice.
    const result = Promise.resolve().then(action);
    requests.set(key, { hash, result, until: now() + 3600000 });
    return result;
  }
  async function adminState() {
    const [state, projects, id, endpoints] = await Promise.all([
      access.get(),
      projectsFor(null),
      machineId(),
      getEndpoints(),
    ]);
    return {
      ...state,
      machineId: id,
      projects: projects.map((project) => ({ ...projectDto(project, id), cwd: project.cwd })),
      endpoints,
    };
  }
  async function handleAdmin(req, res, url) {
    try {
      if (closed) throw fail(503, 'unavailable', 'The API is closing.');
      pagination(url, []);
      if (req.headers.authorization)
        throw fail(401, 'api_token_not_accepted', 'Token administration is local only.');
      const revoke = url.pathname.match(/^\/api\/public-api\/tokens\/([^/]+)$/);
      const methods =
        url.pathname === '/api/public-api'
          ? ['GET', 'PATCH']
          : url.pathname === '/api/public-api/tokens'
            ? ['POST']
            : revoke
              ? ['DELETE']
              : [];
      if (!methods.length) throw missing();
      if (!methods.includes(req.method)) {
        res.setHeader('Allow', methods.join(', '));
        throw fail(405, 'method_not_allowed', 'Method not allowed.');
      }
      if (req.method === 'GET') return json(res, 200, await adminState());
      const body = await readBody(req);
      // Resolve presentation data before persisting a one-time credential.
      const context = await adminState();
      if (req.method === 'PATCH') return json(res, 200, { ...context, ...(await access.configure(body)) });
      if (req.method === 'POST') {
        if (
          Array.isArray(body.projectIds) &&
          body.projectIds.some((id) => id !== '*' && !context.projects.some((project) => project.id === id))
        )
          throw fail(400, 'invalid_token_request', 'Select existing projects.');
        const result = await access.createToken(body);
        return json(res, 201, { ...result, state: { ...context, ...result.state } });
      }
      if (Object.keys(body).some((key) => key !== 'revision'))
        throw fail(400, 'invalid_request', 'Unknown token field.');
      const state = await access.revoke({ id: revoke[1], revision: body.revision });
      return json(res, 200, { ...context, ...state });
    } catch (error) {
      publicApiError(res, error);
    }
  }
  async function handle(req, res, url, trusted) {
    try {
      if (closed) throw fail(503, 'unavailable', 'The API is closing.');
      const authenticate = trusted
        ? async () => {
            await trusted.authorize();
            return { projectIds: ['*'], scopes: ['read', 'runs:write'] };
          }
        : () => access.authenticate(req);
      let principal = await authenticate();
      if (!trusted) access.track(principal, res);
      const route = operations.find(
        (candidate) => candidate.method === req.method && candidate.pattern.test(url.pathname),
      );
      if (!route) {
        const methods = operations
          .filter((candidate) => candidate.pattern.test(url.pathname))
          .map((candidate) => candidate.method);
        if (methods.length) {
          res.setHeader('Allow', methods.join(', '));
          throw fail(405, 'method_not_allowed', 'Method not allowed.');
        }
        throw missing();
      }
      if (route.scopes.some((scope) => !principal.scopes.includes(scope)))
        throw fail(403, 'insufficient_scope', 'This token does not grant the required permission.');
      const matched = url.pathname.match(route.pattern);
      const params = Object.fromEntries(route.names.map((name, i) => [name, matched[i + 1]]));
      const listing = ['projects', 'models', 'sessions', 'messages', 'runs', 'files'].includes(
        route.operationId,
      );
      const paging = pagination(
        url,
        listing
          ? ['limit', 'offset']
          : route.operationId === 'events'
            ? ['after']
            : route.operationId === 'computerUse'
              ? ['sessionId', 'runId']
              : [],
      );
      if (route.operationId === 'events') {
        const after = req.headers['last-event-id'] ?? url.searchParams.get('after');
        if (after != null && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))))
          throw fail(400, 'invalid_query', 'Invalid event cursor.');
      }
      const computerSelector = {};
      if (route.operationId === 'computerUse') {
        for (const key of ['sessionId', 'runId']) {
          if (!url.searchParams.has(key)) continue;
          const value = url.searchParams.get(key);
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value))
            throw fail(400, 'invalid_query', 'Invalid Computer Use target.');
          computerSelector[key] = value;
        }
        if (computerSelector.sessionId && computerSelector.runId)
          throw fail(400, 'invalid_query', 'Choose sessionId or runId, not both.');
      }
      const body = route.method === 'POST' ? (trusted ? trusted.body : await readBody(req)) : null;
      if (body !== null) {
        const checked = validatePublicApiBody(route.operationId, body);
        if (!checked.ok) throw fail(checked.status, checked.code, checked.error);
      }
      const id = await machineId();
      if (route.operationId === 'machine')
        return json(res, 200, {
          apiVersion: 'v1',
          studioVersion: version,
          machineId: id,
          name: hostname(),
          capabilities: ['projects', 'conversations', 'runs', 'roadmaps', 'files', 'computer-use', 'sync'],
          idempotency: { retentionSeconds: 3600, persistent: false },
        });
      if (route.operationId === 'models') {
        const catalog = await models();
        await authenticate();
        return json(
          res,
          200,
          page(
            (catalog.models || []).map((model) =>
              pick(model, [
                'id',
                'name',
                'provider',
                'input',
                'reasoning',
                'thinkingLevels',
                'contextWindow',
                'availability',
              ]),
            ),
            paging,
          ),
        );
      }
      const authorize = async () => {
        principal = await authenticate();
        if (res.destroyed || res.writableEnded)
          throw fail(401, 'api_unauthorized', 'The request is no longer authorized.');
        if (
          computer &&
          !principal.scopes.includes('computer:write') &&
          ['createRun', 'roadmapWork', 'sendMessage', 'interaction'].includes(route.operationId)
        ) {
          const sessionId = params.sessionId || body?.sessionId;
          const target = params.runId ? { runId: params.runId } : sessionId ? { sessionId } : null;
          if (target && computer.status(target).enabled)
            throw fail(
              403,
              'insufficient_scope',
              'This conversation uses Computer Use; computer:write is required.',
            );
        }
      };
      const projects = await projectsFor(principal);
      const project = params.projectId
        ? projects.find((entry) => publicProjectId(entry.cwd) === params.projectId)
        : null;
      if (params.projectId && !project) throw missing();
      const session = params.sessionId ? await sessionFor(params.sessionId, projects, authorize) : null;
      const run = params.runId ? runs.get(params.runId) : null;
      const owner = run ? runProject(run, projects) : null;
      if (params.runId && (!run || !owner)) throw missing();
      await authorize();
      switch (route.operationId) {
        case 'computerUse': {
          computerTarget(computerSelector, projects);
          await computer.refreshBackends?.().catch(() => {});
          await authorize();
          const visible = await projectsFor(principal);
          await authorize();
          return json(res, 200, computerDto(computerSelector, visible, id));
        }
        case 'setComputerUse': {
          const selector = pick(body, ['sessionId', 'runId']);
          const original = computerTarget(selector, projects, { write: true });
          const targetKey = (target) =>
            JSON.stringify([
              publicProjectId(target.project.cwd),
              target.run?.id || null,
              target.run?.sessionId || null,
            ]);
          const originalKey = targetKey(original);
          const authorizeTarget = async () => {
            await authorize();
            const visible = await projectsFor(principal);
            await authorize();
            const current = computerTarget(selector, visible, { write: true });
            if (originalKey !== targetKey(current))
              throw fail(409, 'computer_use_conflict', 'The target changed. Read its state before retrying.');
          };
          if (body.expectedRevision !== computer.revision)
            throw Object.assign(
              fail(409, 'computer_use_conflict', 'Computer Use changed. Read its state before retrying.'),
              { currentRevision: computer.revision },
            );
          try {
            await setComputerUse(
              { ...selector, enabled: body.enabled },
              {
                authorize: authorizeTarget,
                expectedRevision: body.expectedRevision,
                allowTakeover: false,
              },
            );
          } catch (error) {
            // The internal driver can include paths in failures. Do not forward those diagnostics.
            if (['api_unauthorized', 'api_disabled', 'insufficient_scope', 'not_found'].includes(error?.code))
              throw error;
            if (error?.status === 404) throw missing();
            const status = error?.status === 400 ? 400 : error?.status === 409 ? 409 : 503;
            throw Object.assign(
              fail(
                status,
                status === 409 ? 'computer_use_conflict' : 'computer_use_unavailable',
                status === 409
                  ? 'Computer Use could not be changed. Read its state and check the target, model and backend.'
                  : 'Computer Use is unavailable.',
              ),
              status === 409 ? { currentRevision: computer.revision } : {},
            );
          }
          await authorize();
          const visible = await projectsFor(principal);
          await authorize();
          return json(res, 200, computerDto(selector, visible, id));
        }
        case 'syncState': {
          const state = await syncStatus();
          return json(res, 200, {
            machineId: id,
            configured: state.configured === true,
            running: state.running === true,
            lastSync: lastSyncDto(state.lastSync),
          });
        }
        case 'syncProject': {
          if (!(await syncStatus()).configured)
            throw fail(409, 'sync_not_configured', 'Sync is not configured on this Studio.');
          if (project.sync === false) throw fail(409, 'sync_disabled', 'Sync is disabled for this project.');
          const sameProject = (entry) => cwdKey(entry.cwd) === cwdKey(project.cwd);
          const sessionId = body?.sessionId;
          if (sessionId) {
            // A conversation already known locally must belong to this project.
            // An unknown one is received first, then checked (404 if elsewhere).
            const before = (await store.overview()).projects;
            const owner = before.find((entry) => entry.sessions.some((s) => s.id === sessionId));
            if (owner && !sameProject(owner)) throw missing();
            let result;
            try {
              result = await sync.checkSession(sessionId);
            } catch (error) {
              throw syncFailure(error);
            }
            await authorize();
            const after = (await store.overview()).projects.find(sameProject);
            if (!after?.sessions.some((s) => s.id === sessionId)) throw missing();
            return json(res, 200, {
              machineId: id,
              projectId: params.projectId,
              scope: 'session',
              sessionId,
              state: result.state,
              changed: result.changed === true,
            });
          }
          const synced = (await store.overview()).projects.filter((entry) => entry.sync !== false);
          if (!synced.every((entry) => allowed(principal, entry)))
            throw fail(
              403,
              'insufficient_scope',
              'A full sync covers every synced project; this token is not authorized on all of them.',
            );
          try {
            await sync.run();
          } catch (error) {
            throw syncFailure(error);
          }
          await authorize();
          return json(res, 200, {
            machineId: id,
            projectId: params.projectId,
            scope: 'all',
            lastSync: lastSyncDto((await syncStatus()).lastSync),
          });
        }
        case 'projects':
          return json(
            res,
            200,
            page(
              projects.map((entry) => projectDto(entry, id)),
              paging,
            ),
          );
        case 'sessions':
          return json(
            res,
            200,
            page(
              project.sessions.map((entry) => ({
                ...pick(entry, ['id', 'title', 'createdAt', 'updatedAt', 'model', 'thinking']),
                machineId: id,
                projectId: params.projectId,
              })),
              paging,
            ),
          );
        case 'messages':
          return json(res, 200, {
            sessionId: params.sessionId,
            projectId: publicProjectId(session.project.cwd),
            machineId: id,
            ...page(session.history.messages.map(messageDto), paging),
          });
        case 'runs':
          return json(
            res,
            200,
            page(
              [...runs.values()].flatMap((entry) => {
                const owner = runProject(entry, projects);
                return owner ? [runDto(entry, owner, id)] : [];
              }),
              paging,
            ),
          );
        case 'run':
          return json(res, 200, runDto(run, owner, id));
        case 'events':
          return subscribe(req, res, run, url, (event) =>
            eventDto(event, { machineId: id, projectId: publicProjectId(owner.cwd), runId: run.id }),
          );
        case 'stop':
          trusted?.beforeStop?.(run);
          await stopRun(run);
          return json(res, 200, { stopped: true, ...runDto(run, owner, id) });
        case 'interaction':
          return json(res, 200, await respond(run, body));
        case 'createRun': {
          const resumed = body.sessionId ? await sessionFor(body.sessionId, [project], authorize) : null;
          const result = await once(`run:${params.projectId}:${body.requestId}`, body, async () => {
            await authorize();
            const { requestId, ...input } = body;
            const started = await startRun(
              { ...input, cwd: resumed?.history.cwd || project.cwd, computerUse: false },
              { authorize, apiRequestId: requestId },
            );
            return { ...runDto(started, project, id), requestId };
          });
          return json(res, 201, result);
        }
        case 'sendMessage':
          return json(
            res,
            200,
            await liveMessages.send(params.sessionId, { ...body, cwd: session.history.cwd }, { authorize }),
          );
        case 'roadmap':
          onRoadmapRead(project.cwd);
          return json(res, 200, roadmapDto(await roadmapRoutes.read(project.cwd), project, id));
        case 'mutateRoadmap': {
          // step.check accepts an optional associated conversation as context.
          // Other actions keep their existing sessionId meaning
          // (plan.attach, plan.create sessions). Membership in the chosen
          // authorized project is checked here; the domain routes recheck and
          // natively use the verified actual caller. completion/machineId/
          // completedAt are never accepted (contract rejects).
          if (body.action === 'step.check' && body.sessionId !== undefined)
            await sessionFor(body.sessionId, [project], authorize);
          return json(
            res,
            200,
            roadmapDto(await roadmapRoutes.mutate({ ...body, cwd: project.cwd }, { authorize }), project, id),
          );
        }
        case 'roadmapWork': {
          if (body.sessionId) await sessionFor(body.sessionId, [project], authorize);
          const result = await once(`roadmap:${params.projectId}:${body.requestId}`, body, () =>
            roadmapRoutes.work({ ...body, cwd: project.cwd }, { authorize, apiRequestId: body.requestId }),
          );
          return json(res, 201, {
            ...pick(result, ['accepted', 'queued', 'requestId', 'sessionId', 'linkWarning']),
            run: runDto(result.run, project, id),
            ...(result.roadmap ? { roadmap: roadmapDto(result.roadmap, project, id).roadmap } : {}),
            machineId: id,
            projectId: params.projectId,
          });
        }
        case 'files':
        case 'download':
        case 'fileHead': {
          await proofWrites;
          const service = await files();
          const context = {
            sessionId: params.sessionId,
            cwd: session.history.cwd,
            messages: session.history.messages,
          };
          await authorize();
          if (route.operationId === 'files') return json(res, 200, page(await service.list(context), paging));
          return await service.download(req, res, { ...context, fileId: params.fileId });
        }
      }
      throw missing();
    } catch (error) {
      publicApiError(res, error);
    }
  }
  // In-process owner capability only. Never routed from HTTP or given a token.
  // The turn bridge supplies authorize; arbitrary operations remain unavailable.
  async function conversationCall(method, path, body, authorize, beforeStop) {
    if (!(
      (method === 'GET' &&
        /^\/api\/v1\/(projects(?:\/[^/]+\/sessions)?|sessions\/[^/]+\/messages|runs(?:\/[^/]+)?)($|\?)/.test(
          path,
        )) ||
      (method === 'POST' &&
        /^\/api\/v1\/(projects\/[^/]+\/runs|sessions\/[^/]+\/messages|runs\/[^/]+\/stop)$/.test(path))
    ))
      throw missing();
    const req = new EventEmitter();
    req.method = method;
    req.headers = {};
    const res = new EventEmitter();
    res.destroyed = false;
    res.writableEnded = false;
    res.setHeader = () => {};
    let status, result;
    res.writeHead = (value) => {
      status = value;
    };
    res.end = (value) => {
      result = JSON.parse(value);
      res.writableEnded = true;
    };
    await handle(req, res, new URL(path, 'http://studio.invalid'), { body, authorize, beforeStop });
    if (status >= 400) throw fail(status, result.code, result.error);
    return result;
  }
  function noteEvent(run, event) {
    if (closed) return;
    const messages =
      event.kind === 'message'
        ? [event.message]
        : event.kind === 'session'
          ? run.events.filter((entry) => entry.item.kind === 'message').map((entry) => entry.item.message)
          : [];
    if (!validId(run.sessionId) || !messages.length) return;
    proofWrites = proofWrites
      .then(async () => (await files()).recordLocal({ sessionId: run.sessionId, cwd: run.cwd, messages }))
      .catch(() => {});
  }
  return {
    handle,
    handleAdmin,
    conversationCall,
    machineId,
    adminState,
    noteEvent,
    async close() {
      closed = true;
      access.close();
      requests.clear();
      await proofWrites;
      if (fileService) await (await fileService).close?.();
    },
  };
}
