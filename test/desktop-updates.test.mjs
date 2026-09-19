import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { updateManifest, manifestFileName, isBetaVersion } from '../scripts/desktop-update-manifest.mjs';
test('release catalog uses the real signature and a stable GitHub installer name', async () => {
  const signature = await readFile(new URL('./fixtures/updater/payload.txt.sig', import.meta.url), 'utf8');
  const manifest = updateManifest({ version: '2.8.0', signature, notes: 'Release notes' });
  assert.equal(manifest.platforms['windows-x86_64'].signature, signature.trim());
  assert.equal(
    manifest.platforms['windows-x86_64'].url,
    'https://github.com/zerr0o/prime-agent-studio/releases/download/v2.8.0/Prime-Agent-Studio_2.8.0_x64-setup.exe',
  );
  assert.equal(manifest.notes, 'Release notes');
  for (const version of ['../x', '2.8.0-alpha.1', '2.8.0-rc.1', '2.8.0-beta', '2.8.0-beta.1.2', 'latest'])
    assert.throws(() => updateManifest({ version, signature }));
  for (const signature of ['', 'not-a-signature'])
    assert.throws(() => updateManifest({ version: '2.8.0', signature }));
});
test('beta catalog keeps signature checks and uses a beta GitHub installer name', async () => {
  const signature = await readFile(new URL('./fixtures/updater/payload.txt.sig', import.meta.url), 'utf8');
  const manifest = updateManifest({ version: '3.7.0-beta.1', signature, notes: 'Beta notes' });
  assert.equal(manifest.version, '3.7.0-beta.1');
  assert.equal(manifest.platforms['windows-x86_64'].signature, signature.trim());
  assert.equal(
    manifest.platforms['windows-x86_64'].url,
    'https://github.com/zerr0o/prime-agent-studio/releases/download/v3.7.0-beta.1/Prime-Agent-Studio_3.7.0-beta.1_x64-setup.exe',
  );
  assert.equal(manifest.notes, 'Beta notes');
  for (const signature of ['', 'not-a-signature'])
    assert.throws(() => updateManifest({ version: '3.7.0-beta.1', signature }));
});
test('manifest file name keeps stable on latest.json and moves beta to beta.json', () => {
  assert.equal(manifestFileName('2.8.0'), 'latest.json');
  assert.equal(manifestFileName('3.7.0-beta.1'), 'beta.json');
  assert.equal(isBetaVersion('3.7.0-beta.1'), true);
  assert.equal(isBetaVersion('2.8.0'), false);
});
