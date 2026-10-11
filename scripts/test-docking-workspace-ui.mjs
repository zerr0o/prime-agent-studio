// Isolated docking workspace acceptance test (round 2: multi-conversation + prefs tab).
//
// SCOPE: this file ONLY creates scripts/test-docking-workspace-ui.mjs plus its
// OWN runtime artifacts under .local/docking-4.3/round2/ (captures + proof +
// test-fixture-owned). No other Studio source is edited by this test.
// NEVER: production server, real provider account, real model, user Lab :62542,
// installed Studio, native CU, install/build/commit/publish. Seeding uses the
// real createApp fixture API plus normal UI input, plus a controllable stub
// runtime (records starts/cancels, streams only when the test releases).
// Captures are genuine screenshots only: never force hidden/classes/DOM state
// for visuals. Reading refs/storage through page.evaluate for comparison is
// allowed and is NOT UI forcing (same rule as scripts/test-docking-ui.mjs).
//
// CONTRACT (round-2 docking, v3 model): at most 8 conversation panels; panel
// ids conversation/roadmap/session/agents/files/preferences plus conv:<id> refs.
// Session/Agents/Files are INDEPENDENT dock tabs (no monolithic inspector tab):
// the inspector registers live unit roots (#inspector-session/agents/files).
// Exactly one focused conversation carries .dock-tab.is-conversation.is-focused
// (aria-selected stays per-group visibility). Creation flows through the native
// #conversation-picker modal (2-step project -> session; parked views or new
// empty; Escape resolves null). The AddTab submenu is short: new-conversation
// plus the 5 singletons only. Tab-bar drops show the .dock-tab-insertion
// marker with an AFTER-removal index; pane-body drops show the zone preview.
// Sidebar sessions drag with the POINTER session-sorting gesture (6px
// threshold, mouse down/move/up; HTML5 dragstart is prevented): drops resolve
// through openConversationView (registered project/session validated, existing
// owner view reused, no runs). Group ellipsis (⋯) intentionally opens the
// context menu (Unity parity); the Layout/Agencement dialog is reached via the
// menu item docking.title afterwards. Preset overwrite/delete use the INLINE
// confirm (#docking-preset-confirm/cancel), never window.confirm: any native
// dialog during this test is recorded as an error. Saved envelopes are
// geometry only: layout doc version 3 (V1/V2 accepted, inspector expanded in
// place to session/agents/files, active inspector -> session), presets
// version 1 with anonymous conversation slots, sidecar docking.conversations
// version 1 with {activeId, entries[]} and no content.
// ORDER: targeted smoke first (tools split, chooser, tab insertion, sidebar
// pointer drag), then the deep composer chain. The per-pane composer contract
// ([data-cvw=*] roles, per-pane controllers, shell activation) is IMPLEMENTED;
// M2A/M2-fast probe for live wiring and record explicit deferred notes only on
// pre-enable opt-out runs — never weakened, never silent. Native-dialog/picker
// closes are always awaited to resolution before any count is read (close
// events are async).
// HISTORICAL: 21 checks passed on the pre-v3 candidate (proof archive keeps
// the record); they are a progress snapshot, not current acceptance.
// Until every probe below passes, the test reports status "blocked" with the
// exact contract gaps instead of failing with an obscure timeout.

import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const STUDIO_VERSION = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
// Source fence: hashes + timestamps at start/end prove the tree did not move
// mid-run. Any drift is recorded, never mistaken for final acceptance.
const SOURCE_SURFACE = [
  'public/app.js',
  'public/conversation-views.js',
  'public/composer.js',
  'public/images.js',
  'public/live-messages.js',
  'public/commands.js',
  'public/questions.js',
  'public/docking.js',
  'public/docking-layout.js',
  'public/docking-presets.js',
  'public/conversation-picker.js',
  'public/session-sorting.js',
  'public/inspector.js',
  'public/settings.js',
  'public/conversation-views.css',
  'public/docking.css',
  'public/conversation.css',
  'public/live-messages.css',
  'public/questions.css',
  'public/commands.css',
  'public/images.css',
];
function hashSurface() {
  const out = {};
  for (const file of SOURCE_SURFACE) {
    try {
      out[file] = createHash('sha256')
        .update(readFileSync(resolve(file)))
        .digest('hex')
        .slice(0, 16);
    } catch {
      out[file] = 'missing';
    }
  }
  return out;
}
const runMeta = { startedAt: new Date().toISOString(), sourceStart: hashSurface() };

// ---------------------------------------------------------------------------
// Round-2 contract selectors (parent-owned implementation; gaps are reported
// explicitly instead of failing with an obscure timeout).
// ---------------------------------------------------------------------------
const DOCK = {
  openButton: '#open-docking',
  dialog: '#docking-settings',
  toggle: '#docking-toggle',
  closeSettings: '#docking-close-settings',
  reset: '#docking-reset',
  panelSelect: '#docking-panel',
  targetSelect: '#docking-target',
  zoneSelect: '#docking-zone',
  moveButton: '#docking-move',
  newConversation: '#docking-new-conversation',
  workspace: '#dock-workspace',
  dropPreview: '.dock-drop-preview',
  bar: '.dock-bar',
  group: '[data-dock-group]',
  tab: 'button[data-dock-tab]',
  ellipsis: '.dock-bar > .dock-chrome-button:not([data-dock-close])',
  contextMenu: '#docking-context-menu',
  addMenu: '#docking-add-menu',
  addOption: '#docking-add-menu [data-dock-add]',
  presetName: '#docking-preset-name',
  presetSave: '#docking-save-layout',
  presetChoice: '#docking-preset-choice',
  presetLoad: '#docking-load-layout',
  presetDelete: '#docking-delete-layout',
  presetConfirm: '#docking-preset-confirm',
  presetCancel: '#docking-preset-cancel',
  presetStatus: '#docking-preset-status',
  insertion: '.dock-tab-insertion',
  focusedTab: '.dock-tab.is-conversation.is-focused',
  convTab: '.dock-tab.is-conversation',
  picker: '#conversation-picker',
  pickerSearch: '#conversation-picker .conv-picker-search',
  pickerList: '#conversation-picker .conv-picker-list',
  pickerRow: '#conversation-picker .conv-pick-row',
  pickerNew: '#conversation-picker .conv-pick-row.is-new',
  pickerTitle: '#conversation-picker-title',
  sessionRow: '.session-row[data-session-id]',
  sessionHandle: '.session-drag-handle',
};
const SINGLETONS = ['roadmap', 'session', 'agents', 'files', 'preferences'];
const LAYOUT_KEY = 'prime-studio.docking.layout';
const PRESETS_KEY = 'prime-studio.docking.presets';
const CONV_KEY = 'prime-studio.docking.conversations';
const DRAFTS_KEY = 'prime-studio.drafts';
const MAX_CONVERSATIONS = 8;
const ZONES = ['center', 'left', 'right', 'top', 'bottom'];
// Full M2+DEEP is the DEFAULT: every core scenario runs on a normal
// invocation. DOCKR2_DEEP=0 explicitly opts out to the historical smoke-only
// preparatory mode (recorded as deferred, never silent).
const RUN_DEEP = process.env.DOCKR2_DEEP !== '0';
// M2 enforcement is ON by default (explicit opt-out DOCKR2_M2=0 only for
// historical preparatory runs): missing per-pane inputs/attachments are HARD
// failures, never silent deferrals. Opt-out runs keep explicit deferral notes.
const M2_ENFORCE = process.env.DOCKR2_M2 !== '0';
// Focused M2 fast path (no 46-check chain, updates-bootstrap never runs here).
const M2CHECK = process.env.DOCKR2_M2CHECK === '1';
// Fast-path exit signal (top-level return is illegal in modules): thrown after
// the fast proof is written; the catch below maps it to a clean exit.
class FastDone extends Error {}
const deferred = [];

// Per-mode outputs: fast path writes under captures-m2fast + m2fast proof +
// m2fast fixture dir, so a partial scaffold run can never overwrite full-suite
// evidence (or vice versa).
const OUT_ROOT = resolve(
  M2CHECK ? '.local/docking-4.3/round2/captures-m2fast' : '.local/docking-4.3/round2/captures',
);
const PROOF_PATH = join(
  OUT_ROOT,
  M2CHECK ? 'docking-workspace-m2fast-proof.json' : 'docking-workspace-proof.json',
);
const FIXTURE_DIR = resolve(
  M2CHECK
    ? '.local/docking-4.3/round2/test-fixture-owned-m2fast'
    : '.local/docking-4.3/round2/test-fixture-owned',
);
const SHOTS = {
  desktopDefault: 'dockr2-desktop-default.png',
  sideBySide: 'dockr2-side-by-side-ab.png',
  rearranged: 'dockr2-desktop-rearranged.png',
  mobileOff: 'dockr2-mobile-off.png',
};

// ---------------------------------------------------------------------------
// Isolated fixture: real createApp routes/storage, two projects, three
// histories, one seeded roadmap plan. Stub runtime holds every response
// until the test releases it (deterministic delayed-send coverage).
// ---------------------------------------------------------------------------
const temp = await mkdtemp(join(tmpdir(), 'prime-docking-workspace-'));
const cwdA = join(temp, 'Atelier');
const cwdB = join(temp, 'Vtrott');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
await mkdir(cwdA, { recursive: true });
await mkdir(cwdB, { recursive: true });
await mkdir(sessionDir, { recursive: true });

const entry = (id, parentId, role, content, extra = {}) => ({
  type: 'message',
  id,
  parentId,
  message: { role, content, timestamp: Date.now(), ...extra },
});
async function seedSession(file, id, projectCwd, title, paragraphs) {
  const records = [{ type: 'session', id, cwd: projectCwd, version: 3, timestamp: new Date().toISOString() }];
  let parentId = null;
  const link = (record) => {
    record.parentId = parentId;
    records.push(record);
    parentId = record.id;
  };
  link({ type: 'message', id: `${id}-u0`, message: { role: 'user', content: title } });
  // Historical native tool records must reach the real renderer, not just
  // text-only turns. These are fixture records; no tool or model is executed.
  const toolCallId = `${id}-history-tool`;
  link(
    entry(`${id}-tool-call`, null, 'assistant', [
      { type: 'toolCall', id: toolCallId, name: 'ipython', arguments: { code: 'print(2)' } },
    ]),
  );
  link(
    entry(`${id}-tool-result`, null, 'toolResult', `historical-tool-result:${id}`, {
      toolCallId,
      toolName: 'ipython',
      isError: false,
    }),
  );
  paragraphs.forEach((text, index) => {
    link(entry(`${id}-a${index}`, null, 'assistant', text));
    link(entry(`${id}-u${index + 1}`, null, 'user', `Suite ${index + 1} : que faut-il vérifier ensuite ?`));
  });
  link(
    entry(
      `${id}-final`,
      null,
      'assistant',
      'Synthèse disponible. Le panneau reste stable pendant le réarrangement.',
    ),
  );
  await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
}
const longParagraphs = Array.from(
  { length: 14 },
  (_, i) =>
    `Paragraphe de remplissage ${i + 1} : la conversation doit défiler sur plusieurs écrans pour ` +
    'tester le détachement du défilement pendant les déplacements structurels. '.repeat(6),
);
await seedSession(
  join(sessionDir, 'ws-alpha.jsonl'),
  'ws-alpha',
  cwdA,
  "Calibrer la sortie audio de l'Atelier",
  longParagraphs,
);
await seedSession(
  join(sessionDir, 'ws-beta.jsonl'),
  'ws-beta',
  cwdA,
  'Préparer la distribution Windows',
  longParagraphs.slice(0, 4),
);
await seedSession(
  join(sessionDir, 'ws-delta.jsonl'),
  'ws-delta',
  cwdA,
  'Contrôler les sauvegardes du projet',
  longParagraphs.slice(0, 2),
);
await seedSession(
  join(sessionDir, 'ws-gamma.jsonl'),
  'ws-gamma',
  cwdB,
  'Planifier la migration du volant',
  longParagraphs.slice(0, 4),
);
// One real 1px PNG for the genuine attachment path (setInputFiles, no fake).
const pixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const pixelPath = join(temp, 'pixel.png');
await writeFile(pixelPath, pixelPng);

const starts = [];
let cancellations = 0;
const activeControls = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [
      { id: 'fixture/docking', name: 'Docking fixture model', provider: 'fixture', reasoning: true },
      { id: 'fixture/atlas', name: 'Atlas fixture model', provider: 'fixture', reasoning: true },
    ],
    default: { model: 'fixture/docking', thinking: 'medium' },
  }),
  async start(input) {
    const record = { message: input.message, sessionId: input.sessionId || null, cwd: input.cwd };
    starts.push(record);
    let resolveDone;
    const done = new Promise((resolveCompletion) => {
      resolveDone = resolveCompletion;
    });
    const control = {
      record,
      done,
      stream(text) {
        input.onEvent({ kind: 'message', message: { role: 'assistant', text, tools: [] } });
      },
      emitSession(sessionId, cwd) {
        input.onEvent({ kind: 'session', sessionId, cwd: cwd || input.cwd });
      },
      async finish(status = 'completed') {
        const result = {
          kind: 'done',
          sessionId: record.sessionId,
          status,
          code: status === 'completed' ? 0 : 130,
        };
        input.onEvent(result);
        resolveDone(result);
        return result;
      },
      cancel() {
        cancellations++;
        return control.finish('stopped');
      },
    };
    activeControls.push(control);
    // Synchronous session emit (never a timer): a delayed emit can land AFTER
    // finish(), re-adding the server session lock post-completion with no
    // subsequent done to release it. Deterministic order, same payloads.
    if (record.sessionId) {
      try {
        input.onEvent({ kind: 'session', sessionId: record.sessionId, cwd: input.cwd });
      } catch {}
    }
    return control;
  },
  async close() {
    await Promise.all(activeControls.map((control) => control.finish('stopped').catch(() => {})));
  },
};

// Configured-but-disabled remote access (real supported state, no network
// surface): seeded BEFORE createApp so readConfig/get report configured=true
// with every endpoint disabled. networkOptions guarantees no host listener can
// ever bind from this fixture (makeGateway throws instead of binding).
const remoteSalt = 'e'.repeat(32);
const remotePin = '87654321';
await mkdir(dataDir, { recursive: true });
await writeFile(
  join(dataDir, 'lan-access.json'),
  JSON.stringify({
    salt: remoteSalt,
    codeHash: hashAccessCode(remotePin, remoteSalt),
    enabled: false,
    tailscale: { enabled: false, https: { enabled: false } },
  }),
);
const app = createApp({
  runtime,
  agentHome: join(temp, 'agent'),
  sessionDir,
  dataDir,
  initialCwd: cwdA,
  networkOptions: {
    interfaces: () => ({}),
    makeGateway() {
      throw new Error('disabled fixture must not bind');
    },
  },
});
// Two distinct ACCEPTED palette colors via the exact native project-API pattern
// (scripts/test-project-folder-color-ui.mjs): green Atelier, blue Vtrott.
await app.store.project({ cwd: cwdA, color: '#16a34a' }, true);
await app.store.project({ cwd: cwdB, color: '#3b82f6' });
await mkdir(join(temp, 'agent'), { recursive: true });
let roadmapDoc = await app.roadmap.read(cwdA);
roadmapDoc = await app.roadmap.mutate(cwdA, { action: 'init', expectedRevision: roadmapDoc.revision });
roadmapDoc = await app.roadmap.mutate(cwdA, {
  action: 'vision',
  expectedRevision: roadmapDoc.revision,
  text: "Rendre l'espace modulable fiable, mesurable et simple à utiliser.",
});
roadmapDoc = await app.roadmap.mutate(cwdA, {
  action: 'milestone.create',
  expectedRevision: roadmapDoc.revision,
  title: 'Un bureau réarrangeable',
  status: 'active',
});
const milestoneId = roadmapDoc.overview.milestones[0].id;
await app.roadmap.mutate(cwdA, {
  action: 'plan.create',
  expectedRevision: roadmapDoc.revision,
  title: 'Fiabiliser le déplacement des panneaux',
  milestone: milestoneId,
  steps: [{ text: 'Déplacer sans perdre le brouillon' }, { text: 'Conserver le flux actif' }],
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
const fixtureManifest = {
  version: STUDIO_VERSION,
  tempPrefix: 'prime-docking-workspace-',
  projects: [cwdA, cwdB].map((cwd) => ({ cwd, marker: cwd === cwdA ? 'Atelier' : 'Vtrott' })),
  sessions: ['ws-alpha', 'ws-beta', 'ws-gamma', 'ws-delta'],
  ports: 'ephemeral (server.listen(0)); never user Lab 62542, never installed Studio',
  browser: 'owned per-run playwright context via project launcher (scripts/fixtures/browser.mjs)',
  models: 'stub runtime only; zero real model calls',
};

// ---------------------------------------------------------------------------
// Browser + shared helpers.
// ---------------------------------------------------------------------------
const browser = await launchStudioBrowser({ channel: 'chrome' });
const errors = [];
const checks = [];
const measurements = {};
const notes = [];
const usedShots = {};
let proofWritten = false;
let proofPhase = 'boot';

async function freshShot(name) {
  const { access } = await import('node:fs/promises');
  const direct = join(OUT_ROOT, name);
  try {
    await access(direct);
  } catch {
    usedShots[name] = name;
    return direct;
  }
  const dot = name.lastIndexOf('.');
  // Wide collision window: every run keeps its captures (never overwrite), so
  // long iteration histories need room. Past the cap, fail explicitly instead
  // of silently reusing a name.
  for (let n = 2; n < 500; n++) {
    const alt = `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
    try {
      await access(join(OUT_ROOT, alt));
    } catch {
      usedShots[name] = alt;
      return join(OUT_ROOT, alt);
    }
  }
  throw new Error(`No free capture name for ${name}`);
}
function step(text) {
  checks.push(text);
  console.log(`ok - ${text}`);
}
function note(text) {
  notes.push(text);
  console.log(`note - ${text}`);
}
async function seedSelection(context, selection) {
  await context.addInitScript((sel) => {
    if (!localStorage.getItem('prime-studio.selection'))
      localStorage.setItem('prime-studio.selection', JSON.stringify(sel));
  }, selection);
}
async function probeGaps(page, probes) {
  const missing = [];
  for (const [name, selector] of probes) {
    const count = await page
      .locator(selector)
      .count()
      .catch(() => 0);
    if (count === 0) missing.push(`${name} (${selector})`);
  }
  return missing;
}
async function storageEnvelope(page, key) {
  return page.evaluate((storageKey) => {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    try {
      return { raw, parsed: JSON.parse(raw) };
    } catch {
      return { raw, parsed: null, malformed: true };
    }
  }, key);
}
async function snapshotRefs(page) {
  return page.evaluate(() => {
    window.__dockingTestRefs = {
      conversation: document.querySelector('.conversation-column'),
      scroll: document.querySelector('#conversation-scroll'),
      composer: document.querySelector('#composer'),
      roadmap: document.querySelector('#roadmap-panel'),
      inspector: document.querySelector('#details-panel'),
      settings: document.querySelector('#settings-dialog'),
    };
    return { draft: document.querySelector('#composer')?.value ?? null };
  });
}
async function expectRefsStable(page, before, label) {
  const same = await page.evaluate(() => {
    const refs = window.__dockingTestRefs;
    if (!refs) return null;
    const current = {
      conversation: document.querySelector('.conversation-column'),
      scroll: document.querySelector('#conversation-scroll'),
      composer: document.querySelector('#composer'),
      roadmap: document.querySelector('#roadmap-panel'),
      inspector: document.querySelector('#details-panel'),
      settings: document.querySelector('#settings-dialog'),
    };
    return Object.fromEntries(Object.entries(refs).map(([key, node]) => [key, current[key] === node]));
  });
  assert.ok(same, `${label}: __dockingTestRefs missing (page reloaded without re-snapshot?)`);
  for (const [key, identical] of Object.entries(same))
    assert.equal(identical, true, `${label}: DOM node changed for <${key}> (must move, not recreate)`);
  const draft = await page.locator('#composer').inputValue();
  assert.equal(draft, before.draft, `${label}: composer draft lost across structural move`);
}
async function layoutSignature(page) {
  return page.evaluate(() => {
    const groups = [...document.querySelectorAll('[data-dock-group]')].map((group) => ({
      id: group.dataset.dockGroup,
      tabs: [...group.querySelectorAll('button[data-dock-tab]')].map((tab) => tab.dataset.dockTab),
      active: group.querySelector('button[data-dock-tab][aria-selected="true"]')?.dataset.dockTab ?? null,
      width: Math.round(group.getBoundingClientRect().width),
    }));
    const splits = [...document.querySelectorAll('[data-dock-split]')].map(
      (split) => split.dataset.dockSplit,
    );
    const workspace = document.querySelector('#dock-workspace');
    const box = workspace?.getBoundingClientRect();
    return {
      groups,
      splits,
      workspaceActive: Boolean(workspace) && box.width > 0 && getComputedStyle(workspace).display !== 'none',
    };
  });
}
function convTabsOf(signature) {
  return signature.groups
    .flatMap((group) => group.tabs)
    .filter((tab) => tab === 'conversation' || tab.startsWith('conv:'));
}
async function writeProof(extra = {}) {
  // Source fence (central): any production drift between start and finish is
  // recorded, and a would-be pass is DOWNGRADED — green measurements stay as
  // evidence, but the machine-readable status must never advertise a stable
  // integration pass over a moving tree. Enforced runs exit nonzero.
  const sourceEnd = hashSurface();
  const changedPaths = Object.keys(runMeta.sourceStart).filter(
    (key) => runMeta.sourceStart[key] !== sourceEnd[key],
  );
  let status = extra.status || 'pass';
  let downgraded = null;
  if (status === 'pass' && changedPaths.length > 0) {
    status = 'blocked';
    downgraded = 'source-drift';
    notes.push(`SOURCE DRIFT, not a stable pass (changed: ${changedPaths.join(', ')})`);
    if (M2_ENFORCE || RUN_DEEP) process.exitCode = 1;
  }
  const payload = {
    status,
    version: STUDIO_VERSION,
    phase: proofPhase,
    checks,
    errors,
    notes,
    modelCalls: starts.length,
    cancellations,
    measurements,
    shots: usedShots,
    storageKeys: { layout: LAYOUT_KEY, presets: PRESETS_KEY, conversations: CONV_KEY, drafts: DRAFTS_KEY },
    deferred,
    sourceStart: runMeta.sourceStart,
    sourceEnd,
    changedPaths,
    sourceDrift: changedPaths.length > 0,
    downgraded,
    startedAt: runMeta.startedAt,
    finishedAt: new Date().toISOString(),
    deepChain: RUN_DEEP ? 'enabled' : 'held',
    ...extra,
    status,
    ...(downgraded ? { downgraded } : {}),
  };
  await mkdir(OUT_ROOT, { recursive: true });
  await writeFile(PROOF_PATH, JSON.stringify(payload, null, 2));
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(join(FIXTURE_DIR, 'fixture-manifest.json'), JSON.stringify(fixtureManifest, null, 2));
  proofWritten = true;
  console.log(JSON.stringify({ checks: checks.length, errors, modelCalls: starts.length }, null, 2));
}

const storageSnapshots = {};
async function dumpOwnedStorage(page, label) {
  // Fixture-owned artifact: raw storage envelopes at each milestone (truncated
  // values). Doubles as a failure diagnostic for reload/migration phases.
  const snapshot = await page.evaluate(
    (keys) => {
      const out = {};
      for (const key of keys) {
        const raw = localStorage.getItem(key);
        out[key] = raw === null ? null : raw.slice(0, 900);
      }
      return out;
    },
    [LAYOUT_KEY, PRESETS_KEY, CONV_KEY, DRAFTS_KEY, 'prime-studio.selection'],
  );
  storageSnapshots[label] = snapshot;
  measurements[`storage:${label}`] = snapshot;
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(join(FIXTURE_DIR, 'storage-snapshots.json'), JSON.stringify(storageSnapshots, null, 2));
}

async function manuallyDetachScroller(page, scroller = '#conversation-scroll') {
  await page.locator(scroller).first().hover();
  await page.mouse.wheel(0, -600);
  await expect
    .poll(
      () =>
        page.evaluate((sel) => {
          const node = document.querySelector(sel);
          return node.scrollHeight - node.clientHeight - node.scrollTop;
        }, scroller),
      { timeout: 10000 },
    )
    .toBeGreaterThan(20);
}
async function manualDrag(page, fromBox, toBox, observePreview) {
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  const steps = 10;
  let previewSeen = false;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      fromBox.x + ((toBox.x - fromBox.x) * i) / steps,
      fromBox.y + ((toBox.y - fromBox.y) * i) / steps,
      { steps: 2 },
    );
    if (observePreview && i === Math.floor(steps / 2)) {
      previewSeen = await page
        .locator(DOCK.dropPreview)
        .isVisible()
        .catch(() => false);
    }
  }
  await page.mouse.move(toBox.x, toBox.y);
  await page.mouse.move(toBox.x, toBox.y);
  if (observePreview && !previewSeen)
    previewSeen = await page
      .locator(DOCK.dropPreview)
      .isVisible()
      .catch(() => false);
  await page.mouse.up();
  return previewSeen;
}
async function openLayoutDialog(page) {
  await page.locator(DOCK.openButton).click();
  await expect(page.locator(DOCK.dialog)).toBeVisible({ timeout: 10000 });
}
async function openLayoutDialogViaEllipsis(page, groupId = 'conversation-group') {
  // New Unity path: the group ellipsis (⋯) intentionally opens the context
  // menu, NOT the dialog. Selecting Agencement/Layout afterwards is the
  // legitimate feature path, not a test weakening.
  await page.locator(`[data-dock-group="${groupId}"]`).locator(DOCK.ellipsis).click();
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page
    .locator(DOCK.contextMenu)
    .getByRole('menuitem', { name: /Agencement|Layout/ })
    .click();
  await expect(page.locator(DOCK.dialog)).toBeVisible({ timeout: 10000 });
}
async function convTabIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('button[data-dock-tab]')]
      .map((tab) => tab.dataset.dockTab)
      .filter((tab) => tab === 'conversation' || tab.startsWith('conv:')),
  );
}
// Geometry: the live host must mount exactly once, inside the dock, in the
// primary slot when docked — never as an extra classic column. Every visible
// conversation pane must contain its own transcript + composer with usable
// width (catches unmounted-host / tiny-group regressions with real boxes).
async function hostMountInfo(page) {
  return page.evaluate(() => {
    const hosts = [...document.querySelectorAll('.conversation-column')];
    const ws = document.querySelector('#dock-workspace');
    const wsBox = ws?.getBoundingClientRect();
    const hostBox = hosts[0]?.getBoundingClientRect();
    const slot = document.querySelector('.cvw-shell[data-view="conversation"] .cvw-host-slot');
    const frame = document.getElementById('dock-view-conversation');
    return {
      count: hosts.length,
      inDock: hosts.length === 1 && !!hosts[0]?.closest('#dock-workspace'),
      inPrimarySlot: hosts.length === 1 && !!slot?.contains(hosts[0]),
      classicColumn: !!document.querySelector('.workspace-body > .conversation-column'),
      hostWidth: hostBox ? Math.round(hostBox.width) : 0,
      hostLeft: hostBox ? Math.round(hostBox.x) : -1,
      workspaceWidth: wsBox ? Math.round(wsBox.width) : 0,
      primaryVisible: !!frame && !frame.hidden && hostBox ? hostBox.width > 0 : false,
    };
  });
}
async function assertHostMount(page, label) {
  const mount = await hostMountInfo(page);
  measurements[`mount:${label}`] = mount;
  assert.equal(mount.count, 1, `${label}: exactly one live conversation host exists`);
  assert.equal(mount.inDock, true, `${label}: host is mounted inside the dock workspace`);
  assert.equal(mount.inPrimarySlot, true, `${label}: host lives in the primary slot when docked`);
  assert.equal(mount.classicColumn, false, `${label}: no classic column consumes the main layout`);
  // Width floor applies only when the primary tab itself is visible; an
  // inactive primary tab legitimately hides its frame (standard tab UX).
  if (mount.primaryVisible) {
    assert.ok(
      mount.hostWidth >= 240 && mount.hostWidth <= mount.workspaceWidth,
      `${label}: host pane has usable width (got ${mount.hostWidth}px of ${mount.workspaceWidth}px)`,
    );
  }
  step(
    `${label}: host mounted once in primary slot, no classic column` +
      (mount.primaryVisible ? ', usable width.' : ' (primary tab inactive, width check skipped).'),
  );
}
async function paneGeometry(page, ids) {
  // Scrollable transcripts are TALLER than their pane by design: pin the
  // scroller box inside the shell plus the messages' horizontal edges inside
  // the scroller (a full-box containment check misfires on scrolled content).
  // Composers never scroll, so they keep full containment.
  return page.evaluate((viewIds) => {
    const within = (inner, outer, tol = 6) => {
      if (!inner || !outer) return false;
      const a = inner.getBoundingClientRect();
      const b = outer.getBoundingClientRect();
      return (
        a.left >= b.left - tol &&
        a.top >= b.top - tol &&
        a.right <= b.right + tol &&
        a.bottom <= b.bottom + tol
      );
    };
    const visible = (node) => !!node && node.getClientRects().length > 0;
    const result = {};
    for (const id of viewIds) {
      const shell = document.querySelector(`.cvw-shell[data-view="${id}"]`);
      const frame = document.getElementById(`dock-view-${id}`);
      const scrollers = shell ? [...shell.querySelectorAll('.cvw-scroller, #conversation-scroll')] : [];
      const scroller = scrollers.find(visible) || null;
      const messages = scroller
        ? scroller.querySelector('.cvw-messages') || (scroller.id === 'conversation-scroll' ? scroller : null)
        : null;
      const composerShown = shell
        ? [...shell.querySelectorAll('[data-cvw="composer"], #composer')].find(visible) || null
        : null;
      const box = shell?.getBoundingClientRect();
      const scrollerBox = scroller?.getBoundingClientRect();
      const messagesBox = messages?.getBoundingClientRect();
      result[id] = {
        shellVisible: !!box && box.width > 0,
        shellWidth: box ? Math.round(box.width) : 0,
        inFrame: !!frame && !!shell && frame.contains(shell),
        hasTranscript: !!messages,
        transcriptInPane: !!(
          shell &&
          scroller &&
          messages &&
          within(scroller, shell) &&
          messagesBox.left >= scrollerBox.left - 8 &&
          messagesBox.right <= scrollerBox.right + 8 &&
          messagesBox.bottom >= scrollerBox.top - 8 &&
          messagesBox.top <= scrollerBox.bottom + 8
        ),
        hasComposer: !!composerShown,
        composerInPane: !!(shell && composerShown && within(composerShown, shell)),
        composerVisible: visible(composerShown),
      };
    }
    return result;
  }, ids);
}
async function assertPaneGeometry(page, ids, label) {
  const geo = await paneGeometry(page, ids);
  measurements[`panes:${label}`] = geo;
  for (const id of ids) {
    const pane = geo[id];
    assert.ok(pane.shellVisible, `${label}: pane ${id} is visible`);
    assert.ok(pane.inFrame, `${label}: pane ${id} is mounted in its dock frame`);
    assert.ok(pane.shellWidth >= 240, `${label}: pane ${id} has usable width (got ${pane.shellWidth}px)`);
    assert.ok(pane.hasTranscript && pane.transcriptInPane, `${label}: transcript of ${id} inside its pane`);
    assert.ok(
      pane.hasComposer && pane.composerInPane && pane.composerVisible,
      `${label}: composer of ${id} inside its pane and visible`,
    );
  }
  step(`${label}: every conversation transcript+composer contained in its pane.`);
}
// Per-view controls (M2): PRIMARY maps to the host classic IDs, dynamic IDs
// map to their own data-cvw scope. Never use a generic focused input when
// asserting an inactive pane — address the owner explicitly.
async function shellIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.cvw-shell[data-view]')].map((node) => node.dataset.view),
  );
}
const vPane = (page, id) => page.locator(`.cvw-shell[data-view="${id}"]`);
const vComposer = (page, id) =>
  id === 'conversation'
    ? vPane(page, id).locator('#composer')
    : vPane(page, id).locator('[data-cvw="composer"]');
const vSend = (page, id) =>
  id === 'conversation'
    ? vPane(page, id).locator('#send-button')
    : vPane(page, id).locator('[data-cvw="send"]');
const vStop = (page, id) =>
  id === 'conversation'
    ? vPane(page, id).locator('#stop-button')
    : vPane(page, id).locator('[data-cvw="stop"]');
const vTray = (page, id) =>
  id === 'conversation'
    ? vPane(page, id).locator('#image-draft-tray')
    : vPane(page, id).locator('[data-cvw="tray"]');
const vFiles = (page, id) => vPane(page, id).locator('input[type="file"]');
const vText = async (page, id) =>
  vComposer(page, id).evaluate((node) => node.value ?? node.textContent ?? '');
const vFill = async (page, id, text) => vComposer(page, id).fill(text);
async function markShell(page, viewId) {
  await page.evaluate((id) => {
    window.__dockingShellRef = document.querySelector(`.cvw-shell[data-view="${id}"]`);
  }, viewId);
}
async function shellSameAsMarked(page) {
  return page.evaluate(() => {
    const marked = window.__dockingShellRef;
    if (!marked) return null;
    const current = marked.dataset?.view
      ? document.querySelector(`.cvw-shell[data-view="${marked.dataset.view}"]`)
      : null;
    return current === marked;
  });
}
async function viewMessagesText(page, viewId) {
  // Primary renders its transcript through the live host column (its bg shell
  // never renders while docked); dynamic views render their own shell messages.
  return page.evaluate((id) => {
    if (id === 'conversation') return document.getElementById('messages')?.textContent || '';
    const shell = document.querySelector(`.cvw-shell[data-view="${id}"]`);
    return shell?.querySelector('.cvw-messages')?.textContent || '';
  }, viewId);
}
async function expectHistoricalTool(page, viewId, sessionId) {
  const messages =
    viewId === 'conversation'
      ? page.locator('#messages')
      : page.locator(`.cvw-shell[data-view="${viewId}"] .cvw-messages`);
  const tool = messages.locator('.tool-block').filter({ hasText: `historical-tool-result:${sessionId}` });
  await expect(messages).toBeVisible();
  await expect(tool).toHaveCount(1);
  await expect(tool.locator('.tool-name')).toHaveText('ipython');
  await expect(tool.locator('.tool-content')).toContainText(`historical-tool-result:${sessionId}`);
}

async function focusConvTab(page, viewId) {
  // Real UI path: click the dock tab, then require the tab to report
  // aria-selected (bounded, no arbitrary sleep).
  await page.locator(`button[data-dock-tab="${viewId}"]`).click();
  await expect(page.locator(`button[data-dock-tab="${viewId}"][aria-selected="true"]`)).toBeAttached({
    timeout: 10000,
  });
}

let page;
try {
  await mkdir(OUT_ROOT, { recursive: true });
  const context = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 1600, height: 1000 },
    reducedMotion: 'reduce',
  });
  await seedSelection(context, { cwd: cwdA, sessionId: 'ws-alpha', projectOverview: false });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) =>
    errors.push(String(error?.stack || error?.message || error).slice(0, 1200)),
  );
  page.on('dialog', async (dialog) => {
    // Preset overwrite/delete use the INLINE confirm; a native dialog here is
    // a product bug, never an expected step.
    errors.push(`unexpected native dialog (${dialog.type()}): ${dialog.message()}`);
    await dialog.dismiss().catch(() => {});
  });
  const runPosts = [];
  measurements.runPosts = runPosts;
  page.on('response', async (response) => {
    try {
      const request = response.request();
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs') {
        const entry = { status: response.status(), at: new Date().toISOString() };
        try {
          entry.url = new URL(request.url()).pathname;
        } catch {}
        try {
          const sent = JSON.parse(request.postData() || '{}');
          entry.sessionId = sent.sessionId || null;
        } catch {}
        if (response.status() >= 400) {
          try {
            entry.body = (await response.text()).slice(0, 300);
          } catch {}
        }
        runPosts.push(entry);
      }
    } catch {}
  });

  // ================================== M2 FAST PATH =========================
  // DOCKR2_M2CHECK=1 runs ONLY this focused check, then returns (finally[]
  // cleanup still runs): boot, opt-in, two session-bound views via the real
  // picker, side-by-side, old-bar absent, 2 full per-pane composers, drafts,
  // first-click send, targeted send. Neither the 46-check chain nor the
  // updates-bootstrap phase runs here. Local helpers (m2f prefix) keep this
  // path independent of later phase code.
  if (M2CHECK) {
    proofPhase = 'm2-fastpath';
    const m2fPane = (id) => page.locator(`.cvw-shell[data-view="${id}"]`);
    const m2fCtl = (id, role) => m2fPane(id).locator(`[data-cvw="${role}"]`);
    const m2fHostText = async () =>
      m2fPane('conversation')
        .locator('#composer')
        .evaluate((node) => node.value ?? node.textContent ?? '');
    const m2fText = async (id) =>
      m2fCtl(id, 'composer').evaluate((node) => node.value ?? node.textContent ?? '');
    const m2fMarker = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.dock-tab.is-conversation.is-focused')].map(
          (el) => el.dataset.dockTab,
        ),
      );
    await page.goto(url);
    await expect(page.locator('#connection-label')).toContainText('connecté', { timeout: 20000 });
    await openLayoutDialog(page);
    await page.locator(DOCK.toggle).check();
    await expect(page.locator(DOCK.workspace)).toBeVisible({ timeout: 10000 });
    await page.locator(DOCK.closeSettings).click();
    // Wiring mounts per-view composers, so the probe only means something AFTER
    // provisioning. Reader defined here, gated poll runs post-arrange below.
    const m2fReadProbe = () =>
      page.evaluate(() => ({
        total: document.querySelectorAll('#dock-workspace [data-cvw="composer"]').length,
        visible: [...document.querySelectorAll('#dock-workspace [data-cvw="composer"]')].filter(
          (node) => node.getClientRects().length,
        ).length,
      }));
    // Provision primary + dynamics through real UI (no 46-check chain here).
    async function m2fPickSession(project, title) {
      const groups = await layoutSignature(page);
      await page.locator(`[data-dock-group="${groups.groups[0].id}"]`).locator(DOCK.ellipsis).click();
      await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
      await page.locator(DOCK.contextMenu).locator('[aria-haspopup="menu"]').click();
      await page.locator(`${DOCK.addOption}[data-dock-add="new-conversation"]`).click();
      await expect(page.locator(DOCK.picker)).toBeVisible({ timeout: 10000 });
      const rows = page.locator(`${DOCK.picker} .conv-pick-row`);
      await expect.poll(() => rows.count(), { timeout: 10000 }).toBeGreaterThan(0);
      const names = await rows.allTextContents();
      const projectIndex = names.findIndex((text) => text.includes(project));
      assert.ok(projectIndex >= 0, `Fast path project row ${project} must exist`);
      await rows.nth(projectIndex).click();
      await expect(page.locator(DOCK.pickerTitle)).toContainText(project, { timeout: 10000 });
      const sessionRows = page.locator(`${DOCK.picker} .conv-pick-row`);
      await expect.poll(() => sessionRows.count(), { timeout: 10000 }).toBeGreaterThan(0);
      const sessionNames = await sessionRows.allTextContents();
      const sessionIndex = sessionNames.findIndex((text) => text.includes(title));
      assert.ok(sessionIndex >= 0, `Fast path session row ${title} must exist`);
      const tabsBefore = await convTabIds(page);
      await sessionRows.nth(sessionIndex).click();
      await expect(page.locator(DOCK.picker)).toBeHidden({ timeout: 10000 });
      await expect
        .poll(() => convTabIds(page).then((tabs) => tabs.length), { timeout: 15000 })
        .toBe(tabsBefore.length + 1);
      const tabsAfter = await convTabIds(page);
      return tabsAfter.find((tab) => !tabsBefore.includes(tab));
    }
    // Primary bound via the real sidebar; dynamics via the real picker.
    await page.locator('button[data-dock-tab="conversation"]').click();
    await page.locator('#session-list .session-select').filter({ hasText: 'Calibrer la sortie' }).click();
    await expect(page.locator('#detail-session-id')).toContainText('ws-alpha', { timeout: 10000 });
    const m2fDyn = await m2fPickSession('Atelier', 'Préparer la distribution');
    const m2fDyn2 = await m2fPickSession('Vtrott', 'migration du volant');
    assert.ok(m2fDyn?.startsWith('conv:'), 'Fast path mounts a dynamic tab');
    // Side-by-side: primary and dynamic in different groups, each active.
    let m2fSig = await layoutSignature(page);
    const m2fGA = m2fSig.groups.find((group) => group.tabs.includes('conversation'));
    const m2fGB = m2fSig.groups.find((group) => group.tabs.includes(m2fDyn));
    if (m2fGA && m2fGB && m2fGA.id === m2fGB.id) {
      await openLayoutDialog(page);
      await page.locator(DOCK.panelSelect).selectOption(m2fDyn);
      await page.locator(DOCK.targetSelect).selectOption(m2fGA.id);
      await page.locator(DOCK.zoneSelect).selectOption('right');
      await page.locator(DOCK.moveButton).click();
      await page.locator(DOCK.closeSettings).click();
    }
    await page.locator(`button[data-dock-tab="${m2fDyn}"]`).click();
    await page.locator('button[data-dock-tab="conversation"]').click();
    assert.deepEqual(await m2fMarker(), ['conversation'], 'Fast path focuses primary with a unique marker');
    await expectHistoricalTool(page, 'conversation', 'ws-alpha');
    await expectHistoricalTool(page, m2fDyn, 'ws-beta');
    if (!M2_ENFORCE) {
      try {
        await expect
          .poll(() => m2fReadProbe().then((probe) => probe.visible), { timeout: 15000 })
          .toBeGreaterThanOrEqual(1);
      } catch {
        measurements.m2Fastpath = await m2fReadProbe();
        note('DEFERRED: fast path needs a wired dynamic pane');
        deferred.push('m2-fastpath-composers');
        await writeProof({ status: 'partial' });
        throw new FastDone('partial');
      }
    } else {
      await expect
        .poll(() => m2fReadProbe().then((probe) => probe.visible), { timeout: 15000 })
        .toBeGreaterThanOrEqual(1);
    }
    measurements.m2Fastpath = await m2fReadProbe();
    await assertHostMount(page, 'm2fast');
    await assertPaneGeometry(page, ['conversation', m2fDyn], 'm2fast');
    // Bottom alignment + editable width (same row, same height): both
    // composers bottom-docked (not mid-pane) with usable edit width (not ~1px
    // collapse). Pinned on real boxes, not only containment.
    // Bottoms track the composer FORM block (input + toolbar); the edit width
    // tracks the actual editable (textarea/div). Measuring the textarea bottom
    // instead would pin toolbar height, not docking.
    const m2fAlign = await page.evaluate(
      (ids) => {
        const boxOf = (id, sel) =>
          document.querySelector(`.cvw-shell[data-view="${id}"] ${sel}`)?.getBoundingClientRect() || null;
        const entry = (id) => {
          const pane = document.querySelector(`.cvw-shell[data-view="${id}"]`)?.getBoundingClientRect();
          const form =
            boxOf(id, '[data-cvw="composer-form"]') ||
            (id === 'conversation' ? boxOf(id, '#composer-form') : null);
          const editable =
            boxOf(id, '[data-cvw="composer"]') || (id === 'conversation' ? boxOf(id, '#composer') : null);
          return {
            paneBottom: pane ? Math.round(pane.bottom) : -1,
            composerBottom: form ? Math.round(form.bottom) : -1,
            composerWidth: editable ? Math.round(editable.width) : -1,
          };
        };
        return { a: entry(ids[0]), b: entry(ids[1]) };
      },
      ['conversation', m2fDyn],
    );
    measurements['align:m2fast'] = m2fAlign;
    for (const [key, pane] of Object.entries(m2fAlign)) {
      assert.ok(
        pane.composerWidth >= 200,
        `m2fast ${key}: editable width usable (got ${pane.composerWidth}px)`,
      );
      assert.ok(
        pane.paneBottom - pane.composerBottom <= 64 && pane.paneBottom - pane.composerBottom >= -8,
        `m2fast ${key}: composer bottom-docked (gap ${pane.paneBottom - pane.composerBottom}px)`,
      );
    }
    assert.ok(
      Math.abs(m2fAlign.a.composerBottom - m2fAlign.b.composerBottom) <= 12,
      `m2fast: both composers share one baseline (bottoms ${m2fAlign.a.composerBottom} vs ${m2fAlign.b.composerBottom})`,
    );
    step('m2fast: composers bottom-aligned at the same height with usable edit width.');
    // Old bar absent; primary host + dynamic data-cvw controls present.
    for (const id of ['conversation', m2fDyn]) {
      assert.equal(await m2fPane(id).locator('.cvw-bar').count(), 0, `Old header bar absent in ${id}`);
      assert.equal(await m2fPane(id).locator('.cvw-focus').count(), 0, `Old edit button absent in ${id}`);
    }
    await expect(m2fPane('conversation').locator('#composer')).toBeVisible({ timeout: 10000 });
    await expect(m2fCtl(m2fDyn, 'composer')).toBeVisible({ timeout: 10000 });
    await expect(m2fCtl(m2fDyn, 'send')).toBeAttached({ timeout: 10000 });
    await expect(m2fCtl(m2fDyn, 'model')).toBeAttached({ timeout: 10000 });
    await expect(m2fCtl(m2fDyn, 'thinking')).toBeAttached({ timeout: 10000 });
    await expect(m2fCtl(m2fDyn, 'tray')).toBeAttached({ timeout: 10000 });
    step('Fast path: old bar absent, primary host + dynamic data-cvw composers visible.');
    for (const id of ['conversation', m2fDyn]) {
      assert.equal(
        await m2fPane(id).locator('.composer-input-row').count(),
        1,
        `Fast path pane ${id} has exactly one composer input row (no double-wrap)`,
      );
    }
    step('Fast path: single composer input row per pane.');
    await m2fPane('conversation').locator('#composer').fill('M2F-draft-PRIMARY');
    await m2fCtl(m2fDyn, 'composer').fill('M2F-draft-DYN');
    assert.equal(await m2fHostText(), 'M2F-draft-PRIMARY');
    assert.equal(await m2fText(m2fDyn), 'M2F-draft-DYN');
    await page.screenshot({ path: await freshShot('m2fast-side-by-side.png'), animations: 'disabled' });
    // N1-fast: Nouvelle-conversation button + Ctrl+N target the focused tab.
    // No extra tab/view/run; targeted composer cleared with native focus;
    // primary session/draft intact. Rebinds restore the send matrix afterwards.
    const m2fTabs0 = await convTabIds(page);
    const m2fShells0 = await shellIds(page);
    const m2fStarts0 = starts.length;
    async function m2fAssertNewChat(tabId, oldSessionId, label) {
      assert.deepEqual([...(await convTabIds(page))].sort(), [...m2fTabs0].sort(), `${label}: no extra tab`);
      assert.deepEqual([...(await shellIds(page))].sort(), [...m2fShells0].sort(), `${label}: no extra view`);
      assert.deepEqual(await m2fMarker(), [tabId], `${label}: exact focused-view marker`);
      assert.equal(starts.length, m2fStarts0, `${label}: no model run`);
    }
    async function m2fNativeComposerFocus(tabId) {
      const composer =
        tabId === 'conversation'
          ? m2fPane(tabId).locator('#composer')
          : m2fPane(tabId).locator('[data-cvw="composer"]');
      assert.equal(
        await page.evaluate((el) => document.activeElement === el, await composer.elementHandle()),
        true,
        `Native textarea focus in ${tabId}`,
      );
    }
    await page.locator(`button[data-dock-tab="${m2fDyn}"]`).click();
    await page.locator('#new-session').click();
    await expect.poll(() => m2fText(m2fDyn), { timeout: 10000 }).toBe('');
    await m2fAssertNewChat(m2fDyn, 'ws-beta', 'button new-chat');
    await m2fNativeComposerFocus(m2fDyn);
    assert.ok(
      !(
        await page
          .locator('#detail-session-id')
          .textContent()
          .catch(() => 'ws-beta')
      ).includes('ws-beta'),
      'button new-chat: inspector drops the old session',
    );
    assert.equal(await m2fHostText(), 'M2F-draft-PRIMARY', 'button new-chat: primary draft preserved');
    step('Fast N1: button rebinds the focused dynamic tab (no extra tab/run).');
    // Restore ws-beta binding + draft for the send matrix below.
    await page.locator(`button[data-dock-tab="${m2fDyn}"]`).click();
    await page
      .locator('#session-list .session-select')
      .filter({ hasText: 'Préparer la distribution' })
      .click();
    await expect(page.locator('#detail-session-id')).toContainText('ws-beta', { timeout: 10000 });
    await m2fCtl(m2fDyn, 'composer').fill('M2F-draft-DYN');
    await page.locator(`button[data-dock-tab="${m2fDyn2}"]`).click();
    await m2fCtl(m2fDyn2, 'composer').fill('M2F-draft-DYN2');
    await page.locator(`button[data-dock-tab="${m2fDyn}"]`).click();
    await page.keyboard.press('Control+n');
    await expect.poll(() => m2fText(m2fDyn), { timeout: 10000 }).toBe('');
    await m2fAssertNewChat(m2fDyn, 'ws-beta', 'Ctrl+N new-chat');
    await m2fNativeComposerFocus(m2fDyn);
    assert.equal(await m2fHostText(), 'M2F-draft-PRIMARY', 'Ctrl+N new-chat: primary draft preserved');
    step('Fast N1: Ctrl+N rebinds the focused dynamic tab (no extra tab/run).');
    await page.locator(`button[data-dock-tab="${m2fDyn}"]`).click();
    await page
      .locator('#session-list .session-select')
      .filter({ hasText: 'Préparer la distribution' })
      .click();
    await expect(page.locator('#detail-session-id')).toContainText('ws-beta', { timeout: 10000 });
    await m2fCtl(m2fDyn, 'composer').fill('M2F-draft-DYN');
    await page.locator('button[data-dock-tab="conversation"]').click();
    const m2fFiles = await m2fPane(m2fDyn).locator('input[type="file"]').count();
    if (m2fFiles > 0) {
      await m2fPane(m2fDyn).locator('input[type="file"]').first().setInputFiles(pixelPath);
      await expect(m2fCtl(m2fDyn, 'tray')).toBeVisible({ timeout: 10000 });
      step('Fast path: per-pane attachment lands in the owning tray.');
    } else if (M2_ENFORCE) {
      throw new Error('M2 enabled but no per-pane file input wired (fast path)');
    } else {
      note('Fast path attachment deferred: no per-pane file input yet.');
      deferred.push('m2-fastpath-attachments');
    }
    // First click on the inactive dynamic send focuses + sends in one gesture.
    await m2fCtl(m2fDyn, 'send').click();
    await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(1);
    assert.equal(
      activeControls[activeControls.length - 1].record.sessionId,
      'ws-beta',
      'Fast path dynamic send binds ws-beta',
    );
    assert.deepEqual(await m2fMarker(), [m2fDyn], 'Fast path send focuses its owner');
    await activeControls[activeControls.length - 1].finish('completed');
    assert.equal(await m2fHostText(), 'M2F-draft-PRIMARY', 'Fast path primary draft survives dynamic send');
    // Second dynamic covers ws-gamma; primary send covers ws-alpha.
    await page.locator(`button[data-dock-tab="${m2fDyn2}"]`).click();
    await m2fCtl(m2fDyn2, 'composer').fill('M2F-draft-DYN2');
    await m2fCtl(m2fDyn2, 'send').click();
    await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(2);
    assert.equal(
      activeControls[activeControls.length - 1].record.sessionId,
      'ws-gamma',
      'Fast path second dynamic binds ws-gamma',
    );
    await activeControls[activeControls.length - 1].finish('completed');
    await page.locator('button[data-dock-tab="conversation"]').click();
    await m2fPane('conversation').locator('#composer').fill('M2F-draft-PRIMARY');
    await m2fPane('conversation').locator('#send-button').click();
    await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(3);
    assert.equal(
      activeControls[activeControls.length - 1].record.sessionId,
      'ws-alpha',
      'Fast path primary send binds ws-alpha',
    );
    await activeControls[activeControls.length - 1].finish('completed');
    assert.equal(cancellations, 0, 'Fast path never cancels');
    assert.deepEqual(errors, [], `Fast path keeps zero page errors, got ${JSON.stringify(errors)}`);
    step('Fast path: independent drafts, first-click send, targeted sends, zero cancels/errors.');
    await writeProof({ status: deferred.length ? 'partial' : 'pass' });
    throw new FastDone(deferred.length ? 'partial' : 'pass');
  }

  // ------------------------------------------------ Phase 0: classic baseline (two projects, three histories).
  proofPhase = 'classic-baseline';
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connecté');
  await page.locator('#session-list .session-select').filter({ hasText: 'Calibrer la sortie' }).click();
  await expect(page.locator('#messages')).toContainText('Synthèse disponible');
  if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
  await page.locator('#inspector-tab-session').click();
  await expect(page.locator('#detail-session-id')).toContainText('ws-alpha');
  step('Classic baseline: Atelier session ws-alpha renders with inspector session id.');
  await expectHistoricalTool(page, 'conversation', 'ws-alpha');
  step('Historical native tool call/result renders in classic mode without hiding the transcript.');
  await page.locator('#project-list .project-row').filter({ hasText: 'Vtrott' }).click();
  await page.locator('#session-list .session-select').filter({ hasText: 'migration du volant' }).click();
  await expect(page.locator('#messages')).toContainText('Planifier la migration');
  step('Classic baseline: second project Vtrott session ws-gamma loads (2 projects, 3 histories seeded).');
  await page.locator('#project-list .project-row').filter({ hasText: 'Atelier' }).click();
  await page.locator('#session-list .session-select').filter({ hasText: 'Calibrer la sortie' }).click();
  await expect(page.locator('#messages')).toContainText('Synthèse disponible');
  await page.locator('#composer').fill('Brouillon baseline à conserver');
  await manuallyDetachScroller(page);
  const refState = await snapshotRefs(page);
  assert.equal(refState.draft, 'Brouillon baseline à conserver');
  step('Composer draft typed and scroller detached with a real wheel event; host refs snapshotted.');

  // ------------------------------------------------ Phase 1: parent-surface contract preflight.
  proofPhase = 'parent-contract';
  const gapsA = await probeGaps(page, [
    ['openButton', DOCK.openButton],
    ['dialog', DOCK.dialog],
    ['toggle', DOCK.toggle],
    ['closeSettings', DOCK.closeSettings],
    ['reset', DOCK.reset],
    ['panelSelect', DOCK.panelSelect],
    ['targetSelect', DOCK.targetSelect],
    ['zoneSelect', DOCK.zoneSelect],
    ['moveButton', DOCK.moveButton],
    ['newConversation', DOCK.newConversation],
    ['contextMenu', DOCK.contextMenu],
    ['addMenu', DOCK.addMenu],
    ['presetName', DOCK.presetName],
    ['presetSave', DOCK.presetSave],
    ['presetChoice', DOCK.presetChoice],
    ['presetLoad', DOCK.presetLoad],
    ['presetDelete', DOCK.presetDelete],
    ['presetConfirm', DOCK.presetConfirm],
    ['presetCancel', DOCK.presetCancel],
    ['presetStatus', DOCK.presetStatus],
  ]);
  if (gapsA.length > 0) {
    await writeProof({ status: 'blocked', phase: proofPhase, contractGaps: gapsA });
    throw new Error('Round-2 parent contract not implemented yet. Missing: ' + gapsA.join(', '));
  }
  step('Parent contract present: dialog, toggle, ellipsis menus, presets controls, storage keys.');

  // ------------------------------------------------ Phase 2: opt-in + V3 default envelope.
  proofPhase = 'optin-v3';
  await openLayoutDialog(page);
  await page.locator(DOCK.toggle).check();
  await expect(page.locator(DOCK.workspace)).toBeVisible();
  assert.equal(
    await page.evaluate(() => window.matchMedia('(min-width: 1081px)').matches),
    true,
    '1600px viewport must match the desktop docking gate',
  );
  await expectRefsStable(page, refState, 'opt-in');
  let signature = await layoutSignature(page);
  assert.equal(signature.workspaceActive, true, 'workspace must be active after opt-in');
  const envelope = await storageEnvelope(page, LAYOUT_KEY);
  assert.ok(envelope?.parsed, 'V3 layout envelope must be stored');
  assert.equal(envelope.parsed.version, 3, 'Saved layout envelope must be canonical version 3');
  assert.equal(envelope.parsed.enabled, true, 'Envelope must record enabled:true');
  assert.ok(envelope.parsed.root, 'Envelope must carry the layout root');
  const envelopeRaw = envelope.raw;
  assert.ok(
    !envelopeRaw.includes('sessionId') &&
      !envelopeRaw.includes('conv:') &&
      !envelopeRaw.includes('inspector'),
    'Default V3 envelope carries geometry only (no session ids, no conv refs, no monolithic inspector)',
  );
  signature = await layoutSignature(page);
  assert.deepEqual(
    signature.groups.map((group) => [group.id, group.tabs]),
    [
      ['conversation-group', ['conversation']],
      ['tools-group', ['roadmap', 'session', 'agents', 'files']],
    ],
    'V3 default mounts conversation plus the 4 independent tool tabs',
  );
  assert.equal(
    signature.groups.find((group) => group.id === 'tools-group').active,
    'roadmap',
    'V3 default tools group activates roadmap',
  );
  await page.locator(DOCK.closeSettings).click();
  await expect(page.locator(DOCK.dialog)).not.toBeVisible();
  await page.screenshot({ path: await freshShot(SHOTS.desktopDefault), animations: 'disabled' });
  step('Opt-in enables dock with V3 envelope (version 3, 5-tab default); same host nodes.');
  await assertHostMount(page, 'opt-in');

  // ------------------------------------------------ Phase 3: ellipsis opens the context menu, Agencement opens settings.
  proofPhase = 'ellipsis-menu';
  const ellipsis = page.locator('[data-dock-group="conversation-group"]').locator(DOCK.ellipsis);
  await ellipsis.click();
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  assert.equal(
    await page.locator(DOCK.contextMenu).getAttribute('role'),
    'menu',
    'Context menu exposes role=menu',
  );
  const submenuTrigger = page.locator(DOCK.contextMenu).locator('[aria-haspopup="menu"]');
  assert.ok((await submenuTrigger.count()) >= 1, 'AddTab submenu trigger (aria-haspopup) must exist');
  await page
    .locator(DOCK.contextMenu)
    .getByRole('menuitem', { name: /Agencement|Layout/ })
    .click();
  await expect(page.locator(DOCK.dialog)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.closeSettings).click();
  step('Group ellipsis opens the context menu; the Agencement/Layout item opens settings (feature path).');
  // Right-click on an empty bar area + on a tab, keyboard Shift+F10, Escape.
  const barBox = await page.locator('[data-dock-group="conversation-group"] .dock-bar').boundingBox();
  await page.mouse.click(barBox.x + 8, barBox.y + barBox.height / 2, { button: 'right' });
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await expect(page.locator(DOCK.contextMenu)).toBeHidden({ timeout: 10000 });
  step('Right-click on the dock bar opens the menu; Escape closes it.');
  await page.locator('button[data-dock-tab="roadmap"]').click({ button: 'right' });
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await expect(page.locator(DOCK.contextMenu)).toBeHidden({ timeout: 10000 });
  await page.locator('button[data-dock-tab="conversation"]').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await expect(page.locator(DOCK.contextMenu)).toBeHidden({ timeout: 10000 });
  // Escape restores focus to the menu origin: the focused conversation tab for
  // keyboard/right-click paths (origin = tab), NOT the ellipsis. Exact pin.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.dataset?.dockTab || ''), { timeout: 10000 })
    .toBe('conversation');
  step('Right-click on a tab and Shift+F10 open the menu; Escape closes and restores origin focus.');
  assert.equal(starts.length, 0, 'Menu navigation must never start a model run');
  assert.equal(cancellations, 0, 'Menu navigation must never cancel a run');

  // ------------------------------------------------ Phase 4: legacy envelopes migrate to V3.
  proofPhase = 'legacy-migration';
  const v1Envelope = {
    version: 1,
    enabled: true,
    root: {
      kind: 'split',
      id: 'main',
      dir: 'row',
      ratio: 0.68,
      first: { kind: 'group', id: 'conversation-group', panels: ['conversation'], active: 'conversation' },
      second: { kind: 'group', id: 'tools-group', panels: ['roadmap', 'inspector'], active: 'roadmap' },
    },
  };
  await page.evaluate(({ key, doc }) => localStorage.setItem(key, JSON.stringify(doc)), {
    key: LAYOUT_KEY,
    doc: v1Envelope,
  });
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText('connecté', { timeout: 20000 });
  await dumpOwnedStorage(page, 'post-v1-reload');
  await expect(page.locator(DOCK.workspace)).toBeVisible({ timeout: 10000 });
  signature = await layoutSignature(page);
  assert.deepEqual(
    signature.groups.map((group) => [group.id, group.tabs]),
    [
      ['conversation-group', ['conversation']],
      ['tools-group', ['roadmap', 'session', 'agents', 'files']],
    ],
    'Migrated V1 expands inspector in place to the 3 independent tool tabs',
  );
  assert.equal(
    signature.groups.find((group) => group.id === 'tools-group').active,
    'roadmap',
    'V1 migration keeps the tools active tab',
  );
  assert.equal(starts.length, 0, 'Migration/reload must not start a model run');
  step('Valid V1 envelope migrates to V3 (inspector expanded in place) with zero model runs.');
  // V2 with an ACTIVE inspector: active inspector becomes session.
  const v2Envelope = {
    version: 2,
    enabled: true,
    root: {
      kind: 'split',
      id: 'main',
      dir: 'row',
      ratio: 0.68,
      first: { kind: 'group', id: 'conversation-group', panels: ['conversation'], active: 'conversation' },
      second: { kind: 'group', id: 'tools-group', panels: ['roadmap', 'inspector'], active: 'inspector' },
    },
  };
  await page.evaluate(({ key, doc }) => localStorage.setItem(key, JSON.stringify(doc)), {
    key: LAYOUT_KEY,
    doc: v2Envelope,
  });
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText('connecté', { timeout: 20000 });
  await expect(page.locator(DOCK.workspace)).toBeVisible({ timeout: 10000 });
  signature = await layoutSignature(page);
  assert.deepEqual(
    signature.groups.find((group) => group.id === 'tools-group').tabs,
    ['roadmap', 'session', 'agents', 'files'],
    'Migrated V2 expands inspector in place',
  );
  assert.equal(
    signature.groups.find((group) => group.id === 'tools-group').active,
    'session',
    'Active inspector becomes session after migration',
  );
  step('Valid V2 envelope migrates to V3 with active inspector -> session.');
  // Saved layout is V3 after the migrated doc is next persisted (toggle off/on
  // is a real save trigger; the envelope on disk is lazy until then).
  await openLayoutDialog(page);
  await page.locator(DOCK.toggle).uncheck();
  await expect(page.locator(DOCK.workspace)).toHaveCount(0, { timeout: 10000 });
  await page.locator(DOCK.toggle).check();
  await expect(page.locator(DOCK.workspace)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.closeSettings).click();
  const migrated = await storageEnvelope(page, LAYOUT_KEY);
  assert.equal(migrated?.parsed?.version, 3, 'Saved layout after legacy migration must be version 3');
  assert.equal(migrated?.parsed?.enabled, true, 'Re-enabled envelope records enabled:true');
  await dumpOwnedStorage(page, 'post-legacy-resave');
  step('Re-save after migration writes the V3 envelope (version 3, enabled).');
  const refStateMigrated = await snapshotRefs(page);

  // ------------------------------------------------ Phase 5: presets (geometry only, inline confirm).
  proofPhase = 'presets';
  await openLayoutDialogViaEllipsis(page);
  await page.locator(DOCK.presetName).fill('R2-Essai');
  await page.locator(DOCK.presetSave).click();
  await expect(page.locator(DOCK.presetStatus)).not.toBeEmpty({ timeout: 10000 });
  assert.equal(
    await page
      .locator(DOCK.presetStatus)
      .getAttribute('class')
      .then((cls) => cls.includes('is-error')),
    false,
    'Preset save must report success, not an error',
  );
  let presetsEnv = await storageEnvelope(page, PRESETS_KEY);
  assert.ok(presetsEnv?.parsed, 'Presets doc must be stored');
  assert.equal(presetsEnv.parsed.version, 1, 'Presets doc version must be 1');
  assert.equal(presetsEnv.parsed.items.length, 1, 'Exactly one preset must be stored');
  assert.equal(presetsEnv.parsed.items[0].name, 'R2-Essai', 'Preset name round-trips');
  const storedLayoutRaw = JSON.stringify(presetsEnv.parsed.items[0].layout);
  for (const forbidden of [
    'sessionId',
    'draft',
    'messages',
    'content',
    'history',
    'nonce',
    'viewRunId',
    'projectCwd',
  ])
    assert.equal(
      storedLayoutRaw.includes(`"${forbidden}"`),
      false,
      `Preset layout must not carry ${forbidden}`,
    );
  assert.equal(presetsEnv.parsed.items[0].layout.version, 3, 'Preset layout is canonical V3 geometry');
  assert.ok(
    !storedLayoutRaw.includes('"inspector"'),
    'Preset layout carries the split tool tabs, never the monolithic inspector',
  );
  step('Preset save stores V3 geometry only (no session/draft/content/history keys).');
  // Panel select offers exactly the 6 singletons (primary conversation mounted, no conv: views yet).
  const panelValues = await page
    .locator(DOCK.panelSelect)
    .evaluate((el) => [...el.options].map((o) => o.value));
  assert.deepEqual(
    [...panelValues].sort(),
    ['conversation', ...SINGLETONS].sort(),
    'Panel select offers exactly conversation plus the 5 singletons',
  );
  step('Panel select lists exactly the v3 singleton set.');
  // Overwrite with the same name: inline confirmation appears (never a native dialog).
  await page.locator(DOCK.presetName).fill('R2-Essai');
  await page.locator(DOCK.presetSave).click();
  await expect(page.locator(DOCK.presetConfirm)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.presetCancel).click();
  await expect(page.locator(DOCK.presetConfirm)).toBeHidden({ timeout: 10000 });
  presetsEnv = await storageEnvelope(page, PRESETS_KEY);
  assert.equal(presetsEnv.parsed.items.length, 1, 'Overwrite cancel must keep a single preset');
  step('Preset overwrite cancel keeps the stored preset (inline confirm, no native dialog).');
  await page.locator(DOCK.presetSave).click();
  await expect(page.locator(DOCK.presetConfirm)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.presetConfirm).click();
  await expect(page.locator(DOCK.presetStatus)).not.toBeEmpty({ timeout: 10000 });
  presetsEnv = await storageEnvelope(page, PRESETS_KEY);
  assert.equal(presetsEnv.parsed.items.length, 1, 'Overwrite confirm replaces in place (still one preset)');
  step('Preset overwrite confirm replaces the preset inline.');
  // Rearrange, then load: geometry restored, no runs touched.
  const startsBeforeLoad = starts.length;
  await page.locator(DOCK.panelSelect).selectOption('session');
  const liveGroups = (await layoutSignature(page)).groups;
  const moveTarget = liveGroups.find((group) => !group.tabs.includes('session')) || liveGroups[0];
  await page.locator(DOCK.targetSelect).selectOption(moveTarget.id);
  await page.locator(DOCK.zoneSelect).selectOption('center');
  await page.locator(DOCK.moveButton).click();
  await page.locator(DOCK.presetChoice).selectOption('R2-Essai');
  await page.locator(DOCK.presetLoad).click();
  await expect(page.locator(DOCK.presetStatus)).not.toBeEmpty({ timeout: 10000 });
  signature = await layoutSignature(page);
  assert.deepEqual(
    signature.groups.map((group) => [group.id, group.tabs]).sort(),
    [
      ['conversation-group', ['conversation']],
      ['tools-group', ['roadmap', 'session', 'agents', 'files']],
    ].sort(),
    'Preset load restores the saved geometry',
  );
  assert.equal(starts.length, startsBeforeLoad, 'Preset load must not send (no new model runs)');
  assert.equal(cancellations, 0, 'Preset load must not cancel any run');
  step('Preset load restores geometry with zero sends, zero cancels, zero discards.');
  // Delete: cancel keeps, confirm removes.
  await page.locator(DOCK.presetChoice).selectOption('R2-Essai');
  await page.locator(DOCK.presetDelete).click();
  await expect(page.locator(DOCK.presetConfirm)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.presetCancel).click();
  presetsEnv = await storageEnvelope(page, PRESETS_KEY);
  assert.equal(presetsEnv.parsed.items.length, 1, 'Delete cancel keeps the preset');
  await page.locator(DOCK.presetDelete).click();
  await expect(page.locator(DOCK.presetConfirm)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.presetConfirm).click();
  presetsEnv = await storageEnvelope(page, PRESETS_KEY);
  assert.equal(presetsEnv.parsed.items.length, 0, 'Delete confirm removes the preset');
  step('Preset delete cancel/confirm behave inline with truthful storage state.');
  // Wrong-shape presets storage recovers: valid JSON, wrong schema -> fresh save works.
  await page.evaluate(
    (key) => localStorage.setItem(key, JSON.stringify({ version: 99, items: [] })),
    PRESETS_KEY,
  );
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText('connecté', { timeout: 20000 });
  await openLayoutDialog(page);
  await page.locator(DOCK.presetName).fill('R2-Après-Erreur');
  await page.locator(DOCK.presetSave).click();
  await expect(page.locator(DOCK.presetStatus)).not.toBeEmpty({ timeout: 10000 });
  presetsEnv = await storageEnvelope(page, PRESETS_KEY);
  assert.equal(presetsEnv?.parsed?.version, 1, 'Wrong-shape presets storage recovers on next save');
  assert.equal(presetsEnv.parsed.items.length, 1, 'Recovered presets doc holds the new preset');
  step('Wrong-shape presets storage recovers truthfully (no crash, next save wins).');
  // Quota simulation: exactly one forced QuotaExceededError on the presets key.
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.__restoreQuotaStub = () => {
      Storage.prototype.setItem = original;
    };
    window.__quotaArmed = true;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'prime-studio.docking.presets' && window.__quotaArmed) {
        window.__quotaArmed = false;
        throw new DOMException('Quota exceeded (simulated)', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  try {
    await page.locator(DOCK.presetName).fill('R2-Quota');
    await page.locator(DOCK.presetSave).click();
    await expect(page.locator(DOCK.presetStatus)).not.toBeEmpty({ timeout: 10000 });
    assert.equal(
      await page
        .locator(DOCK.presetStatus)
        .getAttribute('class')
        .then((cls) => cls.includes('is-error')),
      true,
      'Quota failure must surface a truthful error status, not a silent success',
    );
    step('Preset quota failure surfaces a truthful error status (simulated QuotaExceededError).');
  } finally {
    await page.evaluate(() => window.__restoreQuotaStub?.());
  }
  await page.locator(DOCK.closeSettings).click();
  await expect(page.locator(DOCK.dialog)).not.toBeVisible();

  // ------------------------------------------------ Phase 6: geometry ratios, gap-0, Escape+200, reduced motion.
  proofPhase = 'geometry';
  signature = await layoutSignature(page);
  const widthsOf = () => signature.groups.map((group) => group.width);
  const ratioOf = () => {
    const conv = signature.groups.find((group) => group.tabs.includes('conversation')).width;
    const total = signature.groups.reduce((sum, group) => sum + group.width, 0);
    return conv / total;
  };
  assert.ok(Math.abs(ratioOf() - 0.68) <= 0.06, `Root row ratio ~0.68, got ${ratioOf().toFixed(3)}`);
  const gapInfo = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('[data-dock-group]')].map((el) =>
      el.getBoundingClientRect(),
    );
    const splitter = document.querySelector('[data-dock-split]');
    const box = splitter?.getBoundingClientRect();
    return {
      groupCount: groups.length,
      gap: groups.length >= 2 ? Math.round(groups[1].left - groups[0].right) : null,
      splitterWidth: box ? Math.round(box.width) : null,
    };
  });
  measurements.geometry = { ratio: Number(ratioOf().toFixed(3)), ...gapInfo };
  assert.ok(
    gapInfo.gap !== null && gapInfo.gap <= 2,
    `Adjacent dock groups must abut (gap 0-2px, got ${gapInfo.gap})`,
  );
  // Effective hit area via an elementFromPoint sweep (technique-agnostic: the
  // 1px visible divider may carry its grab zone as a pseudo-element, which
  // boundingBox cannot see but real pointer hits do).
  const hitSweep = await page.evaluate(() => {
    const grip = document.querySelector('[data-dock-split]');
    if (!grip) return null;
    const box = grip.getBoundingClientRect();
    const y = box.y + box.height / 2;
    const hits = [];
    for (let dx = -14; dx <= 14; dx++) {
      const el = document.elementFromPoint(box.x + box.width / 2 + dx, y);
      hits.push(el === grip || grip.contains(el) ? 1 : 0);
    }
    return { hits, visibleWidth: Math.round(box.width) };
  });
  assert.ok(hitSweep, 'A dock splitter must exist for the hit-area sweep');
  const mid = Math.floor(hitSweep.hits.length / 2);
  let runStart = mid;
  let runEnd = mid;
  while (runStart > 0 && hitSweep.hits[runStart - 1] === 1) runStart--;
  while (runEnd < hitSweep.hits.length - 1 && hitSweep.hits[runEnd + 1] === 1) runEnd++;
  const hitWidth = hitSweep.hits[mid] === 1 ? runEnd - runStart + 1 : 0;
  measurements.geometry.hitWidth = hitWidth;
  measurements.geometry.visibleWidth = hitSweep.visibleWidth;
  assert.ok(hitSweep.visibleWidth <= 2, `Visible divider stays 1px-thin (got ${hitSweep.visibleWidth}px)`);
  assert.ok(hitWidth >= 6, `Splitter keeps an invisible wide hit area (got ${hitWidth}px)`);
  step(
    `Geometry: ratio ~0.68, gap ${gapInfo.gap}px, divider ${hitSweep.visibleWidth}px, hit area ${hitWidth}px.`,
  );
  // Splitter pointer drag resizes; Escape cancels an extreme (+200) in-flight resize.
  const split = page.locator('[data-dock-split][aria-orientation="vertical"]').first();
  await expect(split).toHaveAttribute('tabindex', '0');
  assert.equal(await split.getAttribute('role'), 'separator', 'Splitter exposes role=separator');
  const splitBox = await split.boundingBox();
  await page.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y + splitBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitBox.x + 120, splitBox.y + splitBox.height / 2, { steps: 8 });
  await page.mouse.up();
  const resized = await layoutSignature(page);
  assert.notDeepEqual(
    widthsOf(),
    resized.groups.map((group) => group.width),
    'Pointer drag must resize groups',
  );
  const widthsMid = resized.groups.map((group) => group.width);
  const splitBox2 = await split.boundingBox();
  await page.mouse.move(splitBox2.x + splitBox2.width / 2, splitBox2.y + splitBox2.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitBox2.x + 200, splitBox2.y + splitBox2.height / 2, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect
    .poll(() => layoutSignature(page).then((sig) => sig.groups.map((group) => group.width)), {
      timeout: 10000,
    })
    .toEqual(widthsMid);
  step('Splitter pointer drag resizes; Escape cancels an extreme in-flight resize.');
  const motion = await page.evaluate(() => {
    const node = document.querySelector('[data-dock-split]') || document.querySelector('#dock-workspace');
    const style = getComputedStyle(node);
    return { transitionDuration: style.transitionDuration, transitionDelay: style.transitionDelay };
  });
  measurements.reducedMotion = motion;
  // Numeric pin (not string form): Chromium serializes near-zero durations as
  // 1e-05s. 10 microseconds is behaviorally none; anything above 1ms is not.
  const maxDuration = Math.max(
    ...motion.transitionDuration.split(',').map((part) => Number.parseFloat(part) || 0),
  );
  assert.ok(
    maxDuration <= 0.001,
    `Global reduce-motion keeps dock transitions at none (got ${motion.transitionDuration})`,
  );
  step('Reduced-motion context keeps dock transitions at none.');
  await expectRefsStable(
    page,
    await snapshotRefs(page).then(async (s) => {
      // Re-anchor refs after the reload above (nodes are genuinely new), then
      // require stability from here on.
      await snapshotRefs(page);
      return page.evaluate(() => ({ draft: document.querySelector('#composer')?.value ?? null }));
    }),
    'geometry',
  );

  // ------------------------------------------------ Phase 7: multi-view contract preflight + chooser flow.
  // Creation always resolves through the native picker: click, choose, await
  // close resolution, THEN read counts (close events are async).
  proofPhase = 'multiview-contract';
  async function expectPickerOpen(page) {
    await expect(page.locator(DOCK.picker)).toBeVisible({ timeout: 10000 });
    assert.equal(
      await page.locator(DOCK.picker).evaluate((node) => node.matches('dialog.conv-picker')),
      true,
      'Chooser must be the native dialog.conv-picker',
    );
  }
  // Rows are plain buttons (list role=group in current picker source): select
  // by class + visible text, then index-click. No role guessing.
  async function pickProject(page, name) {
    const rows = page.locator(`${DOCK.picker} .conv-pick-row`);
    await expect.poll(() => rows.count(), { timeout: 10000 }).toBeGreaterThan(0);
    const texts = await rows.allTextContents();
    const index = texts.findIndex((text) => text.includes(name));
    assert.ok(index >= 0, `Project row ${name} must exist in the chooser`);
    await rows.nth(index).click();
    await expect(page.locator(DOCK.pickerTitle)).toContainText(name, { timeout: 10000 });
  }
  async function pickNewEmpty(page) {
    await page.locator(DOCK.pickerNew).click();
    await expect(page.locator(DOCK.picker)).toBeHidden({ timeout: 10000 });
  }
  async function pickSession(page, title) {
    const sessionRows = page.locator(`${DOCK.picker} .conv-pick-row`);
    await expect.poll(() => sessionRows.count(), { timeout: 10000 }).toBeGreaterThan(0);
    const sessionTexts = await sessionRows.allTextContents();
    const sessionIndex = sessionTexts.findIndex((text) => text.includes(title));
    assert.ok(sessionIndex >= 0, `Session row ${title} must exist in the chooser`);
    await sessionRows.nth(sessionIndex).click();
    await expect(page.locator(DOCK.picker)).toBeHidden({ timeout: 10000 });
  }
  async function focusedMarker(page) {
    return page.evaluate(() =>
      [...document.querySelectorAll('.dock-tab.is-conversation.is-focused')].map((el) => el.dataset.dockTab),
    );
  }
  await openLayoutDialog(page);
  await page.locator(DOCK.newConversation).click();
  const gapsB = [];
  try {
    await expectPickerOpen(page);
  } catch {
    gapsB.push('chooser (native #conversation-picker after #docking-new-conversation)');
  }
  if (gapsB.length === 0) {
    await pickProject(page, 'Atelier');
    await pickNewEmpty(page);
    await page
      .locator(DOCK.closeSettings)
      .click()
      .catch(() => {});
  }
  let newTabs = await convTabIds(page);
  if (!newTabs.some((tab) => tab.startsWith('conv:')))
    gapsB.push('conv-tab (button[data-dock-tab="conv:<id>"] after chooser new-empty)');
  if ((await shellIds(page)).length === 0) gapsB.push('view-shell (.cvw-shell[data-view])');
  const sidecar = await storageEnvelope(page, CONV_KEY);
  if (!sidecar?.parsed) gapsB.push(`sidecar (${CONV_KEY} {version:1,activeId,entries[]})`);
  if (gapsB.length > 0) {
    await page
      .locator(DOCK.closeSettings)
      .click()
      .catch(() => {});
    await writeProof({ status: 'blocked', phase: proofPhase, contractGaps: gapsB });
    throw new Error('Multi-conversation surface not wired yet. Missing: ' + gapsB.join(', '));
  }
  step('Multi-view surface wired: chooser, conv: tabs, shells, sidecar.');
  const firstConv = newTabs.find((tab) => tab.startsWith('conv:'));
  assert.ok(firstConv, 'First new conversation tab must exist');
  await focusConvTab(page, firstConv);
  assert.deepEqual(await focusedMarker(page), [firstConv], 'Exactly one focused marker on the focused tab');
  step('Unique .is-focused marker tracks the focused conversation tab.');

  // ================================== TARGETED SMOKE (M1) ==================
  // Runs before the deep composer chain: 3 independent tool tabs, chooser,
  // tab-bar insertion, sidebar pointer drag. Zero model runs throughout.

  // ------------------------------------------------ T1: three independent tool tabs.
  proofPhase = 'tools-split';
  for (const tool of ['session', 'agents', 'files']) {
    await page.locator(`button[data-dock-tab="${tool}"]`).click();
    await expect(page.locator(`#dock-view-${tool}`)).toBeVisible({ timeout: 10000 });
    assert.ok(
      (await page.locator(`#dock-view-${tool} #inspector-${tool}`).count()) >= 1,
      `Live unit root #inspector-${tool} must live in its dock frame`,
    );
  }
  await page.evaluate(() => {
    window.__toolRoots = {
      session: document.querySelector('#dock-view-session #inspector-session'),
      agents: document.querySelector('#dock-view-agents #inspector-agents'),
      files: document.querySelector('#dock-view-files #inspector-files'),
    };
  });
  await page.locator('button[data-dock-tab="roadmap"]').click();
  await page.locator('button[data-dock-tab="session"]').click();
  assert.equal(
    await page.evaluate(
      () => document.querySelector('#dock-view-session #inspector-session') === window.__toolRoots.session,
    ),
    true,
    'Tool tabs move the SAME live unit nodes, never clones',
  );
  // The group × always closes the ACTIVE tab: activate agents first.
  await page.locator('button[data-dock-tab="agents"]').click();
  await page.locator('[data-dock-close="agents"]').first().click();
  await expect
    .poll(() => convTabIds(page).then((tabs) => tabs.includes('agents')), { timeout: 10000 })
    .toBe(false);
  signature = await layoutSignature(page);
  assert.ok(
    !signature.groups.some((group) => group.tabs.includes('agents')),
    'Closing agents removes it from every group',
  );
  const agentsGroup = signature.groups[0].id;
  await page.locator(`[data-dock-group="${agentsGroup}"]`).locator(DOCK.ellipsis).click();
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.contextMenu).locator('[aria-haspopup="menu"]').click();
  await expect(page.locator(DOCK.addMenu)).toBeVisible({ timeout: 10000 });
  await page.locator(`${DOCK.addOption}[data-dock-add="agents"]`).click();
  await expect(page.locator('button[data-dock-tab="agents"]')).toBeAttached({ timeout: 10000 });
  assert.equal(
    await page.evaluate(
      () => document.querySelector('#dock-view-agents #inspector-agents') === window.__toolRoots.agents,
    ),
    true,
    'Reopen restores the existing agents unit node',
  );
  assert.equal(starts.length, 0, 'Tool tab close/reopen must not start any run');
  step('Session/Agents/Files dock as independent tabs with stable live nodes; close/reopen restores.');

  // ------------------------------------------------ T2: short AddTab menu + 2-step chooser.
  proofPhase = 'chooser';
  const chooserGroup = (await layoutSignature(page)).groups[0].id;
  await page.locator(`[data-dock-group="${chooserGroup}"]`).locator(DOCK.ellipsis).click();
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.contextMenu).locator('[aria-haspopup="menu"]').click();
  await expect(page.locator(DOCK.addMenu)).toBeVisible({ timeout: 10000 });
  const addValues = await page
    .locator(DOCK.addMenu)
    .locator('[data-dock-add]')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.dockAdd));
  assert.deepEqual(
    [...addValues].sort(),
    ['new-conversation', ...SINGLETONS].sort(),
    'AddTab menu is short: new-conversation plus the 5 singletons only',
  );
  step('AddTab submenu lists exactly new-conversation + 5 singletons (no conv: instances).');
  const tabsBeforeChooser = await convTabIds(page);
  await page.locator(`${DOCK.addOption}[data-dock-add="new-conversation"]`).click();
  await expectPickerOpen(page);
  const projectRows = await page.locator(`${DOCK.picker} .conv-pick-row`).allTextContents();
  assert.ok(
    projectRows.some((text) => text.includes('Atelier')),
    'Chooser project step lists Atelier',
  );
  assert.ok(
    projectRows.some((text) => text.includes('Vtrott')),
    'Chooser project step lists Vtrott',
  );
  await page.locator(DOCK.pickerSearch).fill('Vtrott');
  // Filtering renders synchronously on input: wait for the settled state,
  // then read once (no negation polling, no arbitrary sleep).
  await expect(page.locator(DOCK.pickerList)).toContainText('Vtrott', { timeout: 10000 });
  const filteredRows = await page.locator(`${DOCK.picker} .conv-pick-row`).allTextContents();
  assert.ok(
    filteredRows.some((text) => text.includes('Vtrott')),
    'Search keeps Vtrott',
  );
  assert.ok(!filteredRows.some((text) => text.includes('Atelier')), 'Search filters Atelier out');
  await page.locator(DOCK.pickerSearch).fill('');
  // Keyboard: ArrowDown from search focuses the first row.
  await page.locator(DOCK.pickerSearch).press('ArrowDown');
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.className || ''), { timeout: 10000 })
    .toContain('conv-pick-row');
  step('Chooser project step lists both projects with working search and keyboard entry.');
  await pickProject(page, 'Atelier');
  const pickerBack = page.locator(`${DOCK.picker} button.icon-button`).first();
  assert.equal(
    await pickerBack.isVisible().catch(() => false),
    true,
    'Session step shows the native back header button',
  );
  assert.equal(await page.locator(DOCK.pickerNew).count(), 1, 'Session step offers new-empty');
  // Back returns to the project step; re-picking restores the session list.
  await pickerBack.click();
  await expect(page.locator(DOCK.pickerTitle)).not.toContainText('Atelier', { timeout: 10000 });
  await expect(page.locator(DOCK.pickerList)).toContainText('Vtrott', { timeout: 10000 });
  const backRows = await page.locator(`${DOCK.picker} .conv-pick-row`).allTextContents();
  assert.ok(
    backRows.some((text) => text.includes('Atelier')),
    'Back restores the project list',
  );
  await pickProject(page, 'Atelier');
  assert.equal(await page.locator(DOCK.pickerNew).count(), 1, 'Re-picked session step offers new-empty');
  await pickSession(page, 'Préparer la distribution');
  const tabsAfterPick = await convTabIds(page);
  assert.equal(tabsAfterPick.length, tabsBeforeChooser.length + 1, 'Session pick opens exactly one tab');
  const pickedTab = tabsAfterPick.find((tab) => !tabsBeforeChooser.includes(tab));
  assert.ok(pickedTab?.startsWith('conv:'), 'Picked session mounts as a conv: tab');
  assert.deepEqual(await focusedMarker(page), [pickedTab], 'Picked tab takes the unique focus marker');
  await expect(page.locator('#detail-session-id')).toContainText('ws-beta', { timeout: 10000 });
  step('Chooser session pick opens the bound tab with inspector following focus.');
  // Dedupe: picking the same session reuses the tab, no new view, no run.
  const runsBeforeDedupe = starts.length;
  const shellsBeforeDedupe = await shellIds(page);
  await page.locator(`[data-dock-group="${chooserGroup}"]`).locator(DOCK.ellipsis).click();
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.contextMenu).locator('[aria-haspopup="menu"]').click();
  await page.locator(`${DOCK.addOption}[data-dock-add="new-conversation"]`).click();
  await expectPickerOpen(page);
  await pickProject(page, 'Atelier');
  await pickSession(page, 'Préparer la distribution');
  assert.deepEqual(
    [...(await convTabIds(page))].sort(),
    [...tabsAfterPick].sort(),
    'Same-session pick dedupes: no new tab',
  );
  assert.deepEqual(
    [...(await shellIds(page))].sort(),
    [...shellsBeforeDedupe].sort(),
    'Same-session pick dedupes: no new shell',
  );
  assert.deepEqual(await focusedMarker(page), [pickedTab], 'Same-session pick focuses the existing tab');
  assert.equal(starts.length, runsBeforeDedupe, 'Chooser dedupe starts zero runs');
  step('Chooser dedupe reuses the existing tab for the same session (no runs).');
  // New-empty + Escape (null resolves to no tab).
  await page.locator(`[data-dock-group="${chooserGroup}"]`).locator(DOCK.ellipsis).click();
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.contextMenu).locator('[aria-haspopup="menu"]').click();
  await page.locator(`${DOCK.addOption}[data-dock-add="new-conversation"]`).click();
  await expectPickerOpen(page);
  await pickProject(page, 'Atelier');
  await pickNewEmpty(page);
  const tabsAfterEmpty = await convTabIds(page);
  assert.equal(tabsAfterEmpty.length, tabsAfterPick.length + 1, 'New-empty opens exactly one tab');
  const emptyTab = tabsAfterEmpty.find((tab) => !tabsAfterPick.includes(tab));
  assert.deepEqual(await focusedMarker(page), [emptyTab], 'New-empty tab takes focus');
  await page.locator(`[data-dock-group="${chooserGroup}"]`).locator(DOCK.ellipsis).click();
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.contextMenu).locator('[aria-haspopup="menu"]').click();
  await page.locator(`${DOCK.addOption}[data-dock-add="new-conversation"]`).click();
  await expectPickerOpen(page);
  await page.keyboard.press('Escape');
  await expect(page.locator(DOCK.picker)).toBeHidden({ timeout: 10000 });
  assert.deepEqual(await convTabIds(page), tabsAfterEmpty, 'Chooser Escape resolves null: no tab');
  assert.equal(starts.length, runsBeforeDedupe, 'Chooser flows start zero runs');
  step('Chooser new-empty opens a focused tab; Escape adds nothing; zero runs.');

  // ------------------------------------------------ T3: tab-bar insertion marker (same + cross group).
  proofPhase = 'tab-insertion';
  async function dragTabToBar(page, tabId, targetGroupId, edge) {
    // Real HTML5 tab drag onto a tab BAR (not the pane body): the tab-only
    // insertion marker must show while the zone preview stays hidden.
    const from = await page.locator(`button[data-dock-tab="${tabId}"]`).boundingBox();
    const bar = await page.locator(`[data-dock-group="${targetGroupId}"] .dock-tabs`).boundingBox();
    const targetX = edge === 'leading' ? bar.x + 6 : bar.x + bar.width - 6;
    const targetY = bar.y + bar.height / 2;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    let markerSeen = false;
    let zoneHidden = true;
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(from.x + ((targetX - from.x) * i) / 10, from.y + ((targetY - from.y) * i) / 10, {
        steps: 2,
      });
      if (i === 6) {
        markerSeen = await page
          .locator(DOCK.insertion)
          .isVisible()
          .catch(() => false);
        zoneHidden = !(await page
          .locator(DOCK.dropPreview)
          .isVisible()
          .catch(() => false));
      }
    }
    await page.mouse.move(targetX, targetY);
    await page.mouse.move(targetX, targetY);
    // Preview updates are coalesced per frame. Observe the rendered marker
    // before releasing; a synchronous isVisible() can run before that frame.
    await expect(page.locator(DOCK.insertion)).toBeVisible({ timeout: 1000 });
    markerSeen = true;
    await page.mouse.up();
    await expect(page.locator(DOCK.insertion)).toBeHidden({ timeout: 10000 });
    return { markerSeen, zoneHidden };
  }
  const runsBeforeInsert = starts.length;
  signature = await layoutSignature(page);
  const hostGroup = signature.groups.find((group) => group.tabs.some((tab) => tab.startsWith('conv:')));
  assert.ok(
    hostGroup && hostGroup.tabs.filter((tab) => tab.startsWith('conv:')).length >= 2,
    'Two conv tabs share one group for same-group insertion',
  );
  const [firstTab, secondTab] = hostGroup.tabs.filter((tab) => tab.startsWith('conv:'));
  const seen = await dragTabToBar(page, firstTab, hostGroup.id, 'trailing');
  assert.equal(seen.markerSeen, true, 'Same-group bar drag shows the tab-only insertion marker');
  assert.equal(seen.zoneHidden, true, 'Bar drag never shows the pane zone preview');
  signature = await layoutSignature(page);
  const reordered = signature.groups
    .find((group) => group.id === hostGroup.id)
    .tabs.filter((tab) => tab.startsWith('conv:'));
  assert.ok(
    reordered[reordered.length - 1] === firstTab,
    'Trailing-edge drop moves the tab to the end (after-removal index)',
  );
  step('Same-group tab-bar insertion moves the tab with a tab-only marker.');
  const otherGroup = signature.groups.find((group) => group.id !== hostGroup.id);
  assert.ok(otherGroup, 'A second live group must exist for cross-group insertion');
  const seenCross = await dragTabToBar(page, firstTab, otherGroup.id, 'leading');
  assert.equal(seenCross.markerSeen, true, 'Cross-group bar drag shows the insertion marker');
  signature = await layoutSignature(page);
  const joined = signature.groups.find((group) => group.id === otherGroup.id).tabs;
  assert.equal(joined[0], firstTab, 'Leading-edge drop inserts the tab first in the target group');
  assert.ok(
    !signature.groups.find((group) => group.id === hostGroup.id).tabs.includes(firstTab),
    'Cross-group drop removes the tab from its source group',
  );
  assert.equal(starts.length, runsBeforeInsert, 'Tab insertion moves start zero runs');
  step('Cross-group tab-bar insertion lands at the marker index with zero runs.');

  // ------------------------------------------------ T3b: close-others per group.
  // #docking-context-menu [data-dock-close-others] carries the group id.
  // Keeps the right-clicked tab (even inactive) or the group active tab on a
  // blank-bar click; closes only SAME-group siblings with existing park
  // semantics; other groups byte-identical; drafts/attachments/runs retained
  // after reopen; disabled for one-tab groups. Zero started/cancelled runs
  // except one intentional held run (finished before phase end).
  proofPhase = 'close-others';
  const t3bStarts = starts.length;
  async function readOwnedDraft(page, viewId) {
    // Era-robust: per-pane data-cvw composer when wired, else the host mirror
    // (caller must have that view focused for the host path to be exact).
    const pane = page.locator(`.cvw-shell[data-view="${viewId}"]`);
    const scoped = pane.locator('[data-cvw="composer"]');
    if ((await scoped.count()) > 0) return scoped.evaluate((node) => node.value ?? node.textContent ?? '');
    return page.locator('#composer').inputValue();
  }
  async function fillOwnedDraft(page, viewId, text) {
    const pane = page.locator(`.cvw-shell[data-view="${viewId}"]`);
    const scoped = pane.locator('[data-cvw="composer"]');
    if ((await scoped.count()) > 0) await scoped.fill(text);
    else await page.locator('#composer').fill(text);
  }
  async function trayVisible(page, viewId) {
    return page.evaluate((id) => {
      const shell = document.querySelector(`.cvw-shell[data-view="${id}"]`);
      if (!shell) return false;
      const paneTray = shell.querySelector('[data-cvw="tray"], #image-draft-tray');
      const hostTray = document.getElementById('image-draft-tray');
      const shown = (node) => !!node && !node.hidden && node.getClientRects().length > 0;
      return shown(paneTray) || shown(hostTray);
    }, viewId);
  }
  async function openCloseOthers(page, groupId, tabId = null) {
    // Right-click a tab (or the bare bar) and return the close-others item.
    if (tabId) await page.locator(`button[data-dock-tab="${tabId}"]`).click({ button: 'right' });
    else {
      const bar = await page.locator(`[data-dock-group="${groupId}"] .dock-bar`).boundingBox();
      await page.mouse.click(bar.x + 8, bar.y + bar.height / 2, { button: 'right' });
    }
    await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
    return page.locator(`${DOCK.contextMenu} [data-dock-close-others]`);
  }
  async function groupsSnapshot(page) {
    const sig = await layoutSignature(page);
    return sig.groups.map((group) => [group.id, group.tabs, group.active]);
  }
  // Case 1: tools group — right-click an INACTIVE tab keeps exactly it.
  let toolsGroup = (await layoutSignature(page)).groups.find((group) => group.tabs.includes('roadmap'));
  assert.ok(toolsGroup && toolsGroup.tabs.length >= 2, 'Tools group needs two tabs for close-others');
  await page.locator('button[data-dock-tab="roadmap"]').click();
  const keepTab = toolsGroup.tabs.find((tab) => tab !== 'roadmap');
  const beforeTools = await groupsSnapshot(page);
  const closeItem1 = await openCloseOthers(page, toolsGroup.id, keepTab);
  assert.equal(
    await closeItem1.getAttribute('data-dock-close-others'),
    toolsGroup.id,
    'Item carries its group id',
  );
  assert.equal(await closeItem1.isDisabled(), false, 'Item enabled for a multi-tab group');
  const parkedTools = toolsGroup.tabs.filter((tab) => tab !== keepTab);
  await closeItem1.click();
  await expect
    .poll(
      () => layoutSignature(page).then((sig) => sig.groups.find((group) => group.id === toolsGroup.id).tabs),
      { timeout: 10000 },
    )
    .toEqual([keepTab]);
  signature = await layoutSignature(page);
  for (const [id, tabs] of beforeTools.filter(([id]) => id !== toolsGroup.id)) {
    assert.deepEqual(
      signature.groups.find((group) => group.id === id)?.tabs,
      tabs,
      `Other group ${id} unchanged by close-others`,
    );
  }
  step('Close-others keeps the right-clicked (inactive) tab; other groups unchanged.');
  // Reopen every parked singleton through the Layout dialog (same nodes).
  await openLayoutDialog(page);
  for (const tab of parkedTools) {
    await page.locator(`button[data-dock-open="${tab}"]`).first().click();
  }
  await page.locator(DOCK.closeSettings).click();
  signature = await layoutSignature(page);
  assert.ok(
    parkedTools.every((tab) => signature.groups.some((group) => group.tabs.includes(tab))),
    'All parked singletons reopen',
  );
  await page.evaluate(() => {
    window.__toolNodes = {
      session: document.querySelector('#dock-view-session #inspector-session'),
      agents: document.querySelector('#dock-view-agents #inspector-agents'),
      files: document.querySelector('#dock-view-files #inspector-files'),
    };
  });
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector('#dock-view-session #inspector-session') === window.__toolNodes.session &&
        document.querySelector('#dock-view-agents #inspector-agents') === window.__toolNodes.agents &&
        document.querySelector('#dock-view-files #inspector-files') === window.__toolNodes.files,
    ),
    true,
    'Reopened singletons are the identical live nodes',
  );
  step('Close-others park/restore keeps identical singleton nodes.');
  // Case 2: conversation group — draft + attachment + held run retained.
  const convKeep = emptyTab;
  const convPark = pickedTab;
  assert.ok(convKeep && convKeep.startsWith('conv:'), 'emptyTab must exist for the kept tab');
  assert.ok(convPark && convPark.startsWith('conv:'), 'pickedTab must exist for the parked tab');
  await openLayoutDialog(page);
  await page.locator(DOCK.panelSelect).selectOption(convKeep);
  const convHost = (await layoutSignature(page)).groups.find((group) => group.tabs.includes(convPark));
  assert.ok(convHost, 'A live group holding the parked candidate must exist');
  await page.locator(DOCK.targetSelect).selectOption(convHost.id);
  await page.locator(DOCK.zoneSelect).selectOption('center');
  await page.locator(DOCK.moveButton).click();
  await page.locator(DOCK.closeSettings).click();
  async function t3bSend(page, viewId) {
    // Era-robust send: per-pane button when wired, else the host button that
    // mirrors the focused view. Caller must have the view focused.
    const pane = page.locator(`.cvw-shell[data-view="${viewId}"]`);
    const scoped = pane.locator('[data-cvw="send"]');
    if ((await scoped.count()) > 0) await scoped.click();
    else await page.locator('#send-button').click();
    await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(t3bStarts + 1);
  }
  // Send first (accepts the composer), then stage draft + attachment while the
  // run is held: closing must park all three together.
  await focusConvTab(page, convPark);
  await fillOwnedDraft(page, convPark, 'T3b-send-text');
  await t3bSend(page, convPark);
  const t3bControl = activeControls[activeControls.length - 1];
  assert.equal(t3bControl.record.sessionId, 'ws-beta', 'Retention run binds ws-beta');
  await fillOwnedDraft(page, convPark, 'T3b-draft-parked');
  const parkFiles = await page
    .locator(`.cvw-shell[data-view="${convPark}"] input[type="file"], #image-files`)
    .count();
  if (parkFiles > 0) {
    const fileInput = page.locator(`.cvw-shell[data-view="${convPark}"] input[type="file"]`).first();
    if ((await fileInput.count()) > 0) await fileInput.setInputFiles(pixelPath);
    else await page.locator('#image-files').setInputFiles(pixelPath);
    await expect.poll(() => trayVisible(page, convPark), { timeout: 10000 }).toBe(true);
  }
  await focusConvTab(page, convKeep);
  const convGroupId = (await layoutSignature(page)).groups.find((group) => group.tabs.includes(convKeep)).id;
  const beforeConv = await groupsSnapshot(page);
  const closeItem2 = await openCloseOthers(page, convGroupId, convKeep);
  await closeItem2.click();
  await expect
    .poll(
      () => layoutSignature(page).then((sig) => sig.groups.find((group) => group.id === convGroupId).tabs),
      { timeout: 10000 },
    )
    .toEqual([convKeep]);
  assert.equal(cancellations, 0, 'Close-others never cancels the parked run');
  signature = await layoutSignature(page);
  for (const [id, tabs] of beforeConv.filter(([id]) => id !== convGroupId)) {
    assert.deepEqual(
      signature.groups.find((group) => group.id === id)?.tabs,
      tabs,
      `Other group ${id} unchanged by conversation close-others`,
    );
  }
  step('Conversation close-others parks siblings with the run live; others unchanged.');
  await markShell(page, convPark);
  await openLayoutDialog(page);
  await page.locator(`button[data-dock-open="${convPark}"]`).first().click();
  await page.locator(DOCK.closeSettings).click();
  await expect
    .poll(() => convTabIds(page).then((tabs) => tabs.includes(convPark)), { timeout: 10000 })
    .toBe(true);
  assert.equal(await shellSameAsMarked(page), true, 'Reopened conversation is the identical shell node');
  await focusConvTab(page, convPark);
  assert.equal(
    await readOwnedDraft(page, convPark),
    'T3b-draft-parked',
    'Parked draft retained after close/reopen',
  );
  assert.equal(await trayVisible(page, convPark), true, 'Parked attachment retained after close/reopen');
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            [...document.querySelectorAll('#stop-button, [data-cvw="stop"]')].filter(
              (node) => node.getClientRects().length,
            ).length,
        ),
      { timeout: 10000 },
    )
    .toBeGreaterThanOrEqual(1);
  await t3bControl.finish('completed');
  step('Reopened tab restores node, draft, attachment with its run still live.');
  // Case 3: keyboard path (Shift+F10, arrows to the item, Enter).
  signature = await layoutSignature(page);
  const kbGroup = signature.groups.find((group) => group.tabs.length >= 2);
  assert.ok(kbGroup, 'A multi-tab group must exist for the keyboard path');
  const kbVictim = kbGroup.tabs[kbGroup.tabs.length - 1];
  await page.locator(`button[data-dock-tab="${kbVictim}"]`).focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  let kbActivated = false;
  for (let n = 0; n < 10 && !kbActivated; n++) {
    await page.keyboard.press('ArrowDown');
    const onItem = await page.evaluate(
      () => document.activeElement?.hasAttribute?.('data-dock-close-others') || false,
    );
    if (onItem) {
      await page.keyboard.press('Enter');
      kbActivated = true;
    }
  }
  assert.equal(kbActivated, true, 'Keyboard reaches and activates the close-others item');
  // The keyboard-opened menu keeps its origin tab: siblings close around it.
  await expect
    .poll(
      () => layoutSignature(page).then((sig) => sig.groups.find((group) => group.id === kbGroup.id).tabs),
      { timeout: 10000 },
    )
    .toEqual([kbVictim]);
  step('Keyboard path closes sibling tabs through the menu item.');
  // Case 4: blank bar keeps the group active tab. The ellipsis button opens
  // the identical menu with a non-tab origin (tab falls back to group active),
  // deterministically and without coordinate flakiness on a gap-0 bar.
  // Ensure a multi-tab group first (earlier cases may leave singletons).
  signature = await layoutSignature(page);
  if (!signature.groups.some((group) => group.tabs.length >= 2)) {
    const [firstGroup, secondGroup] = signature.groups;
    assert.ok(firstGroup && secondGroup, 'Two groups must exist to merge for the blank-bar path');
    await openLayoutDialog(page);
    await page.locator(DOCK.panelSelect).selectOption(secondGroup.tabs[0]);
    await page.locator(DOCK.targetSelect).selectOption(firstGroup.id);
    await page.locator(DOCK.zoneSelect).selectOption('center');
    await page.locator(DOCK.moveButton).click();
    await page.locator(DOCK.closeSettings).click();
    signature = await layoutSignature(page);
  }
  const blankGroup = signature.groups.find((group) => group.tabs.length >= 2);
  assert.ok(blankGroup, 'A multi-tab group must exist for the blank-bar path');
  const blankActive = blankGroup.active;
  assert.ok(blankActive, 'Group must have an active tab');
  await page.locator(`[data-dock-group="${blankGroup.id}"]`).locator(DOCK.ellipsis).click();
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  const closeItem4 = page.locator(`${DOCK.contextMenu} [data-dock-close-others]`);
  assert.equal(
    await closeItem4.getAttribute('data-dock-close-others'),
    blankGroup.id,
    'Item carries its group id',
  );
  await closeItem4.click();
  await expect
    .poll(
      () => layoutSignature(page).then((sig) => sig.groups.find((group) => group.id === blankGroup.id).tabs),
      { timeout: 10000 },
    )
    .toEqual([blankActive]);
  step('Blank-bar close-others keeps the group active tab.');
  // Case 5: disabled for a one-tab group.
  signature = await layoutSignature(page);
  let singleGroup = signature.groups.find((group) => group.tabs.length === 1);
  if (!singleGroup) {
    const donor = signature.groups.find((group) => group.tabs.length >= 2);
    assert.ok(donor, 'A donor group must exist to carve a single-tab group');
    await openLayoutDialog(page);
    await page.locator(DOCK.panelSelect).selectOption(donor.tabs[0]);
    await page.locator(DOCK.targetSelect).selectOption(donor.id);
    await page.locator(DOCK.zoneSelect).selectOption('right');
    await page.locator(DOCK.moveButton).click();
    await page.locator(DOCK.closeSettings).click();
    signature = await layoutSignature(page);
    singleGroup = signature.groups.find((group) => group.tabs.length === 1);
  }
  assert.ok(singleGroup, 'A one-tab group must exist for the disabled check');
  const closeItem5 = await openCloseOthers(page, singleGroup.id, singleGroup.tabs[0]);
  assert.equal(await closeItem5.isDisabled(), true, 'Item disabled for a one-tab group');
  await page.keyboard.press('Escape');
  await expect(page.locator(DOCK.contextMenu)).toBeHidden({ timeout: 10000 });
  assert.equal(starts.length, t3bStarts + 1, 'Exactly the one intentional held run started');
  assert.equal(cancellations, 0, 'Close-others flows cancel zero runs');
  step('Close-others disabled for one-tab groups; zero runs started or cancelled.');
  // Restore every parked view so later phases start from a mounted baseline
  // (singletons idempotent, conv views remounted from the sidecar registry).
  await openLayoutDialog(page);
  for (const tab of ['roadmap', 'session', 'agents', 'files', 'preferences']) {
    await page.locator(`button[data-dock-open="${tab}"]`).first().click();
  }
  await page.locator(DOCK.closeSettings).click();
  const sidecarEnd = await storageEnvelope(page, CONV_KEY);
  for (const entry of sidecarEnd?.parsed?.entries || []) {
    if ((await convTabIds(page)).includes(entry.id)) continue;
    await openLayoutDialog(page);
    await page.locator(`button[data-dock-open="${entry.id}"]`).first().click();
    await page.locator(DOCK.closeSettings).click();
  }
  // NOTE: droppedTab is created later (T4 sidebar drop); only views existing
  // now are restored here. Later phases resolve live state dynamically.
  await expect
    .poll(() => convTabIds(page).then((tabs) => tabs.includes('conversation') && tabs.includes(pickedTab)), {
      timeout: 15000,
    })
    .toBe(true);
  step('T3b restore: all parked singletons and conversation views remounted.');

  // ------------------------------------------------ T4: sidebar pointer drag (drop, dedupe, reorder, Escape).
  proofPhase = 'sidebar-pointer-drag';
  async function pointerDrag(page, fromBox, toBox) {
    // Genuine pointer gesture (the product prevents HTML5 dragstart on rows):
    // down, 6px+ travel in steps, up. No sleeps; observations poll below.
    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(
        fromBox.x + ((toBox.x - fromBox.x) * i) / 12,
        fromBox.y + ((toBox.y - fromBox.y) * i) / 12,
        { steps: 2 },
      );
      if (i === 7) {
        const marker = await page
          .locator(DOCK.insertion)
          .isVisible()
          .catch(() => false);
        const zone = await page
          .locator(DOCK.dropPreview)
          .isVisible()
          .catch(() => false);
        if (marker || zone) break;
      }
    }
    await page.mouse.move(toBox.x, toBox.y);
    await page.mouse.move(toBox.x, toBox.y);
    await page.mouse.up();
  }
  async function sidebarOrder(page) {
    return page.evaluate(() =>
      [...document.querySelectorAll('.session-row[data-session-id]')].map((node) => node.dataset.sessionId),
    );
  }
  const runsBeforeSidebar = starts.length;
  let gammaRow = page.locator('.session-row[data-session-id="ws-gamma"]');
  if ((await gammaRow.count()) === 0) {
    // Expand collapsed projects via toggles only (never selects: no context change).
    for (const toggle of await page.locator('button.project-toggle[aria-expanded="false"]').all())
      await toggle.click().catch(() => {});
    gammaRow = page.locator('.session-row[data-session-id="ws-gamma"]');
  }
  assert.ok((await gammaRow.count()) > 0, 'ws-gamma sidebar row must be renderable for the drop-new case');
  const sidecarNow = await storageEnvelope(page, CONV_KEY);
  const openSessions = new Set(
    (sidecarNow?.parsed?.entries || []).map((entry) => entry.sessionId).filter(Boolean),
  );
  assert.ok(!openSessions.has('ws-gamma'), 'ws-gamma must not own a view before the drop-new case');
  const gammaHandle = gammaRow.locator(DOCK.sessionHandle);
  const gammaBox = await (
    (await gammaHandle.count()) ? gammaHandle : gammaRow.locator('.session-select')
  ).boundingBox();
  signature = await layoutSignature(page);
  const dropGroup = signature.groups[signature.groups.length - 1].id;
  const dropBar = await page.locator(`[data-dock-group="${dropGroup}"] .dock-tabs`).boundingBox();
  const tabsBeforeDrop = await convTabIds(page);
  await pointerDrag(page, gammaBox, { x: dropBar.x + dropBar.width / 2, y: dropBar.y + dropBar.height / 2 });
  await expect
    .poll(() => convTabIds(page).then((tabs) => tabs.length), { timeout: 15000 })
    .toBe(tabsBeforeDrop.length + 1);
  const tabsAfterDrop = await convTabIds(page);
  const droppedTab = tabsAfterDrop.find((tab) => !tabsBeforeDrop.includes(tab));
  assert.ok(droppedTab?.startsWith('conv:'), 'Sidebar drop opens the session as a conv: tab');
  assert.deepEqual(await focusedMarker(page), [droppedTab], 'Dropped tab takes the unique focus marker');
  await expect(page.locator('#detail-session-id')).toContainText('ws-gamma', { timeout: 10000 });
  assert.equal(starts.length, runsBeforeSidebar, 'Sidebar drop validates payload with zero runs');
  step('Sidebar pointer drop opens the session as a focused tab (validated payload, zero runs).');
  // Dedupe: dragging the already-open ws-beta reuses its tab cross-group.
  const betaTabBefore = (await convTabIds(page)).find((tab) => tab === pickedTab);
  assert.ok(betaTabBefore, 'ws-beta tab from the chooser must still exist');
  const betaRow = page.locator('.session-row[data-session-id="ws-beta"]');
  const betaBox = await betaRow.locator('.session-select').boundingBox();
  const betaOrigGroup = (await layoutSignature(page)).groups.find((group) =>
    group.tabs.includes(pickedTab),
  ).id;
  if ((await layoutSignature(page)).groups.length < 2) {
    const soloGroup = (await layoutSignature(page)).groups[0];
    const donor = soloGroup.tabs.find((tab) => tab !== pickedTab) || soloGroup.tabs[0];
    await openLayoutDialog(page);
    await page.locator(DOCK.panelSelect).selectOption(donor);
    await page.locator(DOCK.targetSelect).selectOption(soloGroup.id);
    await page.locator(DOCK.zoneSelect).selectOption('right');
    await page.locator(DOCK.moveButton).click();
    await page.locator(DOCK.closeSettings).click();
  }
  const betaOtherGroup = (await layoutSignature(page)).groups.find((group) => group.id !== betaOrigGroup).id;
  assert.ok(betaOtherGroup, 'A second group must exist for cross-group dedupe');
  const betaBar = await page.locator(`[data-dock-group="${betaOtherGroup}"] .dock-tabs`).boundingBox();
  const shellsBeforeBetaDrop = await shellIds(page);
  await pointerDrag(page, betaBox, { x: betaBar.x + 20, y: betaBar.y + betaBar.height / 2 });
  await expect
    .poll(
      () =>
        layoutSignature(page).then((sig) =>
          sig.groups.find((group) => group.id === betaOtherGroup).tabs.includes(pickedTab),
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  assert.deepEqual(
    (await convTabIds(page)).length,
    tabsAfterDrop.length,
    'Same-session drop dedupes: no new tab',
  );
  assert.deepEqual(
    [...(await shellIds(page))].sort(),
    [...shellsBeforeBetaDrop].sort(),
    'Same-session drop dedupes: no new shell',
  );
  assert.deepEqual(await focusedMarker(page), [pickedTab], 'Deduped drop focuses the existing tab');
  assert.equal(starts.length, runsBeforeSidebar, 'Dedupe drop starts zero runs');
  step('Same-session sidebar drop dedupes cross-group onto the existing tab (zero runs).');
  // Existing reorder keeps working: pointer reorder inside the list, dock untouched.
  // Order-agnostic (activity sorting may pre-order rows): move the first row of
  // the largest same-project group to after its second row.
  async function firstReorderPair(page) {
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.session-row[data-session-id]')].map((node) => ({
        id: node.dataset.sessionId,
        group: [node.dataset.projectKey, node.dataset.pinned, node.dataset.archived].join('|'),
      })),
    );
    const byGroup = new Map();
    for (const row of rows) {
      if (!byGroup.has(row.group)) byGroup.set(row.group, []);
      byGroup.get(row.group).push(row.id);
    }
    const biggest = [...byGroup.values()].sort((a, b) => b.length - a.length)[0];
    assert.ok(biggest && biggest.length >= 2, 'A reorderable pair must exist in one project group');
    return biggest.slice(0, 2);
  }
  const orderBefore = await sidebarOrder(page);
  const dockBeforeReorder = await layoutSignature(page);
  const [moveId, anchorId] = await firstReorderPair(page);
  const moveBox = await page
    .locator(`.session-row[data-session-id="${moveId}"] .session-select`)
    .boundingBox();
  const anchorBox = await page
    .locator(`.session-row[data-session-id="${anchorId}"] .session-select`)
    .boundingBox();
  // Inside the anchor's lower half: past its midpoint (position after) but
  // inside the group's last.bottom+8 band (outside it the gesture targets nothing).
  await pointerDrag(page, moveBox, {
    x: anchorBox.x + anchorBox.width / 2,
    y: anchorBox.y + anchorBox.height - 4,
  });
  await expect.poll(() => sidebarOrder(page), { timeout: 10000 }).not.toEqual(orderBefore);
  const orderMoved = await sidebarOrder(page);
  assert.ok(orderMoved.indexOf(moveId) > orderMoved.indexOf(anchorId), 'Dragged row lands after its anchor');
  assert.deepEqual(
    (await layoutSignature(page)).groups.map((group) => group.tabs),
    dockBeforeReorder.groups.map((group) => group.tabs),
    'Sidebar reorder leaves the dock layout untouched',
  );
  assert.equal(starts.length, runsBeforeSidebar, 'Sidebar reorder starts zero runs');
  step('Sidebar pointer reorder still works with the dock untouched and zero runs.');
  // Escape cancels an in-flight pointer drag: no mutation anywhere.
  const orderPreEscape = await sidebarOrder(page);
  const dockPreEscape = await layoutSignature(page);
  const escBox = await page.locator('.session-row[data-session-id="ws-alpha"] .session-select').boundingBox();
  await page.mouse.move(escBox.x + escBox.width / 2, escBox.y + escBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(escBox.x + 120, escBox.y + 60, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(
    await sidebarOrder(page),
    orderPreEscape,
    'Escape cancels the pointer drag: order unchanged',
  );
  assert.deepEqual(
    (await layoutSignature(page)).groups.map((group) => group.tabs),
    dockPreEscape.groups.map((group) => group.tabs),
    'Escape cancels the pointer drag: dock unchanged',
  );
  assert.equal(starts.length, runsBeforeSidebar, 'Cancelled drag starts zero runs');
  step('Escape cancels an in-flight sidebar drag with zero mutation and zero runs.');
  // Keyboard reorder on the handle: first row of the same group moves down.
  const orderPreKeys = await sidebarOrder(page);
  const [keyMoveId] = await firstReorderPair(page);
  const keyHandle = page.locator(`.session-row[data-session-id="${keyMoveId}"] .session-drag-handle`);
  assert.ok((await keyHandle.count()) > 0, 'Reorder handle must exist (writable navigation)');
  await keyHandle.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => sidebarOrder(page), { timeout: 10000 }).not.toEqual(orderPreKeys);
  step('Sidebar handle keyboard reorder works (ArrowDown).');
  await assertHostMount(page, 'post-sidebar');

  // ------------------------------------------------ T5: per-tab icons use the owning project color.
  // Markup: span.dock-tab-icon[aria-hidden=true] svg + span.dock-tab-label.
  // Probe-gated (implementation landing): absent markup defers with a clear
  // note instead of breaking M1 smoke; present markup runs full assertions.
  proofPhase = 'tab-icons';
  const iconProbe = await page.evaluate(() => ({
    icons: document.querySelectorAll('#dock-workspace .dock-tab span.dock-tab-icon').length,
    labels: document.querySelectorAll('#dock-workspace .dock-tab span.dock-tab-label').length,
    tabs: document.querySelectorAll('#dock-workspace .dock-tab').length,
  }));
  measurements.tabIcons = iconProbe;
  if (iconProbe.icons === 0) {
    note('DEFERRED until tab-icon markup lands: tab-icons (no span.dock-tab-icon yet)');
    deferred.push('tab-icons');
  } else {
    assert.equal(iconProbe.labels, iconProbe.tabs, 'Every dock tab carries its own label span');
    // Color lives on different properties per surface (dock glyph span uses
    // style.color via projectColorOf; sidebar folder icons set svg fill): the
    // comparable signal is the COMPUTED color on both ends. Raw parts are kept
    // in measurements for exact diagnosis.
    async function tabIconColor(page, tabId) {
      return page.evaluate((id) => {
        const tab = document.querySelector(`button[data-dock-tab="${id}"]`);
        const glyph = tab?.querySelector('span.dock-tab-icon');
        const svg = glyph?.querySelector('svg');
        if (!glyph || !svg) return null;
        return {
          color: getComputedStyle(glyph).color,
          svgFill: svg.style.fill || svg.getAttribute('fill') || '',
          svgColor: getComputedStyle(svg).color,
        };
      }, tabId);
    }
    async function sidebarProjectColor(page, name) {
      return page.evaluate((projectName) => {
        const row = [...document.querySelectorAll('#project-list .project-row')].find((node) =>
          (node.textContent || '').includes(projectName),
        );
        // The tinted folder icon only: first-svg grabs chevrons/status icons.
        const svg =
          row?.querySelector('.project-folder-icon svg') || row?.querySelector('.project-folder-icon');
        if (!svg) return null;
        const target = svg.tagName.toLowerCase() === 'svg' ? svg : svg.querySelector('svg') || svg;
        return {
          color: getComputedStyle(target).color,
          svgFill: target.style?.fill || target.getAttribute?.('fill') || '',
        };
      }, name);
    }
    const betaView = (await convTabIds(page)).find((tab) => tab === pickedTab);
    const gammaView = droppedTab;
    assert.ok(betaView && gammaView, 'Atelier + Vtrott views must both be open for icon colors');
    // Sidebar must VISIBLY carry the seeded palette colors first (row attribute
    // plus tinted folder icon); only then can dock colors be compared.
    assert.equal(
      await page
        .locator('#project-list .project-row', { hasText: 'Atelier' })
        .getAttribute('data-project-color'),
      '#16a34a',
      'Sidebar Atelier row shows the seeded green',
    );
    assert.equal(
      await page
        .locator('#project-list .project-row', { hasText: 'Vtrott' })
        .getAttribute('data-project-color'),
      '#3b82f6',
      'Sidebar Vtrott row shows the seeded blue',
    );
    const atelierSide = await sidebarProjectColor(page, 'Atelier');
    const vtrottSide = await sidebarProjectColor(page, 'Vtrott');
    assert.ok(atelierSide && vtrottSide, 'Sidebar project colors must be readable');
    const betaIconA = await tabIconColor(page, betaView);
    const gammaIconA = await tabIconColor(page, gammaView);
    assert.ok(betaIconA && gammaIconA, 'Both conversation tabs must expose icon color data');
    measurements.tabIconDetail = { betaIconA, gammaIconA, atelierSide, vtrottSide };
    const keyOf = (entry) => `${entry.color}`;
    assert.equal(keyOf(betaIconA), keyOf(atelierSide), 'Atelier view icon uses the owning project color');
    assert.equal(keyOf(gammaIconA), keyOf(vtrottSide), 'Vtrott view icon uses the owning project color');
    assert.notEqual(keyOf(betaIconA), keyOf(gammaIconA), 'Two projects use distinct icon colors');
    // Focus change must not recolor: inactive keeps its own project color.
    await focusConvTab(page, betaView);
    await focusConvTab(page, gammaView);
    assert.equal(
      keyOf(await tabIconColor(page, betaView)),
      keyOf(atelierSide),
      'Inactive Atelier icon keeps its color after focus change',
    );
    assert.equal(
      keyOf(await tabIconColor(page, gammaView)),
      keyOf(vtrottSide),
      'Focused Vtrott icon keeps its color after focus change',
    );
    assert.equal(starts.length, runsBeforeSidebar, 'Icon checks start zero runs');
    step('Conversation tab icons carry their owning project color across focus changes.');
  }

  // ------------------------------------------------ M2A: minimal per-pane composer check.
  // M2 wiring staged: real independent composers per pane (data-cvw roles, no
  // IDs), shell pointerdown/focusin focuses owner without consuming the event,
  // single data-focused shell + single .is-focused tab. The old "Modifier ici"
  // bar is REMOVED (Flow): its absence is asserted, never used as fallback.
  // Probe-gated like T5: fewer than 2 visible per-pane composers defers with a
  // clear note instead of breaking smoke.
  proofPhase = 'm2-composers';
  const m2ReadProbe = () =>
    page.evaluate(() => {
      const all = [...document.querySelectorAll('#dock-workspace [data-cvw="composer"]')];
      return {
        total: all.length,
        visible: all.filter((node) => node.getClientRects().length).length,
      };
    });
  // Gate: at least one wired dynamic pane (primary uses the host composer, so
  // data-cvw counts dynamic panes only). Bounded poll absorbs mount timing;
  // the body hard-asserts both panes.
  let m2Wired = true;
  if (!M2_ENFORCE) {
    try {
      await expect
        .poll(() => m2ReadProbe().then((probe) => probe.visible), { timeout: 15000 })
        .toBeGreaterThanOrEqual(1);
    } catch {
      measurements.m2Composers = await m2ReadProbe();
      note('DEFERRED until M2 wiring lands: m2-composers (need a wired dynamic pane)');
      deferred.push('m2-composers');
      m2Wired = false;
    }
  } else {
    await expect
      .poll(() => m2ReadProbe().then((probe) => probe.visible), { timeout: 15000 })
      .toBeGreaterThanOrEqual(1);
  }
  measurements.m2Composers = await m2ReadProbe();
  if (!m2Wired) {
    // Pre-enable deferral recorded above; skip the body silently.
  } else if ((measurements.m2Composers.visible || 0) < 1) {
    throw new Error('M2 enabled but no wired dynamic composer pane');
  } else {
    // PRIMARY + dynamic (never two dynamics alone): primary keeps the ORIGINAL
    // host composer (classic IDs; composerNodes=null), dynamic panes get
    // data-cvw controls. Primary must retain own draft/model while a dynamic
    // view is focused, with both inputs visible — this fails if primary still
    // shares/loses input behind two clones.
    const viewA = 'conversation';
    const viewB = pickedTab;
    const viewC = droppedTab;
    // Generation PATCH observer (real network observation, no injection):
    // every model/thinking/questions change PATCHes /api/conversation-settings
    // with the owning session id. Entries are cleared per block below.
    const genPatches = [];
    page.on('request', (request) => {
      try {
        if (request.method() === 'PATCH' && request.url().includes('/api/conversation-settings')) {
          const body = request.postDataJSON();
          if (body) genPatches.push(body);
        }
      } catch {}
    });
    assert.ok(viewB && viewB.startsWith('conv:'), 'A dynamic bound view must exist (ws-beta)');
    const paneOf = (id) => page.locator(`.cvw-shell[data-view="${id}"]`);
    const ctl = (id, role) => paneOf(id).locator(`[data-cvw="${role}"]`);
    const hostComposer = () => paneOf(viewA).locator('#composer');
    const hostText = async () =>
      paneOf(viewA)
        .locator('#composer')
        .evaluate((node) => node.value ?? node.textContent ?? '');
    const cvText = async (id) => ctl(id, 'composer').evaluate((node) => node.value ?? node.textContent ?? '');
    async function ensureSideBySide(page, tabA, tabB) {
      let sig = await layoutSignature(page);
      let gA = sig.groups.find((group) => group.tabs.includes(tabA));
      let gB = sig.groups.find((group) => group.tabs.includes(tabB));
      assert.ok(gA && gB, 'Both views must be mounted for side-by-side');
      if (gA.id === gB.id) {
        await openLayoutDialog(page);
        await page.locator(DOCK.panelSelect).selectOption(tabB);
        await page.locator(DOCK.targetSelect).selectOption(gA.id);
        await page.locator(DOCK.zoneSelect).selectOption('right');
        await page.locator(DOCK.moveButton).click();
        await page.locator(DOCK.closeSettings).click();
      }
    }
    // Deterministic bindings through real UI (no sends): primary -> ws-alpha,
    // dynamic -> ws-beta.
    await focusConvTab(page, viewA);
    await page.locator('#session-list .session-select').filter({ hasText: 'Calibrer la sortie' }).click();
    await expect(page.locator('#detail-session-id')).toContainText('ws-alpha', { timeout: 10000 });
    await focusConvTab(page, viewB);
    await page
      .locator('#session-list .session-select')
      .filter({ hasText: 'Préparer la distribution' })
      .click();
    await expect(page.locator('#detail-session-id')).toContainText('ws-beta', { timeout: 10000 });
    await ensureSideBySide(page, viewA, viewB);
    await focusConvTab(page, viewB);
    await focusConvTab(page, viewA);
    await assertHostMount(page, 'm2a');
    await assertPaneGeometry(page, [viewA, viewB], 'm2a');
    await expectHistoricalTool(page, viewA, 'ws-alpha');
    await expectHistoricalTool(page, viewB, 'ws-beta');
    step('Primary and dynamic panes both render their own historical tool calls/results.');
    // Old edit-here affordance absent: entire header container, button, text.
    for (const id of [viewA, viewB]) {
      assert.equal(await paneOf(id).locator('.cvw-bar').count(), 0, `Old header bar absent in ${id}`);
      assert.equal(await paneOf(id).locator('.cvw-focus').count(), 0, `Old edit-here button absent in ${id}`);
      assert.equal(
        await paneOf(id).evaluate((node) => /Modifier ici|Edit here/.test(node.textContent || '')),
        false,
        `Old edit-here text absent in ${id}`,
      );
    }
    step('Old Modifier-ici bar absent from primary and dynamic panes.');
    for (const id of [viewA, viewB]) {
      assert.equal(
        await paneOf(id).locator('.composer-input-row').count(),
        1,
        `Pane ${id} has exactly one composer input row (no double-wrap)`,
      );
    }
    step('Single composer input row per pane.');
    // Per-pane controls: primary host IDs + dynamic data-cvw roles.
    await expect(hostComposer()).toBeVisible({ timeout: 10000 });
    await expect(hostComposer()).toBeEnabled();
    await expect(paneOf(viewA).locator('#send-button')).toBeAttached({ timeout: 10000 });
    await expect(paneOf(viewA).locator('#thinking-select')).toBeAttached({ timeout: 10000 });
    await expect(ctl(viewB, 'composer')).toBeVisible({ timeout: 10000 });
    await expect(ctl(viewB, 'composer')).toBeEnabled();
    await expect(ctl(viewB, 'send')).toBeAttached({ timeout: 10000 });
    await expect(ctl(viewB, 'model')).toBeAttached({ timeout: 10000 });
    await expect(ctl(viewB, 'thinking')).toBeAttached({ timeout: 10000 });
    await expect(ctl(viewB, 'attach-images')).toBeAttached({ timeout: 10000 });
    await expect(ctl(viewB, 'attach-files')).toBeAttached({ timeout: 10000 });
    await expect(ctl(viewB, 'tray')).toBeAttached({ timeout: 10000 });
    step('Primary host composer plus dynamic data-cvw controls both present.');
    // Drafts: primary first (focused), then dynamic (focused) — then BOTH must
    // stay visible with intact values while the dynamic view is focused.
    await hostComposer().fill('M2A-draft-PRIMARY pour ws-alpha');
    await focusConvTab(page, viewB);
    await ctl(viewB, 'composer').fill('M2A-draft-DYN pour ws-beta');
    await expect(hostComposer()).toBeVisible({ timeout: 10000 });
    await expect(ctl(viewB, 'composer')).toBeVisible({ timeout: 10000 });
    assert.equal(
      await hostText(),
      'M2A-draft-PRIMARY pour ws-alpha',
      'Primary draft retained while dynamic focused',
    );
    assert.equal(await cvText(viewB), 'M2A-draft-DYN pour ws-beta', 'Dynamic draft isolated');
    step('Primary retains own draft while dynamic focused; both inputs visible.');
    // Generation controls are per-pane independent by SPEC (complete composer
    // in every pane; only Roadmap/tools use the focused context). The current
    // global/session-scoped behavior is the filed product bug, not the spec:
    // divergence is asserted exactly, never waived to architecture.
    const hostThink = paneOf(viewA).locator('#thinking-select');
    const dynThink = ctl(viewB, 'thinking');
    const hostThinkOrig = await hostThink.inputValue();
    const dynThinkOrig = await dynThink.inputValue();
    await hostThink.selectOption('low');
    await dynThink.selectOption('medium');
    await focusConvTab(page, viewA);
    await focusConvTab(page, viewB);
    assert.equal(await hostThink.inputValue(), 'low', 'Primary thinking retained');
    assert.equal(await dynThink.inputValue(), 'medium', 'Dynamic thinking retained');
    await focusConvTab(page, viewA);
    await hostThink.selectOption(hostThinkOrig);
    await focusConvTab(page, viewB);
    await dynThink.selectOption(dynThinkOrig);
    step('Primary and dynamic keep independent model/thinking state.');
    // Independent MODEL per pane through the real picker (two fixture models,
    // real dialog buttons — never the hidden selects). Labels must persist per
    // pane across focus switches; PATCHes must target the owning sessions.
    genPatches.length = 0;
    async function pickPaneModel(pane, buttonSelector, modelId) {
      await pane.locator(buttonSelector).click();
      await expect(page.locator('#model-dialog')).toBeVisible({ timeout: 10000 });
      const choice = page.locator(`#model-dialog .model-choice[data-model-id="${modelId}"]`);
      await expect(choice).toBeVisible({ timeout: 10000 });
      await choice.click();
      await expect(page.locator('#model-dialog')).toBeHidden({ timeout: 10000 });
    }
    const hostModelLabel = () =>
      paneOf(viewA)
        .locator('#model-picker-label')
        .evaluate((node) => node.textContent || '');
    const dynModelLabel = () =>
      paneOf(viewB)
        .locator('[data-cvw="model-name"]')
        .evaluate((node) => node.textContent || '');
    // Seed-then-change so neither assertion can ride a no-op selection.
    await pickPaneModel(paneOf(viewA), '#model-picker-button', 'fixture/docking');
    await pickPaneModel(paneOf(viewA), '#model-picker-button', 'fixture/atlas');
    await pickPaneModel(paneOf(viewB), '[data-cvw="model"]', 'fixture/atlas');
    await pickPaneModel(paneOf(viewB), '[data-cvw="model"]', 'fixture/docking');
    await expect.poll(() => hostModelLabel(), { timeout: 10000 }).toContain('Atlas');
    await expect.poll(() => dynModelLabel(), { timeout: 10000 }).toContain('Docking');
    await focusConvTab(page, viewA);
    await focusConvTab(page, viewB);
    assert.ok((await hostModelLabel()).includes('Atlas'), 'Primary model retained across focus switches');
    assert.ok((await dynModelLabel()).includes('Docking'), 'Dynamic model retained across focus switches');
    const modelPatches = genPatches.filter((body) => body && body.settings && 'model' in body.settings);
    assert.ok(
      modelPatches.some((body) => body.id === 'ws-alpha' && body.settings.model === 'fixture/atlas'),
      'Primary model PATCH targets the owning session',
    );
    assert.ok(
      modelPatches.some((body) => body.id === 'ws-beta' && body.settings.model === 'fixture/docking'),
      'Dynamic model PATCH targets the owning session',
    );
    step('Independent MODEL per pane via real picker (labels persist, PATCH targets own sessions).');
    await pickPaneModel(paneOf(viewA), '#model-picker-button', '');
    await pickPaneModel(paneOf(viewB), '[data-cvw="model"]', '');
    // Independent QUESTIONS per pane with PROVEN divergence: end state is
    // exactly A=false / B=true, reached through real changes on both sides
    // (flip-twice when already at target so a change event + PATCH always fire).
    genPatches.length = 0;
    const hostAllowQ = paneOf(viewA).locator('#allow-questions');
    const dynAllowQ = ctl(viewB, 'allow-questions');
    const hostAllowOrig = await hostAllowQ.isChecked();
    const dynAllowOrig = await dynAllowQ.isChecked();
    async function ensureAllowQ(locator, want) {
      if ((await locator.isChecked()) === want) {
        // Touch both edges so the assertion below never rides a no-op.
        if (want) await locator.uncheck();
        else await locator.check();
      }
      if (want) await locator.check();
      else await locator.uncheck();
      assert.equal(await locator.isChecked(), want, 'Questions control reaches its target state');
    }
    await ensureAllowQ(hostAllowQ, false);
    await ensureAllowQ(dynAllowQ, true);
    await focusConvTab(page, viewA);
    await focusConvTab(page, viewB);
    assert.equal(await hostAllowQ.isChecked(), false, 'Primary questions flag retained (false)');
    assert.equal(await dynAllowQ.isChecked(), true, 'Dynamic questions flag retained (true)');
    const questionPatches = genPatches.filter(
      (body) => body && body.settings && 'allowQuestions' in body.settings,
    );
    assert.ok(
      questionPatches.some((body) => body.id === 'ws-alpha' && body.settings.allowQuestions === false),
      'Primary questions PATCH carries false for the owning session',
    );
    assert.ok(
      questionPatches.some((body) => body.id === 'ws-beta' && body.settings.allowQuestions === true),
      'Dynamic questions PATCH carries true for the owning session',
    );
    step('Independent QUESTIONS per pane (opposite flags persist, exact PATCH values+IDs).');
    if (hostAllowOrig) await hostAllowQ.check();
    else await hostAllowQ.uncheck();
    if (dynAllowOrig) await dynAllowQ.check();
    else await dynAllowQ.uncheck();
    // Focus via click INSIDE panes (never the tab): native focus + single markers.
    await hostComposer().click();
    assert.deepEqual(await focusedMarker(page), [viewA], 'In-pane click focuses primary');
    await ctl(viewB, 'composer').click();
    assert.deepEqual(await focusedMarker(page), [viewB], 'In-pane click focuses the dynamic pane');
    assert.equal(
      await page.evaluate(
        (id) =>
          document.activeElement ===
          document.querySelector(`.cvw-shell[data-view="${id}"] [data-cvw="composer"]`),
        viewB,
      ),
      true,
      'In-pane click focuses the pane composer natively on first click',
    );
    assert.deepEqual(
      await page.evaluate(() =>
        [...document.querySelectorAll('.cvw-shell[data-focused="true"]')].map((n) => n.dataset.view),
      ),
      [viewB],
      'Exactly one shell carries data-focused',
    );
    step('Click inside either pane focuses it natively with a single marker.');
    // First-click send on the inactive dynamic pane: focus primary, then send
    // from the dynamic pane in ONE click (focus + action, ws-beta bound).
    const m2Starts = starts.length;
    await focusConvTab(page, viewA);
    await ctl(viewB, 'send').click();
    await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(m2Starts + 1);
    const m2ControlB = activeControls[activeControls.length - 1];
    assert.equal(m2ControlB.record.sessionId, 'ws-beta', 'First-click dynamic send binds the pane session');
    assert.deepEqual(await focusedMarker(page), [viewB], 'Send focuses its owner pane');
    await expect(ctl(viewB, 'stop')).toBeVisible({ timeout: 10000 });
    assert.equal(await hostText(), 'M2A-draft-PRIMARY pour ws-alpha', 'Primary draft survives dynamic send');
    await m2ControlB.finish('completed');
    await expect(ctl(viewB, 'stop')).toBeHidden({ timeout: 15000 });
    assert.equal(await cvText(viewB), '', 'Dynamic draft accepted on send');
    step('First click on an inactive dynamic send both focuses and sends (ws-beta bound).');
    // Targeted primary send through the host controls (ws-alpha bound).
    await focusConvTab(page, viewA);
    await expect.poll(() => hostText(), { timeout: 10000 }).toBe('M2A-draft-PRIMARY pour ws-alpha');
    await paneOf(viewA).locator('#send-button').click();
    await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(m2Starts + 2);
    const m2ControlA = activeControls[activeControls.length - 1];
    assert.equal(m2ControlA.record.sessionId, 'ws-alpha', 'Primary send binds the primary session');
    await m2ControlA.finish('completed');
    await expect(vStop(page, viewA)).toBeHidden({ timeout: 15000 });
    step('Targeted primary send binds ws-alpha with zero cancels.');
    // Second dynamic covers the ws-gamma binding (compact).
    if (viewC && viewC.startsWith('conv:')) {
      await focusConvTab(page, viewC);
      await page.locator('#session-list .session-select').filter({ hasText: 'migration du volant' }).click();
      await expect(page.locator('#detail-session-id')).toContainText('ws-gamma', { timeout: 10000 });
      await ctl(viewC, 'composer').fill('M2A-draft-C pour ws-gamma');
      await ctl(viewC, 'send').click();
      await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(m2Starts + 3);
      assert.equal(
        activeControls[activeControls.length - 1].record.sessionId,
        'ws-gamma',
        'Second dynamic send binds ws-gamma',
      );
      await activeControls[activeControls.length - 1].finish('completed');
      step('Second dynamic send binds ws-gamma.');
    } else {
      note('No second dynamic view available for ws-gamma binding coverage.');
    }
    // Attachments: dynamic file input when wired, host input for primary.
    // Focus B first so its pane (and tray) is actually visible for the assert.
    await focusConvTab(page, viewB);
    const dynFiles = await paneOf(viewB).locator('input[type="file"]').count();
    if (dynFiles > 0) {
      await paneOf(viewB).locator('input[type="file"]').first().setInputFiles(pixelPath);
      await expect(ctl(viewB, 'tray')).toBeVisible({ timeout: 10000 });
      step('Per-pane attachment lands in the owning dynamic tray.');
    } else if (M2_ENFORCE) {
      throw new Error('M2 enabled but no per-pane file input wired');
    } else {
      note('Per-pane file input not yet wired: attachment flow deferred (tray role present).');
      deferred.push('m2-attachments');
    }
    assert.equal(cancellations, 0, 'M2A sends never cancel');
    // N1: Nouvelle-conversation button + Ctrl+N target the FOCUSED tab.
    // The focused dynamic tab itself becomes new-chat: no extra tab/view/run,
    // its composer cleared, other panes untouched.
    const dynComposer = (id) => paneOf(id).locator('[data-cvw="composer"]');
    const dynText = async (id) => dynComposer(id).evaluate((node) => node.value ?? node.textContent ?? '');
    await focusConvTab(page, viewA);
    await hostComposer().fill('N1-draft-A');
    await focusConvTab(page, viewB);
    await dynComposer(viewB).fill('N1-draft-B');
    assert.equal(
      await paneOf(viewB)
        .locator('[data-cvw="tray"]')
        .evaluate((node) => !node.hidden)
        .catch(() => false),
      true,
      'Precondition: dynamic tray attachment from M2A still present',
    );
    const n1TabsBefore = await convTabIds(page);
    const n1ShellsBefore = await shellIds(page);
    const n1Starts = starts.length;
    async function assertBecameNewChat(page, tabId, oldSessionId, label) {
      assert.deepEqual(
        [...(await convTabIds(page))].sort(),
        [...n1TabsBefore].sort(),
        `${label}: no extra tab`,
      );
      assert.deepEqual(
        [...(await shellIds(page))].sort(),
        [...n1ShellsBefore].sort(),
        `${label}: no extra view`,
      );
      assert.deepEqual(await focusedMarker(page), [tabId], `${label}: focus stays on the targeted tab`);
      assert.equal(starts.length, n1Starts, `${label}: no model run`);
    }
    // Path 1: button from the focused dynamic tab.
    await focusConvTab(page, viewB);
    await page.locator('#new-session').click();
    await expect.poll(() => dynText(viewB), { timeout: 10000 }).toBe('');
    await assertBecameNewChat(page, viewB, 'ws-beta', 'button new-chat');
    assert.ok(
      !(
        await page
          .locator('#detail-session-id')
          .textContent()
          .catch(() => 'ws-beta')
      ).includes('ws-beta'),
      'button new-chat: inspector no longer shows the old session',
    );
    step('Nouvelle-conversation button rebinds the focused dynamic tab (no extra tab/run).');
    // Others unchanged: primary draft + binding intact.
    await focusConvTab(page, viewA);
    assert.equal(await hostText(), 'N1-draft-A', 'Other pane draft unchanged by new-chat');
    await expect(page.locator('#detail-session-id')).toContainText('ws-alpha', { timeout: 10000 });
    // Path 2: Ctrl+N from a rebound focused dynamic tab.
    await focusConvTab(page, viewB);
    await page
      .locator('#session-list .session-select')
      .filter({ hasText: 'Préparer la distribution' })
      .click();
    await expect(page.locator('#detail-session-id')).toContainText('ws-beta', { timeout: 10000 });
    await dynComposer(viewB).fill('N1-draft-B2');
    await focusConvTab(page, viewB);
    await page.keyboard.press('Control+n');
    await expect.poll(() => dynText(viewB), { timeout: 10000 }).toBe('');
    await assertBecameNewChat(page, viewB, 'ws-beta', 'Ctrl+N new-chat');
    step('Ctrl+N rebinds the focused dynamic tab (no extra tab/run).');
    // Tool focus: last-focused conversation is the new-chat target.
    await focusConvTab(page, viewC);
    await page.locator('#session-list .session-select').filter({ hasText: 'migration du volant' }).click();
    await expect(page.locator('#detail-session-id')).toContainText('ws-gamma', { timeout: 10000 });
    assert.ok(viewC && viewC.startsWith('conv:'), 'A second dynamic view must exist for the tool-focus case');
    const dynCText = async () =>
      paneOf(viewC)
        .locator('[data-cvw="composer"]')
        .evaluate((node) => node.value ?? node.textContent ?? '');
    await paneOf(viewC).locator('[data-cvw="composer"]').fill('N1-draft-C');
    await page.locator('button[data-dock-tab="roadmap"]').click();
    await expect(page.locator('#dock-view-roadmap')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Control+n');
    await expect
      .poll(
        () =>
          paneOf(viewC)
            .locator('[data-cvw="composer"]')
            .evaluate((node) => node.value ?? node.textContent ?? ''),
        { timeout: 10000 },
      )
      .toBe('');
    const toolTarget = await focusedMarker(page);
    measurements.newchatToolTarget = toolTarget;
    assert.deepEqual(toolTarget, [viewC], 'Tool-focus Ctrl+N targets the last-focused conversation');
    assert.deepEqual(
      [...(await convTabIds(page))].sort(),
      [...n1TabsBefore].sort(),
      'Tool-focus new-chat: no extra tab',
    );
    assert.equal(starts.length, n1Starts, 'Tool-focus new-chat: no model run');
    step('Tool-focus Ctrl+N rebinds the last-focused conversation (no extra tab/run).');
  }

  // ------------------------------------------------ Phase 8: two new drafts, same project, distinct + attachment.
  proofPhase = 'two-drafts';
  let viewX = null;
  let viewY = null;
  if (!RUN_DEEP) {
    note('DEFERRED until composer M2 stable: two-drafts');
    deferred.push('two-drafts');
  } else {
    // Reuse primary (ws-alpha, Atelier) + pickedTab (ws-beta, Atelier): creating
    // fresh views here would collide with same-session dedupe later, and the cap
    // loop in Phase 13 still exercises creation. Same-project pair preserved.
    [viewX, viewY] = ['conversation', pickedTab];
    assert.ok(viewY && viewY.startsWith('conv:'), 'pickedTab must exist from the chooser phase');
    const p8starts = starts.length;
    // Side-by-side first: each own composer must be group-active (fillable).
    {
      const sig8 = await layoutSignature(page);
      const gX = sig8.groups.find((group) => group.tabs.includes(viewX));
      assert.ok(gX, 'A live group holding viewX must exist');
      if (gX.tabs.includes(viewY)) {
        await openLayoutDialog(page);
        await page.locator(DOCK.panelSelect).selectOption(viewY);
        await page.locator(DOCK.targetSelect).selectOption(gX.id);
        await page.locator(DOCK.zoneSelect).selectOption('right');
        await page.locator(DOCK.moveButton).click();
        await page.locator(DOCK.closeSettings).click();
      }
    }
    await focusConvTab(page, viewX);
    const draftsOf = async () => (await storageEnvelope(page, DRAFTS_KEY))?.parsed || {};
    await vFill(page, viewX, 'Brouillon X : vérifier la sortie audio');
    await focusConvTab(page, viewY);
    await vFill(page, viewY, 'Brouillon Y : préparer la distribution');
    await focusConvTab(page, viewX);
    assert.equal(await vText(page, viewX), 'Brouillon X : vérifier la sortie audio');
    await focusConvTab(page, viewY);
    assert.equal(await vText(page, viewY), 'Brouillon Y : préparer la distribution');
    // Draft key scheme is owner-held (slot/stash acceptance in flight), so pin
    // observable behavior, not key names: both texts persist exactly once under
    // distinct keys.
    const draftsAfter = await draftsOf();
    const draftValues = Object.values(draftsAfter).filter((value) => typeof value === 'string');
    assert.ok(draftValues.includes('Brouillon X : vérifier la sortie audio'), 'Draft text X persists');
    assert.ok(draftValues.includes('Brouillon Y : préparer la distribution'), 'Draft text Y persists');
    assert.equal(
      draftValues.filter((value) => value.startsWith('Brouillon X')).length,
      1,
      'Same-project drafts stay distinct per view (X stored exactly once)',
    );
    assert.equal(
      draftValues.filter((value) => value.startsWith('Brouillon Y')).length,
      1,
      'Same-project drafts stay distinct per view (Y stored exactly once)',
    );
    step('Two new drafts in the same project stay distinct per view, in UI and in slots.');
    // Background draft state without focusing: X's own composer holds its draft
    // while Y is focused (draft-preview bars were removed; the tab owns titles).
    assert.equal(
      await vText(page, viewX),
      'Brouillon X : vérifier la sortie audio',
      'Background view retains its draft while Y is focused',
    );
    step('Background view retains its draft while another view is focused.');
    // Genuine attachment in the focused view, preserved across focus switches.
    await focusConvTab(page, viewX);
    assert.ok((await vFiles(page, viewX).count()) > 0, 'Per-view file input exists for attachment');
    await vFiles(page, viewX).first().setInputFiles(pixelPath);
    await expect(vTray(page, viewX)).toBeVisible({ timeout: 10000 });
    // (Shell badges/titles were removed; the dock tab owns them. Tray visibility
    // plus draft retention below carry the attachment proof.)
    await focusConvTab(page, viewY);
    await focusConvTab(page, viewX);
    await expect(vTray(page, viewX)).toBeVisible({ timeout: 10000 });
    assert.equal(await vText(page, viewX), 'Brouillon X : vérifier la sortie audio');
    step('Attachment stays with the focused view across focus switches (tray + draft intact).');
    // Consume the probe attachment through the real remove control: an unsent
    // reload-restored pending attachment would otherwise gate later sends.
    await vPane(page, viewX).locator('#image-draft-tray .image-remove').click();
    await expect(vTray(page, viewX)).toBeHidden({ timeout: 10000 });
    step('Probe attachment removed through the real UI; zero residue for later sends.');
    assert.equal(starts.length, p8starts, 'Draft/attachment focus work must not start any model run');
  }
  // ------------------------------------------------ Phase 9: reload hydrates drafts + focused session; send binds same.
  proofPhase = 'reload-hydrate';
  if (!RUN_DEEP) {
    note('DEFERRED until composer M2 stable: reload-hydrate');
    deferred.push('reload-hydrate');
  } else {
    await focusConvTab(page, viewY);
    const startsBeforeHydrate = starts.length;
    await page.reload();
    await expect(page.locator('#connection-label')).toContainText('connecté', { timeout: 20000 });
    await expect(page.locator(DOCK.workspace)).toBeVisible({ timeout: 10000 });
    const tabsAfterReload = await convTabIds(page);
    assert.ok(
      tabsAfterReload.includes(viewX) && tabsAfterReload.includes(viewY),
      'Reload must rebind existing conv tabs',
    );
    // Boot guard: reload happened while the dynamic viewY was focused — the
    // sidecar activeId and the unique focus marker must restore to viewY, not primary.
    const sidecarAfterReload = await storageEnvelope(page, CONV_KEY);
    assert.equal(
      sidecarAfterReload?.parsed?.activeId,
      viewY,
      'Sidecar records the focused dynamic view across reload',
    );
    assert.deepEqual(
      await page.evaluate(() =>
        [...document.querySelectorAll('.dock-tab.is-conversation.is-focused')].map(
          (el) => el.dataset.dockTab,
        ),
      ),
      [viewY],
      'Reload restores the unique focus marker to the dynamic view (boot guard)',
    );
    const sidecarAfter = await storageEnvelope(page, CONV_KEY);
    assert.equal(sidecarAfter?.parsed?.version, 1, 'Sidecar version must be 1');
    assert.ok(Array.isArray(sidecarAfter.parsed.entries), 'Sidecar carries content-free entries');
    assert.equal(
      JSON.stringify(sidecarAfter.parsed).includes('"content"'),
      false,
      'Sidecar must not persist conversation content',
    );
    await focusConvTab(page, viewX);
    await expect
      .poll(() => vText(page, viewX), { timeout: 10000 })
      .toBe('Brouillon X : vérifier la sortie audio');
    await focusConvTab(page, viewY);
    await expect
      .poll(() => vText(page, viewY), { timeout: 10000 })
      .toBe('Brouillon Y : préparer la distribution');
    assert.equal(
      starts.length,
      startsBeforeHydrate,
      'Reload must not send, cancel, or discard (zero new runs)',
    );
    step('Reload rebinds existing tabs with per-view drafts; zero sends/cancels/discards.');
    // (Temporary probe sends used during diagnosis were removed once the
    // stub session-timer race was identified and fixed at the source above.)
    // Bind X to the existing session ws-alpha, reload, hydrate, send to the SAME session.
    await focusConvTab(page, viewX);
    await page.locator('#session-list .session-select').filter({ hasText: 'Calibrer la sortie' }).click();
    await expect(page.locator('#detail-session-id')).toContainText('ws-alpha', { timeout: 10000 });
    await page.reload();
    await expect(page.locator('#connection-label')).toContainText('connecté', { timeout: 20000 });
    await focusConvTab(page, viewX);
    // Discriminator: sidecar binding intact vs inspector refresh (exact cause either way).
    const sidecarHydrate = await storageEnvelope(page, CONV_KEY);
    assert.equal(
      (sidecarHydrate?.parsed?.entries || []).find((entry) => entry.id === viewX)?.sessionId,
      'ws-alpha',
      'Sidecar preserves the X session binding across reload',
    );
    await expect(page.locator('#detail-session-id')).toContainText('ws-alpha', { timeout: 10000 });
    await vFill(page, viewX, 'Message de liaison ws-alpha');
    const hydrateStarts = starts.length;
    await vSend(page, viewX).click();
    await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(hydrateStarts + 1);
    const hydrateControl = activeControls[activeControls.length - 1];
    assert.equal(
      hydrateControl.record.sessionId,
      'ws-alpha',
      'Hydrated send must bind the persisted focused session',
    );
    assert.ok(
      String(hydrateControl.record.cwd).replaceAll('\\', '/').endsWith('/Atelier') ||
        String(hydrateControl.record.cwd).includes('Atelier'),
      'Hydrated send must target the Atelier project',
    );
    hydrateControl.stream('Réponse de liaison pour ws-alpha.');
    await expect(vStop(page, viewX)).toBeVisible({ timeout: 10000 });
    await hydrateControl.finish('completed');
    await expect(vStop(page, viewX)).toBeHidden({ timeout: 15000 });
    step('Persisted focused session hydrates on reload and the next send binds that same session.');
  }
  // ------------------------------------------------ Phase 10: close parks (draft + run retained); reopen restores node.
  proofPhase = 'close-reopen';
  if (!RUN_DEEP) {
    note('DEFERRED until composer M2 stable: close-reopen');
    deferred.push('close-reopen');
  } else {
    const p10starts = starts.length;
    await focusConvTab(page, viewY);
    await markShell(page, viewY);
    await page.locator(`[data-dock-close="${viewY}"]`).first().click();
    await expect
      .poll(() => convTabIds(page).then((tabs) => tabs.includes(viewY)), { timeout: 10000 })
      .toBe(false);
    const parkedInSidecar = await storageEnvelope(page, CONV_KEY);
    assert.ok(
      (parkedInSidecar?.parsed?.entries || []).some((entry) => entry.id === viewY),
      'Closed view stays parked in the sidecar registry (nothing deleted)',
    );
    assert.equal(starts.length, p10starts, 'Closing a tab must not start a run');
    step('Closing a conversation tab parks it (sidecar retains the entry, zero runs).');
    await openLayoutDialog(page);
    await page.locator(`button[data-dock-open="${viewY}"]`).first().click();
    await page.locator(DOCK.closeSettings).click();
    await expect
      .poll(() => convTabIds(page).then((tabs) => tabs.includes(viewY)), { timeout: 10000 })
      .toBe(true);
    assert.equal(
      await shellSameAsMarked(page),
      true,
      'Reopen must restore the existing shell node, not a clone',
    );
    await focusConvTab(page, viewY);
    await expect
      .poll(() => vText(page, viewY), { timeout: 10000 })
      .toBe('Brouillon Y : préparer la distribution');
    step('Reopen restores the existing tab node with its parked draft.');
  }
  // ------------------------------------------------ Phase 11: two concurrent held runs, no context steal, side by side.
  proofPhase = 'concurrent-runs';
  if (!RUN_DEEP) {
    note('DEFERRED until composer M2 stable: concurrent-runs');
    deferred.push('concurrent-runs');
  } else {
    // Two DYNAMIC views (primary bg never renders docked by design): pickedTab
    // (ws-beta) + droppedTab (ws-gamma), both pre-bound, never rebound here.
    const concA = pickedTab;
    const concB = droppedTab;
    assert.ok(concA && concA.startsWith('conv:'), 'pickedTab must exist for concurrent runs');
    assert.ok(
      concB && concB.startsWith('conv:') && concB !== concA,
      'droppedTab must exist for concurrent runs',
    );
    // Confirm-select through the real sidebar (dedupe focuses the owner and
    // refreshes the inspector; dock-tab focus alone does not re-render it).
    await focusConvTab(page, concA);
    await page
      .locator('#session-list .session-select')
      .filter({ hasText: 'Préparer la distribution' })
      .click();
    await expect(page.locator('#detail-session-id')).toContainText('ws-beta', { timeout: 10000 });
    await focusConvTab(page, concB);
    await page.locator('#session-list .session-select').filter({ hasText: 'migration du volant' }).click();
    await expect(page.locator('#detail-session-id')).toContainText('ws-gamma', { timeout: 10000 });
    // Split A left / B right through the real dialog selects for the side-by-side capture.
    await openLayoutDialog(page);
    await page.locator(DOCK.panelSelect).selectOption(concB);
    const groupsForSplit = (await layoutSignature(page)).groups;
    const leftGroup = groupsForSplit.find((group) => group.tabs.includes(concA)) || groupsForSplit[0];
    await page.locator(DOCK.targetSelect).selectOption(leftGroup.id);
    await page.locator(DOCK.zoneSelect).selectOption('right');
    await page.locator(DOCK.moveButton).click();
    await page.locator(DOCK.closeSettings).click();
    signature = await layoutSignature(page);
    assert.ok(signature.groups.length >= 2, 'Side-by-side split needs two live groups');
    // Submit MA in A (held), edit B, submit MB in B (held): two live runs.
    await focusConvTab(page, concA);
    await vFill(page, concA, 'Message A pour ws-beta');
    const runsBefore = starts.length;
    await vSend(page, concA).click();
    await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(runsBefore + 1);
    const controlA = activeControls[activeControls.length - 1];
    assert.equal(controlA.record.sessionId, 'ws-beta', 'Run A must bind ws-beta');
    await focusConvTab(page, concB);
    await vFill(page, concB, 'Message B pour ws-gamma');
    await vSend(page, concB).click();
    await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(runsBefore + 2);
    const controlB = activeControls[activeControls.length - 1];
    assert.equal(controlB.record.sessionId, 'ws-gamma', 'Run B must bind ws-gamma');
    assert.notEqual(controlA, controlB, 'Concurrent runs need distinct controls');
    step('Two held runs start from two views with exact session bindings (ws-beta, ws-gamma).');
    // Background liveness + isolation: stream into A while B is focused.
    controlA.stream('Réponse différée exclusive pour la vue A.');
    await expect
      .poll(() => viewMessagesText(page, concA), { timeout: 10000 })
      .toContain('Réponse différée exclusive pour la vue A');
    const bTextWhileAStreams = await viewMessagesText(page, concB);
    assert.equal(
      bTextWhileAStreams.includes('Réponse différée exclusive pour la vue A.'),
      false,
      'Delayed A response must never paint view B',
    );
    const runStateA = await page.evaluate((id) => {
      const shell = document.querySelector(`.cvw-shell[data-view="${id}"]`);
      const status = shell?.querySelector('[data-cvw="run-status"]');
      const visible = (node) => !!node && !node.hidden && node.getClientRects().length > 0;
      return {
        composerVisible: visible(status),
        hasLabel: !!status?.textContent.trim(),
        legacyHidden: shell?.querySelector('.cvw-runline')?.hidden === true,
        visibleCount: [...(shell?.querySelectorAll('.cvw-runline, [data-cvw="run-status"]') || [])].filter(
          visible,
        ).length,
      };
    }, concA);
    assert.equal(
      runStateA.composerVisible,
      true,
      'Background view A shows its live run state while B is focused',
    );
    assert.equal(runStateA.hasLabel, true, 'The live status must include a readable label');
    assert.equal(runStateA.legacyHidden, true, 'The old duplicate runline stays hidden');
    assert.equal(
      runStateA.visibleCount,
      1,
      'Exactly one working indicator is visible in the background pane',
    );
    controlB.stream('Réponse différée exclusive pour la vue B.');
    await expect
      .poll(() => viewMessagesText(page, concB), { timeout: 10000 })
      .toContain('Réponse différée exclusive pour la vue B');
    const aTextWhileBStreams = await viewMessagesText(page, concA);
    assert.equal(
      aTextWhileBStreams.includes('Réponse différée exclusive pour la vue B.'),
      false,
      'Delayed B response must never paint view A',
    );
    step(
      'Concurrent held runs stream into their own views only; exactly one background run status stays live.',
    );
    // Session event for A while B is focused: inspector + B messages must not move.
    const inspectorBefore = await page.locator('#detail-session-id').textContent();
    const bMessagesBefore = await viewMessagesText(page, concB);
    controlA.emitSession('ws-beta', cwdA);
    // Settle through real UI churn (never arbitrary sleeps): force renders in
    // both groups, then compare.
    await page.locator('button[data-dock-tab="roadmap"]').click();
    await focusConvTab(page, concB);
    assert.equal(
      await page.locator('#detail-session-id').textContent(),
      inspectorBefore,
      'Background session event must not steal the inspector',
    );
    assert.equal(
      await viewMessagesText(page, concB),
      bMessagesBefore,
      'Background session event must not repaint view B',
    );
    step('Background session event steals neither the inspector nor the focused view.');
    // Editing lives per pane (M2): every visible pane exposes its OWN composer;
    // questions surface only as notes, never editors for another view's queue.
    for (const id of [concA, concB]) {
      assert.ok(
        (await vPane(page, id).locator('[data-cvw="composer"], #composer').count()) >= 1,
        `Visible pane ${id} exposes its own editable composer`,
      );
    }
    assert.equal(
      await page
        .locator('#workspace-question-alert')
        .isHidden()
        .catch(() => true),
      true,
      'No phantom question alert',
    );
    step('Editing lives per pane with own composers; no phantom question alert.');
    // The session-event churn above parked focus on roadmap: re-focus both
    // conversations through real tabs so the capture shows two live panes.
    await focusConvTab(page, concA);
    await focusConvTab(page, concB);
    await expect(vComposer(page, concA)).toBeVisible({ timeout: 10000 });
    await expect(vComposer(page, concB)).toBeVisible({ timeout: 10000 });
    step('Both conversation panes visibly rendered side by side.');
    await page.screenshot({ path: await freshShot(SHOTS.sideBySide), animations: 'disabled' });
    step('Side-by-side capture of two live conversation views (genuine pixels).');
    await controlA.finish('completed');
    await controlB.finish('completed');
    await focusConvTab(page, concA);
    await expect(vStop(page, concA)).toBeHidden({ timeout: 15000 });
  }
  // ------------------------------------------------ Phase 12: delayed-submit draft races (highest value).
  proofPhase = 'delayed-submit';
  if (!RUN_DEEP) {
    note('DEFERRED until composer M2 stable: delayed-submit');
    deferred.push('delayed-submit');
  } else {
    // Dynamic pair (pickedTab/droppedTab): per-view runs, drafts, rebinds.
    const raceA = pickedTab;
    const raceB = droppedTab;
    assert.ok(raceA && raceA.startsWith('conv:'), 'pickedTab must exist for delayed-submit');
    assert.ok(
      raceB && raceB.startsWith('conv:') && raceB !== raceA,
      'droppedTab must exist for delayed-submit',
    );
    // Case 1: submit on existing session A while held, focus/edit B, release, focus A again.
    await focusConvTab(page, raceA);
    await vFill(page, raceA, 'TEXTE-SOUMIS-A Ne doit jamais ressusciter');
    const raceStarts = starts.length;
    await vSend(page, raceA).click();
    await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(raceStarts + 1);
    const raceControl = activeControls[activeControls.length - 1];
    assert.equal(raceControl.record.sessionId, 'ws-beta', 'Race run must bind ws-beta');
    await focusConvTab(page, raceB);
    await vFill(page, raceB, 'Brouillon B pendant attente A');
    raceControl.stream('Réponse A enfin disponible.');
    await raceControl.finish('completed');
    await focusConvTab(page, raceA);
    await expect.poll(() => vText(page, raceA), { timeout: 10000 }).toBe('');
    const draftsRace = (await storageEnvelope(page, DRAFTS_KEY))?.parsed || {};
    assert.ok(
      !Object.values(draftsRace).includes('TEXTE-SOUMIS-A Ne doit jamais ressusciter'),
      'Submitted text must not linger in any draft slot after release',
    );
    await focusConvTab(page, raceB);
    await expect.poll(() => vText(page, raceB), { timeout: 10000 }).toBe('Brouillon B pendant attente A');
    await vFill(page, raceB, '');
    step('Delayed submit on A + edit on B: release clears A exactly, B draft intact, no stale stash.');
    // Case 2: replace the session in the SAME pane while the POST is held.
    // ws-delta is owned by nobody: the only target the pane can genuinely rebind to.
    await focusConvTab(page, raceA);
    await vFill(page, raceA, 'TEXTE-IDENTIQUE');
    const samePaneStarts = starts.length;
    await vSend(page, raceA).click();
    await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(samePaneStarts + 1);
    const samePaneControl = activeControls[activeControls.length - 1];
    assert.equal(samePaneControl.record.sessionId, 'ws-beta', 'Same-pane run must bind ws-beta');
    await page.locator('#session-list .session-select').filter({ hasText: 'sauvegardes' }).click();
    await expect(page.locator('#detail-session-id')).toContainText('ws-delta', { timeout: 10000 });
    await vFill(page, raceA, 'TEXTE-IDENTIQUE');
    await samePaneControl.finish('completed');
    await focusConvTab(page, raceB);
    await focusConvTab(page, raceA);
    await expect.poll(() => vText(page, raceA), { timeout: 10000 }).toBe('TEXTE-IDENTIQUE');
    await page.locator('#session-list .session-select').filter({ hasText: 'sauvegardes' }).click();
    await expect(page.locator('#detail-session-id')).toContainText('ws-delta', { timeout: 10000 });
    step(
      'Same-pane session replace while POST held: origin clears only its draft, identical target text survives.',
    );
    await vFill(page, raceA, '');
  }
  // ------------------------------------------------ Phase 13: corrupt sidecar recovers visibly, cap has no ghost tab.
  proofPhase = 'sidecar-limits';
  const corruptSidecar = {
    version: 1,
    activeId: 'conversation',
    entries: Array.from({ length: 25 }, (_, index) => ({
      id: index % 3 === 0 ? 'conversation' : `conv:dup${index % 4}`,
      kind: 'session',
      sessionId: index % 2 === 0 ? 'ws-alpha' : 'ws-alpha',
      projectCwd: cwdA,
      execCwd: cwdA,
      viewRunId: null,
      nonce: index % 2 === 0 ? 'same-nonce' : `n${index % 3}`,
      gen: null,
    })),
  };
  await page.evaluate(({ key, doc }) => localStorage.setItem(key, JSON.stringify(doc)), {
    key: CONV_KEY,
    doc: corruptSidecar,
  });
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText('connecté', { timeout: 20000 });
  await expect(page.locator(DOCK.workspace)).toBeVisible({ timeout: 10000 });
  assert.deepEqual(
    errors,
    [],
    `Corrupt sidecar must recover with zero page errors, got ${JSON.stringify(errors)}`,
  );
  const tabsRecovered = await convTabIds(page);
  assert.equal(new Set(tabsRecovered).size, tabsRecovered.length, 'Recovered tabs must have unique ids');
  step('Corrupt sidecar (duplicate ids/nonces/sessionIds, over-cap 25) recovers visibly with zero errors.');
  // Grow to the 8-conversation cap through the real picker, then prove over-cap
  // attempts on both paths create no ghost tab (chooser resolves, view null).
  let guard = 0;
  while ((await convTabIds(page)).length < MAX_CONVERSATIONS && guard < 12) {
    await openLayoutDialog(page);
    await page.locator(DOCK.newConversation).click();
    await expectPickerOpen(page);
    await pickProject(page, 'Atelier');
    await pickNewEmpty(page);
    await page.locator(DOCK.closeSettings).click();
    guard++;
  }
  const cappedTabs = await convTabIds(page);
  assert.equal(cappedTabs.length, MAX_CONVERSATIONS, `Must reach the ${MAX_CONVERSATIONS}-conversation cap`);
  const shellsBeforeCap = await shellIds(page);
  const runsBeforeCap = starts.length;
  // Dialog path at cap: control stays enabled (chooser exists); the resolve is
  // null, so nothing mounts. Await picker close resolution before counting.
  await openLayoutDialog(page);
  assert.equal(
    await page.locator(DOCK.newConversation).isDisabled(),
    false,
    'Dialog create stays enabled (chooser path)',
  );
  await page.locator(DOCK.newConversation).click();
  await expectPickerOpen(page);
  await pickProject(page, 'Atelier');
  await pickNewEmpty(page);
  await page.locator(DOCK.closeSettings).click();
  // Menu path at cap: same resolve-null outcome.
  const anyGroup = (await layoutSignature(page)).groups[0].id;
  await page.locator(`[data-dock-group="${anyGroup}"]`).locator(DOCK.ellipsis).click();
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.contextMenu).locator('[aria-haspopup="menu"]').click();
  await expect(page.locator(DOCK.addMenu)).toBeVisible({ timeout: 10000 });
  await page.locator(`${DOCK.addOption}[data-dock-add="new-conversation"]`).click();
  await expectPickerOpen(page);
  await pickProject(page, 'Atelier');
  await pickNewEmpty(page);
  const tabsAfterCap = await convTabIds(page);
  assert.deepEqual(
    [...tabsAfterCap].sort(),
    [...cappedTabs].sort(),
    'Over-cap attempts must not produce a ghost tab',
  );
  assert.deepEqual(await shellIds(page), shellsBeforeCap, 'Over-cap attempts must not create shells');
  assert.equal(starts.length, runsBeforeCap, 'Over-cap attempts start zero runs');
  assert.deepEqual(errors, [], `Cap enforcement keeps zero page errors, got ${JSON.stringify(errors)}`);
  step('Conversation cap of 8 enforced on dialog+menu paths with no ghost tab and zero runs.');

  // ------------------------------------------------ Phase 14: roadmap work request binds the focused session.
  proofPhase = 'roadmap-focus';
  // Focus-driven (dedupe-aware): sidebar clicks focus the owning views; the
  // roadmap work destination must default to the FOCUSED session each time.
  // No view is rebound here — ownership is resolved by the product.
  const reboundTabs = await convTabIds(page);
  assert.ok(reboundTabs.length >= 2, 'Two rebound conversation tabs required after recovery');
  const workStarts = starts.length;
  async function workDestinationForSession(page, sessionTitle, label) {
    await page.locator('#session-list .session-select').filter({ hasText: sessionTitle }).click();
    // Detail renders a label prefix ("ID ws-alpha"); the work destination
    // carries the raw id — compare normalized values, never the decoration.
    const focusedSession = ((await page.locator('#detail-session-id').textContent()) || '')
      .replace(/^ID\s+/, '')
      .trim();
    assert.ok(focusedSession, `${label}: focusing selects a session`);
    await page.locator('button[data-dock-tab="roadmap"]').click();
    await expect(page.locator('#roadmap-panel')).toContainText('Fiabiliser le déplacement', {
      timeout: 10000,
    });
    const workButton = page.locator('#roadmap-panel button.rm-work-button').first();
    if (!(await workButton.isVisible().catch(() => false))) {
      await page.locator('#roadmap-panel .rm-plan-toggle').filter({ hasText: 'Fiabiliser' }).click();
    }
    await expect(workButton).toBeVisible({ timeout: 10000 });
    await workButton.click();
    const workDialog = page.locator('dialog[open]').last();
    await expect(workDialog).toBeVisible({ timeout: 10000 });
    const destinationValue = await workDialog.locator('select').first().inputValue();
    assert.equal(
      destinationValue,
      focusedSession,
      `${label}: work destination defaults to the focused session`,
    );
    await page.keyboard.press('Escape');
    await expect(workDialog).toBeHidden({ timeout: 10000 });
    return focusedSession.trim();
  }
  const destAlpha = await workDestinationForSession(page, 'Calibrer la sortie', 'alpha-focus');
  const destBeta = await workDestinationForSession(page, 'Préparer la distribution', 'beta-focus');
  assert.notEqual(destAlpha, destBeta, 'Destination follows focus between sessions');
  assert.equal(starts.length, workStarts, 'Inspecting work destinations must not send anything');
  step('Roadmap work request defaults to the focused session id; cancel sends nothing.');
  const viewP = reboundTabs[0];
  const viewQ = reboundTabs[1] || reboundTabs[0];

  // ------------------------------------------------ Phase 15: Preferences as a real dock tab (lifecycle batch).
  proofPhase = 'prefs-dock';
  async function revealOpener(page, openerId) {
    // Panels render async after select (network fetch for remote): settle per
    // tab with a bounded wait instead of a single synchronous read.
    const opener = page.locator(`#settings-dialog #${openerId}`);
    for (const tab of [
      'models',
      'tools',
      'remote',
      'sync',
      'appearance',
      'system',
      'notifications',
      'updates',
    ]) {
      await page
        .locator(`#settings-dialog [data-settings-tab="${tab}"]`)
        .click()
        .catch(() => {});
      try {
        await expect(opener).toBeVisible({ timeout: 5000 });
        return opener;
      } catch {}
    }
    throw new Error(`Settings opener #${openerId} not reachable through any category`);
  }
  async function prefsState(page) {
    return page.evaluate(() => {
      const dialog = document.getElementById('settings-dialog');
      const frame = document.getElementById('dock-view-preferences');
      return {
        inDock: !!dialog?.closest('#dock-workspace'),
        open: dialog?.open || false,
        modal: dialog?.matches(':modal') || false,
        frameHidden: frame ? frame.hidden : null,
        tabPresent: !!document.querySelector('button[data-dock-tab="preferences"]'),
        inert: document.body.inert || !!dialog?.closest('[inert]'),
        updatesVisible: !!document.querySelector('#settings-panel-updates')?.getClientRects().length,
      };
    });
  }
  // Open Preferences through AddTab (real menu path).
  const prefsGroup = (await layoutSignature(page)).groups[0].id;
  await page.locator(`[data-dock-group="${prefsGroup}"]`).locator(DOCK.ellipsis).click();
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.contextMenu).locator('[aria-haspopup="menu"]').click();
  await expect(page.locator(DOCK.addMenu)).toBeVisible({ timeout: 10000 });
  const prefsOption = page.locator(`${DOCK.addOption}[data-dock-add="preferences"]`);
  assert.equal(
    await prefsOption.isDisabled().catch(() => true),
    false,
    'AddTab preferences option must be enabled',
  );
  await prefsOption.click();
  await expect(page.locator('button[data-dock-tab="preferences"]')).toBeAttached({ timeout: 10000 });
  let prefs = await prefsState(page);
  assert.equal(prefs.inDock, true, 'Settings dialog must live inside the dock workspace');
  assert.equal(prefs.open, true, 'Docked preferences must be open');
  assert.equal(prefs.modal, false, 'Docked preferences must NOT be modal');
  assert.equal(prefs.inert, false, 'Docked preferences must not inert the page');
  step('Preferences opens via AddTab as a non-modal dock tab (no modal, no inert).');
  // Dirty-form probe, then same-group hide + rapid return. No text input is
  // visible in Preferences with default fixture state (text-ish fields hide
  // until their feature is configured), so the probe flips the visible
  // enter-to-send checkbox and flips it back afterwards: the dock surface
  // (node, category, control state) is what must survive hide/show.
  const dirtyLocator = page.locator('#settings-dialog #enter-to-send');
  await expect(dirtyLocator).toBeVisible({ timeout: 10000 });
  const dirtyOriginal = await dirtyLocator.isChecked();
  if (dirtyOriginal) await dirtyLocator.uncheck();
  else await dirtyLocator.check();
  const dirtyFlipped = !dirtyOriginal;
  await page.evaluate(() => {
    window.__prefsNode = document.getElementById('settings-dialog');
  });
  // Force same-group: move preferences into viewP's group, then switch to viewP's tab.
  await openLayoutDialog(page);
  await page.locator(DOCK.panelSelect).selectOption('preferences');
  const pGroup = (await layoutSignature(page)).groups.find((group) => group.tabs.includes(viewP));
  assert.ok(pGroup, 'A live group holding viewP must exist');
  await page.locator(DOCK.targetSelect).selectOption(pGroup.id);
  await page.locator(DOCK.zoneSelect).selectOption('center');
  await page.locator(DOCK.moveButton).click();
  await page.locator(DOCK.closeSettings).click();
  await page.locator(`button[data-dock-tab="${viewP}"]`).click();
  await expect
    .poll(
      () =>
        prefsState(page).then((state) => (state.tabPresent ? `${state.open}/${state.frameHidden}` : 'gone')),
      {
        timeout: 15000,
      },
    )
    .toBe('false/true');
  prefs = await prefsState(page);
  assert.equal(prefs.tabPresent, true, 'Switching tabs must hide Preferences WITHOUT removing its tab');
  assert.equal(prefs.modal, false, 'Hidden Preferences must not linger as a modal');
  // Rapid return: no waiting, then a single bounded settle for queued native closes.
  await page.locator('button[data-dock-tab="preferences"]').click();
  await expect
    .poll(
      () => prefsState(page).then((state) => (state.open && state.frameHidden === false ? 'ready' : 'wait')),
      {
        timeout: 15000,
      },
    )
    .toBe('ready');
  assert.equal(
    await dirtyLocator.isChecked(),
    dirtyFlipped,
    'Rapid return must retain the dirty control state',
  );
  assert.equal(
    await page.evaluate(() => document.getElementById('settings-dialog') === window.__prefsNode),
    true,
    'Preferences must be the SAME dialog node after hide/show (never rebuilt)',
  );
  step('Same-group hide keeps the Preferences tab; rapid return restores forms on the same node.');

  // Nested child managers from the docked surface: real showModal stacking, clean return.
  // Remote backend is seeded configured-but-disabled (lan-access.json before
  // createApp + binding-proof networkOptions), so the genuine remote child is
  // covered with zero host listeners. Pin backend state first via real API.
  const remoteBackend = await (await fetch(`${url}/api/remote-access/network`)).json();
  assert.equal(remoteBackend.configured, true, 'Remote backend reports configured');
  assert.equal(remoteBackend.enabled, false, 'Remote backend reports disabled');
  assert.ok(
    Array.isArray(remoteBackend.channels) && remoteBackend.channels.length > 0,
    'Remote backend reports channels',
  );
  for (const channel of remoteBackend.channels) {
    assert.equal(channel.enabled, false, `Channel ${channel.kind} disabled`);
    assert.equal(channel.status, 'disabled', `Channel ${channel.kind} status disabled`);
  }
  step('Remote backend configured-but-disabled on all channels (no listeners).');
  for (const openerId of ['open-provider-settings', 'open-mcp-settings', 'open-remote-access']) {
    const opener = await revealOpener(page, openerId);
    await opener.click();
    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll('dialog:modal').length), { timeout: 10000 })
      .toBe(1);
    prefs = await prefsState(page);
    assert.equal(errors.length, 0, `${openerId}: opening must raise no page error (no InvalidStateError)`);
    await page.keyboard.press('Escape');
    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll('dialog:modal').length), { timeout: 10000 })
      .toBe(0);
    prefs = await prefsState(page);
    assert.equal(prefs.open, true, `${openerId}: closing the child must return to docked Preferences`);
    assert.equal(prefs.modal, false, `${openerId}: return stays non-modal`);
    assert.equal(prefs.inert, false, `${openerId}: no inert leftovers`);
    assert.equal(
      await dirtyLocator.isChecked(),
      dirtyFlipped,
      `${openerId}: dirty control survives the round-trip`,
    );
  }
  step('Nested Providers/MCP/Remote open as real modals and return cleanly (no InvalidState, no inert).');
  // Model config is terminal: prefs tab stays, nothing reopens, nothing breaks.
  const modelOpener = await revealOpener(page, 'open-model-config');
  await modelOpener.click();
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('dialog:modal').length), { timeout: 15000 })
    .toBe(1);
  await page.keyboard.press('Escape');
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('dialog:modal').length), { timeout: 10000 })
    .toBe(0);
  prefs = await prefsState(page);
  assert.equal(prefs.tabPresent, true, 'Model config close keeps the Preferences tab');
  assert.equal(errors.length, 0, 'Model config round-trip raises no page error');
  step('Model config stacks terminally over docked Preferences and closes without damage.');
  // Commands dialog from docked prefs.
  const skillsOpener = await revealOpener(page, 'settings-skills');
  await skillsOpener.click();
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('dialog:modal').length), { timeout: 10000 })
    .toBe(1);
  await page.keyboard.press('Escape');
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('dialog:modal').length), { timeout: 10000 })
    .toBe(0);
  assert.equal(errors.length, 0, 'Commands round-trip raises no page error');
  step('Commands dialog stacks over docked Preferences and closes cleanly.');
  // Flip back so the dirty-form probe leaves no residue (re-select appearance:
  // nested openers leave their own category active and the box is hidden there).
  await page.locator('#settings-dialog [data-settings-tab="appearance"]').click();
  await expect(dirtyLocator).toBeVisible({ timeout: 10000 });
  if (dirtyOriginal) await dirtyLocator.check();
  else await dirtyLocator.uncheck();
  assert.equal(await dirtyLocator.isChecked(), dirtyOriginal, 'Dirty probe restores the original state');
  assert.equal(starts.length, workStarts, 'All Preferences flows must start zero model runs');
  // Main-button entrypoint (user-authorized mode change): #open-settings opens
  // a MODAL POPUP even with docking active, while AddTab keeps the non-modal
  // dock tab. Same live form, never duplicated.
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-dialog')).toBeVisible({ timeout: 10000 });
  const popupState = await page.evaluate(() => {
    const dialog = document.getElementById('settings-dialog');
    return {
      open: dialog?.open || false,
      modal: dialog?.matches(':modal') || false,
      inDock: !!dialog?.closest('#dock-workspace'),
      sameNode: dialog === window.__prefsNode,
      dialogs: document.querySelectorAll('#settings-dialog').length,
    };
  });
  measurements.popupEntrypoint = popupState;
  assert.equal(popupState.open, true, 'Main button opens Preferences');
  assert.equal(popupState.modal, true, 'Main button opens a real modal popup with docking active');
  assert.equal(popupState.sameNode, true, 'Popup is the same live form (no duplicate, no rebuild)');
  assert.equal(popupState.dialogs, 1, 'Exactly one settings form exists');
  // Style regression pin (dock CSS once hid these under :modal): heading and
  // close control must be genuinely visible in the popup.
  await expect(page.locator('#settings-dialog #settings-title')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#settings-dialog .modal-heading button[data-close-dialog]')).toBeVisible({
    timeout: 10000,
  });
  await page.locator('#settings-dialog [data-settings-tab="models"]').click();
  await expect(page.locator('#settings-panel-models')).toBeVisible({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden({ timeout: 10000 });
  assert.equal(
    await page.locator('button[data-dock-tab="preferences"]').count(),
    1,
    'Closing the popup keeps the dock tab (separate entrypoints, shared form)',
  );
  assert.equal(starts.length, workStarts, 'Popup entrypoint starts zero model runs');
  step('Main Preferences button opens a modal popup (same live form, dock tab preserved).');
  // Popup with NO dock tab: same modal behavior, and opening/closing it must
  // not mutate layout or tabs (AddTab stays the only creation path).
  await page.locator('[data-dock-close="preferences"]').first().click();
  await expect
    .poll(() => convTabIds(page).then((tabs) => tabs.includes('preferences')), { timeout: 10000 })
    .toBe(false);
  const noTabLayoutBefore = await layoutSignature(page);
  const noTabCountBefore = (await convTabIds(page)).length;
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-dialog')).toBeVisible({ timeout: 10000 });
  const popupNoTab = await page.evaluate(() => {
    const dialog = document.getElementById('settings-dialog');
    return {
      open: dialog?.open || false,
      modal: dialog?.matches(':modal') || false,
      sameNode: dialog === window.__prefsNode,
      dialogs: document.querySelectorAll('#settings-dialog').length,
    };
  });
  measurements.popupNoTab = popupNoTab;
  assert.equal(popupNoTab.open, true, 'Main button opens Preferences with no dock tab');
  assert.equal(popupNoTab.modal, true, 'No-tab popup is a real modal');
  assert.equal(popupNoTab.sameNode, true, 'No-tab popup is the same live form');
  assert.equal(popupNoTab.dialogs, 1, 'Exactly one settings form exists');
  await page.locator('#settings-dialog [data-settings-tab="models"]').click();
  await expect(page.locator('#settings-panel-models')).toBeVisible({ timeout: 10000 });
  assert.deepEqual(
    (await layoutSignature(page)).groups.map((group) => [group.id, group.tabs]),
    noTabLayoutBefore.groups.map((group) => [group.id, group.tabs]),
    'Popup open mutates no layout groups',
  );
  assert.equal((await convTabIds(page)).length, noTabCountBefore, 'Popup open creates no tab');
  // Model config from the main modal (Flow prepareDockMove seam): the parent
  // modal is deliberately released via counted close (popupOpen preserved),
  // exactly ONE child modal shows, then Escape returns the SAME settings popup
  // (MCP/Remote yield/return UX). The seam fixes session retention, not stacking.
  const modelOpenerPopup = await revealOpener(page, 'open-model-config');
  await modelOpenerPopup.click();
  await expect(page.locator('#model-config-dialog')).toBeVisible({ timeout: 15000 });
  assert.equal(
    await page.evaluate(() => {
      const settings = document.getElementById('settings-dialog');
      const child = document.getElementById('model-config-dialog');
      return (
        settings?.open === false &&
        child?.matches(':modal') === true &&
        document.querySelectorAll('dialog:modal').length === 1
      );
    }),
    true,
    'Model child shows alone while the parent popup is released (counted close)',
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeVisible({ timeout: 10000 });
  assert.equal(
    await page.evaluate(() => {
      const dialog = document.getElementById('settings-dialog');
      return dialog?.open === true && dialog?.matches(':modal') === true && dialog === window.__prefsNode;
    }),
    true,
    'Model config close returns the same modal popup',
  );
  await expect(page.locator('#settings-panel-models')).toBeVisible({ timeout: 10000 });
  assert.equal(errors.length, 0, 'Model-config-over-popup round-trip raises no page error');
  step('Model config yields from the main popup and returns to it (same node).');
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden({ timeout: 10000 });
  assert.deepEqual(
    (await layoutSignature(page)).groups.map((group) => [group.id, group.tabs]),
    noTabLayoutBefore.groups.map((group) => [group.id, group.tabs]),
    'Popup close mutates no layout groups',
  );
  assert.equal((await convTabIds(page)).length, noTabCountBefore, 'Popup close creates no tab');
  assert.equal(starts.length, workStarts, 'No-tab popup starts zero model runs');
  step('Main popup with no dock tab: same form, categories reachable, layout/tabs untouched.');

  // ------------------------------------------------ Phase 16: ?settings=updates bootstrap with saved docking.
  proofPhase = 'updates-bootstrap';
  if (
    await page
      .locator('[data-dock-close="preferences"]')
      .count()
      .then((n) => n > 0)
      .catch(() => false)
  ) {
    await page.locator('[data-dock-close="preferences"]').first().click();
    await expect(page.locator('button[data-dock-tab="preferences"]'))
      .toBeHidden({ timeout: 10000 })
      .catch(() => {});
  }
  const updatesPage = await context.newPage();
  updatesPage.setDefaultTimeout(15000);
  updatesPage.on('pageerror', (error) =>
    errors.push(String(error?.stack || error?.message || error).slice(0, 1200)),
  );
  await updatesPage.goto(`${url}/?settings=updates`);
  await expect(updatesPage.locator('#connection-label')).toContainText('connecté', { timeout: 20000 });
  // Either valid mode: non-modal docked Updates tab, or the default modal
  // popup. Intent (Updates visible, dialog open, closable) must never be lost.
  const bootPrefs = await updatesPage.evaluate(() => {
    const dialog = document.getElementById('settings-dialog');
    const updatesPanel = document.getElementById('settings-panel-updates');
    const updatesVisible = !!updatesPanel?.getClientRects().length;
    const updatesSelected =
      document
        .querySelector('#settings-dialog [data-settings-tab="updates"]')
        ?.getAttribute('aria-selected') === 'true';
    return {
      open: dialog?.open || false,
      modal: dialog?.matches(':modal') || false,
      inert: document.body.inert || !!dialog?.closest('[inert]'),
      updatesVisible,
      updatesSelected,
      dockTab: !!document.querySelector('button[data-dock-tab="preferences"]'),
    };
  });
  measurements.updatesBootstrap = bootPrefs;
  assert.equal(bootPrefs.open, true, '?settings=updates must open Preferences (no lost intent)');
  assert.equal(bootPrefs.updatesVisible, true, '?settings=updates must reveal the Updates section');
  assert.equal(bootPrefs.updatesSelected, true, '?settings=updates must select the Updates category');
  assert.ok(
    (!bootPrefs.modal && bootPrefs.dockTab && !bootPrefs.inert) || bootPrefs.modal,
    '?settings=updates presents docked non-modal Updates or the default modal popup (never a lost intent)',
  );
  if (bootPrefs.modal) {
    await updatesPage.keyboard.press('Escape');
    await expect(updatesPage.locator('#settings-dialog')).toBeHidden({ timeout: 10000 });
  }
  await updatesPage.close();
  step(
    `?settings=updates bootstrap reveals Updates (${bootPrefs.modal ? 'modal popup' : 'docked tab'}, intent kept).`,
  );

  // ------------------------------------------------ Phase 17: classic open, then viewport crossing both ways.
  proofPhase = 'viewport-crossing';
  await openLayoutDialog(page);
  if (
    await page
      .locator(DOCK.toggle)
      .isChecked()
      .catch(() => true)
  ) {
    await page.locator(DOCK.toggle).uncheck();
  }
  await page.locator(DOCK.closeSettings).click();
  await expect(page.locator(DOCK.workspace)).toHaveCount(0, { timeout: 10000 });
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-dialog')).toBeVisible({ timeout: 10000 });
  assert.equal(
    await page.evaluate(() => document.getElementById('settings-dialog').matches(':modal')),
    true,
    'Classic settings must be modal',
  );
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.locator('#settings-dialog')).toBeVisible({ timeout: 10000 });
  assert.equal(
    await page.evaluate(() => document.getElementById('settings-dialog').matches(':modal')),
    true,
    'Narrow crossing must preserve the usable classic modal',
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(page.locator('#settings-dialog')).toBeVisible({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden({ timeout: 10000 });
  step('Classic settings open across viewport crossings stays a usable modal.');
  // Docked prefs across the same crossing: silent close, clean restore.
  await openLayoutDialog(page);
  await page.locator(DOCK.toggle).check();
  await page.locator(DOCK.closeSettings).click();
  await expect(page.locator(DOCK.workspace)).toBeVisible({ timeout: 10000 });
  const prefsGroup2 = (await layoutSignature(page)).groups[0].id;
  await page.locator(`[data-dock-group="${prefsGroup2}"]`).locator(DOCK.ellipsis).click();
  await expect(page.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
  await page.locator(DOCK.contextMenu).locator('[aria-haspopup="menu"]').click();
  await page.locator(`${DOCK.addOption}[data-dock-add="preferences"]`).click();
  await expect(page.locator('button[data-dock-tab="preferences"]')).toBeAttached({ timeout: 10000 });
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.locator(DOCK.workspace)).toHaveCount(0, { timeout: 10000 });
  assert.equal(
    await page.evaluate(() => document.querySelectorAll('dialog:modal').length),
    0,
    'Dock-off crossing must leave no modal trap',
  );
  assert.equal(
    await page.evaluate(() => document.body.inert),
    false,
    'Dock-off crossing must leave no inert page',
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(page.locator(DOCK.workspace)).toBeVisible({ timeout: 10000 });
  assert.equal(errors.length, 0, 'Viewport crossings raise zero page errors');
  step('Docked Preferences across viewport crossings closes silently and restores cleanly.');

  // ------------------------------------------------ Phase 18: project round-trip keeps context + send binding.
  proofPhase = 'project-roundtrip';
  if (!RUN_DEEP) {
    note('DEFERRED until composer M2 stable: project-roundtrip');
    deferred.push('project-roundtrip');
  } else {
    // Focus-driven round-trip: sidebar clicks focus owners; context and
    // send binding are verified against live reads (detail + focused messages),
    // never pinned sessions.
    async function focusedViewId(page) {
      const marked = await page.evaluate(() =>
        [...document.querySelectorAll('.dock-tab.is-conversation.is-focused')].map(
          (el) => el.dataset.dockTab,
        ),
      );
      assert.equal(marked.length, 1, 'Exactly one conversation holds focus');
      return marked[0];
    }
    await page
      .locator('#project-list .project-row')
      .filter({ hasText: 'Atelier' })
      .click()
      .catch(() => {});
    await page.locator('#session-list .session-select').filter({ hasText: 'Calibrer la sortie' }).click();
    const roundTripA = await page.locator('#detail-session-id').textContent();
    assert.ok(roundTripA && roundTripA.trim(), 'Reopened Atelier session shows in the inspector');
    await page.locator('#project-list .project-row').filter({ hasText: 'Vtrott' }).click();
    await page.locator('#session-list .session-select').filter({ hasText: 'migration du volant' }).click();
    const roundTripG = await page.locator('#detail-session-id').textContent();
    assert.ok(
      roundTripG && roundTripG.trim() && roundTripG.trim() !== roundTripA.trim(),
      'Vtrott session takes over context',
    );
    let roundTripView = await focusedViewId(page);
    await focusConvTab(page, roundTripView);
    await expect
      .poll(() => viewMessagesText(page, roundTripView), { timeout: 10000 })
      .toContain('Planifier la migration');
    await page.locator('#project-list .project-row').filter({ hasText: 'Atelier' }).click();
    await page.locator('#session-list .session-select').filter({ hasText: 'Calibrer la sortie' }).click();
    const roundTripA2 = await page.locator('#detail-session-id').textContent();
    assert.equal(roundTripA2.trim(), roundTripA.trim(), 'Prior session reopens with identical context');
    const roundTripA2Id = roundTripA2.trim().replace(/^ID\s+/, '');
    roundTripView = await focusedViewId(page);
    await focusConvTab(page, roundTripView);
    await expect
      .poll(() => viewMessagesText(page, roundTripView), { timeout: 10000 })
      .toContain('Synthèse disponible');
    await vFill(page, roundTripView, 'Envoi après aller-retour projet');
    const roundStarts = starts.length;
    await vSend(page, roundTripView).click();
    await expect.poll(() => Promise.resolve(starts.length), { timeout: 10000 }).toBe(roundStarts + 1);
    const roundControl = activeControls[activeControls.length - 1];
    assert.equal(
      roundControl.record.sessionId,
      roundTripA2Id,
      'Post-round-trip send binds the reopened session',
    );
    await roundControl.finish('completed');
    await expect(vStop(page, roundTripView)).toBeHidden({ timeout: 15000 });
    step('Project round-trip reopens the prior session with correct context and send binding.');
  }
  // ------------------------------------------------ Phase 19: authenticated read-only (drafts preserved, minimal).
  proofPhase = 'readonly';
  const roStartsBefore = starts.length;
  const roSalt = 'f'.repeat(32);
  const roCode = '24681357';
  const roGateway = createLanGateway({
    host: '127.0.0.1',
    upstreamPort: app.server.address().port,
    config: { salt: roSalt, codeHash: hashAccessCode(roCode, roSalt), readOnly: true },
  });
  await new Promise((done) => roGateway.listen(0, '127.0.0.1', done));
  try {
    const roUrl = `http://127.0.0.1:${roGateway.address().port}`;
    const roContext = await browser.newContext({
      locale: 'fr-FR',
      viewport: { width: 1600, height: 1000 },
      reducedMotion: 'reduce',
    });
    await roContext.addInitScript(() => {
      localStorage.setItem('prime-studio.drafts', JSON.stringify({ 'conv:pinned': 'NE-PAS-EFFACER' }));
    });
    await seedSelection(roContext, { cwd: cwdA, sessionId: 'ws-alpha', projectOverview: false });
    const roPage = await roContext.newPage();
    roPage.setDefaultTimeout(15000);
    roPage.on('pageerror', (error) =>
      errors.push(String(error?.stack || error?.message || error).slice(0, 1200)),
    );
    await roPage.goto(roUrl);
    await roPage.locator('#code, input[name="code"]').first().fill(roCode);
    const roSubmit = roPage.locator('button[type="submit"]');
    if ((await roSubmit.count()) > 0) await roSubmit.first().click();
    else await roPage.getByRole('button', { name: /ouvrir/i }).click();
    await expect(roPage.locator('#connection-label')).toContainText('connecté', { timeout: 20000 });
    await expect(roPage.locator('#composer')).toBeDisabled({ timeout: 10000 });
    const roDraftsBefore = (await storageEnvelope(roPage, DRAFTS_KEY))?.parsed;
    await roPage
      .locator('#session-list .session-select')
      .filter({ hasText: 'Préparer la distribution' })
      .click();
    await expect(roPage.locator('#messages')).toContainText('Préparer la distribution', { timeout: 10000 });
    // Project switch without selecting the drop target session: clicking
    // ws-gamma here would bind it to primary, and the drop below must prove
    // creation (not dedupe) for an unowned session.
    await roPage.locator('#project-list .project-row').filter({ hasText: 'Vtrott' }).click();
    await expect(roPage.locator('#project-list .project-row').filter({ hasText: 'Vtrott' })).toBeVisible({
      timeout: 10000,
    });
    const roDraftsAfter = (await storageEnvelope(roPage, DRAFTS_KEY))?.parsed;
    assert.deepEqual(roDraftsAfter, roDraftsBefore, 'Read-only switching must NOT clear any persisted draft');
    await expect(roPage.locator('#composer')).toBeDisabled();
    await roPage.locator(DOCK.openButton).click();
    await expect(roPage.locator(DOCK.dialog)).toBeVisible({ timeout: 10000 });
    await roPage.locator(DOCK.toggle).check();
    await expect(roPage.locator(DOCK.workspace)).toBeVisible({ timeout: 10000 });
    await expect(roPage.locator('#composer')).toBeDisabled();
    await roPage.locator(DOCK.closeSettings).click();
    // Read-only chooser: new-empty is disabled, existing sessions still pickable.
    const roGroup = (await layoutSignature(roPage)).groups[0].id;
    await roPage.locator(`[data-dock-group="${roGroup}"]`).locator(DOCK.ellipsis).click();
    await expect(roPage.locator(DOCK.contextMenu)).toBeVisible({ timeout: 10000 });
    await roPage.locator(DOCK.contextMenu).locator('[aria-haspopup="menu"]').click();
    await roPage.locator(`${DOCK.addOption}[data-dock-add="new-conversation"]`).click();
    await expect(roPage.locator(DOCK.picker)).toBeVisible({ timeout: 10000 });
    await pickProject(roPage, 'Atelier');
    assert.equal(
      await roPage.locator(DOCK.pickerNew).isDisabled(),
      true,
      'Read-only disables chooser new-empty',
    );
    await roPage.keyboard.press('Escape');
    await expect(roPage.locator(DOCK.picker)).toBeHidden({ timeout: 10000 });
    // Read-only pointer drop: validated payload opens the tab with no server
    // reorder (order API untouched) and zero runs. Handles are hidden in
    // read-only, so the gesture starts from the session-select button.
    const roOrderBefore = await sidebarOrder(roPage);
    const roTabsBefore = await convTabIds(roPage);
    const roGammaBox = await roPage
      .locator('.session-row[data-session-id="ws-gamma"] .session-select')
      .boundingBox();
    const roGroups = await layoutSignature(roPage);
    const roBar = await roPage
      .locator(`[data-dock-group="${roGroups.groups[0].id}"] .dock-tabs`)
      .boundingBox();
    await pointerDrag(roPage, roGammaBox, { x: roBar.x + roBar.width / 2, y: roBar.y + roBar.height / 2 });
    await expect
      .poll(() => convTabIds(roPage).then((tabs) => tabs.length), { timeout: 15000 })
      .toBe(roTabsBefore.length + 1);
    await expect(roPage.locator('#detail-session-id')).toContainText('ws-gamma', { timeout: 10000 });
    assert.deepEqual(await sidebarOrder(roPage), roOrderBefore, 'Read-only drop performs no server reorder');
    assert.deepEqual(
      (await storageEnvelope(roPage, DRAFTS_KEY))?.parsed,
      roDraftsAfter,
      'Read-only drop preserves drafts',
    );
    assert.equal(starts.length, roStartsBefore, 'Read-only flows start zero runs anywhere');
    step(
      'Read-only switching preserves every persisted draft; chooser new-empty disabled; pointer drop opens with no reorder.',
    );
    await roContext.close();
  } finally {
    roGateway.closeAllConnections();
    await new Promise((done) => roGateway.close(done));
  }

  // ------------------------------------------------ Phase 20: responsive gate, mobile, classic opt-out, finish.
  proofPhase = 'responsive-finish';
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.locator(DOCK.workspace)).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator('.workspace-body > .conversation-column')).toBeVisible({ timeout: 10000 });
  step('At 800px the dock gates off and classic nodes return.');
  const mobileContext = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  await seedSelection(mobileContext, { cwd: cwdA, sessionId: 'ws-alpha', projectOverview: false });
  const mobile = await mobileContext.newPage();
  mobile.setDefaultTimeout(15000);
  mobile.on('pageerror', (error) =>
    errors.push(String(error?.stack || error?.message || error).slice(0, 1200)),
  );
  await mobile.goto(url);
  await expect(mobile.locator('#connection-label')).toContainText('connecté', { timeout: 20000 });
  assert.equal(await mobile.locator(DOCK.workspace).count(), 0, 'No dock workspace may exist at 390px');
  await mobile
    .locator('#toggle-sidebar')
    .click()
    .catch(() => {});
  await mobile.locator('#session-list .session-select').filter({ hasText: 'Calibrer la sortie' }).click();
  await expect(mobile.locator('#messages')).toContainText('Synthèse disponible', { timeout: 10000 });
  assert.equal(
    await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
    false,
    'Mobile must not overflow horizontally',
  );
  await mobile.screenshot({ path: await freshShot(SHOTS.mobileOff), animations: 'disabled' });
  await mobileContext.close();
  step('At 390px docking stays off, conversation works, no overflow, zero errors.');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(page.locator(DOCK.workspace)).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: await freshShot(SHOTS.rearranged), animations: 'disabled' });
  // Classic opt-out restores the SAME actual host nodes.
  const refStateFinal = await snapshotRefs(page);
  await openLayoutDialog(page);
  await page.locator(DOCK.toggle).uncheck();
  await expect(page.locator(DOCK.workspace)).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator('.workspace-body > .conversation-column')).toBeVisible({ timeout: 10000 });
  await expectRefsStable(page, refStateFinal, 'classic-optout');
  step('Classic opt-out restores the SAME actual host nodes (moved home, never rebuilt).');
  // Finish: every held run completes exactly once; nothing restarted, nothing cancelled.
  for (const control of activeControls) {
    await control.done.catch(() => {}).then(() => {});
  }
  assert.equal(cancellations, 0, 'No flow in this test may cancel a run');
  assert.deepEqual(errors, [], `No page errors expected, got ${JSON.stringify(errors)}`);
  if (!RUN_DEEP) note('Deep composer chain deferred (DOCKR2_DEEP unset, composer M2 pending).');
  step(
    `Smoke complete: ${starts.length} stub starts, 0 cancels, 0 page errors` +
      (deferred.length ? `, deferred: ${deferred.join(', ')}` : ', nothing deferred') +
      '.',
  );
  proofPhase = 'done';
  await writeProof({ status: deferred.length ? 'partial' : 'pass' });
} catch (error) {
  if (error instanceof FastDone) {
    console.log(`ok - M2 fast path complete (${error.message}).`);
  } else {
    try {
      await page?.screenshot({ path: join(OUT_ROOT, 'dockr2-failure.png') }).catch(() => {});
    } catch {}
    if (!proofWritten) {
      try {
        await writeProof({
          status: proofPhase === 'done' || RUN_DEEP ? 'failed' : 'blocked',
          failure: String(error?.message || error).slice(0, 2000),
        });
      } catch {}
    }
    throw error;
  }
} finally {
  await browser.close();
  await app.close();
  assert.equal(dirname(temp), resolve(tmpdir()));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
