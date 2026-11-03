// End-to-end native regression for per-conversation sharedMemories.
// Uses a deterministic LOOPBACK fake provider; no real model calls, account,
// private memories, desktop, build or publication. Temporary agentHome,
// sessionDir and dataDir only. Real native extension loading, real provider
// payloads and real RLM child inheritance are exercised.
//
// Contract under test (runtime glue owned by sibling tasks):
// - input.sharedMemories on createAgentRuntime().start(), default false.
// - true preserves current global memories/refinements; false hides them.
// - A global prompt rule stays visible in both modes.
// - The flag propagates to native RLM children and is re-applied on resume
//   (never sticky process state).
// - studio_knowledge_search/read return globals only when on, while
//   same-project local evidence/history stays available in both modes.
// - Old on-state tool results may legitimately keep past global text; the
//   adapter must suppress old auto-generated harness digests when off
//   without deleting ordinary history.
// - A stale global source id read after switching off must stay blocked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime, discoverCli } from '../lib/agent.mjs';
import { createStore } from '../lib/store.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

const NONCE = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
// Synthetic fixture tokens only. Never real user data.
const GM = 'SHM_GLOBAL_MEM_' + NONCE;
const GR = 'SHM_GLOBAL_REF_' + NONCE;
const GP = 'SHM_GLOBAL_PROMPT_' + NONCE;
const LM = 'SHM_LOCAL_MEM_' + NONCE;
const LM2 = 'SHM_LOCAL_FRESH_' + NONCE;
const HIST = 'SHM_PRIOR_HISTORY_' + NONCE;
const OTHER = 'SHM_OTHER_PROJECT_' + NONCE;
const USERTOK = 'SHM_USER_MSG_' + NONCE;
const FINISH = 'Shared-memory verification complete.';

const PA = 'sm-parent-a';
const CA = 'sm-child-a';
const PB = 'sm-parent-b';
const CB = 'sm-child-b';
const PROVIDER = 'fixture';

const root = await mkdtemp(join(tmpdir(), 'prime-shared-memories-native-'));
const cwd = join(root, 'Projet e');
const other = join(root, 'Autre projet');
const agentHome = join(root, 'agent');
const sessionDir = join(agentHome, 'sessions');
const dataDir = join(root, 'studio');
await Promise.all([cwd, other, sessionDir].map((path) => mkdir(path, { recursive: true })));

const cli = discoverCli();
assert.ok(cli, 'Real Prime Agent CLI was not discovered via discoverCli().');

const store = createStore({ sessionDir, dataDir });
await store.project({ cwd });
await store.project({ cwd: other });

// ---- Synthetic native harness: global memory + global prompt rule ----
const globalState = {
  schema: 1,
  entries: {
    prompt: {
      shmGlobalPrompt: {
        title: GP + ' always-applied routing rule',
        content: GP + ' keep this routing rule visible even when memory sharing is off.',
        scope: 'global',
        version: 1,
        path: 'fixture-global',
      },
    },
    memory: {
      shmGlobalMem: {
        title: GM + ' long-lived project lesson',
        content: GM + ' synthetic lesson kept only while sharedMemories is true.',
        scope: 'global',
        version: 1,
        path: 'fixture-global',
      },
    },
    skill: {},
    subagent: {},
  },
  // Engine digest renders recent refinements from the harness_state.json
  // array (the jsonl history feeds Studio knowledge search instead).
  refinements: [
    {
      id: 'shm-global-ref-1',
      trigger: 'fixture-seed',
      changes: ['seeded one synthetic global refinement'],
      outcome: GR + ' synthetic refinement outcome kept only while sharedMemories is true.',
    },
  ],
};
await mkdir(join(agentHome, 'harness'), { recursive: true });
await writeFile(join(agentHome, 'harness', 'harness_state.json'), JSON.stringify(globalState, null, 2));
await writeFile(
  join(agentHome, 'harness', 'refinements.jsonl'),
  JSON.stringify({
    id: 'shm-global-ref-1',
    trigger: 'fixture-seed',
    changes: ['seeded one synthetic global refinement'],
    outcome: GR + ' synthetic refinement outcome kept only while sharedMemories is true.',
    summary: GR + ' synthetic global refinement.',
    scope: 'global',
    appliedEdits: [
      {
        id: 'shm-edit-1',
        action: 'create',
        kind: 'memory',
        applied: true,
        after: { id: 'shmGlobalMem', scope: 'global', title: GM, content: GM },
      },
    ],
  }) + '\n',
);

// ---- Same-project prior history (stays available in both modes) ----
async function history(id, project, answer) {
  const entries = [
    { type: 'session', version: 3, id, cwd: project, timestamp: '2026-09-04T12:00:00.000Z' },
    {
      type: 'message',
      id: id + '-user',
      parentId: null,
      timestamp: '2026-09-04T12:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Prior fixture research' }] },
    },
    {
      type: 'message',
      id: id + '-answer',
      parentId: id + '-user',
      timestamp: '2026-09-04T12:01:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: answer }], stopReason: 'stop' },
    },
  ];
  await writeFile(
    join(sessionDir, id + '.jsonl'),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
}
await history('prior-own', cwd, HIST + ' measured phase correction with a 48 kHz impulse response.');
await history('prior-other', other, OTHER);

// ---- Provider fixture, registries and payload audit ----
const calls = [];
const requests = [];
const events = [];
const scripts = new Map();
const stage = new Map();
const expects = new Map();
const seen = new Map();

function beginTurn() {
  scripts.clear();
  stage.clear();
  expects.clear();
  seen.clear();
}
function watch(model, exp) {
  expects.set(model, exp);
  seen.set(model, {
    gmDigest: false,
    grDigest: false,
    gpDigest: false,
    digestSeen: false,
    lm2Seen: false,
    lm2Clean: false,
    gmTool: false,
    hist: false,
    histPrior: false,
  });
}

function lastTool(body) {
  const message = (body.messages || []).findLast((entry) => entry && entry.role === 'tool');
  if (!message) return null;
  const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text).slice(0, 2000) };
  }
}
function globalItemsOf(result, kinds) {
  const items = result && Array.isArray(result.items) ? result.items : [];
  return items.filter((item) => item && item.scope === 'global' && kinds.includes(item.kind));
}
// Neutral lookup keys, distinct from sentinel body values: assistant tool-call
// arguments carry the query, so queries must never contain sentinel tokens.
const QUERIES = new Map([
  [GM, 'long-lived project lesson'],
  [GP, 'always-applied routing rule'],
  [GR, 'synthetic global refinement'],
  [LM, 'session-local lesson'],
  [HIST, 'measured phase correction'],
]);
const searchTool = (key, limit = 5) => ({
  name: 'studio_knowledge_search',
  arguments: { q: QUERIES.get(key) || key, limit },
});
const readTool = (id) => ({ name: 'studio_knowledge_read', arguments: { id } });
const spawnTool = (model, name) => ({
  name: 'ipython',
  arguments: {
    code:
      'child = await rlm.spawn("Recheck the memory sentinel", model="fixture/' +
      model +
      '", name="' +
      name +
      '")\nprint("CHILD_ADMITTED")',
  },
});

function audit(model, body) {
  const exp = expects.get(model);
  if (!exp) throw new Error(model + ': no expectation registered for this turn');
  const state = seen.get(model);
  const dump = JSON.stringify(body.messages);
  if (dump.includes(OTHER)) throw new Error(model + ': cross-project private evidence leaked into payload');
  // Inspect only native <harness_state> digest blocks. Ordinary assistant/tool
  // history is preserved and never flagged: probes use neutral lookup keys and
  // old on-state tool results may legitimately keep past global text.
  const digests = (body.messages || [])
    .filter((entry) => entry && JSON.stringify(entry).includes('<harness_state>'))
    .map((entry) => JSON.stringify(entry));
  if (digests.length > 0) state.digestSeen = true;
  for (const text of digests) {
    if (text.includes(GM)) state.gmDigest = true;
    if (text.includes(GR)) state.grDigest = true;
    if (text.includes(GP)) state.gpDigest = true;
    if (text.includes(LM2)) {
      state.lm2Seen = true;
      if (!text.includes(GM) && !text.includes(GR)) state.lm2Clean = true;
    }
  }
  const toolDump = JSON.stringify((body.messages || []).filter((entry) => entry && entry.role === 'tool'));
  if (toolDump.includes(GM)) state.gmTool = true;
  if (dump.includes(USERTOK)) state.hist = true;
  if (dump.includes(HIST)) state.histPrior = true;
  if (exp.digestGM === false && digests.some((text) => text.includes(GM)))
    throw new Error(
      model +
        ': global memory sentinel in harness digest while sharedMemories=false; ' +
        'auto-generated digests must be filtered, ordinary history is preserved',
    );
  if (exp.digestGR === false && digests.some((text) => text.includes(GR)))
    throw new Error(model + ': global refinement sentinel in harness digest while sharedMemories=false');
}

let runtime;
const provider = createServer(async (req, res) => {
  let body = null;
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
    const model = String(body.model || '')
      .split('/')
      .pop();
    requests.push({ model, roles: (body.messages || []).map((entry) => entry && entry.role).join(',') });
    const names = (body.tools || []).map((tool) => tool.function.name);
    assert.ok(names.includes('studio_knowledge_search'), model + ': search not discovered');
    assert.ok(names.includes('studio_knowledge_read'), model + ': read not discovered');
    if (model === PA || model === PB)
      assert.ok(names.includes('ipython'), model + ': ipython not discovered');
    audit(model, body);
    const step = stage.get(model) || 0;
    const list = scripts.get(model);
    if (!list) throw new Error(model + ': no script registered');
    let tool;
    if (step < list.length) {
      stage.set(model, step + 1);
      tool = list[step](body);
      calls.push(model + ':step' + step);
    } else if (step < list.length + 3) {
      // Bounded settle capacity: the engine delivers one [child-exited]
      // notice per detached child into the parent session, which surfaces as
      // an extra provider request (possibly in a later resumed turn).
      stage.set(model, step + 1);
      calls.push(model + ':settle' + (step - list.length));
      tool = null;
    } else throw new Error(model + ': no script for step ' + step);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish = null) =>
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'fixture-' + requests.length,
            object: 'chat.completion.chunk',
            created: 1,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          }) +
          '\n\n',
      );
    frame({ role: 'assistant' });
    if (tool) {
      frame({
        tool_calls: [
          {
            index: 0,
            id: model + '-' + step,
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
          },
        ],
      });
      frame({}, 'tool_calls');
    } else {
      frame({ content: FINISH });
      frame({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  } catch (error) {
    calls.push({ error: error.message });
    // Synthetic fixture data only; bounded failing-payload trace for diagnosis.
    await writeFile(
      join(root, 'failing-body.json'),
      JSON.stringify(
        {
          error: error.message,
          model: String((body && body.model) || ''),
          roles: ((body && body.messages) || []).map((entry) => entry && entry.role),
          nonToolHits: ((body && body.messages) || [])
            .filter((entry) => entry && entry.role !== 'tool')
            .map((entry) => JSON.stringify(entry).slice(0, 600)),
          toolHits: ((body && body.messages) || [])
            .filter((entry) => entry && entry.role === 'tool')
            .map((entry) => JSON.stringify(entry).slice(0, 600)),
        },
        null,
        2,
      ),
    ).catch(() => {});
    res.writeHead(500);
    res.end(error.message);
  }
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));

const settings = JSON.stringify({
  defaultProvider: PROVIDER,
  defaultModel: PA,
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
      [PROVIDER]: {
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1',
        apiKey: 'fixture-only',
        models: [PA, CA, PB, CB].map((id) => ({
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

async function waitForMarkers(markers, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (calls.some((item) => item && item.error))
      throw new Error(label + ' failed: ' + JSON.stringify(calls.filter((item) => item && item.error)));
    if (markers.every((marker) => calls.includes(marker))) return;
    await sleep(100);
  }
  throw new Error(label + ' timed out; calls=' + JSON.stringify(calls.slice(-12)));
}
async function waitSessionId(handle, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (handle.sessionId) return handle.sessionId;
    await sleep(50);
  }
  throw new Error(label + ': native session id never arrived');
}

const shared = { staleId: null, sessionA: null };
const summary = { phases: [], skipped: ['compaction: no deterministic trigger in the loopback fixture'] };

function childScript(childModel, parentLabel, expectOn) {
  return [
    () => searchTool(GM),
    (body) => {
      const result = lastTool(body);
      const hits = globalItemsOf(result, ['memory']);
      if (expectOn) {
        assert.ok(hits.length > 0, childModel + ': expected global memory while on');
        assert.ok(JSON.stringify(result).includes(GM), childModel + ': memory body missing sentinel');
      } else {
        assert.equal(
          hits.length,
          0,
          childModel + ': global memory leaked while off: ' + JSON.stringify(result).slice(0, 400),
        );
        assert.ok(!JSON.stringify(result).includes(GM), childModel + ': memory sentinel leaked while off');
      }
      calls.push(parentLabel + ':child-gm-checked');
      return searchTool(GP);
    },
    (body) => {
      const result = lastTool(body);
      const hits = globalItemsOf(result, ['prompt']);
      assert.ok(hits.length > 0, childModel + ': global prompt rule must remain in both modes');
      assert.ok(JSON.stringify(result).includes(GP), childModel + ': prompt body missing sentinel');
      calls.push(parentLabel + ':child-done');
      return null;
    },
  ];
}

try {
  runtime = createAgentRuntime({
    agentHome,
    sessionDir,
    knowledge: { dataDir },
    env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' },
  });

  // ---- Phase 1: simultaneous independent roots, explicit true vs fresh default-off ----
  beginTurn();
  scripts.set(PA, [
    () => searchTool(GM),
    (body) => {
      const result = lastTool(body);
      const hits = globalItemsOf(result, ['memory']);
      assert.ok(hits.length > 0, 'A: expected global memory hits while on');
      assert.ok(JSON.stringify(result).includes(GM), 'A: global memory body missing sentinel');
      shared.staleId = hits[0].id;
      assert.match(shared.staleId, /^[a-f0-9]{64}$/, 'A: expected a stable knowledge source id');
      return searchTool(GP);
    },
    (body) => {
      const result = lastTool(body);
      assert.ok(globalItemsOf(result, ['prompt']).length > 0, 'A: prompt rule must remain while on');
      assert.ok(JSON.stringify(result).includes(GP), 'A: prompt body missing sentinel');
      return searchTool(GR);
    },
    (body) => {
      const result = lastTool(body);
      assert.ok(
        globalItemsOf(result, ['refinement']).length > 0,
        'A: expected global refinement hits while on',
      );
      assert.ok(JSON.stringify(result).includes(GR), 'A: refinement body missing sentinel');
      return readTool(shared.staleId);
    },
    (body) => {
      const result = lastTool(body);
      assert.ok((result.body || '').includes(GM), 'A: direct read must return the global body while on');
      return spawnTool(CA, 'sm-child-a-t1');
    },
    (body) => {
      assert.ok(JSON.stringify(lastTool(body)).includes('CHILD_ADMITTED'), 'A: child was not admitted');
      calls.push('A:spawned');
      return null;
    },
  ]);
  scripts.set(CA, childScript(CA, 'A', true));
  scripts.set(PB, [
    () => searchTool(GM),
    (body) => {
      const result = lastTool(body);
      assert.equal(
        globalItemsOf(result, ['memory', 'refinement']).length,
        0,
        'B: globals must be hidden by default',
      );
      assert.ok(!JSON.stringify(result).includes(GM), 'B: memory sentinel leaked with default off');
      return searchTool(GP);
    },
    (body) => {
      const result = lastTool(body);
      assert.ok(globalItemsOf(result, ['prompt']).length > 0, 'B: prompt rule must remain with default off');
      assert.ok(JSON.stringify(result).includes(GP), 'B: prompt body missing sentinel');
      return searchTool(HIST);
    },
    (body) => {
      const result = lastTool(body);
      assert.ok(
        JSON.stringify(result).includes(HIST),
        'B: same-project history must stay available with default off',
      );
      calls.push('B:hist-hit');
      return spawnTool(CB, 'sm-child-b-t1');
    },
    (body) => {
      assert.ok(JSON.stringify(lastTool(body)).includes('CHILD_ADMITTED'), 'B: child was not admitted');
      calls.push('B:spawned');
      return null;
    },
  ]);
  scripts.set(CB, childScript(CB, 'B', false));
  watch(PA, { digestGM: true, digestGR: true });
  watch(CA, { digestGM: true, digestGR: true });
  watch(PB, { digestGM: false, digestGR: false });
  watch(CB, { digestGM: false, digestGR: false });

  const handleA = await runtime.start({
    cwd,
    message: 'Survey prior findings ' + USERTOK + ' and delegate a second lookup.',
    model: PROVIDER + '/' + PA,
    sharedMemories: true,
    onEvent: (event) => events.push(event),
  });
  // Fresh default-off: the sharedMemories flag is deliberately omitted.
  const handleB = await runtime.start({
    cwd,
    message: 'Survey prior findings with defaults and delegate a second lookup.',
    model: PROVIDER + '/' + PB,
    onEvent: (event) => events.push(event),
  });
  await waitForMarkers(
    ['A:spawned', 'A:child-done', 'B:spawned', 'B:child-done', 'B:hist-hit'],
    240000,
    'phase1',
  );
  assert.equal((await withTimeout(handleA.done, 120000, 'root A')).status, 'completed');
  assert.equal((await withTimeout(handleB.done, 120000, 'root B')).status, 'completed');
  shared.sessionA = await waitSessionId(handleA, 30000, 'phase1');
  assert.equal(seen.get(PA).gmDigest, true, 'A: harness digest must carry the global memory while on');
  assert.equal(seen.get(PA).grDigest, true, 'A: harness digest must carry the global refinement while on');
  assert.equal(seen.get(PA).gpDigest, true, 'A: harness digest must carry the prompt rule while on');
  assert.equal(seen.get(CA).gmDigest, true, 'child A: must inherit sharedMemories=true');
  assert.equal(
    seen.get(PB).gmDigest,
    false,
    'B: harness digest must hide the global memory with default off',
  );
  assert.equal(
    seen.get(PB).grDigest,
    false,
    'B: harness digest must hide the global refinement with default off',
  );
  assert.equal(seen.get(PB).gpDigest, true, 'B: harness digest must keep the prompt rule with default off');
  assert.equal(seen.get(CB).gmDigest, false, 'child B: must inherit default off');
  assert.equal(seen.get(CB).gpDigest, true, 'child B: prompt rule must remain with default off');
  assert.equal(seen.get(PA).digestSeen, true, 'A: expected harness digest blocks in provider payloads');
  assert.equal(seen.get(PB).digestSeen, true, 'B: expected harness digest blocks in provider payloads');
  summary.phases.push('simultaneous-on-off-with-child-inheritance');

  // ---- Seed a local native memory once the native session id is known ----
  await mkdir(join(agentHome, 'session-artifacts', shared.sessionA, 'harness'), { recursive: true });
  await writeFile(
    join(agentHome, 'session-artifacts', shared.sessionA, 'harness', 'harness_state.json'),
    JSON.stringify({
      schema: 1,
      entries: {
        memory: {
          shmLocalMem: {
            title: LM + ' session-local lesson',
            content: LM + ' synthetic local memory that must survive resume in both modes.',
            scope: 'local',
            version: 1,
            path: 'fixture-local',
          },
        },
        prompt: {},
        skill: {},
        subagent: {},
      },
      refinements: [],
    }),
  );

  // ---- Phase 2: same native conversation true -> false ----
  beginTurn();
  scripts.set(PA, [
    () => searchTool(GM),
    (body) => {
      const result = lastTool(body);
      assert.equal(
        globalItemsOf(result, ['memory', 'refinement']).length,
        0,
        'Aoff: globals must hide after switch',
      );
      return searchTool(LM);
    },
    (body) => {
      const result = lastTool(body);
      assert.ok(JSON.stringify(result).includes(LM), 'Aoff: seeded local memory must be retained on resume');
      calls.push('Aoff:local-kept');
      return searchTool(GP);
    },
    (body) => {
      const result = lastTool(body);
      assert.ok(globalItemsOf(result, ['prompt']).length > 0, 'Aoff: prompt rule must remain after switch');
      return searchTool(HIST);
    },
    (body) => {
      const result = lastTool(body);
      assert.ok(
        JSON.stringify(result).includes(HIST),
        'Aoff: same-project history must stay available after switch',
      );
      return readTool(shared.staleId);
    },
    (body) => {
      const result = lastTool(body);
      assert.ok(
        !(result.body || '').includes(GM),
        'Aoff: stale global source id must stay blocked after switch',
      );
      return searchTool(GR);
    },
    (body) => {
      const result = lastTool(body);
      assert.equal(
        globalItemsOf(result, ['refinement']).length,
        0,
        'Aoff: global refinements must hide after switch',
      );
      return spawnTool(CA, 'sm-child-a-t2');
    },
    (body) => {
      assert.ok(JSON.stringify(lastTool(body)).includes('CHILD_ADMITTED'), 'Aoff: child was not admitted');
      calls.push('Aoff:spawned');
      return null;
    },
  ]);
  scripts.set(CA, [
    () => searchTool(GM),
    (body) => {
      const result = lastTool(body);
      assert.equal(
        globalItemsOf(result, ['memory', 'refinement']).length,
        0,
        'child Aoff: must follow latest choice',
      );
      calls.push('Aoff:child-done');
      return null;
    },
  ]);
  watch(PA, { digestGM: false, digestGR: false });
  watch(CA, { digestGM: false, digestGR: false });
  const resumeOff = await runtime.start({
    cwd,
    message: 'Recheck the same sentinels after sharing was switched off.',
    model: PROVIDER + '/' + PA,
    sessionId: shared.sessionA,
    sharedMemories: false,
    onEvent: (event) => events.push(event),
  });
  await waitForMarkers(['Aoff:local-kept', 'Aoff:spawned', 'Aoff:child-done'], 180000, 'phase2');
  assert.equal((await withTimeout(resumeOff.done, 120000, 'resume off')).status, 'completed');
  assert.equal(seen.get(PA).gmDigest, false, 'Aoff: old digests must be suppressed without deleting history');
  assert.equal(seen.get(PA).grDigest, false, 'Aoff: old refinement digests must be suppressed');
  assert.equal(seen.get(PA).gpDigest, true, 'Aoff: prompt rule must remain after switch');
  assert.equal(seen.get(PA).gmTool, true, 'Aoff: ordinary old tool results must be kept');
  assert.equal(seen.get(PA).hist, true, 'Aoff: existing user history must remain on resume');
  assert.equal(seen.get(PA).histPrior, true, 'Aoff: same-project evidence must stay available');
  assert.equal(seen.get(CA).gmDigest, false, 'child Aoff: must follow the latest false choice');
  assert.equal(seen.get(PA).digestSeen, true, 'Aoff: expected harness digest blocks in provider payloads');
  summary.phases.push('same-session-true-to-false');

  // ---- Phase 3: same native conversation false -> true (not sticky) ----
  beginTurn();
  scripts.set(PA, [
    () => searchTool(GM),
    (body) => {
      const result = lastTool(body);
      assert.ok(
        globalItemsOf(result, ['memory']).length > 0,
        'Aon: globals must return after switching back on',
      );
      calls.push('Aon:gm-back');
      return null;
    },
  ]);
  watch(PA, { digestGM: true, digestGR: true });
  const resumeOn = await runtime.start({
    cwd,
    message: 'Recheck the same sentinels after sharing was switched back on.',
    model: PROVIDER + '/' + PA,
    sessionId: shared.sessionA,
    sharedMemories: true,
    onEvent: (event) => events.push(event),
  });
  await waitForMarkers(['Aon:gm-back'], 120000, 'phase3');
  assert.equal((await withTimeout(resumeOn.done, 120000, 'resume on')).status, 'completed');
  assert.equal(seen.get(PA).gmDigest, true, 'Aon: digest must carry globals again after switching back on');
  assert.equal(seen.get(PA).hist, true, 'Aon: existing user history must remain on resume');
  assert.equal(seen.get(PA).digestSeen, true, 'Aon: expected harness digest blocks in provider payloads');
  summary.phases.push('same-session-false-to-true');

  // ---- Phase 4: restart (fresh runtime) then resume with explicit false ----
  await runtime.close();
  runtime = createAgentRuntime({
    agentHome,
    sessionDir,
    knowledge: { dataDir },
    env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' },
  });
  beginTurn();
  scripts.set(PA, [
    () => searchTool(GM),
    (body) => {
      const result = lastTool(body);
      assert.equal(
        globalItemsOf(result, ['memory', 'refinement']).length,
        0,
        'Arestart: globals must hide after restart',
      );
      calls.push('Arestart:off-ok');
      return null;
    },
  ]);
  watch(PA, { digestGM: false, digestGR: false });
  const resumeRestart = await runtime.start({
    cwd,
    message: 'Final recheck after a runtime restart with sharing off.',
    model: PROVIDER + '/' + PA,
    sessionId: shared.sessionA,
    sharedMemories: false,
    onEvent: (event) => events.push(event),
  });
  await waitForMarkers(['Arestart:off-ok'], 120000, 'phase4');
  assert.equal((await withTimeout(resumeRestart.done, 120000, 'resume after restart')).status, 'completed');
  assert.equal(seen.get(PA).gmDigest, false, 'Arestart: digest must hide globals after restart');
  assert.equal(seen.get(PA).gpDigest, true, 'Arestart: prompt rule must remain after restart');
  assert.equal(seen.get(PA).hist, true, 'Arestart: existing user history must remain after restart');
  assert.equal(
    seen.get(PA).digestSeen,
    true,
    'Arestart: expected harness digest blocks in provider payloads',
  );
  summary.phases.push('restart-resume-off');

  // ---- Phase 5: existing-child reuse across an on->off toggle ----
  // The parent admits one stable-name child while on, then after switching
  // off sends a new task to the SAME child via agent_message (receiver_role
  // child), not a fresh spawn. The rehydrated follow-up turn must honor the
  // latest false choice instead of retaining the old true state.
  const REUSE_CHILD = 'sm-reuse-child';
  const REUSE_TASK = 'RECHECK_GLOBAL_SENTINEL follow-up in the same child session';
  beginTurn();
  scripts.set(PA, [
    () => spawnTool(CA, REUSE_CHILD),
    (body) => {
      assert.ok(
        JSON.stringify(lastTool(body)).includes('CHILD_ADMITTED'),
        'R1: reuse child was not admitted',
      );
      calls.push('R1:spawned');
      return null;
    },
  ]);
  scripts.set(CA, [
    () => searchTool(GM),
    (body) => {
      const result = lastTool(body);
      assert.ok(globalItemsOf(result, ['memory']).length > 0, 'R1 child: expected global hits while on');
      calls.push('R1:child-on-ok');
      return searchTool(GP);
    },
    (body) => {
      const result = lastTool(body);
      assert.ok(globalItemsOf(result, ['prompt']).length > 0, 'R1 child: prompt rule must remain while on');
      calls.push('R1:child-done');
      return null;
    },
  ]);
  watch(PA, { digestGM: true, digestGR: true });
  watch(CA, { digestGM: true, digestGR: true });
  const reuseOn = await runtime.start({
    cwd,
    message: 'Admit one stable child for a later reuse check.',
    model: PROVIDER + '/' + PA,
    sessionId: shared.sessionA,
    sharedMemories: true,
    onEvent: (event) => events.push(event),
  });
  await waitForMarkers(['R1:spawned', 'R1:child-on-ok', 'R1:child-done'], 180000, 'phase5-on');
  assert.equal((await withTimeout(reuseOn.done, 120000, 'reuse on')).status, 'completed');
  assert.equal(seen.get(CA).gmDigest, true, 'R1 child: must inherit sharedMemories=true');
  assert.equal(seen.get(PA).digestSeen, true, 'R1: expected harness digest blocks in provider payloads');
  summary.phases.push('reuse-child-admit-on');

  beginTurn();
  scripts.set(PA, [
    () => ({
      name: 'ipython',
      arguments: {
        code:
          'import agent_message, agent_observe, json\n' +
          'roster = await agent_observe.list_agents()\n' +
          'entry = next((a for a in roster.get("agents", []) if a.get("sessionName") == "' +
          REUSE_CHILD +
          '"), None)\n' +
          'print("REUSE_CHILD_STATUS:" + (json.dumps({k: entry.get(k) for k in ("status", "isSessionActive", "relationship", "sessionName")}) if entry else "missing"))\n' +
          'r = await agent_message.send("' +
          REUSE_TASK +
          '", receiver_role="child", receiver_name="' +
          REUSE_CHILD +
          '")\nprint("REUSE_SENT")',
      },
    }),
    (body) => {
      const text = JSON.stringify(lastTool(body));
      assert.ok(text.includes('REUSE_SENT'), 'R2: reuse message was not sent');
      // Non-hydrating roster read taken BEFORE send: resident (active) vs
      // rehydration (inactive) follow-up path.
      const match = text.match(/REUSE_CHILD_STATUS:(\{[^}]*\}|missing)/);
      assert.ok(match, 'R2: missing pre-send child status');
      shared.reuseChildPreSend = match[1];
      let parsed = null;
      try {
        parsed = JSON.parse(match[1]);
      } catch {}
      shared.reuseMode =
        parsed && parsed.isSessionActive === true ? 'resident' : 'existing-child rehydration';
      calls.push('R2:sent');
      calls.push('R2:child-was-' + (parsed && parsed.status ? parsed.status : 'unknown'));
      return null;
    },
  ]);
  scripts.set(CA, [
    () => searchTool(GM),
    (body) => {
      const result = lastTool(body);
      assert.equal(
        globalItemsOf(result, ['memory', 'refinement']).length,
        0,
        'R2 child: rehydrated follow-up must not retain old true state: ' +
          JSON.stringify(result).slice(0, 400),
      );
      assert.ok(!JSON.stringify(result).includes(GM), 'R2 child: memory sentinel leaked after parent off');
      calls.push('R2:child-off-ok');
      return null;
    },
  ]);
  watch(PA, { digestGM: false, digestGR: false });
  watch(CA, { digestGM: false, digestGR: false });
  const reuseOff = await runtime.start({
    cwd,
    message: 'Send a follow-up to the same child after sharing was switched off.',
    model: PROVIDER + '/' + PA,
    sessionId: shared.sessionA,
    sharedMemories: false,
    onEvent: (event) => events.push(event),
  });
  await waitForMarkers(['R2:sent', 'R2:child-off-ok'], 180000, 'phase5-off');
  assert.equal((await withTimeout(reuseOff.done, 120000, 'reuse off')).status, 'completed');
  assert.equal(
    seen.get(CA).digestSeen,
    true,
    'R2 child: expected harness digest blocks in provider payloads',
  );
  assert.equal(
    seen.get(CA).gmDigest,
    false,
    'R2 child: rehydrated digest must hide globals after parent off',
  );
  assert.equal(
    seen.get(CA).grDigest,
    false,
    'R2 child: rehydrated digest must hide refinements after parent off',
  );
  assert.equal(seen.get(CA).gpDigest, true, 'R2 child: prompt rule must remain after parent off');
  assert.equal(seen.get(PA).digestSeen, true, 'R2: expected harness digest blocks in provider payloads');
  summary.phases.push('reuse-same-child-follows-latest-off');

  // ---- Phase 6: digest freshness across content change + on->off ----
  // Remove global memory/refinements from synthetic state (keep the global
  // prompt), append a fresh local sentinel, then turn ON so a new true-mode
  // digest reflecting the NEW state is definitely written. Switch OFF with
  // no further state change: the false-mode digest must be freshly emitted
  // (same-content fingerprint must account for the mode), retaining local
  // memory + prompt with no global data. Old on-state digests in history
  // pass through untouched while on, so F1 only asserts the NEW digest.
  const globalHarnessFile = join(agentHome, 'harness', 'harness_state.json');
  const freshGlobal = {
    schema: 1,
    entries: {
      prompt: globalState.entries.prompt,
      memory: {},
      skill: {},
      subagent: {},
    },
    refinements: [],
  };
  await writeFile(globalHarnessFile, JSON.stringify(freshGlobal, null, 2));
  await rm(join(agentHome, 'harness', 'refinements.jsonl'), { force: true });
  const localHarnessFile = join(
    agentHome,
    'session-artifacts',
    shared.sessionA,
    'harness',
    'harness_state.json',
  );
  const localState = JSON.parse(await readFile(localHarnessFile, 'utf8'));
  localState.entries.memory.shmLocalMem.content += ' ' + LM2 + ' fresh local sentinel appended while on.';
  await writeFile(localHarnessFile, JSON.stringify(localState, null, 2));

  beginTurn();
  scripts.set(PA, [
    () => searchTool(LM2),
    (body) => {
      const result = lastTool(body);
      assert.ok(JSON.stringify(result).includes(LM2), 'F1: fresh local sentinel must be searchable while on');
      calls.push('F1:local-hit');
      return searchTool(GM);
    },
    (body) => {
      const result = lastTool(body);
      assert.equal(
        globalItemsOf(result, ['memory', 'refinement']).length,
        0,
        'F1: removed globals stay gone while on',
      );
      calls.push('F1:globals-gone');
      return null;
    },
  ]);
  watch(PA, { digestGM: true, digestGR: true });
  const freshOn = await runtime.start({
    cwd,
    message: 'Recheck sentinels after the synthetic state refresh.',
    model: PROVIDER + '/' + PA,
    sessionId: shared.sessionA,
    sharedMemories: true,
    onEvent: (event) => events.push(event),
  });
  await waitForMarkers(['F1:local-hit', 'F1:globals-gone'], 120000, 'phase6-on');
  assert.equal((await withTimeout(freshOn.done, 120000, 'freshness on')).status, 'completed');
  assert.equal(seen.get(PA).digestSeen, true, 'F1: expected harness digest blocks in provider payloads');
  assert.equal(seen.get(PA).lm2Seen, true, 'F1: a new digest reflecting the refreshed state must be written');
  assert.equal(
    seen.get(PA).lm2Clean,
    true,
    'F1: the new digest carries fresh local data with no global data',
  );
  summary.phases.push('freshness-content-change-while-on');

  beginTurn();
  scripts.set(PA, [
    () => searchTool(LM2),
    (body) => {
      const result = lastTool(body);
      assert.ok(
        JSON.stringify(result).includes(LM2),
        'F2: fresh local sentinel must stay searchable while off',
      );
      calls.push('F2:local-hit');
      return null;
    },
  ]);
  watch(PA, { digestGM: false, digestGR: false });
  const freshOff = await runtime.start({
    cwd,
    message: 'Recheck sentinels after sharing was switched off with no state change.',
    model: PROVIDER + '/' + PA,
    sessionId: shared.sessionA,
    sharedMemories: false,
    onEvent: (event) => events.push(event),
  });
  await waitForMarkers(['F2:local-hit'], 120000, 'phase6-off');
  assert.equal((await withTimeout(freshOff.done, 120000, 'freshness off')).status, 'completed');
  assert.equal(
    seen.get(PA).digestSeen,
    true,
    'F2: a fresh false-mode digest must be emitted, not a stale reuse',
  );
  assert.equal(seen.get(PA).lm2Seen, true, 'F2: false-mode digest must retain the fresh local memory');
  assert.equal(
    seen.get(PA).lm2Clean,
    true,
    'F2: false-mode digest must retain local data with no global data',
  );
  assert.equal(seen.get(PA).gpDigest, true, 'F2: false-mode digest must retain the prompt rule');
  assert.equal(seen.get(PA).gmDigest, false, 'F2: stale on-state digests must be filtered when off');
  assert.equal(seen.get(PA).grDigest, false, 'F2: stale refinement digests must be filtered when off');
  summary.phases.push('freshness-off-without-state-change');

  assert.equal(
    await readFile(join(agentHome, 'settings.json'), 'utf8'),
    settings,
    'Native settings must remain unchanged',
  );

  const payload = {
    passed: true,
    nonce: NONCE,
    phases: summary.phases,
    skipped: summary.skipped,
    staleId: shared.staleId,
    sessionA: shared.sessionA,
    reuseChildPreSend: shared.reuseChildPreSend || null,
    reuseMode: shared.reuseMode || null,
    markerCalls: calls.filter((item) => typeof item === 'string'),
    requestModels: requests.map((item) => item.model),
  };
  await writeFile(join(root, 'shared-memories-native-proof.json'), JSON.stringify(payload, null, 2));
  console.log(
    JSON.stringify(
      {
        passed: true,
        proof: join(root, 'shared-memories-native-proof.json'),
        phases: summary.phases,
        skipped: summary.skipped,
        checks: [
          'Fresh default-off hides globals; explicit true shows them',
          'Simultaneous independent roots with distinct fake models',
          'Native children inherit both values',
          'Same-session true->false and false->true toggles apply (not sticky)',
          'Knowledge search/read returns globals only when on; prompt rule always',
          'Same-project local evidence stays available in both modes',
          'Old tool results kept; old digests suppressed when off; stale id blocked',
          'Local memory seeded after session id known is retained on resume',
          'Restart coverage; compaction skipped (no deterministic fixture trigger)',
          'Existing child reuse follows the latest off choice (no stale true)',
          'Digest freshness: content change emits a new true digest; off without state change emits a fresh false digest',
          'Native settings unchanged',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    join(root, 'diagnostic.json'),
    JSON.stringify(
      {
        error: error.message,
        calls,
        requestModels: requests.map((item) => item.model),
        events: events.slice(-8),
      },
      null,
      2,
    ),
  );
  console.error(error);
  console.error('Diagnostic: ' + root);
  process.exitCode = 1;
} finally {
  await runtime?.close();
  await new Promise((resolve) => provider.close(resolve));
}
