// Skills UI: collapsed/expanded skill blocks in user bubbles + composer with 2 skill chips.
// FR screenshots to test-results/skills-ui/. Real Studio UI with isolated fixtures.
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-skills-ui-'));
const cwd = join(root, 'Atelier');
const agentHome = join(root, 'agent');
const sessionDir = join(root, 'sessions');
await Promise.all(
  [
    cwd,
    agentHome,
    sessionDir,
    join(cwd, '.prime', 'agent', 'skills', 'alpha'),
    join(cwd, '.prime', 'agent', 'skills', 'beta'),
  ].map((p) => mkdir(p, { recursive: true })),
);
await writeFile(join(agentHome, 'settings.json'), JSON.stringify({ enableBuiltinSkills: false }));
await writeFile(
  join(cwd, '.prime', 'agent', 'skills', 'alpha', 'SKILL.md'),
  '---\nname: alpha\ndescription: Premiere skill de test\n---\nInstructions Alpha avec accents : ete.',
);
await writeFile(
  join(cwd, '.prime', 'agent', 'skills', 'beta', 'SKILL.md'),
  '---\nname: beta\ndescription: Seconde skill de test\n---\nInstructions Beta sur deux lignes.\nSeconde ligne.',
);
const alphaPath = join(cwd, '.prime', 'agent', 'skills', 'alpha', 'SKILL.md');
const betaPath = join(cwd, '.prime', 'agent', 'skills', 'beta', 'SKILL.md');
const expandedUser = `<skill name="alpha" location="${alphaPath}">\nReferences are relative to ${join(cwd, '.prime', 'agent', 'skills', 'alpha')}.\n\nInstructions Alpha avec accents : ete.\n</skill>\n\n<skill name="beta" location="${betaPath}">\nReferences are relative to ${join(cwd, '.prime', 'agent', 'skills', 'beta')}.\n\nInstructions Beta sur deux lignes.\nSeconde ligne.\n</skill>\n\nFais la synthese des deux skills.`;
await writeFile(
  join(sessionDir, 'test.jsonl'),
  [
    { type: 'session', id: 'skills-session', cwd, timestamp: new Date().toISOString() },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: expandedUser } },
  ]
    .map(JSON.stringify)
    .join('\n') + '\n',
);
const controls = [];
const errors = [];
const checks = [];
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
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const outDir = join(process.cwd(), 'test-results', 'skills-ui');
await mkdir(outDir, { recursive: true });
function launchOptions() {
  const channel = process.env.PRIME_STUDIO_TEST_BROWSER;
  if (!channel || channel === 'chromium') return { headless: true };
  return { channel, headless: true };
}
let browser;
try {
  browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({
    locale: 'fr-FR',
    viewport: { width: 1440, height: 960 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page.locator('.session-select').click();
  const bubble = page.locator('.message.user .message-body');
  await expect(bubble).toBeVisible({ timeout: 10000 });
  // Collapsed skill blocks: Skill label plus names, user text visible, raw SKILL body hidden.
  await expect(bubble.locator('.skill-block').first()).toBeVisible();
  await expect(bubble).toContainText('Skill');
  await expect(bubble).toContainText('alpha');
  await expect(bubble).toContainText('Fais la synthese des deux skills.');
  // Copy keeps the typed request, not the expanded instructions.
  await page.locator('.message.user .message-actions button').first().click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('Fais la synthese des deux skills.');
  checks.push('Message copy returns the typed request without expanded skill text');
  await page.locator('#messages').screenshot({ path: join(outDir, 'skill-collapsed-fr.png') });
  // Expand the first skill block.
  await bubble.locator('.skill-block summary').first().click();
  await expect(bubble.locator('.skill-block[open]').first()).toBeVisible();
  await expect(bubble).toContainText('Instructions Alpha');
  await page.locator('#messages').screenshot({ path: join(outDir, 'skill-expanded-fr.png') });
  checks.push('Collapsed skill blocks with user text, then expanded content');
  // Composer with 2 skill chips.
  await page.locator('#new-session').click();
  await expect(page.locator('#composer')).toBeVisible();
  async function choose(name) {
    await page.locator('#open-commands').click();
    await page.locator('.command-search').fill(`/${name}`);
    await page.locator('.command-item').first().click();
  }
  await choose('skill:alpha');
  await expect(page.locator('#composer-command')).toBeVisible();
  await choose('skill:beta');
  await expect(page.locator('.composer-command-extra')).toBeVisible();
  await expect(page.locator('.composer-command-extra')).toHaveCount(1);
  // Duplicate selection does not stack the same skill twice.
  await choose('skill:alpha');
  await expect(page.locator('.composer-command-extra')).toHaveCount(1);
  await expect(page.locator('#composer-command-label')).toHaveText('/skill:alpha');
  await page.locator('#composer').fill('Combine les deux skills.');
  // Draft restore keeps both chips and the typed text after reload.
  await page.reload();
  await expect(page.locator('#composer-command')).toBeVisible();
  await expect(page.locator('.composer-command-extra')).toHaveCount(1);
  await expect(page.locator('#composer')).toHaveValue('Combine les deux skills.');
  // Removing one chip keeps the other and its text.
  await page.locator('.composer-command-extra button').click();
  await expect(page.locator('.composer-command-extra')).toHaveCount(0);
  await expect(page.locator('#composer-command')).toBeVisible();
  await expect(page.locator('#composer')).toHaveValue('Combine les deux skills.');
  await choose('skill:beta');
  await expect(page.locator('.composer-command-extra')).toHaveCount(1);
  await expect(page.locator('#composer')).toHaveValue('Combine les deux skills.');
  await expect(page.locator('#send-button')).toBeEnabled();
  await page.locator('#composer-form').screenshot({ path: join(outDir, 'composer-two-skills-fr.png') });
  checks.push('Duplicate skill selection dedupes, reload restores two chips, removing one keeps text');
  // Send multi-skill: Studio expands both the same way as the engine, no duplicate leading command.
  const prior = controls.length;
  await page.locator('#send-button').click();
  await expect.poll(() => controls.length).toBe(prior + 1);
  const sent = controls.at(-1).input.message;
  expect(sent).toContain('<skill name="alpha"');
  expect(sent).toContain('<skill name="beta"');
  expect(sent).toContain('Combine les deux skills.');
  expect(sent.startsWith('/skill:')).toBe(false);
  checks.push('Composer stacks 2 skill chips and sends both expanded blocks');
  await context.close();
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser?.close();
  await app.close();
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
    throw new Error('Fixture path outside temporary directory');
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
