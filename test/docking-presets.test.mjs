import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS_VERSION,
  MAX_PRESETS,
  MAX_PRESET_NAME,
  validatePresets,
  createPresetLayout,
  presetConversationCount,
  applyPresetLayout,
} from '../public/docking-presets.js';
import { createDefaultLayout, validateLayout, groupsOf } from '../public/docking-layout.js';

const openPanels = (doc) => groupsOf(doc).flatMap((g) => g.panels);
const payloadOf = (doc) => JSON.stringify(doc);

test('validatePresets accepts an empty doc and freezes it', () => {
  const clean = validatePresets({ version: 1, items: [] });
  assert.deepEqual(clean, { version: 1, items: [] });
  assert.ok(Object.isFrozen(clean) && Object.isFrozen(clean.items), 'frozen');
});

test('validatePresets normalizes entries: trims names, canonicalizes v1 layouts', () => {
  const clean = validatePresets({
    version: 1,
    items: [
      {
        name: '  Review  ',
        layout: {
          version: 1,
          title: 'strip me',
          root: { kind: 'group', id: 'r', panels: ['conversation'], active: 'conversation' },
        },
      },
    ],
  });
  assert.equal(clean.version, 1);
  assert.equal(clean.items.length, 1);
  assert.equal(clean.items[0].name, 'Review', 'trimmed, display case preserved');
  assert.equal(clean.items[0].layout.version, 3, 'layout normalized to v3');
  assert.ok(!('title' in clean.items[0].layout), 'layout extras stripped');
  assert.deepEqual(validatePresets(clean), clean, 'revalidates identically');
});

test('validatePresets rejects malformed docs and bounds', () => {
  assert.equal(validatePresets(null), null);
  assert.equal(validatePresets(42), null);
  assert.equal(validatePresets({ version: 2, items: [] }), null, 'bad version rejects');
  assert.equal(validatePresets({ version: 1 }), null, 'missing items');
  assert.equal(validatePresets({ version: 1, items: 'x' }), null, 'items not array');
  const many = [];
  for (let i = 0; i <= MAX_PRESETS; i += 1) {
    many.push({
      name: `layout-${i}`,
      layout: createDefaultLayout(),
    });
  }
  assert.equal(many.length, MAX_PRESETS + 1);
  assert.equal(validatePresets({ version: 1, items: many }), null, 'over the preset cap');
  const twenty = many.slice(0, MAX_PRESETS);
  assert.ok(validatePresets({ version: 1, items: twenty }), 'exactly the cap validates');
});

test('validatePresets rejects bad names and case-insensitive duplicates', () => {
  const layout = createDefaultLayout();
  const bad = ['', '   ', 'x'.repeat(MAX_PRESET_NAME + 1), 42, null];
  for (const name of bad) {
    assert.equal(
      validatePresets({ version: 1, items: [{ name, layout }] }),
      null,
      `name ${String(name).slice(0, 8)}`,
    );
  }
  assert.equal(
    validatePresets({
      version: 1,
      items: [
        { name: 'Review', layout },
        { name: '  review ', layout },
      ],
    }),
    null,
    'duplicate names fold case and trim',
  );
  assert.equal(
    validatePresets({
      version: 1,
      items: [
        { name: 'Review', layout },
        { name: 'REVIEW', layout },
      ],
    }),
    null,
    'duplicate names fold case',
  );
});

test('validatePresets rejects smuggled session/draft/run payload and dangerous keys', () => {
  const layout = createDefaultLayout();
  const smuggled = [
    { name: 'a', layout, sessionId: 'abc' },
    { name: 'a', layout, session: 'abc' },
    { name: 'a', layout, draft: 'hello' },
    { name: 'a', layout, drafts: {} },
    { name: 'a', layout, runId: 'x' },
    { name: 'a', layout, messages: [] },
    { name: 'a', layout, content: 'x' },
  ];
  for (const entry of smuggled) {
    assert.equal(validatePresets({ version: 1, items: [entry] }), null, `key ${Object.keys(entry).pop()}`);
  }
  const proto = JSON.parse('{"name":"a","layout":null,"__proto__":{"polluted":true}}');
  proto.layout = createDefaultLayout();
  assert.equal(validatePresets({ version: 1, items: [proto] }), null, '__proto__ rejected');
  assert.equal({}.polluted, undefined, 'no prototype pollution');
  assert.equal(
    validatePresets({ version: 1, items: [{ name: 'a', layout: { version: 9, root: {} } }] }),
    null,
    'invalid layout rejected',
  );
});

test('stored presets carry no session/draft/run metadata', () => {
  const live = validateLayout({
    version: 2,
    root: {
      kind: 'split',
      id: 'main',
      dir: 'row',
      ratio: 0.5,
      first: { kind: 'group', id: 'a', panels: ['conv:live-9'], active: 'conv:live-9' },
      second: { kind: 'group', id: 'b', panels: ['roadmap'], active: 'roadmap' },
    },
  });
  const clean = validatePresets({ version: 1, items: [{ name: 'Solo', layout: createPresetLayout(live) }] });
  const payload = payloadOf(clean);
  for (const leak of ['live-9', 'sessionId', 'draft', 'runId', 'messages']) {
    assert.ok(!payload.includes(leak), `no leak of ${leak}`);
  }
  assert.ok(payload.includes('conv:slot') || payload.includes('"conversation"'), 'anonymous slots stored');
});

test('validatePresets anonymizes live conv refs and strips layout extras', () => {
  const live = {
    version: 2,
    title: 'strip me',
    root: {
      kind: 'split',
      id: 'main',
      dir: 'row',
      ratio: 0.5,
      note: 'strip me too',
      first: {
        kind: 'group',
        id: 'a',
        panels: ['conv:actualSessionRef'],
        active: 'conv:actualSessionRef',
        x: 1,
      },
      second: { kind: 'group', id: 'b', panels: ['roadmap'], active: 'roadmap' },
    },
  };
  const clean = validatePresets({ version: 1, items: [{ name: 'Imported', layout: live }] });
  assert.ok(clean, 'imported layout accepted');
  const stored = clean.items[0].layout;
  assert.equal(stored.version, 3, 'normalized to v3');
  assert.deepEqual(
    groupsOf(stored).flatMap((g) => g.panels),
    ['conversation', 'roadmap'],
  );
  assert.ok(!payloadOf(clean).includes('actualSessionRef'), 'live ref anonymized away');
  assert.ok(!('title' in clean.items[0].layout) && !('title' in stored), 'doc extras stripped');
  assert.ok(!('note' in stored.root) && !('x' in stored.root.first), 'node extras stripped');
  assert.deepEqual(validatePresets(clean), clean, 'stored form is a fixed point');
});

test('createPresetLayout anonymizes in position order', () => {
  const anon = createPresetLayout(createDefaultLayout());
  assert.deepEqual(openPanels(anon).sort(), ['agents', 'conversation', 'files', 'roadmap', 'session']);
  const live = validateLayout({
    version: 3,
    root: {
      kind: 'split',
      id: 'main',
      dir: 'row',
      ratio: 0.5,
      first: { kind: 'group', id: 'a', panels: ['conv:zzz', 'roadmap'], active: 'conv:zzz' },
      second: { kind: 'group', id: 'b', panels: ['conv:aaa', 'session'], active: 'conv:aaa' },
    },
  });
  const preset = createPresetLayout(live);
  // Position order: conv:zzz (first group) then conv:aaa.
  assert.deepEqual(openPanels(preset), ['conversation', 'roadmap', 'conv:slot-1', 'session']);
  assert.equal(preset.version, 3);
  assert.ok(Object.isFrozen(preset), 'frozen');
  assert.equal(createPresetLayout(null), null, 'invalid input');
  assert.equal(createPresetLayout({ version: 9, root: {} }), null, 'unknown version');
});

test('presetConversationCount counts slots, 0 when none or invalid', () => {
  assert.equal(presetConversationCount(createDefaultLayout()), 1);
  const preset = createPresetLayout(
    validateLayout({
      version: 2,
      root: {
        kind: 'split',
        id: 'main',
        dir: 'row',
        ratio: 0.5,
        first: { kind: 'group', id: 'a', panels: ['conversation', 'conv:slot-1'], active: 'conversation' },
        second: { kind: 'group', id: 'b', panels: ['roadmap'], active: 'roadmap' },
      },
    }),
  );
  assert.equal(presetConversationCount(preset), 2);
  const bare = validateLayout({
    version: 2,
    root: { kind: 'group', id: 'r', panels: ['roadmap'], active: 'roadmap' },
  });
  assert.equal(presetConversationCount(bare), 0);
  assert.equal(presetConversationCount(null), 0, 'invalid input');
  assert.equal(presetConversationCount({ version: 9 }), 0, 'unknown version');
});

test('applyPresetLayout binds matching ids in position order', () => {
  const preset = createPresetLayout(
    validateLayout({
      version: 3,
      root: {
        kind: 'split',
        id: 'main',
        dir: 'row',
        ratio: 0.5,
        first: { kind: 'group', id: 'a', panels: ['conv:x', 'roadmap'], active: 'conv:x' },
        second: { kind: 'group', id: 'b', panels: ['conv:y'], active: 'conv:y' },
      },
    }),
  );
  const bound = applyPresetLayout(preset, ['conv:live-1', 'conv:live-2']);
  assert.ok(bound, 'matching ids bind');
  assert.deepEqual(openPanels(bound), ['conv:live-1', 'roadmap', 'conv:live-2']);
  assert.equal(bound.version, 3);
  assert.ok(Object.isFrozen(bound), 'frozen');
});

test('applyPresetLayout ignores spare ids and rejects deficits or bad ids', () => {
  const preset = createPresetLayout(createDefaultLayout());
  const spare = applyPresetLayout(preset, ['conv:a', 'conv:b', 'conv:c']);
  assert.ok(spare, 'spare ids ignored');
  assert.ok(openPanels(spare).includes('conv:a'), 'first id binds the single slot');
  assert.ok(!payloadOf(spare).includes('conv:b'), 'unused ids stripped');
  assert.equal(applyPresetLayout(preset, []), null, 'deficit rejected');
  assert.equal(applyPresetLayout(preset, ['agents']), null, 'non-conversation id rejected');
  assert.equal(applyPresetLayout(preset, 'conv:a'), null, 'non-array rejected');
  const two = createPresetLayout(
    validateLayout({
      version: 3,
      root: { kind: 'group', id: 'r', panels: ['conversation', 'conv:slot-1'], active: 'conversation' },
    }),
  );
  assert.equal(applyPresetLayout(two, ['conv:a', 'conv:a']), null, 'duplicate ids rejected');
  assert.equal(applyPresetLayout(two, ['conv:a']), null, 'deficit of one rejected');
  assert.equal(applyPresetLayout(null, ['conv:a']), null, 'invalid layout');
  const slotless = validateLayout({
    version: 3,
    root: { kind: 'group', id: 'r', panels: ['roadmap'], active: 'roadmap' },
  });
  assert.deepEqual(applyPresetLayout(slotless, []), slotless, 'slot-free layout passes through');
});

test('validatePresets migrates legacy inner layouts to canonical v3', () => {
  const v1 = validatePresets({
    version: 1,
    items: [
      {
        name: 'Legacy tabs',
        layout: {
          version: 1,
          root: {
            kind: 'split',
            id: 'main',
            dir: 'row',
            ratio: 0.68,
            first: { kind: 'group', id: 'a', panels: ['conversation'], active: 'conversation' },
            second: { kind: 'group', id: 'b', panels: ['roadmap', 'inspector'], active: 'inspector' },
          },
        },
      },
    ],
  });
  assert.ok(v1, 'legacy inner v1 accepted');
  assert.equal(v1.items[0].layout.version, 3, 'stored as canonical v3');
  assert.deepEqual(openPanels(v1.items[0].layout), ['conversation', 'roadmap', 'session', 'agents', 'files']);
  assert.deepEqual(validatePresets(v1), v1, 'stored form is a fixed point');

  const v2 = validatePresets({
    version: 1,
    items: [
      {
        name: 'Legacy prefs',
        layout: {
          version: 2,
          root: {
            kind: 'group',
            id: 'r',
            panels: ['conv:live-7', 'roadmap', 'inspector', 'preferences'],
            active: 'inspector',
          },
        },
      },
    ],
  });
  assert.ok(v2, 'legacy inner v2 accepted');
  const stored = v2.items[0].layout;
  assert.equal(stored.version, 3, 'stored as canonical v3');
  // Anonymized in position order, inspector expanded in place, active follows.
  assert.deepEqual(openPanels(stored), [
    'conversation',
    'roadmap',
    'session',
    'agents',
    'files',
    'preferences',
  ]);
  assert.ok(!payloadOf(v2).includes('live-7'), 'live ref anonymized away');
  assert.ok(!payloadOf(v2).includes('inspector'), 'no inspector leaks into storage');
  const bound = applyPresetLayout(stored, ['conv:live-7']);
  assert.ok(bound, 'stored preset binds');
  assert.deepEqual(openPanels(bound), [
    'conv:live-7',
    'roadmap',
    'session',
    'agents',
    'files',
    'preferences',
  ]);
  assert.equal(bound.version, 3);
});
