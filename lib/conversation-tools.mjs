import { publicProjectId } from './public-api.mjs';
import { cwdKey } from './store.mjs';

const fail = (message, code = 'conversation_invalid') =>
  Object.assign(new Error(message), {
    code,
    status:
      code === 'delivery_uncertain'
        ? 503
        : code === 'not_found'
          ? 404
          : code === 'conversation_conflict'
            ? 409
            : 400,
  });
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
const fields = {
  projects: ['limit', 'offset'],
  list: ['projectId', 'limit', 'offset'],
  inspect: ['sessionId'],
  history: ['sessionId', 'limit', 'offset'],
  create: ['projectId', 'requestId', 'message', 'model', 'thinking', 'name'],
  continue: ['sessionId', 'requestId', 'message', 'model', 'thinking'],
  send: ['sessionId', 'requestId', 'message', 'mode'],
  interrupt: ['sessionId', 'expectedRunId'],
};

/** Owner-wide registered-project adapter. No model-supplied cwd, credentials or API paths. */
export function createConversationTools({ api, store, runs, now = Date.now }) {
  return async (action, params, { authorize }) => {
    const allowed = fields[action];
    if (!allowed || Object.keys(params).some((key) => !allowed.includes(key)))
      throw fail('Unknown conversation operation or field.');
    for (const key of ['sessionId', 'projectId', 'expectedRunId'])
      if (allowed.includes(key) && (params[key] !== undefined || key !== 'projectId') && !id(params[key]))
        throw fail(`Invalid ${key}.`);
    const limit = params.limit ?? 20,
      offset = params.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0)
      throw fail('Pagination requires limit 1..50 and nonnegative offset.');
    await authorize();
    const overview = await store.overview();
    await authorize();
    const projects = overview.projects;
    const project = params.projectId
      ? projects.find((p) => publicProjectId(p.cwd) === params.projectId)
      : null;
    if (params.projectId && !project) throw fail('Registered project not found.', 'not_found');
    const owners = params.sessionId
      ? projects.filter((p) => p.sessions.some((s) => s.id === params.sessionId))
      : [];
    if (params.sessionId && owners.length !== 1)
      throw fail('Exact registered conversation not found.', 'not_found');
    const owner = owners[0];
    const call = async (method, path, body) => {
      try {
        return await api.conversationCall(
          method,
          path,
          body,
          async () => {
            await authorize();
            const current = (await store.overview()).projects;
            const expected = owner || project;
            if (
              expected &&
              !current.some(
                (p) =>
                  cwdKey(p.cwd) === cwdKey(expected.cwd) &&
                  (!params.sessionId || p.sessions.some((s) => s.id === params.sessionId)),
              )
            )
              throw fail('Conversation or project registration changed.', 'conversation_conflict');
            await authorize();
            if (action === 'interrupt') {
              const active = [...runs.values()].filter(
                (r) =>
                  r.sessionId === params.sessionId &&
                  !r.finished &&
                  ['running', 'stopping'].includes(r.status),
              );
              if (
                active.length !== 1 ||
                active[0].id !== params.expectedRunId ||
                active[0].status !== 'running'
              )
                throw fail('Current run changed; inspect before interrupting.', 'conversation_conflict');
            }
          },
          action === 'interrupt'
            ? (run) => {
                const active = [...runs.values()].filter(
                  (r) =>
                    r.sessionId === params.sessionId &&
                    !r.finished &&
                    ['running', 'stopping'].includes(r.status),
                );
                if (
                  active.length !== 1 ||
                  active[0] !== run ||
                  run.id !== params.expectedRunId ||
                  run.status !== 'running'
                )
                  throw fail('Current run changed.', 'conversation_conflict');
              }
            : undefined,
        );
      } catch (error) {
        if (method === 'POST' && (error.status >= 500 || error.code === 'delivery_uncertain'))
          throw fail(
            'Delivery UNKNOWN; reconcile requestId and target, do not retry automatically.',
            'delivery_uncertain',
          );
        throw error;
      }
    };
    const page = `?limit=${limit}&offset=${offset}`;
    if (action === 'projects') return call('GET', '/api/v1/projects' + page);
    if (action === 'list') {
      if (!project) throw fail('projectId is required.');
      return call('GET', `/api/v1/projects/${params.projectId}/sessions` + page);
    }
    const matching = () =>
      [...runs.values()].filter(
        (r) => r.sessionId === params.sessionId && !r.finished && ['running', 'stopping'].includes(r.status),
      );
    if (action === 'inspect') {
      const active = matching();
      if (active.length > 1) throw fail('Ambiguous active run.', 'conversation_conflict');
      const run = active[0];
      const session = owner.sessions.find((s) => s.id === params.sessionId);
      await authorize();
      return {
        sessionId: session.id,
        projectId: publicProjectId(owner.cwd),
        machineId: await api.machineId(),
        title: session.title,
        model: session.model,
        thinking: session.thinking,
        status: run?.status || 'saved',
        runId: run?.id || null,
        observedAt: new Date(now()).toISOString(),
        freshness: 'snapshot',
        activity: run
          ? 'Studio run active; inspect results separately'
          : 'No active Studio run observed; native activity unknown',
      };
    }
    if (action === 'history') {
      const result = await call('GET', `/api/v1/sessions/${params.sessionId}/messages` + page);
      let remaining = 16000;
      return {
        ...result,
        items: result.items.map((m) => {
          const cap = Math.min(1500, remaining);
          remaining -= Math.min(cap, typeof m.text === 'string' ? m.text.length : 0);
          return {
            id: m.id,
            role: m.role,
            timestamp: m.timestamp,
            text: typeof m.text === 'string' ? m.text.slice(0, cap) : '',
            truncated: typeof m.text === 'string' && m.text.length > cap,
            tools: (m.tools || []).slice(0, 3).map((t) => ({
              id: String(t.id || '').slice(0, 100),
              name: String(t.name || '').slice(0, 100),
              status: t.status,
            })),
          };
        }),
        contentLimit: 1500,
        pageContentLimit: 16000,
      };
    }
    if (action === 'interrupt') {
      const active = matching();
      if (active.length !== 1 || active[0].id !== params.expectedRunId || active[0].status !== 'running')
        throw fail('Current run changed; inspect before interrupting.', 'conversation_conflict');
      const run = active[0];
      // Recheck after every asynchronous authorization, immediately before stop.
      await call('GET', `/api/v1/runs/${run.id}`);
      if (matching().length !== 1 || matching()[0] !== run || run.status !== 'running')
        throw fail('Current run changed.', 'conversation_conflict');
      return call('POST', `/api/v1/runs/${run.id}/stop`, {});
    }
    if (action === 'send') {
      const result = await call('POST', `/api/v1/sessions/${params.sessionId}/messages`, {
        requestId: params.requestId,
        message: params.message,
        mode: params.mode ?? 'follow_up',
      });
      return { ...result, sessionId: params.sessionId, delivery: 'accepted', completion: 'not_observed' };
    }
    if (action === 'create' || action === 'continue') {
      if (action === 'create' && !project) throw fail('projectId is required.');
      if (
        params.name !== undefined &&
        (typeof params.name !== 'string' || !params.name.trim() || params.name.length > 200)
      )
        throw fail('Invalid conversation name.');
      const { projectId, name, ...body } = params;
      const result = await call(
        'POST',
        `/api/v1/projects/${publicProjectId((owner || project).cwd)}/runs`,
        body,
      );
      let nameWarning;
      if (name && result.sessionId) {
        try {
          await authorize();
          await store.patchSession({ id: result.sessionId, title: name });
        } catch {
          nameWarning = 'Run accepted, but the requested display name could not be saved.';
        }
      }
      return {
        ...result,
        delivery: 'accepted',
        completion: 'not_observed',
        independent: action === 'create',
        ...(nameWarning ? { nameWarning } : {}),
      };
    }
    throw fail('Unsupported operation.');
  };
}
