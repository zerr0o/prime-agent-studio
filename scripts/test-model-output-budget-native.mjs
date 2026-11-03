// Focused native regression for model output budget.
// Loopback fake provider; isolated agentHome/sessionDir/dataDir only.
// - implicit default is model.maxTokens (128000), not min(...,32000).
// - explicit small caps and unknown/nonpositive fallback stay preserved.
// - main + genuine RLM child share the new default; child proved separately
//   via live inspector. Installed helper stays unmutated (hash equal).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgentRuntime, discoverCli } from '../lib/agent.mjs';
import { createLiveSessionClient } from '../lib/live-session-client.mjs';
import { createSubagentDefaultsStore } from '../lib/subagent-defaults.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(label + ' timed out');
    await sleep(60);
  }
}
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function sha256File(path) {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}
const textOf = (c) => (typeof c === 'string' ? c : JSON.stringify(c ?? null));
const userText = (r) =>
  (r.messages || [])
    .filter((m) => m && m.role === 'user')
    .map((m) => textOf(m.content))
    .join('\n');
const markerSnippet = (r, marker) => {
  const u = userText(r);
  const i = u.indexOf(marker);
  return i < 0 ? '' : u.slice(Math.max(0, i - 40), i + marker.length + 40).replace(/\s+/g, ' ');
};

const PROVIDER = 'fixture';
const BIG = 'big';
const TINY = 'tiny';
const BIG_MAX = 128000;
const TINY_MAX = 512;
const OLD_CAP = 32000;

const cli = discoverCli();
assert.ok(cli?.packageDir, 'native CLI packageDir must be discoverable');
const bundleDir = join(cli.packageDir, 'dist', 'bundle');
let helperPath = null;
let helperName = null;
for (const name of (await readdir(bundleDir)).filter((n) => n.endsWith('.js'))) {
  try {
    const src = await readFile(join(bundleDir, name), 'utf8');
    if (src.includes('function buildBaseOptions(')) {
      helperPath = join(bundleDir, name);
      helperName = name;
      break;
    }
  } catch {}
}
assert.ok(helperPath, 'helper defining buildBaseOptions must be discoverable');
const hashBefore = await sha256File(helperPath);
const helperSource = await readFile(helperPath, 'utf8');
const diskHasOldCap = helperSource.includes('32e3') || helperSource.includes('32000');

const loaderSource = await readFile(join(repoRoot, 'runtime', 'session-preferences-loader.mjs'), 'utf8');
const hookCandidates = [];
for (const name of (await readdir(join(repoRoot, 'runtime'))).filter((n) => n.endsWith('.mjs'))) {
  try {
    const src = await readFile(join(repoRoot, 'runtime', name), 'utf8');
    if (
      src.includes('buildBaseOptions') ||
      src.includes('output-budget') ||
      src.includes('outputBudget') ||
      src.includes('32e3')
    )
      hookCandidates.push(name);
  } catch {}
}

const { buildBaseOptions } = await import(pathToFileURL(helperPath).href);
assert.equal(typeof buildBaseOptions, 'function', 'buildBaseOptions must be importable');
assert.equal(
  buildBaseOptions({ maxTokens: BIG_MAX }, { maxTokens: TINY_MAX })?.maxTokens,
  TINY_MAX,
  'explicit 512 must be preserved',
);
assert.equal(
  buildBaseOptions({ maxTokens: 4096 }, {})?.maxTokens,
  4096,
  'explicit small model 4096 must be preserved',
);
assert.equal(
  buildBaseOptions({ maxTokens: 0 }, {})?.maxTokens,
  undefined,
  'nonpositive model cap must fall back to undefined',
);
assert.equal(buildBaseOptions({}, {})?.maxTokens, undefined, 'unknown model cap must fall back to undefined');
const helperDefaultActual = buildBaseOptions({ maxTokens: BIG_MAX }, {})?.maxTokens;

const root = await mkdtemp(join(tmpdir(), 'prime-output-budget-native-'));
const cwd = join(root, 'project');
const agentHome = join(root, 'agent');
const sessionDir = join(agentHome, 'sessions');
await Promise.all([cwd, agentHome, sessionDir].map((p) => mkdir(p, { recursive: true })));

const requests = [];
let releaseChildren = false;
let spawned = false;
const provider = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
  });
  req.on('end', async () => {
    try {
      const body = JSON.parse(raw);
      requests.push({
        model: body.model,
        cap: body.max_completion_tokens ?? body.max_tokens ?? null,
        messages: body.messages || [],
      });
      const users = (body.messages || [])
        .filter((m) => m && m.role === 'user')
        .map((m) => textOf(m.content))
        .join('\n');
      let code = null;
      if (users.includes('ROOT_BUDGET') && !spawned) {
        spawned = true;
        code =
          'import rlm\nchild = await rlm.spawn("CHILD_BUDGET", model="fixture/big", name="budget-child")\nprint("CHILD_SPAWNED")\n';
      } else if (!users.includes('ROOT_BUDGET') && !users.includes('TINY_CHECK') && !releaseChildren) {
        await until(() => releaseChildren, 60000, 'child release');
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (delta, finish = null) =>
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
      frame({ role: 'assistant' });
      if (code) {
        frame({
          tool_calls: [
            {
              index: 0,
              id: 'budget-0',
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
    } catch (e) {
      res.writeHead(500);
      res.end(String(e?.message || e));
    }
  });
});
await new Promise((done) => provider.listen(0, '127.0.0.1', done));

await writeFile(join(agentHome, 'auth.json'), '{}');
await writeFile(
  join(agentHome, 'settings.json'),
  JSON.stringify({
    defaultProvider: PROVIDER,
    defaultModel: BIG,
    defaultThinkingLevel: 'off',
    autoRefine: { enabled: false },
    compaction: { enabled: false },
    retry: { enabled: false },
    telemetry: { enabled: false, noticeShown: true },
  }),
);
await writeFile(
  join(agentHome, 'models.json'),
  JSON.stringify({
    providers: {
      [PROVIDER]: {
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1',
        apiKey: 'fixture-only',
        models: [
          {
            id: BIG,
            name: BIG,
            reasoning: false,
            input: ['text'],
            contextWindow: 200000,
            maxTokens: BIG_MAX,
          },
          {
            id: TINY,
            name: TINY,
            reasoning: false,
            input: ['text'],
            contextWindow: 131072,
            maxTokens: TINY_MAX,
          },
        ],
      },
    },
  }),
);

const defaults = createSubagentDefaultsStore({ dataDir: join(root, 'data') });
await defaults.set({ revision: '', policy: { model: 'fixture/' + BIG, thinking: 'off' } });

const runtime = createAgentRuntime({
  agentHome,
  sessionDir,
  subagentPolicyFile: defaults.file,
  env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' },
});
let client;
try {
  const first = await withTimeout(
    runtime.start({ cwd, message: 'ROOT_BUDGET', model: 'fixture/' + BIG, thinking: 'off' }),
    90000,
    'main start',
  );
  await until(
    () => {
      const hasMain = requests.some((r) => r.model === BIG && userText(r).includes('ROOT_BUDGET'));
      const hasChild = requests.some((r) => r.model === BIG && userText(r).includes('CHILD_BUDGET'));
      return hasMain && hasChild;
    },
    60000,
    'main+child provider requests',
  );
  client = createLiveSessionClient(runtime.getLiveEndpoint());
  const live = await until(
    async () => {
      try {
        const snap = await client.getInspector(first.sessionId, cwd);
        return snap?.children?.some((c) => c.sessionName === 'budget-child') ? snap : null;
      } catch {
        return null;
      }
    },
    60000,
    'budget-child inspector',
  );
  const child = live.children.find((c) => c.sessionName === 'budget-child');
  assert.ok(child, 'genuine RLM child budget-child must be visible in live inspector');
  assert.equal(child.model, 'fixture/' + BIG, 'child must inherit fixture/big model');

  const capOf = (r) => r.cap;
  const mainReq = requests.find((r) => r.model === BIG && userText(r).includes('ROOT_BUDGET'));
  const childReq = requests.find((r) => r.model === BIG && userText(r).includes('CHILD_BUDGET'));
  assert.ok(mainReq, 'main provider request must be recorded');
  assert.ok(childReq, 'child provider request must be recorded');
  assert.notEqual(mainReq, childReq, 'parent and child captures must be distinct requests');
  assert.ok(!userText(mainReq).includes('CHILD_BUDGET'), 'main user content must not contain child marker');
  assert.ok(!userText(childReq).includes('ROOT_BUDGET'), 'child user content must not contain parent marker');
  assert.equal(
    capOf(mainReq),
    BIG_MAX,
    'main cap must be ' + BIG_MAX + ' (old ' + OLD_CAP + ' fails pre-fix); got ' + capOf(mainReq),
  );
  assert.equal(
    capOf(childReq),
    BIG_MAX,
    'child cap must be ' + BIG_MAX + ' (old ' + OLD_CAP + ' fails pre-fix); got ' + capOf(childReq),
  );

  releaseChildren = true;
  const done = await withTimeout(first.done, 60000, 'main done');
  assert.equal(done.status, 'completed', 'main run must complete');

  const tinyStart = await withTimeout(
    runtime.start({ cwd, message: 'TINY_CHECK', model: 'fixture/' + TINY, thinking: 'off' }),
    90000,
    'tiny start',
  );
  await until(
    () => requests.some((r) => r.model === TINY && userText(r).includes('TINY_CHECK')),
    60000,
    'tiny provider request',
  );
  const tinyReq = requests.find((r) => r.model === TINY && userText(r).includes('TINY_CHECK'));
  assert.equal(capOf(tinyReq), TINY_MAX, 'tiny cap must stay ' + TINY_MAX + '; got ' + capOf(tinyReq));
  releaseChildren = true;
  const tinyDone = await withTimeout(tinyStart.done, 60000, 'tiny done');
  assert.equal(tinyDone.status, 'completed', 'tiny run must complete');

  const hashAfter = await sha256File(helperPath);
  assert.equal(hashAfter, hashBefore, 'installed helper must stay unmutated');
  console.log(
    JSON.stringify(
      {
        passed: true,
        classification: 'user-role-only',
        mainCap: capOf(mainReq),
        childCap: capOf(childReq),
        tinyCap: capOf(tinyReq),
        mainHasRoot: userText(mainReq).includes('ROOT_BUDGET'),
        mainHasChild: userText(mainReq).includes('CHILD_BUDGET'),
        childHasChild: userText(childReq).includes('CHILD_BUDGET'),
        childHasRoot: userText(childReq).includes('ROOT_BUDGET'),
        mainUser: markerSnippet(mainReq, 'ROOT_BUDGET'),
        childUser: markerSnippet(childReq, 'CHILD_BUDGET'),
        tinyUser: markerSnippet(tinyReq, 'TINY_CHECK'),
        distinctCaptures: mainReq !== childReq,
        explicitHelper512: buildBaseOptions({ maxTokens: BIG_MAX }, { maxTokens: TINY_MAX })?.maxTokens,
        helperDefaultActual,
        helperName,
        diskHasOldCap,
        hashBefore,
        hashAfter,
        hookCandidates,
        loaderHasSessionPreferences: loaderSource.includes('session-preferences.mjs'),
        childSession: child.sessionName,
        childModel: child.model,
        requests: requests.map((r) => ({
          model: r.model,
          cap: r.cap,
          hasRoot: userText(r).includes('ROOT_BUDGET'),
          hasChild: userText(r).includes('CHILD_BUDGET'),
          hasTiny: userText(r).includes('TINY_CHECK'),
        })),
        root,
      },
      null,
      2,
    ),
  );
} finally {
  releaseChildren = true;
  try {
    client?.close();
  } catch {}
  await withTimeout(
    runtime.close().catch(() => {}),
    30000,
    'runtime close',
  ).catch(() => {});
  await withTimeout(new Promise((done) => provider.close(done)), 15000, 'provider close').catch(() => {});
}
