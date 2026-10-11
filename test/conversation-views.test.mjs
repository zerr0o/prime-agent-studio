import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIMARY_VIEW_ID,
  SIDECAR_VERSION,
  REGISTRY_HARD_CAP,
  draftKeyFor,
  imageKeyOf,
  legacyBackupKey,
  validateSidecar,
} from '../public/conversation-views.js';

const entry = (over = {}) => ({
  id: 'conversation',
  kind: 'new',
  sessionId: null,
  projectCwd: null,
  execCwd: null,
  viewRunId: null,
  nonce: 'n1',
  gen: null,
  ...over,
});

test('draft keys isolate bindings: session shared, new per-nonce', () => {
  assert.equal(draftKeyFor({ sessionId: 'S1', nonce: 'a' }), 'session:S1');
  assert.equal(draftKeyFor({ sessionId: 'S1', nonce: 'b' }), 'session:S1', 'one writer per session');
  assert.equal(draftKeyFor({ sessionId: null, nonce: 'a' }), 'conv:a');
  assert.notEqual(
    draftKeyFor({ sessionId: null, nonce: 'a' }),
    draftKeyFor({ sessionId: null, nonce: 'b' }),
    'unsent slots never share a key',
  );
  assert.equal(draftKeyFor(null), null);
  assert.equal(imageKeyOf({ sessionId: 'S1', nonce: 'a' }), 'session:S1', 'images ride the same key');
});

test('legacy backup keys are one-shot and never equal the canonical key', () => {
  assert.equal(legacyBackupKey({ sessionId: 'S1', projectCwd: 'C:/p' }), 'session:S1');
  assert.equal(legacyBackupKey({ sessionId: null, projectCwd: 'C:\\P\\' }), 'project:c:/p');
  assert.equal(legacyBackupKey({ sessionId: null, projectCwd: null }), null);
});

test('validateSidecar accepts a minimal registry and falls back activeId', () => {
  const clean = validateSidecar({ version: 1, activeId: 'nope', entries: [entry()] });
  assert.ok(clean, 'accepted');
  assert.equal(clean.activeId, PRIMARY_VIEW_ID, 'unknown active falls back to primary');
  assert.equal(clean.entries[0].nonce, 'n1', 'nonce preserved for slot restore');
});

test('validateSidecar rejects malformed registries', () => {
  assert.equal(validateSidecar(null), null);
  assert.equal(validateSidecar({ version: 9, entries: [entry()] }), null, 'unknown version');
  assert.equal(
    validateSidecar({ version: 1, entries: [{ ...entry(), id: 'conv:x' }] }),
    null,
    'primary required',
  );
  const dup = validateSidecar({ version: 1, entries: [entry(), entry()] });
  assert.equal(dup, null, 'duplicate ids rejected');
  const badId = validateSidecar({ version: 1, entries: [{ ...entry(), id: 'conv:' }] });
  assert.equal(badId, null, 'malformed ref rejected');
  const badNonce = validateSidecar({ version: 1, entries: [{ ...entry(), nonce: 'has space' }] });
  assert.equal(badNonce, null, 'malformed nonce rejected');
  const mismatch = validateSidecar({
    version: 1,
    entries: [entry({ kind: 'session', sessionId: null })],
  });
  assert.equal(mismatch, null, 'session kind without sessionId rejected');
  const runMismatch = validateSidecar({
    version: 1,
    entries: [{ ...entry(), id: 'conv:x', kind: 'run', viewRunId: null }],
  });
  assert.equal(runMismatch, null, 'run kind without viewRunId rejected');
  const newWithRefs = validateSidecar({
    version: 1,
    entries: [{ ...entry(), kind: 'new', sessionId: 'S1' }],
  });
  assert.equal(newWithRefs, null, 'new kind with refs rejected');
  const big = validateSidecar({
    version: 1,
    entries: [{ ...entry(), projectCwd: `c:/${'x'.repeat(600)}` }],
  });
  assert.equal(big, null, 'oversized fields rejected');
});

test('validateSidecar enforces the registry cap', () => {
  assert.equal(REGISTRY_HARD_CAP, 24);
  const entries = [entry()];
  for (let i = 0; i < REGISTRY_HARD_CAP; i += 1) {
    entries.push({ ...entry(), id: `conv:v${i}`, nonce: `n${i}x` });
  }
  assert.equal(entries.length, REGISTRY_HARD_CAP + 1);
  assert.equal(validateSidecar({ version: SIDECAR_VERSION, entries }), null, 'over cap rejected');
  assert.ok(
    validateSidecar({ version: SIDECAR_VERSION, entries: entries.slice(0, REGISTRY_HARD_CAP) }),
    'at cap accepted',
  );
});
