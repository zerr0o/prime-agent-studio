import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server.mjs';

const temp = await mkdtemp(join(tmpdir(), 'studio-message-heading-'));
const cwd = join(temp, 'Atelier'),
  agentHome = join(temp, 'agent'),
  sessionDir = join(temp, 'sessions');
await Promise.all([cwd, agentHome, sessionDir].map((path) => mkdir(path)));
const timestamp = new Date().toISOString();
await writeFile(
  join(sessionDir, 'heading.jsonl'),
  [
    { type: 'session', id: 'heading', version: 3, cwd, timestamp },
    {
      type: 'message',
      id: 'user-heading',
      timestamp,
      message: { role: 'user', content: 'Rendre les messages plus faciles à distinguer.' },
    },
    {
      type: 'message',
      id: 'agent-heading',
      parentId: 'user-heading',
      timestamp,
      message: {
        role: 'assistant',
        model: 'test/model',
        content: [
          {
            type: 'text',
            text: 'Le message utilisateur affiche son heure à gauche et son auteur à droite.\n\nLes messages de l’agent gardent leur présentation habituelle.',
          },
        ],
        stopReason: 'stop',
      },
    },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);
const app = createApp({
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir: join(temp, 'data'),
  runtime: {
    getStatus: async () => ({ available: true, version: '0.9.5' }),
    getModels: async () => ({
      models: [{ id: 'test/model', name: 'Test Model', provider: 'test' }],
      default: { model: 'test/model', thinking: 'medium' },
    }),
    start: async () => {
      throw new Error('This visual fixture never starts an agent');
    },
    close: async () => {},
  },
});
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PRIME_STUDIO_TEST_BROWSER ? { channel: process.env.PRIME_STUDIO_TEST_BROWSER } : {}),
  });
  await mkdir(resolve('test-results'), { recursive: true });
  for (const [locale, author] of [
    ['fr-FR', 'Vous'],
    ['en-US', 'You'],
  ]) {
    const context = await browser.newContext({ locale, viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page
      .locator('#session-list')
      .getByText('Rendre les messages plus faciles à distinguer.', { exact: true })
      .click();
    const user = page.locator('.message.user').first();
    const agent = page.locator('.message.assistant').first();
    await expect(user.locator('.message-author')).toHaveText(author);
    await expect(agent.locator('.message-author')).toHaveText('Prime Agent');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
      await expect(user).toBeVisible();
      const geometry = async (locator) =>
        locator.evaluate((node) => {
          const box = (selector) => {
            const r = node.querySelector(selector).getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          };
          return {
            time: box('.message-time'),
            author: box('.message-author'),
            avatar: box('.message-avatar'),
            body: box('.message-body'),
            overflow: node.scrollWidth > node.clientWidth + 1,
          };
        });
      const u = await geometry(user),
        a = await geometry(agent);
      assert.ok(u.time.right < u.author.left, 'user time is left of the author');
      assert.ok(u.author.right <= u.avatar.left, 'user avatar mirrors the agent avatar');
      assert.ok(
        a.avatar.right <= a.author.left && a.author.right < a.time.left,
        'agent header order is unchanged',
      );
      assert.ok(Math.abs(u.time.left - u.body.left) <= 1, 'user timestamp aligns above card left edge');
      assert.ok(Math.abs(u.avatar.right - u.body.right) <= 1, 'user identity aligns above card right edge');
      assert.ok(
        u.author.bottom <= u.body.top && u.time.bottom <= u.body.top,
        'metadata remains above the card',
      );
      assert.ok(!u.overflow && !a.overflow, `no overflow at ${width}px`);
      await page.screenshot({
        path: resolve(`test-results/message-heading-${locale}-${width}.png`),
        animations: 'disabled',
      });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    'Message headings passed: mirrored user header, unchanged agent, above-card alignment, FR/EN, desktop/390/320, no page errors.',
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 4 });
}
