import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventProjection, normalizeEvent } from '../lib/agent.mjs';
import { agentStatus, createSessionInspector } from '../lib/session-inspector.mjs';
import { applyRuntimeStatus, noteActivity } from '../public/runtime-status.js';
import { messages } from '../public/translations.js';

const tr = (key) => key;

test('agent_end maps to a nonterminal activity event, never done', () => {
  const events = normalizeEvent({ type: 'agent_end' });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'status');
  assert.equal(events[0].status, 'turn_end');
  assert.ok(events.every((event) => event.kind !== 'done'));
  assert.ok(!JSON.stringify(events).includes('Terminé'));
  assert.ok(!JSON.stringify(events).includes('termine'));
  const doneKinds = events.filter((event) => event.status === 'completed' || event.status === 'failed');
  assert.deepEqual(doneKinds, []);
});

test('agent_start, input, tool, compaction and retry resume activity', () => {
  assert.deepEqual(normalizeEvent({ type: 'agent_start' }), [{ kind: 'status', status: 'running' }]);
  assert.deepEqual(normalizeEvent({ type: 'agent_input' }), [{ kind: 'status', status: 'running' }]);
  assert.equal(
    normalizeEvent({ type: 'tool_execution_start', toolCallId: 't', toolName: 'bash' })[0].kind,
    'tool_start',
  );
  assert.equal(normalizeEvent({ type: 'compaction_start' })[0].status, 'compacting');
  assert.equal(normalizeEvent({ type: 'auto_retry_start', errorMessage: 'busy' })[0].status, 'retrying');
  assert.equal(normalizeEvent({ type: 'compaction_end' })[0].status, 'running');
  assert.equal(normalizeEvent({ type: 'auto_retry_end', success: true })[0].status, 'running');
  // Unknown turn_end wire events between tool rounds stay ignored, only agent_end is a boundary.
  assert.deepEqual(normalizeEvent({ type: 'turn_end' }), []);
  assert.deepEqual(normalizeEvent({ type: 'agent_end', extra: 1 })[0].status, 'turn_end');
});

test('turn end while a subagent works reads children, then follows the subagents', () => {
  const project = createEventProjection();
  const child = (id, status, extra = {}) => ({ type: 'rlm_child_update', child: { id, status, ...extra } });
  const turnEnd = [{ kind: 'status', status: 'turn_end' }];
  const children = [{ kind: 'status', status: 'children' }];
  assert.deepEqual(project({ type: 'agent_start' }), [{ kind: 'status', status: 'running' }]);
  // Updates while the root works never replace its working label.
  assert.deepEqual(project(child('c1', 'queued')), []);
  assert.deepEqual(project(child('c1', 'running')), []);
  assert.deepEqual(project({ type: 'agent_end' }), children);
  // Progress and a nested descendant keep the same wait without noise.
  assert.deepEqual(project(child('c1', 'running', { progressNote: 'Phase 1 committed' })), []);
  assert.deepEqual(project(child('g1', 'running', { parentId: 'c1' })), []);
  assert.deepEqual(project(child('c1', 'done')), [{ kind: 'subagent_idle', agentId: 'c1' }]);
  assert.deepEqual(project(child('g1', 'cancelled', { parentId: 'c1' })), [
    ...turnEnd,
    { kind: 'subagent_idle', agentId: 'g1' },
  ]);
  // A retained subagent working on a follow-up counts again until it settles.
  assert.deepEqual(project(child('c1', 'done', { activity: { kind: 'executing' } })), children);
  assert.deepEqual(project(child('c1', 'error')), [...turnEnd, { kind: 'subagent_idle', agentId: 'c1' }]);
  // The next root turn resumes and stays quiet until its own boundary.
  assert.deepEqual(project({ type: 'agent_start' }), [{ kind: 'status', status: 'running' }]);
  assert.deepEqual(project(child('c2', 'running')), []);
  assert.deepEqual(project({ type: 'agent_end' }), children);
  assert.deepEqual(project(child('c2', 'done')), [...turnEnd, { kind: 'subagent_idle', agentId: 'c2' }]);
  assert.deepEqual(project({ type: 'agent_start' }), [{ kind: 'status', status: 'running' }]);
  assert.deepEqual(project({ type: 'agent_end' }), turnEnd);
  // Malformed updates change nothing, other events keep the stateless mapping.
  for (const update of [
    {},
    { child: [] },
    { child: { status: 'running' } },
    { child: { id: '', status: 'running' } },
  ])
    assert.deepEqual(project({ type: 'rlm_child_update', ...update }), []);
  assert.deepEqual(project({ type: 'agent_end' }), turnEnd);
  assert.deepEqual(project({ type: 'turn_end' }), []);
  assert.deepEqual(project(null), []);
  assert.equal(project({ type: 'compaction_start' })[0].status, 'compacting');
  assert.ok(
    [project({ type: 'agent_end' }), project(child('c3', 'running'))].flat().every((e) => e.kind !== 'done'),
  );
});

test('runtime status shows turn end and background without finishing, then resumes', () => {
  const run = {};
  applyRuntimeStatus(run, { status: 'turn_end' }, tr);
  assert.equal(run.statusLabel, 'ui.fin_de_tour');
  assert.equal(run.activityStatus, 'turn_end');
  noteActivity(run, tr);
  assert.equal(run.activityStatus, undefined);
  assert.equal(run.statusLabel, undefined);
  applyRuntimeStatus(run, { status: 'children' }, tr);
  assert.equal(run.statusLabel, 'ui.attend_ses_sous_agents');
  assert.equal(run.activityStatus, 'children');
  noteActivity(run, tr);
  assert.equal(run.activityStatus, undefined);
  assert.equal(run.statusLabel, undefined);
  applyRuntimeStatus(run, { status: 'background' }, tr);
  assert.equal(run.statusLabel, 'ui.en_arriere_plan');
  noteActivity(run, tr);
  assert.equal(run.statusLabel, undefined);
  applyRuntimeStatus(run, { status: 'waiting' }, tr);
  assert.equal(run.statusLabel, 'ui.en_attente');
  applyRuntimeStatus(run, { status: 'running' }, tr);
  assert.equal(run.activityStatus, undefined);
  assert.equal(run.statusLabel, 'ui.l_agent_travaille');
  applyRuntimeStatus(run, { status: 'compacting' }, tr);
  assert.equal(run.statusLabel, 'ui.optimisation_du_contexte');
});

test('reconnection restores the nonterminal activity label instead of leaving reconnecting', () => {
  for (const [status, label] of [
    ['turn_end', 'ui.fin_de_tour'],
    ['children', 'ui.attend_ses_sous_agents'],
    ['background', 'ui.en_arriere_plan'],
    ['waiting', 'ui.en_attente'],
  ]) {
    const run = { status: 'running' };
    applyRuntimeStatus(run, { status }, tr);
    run.statusLabel = 'ui.reconnexion_a_l_agent';
    applyRuntimeStatus(run, { status: run.activityStatus || 'running' }, tr);
    assert.equal(run.statusLabel, label);
    assert.equal(run.activityStatus, status);
    assert.equal(run.status, 'running');
  }
});

test('a turn boundary preserves backup model state and restores its label on activity', () => {
  const run = { status: 'running', backupModel: 'fixture/backup' };
  applyRuntimeStatus(run, { status: 'turn_end' }, tr);
  assert.equal(run.backupModel, 'fixture/backup');
  noteActivity(run, tr);
  assert.equal(run.statusLabel, 'providerRetry.backup');
  assert.equal(run.backupModel, 'fixture/backup');
  assert.equal(run.activityStatus, undefined);
});

test('snapshot flags alone mean honest background, never deduced service', () => {
  assert.equal(agentStatus({ isSessionActive: true }), 'background');
  assert.notEqual(agentStatus({ isSessionActive: true }), 'working');
  assert.equal(agentStatus({}), 'idle');
  assert.equal(agentStatus({ isStreaming: true, isSessionActive: true }), 'working');
  assert.equal(agentStatus({ isRunningTools: true, isSessionActive: true }), 'tool');
  assert.equal(agentStatus({ isBashRunning: true }), 'tool');
  assert.equal(agentStatus({ hasRunningRlmChildren: true, isSessionActive: true }), 'children');
  assert.equal(agentStatus({ isCompacting: true, isSessionActive: true }), 'compacting');
  // A long tool or subagent wait keeps its own label, it is not flattened to background.
  assert.equal(agentStatus({ isBashRunning: true, isSessionActive: true }), 'tool');
  assert.equal(agentStatus({ hasRunningRlmChildren: true }), 'children');
});

async function inspectWith(liveState, runStatus = 'running') {
  const root = { id: 'root-activity', cwd: '/fixture', file: '/fixture/session.jsonl', messages: [] };
  const inspector = createSessionInspector({
    store: { findProject: async () => ({ cwd: root.cwd }), history: async () => root },
    agentHome: '/fixture/agent',
    sessionDir: '/fixture/sessions',
    readEdges: async () => [],
    getRun: () => ({ status: runStatus }),
    getClient: () => ({
      getInspector: async () => ({ state: liveState, children: [] }),
      close() {},
    }),
  });
  return inspector.inspect(root.cwd, root.id);
}

test('root idle with a maintained run waits, root background differs from working', async () => {
  const waiting = await inspectWith({});
  assert.equal(waiting.session.status, 'waiting');
  assert.notEqual(waiting.session.status, 'working');
  assert.notEqual(waiting.session.status, 'completed');
  const background = await inspectWith({ isSessionActive: true });
  assert.equal(background.session.status, 'background');
  assert.notEqual(background.session.status, 'working');
  const idle = await inspectWith({}, 'completed');
  assert.equal(idle.session.status, 'idle');
});

test('live tool and child overlays keep working without regression', async () => {
  const tool = await inspectWith({ isBashRunning: true, isSessionActive: true });
  assert.equal(tool.session.status, 'tool');
  const children = await inspectWith({ hasRunningRlmChildren: true });
  assert.equal(children.session.status, 'children');
  const working = await inspectWith({ isStreaming: true });
  assert.equal(working.session.status, 'working');
});

test('new activity labels exist in French and English without em dashes', () => {
  for (const key of ['ui.en_arriere_plan', 'ui.fin_de_tour', 'ui.attend_ses_sous_agents']) {
    assert.ok(messages[key], key);
    assert.ok(messages[key].fr?.trim(), `${key} fr`);
    assert.ok(messages[key].en?.trim(), `${key} en`);
    assert.equal(messages[key].fr.includes('\u2014'), false);
    assert.equal(messages[key].en.includes('\u2014'), false);
  }
});
