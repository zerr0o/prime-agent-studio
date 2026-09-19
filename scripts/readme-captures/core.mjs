// Prime Agent Studio — README core captures (isolated fixtures, real UI).
//
// What this script does:
// - Starts the real Studio server (server.mjs) on a random 127.0.0.1 port with
//   fully fictional demonstration data held in memory + an isolated temp dir.
// - Drives the real shipped interface (no DOM/CSS injection, no visual fixture
//   overlay or banner) with Playwright Chromium and saves fresh FR+EN shots.
// - Fixture-only HTTP endpoints are served two ways: in-process fixture objects
//   (store, runtime, roadmap, live snapshot) and Playwright route mocks for
//   browser polling endpoints (/api/inspector, provider usage, archive preview).
// - Never starts a native agent, never reads user accounts/sessions, never
//   touches the network outside the loopback server, never alters UI/runtime.
// - Cleans up (browser, server, temp dirs) even when the browser fails to launch.
//
// Usage:
//   node scripts/readme-captures/core.mjs [--output <dir>] [--lang fr|en]
// Defaults: output .local/readme-refresh/core, both languages.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../../server.mjs';
import { createFileStore } from '../../lib/files.mjs';
import { projectKey } from '../../runtime/subagent-policy.mjs';
import { createRoadmapService } from '../../lib/roadmap.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const outputArg = opt('--output');
const langArg = opt('--lang');
if (langArg && !['fr', 'en'].includes(langArg)) throw new Error('--lang must be fr or en');
const langs = langArg ? [langArg] : ['fr', 'en'];
const output = outputArg ? resolve(root, outputArg) : join(root, '.local', 'readme-refresh', 'core');

// ---------------------------------------------------------------------------
// Original demo PNG generator (pure node, no dependency, no external asset).
// A small abstract workspace mockup used as the demonstration attachment.
// ---------------------------------------------------------------------------
function crc32(buffer) {
  let table = crc32.cache;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32.cache = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = table[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.alloc(4 + data.length);
  body.write(type, 0, 'ascii');
  data.copy(body, 4);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}
function makeDemoPng(width, height) {
  const px = Buffer.alloc(width * height * 3, 0);
  const fill = (x0, y0, x1, y1, [r, g, b]) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
        const o = (y * width + x) * 3;
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
      }
  };
  const dot = (cx, cy, rad, [r, g, b]) => {
    for (let y = Math.floor(cy - rad); y <= cy + rad; y++)
      for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) {
          const o = (y * width + x) * 3;
          px[o] = r;
          px[o + 1] = g;
          px[o + 2] = b;
        }
      }
  };
  const slate = [32, 41, 58],
    panel = [49, 64, 90],
    line = [74, 94, 124];
  const teal = [79, 209, 197],
    amber = [246, 173, 85],
    soft = [148, 178, 215];
  fill(0, 0, width, height, slate);
  fill(0, 0, width, 52, [20, 27, 40]);
  fill(0, 52, 132, height, [26, 34, 50]);
  fill(0, 52, 6, height, teal);
  for (let i = 0; i < 4; i++) fill(18, 80 + i * 40, 114, 106 + i * 40, i === 0 ? teal : panel);
  fill(156, 80, 420, 196, panel);
  fill(156, 80, 420, 92, line);
  fill(440, 80, 604, 196, panel);
  dot(482, 122, 20, amber);
  fill(452, 156, 592, 166, soft);
  fill(156, 210, 368, 306, panel);
  fill(156, 210, 368, 222, line);
  fill(392, 210, 604, 306, panel);
  fill(392, 210, 604, 222, line);
  fill(170, 240, 320, 250, soft);
  fill(170, 262, 280, 272, soft);
  fill(406, 240, 556, 250, soft);
  fill(406, 262, 500, 272, soft);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    px.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function pngSize(file) {
  const width = file.readUInt32BE(16),
    height = file.readUInt32BE(20);
  return { width, height };
}
// ---------------------------------------------------------------------------
// Bilingual demonstration fixtures. FR is the source; EN mirrors it 1:1.
// ---------------------------------------------------------------------------
let captureLanguage = 'fr';
const T = (fr, en) => (captureLanguage === 'en' ? en : fr);
const FR_EN = {
  'Recherche et favoris des modèles': 'Model search and favorites',
  'Améliorer la navigation au clavier': 'Improve keyboard navigation',
  'Tests du parcours de connexion': 'Sign-in flow checks',
  'Documenter la première installation': 'Document the first installation',
  'Site vitrine': 'Showcase website',
  'Ajoute une recherche et des favoris au catalogue de modèles. Garde une interface simple, utilisable au clavier.':
    'Add search and favorites to the model catalog. Keep the interface simple and keyboard-friendly.',
  'Examiner le catalogue et les composants existants.': 'Review the existing catalog and components.',
  'Vérifier la recherche, les favoris et la navigation au clavier.':
    'Check search, favorites and keyboard navigation.',
  'Vos modèles, plus faciles à retrouver': 'Find your models more easily',
  'La recherche et les favoris sont en place. Le sélecteur conserve le modèle choisi et distingue les fournisseurs.':
    'Search and favorites are ready. The picker keeps your selected model and distinguishes providers.',
  '| Fonction | Comportement |': '| Feature | Behavior |',
  '| Recherche | Nom, fournisseur ou identifiant |': '| Search | Name, provider or identifier |',
  '| Favoris | Vos modèles préférés en tête de liste |': '| Favorites | Your preferred models at the top |',
  '| Clavier | Tabulation, Entrée et Échap |': '| Keyboard | Tab, Enter and Escape |',
  'Les préférences restent enregistrées dans ce navigateur. Vous pouvez reprendre le travail dans une autre session à tout moment.':
    'Preferences stay saved in this browser. You can return to work in another conversation at any time.',
  'Un espace de travail simple, accessible et agréable sur tous les écrans.':
    'A simple, accessible workspace that feels right on every screen.',
  'Une première version prête à essayer': 'A first version ready to try',
  'Rechercher dans le catalogue': 'Search the catalog',
  'Filtrer par nom et fournisseur': 'Filter by name and provider',
  'Conserver la sélection pendant la recherche': 'Keep the selection while searching',
  'Retrouver ses favoris': 'Find your favorites',
  'Soigner les interactions': 'Refine interactions',
  'Vérifier les raccourcis clavier': 'Check keyboard shortcuts',
  'Relire les états vides et les erreurs': 'Review empty states and errors',
  'Documenter le parcours de démarrage': 'Document the startup flow',
  'Préparer les retours utilisateurs': 'Prepare user feedback',
  'Vérifier le confort sur téléphone': 'Check usability on mobile',
  'Publier le guide de démarrage': 'Publish the getting-started guide',
  'Vérifie la navigation au clavier.': 'Check keyboard navigation.',
  'Les boutons disposent de libellés accessibles et les dialogues rendent le focus au déclencheur.':
    'Buttons have accessible labels and dialogs return focus to their trigger.',
  'Prépare les tests du parcours de connexion.': 'Prepare the sign-in flow checks.',
  'Le parcours couvre la connexion, les erreurs de saisie et la déconnexion.':
    'The flow covers sign-in, input errors and sign-out.',
  'Rédige le guide de démarrage du projet.': 'Write the project getting-started guide.',
  'Le guide présente les prérequis, le lancement et la configuration locale.':
    'The guide covers prerequisites, startup and local configuration.',
  'Vérifie maintenant les derniers détails de navigation.': 'Now check the last navigation details.',
  'La recherche et les favoris sont vérifiés. Je termine les contrôles de navigation au clavier et la documentation.':
    'Search and favorites are verified. I am finishing the keyboard navigation checks and the documentation.',
  'Contrôler le retour du focus après fermeture du sélecteur.':
    'Check focus return after closing the picker.',
  'Vérifie aussi le retour du focus après fermeture du sélecteur.':
    'Also check focus return after closing the picker.',
  'Conserve aussi les raccourcis clavier existants.': 'Also keep the existing keyboard shortcuts.',
  'Ajoute un exemple au guide de démarrage.': 'Add an example to the getting-started guide.',
  'Catalogue et composants examinés.': 'Catalog and components reviewed.',
  'Les scénarios de démonstration sont terminés.': 'The demonstration scenarios are complete.',
  'Agent principal': 'Main agent',
  'Navigation et clavier': 'Navigation and keyboard',
  'Navigation et raccourcis vérifiés.': 'Navigation and shortcuts reviewed.',
  'Relecture de l’interface': 'Interface review',
  'Libellés, contrastes et états vides relus.': 'Labels, contrast and empty states reviewed.',
  Démonstration: 'Demonstration',
  'Images et fichiers pour le projet': 'Project images and files',
  'Voici le logo et le brief du projet. Prépare les prochaines étapes.':
    'Here are the project mockup and brief. Prepare the next steps.',
  'Une base commune pour la suite': 'A shared basis for what is next',
  'La maquette et le brief sont prêts à guider le travail sur l’interface.':
    'The mockup and brief are ready to guide the interface work.',
  '- Reprendre les couleurs de la maquette dans les éléments de navigation.':
    '- Reuse the mockup colors in the navigation elements.',
  '- Définir les écrans prioritaires à partir du brief.': '- Define the priority screens from the brief.',
  '- Vérifier les parcours sur PC et sur mobile.': '- Check the flows on desktop and mobile.',
  'Voici les éléments pour la prochaine itération.': 'Here is the material for the next iteration.',
  'Choisir la présentation d’accueil': 'Choose the home page layout',
  'Voici la maquette d’accueil. Choisis la présentation que tu préfères avant que je prépare les écrans.':
    'Here is the home page mockup. Pick your preferred layout before I prepare the screens.',
  'La maquette est prête. Il reste un choix de présentation à trancher.':
    'The mockup is ready. One layout choice is still open.',
  'Quelle présentation préférez-vous pour la page d’accueil ?':
    'Which layout do you prefer for the home page?',
  'Vue compacte': 'Compact view',
  'Les informations essentielles, visibles immédiatement.': 'Key information, visible immediately.',
  'Vue détaillée': 'Detailed view',
  'Davantage de contexte pour chaque élément.': 'More context for each item.',
  'Vue en liste': 'List view',
  'Une lecture simple, ligne par ligne.': 'Simple reading, line by line.',
  'Moteur connecté': 'Engine connected',
  'Atelier — Démo': 'Atelier — Demo',
};
function localizeDemo(value) {
  if (captureLanguage !== 'en') return value;
  if (typeof value === 'string') {
    for (const [fr, en] of Object.entries(FR_EN)) value = value.replaceAll(fr, en);
    return value;
  }
  if (Array.isArray(value)) return value.map(localizeDemo);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, localizeDemo(val)]));
  return value;
}

const model = 'openai-codex/gpt-5.6-luna';
const cwd = process.platform === 'win32' ? 'C:\\Projets\\Atelier' : '/projects/Atelier';
const timestamp = Date.now() - 20 * 60000;
let serial = 0;
const message = (role, text, extra = {}) => ({
  id: `demo-message-${++serial}`,
  role,
  text,
  timestamp,
  tools: [],
  ...(role === 'assistant' ? { model: 'gpt-5.6-luna', provider: 'openai-codex' } : {}),
  ...extra,
});
const activity = (label, result, index) =>
  message('assistant', '', {
    thinking: label,
    tools: [
      {
        id: `demo-tool-${index}`,
        name: 'ipython',
        args: { code: `print(${JSON.stringify(result)})` },
        result,
        status: 'done',
      },
    ],
  });

function buildBaseConversation() {
  return [
    message(
      'user',
      T(
        'Ajoute une recherche et des favoris au catalogue de modèles. Garde une interface simple, utilisable au clavier.',
        'Add search and favorites to the model catalog. Keep the interface simple and keyboard-friendly.',
      ),
    ),
    activity(
      T('Examiner le catalogue et les composants existants.', 'Review the existing catalog and components.'),
      T('Catalogue et composants examinés.', 'Catalog and components reviewed.'),
      1,
    ),
    activity(
      T(
        'Vérifier la recherche, les favoris et la navigation au clavier.',
        'Check search, favorites and keyboard navigation.',
      ),
      T('Les scénarios de démonstration sont terminés.', 'The demonstration scenarios are complete.'),
      2,
    ),
    message(
      'assistant',
      T(
        [
          '## Vos modèles, plus faciles à retrouver',
          '',
          'La recherche et les favoris sont en place. Le sélecteur conserve le modèle choisi et distingue les fournisseurs.',
          '',
          '| Fonction | Comportement |',
          '| --- | --- |',
          '| Recherche | Nom, fournisseur ou identifiant |',
          '| Favoris | Vos modèles préférés en tête de liste |',
          '| Clavier | Tabulation, Entrée et Échap |',
          '',
          'Les préférences restent enregistrées dans ce navigateur. Vous pouvez reprendre le travail dans une autre session à tout moment.',
        ].join('\n'),
        [
          '## Find your models more easily',
          '',
          'Search and favorites are ready. The picker keeps your selected model and distinguishes providers.',
          '',
          '| Feature | Behavior |',
          '| --- | --- |',
          '| Search | Name, provider or identifier |',
          '| Favorites | Your preferred models at the top |',
          '| Keyboard | Tab, Enter and Escape |',
          '',
          'Preferences stay saved in this browser. You can return to work in another conversation at any time.',
        ].join('\n'),
      ),
    ),
  ];
}

function buildSessions() {
  serial = 0;
  const sessions = [
    {
      id: 'demo-model-search',
      title: T('Recherche et favoris des modèles', 'Model search and favorites'),
      pinned: true,
      messages: buildBaseConversation(),
    },
    {
      id: 'demo-accessibility',
      title: T('Améliorer la navigation au clavier', 'Improve keyboard navigation'),
      messages: [
        message('user', T('Vérifie la navigation au clavier.', 'Check keyboard navigation.')),
        message(
          'assistant',
          T(
            'Les boutons disposent de libellés accessibles et les dialogues rendent le focus au déclencheur.',
            'Buttons have accessible labels and dialogs return focus to their trigger.',
          ),
        ),
      ],
    },
    {
      id: 'demo-tests',
      title: T('Tests du parcours de connexion', 'Sign-in flow checks'),
      messages: [
        message('user', T('Prépare les tests du parcours de connexion.', 'Prepare the sign-in flow checks.')),
        message(
          'assistant',
          T(
            'Le parcours couvre la connexion, les erreurs de saisie et la déconnexion.',
            'The flow covers sign-in, input errors and sign-out.',
          ),
        ),
      ],
    },
    {
      id: 'demo-docs',
      title: T('Documenter la première installation', 'Document the first installation'),
      messages: [
        message(
          'user',
          T('Rédige le guide de démarrage du projet.', 'Write the project getting-started guide.'),
        ),
        message(
          'assistant',
          T(
            'Le guide présente les prérequis, le lancement et la configuration locale.',
            'The guide covers prerequisites, startup and local configuration.',
          ),
        ),
      ],
    },
    {
      // Dedicated session for the interactive-question capture: its draft key
      // stays untouched by the attachments phase, so the composer is clean.
      id: 'demo-home-layout',
      title: T('Choisir la présentation d’accueil', 'Choose the home page layout'),
      messages: [
        message(
          'user',
          T(
            'Voici la maquette d’accueil. Choisis la présentation que tu préfères avant que je prépare les écrans.',
            'Here is the home page mockup. Pick your preferred layout before I prepare the screens.',
          ),
        ),
        message(
          'assistant',
          T(
            'La maquette est prête. Il reste un choix de présentation à trancher.',
            'The mockup is ready. One layout choice is still open.',
          ),
        ),
      ],
    },
  ].map((session, index) => ({
    ...session,
    cwd,
    model,
    messageCount: session.messages.length,
    createdAt: new Date(timestamp - index * 3600000).toISOString(),
    updatedAt: new Date(timestamp - index * 3600000).toISOString(),
  }));
  const projects = [
    { cwd, name: 'Atelier', pinned: true, exists: true, sessions },
    { cwd: cwd.replace('Atelier', 'Documentation'), name: 'Documentation', exists: true, sessions: [] },
    {
      cwd: cwd.replace('Atelier', 'Site-vitrine'),
      name: T('Site vitrine', 'Showcase website'),
      exists: true,
      sessions: [],
    },
  ];
  return { sessions, projects };
}

let live = buildSessions();
const store = {
  async knowledgeProject(path) {
    return this.findProject(path);
  },
  async markRead() {
    return { ok: true };
  },
  async getConversationSettings() {
    return { model, thinking: 'high' };
  },
  async pastudioNeedsModel() {
    return false;
  },
  async overview() {
    return {
      projects: live.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map(({ messages, ...summary }) => summary),
      })),
      totalSessions: live.sessions.length,
    };
  },
  async history(id) {
    const session = live.sessions.find((value) => value.id === id);
    assert.ok(session, 'Only demonstration sessions may be opened');
    return session;
  },
  async findProject(path) {
    const project = live.projects.find((project) => project.cwd === path);
    assert.ok(project, 'Only demonstration projects may be opened');
    return project;
  },
};
const models = [
  { id: model, name: 'GPT-5.6 Luna', provider: 'openai-codex', reasoning: true },
  { id: 'openai-codex/gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai-codex', reasoning: true },
  { id: 'openai-codex/gpt-5.5', name: 'GPT-5.5', provider: 'openai-codex', reasoning: true },
];
for (const item of models) item.thinkingLevels = ['off', 'low', 'medium', 'high', 'xhigh'];
const runtime = {
  async getStatus() {
    return { available: true, version: '0.9.4' };
  },
  async getModels() {
    return {
      models,
      configuredProviders: ['openai-codex'],
      default: { model: 'openai-codex/gpt-5.6-sol', thinking: 'high' },
    };
  },
  async start() {
    throw new Error('Screenshot fixtures cannot start an agent.');
  },
  async close() {},
};
// ---------------------------------------------------------------------------
// Isolated server (loopback only, temp dirs, no user data).
// ---------------------------------------------------------------------------
const temp = await mkdtemp(join(tmpdir(), 'prime-readme-core-'));
await mkdir(join(temp, 'Atelier'), { recursive: true });
await Promise.all(['agent', 'data', 'sessions'].map((name) => mkdir(join(temp, name), { recursive: true })));
await writeFile(
  join(temp, 'agent', 'settings.json'),
  JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'gpt-5.6-sol' }),
);
await writeFile(
  join(temp, 'data', 'subagent-defaults.json'),
  JSON.stringify({
    version: 1,
    revision: 'demo',
    global: { model, thinking: 'high' },
    projects: { [projectKey(cwd)]: { model, thinking: 'medium' } },
  }),
);
const isolatedRoadmap = createRoadmapService({
  resolveProject: async (path) => {
    await store.findProject(path);
    return { cwd: join(temp, 'Atelier'), name: 'Atelier' };
  },
});
const roadmap = {
  async close() {
    await isolatedRoadmap.close();
  },
  async read(path) {
    // Roadmap content is authored once in FR; EN readers get the 1:1 mirror.
    return localizeDemo({ ...(await isolatedRoadmap.read(path)), cwd: path });
  },
  async mutate(path, input) {
    return { ...(await isolatedRoadmap.mutate(path, input)), cwd: path };
  },
};
const liveClient = {
  async getSnapshot() {
    return {
      available: true,
      steering: [
        T('Conserve aussi les raccourcis clavier existants.', 'Also keep the existing keyboard shortcuts.'),
      ],
      followUps: [
        T('Ajoute un exemple au guide de démarrage.', 'Add an example to the getting-started guide.'),
      ],
    };
  },
};
const app = createApp({
  roadmap,
  store,
  runtime,
  agentHome: join(temp, 'agent'),
  dataDir: join(temp, 'data'),
  sessionDir: join(temp, 'sessions'),
  liveClient,
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;
const fileStore = createFileStore(join(temp, 'data', 'attachments'));

// Demonstration Roadmap content (fictional, authored once in FR).
let doc = await app.roadmap.read(cwd);
async function mutate(action, extra = {}) {
  doc = await app.roadmap.mutate(cwd, { action, expectedRevision: doc.revision, ...extra });
}
await mutate('init');
await mutate('vision', { text: 'Un espace de travail simple, accessible et agréable sur tous les écrans.' });
await mutate('milestone.create', { title: 'Une première version prête à essayer', status: 'active' });
await mutate('plan.create', {
  title: 'Recherche et favoris des modèles',
  milestone: doc.overview.milestones[0].id,
  sessions: ['demo-model-search'],
  steps: [
    {
      text: 'Rechercher dans le catalogue',
      done: true,
      children: [
        { text: 'Filtrer par nom et fournisseur', done: true },
        { text: 'Conserver la sélection pendant la recherche', done: true },
      ],
    },
    { text: 'Retrouver ses favoris', done: true },
    {
      text: 'Soigner les interactions',
      children: [
        { text: 'Vérifier les raccourcis clavier', done: true },
        { text: 'Relire les états vides et les erreurs' },
      ],
    },
    { text: 'Documenter le parcours de démarrage' },
  ],
});
await mutate('plan.create', {
  title: 'Préparer les retours utilisateurs',
  milestone: doc.overview.milestones[0].id,
  steps: [{ text: 'Vérifier le confort sur téléphone' }, { text: 'Publier le guide de démarrage' }],
});

// Original demonstration assets: generated PNG mockup + brief document.
const demoPng = makeDemoPng(640, 320);
const briefName = 'brief-du-projet.md';
const briefBody = Buffer.from(
  T(
    '# Atelier\n\nConserver les couleurs de la maquette et simplifier la navigation.\n',
    '# Atelier\n\nReuse the mockup colors and simplify the navigation.\n',
  ),
);

// ---------------------------------------------------------------------------
// Capture run.
// ---------------------------------------------------------------------------
const SHOTS = [
  {
    file: 'desktop-conversation.png',
    scenario: 'Workspace hero: fictional model-search conversation, session inspector.',
  },
  {
    file: 'desktop-models.png',
    scenario: 'Model picker dialog with search and favorites (real dialog, cropped).',
  },
  {
    file: 'roadmap-expanded.png',
    scenario: 'Expanded Roadmap panel with plans unfolded (real panel, cropped).',
  },
  {
    file: 'desktop-projects.png',
    scenario: 'Project overview in the light theme for variety (full workspace).',
  },
  {
    file: 'desktop-project-import.png',
    scenario:
      'Project archive import dialog with a plausible demo preview (real dialog, cropped; preview served by a fixture endpoint).',
  },
  {
    file: 'desktop-new-conversation-agents.png',
    scenario: 'New conversation defaults under the agents inspector (full workspace).',
  },
  {
    file: 'desktop-live-messages.png',
    scenario: 'Live steering/follow-up queues during a running turn (simulated run events, real UI).',
  },
  {
    file: 'desktop-attachments.png',
    scenario: 'Original generated image + brief document rendered, with upload drafts (full workspace).',
  },
  {
    file: 'desktop-interactive-questions.png',
    scenario: 'Pending layout choice with three options next to the generated mockup (full workspace).',
  },
];
const report = {
  tool: 'scripts/readme-captures/core.mjs',
  output: output,
  viewport: { width: 1600, height: 1000 },
  browser: `chromium channel ${process.env.PRIME_STUDIO_BROWSER || 'chromium (standalone default)'}`,
  provenance:
    'Real Studio server + real shipped UI on an isolated 127.0.0.1 server. All people, projects, conversations, metrics and files are fictional fixtures; no native agent is started, no user account/session is read, no network leaves loopback. No DOM/CSS is faked and no fixture overlay or banner is injected: the interface stays clean; fixture transparency lives in this manifest and in README captions, not in the UI.',
  images: [],
  assertions: [],
  pageerrors: [],
  nativeAgentsStarted: 0,
};
const noted = (text) => report.assertions.push(`[${captureLanguage}] ${text}`);
let browser;
try {
  for (const language of langs) {
    captureLanguage = language;
    const fr = language === 'fr';
    // Fresh browser per language so native controls (file picker button) speak
    // the capture language. No UI code is touched. Default channel is the full
    // Chromium build (native locales); PRIME_STUDIO_BROWSER keeps priority.
    browser = await chromium.launch({
      channel: process.env.PRIME_STUDIO_BROWSER || 'chromium',
      headless: true,
      args: [`--lang=${fr ? 'fr-FR' : 'en-US'}`],
    });
    live = buildSessions();
    const { sessions, projects } = live;
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      locale: fr ? 'fr-FR' : 'en-US',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (request) => {
      // Fixture POSTs (archive preview, session reads) stay on the loopback server.
      assert.equal(new URL(request.url()).origin, url, 'Only the isolated server is allowed');
    });
    await context.route('**/api/inspector?*', (route) =>
      route.fulfill({
        json: {
          session: {
            id: sessions[0].id,
            status: 'idle',
            usage: { input: 28600, output: 3420, cache: 12600, cost: 0 },
            contextUsage: { tokens: 38400, contextWindow: 128000, percent: 30 },
          },
          contextUsage: { tokens: 38400, contextWindow: 128000, percent: 30 },
          live: false,
          notes: [],
          agents: [
            {
              id: sessions[0].id,
              root: true,
              name: T('Agent principal', 'Main agent'),
              status: 'idle',
              model,
              thinking: 'high',
              usage: { input: 28600, output: 3420, cache: 12600, cost: 0 },
            },
            {
              id: 'demo-design',
              parentId: sessions[0].id,
              name: T('Navigation et clavier', 'Navigation and keyboard'),
              status: 'saved',
              model,
              thinking: 'high',
              preview: T('Navigation et raccourcis vérifiés.', 'Navigation and shortcuts reviewed.'),
              history: true,
              toolUseCount: 8,
            },
            {
              id: 'demo-review',
              parentId: sessions[0].id,
              name: T('Relecture de l’interface', 'Interface review'),
              status: 'saved',
              model,
              thinking: 'medium',
              preview: T(
                'Libellés, contrastes et états vides relus.',
                'Labels, contrast and empty states reviewed.',
              ),
              history: true,
              toolUseCount: 5,
            },
          ],
          truncated: false,
        },
      }),
    );
    await context.route('**/api/providers/codex-link', (route) =>
      route.fulfill({ json: { provider: 'openai-codex', linked: true, revision: 'demo' } }),
    );
    await context.route('**/api/providers/codex-usage?*', (route) =>
      route.fulfill({
        json: {
          available: true,
          provider: 'openai-codex',
          plan: T('Démonstration', 'Demonstration'),
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
    await context.route('**/api/project-archives/preview?*', (route) =>
      route.fulfill({
        json: {
          duplicate: false,
          pending: false,
          archiveChanged: false,
          archiveId: 'demo-archive-1',
          payloadDigest: 'demo-digest',
          destCwd: projects[1].cwd,
          sourceProject: { name: T('Atelier — Démo', 'Atelier — Demo') },
          counts: {
            sessions: 3,
            childSessions: 1,
            messages: 24,
            roadmapPlans: 2,
            roadmapSteps: 9,
            backlogItems: 2,
            backlogNotes: 1,
            journalEntries: 1,
            milestones: 1,
          },
          warnings: ['additive', 'no-overwrite', 'secret-in-history'],
          previewToken: 'demo-preview-token',
          expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
        },
      }),
    );
    await page.addInitScript(
      ({ cwd, model }) => {
        localStorage.setItem(
          'prime-studio.selection',
          JSON.stringify({ cwd, sessionId: 'demo-model-search', projectOverview: false }),
        );
        localStorage.setItem(
          'prime-studio.preferences',
          JSON.stringify({
            theme: 'dark',
            details: true,
            modelFavorites: [model, 'openai-codex/gpt-5.6-sol'],
          }),
        );
      },
      { cwd, model },
    );
    await page.goto(url);
    await page.evaluate(async (lang) => {
      const i18n = await import('/public/i18n.js');
      i18n.setLanguage(lang);
    }, language);
    const outDir = fr ? output : join(output, 'en');
    await mkdir(outDir, { recursive: true });
    async function shot(file, target = page) {
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(1590, 990);
      const dest = join(outDir, file);
      await target.screenshot({ path: dest, animations: 'disabled' });
      const bytes = await stat(dest);
      const { width, height } = pngSize(await readFile(dest));
      report.images.push({
        language,
        file: fr ? file : `en/${file}`,
        width,
        height,
        bytes: bytes.size,
        scenario: SHOTS.find((s) => s.file === file)?.scenario || '',
        fixtures: 'Fictional in-memory sessions/projects/roadmap + fixture HTTP routes; no native agent.',
      });
    }

    // 1. Hero conversation (dark).
    await expect(page.locator('#header-session')).toHaveText(sessions[0].title);
    noted(`hero title "${sessions[0].title}"`);
    await expect(page.locator('#connection-label')).toHaveText(T('Moteur connecté', 'Engine connected'));
    noted('engine badge in UI language');
    await expect(page.locator('.session-row').first()).toBeVisible();
    if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
    await page.locator('#inspector-tab-session').click();
    await expect(page.locator('#inspector-context')).toBeVisible();
    noted('session inspector context visible');
    await shot('desktop-conversation.png');

    // 2. Model picker dialog.
    await page.locator('#model-picker-button').click();
    await expect(page.locator('#model-search')).toBeVisible();
    await expect(page.locator('#model-favorites-label')).toContainText('2');
    noted('model dialog with 2 favorites');
    await shot('desktop-models.png', page.locator('#model-dialog'));
    await page.keyboard.press('Escape');

    // 3. Roadmap expanded.
    await page.locator('#open-roadmap').click();
    const panel = page.locator('#roadmap-panel');
    await expect(panel).toBeVisible();
    await panel.locator('.rm-expand').click();
    await expect(page.locator('body')).toHaveClass(/roadmap-expanded/);
    for (const toggle of await panel.locator('.rm-plan > .rm-plan-head > .rm-plan-toggle').all()) {
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    }
    const completedGroup = panel.locator('.rm-plan').first().locator('.rm-step-toggle').first();
    if ((await completedGroup.getAttribute('aria-expanded')) === 'true') await completedGroup.click();
    const nextPlan = panel.locator('.rm-plan').nth(1).locator(':scope > .rm-plan-head > .rm-plan-toggle');
    if ((await nextPlan.getAttribute('aria-expanded')) === 'true') await nextPlan.click();
    await panel.locator('.rm-content').evaluate((el) => {
      el.scrollTop = 0;
    });
    noted('roadmap expanded with plans unfolded');
    await shot('roadmap-expanded.png', panel);
    await panel.locator('.rm-close').click();
    await expect(panel).toBeHidden();

    // 4. Projects overview in the light theme (variety shot).
    await page.locator('#open-settings').click();
    await page.locator('[data-theme-choice="light"]').click();
    await page.keyboard.press('Escape');
    await page.locator('#header-project').click();
    await expect(page.locator('#project-overview')).toBeVisible();
    await expect(page.locator('#project-overview-title')).toContainText('Atelier');
    noted('project overview in light theme');
    await shot('desktop-projects.png');

    // 5. Real import dialog with a plausible demo preview.
    await page.locator('.project-more').first().click();
    await page.locator('[data-project-action="archive-import"]').click();
    await expect(page.locator('#project-archive-dialog')).toBeVisible();
    await page.locator('#project-archive-file').setInputFiles({
      name: 'atelier-demo.pastudio',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('pastudio-demo-fixture'),
    });
    await expect(page.locator('#project-archive-preview')).toBeVisible();
    await expect(page.locator('#project-archive-source')).toContainText(
      T('Atelier — Démo', 'Atelier — Demo'),
    );
    await expect(page.locator('#project-archive-counts')).toContainText('24');
    noted('import preview with demo source + counts');
    await shot('desktop-project-import.png', page.locator('#project-archive-dialog'));
    await page.keyboard.press('Escape');
    await page.locator('#open-settings').click();
    await page.locator('[data-theme-choice="dark"]').click();
    await page.keyboard.press('Escape');

    // 6. New conversation defaults under the agents inspector.
    await page.locator('#new-session').click();
    if (!(await page.locator('#details-panel').isVisible())) await page.locator('#toggle-details').click();
    await page.locator('#inspector-tab-agents').click();
    await expect(page.locator('#project-subagent-settings')).toBeVisible();
    await expect(page.locator('#detail-session-id')).toBeHidden();
    noted('new-conversation project subagent defaults visible');
    await shot('desktop-new-conversation-agents.png');

    // 7. Live steering / follow-ups during a running turn.
    const startedAt = new Date(Date.now() - 84000).toISOString();
    sessions[0].updatedAt = startedAt;
    sessions[0].messages = [];
    sessions[0].messageCount = 0;
    const runId = '00000000-0000-4000-8000-000000000001';
    const run = {
      id: runId,
      sessionId: sessions[0].id,
      cwd,
      status: 'running',
      model,
      thinking: 'high',
      allowQuestions: true,
      prompt: T(
        'Vérifie maintenant les derniers détails de navigation.',
        'Now check the last navigation details.',
      ),
      startedAt,
      seq: 0,
      events: [],
      clients: new Set(),
      finished: false,
      bytes: 0,
    };
    const wire = (event) => {
      const item = { ...event, seq: ++run.seq };
      return { item, wire: `id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n` };
    };
    run.events = [
      wire({
        kind: 'message',
        message: message(
          'assistant',
          T(
            'La recherche et les favoris sont vérifiés. Je termine les contrôles de navigation au clavier et la documentation.',
            'Search and favorites are verified. I am finishing the keyboard navigation checks and the documentation.',
          ),
          { timestamp: Date.parse(startedAt) + 15000 },
        ),
      }),
      wire({
        kind: 'message',
        message: message('assistant', '', {
          timestamp: Date.parse(startedAt) + 30000,
          thinking: T(
            'Contrôler le retour du focus après fermeture du sélecteur.',
            'Check focus return after closing the picker.',
          ),
          tools: [
            {
              id: 'demo-running-tool',
              name: 'ipython',
              status: 'running',
              args: { code: 'verify_keyboard_navigation()' },
            },
          ],
        }),
      }),
    ];
    app.runs.set(run.id, run);
    await page.goto(url);
    await page.evaluate(async (lang) => {
      const i18n = await import('/public/i18n.js');
      i18n.setLanguage(lang);
    }, language);
    await expect(page.locator('#stop-button')).toBeVisible();
    await expect(page.locator('.live-queue-count')).toHaveText('2');
    await page
      .locator('#composer')
      .fill(
        T(
          'Vérifie aussi le retour du focus après fermeture du sélecteur.',
          'Also check focus return after closing the picker.',
        ),
      );
    await expect(page.locator('#send-button')).toBeEnabled();
    await page.locator('.live-queue > summary').click();
    await expect(page.locator('#messages')).toContainText(
      T('Je termine les contrôles de navigation', 'I am finishing the keyboard navigation checks'),
    );
    await expect(page.locator('.activity-stack.is-running')).toBeVisible();
    await expect(page.locator('.activity-stack.is-running')).toBeInViewport();
    noted('live queues (steer + follow-up) with running activity');
    await shot('desktop-live-messages.png');

    // 8. Attachments: generated image + brief rendered, drafts staged.
    app.runs.delete(run.id);
    const [attachment] = await fileStore.save([{ name: briefName, data: briefBody.toString('base64') }]);
    sessions[0].title = T('Images et fichiers pour le projet', 'Project images and files');
    sessions[0].messages = [
      message(
        'user',
        T(
          'Voici la maquette et le brief du projet. Prépare les prochaines étapes.',
          'Here are the project mockup and brief. Prepare the next steps.',
        ),
        {
          attachments: [
            { type: 'image', mimeType: 'image/png', data: demoPng.toString('base64') },
            { type: 'file', id: attachment.id, name: attachment.name, size: attachment.size },
          ],
        },
      ),
      message(
        'assistant',
        T(
          [
            '## Une base commune pour la suite',
            '',
            'La maquette et le brief sont prêts à guider le travail sur l’interface.',
            '',
            '- Reprendre les couleurs de la maquette dans les éléments de navigation.',
            '- Définir les écrans prioritaires à partir du brief.',
            '- Vérifier les parcours sur PC et sur mobile.',
          ].join('\n'),
          [
            '## A shared basis for what is next',
            '',
            'The mockup and brief are ready to guide the interface work.',
            '',
            '- Reuse the mockup colors in the navigation elements.',
            '- Define the priority screens from the brief.',
            '- Check the flows on desktop and mobile.',
          ].join('\n'),
        ),
      ),
    ];
    sessions[0].messageCount = sessions[0].messages.length;
    await page.goto(url);
    await page.evaluate(async (lang) => {
      const i18n = await import('/public/i18n.js');
      i18n.setLanguage(lang);
    }, language);
    await expect(page.locator('#header-session')).toHaveText(sessions[0].title);
    await expect(page.locator('.message-image')).toBeVisible();
    await expect(page.locator('.message-file')).toHaveText(briefName);
    await expect(page.locator('#attach-images')).toBeEnabled();
    await page
      .locator('#image-files')
      .setInputFiles({ name: 'maquette-accueil.png', mimeType: 'image/png', buffer: demoPng });
    await expect(page.locator('.image-draft')).toHaveCount(1);
    await page
      .locator('#attachment-files')
      .setInputFiles({ name: 'notes-de-relecture.md', mimeType: 'text/markdown', buffer: briefBody });
    await expect(page.locator('.image-draft')).toHaveCount(2);
    await expect(page.locator('.image-draft-tray')).toContainText('notes-de-relecture.md');
    await page
      .locator('#composer')
      .fill(
        T('Voici les éléments pour la prochaine itération.', 'Here is the material for the next iteration.'),
      );
    await expect(page.locator('#send-button')).toBeEnabled();
    noted('attachments rendered + 2 drafts staged');
    await shot('desktop-attachments.png');

    // 9. Interactive question: layout choice beside the generated mockup.
    // Uses the dedicated demo-home-layout session so no attachment draft from
    // phase 8 pollutes its composer (draft keys are per session).
    const qsession = sessions.find((s) => s.id === 'demo-home-layout');
    // Single user message: the running turn asks its layout question before
    // answering, which also keeps mockup + choices within one frame.
    // The message timestamp matches the run start so the real client dedups
    // history vs. the live user echo; the replayed user event then enriches
    // that single echo with the image attachments (native reload path).
    const qStart = new Date().toISOString();
    const qUserText = T(
      'Voici la maquette d’accueil. Choisis la présentation que tu préfères avant que je prépare les écrans.',
      'Here is the home page mockup. Pick your preferred layout before I prepare the screens.',
    );
    const qImage = { type: 'image', mimeType: 'image/png', data: demoPng.toString('base64') };
    qsession.messages = [
      message('user', qUserText, { timestamp: Date.parse(qStart), attachments: [qImage] }),
    ];
    qsession.messageCount = qsession.messages.length;
    const question = {
      id: 'demo-question-layout',
      toolId: 'demo-tool-question',
      status: 'pending',
      title: T(
        'Quelle présentation préférez-vous pour la page d’accueil ?',
        'Which layout do you prefer for the home page?',
      ),
      options: [
        T('Vue compacte', 'Compact view'),
        T('Vue détaillée', 'Detailed view'),
        T('Vue en liste', 'List view'),
      ],
      optionDetails: [
        {
          label: T('Vue compacte', 'Compact view'),
          description: T(
            'Les informations essentielles, visibles immédiatement.',
            'Key information, visible immediately.',
          ),
        },
        {
          label: T('Vue détaillée', 'Detailed view'),
          description: T('Davantage de contexte pour chaque élément.', 'More context for each item.'),
        },
        {
          label: T('Vue en liste', 'List view'),
          description: T('Une lecture simple, ligne par ligne.', 'Simple reading, line by line.'),
        },
      ],
      allowCustom: false,
    };
    const qrun = {
      id: '00000000-0000-4000-8000-000000000002',
      sessionId: qsession.id,
      cwd,
      status: 'running',
      model,
      thinking: 'high',
      allowQuestions: true,
      interactions: [question],
      prompt: qUserText,
      startedAt: qStart,
      seq: 0,
      events: [],
      clients: new Set(),
      finished: false,
      bytes: 0,
    };
    const qwire = (event) => {
      const item = { ...event, seq: ++qrun.seq };
      return { item, wire: `id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n` };
    };
    qrun.events = [
      // Replayed first: enriches the live user echo with the mockup image.
      qwire({
        kind: 'message',
        message: message('user', qUserText, {
          timestamp: Date.parse(qStart),
          attachments: [qImage],
        }),
      }),
      qwire({ kind: 'interaction', request: question }),
    ];
    app.runs.set(qrun.id, qrun);
    await page.goto(url);
    await page.evaluate(async (lang) => {
      const i18n = await import('/public/i18n.js');
      i18n.setLanguage(lang);
    }, language);
    await page.locator('.session-row', { hasText: qsession.title }).first().click();
    await expect(page.locator('#header-session')).toHaveText(qsession.title);
    const pending = page.locator('.agent-question:not(.question-resolved)');
    await expect(pending).toBeVisible();
    await expect(pending.locator('input[type="radio"]')).toHaveCount(3);
    await expect(page.locator('.message-image').first()).toBeVisible();
    await expect(page.locator('#composer')).toBeEmpty();
    // Frame from the top of the conversation so the generated mockup and the
    // pending choices share the frame (verified below, both in viewport).
    await page.evaluate(() => {
      document.querySelector('#conversation-scroll').scrollTop = 0;
    });
    await expect(page.locator('.message-image').first()).toBeInViewport();
    await expect(pending).toBeInViewport();
    noted('pending 3-choice question beside generated mockup, clean composer');
    await shot('desktop-interactive-questions.png');
    app.runs.delete(qrun.id);

    assert.deepEqual(errors, []);
    noted('zero page errors');
    await context.close();
    await browser.close();
    browser = undefined;
  }
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        output,
        languages: langs,
        images: report.images.map((i) => `${i.language}:${i.file} ${i.width}x${i.height} ${i.bytes}B`),
        assertions: report.assertions.length,
        pageerrors: report.pageerrors.length,
        nativeAgentsStarted: 0,
      },
      null,
      2,
    ),
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  await app.close().catch(() => {});
  const safe = resolve(temp);
  assert.ok(safe.startsWith(resolve(tmpdir()) + sep) && safe.includes('prime-readme-core-'));
  await rm(safe, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
