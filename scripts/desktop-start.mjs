import { cp, mkdir, readFile, rename, rm, lstat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startServer } from './start-server.mjs';
import { acquireLock, probeHealth, parsePort, isDirectInvocation } from './launcher-common.mjs';
import { repairDesktop280Resources } from './desktop-runtime-resources.mjs';
import { quickComponentReceipt, selectedEnvironment } from '../lib/desktop-components.mjs';

const resources = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const importedFiles = ['workspace.json', 'subagent-defaults.json', 'lan-access.json', 'attachments'];

export async function importLegacyData(sourceRoot, dataDir) {
  const source = resolve(sourceRoot, '.local');
  if (!existsSync(join(sourceRoot, 'server.mjs')) || !existsSync(join(source, 'workspace.json')))
    throw new Error(
      'Cette installation ne contient pas les données du Studio. / Studio data not found in this installation.',
    );
  const staging = `${dataDir}.import-${randomUUID()}`;
  try {
    await mkdir(staging, { recursive: true });
    for (const name of importedFiles) {
      const path = join(source, name);
      if (!existsSync(path)) continue;
      await cp(path, join(staging, name), {
        recursive: true,
        filter: async (entry) => {
          if ((await lstat(entry)).isSymbolicLink())
            throw new Error(
              'Un lien symbolique empêche la copie des données. / Cannot import symbolic links.',
            );
          return true;
        },
      });
    }
    await writeFile(
      join(staging, 'desktop-import.json'),
      JSON.stringify({ source: sourceRoot, importedAt: new Date().toISOString() }),
    );
    await rename(staging, dataDir);
  } finally {
    if (dirname(staging) === dirname(resolve(dataDir))) await rm(staging, { recursive: true, force: true });
  }
}

export async function startDesktop(
  {
    resourceDir = resources,
    dataRoot,
    port = 3088,
    legacyRoot,
    env = process.env,
    allowUnconfigured = false,
  },
  deps = {},
) {
  port = parsePort(port);
  dataRoot = resolve(dataRoot);
  await repairDesktop280Resources(resourceDir, dataRoot);
  const probe = deps.probe || probeHealth;
  const initial = await probe(port);
  // Reuse even a source-launched Studio: no import, restart, or configuration write while it is active.
  const reused = async (health) => {
    // Read-only metadata, no engine probe or download on warm reuse.
    const manifest = await readFile(join(resourceDir, 'desktop-resource.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    return {
      port,
      reused: true,
      pid: health.pid,
      version: health.version,
      ...(manifest?.version && manifest.version !== health.version ? { showUpdates: true } : {}),
    };
  };
  if (initial.state === 'ready') return reused(initial.health);
  if (initial.state !== 'absent')
    throw new Error(
      'Le port du Studio est occupé par un autre service. / Studio port is occupied by another service.',
    );
  await mkdir(dataRoot, { recursive: true });
  // Cold cheap gate (no exec/download): valid receipt starts immediately.
  // Missing/changed/explicit mismatch throws components_required:* so the
  // launcher runs full diagnose only when setup is actually necessary.
  // Warm reuse above never reaches this gate. Explicit Later/background
  // passes allowUnconfigured to open Studio anyway (agents report setup).
  if (!allowUnconfigured) {
    const receipt = await (deps.quickReceipt || quickComponentReceipt)({ dataRoot, env });
    if (!receipt.ok) throw new Error(`components_required:${receipt.reason || 'missing'}`);
  }
  const release = await acquireLock({ lock: join(dataRoot, 'desktop-setup.lock') });
  try {
    const current = await probe(port);
    if (current.state === 'ready') return reused(current.health);
    if (current.state !== 'absent')
      throw new Error('Le port du Studio est occupé. / Studio port is occupied.');
    const manifest = JSON.parse(await readFile(join(resourceDir, 'desktop-resource.json'), 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(manifest.identity)) throw new Error('Invalid desktop resource manifest');
    const versions = join(dataRoot, 'versions');
    const generation = join(versions, manifest.identity);
    await mkdir(versions, { recursive: true });
    if (!existsSync(join(generation, 'ready.json'))) {
      const staging = join(versions, `${manifest.identity}.tmp-${randomUUID()}`);
      try {
        await mkdir(staging);
        await cp(join(resourceDir, 'studio'), join(staging, 'studio'), { recursive: true });
        await cp(join(resourceDir, 'node.exe'), join(staging, 'node.exe'));
        await writeFile(join(staging, 'ready.json'), JSON.stringify(manifest));
        await rename(staging, generation);
      } finally {
        if (resolve(staging).startsWith(resolve(versions) + sep))
          await rm(staging, { recursive: true, force: true });
      }
    }
    const dataDir = join(dataRoot, 'data');
    if (!existsSync(dataDir) && legacyRoot) await importLegacyData(resolve(legacyRoot), dataDir);
    const childEnv = {
      ...(await selectedEnvironment(dataRoot, env)),
      PRIME_AGENT_GUI_DATA_DIR: dataDir,
      PRIME_AGENT_GUI_KERNEL_ROOT: dataRoot,
      PRIME_AGENT_GUI_INITIAL_CWD: homedir(),
      PATH: `${generation}${process.platform === 'win32' ? ';' : ':'}${env.PATH || ''}`,
    };
    return await (deps.start || startServer)({
      root: join(generation, 'studio'),
      node: join(generation, 'node.exe'),
      port,
      env: childEnv,
    });
  } finally {
    await release();
  }
}

if (isDirectInvocation(import.meta.url)) {
  try {
    const args = JSON.parse(process.argv[2] || '{}');
    if (typeof args.dataRoot !== 'string' || !args.dataRoot)
      throw new Error('Desktop data directory missing');
    const result = await startDesktop(args);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
}
