import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createComputerUseManager } from '../lib/computer-use.mjs';
import { createComputerUseBridge } from '../lib/computer-use-bridge.mjs';

register('./typebox-hook.mjs', import.meta.url);

const IMAGE = Buffer.from('extension-screenshot').toString('base64');
let extensionSeq = 0;

function fakeDriver() {
  const calls = [];
  const driver = {
    calls,
    async request(command) {
      calls.push(command);
      if (command.method === 'status') return { supported: true, platform: 'win32' };
      if (command.method === 'windows') return { windows: [] };
      if (command.method === 'observe')
        return {
          image: { data: IMAGE, mimeType: 'image/jpeg' },
          frame: {
            width: 640,
            height: 480,
            bounds: { x: 0, y: 0, width: 640, height: 480 },
            capturedAt: 't',
          },
        };
      if (command.method === 'act') return { executed: command.params.actions.length };
      throw new Error(`unexpected ${command.method}`);
    },
    async stop() {},
    async close() {},
  };
  return driver;
}

const caller = {
  cwd: '/tmp/p',
  sessionId: 'sess-1',
  rootSessionId: 'sess-1',
  ownerId: 'run-1',
  name: 'Prime Agent',
};
const ctx = {
  cwd: '/tmp/p',
  sessionManager: { getSessionId: () => 'sess-1', getSessionFile: () => '/tmp/p/sess-1.jsonl' },
};

const COMPUTER_MODEL = 'acme/vis-model';
const COMPUTER_THINKING = 'high';
const childCaller = {
  cwd: '/tmp/p',
  sessionId: 'sess-child-1',
  rootSessionId: 'sess-1',
  ownerId: 'run-1',
  agentId: 'agent-1',
  name: 'child',
  // Trusted native provenance: bridge authorizes caller.model/imageCapable only.
  // Extension identity.model/imageCapable is hint-only and ignored for auth.
  model: COMPUTER_MODEL,
  imageCapable: true,
};
const mainCaller = {
  cwd: '/tmp/p',
  sessionId: 'sess-1',
  rootSessionId: 'sess-1',
  ownerId: 'run-1',
  name: 'Prime Agent',
  model: 'other/model',
  imageCapable: false,
};
const childCtx = {
  cwd: '/tmp/p',
  sessionManager: {
    getSessionId: () => 'sess-child-1',
    getSessionFile: () => '/tmp/p/sess-child-1.jsonl',
  },
  model: { provider: 'acme', id: 'vis-model', input: ['text', 'image'] },
};
const mainCtx = {
  cwd: '/tmp/p',
  sessionManager: { getSessionId: () => 'sess-1', getSessionFile: () => '/tmp/p/sess-1.jsonl' },
  model: { provider: 'other', id: 'model', input: ['text'] },
};

async function startCodedStubBridge(t, handler) {
  const { createServer } = await import('node:http');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { unlink } = await import('node:fs/promises');
  const token = `stub-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\prime-test-coded-${Date.now()}-${Math.random().toString(16).slice(2)}`
      : join(tmpdir(), `prime-test-coded-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`);
  const calls = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.push(input);
      const out = await handler(input, calls);
      if (out && typeof out === 'object' && Number.isInteger(out.status) && 'body' in out) {
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      }
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: String(error?.message || error),
          code: error?.code || 'computer_use_failed',
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  if (process.platform !== 'win32') t.after(() => unlink(socketPath).catch(() => {}));
  return { config: { socketPath, token }, calls };
}

async function loadExtension(t, config) {
  process.env.PRIME_STUDIO_COMPUTER_USE_CONFIG = JSON.stringify(config);
  t.after(() => {
    delete process.env.PRIME_STUDIO_COMPUTER_USE_CONFIG;
  });
  extensionSeq += 1;
  const module = await import(
    `../runtime/studio-computer-use-extension.mjs?ext=${Date.now()}-${extensionSeq}-${Math.random().toString(16).slice(2)}`
  );
  const tools = new Map();
  const events = new Map();
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, handler) => events.set(name, handler),
  };
  module.default(pi);
  return { tools, events };
}

async function startStubBridge(t, handler) {
  const { createServer } = await import('node:http');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { unlink } = await import('node:fs/promises');
  const token = `stub-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\prime-test-computer-${Date.now()}-${Math.random().toString(16).slice(2)}`
      : join(tmpdir(), `prime-test-computer-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`);
  const calls = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.push(input);
      const result = await handler(input, calls);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  if (process.platform !== 'win32') t.after(() => unlink(socketPath).catch(() => {}));
  return { config: { socketPath, token }, calls };
}

test('extension registers desktop tools and returns ImageContent for observe', async (t) => {
  const manager = createComputerUseManager({ createDriver: fakeDriver, isSupported: true });
  const bridge = createComputerUseBridge({ manager, resolveCaller: async () => childCaller });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  const { tools } = await loadExtension(t, bridge.config);
  for (const name of [
    'computer_status',
    'computer_windows',
    'computer_observe',
    'computer_act',
    'computer_release',
  ])
    assert.ok(tools.has(name), `missing ${name}`);

  const observe = tools.get('computer_observe');
  await assert.rejects(observe.execute('id', {}, null, null, mainCtx), /Enable it in Studio/);
  await manager.enable({
    sessionId: 'sess-1',
    runId: 'run-1',
    cwd: '/tmp/p',
    computerModel: COMPUTER_MODEL,
    computerThinking: COMPUTER_THINKING,
  });
  const shot = await observe.execute('id', {}, null, null, childCtx);
  assert.equal(shot.content[0].type, 'image');
  assert.equal(shot.content[0].mimeType, 'image/jpeg');
  assert.equal(typeof shot.content[0].data, 'string');
  assert.ok(!JSON.stringify(shot.content[0]).includes('base64,text'));
  assert.ok(shot.details.frame.frameId);

  const act = tools.get('computer_act');
  const done = await act.execute(
    'id',
    { frameId: shot.details.frame.frameId, actions: [{ type: 'click', x: 10, y: 10 }] },
    null,
    null,
    childCtx,
  );
  assert.match(JSON.stringify(done), /executed/);
  await assert.rejects(
    act.execute(
      'id',
      { frameId: shot.details.frame.frameId, actions: [{ type: 'click', x: 10, y: 10 }] },
      null,
      null,
      childCtx,
    ),
    /stale/i,
  );
});

test('extension act with observeAfter returns a verification ImageContent', async (t) => {
  const manager = createComputerUseManager({ createDriver: fakeDriver, isSupported: true });
  const bridge = createComputerUseBridge({ manager, resolveCaller: async () => childCaller });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  const { tools } = await loadExtension(t, bridge.config);
  await manager.enable({
    sessionId: 'sess-1',
    runId: 'run-1',
    cwd: '/tmp/p',
    computerModel: COMPUTER_MODEL,
    computerThinking: COMPUTER_THINKING,
  });
  const shot = await tools.get('computer_observe').execute('id', {}, null, null, childCtx);
  const result = await tools
    .get('computer_act')
    .execute(
      'id',
      { frameId: shot.details.frame.frameId, actions: [{ type: 'wait', ms: 5 }], observeAfter: true },
      null,
      null,
      childCtx,
    );
  assert.equal(result.content[0].type, 'image');
  assert.ok(result.details.frame.frameId !== shot.details.frame.frameId);
});

test('computer status reports the true off state without spawning the worker', async (t) => {
  let spawned = 0;
  const counting = () => {
    spawned++;
    return fakeDriver();
  };
  const manager = createComputerUseManager({ createDriver: counting, isSupported: true });
  const bridge = createComputerUseBridge({ manager, resolveCaller: async () => caller });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  const { tools } = await loadExtension(t, bridge.config);
  const status = await tools.get('computer_status').execute('id', {}, null, null, ctx);
  const data = JSON.parse(status.content[0].text);
  assert.equal(data.enabled, false);
  assert.equal(data.mine, false);
  assert.equal(data.driver, null);
  assert.equal(spawned, 0);
});

test('extension rejects over-cap wait, path and scroll values', async (t) => {
  const manager = createComputerUseManager({ createDriver: fakeDriver, isSupported: true });
  const bridge = createComputerUseBridge({ manager, resolveCaller: async () => childCaller });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  const { tools } = await loadExtension(t, bridge.config);
  await manager.enable({
    sessionId: 'sess-1',
    runId: 'run-1',
    cwd: '/tmp/p',
    computerModel: COMPUTER_MODEL,
    computerThinking: COMPUTER_THINKING,
  });
  const shot = await tools.get('computer_observe').execute('id', {}, null, null, childCtx);
  const frameId = shot.details.frame.frameId;
  const act = tools.get('computer_act');
  await assert.rejects(
    act.execute('id', { frameId, actions: [{ type: 'wait', ms: 5001 }] }, null, null, childCtx),
    /5000/,
  );
  await assert.rejects(
    act.execute('id', { frameId, actions: [{ type: 'scroll', deltaY: 101 }] }, null, null, childCtx),
    /100/,
  );
  await assert.rejects(
    act.execute(
      'id',
      {
        frameId,
        actions: [{ type: 'drag', x: 1, y: 1, path: Array.from({ length: 21 }, () => ({ x: 1, y: 1 })) }],
      },
      null,
      null,
      childCtx,
    ),
    /20/,
  );
});

test('windows wait schema exposes bounded filters and requires one nonempty filter', async (t) => {
  const stub = await startStubBridge(t, async () => ({ windows: [] }));
  const { tools } = await loadExtension(t, stub.config);
  const windows = tools.get('computer_windows');
  const properties = windows.parameters?.properties || {};
  for (const key of ['action', 'windowId', 'processName', 'title', 'timeoutMs']) {
    assert.ok(properties[key], `missing windows parameter ${key}`);
  }
  assert.match(windows.description, /wait/i);
  assert.match(windows.description, /read-only/i);
  assert.match(windows.description, /found/i);
  assert.match(windows.description, /timedOut/i);
  assert.match(windows.description, /observe that window/i);
  assert.match(windows.description, /stale frame/i);
  const before = stub.calls.length;
  await assert.rejects(windows.execute('id', { action: 'wait' }, null, null, ctx), /at least one.*filter/i);
  await assert.rejects(
    windows.execute('id', { action: 'wait', processName: '   ', title: '' }, null, null, ctx),
    /at least one.*filter/i,
  );
  await assert.rejects(
    windows.execute('id', { action: 'wait', title: 'Qobuz', timeoutMs: 50 }, null, null, ctx),
    /timeoutMs/i,
  );
  await assert.rejects(
    windows.execute('id', { action: 'wait', title: 'Qobuz', timeoutMs: 25000 }, null, null, ctx),
    /timeoutMs/i,
  );
  assert.equal(stub.calls.length, before);
});

test('windows wait forwards filters and preserves the contracted wait response', async (t) => {
  const foundWindow = {
    id: 'w-qobuz',
    title: 'Qobuz',
    processName: 'Qobuz.exe',
    foreground: false,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  };
  const stub = await startStubBridge(t, async (input) => {
    if (input.action === 'windows' && input.params?.action === 'wait') {
      return {
        found: true,
        timedOut: false,
        window: foundWindow,
        windows: [foundWindow],
        elapsedMs: 320,
        note: 'Window observed within budget.',
      };
    }
    if (input.action === 'windows') return { windows: [foundWindow] };
    return {};
  });
  const { tools } = await loadExtension(t, stub.config);
  const result = await tools
    .get('computer_windows')
    .execute(
      'id',
      { action: 'wait', processName: 'qobuz.exe', title: 'qobuz', timeoutMs: 10000 },
      null,
      null,
      ctx,
    );
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].params.action, 'wait');
  assert.equal(stub.calls[0].params.processName, 'qobuz.exe');
  assert.equal(stub.calls[0].params.title, 'qobuz');
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.found, true);
  assert.equal(data.timedOut, false);
  assert.deepEqual(data.window, foundWindow);
  assert.equal(data.elapsedMs, 320);
  assert.equal(typeof data.note, 'string');
  assert.equal(result.details.action, 'computer_windows');

  const timeoutStub = await startStubBridge(t, async () => ({
    found: false,
    timedOut: true,
    windows: [],
    elapsedMs: 10000,
    note: 'Window was not seen within budget.',
  }));
  const timeoutLoaded = await loadExtension(t, timeoutStub.config);
  const missed = await timeoutLoaded.tools
    .get('computer_windows')
    .execute('id', { action: 'wait', windowId: 'w-missing', timeoutMs: 1000 }, null, null, ctx);
  const missedData = JSON.parse(missed.content[0].text);
  assert.equal(missedData.found, false);
  assert.equal(missedData.timedOut, true);
  assert.equal(missedData.elapsedMs, 10000);
});

test('act observeOptions schema exists and is gated on observeAfter true', async (t) => {
  const stub = await startStubBridge(t, async () => ({}));
  const { tools } = await loadExtension(t, stub.config);
  const act = tools.get('computer_act');
  const properties = act.parameters?.properties || {};
  assert.ok(properties.observeOptions, 'missing act observeOptions');
  const scope = properties.observeOptions?.schema?.properties || properties.observeOptions?.properties || {};
  assert.ok(scope.windowId || properties.observeOptions, 'observeOptions should carry window scope');
  assert.match(act.description, /observeOptions/i);
  assert.match(act.description, /observeAfter/i);
  assert.match(act.description, /applicationState/i);
  assert.match(act.description, /observationError/i);
  assert.match(act.description, /point-in-time/i);
  const before = stub.calls.length;
  await assert.rejects(
    act.execute(
      'id',
      { frameId: 'f1', actions: [{ type: 'wait', ms: 5 }], observeOptions: { windowId: 'w1' } },
      null,
      null,
      ctx,
    ),
    /observeAfter/i,
  );
  await assert.rejects(
    act.execute(
      'id',
      {
        frameId: 'f1',
        actions: [{ type: 'wait', ms: 5 }],
        observeAfter: false,
        observeOptions: {},
      },
      null,
      null,
      ctx,
    ),
    /observeAfter/i,
  );
  assert.equal(stub.calls.length, before);
});

test('act forwards observeOptions and preserves verification metadata without image bytes', async (t) => {
  const frame = {
    frameId: 'f-verify',
    width: 640,
    height: 480,
    bounds: { x: 0, y: 0, width: 640, height: 480 },
    capturedAt: 't',
  };
  const stub = await startStubBridge(t, async (input) => {
    if (input.action === 'act' && input.params?.observeOptions?.windowId === 'w-new') {
      return {
        executed: 1,
        applicationState: 'unverified',
        observe: { image: { data: IMAGE, mimeType: 'image/jpeg' }, frame },
      };
    }
    if (input.action === 'act' && input.params?.observeAfter === true) {
      return {
        executed: 1,
        applicationState: 'unverified',
        observe: { image: { data: IMAGE, mimeType: 'image/jpeg' }, frame },
      };
    }
    return { executed: 1, applicationState: 'unverified' };
  });
  const { tools } = await loadExtension(t, stub.config);
  const act = tools.get('computer_act');
  const scoped = await act.execute(
    'id',
    {
      frameId: 'f1',
      actions: [{ type: 'click', x: 10, y: 10 }],
      observeAfter: true,
      observeOptions: { windowId: 'w-new' },
    },
    null,
    null,
    ctx,
  );
  assert.equal(stub.calls[0].params.observeOptions.windowId, 'w-new');
  assert.equal(stub.calls[0].params.observeAfter, true);
  assert.equal(scoped.content[0].type, 'image');
  assert.equal(scoped.content[1].type, 'text');
  assert.ok(!scoped.content[1].text.includes(IMAGE));
  const scopedText = JSON.parse(scoped.content[1].text);
  assert.equal(scopedText.executed, 1);
  assert.equal(scopedText.applicationState, 'unverified');
  assert.deepEqual(scopedText.frame, frame);
  assert.equal(scoped.details.applicationState, 'unverified');
  assert.equal(scoped.details.executed, 1);

  const whole = await act.execute(
    'id',
    { frameId: 'f2', actions: [{ type: 'wait', ms: 5 }], observeAfter: true, observeOptions: {} },
    null,
    null,
    ctx,
  );
  assert.deepEqual(stub.calls[1].params.observeOptions, {});
  assert.equal(whole.content[0].type, 'image');
  assert.ok(!whole.content[1].text.includes(IMAGE));
});

test('act keeps executed plus observationError when verification capture fails', async (t) => {
  const stub = await startStubBridge(t, async () => ({
    executed: 2,
    applicationState: 'unverified',
    observationError: { code: 'observe_failed', message: 'Verification capture failed.' },
  }));
  const { tools } = await loadExtension(t, stub.config);
  const result = await tools
    .get('computer_act')
    .execute(
      'id',
      { frameId: 'f1', actions: [{ type: 'wait', ms: 5 }], observeAfter: true },
      null,
      null,
      ctx,
    );
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.ok(!result.content[0].text.includes(IMAGE));
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.executed, 2);
  assert.equal(data.applicationState, 'unverified');
  assert.equal(data.observationError.code, 'observe_failed');
  assert.equal(result.details.executed, 2);
  assert.equal(result.details.applicationState, 'unverified');
  assert.equal(result.details.observationError.code, 'observe_failed');
});

test('act without verification still reports unverified state and observe stays point-in-time', async (t) => {
  const stub = await startStubBridge(t, async () => ({ executed: 1 }));
  const { tools } = await loadExtension(t, stub.config);
  const plain = await tools
    .get('computer_act')
    .execute('id', { frameId: 'f1', actions: [{ type: 'wait', ms: 5 }] }, null, null, ctx);
  const data = JSON.parse(plain.content[0].text);
  assert.equal(data.executed, 1);
  assert.equal(data.applicationState, 'unverified');
  assert.equal(plain.details.applicationState, 'unverified');
  assert.ok(!plain.content[0].text.includes(IMAGE));
  const observe = tools.get('computer_observe');
  assert.match(observe.description, /point-in-time/i);
});

test('context hook removes oversized historical screenshots and guards user images', async (t) => {
  // Hermetic: no engine resizer outside the real Studio runtime, so oversized
  // attachments fall back to a removal marker instead of breaking the request.
  process.env.PRIME_STUDIO_IMAGE_RESIZER = 'off';
  t.after(() => {
    delete process.env.PRIME_STUDIO_IMAGE_RESIZER;
  });
  const stub = await startStubBridge(t, async () => ({}));
  const { events } = await loadExtension(t, stub.config);
  assert.equal(typeof events.get('context'), 'function');
  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(png);
  png.writeUInt32BE(900, 16);
  png.writeUInt32BE(2400, 20);
  const part = { type: 'image', data: png.toString('base64'), mimeType: 'image/png' };
  const historical = {
    role: 'toolResult',
    toolName: 'computer_observe',
    toolCallId: 'old-observe',
    content: [part, { type: 'text', text: '{"frame":{"frameId":"old-frame"}}' }],
  };
  const userImage = { role: 'user', content: [part] };
  const messages = [historical, userImage];
  const before = JSON.stringify(messages);
  const result = await events.get('context')({ messages });
  assert.equal(JSON.stringify(messages), before);
  assert.equal(result.messages[0].toolCallId, 'old-observe');
  assert.equal(result.messages[0].content[0].type, 'text');
  assert.match(result.messages[0].content[0].text, /900x2400/);
  assert.match(result.messages[0].content[0].text, /fresh|new observation/i);
  // Oversized user attachment cannot pass through: without a resizer it is
  // replaced by a marker carrying no base64.
  assert.equal(result.messages[1].content[0].type, 'text');
  assert.match(result.messages[1].content[0].text, /900x2400/);
  assert.ok(!JSON.stringify(result.messages[1]).includes(part.data.slice(0, 32)));
  const smallPng = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(smallPng);
  smallPng.writeUInt32BE(640, 16);
  smallPng.writeUInt32BE(480, 20);
  const smallUser = {
    role: 'user',
    content: [{ type: 'image', data: smallPng.toString('base64'), mimeType: 'image/png' }],
  };
  assert.equal(await events.get('context')({ messages: [smallUser] }), undefined);
});

test('CUA inspect schema and requests preserve fresh element frames without images', async (t) => {
  const stub = await startStubBridge(t, async () => ({
    frame: { frameId: 'f-ax', kind: 'accessibility', backend: 'cua' },
    elements: [{ elementId: 's00000001:2', label: 'Play', role: 'button' }],
    truncated: false,
  }));
  const { tools } = await loadExtension(t, stub.config);
  const inspect = tools.get('computer_inspect');
  assert.ok(inspect);
  assert.match(inspect.description, /CUA mode only/);
  assert.ok(inspect.parameters.properties.windowId);
  const result = await inspect.execute('id', { windowId: '42:128' }, null, null, ctx);
  assert.equal(stub.calls[0].action, 'inspect');
  assert.equal(stub.calls[0].params.windowId, '42:128');
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.frame.kind, 'accessibility');
  assert.equal(parsed.elements[0].elementId, 's00000001:2');
});

test('CUA image verification retains partial action evidence and does not duplicate image bytes', async (t) => {
  const stub = await startStubBridge(t, async () => ({
    executed: 0,
    partial: true,
    applicationState: 'unverified',
    results: [{ index: 0, effect: 'refused', route: 'none' }],
    observe: {
      image: { data: IMAGE, mimeType: 'image/png' },
      frame: { frameId: 'f-next', backend: 'cua', kind: 'screenshot' },
      elements: [{ elementId: 's00000002:1', role: 'button', label: 'Play' }],
      truncated: false,
    },
  }));
  const { tools } = await loadExtension(t, stub.config);
  const act = tools.get('computer_act');
  assert.ok(act.parameters.properties.deliveryMode);
  const actionProperties = act.parameters.properties.actions.items.properties;
  assert.ok(actionProperties.elementId);
  assert.ok(actionProperties.value);
  const result = await act.execute(
    'id',
    {
      frameId: 'f-old',
      actions: [{ type: 'set_value', elementId: 's00000001:1', value: '' }],
      deliveryMode: 'background',
      observeAfter: true,
    },
    null,
    null,
    ctx,
  );
  assert.equal(stub.calls[0].params.actions[0].value, '');
  assert.equal(stub.calls[0].params.deliveryMode, 'background');
  const text = JSON.parse(result.content.find((p) => p.type === 'text').text);
  assert.equal(text.executed, 0);
  assert.equal(text.partial, true);
  assert.equal(text.results[0].effect, 'refused');
  assert.equal(text.elements[0].label, 'Play');
  assert.equal(result.details.partial, true);
  assert.ok(!JSON.stringify(text).includes(IMAGE));
});

test('main receives on-demand delegation instructions only when enabled, never auto-spawns', async (t) => {
  const routing = { model: COMPUTER_MODEL, thinking: COMPUTER_THINKING };
  const stub = await startStubBridge(t, async (input) => {
    if (input.action === 'release') return { released: false };
    if (input.action === 'status')
      return { enabled: true, mine: false, delegated: false, routing, owner: null, busy: false };
    return {};
  });
  const { events, tools } = await loadExtension(t, stub.config);
  assert.equal(typeof events.get('before_agent_start'), 'function');
  const out = await events.get('before_agent_start')({ systemPrompt: 'BASE', prompt: 'do desktop' }, mainCtx);
  assert.ok(out && typeof out.systemPrompt === 'string');
  assert.match(out.systemPrompt, /BASE/);
  assert.match(out.systemPrompt, /on-demand/i);
  assert.match(out.systemPrompt, /await rlm\.spawn\(/);
  assert.match(out.systemPrompt, /name="/);
  assert.match(out.systemPrompt, new RegExp(COMPUTER_MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(out.systemPrompt, /overrides general subagent defaults/i);
  // Exact native shape is Python kwargs, never JS object syntax.
  assert.ok(
    !/rlm\.spawn\(prompt,\s*\{/.test(out.systemPrompt),
    'must not use JS rlm.spawn(prompt, {name:}) shape',
  );
  assert.ok(!/\{name:/.test(out.systemPrompt), 'must not use JS {name:} object syntax');
  assert.match(out.systemPrompt, /do not auto-create/i);
  assert.match(out.systemPrompt, /parent messages/i);
  assert.match(out.systemPrompt, /do not poll/i);
  assert.match(out.systemPrompt, /computer_use_delegate_required/);
  // No auto-spawn: hook only returns prompt, never calls desktop actions itself.
  const kinds = stub.calls.map((c) => c.action).sort();
  assert.ok(kinds.includes('status'), 'hook must fetch status over local IPC');
  assert.ok(kinds.includes('release'), 'hook releases leftover hold before new mission');
  assert.ok(
    !kinds.includes('observe') && !kinds.includes('act'),
    'main prompt must not auto-spawn desktop work',
  );

  // Disabled permission appends nothing.
  const offStub = await startStubBridge(t, async (input) => {
    if (input.action === 'release') return { released: false };
    if (input.action === 'status') return { enabled: false, mine: false, delegated: false, routing: null };
    return {};
  });
  const offLoaded = await loadExtension(t, offStub.config);
  const offOut = await offLoaded.events.get('before_agent_start')({ systemPrompt: 'BASE' }, mainCtx);
  assert.equal(offOut, undefined);
  // Schemas unchanged: status stays parameter-free, descriptions explain delegation.
  assert.deepEqual(Object.keys(tools.get('computer_status').parameters.properties || {}), []);
  assert.match(tools.get('computer_status').description, /delegated/i);
  assert.match(tools.get('computer_status').description, /routing/i);
});

test('delegated child with matching model may use desktop; mismatched child must delegate', async (t) => {
  const routing = { model: COMPUTER_MODEL, thinking: COMPUTER_THINKING };
  const stub = await startStubBridge(t, async (input) => {
    if (input.action === 'release') return { released: false };
    if (input.action === 'status')
      return { enabled: true, mine: false, delegated: true, routing, owner: null, busy: false };
    return {};
  });
  const { events } = await loadExtension(t, stub.config);
  const matched = await events.get('before_agent_start')({ systemPrompt: 'BASE' }, childCtx);
  assert.ok(matched && typeof matched.systemPrompt === 'string');
  assert.match(matched.systemPrompt, /ONLY if this task requires desktop interaction/i);
  assert.match(matched.systemPrompt, /Otherwise use normal tools/i);
  assert.match(matched.systemPrompt, /First desktop use acquires the exclusive lock/i);
  // Model match alone never assigns a CU specialist role or mandates desktop work.
  assert.ok(!/You are the delegated Computer Use subagent/i.test(matched.systemPrompt));
  assert.ok(!/you must use desktop tools/i.test(matched.systemPrompt));

  const otherCtx = {
    cwd: '/tmp/p',
    sessionManager: {
      getSessionId: () => 'sess-child-2',
      getSessionFile: () => '/tmp/p/sess-child-2.jsonl',
    },
    model: { provider: 'other', id: 'model', input: ['text'] },
  };
  const mismatched = await events.get('before_agent_start')({ systemPrompt: 'BASE' }, otherCtx);
  assert.ok(mismatched && typeof mismatched.systemPrompt === 'string');
  assert.match(mismatched.systemPrompt, /not the configured/i);
  assert.match(mismatched.systemPrompt, new RegExp(COMPUTER_MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(mismatched.systemPrompt, /do not.*switch/i);
  assert.match(mismatched.systemPrompt, /computer_use_delegate_required/);
});

test('different native sessions keep isolated hold state', async (t) => {
  const stub = await startStubBridge(t, async (input) => {
    if (input.action === 'release') return { released: true };
    if (input.action === 'status') return { enabled: true, mine: false, delegated: false, routing: null };
    return { ok: true };
  });
  const { tools, events } = await loadExtension(t, stub.config);
  const ctxA = {
    cwd: '/tmp/p',
    sessionManager: { getSessionId: () => 'sess-A', getSessionFile: () => '/tmp/p/sess-A.jsonl' },
    model: { provider: 'acme', id: 'vis-model', input: ['text', 'image'] },
  };
  const ctxB = {
    cwd: '/tmp/p',
    sessionManager: { getSessionId: () => 'sess-B', getSessionFile: () => '/tmp/p/sess-B.jsonl' },
    model: { provider: 'acme', id: 'vis-model', input: ['text', 'image'] },
  };
  await events.get('agent_start')(null, ctxA);
  await events.get('agent_start')(null, ctxB);
  await tools.get('computer_status').execute('id', {}, null, null, ctxA);
  await tools.get('computer_status').execute('id', {}, null, null, ctxB);
  const ids = stub.calls.filter((c) => c.action === 'status').map((c) => c.identity.sessionId);
  assert.ok(ids.includes('sess-A'));
  assert.ok(ids.includes('sess-B'));
  assert.notEqual(
    stub.calls.find((c) => c.identity.sessionId === 'sess-A').identity,
    stub.calls.find((c) => c.identity.sessionId === 'sess-B').identity,
  );
  // Ending A must not block B.
  await events.get('agent_end')(null, ctxA);
  const again = await tools.get('computer_status').execute('id', {}, null, null, ctxB);
  assert.equal(JSON.parse(again.content[0].text).enabled, true);
  await assert.rejects(tools.get('computer_status').execute('id', {}, null, null, ctxA), /ended/i);
});

test('agent_end and session_shutdown release exactly once via raw send and stay idempotent', async (t) => {
  const stub = await startStubBridge(t, async (input) => {
    if (input.action === 'status')
      return {
        enabled: true,
        mine: true,
        delegated: true,
        routing: { model: COMPUTER_MODEL, thinking: COMPUTER_THINKING },
      };
    if (input.action === 'release') return { released: true };
    return {};
  });
  const { events, tools } = await loadExtension(t, stub.config);
  await events.get('agent_start')(null, childCtx);
  await tools.get('computer_status').execute('id', {}, null, null, childCtx);
  const before = stub.calls.filter((c) => c.action === 'release').length;
  await events.get('agent_end')(null, childCtx);
  await events.get('session_shutdown')(null, childCtx);
  const releases = stub.calls.filter((c) => c.action === 'release');
  assert.ok(releases.length >= before + 2, 'both lifecycle hooks must best-effort release');
  for (const r of releases) assert.equal(r.identity.sessionId, 'sess-child-1');
  // After end, further tool use is blocked (state ended), but release itself already went out.
  await assert.rejects(tools.get('computer_status').execute('id', {}, null, null, childCtx), /ended/i);
});

test('failed lifecycle release never masks the task result', async (t) => {
  const stub = await startCodedStubBridge(t, async (input) => {
    if (input.action === 'release') {
      const err = new Error('socket hang up');
      err.status = 500;
      err.code = 'computer_use_failed';
      throw err;
    }
    if (input.action === 'status') return { enabled: true, mine: false, delegated: false, routing: null };
    return {};
  });
  const { events } = await loadExtension(t, stub.config);
  await events.get('agent_start')(null, childCtx);
  // Must not throw even though release IPC fails.
  await events.get('agent_end')(null, childCtx);
  await events.get('session_shutdown')(null, childCtx);
  assert.ok(stub.calls.some((c) => c.action === 'release'));
});

test('native identity stays minimal (no wire model hints) and bridge errors stay visible with code', async (t) => {
  const stub = await startStubBridge(t, async (input) => {
    return { enabled: true };
  });
  const { tools } = await loadExtension(t, stub.config);
  await tools.get('computer_status').execute('id', {}, null, null, childCtx);
  // Bridge ignores wire hints: only native cwd/sessionId/sessionFile are sent.
  assert.deepEqual(Object.keys(stub.calls[0].identity).sort(), ['cwd', 'sessionFile', 'sessionId']);
  assert.ok(!('model' in stub.calls[0].identity));
  assert.ok(!('imageCapable' in stub.calls[0].identity));

  const noModelCtx = {
    cwd: '/tmp/p',
    sessionManager: { getSessionId: () => 'sess-nomodel', getSessionFile: () => '/tmp/p/sess-nomodel.jsonl' },
  };
  await tools.get('computer_status').execute('id', {}, null, null, noModelCtx);
  const nomodel = stub.calls.find((c) => c.identity.sessionId === 'sess-nomodel');
  assert.ok(nomodel);
  assert.deepEqual(Object.keys(nomodel.identity).sort(), ['cwd', 'sessionFile', 'sessionId']);

  // Even with a model in ctx, identity never carries it; local guidance uses modelRefOf only.
  await tools.get('computer_status').execute('id', {}, null, null, mainCtx);
  const mainCall = stub.calls.find((c) => c.identity.sessionId === 'sess-1');
  assert.ok(mainCall);
  assert.ok(!('model' in mainCall.identity));
  assert.ok(!('imageCapable' in mainCall.identity));

  // Bridge 409 with code stays visible (isError via throw, code in message + details).
  const coded = await startCodedStubBridge(t, async (input) => {
    if (input.action === 'observe')
      return {
        status: 409,
        body: {
          error:
            'Delegate this desktop task to a normal rlm.spawn subagent using the configured Computer Use model.',
          code: 'computer_use_delegate_required',
        },
      };
    return { enabled: true };
  });
  const codedLoaded = await loadExtension(t, coded.config);
  const err = await codedLoaded.tools
    .get('computer_observe')
    .execute('id', {}, null, null, mainCtx)
    .then(
      () => assert.fail('expected delegate_required'),
      (e) => e,
    );
  assert.equal(err.code, 'computer_use_delegate_required');
  assert.match(String(err.message), /computer_use_delegate_required/);
  assert.match(String(err.message), /Delegate this desktop task/);
  assert.equal(err.details.code, 'computer_use_delegate_required');
});

test('real bridge: main is delegated-required, matching child acquires, release is holder-scoped', async (t) => {
  const manager = createComputerUseManager({ createDriver: fakeDriver, isSupported: true });
  const seen = [];
  const bridge = createComputerUseBridge({
    manager,
    resolveCaller: async (identity) => {
      seen.push(identity);
      if (identity.sessionId === 'sess-child-1') return childCaller;
      return mainCaller;
    },
  });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  await manager.enable({
    sessionId: 'sess-1',
    runId: 'run-1',
    cwd: '/tmp/p',
    computerModel: COMPUTER_MODEL,
    computerThinking: COMPUTER_THINKING,
  });
  const { tools, events } = await loadExtension(t, bridge.config);
  // Main desktop action is delegated-required with code preserved.
  const mainErr = await tools
    .get('computer_observe')
    .execute('id', {}, null, null, mainCtx)
    .then(
      () => assert.fail('main must not observe'),
      (e) => e,
    );
  assert.equal(mainErr.code, 'computer_use_delegate_required');
  assert.match(String(mainErr.message), /computer_use_delegate_required/);
  // Matching child can observe.
  const shot = await tools.get('computer_observe').execute('id', {}, null, null, childCtx);
  assert.equal(shot.content[0].type, 'image');
  // Status for child is delegated with routing; for main it is not delegated.
  const childStatus = JSON.parse(
    (await tools.get('computer_status').execute('id', {}, null, null, childCtx)).content[0].text,
  );
  assert.equal(childStatus.enabled, true);
  assert.equal(childStatus.delegated, true);
  assert.equal(childStatus.routing.model, COMPUTER_MODEL);
  assert.equal(childStatus.routing.thinking, COMPUTER_THINKING);
  const mainStatus = JSON.parse(
    (await tools.get('computer_status').execute('id', {}, null, mainCtx)).content[0].text,
  );
  assert.equal(mainStatus.enabled, true);
  assert.equal(mainStatus.delegated, false);
  // Lifecycle release for holder clears; non-holder release is a no-op success.
  await events.get('agent_end')(null, childCtx);
  assert.equal(manager.status().owner, null);
});

test('bridge error details are visible inside thrown message, not only Error properties', async (t) => {
  const coded = await startCodedStubBridge(t, async (input) => {
    if (input.action === 'act')
      return {
        status: 409,
        body: {
          error: 'The desktop focus changed during this batch. Observe again before acting.',
          code: 'computer_use_stale_frame',
          details: { stage: 'verify-focus', expectedWindowId: '42', actualForeground: '99' },
        },
      };
    if (input.action === 'status') return { enabled: true };
    return {};
  });
  const { tools } = await loadExtension(t, coded.config);
  const err = await tools
    .get('computer_act')
    .execute('id', { frameId: 'f1', actions: [{ type: 'wait', ms: 5 }] }, null, null, childCtx)
    .then(
      () => assert.fail('expected stale focus error'),
      (e) => e,
    );
  assert.equal(err.code, 'computer_use_stale_frame');
  // Native wrapping ignores Error.details, so values must be inside message/content text.
  assert.match(String(err.message), /verify-focus/);
  assert.match(String(err.message), /42/);
  assert.match(String(err.message), /99/);
  assert.match(String(err.message), /computer_use_stale_frame/);
});
test('real bridge ignores spoofed identity model, trusts resolver provenance only', async (t) => {
  const manager = createComputerUseManager({ createDriver: fakeDriver, isSupported: true });
  const bridge = createComputerUseBridge({
    manager,
    resolveCaller: async (identity) => {
      if (identity.sessionId === 'sess-child-1') return childCaller;
      return mainCaller;
    },
  });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  await manager.enable({
    sessionId: 'sess-1',
    runId: 'run-1',
    cwd: '/tmp/p',
    computerModel: COMPUTER_MODEL,
    computerThinking: COMPUTER_THINKING,
  });
  const { tools } = await loadExtension(t, bridge.config);
  // Spoofed identity: same holder session but wrong model in native ctx (hint-only).
  // Authorization must still succeed because resolver returns the trusted model.
  const spoofedCtx = {
    cwd: '/tmp/p',
    sessionManager: {
      getSessionId: () => 'sess-child-1',
      getSessionFile: () => '/tmp/p/sess-child-1.jsonl',
    },
    model: { provider: 'other', id: 'model', input: ['text'] },
  };
  const shot = await tools.get('computer_observe').execute('id', {}, null, null, spoofedCtx);
  assert.equal(shot.content[0].type, 'image');
});
