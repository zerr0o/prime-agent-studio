import { join } from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import {
  atomicJson,
  diagnoseComponents,
  prepareComponents,
  quickComponentReceipt,
  COMPONENT_POLICY,
} from '../lib/desktop-components.mjs';
import { isDirectInvocation, acquireLock, readJson } from './launcher-common.mjs';
import { desktopServerStatus, restartDesktop } from './desktop-control.mjs';

const safeCode = (error, fallback = 'preparation_failed') =>
  /^[a-z_]{1,80}$/.test(error?.message || '') ? error.message : fallback;

async function runtimeVersion(port, fetcher, timeout = 4000) {
  const response = await fetcher(`http://127.0.0.1:${port}/api/version`, {
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error('server_validation_failed');
  const runtime = await response.json();
  return { available: runtime.available === true, version: String(runtime.version || '').trim() };
}

async function describe(options, result, deps) {
  const installed = await readJson(join(options.dataRoot, 'engine/installation.json'));
  const app = options.resourceDir ? await readJson(join(options.resourceDir, 'desktop-resource.json')) : null;
  result.requiredEngine = COMPONENT_POLICY.engine;
  result.installedEngine = installed?.components?.engine?.version || null;
  result.appVersion = app?.version || null;
  result.needsUpdate = !result.ready;
  try {
    result.server = await (deps.serverStatus || desktopServerStatus)(options);
    if (result.server.running) {
      try {
        const runtime = await runtimeVersion(options.port, deps.fetch || fetch);
        result.server.engineVersion = runtime.version || null;
        result.server.engineAvailable = runtime.available;
      } catch (error) {
        result.server.error = safeCode(error, 'server_status_failed');
      }
    }
  } catch (error) {
    result.server = { managed: false, error: safeCode(error, 'server_status_failed') };
  }
  result.needsRestart = Boolean(
    result.ready &&
    (!result.server.running ||
      result.server.engineVersion !== result.requiredEngine ||
      !result.server.engineAvailable ||
      (result.appVersion && result.server.version !== result.appVersion)),
  );
  result.serverUpdatePending = Boolean(
    result.server.running && result.appVersion && result.server.version !== result.appVersion,
  );
  return result;
}

export async function runComponents(options, { signal, onProgress = () => {} } = {}, deps = {}) {
  if (!['status', 'diagnose', 'install', 'select', 'activate', 'apply'].includes(options.action))
    throw new Error('action_invalid');
  if (options.action === 'status') {
    const installed = await readJson(join(options.dataRoot, 'engine/installation.json'));
    const receipt = await (deps.quickReceipt || quickComponentReceipt)(options);
    const components = Object.fromEntries(
      Object.entries(installed?.components || {})
        .filter(([, info]) => info)
        .map(([name, info]) => [name, { ...info, status: receipt.ok ? 'ready' : 'pending' }]),
    );
    return describe(options, { ready: receipt.ok, components, receiptReason: receipt.reason }, deps);
  }
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
  // Inspect the live server before a long preparation, without stopping it.
  // This snapshot is only explanatory: activation rechecks ownership and activity.
  const before = ['install', 'apply'].includes(options.action)
    ? await describe(options, { ready: false }, deps)
    : null;
  if (before?.serverUpdatePending) onProgress({ component: 'studio', stage: 'server_update_pending' });
  const result =
    options.action === 'install'
      ? await (deps.prepare || prepareComponents)({ ...options, signal, onProgress })
      : await (deps.diagnose || diagnoseComponents)({ ...options, signal, onProgress });
  // Legacy launcher activation only records an already validated explicit choice.
  // It MUST NOT restart a warm server just because the launcher is opened.
  if (['activate', 'apply'].includes(options.action) && result.ready) {
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
  await describe(options, result, deps);
  if (!['install', 'apply'].includes(options.action)) return result;
  if (!result.ready) {
    result.activation = 'incomplete';
    return result;
  }
  // Preparation is committed. Do not relabel a subsequent activation failure
  // as an installation failure or lose the validated component details.
  try {
    signal?.throwIfAborted();
    const status = await (deps.serverStatus || desktopServerStatus)(options);
    if (!status.managed || status.activeRuns) {
      result.activation = 'deferred';
      result.activationReason = status.managed ? 'agents_running' : 'server_not_managed';
    } else {
      onProgress({ component: 'studio', stage: 'opening' });
      const restarted = await (deps.restart || restartDesktop)({ ...options, force: false });
      result.activation = restarted.restarted ? 'active' : 'deferred';
      result.activationReason = restarted.reason || undefined;
      if (restarted.reason === 'components_required') {
        result.ready = false;
        result.activation = 'incomplete';
        result.activationError = 'components_required';
        onProgress({ component: 'studio', stage: 'error', error: 'components_required' });
      }
      if (restarted.restarted) {
        const runtime = await runtimeVersion(options.port, deps.fetch || fetch, 30000);
        if (!runtime.available || runtime.version !== result.requiredEngine)
          throw new Error('server_validation_failed');
      }
    }
  } catch (error) {
    result.activation = 'failed';
    result.activationError = signal?.aborted ? 'cancelled' : safeCode(error, 'server_activation_failed');
    onProgress({ component: 'studio', stage: 'error', error: result.activationError });
  }
  await describe(options, result, deps);
  if (result.activation === 'active') result.needsRestart = false;
  return result;
}

// Persist the final controlled diagnostic, even when the error happens after
// prepareComponents returned. No stack, command, environment or tool stderr.
export async function recordComponentFailure(dataRoot, { component, error, phase = 'preparation' }) {
  const directory = join(dataRoot, 'engine/logs');
  await mkdir(directory, { recursive: true });
  const code = safeCode({ message: error });
  const known = ['engine', 'python', 'uv', 'npm', 'bash', 'node', 'studio'];
  await appendFile(
    join(directory, 'components.log'),
    JSON.stringify({
      at: new Date().toISOString(),
      component: known.includes(component) ? component : 'studio',
      stage: 'error',
      phase: phase === 'activation' ? phase : 'preparation',
      error: code,
    }) + '\n',
  );
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
    const result = await runComponents(options, { signal: abort.signal, onProgress });
    if (result.activationError)
      await recordComponentFailure(options.dataRoot, {
        component: 'studio',
        error: result.activationError,
        phase: 'activation',
      }).catch(() => {});
    output({ type: 'result', result });
  } catch (error) {
    await recordComponentFailure(options.dataRoot, {
      component: error.component,
      error: safeCode(error),
    }).catch(() => {});
    output({
      type: 'failure',
      component: error.component,
      error: /^[a-z_]+$/.test(error.message) ? error.message : 'preparation_failed',
    });
  } finally {
    process.stdin.destroy();
  }
}
