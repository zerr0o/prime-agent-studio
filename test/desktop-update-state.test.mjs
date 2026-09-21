import test from 'node:test';
import assert from 'node:assert/strict';
import {
  updateView,
  operationActive,
  operationCancellable,
  progressNumbers,
} from '../public/desktop-update-state.js';
const server = {
  running: true,
  managed: false,
  ownership: 'recoverable',
  canRestart: true,
  canStop: true,
  appVersion: '3.7.1',
  version: '3.7.0',
};
test('recoverable server can restart and never claims current when backend is old', () => {
  const v = updateView({ server, checked: true });
  assert.equal(v.status, 'updates.state_restart');
  assert.equal(v.restartDisabled, false);
  assert.equal(v.canControl, true);
});
test('foreign identity blocks restart with explicit presentation state', () => {
  const v = updateView({ server: { ...server, canRestart: false, canStop: false } });
  assert.equal(v.canControl, false);
  assert.equal(v.restartDisabled, true);
});
test('busy download or repair does not prevent explicit restart', () => {
  for (const kind of ['install', 'prepare', 'components']) {
    const v = updateView({
      server,
      operation: { kind, stage: kind === 'install' ? 'downloading' : 'working', cancellable: true },
    });
    assert.equal(v.busy, true);
    assert.equal(v.restartDisabled, false);
    assert.equal(v.cancellable, true);
  }
});
test('installer handoff cannot be cancelled or restarted', () => {
  for (const stage of ['verifying', 'installing']) {
    const v = updateView({ server, operation: { kind: 'install', stage, cancellable: false } });
    assert.equal(v.locked, true);
    assert.equal(v.restartDisabled, true);
    assert.equal(v.cancellable, false);
  }
});
test('terminal snapshots survive without locking controls', () => {
  for (const stage of ['done', 'error', 'cancelled']) {
    const operation = { kind: 'install', stage, terminal: true, done: true, cancellable: false };
    assert.equal(operationActive(operation), false);
    assert.equal(operationCancellable(operation), false);
    assert.equal(updateView({ server, operation }).busy, false);
  }
});
test('progress reports bytes without inventing a total or percent', () => {
  assert.deepEqual(
    progressNumbers(
      {
        receivedBytes: 42,
        totalBytes: null,
        percent: null,
        startedAt: 1000,
        updatedAt: 1000,
        stage: 'downloading',
      },
      20000,
    ),
    { received: 42, total: null, percent: null, seconds: 19, stalled: true },
  );
  assert.equal(progressNumbers({ receivedBytes: 50, totalBytes: 100 }).percent, 50);
});
test('ready files do not imply an active runtime; never claim latest before checking', () => {
  assert.equal(
    updateView({ server: { ...server, version: '3.7.1' }, components: { ready: true, needsRestart: true } })
      .status,
    'updates.state_restart',
  );
  assert.equal(updateView({ server: { ...server, version: '3.7.1' } }).status, 'updates.state_running');
  assert.equal(
    updateView({ server: { ...server, version: '3.7.1' }, checked: true }).status,
    'updates.current',
  );
  assert.equal(updateView({ server: { running: false, canRestart: false } }).restartDisabled, false);
});
