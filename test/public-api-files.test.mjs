import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildFileId,
  buildEtag,
  createPublicApiFiles,
  extractAttachmentRefs,
  extractLinkedReferences,
  isLocalFileReference,
  parseHttpRange,
  sanitizeDownloadName,
  streamFileToResponse,
} from '../lib/public-api-files.mjs';
import { createFileStore, validateFiles } from '../lib/files.mjs';

const slash = (path) => path.replaceAll('\\', '/');

async function fixture(t, prefix = 'prime-public-api-files-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function service(t, options = {}) {
  const dataDir = options.dataDir ?? (await fixture(t, 'prime-public-api-data-'));
  const svc = createPublicApiFiles({ machineId: 'machine-a', ...options, dataDir });
  t.after(() => svc.close());
  return { svc, dataDir };
}

async function serve(t, handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        if (!res.headersSent) {
          res.writeHead(error.status ?? 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.code ?? 'internal' }));
        } else res.destroy();
      });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('extraction keeps markdown links, local images and code spans, nothing else', () => {
  const messages = [
    { role: 'user', text: 'see [guide](docs/guide.md) and ![chart](charts/a.png)' },
    { role: 'assistant', text: 'run `docs/run.sh` after reading' },
    { role: 'assistant', text: 'the file docs/plain.md broke' },
    { role: 'assistant', text: '```\n[x](fenced.md)\n```' },
    { role: 'assistant', text: 'site [web](https://example.com/f.md) mail [m](mailto:a@b.c)' },
    {
      role: 'assistant',
      text: 'remote ![img](https://example.com/a.png) blob ![b](data:image/png;base64,AAA)',
    },
    { role: 'assistant', text: '<a href="inline.md">html</a>' },
  ];
  assert.deepEqual(extractLinkedReferences(messages), ['docs/guide.md', 'charts/a.png', 'docs/run.sh']);
  assert.ok(isLocalFileReference('notes.md'));
  assert.equal(isLocalFileReference('https://example.com/f.md'), false);
  assert.equal(isLocalFileReference('hello world'), false);
});

test('linked files outside the project serve after a local receipt; prose paths never list', async (t) => {
  const project = await fixture(t);
  const outside = await fixture(t, 'prime-public-api-out-');
  await writeFile(join(outside, 'report.md'), '# Report\n');
  const { svc } = await service(t);
  const sessionId = 'sess-outside-1';
  const messages = [
    { role: 'user', text: `read [report](${slash(join(outside, 'report.md'))}) please` },
    { role: 'assistant', text: `the file ${slash(join(outside, 'report.md'))} is mentioned` },
    { role: 'assistant', text: 'also see [missing](nope/missing.md)' },
  ];
  assert.deepEqual(extractLinkedReferences(messages), [slash(join(outside, 'report.md')), 'nope/missing.md']);
  let listed = await svc.list({ sessionId, cwd: project, messages });
  assert.equal(listed.length, 2);
  assert.ok(listed.every((entry) => entry.available === false && entry.originMachineId === null));
  assert.deepEqual(await svc.recordLocal({ sessionId, cwd: project, messages }), {
    recorded: 1,
    sessionId,
  });
  listed = await svc.list({ sessionId, cwd: project, messages });
  const [report, missing] = listed;
  assert.equal(report.available, true);
  assert.equal(report.originMachineId, 'machine-a');
  assert.equal(report.machineId, 'machine-a');
  assert.equal(report.kind, 'link');
  assert.equal(report.name, 'report.md');
  assert.equal(report.size, 9);
  assert.equal(missing.available, false);
  assert.equal(missing.originMachineId, null);
  assert.deepEqual(Object.keys(report).sort(), [
    'available',
    'id',
    'kind',
    'machineId',
    'name',
    'originMachineId',
    'size',
  ]);
});

test('deliberately linked dotfiles outside the project are honored; no extension denylist', async (t) => {
  const project = await fixture(t);
  const outside = await fixture(t, 'prime-public-api-out-');
  await writeFile(join(outside, 'custom.env'), 'TOKEN=abc\n');
  const { svc } = await service(t);
  const sessionId = 'sess-dotfile-1';
  const messages = [{ role: 'user', text: `check \`${slash(join(outside, 'custom.env'))}\`` }];
  assert.deepEqual(await svc.recordLocal({ sessionId, cwd: project, messages }), {
    recorded: 1,
    sessionId,
  });
  const [entry] = await svc.list({ sessionId, cwd: project, messages });
  assert.equal(entry.available, true);
  assert.equal(entry.name, 'custom.env');
  assert.equal(entry.size, 10);
});

test('file ids are deterministic per session and differ across sessions', async (t) => {
  const project = await fixture(t);
  await mkdir(join(project, 'docs'), { recursive: true });
  await writeFile(join(project, 'docs', 'guide.md'), 'guide\n');
  const { svc } = await service(t);
  const messages = [{ role: 'user', text: 'read [guide](docs/guide.md)' }];
  await svc.recordLocal({ sessionId: 'sess-alpha', cwd: project, messages });
  await svc.recordLocal({ sessionId: 'sess-beta', cwd: project, messages });
  const alpha = await svc.list({ sessionId: 'sess-alpha', cwd: project, messages });
  const beta = await svc.list({ sessionId: 'sess-beta', cwd: project, messages });
  assert.equal(alpha.length, 1);
  assert.equal(beta.length, 1);
  assert.notEqual(alpha[0].id, beta[0].id);
  assert.match(alpha[0].id, /^[0-9a-f]{32}$/);
  const again = await svc.list({ sessionId: 'sess-alpha', cwd: project, messages });
  assert.equal(again[0].id, alpha[0].id);
  assert.equal(alpha[0].id, buildFileId('machine-a', 'sess-alpha', 'link', 'docs/guide.md'));
});

test('remote urls, network paths, device paths and unsafe names are rejected', async (t) => {
  const project = await fixture(t);
  await writeFile(join(project, 'ok.md'), 'ok\n');
  const seen = [];
  const { svc } = await service(t, {
    getLocalOrigin: async (info) => {
      seen.push(info);
      return 'machine-a';
    },
  });
  const sessionId = 'sess-reject-1';
  // Remote URLs never even extract; the rest extract but must fail closed.
  const remote = [{ role: 'user', text: 'see [w](https://example.com/f.md)' }];
  assert.deepEqual(extractLinkedReferences(remote), []);
  assert.deepEqual(await svc.list({ sessionId, cwd: project, messages: remote }), []);
  const cases = [
    ['file-host', `[f](file://server/share/f.md)`, 'remote_url'],
    ['unc', 'see [u](' + '\\\\\\\\server\\\\share\\\\f.md)', 'network_path'],
    ['dev', '[d](/dev/null)', 'device_path'],
    ['reserved', '[c](COM1.txt)', 'unsafe_path'],
    ['trailing-dot', '[n](notes./x.md)', 'unsafe_path'],
    ['ads', `[a](${slash(join(project, 'ok.md'))}:stream)`, 'unsafe_path'],
  ];
  for (const [label, text, code] of cases) {
    const messages = [{ role: 'user', text }];
    const refs = extractLinkedReferences(messages);
    assert.equal(refs.length, 1, label);
    const listed = await svc.list({ sessionId, cwd: project, messages });
    assert.equal(listed.length, 1, label);
    assert.equal(listed[0].available, false, label);
    await assert.rejects(
      svc.download(
        { method: 'GET', headers: {} },
        { writeHead: () => assert.fail(`must not respond (${label})`) },
        { sessionId, cwd: project, messages, fileId: listed[0].id },
      ),
      (error) => error.code === code && [400, 403].includes(error.status),
      label,
    );
  }
  assert.ok(seen.length > 0);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['cwd', 'kind', 'reference', 'sessionId']);
  assert.equal(seen[0].kind, 'link');
});

test('protected roots refuse direct and symlinked linked paths', async (t) => {
  const project = await fixture(t);
  const protectedDir = await fixture(t, 'prime-public-api-protected-');
  await writeFile(join(protectedDir, 'creds.env'), 'SECRET=1\n');
  await writeFile(join(project, 'public.md'), 'public\n');
  const linkDir = join(project, 'linkdir');
  let junction = false;
  try {
    await symlink(protectedDir, linkDir, 'junction');
    junction = true;
  } catch {
    junction = false;
  }
  const { svc } = await service(t, { protectedRoots: [protectedDir] });
  const sessionId = 'sess-protected-1';
  const messages = [
    { role: 'user', text: `leaked [creds](${slash(join(protectedDir, 'creds.env'))})` },
    ...(junction ? [{ role: 'user', text: 'sneaky [sneak](linkdir/creds.env)' }] : []),
    { role: 'user', text: 'fine [public](public.md)' },
  ];
  assert.deepEqual(await svc.recordLocal({ sessionId, cwd: project, messages }), {
    recorded: 1,
    sessionId,
  });
  const listed = await svc.list({ sessionId, cwd: project, messages });
  const byName = Object.fromEntries(listed.map((entry) => [entry.name, entry]));
  assert.equal(byName['creds.env']?.available, false);
  assert.equal(byName['public.md']?.available, true);
  if (junction) {
    // recordLocal validated only public.md, so the smuggled name stays unknown-origin.
    assert.equal(byName['creds.env'] && listed.filter((e) => e.name === 'creds.env').length, 2);
    for (const entry of listed.filter((e) => e.name === 'creds.env'))
      assert.equal(entry.originMachineId, null);
  }
  // A proven direct protected reference fails with path_protected, not file bytes.
  const hooked = createPublicApiFiles({
    machineId: 'machine-a',
    protectedRoots: [protectedDir],
    dataDir: await fixture(t, 'prime-public-api-data-'),
    getLocalOrigin: async () => 'machine-a',
  });
  t.after(() => hooked.close());
  const direct = [{ role: 'user', text: `leaked [creds](${slash(join(protectedDir, 'creds.env'))})` }];
  const [proven] = await hooked.list({ sessionId, cwd: project, messages: direct });
  assert.equal(proven.originMachineId, 'machine-a');
  assert.equal(proven.available, false);
  await assert.rejects(
    hooked.download(
      { method: 'GET', headers: {} },
      { writeHead: () => assert.fail('must not respond') },
      {
        sessionId,
        cwd: project,
        messages: direct,
        fileId: proven.id,
      },
    ),
    (error) => error.code === 'path_protected' && error.status === 403,
  );
  if (junction) {
    const sneaky = [{ role: 'user', text: 'sneaky [sneak](linkdir/creds.env)' }];
    const [entry] = await hooked.list({ sessionId, cwd: project, messages: sneaky });
    assert.equal(entry.available, false);
    await assert.rejects(
      hooked.download(
        { method: 'GET', headers: {} },
        { writeHead: () => assert.fail('must not respond') },
        { sessionId, cwd: project, messages: sneaky, fileId: entry.id },
      ),
      (error) => error.code === 'path_protected' && error.status === 403,
    );
  }
});

test('directories never serve as files', async (t) => {
  const project = await fixture(t);
  await mkdir(join(project, 'docs'), { recursive: true });
  const { svc } = await service(t, { getLocalOrigin: async () => 'machine-a' });
  const sessionId = 'sess-dir-1';
  const messages = [{ role: 'user', text: 'open [docs](docs/) please' }];
  const [entry] = await svc.list({ sessionId, cwd: project, messages });
  assert.equal(entry.available, false);
  await assert.rejects(
    svc.download(
      { method: 'GET', headers: {} },
      { writeHead: () => assert.fail('must not respond') },
      {
        sessionId,
        cwd: project,
        messages,
        fileId: entry.id,
      },
    ),
    (error) => error.code === 'not_a_file',
  );
});

test('local receipts persist fingerprints only and survive restarts', async (t) => {
  const project = await fixture(t);
  const outside = await fixture(t, 'prime-public-api-out-');
  await writeFile(join(outside, 'report.md'), '# Report\n');
  const dataDir = await fixture(t, 'prime-public-api-data-');
  const sessionId = 'sess-receipt-1';
  const ref = slash(join(outside, 'report.md'));
  const messages = [{ role: 'user', text: `read [report](${ref})` }];
  const first = createPublicApiFiles({ machineId: 'machine-a', dataDir });
  assert.deepEqual(await first.recordLocal({ sessionId, cwd: project, messages }), {
    recorded: 1,
    sessionId,
  });
  await first.close();
  const receiptFile = join(dataDir, 'public-api-file-receipts', `${sessionId}.json`);
  const raw = await readFile(receiptFile, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.machineId, 'machine-a');
  assert.equal(parsed.sessionId, sessionId);
  assert.deepEqual(parsed.refs, [buildFileId('machine-a', sessionId, 'link', ref)]);
  assert.ok(!raw.includes('report.md') && !raw.includes('Report'));
  // Fresh instance, same dataDir: legacy history validates without a new receipt.
  const second = createPublicApiFiles({ machineId: 'machine-a', dataDir });
  t.after(() => second.close());
  const listed = await second.list({ sessionId, cwd: project, messages });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].available, true);
  assert.equal(listed[0].originMachineId, 'machine-a');
});

test('unknown legacy references stay unavailable and downloads fail closed', async (t) => {
  const project = await fixture(t);
  const outside = await fixture(t, 'prime-public-api-out-');
  await writeFile(join(outside, 'legacy.md'), 'legacy\n');
  const { svc } = await service(t);
  const sessionId = 'sess-legacy-1';
  const ref = slash(join(outside, 'legacy.md'));
  const messages = [{ role: 'user', text: `old [legacy](${ref})` }];
  const [entry] = await svc.list({ sessionId, cwd: project, messages });
  assert.equal(entry.available, false);
  assert.equal(entry.size, null);
  assert.equal(entry.originMachineId, null);
  await assert.rejects(
    svc.download(
      { method: 'GET', headers: {} },
      { writeHead: () => assert.fail('must not respond') },
      {
        sessionId,
        cwd: project,
        messages,
        fileId: entry.id,
      },
    ),
    (error) => error.code === 'origin_unknown' && error.status === 409,
  );
});

test('a resumed session never blanket-grants old references; receipts are per reference', async (t) => {
  const project = await fixture(t);
  const outside = await fixture(t, 'prime-public-api-out-');
  await writeFile(join(outside, 'old.md'), 'old\n');
  await writeFile(join(outside, 'new.md'), 'new\n');
  const { svc, dataDir } = await service(t);
  const sessionId = 'sess-resume-1';
  const oldRef = slash(join(outside, 'old.md'));
  const newRef = slash(join(outside, 'new.md'));
  // Only the resumed (locally produced) message is recorded.
  assert.deepEqual(
    await svc.recordLocal({
      sessionId,
      cwd: project,
      message: { role: 'user', text: `now [fresh](${newRef})`, attachments: [], timestamp: 1 },
    }),
    { recorded: 1, sessionId },
  );
  const messages = [
    { role: 'user', text: `before [stale](${oldRef})` },
    { role: 'user', text: `now [fresh](${newRef})` },
  ];
  const listed = await svc.list({ sessionId, cwd: project, messages });
  const byId = Object.fromEntries(listed.map((entry) => [entry.id, entry]));
  assert.equal(byId[buildFileId('machine-a', sessionId, 'link', oldRef)].available, false);
  assert.equal(byId[buildFileId('machine-a', sessionId, 'link', oldRef)].originMachineId, null);
  assert.equal(byId[buildFileId('machine-a', sessionId, 'link', newRef)].available, true);
  // Recording merges: the old reference stays unknown until its own local event.
  assert.deepEqual(await svc.recordLocal({ sessionId, cwd: project, messages }), {
    recorded: 1,
    sessionId,
  });
  const merged = await svc.list({ sessionId, cwd: project, messages });
  assert.ok(merged.every((entry) => entry.available === true));
  assert.ok(dataDir.length > 0);
});

test('receipts are host-scoped: another machine never inherits them', async (t) => {
  const project = await fixture(t);
  const outside = await fixture(t, 'prime-public-api-out-');
  await writeFile(join(outside, 'shared.md'), 'shared\n');
  const dataDir = await fixture(t, 'prime-public-api-data-');
  const sessionId = 'sess-host-1';
  const messages = [{ role: 'user', text: `read [s](${slash(join(outside, 'shared.md'))})` }];
  const hostA = createPublicApiFiles({ machineId: 'machine-a', dataDir });
  t.after(() => hostA.close());
  await hostA.recordLocal({ sessionId, cwd: project, messages });
  const hostB = createPublicApiFiles({ machineId: 'machine-b', dataDir });
  t.after(() => hostB.close());
  const listedB = await hostB.list({ sessionId, cwd: project, messages });
  assert.equal(listedB.length, 1);
  assert.equal(listedB[0].available, false);
  assert.equal(listedB[0].originMachineId, null);
  assert.notEqual(listedB[0].id, (await hostA.list({ sessionId, cwd: project, messages }))[0].id);
});

test('recordLocal no-ops without links, validates input and tolerates corrupt receipts', async (t) => {
  const project = await fixture(t);
  const dataDir = await fixture(t, 'prime-public-api-data-');
  const svc = createPublicApiFiles({ machineId: 'machine-a', dataDir });
  t.after(() => svc.close());
  assert.deepEqual(
    await svc.recordLocal({
      sessionId: 'sess-empty-1',
      cwd: project,
      messages: [{ role: 'user', text: 'hello' }],
    }),
    { recorded: 0, sessionId: 'sess-empty-1' },
  );
  await assert.rejects(svc.recordLocal({ sessionId: 'bad id!', cwd: project, messages: [] }), {
    status: 400,
  });
  await assert.rejects(svc.recordLocal({ sessionId: 'sess-empty-1', cwd: 'relative', messages: [] }), {
    status: 400,
  });
  await svc.recordLocal({ sessionId: 'sess-empty-1', cwd: project, messages: 'nope' });
  const receiptFile = join(dataDir, 'public-api-file-receipts', 'sess-empty-1.json');
  await assert.rejects(readFile(receiptFile, 'utf8'));
  // Corrupt and oversized receipts fail closed as unknown provenance.
  await mkdir(join(dataDir, 'public-api-file-receipts'), { recursive: true });
  await writeFile(join(dataDir, 'public-api-file-receipts', 'sess-bad-1.json'), 'not json{');
  const listed = await svc.list({ sessionId: 'sess-bad-1', cwd: project, messages: [] });
  assert.deepEqual(listed, []);
});

test('close flushes queued record writes without awaiting each receipt', async (t) => {
  const project = await fixture(t);
  const outside = await fixture(t, 'prime-public-api-out-');
  await writeFile(join(outside, 'a.md'), 'a\n');
  await writeFile(join(outside, 'b.md'), 'b\n');
  const dataDir = await fixture(t, 'prime-public-api-data-');
  const svc = createPublicApiFiles({ machineId: 'machine-a', dataDir });
  const sessionId = 'sess-flush-1';
  const pending = [
    svc.recordLocal({
      sessionId,
      cwd: project,
      messages: [{ role: 'user', text: `[a](${slash(join(outside, 'a.md'))})` }],
    }),
    svc.recordLocal({
      sessionId,
      cwd: project,
      messages: [{ role: 'user', text: `[b](${slash(join(outside, 'b.md'))})` }],
    }),
  ];
  pending.forEach((task) => task.catch(() => {}));
  await svc.close();
  const settled = await Promise.all(pending);
  assert.deepEqual(settled.map((result) => result.recorded).sort(), [1, 1]);
  const fresh = createPublicApiFiles({ machineId: 'machine-a', dataDir });
  t.after(() => fresh.close());
  const listed = await fresh.list({
    sessionId,
    cwd: project,
    messages: [
      { role: 'user', text: `[a](${slash(join(outside, 'a.md'))}) and [b](${slash(join(outside, 'b.md'))})` },
    ],
  });
  assert.ok(listed.every((entry) => entry.available === true));
});

test('stored attachment bytes serve by uuid; missing bytes and missing dir stay unavailable', async (t) => {
  const project = await fixture(t);
  const attachmentDir = await fixture(t, 'prime-public-api-attachments-');
  const store = createFileStore(attachmentDir);
  const [saved] = await store.save(
    validateFiles([{ name: 'hello.txt', data: Buffer.from('attachment-bytes').toString('base64') }]),
  );
  const { svc } = await service(t, { attachmentDir });
  const sessionId = 'sess-attach-1';
  const messages = [
    {
      role: 'user',
      text: 'see attached',
      attachments: [{ type: 'file', id: saved.id, name: 'hello.txt', size: 16 }],
    },
    {
      role: 'assistant',
      text: 'inline image',
      attachments: [{ type: 'image', mimeType: 'image/png', data: 'AAA' }],
    },
  ];
  assert.deepEqual(extractAttachmentRefs(messages), [{ attachId: saved.id, name: 'hello.txt', size: 16 }]);
  const [entry] = await svc.list({ sessionId, cwd: project, messages });
  assert.equal(entry.kind, 'attachment');
  assert.equal(entry.available, true);
  assert.equal(entry.size, 16);
  assert.equal(entry.name, 'hello.txt');
  assert.equal(entry.originMachineId, 'machine-a');
  const url = await serve(t, (req, res) =>
    svc.download(req, res, { sessionId, cwd: project, messages, fileId: entry.id }),
  );
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'attachment-bytes');
  // Missing bytes: metadata without local content stays unavailable.
  const ghost = [
    {
      role: 'user',
      text: 'x',
      attachments: [
        {
          type: 'file',
          id: saved.id.slice(0, -1) + (saved.id.endsWith('0') ? '1' : '0'),
          name: 'ghost.txt',
          size: 3,
        },
      ],
    },
  ];
  const [missing] = await svc.list({ sessionId, cwd: project, messages: ghost });
  assert.equal(missing.available, false);
  assert.equal(missing.originMachineId, null);
  // No attachment dir configured: attachments never serve.
  const bare = createPublicApiFiles({
    machineId: 'machine-a',
    dataDir: await fixture(t, 'prime-public-api-data-'),
  });
  t.after(() => bare.close());
  const [unserved] = await bare.list({ sessionId, cwd: project, messages });
  assert.equal(unserved.available, false);
});

test('download serves bytes, head, single ranges and conditionals over http', async (t) => {
  const project = await fixture(t);
  const outside = await fixture(t, 'prime-public-api-out-');
  const content = Buffer.from('0123456789abcdef'.repeat(16));
  await writeFile(join(outside, 'data.bin'), content);
  const { svc } = await service(t);
  const sessionId = 'sess-http-1';
  const messages = [{ role: 'user', text: `fetch [data](${slash(join(outside, 'data.bin'))})` }];
  await svc.recordLocal({ sessionId, cwd: project, messages });
  const [entry] = await svc.list({ sessionId, cwd: project, messages });
  assert.equal(entry.available, true);
  const ctx = { sessionId, cwd: project, messages, fileId: entry.id };
  const url = await serve(t, (req, res) => svc.download(req, res, ctx));
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-length'), String(content.length));
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(full.headers.get('content-type'), 'application/octet-stream');
  assert.ok(full.headers.get('content-disposition').startsWith('attachment;'));
  assert.ok(full.headers.get('etag'));
  assert.ok(full.headers.get('last-modified'));
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), content);
  const etag = full.headers.get('etag');
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(content.length));
  assert.equal(await head.text(), '');
  const range = await fetch(url, { headers: { Range: 'bytes=0-9' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-9/${content.length}`);
  assert.equal(await range.text(), '0123456789');
  const suffix = await fetch(url, { headers: { Range: 'bytes=-4' } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), content.subarray(-4).toString());
  const openEnded = await fetch(url, { headers: { Range: `bytes=${content.length - 4}-` } });
  assert.equal(openEnded.status, 206);
  assert.equal(await openEnded.text(), content.subarray(-4).toString());
  const pastEnd = await fetch(url, { headers: { Range: `bytes=${content.length}-` } });
  assert.equal(pastEnd.status, 416);
  assert.equal(pastEnd.headers.get('content-range'), `bytes */${content.length}`);
  const farPastEnd = await fetch(url, { headers: { Range: 'bytes=5000000000-' } });
  assert.equal(farPastEnd.status, 416);
  const rangedEtag = await fetch(url, { headers: { Range: 'bytes=0-9', 'If-Range': etag } });
  assert.equal(rangedEtag.status, 206);
  const staleRange = await fetch(url, { headers: { Range: 'bytes=0-9', 'If-Range': '"stale"' } });
  assert.equal(staleRange.status, 200);
  assert.equal((await staleRange.arrayBuffer()).byteLength, content.length);
  const stalePastEnd = await fetch(url, { headers: { Range: 'bytes=5000000000-', 'If-Range': '"stale"' } });
  assert.equal(stalePastEnd.status, 200);
  assert.equal((await stalePastEnd.arrayBuffer()).byteLength, content.length);
  assert.equal((await fetch(url, { headers: { Range: '' } })).status, 416);
  assert.equal((await fetch(url, { headers: { 'If-Match': '' } })).status, 412);
  const freshRange = await fetch(url, {
    headers: { Range: 'bytes=0-9', 'If-Range': new Date(Date.now() + 60000).toUTCString() },
  });
  assert.equal(freshRange.status, 206);
  const notModified = await fetch(url, { headers: { 'If-None-Match': etag } });
  assert.equal(notModified.status, 304);
  assert.equal(await notModified.text(), '');
  const sinceFuture = await fetch(url, {
    headers: { 'If-Modified-Since': new Date(Date.now() + 60000).toUTCString() },
  });
  assert.equal(sinceFuture.status, 304);
  const sincePast = await fetch(url, {
    headers: { 'If-Modified-Since': new Date(946684800000).toUTCString() },
  });
  assert.equal(sincePast.status, 200);
  const multi = await fetch(url, { headers: { Range: 'bytes=0-1,3-4' } });
  assert.equal(multi.status, 416);
  assert.equal(multi.headers.get('content-range'), `bytes */${content.length}`);
  const bad = await fetch(url, { headers: { Range: 'bytes=abc' } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), `bytes */${content.length}`);
  // The rejected ranges never leak bytes and always release the file handle.
  await rm(join(outside, 'data.bin'), { maxRetries: 20, retryDelay: 50 });
  const unknown = await fetch(`${url}/nope`.slice(0, url.length), {
    method: 'POST',
  });
  assert.equal(unknown.status, 405);
});

test('unknown file ids 404 and disappeared files report file_missing', async (t) => {
  const project = await fixture(t);
  const outside = await fixture(t, 'prime-public-api-out-');
  const target = join(outside, 'volatile.md');
  await writeFile(target, 'here\n');
  const { svc } = await service(t);
  const sessionId = 'sess-volatile-1';
  const messages = [{ role: 'user', text: `watch [v](${slash(target)})` }];
  await svc.recordLocal({ sessionId, cwd: project, messages });
  const [entry] = await svc.list({ sessionId, cwd: project, messages });
  assert.equal(entry.available, true);
  const ctx = { sessionId, cwd: project, messages, fileId: entry.id };
  const url = await serve(t, (req, res) => svc.download(req, res, ctx));
  assert.equal((await fetch(url)).status, 200);
  await assert.rejects(
    svc.download(
      { method: 'GET', headers: {} },
      { writeHead: () => assert.fail('must not respond') },
      {
        ...ctx,
        fileId: 'deadbeefdeadbeefdeadbeefdeadbeef',
      },
    ),
    (error) => error.code === 'unknown_file' && error.status === 404,
  );
  await rm(target);
  const relisted = await svc.list({ sessionId, cwd: project, messages });
  assert.equal(relisted[0].available, false);
  assert.equal(relisted[0].originMachineId, 'machine-a');
  const gone = await fetch(url);
  assert.equal(gone.status, 404);
  assert.deepEqual(await gone.json(), { error: 'file_missing' });
});

test('range parsing handles suffix, open, invalid and very large logical offsets', () => {
  assert.deepEqual(parseHttpRange(undefined, 100), null);
  assert.deepEqual(parseHttpRange('', 100), { error: 'invalid' });
  assert.deepEqual(parseHttpRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseHttpRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseHttpRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseHttpRange('bytes=-200', 100), { start: 0, end: 99 });
  assert.deepEqual(parseHttpRange('bytes=0-999', 100), { start: 0, end: 99 });
  assert.deepEqual(parseHttpRange('bytes=100-', 100), { error: 'unsatisfiable' });
  assert.deepEqual(parseHttpRange('bytes=0-0', 0), { error: 'unsatisfiable' });
  assert.deepEqual(parseHttpRange('bytes=9-3', 100), { error: 'invalid' });
  assert.deepEqual(parseHttpRange('bytes=0-1,3-4', 100), { error: 'invalid' });
  assert.deepEqual(parseHttpRange('bytes=abc', 100), { error: 'invalid' });
  assert.deepEqual(parseHttpRange('items=0-9', 100), { error: 'invalid' });
  // Offsets past 4 GiB stay exact without any large fixture on disk.
  assert.deepEqual(parseHttpRange('bytes=5000000000-5000000009', 6000000000), {
    start: 5000000000,
    end: 5000000009,
  });
  assert.deepEqual(parseHttpRange('bytes=5999999999-', 6000000000), {
    start: 5999999999,
    end: 5999999999,
  });
  assert.deepEqual(parseHttpRange('bytes=-16', 6000000000), {
    start: 5999999984,
    end: 5999999999,
  });
  assert.deepEqual(parseHttpRange('bytes=6000000000-', 6000000000), { error: 'unsatisfiable' });
});

test('streaming aborts cleanly when the response closes early', async (t) => {
  const dir = await fixture(t);
  const file = join(dir, 'big.bin');
  await writeFile(file, Buffer.alloc(512 * 1024, 7));
  const handle = await open(file, 'r');
  const sink = new PassThrough();
  const pending = streamFileToResponse(sink, handle, { start: 0, end: 512 * 1024 - 1 });
  // The unread sink stalls on backpressure; simulate the parent destroying res.
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
  sink.emit('close');
  await assert.rejects(pending, (error) => error && error.code === 'client_aborted');
  await rm(file, { maxRetries: 20, retryDelay: 50 });
});

test('streaming a small range completes with exact bytes and releases the handle', async (t) => {
  const dir = await fixture(t);
  const file = join(dir, 'small.bin');
  await writeFile(file, Buffer.from('0123456789abcdef'));
  const handle = await open(file, 'r');
  const sink = new PassThrough();
  const chunks = [];
  sink.on('data', (chunk) => chunks.push(chunk));
  const result = await streamFileToResponse(sink, handle, { start: 4, end: 9 });
  assert.deepEqual(result, { bytesSent: 6 });
  assert.equal(Buffer.concat(chunks).toString(), '456789');
  await rm(file);
});

test('attachment filenames are sanitized in content disposition', async (t) => {
  assert.equal(sanitizeDownloadName('../../evil.txt'), 'evil.txt');
  assert.equal(sanitizeDownloadName('a"b\\c'), 'c');
  assert.equal(sanitizeDownloadName(''), 'file');
  const project = await fixture(t);
  const attachmentDir = await fixture(t, 'prime-public-api-attachments-');
  const store = createFileStore(attachmentDir);
  const [saved] = await store.save(
    validateFiles([{ name: 'a"b.txt', data: Buffer.from('x').toString('base64') }]),
  );
  const { svc } = await service(t, { attachmentDir });
  const sessionId = 'sess-name-1';
  const messages = [
    { role: 'user', text: 'q', attachments: [{ type: 'file', id: saved.id, name: 'a"b.txt', size: 1 }] },
  ];
  const [entry] = await svc.list({ sessionId, cwd: project, messages });
  assert.equal(entry.available, true);
  assert.equal(entry.name, 'ab.txt');
  const url = await serve(t, (req, res) =>
    svc.download(req, res, { sessionId, cwd: project, messages, fileId: entry.id }),
  );
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const disposition = response.headers.get('content-disposition');
  assert.ok(disposition.startsWith('attachment;'));
  assert.ok(!disposition.includes('"b'));
  assert.ok(disposition.includes("filename*=UTF-8''"));
});

test('a response already closed during file validation releases the opened descriptor', async (t) => {
  const dir = await fixture(t);
  const path = join(dir, 'closed.txt');
  await writeFile(path, 'closed');
  for (const state of ['destroyed', 'ended']) {
    const handle = await open(path, 'r');
    const response = new PassThrough();
    if (state === 'destroyed') response.destroy();
    else response.end();
    await assert.rejects(streamFileToResponse(response, handle, { start: 0, end: 5 }), {
      code: 'client_aborted',
    });
    assert.equal(handle.fd, -1);
    await assert.rejects(handle.stat(), { code: 'EBADF' });
  }
});

test('streaming retains offsets above 4 GiB without a giant fixture', async () => {
  const response = new PassThrough();
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  let closed = false;
  const offset = 5 * 1024 ** 3;
  const handle = {
    createReadStream(options) {
      assert.deepEqual(options, { start: offset, end: offset + 3 });
      return Readable.from([Buffer.from('tail')]);
    },
    async close() {
      closed = true;
    },
  };
  await streamFileToResponse(response, handle, { start: offset, end: offset + 3 });
  assert.equal(Buffer.concat(chunks).toString(), 'tail');
  assert.equal(closed, true);
});

test('ETags preserve 64-bit file identities and nanosecond change times', () => {
  const stat = { dev: 1n, ino: 9007199254740993n, size: 5, mtimeNs: 10n, ctimeNs: 20n };
  const etag = buildEtag(stat);
  assert.match(etag, /9007199254740993/);
  assert.notEqual(etag, buildEtag({ ...stat, ino: stat.ino + 1n }));
  assert.notEqual(etag, buildEtag({ ...stat, ctimeNs: 21n }));
});

test('a protected directory alias cannot expose its real target', async (t) => {
  const dir = await fixture(t);
  const hidden = join(dir, 'private-real');
  const alias = join(dir, 'private-alias');
  await mkdir(hidden);
  await writeFile(join(hidden, 'settings.json'), 'private');
  await symlink(hidden, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const messages = [{ text: `[settings](${slash(join(hidden, 'settings.json'))})` }];
  const { svc } = await service(t, { protectedRoots: [alias], getLocalOrigin: () => 'machine-a' });
  const context = { sessionId: 'protected-alias', cwd: dir, messages };
  assert.equal((await svc.recordLocal(context)).recorded, 0);
  const files = await svc.list(context);
  assert.equal(files[0].available, false);
  const address = await serve(t, (req, res) => svc.download(req, res, { ...context, fileId: files[0].id }));
  assert.equal((await fetch(address)).status, 403);
});

test('factory and listing inputs are validated', async (t) => {
  assert.throws(() => createPublicApiFiles({}), TypeError);
  assert.throws(() => createPublicApiFiles({ machineId: 'm', protectedRoots: ['relative'] }), TypeError);
  const { svc } = await service(t);
  await assert.rejects(svc.list({ sessionId: '', cwd: 'C:\\x', messages: [] }), { status: 400 });
  await assert.rejects(svc.list({ sessionId: 'sess-ok-1', cwd: 'relative', messages: [] }), { status: 400 });
  await assert.rejects(svc.list({ sessionId: 'sess-ok-1', cwd: 'C:\\x' }), { status: 500 });
});

test('if-match and if-unmodified-since gate the body with 412 before any range', async (t) => {
  const project = await fixture(t);
  const outside = await fixture(t, 'prime-public-api-out-');
  const target = join(outside, 'guarded.bin');
  const content = Buffer.from('0123456789abcdef');
  await writeFile(target, content);
  const { svc } = await service(t);
  const sessionId = 'sess-precond-1';
  const messages = [{ role: 'user', text: `fetch [g](${slash(target)})` }];
  await svc.recordLocal({ sessionId, cwd: project, messages });
  const [entry] = await svc.list({ sessionId, cwd: project, messages });
  assert.equal(entry.available, true);
  const ctx = { sessionId, cwd: project, messages, fileId: entry.id };
  const url = await serve(t, (req, res) => svc.download(req, res, ctx));
  const etag = (await fetch(url)).headers.get('etag');
  assert.ok(etag);
  const future = new Date(Date.now() + 86400000).toUTCString();
  const past = new Date(946684800000).toUTCString();
  // If-Match: strong exact match and '*' pass; weak or stale validators fail.
  assert.equal((await fetch(url, { headers: { 'If-Match': etag } })).status, 200);
  assert.equal((await fetch(url, { headers: { 'If-Match': '*' } })).status, 200);
  assert.equal((await fetch(url, { headers: { 'If-Match': '"stale"' } })).status, 412);
  assert.equal((await fetch(url, { headers: { 'If-Match': `W/${etag}` } })).status, 412);
  assert.equal((await fetch(url, { headers: { 'If-Match': `${etag}, "other"` } })).status, 200);
  // If-Unmodified-Since: only without If-Match; unparseable dates are ignored.
  assert.equal((await fetch(url, { headers: { 'If-Unmodified-Since': future } })).status, 200);
  assert.equal((await fetch(url, { headers: { 'If-Unmodified-Since': past } })).status, 412);
  assert.equal((await fetch(url, { headers: { 'If-Unmodified-Since': 'not-a-date' } })).status, 200);
  // Precedence: If-Match beats If-None-Match; If-Unmodified-Since beats it too.
  assert.equal((await fetch(url, { headers: { 'If-Match': '"stale"', 'If-None-Match': etag } })).status, 412);
  assert.equal(
    (await fetch(url, { headers: { 'If-Unmodified-Since': past, 'If-None-Match': etag } })).status,
    412,
  );
  // A failed precondition wins over ranges: 412 with no bytes, handle released.
  const ranged = await fetch(url, { headers: { 'If-Match': '"stale"', Range: 'bytes=0-3' } });
  assert.equal(ranged.status, 412);
  assert.equal(await ranged.text(), '');
  // HEAD honors preconditions with headers only and no bytes.
  const head412 = await fetch(url, { method: 'HEAD', headers: { 'If-Match': '"stale"' } });
  assert.equal(head412.status, 412);
  assert.equal(await head412.text(), '');
  const head200 = await fetch(url, { method: 'HEAD', headers: { 'If-Match': etag } });
  assert.equal(head200.status, 200);
  assert.equal(head200.headers.get('content-length'), String(content.length));
  await rm(target, { maxRetries: 20, retryDelay: 50 });
});
