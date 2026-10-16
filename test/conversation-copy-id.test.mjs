import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const extract = (start, end) =>
  source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('copy ID uses captured saved menu target, not current focus; drafts do not open', async () => {
  const copied = [];
  const state = { menuSessionId: 'saved-B', sessionId: 'focused-A', readOnly: false };
  const ctx = vm.createContext({
    state,
    session: (id) => (id === 'saved-B' ? { id } : null),
    closeSessionMenu: () => {
      state.sessionId = 'focused-C';
    },
    copyText: async (id) => copied.push(id),
    toast: () => {},
    translateKnown: (s) => s,
  });
  vm.runInContext(extract('async function menuAction(', 'async function renameSession('), ctx);
  await ctx.menuAction('copy-id');
  assert.deepEqual(copied, ['saved-B']);
  vm.runInContext(extract('function openSessionMenu(', 'async function patchSession('), ctx);
  ctx.openSessionMenu(null, null);
  assert.equal(state.menuSessionId, 'saved-B');
});

test('copy ID uses existing clipboard fallback without exporting transcript', async () => {
  const values = [];
  const ctx = vm.createContext({
    navigator: {
      clipboard: {
        writeText: async () => {
          throw Error('denied');
        },
      },
    },
    tr: (s) => s,
    toast: () => {},
    el: () => ({
      select() {
        values.push(this.value);
      },
      remove() {},
    }),
    document: { body: { append() {} }, execCommand: (name) => name === 'copy' },
  });
  vm.runInContext(extract('async function copyText(', 'function fence('), ctx);
  await ctx.copyText('durable-session-id');
  assert.deepEqual(values, ['durable-session-id']);
});
