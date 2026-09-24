import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createStore, PROJECT_FOLDER_COLORS, normalizeProjectColor } from '../lib/store.mjs';
import { PROJECT_FOLDER_COLORS as PUBLIC_FOLDER_COLORS } from '../public/project-navigation.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-folder-color-'));
  const options = {
    sessionDir: join(root, 'sessions'),
    dataDir: join(root, 'local'),
    initialCwd: join(root, 'project'),
  };
  await mkdir(options.sessionDir, { recursive: true });
  await mkdir(options.initialCwd, { recursive: true });
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, options, store: createStore(options) };
}

test('folder color palette has exactly six choices with transparent first', () => {
  assert.equal(PROJECT_FOLDER_COLORS.length, 6);
  assert.equal(PROJECT_FOLDER_COLORS[0], 'transparent');
  assert.equal(new Set(PROJECT_FOLDER_COLORS).size, 6);
});

test('normalizeProjectColor validates at the trust boundary', () => {
  assert.equal(normalizeProjectColor(undefined), undefined);
  assert.equal(normalizeProjectColor('transparent'), '');
  assert.equal(normalizeProjectColor(''), '');
  assert.equal(normalizeProjectColor('#7FA6C9'), '#7fa6c9');
  assert.equal(normalizeProjectColor('red'), null);
  assert.equal(normalizeProjectColor('#ffffff'), null);
  assert.equal(normalizeProjectColor(42), null);
  assert.equal(normalizeProjectColor(null), null);
  assert.equal(normalizeProjectColor(['#7fa6c9']), null);
  assert.equal(normalizeProjectColor({ color: '#7fa6c9' }), null);
  assert.equal(normalizeProjectColor(true), null);
});

test('frontend palette matches the backend palette', () => {
  assert.deepEqual(PUBLIC_FOLDER_COLORS, PROJECT_FOLDER_COLORS);
});

test('PATCH persists a swatch per project and transparent resets across reload', async (t) => {
  const { root, options, store } = await fixture(t);
  await store.project({ cwd: options.initialCwd }, true);
  const other = join(root, 'other');
  await mkdir(other, { recursive: true });
  await store.project({ cwd: other });

  const tinted = await store.project({ cwd: options.initialCwd, color: '#8fb49e' }, true);
  assert.equal(tinted.color, '#8fb49e');
  let overview = await store.overview();
  assert.equal(overview.projects.find((p) => p.cwd === tinted.cwd).color, '#8fb49e');
  assert.equal(overview.projects.find((p) => p.cwd === other).color, undefined);

  const reopened = createStore(options);
  overview = await reopened.overview();
  assert.equal(overview.projects.find((p) => p.cwd === tinted.cwd).color, '#8fb49e');

  const reset = await reopened.project({ cwd: options.initialCwd, color: 'transparent' }, true);
  assert.equal(reset.color, undefined);
  overview = await reopened.overview();
  assert.equal(overview.projects.find((p) => p.cwd === tinted.cwd).color, undefined);
});

test('PATCH rejects colors outside the palette', async (t) => {
  const { options, store } = await fixture(t);
  await store.project({ cwd: options.initialCwd }, true);
  for (const color of ['red', '#ffffff', 'javascript:alert(1)', '#7fa6c9;', ['#7fa6c9'], { color: '#7fa6c9' }, null, 42]) {
    await assert.rejects(store.project({ cwd: options.initialCwd, color }, true), /400|valeur|Invalid/i);
  }
  const overview = await store.overview();
  assert.equal(overview.projects[0].color, undefined);
});
