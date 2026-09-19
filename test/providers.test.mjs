import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createProviderAuth, credentialRevision } from '../lib/provider-auth.mjs';
import { createProviderService } from '../lib/provider-service.mjs';

async function fixture(t) {
  const agentHome = await mkdtemp(join(tmpdir(), 'prime-studio-providers-'));
  t.after(() => rm(agentHome, { recursive: true, force: true }));
  return {
    agentHome,
    authPath: join(agentHome, 'auth.json'),
    store: () => createProviderAuth({ agentHome }),
  };
}
test('native provider listing never refreshes tokens or runs credential commands; writes preserve other providers and MCP', async (t) => {
  const { agentHome, authPath, store } = await fixture(t);
  const marker = join(agentHome, 'command-must-not-run.txt');
  const initial = {
    'mcp:notes': { type: 'oauth', access: 'mcp-private', refresh: 'refresh-private', expires: 0 },
    anthropic: { type: 'oauth', access: 'private-anthropic', refresh: 'private-refresh', expires: 0 },
    openai: { type: 'api_key', key: 'private-openai' },
    groq: { type: 'api_key', key: `!echo unwanted > "${marker}"` },
  };
  await writeFile(authPath, JSON.stringify(initial));
  const sdk = await store(),
    list = sdk.list();
  assert.doesNotMatch(
    JSON.stringify(list),
    /private-openai|mcp-private|refresh-private|private-anthropic|command-must-not-run/,
  );
  await assert.rejects(access(marker));
  assert(!list.providers.some((p) => p.id.startsWith('mcp:')));
  assert(
    list.providers.some(
      (p) => p.id === 'openai-codex' && p.methods.includes('oauth') && !p.methods.includes('api_key'),
    ),
  );
  assert.deepEqual(JSON.parse(await readFile(authPath)), initial);
  const rev = list.providers.find((p) => p.id === 'openai').revision;
  // An MCP login occurred after this view was loaded.
  initial['mcp:another'] = { type: 'api_key', key: 'another-private' };
  await writeFile(authPath, JSON.stringify(initial));
  await sdk.save({ provider: 'openai', revision: rev, kind: 'key', value: 'replacement-private' });
  const saved = JSON.parse(await readFile(authPath));
  assert.deepEqual(saved['mcp:another'], initial['mcp:another']);
  assert.deepEqual(saved['mcp:notes'], initial['mcp:notes']);
  assert.deepEqual(saved.groq, initial.groq);
  assert.equal(saved.openai.key, 'replacement-private');
  const fresh = await store();
  fresh.remove({
    provider: 'openai',
    revision: fresh.list().providers.find((p) => p.id === 'openai').revision,
  });
  assert.deepEqual(JSON.parse(await readFile(authPath)), {
    'mcp:notes': initial['mcp:notes'],
    anthropic: initial.anthropic,
    groq: initial.groq,
    'mcp:another': initial['mcp:another'],
  });
});
test('native lock rejects stale edits and removal of the same provider', async (t) => {
  const { authPath, store } = await fixture(t);
  await writeFile(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'first' } }));
  const stale = await store(),
    revision = stale.list().providers.find((p) => p.id === 'openai').revision;
  const concurrent = {
    openai: { type: 'api_key', key: 'second' },
    'mcp:test': { type: 'api_key', key: 'kept' },
  };
  await writeFile(authPath, JSON.stringify(concurrent));
  await assert.rejects(
    stale.save({ provider: 'openai', revision, kind: 'key', value: 'third' }),
    (e) => e.status === 409,
  );
  assert.throws(
    () => stale.remove({ provider: 'openai', revision }),
    (e) => e.status === 409,
  );
  assert.deepEqual(JSON.parse(await readFile(authPath)), concurrent);
});
test('invalid and command-backed key input cannot execute or corrupt stored connections', async (t) => {
  const { authPath, store } = await fixture(t);
  const sdk = await store(),
    revision = credentialRevision(null);
  for (const [provider, value, kind] of [
    ['openai', '!echo secret', 'key'],
    ['__proto__', 'key', 'key'],
    ['mcp:test', 'key', 'key'],
    ['openai', 'a\nb', 'key'],
    ['openai-codex', 'value', 'key'],
    ['unknown-new', 'value', 'key'],
    ['openai', 'STUDIO_PROVIDER_MISSING_TEST_VAR', 'environment'],
  ])
    await assert.rejects(sdk.save({ provider, revision, kind, value }));
  assert.deepEqual(JSON.parse(await readFile(authPath)), {});
  await writeFile(authPath, '{"broken":');
  await assert.rejects(store());
  assert.equal(await readFile(authPath, 'utf8'), '{"broken":');
  await writeFile(authPath, '[]');
  await assert.rejects(store());
  assert.equal(await readFile(authPath, 'utf8'), '[]');
});
test('hidden auth worker writes real native credentials without returning keys and honors busy sessions', async (t) => {
  const { agentHome, authPath } = await fixture(t);
  let busy = false,
    changed = 0;
  const service = createProviderService({ agentHome, isBusy: () => busy, onChanged: () => changed++ });
  t.after(() => service.close());
  const data = await service.list(),
    entry = data.providers.find((p) => p.id === 'deepseek');
  busy = true;
  const result = await service.save({
    provider: entry.id,
    revision: entry.revision,
    kind: 'key',
    value: 'test-deepseek-secret',
  });
  assert.doesNotMatch(JSON.stringify(result), /test-deepseek-secret/);
  assert.equal(JSON.parse(await readFile(authPath)).deepseek.key, 'test-deepseek-secret');
  const revision = credentialRevision({ type: 'api_key', key: 'test-deepseek-secret' });
  await assert.rejects(service.remove({ provider: 'deepseek', revision }), (e) => e.status === 409);
  await assert.rejects(
    service.save({ provider: 'deepseek', revision, kind: 'key', value: 'other' }),
    (e) => e.status === 409,
  );
  busy = false;
  await service.remove({ provider: 'deepseek', revision });
  assert.equal(changed, 2);
});

test('an environment connection cannot be overridden while agents are active; variable references remain native', async (t) => {
  const { agentHome, authPath } = await fixture(t);
  let busy = true;
  const service = createProviderService({
    agentHome,
    isBusy: () => busy,
    environment: {
      ...process.env,
      DEEPSEEK_API_KEY: 'environment-private-value',
      STUDIO_TEST_KEY: 'environment-private-value',
    },
  });
  t.after(() => service.close());
  const data = await service.list(),
    entry = data.providers.find((p) => p.id === 'deepseek');
  assert.equal(entry.configured, true);
  assert.equal(entry.source, 'environment');
  assert.equal(entry.stored, false);
  assert.doesNotMatch(JSON.stringify(data), /environment-private-value/);
  const body = {
    provider: entry.id,
    revision: entry.revision,
    kind: 'environment',
    value: 'STUDIO_TEST_KEY',
  };
  await assert.rejects(service.save(body), (e) => e.status === 409);
  assert.deepEqual(JSON.parse(await readFile(authPath)), {});
  busy = false;
  await service.save(body);
  assert.equal(JSON.parse(await readFile(authPath)).deepseek.key, 'STUDIO_TEST_KEY');
});

export function fakeAuthSpawn(onRequest) {
  const spawned = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.killed = false;
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      child.emit('close', 0);
    };
    let buffer = '';
    child.send = (data) => child.stdout.write(JSON.stringify(data) + '\n');
    child.stdin.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        onRequest(child, JSON.parse(line));
      }
    });
    spawned.push({ child, command, args, options });
    return child;
  };
  return { spawnProcess, spawned };
}
const promptId = '12345678-abcd-1234-abcd-123456789012';
test('OAuth handles manual input, selection, cancellation, completion and timeout in its own hidden worker', async (t) => {
  const answers = [];
  const fake = fakeAuthSpawn((child, data) => {
    if (data.operation === 'login')
      queueMicrotask(() =>
        child.send({
          type: 'auth',
          url: 'https://github.com/login/device',
          instructions: 'Code : DEMO-CODE',
        }),
      );
    else answers.push(data);
  });
  let changed = 0;
  const service = createProviderService({
    agentHome: 'unused-fixture',
    spawnProcess: fake.spawnProcess,
    onChanged: () => changed++,
  });
  t.after(() => service.close());
  const body = { provider: 'github-copilot', revision: credentialRevision(null) };
  let job = service.login(body);
  await new Promise((r) => setImmediate(r));
  const { child, options, args } = fake.spawned[0];
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, false);
  assert.equal(args.length, 1);
  child.send({
    type: 'prompt',
    prompt: { id: promptId, kind: 'text', message: 'Domaine', allowEmpty: true },
  });
  assert.equal(service.job(job.id).prompts.length, 1);
  service.answer(job.id, { promptId, value: '' });
  assert.equal(answers[0].value, '');
  child.send({
    type: 'prompt',
    prompt: { id: promptId, kind: 'select', message: 'Compte', options: [{ id: 'one', label: 'Personnel' }] },
  });
  assert.throws(
    () => service.answer(job.id, { promptId, value: 'bad' }),
    (e) => e.status === 400,
  );
  service.answer(job.id, { promptId, value: 'one' });
  child.send({ type: 'prompt', prompt: { id: promptId, kind: 'commit' } });
  assert.equal(service.job(job.id).status, 'saving');
  assert.throws(
    () => service.cancel(job.id),
    (e) => e.status === 409,
  );
  child.send({ type: 'result', result: { saved: true } });
  assert.equal(service.job(job.id).status, 'complete');
  assert.equal(changed, 1);
  job = service.login(body);
  assert.equal(service.cancel(job.id).status, 'cancelled');
  fake.spawned[1].child.send({ type: 'result', result: { saved: true } });
  assert.equal(changed, 1);
  const expiry = createProviderService({
    agentHome: 'unused-fixture',
    spawnProcess: fake.spawnProcess,
    timeoutMs: 20,
  });
  t.after(() => expiry.close());
  const expires = expiry.login(body);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(expiry.job(expires.id).status, 'error');
});
test('OAuth refuses unsafe authorization URLs and rechecks busy status before saving', async (t) => {
  let busy = false;
  const fake = fakeAuthSpawn(() => {}),
    service = createProviderService({
      agentHome: 'unused',
      spawnProcess: fake.spawnProcess,
      isBusy: () => busy,
    });
  t.after(() => service.close());
  let job = service.login({ provider: 'openai-codex', revision: credentialRevision(null) });
  fake.spawned[0].child.send({ type: 'auth', url: 'javascript:alert(1)' });
  assert.equal(service.job(job.id).status, 'error');
  job = service.login({
    provider: 'openai-codex',
    revision: credentialRevision({ type: 'oauth', access: 'old' }),
  });
  busy = true;
  fake.spawned[1].child.send({ type: 'prompt', prompt: { id: promptId, kind: 'commit' } });
  assert.equal(service.job(job.id).status, 'error');
  assert.equal(fake.spawned[1].child.killed, true);
});

test('OAuth methods follow the native registry including xAI Grok without a frozen list', async (t) => {
  const { agentHome } = await fixture(t);
  const data = {};
  const fromStorageOptions = [];
  const oauthIds = ['anthropic', 'github-copilot', 'openai-codex', 'xai'];
  const fakeNative = {
    FileAuthStorageBackend: class {
      constructor(path) {
        this.path = path;
      }
      withLock(fn) {
        const current = JSON.stringify(data);
        const { result, next } = fn(current);
        if (next !== undefined) Object.assign(data, JSON.parse(next));
        return result;
      }
      async withLockAsync(fn) {
        const current = JSON.stringify(data);
        const { result, next } = await fn(current);
        if (next !== undefined) Object.assign(data, JSON.parse(next));
        return result;
      }
    },
    AuthStorage: {
      fromStorage: (backend, options) => {
        fromStorageOptions.push(options);
        return {
          drainErrors: () => [],
          reload: () => {},
          getOAuthProviders: () => oauthIds.map((id) => ({ id, name: id === 'xai' ? 'xAI (Grok)' : id })),
          list: () => Object.keys(data),
          get: (id) => data[id],
          set: (id, credential) => {
            data[id] = credential;
          },
          removeVerified: (id) => {
            delete data[id];
          },
        };
      },
    },
    ModelRegistry: {
      create: () => ({
        getAll: () => [
          { provider: 'anthropic' },
          { provider: 'github-copilot' },
          { provider: 'openai-codex' },
          { provider: 'xai' },
          { provider: 'deepseek' },
        ],
        getProviderAuthStatus: () => ({ configured: false }),
        getProviderDisplayName: (id) => (id === 'xai' ? 'xAI (Grok)' : id),
        getError: () => undefined,
      }),
    },
  };
  const store = await createProviderAuth({ agentHome, native: fakeNative });
  const list = store.list();
  const methods = Object.fromEntries(list.providers.map((p) => [p.id, p.methods]));
  // Registry-driven: xAI/Grok exposes both subscription (OAuth) and API-key entry.
  assert.deepEqual(methods.xai.sort(), ['api_key', 'oauth']);
  assert.deepEqual(methods.anthropic.sort(), ['api_key', 'oauth']);
  assert.deepEqual(methods['openai-codex'], ['oauth']);
  assert.deepEqual(methods['github-copilot'], ['oauth']);
  assert.deepEqual(methods.deepseek, ['api_key']);
  // A future registry entry needs no production-code change.
  oauthIds.push('future-oauth');
  fakeNative.ModelRegistry.create = () => ({
    getAll: () => [{ provider: 'future-oauth' }],
    getProviderAuthStatus: () => ({ configured: false }),
    getProviderDisplayName: (id) => id,
    getError: () => undefined,
  });
  const extended = await createProviderAuth({ agentHome, native: fakeNative });
  assert.ok(extended.list().providers.some((p) => p.id === 'future-oauth' && p.methods.includes('oauth')));
});

test('ordinary writes never enable the Prime CLI candidate', async (t) => {
  const { agentHome } = await fixture(t);
  const data = {};
  const seen = [];
  const fakeNative = {
    FileAuthStorageBackend: class {
      withLock(fn) {
        const { result, next } = fn(JSON.stringify(data));
        if (next !== undefined) Object.assign(data, JSON.parse(next));
        return result;
      }
      async withLockAsync(fn) {
        const { result, next } = await fn(JSON.stringify(data));
        if (next !== undefined) Object.assign(data, JSON.parse(next));
        return result;
      }
    },
    AuthStorage: {
      fromStorage: (backend, options) => {
        seen.push(options);
        return {
          drainErrors: () => [],
          reload: () => {},
          getOAuthProviders: () => [],
          list: () => Object.keys(data),
          get: (id) => data[id],
          set: (id, credential) => {
            data[id] = credential;
          },
          removeVerified: (id) => {
            delete data[id];
          },
        };
      },
    },
    ModelRegistry: {
      create: () => ({
        getAll: () => [{ provider: 'deepseek' }],
        getProviderAuthStatus: () => ({ configured: false }),
        getProviderDisplayName: (id) => id,
        getError: () => undefined,
      }),
    },
  };
  const store = await createProviderAuth({ agentHome, native: fakeNative });
  const revision = store.list().providers.find((p) => p.id === 'deepseek').revision;
  await store.save({ provider: 'deepseek', revision, kind: 'key', value: 'test-isolated-secret' });
  assert.ok(seen.length >= 2);
  assert.deepEqual(seen[seen.length - 1], { usePrimeCliConfig: false });
  assert.equal(data.deepseek.key, 'test-isolated-secret');
});

test('legacy prime_cli source stays readable for older engines', async (t) => {
  const { agentHome } = await fixture(t);
  const fakeNative = {
    FileAuthStorageBackend: class {
      withLock(fn) {
        return fn('{}').result;
      }
      async withLockAsync(fn) {
        return (await fn('{}')).result;
      }
    },
    AuthStorage: {
      fromStorage: () => ({
        drainErrors: () => [],
        reload: () => {},
        getOAuthProviders: () => [],
        list: () => [],
        get: () => undefined,
      }),
    },
    ModelRegistry: {
      create: () => ({
        getAll: () => [{ provider: 'prime-inference' }],
        getProviderAuthStatus: () => ({ configured: true, source: 'prime_cli' }),
        getProviderDisplayName: (id) => id,
        getError: () => undefined,
      }),
    },
  };
  const store = await createProviderAuth({ agentHome, native: fakeNative });
  assert.equal(store.list().providers[0].source, 'prime_cli');
});
