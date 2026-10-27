import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createConnection } from 'node:net';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRoadmapBridge } from '../lib/roadmap-bridge.mjs';
import { createRustStudioTools } from '../lib/rust-studio-tools.mjs';

const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)));
const session = { cwd, sessionId: 'session-1', sessionFile: resolve(cwd, 'session-1.jsonl') };
const python = fileURLToPath(new URL('../runtime/python/prime_studio.py', import.meta.url));

async function call(configPath, action, params, extra = {}) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const connection =
    config.transport === 'unix'
      ? createConnection(config.socketPath)
      : createConnection(config.port, config.host);
  return new Promise((resolveResult, reject) => {
    let output = '';
    connection.on('error', reject);
    connection.on('connect', () =>
      connection.write(JSON.stringify({ token: config.token, action, params, ...extra }) + '\n'),
    );
    connection.on('data', (chunk) => {
      output += chunk.toString();
    });
    connection.on('end', () => {
      try {
        resolveResult(JSON.parse(output));
      } catch (cause) {
        reject(cause);
      }
    });
  });
}

function runPython(configPath, code, extraEnv = {}) {
  const script = `import importlib.util, json, sys\nsys.dont_write_bytecode=True\nspec=importlib.util.spec_from_file_location('prime_studio', sys.argv[1])\nprime_studio=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(prime_studio)\nprime_studio.configure(sys.argv[2])\n${code}`;
  const child = spawn('python', ['-c', script, python, configPath], {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolveRun, rejectRun) =>
    child.on('close', (code) => {
      if (code) rejectRun(new Error(stderr || `Python exited ${code}`));
      else resolveRun(JSON.parse(output));
    }),
  );
}

async function pendingQuestion(events) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const pending = events.find((event) => event.request.status === 'pending');
    if (pending) return pending;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error('Python question did not reach Studio');
}

test('unbound identity and invalid bearer are refused; prompt has no bearer', async () => {
  const bridge = createRustStudioTools({ cwd, allowQuestions: false });
  try {
    await bridge.ready;
    const config = JSON.parse(readFileSync(bridge.configPath, 'utf8'));
    const prompt = bridge.appendSystemPrompt('Base');
    assert.ok(!prompt.includes(config.token));
    assert.ok(!prompt.includes('question,'));
    assert.match(prompt, /every turn.*fresh bridge/);
    assert.match(prompt, /question\(\.\.\.\) returns a dict with answer and wasCustom/);
    assert.match(prompt, /print result\["answer"\]/);
    assert.ok(prompt.includes(JSON.stringify(bridge.configPath)));
    if (process.platform !== 'win32') assert.equal(statSync(bridge.configPath).mode & 0o777, 0o600);
    const unbound = await call(bridge.configPath, 'roadmap_read', {});
    assert.equal(unbound.code, 'studio_tool_unbound');
    bridge.bindSession(session);
    assert.throws(() => bridge.bindSession(session), /already bound/);
    await bridge.beginTurn();
    const deniedQuestion = await call(bridge.configPath, 'question', {
      question: 'Choose?',
      options: [
        { label: 'A', description: 'First' },
        { label: 'B', description: 'Second' },
      ],
    });
    assert.equal(deniedQuestion.code, 'question_unavailable');
    const wrong = await call(bridge.configPath, 'roadmap_read', {}, { token: 'wrong' });
    assert.equal(wrong.ok, false);
  } finally {
    await bridge.close();
  }
});

test('child Roadmap identity requires a native resolver and clears child activity', async () => {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\prime-studio-roadmap-child-${randomUUID()}`
      : join(tmpdir(), `prime-studio-roadmap-child-${randomUUID()}.sock`);
  const forwarded = [];
  const server = createHttpServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    forwarded.push(payload);
    response.end(JSON.stringify({ active: payload.action === 'work', revision: 3 }));
  });
  await new Promise((resolveListen) => server.listen(endpoint, resolveListen));
  const child = { cwd, sessionId: 'child-1', sessionFile: resolve(cwd, 'child-1.jsonl') };
  const bridge = createRustStudioTools({
    cwd,
    roadmapConfig: { socketPath: endpoint, token: 'fixture' },
    resolveContext: async ({ root, callerSessionId }) => {
      assert.deepEqual(root, session);
      return callerSessionId === child.sessionId ? child : null;
    },
  });
  try {
    await bridge.ready;
    bridge.bindSession(session);
    await bridge.beginTurn();
    const denied = await call(bridge.configPath, 'roadmap_read', {}, { callerSessionId: 'forged-child' });
    assert.equal(denied.code, 'studio_tool_identity_denied');
    const childRead = await runPython(bridge.configPath,
      `print(json.dumps(prime_studio.roadmap_read()))`, { PRIME_STUDIO_SESSION_ID: child.sessionId });
    assert.equal(childRead.revision, 3);
    assert.deepEqual(forwarded.at(-1).identity, child);
    const work = await call(bridge.configPath, 'roadmap_work',
      { targets: [{ kind: 'plan', planId: 'p1' }] }, { callerSessionId: child.sessionId });
    assert.equal(work.data.active, true);
    await bridge.endTurn();
    assert.ok(forwarded.some((item) => item.action === 'clear' && item.identity.sessionId === child.sessionId));
    const after = await call(bridge.configPath, 'roadmap_read', {}, { callerSessionId: child.sessionId });
    assert.equal(after.code, 'studio_tool_inactive');
  } finally {
    await bridge.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('a child identity resolved after its turn ends cannot enter the next turn', async () => {
  let release;
  let started;
  const resolving = new Promise((resolveStarted) => { started = resolveStarted; });
  const bridge = createRustStudioTools({
    cwd,
    resolveContext: async () => {
      started();
      await new Promise((resolveRelease) => { release = resolveRelease; });
      return { cwd, sessionId: 'child-1', sessionFile: resolve(cwd, 'child-1.jsonl') };
    },
  });
  try {
    await bridge.ready;
    bridge.bindSession(session);
    await bridge.beginTurn();
    const pending = call(bridge.configPath, 'roadmap_read', {}, { callerSessionId: 'child-1' });
    await resolving;
    await bridge.endTurn();
    await bridge.beginTurn();
    release();
    const result = await pending;
    assert.equal(result.code, 'studio_tool_inactive');
  } finally {
    release?.();
    await bridge.close();
  }
});

test('Python knowledge search and read use a real native session fixture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'prime-studio-knowledge-test-'));
  const dataDir = join(root, 'data');
  const sessionDir = join(root, 'sessions');
  const agentHome = join(root, 'agent');
  mkdirSync(dataDir);
  mkdirSync(sessionDir);
  mkdirSync(agentHome);
  writeFileSync(
    join(dataDir, 'workspace.json'),
    JSON.stringify({ projects: [{ cwd: root, name: 'Fixture' }], sessions: {} }),
  );
  const sessionFile = join(sessionDir, 'session-1.jsonl');
  writeFileSync(
    sessionFile,
    [
      { type: 'session', id: 'session-1', cwd: root, timestamp: '2026-10-13T00:00:00.000Z' },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'The violet comet marks the project decision.' }],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const bridge = createRustStudioTools({ cwd: root, knowledgeConfig: { dataDir, sessionDir, agentHome } });
  try {
    await bridge.ready;
    bridge.bindSession({ cwd: root, sessionId: 'session-1', sessionFile });
    await bridge.beginTurn();
    const result = await runPython(
      bridge.configPath,
      `items=prime_studio.knowledge_search('violet comet')\nprint(json.dumps({'count':len(items['items']), 'detail':prime_studio.knowledge_read(items['items'][0]['id'])['body']}))`,
    );
    assert.ok(result.count >= 1);
    assert.match(result.detail, /violet comet/);
  } finally {
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Python question returns a custom answer and cancellation', async () => {
  const events = [];
  const bridge = createRustStudioTools({ cwd, onEvent: (event) => events.push(event) });
  try {
    await bridge.ready;
    bridge.bindSession(session);
    await bridge.beginTurn();
    let running = runPython(
      bridge.configPath,
      `print(json.dumps(prime_studio.question('Choose?', [{'label':'A','description':'Fast'}, {'label':'B','description':'Careful'}])))`,
    );
    const first = await pendingQuestion(events);
    bridge.respond(first.request.id, { value: 'Another answer' });
    assert.deepEqual(await running, {
      question: 'Choose?',
      options: [
        { label: 'A', description: 'Fast' },
        { label: 'B', description: 'Careful' },
      ],
      answer: 'Another answer',
      wasCustom: true,
    });
    events.length = 0;
    running = runPython(
      bridge.configPath,
      `print(json.dumps(prime_studio.question('Select a canary option', [{'label':'Alpha','description':'First canary choice'}, {'label':'Beta','description':'Second canary choice'}])))`,
    );
    const selected = await pendingQuestion(events);
    bridge.respond(selected.request.id, { value: selected.request.options[0] });
    assert.equal((await running).answer, 'Alpha');
    events.length = 0;
    running = runPython(
      bridge.configPath,
      `print(json.dumps(prime_studio.question('Choose?', [{'label':'A','description':'Fast'}, {'label':'B','description':'Careful'}])))`,
    );
    await pendingQuestion(events);
    await bridge.endTurn();
    assert.equal((await running).answer, null);
  } finally {
    await bridge.close();
  }
});

test('closing with a pending Python question ends the IPC', async () => {
  const events = [];
  const bridge = createRustStudioTools({ cwd, onEvent: (event) => events.push(event) });
  await bridge.ready;
  bridge.bindSession(session);
  await bridge.beginTurn();
  const running = runPython(
    bridge.configPath,
    `print(json.dumps(prime_studio.question('Wait?', [{'label':'A','description':'First'}, {'label':'B','description':'Second'}])))`,
  );
  await pendingQuestion(events);
  await bridge.close();
  let timer;
  const outcome = await Promise.race([
    running.then(
      (value) => ({ value }),
      (cause) => ({ cause }),
    ),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Python remained blocked after close')), 3000);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.ok(outcome.cause || outcome.value.answer === null);
});

test('reset during a partial request cannot crash the bridge', async () => {
  const bridge = createRustStudioTools({ cwd });
  try {
    await bridge.ready;
    bridge.bindSession(session);
    await bridge.beginTurn();
    const config = JSON.parse(readFileSync(bridge.configPath, 'utf8'));
    const broken =
      config.transport === 'unix'
        ? createConnection(config.socketPath)
        : createConnection(config.port, config.host);
    broken.on('error', () => {});
    await new Promise((resolveConnect) => broken.once('connect', resolveConnect));
    broken.write('{');
    if (config.transport === 'tcp') broken.resetAndDestroy();
    else broken.destroy();
    await new Promise((resolveClose) => broken.once('close', resolveClose));
    const healthy = await call(bridge.configPath, 'roadmap_read', {});
    assert.equal(healthy.code, 'roadmap_unavailable');
  } finally {
    await bridge.close();
  }
});

test('abrupt question peer loss cancels its pending interaction', async () => {
  const events = [];
  const bridge = createRustStudioTools({ cwd, onEvent: (event) => events.push(event) });
  try {
    await bridge.ready;
    bridge.bindSession(session);
    await bridge.beginTurn();
    const config = JSON.parse(readFileSync(bridge.configPath, 'utf8'));
    const broken =
      config.transport === 'unix'
        ? createConnection(config.socketPath)
        : createConnection(config.port, config.host);
    broken.on('error', () => {});
    await new Promise((resolveConnect) => broken.once('connect', resolveConnect));
    broken.write(
      JSON.stringify({
        token: config.token,
        action: 'question',
        params: {
          question: 'Choose?',
          options: [
            { label: 'A', description: 'First' },
            { label: 'B', description: 'Second' },
          ],
        },
      }) + '\n',
    );
    const pending = await pendingQuestion(events);
    if (config.transport === 'tcp') broken.resetAndDestroy();
    else broken.destroy();
    await new Promise((resolveClose) => broken.once('close', resolveClose));
    const deadline = Date.now() + 1000;
    while (
      !events.some(
        (event) => event.request.id === pending.request.id && event.request.status === 'cancelled',
      ) &&
      Date.now() < deadline
    )
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    assert.ok(
      events.some((event) => event.request.id === pending.request.id && event.request.status === 'cancelled'),
    );
    assert.throws(() => bridge.respond(pending.request.id, { value: 'A' }), /no longer awaits/);
  } finally {
    await bridge.close();
  }
});

test('interrupted Roadmap response is reported without hanging the client socket', async () => {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\prime-studio-roadmap-abort-${randomUUID()}`
      : join(tmpdir(), `prime-studio-roadmap-abort-${randomUUID()}.sock`);
  const server = createHttpServer((_req, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"partial":');
    setImmediate(() => response.socket.destroy());
  });
  await new Promise((resolveListen) => server.listen(endpoint, resolveListen));
  const bridge = createRustStudioTools({ cwd, roadmapConfig: { socketPath: endpoint, token: 'test' } });
  try {
    await bridge.ready;
    bridge.bindSession(session);
    await bridge.beginTurn();
    const result = await call(bridge.configPath, 'roadmap_read', {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'roadmap_unavailable');
  } finally {
    await bridge.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('endTurn revokes new calls and cancels a pending Roadmap work request', async () => {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\prime-studio-roadmap-turn-${randomUUID()}`
      : join(tmpdir(), `prime-studio-roadmap-turn-${randomUUID()}.sock`);
  let workStarted;
  const started = new Promise((resolveStarted) => {
    workStarted = resolveStarted;
  });
  const seen = [];
  const server = createHttpServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { action } = JSON.parse(body);
    seen.push(action);
    if (action === 'work') {
      workStarted(response);
      return;
    }
    response.end(JSON.stringify({ active: false }));
  });
  await new Promise((resolveListen) => server.listen(endpoint, resolveListen));
  const bridge = createRustStudioTools({ cwd, roadmapConfig: { socketPath: endpoint, token: 'test' } });
  try {
    await bridge.ready;
    bridge.bindSession(session);
    const before = await call(bridge.configPath, 'roadmap_read', {});
    assert.equal(before.code, 'studio_tool_inactive');
    await bridge.beginTurn();
    const work = call(bridge.configPath, 'roadmap_work', { targets: [] });
    const response = await started;
    await bridge.endTurn();
    const cancelled = await work;
    assert.equal(cancelled.code, 'roadmap_cancelled');
    response.end(JSON.stringify({ active: true }));
    const after = await call(bridge.configPath, 'roadmap_read', {});
    assert.equal(after.code, 'studio_tool_inactive');
    assert.deepEqual(seen, ['clear', 'work', 'clear']);
  } finally {
    await bridge.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('Roadmap bridge rejects malformed tool arguments before the writer', async () => {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\prime-studio-roadmap-contract-${randomUUID()}`
      : join(tmpdir(), `prime-studio-roadmap-contract-${randomUUID()}.sock`);
  const forwarded = [];
  const server = createHttpServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    forwarded.push(JSON.parse(body));
    response.end(JSON.stringify({ revision: 3, active: false }));
  });
  await new Promise((resolveListen) => server.listen(endpoint, resolveListen));
  const bridge = createRustStudioTools({ cwd, roadmapConfig: { socketPath: endpoint, token: 'fixture' } });
  try {
    await bridge.ready;
    bridge.bindSession(session);
    await bridge.beginTurn();
    const initial = forwarded.length;
    const bad = [
      ['roadmap_read', { target: 'plan', offset: -1 }],
      ['roadmap_read', { target: 'overview', sessionId: 'forged-child' }],
      ['roadmap_plan', { action: 'create', title: 'Missing revision' }],
      ['roadmap_plan', { action: 'steps', expectedRevision: 3, steps: [{ text: 'Task', children: [{ text: 'Subtask', children: [{ text: 'Leaf', children: [{}] }] }] }] }],
      ['roadmap_check', { expectedRevision: 3, planId: 'p1', done: 'true' }],
      ['roadmap_backlog', { action: 'add', expectedRevision: 3, number: 0 }],
      ['roadmap_milestone', { action: 'create', expectedRevision: 3, title: '' }],
      ['roadmap_work', { targets: [{ kind: 'plan', planId: 'p1', sessionId: 'forged-child' }] }],
    ];
    for (const [action, params] of bad) {
      const result = await call(bridge.configPath, action, params);
      assert.equal(result.code, 'studio_tool_invalid', action);
    }
    assert.equal(forwarded.length, initial);
    const good = await call(bridge.configPath, 'roadmap_plan', {
      action: 'create', expectedRevision: 3, title: 'Plan', steps: [{ text: 'Task', children: [{ text: 'Subtask' }] }],
    });
    assert.equal(good.ok, true);
    assert.equal(forwarded.at(-1).params.action, 'plan.create');
    assert.deepEqual(forwarded.at(-1).identity, session);
  } finally {
    await bridge.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('Python exposes explicit Roadmap signatures and omits unset fields', async () => {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\prime-studio-roadmap-python-${randomUUID()}`
      : join(tmpdir(), `prime-studio-roadmap-python-${randomUUID()}.sock`);
  const forwarded = [];
  const server = createHttpServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    forwarded.push(JSON.parse(body));
    response.end(JSON.stringify({ revision: 3 }));
  });
  await new Promise((resolveListen) => server.listen(endpoint, resolveListen));
  const bridge = createRustStudioTools({ cwd, roadmapConfig: { socketPath: endpoint, token: 'fixture' } });
  try {
    await bridge.ready;
    bridge.bindSession(session);
    await bridge.beginTurn();
    const result = await runPython(bridge.configPath,
      `import inspect\ntry:\n prime_studio.roadmap_read(sessoinId='forged')\nexcept TypeError:\n rejected=True\nelse:\n rejected=False\nprime_studio.roadmap_plan('create', 3, title='Plan')\nprint(json.dumps({'rejected':rejected,'signature':str(inspect.signature(prime_studio.roadmap_check)),'help':prime_studio.roadmap_work.__doc__}))`);
    assert.equal(result.rejected, true);
    assert.match(result.signature, /expectedRevision, planId, done/);
    assert.match(result.help, /does not launch work/);
    assert.deepEqual(forwarded.at(-1).params, { expectedRevision: 3, title: 'Plan', action: 'plan.create' });
  } finally {
    await bridge.close();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('roadmap calls use trusted bound identity and preserve revision conflicts', async () => {
  let seen;
  let revision = 2;
  const dto = () => ({
    revision,
    initialized: true,
    document: {
      overview: { vision: '', milestones: [] },
      plans: [{ id: 'p1', title: 'Plan', summary: '', status: 'active', steps: [] }],
      backlog: { items: [], notes: [] },
    },
  });
  const roadmap = createRoadmapBridge({
    service: {
      read: async () => dto(),
      mutate: async (_cwd, command) => {
        if (command.expectedRevision !== revision)
          throw Object.assign(new Error('Roadmap changed'), {
            status: 409,
            code: 'roadmap_conflict',
            currentRevision: revision,
          });
        revision++;
        return dto();
      },
    },
    resolveCaller: async (identity) => {
      seen = identity;
      return {
        cwd,
        sessionId: session.sessionId,
        rootSessionId: session.sessionId,
        ownerId: 'owner-1',
        name: 'Prime Agent',
      };
    },
  });
  const bridge = createRustStudioTools({ cwd, roadmapConfig: roadmap.config });
  try {
    await Promise.all([roadmap.ready, bridge.ready]);
    bridge.bindSession(session);
    await bridge.beginTurn();
    const read = await call(
      bridge.configPath,
      'roadmap_read',
      { target: 'overview' },
      { identity: { cwd: '/forged', sessionId: 'forged', sessionFile: '/forged' } },
    );
    assert.equal(read.data.revision, 2);
    assert.deepEqual(seen, session);
    const conflict = await call(bridge.configPath, 'roadmap_milestone', {
      action: 'vision',
      expectedRevision: 1,
      text: 'Goal',
    });
    assert.equal(conflict.code, 'roadmap_conflict');
    assert.match(conflict.error, /Current revision: 2/);
    const changed = await call(bridge.configPath, 'roadmap_milestone', {
      action: 'vision',
      expectedRevision: 2,
      text: 'Goal',
    });
    assert.equal(changed.data.revision, 3);
    const work = await call(bridge.configPath, 'roadmap_work', { targets: [{ kind: 'plan', planId: 'p1' }] });
    assert.equal(work.data.active, true);
    assert.equal(roadmap.snapshot(cwd).activity.length, 1);
    await bridge.endTurn();
    assert.equal(roadmap.snapshot(cwd).activity.length, 0);
  } finally {
    await bridge.close();
    await roadmap.close();
  }
});
