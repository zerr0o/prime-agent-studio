import { formatMessage as tr } from '../public/i18n-core.js';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { agentEnvironment, discoverCli } from './agent.mjs';
import { createMcpConfigStore, mcpRevision } from './mcp-config.mjs';
import { HttpError } from './store.mjs';
import { ensureLocalKernel, localKernelPython } from './kernel.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32')
    execFile(
      join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, shell: false },
      () => {},
    );
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }
}
export function createMcpService({
  agentHome,
  environment = process.env,
  store = createMcpConfigStore({ agentHome, env: environment }),
  kernelRoot = environment.PRIME_AGENT_GUI_KERNEL_ROOT || ROOT,
  python,
  prepareKernel = ensureLocalKernel,
  discoverRuntime = discoverCli,
  spawnProcess = spawn,
}) {
  const jobs = new Map(),
    probes = new Set(),
    preparations = new Set();
  let pendingProbes = 0,
    closed = false;
  function ensureOpen() {
    if (closed) throw new HttpError(503, tr('server.la_gestion_mcp_est_en_cours_de_fermeture'));
  }
  function ensureIdle(name) {
    if ([...jobs.values()].some((job) => job.name === name && ['preparing', 'waiting'].includes(job.status)))
      throw new HttpError(409, tr('server.terminez_ou_annulez_la_connexion_oauth_de_ce_serveur_avant_de_le'));
  }
  function snapshot(job) {
    return { id: job.id, name: job.name, status: job.status, url: job.url, error: job.error };
  }
  async function probePython() {
    // Desktop releases share a persistent kernel root. Read its marker on each
    // test: an agent may have prepared Python since this service was created.
    const configured = python || environment.PRIME_AGENT_KERNEL_PYTHON;
    const available = configured || localKernelPython(kernelRoot);
    if (existsSync(available)) return available;
    if (configured) throw new HttpError(503, tr('server.le_moteur_python_configure_est_introuvable'));
    const preparation = new AbortController();
    preparations.add(preparation);
    try {
      const cli = discoverRuntime(environment.PRIME_AGENT_CLI);
      if (!cli?.packageDir) throw new Error('Prime Agent runtime unavailable');
      return await prepareKernel({
        packageDir: cli.packageDir,
        agentHome,
        root: kernelRoot,
        env: agentEnvironment({ agentHome, env: environment }),
        // MCP discovery needs the core runtime, not a project's optional skills.
        pythonSkills: [],
        signal: preparation.signal,
      });
    } catch {
      ensureOpen();
      throw new HttpError(503, tr('server.la_preparation_automatique_de_python_a_echoue'));
    } finally {
      preparations.delete(preparation);
    }
  }
  async function probe(body) {
    ensureOpen();
    if (pendingProbes >= 2) throw new HttpError(429, tr('server.deux_tests_mcp_sont_deja_en_cours'));
    pendingProbes++;
    try {
      return await runProbe(body);
    } finally {
      pendingProbes--;
    }
  }
  async function runProbe(body) {
    let { config } = await store.get(body.name);
    ensureOpen();
    if (body.revision !== mcpRevision(config))
      throw new HttpError(409, tr('server.rechargez_la_liste_ce_serveur_a_change'));
    if (config.enabled === false)
      throw new HttpError(400, tr('server.activez_ce_serveur_avant_de_le_tester'));
    const resolvedPython = await probePython();
    ensureOpen();
    // Setup can take time. Never connect using a configuration changed or
    // disabled while Python was being prepared.
    ({ config } = await store.get(body.name));
    ensureOpen();
    if (body.revision !== mcpRevision(config))
      throw new HttpError(409, tr('server.rechargez_la_liste_ce_serveur_a_change'));
    if (config.enabled === false)
      throw new HttpError(400, tr('server.activez_ce_serveur_avant_de_le_tester'));
    return new Promise((done, reject) => {
      const child = spawnProcess(process.execPath, [join(ROOT, 'scripts/mcp-probe-worker.mjs')], {
        env: agentEnvironment({ agentHome, env: environment }),
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      probes.add(child);
      let output = '',
        settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        probes.delete(child);
        error ? reject(error) : done(value);
      };
      const timer = setTimeout(
        () => {
          stop(child);
          finish(new HttpError(504, tr('server.le_test_mcp_a_depasse_le_delai_de_connexion')));
        },
        Math.min(config.startupTimeoutMs || 20000, 25000) + 5000,
      );
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.length > 512 * 1024) {
          stop(child);
          finish(new HttpError(502, tr('server.le_catalogue_mcp_depasse_la_taille_autorisee')));
        }
      });
      child.once('error', () => finish(new HttpError(502, tr('server.impossible_de_lancer_le_test_mcp'))));
      child.once('close', (code) => {
        try {
          const data = JSON.parse(output.trim());
          if (code !== 0 || data.error || !Array.isArray(data.tools) || !Number.isSafeInteger(data.total))
            throw new Error();
          finish(null, { tools: data.tools, total: data.total, testedAt: new Date().toISOString() });
        } catch {
          finish(
            new HttpError(502, tr('server.connexion_mcp_impossible_verifiez_la_commande_ou_l_url_les_varia')),
          );
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(
        JSON.stringify({
          agentHome,
          name: body.name,
          revision: body.revision,
          python: resolvedPython,
        }),
      );
    });
  }
  async function login(body) {
    ensureOpen();
    ensureIdle(body.name);
    const selected = await store.get(body.name);
    ensureOpen();
    ensureIdle(body.name);
    if (body.revision !== mcpRevision(selected.config))
      throw new HttpError(409, tr('server.rechargez_la_liste_ce_serveur_a_change'));
    if (!selected.config.oauth || selected.config.enabled === false)
      throw new HttpError(400, tr('server.activez_oauth_sur_ce_serveur_avant_de_vous_connecter'));
    if ([...jobs.values()].filter((job) => ['preparing', 'waiting'].includes(job.status)).length >= 2)
      throw new HttpError(429, tr('server.deux_connexions_oauth_sont_deja_en_cours'));
    const child = spawnProcess(process.execPath, [join(ROOT, 'scripts/mcp-oauth-worker.mjs')], {
      env: agentEnvironment({ agentHome, env: environment }),
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const job = { id: randomUUID(), name: body.name, status: 'preparing', child };
    jobs.set(job.id, job);
    const finish = () => {
      clearTimeout(job.timer);
      job.url = undefined;
      setTimeout(() => jobs.delete(job.id), 60000).unref();
    };
    job.timer = setTimeout(() => {
      job.status = 'error';
      job.error = tr('server.connexion_expiree_relancez_la_pour_reessayer');
      stop(child);
      finish();
    }, 180000);
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      if (pending.length > 65536) {
        stop(child);
        return;
      }
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (!['preparing', 'waiting'].includes(job.status)) continue;
        try {
          const data = JSON.parse(line);
          if (data.status === 'waiting') {
            const url = new URL(data.url);
            const callback = new URL(url.searchParams.get('redirect_uri'));
            if (
              url.protocol !== 'https:' ||
              url.username ||
              url.password ||
              !url.searchParams.get('state') ||
              callback.protocol !== 'http:' ||
              callback.hostname !== 'localhost' ||
              callback.pathname !== '/callback' ||
              !/^5370[0-9]$/.test(callback.port)
            )
              throw new Error();
            job.url = url.toString();
            job.status = 'waiting';
          } else if (data.status === 'complete') {
            job.status = 'complete';
            finish();
          } else if (data.status === 'error') {
            job.status = 'error';
            job.error = data.error;
            finish();
          }
        } catch {
          job.status = 'error';
          job.error = tr('server.reponse_oauth_invalide');
          stop(child);
          finish();
        }
      }
    });
    child.on('error', () => {
      job.status = 'error';
      job.error = tr('server.impossible_de_demarrer_la_connexion_oauth');
      finish();
    });
    child.on('close', () => {
      if (['preparing', 'waiting'].includes(job.status)) {
        job.status = 'error';
        job.error = tr('server.la_connexion_oauth_a_ete_interrompue');
        finish();
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ agentHome, name: body.name, revision: body.revision }) + '\n');
    return snapshot(job);
  }
  function jobFor(id) {
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, tr('server.connexion_oauth_introuvable_ou_expiree'));
    return job;
  }
  function complete(body) {
    const job = jobFor(body.id);
    // A pasted return URL often arrives after the exchange already failed.
    // Show the stored provider error instead of a generic mismatch message.
    if (job.status !== 'waiting') {
      if (job.error) throw new HttpError(400, job.error);
      throw new HttpError(409, tr('server.cette_connexion_n_attend_pas_de_reponse'));
    }
    let returned, auth;
    try {
      returned = new URL(body.url);
      auth = new URL(job.url);
    } catch {
      throw new HttpError(400, tr('server.collez_l_adresse_complete_obtenue_apres_autorisation'));
    }
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    // The provider may refuse in the browser (access_denied, invalid_request).
    // Report its reason instead of a generic mismatch message.
    const refused = returned.searchParams.get('error');
    if (refused) {
      const description = (returned.searchParams.get('error_description') || '').slice(0, 300);
      throw new HttpError(
        400,
        tr('server.le_serveur_a_refuse_l_autorisation', {
          value1: description ? `${refused} : ${description}` : refused,
        }),
      );
    }
    if (
      returned.origin !== callback.origin ||
      returned.pathname !== callback.pathname ||
      !returned.searchParams.get('code') ||
      !auth.searchParams.get('state') ||
      returned.searchParams.get('state') !== auth.searchParams.get('state')
    )
      throw new HttpError(400, tr('server.cette_adresse_de_retour_ne_correspond_pas_a_la_connexion_en_cour'));
    job.child.stdin.write(JSON.stringify({ type: 'complete', url: returned.toString() }) + '\n');
    return snapshot(job);
  }
  function cancel(id) {
    const job = jobFor(id);
    if (['preparing', 'waiting'].includes(job.status)) {
      job.status = 'cancelled';
      clearTimeout(job.timer);
      stop(job.child);
      job.url = undefined;
      setTimeout(() => jobs.delete(id), 60000).unref();
    }
    return snapshot(job);
  }
  return {
    list: store.list,
    probe,
    login,
    complete,
    cancel,
    job: (id) => snapshot(jobFor(id)),
    upsert: (body) => {
      ensureIdle(body.name);
      return store.upsert(body);
    },
    remove: (body) => {
      ensureIdle(body.name);
      return store.remove(body);
    },
    toggle: (body) => {
      ensureIdle(body.name);
      return store.toggle(body);
    },
    disconnect: (body) => {
      ensureIdle(body.name);
      return store.disconnect(body);
    },
    close() {
      closed = true;
      for (const preparation of preparations) preparation.abort();
      for (const child of probes) stop(child);
      for (const job of jobs.values()) {
        clearTimeout(job.timer);
        stop(job.child);
      }
    },
  };
}
