import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { messages } from '../public/translations.js';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('newSession ignores non-string cwd (click events) and falls back to the project', () => {
  assert.match(
    appSource,
    /state\.execCwd = typeof execCwd === 'string' && execCwd\.trim\(\) \? execCwd : state\.projectCwd/,
    'newSession must route every caller through a string-only guard',
  );
});

test('new-session buttons do not forward the click event', () => {
  assert.ok(
    appSource.includes("$('new-session').onclick = () => newSession();"),
    'sidebar button must call newSession without the event',
  );
  assert.ok(
    appSource.includes("$('project-new-session').onclick = () => newSession();"),
    'listing button must call newSession without the event',
  );
  assert.ok(
    !appSource.includes("$('new-session').onclick = newSession;"),
    'direct wiring would store the MouseEvent as cwd',
  );
});

test('first send never POSTs without a valid absolute cwd', () => {
  assert.ok(appSource.includes('if (!isValidRunCwd(cwd))'), 'sendMessage must validate cwd before POST');
  assert.ok(
    appSource.includes("tr('conversation.missing_project')"),
    'missing cwd must show the actionable message',
  );
  assert.match(
    appSource,
    /const isValidRunCwd = \(value\) => \{[\s\S]*?typeof value !== 'string'[\s\S]*?\^?\[a-zA-Z\]/,
    'isValidRunCwd must reject non-strings and require an absolute path',
  );
});

test('missing project message is translated in FR and EN with no em dash', () => {
  const row = messages['conversation.missing_project'];
  assert.ok(row, 'conversation.missing_project must exist');
  assert.ok(row.fr?.trim(), 'French text is required');
  assert.ok(row.en?.trim(), 'English text is required');
  assert.ok(!row.fr.includes('\u2014') && !row.en.includes('\u2014'), 'no em dashes allowed');
  assert.match(row.fr, /projet/i);
  assert.match(row.en, /project/i);
});
