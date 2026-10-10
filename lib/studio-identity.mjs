import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const pending = new Map();
const valid = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id);
async function read(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// API and sync share one durable identity; creating it never configures sync.
export function getStudioMachineId(dataDir) {
  const key = resolve(dataDir);
  if (pending.has(key)) return pending.get(key);
  const operation = (async () => {
    const file = join(key, 'sync-device.json');
    const [config, device] = await Promise.all([read(join(key, 'sync.json')), read(file)]);
    if ((device && !valid(device.id)) || (config?.deviceId !== undefined && !valid(config.deviceId)))
      throw new Error('Invalid persisted Studio identity.');
    if (config?.deviceId && device?.id && config.deviceId !== device.id)
      throw new Error('Conflicting persisted Studio identities.');
    const id = config?.deviceId || device?.id || randomUUID();
    if (!device) {
      await mkdir(key, { recursive: true });
      try {
        await writeFile(file, JSON.stringify({ id }), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const winner = await read(file);
        if (!valid(winner?.id) || (config?.deviceId && winner.id !== config.deviceId)) throw error;
        return winner.id;
      }
    }
    return id;
  })();
  pending.set(key, operation);
  operation.finally(() => pending.delete(key)).catch(() => {});
  return operation;
}
