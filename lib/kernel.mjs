import { formatMessage as tr } from '../public/i18n-core.js';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, open, unlink, stat, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, delimiter, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { discoverPythonSkills, resolveSkillPackages } from './kernel-skills.mjs';
import { KERNEL_COMPAT_SCRIPT, applyKernelCompat, kernelCompatIdentity } from './kernel-compat.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jobs = new Map();
const PACKAGES = [
  'dill',
  'requests',
  'httpx',
  'pyyaml',
  'tomli',
  'python-dotenv',
  'pandas',
  'numpy',
  'scipy',
  'beautifulsoup4',
  'lxml',
  'pydantic',
  'tyro',
];
const SCHEMA = 2;
const IMPORTS = [
  'rlm',
  'rlm.repl',
  'dill',
  'requests',
  'httpx',
  'yaml',
  'tomli',
  'dotenv',
  'pandas',
  'numpy',
  'scipy',
  'bs4',
  'lxml',
  'pydantic',
  'tyro',
];
const pythonIn = (venv) => join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

/** Last fully validated environment, with the legacy location as a migration fallback. */
export function localKernelPython(root = ROOT) {
  try {
    const marker = JSON.parse(readFileSync(join(root, '.local/kernel-ready.json'), 'utf8'));
    if (
      marker.schema === SCHEMA &&
      typeof marker.python === 'string' &&
      resolve(marker.python).startsWith(resolve(root, '.local/kernel-venv') + sep) &&
      existsSync(marker.python)
    )
      return marker.python;
  } catch {
    /* An old installation can still serve runtime-only MCP probes. */
  }
  return pythonIn(join(root, '.local/kernel-venv'));
}

export function checkCode(skills) {
  return `import importlib, inspect, json, traceback
checks = json.loads(${JSON.stringify(
    JSON.stringify([
      ...IMPORTS.map((name) => ({ name, kind: 'runtime' })),
      ...skills.map((skill) => ({ name: skill.importName, kind: 'skill' })),
    ]),
  )})
failures = []
for check in checks:
    try:
        module = importlib.import_module(check['name'])
        if check['name'] == 'rlm':
            assert callable(module.host_request), 'rlm.host_request must be callable'
            assert callable(module.spawn), 'rlm.spawn must be callable'
            assert callable(module.progress_note), 'rlm.progress_note must be callable'
            assert not hasattr(module, 'run'), 'rlm.run was removed; use rlm.spawn'
            assert inspect.signature(module.spawn).parameters['name'].default is inspect.Parameter.empty, 'rlm.spawn name must be required'
            assert callable(module.rlm.spawn), 'rlm.rlm.spawn must be callable'
            assert not hasattr(module.rlm, 'run'), 'rlm.run was removed; use rlm.spawn'
            _mcp = importlib.import_module('rlm.mcp')
            for _method in ('list_plugins', 'search_plugins', 'list_connections', 'search_tools', 'describe_tool'):
                assert callable(getattr(_mcp, _method, None)), f'rlm.mcp.{_method} must be callable; the kernel venv needs a current prime-agent-runtime'
        if check['name'] == 'rlm.repl':
            assert module.PROTOCOL_VERSION == 3, 'unsupported kernel protocol'
        if check['name'] == 'agent_message':
            assert callable(module.send), 'agent_message.send must be callable'
    except Exception:
        failures.append(dict(check, error=traceback.format_exc()))
try:
    import importlib as _compat_il
    import pathlib as _compat_pl
    import runpy as _compat_runpy
    # Same shadowing trap as in kernel-compat.py: rlm/__init__ re-exports a
    # bash() function, so only import_module returns the real rlm.bash module.
    _compat_bashmod = _compat_il.import_module('rlm.bash')
    _compat_probe = _compat_runpy.run_path(${JSON.stringify(KERNEL_COMPAT_SCRIPT)})
    _compat_src = _compat_pl.Path(_compat_bashmod.__file__).read_text(encoding='utf-8')
    assert _compat_probe['classify'](_compat_src) == 'patched', (
        'PR2372 kernel fix missing or unrecognized: the bash.consumed withdrawal must be '
        'synchronous. Unset PRIME_AGENT_KERNEL_PYTHON to use the managed patched kernel.'
    )
    assert not _compat_probe['_missing_imports'](_compat_src), (
        'PR2372 kernel fix incomplete: required functools/uuid imports are missing.'
    )
except Exception:
    failures.append({'name': 'kernel-compat-pr2372', 'kind': 'runtime', 'error': traceback.format_exc()})
print(json.dumps({'failures': failures}))`;
}

export function execute(command, args, env, timeout = 300000, signal, { cwd } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error(tr('server.preparation_du_noyau_annulee')));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false,
      cancelled = false;
    const stop = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') {
        execFile(
          join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, shell: false, timeout: 10000 },
          () => {
            if (child.exitCode === null && child.signalCode === null) child.kill();
          },
        );
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const abort = () => {
      cancelled = true;
      stop();
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-65536);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-65536);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new Error(`${command} : ${error.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (cancelled) reject(new Error(tr('server.preparation_du_noyau_annulee')));
      else if (timedOut)
        reject(
          new Error(
            tr('server.le_delai_de_s_est_depasse_pour_vous_pouvez_relancer_npm_run_setup', {
              value1: Math.round(timeout / 1000),
              value2: command,
            }),
          ),
        );
      else if (code !== 0)
        reject(new Error(`${command} : ${(stderr || `code de sortie ${code}`).trim().slice(-4000)}`));
      else resolvePromise(stdout.trim());
    });
  });
}

async function setupLock(path, signal) {
  const deadline = Date.now() + 330000;
  while (true) {
    if (signal?.aborted) throw new Error(tr('server.preparation_du_noyau_annulee'));
    try {
      const file = await open(path, 'wx');
      await file.writeFile(JSON.stringify({ pid: process.pid }));
      return async () => {
        await file.close();
        await unlink(path).catch(() => {});
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(await readFile(path, 'utf8'));
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
          } catch (error) {
            if (error.code === 'ESRCH') await unlink(path).catch(() => {});
          }
        }
      } catch {
        // A creator may not have written the PID yet. Only reap an old,
        // incomplete lock; never race a freshly-created lock file.
        const info = await stat(path).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 30000) await unlink(path).catch(() => {});
      }
      if (Date.now() > deadline)
        throw new Error(tr('server.une_autre_preparation_du_noyau_est_toujours_en_cours_reessayez_ap'));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
  }
}

async function fingerprint(source) {
  const hash = createHash('sha256');
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (
        ['__pycache__', '.git', '.venv', 'node_modules', 'build', 'dist'].includes(entry.name) ||
        entry.name.endsWith('.egg-info')
      )
        continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.py') || entry.name === 'pyproject.toml')
        hash.update(path).update(await readFile(path));
    }
  }
  await walk(source);
  return hash.digest('hex');
}

/** Windows-compatible, immutable environments; never repair an active Python in place. */
export async function ensureLocalKernel(
  {
    packageDir,
    env = process.env,
    root = ROOT,
    cwd = process.cwd(),
    agentHome = env.PRIME_AGENT_CODING_AGENT_DIR || join(homedir(), '.prime', 'agent'),
    pythonSkills,
    onProgress = () => {},
    signal,
    readOnly = false,
  },
  dependencies = {},
) {
  if (signal?.aborted) throw new Error(tr('server.preparation_du_noyau_annulee'));
  const run = dependencies.execute || execute;
  const discovery =
    pythonSkills === undefined
      ? await (dependencies.discover || discoverPythonSkills)({ packageDir, cwd, agentHome, env, signal })
      : { skills: pythonSkills, diagnostics: [] };
  for (const message of discovery.diagnostics || [])
    onProgress(tr('server.skills_python', { value1: message }));
  const skills = discovery.skills;
  async function validate(python, external = false) {
    let result;
    try {
      const output = await run(
        python,
        ['-c', checkCode(skills)],
        { ...env, PYTHONDONTWRITEBYTECODE: '1' },
        30000,
        signal,
      );
      result = JSON.parse(output.split(/\r?\n/).at(-1));
      if (!Array.isArray(result.failures)) throw new Error(tr('server.resultat_de_validation_invalide'));
    } catch (error) {
      throw new Error(tr('server.verification_du_python', { value1: python, value2: error.message }));
    }
    for (const failure of result.failures) {
      const essential = failure.kind === 'runtime' || failure.name === 'agent_message';
      const diagnostic = tr('server.python', {
        value1: python,
        value2: essential ? 'fonction essentielle' : 'skill optionnelle',
        value3: failure.name,
        value4: failure.error,
      });
      if (!external || essential) throw new Error(diagnostic);
      onProgress(tr('server.avertissement', { value1: diagnostic }));
    }
  }
  if (env.PRIME_AGENT_KERNEL_PYTHON) {
    const override = env.PRIME_AGENT_KERNEL_PYTHON;
    const python = resolve(/^~[\\/]/.test(override) ? join(homedir(), override.slice(2)) : override);
    // Explicit overrides are never modified in place. validate() also probes the PR2372
    // compat overlay read-only and rejects an unpatched interpreter with an actionable message.
    await validate(python, true);
    return python;
  }
  const source = join(packageDir, 'dist', 'prime-agent-runtime');
  if (!existsSync(join(source, 'pyproject.toml')))
    throw new Error(tr('server.le_runtime_python_fourni_avec_prime_agent_est_introuvable_reinsta'));
  const packages = await resolveSkillPackages(skills);
  const inputs = await Promise.all(
    [source, ...packages.map((skill) => skill.packagePath)].map(async (path) => [
      path,
      await fingerprint(path),
    ]),
  );
  const compat = await (dependencies.compatIdentity || kernelCompatIdentity)();
  const identity = createHash('sha256')
    .update(
      JSON.stringify({
        schema: SCHEMA,
        packages: PACKAGES,
        inputs,
        imports: skills.map((skill) => skill.importName).sort(),
        compat,
      }),
    )
    .digest('hex');
  const base = join(root, '.local', 'kernel-venv');
  if (readOnly || env.PRIME_STUDIO_COMPONENTS_REQUIRED === '1') {
    try {
      const marker = JSON.parse(await readFile(join(base, `${identity}.json`), 'utf8'));
      if (
        marker.schema !== SCHEMA ||
        marker.identity !== identity ||
        typeof marker.python !== 'string' ||
        !resolve(marker.python).startsWith(resolve(base) + sep)
      )
        throw new Error('missing');
      await validate(marker.python);
      return marker.python;
    } catch {
      if (signal?.aborted) throw new Error(tr('server.preparation_du_noyau_annulee'));
      if (!readOnly)
        throw new Error(
          'Terminez la configuration dans les réglages de l’application. / Finish component setup in application settings.',
        );
      return null;
    }
  }
  const jobKey = `${base}:${identity}`;
  if (jobs.has(jobKey)) return jobs.get(jobKey);
  const job = (async () => {
    await mkdir(base, { recursive: true });
    const release = await setupLock(join(root, '.local', 'kernel-setup.lock'), signal);
    try {
      const markerPath = join(base, `${identity}.json`);
      let marker;
      try {
        marker = JSON.parse(await readFile(markerPath, 'utf8'));
      } catch {
        /* Initial setup. */
      }
      if (
        marker?.schema === SCHEMA &&
        marker.identity === identity &&
        typeof marker.python === 'string' &&
        resolve(marker.python).startsWith(resolve(base) + sep) &&
        existsSync(marker.python)
      ) {
        try {
          await validate(marker.python);
          return marker.python;
        } catch {
          if (signal?.aborted) throw new Error(tr('server.preparation_du_noyau_annulee'));
          // Even a damaged generation can still be used by an existing kernel.
          // Prepare a replacement at a new path instead of mutating its files.
        }
      }
      const executable = process.platform === 'win32' ? 'uv.exe' : 'uv';
      const candidates = [
        env.PRIME_GUI_UV,
        join(homedir(), '.local', 'bin', executable),
        ...(env.PATH || process.env.PATH || '').split(delimiter).map((path) => join(path, executable)),
      ];
      const uv = env.PRIME_GUI_UV || candidates.find((path) => path && existsSync(path));
      if (!uv) throw new Error('uv est introuvable. Installez uv, puis relancez « npm run setup:runtime ».');
      const venv = join(base, `${identity.slice(0, 16)}-${randomUUID().slice(0, 8)}`);
      const python = pythonIn(venv);
      onProgress(tr('server.preparation_du_noyau_python_local'));
      await run(uv, ['venv', venv, '--python', '3.11', '--seed'], env, 300000, signal);
      onProgress(tr('server.installation_du_runtime_et_de_skills_python', { value1: skills.length }));
      await run(
        uv,
        [
          'pip',
          'install',
          '--python',
          python,
          source,
          ...packages.map((skill) => skill.packagePath),
          ...PACKAGES,
        ],
        env,
        300000,
        signal,
      );
      await (dependencies.applyCompat || applyKernelCompat)(python, { run, env, signal, onProgress });
      await validate(python);
      const contents =
        JSON.stringify(
          {
            schema: SCHEMA,
            identity,
            python,
            compat,
            skills,
            inputs,
            preparedAt: new Date().toISOString(),
          },
          null,
          2,
        ) + '\n';
      for (const path of [markerPath, join(root, '.local/kernel-ready.json')]) {
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(temp, contents);
        await rename(temp, path);
      }
      onProgress(tr('server.noyau_python_pret_runtime_et_skills_verifies', { value1: skills.length }));
      return python;
    } finally {
      await release();
    }
  })();
  jobs.set(jobKey, job);
  try {
    return await job;
  } finally {
    jobs.delete(jobKey);
  }
}
