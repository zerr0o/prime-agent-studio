import { chromium, expect } from '@playwright/test';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createKnowledgeFixture } from './fixtures/knowledge.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const packaged = process.env.PRIME_STUDIO_TEST_PACKAGED;
const createApplication = packaged
  ? (await import(pathToFileURL(resolve(packaged, 'server.mjs')))).createApp
  : undefined;
const fixture = await createKnowledgeFixture({ longHistory: true, createApplication });
const browser = await launchStudioBrowser({ channel: 'chrome' });
const errors = [],
  checks = [];
let gateway;
await mkdir(resolve('test-results'), { recursive: true });
try {
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  const openKnowledge = async () => {
    await page
      .locator('.project-entry')
      .filter({ has: page.locator('.project-label', { hasText: 'SoundsPerfect' }) })
      .locator('.project-more')
      .click();
    await page.locator('[data-project-action="knowledge"]').click();
    await expect(page.locator('#knowledge-dialog')).toBeVisible();
    await expect(page.locator('.knowledge-result').first()).toBeVisible();
  };
  await page.goto(fixture.url);
  await openKnowledge();
  const search = page.locator('.knowledge-search input');
  await expect(search).toBeFocused();
  await page.locator('[data-kind="memory"]').click();
  await expect(page.locator('[data-kind="memory"]')).toBeFocused();
  await expect(page.locator('.knowledge-result')).toHaveCount(2);
  await expect(page.locator('.knowledge-list')).toContainText('Lancements Windows discrets');
  await expect(page.locator('.knowledge-list')).toContainText('Global');
  await page.locator('.knowledge-result').filter({ hasText: 'Validation audio' }).click();
  await expect(page.locator('.knowledge-result').filter({ hasText: 'Validation audio' })).toBeFocused();
  await expect(page.locator('.knowledge-detail')).toContainText('48 kHz');
  await page.locator('.knowledge-source summary').click();
  await expect(page.locator('.knowledge-source')).toContainText('/entries/memory/calibration');
  checks.push('Mémoires natives session/global, source exacte');
  await page.locator('[data-kind="global"]').click();
  await expect(page.locator('.knowledge-result').first()).toBeVisible();
  for (const meta of await page.locator('.knowledge-result-meta').allTextContents())
    if (!meta.includes('Global')) throw new Error(`Non-global result in Global filter: ${meta}`);
  checks.push('Filtre Global uniquement');
  await page.locator('[data-kind="refinement"]').click();
  await expect(page.locator('.knowledge-result')).toHaveCount(1);
  await expect(page.locator('.knowledge-change-pair')).toContainText('Avant');
  await expect(page.locator('.knowledge-change-pair')).toContainText('Après');
  await expect(page.locator('.knowledge-change-pair')).toContainText('conserver le rapport');
  await page.screenshot({ path: resolve('test-results/knowledge-desktop-refinement.png') });
  checks.push('Refinement natif, raison et modifications avant/après');
  await page.locator('[data-kind="all"]').click();
  await search.fill('convolution');
  await expect(page.locator('.knowledge-result')).toHaveCount(1);
  await expect(page.locator('.knowledge-detail')).toContainText('sous-agent');
  await expect(page.locator('.knowledge-open-session')).toHaveCount(0);
  await page.locator('.knowledge-source summary').click();
  await expect(page.locator('.knowledge-source')).toContainText('child-closed.jsonl');
  checks.push('Sous-agent terminé consultable avec source, sans faux lien conversation');
  await search.fill('PROJECT_BOUNDARY_SENTINEL');
  await expect(page.locator('.knowledge-status')).toContainText('Aucun résultat');
  await search.fill('introuvable');
  await search.fill('calibration');
  await expect(page.locator('.knowledge-result').first()).toBeVisible();
  await expect(page.locator('.knowledge-status')).not.toContainText('Aucun résultat');
  checks.push('Isolation par projet et recherche rapide sans résultat périmé');
  await page.locator('[data-kind="history"]').click();
  await search.fill('rapport final');
  await page.locator('.knowledge-result').filter({ hasText: 'rapport final' }).click();
  await page.locator('.knowledge-open-session').click();
  await expect(page.locator('#knowledge-dialog')).not.toBeVisible();
  await expect(page.locator('#messages')).toContainText('rapport final');
  await expect(page.locator('#messages [data-message-id="calibration-demo-answer"]').last()).toBeFocused();
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(page.locator('#messages [data-message-id="calibration-demo-answer"]').last()).toBeInViewport({
    ratio: 0.8,
  });
  checks.push('Ouvrir la conversation source et conserver le passage');
  await page.screenshot({ path: resolve('test-results/v3-sidebar-desktop.png') });
  await openKnowledge();
  await page.locator('[data-kind="refinement"]').click();
  await page.locator('.knowledge-harness-action').click();
  await expect(page.locator('#knowledge-dialog')).not.toBeVisible();
  await expect(page.locator('#composer')).toHaveValue(/^\/refine rollback \S+$/);
  await expect(page.locator('#composer')).toBeFocused();
  await page.locator('#composer').fill('');
  checks.push('Annuler un refinement pré-remplit la commande native dans sa session');
  await openKnowledge();
  await page.locator('[data-kind="refinement"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.knowledge-result').click();
  await expect(page.locator('.knowledge-change-pair')).toBeVisible();
  await expect(page.locator('.knowledge-back')).toBeFocused();
  await expect
    .poll(() => page.locator('#knowledge-dialog').evaluate((d) => d.scrollWidth <= d.clientWidth))
    .toBe(true);
  await page.screenshot({ path: resolve('test-results/knowledge-mobile-refinement.png') });
  await page.locator('.knowledge-back').click();
  await expect(page.locator('.knowledge-list')).toBeVisible();
  await page.screenshot({ path: resolve('test-results/knowledge-mobile-list.png') });
  await page.route('**/api/knowledge/item?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Source temporairement indisponible' }),
    }),
  );
  await page.locator('.knowledge-result').click();
  await expect(page.locator('.knowledge-error')).toContainText('Source temporairement indisponible');
  await expect(page.locator('.knowledge-back')).toBeFocused();
  await page.locator('.knowledge-back').click();
  await expect(page.locator('.knowledge-list')).toBeVisible();
  await page.unroute('**/api/knowledge/item?*');
  checks.push('Mobile, lecture plein panneau et retour aux résultats, sans débordement');
  await page.keyboard.press('Escape');
  await expect(page.locator('#knowledge-dialog')).not.toBeVisible();
  await expect(
    page
      .locator('.project-entry')
      .filter({ has: page.locator('.project-label', { hasText: 'SoundsPerfect' }) })
      .locator('.project-more'),
  ).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => {
    localStorage.setItem('prime-studio.language', 'en');
    document.documentElement.dataset.theme = 'light';
  });
  await page.reload();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await openKnowledge();
  await expect(page.locator('#knowledge-title')).toHaveText('Project knowledge');
  await page.locator('[data-kind="refinement"]').click();
  await expect(page.locator('.knowledge-change-pair')).toContainText('Before');
  await page.screenshot({ path: resolve('test-results/knowledge-desktop-light-en.png') });
  checks.push('FR/EN et thème clair, Échap ferme le dialogue');
  const harnessFile = join(fixture.agentHome, 'harness', 'harness_state.json');
  const harness = JSON.parse(await readFile(harnessFile, 'utf8'));
  harness.entries.memory.markup = {
    id: 'markup',
    title: 'HTML_PROBE',
    content: `<p>Lecture de preuve HTML.</p><div style="position:fixed;inset:0;z-index:2147483647;background:black;color:white" id="overlay-proof">Contenu de source</div><img src="${fixture.url}/knowledge-markup-probe"><svg><image href="${fixture.url}/knowledge-markup-probe" /></svg><form><button>Contrôle source</button></form>`,
  };
  await writeFile(harnessFile, JSON.stringify(harness));
  let markupRequests = 0;
  await page.route('**/knowledge-markup-probe', (route) => {
    markupRequests++;
    return route.fulfill({ status: 200, body: '' });
  });
  await page.locator('[data-kind="memory"]').click();
  await search.fill('HTML_PROBE');
  await expect(page.locator('.knowledge-result')).toHaveCount(1);
  await expect(page.locator('.knowledge-detail h3')).toHaveText('HTML_PROBE');
  await expect(
    page.locator(
      '.knowledge-body [style], .knowledge-body img, .knowledge-body svg, .knowledge-body button, .knowledge-body form',
    ),
  ).toHaveCount(0);
  await page.locator('.knowledge-close').click();
  await expect(page.locator('#knowledge-dialog')).not.toBeVisible();
  expect(markupRequests).toBe(0);
  await page.unroute('**/knowledge-markup-probe');
  delete harness.entries.memory.markup;
  await writeFile(harnessFile, JSON.stringify(harness));
  checks.push('HTML natif sans styles, médias ni contrôles injectés ; fermeture accessible');
  const code = '48159267',
    salt = 'e54d6dd09bb15f7c347b38b671472aa9';
  gateway = createLanGateway({
    host: '127.0.0.1',
    port: 0,
    upstreamPort: fixture.app.server.address().port,
    config: { salt, codeHash: hashAccessCode(code, salt), readOnly: true },
  });
  await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
  const remoteUrl = `http://127.0.0.1:${gateway.address().port}`;
  const phoneContext = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const login = await phoneContext.request.post(remoteUrl + '/lan/login', {
    form: { code },
    maxRedirects: 0,
  });
  expect(login.status()).toBe(303);
  const phone = await phoneContext.newPage();
  phone.on('pageerror', (error) => errors.push(error.message));
  await phone.goto(remoteUrl);
  await phone.locator('#toggle-sidebar').click();
  await phone
    .locator('.project-entry')
    .filter({ has: phone.locator('.project-label', { hasText: 'SoundsPerfect' }) })
    .locator('.project-more')
    .click();
  await expect(phone.locator('#project-menu button:visible')).toHaveCount(1);
  await phone.locator('[data-project-action="knowledge"]').click();
  await phone.locator('[data-kind="memory"]').click();
  await expect(phone.locator('.knowledge-result')).toHaveCount(2);
  await phone.locator('.knowledge-result').filter({ hasText: 'Validation audio' }).click();
  await expect(phone.locator('.knowledge-detail')).toContainText('48 kHz');
  await phone.screenshot({ path: resolve('test-results/knowledge-mobile-readonly.png') });
  checks.push('Téléphone authentifié en consultation : menu sans mutation, mémoires accessibles');
  await phoneContext.close();
  expect(errors).toEqual([]);
  await writeFile(
    resolve('test-results/knowledge-ui.json'),
    JSON.stringify({ source: packaged || 'worktree', checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ source: packaged || 'worktree', checks, errors }, null, 2));
} finally {
  await browser.close();
  if (gateway) {
    gateway.closeAllConnections();
    await new Promise((done) => gateway.close(done));
  }
  await fixture.close();
}
