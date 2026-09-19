// Regenerate README illustrations from the current UI with isolated demonstration data.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedImages = {
  core: [
    'desktop-conversation', 'desktop-projects', 'desktop-project-import', 'roadmap-expanded',
    'desktop-live-messages', 'desktop-attachments', 'desktop-interactive-questions',
    'desktop-models', 'desktop-new-conversation-agents',
  ],
  tools: [
    'desktop-providers', 'desktop-mcp', 'desktop-commands', 'desktop-document-preview',
    'desktop-knowledge', 'desktop-session',
  ],
  platforms: [
    'mobile-conversation', 'desktop-remote-access', 'mobile-notifications', 'desktop-startup', 'desktop-updates',
  ],
};
const allGroups = Object.keys(expectedImages);
let language = 'all';
let output = join(root, 'docs', 'screenshots');
const groups = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--docs-en') language = 'en';
  else if (arg === '--lang' && args[index + 1]) language = args[++index];
  else if (arg === '--output' && args[index + 1]) output = resolve(args[++index]);
  else if (arg === '--group' && args[index + 1]) groups.push(args[++index]);
  else if (arg === '--help') {
    console.log(
      'Usage: node scripts/capture-readme.mjs [--lang fr|en|all] [--group core|tools|platforms] [--output directory]',
    );
    console.log(
      'Defaults: both languages, all groups, docs/screenshots. --docs-en remains an alias for --lang en.',
    );
    process.exit(0);
  } else throw new Error(`Unknown or incomplete argument: ${arg}`);
}
if (!['fr', 'en', 'all'].includes(language)) throw new Error('Language must be fr, en, or all.');
if (groups.some((group) => !allGroups.includes(group))) throw new Error('Unknown capture group.');
const selected = groups.length ? [...new Set(groups)] : allGroups;

function run(script, args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, PRIME_STUDIO_BROWSER: process.env.PRIME_STUDIO_BROWSER || 'chromium' },
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) done();
      else
        reject(
          new Error(
            `${relative(root, script)} failed (${signal || code}). Final screenshots were not replaced.`,
          ),
        );
    });
  });
}

async function inventory(folder, prefix = '') {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isDirectory() && !prefix && ['fr', 'en'].includes(entry.name))
      files.push(...(await inventory(join(folder, entry.name), `${entry.name}/`)));
    else if (entry.isFile() && /^(?:desktop|mobile|roadmap)-[a-z-]+\.png$/.test(entry.name))
      files.push({ source: prefix + entry.name, file: (prefix === 'fr/' ? '' : prefix) + entry.name });
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

const staging = await mkdtemp(join(tmpdir(), 'prime-readme-suite-'));
const manifest = {
  generatedAt: new Date().toISOString(),
  language,
  groups: selected,
  interface: 'Current repository HTML, JavaScript and styles; isolated fictional fixtures.',
  limitation:
    'Provider, agent, MCP, native desktop and network services may be simulated. Screenshots are not live-service test evidence.',
  nativeAgentsStarted: 0,
  screenshots: [],
  scenarios: {},
};
try {
  const targets = new Set();
  for (const group of selected) {
    const groupOutput = join(staging, group);
    const commandArgs = ['--output', groupOutput];
    if (language !== 'all') commandArgs.push('--lang', language);
    await run(join(root, 'scripts', 'readme-captures', `${group}.mjs`), commandArgs);
    const files = await inventory(groupOutput);
    if (!files.length) throw new Error(`${group} produced no screenshots.`);
    const produced = new Set(files.map((item) => item.file));
    for (const lang of language === 'all' ? ['fr', 'en'] : [language]) {
      for (const name of expectedImages[group]) {
        const file = `${lang === 'en' ? 'en/' : ''}${name}.png`;
        if (!produced.has(file)) throw new Error(`${group} did not produce required screenshot ${file}.`);
      }
    }
    try {
      manifest.scenarios[group] = JSON.parse(await readFile(join(groupOutput, 'report.json'), 'utf8'));
    } catch (error) {
      throw new Error(`${group} did not produce a readable report.json.`, { cause: error });
    }
    for (const { source, file } of files) {
      const fileLanguage = file.startsWith('en/') ? 'en' : 'fr';
      if (language !== 'all' && fileLanguage !== language)
        throw new Error(`${group} produced an unrequested language: ${file}`);
      if (targets.has(file)) throw new Error(`Duplicate screenshot target: ${file}`);
      targets.add(file);
      const bytes = await readFile(join(groupOutput, source));
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error(`Not a PNG: ${file}`);
      manifest.screenshots.push({
        group,
        source,
        file,
        language: file.startsWith('en/') ? 'en' : 'fr',
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  // Capture every requested group successfully before replacing any published illustration.
  for (const item of manifest.screenshots) {
    const destination = join(output, item.file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(staging, item.group, item.source), destination);
  }
  await mkdir(join(root, 'test-results'), { recursive: true });
  const reportPath = join(root, 'test-results', 'readme-captures.json');
  await writeFile(reportPath, JSON.stringify({ ...manifest, output }, null, 2) + '\n');
  console.log(`${manifest.screenshots.length} fresh screenshots saved to ${output}. Report: ${reportPath}`);
} finally {
  await rm(staging, { recursive: true, force: true, maxRetries: 5 });
}
