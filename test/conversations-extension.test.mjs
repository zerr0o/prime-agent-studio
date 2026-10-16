import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRoadmapBridge, createRoadmapCallerResolver } from '../lib/roadmap-bridge.mjs';
import { createConversationTools } from '../lib/conversation-tools.mjs';
import { createPublicApi, publicProjectId } from '../lib/public-api.mjs';
register('./typebox-hook.mjs', import.meta.url);
const { default: extension } = await import('../runtime/studio-conversations-extension.mjs');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'conversations-extension-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentHome = join(dir, 'agent'),
    sessionDir = join(agentHome, 'sessions');
  const cwd = join(dir, 'a'),
    other = join(dir, 'b');
  await Promise.all([sessionDir, cwd, other].map((p) => mkdir(p, { recursive: true })));
  const file = join(sessionDir, 'root.jsonl'),
    childFile = join(sessionDir, 'child.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session', id: 'root', cwd }) + '\n');
  await writeFile(childFile, JSON.stringify({ type: 'session', id: 'child', cwd }) + '\n');
  const projects = [
    { cwd, sessions: [{ id: 'root', title: 'Root' }] },
    { cwd: other, sessions: [{ id: 'saved-b', title: 'B' }] },
  ];
  const runs = new Map([['owner', { id: 'owner', sessionId: 'root', cwd, status: 'running' }]]);
  let historyReads = 0,
    starts = 0,
    sends = 0,
    stops = 0,
    overviewHook;
  const store = {
    overview: async () => {
      overviewHook?.();
      return { projects };
    },
    findProject: async (path) => projects.find((p) => p.cwd === path),
    history: async (id) => {
      historyReads++;
      return {
        cwd: projects.find((p) => p.sessions.some((s) => s.id === id)).cwd,
        messages: [{ id: 'm', role: 'assistant', text: 'x'.repeat(2000) }],
      };
    },
    patchSession: async ({ id, title }) => {
      projects.flatMap((p) => p.sessions).find((s) => s.id === id).title = title;
    },
  };
  const api = createPublicApi({
    access: { close() {} },
    store,
    dataDir: dir,
    agentHome,
    runs,
    startRun: async (body, { authorize }) => {
      await authorize();
      starts++;
      const sessionId = body.sessionId || 'created-b';
      if (!body.sessionId) projects[1].sessions.push({ id: sessionId, title: 'New' });
      const run = { id: `target-${starts}`, sessionId, cwd: body.cwd, status: 'running' };
      runs.set(run.id, run);
      return run;
    },
    liveMessages: {
      send: async (_id, body, { authorize }) => {
        await authorize();
        sends++;
        return { accepted: true, mode: body.mode };
      },
    },
    stopRun: async (run) => {
      stops++;
      run.status = 'stopping';
    },
  });
  t.after(() => api.close());
  const bridge = createRoadmapBridge({
    service: {},
    resolveCaller: createRoadmapCallerResolver({
      getRuns: () => [...runs.values()],
      store,
      agentHome,
      sessionDir,
      readEdges: async () => [{ childId: 'child-handle', child: childFile, parent: file }],
    }),
    isOwnerActive: (id) => runs.get(id)?.status === 'running',
    conversations: createConversationTools({ api, store, runs }),
  });
  await bridge.ready;
  t.after(() => bridge.close());
  const prior = process.env.PRIME_STUDIO_ROADMAP_CONFIG;
  process.env.PRIME_STUDIO_ROADMAP_CONFIG = JSON.stringify(bridge.config);
  const tools = new Map(),
    events = new Map();
  extension({ registerTool: (tool) => tools.set(tool.name, tool), on: (event, fn) => events.set(event, fn) });
  if (prior === undefined) delete process.env.PRIME_STUDIO_ROADMAP_CONFIG;
  else process.env.PRIME_STUDIO_ROADMAP_CONFIG = prior;
  const ctx = { cwd, sessionManager: { getSessionId: () => 'root', getSessionFile: () => file } };
  const invoke = async (operation, params, context = ctx) =>
    JSON.parse(
      (await tools.get(`conversations_${operation}`).execute('call', params, null, null, context)).content[0]
        .text,
    );
  return {
    bridge,
    projects,
    runs,
    tools,
    events,
    ctx,
    invoke,
    childFile,
    counts: () => ({ historyReads, starts, sends, stops }),
    hook: (fn) => {
      overviewHook = fn;
    },
  };
}

test('native JS extension → authenticated socket → native caller resolver → ordinary public consumers', async (t) => {
  const f = await fixture(t);
  assert.equal(f.tools.size, 8);
  const listed = await f.invoke('projects', {});
  assert.equal(listed.items.length, 2);
  assert.equal((await f.invoke('inspect', { sessionId: 'saved-b' })).status, 'saved');
  assert.equal(f.counts().historyReads, 0);
  assert.equal((await f.invoke('history', { sessionId: 'saved-b' })).items[0].text.length, 1500);
  await assert.rejects(f.invoke('history', { sessionId: 'foreign' }));
  const input = {
    projectId: publicProjectId(f.projects[1].cwd),
    requestId: 'create_request_0001',
    message: 'Task',
    name: 'Independent',
  };
  const created = await f.invoke('create', input);
  assert.equal(created.independent, true);
  assert.equal((await f.invoke('create', input)).id, created.id);
  assert.equal(f.counts().starts, 1);
  assert.equal(
    (
      await f.invoke('send', {
        sessionId: created.sessionId,
        requestId: 'follow_request_0001',
        message: 'Follow',
      })
    ).mode,
    'follow_up',
  );
  await assert.rejects(f.invoke('interrupt', { sessionId: created.sessionId, expectedRunId: 'stale' }));
  await f.invoke('interrupt', { sessionId: created.sessionId, expectedRunId: created.id });
  assert.equal(f.counts().stops, 1);
  const resumed = await f.invoke('continue', {
    sessionId: 'saved-b',
    requestId: 'resume_request_0001',
    message: 'Resume',
  });
  assert.equal(resumed.sessionId, 'saved-b');
  const childCtx = {
    ...f.ctx,
    sessionManager: { getSessionId: () => 'child', getSessionFile: () => f.childFile },
  };
  await assert.rejects(f.invoke('projects', {}, childCtx), /no longer owns/);
  await f.events.get('agent_end')({}, f.ctx);
  await assert.rejects(f.invoke('projects', {}), /turn has ended/);
});

test('revocation during asynchronous project lookup reaches no transcript or effect through extension', async (t) => {
  const f = await fixture(t);
  let reads = 0;
  f.hook(() => {
    if (++reads === 2) f.bridge.revokeOwner('owner');
  });
  await assert.rejects(f.invoke('history', { sessionId: 'saved-b' }), /no longer owns/);
  assert.deepEqual(f.counts(), { historyReads: 0, starts: 0, sends: 0, stops: 0 });
});

test('transport ACK loss is UNKNOWN and is never replayed by extension', async (t) => {
  const f = await fixture(t);
  await f.bridge.close();
  await assert.rejects(
    f.invoke('send', { sessionId: 'saved-b', requestId: 'unknown_request_0001', message: 'Follow' }),
    (error) => error.code === 'delivery_uncertain' && error.delivery === 'UNKNOWN',
  );
  assert.equal(f.counts().sends, 0);
});
