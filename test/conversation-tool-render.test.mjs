import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function renderTool(');
const end = source.indexOf('const messageNodes =', start);
assert.ok(start >= 0 && end > start, 'test executes the production tool renderer');
const el = (tag, className = '', text = '') => ({
  tag,
  className,
  text: typeof text === 'function' ? text() : text,
  dataset: {},
  childNodes: [],
  append(...nodes) {
    this.childNodes.push(...nodes);
  },
});
const renderTool = runInNewContext(`(${source.slice(start, end)})`, {
  el,
  icon: (name) => el('svg', name),
  makeDetails: (className) => el('details', className),
  tr: (key) => key,
  translateKnown: (value) => value,
  stringify: (value) => (typeof value === 'string' ? value : JSON.stringify(value)),
});
const textOf = (node) => [node.text, ...node.childNodes.map(textOf)].filter(Boolean).join(' ');

test('historical tool calls render their result in classic, primary and owned conversation views', () => {
  for (const cwd of [undefined, 'C:/owner-one', 'C:/owner-two']) {
    const node = renderTool(
      {
        id: 'call-1',
        name: 'ipython',
        status: 'done',
        args: { code: 'print(2)' },
        result: 'history-tool-result',
      },
      'assistant-1',
      cwd,
    );
    assert.equal(node.tag, 'details');
    assert.equal(node.dataset.cwd, cwd);
    assert.equal(node.childNodes.filter((child) => child.tag === 'summary').length, 1);
    assert.match(textOf(node), /ipython/);
    assert.match(textOf(node), /print\(2\)/);
    assert.match(textOf(node), /history-tool-result/);
  }
});

test('pending, running and failed tools remain renderable', () => {
  for (const [status, isError, label] of [
    ['pending', false, 'ui.preparation'],
    ['running', false, 'ui.en_cours'],
    ['error', true, 'common.error'],
  ]) {
    const node = renderTool({ name: 'ipython', status, isError }, 'assistant-2');
    assert.match(textOf(node), new RegExp(label.replaceAll('.', '\\.')));
    assert.match(textOf(node), /ui.en_attente_du_resultat/);
  }
});

test('native question tools render answered and pending historical records', () => {
  const answered = renderTool(
    { name: 'question', status: 'done', result: JSON.stringify({ question: 'Continue?', answer: 'Yes' }) },
    'assistant-3',
  );
  assert.match(textOf(answered), /Continue\?/);
  assert.match(textOf(answered), /questions.answered Yes/);
  const pending = renderTool(
    { name: 'question', status: 'pending', args: { question: 'Continue?' } },
    'assistant-4',
  );
  assert.match(textOf(pending), /questions.waiting/);
});
