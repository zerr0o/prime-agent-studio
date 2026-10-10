// Focused mobile regression: Studio conversation header + composer on narrow screens.
// Isolated fixture: synthetic session, stub runtime, no providers or model calls.
// Run: node scripts/test-mobile-header-composer-ui.mjs [--tag=r1] (--tag=before|after keep legacy names)
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server.mjs';

const tagArg = process.argv.find((item) => item.startsWith('--tag='));
const tag = ((tagArg ? tagArg.slice(6) : 'current') || 'current').replace(/[^a-z0-9-]+/gi, '') || 'current';
const shot = (name) => resolve('.local', `mobile-header-composer-${name}.png`);
// Revision names keep original before* and previous review captures untouched.
const shotFile = (kind) => {
  if (tag !== 'before' && tag !== 'after')
    return shot(
      `${tag}-${{ empty: '390-empty', draft: '390-draft', narrow: '320', desktop: 'desktop', en: '390-en', details: '390-details', detailsNarrow: '320-details' }[kind] || kind}`,
    );
  if (kind === 'empty') return shot(tag);
  if (kind === 'narrow' || kind === 'desktop') return shot(kind);
  return shot(`${tag}-${kind}`);
};

// Deterministic Computer Use fixture mock (GET only; hardware untouched).
// The module's own refresh()/update() loop re-applies this state every poll,
// so measured bounds and screenshots observe the exact same state.
let cuActive = false;
async function installComputerStub(page) {
  await page.route('**/api/computer-use*', (route) => {
    if (route.request().method() !== 'GET' || !cuActive) return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        supported: true,
        enabled: true,
        busy: true,
        owner: { sessionId },
        backend: 'native',
        lastAction: null,
        lastFrame: null,
      }),
    });
  });
}

const temp = await mkdtemp(join(tmpdir(), 'prime-studio-mobile-header-'));
const cwd = join(temp, 'Atelier');
const sessionDir = join(temp, 'sessions');
await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
const sessionId = 'mobile-header-fixture';
const sessionFile = join(sessionDir, 'mobile-header.jsonl');
await writeFile(
  sessionFile,
  [
    { type: 'session', id: sessionId, cwd, version: 3, timestamp: new Date().toISOString() },
    {
      type: 'message',
      id: 'u1',
      parentId: null,
      message: { role: 'user', content: 'Conversation mobile de demonstration' },
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Reponse synthetique.' }] },
    },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);

const controls = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/gpt-6-astra', name: 'GPT-6 Astra', provider: 'fixture', reasoning: true }],
    default: { model: 'fixture/gpt-6-astra', thinking: 'max' },
  }),
  async start(input) {
    const serial = controls.length + 1;
    const file = input.sessionFile || sessionFile;
    const raw = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    let parentId = raw.findLast((entry) => entry.type === 'message').id;
    const userId = `live-user-${serial}`;
    await appendFile(
      file,
      JSON.stringify({
        type: 'message',
        id: userId,
        parentId,
        message: { role: 'user', content: input.message },
      }) + '\n',
    );
    parentId = userId;
    let resolveDone,
      finished = false;
    const done = new Promise((resolveCompletion) => {
      resolveDone = resolveCompletion;
    });
    const control = {
      sessionId,
      done,
      emit(event) {
        if (!finished) input.onEvent(event);
      },
      async finish(status = 'completed') {
        if (finished) return done;
        finished = true;
        if (status === 'completed') {
          await appendFile(
            file,
            JSON.stringify({
              type: 'message',
              id: `live-final-${serial}`,
              parentId,
              message: { role: 'assistant', content: [{ type: 'text', text: 'Tour simule termine.' }] },
            }) + '\n',
          );
          input.onEvent({
            kind: 'message',
            message: { role: 'assistant', text: 'Tour simule termine.', tools: [] },
          });
        }
        const result = { kind: 'done', sessionId, status, code: status === 'completed' ? 0 : 130 };
        input.onEvent(result);
        resolveDone(result);
        return result;
      },
      cancel() {
        return control.finish('stopped');
      },
    };
    controls.push(control);
    setTimeout(() => control.emit({ kind: 'session', sessionId, cwd: input.cwd }), 20);
    return control;
  },
  async close() {
    await Promise.all(controls.map((control) => control.finish('stopped')));
  },
};

const app = createApp({ runtime, sessionDir, dataDir: join(temp, 'data'), initialCwd: cwd });
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
const checks = [];
const measurements = [];
const failures = [];
let browser;
async function check(label, fn) {
  try {
    await fn();
    checks.push(label);
  } catch (error) {
    failures.push(`${label} :: ${error.message}`);
  }
}
const pages = [];

async function crowdHeader(page) {
  await page.evaluate(() => {
    const progress = document.getElementById('roadmap-progress');
    if (progress) {
      progress.hidden = false;
      progress.textContent = '85%';
    }
  });
}

async function snapshot(page, label) {
  await crowdHeader(page);
  return page
    .evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      };
      const styleOf = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const style = getComputedStyle(node);
        return {
          height: node.getBoundingClientRect().height,
          radius: style.borderTopLeftRadius,
          minHeight: style.minHeight,
        };
      };
      const textarea = document.getElementById('composer');
      const placeholder = textarea?.placeholder || '';
      let placeholderLinesHeight = 0;
      if (textarea) {
        const mirror = document.createElement('div');
        const style = getComputedStyle(textarea);
        const width = textarea.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        Object.assign(mirror.style, {
          position: 'absolute',
          visibility: 'hidden',
          pointerEvents: 'none',
          width: `${Math.max(40, width)}px`,
          font: style.font,
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          padding: '0',
          border: '0',
        });
        mirror.textContent = placeholder;
        document.body.append(mirror);
        placeholderLinesHeight = mirror.scrollHeight;
        mirror.remove();
      }
      return {
        viewport: window.innerWidth,
        viewportHeight: window.innerHeight,
        headerInert: document.querySelector('.workspace-header')?.inert,
        detailsRole: document.getElementById('details-panel')?.getAttribute('role'),
        detailsModal: document.getElementById('details-panel')?.getAttribute('aria-modal'),
        scrollWidth: document.documentElement.scrollWidth,
        header: rect('.workspace-header'),
        headerActions: rect('.header-actions'),
        controls: {
          roadmap: styleOf('#open-roadmap'),
          computer: styleOf('#computer-use-toggle'),
          menu: styleOf('#session-menu-button'),
          details: styleOf('#toggle-details'),
        },
        textarea: rect('#composer'),
        textareaClientHeight: textarea?.clientHeight || 0,
        textareaScrollHeight: textarea?.scrollHeight || 0,
        placeholder,
        placeholderLinesHeight,
        toolbar: rect('#composer-form .composer-toolbar'),
        toolbarScrollWidth: document.querySelector('#composer-form .composer-toolbar')?.scrollWidth || 0,
        toolbarClientWidth: document.querySelector('#composer-form .composer-toolbar')?.clientWidth || 0,
        model: rect('#model-picker-button'),
        thinking: rect('#thinking-select'),
        attachments: rect('.attachment-controls'),
        liveMode: document.getElementById('live-mode-row')?.hidden === false ? rect('#live-mode-row') : null,
        liveModeScrollWidth: document.getElementById('live-mode-row')?.scrollWidth || 0,
        stopVisible: document.getElementById('computer-use-stop')?.hidden === false,
        details: document.getElementById('details-panel')?.classList.contains('mobile-open')
          ? rect('#details-panel')
          : null,
        progressVisible: document.getElementById('roadmap-progress')?.hidden === false,
        actionTops: [
          '#computer-use-toggle',
          '#computer-use-stop',
          '#open-roadmap',
          '#session-menu-button',
          '#toggle-details',
        ]
          .map((selector) => document.querySelector(selector))
          .filter((node) => node && !node.hidden && node.getBoundingClientRect().width > 0)
          .map((node) => Math.round(node.getBoundingClientRect().top)),
      };
    })
    .then((data) => ({ label, ...data }));
}

function assertNoPageOverflow(snap) {
  assert.ok(
    snap.scrollWidth <= snap.viewport + 1,
    `${snap.label}: page overflows (${snap.scrollWidth} > ${snap.viewport})`,
  );
}

function assertHeaderFits(snap) {
  assert.ok(snap.headerActions, `${snap.label}: header actions missing`);
  assert.ok(
    snap.headerActions.right <= snap.viewport + 1,
    `${snap.label}: header spills past right edge (${snap.headerActions.right} > ${snap.viewport})`,
  );
  assert.ok(snap.headerActions.left >= -1, `${snap.label}: header starts off screen`);
}

async function assertHeaderReachable(page, label) {
  const viewport = await page.evaluate(() => window.innerWidth);
  const sidebarHidden = await page.locator('#toggle-sidebar').isHidden();
  assert.equal(sidebarHidden, viewport > 760, `${label}: sidebar toggle visibility wrong at ${viewport}px`);
  for (const selector of [
    '#computer-use-toggle',
    '#open-roadmap',
    '#session-menu-button',
    '#toggle-details',
  ]) {
    const box = await page.locator(selector).evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height, right: rect.right, left: rect.left };
    });
    assert.ok(box.width > 0 && box.height > 0, `${label}: ${selector} has no size`);
    assert.ok(box.left >= -1, `${label}: ${selector} off left edge`);
    assert.ok(box.right <= viewport + 1, `${label}: ${selector} past right edge`);
  }
  const disabled = await page.evaluate(() => ({
    roadmap: document.getElementById('open-roadmap')?.disabled,
    menu: document.getElementById('session-menu-button')?.disabled,
  }));
  assert.equal(disabled.roadmap, false, `${label}: roadmap must stay enabled`);
  assert.equal(disabled.menu, false, `${label}: session menu must stay enabled`);
}

function assertControlSizing(snap) {
  const heights = Object.values(snap.controls).map((item) => item.height);
  const spread = Math.max(...heights) - Math.min(...heights);
  assert.ok(spread <= 4, `${snap.label}: header control heights differ by ${spread.toFixed(1)}px`);
  const radii = new Set(Object.values(snap.controls).map((item) => item.radius));
  assert.equal(radii.size, 1, `${snap.label}: header control radii differ (${[...radii].join(', ')})`);
}

function assertNoInnerScroll(snap) {
  assert.ok(
    snap.textareaScrollHeight <= snap.textareaClientHeight + 1,
    `${snap.label}: textarea clips internally (scroll ${snap.textareaScrollHeight} > box ${snap.textareaClientHeight})`,
  );
}

function assertActionsSingleRow(snap) {
  assert.ok(snap.actionTops.length >= 4, `${snap.label}: expected visible header actions`);
  const spread = Math.max(...snap.actionTops) - Math.min(...snap.actionTops);
  assert.ok(
    spread <= 6,
    `${snap.label}: header actions wrap to a second row (tops ${snap.actionTops.join(',')})`,
  );
}

async function assertPermissionLabels(page, label, narrow) {
  const state = await page.evaluate(() => {
    const visible = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 ? node.textContent.trim() : null;
    };
    return {
      full: [visible('#allow-questions + .toggle-full'), visible('#allow-computer-use + .toggle-full')],
      short: [visible('#allow-questions ~ .toggle-short'), visible('#allow-computer-use ~ .toggle-short')],
      aria: [
        document.getElementById('allow-questions')?.getAttribute('aria-label'),
        document.getElementById('allow-computer-use')?.getAttribute('aria-label'),
      ],
    };
  });
  assert.deepEqual(
    state.aria,
    ['Autoriser les questions', 'Autoriser le Computer Use'],
    `${label}: full accessible names lost`,
  );
  if (narrow) {
    assert.deepEqual(state.full, [null, null], `${label}: full labels should hide on narrow`);
    assert.ok(state.short[0]?.length > 0 && state.short[1]?.length > 0, `${label}: short labels missing`);
  } else {
    assert.deepEqual(state.short, [null, null], `${label}: short labels should hide on desktop`);
    assert.ok(state.full[0]?.length > 0 && state.full[1]?.length > 0, `${label}: full labels missing`);
  }
  return state;
}

function assertDetailsModal(snap) {
  assert.ok(snap.details, `${snap.label}: details panel did not open`);
  assert.ok(snap.details.top <= snap.header.top + 1, `${snap.label}: inert header exposed above modal`);
  assert.ok(snap.details.bottom >= snap.viewportHeight - 1, `${snap.label}: modal does not cover viewport`);
  assert.ok(snap.details.right <= snap.viewport + 1, `${snap.label}: details panel overflows`);
  assert.equal(snap.detailsRole, 'dialog', `${snap.label}: modal role missing`);
  assert.equal(snap.detailsModal, 'true', `${snap.label}: aria-modal missing`);
  assert.equal(snap.headerInert, true, `${snap.label}: background must stay inert`);
}

function assertStableShot(before, after) {
  assert.equal(
    after.header.height,
    before.header.height,
    `screenshot state drifted (header ${before.header.height} -> ${after.header.height})`,
  );
  assert.equal(
    after.headerActions.right,
    before.headerActions.right,
    'screenshot state drifted (actions edge)',
  );
  assert.equal(after.stopVisible, before.stopVisible, 'screenshot state drifted (CU stop visibility)');
}

async function stableShot(page, kind, label) {
  const before = await snapshot(page, `${label}-pre`);
  measurements.push(before);
  await page.screenshot({ path: shotFile(kind), animations: 'disabled' });
  const after = await snapshot(page, `${label}-post`);
  measurements.push(after);
  assertStableShot(before, after);
  return after;
}

function assertPlaceholderReadable(snap) {
  assert.ok(snap.placeholder.length > 0, `${snap.label}: placeholder empty`);
  assert.ok(
    snap.textareaClientHeight + 2 >= snap.placeholderLinesHeight,
    `${snap.label}: placeholder cut off (box ${snap.textareaClientHeight}px < text ${snap.placeholderLinesHeight}px)`,
  );
}

function assertToolbarFits(snap) {
  assert.ok(snap.toolbarScrollWidth <= snap.toolbarClientWidth + 1, `${snap.label}: toolbar overflows`);
  for (const [name, box] of [
    ['model', snap.model],
    ['thinking', snap.thinking],
  ]) {
    assert.ok(box && box.right <= snap.viewport + 1, `${snap.label}: ${name} past right edge`);
  }
  if (snap.liveMode) {
    assert.ok(snap.liveMode.right <= snap.viewport + 1, `${snap.label}: live mode row past right edge`);
    assert.ok(snap.liveModeScrollWidth <= snap.liveMode.width + 1, `${snap.label}: live mode row overflows`);
  }
}

try {
  browser = await launchStudioBrowser({ headless: true });
  const page = await browser.newPage({
    locale: 'fr-FR',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  pages.push(page);
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText('connect');
  await page.locator('#toggle-sidebar').click();
  await page
    .locator('#session-list')
    .getByText('Conversation mobile de demonstration', { exact: true })
    .click();
  await expect(page.locator('#messages')).toContainText('Reponse synthetique.');
  await expect(page.locator('#open-roadmap')).toBeEnabled();
  await expect(page.locator('#session-menu-button')).toBeEnabled();

  await installComputerStub(page);
  let snap = await snapshot(page, 'idle-off-390-fr');
  measurements.push(snap);
  await check('Repos 390 FR CU off : page sans debordement', () => assertNoPageOverflow(snap));
  await check('Repos 390 FR CU off : en-tete sans debordement', () => assertHeaderFits(snap));
  await check('Repos 390 FR CU off : actions joignables et actives', () =>
    assertHeaderReachable(page, 'idle-off-390-fr'),
  );
  await check('Repos 390 FR CU off : gabarits de controles coherents', () => assertControlSizing(snap));
  await check('Repos 390 FR CU off : actions sur une seule ligne', () => assertActionsSingleRow(snap));
  await check('Repos 390 FR CU off : libelles courts, noms complets conserves', () =>
    assertPermissionLabels(page, 'idle-off-390-fr', true),
  );
  await check('Repos 390 FR CU off : aucun scroll interne', () => assertNoInnerScroll(snap));
  await check('Repos 390 FR CU off : barre composer sans debordement', () => assertToolbarFits(snap));
  assert.equal(snap.stopVisible, false, 'idle-off-390-fr: CU stop should stay hidden');

  cuActive = true;
  await page.locator('#composer').fill('Demarre un tour simule.');
  await page.locator('#send-button').click();
  await expect(page.locator('#stop-button')).toBeVisible();
  await expect(page.locator('#computer-use-stop')).toBeVisible();
  await expect(page.locator('#messages')).toContainText('Demarre un tour simule.');
  snap = await snapshot(page, 'running-empty-390-fr');
  measurements.push(snap);
  assert.ok(
    snap.placeholder.startsWith('Pr\u00e9parez'),
    `running FR placeholder unexpected: ${snap.placeholder}`,
  );
  assert.equal(snap.stopVisible, true, 'running-empty-390-fr: CU stop should show through module logic');
  assert.equal(snap.progressVisible, true, 'running-empty-390-fr: roadmap 85% should show');
  await check('Tour actif 390 FR CU on : page sans debordement', () => assertNoPageOverflow(snap));
  await check('Tour actif 390 FR CU on : en-tete sans debordement', () => assertHeaderFits(snap));
  await check('Tour actif 390 FR CU on : actions sur une seule ligne', () => assertActionsSingleRow(snap));
  await check('Tour actif 390 FR CU on : placeholder long lisible en entier', () =>
    assertPlaceholderReadable(snap),
  );
  await check('Tour actif 390 FR CU on : aucun scroll interne', () => assertNoInnerScroll(snap));
  await check('Tour actif 390 FR CU on : libelles courts, noms complets conserves', () =>
    assertPermissionLabels(page, 'running-empty-390-fr', true),
  );
  await check('Tour actif 390 FR CU on : barre sans debordement', () => assertToolbarFits(snap));
  await check('Tour actif 390 FR CU on : capture egale etat mesure', () =>
    stableShot(page, 'empty', 'r1-empty-390-fr'),
  );

  await page.locator('#composer').fill('Suite pendant le tour.');
  await expect(page.locator('#live-mode-row')).toBeVisible();
  snap = await snapshot(page, 'running-draft-390-fr');
  measurements.push(snap);
  await check('Tour actif 390 FR brouillon : page sans debordement', () => assertNoPageOverflow(snap));
  await check('Tour actif 390 FR brouillon : en-tete sans debordement', () => assertHeaderFits(snap));
  await check('Tour actif 390 FR brouillon : actions joignables et actives', () =>
    assertHeaderReachable(page, 'running-draft-390-fr'),
  );
  await check('Tour actif 390 FR brouillon : gabarits de controles coherents', () =>
    assertControlSizing(snap),
  );
  await check('Tour actif 390 FR brouillon : actions sur une seule ligne', () =>
    assertActionsSingleRow(snap),
  );
  await check('Tour actif 390 FR brouillon : barre et puce de mode sans debordement', () =>
    assertToolbarFits(snap),
  );
  await check('Tour actif 390 FR brouillon : libelles courts lisibles en entier', async () => {
    const state = await assertPermissionLabels(page, 'running-draft-390-fr', true);
    assert.ok(
      state.short.every((text) => text && !text.includes('\u2026')),
      'short labels must not ellipsize',
    );
  });
  await check('Tour actif 390 FR brouillon : capture egale etat mesure', () =>
    stableShot(page, 'draft', 'r1-draft-390-fr'),
  );

  await page.locator('#toggle-details').click();
  await expect(page.locator('#details-panel')).toBeVisible();
  snap = await snapshot(page, 'details-open-390-fr');
  measurements.push(snap);
  await check('Panneau details 390 FR : modal plein ecran, commandes inertes non exposees', () =>
    assertDetailsModal(snap),
  );
  await check('Panneau details 390 FR : preuve visuelle', () =>
    stableShot(page, 'details', 'r1-details-390-fr'),
  );
  // While open the panel is modal (header inert by design): close via its own button.
  await page.locator('#close-inspector').click();
  await expect(page.locator('#details-panel')).toBeHidden();
  await check('Panneau details 390 FR : fermeture x restaure les commandes', async () => {
    await expect.poll(() => page.locator('.workspace-header').evaluate((node) => node.inert)).toBe(false);
    await assertHeaderReachable(page, 'details-closed-390-fr');
  });

  const emptyHeight = (await snapshot(page, 'empty-ref-390-fr')).textareaClientHeight;
  await page.locator('#composer').fill('Ligne une\nLigne deux\nLigne trois du brouillon utilisateur.');
  snap = await snapshot(page, 'multiline-390-fr');
  measurements.push(snap);
  await check('Texte multiligne 390 FR : zone grandit et rien de tronque', () => {
    assert.ok(snap.textareaClientHeight > emptyHeight + 20, 'multiline draft did not grow');
    assert.ok(snap.textareaScrollHeight <= snap.textareaClientHeight + 4, 'multiline text cut off');
  });
  await check('Texte multiligne 390 FR : aucun scroll interne parasite', () => assertNoInnerScroll(snap));
  await check('Texte multiligne 390 FR : page sans debordement', () => assertNoPageOverflow(snap));
  await page.locator('#composer').fill('Suite pendant le tour.');

  await page.setViewportSize({ width: 320, height: 568 });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(320);
  snap = await snapshot(page, 'running-draft-320-fr');
  measurements.push(snap);
  assert.equal(snap.stopVisible, true, 'running-draft-320-fr: CU stop should show through module logic');
  await check('Tour actif 320 FR : page sans debordement', () => assertNoPageOverflow(snap));
  await check('Tour actif 320 FR : en-tete sans debordement', () => assertHeaderFits(snap));
  await check('Tour actif 320 FR : actions joignables et actives', () =>
    assertHeaderReachable(page, 'running-draft-320-fr'),
  );
  await check('Tour actif 320 FR : gabarits de controles coherents', () => assertControlSizing(snap));
  await check('Tour actif 320 FR : actions sur une seule ligne', () => assertActionsSingleRow(snap));
  await check('Tour actif 320 FR : barre et puce de mode sans debordement', () => assertToolbarFits(snap));
  await check('Tour actif 320 FR : placeholder lisible', () => assertPlaceholderReadable(snap));
  await check('Tour actif 320 FR : aucun scroll interne', () => assertNoInnerScroll(snap));
  await check('Tour actif 320 FR : capture egale etat mesure', () =>
    stableShot(page, 'narrow', 'r1-narrow-320-fr'),
  );

  await page.locator('#toggle-details').click();
  await expect(page.locator('#details-panel')).toBeVisible();
  snap = await snapshot(page, 'details-open-320-fr');
  measurements.push(snap);
  await check('Panneau details 320 FR : modal plein ecran, commandes inertes non exposees', () =>
    assertDetailsModal(snap),
  );
  await check('Panneau details 320 FR : preuve visuelle', () =>
    stableShot(page, 'detailsNarrow', `${tag}-details-320-fr`),
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('#details-panel')).toBeHidden();
  await check('Panneau details 320 FR : fermeture Escape restaure les commandes', async () => {
    await expect.poll(() => page.locator('.workspace-header').evaluate((node) => node.inert)).toBe(false);
    await assertHeaderReachable(page, 'details-closed-320-fr');
  });

  await controls[0].finish();
  await expect(page.locator('#stop-button')).toBeHidden();
  cuActive = false;
  await page.reload();
  await expect(page.locator('#messages')).toContainText('Reponse synthetique.');
  snap = await snapshot(page, 'idle-off-320-fr');
  measurements.push(snap);
  assert.equal(snap.stopVisible, false, 'idle-off-320-fr: CU stop should stay hidden');
  await check('Repos 320 FR CU off : page sans debordement', () => assertNoPageOverflow(snap));
  await check('Repos 320 FR CU off : en-tete sans debordement', () => assertHeaderFits(snap));
  await check('Repos 320 FR CU off : actions sur une seule ligne', () => assertActionsSingleRow(snap));
  await check('Repos 320 FR CU off : aucun scroll interne', () => assertNoInnerScroll(snap));

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440);
  await page.locator('#composer').fill('');
  snap = await snapshot(page, 'idle-1440-fr');
  measurements.push(snap);
  await check('Bureau 1440 FR : page sans debordement', () => assertNoPageOverflow(snap));
  await check('Bureau 1440 FR : en-tete sans debordement', () => assertHeaderFits(snap));
  await check('Bureau 1440 FR : actions joignables et actives', () =>
    assertHeaderReachable(page, 'idle-1440-fr'),
  );
  await check('Bureau 1440 FR : libelles complets d origine', () =>
    assertPermissionLabels(page, 'idle-1440-fr', false),
  );
  await check('Bureau 1440 FR : barre sans debordement', () => assertToolbarFits(snap));
  await check('Bureau 1440 FR : capture egale etat mesure', () =>
    stableShot(page, 'desktop', 'r1-desktop-1440-fr'),
  );

  const english = await browser.newPage({
    locale: 'en-US',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  pages.push(english);
  english.setDefaultTimeout(15000);
  english.on('pageerror', (error) => errors.push(error.message));
  await installComputerStub(english);
  cuActive = true;
  await english.goto(url);
  await expect(english.locator('#connection-label')).toContainText('connect');
  await english.locator('#toggle-sidebar').click();
  await english
    .locator('#session-list')
    .getByText('Conversation mobile de demonstration', { exact: true })
    .click();
  await expect(english.locator('#messages')).toContainText('Reponse synthetique.');
  await english.locator('#composer').fill('Start a simulated turn.');
  await english.locator('#send-button').click();
  await expect(english.locator('#stop-button')).toBeVisible();
  await expect(english.locator('#computer-use-stop')).toBeVisible();
  await english.locator('#composer').fill('Follow-up during the turn.');
  await expect(english.locator('#live-mode-row')).toBeVisible();
  snap = await snapshot(english, 'running-draft-390-en');
  measurements.push(snap);
  assert.ok(snap.placeholder.startsWith('Prepare'), `running EN placeholder unexpected: ${snap.placeholder}`);
  assert.equal(snap.stopVisible, true, 'running-draft-390-en: CU stop should show through module logic');
  await check('Tour actif 390 EN : page sans debordement', () => assertNoPageOverflow(snap));
  await check('Tour actif 390 EN : en-tete sans debordement', () => assertHeaderFits(snap));
  await check('Tour actif 390 EN : actions sur une seule ligne', () => assertActionsSingleRow(snap));
  await check('Tour actif 390 EN : placeholder lisible', () => assertPlaceholderReadable(snap));
  await check('Tour actif 390 EN : aucun scroll interne', () => assertNoInnerScroll(snap));
  await check('Tour actif 390 EN : barre sans debordement', () => assertToolbarFits(snap));
  await check('Tour actif 390 EN : capture egale etat mesure', () =>
    stableShot(english, 'en', 'r1-en-390-fr'),
  );
  await controls[1].finish();
  await expect(english.locator('#stop-button')).toBeHidden();

  if (errors.length) failures.push(`page errors: ${errors.join(' | ')}`);
  const passed = failures.length === 0;
  await writeFile(
    resolve('.local', 'mobile-header-composer-proof.json'),
    JSON.stringify({ passed, tag, checks, failures, measurements }, null, 2),
  );
  console.log(JSON.stringify({ passed, tag, checks, failures }, null, 2));
  if (!passed) process.exitCode = 1;
} catch (error) {
  await writeFile(
    resolve('.local', 'mobile-header-composer-proof.json'),
    JSON.stringify(
      {
        passed: false,
        tag,
        checks,
        failures,
        measurements,
        error: String((error && error.message) || error),
      },
      null,
      2,
    ),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
  const cleanupPath = resolve(temp);
  if (!cleanupPath.startsWith(resolve(tmpdir()) + sep)) throw new Error('Refused cleanup outside tmpdir.');
  await rm(cleanupPath, { recursive: true, force: true });
}
