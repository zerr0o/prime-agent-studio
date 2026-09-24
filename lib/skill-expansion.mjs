import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { formatMessage as tr } from '../public/i18n-core.js';
import { HttpError } from './store.mjs';
import { parseMultiSkillCommand } from './commands.mjs';

// Engine parity (packages/coding-agent/src/utils/frontmatter.ts + agent-session.ts):
// normalize newlines, split leading --- frontmatter, trim body, then
// <skill name="..." location="...">\nReferences are relative to <dir>.\n\n<body>\n</skill>
function stripFrontmatter(content) {
  const normalized = String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  if (!normalized.startsWith('---')) return normalized;
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return normalized;
  return normalized.slice(end + 4).trim();
}

export function skillBlockFor({ name, filePath, body }) {
  const baseDir = dirname(filePath);
  const trimmed = String(body || '').trim();
  return `<skill name="${name}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${trimmed}\n</skill>`;
}

function lookupSkill(catalog, name) {
  const wanted = `skill:${name}`;
  return (catalog?.commands || []).find((item) => item.name === wanted && item.source === 'skill');
}

// Expand 2+ leading /skill:name tokens the SAME way the engine expands one:
// identical block format, same SKILL.md files from the catalog (engine precedence),
// frontmatter stripped like the engine. Returns null when not a multi-skill message.
// Single-skill messages stay engine expanded to avoid any duplicate expansion.
async function readSkill(path, _encoding, maxChars) {
  const handle = await open(path, 'r');
  try {
    // UTF-8 needs at most four bytes per character. Read one extra byte to
    // detect growth too, without loading an arbitrarily large local file.
    const limit = maxChars * 4;
    if ((await handle.stat()).size > limit) throw new HttpError(400, tr('server.skills_trop_volumineux'));
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new HttpError(400, tr('server.skills_trop_volumineux'));
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function expandMultiSkillMessage(text, catalog, { read = readSkill, maxChars = 200000 } = {}) {
  const parsed = parseMultiSkillCommand(text);
  if (!parsed) return null;
  const blocks = [];
  let total = parsed.args.length;
  for (const name of parsed.names) {
    const entry = lookupSkill(catalog, name);
    if (!entry?.sourceInfo?.path)
      throw new HttpError(400, tr('server.skill_inconnu_dans_ce_projet', { value1: name }));
    let raw;
    try {
      raw = await read(entry.sourceInfo.path, 'utf8', maxChars);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, tr('server.skill_inconnu_dans_ce_projet', { value1: name }));
    }
    if (raw.length > maxChars) throw new HttpError(400, tr('server.skills_trop_volumineux'));
    const block = skillBlockFor({ name, filePath: entry.sourceInfo.path, body: stripFrontmatter(raw) });
    total += block.length + (blocks.length ? 2 : 0);
    if (total > maxChars) throw new HttpError(400, tr('server.skills_trop_volumineux'));
    blocks.push(block);
  }
  const expanded = parsed.args ? `${blocks.join('\n\n')}\n\n${parsed.args}` : blocks.join('\n\n');
  if (expanded.length > maxChars) throw new HttpError(400, tr('server.skills_trop_volumineux'));
  return expanded;
}
