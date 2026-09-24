import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { open, realpath, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cwdKey, validId } from './store.mjs';

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const fail = (status, message, code = 'roadmap_agent_denied') =>
  Object.assign(new Error(message), { status, code });
const denied = () => fail(403, 'This agent no longer owns an active Studio session.');
const bodyLimit = 128 * 1024;

// Read the native identity, never the transcript. A partially written header is
// unavailable; reads must not repair or initialize native session files.
export async function readRoadmapSessionHeader(file, roots) {
  if (typeof file !== 'string' || !isAbsolute(file) || file.length > 32768) throw denied();
  const actual = await realpath(file).catch(() => null);
  if (
    !actual ||
    cwdKey(actual) !== cwdKey(file) ||
    !roots.some((root) => cwdKey(actual).startsWith(cwdKey(root) + sep))
  )
    throw denied();
  const handle = await open(actual, 'r');
  try {
    const bytes = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const end = bytes.subarray(0, bytesRead).indexOf(10);
    if (end < 0) throw denied();
    const header = JSON.parse(bytes.subarray(0, end).toString('utf8'));
    if (header.type !== 'session' || !validId(header.id) || !isAbsolute(header.cwd || '')) throw denied();
    return { ...header, file: actual };
  } finally {
    await handle.close();
  }
}

/** Verify an extension's native context against an active GUI run and its native ledger. */
export function createRoadmapCallerResolver({ getRuns, store, agentHome, sessionDir, readEdges }) {
  let ledger;
  const nativeEdges =
    readEdges ||
    (async () => {
      if (!ledger) {
        const { discoverCli } = await import('./agent.mjs');
        const cli = discoverCli();
        if (!cli?.packageDir) throw denied();
        const { RlmSpawnLedger } = await import(
          pathToFileURL(join(cli.packageDir, 'dist/modes/daemon/rlm-ledger.js')).href
        );
        ledger = new RlmSpawnLedger(agentHome, sessionDir);
      }
      return ledger.liveEdges();
    });
  return async (identity) => {
    if (!record(identity) || !validId(identity.sessionId) || !isAbsolute(identity.cwd || '')) throw denied();
    const project = await (store.knowledgeProject || store.findProject).call(store, identity.cwd);
    const roots = [sessionDir, join(agentHome, 'session-artifacts')];
    const own = await readRoadmapSessionHeader(identity.sessionFile, roots);
    if (
      own.id !== identity.sessionId ||
      cwdKey(own.cwd) !== cwdKey(identity.cwd) ||
      cwdKey(project.cwd) !== cwdKey(own.cwd)
    )
      throw denied();
    const matching = () =>
      getRuns().filter((run) => run.status === 'running' && cwdKey(run.cwd) === cwdKey(own.cwd));
    const direct = matching().find((run) => run.sessionId === own.id);
    if (direct)
      return {
        cwd: project.cwd,
        sessionId: own.id,
        rootSessionId: own.id,
        ownerId: direct.id,
        name: 'Prime Agent',
      };
    const edges = await nativeEdges();
    const byChild = new Map();
    for (const edge of edges) {
      if (
        !edge.deleted &&
        validId(edge.childId) &&
        isAbsolute(edge.child || '') &&
        isAbsolute(edge.parent || '')
      ) {
        const key = cwdKey(edge.child);
        if (byChild.has(key)) throw denied();
        byChild.set(key, edge);
      }
    }
    let current = own,
      ownEdge,
      parentSessionId;
    const visited = new Set();
    for (let depth = 0; depth < 32; depth++) {
      const key = cwdKey(current.file);
      if (visited.has(key)) throw denied();
      visited.add(key);
      const edge = byChild.get(key);
      if (!edge) throw denied();
      ownEdge ||= edge;
      current = await readRoadmapSessionHeader(edge.parent, roots);
      if (cwdKey(current.cwd) !== cwdKey(own.cwd)) throw denied();
      parentSessionId ||= current.id;
      const run = matching().find((candidate) => candidate.sessionId === current.id);
      if (run)
        return {
          cwd: project.cwd,
          sessionId: own.id,
          rootSessionId: current.id,
          parentSessionId,
          agentId: ownEdge.childId,
          ownerId: run.id,
          name: String(ownEdge.name || 'Sous-agent').slice(0, 200),
        };
    }
    throw denied();
  };
}

function safeResponse(result, limit = 120 * 1024) {
  if (Buffer.byteLength(JSON.stringify(result)) <= limit) return result;
  throw fail(
    413,
    'Roadmap response is too large. Read a specific plan or the backlog.',
    'roadmap_response_too_large',
  );
}

function readProjection(dto, params) {
  const document = dto.document || dto;
  const offset = params.offset ?? 0,
    limit = params.limit ?? 30;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw fail(
      400,
      'Invalid Roadmap page. Use an offset >= 0 and limit between 1 and 50.',
      'roadmap_invalid',
    );
  let textTruncated = false;
  const excerpt = (value, maximum) => {
    if (typeof value !== 'string') return value;
    if (value.length > maximum) textTruncated = true;
    return value.slice(0, maximum);
  };
  const items = (entries) =>
    (entries || [])
      .slice(offset, offset + limit)
      .map((entry) => ({ ...entry, text: excerpt(entry.text, 1500), note: excerpt(entry.note, 1000) }));
  if (params.target === 'plan') {
    const plan = document.plans?.find((item) => item.id === params.planId);
    if (!plan || plan.archived)
      throw fail(404, 'Unknown plan ID. Read the overview for current references.', 'roadmap_not_found');
    // Small plans retain their natural hierarchy. Large plans expose a bounded
    // flat page with stable IDs and parent references rather than becoming
    // unreadable once they cross the IPC response limit.
    if (!offset && Buffer.byteLength(JSON.stringify(plan)) < 110 * 1024)
      return { revision: dto.revision, plan };
    const flat = [];
    const flatten = (steps, parentId = null) => {
      for (const { children, ...step } of steps || []) {
        flat.push({ ...step, parentId, childCount: children?.length || 0 });
        flatten(children, step.id);
      }
    };
    flatten(plan.steps);
    const { steps: _steps, journal, summary, sessions, ...metadata } = plan;
    const page = items(flat);
    const result = {
      revision: dto.revision,
      plan: {
        ...metadata,
        sessions: (sessions || []).slice(0, 20),
        sessionCount: sessions?.length || 0,
        summary: excerpt(summary, 2000),
        journal: (journal || []).slice(-5).map((entry) => ({ ...entry, text: excerpt(entry.text, 1000) })),
      },
      flatSteps: page,
      totalSteps: flat.length,
      offset,
      nextOffset: offset + limit < flat.length ? offset + limit : null,
      textTruncated,
    };
    return result;
  }
  if (params.target === 'backlog') {
    const backlog = document.backlog || { items: [], notes: [] };
    const selected = {
      items: items(backlog.items),
      notes: items(backlog.notes),
      nextNumber: backlog.nextNumber,
    };
    const total = Math.max(backlog.items?.length || 0, backlog.notes?.length || 0);
    return {
      revision: dto.revision,
      backlog: selected,
      totalItems: backlog.items?.length || 0,
      totalNotes: backlog.notes?.length || 0,
      offset,
      nextOffset: offset + limit < total ? offset + limit : null,
      textTruncated,
    };
  }
  if (params.target && params.target !== 'overview')
    throw fail(400, 'Unknown roadmap read target.', 'roadmap_invalid');
  const milestones = document.overview?.milestones ?? document.milestones ?? [];
  const plans = (document.plans || []).filter((item) => !item.archived);
  const projection = {
    revision: dto.revision,
    initialized: dto.initialized,
    vision: excerpt(document.overview?.vision ?? document.vision, 3000),
    progress: dto.progress,
    milestones: milestones
      .slice(offset, offset + limit)
      .map((item) => ({ ...item, summary: excerpt(item.summary, 500) })),
    plans: plans
      .slice(offset, offset + limit)
      .map(({ id, title, summary, status, milestone, sessions, progress }) => ({
        id,
        title,
        summary: excerpt(summary, 500),
        status,
        milestone,
        sessions: (sessions || []).slice(0, 10),
        sessionCount: sessions?.length || 0,
        progress,
      })),
    backlog: {
      itemCount: document.backlog?.items?.length || 0,
      noteCount: document.backlog?.notes?.length || 0,
    },
    planCount: plans.length,
    milestoneCount: milestones.length,
    offset,
    nextOffset: offset + limit < Math.max(plans.length, milestones.length) ? offset + limit : null,
  };
  return {
    ...projection,
    textTruncated,
  };
}

function boundedProjection(dto, params) {
  let limit = params.limit ?? 30;
  for (;;) {
    const result = readProjection(dto, { ...params, limit });
    if (Buffer.byteLength(JSON.stringify(result)) <= 110 * 1024 || limit <= 1) return safeResponse(result);
    limit = Math.max(1, Math.floor(limit / 2));
  }
}

function validateTargets(dto, targets) {
  if (!Array.isArray(targets) || targets.length > 20)
    throw fail(400, 'Provide up to 20 Roadmap work targets.', 'roadmap_invalid');
  const document = dto.document || dto;
  const seen = new Set();
  const hasStep = (steps, id) => (steps || []).some((step) => step.id === id || hasStep(step.children, id));
  return targets.map((target) => {
    if (!record(target)) throw fail(400, 'Invalid Roadmap work target.', 'roadmap_invalid');
    let normalized;
    if (target.kind === 'plan') {
      const plan = document.plans?.find((item) => item.id === target.planId);
      if (!plan || plan.archived || (target.stepId && !hasStep(plan.steps, target.stepId)))
        throw fail(404, 'Unknown plan or step ID.', 'roadmap_not_found');
      normalized = {
        kind: 'plan',
        planId: target.planId,
        ...(target.stepId ? { stepId: target.stepId } : {}),
      };
    } else if (target.kind === 'milestone') {
      if (
        !(document.overview?.milestones ?? document.milestones)?.some(
          (item) => item.id === target.milestoneId,
        )
      )
        throw fail(404, 'Unknown milestone ID.', 'roadmap_not_found');
      normalized = { kind: 'milestone', milestoneId: target.milestoneId };
    } else if (target.kind === 'backlog') {
      const items = Array.isArray(document.backlog)
        ? document.backlog
        : [...(document.backlog?.items || []), ...(document.backlog?.notes || [])];
      if (!items?.some((item) => item.number === target.number))
        throw fail(404, 'Unknown backlog number.', 'roadmap_not_found');
      normalized = { kind: 'backlog', number: target.number };
    } else throw fail(400, 'Unknown Roadmap target kind.', 'roadmap_invalid');
    const key = JSON.stringify(normalized);
    if (seen.has(key)) throw fail(400, 'Duplicate Roadmap target.', 'roadmap_invalid');
    seen.add(key);
    return normalized;
  });
}

/** One in-memory capability and one writer service for every native worker. */
export function createRoadmapBridge({
  service,
  resolveCaller,
  isOwnerActive = () => true,
  ttl = 30000,
  now = Date.now,
}) {
  const instanceId = randomUUID();
  const token = randomBytes(32).toString('hex');
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\prime-studio-roadmap-${instanceId}`
      : join(tmpdir(), `prime-roadmap-${instanceId}.sock`);
  const activity = new Map(),
    closedEpochs = new Map(),
    revokedOwners = new Set();
  let activityRevision = 0,
    closed = false;
  function remove(key) {
    if (activity.delete(key)) activityRevision++;
  }
  function sweep() {
    for (const [key, value] of activity)
      if (value.expiresAt <= now() || revokedOwners.has(value.ownerId) || !isOwnerActive(value.ownerId))
        remove(key);
    for (const [key, expiresAt] of closedEpochs) if (expiresAt <= now()) closedEpochs.delete(key);
  }
  function rememberClosed(key, epoch) {
    // A delayed IPC request is bounded to ten seconds. Keep a much longer
    // tombstone so finishing/aborting a turn cannot resurrect its work badge.
    closedEpochs.set(`${key}\0${epoch}`, now() + 24 * 60 * 60 * 1000);
  }
  const allowedActions = new Set([
    'init',
    'plan.create',
    'plan.patch',
    'plan.attach',
    'plan.steps',
    'plan.delete',
    'step.add',
    'step.edit',
    'step.remove',
    'step.move',
    'step.check',
    'journal.add',
    'backlog.add',
    'backlog.set',
    'backlog.edit',
    'backlog.remove',
    'backlog.move',
    'backlog.convert',
    'milestone.create',
    'milestone.patch',
    'milestone.delete',
    'milestone.move',
    'vision',
  ]);
  async function dispatch(input) {
    if (closed) throw denied();
    if (!record(input) || !record(input.identity) || !record(input.params || {}))
      throw fail(400, 'Invalid Roadmap request.', 'roadmap_invalid');
    const caller = await resolveCaller(input.identity);
    if (
      !caller?.ownerId ||
      !validId(caller.sessionId) ||
      !validId(caller.rootSessionId) ||
      cwdKey(caller.cwd) !== cwdKey(input.identity.cwd) ||
      caller.sessionId !== input.identity.sessionId
    )
      throw denied();
    const stillActive = () => !closed && !revokedOwners.has(caller.ownerId) && isOwnerActive(caller.ownerId);
    if (!stillActive()) throw denied();
    const params = input.params || {};
    const key = `${caller.ownerId}\0${caller.sessionId}`;
    const conversation = {
      sessionId: caller.sessionId,
      rootSessionId: caller.rootSessionId,
      ...(caller.agentId ? { agentId: caller.agentId } : {}),
    };
    if (input.action === 'read')
      return safeResponse({ ...boundedProjection(await service.read(caller.cwd), params), conversation });
    if (input.action === 'mutate') {
      if (!allowedActions.has(params.action)) throw fail(400, 'Unknown Roadmap mutation.', 'roadmap_invalid');
      if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0)
        throw fail(400, 'Read the current revision before editing Roadmap.', 'roadmap_invalid');
      const allowedSessions = new Set([caller.sessionId, caller.rootSessionId]);
      if (
        (params.action === 'plan.attach' && !allowedSessions.has(params.sessionId)) ||
        (params.action === 'plan.create' &&
          params.sessions !== undefined &&
          (!Array.isArray(params.sessions) || params.sessions.some((id) => !allowedSessions.has(id))))
      )
        throw fail(
          403,
          'An agent may attach only its current native conversation or its root conversation.',
          'roadmap_agent_denied',
        );
      const actor = {
        by: 'agent',
        sessionId: caller.sessionId,
        rootSessionId: caller.rootSessionId,
        name: caller.name,
      };
      const command =
        params.action === 'plan.create' && params.sessions === undefined
          ? { ...params, sessions: [caller.rootSessionId] }
          : params;
      const result = await service.mutate(caller.cwd, command, actor);
      const mutation = {
        action: params.action,
        ...(params.planId || params.action === 'plan.create'
          ? { planId: params.planId || result.plans.at(-1).id }
          : {}),
        ...(params.milestoneId || params.action === 'milestone.create'
          ? { milestoneId: params.milestoneId || result.overview.milestones.at(-1).id }
          : {}),
      };
      return safeResponse({ ...boundedProjection(result, { target: 'overview' }), mutation, conversation });
    }
    if (!validId(input.epoch)) throw fail(400, 'Invalid agent lifecycle.', 'roadmap_invalid');
    if (input.action === 'clear') {
      rememberClosed(key, input.epoch);
      if (activity.get(key)?.epoch === input.epoch) remove(key);
      return { cleared: true };
    }
    if (closedEpochs.has(`${key}\0${input.epoch}`))
      throw fail(409, 'This agent turn has already ended.', 'roadmap_work_ended');
    if (input.action === 'heartbeat') {
      const current = activity.get(key);
      if (!current || current.epoch !== input.epoch || current.expiresAt <= now()) {
        remove(key);
        throw fail(409, 'Declare work again in the current agent turn.', 'roadmap_work_ended');
      }
      current.expiresAt = now() + ttl;
      return { active: true };
    }
    if (input.action !== 'work') throw fail(400, 'Unknown Roadmap operation.', 'roadmap_invalid');
    const targets = validateTargets(await service.read(caller.cwd), params.targets);
    if (!stillActive() || closedEpochs.has(`${key}\0${input.epoch}`)) throw denied();
    if (activity.get(key)?.epoch && activity.get(key).epoch !== input.epoch)
      rememberClosed(key, activity.get(key).epoch);
    if (targets.length) {
      activity.set(key, { ...caller, targets, epoch: input.epoch, expiresAt: now() + ttl });
      activityRevision++;
    } else {
      rememberClosed(key, input.epoch);
      remove(key);
    }
    return {
      active: targets.length > 0,
      targets,
      sessionId: caller.sessionId,
      rootSessionId: caller.rootSessionId,
    };
  }
  const server = createServer(async (req, res) => {
    const respond = (status, data) => {
      if (!res.destroyed) {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      }
    };
    const supplied = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return respond(403, { error: 'Roadmap capability is unavailable.', code: 'roadmap_agent_denied' });
    if (req.method !== 'POST' || req.url !== '/') return respond(404, { error: 'Unknown Roadmap endpoint.' });
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > bodyLimit)
          throw fail(413, 'Roadmap request exceeds 128 KiB.', 'roadmap_request_too_large');
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw fail(400, 'Invalid Roadmap JSON request.', 'roadmap_invalid');
      }
      respond(200, await dispatch(input));
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      respond(status, {
        error: status < 500 ? error.message : 'Roadmap operation failed. Read the document before retrying.',
        code: error.code || 'roadmap_failed',
        ...(Number.isSafeInteger(error.currentRevision) ? { currentRevision: error.currentRevision } : {}),
      });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const ready = new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolveReady);
  });
  // Expose startup failure via ready without an unhandled rejection while the
  // Studio finishes constructing its runtime.
  ready.catch(() => {});
  const timer = setInterval(sweep, Math.min(ttl, 5000));
  timer.unref?.();
  return {
    config: Object.freeze({ socketPath, token, instanceId }),
    ready,
    snapshot(cwd) {
      sweep();
      return {
        instanceId,
        activityRevision,
        activity: [...activity.values()]
          .filter((item) => cwdKey(item.cwd) === cwdKey(cwd))
          .map(({ epoch, expiresAt, cwd: _cwd, ...item }) => structuredClone(item)),
      };
    },
    revokeOwner(ownerId) {
      revokedOwners.add(ownerId);
      for (const [key, value] of activity) if (value.ownerId === ownerId) remove(key);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      activity.clear();
      activityRevision++;
      await ready.catch(() => {});
      await new Promise((resolveClose) => {
        server.closeAllConnections?.();
        server.close(resolveClose);
      });
      if (process.platform !== 'win32') await unlink(socketPath).catch(() => {});
    },
  };
}
