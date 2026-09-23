// Positive Node-parented CUA job adoption probe (dev validation only).
//
// Spawns a private fixture AND the native worker -JobAdoptProbe mode, so the
// fixture parent equals the worker parent (this Node process): production
// Add-CuaJobAdopt runs FOR REAL (exact image, live Node parent, birth
// boundary, private socket nonce on the opened handle, assign on that same
// handle, alive recheck), plus kill-to-verified-zero. --mode=nested
// pre-assigns the fixture to a benign outer job inside the probe first.
//
// Guarantees: repo-relative worker/evidence paths only; exact private
// process ownership (only the recorded fixture pid and the owned worker
// child are ever signalled, never broad kills); bounded timers with
// finally cleanup; no desktop, no hotkey, no real mutex, no CUA runtime.
//
// Exact commands (from the repo root, Windows):
//   node scripts/test-cua-job-adoption.mjs --mode=direct
//   node scripts/test-cua-job-adoption.mjs --mode=nested
//   node scripts/test-cua-job-adoption.mjs --mode=both
// Evidence logs land in test-results/cua-integration/adopt-harness-<mode>.log
// (ignored proof dir; the earlier proof logs stay untouched).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worker = join(root, 'runtime', 'computer-use-worker.ps1');
const evidenceDir = join(root, 'test-results', 'cua-integration');

const modeArg = (process.argv.find((a) => a.startsWith('--mode=')) || '').slice('--mode='.length);
const mode = modeArg || 'both';
if (!['direct', 'nested', 'both'].includes(mode)) {
  console.error('usage: node scripts/test-cua-job-adoption.mjs --mode=direct|nested|both');
  process.exit(2);
}
const modes = mode === 'both' ? ['direct', 'nested'] : [mode];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runBounded(cmd, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let child;
    try {
      child = spawn(cmd, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ exit: null, output: '', why: String(error?.message || error) });
      return;
    }
    const finish = (exit, why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exit, output: out, why });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(null, 'timeout');
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout?.on('data', (c) => {
      out += String(c);
      if (out.length > 65536) out = out.slice(-65536);
    });
    child.stderr?.on('data', (c) => {
      out += String(c);
      if (out.length > 65536) out = out.slice(-65536);
    });
    child.on('exit', (exitCode) => finish(exitCode, 'exit'));
    child.on('error', (error) => finish(null, String(error?.message || error)));
  });
}

async function runMode(kind) {
  const outer = kind === 'nested';
  const sockNonce = `sockprobe-${process.pid}-${kind}`;
  const jobNonce = `adoptprobe-${process.pid}-${outer ? 'outer001' : 'direct01'}`;
  const lines = [];
  const note = (line) => {
    lines.push(line);
    console.log(`[${kind}] ${line}`);
  };
  let failed = 0;
  const check = (name, cond) => {
    note(`${cond ? 'PASS' : 'FAIL'} ${name}`);
    if (!cond) failed += 1;
  };
  // Sibling fixture with actual Node parentage. Normal spawn is proven to
  // run; the nonce rides argv so the worker CIM check can see it.
  const fixture = spawn(process.execPath, ['-e', 'setTimeout(function(){},45000)', sockNonce], {
    stdio: ['ignore', 'ignore', 'ignore'],
    shell: false,
    windowsHide: true,
  });
  const fixturePid = fixture.pid;
  const birthMs = Date.now();
  fixture.on('error', () => {});
  note(`fixture pid=${fixturePid} nonce=${sockNonce}`);
  try {
    assert.ok(Number.isInteger(fixturePid) && fixturePid > 0, 'fixture spawned');
    await sleep(900);
    check('fixture-alive', alive(fixturePid));
    const workerEnv = {
      ...process.env,
      JOBPROBE_JOBNONCE: jobNonce,
      JOBPROBE_PID: String(fixturePid),
      JOBPROBE_EXE: process.execPath,
      JOBPROBE_BIRTH: String(birthMs),
      JOBPROBE_NONCE: sockNonce,
      JOBPROBE_PARENTPID: String(process.pid),
      ...(outer ? { JOBPROBE_OUTER: '1' } : {}),
    };
    const probed = await runBounded(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', worker, '-JobAdoptProbe'],
      { env: workerEnv, timeoutMs: 90000 },
    );
    note('--- worker output ---');
    for (const line of probed.output.split(/\r?\n/).slice(-40)) note(line);
    note('--- end worker output ---');
    check('probe-exit-0', probed.exit === 0);
    check('probe-done-clean', /TEST-DONE failed=0/.test(probed.output));
    check('probe-adopted', /TEST-PASS probe-adopted/.test(probed.output));
    check('probe-member', /TEST-PASS probe-member/.test(probed.output));
    check('probe-killed', /TEST-PASS probe-killed/.test(probed.output));
    check('probe-fixture-gone', /TEST-PASS probe-fixture-gone/.test(probed.output));
    if (outer) check('probe-outer-made', /TEST-PASS probe-outer-made/.test(probed.output));
    check('probe-no-fail', !/TEST-FAIL/.test(probed.output));
    if (alive(fixturePid)) {
      try {
        process.kill(fixturePid);
      } catch {}
      check('harness-fixture-reaped', false);
    } else {
      check('harness-fixture-reaped', true);
    }
  } finally {
    try {
      if (alive(fixturePid)) process.kill(fixturePid);
    } catch {}
  }
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, `adopt-harness-${kind}.log`), lines.join('\n') + '\n', 'utf8');
  return failed;
}

let total = 0;
for (const kind of modes) total += await runMode(kind);
if (total > 0) {
  console.error(`DONE failed=${total}`);
  process.exit(1);
}
console.log('DONE failed=0');
