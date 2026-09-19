// Isolated projects, native transcript shapes and an inert runtime: never uses user sessions.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';
import { captureEnglishDocumentation } from './documentation-capture.mjs';

const exec = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), 'prime-inspector-ui-'));
const cwd = join(temp, 'Atelier'),
  agentHome = join(temp, 'agent'),
  sessionDir = join(agentHome, 'sessions');
await mkdir(cwd);
await mkdir(sessionDir, { recursive: true });
await mkdir('test-results', { recursive: true });
const git = (...args) => exec('git', ['-C', cwd, ...args], { windowsHide: true });
await git('init', '-q');
await git('config', 'user.name', 'Fixture');
await git('config', 'user.email', 'fixture@example.test');
await mkdir(join(cwd, 'src'));
await writeFile(join(cwd, 'src', 'app.js'), 'const title = "Avant";\n');
await writeFile(join(cwd, 'obsolete.txt'), 'ancien fichier\n');
await writeFile(join(cwd, 'document.bin'), Buffer.from([0, 255, 8, 0]));
const jsonSource = '{"title":"Studio","id":9007199254740993123,"tools":["Python","Git"]}';
await writeFile(join(cwd, 'config.json'), jsonSource);
await writeFile(join(cwd, 'unsafe.html'), '<script>window.__fileXss = true</script><h1>Texte littéral</h1>');
await mkdir(join(cwd, 'md_files'));
await writeFile(
  join(cwd, 'md_files', 'PLAN.md'),
  '# Plan de reconnexion\n\nRetrouver une session après une interruption réseau, sur **PC et téléphone**.\n\n## Parcours prévu\n\n1. Afficher l’état de la connexion.\n2. Reprendre les messages à partir du dernier événement reçu.\n3. Conserver le brouillon et les pièces jointes.\n\n> Les agents continuent leur travail pendant la reconnexion.\n\n## Vérifications\n\n| Situation | Résultat attendu |\n| --- | --- |\n| Retour sur la page | Historique restauré |\n| Réseau rétabli | Réponses en direct |\n| Brouillon en cours | Texte conservé |\n\n[Les notes](../notes.md)',
);
const pdfStream = 'BT /F1 18 Tf 20 140 Td (Prime Agent Studio) Tj ET\n';
const pdfObjects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  `<< /Length ${Buffer.byteLength(pdfStream)} >>\nstream\n${pdfStream}endstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
let pdf = '%PDF-1.4\n';
const offsets = [0];
pdfObjects.forEach((object, index) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
  .slice(1)
  .map((offset) => String(offset).padStart(10, '0') + ' 00000 n ')
  .join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(join(cwd, 'report.pdf'), pdf);
await writeFile(
  join(cwd, 'image.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
    'base64',
  ),
);
await git('add', '.');
await git('commit', '-qm', 'Initial');
await writeFile(join(cwd, 'src', 'app.js'), 'const title = "Après";\n');
await rm(join(cwd, 'obsolete.txt'));
const markdownSource =
  '# Prochaine étape\n\nUne interface **lisible**, sur PC et téléphone.\n\n## À vérifier\n\n- Navigation des fichiers\n- Aperçu des documents\n\n> Le fichier original reste intact.\n\n| Fichier | État |\n| --- | --- |\n| app.js | Prêt |\n\n```js\nconst studio = "Prime Agent";\n```\n\n<script>window.__xss = true</script><img src=x onerror="window.__xss = true">\n';
await writeFile(join(cwd, 'notes.md'), markdownSource);
const rootId = 'inspector-root',
  childId = 'design-child',
  grandId = 'audit-grand';
const rootFile = join(sessionDir, 'root.jsonl');
const childFile = join(agentHome, 'session-artifacts', rootId, 'design', 'child.jsonl');
const grandFile = join(dirname(childFile), 'audit', 'grand.jsonl');
for (const [file, id, prompt, answer] of [
  [
    rootFile,
    rootId,
    'Construire une interface professionnelle',
    'Les agents travaillent sur le projet.\n\nDocument créé : [PLAN.md](md_files/PLAN.md). Voir aussi `config.json`.',
  ],
  [
    childFile,
    'design-session',
    'Améliorer la navigation',
    'Navigation et composants en cours de vérification.',
  ],
  [
    grandFile,
    'audit-session',
    'Vérifier les interactions',
    'Audit terminé.\n\n<script>window.__xss = true</script><img src=x onerror="window.__xss = true">',
  ],
]) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    [
      { type: 'session', id, cwd, timestamp: new Date().toISOString(), version: 3 },
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: prompt } },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        message: {
          role: 'assistant',
          model: 'gpt-5.6-luna',
          provider: 'openai-codex',
          content: [{ type: 'text', text: answer }],
          usage: { input: 16400, output: 2310, cacheRead: 8000, cost: { total: 0.013 } },
        },
      },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n',
  );
}
const originalRoot = await readFile(rootFile),
  originalIndex = await readFile(join(cwd, '.git', 'index'));
let starts = 0,
  cancellations = 0,
  finish,
  liveReads = 0;
const openedFiles = [];
const app = createApp({
  openFile: async (path) => {
    openedFiles.push(path);
    return { opened: true };
  },
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir: join(temp, 'data'),
  readInspectorEdges: async () => [
    { parent: rootFile, child: childFile, childId, name: 'Navigation' },
    { parent: childFile, child: grandFile, childId: grandId, name: 'Audit des interactions' },
  ],
  inspectorClient: {
    async getInspector() {
      liveReads++;
      return {
        state: { hasRunningRlmChildren: true },
        children: [
          {
            id: childId,
            parentId: rootId,
            sessionName: 'Navigation',
            status: 'done',
            activity: { kind: 'executing', toolName: 'ipython' },
            model: 'gpt-5.6-luna',
            recap: 'Vérification des composants de navigation.',
            toolUseCount: 12,
          },
          {
            id: grandId,
            parentId: childId,
            sessionName: 'Audit des interactions',
            status: 'done',
            model: 'gpt-5.6-luna',
            answerPreview: 'Interactions validées.',
          },
        ],
      };
    },
    close() {},
  },
  runtime: {
    async getStatus() {
      return { available: true, version: '0.9.2' };
    },
    async getModels() {
      return {
        models: [
          {
            id: 'openai-codex/gpt-5.6-luna',
            name: 'GPT-5.6 Luna',
            provider: 'openai-codex',
            reasoning: true,
          },
        ],
        default: { model: 'openai-codex/gpt-5.6-luna', thinking: 'high' },
      };
    },
    async start() {
      starts++;
      return {
        done: new Promise((done) => {
          finish = done;
        }),
        cancel() {
          cancellations++;
          finish({ status: 'stopped' });
        },
      };
    },
    async close() {
      finish?.({ status: 'completed' });
    },
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const local = `http://127.0.0.1:${app.server.address().port}`;
const run = await fetch(local + '/api/runs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: local },
  body: JSON.stringify({
    cwd,
    sessionId: rootId,
    message: 'Poursuivre la vérification',
    model: 'openai-codex/gpt-5.6-luna',
  }),
});
assert.equal(run.status, 201);
const salt = 'c'.repeat(32),
  code = '12345678';
const gateway = createLanGateway({
  host: '127.0.0.1',
  upstreamPort: app.server.address().port,
  config: { salt, codeHash: hashAccessCode(code, salt), readOnly: true },
});
await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${gateway.address().port}`;
const browser = await chromium.launch({ channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chrome', headless: true });
let page;
const errors = [],
  results = [];
async function bounds(selector, width, height) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(
    box && box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1,
    `${selector} must fit ${width} × ${height}: ${JSON.stringify(box)}`,
  );
}
try {
  assert.equal((await fetch(url + `/api/project-files?cwd=${encodeURIComponent(cwd)}`)).status, 401);
  assert.equal(
    (await fetch(url + `/api/project-files/open?${new URLSearchParams({ cwd, path: 'config.json' })}`))
      .status,
    401,
  );
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    const mobile = viewport.width < 1080;
    const context = await browser.newContext({
      locale: 'fr-FR',
      viewport,
      isMobile: mobile,
      hasTouch: mobile,
      acceptDownloads: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator('#code').fill(code);
    await page.getByRole('button', { name: 'Ouvrir le studio' }).click();
    await expect(page.locator('#connection-label')).toHaveText('Moteur connecté');
    if (mobile) await page.locator('#toggle-sidebar').click();
    await page
      .locator('#session-list .session-select')
      .filter({ hasText: 'Construire une interface' })
      .click();
    if (mobile || !(await page.locator('#details-panel').isVisible()))
      await page.locator('#toggle-details').click();
    await expect(page.locator('#detail-status')).toContainText('Attend ses sous-agents');
    await expect(page.locator('#inspector-usage')).toContainText('16,4');
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await expect(page.locator('.inspector-agent')).toHaveCount(3);
    await expect(page.locator(`[data-agent-id="${childId}"]`)).toContainText('Exécute un outil');
    await expect(page.locator(`[data-agent-id="${grandId}"]`)).toContainText('niveau 2');
    const offsets = await page.locator('.inspector-agent').evaluateAll((cards) =>
      cards.map((card) => ({
        left: card.getBoundingClientRect().left,
        depth: card.style.getPropertyValue('--agent-depth'),
        width: getComputedStyle(card).width,
        margin: getComputedStyle(card).marginLeft,
      })),
    );
    assert.ok(
      offsets[0].left < offsets[1].left && offsets[1].left < offsets[2].left,
      `Nested agents must be indented: ${JSON.stringify(offsets)}`,
    );
    await bounds('#details-panel', viewport.width, viewport.height);
    await page.screenshot({ path: `test-results/inspector-agents-${viewport.width}.png` });
    await page.locator(`[data-agent-id="${grandId}"]`).click();
    await expect(page.locator('#inspector-view-body')).toContainText('Audit terminé.');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    await bounds('#inspector-viewer', viewport.width, viewport.height);
    await page.keyboard.press('Escape');
    await expect(page.locator('#inspector-viewer')).not.toBeVisible();
    await expect(page.locator('#details-panel')).toBeVisible();
    await expect(page.locator(`[data-agent-id="${grandId}"]`)).toBeFocused();
    await page.getByRole('tab', { name: 'Fichiers', exact: true }).click();
    await expect(page.locator('.inspector-file')).toHaveCount(3);
    await page.locator('[data-file-path="src/app.js"]').click();
    await expect(page.locator('.diff-add')).toContainText('Après');
    await expect(page.locator('.diff-remove')).toContainText('Avant');
    await bounds('#inspector-viewer', viewport.width, viewport.height);
    await page.screenshot({ path: `test-results/inspector-diff-${viewport.width}.png` });
    if (mobile) {
      await page.evaluate(() => {
        for (const [name, value] of Object.entries({
          '--studio-top': '30px',
          '--studio-height': '450px',
          '--studio-safe-top': '24px',
          '--studio-safe-bottom': '28px',
        }))
          document.documentElement.style.setProperty(name, value);
      });
      const short = await page.locator('#inspector-viewer').boundingBox();
      assert.ok(
        short.y >= 54 && short.y + short.height <= 452,
        'Preview must respect a panned viewport and system insets',
      );
      await page.evaluate(() => {
        for (const name of ['--studio-top', '--studio-height', '--studio-safe-top', '--studio-safe-bottom'])
          document.documentElement.style.removeProperty(name);
        visualViewport.dispatchEvent(new Event('resize'));
      });
    }
    await expect(page.locator('.inspector-open')).toHaveCount(0);
    assert.equal(
      (
        await context.request.post(url + '/api/project-files/open', { data: { cwd, path: 'src/app.js' } })
      ).status(),
      405,
    );
    const rawFile = await context.request.get(
      url + `/api/project-files/download?${new URLSearchParams({ cwd, path: 'src/app.js' })}`,
    );
    assert.equal(await rawFile.text(), 'const title = "Après";\n');
    assert.match(rawFile.headers()['content-disposition'], /^attachment;/);
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.locator('[data-file-path="obsolete.txt"]').click();
    await expect(page.getByRole('link', { name: 'Ouvrir', exact: true })).toHaveCount(0);
    await expect(page.locator('.diff-remove')).toContainText('ancien fichier');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Parcourir', exact: true }).click();
    await page.getByRole('button', { name: 'Consulter document.bin', exact: true }).click();
    await expect(page.locator('#inspector-view-body')).toContainText('Aperçu indisponible');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Consulter image.png', exact: true }).click();
    await expect(page.locator('.inspector-preview-image')).toBeVisible();
    await expect
      .poll(() => page.locator('.inspector-preview-image').evaluate((image) => image.naturalWidth))
      .toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Ouvrir le dossier src', exact: true }).click();
    await expect(page.locator('#inspector-file-breadcrumb')).toContainText('src');
    await page.getByRole('button', { name: 'Consulter app.js', exact: true }).click();
    await expect(page.locator('.inspector-code')).toContainText('Après');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Projet', exact: true }).click();
    await page.getByRole('button', { name: 'Consulter notes.md', exact: true }).click();
    await expect(page.locator('.inspector-document h1')).toHaveText('Prochaine étape');
    await expect(page.locator('.inspector-document h2')).toHaveText('À vérifier');
    await expect(page.locator('.inspector-document strong')).toHaveText('lisible');
    await expect(page.locator('.inspector-document li')).toHaveCount(2);
    await expect(page.locator('.inspector-document table')).toContainText('app.js');
    await expect(page.locator('.inspector-document pre code')).toContainText('const studio');
    await expect(page.locator('.inspector-document script')).toHaveCount(0);
    await page.screenshot({
      path: `test-results/inspector-markdown-${viewport.width}.png`,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(page.locator('.inspector-code')).toContainText('<script>');
    assert.equal(await page.locator('.inspector-code').textContent(), markdownSource);
    await page.getByRole('button', { name: 'Aperçu', exact: true }).click();
    await expect(page.locator('.inspector-document h1')).toBeVisible();
    await bounds('#inspector-viewer', viewport.width, viewport.height);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Consulter config.json', exact: true }).click();
    await expect(page.locator('.inspector-code')).toContainText('9007199254740993123');
    assert.match(await page.locator('.inspector-code').textContent(), /\n  "title": "Studio"/);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    assert.equal(await page.locator('.inspector-code').textContent(), jsonSource);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Consulter unsafe.html', exact: true }).click();
    await expect(page.locator('.inspector-code')).toContainText('<script>');
    assert.equal(await page.evaluate(() => window.__fileXss), undefined);
    await page.keyboard.press('Escape');
    const noGetOpen = await context.request.get(
      url + `/api/project-files/open?${new URLSearchParams({ cwd, path: 'report.pdf' })}`,
    );
    assert.equal(noGetOpen.status(), 404);
    await page.locator('#inspector-tab-files').focus();
    await page.keyboard.press('Home');
    await expect(page.locator('#inspector-tab-session')).toHaveAttribute('aria-selected', 'true');
    if (mobile) {
      await expect(page.locator('.conversation-column')).toHaveAttribute('inert', '');
      await page.locator('#close-inspector').focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(
        await page.evaluate(() => document.querySelector('#details-panel').contains(document.activeElement)),
        true,
      );
      await page.keyboard.press('Escape');
      await expect(page.locator('#details-panel')).not.toBeVisible();
      await expect(page.locator('#toggle-details')).toBeFocused();
      assert.equal(await page.locator('.conversation-column').evaluate((element) => element.inert), false);
    } else {
      await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
      await page.locator('#inspector-tab-agents').click();
      await page.screenshot({ path: 'test-results/inspector-agents-light.png' });
    }
    const protectedResponse = await context.request.get(
      url + `/api/project-files/preview?${new URLSearchParams({ cwd, path: '.git/config' })}`,
    );
    assert.equal(protectedResponse.status(), 403);
    assert.equal(
      (
        await context.request.get(
          url +
            `/api/inspector/history?${new URLSearchParams({ cwd, sessionId: rootId, agentId: 'unrelated' })}`,
        )
      ).status(),
      404,
    );
    assert.equal(
      (await context.request.post(url + '/api/runs', { data: { cwd, message: 'not allowed' } })).status(),
      405,
    );
    results.push({ ...viewport, passed: true });
    await context.close();
  }
  // Editable local chat keeps its unsent draft while opening and closing both kinds of details.
  page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1440, height: 960 } });
  await page.goto(local);
  await page.locator('#session-list .session-select').first().click();
  await page.locator('#composer').fill('Brouillon à conserver');
  await page.locator('#inspector-tab-agents').click();
  await expect(page.locator('.inspector-agent')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/desktop-inspector-agents.png', animations: 'disabled' });
  await captureEnglishDocumentation(page, 'desktop-inspector-agents.png');
  await page.locator(`[data-agent-id="${childId}"]`).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#composer')).toHaveValue('Brouillon à conserver');
  await page.locator('.assistant-text .document-link').filter({ hasText: 'PLAN.md' }).click();
  await expect(page.locator('.inspector-document h1')).toHaveText('Plan de reconnexion');
  const pagesBefore = page.context().pages().length;
  await page.getByRole('button', { name: 'Ouvrir', exact: true }).click();
  await expect(page.locator('.inspector-open-feedback')).toContainText('Ouverture demandée');
  assert.equal(openedFiles.at(-1), join(cwd, 'md_files', 'PLAN.md'));
  assert.equal(page.context().pages().length, pagesBefore, 'Native open must not create browser tabs');
  await page.screenshot({ path: 'test-results/inspector-document-link.png', animations: 'disabled' });
  await captureEnglishDocumentation(page, 'desktop-document-preview.png');
  await page.locator('.inspector-document .document-link').filter({ hasText: 'Les notes' }).click();
  await expect(page.locator('.inspector-document h1')).toHaveText('Prochaine étape');
  await page.keyboard.press('Escape');
  await expect(page.locator('#composer')).toHaveValue('Brouillon à conserver');
  await page.locator('.assistant-text .document-link').filter({ hasText: 'config.json' }).click();
  await expect(page.locator('.inspector-code')).toContainText('9007199254740993123');
  await page.keyboard.press('Escape');
  const controlGateway = createLanGateway({
    host: '127.0.0.1',
    upstreamPort: app.server.address().port,
    config: { salt, codeHash: hashAccessCode(code, salt), readOnly: false },
  });
  await new Promise((done) => controlGateway.listen(0, '127.0.0.1', done));
  try {
    const mobile = await browser.newPage({
      locale: 'fr-FR',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const controlUrl = `http://127.0.0.1:${controlGateway.address().port}`;
    await mobile.goto(controlUrl);
    await mobile.locator('#code').fill(code);
    await mobile.getByRole('button', { name: 'Ouvrir le studio' }).click();
    await expect(mobile.locator('#connection-label')).toHaveText('Moteur connecté');
    await mobile.locator('#toggle-sidebar').click();
    await mobile.locator('#session-list .session-select').first().click();
    await mobile.locator('.assistant-text .document-link').filter({ hasText: 'PLAN.md' }).click();
    await expect(mobile.locator('.inspector-document h1')).toHaveText('Plan de reconnexion');
    await mobile.getByRole('button', { name: 'Ouvrir sur le PC', exact: true }).click();
    await expect(mobile.locator('.inspector-open-feedback')).toContainText('Ouverture demandée');
    assert.equal(openedFiles.at(-1), join(cwd, 'md_files', 'PLAN.md'));
    await mobile.screenshot({ path: 'test-results/inspector-document-mobile.png', animations: 'disabled' });
    const protectedOpen = await mobile.request.post(controlUrl + '/api/project-files/open', {
      data: { cwd, path: '../private.md' },
    });
    assert.equal(protectedOpen.status(), 403);
    await mobile.close();
  } finally {
    controlGateway.closeAllConnections();
    await new Promise((done) => controlGateway.close(done));
  }
  assert.equal(starts, 1);
  assert.equal(cancellations, 0);
  assert.ok(liveReads >= 1);
  assert.deepEqual(await readFile(rootFile), originalRoot);
  assert.equal(await readFile(join(cwd, 'notes.md'), 'utf8'), markdownSource);
  assert.equal(await readFile(join(cwd, 'config.json'), 'utf8'), jsonSource);
  assert.deepEqual(await readFile(join(cwd, '.git', 'index')), originalIndex);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, viewports: results, readOnlyRemote: true, sessionsPreserved: true }),
  );
} catch (error) {
  await page?.screenshot({ path: 'test-results/inspector-failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  finish?.({ status: 'completed' });
  await app.close();
  assert.equal(dirname(temp), resolve(tmpdir()));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
