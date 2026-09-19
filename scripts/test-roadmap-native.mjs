// Real Prime Agent parent/child extensions, shared service and lifecycle. The
// deterministic provider listens only on loopback; no account or paid model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime } from '../lib/agent.mjs';
import { createStore } from '../lib/store.mjs';
import { createRoadmapService } from '../lib/roadmap.mjs';
import { createRoadmapBridge, createRoadmapCallerResolver } from '../lib/roadmap-bridge.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-roadmap-native-'));
const cwd = join(root, 'Projet é'),
  agentHome = join(root, 'agent'),
  sessionDir = join(agentHome, 'sessions'),
  dataDir = join(root, 'studio');
await Promise.all([cwd, sessionDir].map((path) => mkdir(path, { recursive: true })));
const store = createStore({ sessionDir, dataDir });
await store.project({ cwd });
const service = createRoadmapService({ resolveProject: (cwd) => store.findProject(cwd) });
await service.mutate(cwd, { action: 'init', expectedRevision: 0 }, { by: 'user' });
const run = { id: 'native-fixture-run', sessionId: null, cwd, status: 'running' };
const bridge = createRoadmapBridge({
  service,
  resolveCaller: createRoadmapCallerResolver({ getRuns: () => [run], store, agentHome, sessionDir }),
  isOwnerActive: (id) => run.id === id && run.status === 'running',
});
await bridge.ready;
const calls = [],
  requests = [],
  events = [],
  snapshots = [],
  stage = new Map();
const toolNames = [
  'roadmap_read',
  'roadmap_plan',
  'roadmap_check',
  'roadmap_backlog',
  'roadmap_milestone',
  'roadmap_work',
];
let runtime, planId, stepIds;
const provider = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw),
      role = body.model;
    requests.push(body);
    const names = body.tools.map((tool) => tool.function.name);
    for (const name of toolNames) assert.ok(names.includes(name), `${role}: ${name} not discovered`);
    assert.ok(!JSON.stringify(body).includes(bridge.config.token), 'Private capability leaked to model');
    const step = stage.get(role) || 0;
    const latestTool = body.messages.findLast((entry) => entry.role === 'tool');
    let result;
    if (latestTool && !String(latestTool.content).includes('CHILD_ADMITTED')) {
      try {
        result = JSON.parse(latestTool.content);
      } catch {
        if (step < 8 || role === 'child')
          throw new Error(`${role} stage ${step} tool failed: ${String(latestTool.content).slice(0, 1200)}`);
      }
    }
    let tool;
    if (role === 'parent') {
      if (step === 0) tool = { name: 'roadmap_read', arguments: { target: 'overview' } };
      else if (step === 1) {
        assert.equal(result.revision, 1);
        tool = {
          name: 'roadmap_milestone',
          arguments: { action: 'create', expectedRevision: result.revision, title: 'Native proof' },
        };
      } else if (step === 2) {
        assert.equal(result.milestones.length, 1);
        tool = {
          name: 'roadmap_plan',
          arguments: {
            action: 'create',
            expectedRevision: result.revision,
            title: 'Shared verification',
            milestone: result.milestones[0].id,
            steps: [{ text: 'Parent verification' }, { text: 'Child verification' }],
          },
        };
      } else if (step === 3) {
        planId = result.plans[0].id;
        tool = { name: 'roadmap_read', arguments: { target: 'plan', planId } };
      } else if (step === 4) {
        stepIds = result.plan.steps.map((step) => step.id);
        tool = {
          name: 'roadmap_check',
          arguments: {
            expectedRevision: result.revision,
            planId,
            stepId: stepIds[0],
            done: true,
            comment: 'Native parent checked its result.',
          },
        };
      } else if (step === 5)
        tool = {
          name: 'roadmap_backlog',
          arguments: {
            action: 'add',
            expectedRevision: result.revision,
            items: [{ text: 'Follow-up captured by native parent' }],
          },
        };
      else if (step === 6)
        tool = { name: 'roadmap_work', arguments: { targets: [{ kind: 'plan', planId }] } };
      else if (step === 7) {
        const active = bridge.snapshot(cwd);
        assert.equal(active.activity.length, 1);
        assert.equal(active.activity[0].sessionId, run.sessionId);
        snapshots.push({ phase: 'parent-tool-loop', ...active });
        tool = {
          name: 'ipython',
          arguments: {
            code: 'import rlm\nchild = await rlm.spawn("Verify the second Roadmap checklist step", model="fixture/child", name="roadmap-tester")\nprint("CHILD_ADMITTED")',
          },
        };
      } else if (step === 8) {
        const deadline = Date.now() + 30000;
        while (
          Date.now() < deadline &&
          (!calls.includes('child:finished') ||
            bridge.snapshot(cwd).activity.some((item) => item.sessionId !== run.sessionId))
        )
          await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(calls.includes('child:finished'), 'Child did not finish its native checks');
        assert.deepEqual(
          bridge.snapshot(cwd).activity.map((item) => item.sessionId),
          [run.sessionId],
          'Child agent_end must clear only the child, while parent remains active',
        );
        calls.push('parent:finished');
      } else {
        assert.equal(
          bridge.snapshot(cwd).activity.length,
          0,
          'A native follow-up must not inherit work from the finished agent loop',
        );
        calls.push('parent:followup-without-stale-work');
      }
    } else {
      if (step === 0) tool = { name: 'roadmap_read', arguments: { target: 'plan', planId } };
      else if (step === 1) {
        assert.equal(result.plan.steps[0].done, true);
        assert.equal(result.plan.steps[1].done, false);
        tool = {
          name: 'roadmap_work',
          arguments: { targets: [{ kind: 'plan', planId, stepId: stepIds[1] }] },
        };
      } else if (step === 2) {
        assert.notEqual(result.sessionId, run.sessionId);
        assert.equal(result.rootSessionId, run.sessionId);
        const active = bridge.snapshot(cwd);
        const child = active.activity.find((item) => item.sessionId === result.sessionId);
        assert.equal(active.activity.length, 2);
        assert.equal(child.name, 'roadmap-tester');
        assert.ok(child.agentId, 'Child must carry the inspector navigation ID');
        snapshots.push({ phase: 'exact-child', ...active });
        const dto = await service.read(cwd);
        tool = {
          name: 'roadmap_check',
          arguments: {
            expectedRevision: dto.revision,
            planId,
            stepId: stepIds[1],
            done: true,
            comment: 'Native child verified its own checklist step.',
          },
        };
      } else if (step === 3) tool = { name: 'roadmap_read', arguments: { target: 'plan', planId } };
      else {
        assert.deepEqual(result.plan.progress, { done: 2, total: 2, percent: 100 });
        assert.notEqual(result.plan.journal.at(-1).sessionId, run.sessionId);
        assert.equal(result.plan.journal.at(-1).rootSessionId, run.sessionId);
        calls.push('child:finished');
      }
    }
    stage.set(role, step + 1);
    if (tool) calls.push(`${role}:${tool.name}`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: `message-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: role, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
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
      frame({ content: 'Roadmap native integration verified.' });
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
    roadmap: { config: bridge.config },
    env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' },
  });
  const handle = await runtime.start({
    cwd,
    message: 'Create a Roadmap plan and verify its checklist with one native child.',
    model: 'fixture/parent',
    allowQuestions: process.env.PRIME_STUDIO_TEST_QUESTIONS === '1',
    onEvent: (event) => {
      events.push(event);
      if (event.kind === 'session') run.sessionId = event.sessionId;
    },
  });
  let timer;
  const done = await Promise.race([
    handle.done,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native Roadmap test timed out')), 120000);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.deepEqual(
    calls.filter((entry) => entry?.error),
    [],
    JSON.stringify(calls),
  );
  assert.equal(done.status, 'completed');
  assert.ok(calls.includes('child:finished'));
  assert.ok(calls.includes('parent:finished'));
  assert.equal(
    bridge.snapshot(cwd).activity.length,
    0,
    'Parent agent_end must clear activity before owner completion',
  );
  run.status = 'completed';
  bridge.revokeOwner(run.id);
  const final = await service.read(cwd);
  assert.equal(final.revision, 6);
  assert.deepEqual(final.progress, { done: 2, total: 2, percent: 100 });
  assert.equal(final.backlog.items.length, 1);
  assert.equal(await readFile(join(agentHome, 'settings.json'), 'utf8'), settings);
  await writeFile(
    join(root, 'proof.json'),
    JSON.stringify({ passed: true, calls, snapshots, final }, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        root,
        calls,
        checks: [
          'Six real native tools discovered by parent and child',
          'Shared atomic writer and revision visibility',
          'Exact native child identity and inspector reference',
          'Activity survives tool rounds, clears per agent_end',
          'Child progress, journal attribution and backlog persisted',
          'Native settings unchanged; loopback provider only',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    join(root, 'diagnostic.json'),
    JSON.stringify({ requests, calls, events, snapshots }, null, 2),
  );
  console.error(error);
  console.error(`Diagnostic: ${root}`);
  process.exitCode = 1;
} finally {
  await runtime?.close();
  await bridge.close();
  await service.close();
  await new Promise((resolve) => {
    provider.closeAllConnections?.();
    provider.close(resolve);
  });
}
