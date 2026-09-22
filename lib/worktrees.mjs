// Managed Git worktree service (V1) for Prime Agent Studio.
// One isolated task worktree per task, created from a registered project
// checkout at its committed HEAD. System generated branch and path under the
// Studio dataDir. Never stash, reset, or edit the source working tree.
// V1 integrates only existing committed task work with an explicit confirmed
// fast-forward merge into the original branch. There is no implicit commit,
// no auto commit-all, no conflict resolution, no push, no hook execution.
// Agents or users create normal commits with their own Git workflow; a
// diverged task can merge the target branch into the task worktree and
// resolve conflicts there, then the final integrate stays a clean FF.
// All git commands run via execFile (no shell), windowsHide, bounded output,
// disabled hooks (empty core.hooksPath), disabled fsmonitor, no external diff
// drivers and no textconv. Repos with custom smudge/process filter drivers
// are rejected at creation (explicit V1 limitation).
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { HttpError } from './store.mjs';

const exec = promisify(execFile);

export const WORKTREE_LIMITS = {
  filesMax: 200,
  untrackedMax: 200,
  numstatMax: 100,
  patchMaxFiles: 50,
  patchMaxBytes: 262144,
  statusMaxBytes: 512 * 1024,
  gitTimeoutMs: 20000,
  lockTimeoutMs: 60000,
  lockStaleMs: 30000,
  filterScanMaxFiles: 20000,
};

export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

const SCHEMA_VERSION = 1;
const ID_RE = /^wt-[0-9a-f]{12}$/;
const REVISION_RE = /^[A-Za-z0-9-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{4,64}$/i;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,127}$/;

const fail = (status, code, message) =>
  Object.assign(new HttpError(status, message), { code });

const keyOf = (value) =>
  process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
const within = (root, value) => {
  const r = keyOf(root);
  const v = keyOf(value);
  return v === r || v.startsWith(r + sep);
};
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isoNow = (now) => new Date(typeof now === 'function' ? now() : Date.now()).toISOString();

function slugify(name, fallback = 'task') {
  const text = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/^-+|-+$/g, '');
  return text || fallback;
}

function checkBranch(branch) {
  if (typeof branch !== 'string' || branch.length > 128 || !BRANCH_RE.test(branch)) return false;
  if (branch.startsWith('-') || branch.startsWith('.') || branch.includes('..')) return false;
  if (branch.includes('//') || branch.endsWith('/') || branch.endsWith('.lock')) return false;
  if (branch.includes('@{') || /[\s~^:?*\[\\]/.test(branch)) return false;
  return true;
}

function checkGitArg(arg) {
  return typeof arg === 'string' && arg.length > 0 && arg.length <= 4096 && !arg.includes('\0');
}

function gitError(status, code, message, stderr) {
  const extra = typeof stderr === 'string' && stderr.trim()
    ? `: ${stderr.trim().slice(0, 500)}`
    : '';
  return fail(status, code, `${message}${extra}`);
}

// In-process per-key serialization (chains awaited sequentially).
const chains = new Map();
async function serialize(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((done) => { release = done; });
  chains.set(key, prev.catch(() => {}).then(() => gate));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

function lockOwnerAlive(pid) {
  if (!Number.isSafeInteger(pid)) return null;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM' ? true : false;
  }
}

async function tryTakeDeadLock(file, seen) {
  // Compare-and-swap: only remove when content is still what we read, so two
  // takers cannot both believe they own the lock. The loser gets EEXIST on
  // recreate and re-reads a live owner.
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current !== seen) return false;
  await rm(file).catch(() => {});
  return true;
}

async function withFileLock(file, fn, { timeoutMs = WORKTREE_LIMITS.lockTimeoutMs, staleMs = WORKTREE_LIMITS.lockStaleMs } = {}) {
  await mkdir(dirname(file), { recursive: true });
  const mine = `${process.pid}:${randomUUID()}:${Date.now()}`;
  const start = Date.now();
  for (;;) {
    try {
      await writeFile(file, mine, { flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const seen = await readFile(file, 'utf8').catch(() => null);
      if (seen === null) continue;
      const mtime = await stat(file).then((st) => st.mtimeMs).catch(() => 0);
      // Never steal a live owner merely because time passed. Only a dead PID
      // (or an ancient unparseable file) may be taken over.
      const pid = Number.parseInt(String(seen).split(':')[0], 10);
      const alive = lockOwnerAlive(pid);
      if (alive === false || (alive === null && Date.now() - mtime > staleMs)) {
        if (await tryTakeDeadLock(file, seen)) continue;
        continue;
      }
      if (Date.now() - start > timeoutMs)
        throw fail(409, 'worktree_busy', 'Another worktree operation is in progress. Please retry.');
      await delay(60);
    }
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock token, never another owner's.
    const current = await readFile(file, 'utf8').catch(() => null);
    if (current === mine) await rm(file, { force: true }).catch(() => {});
  }
}

function emptyDocument() {
  return { schemaVersion: SCHEMA_VERSION, revision: randomUUID(), worktrees: [] };
}

function validEntry(value) {
  return (
    isObject(value) &&
    typeof value.id === 'string' && ID_RE.test(value.id) &&
    typeof value.revision === 'string' && REVISION_RE.test(value.revision) &&
    typeof value.branch === 'string' && checkBranch(value.branch) &&
    typeof value.path === 'string' && value.path.length <= 4096 &&
    typeof value.sourcePath === 'string' && value.sourcePath.length <= 4096 &&
    typeof value.sourceBranch === 'string' &&
    typeof value.baseCommit === 'string' && FULL_SHA_RE.test(value.baseCommit) &&
    (value.sessionId === null || (typeof value.sessionId === 'string' && SESSION_ID_RE.test(value.sessionId)))
  );
}

function validDocument(value) {
  return (
    isObject(value) &&
    value.schemaVersion === SCHEMA_VERSION &&
    Array.isArray(value.worktrees) &&
    value.worktrees.length <= 500 &&
    value.worktrees.every(validEntry)
  );
}

async function loadRegistry(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { document: emptyDocument(), recovered: false };
    throw error;
  }
  if (raw.length > 8 * 1024 * 1024) throw fail(500, 'worktree_invalid', 'Worktree registry is too large.');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw fail(500, 'worktree_corrupt', 'Worktree registry is corrupt, refusing to continue. No data was changed.');
  }
  // Normalize before validating so entries written before sessionId
  // existed stay readable. Anything else invalid fails closed, data retained.
  if (isObject(parsed) && Array.isArray(parsed.worktrees)) {
    for (const entry of parsed.worktrees) {
      if (isObject(entry) && entry.sessionId === undefined) entry.sessionId = null;
    }
  }
  if (!validDocument(parsed))
    throw fail(500, 'worktree_corrupt', 'Worktree registry is invalid, refusing to continue. No data was changed.');
  return { document: parsed, recovered: false };
}

async function saveRegistry(file, document) {
  document.revision = randomUUID();
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function publicEntry(entry) {
  return {
    id: entry.id,
    revision: entry.revision,
    name: entry.name,
    slug: entry.slug,
    projectCwd: entry.projectCwd,
    sourcePath: entry.sourcePath,
    sourceBranch: entry.sourceBranch,
    baseCommit: entry.baseCommit,
    branch: entry.branch,
    path: entry.path,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    sourceDirtyAtCreate: entry.sourceDirtyAtCreate,
    integratedAt: entry.integratedAt || null,
    integratedSourceHead: entry.integratedSourceHead || null,
    sessionId: entry.sessionId || null,
  };
}

const GIT_SCRUB_EXACT = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
]);

function gitBaseEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (GIT_SCRUB_EXACT.has(key) || key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_'))
      delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  env.GIT_EDITOR = 'true';
  env.GIT_LFS_SKIP_SMUDGE = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

async function runGit(cwd, args, { hooksDir, timeoutMs = WORKTREE_LIMITS.gitTimeoutMs, maxBuffer = 2 * 1024 * 1024 } = {}) {
  for (const arg of args) {
    if (!checkGitArg(arg)) throw fail(400, 'worktree_invalid', 'Invalid git argument.');
  }
  const head = [];
  if (hooksDir) {
    head.push('-c', `core.hooksPath=${hooksDir.replace(/\\/g, '/')}`, '-c', 'core.fsmonitor=false');
  }
  head.push('-c', 'submodule.recurse=false');
  head.push('--no-optional-locks');
  try {
    const { stdout } = await exec('git', [...head, ...args], {
      cwd,
      windowsHide: true,
      shell: false,
      timeout: timeoutMs,
      maxBuffer,
      env: gitBaseEnv(),
    });
    return String(stdout);
  } catch (error) {
    if (error?.code === 'ENOENT')
      throw fail(500, 'worktree_git_unavailable', 'Git is not installed or not on PATH.');
    if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      throw fail(413, 'worktree_invalid', 'Git output too large, refusing to continue.');
    if (error?.killed) throw fail(504, 'worktree_invalid', 'Git timed out, please retry.');
    throw error;
  }
}

const gitStderr = (error) => String(error?.stderr || '').trim().slice(0, 500);

async function showToplevel(cwd, hooksDir) {
  try {
    return (await runGit(cwd, ['rev-parse', '--show-toplevel'], { hooksDir })).trim();
  } catch (error) {
    if (error?.status) throw error;
    if (/not a git repository/i.test(gitStderr(error)))
      throw fail(400, 'worktree_invalid', 'Project is not inside a git repository.');
    throw gitError(409, 'worktree_invalid', 'Cannot inspect git repository.', gitStderr(error));
  }
}

async function commonDirAbs(cwd, hooksDir) {
  const raw = (await runGit(cwd, ['rev-parse', '--git-common-dir'], { hooksDir })).trim();
  if (!raw) throw fail(409, 'worktree_ownership', 'Cannot determine repository ownership.');
  const absolute = raw.includes(':') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)
    ? raw
    : resolve(cwd, raw);
  return resolve(absolute);
}

async function headSha(cwd, hooksDir) {
  try {
    const sha = (await runGit(cwd, ['rev-parse', 'HEAD'], { hooksDir })).trim();
    if (!FULL_SHA_RE.test(sha)) throw new Error('bad sha');
    return sha;
  } catch (error) {
    if (error?.status) throw error;
    throw gitError(400, 'worktree_invalid', 'Repository has no commits yet (unborn HEAD).', gitStderr(error));
  }
}

async function currentBranch(cwd, hooksDir) {
  let name;
  try {
    name = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { hooksDir })).trim();
  } catch (error) {
    if (error?.status) throw error;
    throw gitError(400, 'worktree_invalid', 'Repository has no commits yet (unborn HEAD) or is unreadable.', gitStderr(error));
  }
  if (!name || name === 'HEAD') throw fail(400, 'worktree_invalid', 'Source checkout is detached, open a branch first.');
  if (!checkBranch(name)) throw fail(409, 'worktree_ownership', 'Source branch name is unsupported.');
  return name;
}

function parseStatusZ(out) {
  const tokens = out.split('\0').filter((token) => token.length > 0).slice(0, 600);
  const files = [];
  const untracked = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4 || token[2] !== ' ') continue;
    const code = token.slice(0, 2);
    // Verified against git: in -z porcelain the first path of a rename/copy
    // entry is the destination, the following token is the source to skip.
    let filePath = token.slice(3);
    if ((code[0] === 'R' || code[0] === 'C') && i + 1 < tokens.length) i += 1;
    if (filePath.length > 1024) filePath = filePath.slice(0, 1024);
    if (code === '??') {
      if (untracked.length < WORKTREE_LIMITS.untrackedMax) untracked.push(filePath);
      continue;
    }
    if (files.length < WORKTREE_LIMITS.filesMax) files.push({ path: filePath, code: code.trim() || 'M' });
  }
  return { files, untracked };
}

async function worktreeStatus(cwd, hooksDir) {
  const out = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], {
    hooksDir,
    maxBuffer: WORKTREE_LIMITS.statusMaxBytes,
  });
  const { files, untracked } = parseStatusZ(out);
  return { clean: files.length === 0 && untracked.length === 0, files, untracked };
}

function checkRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    value !== '.' &&
    !value.split('/').includes('..')
  );
}

async function worktreeListPaths(sourceCwd, hooksDir) {
  const out = await runGit(sourceCwd, ['worktree', 'list', '--porcelain'], { hooksDir });
  const paths = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      const value = line.slice(9).trim();
      if (value) paths.push(value);
    }
    if (paths.length > 600) break;
  }
  return paths;
}

async function verifyOwnership(entry, hooksDir) {
  let sourceCommon;
  try {
    sourceCommon = await commonDirAbs(entry.sourcePath, hooksDir);
  } catch (error) {
    if (error?.status) throw error;
    throw fail(409, 'worktree_ownership', 'Source repository is missing or unreadable.');
  }
  let taskCommon;
  try {
    taskCommon = await commonDirAbs(entry.path, hooksDir);
  } catch {
    throw fail(409, 'worktree_ownership', 'Worktree checkout is missing or unreadable.');
  }
  if (keyOf(sourceCommon) !== keyOf(taskCommon))
    throw fail(409, 'worktree_ownership', 'Worktree ownership mismatch, refusing to touch it.');
  const listed = await worktreeListPaths(entry.sourcePath, hooksDir);
  if (!listed.some((value) => keyOf(value) === keyOf(entry.path)))
    throw fail(409, 'worktree_ownership', 'Worktree is not registered with its source repository.');
}

async function managedRealDir(managedRoot) {
  const real = await realpath(managedRoot).catch(() => null);
  return real || resolve(managedRoot);
}

async function assertTaskContained(entry, managedRoot) {
  const managedReal = await managedRealDir(managedRoot);
  // Symlink aware: resolve the task path itself, fall back to lexical only
  // when the path is already gone (prune path handles that separately).
  const taskReal = await realpath(entry.path).catch(() => resolve(entry.path));
  if (!within(managedReal, taskReal))
    throw fail(409, 'worktree_ownership', 'Worktree path escapes managed ownership.');
  const sourceReal = await realpath(entry.sourcePath).catch(() => resolve(entry.sourcePath));
  if (within(managedReal, sourceReal))
    throw fail(409, 'worktree_ownership', 'Source checkout lives inside managed ownership.');
}

async function configuredFilterDrivers(sourceCwd, hooksDir) {
  let out;
  try {
    out = await runGit(sourceCwd, ['config', '--get-regexp', '^filter\\..*\\.(smudge|process)$'], { hooksDir });
  } catch (error) {
    if (error?.code === 1) return new Set();
    if (error?.status) throw error;
    throw gitError(409, 'worktree_invalid', 'Cannot read repository filter configuration.', gitStderr(error));
  }
  const names = new Set();
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.search(/\s/);
    if (space < 0) continue;
    const key = trimmed.slice(0, space);
    if (!key.startsWith('filter.')) continue;
    const rest = key.slice(7);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) continue;
    const kind = rest.slice(dot + 1).toLowerCase();
    if (kind !== 'smudge' && kind !== 'process') continue;
    names.add(rest.slice(0, dot).toLowerCase());
  }
  return names;
}

function filterTokensInText(text, configured) {
  // Direct read of attribute files. Catches exact names, wildcards and
  // [attr] macro definitions alike. Tokens like -filter= / !filter= / bare
  // filter (boolean) never name a driver and are ignored.
  const hits = new Set();
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    for (const token of line.split(/\s+/)) {
      if (!token.startsWith('filter=')) continue;
      const driver = token.slice(7).trim().toLowerCase();
      if (driver && configured.has(driver)) hits.add(driver);
    }
  }
  return hits;
}

async function attributeFileFilterHits(sourceCwd, hooksDir, configured, tracked) {
  const hits = new Set();
  const scan = (text) => {
    for (const driver of filterTokensInText(text, configured)) hits.add(driver);
  };
  for (const name of tracked) {
    if (hits.size > 0) break;
    const base = name.split('/').pop();
    if (base !== '.gitattributes') continue;
    try {
      const out = await runGit(sourceCwd, ['show', `HEAD:${name}`], { hooksDir, maxBuffer: 256 * 1024 });
      scan(out);
    } catch (error) {
      if (error?.status) throw error;
      throw fail(409, 'worktree_unsupported', 'Cannot verify filter drivers, refusing to continue.');
    }
  }
  if (hits.size > 0) return hits;
  try {
    const gitDir = (await runGit(sourceCwd, ['rev-parse', '--git-dir'], { hooksDir })).trim();
    const infoAttrs = resolve(sourceCwd, gitDir, 'info', 'attributes');
    const text = await readFile(infoAttrs, 'utf8').catch(() => null);
    if (typeof text === 'string') scan(text);
  } catch (error) {
    if (error?.status) throw error;
  }
  if (hits.size > 0) return hits;
  try {
    const custom = (await runGit(sourceCwd, ['config', 'core.attributesFile'], { hooksDir }).catch(() => '')).trim();
    if (custom) {
      const text = await readFile(resolve(sourceCwd, custom), 'utf8').catch(() => null);
      if (typeof text === 'string') scan(text);
    }
  } catch (error) {
    if (error?.status) throw error;
  }
  return hits;
}

async function trackedPaths(sourceCwd, hooksDir) {
  let listing;
  try {
    listing = await runGit(sourceCwd, ['ls-files', '-z'], { hooksDir, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    if (error?.status) throw error;
    throw fail(409, 'worktree_unsupported', 'Repository is too large to verify filter drivers in V1.');
  }
  const paths = listing.split('\0').map((s) => s.trim()).filter((s) => s && checkRelativePath(s));
  if (paths.length > WORKTREE_LIMITS.filterScanMaxFiles)
    throw fail(409, 'worktree_unsupported', 'Repository is too large to verify filter drivers in V1.');
  return paths;
}

async function activeFilterDrivers(sourceCwd, hooksDir) {
  const configured = await configuredFilterDrivers(sourceCwd, hooksDir);
  if (configured.size === 0) return [];
  const paths = await trackedPaths(sourceCwd, hooksDir);
  if (paths.length === 0) return [];
  const active = await attributeFileFilterHits(sourceCwd, hooksDir, configured, paths);
  if (active.size > 0) return [...active];
  // Supplementary evaluation through git itself. Raw argv paths: this git
  // build does not apply :(literal) magic in check-attr, and --stdin hangs
  // under execFile on Windows, so plain args in small batches. A batch
  // failure falls back to the file scan above, never to silent approval.
  // Note: git check-attr --stdin hangs under execFile on Windows, never use it.
  for (let i = 0; i < paths.length; i += 400) {
    let out;
    try {
      out = await runGit(sourceCwd, ['check-attr', '-z', 'filter', '--', ...paths.slice(i, i + 400)], {
        hooksDir,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch {
      break;
    }
    const tokens = out.split('\0');
    for (let j = 0; j + 2 < tokens.length; j += 3) {
      const value = (tokens[j + 2] || '').trim().toLowerCase();
      if (value && value !== 'unspecified' && value !== 'unset' && configured.has(value)) active.add(value);
    }
    if (active.size > 0) break;
  }
  return [...active];
}

async function ensureNoHooksDir(dir) {
  let info = await lstat(dir).catch(() => null);
  if (!info) {
    await mkdir(dir, { recursive: true });
    info = await lstat(dir).catch(() => null);
  }
  // Fail closed: never delete existing content, never follow symlinks.
  if (!info || info.isSymbolicLink() || !info.isDirectory())
    throw fail(500, 'worktree_invalid', 'Hook guard is not a plain directory, refusing to run git.');
  const names = await readdir(dir);
  if (names.length > 0)
    throw fail(500, 'worktree_invalid', 'Hook guard is contaminated, refusing to run git.');
}

function parseNumstatZ(out, max = WORKTREE_LIMITS.numstatMax) {
  const tokens = out.split('\0').filter((token) => token.length > 0);
  const rows = [];
  const binary = [];
  for (let i = 0; i < tokens.length && rows.length < max; i++) {
    const token = tokens[i];
    const tab = token.indexOf('\t');
    if (tab < 0) continue;
    const parts = token.split('\t');
    if (parts.length < 3) continue;
    let filePath = parts.slice(2).join('\t');
    if (i + 1 < tokens.length && !tokens[i + 1].includes('\t')) {
      i += 1;
      filePath = tokens[i];
    }
    if (!checkRelativePath(filePath)) continue;
    const isBinary = parts[0] === '-' && parts[1] === '-';
    rows.push({
      path: filePath,
      added: isBinary ? null : Number.parseInt(parts[0], 10) || 0,
      removed: isBinary ? null : Number.parseInt(parts[1], 10) || 0,
    });
    if (isBinary && binary.length < max) binary.push(filePath);
  }
  return { rows, binary };
}

async function nameOnly(cwd, hooksDir, from, to, max) {
  const out = await runGit(
    cwd,
    ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--name-only', '-z', from, to, '--'],
    { hooksDir, maxBuffer: 2 * 1024 * 1024 },
  );
  return out.split('\0').map((s) => s.trim()).filter((s) => s && checkRelativePath(s)).slice(0, max);
}

function truncateUtf8(text, maxBytes) {
  // Byte based cut that never splits a multi-byte sequence: Buffer slicing
  // plus utf8 decode drops a trailing partial character safely.
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return { text, truncated: false, bytes: total };
  let cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  const last = cut.lastIndexOf('\n');
  if (last > 0) cut = cut.slice(0, last);
  const marked = `${cut}\n... [truncated at ${maxBytes} bytes]`;
  return { text: marked, truncated: true, bytes: Buffer.byteLength(marked, 'utf8') };
}

async function boundedPatch(cwd, hooksDir, from, to, files) {
  const picked = files.filter(checkRelativePath).slice(0, WORKTREE_LIMITS.patchMaxFiles);
  const truncatedByFiles = files.length > picked.length;
  if (picked.length === 0) {
    return { patch: '', truncated: truncatedByFiles, bytes: 0 };
  }
  // git diff honors :(literal) pathspecs, so exact filenames with glob
  // characters still select exactly themselves.
  const literal = picked.map((value) => `:(literal)${value}`);
  let out;
  try {
    out = await runGit(
      cwd,
      ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--unified=3', from, to, '--', ...literal],
      { hooksDir, maxBuffer: 2 * 1024 * 1024 },
    );
  } catch (error) {
    if (error?.status) throw error;
    throw gitError(409, 'worktree_invalid', 'Cannot compute diff.', gitStderr(error));
  }
  const cut = truncateUtf8(out, WORKTREE_LIMITS.patchMaxBytes);
  return { patch: cut.text, truncated: truncatedByFiles || cut.truncated, bytes: cut.bytes };
}

async function aheadBehind(cwd, hooksDir, sourceHead, taskHead) {
  if (!SHA_RE.test(sourceHead) || !SHA_RE.test(taskHead))
    throw fail(400, 'worktree_invalid', 'Invalid commit reference.');
  const out = await runGit(cwd, ['rev-list', '--left-right', '--count', `${sourceHead}...${taskHead}`], { hooksDir });
  const [behindRaw, aheadRaw] = out.trim().split(/\s+/);
  const behind = Number.parseInt(behindRaw, 10);
  const ahead = Number.parseInt(aheadRaw, 10);
  if (!Number.isSafeInteger(behind) || !Number.isSafeInteger(ahead))
    throw fail(409, 'worktree_invalid', 'Cannot compare repository history.');
  return { ahead, behind };
}

async function isAncestor(cwd, hooksDir, maybeAncestor, head) {
  if (!SHA_RE.test(maybeAncestor) || !SHA_RE.test(head))
    throw fail(400, 'worktree_invalid', 'Invalid commit reference.');
  try {
    await runGit(cwd, ['merge-base', '--is-ancestor', maybeAncestor, head], { hooksDir });
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    if (error?.status) throw error;
    throw gitError(409, 'worktree_invalid', 'Cannot compare repository history.', gitStderr(error));
  }
}

async function pathExists(value) {
  try {
    await lstat(value);
    return true;
  } catch {
    return false;
  }
}

export function createWorktrees({ dataDir, isBusy, now } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.length > 4096 || !isAbsolute(dataDir))
    throw new HttpError(400, 'Studio dataDir must be an absolute path.');
  const root = resolve(dataDir.trim());
  const file = join(root, 'worktrees.json');
  const managedRoot = join(root, 'worktrees');
  const locksDir = join(root, 'worktrees-locks');
  const hooksDir = join(root, 'worktrees-nohooks');
  const busy = typeof isBusy === 'function' ? isBusy : () => false;
  const clock = typeof now === 'function' ? now : () => Date.now();

  async function resolveProjectDir(projectCwd) {
    if (typeof projectCwd !== 'string' || !projectCwd.trim() || projectCwd.length > 4096 || !isAbsolute(projectCwd))
      throw fail(400, 'worktree_invalid', 'projectCwd must be an absolute directory path.');
    const resolved = resolve(projectCwd.trim());
    const info = await stat(resolved).catch(() => null);
    if (!info?.isDirectory()) throw fail(404, 'worktree_missing', 'Project directory is missing.');
    return { input: resolved, real: await realpath(resolved).catch(() => resolved) };
  }

  function repoLockName(value) {
    return join(locksDir, `repo-${createHash('sha256').update(keyOf(value)).digest('hex').slice(0, 32)}.lock`);
  }
  const registryLock = join(locksDir, 'registry.lock');

  async function withRepoMutation(repoKey, fn) {
    return serialize(`repo:${keyOf(repoKey)}`, () =>
      withFileLock(repoLockName(repoKey), () =>
        serialize('registry', () => withFileLock(registryLock, fn)),
      ),
    );
  }

  function matchProject(entry, query) {
    return keyOf(entry.projectCwd) === keyOf(query) || keyOf(entry.sourcePath) === keyOf(query);
  }

  async function create({ projectCwd, name }) {
    const project = await resolveProjectDir(projectCwd);
    if (within(managedRoot, project.real) || within(project.real, managedRoot))
      throw fail(400, 'worktree_invalid', 'Project must live outside the managed worktree directory.');
    await ensureNoHooksDir(hooksDir);
    const toplevelRaw = await showToplevel(project.real, hooksDir);
    const toplevel = await realpath(resolve(project.real, toplevelRaw)).catch(() => resolve(project.real, toplevelRaw));
    if (within(managedRoot, toplevel))
      throw fail(400, 'worktree_invalid', 'Repository must live outside the managed worktree directory.');
    const sourceBranch = await currentBranch(toplevel, hooksDir);
    const baseCommit = await headSha(toplevel, hooksDir);
    const activeDrivers = await activeFilterDrivers(toplevel, hooksDir);
    if (activeDrivers.length > 0)
      throw fail(409, 'worktree_unsupported', `Repository uses filter driver "${activeDrivers[0]}", not supported in V1.`);
    const status = await worktreeStatus(toplevel, hooksDir);
    const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : 'task';
    if (/[\0]/.test(label)) throw fail(400, 'worktree_invalid', 'Invalid task name.');
    const slug = slugify(label);
    await mkdir(managedRoot, { recursive: true });
    const managedReal = await realpath(managedRoot).catch(() => managedRoot);

    return withRepoMutation(toplevel, async () => {
      const { document } = await loadRegistry(file);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const rand = randomBytes(6).toString('hex');
        const id = `wt-${rand}`;
        const branch = `studio/wt-${slug}-${rand.slice(0, 6)}`;
        if (!checkBranch(branch)) continue;
        const dirName = `${slug}-${rand.slice(0, 8)}`;
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,64}$/.test(dirName)) continue;
        const taskPath = join(managedReal, dirName);
        if (!within(managedReal, taskPath)) continue;
        if (document.worktrees.some((entry) => entry.id === id)) continue;
        if (await pathExists(taskPath)) continue;
        const link = await lstat(taskPath).catch(() => null);
        if (link) continue;
        let added = false;
        try {
          await runGit(toplevel, ['worktree', 'add', '-b', branch, taskPath, baseCommit], { hooksDir, timeoutMs: 30000 });
          added = true;
        } catch (error) {
          if (error?.status) throw error;
          throw gitError(409, 'worktree_invalid', 'Cannot create task worktree.', gitStderr(error));
        }
        try {
          const taskReal = await realpath(taskPath);
          if (!within(managedReal, taskReal)) {
            await runGit(toplevel, ['worktree', 'remove', '--force', taskPath], { hooksDir }).catch(() => {});
            throw fail(409, 'worktree_ownership', 'Worktree path escaped managed ownership.');
          }
          const listed = await worktreeListPaths(toplevel, hooksDir);
          if (!listed.some((value) => keyOf(value) === keyOf(taskPath)))
            throw fail(409, 'worktree_ownership', 'Worktree registration failed.');
          const taskHead = await headSha(taskPath, hooksDir);
          if (taskHead !== baseCommit)
            throw fail(409, 'worktree_invalid', 'Worktree started from an unexpected commit.');
          const timestamp = isoNow(clock);
          const entry = {
            id,
            revision: randomUUID(),
            name: label,
            slug,
            projectCwd: project.input,
            sourcePath: toplevel,
            sourceBranch,
            baseCommit,
            branch,
            path: taskPath,
            createdAt: timestamp,
            updatedAt: timestamp,
            sourceDirtyAtCreate: !status.clean,
            integratedAt: null,
            integratedSourceHead: null,
            sessionId: null,
          };
          const fresh = (await loadRegistry(file)).document;
          if (fresh.worktrees.some((item) => item.id === id))
            throw fail(409, 'worktree_conflict', 'Worktree id collision, please retry.');
          fresh.worktrees.push(entry);
          await saveRegistry(file, fresh);
          return { worktree: publicEntry(entry), sourceDirty: !status.clean, baseCommit };
        } catch (error) {
          if (added && within(managedReal, taskPath)) {
            await runGit(toplevel, ['worktree', 'remove', '--force', taskPath], { hooksDir }).catch(() => {});
            await rm(taskPath, { recursive: true, force: true }).catch(() => {});
          }
          throw error;
        }
      }
      throw fail(409, 'worktree_invalid', 'Cannot allocate a managed worktree path, please retry.');
    });
  }

  async function list({ projectCwd } = {}) {
    const project = await resolveProjectDir(projectCwd);
    const { document } = await loadRegistry(file);
    return {
      worktrees: document.worktrees
        .filter((entry) => matchProject(entry, project.input) || matchProject(entry, project.real))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map(publicEntry),
    };
  }

  async function findEntry(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw fail(404, 'worktree_missing', 'Worktree not found.');
    const { document } = await loadRegistry(file);
    const entry = document.worktrees.find((item) => item.id === id);
    if (!entry) throw fail(404, 'worktree_missing', 'Worktree not found.');
    return entry;
  }

  async function inspect({ id }) {
    const entry = await findEntry(id);
    const detail = {
      worktree: publicEntry(entry),
      main: null,
      task: null,
      baseCommit: entry.baseCommit,
      sourceDirtyAtCreate: entry.sourceDirtyAtCreate,
      ahead: null,
      behind: null,
      files: [],
      committedFiles: [],
      binary: [],
      numstat: [],
      untracked: [],
      diff: null,
      orphaned: false,
      reason: null,
    };
    let sourceHead = null;
    let taskHead = null;
    try {
      const branch = await currentBranch(entry.sourcePath, hooksDir).catch(() => null);
      sourceHead = await headSha(entry.sourcePath, hooksDir);
      const status = await worktreeStatus(entry.sourcePath, hooksDir);
      detail.main = { path: entry.sourcePath, branch, head: sourceHead, clean: status.clean };
    } catch {
      detail.orphaned = true;
      detail.reason = 'Source checkout is missing or unreadable.';
    }
    try {
      taskHead = await headSha(entry.path, hooksDir);
      const status = await worktreeStatus(entry.path, hooksDir);
      const branch = await runGit(entry.path, ['rev-parse', '--abbrev-ref', 'HEAD'], { hooksDir }).then((s) => s.trim()).catch(() => null);
      detail.task = { path: entry.path, branch, head: taskHead, clean: status.clean };
      detail.files = status.files;
      detail.untracked = status.untracked;
    } catch {
      detail.orphaned = true;
      detail.reason = detail.reason || 'Worktree checkout is missing or unreadable.';
    }
    if (!detail.orphaned) {
      try {
        await assertTaskContained(entry, managedRoot);
      } catch {
        detail.orphaned = true;
        detail.reason = 'Worktree path escapes managed ownership.';
      }
    }
    if (detail.orphaned || !sourceHead || !taskHead) {
      detail.diff = {
        patch: '', truncated: false, bytes: 0,
        workingPatch: '', workingTruncated: false, workingBytes: 0,
        committedFiles: [], files: detail.files, binary: [], numstat: [],
        untracked: detail.untracked, untrackedIncluded: false,
        note: 'Worktree is orphaned, no diff available.',
      };
      return detail;
    }
    try {
      await verifyOwnership(entry, hooksDir);
    } catch {
      detail.orphaned = true;
      detail.reason = 'Worktree ownership mismatch.';
      detail.diff = {
        patch: '', truncated: false, bytes: 0,
        workingPatch: '', workingTruncated: false, workingBytes: 0,
        committedFiles: [], files: detail.files, binary: [], numstat: [],
        untracked: detail.untracked, untrackedIncluded: false,
        note: 'Ownership mismatch, no diff available.',
      };
      return detail;
    }
    const counts = await aheadBehind(entry.sourcePath, hooksDir, sourceHead, taskHead);
    detail.ahead = counts.ahead;
    detail.behind = counts.behind;
    const committedNames = sourceHead === taskHead ? [] : await nameOnly(entry.sourcePath, hooksDir, sourceHead, taskHead, WORKTREE_LIMITS.filesMax + 1);
    detail.committedFiles = committedNames.slice(0, WORKTREE_LIMITS.filesMax);
    let numstat = { rows: [], binary: [] };
    if (sourceHead !== taskHead) {
      const out = await runGit(
        entry.sourcePath,
        ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--numstat', '-z', sourceHead, taskHead, '--'],
        { hooksDir, maxBuffer: 2 * 1024 * 1024 },
      );
      numstat = parseNumstatZ(out);
    }
    detail.numstat = numstat.rows;
    detail.binary = numstat.binary;
    const committed = await boundedPatch(entry.sourcePath, hooksDir, sourceHead, taskHead, committedNames);
    const workingNames = detail.files.map((item) => item.path).filter(checkRelativePath);
    let workingPatch = { patch: '', truncated: false, bytes: 0 };
    if (workingNames.length > 0) {
      const literalWorking = workingNames
        .slice(0, WORKTREE_LIMITS.patchMaxFiles)
        .map((value) => `:(literal)${value}`);
      const out = await runGit(
        entry.path,
        ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--unified=3', 'HEAD', '--', ...literalWorking],
        { hooksDir, maxBuffer: 2 * 1024 * 1024 },
      ).catch(() => '');
      const cut = truncateUtf8(out, WORKTREE_LIMITS.patchMaxBytes);
      workingPatch = {
        patch: cut.text,
        truncated: workingNames.length > WORKTREE_LIMITS.patchMaxFiles || cut.truncated,
        bytes: cut.bytes,
      };
    }
    detail.diff = {
      patch: committed.patch,
      truncated: committed.truncated || committedNames.length > WORKTREE_LIMITS.filesMax,
      bytes: committed.bytes,
      workingPatch: workingPatch.patch,
      workingTruncated: workingPatch.truncated,
      workingBytes: workingPatch.bytes,
      committedFiles: detail.committedFiles,
      files: detail.files,
      binary: detail.binary,
      numstat: detail.numstat,
      untracked: detail.untracked,
      untrackedIncluded: false,
      note: 'patch shows committed worktree changes vs current source HEAD (what a fast-forward merge would bring in). workingPatch and untracked names are pending only, never auto included, untracked content is never read. Re-inspect before confirming the merge.',
    };
    return detail;
  }

  async function integrate({ id, revision, confirm, expectedSourceHead, expectedWorktreeHead }) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw fail(404, 'worktree_missing', 'Worktree not found.');
    if (typeof revision !== 'string' || !REVISION_RE.test(revision))
      throw fail(409, 'worktree_conflict', 'Revision is required and must match.');
    if (confirm !== true) throw fail(400, 'worktree_invalid', 'Fast-forward merge requires explicit confirmation.');
    // Fresh confirmation: both heads are required as full hashes, never optional.
    for (const sha of [expectedSourceHead, expectedWorktreeHead]) {
      if (typeof sha !== 'string' || !FULL_SHA_RE.test(sha))
        throw fail(400, 'worktree_invalid', 'Fresh expected source and worktree heads (full hashes) are required.');
    }
    const registered = await findEntry(id);
    if (registered.revision !== revision)
      throw fail(409, 'worktree_conflict', 'Worktree changed, re-inspect and retry.');
    if (await busy([registered.sourcePath, registered.path]))
      throw fail(409, 'worktree_busy', 'Worktree or project is busy, please retry later.');
    return withRepoMutation(registered.sourcePath, async () => {
      const { document } = await loadRegistry(file);
      const entry = document.worktrees.find((item) => item.id === id);
      if (!entry) throw fail(404, 'worktree_missing', 'Worktree not found.');
      if (entry.revision !== revision)
        throw fail(409, 'worktree_conflict', 'Worktree changed, re-inspect and retry.');
      // Authoritative busy recheck inside the lock: the pre-lock check races.
      if (await busy([entry.sourcePath, entry.path]))
        throw fail(409, 'worktree_busy', 'Worktree or project is busy, please retry later.');
      await ensureNoHooksDir(hooksDir);
      await assertTaskContained(entry, managedRoot);
      await verifyOwnership(entry, hooksDir);
      const sourceBranch = await currentBranch(entry.sourcePath, hooksDir).catch(() => null);
      if (sourceBranch !== entry.sourceBranch)
        throw fail(409, 'worktree_conflict', `Source is on "${sourceBranch || 'unknown'}", expected "${entry.sourceBranch}".`);
      const sourceHead = await headSha(entry.sourcePath, hooksDir);
      const taskHead = await headSha(entry.path, hooksDir);
      const taskBranch = await runGit(entry.path, ['rev-parse', '--abbrev-ref', 'HEAD'], { hooksDir }).then((s) => s.trim()).catch(() => null);
      if (taskBranch !== entry.branch)
        throw fail(409, 'worktree_conflict', 'Worktree checkout switched branch, refusing the merge.');
      if (sourceHead.toLowerCase() !== expectedSourceHead.toLowerCase())
        throw fail(409, 'worktree_conflict', 'Source branch changed since inspect, re-inspect and retry.');
      if (taskHead.toLowerCase() !== expectedWorktreeHead.toLowerCase())
        throw fail(409, 'worktree_conflict', 'Worktree changed since inspect, re-inspect and retry.');
      // Worktree commits can introduce new attribute files, so recheck both sides.
      for (const side of [entry.sourcePath, entry.path]) {
        const drivers = await activeFilterDrivers(side, hooksDir);
        if (drivers.length > 0)
          throw fail(409, 'worktree_unsupported', `Filter driver "${drivers[0]}" became active, not supported in V1.`);
      }
      const sourceStatus = await worktreeStatus(entry.sourcePath, hooksDir);
      if (!sourceStatus.clean)
        throw fail(409, 'worktree_dirty', 'Source checkout has uncommitted changes, commit or discard them first.');
      const taskStatus = await worktreeStatus(entry.path, hooksDir);
      if (!taskStatus.clean)
        throw fail(409, 'worktree_dirty', 'Worktree has uncommitted changes, commit them in the worktree first.');
      if (sourceHead === taskHead) {
        entry.updatedAt = isoNow(clock);
        entry.revision = randomUUID();
        entry.integratedAt = entry.integratedAt || entry.updatedAt;
        entry.integratedSourceHead = sourceHead;
        await saveRegistry(file, document);
        return { integrated: true, alreadyUpToDate: true, sourceHead, worktreeHead: taskHead };
      }
      if (!(await isAncestor(entry.sourcePath, hooksDir, sourceHead, taskHead)))
        throw fail(409, 'worktree_not_fast_forward', 'Worktree diverged from source, merge the target branch into the worktree first.');
      try {
        await runGit(entry.sourcePath, ['merge', '--ff-only', taskHead], { hooksDir, timeoutMs: 30000 });
      } catch (error) {
        if (error?.status) throw error;
        throw gitError(409, 'worktree_not_fast_forward', 'Fast-forward merge failed.', gitStderr(error));
      }
      const merged = await headSha(entry.sourcePath, hooksDir);
      if (merged !== taskHead)
        throw fail(409, 'worktree_not_fast_forward', 'Source branch did not land on the worktree head.');
      entry.updatedAt = isoNow(clock);
      entry.revision = randomUUID();
      entry.integratedAt = entry.updatedAt;
      entry.integratedSourceHead = merged;
      await saveRegistry(file, document);
      return { integrated: true, alreadyUpToDate: false, sourceHead: merged, worktreeHead: taskHead };
    });
  }

  async function remove({ id, revision, confirm, discard }) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw fail(404, 'worktree_missing', 'Worktree not found.');
    if (typeof revision !== 'string' || !REVISION_RE.test(revision))
      throw fail(409, 'worktree_conflict', 'Revision is required and must match.');
    if (confirm !== true) throw fail(400, 'worktree_invalid', 'Removal requires explicit confirmation.');
    if (discard !== undefined && typeof discard !== 'boolean')
      throw fail(400, 'worktree_invalid', 'discard must be a boolean.');
    const registered = await findEntry(id);
    if (registered.revision !== revision)
      throw fail(409, 'worktree_conflict', 'Worktree changed, re-inspect and retry.');
    if (!within(managedRoot, resolve(registered.path)))
      throw fail(409, 'worktree_ownership', 'Worktree path is outside managed ownership.');
    if (await busy([registered.sourcePath, registered.path]))
      throw fail(409, 'worktree_busy', 'Worktree or project is busy, please retry later.');
    return withRepoMutation(registered.sourcePath, async () => {
      const { document } = await loadRegistry(file);
      const index = document.worktrees.findIndex((item) => item.id === id);
      if (index < 0) throw fail(404, 'worktree_missing', 'Worktree not found.');
      const entry = document.worktrees[index];
      if (entry.revision !== revision)
        throw fail(409, 'worktree_conflict', 'Worktree changed, re-inspect and retry.');
      if (await busy([entry.sourcePath, entry.path]))
        throw fail(409, 'worktree_busy', 'Worktree or project is busy, please retry later.');
      if (!within(managedRoot, resolve(entry.path)))
        throw fail(409, 'worktree_ownership', 'Worktree path is outside managed ownership.');
      const missing = !(await pathExists(entry.path));
      if (missing) {
        // Prune path: only drop this registry entry, never touch another path.
        document.worktrees.splice(index, 1);
        await saveRegistry(file, document);
        return { removed: true, pruned: true, branchRetained: entry.branch };
      }
      await ensureNoHooksDir(hooksDir);
      await assertTaskContained(entry, managedRoot);
      await verifyOwnership(entry, hooksDir);
      const sourceHead = await headSha(entry.sourcePath, hooksDir);
      const taskHead = await headSha(entry.path, hooksDir);
      // The checkout must still be on the recorded branch, otherwise removal
      // could strand commits while claiming the branch was retained.
      const taskBranch = await runGit(entry.path, ['rev-parse', '--abbrev-ref', 'HEAD'], { hooksDir }).then((s) => s.trim()).catch(() => null);
      if (taskBranch !== entry.branch)
        throw fail(409, 'worktree_conflict', 'Worktree checkout switched branch, refusing removal.');
      const status = await worktreeStatus(entry.path, hooksDir);
      const merged = sourceHead === taskHead || (await isAncestor(entry.path, hooksDir, taskHead, sourceHead));
      if (!status.clean && discard !== true)
        throw fail(409, 'worktree_dirty', 'Worktree has uncommitted changes, confirm discard to remove it.');
      if (!merged && discard !== true)
        throw fail(409, 'worktree_unmerged', 'Worktree has commits not in the source branch, confirm discard to remove it.');
      try {
        const args = discard === true
          ? ['worktree', 'remove', '--force', entry.path]
          : ['worktree', 'remove', entry.path];
        await runGit(entry.sourcePath, args, { hooksDir, timeoutMs: 30000 });
      } catch (error) {
        if (error?.status) throw error;
        throw gitError(409, 'worktree_invalid', 'Cannot remove the worktree.', gitStderr(error));
      }
      document.worktrees.splice(index, 1);
      await saveRegistry(file, document);
      return { removed: true, pruned: false, branchRetained: entry.branch };
    });
  }

  async function bindSession({ id, revision, sessionId }) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw fail(404, 'worktree_missing', 'Worktree not found.');
    if (typeof revision !== 'string' || !REVISION_RE.test(revision))
      throw fail(409, 'worktree_conflict', 'Revision is required and must match.');
    if (sessionId !== null && !(typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId)))
      throw fail(400, 'worktree_invalid', 'sessionId must be a valid session id or null.');
    return serialize('registry', () =>
      withFileLock(join(locksDir, 'registry.lock'), async () => {
        const { document } = await loadRegistry(file);
        const entry = document.worktrees.find((item) => item.id === id);
        if (!entry) throw fail(404, 'worktree_missing', 'Worktree not found.');
        if (entry.revision !== revision)
          throw fail(409, 'worktree_conflict', 'Worktree changed, re-inspect and retry.');
        entry.sessionId = sessionId;
        entry.updatedAt = isoNow(clock);
        entry.revision = randomUUID();
        await saveRegistry(file, document);
        return { worktree: publicEntry(entry) };
      }),
    );
  }

  async function findByPath({ path } = {}) {
    // Validated read-only lookup for server run binding. No git calls, no
    // busy gate, no locks, no ownership side effects. Fails closed on a
    // corrupt registry via loadRegistry. Returns the public entry or null.
    if (typeof path !== 'string' || !path.trim() || path.length > 4096 || !isAbsolute(path))
      throw fail(400, 'worktree_invalid', 'path must be an absolute path.');
    const { document } = await loadRegistry(file);
    const needle = resolve(path.trim());
    const keys = new Set([keyOf(needle)]);
    const needleReal = await realpath(needle).catch(() => null);
    if (needleReal) keys.add(keyOf(needleReal));
    for (const item of document.worktrees) {
      if (typeof item.path !== 'string' || !isAbsolute(item.path)) continue;
      if (keys.has(keyOf(resolve(item.path)))) return publicEntry(item);
    }
    for (const item of document.worktrees) {
      if (typeof item.path !== 'string' || !isAbsolute(item.path)) continue;
      const itemReal = await realpath(item.path).catch(() => null);
      if (itemReal && keys.has(keyOf(itemReal))) return publicEntry(item);
    }
    return null;
  }

  return { file, managedRoot, create, list, inspect, integrate, remove, bindSession, findByPath };
}
