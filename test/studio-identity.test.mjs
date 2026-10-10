import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStudioMachineId } from '../lib/studio-identity.mjs';

// Studio identity is shared with synchronization through sync-device.json.
// Creating the identity must never configure or start synchronization.

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prime-studio-identity-'));
  t.after(async () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id);

test('a fresh directory gets a stable identity persisted in sync-device.json', async (t) => {
  const dir = await tempDir(t);
  const first = await getStudioMachineId(dir);
  assert.ok(validId(first), 'identity is an opaque ASCII identifier');
  const stored = JSON.parse(await readFile(join(dir, 'sync-device.json'), 'utf8'));
  assert.equal(stored.id, first);
  assert.equal(await getStudioMachineId(dir), first);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => getStudioMachineId(dir)));
  assert.ok(
    concurrent.every((id) => id === first),
    'concurrent reads share one identity',
  );
  assert.equal(await getStudioMachineId(dir), first, 'reads stay stable after settling');
});

test('a legacy sync.json deviceId is preserved without configuring synchronization', async (t) => {
  const dir = await tempDir(t);
  const legacy = { deviceId: 'legacy-device-ABC123', device: 'Studio A' };
  await writeFile(join(dir, 'sync.json'), JSON.stringify(legacy));
  const before = await readFile(join(dir, 'sync.json'), 'utf8');
  const id = await getStudioMachineId(dir);
  assert.equal(id, legacy.deviceId);
  assert.equal(await readFile(join(dir, 'sync.json'), 'utf8'), before, 'sync.json is untouched');
  const device = JSON.parse(await readFile(join(dir, 'sync-device.json'), 'utf8'));
  assert.equal(device.id, legacy.deviceId);
  const names = await readdir(dir);
  assert.ok(!names.includes('sync-state.json'), 'no synchronization state is created');
  assert.equal(await getStudioMachineId(dir), legacy.deviceId, 'legacy identity stays stable');
});

test('conflicting persisted identities fail closed', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'sync.json'), JSON.stringify({ deviceId: 'device-A-1' }));
  await writeFile(join(dir, 'sync-device.json'), JSON.stringify({ id: 'device-B-2' }));
  await assert.rejects(getStudioMachineId(dir), /Conflicting persisted Studio identities/);
});

test('invalid persisted identities fail closed', async (t) => {
  const badDevice = await tempDir(t);
  await writeFile(join(badDevice, 'sync-device.json'), JSON.stringify({ id: 'not valid!!' }));
  await assert.rejects(getStudioMachineId(badDevice), /Invalid persisted Studio identity/);
  for (const deviceId of ['not valid!!', '', 0, false, null]) {
    const badConfig = await tempDir(t);
    await writeFile(join(badConfig, 'sync.json'), JSON.stringify({ deviceId }));
    await assert.rejects(getStudioMachineId(badConfig), /Invalid persisted Studio identity/);
  }
});

test('separate directories get distinct stable identities', async (t) => {
  const first = await tempDir(t);
  const second = await tempDir(t);
  const [idA, idB] = await Promise.all([getStudioMachineId(first), getStudioMachineId(second)]);
  assert.ok(validId(idA) && validId(idB));
  assert.notEqual(idA, idB);
  assert.equal(await getStudioMachineId(first), idA);
  assert.equal(await getStudioMachineId(second), idB);
});
