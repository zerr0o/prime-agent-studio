// Isolated native docking/CSS regression. No app boot, engine, Lab or model calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { preferencesFixture } from './preview-preferences.mjs';

const out = resolve('.local/docking-4.3/resize-regression');
await mkdir(out, { recursive: true });
const fixture = await preferencesFixture();
const samples = [],
  checks = [],
  errors = [];
let browser;
function layoutFor(panels, dir) {
  const group = (panel, i) => ({ kind: 'group', id: `group-${i}`, panels: [panel], active: panel });
  let root = group(panels[0], 0);
  for (let i = 1; i < panels.length; i++)
    root = {
      kind: 'split',
      id: `split-${i}`,
      dir,
      ratio: i / (i + 1),
      first: root,
      second: group(panels[i], i),
    };
  return { version: 3, root };
}
try {
  browser = await launchStudioBrowser();
  const page = await browser.newPage({ viewport: { width: 2000, height: 1400 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/public/app.js', (route) => route.abort());
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const { createDocking } = await import('/public/docking.js');
    const { createDefaultLayout } = await import('/public/docking-layout.js');
    const roadmap = document.createElement('section');
    roadmap.id = 'roadmap-panel';
    roadmap.textContent = 'Roadmap — isolated resize fixture';
    document.body.append(roadmap);
    const panels = {
      conversation: document.querySelector('.conversation-column'),
      roadmap,
      session: document.getElementById('inspector-session'),
      agents: document.getElementById('inspector-agents'),
      files: document.getElementById('inspector-files'),
      preferences: document.getElementById('settings-dialog'),
    };
    const writes = [];
    const dock = createDocking({
      panels,
      read: (key, fallback) =>
        key === 'docking.layout' ? { ...createDefaultLayout(), enabled: true } : fallback,
      write: (key, value) => {
        writes.push({ key, value });
        return true;
      },
      onChange: ({ active }) => {
        document.getElementById('details-panel').hidden = active;
      },
    });
    dock.updateViewport();
    window.resizeFixture = { dock, panels, writes };
  });
  const geometry = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.dock-split')].map((node) => {
        const row = node.dataset.direction === 'row';
        const start = row ? 'left' : 'top',
          end = row ? 'right' : 'bottom',
          size = row ? 'width' : 'height';
        const rect = node.getBoundingClientRect();
        const children = [...node.children].map((child) => child.getBoundingClientRect());
        return {
          id: node.id,
          gap: rect[end] - children.at(-1)[end],
          leading: children[0][start] - rect[start],
          between: children.slice(1).map((child, i) => child[start] - children[i][end]),
          extent: rect[size],
          sizes: children.map((child) => child[size]),
          tracks: getComputedStyle(node)[row ? 'gridTemplateColumns' : 'gridTemplateRows'],
        };
      }),
    );
  async function filled(label) {
    const nodes = await geometry();
    samples.push({ label, nodes });
    for (const node of nodes) {
      assert.ok(Math.abs(node.gap) <= 1, `${label} ${node.id}: unused trailing strip ${node.gap}px`);
      assert.ok(Math.abs(node.leading) <= 1, `${label} ${node.id}: leading gap`);
      assert.ok(
        node.between.every((gap) => Math.abs(gap) <= 1),
        `${label} ${node.id}: internal gap/overlap`,
      );
      assert.ok(Math.abs(node.sizes[1] - 1) <= 0.1, `${label}: divider must stay 1px`);
    }
    return nodes;
  }
  const model = (id) =>
    page.evaluate((id) => {
      const find = (node) =>
        node.id === id ? node : node.kind === 'split' ? find(node.first) || find(node.second) : null;
      return find(window.resizeFixture.dock.getLayout().root);
    }, id);
  async function begin(id) {
    const node = await page.locator(`#dock-node-${id}`).boundingBox();
    const grip = await page.locator(`[data-dock-split="${id}"]`).boundingBox();
    const point = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
    const hit = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return {
        splitter: target?.closest('[data-dock-split]')?.dataset.dockSplit,
        tag: target?.tagName,
        id: target?.id,
        className: target?.className,
      };
    }, point);
    assert.equal(hit.splitter, id, `pointer target: ${JSON.stringify(hit)}`);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    assert.ok(await page.locator('#dock-workspace.is-resizing').count(), 'native pointer starts resize');
    return { node, grip };
  }
  async function move({ node, grip }, dir, ratio) {
    await page.mouse.move(
      dir === 'row' ? node.x + node.width * ratio : grip.x + grip.width / 2,
      dir === 'column' ? node.y + node.height * ratio : grip.y + grip.height / 2,
      { steps: 2 },
    );
  }
  for (const motion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion: motion });
    for (const dir of ['row', 'column']) {
      for (const panels of [
        ['files', 'conversation', 'agents'],
        ['files', 'roadmap', 'session', 'conversation', 'agents'],
      ]) {
        const base = layoutFor(panels, dir);
        await page.setViewportSize({
          width: panels.length === 3 ? 1600 : 2000,
          height: dir === 'column' ? 1700 : 1000,
        });
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        for (let middle = 1; middle < panels.length - 1; middle++) {
          const id = `split-${middle}`,
            label = `${motion}/${dir}/${panels.length}/${panels[middle]}`;
          assert.equal(
            await page.evaluate((layout) => window.resizeFixture.dock.applyLayout(layout), base),
            true,
          );
          await filled(`${label}/start`);
          const drag = await begin(id);
          let previous;
          for (const ratio of [0.55, 0.65, 0.7, 0.75, 0.8, 0.85, 0.98]) {
            await move(drag, dir, ratio);
            const nodes = await filled(`${label}/${ratio}`);
            const node = nodes.find((node) => node.id === `dock-node-${id}`);
            if (previous) {
              assert.ok(
                node.sizes[0] >= previous.sizes[0] - 1,
                `${label}: first side jumped backwards at minimum`,
              );
              assert.ok(
                node.sizes[2] <= previous.sizes[2] + 1,
                `${label}: middle pane jumped wider at minimum`,
              );
            }
            previous = node;
          }
          await page.mouse.up();
          assert.equal((await model(id)).ratio, 0.85);
          // Escape must restore both the geometry and persisted model after a large reverse movement.
          const before = await geometry(),
            beforeModel = await model(id);
          const writes = await page.evaluate(() => window.resizeFixture.writes.length);
          const reverse = await begin(id);
          await move(reverse, dir, 0.02);
          await filled(`${label}/reverse-minimum`);
          await page.keyboard.press('Escape');
          await page.mouse.up();
          assert.deepEqual(await model(id), beforeModel);
          assert.equal(await page.evaluate(() => window.resizeFixture.writes.length), writes);
          const restored = await filled(`${label}/escape`);
          for (const node of restored) {
            const initial = before.find((item) => item.id === node.id);
            node.sizes.forEach((size, index) =>
              assert.ok(Math.abs(size - initial.sizes[index]) <= 1, `${label}: Escape lost size`),
            );
          }
          // Keyboard and pointer both store normalized ratios, not CSS flex weights.
          const grip = page.locator(`[data-dock-split="${id}"]`);
          await grip.focus();
          await grip.press('Home');
          assert.equal((await model(id)).ratio, 0.15);
          await filled(`${label}/home`);
          await grip.press(dir === 'row' ? 'ArrowRight' : 'ArrowDown');
          assert.ok(Math.abs((await model(id)).ratio - 0.17) < 1e-9);
          await filled(`${label}/arrow`);
          await grip.press('End');
          assert.equal((await model(id)).ratio, 0.85);
          await filled(`${label}/end`);
          // Rebuilding from a stored layout keeps geometry and the same live panel nodes.
          const saved = await page.evaluate(() => window.resizeFixture.dock.getLayout());
          assert.equal(
            await page.evaluate((layout) => window.resizeFixture.dock.applyLayout(layout), saved),
            true,
          );
          await filled(`${label}/restore`);
          assert.ok(
            await page.evaluate(
              (ids) =>
                ids.every(
                  (id) =>
                    window.resizeFixture.panels[id].isConnected &&
                    window.resizeFixture.panels[id].closest('[role="tabpanel"]'),
                ),
              panels,
            ),
          );
          checks.push(`${label}: no blank band/jump; pointer, keyboard, Escape, restore`);
        }
        if (motion === 'reduce')
          await page.screenshot({ path: join(out, `${dir}-${panels.length}-fixed.png`) });
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', checks, sampleCount: samples.length, errors }, null, 2));
} finally {
  await writeFile(join(out, 'proof.json'), JSON.stringify({ checks, samples, errors }, null, 2));
  await browser?.close();
  await fixture.close();
}
