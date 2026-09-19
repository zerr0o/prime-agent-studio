// Regression: on mobile the "Derniers messages" pill must stay above the composer
// frame while typing (textarea autoresize) and when the viewport shrinks
// (keyboard / resize). Real app + browser, synthetic streaming transport.
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const root = await mkdtemp(join(tmpdir(), 'studio-scroll-composer-'));
const cwd = join(root, 'project');
await mkdir(cwd);
let emit, finish;
const gate = new Promise((resolve) => (finish = resolve));
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/demo', name: 'Demo', provider: 'fixture' }],
    default: { model: 'fixture/demo' },
  }),
  async start({ onEvent }) {
    emit = (delta) => onEvent({ kind: 'text', delta });
    onEvent({ kind: 'message_start', role: 'assistant' });
    emit(
      Array.from({ length: 60 }, (_, i) => `Paragraphe ${i} : contenu de la réponse en cours.\n\n`).join(''),
    );
    return { done: gate.then(() => ({ status: 'completed', code: 0 })), cancel: finish };
  },
  async close() {
    finish();
  },
};
const app = createApp({
  runtime,
  initialCwd: cwd,
  sessionDir: join(root, 'sessions'),
  agentHome: join(root, 'agent'),
  dataDir: join(root, 'data'),
});
await app.store.project({ cwd });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const fixture = {
  cwd,
  url: `http://127.0.0.1:${app.server.address().port}`,
  async close() {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  },
};
const browser = await chromium.launch({
  channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome',
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((cwd) => {
    localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, projectOverview: false }));
  }, fixture.cwd);
  await page.goto(fixture.url);
  await expect(page.locator('#allow-questions')).toBeEnabled({ timeout: 30000 });
  await page.locator('#allow-questions').check();
  await page.locator('#composer').fill('Tester le défilement.');
  await page.locator('#send-button').click();
  await expect(page.locator('#messages')).toContainText('Paragraphe 59', { timeout: 30000 });
  finish();
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 30000 });

  const scroll = page.locator('#conversation-scroll');
  const bottom = page.locator('#scroll-bottom');
  // Detach by scrolling up so the pill becomes visible.
  await scroll.evaluate((s) => {
    s.scrollTop = s.scrollHeight - s.clientHeight - 400;
  });
  await expect(bottom).toBeVisible();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

  async function geometry(label) {
    const g = await page.evaluate(() => {
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height };
      };
      const area = document.querySelector('.conversation-column .composer-area');
      const form = document.getElementById('composer-form');
      const input = document.getElementById('composer');
      const pill = document.getElementById('scroll-bottom');
      const offset = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--scroll-bottom-offset'),
      );
      return {
        area: rect(area),
        form: rect(form),
        input: rect(input),
        pill: rect(pill),
        areaHeight: area.offsetHeight,
        offset,
        pillHidden: pill.hidden,
      };
    });
    console.log(
      `${label}: pill.bottom=${g.pill.bottom.toFixed(1)} form.top=${g.form.top.toFixed(1)} area.h=${g.areaHeight} offset=${g.offset}`,
    );
    return g;
  }
  async function expectAboveComposer(label) {
    await expect
      .poll(
        async () => {
          const g = await geometry(label);
          return g.pill.bottom <= g.form.top - 8
            ? 'ok'
            : `pill.bottom=${g.pill.bottom} form.top=${g.form.top}`;
        },
        { timeout: 5000 },
      )
      .toBe('ok');
    const g = await geometry(`${label} (final)`);
    // The dynamic offset must track the composer height (+12px gap).
    expect(
      Math.abs(g.offset - (g.areaHeight + 12)) < 2,
      `${label}: --scroll-bottom-offset (${g.offset}) should equal composer height (${g.areaHeight}) + 12`,
    ).toBe(true);
  }

  await expectAboveComposer('baseline detached');
  // Typing the first words grows the textarea (autoresize): the pill must move up.
  const areaBefore = (await geometry('before typing')).areaHeight;
  await page
    .locator('#composer')
    .fill('Bonjour voici les premiers mots qui font grandir le champ sur mobile');
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const areaAfter = (await geometry('after first words')).areaHeight;
  expect(areaAfter >= areaBefore, 'typing should grow or keep the composer height').toBe(true);
  await expectAboveComposer('first words typed');
  // Longer draft close to the mobile max-height: still no overlap.
  await page.locator('#composer').fill('Un brouillon plus long pour mobile.\n'.repeat(8));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(bottom).toBeVisible();
  await expectAboveComposer('long draft');
  // Keyboard/resize: shrink the visible height, the pill must stay above the frame.
  await page.setViewportSize({ width: 390, height: 600 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(bottom).toBeVisible();
  await expectAboveComposer('keyboard height (600px)');
  await page.locator('#composer').fill('Encore quelques mots avec le clavier ouvert sur mobile');
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expectAboveComposer('keyboard + typing');
  expect(errors).toEqual([]);
  console.log('Scroll-bottom composer PASS: pill stays above composer while typing and on keyboard resize');
} finally {
  try {
    finish();
  } catch {}
  await browser.close();
  await fixture.close();
}
