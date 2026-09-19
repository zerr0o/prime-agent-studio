// Real native extension loading, tools and RLM child inheritance. The provider
// is a deterministic loopback fixture; no external model or account is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime } from '../lib/agent.mjs';
import { createStore } from '../lib/store.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-knowledge-native-'));
const cwd = join(root, 'Projet é'),
  other = join(root, 'Autre projet');
const agentHome = join(root, 'agent'),
  sessionDir = join(agentHome, 'sessions'),
  dataDir = join(root, 'studio');
await Promise.all([cwd, other, sessionDir].map((path) => mkdir(path, { recursive: true })));
const store = createStore({ sessionDir, dataDir });
await store.project({ cwd });
await store.project({ cwd: other });
const evidence = 'DIRAC_FIXTURE_EVIDENCE: measured phase correction with a 48 kHz impulse response.';
const privateEvidence = 'OTHER_PROJECT_PRIVATE_EVIDENCE';
async function history(id, project, answer) {
  const entries = [
    { type: 'session', version: 3, id, cwd: project, timestamp: '2026-09-04T12:00:00.000Z' },
    {
      type: 'message',
      id: `${id}-user`,
      parentId: null,
      timestamp: '2026-09-04T12:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Prior Dirac research' }] },
    },
    {
      type: 'message',
      id: `${id}-answer`,
      parentId: `${id}-user`,
      timestamp: '2026-09-04T12:01:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: answer }], stopReason: 'stop' },
    },
  ];
  await writeFile(
    join(sessionDir, `${id}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
}
await history('prior-own', cwd, evidence);
await history('prior-other', other, `Dirac ${privateEvidence}`);
const calls = [],
  requests = [],
  events = [],
  stage = new Map();
let runtime;
const provider = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw),
      role = body.model;
    requests.push(body);
    const names = body.tools.map((tool) => tool.function.name);
    assert.ok(names.includes('studio_knowledge_search'), `${role}: search not discovered`);
    assert.ok(names.includes('studio_knowledge_read'), `${role}: read not discovered`);
    assert.doesNotMatch(JSON.stringify(body.messages), /OTHER_PROJECT_PRIVATE_EVIDENCE/);
    const step = stage.get(role) || 0;
    let tool;
    if (step === 0) {
      tool = { name: 'studio_knowledge_search', arguments: { q: 'DIRAC_FIXTURE_EVIDENCE', limit: 3 } };
    } else if (step === 1) {
      const message = body.messages.findLast((entry) => entry.role === 'tool');
      const result = JSON.parse(message.content);
      const hit = result.items.find((item) => item.excerpt.includes('DIRAC_FIXTURE_EVIDENCE'));
      assert.ok(hit, `${role}: missing native search evidence`);
      assert.equal(hit.source.sessionId, 'prior-own');
      calls.push(`${role}:search`);
      tool = { name: 'studio_knowledge_read', arguments: { id: hit.id } };
    } else if (step === 2) {
      const message = body.messages.findLast((entry) => entry.role === 'tool');
      const result = JSON.parse(message.content);
      assert.match(result.body, /DIRAC_FIXTURE_EVIDENCE/);
      assert.equal(result.source.sessionId, 'prior-own');
      calls.push(`${role}:read`);
      if (role === 'parent')
        tool = {
          name: 'ipython',
          arguments: {
            code: 'import rlm\nchild = await rlm.spawn("Search prior Dirac findings", model="fixture/child", name="knowledge-reader")\nprint("CHILD_ADMITTED")',
          },
        };
    }
    stage.set(role, step + 1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: `message-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: role,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    frame({ role: 'assistant' });
    if (tool) {
      frame({
        tool_calls: [
          {
            index: 0,
            id: `${role}-${step}`,
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
          },
        ],
      });
      frame({}, 'tool_calls');
    } else {
      frame({ content: 'Knowledge integration verified.' });
      frame({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  } catch (error) {
    calls.push({ error: error.message });
    res.writeHead(500);
    res.end(error.message);
  }
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const settings = JSON.stringify({
  defaultProvider: 'fixture',
  defaultModel: 'parent',
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
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        apiKey: 'fixture-only',
        models: ['parent', 'child'].map((id) => ({
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
try {
  runtime = createAgentRuntime({
    agentHome,
    sessionDir,
    knowledge: { dataDir },
    env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' },
  });
  const handle = await runtime.start({
    cwd,
    message: 'Check previous findings and delegate a second lookup.',
    model: 'fixture/parent',
    onEvent: (event) => events.push(event),
  });
  const deadline = Date.now() + 120000;
  while (!calls.includes('child:read') && !calls.some((item) => item?.error) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(
    calls.filter((item) => item?.error),
    [],
    JSON.stringify(calls),
  );
  for (const expected of ['parent:search', 'parent:read', 'child:search', 'child:read'])
    assert.ok(calls.includes(expected), `${expected} missing: ${JSON.stringify(events.slice(-5))}`);
  assert.equal((await handle.done).status, 'completed');
  assert.equal(
    await readFile(join(agentHome, 'settings.json'), 'utf8'),
    settings,
    'Native settings must remain unchanged',
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        calls,
        root,
        checks: [
          'Real native tool discovery by parent and child',
          'Actual bounded source search/read',
          'Project isolation',
          'Native settings unchanged',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(join(root, 'diagnostic.json'), JSON.stringify({ requests, calls, events }, null, 2));
  console.error(error);
  console.error(`Diagnostic: ${root}`);
  process.exitCode = 1;
} finally {
  await runtime?.close();
  await new Promise((resolve) => provider.close(resolve));
}
