import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';
const root = await mkdtemp(join(tmpdir(), 'prime-command-ui-'));
const cwd = join(root, 'Atelier'),
  agentHome = join(root, 'agent'),
  sessionDir = join(root, 'sessions');
await Promise.all(
  [
    cwd,
    agentHome,
    sessionDir,
    join(cwd, '.prime', 'agent', 'skills', 'design'),
    join(cwd, '.prime', 'agent', 'prompts'),
  ].map((p) => mkdir(p, { recursive: true })),
);
await writeFile(join(agentHome, 'settings.json'), JSON.stringify({ enableBuiltinSkills: false }));
await writeFile(
  join(cwd, '.prime', 'agent', 'skills', 'design', 'SKILL.md'),
  '---\nname: design\ndescription: Concevoir une interface accessible <script>untrusted()</script>\n---\nTest uniquement',
);
await writeFile(
  join(cwd, '.prime', 'agent', 'prompts', 'review.md'),
  '---\ndescription: Relire un fichier\n---\nReview $1',
);
const controls = [],
  opened = [],
  errors = [],
  checks = [];
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({
    models: [{ id: 'fixture/luna', name: 'Luna', provider: 'fixture' }],
    default: { model: 'fixture/luna' },
  }),
  async start(input) {
    let finish;
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    const handle = { input, done, cancel: async () => finish({ status: 'stopped', code: 130 }) };
    controls.push(handle);
    return handle;
  },
  async close() {
    for (const h of controls) await h.cancel();
  },
};
const app = createApp({
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir: join(root, 'data'),
  runtime,
  openDirectory: async (path) => {
    opened.push(path);
    return { opened: true };
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const salt = 'e54d6dd09bb15f7c347b38b671472aa9';
const gateway = createLanGateway({
  upstreamPort: app.server.address().port,
  host: '127.0.0.1',
  port: 0,
  config: { salt, codeHash: hashAccessCode('12345678', salt), readOnly: false },
});
await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch(
    !process.env.PRIME_STUDIO_TEST_BROWSER || process.env.PRIME_STUDIO_TEST_BROWSER === 'chromium'
      ? { headless: true }
      : { channel: process.env.PRIME_STUDIO_TEST_BROWSER, headless: true },
  );
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      locale: 'fr-FR',
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${gateway.address().port}`);
    await page.locator('input[name="code"]').fill('12345678');
    await page.locator('button[type="submit"]').click();
    await page.locator('#project-new-session').click();
    await expect(page.locator('#composer')).toBeVisible();
    await page.locator('#composer').fill('/mod');
    await expect(page.locator('#command-suggestions')).toBeVisible();
    await page.locator('#composer').press('Enter');
    await expect(page.locator('#composer-command-label')).toHaveText('/model');
    await expect(page.locator('#composer')).toHaveValue('');
    expect(controls).toHaveLength(0);
    await page.locator('#send-button').click();
    await expect(page.locator('#model-dialog')).toBeVisible();
    await page.locator('#model-dialog [data-close-dialog]').click();
    await page.locator('#open-commands').click();
    await expect(page.locator('#commands-dialog')).toBeVisible();
    await expect(page.locator('#command-open-folder')).toBeHidden();
    for (const source of ['Skills', 'Prompts']) {
      await page.getByRole('button', { name: source, exact: true }).click();
      for (const scope of ['global', 'project']) {
        await page.locator('#command-folder-scope').selectOption(scope);
        await page.locator('#command-open-folder').click();
        await expect(page.locator('.command-folder-status')).toHaveText('Dossier ouvert sur le PC.');
        expect(opened.at(-1)).toBe(
          join(scope === 'global' ? agentHome : join(cwd, '.prime', 'agent'), source.toLowerCase()),
        );
      }
    }
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    const designSkill = page.locator('.command-item').filter({ hasText: '/skill:design' });
    await expect(designSkill).toHaveCount(1);
    await expect(designSkill).toContainText('<script>untrusted()</script>');
    expect(await page.locator('#commands-dialog script').count()).toBe(0);
    await designSkill.click();
    await expect(page.locator('#composer-command-label')).toHaveText('/skill:design');
    await expect(page.locator('#composer')).toHaveValue('');
    await page.locator('#remove-command').click();
    await page.locator('#composer').fill('/share');
    await page.locator('#send-button').click();
    await expect(page.locator('#composer')).toHaveValue('/share');
    expect(controls).toHaveLength(0);
    await page.locator('#open-commands').click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.locator('#command-open-folder')).toBeHidden();
    await expect(page.locator('.command-item').filter({ hasText: '/share' })).toBeDisabled();
    await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    await page.locator('#composer').fill('/skill:design Fais une page');
    const form = await page.locator('#composer-form').boundingBox();
    const buttons = await Promise.all(
      ['open-commands', 'attach-images', 'attach-files', 'send-button'].map((id) =>
        page.locator(`#${id}`).boundingBox(),
      ),
    );
    for (const b of buttons) {
      expect(b.y).toBeGreaterThanOrEqual(form.y);
      expect(b.y + b.height).toBeLessThanOrEqual(form.y + form.height + 1);
    }
    expect(form.y + form.height).toBeLessThanOrEqual(mobile ? 844 : 960);
    if (!mobile) {
      await page.locator('#open-commands').click();
      await page.getByRole('button', { name: 'Skills', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Skills', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await page.screenshot({ path: join(process.cwd(), '.local', 'commands-desktop.png') });
      await page.getByRole('button', { name: 'Terminé', exact: true }).click();
    } else {
      await page.locator('#composer').fill('/skill');
      await expect(page.locator('#command-suggestions')).toBeVisible();
      await page.screenshot({ path: join(process.cwd(), '.local', 'commands-mobile.png') });
      await page.locator('#composer').press('Escape');
      await page.locator('#composer').fill('/skill:design Fais une page');
      await page.locator('#send-button').click();
      await expect.poll(() => controls.length).toBe(1);
      expect(controls[0].input.message).toBe('/skill:design Fais une page');
    }
    checks.push(
      mobile
        ? 'Mobile: catalogue, insertion tactile, composer complet et envoi natif'
        : 'PC: complétion clavier, raccourcis Studio, skills et commandes terminal protégées',
    );
    await context.close();
  }
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser?.close();
  await new Promise((done) => gateway.close(done));
  await app.close();
  await rm(root, { recursive: true, force: true });
}
