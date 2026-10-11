// BETA3 docking cold-restore + live-run regression (isolated, deterministic).
// SCOPE: this file ONLY + its OWN artifacts under .local/release-4.3.0-beta.3/qa/.
// NEVER: product source, other tests, version/Git, real models, active Studio,
// Lab :62542, source swapping, persisted instrumentation. Real createApp on
// temp dirs (loopback 127.0.0.1, ephemeral port); FAKE held stub runtime.
// Two tool-rich sessions (one >=1MB tool results, asserted WITHOUT truncation):
// split-dock layout + sidecar activeId dynamic (case A) then primary (case B).
// Both visible panes must hydrate with zero clicks; focus/drafts preserved.
// Case A then starts one FAKE held run from the dynamic pane UI: exactly one
// visible work status (runline hidden, composer run-status visible), burst 100
// text deltas verified in full, rAF frame count recorded (no big profiler).
// Budgets: overall watchdog 90s, actions 10s. Proof written BEFORE teardown;
// finally closes browser + app + temp data.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';

const OUT = resolve('.local/release-4.3.0-beta.3/qa');
const PROOF = join(OUT, 'docking-regressions-proof.json');
const SRC = [
  'public/app.js',
  'public/conversation-views.js',
  'public/docking.js',
  'public/docking-layout.js',
];
const hashSrc = () =>
  Object.fromEntries(
    SRC.map((f) => {
      try {
        return [
          f,
          createHash('sha256')
            .update(readFileSync(resolve(f)))
            .digest('hex')
            .slice(0, 16),
        ];
      } catch {
        return [f, 'missing'];
      }
    }),
  );
const sourceStart = hashSrc();
const startedAt = new Date().toISOString();
const checks = [],
  errors = [],
  measurements = {};
const step = (t) => {
  checks.push(t);
  console.log(`ok - ${t}`);
};
const watchdog = setTimeout(() => {
  errors.push('overall watchdog 90s exceeded');
  process.exitCode = 1;
}, 90000);

const temp = await mkdtemp(join(tmpdir(), 'prime-docking-regress-'));
const cwd = join(temp, 'Atelier');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
await mkdir(cwd, { recursive: true });
await mkdir(sessionDir, { recursive: true });
const HEAD = 'BLOB-HEAD-reg-b:',
  TAIL = ':BLOB-TAIL-reg-b';
const BIG = HEAD + 'x'.repeat(1150000) + TAIL;
async function seedSession(file, id, title, toolText) {
  const recs = [{ type: 'session', id, cwd, version: 3, timestamp: new Date().toISOString() }];
  let parent = null;
  const link = (r) => {
    r.parentId = parent;
    recs.push(r);
    parent = r.id;
  };
  const msg = (mid, role, content, extra = {}) => ({
    type: 'message',
    id: mid,
    message: { role, content, timestamp: Date.now(), ...extra },
  });
  link(msg(`${id}-u0`, 'user', title));
  const tc = `${id}-tool`;
  link(
    msg(`${id}-call`, 'assistant', [
      { type: 'toolCall', id: tc, name: 'ipython', arguments: { code: 'print(2)' } },
    ]),
  );
  link(msg(`${id}-res`, 'toolResult', toolText, { toolCallId: tc, toolName: 'ipython', isError: false }));
  link(msg(`${id}-a1`, 'assistant', `Synthese ${id} disponible. ` + 'Le panneau reste stable. '.repeat(20)));
  await writeFile(file, recs.map(JSON.stringify).join('\n') + '\n');
}
await seedSession(
  join(sessionDir, 'reg-a.jsonl'),
  'reg-a',
  'Calibrer la sortie audio',
  'historical-tool-result:reg-a',
);
await seedSession(
  join(sessionDir, 'reg-b.jsonl'),
  'reg-b',
  'Preparer la distribution',
  `historical-tool-result:reg-b ${BIG}`,
);
step(`seeded reg-a + reg-b (reg-b file >=1MB: ${(BIG.length / 1048576).toFixed(2)}MB tool result)`);

const starts = [];
const controls = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/regress', name: 'Regress fixture', provider: 'fixture', reasoning: true }],
    default: { model: 'fixture/regress', thinking: 'medium' },
  }),
  async start(input) {
    const record = { sessionId: input.sessionId || null, cwd: input.cwd };
    starts.push(record);
    let done;
    const finished = new Promise((r) => {
      done = r;
    });
    const ctl = {
      record,
      done: finished,
      stream: (text) => input.onEvent({ kind: 'text', delta: text }),
      async finish(s = 'completed') {
        const r = { kind: 'done', sessionId: record.sessionId, status: s, code: 0 };
        input.onEvent(r);
        done(r);
        return r;
      },
      cancel() {
        return ctl.finish('stopped');
      },
    };
    controls.push(ctl);
    if (record.sessionId) {
      try {
        input.onEvent({ kind: 'session', sessionId: record.sessionId, cwd: input.cwd });
      } catch {}
    }
    return ctl;
  },
  async close() {
    await Promise.all(controls.map((c) => c.finish('stopped').catch(() => {})));
  },
};
const app = createApp({
  runtime,
  agentHome: join(temp, 'agent'),
  sessionDir,
  dataDir,
  initialCwd: cwd,
  networkOptions: {
    interfaces: () => ({}),
    makeGateway() {
      throw new Error('fixture must not bind');
    },
  },
});
await app.store.project({ cwd });
await mkdir(join(temp, 'agent'), { recursive: true });
await new Promise((d) => app.server.listen(0, '127.0.0.1', d));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await launchStudioBrowser({ channel: 'chrome' });
let proofWritten = false;
async function writeProof(status, extra = {}) {
  const sourceEnd = hashSrc();
  const drift = Object.keys(sourceStart).filter((k) => sourceStart[k] !== sourceEnd[k]);
  await mkdir(OUT, { recursive: true });
  await writeFile(
    PROOF,
    JSON.stringify(
      {
        status,
        version: JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version,
        checks,
        errors,
        measurements,
        modelCalls: starts.length,
        sourceStart,
        sourceEnd,
        changedPaths: drift,
        sourceDrift: drift.length > 0,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...extra,
      },
      null,
      2,
    ),
  );
  proofWritten = true;
}
const paneText = (page, id) =>
  page.evaluate(
    (v) =>
      v === 'conversation'
        ? document.getElementById('messages')?.textContent || ''
        : document.querySelector(`.cvw-shell[data-view="${v}"] .cvw-messages`)?.textContent || '',
    id,
  );
const marker = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.dock-tab.is-conversation.is-focused')].map((el) => el.dataset.dockTab),
  );
const draftsOf = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('prime-studio.drafts') || '{}');
    } catch {
      return {};
    }
  });
async function seedStorage(context, activeId) {
  await context.addInitScript(
    ({ cwd, activeId }) => {
      localStorage.setItem(
        'prime-studio.docking.layout',
        JSON.stringify({
          version: 3,
          enabled: true,
          root: {
            kind: 'split',
            id: 'main',
            dir: 'row',
            ratio: 0.5,
            first: {
              kind: 'group',
              id: 'conversation-group',
              panels: ['conversation'],
              active: 'conversation',
            },
            second: { kind: 'group', id: 'side-group', panels: ['conv:dyn1'], active: 'conv:dyn1' },
          },
        }),
      );
      const e = (id, sid, nonce) => ({
        id,
        kind: 'session',
        sessionId: sid,
        projectCwd: cwd,
        execCwd: cwd,
        viewRunId: null,
        nonce,
        gen: null,
      });
      localStorage.setItem(
        'prime-studio.docking.conversations',
        JSON.stringify({
          version: 1,
          activeId,
          entries: [e('conversation', 'reg-a', 'aaaa1111'), e('conv:dyn1', 'reg-b', 'bbbb2222')],
        }),
      );
      localStorage.setItem(
        'prime-studio.drafts',
        JSON.stringify({
          'session:reg-a': 'Brouillon A : sortie audio',
          'session:reg-b': 'Brouillon B : distribution',
        }),
      );
      localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, projectOverview: false }));
    },
    { cwd, activeId },
  );
}
async function hydrateCase(activeId, label) {
  const context = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 1600, height: 1000 },
    reducedMotion: 'reduce',
  });
  await seedStorage(context, activeId);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(String(e?.stack || e?.message || e).slice(0, 500)));
  page.on('dialog', async (d) => {
    errors.push(`native dialog: ${d.message()}`);
    await d.dismiss().catch(() => {});
  });
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connecté', { timeout: 10000 });
  for (const id of ['conversation', 'conv:dyn1'])
    await expect.poll(() => paneText(page, id).then((t) => t.length), { timeout: 10000 }).toBeGreaterThan(50);
  step(`${label}: both visible panes hydrated with zero clicks`);
  assert.deepEqual(await marker(page), [activeId], `${label}: focus preserved on ${activeId} without click`);
  const focusedComposer =
    activeId === 'conversation' ? '#composer' : '.cvw-shell[data-view="conv:dyn1"] [data-cvw="composer"]';
  const wantDraft = activeId === 'conversation' ? 'Brouillon A : sortie audio' : 'Brouillon B : distribution';
  assert.equal(
    await page.locator(focusedComposer).inputValue(),
    wantDraft,
    `${label}: focused draft restored after hydration`,
  );
  const d = await draftsOf(page);
  assert.ok(
    Object.values(d).includes('Brouillon A : sortie audio') &&
      Object.values(d).includes('Brouillon B : distribution'),
    `${label}: both drafts preserved in storage`,
  );
  step(`${label}: focus (${activeId}) + both drafts preserved after hydration`);
  const toolA = page.locator('#messages .tool-block').filter({ hasText: 'historical-tool-result:reg-a' });
  await expect(toolA).toHaveCount(1, { timeout: 10000 });
  const dynTools = page
    .locator('.cvw-shell[data-view="conv:dyn1"] .cvw-messages .tool-block')
    .filter({ hasText: 'historical-tool-result:reg-b' });
  await expect(dynTools).toHaveCount(1, { timeout: 10000 });
  const blob = await paneText(page, 'conv:dyn1');
  assert.ok(
    blob.length >= 1000000 && blob.includes(HEAD) && blob.includes(TAIL),
    `${label}: 1MB history intact head+tail (len=${blob.length})`,
  );
  step(`${label}: tool-rich histories rendered, 1MB blob intact (no truncation)`);
  return { context, page };
}
try {
  const A = await hydrateCase('conv:dyn1', 'caseA-dynamic');
  measurements.focusA = await marker(A.page);
  const dyn = 'conv:dyn1';
  await A.page
    .locator(`.cvw-shell[data-view="${dyn}"] [data-cvw="composer"]`)
    .fill('Message tenu pour reg-b');
  const n0 = starts.length;
  await A.page.locator(`.cvw-shell[data-view="${dyn}"] [data-cvw="send"]`).click();
  await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(n0 + 1);
  const ctl = controls[controls.length - 1];
  assert.equal(ctl.record.sessionId, 'reg-b', 'held run binds reg-b');
  step('held FAKE run started from dynamic pane UI, bound reg-b');
  await expect(A.page.locator(`.cvw-shell[data-view="${dyn}"] [data-cvw="run-status"]`)).toBeVisible({
    timeout: 10000,
  });
  const st = await A.page.evaluate(() => ({
    runlines: [...document.querySelectorAll('.cvw-runline')].filter(
      (n) => !n.hidden && n.getClientRects().length,
    ).length,
    paneStatus: [...document.querySelectorAll('.cvw-shell [data-cvw="run-status"]')].filter(
      (n) => n.getClientRects().length,
    ).length,
  }));
  measurements.workStatus = st;
  assert.equal(st.runlines, 0, 'no visible cvw-runline while composer run-status owns the signal');
  assert.equal(st.paneStatus, 1, 'exactly one visible composer run-status');
  step('exactly one visible work status (runline hidden, composer run-status visible)');
  const framesP = A.page.evaluate(
    () =>
      new Promise((res) => {
        let n = 0;
        const t0 = performance.now();
        const k = () => {
          n++;
          performance.now() - t0 < 1500 ? requestAnimationFrame(k) : res(n);
        };
        requestAnimationFrame(k);
      }),
  );
  await A.page.locator('button[data-dock-tab="conversation"]').click();
  await expect(A.page.locator('button[data-dock-tab="conversation"][aria-selected="true"]')).toBeAttached({
    timeout: 10000,
  });
  step('primary focused before burst: dynamic run streams as unfocused heavy background');
  const toks = Array.from({ length: 100 }, (_, i) => `D${i};`);
  for (const tok of toks) ctl.stream(tok);
  await expect.poll(() => paneText(A.page, dyn), { timeout: 10000 }).toContain(toks.join(''));
  measurements.framesDuringBurst = await framesP;
  measurements.burstChars = toks.join('').length;
  step(
    `burst 100 deltas rendered in full (${toks.join('').length} chars, ${measurements.framesDuringBurst} rAF ticks)`,
  );
  await ctl.finish('completed');
  await expect(A.page.locator(`.cvw-shell[data-view="${dyn}"] [data-cvw="stop"]`)).toBeHidden({
    timeout: 10000,
  });
  step('held run completed, stop control hidden, zero cancels');
  await A.context.close();
  const B = await hydrateCase('conversation', 'caseB-primary');
  measurements.focusB = await marker(B.page);
  await B.context.close();
  assert.deepEqual(errors, [], `zero page errors, got ${JSON.stringify(errors).slice(0, 400)}`);
  step(`done: ${starts.length} stub start(s), 0 errors`);
  await writeProof('pass');
} catch (e) {
  if (!proofWritten) {
    try {
      await writeProof('failed', { failure: String(e?.message || e).slice(0, 1500) });
    } catch {}
  }
  throw e;
} finally {
  clearTimeout(watchdog);
  await browser.close().catch(() => {});
  await app.close().catch(() => {});
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
