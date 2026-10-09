// Focused UI regression for the Alt-hold radial conversation switcher.
// Isolated fixture only. No user sessions, network or credentials.
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { recentConversations } from '../public/session-wheel.js';
import { createNavigationFixture } from './fixtures/project-navigation.mjs';

const checks = [];
const errors = [];

// Isolated module API: empty, fewer, latest-six (not alphabetic-first),
// archived excluded, owning cwd, color, language sorting.
{
  expect(recentConversations([], 'fr')).toEqual([]);
  expect(recentConversations([{ cwd: '/p', name: 'P', sessions: [] }], 'fr')).toEqual([]);
  checks.push('Vide via API isolee : aucun overlay attendu (open sort sans items)');

  const now = Date.now();
  const mk = (id, title, ageMs, extra = {}) => ({
    id,
    title,
    updatedAt: new Date(now - ageMs).toISOString(),
    ...extra,
  });
  const few = [
    {
      cwd: '/proj/Alpha',
      name: 'Alpha',
      sessions: [mk('few-b', 'Zebra', 2000), mk('few-a', 'Apple', 1000)],
    },
  ];
  const fewOut = recentConversations(few, 'fr');
  expect(fewOut.map((s) => s.id)).toEqual(['few-a', 'few-b']);
  expect(fewOut[0]).toMatchObject({ cwd: '/proj/Alpha', projectName: 'Alpha', title: 'Apple' });
  checks.push('Moins de six via API isolee : ordre alphabetique des titres');

  const projects = [
    {
      cwd: '/proj/Beta',
      name: 'Beta',
      color: '#7fa6c9',
      sessions: [
        mk('s-newest', 'Zebra', 1000),
        mk('s-1', 'Yellow', 60_000),
        mk('s-2', 'Xray', 120_000),
        mk('s-archived', 'AAA archive recent', 500, { archived: true }),
        mk('s-worktree', 'Whiskey', 180_000, { cwd: '/proj/Beta/worktree-task' }),
      ],
    },
    {
      cwd: '/proj/Alpha',
      name: 'Alpha',
      sessions: [
        mk('s-3', 'Victor', 240_000),
        mk('s-4', 'Uniform', 300_000),
        mk('s-5', 'Tango', 360_000),
        mk('s-old-alpha', 'Apple', 420_000),
        mk('s-oldest', 'Banana', 480_000),
      ],
    },
  ];
  const out = recentConversations(projects, 'fr');
  // 6 most recent non-archived, then alphabetic: Uniform..Zebra. Tango/Apple/Banana
  // (alphabetic-first candidates) are excluded because they are oldest. Archived excluded.
  expect(out.map((s) => s.id)).toEqual(['s-4', 's-3', 's-worktree', 's-2', 's-1', 's-newest']);
  expect(out.some((s) => s.id === 's-archived')).toBe(false);
  expect(out.some((s) => s.id === 's-old-alpha')).toBe(false);
  expect(new Set(out.map((s) => s.projectName)).size).toBeGreaterThan(1);
  expect(out.find((s) => s.id === 's-worktree').cwd).toBe('/proj/Beta');
  expect(out.find((s) => s.id === 's-newest').color).toBe('#3b82f6');
  expect(out.find((s) => s.id === 's-3')?.color ?? '').toBe('');
  for (const item of out) {
    expect(item).toMatchObject({
      id: expect.any(String),
      cwd: expect.any(String),
      projectName: expect.any(String),
      title: expect.any(String),
    });
  }
  const frTitles = recentConversations(projects, 'fr').map((s) => s.title);
  const enTitles = recentConversations(projects, 'en').map((s) => s.title);
  expect(frTitles.length).toBe(6);
  expect(enTitles.length).toBe(6);
  checks.push(
    'Six plus recents interprojets (updatedAt), archives exclues, cwd projet proprietaire, tri alphabetique ensuite, pas alphabetique d abord',
  );
}

const fixture = await createNavigationFixture();
// Give one project a tint so data-project-color and bold can be verified in DOM.
try {
  const overview0 = await (await fetch(`${fixture.url}/api/overview`)).json();
  const atelier = (overview0.projects || []).find(
    (p) => String(p.name || '').includes('Atelier') || String(p.cwd || '').endsWith('Atelier'),
  );
  if (atelier?.cwd) await fixture.app.store.project({ cwd: atelier.cwd, color: '#7fa6c9' }, true);
} catch {}
await mkdir(resolve('test-results/session-wheel'), { recursive: true });

let browser;
try {
  browser = await launchStudioBrowser({ channel: 'chrome' });
  const context = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 1440, height: 960 },
    reducedMotion: 'no-preference',
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(fixture.url);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });

  const overview = await (await fetch(`${fixture.url}/api/overview`)).json();
  const expected = recentConversations(overview.projects || [], 'fr');
  expect(expected.length).toBe(6);
  expect(new Set(expected.map((s) => s.projectName)).size).toBeGreaterThan(1);
  const titles = expected.map((s) => s.title);
  expect([...titles].sort((a, b) => a.localeCompare(b, 'fr'))).toEqual(titles);
  expect(expected.some((s) => s.id === 'documentation-1')).toBe(false);
  checks.push(
    'Attendus depuis overview : 6 non archivees interprojets, tri A a Z apres selection des plus recentes',
  );

  const wheel = page.locator('#session-wheel');
  const items = page.locator('button.session-wheel-item');
  const headerSession = page.locator('#header-session');
  const headerProject = page.locator('#header-project');
  async function expectLabelsInsideSectors() {
    const geometry = await items.evaluateAll((nodes) =>
      nodes.map((node) => {
        const label = node.querySelector('.session-wheel-label');
        const title = node.querySelector('.session-wheel-title').getBoundingClientRect();
        const project = node.querySelector('.session-wheel-project').getBoundingClientRect();
        const rect = label.getBoundingClientRect();
        const path = node.querySelector('path');
        const matrix = path.getScreenCTM().inverse();
        const corners = [
          [rect.left, rect.top],
          [rect.right, rect.top],
          [rect.left, rect.bottom],
          [rect.right, rect.bottom],
        ];
        return {
          titleFirst: title.bottom <= project.top,
          inside: corners.every(([x, y]) => path.isPointInFill(new DOMPoint(x, y).matrixTransform(matrix))),
          titleWidth: title.width <= rect.width + 1,
          projectWidth: project.width <= rect.width + 1,
        };
      }),
    );
    for (const item of geometry) {
      expect(item).toEqual({ titleFirst: true, inside: true, titleWidth: true, projectWidth: true });
    }
  }

  await page.locator('#composer').click();
  const initialHeader = await headerSession.innerText().catch(() => '');
  const activeId = await page
    .evaluate(() => JSON.parse(localStorage.getItem('prime-studio.selection') || '{}').sessionId || '')
    .catch(() => '');
  const draftText = 'Brouillon roue a conserver';
  await page.locator('#composer').fill(draftText);

  // Hold AltLeft opens overlay above app with full DOM contract, no initial selection.
  await page.keyboard.down('Alt');
  await expect(wheel).toBeVisible();
  await expect(page.locator('.session-wheel-stage')).toBeVisible();
  await expect(items).toHaveCount(6);
  await expect(page.locator('.session-wheel-center')).toBeVisible();
  for (let i = 0; i < 6; i++) {
    const button = items.nth(i);
    await expect(button).toHaveAttribute('data-session-id', expected[i].id);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(button).toHaveAttribute('title', `${expected[i].projectName}\n${expected[i].title}`);
    await expect(button).toHaveAttribute(
      'aria-label',
      `${i + 1}. ${expected[i].projectName}. ${expected[i].title}`,
    );
    await expect(button.locator('strong.session-wheel-project')).toHaveText(expected[i].projectName);
    await expect(button.locator('.session-wheel-title')).toHaveText(expected[i].title);
    await expect(button.locator('.session-wheel-label')).toBeVisible();
    await expect(button.locator('.session-wheel-label kbd')).toHaveText(String(i + 1));
    await expect(button).toHaveAttribute('data-project-color', expected[i].color || 'transparent');
  }
  const runningChoice = wheel.locator('[data-session-id="stability-demo"]');
  const unreadChoice = wheel.locator('[data-session-id="atelier-0"]');
  await expect(runningChoice).toHaveAttribute('data-activity', 'running');
  await expect(runningChoice.locator('.running-dot')).toBeVisible();
  await expect(unreadChoice).toHaveAttribute('data-activity', 'unread');
  await expect(unreadChoice.locator('.unread-dot')).toBeVisible();
  for (const [choice, color] of [
    [runningChoice, '--green'],
    [unreadChoice, '--blue'],
  ]) {
    const expectedFill = await page.evaluate((variable) => {
      const probe = document.createElement('span');
      probe.style.color = `color-mix(in srgb, var(${variable}) 12%, transparent)`;
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    }, color);
    await expect(choice.locator('.session-wheel-tint')).toHaveCSS('fill', expectedFill);
    await expect(choice.locator('.session-wheel-tint')).toHaveCSS('stroke', 'none');
    await expect(choice.locator('.session-wheel-tint')).toHaveCSS('pointer-events', 'none');
  }
  await expect(runningChoice.locator('.session-wheel-tint')).toHaveCSS('animation-name', 'pulse');
  const rhythms = await runningChoice.evaluate((node) => {
    const tint = node.querySelector('.session-wheel-tint').getAnimations()[0];
    const dot = node.querySelector('.running-dot').getAnimations()[0];
    return {
      sameStart: tint.startTime === dot.startTime,
      sameDuration: tint.effect.getTiming().duration === dot.effect.getTiming().duration,
    };
  });
  expect(rhythms).toEqual({ sameStart: true, sameDuration: true });
  await expect(unreadChoice.locator('.session-wheel-tint')).toHaveCSS('animation-name', 'none');
  for (const id of ['stability-demo', 'atelier-0']) {
    const sidebarRow = page.locator(`.session-row[data-session-id="${id}"]`);
    const choice = wheel.locator(`[data-session-id="${id}"]`);
    await expect(choice).toHaveAttribute('data-activity', await sidebarRow.getAttribute('data-activity'));
    const dot = choice.locator('.session-wheel-activity > span');
    await expect(dot).toHaveAttribute('role', 'img');
    await expect(choice).toHaveAttribute('aria-description', await dot.getAttribute('aria-label'));
    await expect(dot).toHaveCSS(
      'background-color',
      await sidebarRow
        .locator('[role="img"]')
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    );
  }
  const beforeRead = await page.evaluate(() => {
    const key = 'prime-studio.session-activity.atelier-0';
    const previous = localStorage.getItem(key);
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(previous), unread: false }));
    window.dispatchEvent(new StorageEvent('storage', { key }));
    return previous;
  });
  await expect(unreadChoice).toHaveAttribute('data-activity', 'idle');
  await expect(unreadChoice.locator('.unread-dot')).toHaveCount(0);
  await expect(unreadChoice.locator('.session-wheel-tint')).toHaveCSS('fill', 'rgba(0, 0, 0, 0)');
  await expect(wheel).toBeVisible();
  expect(await items.evaluateAll((nodes) => nodes.map((node) => node.dataset.sessionId))).toEqual(
    expected.map((item) => item.id),
  );
  await page.evaluate((previous) => {
    const key = 'prime-studio.session-activity.atelier-0';
    localStorage.setItem(key, previous);
    window.dispatchEvent(new StorageEvent('storage', { key }));
  }, beforeRead);
  await expect(unreadChoice.locator('.unread-dot')).toBeVisible();
  checks.push(
    'Pastilles identiques a la sidebar, priorite activite, non-lu actualise en direct sans fermer ni reordonner la roue',
  );
  await expect(wheel).toHaveAttribute('data-selected', 'false');
  await expect(page.locator('#session-wheel-heading')).toHaveText('Conversations récentes');
  await expect(page.locator('.session-wheel-eyebrow')).toHaveText('Navigation rapide');
  await expect(page.locator('#session-wheel-help')).toContainText('chap');
  const bold = await items
    .first()
    .locator('strong.session-wheel-project')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontWeight));
  expect(bold).toBeGreaterThanOrEqual(600);
  const atelierItem = items.filter({
    has: page.locator('strong.session-wheel-project', { hasText: 'Atelier' }),
  });
  if ((await atelierItem.count()) > 0) {
    await expect(atelierItem.first()).toHaveAttribute('data-project-color', '#3b82f6');
  }
  const frame = page.locator('.session-wheel-frame');
  const duration = await frame.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
  expect(duration).toBeGreaterThan(0);
  expect(duration).toBeLessThanOrEqual(0.2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(frame).toHaveCSS('animation-name', 'none');
  await expect(runningChoice.locator('.session-wheel-tint')).toHaveCSS('animation-name', 'none');
  await expect(runningChoice.locator('.running-dot')).toHaveCSS('animation-name', 'none');
  checks.push('Animation native de 160 ms, desactivee avec reduced motion');
  checks.push(
    'Overlay #session-wheel + stage + 6 items label/projet/centre, Alt seul sans selection, couleur projet et gras',
  );
  await expectLabelsInsideSectors();
  await page.screenshot({ path: resolve('test-results/session-wheel/dark.png'), animations: 'disabled' });
  const originalLabels = await items.evaluateAll((nodes) =>
    nodes.map((node) => {
      const title = node.querySelector('.session-wheel-title');
      const project = node.querySelector('.session-wheel-project');
      const original = [title.textContent, project.textContent];
      title.textContent = 'UneConversationSansEspacesAvecUnTitreBeaucoupTropLong'.repeat(4);
      project.textContent = 'ProjetAvecUnNomTrèsLongSansEspaces'.repeat(3);
      return original;
    }),
  );
  await expectLabelsInsideSectors();
  await page.screenshot({
    path: resolve('test-results/session-wheel/long-titles.png'),
    animations: 'disabled',
  });
  await items.evaluateAll(
    (nodes, originals) =>
      nodes.forEach((node, index) => {
        node.querySelector('.session-wheel-title').textContent = originals[index][0];
        node.querySelector('.session-wheel-project').textContent = originals[index][1];
      }),
    originalLabels,
  );

  // Mouse hover selects via label (button covers whole wheel), release Alt navigates preserving drafts.
  const currentIds = new Set(expected.map((s) => s.id).filter((id) => id && id !== activeId));
  let targetIndex = expected.findIndex((s) => currentIds.has(s.id));
  if (targetIndex < 0) targetIndex = 1;
  const target = expected[targetIndex];
  await page.locator('.session-wheel-item .session-wheel-label').nth(targetIndex).hover();
  await expect(items.nth(targetIndex)).toHaveAttribute('aria-pressed', 'true');
  await expect(wheel).toHaveAttribute('data-selected', 'true');
  await expect(page.locator('.session-wheel-prompt')).toHaveText('Relâchez Alt pour ouvrir');
  await page.screenshot({ path: resolve('test-results/session-wheel/selected.png'), animations: 'disabled' });
  await page.keyboard.up('Alt');
  await expect(wheel).toBeHidden();
  await expect(headerSession).toContainText(target.title.slice(0, 24), { timeout: 10000 });
  await expect(headerProject).toContainText(target.projectName);
  const drafts = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('prime-studio.drafts') || '{}');
    } catch {
      return {};
    }
  });
  if (activeId) expect(drafts[`session:${activeId}`]).toBe(draftText);
  checks.push('Survol souris + relache Alt ouvre via navigation existante, brouillon conserve');

  // Numpad code selects (NumLock-off proof uses code, not key value).
  const afterMouseHeader = await headerSession.innerText();
  const currentId2 = await page
    .evaluate(() => JSON.parse(localStorage.getItem('prime-studio.selection') || '{}').sessionId || '')
    .catch(() => '');
  let numpadIndex = expected.findIndex((s) => s.id !== currentId2);
  if (numpadIndex < 0) numpadIndex = 0;
  const numpadTarget = expected[numpadIndex];
  await page.locator('#composer').click();
  await page.keyboard.down('Alt');
  await expect(wheel).toBeVisible();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press(`Numpad${i + 1}`);
    await expect(items.nth(i)).toHaveAttribute('aria-pressed', 'true');
  }
  await page.keyboard.press(`Numpad${numpadIndex + 1}`);
  await expect(items.nth(numpadIndex)).toHaveAttribute('aria-pressed', 'true');
  // NumLock off sends End/Arrows with Numpad codes: implementation must use event.code.
  await page.evaluate((index) => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'End',
        code: `Numpad${index + 1}`,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, numpadIndex);
  await expect(items.nth(numpadIndex)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.up('Alt');
  await expect(wheel).toBeHidden();
  await expect(headerSession).toContainText(numpadTarget.title.slice(0, 24), { timeout: 10000 });
  await expect(headerProject).toContainText(numpadTarget.projectName);
  checks.push('Numpad1..6 par code (NumLock coupe inclus) + relache Alt ouvre la conversation');
  const currentId3 = await page
    .evaluate(() => JSON.parse(localStorage.getItem('prime-studio.selection') || '{}').sessionId || '')
    .catch(() => '');
  expect(currentId3).toBe(numpadTarget.id);
  expect(currentId3).not.toBe(currentId2);

  // Sector SVG area away from the label also selects (button covers the whole wheel).
  const sectorHeader = await headerSession.innerText();
  await page.keyboard.down('Alt');
  await expect(wheel).toBeVisible();
  const sector = await page.evaluate(() => {
    const rect = document.querySelector('.session-wheel-stage').getBoundingClientRect();
    const angle = ((-90 + 4 * 60) * Math.PI) / 180;
    const radius = 250 / 600;
    return {
      x: rect.left + rect.width * (0.5 + radius * Math.cos(angle)),
      y: rect.top + rect.height * (0.5 + radius * Math.sin(angle)),
    };
  });
  await page.mouse.move(sector.x, sector.y);
  await expect(items.nth(4)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(wheel).toBeHidden();
  await page.keyboard.up('Alt').catch(() => {});
  expect(await headerSession.innerText()).toBe(sectorHeader);
  checks.push('Survol zone SVG du secteur hors label selectionne, Echap annule');

  // Alt alone releases with no selection and navigates nowhere.
  const steadyHeader = await headerSession.innerText();
  await page.keyboard.down('Alt');
  await expect(wheel).toBeVisible();
  await expect(page.locator('.session-wheel-item[aria-pressed="true"]')).toHaveCount(0);
  await page.keyboard.up('Alt');
  await expect(wheel).toBeHidden();
  expect(await headerSession.innerText()).toBe(steadyHeader);
  checks.push('Alt seul sans choix : aucune selection accidentelle');

  // Center cancels: move back to center after a selection, then release.
  await page.keyboard.down('Alt');
  await expect(wheel).toBeVisible();
  await page.locator('.session-wheel-item .session-wheel-label').nth(0).hover();
  await expect(items.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.session-wheel-center').hover();
  await expect(page.locator('.session-wheel-item[aria-pressed="true"]')).toHaveCount(0);
  await expect(wheel).toHaveAttribute('data-selected', 'false');
  await page.keyboard.up('Alt');
  await expect(wheel).toBeHidden();
  expect(await headerSession.innerText()).toBe(steadyHeader);
  checks.push('Centre annule la selection, relache sans navigation');

  // Escape cancels without navigation.
  await page.keyboard.down('Alt');
  await expect(wheel).toBeVisible();
  await page.locator('.session-wheel-item .session-wheel-label').nth(2).hover();
  await page.keyboard.press('Escape');
  await expect(wheel).toBeHidden();
  await page.keyboard.up('Alt').catch(() => {});
  expect(await headerSession.innerText()).toBe(steadyHeader);
  checks.push('Echap annule sans navigation');

  // Blur cancels without navigation.
  await page.keyboard.down('Alt');
  await expect(wheel).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(wheel).toBeHidden();
  await page.keyboard.up('Alt').catch(() => {});
  expect(await headerSession.innerText()).toBe(steadyHeader);
  checks.push('Blur annule sans navigation');

  // Combos cancel and do not break AltGr or Alt+Tab follow-up.
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await expect(wheel).toBeHidden();
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await page.keyboard.down('Alt');
  await expect(wheel).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(wheel).toBeHidden();
  await page.keyboard.up('Alt').catch(() => {});
  expect(await headerSession.innerText()).toBe(steadyHeader);
  await page.keyboard.down('Alt');
  await expect(wheel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(wheel).toBeHidden();
  await page.keyboard.up('Alt').catch(() => {});
  checks.push('AltGr et Alt+Tab ne declenchent rien ni ne cassent Alt, combos annulent');

  // Overlay sits above an existing dialog and leaves it open on cancel.
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.keyboard.down('Alt');
  await expect(wheel).toBeVisible();
  const stacking = await page.evaluate(() => {
    const settings = document.querySelector('#settings-dialog');
    const wheelDialog = document.querySelector('#session-wheel');
    const wheelRect = wheelDialog.getBoundingClientRect();
    const cx = wheelRect.left + wheelRect.width / 2;
    const cy = wheelRect.top + Math.min(wheelRect.height - 1, wheelRect.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    return {
      settingsOpen: settings?.open === true,
      wheelOpen: wheelDialog?.open === true,
      hitInWheel: Boolean(hit?.closest?.('#session-wheel')),
    };
  });
  expect(stacking.settingsOpen).toBe(true);
  expect(stacking.wheelOpen).toBe(true);
  expect(stacking.hitInWheel).toBe(true);
  await page.keyboard.press('Escape');
  await expect(wheel).toBeHidden();
  await page.keyboard.up('Alt').catch(() => {});
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden();
  checks.push('Roue au-dessus du dialogue existant, annulation sans le fermer');

  // Light and compact screenshots with reduced motion.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await page.keyboard.down('Alt');
  await expect(wheel).toBeVisible();
  await page.screenshot({ path: resolve('test-results/session-wheel/light.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(wheel).toBeHidden();
  await page.keyboard.up('Alt').catch(() => {});
  const resized = page.evaluate(
    () =>
      new Promise((resolve) =>
        window.addEventListener('resize', () => requestAnimationFrame(() => requestAnimationFrame(resolve)), {
          once: true,
        }),
      ),
  );
  await page.setViewportSize({ width: 1024, height: 700 });
  await resized;
  await page.keyboard.down('Alt');
  await expect(wheel).toBeVisible();
  await expect(items).toHaveCount(6);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await expectLabelsInsideSectors();
  await page.screenshot({ path: resolve('test-results/session-wheel/compact.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(wheel).toBeHidden();
  await page.keyboard.up('Alt').catch(() => {});
  checks.push('Captures light et compacte 1024x700 sans debordement, resize synchronise, reduced motion');

  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser?.close();
  await fixture.close();
}
