import { createHash } from 'node:crypto';
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
  function roadmapDto(value, project, id) {
    const { cwd, ...roadmap } = value;
    return { machineId: id, projectId: publicProjectId(project.cwd), roadmap };
  }
  async function sessionFor(id, projects) {
    if (!validId(id)) throw missing();
    const project = projects.find((entry) => entry.sessions.some((session) => session.id === id));
    if (!project) throw missing();
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
  async function handle(req, res, url) {
    try {
      if (closed) throw fail(503, 'unavailable', 'The API is closing.');
      let principal = await access.authenticate(req);
      access.track(principal, res);
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
        listing ? ['limit', 'offset'] : route.operationId === 'events' ? ['after'] : [],
      );
      if (route.operationId === 'events') {
        const after = req.headers['last-event-id'] ?? url.searchParams.get('after');
        if (after != null && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))))
          throw fail(400, 'invalid_query', 'Invalid event cursor.');
      }
      const body = route.method === 'POST' ? await readBody(req) : null;
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
          capabilities: ['projects', 'conversations', 'runs', 'roadmaps', 'files'],
          idempotency: { retentionSeconds: 3600, persistent: false },
        });
      if (route.operationId === 'models') {
        const catalog = await models();
        await access.authenticate(req);
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
      const projects = await projectsFor(principal);
      const project = params.projectId
        ? projects.find((entry) => publicProjectId(entry.cwd) === params.projectId)
        : null;
      if (params.projectId && !project) throw missing();
      const session = params.sessionId ? await sessionFor(params.sessionId, projects) : null;
      const run = params.runId ? runs.get(params.runId) : null;
      const owner = run ? runProject(run, projects) : null;
      if (params.runId && (!run || !owner)) throw missing();
      const authorize = async () => {
        principal = await access.authenticate(req);
        if (res.destroyed || res.writableEnded)
          throw fail(401, 'api_unauthorized', 'The request is no longer authorized.');
      };
      await authorize();
      switch (route.operationId) {
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
          await stopRun(run);
          return json(res, 200, { stopped: true, ...runDto(run, owner, id) });
        case 'interaction':
          return json(res, 200, await respond(run, body));
        case 'createRun': {
          const resumed = body.sessionId ? await sessionFor(body.sessionId, [project]) : null;
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
        case 'mutateRoadmap':
          return json(
            res,
            200,
            roadmapDto(await roadmapRoutes.mutate({ ...body, cwd: project.cwd }, { authorize }), project, id),
          );
        case 'roadmapWork': {
          if (body.sessionId) await sessionFor(body.sessionId, [project]);
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
