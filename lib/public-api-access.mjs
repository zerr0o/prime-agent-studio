import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './store.mjs';
import { PUBLIC_API_SCOPES } from './public-api-contract.mjs';

export { PUBLIC_API_SCOPES };
const PROJECT_ID_PATTERN = /^p_[0-9a-f]{32}$/;
const MAX_NAME_LENGTH = 64;
const MAX_PROJECT_IDS = 100;
const MAX_TOKENS = 100;
const READ_CAP_BYTES = 1024 * 1024;

const fail = (status, code, extra) => {
  const error = new HttpError(status, code);
  error.code = code;
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  if (error.code === undefined) error.code = code;
  return error;
};

function sanitizeToken(entry) {
  return {
    id: entry.id,
    name: entry.name,
    scopes: [...entry.scopes],
    projectIds: [...entry.projectIds],
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  };
}

function checkName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_NAME_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  return true;
}

function checkScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > PUBLIC_API_SCOPES.length) return false;
  const seen = new Set();
  for (const scope of scopes) {
    if (typeof scope !== 'string' || !PUBLIC_API_SCOPES.includes(scope) || seen.has(scope)) return false;
    seen.add(scope);
  }
  return seen.has('read');
}

function checkProjectIds(projectIds) {
  if (!Array.isArray(projectIds) || projectIds.length < 1 || projectIds.length > MAX_PROJECT_IDS)
    return false;
  if (projectIds.length === 1 && projectIds[0] === '*') return true;
  const seen = new Set();
  for (const id of projectIds) {
    if (typeof id !== 'string' || !PROJECT_ID_PATTERN.test(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function normalizeExpiresAt(value, nowMs) {
  if (value === undefined || value === null || value === '') return null;
  let ms = null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return { invalid: true };
    ms = value;
  } else if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return { invalid: true };
    ms = parsed;
  } else {
    return { invalid: true };
  }
  if (ms <= nowMs) return { invalid: true };
  try {
    return { iso: new Date(ms).toISOString() };
  } catch {
    return { invalid: true };
  }
}

function digestOf(credential) {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

/** Generic integration-token store for the versioned public API. Local UI only; no self-issuing route. */
export function createPublicApiAccess({ dataDir, now } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new Error('dataDir is required');
  const nowMs = typeof now === 'function' ? now : () => Date.now();
  const file = join(dataDir, 'public-api.json');
  const tracked = new Map();
  const timers = new Set();
  let writes = Promise.resolve();
  let closedAccess = false;

  function untrack(res, id) {
    const set = tracked.get(id);
    if (set) {
      set.delete(res);
      if (!set.size) tracked.delete(id);
    }
  }

  function destroyRes(res) {
    try {
      if (!res || res.destroyed || res.writableEnded) return;
      res.destroy();
    } catch {}
  }

  function closeTokenResponses(id) {
    const set = tracked.get(id);
    if (!set) return;
    for (const res of [...set]) destroyRes(res);
  }

  function closeAllResponses() {
    for (const set of tracked.values()) for (const res of [...set]) destroyRes(res);
  }

  async function readState() {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > READ_CAP_BYTES)
        throw new Error('unreadable');
      const raw = await readFile(file, 'utf8');
      const data = JSON.parse(raw);
      if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('unreadable');
      if (typeof data.enabled !== 'boolean') throw new Error('unreadable');
      if (!Number.isInteger(data.revision) || data.revision < 0) throw new Error('unreadable');
      if (!Array.isArray(data.tokens)) throw new Error('unreadable');
      for (const entry of data.tokens) {
        if (!entry || typeof entry !== 'object') throw new Error('unreadable');
        if (typeof entry.id !== 'string' || !entry.id) throw new Error('unreadable');
        if (!checkName(entry.name)) throw new Error('unreadable');
        if (!checkScopes(entry.scopes)) throw new Error('unreadable');
        if (!checkProjectIds(entry.projectIds)) throw new Error('unreadable');
        if (typeof entry.createdAt !== 'string' || Number.isNaN(Date.parse(entry.createdAt)))
          throw new Error('unreadable');
        if (
          entry.expiresAt !== null &&
          (typeof entry.expiresAt !== 'string' || Number.isNaN(Date.parse(entry.expiresAt)))
        )
          throw new Error('unreadable');
        if (typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest))
          throw new Error('unreadable');
      }
      return data;
    } catch (error) {
      if (error?.code === 'ENOENT') return { enabled: false, revision: 0, tokens: [] };
      if (error instanceof HttpError) throw error;
      throw fail(500, 'api_configuration_unreadable');
    }
  }

  function stateOf(data) {
    return {
      enabled: data.enabled,
      revision: data.revision,
      tokens: data.tokens.map(sanitizeToken),
      scopes: [...PUBLIC_API_SCOPES],
    };
  }

  function persistedBytes(value) {
    return Buffer.byteLength(JSON.stringify(value, null, 2) + '\n', 'utf8');
  }
  async function persist(data) {
    const revision = data.revision;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const preview = { ...data, revision: revision + 1 };
      if (persistedBytes(preview) > READ_CAP_BYTES) throw fail(400, 'invalid_token_request');
      await mkdir(dataDir, { recursive: true });
      await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      const current = await readState();
      if (current.revision !== revision)
        throw fail(409, 'revision_conflict', { currentRevision: current.revision });
      data.revision = revision + 1;
      if (persistedBytes(data) > READ_CAP_BYTES) throw fail(400, 'invalid_token_request');
      await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      if (error instanceof HttpError) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      await rm(temporary, { force: true }).catch(() => {});
      // Re-read to report the live revision on write races.
      try {
        const current = await readState();
        if (Number.isInteger(current.revision) && current.revision !== revision)
          throw fail(409, 'revision_conflict', { currentRevision: current.revision });
      } catch (inner) {
        if (inner instanceof HttpError && inner.status === 409) throw inner;
      }
      throw fail(500, 'api_configuration_not_saved');
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return data;
  }

  function requireRevision(input, current) {
    if (!Number.isInteger(input) || input !== current)
      throw fail(409, 'revision_conflict', { currentRevision: current });
  }

  async function get() {
    await writes.catch(() => {});
    return stateOf(await readState());
  }

  async function configure(input) {
    if (
      !input ||
      Object.keys(input).some((key) => !['enabled', 'revision'].includes(key)) ||
      typeof input.enabled !== 'boolean' ||
      !Number.isInteger(input?.revision)
    )
      throw fail(400, 'invalid_configuration');
    const operation = writes
      .catch(() => {})
      .then(async () => {
        const data = await readState();
        requireRevision(input.revision, data.revision);
        const next = { enabled: input.enabled, revision: data.revision, tokens: data.tokens };
        await persist(next);
        if (!next.enabled) closeAllResponses();
        return stateOf(next);
      });
    writes = operation;
    return operation;
  }

  async function createToken(input) {
    const keys = input ? Object.keys(input) : [];
    if (
      !input ||
      keys.some((key) => !['name', 'scopes', 'projectIds', 'expiresAt', 'revision'].includes(key)) ||
      !checkName(input.name) ||
      !checkScopes(input.scopes) ||
      !checkProjectIds(input.projectIds) ||
      !Number.isInteger(input.revision)
    )
      throw fail(400, 'invalid_token_request');
    const normalized = normalizeExpiresAt(input.expiresAt, nowMs());
    if (normalized?.invalid) throw fail(400, 'invalid_token_request');
    const operation = writes
      .catch(() => {})
      .then(async () => {
        const data = await readState();
        requireRevision(input.revision, data.revision);
        const credential = `pa_${randomBytes(32).toString('base64url')}`;
        const entry = {
          id: randomUUID(),
          name: input.name.trim(),
          scopes: [...new Set(input.scopes)],
          projectIds: [...input.projectIds],
          createdAt: new Date(nowMs()).toISOString(),
          expiresAt: normalized ? normalized.iso : null,
          digest: digestOf(credential),
        };
        if (data.tokens.length >= MAX_TOKENS) throw fail(400, 'invalid_token_request');
        const next = { enabled: data.enabled, revision: data.revision, tokens: [...data.tokens, entry] };
        await persist(next);
        return { token: sanitizeToken(entry), credential, state: stateOf(next) };
      });
    writes = operation;
    return operation;
  }

  async function revoke(input) {
    if (
      !input ||
      Object.keys(input).some((key) => !['id', 'revision'].includes(key)) ||
      typeof input.id !== 'string' ||
      !input.id ||
      !Number.isInteger(input.revision)
    )
      throw fail(400, 'invalid_token_request');
    const operation = writes
      .catch(() => {})
      .then(async () => {
        const data = await readState();
        requireRevision(input.revision, data.revision);
        const index = data.tokens.findIndex((entry) => entry.id === input.id);
        if (index === -1) throw fail(404, 'token_not_found');
        const next = {
          enabled: data.enabled,
          revision: data.revision,
          tokens: data.tokens.filter((entry) => entry.id !== input.id),
        };
        await persist(next);
        closeTokenResponses(input.id);
        return stateOf(next);
      });
    writes = operation;
    return operation;
  }

  function bearerOf(req) {
    if (typeof req === 'string') return req;
    const headers = req?.headers || {};
    const value = headers.authorization ?? headers.Authorization ?? req?.authorization;
    if (typeof value !== 'string') return '';
    const match = value.match(/^Bearer\s+(.+?)\s*$/i);
    return match ? match[1] : '';
  }

  async function authenticate(req) {
    if (closedAccess) throw fail(503, 'api_unavailable');
    await writes.catch(() => {});
    const data = await readState();
    if (!data.enabled) throw fail(404, 'api_disabled');
    const credential = bearerOf(req);
    if (!credential) throw fail(401, 'api_unauthorized');
    let candidate = null;
    try {
      candidate = createHash('sha256').update(credential, 'utf8').digest();
    } catch {
      throw fail(401, 'api_unauthorized');
    }
    for (const entry of data.tokens) {
      let stored = null;
      try {
        stored = Buffer.from(entry.digest, 'hex');
      } catch {
        continue;
      }
      if (stored.length !== candidate.length) continue;
      if (!timingSafeEqual(stored, candidate)) continue;
      if (entry.expiresAt && nowMs() >= Date.parse(entry.expiresAt)) throw fail(401, 'api_unauthorized');
      return {
        id: entry.id,
        name: entry.name,
        scopes: [...entry.scopes],
        projectIds: [...entry.projectIds],
        expiresAt: entry.expiresAt,
      };
    }
    throw fail(401, 'api_unauthorized');
  }

  function track(principal, res) {
    const id = principal?.id;
    if (closedAccess) return () => {};
    if (!id || !res || typeof res.on !== 'function') return () => {};
    if (res.destroyed || res.writableEnded) return () => {};
    if (!tracked.has(id)) tracked.set(id, new Set());
    tracked.get(id).add(res);
    let timer = null;
    const cleanup = () => {
      untrack(res, id);
      if (timer) {
        clearTimeout(timer);
        timers.delete(timer);
        timer = null;
      }
    };
    res.once('finish', cleanup);
    res.once('close', cleanup);
    if (principal?.expiresAt) {
      const expiresMs = Date.parse(principal.expiresAt);
      if (!Number.isFinite(expiresMs)) {
        destroyRes(res);
        return cleanup;
      }
      const arm = () => {
        if (res.destroyed || res.writableEnded) return;
        const remaining = expiresMs - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0) {
          destroyRes(res);
          return;
        }
        timer = setTimeout(
          () => {
            timers.delete(timer);
            timer = null;
            if (Date.now() >= expiresMs) destroyRes(res);
            else arm();
          },
          Math.min(remaining, 2 ** 31 - 1),
        );
        if (timer.unref) timer.unref();
        timers.add(timer);
      };
      arm();
    }
    return cleanup;
  }

  function close() {
    closedAccess = true;
    closeAllResponses();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  return { file, get, configure, createToken, revoke, authenticate, track, close };
}
