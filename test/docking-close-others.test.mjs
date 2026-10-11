import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import {
  activatePanel,
  closePanel,
  groupsOf,
  isConversationPanel,
  validateLayout,
} from '../public/docking-layout.js';

const source = await readFile(new URL('../public/docking.js', import.meta.url), 'utf8');
const start = source.indexOf('  function removeOtherPanels(');
const end = source.indexOf('  function removePanel(', start);
assert.ok(start >= 0 && end > start, 'Production close-others handler must exist');
const handler = source.slice(start, end);
const layout = validateLayout({
  version: 3,
  root: {
    kind: 'split',
    id: 'root',
    dir: 'row',
    ratio: 0.6,
    first: {
      kind: 'group',
      id: 'left',
      panels: ['conversation', 'conv:b', 'roadmap'],
      active: 'conversation',
    },
    second: { kind: 'group', id: 'right', panels: ['conv:c', 'session', 'files'], active: 'conv:c' },
  },
});
assert.ok(layout);

function invoke(group, keep, current = layout, active = true, focused = 'conversation') {
  const commits = [];
  const closeOthers = runInNewContext(`(${handler})`, {
    active,
    layout: current,
    groupsOf,
    activatePanel,
    closePanel,
    isConversationPanel,
    isFocusedPanel: (id) => id === focused,
    commit: (next, focus) => commits.push({ next, focus }),
    focusTab: (id) => {
      commits.at(-1).tabFocus = id;
    },
  });
  closeOthers(group, keep);
  return commits;
}

test('close others keeps the clicked inactive tab and commits once, only within its group', () => {
  const before = JSON.stringify(layout);
  const commits = invoke('left', 'conv:b');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].focus, 'conv:b');
  const next = commits[0].next;
  assert.deepEqual(
    groupsOf(next).find((group) => group.id === 'left'),
    {
      kind: 'group',
      id: 'left',
      panels: ['conv:b'],
      active: 'conv:b',
    },
  );
  assert.deepEqual(next.root.second, layout.root.second, 'other group stays intact');
  assert.equal(next.root.ratio, layout.root.ratio, 'split geometry stays intact');
  assert.equal(JSON.stringify(layout), before, 'source layout is immutable');
});

test('group-bar action keeps its active tab and leaves the other group intact', () => {
  const keep = groupsOf(layout).find((group) => group.id === 'left').active;
  const [{ next, focus }] = invoke('left', keep);
  assert.equal(focus, keep);
  assert.deepEqual(groupsOf(next).find((group) => group.id === 'left').panels, [keep]);
  assert.equal(
    groupsOf(next).some((group) => group.panels.includes('conv:c')),
    true,
  );
});

test('stale group/target, inactive workspace and single-tab group are safe no-ops', () => {
  for (const [group, keep] of [
    ['missing', 'conv:b'],
    ['left', 'conv:c'],
    ['left', 'missing'],
  ]) {
    assert.deepEqual(invoke(group, keep), []);
  }
  assert.deepEqual(invoke('left', 'conv:b', layout, false), []);
  const [{ next }] = invoke('left', 'conv:b');
  assert.deepEqual(invoke('left', 'conv:b', next), []);
});

test('keeping a tool after closing the focused conversation uses a visible context and keeps keyboard focus', () => {
  const [result] = invoke('left', 'roadmap');
  assert.equal(result.focus, 'conv:c');
  assert.equal(result.tabFocus, 'roadmap');
  assert.deepEqual(result.next.root.second, layout.root.second);
});

test('keeping a tool does not change a conversation context in another group', () => {
  const [result] = invoke('left', 'roadmap', layout, true, 'conv:c');
  assert.equal(result.focus, 'roadmap');
  assert.equal(result.tabFocus, undefined);
  assert.deepEqual(result.next.root.second, layout.root.second);
});
