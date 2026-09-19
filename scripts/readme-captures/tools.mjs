// Isolated README captures — tools & context family (FR + EN).
//
// Captures the real Studio UI with fictional fixtures only. No user provider
// account, no real MCP server, no native agent and no secret is used.
// Loopback server on a random port, temporary agentHome/dataDir/sessionDir/cwd.
// Transparency lives in report.json + README captions, never as a UI overlay.
//
// Usage:
//   node scripts/readme-captures/tools.mjs [--output <dir>] [--lang fr|en]
// Defaults: --output .local/readme-refresh/tools, both languages.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, expect as baseExpect } from '@playwright/test';
import { createApp } from '../../server.mjs';
import { createMcpService } from '../../lib/mcp-service.mjs';

const exec = promisify(execFile);
const expect = baseExpect.configure({ timeout: 15000 });
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const args = { output: join(REPO, '.local', 'readme-refresh', 'tools'), lang: 'both' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output') args.output = resolve(argv[++i] ?? '');
    else if (argv[i] === '--lang' && ['fr', 'en'].includes(argv[i + 1])) args.lang = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}
const ARGS = parseArgs(process.argv.slice(2));
const LANGS = ARGS.lang === 'both' ? ['fr', 'en'] : [ARGS.lang];

// Demonstration strings. Ids, counts and file names stay identical in FR/EN;
// visible demo text is translated so each screenshot reads in its own language.
const STRINGS = {
  fr: {
    locale: 'fr-FR',
    connected: 'Moteur connecté',
    configured: 'Configuré',
    viewFile: 'Consulter',
    before: 'Avant',
    quotaPlan: 'Équipe',
    docTitle: 'Prochaine étape',
    calibrationTitle: 'Calibrer la sortie audio à 48 kHz',
    calibrationAnswer:
      'La calibration utilise une réponse impulsionnelle mesurée à **48 kHz**. Le rapport final confirme la stabilité des canaux gauche et droit.',
    exportTitle: 'Exporter les filtres pour Equalizer APO',
    exportAnswer:
      'Pour exporter, conserver les canaux indépendants et documenter le gain maximal. Le filtre doit rester au format WAV.',
    docsTitle: 'Documenter le protocole de mesure',
    docsAnswer: 'La documentation décrit le microphone, son emplacement et le niveau sonore.',
    refinementSummary: 'Préciser la validation des filtres audio',
    refinementRationale: 'Le contrôle initial ne précisait ni la fréquence ni les preuves à conserver.',
    refinementOutcome: 'Des vérifications reproductibles à chaque nouvelle calibration.',
    memoryBefore: 'Vérifier le filtre avant distribution.',
    memoryAfter:
      'Valider le filtre à 48 kHz, mesurer la réponse impulsionnelle et conserver le rapport de mesure.',
    memoryTitle: 'Validation audio',
    globalTitle: 'Lancements Windows discrets',
    globalContent: 'Les utilitaires en arrière-plan doivent démarrer sans prendre le focus.',
    childName: 'Recherche sur la convolution',
    childAnswer:
      'La convolution applique le filtre mesuré sans perdre la correction de phase. Vérification terminée par le sous-agent.',
    agentMain: 'Agent principal',
    agentNav: 'Navigation et clavier',
    agentNavPreview: 'Navigation et raccourcis vérifiés.',
    agentReview: 'Relecture de l’interface',
    agentReviewPreview: 'Libellés, contrastes et états vides relus.',
    skillDescription: 'Concevoir une interface accessible',
    promptDescription: 'Relire un fichier',
    notesMd: `# Prochaine étape

Une interface **lisible**, sur PC et téléphone.

## À vérifier

- Navigation des fichiers
- Aperçu des documents

> Le fichier original reste intact.

| Fichier | État |
| --- | --- |
| app.js | Prêt |
`,
    planMd: `# Plan de démonstration

Préparer une capture **lisible** du visualiseur de fichiers.
`,
    appBefore: 'const title = "Avant";\n',
    appAfter: 'const title = "Après";\n',
  },
  en: {
    locale: 'en-US',
    connected: 'Engine connected',
    configured: 'Configured',
    viewFile: 'View',
    before: 'Before',
    quotaPlan: 'Team',
    docTitle: 'Next step',
    calibrationTitle: 'Calibrate the audio output at 48 kHz',
    calibrationAnswer:
      'Calibration uses an impulse response measured at **48 kHz**. The final report confirms left and right channel stability.',
    exportTitle: 'Export filters for Equalizer APO',
    exportAnswer:
      'For export, keep independent channels and document the maximum gain. Filters must stay in WAV format.',
    docsTitle: 'Document the measurement protocol',
    docsAnswer: 'The documentation describes the microphone, its placement and the sound level.',
    refinementSummary: 'Clarify the audio filter validation',
    refinementRationale: 'The initial check stated neither the frequency nor the evidence to keep.',
    refinementOutcome: 'Reproducible checks for every new calibration.',
    memoryBefore: 'Check the filter before release.',
    memoryAfter:
      'Validate the filter at 48 kHz, measure the impulse response and keep the measurement report.',
    memoryTitle: 'Audio validation',
    globalTitle: 'Quiet Windows launches',
    globalContent: 'Background utilities must start without stealing focus.',
    childName: 'Convolution research',
    childAnswer:
      'Convolution applies the measured filter without losing phase correction. Sub-agent review complete.',
    agentMain: 'Main agent',
    agentNav: 'Navigation and keyboard',
    agentNavPreview: 'Navigation and shortcuts reviewed.',
    agentReview: 'Interface review',
    agentReviewPreview: 'Labels, contrast and empty states reviewed.',
    skillDescription: 'Design an accessible interface',
    promptDescription: 'Review a file',
    notesMd: `# Next step

A **readable** interface, on desktop and phone.

## To check

- File navigation
- Document preview

> The original file stays untouched.

| File | Status |
| --- | --- |
| app.js | Ready |
`,
    planMd: `# Demonstration plan

Prepare a **readable** capture of the file viewer.
`,
    appBefore: 'const title = "Before";\n',
    appAfter: 'const title = "After";\n',
  },
};
const MODEL = 'openai-codex/gpt-5.6-luna';

async function git(cwd, ...args) {
  await exec('git', ['-C', cwd, ...args], { windowsHide: true });
}

// Builds the isolated fixture tree. Everything is synthetic; nothing is read
// from the user's agent home, projects or provider accounts.
async function buildFixture(S) {
  const tmp = await mkdtemp(join(tmpdir(), 'prime-readme-tools-'));
  const agentHome = join(tmp, 'agent');
  const sessionDir = join(tmp, 'sessions');
  const dataDir = join(tmp, 'data');
  const cwd = join(tmp, 'Atelier');
  const otherCwd = join(tmp, 'Documentation');
  for (const dir of [
    agentHome,
    sessionDir,
    dataDir,
    cwd,
    otherCwd,
    join(cwd, '.prime', 'agent', 'skills', 'design'),
    join(cwd, '.prime', 'agent', 'prompts'),
    join(cwd, 'md_files'),
    join(cwd, 'src'),
    join(agentHome, 'harness'),
  ])
    await mkdir(dir, { recursive: true });

  // Provider + MCP fixtures: one stored API key (never rendered in the UI), one
  // documentation MCP on a reserved .test domain. Secrets stay masked by the
  // real implementation, exactly as with user credentials.
  await writeFile(
    agentHome + '/auth.json',
    JSON.stringify({ openai: { type: 'api_key', key: 'private-fixture-openai' } }),
  );
  await writeFile(agentHome + '/models.json', '{"providers":{}}');
  await writeFile(
    agentHome + '/settings.json',
    JSON.stringify({ mcpServers: { documentation: { type: 'http', url: 'https://docs.example.test/mcp' } } }),
  );

  // Command fixtures: one project skill + one project prompt.
  await writeFile(
    join(cwd, '.prime', 'agent', 'skills', 'design', 'SKILL.md'),
    `---\nname: design\ndescription: ${S.skillDescription}\n---\nFixture only.\n`,
  );
  await writeFile(
    join(cwd, '.prime', 'agent', 'prompts', 'review.md'),
    `---\ndescription: ${S.promptDescription}\n---\nReview $1\n`,
  );

  // Git project with a Markdown document for the file-viewer capture.
  await writeFile(join(cwd, 'notes.md'), S.notesMd);
  await writeFile(join(cwd, 'md_files', 'PLAN.md'), S.planMd);
  await writeFile(
    join(cwd, 'config.json'),
    '{"title":"Studio","id":9007199254740993123,"tools":["Python","Git"]}',
  );
  await writeFile(join(cwd, 'src', 'app.js'), S.appBefore);
  await git(cwd, 'init', '-q');
  await git(cwd, 'config', 'user.name', 'Fixture');
  await git(cwd, 'config', 'user.email', 'fixture@example.test');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-qm', 'Initial');
  await writeFile(join(cwd, 'src', 'app.js'), S.appAfter);

  // Session fixtures double as conversation content and knowledge history.
  const ts = (hour) => `2026-09-08T${hour}:00:00Z`;
  const sessionFile = async (id, title, answer, hour, extra = []) => {
    const entries = [
      { type: 'session', id, cwd, timestamp: ts(hour) },
      { type: 'session_info', id: `${id}-name`, parentId: null, name: title, timestamp: ts(hour) },
      {
        type: 'message',
        id: `${id}-user`,
        parentId: `${id}-name`,
        timestamp: ts(hour),
        message: { role: 'user', content: title },
      },
      {
        type: 'message',
        id: `${id}-answer`,
        parentId: `${id}-user`,
        timestamp: ts(hour),
        message: { role: 'assistant', content: answer, stopReason: 'stop' },
      },
      ...extra,
    ];
    await writeFile(join(sessionDir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };
  const refinement = {
    id: 'refine-audio-2',
    summary: S.refinementSummary,
    rationale: S.refinementRationale,
    expectedOutcome: S.refinementOutcome,
    appliedEdits: [
      {
        action: 'update',
        kind: 'memory',
        id: 'calibration',
        applied: true,
        before: {
          id: 'calibration',
          title: S.memoryTitle,
          content: S.memoryBefore,
          version: 1,
          scope: 'session',
        },
        after: {
          id: 'calibration',
          title: S.memoryTitle,
          content: S.memoryAfter,
          version: 2,
          updated_at: ts('16'),
        },
      },
    ],
  };
  await sessionFile('calibration-demo', S.calibrationTitle, S.calibrationAnswer, '15', [
    {
      type: 'custom',
      customType: 'prime-agent.refinement',
      id: 'refinement-entry',
      parentId: 'calibration-demo-answer',
      timestamp: ts('16'),
      data: refinement,
    },
  ]);
  await sessionFile('filter-export', S.exportTitle, S.exportAnswer, '14');
  await sessionFile('docs-audio', S.docsTitle, S.docsAnswer, '13');
  await writeFile(
    join(sessionDir, 'other.jsonl'),
    [
      { type: 'session', id: 'other-project', cwd: otherCwd, timestamp: ts('16') },
      {
        type: 'message',
        id: 'other-user',
        parentId: null,
        message: { role: 'user', content: 'Planifier la migration du volant' },
      },
      {
        type: 'message',
        id: 'other-answer',
        parentId: 'other-user',
        message: { role: 'assistant', content: 'PROJECT_BOUNDARY_SENTINEL', stopReason: 'stop' },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  );

  // Native harness memories (session + global) and one finished sub-agent trace.
  const artifact = join(sessionDir, 'session-artifacts', 'calibration-demo');
  await mkdir(join(artifact, 'harness'), { recursive: true });
  await writeFile(
    join(artifact, 'harness', 'harness_state.json'),
    JSON.stringify({ entries: { memory: { calibration: refinement.appliedEdits[0].after } } }),
  );
  await mkdir(join(artifact, 'sub-audio-research'), { recursive: true });
  await writeFile(
    join(artifact, 'sub-audio-research', 'child-closed.jsonl'),
    [
      { type: 'session', id: 'child-closed', cwd, timestamp: ts('14') },
      { type: 'session_info', id: 'child-name', parentId: null, name: S.childName, timestamp: ts('14') },
      {
        type: 'message',
        id: 'child-answer',
        parentId: 'child-name',
        timestamp: ts('14'),
        message: { role: 'assistant', content: S.childAnswer, stopReason: 'stop' },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  );
  await writeFile(
    join(agentHome, 'harness', 'harness_state.json'),
    JSON.stringify({
      entries: {
        memory: {
          'windows-launch': {
            id: 'windows-launch',
            title: S.globalTitle,
            content: S.globalContent,
            version: 1,
            scope: 'global',
            created_at: '2026-09-07T09:00:00Z',
          },
        },
      },
    }),
  );
  return { tmp, agentHome, sessionDir, dataDir, cwd, otherCwd };
}

function createFixtureApp(fixture) {
  const nativeMcp = createMcpService({ agentHome: fixture.agentHome });
  return createApp({
    agentHome: fixture.agentHome,
    sessionDir: fixture.sessionDir,
    dataDir: fixture.dataDir,
    initialCwd: fixture.cwd,
    runtime: {
      getStatus: async () => ({ available: true, version: '0.9.4' }),
      getModels: async () => ({
        models: [
          {
            id: MODEL,
            name: 'GPT-5.6 Luna',
            provider: 'openai-codex',
            reasoning: true,
            thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
          },
          {
            id: 'openai-codex/gpt-5.6-sol',
            name: 'GPT-5.6 Sol',
            provider: 'openai-codex',
            reasoning: true,
            thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
          },
        ],
        configuredProviders: ['openai-codex'],
        default: { model: MODEL, thinking: 'high' },
      }),
      start: async () => {
        throw new Error('Screenshot fixtures cannot start an agent.');
      },
      close: async () => {},
    },
    mcp: {
      ...nativeMcp,
      probe: async () => ({
        total: 1,
        tools: [
          {
            name: 'rechercher',
            description: 'Recherche une entrée de démonstration.',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      }),
    },
    openDirectory: async () => ({ opened: true }),
    openFile: async () => ({ opened: true }),
  });
}

// Demonstration inspector/quota payloads served over Playwright routes only.
// The components, dialogs and interactions stay the real implementation.
function inspectorPayload(S) {
  return {
    session: {
      id: 'calibration-demo',
      status: 'idle',
      usage: { input: 28600, output: 3420, cache: 12600, cost: 0.0042 },
      contextUsage: { tokens: 38400, contextWindow: 128000, percent: 30 },
    },
    contextUsage: { tokens: 38400, contextWindow: 128000, percent: 30 },
    live: false,
    notes: [],
    agents: [
      {
        id: 'calibration-demo',
        root: true,
        name: S.agentMain,
        status: 'idle',
        model: MODEL,
        thinking: 'high',
        usage: { input: 28600, output: 3420, cache: 12600, cost: 0.0042 },
      },
      {
        id: 'demo-design',
        parentId: 'calibration-demo',
        name: S.agentNav,
        status: 'saved',
        model: MODEL,
        thinking: 'high',
        preview: S.agentNavPreview,
        history: true,
        toolUseCount: 8,
      },
      {
        id: 'demo-review',
        parentId: 'calibration-demo',
        name: S.agentReview,
        status: 'saved',
        model: MODEL,
        thinking: 'medium',
        preview: S.agentReviewPreview,
        history: true,
        toolUseCount: 5,
      },
    ],
    truncated: false,
  };
}
const SHOTS = [
  { name: 'desktop-session.png' },
  { name: 'desktop-inspector-agents.png', optional: true },
  { name: 'desktop-providers.png' },
  { name: 'desktop-mcp.png' },
  { name: 'desktop-commands.png' },
  { name: 'desktop-document-preview.png' },
  { name: 'desktop-knowledge.png' },
];

async function runLanguage(lang, browser, report) {
  const S = STRINGS[lang];
  const fixture = await buildFixture(S);
  const outDir = join(ARGS.output, lang);
  const captures = [];
  const pageErrors = [];
  let current = null;
  const check = async (label, fn) => {
    await fn();
    current.assertions.push(label);
  };
  let app;
  let context;
  try {
    app = createFixtureApp(fixture);
    await app.store.project({ cwd: fixture.cwd });
    await app.store.project({ cwd: fixture.otherCwd });
    await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${app.server.address().port}`;

    context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      locale: S.locale,
      reducedMotion: 'reduce',
    });
    await context.route('**/api/inspector?*', (route) => route.fulfill({ json: inspectorPayload(S) }));
    await context.route('**/api/providers/codex-link', (route) =>
      route.fulfill({ json: { provider: 'openai-codex', linked: true, revision: 'a'.repeat(64) } }),
    );
    await context.route('**/api/providers/codex-usage?*', (route) =>
      route.fulfill({
        json: {
          available: true,
          provider: 'openai-codex',
          plan: S.quotaPlan,
          weekly: {
            usedPercent: 32,
            remainingPercent: 68,
            resetAt: Date.now() + 3 * 86400000,
            windowSeconds: 604800,
          },
          fetchedAt: Date.now(),
        },
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    page.on('request', (request) => {
      assert.equal(new URL(request.url()).origin, url, 'Only the isolated server is allowed');
    });
    await page.addInitScript(
      ({ cwd, lang }) => {
        localStorage.setItem('prime-studio.language', lang);
        localStorage.setItem('prime-studio.preferences', JSON.stringify({ theme: 'dark', details: true }));
        localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd }));
      },
      { cwd: fixture.cwd, lang },
    );
    await page.goto(url);
    await expect(page.locator('#connection-label')).toHaveText(S.connected);

    async function shot(name, target, isPage) {
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(1590, 990);
      const file = join(outDir, name);
      await mkdir(dirname(file), { recursive: true });
      if (isPage) await page.screenshot({ path: file, animations: 'disabled' });
      else await target.screenshot({ path: file, animations: 'disabled' });
      const box = isPage ? { width: 1600, height: 1000 } : await target.boundingBox();
      const bytes = (await stat(file)).size;
      assert.ok(bytes > 20000, `Capture looks empty: ${file} (${bytes} bytes)`);
      assert.ok(box && box.width > 400 && box.height > 200, `Unexpected capture box for ${name}`);
      current.file = relative(REPO, file);
      current.width = Math.round(box.width);
      current.height = Math.round(box.height);
      current.bytes = bytes;
      captures.push(current);
      current = null;
    }
    const begin = (name) => {
      current = { name, language: lang, file: '', width: 0, height: 0, bytes: 0, assertions: [] };
    };
    async function closeDialogs() {
      await page.keyboard.press('Escape');
      for (const selector of ['#providers-dialog', '#mcp-dialog', '#commands-dialog', '#knowledge-dialog']) {
        assert.equal(await page.locator(selector).count(), 1, `${selector} must exist exactly once`);
      }
    }

    // Open the demonstration session with real store data.
    await page.locator('#session-list .session-select').filter({ hasText: S.calibrationTitle }).click();
    await expect(page.locator('#header-session')).toHaveText(S.calibrationTitle);
    await expect(page.locator('#composer')).toBeVisible();
    if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
    await expect(page.locator('#details-panel')).toBeVisible();

    // 1. Session context: usage, live context window and quota bars.
    begin('desktop-session.png');
    await page.locator('#inspector-tab-session').click();
    await check('usage section visible', () => expect(page.locator('#inspector-usage')).toBeVisible());
    await check('context line visible', () =>
      expect(page.locator('.session-context-line').first()).toBeVisible(),
    );
    await check('quota refresh paints bars', async () => {
      await page.locator('.session-quota-refresh').click();
      await expect(page.locator('.quota-bars')).toBeVisible();
      await page.locator('#inspector-quota').scrollIntoViewIfNeeded();
    });
    await shot('desktop-session.png', null, true);

    // 2. Delegations (optional: the core group shoots new sub-agents separately).
    begin('desktop-inspector-agents.png');
    await page.locator('#inspector-tab-agents').click();
    await check('three demonstration agents listed', () =>
      expect(page.locator('.inspector-agent')).toHaveCount(3),
    );
    await shot('desktop-inspector-agents.png', null, true);
    await page.locator('#inspector-tab-session').click();

    // 3. Provider connections.
    begin('desktop-providers.png');
    if (!(await page.locator('#settings-dialog').isVisible())) await page.locator('#open-settings').click();
    await page.locator('#settings-tab-models').click();
    await page.locator('#open-provider-settings').click();
    const providersDialog = page.locator('#providers-dialog');
    await check('providers dialog visible', () => expect(providersDialog).toBeVisible());
    await check('provider cards listed', () => expect(page.locator('.provider-card').first()).toBeVisible());
    await check('fixture provider shown as configured', () =>
      expect(page.locator('[data-provider="openai"]')).toContainText(S.configured),
    );
    await check('stored key never rendered', async () => {
      assert.doesNotMatch(await providersDialog.textContent(), /private-fixture/);
    });
    await shot('desktop-providers.png', providersDialog, false);
    await page.locator('#providers-done').click();
    await page.locator('#settings-dialog .primary-button[data-close-dialog]').click();
    await expect(page.locator('#settings-dialog')).toBeHidden();

    // 4. MCP connections.
    begin('desktop-mcp.png');
    await page.locator('#open-settings').click();
    await page.locator('#settings-tab-tools').click();
    await page.locator('#open-mcp-settings').click();
    const mcpDialog = page.locator('#mcp-dialog');
    await check('mcp dialog visible', () => expect(mcpDialog).toBeVisible());
    await check('mcp cards listed', async () => {
      await expect(page.locator('.mcp-card').first()).toBeVisible();
      await expect
        .poll(() => page.locator('.mcp-card').count(), { timeout: 10000 })
        .toBeGreaterThanOrEqual(2);
    });
    await check('fixture MCP listed', () => expect(mcpDialog).toContainText('documentation'));
    await shot('desktop-mcp.png', mcpDialog, false);
    await page.locator('#mcp-close').click();
    await page.locator('#settings-dialog .primary-button[data-close-dialog]').click();
    await expect(page.locator('#settings-dialog')).toBeHidden();

    // 5. Slash palette: studio commands, project skill and project prompt.
    begin('desktop-commands.png');
    await check('command launcher enabled', () => expect(page.locator('#open-commands')).toBeEnabled());
    await page.locator('#open-commands').click();
    const commandsDialog = page.locator('#commands-dialog');
    await check('commands dialog visible', () => expect(commandsDialog).toBeVisible());
    await check('catalog items listed', async () => {
      assert.ok((await page.locator('.command-item').count()) >= 2, 'Expected catalog items');
    });
    await check('project skill listed', () => expect(commandsDialog).toContainText('/skill:design'));
    // One frame holds the project prompt (/review), studio commands and the
    // first skills: scroll the prompt row to the top of the catalog list.
    await check('commands, prompt and skills in one frame', async () => {
      await expect
        .poll(() => commandsDialog.locator('.command-item').count(), { timeout: 10000 })
        .toBeGreaterThanOrEqual(10);
      const promptRow = commandsDialog.locator('.command-item').filter({ hasText: '/review' }).first();
      await promptRow.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await expect(promptRow).toBeInViewport();
      await expect(
        commandsDialog.locator('.command-item').filter({ hasText: '/skill:' }).first(),
      ).toBeInViewport();
      await expect(commandsDialog).toContainText('/skill:design');
    });
    await check('skill/prompt/terminal filters present', async () => {
      for (const label of ['Skills', 'Prompts', 'Terminal']) {
        await expect(commandsDialog.getByRole('button', { name: label, exact: true })).toBeVisible();
      }
    });
    await shot('desktop-commands.png', commandsDialog, false);
    await page.keyboard.press('Escape');
    await expect(commandsDialog).toBeHidden();

    // 6. Markdown document inside the real file viewer (Git project).
    begin('desktop-document-preview.png');
    await page.locator('#inspector-tab-files').click();
    await page.locator('#files-all').click();
    await page.getByRole('button', { name: `${S.viewFile} notes.md`, exact: true }).click();
    const viewer = page.locator('#inspector-viewer');
    await check('markdown preview rendered', () =>
      expect(viewer.locator('.inspector-document h1')).toHaveText(S.docTitle),
    );
    await shot('desktop-document-preview.png', viewer, false);
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();

    // 7. Project knowledge: history, memories and refinements.
    begin('desktop-knowledge.png');
    await page
      .locator('.project-entry')
      .filter({ has: page.locator('.project-label', { hasText: 'Atelier' }) })
      .locator('.project-more')
      .click();
    await page.locator('[data-project-action="knowledge"]').click();
    const knowledgeDialog = page.locator('#knowledge-dialog');
    await check('knowledge dialog visible', () => expect(knowledgeDialog).toBeVisible());
    await page.locator('[data-kind="refinement"]').click();
    await check('one refinement result', () => expect(page.locator('.knowledge-result')).toHaveCount(1));
    await page.locator('.knowledge-result').first().click();
    await check('before/after change rendered', async () => {
      await expect(page.locator('.knowledge-change-pair')).toBeVisible();
      await expect(page.locator('.knowledge-change-pair')).toContainText(S.before);
    });
    await shot('desktop-knowledge.png', knowledgeDialog, false);
    await page.keyboard.press('Escape');
    await expect(knowledgeDialog).toBeHidden();

    await closeDialogs();
    assert.deepEqual(pageErrors, [], `Page errors in ${lang}: ${JSON.stringify(pageErrors)}`);
  } finally {
    await context?.close().catch(() => {});
    await app?.close().catch(() => {});
    await rm(fixture.tmp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
  report.languages[lang] = { captures, pageErrors };
}

async function main() {
  await mkdir(ARGS.output, { recursive: true });
  const report = {
    tool: 'scripts/readme-captures/tools.mjs',
    scope:
      'tools/context screenshot family (providers, MCP, slash palette, document preview, knowledge, session)',
    appVersion: '3.6.1',
    date: new Date().toISOString(),
    output: relative(REPO, ARGS.output),
    viewport: { width: 1600, height: 1000 },
    browser: process.env.PRIME_STUDIO_BROWSER || 'bundled playwright chromium (no channel)',
    languages: {},
    fixtures: {
      summary:
        'Fictional audio-calibration project. No user account, provider credential, MCP server, agent run or secret.',
      providers: 'Temporary auth.json with a masked fixture key; UI shows status only, never the key.',
      mcp: 'Native MCP service with a stubbed probe; one documentation server on reserved https://docs.example.test/mcp.',
      runtime: 'Stubbed status/model catalog (openai-codex/gpt-5.6-luna fixture); start() always throws.',
      inspector:
        'Usage (28.6k/3.4k in, 12.6k cache), context window (38 400/128 000, 30%), 3 agents and Codex quota (32% weekly) served over Playwright routes only; components and dialogs are the real implementation.',
      knowledge:
        '3 project sessions, 1 session memory, 1 global memory, 1 refinement with before/after, 1 finished sub-agent trace, 1 foreign-project sentinel for isolation.',
      projectFiles:
        'Temporary Git project (notes.md, PLAN.md, config.json, src/app.js) with one committed change.',
      commands: 'One project skill (/skill:design) + one project prompt + built-in Studio/terminal commands.',
    },
    mockedEndpoints: ['/api/inspector', '/api/providers/codex-link', '/api/providers/codex-usage'],
    realEndpoints: [
      '/api/providers',
      '/api/mcp*',
      '/api/commands',
      '/api/knowledge*',
      '/api/project-files*',
      '/api/overview',
      '/api/history',
    ],
    safety: [
      'Loopback-only server on a random port; temp agentHome/dataDir/sessionDir/cwd removed afterwards.',
      'No agent started (runtime.start throws), no MCP process spawned, no provider account touched.',
      'Screenshots + report.json are the only outputs, written under --output.',
    ],
    limitations: [
      'Quota/usage/agent numbers are plausible fixtures, not live measurements.',
      'desktop-inspector-agents.png is optional: the core group captures new sub-agents separately.',
      'No test that touches final captures or other outputs was executed; only this standalone script ran.',
    ],
  };
  let browser;
  try {
    browser = await chromium.launch(
      process.env.PRIME_STUDIO_BROWSER
        ? { channel: process.env.PRIME_STUDIO_BROWSER, headless: true }
        : { headless: true },
    );
    for (const lang of LANGS) await runLanguage(lang, browser, report);
    await writeFile(join(ARGS.output, 'report.json'), JSON.stringify(report, null, 2));
    const files = Object.values(report.languages).flatMap((entry) => entry.captures.map((c) => c.file));
    console.log(JSON.stringify({ ok: true, output: report.output, files }, null, 2));
  } finally {
    await browser?.close().catch(() => {});
  }
}

await main();
