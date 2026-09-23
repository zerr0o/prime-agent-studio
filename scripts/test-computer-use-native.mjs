// Computer Use native integration proof: real installed Prime Agent,
// deterministic loopback vision fixture, FAKE desktop driver only.
// No real mouse, keyboard, screenshots, accounts or paid models.
// Temp agentHome/sessionDir/cwd, loopback port 0 providers, private daemon
// namespace owned by createAgentRuntime. Kills only exact test processes it
// created via runtime.close/bridge.close/provider.close. Synthetic PNG only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, sep, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime, discoverCli, agentEnvironment } from '../lib/agent.mjs';
import { createStore, validId, cwdKey } from '../lib/store.mjs';
import { createComputerUseManager } from '../lib/computer-use.mjs';
import { createComputerUseBridge, toPhysicalCoordinates } from '../lib/computer-use-bridge.mjs';

const EXPECTED_TOOLS = [
  'computer_status',
  'computer_windows',
  'computer_observe',
  'computer_inspect',
  'computer_act',
  'computer_release',
];
const FRAME_GEOM = {
  width: 400,
  height: 300,
  bounds: { x: 100, y: 80, width: 800, height: 600 },
};
const MODEL_X = 200;
const MODEL_Y = 150;
const EXPECTED_PHYSICAL = { x: 500, y: 380 };

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  return '';
}

function toolMessages(messages) {
  return (messages || []).filter((entry) => entry && entry.role === 'tool');
}

function lastToolText(messages) {
  const tools = toolMessages(messages);
  if (!tools.length) return '';
  return textOf(tools[tools.length - 1].content);
}

function parseFrameFromTools(messages) {
  for (let index = toolMessages(messages).length - 1; index >= 0; index -= 1) {
    const text = textOf(toolMessages(messages)[index].content);
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      const frame =
        parsed && parsed.frame
          ? parsed.frame
          : parsed && parsed.observe && parsed.observe.frame
            ? parsed.observe.frame
            : null;
      if (frame && typeof frame.frameId === 'string') return { parsed, frame };
    } catch {
      /* Not JSON, keep scanning older tool results. */
    }
  }
  return { parsed: null, frame: null };
}

function imageEvidence(messages, pngPrefix) {
  const flat = JSON.stringify(messages || []);
  const hasBase64 = typeof pngPrefix === 'string' && pngPrefix.length > 8 && flat.includes(pngPrefix);
  let hasImagePart = false;
  const partTypes = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string' && ['image_url', 'image', 'input_image'].includes(node.type)) {
      hasImagePart = true;
      partTypes.add(node.type);
    }
    if (typeof node.url === 'string' && node.url.startsWith('data:image/')) {
      hasImagePart = true;
      partTypes.add('data-url');
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) walk(item);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  for (const message of messages || []) walk(message);
  if (flat.includes('data:image/png;base64') || flat.includes('data:image/jpeg;base64')) {
    hasImagePart = true;
    partTypes.add('embedded-data-url');
  }
  return { hasBase64, hasImagePart, partTypes: [...partTypes] };
}

// Minimal deterministic PNG writer (truecolor, no external deps).
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1)
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function makeFixturePng(width, height) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 3;
      const shade = 190 + Math.round((30 * (x + y)) / (width + height));
      let r = shade;
      let g = shade;
      let b = 212;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        r = 40;
        g = 40;
        g = 40;
        b = 40;
      }
      if (Math.abs(x - MODEL_X) <= 2 || Math.abs(y - MODEL_Y) <= 2) {
        r = 220;
        g = 40;
        b = 40;
      }
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Fake desktop geometry shared by every minted worker instance. Production
// workers verify this natively before sending input; the fake enforces the
// same contract so forwarded expectedFrame guards are actually exercised.
const FAKE_DESKTOP_BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };
const FAKE_FOREGROUND_WINDOW = 'fake-main';
const FAKE_WINDOW = {
  id: 'fake-main',
  title: 'Fake App',
  processId: 1234,
  processName: 'fake.exe',
  bounds: { x: 100, y: 100, width: 800, height: 600 },
  foreground: true,
};

function sameRect(a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function createFakeDesktopDriver({ pngBase64 }) {
  /* stopReasons records every direct preempt/stop in order. */
  const calls = { status: 0, windows: [], observes: [], acts: [] };
  const stopReasons = [];
  let closed = false;
  return {
    calls,
    stopReasons,
    get stoppedReason() {
      return stopReasons.length > 0 ? stopReasons[stopReasons.length - 1] : null;
    },
    get closed() {
      return closed;
    },
    async request(command, { signal } = {}) {
      if (signal && signal.aborted) {
        const error = new Error('Fake driver operation cancelled.');
        error.name = 'AbortError';
        throw error;
      }
      const method = command && command.method;
      const params = (command && command.params) || {};
      if (closed) {
        const error = new Error('Fake worker is closed. A fresh worker must be spawned.');
        error.code = 'WORKER_EXIT';
        throw error;
      }
      if (method === 'status') {
        calls.status += 1;
        return {
          supported: true,
          platform: 'win32',
          hotkey: 'Ctrl+Alt+Shift+F10',
          fake: true,
          desktopBounds: { ...FAKE_DESKTOP_BOUNDS },
          foregroundWindowId: FAKE_FOREGROUND_WINDOW,
        };
      }
      if (method === 'windows') {
        calls.windows.push(params);
        const action = params.action === undefined ? 'list' : params.action;
        if (action === 'focus' && typeof params.windowId !== 'string') {
          const error = new Error('Focusing a window needs a windowId.');
          error.status = 400;
          throw error;
        }
        return {
          windows: [
            {
              id: 'fake-main',
              title: 'Fake App',
              processId: 1234,
              processName: 'fake.exe',
              bounds: { x: 100, y: 100, width: 800, height: 600 },
              foreground: true,
            },
          ],
          foreground: 'fake-main',
          fake: true,
        };
      }
      if (method === 'observe') {
        calls.observes.push(params);
        // Actual native shape: desktopBounds and foregroundWindowId live
        // top-level beside frame (nested copies are only a legacy fallback).
        return {
          image: { data: pngBase64, mimeType: 'image/png' },
          frame: {
            width: FRAME_GEOM.width,
            height: FRAME_GEOM.height,
            bounds: { ...FRAME_GEOM.bounds },
            capturedAt: new Date().toISOString(),
            windowId: FAKE_WINDOW.id,
          },
          desktopBounds: { ...FAKE_DESKTOP_BOUNDS },
          foregroundWindowId: FAKE_FOREGROUND_WINDOW,
          fake: true,
        };
      }
      if (method === 'act') {
        calls.acts.push(params);
        const expected = params.expectedFrame;
        if (expected !== undefined) {
          const problems = [];
          if (expected.windowId !== undefined && expected.windowId !== FAKE_WINDOW.id)
            problems.push('windowId');
          if (expected.bounds !== undefined && !sameRect(expected.bounds, FRAME_GEOM.bounds))
            problems.push('bounds');
          if (expected.desktopBounds !== undefined && !sameRect(expected.desktopBounds, FAKE_DESKTOP_BOUNDS))
            problems.push('desktopBounds');
          if (
            expected.foregroundWindowId !== undefined &&
            expected.foregroundWindowId !== FAKE_FOREGROUND_WINDOW
          )
            problems.push('foregroundWindowId');
          if (expected.requireForeground === true && FAKE_FOREGROUND_WINDOW !== FAKE_WINDOW.id)
            problems.push('requireForeground');
          if (problems.length > 0) {
            const error = new Error('Fake desktop changed: ' + problems.join(',') + '.');
            error.code = 'STALE_FRAME';
            throw error;
          }
        }
        const count = Array.isArray(params.actions) ? params.actions.length : 0;
        return { executed: count, fake: true };
      }
      const error = new Error('Unknown fake driver method ' + String(method));
      error.status = 400;
      throw error;
    },
    async stop(reason = 'user') {
      stopReasons.push(reason);
    },
    async close() {
      closed = true;
    },
  };
}

async function readSessionHeader(file, roots) {
  const denied = () =>
    Object.assign(new Error('Test caller is not an active native session.'), { status: 403 });
  if (typeof file !== 'string' || !isAbsolute(file) || file.length > 32768) throw denied();
  const actual = await realpath(file).catch(() => null);
  if (!actual) throw denied();
  const key = (value) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
  if (key(actual) !== key(file)) throw denied();
  if (!roots.some((root) => key(actual).startsWith(key(root) + sep))) throw denied();
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

function createTestCallerResolver({ getRuns, store, agentHome, sessionDir }) {
  let ledger;
  const liveEdges = async () => {
    if (!ledger) {
      const { discoverCli: discover } = await import('../lib/agent.mjs');
      const cli = discover();
      if (!cli || !cli.packageDir) throw new Error('Test caller needs the installed engine package.');
      const { RlmSpawnLedger } = await import(
        (await import('node:url')).pathToFileURL(
          (await import('node:path')).join(cli.packageDir, 'dist/modes/daemon/rlm-ledger.js'),
        ).href
      );
      ledger = new RlmSpawnLedger(agentHome, sessionDir);
    }
    return ledger.liveEdges();
  };
  const denied = () =>
    Object.assign(new Error('This agent no longer owns an active Studio session.'), { status: 403 });
  return async (identity) => {
    if (
      !identity ||
      typeof identity !== 'object' ||
      !validId(identity.sessionId) ||
      !isAbsolute(identity.cwd || '')
    )
      throw denied();
    const project = await store.findProject(identity.cwd);
    const roots = [sessionDir, join(agentHome, 'session-artifacts')];
    const own = await readSessionHeader(identity.sessionFile, roots).catch(() => {
      throw denied();
    });
    if (own.id !== identity.sessionId) throw denied();
    if (cwdKey(own.cwd) !== cwdKey(identity.cwd)) throw denied();
    if (cwdKey(project.cwd) !== cwdKey(own.cwd)) throw denied();
    const matching = () =>
      getRuns().filter((run) => run && run.status === 'running' && cwdKey(run.cwd) === cwdKey(own.cwd));
    const direct = matching().find((run) => run.sessionId === own.id);
    if (direct)
      return {
        cwd: project.cwd,
        sessionId: own.id,
        rootSessionId: own.id,
        ownerId: direct.id,
        name: 'Prime Agent',
      };
    const edges = await liveEdges().catch(() => []);
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
    let current = own;
    let ownEdge = null;
    let parentSessionId = null;
    const visited = new Set();
    for (let depth = 0; depth < 32; depth += 1) {
      const key = cwdKey(current.file);
      if (visited.has(key)) throw denied();
      visited.add(key);
      const edge = byChild.get(key);
      if (!edge) throw denied();
      if (!ownEdge) ownEdge = edge;
      current = await readSessionHeader(edge.parent, roots).catch(() => {
        throw denied();
      });
      if (cwdKey(current.cwd) !== cwdKey(own.cwd)) throw denied();
      if (!parentSessionId) parentSessionId = current.id;
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

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROOF_ROOT = resolve(join(SCRIPT_DIR, '..'));
const COMPUTER_EXTENSION = join(SCRIPT_DIR, '..', 'runtime', 'studio-computer-use-extension.mjs');

// The shell that launches this proof may carry another Studio install's
// loader hooks in NODE_OPTIONS. Test-owned engine children must load only
// this checkout's runtime hooks (createAgentRuntime appends them itself), so
// foreign Studio loader entries are stripped when building the child env.
// This only shapes the env object passed to exact test child processes. It
// never edits loader files, the installed engine, or the current server.
function sanitizeChildNodeOptions(value, root) {
  if (!value) return value;
  const rootKey = resolve(root).toLowerCase();
  const tokens = String(value).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const kept = tokens.filter((token) => {
    const flag = token.replace(/^["']|["']$/g, '');
    if (!flag.startsWith('--import=') && !flag.startsWith('--require=')) return true;
    const rawTarget = flag
      .slice(flag.indexOf('=') + 1)
      .replace(/^["']|["']$/g, '')
      .replace(/^file:\/\//, '')
      .replace(/^\/([A-Za-z]:[\/\\])/, '$1');
    const lowered = rawTarget.replaceAll('/', '\\').toLowerCase();
    const looksStudioLoader =
      lowered.includes('studio\\runtime\\') || /[-_](loader|hook)\.(mjs|cjs)$/.test(lowered);
    if (!looksStudioLoader) return true;
    try {
      if (resolve(rawTarget).toLowerCase().startsWith(rootKey)) return true;
    } catch {
      /* Unresolvable loader targets are dropped. */
    }
    return false;
  });
  return kept.join(' ');
}

function testChildEnv() {
  const env = { ...process.env, PRIME_AGENT_TELEMETRY: '0' };
  env.NODE_OPTIONS = sanitizeChildNodeOptions(env.NODE_OPTIONS, PROOF_ROOT);
  if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  return env;
}

function startDirectCli({
  label,
  entry,
  cwd,
  agentHome,
  sessionDir,
  bridgeConfig,
  run,
  events,
  resume = null,
}) {
  const env = agentEnvironment({ agentHome, sessionDir, env: testChildEnv() });
  env.PRIME_STUDIO_COMPUTER_USE_CONFIG = JSON.stringify(bridgeConfig);
  const args = [
    '-p',
    '--mode',
    'json',
    '--cwd',
    cwd,
    '--session-dir',
    sessionDir,
    '--extension',
    COMPUTER_EXTENSION,
    '--model',
    'fixture/computer',
    '--thinking',
    'off',
  ];
  if (resume) args.push('--resume', resume);
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env,
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event && event.type === 'session' && typeof event.id === 'string') run.sessionId = event.id;
        events.push({ kind: event.type || 'event', id: event.id || null });
      } catch {
        events.push({ kind: 'stdout', text: line.slice(0, 300) });
      }
    }
    if (buffer.length > 4 * 1024 * 1024) buffer = buffer.slice(-1024);
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8000);
  });
  const done = new Promise((resolveDone) => {
    child.on('close', (code, signal) => resolveDone({ code, signal, stderr }));
    child.on('error', (error) =>
      resolveDone({ code: -1, error: String(error && error.message ? error.message : error), stderr }),
    );
  });
  child.stdin.on('error', () => {});
  child.stdin.end('Prove Computer Use tools with the fake desktop driver. Start with status, then observe.');
  return { child, done };
}

async function runPhase({ label, interactive, pngBase64, pngPrefix, resultsDir, engineMode = 'runtime' }) {
  const phaseRoot = await mkdtemp(join(tmpdir(), 'prime-computer-native-' + label + '-'));
  const cwd = join(phaseRoot, 'project');
  const agentHome = join(phaseRoot, 'agent');
  const sessionDir = join(agentHome, 'sessions');
  const dataDir = join(phaseRoot, 'studio');
  await Promise.all([cwd, sessionDir].map((path) => mkdir(path, { recursive: true })));
  const store = createStore({ sessionDir, dataDir });
  await store.project({ cwd });
  const run = {
    id:
      label === 'headless' ? '11111111-2222-4333-8444-555555555555' : 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    sessionId: null,
    cwd,
    status: 'running',
  };
  // Production factories mint a fresh worker per lease and closed workers
  // reject every request. The fake mirrors that: one factory, one new
  // instance per call, shared aggregate log plus per-instance call records.
  const driverInstances = [];
  const createDriver = () => {
    const instance = createFakeDesktopDriver({ pngBase64 });
    instance.instanceId = driverInstances.length;
    driverInstances.push(instance);
    return instance;
  };
  const manager = createComputerUseManager({ createDriver, isSupported: true });
  const totals = () => {
    const out = { status: 0, windows: 0, observes: 0, acts: 0 };
    for (const instance of driverInstances) {
      out.status += instance.calls.status;
      out.windows += instance.calls.windows.length;
      out.observes += instance.calls.observes.length;
      out.acts += instance.calls.acts.length;
    }
    return out;
  };
  const bridge = createComputerUseBridge({
    manager,
    resolveCaller: createTestCallerResolver({ getRuns: () => [run], store, agentHome, sessionDir }),
    isOwnerActive: (id) => run.id === id && run.status === 'running',
  });
  await bridge.ready;
  const calls = [];
  const requests = [];
  const events = [];
  const stage = new Map();
  const evidence = { imageStages: [], mapping: null, toolDiscovery: null };
  let runtime = null;
  let observedFrameId = null;
  const RUN2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const RUN3 = 'cccccccc-dddd-4eee-8fff-000000000000';
  let resumeArmed = false;
  let resumeStep = 0;

  async function ensureEnabled() {
    const deadline = Date.now() + 15000;
    while (!run.sessionId && Date.now() < deadline) await sleep(50);
    assert.ok(run.sessionId, label + ': native session id was not assigned before enable');
    const current = manager.status({ sessionId: run.sessionId });
    if (!current.enabled) {
      await manager.enable({
        sessionId: run.sessionId,
        runId: run.id,
        cwd,
        name: 'native-proof-' + label,
        imageCapable: true,
        model: 'fixture/computer',
      });
      calls.push(label + ':test-enabled-lease');
    }
  }

  const provider = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const role = body.model || 'computer';
      requests.push(body);
      const names = (body.tools || []).map((tool) => tool.function.name);
      for (const name of EXPECTED_TOOLS)
        assert.ok(names.includes(name), label + ' ' + role + ': tool ' + name + ' was not discovered');
      if (resumeArmed) {
        let tool = null;
        if (resumeStep === 0) tool = { name: 'computer_status', arguments: {} };
        else if (resumeStep === 1) {
          const text = lastToolText(body.messages);
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          assert.ok(
            parsed && parsed.enabled === true,
            label + ': resumed status must report enabled, got ' + text.slice(0, 300),
          );
          assert.ok(
            parsed.owner && parsed.owner.runId === RUN2,
            label + ': resumed status must bind the new run',
          );
          calls.push(label + ':resume-status-verified');
        } else {
          calls.push(label + ':resume-finished');
        }
        resumeStep += 1;
        if (tool) calls.push(label + ':' + tool.name + '-resume');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const resumeFrame = (delta, finishReason = null) =>
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'message-' + requests.length,
                object: 'chat.completion.chunk',
                created: 1,
                model: role,
                choices: [{ index: 0, delta, finish_reason: finishReason }],
              }) +
              '\n\n',
          );
        resumeFrame({ role: 'assistant' });
        if (tool) {
          resumeFrame({
            tool_calls: [
              {
                index: 0,
                id: role + '-resume-' + resumeStep,
                type: 'function',
                function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
              },
            ],
          });
          resumeFrame({}, 'tool_calls');
        } else {
          resumeFrame({ content: 'Resumed session verified.' });
          resumeFrame({}, 'stop');
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      if (!evidence.toolDiscovery)
        evidence.toolDiscovery = {
          count: names.length,
          computerTools: EXPECTED_TOOLS.filter((name) => names.includes(name)),
        };
      const step = stage.get(role) || 0;
      let tool = null;
      if (step === 0) {
        tool = { name: 'computer_status', arguments: {} };
      } else if (step === 1) {
        const text = lastToolText(body.messages);
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed.enabled === 'boolean') {
          assert.equal(parsed.enabled, false, label + ': status must report disabled before enable');
          calls.push(label + ':status-disabled-json');
        } else {
          assert.match(
            text,
            /off|Enable it in Studio/i,
            label + ': disabled status must refuse with enable hint, got ' + text.slice(0, 300),
          );
          calls.push(label + ':status-disabled-refusal');
        }
        tool = { name: 'computer_observe', arguments: {} };
      } else if (step === 2) {
        const text = lastToolText(body.messages);
        assert.match(
          text,
          /off|Enable it in Studio/i,
          label + ': disabled observe must refuse with enable hint, got ' + text.slice(0, 300),
        );
        calls.push(label + ':observe-disabled-refusal');
        await ensureEnabled();
        tool = { name: 'computer_status', arguments: {} };
      } else if (step === 3) {
        const text = lastToolText(body.messages);
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        assert.ok(
          parsed && parsed.enabled === true,
          label + ': enabled status must report enabled JSON, got ' + text.slice(0, 300),
        );
        assert.ok(
          parsed.owner && parsed.owner.runId === run.id,
          label + ': enabled status must bind the test run owner',
        );
        calls.push(label + ':status-enabled-json');
        tool = { name: 'computer_observe', arguments: { windowId: FAKE_WINDOW.id, maxWidth: 800 } };
      } else if (step === 4) {
        const found = parseFrameFromTools(body.messages);
        assert.ok(found.frame, label + ': enabled observe must return frame metadata');
        assert.equal(found.frame.width, FRAME_GEOM.width, label + ': frame width must match fake driver');
        assert.equal(found.frame.height, FRAME_GEOM.height, label + ': frame height must match fake driver');
        assert.equal(found.frame.windowId, FAKE_WINDOW.id, label + ': frame must carry the fake window id');
        assert.deepEqual(
          found.frame.desktopBounds,
          FAKE_DESKTOP_BOUNDS,
          label + ': frame must carry fake desktop bounds',
        );
        assert.equal(
          found.frame.foregroundWindowId,
          FAKE_FOREGROUND_WINDOW,
          label + ': frame must carry the fake foreground window',
        );
        observedFrameId = found.frame.frameId;
        assert.ok(observedFrameId, label + ': frameId is required for act');
        const seen = imageEvidence(body.messages, pngPrefix);
        evidence.imageStages.push({ stage: 'after-observe', ...seen });
        assert.ok(seen.hasBase64, label + ': observe pixels must reach the next model request');
        assert.ok(
          seen.hasImagePart,
          label +
            ': observe must arrive as an image part, not JSON text only. parts=' +
            seen.partTypes.join(','),
        );
        calls.push(label + ':observe-image-in-request');
        tool = {
          name: 'computer_windows',
          arguments: { action: 'wait', processName: 'FAKE', title: 'fake app', timeoutMs: 1000 },
        };
      } else if (step === 5) {
        const text = lastToolText(body.messages);
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        const windows = (parsed && parsed.windows) || [];
        assert.ok(
          windows.some((entry) => entry && entry.id === 'fake-main'),
          label + ': windows list must return the fake driver window, got ' + text.slice(0, 300),
        );
        assert.equal(parsed.found, true, label + ': bounded window wait must find the fake app');
        assert.equal(parsed.timedOut, false);
        assert.equal(parsed.window.id, FAKE_WINDOW.id);
        assert.match(parsed.note, /does not confirm application readiness/);
        evidence.windowWait = parsed;
        calls.push(label + ':window-wait-verified');
        tool = {
          name: 'computer_act',
          arguments: {
            frameId: observedFrameId,
            actions: [{ type: 'click', x: MODEL_X, y: MODEL_Y }],
            observeAfter: true,
            ...(interactive ? { observeOptions: { windowId: FAKE_WINDOW.id, maxWidth: 1024 } } : {}),
          },
        };
      } else if (step === 6) {
        const text = lastToolText(body.messages);
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        assert.ok(
          parsed && (parsed.executed === 1 || parsed.observe),
          label + ': act must report execution, got ' + text.slice(0, 300),
        );
        assert.equal(
          totals().acts,
          1,
          label + ': fake workers must receive exactly one act batch in aggregate',
        );
        assert.equal(
          parsed.applicationState,
          'unverified',
          label + ': sent input is not application readiness',
        );
        const captureOptions = { windowId: FAKE_WINDOW.id, maxWidth: interactive ? 1024 : 800 };
        assert.deepEqual(
          driverInstances.flatMap((instance) => instance.calls.observes).at(-1),
          captureOptions,
        );
        assert.deepEqual(parsed.frame.captureOptions, captureOptions);
        evidence.verificationCapture = { captureOptions, applicationState: parsed.applicationState };
        const actCall = driverInstances.flatMap((instance) => instance.calls.acts)[0];
        const received = actCall.actions[0];
        assert.equal(received.x, EXPECTED_PHYSICAL.x, label + ': screenshot x must map to physical x');
        assert.equal(received.y, EXPECTED_PHYSICAL.y, label + ': screenshot y must map to physical y');
        assert.deepEqual(
          actCall.expectedFrame,
          {
            windowId: FAKE_WINDOW.id,
            bounds: FRAME_GEOM.bounds,
            desktopBounds: FAKE_DESKTOP_BOUNDS,
            foregroundWindowId: FAKE_FOREGROUND_WINDOW,
            requireForeground: false,
          },
          label + ': bridge must forward the observed geometry as expectedFrame',
        );
        evidence.mapping = { sent: { x: MODEL_X, y: MODEL_Y }, received: { x: received.x, y: received.y } };
        evidence.expectedFrame = actCall.expectedFrame;
        const seen = imageEvidence(body.messages, pngPrefix);
        evidence.imageStages.push({ stage: 'after-act-observeAfter', ...seen });
        assert.ok(
          seen.hasBase64 && seen.hasImagePart,
          label + ': verification screenshot must reach the model as image',
        );
        calls.push(label + ':act-frame-mapped');
        tool = { name: 'computer_release', arguments: {} };
      } else if (step === 7) {
        const text = lastToolText(body.messages);
        const parsed = JSON.parse(text);
        assert.equal(parsed.released, true, label + ': release must confirm');
        calls.push(label + ':release');
      } else {
        calls.push(label + ':finished');
      }
      stage.set(role, step + 1);
      if (tool) calls.push(label + ':' + tool.name);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (delta, finishReason = null) =>
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'message-' + requests.length,
              object: 'chat.completion.chunk',
              created: 1,
              model: role,
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            }) +
            '\n\n',
        );
      frame({ role: 'assistant' });
      if (tool) {
        frame({
          tool_calls: [
            {
              index: 0,
              id: role + '-' + step,
              type: 'function',
              function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
            },
          ],
        });
        frame({}, 'tool_calls');
      } else {
        frame({ content: 'Computer Use native integration verified in ' + label + ' mode.' });
        frame({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      calls.push({
        error: label + ' provider: ' + String(error && error.message ? error.message : error).slice(0, 500),
      });
      try {
        res.writeHead(500);
        res.end(String(error && error.message ? error.message : error).slice(0, 2000));
      } catch {
        /* Provider errors are recorded in calls for diagnostics. */
      }
    }
  });
  await new Promise((done) => provider.listen(0, '127.0.0.1', done));
  const port = provider.address().port;
  const settings = JSON.stringify({
    defaultProvider: 'fixture',
    defaultModel: 'computer',
    defaultThinkingLevel: 'off',
    autoRefine: { enabled: false },
    compaction: { enabled: false },
    retry: { enabled: false },
    telemetry: { enabled: false, noticeShown: true },
  });
  await writeFile(join(agentHome, 'auth.json'), '{}');
  await writeFile(join(agentHome, 'settings.json'), settings);
  await writeFile(
    join(agentHome, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:' + port + '/v1',
          apiKey: 'fixture-only',
          models: [
            {
              id: 'computer',
              name: 'Computer fixture',
              reasoning: false,
              input: ['text', 'image'],
              contextWindow: 131072,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  let handle = null;
  let direct = null;
  let resumeHandle = null;
  try {
    let done;
    if (engineMode === 'direct') {
      direct = startDirectCli({
        label,
        entry: cli.launchPath ?? cli.path,
        cwd,
        agentHome,
        sessionDir,
        bridgeConfig: bridge.config,
        run,
        events,
      });
      handle = { pid: direct.child.pid, daemonPid: null };
      let timer;
      const outcome = await Promise.race([
        direct.done,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try {
              direct.child.kill('SIGKILL');
            } catch {
              /* Timeout kill targets only the exact test child. */
            }
            reject(new Error(label + ' direct run timed out after 120s'));
          }, 120000);
        }),
      ]).finally(() => clearTimeout(timer));
      assert.equal(outcome.code, 0, label + ' direct CLI exit: ' + JSON.stringify(outcome).slice(0, 1000));
      done = { status: 'completed' };
    } else {
      runtime = createAgentRuntime({
        agentHome,
        sessionDir,
        computer: { config: bridge.config },
        env: testChildEnv(),
      });
      handle = await runtime.start({
        cwd,
        message: 'Prove Computer Use tools with the fake desktop driver. Start with status, then observe.',
        model: 'fixture/computer',
        thinking: 'off',
        allowQuestions: interactive,
        onEvent: (event) => {
          events.push(event);
          if (event && event.kind === 'session' && event.sessionId) run.sessionId = event.sessionId;
        },
      });
      let timer;
      done = await Promise.race([
        handle.done,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + ' native run timed out after 120s')), 120000);
        }),
      ]).finally(() => clearTimeout(timer));
    }
    const providerErrors = calls.filter((entry) => entry && entry.error);
    assert.deepEqual(
      providerErrors,
      [],
      label + ' provider errors: ' + JSON.stringify(providerErrors).slice(0, 2000),
    );
    assert.equal(done.status, 'completed', label + ' run status: ' + JSON.stringify(done).slice(0, 500));
    assert.ok(
      calls.includes(label + ':status-disabled-json') || calls.includes(label + ':status-disabled-refusal'),
      label + ' missing disabled status proof in ' + JSON.stringify(calls).slice(0, 2000),
    );
    for (const expected of [
      label + ':observe-disabled-refusal',
      label + ':status-enabled-json',
      label + ':observe-image-in-request',
      label + ':window-wait-verified',
      label + ':act-frame-mapped',
      label + ':release',
    ])
      assert.ok(
        calls.includes(expected),
        label + ' missing model check ' + expected + ' in ' + JSON.stringify(calls).slice(0, 2000),
      );
    assert.ok(manager.status().enabled, label + ': lease must still be enabled before stop test');
    assert.ok(driverInstances.length >= 1, label + ': at least one fake worker must serve the model turn');
    const actWorkers = driverInstances.filter((instance) => instance.calls.acts.length > 0);
    assert.equal(actWorkers.length, 1, label + ': exactly one fake worker must execute the act batch');
    const firstWorker = driverInstances[0];
    const staleBefore = manager.takeFrame(observedFrameId);
    assert.ok(
      !staleBefore || staleBefore.frameId === observedFrameId,
      label + ': release must clear the acted frame',
    );
    const stopped = await manager.stop('native-proof-' + label);
    assert.equal(stopped.enabled, false, label + ': stop must disable the lease');
    assert.equal(stopped.owner, null, label + ': stop must clear the owner');
    assert.equal(manager.takeFrame(observedFrameId), null, label + ': stop must invalidate frames');
    assert.ok(
      firstWorker.stopReasons.includes('release'),
      label + ': release must preempt the fake worker through the direct stop channel',
    );
    assert.equal(firstWorker.closed, true, label + ': stop must close the fake worker');
    calls.push(label + ':stop-disable');
    await assert.rejects(
      firstWorker.request({ method: 'status', params: {} }),
      /closed/,
      label + ': a closed fake worker must reject new requests',
    );
    calls.push(label + ':closed-worker-rejects');
    await manager.enable({
      sessionId: run.sessionId,
      runId: RUN2,
      cwd,
      name: 'rebind-check',
      imageCapable: true,
      model: 'fixture/computer',
    });
    const instancesBeforeRebind = driverInstances.length;
    const secondWorker = await manager.driver();
    assert.notEqual(secondWorker, firstWorker, label + ': re-enable must mint a fresh fake worker');
    assert.ok(
      driverInstances.length > instancesBeforeRebind,
      label + ': factory must mint a new instance after teardown',
    );
    assert.equal(secondWorker.closed, false, label + ': the fresh worker must be usable');
    const statusAgain = await secondWorker.request({ method: 'status', params: {} });
    assert.equal(statusAgain.supported, true, label + ': the fresh worker must serve requests');
    await assert.rejects(
      secondWorker.request({
        method: 'act',
        params: {
          actions: [{ type: 'click', x: 500, y: 380 }],
          expectedFrame: {
            desktopBounds: { x: 1, y: 2, width: 3, height: 4 },
            foregroundWindowId: 'elsewhere',
          },
        },
      }),
      /STALE_FRAME|changed/,
      label + ': tampered geometry must fail the native guard',
    );
    const guardedAct = await secondWorker.request({
      method: 'act',
      params: {
        actions: [{ type: 'click', x: 500, y: 380 }],
        expectedFrame: {
          windowId: FAKE_WINDOW.id,
          bounds: { ...FRAME_GEOM.bounds },
          desktopBounds: { ...FAKE_DESKTOP_BOUNDS },
          foregroundWindowId: FAKE_FOREGROUND_WINDOW,
          requireForeground: false,
        },
      },
    });
    assert.equal(guardedAct.executed, 1, label + ': matching geometry must pass the native guard');
    calls.push(label + ':fresh-lifecycle-guards');
    run.id = RUN2;
    resumeArmed = true;
    resumeHandle = null;
    if (engineMode === 'direct') {
      const resumed = startDirectCli({
        label,
        entry: cli.launchPath ?? cli.path,
        cwd,
        agentHome,
        sessionDir,
        bridgeConfig: bridge.config,
        run,
        events,
        resume: run.sessionId,
      });
      resumeHandle = resumed;
      let resumeTimer;
      const resumeOutcome = await Promise.race([
        resumed.done,
        new Promise((_, reject) => {
          resumeTimer = setTimeout(() => {
            try {
              resumed.child.kill('SIGKILL');
            } catch {
              /* Timeout kill targets only the exact test child. */
            }
            reject(new Error(label + ' resume turn timed out after 60s'));
          }, 60000);
        }),
      ]).finally(() => clearTimeout(resumeTimer));
      assert.equal(
        resumeOutcome.code,
        0,
        label + ' resume CLI exit: ' + JSON.stringify(resumeOutcome).slice(0, 1000),
      );
    } else {
      resumeHandle = await runtime.start({
        cwd,
        sessionId: run.sessionId,
        message: 'Confirm Computer Use status on the resumed session.',
        model: 'fixture/computer',
        thinking: 'off',
        ...(interactive ? { allowQuestions: true } : {}),
        onEvent: (event) => {
          events.push(event);
        },
      });
      let resumeTimer;
      const resumeDone = await Promise.race([
        resumeHandle.done,
        new Promise((_, reject) => {
          resumeTimer = setTimeout(
            () => reject(new Error(label + ' resume turn timed out after 60s')),
            60000,
          );
        }),
      ]).finally(() => clearTimeout(resumeTimer));
      assert.equal(
        resumeDone.status,
        'completed',
        label + ' resume status: ' + JSON.stringify(resumeDone).slice(0, 500),
      );
    }
    assert.ok(
      calls.includes(label + ':resume-status-verified'),
      label + ' resume turn must verify the rebound lease',
    );
    assert.equal(firstWorker.closed, true, label + ': the stopped worker must stay closed across resume');
    assert.ok(
      secondWorker.closed === false ||
        driverInstances.some((instance) => instance !== firstWorker && !instance.closed),
      label + ': resume must be served by a live worker, never the closed one',
    );
    calls.push(label + ':resume-new-lifecycle');
    await manager.releaseRun(RUN2);
    assert.equal(manager.status().enabled, false, label + ': run completion must release the controller');
    await manager.noteRunStarted({ runId: RUN3, sessionId: run.sessionId, cwd });
    assert.equal(
      manager.status({ sessionId: run.sessionId }).enabled,
      true,
      label + ': same session next turn must rebind',
    );
    await manager.disable({ sessionId: run.sessionId });
    assert.equal(
      manager.status({ sessionId: run.sessionId }).enabled,
      false,
      label + ': disable must clear the session',
    );
    calls.push(label + ':restart-session-rebind');
    for (const expected of [
      label + ':stop-disable',
      label + ':closed-worker-rejects',
      label + ':fresh-lifecycle-guards',
      label + ':resume-status-verified',
      label + ':resume-new-lifecycle',
      label + ':restart-session-rebind',
    ])
      assert.ok(
        calls.includes(expected),
        label + ' missing harness check ' + expected + ' in ' + JSON.stringify(calls).slice(0, 2000),
      );
    assert.equal(
      await readFile(join(agentHome, 'settings.json'), 'utf8'),
      settings,
      label + ': native settings must remain unchanged',
    );
    return {
      label,
      interactive,
      engineMode,
      passed: true,
      calls,
      evidence,
      sessionId: run.sessionId,
      pid: handle.pid,
      daemonPid: handle.daemonPid,
      root: phaseRoot,
      requestCount: requests.length,
      driver: {
        instances: driverInstances.length,
        ...totals(),
        perInstance: driverInstances.map((instance) => ({
          id: instance.instanceId,
          closed: instance.closed,
          stoppedReason: instance.stoppedReason,
          status: instance.calls.status,
          windows: instance.calls.windows.length,
          observes: instance.calls.observes.length,
          acts: instance.calls.acts.length,
        })),
      },
    };
  } finally {
    run.status = 'completed';
    const resumeOwned =
      typeof resumeHandle !== 'undefined' && resumeHandle && resumeHandle.child ? resumeHandle : null;
    for (const owned of [direct, resumeOwned]) {
      try {
        if (owned && owned.child.exitCode === null && owned.child.signalCode === null)
          owned.child.kill('SIGKILL');
      } catch {
        /* Direct child cleanup targets only the exact test process. */
      }
    }
    try {
      await runtime?.close();
    } catch {
      /* Runtime close is best effort after assertions. */
    }
    try {
      await bridge.close();
    } catch {
      /* Bridge close is best effort after assertions. */
    }
    await new Promise((doneClose) => {
      try {
        provider.closeAllConnections?.();
      } catch {
        /* Older Node has no closeAllConnections. */
      }
      provider.close(doneClose);
    });
  }
}

const cli = discoverCli();
console.log(
  JSON.stringify({
    engine: cli
      ? { path: cli.path, launchPath: cli.launchPath, version: cli.version, packageDir: cli.packageDir }
      : null,
  }),
);
if (!cli || !cli.packageDir) {
  console.error('Prime Agent engine was not found. Set PRIME_AGENT_CLI to the installed cli.js.');
  process.exit(1);
}

const pngBytes = makeFixturePng(FRAME_GEOM.width, FRAME_GEOM.height);
const pngBase64 = pngBytes.toString('base64');
const pngPrefix = pngBase64.slice(0, 48);
const expectedMappingCheck = toPhysicalCoordinates({ type: 'click', x: MODEL_X, y: MODEL_Y }, FRAME_GEOM);
assert.equal(
  Math.round(expectedMappingCheck.x),
  EXPECTED_PHYSICAL.x,
  'Test geometry must map center to expected physical x',
);
assert.equal(
  Math.round(expectedMappingCheck.y),
  EXPECTED_PHYSICAL.y,
  'Test geometry must map center to expected physical y',
);

const resultsDir = resolve('test-results/computer-use');
await mkdir(resultsDir, { recursive: true });
await writeFile(join(resultsDir, 'native-frame.png'), pngBytes);

const summary = {
  startedAt: new Date().toISOString(),
  engine: { path: cli.path, version: cli.version },
  kernelPython: process.env.PRIME_AGENT_KERNEL_PYTHON || null,
  geometry: { sent: { x: MODEL_X, y: MODEL_Y }, expectedPhysical: EXPECTED_PHYSICAL, frame: FRAME_GEOM },
  pngBytes: pngBytes.length,
  pngBase64Length: pngBase64.length,
  phases: [],
  checks: [],
  blocked: [],
  partial: null,
  partialChecks: [],
};
const ADAPTER_BLOCK_PATTERN = /adaptateur du Studio|transformSessionPreferences|session preference only/;
function blockedReason(error) {
  const stack = String(error && error.stack ? error.stack : error);
  if (!ADAPTER_BLOCK_PATTERN.test(stack)) return null;
  return stack.slice(0, 1500);
}

const MANDATORY_CHECKS = [
  'six computer tools discovered by the real engine (status, windows, observe, inspect, act, release)',
  'disabled status reports enabled false, disabled observe refuses with enable hint',
  'enabled status returns owner binding, enabled observe pixels arrive in the next model request as an image part',
  'bounded window wait returns the fake driver window without implying application readiness',
  'frame mapped click reaches a fake worker in physical pixels with forwarded expectedFrame guards',
  'observeAfter preserves or overrides capture scope, reports unverified application state, and returns image; release confirms',
  'stop closes the worker, closed workers reject, re-enable mints a fresh worker with enforced guards',
  'resume turn on the same session verifies the rebound lease on a live worker',
  'run completion releases controller, same session rebinds, disable clears',
];

const proofStart = Date.now();
const PROOF_BUDGET_MS = 9 * 60 * 1000;
function withBudget(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    const left = PROOF_BUDGET_MS - (Date.now() - proofStart);
    timer = setTimeout(
      () => reject(new Error(label + ' exceeded the overall native proof budget')),
      Math.max(1, left),
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let headlessResult = null;
try {
  headlessResult = await withBudget(
    runPhase({ label: 'headless', interactive: false, pngBase64, pngPrefix, resultsDir }),
    'headless',
  );
  summary.phases.push({ ...headlessResult, evidence: headlessResult.evidence });
  for (const check of MANDATORY_CHECKS) summary.checks.push('Headless: ' + check);
} catch (error) {
  const blocked = blockedReason(error);
  summary.phases.push({
    label: 'headless',
    passed: false,
    ...(blocked
      ? { blocked: blocked.slice(0, 1000) }
      : { error: String(error && error.stack ? error.stack : error).slice(0, 4000) }),
  });
  if (blocked) summary.blocked.push('headless: ' + blocked.slice(0, 300));
  else console.error('Headless phase failed:', error);
}

let rpcResult = null;
try {
  rpcResult = await withBudget(
    runPhase({ label: 'rpc', interactive: true, pngBase64, pngPrefix, resultsDir }),
    'rpc',
  );
  summary.phases.push({ ...rpcResult, evidence: rpcResult.evidence });
  for (const check of MANDATORY_CHECKS) summary.checks.push('RPC: ' + check);
} catch (error) {
  const text = String(error && error.message ? error.message : error);
  const blocked = blockedReason(error);
  if (blocked) {
    summary.phases.push({ label: 'rpc', passed: false, blocked: blocked.slice(0, 1000) });
    summary.blocked.push('rpc: ' + blocked.slice(0, 300));
  } else if (/questions|daemon|natifs?|moteur natif/i.test(text)) {
    summary.phases.push({ label: 'rpc', passed: false, blocked: text.slice(0, 1000) });
    summary.blocked.push('rpc: interactive engine path unavailable: ' + text.slice(0, 300));
  } else {
    summary.phases.push({
      label: 'rpc',
      passed: false,
      error: String(error && error.stack ? error.stack : error).slice(0, 4000),
    });
    console.error('RPC phase failed:', error);
  }
}

// Partial diagnostic only: the direct engine spawn bypasses the Studio
// runtime loaders, so it can never turn a blocked mandatory phase green.
// It records the same computer assertions as an isolated signal.
let directResult = null;
try {
  directResult = await withBudget(
    runPhase({
      label: 'direct-json',
      interactive: false,
      pngBase64,
      pngPrefix,
      resultsDir,
      engineMode: 'direct',
    }),
    'direct-json',
  );
  summary.partial = { ...directResult, evidence: directResult.evidence, partial: true };
  summary.partialChecks = MANDATORY_CHECKS.map((check) => 'Direct engine (partial): ' + check);
} catch (error) {
  summary.partial = {
    label: 'direct-json',
    passed: false,
    partial: true,
    error: String(error && error.stack ? error.stack : error).slice(0, 4000),
  };
  console.error('Direct phase failed:', error);
}

summary.finishedAt = new Date().toISOString();
summary.passed = summary.phases.length > 0 && summary.phases.every((phase) => phase.passed === true);
await writeFile(join(resultsDir, 'native-proof.json'), JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify(
    {
      passed: summary.passed,
      checks: summary.checks,
      blocked: summary.blocked,
      phases: summary.phases.map((phase) => ({
        label: phase.label,
        passed: phase.passed,
        blocked: phase.blocked || null,
        calls: phase.calls || null,
        driver: phase.driver || null,
        requestCount: phase.requestCount || null,
      })),
      partial: summary.partial
        ? {
            label: summary.partial.label,
            passed: summary.partial.passed,
            calls: summary.partial.calls || null,
            driver: summary.partial.driver || null,
          }
        : null,
    },
    null,
    2,
  ),
);
if (!summary.passed) process.exitCode = 1;
