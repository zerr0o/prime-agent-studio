// CUA + history native proof: real installed Prime Agent 0.9.5 only.
// Two narrow cases, isolated temp agentHome/namespace, fake desktops,
// local deterministic provider. No real input, capture, paid models,
// live Studio daemon, installs or restarts. Kills only exact test trees
// via runtime.close/bridge.close/provider.close.
// Case H: oversized HISTORICAL ComputerUse image filtered by the real
//   extension relative helper import + context hook BEFORE provider.
//   Seeds an isolated session fixture toolResult PNG>2000 then resumes.
//   Session logs on disk stay unchanged; provider sees only the marker.
// Case C: real-engine CUA fake-driver proof: computer_inspect text frame
//   -> elementId/set_value via existing bridge owner backend cua,
//   pixel coords untouched, partial truth preserved.
// Fake Node helper with driverFrame bindings; CUA exe never used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, sep, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { open, realpath } from 'node:fs/promises';
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
const FRAME_GEOM = { width: 400, height: 300, bounds: { x: 100, y: 80, width: 800, height: 600 } };
const CUA_GEOM = { width: 800, height: 450, bounds: { x: -1600, y: 100, width: 1600, height: 900 } };
const CUA_WINDOW_ID = '432:198738';
const CUA_PIXEL = { x: 400, y: 200 };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  return '';
}
function toolMessages(messages) {
  return (messages || []).filter((e) => e && e.role === 'tool');
}
function lastToolText(messages) {
  const tools = toolMessages(messages);
  if (!tools.length) return '';
  return textOf(tools[tools.length - 1].content);
}
function imageEvidence(messages, prefix) {
  const flat = JSON.stringify(messages || []);
  const hasBase64 = typeof prefix === 'string' && prefix.length > 8 && flat.includes(prefix);
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
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) for (const it of v) walk(it);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  for (const m of messages || []) walk(m);
  if (flat.includes('data:image/png;base64') || flat.includes('data:image/jpeg;base64')) {
    hasImagePart = true;
    partTypes.add('embedded-data-url');
  }
  return { hasBase64, hasImagePart, partTypes: [...partTypes] };
}
// Minimal PNG writer for small native fixture.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makeFixturePng(w, h) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = 190;
      raw[o + 1] = 190;
      raw[o + 2] = 212;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
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
function pngHeaderBase64(w, h) {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  buf[24] = 8;
  buf[25] = 2;
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  buf.writeUInt32BE(0, 29);
  return buf.toString('base64');
}
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
function createFakeNativeDriver({ pngBase64 }) {
  const calls = { status: 0, windows: [], observes: [], acts: [] };
  const stopReasons = [];
  let closed = false;
  return {
    calls,
    stopReasons,
    get stoppedReason() {
      return stopReasons.length ? stopReasons[stopReasons.length - 1] : null;
    },
    get closed() {
      return closed;
    },
    async request(command, { signal } = {}) {
      if (signal && signal.aborted) {
        const e = new Error('Fake driver operation cancelled.');
        e.name = 'AbortError';
        throw e;
      }
      const method = command && command.method;
      const params = (command && command.params) || {};
      if (closed) {
        const e = new Error('Fake worker is closed. A fresh worker must be spawned.');
        e.code = 'WORKER_EXIT';
        throw e;
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
        return { executed: Array.isArray(params.actions) ? params.actions.length : 0, fake: true };
      }
      const e = new Error('Unknown fake driver method ' + String(method));
      e.status = 400;
      throw e;
    },
    async stop(r = 'user') {
      stopReasons.push(r);
    },
    async close() {
      closed = true;
    },
  };
}
function createFakeCuaDriver({ smallPngBase64 }) {
  const calls = { status: 0, windows: [], observes: [], inspects: [], acts: [] };
  let seq = 0;
  let closed = false;
  const stopReasons = [];
  const nextSnapshot = () => {
    seq += 1;
    return 's' + seq.toString(16).padStart(8, '0');
  };
  let lastInspectSnapshot = null;
  let lastObserveSnapshot = null;
  let lastInspectElement = null;
  return {
    calls,
    stopReasons,
    get closed() {
      return closed;
    },
    get lastInspectSnapshot() {
      return lastInspectSnapshot;
    },
    get lastObserveSnapshot() {
      return lastObserveSnapshot;
    },
    get lastInspectElement() {
      return lastInspectElement;
    },
    async request(command) {
      const method = command && command.method;
      const params = (command && command.params) || {};
      if (closed) {
        const e = new Error('Fake CUA worker is closed.');
        e.code = 'WORKER_EXIT';
        throw e;
      }
      if (method === 'status') {
        calls.status += 1;
        return { supported: true, hotkeyRegistered: true, hotkeyError: 0, fake: true, backend: 'cua' };
      }
      if (method === 'windows') {
        calls.windows.push(params);
        return {
          windows: [
            {
              id: CUA_WINDOW_ID,
              title: 'Fake CUA App',
              processId: 432,
              processName: 'fake.exe',
              bounds: { x: -1600, y: 100, width: 1600, height: 900 },
              foreground: false,
            },
          ],
          foreground: CUA_WINDOW_ID,
          fake: true,
        };
      }
      if (method === 'inspect') {
        calls.inspects.push(params);
        const snapshotId = nextSnapshot();
        lastInspectSnapshot = snapshotId;
        const elementId = snapshotId + ':1';
        lastInspectElement = elementId;
        return {
          frame: {
            width: CUA_GEOM.width,
            height: CUA_GEOM.height,
            windowId: params.windowId,
            bounds: { ...CUA_GEOM.bounds },
            capturedAt: new Date().toISOString(),
          },
          driverFrame: {
            backend: 'cua',
            kind: 'accessibility',
            pid: 432,
            windowId: 198738,
            snapshotId,
            sessionLabel: 'private',
          },
          elements: [{ elementId, role: 'button', label: 'Play', enabled: true }],
          timing: { driverMs: 2 },
        };
      }
      if (method === 'observe') {
        calls.observes.push(params);
        const snapshotId = nextSnapshot();
        lastObserveSnapshot = snapshotId;
        const elementId = snapshotId + ':1';
        return {
          image: { mimeType: 'image/png', data: smallPngBase64 },
          frame: {
            width: CUA_GEOM.width,
            height: CUA_GEOM.height,
            windowId: params.windowId || CUA_WINDOW_ID,
            bounds: { ...CUA_GEOM.bounds },
            capturedAt: new Date().toISOString(),
          },
          driverFrame: {
            backend: 'cua',
            kind: 'screenshot',
            pid: 432,
            windowId: 198738,
            snapshotId,
            sessionLabel: 'private',
          },
          elements: [{ elementId, role: 'button', label: 'Play', enabled: true }],
          timing: { driverMs: 2 },
        };
      }
      if (method === 'act') {
        calls.acts.push(params);
        const actions = Array.isArray(params.actions) ? params.actions : [];
        const first = actions[0] || {};
        if (typeof first.elementId === 'string') {
          return {
            executed: actions.length,
            results: actions.map((_, i) => ({ index: i, effect: 'confirmed', route: 'uia' })),
            fake: true,
          };
        }
        // Pixel path: omit executed to exercise CUA partial truth (bridge sets executed null, partial true).
        return {
          results: actions.map((_, i) => ({ index: i, effect: 'unverified', route: 'uia' })),
          fake: true,
        };
      }
      const e = new Error('Unknown fake CUA method ' + String(method));
      e.status = 400;
      throw e;
    },
    async stop(r = 'user') {
      stopReasons.push(r);
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
  const key = (v) => (process.platform === 'win32' ? resolve(v).toLowerCase() : resolve(v));
  if (key(actual) !== key(file)) throw denied();
  if (!roots.some((r) => key(actual).startsWith(key(r) + sep))) throw denied();
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
      getRuns().filter((r) => r && r.status === 'running' && cwdKey(r.cwd) === cwdKey(own.cwd));
    const direct = matching().find((r) => r.sessionId === own.id);
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
        const k = cwdKey(edge.child);
        if (byChild.has(k)) throw denied();
        byChild.set(k, edge);
      }
    }
    let current = own;
    let ownEdge = null;
    let parentSessionId = null;
    const visited = new Set();
    for (let d = 0; d < 32; d++) {
      const k = cwdKey(current.file);
      if (visited.has(k)) throw denied();
      visited.add(k);
      const edge = byChild.get(k);
      if (!edge) throw denied();
      if (!ownEdge) ownEdge = edge;
      current = await readSessionHeader(edge.parent, roots).catch(() => {
        throw denied();
      });
      if (cwdKey(current.cwd) !== cwdKey(own.cwd)) throw denied();
      if (!parentSessionId) parentSessionId = current.id;
      const run = matching().find((c) => c.sessionId === current.id);
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
function sanitizeChildNodeOptions(value, root) {
  if (!value) return value;
  const rootKey = resolve(root).toLowerCase();
  const tokens = String(value).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const kept = tokens.filter((tok) => {
    const flag = tok.replace(/^["']|["']$/g, '');
    if (!flag.startsWith('--import=') && !flag.startsWith('--require=')) return true;
    const raw = flag
      .slice(flag.indexOf('=') + 1)
      .replace(/^["']|["']$/g, '')
      .replace(/^file:\/\//, '')
      .replace(/^\/([A-Za-z]:[\/\\])/, '$1');
    const lowered = raw.replaceAll('/', '\\').toLowerCase();
    const looks = lowered.includes('studio\\runtime\\') || /[-_](loader|hook)\.(mjs|cjs)$/.test(lowered);
    if (!looks) return true;
    try {
      if (resolve(raw).toLowerCase().startsWith(rootKey)) return true;
    } catch {}
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

async function runHistoryCase({ pngBase64, pngPrefix, resultsDir }) {
  const label = 'history-filter';
  const phaseRoot = await mkdtemp(join(tmpdir(), 'prime-cua-native-' + label + '-'));
  const cwd = join(phaseRoot, 'project');
  const agentHome = join(phaseRoot, 'agent');
  const sessionDir = join(agentHome, 'sessions');
  const dataDir = join(phaseRoot, 'studio');
  await Promise.all([cwd, sessionDir].map((p) => mkdir(p, { recursive: true })));
  const store = createStore({ sessionDir, dataDir });
  await store.project({ cwd });
  const run = { id: '11111111-2222-4333-8444-555555555556', sessionId: null, cwd, status: 'running' };
  const RUN2 = 'bbbbbbbb-cccc-4ddd-8eee-fffffffffff0';
  const driverInstances = [];
  const createDriver = () => {
    const d = createFakeNativeDriver({ pngBase64 });
    d.instanceId = driverInstances.length;
    driverInstances.push(d);
    return d;
  };
  const manager = createComputerUseManager({ createDriver, isSupported: true });
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
  const evidence = { imageStages: [], toolDiscovery: null };
  let runtime = null;
  let observedFrameId = null;
  let resumeArmed = false;
  let resumeStep = 0;
  let resumeFirstBody = null;
  async function ensureEnabled() {
    const deadline = Date.now() + 15000;
    while (!run.sessionId && Date.now() < deadline) await sleep(50);
    assert.ok(run.sessionId, label + ': session id missing before enable');
    const cur = manager.status({ sessionId: run.sessionId });
    if (!cur.enabled) {
      await manager.enable({
        sessionId: run.sessionId,
        runId: run.id,
        cwd,
        name: 'native-cua-' + label,
        imageCapable: true,
        model: 'fixture/history',
      });
      calls.push(label + ':test-enabled-lease');
    }
  }
  const provider = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const role = body.model || 'history';
      requests.push(body);
      const names = (body.tools || []).map((t) => t.function.name);
      for (const n of EXPECTED_TOOLS)
        assert.ok(names.includes(n), label + ' ' + role + ': tool ' + n + ' missing');
      if (!evidence.toolDiscovery)
        evidence.toolDiscovery = {
          count: names.length,
          computerTools: EXPECTED_TOOLS.filter((n) => names.includes(n)),
        };
      if (resumeArmed) {
        if (resumeStep === 0) {
          resumeFirstBody = body;
          const flat = JSON.stringify(body.messages || []);
          try {
            await writeFile(
              join(resultsDir, 'debug-resume-body.json'),
              JSON.stringify(
                {
                  flatLength: flat.length,
                  hasMarker: flat.includes('exceeds the 2000px'),
                  hasOversized: flat.includes(oversizedPrefix),
                  hasSmall: flat.includes(pngPrefix),
                  hasSeedId: flat.includes('seeded-oversized-1'),
                  sample: flat.slice(0, 4000),
                },
                null,
                2,
              ),
            );
          } catch {}
          try {
            await writeFile(
              join(resultsDir, 'debug-resume-full.json'),
              JSON.stringify(body, null, 2).slice(0, 200000),
            );
          } catch {}
          // Real helper marker contract: dimensions + normalized + fresh observation hint.
          assert.match(flat, /exceeds the 2000px provider limit/, label + ': filtered marker missing');
          assert.match(flat, /History was normalized/, label + ': normalized marker missing');
          assert.match(flat, /Take a new observation/, label + ': fresh observation hint missing');
          assert.match(flat, /3840x2160/, label + ': seeded dimensions missing in marker');
          assert.ok(!flat.includes(oversizedPrefix), label + ': oversized base64 must not reach provider');
          assert.ok(flat.includes(pngPrefix), label + ': small historical image must be preserved');
          assert.ok(flat.includes('seeded-oversized-1'), label + ': seeded toolCallId must be preserved');
          calls.push(label + ':oversized-filtered-before-provider');
        }
        let tool = null;
        if (resumeStep === 0) tool = { name: 'computer_status', arguments: {} };
        else if (resumeStep === 1) {
          const text = lastToolText(body.messages);
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {}
          assert.ok(parsed && parsed.enabled === true, label + ': resumed status must be enabled');
          assert.ok(parsed.owner && parsed.owner.runId === RUN2, label + ': resumed status must bind RUN2');
          calls.push(label + ':resume-status-verified');
        } else calls.push(label + ':resume-finished');
        resumeStep += 1;
        if (tool) calls.push(label + ':' + tool.name + '-resume');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frame = (delta, fin = null) =>
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'message-' + requests.length,
                object: 'chat.completion.chunk',
                created: 1,
                model: role,
                choices: [{ index: 0, delta, finish_reason: fin }],
              }) +
              '\n\n',
          );
        frame({ role: 'assistant' });
        if (tool) {
          frame({
            tool_calls: [
              {
                index: 0,
                id: role + '-resume-' + resumeStep,
                type: 'function',
                function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
              },
            ],
          });
          frame({}, 'tool_calls');
        } else {
          frame({ content: 'History resume verified.' });
          frame({}, 'stop');
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      const step = stage.get(role) || 0;
      let tool = null;
      if (step === 0) tool = { name: 'computer_status', arguments: {} };
      else if (step === 1) {
        const text = lastToolText(body.messages);
        let p = null;
        try {
          p = JSON.parse(text);
        } catch {}
        assert.ok(p && p.enabled === false, label + ': status must be disabled first');
        calls.push(label + ':status-disabled-json');
        tool = { name: 'computer_observe', arguments: {} };
      } else if (step === 2) {
        const text = lastToolText(body.messages);
        assert.match(text, /off|Enable it in Studio/i, label + ': disabled observe must refuse');
        calls.push(label + ':observe-disabled-refusal');
        await ensureEnabled();
        tool = { name: 'computer_status', arguments: {} };
      } else if (step === 3) {
        const text = lastToolText(body.messages);
        let p = null;
        try {
          p = JSON.parse(text);
        } catch {}
        assert.ok(p && p.enabled === true, label + ': enabled status missing');
        calls.push(label + ':status-enabled-json');
        tool = { name: 'computer_observe', arguments: { windowId: FAKE_WINDOW.id, maxWidth: 800 } };
      } else if (step === 4) {
        const found = (() => {
          for (let i = toolMessages(body.messages).length - 1; i >= 0; i--) {
            const t = textOf(toolMessages(body.messages)[i].content);
            if (!t) continue;
            try {
              const pa = JSON.parse(t);
              const fr =
                pa && pa.frame ? pa.frame : pa && pa.observe && pa.observe.frame ? pa.observe.frame : null;
              if (fr && typeof fr.frameId === 'string') return { parsed: pa, frame: fr };
            } catch {}
          }
          return { parsed: null, frame: null };
        })();
        assert.ok(found.frame, label + ': observe must return frame');
        observedFrameId = found.frame.frameId;
        const seen = imageEvidence(body.messages, pngPrefix);
        evidence.imageStages.push({ stage: 'after-observe', ...seen });
        assert.ok(seen.hasBase64 && seen.hasImagePart, label + ': small pixels must reach model as image');
        calls.push(label + ':observe-image-in-request');
      } else calls.push(label + ':finished');
      stage.set(role, step + 1);
      if (tool) calls.push(label + ':' + tool.name);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const fr = (delta, fin = null) =>
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'message-' + requests.length,
              object: 'chat.completion.chunk',
              created: 1,
              model: role,
              choices: [{ index: 0, delta, finish_reason: fin }],
            }) +
            '\n\n',
        );
      fr({ role: 'assistant' });
      if (tool) {
        fr({
          tool_calls: [
            {
              index: 0,
              id: role + '-' + step,
              type: 'function',
              function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
            },
          ],
        });
        fr({}, 'tool_calls');
      } else {
        fr({ content: 'History seed ready.' });
        fr({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (e) {
      calls.push({ error: label + ' provider: ' + String(e && e.message ? e.message : e).slice(0, 500) });
      try {
        res.writeHead(500);
        res.end(String(e && e.message ? e.message : e).slice(0, 2000));
      } catch {}
    }
  });
  provider.requestTimeout = 30000;
  provider.headersTimeout = 15000;
  await new Promise((d) => provider.listen(0, '127.0.0.1', d));
  const port = provider.address().port;
  const settings = JSON.stringify({
    defaultProvider: 'fixture',
    defaultModel: 'history',
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
              id: 'history',
              name: 'History fixture',
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
  let resumeHandle = null;
  // Oversized seeded fixture: header-only PNG 3840x2160 (>2000). Real pixels would be MBs; header suffices for helper.
  const oversizedBase64 = pngHeaderBase64(3840, 2160);
  const oversizedPrefix = oversizedBase64.slice(0, 48);
  try {
    runtime = createAgentRuntime({
      agentHome,
      sessionDir,
      computer: { config: bridge.config },
      env: testChildEnv(),
    });
    handle = await runtime.start({
      cwd,
      message: 'Prove history filtering with small observe. Start with status, then observe.',
      model: 'fixture/history',
      thinking: 'off',
      onEvent: (ev) => {
        events.push(ev);
        if (ev && ev.kind === 'session' && ev.sessionId) run.sessionId = ev.sessionId;
      },
    });
    let timer;
    const done = await Promise.race([
      handle.done,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(label + ' initial run timed out after 120s')), 120000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(done.status, 'completed', label + ' initial status ' + JSON.stringify(done).slice(0, 500));
    for (const ex of [
      label + ':status-disabled-json',
      label + ':observe-disabled-refusal',
      label + ':status-enabled-json',
      label + ':observe-image-in-request',
    ])
      assert.ok(calls.includes(ex), label + ' missing ' + ex);
    // Seed isolated session fixture only (never touches live Studio logs).
    assert.ok(run.sessionId, label + ': sessionId required for seeding');
    const files = await readdir(sessionDir);
    const target = files.map((f) => join(sessionDir, f)).find((f) => f.endsWith(run.sessionId + '.jsonl'));
    assert.ok(target, label + ': session file not found for ' + run.sessionId);
    const beforeRaw = await readFile(target, 'utf8');
    assert.ok(beforeRaw.includes(pngPrefix), label + ': small history must exist before seeding');
    assert.ok(!beforeRaw.includes(oversizedPrefix), label + ': oversized must not exist before seeding');
    const lines = beforeRaw.split('\n').filter((l) => l.trim());
    const lastId = JSON.parse(lines[lines.length - 1]).id;
    assert.ok(lastId, label + ': last entry id missing');
    const seededCallId = 'seeded-oversized-1';
    const seededAssistant = {
      type: 'message',
      id: 'seededassistant1',
      parentId: lastId,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: seededCallId, name: 'computer_observe', arguments: {} }],
        api: 'openai-completions',
        provider: 'fixture',
        model: 'history',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: Date.now(),
        responseId: 'message-seeded',
      },
    };
    const seededEntry = {
      type: 'message',
      id: 'seededoversized1',
      parentId: 'seededassistant1',
      timestamp: new Date().toISOString(),
      message: {
        role: 'toolResult',
        toolCallId: seededCallId,
        toolName: 'computer_observe',
        content: [
          { type: 'image', data: oversizedBase64, mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify({ frame: { frameId: 'old-frame-seeded' } }) },
        ],
        details: {
          action: 'computer_observe',
          frame: { frameId: 'old-frame-seeded', width: 3840, height: 2160 },
        },
        isError: false,
        timestamp: Date.now(),
      },
    };
    await appendFile(target, JSON.stringify(seededAssistant) + '\n', 'utf8');
    await appendFile(target, JSON.stringify(seededEntry) + '\n', 'utf8');
    const afterSeed = await readFile(target, 'utf8');
    assert.ok(afterSeed.includes(oversizedPrefix), label + ': seeded file must contain oversized');
    calls.push(label + ':seeded-isolated-fixture');
    // Verify extension uses relative helper import (no absolute path) before resume proves it.
    const extPath = join(PROOF_ROOT, 'runtime', 'studio-computer-use-extension.mjs');
    const extText = await readFile(extPath, 'utf8');
    assert.ok(
      extText.includes("from './computer-use-image-safety.mjs'"),
      label + ': extension must use relative helper import',
    );
    assert.ok(
      !extText.includes('E:/') && !extText.includes('C:/'),
      label + ': extension must not use absolute helper path',
    );
    assert.ok(extText.includes("pi.on('context'"), label + ': extension must register context hook');
    calls.push(label + ':relative-import-verified');
    // Rebind lease to RUN2 for resume (same session, new run).
    run.id = RUN2;
    await manager.enable({
      sessionId: run.sessionId,
      runId: RUN2,
      cwd,
      name: 'rebind-history',
      imageCapable: true,
      model: 'fixture/history',
    });
    resumeArmed = true;
    resumeHandle = await runtime.start({
      cwd,
      sessionId: run.sessionId,
      message: 'Confirm Computer Use status after history normalization.',
      model: 'fixture/history',
      thinking: 'off',
      onEvent: (ev) => {
        events.push(ev);
      },
    });
    let rtimer;
    const rdone = await Promise.race([
      resumeHandle.done,
      new Promise((_, rej) => {
        rtimer = setTimeout(() => rej(new Error(label + ' resume timed out after 60s')), 60000);
      }),
    ]).finally(() => clearTimeout(rtimer));
    assert.equal(rdone.status, 'completed', label + ' resume status ' + JSON.stringify(rdone).slice(0, 500));
    assert.ok(
      calls.includes(label + ':oversized-filtered-before-provider'),
      label + ': filtering proof missing',
    );
    assert.ok(calls.includes(label + ':resume-status-verified'), label + ': resume lease proof missing');
    const finalRaw = await readFile(target, 'utf8');
    assert.ok(
      finalRaw.includes(oversizedPrefix),
      label + ': session log must still contain oversized (transient only)',
    );
    assert.ok(finalRaw.includes(pngPrefix), label + ': session log must still contain small image');
    calls.push(label + ':logs-unchanged');
    return {
      label,
      passed: true,
      calls,
      evidence: {
        ...evidence,
        oversized: { width: 3840, height: 2160, prefixLength: oversizedPrefix.length },
        smallPrefixLength: pngPrefix.length,
        resumeRequests: resumeStep,
      },
      sessionId: run.sessionId,
      root: phaseRoot,
      requestCount: requests.length,
    };
  } finally {
    run.status = 'completed';
    try {
      await runtime?.close();
    } catch {}
    try {
      await bridge.close();
    } catch {}
    await new Promise((d) => {
      try {
        provider.closeAllConnections?.();
      } catch {}
      provider.close(d);
    });
  }
}

async function runCuaCase({ resultsDir }) {
  const label = 'cua-inspect';
  const phaseRoot = await mkdtemp(join(tmpdir(), 'prime-cua-native-' + label + '-'));
  const cwd = join(phaseRoot, 'project');
  const agentHome = join(phaseRoot, 'agent');
  const sessionDir = join(agentHome, 'sessions');
  const dataDir = join(phaseRoot, 'studio');
  await Promise.all([cwd, sessionDir].map((p) => mkdir(p, { recursive: true })));
  const store = createStore({ sessionDir, dataDir });
  await store.project({ cwd });
  const run = { id: 'cccccccc-dddd-4eee-8fff-000000000001', sessionId: null, cwd, status: 'running' };
  const smallPngBase64 = pngHeaderBase64(CUA_GEOM.width, CUA_GEOM.height);
  const smallPrefix = smallPngBase64.slice(0, 48);
  const driver = createFakeCuaDriver({ smallPngBase64 });
  const manager = createComputerUseManager({
    createDriver: () => driver,
    isSupported: true,
    cuaAvailability: { available: true, supported: true },
  });
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
  const evidence = { toolDiscovery: null, elements: [] };
  let runtime = null;
  let inspectFrameId = null;
  let inspectElement = null;
  let observeFrameId = null;
  async function ensureCua() {
    const deadline = Date.now() + 15000;
    while (!run.sessionId && Date.now() < deadline) await sleep(50);
    assert.ok(run.sessionId, label + ': session id missing');
    const cur = manager.status({ sessionId: run.sessionId });
    if (!cur.enabled || cur.owner?.backend !== 'cua') {
      await manager.enable({
        sessionId: run.sessionId,
        runId: run.id,
        cwd,
        name: 'native-cua-' + label,
        imageCapable: true,
        model: 'fixture/cua',
        backend: 'cua',
      });
      calls.push(label + ':test-enabled-cua-lease');
    }
  }
  const provider = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const role = body.model || 'cua';
      requests.push(body);
      const names = (body.tools || []).map((t) => t.function.name);
      for (const n of EXPECTED_TOOLS)
        assert.ok(names.includes(n), label + ' ' + role + ': tool ' + n + ' missing');
      if (!evidence.toolDiscovery)
        evidence.toolDiscovery = {
          count: names.length,
          computerTools: EXPECTED_TOOLS.filter((n) => names.includes(n)),
        };
      const step = stage.get(role) || 0;
      let tool = null;
      if (step === 0) tool = { name: 'computer_status', arguments: {} };
      else if (step === 1) {
        const text = lastToolText(body.messages);
        let p = null;
        try {
          p = JSON.parse(text);
        } catch {}
        assert.ok(p && p.enabled === false, label + ': status must be disabled first');
        calls.push(label + ':status-disabled-json');
        await ensureCua();
        tool = { name: 'computer_status', arguments: {} };
      } else if (step === 2) {
        const text = lastToolText(body.messages);
        let p = null;
        try {
          p = JSON.parse(text);
        } catch {}
        assert.ok(p && p.enabled === true, label + ': enabled status missing, got ' + text.slice(0, 300));
        assert.equal(
          p.owner && p.owner.backend,
          'cua',
          label + ': owner backend must be cua, got ' + text.slice(0, 300),
        );
        assert.ok(p.owner && p.owner.runId === run.id, label + ': owner must bind test run');
        calls.push(label + ':status-enabled-cua-json');
        tool = { name: 'computer_inspect', arguments: { windowId: CUA_WINDOW_ID } };
      } else if (step === 3) {
        const text = lastToolText(body.messages);
        let p = null;
        try {
          p = JSON.parse(text);
        } catch {}
        assert.ok(p && p.frame, label + ': inspect must return frame, got ' + text.slice(0, 500));
        assert.equal(p.frame.kind, 'accessibility', label + ': inspect frame must be accessibility');
        assert.equal(p.frame.backend, 'cua', label + ': inspect frame backend must be cua');
        assert.ok(p.frame.frameId, label + ': inspect frameId required');
        assert.ok(Array.isArray(p.elements) && p.elements.length > 0, label + ': inspect elements missing');
        assert.ok(p.elements[0].elementId, label + ': elementId missing');
        assert.equal(p.image, undefined, label + ': inspect must return no pixels');
        inspectFrameId = p.frame.frameId;
        inspectElement = p.elements[0].elementId;
        evidence.elements.push({ frameId: inspectFrameId, elementId: inspectElement, kind: p.frame.kind });
        const seen = imageEvidence(body.messages, smallPrefix);
        // No screenshot yet, so no CUA pixels should be present.
        assert.ok(!seen.hasBase64, label + ': inspect text frame must carry no pixels');
        calls.push(label + ':inspect-text-frame');
        tool = {
          name: 'computer_act',
          arguments: {
            frameId: inspectFrameId,
            actions: [{ type: 'set_value', elementId: inspectElement, value: 'hello' }],
            deliveryMode: 'background',
          },
        };
      } else if (step === 4) {
        const text = lastToolText(body.messages);
        let p = null;
        try {
          p = JSON.parse(text);
        } catch {}
        assert.ok(
          p && typeof p.executed === 'number',
          label + ': set_value must report executed, got ' + text.slice(0, 500),
        );
        assert.equal(p.executed, 1, label + ': set_value executed must be 1');
        assert.equal(p.applicationState, 'unverified', label + ': applicationState must be unverified');
        assert.ok(
          Array.isArray(p.results) && p.results[0].effect === 'confirmed',
          label + ': per-action effect missing',
        );
        assert.equal(p.partial || false, false, label + ': confirmed set_value must not be partial');
        calls.push(label + ':set-value-routed');
        // Verify driver routing synchronously (same tick, before next observe).
        const actCall = driver.calls.acts[0];
        assert.ok(actCall, label + ': driver must have received set_value act');
        assert.deepEqual(
          actCall.actions,
          [{ type: 'set_value', elementId: inspectElement, value: 'hello' }],
          label + ': element action must be routed unchanged',
        );
        assert.equal(actCall.deliveryMode, 'background', label + ': deliveryMode must be forwarded');
        assert.ok(
          actCall.expectedFrame &&
            actCall.expectedFrame.driverFrame &&
            actCall.expectedFrame.driverFrame.backend === 'cua',
          label + ': expectedFrame must carry CUA binding',
        );
        assert.equal(
          actCall.expectedFrame.driverFrame.snapshotId,
          driver.lastInspectSnapshot,
          label + ': snapshot binding must match inspect',
        );
        assert.equal(
          actCall.expectedFrame.driverFrame.kind,
          'accessibility',
          label + ': binding kind must be accessibility',
        );
        calls.push(label + ':bridge-binding-verified');
        tool = { name: 'computer_observe', arguments: { windowId: CUA_WINDOW_ID } };
      } else if (step === 5) {
        const text = lastToolText(body.messages);
        let p = null;
        try {
          p = JSON.parse(text);
        } catch {}
        // Observe returns image+text; the text side is the second content part, but lastToolText merges text parts.
        // Find frame from tool messages (observe text payload).
        let frame = null;
        for (let i = toolMessages(body.messages).length - 1; i >= 0; i--) {
          const t = textOf(toolMessages(body.messages)[i].content);
          if (!t) continue;
          try {
            const pa = JSON.parse(t);
            const fr =
              pa && pa.frame ? pa.frame : pa && pa.observe && pa.observe.frame ? pa.observe.frame : null;
            if (fr && fr.frameId) {
              frame = fr;
              break;
            }
          } catch {}
        }
        assert.ok(frame, label + ': screenshot observe must return frame');
        assert.equal(frame.backend, 'cua', label + ': screenshot backend must be cua');
        observeFrameId = frame.frameId;
        const seen = imageEvidence(body.messages, smallPrefix);
        assert.ok(
          seen.hasBase64 && seen.hasImagePart,
          label + ': screenshot pixels must reach model as image',
        );
        calls.push(label + ':screenshot-pixels-local');
        tool = {
          name: 'computer_act',
          arguments: {
            frameId: observeFrameId,
            actions: [{ type: 'click', x: CUA_PIXEL.x, y: CUA_PIXEL.y }],
          },
        };
      } else if (step === 6) {
        const text = lastToolText(body.messages);
        let p = null;
        try {
          p = JSON.parse(text);
        } catch {}
        assert.ok(p, label + ': pixel act must return JSON, got ' + text.slice(0, 500));
        assert.equal(p.applicationState, 'unverified', label + ': pixel act must be unverified');
        assert.equal(
          p.partial,
          true,
          label + ': pixel act without driver executed must be partial true, got ' + text.slice(0, 500),
        );
        assert.ok(
          p.executed === null || p.executed === undefined,
          label + ': partial executed must be null/undefined',
        );
        calls.push(label + ':partial-truth');
        const pixelCall = driver.calls.acts[1];
        assert.ok(pixelCall, label + ': driver must have received pixel act');
        assert.deepEqual(
          pixelCall.actions[0],
          { type: 'click', x: CUA_PIXEL.x, y: CUA_PIXEL.y },
          label + ': CUA pixel coords must stay local untouched',
        );
        assert.equal(
          pixelCall.expectedFrame.driverFrame.snapshotId,
          driver.lastObserveSnapshot,
          label + ': pixel snapshot binding must match screenshot',
        );
        assert.equal(
          pixelCall.expectedFrame.driverFrame.kind,
          'screenshot',
          label + ': pixel binding kind must be screenshot',
        );
        calls.push(label + ':pixel-untouched');
        tool = { name: 'computer_release', arguments: {} };
      } else if (step === 7) {
        const text = lastToolText(body.messages);
        const p = JSON.parse(text);
        assert.equal(p.released, true, label + ': release must confirm');
        calls.push(label + ':release');
      } else calls.push(label + ':finished');
      stage.set(role, step + 1);
      if (tool) calls.push(label + ':' + tool.name);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const fr = (delta, fin = null) =>
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'message-' + requests.length,
              object: 'chat.completion.chunk',
              created: 1,
              model: role,
              choices: [{ index: 0, delta, finish_reason: fin }],
            }) +
            '\n\n',
        );
      fr({ role: 'assistant' });
      if (tool) {
        fr({
          tool_calls: [
            {
              index: 0,
              id: role + '-' + step,
              type: 'function',
              function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
            },
          ],
        });
        fr({}, 'tool_calls');
      } else {
        fr({ content: 'CUA native integration verified.' });
        fr({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (e) {
      calls.push({ error: label + ' provider: ' + String(e && e.message ? e.message : e).slice(0, 500) });
      try {
        res.writeHead(500);
        res.end(String(e && e.message ? e.message : e).slice(0, 2000));
      } catch {}
    }
  });
  provider.requestTimeout = 30000;
  provider.headersTimeout = 15000;
  await new Promise((d) => provider.listen(0, '127.0.0.1', d));
  const port = provider.address().port;
  const settings = JSON.stringify({
    defaultProvider: 'fixture',
    defaultModel: 'cua',
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
              id: 'cua',
              name: 'CUA fixture',
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
  try {
    runtime = createAgentRuntime({
      agentHome,
      sessionDir,
      computer: { config: bridge.config },
      env: testChildEnv(),
    });
    handle = await runtime.start({
      cwd,
      message: 'Prove CUA inspect with fake driver. Start with status, then inspect.',
      model: 'fixture/cua',
      thinking: 'off',
      onEvent: (ev) => {
        events.push(ev);
        if (ev && ev.kind === 'session' && ev.sessionId) run.sessionId = ev.sessionId;
      },
    });
    let timer;
    const done = await Promise.race([
      handle.done,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(label + ' run timed out after 120s')), 120000);
      }),
    ]).finally(() => clearTimeout(timer));
    const providerErrors = calls.filter((e) => e && e.error);
    assert.deepEqual(
      providerErrors,
      [],
      label + ' provider errors: ' + JSON.stringify(providerErrors).slice(0, 2000),
    );
    assert.equal(done.status, 'completed', label + ' run status ' + JSON.stringify(done).slice(0, 500));
    for (const ex of [
      label + ':status-disabled-json',
      label + ':status-enabled-cua-json',
      label + ':inspect-text-frame',
      label + ':set-value-routed',
      label + ':bridge-binding-verified',
      label + ':screenshot-pixels-local',
      label + ':partial-truth',
      label + ':pixel-untouched',
      label + ':release',
    ])
      assert.ok(calls.includes(ex), label + ' missing ' + ex + ' in ' + JSON.stringify(calls).slice(0, 2000));
    assert.equal(driver.calls.inspects.length, 1, label + ': exactly one inspect must reach driver');
    assert.equal(
      driver.calls.observes.length,
      1,
      label + ': exactly one screenshot observe must reach driver',
    );
    assert.equal(driver.calls.acts.length, 2, label + ': exactly two act batches must reach driver');
    return {
      label,
      passed: true,
      calls,
      evidence,
      sessionId: run.sessionId,
      root: phaseRoot,
      requestCount: requests.length,
      driver: {
        inspects: driver.calls.inspects.length,
        observes: driver.calls.observes.length,
        acts: driver.calls.acts.length,
      },
    };
  } finally {
    run.status = 'completed';
    try {
      await runtime?.close();
    } catch {}
    try {
      await bridge.close();
    } catch {}
    await new Promise((d) => {
      try {
        provider.closeAllConnections?.();
      } catch {}
      provider.close(d);
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
if (cli.version !== '0.9.5') console.error('Warning: expected engine 0.9.5, got ' + cli.version);
const pngBytes = makeFixturePng(FRAME_GEOM.width, FRAME_GEOM.height);
const pngBase64 = pngBytes.toString('base64');
const pngPrefix = pngBase64.slice(0, 48);
const resultsDir = resolve('test-results/cua-integration/native');
await mkdir(resultsDir, { recursive: true });
await writeFile(join(resultsDir, 'native-frame.png'), pngBytes);
const summary = {
  startedAt: new Date().toISOString(),
  engine: { path: cli.path, version: cli.version },
  kernelPython: process.env.PRIME_AGENT_KERNEL_PYTHON || null,
  expectedTools: EXPECTED_TOOLS,
  phases: [],
  checks: [],
  blocked: [],
  passed: false,
};
const proofStart = Date.now();
const PROOF_BUDGET_MS = 8 * 60 * 1000;
function withBudget(promise, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    const left = PROOF_BUDGET_MS - (Date.now() - proofStart);
    timer = setTimeout(() => rej(new Error(label + ' exceeded overall budget')), Math.max(1, left));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
let historyResult = null;
try {
  historyResult = await withBudget(runHistoryCase({ pngBase64, pngPrefix, resultsDir }), 'history-filter');
  summary.phases.push({ ...historyResult, evidence: historyResult.evidence });
  summary.checks.push(
    'History: real engine extension relative helper import + context hook filters oversized HISTORICAL ComputerUse image before provider, logs unchanged',
  );
} catch (e) {
  summary.phases.push({
    label: 'history-filter',
    passed: false,
    error: String(e && e.stack ? e.stack : e).slice(0, 4000),
  });
  console.error('History phase failed:', e);
}
let cuaResult = null;
try {
  cuaResult = await withBudget(runCuaCase({ resultsDir }), 'cua-inspect');
  summary.phases.push({ ...cuaResult, evidence: cuaResult.evidence });
  summary.checks.push(
    'CUA: real engine computer_inspect text frame -> elementId/set_value via bridge owner backend cua, pixel coords untouched, partial truth',
  );
} catch (e) {
  summary.phases.push({
    label: 'cua-inspect',
    passed: false,
    error: String(e && e.stack ? e.stack : e).slice(0, 4000),
  });
  console.error('CUA phase failed:', e);
}
summary.finishedAt = new Date().toISOString();
summary.passed = summary.phases.length === 2 && summary.phases.every((p) => p.passed === true);
await writeFile(join(resultsDir, 'native-cua-proof.json'), JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify(
    {
      passed: summary.passed,
      checks: summary.checks,
      phases: summary.phases.map((p) => ({
        label: p.label,
        passed: p.passed,
        calls: p.calls || null,
        error: p.error || null,
      })),
    },
    null,
    2,
  ),
);
if (!summary.passed) process.exitCode = 1;
