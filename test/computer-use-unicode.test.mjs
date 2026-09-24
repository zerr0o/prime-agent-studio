import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createComputerUseDriver } from '../lib/computer-use-driver.mjs';
import { createCuaComputerUseDriver } from '../lib/cua-computer-use-driver.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workerSource = readFileSync(join(here, '..', 'runtime', 'computer-use-worker.ps1'), 'utf8');

// Live evidence: typing "67 a 83 s ... Signe Claude" through the native
// backend arrived in Chrome as garbled OEM characters. UTF-8 bytes were
// decoded with the OEM code page. This probe covers every affected class:
// precomposed Latin, cedilla, ligature, euro sign and a surrogate pair.
const PROBE = 'Sign\u00e9 Claude: 67 \u00e0 83, fa\u00e7ade \u0153uvre \u00e0 3 \u20ac \u{1F600}';
const PROBE_POINTS = [...PROBE].map((ch) => ch.codePointAt(0));

function createFakeProcess() {
  const received = [];
  const child = new EventEmitter();
  child.pid = 71000 + Math.floor(Math.random() * 1000);
  child.exitCode = null;
  child.signalCode = null;
  const stdin = {
    written: [],
    encodings: [],
    write(line, encoding, callback) {
      if (typeof encoding === 'function') callback = encoding;
      stdin.written.push(String(line));
      stdin.encodings.push(typeof encoding === 'string' ? encoding : '');
      try {
        received.push(JSON.parse(String(line)));
      } catch {
        /* record raw only */
      }
      if (callback) setImmediate(() => callback(null));
      return true;
    },
    end() {
      setImmediate(() => {
        if (child.exitCode === null) {
          child.exitCode = 0;
          child.emit('exit', 0, null);
        }
      });
    },
  };
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    if (child.exitCode === null) {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    }
    return true;
  };
  const api = {
    child,
    received,
    stdin,
    spawn() {
      return child;
    },
    ready(extra = {}) {
      child.stdout.emit('data', `${JSON.stringify({ event: 'ready', pid: child.pid, ...extra })}\n`);
    },
    respond(id, result) {
      child.stdout.emit('data', `${JSON.stringify({ id, result })}\n`);
    },
  };
  return api;
}

async function tick(count = 1) {
  for (let i = 0; i < count; i++) await new Promise((done) => setImmediate(done));
}

test('native driver writes non-ASCII type text as UTF-8 bytes', async () => {
  const fake = createFakeProcess();
  const driver = createComputerUseDriver({
    platform: 'win32',
    spawnProcess: fake.spawn,
    workerPath: 'C:\\fake\\computer-use-worker.ps1',
    startupTimeoutMs: 2000,
    defaultTimeoutMs: 1000,
    stopTimeoutMs: 300,
  });
  try {
    const pending = driver.request({
      method: 'act',
      params: { actions: [{ type: 'type', text: PROBE }] },
    });
    await tick(3);
    fake.ready();
    const deadline = Date.now() + 1500;
    while (fake.received.length === 0 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 5));
    }
    assert.equal(fake.received.length, 1);
    const line = fake.received[0];
    assert.equal(line.params.actions[0].text, PROBE);
    // The raw pipe bytes are UTF-8: re-encoding the captured line must give
    // the exact byte length of a UTF-8 framing, and decoding those bytes as
    // UTF-8 must restore every code point.
    const rawLine = fake.stdin.written[0];
    assert.equal(fake.stdin.encodings[0], 'utf8');
    const bytes = Buffer.from(rawLine, 'utf8');
    assert.ok(bytes.length > rawLine.length, 'multibyte characters take extra bytes');
    const decoded = JSON.parse(bytes.toString('utf8'));
    assert.equal(decoded.params.actions[0].text, PROBE);
    assert.deepEqual(
      [...decoded.params.actions[0].text].map((ch) => ch.codePointAt(0)),
      PROBE_POINTS,
    );
    fake.respond(line.id, { executed: 1 });
    assert.deepEqual(await pending, { executed: 1 });
  } finally {
    await driver.close();
  }
});

test('UTF-8 bytes misread as single-byte OEM text garble the probe', () => {
  // Documents the root cause: Windows PowerShell used to decode stdin with
  // the OEM code page, so each multibyte UTF-8 sequence became two garbage
  // characters (live symptom: garbled text in Chrome). Latin-1 stands in for
  // the OEM page here: any single-byte decoding must NOT match the probe,
  // while UTF-8 decoding restores it exactly.
  const bytes = Buffer.from(JSON.stringify({ text: PROBE }), 'utf8');
  const garbled = JSON.parse(bytes.toString('latin1'));
  assert.notEqual(garbled.text, PROBE);
  assert.ok(garbled.text.includes('\u00c3'), 'multibyte head byte leaks through as garbage');
  const intact = JSON.parse(bytes.toString('utf8'));
  assert.equal(intact.text, PROBE);
  assert.deepEqual([...intact.text].map((ch) => ch.codePointAt(0)), PROBE_POINTS);
});

test('worker pins the stdin/stdout console encoding to UTF-8', () => {
  // Static guard for the root-cause fix: without an explicit UTF-8 console
  // input encoding the worker decodes the driver UTF-8 bytes as OEM text.
  assert.match(workerSource, /\[Console\]::InputEncoding\s*=.*UTF8/s);
  assert.match(workerSource, /\[Console\]::OutputEncoding\s*=.*UTF8/s);
});

function fakeCuaTransport() {
  const calls = [];
  const transport = {
    daemonPid: 6201,
    proxyPid: 6202,
    started: true,
    generation: 1,
    async start() {
      return { daemonPid: 6201, proxyPid: 6202, generation: 1 };
    },
    async callTool(name, args = {}) {
      calls.push({ name, args });
      if (name === 'get_desktop_state') {
        return {
          result: {
            content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }],
            structuredContent: {
              screenshot_width: 800,
              screenshot_height: 600,
              screen_width: 800,
              screen_height: 600,
              scale_factor: 1,
              platform: 'windows',
              display: 'primary',
              screenshot_mime_type: 'image/png',
            },
          },
          timing: { durationMs: 1 },
        };
      }
      return {
        result: { content: [{ type: 'text', text: 'acted' }], structuredContent: { effect: 'confirmed' } },
        timing: { durationMs: 1 },
      };
    },
    async stop(reason) {
      return { stopped: true, reason, treeExited: true };
    },
    async close() {},
  };
  return { transport, calls };
}

function fakeNativeGuardian() {
  return {
    async request(command) {
      if (command?.method === 'status') {
        return {
          supported: true,
          platform: 'win32',
          hotkey: 'Ctrl+Alt+Shift+F10',
          hotkeyRegistered: true,
          mutex: true,
          externalInputGuard: { supported: true, armed: false },
        };
      }
      if (command?.method === 'stop') return { stopped: true };
      if (command?.method === 'cleanup_external_input') return { cleaned: true };
      if (command?.method === 'disarm_external_input') return { disarmed: true };
      const error = new Error(`Unknown computer-use method: ${command?.method}.`);
      error.code = 'UNKNOWN_METHOD';
      throw error;
    },
    async stop(reason) {
      return { stopped: true, reason };
    },
    async close() {},
  };
}

test('CUA type_text forwards non-ASCII text with intact code points', async () => {
  // Read-only check of the CUA path: JSON-RPC stays UTF-8 end to end, so the
  // probe must reach the tool call byte-identical. No CUA file is changed.
  const fake = fakeCuaTransport();
  const driver = createCuaComputerUseDriver({
    platform: 'win32',
    arch: 'x64',
    sessionLabel: 'unicode-test',
    transport: fake.transport,
    createGuardian: async () => fakeNativeGuardian(),
    defaultTimeoutMs: 1500,
    stopTimeoutMs: 300,
  });
  try {
    const observed = await driver.request({ method: 'observe', params: {} });
    const acted = await driver.request({
      method: 'act',
      params: {
        actions: [{ type: 'type', text: PROBE }],
        expectedFrame: { driverFrame: observed.driverFrame },
      },
    });
    assert.equal(acted.executed, 1);
    const typeCall = fake.calls.find((c) => c.name === 'type_text');
    assert.ok(typeCall, 'type action maps to type_text');
    assert.equal(typeCall.args.text, PROBE);
    assert.deepEqual(
      [...typeCall.args.text].map((ch) => ch.codePointAt(0)),
      PROBE_POINTS,
    );
  } finally {
    await driver.close();
  }
});
