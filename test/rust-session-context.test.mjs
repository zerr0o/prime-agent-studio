import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveRustSessionContext } from '../lib/rust-session-context.mjs';

const cwd = resolve('fixture-project');
const row = (id, parent) => ({ sessionId: id, activeSessionId: `active-${id}`, cwd,
  sessionFile: resolve(`fixture-sessions/${id}.jsonl`), rlmDepth: parent ? 1 : 0,
  ...(parent && {parentSessionPath: parent.sessionFile, parentSessionId: parent.sessionId,
    parentActiveSessionId: parent.activeSessionId}) });
const root = row('root');
const child = row('child', root);
const grandchild = {...row('grandchild', child), rlmDepth: 2};
const ask = (callerSessionId, sessions) => resolveRustSessionContext({root, callerSessionId, sessions});

test('child and nested child keep their own supervisor identity', () => {
  for (const caller of [child, grandchild]) assert.deepEqual(ask(caller.sessionId, [root, child, grandchild]),
    {cwd, sessionId: caller.sessionId, sessionFile: caller.sessionFile});
});

test('unrelated root, forged edge, cross-project row and absent live caller are rejected', () => {
  const other = row('other');
  for (const rows of [[root, other], [root, {...child, parentSessionId: 'other'}],
    [root, {...child, parentActiveSessionId:'old-root'}], [root, {...child, cwd:resolve('other-project')}],
    [root], [root, {...child, rlmDepth:0}]]) {
    assert.throws(() => ask(rows.includes(other) ? 'other' : 'child', rows), {code:'studio_session_identity'});
  }
});

test('cycles, duplicated identities and changed root binding fail closed', () => {
  assert.throws(() => ask('child', [root, {...child, parentSessionPath:child.sessionFile,
    parentSessionId:'child', parentActiveSessionId:child.activeSessionId}]), {code:'studio_session_identity'});
  assert.throws(() => ask('child', [root, child, {...child}]), {code:'studio_session_identity'});
  assert.throws(() => ask('child', [{...root, sessionFile:resolve('wrong.jsonl')}, child]), {code:'studio_session_identity'});
});
