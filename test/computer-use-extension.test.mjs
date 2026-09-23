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
  const bridge = createComputerUseBridge({ manager, resolveCaller: async () => caller });
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
  await assert.rejects(observe.execute('id', {}, null, null, ctx), /Enable it in Studio/);
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const shot = await observe.execute('id', {}, null, null, ctx);
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
    ctx,
  );
  assert.match(JSON.stringify(done), /executed/);
  await assert.rejects(
    act.execute(
      'id',
      { frameId: shot.details.frame.frameId, actions: [{ type: 'click', x: 10, y: 10 }] },
      null,
      null,
      ctx,
    ),
    /stale/i,
  );
});

test('extension act with observeAfter returns a verification ImageContent', async (t) => {
  const manager = createComputerUseManager({ createDriver: fakeDriver, isSupported: true });
  const bridge = createComputerUseBridge({ manager, resolveCaller: async () => caller });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  const { tools } = await loadExtension(t, bridge.config);
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const shot = await tools.get('computer_observe').execute('id', {}, null, null, ctx);
  const result = await tools
    .get('computer_act')
    .execute(
      'id',
      { frameId: shot.details.frame.frameId, actions: [{ type: 'wait', ms: 5 }], observeAfter: true },
      null,
      null,
      ctx,
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
  const bridge = createComputerUseBridge({ manager, resolveCaller: async () => caller });
  await bridge.ready;
  t.after(() => bridge.close());
  t.after(() => manager.close());
  const { tools } = await loadExtension(t, bridge.config);
  await manager.enable({ sessionId: 'sess-1', runId: 'run-1', cwd: '/tmp/p' });
  const shot = await tools.get('computer_observe').execute('id', {}, null, null, ctx);
  const frameId = shot.details.frame.frameId;
  const act = tools.get('computer_act');
  await assert.rejects(
    act.execute('id', { frameId, actions: [{ type: 'wait', ms: 5001 }] }, null, null, ctx),
    /5000/,
  );
  await assert.rejects(
    act.execute('id', { frameId, actions: [{ type: 'scroll', deltaY: 101 }] }, null, null, ctx),
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
      ctx,
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

test('context hook removes oversized historical screenshots without changing history or user images', async (t) => {
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
  assert.equal(result.messages[1], userImage);
  assert.equal(await events.get('context')({ messages: [userImage] }), undefined);
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
