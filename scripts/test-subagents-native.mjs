// Real Prime Agent and Python, isolated accounts/sessions and a local deterministic provider.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime } from '../lib/agent.mjs';
import { createLiveSessionClient } from '../lib/live-session-client.mjs';
import { createSubagentDefaultsStore } from '../lib/subagent-defaults.mjs';
import { createStore } from '../lib/store.mjs';
import { createSessionInspector } from '../lib/session-inspector.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-subagent-native-'));
const cwd = join(root, 'project'),
  agentHome = join(root, 'agent'),
  sessionDir = join(agentHome, 'sessions');
await Promise.all(
  [cwd, agentHome, sessionDir, join(cwd, '.prime/agent')].map((p) => mkdir(p, { recursive: true })),
);
await writeFile(join(cwd, '.prime/agent/APPEND_SYSTEM.md'), 'EXISTING_APPEND_PROMPT_MUST_SURVIVE');
const defaults = createSubagentDefaultsStore({ dataDir: join(root, 'data') });
let policy = await defaults.set({ revision: '', policy: { model: 'fixture/default', thinking: 'high' } });
const requests = [],
  events = [],
  spawned = new Set();
let releaseChildren = false;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await sleep(60);
  }
  throw new Error(`Native subagent fixture timed out. Events: ${JSON.stringify(events.slice(-3))}`);
}
const provider = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const lastUser = body.messages.findLast((m) => m.role === 'user');
  const prompt = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content);
  const phase = prompt?.includes('ROOT_FIRST') ? 'first' : prompt?.includes('ROOT_SECOND') ? 'second' : null;
  let code;
  if (phase && !spawned.has(phase)) {
    spawned.add(phase);
    code =
      phase === 'first'
        ? 'import rlm\na = await rlm.spawn("CHILD_DEFAULT_FIRST", name="policy-default")\nb = await rlm.spawn("CHILD_EXPLICIT", model="fixture/explicit", thinking="off", name="policy-explicit")\nprint("CHILDREN_ADMITTED")'
        : 'import rlm\na = await rlm.spawn("CHILD_PROJECT_SECOND", name="policy-project")\nprint("CHILD_ADMITTED")';
  }
  // Emit a real 0.9.5 progress note before holding this child open for inspection.
  if (!phase && body.model === 'default' && !spawned.has('progress-note')) {
    spawned.add('progress-note');
    code =
      'import rlm\nresult = await rlm.progress_note("NATIVE_PROGRESS_MARKER")\nassert result.accepted\nprint("PROGRESS_RECORDED")';
  }
  if (!phase && !code) await until(() => releaseChildren);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const frame = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  frame({ role: 'assistant' });
  if (code) {
    frame({
      tool_calls: [
        {
          index: 0,
          id: `call_${phase}`,
          type: 'function',
          function: { name: 'ipython', arguments: JSON.stringify({ code }) },
        },
      ],
    });
    frame({}, 'tool_calls');
  } else {
    frame({ content: 'Fixture completed.' });
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
        models: ['parent', 'default', 'explicit', 'project'].map((id) => ({
          id,
          name: id,
          reasoning: true,
          input: ['text'],
          contextWindow: 131072,
          maxTokens: 4096,
        })),
      },
    },
  }),
);
await writeFile(join(agentHome, 'auth.json'), '{}');
await writeFile(
  join(agentHome, 'settings.json'),
  JSON.stringify({
    defaultProvider: 'fixture',
    defaultModel: 'parent',
    defaultThinkingLevel: 'medium',
    autoRefine: { enabled: false },
    compaction: { enabled: false },
    retry: { enabled: false },
    telemetry: { enabled: false, noticeShown: true },
  }),
);
const runtime = createAgentRuntime({
  agentHome,
  sessionDir,
  subagentPolicyFile: defaults.file,
  env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' },
});
const store = createStore({ sessionDir, dataDir: join(root, 'studio'), initialCwd: cwd });
let client;
try {
  const first = await runtime.start({
    cwd,
    message: 'ROOT_FIRST',
    model: 'fixture/parent',
    thinking: 'medium',
    onEvent: (e) => events.push(e),
  });
  await until(
    () => requests.some((r) => r.model === 'default') && requests.some((r) => r.model === 'explicit'),
  );
  client = createLiveSessionClient(runtime.getLiveEndpoint());
  const live = await until(async () => {
    const snapshot = await client.getInspector(first.sessionId, cwd);
    return snapshot.children.some((child) => child.progressNote === 'NATIVE_PROGRESS_MARKER') && snapshot;
  });
  const progressChild = live.children.find((child) => child.sessionName === 'policy-default');
  assert.equal(progressChild.progressNote, 'NATIVE_PROGRESS_MARKER');
  assert.ok(Number.isFinite(progressChild.lastActivityAt) && progressChild.lastActivityAt > 0);
  assert.equal(live.state.model, 'fixture/parent');
  assert.equal(live.state.thinkingLevel, 'medium');
  assert.equal(live.children.find((c) => c.sessionName === 'policy-default')?.thinkingLevel, 'high');
  assert.equal(live.children.find((c) => c.sessionName === 'policy-explicit')?.thinkingLevel, 'off');
  const firstSystem = JSON.stringify(
    requests[0].messages.filter((m) => ['system', 'developer'].includes(m.role)),
  );
  assert.match(firstSystem, /EXISTING_APPEND_PROMPT_MUST_SURVIVE/);
  assert.match(firstSystem, /subagent defaults/);
  assert.match(firstSystem, /fixture\/default/);
  // Same retained root/daemon; a changed project policy updates both the next system prompt and spawn.
  policy = await defaults.set({
    cwd,
    revision: policy.revision,
    policy: { model: 'fixture/project', thinking: 'low' },
  });
  const requestIndex = requests.length;
  await client.send(first.sessionId, cwd, { message: 'ROOT_SECOND', mode: 'follow_up' });
  await until(() => requests.slice(requestIndex).some((r) => r.model === 'project'));
  client.close();
  client = createLiveSessionClient(runtime.getLiveEndpoint());
  const refreshed = await client.getInspector(first.sessionId, cwd);
  assert.equal(refreshed.children.find((c) => c.sessionName === 'policy-project')?.thinkingLevel, 'low');
  assert.equal(refreshed.children.find((c) => c.sessionName === 'policy-default')?.thinkingLevel, 'high');
  releaseChildren = true;
  const firstDone = await first.done;
  assert.equal(firstDone.status, 'completed', JSON.stringify(firstDone));
  const inspector = createSessionInspector({
    store,
    agentHome,
    sessionDir,
    getClient: () => null,
    getRun: () => null,
  });
  const saved = await inspector.inspect(cwd, first.sessionId);
  assert.equal(saved.agents.find((a) => a.name === 'policy-default')?.thinking, 'high');
  assert.equal(saved.agents.find((a) => a.name === 'policy-explicit')?.thinking, 'off');
  assert.equal(saved.agents.find((a) => a.name === 'policy-project')?.thinking, 'low');
  const secondRequest = requests
    .slice(requestIndex)
    .find(
      (r) =>
        r.model === 'parent' &&
        JSON.stringify(r.messages.findLast((m) => m.role === 'user')).includes('ROOT_SECOND'),
    );
  const secondSystem = JSON.stringify(
    secondRequest.messages.filter((m) => ['system', 'developer'].includes(m.role)),
  );
  assert.match(secondSystem, /fixture\/project/);
  assert.doesNotMatch(secondSystem, /Model: fixture\/default/);
  assert.match(secondSystem, /EXISTING_APPEND_PROMPT_MUST_SURVIVE/);
  assert.deepEqual(
    JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8')).defaultModel,
    'parent',
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          'native defaults applied to Python delegation',
          'explicit model/thinking preserved',
          'live and historical thinking',
          'native progress_note and lastActivityAt reach the live inspector',
          'dynamic per-project system prompt on resumed session',
          'existing prompt and children preserved',
        ],
        root,
      },
      null,
      2,
    ),
  );
} finally {
  releaseChildren = true;
  client?.close();
  await runtime.close();
  await new Promise((done) => provider.close(done));
}
