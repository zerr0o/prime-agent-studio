/**
 * Named layout presets (Studio 4.3.x, multi-conversation slice).
 *
 * Pure data module: no DOM, no localStorage, no network. A preset stores
 * geometry only (anonymous conversation slots, singleton placement), never
 * session ids, drafts, runs, or registry bindings.
 *
 * Schema:
 *   PresetsDoc = { version: 1, items: Preset[] }
 *   Preset     = { name: string, layout: LayoutDoc }
 *
 * Conventions (part of the API contract):
 * - `validatePresets` returns a normalized deep-frozen doc or null. Names are
 *   trimmed for storage (display case preserved) and unique case-insensitively.
 * - Every stored layout is a canonical V3 doc (legacy inner V1/V2 accepted,
 *   migrated: `inspector` replaced in place with `session`, `agents`, `files`)
 *   with ANONYMOUS conversation slots: `conversation` for the first slot in
 *   position order, then `conv:slot-1`, `conv:slot-2`, .... validatePresets
 *   anonymizes each entry via createPresetLayout, so a persisted or imported
 *   layout can never retain a live `conv:<session>` ref.
 * - `createPresetLayout` anonymizes a live layout (save path);
 *   `applyPresetLayout` binds anonymous slots to live instance refs (load path).
 *   Surplus live instances are NOT represented here: the parent parks them in
 *   its registry. Deficit slots are the parent's job (empty drafts via its own
 *   callback); this module only reports the need by returning null when ids
 *   are missing.
 * - No-op calls return the INPUT by reference where stated, so callers can
 *   skip persistence with a cheap identity check.
 */

import { validateLayout, groupsOf, isConversationPanel } from './docking-layout.js';

export const PRESETS_VERSION = 1;
/** Maximum named presets stored in one doc. */
export const MAX_PRESETS = 20;
/** Maximum preset name length after trimming. */
export const MAX_PRESET_NAME = 64;

const PRESET_KEYS = new Set(['name', 'layout']);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function freezeDeep(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry, seen);
  } else {
    for (const key of Object.keys(value)) freezeDeep(value[key], seen);
  }
  return Object.freeze(value);
}

/** Conversation slot refs of a validated doc in position (pre-order) order. */
function slotsOf(clean) {
  const slots = [];
  for (const group of groupsOf(clean)) {
    for (const panel of group.panels) {
      if (isConversationPanel(panel)) slots.push(panel);
    }
  }
  return slots;
}

function remapConversations(clean, mapping) {
  const remap = (node) => {
    if (node.kind === 'group') {
      return {
        kind: 'group',
        id: node.id,
        panels: node.panels.map((panel) => mapping.get(panel) || panel),
        active: mapping.get(node.active) || node.active,
      };
    }
    return {
      kind: 'split',
      id: node.id,
      dir: node.dir,
      ratio: node.ratio,
      first: remap(node.first),
      second: remap(node.second),
    };
  };
  return remap(clean.root);
}

/**
 * Strictly validate an unknown value as a presets doc.
 *
 * Returns a normalized deep-frozen `{ version: 1, items: [{ name, layout }] }`
 * or null. Rejected (=> null): non-object input, wrong/missing version, items
 * not an array or longer than MAX_PRESETS, non-object entries, entries with
 * any key outside `{ name, layout }` (this rejects dangerous keys and any
 * session/draft/run payload smuggled beside the layout), empty or over-long
 * names (after trim), duplicate names (case-insensitive on the trimmed name),
 * or layouts that fail layout validation. Each stored layout is anonymized
 * via createPresetLayout (which also strips layout extras and normalizes to
 * canonical V3), so live instance refs never persist.
 */
export function validatePresets(input) {
  if (!isPlainObject(input)) return null;
  if (input.version !== PRESETS_VERSION) return null;
  if (!Array.isArray(input.items) || input.items.length > MAX_PRESETS) return null;
  const seen = new Set();
  const items = [];
  for (const entry of input.items) {
    if (!isPlainObject(entry)) return null;
    for (const key of Object.keys(entry)) {
      if (DANGEROUS_KEYS.has(key) || !PRESET_KEYS.has(key)) return null;
    }
    if (typeof entry.name !== 'string') return null;
    const name = entry.name.trim();
    if (name.length < 1 || name.length > MAX_PRESET_NAME) return null;
    const folded = name.toLowerCase();
    if (seen.has(folded)) return null;
    seen.add(folded);
    const layout = createPresetLayout(entry.layout);
    if (!layout) return null;
    items.push({ name, layout });
  }
  return freezeDeep({ version: PRESETS_VERSION, items });
}

/**
 * Anonymize a live layout for preset storage (save path).
 *
 * Returns a frozen canonical layout where conversation slots are renamed in
 * position order to `conversation`, `conv:slot-1`, `conv:slot-2`, ...;
 * singletons, splits, ratios, and actives (remapped) are preserved. Invalid
 * input => null. Already-anonymous layouts normalize to an equal doc.
 */
export function createPresetLayout(layout) {
  const clean = validateLayout(layout);
  if (!clean) return null;
  const mapping = new Map();
  let extra = 0;
  for (const slot of slotsOf(clean)) {
    if (!mapping.has(slot))
      mapping.set(slot, mapping.size === 0 ? 'conversation' : `conv:slot-${(extra += 1)}`);
  }
  if (mapping.size === 0) return clean;
  return validateLayout({ version: 3, root: remapConversations(clean, mapping) });
}

/**
 * Count the anonymous conversation slots of a layout (preset or live).
 * Invalid input => 0.
 */
export function presetConversationCount(layout) {
  const clean = validateLayout(layout);
  if (!clean) return 0;
  return slotsOf(clean).length;
}

/**
 * Bind a preset's anonymous slots to live conversation instance refs.
 *
 * `conversationIds` must hold at least as many unique valid conversation refs
 * as the layout has slots; slots bind in position order and surplus ids are
 * ignored (stripped, never stored). Returns a frozen validated layout, or
 * null when the layout is invalid, the ids are not an array, any id is not a
 * conversation ref, ids are duplicated, or fewer ids than slots are given.
 * A slot-free layout returns its normalized form regardless of ids.
 */
export function applyPresetLayout(layout, conversationIds) {
  const clean = validateLayout(layout);
  if (!clean) return null;
  const slots = slotsOf(clean);
  if (slots.length === 0) return clean;
  if (!Array.isArray(conversationIds) || conversationIds.length < slots.length) return null;
  const seen = new Set();
  for (const id of conversationIds) {
    if (!isConversationPanel(id) || seen.has(id)) return null;
    seen.add(id);
  }
  const mapping = new Map(slots.map((slot, index) => [slot, conversationIds[index]]));
  return validateLayout({ version: 3, root: remapConversations(clean, mapping) });
}
