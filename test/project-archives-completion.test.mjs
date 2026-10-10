import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

test(
  '.pastudio coordinator preserves completion origin while replacing plan and step IDs',
  { timeout: 15000 },
  async (t) => {
    const temp = await mkdtemp(join(tmpdir(), 'prime-completion-archive-'));
    const apps = [];
    t.after(async () => {
      await Promise.all(
        apps.map(async (app) => {
          app.server.closeAllConnections?.();
          await new Promise((done) => app.server.close(done));
          await app.close();
        }),
      );
      await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    async function appFor(name) {
      const cwd = join(temp, name, 'project');
      const sessionDir = join(temp, name, 'sessions');
      await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
      const app = createApp({
        initialCwd: cwd,
        sessionDir,
        dataDir: join(temp, name, 'data'),
        agentHome: join(temp, name, 'agent'),
        runtime: {
          getStatus: async () => ({ available: false }),
          getModels: async () => ({ models: [] }),
          start: async () => {
            throw new Error('No model calls permitted');
          },
          close: async () => {},
        },
      });
      apps.push(app);
      await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
      return { app, cwd };
    }
    const source = await appFor('source');
    const destination = await appFor('destination');
    let doc = await source.app.roadmap.mutate(source.cwd, { action: 'init', expectedRevision: 0 });
    doc = await source.app.roadmap.mutate(source.cwd, {
      action: 'plan.create',
      expectedRevision: doc.revision,
      title: 'Export completed work',
      steps: [{ text: 'Parent', children: [{ text: 'Done' }, { text: 'Remaining' }] }],
    });
    doc = await source.app.roadmap.mutate(
      source.cwd,
      {
        action: 'step.check',
        expectedRevision: doc.revision,
        planId: doc.plans[0].id,
        stepId: doc.plans[0].steps[0].children[0].id,
        done: true,
      },
      { by: 'agent', sessionId: 'origin-child', rootSessionId: 'origin-root' },
    );
    const original = doc.plans[0].steps[0].children[0];
    assert.equal(original.completion.sessionId, 'origin-child');
    const archive = await source.app.projectArchives.exportArchive(source.cwd);
    const preview = await destination.app.projectArchives.previewArchive(archive.buffer, destination.cwd);
    await destination.app.projectArchives.importArchive(
      archive.buffer,
      destination.cwd,
      preview.previewToken,
    );
    const imported = await destination.app.roadmap.read(destination.cwd);
    const step = imported.plans[0].steps[0].children[0];
    assert.notEqual(imported.plans[0].id, doc.plans[0].id);
    assert.notEqual(step.id, original.id);
    assert.deepEqual(step.completion, original.completion);
    assert.equal(imported.plans[0].steps[0].children[1].completion, null);
  },
);
