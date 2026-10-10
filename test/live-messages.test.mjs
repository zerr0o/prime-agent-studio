import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createLiveMessages } from '../lib/live-messages.mjs';

const cwd = resolve('test-live-project');
const sessionId = 'live-session-1';
function fixture() {
  const calls = [];
  const run = { sessionId, cwd, status: 'running' };
  const queue = { available: true, steering: ['A'], followUps: ['B'] };
  const client = {
    async getSnapshot() {
      return queue;
    },
    async send(id, path, data) {
      calls.push({ id, path, data });
      return { accepted: true, snapshot: queue };
    },
    async mutate(id, path, data) {
      calls.push({ id, path, data });
      return { status: 'applied', snapshot: queue };
    },
  };
  const service = createLiveMessages({ getRuns: async () => [run], getClient: async () => client });
  return { service, calls, run, client, queue };
}
const body = (extra = {}) => ({
  cwd,
  message: 'Corrige ce point.',
  mode: 'steer',
  requestId: 'request-1234567890',
  ...extra,
});
test('live controls match an active native session and exact project before reaching the client', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.getSnapshot(sessionId, cwd), f.queue);
  await assert.rejects(f.service.send(sessionId, body({ cwd: resolve('other-project') })), { status: 409 });
  await assert.rejects(f.service.send('other-session', body()), { status: 409 });
  assert.equal(f.calls.length, 0);
  f.run.status = 'stopping';
  await assert.rejects(f.service.send(sessionId, body({ requestId: 'request-1234567891' })), { status: 409 });
  f.run.status = 'completed';
  assert.equal((await f.service.getSnapshot(sessionId, cwd)).available, false);
});

test('admission is rechecked after asynchronous validation before a live send', async () => {
  const f = fixture();
  let validated, release;
  const reached = new Promise((resolvePromise) => {
    validated = resolvePromise;
  });
  const gate = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  let allowed = true;
  const service = createLiveMessages({
    getRuns: async () => [f.run],
    getClient: async () => f.client,
    validateMessage: async () => {
      validated();
      await gate;
    },
  });
  const sending = service.send(sessionId, body(), {
    authorize: async () => {
      if (!allowed) throw Object.assign(new Error('Revoked'), { status: 401 });
    },
  });
  const rejected = assert.rejects(sending, { status: 401 });
  await reached;
  allowed = false;
  release();
  await rejected;
  assert.equal(f.calls.length, 0);
});

test('queue replacements preserve the native command action kind', async () => {
  const f = fixture();
  for (const [expectedText, text] of [
    ['ordinary message', '/goal status'],
    ['/goal status', 'ordinary message'],
  ]) {
    await assert.rejects(
      f.service.mutate(sessionId, {
        cwd,
        lane: 'steering',
        index: 0,
        expectedText,
        mutation: { type: 'replace', lane: 'steering', text },
      }),
      { status: 400 },
    );
  }
  assert.equal(f.calls.length, 0);
});
test('concurrent duplicate sends and retries after completion reuse the same native acceptance', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 5 }, () => f.service.send(sessionId, body())));
  assert.equal(f.calls.length, 1);
  assert.ok(results.every((r) => r.accepted));
  f.run.status = 'completed';
  assert.equal((await f.service.send(sessionId, body())).accepted, true);
  await assert.rejects(f.service.send(sessionId, body({ message: 'Different' })), { status: 409 });
});
test('an uncertain native send is not blindly repeated with the same key', async () => {
  const f = fixture();
  let attempts = 0;
  f.client.send = async () => {
    attempts++;
    throw Object.assign(new Error('Unconfirmed'), { status: 503 });
  };
  await assert.rejects(f.service.send(sessionId, body()), { status: 503 });
  await assert.rejects(f.service.send(sessionId, body()), { status: 503 });
  assert.equal(attempts, 1);
});
test('a native refusal never becomes an accepted acknowledgement', async () => {
  const f = fixture();
  f.client.send = async () => ({ accepted: false });
  await assert.rejects(f.service.send(sessionId, body()), { status: 409 });
});
test('input validation refuses malformed delivery modes, keys, messages, and queue mutations', async () => {
  const f = fixture();
  for (const bad of [{ mode: 'abort' }, { message: '' }, { requestId: '../x' }, { message: 42 }])
    await assert.rejects(f.service.send(sessionId, body(bad)), { status: 400 });
  await assert.rejects(f.service.send(sessionId, body({ message: 'x'.repeat(270000) })), { status: 413 });
  for (const mutation of [
    { type: 'abort' },
    { type: 'move', direction: 4 },
    { type: 'replace', text: 'x', lane: 'other' },
  ])
    await assert.rejects(
      f.service.mutate(sessionId, { cwd, lane: 'steering', index: 0, expectedText: 'A', mutation }),
      { status: 400 },
    );
  assert.equal(f.calls.length, 0);
});
test('queue edit preserves the compare-and-swap contract and surfaces a changed queue', async () => {
  const f = fixture();
  const change = {
    cwd,
    lane: 'steering',
    index: 0,
    expectedText: 'A',
    mutation: { type: 'replace', text: 'Edited', lane: 'followUp' },
  };
  const result = await f.service.mutate(sessionId, change);
  assert.equal(result.status, 'applied');
  assert.deepEqual(f.calls[0].data, {
    lane: change.lane,
    index: 0,
    expectedText: 'A',
    mutation: change.mutation,
  });
  f.client.mutate = async () => ({ status: 'rejected' });
  await assert.rejects(f.service.mutate(sessionId, change), { status: 409 });
});
