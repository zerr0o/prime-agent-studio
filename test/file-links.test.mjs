import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { isFileReference } from '../public/file-links.js';
import { parentFolder } from '../public/file-presentation.js';
import { createProjectFiles } from '../lib/project-files.mjs';
import { pathToFileURL } from 'node:url';

test('file links cover dot folders, binaries, spaces, encoded and folder paths', () => {
  for (const reference of [
    'md_files/PLAN.md',
    'C:\\Project\\notes.md',
    'file:///C:/Project/report.pdf',
    'src/app.ts:12:3',
    'src/app.ts#L4-L9',
    'notes.md',
    '.local/desktop-release/v4.0.2/Prime-Agent-Studio_4.0.2_x64-setup.exe',
    'builds/app.exe',
    'archive.zip',
    'installer.msi',
    'run.tar.gz',
    'docs/guide.md',
    'docs/mes notes.md',
    'docs/mes%20notes.md',
    'docs/',
    'docs/sub/',
    '.local/release/app.exe',
  ])
    assert.equal(isFileReference(reference), true, reference);
  for (const value of [
    'https://example.com/file.md',
    'javascript:alert(1)',
    'mailto:user@example.test',
    '#heading',
    '//example.com/file.md',
    'hello world',
    'x\n.md',
    'justaword',
    'README',
    '',
    null,
    undefined,
  ])
    assert.equal(isFileReference(value), false, String(value));
});

test('link resolution keeps security boundaries while serving files and folders', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-file-links-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'builds'), { recursive: true });
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n');
  await writeFile(join(root, 'docs', 'mes notes.md'), '# Notes\n');
  await writeFile(join(root, 'builds', 'app.exe'), Buffer.from([0x4d, 0x5a, 0x00, 0xff]));
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  const files = createProjectFiles({
    store: { findProject: async () => ({ cwd: root }) },
    protectedRoots: [],
  });
  assert.deepEqual(await files.resolveReference(root, 'docs/guide.md'), { path: 'docs/guide.md' });
  assert.deepEqual(await files.resolveReference(root, 'builds/app.exe'), { path: 'builds/app.exe' });
  assert.deepEqual(await files.resolveReference(root, 'docs/mes notes.md'), {
    path: 'docs/mes notes.md',
  });
  assert.deepEqual(await files.resolveReference(root, 'docs/mes%20notes.md'), {
    path: 'docs/mes notes.md',
  });
  assert.deepEqual(await files.resolveReference(root, 'docs/'), { path: 'docs', directory: true });
  assert.deepEqual(await files.resolveReference(root, 'docs'), { path: 'docs', directory: true });
  // Dot folders other than internals resolve like any project path.
  assert.deepEqual(await files.resolveReference(root, '.github/workflows/ci.yml'), {
    path: '.github/workflows/ci.yml',
  });
  const preview = await files.preview(root, 'builds/app.exe');
  assert.equal(preview.type, 'binary');
  await assert.rejects(files.resolveReference(root, '../outside'), { status: 403 });
  await assert.rejects(files.resolveReference(root, '/etc/hosts'), (error) =>
    [400, 403, 404].includes(error.status),
  );
  await assert.rejects(files.resolveReference(root, 'docs/missing.md'), { status: 404 });
  assert.equal(parentFolder('builds/app.exe'), 'builds');
  assert.equal(parentFolder('root.txt'), '');
});

test('published .local artifacts resolve unless the data dir covers them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-file-links-dot-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, '.local', 'desktop-release', 'v4.0.2'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  const reference = '.local/desktop-release/v4.0.2/Prime-Agent-Studio_4.0.2_x64-setup.exe';
  await writeFile(join(root, reference), Buffer.from([0x4d, 0x5a, 0x00, 0xff]));
  await writeFile(join(root, '.local', 'workspace.json'), '{"projects":[]}');
  await writeFile(join(root, '.git', 'config'), '[core]\n');
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'export default 1;\n');
  // Installed app layout: the Studio data dir lives outside the project,
  // so a project .local is ordinary project content.
  const files = createProjectFiles({
    store: { findProject: async () => ({ cwd: root }) },
    protectedRoots: [join(root, '..', 'studio-data')],
  });
  assert.equal(isFileReference(reference), true);
  assert.deepEqual(await files.resolveReference(root, reference), { path: reference });
  const preview = await files.preview(root, reference);
  assert.equal(preview.type, 'binary');
  assert.ok(preview.size > 0);
  // Reveal targets the containing folder through the same public artifact path.
  assert.equal(
    await files.localDirectory(root, parentFolder(reference)),
    await realpath(join(root, '.local', 'desktop-release', 'v4.0.2')),
  );
  // Version control internals and dependencies keep refusing.
  await assert.rejects(files.resolveReference(root, '.git/config'), { status: 403 });
  await assert.rejects(files.resolveReference(root, 'node_modules/pkg/index.js'), { status: 403 });
  // Source tree layout: when the running Studio data dir IS the project
  // .local folder, its content stays refused.
  const devFiles = createProjectFiles({
    store: { findProject: async () => ({ cwd: root }) },
    protectedRoots: [join(root, '.local')],
  });
  await assert.rejects(devFiles.resolveReference(root, reference), { status: 403 });
  await assert.rejects(devFiles.resolveReference(root, '.local/workspace.json'), { status: 403 });
});

test('project root references resolve as folders and symlinks never widen resolution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-file-links-root-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n');
  const outside = await mkdtemp(join(tmpdir(), 'prime-file-links-outside-'));
  t.after(async () => {
    await rm(outside, { recursive: true, force: true, maxRetries: 5 });
  });
  await writeFile(join(outside, 'secret.txt'), 'private');
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const files = createProjectFiles({
    store: { findProject: async () => ({ cwd: root }) },
    protectedRoots: [],
  });
  // Absolute and file: references to the project root resolve as a folder,
  // so the viewer can offer the folder reveal action for them.
  assert.deepEqual(await files.resolveReference(root, root), { path: '', directory: true });
  assert.deepEqual(await files.resolveReference(root, pathToFileURL(root).href), {
    path: '',
    directory: true,
  });
  // Symlinked directories are never descended or matched: a bare filename
  // reachable only through the link stays missing, and the slashed escape
  // path is refused for leaving the project.
  await assert.rejects(files.resolveReference(root, 'secret.txt'), { status: 404 });
  await assert.rejects(files.resolveReference(root, 'escape/secret.txt'), { status: 403 });
});
