// Real 0.9.6 dispatch and persistence, with a loopback-only provider.
// No real account, paid model, desktop action or user daemon is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentRuntime, discoverCli } from '../lib/agent.mjs';
import { createLiveSessionClient } from '../lib/live-session-client.mjs';
import { createStore } from '../lib/store.mjs';

const cli = discoverCli();
assert.equal(JSON.parse(await readFile(join(cli.packageDir, 'package.json'), 'utf8')).version, '0.9.6');
const { buildSessionContext } = await import(
  pathToFileURL(join(cli.packageDir, 'dist/core/session-manager.js'))
);
const root = await mkdtemp(join(tmpdir(), 'prime-image-routing-native-'));
const cwd = join(root, 'project'),
  agentHome = join(root, 'agent'),
  sessionDir = join(root, 'sessions');
await Promise.all([cwd, agentHome, sessionDir].map((path) => mkdir(path, { recursive: true })));
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const requests = [],
  events = [],
  report = { root, engine: cli.packageDir };
const requestSeen = Promise.withResolvers(),
  replyGate = Promise.withResolvers();
async function bounded(promise, label, ms = 30000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const provider = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    if (requests.length === 1) {
      requestSeen.resolve(body);
      await replyGate.promise;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-image-fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    frame({ role: 'assistant', content: 'Fixture answer.' });
    frame({}, 'stop');
    res.end('data: [DONE]\n\n');
  } catch (error) {
    requestSeen.reject(error);
    res.destroy(error);
  }
});
await new Promise((done) => provider.listen(0, '127.0.0.1', done));
await writeFile(
  join(agentHome, 'models.json'),
  JSON.stringify({
    providers: {
      fixture: {
        api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        apiKey: 'fixture-only',
        models: ['plain', 'vision'].map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: id === 'vision' ? ['text', 'image'] : ['text'],
          contextWindow: 131072,
          maxTokens: 4096,
        })),
      },
    },
  }),
);
await writeFile(join(agentHome, 'auth.json'), '{}');
await writeFile(
  join(agentHome, 'settings.json'),
  JSON.stringify({
    defaultProvider: 'fixture',
    defaultModel: 'plain',
    imageModel: 'fixture/vision',
    defaultThinkingLevel: 'off',
    autoRefine: { enabled: false },
    compaction: { enabled: false },
    retry: { enabled: false },
    telemetry: { enabled: false, noticeShown: true },
  }),
);
const runtime = createAgentRuntime({
  agentHome,
  sessionDir,
  kernelRoot: root,
  env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' },
});
const store = createStore({ sessionDir, dataDir: join(root, 'data') });
let client, failure;
try {
  const handle = await bounded(
    runtime.start({
      cwd,
      message: 'IMAGE_TURN_FIXTURE',
      model: 'fixture/plain',
      thinking: 'off',
      images: [{ type: 'image', mimeType: 'image/png', data: png }],
      onEvent: (event) => events.push(event),
    }),
    'start',
    60000,
  );
  const imageRequest = await bounded(requestSeen.promise, 'provider request');
  report.imageRequestModel = imageRequest.model;
  assert.equal(imageRequest.model, 'vision');
  const parts = imageRequest.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  );
  assert.ok(
    parts.some((part) => part.type === 'image_url' && part.image_url?.url === `data:image/png;base64,${png}`),
  );
  report.imageBytesPreserved = true;
  assert.ok(handle.sessionId);
  client = createLiveSessionClient(runtime.getLiveEndpoint());
  const inspector = await bounded(client.getInspector(handle.sessionId, cwd), 'live inspector');
  report.liveConfiguredModel = inspector.state.model;
  assert.equal(inspector.state.model, 'fixture/plain');
  replyGate.resolve();
  const result = await bounded(handle.done, 'image completion');
  assert.equal(result.status, 'completed', result.error);
  const history = await store.history(handle.sessionId);
  const entries = (await readFile(history.file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  report.studioHistoryModel = history.model;
  report.nativeContextModel = buildSessionContext(entries).model;
  report.persistedModelEntries = entries
    .filter((entry) => entry.type === 'model_change')
    .map(({ provider, modelId }) => ({ provider, modelId }));
  report.assistantModels = entries
    .filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant')
    .map((entry) => entry.message.model);
  const resumed = await bounded(
    runtime.start({
      cwd,
      sessionId: handle.sessionId,
      message: 'TEXT_RESUME_FIXTURE',
      onEvent: (event) => events.push(event),
    }),
    'resume',
    60000,
  );
  const resumedResult = await bounded(resumed.done, 'resumed completion');
  assert.equal(resumedResult.status, 'completed', resumedResult.error);
  report.resumedRequestModels = requests.slice(1).map((request) => request.model);
  const settings = JSON.parse(await readFile(join(agentHome, 'settings.json'), 'utf8'));
  assert.equal(settings.defaultProvider, 'fixture');
  assert.equal(settings.defaultModel, 'plain');
  assert.equal(settings.imageModel, 'fixture/vision');
  report.modelDefaultsPreserved = true;
  assert.deepEqual(report.nativeContextModel, { provider: 'fixture', modelId: 'plain' });
  assert.equal(report.studioHistoryModel, 'fixture/plain');
  assert.ok(report.resumedRequestModels.length > 0);
  assert.ok(report.resumedRequestModels.every((model) => model === 'plain'));
} catch (error) {
  failure = error;
  report.error = String(error.stack || error);
} finally {
  replyGate.resolve();
  client?.close();
  try {
    await bounded(runtime.close(), 'owned runtime cleanup', 30000);
    report.runtimeClosed = true;
  } catch (error) {
    failure ||= error;
    report.cleanupError = String(error);
  }
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  report.providerClosed = true;
  if (report.runtimeClosed) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    report.tempRootRemoved = true;
  }
  report.passed = !failure;
  const evidence = resolve(
    process.env.PRIME_STUDIO_IMAGE_PROOF_REPORT || 'test-results/engine-0.9.6/image-routing-native.json',
  );
  await mkdir(join(evidence, '..'), { recursive: true });
  await writeFile(evidence, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
if (failure) process.exitCode = 1;
