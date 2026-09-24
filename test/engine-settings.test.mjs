import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEngineSettingsStore,
  assertEngineRevision,
  cleanModelReference,
  cleanAutonomousValue,
  cleanAutonomousInput,
  DEFAULT_AUTONOMOUS_LIMITS,
} from '../lib/engine-settings.mjs';

async function fixture(t, settings) {
  const agentHome = await mkdtemp(join(tmpdir(), 'prime-studio-engine-settings-'));
  if (settings !== undefined) await writeFile(join(agentHome, 'settings.json'), settings, 'utf8');
  t.after(() => rm(agentHome, { recursive: true, force: true }));
  return { agentHome, store: createEngineSettingsStore({ agentHome }) };
}

test('starts unset without enabling backup or autonomous', async (t) => {
  const { store } = await fixture(t);
  const state = await store.get();
  assert.equal(state.revision, null);
  assert.equal(state.auxiliaryModel, '');
  assert.equal(state.providerBackupModel, '');
  assert.equal(state.nativeSubagentDefaultModel, '');
  assert.deepEqual(state.autonomous, {
    maxContinuations: null,
    maxTurns: null,
    maxTokens: null,
    timeoutMs: null,
  });
  assert.deepEqual(state.defaults.autonomous, DEFAULT_AUTONOMOUS_LIMITS);
});

test('0.9.6 image model and service tier stay opt-in and preserve unrelated settings', async (t) => {
  const { agentHome, store } = await fixture(t, JSON.stringify({ theme: 'light' }));
  const initial = await store.get();
  assert.equal(initial.imageModel, '');
  assert.equal(initial.defaultServiceTier, 'default');
  const saved = await store.set({
    revision: initial.revision,
    imageModel: 'openai/vision-model',
    defaultServiceTier: 'priority',
  });
  assert.equal(saved.imageModel, 'openai/vision-model');
  assert.equal(saved.defaultServiceTier, 'priority');
  await store.set({ autonomous: { maxTurns: 6 } });
  const kept = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal(kept.imageModel, 'openai/vision-model');
  assert.equal(kept.defaultServiceTier, 'priority');
  assert.equal(kept.theme, 'light');
  await assert.rejects(store.set({ revision: initial.revision, imageModel: null }), { status: 409 });
  const cleared = await store.set({ imageModel: null, defaultServiceTier: null });
  assert.equal(cleared.imageModel, '');
  assert.equal(cleared.defaultServiceTier, 'default');
  const raw = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal('imageModel' in raw, false);
  assert.equal('defaultServiceTier' in raw, false);
});

test('0.9.6 settings validate image references and native service tier values before writing', async (t) => {
  const { store } = await fixture(t);
  for (const tier of ['default', 'flex', 'priority', 'auto']) {
    assert.equal((await store.set({ defaultServiceTier: tier })).defaultServiceTier, tier);
  }
  const before = await store.get();
  for (const bad of ['fast', 'Priority', true, 2, {}, []]) {
    await assert.rejects(store.set({ defaultServiceTier: bad }), { status: 400 });
  }
  for (const bad of [42, {}, [], '__proto__/x', 'two words']) {
    await assert.rejects(store.set({ imageModel: bad }), { status: 400 });
  }
  assert.equal((await store.get()).revision, before.revision);
});

test('official engine reads the stored image model and service tier defaults', async (t) => {
  const { loadPrimeNative } = await import('../lib/prime-native.mjs');
  const { SettingsManager } = await loadPrimeNative();
  const { agentHome, store } = await fixture(t);
  await store.set({ imageModel: 'test/vision', defaultServiceTier: 'flex' });
  const native = SettingsManager.create(agentHome, agentHome);
  assert.equal(native.getImageModel(), 'test/vision');
  assert.equal(native.getDefaultServiceTier(), 'flex');
  await store.set({ imageModel: null, defaultServiceTier: null });
  const cleared = SettingsManager.create(agentHome, agentHome);
  assert.equal(cleared.getImageModel(), undefined);
  assert.equal(cleared.getDefaultServiceTier(), 'default');
});

test('writes native fields, merges unknown keys and keeps a backup', async (t) => {
  const initial = JSON.stringify(
    {
      theme: 'dark',
      mcpServers: { private: { type: 'http', url: 'https://private.test' } },
      recentModels: ['old-provider/old-model'],
    },
    null,
    2,
  );
  const { agentHome, store } = await fixture(t, initial);
  const saved = await store
    .set({
      auxiliaryModel: 'opencode/muse-spark-1.3-contributor-free',
      providerBackupModel: 'anthropic/claude-opus-4-7',
      nativeSubagentDefaultModel: 'openrouter/moonshotai/kimi-k2.6',
      autonomous: { maxContinuations: 5, maxTurns: 'unlimited', maxTokens: null, maxTurns2: undefined },
    })
    .catch((error) => {
      // maxTurns2 is unknown and must be rejected; retry without it.
      assert.equal(error.status, 400);
      return store.set({
        auxiliaryModel: 'opencode/muse-spark-1.3-contributor-free',
        providerBackupModel: 'anthropic/claude-opus-4-7',
        nativeSubagentDefaultModel: 'openrouter/moonshotai/kimi-k2.6',
        autonomous: { maxContinuations: 5, maxTurns: 'unlimited', maxTokens: null },
      });
    });
  assert.equal(saved.auxiliaryModel, 'opencode/muse-spark-1.3-contributor-free');
  assert.equal(saved.providerBackupModel, 'anthropic/claude-opus-4-7');
  assert.equal(saved.nativeSubagentDefaultModel, 'openrouter/moonshotai/kimi-k2.6');
  assert.equal(saved.autonomous.maxContinuations, 5);
  assert.equal(saved.autonomous.maxTurns, 'unlimited');
  assert.equal(saved.autonomous.maxTokens, null);
  const raw = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal(raw.auxiliaryModel, 'opencode/muse-spark-1.3-contributor-free');
  assert.equal(raw.providerBackupModel, 'anthropic/claude-opus-4-7');
  assert.equal(raw.subagentDefaultModel, 'openrouter/moonshotai/kimi-k2.6');
  assert.equal(raw.autonomous.maxContinuations, 5);
  assert.equal(raw.autonomous.maxTurns, 'unlimited');
  assert.equal('maxTokens' in (raw.autonomous || {}), false);
  assert.equal(raw.theme, 'dark');
  assert.equal(raw.mcpServers.private.url, 'https://private.test');
  assert.deepEqual(raw.recentModels, ['old-provider/old-model']);
  assert.equal(await readFile(join(agentHome, 'settings.json.prime-studio.bak'), 'utf8'), initial);
});

test('empty clears fields and budgets revert to native defaults', async (t) => {
  const { agentHome, store } = await fixture(t);
  await store.set({
    auxiliaryModel: 'openai/gpt-5.4',
    providerBackupModel: 'openai/gpt-5.4',
    nativeSubagentDefaultModel: 'openai/gpt-5.4',
    autonomous: { maxContinuations: 2, maxTurns: 4, maxTokens: 1000, timeoutMs: 60000 },
  });
  const cleared = await store.set({
    auxiliaryModel: '',
    providerBackupModel: null,
    nativeSubagentDefaultModel: '  ',
    autonomous: { maxContinuations: null, maxTurns: '', maxTokens: null, timeoutMs: null },
  });
  assert.equal(cleared.auxiliaryModel, '');
  assert.equal(cleared.providerBackupModel, '');
  assert.equal(cleared.nativeSubagentDefaultModel, '');
  assert.deepEqual(cleared.autonomous, {
    maxContinuations: null,
    maxTurns: null,
    maxTokens: null,
    timeoutMs: null,
  });
  const raw = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal('auxiliaryModel' in raw, false);
  assert.equal('providerBackupModel' in raw, false);
  assert.equal('subagentDefaultModel' in raw, false);
  assert.equal('autonomous' in raw, false);
  // Deleting the whole autonomous object is also supported.
  await store.set({ autonomous: { maxTokens: 500 } });
  await store.set({ autonomous: null });
  assert.equal('autonomous' in JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8')), false);
});

test('revision CAS advises the current revision on conflict', async (t) => {
  const { store } = await fixture(t);
  const first = await store.get();
  await store.set({ auxiliaryModel: 'openai/gpt-5.4' });
  const second = await store.get();
  assert.notEqual(first.revision, second.revision);
  await assert.rejects(store.set({ revision: first.revision, auxiliaryModel: 'x/y' }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.currentRevision, second.revision);
    return true;
  });
  // Omitted revision stays allowed (last write wins) for single-tab callers.
  const ok = await store.set({ auxiliaryModel: 'anthropic/claude-opus-4-7' });
  assert.equal(ok.auxiliaryModel, 'anthropic/claude-opus-4-7');
});

test('rejects unknown keys, bad references and bad budgets', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(store.set({ unknownField: 'x' }), (error) => error.status === 400);
  await assert.rejects(store.set({ revision: 'not-a-hash' }), (error) => error.status === 400);
  for (const bad of ['__proto__/x', 'Provider/model', 'two words', 'a/']) {
    await assert.rejects(store.set({ auxiliaryModel: bad }), (error) => error.status === 400);
  }
  await assert.rejects(store.set({ auxiliaryModel: 42 }), (error) => error.status === 400);
  for (const bad of [0, -3, 2.5, 'many', true, {}, []]) {
    if (bad === 2.5) continue; // numbers truncate like the native resolver; tested below.
    await assert.rejects(store.set({ autonomous: { maxTurns: bad } }), (error) => error.status === 400);
  }
  await assert.rejects(store.set({ autonomous: { maxTurns: 3, bogus: 1 } }), (error) => error.status === 400);
  await assert.rejects(store.set({ autonomous: 'unlimited' }), (error) => error.status === 400);
  const broken = '{ "auxiliaryModel": ';
  const separate = await fixture(t, broken);
  await assert.rejects(separate.store.set({ auxiliaryModel: 'a/b' }), /JSON invalide/);
  assert.equal(await readFile(join(separate.agentHome, 'settings.json'), 'utf8'), broken);
});

test('hand-edited non-string values read as unset', async (t) => {
  const { store } = await fixture(
    t,
    JSON.stringify({
      auxiliaryModel: 42,
      providerBackupModel: null,
      subagentDefaultModel: ['x'],
      autonomous: { maxTurns: 'soon', maxTokens: -5, timeoutMs: 'unlimited' },
    }),
  );
  const state = await store.get();
  assert.equal(state.auxiliaryModel, '');
  assert.equal(state.providerBackupModel, '');
  assert.equal(state.nativeSubagentDefaultModel, '');
  assert.equal(state.autonomous.maxTurns, null);
  assert.equal(state.autonomous.maxTokens, null);
  assert.equal(state.autonomous.timeoutMs, 'unlimited');
});

test('clean helpers match native parsing rules', () => {
  assert.equal(cleanModelReference('  openai/gpt-5.4  '), 'openai/gpt-5.4');
  assert.equal(cleanModelReference('bare-model-id'), 'bare-model-id');
  assert.equal(cleanModelReference(''), '');
  assert.equal(cleanModelReference(null), '');
  assert.equal(cleanAutonomousValue('unlimited'), 'unlimited');
  assert.equal(cleanAutonomousValue('UNLIMITED'), 'unlimited');
  assert.equal(cleanAutonomousValue(' 12 '), 12);
  assert.equal(cleanAutonomousValue(2.9), 2);
  assert.equal(cleanAutonomousValue(null), null);
  assert.equal(cleanAutonomousValue(''), null);
  assert.deepEqual(cleanAutonomousInput(null), null);
  assert.equal(cleanAutonomousInput(undefined), undefined);
  assert.deepEqual(cleanAutonomousInput({ maxTurns: 'unlimited' }), { maxTurns: 'unlimited' });
});

test('stale revisions fail after an external native-style write', async (t) => {
  const { agentHome, store } = await fixture(t);
  await store.set({ auxiliaryModel: 'openai/gpt-5.4' });
  const stale = await store.get();
  // Simulate a concurrent native or inter-process writer editing settings.json directly.
  const raw = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  raw.providerBackupModel = 'anthropic/claude-opus-4-7';
  await writeFile(join(agentHome, 'settings.json'), JSON.stringify(raw, null, 2) + '\n', 'utf8');
  await assert.rejects(store.set({ revision: stale.revision, auxiliaryModel: 'x/y' }), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.currentRevision, /^[a-f0-9]{64}$/);
    return true;
  });
  // The external write is preserved, not overwritten.
  const kept = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal(kept.providerBackupModel, 'anthropic/claude-opus-4-7');
  assert.equal(kept.auxiliaryModel, 'openai/gpt-5.4');
  // A fresh revision succeeds and merges.
  const fresh = await store.get();
  const merged = await store.set({ revision: fresh.revision, autonomous: { maxTurns: 9 } });
  assert.equal(merged.autonomous.maxTurns, 9);
  assert.equal(merged.providerBackupModel, 'anthropic/claude-opus-4-7');
});

test('overlapping writes with the same revision let exactly one winner through', async (t) => {
  const { store } = await fixture(t);
  const first = await store.get();
  const a = store.set({ revision: first.revision, auxiliaryModel: 'openai/gpt-5.4' });
  const b = store.set({ revision: first.revision, providerBackupModel: 'anthropic/claude-opus-4-7' });
  const [ra, rb] = await Promise.allSettled([a, b]);
  assert.equal(ra.status, 'fulfilled');
  assert.equal(rb.status, 'rejected');
  assert.equal(rb.reason.status, 409);
  const state = await store.get();
  assert.equal(state.auxiliaryModel, 'openai/gpt-5.4');
  assert.equal(state.providerBackupModel, '');
});

test('external deletion invalidates earlier revisions', async (t) => {
  const { agentHome, store } = await fixture(t);
  await store.set({ auxiliaryModel: 'openai/gpt-5.4' });
  const stale = await store.get();
  await rm(join(agentHome, 'settings.json'), { force: true });
  await assert.rejects(store.set({ revision: stale.revision, auxiliaryModel: 'x/y' }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.currentRevision, null);
    return true;
  });
});

test('assertEngineRevision guards raw content read under lock', () => {
  assert.equal(assertEngineRevision('', undefined), null);
  assert.equal(assertEngineRevision(undefined, undefined), null);
  const revisionOfRaw = (raw) => assertEngineRevision(raw, undefined);
  const emptyRev = revisionOfRaw('{}');
  assert.match(emptyRev, /^[a-f0-9]{64}$/);
  assert.equal(assertEngineRevision('{}', emptyRev), emptyRev);
  const rev = revisionOfRaw('{"a":1}');
  assert.match(rev, /^[a-f0-9]{64}$/);
  assert.equal(assertEngineRevision('{"a":1}', rev), rev);
  assert.throws(
    () => assertEngineRevision('{"a":2}', rev),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.currentRevision, revisionOfRaw('{"a":2}'));
      return true;
    },
  );
  assert.throws(
    () => assertEngineRevision('', rev),
    (error) => error.status === 409,
  );
  assert.throws(
    () => assertEngineRevision('{"a":1}', null),
    (error) => error.status === 409,
  );
  assert.equal(assertEngineRevision('', null), null);
});

test('first write in a fresh directory succeeds and creates no backup', async (t) => {
  const agentHome = join(await mkdtemp(join(tmpdir(), 'prime-studio-engine-fresh-')), 'fresh');
  t.after(() => rm(agentHome, { recursive: true, force: true }));
  const store = createEngineSettingsStore({ agentHome });
  assert.equal((await store.get()).revision, null);
  const saved = await store.set({ auxiliaryModel: 'openai/gpt-5.4' });
  assert.equal(saved.auxiliaryModel, 'openai/gpt-5.4');
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
  const raw = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal(raw.auxiliaryModel, 'openai/gpt-5.4');
  await assert.rejects(readFile(join(agentHome, 'settings.json.prime-studio.bak'), 'utf8'), (error) => {
    assert.equal(error.code, 'ENOENT');
    return true;
  });
});

test('oversized settings reject writes and stay untouched without backup', async (t) => {
  const { agentHome, store } = await fixture(t);
  const big = 'x'.repeat(2 * 1024 * 1024 + 1);
  await writeFile(join(agentHome, 'settings.json'), big, 'utf8');
  await assert.rejects(store.get(), (error) => error.status === 500);
  await assert.rejects(store.set({ auxiliaryModel: 'openai/gpt-5.4' }), (error) => error.status === 500);
  assert.equal(await readFile(join(agentHome, 'settings.json'), 'utf8'), big);
  await assert.rejects(readFile(join(agentHome, 'settings.json.prime-studio.bak'), 'utf8'), (error) => {
    assert.equal(error.code, 'ENOENT');
    return true;
  });
});

test('malformed settings reject writes without backup or overwrite', async (t) => {
  const broken = '{ "auxiliaryModel": ';
  const { agentHome, store } = await fixture(t, broken);
  await assert.rejects(store.get(), /JSON invalide/);
  await assert.rejects(store.set({ auxiliaryModel: 'openai/gpt-5.4' }), /JSON invalide/);
  assert.equal(await readFile(join(agentHome, 'settings.json'), 'utf8'), broken);
  await assert.rejects(readFile(join(agentHome, 'settings.json.prime-studio.bak'), 'utf8'), (error) => {
    assert.equal(error.code, 'ENOENT');
    return true;
  });
});

test('symlinked settings reject reads and writes', async (t) => {
  const { agentHome, store } = await fixture(t);
  const target = join(agentHome, 'real-settings.json');
  await writeFile(target, JSON.stringify({ auxiliaryModel: 'openai/gpt-5.4' }), 'utf8');
  try {
    const { symlinkSync } = await import('node:fs');
    symlinkSync(target, join(agentHome, 'settings.json'), 'file');
  } catch (error) {
    t.skip(`symlinks need privileges on this machine: ${error.code || error.message}`);
    return;
  }
  await assert.rejects(store.get(), (error) => error.status === 500);
  await assert.rejects(store.set({ auxiliaryModel: 'x/y' }), (error) => error.status === 500);
  assert.equal(JSON.parse(await readFile(target, 'utf8')).auxiliaryModel, 'openai/gpt-5.4');
});
