import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, delimiter } from 'node:path';
import { ensureLocalKernel, checkCode, localKernelPython } from '../lib/kernel.mjs';
import {
  KERNEL_COMPAT_VERSION,
  KERNEL_COMPAT_SCRIPT,
  kernelCompatIdentity,
  applyKernelCompat,
  checkKernelCompat,
  externalCompatError,
} from '../lib/kernel-compat.mjs';
import { discoverCli } from '../lib/agent.mjs';

function runFile(python, args, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    execFile(python, args, { env, windowsHide: true, timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function findPython() {
  for (const command of ['python3', 'python', 'py']) {
    try {
      execFileSync(command, ['--version'], { stdio: 'pipe' });
      return command;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

const anyPython = findPython();

async function compatBlock(name) {
  const source = await readFile(KERNEL_COMPAT_SCRIPT, 'utf8');
  const marker = name + " = '''";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1);
  const end = source.indexOf("\n'''", start + marker.length);
  assert.notEqual(end, -1);
  return source.slice(start + marker.length, end);
}

test('compat identity tracks version and script content', async () => {
  const identity = await kernelCompatIdentity();
  assert.equal(identity.version, KERNEL_COMPAT_VERSION);
  assert.equal(identity.version, 'pr2372-v1');
  assert.match(identity.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await kernelCompatIdentity(), identity);
  const changed = await kernelCompatIdentity({ read: async () => 'changed' });
  assert.equal(changed.version, KERNEL_COMPAT_VERSION);
  assert.notEqual(changed.sha256, identity.sha256);
});

test('apply and check call the compat script with a bounded read-only probe', async () => {
  const calls = [];
  let progressed = 0;
  const run = async (command, args, env, timeout, signal) => {
    calls.push({ command, args, env, timeout, signal });
    return '';
  };
  await applyKernelCompat('/fake/python', {
    run,
    onProgress: () => {
      progressed += 1;
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/fake/python');
  assert.deepEqual(calls[0].args, [KERNEL_COMPAT_SCRIPT, '--json']);
  assert.equal(calls[0].env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(calls[0].timeout, 60000);
  assert.equal(progressed, 1);
  await assert.rejects(applyKernelCompat('/fake/python', {}), /execute runner required/);
  assert.equal(await checkKernelCompat('/fake/python', { run }), true);
  assert.deepEqual(calls[1].args, [KERNEL_COMPAT_SCRIPT, '--check-only', '--json']);
  const unpatched = async () => {
    const error = new Error('KERNEL_COMPAT_UNPATCHED: supported unpatched form, patch required');
    throw error;
  };
  assert.equal(await checkKernelCompat('/fake/python', { run: unpatched }), false);
  const broken = async () => {
    throw new Error('KERNEL_COMPAT_UNRECOGNIZED: weird');
  };
  await assert.rejects(checkKernelCompat('/fake/python', { run: broken }), /UNRECOGNIZED/);
});

test('external override error is actionable and never patches', () => {
  const error = externalCompatError('/fake/external python');
  assert.match(error.message, /\/fake\/external python/);
  assert.match(error.message, /PRIME_AGENT_KERNEL_PYTHON/);
  assert.match(error.message, /never modified/);
  assert.match(error.message, /--check-only/);
  assert.equal(error.message.includes('\u2014'), false);
});

test('owned compat files carry no em dashes', async () => {
  for (const path of [KERNEL_COMPAT_SCRIPT, 'lib/kernel-compat.mjs', 'test/kernel-compat.test.mjs']) {
    const full = path === KERNEL_COMPAT_SCRIPT ? path : new URL('../' + path, import.meta.url);
    let text = await readFile(full, 'utf8');
    if (path === KERNEL_COMPAT_SCRIPT) {
      for (const name of ['EXPECTED_OLD_BLOCK', 'EXPECTED_NEW_BLOCK']) {
        const marker = name + " = '''";
        const start = text.indexOf(marker);
        const end = text.indexOf("\n'''", start + marker.length);
        text = text.slice(0, start) + text.slice(end);
      }
    }
    assert.equal(text.includes('\u2014'), false, path);
  }
});

async function wiringFixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-compat-wire-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const packageDir = join(root, 'prime');
  const source = join(packageDir, 'dist/prime-agent-runtime');
  const uv = join(root, 'uv.exe');
  const calls = [];
  const installed = new Set();
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'pyproject.toml'), '[project]\nname="prime-agent-runtime"\nversion="1"');
  await writeFile(join(source, 'runtime.py'), '# runtime');
  await writeFile(uv, 'fixture');
  const deps = {
    discover: async () => ({ skills: [], diagnostics: [] }),
    ...overrides,
    async execute(command, args) {
      calls.push({ command, args });
      if (args[0] === 'venv') {
        const python = join(args[1], process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        await mkdir(dirname(python), { recursive: true });
        await writeFile(python, 'fixture python');
      } else if (args[0] === 'pip') {
        installed.add(args[args.indexOf('--python') + 1]);
      } else if (typeof args[0] === 'string' && args[0].endsWith('kernel-compat.py')) {
        assert.ok(installed.has(command), 'overlay applies to the new venv before validation');
      } else {
        assert.equal(args[0], '-c');
        return JSON.stringify({ failures: [] });
      }
      return '';
    },
  };
  const options = { root, packageDir, cwd: root, env: { PRIME_GUI_UV: uv } };
  return { root, options, deps, calls, prepare: () => ensureLocalKernel(options, deps) };
}

function callKinds(calls) {
  return calls.map((call) => {
    if (call.args[0] === 'venv' || call.args[0] === 'pip' || call.args[0] === '-c') return call.args[0];
    if (typeof call.args[0] === 'string' && call.args[0].endsWith('kernel-compat.py')) {
      return call.args.includes('--check-only') ? 'compat-check' : 'compat-apply';
    }
    return JSON.stringify(call.args[0]);
  });
}

test('new venvs apply the overlay after install and before validation, then reuse', async (t) => {
  const f = await wiringFixture(t);
  const python = await f.prepare();
  const kinds = callKinds(f.calls);
  const pip = kinds.indexOf('pip');
  const compat = kinds.indexOf('compat-apply');
  const validate = kinds.indexOf('-c');
  assert.ok(pip >= 0 && compat >= 0 && validate >= 0);
  assert.ok(pip < compat && compat < validate);
  const marker = JSON.parse(await readFile(join(f.root, '.local/kernel-ready.json'), 'utf8'));
  assert.equal(marker.compat.version, KERNEL_COMPAT_VERSION);
  assert.match(marker.compat.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(marker.compat, await kernelCompatIdentity());
  assert.equal(await f.prepare(), python);
  assert.equal(callKinds(f.calls).filter((kind) => kind === 'pip').length, 1);
  assert.equal(callKinds(f.calls).filter((kind) => kind === 'compat-apply').length, 1);
});

test('compat content change rebuilds a new generation without touching the old one', async (t) => {
  const f = await wiringFixture(t);
  const first = await f.prepare();
  const before = await readFile(first, 'utf8');
  const rotated = { version: KERNEL_COMPAT_VERSION, sha256: 'f'.repeat(64) };
  const second = await ensureLocalKernel(f.options, {
    ...f.deps,
    compatIdentity: async () => rotated,
  });
  assert.notEqual(second, first);
  assert.equal(await readFile(first, 'utf8'), before);
  const marker = JSON.parse(await readFile(join(f.root, '.local/kernel-ready.json'), 'utf8'));
  assert.deepEqual(marker.compat, rotated);
});

test('readOnly never applies the overlay and never writes', async (t) => {
  const f = await wiringFixture(t);
  assert.equal(await ensureLocalKernel({ ...f.options, readOnly: true }, f.deps), null);
  assert.equal(f.calls.length, 0);
  const python = await f.prepare();
  const markerBefore = await readFile(join(f.root, '.local/kernel-ready.json'), 'utf8');
  const compatCalls = f.calls.filter((call) => String(call.args[0]).endsWith('kernel-compat.py')).length;
  assert.equal(await ensureLocalKernel({ ...f.options, readOnly: true }, f.deps), python);
  assert.equal(await readFile(join(f.root, '.local/kernel-ready.json'), 'utf8'), markerBefore);
  assert.equal(
    f.calls.filter((call) => String(call.args[0]).endsWith('kernel-compat.py')).length,
    compatCalls,
  );
});

test('compat failure publishes no marker and leaves no lock', async (t) => {
  const f = await wiringFixture(t, {
    applyCompat: async () => {
      throw new Error('fixture compat failed');
    },
  });
  await assert.rejects(f.prepare(), /fixture compat failed/);
  assert.equal(existsSync(join(f.root, '.local/kernel-ready.json')), false);
  assert.equal(existsSync(join(f.root, '.local/kernel-setup.lock')), false);
});

test('explicit external python is never installed into nor patched', async (t) => {
  const f = await wiringFixture(t);
  const external = join(f.root, 'external python.exe');
  const options = { ...f.options, env: { ...f.options.env, PRIME_AGENT_KERNEL_PYTHON: external } };
  assert.equal(await ensureLocalKernel(options, f.deps), external);
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every((call) => call.args[0] === '-c'));
  assert.equal(existsSync(join(f.root, '.local')), false);
});

const fixtureHead =
  'import asyncio\nimport functools\nimport sys\nimport threading\nimport time\n\n\nclass BashHandle:\n';
const fixtureTail = '    async def _wait_reaped(self):\n        pass\n';

async function pythonCompile(python, path) {
  await runFile(python, ['-m', 'py_compile', path]);
}

test(
  'compat script patches fixtures, stays idempotent, refuses unknown forms',
  { skip: !anyPython },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'prime-compat-py-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const oldBlock = await compatBlock('EXPECTED_OLD_BLOCK');
    const runScript = (args) => runFile(anyPython, [KERNEL_COMPAT_SCRIPT, ...args]);
    const unpatched = join(dir, 'unpatched.py');
    await writeFile(unpatched, fixtureHead + oldBlock + fixtureTail);
    await assert.rejects(runScript(['--file', unpatched, '--check-only', '--json']), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /KERNEL_COMPAT_UNPATCHED/);
      assert.match(error.stdout, /"status": "needs-patch"/);
      return true;
    });
    const patched = await runScript(['--file', unpatched, '--json']);
    assert.match(patched.stdout, /"status": "patched"/);
    await pythonCompile(anyPython, unpatched);
    const afterPatch = await readFile(unpatched, 'utf8');
    assert.match(afterPatch, /repl\._send\(/);
    assert.equal(afterPatch.includes('async def _notify_result_consumed'), false);
    assert.match(afterPatch, /\nimport uuid\n/);
    const recheck = await runScript(['--file', unpatched, '--check-only', '--json']);
    assert.match(recheck.stdout, /"status": "already-patched"/);
    const repatch = await runScript(['--file', unpatched]);
    assert.match(repatch.stdout, /already-patched/);
    assert.equal(await readFile(unpatched, 'utf8'), afterPatch);
    const garbled = join(dir, 'garbled.py');
    const garbledText =
      fixtureHead + '    def _arm_consumed_notice(self, command):\n        pass\n' + fixtureTail;
    await writeFile(garbled, garbledText);
    await assert.rejects(runScript(['--file', garbled]), /KERNEL_COMPAT_UNRECOGNIZED/);
    assert.equal(await readFile(garbled, 'utf8'), garbledText);
    await assert.rejects(runScript(['--file', join(dir, 'missing.py')]), /KERNEL_COMPAT_UNRECOGNIZED/);
  },
);

test(
  'fixed detection tolerates cosmetic changes but rejects different withdrawal control flow',
  { skip: !anyPython },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'prime-compat-control-flow-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const newBlock = await compatBlock('EXPECTED_NEW_BLOCK');
    const head = fixtureHead.replace('import functools\n', 'import functools\nimport uuid\n');
    const cosmetic = join(dir, 'cosmetic.py');
    await writeFile(
      cosmetic,
      head +
        newBlock.replace('        repl._send(', '        # Cosmetic upstream comment\n        repl._send(') +
        fixtureTail,
    );
    await runFile(anyPython, [KERNEL_COMPAT_SCRIPT, '--file', cosmetic, '--check-only']);
    for (const [name, block] of [
      ['early-return', newBlock.replace('        repl._send(', '        return\n        repl._send(')],
      [
        'deferred-send',
        newBlock.replace('        repl._send(', '        dispatch_later = lambda: repl._send('),
      ],
    ]) {
      const file = join(dir, name + '.py');
      const source = head + block + fixtureTail;
      await writeFile(file, source);
      await assert.rejects(
        runFile(anyPython, [KERNEL_COMPAT_SCRIPT, '--file', file, '--check-only']),
        /KERNEL_COMPAT_UNRECOGNIZED/,
      );
      assert.equal(await readFile(file, 'utf8'), source);
    }
  },
);

test('compat script guarantees functools and uuid imports on every path', { skip: !anyPython }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'prime-compat-imports-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const oldBlock = await compatBlock('EXPECTED_OLD_BLOCK');
  const newBlock = await compatBlock('EXPECTED_NEW_BLOCK');
  const runScript = (args) => runFile(anyPython, [KERNEL_COMPAT_SCRIPT, ...args]);
  const headNoFunctools = fixtureHead.replace('import functools\n', '');
  const unpatched = join(dir, 'unpatched.py');
  await writeFile(unpatched, headNoFunctools + oldBlock + fixtureTail);
  await runScript(['--file', unpatched, '--json']);
  const repaired = await readFile(unpatched, 'utf8');
  assert.match(repaired, /\nimport functools\n/);
  assert.match(repaired, /\nimport uuid\n/);
  await pythonCompile(anyPython, unpatched);
  const fixedNoImports = join(dir, 'fixed.py');
  await writeFile(fixedNoImports, headNoFunctools + newBlock + fixtureTail);
  await assert.rejects(
    runScript(['--file', fixedNoImports, '--check-only', '--json']),
    /KERNEL_COMPAT_UNPATCHED/,
  );
  const result = await runScript(['--file', fixedNoImports, '--json']);
  assert.match(result.stdout, /"status": "patched"/);
  const afterRepair = await readFile(fixedNoImports, 'utf8');
  assert.match(afterRepair, /\nimport functools\n/);
  const recheck = await runScript(['--file', fixedNoImports, '--check-only', '--json']);
  assert.match(recheck.stdout, /"status": "already-patched"/);
  await pythonCompile(anyPython, fixedNoImports);
});

function engineRuntime() {
  try {
    const cli = discoverCli();
    const rlmDir = cli?.packageDir ? join(cli.packageDir, 'dist', 'prime-agent-runtime', 'src', 'rlm') : null;
    if (!rlmDir || !existsSync(join(rlmDir, 'bash.py'))) return null;
    let fullPython = null;
    try {
      const marker = localKernelPython();
      if (marker && existsSync(marker)) fullPython = marker;
    } catch {
      /* no managed kernel yet */
    }
    return { rlmDir, fullPython, protoPython: fullPython || anyPython };
  } catch {
    return null;
  }
}

const eng = engineRuntime();

test(
  'shipped probe accepts the patched tree and rejects the unpatched tree',
  { skip: !eng?.fullPython },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'prime-compat-probe-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await cp(eng.rlmDir, join(dir, 'patched', 'rlm'), { recursive: true });
    await cp(eng.rlmDir, join(dir, 'unpatched', 'rlm'), { recursive: true });
    await runFile(eng.fullPython, [
      KERNEL_COMPAT_SCRIPT,
      '--file',
      join(dir, 'patched', 'rlm', 'bash.py'),
      '--json',
    ]);
    const code = checkCode([]);
    assert.match(code, /module\.send/);
    const patchedEnv = { ...process.env, PYTHONPATH: join(dir, 'patched'), PYTHONDONTWRITEBYTECODE: '1' };
    const patchedOut = await runFile(eng.fullPython, ['-c', code], patchedEnv);
    assert.deepEqual(JSON.parse(patchedOut.stdout.trim().split(/\r?\n/).at(-1)).failures, []);
    const unpatchedEnv = { ...process.env, PYTHONPATH: join(dir, 'unpatched'), PYTHONDONTWRITEBYTECODE: '1' };
    const unpatchedOut = await runFile(eng.fullPython, ['-c', code], unpatchedEnv);
    const failures = JSON.parse(unpatchedOut.stdout.trim().split(/\r?\n/).at(-1)).failures;
    const compat = failures.filter((failure) => failure.name === 'kernel-compat-pr2372');
    assert.equal(compat.length, 1);
    assert.equal(compat[0].kind, 'runtime');
    assert.match(compat[0].error, /PRIME_AGENT_KERNEL_PYTHON/);
  },
);

const syncProbe = [
  'import asyncio, importlib, sys, threading',
  'sys.path.insert(0, sys.argv[1])',
  "b = importlib.import_module('rlm.bash')",
  "r = importlib.import_module('rlm.repl')",
  'frames = []',
  'r._send = frames.append',
  'r.is_active = lambda: True',
  'b._live_cell_owner = lambda: object()',
  'h = object.__new__(b.BashHandle)',
  'h._pid = 4242',
  'h._done = threading.Event(); h._done.set()',
  'h._callback_lock = threading.Lock()',
  'h._result_consumed = False',
  'h._consumed_notice = None',
  "h._arm_consumed_notice('sync-probe')",
  'h._note_result_consumed()',
  'assert len(frames) == 1, frames',
  'f = frames[0]',
  "assert f['event'] == 'host_request', f",
  "assert f['data']['type'] == 'bash.consumed', f",
  "assert f['data']['pid'] == 4242 and f['data']['command'] == 'sync-probe', f",
  "print('SYNC_WITHDRAWAL_OK ' + f['id'][:8])",
].join('\n');

test(
  'patched runtime ships bash.consumed synchronously with no event loop',
  { skip: !eng?.protoPython },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'prime-compat-sync-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await cp(eng.rlmDir, join(dir, 'patched', 'rlm'), { recursive: true });
    await cp(eng.rlmDir, join(dir, 'unpatched', 'rlm'), { recursive: true });
    const patchedBash = join(dir, 'patched', 'rlm', 'bash.py');
    await runFile(eng.protoPython, [KERNEL_COMPAT_SCRIPT, '--file', patchedBash, '--json']);
    const probePath = join(dir, 'probe.py');
    await writeFile(probePath, syncProbe);
    const ok = await runFile(eng.protoPython, [probePath, join(dir, 'patched')]);
    assert.match(ok.stdout, /SYNC_WITHDRAWAL_OK/);
    const before = await readFile(patchedBash, 'utf8');
    const again = await runFile(eng.protoPython, [KERNEL_COMPAT_SCRIPT, '--file', patchedBash, '--json']);
    assert.match(again.stdout, /"status": "already-patched"/);
    assert.equal(await readFile(patchedBash, 'utf8'), before);
    const stillOk = await runFile(eng.protoPython, [probePath, join(dir, 'patched')]);
    assert.match(stillOk.stdout, /SYNC_WITHDRAWAL_OK/);
    await assert.rejects(runFile(eng.protoPython, [probePath, join(dir, 'unpatched')]), (error) => {
      assert.match(error.stderr, /no running event loop/);
      return true;
    });
  },
);
