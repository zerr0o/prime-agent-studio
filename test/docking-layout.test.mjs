import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_IDS,
  TOOL_KINDS,
  MAX_CONVERSATIONS,
  MAX_TOOL_PANELS,
  MIN_RATIO,
  MAX_RATIO,
  isConversationPanel,
  isToolPanel,
  toolKindOf,
  isPanelId,
  createDefaultLayout,
  validateLayout,
  groupsOf,
  movePanel,
  activatePanel,
  closePanel,
  resizeSplit,
} from '../public/docking-layout.js';

// Default-mounted set: legacy primary conversation + roadmap/session/agents/files
// (the old whole `inspector` panel is gone in geometry V3+; its former tabs dock
// as three separate panels). Preferences and dynamic conv:/tool: refs mount on
// demand; geometry V4 caps live conversations at MAX_CONVERSATIONS (legacy
// primary included) and live tool tabs at MAX_TOOL_PANELS (primaries included).
const ALL = ['conversation', 'roadmap', 'session', 'agents', 'files'];
const MAX_TABS = MAX_TOOL_PANELS + MAX_CONVERSATIONS;
const MAX_TREE_NODES = 2 * MAX_TABS - 1;

function group(id, panels, active) {
  return { kind: 'group', id, panels: [...panels], active };
}

function split(id, dir, ratio, first, second) {
  return { kind: 'split', id, dir, ratio, first, second };
}

function nodeCount(doc) {
  let n = 0;
  const stack = [doc.root];
  const seen = new Set();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    n += 1;
    if (node.kind === 'split') stack.push(node.first, node.second);
  }
  return n;
}

function collectNodeIds(doc) {
  const ids = [];
  const stack = [doc.root];
  const seen = new Set();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    ids.push(node.id);
    if (node.kind === 'split') stack.push(node.first, node.second);
  }
  return ids;
}

function openPanels(doc) {
  return groupsOf(doc).flatMap((g) => g.panels);
}

function splitDepth(doc) {
  let max = 0;
  const stack = [{ node: doc.root, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    if (node.kind === 'split') {
      max = Math.max(max, depth + 1);
      stack.push({ node: node.first, depth: depth + 1 });
      stack.push({ node: node.second, depth: depth + 1 });
    }
  }
  return max;
}

function assertInvariants(doc, label) {
  const valid = validateLayout(doc);
  assert.ok(valid, `${label}: doc must validate`);
  assert.deepEqual(doc, valid, `${label}: mutator output must already be canonical`);
  const open = openPanels(doc);
  assert.deepEqual([...open].sort(), [...new Set(open)].sort(), `${label}: panels unique`);
  for (const panel of open) assert.ok(isPanelId(panel), `${label}: known panel`);
  const groups = groupsOf(doc);
  assert.ok(groups.length <= MAX_TABS, `${label}: groups bounded`);
  assert.ok(nodeCount(doc) <= MAX_TREE_NODES, `${label}: nodes bounded`);
  assert.ok(splitDepth(doc) <= MAX_TREE_NODES, `${label}: depth bounded`);
  assert.deepEqual(
    collectNodeIds(doc).length,
    new Set(collectNodeIds(doc)).size,
    `${label}: node ids unique`,
  );
  assert.ok(Object.isFrozen(doc) && Object.isFrozen(doc.root), `${label}: frozen`);
  for (const g of groups) {
    assert.ok(Object.isFrozen(g.panels), `${label}: panels frozen`);
    if (g.panels.length === 0) {
      assert.equal(g.active, null, `${label}: empty group active null`);
    } else {
      assert.ok(g.panels.includes(g.active), `${label}: active in panels`);
    }
  }
}

test('PANEL_IDS is the fixed V4 set and ratios bound splits', () => {
  assert.deepEqual([...PANEL_IDS], ['conversation', 'roadmap', 'session', 'agents', 'files', 'preferences', 'performance', 'context']);
  assert.deepEqual([...TOOL_KINDS], ['roadmap', 'session', 'agents', 'files', 'preferences', 'performance', 'context']);
  assert.equal(MAX_CONVERSATIONS, 16);
  assert.equal(MAX_TOOL_PANELS, 16);
  assert.equal(MIN_RATIO, 0.15);
  assert.equal(MAX_RATIO, 0.85);
});

test('panel id helpers classify singletons, legacy, and dynamic refs', () => {
  assert.ok(isConversationPanel('conversation'), 'legacy primary');
  assert.ok(isConversationPanel('conv:a'), 'dynamic ref');
  assert.ok(isConversationPanel('conv:slot-12'), 'dynamic ref');
  assert.ok(isConversationPanel('conv:Aa0-_'), 'charset');
  assert.ok(isToolPanel('tool:roadmap:a'), 'dynamic tool ref');
  assert.ok(isPanelId('context'), 'Context primary');
  assert.ok(isToolPanel('tool:context:a'), 'Context instance');
  assert.equal(toolKindOf('tool:context:a'), 'context');
  assert.equal(isConversationPanel('context'), false);
  assert.equal(isToolPanel('context'), false);
  assert.equal(isPanelId('tool:context:'), false, 'Context requires nonce');
  assert.equal(isPanelId(`tool:context:${'x'.repeat(65)}`), false, 'Context nonce remains bounded');
  assert.ok(isToolPanel('tool:preferences:Aa0-_'), 'tool charset');
  assert.equal(toolKindOf('tool:session:xyz'), 'session', 'tool kind');
  assert.equal(toolKindOf('tool:files:slot-1'), 'files', 'tool slot kind');
  // Contract: fixed primaries map to themselves (parent registry uses this
  // for all five primary ids); dynamic refs map to their kind.
  for (const kind of TOOL_KINDS)
    assert.equal(toolKindOf(kind), kind, `fixed primary ${kind} maps to itself`);
  assert.equal(toolKindOf('conversation'), null, 'legacy conversation has no tool kind');
  assert.equal(toolKindOf('conv:a'), null, 'conversation instance has no tool kind');
  assert.equal(toolKindOf('inspector'), null, 'removed panel has no tool kind');
  assert.equal(toolKindOf('tool:bogus:a'), null, 'unknown kind has no tool kind');
  assert.equal(toolKindOf('tool:bogus:a'), null, 'unknown kind');
  assert.equal(toolKindOf('tool:roadmap:'), null, 'empty nonce');
  assert.equal(toolKindOf(`tool:roadmap:${'x'.repeat(65)}`), null, 'over-long nonce');
  assert.equal(isToolPanel('roadmap'), false, 'primary is not a dynamic tool ref');
  assert.equal(isToolPanel('preferences'), false, 'prefs primary is not a dynamic tool ref');
  assert.equal(isToolPanel('conv:a'), false, 'conversation is not a tool ref');
  assert.equal(isToolPanel('tool:inspector:a'), false, 'removed kind rejected');
  assert.equal(isConversationPanel('conv:'), false, 'empty id');
  assert.equal(isConversationPanel('conv:a b'), false, 'space');
  assert.equal(isConversationPanel(`conv:${'x'.repeat(65)}`), false, 'over-long id');
  assert.equal(isConversationPanel('roadmap'), false, 'singleton is not a conversation');
  assert.equal(isConversationPanel('session'), false, 'singleton is not a conversation');
  assert.equal(isConversationPanel('inspector'), false, 'removed panel is not a conversation');
  assert.equal(isConversationPanel(''), false, 'empty');
  assert.equal(isConversationPanel(null), false, 'non-string');
  assert.equal(isConversationPanel(42), false, 'non-string');
  assert.ok(
    isPanelId('roadmap') &&
      isPanelId('session') &&
      isPanelId('agents') &&
      isPanelId('files') &&
      isPanelId('preferences'),
    'singletons',
  );
  assert.ok(isPanelId('conversation') && isPanelId('conv:tab-1'), 'conversations');
  assert.ok(isPanelId('tool:roadmap:n1') && isPanelId('tool:preferences:n2'), 'tool instances');
  assert.equal(isPanelId('inspector'), false, 'removed whole-inspector panel rejected');
  assert.equal(isPanelId('conv:'), false, 'bad ref');
  assert.equal(isPanelId('tool:roadmap:'), false, 'bad tool ref');
});

test('Context primary and instance restore, move and close independently', () => {
  const restored = validateLayout({ version: 4, root: group('tools', ['conversation', 'context', 'tool:context:locked'], 'tool:context:locked') });
  assertInvariants(restored, 'Context restored');
  assert.equal(restored.root.active, 'tool:context:locked');
  const closed = closePanel(restored, 'context');
  assert.deepEqual(openPanels(closed), ['conversation', 'tool:context:locked']);
  assert.equal(closed.root.active, 'tool:context:locked');
  const reopened = movePanel(closed, { panel: 'context', targetGroupId: 'tools' });
  assertInvariants(reopened, 'Context reopened');
  assert.equal(reopened.root.active, 'context');
  assert.deepEqual(openPanels(reopened), ['conversation', 'tool:context:locked', 'context']);
});

test('default layout matches the contract', () => {
  const doc = createDefaultLayout();
  assert.equal(doc.version, 4);
  assert.equal(doc.root.kind, 'split');
  assert.equal(doc.root.id, 'main');
  assert.equal(doc.root.dir, 'row');
  assert.equal(doc.root.ratio, 0.68);
  assert.deepEqual(doc.root.first, group('conversation-group', ['conversation'], 'conversation'));
  assert.deepEqual(
    doc.root.second,
    group('tools-group', ['roadmap', 'session', 'agents', 'files'], 'roadmap'),
  );
  assert.ok(validateLayout(doc), 'default validates');
  assert.deepEqual(
    groupsOf(doc).map((g) => g.id),
    ['conversation-group', 'tools-group'],
  );
  assert.deepEqual(openPanels(doc).sort(), [...ALL].sort(), 'preferences stays closed by default');
});

test('validateLayout accepts canonical docs and strips extras', () => {
  const doc = createDefaultLayout();
  const clean = validateLayout(doc);
  assert.deepEqual(clean, doc);
  assert.ok(Object.isFrozen(clean) && Object.isFrozen(clean.root));

  const dirty = {
    version: 1,
    title: 'drop me',
    root: {
      kind: 'split',
      id: 'main',
      dir: 'row',
      ratio: 0.68,
      note: 'drop me',
      first: {
        kind: 'group',
        id: 'conversation-group',
        panels: ['conversation'],
        active: 'conversation',
        x: 1,
      },
      second: { kind: 'group', id: 'tools-group', panels: ['roadmap', 'inspector'], active: 'roadmap' },
    },
  };
  const canon = validateLayout(dirty);
  assert.deepEqual(canon, doc, 'extras stripped to canonical shape');
});

test('validateLayout clamps finite out-of-range ratios (documented choice)', () => {
  const base = createDefaultLayout();
  const low = structuredClone(base);
  low.root.ratio = 0.01;
  const high = structuredClone(base);
  high.root.ratio = 0.99;
  assert.equal(validateLayout(low).root.ratio, MIN_RATIO);
  assert.equal(validateLayout(high).root.ratio, MAX_RATIO);
});

test('validateLayout rejects invalid docs with null', () => {
  const base = createDefaultLayout();
  const cases = {
    'non-object': 42,
    null: null,
    array: [],
    'wrong version': { ...structuredClone(base), version: 5 },
    'missing version': { root: base.root },
    'missing root': { version: 3 },
    'removed whole-inspector panel in v3': (() => {
      const d = structuredClone(base);
      d.root.second.panels.push('inspector');
      return d;
    })(),
    'unknown panel id': (() => {
      const d = structuredClone(base);
      d.root.second.panels.push('nope');
      return d;
    })(),
    'duplicate panel across groups': (() => {
      const d = structuredClone(base);
      d.root.first.panels.push('roadmap');
      return d;
    })(),
    'duplicate panel in one group': (() => {
      const d = structuredClone(base);
      d.root.second.panels.push('roadmap');
      return d;
    })(),
    'duplicate node id': (() => {
      const d = structuredClone(base);
      d.root.second.id = 'main';
      return d;
    })(),
    'active not in panels': (() => {
      const d = structuredClone(base);
      d.root.second.active = 'conversation';
      return d;
    })(),
    'nested empty group': (() => ({
      version: 1,
      root: split('main', 'row', 0.5, group('a', ['conversation'], 'conversation'), group('b', [], null)),
    }))(),
    'empty root with non-null active': (() => ({ version: 1, root: group('root', [], 'roadmap') }))(),
    'unknown kind': (() => {
      const d = structuredClone(base);
      d.root.kind = 'tabset';
      return d;
    })(),
    'unknown dir': (() => {
      const d = structuredClone(base);
      d.root.dir = 'diagonal';
      return d;
    })(),
    'NaN ratio': (() => {
      const d = structuredClone(base);
      d.root.ratio = Number.NaN;
      return d;
    })(),
    'Infinite ratio': (() => {
      const d = structuredClone(base);
      d.root.ratio = Number.POSITIVE_INFINITY;
      return d;
    })(),
    'string ratio': (() => {
      const d = structuredClone(base);
      d.root.ratio = '0.5';
      return d;
    })(),
    'unsafe id with space': (() => {
      const d = structuredClone(base);
      d.root.second.id = 'evil id';
      return d;
    })(),
    'empty id': (() => {
      const d = structuredClone(base);
      d.root.second.id = '';
      return d;
    })(),
    'missing panels field': (() => {
      const d = structuredClone(base);
      delete d.root.second.panels;
      return d;
    })(),
    'missing split child': (() => {
      const d = structuredClone(base);
      delete d.root.first;
      return d;
    })(),
    'too many panels in one group': (() => ({
      version: 3,
      root: group('root', new Array(14).fill('roadmap'), 'roadmap'),
    }))(),
    'new session id rejected in v1': (() => ({
      version: 1,
      root: group('root', ['conversation', 'session'], 'conversation'),
    }))(),
    'new agents id rejected in v2': (() => ({
      version: 2,
      root: group('root', ['conversation', 'agents'], 'conversation'),
    }))(),
    'new files id rejected in v2': (() => ({
      version: 2,
      root: group('root', ['conversation', 'files'], 'conversation'),
    }))(),
  };
  for (const [name, input] of Object.entries(cases)) {
    assert.equal(validateLayout(input), null, `reject: ${name}`);
  }
});

test('validateLayout accepts the empty root (all panels closed)', () => {
  const empty = { version: 1, root: { kind: 'group', id: 'root', panels: [], active: null } };
  const clean = validateLayout(empty);
  assert.deepEqual(clean, { version: 4, root: { kind: 'group', id: 'root', panels: [], active: null } });
});

test('validateLayout accepts valid nested topologies (no arbitrary nesting ban)', () => {
  const nested = {
    version: 1,
    root: split(
      'main',
      'row',
      0.6,
      group('a', ['conversation'], 'conversation'),
      split('s2', 'column', 0.5, group('b', ['roadmap'], 'roadmap'), group('c', ['inspector'], 'inspector')),
    ),
  };
  const clean = validateLayout(nested);
  assert.ok(clean, '3-group nested tree is valid');
  assert.equal(clean.version, 4, 'legacy normalized to v4');
  assert.equal(nodeCount(clean), 5);
  assert.equal(groupsOf(clean).length, 3);
  assert.deepEqual(openPanels(clean).sort(), ['agents', 'conversation', 'files', 'roadmap', 'session']);
});

test('validateLayout is bounded on cyclic and huge inputs', () => {
  const cyclicExtra = {
    version: 1,
    root: { kind: 'group', id: 'a', panels: ['conversation'], active: 'conversation' },
  };
  cyclicExtra.root.self = cyclicExtra.root;
  // A cycle through a stripped extra field must not hang or throw; the
  // canonical output drops the extra field entirely.
  const stripped = validateLayout(cyclicExtra);
  assert.deepEqual(stripped, {
    version: 4,
    root: { kind: 'group', id: 'a', panels: ['conversation'], active: 'conversation' },
  });

  const a = { kind: 'split', id: 'loop-a', dir: 'row', ratio: 0.5, first: null, second: null };
  const b = { kind: 'split', id: 'loop-b', dir: 'row', ratio: 0.5, first: a, second: null };
  a.first = b;
  a.second = { kind: 'group', id: 'g', panels: ['conversation'], active: 'conversation' };
  b.second = { kind: 'group', id: 'h', panels: ['roadmap'], active: 'roadmap' };
  assert.equal(validateLayout({ version: 1, root: a }), null, 'mutual cycle rejected');

  let deep = { kind: 'group', id: 'leaf', panels: ['conversation'], active: 'conversation' };
  for (let i = 0; i < 10000; i += 1) {
    deep = {
      kind: 'split',
      id: `s${i}`,
      dir: 'row',
      ratio: 0.5,
      first: deep,
      second: { kind: 'group', id: `g${i}`, panels: [], active: null },
    };
  }
  const started = Date.now();
  assert.equal(validateLayout({ version: 1, root: deep }), null, '10k-deep chain rejected');
  assert.ok(Date.now() - started < 2000, 'deep chain rejected quickly');

  const wide = {
    version: 1,
    root: { kind: 'group', id: 'root', panels: new Array(200000).fill('x'), active: null },
  };
  assert.equal(validateLayout(wide), null, 'huge panels array rejected');

  const bigId = {
    version: 1,
    root: { kind: 'group', id: `g${'x'.repeat(100000)}`, panels: ['conversation'], active: 'conversation' },
  };
  assert.equal(validateLayout(bigId), null, 'giant id rejected');
});

test('movePanel center opens closed panels and moves across groups', () => {
  let doc = createDefaultLayout();
  doc = closePanel(doc, 'roadmap');
  assert.deepEqual(openPanels(doc), ['conversation', 'session', 'agents', 'files']);
  const reopened = movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group' });
  assert.deepEqual(openPanels(reopened).sort(), [...ALL].sort());
  const tools = findById(reopened, 'tools-group');
  assert.deepEqual(tools.panels, ['session', 'agents', 'files', 'roadmap'], 'omitted index appends');
  assert.equal(tools.active, 'roadmap', 'moved panel becomes active');

  const moved = movePanel(createDefaultLayout(), { panel: 'session', targetGroupId: 'conversation-group' });
  const conv = findById(moved, 'conversation-group');
  assert.deepEqual(conv.panels, ['conversation', 'session']);
  assert.equal(conv.active, 'session');
  assertInvariants(moved, 'cross-group center move');
});

test('movePanel center index semantics: reorder, clamp, document order', () => {
  const doc = createDefaultLayout();
  // tools-group is [roadmap, session, agents, files], active roadmap.
  const reordered = movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group', index: 2 });
  assert.deepEqual(findById(reordered, 'tools-group').panels, ['session', 'agents', 'roadmap', 'files']);
  assert.equal(findById(reordered, 'tools-group').active, 'roadmap');

  // Index counts AFTER removal: moving roadmap (at 0) to index 0 is a no-op positionally
  // but still activates (already active) => same reference.
  assert.strictEqual(
    movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group', index: 0 }),
    doc,
    'same position + same active => same ref',
  );

  // Moving session (at 1, not active) to index 1 keeps order but changes active => new doc.
  const activated = movePanel(doc, { panel: 'session', targetGroupId: 'tools-group', index: 1 });
  assert.notStrictEqual(activated, doc);
  assert.deepEqual(findById(activated, 'tools-group').panels, ['roadmap', 'session', 'agents', 'files']);
  assert.equal(findById(activated, 'tools-group').active, 'session');

  // Clamping: huge index appends, negative index prepends.
  const appended = movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group', index: 99 });
  assert.deepEqual(findById(appended, 'tools-group').panels, ['session', 'agents', 'files', 'roadmap']);
  const prepended = movePanel(doc, { panel: 'session', targetGroupId: 'tools-group', index: -5 });
  assert.deepEqual(findById(prepended, 'tools-group').panels, ['session', 'roadmap', 'agents', 'files']);

  // Same-group move without index keeps order => same reference.
  assert.strictEqual(movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group' }), doc);
});

test('movePanel center no-ops return the same doc', () => {
  const doc = createDefaultLayout();
  assert.strictEqual(movePanel(doc, { panel: 'nope', targetGroupId: 'tools-group' }), doc, 'unknown panel');
  assert.strictEqual(
    movePanel(doc, { panel: 'inspector', targetGroupId: 'tools-group' }),
    doc,
    'removed panel',
  );
  assert.strictEqual(movePanel(doc, { panel: 'roadmap', targetGroupId: 'missing' }), doc, 'unknown group');
  assert.strictEqual(
    movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group', zone: 'diagonal' }),
    doc,
    'unknown zone',
  );
  assert.strictEqual(
    movePanel(null, { panel: 'roadmap', targetGroupId: 'tools-group' }),
    null,
    'invalid doc passes through',
  );
});

test('movePanel edges split every direction with the panel on the right side', () => {
  const expectations = {
    left: { dir: 'row', first: ['session'] },
    right: { dir: 'row', first: ['conversation'] },
    top: { dir: 'column', first: ['session'] },
    bottom: { dir: 'column', first: ['conversation'] },
  };
  for (const [zone, want] of Object.entries(expectations)) {
    const doc = movePanel(createDefaultLayout(), {
      panel: 'session',
      targetGroupId: 'conversation-group',
      zone,
    });
    // The kept group keeps the target id; the fresh split (ratio 0.5) is its parent.
    const kept = findById(doc, 'conversation-group');
    assert.deepEqual(kept.panels, ['conversation']);
    const wrapper = parentOf(doc, 'conversation-group');
    assert.ok(
      wrapper.kind === 'split' && wrapper.dir === want.dir && wrapper.ratio === 0.5,
      `${zone}: split ${want.dir} @0.5`,
    );
    const firstPanels = wrapper.first.kind === 'group' ? wrapper.first.panels : null;
    assert.deepEqual(firstPanels, want.first, `${zone}: first child panels`);
    const movedGroup = wrapper.first.panels.includes('session') ? wrapper.first : wrapper.second;
    assert.deepEqual(movedGroup.panels, ['session'], `${zone}: moved panel alone in its group`);
    assert.equal(movedGroup.active, 'session', `${zone}: moved panel active`);
    assertInvariants(doc, `edge ${zone}`);
  }
});

test('movePanel edge works for closed panels', () => {
  let doc = closePanel(createDefaultLayout(), 'session');
  doc = movePanel(doc, { panel: 'session', targetGroupId: 'conversation-group', zone: 'right' });
  const kept = findById(doc, 'conversation-group');
  assert.deepEqual(kept.panels, ['conversation']);
  const wrapper = parentOf(doc, 'conversation-group');
  assert.equal(wrapper.kind, 'split');
  assert.equal(wrapper.dir, 'row');
  assert.deepEqual(collectPanels(wrapper).sort(), ['conversation', 'session']);
  assertInvariants(doc, 'edge open of closed panel');
});

test('movePanel edge onto the empty (all-closed) root inserts instead of splitting', () => {
  let doc = createDefaultLayout();
  for (const panel of ALL) doc = closePanel(doc, panel);
  assert.deepEqual(doc.root.panels, []);
  for (const zone of ['left', 'right', 'top', 'bottom', 'center']) {
    const out = movePanel(doc, { panel: 'roadmap', targetGroupId: doc.root.id, zone });
    assert.deepEqual(
      out.root,
      { kind: 'group', id: doc.root.id, panels: ['roadmap'], active: 'roadmap' },
      `zone ${zone}`,
    );
    assertInvariants(out, `empty-root edge ${zone}`);
  }
});

test('movePanel self-edge splits a multi-tab root group in place', () => {
  const single = validateLayout({
    version: 1,
    root: { kind: 'group', id: 'root', panels: ['conversation', 'roadmap'], active: 'conversation' },
  });
  const out = movePanel(single, { panel: 'roadmap', targetGroupId: 'root', zone: 'bottom' });
  assert.equal(out.root.kind, 'split');
  assert.equal(out.root.dir, 'column');
  assert.deepEqual(collectPanels(out.root.first), ['conversation']);
  assert.deepEqual(collectPanels(out.root.second), ['roadmap']);
  assertInvariants(out, 'root self-edge');
});

test('movePanel self-edge on a single-panel group is a no-op', () => {
  const doc = createDefaultLayout();
  for (const zone of ['left', 'right', 'top', 'bottom']) {
    assert.strictEqual(
      movePanel(doc, { panel: 'conversation', targetGroupId: 'conversation-group', zone }),
      doc,
      `self-edge ${zone} on single panel`,
    );
  }
});

test('movePanel self-edge on a multi-tab group splits that panel out', () => {
  const doc = createDefaultLayout();
  const out = movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group', zone: 'right' });
  const kept = findById(out, 'tools-group');
  assert.deepEqual(kept.panels, ['session', 'agents', 'files'], 'kept group keeps the target id');
  assert.equal(kept.active, 'session', 'kept group keeps a valid active');
  const wrapper = parentOf(out, 'tools-group');
  assert.equal(wrapper.kind, 'split');
  assert.equal(wrapper.dir, 'row');
  assert.deepEqual(collectPanels(wrapper.first), ['session', 'agents', 'files'], 'kept group first');
  assert.deepEqual(collectPanels(wrapper.second), ['roadmap'], 'moved panel second');
  assertInvariants(out, 'self-edge multitab');
});

test('movePanel collapses the emptied source group', () => {
  const nested = validateLayout({
    version: 3,
    root: split(
      'main',
      'row',
      0.6,
      group('conv', ['conversation'], 'conversation'),
      split('s2', 'column', 0.5, group('ga', ['roadmap'], 'roadmap'), group('gb', ['session'], 'session')),
    ),
  });
  const doc = movePanel(nested, { panel: 'session', targetGroupId: 'conv' });
  // gb emptied => s2 collapses to ga promoted in place.
  assert.deepEqual(doc.root.second, group('ga', ['roadmap'], 'roadmap'));
  assert.deepEqual(findById(doc, 'conv').panels, ['conversation', 'session']);
  assertInvariants(doc, 'source collapse');
});

test('movePanel ids are deterministic and unique', () => {
  const run = () =>
    movePanel(createDefaultLayout(), { panel: 'roadmap', targetGroupId: 'conversation-group', zone: 'left' });
  assert.deepEqual(run(), run(), 'same input + same op => same doc');
  const ids = collectNodeIds(run());
  assert.equal(ids.length, new Set(ids).size, 'unique ids');
  assert.ok(
    ids.some((id) => id.startsWith('split-')),
    'split-N allocator',
  );
  assert.ok(
    ids.some((id) => id.startsWith('group-')),
    'group-N allocator',
  );
});

test('activatePanel switches tabs and no-ops otherwise', () => {
  const doc = createDefaultLayout();
  const out = activatePanel(doc, 'session');
  assert.equal(findById(out, 'tools-group').active, 'session');
  assert.strictEqual(activatePanel(out, 'session'), out, 'already active => same ref');
  const closed = closePanel(doc, 'session');
  assert.strictEqual(activatePanel(closed, 'session'), closed, 'closed panel => same ref');
  assert.strictEqual(activatePanel(doc, 'nope'), doc, 'unknown panel => same ref');
  assert.strictEqual(activatePanel(doc, 'inspector'), doc, 'removed panel => same ref');
  assertInvariants(out, 'activate');
});

test('closePanel closes, collapses, empties root, and reopens', () => {
  let doc = createDefaultLayout();
  doc = closePanel(doc, 'session');
  assert.deepEqual(findById(doc, 'tools-group').panels, ['roadmap', 'agents', 'files']);
  assert.equal(findById(doc, 'tools-group').active, 'roadmap');
  assert.strictEqual(closePanel(doc, 'session'), doc, 'closing absent panel => same ref');

  // Close the active tab: active falls back to the first remaining panel.
  let tools2 = movePanel(createDefaultLayout(), {
    panel: 'agents',
    targetGroupId: 'tools-group',
    index: 0,
  });
  assert.equal(findById(tools2, 'tools-group').active, 'agents');
  tools2 = closePanel(tools2, 'agents');
  assert.deepEqual(findById(tools2, 'tools-group').panels, ['roadmap', 'session', 'files']);
  assert.equal(findById(tools2, 'tools-group').active, 'roadmap');

  // Emptying a nested group promotes its sibling; emptying the last group empties the root.
  for (const panel of ['session', 'agents', 'files']) doc = closePanel(doc, panel);
  assert.deepEqual(findById(doc, 'tools-group').panels, ['roadmap']);
  doc = closePanel(doc, 'roadmap');
  assert.equal(doc.root.kind, 'group', 'last nested collapse promotes sibling to root');
  assert.deepEqual(doc.root.panels, ['conversation']);
  doc = closePanel(doc, 'conversation');
  assert.deepEqual(doc.root, { kind: 'group', id: 'conversation-group', panels: [], active: null });
  assert.deepEqual(groupsOf(doc).length, 1);
  assertInvariants(doc, 'empty root');

  // Reopen from the empty root via a center move.
  const reopened = movePanel(doc, { panel: 'roadmap', targetGroupId: 'conversation-group' });
  assert.deepEqual(reopened.root.panels, ['roadmap']);
  assert.equal(reopened.root.active, 'roadmap');
  assertInvariants(reopened, 'reopened root');

  // Close every panel one by one from default => same empty shape (root keeps its id).
  let all = createDefaultLayout();
  for (const panel of ALL) all = closePanel(all, panel);
  assert.deepEqual(openPanels(all), []);
  assert.ok(validateLayout(all), 'all-closed validates');
});

test('resizeSplit sets, clamps, and no-ops', () => {
  const doc = createDefaultLayout();
  const out = resizeSplit(doc, 'main', 0.5);
  assert.equal(out.root.ratio, 0.5);
  assert.equal(resizeSplit(doc, 'main', 0.01).root.ratio, MIN_RATIO, 'clamp low');
  assert.equal(resizeSplit(doc, 'main', 0.99).root.ratio, MAX_RATIO, 'clamp high');
  assert.strictEqual(resizeSplit(doc, 'main', 0.68), doc, 'same value => same ref');
  assert.strictEqual(resizeSplit(doc, 'missing', 0.5), doc, 'unknown split => same ref');
  assert.strictEqual(resizeSplit(doc, 'main', Number.NaN), doc, 'NaN => same ref');
  assert.strictEqual(resizeSplit(doc, 'main', Number.POSITIVE_INFINITY), doc, 'Infinity => same ref');
  assert.strictEqual(resizeSplit(doc, 'tools-group', 0.5), doc, 'group id => same ref');
  assertInvariants(out, 'resize');
});

test('mutators never mutate their input', () => {
  const ops = [
    (doc) => movePanel(doc, { panel: 'session', targetGroupId: 'conversation-group' }),
    (doc) => movePanel(doc, { panel: 'roadmap', targetGroupId: 'conversation-group', zone: 'bottom' }),
    (doc) => movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group', index: 0 }),
    (doc) => activatePanel(doc, 'session'),
    (doc) => closePanel(doc, 'roadmap'),
    (doc) => resizeSplit(doc, 'main', 0.4),
  ];
  for (const op of ops) {
    const doc = createDefaultLayout();
    const before = structuredClone(doc);
    op(doc);
    assert.deepEqual(doc, before, 'input unchanged');
  }
});

test('deterministic random operations always preserve invariants', () => {
  for (const startSeed of [0x4d3c49, 0x12345678, 0xdeadbeef]) {
    fuzzRun(startSeed);
  }
});

function fuzzRun(startSeed) {
  let seed = startSeed;
  const random = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(random() * arr.length)];
  const zones = ['center', 'left', 'right', 'top', 'bottom'];

  let doc = createDefaultLayout();
  for (let i = 0; i < 500; i += 1) {
    const kind = random();
    const groups = groupsOf(doc);
    const target = pick(groups).id;
    if (kind < 0.55) {
      const op = { panel: pick(ALL), targetGroupId: target, zone: pick(zones) };
      if (random() < 0.4) op.index = Math.floor(random() * 5) - 1;
      doc = movePanel(doc, op);
    } else if (kind < 0.7) {
      doc = activatePanel(doc, pick(ALL));
    } else if (kind < 0.85) {
      doc = closePanel(doc, pick(ALL));
    } else {
      const ids = collectNodeIds(doc);
      doc = resizeSplit(doc, pick(ids), random() * 1.2 - 0.1);
    }
    assertInvariants(doc, `seed ${startSeed.toString(16)} step ${i}`);
  }
}

// --- local helpers (test-only tree navigation) ---

function findById(doc, id) {
  const stack = [doc.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.id === id) return node;
    if (node.kind === 'split') stack.push(node.first, node.second);
  }
  throw new Error(`missing node ${id}`);
}

function collectPanels(node) {
  const out = [];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.kind === 'group') out.push(...current.panels);
    else stack.push(current.first, current.second);
  }
  return out;
}

function parentOf(doc, id) {
  const stack = [{ node: doc.root, parent: null }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop();
    if (node.id === id) return parent;
    if (node.kind === 'split') {
      stack.push({ node: node.first, parent: node });
      stack.push({ node: node.second, parent: node });
    }
  }
  throw new Error(`missing node ${id}`);
}

test('validateLayout normalizes v1 to frozen v4 with inspector migrated in place', () => {
  const v1 = {
    version: 1,
    root: split(
      'main',
      'row',
      0.68,
      group('conversation-group', ['conversation'], 'conversation'),
      split('s2', 'column', 0.5, group('b', ['roadmap'], 'roadmap'), group('c', ['inspector'], 'inspector')),
    ),
  };
  const clean = validateLayout(v1);
  assert.ok(clean, 'v1 accepted');
  assert.equal(clean.version, 4, 'normalized to v4');
  assert.deepEqual(
    findById(clean, 'c').panels,
    ['session', 'agents', 'files'],
    'inspector replaced in place',
  );
  assert.equal(findById(clean, 'c').active, 'session', 'active inspector becomes session');
  assert.ok(Object.isFrozen(clean) && Object.isFrozen(clean.root), 'frozen');
  assert.deepEqual(validateLayout(clean), clean, 'v4 output revalidates identically');
});

test('legacy migration replaces inspector in place (v1 default becomes v4 default)', () => {
  const v1Default = {
    version: 1,
    root: split(
      'main',
      'row',
      0.68,
      group('conversation-group', ['conversation'], 'conversation'),
      group('tools-group', ['roadmap', 'inspector'], 'roadmap'),
    ),
  };
  assert.deepEqual(validateLayout(v1Default), createDefaultLayout(), 'v1 default migrates to the v4 default');
});

test('legacy migration keeps position when inspector sits mid-group (active follows)', () => {
  const v1 = {
    version: 1,
    root: group('root', ['roadmap', 'inspector', 'conversation'], 'inspector'),
  };
  const clean = validateLayout(v1);
  assert.ok(clean, 'v1 accepted');
  assert.equal(clean.version, 4);
  assert.deepEqual(clean.root.panels, ['roadmap', 'session', 'agents', 'files', 'conversation']);
  assert.equal(clean.root.active, 'session');
  assertInvariants(clean, 'migrated mid-group inspector');
});

test('legacy v2 migration preserves prefs and dynamic conv refs around inspector', () => {
  const v2 = {
    version: 2,
    root: split(
      'main',
      'row',
      0.5,
      group('a', ['conversation', 'conv:live-1'], 'conv:live-1'),
      group('b', ['roadmap', 'inspector', 'preferences', 'conv:live-2'], 'inspector'),
    ),
  };
  const clean = validateLayout(v2);
  assert.ok(clean, 'v2 accepted');
  assert.equal(clean.version, 4);
  assert.deepEqual(findById(clean, 'a').panels, ['conversation', 'conv:live-1']);
  assert.equal(findById(clean, 'a').active, 'conv:live-1');
  assert.deepEqual(findById(clean, 'b').panels, [
    'roadmap',
    'session',
    'agents',
    'files',
    'preferences',
    'conv:live-2',
  ]);
  assert.equal(findById(clean, 'b').active, 'session', 'active inspector becomes session');
  assertInvariants(clean, 'migrated v2 with prefs and conv refs');
});

test('v3 and v4 reject inspector but mutators treat it as an unknown no-op panel', () => {
  const withInspector = {
    version: 3,
    root: group('root', ['conversation', 'inspector'], 'conversation'),
  };
  assert.equal(validateLayout(withInspector), null, 'inspector rejected in v3');
  assert.equal(
    validateLayout({ version: 4, root: group('root', ['conversation', 'inspector'], 'conversation') }),
    null,
    'inspector rejected in v4',
  );
  const doc = createDefaultLayout();
  assert.strictEqual(movePanel(doc, { panel: 'inspector', targetGroupId: 'tools-group' }), doc, 'move no-op');
  assert.strictEqual(closePanel(doc, 'inspector'), doc, 'close no-op');
  assert.strictEqual(activatePanel(doc, 'inspector'), doc, 'activate no-op');
});

test('validateLayout rejects conv: refs and preferences in v1 only', () => {
  const withConv = {
    version: 1,
    root: group('root', ['conversation', 'conv:tab-1'], 'conversation'),
  };
  assert.equal(validateLayout(withConv), null, 'conv: ref rejected in v1');
  const withPrefs = {
    version: 1,
    root: group('root', ['conversation', 'preferences'], 'conversation'),
  };
  assert.equal(validateLayout(withPrefs), null, 'preferences rejected in v1');
  const v2Conv = { ...structuredClone(withConv), version: 2 };
  assert.ok(validateLayout(v2Conv), 'conv: ref accepted in v2');
  const v2Prefs = { ...structuredClone(withPrefs), version: 2 };
  assert.ok(validateLayout(v2Prefs), 'preferences accepted in v2');
  const v3Conv = { ...structuredClone(withConv), version: 3 };
  assert.ok(validateLayout(v3Conv), 'conv: ref accepted in v3');
  const v3Prefs = { ...structuredClone(withPrefs), version: 3 };
  assert.ok(validateLayout(v3Prefs), 'preferences accepted in v3');
  const v4Conv = { ...structuredClone(withConv), version: 4 };
  assert.ok(validateLayout(v4Conv), 'conv: ref accepted in v4');
  const v4Prefs = { ...structuredClone(withPrefs), version: 4 };
  assert.ok(validateLayout(v4Prefs), 'preferences accepted in v4');
  const toolDoc = (version, panels) => validateLayout({ version, root: group('root', panels, panels[0]) });
  assert.equal(toolDoc(1, ['conversation', 'tool:roadmap:n1']), null, 'tool: ref rejected in v1');
  assert.equal(toolDoc(2, ['conversation', 'tool:roadmap:n1']), null, 'tool: ref rejected in v2');
  assert.equal(toolDoc(3, ['conversation', 'tool:roadmap:n1']), null, 'tool: ref rejected in v3');
  assert.ok(toolDoc(4, ['conversation', 'tool:roadmap:n1']), 'tool: ref accepted in v4');
  assert.equal(toolDoc(4, ['conversation', 'tool:bogus:n1']), null, 'unknown tool kind rejected in v4');
  for (const fresh of ['session', 'agents', 'files']) {
    assert.equal(
      validateLayout({ version: 1, root: group('root', ['conversation', fresh], 'conversation') }),
      null,
      `${fresh} rejected in v1`,
    );
    assert.equal(
      validateLayout({ version: 2, root: group('root', ['conversation', fresh], 'conversation') }),
      null,
      `${fresh} rejected in v2`,
    );
    assert.ok(
      validateLayout({ version: 3, root: group('root', ['conversation', fresh], 'conversation') }),
      `${fresh} accepted in v3`,
    );
  }
});

test('validateLayout rejects unknown versions', () => {
  const base = createDefaultLayout();
  for (const version of [0, 5, 99, '4', null, undefined]) {
    assert.equal(
      validateLayout({ ...structuredClone(base), version }),
      null,
      `version ${String(version)} rejected`,
    );
  }
});

test('preferences docks as a closable singleton', () => {
  let doc = createDefaultLayout();
  assert.ok(!openPanels(doc).includes('preferences'), 'closed by default');
  doc = movePanel(doc, { panel: 'preferences', targetGroupId: 'tools-group' });
  assert.deepEqual(findById(doc, 'tools-group').panels, [
    'roadmap',
    'session',
    'agents',
    'files',
    'preferences',
  ]);
  assert.equal(findById(doc, 'tools-group').active, 'preferences');
  assertInvariants(doc, 'preferences opened');
  const closed = closePanel(doc, 'preferences');
  assert.ok(!openPanels(closed).includes('preferences'), 'closed again');
  assertInvariants(closed, 'preferences closed');
  assert.strictEqual(closePanel(closed, 'preferences'), closed, 'reclose is a no-op');
});

function convIds(n) {
  const ids = ['conversation'];
  for (let i = 1; i < n; i += 1) ids.push(`conv:t${i}`);
  return ids;
}

test('v3 docs migrate to frozen v4 unchanged (no tool refs yet)', () => {
  const v3 = {
    version: 3,
    root: split(
      'main',
      'row',
      0.68,
      group('conversation-group', ['conversation'], 'conversation'),
      group('tools-group', ['roadmap', 'session', 'agents', 'files'], 'roadmap'),
    ),
  };
  const clean = validateLayout(v3);
  assert.ok(clean, 'v3 accepted');
  assert.equal(clean.version, 4, 'normalized to v4');
  assert.deepEqual(clean, createDefaultLayout(), 'v3 default migrates to the v4 default');
  assert.deepEqual(validateLayout(clean), clean, 'v4 output revalidates identically');
});

test('fixed primaries stay addressable while dynamic tool instances open beside them', () => {
  let doc = validateLayout({
    version: 4,
    root: split(
      'main',
      'row',
      0.5,
      group('a', ['roadmap', 'tool:roadmap:n1'], 'roadmap'),
      group('b', ['conversation'], 'conversation'),
    ),
  });
  assert.ok(doc, 'tool instance validates');
  doc = movePanel(doc, { panel: 'tool:roadmap:n2', targetGroupId: 'b' });
  assert.deepEqual(findById(doc, 'b').panels, ['conversation', 'tool:roadmap:n2']);
  assert.equal(findById(doc, 'b').active, 'tool:roadmap:n2');
  doc = activatePanel(doc, 'tool:roadmap:n1');
  assert.equal(findById(doc, 'a').active, 'tool:roadmap:n1');
  assert.strictEqual(activatePanel(doc, 'tool:roadmap:missing'), doc, 'unknown tool ref no-op');
  doc = closePanel(doc, 'tool:roadmap:n1');
  assert.deepEqual(openPanels(doc).sort(), ['conversation', 'roadmap', 'tool:roadmap:n2']);
  assertInvariants(doc, 'tool instance lifecycle');
});

function toolIds(kind, n, prefix = 'n') {
  const ids = [];
  for (let i = 0; i < n; i += 1) ids.push(`tool:${kind}:${prefix}${i}`);
  return ids;
}

test('tool bound: 16 tool tabs validate, the 17th is rejected', () => {
  const sixteen = {
    version: 4,
    root: group(
      'root',
      ['roadmap', 'session', 'agents', 'files', 'preferences', ...toolIds('roadmap', 11)],
      'roadmap',
    ),
  };
  const clean = validateLayout(sixteen);
  assert.ok(clean, '16 tool tabs validate');
  assertInvariants(clean, '16 tool tabs');
  const seventeen = {
    version: 4,
    root: group(
      'root',
      ['roadmap', 'session', 'agents', 'files', 'preferences', ...toolIds('roadmap', 12)],
      'roadmap',
    ),
  };
  assert.equal(validateLayout(seventeen), null, '17 tool tabs rejected');
  // Full house: 16 conversations + 16 tools = 32 tabs validate.
  const full = {
    version: 4,
    root: split(
      'main',
      'row',
      0.5,
      group('a', convIds(16), 'conversation'),
      group(
        'b',
        ['roadmap', 'session', 'agents', 'files', 'preferences', ...toolIds('session', 11)],
        'roadmap',
      ),
    ),
  };
  const fullClean = validateLayout(full);
  assert.ok(fullClean, '32 tabs validate');
  assertInvariants(fullClean, 'full house');
});

test('conversation bound: 16 instances validate, the 17th is rejected', () => {
  const sixteen = {
    version: 3,
    root: group('root', convIds(16), 'conversation'),
  };
  const clean = validateLayout(sixteen);
  assert.ok(clean, '16 conversations validate');
  assertInvariants(clean, '16 conversations');
  const seventeen = {
    version: 3,
    root: group('root', convIds(17), 'conversation'),
  };
  assert.equal(validateLayout(seventeen), null, '17 conversations rejected');
  // Full house: 16 conversations + 5 singletons = 21 tabs validate.
  const full = {
    version: 3,
    root: split(
      'main',
      'row',
      0.5,
      group('a', convIds(16), 'conversation'),
      group('b', ['roadmap', 'session', 'agents', 'files', 'preferences'], 'roadmap'),
    ),
  };
  const fullClean = validateLayout(full);
  assert.ok(fullClean, '21 tabs validate');
  assertInvariants(fullClean, 'full house');
});

test('duplicate conversation refs are rejected', () => {
  const doubled = {
    version: 3,
    root: split(
      'main',
      'row',
      0.5,
      group('a', ['conversation', 'conv:t1'], 'conversation'),
      group('b', ['conv:t1', 'roadmap'], 'roadmap'),
    ),
  };
  assert.equal(validateLayout(doubled), null, 'duplicate conv: ref across groups');
  const same = {
    version: 3,
    root: group('root', ['conv:t1', 'conv:t1'], 'conv:t1'),
  };
  assert.equal(validateLayout(same), null, 'duplicate conv: ref in one group');
});

test('mutators support dynamic conv refs alongside the fixed set', () => {
  let doc = validateLayout({
    version: 3,
    root: split(
      'main',
      'row',
      0.5,
      group('a', ['conversation', 'roadmap'], 'conversation'),
      group('b', ['conv:t1', 'session'], 'conv:t1'),
    ),
  });
  doc = movePanel(doc, { panel: 'conv:t1', targetGroupId: 'a' });
  assert.deepEqual(findById(doc, 'a').panels, ['conversation', 'roadmap', 'conv:t1']);
  assert.equal(findById(doc, 'a').active, 'conv:t1');
  assertInvariants(doc, 'dynamic cross-group move');
  doc = activatePanel(doc, 'roadmap');
  assert.equal(findById(doc, 'a').active, 'roadmap');
  assert.strictEqual(activatePanel(doc, 'conv:missing'), doc, 'unknown dynamic ref no-op');
  doc = closePanel(doc, 'conv:t1');
  assert.deepEqual(openPanels(doc).sort(), ['conversation', 'roadmap', 'session']);
  assertInvariants(doc, 'dynamic close');
  doc = movePanel(doc, { panel: 'conv:t2', targetGroupId: 'b', zone: 'right' });
  assert.ok(openPanels(doc).includes('conv:t2'), 'closed dynamic ref opens via edge');
  assertInvariants(doc, 'dynamic edge open');
});

test('mutators normalize legacy input to v4 (migrating inspector)', () => {
  const v1 = {
    version: 1,
    root: split(
      'main',
      'row',
      0.68,
      group('conversation-group', ['conversation'], 'conversation'),
      group('tools-group', ['roadmap', 'inspector'], 'roadmap'),
    ),
  };
  const moved = movePanel(v1, { panel: 'session', targetGroupId: 'conversation-group' });
  assert.equal(moved.version, 4, 'move normalizes to v4');
  assert.deepEqual(findById(moved, 'conversation-group').panels, ['conversation', 'session']);
  assertInvariants(moved, 'v1 move');
  const closed = closePanel(v1, 'roadmap');
  assert.equal(closed.version, 4, 'close normalizes to v4');
  assert.deepEqual(findById(closed, 'tools-group').panels, ['session', 'agents', 'files']);
  const active = activatePanel(v1, 'session');
  assert.equal(active.version, 4, 'activate normalizes to v4');
  assert.equal(findById(active, 'tools-group').active, 'session');
  const v2 = {
    version: 2,
    root: split(
      'main',
      'row',
      0.68,
      group('conversation-group', ['conversation'], 'conversation'),
      group('tools-group', ['roadmap', 'inspector', 'preferences'], 'roadmap'),
    ),
  };
  const moved2 = movePanel(v2, { panel: 'preferences', targetGroupId: 'conversation-group' });
  assert.equal(moved2.version, 4, 'v2 move normalizes to v4');
  assert.deepEqual(findById(moved2, 'tools-group').panels, ['roadmap', 'session', 'agents', 'files']);
  assertInvariants(moved2, 'v2 move');
});

test('random operations over v4 ids preserve invariants', () => {
  const pool = [
    'conversation',
    'conv:t1',
    'conv:t2',
    'roadmap',
    'session',
    'agents',
    'files',
    'preferences',
    'tool:roadmap:n1',
    'tool:roadmap:n2',
    'tool:session:n1',
    'tool:agents:n1',
    'tool:files:n1',
    'tool:preferences:n1',
  ];
  const zones = ['center', 'left', 'right', 'top', 'bottom'];
  let seed = 0x2f6e2b21;
  const random = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(random() * arr.length)];
  let doc = createDefaultLayout();
  for (let i = 0; i < 400; i += 1) {
    const kind = random();
    const groups = groupsOf(doc);
    const target = pick(groups).id;
    if (kind < 0.55) {
      const op = { panel: pick(pool), targetGroupId: target, zone: pick(zones) };
      if (random() < 0.4) op.index = Math.floor(random() * 5) - 1;
      doc = movePanel(doc, op);
    } else if (kind < 0.7) {
      doc = activatePanel(doc, pick(pool));
    } else if (kind < 0.85) {
      doc = closePanel(doc, pick(pool));
    } else {
      const ids = collectNodeIds(doc);
      doc = resizeSplit(doc, pick(ids), random() * 1.2 - 0.1);
    }
    assertInvariants(doc, `v4 fuzz step ${i}`);
  }
});

// --- Restore-preservation regression (root review blocker) ------------------
// A persisted layout with tool refs spread over several groups must survive
// the initial createDocking restore byte-identical: same panels, same order,
// same ratios, same actives. The dock registers supplied roots in place and
// prunes ONLY still-missing refs; it must never relocate a restored pane
// (no movePanel into a first group, which would collapse splits).
test('restore-preservation: tool refs across groups validate byte-identical', () => {
  const stored = {
    version: 4,
    root: split(
      'main',
      'row',
      0.6,
      split(
        'left',
        'column',
        0.4,
        group('ga', ['conversation', 'tool:roadmap:n1'], 'tool:roadmap:n1'),
        group('gb', ['tool:session:n2', 'roadmap'], 'roadmap'),
      ),
      group('gc', ['tool:files:n3', 'agents', 'tool:roadmap:n4'], 'tool:files:n3'),
    ),
  };
  const clean = validateLayout(stored);
  assert.ok(clean, 'multi-group tool layout validates');
  // Registration keeps the tree: every ref present means zero closes.
  const present = new Set([
    'conversation',
    'tool:roadmap:n1',
    'tool:session:n2',
    'roadmap',
    'tool:files:n3',
    'agents',
    'tool:roadmap:n4',
  ]);
  let next = clean;
  for (const id of groupsOf(next).flatMap((group) => group.panels))
    if (!present.has(id)) next = closePanel(next, id);
  assert.strictEqual(next, clean, 'fully-supplied restore prunes nothing (same ref)');
  assert.deepEqual(
    groupsOf(next).map((group) => [group.id, group.panels, group.active]),
    [
      ['ga', ['conversation', 'tool:roadmap:n1'], 'tool:roadmap:n1'],
      ['gb', ['tool:session:n2', 'roadmap'], 'roadmap'],
      ['gc', ['tool:files:n3', 'agents', 'tool:roadmap:n4'], 'tool:files:n3'],
    ],
    'panels, order and actives preserved per group',
  );
  assert.equal(findById(next, 'main').ratio, 0.6, 'root ratio preserved');
  assert.equal(findById(next, 'left').ratio, 0.4, 'nested ratio preserved');
  // Only still-missing roots prune, and only their own branch collapses.
  const partial = new Set([...present].filter((id) => id !== 'tool:session:n2'));
  let pruned = clean;
  for (const id of groupsOf(pruned).flatMap((group) => group.panels))
    if (!partial.has(id)) pruned = closePanel(pruned, id);
  assert.deepEqual(findById(pruned, 'gb').panels, ['roadmap'], 'missing ref pruned in place');
  assert.equal(findById(pruned, 'gb').active, 'roadmap', 'active falls back inside its group');
  assert.deepEqual(findById(pruned, 'ga').panels, ['conversation', 'tool:roadmap:n1']);
  assert.deepEqual(findById(pruned, 'gc').panels, ['tool:files:n3', 'agents', 'tool:roadmap:n4']);
  assert.equal(findById(pruned, 'main').ratio, 0.6, 'unrelated splits untouched');
  assertInvariants(pruned, 'partial restore');
});

test('dock restore path relocates nothing (source regression)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../public/docking.js', import.meta.url), 'utf8');
  const start = source.indexOf('Synchronous prune-time restore');
  assert.ok(start >= 0, 'restore block must exist');
  const end = source.indexOf('refreshDialog();', start);
  assert.ok(end > start, 'restore block must end before final refresh');
  const block = source.slice(start, end);
  assert.match(block, /registerPanel/, 'restore registers supplied roots');
  assert.match(block, /closePanel/, 'restore prunes only still-missing roots');
  assert.doesNotMatch(block, /movePanel/, 'restore never relocates panes across groups');
  assert.doesNotMatch(block, /openPanel/, 'restore never reopens panes elsewhere');
});
