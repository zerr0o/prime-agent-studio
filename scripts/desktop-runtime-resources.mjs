import { copyFile, link, unlink, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';

// Runtime entrypoints include child-process workers and native Windows helpers, not just the launcher.
export const desktopRuntimeScripts = [
  'start-server.mjs',
  'launcher-common.mjs',
  'desktop-start.mjs',
  'desktop-control.mjs',
  'desktop-server-identity.mjs',
  'desktop-components.mjs',
  'component-probe.mjs',
  'stop-server.mjs',
  'desktop-runtime-resources.mjs',
  'command-catalog-worker.mjs',
  'model-catalog-worker.mjs',
  'kernel-catalog-worker.mjs',
  'native-skill-resources.mjs',
  'studio-knowledge-worker.mjs',
  'provider-auth-worker.mjs',
  'mcp-probe-worker.mjs',
  'mcp-oauth-worker.mjs',
  'mcp-probe.py',
  'open-directory.ps1',
  'open-terminal.ps1',
  'open-file.ps1',
  'pick-directory.ps1',
];
const missingIn280 = desktopRuntimeScripts.filter(
  (name) =>
    ![
      'start-server.mjs',
      'launcher-common.mjs',
      'desktop-start.mjs',
      'desktop-control.mjs',
      'desktop-server-identity.mjs',
      'desktop-components.mjs',
      'component-probe.mjs',
      'stop-server.mjs',
      'desktop-runtime-resources.mjs',
      'studio-knowledge-worker.mjs',
    ].includes(name),
);
export const desktop280Identity = '3aaa070e42d268e555a705e67656c5428fc62478c07d86e1ba363be4e96fc6ef';

// One-time additive repair: 2.8.0 may still own the active server after the desktop app updates.
// Never overwrite a file or touch another generation, running process, or user configuration.
export async function repairDesktop280Resources(resourceDir, dataRoot) {
  let folder = resolve(dataRoot);
  for (const part of ['versions', desktop280Identity, 'studio', 'scripts']) {
    folder = join(folder, part);
    const info = await lstat(folder).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!info) return [];
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Invalid legacy desktop resource directory');
  }
  const generation = resolve(folder, '../..');
  const ready = JSON.parse(await readFile(join(generation, 'ready.json'), 'utf8'));
  if (ready.identity !== desktop280Identity || ready.version !== '2.8.0') return [];
  const repaired = [];
  for (const name of missingIn280) {
    if (
      await lstat(join(folder, name)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      })
    )
      continue;
    const staging = join(folder, `.${name}.${randomUUID()}.tmp`);
    try {
      await copyFile(join(resourceDir, 'studio', 'scripts', name), staging);
      // Atomic, no-clobber publication: a running worker cannot read a partially copied script.
      await link(staging, join(folder, name));
      repaired.push(name);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      await unlink(staging).catch(() => {});
    }
  }
  if (repaired.length)
    await writeFile(
      join(generation, 'repair-2.8.1.json'),
      JSON.stringify({ repaired, at: new Date().toISOString() }),
    );
  return repaired;
}

// Catch missing relative modules and file-backed worker/helper references before packaging.
export async function verifyDesktopRuntimeResources(studioRoot) {
  const root = resolve(studioRoot);
  for (const name of desktopRuntimeScripts) {
    if (!(await lstat(join(root, 'scripts', name))).isFile())
      throw new Error(`Missing desktop runtime: ${name}`);
  }
  async function scan(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      if (!/\.(mjs|js)$/.test(entry.name)) continue;
      const source = await readFile(path, 'utf8');
      for (const match of source.matchAll(
        /['"]((?:\.{1,2}\/|scripts\/)[^'"\r\n]+\.(?:mjs|js|ps1|py))['"]/g,
      )) {
        const reference = resolve(match[1].startsWith('scripts/') ? root : dirname(path), match[1]);
        if (!reference.startsWith(root + sep)) throw new Error(`Desktop reference escapes bundle: ${path}`);
        const info = await lstat(reference).catch(() => null);
        if (!info?.isFile()) throw new Error(`Missing desktop resource ${match[1]} referenced by ${path}`);
      }
    }
  }
  await scan(root);
}
