// Formatting is for the preview only. Original file bytes are never rewritten.
export function formatJson(text) {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  // Keep original number/string literals, duplicate keys and key order intact.
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) || [];
  const parts = [];
  let depth = 0,
    length = 0;
  const newline = () => '\n' + '  '.repeat(depth);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let chunk = token;
    if (token === '{' || token === '[') {
      if (++depth > 80) return null;
      if (tokens[i + 1] !== (token === '{' ? '}' : ']')) chunk += newline();
    } else if (token === '}' || token === ']') {
      depth--;
      if (tokens[i - 1] !== (token === '}' ? '{' : '[')) chunk = newline() + token;
    } else if (token === ',') chunk += newline();
    else if (token === ':') chunk += ' ';
    length += chunk.length;
    if (length > 2 * 1024 * 1024) return null;
    parts.push(chunk);
  }
  return parts.join('');
}

// Image extensions served inline by the project-files preview API (lib/project-files.mjs).
export function isImagePath(path) {
  return /\.(png|jpe?g|webp|gif)$/i.test(String(path || ''));
}

// Folder that contains a project-relative path ('' for the project root).
export function parentFolder(path) {
  const value = String(path || '');
  const index = value.lastIndexOf('/');
  return index < 0 ? '' : value.slice(0, index);
}

// Viewer mode used when a file row is activated: images always open their
// content preview, deleted files keep their diff view, other tracked changes
// keep the diff view, and plain browser entries open the content preview.
export function defaultFileView(file) {
  if (!file || typeof file !== 'object') return 'preview';
  if (file.directory) return 'preview';
  if (file.deleted) return 'diff';
  if (file.status && !isImagePath(file.path)) return 'diff';
  return 'preview';
}

export function filePresentation(path, text) {
  if (/\.(md|markdown|mdown|mkd)$/i.test(path)) return { kind: 'markdown', label: 'Markdown', text };
  if (/\.json$/i.test(path)) {
    const formatted = formatJson(text);
    if (formatted !== null) return { kind: 'json', label: 'JSON', text: formatted };
  }
  return { kind: 'text', text };
}
