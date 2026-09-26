import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Backport of upstream Prime Agent PR2372 (synchronous bash.consumed frame
// before the cell done frame) into NEW Studio kernel venvs only.
// Upstream: https://github.com/PrimeIntellect-ai/prime-agent/pull/2372
export const KERNEL_COMPAT_VERSION = 'pr2372-v1';
const HERE = dirname(fileURLToPath(import.meta.url));
export const KERNEL_COMPAT_SCRIPT = join(HERE, '..', 'runtime', 'kernel-compat.py');

/** Identity of the compat overlay: version plus script content hash. */
export async function kernelCompatIdentity({ read = readFile, script = KERNEL_COMPAT_SCRIPT } = {}) {
  const content = await read(script, 'utf8');
  return {
    version: KERNEL_COMPAT_VERSION,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

/** Patch the freshly installed venv copy of rlm/bash.py, before validation. */
export async function applyKernelCompat(
  python,
  { run, env = process.env, signal, onProgress = () => {}, compatScript = KERNEL_COMPAT_SCRIPT } = {},
) {
  if (typeof run !== 'function') throw new Error('kernel compat: execute runner required');
  onProgress('Correctif noyau PR2372 en cours / Applying PR2372 kernel fix to the new environment');
  await run(python, [compatScript, '--json'], { ...env, PYTHONDONTWRITEBYTECODE: '1' }, 60000, signal);
}
