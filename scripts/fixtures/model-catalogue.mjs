// Synthetic catalogue only. Does not access credentials, the native daemon or providers.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../../server.mjs';

export function modelCatalogue({ retired = true, refreshing = false } = {}) {
  return {
    models: [
      {
        id: 'prime-inference/claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        provider: 'prime-inference',
        availability: 'available',
      },
      {
        id: 'prime-inference/minimax/minimax-m3',
        name: 'MiniMax M3',
        provider: 'prime-inference',
        availability: 'available',
      },
      {
        id: 'openrouter/minimax/minimax-m3:free',
        name: 'MiniMax M3 (free)',
        provider: 'openrouter',
        availability: retired ? 'unavailable' : 'available',
      },
      {
        id: 'openrouter/minimax/minimax-m3',
        name: 'MiniMax M3',
        provider: 'openrouter',
        availability: 'available',
      },
      {
        id: 'openrouter/qwen/qwen3.6-plus',
        name: 'Qwen 3.6 Plus',
        provider: 'openrouter',
        availability: 'available',
      },
    ],
    default: { model: 'openrouter/minimax/minimax-m3:free', thinking: 'medium' },
    refreshing,
  };
}

export async function createModelCatalogueFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-model-catalogue-ui-'));
  const cwd = join(root, 'Atelier'),
    sessionDir = join(root, 'sessions');
  await Promise.all([cwd, sessionDir, join(root, 'agent')].map((path) => mkdir(path)));
  const app = createApp({
    agentHome: join(root, 'agent'),
    sessionDir,
    dataDir: join(root, 'data'),
    initialCwd: cwd,
    runtime: {
      getStatus: async () => ({ available: true, version: '0.9.5', cli: 'fixture' }),
      getModels: async () => modelCatalogue(options),
      start: async () => {
        throw new Error('No agent should start in this catalogue fixture');
      },
      close: async () => {},
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${app.server.address().port}`,
    async close() {
      await app.close();
      assert.equal(dirname(root), resolve(tmpdir()));
      assert.ok(root.startsWith(join(tmpdir(), 'prime-studio-model-catalogue-ui-')));
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = await createModelCatalogueFixture();
  await mkdir(resolve('.local'), { recursive: true });
  await writeFile(
    resolve('.local/model-catalogue-preview.json'),
    JSON.stringify({ url: fixture.url, pid: process.pid }, null, 2),
  );
  console.log(JSON.stringify({ url: fixture.url, pid: process.pid }));
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await fixture.close();
      process.exit();
    });
}
