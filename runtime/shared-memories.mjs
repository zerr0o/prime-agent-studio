// Per-conversation shared-memory policy for the native Prime Agent runtime.
//
// Checkbox "Injecter les mémoires partagées" (default OFF / false):
// - false excludes GLOBAL memory entries and global refinement summaries from
//   the provider context, while preserving session/project context, global
//   prompt entries (user rules), installed skills, subagent specs and MCP.
// - true preserves the current native behavior (global + local merged).
//
// Transport (no daemon protocol change, no new settings store, no process.env):
// the Studio launcher passes one explicit bare CLI flag on every start,
// `--shared-memories` (= true) or `--no-shared-memories` (= false), which the
// native CLI folds into command.config.extensionFlagValues (per-session,
// first-request safe). studio-context-extension registers both flags so the
// native layer accepts them.
//
// Priority (explicit launch flags always override the persisted entry):
// construction and every per-event read resolve explicit pipeline values
// first; the persisted `studio.shared-memories` custom session entry (type
// "custom": never rendered as a message) is only a fallback for flag-less
// (legacy) resumes and the sessionManager-readable policy for the knowledge
// filter and tool-call helpers. A malformed latest entry fails closed to
// false and never resurrects an older value. Native subagents inherit the
// live parent value at spawn. Past user/assistant text is never rewritten;
// stale provider-bound snapshots are filtered on request-only clones of typed
// records (role/customType/fields) — message text is never parsed or stripped.

import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARED_MEMORIES_FLAG = 'shared-memories';
export const NO_SHARED_MEMORIES_FLAG = 'no-shared-memories';
export const SHARED_MEMORIES_ENTRY = 'studio.shared-memories';
export const HARNESS_DIGEST_CUSTOM_TYPE = 'harness_digest';
export const REFINEMENT_NOTICE_CUSTOM_TYPE = 'refinement_notice';
export const REFINEMENT_RESULT_CUSTOM_TYPE = 'prime-agent.refinement';

const SELF_URL = import.meta.url;

// Strict boolean contract: only an explicit true enables shared memories.
// Absent, malformed or legacy values fail closed to false.
export function normalizeSharedMemories(value) {
  return value === true;
}

function flagMapGet(flagValues, name) {
  try {
    if (typeof flagValues?.get === 'function') return flagValues.get(name);
    if (flagValues && typeof flagValues === 'object') return flagValues[name];
  } catch {
    /* Malformed flag carrier: treated as absent below. */
  }
  return undefined;
}

// Two complementary bare CLI flags (the native boolean-flag pipeline cannot
// express an explicit false with a single flag: any present value reads true).
// `--no-shared-memories` wins when both are present: fail closed to false.
export function flagValuesToSharedMemories(flagValues) {
  if (flagMapGet(flagValues, NO_SHARED_MEMORIES_FLAG) === true) return false;
  if (flagMapGet(flagValues, SHARED_MEMORIES_FLAG) === true) return true;
  return undefined;
}

// Explicit value carried by a daemon create/session config. Absent keys mean
// "keep the running session value" (legacy/foreign clients), never false.
export function seedFromConfig(config) {
  if (!config || typeof config !== 'object') return undefined;
  if (typeof config.sharedMemories === 'boolean') return config.sharedMemories;
  return flagValuesToSharedMemories(config.extensionFlagValues);
}

// Latest policy entry wins. A malformed LATEST entry fails closed to false
// instead of resurrecting an older value. Returns undefined when no entry.
export function readSharedMemoriesEntry(sessionManager) {
  try {
    const branch = sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return undefined;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === 'custom' && entry?.customType === SHARED_MEMORIES_ENTRY) {
        return typeof entry?.data?.sharedMemories === 'boolean' ? entry.data.sharedMemories : false;
      }
    }
  } catch {
    /* Unreadable branch: no entry. */
  }
  return undefined;
}

// Sanctioned sessionManager-readable policy for the knowledge filter and
// tool-call helpers. Returns true ONLY from authoritative pipeline records:
// the live session field (attached by the native adapter) or a native-written
// persisted entry — never inferred from message text (this module performs no
// text parsing or stripping). Strict boolean: false when unset.
export function readSharedMemoriesPolicy(sessionManager) {
  try {
    const live = sessionManager?.getStudioSharedMemories?.();
    if (typeof live === 'boolean') return live;
  } catch {
    /* Fall through to the persisted entry. */
  }
  const fromEntry = readSharedMemoriesEntry(sessionManager);
  return fromEntry === true;
}

// Construction seed: ONLY explicit pipeline values (first-class option, then
// launch flags). The persisted entry is deliberately NOT consulted here so an
// explicit launch value can never transiently restore a stale `true` after a
// resumed/restarted root. Absent explicit values seed false; legacy resumes
// without flags fall back to the entry in the live read below.
export function constructionSeed(config, resourceLoader) {
  if (config && typeof config.sharedMemories === 'boolean') {
    return { value: config.sharedMemories, explicit: true };
  }
  try {
    const fromFlags = flagValuesToSharedMemories(resourceLoader?.getExtensions?.()?.runtime?.flagValues);
    if (typeof fromFlags === 'boolean') return { value: fromFlags, explicit: true };
  } catch {
    /* Loader without extensions: fall through to the default. */
  }
  return { value: false, explicit: false };
}

// Live read: an explicitly seeded session answers from its field (explicit
// launch flags always override the persisted entry, including on resumed or
// restarted roots); a legacy session without explicit values falls back to
// the persisted entry, then the construction default. Default false.
export function resolveSharedMemories({ sessionManager, seed, explicit } = {}) {
  if (explicit === true) return seed === true;
  const fromEntry = readSharedMemoriesEntry(sessionManager);
  if (typeof fromEntry === 'boolean') return fromEntry;
  return seed === true;
}

// Context/extension helper: authoritative live session field first, then
// stale persisted entry on resumed/restarted roots), then the entry, then
// default false. This runs per provider request, strictly after the daemon
// session_start refresh, so no stale entry can reach outbound context.
// Never model-supplied: only native pipeline values.
export function resolveSharedMemoriesForContext(pi, ctx) {
  // Authoritative live session field first: stale launch flags must not
  // override a live false (the loader flag sync is best-effort).
  try {
    const live = ctx?.sessionManager?.getStudioSharedMemories?.();
    if (typeof live === 'boolean') return live;
  } catch {
    /* Fall through to launch flags. */
  }
  try {
    const seed = seedFromConfig({
      extensionFlagValues: {
        [SHARED_MEMORIES_FLAG]: pi?.getFlag?.(SHARED_MEMORIES_FLAG),
        [NO_SHARED_MEMORIES_FLAG]: pi?.getFlag?.(NO_SHARED_MEMORIES_FLAG),
      },
    });
    if (typeof seed === 'boolean') return seed;
  } catch {
    /* No flag access from this context. */
  }
  const fromEntry = readSharedMemoriesEntry(ctx?.sessionManager);
  if (typeof fromEntry === 'boolean') return fromEntry;
  return false;
}

// Align the persisted entry with an explicit policy value. Writes only when
// different (no per-start file spam). IO failures propagate: policy writes
// fail loudly rather than silently carrying a stale value. Memory-safe:
// SessionManager._persist no-ops for unpersisted sessions.
export function syncSharedMemoriesEntry(sessionManager, value) {
  if (typeof value !== 'boolean') return readSharedMemoriesEntry(sessionManager);
  const current = readSharedMemoriesEntry(sessionManager);
  if (current === value) return value;
  sessionManager?.appendCustomEntry?.(SHARED_MEMORIES_ENTRY, {
    sharedMemories: value,
    updatedAt: new Date().toISOString(),
  });
  return value;
}

function plainFlags(flagValues) {
  if (!flagValues || typeof flagValues !== 'object') return {};
  try {
    if (flagValues instanceof Map) return Object.fromEntries(flagValues);
  } catch {
    return {};
  }
  return { ...flagValues };
}

// Resolve the authoritative CURRENT parent state for an agent-message
// delivery target. The target's own metadata record comes first: it covers
// parent-, sibling- and client-originated delivery without trusting the
// sender's unrelated policy. Sender fallback applies only when the sender is
// the target's parent. Returns undefined when no resident authoritative
// parent exists (deliver unchanged; never invent a policy). Root targets
// resolve to undefined: roots keep their independent policy.
export function digestMatchesPolicy(latest, shared) {
  if (!latest || typeof latest !== 'object') return false;
  return latest.sharedMemories === shared;
}

// Resolve the authoritative CURRENT parent state for an agent-message
// delivery target. The target's own metadata record comes first (covers
// parent-, sibling- and client-originated delivery); when it is unavailable,
// fall back to the sender, but only when verified to be the target's actual
// parent — an unrelated sender is never authority. Returns undefined when no
// resident authoritative parent can be resolved or the target is not a
// subagent (roots keep their independent policy).
export function resolveDeliveryParent(daemon, targetState, options) {
  const metadata = targetState?.runtime?.metadata;
  if (!metadata || metadata.kind !== 'subagent') return undefined;
  const sessions = daemon?.sessions;
  const parentId = metadata?.parentActiveSessionId;
  if (parentId && sessions && typeof sessions.get === 'function') {
    const parent = sessions.get(parentId);
    if (parent && parent !== targetState) return parent;
  }
  const fromState = options?.fromState;
  if (fromState && typeof daemon?.agentMessageRelationship === 'function') {
    if (daemon.agentMessageRelationship(fromState, targetState) === 'parent') return fromState;
  }
  return undefined;
}

// Refresh a subagent delivery target from its authoritative current parent
// immediately before acceptAgentSessionMessage. No resident parent (or no
// live boolean) fails closed to false. No swallowing: a missing setter or a
// failing write throws, which prevents delivery instead of silently
// carrying a stale true.
export function refreshDeliveryPolicy(daemon, targetState, options) {
  const metadata = targetState?.runtime?.metadata;
  if (!metadata || metadata.kind !== 'subagent') return false;
  const session = targetState?.runtime?.session;
  if (!session || typeof session.setStudioSharedMemories !== 'function') {
    throw new Error('Studio shared-memories adapter: session policy setter missing; update the adapter.');
  }
  const parent = resolveDeliveryParent(daemon, targetState, options);
  const live = parent?.runtime?.session?.getStudioSharedMemories?.();
  session.setStudioSharedMemories(typeof live === 'boolean' ? live : false);
  return true;
}

// Merge child sessionConfig with the live parent value so daemon-hosted and
// runtime-hosted subagents inherit the toggle. Returns baseConfig unchanged
// when there is no live boolean to carry (never invents a policy).
export function withSharedMemoriesConfig(baseConfig, parentSession) {
  try {
    if (!baseConfig || typeof baseConfig !== 'object') return baseConfig;
    const value = parentSession?.getStudioSharedMemories?.();
    if (typeof value !== 'boolean') return baseConfig;
    const baseFlags = baseConfig.extensionFlagValues;
    const flags =
      baseFlags instanceof Map
        ? Object.fromEntries(baseFlags)
        : { ...(baseFlags && typeof baseFlags === 'object' ? baseFlags : {}) };
    if (value) {
      flags[SHARED_MEMORIES_FLAG] = true;
      delete flags[NO_SHARED_MEMORIES_FLAG];
    } else {
      flags[NO_SHARED_MEMORIES_FLAG] = true;
      delete flags[SHARED_MEMORIES_FLAG];
    }
    return { ...baseConfig, extensionFlagValues: flags };
  } catch {
    // Fail closed: never carry a possibly stale explicit-true forward.
    if (!baseConfig || typeof baseConfig !== 'object') return baseConfig;
    try {
      const flags = plainFlags(baseConfig.extensionFlagValues);
      delete flags[SHARED_MEMORIES_FLAG];
      flags[NO_SHARED_MEMORIES_FLAG] = true;
      return { ...baseConfig, extensionFlagValues: flags };
    } catch {
      return baseConfig;
    }
  }
}

// Session-local refinement results with an explicit global scope (carried in
// the current session log) must not reach the auto-refine reviewer when
// shared memories are off. Malformed entries are dropped, not trusted.
export function keepLocalRefinements(results) {
  if (!Array.isArray(results)) return [];
  return results.filter((result) => !result || result.scope !== 'global');
}

// Compaction summarizer input: filter the typed preparation records when off,
// independent of the code-context gate. Ordinary history, previousSummary and
// other preparation fields pass through untouched.
export function filterCompactionPreparation(preparation, shared) {
  if (shared === true || !preparation || typeof preparation !== 'object') return { changed: false };
  let changed = false;
  for (const key of ['messagesToSummarize', 'turnPrefixMessages']) {
    const messages = preparation[key];
    if (!Array.isArray(messages)) continue;
    const filtered = filterContextMessagesForSharedMemories(messages, false);
    if (filtered.changed) {
      preparation[key] = filtered.messages;
      changed = true;
    }
  }
  return { changed };
}

// Branch-summary input: native summarization already excludes harness
// digests, but global refinement notices and global refinement results would
// still reach it. Drop those typed entries when off; messages, digests,
// compaction records and local refinements pass through untouched.
export function filterBranchSummaryEntries(entries, shared) {
  if (shared === true) return { entries, changed: false };
  if (!Array.isArray(entries)) return { entries, changed: false };
  let changed = false;
  const out = [];
  for (const entry of entries) {
    if (
      entry?.type === 'custom_message' &&
      entry?.customType === REFINEMENT_NOTICE_CUSTOM_TYPE &&
      entry?.details?.scope === 'global'
    ) {
      changed = true;
      continue;
    }
    if (
      entry?.type === 'custom' &&
      entry?.customType === REFINEMENT_RESULT_CUSTOM_TYPE &&
      entry?.data?.scope === 'global'
    ) {
      changed = true;
      continue;
    }
    out.push(entry);
  }
  return { entries: changed ? out : entries, changed };
}

// Strip the GLOBAL harness state source before merging when shared memories
// are off: the global file contributes no memory entries and no refinements
// (location-global records, including legacy scope-less ones, cannot leak),
// while global prompt entries (user rules), skills and subagent specs are
// preserved untouched. Local state is never modified here.
export function stripGlobalHarnessState(globalState) {
  if (!globalState || typeof globalState !== 'object') return globalState;
  const entries = globalState.entries && typeof globalState.entries === 'object' ? globalState.entries : {};
  return {
    ...globalState,
    entries: { ...entries, memory: {} },
    refinements: [],
  };
}

// Post-merge defense in depth: drop entries explicitly tagged global from the
// memory kind and global refinements, whatever file they came from. Prompt,
// skill and subagent kinds pass through untouched. `true` returns the state
// untouched (current native behavior).
export function filterHarnessStateForSharedMemories(state, shared) {
  if (shared === true) return state;
  if (!state || typeof state !== 'object') return state;
  const entries = state.entries && typeof state.entries === 'object' ? state.entries : {};
  const keepLocalEntries = (group) => {
    if (!group || typeof group !== 'object') return {};
    const out = {};
    for (const [id, entry] of Object.entries(group)) {
      if (entry && typeof entry === 'object' && entry.scope === 'global') continue;
      out[id] = entry;
    }
    return out;
  };
  const refinements = Array.isArray(state.refinements)
    ? state.refinements.filter((result) => !result || result.scope !== 'global')
    : [];
  return {
    ...state,
    entries: { ...entries, memory: keepLocalEntries(entries.memory) },
    refinements,
  };
}

// Request-only provider-payload hygiene for stale snapshots generated while
// shared memories were on (or before the marker existed). Operates on typed
// records only — message text is never parsed or regex-stripped:
// - drop harness-digest messages not marked as filtered-local;
// - strip compaction snapshot fields (the summary text stays: session content);
// - drop global refinement notices.
// `true` returns the messages untouched. User/assistant/toolResult and every
// other message pass through identical.
export function filterContextMessagesForSharedMemories(messages, shared) {
  if (shared === true) return { messages, changed: false };
  if (!Array.isArray(messages)) return { messages, changed: false };
  let changed = false;
  const out = [];
  for (const message of messages) {
    if (message?.role === 'custom' && message?.customType === HARNESS_DIGEST_CUSTOM_TYPE) {
      if (message?.details?.sharedMemories === false) {
        out.push(message);
        continue;
      }
      changed = true;
      continue;
    }
    if (
      message?.role === 'compactionSummary' &&
      (message?.harnessDigest !== undefined || message?.harnessStateFingerprint !== undefined)
    ) {
      const { harnessDigest: _digest, harnessStateFingerprint: _fingerprint, ...rest } = message;
      out.push(rest);
      changed = true;
      continue;
    }
    if (
      message?.role === 'custom' &&
      message?.customType === REFINEMENT_NOTICE_CUSTOM_TYPE &&
      message?.details?.scope === 'global'
    ) {
      changed = true;
      continue;
    }
    out.push(message);
  }
  return { messages: changed ? out : messages, changed };
}

function studioFlagError(detail) {
  return new Error(`Studio shared-memories adapter: native layout changed; update the adapter. ${detail}`);
}

const AGENT_MARKER = '/* Studio: shared-memories agent-session. */';
const MESSAGES_MARKER = '/* Studio: shared-memories messages. */';
const RUNTIME_MARKER = '/* Studio: shared-memories agent-session-runtime. */';
const DAEMON_MARKER = '/* Studio: shared-memories daemon-mode. */';
const STUDIO_IMPORT = 'import * as StudioSharedMemories from ';

// Each edit: an indent-agnostic regex anchor (covering both the unbundled
// dist sources and the bundled cli-node build), a skip marker present in the
// injected code, and a replacer. Once a file's gate matches, every edit of
// that set is required: a missing anchor throws instead of silently shipping
// the old always-global behavior. Files without the gate are left untouched.
function runEdits(source, edits, { required, url, set }) {
  let out = source;
  let changed = false;
  for (const edit of edits) {
    if (out.includes(edit.skip)) continue;
    edit.pattern.lastIndex = 0;
    if (!edit.pattern.test(out)) {
      if (required) {
        const where = typeof url === 'string' && url ? ` (${url.slice(-120)})` : '';
        throw studioFlagError(`${set}/${edit.name}: anchor missing${where}`);
      }
      return { source, changed: false, skipped: true };
    }
    edit.pattern.lastIndex = 0;
    out = out.replace(edit.pattern, edit.replace);
    changed = true;
  }
  return { source: out, changed };
}

// --- dist/core/agent-session.js (also the bundled session class chunk) ---
function agentSessionEdits() {
  return [
    {
      name: 'constructor seed',
      skip: 'StudioSharedMemories.constructionSeed(config, this._resourceLoader)',
      pattern: /^([ \t]*)this\._rlmMaxDepthSource = resolvedRlmMaxDepth\.source;$/m,
      replace: (line, indent) =>
        `${line}\n` +
        `${indent}this._studioSharedMemories = StudioSharedMemories.constructionSeed(config, this._resourceLoader);\n` +
        `${indent}this._studioSharedMemoriesExplicit = this._studioSharedMemories.explicit === true;\n` +
        `${indent}this._studioSharedMemories = this._studioSharedMemories.value === true;\n` +
        `${indent}try { this.sessionManager.getStudioSharedMemories = () => this.getStudioSharedMemories(); } catch { /* Getter attach is best-effort; the persisted entry remains readable. */ }\n` +
        `${indent}StudioSharedMemories.syncSharedMemoriesEntry(this.sessionManager, this._studioSharedMemoriesExplicit ? this._studioSharedMemories : undefined);`,
    },
    {
      name: 'policy accessors and merge gate',
      skip: 'StudioSharedMemories.filterHarnessStateForSharedMemories',
      pattern:
        /^[ \t]*_loadMergedHarnessState\(\) \{\n\s*const localHarnessStateDir = this\._localHarnessStateDir\(\);\n\s*return mergeHarnessStates\(loadHarnessState\(getGlobalHarnessStateDir\(\), "global"\), localHarnessStateDir \? loadHarnessState\(localHarnessStateDir, "local"\) : (?:undefined|void 0)\);\n\s*\}/m,
      replace: (block) => {
        const methodIndent = block.match(/^[ \t]*/m)[0];
        const body = `${methodIndent}    `;
        return (
          `${methodIndent}getStudioSharedMemories() {\n` +
          `${body}${AGENT_MARKER}\n` +
          `${body}if (this._studioSharedMemoriesExplicit === true) return this._studioSharedMemories === true;\n` +
          `${body}return StudioSharedMemories.resolveSharedMemories({ sessionManager: this.sessionManager, seed: this._studioSharedMemories });\n` +
          `${methodIndent}}\n` +
          `${methodIndent}setStudioSharedMemories(value) {\n` +
          `${body}${AGENT_MARKER}\n` +
          `${body}const next = StudioSharedMemories.normalizeSharedMemories(value);\n` +
          `${body}if (this.getStudioSharedMemories() === next && this._studioSharedMemories === next) return next;\n` +
          `${body}this._studioSharedMemories = next;\n` +
          `${body}this._studioSharedMemoriesExplicit = true;\n` +
          `${body}try {\n` +
          `${body}    const flagValues = this._resourceLoader?.getExtensions?.()?.runtime?.flagValues;\n` +
          `${body}    if (flagValues instanceof Map) {\n` +
          `${body}        if (next) {\n` +
          `${body}            flagValues.set(StudioSharedMemories.SHARED_MEMORIES_FLAG, true);\n` +
          `${body}            flagValues.delete(StudioSharedMemories.NO_SHARED_MEMORIES_FLAG);\n` +
          `${body}        } else {\n` +
          `${body}            flagValues.set(StudioSharedMemories.NO_SHARED_MEMORIES_FLAG, true);\n` +
          `${body}            flagValues.delete(StudioSharedMemories.SHARED_MEMORIES_FLAG);\n` +
          `${body}        }\n` +
          `${body}    }\n` +
          `${body}} catch { /* Loader flag sync is ancillary; field and entry stay authoritative. */ }\n` +
          `${body}StudioSharedMemories.syncSharedMemoriesEntry(this.sessionManager, next);\n` +
          `${body}try {\n` +
          `${body}    this._harnessDigestPending = true;\n` +
          `${body}} catch { /* Digest hint is ancillary. */ }\n` +
          `${body}return next;\n` +
          `${methodIndent}}\n` +
          `${methodIndent}_loadMergedHarnessState() {\n` +
          `${body}const localHarnessStateDir = this._localHarnessStateDir();\n` +
          `${body}const harnessLocalDir = localHarnessStateDir ? loadHarnessState(localHarnessStateDir, "local") : undefined;\n` +
          `${body}if (this.getStudioSharedMemories()) return mergeHarnessStates(loadHarnessState(getGlobalHarnessStateDir(), "global"), harnessLocalDir);\n` +
          `${body}const harnessGlobalStripped = StudioSharedMemories.stripGlobalHarnessState(loadHarnessState(getGlobalHarnessStateDir(), "global"));\n` +
          `${body}return StudioSharedMemories.filterHarnessStateForSharedMemories(mergeHarnessStates(harnessGlobalStripped, harnessLocalDir), false);\n` +
          `${methodIndent}}`
        );
      },
    },
    {
      name: 'refinement gate',
      skip: 'sharedMemoriesLocal',
      pattern:
        /^[ \t]*return mergeRefinementHistory\(loadGlobalRefinementHistory\(getGlobalHarnessStateDir\(\)\), getRefinementHistory\(this\.sessionManager\.getEntries\(\)\.filter\(\(entry\) => entry\.type === "custom"\)\)\);$/m,
      replace: (line) => {
        const indent = line.match(/^[ \t]*/m)[0];
        return (
          `${indent}const sharedMemoriesLocal = getRefinementHistory(this.sessionManager.getEntries().filter((entry) => entry.type === "custom"));\n` +
          `${indent}if (this.getStudioSharedMemories()) return mergeRefinementHistory(loadGlobalRefinementHistory(getGlobalHarnessStateDir()), sharedMemoriesLocal);\n` +
          `${indent}return mergeRefinementHistory([], StudioSharedMemories.keepLocalRefinements(sharedMemoriesLocal));`
        );
      },
    },
    {
      name: 'first-turn digest marker',
      skip: 'createHarnessDigestMessage(digest, Date.now(), stateFingerprint, this.getStudioSharedMemories()),',
      pattern: /^[ \t]*createHarnessDigestMessage\(digest, Date\.now\(\), stateFingerprint\),$/m,
      replace: (line) => {
        const indent = line.match(/^[ \t]*/m)[0];
        return `${indent}createHarnessDigestMessage(digest, Date.now(), stateFingerprint, this.getStudioSharedMemories()),`;
      },
    },
    {
      name: 'stale-check digest marker',
      skip: 'const message = createHarnessDigestMessage(digest, Date.now(), stateFingerprint, this.getStudioSharedMemories());',
      pattern:
        /^[ \t]*const message = createHarnessDigestMessage\(digest, Date\.now\(\), stateFingerprint\);$/m,
      replace: (line) => {
        const indent = line.match(/^[ \t]*/m)[0];
        return `${indent}const message = createHarnessDigestMessage(digest, Date.now(), stateFingerprint, this.getStudioSharedMemories());`;
      },
    },
    {
      name: 'digest details marker propagation',
      skip: 'sharedMemories: details.sharedMemories',
      pattern:
        /^[ \t]*latest = \{\n\s*timestamp: message\.timestamp,\n\s*digest: details\.digest,\n\s*stateFingerprint: details\.stateFingerprint(,?)\n\s*\};$/m,
      replace: (block) => {
        const m = block.match(/^([ \t]*)stateFingerprint: details\.stateFingerprint(,?)$/m);
        const indent = m[1];
        const tail = m[2] === ',' ? ',' : '';
        return block.replace(
          /^([ \t]*)stateFingerprint: details\.stateFingerprint(,?)$/m,
          `${indent}stateFingerprint: details.stateFingerprint,\n${indent}sharedMemories: details.sharedMemories${tail}`,
        );
      },
    },
    {
      name: 'freshness mode guard',
      skip: 'digestMatchesPolicy(latest, this.getStudioSharedMemories())',
      pattern: /^([ \t]*)_harnessDigestIsFresh\(latest, freshDigest, freshFingerprint\) \{$/m,
      replace: (line, indent) =>
        `${line}\n${indent}    if (!StudioSharedMemories.digestMatchesPolicy(latest, this.getStudioSharedMemories())) return false;`,
    },
    {
      name: 'child inheritance',
      skip: 'sharedMemories: this.getStudioSharedMemories(),',
      pattern: /^[ \t]*const child = new (?:_)?AgentSession\(\{\n\s*agent: childAgent,$/m,
      replace: (block) => {
        const indent = block.match(/^[ \t]*/m)[0];
        return `${block}\n${indent}    sharedMemories: this.getStudioSharedMemories(),`;
      },
    },
  ];
}

export function transformAgentSession(source, { required = false, url = null } = {}) {
  if (!source.includes(AGENT_MARKER) && !source.includes('_loadMergedHarnessState() {')) {
    if (!required) return { source, changed: false };
    throw studioFlagError(`agent-session gate missing${url ? ` (${url.slice(-120)})` : ''}`);
  }
  if (source.includes(AGENT_MARKER)) {
    for (const edit of agentSessionEdits()) {
      if (!source.includes(edit.skip)) {
        const where = typeof url === 'string' && url ? ` (${url.slice(-120)})` : '';
        throw studioFlagError(`agent-session/${edit.name}: marker present but snippet missing${where}`);
      }
    }
    return { source, changed: false };
  }
  return runEdits(source, agentSessionEdits(), { required, url, set: 'agent-session' });
}

// --- dist/core/messages.js ---
function harnessDigestMessageEdits() {
  return [
    {
      name: 'digest factory',
      skip: 'createHarnessDigestMessage(digest, timestamp = Date.now(), stateFingerprint, sharedMemories)',
      pattern:
        /^(?:export )?function createHarnessDigestMessage\(digest, timestamp = Date\.now\(\), stateFingerprint\) \{$/m,
      replace: (line) =>
        line.replace(
          'createHarnessDigestMessage(digest, timestamp = Date.now(), stateFingerprint)',
          'createHarnessDigestMessage(digest, timestamp = Date.now(), stateFingerprint, sharedMemories)',
        ),
    },
    {
      name: 'digest details marker',
      skip: 'sharedMemories } : {}) },',
      pattern:
        /^([ \t]*)details: \{ digest, \.\.\.(\(?)stateFingerprint \? \{ stateFingerprint \} : \{\}(\)?) \},$/m,
      replace: (line, indent) =>
        `${indent}details: { digest, ...(stateFingerprint ? { stateFingerprint } : {}), ...(typeof sharedMemories === "boolean" ? { sharedMemories } : {}) },`,
    },
  ];
}

export function transformHarnessDigestMessage(source, { required = false, url = null } = {}) {
  if (!source.includes(MESSAGES_MARKER) && !source.includes('createHarnessDigestMessage(digest,')) {
    if (!required) return { source, changed: false };
    throw studioFlagError(`messages gate missing${url ? ` (${url.slice(-120)})` : ''}`);
  }
  if (source.includes(MESSAGES_MARKER)) {
    for (const edit of harnessDigestMessageEdits()) {
      if (!source.includes(edit.skip)) {
        const where = typeof url === 'string' && url ? ` (${url.slice(-120)})` : '';
        throw studioFlagError(`messages/${edit.name}: marker present but snippet missing${where}`);
      }
    }
    return { source, changed: false };
  }
  const out = runEdits(source, harnessDigestMessageEdits(), { required, url, set: 'messages' });
  if (out.changed && !out.source.includes(MESSAGES_MARKER)) {
    return { source: `${MESSAGES_MARKER}\n${out.source}`, changed: true };
  }
  return out;
}

// --- dist/core/agent-session-runtime.js ---
export function transformAgentSessionRuntime(source, { required = false, url = null } = {}) {
  if (!source.includes(RUNTIME_MARKER) && !source.includes('rlmSubagentRuntimeSpec(options)')) {
    if (!required) return { source, changed: false };
    throw studioFlagError(`runtime spawn gate missing${url ? ` (${url.slice(-120)})` : ''}`);
  }
  if (source.includes(RUNTIME_MARKER)) {
    if (
      !source.includes(
        'StudioSharedMemories.withSharedMemoriesConfig(this.sessionConfig, options.parentSession)',
      )
    ) {
      const where = typeof url === 'string' && url ? ` (${url.slice(-120)})` : '';
      throw studioFlagError(`agent-session-runtime/spawn merge: marker present but snippet missing${where}`);
    }
    return { source, changed: false };
  }
  const out = runEdits(
    source,
    [
      {
        name: 'runtime spawn merge',
        skip: 'StudioSharedMemories.withSharedMemoriesConfig(this.sessionConfig, options.parentSession)',
        pattern: /^[ \t]*sessionConfig: this\.sessionConfig,\n\s*\.\.\.rlmSubagentRuntimeSpec\(options\),?$/m,
        replace: (block) => {
          const indent = block.match(/^[ \t]*/m)[0];
          const spread = block.slice(block.indexOf('...rlmSubagentRuntimeSpec'));
          return (
            `${indent}sessionConfig: StudioSharedMemories.withSharedMemoriesConfig(this.sessionConfig, options.parentSession),\n` +
            `${RUNTIME_MARKER}\n` +
            spread
          );
        },
      },
    ],
    { required, url, set: 'agent-session-runtime' },
  );
  return out;
}

// --- dist/modes/daemon/daemon-mode.js ---
export function transformDaemonMode(source, { required = false, url = null } = {}) {
  if (!source.includes(DAEMON_MARKER) && !source.includes('adoptClientEnv(state, env) {')) {
    if (!required) return { source, changed: false };
    throw studioFlagError(`daemon gate missing${url ? ` (${url.slice(-120)})` : ''}`);
  }
  if (source.includes(DAEMON_MARKER)) {
    for (const snippet of [
      'refreshStudioSharedMemoriesPolicy(state, config)',
      'refreshStudioSharedMemoriesForDelivery(targetState, options) {',
      'StudioSharedMemories.withSharedMemoriesConfig(parentState.runtime.runtimeConfig, parentState.runtime.session)',
      'this.refreshStudioSharedMemoriesForDelivery(targetState, options);',
    ]) {
      if (!source.includes(snippet)) {
        const where = typeof url === 'string' && url ? ` (${url.slice(-120)})` : '';
        throw studioFlagError(
          `daemon-mode: marker present but snippet missing (${snippet.slice(0, 60)})${where}`,
        );
      }
    }
    return { source, changed: false };
  }
  return runEdits(
    source,
    [
      {
        name: 'refresh method',
        skip: 'refreshStudioSharedMemoriesPolicy(state, config) {',
        pattern: /^([ \t]*)adoptClientEnv\(state, env\) \{$/m,
        replace: (line, indent) =>
          `${indent}refreshStudioSharedMemoriesPolicy(state, config) {\n` +
          `${indent}    ${DAEMON_MARKER}\n` +
          `${indent}    const value = StudioSharedMemories.seedFromConfig(config);\n` +
          `${indent}    if (typeof value !== "boolean") return;\n` +
          `${indent}    const session = state?.runtime?.session;\n` +
          `${indent}    if (!session) return;\n` +
          `${indent}    if (typeof session.setStudioSharedMemories !== "function") throw new Error("Studio shared-memories adapter: session policy setter missing; update the adapter.");\n` +
          `${indent}    session.setStudioSharedMemories(value);\n` +
          `${indent}}\n` +
          line,
      },
      {
        name: 'delivery refresh method',
        skip: 'refreshStudioSharedMemoriesForDelivery(targetState, options) {',
        pattern: /^([ \t]*)adoptClientEnv\(state, env\) \{$/m,
        replace: (line, indent) =>
          `${indent}refreshStudioSharedMemoriesForDelivery(targetState, options) {\n` +
          `${indent}    ${DAEMON_MARKER}\n` +
          `${indent}    StudioSharedMemories.refreshDeliveryPolicy(this, targetState, options);\n` +
          `${indent}}\n` +
          line,
      },
      {
        name: 'reuse refresh',
        skip: 'this.refreshStudioSharedMemoriesPolicy(',
        pattern:
          /^[ \t]*this\.adoptClientEnv\((state|existing), clientEnv\);\n\s*await this\.rebindCronJobsToState\(\1\);\n\s*return \1;$/gm,
        replace: (block) =>
          block.replace(
            /^([ \t]*)this\.adoptClientEnv\((state|existing), clientEnv\);/m,
            (_, indent, which) =>
              `${indent}this.adoptClientEnv(${which}, clientEnv);\n${indent}this.refreshStudioSharedMemoriesPolicy(${which}, config);`,
          ),
      },
      {
        name: 'delivery refresh call',
        skip: 'this.refreshStudioSharedMemoriesForDelivery(targetState, options);',
        pattern:
          /^[ \t]*const \{ status \} = await this\.acceptAgentSessionMessage\(targetState, payload\);$/m,
        replace: (line) => {
          const indent = line.match(/^[ \t]*/m)[0];
          return `${indent}this.refreshStudioSharedMemoriesForDelivery(targetState, options);\n` + line;
        },
      },
      {
        name: 'spawn merges',
        skip: 'StudioSharedMemories.withSharedMemoriesConfig(parentState.runtime.runtimeConfig, parentState.runtime.session)',
        pattern: /^[ \t]*sessionConfig: parentState\.runtime\.runtimeConfig,$/gm,
        replace: (line) =>
          line.replace(
            'sessionConfig: parentState.runtime.runtimeConfig,',
            'sessionConfig: StudioSharedMemories.withSharedMemoriesConfig(parentState.runtime.runtimeConfig, parentState.runtime.session),',
          ),
      },
    ],
    { required, url, set: 'daemon-mode' },
  );
}

let packageRoot;
export function initialize(data) {
  packageRoot = resolve(data.packageRoot);
}

function withStudioImport(source) {
  if (source.includes(STUDIO_IMPORT)) return source;
  return `import * as StudioSharedMemories from ${JSON.stringify(SELF_URL)};\n${source}`;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!packageRoot || !url.startsWith('file:') || result.format !== 'module') return result;
  const path = relative(packageRoot, fileURLToPath(url)).replaceAll('\\', '/');
  const isAgentSession = path === 'dist/core/agent-session.js';
  const isMessages = path === 'dist/core/messages.js';
  const isRuntime = path === 'dist/core/agent-session-runtime.js';
  const isDaemon = path === 'dist/modes/daemon/daemon-mode.js';
  const isBundle =
    !isAgentSession && !isMessages && !isRuntime && !isDaemon && /^dist\/bundle\/[^/]+\.m?js$/.test(path);
  if (!isAgentSession && !isMessages && !isRuntime && !isDaemon && !isBundle) return result;
  const source =
    typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  let out = source;
  let changed = false;
  // Once a file's gate matches (unbundled or bundled), every edit of that
  // set is required: a missing anchor throws instead of silently shipping
  // the old always-global behavior.
  const apply = (fn, gate) => {
    const matched = out.includes(gate);
    const patched = fn(out, { required: matched, url });
    out = patched.source;
    changed = changed || patched.changed;
  };
  if (isAgentSession || isBundle) apply(transformAgentSession, '_loadMergedHarnessState() {');
  if (isMessages || isBundle) apply(transformHarnessDigestMessage, 'createHarnessDigestMessage(digest,');
  if (isRuntime || isBundle) apply(transformAgentSessionRuntime, 'rlmSubagentRuntimeSpec(options)');
  if (isDaemon || isBundle) apply(transformDaemonMode, 'adoptClientEnv(state, env) {');
  if (!changed) return result;
  return { ...result, source: withStudioImport(out) };
}
