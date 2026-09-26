// Tiny shared JSONC reader for models.json provider-override detection.
// Only node:fs, no UI or heavy imports, safe for workers and extensions.
import { existsSync, readFileSync } from 'node:fs';

export function stripJsonComments(input) {
  return String(input)
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ''))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? match);
}

// True when models.json defines ANY providers.<providerId> entry. Missing
// file reads false. Unreadable or malformed content fails closed (reads
// true) so a canonical definition can never clobber config we cannot see.
export function hasUserProviderConfig(modelsJsonPath, providerId) {
  try {
    if (typeof modelsJsonPath !== 'string' || !modelsJsonPath) return false;
    if (!existsSync(modelsJsonPath)) return false;
    let raw;
    try {
      raw = readFileSync(modelsJsonPath, 'utf8');
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
      return true;
    }
    const parsed = JSON.parse(stripJsonComments(raw));
    return !!(parsed && typeof parsed === 'object' && parsed.providers && parsed.providers[providerId] !== undefined);
  } catch {
    return true;
  }
}
