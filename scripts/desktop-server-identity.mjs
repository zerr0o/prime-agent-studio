import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

const execFileAsync = promisify(execFile);

function norm(path) {
  try {
    const r = resolve(String(path));
    return process.platform === 'win32' ? r.toLowerCase() : r;
  } catch {
    return String(path || '');
  }
}

function isNodeExe(exe) {
  const base = basename(String(exe || '')).toLowerCase();
  return process.platform === 'win32' ? base === 'node.exe' : base === 'node' || base === 'node.exe';
}

function insideDir(path, dir) {
  const p = norm(path);
  const d = norm(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

async function realProcessInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true, timeout: 8000 },
      );
      const text = String(stdout || '')
        .trim()
        .replace(/^﻿/, '');
      if (!text || text === 'null') return null;
      const info = JSON.parse(text);
      if (!info || !info.ExecutablePath) return null;
      return {
        exe: info.ExecutablePath,
        args: String(info.CommandLine || ''),
        createdAt: info.CreationDate ? String(info.CreationDate) : undefined,
      };
    }
    try {
      const mod = await import('node:fs/promises');
      const exe = await mod.readlink(`/proc/${pid}/exe`).catch(() => null);
      const raw = await mod.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => null);
      let createdAt;
      try {
        const st = await mod.stat(`/proc/${pid}`).catch(() => null);
        if (st && st.birthtimeMs) createdAt = new Date(st.birthtimeMs).toISOString();
      } catch {}
      if (exe || raw) return { exe: exe || '', args: raw ? raw.replace(/\0/g, ' ').trim() : '', createdAt };
    } catch {}
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm=,args='], { timeout: 8000 });
    const line = String(stdout || '').trim();
    if (!line) return null;
    const parts = line.split(/\s+/);
    return { exe: parts[0] || '', args: line, createdAt: undefined };
  } catch {
    return null;
  }
}

// Real TCP listen owner. Returns { unknown: true } when the OS query is
// unavailable, { pids: [...] } otherwise. Never throws.
async function realPortOwners(port) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess) | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true, timeout: 8000 },
      );
      const text = String(stdout || '')
        .trim()
        .replace(/^﻿/, '');
      if (!text || text === 'null') return { unknown: true };
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const pids = list.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
      if (!pids.length) return { unknown: true };
      return { pids };
    }
    return { unknown: true };
  } catch {
    return { unknown: true };
  }
}

async function readJsonSafe(path, deps) {
  try {
    const reader = deps && deps.readFile ? deps.readFile : readFile;
    return JSON.parse(await reader(path, 'utf8'));
  } catch {
    return null;
  }
}

// Verify that an OS process is a legitimate Studio generation server.
// Rules (all required):
//  1. exe basename is node / node.exe.
//  2. exe lives inside <dataRoot>/versions/<hash>/ or inside <resourceDir>.
//  3. command line references studio/server.mjs inside the same generation dir
//     (or inside <resourceDir>/studio/server.mjs).
//  4. generation ready metadata exists: <gen>/ready.json, or the resource
//     manifest desktop-resource.json with a 64 hex identity.
// Never throws for foreign processes: returns { verified: false, reason }.
export async function verifyServerProcess({ pid, dataRoot, resourceDir }, deps = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { verified: false, reason: 'bad-pid' };
  const getInfo = deps.processInfo || realProcessInfo;
  let info = null;
  try {
    info = await getInfo(pid);
  } catch {
    info = null;
  }
  if (!info || !info.exe) return { verified: false, reason: 'process-not-found', pid };
  if (!info.createdAt) return { verified: false, reason: 'process-start-unknown', pid };
  const exe = String(info.exe);
  const args = String(info.args || '');
  if (!isNodeExe(exe)) return { verified: false, reason: 'foreign-exe', exe, pid };
  const dataVersions = dataRoot ? join(resolve(String(dataRoot)), 'versions') : null;
  const resDir = resourceDir ? resolve(String(resourceDir)) : null;
  let generationDir = null;
  let identity = null;
  if (dataVersions && insideDir(exe, dataVersions)) {
    generationDir = dirname(resolve(exe));
    identity = basename(generationDir);
  } else if (resDir && insideDir(exe, resDir)) {
    generationDir = resDir;
  } else {
    return { verified: false, reason: 'foreign-path', exe, pid };
  }
  // Launcher uses exactly: <node> <absolute studio/server.mjs>. Do not accept
  // a substring in another argument or in node's own executable path.
  const argv = [...args.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  const expectedScript = join(generationDir, 'studio', 'server.mjs');
  if (argv.length !== 2 || norm(argv[0]) !== norm(exe) || norm(argv[1]) !== norm(expectedScript)) {
    return { verified: false, reason: 'foreign-args', exe, pid };
  }
  if (dataVersions && generationDir && insideDir(exe, dataVersions)) {
    const ready = await readJsonSafe(join(generationDir, 'ready.json'), deps);
    if (!/^[a-f0-9]{64}$/i.test(identity || '') || ready?.identity !== identity) {
      return { verified: false, reason: 'generation-not-ready', exe, pid, generationDir };
    }
    return { verified: true, exe, args, generationDir, identity, pid, createdAt: info.createdAt };
  }
  const manifest = await readJsonSafe(join(generationDir, 'desktop-resource.json'), deps);
  if (!manifest || !/^[a-f0-9]{64}$/.test(String(manifest.identity || ''))) {
    return { verified: false, reason: 'generation-not-ready', exe, pid, generationDir };
  }
  return {
    verified: true,
    exe,
    args,
    generationDir,
    identity: String(manifest.identity),
    pid,
    createdAt: info.createdAt,
  };
}

// The OS must confirm that this PID is the only listener for the Studio port.
export async function verifyPortOwner({ port, pid }, deps = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { ok: false, reason: 'bad-pid' };
  try {
    const answer = deps.portOwner ? await deps.portOwner(port) : await realPortOwners(port);
    if (answer == null || answer === 'unknown' || answer.unknown)
      return { ok: false, reason: 'port-owner-unknown' };
    const raw = answer.pids || (Array.isArray(answer) ? answer : [answer]);
    const pids = raw.map(Number);
    return pids.length && pids.every((value) => value === pid)
      ? { ok: true }
      : { ok: false, reason: 'port-owner-mismatch' };
  } catch {
    return { ok: false, reason: 'port-owner-unknown' };
  }
}

function ownerShapeInvalid(owner) {
  if (!owner || typeof owner !== 'object') return false;
  const pidOk = Number.isSafeInteger(owner.pid) && owner.pid > 0;
  const portOk = Number.isSafeInteger(owner.port) && owner.port >= 1 && owner.port <= 65535;
  const idOk = typeof owner.instanceId === 'string' && owner.instanceId.length > 0;
  return !(pidOk && portOk && idOk);
}

// Resolve ownership without writing any file (status is readonly).
// owner: parsed data/server.json or null. health: probeHealth ready health.
// Invalid marker shape never falls back blindly to the health PID.
export async function resolveOwnership({ health, owner, port, dataRoot, resourceDir }, deps = {}) {
  if (!health) return { ownership: 'absent', source: 'none', managed: false };
  const validOwner =
    owner &&
    owner.pid === health.pid &&
    owner.port === port &&
    typeof owner.instanceId === 'string' &&
    owner.instanceId &&
    owner.instanceId === health.instanceId;
  if (validOwner) {
    const checked = await verifyManagedTarget({ health, owner, port, dataRoot, resourceDir }, deps);
    return checked.ok
      ? { ownership: 'managed', source: 'owner-file', managed: true }
      : { ownership: 'unverified', source: 'owner-file', managed: false, reason: checked.reason };
  }
  // A marker for a different instance is not a missing marker. Do not adopt it.
  if (owner && !ownerShapeInvalid(owner)) {
    return { ownership: 'unverified', source: 'mismatch', managed: false, reason: 'marker-mismatch' };
  }
  if (owner && ownerShapeInvalid(owner)) {
    return { ownership: 'unverified', source: 'invalid', managed: false, reason: 'invalid-marker' };
  }
  const source = owner ? 'mismatch' : 'none';
  try {
    const checked = await verifyServerProcess({ pid: health.pid, dataRoot, resourceDir }, deps);
    if (!checked.verified) {
      return { ownership: 'unverified', source, managed: false, reason: checked.reason };
    }
    const portCheck = await verifyPortOwner({ port, pid: health.pid }, deps);
    if (!portCheck.ok) {
      return {
        ownership: 'unverified',
        source,
        managed: false,
        reason: portCheck.reason || 'port-owner-mismatch',
      };
    }
    return {
      ownership: 'recoverable',
      source: 'os-verified',
      managed: false,
      generationDir: checked.generationDir,
      identity: checked.identity,
      exe: checked.exe,
      portUnknown: Boolean(portCheck.unknown),
    };
  } catch {
    return { ownership: 'unverified', source, managed: false, reason: 'verify-failed' };
  }
}

// A marker is only a claim. OS executable, exact script, receipt and TCP
// ownership must confirm it before status offers control or a stop proceeds.
export async function verifyManagedTarget({ health, owner, port, dataRoot, resourceDir }, deps = {}) {
  if (!health || !owner) return { ok: false, reason: 'not-managed' };
  if (
    owner.pid !== health.pid ||
    owner.port !== port ||
    !owner.instanceId ||
    owner.instanceId !== health.instanceId
  ) {
    return { ok: false, reason: 'not-managed' };
  }
  if (ownerShapeInvalid(owner)) return { ok: false, reason: 'invalid-marker' };
  let checked = null;
  try {
    checked = await verifyServerProcess({ pid: health.pid, dataRoot, resourceDir }, deps);
  } catch {
    return { ok: false, reason: 'verify-failed' };
  }
  if (!checked.verified) {
    // Fail closed on definite mismatch. A missing process entry alone
    // (stale PID) also blocks: never kill on an unverified target.
    return { ok: false, reason: checked.reason || 'os-mismatch' };
  }
  const portCheck = await verifyPortOwner({ port, pid: health.pid }, deps);
  if (!portCheck.ok) return { ok: false, reason: portCheck.reason || 'port-owner-mismatch' };
  return {
    ok: true,
    createdAt: checked.createdAt,
    generationDir: checked.generationDir,
    identity: checked.identity,
  };
}
