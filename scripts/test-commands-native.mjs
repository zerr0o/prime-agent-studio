// Real Prime Agent + real Python, with an isolated local model fixture.
// No user account, settings, daemon or project is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const runtimeRoot = resolve(
  process.env.PRIME_STUDIO_TEST_RUNTIME_ROOT || fileURLToPath(new URL('..', import.meta.url)),
);
const load = (name) => import(pathToFileURL(join(runtimeRoot, 'lib', name)).href);
const [{ createAgentRuntime }, { createLiveSessionClient }, { createCommandService }, { createStore }] =
  await Promise.all([
    load('agent.mjs'),
    load('live-session-client.mjs'),
    load('commands.mjs'),
    load('store.mjs'),
  ]);
const root = await mkdtemp(join(tmpdir(), 'prime-command-native-'));
const cwd = join(root, 'project'),
  agentHome = join(root, 'agent'),
  sessionDir = join(agentHome, 'sessions');
const skillDir = join(cwd, '.prime', 'agent', 'skills', 'studio-check'),
  promptsDir = join(cwd, '.prime', 'agent', 'prompts');
await Promise.all(
  [cwd, agentHome, sessionDir, skillDir, promptsDir].map((p) => mkdir(p, { recursive: true })),
);
await writeFile(
  join(skillDir, 'SKILL.md'),
  '---\nname: studio-check\ndescription: Native Studio integration fixture\n---\nSKILL_INSTRUCTIONS_MARKER',
);
await writeFile(
  join(promptsDir, 'review.md'),
  '---\ndescription: Native template fixture\n---\nTEMPLATE_MARKER $1 / $2',
);
const requests = [],
  events = [],
  checks = [];
const gate = join(cwd, 'gate-started'),
  release = join(cwd, 'gate-release');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(80);
  }
  throw new Error('Native command fixture timed out');
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native command completion timed out')), 60000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const code = `from pathlib import Path\nimport time\nPath(${JSON.stringify(gate)}).write_text('ready')\nwhile not Path(${JSON.stringify(release)}).exists():\n    time.sleep(0.05)\nprint('TOOL_FINISHED')`;
const provider = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const frame = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'commands', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  frame({ role: 'assistant' });
  if (requests.length === 1) {
    frame({
      tool_calls: [
        {
          index: 0,
          id: 'call_gate',
          type: 'function',
          function: { name: 'ipython', arguments: JSON.stringify({ code }) },
        },
      ],
    });
    frame({}, 'tool_calls');
  } else {
    frame({ content: 'Native fixture completed.' });
    frame({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
});
await new Promise((done) => provider.listen(0, '127.0.0.1', done));
await writeFile(
  join(agentHome, 'models.json'),
  JSON.stringify({
    providers: {
      fixture: {
        api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        apiKey: 'fixture-only',
        models: [
          {
            id: 'commands',
            name: 'Command fixture',
            reasoning: false,
            input: ['text'],
            contextWindow: 131072,
            maxTokens: 4096,
          },
        ],
      },
    },
  }),
);
await writeFile(join(agentHome, 'auth.json'), '{}');
await writeFile(
  join(agentHome, 'settings.json'),
  JSON.stringify({
    defaultProvider: 'fixture',
    defaultModel: 'commands',
    defaultThinkingLevel: 'off',
    autoRefine: { enabled: false },
    compaction: { enabled: false },
    retry: { enabled: false },
    telemetry: { enabled: false, noticeShown: true },
  }),
);
const runtime = createAgentRuntime({
  agentHome,
  sessionDir,
  kernelRoot: root,
  env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' },
});
const store = createStore({ sessionDir, dataDir: join(root, 'data') });
const catalog = createCommandService({ agentHome });
let client;
try {
  const handle = await bounded(
    runtime.start({
      cwd,
      message: '/skill:studio-check INITIAL_REQUEST',
      model: 'fixture/commands',
      thinking: 'off',
      onEvent: (e) => events.push(e),
    }),
  );
  let completed = false;
  handle.done.then(() => {
    completed = true;
  });
  await until(async () => {
    if (completed) throw new Error(`Premature finish: ${JSON.stringify(await handle.done)}`);
    return (
      handle.sessionId &&
      (await readFile(gate).then(
        () => true,
        () => false,
      ))
    );
  });
  client = createLiveSessionClient(runtime.getLiveEndpoint());
  const inspected = await client.getInspector(handle.sessionId, cwd);
  assert.equal(inspected.state.isRunningTools, true);
  assert.ok(Array.isArray(inspected.children));
  assert.equal(completed, false, 'Inspecting agents never interrupts or attaches to the worker');
  const loaded = await client.getCommands(handle.sessionId, cwd);
  assert.ok(loaded.some((c) => c.name === 'skill:studio-check'));
  assert.ok(loaded.some((c) => c.name === 'review'));
  const configured = await catalog.list({ cwd });
  assert.ok(configured.commands.some((c) => c.name === 'skill:studio-check'));
  const send = async (message, mode) =>
    assert.equal((await client.send(handle.sessionId, cwd, { message, mode })).accepted, true);
  await send('/goal status', 'steer');
  await send('/autonomous status', 'follow_up');
  await send('/review "quoted file" second', 'follow_up');
  await send('/skill:studio-check LIVE_REQUEST', 'steer');
  const queue = await client.getSnapshot(handle.sessionId, cwd);
  assert.ok(queue.steering.some((text) => text === '/goal status'));
  assert.ok(queue.followUps.some((text) => text === '/autonomous status'));
  assert.equal(completed, false);
  assert.equal(requests.length, 1, 'No model call while the original Python tool is blocked');
  await writeFile(release, 'release');
  const result = await bounded(handle.done);
  assert.equal(result.status, 'completed', result.error);
  const textOf = (content) =>
    typeof content === 'string'
      ? content
      : (content || [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
  const modelUsers = requests.flatMap((r) =>
    r.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)),
  );
  assert.ok(
    modelUsers.some((text) => text.includes('SKILL_INSTRUCTIONS_MARKER') && text.includes('INITIAL_REQUEST')),
  );
  assert.ok(
    modelUsers.some((text) => text.includes('SKILL_INSTRUCTIONS_MARKER') && text.includes('LIVE_REQUEST')),
  );
  assert.ok(modelUsers.some((text) => text.includes('TEMPLATE_MARKER quoted file / second')));
  assert.ok(
    !modelUsers.some((text) => text === '/goal status' || text === '/autonomous status'),
    'Session commands must never become ordinary model prompts',
  );
  const history = await store.history(handle.sessionId);
  assert.ok(history.messages.some((m) => m.role === 'system' && /goal/i.test(m.text)));
  assert.ok(
    events.some((e) => e.kind === 'message' && e.message.role === 'system' && /goal/i.test(e.message.text)),
    'Command results must be visible in the live conversation',
  );
  assert.equal(
    events.filter((e) => e.kind === 'message' && e.message.role === 'system' && /goal/i.test(e.message.text))
      .length,
    1,
    'Queued command result is delivered exactly once',
  );
  checks.push(
    'Skills développés par Prime Agent au premier tour et en réorientation',
    'Prompts natifs avec arguments entre guillemets',
    'Commandes goal/autonomous dans leurs files natives sans interrompre Python',
    'Résultats des commandes visibles en direct et dans l’historique',
  );
  const before = requests.length;
  const idle = await runtime.start({
    cwd,
    sessionId: handle.sessionId,
    message: '/goal status',
    onEvent: (e) => events.push(e),
  });
  assert.equal((await bounded(idle.done)).status, 'completed');
  assert.equal(requests.length, before, 'A status command on an idle session makes no model request');
  assert.equal(
    events.filter((e) => e.kind === 'message' && e.message.role === 'system' && /goal/i.test(e.message.text))
      .length,
    2,
    'Resuming does not replay the previous command result',
  );
  checks.push('Commande native entre deux tours sans appel au modèle');
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  await writeFile(
    join(root, 'diagnostic.json'),
    JSON.stringify({ error: String(error.stack), events, requests }, null, 2),
  );
  console.error(`Diagnostic isolé : ${root}`);
  throw error;
} finally {
  await writeFile(release, 'cleanup');
  client?.close();
  catalog.close();
  await runtime.close();
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
}
