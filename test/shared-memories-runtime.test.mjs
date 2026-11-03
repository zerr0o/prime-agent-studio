import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  NO_SHARED_MEMORIES_FLAG,
  SHARED_MEMORIES_ENTRY,
  SHARED_MEMORIES_FLAG,
  constructionSeed,
  filterContextMessagesForSharedMemories,
  filterHarnessStateForSharedMemories,
  flagValuesToSharedMemories,
  normalizeSharedMemories,
  readSharedMemoriesEntry,
  readSharedMemoriesPolicy,
  resolveSharedMemories,
  resolveSharedMemoriesForContext,
  seedFromConfig,
  stripGlobalHarnessState,
  syncSharedMemoriesEntry,
  withSharedMemoriesConfig,
  transformAgentSession,
  transformAgentSessionRuntime,
  transformDaemonMode,
  transformHarnessDigestMessage,
} from '../runtime/shared-memories.mjs';

// Focused unit tests for the native per-conversation sharedMemories adapter
// (default false). Synthetic fixtures only: no provider, no real user data.

function branchManager(entries) {
  return { getBranch: () => entries };
}

test('normalizeSharedMemories is strict: only true enables', () => {
  assert.equal(normalizeSharedMemories(true), true);
  for (const v of [false, undefined, null, 0, 1, 'true', 'false', {}, []]) {
    assert.equal(normalizeSharedMemories(v), false, `expected false for ${String(v)}`);
  }
});

test('flagValuesToSharedMemories reads Map and object carriers, no-flag wins', () => {
  assert.equal(flagValuesToSharedMemories(new Map([[SHARED_MEMORIES_FLAG, true]])), true);
  assert.equal(flagValuesToSharedMemories({ [SHARED_MEMORIES_FLAG]: true }), true);
  assert.equal(flagValuesToSharedMemories(new Map([[NO_SHARED_MEMORIES_FLAG, true]])), false);
  assert.equal(flagValuesToSharedMemories({ [NO_SHARED_MEMORIES_FLAG]: true }), false);
  assert.equal(
    flagValuesToSharedMemories({ [SHARED_MEMORIES_FLAG]: true, [NO_SHARED_MEMORIES_FLAG]: true }),
    false,
  );
  assert.equal(flagValuesToSharedMemories(new Map()), undefined);
  assert.equal(flagValuesToSharedMemories({}), undefined);
  assert.equal(flagValuesToSharedMemories(undefined), undefined);
  assert.equal(flagValuesToSharedMemories({ [SHARED_MEMORIES_FLAG]: 'true' }), undefined);
});

test('seedFromConfig prefers first-class option, then flags, else undefined', () => {
  assert.equal(seedFromConfig({ sharedMemories: true }), true);
  assert.equal(seedFromConfig({ sharedMemories: false }), false);
  assert.equal(
    seedFromConfig({ sharedMemories: false, extensionFlagValues: { [SHARED_MEMORIES_FLAG]: true } }),
    false,
  );
  assert.equal(seedFromConfig({ extensionFlagValues: { [SHARED_MEMORIES_FLAG]: true } }), true);
  assert.equal(seedFromConfig({ extensionFlagValues: { [NO_SHARED_MEMORIES_FLAG]: true } }), false);
  assert.equal(seedFromConfig({ extensionFlagValues: {} }), undefined);
  assert.equal(seedFromConfig({}), undefined);
  assert.equal(seedFromConfig(null), undefined);
});

test('constructionSeed never consults the persisted entry (explicit wins)', () => {
  const entryTrue = branchManager([
    { type: 'custom', customType: SHARED_MEMORIES_ENTRY, data: { sharedMemories: true } },
  ]);
  const flagsOff = {
    getExtensions: () => ({ runtime: { flagValues: new Map([[NO_SHARED_MEMORIES_FLAG, true]]) } }),
  };
  assert.deepEqual(constructionSeed({ sharedMemories: true }, flagsOff), { value: true, explicit: true });
  assert.deepEqual(constructionSeed({}, flagsOff), { value: false, explicit: true });
  assert.deepEqual(constructionSeed({ extensionFlagValues: { [SHARED_MEMORIES_FLAG]: true } }, null), {
    value: false,
    explicit: false,
  });
});

test('explicit construction seed overrides a stale persisted true', () => {
  const entryTrue = branchManager([
    { type: 'custom', customType: SHARED_MEMORIES_ENTRY, data: { sharedMemories: true } },
  ]);
  const flagsOffLoader = {
    getExtensions: () => ({ runtime: { flagValues: new Map([[NO_SHARED_MEMORIES_FLAG, true]]) } }),
  };
  const seed = constructionSeed({}, flagsOffLoader);
  assert.deepEqual(seed, { value: false, explicit: true });
  const calls = [];
  const sm = { getBranch: entryTrue.getBranch, appendCustomEntry: (...a) => calls.push(a) };
  assert.equal(
    resolveSharedMemories({ sessionManager: sm, seed: seed.value, explicit: seed.explicit }),
    false,
  );
  assert.deepEqual(calls, []);
});

test('legacy sessions without flags fall back to the persisted entry', () => {
  const sm = branchManager([
    { type: 'custom', customType: SHARED_MEMORIES_ENTRY, data: { sharedMemories: true } },
  ]);
  assert.equal(resolveSharedMemories({ sessionManager: sm, seed: false, explicit: false }), true);
  assert.equal(
    resolveSharedMemories({ sessionManager: branchManager([]), seed: false, explicit: false }),
    false,
  );
});

test('malformed latest entry fails closed to false, never resurrects older true', () => {
  const sm = branchManager([
    { type: 'custom', customType: SHARED_MEMORIES_ENTRY, data: { sharedMemories: true } },
    { type: 'custom', customType: SHARED_MEMORIES_ENTRY, data: { sharedMemories: 'yes' } },
  ]);
  assert.equal(readSharedMemoriesEntry(sm), false);
  assert.equal(resolveSharedMemories({ sessionManager: sm, seed: true, explicit: false }), false);
  assert.equal(readSharedMemoriesPolicy(sm), false);
});

test('readSharedMemoriesPolicy is strict bool: live getter, then entry, then false', () => {
  assert.equal(readSharedMemoriesPolicy(null), false);
  assert.equal(readSharedMemoriesPolicy(branchManager([])), false);
  const withLive = { getBranch: () => [], getStudioSharedMemories: () => true };
  assert.equal(readSharedMemoriesPolicy(withLive), true);
  const liveOffEntryOn = {
    getBranch: () => [{ type: 'custom', customType: SHARED_MEMORIES_ENTRY, data: { sharedMemories: true } }],
    getStudioSharedMemories: () => false,
  };
  assert.equal(readSharedMemoriesPolicy(liveOffEntryOn), false);
  const entryOn = {
    getBranch: () => [{ type: 'custom', customType: SHARED_MEMORIES_ENTRY, data: { sharedMemories: true } }],
  };
  assert.equal(readSharedMemoriesPolicy(entryOn), true);
});

test('resolveSharedMemoriesForContext prefers launch flags over stale entry', () => {
  const entryTrue = {
    getBranch: () => [{ type: 'custom', customType: SHARED_MEMORIES_ENTRY, data: { sharedMemories: true } }],
  };
  const piOff = { getFlag: (name) => (name === NO_SHARED_MEMORIES_FLAG ? true : undefined) };
  assert.equal(resolveSharedMemoriesForContext(piOff, { sessionManager: entryTrue }), false);
  const piOn = { getFlag: (name) => (name === SHARED_MEMORIES_FLAG ? true : undefined) };
  assert.equal(resolveSharedMemoriesForContext(piOn, { sessionManager: branchManager([]) }), true);
  assert.equal(resolveSharedMemoriesForContext(null, { sessionManager: entryTrue }), true);
  assert.equal(resolveSharedMemoriesForContext(null, { sessionManager: branchManager([]) }), false);
});

test('syncSharedMemoriesEntry writes only on change and propagates IO failures', () => {
  const calls = [];
  const sm = {
    getBranch: () => [{ type: 'custom', customType: SHARED_MEMORIES_ENTRY, data: { sharedMemories: true } }],
    appendCustomEntry: (...a) => calls.push(a),
  };
  assert.equal(syncSharedMemoriesEntry(sm, true), true);
  assert.deepEqual(calls, []);
  assert.equal(syncSharedMemoriesEntry(sm, false), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], SHARED_MEMORIES_ENTRY);
  assert.equal(calls[0][1].sharedMemories, false);
  const failing = {
    getBranch: () => [],
    appendCustomEntry: () => {
      throw new Error('disk gone');
    },
  };
  assert.throws(() => syncSharedMemoriesEntry(failing, true), /disk gone/);
  assert.equal(syncSharedMemoriesEntry(sm, undefined), true);
});

test('stripGlobalHarnessState drops global memories/refinements, keeps prompt/skills/subagents', () => {
  const prompt = { p: { scope: 'global', text: 'rule' } };
  const skill = { s: { scope: 'global' } };
  const subagent = { a: { scope: 'global' } };
  const state = {
    schema: 1,
    entries: { prompt, memory: { m: { scope: 'global' } }, skill, subagent },
    refinements: [{ id: 'r' }],
  };
  const stripped = stripGlobalHarnessState(state);
  assert.deepEqual(stripped.entries.memory, {});
  assert.deepEqual(stripped.refinements, []);
  assert.equal(stripped.entries.prompt, prompt);
  assert.equal(stripped.entries.skill, skill);
  assert.equal(stripped.entries.subagent, subagent);
  assert.equal(stripped.schema, 1);
  assert.equal(stripGlobalHarnessState(null), null);
});

test('filterHarnessStateForSharedMemories keeps globals except memory/refinements', () => {
  const state = {
    schema: 1,
    entries: {
      prompt: { p: { scope: 'global' } },
      memory: { g: { scope: 'global' }, l: { scope: 'local' }, u: {} },
      skill: { s: { scope: 'global' } },
      subagent: { a: { scope: 'global' } },
    },
    refinements: [{ id: 'g', scope: 'global' }, { id: 'l', scope: 'local' }, { id: 'u' }],
  };
  assert.equal(filterHarnessStateForSharedMemories(state, true), state);
  const out = filterHarnessStateForSharedMemories(state, false);
  assert.deepEqual(out.entries.prompt, { p: { scope: 'global' } });
  assert.deepEqual(out.entries.skill, { s: { scope: 'global' } });
  assert.deepEqual(out.entries.subagent, { a: { scope: 'global' } });
  assert.deepEqual(Object.keys(out.entries.memory).sort(), ['l', 'u']);
  assert.deepEqual(
    out.refinements.map((r) => r.id),
    ['l', 'u'],
  );
});

test('filterContextMessagesForSharedMemories touches typed records only, never text', () => {
  const userWithTag = { role: 'user', content: [{ type: 'text', text: 'mention [harness-digest] here' }] };
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'ok' }] };
  const freshDigest = {
    role: 'custom',
    customType: 'harness_digest',
    content: 'x',
    details: { sharedMemories: false },
  };
  const staleDigest = {
    role: 'custom',
    customType: 'harness_digest',
    content: 'global secrets',
    details: {},
  };
  const compaction = {
    role: 'compactionSummary',
    summary: 'session work',
    harnessDigest: 'global',
    harnessStateFingerprint: 'f',
  };
  const globalNotice = {
    role: 'custom',
    customType: 'refinement_notice',
    content: 'n',
    details: { scope: 'global' },
  };
  const localNotice = {
    role: 'custom',
    customType: 'refinement_notice',
    content: 'n',
    details: { scope: 'local' },
  };
  const messages = [userWithTag, assistant, freshDigest, staleDigest, compaction, globalNotice, localNotice];
  const kept = filterContextMessagesForSharedMemories(messages, true);
  assert.equal(kept.messages, messages);
  assert.equal(kept.changed, false);
  const out = filterContextMessagesForSharedMemories(messages, false);
  assert.equal(out.changed, true);
  assert.deepEqual(
    out.messages.map((m) => m.role + ':' + (m.customType || '')),
    ['user:', 'assistant:', 'custom:harness_digest', 'compactionSummary:', 'custom:refinement_notice'],
  );
  assert.equal(out.messages[0], userWithTag);
  assert.equal(out.messages[1], assistant);
  assert.equal(out.messages[2], freshDigest);
  assert.equal(out.messages[3].summary, 'session work');
  assert.equal(out.messages[3].harnessDigest, undefined);
  assert.equal(out.messages[3].harnessStateFingerprint, undefined);
  assert.equal(out.messages[4], localNotice);
  assert.equal(filterContextMessagesForSharedMemories(null, false).changed, false);
});

test('withSharedMemoriesConfig carries the live parent value, never invents one', () => {
  const base = { cwd: '/x', extensionFlagValues: { other: true } };
  const parentOn = { getStudioSharedMemories: () => true };
  const merged = withSharedMemoriesConfig(base, parentOn);
  assert.equal(merged.extensionFlagValues[SHARED_MEMORIES_FLAG], true);
  assert.equal('other' in merged.extensionFlagValues, true);
  assert.equal(merged.cwd, '/x');
  assert.equal(base.extensionFlagValues[SHARED_MEMORIES_FLAG], undefined);
  const parentOff = { getStudioSharedMemories: () => false };
  const mergedOff = withSharedMemoriesConfig(base, parentOff);
  assert.equal(mergedOff.extensionFlagValues[NO_SHARED_MEMORIES_FLAG], true);
  assert.equal(SHARED_MEMORIES_FLAG in mergedOff.extensionFlagValues, false);
  assert.equal(withSharedMemoriesConfig(base, {}), base);
  assert.equal(withSharedMemoriesConfig(base, null), base);
  assert.equal(withSharedMemoriesConfig(null, parentOn), null);
});

// --- transform fixtures (synthetic, both build styles) ---
const UNBUNDLED_AGENT = `    constructor(config) {
        this.sessionManager = config.sessionManager;
        this._rlmMaxDepthSource = resolvedRlmMaxDepth.source;
        this._foo = 1;
    }
    _loadMergedHarnessState() {
        const localHarnessStateDir = this._localHarnessStateDir();
        return mergeHarnessStates(loadHarnessState(getGlobalHarnessStateDir(), "global"), localHarnessStateDir ? loadHarnessState(localHarnessStateDir, "local") : undefined);
    }
    _loadRefinementHistory() {
        return mergeRefinementHistory(loadGlobalRefinementHistory(getGlobalHarnessStateDir()), getRefinementHistory(this.sessionManager.getEntries().filter((entry) => entry.type === "custom")));
    }
    _harnessDigestIsFresh(latest, freshDigest, freshFingerprint) {
        return latest.stateFingerprint !== undefined
            ? latest.stateFingerprint === freshFingerprint
            : latest.digest === freshDigest;
    }
    _latestContextHarnessDigestDetails() {
        for (const message of this.agent.state.messages) {
            const details = message.details;
            if (details?.digest !== undefined) {
                latest = {
                    timestamp: message.timestamp,
                    digest: details.digest,
                    stateFingerprint: details.stateFingerprint,
                };
            }
        }
    }
    async commit() {
        if (ok) {
            nextTurnMessages = [
                                createHarnessDigestMessage(digest, Date.now(), stateFingerprint),
                                ...nextTurnMessages,
                            ];
        }
        const message = createHarnessDigestMessage(digest, Date.now(), stateFingerprint);
    }
        const child = new AgentSession({
            agent: childAgent,
            cwd: this._cwd,
        });
`;
const BUNDLED_AGENT = UNBUNDLED_AGENT.replaceAll('        ', '  ')
  .replaceAll('localHarnessStateDir, "local") : undefined', 'localHarnessStateDir, "local") : void 0')
  .replaceAll('const child = new AgentSession({', 'const child = new _AgentSession({');

test('transformAgentSession patches both build styles exactly once and is idempotent', () => {
  for (const fixture of [UNBUNDLED_AGENT, BUNDLED_AGENT]) {
    const once = transformAgentSession(fixture, { required: true });
    assert.equal(once.changed, true);
    for (const snippet of [
      'this._studioSharedMemories = StudioSharedMemories.constructionSeed(config, this._resourceLoader);',
      'this._studioSharedMemoriesExplicit = this._studioSharedMemories.explicit === true;',
      'this._studioSharedMemories = this._studioSharedMemories.value === true;',
      'this.sessionManager.getStudioSharedMemories = () => this.getStudioSharedMemories();',
      'StudioSharedMemories.syncSharedMemoriesEntry(this.sessionManager,',
      'getStudioSharedMemories() {',
      'setStudioSharedMemories(value) {',
      'StudioSharedMemories.filterHarnessStateForSharedMemories',
      'StudioSharedMemories.keepLocalRefinements(',
      'if (!StudioSharedMemories.digestMatchesPolicy(latest, this.getStudioSharedMemories())) return false;',
      'sharedMemories: details.sharedMemories',
      'StudioSharedMemories.stripGlobalHarnessState(',
      'sharedMemoriesLocal',
      'createHarnessDigestMessage(digest, Date.now(), stateFingerprint, this.getStudioSharedMemories())',
      'sharedMemories: this.getStudioSharedMemories(),',
    ]) {
      assert.ok(once.source.includes(snippet), `missing ${snippet}`);
    }
    // Mode check must precede the fingerprint comparison (freshness gate order).
    assert.ok(
      once.source.indexOf('digestMatchesPolicy(latest, this.getStudioSharedMemories())') <
        once.source.indexOf('latest.stateFingerprint', once.source.indexOf('_harnessDigestIsFresh')),
      'mode check must precede the fingerprint comparison',
    );
    // Original assignment preserved (blocker: must re-emit, not replace).
    assert.ok(once.source.includes('this._rlmMaxDepthSource = resolvedRlmMaxDepth.source;'));
    // Original merge body replaced by gated version, not duplicated.
    assert.equal(once.source.split('_loadMergedHarnessState() {').length - 1, 1);
    const twice = transformAgentSession(once.source, { required: true });
    assert.equal(twice.changed, false);
    assert.equal(twice.source, once.source);
  }
});

test('transformAgentSession throws on drift when required', () => {
  assert.throws(() => transformAgentSession('nothing here', { required: true }), /gate missing/);
  const broken = UNBUNDLED_AGENT.replace('_loadMergedHarnessState() {', '_loadMergedHarnessStateV2() {');
  assert.throws(() => transformAgentSession(broken, { required: true }), /gate missing/);
});

test('transformHarnessDigestMessage adds the opt-in marker param', () => {
  const src = `export function createHarnessDigestMessage(digest, timestamp = Date.now(), stateFingerprint) {
    return {
        details: { digest, ...(stateFingerprint ? { stateFingerprint } : {}) },
    };
}`;
  const once = transformHarnessDigestMessage(src, { required: true });
  assert.ok(once.source.includes('stateFingerprint, sharedMemories)'));
  assert.ok(once.source.includes('...(typeof sharedMemories === "boolean" ? { sharedMemories } : {})'));
  const twice = transformHarnessDigestMessage(once.source, { required: true });
  assert.equal(twice.changed, false);
});

test('transformAgentSessionRuntime and transformDaemonMode patch spawn and reuse', () => {
  const rt = `            sessionConfig: this.sessionConfig,
            ...rlmSubagentRuntimeSpec(options),`;
  const rtOut = transformAgentSessionRuntime(rt, { required: true });
  assert.ok(
    rtOut.source.includes(
      'StudioSharedMemories.withSharedMemoriesConfig(this.sessionConfig, options.parentSession)',
    ),
  );
  assert.equal(transformAgentSessionRuntime(rtOut.source, { required: true }).changed, false);
  const daemon = `    adoptClientEnv(state, env) {
        return;
    }
            this.adoptClientEnv(state, clientEnv);
            await this.rebindCronJobsToState(state);
            return state;
                this.adoptClientEnv(existing, clientEnv);
                await this.rebindCronJobsToState(existing);
                return existing;
                sessionConfig: parentState.runtime.runtimeConfig,
                sessionOptions: {
        try {
            const { status } = await this.acceptAgentSessionMessage(targetState, payload);
            return createAgentSessionMessageReceipt(payload, status);
        }`;
  const dOut = transformDaemonMode(daemon, { required: true });
  assert.ok(dOut.source.includes('refreshStudioSharedMemoriesPolicy(state, config)'));
  assert.ok(
    dOut.source.includes(
      'StudioSharedMemories.withSharedMemoriesConfig(parentState.runtime.runtimeConfig, parentState.runtime.session),',
    ),
  );
  assert.ok(
    dOut.source.includes(
      'throw new Error("Studio shared-memories adapter: session policy setter missing; update the adapter.");',
    ),
  );
  assert.ok(dOut.source.includes('refreshStudioSharedMemoriesForDelivery(targetState, options) {'));
  const acceptIdx = dOut.source.indexOf('acceptAgentSessionMessage(targetState, payload)');
  const refreshIdx = dOut.source.indexOf(
    'this.refreshStudioSharedMemoriesForDelivery(targetState, options);',
  );
  assert.ok(refreshIdx !== -1 && refreshIdx < acceptIdx, 'refresh must precede delivery');
  const dTwice = transformDaemonMode(dOut.source, { required: true });
  assert.equal(dTwice.changed, false);
  assert.equal(dTwice.source, dOut.source);
});

test('delivery refresh inherits the actual parent, never the sender (behavioral)', async () => {
  const sm = await import('../runtime/shared-memories.mjs');
  const branchOf = (value) => () =>
    value === undefined
      ? []
      : [{ type: 'custom', customType: 'studio.shared-memories', data: { sharedMemories: value } }];
  const makeSession = (live, entry) => ({
    _live: live,
    getStudioSharedMemories: function () {
      return this._live;
    },
    setStudioSharedMemories: function (v) {
      this._live = v === true;
      return this._live;
    },
    appendCustomEntry: () => {},
    getBranch: branchOf(entry),
  });
  // Old-ON child, resumed-OFF parent: stale true must become false.
  const parent = { activeSessionId: 'p', runtime: { session: makeSession(false, false) } };
  const child = {
    activeSessionId: 'c',
    runtime: { metadata: { kind: 'subagent', parentActiveSessionId: 'p' }, session: makeSession(true, true) },
  };
  const daemon = {
    sessions: new Map([
      ['p', parent],
      ['c', child],
    ]),
    agentMessageRelationship: () => {
      throw new Error('must not consult family when metadata resolves');
    },
  };
  assert.equal(sm.refreshDeliveryPolicy(daemon, child, {}), true);
  assert.equal(child.runtime.session._live, false);
  // Sibling sender with unrelated true must not leak into the child.
  const writes2 = [];
  const child2 = {
    activeSessionId: 'c2',
    runtime: { metadata: { kind: 'subagent', parentActiveSessionId: 'p' }, session: makeSession(true, true) },
  };
  const sibling = { activeSessionId: 's', runtime: { session: makeSession(true, true) } };
  const daemon2 = {
    sessions: new Map([
      ['p', parent],
      ['c2', child2],
      ['s', sibling],
    ]),
    agentMessageRelationship: (from, to) => (from === sibling && to === child2 ? 'sibling' : undefined),
  };
  child2.runtime.session.setStudioSharedMemories = function (v) {
    this._live = v === true;
    writes2.push(v);
    return this._live;
  };
  assert.equal(sm.refreshDeliveryPolicy(daemon2, child2, { fromState: sibling }), true);
  assert.equal(child2.runtime.session._live, false);
  assert.deepEqual(writes2, [false]);
  // Root targets keep their independent policy: setter never called.
  let rootCalled = false;
  const root = {
    activeSessionId: 'r',
    runtime: {
      metadata: { kind: 'root' },
      session: {
        setStudioSharedMemories: () => {
          rootCalled = true;
        },
      },
    },
  };
  assert.equal(sm.refreshDeliveryPolicy(daemon2, root, { fromState: sibling }), false);
  assert.equal(rootCalled, false);
  // Evicted parent with no sender: fail closed to false (never deliver unchanged stale true).
  const writes3 = [];
  const orphan = {
    activeSessionId: 'o',
    runtime: {
      metadata: { kind: 'subagent', parentActiveSessionId: 'gone' },
      session: makeSession(true, true),
    },
  };
  orphan.runtime.session.setStudioSharedMemories = function (v) {
    this._live = v === true;
    writes3.push(v);
    return this._live;
  };
  assert.equal(sm.refreshDeliveryPolicy(daemon2, orphan, {}), true);
  assert.equal(orphan.runtime.session._live, false);
  assert.deepEqual(writes3, [false]);
});

test('delivery refresh resolves sender-parent fallback and fails delivery loudly on error', async () => {
  const sm = await import('../runtime/shared-memories.mjs');
  // Metadata without a resident parent: sender-is-parent fallback applies.
  const parent = { activeSessionId: 'p', runtime: { session: { getStudioSharedMemories: () => false } } };
  const child = {
    activeSessionId: 'c',
    runtime: {
      metadata: { kind: 'subagent' },
      session: {
        setStudioSharedMemories(v) {
          this._live = v;
          return v;
        },
        _live: true,
      },
    },
  };
  const daemon = {
    sessions: new Map([['c', child]]),
    agentMessageRelationship: (from, to) => (from === parent && to === child ? 'parent' : undefined),
  };
  assert.equal(sm.refreshDeliveryPolicy(daemon, child, { fromState: parent }), true);
  assert.equal(child.runtime.session._live, false);
  // Unrelated sender is never authority: falls back to explicit false.
  const stranger = { activeSessionId: 'x', runtime: { session: { getStudioSharedMemories: () => true } } };
  const child3 = {
    activeSessionId: 'c3',
    runtime: {
      metadata: { kind: 'subagent' },
      session: {
        setStudioSharedMemories(v) {
          this._live = v;
          return v;
        },
        _live: true,
      },
    },
  };
  const daemon3 = {
    sessions: new Map([['c3', child3]]),
    agentMessageRelationship: () => 'sibling',
  };
  assert.equal(sm.refreshDeliveryPolicy(daemon3, child3, { fromState: stranger }), true);
  assert.equal(child3.runtime.session._live, false);
  // Setter failure propagates: delivery must be prevented, not silently kept.
  const badChild = {
    activeSessionId: 'b',
    runtime: {
      metadata: { kind: 'subagent', parentActiveSessionId: 'p' },
      session: {
        setStudioSharedMemories: () => {
          throw new Error('persist failed');
        },
      },
    },
  };
  const daemon2 = {
    sessions: new Map([
      ['p', parent],
      ['b', badChild],
    ]),
    agentMessageRelationship: () => 'parent',
  };
  assert.throws(() => sm.refreshDeliveryPolicy(daemon2, badChild, {}), /persist failed/);
  // Missing setter on a subagent target is an adapter mismatch: loud, not silent.
  const noSetter = {
    activeSessionId: 'n',
    runtime: { metadata: { kind: 'subagent', parentActiveSessionId: 'p' }, session: {} },
  };
  assert.throws(() => sm.refreshDeliveryPolicy(daemon2, noSetter, {}), /setter missing/);
});

test('digestMatchesPolicy is mode-sensitive (behavioral freshness table)', async () => {
  const sm = await import('../runtime/shared-memories.mjs');
  // Unmarked snapshots (pre-marker digests, compaction snapshots) never match.
  assert.equal(sm.digestMatchesPolicy(undefined, false), false);
  assert.equal(sm.digestMatchesPolicy(null, true), false);
  assert.equal(sm.digestMatchesPolicy({ digest: 'd' }, false), false);
  assert.equal(sm.digestMatchesPolicy({ sharedMemories: undefined }, true), false);
  // Marked snapshots match only the policy they were generated under.
  assert.equal(sm.digestMatchesPolicy({ sharedMemories: false }, false), true);
  assert.equal(sm.digestMatchesPolicy({ sharedMemories: true }, true), true);
  assert.equal(sm.digestMatchesPolicy({ sharedMemories: true }, false), false);
  assert.equal(sm.digestMatchesPolicy({ sharedMemories: false }, true), false);
});

// --- live native sources (when the installed engine is present) ---
function findEngineRoots() {
  const candidates = [
    process.env.PRIME_AGENT_ENGINE_DIR,
    'C:/Users/zerr0o/AppData/Local/com.primeagent.studio/engine/prime-agent/0.9.8-438660c3-42fa-4614-9934-9472d84dfb38/dist',
  ].filter(Boolean);
  return candidates.filter((dir) => {
    try {
      return existsSync(join(dir, 'core', 'agent-session.js'));
    } catch {
      return false;
    }
  });
}

for (const engineDir of findEngineRoots()) {
  test(`native sources patch cleanly and idempotently (${engineDir})`, async () => {
    const { readFile } = await import('node:fs/promises');
    const agent = await readFile(join(engineDir, 'core', 'agent-session.js'), 'utf8');
    const messages = await readFile(join(engineDir, 'core', 'messages.js'), 'utf8');
    const runtime = await readFile(join(engineDir, 'core', 'agent-session-runtime.js'), 'utf8');
    const daemon = await readFile(join(engineDir, 'modes', 'daemon', 'daemon-mode.js'), 'utf8');
    const a1 = transformAgentSession(agent, { required: true, url: 'agent-session.js' });
    const m1 = transformHarnessDigestMessage(messages, { required: true, url: 'messages.js' });
    const r1 = transformAgentSessionRuntime(runtime, { required: true, url: 'agent-session-runtime.js' });
    const d1 = transformDaemonMode(daemon, { required: true, url: 'daemon-mode.js' });
    for (const [name, once] of [
      ['agent', a1],
      ['messages', m1],
      ['runtime', r1],
      ['daemon', d1],
    ]) {
      assert.equal(once.changed, true, `${name} should change`);
    }
    assert.equal(transformAgentSession(a1.source, { required: true }).changed, false);
    assert.equal(transformHarnessDigestMessage(m1.source, { required: true }).changed, false);
    assert.equal(transformAgentSessionRuntime(r1.source, { required: true }).changed, false);
    assert.equal(transformDaemonMode(d1.source, { required: true }).changed, false);
    // Bundled cli-node chunks patch too when their gates match.
    for (const chunk of ['chunk-TN7ATWR6.js', 'chunk-YBYB35XU.js']) {
      const file = join(engineDir, 'bundle', chunk);
      if (!existsSync(file)) continue;
      const source = await readFile(file, 'utf8');
      const sets = [
        [transformAgentSession, '_loadMergedHarnessState() {'],
        [transformHarnessDigestMessage, 'createHarnessDigestMessage(digest,'],
        [transformAgentSessionRuntime, 'rlmSubagentRuntimeSpec(options)'],
        [transformDaemonMode, 'adoptClientEnv(state, env) {'],
      ];
      let out = source;
      let changedAny = false;
      for (const [fn, gate] of sets) {
        if (!out.includes(gate)) continue;
        const patched = fn(out, { required: true, url: chunk });
        out = patched.source;
        changedAny = changedAny || patched.changed;
      }
      assert.equal(changedAny, true, `${chunk} should patch at least one set`);
    }
  });
}

test('studio-context-extension registers both flags and filters stale snapshots when off', async () => {
  const { default: studioContext } = await import('../runtime/studio-context-extension.mjs');
  const flags = new Map();
  const defaults = new Map();
  const handlers = new Map();
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerFlag: (name, opts) => {
      flags.set(name, opts);
      if (opts?.default !== undefined && !defaults.has(name)) defaults.set(name, opts.default);
    },
    getFlag: (name) => (flags.has(name) ? (defaults.has(name) ? defaults.get(name) : undefined) : undefined),
  };
  studioContext(pi);
  assert.equal(flags.get('shared-memories')?.type, 'boolean');
  assert.equal(flags.get('no-shared-memories')?.type, 'boolean');
  assert.equal(flags.get('shared-memories')?.default, false);
  const handler = handlers.get('context');
  assert.equal(typeof handler, 'function');
  const stale = { role: 'custom', customType: 'harness_digest', content: 'global', details: {} };
  const user = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
  // Flags absent (defaults false): policy off -> stale digest stripped, request-only.
  const filtered = handler(
    { messages: [user, stale] },
    { cwd: '/x', sessionManager: { getBranch: () => [] } },
  );
  assert.ok(filtered);
  assert.deepEqual(filtered.messages, [user]);
  assert.equal(stale.content, 'global');
  // Explicit on via flag: everything passes through untouched.
  defaults.set('shared-memories', true);
  const kept = handler({ messages: [user, stale] }, { cwd: '/x', sessionManager: { getBranch: () => [] } });
  assert.equal(kept, undefined);
});

test('keepLocalRefinements drops global session refinements; reviewer merge stays clean (behavioral)', async () => {
  const sm = await import('../runtime/shared-memories.mjs');
  // Mirror of the native mergeRefinementHistory byId semantics (native data
  // is clean records; the mirror skips malformed shapes it would choke on).
  const nativeMerge = (global, session) => {
    const clean = (list) => (Array.isArray(list) ? list : []).filter((r) => r && typeof r === 'object');
    const byId = new Map();
    for (const result of clean(global)) byId.set(result.id, result);
    for (const result of clean(session)) {
      const existing = byId.get(result.id);
      byId.set(result.id, result.scope || !existing?.scope ? result : { ...result, scope: existing.scope });
    }
    return [...byId.values()];
  };
  const sessionLocal = [
    { id: 'a', scope: 'local', summary: 'local work' },
    { id: 'g', scope: 'global', summary: 'GLOBAL SECRET' },
    { id: 'u', summary: 'no scope session record' },
    null,
    'junk',
  ];
  const kept = sm.keepLocalRefinements(sessionLocal);
  assert.deepEqual(
    kept.filter((r) => r && typeof r === 'object').map((r) => r.id),
    ['a', 'u'],
  );
  // Reviewer input when off: global file skipped, local filtered before merge.
  const reviewerInput = nativeMerge([], kept);
  const text = JSON.stringify(reviewerInput);
  assert.ok(!text.includes('GLOBAL SECRET'), 'global refinement must not reach the reviewer');
  assert.ok(text.includes('local work'), 'local refinement retained');
  assert.ok(text.includes('no scope session record'), 'scopeless session record retained');
  // True path keeps the native behavior (unfiltered locals merged with global).
  const reviewerOn = nativeMerge([{ id: 'gg', scope: 'global', summary: 'shared' }], sessionLocal);
  assert.ok(JSON.stringify(reviewerOn).includes('GLOBAL SECRET'));
  assert.equal(sm.keepLocalRefinements(null).length, 0);
});

test('resolveSharedMemoriesForContext prefers live getter over stale flags', async () => {
  const sm = await import('../runtime/shared-memories.mjs');
  const staleOn = { getFlag: (n) => (n === 'shared-memories' ? true : undefined) };
  const staleOff = { getFlag: (n) => (n === 'no-shared-memories' ? true : undefined) };
  const liveFalse = { sessionManager: { getBranch: () => [], getStudioSharedMemories: () => false } };
  const liveTrue = { sessionManager: { getBranch: () => [], getStudioSharedMemories: () => true } };
  assert.equal(sm.resolveSharedMemoriesForContext(staleOn, liveFalse), false);
  assert.equal(sm.resolveSharedMemoriesForContext(staleOff, liveTrue), true);
  const noLive = { sessionManager: { getBranch: () => [] } };
  assert.equal(sm.resolveSharedMemoriesForContext(staleOn, noLive), true);
  assert.equal(sm.resolveSharedMemoriesForContext(staleOff, noLive), false);
  const entryTrue = {
    sessionManager: {
      getBranch: () => [
        { type: 'custom', customType: 'studio.shared-memories', data: { sharedMemories: true } },
      ],
    },
  };
  assert.equal(sm.resolveSharedMemoriesForContext({}, entryTrue), true);
});

test('withSharedMemoriesConfig fails closed to explicit false on exceptions', async () => {
  const sm = await import('../runtime/shared-memories.mjs');
  const throwing = {
    getStudioSharedMemories: () => {
      throw new Error('boom');
    },
  };
  const base = { cwd: '/x', extensionFlagValues: { 'shared-memories': true } };
  const out = sm.withSharedMemoriesConfig(base, throwing);
  assert.equal(out.extensionFlagValues['no-shared-memories'], true);
  assert.equal('shared-memories' in out.extensionFlagValues, false);
  assert.equal(out.cwd, '/x');
  assert.equal(sm.withSharedMemoriesConfig(null, throwing), null);
});

test('filterCompactionPreparation filters both arrays when off, keeps ordinary records', async () => {
  const sm = await import('../runtime/shared-memories.mjs');
  const stale = { role: 'custom', customType: 'harness_digest', content: 'global', details: {} };
  const notice = {
    role: 'custom',
    customType: 'refinement_notice',
    content: 'n',
    details: { scope: 'global' },
  };
  const user = { role: 'user', content: [{ type: 'text', text: 'work' }] };
  const prep = {
    previousSummary: 'old',
    messagesToSummarize: [user, stale],
    turnPrefixMessages: [notice, user],
  };
  const r = sm.filterCompactionPreparation(prep, false);
  assert.equal(r.changed, true);
  assert.deepEqual(prep.messagesToSummarize, [user]);
  assert.deepEqual(prep.turnPrefixMessages, [user]);
  assert.equal(prep.previousSummary, 'old');
  assert.equal(stale.content, 'global');
  const prepOn = { messagesToSummarize: [stale], turnPrefixMessages: [notice] };
  assert.equal(sm.filterCompactionPreparation(prepOn, true).changed, false);
  assert.equal(prepOn.messagesToSummarize[0], stale);
  assert.equal(sm.filterCompactionPreparation(null, false).changed, false);
});

test('filterBranchSummaryEntries drops global notices/results only', async () => {
  const sm = await import('../runtime/shared-memories.mjs');
  const msg = { type: 'message', message: { role: 'user' } };
  const digest = { type: 'custom_message', customType: 'harness_digest', content: 'd', details: {} };
  const gNotice = {
    type: 'custom_message',
    customType: 'refinement_notice',
    content: 'n',
    details: { scope: 'global' },
  };
  const lNotice = {
    type: 'custom_message',
    customType: 'refinement_notice',
    content: 'n',
    details: { scope: 'local' },
  };
  const gResult = { type: 'custom', customType: 'prime-agent.refinement', data: { scope: 'global' } };
  const lResult = { type: 'custom', customType: 'prime-agent.refinement', data: { scope: 'local' } };
  const entries = [msg, digest, gNotice, lNotice, gResult, lResult];
  const out = sm.filterBranchSummaryEntries(entries, false);
  assert.equal(out.changed, true);
  assert.deepEqual(out.entries, [msg, digest, lNotice, lResult]);
  const kept = sm.filterBranchSummaryEntries(entries, true);
  assert.equal(kept.entries, entries);
  assert.equal(kept.changed, false);
});

test('extension compaction/tree hooks filter when off even with context gate disabled', async () => {
  const { default: studioContext } = await import('../runtime/studio-context-extension.mjs');
  const handlers = new Map();
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerFlag: () => {},
    getFlag: () => undefined,
  };
  studioContext(pi);
  const stale = { role: 'custom', customType: 'harness_digest', content: 'global', details: {} };
  const notice = {
    role: 'custom',
    customType: 'refinement_notice',
    content: 'n',
    details: { scope: 'global' },
  };
  const user = { role: 'user', content: [{ type: 'text', text: 'work' }] };
  // No PRIME_STUDIO_CODE_CONFIG in test env: context gate disabled, filter still applies.
  const prep = { previousSummary: 'old', messagesToSummarize: [user, stale], turnPrefixMessages: [notice] };
  handlers.get('session_before_compact')(
    { preparation: prep, signal: {} },
    { cwd: '/x', sessionManager: { getBranch: () => [] } },
  );
  assert.deepEqual(prep.messagesToSummarize, [user]);
  assert.deepEqual(prep.turnPrefixMessages, []);
  assert.equal(prep.previousSummary, 'old');
  const treePrep = {
    entriesToSummarize: [
      { type: 'message', message: { role: 'user' } },
      { type: 'custom_message', customType: 'refinement_notice', content: 'n', details: { scope: 'global' } },
    ],
  };
  handlers.get('session_before_tree')(
    { preparation: treePrep, signal: {} },
    { cwd: '/x', sessionManager: { getBranch: () => [] } },
  );
  assert.deepEqual(treePrep.entriesToSummarize, [{ type: 'message', message: { role: 'user' } }]);
});
