import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  stopKindOf,
  shouldShowStopNotice,
  noticeKeyFor,
  findLatestResumableId,
  resolveContinueTarget,
  buildStopNotice,
  isNetworkErrorText,
  errorTextOf,
} from '../public/response-status.js';

// Minimal injected-deps double: records structure without a browser.
function stubDeps(calls = []) {
  const el = (tag, className, text) => {
    const node = {
      tag,
      className,
      text: typeof text === 'function' ? text() : text,
      children: [],
      dataset: {},
      type: null,
      onclick: null,
      append(...items) {
        node.children.push(...items);
        return node;
      },
      setAttribute(name, value) {
        node[name] = String(value);
      },
    };
    calls.push(node);
    return node;
  };
  const icon = (name) => ({ icon: name });
  const tr = (key) => key;
  return { el, icon, tr, calls };
}

test('length variants classify, case-insensitive; success/tool-use/streaming stay silent', () => {
  for (const stopReason of ['length', 'truncated', 'TRUNCATED', ' Length ', 'output_limit', 'max_tokens']) {
    assert.equal(stopKindOf({ role: 'assistant', stopReason }), 'length', stopReason);
    assert.equal(shouldShowStopNotice({ role: 'assistant', stopReason }), true);
  }
  // Thinking-only length (reasoning hidden/collapsed in the UI) is still a stop.
  assert.equal(stopKindOf({ role: 'assistant', stopReason: 'length', thinking: 'deep thought' }), 'length');
  assert.equal(noticeKeyFor('length'), 'ui.stop_reponse_tronquee');
  // No notice on success, tool use in progress, or live streaming.
  assert.equal(stopKindOf({ role: 'assistant', stopReason: 'stop', text: 'done' }), null);
  assert.equal(stopKindOf({ role: 'assistant', text: 'done' }), null);
  assert.equal(
    stopKindOf({ role: 'assistant', stopReason: 'stop', tools: [{ name: 'read', status: 'done' }] }),
    null,
  );
  assert.equal(stopKindOf({ role: 'assistant', stopReason: 'length', streaming: true }), null);
  assert.equal(stopKindOf({ role: 'assistant', streaming: true, text: 'partial' }), null);
  assert.equal(stopKindOf({ role: 'assistant', stopReason: 'tool_use' }), null);
  assert.equal(stopKindOf({ role: 'assistant', stopReason: 'mystery-future-kind' }), null);
  assert.equal(stopKindOf(null), null);
});

test('aborted spellings share the existing interrupted key; normal toolUse is silent', () => {
  for (const stopReason of ['aborted', 'cancelled', 'canceled', 'interrupted', 'ABORTED']) {
    assert.equal(stopKindOf({ role: 'assistant', stopReason }), 'aborted', stopReason);
  }
  assert.equal(noticeKeyFor('aborted'), 'ui.reponse_interrompue');
  assert.equal(
    stopKindOf({ role: 'assistant', stopReason: 'stop', text: 'with tools', tools: [{ name: 'x' }] }),
    null,
  );
});

test('errors classify network honestly and preserve detail', () => {
  for (const error of [
    'fetch failed',
    'NetworkError: network request failed',
    'read ECONNRESET',
    'socket hang up',
    'request timed out after 30s',
    'ENOTFOUND registry.example',
  ]) {
    assert.equal(stopKindOf({ role: 'assistant', stopReason: 'error', error }), 'error-network', error);
    assert.equal(isNetworkErrorText(error), true);
  }
  const generic = "Bad request: unknown model 'nope-1' (400)";
  assert.equal(stopKindOf({ role: 'assistant', stopReason: 'error', error: generic }), 'error');
  assert.equal(isNetworkErrorText(generic), false);
  // HTTP statuses / reason phrases are provider errors, not transport proof.
  for (const error of [
    'Service Unavailable (503)',
    'HTTP 503: overloaded',
    'Bad Gateway (502)',
    'HTTP 504 from provider',
    'Gateway Timeout',
    'HTTP Gateway Timeout (504)',
  ]) {
    assert.equal(stopKindOf({ role: 'assistant', stopReason: 'error', error }), 'error', error);
    assert.equal(isNetworkErrorText(error), false);
  }
  assert.equal(noticeKeyFor('error'), 'ui.stop_erreur_fournisseur');
  assert.equal(noticeKeyFor('error-network'), 'ui.stop_erreur_reseau');
  // Detail preserved verbatim, never replaced by the classification.
  assert.equal(errorTextOf({ error: generic }), generic);
  assert.equal(errorTextOf({}), '');
  // Truthy non-string error flags stay generic errors, never network.
  assert.equal(stopKindOf({ role: 'assistant', stopReason: 'stop', error: true }), 'error');
  // A bare error stop without detail is generic, not network.
  assert.equal(stopKindOf({ role: 'assistant', stopReason: 'error' }), 'error');
});

test('old failures keep notice but only the trailing failure is resumable', () => {
  const failed = (id, extra = {}) => ({ id, role: 'assistant', stopReason: 'length', ...extra });
  const ok = (id) => ({ id, role: 'assistant', stopReason: 'stop', text: 'done' });
  // Latest failure wins; older ones are not returned.
  assert.equal(findLatestResumableId([failed('a1'), failed('a2')]), 'a2');
  // A newer user message (new turn pending) rejects the older stop.
  assert.equal(findLatestResumableId([failed('a1'), { id: 'u2', role: 'user', text: 'go on' }]), null);
  // A later successful assistant (answer, tool result, empty completion) supersedes it.
  assert.equal(findLatestResumableId([failed('a1'), ok('a2')]), null);
  assert.equal(
    findLatestResumableId([failed('a1'), { id: 'a2', role: 'assistant', tools: [{ name: 't' }] }]),
    null,
  );
  // Later live streaming means the turn is alive, not resumable.
  assert.equal(findLatestResumableId([failed('a1'), { id: 'a2', role: 'assistant', streaming: true }]), null);
  // A newer failure after a success is resumable again.
  assert.equal(findLatestResumableId([ok('a0'), failed('a1')]), 'a1');
  // System/technical notices after the failure do not block it.
  assert.equal(
    findLatestResumableId([failed('a1'), { id: 's', role: 'system', customType: 'git_state' }]),
    'a1',
  );
});

test('continue target gating: read-only, running, stale, disappeared, missing callback', () => {
  const failed = { id: 'a9', role: 'assistant', stopReason: 'aborted' };
  const list = [{ id: 'u1', role: 'user', text: 'q' }, failed];
  const gate = { onContinue: () => {} };
  assert.deepEqual(resolveContinueTarget(list, gate), { messageId: 'a9', kind: 'aborted' });
  // Read-only / active run / loading / wrong session: owner denies, notice stays, no target.
  assert.equal(resolveContinueTarget(list, { ...gate, hidden: true }), null);
  assert.equal(resolveContinueTarget(list, { ...gate, canContinue: () => false }), null);
  assert.equal(
    resolveContinueTarget(list, {
      ...gate,
      canContinue: () => {
        throw new Error('gate blew up');
      },
    }),
    null,
  );
  // Gate may inspect id + message; denial for a stale binding hides the CTA.
  assert.equal(
    resolveContinueTarget(list, { ...gate, canContinue: (id) => id === 'other-session-tail' }),
    null,
  );
  // No callback, no button anywhere (notices unaffected).
  assert.equal(resolveContinueTarget(list, {}), null);
  assert.equal(resolveContinueTarget(list, null), null);
  // Owner-scoped id must still be the trailing failure.
  assert.deepEqual(resolveContinueTarget(list, { ...gate, resumableId: 'a9' }), {
    messageId: 'a9',
    kind: 'aborted',
  });
  assert.equal(resolveContinueTarget(list, { ...gate, resumableId: 'stale-id' }), null);
  assert.equal(
    resolveContinueTarget([...list, { id: 'u2', role: 'user', text: 'new turn' }], {
      ...gate,
      resumableId: 'a9',
    }),
    null,
  );
  assert.equal(
    resolveContinueTarget([{ id: 'ghost', role: 'assistant', stopReason: 'length' }], {
      ...gate,
      resumableId: 'a9',
    }),
    null,
  );
});

test('stop notice node: visible line always, button only when eligible, click re-checks gate', () => {
  const deps = stubDeps();
  const message = { id: 'a9', role: 'assistant', stopReason: 'length' };
  assert.equal(buildStopNotice(deps, message, null, {}), null);
  assert.equal(buildStopNotice(null, message, 'length', {}), null);
  // Notice without Continue wiring: line only, no button, no throw.
  const bare = buildStopNotice(deps, message, 'length', {});
  assert.equal(bare.className, 'stop-notice');
  assert.equal(bare.dataset.stopKind, 'length');
  assert.ok(
    bare.children.some((child) => child.className === 'stop-notice-text'),
    'notice text stays visible outside collapsed reasoning',
  );
  assert.ok(!bare.children.some((child) => child.tag === 'button'), 'no button without onContinue');
  // Eligible: exactly one button carrying the message id.
  let sent = [];
  const wired = buildStopNotice(deps, message, 'length', {
    showContinue: true,
    onContinue: (id) => sent.push(id),
    canContinue: () => true,
  });
  const buttons = wired.children.filter((child) => child.tag === 'button');
  assert.equal(buttons.length, 1);
  assert.match(buttons[0].className, /stop-continue/);
  assert.equal(buttons[0]['data-continue-for'], 'a9');
  buttons[0].onclick();
  assert.deepEqual(sent, ['a9']);
  // Gate re-checked on click: denial swallows the click, nothing sent.
  sent = [];
  const denied = buildStopNotice(deps, message, 'aborted', {
    showContinue: true,
    onContinue: (id) => sent.push(id),
    canContinue: () => false,
  });
  denied.children.filter((child) => child.tag === 'button')[0].onclick();
  assert.deepEqual(sent, []);
  // showContinue false (old failure history): notice kept, no button.
  const old = buildStopNotice(deps, { ...message, id: 'a1' }, 'length', {
    showContinue: false,
    onContinue: (id) => sent.push(id),
  });
  assert.ok(!old.children.some((child) => child.tag === 'button'));
  assert.ok(old.children.some((child) => child.className === 'stop-notice-text'));
});

test('stop strings file ships FR/EN for root merge', async () => {
  const raw = await readFile(
    new URL('../.local/study/v448-usability/strings-stops.json', import.meta.url),
    'utf8',
  );
  const strings = JSON.parse(raw);
  for (const key of [
    'ui.stop_reponse_tronquee',
    'ui.stop_erreur_fournisseur',
    'ui.stop_erreur_reseau',
    'ui.continuer',
  ]) {
    assert.ok(strings.keys[key], key);
    assert.match(strings.keys[key].fr, /\S/, `${key} fr`);
    assert.match(strings.keys[key].en, /\S/, `${key} en`);
  }
});
