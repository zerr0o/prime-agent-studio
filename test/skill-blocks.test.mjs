import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSkillBlocks,
  hasSkillBlock,
  stripSkillBlocks,
  readableCopyText,
} from '../public/skill-blocks.js';

test('skill blocks parse single expanded engine message', () => {
  const text = `<skill name="ponytail-debt" location="C:\\skills\\ponytail-debt\\SKILL.md">\nReferences are relative to C:\\skills\\ponytail-debt.\n\nBody line 1\n</skill>\n\nDo the thing`;
  assert.equal(hasSkillBlock(text), true);
  const parts = parseSkillBlocks(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].type, 'skill');
  assert.equal(parts[0].name, 'ponytail-debt');
  assert.ok(parts[0].content.includes('Body line 1'));
  assert.deepEqual(parts[1], { type: 'text', text: 'Do the thing' });
  assert.equal(stripSkillBlocks(text), 'Do the thing');
});

test('skill blocks parse multiple blocks and keep user text', () => {
  const text = `<skill name="a" location="/s/a/SKILL.md">\nReferences are relative to /s/a.\n\nA body\n</skill>\n\n<skill name="b" location="/s/b/SKILL.md">\nReferences are relative to /s/b.\n\nB body\n</skill>\n\nShared request`;
  const parts = parseSkillBlocks(text);
  assert.deepEqual(
    parts.map((p) => p.type),
    ['skill', 'skill', 'text'],
  );
  assert.equal(parts[2].text, 'Shared request');
  assert.equal(stripSkillBlocks(text), 'Shared request');
});

test('plain user text has no skill block', () => {
  assert.equal(hasSkillBlock('Hello world'), false);
  assert.deepEqual(parseSkillBlocks('Hello world'), [{ type: 'text', text: 'Hello world' }]);
  assert.equal(stripSkillBlocks('Hello world'), 'Hello world');
});

test('copy keeps typed request for users and full text otherwise', () => {
  const userText = `<skill name="a" location="/s/a/SKILL.md">\nReferences are relative to /s/a.\n\nA body\n</skill>\n\nDo the thing`;
  assert.equal(readableCopyText('user', userText), 'Do the thing');
  assert.equal(readableCopyText('assistant', userText), userText);
  assert.equal(readableCopyText('system', userText), userText);
  assert.equal(readableCopyText('user', 'Hello'), 'Hello');
  const onlyBlock = `<skill name="a" location="/s/a/SKILL.md">\nReferences are relative to /s/a.\n\nA body\n</skill>`;
  assert.equal(readableCopyText('user', onlyBlock), onlyBlock);
});

test('assistant code samples with skill-like text are not treated as history blocks on copy', () => {
  const sample = 'Here is an example:\n<skill name="a" location="/s/a/SKILL.md">\nbody\n</skill>\nDone';
  assert.equal(hasSkillBlock(sample), true);
  assert.equal(readableCopyText('assistant', sample), sample);
  assert.equal(readableCopyText('user', sample), 'Here is an example:\n\nDone');
});
