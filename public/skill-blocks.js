// Collapsible skill blocks in user messages. Pure presentation: never alters
// what is sent to the model or stored in session history.
// Engine format (agent-session.ts _expandSkillCommand):
// <skill name="..." location="...">\nReferences are relative to ...\n\n<body>\n</skill>
const BLOCK_RE = /<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>/g;

export function parseSkillBlocks(text) {
  const input = String(text || '');
  const parts = [];
  let last = 0;
  BLOCK_RE.lastIndex = 0;
  let match;
  while ((match = BLOCK_RE.exec(input))) {
    if (match.index > last) parts.push({ type: 'text', text: input.slice(last, match.index) });
    parts.push({ type: 'skill', name: match[1], location: match[2], content: match[3] });
    last = match.index + match[0].length;
  }
  if (last < input.length) parts.push({ type: 'text', text: input.slice(last) });
  // Trim whitespace-only text edges so the user request stays visible without blank gaps.
  return parts
    .map((part) => (part.type === 'text' ? { ...part, text: part.text.trim() } : part))
    .filter((part) => (part.type === 'text' ? part.text.length > 0 : true));
}

export function hasSkillBlock(text) {
  BLOCK_RE.lastIndex = 0;
  return BLOCK_RE.test(String(text || ''));
}

export function stripSkillBlocks(text) {
  return parseSkillBlocks(text)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

export function readableCopyText(role, text) {
  if (role !== 'user') return String(text || '');
  if (!hasSkillBlock(text)) return String(text || '');
  return stripSkillBlocks(text) || String(text || '');
}
