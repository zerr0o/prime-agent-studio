import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverCli, agentEnvironment } from '../lib/agent.mjs';
import { transformDaemonStream, initialize, load } from '../runtime/daemon-stream-hook.mjs';
import { pathToFileURL } from 'node:url';

const cli = discoverCli();
const source = await readFile(join(cli.packageDir, 'dist/modes/daemon/daemon-mode.js'), 'utf8');
const transformed = transformDaemonStream(source, { required: true });
const method = [
  ...transformed.source.matchAll(
    /^( +)writeSerialized\(client, line, message, payloadEncoding = "jsonl", snapshotPurpose\) \{[\s\S]*?^\1\}/gm,
  ),
][0][0];
const Writer = new Function(
  'encodePrivateFrame',
  'hasDaemonOutboundActiveSessionId',
  `return class { ${method} }`,
)(
  (_header, payload) => payload,
  () => false,
);
function client(role = 'supervisor', transport = 'private-framed') {
  return {
    authenticationRole: role,
    transport,
    backpressured: false,
    socket: {
      destroyed: false,
      writableLength: 20 * 1024,
      frames: [],
      write(data) {
        this.frames.push(data.toString());
        this.writableLength += Buffer.byteLength(data);
        return false;
      },
      destroy(error) {
        this.destroyed = true;
        this.error = error;
      },
    },
  };
}
test('authenticated private relay keeps live frames in order above the Node high-water mark', () => {
  const peer = client();
  const writer = new Writer();
  for (const text of ['start', 'result', 'end']) {
    assert.equal(
      peer.backpressured,
      false,
      'the native broadcaster must not divert the next event to a snapshot',
    );
    assert.equal(
      writer.writeSerialized(peer, text, { type: 'session_event', event: { type: 'message_end' } }),
      true,
      'queued frames are accepted, not silently discarded',
    );
  }
  assert.deepEqual(peer.socket.frames, ['start', 'result', 'end']);
  assert.equal(peer.backpressured, false);
});
test('untrusted, direct and public peers keep native backpressure behavior', () => {
  for (const peer of [
    client('session_client'),
    { ...client(), authenticationRole: undefined },
    client('supervisor', 'jsonl'),
  ]) {
    new Writer().writeSerialized(peer, 'event', { type: 'session_event', event: { type: 'message_end' } });
    assert.equal(peer.backpressured, true);
  }
});
test('private relay has a hard memory bound and refuses silent truncation', () => {
  const peer = client();
  peer.socket.writableLength = 16 * 1024 * 1024;
  assert.equal(
    new Writer().writeSerialized(peer, 'x', { type: 'session_event', event: { type: 'message_end' } }),
    false,
  );
  assert.equal(peer.socket.destroyed, true);
  assert.match(peer.socket.error.message, /16 MiB/);
  assert.deepEqual(peer.socket.frames, []);
});
test('stream adapter scopes source and bundle transforms and fails closed on changed layouts', async () => {
  assert.equal(transformed.changed, true);
  assert.equal(transformDaemonStream('export const unrelated = 1;').changed, false);
  assert.throws(
    () =>
      transformDaemonStream(source.replace('const accepted = client.socket.write(wireData);', 'changed();')),
    /layout changed/,
  );
  assert.throws(
    () =>
      transformDaemonStream(
        source.replaceAll(
          'writeSerialized(client, line, message, payloadEncoding = "jsonl", snapshotPurpose)',
          'writeChanged(client)',
        ),
      ),
    /layout changed/,
  );
  let count = 0;
  for (const name of await readdir(join(cli.packageDir, 'dist/bundle'))) {
    if (
      name.endsWith('.js') &&
      transformDaemonStream(await readFile(join(cli.packageDir, 'dist/bundle', name), 'utf8')).changed
    )
      count++;
  }
  assert.equal(count, 1);
  initialize({ packageRoot: cli.packageDir });
  const next = async () => ({ format: 'module', source });
  const outside = await load(pathToFileURL(join(cli.packageDir, '../outside.js')).href, {}, next);
  assert.equal(outside.source, source);
  const inside = await load(
    pathToFileURL(join(cli.packageDir, 'dist/modes/daemon/daemon-mode.js')).href,
    {},
    next,
  );
  assert.equal(inside.source, transformed.source);
  assert.equal(
    agentEnvironment({ env: { PRIME_STUDIO_RELAY_PACKAGE: 'foreign' } }).PRIME_STUDIO_RELAY_PACKAGE,
    undefined,
  );
});

const supervisorSource = await readFile(
  join(cli.packageDir, 'dist/modes/daemon/daemon-supervisor.js'),
  'utf8',
);
const supervisorTransformed = transformDaemonStream(supervisorSource, { supervisorRequired: true });
const supervisorMethod = [
  ...supervisorTransformed.source.matchAll(
    /^( +)writeSerialized\(client, line, studioSnapshot = false\) \{[\s\S]*?^\1\}/gm,
  ),
][0][0];
const SupervisorWriter = new Function(`return class { ${supervisorMethod} }`)();
test('Studio supervisor queues client events in order instead of dropping them under pressure', () => {
  const peer = client('supervisor', 'jsonl');
  const writer = new SupervisorWriter();
  for (const frame of ['image start', 'image end', 'question', 'result']) {
    assert.equal(writer.writeSerialized(peer, frame), true);
    assert.equal(peer.backpressured, false);
  }
  assert.deepEqual(peer.socket.frames, ['image start', 'image end', 'question', 'result']);
});
test('both snapshot producers still receive the drain signal and the public queue is bounded', () => {
  const workerPeer = client();
  assert.equal(new Writer().writeSerialized(workerPeer, 'chunk', { type: 'session_snapshot_chunk' }), false);
  const peer = client('supervisor', 'jsonl');
  assert.equal(new SupervisorWriter().writeSerialized(peer, 'chunk', true), false);
  assert.match(supervisorTransformed.source, /this\.writeSerialized\(client, buffer, true\)/);
  peer.socket.writableLength = 16 * 1024 * 1024;
  assert.equal(new SupervisorWriter().writeSerialized(peer, 'overflow'), false);
  assert.equal(peer.socket.destroyed, true);
  assert.deepEqual(peer.socket.frames, ['chunk']);
});
test('supervisor adapter fails closed if the native writer or snapshot drain contract changes', () => {
  assert.throws(
    () =>
      transformDaemonStream(
        supervisorSource.replace('const accepted = client.socket.write(line);', 'changed();'),
      ),
    /layout changed/,
  );
  assert.throws(
    () =>
      transformDaemonStream(supervisorSource.replace('this.writeSerialized(client, buffer)', 'changed()')),
    /layout changed/,
  );
});
