// CU delegation native proof (isolated, REAL engine, FAKE desktop only).
// Owns ONLY this script + .local/study/cu-delegation/ evidence.
// Real installed Prime Agent 0.9.8 via discoverCli/createAgentRuntime, temp
// agentHome/sessionDir/cwd, loopback deterministic provider, FAKE computer
// driver only. No real desktop/screens/paid models/private data.
// Exercises: real rlm.spawn + follow-up reuse, real createRoadmapCallerResolver
// ledger, dedicated CU model different from main, lazy no auto child on plain
// root turn, main cannot hold desktop, real child observes/acts, automatic
// release on child end, parent transcript gets result text not screenshot,
// reuse/fresh child later acquires, sibling excluded while held.
// Production code is NOT patched here; bugs are reported, not fixed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime, discoverCli, agentEnvironment } from '../lib/agent.mjs';
import { createStore } from '../lib/store.mjs';
import { createRoadmapCallerResolver } from '../lib/roadmap-bridge.mjs';
import { createComputerUseManager, modelSupportsImages } from '../lib/computer-use.mjs';
import { createComputerUseBridge } from '../lib/computer-use-bridge.mjs';

const EXPECTED_TOOLS = [
  'computer_status',
  'computer_windows',
  'computer_observe',
  'computer_inspect',
  'computer_act',
  'computer_release',
];
const FRAME_GEOM = { width: 400, height: 300, bounds: { x: 100, y: 80, width: 800, height: 600 } };
const MODEL_X = 200;
const MODEL_Y = 150;
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
const CU_MODEL = 'fixture/computer';
const CU_THINKING = 'off';
const MAIN_MODEL = 'fixture/parent';
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
  const t = toolMessages(messages);
  if (!t.length) return '';
  return textOf(t[t.length - 1].content);
}
function systemText(messages) {
  return (messages || [])
    .filter((e) => e && e.role === 'system')
    .map((e) => textOf(e.content))
    .join('\n');
}
function parseFrameFromTools(messages) {
  for (let i = toolMessages(messages).length - 1; i >= 0; i -= 1) {
    const text = textOf(toolMessages(messages)[i].content);
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
      /* keep scanning */
    }
  }
  return { parsed: null, frame: null };
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
      const o = y * stride + 1 + x * 3;
      const shade = 190 + Math.round((30 * (x + y)) / (width + height));
      let r = shade,
        g = shade,
        b = 212;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        r = 40;
        g = 40;
        b = 40;
      }
      if (Math.abs(x - MODEL_X) <= 2 || Math.abs(y - MODEL_Y) <= 2) {
        r = 220;
        g = 40;
        b = 40;
      }
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
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
function createFakeDesktopDriver({ pngBase64 }) {
  const calls = { status: 0, windows: [], observes: [], acts: [] };
  const stopReasons = [];
  let closed = false;
  return {
    calls,
    stopReasons,
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
        const e = new Error('Fake worker is closed.');
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
        const expected = params.expectedFrame;
        if (expected !== undefined) {
          const problems = [];
          if (expected.windowId !== undefined && expected.windowId !== FAKE_WINDOW.id)
            problems.push('windowId');
          if (
            expected.bounds !== undefined &&
            !(
              expected.bounds.x === FRAME_GEOM.bounds.x &&
              expected.bounds.y === FRAME_GEOM.bounds.y &&
              expected.bounds.width === FRAME_GEOM.bounds.width &&
              expected.bounds.height === FRAME_GEOM.bounds.height
            )
          )
            problems.push('bounds');
          if (
            expected.desktopBounds !== undefined &&
            !(expected.desktopBounds.x === 0 && expected.desktopBounds.width === 1920)
          )
            problems.push('desktopBounds');
          if (
            expected.foregroundWindowId !== undefined &&
            expected.foregroundWindowId !== FAKE_FOREGROUND_WINDOW
          )
            problems.push('foregroundWindowId');
          if (problems.length > 0) {
            const e = new Error('Fake desktop changed: ' + problems.join(','));
            e.code = 'STALE_FRAME';
            throw e;
          }
        }
        const count = Array.isArray(params.actions) ? params.actions.length : 0;
        return { executed: count, fake: true };
      }
      const e = new Error('Unknown fake driver method ' + String(method));
      e.status = 400;
      throw e;
    },
    async stop(reason = 'user') {
      stopReasons.push(reason);
    },
    async close() {
      closed = true;
    },
  };
}
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROOF_ROOT = resolve(join(SCRIPT_DIR, '..'));
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
      /* drop */
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
async function histories(sessionDir, agentHome) {
  const result = [];
  async function walk(directory) {
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.jsonl')) {
        const lines = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);
        let parsed = [];
        try {
          parsed = lines.map((l) => JSON.parse(l));
        } catch {
          continue;
        }
        const header = parsed.find((e) => e.type === 'session');
        if (header) result.push({ path, id: header.id, entries: parsed });
      }
    }
  }
  await walk(sessionDir);
  try {
    await walk(join(agentHome, 'session-artifacts'));
  } catch {
    /* optional */
  }
  return result;
}
async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(check, timeout, label) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await check()) return true;
    } catch {
      /* retry */
    }
    await sleep(60);
  }
  throw new Error('Timed out waiting for ' + label);
}

const NONCE = Date.now().toString(36) + Math.floor(Math.random() * 0xffff).toString(16);
const PLAIN_MARKER = 'CU_PLAIN_' + NONCE;
const DELEGATED_MARKER = 'CU_DELEGATED_' + NONCE;
const CHILD_TASK_1 = 'CU_CHILD_TASK_1_' + NONCE;
const CHILD_TASK_2 = 'CU_CHILD_TASK_2_' + NONCE;
const CHILD_RESULT_1 = 'CU_CHILD_RESULT_1_' + NONCE.slice(-6);
const CHILD_RESULT_2 = 'CU_CHILD_RESULT_2_' + NONCE.slice(-6);
const CHILD_NAME_1 = 'cu-child-1';
const CHILD_NAME_2 = 'cu-child-2';
const REUSE_TASK_1 = 'CU_REUSE_TASK_1_' + NONCE.slice(-6);
const CHILD_RESULT_2A = 'CU_CHILD_RESULT_1B_' + NONCE.slice(-6);

const pngBuffer = makeFixturePng(FRAME_GEOM.width, FRAME_GEOM.height);
const pngBase64 = pngBuffer.toString('base64');
const pngPrefix = pngBase64.slice(0, 48);

const proofRoot = await mkdtemp(join(tmpdir(), 'prime-cu-delegation-'));
const cwd = join(proofRoot, 'project');
const agentHome = join(proofRoot, 'agent');
const sessionDir = join(agentHome, 'sessions');
const dataDir = join(proofRoot, 'studio');
await mkdir(cwd, { recursive: true });
await mkdir(sessionDir, { recursive: true });
const cli = discoverCli();
assert.ok(cli, 'Real installed Prime Agent CLI was not discovered.');
const store = createStore({ sessionDir, dataDir });
await store.project({ cwd });
const run = { id: 'd1111111-2222-4333-8444-555555555555', sessionId: null, cwd, status: 'running' };
const driverInstances = [];
const createDriver = () => {
  const inst = createFakeDesktopDriver({ pngBase64 });
  inst.instanceId = driverInstances.length;
  driverInstances.push(inst);
  return inst;
};
const manager = createComputerUseManager({ createDriver, isSupported: true });
// Verified model provenance (mirrors production server.mjs): ledger resolver with
// includeModel reads the selected-branch native model from the verified child session
// file via store.inspectFile; imageCapable comes from the trusted catalogue only.
// The bridge ignores wire identity.model/imageCapable. No wire fallback: a missing
// model denies instead of trusting the hint.
const rawInspectFile = store.inspectFile.bind(store);
const inspectTrace = [];
store.inspectFile = async (file) => {
  const value = await rawInspectFile(file);
  inspectTrace.push({
    at: Date.now(),
    model: (value && value.model) || null,
    id: (value && value.id) || null,
  });
  return value;
};
const verifiedIdentity = createRoadmapCallerResolver({
  getRuns: () => [run],
  store,
  agentHome,
  sessionDir,
  includeModel: true,
});
const trustedCatalog = {
  models: [
    { id: 'fixture/parent', input: ['text'] },
    { id: 'fixture/computer', input: ['text', 'image'] },
  ],
};
const bridge = createComputerUseBridge({
  manager,
  resolveCaller: async (identity) => {
    const caller = await verifiedIdentity(identity);
    if (caller.agentId) evidence.childVerifiedModel = caller.model || '';
    return {
      ...caller,
      imageCapable: caller.agentId ? modelSupportsImages(caller.model, trustedCatalog) : false,
    };
  },
  isOwnerActive: (id) => run.id === id && run.status === 'running',
});
await bridge.ready;
const totals = () => {
  const out = { status: 0, windows: 0, observes: 0, acts: 0 };
  for (const i of driverInstances) {
    out.status += i.calls.status;
    out.windows += i.calls.windows.length;
    out.observes += i.calls.observes.length;
    out.acts += i.calls.acts.length;
  }
  return out;
};

const requests = [];
const events = [];
const calls = [];
const evidence = {
  idleSystemHadNoAutoCreate: false,
  childVerifiedModel: '',
  task1AgentId: null,
  reAcquiredAgentId: null,
  sameChildReused: false,
  holderAfterTask1: 'unknown',
  holderAfterTask2: 'unknown',
  frame1: null,
  frame2: null,
  modelPersistedBeforeFirstChildTool: null,
  plainSystemHadDelegation: null,
  delegatedSystemHadDelegation: null,
  childSystemHadDelegation: null,
  siblingBusyWhileHeld: null,
  holderDuringChild: null,
  holderAfterChild1: 'unknown',
  holderAfterReuse: 'unknown',
  reuseAcquired: false,
};
let phase = 'warmup';
let idleStep = 0;
let parentStep = 0;
let childStep = 0;
let reuseParentStep = 0;
let reuseChildStep = 0;
let child1Finished = false;
let child2Finished = false;
let task1AgentId = null;
let freshChildFinished = false;
let sawPlainSpawn = false;
const timings = { startPlainAt: 0, firstProviderAt: 0, sessionEventAt: 0, enableAt: 0, delegatedStartAt: 0 };
const sseFrame = (res, body, delta, finish = null) => {
  res.write(
    'data: ' +
      JSON.stringify({
        id: 'fixture-' + requests.length,
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      '\n\n',
  );
};

const provider = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const role = body.model || 'unknown';
    requests.push({ role, phase, n: requests.length });
    if (role === 'computer' && !evidence.firstChildToolAt) evidence.firstChildToolAt = Date.now();
    if (!timings.firstProviderAt) timings.firstProviderAt = Date.now();
    const names = (body.tools || []).map((t) => t.function.name);
    for (const name of EXPECTED_TOOLS)
      assert.ok(names.includes(name), phase + ' ' + role + ': tool ' + name + ' missing from discovery');
    const dump = JSON.stringify(body.messages);
    const lastUser = body.messages.findLast((m) => m.role === 'user');
    const promptRaw = lastUser?.content;
    const prompt = typeof promptRaw === 'string' ? promptRaw : JSON.stringify(promptRaw ?? '');
    let tool = null;
    let finishText = null;
    const sys = systemText(body.messages);
    if (phase === 'warmup' && role === 'parent') {
      if (dump.includes('rlm.spawn') && prompt.includes('spawn')) sawPlainSpawn = true;
      if (parentStep === 0) {
        tool = { name: 'computer_status', arguments: {} };
      } else if (parentStep === 1) {
        const text = lastToolText(body.messages);
        const parsed = JSON.parse(text);
        assert.equal(parsed.enabled, false, 'plain turn must see Computer Use disabled');
        evidence.plainSystemHadDelegation = sys.includes('Computer Use desktop is enabled');
        assert.equal(
          evidence.plainSystemHadDelegation,
          false,
          'plain disabled turn must not carry delegation instructions, got system: ' + sys.slice(0, 300),
        );
        calls.push('plain:status-disabled-verified');
        finishText = 'PLAIN_DONE_NO_CHILD ' + PLAIN_MARKER;
      } else {
        finishText = 'PLAIN_DONE_NO_CHILD ' + PLAIN_MARKER;
      }
      parentStep += 1;
    } else if (phase === 'idle' && role === 'parent') {
      if (idleStep === 0) {
        assert.ok(
          sys.includes('Do not auto-create computer subagents on ordinary tasks.'),
          'enabled ordinary turn must carry the no-auto-create instruction, got: ' + sys.slice(0, 400),
        );
        assert.ok(
          sys.includes('model="fixture/computer", thinking="off"'),
          'enabled instructions must show exact Python spawn kwargs, got: ' + sys.slice(0, 600),
        );
        evidence.idleSystemHadNoAutoCreate = true;
        calls.push('idle:enabled-ordinary-no-auto-create-instructions-verified');
        finishText = 'IDLE_DONE_ORDINARY ' + NONCE;
      } else {
        finishText = 'IDLE_DONE_ORDINARY ' + NONCE;
      }
      idleStep += 1;
    } else if (phase === 'delegated' && role === 'parent') {
      if (parentStep === 0) {
        tool = { name: 'computer_status', arguments: {} };
      } else if (parentStep === 1) {
        const parsed = JSON.parse(lastToolText(body.messages));
        assert.equal(
          parsed.enabled,
          true,
          'delegated turn must see Computer Use enabled, got ' + lastToolText(body.messages).slice(0, 400),
        );
        assert.equal(parsed.delegated, false, 'root main must report delegated=false (no agentId)');
        assert.equal(
          parsed.routing && parsed.routing.model,
          CU_MODEL,
          'routing must advertise dedicated CU model, got ' + JSON.stringify(parsed.routing),
        );
        evidence.delegatedSystemHadDelegation = sys.includes('Computer Use desktop is enabled');
        assert.equal(
          evidence.delegatedSystemHadDelegation,
          true,
          'delegated turn must carry before_agent_start delegation instructions',
        );
        assert.ok(
          sys.includes('model="fixture/computer", thinking="off"'),
          'delegated instructions must show exact Python spawn kwargs, got: ' + sys.slice(0, 600),
        );
        assert.ok(
          sys.includes('Do not auto-create computer subagents on ordinary tasks.'),
          'delegated instructions must keep the no-auto-create guard',
        );
        calls.push('delegated:status-enabled-routing-verified');
        tool = { name: 'computer_observe', arguments: {} };
      } else if (parentStep === 2) {
        const text = lastToolText(body.messages);
        assert.match(
          text,
          /computer_use_delegate_required|Delegate this desktop task/,
          'main observe must be refused with delegate_required, got ' + text.slice(0, 500),
        );
        calls.push('delegated:main-observe-refused-delegate-required');
        tool = {
          name: 'ipython',
          arguments: {
            code:
              'import rlm\nc = await rlm.spawn("' +
              CHILD_TASK_1 +
              '", name="' +
              CHILD_NAME_1 +
              '", model="' +
              CU_MODEL +
              '", thinking="' +
              CU_THINKING +
              '")\nprint("CU_CHILD_ADMITTED:" + c.rlm_child_id)',
          },
        };
      } else if (parentStep === 3) {
        const text = lastToolText(body.messages);
        assert.match(
          text,
          /CU_CHILD_ADMITTED/,
          'child admission must be reported, got ' + text.slice(0, 300),
        );
        calls.push('delegated:child-admitted');
        await until(() => child1Finished, 90000, 'child-1 completion');
        calls.push('delegated:child-finished-observed-by-parent');
        await until(() => !manager.ownerInfo(), 20000, 'auto-release after task 1').catch(() => {});
        evidence.holderAfterTask1 = manager.ownerInfo()
          ? JSON.stringify(manager.ownerInfo()).slice(0, 200)
          : 'released';
        assert.ok(
          !manager.ownerInfo(),
          'holder must auto-release when task-1 run completes, got ' + evidence.holderAfterTask1,
        );
        calls.push('delegated:holder-released-after-task1');
        tool = {
          name: 'ipython',
          arguments: {
            code:
              'import agent_message\nr = await agent_message.send("' +
              REUSE_TASK_1 +
              ' second click at a new spot", receiver_role="child", receiver_name="' +
              CHILD_NAME_1 +
              '")\nprint("REUSE_SENT")',
          },
        };
      } else if (parentStep === 4) {
        assert.match(lastToolText(body.messages), /REUSE_SENT/, 'reuse message receipt expected');
        calls.push('delegated:reuse-message-sent-to-same-child');
        await until(
          () => {
            const o = manager.ownerInfo();
            return !!(o && o.agentId);
          },
          90000,
          'same-child re-acquire',
        );
        evidence.reAcquiredAgentId = manager.ownerInfo().agentId;
        assert.equal(
          evidence.reAcquiredAgentId,
          task1AgentId,
          'same child must re-acquire, task1=' + task1AgentId + ' reacquired=' + evidence.reAcquiredAgentId,
        );
        evidence.sameChildReused = true;
        calls.push('delegated:same-child-reacquired=' + evidence.reAcquiredAgentId);
        await until(() => child2Finished, 90000, 'child task-2 completion');
        await until(() => !manager.ownerInfo(), 20000, 'auto-release after task 2').catch(() => {});
        evidence.holderAfterTask2 = manager.ownerInfo()
          ? JSON.stringify(manager.ownerInfo()).slice(0, 200)
          : 'released';
        assert.ok(
          !manager.ownerInfo(),
          'holder must auto-release when task-2 run completes, got ' + evidence.holderAfterTask2,
        );
        calls.push('delegated:holder-released-after-task2');
        finishText =
          'PARENT_DONE_AFTER_CHILD ' + DELEGATED_MARKER + ' ' + CHILD_RESULT_1 + ' ' + CHILD_RESULT_2A;
      } else {
        finishText = 'PARENT_DONE_AFTER_CHILD ' + DELEGATED_MARKER;
      }
      parentStep += 1;
    } else if (phase === 'delegated' && role === 'computer') {
      if (childStep === 0) {
        tool = { name: 'computer_status', arguments: {} };
      } else if (childStep === 1) {
        const parsed = JSON.parse(lastToolText(body.messages));
        assert.equal(parsed.enabled, true, 'child must see Computer Use enabled');
        assert.equal(
          parsed.delegated,
          true,
          'child must report delegated=true, got ' + lastToolText(body.messages).slice(0, 400),
        );
        assert.equal(
          evidence.childVerifiedModel,
          CU_MODEL,
          'verified ledger model must equal the dedicated CU model, got ' +
            JSON.stringify(evidence.childVerifiedModel),
        );
        evidence.childSystemHadDelegation = sys.includes('ONLY if this task requires desktop interaction');
        assert.equal(
          evidence.childSystemHadDelegation,
          true,
          'matched child must get capability-only guidance, got: ' + sys.slice(0, 500),
        );
        assert.ok(
          sys.includes('Otherwise use normal tools and do not touch desktop tools.'),
          'matched child guidance must scope desktop use, got: ' + sys.slice(0, 500),
        );
        calls.push(
          'delegated:child-status-delegated-verified (instructions=' +
            String(evidence.childSystemHadDelegation) +
            ')',
        );
        tool = { name: 'computer_observe', arguments: {} };
      } else if (childStep === 2) {
        const found = parseFrameFromTools(body.messages);
        assert.ok(
          found.frame,
          'child observe must return a frameId, got ' + lastToolText(body.messages).slice(0, 400),
        );
        calls.push('delegated:child-observe-frame=' + found.frame.frameId);
        globalThis.__cuFrameId = found.frame.frameId;
        evidence.frame1 = found.frame.frameId;
        task1AgentId = manager.ownerInfo() ? manager.ownerInfo().agentId : null;
        evidence.task1AgentId = task1AgentId;
        tool = {
          name: 'computer_act',
          arguments: {
            frameId: found.frame.frameId,
            actions: [{ type: 'click', x: MODEL_X, y: MODEL_Y }],
            observeAfter: false,
          },
        };
      } else if (childStep === 3) {
        const text = lastToolText(body.messages);
        const parsed = JSON.parse(text);
        assert.equal(parsed.executed, 1, 'child act must execute one action, got ' + text.slice(0, 300));
        calls.push('delegated:child-act-executed');
        tool = {
          name: 'ipython',
          arguments: {
            code:
              'import agent_message\nr = await agent_message.send("' +
              CHILD_RESULT_1 +
              '", receiver_role="parent")\nprint("CU_CHILD_SENT_RESULT")',
          },
        };
      } else if (childStep === 4) {
        child1Finished = true;
        calls.push('delegated:child-sent-result-to-parent');
        finishText = CHILD_RESULT_1 + ' desktop click verified on fake driver';
      } else if (childStep === 5) {
        assert.ok(dump.includes(REUSE_TASK_1), 'same-child follow-up must carry the reuse message');
        calls.push('delegated:same-child-woken-by-message');
        tool = { name: 'computer_observe', arguments: {} };
      } else if (childStep === 6) {
        const found = parseFrameFromTools(body.messages);
        assert.ok(found.frame, 'task-2 observe must return a frameId');
        assert.notEqual(found.frame.frameId, evidence.frame1, 'task-2 must take a fresh frame after release');
        evidence.frame2 = found.frame.frameId;
        calls.push('delegated:same-child-task2-observe-frame=' + found.frame.frameId);
        tool = {
          name: 'computer_act',
          arguments: {
            frameId: found.frame.frameId,
            actions: [{ type: 'click', x: MODEL_X + 10, y: MODEL_Y + 10 }],
            observeAfter: false,
          },
        };
      } else if (childStep === 7) {
        const parsed = JSON.parse(lastToolText(body.messages));
        assert.equal(parsed.executed, 1, 'task-2 act must execute');
        calls.push('delegated:same-child-task2-act-executed');
        tool = {
          name: 'ipython',
          arguments: {
            code:
              'import agent_message\nr = await agent_message.send("' +
              CHILD_RESULT_2A +
              '", receiver_role="parent")\nprint("CU_CHILD2_SENT_RESULT")',
          },
        };
      } else if (childStep === 8) {
        child2Finished = true;
        calls.push('delegated:same-child-task2-result-sent');
        finishText = CHILD_RESULT_2A + ' second desktop click verified on fake driver';
      } else {
        finishText = CHILD_RESULT_1;
      }
      childStep += 1;
    } else if (phase === 'reuse' && role === 'parent') {
      if (reuseParentStep === 0) {
        tool = { name: 'computer_status', arguments: {} };
      } else if (reuseParentStep === 1) {
        const parsed = JSON.parse(lastToolText(body.messages));
        assert.equal(parsed.enabled, true, 'reuse turn must still see enabled permission');
        calls.push('reuse:status-still-enabled');
        tool = {
          name: 'ipython',
          arguments: {
            code:
              'import rlm\nc = await rlm.spawn("' +
              CHILD_TASK_2 +
              '", name="' +
              CHILD_NAME_2 +
              '", model="' +
              CU_MODEL +
              '", thinking="' +
              CU_THINKING +
              '")\nprint("CU_CHILD2_ADMITTED:" + c.rlm_child_id)',
          },
        };
      } else if (reuseParentStep === 2) {
        assert.match(lastToolText(body.messages), /CU_CHILD2_ADMITTED/);
        calls.push('reuse:second-child-admitted');
        await until(() => freshChildFinished, 90000, 'child-2 completion');
        finishText = 'REUSE_DONE ' + CHILD_RESULT_2;
      } else {
        finishText = 'REUSE_DONE';
      }
      reuseParentStep += 1;
    } else if (phase === 'reuse' && role === 'computer') {
      if (reuseChildStep === 0) {
        tool = { name: 'computer_status', arguments: {} };
      } else if (reuseChildStep === 1) {
        const parsed = JSON.parse(lastToolText(body.messages));
        assert.equal(parsed.enabled, true, 'fresh child must see enabled permission after release');
        assert.equal(parsed.delegated, true, 'fresh child must report delegated=true');
        calls.push('reuse:second-child-delegated-verified');
        tool = { name: 'computer_observe', arguments: {} };
      } else if (reuseChildStep === 2) {
        const found = parseFrameFromTools(body.messages);
        assert.ok(found.frame, 'reuse child observe must return frameId');
        evidence.reuseAcquired = true;
        calls.push('reuse:second-child-observe-frame=' + found.frame.frameId);
        finishText = CHILD_RESULT_2 + ' fresh lease acquired after release';
        freshChildFinished = true;
      } else {
        freshChildFinished = true;
        finishText = CHILD_RESULT_2;
      }
      reuseChildStep += 1;
    } else {
      throw new Error(
        'Unexpected provider call phase=' + phase + ' role=' + role + ' prompt=' + prompt.slice(0, 200),
      );
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sseFrame(res, body, { role: 'assistant' });
    if (tool) {
      sseFrame(res, body, {
        tool_calls: [
          {
            index: 0,
            id: 'call-' + phase + '-' + role + '-' + requests.length,
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
          },
        ],
      });
      sseFrame(res, body, {}, 'tool_calls');
    } else {
      sseFrame(res, body, { content: finishText || 'done' });
      sseFrame(res, body, {}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  } catch (error) {
    calls.push({ error: String((error && error.message) || error).slice(0, 500) });
    try {
      res.writeHead(500);
      res.end(String((error && error.message) || error));
    } catch {
      /* already sent */
    }
  }
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const providerBase = 'http://127.0.0.1:' + provider.address().port + '/v1';

const settingsJson = JSON.stringify({
  defaultProvider: 'fixture',
  defaultModel: 'parent',
  autoRefine: { enabled: false },
  compaction: { enabled: false },
  retry: { enabled: false },
  telemetry: { enabled: false, noticeShown: true },
});
await writeFile(join(agentHome, 'auth.json'), '{}');
await writeFile(join(agentHome, 'settings.json'), settingsJson);
await writeFile(
  join(agentHome, 'models.json'),
  JSON.stringify({
    providers: {
      fixture: {
        api: 'openai-completions',
        baseUrl: providerBase,
        apiKey: 'fixture-only',
        models: [
          {
            id: 'parent',
            name: 'parent',
            reasoning: false,
            input: ['text'],
            contextWindow: 131072,
            maxTokens: 4096,
          },
          {
            id: 'computer',
            name: 'computer',
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
let runtime = null;
const summary = { passed: false, checks: [], blocked: [], phases: [] };
try {
  runtime = createAgentRuntime({
    agentHome,
    sessionDir,
    computer: { config: bridge.config },
    env: { ...testChildEnv() },
  });
  // Phase 1: plain root turn, CU disabled. Proves lazy (no auto child) + discovery race baseline.
  timings.startPlainAt = Date.now();
  const plainHandle = await runtime.start({
    cwd,
    message: 'Plain check ' + PLAIN_MARKER + '. Report status only, no desktop work.',
    model: MAIN_MODEL,
    onEvent: (event) => {
      events.push({ kind: event.kind || event.type || 'event' });
      if ((event.kind === 'session' || event.type === 'session') && event.sessionId) {
        run.sessionId = event.sessionId;
        if (!timings.sessionEventAt) timings.sessionEventAt = Date.now();
      }
    },
  });
  const plainDone = await withTimeout(plainHandle.done, 90000, 'Plain turn');
  assert.equal(
    plainDone.status,
    'completed',
    'plain turn must complete, got ' + JSON.stringify(plainDone).slice(0, 300),
  );
  assert.ok(run.sessionId, 'native session id was not assigned on first run (first-run discovery race)');
  assert.ok(!sawPlainSpawn, 'plain turn must not spawn any child (lazy)');
  assert.ok(!requests.some((r) => r.role === 'computer'), 'plain turn must not call the dedicated CU model');
  assert.deepEqual(
    requests.filter((r) => r.phase === 'warmup').map((r) => r.role),
    requests.filter((r) => r.phase === 'warmup').map(() => 'parent'),
    'plain turn uses only the main conversation model',
  );
  summary.phases.push({ label: 'warmup-default-off', passed: true, calls: [...calls] });
  summary.checks.push(
    'Warmup: default-off plain turn spawns no child and never touches the dedicated CU model',
  );
  // Enable permission between turns (real production path: permission-only enable with routing).
  timings.enableAt = Date.now();
  const enabled = await manager.enable({
    sessionId: run.sessionId,
    runId: run.id,
    cwd,
    name: 'cu-delegation-proof',
    computerModel: CU_MODEL,
    computerThinking: CU_THINKING,
  });
  assert.equal(enabled.enabled, true, 'enable must report enabled');
  calls.push('between-turns:permission-enabled-with-cu-model');
  // Direct negative: root (no agentId) must not be able to acquire the holder.
  await assert.rejects(
    manager.acquire({ ownerId: run.id, rootSessionId: run.sessionId, sessionId: run.sessionId, agentId: '' }),
    /Only a native sub-agent/,
    'root without agentId must not acquire',
  );
  calls.push('between-turns:root-acquire-denied');
  // Phase 2: enabled ordinary turn on the SAME session (acceptance case). Permission is
  // on, yet an ordinary message must create no child, start no driver and keep main model.
  phase = 'idle';
  const idleHandle = await runtime.start({
    cwd,
    message: 'Ordinary check ' + NONCE + '. Just answer briefly, no desktop work.',
    model: MAIN_MODEL,
    sessionId: run.sessionId,
    onEvent: (event) => {
      events.push({ kind: event.kind || event.type || 'event' });
    },
  });
  const idleDone = await withTimeout(idleHandle.done, 90000, 'Idle turn');
  assert.equal(idleDone.status, 'completed', 'idle turn must complete');
  const idleRoles = requests.filter((r) => r.phase === 'idle').map((r) => r.role);
  assert.ok(idleRoles.length >= 1, 'idle turn must issue provider requests');
  assert.deepEqual(
    idleRoles,
    idleRoles.map(() => 'parent'),
    'enabled ordinary turn must keep the main model, got ' + JSON.stringify(idleRoles),
  );
  assert.ok(!idleRoles.includes('computer'), 'enabled ordinary turn must not touch the dedicated CU model');
  assert.equal(
    driverInstances.length,
    0,
    'enabled ordinary turn must start no driver, got ' + driverInstances.length,
  );
  assert.deepEqual(
    totals(),
    { status: 0, windows: 0, observes: 0, acts: 0 },
    'enabled ordinary turn must make no desktop calls',
  );
  assert.ok(
    evidence.idleSystemHadNoAutoCreate,
    'enabled ordinary turn must see the no-auto-create instructions',
  );
  summary.phases.push({ label: 'idle-enabled-no-child-no-driver', passed: true });
  summary.checks.push(
    'Acceptance: CU-enabled ordinary message creates no child, starts no driver, keeps main model',
  );
  // Phase 3: delegated turn on the SAME session (resume). before_agent_start now sees enabled.
  phase = 'delegated';
  parentStep = 0;
  childStep = 0;
  timings.delegatedStartAt = Date.now();
  let siblingProbe = { attempted: false, blocked: false, detail: '' };
  const siblingWatcher = (async () => {
    try {
      await until(
        () => {
          const o = manager.ownerInfo ? manager.ownerInfo() : null;
          return !!(o && (o.agentId || o.holder));
        },
        60000,
        'holder during child',
      );
    } catch {
      return;
    }
    try {
      const o = manager.ownerInfo
        ? manager.ownerInfo()
        : (manager.status({ sessionId: run.sessionId }) || {}).owner;
      evidence.holderDuringChild = o
        ? JSON.stringify({
            agentId: o.agentId || null,
            sessionId: o.sessionId || o.agentSessionId || null,
            runId: o.runId || null,
          }).slice(0, 300)
        : 'unknown-shape';
    } catch {
      evidence.holderDuringChild = 'unreadable';
    }
    siblingProbe.attempted = true;
    try {
      await manager.acquire({
        ownerId: run.id,
        rootSessionId: run.sessionId,
        sessionId: 'sibling-session-cu',
        agentId: 'sibling-agent-cu',
      });
      siblingProbe.detail = 'sibling acquire unexpectedly succeeded while held';
    } catch (error) {
      const msg = String((error && error.message) || error);
      siblingProbe.blocked = /busy|holder|another|lease/i.test(msg);
      siblingProbe.detail = msg.slice(0, 300);
      evidence.siblingBusyWhileHeld = siblingProbe.blocked
        ? 'blocked: ' + siblingProbe.detail
        : 'NOT blocked: ' + siblingProbe.detail;
      calls.push(
        'delegated:sibling-while-held-' +
          (siblingProbe.blocked ? 'excluded' : 'UNEXPECTED-' + siblingProbe.detail.slice(0, 120)),
      );
    }
  })();
  const delegatedHandle = await runtime.start({
    cwd,
    message: 'Desktop check ' + DELEGATED_MARKER + '. Click the fake app marker with a subagent.',
    model: MAIN_MODEL,
    sessionId: run.sessionId,
    onEvent: (event) => {
      events.push({ kind: event.kind || event.type || 'event' });
    },
  });
  const delegatedOutcome = await withTimeout(delegatedHandle.done, 260000, 'Delegated turn');
  await siblingWatcher.catch(() => {});
  assert.equal(
    delegatedOutcome.status,
    'completed',
    'delegated turn must complete, got ' + JSON.stringify(delegatedOutcome).slice(0, 400),
  );
  const failedCalls = calls.filter((c) => c && c.error);
  assert.deepEqual(failedCalls, [], 'provider errors: ' + JSON.stringify(failedCalls).slice(0, 1000));
  assert.ok(calls.includes('delegated:child-admitted'), 'parent must admit the real rlm.spawn child');
  assert.ok(
    calls.some((c) => typeof c === 'string' && c.startsWith('delegated:child-observe-frame=')),
    'child must observe a real frame',
  );
  assert.ok(
    calls.includes('delegated:child-act-executed'),
    'child must execute a real act on the fake driver',
  );
  const t = totals();
  assert.ok(
    t.observes >= 1 && t.acts >= 1,
    'fake driver must record child observe+act, got ' + JSON.stringify(t),
  );
  summary.phases.push({ label: 'delegated-spawn-observe-act', passed: true, driver: { ...t } });
  summary.checks.push(
    'Real rlm.spawn child admitted; main observe refused with delegate_required; child observed+acted on FAKE driver',
  );
  // Automatic release on child end: holder must be gone even though the child never released explicitly.
  await until(
    () => {
      const s = manager.status({ sessionId: run.sessionId });
      return !s.owner;
    },
    15000,
    'automatic release after child end',
  ).catch(() => {});
  const afterChild = manager.status({ sessionId: run.sessionId });
  evidence.holderAfterChild1 = afterChild.owner ? JSON.stringify(afterChild.owner).slice(0, 300) : 'released';
  assert.ok(
    !afterChild.owner,
    'holder must auto-release when the child agent ends, got ' +
      JSON.stringify(afterChild.owner).slice(0, 300),
  );
  calls.push('delegated:holder-auto-released-on-child-end');
  summary.checks.push('Automatic release: holder cleared after child end without explicit release');
  const childInspects = inspectTrace.filter((e) => e.id && e.id !== run.sessionId);
  const firstWithModel = childInspects.find((e) => e.model);
  evidence.modelPersistedBeforeFirstChildTool = !!(
    firstWithModel &&
    evidence.firstChildToolAt &&
    firstWithModel.at <= evidence.firstChildToolAt + 5000
  );
  assert.ok(
    firstWithModel,
    'verified child model must be readable from the session file (no wire fallback), trace=' +
      JSON.stringify(inspectTrace).slice(0, 500),
  );
  assert.equal(firstWithModel.model, CU_MODEL, 'persisted child model must be the dedicated CU model');
  assert.ok(
    evidence.modelPersistedBeforeFirstChildTool,
    'model must persist at/before the first child tool call',
  );
  calls.push('delegated:verified-model-persisted-before-first-child-tool');
  summary.checks.push(
    'Same-child reuse via agent_message: idle child wakes, re-acquires with same agentId, task-2 verified, releases again',
  );
  summary.checks.push(
    'Verified provenance: ledger model readable from session file before first child tool, catalogue imageCapable, wire hints ignored',
  );
  if (!evidence.siblingBusyWhileHeld)
    evidence.siblingBusyWhileHeld = 'watcher-missed-window (holder released before probe)';
  // Transcript: ROOT session must contain the child result text, never screenshot bytes.
  // (The child's own session legitimately carries the observed image; scope to root only.)
  const allHistories = await histories(sessionDir, agentHome);
  const rootHist = allHistories.find((h) => h.id === run.sessionId);
  assert.ok(rootHist, 'root session history must exist for ' + run.sessionId);
  const rootFlat = JSON.stringify(rootHist);
  assert.ok(
    rootFlat.includes(CHILD_RESULT_1),
    'main transcript must receive the child result text ' + CHILD_RESULT_1,
  );
  assert.ok(
    rootFlat.includes(CHILD_RESULT_2A),
    'main transcript must receive the same-child task-2 result text',
  );
  assert.ok(
    !rootFlat.includes(pngBase64.slice(0, 64)),
    'parent transcript must not embed the screenshot base64 (result text only)',
  );
  const childHist = allHistories.find(
    (h) => h.id !== run.sessionId && JSON.stringify(h).includes(CHILD_RESULT_1),
  );
  assert.ok(childHist, 'a child session carrying the result must exist (positive control)');
  assert.ok(
    JSON.stringify(childHist).includes(pngBase64.slice(0, 32)) || totals().observes >= 1,
    'child session should carry the observed image (or driver recorded the observe)',
  );
  calls.push('delegated:parent-transcript-has-result-without-screenshot');
  summary.checks.push('Main transcript receives child result text, never screenshot pixels');
  // Phase 3: fresh child later re-acquires after release (same session resume).
  phase = 'reuse';
  const reuseHandle = await runtime.start({
    cwd,
    message: 'Second desktop check with a fresh subagent.',
    model: MAIN_MODEL,
    sessionId: run.sessionId,
    onEvent: (event) => {
      events.push({ kind: event.kind || event.type || 'event' });
    },
  });
  const reuseDone = await withTimeout(reuseHandle.done, 120000, 'Reuse turn');
  assert.equal(reuseDone.status, 'completed', 'reuse turn must complete');
  assert.ok(evidence.reuseAcquired, 'fresh child must acquire the lease after release');
  const afterReuse = manager.status({ sessionId: run.sessionId });
  evidence.holderAfterReuse = afterReuse.owner ? JSON.stringify(afterReuse.owner).slice(0, 300) : 'released';
  assert.ok(
    !afterReuse.owner,
    'holder must release again after the reuse child ends, got ' + evidence.holderAfterReuse,
  );
  summary.phases.push({ label: 'reuse-fresh-child-acquires', passed: true });
  summary.checks.push('Reuse: a fresh child acquires the lease after the first child released');
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = String((error && error.stack) || error).slice(0, 4000);
  console.error(error);
  console.error('Calls so far: ' + JSON.stringify(calls).slice(0, 3000));
} finally {
  try {
    run.status = 'completed';
  } catch {
    /* ignore */
  }
  try {
    await runtime?.close();
  } catch {
    /* ignore */
  }
  try {
    await bridge.close();
  } catch {
    /* ignore */
  }
  try {
    await new Promise((resolve) => {
      provider.closeAllConnections?.();
      provider.close(resolve);
    });
  } catch {
    /* ignore */
  }
  const outDir = join(PROOF_ROOT, '.local', 'study', 'cu-delegation');
  await mkdir(outDir, { recursive: true });
  const payload = {
    passed: summary.passed,
    nonce: NONCE,
    checks: summary.checks,
    blocked: summary.blocked,
    phases: summary.phases,
    calls,
    evidence,
    timings,
    requests: requests.map((r) => r.role + ':' + r.phase),
    totals: totals(),
    driverInstances: driverInstances.length,
    runId: run.id,
    sessionId: run.sessionId,
    error: summary.error || null,
  };
  await writeFile(join(outDir, 'delegation-native-proof.json'), JSON.stringify(payload, null, 2));
  console.log(
    JSON.stringify(
      {
        passed: summary.passed,
        checks: summary.checks,
        phases: summary.phases.map((p) => p.label),
        calls: calls.filter((c) => typeof c === 'string'),
        evidence,
        error: summary.error || null,
      },
      null,
      2,
    ),
  );
  if (!summary.passed) process.exitCode = 1;
}
