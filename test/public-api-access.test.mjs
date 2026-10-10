import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createPublicApiAccess, PUBLIC_API_SCOPES } from '../lib/public-api-access.mjs';

const PROJECT_A = `p_${'a'.repeat(32)}`;
const PROJECT_B = `p_${'b'.repeat(32)}`;

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prime-public-api-'));
  t.after(async () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function fakeRes() {
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.destroy = () => {
    if (res.destroyed) return;
    res.destroyed = true;
    res.emit('close');
  };
  return res;
}

function reqWith(token) {
  return { headers: { authorization: token ? `Bearer ${token}` : '' } };
}

test('default state is disabled with integer revision and documented scopes', async (t) => {
  const dataDir = await tempDir(t);
  const api = createPublicApiAccess({ dataDir });
  const state = await api.get();
  assert.equal(state.enabled, false);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.tokens, []);
  assert.deepEqual(state.scopes, ['read', 'runs:write', 'roadmaps:write', 'files:download']);
  assert.deepEqual(PUBLIC_API_SCOPES, ['read', 'runs:write', 'roadmaps:write', 'files:download']);
  await assert.rejects(api.authenticate(reqWith('anything')), (error) => {
    assert.equal(error.status, 404);
    assert.match(error.message, /api_disabled/);
    return true;
  });
  api.close();
});

test('configure validates input and enforces CAS with live revision', async (t) => {
  const dataDir = await tempDir(t);
  const api = createPublicApiAccess({ dataDir });
  await assert.rejects(api.configure({ enabled: true }), /./);
  await assert.rejects(api.configure({ enabled: 'yes', revision: 0 }), (e) => e.status === 400);
  await assert.rejects(api.configure({ enabled: true, revision: 0, extra: 1 }), (e) => e.status === 400);
  const on = await api.configure({ enabled: true, revision: 0 });
  assert.equal(on.enabled, true);
  assert.equal(on.revision, 1);
  await assert.rejects(api.configure({ enabled: false, revision: 0 }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.currentRevision, 1);
    return true;
  });
  const off = await api.configure({ enabled: false, revision: 1 });
  assert.equal(off.enabled, false);
  assert.equal(off.revision, 2);
  api.close();
});

test('createToken validates names, scopes, projects and expiry', async (t) => {
  const dataDir = await tempDir(t);
  const api = createPublicApiAccess({ dataDir });
  await api.configure({ enabled: true, revision: 0 });
  const base = { scopes: ['read'], projectIds: [PROJECT_A], revision: 1 };
  for (const name of ['', '   ', 'x'.repeat(65), 'bad\nname', 42, null]) {
    await assert.rejects(api.createToken({ ...base, name }), (e) => e.status === 400, `name ${String(name)}`);
  }
  for (const scopes of [
    [],
    ['runs:write'],
    ['read', 'read'],
    ['read', 'unknown'],
    'read',
    ['read', 'runs:write', 'roadmaps:write', 'files:download', 'extra'],
  ]) {
    await assert.rejects(
      api.createToken({ name: 'ok', scopes, projectIds: [PROJECT_A], revision: 1 }),
      (e) => e.status === 400,
    );
  }
  for (const projectIds of [
    [],
    ['*', PROJECT_A],
    ['nope'],
    [`p_${'G'.repeat(32)}`],
    ['p_short'],
    'p_x',
    Array.from({ length: 101 }, () => PROJECT_A),
  ]) {
    await assert.rejects(
      api.createToken({ name: 'ok', scopes: ['read'], projectIds, revision: 1 }),
      (e) => e.status === 400,
    );
  }
  await assert.rejects(
    api.createToken({
      name: 'ok',
      scopes: ['read'],
      projectIds: [PROJECT_A],
      expiresAt: 'not-a-date',
      revision: 1,
    }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    api.createToken({
      name: 'ok',
      scopes: ['read'],
      projectIds: [PROJECT_A],
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      revision: 1,
    }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    api.createToken({ name: 'ok', scopes: ['read'], projectIds: [PROJECT_A], revision: 999 }),
    (e) => e.status === 409 && e.currentRevision === 1,
  );
  // Explicit all-projects marker is accepted.
  const all = await api.createToken({ name: 'all', scopes: ['read'], projectIds: ['*'], revision: 1 });
  assert.equal(all.token.projectIds.join(','), '*');
  assert.match(all.credential, /^pa_[A-Za-z0-9_-]{43}$/);
  api.close();
});

test('credential persists as digest only and survives reload', async (t) => {
  const dataDir = await tempDir(t);
  const api = createPublicApiAccess({ dataDir });
  await api.configure({ enabled: true, revision: 0 });
  const created = await api.createToken({
    name: 'integration-one',
    scopes: ['read', 'runs:write'],
    projectIds: [PROJECT_A, PROJECT_B],
    revision: 1,
  });
  assert.equal(typeof created.credential, 'string');
  assert.ok(created.credential.length >= 40);
  assert.equal(created.token.name, 'integration-one');
  assert.deepEqual(created.token.scopes, ['read', 'runs:write']);
  assert.equal(created.token.expiresAt, null);
  const state = await api.get();
  assert.equal(state.tokens.length, 1);
  assert.ok(!('digest' in state.tokens[0]) && !('credential' in state.tokens[0]));
  const raw = await readFile(join(dataDir, 'public-api.json'), 'utf8');
  assert.ok(!raw.includes(created.credential));
  const expected = createHash('sha256').update(created.credential, 'utf8').digest('hex');
  assert.ok(raw.includes(expected));
  const parsed = JSON.parse(raw);
  assert.equal(parsed.tokens[0].digest, expected);
  // Same credential authenticates on a fresh instance over the same directory.
  const reloaded = createPublicApiAccess({ dataDir });
  const principal = await reloaded.authenticate(reqWith(created.credential));
  assert.equal(principal.id, created.token.id);
  assert.deepEqual(principal.scopes, ['read', 'runs:write']);
  assert.deepEqual(principal.projectIds, [PROJECT_A, PROJECT_B]);
  assert.equal(principal.expiresAt, null);
  api.close();
  reloaded.close();
});

test('authenticate rejects missing, bad, expired and revoked credentials', async (t) => {
  const dataDir = await tempDir(t);
  const api = createPublicApiAccess({ dataDir });
  await api.configure({ enabled: true, revision: 0 });
  const created = await api.createToken({
    name: 'temp',
    scopes: ['read'],
    projectIds: [PROJECT_A],
    revision: 1,
  });
  for (const headers of [
    {},
    { authorization: '' },
    { authorization: 'Bearer' },
    { authorization: 'Token abc' },
  ]) {
    await assert.rejects(api.authenticate({ headers }), (e) => e.status === 401);
  }
  await assert.rejects(api.authenticate(reqWith('pa_wrong')), (e) => e.status === 401);
  const expiring = await api.createToken({
    name: 'short',
    scopes: ['read'],
    projectIds: [PROJECT_A],
    expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    revision: 2,
  });
  assert.ok((await api.authenticate(reqWith(expiring.credential))).id === expiring.token.id);
  api.close();
  let nowValue = Date.now();
  const clocked = createPublicApiAccess({ dataDir, now: () => nowValue });
  // Token created with a short TTL expires when the clock advances.
  const live = await clocked.get();
  const shortLived = await clocked.createToken({
    name: 'clocked',
    scopes: ['read'],
    projectIds: [PROJECT_A],
    expiresAt: new Date(nowValue + 50).toISOString(),
    revision: live.revision,
  });
  assert.equal((await clocked.authenticate(reqWith(shortLived.credential))).id, shortLived.token.id);
  nowValue += 5000;
  await assert.rejects(clocked.authenticate(reqWith(shortLived.credential)), (e) => e.status === 401);
  // Revoke removes the credential permanently.
  const beforeRevoke = await clocked.get();
  await clocked.revoke({ id: created.token.id, revision: beforeRevoke.revision });
  await assert.rejects(clocked.authenticate(reqWith(created.credential)), (e) => e.status === 401);
  const after = await clocked.get();
  assert.ok(!after.tokens.some((entry) => entry.id === created.token.id));
  await assert.rejects(clocked.revoke({ id: 'missing', revision: after.revision }), (e) => e.status === 404);
  clocked.close();
});

test('enabled toggle retains credentials while revoke is permanent', async (t) => {
  const dataDir = await tempDir(t);
  const api = createPublicApiAccess({ dataDir });
  await api.configure({ enabled: true, revision: 0 });
  const created = await api.createToken({ name: 'keep', scopes: ['read'], projectIds: ['*'], revision: 1 });
  const off = await api.configure({ enabled: false, revision: 2 });
  assert.equal(off.tokens.length, 1);
  await assert.rejects(api.authenticate(reqWith(created.credential)), (e) => e.status === 404);
  const on = await api.configure({ enabled: true, revision: 3 });
  assert.equal(on.tokens.length, 1);
  assert.equal((await api.authenticate(reqWith(created.credential))).id, created.token.id);
  const revoked = await api.revoke({ id: created.token.id, revision: on.revision });
  assert.equal(revoked.tokens.length, 0);
  await assert.rejects(api.authenticate(reqWith(created.credential)), (e) => e.status === 401);
  api.close();
});

test('track closes streams on revoke, disable and expiry only', async (t) => {
  const dataDir = await tempDir(t);
  let nowValue = Date.now();
  const api = createPublicApiAccess({ dataDir, now: () => nowValue });
  await api.configure({ enabled: true, revision: 0 });
  const first = await api.createToken({
    name: 'first',
    scopes: ['read'],
    projectIds: [PROJECT_A],
    revision: 1,
  });
  const second = await api.createToken({
    name: 'second',
    scopes: ['read'],
    projectIds: [PROJECT_A],
    revision: 2,
  });
  const principalA = await api.authenticate(reqWith(first.credential));
  const principalB = await api.authenticate(reqWith(second.credential));
  const resA1 = fakeRes();
  const resA2 = fakeRes();
  const resB = fakeRes();
  api.track(principalA, resA1);
  api.track(principalA, resA2);
  api.track(principalB, resB);
  const state = await api.get();
  await api.revoke({ id: first.token.id, revision: state.revision });
  assert.equal(resA1.destroyed, true);
  assert.equal(resA2.destroyed, true);
  assert.equal(resB.destroyed, false);
  // Finished responses unregister and survive later revocations.
  const resC = fakeRes();
  api.track(principalB, resC);
  resC.emit('finish');
  const live = await api.get();
  await api.configure({ enabled: false, revision: live.revision });
  assert.equal(resB.destroyed, true);
  assert.equal(resC.destroyed, false);
  api.close();
});

test('track destroys a stream when its expiry passes', async (t) => {
  const dataDir = await tempDir(t);
  let nowValue = Date.now();
  const api = createPublicApiAccess({ dataDir, now: () => nowValue });
  await api.configure({ enabled: true, revision: 0 });
  const base = await api.get();
  const created = await api.createToken({
    name: 'expiring',
    scopes: ['read'],
    projectIds: [PROJECT_A],
    expiresAt: new Date(nowValue + 40).toISOString(),
    revision: base.revision,
  });
  const principal = await api.authenticate(reqWith(created.credential));
  const res = fakeRes();
  api.track(principal, res);
  await new Promise((done) => setTimeout(done, 120));
  assert.equal(res.destroyed, true);
  api.close();
});

test('invalid persisted configuration fails closed instead of resetting', async (t) => {
  const dataDir = await tempDir(t);
  const api = createPublicApiAccess({ dataDir });
  await api.configure({ enabled: true, revision: 0 });
  const created = await api.createToken({
    name: 'valid',
    scopes: ['read'],
    projectIds: [PROJECT_A],
    revision: 1,
  });
  assert.equal((await api.authenticate(reqWith(created.credential))).id, created.token.id);
  const file = join(dataDir, 'public-api.json');
  // Corrupt JSON must not reset to disabled-empty and must not authenticate.
  await writeFile(file, '{not-json', 'utf8');
  await assert.rejects(api.get(), (e) => e.status === 500);
  await assert.rejects(api.authenticate(reqWith(created.credential)), (e) => e.status === 500);
  await assert.rejects(api.configure({ enabled: false, revision: 2 }), (e) => e.status === 500);
  // Tampered token metadata (missing read scope) fails closed on reload.
  await writeFile(
    file,
    JSON.stringify({
      enabled: true,
      revision: 2,
      tokens: [
        {
          id: 'x',
          name: 'bad',
          scopes: ['runs:write'],
          projectIds: [PROJECT_A],
          createdAt: new Date().toISOString(),
          expiresAt: null,
          digest: 'a'.repeat(64),
        },
      ],
    }),
    'utf8',
  );
  await assert.rejects(api.get(), (e) => e.status === 500);
  await assert.rejects(api.authenticate(reqWith(created.credential)), (e) => e.status === 500);
  // Tampered digest format fails closed.
  await writeFile(
    file,
    JSON.stringify({
      enabled: true,
      revision: 2,
      tokens: [
        {
          id: 'x',
          name: 'bad',
          scopes: ['read'],
          projectIds: [PROJECT_A],
          createdAt: new Date().toISOString(),
          expiresAt: null,
          digest: 'not-hex',
        },
      ],
    }),
    'utf8',
  );
  await assert.rejects(api.authenticate(reqWith(created.credential)), (e) => e.status === 500);
  // Tampered project allowlist fails closed.
  await writeFile(
    file,
    JSON.stringify({
      enabled: true,
      revision: 2,
      tokens: [
        {
          id: 'x',
          name: 'bad',
          scopes: ['read'],
          projectIds: ['evil'],
          createdAt: new Date().toISOString(),
          expiresAt: null,
          digest: 'a'.repeat(64),
        },
      ],
    }),
    'utf8',
  );
  await assert.rejects(api.get(), (e) => e.status === 500);
  api.close();
});

test('errors carry machine code and conflicts keep live revision', async (t) => {
  const dataDir = await tempDir(t);
  const api = createPublicApiAccess({ dataDir });
  await assert.rejects(
    api.authenticate(reqWith('x')),
    (e) => e.status === 404 && e.code === 'api_disabled' && e.message === 'api_disabled',
  );
  await api.configure({ enabled: true, revision: 0 });
  await assert.rejects(
    api.configure({ enabled: true, revision: 0 }),
    (e) => e.status === 409 && e.code === 'revision_conflict' && e.currentRevision === 1,
  );
  await assert.rejects(
    api.createToken({ name: 'x', scopes: ['read'], projectIds: [PROJECT_A], revision: 0 }),
    (e) => e.status === 409 && e.code === 'revision_conflict' && e.currentRevision === 1,
  );
  const created = await api.createToken({
    name: 'one',
    scopes: ['read'],
    projectIds: [PROJECT_A],
    revision: 1,
  });
  await assert.rejects(
    api.authenticate(reqWith('pa_wrong')),
    (e) => e.status === 401 && e.code === 'api_unauthorized',
  );
  const live = await api.get();
  await assert.rejects(
    api.revoke({ id: 'missing', revision: live.revision }),
    (e) => e.status === 404 && e.code === 'token_not_found',
  );
  await assert.rejects(
    api.revoke({ id: created.token.id, revision: 0 }),
    (e) => e.status === 409 && e.code === 'revision_conflict' && Number.isInteger(e.currentRevision),
  );
  api.close();
});

test('out-of-range expiry is rejected as invalid, never 500', async (t) => {
  const dataDir = await tempDir(t);
  const api = createPublicApiAccess({ dataDir });
  await api.configure({ enabled: true, revision: 0 });
  await assert.rejects(
    api.createToken({
      name: 'far',
      scopes: ['read'],
      projectIds: [PROJECT_A],
      expiresAt: Number.MAX_SAFE_INTEGER,
      revision: 1,
    }),
    (e) => e.status === 400 && e.code === 'invalid_token_request',
  );
  await assert.rejects(
    api.createToken({
      name: 'far',
      scopes: ['read'],
      projectIds: [PROJECT_A],
      expiresAt: 8640000000000000 + 100000,
      revision: 1,
    }),
    (e) => e.status === 400,
  );
  api.close();
});

test('token count is bounded and persisted bytes stay within read cap', async (t) => {
  const dataDir = await tempDir(t);
  const api = createPublicApiAccess({ dataDir });
  await api.configure({ enabled: true, revision: 0 });
  let revision = 1;
  const bigProjects = Array.from({ length: 20 }, (_, i) => `p_${i.toString(16).padStart(32, '0')}`);
  for (let n = 0; n < 100; n += 1) {
    const created = await api.createToken({
      name: `int-${n}`,
      scopes: ['read'],
      projectIds: bigProjects,
      revision,
    });
    revision = created.state.revision;
  }
  const state = await api.get();
  assert.equal(state.tokens.length, 100);
  const { stat } = await import('node:fs/promises');
  const size = (await stat(join(dataDir, 'public-api.json'))).size;
  assert.ok(size <= 1024 * 1024);
  await assert.rejects(
    api.createToken({ name: 'overflow', scopes: ['read'], projectIds: [PROJECT_A], revision }),
    (e) => e.status === 400 && e.code === 'invalid_token_request',
  );
  api.close();
});

test('far-future expiry does not destroy early and scope constants match contract', async (t) => {
  const { PUBLIC_API_SCOPES: contractScopes } = await import('../lib/public-api-contract.mjs');
  assert.deepEqual(PUBLIC_API_SCOPES, contractScopes);
  assert.equal(PUBLIC_API_SCOPES, contractScopes);
  const dataDir = await tempDir(t);
  let nowValue = Date.now();
  const api = createPublicApiAccess({ dataDir, now: () => nowValue });
  await api.configure({ enabled: true, revision: 0 });
  const base = await api.get();
  const created = await api.createToken({
    name: 'far',
    scopes: ['read'],
    projectIds: [PROJECT_A],
    expiresAt: new Date(nowValue + 90 * 24 * 3600 * 1000).toISOString(),
    revision: base.revision,
  });
  const principal = await api.authenticate(reqWith(created.credential));
  const res = fakeRes();
  api.track(principal, res);
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(res.destroyed, false);
  res.emit('finish');
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(res.destroyed, false);
  api.close();
});

test('closed access guards authenticate and track', async (t) => {
  const dataDir = await tempDir(t);
  const api = createPublicApiAccess({ dataDir });
  await api.configure({ enabled: true, revision: 0 });
  const created = await api.createToken({
    name: 'one',
    scopes: ['read'],
    projectIds: [PROJECT_A],
    revision: 1,
  });
  const principal = await api.authenticate(reqWith(created.credential));
  assert.equal(principal.id, created.token.id);
  api.close();
  await assert.rejects(
    api.authenticate(reqWith(created.credential)),
    (e) => e.status === 503 && e.code === 'api_unavailable',
  );
  const res = fakeRes();
  const cleanup = api.track(principal, res);
  assert.equal(typeof cleanup, 'function');
  assert.equal(res.destroyed, false);
  assert.equal(res.listenerCount('finish'), 0);
  assert.equal(res.listenerCount('close'), 0);
});
