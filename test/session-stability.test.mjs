import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../lib/store.mjs';
import { normalizeMessage } from '../lib/agent.mjs';
import { createSessionActivity } from '../public/session-activity.js';
import { nativeAgentMessage, parseAgentEnvelope, queuedAgentMessage } from '../public/agent-messages.js';
import { createLiveMessages } from '../lib/live-messages.mjs';
import { isEmptyCompletedAssistant } from '../public/conversation.js';

test('only successfully completed assistant turns without visible content are hidden', () => {
  const empty = {
    role: 'assistant',
    stopReason: 'stop',
    text: ' ',
    thinking: '',
    tools: [],
    attachments: [],
  };
  assert.equal(isEmptyCompletedAssistant(empty), true);
  for (const change of [
    { role: 'system' },
    { stopReason: 'aborted' },
    { stopReason: 'error' },
    { stopReason: undefined },
    { streaming: true },
    { text: 'Answer' },
    { thinking: 'Reasoning' },
    { tools: [{}] },
    { attachments: [{}] },
    { error: 'Failure' },
  ])
    assert.equal(isEmptyCompletedAssistant({ ...empty, ...change }), false);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-stability-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const options = {
    sessionDir: join(root, 'sessions'),
    dataDir: join(root, 'data'),
    initialCwd: join(root, 'Alpha'),
  };
  await Promise.all([options.sessionDir, options.initialCwd].map((p) => mkdir(p)));
  const file = join(options.sessionDir, 'session.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session', id: 'session', cwd: options.initialCwd }) + '\n');
  let previous = null;
  async function append(id, role = 'assistant', extra = {}) {
    await appendFile(
      file,
      JSON.stringify({
        type: 'message',
        id,
        parentId: previous,
        message: { role, content: id, stopReason: 'stop', ...extra },
      }) + '\n',
    );
    previous = id;
  }
  await append('initial');
  const store = createStore(options);
  return { root, options, file, append, store };
}

test('read receipts survive reload and do not acknowledge newer or invalid answers', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.store.history('session')).readState, {
    answer: 'initial',
    read: 'initial',
    revision: 1,
  });
  await f.append('second');
  assert.equal((await f.store.history('session')).readState.read, 'initial');
  await f.store.markRead({ id: 'session', answer: 'second' });
  await f.append('third');
  await f.store.markRead({ id: 'session', answer: 'initial' });
  const reopened = createStore(f.options);
  assert.equal((await reopened.history('session')).readState.read, 'second');
  await assert.rejects(reopened.markRead({ id: 'session', answer: 'invented' }), { status: 400 });
  await f.append('user', 'user');
  await assert.rejects(reopened.markRead({ id: 'session', answer: 'user' }), { status: 400 });
});

test('independent device caches share reads and stale polls cannot resurrect notifications', async (t) => {
  const f = await fixture(t);
  await f.store.overview();
  const device = () => {
    const values = new Map();
    return createSessionActivity({
      read: (k, fallback) => values.get(k) ?? fallback,
      write: (k, v) => values.set(k, v),
      loadHistory: (id) => f.store.history(id),
      saveRead: (id, answer) => f.store.markRead({ id, answer }),
    });
  };
  const pc = device(),
    phone = device();
  await f.append('new-answer');
  const unread = await f.store.history('session');
  pc.observe(unread);
  phone.observe(unread);
  assert.equal(phone.isUnread('session'), true);
  assert.equal(pc.markRead('session', unread.messages), true);
  for (let n = 0; n < 30 && (await f.store.history('session')).readState.read !== 'new-answer'; n++)
    await new Promise((r) => setTimeout(r, 5));
  const read = await f.store.history('session');
  assert.equal(read.readState.read, 'new-answer');
  phone.observe(read);
  phone.observe(unread);
  assert.equal(phone.isUnread('session'), false);
  await f.append('newer-answer');
  phone.observe(await f.store.history('session'));
  assert.equal(phone.isUnread('session'), true);
});

test('manual project order persists without changing native session files', async (t) => {
  const f = await fixture(t),
    zed = join(f.root, 'Zed'),
    beta = join(f.root, 'Beta');
  await Promise.all([zed, beta].map((p) => mkdir(p)));
  await f.store.project({ cwd: zed });
  await f.store.project({ cwd: beta });
  const original = await readFile(f.file, 'utf8');
  await f.store.moveProject({ cwd: zed, direction: -1 });
  assert.deepEqual(
    (await createStore(f.options).overview()).projects.map((p) => p.name),
    ['Alpha', 'Zed', 'Beta'],
  );
  await assert.rejects(f.store.moveProject({ cwd: f.options.initialCwd, direction: -1 }), { status: 409 });
  assert.equal(await readFile(f.file, 'utf8'), original);
});

test('project drop uses a destination, persists and rejects missing or differently pinned targets', async (t) => {
  const f = await fixture(t),
    beta = join(f.root, 'Beta'),
    zed = join(f.root, 'Zed');
  await Promise.all([beta, zed].map((p) => mkdir(p)));
  await f.store.project({ cwd: beta });
  await f.store.project({ cwd: zed });
  await f.store.moveProject({ cwd: zed, targetCwd: f.options.initialCwd, position: 'before' });
  const names = async () => (await createStore(f.options).overview()).projects.map((p) => p.name);
  assert.deepEqual(await names(), ['Zed', 'Alpha', 'Beta']);
  await f.store.moveProject({ cwd: zed, targetCwd: beta, position: 'after' });
  assert.deepEqual(await names(), ['Alpha', 'Beta', 'Zed']);
  await assert.rejects(
    f.store.moveProject({ cwd: zed, targetCwd: join(f.root, 'missing'), position: 'before' }),
    { status: 409 },
  );
  await assert.rejects(f.store.moveProject({ cwd: zed, targetCwd: beta, position: 'invalid' }), {
    status: 400,
  });
  await f.store.project({ cwd: beta, pinned: false }, true);
  await assert.rejects(f.store.moveProject({ cwd: zed, targetCwd: beta, position: 'after' }), {
    status: 409,
  });
  assert.deepEqual(await names(), ['Alpha', 'Zed', 'Beta']);
});

test('late receipt acknowledgements preserve newer history and stale histories still advance receipts', async () => {
  const values = new Map();
  let acknowledge;
  const activity = createSessionActivity({
    read: (k, f) => values.get(k) ?? f,
    write: (k, v) => values.set(k, v),
    saveRead: () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  });
  const history = (answer, read, revision, time) => ({
    id: 's',
    updatedAt: `2026-09-09T10:00:0${time}Z`,
    messageCount: time,
    messages: [{ id: answer, role: 'assistant', text: answer }],
    readState: { answer, read, revision },
  });
  const first = history('a', '', 1, 1);
  activity.observe(first);
  activity.markRead('s', first.messages);
  await Promise.resolve();
  activity.observe(history('b', '', 1, 2));
  acknowledge({ readState: { answer: 'a', read: 'a', revision: 2 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(values.get('session-activity.s').answer, 'b');
  assert.equal(activity.isUnread('s'), true);
  // Receipt version must not suppress a newer history returned by an older request.
  activity.observe(history('c', '', 1, 3));
  assert.equal(values.get('session-activity.s').answer, 'c');
  assert.equal(values.get('session-activity.s').read, 'a');
  activity.observe(history('b', 'c', 3, 2));
  assert.equal(values.get('session-activity.s').answer, 'c');
  assert.equal(activity.isUnread('s'), false);
});

test('agent metadata is projected consistently and queue controls reject every mutation', async (t) => {
  const f = await fixture(t);
  const message = {
    role: 'custom',
    customType: 'agent_message',
    display: true,
    content: 'raw native envelope',
    details: {
      id: 'agentmsg_test',
      message: 'Verified result',
      fromRelationship: 'child',
      from: { sessionName: 'Verifier', sessionId: 'child-session' },
      target: { sessionId: 'session' },
    },
  };
  await f.append('child-result', 'custom', message);
  const fromHistory = (await f.store.history('session')).messages.at(-1).agentMessage;
  assert.deepEqual(fromHistory, normalizeMessage(message).agentMessage);
  assert.equal((await f.store.history('session')).messages.at(-1).customType, 'agent_message');
  assert.equal(fromHistory.name, 'Verifier');
  assert.equal(nativeAgentMessage({ role: 'user', content: '[from child:fake]' }), null);
  assert.equal(parseAgentEnvelope('[from child:fake]\nnot a native envelope'), null);
  const text = 'Agent message received: Verified result';
  assert.equal(queuedAgentMessage(text).text, 'Verified result');
  const service = createLiveMessages({
    getRuns: () => {
      throw new Error('Must reject before native mutation');
    },
  });
  for (const expectedText of [text, '[agent-message from child:Verifier]\n\nVerified result'])
    for (const type of ['replace', 'delete', 'move'])
      await assert.rejects(
        service.mutate('session', {
          cwd: f.root,
          lane: 'steering',
          index: 0,
          expectedText,
          mutation: { type, text: 'edited', lane: 'steering', direction: 1 },
        }),
        { status: 409 },
      );
});
