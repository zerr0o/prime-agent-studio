import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { desktopRuntimeScripts, verifyDesktopRuntimeResources } from './desktop-runtime-resources.mjs';
import { checkNode } from '../lib/desktop-components.mjs';

checkNode();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.desktop-build'),
  studio = join(output, 'studio');
if (dirname(output) !== root || !output.endsWith('.desktop-build'))
  throw new Error('Unexpected build directory');
await rm(output, { recursive: true, force: true });
await mkdir(studio, { recursive: true });
for (const name of [
  'server.mjs',
  'index.html',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'lib',
  'public',
  'assets',
  'runtime',
])
  await cp(join(root, name), join(studio, name), {
    recursive: true,
    filter: (path) => !path.includes('__pycache__') && !path.endsWith('.pyc'),
  });
await mkdir(join(studio, 'scripts'));
for (const name of desktopRuntimeScripts)
  await cp(join(root, 'scripts', name), join(studio, 'scripts', name));
await verifyDesktopRuntimeResources(studio);
// Native-only engine: never ship a legacy runtime/cua-driver dir that the
// generic runtime copy above may have staged from the source tree.
await rm(join(studio, 'runtime', 'cua-driver'), { recursive: true, force: true });
const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: studio,
  windowsHide: true,
  stdio: 'inherit',
});
await cp(process.execPath, join(output, 'node.exe'));
// Windows starts the bundled Node with verbatim (\\?\C:\...) script paths.
// Node v24.20.0 crashes on them (EISDIR lstat 'C:'), so refuse such a build.
if (process.platform === 'win32') {
  const probe = join(output, 'verbatim-probe.mjs');
  await writeFile(probe, '');
  try {
    execFileSync(join(output, 'node.exe'), [`\\\\?\\${resolve(probe)}`], {
      windowsHide: true,
      stdio: 'pipe',
    });
  } catch {
    throw new Error(
      `Node ${process.version} cannot start scripts from verbatim Windows paths. Build with the pinned Node version.`,
    );
  } finally {
    await rm(probe, { force: true });
  }
}
const nodeLicense = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
if (!nodeLicense.ok) throw new Error('Cannot fetch the license for the bundled Node version');
await writeFile(join(output, 'NODE-LICENSE'), await nodeLicense.text());
const hash = createHash('sha256');
async function fingerprint(folder) {
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await fingerprint(path);
    else {
      hash.update(relative(output, path).replaceAll('\\', '/'));
      hash.update(await readFile(path));
    }
  }
}
await fingerprint(output);
const pkg = JSON.parse(await readFile(join(root, 'package.json')));
await writeFile(
  join(output, 'desktop-resource.json'),
  JSON.stringify({ identity: hash.digest('hex'), version: pkg.version, node: process.version }),
);
console.log(`Desktop resources prepared with Node ${process.version}.`);
