import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../public/inspector.js', import.meta.url), 'utf8');
function body(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} exists in the inspector`);
  return source.slice(start, end);
}

test('quota dispatch stays gated; hidden changes are fetched on reveal', () => {
  let visible = false;
  const calls = [];
  const ctx = {
    current: { enabled: true, online: true, mainModel: 'provider/main', cwd: '/one' },
    document: { hidden: false },
    unitVisible: (key) => key === 'session' && visible,
    mainModelId: () => ctx.current.mainModel,
    renderQuota: () => calls.push(ctx.current.cwd),
  };
  vm.runInNewContext(
    `let lastQuotaProbeKey = ''; ${body('  function requestQuota(', '  function ensureSessionExtras(')}; globalThis.probe = requestQuota;`,
    ctx,
  );
  ctx.probe(true);
  assert.equal(calls.length, 0, 'force cannot fetch a hidden session unit');
  visible = true;
  for (const [object, key] of [
    [ctx.current, 'enabled'],
    [ctx.current, 'online'],
  ]) {
    object[key] = false;
    ctx.probe(true);
    assert.equal(calls.length, 0, `${key} still gates forced probes`);
    object[key] = true;
  }
  ctx.document.hidden = true;
  ctx.probe(true);
  assert.equal(calls.length, 0, 'background documents stay quiet');
  ctx.document.hidden = false;
  ctx.probe();
  ctx.probe();
  assert.deepEqual(calls, ['/one'], 'ordinary updates deduplicate the same key');
  ctx.probe(true);
  assert.deepEqual(calls, ['/one', '/one'], 'metadata refresh can bypass only key deduplication');
  visible = false;
  ctx.current.cwd = '/two';
  ctx.probe(true);
  visible = true;
  ctx.probe();
  assert.deepEqual(calls, ['/one', '/one', '/two'], 'hidden probes never consume the new context key');
});

test('agent refresh requests a metadata recheck for the unchanged context', async () => {
  const probes = [];
  const ctx = {
    current: { enabled: true, cwd: '/one', sessionId: 'session' },
    pending: new Set(),
    Date,
    bindText: () => {},
    $: () => ({}),
    tr: (value) => value,
    request: async () => ({}),
    query: () => '',
    renderAgents: () => {},
    syncGitBar: () => {},
    showUsage: () => {},
    renderContext: () => {},
    requestQuota: (force) => probes.push(force),
  };
  vm.runInNewContext(
    `let agentsAt = 0, agentData = null; ${body('  async function loadAgents(', '  function setTab(')}; globalThis.load = loadAgents;`,
    ctx,
  );
  await ctx.load();
  await ctx.load(true);
  assert.deepEqual(probes, [true, true]);
});

test('forced probes retain the defaults and provider linkage metadata TTLs', async () => {
  let now = 100000;
  const calls = [];
  const ctx = {
    Date: { now: () => now },
    URLSearchParams,
    api: async (url) => {
      calls.push(url);
      return url.startsWith('/api/project-subagent-defaults')
        ? { effective: { model: `provider/sub-${calls.length}` } }
        : { linked: true, revision: 'a'.repeat(64) };
    },
  };
  vm.runInNewContext(
    `let subagentCache = {}, providerCache = {};
    ${body('  async function effectiveSubagentModel(', '  function quotaDate(')}
    globalThis.defaults = effectiveSubagentModel; globalThis.link = codexEntry;`,
    ctx,
  );
  const first = await ctx.defaults('/one');
  await ctx.link('openai-codex');
  now += 14999;
  assert.equal(await ctx.defaults('/one'), first);
  await ctx.link('openai-codex');
  assert.equal(calls.length, 2);
  now += 2;
  assert.notEqual(await ctx.defaults('/one'), first);
  await ctx.link('openai-codex');
  assert.equal(calls.length, 3, 'defaults expire after 15 seconds, provider linkage stays cached');
  now += 15000;
  await ctx.link('openai-codex');
  assert.equal(calls.length, 4, 'provider linkage expires after 30 seconds');
});
