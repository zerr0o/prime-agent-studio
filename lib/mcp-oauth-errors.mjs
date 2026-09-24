import { formatMessage as tr } from '../public/i18n-core.js';

const MAX_DETAIL = 500;

export function sanitizeOAuthDetail(value) {
  let text = value instanceof Error ? value.message : String(value ?? '');
  text = text
    .replace(/([?&](?:code|state|client_secret|refresh_token|access_token|id_token)=)[^&\s]*/gi, '$1…')
    .replace(/\b((?:client_secret|refresh_token|access_token|id_token)\s*[:=]\s*)\S+/gi, '$1…')
    .replace(/\b((?:code|state)\s*=\s*)[A-Za-z0-9._~-]{8,}/gi, '$1…')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > MAX_DETAIL) text = text.slice(0, MAX_DETAIL).trimEnd() + '…';
  return text;
}

export function isConfidentialClientError(detail) {
  if (/client_secret|invalid_client|confidential/i.test(detail)) return true;
  return /token request to \S+ failed: 422/i.test(detail);
}

export function isCancelError(value) {
  const text = value instanceof Error ? value.message : String(value ?? '');
  return /^cancelled$|^login cancelled$|was cancelled/i.test(text.trim());
}

export function oauthErrorMessage(error) {
  if (isCancelError(error)) return tr('server.connexion_oauth_annulee');
  const detail = sanitizeOAuthDetail(error);
  if (!detail) return tr('server.oauth_a_echoue_detail', { value1: 'unknown error' });
  if (isConfidentialClientError(detail))
    return tr('server.oauth_client_confidentiel_requis', { value1: detail });
  return tr('server.oauth_a_echoue_detail', { value1: detail });
}

const TOKEN_PREFIXES = [
  'sbp_v0_',
  'sbp_',
  'ghp_',
  'gho_',
  'github_pat_',
  'glpat-',
  'sk_live_',
  'sk-',
  'xoxb-',
  'xoxp-',
];
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CONVENTIONAL_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
export function looksLikePastedToken(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const prefix of TOKEN_PREFIXES) if (lower.startsWith(prefix)) return true;
  // Compact JWT (header.payload.signature), e.g. eyJhbGciOi...
  if (JWT_SHAPE.test(text)) return true;
  // Conventional names stay names, however long: MON_SERVICE_TOKEN.
  if (CONVENTIONAL_ENV_NAME.test(text)) return false;
  // Long mixed-case secrets without name shape: sbp_ plus hex, API keys.
  if (text.length >= 32 && /[a-z]/.test(text) && /[0-9]/.test(text)) return true;
  if (/[^A-Za-z0-9_]/.test(text) && text.length >= 12) return true;
  return text.length > 64;
}
