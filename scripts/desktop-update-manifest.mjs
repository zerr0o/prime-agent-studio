import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectInvocation } from './launcher-common.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function isBetaVersion(version) {
  return /^\d+\.\d+\.\d+-beta\.\d+$/.test(String(version || ''));
}
export function manifestFileName(version) {
  return isBetaVersion(version) ? 'beta.json' : 'latest.json';
}
export function updateManifest({ version, signature, notes = '', date = new Date().toISOString() }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) && !/^\d+\.\d+\.\d+-beta\.\d+$/.test(version))
    throw new Error('A stable or beta version is required (for example 2.8.0 or 3.7.0-beta.1)');
  if (
    !signature?.trim() ||
    !Buffer.from(signature.trim(), 'base64').toString().startsWith('untrusted comment:')
  )
    throw new Error('Missing updater signature');
  return {
    version,
    notes,
    pub_date: date,
    platforms: {
      'windows-x86_64': {
        signature: signature.trim(),
        url: `https://github.com/zerr0o/prime-agent-studio/releases/download/v${version}/Prime-Agent-Studio_${version}_x64-setup.exe`,
      },
    },
  };
}
if (isDirectInvocation(import.meta.url)) {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const source = join(
    root,
    'src-tauri/target/release/bundle/nsis',
    `Prime Agent Studio_${version}_x64-setup.exe`,
  );
  const signature = await readFile(source + '.sig', 'utf8');
  const notes = process.argv[2] ? await readFile(resolve(process.argv[2]), 'utf8') : '';
  const manifest = updateManifest({ version, signature, notes });
  const output = join(root, '.local', 'desktop-release', `v${version}`);
  await mkdir(output, { recursive: true });
  const destination = join(output, `Prime-Agent-Studio_${version}_x64-setup.exe`);
  await copyFile(source, destination);
  await copyFile(source + '.sig', destination + '.sig');
  const fileName = manifestFileName(version);
  await writeFile(join(output, fileName), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Signed installer, signature and ${fileName} prepared in ${output}`);
}
