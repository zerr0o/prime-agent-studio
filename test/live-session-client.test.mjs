import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createLiveSessionClient, resolveLiveSessionOwner } from '../lib/live-session-client.mjs';

const sessionId = 'session-header-one';
const cwd = resolve('test/live-project');
const socketPath =
  process.platform === 'win32' ? '\\\\.\\pipe\\prime-studio-test' : '/tmp/prime-studio-test.sock';
const owner = {
  sessionId,
  cwd,
  activeSessionId: 'active-one',
  ownerClientId: 'daemon-client:private-owner',
  sessionFile: join(cwd, 'different-filename.jsonl'),
};

function fixture(options = {}) {
  const calls = [];
  const instances = [];
  const queue = { steering: [], followUp: [] };
  let changed = false;
  class Client {
    requestId = 0;
    closed = false;
    constructor(socket) {
      this.socket = socket;
      instances.push(this);
    }
    async connect() {}
    async waitForHello() {
      return { supervisorPid: options.wrongPid ? 99 : 11, socketPath };
    }
    supportsServerCapability() {
      return options.mutationSupported !== false;
    }
    close() {
      this.closed = true;
    }
    async request(command) {
      const id = ++this.requestId;
      calls.push({ ...command, id, owner: this.protocolClientId });
      assert.equal(this.protocolClientId, owner.ownerClientId);
      assert.equal(command.activeSessionId, owner.activeSessionId);
      if (options.snapshotFailsAfterSend && changed)
        throw new Error('Unknown active session C:/private-path');
      switch (command.type) {
        case 'set_thinking_level':
          if (options.sendThrows) throw new Error('Disconnected');
          return { success: !options.sendRejected };
        case 'get_state':
          return {
            success: true,
            data: {
              sessionId,
              activeSessionId: owner.activeSessionId,
              cwd: options.wrongCwd ? resolve('another-project') : cwd,
              sessionFile: owner.sessionFile,
              isStreaming: true,
              isRunningTools: true,
              messageCount: 4,
              privateCredentials: 'secret-must-not-escape',
              model: { provider: 'fixture', id: 'parent', apiKey: 'secret-must-not-escape' },
              thinkingLevel: 'max',
            },
          };
        case 'get_session_header':
          return {
            success: true,
            data: { header: { type: 'session', id: options.wrongHeader ? 'wrong-header' : sessionId, cwd } },
          };
        case 'get_queue':
          return { success: true, data: { steering: [...queue.steering], followUp: [...queue.followUp] } };
        case 'get_rlm_children':
          return {
            success: true,
            data: {
              children: [
                {
                  id: 'child-one',
                  parentId: sessionId,
                  sessionName: 'Audit',
                  model: 'fixture/child',
                  thinkingLevel: 'off',
                  status: 'done',
                  activity: { kind: 'executing', toolName: 'ipython', privateCredentials: 'secret' },
                  sessionDir: 'private-secret',
                  answerPreview: 'A result',
                  progressNote: 'Checking the result',
                  lastActivityAt: 1800000000000,
                  activityStaleMs: 2000,
                },
              ],
            },
          };
        case 'get_commands':
          return {
            success: true,
            data: {
              commands: [
                {
                  name: 'skill:example',
                  source: 'skill',
                  description: 'A skill',
                  sourceInfo: { path: 'skill.md', scope: 'project', secret: 'private' },
                },
              ],
            },
          };
        case 'prompt':
          queue[command.streamingBehavior === 'steer' ? 'steering' : 'followUp'].push(command.message);
          return { success: true };
        case 'steer':
        case 'follow_up':
          if (options.sendThrows) throw new Error('Private C:/path with owner-secret');
          if (options.sendRejected) return { success: false, error: 'Private C:/path with owner-secret' };
          changed = true;
          if (options.notQueued) return { success: true, data: { queued: false } };
          queue[command.type === 'steer' ? 'steering' : 'followUp'].push(command.message);
          return { success: true, data: command.type === 'follow_up' ? { queued: true } : undefined };
        case 'mutate_queued_message': {
          const lane = queue[command.lane];
          if (lane[command.index] !== command.expectedText)
            return { success: true, data: { status: 'rejected' } };
          if (command.mutation.type === 'delete') lane.splice(command.index, 1);
          else if (command.mutation.type === 'replace') {
            lane.splice(command.index, 1);
            queue[command.mutation.lane].push(command.mutation.text);
          } else {
            const to = command.index + command.mutation.direction;
            if (to < 0 || to >= lane.length) return { success: true, data: { status: 'rejected' } };
            [lane[to], lane[command.index]] = [lane[command.index], lane[to]];
          }
          return { success: true, data: { status: 'applied' } };
        }
        default:
          throw new Error(`Forbidden command ${command.type}`);
      }
    }
  }
  const client = createLiveSessionClient(
    {
      packageDir: resolve('test/fake-prime'),
      socketPath,
      supervisorPid: 11,
      resolveOwner: async () => ({ ...owner, ...options.owner }),
    },
    { loadClient: async () => Client },
  );
  return { client, queue, calls, instances };
}

test('live thinking targets the verified owner and returns the native effective level', async () => {
  const f = fixture();
  assert.equal(await f.client.setThinking(sessionId, cwd, 'high'), 'max');
  assert.deepEqual(
    f.calls.map((x) => x.type),
    ['get_state', 'get_session_header', 'set_thinking_level', 'get_state', 'get_session_header'],
  );
  assert.ok(f.instances.every((x) => x.closed));
  for (const options of [{ wrongCwd: true }, { wrongHeader: true }]) {
    const other = fixture(options);
    await assert.rejects(other.client.setThinking(sessionId, cwd, 'low'));
    assert.ok(!other.calls.some((x) => x.type === 'set_thinking_level'));
  }
  await assert.rejects(fixture({ sendThrows: true }).client.setThinking(sessionId, cwd, 'low'), {
    code: 'delivery_uncertain',
  });
});

test('snapshot observes the exact native header without lifecycle commands or private metadata', async () => {
  const f = fixture();
  f.queue.steering.push('Ajuste le test');
  const snapshot = await f.client.getSnapshot(sessionId, cwd);
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.steering, ['Ajuste le test']);
  assert.deepEqual(snapshot.followUps, []);
  assert.equal(snapshot.state.isRunningTools, true);
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
  assert.ok(!JSON.stringify(snapshot).includes(owner.ownerClientId));
  assert.deepEqual(
    f.calls.map((call) => call.type),
    ['get_state', 'get_session_header', 'get_queue'],
  );
  assert.ok(f.instances.every((instance) => instance.closed));
});

test('inspector observes sub-agents without attaching or exposing private metadata', async () => {
  const f = fixture();
  const snapshot = await f.client.getInspector(sessionId, cwd);
  assert.equal(snapshot.state.model, 'fixture/parent');
  assert.equal(snapshot.state.thinkingLevel, 'max');
  assert.equal(snapshot.children[0].thinkingLevel, 'off');
  assert.equal(snapshot.state.isRunningTools, true);
  assert.equal(snapshot.children[0].activity.kind, 'executing');
  assert.equal(snapshot.children[0].progressNote, 'Checking the result');
  assert.equal(snapshot.children[0].lastActivityAt, 1800000000000);
  assert.equal(snapshot.children[0].activityStaleMs, 2000);
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
  assert.deepEqual(
    f.calls.map((call) => call.type),
    ['get_state', 'get_session_header', 'get_rlm_children', 'get_connection_state'],
  );
  assert.ok(f.instances.every((instance) => instance.closed));
});

test('native command catalogue is read-only and session commands use prompt admission in their chosen lane', async () => {
  const f = fixture();
  assert.deepEqual(await f.client.getCommands(sessionId, cwd), [
    {
      name: 'skill:example',
      source: 'skill',
      description: 'A skill',
      sourceInfo: { path: 'skill.md', scope: 'project' },
    },
  ]);
  for (const mode of ['steer', 'follow_up']) {
    assert.equal((await f.client.send(sessionId, cwd, { message: '  /goal status  ', mode })).accepted, true);
  }
  const prompts = f.calls.filter((c) => c.type === 'prompt');
  assert.deepEqual(
    prompts.map((p) => p.streamingBehavior),
    ['steer', 'followUp'],
  );
  assert.ok(prompts.every((p) => p.queueIfBusy && p.message === '/goal status'));
  await assert.rejects(f.client.send(sessionId, cwd, { message: '/goal status\nhello', mode: 'steer' }), {
    status: 400,
  });
  assert.ok(f.instances.every((instance) => instance.closed));
});

test('a different cwd, native header, owner target, or daemon PID prevents every mutation', async () => {
  for (const options of [
    { wrongCwd: true },
    { wrongHeader: true },
    { wrongPid: true },
    { owner: { sessionId: 'other' } },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.client.send(sessionId, cwd, { message: 'Hello', mode: 'steer' }), { status: 409 });
    assert.ok(!f.calls.some((call) => call.type === 'steer'));
    assert.ok(f.instances.every((instance) => instance.closed));
  }
});

test('steering and follow-up report native admission and queue snapshots', async () => {
  const f = fixture();
  const first = await f.client.send(sessionId, cwd, {
    message: 'Corrige maintenant',
    mode: 'steer',
    requestId: 'request-one',
  });
  const second = await f.client.send(sessionId, cwd, {
    message: 'Puis la documentation',
    mode: 'follow_up',
    requestId: 'request-two',
  });
  assert.equal(first.accepted, true);
  assert.deepEqual(first.snapshot.steering, ['Corrige maintenant']);
  assert.deepEqual(second.snapshot.followUps, ['Puis la documentation']);
  const native = f.calls.filter((call) => ['steer', 'follow_up'].includes(call.type));
  assert.deepEqual(
    native.map((call) => call.queueKey),
    ['prime-studio:request-one', 'prime-studio:request-two'],
  );
  assert.ok(native.every((call) => call.id > 2 ** 50 && Number.isSafeInteger(call.id)));
  assert.notEqual(native[0].id, native[1].id);
  const rejected = fixture({ notQueued: true });
  assert.equal(
    (await rejected.client.send(sessionId, cwd, { message: 'No', mode: 'follow_up' })).accepted,
    false,
  );
});

test('repeat request IDs reuse native mutation IDs and fresh observations use independent counters', async () => {
  const f = fixture();
  const input = { message: 'One request', mode: 'steer', requestId: 'same-request' };
  await f.client.send(sessionId, cwd, input);
  await f.client.send(sessionId, cwd, input);
  const sends = f.calls.filter((call) => call.type === 'steer');
  const reads = f.calls.filter((call) => call.type === 'get_state');
  assert.equal(sends[0].id, sends[1].id);
  assert.notEqual(reads[0].id, reads[2].id);
});

test('edit, move, delete, and expected-text conflicts use native queue mutation safely', async () => {
  const f = fixture();
  f.queue.steering.push('one', 'two');
  const moved = await f.client.mutate(sessionId, cwd, {
    lane: 'steering',
    index: 1,
    expectedText: 'two',
    mutation: { type: 'move', direction: -1 },
  });
  assert.equal(moved.status, 'applied');
  assert.deepEqual(moved.snapshot.steering, ['two', 'one']);
  const edited = await f.client.mutate(sessionId, cwd, {
    lane: 'steering',
    index: 0,
    expectedText: 'two',
    mutation: { type: 'replace', text: 'edited', lane: 'followUp', ignored: 'secret' },
  });
  assert.deepEqual(edited.snapshot.followUps, ['edited']);
  const stale = await f.client.mutate(sessionId, cwd, {
    lane: 'steering',
    index: 0,
    expectedText: 'two',
    mutation: { type: 'delete' },
  });
  assert.equal(stale.status, 'rejected');
  assert.deepEqual(stale.snapshot.steering, ['one']);
  const removed = await f.client.mutate(sessionId, cwd, {
    lane: 'followUp',
    index: 0,
    expectedText: 'edited',
    mutation: { type: 'delete' },
  });
  assert.deepEqual(removed.snapshot.followUps, []);
  assert.ok(!JSON.stringify(f.calls).includes('ignored'));
});

test('unsupported mutation and invalid inputs never send a mutation command', async () => {
  const f = fixture({ mutationSupported: false });
  const result = await f.client.mutate(sessionId, cwd, {
    lane: 'steering',
    index: 0,
    expectedText: 'one',
    mutation: { type: 'delete' },
  });
  assert.equal(result.status, 'unsupported');
  await assert.rejects(f.client.send(sessionId, cwd, { message: '', mode: 'steer' }), { status: 400 });
  await assert.rejects(f.client.send(sessionId, cwd, { message: 'OK', mode: 'shutdown' }), { status: 400 });
  await assert.rejects(
    f.client.send(sessionId, cwd, { message: 'OK', mode: 'steer', requestId: '../other' }),
    { status: 400 },
  );
  await assert.rejects(
    f.client.mutate(sessionId, cwd, {
      lane: 'steering',
      index: -1,
      expectedText: 'one',
      mutation: { type: 'delete' },
    }),
    { status: 400 },
  );
  assert.ok(!f.calls.some((call) => ['steer', 'follow_up', 'mutate_queued_message'].includes(call.type)));
});

test('native errors are public-safe and an accepted send remains accepted if its session ends during the snapshot', async () => {
  for (const [options, status, code] of [
    [{ sendThrows: true }, 503, 'delivery_uncertain'],
    [{ sendRejected: true }, 409, 'native_rejected'],
  ]) {
    const f = fixture(options);
    await assert.rejects(f.client.send(sessionId, cwd, { message: 'Hello', mode: 'steer' }), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.ok(!error.message.includes('private'));
      assert.ok(!error.message.includes('C:/'));
      return true;
    });
  }
  const f = fixture({ snapshotFailsAfterSend: true });
  const result = await f.client.send(sessionId, cwd, { message: 'Accepted', mode: 'steer' });
  assert.equal(result.accepted, true);
  assert.equal(result.snapshot, null);
});

test('close disconnects observers only and prevents later access', async () => {
  const f = fixture();
  await f.client.getSnapshot(sessionId, cwd);
  f.client.close();
  await assert.rejects(f.client.getSnapshot(sessionId, cwd), { status: 409 });
  assert.ok(!f.calls.some((call) => /close|stop|shutdown|kill|detach|attach|create|resume/.test(call.type)));
});

test('descriptor discovery stays in the exact socket namespace and rejects stopped or ambiguous owners', async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), 'prime-live-descriptors-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const key = createHash('sha256')
    .update(process.platform === 'win32' ? socketPath.toLowerCase() : resolve(socketPath))
    .digest('hex')
    .slice(0, 12);
  const directory = join(agentDir, 'daemon-workers', key);
  await mkdir(directory, { recursive: true });
  const descriptor = {
    rootSessionId: sessionId,
    rootActiveSessionId: owner.activeSessionId,
    ownerClientId: owner.ownerClientId,
    supervisorSocketPath: socketPath,
    sessionFile: owner.sessionFile,
    lifecycle: 'ready',
    authenticationToken: 'must-not-return',
  };
  await writeFile(join(directory, 'worker.json'), JSON.stringify(descriptor));
  await writeFile(
    join(directory, 'foreign.json'),
    JSON.stringify({ ...descriptor, supervisorSocketPath: `${socketPath}-other` }),
  );
  const context = await resolveLiveSessionOwner({ socketPath, agentDir }, sessionId, cwd);
  assert.deepEqual(context, owner);
  assert.equal(context.authenticationToken, undefined);
  await writeFile(
    join(directory, 'worker.json'),
    JSON.stringify({ ...descriptor, stopRequestedAt: new Date().toISOString() }),
  );
  await assert.rejects(resolveLiveSessionOwner({ socketPath, agentDir }, sessionId, cwd), { status: 409 });
  await writeFile(join(directory, 'worker.json'), JSON.stringify(descriptor));
  await writeFile(join(directory, 'duplicate.json'), JSON.stringify(descriptor));
  await assert.rejects(resolveLiveSessionOwner({ socketPath, agentDir }, sessionId, cwd), { status: 409 });
});
