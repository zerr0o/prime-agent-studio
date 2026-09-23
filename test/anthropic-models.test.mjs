import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ANTHROPIC_OPUS_55,
  ANTHROPIC_CLAUDE_CODE_CLIENT_VERSION,
  registerStudioModelSupport,
} from '../lib/studio-models.mjs';
import { transformStudioModelSupport, studioModelSourceKind } from '../runtime/studio-models-hook.mjs';
import { discoverCli } from '../lib/agent.mjs';
import { createNativeModelCatalog } from '../lib/native-model-catalog.mjs';

const loop = 'for (const [provider, models] of Object.entries(MODELS)) {';
const catalogSource = (models) => `
const MODELS = ${JSON.stringify(models)};
const modelRegistry = new Map();
${loop}
  modelRegistry.set(provider, new Map(Object.entries(models)));
}
globalThis.result = Object.fromEntries(modelRegistry.get('anthropic'));
`;

test('Opus 5.5 is additive, idempotent and does not replace newer native metadata', () => {
  const legacy = { id: 'claude-opus-5', name: 'Existing model' };
  const source = catalogSource({ anthropic: { 'claude-opus-5': legacy } });
  const transformed = transformStudioModelSupport(source, { catalog: true });
  assert.equal(transformStudioModelSupport(transformed, { catalog: true }), transformed);
  const context = {};
  runInNewContext(transformed, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), {
    'claude-opus-5': legacy,
    'claude-opus-5-5': ANTHROPIC_OPUS_55,
  });
  const upstream = { ...ANTHROPIC_OPUS_55, name: 'Upstream definition', maxTokens: 64000 };
  const updated = {};
  runInNewContext(
    transformStudioModelSupport(catalogSource({ anthropic: { [upstream.id]: upstream } })),
    updated,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(updated.result[upstream.id])), upstream);
});

test('compatibility transforms stay scoped and fail clearly on unsupported native shapes', () => {
  assert.equal(
    transformStudioModelSupport('export const unrelated = true;'),
    'export const unrelated = true;',
  );
  assert.throws(() => transformStudioModelSupport('unknown', { catalog: true }), /requires an update/);
  assert.throws(() => transformStudioModelSupport('unknown', { adapter: true }), /requires an update/);
  assert.throws(() => transformStudioModelSupport(`${loop} } ${loop} }`), /requires an update/);
  assert.equal(studioModelSourceKind('node_modules/@earendil-works/pi-ai/dist/models.js').catalog, true);
  assert.equal(
    studioModelSourceKind('node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js').adapter,
    true,
  );
  assert.equal(studioModelSourceKind('dist/bundle/chunk-TEST.js').bundle, true);
  assert.deepEqual(studioModelSourceKind('../other/dist/models.js'), {
    catalog: false,
    adapter: false,
    registry: false,
    bundle: false,
  });
});

const thinkingFixture = 'function isAlwaysOnAdaptiveThinkingModel(modelId) { return false; }';

test('Claude Code identity floor is idempotent and never downgrades newer engines', () => {
  assert.equal(ANTHROPIC_CLAUDE_CODE_CLIENT_VERSION, '2.1.280');
  for (const declaration of ['const', 'var']) {
    for (const quote of ['"', "'"]) {
      for (const [version, expected] of [
        ['1.99.999', '2.1.280'],
        ['2.0.999', '2.1.280'],
        ['2.1.261', '2.1.280'],
        ['2.1.279', '2.1.280'],
        ['2.1.280', '2.1.280'],
        ['2.1.300', '2.1.300'],
        ['2.2.0', '2.2.0'],
        ['2.10.0', '2.10.0'],
        ['3.0.0', '3.0.0'],
      ]) {
        const source = `${declaration} claudeCodeVersion = ${quote}${version}${quote};\n${thinkingFixture}\nglobalThis.version = claudeCodeVersion;`;
        const kind = declaration === 'const' ? { adapter: true } : { bundle: true };
        const transformed = transformStudioModelSupport(source, kind);
        const context = {};
        runInNewContext(transformed, context);
        assert.equal(context.version, expected);
        assert.equal(transformStudioModelSupport(transformed, kind), transformed);
        assert.ok(transformed.includes(`${quote}${expected}${quote}`));
      }
    }
  }
});

test('Claude Code identity adapter fails explicitly on changed or ambiguous native layouts', () => {
  for (const kind of [{ adapter: true }, { bundle: true }]) {
    for (const declaration of [
      '',
      'const claudeCodeVersion = "2.1";',
      'const claudeCodeVersion = getVersion();',
      'var claudeCodeVersion = "2.1.261"; var claudeCodeVersion = "2.1.280";',
    ]) {
      assert.throws(
        () => transformStudioModelSupport(`${declaration}\n${thinkingFixture}`, kind),
        /Studio Claude Code version adapter requires an update/,
      );
    }
  }
  const unrelated = 'export const unrelated = "2.1.261";';
  assert.equal(transformStudioModelSupport(unrelated, { bundle: true }), unrelated);
});

async function nativeParts(t) {
  const cli = discoverCli();
  if (!cli?.packageDir) {
    t.skip('Prime Agent engine unavailable');
    return null;
  }
  registerStudioModelSupport(cli.packageDir);
  const load = (path) => import(pathToFileURL(join(cli.packageDir, path)).href);
  const [models, auth, registry, adapter] = await Promise.all([
    load('node_modules/@earendil-works/pi-ai/dist/models.js'),
    load('dist/core/auth-storage.js'),
    load('dist/core/model-registry.js'),
    load('node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js'),
  ]);
  return { cli, ...models, ...auth, ...registry, ...adapter };
}

async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prime-studio-opus-55-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('native registry exposes Opus 5.5 with existing auth and honors model overrides', async (t) => {
  const native = await nativeParts(t);
  if (!native) return;
  const auth = native.AuthStorage.inMemory(
    { anthropic: { type: 'api_key', key: 'test-only-key' } },
    { usePrimeCliConfig: false },
  );
  const registry = native.ModelRegistry.inMemory(auth);
  const model = registry.find('anthropic', ANTHROPIC_OPUS_55.id);
  assert.deepEqual(model, ANTHROPIC_OPUS_55);
  assert.ok(registry.find('anthropic', 'claude-opus-5'));
  assert.ok(registry.getAvailable().some((item) => item.id === model.id && item.provider === 'anthropic'));
  assert.deepEqual(native.getSupportedThinkingLevels(model), [
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assert.equal(native.clampThinkingLevel(model, 'off'), 'minimal');
  assert.equal((await registry.getApiKeyAndHeaders(model)).apiKey, 'test-only-key');

  const dir = await tempHome(t);
  const path = join(dir, 'models.json');
  const config = {
    providers: {
      anthropic: {
        baseUrl: 'https://custom.invalid',
        modelOverrides: {
          [model.id]: { name: 'User override', maxTokens: 8192 },
        },
      },
    },
  };
  await writeFile(path, JSON.stringify(config));
  const customized = native.ModelRegistry.create(auth, path);
  assert.equal(customized.getError(), undefined);
  const override = customized.find('anthropic', model.id);
  assert.equal(override.name, 'User override');
  assert.equal(override.maxTokens, 8192);
  assert.equal(override.baseUrl, 'https://custom.invalid');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), config);
});

test('native request payload uses adaptive effort and preserves empty signed thinking', async (t) => {
  const native = await nativeParts(t);
  if (!native) return;
  const model = native.getModel('anthropic', ANTHROPIC_OPUS_55.id);
  const context = {
    systemPrompt: 'Fixture',
    messages: [
      { role: 'user', content: 'Fixture', timestamp: 1 },
      {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: 2,
        stopReason: 'stop',
        content: [
          { type: 'thinking', thinking: '', thinkingSignature: 'test-signed-block' },
          { type: 'text', text: 'Previous response' },
        ],
      },
      { role: 'user', content: 'Continue', timestamp: 3 },
    ],
  };
  // Capture at the native payload boundary, then stop before any network I/O.
  async function payload(reasoning, selectedModel = model) {
    let captured;
    const response = native.streamSimpleAnthropic(selectedModel, context, {
      apiKey: 'test-only-key',
      reasoning,
      temperature: 0.3,
      onPayload(value) {
        captured = value;
        throw new Error('fixture-stop-before-network');
      },
    });
    const result = await response.result();
    assert.match(result.errorMessage, /fixture-stop-before-network/);
    assert.ok(captured);
    return captured;
  }
  for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const request = await payload(level);
    assert.equal(request.model, model.id);
    assert.deepEqual(request.thinking, { type: 'adaptive', display: 'summarized' });
    assert.equal(request.output_config.effort, level === 'minimal' ? 'low' : level);
    assert.equal('temperature' in request, false);
    assert.deepEqual(request.messages[1].content[0], {
      type: 'thinking',
      thinking: '',
      signature: 'test-signed-block',
    });
  }
  for (const level of [undefined, 'off']) {
    const request = await payload(level);
    assert.equal('thinking' in request, false);
    assert.equal('temperature' in request, false);
  }
  const legacy = await payload('off', native.getModel('anthropic', 'claude-opus-5'));
  assert.deepEqual(legacy.thinking, { type: 'disabled' });
  assert.equal(legacy.temperature, 0.3);
});

test('native Anthropic request headers keep OAuth compatible and API billing separate', async (t) => {
  const native = await nativeParts(t);
  if (!native) return;
  const adapters = [['unbundled', native.streamSimpleAnthropic]];
  const bundleDir = join(native.cli.packageDir, 'dist', 'bundle');
  const bundleNames = (await readdir(bundleDir)).filter((name) => /^anthropic-.*\.js$/.test(name));
  assert.equal(bundleNames.length, 1, 'Expected one native bundled Anthropic adapter');
  const bundled = await import(pathToFileURL(join(bundleDir, bundleNames[0])).href);
  assert.equal(typeof bundled.streamSimpleAnthropic, 'function');
  adapters.push(['bundled', bundled.streamSimpleAnthropic]);
  const captured = [];
  // Exercise the actual SDK header construction against loopback only. No
  // credentials, provider network calls or paid inference are involved.
  const server = createServer((request, response) => {
    captured.push({ headers: request.headers, url: request.url });
    request.resume();
    response.writeHead(400, { 'content-type': 'application/json', connection: 'close' });
    response.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'fixture-request-captured' },
      }),
    );
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const context = { messages: [{ role: 'user', content: 'Fixture only', timestamp: 1 }] };
  async function request(stream, apiKey, modelHeaders, requestHeaders) {
    const before = captured.length;
    const model = { ...ANTHROPIC_OPUS_55, baseUrl, headers: modelHeaders };
    const result = await stream(model, context, {
      apiKey,
      reasoning: 'low',
      headers: requestHeaders,
    }).result();
    assert.match(result.errorMessage, /fixture-request-captured/);
    assert.equal(captured.length, before + 1);
    assert.match(captured.at(-1).url, /^\/v1\/messages(?:\?|$)/);
    return captured.at(-1).headers;
  }
  for (const [label, stream] of adapters) {
    await t.test(`${label}: OAuth sends a compatible Claude Code client version`, async () => {
      const headers = await request(stream, 'sk-ant-oat-fixture-only');
      const version = headers['user-agent']
        .match(/^claude-cli\/(\d+)\.(\d+)\.(\d+)$/)
        ?.slice(1)
        .map(Number);
      assert.ok(version, headers['user-agent']);
      const minimum = ANTHROPIC_CLAUDE_CODE_CLIENT_VERSION.split('.').map(Number);
      const different = version.findIndex((part, index) => part !== minimum[index]);
      assert.ok(different < 0 || version[different] > minimum[different], headers['user-agent']);
      assert.equal(headers.authorization, 'Bearer sk-ant-oat-fixture-only');
      assert.equal(headers['x-api-key'], undefined);
      assert.equal(headers['x-app'], 'cli');
      assert.match(headers['anthropic-beta'], /claude-code-20250219/);
      assert.match(headers['anthropic-beta'], /oauth-2025-04-20/);
    });
    await t.test(`${label}: API-key requests keep native SDK identity and API authentication`, async () => {
      const headers = await request(stream, 'fixture-api-key-only');
      assert.doesNotMatch(headers['user-agent'], /claude-cli\//);
      assert.equal(headers['x-api-key'], 'fixture-api-key-only');
      assert.equal(headers.authorization, undefined);
      assert.equal(headers['x-app'], undefined);
      assert.doesNotMatch(headers['anthropic-beta'] || '', /oauth-2025-04-20/);
    });
    await t.test(`${label}: Explicit model and request headers retain native precedence`, async () => {
      const modelHeaders = { 'user-agent': 'fixture-model-client/9' };
      const headers = await request(stream, 'sk-ant-oat-fixture-only', modelHeaders);
      assert.equal(headers['user-agent'], modelHeaders['user-agent']);
      const override = await request(stream, 'sk-ant-oat-fixture-only', modelHeaders, {
        'user-agent': 'fixture-request-client/10',
      });
      assert.equal(override['user-agent'], 'fixture-request-client/10');
      assert.equal(override.authorization, 'Bearer sk-ant-oat-fixture-only');
    });
  }
});

test('isolated native catalog includes Opus 5.5 without exposing credentials', async (t) => {
  const cli = discoverCli();
  if (!cli?.packageDir) return t.skip('Prime Agent engine unavailable');
  const dir = await mkdtemp(join(tmpdir(), 'prime-studio-opus-55-'));
  const secret = 'opus-55-fixture-secret';
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ anthropic: { type: 'api_key', key: secret } }));
  await writeFile(join(dir, 'models.json'), '{"providers":{}}');
  const catalog = createNativeModelCatalog({
    cli,
    agentHome: dir,
    env: { SystemRoot: process.env.SystemRoot },
  });
  t.after(async () => {
    await catalog.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const result = await catalog.read();
  const model = result.models.find(
    (item) => item.provider === 'anthropic' && item.id === ANTHROPIC_OPUS_55.id,
  );
  assert.ok(model);
  assert.equal(model.name, 'Claude Opus 5.5');
  assert.equal(model.contextWindow, 1000000);
  assert.equal(model.maxTokens, 128000);
  assert.equal(model.thinkingLevels.includes('off'), false);
  assert.equal(model.thinkingLevels.includes('max'), true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes('https://api.anthropic.com'), false);
  await writeFile(join(dir, 'auth.json'), '{}');
  const signedOut = await catalog.read();
  assert.equal(
    signedOut.models.some((item) => item.provider === 'anthropic'),
    false,
  );
});

test('installed bundled catalog and Anthropic adapter accept the same transformations', async (t) => {
  const cli = discoverCli();
  if (!cli?.packageDir) return t.skip('Prime Agent engine unavailable');
  const dir = join(cli.packageDir, 'dist', 'bundle');
  let catalogs = 0,
    adapters = 0;
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.js')) continue;
    const source = await readFile(join(dir, name), 'utf8');
    if (!source.includes(loop) && !source.includes('function isAlwaysOnAdaptiveThinkingModel(modelId) {'))
      continue;
    const transformed = transformStudioModelSupport(source);
    assert.notEqual(transformed, source);
    assert.equal(transformStudioModelSupport(transformed), transformed);
    if (source.includes(loop)) {
      catalogs++;
      assert.match(transformed, /MODELS\[studioModel\.provider\]/);
      assert.match(transformed, /"id":"claude-opus-5-5"/);
    } else {
      adapters++;
      assert.match(transformed, /if \(modelId === "claude-opus-5-5"\) return true;/);
    }
  }
  assert.equal(catalogs, 1);
  assert.equal(adapters, 1);
});

test('bundled CLI inherits new Anthropic and OpenAI models through the runtime transport loader', async (t) => {
  const cli = discoverCli();
  if (!cli?.packageDir) return t.skip('Prime Agent engine unavailable');
  const dir = await tempHome(t);
  await writeFile(
    join(dir, 'auth.json'),
    JSON.stringify({
      anthropic: { type: 'api_key', key: 'test-only-key' },
      openai: { type: 'api_key', key: 'test-only-key' },
      'openai-codex': { type: 'api_key', key: 'test-only-key' },
    }),
  );
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [cli.launchPath || cli.path, 'model', 'list'],
    {
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        PRIME_AGENT_CODING_AGENT_DIR: dir,
        PRIME_STUDIO_TRANSPORT_PACKAGE: cli.packageDir,
        NODE_OPTIONS: `--import="${new URL('../runtime/transport-loader.mjs', import.meta.url).href}"`,
        NO_COLOR: '1',
      },
      windowsHide: true,
      timeout: 20000,
    },
  );
  const output = stdout + stderr;
  assert.match(output, /anthropic\s+claude-opus-5-5\s+1M\s+128K/);
  for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
    assert.match(output, new RegExp(`openai\\s+${model}\\s+1.1M\\s+128K`));
    assert.match(output, new RegExp(`openai-codex\\s+${model}\\s+272K\\s+128K`));
  }
});
