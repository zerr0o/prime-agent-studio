import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Focused imageModel composer guard proof. Local fixture page only, no model
// calls, no Studio server. The fixture mirrors the app lifecycle: onChange
// drives update(), update() runs after assignment, and the test waits for the
// attach control to enable (draft storage ready) before attaching.
// Variant refuse: text-only model, no route (truthful refusal, send blocked).
// Variant route: server-validated imageModel id (attachments allowed), then an
// immediate route clear plus another attach on the SAME page (refusal returns,
// send stays blocked).
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
await mkdir('.local/image-guard', { recursive: true });
await writeFile('.local/image-guard/guard.png', png);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/guard') {
    const routed = url.searchParams.get('variant') === 'route';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><body>
<form id="composer-form"><textarea id="composer"></textarea></form>
<script type="module">
import { createImageComposer } from '/public/images.js';
const context = {
  key: 'guard',
  available: true,
  disabled: false,
  input: ['text'],
  ...( ${routed ? 'true' : 'false'} ? { imageModel: 'test/vision' } : {}),
};
let composer = null;
composer = createImageComposer({
  getContext: () => context,
  onChange: () => composer?.update(),
  onError: (e) => {
    window.__guardError = String(e?.message || e);
  },
});
window.__composer = composer;
window.__setImageModel = (value) => {
  if (value) context.imageModel = value;
  else delete context.imageModel;
  composer.update();
};
composer.update();
</script></body></html>`);
    return;
  }
  if (url.pathname.startsWith('/public/')) {
    const name = url.pathname.slice('/public/'.length);
    if (!/^[A-Za-z0-9_.-]+\.js$/.test(name)) return res.writeHead(404).end();
    try {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(join('public', name)));
      return;
    } catch {
      return res.writeHead(404).end();
    }
  }
  res.writeHead(404).end();
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function waitFor(page, fn, what, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn)) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for guard: ${what}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}
const note = (page) => page.evaluate(() => document.querySelector('.image-draft-note')?.textContent || '');
const count = (page) => page.evaluate(() => window.__composer.snapshot().images.length);
try {
  for (const variant of ['refuse', 'route']) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log(`pageerror(${variant}):`, String(e).slice(0, 300)));
    await page.goto(`${base}/guard?variant=${variant}`, { waitUntil: 'load', timeout: 30000 });
    await waitFor(page, () => !!window.__composer, 'composer ready');
    await waitFor(page, () => !document.getElementById('attach-images')?.disabled, 'draft storage ready');
    await page.setInputFiles('#image-files', '.local/image-guard/guard.png');
    await waitFor(page, () => window.__composer.hasImages(), 'attached image');
    const blocked = await page.evaluate(() => window.__composer.blocked());
    if (variant === 'refuse') {
      assert.equal(blocked, true, 'text-only model without imageModel must block send');
      assert.ok((await note(page)).length > 0, 'truthful refusal note stays visible');
      console.log(`guard refuse: blocked=true note=${JSON.stringify((await note(page)).slice(0, 60))}`);
    } else {
      assert.equal(blocked, false, 'usable imageModel route must allow attachments');
      console.log(`guard route: blocked=false note=${JSON.stringify((await note(page)).slice(0, 60))}`);
      // Immediate route clear plus another attach on the SAME page.
      await page.evaluate(() => window.__setImageModel(null));
      assert.equal(
        await page.evaluate(() => window.__composer.blocked()),
        true,
        'clearing the route must block send immediately',
      );
      assert.ok((await note(page)).length > 0, 'refusal note returns immediately after clear');
      await page.setInputFiles('#image-files', '.local/image-guard/guard.png');
      await waitFor(page, () => window.__composer.snapshot().images.length === 2, 'second image');
      assert.equal(
        await page.evaluate(() => window.__composer.blocked()),
        true,
        'send stays blocked after clear even with another attach',
      );
      await page.evaluate(() => window.__setImageModel('test/vision'));
      assert.equal(
        await page.evaluate(() => window.__composer.blocked()),
        false,
        'restoring the route must allow send immediately',
      );
      console.log(`guard route clear/add on same page: counts=${await count(page)} gate flips ok`);
    }
    await page.close();
  }
  console.log(
    'PASS: imageModel composer guard (refuse without route, allow with route, immediate clear/add).',
  );
} finally {
  await browser.close();
  server.close();
}
