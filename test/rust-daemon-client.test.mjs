import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { RustDaemonClient } from '../lib/rust-daemon-client.mjs';

async function fixture(run) {
  const path = `\\\\.\\pipe\\rust-studio-test-${randomUUID()}`;
  let peer;
  let accept;
  const accepted = new Promise((resolve) => {
    accept = resolve;
  });
  const server = createServer((socket) => {
    peer = socket;
    accept();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  const client = new RustDaemonClient(path);
  try {
    await client.connect();
    await accepted;
    assert.ok(peer);
    await run({ client, peer, path });
  } finally {
    client.close();
    peer?.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

function hello(path, overrides = {}) {
  return {
    type: 'daemon_hello',
    socketPath: path,
    protocol: { name: 'prime-agent.daemon', version: 7 },
    schemaId: 'protocol-7-schema-30-8e4b17c2a9f5',
    schemaRevision: 30,
    appVersion: '0.10.0',
    supervisorPid: 1234,
    clientId: 'connection-1',
    serverCapabilities: ['queue_message_mutation'],
    runtime: { buildId: 'pa-daemon-rs-0.10.0', executablePath: '/agent' },
    ...overrides,
  };
}

function line(peer, value) {
  peer.write(`${JSON.stringify(value)}\n`);
}

async function nextLine(peer) {
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('No client command'));
    }, 1000);
    function cleanup() {
      clearTimeout(timer);
      peer.off('data', onData);
    }
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        cleanup();
        resolve(JSON.parse(buffer.slice(0, end)));
      }
    }
    peer.on('data', onData);
  });
}

test('fragmented Unicode hello and interleaved response/event/progress', async () => {
  await fixture(async ({ client, peer, path }) => {
    const encoded = Buffer.from(`${JSON.stringify(hello(path))}\n`);
    const pivot = encoded.indexOf(Buffer.from('daemon_hello')) + 3;
    peer.write(encoded.subarray(0, pivot));
    peer.write(encoded.subarray(pivot));
    assert.equal((await client.waitForHello()).supervisorPid, 1234);
    assert.equal(client.supportsServerCapability('queue_message_mutation'), true);
    const messages = [];
    const progress = [];
    client.onMessage((message) => messages.push(message));
    const commandLine = nextLine(peer);
    client.protocolClientId = 'owner-1';
    client.requestId = 100;
    const pending = client.request({ type: 'get_state', activeSessionId: 'session-1' }, 1000, {
      onProgress: (value) => progress.push(value),
    });
    const command = await commandLine;
    assert.equal(command.type, 'command');
    assert.deepEqual(command.protocol, { name: 'prime-agent.daemon', version: 7 });
    assert.equal(command.clientId, 'owner-1');
    assert.equal(command.id, 'daemon_101');
    assert.deepEqual(command.command, { type: 'get_state', activeSessionId: 'session-1', id: 'daemon_101' });
    const event = { type: 'session_event', activeSessionId: 'session-1', event: { text: 'é😀' } };
    const frame = Buffer.from(`${JSON.stringify(event)}\n`);
    const emoji = frame.indexOf(Buffer.from('😀'));
    peer.write(frame.subarray(0, emoji + 2));
    peer.write(frame.subarray(emoji + 2));
    line(peer, {
      type: 'session_list_progress',
      id: command.id,
      command: 'list_saved_sessions',
      loaded: 1,
      total: 2,
    });
    line(peer, {
      type: 'response',
      id: command.id,
      command: 'get_state',
      success: true,
      data: { name: 'é😀' },
    });
    assert.deepEqual((await pending).data, { name: 'é😀' });
    assert.deepEqual(messages, [event]);
    assert.equal(progress.length, 1);
  });
});

test('rejects unexpected Rust namespace identity before request', async () => {
  await fixture(async ({ client, peer, path }) => {
    const waiting = client.waitForHello(1000);
    line(peer, hello(path, { supervisorPid: 0 }));
    await assert.rejects(waiting, /Invalid or incompatible Rust daemon hello/);
    await assert.rejects(client.request({ type: 'list' }), /not connected/);
  });
});

test('caller supplied process identity is checked', async () => {
  await fixture(async ({ client, peer, path }) => {
    client.expectedIdentity = { supervisorPid: 9999 };
    const waiting = client.waitForHello(1000);
    line(peer, hello(path));
    await assert.rejects(waiting, /identity mismatch/);
  });
});

test('timeout and socket closure reject outstanding requests without retry', async () => {
  await fixture(async ({ client, peer, path }) => {
    line(peer, hello(path));
    await client.waitForHello();
    let commandLine = nextLine(peer);
    const timed = client.request({ type: 'prompt', activeSessionId: 's', message: 'x' }, 20);
    await commandLine;
    await assert.rejects(timed, /delivery is uncertain/);
    commandLine = nextLine(peer);
    const pending = client.request({ type: 'get_state', activeSessionId: 's' }, 1000);
    await commandLine;
    peer.destroy();
    await assert.rejects(pending, /socket closed|ECONNRESET/i);
    assert.equal(client.pending.size, 0);
  });
});

test('command refusal resolves as an explicit response', async () => {
  await fixture(async ({ client, peer, path }) => {
    line(peer, hello(path));
    await client.waitForHello();
    const commandLine = nextLine(peer);
    const pending = client.request({ type: 'get_state', activeSessionId: 's' });
    const command = await commandLine;
    line(peer, {
      type: 'response',
      id: command.id,
      command: 'get_state',
      success: false,
      error: 'Unknown session',
    });
    assert.equal((await pending).error, 'Unknown session');
  });
});

test('persistent attach client receives worker events after the attach response', async () => {
  await fixture(async ({ client, peer, path }) => {
    line(peer, hello(path));
    await client.waitForHello();
    const received = [];
    let delivered;
    const deliveredEvent = new Promise((resolve) => {
      delivered = resolve;
    });
    client.onMessage((message) => {
      received.push(message);
      delivered();
    });
    const commandLine = nextLine(peer);
    const attaching = client.request({
      type: 'attach',
      activeSessionId: 'session-1',
      clientId: 'studio-view',
      capabilities: ['attach_snapshot', 'event_sequence'],
    });
    const command = await commandLine;
    line(peer, {
      type: 'response',
      id: command.id,
      command: 'attach',
      success: true,
      data: { activeSessionId: 'session-1' },
    });
    assert.equal((await attaching).success, true);
    const event = { type: 'session_event', activeSessionId: 'session-1', event: { type: 'message_update' } };
    line(peer, event);
    await deliveredEvent;
    assert.deepEqual(received, [event]);
  });
});
