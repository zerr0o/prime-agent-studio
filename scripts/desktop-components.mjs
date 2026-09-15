import { join } from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import { atomicJson, diagnoseComponents, prepareComponents } from '../lib/desktop-components.mjs';
import { isDirectInvocation, acquireLock, readJson } from './launcher-common.mjs';
import { desktopServerStatus, restartDesktop } from './desktop-control.mjs';

export async function runComponents(options, { signal, onProgress = () => {} } = {}) {
  if (!['diagnose', 'install', 'select', 'activate'].includes(options.action))
    throw new Error('action_invalid');
  if (options.action === 'select') {
    if (!['engine', 'uv', 'python'].includes(options.component) || typeof options.path !== 'string')
      throw new Error('selection_invalid');
    const base = join(options.dataRoot, 'engine');
    await mkdir(base, { recursive: true });
    const release = await acquireLock({ lock: join(base, 'install.lock') }, { timeout: 1200 });
    try {
      const current = (await readJson(join(base, 'selection.json'))) || {};
      await atomicJson(join(base, 'selection.json'), { ...current, [options.component]: options.path });
    } finally {
      await release();
    }
  }
  const result =
    options.action === 'install'
      ? await prepareComponents({ ...options, signal, onProgress })
      : await diagnoseComponents({ ...options, signal, onProgress });
  // Reuse a fully working external installation without authorizing any download.
  if (options.action === 'activate' && result.ready) {
    const base = join(options.dataRoot, 'engine');
    await mkdir(base, { recursive: true });
    const release = await acquireLock({ lock: join(base, 'install.lock') }, { timeout: 1200 });
    try {
      const current = (await readJson(join(base, 'installation.json'))) || {};
      if (
        current.shellValidated !== true ||
        current.components?.engine?.path !== result.components.engine.path ||
        current.components?.python?.path !== result.components.python.path
      )
        await atomicJson(join(base, 'installation.json'), {
          schema: 1,
          validatedAt: new Date().toISOString(),
          shellValidated: true,
          components: result.components,
        });
    } finally {
      await release();
    }
  }
  if (options.action === 'install') {
    if (!result.ready) {
      result.activation = 'incomplete';
      return result;
    }
    const status = await desktopServerStatus(options);
    if (!status.managed || status.activeRuns) result.activation = 'deferred';
    else {
      onProgress({ component: 'studio', stage: 'opening' });
      const restarted = await restartDesktop({ ...options, force: false });
      result.activation = restarted.restarted ? 'active' : 'deferred';
      if (restarted.restarted) {
        const response = await fetch(`http://127.0.0.1:${options.port}/api/version`, {
          signal: AbortSignal.timeout(30000),
        });
        const version = await response.json();
        if (
          !response.ok ||
          !version.available ||
          !String(version.version).includes(result.components.engine.version)
        )
          throw new Error('server_validation_failed');
      }
    }
  }
  return result;
}
if (isDirectInvocation(import.meta.url)) {
  const abort = new AbortController();
  process.stdin.resume();
  process.stdin.on('data', () => abort.abort());
  process.stdin.on('end', () => abort.abort());
  const options = JSON.parse(process.argv[2] || '{}');
  const output = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  let lastLog = 0;
  const onProgress = (event) => {
    output({ type: 'progress', ...event });
    if (Date.now() - lastLog > 1000 || event.stage === 'error') {
      lastLog = Date.now();
      // Only controlled codes and byte counts, never tool stderr or the environment.
      void appendFile(
        join(options.dataRoot, 'engine/logs/components.log'),
        JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n',
      ).catch(() => {});
    }
  };
  try {
    if (options.action === 'install') await mkdir(join(options.dataRoot, 'engine/logs'), { recursive: true });
    output({ type: 'result', result: await runComponents(options, { signal: abort.signal, onProgress }) });
  } catch (error) {
    output({
      type: 'failure',
      component: error.component,
      error: /^[a-z_]+$/.test(error.message) ? error.message : 'preparation_failed',
    });
  } finally {
    process.stdin.destroy();
  }
}
