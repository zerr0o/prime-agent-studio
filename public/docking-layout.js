/**
 * Dockable workspace layout model (Studio 4.3.x, geometry V3).
 *
 * Pure data model: no DOM, no localStorage, no network. The storage
 * envelope and the DOM controller are owned by the parent scope; this
 * module only builds, validates and transforms immutable layout docs.
 *
 * Schema:
 *   LayoutDoc = { version: 3, root: LayoutNode }
 *   Group     = { kind: 'group', id, panels: PanelId[], active: PanelId | null }
 *   Split     = { kind: 'split', id, dir: 'row' | 'column', ratio, first, second }
 *   PanelId   = 'conversation' | 'roadmap' | 'session' | 'agents' | 'files' | 'preferences' | `conv:${InstanceId}`
 *
 * Conventions (part of the API contract):
 * - Tabs are panel ids: the fixed PANEL_IDS plus dynamic conversation refs
 *   `conv:<id>` (see isConversationPanel). A panel absent from the tree is
 *   CLOSED (closable/reopenable). At most MAX_CONVERSATIONS conversation tabs
 *   (legacy primary included) and at most one of each singleton. No session,
 *   draft, run, or registry state is stored here: geometry only.
 * - V1 docs (fixed conversation/roadmap/inspector, no preferences, no
 *   conv: refs) and V2 docs (plus preferences and conv: refs) are accepted
 *   as legacy: validated against their original allowed ids, then `inspector`
 *   is replaced IN PLACE with `session`, `agents`, `files` in the same group
 *   (active `inspector` becomes `session`) and normalized to frozen V3 on
 *   output. V3 rejects `inspector`. Unknown versions are rejected.
 * - The root may be an empty group `{ panels: [], active: null }` when every
 *   panel is closed. Nested (non-root) empty groups are invalid and are
 *   collapsed away by mutators.
 * - Every mutator returns a NEW deep-frozen doc and never mutates its input.
 *   No-op calls return the INPUT DOC BY REFERENCE (`===`), so callers can
 *   skip re-render and persistence with a cheap identity check.
 * - New node ids come from a deterministic allocator (`group-N` / `split-N`,
 *   smallest free N over the ids already present). Same input doc + same
 *   operation => same ids, with no crypto or global counter.
 * - Split `ratio` is the fraction owned by `first` (`second` owns `1 - ratio`).
 *   For `dir: 'row'`, `first` is left and `second` is right; for
 *   `dir: 'column'`, `first` is top and `second` is bottom.
 * - `resizeSplit` and `validateLayout` CLAMP finite out-of-range ratios into
 *   [MIN_RATIO, MAX_RATIO]; non-finite ratios (NaN, +/-Infinity, non-numbers)
 *   are rejected (validate => null, resize => no-op). Clamping (not rejection)
 *   was chosen so a slightly stale persisted ratio can never blank the app.
 * - `movePanel` index semantics: `index` is the insertion position in the
 *   target group's panel list AFTER the panel has been removed from its
 *   previous group (when it was open). It is truncated and clamped to
 *   [0, length]. Omitted index means "append at end", except that moving a
 *   panel within its own group without an index is a no-op (order kept).
 *   Center moves from another group (or from closed) also make the moved
 *   panel the group's `active` tab. Same-group reorders also set
 *   `active` to the moved panel.
 */

// Fixed panel ids (geometry V3): the legacy primary conversation plus the five
// singleton panels. Extra conversation instances are dynamic refs `conv:<id>`
// (see isConversationPanel): valid panel ids without being listed here. The old
// whole `inspector` panel is no longer mountable (V3 rejects it); its former
// Session/Agents/Files tabs are now three separate panels. The sidebar stays a
// fixed global nav outside the layout tree. Preferences stays closed by default
// until explicitly added as a tab.
export const PANEL_IDS = Object.freeze([
  'conversation',
  'roadmap',
  'session',
  'agents',
  'files',
  'preferences',
]);

/** Maximum conversation instances mounted at once, legacy primary included. */
export const MAX_CONVERSATIONS = 8;

const CONV_REF_PATTERN = /^conv:[A-Za-z0-9_-]{1,64}$/;
const SINGLETON_SET = new Set(['roadmap', 'session', 'agents', 'files', 'preferences']);

/**
 * True for the legacy primary 'conversation' or a dynamic instance ref
 * `conv:<id>`. Which session/draft an instance shows is resolved by the
 * frontend registry, never by this pure geometry validator.
 */
export function isConversationPanel(id) {
  return id === 'conversation' || (typeof id === 'string' && CONV_REF_PATTERN.test(id));
}

/** True for any mountable tab: singletons plus all conversation instances. */
export function isPanelId(id) {
  return typeof id === 'string' && (SINGLETON_SET.has(id) || isConversationPanel(id));
}

export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

const VERSION = 3;
const V1_VERSION = 1;
const V2_VERSION = 2;
// Tree budgets derived from the maximum mounted tab count
// (5 singletons + MAX_CONVERSATIONS conversations = 13). Binary tree: at most
// 13 groups, at most 25 nodes, split nesting well under 25. Nested empty
// groups collapse, so every surviving non-root group holds >= 1 panel.
const MAX_SINGLETONS = 5;
const MAX_PANELS = MAX_SINGLETONS + MAX_CONVERSATIONS;
const MAX_GROUPS = MAX_PANELS;
const MAX_NODES = 2 * MAX_PANELS - 1;
const MAX_DEPTH = 2 * MAX_PANELS - 1;
const MAX_PANELS_PER_GROUP = MAX_PANELS;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Validation budget: bounds work on hostile input (deep chains use an
// explicit stack, never recursion; cycles are cut via a visited set).
const MAX_VISITED_NODES = 64;

// V1 accepted exactly these fixed ids (no preferences, no conv: refs);
// V2 accepted these fixed ids (plus conv: refs). Both are validated against
// their original allowed ids, then migrated to frozen V3 on output: `inspector`
// is replaced in place with `session`, `agents`, `files` (active follows).
const V1_PANEL_SET = new Set(['conversation', 'roadmap', 'inspector']);
const V2_SINGLETON_SET = new Set(['roadmap', 'inspector', 'preferences']);
const INSPECTOR_REPLACEMENT = ['session', 'agents', 'files'];

function isV2PanelId(id) {
  return typeof id === 'string' && (V2_SINGLETON_SET.has(id) || isConversationPanel(id));
}

function migratePanels(panels) {
  const out = [];
  for (const panel of panels) {
    if (panel === 'inspector') out.push(...INSPECTOR_REPLACEMENT);
    else out.push(panel);
  }
  return out;
}
const EDGE_ZONES = new Set(['left', 'right', 'top', 'bottom']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clampRatio(ratio) {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
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

function collectIds(root) {
  const ids = new Set();
  const stack = [root];
  const seen = new Set();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (typeof node.id === 'string') ids.add(node.id);
    if (node.first !== undefined) stack.push(node.first);
    if (node.second !== undefined) stack.push(node.second);
  }
  return ids;
}

function allocateId(ids, prefix) {
  let n = 1;
  while (ids.has(`${prefix}-${n}`)) n += 1;
  const id = `${prefix}-${n}`;
  ids.add(id);
  return id;
}

/**
 * Default desktop layout: a `row` split (id 'main', ratio 0.68) with the
 * conversation alone on the left and the tool panels tabbed on the right
 * (roadmap, session, agents, files; roadmap active). Preferences stays closed.
 */
export function createDefaultLayout() {
  return freezeDeep({
    version: VERSION,
    root: {
      kind: 'split',
      id: 'main',
      dir: 'row',
      ratio: 0.68,
      first: {
        kind: 'group',
        id: 'conversation-group',
        panels: ['conversation'],
        active: 'conversation',
      },
      second: {
        kind: 'group',
        id: 'tools-group',
        panels: ['roadmap', 'session', 'agents', 'files'],
        active: 'roadmap',
      },
    },
  });
}

/**
 * Strictly validate an unknown value as a layout doc.
 *
 * Returns a safe canonical deep-frozen V3 doc, or null when the input is
 * rejected. V1 and V2 docs are accepted as legacy: validated against their
 * original allowed ids, then `inspector` is replaced in place with `session`,
 * `agents`, `files` (active `inspector` becomes `session`) and normalized to
 * V3. Rejected (=> null): non-object input, missing/unknown version (only 1,
 * 2 and 3 accepted), missing/unknown `kind` or `dir`, missing/wrongly-typed
 * fields, unsafe node ids (not matching /^[A-Za-z0-9_-]{1,64}$/), unknown
 * panel ids (V3 rejects `inspector`; V1 additionally rejects preferences and
 * conv: refs; V2 rejects the new session/agents/files ids), more than
 * MAX_CONVERSATIONS conversation tabs, duplicate panels (globally) or
 * duplicate node ids, `active` not in `panels` (non-empty groups) or non-null
 * `active` on empty groups, nested empty groups, non-finite ratios, topology
 * over budget (nodes > 25, groups > 13, split depth > 25, panels/group > 13),
 * cyclic references, or anything beyond the visit budget.
 * Unknown EXTRA fields are stripped (canonical nodes keep exactly the
 * schema fields). Finite out-of-range ratios are CLAMPED (see header).
 */
export function validateLayout(input) {
  if (!isPlainObject(input)) return null;
  if (input.version !== VERSION && input.version !== V1_VERSION && input.version !== V2_VERSION) return null;
  const v1Only = input.version === V1_VERSION;
  const v2Only = input.version === V2_VERSION;
  const isLegacy = v1Only || v2Only;
  if (input.root === null || typeof input.root !== 'object') return null;

  // Iterative walk: tolerates hostile depth without call-stack overflow.
  // Records a canonical plan per node id-free (keyed by node reference).
  const seen = new Set();
  const order = [];
  let visited = 0;
  let groupCount = 0;
  const stack = [{ node: input.root, depth: 0, isRoot: true }];
  while (stack.length > 0) {
    const { node, depth, isRoot } = stack.pop();
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
    if (seen.has(node)) return null; // cyclic reference
    seen.add(node);
    visited += 1;
    if (visited > MAX_VISITED_NODES) return null;
    if (depth > MAX_DEPTH) return null;

    if (node.kind === 'group') {
      groupCount += 1;
      if (groupCount > MAX_GROUPS) return null;
      if (typeof node.id !== 'string' || !ID_PATTERN.test(node.id)) return null;
      if (!Array.isArray(node.panels) || node.panels.length > MAX_PANELS_PER_GROUP) return null;
      for (const panel of node.panels) {
        if (typeof panel !== 'string' || panel.length > 128) return null;
        if (v1Only ? !V1_PANEL_SET.has(panel) : v2Only ? !isV2PanelId(panel) : !isPanelId(panel)) return null;
      }
      if (node.panels.length === 0) {
        if (!isRoot) return null; // nested empty groups are invalid
        if (node.active !== null) return null;
      } else if (typeof node.active !== 'string' || !node.panels.includes(node.active)) {
        return null;
      }
      order.push(node);
    } else if (node.kind === 'split') {
      if (typeof node.id !== 'string' || !ID_PATTERN.test(node.id)) return null;
      if (node.dir !== 'row' && node.dir !== 'column') return null;
      if (typeof node.ratio !== 'number' || !Number.isFinite(node.ratio)) return null;
      if (node.first === null || typeof node.first !== 'object') return null;
      if (node.second === null || typeof node.second !== 'object') return null;
      order.push(node);
      stack.push({ node: node.second, depth: depth + 1, isRoot: false });
      stack.push({ node: node.first, depth: depth + 1, isRoot: false });
    } else {
      return null;
    }
  }

  const totalNodes = order.length;
  if (totalNodes === 0 || totalNodes > MAX_NODES) return null;

  // Global uniqueness: panels and node ids.
  const panelsSeen = new Set();
  const idsSeen = new Set();
  for (const node of order) {
    if (idsSeen.has(node.id)) return null;
    idsSeen.add(node.id);
    if (node.kind === 'group') {
      for (const panel of node.panels) {
        if (panelsSeen.has(panel)) return null;
        panelsSeen.add(panel);
      }
    }
  }
  let conversations = 0;
  for (const panel of panelsSeen) if (isConversationPanel(panel)) conversations += 1;
  if (conversations > MAX_CONVERSATIONS) return null;

  // Rebuild canonical nodes (extras stripped, ratios clamped, legacy
  // `inspector` replaced in place), then freeze.
  const canonical = new Map();
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const node = order[i];
    if (node.kind === 'group') {
      const panels = isLegacy ? migratePanels(node.panels) : [...node.panels];
      const active = isLegacy && node.active === 'inspector' ? 'session' : node.active;
      canonical.set(node, {
        kind: 'group',
        id: node.id,
        panels,
        active,
      });
    } else {
      canonical.set(node, {
        kind: 'split',
        id: node.id,
        dir: node.dir,
        ratio: clampRatio(node.ratio),
        first: canonical.get(node.first),
        second: canonical.get(node.second),
      });
    }
  }
  const root = canonical.get(input.root);
  if (!root || (root.kind === 'split' && (!root.first || !root.second))) return null;
  return freezeDeep({ version: VERSION, root });
}

function checkDoc(doc) {
  return (
    isPlainObject(doc) &&
    (doc.version === VERSION || doc.version === V1_VERSION || doc.version === V2_VERSION) &&
    doc.root !== null &&
    typeof doc.root === 'object'
  );
}

// Full strict validation for mutator entry: guarantees bounded depth for the
// recursive tree walkers below. Invalid docs pass through untouched (same ref).
function asValid(doc) {
  if (!checkDoc(doc)) return null;
  try {
    return validateLayout(doc);
  } catch {
    return null;
  }
}

/** Groups of a doc in pre-order (root-first). Returns [] for unusable input. */
export function groupsOf(doc) {
  if (!checkDoc(doc)) return [];
  const groups = [];
  const stack = [doc.root];
  const seen = new Set();
  let guard = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    guard += 1;
    if (guard > MAX_VISITED_NODES) break;
    if (node.kind === 'group') {
      groups.push(node);
    } else if (node.kind === 'split') {
      stack.push(node.second);
      stack.push(node.first);
    } else {
      return [];
    }
  }
  return groups;
}

function findGroupId(root, groupId) {
  const stack = [root];
  const seen = new Set();
  let guard = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    guard += 1;
    if (guard > MAX_VISITED_NODES) return null;
    if (node.kind === 'group') {
      if (node.id === groupId) return node;
    } else if (node.kind === 'split') {
      stack.push(node.second);
      stack.push(node.first);
    } else {
      return null;
    }
  }
  return null;
}

function findPanelGroupId(root, panel) {
  const stack = [root];
  const seen = new Set();
  let guard = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    guard += 1;
    if (guard > MAX_VISITED_NODES) return null;
    if (node.kind === 'group') {
      if (Array.isArray(node.panels) && node.panels.includes(panel)) return node.id;
    } else if (node.kind === 'split') {
      stack.push(node.second);
      stack.push(node.first);
    } else {
      return null;
    }
  }
  return null;
}

// Remove `panel` from the tree. Returns { node, removed } where node is null
// when a NON-root subtree vanished ( caller promotes the sibling); the root
// itself becomes an empty group `{ panels: [], active: null }` (same id)
// instead of vanishing. Never mutates the input.
function removePanel(node, panel, isRoot) {
  if (node.kind === 'group') {
    if (!node.panels.includes(panel)) return { node, removed: false };
    const panels = node.panels.filter((entry) => entry !== panel);
    if (panels.length === 0) {
      if (isRoot) {
        return {
          node: { kind: 'group', id: node.id, panels: [], active: null },
          removed: true,
        };
      }
      return { node: null, removed: true };
    }
    const active = node.active === panel ? panels[0] : node.active;
    return { node: { kind: 'group', id: node.id, panels, active }, removed: true };
  }
  const left = removePanel(node.first, panel, false);
  if (left.removed) {
    if (left.node === null) return { node: node.second, removed: true };
    if (left.node === node.first) return { node, removed: false };
    return {
      node: {
        kind: 'split',
        id: node.id,
        dir: node.dir,
        ratio: node.ratio,
        first: left.node,
        second: node.second,
      },
      removed: true,
    };
  }
  const right = removePanel(node.second, panel, false);
  if (!right.removed) return { node, removed: false };
  if (right.node === null) return { node: node.first, removed: true };
  return {
    node: {
      kind: 'split',
      id: node.id,
      dir: node.dir,
      ratio: node.ratio,
      first: node.first,
      second: right.node,
    },
    removed: true,
  };
}

// Replace the node with `targetId` via `replace(node)`. Unchanged branches
// keep their references. Returns { root, changed }.
function replaceNode(node, targetId, replace) {
  if (node.kind === 'group') {
    if (node.id !== targetId) return { root: node, changed: false };
    return { root: replace(node), changed: true };
  }
  if (node.id === targetId) return { root: replace(node), changed: true };
  const left = replaceNode(node.first, targetId, replace);
  if (left.changed) {
    return {
      root: {
        kind: 'split',
        id: node.id,
        dir: node.dir,
        ratio: node.ratio,
        first: left.root,
        second: node.second,
      },
      changed: true,
    };
  }
  const right = replaceNode(node.second, targetId, replace);
  if (!right.changed) return { root: node, changed: false };
  return {
    root: {
      kind: 'split',
      id: node.id,
      dir: node.dir,
      ratio: node.ratio,
      first: node.first,
      second: right.root,
    },
    changed: true,
  };
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Move (or open) `panel` relative to `targetGroupId`.
 *
 * zones:
 * - 'center' (default): insert into the target group. Omitted `index`
 *   appends at the end for cross-group/closed moves, and is a no-op for
 *   same-group moves (order kept). With an explicit `index`, same-group
 *   moves reorder (remove-then-insert, clamped); the moved panel becomes
 *   `active` in every non-no-op center move.
 * - 'left'/'right' => new `row` split; 'top'/'bottom' => new `column` split.
 *   'left'/'top' put the panel's new group FIRST, 'right'/'bottom' put it
 *   SECOND, both with ratio 0.5. Edge zones ignore `index` (the panel always
 *   lands alone in its fresh group). A self-edge on a single-panel group is
 *   a no-op; a self-edge on a multi-tab group splits that panel out of it.
 *   An edge onto an EMPTY group (possible only at the all-closed root)
 *   degrades to a center insert, since there is nothing to split against.
 *   Moves from another group (or from closed) remove/collapse the source
 *   first, so empty groups never linger after the move.
 *
 * Unknown/invalid panel ref, unknown target group, or unknown zone => no-op (same doc).
 */
export function movePanel(doc, { panel, targetGroupId, zone = 'center', index } = {}) {
  if (!isPanelId(panel)) return doc;
  if (typeof targetGroupId !== 'string') return doc;
  if (zone !== 'center' && !EDGE_ZONES.has(zone)) return doc;
  const base0 = asValid(doc);
  if (!base0) return doc;

  const target = findGroupId(base0.root, targetGroupId);
  if (!target) return doc;
  const sourceGroupId = findPanelGroupId(base0.root, panel);

  if (zone === 'center') {
    if (sourceGroupId === targetGroupId) {
      if (index === undefined) return doc; // same-group order kept => no-op
      if (typeof index !== 'number' || !Number.isFinite(index)) return doc;
      const at = Math.min(Math.max(Math.trunc(index), 0), target.panels.length - 1);
      const without = target.panels.filter((entry) => entry !== panel);
      const next = [...without.slice(0, at), panel, ...without.slice(at)];
      if (arraysEqual(next, target.panels) && target.active === panel) return doc;
      const { root } = replaceNode(base0.root, targetGroupId, (group) => ({
        kind: 'group',
        id: group.id,
        panels: next,
        active: panel,
      }));
      return freezeDeep({ version: VERSION, root });
    }
    // Cross-group move or opening a closed panel.
    let base = base0.root;
    if (sourceGroupId) {
      const removed = removePanel(base, panel, true);
      base = removed.node;
    }
    const live = findGroupId(base, targetGroupId);
    if (!live) return doc;
    let panels;
    if (index === undefined) {
      panels = [...live.panels, panel];
    } else {
      if (typeof index !== 'number' || !Number.isFinite(index)) {
        panels = [...live.panels, panel];
      } else {
        const at = Math.min(Math.max(Math.trunc(index), 0), live.panels.length);
        panels = [...live.panels.slice(0, at), panel, ...live.panels.slice(at)];
      }
    }
    const { root } = replaceNode(base, targetGroupId, (group) => ({
      kind: 'group',
      id: group.id,
      panels,
      active: panel,
    }));
    return freezeDeep({ version: VERSION, root });
  }

  // Edge zones: split the target leaf.
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'column';
  const panelFirst = zone === 'left' || zone === 'top';
  const ids = collectIds(base0.root);

  if (sourceGroupId === targetGroupId) {
    if (target.panels.length <= 1) return doc; // self-edge on a single panel
    const rest = target.panels.filter((entry) => entry !== panel);
    const restActive = target.active === panel ? rest[0] : target.active;
    const splitId = allocateId(ids, 'split');
    const groupId = allocateId(ids, 'group');
    const kept = { kind: 'group', id: target.id, panels: rest, active: restActive };
    const moved = { kind: 'group', id: groupId, panels: [panel], active: panel };
    const split = {
      kind: 'split',
      id: splitId,
      dir,
      ratio: 0.5,
      first: panelFirst ? moved : kept,
      second: panelFirst ? kept : moved,
    };
    const { root } = replaceNode(base0.root, targetGroupId, () => split);
    return freezeDeep({ version: VERSION, root });
  }

  let base = base0.root;
  if (sourceGroupId) {
    const removed = removePanel(base, panel, true);
    base = removed.node;
    for (const id of collectIds(base)) ids.add(id);
  }
  const live = findGroupId(base, targetGroupId);
  if (!live) return doc;
  if (live.panels.length === 0) {
    // Nothing to split against (all-closed root): plain insert instead.
    const { root } = replaceNode(base, targetGroupId, (group) => ({
      kind: 'group',
      id: group.id,
      panels: [panel],
      active: panel,
    }));
    return freezeDeep({ version: VERSION, root });
  }
  const splitId = allocateId(ids, 'split');
  const groupId = allocateId(ids, 'group');
  const moved = { kind: 'group', id: groupId, panels: [panel], active: panel };
  const split = {
    kind: 'split',
    id: splitId,
    dir,
    ratio: 0.5,
    first: panelFirst ? moved : live,
    second: panelFirst ? live : moved,
  };
  const { root } = replaceNode(base, targetGroupId, () => split);
  return freezeDeep({ version: VERSION, root });
}

/**
 * Make an OPEN panel its group's active tab. Closed or already-active
 * panels (and unknown/invalid ids) => no-op (same doc).
 */
export function activatePanel(doc, panel) {
  if (!isPanelId(panel)) return doc;
  const base0 = asValid(doc);
  if (!base0) return doc;
  const groupId = findPanelGroupId(base0.root, panel);
  if (!groupId) return doc;
  const group = findGroupId(base0.root, groupId);
  if (!group || group.active === panel) return doc;
  const { root } = replaceNode(base0.root, groupId, (node) => ({
    kind: 'group',
    id: node.id,
    panels: [...node.panels],
    active: panel,
  }));
  return freezeDeep({ version: VERSION, root });
}

/**
 * Close a panel (remove it; absent ids stay absent). Empty nested groups
 * collapse (sibling promoted); closing the last panel yields an empty root
 * group `{ panels: [], active: null }`. Closing an absent panel => no-op.
 */
export function closePanel(doc, panel) {
  if (!isPanelId(panel)) return doc;
  const base0 = asValid(doc);
  if (!base0) return doc;
  const { node, removed } = removePanel(base0.root, panel, true);
  if (!removed) return doc;
  return freezeDeep({ version: VERSION, root: node });
}

/**
 * Set a split's ratio. Unknown split id or non-finite ratio => no-op.
 * Finite ratios are clamped to [MIN_RATIO, MAX_RATIO]; setting the already
 * current (clamped-equal) value => no-op (same doc).
 */
export function resizeSplit(doc, splitId, ratio) {
  if (typeof splitId !== 'string') return doc;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return doc;
  const base0 = asValid(doc);
  if (!base0) return doc;
  const next = clampRatio(ratio);
  let noop = false;
  const { root, changed } = replaceNode(base0.root, splitId, (node) => {
    if (node.kind !== 'split') {
      noop = true;
      return node;
    }
    if (node.ratio === next) {
      noop = true;
      return node;
    }
    return {
      kind: 'split',
      id: node.id,
      dir: node.dir,
      ratio: next,
      first: node.first,
      second: node.second,
    };
  });
  if (!changed || noop) return doc;
  return freezeDeep({ version: VERSION, root });
}
