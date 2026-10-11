// Docking drop-preview performance regression (beta.3).
//
// SCOPE: public/docking.js preview path only. This file is the focused
// regression for the beta.3 preview fix; it never edits product sources.
// NEVER: production server, real provider account, real model, Lab, commit,
// build or publish. Fixture is ephemeral (temp dir + loopback) with a stub
// runtime that cannot start agents; the full app boot is aborted and only
// docking.js is imported in the page.
// OWNER: beta.3 preview fix. The docking UI workspace suite belongs to the
// parent and is NOT modified here.
//
// Covers: same-target dragover does not mutate (no hide/remove/reappend/
// retext); a same-frame burst measures once and shows the latest point;
// drop commits from the current event (stale queued point never wins);
// Escape/dragend/cancel leave no resurrected preview. Geometry guards keep
// right-edge zones and tab-insertion placement intact, plus the project
// sidebar pointer preview path (previewConversationDrop/cancel).

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { preferencesFixture } from './preview-preferences.mjs';

const WATCHDOG_MS = 90000;
const OUT = resolve('.local/docking-performance-beta2');
const PROOF_PATH = join(OUT, 'preview-proof.json');
const checks = [];
const errors = [];
let browser;
let fixture;
let page;

async function main() {
  await mkdir(OUT, { recursive: true });
  fixture = await preferencesFixture();
  browser = await launchStudioBrowser();
  page = await browser.newPage({ viewport: { width: 2000, height: 1400 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/public/app.js', (route) => route.abort());
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });

  await page.evaluate(async () => {
    const { createDocking } = await import('/public/docking.js');
    const { createDefaultLayout } = await import('/public/docking-layout.js');
    const roadmap = document.createElement('section');
    roadmap.id = 'roadmap-panel';
    roadmap.textContent = 'Roadmap — isolated preview fixture';
    document.body.append(roadmap);
    const panels = {
      conversation: document.querySelector('.conversation-column'),
      roadmap,
      session: document.getElementById('inspector-session'),
      agents: document.getElementById('inspector-agents'),
      files: document.getElementById('inspector-files'),
      preferences: document.getElementById('settings-dialog'),
    };
    const dock = createDocking({
      panels,
      read: (key, fallback) =>
        key === 'docking.layout' ? { ...createDefaultLayout(), enabled: true } : fallback,
      write: () => true,
      onDropConversation: async () => null,
      onChange: ({ active }) => {
        document.getElementById('details-panel').hidden = active;
      },
    });
    dock.updateViewport();
    assertDockActive(dock);
    function assertDockActive(dock) {
      if (!dock.active) throw new Error('docking did not activate at 2000px viewport');
    }

    // --- instrumentation: measurement + mutation counters -----------------
    let measureCount = 0;
    const nativeRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (...args) {
      measureCount += 1;
      return nativeRect.apply(this, args);
    };
    let mutationCount = 0;
    let lastRecords = [];
    const previewObserver = new MutationObserver((records) => {
      mutationCount += records.length;
      lastRecords = records.slice(-5).map((record) => ({
        type: record.type,
        target:
          record.target === document.getElementById('dock-workspace')
            ? '#dock-workspace'
            : (record.target.className?.baseVal ?? record.target.className ?? record.target.nodeName),
        added: [...record.addedNodes].map((node) => node.className ?? node.nodeName),
        removed: [...record.removedNodes].map((node) => node.className ?? node.nodeName),
        attribute: record.attributeName,
      }));
    });
    previewObserver.observe(document.getElementById('dock-workspace'), {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    const dataTransfer = () => ({
      effectAllowed: 'move',
      dropEffect: 'move',
      setData() {},
      getData() {
        return '';
      },
      clearData() {},
      files: [],
      types: [],
    });
    const groupEl = (id) => document.querySelector(`[data-dock-group="${id}"]`);
    const fireOn = (node, type, x, y) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      event.clientX = x;
      event.clientY = y;
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer() });
      node.dispatchEvent(event);
    };
    const pointIn = (groupId, where) => {
      const group = groupEl(groupId);
      const rect = nativeRect.call(group);
      const bar = nativeRect.call(group.querySelector(':scope > .dock-bar'));
      const midY = bar.bottom + (rect.bottom - bar.bottom) / 2;
      if (where === 'left') return { x: rect.left + 4, y: midY };
      if (where === 'right') return { x: rect.right - 4, y: midY };
      if (where === 'center') return { x: (rect.left + rect.right) / 2, y: midY };
      return { x: (bar.left + bar.right) / 2, y: (bar.top + bar.bottom) / 2 };
    };
    const frames = (n = 2) =>
      new Promise((done) => {
        const step = () => (n <= 1 ? done() : requestAnimationFrame(() => frames(n - 1).then(done)));
        requestAnimationFrame(step);
      });
    const previewEl = () => document.querySelector('.dock-drop-preview');
    const tabEl = () => document.querySelector('.dock-tab-insertion');
    const state = () => {
      const preview = previewEl();
      const tab = tabEl();
      return {
        previewVisible: !!preview && preview.isConnected && !preview.hidden,
        previewZone: preview?.dataset.zone ?? null,
        previewText: preview?.textContent ?? null,
        previewInGroup: preview?.parentElement?.dataset?.dockGroup ?? null,
        tabVisible: !!tab && tab.isConnected && !tab.hidden,
        tabLeft: tab && !tab.hidden ? tab.style.left : null,
        tabInGroup: tab?.parentElement?.dataset?.dockGroup ?? null,
        isDragging: document.getElementById('dock-workspace').classList.contains('is-dragging'),
        measureCount,
        mutationCount,
        lastRecords,
      };
    };

    window.previewFixture = {
      dock,
      frames,
      resetCounters() {
        // Drop synchronously-queued observer batches so the next window only
        // sees records caused by the measured action.
        previewObserver.takeRecords();
        measureCount = 0;
        mutationCount = 0;
        lastRecords = [];
      },
      dragStart(panelId) {
        const tab = document.querySelector(`[data-dock-tab="${panelId}"]`);
        if (!tab) throw new Error(`missing tab ${panelId}`);
        fireOn(tab, 'dragstart', 0, 0);
      },
      dragOver(groupId, where) {
        const point = pointIn(groupId, where);
        fireOn(groupEl(groupId), 'dragover', point.x, point.y);
        return point;
      },
      dragOverBurst(groupId, where, times) {
        const point = pointIn(groupId, where);
        for (let i = 0; i < times; i += 1) fireOn(groupEl(groupId), 'dragover', point.x, point.y);
        return point;
      },
      // Queue a stale point then drop at a live point in the same task, so no
      // rAF can run between them: the commit must use the drop event's point.
      staleQueueThenDrop(staleGroup, staleWhere, dropGroup, dropWhere) {
        const stale = pointIn(staleGroup, staleWhere);
        const live = pointIn(dropGroup, dropWhere);
        fireOn(groupEl(staleGroup), 'dragover', stale.x, stale.y);
        fireOn(groupEl(dropGroup), 'drop', live.x, live.y);
        return { stale, live };
      },
      // Queue a point then cancel in the same task: nothing may appear later.
      queueThenEscape(groupId, where) {
        const point = pointIn(groupId, where);
        fireOn(groupEl(groupId), 'dragover', point.x, point.y);
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
        return point;
      },
      queueThenDragEnd(panelId, groupId, where) {
        const point = pointIn(groupId, where);
        fireOn(groupEl(groupId), 'dragover', point.x, point.y);
        const tab = document.querySelector(`[data-dock-tab="${panelId}"]`);
        fireOn(tab, 'dragend', point.x, point.y);
        return point;
      },
      dragLeave(groupId) {
        fireOn(groupEl(groupId), 'dragleave', 0, 0);
      },
      pointerPreview(groupId, where) {
        const point = pointIn(groupId, where);
        return dock.previewConversationDrop({ clientX: point.x, clientY: point.y });
      },
      cancelPointer() {
        dock.cancelConversationDrop();
      },
      sameNode(kind) {
        const node = kind === 'tab' ? tabEl() : previewEl();
        if (!window.__seen) window.__seen = {};
        if (!window.__seen[kind]) {
          window.__seen[kind] = node;
          return true;
        }
        return window.__seen[kind] === node;
      },
      forgetNodes() {
        window.__seen = {};
      },
      pointIn,
      state,
      layout: () => dock.getLayout(),
    };
  });

  const state = () => page.evaluate(() => window.previewFixture.state());
  const frames = (n) => page.evaluate((count) => window.previewFixture.frames(count), n ?? 2);
  const reset = () => page.evaluate(() => window.previewFixture.resetCounters());

  // --- 1. geometry guards: right zone + tab insertion ----------------------
  await page.evaluate(() => window.previewFixture.dragStart('files'));
  await page.evaluate(() => window.previewFixture.dragOver('conversation-group', 'right'));
  await frames(3);
  {
    const s = await state();
    assert.equal(s.previewVisible, true, 'right-edge dragover shows a preview');
    assert.equal(s.previewZone, 'right', 'right edge keeps zone=right');
    assert.equal(s.previewInGroup, 'conversation-group', 'preview lands in the hovered group');
    checks.push('right-edge zone preview preserved');
  }
  await page.evaluate(() => window.previewFixture.dragOver('tools-group', 'tab'));
  await frames(3);
  {
    const s = await state();
    assert.equal(s.tabVisible, true, 'tab-bar dragover shows the insertion marker');
    assert.equal(s.tabInGroup, 'tools-group', 'insertion marker lands in the hovered group');
    const left = Number.parseFloat(s.tabLeft);
    assert.ok(Number.isFinite(left), 'insertion marker has a tabX position');
    const bounds = await page.evaluate(() => {
      const group = document.querySelector('[data-dock-group="tools-group"]');
      const tabs = group.querySelector('.dock-tabs').getBoundingClientRect();
      const bar = group.getBoundingClientRect();
      return { left: tabs.left - bar.left, right: tabs.right - bar.left, value: 0 };
    });
    assert.ok(left >= bounds.left - 3 && left <= bounds.right + 3, 'insertion tabX stays in tab bounds');
    checks.push('tab-insertion geometry preserved');
  }

  // --- 2. same target does not mutate --------------------------------------
  await page.evaluate(() => window.previewFixture.dragOver('conversation-group', 'right'));
  await frames(3);
  await page.evaluate(() => window.previewFixture.forgetNodes());
  await page.evaluate(() => window.previewFixture.sameNode('preview'));
  await reset();
  await page.evaluate(() => window.previewFixture.dragOverBurst('conversation-group', 'right', 20));
  await frames(3);
  {
    const s = await state();
    assert.equal(s.previewVisible, true, 'preview still shown after same-target burst');
    assert.equal(s.previewZone, 'right', 'zone unchanged after same-target burst');
    assert.equal(s.mutationCount, 0, `same-target burst mutated DOM ${s.mutationCount}x`);
    assert.ok(s.measureCount <= 12, `same-target burst measured ${s.measureCount}x (one rAF run)`);
    const stable = await page.evaluate(() => window.previewFixture.sameNode('preview'));
    assert.equal(stable, true, 'same-target burst keeps the preview node (no remove/reappend)');
    checks.push(`same-target dragover: 0 DOM mutations, ${s.measureCount} measurements for 20 events`);
  }
  await page.evaluate(() => window.previewFixture.dragOver('tools-group', 'tab'));
  await frames(3);
  await page.evaluate(() => window.previewFixture.forgetNodes());
  await page.evaluate(() => window.previewFixture.sameNode('tab'));
  await reset();
  await page.evaluate(() => window.previewFixture.dragOverBurst('tools-group', 'tab', 20));
  await frames(3);
  {
    const s = await state();
    assert.equal(s.tabVisible, true, 'insertion marker still shown after same-target burst');
    assert.equal(s.mutationCount, 0, `same-target tab burst mutated DOM ${s.mutationCount}x`);
    const stable = await page.evaluate(() => window.previewFixture.sameNode('tab'));
    assert.equal(stable, true, 'same-target tab burst keeps the marker node (no style churn)');
    checks.push('same-target tab burst: 0 DOM mutations, marker node stable');
  }

  // --- 3. latest point wins -------------------------------------------------
  await reset();
  await page.evaluate(() => {
    window.previewFixture.dragOver('conversation-group', 'left');
    window.previewFixture.dragOver('conversation-group', 'right');
  });
  await frames(3);
  {
    const s = await state();
    assert.equal(s.previewZone, 'right', 'same-frame burst shows the latest point, not the first');
    assert.ok(s.measureCount <= 12, `two-event burst measured ${s.measureCount}x (coalesced to one run)`);
    checks.push('latest-point-only coalescing across zones');
  }

  // --- 4. drop uses the current event, stale queue never wins ---------------
  await page.evaluate(() =>
    window.previewFixture.staleQueueThenDrop('tools-group', 'tab', 'conversation-group', 'right'),
  );
  await frames(3);
  {
    const s = await state();
    assert.equal(s.previewVisible, false, 'no preview left behind after drop');
    assert.equal(s.tabVisible, false, 'no marker left behind after drop');
    const layout = await page.evaluate(() => window.previewFixture.layout());
    const flat = [];
    const walk = (node) => {
      if (!node) return;
      if (node.kind === 'group') flat.push(node);
      else {
        walk(node.first);
        walk(node.second);
      }
    };
    walk(layout.root);
    const files = flat.find((group) => group.panels.includes('files'));
    assert.ok(files, 'dropped tab lands in a group');
    assert.deepEqual(files.panels, ['files'], 'right-edge drop splits instead of tab-reordering');
    assert.equal(layout.root.first.kind, 'split', 'drop split the conversation leaf');
    assert.deepEqual(layout.root.first.second.panels, ['files'], 'files land on the right side');
    assert.ok(!flat.find((group) => group.id === 'tools-group').panels.includes('files'), 'files left tools');
    await frames(4);
    const later = await state();
    assert.equal(later.previewVisible, false, 'stale rAF never resurrects a preview after drop');
    assert.equal(later.mutationCount, s.mutationCount, 'no post-drop DOM churn from a stale queue');
    checks.push('drop commits from the current event; stale queue cannot resurrect');
  }

  // --- 5. cancel paths leave nothing behind ---------------------------------
  await page.evaluate(() => window.previewFixture.dragStart('session'));
  await page.evaluate(() => window.previewFixture.queueThenEscape('conversation-group', 'left'));
  await frames(4);
  {
    const s = await state();
    assert.equal(s.previewVisible, false, 'Escape hides the preview');
    assert.equal(s.isDragging, false, 'Escape clears the dragging state');
    checks.push('Escape cancels the queued preview with no resurrection');
  }
  await page.evaluate(() => window.previewFixture.dragStart('session'));
  await page.evaluate(() => window.previewFixture.queueThenDragEnd('session', 'conversation-group', 'left'));
  await frames(4);
  {
    const s = await state();
    assert.equal(s.previewVisible, false, 'dragend hides the preview');
    assert.equal(s.isDragging, false, 'dragend clears the dragging state');
    checks.push('dragend cancels the queued preview with no resurrection');
  }
  await page.evaluate(() => window.previewFixture.dragStart('agents'));
  await page.evaluate(() => window.previewFixture.dragOver('conversation-group', 'left'));
  await frames(3);
  assert.equal((await state()).previewZone, 'left', 'preview shown before cancel');
  await page.evaluate(() => window.previewFixture.cancelPointer());
  await frames(3);
  {
    const s = await state();
    assert.equal(s.previewVisible, false, 'cancel clears a shown preview');
    assert.equal(s.isDragging, false, 'cancel clears the dragging state');
    checks.push('cancelConversationDrop clears preview without resurrection');
  }

  // --- 6. project sidebar pointer path stays intact --------------------------
  {
    const shown = await page.evaluate(() => window.previewFixture.pointerPreview('tools-group', 'center'));
    assert.equal(shown, true, 'pointer preview resolves a dock group');
    await frames(2);
    const s = await state();
    assert.equal(s.previewVisible, true, 'pointer preview shows');
    await reset();
    const repeatProbe = await page.evaluate(() => {
      const host = document.getElementById('dock-workspace');
      const hadClass = host.classList.contains('is-dragging');
      const result = window.previewFixture.pointerPreview('tools-group', 'center');
      return { hadClass, result };
    });
    assert.equal(repeatProbe.result, true, 'repeated pointer preview still resolves');
    assert.equal(repeatProbe.hadClass, true, 'repeat runs inside one continuous dragging state');
    await frames(2);
    const repeated = await state();
    assert.equal(
      repeated.mutationCount,
      0,
      `repeated pointer preview at same target does not churn: ${JSON.stringify(repeated.lastRecords)}`,
    );
    await page.evaluate(() => window.previewFixture.cancelPointer());
    const cleared = await state();
    assert.equal(cleared.previewVisible, false, 'pointer cancel hides the preview');
    checks.push('project sidebar pointer preview/cancel preserved with same-target dedup');
  }

  assert.deepEqual(errors, []);
  const proof = { status: 'passed', checks, errors };
  await writeFile(PROOF_PATH, JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
}

let timer;
let failed = null;
const timeout = new Promise((_, reject) => {
  timer = setTimeout(
    () => reject(new Error('watchdog: docking preview regression exceeded 90s')),
    WATCHDOG_MS,
  );
});
try {
  await Promise.race([main(), timeout]);
} catch (error) {
  failed = error;
} finally {
  clearTimeout(timer);
  const status = failed || errors.length ? 'failed' : 'passed';
  await writeFile(
    PROOF_PATH,
    JSON.stringify(
      { status, checks, errors, failure: failed ? String(failed?.message ?? failed) : null },
      null,
      2,
    ),
  ).catch(() => {});
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await fixture?.close().catch(() => {});
}
if (failed) throw failed;
if (errors.length) throw new Error(errors.join('\n'));
