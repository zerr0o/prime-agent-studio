import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_IDS,
  MAX_CONVERSATIONS,
  MIN_RATIO,
  MAX_RATIO,
  isConversationPanel,
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
// (the old whole `inspector` panel is gone in geometry V3; its former tabs dock
// as three separate panels). Preferences and dynamic conv: refs mount on
// demand; geometry V3 caps live conversations at MAX_CONVERSATIONS (legacy
// primary included).
const ALL = ['conversation', 'roadmap', 'session', 'agents', 'files'];
const MAX_TABS = 5 + MAX_CONVERSATIONS;
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

test('PANEL_IDS is the fixed V3 set and ratios bound splits', () => {
  assert.deepEqual([...PANEL_IDS], ['conversation', 'roadmap', 'session', 'agents', 'files', 'preferences']);
  assert.equal(MAX_CONVERSATIONS, 8);
  assert.equal(MIN_RATIO, 0.15);
  assert.equal(MAX_RATIO, 0.85);
});

test('panel id helpers classify singletons, legacy, and dynamic refs', () => {
  assert.ok(isConversationPanel('conversation'), 'legacy primary');
  assert.ok(isConversationPanel('conv:a'), 'dynamic ref');
  assert.ok(isConversationPanel('conv:slot-12'), 'dynamic ref');
  assert.ok(isConversationPanel('conv:Aa0-_'), 'charset');
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
  assert.equal(isPanelId('inspector'), false, 'removed whole-inspector panel rejected');
  assert.equal(isPanelId('conv:'), false, 'bad ref');
});

test('default layout matches the contract', () => {
  const doc = createDefaultLayout();
  assert.equal(doc.version, 3);
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
    'wrong version': { ...structuredClone(base), version: 4 },
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
  assert.deepEqual(clean, { version: 3, root: { kind: 'group', id: 'root', panels: [], active: null } });
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
  assert.equal(clean.version, 3, 'legacy normalized to v3');
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
    version: 3,
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

test('validateLayout normalizes v1 to frozen v3 with inspector migrated in place', () => {
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
  assert.equal(clean.version, 3, 'normalized to v3');
  assert.deepEqual(
    findById(clean, 'c').panels,
    ['session', 'agents', 'files'],
    'inspector replaced in place',
  );
  assert.equal(findById(clean, 'c').active, 'session', 'active inspector becomes session');
  assert.ok(Object.isFrozen(clean) && Object.isFrozen(clean.root), 'frozen');
  assert.deepEqual(validateLayout(clean), clean, 'v3 output revalidates identically');
});

test('legacy migration replaces inspector in place (v1 default becomes v3 default)', () => {
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
  assert.deepEqual(validateLayout(v1Default), createDefaultLayout(), 'v1 default migrates to the v3 default');
});

test('legacy migration keeps position when inspector sits mid-group (active follows)', () => {
  const v1 = {
    version: 1,
    root: group('root', ['roadmap', 'inspector', 'conversation'], 'inspector'),
  };
  const clean = validateLayout(v1);
  assert.ok(clean, 'v1 accepted');
  assert.equal(clean.version, 3);
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
  assert.equal(clean.version, 3);
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

test('v3 rejects inspector but mutators treat it as an unknown no-op panel', () => {
  const withInspector = {
    version: 3,
    root: group('root', ['conversation', 'inspector'], 'conversation'),
  };
  assert.equal(validateLayout(withInspector), null, 'inspector rejected in v3');
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
  for (const version of [0, 4, 99, '3', null, undefined]) {
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

test('conversation bound: 8 instances validate, the 9th is rejected', () => {
  const eight = {
    version: 3,
    root: group('root', convIds(8), 'conversation'),
  };
  const clean = validateLayout(eight);
  assert.ok(clean, '8 conversations validate');
  assertInvariants(clean, '8 conversations');
  const nine = {
    version: 3,
    root: group('root', convIds(9), 'conversation'),
  };
  assert.equal(validateLayout(nine), null, '9 conversations rejected');
  // Full house: 8 conversations + 5 singletons = 13 tabs validate.
  const full = {
    version: 3,
    root: split(
      'main',
      'row',
      0.5,
      group('a', convIds(8), 'conversation'),
      group('b', ['roadmap', 'session', 'agents', 'files', 'preferences'], 'roadmap'),
    ),
  };
  const fullClean = validateLayout(full);
  assert.ok(fullClean, '13 tabs validate');
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

test('mutators normalize legacy input to v3 (migrating inspector)', () => {
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
  assert.equal(moved.version, 3, 'move normalizes to v3');
  assert.deepEqual(findById(moved, 'conversation-group').panels, ['conversation', 'session']);
  assertInvariants(moved, 'v1 move');
  const closed = closePanel(v1, 'roadmap');
  assert.equal(closed.version, 3, 'close normalizes to v3');
  assert.deepEqual(findById(closed, 'tools-group').panels, ['session', 'agents', 'files']);
  const active = activatePanel(v1, 'session');
  assert.equal(active.version, 3, 'activate normalizes to v3');
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
  assert.equal(moved2.version, 3, 'v2 move normalizes to v3');
  assert.deepEqual(findById(moved2, 'tools-group').panels, ['roadmap', 'session', 'agents', 'files']);
  assertInvariants(moved2, 'v2 move');
});

test('random operations over v3 ids preserve invariants', () => {
  const pool = ['conversation', 'conv:t1', 'conv:t2', 'roadmap', 'session', 'agents', 'files', 'preferences'];
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
    assertInvariants(doc, `v3 fuzz step ${i}`);
  }
});
