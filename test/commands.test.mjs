import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commandCatalog, createCommandService, parseCommand, validateCommand } from '../lib/commands.mjs';
import { normalizeEvent } from '../lib/agent.mjs';

test('commands distinguish Studio actions, native commands, skills and terminal-only commands', () => {
  const catalog = commandCatalog({
    builtins: [{ name: 'goal' }, { name: 'share' }],
    commands: [
      { name: 'skill:example', source: 'skill' },
      { name: 'review', source: 'prompt' },
    ],
  });
  assert.equal(parseCommand('/thinking high').name, 'effort');
  assert.equal(parseCommand('/constructor').name, 'constructor');
  assert.equal(parseCommand('/tmp/file'), null);
  assert.doesNotThrow(() => validateCommand('/goal status', catalog, { live: true }));
  assert.doesNotThrow(() =>
    validateCommand('/skill:example hello\nworld', catalog, { live: true, attachments: true }),
  );
  for (const text of ['/share', '/unknown', '/settings', '/goal status\nhello'])
    assert.throws(() => validateCommand(text, catalog), { status: 400 });
  assert.throws(() => validateCommand('/goal status', catalog, { attachments: true }), { status: 400 });
  assert.doesNotThrow(() => validateCommand('/review "quoted argument"', catalog));
  assert.equal(
    normalizeEvent({
      type: 'message_end',
      message: { role: 'custom', display: true, content: 'Goal: idle' },
    })[0].message.role,
    'system',
  );
  assert.equal(
    normalizeEvent({ type: 'message_end', message: { role: 'custom', display: false, content: 'hidden' } })[0]
      .message.role,
    'custom',
  );
  assert.equal(
    normalizeEvent({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'session_slash_command',
        display: true,
        content: '/goal status',
      },
    })[0].message.role,
    'user',
  );
});

test('native catalogue respects project priority, metadata, explicit-only skills and packages without executing extensions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-commands-'));
  const cwd = join(root, 'project'),
    agentHome = join(root, 'agent');
  const service = createCommandService({ agentHome });
  t.after(async () => {
    service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const dirs = [
    join(cwd, '.prime', 'agent', 'skills', 'example'),
    join(agentHome, 'skills', 'example'),
    join(cwd, '.prime', 'agent', 'prompts'),
    join(cwd, '.prime', 'agent', 'extensions'),
  ];
  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
  const nativeSettings = JSON.stringify({
    enableBuiltinSkills: false,
    packages: ['npm:studio-intentionally-missing-fixture-package@0.0.0'],
  });
  await writeFile(join(agentHome, 'settings.json'), nativeSettings);
  await writeFile(
    join(dirs[0], 'SKILL.md'),
    '---\nname: example\ndescription: Project wins\ndisable-model-invocation: true\n---\nPROJECT_ONLY',
  );
  await writeFile(
    join(dirs[1], 'SKILL.md'),
    '---\nname: example\ndescription: Global loses\n---\nGLOBAL_ONLY',
  );
  await writeFile(
    join(dirs[2], 'review.md'),
    '---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1',
  );
  await writeFile(
    join(dirs[3], 'must-not-run.mjs'),
    'throw new Error("A catalogue must never execute an extension");',
  );
  const catalog = await service.list({ cwd });
  const skill = catalog.commands.find((c) => c.name === 'skill:example');
  assert.equal(skill.description, 'Project wins');
  assert.equal(skill.explicitOnly, true);
  assert.equal(resolve(skill.sourceInfo.path), resolve(dirs[0], 'SKILL.md'));
  assert.equal(catalog.commands.find((c) => c.name === 'review').argumentHint, '<file>');
  assert.ok(catalog.diagnostics.some((d) => d.message.includes('Package absent')));
  assert.equal(await readFile(join(agentHome, 'settings.json'), 'utf8'), nativeSettings);
});
