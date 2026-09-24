import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatMessage as tr } from '../public/i18n-core.js';
import { parseMultiSkillCommand, validateCommand } from '../lib/commands.mjs';
import { expandMultiSkillMessage } from '../lib/skill-expansion.mjs';

const catalog = {
  commands: [
    { name: 'skill:alpha', source: 'skill', supported: true, sourceInfo: { path: '/skills/alpha/SKILL.md' } },
    { name: 'skill:beta', source: 'skill', supported: true, sourceInfo: { path: '/skills/beta/SKILL.md' } },
  ],
};

test('multi skill invocation parses two leading skills', () => {
  assert.deepEqual(parseMultiSkillCommand('/skill:alpha /skill:beta Do work'), {
    names: ['alpha', 'beta'],
    args: 'Do work',
  });
  assert.equal(parseMultiSkillCommand('/skill:alpha Do work'), null);
  assert.equal(parseMultiSkillCommand('Do work'), null);
});

test('repeated skill names dedupe to one expansion', () => {
  assert.deepEqual(parseMultiSkillCommand('/skill:alpha /skill:alpha /skill:beta text'), {
    names: ['alpha', 'beta'],
    args: 'text',
  });
  assert.deepEqual(parseMultiSkillCommand('/skill:alpha /skill:alpha text'), {
    names: ['alpha'],
    args: 'text',
  });
});

test('validateCommand accepts known multi skills and rejects unknown', () => {
  assert.doesNotThrow(() => validateCommand('/skill:alpha /skill:beta Do work', catalog));
  assert.throws(() => validateCommand('/skill:alpha /skill:missing Do work', catalog), { status: 400 });
});

test('expansion matches engine block format byte for byte', async () => {
  const files = {
    '/skills/alpha/SKILL.md': '---\nname: alpha\ndescription: A\n---\nAlpha body',
    '/skills/beta/SKILL.md': 'Beta body without frontmatter',
  };
  const expanded = await expandMultiSkillMessage('/skill:alpha /skill:beta Shared text', catalog, {
    read: async (path) => files[path],
  });
  const expected =
    '<skill name="alpha" location="/skills/alpha/SKILL.md">\n' +
    'References are relative to /skills/alpha.\n\nAlpha body\n</skill>\n\n' +
    '<skill name="beta" location="/skills/beta/SKILL.md">\n' +
    'References are relative to /skills/beta.\n\nBeta body without frontmatter\n</skill>\n\n' +
    'Shared text';
  assert.equal(expanded, expected);
  assert.equal(await expandMultiSkillMessage('/skill:alpha Only one', catalog), null);
});

test('frontmatter stripped like the engine on CRLF and edge cases', async () => {
  const files = {
    '/skills/alpha/SKILL.md': '---\r\nname: alpha\r\n---\r\nBody CRLF   ',
    '/skills/beta/SKILL.md': 'No frontmatter body',
  };
  const expanded = await expandMultiSkillMessage('/skill:alpha /skill:beta text', catalog, {
    read: async (path) => files[path],
  });
  assert.ok(expanded.includes('Body CRLF\n</skill>'));
  assert.ok(expanded.includes('No frontmatter body\n</skill>'));
  const missingClose = await expandMultiSkillMessage('/skill:alpha /skill:beta text', catalog, {
    read: async (path) => (path.endsWith('alpha/SKILL.md') ? '---\nno closing marker' : 'plain'),
  });
  assert.ok(missingClose.includes('---\nno closing marker\n</skill>'));
});

test('duplicate manual command expands once without duplication', async () => {
  const files = {
    '/skills/alpha/SKILL.md': 'Alpha',
    '/skills/beta/SKILL.md': 'Beta',
  };
  let reads = 0;
  const expanded = await expandMultiSkillMessage('/skill:alpha /skill:alpha /skill:beta go', catalog, {
    read: async (path) => {
      reads++;
      return files[path];
    },
  });
  assert.equal(reads, 2);
  assert.equal(expanded.match(/<skill name="alpha"/g).length, 1);
  assert.equal(expanded.match(/<skill name="beta"/g).length, 1);
});

test('unknown skill produces clear error and oversize is refused while reading', async () => {
  await assert.rejects(
    expandMultiSkillMessage('/skill:alpha /skill:gone Text', catalog, {
      read: async () => {
        throw new Error('no');
      },
    }),
    { status: 400 },
  );
  const reads = [];
  await assert.rejects(
    expandMultiSkillMessage('/skill:alpha /skill:beta Text', catalog, {
      read: async (path) => {
        reads.push(path);
        return 'x'.repeat(500);
      },
      maxChars: 10,
    }),
    { status: 400 },
  );
  assert.ok(reads.length <= 1);
});

test('same skill twice consumes both tokens and expands only once', async () => {
  const result = await expandMultiSkillMessage('/skill:alpha /skill:alpha Do work', catalog, {
    read: async () => 'Alpha',
  });
  assert.equal((result.match(/<skill name="alpha"/g) || []).length, 1);
  assert.equal(result.includes('/skill:'), false);
  assert.ok(result.endsWith('Do work'));
});

test('real disk reads reject a large skill before loading its body', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-skill-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'SKILL.md');
  await writeFile(path, 'x'.repeat(8192));
  const localCatalog = { commands: [{ name: 'skill:alpha', source: 'skill', sourceInfo: { path } }] };
  await assert.rejects(
    expandMultiSkillMessage('/skill:alpha /skill:alpha request', localCatalog, { maxChars: 1000 }),
    (error) => error.status === 400 && error.message === tr('server.skills_trop_volumineux'),
  );
  await writeFile(path, 'Valid instructions');
  const expanded = await expandMultiSkillMessage('/skill:alpha /skill:alpha request', localCatalog, {
    maxChars: 1000,
  });
  assert.ok(expanded.includes('Valid instructions'));
});
