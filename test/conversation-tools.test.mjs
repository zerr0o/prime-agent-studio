import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicApi, publicProjectId } from '../lib/public-api.mjs';
import { createConversationTools } from '../lib/conversation-tools.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const projects = [
    { cwd: join(dir, 'a'), name: 'A', exists: true, sessions: [{ id: 'saved-a', title: 'A saved' }] },
    { cwd: join(dir, 'b'), name: 'B', exists: true, sessions: [{ id: 'saved-b', title: 'B saved' }] },
  ];
  let historyReads = 0,
    starts = 0,
    sends = 0,
    stops = 0;
  const runs = new Map();
  const store = {
    overview: async () => ({ projects }),
    history: async (id) => {
      historyReads++;
      return {
        cwd: projects.find((p) => p.sessions.some((s) => s.id === id)).cwd,
        messages: [{ id: 'm', role: 'assistant', text: 'x'.repeat(3000) }],
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
    agentHome: dir,
    runs,
    startRun: async (body, admission) => {
      await admission.authorize();
      starts++;
      const sessionId = body.sessionId || `created-${starts}`;
      const p = projects.find((p) => p.cwd === body.cwd);
      if (!body.sessionId) p.sessions.push({ id: sessionId, title: 'New' });
      const run = {
        id: `run-${starts}`,
        sessionId,
        cwd: body.cwd,
        status: 'running',
        model: body.model,
        thinking: body.thinking,
      };
      runs.set(run.id, run);
      return run;
    },
    stopRun: async (run) => {
      stops++;
      run.status = 'stopping';
    },
    liveMessages: {
      send: async (sessionId, body, admission) => {
        await admission.authorize();
        sends++;
        return { accepted: true, requestId: body.requestId, mode: body.mode };
      },
    },
  });
  t.after(() => api.close());
  const control = createConversationTools({ api, store, runs });
  return { control, projects, runs, api, store, counts: () => ({ historyReads, starts, sends, stops }) };
}
const auth = { authorize: async () => {} };

test('owner-wide registered targets, passive inspect, bounded history and existing consumers/dedup', async (t) => {
  const f = await fixture(t);
  const listed = await f.control('projects', {}, auth);
  assert.equal(listed.items.length, 2);
  const inspected = await f.control('inspect', { sessionId: 'saved-b' }, auth);
  assert.equal(inspected.status, 'saved');
  assert.equal(f.counts().historyReads, 0);
  const history = await f.control('history', { sessionId: 'saved-b', limit: 1 }, auth);
  assert.equal(history.items[0].text.length, 1500);
  assert.equal(history.items[0].truncated, true);
  await assert.rejects(f.control('history', { sessionId: 'foreign' }, auth));
  assert.equal(f.counts().historyReads, 1);
  await assert.rejects(f.control('history', { sessionId: 'saved-b', limit: 51 }, auth));
  const input = {
    projectId: publicProjectId(f.projects[1].cwd),
    message: 'Task',
    requestId: 'request_create_0001',
    name: 'Independent',
    model: 'provider/model',
    thinking: 'medium',
  };
  const created = await f.control('create', input, auth);
  const duplicate = await f.control('create', input, auth);
  assert.equal(duplicate.sessionId, created.sessionId);
  assert.equal(f.counts().starts, 1);
  assert.equal(created.model, 'provider/model');
  assert.equal(f.projects[1].sessions.find((s) => s.id === created.sessionId).title, 'Independent');
  const sent = await f.control(
    'send',
    { sessionId: created.sessionId, message: 'Follow', requestId: 'request_follow_0001' },
    auth,
  );
  assert.equal(sent.mode, 'follow_up');
  await assert.rejects(
    f.control('interrupt', { sessionId: created.sessionId, expectedRunId: 'stale' }, auth),
  );
  await f.control('interrupt', { sessionId: created.sessionId, expectedRunId: created.id }, auth);
  assert.equal(f.counts().stops, 1);
  assert.equal(
    f.projects[1].sessions.some((s) => s.id === created.sessionId),
    true,
  );
  const continued = await f.control(
    'continue',
    { sessionId: 'saved-b', message: 'Resume exact', requestId: 'request_resume_0001' },
    auth,
  );
  assert.equal(continued.sessionId, 'saved-b');
  await assert.rejects(f.control('create', { ...input, cwd: '/wrong' }, auth));
  await assert.rejects(
    f.control(
      'history',
      { sessionId: 'saved-b' },
      {
        authorize: async () => {
          throw Error('revoked');
        },
      },
    ),
  );
});

test('interrupt rechecks exact run after authorization race; UNKNOWN is surfaced without retry', async (t) => {
  const f = await fixture(t);
  const created = await f.control(
    'create',
    { projectId: publicProjectId(f.projects[0].cwd), message: 'Task', requestId: 'race_request_00001' },
    auth,
  );
  let checks = 0;
  const race = {
    authorize: async () => {
      if (++checks === 8) {
        const old = f.runs.get(created.id);
        old.finished = true;
        f.runs.set('new-run', { ...old, id: 'new-run', finished: false });
      }
    },
  };
  await assert.rejects(
    f.control('interrupt', { sessionId: created.sessionId, expectedRunId: created.id }, race),
  );
  assert.equal(f.counts().stops, 0);
  const original = f.api.conversationCall;
  let sends = 0;
  f.api.conversationCall = async (...args) => {
    if (args[0] === 'POST') {
      sends++;
      throw Object.assign(Error('lost ack'), { status: 503 });
    }
    return original(...args);
  };
  await assert.rejects(
    f.control(
      'send',
      { sessionId: created.sessionId, message: 'Task', requestId: 'uncertain_request1' },
      auth,
    ),
    { code: 'delivery_uncertain' },
  );
  assert.equal(sends, 1);
});

test('revocation during API overview prevents transcript reads for history, send and continue', async (t) => {
  for (const operation of ['history', 'send', 'continue']) {
    await t.test(operation, async (t) => {
      const f = await fixture(t);
      let revoked = false;
      f.store.overview = async () => {
        revoked = true;
        return { projects: f.projects };
      };
      const authorize = async () => {
        if (revoked) throw Object.assign(Error('revoked'), { status: 403, code: 'forbidden' });
      };
      const projectId = publicProjectId(f.projects[0].cwd);
      const path =
        operation === 'continue'
          ? `/api/v1/projects/${projectId}/runs`
          : `/api/v1/sessions/saved-a/messages${operation === 'history' ? '?limit=1' : ''}`;
      const body =
        operation === 'history'
          ? undefined
          : {
              requestId: 'revoked_request_001',
              message: 'Do not read or deliver',
              ...(operation === 'continue' ? { sessionId: 'saved-a' } : { mode: 'follow_up' }),
            };
      await assert.rejects(
        f.api.conversationCall(operation === 'history' ? 'GET' : 'POST', path, body, authorize),
        { code: 'forbidden' },
      );
      assert.deepEqual(f.counts(), { historyReads: 0, starts: 0, sends: 0, stops: 0 });
    });
  }
});
