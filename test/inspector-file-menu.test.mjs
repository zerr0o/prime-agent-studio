import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultFileView, filePresentation, isImagePath, parentFolder } from '../public/file-presentation.js';
import { messages } from '../public/translations.js';

test('image paths match the preview API formats only', () => {
  for (const path of ['photo.png', 'docs/image.JPG', 'a/b/c.jpeg', 'shot.webp', 'anim.GIF'])
    assert.equal(isImagePath(path), true, path);
  for (const path of [
    'notes.md',
    'data.json',
    'plain.txt',
    'image.svg',
    'photo.pdf',
    'photo.png.txt',
    '',
    null,
    undefined,
  ])
    assert.equal(isImagePath(path), false, String(path));
});

test('file activation opens images in content mode and keeps diff otherwise', () => {
  // Changed text file -> diff view (existing behaviour preserved).
  assert.equal(defaultFileView({ path: 'src/app.js', status: 'M ' }), 'diff');
  // Changed image file -> content preview directly.
  assert.equal(defaultFileView({ path: 'assets/shot.png', status: 'M ' }), 'preview');
  assert.equal(defaultFileView({ path: 'docs/logo.JPEG', status: '??', untracked: true }), 'preview');
  // Deleted files keep the diff view even for images.
  assert.equal(defaultFileView({ path: 'old.png', status: ' D', deleted: true }), 'diff');
  // Browser entries and directories open the content view.
  assert.equal(defaultFileView({ path: 'notes.md' }), 'preview');
  assert.equal(defaultFileView({ path: 'docs', directory: true }), 'preview');
  assert.equal(defaultFileView(null), 'preview');
  assert.equal(defaultFileView('photo.png'), 'preview');
});

test('revealing a folder targets the containing directory', () => {
  assert.equal(parentFolder('docs/plan.md'), 'docs');
  assert.equal(parentFolder('a/b/c.txt'), 'a/b');
  assert.equal(parentFolder('root.txt'), '');
  assert.equal(parentFolder('docs'), '');
  assert.equal(parentFolder(''), '');
});

test('inspector wires the file context menu on existing flows only', async () => {
  const source = await readFile('public/inspector.js', 'utf8');
  // Right-click + keyboard menu on file rows.
  assert.match(source, /addEventListener\('contextmenu'/);
  assert.match(source, /ContextMenu/);
  assert.match(source, /inspector-file-menu/);
  // Changed rows use the shared default view (images -> content).
  assert.match(source, /openFile\(file, defaultFileView\(file\)\)/);
  // The three menu actions reuse existing navigation and clipboard flows.
  assert.match(source, /api\('\/api\/projects\/open'/);
  assert.match(source, /void copyFilePath\(path\)/);
  assert.match(source, /navigator\.clipboard/);
  // Menu labels reuse existing translation keys (no translations.js change).
  for (const key of ['ui.ouvrir', 'ui.ouvrir_le_dossier', 'ui.copier_le_chemin', 'ui.copie'])
    assert.ok(source.includes(`'${key}'`), key);
  // Every message key referenced by the inspector must already be translated.
  const unknown = [];
  for (const match of source.matchAll(/\btr\(\s*['"]([\w.-]+)['"]/g)) {
    if (!(match[1] in messages)) unknown.push(match[1]);
  }
  assert.deepEqual(unknown, []);
});

test('inspector styles the file context menu', async () => {
  const css = await readFile('public/inspector.css', 'utf8');
  assert.match(css, /\.inspector-file-menu/);
  assert.match(css, /\.inspector-file-menu\[hidden\]/);
});

test('file presentation behaviour is unchanged', () => {
  assert.equal(filePresentation('docs/README.MD', '# Titre').kind, 'markdown');
  assert.equal(filePresentation('config.json', '{"enabled":true}').text, '{\n  "enabled": true\n}');
});
