import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionGoal } from '../public/session-goal.js';

const ids = [
  'session-goal-button',
  'session-goal-dialog',
  'session-goal-form',
  'session-goal-objective',
  'session-goal-input',
  'session-goal-edit',
  'session-goal-stop',
  'session-goal-clear',
  'session-goal-resume',
  'session-goal-resume-hint',
  'session-goal-save',
  'session-goal-reload',
  'session-goal-error',
  'session-goal-button-status',
  'session-goal-status',
  'session-goal-usage',
  'session-goal-editor',
];

class Element {
  constructor() {
    this.handlers = new Map();
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.textContent = '';
  }
  addEventListener(name, handler) {
    this.handlers.set(name, handler);
  }
  fire(name) {
    this.handlers.get(name)?.({ preventDefault() {}, target: { closest: () => null } });
  }
  click() {
    if (!this.disabled) this.fire('click');
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.fire('close');
  }
  setAttribute() {}
  focus() {}
}

const goal = (overrides = {}) => ({
  goalId: 'g1',
  objective: 'Keep the original objective',
  status: 'paused',
  active: false,
  tokensUsed: 20,
  tokenBudget: 100,
  timeUsedSeconds: 30,
  continuationsUsed: 2,
  ...overrides,
});
const response = (value, extra = {}) => ({ goal: value, editable: true, controllable: true, ...extra });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ readOnly = false } = {}) {
  const elements = new Map(ids.map((id) => [id, new Element()]));
  globalThis.document = {
    getElementById: (id) => elements.get(id),
    documentElement: { classList: { toggle() {} } },
  };
  const requests = [];
  const api = (url, options = {}) =>
    new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
    });
  const labels = {
    'goal.stop': 'Stop goal',
    'goal.stopAgent': 'Stop agent',
    'goal.resume': 'Resume goal',
    'goal.retry': 'Retry goal',
    'goal.status.active': 'active',
    'goal.status.paused': 'paused',
    'goal.resumeBlockedRunning':
      'The current run is still active. Wait for it to finish before resuming this goal.',
    'goal.resumeBlockedStopping': 'Waiting for the current run to finish…',
    'goal.resumeBlockedBusy': 'The session is changing. Please wait.',
  };
  const ui = createSessionGoal({ api, t: (key) => labels[key] || key });
  ui.setSelection({ id: 's1', cwd: '/fixture', readOnly });
  return {
    requests,
    ui,
    el: (id) => elements.get(`session-goal-${id}`),
    async load(data) {
      requests.at(-1).resolve(data);
      await settle();
    },
    open() {
      elements.get('session-goal-button').click();
    },
  };
}

test('paused goal waits for its active run before offering Resume', async () => {
  const f = fixture();
  const initial = goal();
  await f.load(response(initial, { resumable: true }));
  f.open();
  assert.equal(f.requests.length, 2, 'opening requests fresh goal state');
  assert.equal(f.el('objective').textContent, initial.objective, 'known objective stays visible');
  assert.equal(f.el('resume').disabled, true, 'cached capability cannot act during refresh');
  f.el('resume').fire('click');
  assert.equal(f.requests.length, 2, 'guard rejects stale cached capability');
  await f.load(response(initial, { resumeBlocked: 'running' }));
  assert.equal(f.el('resume').hidden, false);
  assert.equal(f.el('resume').disabled, true);
  assert.match(f.el('resume-hint').textContent, /Wait for it to finish/);
  assert.equal(f.el('stop').hidden, true, 'paused goals cannot be paused a second time');
  f.el('stop').fire('click');
  assert.equal(f.requests.length, 2, 'the UI cannot send Pause for a paused goal');

  const refresh = f.ui.refresh({ force: true });
  await settle();
  assert.equal(f.requests.length, 3, 'run completion refreshes the current goal');
  f.requests[2].resolve(response(initial, { resumable: true }));
  await refresh;
  assert.equal(f.el('resume').disabled, false);
  assert.match(f.el('usage').textContent, /20 \/ 100/);
  assert.match(f.el('usage').textContent, /2$/);
  f.el('resume').click();
  assert.equal(f.requests[3].url, '/api/sessions/s1/goal/resume');
  assert.deepEqual(f.requests[3].options.body, {
    cwd: '/fixture',
    goalId: 'g1',
    expectedObjective: initial.objective,
  });
});

test('stopping and busy blockers explain disabled Resume without a Stop action', async () => {
  for (const blocked of ['stopping', 'busy']) {
    const f = fixture();
    await f.load(response(goal(), { resumeBlocked: blocked }));
    f.open();
    await f.load(response(goal(), { resumeBlocked: blocked }));
    assert.equal(f.el('resume').hidden, false);
    assert.equal(f.el('resume').disabled, true);
    assert.equal(f.el('stop').hidden, true);
    assert.match(f.el('resume-hint').textContent, blocked === 'busy' ? /changing/ : /Waiting/);
    f.el('resume').fire('click');
    assert.equal(f.requests.length, 2);
  }
});

test('failed fresh read offers Reload and restores actions only after a successful read', async () => {
  const f = fixture();
  const data = response(goal(), { resumable: true });
  await f.load(data);
  f.open();
  f.requests.at(-1).reject(new Error('Connection lost'));
  await settle();
  assert.equal(f.el('resume').disabled, true);
  assert.equal(f.el('reload').hidden, false);
  assert.equal(f.el('error').textContent, 'Connection lost');
  f.el('reload').click();
  await f.load(data);
  assert.equal(f.el('resume').disabled, false);
  assert.equal(f.el('reload').hidden, true);
  assert.equal(f.el('error').hidden, true);
});

test('reopening during Stop cannot accept an older GET result or resume while stopping', async () => {
  const f = fixture();
  const active = goal({ status: 'active', active: true });
  const blocked = response(active, { resumeBlocked: 'running' });
  await f.load(blocked);
  f.open();
  await f.load(blocked);
  f.el('stop').click();
  const stopRequest = f.requests.at(-1);
  f.el('dialog').close();
  f.open();
  const staleRead = f.requests.at(-1);
  const paused = goal();
  stopRequest.resolve(response(paused, { resumeBlocked: 'stopping' }));
  await settle();
  staleRead.resolve(blocked);
  await settle();
  assert.equal(f.el('dialog').open, true);
  assert.equal(f.el('stop').hidden, true);
  assert.equal(f.el('resume').disabled, true);
  assert.match(f.el('resume-hint').textContent, /Waiting for the current run/);
  assert.equal(f.el('status').textContent, 'paused');

  const refresh = f.ui.refresh({ force: true });
  await settle();
  f.requests.at(-1).resolve(response(paused, { resumable: true }));
  await refresh;
  assert.equal(f.el('resume').disabled, false);
});

test('reopening during an edit uses its confirmed result and restores actions', async () => {
  const f = fixture();
  const initial = response(goal(), { resumable: true });
  await f.load(initial);
  f.open();
  await f.load(initial);
  f.el('edit').click();
  f.el('input').value = 'Updated objective';
  f.el('form').fire('submit');
  const editRequest = f.requests.at(-1);
  assert.equal(editRequest.options.method, 'PATCH');
  f.el('dialog').close();
  f.open();
  const staleRead = f.requests.at(-1);
  editRequest.resolve(response(goal({ objective: 'Updated objective' }), { resumable: true }));
  await settle();
  staleRead.resolve(initial);
  await settle();
  assert.equal(f.el('objective').textContent, 'Updated objective');
  assert.equal(f.el('edit').disabled, false);
  assert.equal(f.el('resume').disabled, false);
});

test('read-only and exhausted goals cannot resume; read-only cannot stop', async () => {
  for (const [readOnly, value] of [
    [true, goal()],
    [false, goal({ tokensUsed: 100 })],
  ]) {
    const f = fixture({ readOnly });
    await f.load(response(value, { resumeBlocked: 'running' }));
    f.open();
    await f.load(response(value, { resumeBlocked: 'running' }));
    assert.equal(f.el('resume').hidden, true);
    f.el('resume').fire('click');
    assert.equal(f.requests.length, 2);
    if (readOnly) {
      assert.equal(f.el('stop').hidden, true);
      f.el('stop').fire('click');
      assert.equal(f.requests.length, 2);
    }
  }
});
