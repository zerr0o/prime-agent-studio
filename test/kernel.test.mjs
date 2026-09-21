import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { ensureLocalKernel, localKernelPython } from '../lib/kernel.mjs';
import { discoverPythonSkills, resolveSkillPackages } from '../lib/kernel-skills.mjs';
import { discoverCli, agentEnvironment } from '../lib/agent.mjs';
import { transformKernelBootstrap } from '../runtime/kernel-hook.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-kernel é espaces-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const packageDir = join(root, 'prime'),
    source = join(packageDir, 'dist/prime-agent-runtime');
  const uv = join(root, 'uv.exe'),
    skills = [],
    calls = [],
    installed = new Set(),
    broken = new Set();
  let failInstall = false;
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'pyproject.toml'), '[project]\nname="prime-agent-runtime"\nversion="1"');
  await writeFile(join(source, 'runtime.py'), '# runtime');
  await writeFile(uv, 'fixture');
  async function skill(name, dependencies = [], directory = join(root, 'skills', name)) {
    const importName = name.replaceAll('-', '_');
    await mkdir(join(directory, 'src', importName), { recursive: true });
    await writeFile(join(directory, 'src', importName, '__init__.py'), 'def send(): pass\n');
    await writeFile(
      join(directory, 'pyproject.toml'),
      `[project]\nname=${JSON.stringify(name)}\nversion="1"\ndependencies=${JSON.stringify(dependencies)}\n`,
    );
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill.\n---\nTest.`);
    const info = {
      name,
      importName,
      packagePath: directory,
      pyprojectPath: join(directory, 'pyproject.toml'),
    };
    skills.push(info);
    return info;
  }
  await skill('agent-message');
  const deps = {
    discover: async () => ({ skills, diagnostics: [] }),
    async execute(command, args) {
      calls.push({ command, args });
      if (args[0] === 'venv') {
        const python = join(args[1], process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        await mkdir(dirname(python), { recursive: true });
        await writeFile(python, 'fixture python');
      } else if (args[0] === 'pip') {
        if (failInstall) throw new Error('fixture install failed');
        installed.add(args[args.indexOf('--python') + 1]);
      } else if (typeof args[0] === 'string' && args[0].endsWith('kernel-compat.py')) {
        assert.ok(installed.has(command), 'compat overlay applies to the new venv before validation');
      } else {
        assert.equal(args[0], '-c');
        assert.match(args[1], /module\.send/);
        return JSON.stringify({
          failures:
            installed.has(command) && !broken.has(command)
              ? []
              : [
                  {
                    kind: 'skill',
                    name: 'agent_message',
                    error: 'ModuleNotFoundError: No module named agent_message',
                  },
                ],
        });
      }
      return '';
    },
  };
  const options = { root, packageDir, cwd: root, env: { PRIME_GUI_UV: uv } };
  return {
    root,
    source,
    options,
    deps,
    calls,
    skills,
    skill,
    installed,
    broken,
    prepare: () => ensureLocalKernel(options, deps),
    failInstall: (value) => {
      failInstall = value;
    },
  };
}

test('fresh setup installs runtime and local skills together, then validates imports without reinstalling', async (t) => {
  const f = await fixture(t),
    python = await f.prepare();
  const install = f.calls.find((call) => call.args[0] === 'pip');
  assert.ok(install.args.includes(f.source));
  assert.ok(install.args.includes(f.skills[0].packagePath));
  assert.equal(install.args[install.args.indexOf('--python') + 1], python);
  assert.equal(await f.prepare(), python);
  assert.equal(f.calls.filter((call) => call.args[0] === 'pip').length, 1);
  assert.equal(f.calls.filter((call) => call.args[0] === '-c').length, 2);
  const marker = JSON.parse(await readFile(join(f.root, '.local/kernel-ready.json'), 'utf8'));
  assert.equal(marker.schema, 2);
  assert.equal(marker.skills[0].importName, 'agent_message');
  assert.equal(localKernelPython(f.root), python);
});

test('diagnosis never creates a kernel, and a skipped desktop setup never installs implicitly', async (t) => {
  const f = await fixture(t);
  assert.equal(await ensureLocalKernel({ ...f.options, readOnly: true }, f.deps), null);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(join(f.root, '.local/kernel-ready.json')), { code: 'ENOENT' });
  await assert.rejects(
    ensureLocalKernel(
      { ...f.options, env: { ...f.options.env, PRIME_STUDIO_COMPONENTS_REQUIRED: '1' } },
      f.deps,
    ),
    /Finish component setup/,
  );
  assert.equal(f.calls.length, 0);
  const python = await f.prepare();
  const before = await readFile(join(f.root, '.local/kernel-ready.json'), 'utf8');
  assert.equal(await ensureLocalKernel({ ...f.options, readOnly: true }, f.deps), python);
  assert.equal(await readFile(join(f.root, '.local/kernel-ready.json'), 'utf8'), before);
  assert.equal(f.calls.filter((c) => c.args[0] === 'pip').length, 1);
});

test('legacy ready marker and a damaged generation are repaired without mutating either Python', async (t) => {
  const f = await fixture(t),
    legacy = localKernelPython(f.root);
  await mkdir(dirname(legacy), { recursive: true });
  await writeFile(legacy, 'legacy runtime, no skills');
  await writeFile(
    join(f.root, '.local/kernel-ready.json'),
    JSON.stringify({ identity: 'legacy', python: legacy }),
  );
  const repaired = await f.prepare();
  assert.notEqual(repaired, legacy);
  assert.equal(await readFile(legacy, 'utf8'), 'legacy runtime, no skills');
  f.broken.add(repaired);
  const replacement = await f.prepare();
  assert.notEqual(replacement, repaired);
  assert.equal(await readFile(repaired, 'utf8'), 'fixture python');
});

test('skill dependency changes and source changes produce new validated generations', async (t) => {
  const f = await fixture(t),
    first = await f.prepare();
  await appendFile(f.skills[0].pyprojectPath, '\nrequires-python=">=3.11"\n');
  const second = await f.prepare();
  assert.notEqual(second, first);
  await appendFile(join(f.skills[0].packagePath, 'src/agent_message/__init__.py'), '# changed\n');
  assert.notEqual(await f.prepare(), second);
});

test('local dependency closure resolves siblings and cycles in one transaction rather than registry homonyms', async (t) => {
  const f = await fixture(t);
  const parent = await f.skill('primary', ['Helper_Package>=1; python_version >= "3.11"']);
  const helper = await f.skill('helper-package', ['primary>=1']);
  f.skills.splice(f.skills.indexOf(helper), 1);
  await f.prepare();
  const args = f.calls.find((call) => call.args[0] === 'pip').args;
  assert.ok(args.includes(parent.packagePath));
  assert.ok(args.includes(helper.packagePath));
  assert.equal(args.includes('helper-package'), false);
  const duplicate = { ...helper, packagePath: join(f.root, 'duplicate-helper') };
  await mkdir(duplicate.packagePath);
  await writeFile(join(duplicate.packagePath, 'pyproject.toml'), '[project]\nname="helper_package"');
  await assert.rejects(resolveSkillPackages([helper, duplicate]), /même nom/);
});

test('failed installation never publishes readiness and a later attempt succeeds', async (t) => {
  const f = await fixture(t);
  f.failInstall(true);
  await assert.rejects(f.prepare(), /fixture install failed/);
  assert.equal(existsSync(join(f.root, '.local/kernel-ready.json')), false);
  assert.equal(existsSync(join(f.root, '.local/kernel-setup.lock')), false);
  f.failInstall(false);
  assert.ok(await f.prepare());
});

test('unrelated broken sibling packages are ignored, but broken local dependencies never fall back to a registry', async (t) => {
  const f = await fixture(t),
    parent = await f.skill('primary', ['external-package']);
  const ignored = join(f.root, 'skills', 'disabled-skill');
  await mkdir(ignored);
  await writeFile(join(ignored, 'pyproject.toml'), 'not valid toml');
  assert.ok(await resolveSkillPackages([parent]));
  await writeFile(parent.pyprojectPath, '[project]\nname="primary"\ndependencies=["disabled-skill"]');
  await assert.rejects(resolveSkillPackages([parent]), /pyproject.toml invalide/);
});

test('simultaneous preparations in Windows paths with spaces share one installation', async (t) => {
  const f = await fixture(t);
  const paths = await Promise.all([f.prepare(), f.prepare(), f.prepare()]);
  assert.equal(new Set(paths).size, 1);
  assert.equal(f.calls.filter((call) => call.args[0] === 'pip').length, 1);
});

test('explicit external Python receives diagnostics and is never installed into', async (t) => {
  const f = await fixture(t),
    python = join(f.root, 'external python.exe');
  const options = { ...f.options, env: { ...f.options.env, PRIME_AGENT_KERNEL_PYTHON: python } };
  await assert.rejects(ensureLocalKernel(options, f.deps), (error) => {
    assert.ok(error.message.includes(python));
    assert.match(error.message, /fonction essentielle.*agent_message.*ModuleNotFoundError/);
    return true;
  });
  f.installed.add(python);
  assert.equal(await ensureLocalKernel(options, f.deps), python);
  assert.ok(f.calls.every((call) => call.args[0] === '-c'));
  assert.equal(existsSync(join(f.root, '.local')), false);
  const warnings = [];
  assert.equal(
    await ensureLocalKernel(
      { ...options, onProgress: (message) => warnings.push(message) },
      {
        ...f.deps,
        execute: async () =>
          JSON.stringify({
            failures: [{ kind: 'skill', name: 'optional_skill', error: 'optional missing' }],
          }),
      },
    ),
    python,
  );
  assert.match(warnings[0], /skill optionnelle.*optional_skill/);
});

test('native bootstrap adapter requires an exact supported entry point and leaves unrelated code alone', () => {
  assert.equal(transformKernelBootstrap('export const unrelated = 1;').changed, false);
  assert.throws(() => transformKernelBootstrap('unsupported', { required: true }), /mise à jour/);
  const source = 'export function ensureKernelPython(options = {}) { return "native"; }';
  assert.match(
    transformKernelBootstrap(source, { required: true }).source,
    /return studioPrepareKernel\(options\)/,
  );
  assert.throws(() => transformKernelBootstrap(source + source), /mise à jour/);
});

const cli = discoverCli();
test(
  'installed native discovery honors project overrides, disabled builtins and configured skill paths',
  { skip: !cli?.packageDir },
  async (t) => {
    const f = await fixture(t),
      agentHome = join(f.root, 'agent');
    await mkdir(agentHome);
    const override = await f.skill('agent-message', [], join(f.root, '.prime/agent/skills/agent-message'));
    const configured = await f.skill('configured-skill');
    await writeFile(
      join(agentHome, 'settings.json'),
      JSON.stringify({ bundledSkills: { websearch: false }, skills: [configured.packagePath] }),
    );
    const result = await discoverPythonSkills({
      packageDir: cli.packageDir,
      cwd: f.root,
      agentHome,
      env: agentEnvironment({ agentHome }),
    });
    assert.equal(
      result.skills.find((skill) => skill.importName === 'agent_message')?.packagePath,
      override.packagePath,
    );
    assert.ok(result.skills.some((skill) => skill.importName === 'configured_skill'));
    assert.equal(
      result.skills.some((skill) => skill.importName === 'websearch'),
      false,
    );
    const native = await readFile(join(cli.packageDir, 'dist/core/kernel/bootstrap.js'), 'utf8');
    assert.equal(transformKernelBootstrap(native, { required: true }).changed, true);
    const bundleDir = join(cli.packageDir, 'dist/bundle');
    let changed = 0;
    for (const name of await readdir(bundleDir))
      if (name.endsWith('.js'))
        changed += Number(transformKernelBootstrap(await readFile(join(bundleDir, name), 'utf8')).changed);
    assert.equal(changed, 1);
  },
);
