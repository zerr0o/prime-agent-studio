import { isAbsolute, resolve } from 'node:path';

const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' &&
  isAbsolute(left) && isAbsolute(right) && resolve(left) === resolve(right);
const denied = () => Object.assign(new Error('Studio helper caller is not a live member of this session family.'),
  { code: 'studio_session_identity' });

/** Resolve only supervisor-owned live rows; caller input supplies an id, never a path.
 * The bridge token authorizes the root family. This validates family membership and
 * attribution, not isolation between processes that already share the same OS user.
 */
export function resolveRustSessionContext({ root, callerSessionId, sessions }) {
  if (!Array.isArray(sessions) || sessions.length > 10000 || typeof callerSessionId !== 'string') throw denied();
  const byId = new Map();
  const byFile = new Map();
  for (const row of sessions) {
    if (!row || typeof row.sessionId !== 'string' || !isAbsolute(row.sessionFile || '') ||
        !samePath(row.cwd, root.cwd)) continue;
    const file = resolve(row.sessionFile);
    if (byId.has(row.sessionId) || byFile.has(file)) throw denied();
    byId.set(row.sessionId, row);
    byFile.set(file, row);
  }
  const rootRow = byId.get(root.sessionId);
  if (!rootRow || !samePath(rootRow.sessionFile, root.sessionFile)) throw denied();
  const caller = byId.get(callerSessionId);
  if (!caller) throw denied();
  const seen = new Set();
  let row = caller;
  while (row.sessionId !== root.sessionId) {
    if (seen.has(row.sessionId) || seen.size >= 32 || !(row.rlmDepth > 0) ||
        !isAbsolute(row.parentSessionPath || '')) throw denied();
    seen.add(row.sessionId);
    const parent = byFile.get(resolve(row.parentSessionPath));
    if (!parent || (row.parentSessionId && row.parentSessionId !== parent.sessionId) ||
        (row.parentActiveSessionId && row.parentActiveSessionId !== parent.activeSessionId)) throw denied();
    row = parent;
  }
  return { cwd: caller.cwd, sessionId: caller.sessionId, sessionFile: caller.sessionFile };
}
