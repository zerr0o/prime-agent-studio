import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { interactiveStudio } from './fixtures/interactive-studio.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const fixture = await interactiveStudio();
const out = resolve(process.env.PRIME_STUDIO_REVIEW_DIR || '.local/interactive-review/builder');
await mkdir(out, { recursive: true });
const gateway = createLanGateway({
  host: '127.0.0.1',
  upstreamPort: fixture.app.server.address().port,
  config: { readOnly: false, salt: 'f'.repeat(32), codeHash: hashAccessCode('12345678', 'f'.repeat(32)) },
});
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
const remote = `http://127.0.0.1:${gateway.address().port}`;
const browser = await launchStudioBrowser({ channel: 'chrome' });
const errors = [];
const desktop = await browser.newContext({
  viewport: { width: 1500, height: 1050 },
  locale: 'fr-FR',
  reducedMotion: 'reduce',
});
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  locale: 'fr-FR',
  reducedMotion: 'reduce',
});
const page = await desktop.newPage(),
  mobile = await phone.newPage();
for (const p of [page, mobile]) p.on('pageerror', (error) => errors.push(error.message));
await desktop.addInitScript((cwd) => {
  if (!localStorage.getItem('prime-studio.selection'))
    localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, projectOverview: false }));
}, fixture.cwd);
try {
  await page.goto(fixture.url);
  await expect(page.locator('#composer')).toBeVisible();
  await expect(page.locator('#connection-label')).toContainText('connecté', { timeout: 30000 });
  await page.locator('#allow-questions').check();
  await page.locator('#composer').fill('Préparer un aperçu et demander ma préférence.');
  await page.locator('#send-button').click();
  const question = page.locator('.agent-question:not(.question-resolved)');
  await expect(question).toBeVisible({ timeout: 45000 });
  await expect(page.locator('.inline-image-open img').first()).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.inline-image-open img')
        .first()
        .evaluate((img) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(page.locator('#allow-questions')).toBeChecked();
  await expect(question).toBeInViewport({ ratio: 0.9 });
  await page.screenshot({ path: join(out, 'desktop-question.png') });
  const selection = await page.evaluate(() => localStorage.getItem('prime-studio.selection'));
  await phone.addInitScript((selection) => {
    if (!localStorage.getItem('prime-studio.selection'))
      localStorage.setItem('prime-studio.selection', selection);
  }, selection);
  await mobile.goto(remote);
  await mobile.locator('input[name="code"]').fill('12345678');
  await mobile.locator('button[type="submit"]').click();
  const mobileQuestion = mobile.locator('.agent-question:not(.question-resolved)');
  await expect(mobileQuestion).toBeVisible({ timeout: 30000 });
  await expect(mobileQuestion).toBeInViewport({ ratio: 0.8 });
  await mobile.screenshot({ path: join(out, 'phone-question.png') });
  await expect
    .poll(() =>
      mobile
        .locator('.inline-image-open img')
        .first()
        .evaluate((img) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await mobileQuestion.locator('textarea').fill('Une page centrée sur les résultats');
  await page.reload();
  await expect(page.locator('.agent-question:not(.question-resolved)')).toBeVisible();
  await mobileQuestion.getByRole('button', { name: 'Envoyer la réponse' }).click();
  await expect(page.locator('#messages')).toContainText('Une page centrée sur les résultats', {
    timeout: 30000,
  });
  await expect(mobile.locator('.agent-question:not(.question-resolved)')).toHaveCount(0);
  await expect(page.locator('#stop-button')).toBeHidden({ timeout: 30000 });
  await page.locator('.inline-image-open').last().click();
  await expect(page.locator('.image-viewer[open] img')).toBeVisible();
  await page.screenshot({ path: join(out, 'image-expanded.png') });
  await page.keyboard.press('Escape');
  await rm(join(fixture.cwd, 'captures/apercu.png'));
  await page.reload();
  await expect(page.locator('.inline-image-note').last()).toContainText('fichier déplacé ou supprimé');
  await page.locator('.inline-image-note').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, 'image-missing.png') });
  await page.locator('#allow-questions').uncheck();
  await page.reload();
  await expect(page.locator('#allow-questions')).not.toBeChecked();
  assert.deepEqual(errors, []);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await writeFile(
    join(out, 'proof.json'),
    JSON.stringify(
      {
        passed: true,
        native: true,
        source: fixture.root,
        checks: [
          'Native inline question',
          'Free answer sent through authenticated remote gateway',
          'Question restored after page reload',
          'Second device resolves the same question',
          'Native answer in transcript',
          'Image enlargement',
          'Same-origin image through gateway',
          'Deleted file fallback',
          'Per-conversation checkbox persists',
          '390px layout without overflow',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log('Interactive UI PASS', out);
} catch (error) {
  await page.screenshot({ path: join(out, 'failure-desktop.png') });
  await mobile.screenshot({ path: join(out, 'failure-phone.png') });
  throw error;
} finally {
  await browser.close();
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
  await fixture.close();
}
