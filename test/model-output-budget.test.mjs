import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverCli } from '../lib/agent.mjs';
import {
  BUDGET_MARKER,
  transformModelOutputBudget,
  initialize as initBudget,
  load as budgetLoad,
} from '../runtime/model-output-budget.mjs';

const LEGACY_LINE =
  'maxTokens: options?.maxTokens ?? (model.maxTokens > 0 ? Math.min(model.maxTokens, 32e3) : void 0),';
const PATCHED_LINE = `maxTokens: options?.maxTokens ?? (model.maxTokens > 0 ? model.maxTokens : void 0) ${BUDGET_MARKER},`;

function fixtureSource(legacyLine = LEGACY_LINE) {
  return `function buildBaseOptions(model, options, apiKey) {\n  return {\n    ${legacyLine}\n  };\n}\n`;
}

function buildFn(source) {
  const match = source.match(/function buildBaseOptions\(model, options, apiKey\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'fixture should contain buildBaseOptions');
  const bodyStart = match[0].indexOf('{');
  const body = match[0].slice(bodyStart + 1, match[0].lastIndexOf('}'));
  return new Function('model', 'options', 'apiKey', body);
}

// Engine-dependent: returns null on CI without the installed native engine
// so pure tests never require it. Real-helper proof lives in
// scripts/test-model-output-budget-native.mjs; the last test below skips.
async function maybeEngineHelper() {
  let cli;
  try {
    cli = discoverCli();
  } catch {
    return null;
  }
  if (!cli?.packageDir) return null;
  let names;
  try {
    names = (await readdir(join(cli.packageDir, 'dist', 'bundle'))).filter((name) => name.endsWith('.js'));
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const text = await readFile(join(cli.packageDir, 'dist', 'bundle', name), 'utf8');
      if (text.includes('function buildBaseOptions('))
        return { cli, path: join(cli.packageDir, 'dist', 'bundle', name), text };
    } catch {}
  }
  return null;
}

function runNode(args, env, timeoutMs = 30000) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      args,
      { env, windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`node probe failed: ${error.message}\n${stderr}`));
        else resolvePromise({ stdout, stderr });
      },
    );
  });
}

test('transform leaves unrelated sources untouched', () => {
  assert.deepEqual(transformModelOutputBudget('export const unrelated = 1;'), {
    source: 'export const unrelated = 1;',
    changed: false,
  });
});

test('transform fails closed on unknown layouts when required', () => {
  assert.throws(
    () => transformModelOutputBudget('export function buildBaseOptions() { return {}; }', { required: true }),
    /Model output budget layout changed/,
  );
  assert.throws(
    () => transformModelOutputBudget(fixtureSource(LEGACY_LINE).replace('32e3', '99999'), { required: true }),
    /Model output budget layout changed/,
  );
});

test('marker-only partial patch fails closed', () => {
  const partial = fixtureSource(LEGACY_LINE).replace('void 0),', `void 0) ${BUDGET_MARKER},`);
  assert.throws(() => transformModelOutputBudget(partial, { required: true }), /layout changed/);
  assert.throws(() => transformModelOutputBudget(`${fixtureSource()}${fixtureSource()}`), /layout changed/);
});

test('patched helper: default follows model, explicit and invalid limits preserved', () => {
  const out = transformModelOutputBudget(fixtureSource());
  assert.equal(out.changed, true);
  const fn = buildFn(out.source);
  // Default 128000 (legacy code capped this at 32000).
  assert.equal(fn({ maxTokens: 128000 }, {}, 'k').maxTokens, 128000);
  // Explicit options.maxTokens (including 512) always wins.
  assert.equal(fn({ maxTokens: 128000 }, { maxTokens: 512 }, 'k').maxTokens, 512);
  // Small model limit passes through unchanged.
  assert.equal(fn({ maxTokens: 4096 }, {}, 'k').maxTokens, 4096);
  // Unknown/nonpositive model limits fall back to undefined.
  for (const maxTokens of [0, -1, undefined, null]) {
    assert.equal(fn({ maxTokens }, {}, 'k').maxTokens, undefined);
  }
});

test('transform supports the 32000 spelling and is narrow and idempotent', () => {
  for (const line of [LEGACY_LINE, LEGACY_LINE.replace('32e3', '32000')]) {
    const fixture = fixtureSource(line);
    const out = transformModelOutputBudget(fixture);
    assert.equal(out.changed, true);
    assert.ok(out.source.includes(PATCHED_LINE));
    assert.equal(out.source.split(BUDGET_MARKER).length - 1, 1, 'should patch exactly once');
    assert.equal(out.source.replace(PATCHED_LINE, line), fixture, 'diff should be narrow');
    const again = transformModelOutputBudget(out.source);
    assert.equal(again.changed, false);
    assert.equal(again.source, out.source);
  }
});

test('loader scopes the patch to the native package and leaves other modules intact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-budget-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const text = fixtureSource();
  initBudget({ packageRoot: root });
  const bundleUrl = pathToFileURL(join(root, 'dist/bundle/chunk-TEST.js')).href;
  const outsideUrl = pathToFileURL(join(resolve(root, '..'), 'other/dist/bundle/chunk-TEST.js')).href;
  const readModule = (content) => async () => ({ format: 'module', source: Buffer.from(content) });

  const patched = await budgetLoad(bundleUrl, {}, readModule(text));
  assert.ok(String(patched.source).includes(BUDGET_MARKER));

  const skippedNoHelper = await budgetLoad(bundleUrl, {}, readModule('export const provider = 1;'));
  assert.equal(String(skippedNoHelper.source), 'export const provider = 1;');

  const skippedOutside = await budgetLoad(outsideUrl, {}, readModule(text));
  assert.equal(String(skippedOutside.source), text);

  const skippedRpc = await budgetLoad(
    pathToFileURL(join(root, 'dist/modes/rpc/rpc-mode.js')).href,
    {},
    readModule(text),
  );
  assert.equal(String(skippedRpc.source), text);

  const nonModule = await budgetLoad(bundleUrl, {}, async () => ({ format: 'commonjs', source: text }));
  assert.equal(nonModule.source, text);

  const unbundledUrl = pathToFileURL(join(root, 'ai/src/providers/simple-options.ts')).href;
  await assert.rejects(
    budgetLoad(unbundledUrl, {}, readModule('export const broken = 1;')),
    /Model output budget layout changed/,
  );

  const patchedString = await budgetLoad(bundleUrl, {}, async () => ({ format: 'module', source: text }));
  assert.ok(String(patchedString.source).includes(BUDGET_MARKER));

  // Foreign package content is never rewritten by the transform itself.
  assert.equal(transformModelOutputBudget('export const foreign = 1;').changed, false);
});

test('loader rejects foreign unbundled paths outside the native package', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-budget-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  initBudget({ packageRoot: root });
  const readModule = (content) => async () => ({ format: 'module', source: Buffer.from(content) });
  const foreignUrl = pathToFileURL(
    join(resolve(root, '..'), 'other/ai/src/providers/simple-options.ts'),
  ).href;
  const skipped = await budgetLoad(foreignUrl, {}, readModule(fixtureSource()));
  assert.equal(String(skipped.source), fixtureSource(), 'foreign ../ unbundled must pass through untouched');
  const foreignJs = pathToFileURL(join(resolve(root, '..'), 'foreign-simple-options.js')).href.replace(
    'foreign-simple-options.js',
    'simple-options.js',
  );
  const skippedJs = await budgetLoad(foreignJs, {}, readModule(fixtureSource()));
  assert.equal(
    String(skippedJs.source),
    fixtureSource(),
    'foreign ../ simple-options.js must pass through untouched',
  );
});

test('loader rejects absolute paths from another drive (Windows)', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows drive-letter scope only');
  const root = await mkdtemp(join(tmpdir(), 'prime-budget-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  initBudget({ packageRoot: root });
  const drive = resolve(root)[0].toLowerCase();
  const other = drive === 'c' ? 'd' : 'c';
  const foreignUrl = pathToFileURL(`${other}:\\foreign\\ai\\src\\providers\\simple-options.ts`).href;
  const readModule = (content) => async () => ({ format: 'module', source: Buffer.from(content) });
  const skipped = await budgetLoad(foreignUrl, {}, readModule(fixtureSource()));
  assert.equal(String(skipped.source), fixtureSource(), 'other-drive absolute must pass through untouched');
});

test('session-preferences loader shares the native scope with the budget hook', async () => {
  const text = await readFile(resolve('runtime/session-preferences-loader.mjs'), 'utf8');
  assert.ok(text.includes('./model-output-budget.mjs'), 'loader should register the budget hook');
  assert.ok(text.includes('./session-quiescence.mjs'), 'loader should keep the quiescence hook');
  assert.ok(text.includes('./session-preferences.mjs'), 'loader should keep the preferences hook');
});

test('installed native helper under the loader defaults to model.maxTokens (isolated + inherited child)', async (t) => {
  const eng = await maybeEngineHelper();
  if (!eng)
    return t.skip(
      'installed native engine not discoverable (CI); see scripts/test-model-output-budget-native.mjs',
    );
  const { cli, path, text } = eng;
  assert.ok(
    text.includes('Math.min(model.maxTokens, 32e3)'),
    'engine should still carry the legacy cap on disk',
  );
  const loaderHref = pathToFileURL(resolve('runtime/session-preferences-loader.mjs')).href;
  const chunkHref = pathToFileURL(path).href;
  const env = {
    ...process.env,
    PRIME_STUDIO_SESSION_PACKAGE: cli.packageDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import="${loaderHref}"`.trim(),
  };
  const parentCode = [
    `const chunk = ${JSON.stringify(chunkHref)};`,
    'const mod = await import(chunk);',
    "const own = mod.buildBaseOptions({ maxTokens: 128000 }, {}, 'k').maxTokens;",
    "const explicit = mod.buildBaseOptions({ maxTokens: 128000 }, { maxTokens: 512 }, 'k').maxTokens;",
    'const { execFileSync } = await import("node:child_process");',
    'const childCode = "import(" + JSON.stringify(chunk) + ").then((m) => { console.log(JSON.stringify({ child: m.buildBaseOptions({ maxTokens: 128000 }, {}, \'k\').maxTokens })); });";',
    'const childOut = execFileSync(process.execPath, ["--input-type=module", "-e", childCode], { encoding: "utf8" });',
    'console.log(JSON.stringify({ own, explicit, child: JSON.parse(childOut).child }));',
  ].join('\n');
  const { stdout } = await runNode(['--input-type=module', '-e', parentCode], env);
  const line = stdout.trim().split('\n').pop();
  assert.deepEqual(JSON.parse(line), { own: 128000, explicit: 512, child: 128000 });
});
