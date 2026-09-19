import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentEnvelope, nativeAgentMessage, queuedAgentMessage } from '../public/agent-messages.js';
import { normalizeEvent, normalizeMessage } from '../lib/agent.mjs';
import { applyRuntimeStatus } from '../public/runtime-status.js';

const current = '[agent-message from child:Vérificateur]\n\nRésultat\n<script>not executable</script>';
const legacy =
  '[from child:Vérificateur]\nAgent-to-agent message received.\nSource: agent_message\nFrom: Vérificateur, active child\nTo: parent\nMessage id: agentmsg_old\n\nRésultat';

test('0.9.5 agent envelopes and persisted legacy envelopes retain presentation metadata', () => {
  assert.equal(parseAgentEnvelope(current).name, 'Vérificateur');
  assert.equal(parseAgentEnvelope(current).relationship, 'child');
  assert.equal(parseAgentEnvelope(current).text, 'Résultat\n<script>not executable</script>');
  assert.equal(parseAgentEnvelope(legacy).id, 'agentmsg_old');
  assert.equal(parseAgentEnvelope(legacy.replaceAll('\n', '\r\n')).text, 'Résultat');
  assert.equal(parseAgentEnvelope(current.replaceAll('\n', '\r\n')).name, 'Vérificateur');
  assert.equal(parseAgentEnvelope('[agent-message from worker]\n\nOK').relationship, '');
  for (const text of [
    'ordinary user message',
    '[agent-message from child:x]\nmissing boundary',
    '[agent-message from child:x\nfake]\n\nbody',
  ])
    assert.equal(parseAgentEnvelope(text), null);
  assert.equal(nativeAgentMessage({ role: 'user', content: current }), null);
  assert.equal(nativeAgentMessage({ customType: 'agent_message', content: current }).name, 'Vérificateur');
  assert.equal(queuedAgentMessage(current).relationship, 'child');
  assert.equal(queuedAgentMessage('Agent message received: old preview').text, 'old preview');
});

test('native customType and structured agent details take precedence over textual envelopes', () => {
  const message = {
    role: 'custom',
    customType: 'agent_message',
    display: true,
    content: current,
    details: {
      id: 'agentmsg_real',
      message: 'Canonical result',
      fromRelationship: 'sibling',
      from: { sessionName: 'Real sender' },
    },
  };
  const result = normalizeMessage(message);
  assert.equal(result.customType, 'agent_message');
  assert.equal(result.agentMessage.name, 'Real sender');
  assert.equal(result.agentMessage.text, 'Canonical result');
  assert.equal(result.role, 'system');
  assert.equal('details' in result, false);
  assert.equal(
    normalizeMessage({ role: 'custom', customType: 'harness_digest', display: false }).role,
    'custom',
  );
});

test('provider recovery events preserve bounded native metadata, not arbitrary details', () => {
  for (const reason of ['usage', 'unavailable', 'backup']) {
    const [event] = normalizeEvent({
      type: 'auto_retry_start',
      reason,
      attempt: 2,
      maxAttempts: 10,
      delayMs: 1500,
      backupModel: 'fixture/backup',
      details: { token: 'secret' },
    });
    assert.equal(event.reason, reason);
    assert.equal(event.maxAttempts, 10);
    assert.equal(event.backupModel, 'fixture/backup');
    assert.equal(event.delayMs, 1500);
    assert.equal('details' in event, false);
  }
  assert.equal(normalizeEvent({ type: 'auto_retry_start', reason: 'unexpected' })[0].reason, undefined);
  const [restored] = normalizeEvent({
    type: 'auto_retry_end',
    success: true,
    restoredModel: 'fixture/primary',
  });
  assert.equal(restored.retryEnded, true);
  assert.equal(restored.restoredModel, 'fixture/primary');
  assert.equal(restored.status, 'running');
  assert.equal(
    normalizeEvent({ type: 'auto_retry_end', success: false, finalError: 'Quota still blocked' })[0].status,
    'retry_failed',
  );
});

test('backup status persists while streaming and clears on restore without changing model selection', () => {
  const run = { model: 'fixture/primary' };
  const tr = (key, values) => key + (values ? JSON.stringify(values) : '');
  applyRuntimeStatus(run, { status: 'retrying', reason: 'usage', delayMs: 1500 }, tr);
  assert.match(run.statusLabel, /providerRetry\.usage.*"seconds":2/);
  applyRuntimeStatus(run, { status: 'retrying', reason: 'backup', backupModel: 'fixture/backup' }, tr);
  applyRuntimeStatus(run, { status: 'running' }, tr);
  assert.match(run.statusLabel, /providerRetry\.backup/);
  assert.equal(run.model, 'fixture/primary');
  applyRuntimeStatus(run, { status: 'running', retryEnded: true, restoredModel: 'fixture/primary' }, tr);
  assert.equal(run.backupModel, undefined);
  assert.match(run.statusLabel, /providerRetry\.restored/);
  applyRuntimeStatus(run, { status: 'retry_failed', retryEnded: true }, tr);
  assert.equal(run.statusLabel, 'providerRetry.failed');
});
