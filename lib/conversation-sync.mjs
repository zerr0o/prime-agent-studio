// Conversation sync over a passive object store (Cloudflare R2).
// Repository layout (all encrypted except repo.json):
//   repo.json               { version, salt, check }   passphrase verification
//   objects/<keyed hash>    packs of NEW session entries, or image blobs
//   refs/<deviceId>.json    one per machine: sessions -> packs + active leaf
// Each machine writes only its own ref and immutable objects: no locks needed.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { gitDirs } from './git-head.mjs';
import { mergeEntries, parse, serialize } from './sync-merge.mjs';
import { r2Store } from './sync-store.mjs';
import { getStudioMachineId } from './studio-identity.mjs';
import { HttpError, cwdKey } from './store.mjs';
import { formatMessage as tr } from '../public/i18n-core.js';
import { normalizeDeviceColor } from '../public/palettes.js';
import { mergeRoadmaps, roadmapContentHash, ensureBacklogIds } from './roadmap-merge.mjs';
import { createRoadmapService, validateRoadmapDocument } from './roadmap.mjs';

const BLOB = '\u0000studio-blob:';
const CHECK = 'prime-agent-studio-sync-v1';
const derive = (master, label) => createHmac('sha256', master).update(label).digest();
const keysFrom = (master) => ({ enc: derive(master, 'enc'), mac: derive(master, 'mac') });
const objectId = (keys, data) => createHmac('sha256', keys.mac).update(data).digest('hex');
function seal(keys, data) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', keys.enc, iv);
  const body = Buffer.concat([cipher.update(gzipSync(data)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
function unseal(keys, data) {
  const decipher = createDecipheriv('aes-256-gcm', keys.enc, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return gunzipSync(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]));
}
async function atomicWrite(file, data, mode) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + '.sync-tmp', data, mode ? { mode } : undefined);
  await rename(file + '.sync-tmp', file);
}
async function readHeader(path) {
  const handle = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(65536), 0, 65536, 0);
    const line = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    return JSON.parse(line);
  } finally {
    await handle.close();
  }
}
const metaVersion = (meta) => Math.max(meta?.metaAt || 0, meta?.readAt || 0);
const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

// Native image blocks become binary blobs stored once; key order is kept.
function extractImages(value, addBlob) {
  if (Array.isArray(value)) return value.map((v) => extractImages(v, addBlob));
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [k, v] of Object.entries(value))
    copy[k] =
      k === 'data' && value.type === 'image' && typeof v === 'string' && v.length > 1024
        ? BLOB + addBlob(Buffer.from(v, 'base64'))
        : extractImages(v, addBlob);
  return copy;
}
async function restoreImages(value, getBlob) {
  if (Array.isArray(value)) return Promise.all(value.map((v) => restoreImages(v, getBlob)));
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [k, v] of Object.entries(value))
    copy[k] =
      typeof v === 'string' && v.startsWith(BLOB)
        ? (await getBlob(v.slice(BLOB.length))).toString('base64')
        : await restoreImages(v, getBlob);
  return copy;
}
async function sessionFiles(dir, depth = 0) {
  const out = [];
  for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, item.name);
    if (item.isDirectory() && depth < 2) out.push(...(await sessionFiles(path, depth + 1)));
    else if (item.isFile() && item.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}
// Same project on two PCs: same normalized Git remote (host/owner/repo).
// Credentials in remote URLs are dropped.
export function normalizeGitRemote(url) {
  let value = String(url || '').trim();
  if (!value) return null;
  value = value.replace(/\.git\/?$/i, '').replace(/\/+$/, '');
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(value);
  let host, path;
  if (scp && !/^[a-z]+:\/\//i.test(value)) [, host, path] = scp;
  else {
    try {
      const parsed = new URL(value);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return null;
    }
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '');
  return host && path ? `${host}/${path}`.toLowerCase() : null;
}
export async function gitRemote(cwd) {
  try {
    const dirs = await gitDirs(cwd);
    if (!dirs) return null;
    const config = await readFile(join(dirs.common, 'config'), 'utf8');
    const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] || '';
    return normalizeGitRemote(/^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]);
  } catch {
    return null;
  }
}
function parseUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    throw new HttpError(400, tr('sync.err_url'));
  }
  const bucket = parsed.pathname.split('/').filter(Boolean)[0];
  if (parsed.protocol !== 'https:' || !bucket) throw new HttpError(400, tr('sync.err_url'));
  return { endpoint: parsed.origin, bucket, url: `${parsed.origin}/${bucket}` };
}

export function createConversationSync({
  dataDir,
  sessionDir,
  store,
  isSessionActive = () => false,
  objectStore,
  roadmap: roadmapOverride,
}) {
  const options = { roadmap: roadmapOverride };
  const configPath = join(dataDir, 'sync.json'),
    statePath = join(dataDir, 'sync-state.json'),
    devicePath = join(dataDir, 'sync-device.json');
  let running = null,
    lastSync = null,
    progress = null;

  const remote = (config) =>
    objectStore ||
    r2Store({
      ...parseUrl(config.url),
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
  async function status() {
    const config = await readJson(configPath);
    const raw = (await readJson(statePath)) || {};
    lastSync ??= raw.lastSync ?? null;
    const local = config?.key
      ? ((await store.overview()).projects || []).filter((p) => p.sync !== false && p.syncId)
      : [];
    const localById = new Map(local.map((p) => [p.syncId, p.cwd]));
    const selfDevice = {
      id: config?.deviceId ?? null,
      name: config?.device || hostname(),
      color: config?.color || '',
      self: true,
    };
    const knownDevices = Array.isArray(raw.devices) ? raw.devices : [];
    return {
      configured: Boolean(config?.key),
      url: config?.url ?? null,
      accessKeyId: config?.accessKeyId ?? null,
      hasSecret: Boolean(config?.secretAccessKey),
      hasPassphrase: Boolean(config?.key),
      device: config?.device || hostname(),
      color: config?.color || '',
      devices: config?.key ? [selfDevice, ...knownDevices.filter((d) => d.id !== selfDevice.id)] : [],
      sessionDevices: config?.key ? raw.sessionDevices || {} : {},
      running: Boolean(running),
      progress: running ? progress : null,
      lastSync,
      ...(await sessionStates()),
      remoteProjects: config?.key
        ? (raw.remoteProjects || []).map((r) => ({ ...r, local: localById.get(r.id) ?? null }))
        : [],
      projectLinks: Object.fromEntries(
        local.map((p) => [
          p.cwd,
          { id: p.syncId, via: p.syncManual ? 'manual' : raw.via?.[p.syncId] || 'id' },
        ]),
      ),
    };
  }

  async function configure(body = {}) {
    if (running) throw new HttpError(409, tr('sync.err_busy'));
    const previous = (await readJson(configPath)) || {};
    // Color only (the panel's swatches): keep the configuration, no reconnection.
    if (previous.key && Object.keys(body).length === 1 && body.color !== undefined) {
      const color = normalizeDeviceColor(body.color);
      if (color === null) throw new HttpError(400, tr('server.valeur_invalide'));
      await atomicWrite(configPath, JSON.stringify({ ...previous, color: color || '' }), 0o600);
      return status();
    }
    const { url } = parseUrl(body.url);
    const accessKeyId = String(body.accessKeyId || '').trim();
    const secretAccessKey =
      String(body.secretAccessKey || '') || (url === previous.url ? previous.secretAccessKey : '');
    const passphrase = String(body.passphrase || '');
    const device =
      String(body.device || previous.device || '')
        .trim()
        .slice(0, 60) ||
      previous.device ||
      hostname();
    let color = previous.color || '';
    if (body.color !== undefined) {
      const normalized = normalizeDeviceColor(body.color);
      if (normalized === null) throw new HttpError(400, tr('server.valeur_invalide'));
      color = normalized || '';
    }
    if (!accessKeyId || !secretAccessKey) throw new HttpError(400, tr('sync.err_keys'));
    if (passphrase && passphrase.length < 12) throw new HttpError(400, tr('sync.err_passphrase_short'));
    const config = {
      url,
      accessKeyId,
      secretAccessKey,
      device,
      color,
      // Stable per machine, kept when the configuration is forgotten: a new id
      // would re-upload everything and pull this PC's old ref as a stranger.
      deviceId: await getStudioMachineId(dataDir),
      key: url === previous.url ? previous.key : undefined,
    };
    const target = remote(config);
    let repo;
    try {
      repo = await target.get('repo.json');
    } catch (error) {
      throw new HttpError(400, tr('sync.err_connect', { value1: error.message }));
    }
    repo = repo ? JSON.parse(repo.toString('utf8')) : null;
    if (passphrase) {
      if (!repo) {
        repo = { version: 1, salt: randomBytes(16).toString('base64') };
        const master = scryptSync(passphrase, Buffer.from(repo.salt, 'base64'), 32, {
          N: 1 << 15,
          maxmem: 64 << 20,
        });
        repo.check = createHmac('sha256', keysFrom(master).mac).update(CHECK).digest('hex');
        await target.put('repo.json', Buffer.from(JSON.stringify(repo)));
      }
      const master = scryptSync(passphrase, Buffer.from(repo.salt, 'base64'), 32, {
        N: 1 << 15,
        maxmem: 64 << 20,
      });
      if (createHmac('sha256', keysFrom(master).mac).update(CHECK).digest('hex') !== repo.check)
        throw new HttpError(400, tr('sync.err_passphrase_wrong'));
      config.key = master.toString('base64');
    } else if (!config.key) {
      throw new HttpError(400, tr('sync.err_passphrase_required'));
    }
    const kept = await readJson(statePath);
    if (kept && kept.url !== undefined && kept.url !== url) await rm(statePath, { force: true });
    await atomicWrite(devicePath, JSON.stringify({ id: config.deviceId }));
    await atomicWrite(configPath, JSON.stringify(config), 0o600);
    return status();
  }

  async function forget() {
    if (running) throw new HttpError(409, tr('sync.err_busy'));
    // Credentials only. Sync state stays so reconnecting the same bucket sends
    // only new entries; a different bucket resets it in configure().
    await rm(configPath, { force: true });
    lastSync = null;
    return status();
  }

  async function syncOnce(only = null) {
    const config = await readJson(configPath);
    if (!config?.key) throw new HttpError(400, tr('sync.err_not_configured'));
    const keys = keysFrom(Buffer.from(config.key, 'base64'));
    const target = remote(config);
    const raw = (await readJson(statePath)) || {};
    const state = {
      files: raw.files || {},
      leaf: raw.leaf || {},
      ids: raw.ids || {},
      mtime: raw.mtime || {},
      meta: raw.meta || {},
      via: raw.via || {},
      remoteProjects: raw.remoteProjects || [],
      roadmaps: raw.roadmaps || {},
      devices: raw.devices || [],
      sessionDevices: raw.sessionDevices || {},
      fetched: new Set(raw.fetched || []),
      blobs: new Set(raw.blobs || []),
      known: Object.fromEntries(Object.entries(raw.known || {}).map(([k, v]) => [k, new Set(v)])),
    };
    const save = (extra = {}) =>
      atomicWrite(
        statePath,
        JSON.stringify({
          lastSync: raw.lastSync,
          ...extra,
          url: config.url,
          files: state.files,
          leaf: state.leaf,
          ids: state.ids,
          mtime: state.mtime,
          meta: state.meta,
          via: state.via,
          remoteProjects: state.remoteProjects,
          roadmaps: state.roadmaps,
          devices: state.devices,
          sessionDevices: state.sessionDevices,
          fetched: [...state.fetched],
          blobs: [...state.blobs],
          known: Object.fromEntries(Object.entries(state.known).map(([k, v]) => [k, [...v]])),
        }),
      );
    const projects = ((await store.overview()).projects || []).filter(
      (p) => p.sync !== false && p.exists !== false,
    );
    const report = {
      sent: 0,
      pushed: 0,
      received: 0,
      skipped: 0,
      errors: 0,
      roadmapsSent: 0,
      roadmapsReceived: 0,
      roadmapConflicts: [],
    };
    const put = async (key, data) => {
      await target.put(key, data);
      report.sent += data.length;
    };
    const fileInfo = async (path) => {
      const info = await stat(path);
      return {
        stamp: `${info.size}:${info.mtimeMs}`,
        mtime: info.mtime.getTime() /* same rounding as the overview updatedAt */,
      };
    };
    const relOf = (path) => relative(sessionDir, path).replaceAll('\\', '/');
    const sidOf = Object.fromEntries(Object.entries(state.ids).map(([sid, rel]) => [rel, sid]));
    const metaOf = (sid) => store.sessionMeta?.(sid) ?? { metaAt: 0 };
    // Metadata format 2 adds read receipts: resend metadata once after upgrading.
    const metaCurrent = raw.metaFormat === 2;

    const refKey = `refs/${config.deviceId}.json`;
    const others = [];
    let existing = null;
    for (const key of await target.list('refs/')) {
      const data = await target.get(key);
      if (key === refKey) existing = data;
      else if (data) {
        try {
          const parsed = JSON.parse(unseal(keys, data));
          parsed.deviceId = key.startsWith('refs/') ? key.slice(5, -5) : key;
          others.push(parsed);
        } catch {
          report.errors++;
        }
      }
    }

    // Stable project identity across PCs: explicit or remembered id, else the
    // same Git remote, else the same name. The first PC to sync creates the id.
    const remoteById = new Map();
    for (const other of others) {
      for (const [id, p] of Object.entries(other.projects || {})) {
        const entry = remoteById.get(id) ?? {
          id,
          name: p.name,
          git: p.git ?? null,
          devices: new Set(),
          sessions: 0,
        };
        entry.devices.add(other.device || '?');
        remoteById.set(id, entry);
      }
      for (const info of Object.values(other.sessions || {}))
        if (remoteById.has(info.projectId)) remoteById.get(info.projectId).sessions++;
    }
    const remotes = [...remoteById.values()];
    const used = new Set(projects.map((p) => p.syncId).filter(Boolean));
    const only1 = (list) => (list.length === 1 ? list[0] : null);
    const renamed = new Map();
    for (const p of projects) {
      const git = await gitRemote(p.cwd);
      const free = (r) => !used.has(r.id) || r.id === p.syncId;
      const sameGit = git ? only1(remotes.filter((r) => r.git === git && free(r))) : null;
      let id = p.syncId,
        via = p.syncManual ? 'manual' : state.via[id] || 'id';
      if (!id) {
        const sameName = only1(remotes.filter((r) => r.name === p.name && free(r)));
        [id, via] = sameGit ? [sameGit.id, 'git'] : sameName ? [sameName.id, 'name'] : [randomUUID(), 'new'];
      } else if (sameGit && sameGit.id !== id && !p.syncManual && !remoteById.has(id) && sameGit.id < id) {
        // Two PCs created ids before seeing each other: converge on one.
        renamed.set(id, sameGit.id);
        [id, via] = [sameGit.id, 'git'];
      }
      if (id !== p.syncId) {
        await store.setProjectSyncId(p.cwd, id);
        p.syncId = id;
      }
      used.add(id);
      state.via[id] = via;
      p.syncGit = git;
    }
    state.remoteProjects = remotes.map((r) => ({ ...r, devices: [...r.devices] }));
    const byCwd = new Map(projects.map((p) => [cwdKey(p.cwd), p]));
    const byName = new Map(projects.map((p) => [p.name, p]));
    const byId = new Map(projects.map((p) => [p.syncId, p]));

    // Project colors: newest colorAt wins across PCs, applied through the store.
    if (!only) {
      for (const other of others) {
        for (const [id, entry] of Object.entries(other.projects || {})) {
          const local = projects.find((p) => p.syncId === id);
          if (!local || !entry || typeof entry !== 'object') continue;
          const remoteAt = Number(entry.colorAt) || 0;
          if (remoteAt > (Number(local.colorAt) || 0)) {
            try {
              if (typeof store.applyProjectColor === 'function') {
                const changed = await store.applyProjectColor(local.cwd, entry.color || '', remoteAt);
                if (changed) {
                  if (entry.color) local.color = entry.color;
                  else delete local.color;
                  local.colorAt = remoteAt;
                }
              }
            } catch {
              report.errors++;
            }
          }
        }
      }
    }
    // Roadmap sync helpers (per synced project, three-way merge against base).
    const roadmapService =
      options.roadmap ||
      createRoadmapService({
        resolveProject: async (cwd) => {
          try {
            if (typeof store.knowledgeProject === 'function') return await store.knowledgeProject(cwd);
          } catch {}
          try {
            if (typeof store.findProject === 'function') return await store.findProject(cwd);
          } catch {}
          return { cwd, name: String(cwd).split(/[\\/]/).pop() || 'Project' };
        },
      });
    const roadmapLocked = async (cwd) => {
      try {
        await stat(join(cwd, '.prime', 'studio', '.roadmap.lock'));
        return true;
      } catch {
        return false;
      }
    };
    for (const [from, to] of renamed) {
      if (state.roadmaps[from] && !state.roadmaps[to]) state.roadmaps[to] = state.roadmaps[from];
      delete state.roadmaps[from];
    }

    // Push: new entries and metadata of synced, idle sessions.
    const ref = existing ? JSON.parse(unseal(keys, existing)) : { sessions: {} };
    const before = JSON.stringify(ref);
    ref.device = config.device;
    ref.color = config.color || '';
    ref.projects = Object.fromEntries(
      projects.map((p) => [
        p.syncId,
        { name: p.name, git: p.syncGit, color: p.color || '', colorAt: Number(p.colorAt) || 0 },
      ]),
    );
    try {
      const prevProjects = existing ? JSON.parse(unseal(keys, existing)).projects || {} : {};
      for (const [id, entry] of Object.entries(ref.projects)) {
        if (typeof prevProjects[id]?.roadmap === 'string') entry.roadmap = prevProjects[id].roadmap;
      }
    } catch {}
    for (const info of Object.values(ref.sessions)) {
      if (renamed.has(info.projectId)) info.projectId = renamed.get(info.projectId);
      if (!info.projectId && byName.has(info.project)) info.projectId = byName.get(info.project).syncId;
    }
    let files;
    const pushedThisRun = new Set();
    if (only) {
      const known = state.ids[only] && join(sessionDir, ...state.ids[only].split('/'));
      const file = known || (await store.history?.(only)?.catch(() => null))?.file;
      files = file ? [file] : [];
    } else files = await sessionFiles(sessionDir);
    if (!only) progress = { phase: 'push', done: 0, total: files.length };
    for (const path of files) {
      if (!only) progress.done++;
      const rel = relOf(path);
      try {
        const { stamp, mtime } = await fileInfo(path);
        let knownSid = sidOf[rel];
        if (state.files[rel] === stamp && !knownSid) {
          // Unchanged file pushed by an older build: record its identity once so
          // its status reads as synced instead of pending.
          const header = await readHeader(path).catch(() => null);
          if (header?.type === 'session' && state.known[header.id]) {
            knownSid = header.id;
            state.ids[knownSid] = rel;
            state.mtime[knownSid] = mtime;
            state.meta[knownSid] ??= 0;
          }
        }
        if (
          state.files[rel] === stamp &&
          (!knownSid || (metaCurrent && metaVersion(metaOf(knownSid)) <= (state.meta[knownSid] || 0)))
        )
          continue;
        const first = await readHeader(path);
        const project = first?.type === 'session' && byCwd.get(cwdKey(first.cwd || ''));
        if (!project) continue;
        if (isSessionActive(first.id)) {
          report.skipped++;
          continue;
        }
        const [header, ...entries] = parse(await readFile(path, 'utf8'));
        const known = (state.known[header.id] ??= new Set());
        const fresh = entries.filter((e) => !known.has(e.id));
        const info = (ref.sessions[header.id] ??= { file: rel, packs: [] });
        info.project = project.name;
        info.projectId = project.syncId;
        info.header = { ...header, cwd: undefined };
        info.meta = metaOf(header.id);
        if (fresh.length) {
          const blobs = [];
          const packed = fresh.map((e) =>
            extractImages(e, (bin) => {
              const id = objectId(keys, bin);
              if (!state.blobs.has(id)) blobs.push([id, bin]);
              state.blobs.add(id);
              return id;
            }),
          );
          for (const [id, bin] of blobs) await put(`objects/${id}`, seal(keys, bin));
          const pack = Buffer.from(serialize(packed));
          const packId = objectId(keys, pack);
          await put(`objects/${packId}`, seal(keys, pack));
          info.packs.push(packId);
          for (const e of fresh) known.add(e.id);
          report.pushed += fresh.length;
          if (fresh.length) pushedThisRun.add(header.id);
        }
        // leafAt marks when THIS PC first published the leaf. A PC that only
        // re-publishes a received leaf (read state, pin) gets a later time.
        const leaf = entries.at(-1)?.id;
        if (info.leaf !== leaf) {
          info.leaf = leaf;
          info.leafAt = Date.now();
        }
        state.leaf[header.id] = info.leaf;
        state.files[rel] = stamp;
        state.ids[header.id] = rel;
        state.mtime[header.id] = mtime;
        state.meta[header.id] = metaVersion(info.meta);
      } catch {
        report.errors++;
      }
    }
    // Roadmaps: encrypted per-project objects, pushed only when the content
    // changed, merged three-way against the last synced base. Skipped for
    // single-session checks and while a roadmap write lock is held.
    const pushedSessionIds = pushedThisRun;
    if (!only) {
      if (!progress) progress = { phase: 'roadmap', done: 0, total: projects.length };
      else progress = { phase: 'roadmap', done: 0, total: projects.length };
      for (const project of projects) {
        progress.done++;
        const syncId = project.syncId;
        if (!syncId) continue;
        try {
          if (await roadmapLocked(project.cwd)) {
            report.skipped++;
            continue;
          }
          let localDoc = null;
          try {
            const raw = await roadmapService.readRaw(project.cwd);
            localDoc = raw.revision > 0 ? raw : null;
          } catch (error) {
            // Uninitialized roadmap (no file yet) is not an error: it merges
            // as empty and receives the remote document. Corrupt files keep
            // local state untouched and are reported.
            const fileMissing = await stat(join(project.cwd, '.prime', 'studio', 'roadmap.json'))
              .then(() => false)
              .catch(() => true);
            if (fileMissing) localDoc = null;
            else {
              report.errors++;
              continue;
            }
            void error;
          }
          let idsAdded = false;
          if (localDoc) {
            const copy = structuredClone(localDoc);
            if (ensureBacklogIds(copy.backlog)) {
              idsAdded = true;
              localDoc = copy;
            }
          }
          const localHash = localDoc ? roadmapContentHash(localDoc) : null;
          const baseEntry = state.roadmaps[syncId];
          const baseDoc = baseEntry?.base ?? null;
          const baseHash = baseEntry?.hash ?? null;
          const remoteDocs = [];
          for (const other of others) {
            const roadmapId = other.projects?.[syncId]?.roadmap;
            if (!roadmapId || typeof roadmapId !== 'string') continue;
            if (state.fetched.has(roadmapId)) continue;
            try {
              const raw = await target.get(`objects/${roadmapId}`);
              if (!raw) continue;
              const doc = validateRoadmapDocument(JSON.parse(unseal(keys, raw).toString('utf8')));
              state.fetched.add(roadmapId);
              remoteDocs.push(doc);
            } catch {
              report.errors++;
            }
          }
          if (!localDoc && !remoteDocs.length) continue;
          if (localHash && localHash === baseHash && !remoteDocs.length && !idsAdded) {
            ref.projects[syncId] ??= { name: project.name, git: project.syncGit };
            continue;
          }
          let merged = localDoc;
          for (const remoteDoc of remoteDocs) {
            try {
              merged = mergeRoadmaps(baseDoc, merged, remoteDoc);
            } catch {
              report.errors++;
              merged = localDoc;
              break;
            }
          }
          if (!merged && remoteDocs.length) merged = remoteDocs[0];
          if (!merged) continue;
          const mergedHash = roadmapContentHash(merged);
          const needsWrite = idsAdded || !localDoc || (localHash && mergedHash !== localHash);
          if (needsWrite && merged) {
            try {
              await roadmapService.replaceRaw(project.cwd, merged);
              localDoc = merged;
              report.roadmapsReceived += remoteDocs.length ? 1 : 0;
            } catch {
              report.errors++;
              try {
                const dir = join(dataDir, 'sync-conflicts');
                await mkdir(dir, { recursive: true });
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                const file = join(dir, `roadmap-${syncId}-${stamp}.json`);
                await writeFile(file, JSON.stringify(remoteDocs[0] ?? merged, null, 2));
                report.roadmapConflicts.push({ project: syncId, file });
              } catch {}
              continue;
            }
          }
          const finalHash = localDoc ? roadmapContentHash(localDoc) : mergedHash;
          const finalDoc = localDoc ?? merged;
          const previousRoadmap = (() => {
            try {
              return existing ? JSON.parse(unseal(keys, existing)).projects?.[syncId]?.roadmap : null;
            } catch {
              return null;
            }
          })();
          const bytes = Buffer.from(JSON.stringify(finalDoc));
          const rid = objectId(keys, bytes);
          if (finalHash !== baseHash || rid !== previousRoadmap) {
            if (rid !== previousRoadmap || !state.fetched.has(rid)) {
              await put(`objects/${rid}`, seal(keys, bytes));
              state.fetched.add(rid);
            }
            report.roadmapsSent++;
          }
          ref.projects[syncId] ??= { name: project.name, git: project.syncGit };
          ref.projects[syncId].roadmap = rid;
          state.roadmaps[syncId] = { hash: finalHash, base: finalDoc };
        } catch {
          report.errors++;
        }
      }
    }
    if (JSON.stringify(ref) !== before) await put(refKey, seal(keys, Buffer.from(JSON.stringify(ref))));

    // Pull: merge other machines' entries and newer metadata into synced projects.
    const getBlob = async (id) => unseal(keys, await target.get(`objects/${id}`));
    const pairs = others.flatMap((o) =>
      Object.entries(o.sessions || {}).filter(([sid]) => !only || sid === only),
    );
    if (!only) progress = { phase: 'pull', done: 0, total: pairs.length };
    for (const [sid, info] of pairs) {
      if (!only) progress.done++;
      try {
        // Older builds tagged sessions by project name only.
        const project = info.projectId ? byId.get(info.projectId) : byName.get(info.project);
        if (!project) continue;
        const packs = info.packs.filter((p) => !state.fetched.has(p));
        if (packs.length || state.leaf[sid] !== info.leaf) {
          if (isSessionActive(sid)) {
            report.skipped++;
            continue;
          }
          const path = join(sessionDir, ...info.file.split('/'));
          let local,
            stamp = null;
          try {
            stamp = (await fileInfo(path)).stamp;
            local = parse(await readFile(path, 'utf8'));
          } catch {
            local = [{ ...info.header, cwd: project.cwd }];
          }
          const incoming = [];
          for (const pack of packs)
            for (const e of parse(unseal(keys, await target.get(`objects/${pack}`)).toString('utf8')))
              incoming.push(await restoreImages(e, getBlob));
          const merged = mergeEntries(local, incoming, info.leaf);
          const changed = merged.added || !stamp || merged.entries.at(-1)?.id !== local.at(-1)?.id;
          if (changed) {
            // Never overwrite a file that changed while we were merging.
            if (stamp && (await fileInfo(path)).stamp !== stamp) {
              report.skipped++;
              continue;
            }
            await atomicWrite(path, serialize(merged.entries));
          }
          for (const pack of packs) state.fetched.add(pack);
          const known = (state.known[sid] ??= new Set());
          for (const e of incoming) known.add(e.id);
          state.leaf[sid] = merged.entries.at(-1)?.id;
          const after = await fileInfo(path);
          state.files[relOf(path)] = after.stamp;
          state.ids[sid] = relOf(path);
          state.mtime[sid] = after.mtime;
          report.received += merged.added;
        }
        // Metadata after the merge: a read receipt can name a message just received.
        if (info.meta && (await store.applySessionMeta?.(sid, info.meta))) {
          state.meta[sid] = metaVersion(metaOf(sid));
          report.received++;
        }
      } catch {
        report.errors++;
      }
    }
    if (!only) {
      // Devices seen in refs plus this PC, and the device that last pushed
      // each conversation leaf (matching ref leaf wins, local pushes are self).
      const selfId = config.deviceId;
      const devices = [];
      for (const other of others) {
        if (!other.deviceId) continue;
        devices.push({
          id: other.deviceId,
          name: other.device || '?',
          color: other.color || '',
          self: false,
        });
      }
      state.devices = devices;
      const previous = (() => {
        try {
          return existing ? JSON.parse(unseal(keys, existing)) : null;
        } catch {
          return null;
        }
      })();
      const sessionDevices = { ...(raw.sessionDevices || {}) };
      for (const [sid, leaf] of Object.entries(state.leaf)) {
        if (!leaf) continue;
        if (pushedSessionIds.has(sid)) {
          sessionDevices[sid] = selfId;
          continue;
        }
        // Several PCs can publish the same leaf (one wrote it, others only
        // re-published it with metadata): the earliest publication wins.
        const own = ref.sessions?.[sid] || previous?.sessions?.[sid];
        const candidates = [
          ...others.map((o) => ({ id: o.deviceId, info: o.sessions?.[sid] })),
          { id: selfId, info: own },
        ].filter((c) => c.id && c.info?.leaf === leaf);
        if (!candidates.length) continue;
        // No leafAt = published by an older build, so before any stamped one.
        const at = (c) => (Number.isFinite(c.info.leafAt) ? c.info.leafAt : 0);
        const first = Math.min(...candidates.map(at));
        const earliest = candidates.filter((c) => at(c) === first);
        // Same time (two older refs): keep the current marker if possible.
        sessionDevices[sid] = (
          earliest.find((c) => c.id === sessionDevices[sid]) ||
          earliest.find((c) => c.id !== selfId) ||
          earliest[0]
        ).id;
      }
      state.sessionDevices = sessionDevices;
    }
    const result = {
      at: new Date().toISOString(),
      ok: report.errors === 0,
      ...report,
      ...(report.errors ? { error: tr('sync.err_partial', { value1: report.errors }) } : {}),
    };
    if (!only) lastSync = result;
    await save(
      only ? { metaFormat: raw.metaFormat } : { lastSync, metaFormat: report.errors ? raw.metaFormat : 2 },
    );
    return result;
  }

  // One sync at a time: a full run, or a quick check of one conversation.
  let lock = Promise.resolve();
  function exclusive(task) {
    const next = lock.then(task, task);
    lock = next.catch(() => {});
    return next;
  }

  // Per-conversation state from the cached overview: no extra file reads.
  async function sessionStates() {
    const config = await readJson(configPath);
    if (!config?.key) return { sessions: {}, pending: 0 };
    const raw = (await readJson(statePath)) || {};
    const sessions = {};
    let pending = 0;
    for (const p of (await store.overview()).projects || []) {
      if (p.sync === false || p.exists === false) continue;
      for (const s of p.sessions || []) {
        const synced =
          raw.mtime?.[s.id] === Date.parse(s.updatedAt) &&
          metaVersion(store.sessionMeta?.(s.id) ?? {}) <= (raw.meta?.[s.id] || 0);
        // A running conversation is sent when its turn ends: not "to send" yet.
        if (!synced && isSessionActive(s.id)) {
          sessions[s.id] = 'running';
          continue;
        }
        sessions[s.id] = synced ? 'synced' : 'pending';
        if (!synced) pending++;
      }
    }
    return { sessions, pending };
  }

  async function checkSession(id) {
    const config = await readJson(configPath);
    if (!config?.key) return { state: 'unconfigured', changed: false };
    if (running) return { state: 'busy', changed: false };
    const owner = ((await store.overview()).projects || []).find((p) =>
      (p.sessions || []).some((s) => s.id === id),
    );
    if (owner && owner.sync === false) return { state: 'off', changed: false };
    if (isSessionActive(id))
      return { state: (await sessionStates()).sessions[id] || 'pending', changed: false };
    const result = await exclusive(() => syncOnce(id));
    return {
      state: (await sessionStates()).sessions[id] || (owner ? 'pending' : 'synced'),
      changed: result.received > 0,
    };
  }

  async function run() {
    running ??= exclusive(() => syncOnce())
      .catch(async (error) => {
        lastSync = {
          at: new Date().toISOString(),
          ok: false,
          error: error.message,
          sent: 0,
          pushed: 0,
          received: 0,
        };
        const raw = (await readJson(statePath)) || {};
        await atomicWrite(statePath, JSON.stringify({ ...raw, lastSync })).catch(() => {});
        throw error;
      })
      .finally(() => {
        running = null;
      });
    await running;
    return status();
  }
  return { status, configure, forget, run, checkSession };
}
