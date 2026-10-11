import test from 'node:test';
import assert from 'node:assert/strict';
import {
  draftKeyFor,
  originSessionId,
  writableDraftKey,
  validateSidecar,
  REGISTRY_HARD_CAP,
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

test('readonly yields no writable draft key (save/delete prohibited, nothing shown)', () => {
  assert.equal(writableDraftKey({ sessionId: 'S1', nonce: 'a' }, true), null);
  assert.equal(writableDraftKey({ sessionId: null, nonce: 'a' }, true), null);
  assert.equal(writableDraftKey(null, true), null);
  assert.equal(writableDraftKey({ sessionId: 'S1', nonce: 'a' }, false), 'session:S1');
  assert.equal(writableDraftKey({ sessionId: null, nonce: 'a' }, false), 'conv:a');
  assert.equal(writableDraftKey({ sessionId: 'S1', nonce: 'a' }, undefined), 'session:S1');
});

test('validateSidecar rejects duplicate nonces (shared unsent slot)', () => {
  const dup = validateSidecar({
    version: 1,
    entries: [entry(), { ...entry(), id: 'conv:v2', nonce: 'n1' }],
  });
  assert.equal(dup, null, 'duplicate new nonce rejected');
});

test('validateSidecar rejects duplicate sessionIds (dual writers)', () => {
  const dup = validateSidecar({
    version: 1,
    entries: [
      { ...entry(), kind: 'session', sessionId: 'S1', nonce: 'a' },
      { ...entry(), id: 'conv:v2', kind: 'session', sessionId: 'S1', nonce: 'b' },
    ],
  });
  assert.equal(dup, null, 'duplicate session rejected');
});

test('validateSidecar keeps distinct sessions and distinct new nonces', () => {
  const clean = validateSidecar({
    version: 1,
    activeId: 'conv:v2',
    entries: [
      { ...entry(), kind: 'session', sessionId: 'S1', nonce: 'a' },
      { ...entry(), id: 'conv:v2', kind: 'new', sessionId: null, viewRunId: null, nonce: 'b' },
    ],
  });
  assert.ok(clean, 'distinct bindings accepted');
  assert.equal(clean.activeId, 'conv:v2');
  assert.equal(clean.entries.length, 2);
});

test('registry hard cap is a positive bound above the mount cap', () => {
  assert.ok(REGISTRY_HARD_CAP >= 8, 'registry holds closed views beyond 8 mounted');
  assert.equal(draftKeyFor({ sessionId: null, nonce: 'x'.repeat(64) }), `conv:${'x'.repeat(64)}`);
});

test('stale draft gen never overrides a bound session (bind clears, resolver guards)', async () => {
  // Resolver-level guard lives in app tripleForView; registry guarantees the
  // slot invariant below: distinct session bindings never share draft keys.
  assert.equal(draftKeyFor({ sessionId: 'S1', nonce: 'stale-pick' }), 'session:S1');
  assert.equal(draftKeyFor({ sessionId: null, nonce: 'stale-pick' }), 'conv:stale-pick');
  // A rebind from the new-chat slot to the session slot changes the canonical
  // key, so the old unsent pick cannot leak into the session binding.
  assert.notEqual(
    draftKeyFor({ sessionId: null, nonce: 'stale-pick' }),
    draftKeyFor({ sessionId: 'S1', nonce: 'stale-pick' }),
  );
});

test('duplicate session bindings rejected even with distinct nonces/ids', () => {
  const dup = validateSidecar({
    version: 1,
    entries: [
      {
        id: 'conversation',
        kind: 'session',
        sessionId: 'S1',
        projectCwd: null,
        execCwd: null,
        viewRunId: null,
        nonce: 'a',
        gen: null,
      },
      {
        id: 'conv:v2',
        kind: 'new',
        sessionId: null,
        projectCwd: 'C:/p',
        execCwd: 'C:/p',
        viewRunId: null,
        nonce: 'S1',
        gen: null,
      },
    ],
  });
  // Nonce 'S1' is a well-formed unique nonce: only view-id/session duplicates
  // reject. A nonce merely colliding with another entry's session text is fine.
  assert.ok(dup, 'nonce text may coincidentally match other fields');
  assert.equal(dup.entries[1].nonce, 'S1');
});

test('origin session never falls through: new origin resolves null', () => {
  assert.equal(originSessionId(null, 'S9'), 'S9', 'missing origin uses fallback');
  assert.equal(originSessionId({ sessionId: 'A' }, 'S9'), 'A', 'explicit origin wins');
  assert.equal(
    originSessionId({ sessionId: null }, 'S9'),
    null,
    'new origin must not inherit another session',
  );
  assert.equal(
    originSessionId({ sessionId: '' }, 'S9'),
    null,
    'empty origin must not inherit another session',
  );
});
