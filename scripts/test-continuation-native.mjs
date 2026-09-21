// Real engine and Python with a local fake provider. No user sessions or model account.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const runtimeRoot = resolve(
  process.env.PRIME_STUDIO_TEST_RUNTIME_ROOT || fileURLToPath(new URL('..', import.meta.url)),
);
const { createAgentRuntime } = await import(pathToFileURL(join(runtimeRoot, 'lib/agent.mjs')).href);
const root = await mkdtemp(join(tmpdir(), 'studio-continuation-native-'));
const cwd = join(root, 'project'),
  agentHome = join(root, 'agent');
await Promise.all([cwd, agentHome].map((p) => mkdir(p, { recursive: true })));
const release = join(cwd, 'release'),
  alive = join(cwd, 'alive'),
  exited = join(cwd, 'exited');
const taskFile = join(cwd, 'background.py');
await writeFile(
  taskFile,
  `from pathlib import Path
import time
release = Path(${JSON.stringify(release)})
Path(${JSON.stringify(alive)}).write_text('alive')
deadline = time.monotonic() + 90
while not release.exists() and time.monotonic() < deadline:
    time.sleep(0.03)
Path(${JSON.stringify(exited)}).write_text('exited')
`,
);
const code = `import sys
short = bash('"' + sys.executable + '" -c "print(2372)"')
result = await short
assert result.exit_code == 0 and '2372' in result.output
background = bash('"' + sys.executable + '" "' + ${JSON.stringify(taskFile)} + '"')
print('BASH_RESULT_CONSUMED')`;
const events = [],
  requests = [];
const provider = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const frame = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-continuation',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'continuation',
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`,
    );
  frame({ role: 'assistant' });
  if (requests.length === 1) {
    frame({
      tool_calls: [
        {
          index: 0,
          id: 'call_consume',
          type: 'function',
          function: {
            name: 'ipython',
            arguments: JSON.stringify({ code }),
          },
        },
      ],
    });
    frame({}, 'tool_calls');
  } else {
    frame({ content: 'POST_TOOL_CONTINUATION_OK' });
    frame({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
});
await new Promise((done) => provider.listen(0, '127.0.0.1', done));
await writeFile(join(agentHome, 'auth.json'), '{}');
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
            id: 'continuation',
            name: 'Local fixture',
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
await writeFile(
  join(agentHome, 'settings.json'),
  JSON.stringify({
    defaultProvider: 'fixture',
    defaultModel: 'continuation',
    defaultThinkingLevel: 'off',
    autoRefine: { enabled: false },
    compaction: { enabled: false },
    retry: { enabled: false },
    telemetry: { enabled: false, noticeShown: true },
  }),
);
async function until(check, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('Continuation fixture timed out');
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Completion timed out')), 60000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const runtime = createAgentRuntime({
  agentHome,
  sessionDir: join(agentHome, 'sessions'),
  kernelRoot: root,
  env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' },
});
let completed = false;
try {
  const handle = await bounded(
    runtime.start({
      cwd,
      message: 'Run the local fixture.',
      model: 'fixture/continuation',
      thinking: 'off',
      onEvent: (e) => events.push(e),
    }),
  );
  handle.done.then(() => {
    completed = true;
  });
  await until(() => {
    assert.equal(completed, false, JSON.stringify(events));
    return events.some((e) => e.kind === 'status' && e.status === 'turn_end') && requests.length >= 2;
  });
  await until(() =>
    readFile(alive).then(
      () => true,
      () => false,
    ),
  );
  assert.equal(requests.length, 2, 'One continuation after the consumed tool result');
  assert.ok(
    JSON.stringify(requests[1]).includes('BASH_RESULT_CONSUMED'),
    'Continuation includes tool output',
  );
  // This delay is a bounded regression assertion: an open background task must not
  // be disposed at agent_end. It is not a production completion heuristic.
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(completed, false, 'Turn boundary does not close the worker');
  assert.equal(
    events.some((e) => e.kind === 'done'),
    false,
    'No premature done event',
  );
  assert.equal(
    await readFile(exited).then(
      () => true,
      () => false,
    ),
    false,
    'Background task remains alive',
  );
  await writeFile(release, 'release own fixture task');
  const result = await bounded(handle.done);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(await readFile(exited, 'utf8'), 'exited', 'Task finished itself before worker disposal');
  assert.equal(events.filter((e) => e.kind === 'done').length, 1, 'One terminal event');
  const lastDone = events.findLastIndex((e) => e.kind === 'done');
  assert.ok(lastDone > events.findIndex((e) => e.kind === 'status' && e.status === 'turn_end'));
  console.log(
    JSON.stringify({
      passed: true,
      requests: requests.length,
      checks: [
        'Real Python bash result consumption followed by a model continuation',
        'agent_end is nonterminal and leaves the background task alive',
        'Normal completion only after task settlement, exactly one done',
      ],
    }),
  );
} catch (error) {
  await writeFile(
    join(root, 'diagnostic.json'),
    JSON.stringify({ error: String(error.stack), events, requests }, null, 2),
  );
  console.error(`Isolated diagnostic: ${root}`);
  throw error;
} finally {
  await writeFile(release, 'cleanup own fixture task');
  await runtime.close();
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
}
