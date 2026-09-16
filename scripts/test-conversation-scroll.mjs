import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

// Real app + browser, synthetic streaming transport; no native CLI or paid provider.
const root = await mkdtemp(join(tmpdir(), 'studio-scroll-'));
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
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
  const scroll = page.locator('#conversation-scroll');
  const bottom = page.locator('#scroll-bottom');
  const gap = () => scroll.evaluate((s) => s.scrollHeight - s.clientHeight - s.scrollTop);
  await expect(page.locator('#messages')).toContainText('Paragraphe 59', { timeout: 30000 });
  await expect.poll(gap).toBeLessThan(3);
  await scroll.hover();
  // A small upward gesture must detach even inside the old 110px threshold.
  await page.mouse.wheel(0, -60);
  await expect.poll(gap).toBeGreaterThan(30);
  const position = await scroll.evaluate((s) => s.scrollTop);
  emit('Ajout pendant la lecture.\n\n'.repeat(20));
  await expect(page.locator('#messages')).toContainText('Ajout pendant la lecture.');
  await expect(bottom).toBeVisible();
  await expect.poll(() => scroll.evaluate((s) => s.scrollTop)).toBe(position);
  // Returning manually to the actual bottom resumes following.
  await scroll.evaluate((s) => {
    s.scrollTop = s.scrollHeight;
  });
  await expect(bottom).toBeHidden();
  emit('Suivi repris manuellement.\n\n'.repeat(15));
  await expect(page.locator('#messages')).toContainText('Suivi repris manuellement.');
  await expect.poll(gap).toBeLessThan(3);
  await scroll.hover();
  await page.mouse.wheel(0, -500);
  await expect(bottom).toBeVisible();
  await bottom.click();
  await expect.poll(gap).toBeLessThan(3);
  emit('Suivi repris via bouton.\n\n'.repeat(15));
  await expect(page.locator('#messages')).toContainText('Suivi repris via bouton.');
  await expect.poll(gap).toBeLessThan(3);
  await scroll.hover();
  await page.mouse.wheel(0, -400);
  await expect(bottom).toBeVisible();
  const finalPosition = await scroll.evaluate((s) => s.scrollTop);
  finish();
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 30000 });
  await expect.poll(() => scroll.evaluate((s) => s.scrollTop)).toBe(finalPosition);
  expect(errors).toEqual([]);
  console.log('Streaming scroll PASS: detach, preserve reading, manual/button resume, completion');
} finally {
  finish();
  await browser.close();
  await fixture.close();
}
