import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createQuestions, questionAnchorMessageId } from '../public/questions.js';

class Node {
  constructor(tag = 'div', data = '') {
    this.tag = tag;
    this.nodeType = tag === '#text' ? 3 : 1;
    this.data = data;
    this.childNodes = [];
    this.classList = { toggle() {}, add() {} };
    this.attributes = new Map();
  }
  get firstChild() {
    return this.childNodes[0];
  }
  get textContent() {
    return this.nodeType === 3 ? this.data : this.childNodes.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this.replaceChildren(new Node('#text', String(value)));
  }
  append(...children) {
    for (const child of children) {
      child.remove();
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...children);
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  focus() {}
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  querySelectorAll(tag) {
    return this.childNodes.flatMap((child) => [
      ...(child.tag === tag ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }
}

test('answered bridge question moves beside its original assistant while newer messages follow', () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => new Node('#text', text),
  };
  try {
    const earlier = { id: 'assistant-before', role: 'assistant', timestamp: 1000, tools: [{ id: 'python' }] };
    const later = { id: 'assistant-after', role: 'assistant', timestamp: 3000, tools: [] };
    const request = {
      id: 'question-1',
      method: 'input',
      title: 'Choose',
      status: 'pending',
      createdAt: 2000,
    };
    const run = { id: 'run-1', status: 'running', messages: [earlier, later], interactions: [request] };
    const root = new Node();
    const questions = createQuestions({
      root,
      api: async () => {},
      getContext: () => ({ run, readOnly: false }),
    });
    questions.update();
    assert.equal(root.childNodes.length, 1, 'unanswered question remains active by the composer');
    assert.equal(questions.partsFor(earlier).length, 0);

    request.status = 'answered';
    request.answer = 'Alpha';
    questions.update();
    assert.equal(
      root.childNodes.length,
      0,
      'windowed offscreen history must not leave the answer at the bottom',
    );
    const parts = questions.partsFor(earlier);
    assert.equal(parts.length, 1);
    assert.equal(questions.partsFor(later).length, 0);
    const transcript = new Node();
    transcript.append(new Node('earlier'), parts[0].node, new Node('later'));
    assert.equal(root.childNodes.length, 0, 'answered question leaves the active bottom area');
    assert.deepEqual(
      transcript.childNodes.map((node) => node.tag),
      ['earlier', 'form', 'later'],
    );
    assert.match(parts[0].node.textContent, /Alpha/);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('native tool-linked questions keep their owner and unlinked answers use creation time', () => {
  const run = {
    messages: [
      { id: 'a1', role: 'assistant', timestamp: 1000, tools: [{ id: 'tool-1' }] },
      { id: 'a2', role: 'assistant', timestamp: 3000, tools: [] },
    ],
  };
  assert.equal(questionAnchorMessageId(run, { toolId: 'tool-1', status: 'pending' }), 'a1');
  assert.equal(questionAnchorMessageId(run, { toolId: 'tool-1', status: 'answered' }), 'a1');
  assert.equal(
    questionAnchorMessageId(run, { toolId: 'missing', status: 'answered', createdAt: 2000 }),
    null,
  );
  assert.equal(questionAnchorMessageId(run, { status: 'answered', createdAt: 2000 }), 'a1');
  assert.equal(questionAnchorMessageId(run, { status: 'pending', createdAt: 2000 }), null);
});

test('a resolved question batch preserves all answers and skips beside its original assistant', () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => new Node('#text', text),
  };
  try {
    const before = { id: 'before', role: 'assistant', timestamp: 1000 };
    const later = { id: 'later', role: 'assistant', timestamp: 3000 };
    const request = {
      id: 'batch', kind: 'questions', title: 'Choose settings', status: 'pending', createdAt: 2000,
      questions: [
        { question: 'Which model?', options: [{ value: 'alpha', label: 'Alpha' }] },
        { question: 'Any constraints?', options: [] },
      ],
    };
    const run = { id: 'run', status: 'running', messages: [before, later], interactions: [request] };
    const root = new Node();
    const create = () => createQuestions({ root, api: async () => {}, getContext: () => ({ run, readOnly: false }) });
    let questions = create();
    questions.update();
    assert.equal(root.childNodes.length, 1);
    assert.equal(questions.partsFor(before).length, 0);
    request.status = 'answered';
    request.answers = [
      { question: 'Which model?', answer: 'Alpha', skipped: false },
      { question: 'Any constraints?', answer: '', skipped: true },
    ];
    questions.update();
    const resolved = questions.partsFor(before)[0].node;
    assert.equal(root.childNodes.length, 0);
    assert.equal(questions.partsFor(later).length, 0);
    assert.match(resolved.textContent, /Which model\? — Alpha/);
    assert.match(resolved.textContent, /Any constraints\? — .+/);
    // Windowed history can unmount this form. Reconstructing it from saved
    // interactions must keep the full batch at its original chronological slot.
    questions = create();
    questions.update();
    assert.equal(root.childNodes.length, 0);
    assert.equal(questions.partsFor(later).length, 0);
    assert.equal(questions.partsFor(before)[0].node.textContent, resolved.textContent);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('ISO timestamps preserve the question position across component remount', () => {
  const before = '2026-10-13T10:00:00.000Z';
  const asked = '2026-10-13T10:00:05.000Z';
  const after = '2026-10-13T10:00:10.000Z';
  const restored = {
    messages: [
      { id: 'before', role: 'assistant', timestamp: before },
      { id: 'later', role: 'assistant', timestamp: after },
    ],
  };
  assert.equal(questionAnchorMessageId(restored, { status: 'answered', createdAt: asked }), 'before');
  assert.equal(questionAnchorMessageId(restored, { status: 'cancelled', createdAt: asked }), 'before');
});

test(
  'real conversation renderer keeps a resolved bridge question between assistant messages after remount',
  { skip: process.env.PRIME_STUDIO_QUESTION_BROWSER_SMOKE !== '1' },
  async () => {
    const { chromium } = await import('@playwright/test');
    const server = createServer(async (request, response) => {
      if (request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          '<div id="scroll" style="height:450px;overflow:auto"><div id="messages"></div><div id="questions"></div></div>',
        );
        return;
      }
      if (!/^\/[a-z0-9-]+\.js$/.test(request.url || '')) {
        response.writeHead(404).end();
        return;
      }
      try {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end(await readFile(new URL(`../public/${request.url.slice(1)}`, import.meta.url)));
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const state = await page.evaluate(async () => {
        const { createQuestions } = await import('/questions.js');
        const { createConversationRenderer } = await import('/conversation.js');
        const root = document.querySelector('#messages');
        const bottom = document.querySelector('#questions');
        const epoch = Date.parse('2026-10-13T10:00:00.000Z');
        const assistant = (id, text, offset) => ({
          id,
          role: 'assistant',
          text,
          timestamp: new Date(epoch + offset).toISOString(),
          tools: [],
        });
        const before = assistant('before', 'Before marker', 0);
        const later = assistant('later', 'Later marker', 10_000);
        const request = {
          id: 'bridge-question',
          method: 'input',
          title: 'Choose',
          status: 'pending',
          createdAt: new Date(epoch + 5000).toISOString(),
        };
        const run = { id: 'run', status: 'running', messages: [before], interactions: [request] };
        const element = (tag, className, content) => {
          const node = document.createElement(tag);
          if (className) node.className = className;
          if (content != null) node.textContent = typeof content === 'function' ? content() : content;
          return node;
        };
        const renderer = (questions) =>
          createConversationRenderer({
            windowed: true,
            el: element,
            icon: () => document.createElement('span'),
            markdown: (text) => element('span', '', text),
            renderTool: () => document.createElement('div'),
            makeDetails: (className) => element('details', className),
            dateLabel: (timestamp) => String(timestamp),
            copyText: () => {},
            reasoningMode: () => 'collapsed',
            renderMessage: (message) => element('div', '', message.text || ''),
            renderInteractions: (message) => questions.partsFor(message),
          });
        const questions = () =>
          createQuestions({
            root: bottom,
            api: async () => {},
            getContext: () => ({ run, readOnly: false }),
          });
        let forms = questions();
        let transcript = renderer(forms);
        const paint = () => {
          forms.update();
          transcript.render(root, run.messages, { key: run.id, follow: true });
        };
        paint();
        const pendingAtBottom = bottom.querySelector('.agent-question:not(.question-resolved)') !== null;
        request.status = 'answered';
        request.answer = 'Alpha';
        run.messages.push(later);
        paint();
        const ordered = () => {
          const beforeNode = [...root.querySelectorAll('.assistant-text')].find((node) =>
            node.textContent.includes('Before marker'),
          );
          const laterNode = [...root.querySelectorAll('.assistant-text')].find((node) =>
            node.textContent.includes('Later marker'),
          );
          const form = root.querySelector('.agent-question.question-resolved');
          return (
            !!beforeNode &&
            !!form &&
            !!laterNode &&
            !!(beforeNode.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            !!(form.compareDocumentPosition(laterNode) & Node.DOCUMENT_POSITION_FOLLOWING)
          );
        };
        const liveOrdered = ordered();
        transcript.destroy?.(root);
        root.replaceChildren();
        bottom.replaceChildren();
        forms = questions();
        transcript = renderer(forms);
        paint();
        const restoredOrdered = ordered();
        for (let index = 0; index < 100; index++) {
          run.messages.push({
            id: `user-${index}`,
            role: 'user',
            text: 'Next',
            timestamp: epoch + 20_000 + index * 2000,
          });
          run.messages.push(assistant(`assistant-${index}`, `Reply ${index}`, 21_000 + index * 2000));
        }
        paint();
        return {
          pendingAtBottom,
          liveOrdered,
          restoredOrdered,
          answeredAtBottom: !!bottom.querySelector('.agent-question'),
        };
      });
      assert.deepEqual(state, {
        pendingAtBottom: true,
        liveOrdered: true,
        restoredOrdered: true,
        answeredAtBottom: false,
      });
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
