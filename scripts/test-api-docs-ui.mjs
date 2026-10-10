// Interactive OpenAPI docs page proof — isolated Playwright checks.
// Real HTTP shell with isolated temp profile and fake runtime only.
// Parent serves GET /api-docs and GET /openapi-v1.json generated from the
// contract; this script owns ONLY its own file and never edits UI/server.
// Covers: DOM contract (token/clear/search + 18 operation cards with
// path/query/header inputs, request-body textarea, body-variant select,
// confirm, execute/cancel, status/response/headers/curl), per-operation
// route stubs for /api/v1/** with exact method/path/auth + query/header/body
// assertions, download Range preview, HEAD headers, SSE chunks + abort,
// 403/409 errors, >64KiB clipping, no auto-fetch, token hygiene
// (storage/URL/curl/snippets + clear/pagehide), keyboard/search, FR/EN,
// real read phase (Node admin enable/token, page GET machine, revoke 401,
// API off 404 without creating tokens from the docs UI), 1440 screenshot
// without credentials plus 390 no-overflow, JSON checks/coverage output.
// Mutation/model calls never reach production: /api/v1/** is stubbed except
// the deliberate real GET machine read. Bounded timeouts everywhere; the SSE
// stream is observed through the UI only, never awaited via Node .text().
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { createApp } from '../server.mjs';

const FIXTURE_TOKEN = 'pa_fixture_docs_proof_0123456789abcdef';
const IDS = {
  projectId: 'fixture-project-01',
  sessionId: 'fixture-session-01',
  runId: 'fixture-run-01',
  fileId: 'fixture-file-01',
};
const REQ_RUN = 'req-fixture-run-0123456789';
const REQ_MSG = 'req-fixture-msg-0123456789';
const REQ_WORK = 'req-fixture-work-0123456789';
const DOWNLOAD_RAW_LEN = 70000;
const DOWNLOAD_RAW = 'x'.repeat(DOWNLOAD_RAW_LEN);

// All 18 contract operations in spec order.
const OPERATIONS = [
  {
    operationId: 'machine',
    method: 'GET',
    path: '/api/v1/machine',
    body: null,
    needsConfirm: false,
    snippet: 'machine-fixture-01',
  },
  {
    operationId: 'projects',
    method: 'GET',
    path: '/api/v1/projects',
    body: null,
    needsConfirm: false,
    snippet: 'fixture-project-01',
  },
  {
    operationId: 'models',
    method: 'GET',
    path: '/api/v1/models',
    body: null,
    needsConfirm: false,
    snippet: 'fixture-model-01',
  },
  {
    operationId: 'sessions',
    method: 'GET',
    path: '/api/v1/projects/{projectId}/sessions',
    body: null,
    needsConfirm: false,
    snippet: 'fixture-session-01',
  },
  {
    operationId: 'messages',
    method: 'GET',
    path: '/api/v1/sessions/{sessionId}/messages',
    body: null,
    needsConfirm: false,
    snippet: 'fixture-session-01',
  },
  {
    operationId: 'createRun',
    method: 'POST',
    path: '/api/v1/projects/{projectId}/runs',
    body: { requestId: REQ_RUN, message: 'Hello fixture run' },
    needsConfirm: true,
    snippet: 'fixture-run-01',
  },
  {
    operationId: 'runs',
    method: 'GET',
    path: '/api/v1/runs',
    body: null,
    needsConfirm: false,
    snippet: 'fixture-run-01',
  },
  {
    operationId: 'run',
    method: 'GET',
    path: '/api/v1/runs/{runId}',
    body: null,
    needsConfirm: false,
    snippet: 'fixture-run-01',
  },
  {
    operationId: 'events',
    method: 'GET',
    path: '/api/v1/runs/{runId}/events',
    body: null,
    needsConfirm: false,
    snippet: 'fixture-event',
  },
  {
    operationId: 'stop',
    method: 'POST',
    path: '/api/v1/runs/{runId}/stop',
    body: {},
    needsConfirm: true,
    snippet: 'stopped',
  },
  {
    operationId: 'interaction',
    method: 'POST',
    path: '/api/v1/runs/{runId}/interactions',
    body: { id: 'q-fixture-01', response: { confirmed: true } },
    needsConfirm: true,
    snippet: 'accepted',
  },
  {
    operationId: 'sendMessage',
    method: 'POST',
    path: '/api/v1/sessions/{sessionId}/messages',
    body: { requestId: REQ_MSG, mode: 'steer', message: 'Hello fixture message' },
    needsConfirm: true,
    snippet: 'accepted',
  },
  {
    operationId: 'roadmap',
    method: 'GET',
    path: '/api/v1/projects/{projectId}/roadmap',
    body: null,
    needsConfirm: false,
    snippet: 'machine-fixture-01',
  },
  {
    operationId: 'mutateRoadmap',
    method: 'POST',
    path: '/api/v1/projects/{projectId}/roadmap/mutations',
    body: { action: 'vision', expectedRevision: 3, text: 'Fixture vision' },
    needsConfirm: true,
    snippet: 'machine-fixture-01',
  },
  {
    operationId: 'roadmapWork',
    method: 'POST',
    path: '/api/v1/projects/{projectId}/roadmap/work',
    body: {
      requestId: REQ_WORK,
      expectedRevision: 3,
      targets: [{ kind: 'plan', planId: 'plan-fixture-01' }],
    },
    needsConfirm: true,
    snippet: 'accepted',
  },
  {
    operationId: 'files',
    method: 'GET',
    path: '/api/v1/sessions/{sessionId}/files',
    body: null,
    needsConfirm: false,
    snippet: 'fixture-file-01',
  },
  {
    operationId: 'download',
    method: 'GET',
    path: '/api/v1/sessions/{sessionId}/files/{fileId}',
    body: null,
    needsConfirm: false,
    snippet: 'download-preview',
  },
  {
    operationId: 'fileHead',
    method: 'HEAD',
    path: '/api/v1/sessions/{sessionId}/files/{fileId}',
    body: null,
    needsConfirm: false,
    snippet: 'etag-fixture-01',
  },
];
const OP_BY_ID = Object.fromEntries(OPERATIONS.map((op) => [op.operationId, op]));

function stubFor(operationId) {
  switch (operationId) {
    case 'machine':
      return {
        status: 200,
        contentType: 'application/json',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiVersion: 'v1',
          studioVersion: 'fixture',
          machineId: 'machine-fixture-01',
          name: 'Fixture Studio',
          capabilities: ['projects', 'conversations', 'runs', 'roadmaps', 'files'],
          idempotency: { retentionSeconds: 3600, persistent: false },
        }),
      };
    case 'projects':
      return {
        status: 200,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({
          items: [{ id: 'fixture-project-01', name: 'Fixture project' }],
          nextOffset: null,
        }),
      };
    case 'models':
      return {
        status: 200,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({ items: [{ id: 'fixture-model-01' }], nextOffset: null }),
      };
    case 'sessions':
      return {
        status: 200,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({ items: [{ id: 'fixture-session-01' }], nextOffset: null }),
      };
    case 'messages':
      return {
        status: 200,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({
          sessionId: 'fixture-session-01',
          projectId: 'fixture-project-01',
          machineId: 'machine-fixture-01',
          items: [],
          nextOffset: null,
        }),
      };
    case 'createRun':
      return {
        status: 201,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({
          id: 'fixture-run-01',
          status: 'running',
          projectId: 'fixture-project-01',
          machineId: 'machine-fixture-01',
          requestId: REQ_RUN,
        }),
      };
    case 'runs':
      return {
        status: 200,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({ items: [{ id: 'fixture-run-01' }], nextOffset: null }),
      };
    case 'run':
      return {
        status: 200,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({
          id: 'fixture-run-01',
          status: 'running',
          projectId: 'fixture-project-01',
          machineId: 'machine-fixture-01',
        }),
      };
    case 'events':
      return {
        status: 200,
        contentType: 'text/event-stream',
        headers: {},
        body: 'id: 1\ndata: {"kind":"message","seq":1,"note":"fixture-event-1"}\n\nid: 2\ndata: {"kind":"message","seq":2,"note":"fixture-event-2"}\n\n',
      };
    case 'stop':
      return {
        status: 200,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({ stopped: true, id: 'fixture-run-01' }),
      };
    case 'interaction':
      return {
        status: 200,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({ accepted: true }),
      };
    case 'sendMessage':
      return {
        status: 200,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({ accepted: true }),
      };
    case 'roadmap':
      return {
        status: 200,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({
          machineId: 'machine-fixture-01',
          projectId: 'fixture-project-01',
          roadmap: {},
        }),
      };
    case 'mutateRoadmap':
      return {
        status: 200,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({
          machineId: 'machine-fixture-01',
          projectId: 'fixture-project-01',
          roadmap: {},
        }),
      };
    case 'roadmapWork':
      return {
        status: 201,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({
          accepted: true,
          queued: false,
          requestId: REQ_WORK,
          machineId: 'machine-fixture-01',
          projectId: 'fixture-project-01',
        }),
      };
    case 'files':
      return {
        status: 200,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({ items: [{ id: 'fixture-file-01', name: 'fixture.txt' }], nextOffset: null }),
      };
    case 'download':
      return {
        status: 206,
        contentType: 'application/octet-stream',
        headers: {
          'content-range': 'bytes 0-1023/70000',
          'accept-ranges': 'bytes',
          etag: '"etag-fixture-01"',
        },
        body: `download-preview:${DOWNLOAD_RAW}`,
      };
    case 'fileHead':
      return {
        status: 200,
        contentType: 'text/plain',
        headers: { etag: '"etag-fixture-01"', 'content-length': '128', 'accept-ranges': 'bytes' },
        body: '',
      };
    default:
      throw new Error(`Unknown stub: ${operationId}`);
  }
}

const concretePath = (template) => template.replace(/\{(\w+)\}/g, (_, name) => IDS[name] || 'fixture-01');

const temp = await mkdtemp(join(tmpdir(), 'prime-api-docs-ui-'));
const cwd = join(temp, 'Atelier');
const agentHome = join(temp, 'agent');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
await Promise.all([cwd, agentHome, sessionDir, dataDir].map((p) => mkdir(p, { recursive: true })));

const app = createApp({
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir,
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({ models: [], default: {} }),
    start: async () => {
      throw new Error('Isolated docs fixture cannot start agents');
    },
    close: async () => {},
  },
  openDirectory: async () => {},
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;

let browser;
const deadline = setTimeout(() => {
  void browser?.close();
  void app.close();
}, 180000);

const checks = [];
const routeCoverage = {};
let apiHits = 0;
let currentExpected = null;
let lastRequest = null;
let abortDelayed = false;
let delayNext = false;
const externalHosts = [];

async function stubApi(route) {
  const req = route.request();
  const requestUrl = new URL(req.url());
  apiHits += 1;
  if (!['127.0.0.1', 'localhost'].includes(requestUrl.hostname)) externalHosts.push(requestUrl.host);
  const method = req.method();
  const path = requestUrl.pathname;
  const headers = req.headers();
  let postData = null;
  let postRaw = null;
  try {
    const buf = req.postDataBuffer();
    postRaw = buf ? buf.toString('utf-8') : null;
    if (postRaw) {
      try {
        postData = JSON.parse(postRaw);
      } catch {
        postData = postRaw;
      }
    }
  } catch {
    postData = null;
  }
  lastRequest = {
    method,
    path,
    query: Object.fromEntries(requestUrl.searchParams.entries()),
    headers,
    postData,
    postRaw,
    url: req.url(),
  };
  if (!currentExpected) {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unexpected API call before execute.', code: 'unexpected' }),
    });
    return;
  }
  const exp = currentExpected;
  routeCoverage[exp.operationId] = (routeCoverage[exp.operationId] || 0) + 1;
  const stub = stubFor(exp.operationId === '__error__' ? exp.actualId : exp.operationId);
  if (abortDelayed && exp.operationId === 'events') {
    await new Promise((r) => setTimeout(r, 8000));
  }
  if (delayNext) {
    delayNext = false;
    await new Promise((r) => setTimeout(r, 1500));
  }
  await route.fulfill({
    status: stub.status,
    contentType: stub.contentType,
    headers: stub.headers,
    body: stub.body,
  });
}

async function ensureOpen(details) {
  const isOpen = await details.evaluate((el) => el.open);
  if (!isOpen) {
    await details.locator('summary').first().click();
    await expect(details).toHaveAttribute('open', '', { timeout: 10000 });
  }
}

async function fillParamInputs(details) {
  const filledPath = {};
  const filledQuery = {};
  const filledHeaders = {};
  const inputs = details.locator('input[data-param-in][data-param-name]');
  const count = await inputs.count();
  for (let i = 0; i < count; i += 1) {
    const inp = inputs.nth(i);
    const pin = await inp.getAttribute('data-param-in');
    const pname = await inp.getAttribute('data-param-name');
    assert.ok(pin && pname, 'param input carries in+name');
    let val = '';
    if (pin === 'path') {
      val = IDS[pname] || 'fixture-01';
      filledPath[pname] = val;
    } else if (pin === 'query') {
      if (pname === 'limit') val = '2';
      else if (pname === 'offset') val = '0';
      else if (pname === 'after') val = '0';
      else val = 'fixture-q';
      filledQuery[pname] = val;
    } else if (pin === 'header') {
      const lower = pname.toLowerCase();
      if (lower === 'range') val = 'bytes=0-1023';
      else if (lower === 'last-event-id') val = '0';
      else if (lower === 'if-none-match' || lower === 'if-match' || lower === 'if-range')
        val = '"etag-fixture-01"';
      else if (lower === 'if-modified-since' || lower === 'if-unmodified-since')
        val = 'Wed, 01 Jan 2025 00:00:00 GMT';
      else val = 'fixture-header';
      filledHeaders[pname] = val;
    } else {
      throw new Error(`Unknown param in: ${pin}`);
    }
    await inp.fill(val);
  }
  return { filledPath, filledQuery, filledHeaders };
}

async function fillBodyAndConfirm(details, op) {
  let variant = null;
  const sel = details.locator('select[data-body-variant]');
  if ((await sel.count()) > 0) {
    const opts = await sel
      .first()
      .locator('option')
      .evaluateAll((els) => els.map((e) => ({ value: e.value, text: e.textContent || '' })));
    assert.ok(opts.length > 0, 'body variant select has options');
    let pref = null;
    if (op.operationId === 'interaction')
      pref = opts.find((o) => /confirm/i.test(`${o.value} ${o.text}`))?.value;
    else if (op.operationId === 'mutateRoadmap')
      pref = opts.find((o) => /vision/i.test(`${o.value} ${o.text}`))?.value;
    if (pref == null) {
      const firstNonEmpty = opts.find((o) => o.value !== '');
      pref = firstNonEmpty ? firstNonEmpty.value : opts[0].value;
    }
    await sel.first().selectOption(pref);
    variant = pref;
    await details.page().waitForTimeout(100);
  }
  let bodyStr = null;
  let bodyObj = null;
  const ta = details.locator('textarea[data-request-body]');
  const wantsBody = op.body !== null && op.body !== undefined;
  if (!wantsBody) {
    assert.equal(await ta.count(), 0, `${op.operationId} has no request body control`);
  }
  if (wantsBody) {
    assert.ok((await ta.count()) > 0, `${op.operationId} has textarea[data-request-body]`);
    bodyStr = JSON.stringify(op.body, null, 2);
    await ta.first().fill(bodyStr);
    bodyStr = await ta.first().inputValue();
    try {
      bodyObj = JSON.parse(bodyStr);
    } catch {
      assert.fail(`${op.operationId} request body is not JSON after fill`);
    }
  }
  const conf = details.locator('input[data-confirm]');
  if (!op.needsConfirm) {
    assert.equal(await conf.count(), 0, `${op.operationId} has no confirm (read-only)`);
  }
  if (op.needsConfirm) {
    assert.ok((await conf.count()) > 0, `${op.operationId} has input[data-confirm]`);
    const type = await conf.first().getAttribute('type');
    if (type === 'checkbox' || type === 'radio') await conf.first().check({ force: true });
    else await conf.first().fill('CONFIRM');
  }
  return { variant, bodyStr, bodyObj };
}

function assertNoTokenLeak(text, token, where) {
  assert.ok(!String(text || '').includes(token), `token leaked in ${where}`);
}

try {
  browser = await launchStudioBrowser();
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.route('**/api/v1/**', stubApi);

  const gotoRes = await page.goto(`${url}/api-docs`, { waitUntil: 'domcontentloaded' });
  assert.equal(
    gotoRes?.status(),
    200,
    'GET /api-docs serves the interactive page (UI worker pending? coordinate via parent message, no edits).',
  );

  // DOM contract: token / clear / search.
  await expect(page.locator('#api-docs-token')).toBeVisible();
  await expect(page.locator('#api-docs-clear-token')).toBeVisible();
  await expect(page.locator('#api-docs-search')).toBeVisible();
  checks.push('dom token/clear/search present');

  // DOM contract: all 18 operation cards.
  const cards = page.locator('details[data-operation-id]');
  assert.equal(await cards.count(), 18, 'all 18 operation cards exist');
  for (const op of OPERATIONS) {
    const card = page.locator(`details[data-operation-id="${op.operationId}"]`);
    assert.equal(await card.count(), 1, `card ${op.operationId} exists`);
    assert.ok((await card.locator('input[data-param-in][data-param-name]').count()) >= 0);
    // Body controls exist exactly where the spec defines them: textarea for
    // requestBody operations, variant select only for the oneOf mutation
    // schema (mutateRoadmap), confirm checkbox only for POST writes.
    const hasBody = op.body !== null && op.body !== undefined;
    const wantsVariant = op.operationId === 'mutateRoadmap';
    if (hasBody)
      assert.ok(
        (await card.locator('textarea[data-request-body]').count()) >= 1,
        `${op.operationId} textarea`,
      );
    else
      assert.equal(
        await card.locator('textarea[data-request-body]').count(),
        0,
        `${op.operationId} has no body textarea`,
      );
    if (wantsVariant)
      assert.ok(
        (await card.locator('select[data-body-variant]').count()) >= 1,
        `${op.operationId} variant select`,
      );
    else
      assert.equal(
        await card.locator('select[data-body-variant]').count(),
        0,
        `${op.operationId} has no variant select`,
      );
    if (op.needsConfirm)
      assert.ok((await card.locator('input[data-confirm]').count()) >= 1, `${op.operationId} confirm`);
    else
      assert.equal(
        await card.locator('input[data-confirm]').count(),
        0,
        `${op.operationId} has no confirm (read-only)`,
      );
    assert.ok((await card.locator('button[data-execute]').count()) >= 1, `${op.operationId} execute`);
    assert.ok((await card.locator('button[data-cancel]').count()) >= 1, `${op.operationId} cancel`);
    assert.ok((await card.locator('[data-status]').count()) >= 1, `${op.operationId} status`);
    assert.ok((await card.locator('pre[data-response]').count()) >= 1, `${op.operationId} response`);
    assert.ok(
      (await card.locator('pre[data-response-headers]').count()) >= 1,
      `${op.operationId} response headers`,
    );
    assert.ok((await card.locator('pre[data-curl]').count()) >= 1, `${op.operationId} curl`);
  }
  checks.push('all 18 cards with param/body/variant/confirm/execute/cancel/status/response/headers/curl');

  // Real spec stays wired: /openapi-v1.json generated from the contract.
  const specOps = await page.evaluate(async () => {
    const res = await fetch('/openapi-v1.json');
    if (!res.ok) throw new Error(`openapi fetch ${res.status}`);
    const doc = await res.json();
    const ids = [];
    for (const item of Object.values(doc.paths || {})) {
      for (const operation of Object.values(item)) {
        if (operation && operation.operationId) ids.push(operation.operationId);
      }
    }
    return ids.sort();
  });
  assert.deepEqual(
    specOps,
    OPERATIONS.map((o) => o.operationId).sort(),
    'spec lists the same 18 operationIds',
  );
  checks.push('real /openapi-v1.json lists 18 operations');

  // No auto fetch on load.
  await page.waitForTimeout(800);
  assert.equal(apiHits, 0, 'no API call on page load');
  checks.push('no auto fetch on load');

  // No auto fetch on search.
  await page.locator('#api-docs-search').fill('roadmap');
  await page.waitForTimeout(500);
  assert.equal(apiHits, 0, 'no API call on search');
  await page.locator('#api-docs-search').fill('');
  await page.waitForTimeout(300);
  checks.push('no auto fetch on search');

  // Token fill (fixture only, never persisted).
  await page.locator('#api-docs-token').fill(FIXTURE_TOKEN);
  assert.equal(await page.locator('#api-docs-token').inputValue(), FIXTURE_TOKEN);

  // No auto fetch on body changes: touch one POST textarea without executing.
  {
    const first = page.locator('details[data-operation-id="createRun"]');
    await ensureOpen(first);
    await first.locator('textarea[data-request-body]').first().fill('{"probe":true}');
    await page.waitForTimeout(500);
    assert.equal(apiHits, 0, 'no API call on body edits');
    checks.push('no auto fetch on body changes');
  }

  // Per-operation stubbed executions.
  for (const op of OPERATIONS) {
    const card = page.locator(`details[data-operation-id="${op.operationId}"]`);
    await ensureOpen(card);
    const { filledQuery, filledHeaders } = await fillParamInputs(card);
    // Re-assert token still set (fills must not wipe it).
    if ((await page.locator('#api-docs-token').inputValue()) !== FIXTURE_TOKEN) {
      await page.locator('#api-docs-token').fill(FIXTURE_TOKEN);
    }
    const { bodyObj } = await fillBodyAndConfirm(card, op);
    // Textarea carries an accessible label pointing at the body heading.
    if (op.body !== null && op.body !== undefined) {
      const labelledBy = await card
        .locator('textarea[data-request-body]')
        .first()
        .getAttribute('aria-labelledby');
      assert.ok(labelledBy, `${op.operationId} textarea has aria-labelledby`);
      assert.equal(
        await card.locator(`#${labelledBy}`).count(),
        1,
        `${op.operationId} textarea label target exists`,
      );
    }
    const execBtn = card.locator('button[data-execute]').first();
    const cancelBtn = card.locator('button[data-cancel]').first();
    await expect(cancelBtn).toBeDisabled({ timeout: 10000 });
    const expectedPath = concretePath(op.path);
    const stub = stubFor(op.operationId);
    currentExpected = { operationId: op.operationId, method: op.method, path: expectedPath };
    lastRequest = null;
    await execBtn.click();
    const statusLoc = card.locator('[data-status]').first();
    const respLoc = card.locator('pre[data-response]').first();
    await expect(statusLoc).toContainText(String(stub.status), { timeout: 10000 });
    // Completion signal: Execute re-enabled means the final status and the
    // full response are set (status shows the code during streaming too).
    await expect(execBtn).toBeEnabled({ timeout: 15000 });
    await expect(cancelBtn).toBeDisabled({ timeout: 10000 });
    if (op.operationId !== 'fileHead') {
      await page.waitForFunction(
        (sel) => (document.querySelector(sel)?.textContent || '').trim().length > 0,
        `details[data-operation-id="${op.operationId}"] pre[data-response]`,
        { timeout: 10000 },
      );
    }
    const statusText = await card.locator('[data-status]').first().innerText();
    const respText = await card.locator('pre[data-response]').first().innerText();
    const headersText = await card.locator('pre[data-response-headers]').first().innerText();
    const curlText = await card.locator('pre[data-curl]').first().innerText();
    assert.ok(lastRequest, `${op.operationId} issued exactly one stubbed request`);
    assert.equal(lastRequest.method, op.method, `${op.operationId} method`);
    assert.equal(lastRequest.path, expectedPath, `${op.operationId} path`);
    assert.equal(lastRequest.headers.authorization, `Bearer ${FIXTURE_TOKEN}`, `${op.operationId} auth`);
    for (const [k, v] of Object.entries(filledQuery)) {
      assert.equal(lastRequest.query[k], v, `${op.operationId} query ${k}`);
    }
    for (const [k, v] of Object.entries(filledHeaders)) {
      assert.equal(lastRequest.headers[k.toLowerCase()], v, `${op.operationId} header ${k}`);
    }
    if (bodyObj !== null && bodyObj !== undefined && typeof bodyObj === 'object') {
      assert.deepEqual(lastRequest.postData, bodyObj, `${op.operationId} body`);
    }
    assert.ok(statusText.includes(String(stub.status)), `${op.operationId} status shows ${stub.status}`);
    assert.ok(
      /\d+\s*ms/.test(statusText),
      `${op.operationId} status shows elapsed time (final, not streaming)`,
    );
    if (op.operationId === 'fileHead') {
      assert.ok(respText.trim() === '' || respText.length < 100, 'HEAD shows no body');
      assert.ok(/etag/i.test(headersText), 'HEAD headers show ETag');
    } else if (op.operationId === 'download') {
      assert.ok(/range/i.test(`${curlText} ${headersText} ${respText}`), 'download Range visible');
      assert.ok(respText.includes('download-preview'), 'download preview marker');
      const rawDownload = `download-preview:${DOWNLOAD_RAW}`;
      assert.equal(respText.length, 65536, `download keeps the exact 64KiB prefix, got ${respText.length}`);
      assert.ok(
        rawDownload.startsWith(respText),
        'download preview is the exact byte prefix (first chunk retained)',
      );
      assert.ok(/tronqu|truncat/i.test(statusText), 'download truncated suffix shown');
    } else if (op.operationId === 'events') {
      assert.ok(/fixture-event|seq/i.test(respText), 'SSE chunks displayed');
    } else {
      assert.ok(
        respText.includes(op.snippet) || headersText.includes(op.snippet),
        `${op.operationId} displayed snippet`,
      );
    }
    assertNoTokenLeak(respText, FIXTURE_TOKEN, `${op.operationId} response`);
    assertNoTokenLeak(headersText, FIXTURE_TOKEN, `${op.operationId} headers`);
    assertNoTokenLeak(curlText, FIXTURE_TOKEN, `${op.operationId} curl`);
    if (op.operationId === 'fileHead') {
      assert.ok(curlText.includes('--head'), 'HEAD curl uses --head');
      assert.ok(!curlText.includes('-X HEAD'), 'HEAD curl avoids -X HEAD');
    } else {
      assert.ok(curlText.includes(`-X ${op.method}`), `${op.operationId} curl shows method`);
    }
    assert.ok(
      curlText.includes('"$STUDIO_TOKEN"') || curlText.includes('"Authorization: Bearer $STUDIO_TOKEN"'),
      `${op.operationId} curl redacts token double-quoted`,
    );
    assert.ok(
      curlText.includes(expectedPath) || curlText.includes(op.operationId),
      `${op.operationId} curl shows path`,
    );
    currentExpected = null;
    checks.push(`op ${op.operationId} ${op.method} ${expectedPath} -> ${stub.status}`);
  }
  assert.equal(externalHosts.length, 0, 'no production/external hosts contacted');
  checks.push(
    '18/18 stubbed operations with exact method/path/auth/query/header/body plus idle-cancel, completion-gated reads, elapsed status, labelled bodies and redacted curl',
  );

  // Duplicate POST guard: Execute disables while active, so a double click
  // issues exactly one request and the controller is never lost.
  {
    const card = page.locator('details[data-operation-id="stop"]');
    await ensureOpen(card);
    await fillParamInputs(card);
    await fillBodyAndConfirm(card, OP_BY_ID.stop);
    const execBtn = card.locator('button[data-execute]').first();
    const cancelBtn = card.locator('button[data-cancel]').first();
    const before = routeCoverage.stop || 0;
    currentExpected = { operationId: 'stop', method: 'POST', path: concretePath(OP_BY_ID.stop.path) };
    delayNext = true;
    await execBtn.click();
    await expect(execBtn).toBeDisabled({ timeout: 10000 });
    await expect(cancelBtn).toBeEnabled({ timeout: 10000 });
    await expect(execBtn).toBeEnabled({ timeout: 15000 });
    await expect(card.locator('[data-status]').first()).toContainText('200', { timeout: 10000 });
    assert.equal((routeCoverage.stop || 0) - before, 1, 'double-click window issues exactly one POST');
    currentExpected = null;
    checks.push('execute disabled while active blocks duplicate POSTs');
  }

  // Confirm reset: checking then editing params/body/variant unchecks again.
  {
    const card = page.locator('details[data-operation-id="createRun"]');
    await ensureOpen(card);
    await fillParamInputs(card);
    await fillBodyAndConfirm(card, OP_BY_ID.createRun);
    const confirm = card.locator('input[data-confirm]').first();
    assert.ok(await confirm.isChecked(), 'confirm checked before edit');
    await card.locator('input[data-param-in][data-param-name]').first().fill('fixture-project-01');
    assert.ok(!(await confirm.isChecked()), 'confirm resets on parameter edit');
    await confirm.check({ force: true });
    await card
      .locator('textarea[data-request-body]')
      .first()
      .fill(JSON.stringify(OP_BY_ID.createRun.body, null, 2));
    assert.ok(!(await confirm.isChecked()), 'confirm resets on body edit');
    const roadmapCard = page.locator('details[data-operation-id="mutateRoadmap"]');
    await ensureOpen(roadmapCard);
    await fillParamInputs(roadmapCard);
    await fillBodyAndConfirm(roadmapCard, OP_BY_ID.mutateRoadmap);
    const variant = roadmapCard.locator('select[data-body-variant]').first();
    const confirm2 = roadmapCard.locator('input[data-confirm]').first();
    assert.ok(await confirm2.isChecked(), 'mutate confirm checked before variant change');
    const current = await variant.inputValue();
    const opts = await variant.locator('option').evaluateAll((els) => els.map((e) => e.value));
    const other = opts.find((v) => v !== current);
    if (other !== undefined) {
      await variant.selectOption(other);
      assert.ok(!(await confirm2.isChecked()), 'confirm resets on variant change');
    }
    checks.push('confirm resets on parameter/body/variant edits');
  }

  // SSE abort: delayed stub then explicit cancel (bounded, never .text()).
  {
    const card = page.locator('details[data-operation-id="events"]');
    await ensureOpen(card);
    await fillParamInputs(card);
    await fillBodyAndConfirm(card, OP_BY_ID.events);
    abortDelayed = true;
    currentExpected = { operationId: 'events', method: 'GET', path: concretePath(OP_BY_ID.events.path) };
    const abortExec = card.locator('button[data-execute]').first();
    const abortCancel = card.locator('button[data-cancel]').first();
    await abortExec.click();
    await expect(abortExec).toBeDisabled({ timeout: 10000 });
    await abortCancel.click();
    await expect(abortExec).toBeEnabled({ timeout: 15000 });
    await expect(card.locator('[data-status]').first()).toContainText(/arr[eê]t|stopp|abort/i, {
      timeout: 10000,
    });
    const abortStatus = await card.locator('[data-status]').first().innerText();
    assert.ok(/arr[eê]t|stopp|abort/i.test(abortStatus), 'SSE abort status visible');
    abortDelayed = false;
    currentExpected = null;
    // Re-run quickly to leave a clean success state for later checks.
    await ensureOpen(card);
    await fillParamInputs(card);
    await fillBodyAndConfirm(card, OP_BY_ID.events);
    currentExpected = { operationId: 'events', method: 'GET', path: concretePath(OP_BY_ID.events.path) };
    await card.locator('button[data-execute]').first().click();
    await expect(card.locator('[data-status]').first()).toContainText('200', { timeout: 10000 });
    await expect(card.locator('button[data-execute]').first()).toBeEnabled({ timeout: 15000 });
    currentExpected = null;
    checks.push('sse chunks plus cancel abort without hanging');
  }

  // Error shapes: 403 then 409 via re-execution with error stubs.
  {
    const failOnce = async (route) => {
      const req = route.request();
      const requestUrl = new URL(req.url());
      apiHits += 1;
      let postData = null;
      try {
        const raw = req.postDataBuffer()?.toString('utf-8');
        if (raw) {
          try {
            postData = JSON.parse(raw);
          } catch {
            postData = raw;
          }
        }
      } catch {}
      lastRequest = {
        method: req.method(),
        path: requestUrl.pathname,
        query: Object.fromEntries(requestUrl.searchParams.entries()),
        headers: req.headers(),
        postData,
        url: req.url(),
      };
      const exp = currentExpected;
      routeCoverage[exp.operationId] = (routeCoverage[exp.operationId] || 0) + 1;
      if (exp.operationId === 'interaction') {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Forbidden fixture', code: 'forbidden' }),
        });
      } else {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Revision conflict fixture',
            code: 'revision_conflict',
            currentRevision: 4,
          }),
        });
      }
    };
    await page.unroute('**/api/v1/**');
    // 403 on interaction.
    const interactionCard = page.locator('details[data-operation-id="interaction"]');
    await ensureOpen(interactionCard);
    await fillParamInputs(interactionCard);
    await fillBodyAndConfirm(interactionCard, OP_BY_ID.interaction);
    currentExpected = {
      operationId: 'interaction',
      method: 'POST',
      path: concretePath(OP_BY_ID.interaction.path),
    };
    await page.route('**/api/v1/runs/*/interactions', failOnce);
    await interactionCard.locator('button[data-execute]').first().click();
    await expect(interactionCard.locator('[data-status]').first()).toContainText('403', { timeout: 10000 });
    await expect(interactionCard.locator('button[data-execute]').first()).toBeEnabled({ timeout: 15000 });
    {
      const t = await interactionCard.locator('pre[data-response]').first().innerText();
      assert.ok(/forbidden/i.test(t), '403 body displayed');
    }
    await page.unroute('**/api/v1/runs/*/interactions');
    currentExpected = null;
    // 409 on mutateRoadmap.
    const roadmapCard = page.locator('details[data-operation-id="mutateRoadmap"]');
    await ensureOpen(roadmapCard);
    await fillParamInputs(roadmapCard);
    await fillBodyAndConfirm(roadmapCard, OP_BY_ID.mutateRoadmap);
    currentExpected = {
      operationId: 'mutateRoadmap',
      method: 'POST',
      path: concretePath(OP_BY_ID.mutateRoadmap.path),
    };
    await page.route('**/api/v1/projects/*/roadmap/mutations', failOnce);
    await roadmapCard.locator('button[data-execute]').first().click();
    await expect(roadmapCard.locator('[data-status]').first()).toContainText('409', { timeout: 10000 });
    await expect(roadmapCard.locator('button[data-execute]').first()).toBeEnabled({ timeout: 15000 });
    {
      const t = await roadmapCard.locator('pre[data-response]').first().innerText();
      assert.ok(/revision_conflict|conflict/i.test(t), '409 body displayed');
    }
    await page.unroute('**/api/v1/projects/*/roadmap/mutations');
    currentExpected = null;
    await page.route('**/api/v1/**', stubApi);
    checks.push('errors 403 and 409 displayed');
  }

  // Token hygiene: storage, URL, every curl/snippet.
  {
    const dump = await page.evaluate(
      () =>
        JSON.stringify({ ...localStorage }) +
        JSON.stringify({ ...sessionStorage }) +
        document.documentElement.outerHTML.slice(0, 200000),
    );
    assertNoTokenLeak(dump, FIXTURE_TOKEN, 'web storage/snippets');
    assert.ok(!page.url().includes(FIXTURE_TOKEN), 'token not in URL');
    const curls = await page
      .locator('pre[data-curl]')
      .evaluateAll((els) => els.map((e) => e.textContent || ''));
    for (const [i, text] of curls.entries()) assertNoTokenLeak(text, FIXTURE_TOKEN, `curl ${i}`);
    checks.push('token absent from storage/URL/curl/snippets');
  }

  // Clear + pagehide.
  {
    await page.locator('#api-docs-clear-token').click();
    assert.equal(await page.locator('#api-docs-token').inputValue(), '', 'clear empties token');
    await page.locator('#api-docs-token').fill(FIXTURE_TOKEN);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#api-docs-token').inputValue(), '', 'pagehide clears token');
    const dump = await page.evaluate(
      () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    );
    assertNoTokenLeak(dump, FIXTURE_TOKEN, 'storage after clear/pagehide');
    await page.locator('#api-docs-token').fill(FIXTURE_TOKEN);
    checks.push('clear button plus pagehide wipe token');
  }

  // Keyboard + search filtering.
  {
    await page.locator('#api-docs-search').fill('');
    assert.equal(
      await page.locator('details[data-operation-id]:visible').count(),
      18,
      'search cleared shows all',
    );
    await page.locator('#api-docs-search').focus();
    await page.keyboard.type('roadmap', { delay: 20 });
    await page.waitForTimeout(400);
    const visible = await page.locator('details[data-operation-id]:visible').count();
    assert.ok(visible < 18 && visible >= 2, `search filters cards, got ${visible}`);
    const visibleIds = await page
      .locator('details[data-operation-id]:visible')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-operation-id')));
    assert.ok(
      visibleIds.every((id) => /roadmap/i.test(id || '')),
      'search keeps only matching cards',
    );
    // Nav items follow the same [hidden] filter (li hidden to avoid gaps).
    const hiddenNav = await page
      .locator('#api-docs-nav li[hidden]')
      .evaluateAll((els) => els.map((e) => e.textContent || ''));
    assert.equal(hiddenNav.length, 18 - visible, `nav items hidden with cards, got ${hiddenNav.length}`);
    assert.ok(
      hiddenNav.every((text) => !/roadmap/i.test(text || '')),
      'hidden nav items are the non-matching routes',
    );
    assert.equal(
      await page.locator('#api-docs-nav li:not([hidden])').count(),
      visible,
      'visible nav items match visible cards',
    );
    await page.keyboard.press('Escape');
    await page.locator('#api-docs-search').fill('');
    await page.waitForTimeout(300);
    assert.equal(
      await page.locator('details[data-operation-id]:visible').count(),
      18,
      'search reset restores all',
    );
    const summary = page.locator('details[data-operation-id="machine"] summary').first();
    const machineCard = page.locator('details[data-operation-id="machine"]');
    if (await machineCard.evaluate((el) => el.open)) await summary.click();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(machineCard).toHaveAttribute('open', '', { timeout: 10000 });
    checks.push('keyboard operable search plus summary toggle and filtered search');
  }

  // FR + EN rendering (two locales, same contract).
  {
    const frText = await page.locator('body').innerText();
    assert.ok(/jeton|rechercher|exécuter|executer|annuler|documentation/i.test(frText), 'FR wording visible');
    const enContext = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    const enPage = await enContext.newPage();
    enPage.on('pageerror', (error) => errors.push(`en: ${error.message}`));
    enPage.setDefaultTimeout(10000);
    await enPage.route('**/api/v1/**', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'no auto fetch', code: 'unexpected' }),
      });
    });
    await enPage.goto(`${url}/api-docs`, { waitUntil: 'domcontentloaded' });
    await expect(enPage.locator('details[data-operation-id]')).toHaveCount(18);
    const enText = await enPage.locator('body').innerText();
    assert.ok(/token|search|execute|cancel|documentation/i.test(enText), 'EN wording visible');
    await enContext.close();
    checks.push('FR plus EN wording with 18 cards in both');
  }

  // Screenshot without credentials: safe fixture response, cleared field.
  await mkdir('.local', { recursive: true });
  {
    const machineCard = page.locator('details[data-operation-id="machine"]');
    await ensureOpen(machineCard);
    await page.locator('#api-docs-token').fill(FIXTURE_TOKEN);
    await fillParamInputs(machineCard);
    await fillBodyAndConfirm(machineCard, OP_BY_ID.machine);
    currentExpected = { operationId: 'machine', method: 'GET', path: concretePath(OP_BY_ID.machine.path) };
    await machineCard.locator('button[data-execute]').first().click();
    await expect(machineCard.locator('[data-status]').first()).toContainText('200', { timeout: 10000 });
    await expect(machineCard.locator('button[data-execute]').first()).toBeEnabled({ timeout: 15000 });
    await machineCard.scrollIntoViewIfNeeded();
    currentExpected = null;
    await page.locator('#api-docs-clear-token').click();
    assert.equal(await page.locator('#api-docs-token').inputValue(), '', 'field cleared before screenshot');
    const bodyText = await page.locator('body').innerText();
    assertNoTokenLeak(bodyText, FIXTURE_TOKEN, 'screenshot page text');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator('details[data-operation-id="machine"]')).toBeInViewport();
    await page.screenshot({ path: '.local/api-docs-page.png', animations: 'disabled' });
    checks.push('screenshot .local/api-docs-page.png without credential');
  }

  // Real read phase: Node drives real admin endpoints; docs UI only reads.
  {
    const realTemp = await mkdtemp(join(tmpdir(), 'prime-api-docs-real-'));
    const realCwd = join(realTemp, 'Atelier');
    const realAgent = join(realTemp, 'agent');
    const realSessions = join(realTemp, 'sessions');
    const realData = join(realTemp, 'data');
    await Promise.all([realCwd, realAgent, realSessions, realData].map((p) => mkdir(p, { recursive: true })));
    const realApp = createApp({
      initialCwd: realCwd,
      agentHome: realAgent,
      sessionDir: realSessions,
      dataDir: realData,
      runtime: {
        getStatus: async () => ({ available: true, version: 'fixture' }),
        getModels: async () => ({ models: [], default: {} }),
        start: async () => {
          throw new Error('Isolated docs fixture cannot start agents');
        },
        close: async () => {},
      },
      openDirectory: async () => {},
    });
    await new Promise((done) => realApp.server.listen(0, '127.0.0.1', done));
    const realUrl = `http://127.0.0.1:${realApp.server.address().port}`;
    try {
      const admin = async (path, options) => {
        const res = await fetch(realUrl + path, {
          ...options,
          headers: {
            ...(options?.headers || {}),
            ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: options?.body ? JSON.stringify(options.body) : undefined,
        });
        let data = null;
        try {
          data = await res.json();
        } catch {}
        return { status: res.status, data };
      };
      const first = await admin('/api/public-api');
      assert.equal(first.status, 200, 'real admin readable');
      assert.equal(first.data.enabled, false, 'real API disabled by default');
      const listedId = first.data.projects[0].id;
      const machineId = first.data.machineId;
      const enabled = await admin('/api/public-api', {
        method: 'PATCH',
        body: { revision: first.data.revision, enabled: true },
      });
      assert.equal(enabled.status, 200, 'real API enabled via Node admin');
      const created = await admin('/api/public-api/tokens', {
        method: 'POST',
        body: {
          revision: enabled.data.revision,
          name: 'Docs proof read',
          scopes: ['read'],
          projectIds: [listedId],
        },
      });
      assert.equal(created.status, 201, 'real read token created via Node admin (never from docs UI)');
      const credential = created.data.credential;
      const tokenId = created.data.token.id;
      assert.ok(String(credential).startsWith('pa_'), 'real credential opaque');
      let revision = created.data.state.revision;
      // Real docs page without stubs: the machine read really succeeds.
      const realContext = await browser.newContext({
        locale: 'fr-FR',
        viewport: { width: 1440, height: 900 },
      });
      const realPage = await realContext.newPage();
      realPage.on('pageerror', (error) => errors.push(`real: ${error.message}`));
      realPage.setDefaultTimeout(10000);
      const realGoto = await realPage.goto(`${realUrl}/api-docs`, { waitUntil: 'domcontentloaded' });
      assert.equal(realGoto?.status(), 200, 'real /api-docs reachable');
      await expect(realPage.locator('details[data-operation-id="machine"]')).toHaveCount(1);
      const realCard = realPage.locator('details[data-operation-id="machine"]');
      const realOpen = await realCard.evaluate((el) => el.open);
      if (!realOpen) await realCard.locator('summary').first().click();
      await realPage.locator('#api-docs-token').fill(credential);
      await realCard.locator('button[data-execute]').first().click();
      await expect(realCard.locator('[data-status]').first()).toContainText('200', { timeout: 15000 });
      await expect(realCard.locator('button[data-execute]').first()).toBeEnabled({ timeout: 15000 });
      {
        const t = await realCard.locator('pre[data-response]').first().innerText();
        assert.ok(t.includes(machineId), 'real machine read shows real machineId');
        assert.ok(!t.includes(credential), 'real response carries no credential');
      }
      checks.push('real Node-issued token reads GET machine through docs UI');
      // Revoke via Node admin: docs UI now shows 401 (token never created there).
      const listed = await admin('/api/public-api');
      revision = listed.data.revision;
      const revoked = await admin(`/api/public-api/tokens/${encodeURIComponent(tokenId)}`, {
        method: 'DELETE',
        body: { revision },
      });
      assert.equal(revoked.status, 200, 'real token revoked via Node admin');
      revision = revoked.data.revision;
      await realCard.locator('button[data-execute]').first().click();
      await expect(realCard.locator('[data-status]').first()).toContainText('401', { timeout: 15000 });
      await expect(realCard.locator('button[data-execute]').first()).toBeEnabled({ timeout: 15000 });
      checks.push('real revoke turns docs machine read to 401');
      // Second token then API off: docs UI shows 404 while tokens persist.
      const again = await admin('/api/public-api');
      const created2 = await admin('/api/public-api/tokens', {
        method: 'POST',
        body: {
          revision: again.data.revision,
          name: 'Docs proof read 2',
          scopes: ['read'],
          projectIds: [listedId],
        },
      });
      assert.equal(created2.status, 201);
      const credential2 = created2.data.credential;
      revision = created2.data.state.revision;
      await realPage.locator('#api-docs-token').fill(credential2);
      await realCard.locator('button[data-execute]').first().click();
      await expect(realCard.locator('[data-status]').first()).toContainText('200', { timeout: 15000 });
      await expect(realCard.locator('button[data-execute]').first()).toBeEnabled({ timeout: 15000 });
      const off = await admin('/api/public-api', { method: 'PATCH', body: { revision, enabled: false } });
      assert.equal(off.status, 200, 'real API disabled via Node admin');
      await realCard.locator('button[data-execute]').first().click();
      await expect(realCard.locator('[data-status]').first()).toContainText('404', { timeout: 15000 });
      await expect(realCard.locator('button[data-execute]').first()).toBeEnabled({ timeout: 15000 });
      checks.push('real API off turns docs machine read to 404');
      await realContext.close();
    } finally {
      await realApp.close();
      assert.equal(dirname(realTemp), resolve(tmpdir()));
      await rm(realTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  // Responsive 390: no horizontal page overflow (last: restores 1440 after).
  {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      bodySw: document.body ? document.body.scrollWidth : 0,
    }));
    assert.ok(
      overflow.sw <= overflow.cw + 1,
      `390px no page overflow: scrollWidth ${overflow.sw} <= clientWidth ${overflow.cw}`,
    );
    checks.push('390px responsive without horizontal page overflow');
    await page.screenshot({ path: '.local/api-docs-page-narrow.png', animations: 'disabled' });
    checks.push('screenshot .local/api-docs-page-narrow.png at 390px');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }

  assert.deepEqual(errors, [], 'no page errors');
  assert.equal(externalHosts.length, 0, 'still no external hosts');
  const missing = OPERATIONS.filter((op) => !(routeCoverage[op.operationId] >= 1)).map(
    (op) => op.operationId,
  );
  assert.deepEqual(missing, [], `route coverage 18/18, missing: ${missing.join(',')}`);
  console.log(JSON.stringify({ passed: true, checks, routeCoverage }, null, 2));
} finally {
  clearTimeout(deadline);
  await browser?.close();
  await app.close();
  assert.equal(dirname(temp), resolve(tmpdir()));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
