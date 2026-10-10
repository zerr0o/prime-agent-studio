import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_IDS,
  MIN_RATIO,
  MAX_RATIO,
  createDefaultLayout,
  validateLayout,
  groupsOf,
  movePanel,
  activatePanel,
  closePanel,
  resizeSplit,
} from '../public/docking-layout.js';

// Slice 1 panel set: conversation + roadmap + whole inspector (its internal
// Session/Agents/Files tabs stay inside the inspector, untouched).
const ALL = ['conversation', 'roadmap', 'inspector'];

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
  for (const panel of open) assert.ok(PANEL_IDS.includes(panel), `${label}: known panel`);
  const groups = groupsOf(doc);
  assert.ok(groups.length <= PANEL_IDS.length, `${label}: groups <= N`);
  assert.ok(nodeCount(doc) <= 2 * PANEL_IDS.length - 1, `${label}: nodes <= 2N-1`);
  assert.ok(splitDepth(doc) <= 2 * PANEL_IDS.length - 1, `${label}: depth bounded`);
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

test('PANEL_IDS is the 3-panel slice and ratios bound splits', () => {
  assert.deepEqual([...PANEL_IDS], ALL);
  assert.equal(MIN_RATIO, 0.15);
  assert.equal(MAX_RATIO, 0.85);
});

test('default layout matches the contract', () => {
  const doc = createDefaultLayout();
  assert.equal(doc.version, 1);
  assert.equal(doc.root.kind, 'split');
  assert.equal(doc.root.id, 'main');
  assert.equal(doc.root.dir, 'row');
  assert.equal(doc.root.ratio, 0.68);
  assert.deepEqual(doc.root.first, group('conversation-group', ['conversation'], 'conversation'));
  assert.deepEqual(doc.root.second, group('tools-group', ['roadmap', 'inspector'], 'roadmap'));
  assert.ok(validateLayout(doc), 'default validates');
  assert.deepEqual(
    groupsOf(doc).map((g) => g.id),
    ['conversation-group', 'tools-group'],
  );
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
    'wrong version': { ...structuredClone(base), version: 2 },
    'missing version': { root: base.root },
    'missing root': { version: 1 },
    'unknown panel (old 5-view id)': (() => {
      const d = structuredClone(base);
      d.root.second.panels.push('agents');
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
      version: 1,
      root: group('root', ['conversation', 'roadmap', 'inspector', 'conversation'], 'conversation'),
    }))(),
  };
  for (const [name, input] of Object.entries(cases)) {
    assert.equal(validateLayout(input), null, `reject: ${name}`);
  }
});

test('validateLayout accepts the empty root (all panels closed)', () => {
  const empty = { version: 1, root: { kind: 'group', id: 'root', panels: [], active: null } };
  const clean = validateLayout(empty);
  assert.deepEqual(clean, empty);
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
  assert.equal(nodeCount(clean), 5);
  assert.equal(groupsOf(clean).length, 3);
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
    version: 1,
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
  assert.deepEqual(openPanels(doc), ['conversation', 'inspector']);
  const reopened = movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group' });
  assert.deepEqual(openPanels(reopened).sort(), [...ALL].sort());
  const tools = findById(reopened, 'tools-group');
  assert.deepEqual(tools.panels, ['inspector', 'roadmap'], 'omitted index appends');
  assert.equal(tools.active, 'roadmap', 'moved panel becomes active');

  const moved = movePanel(createDefaultLayout(), { panel: 'inspector', targetGroupId: 'conversation-group' });
  const conv = findById(moved, 'conversation-group');
  assert.deepEqual(conv.panels, ['conversation', 'inspector']);
  assert.equal(conv.active, 'inspector');
  assertInvariants(moved, 'cross-group center move');
});

test('movePanel center index semantics: reorder, clamp, document order', () => {
  const doc = createDefaultLayout();
  // tools-group is [roadmap, inspector], active roadmap.
  const reordered = movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group', index: 1 });
  assert.deepEqual(findById(reordered, 'tools-group').panels, ['inspector', 'roadmap']);
  assert.equal(findById(reordered, 'tools-group').active, 'roadmap');

  // Index counts AFTER removal: moving roadmap (at 0) to index 0 is a no-op positionally
  // but still activates (already active) => same reference.
  assert.strictEqual(
    movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group', index: 0 }),
    doc,
    'same position + same active => same ref',
  );

  // Moving inspector (at 1, not active) to index 1 keeps order but changes active => new doc.
  const activated = movePanel(doc, { panel: 'inspector', targetGroupId: 'tools-group', index: 1 });
  assert.notStrictEqual(activated, doc);
  assert.deepEqual(findById(activated, 'tools-group').panels, ['roadmap', 'inspector']);
  assert.equal(findById(activated, 'tools-group').active, 'inspector');

  // Clamping: huge index appends, negative index prepends.
  const appended = movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group', index: 99 });
  assert.deepEqual(findById(appended, 'tools-group').panels, ['inspector', 'roadmap']);
  const prepended = movePanel(doc, { panel: 'inspector', targetGroupId: 'tools-group', index: -5 });
  assert.deepEqual(findById(prepended, 'tools-group').panels, ['inspector', 'roadmap']);

  // Same-group move without index keeps order => same reference.
  assert.strictEqual(movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group' }), doc);
});

test('movePanel center no-ops return the same doc', () => {
  const doc = createDefaultLayout();
  assert.strictEqual(movePanel(doc, { panel: 'nope', targetGroupId: 'tools-group' }), doc, 'unknown panel');
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
    left: { dir: 'row', first: ['inspector'] },
    right: { dir: 'row', first: ['conversation'] },
    top: { dir: 'column', first: ['inspector'] },
    bottom: { dir: 'column', first: ['conversation'] },
  };
  for (const [zone, want] of Object.entries(expectations)) {
    const doc = movePanel(createDefaultLayout(), {
      panel: 'inspector',
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
    const movedGroup = wrapper.first.panels.includes('inspector') ? wrapper.first : wrapper.second;
    assert.deepEqual(movedGroup.panels, ['inspector'], `${zone}: moved panel alone in its group`);
    assert.equal(movedGroup.active, 'inspector', `${zone}: moved panel active`);
    assertInvariants(doc, `edge ${zone}`);
  }
});

test('movePanel edge works for closed panels', () => {
  let doc = closePanel(createDefaultLayout(), 'inspector');
  doc = movePanel(doc, { panel: 'inspector', targetGroupId: 'conversation-group', zone: 'right' });
  const kept = findById(doc, 'conversation-group');
  assert.deepEqual(kept.panels, ['conversation']);
  const wrapper = parentOf(doc, 'conversation-group');
  assert.equal(wrapper.kind, 'split');
  assert.equal(wrapper.dir, 'row');
  assert.deepEqual(collectPanels(wrapper).sort(), ['conversation', 'inspector']);
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
  assert.deepEqual(kept.panels, ['inspector'], 'kept group keeps the target id');
  assert.equal(kept.active, 'inspector', 'kept group keeps a valid active');
  const wrapper = parentOf(out, 'tools-group');
  assert.equal(wrapper.kind, 'split');
  assert.equal(wrapper.dir, 'row');
  assert.deepEqual(collectPanels(wrapper.first), ['inspector'], 'kept group first');
  assert.deepEqual(collectPanels(wrapper.second), ['roadmap'], 'moved panel second');
  assertInvariants(out, 'self-edge multitab');
});

test('movePanel collapses the emptied source group', () => {
  const nested = validateLayout({
    version: 1,
    root: split(
      'main',
      'row',
      0.6,
      group('conv', ['conversation'], 'conversation'),
      split(
        's2',
        'column',
        0.5,
        group('ga', ['roadmap'], 'roadmap'),
        group('gb', ['inspector'], 'inspector'),
      ),
    ),
  });
  const doc = movePanel(nested, { panel: 'inspector', targetGroupId: 'conv' });
  // gb emptied => s2 collapses to ga promoted in place.
  assert.deepEqual(doc.root.second, group('ga', ['roadmap'], 'roadmap'));
  assert.deepEqual(findById(doc, 'conv').panels, ['conversation', 'inspector']);
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
  const out = activatePanel(doc, 'inspector');
  assert.equal(findById(out, 'tools-group').active, 'inspector');
  assert.strictEqual(activatePanel(out, 'inspector'), out, 'already active => same ref');
  const closed = closePanel(doc, 'inspector');
  assert.strictEqual(activatePanel(closed, 'inspector'), closed, 'closed panel => same ref');
  assert.strictEqual(activatePanel(doc, 'nope'), doc, 'unknown panel => same ref');
  assertInvariants(out, 'activate');
});

test('closePanel closes, collapses, empties root, and reopens', () => {
  let doc = createDefaultLayout();
  doc = closePanel(doc, 'inspector');
  assert.deepEqual(findById(doc, 'tools-group').panels, ['roadmap']);
  assert.equal(findById(doc, 'tools-group').active, 'roadmap');
  assert.strictEqual(closePanel(doc, 'inspector'), doc, 'closing absent panel => same ref');

  // Close the active tab: active falls back to the first remaining panel.
  let tools2 = movePanel(createDefaultLayout(), {
    panel: 'inspector',
    targetGroupId: 'tools-group',
    index: 0,
  });
  assert.equal(findById(tools2, 'tools-group').active, 'inspector');
  tools2 = closePanel(tools2, 'inspector');
  assert.deepEqual(findById(tools2, 'tools-group').panels, ['roadmap']);
  assert.equal(findById(tools2, 'tools-group').active, 'roadmap');

  // Emptying a nested group promotes its sibling; emptying the last group empties the root.
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
    (doc) => movePanel(doc, { panel: 'inspector', targetGroupId: 'conversation-group' }),
    (doc) => movePanel(doc, { panel: 'roadmap', targetGroupId: 'conversation-group', zone: 'bottom' }),
    (doc) => movePanel(doc, { panel: 'roadmap', targetGroupId: 'tools-group', index: 0 }),
    (doc) => activatePanel(doc, 'inspector'),
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
