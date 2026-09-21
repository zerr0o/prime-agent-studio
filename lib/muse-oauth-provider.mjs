// Direct Muse Code browser login adapter for PrimeAgentGUI.
// Provider id: muse-code, separate from paid meta provider.
// No environment fallback. No file access. No network until called.
//
// Official device flow (Meta public launcher):
// POST https://auth.meta.com/oidc/device/authorization/ with client_id only,
// then poll POST https://auth.meta.com/oidc/device/token/ with device_code.
// Launcher: https://api.meta.ai/muse-launcher.sh (and .ps1), client 1031625952748946.
// No PKCE. No localhost callback. No client secret. No OAuth refresh_token grant.
//
// EXPERIMENTAL key step (reverse engineered, not in official docs):
// POST https://api.meta.ai/muse-code/key with the account token mints the
// subscription inference key. Inference uses ONLY that minted key.

export const MUSE_OAUTH_PROVIDER_ID = 'muse-code';
export const MUSE_CODE_PROVIDER_ID = MUSE_OAUTH_PROVIDER_ID;
export const MUSE_PROVIDER_NAME = 'Muse Code';
export const MUSE_CODE_NAME = MUSE_PROVIDER_NAME;
export const MUSE_AUTH_URL = 'https://auth.meta.com';
export const MUSE_CLIENT_ID = '1031625952748946';
export const MUSE_DEVICE_AUTHZ_PATH = '/oidc/device/authorization/';
export const MUSE_DEVICE_TOKEN_PATH = '/oidc/device/token/';
export const MUSE_GRANT_DEVICE_CODE = 'urn:ietf:params:oauth:grant-type:device_code';
export const MUSE_KEY_URL = 'https://api.meta.ai/muse-code/key';
export const MUSE_API_VERSION = '1.0.0';
export const MUSE_BASE_URL = 'https://api.meta.ai/v1';
export const MUSE_MODELS_URL = 'https://api.meta.ai/v1/models';
export const MUSE_API = 'openai-responses';
export const MUSE_REQUEST_TIMEOUT_MS = 20000;
export const MUSE_KEY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MUSE_MAX_URL_LENGTH = 16000;
export const MUSE_ALLOWED_VERIFICATION_HOSTS = ['auth.meta.com'];

export const MUSE_CODE_MODELS = [
  {
    id: 'muse-spark-1.3',
    name: 'Muse Spark 1.3',
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    input: ['text', 'image'],
    cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 131072,
  },
  {
    id: 'muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3 Contributor (training allowed)',
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
    input: ['text', 'image'],
    cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 131072,
  },
];

export function museCodeModels() {
  return MUSE_CODE_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    thinkingLevelMap: { ...model.thinkingLevelMap },
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}

function isCleanToken(value, limit = 8192) {
  // Bearer and header safe: no whitespace anywhere (spaces would split headers).
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    !/\s/.test(value) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function fail(status, message) {
  const error = new Error(message);
  if (typeof status === 'number') error.status = status;
  return error;
}

function isAbortError(error) {
  return !!error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

function combinedSignal(callerSignal, timeoutMs) {
  const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : MUSE_REQUEST_TIMEOUT_MS;
  let timeoutSignal;
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      timeoutSignal = AbortSignal.timeout(timeout);
    }
  } catch { timeoutSignal = undefined; }
  if (!callerSignal) return timeoutSignal;
  if (!timeoutSignal) return callerSignal;
  try {
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([callerSignal, timeoutSignal]);
  } catch { /* keep caller signal */ }
  return callerSignal;
}

function checkAborted(signal) {
  if (signal && signal.aborted) throw fail(499, 'Muse Code sign-in was cancelled');
}

function validateAuthUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 500) {
    throw fail(400, 'Muse Code sign-in is misconfigured');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw fail(400, 'Muse Code sign-in is misconfigured'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw fail(400, 'Muse Code sign-in is misconfigured');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function validateVerificationUri(value) {
  if (typeof value !== 'string' || !value || value.length > MUSE_MAX_URL_LENGTH) {
    throw fail(400, 'Muse Code sign-in link is invalid');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw fail(400, 'Muse Code sign-in link is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw fail(400, 'Muse Code sign-in link is invalid');
  }
  // Reject explicit ports (even numeric): only default 443 with no port text.
  if (parsed.port) {
    throw fail(400, 'Muse Code sign-in link is invalid');
  }
  const host = parsed.hostname.toLowerCase();
  if (!MUSE_ALLOWED_VERIFICATION_HOSTS.includes(host)) {
    throw fail(400, 'Muse Code sign-in link is invalid');
  }
  return parsed.href;
}

async function readJsonObject(response) {
  // Malformed or unreadable bodies are always 502, even on HTTP 200:
  // a 200 with invalid JSON must not surface as status 200 failure.
  let text = '';
  try { text = await response.text(); } catch { throw fail(502, 'Muse Code request failed'); }
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    return {};
  } catch { throw fail(502, 'Muse Code request failed'); }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  const g = globalThis?.fetch;
  if (typeof g !== 'function') throw fail(500, 'Muse Code network is unavailable');
  return g.bind(globalThis);
}

export async function startDeviceAuthorization(options = {}) {
  const fetchImpl = resolveFetch(options.fetchImpl ?? options.fetch);
  const authUrl = validateAuthUrl(options.authUrl ?? MUSE_AUTH_URL);
  checkAborted(options.signal);
  const url = authUrl + MUSE_DEVICE_AUTHZ_PATH;
  const signal = combinedSignal(options.signal, options.timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: MUSE_CLIENT_ID }).toString(),
      redirect: 'error',
      signal,
    });
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) throw fail(499, 'Muse Code sign-in was cancelled');
    throw fail(502, 'Muse Code sign-in could not start');
  }
  checkAborted(options.signal);
  if (!response || !response.ok) throw fail(response?.status || 502, 'Muse Code sign-in could not start');
  const body = await readJsonObject(response);
  const deviceCode = typeof body.device_code === 'string' ? body.device_code : '';
  const userCode = typeof body.user_code === 'string' ? body.user_code : '';
  const verificationUri = typeof body.verification_uri === 'string' ? body.verification_uri : '';
  const completeRaw = typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : '';
  if (!isCleanToken(deviceCode, 4096) || !isCleanToken(userCode, 128) || !verificationUri) {
    throw fail(502, 'Muse Code sign-in could not start');
  }
  const verifiedUri = validateVerificationUri(verificationUri);
  let verifiedComplete = '';
  if (completeRaw) verifiedComplete = validateVerificationUri(completeRaw);
  let intervalSeconds = Number(body.interval);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) intervalSeconds = 5;
  intervalSeconds = Math.min(Math.max(Math.floor(intervalSeconds), 1), 30);
  let expiresInSeconds = Number(body.expires_in);
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) expiresInSeconds = 900;
  expiresInSeconds = Math.min(Math.max(Math.floor(expiresInSeconds), 60), 1800);
  const now = typeof options.now === 'number' ? options.now : Date.now();
  return { deviceCode, userCode, verificationUri: verifiedUri,
    verificationUriComplete: verifiedComplete || verifiedUri,
    intervalSeconds, expiresInSeconds, deadlineMs: now + expiresInSeconds * 1000 };
}

export async function pollDeviceToken(options = {}) {
  const fetchImpl = resolveFetch(options.fetchImpl ?? options.fetch);
  const authUrl = validateAuthUrl(options.authUrl ?? MUSE_AUTH_URL);
  if (!isCleanToken(options.deviceCode, 4096)) throw fail(400, 'Muse Code sign-in request is invalid');
  let intervalSeconds = Number(options.intervalSeconds ?? 5);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) intervalSeconds = 5;
  intervalSeconds = Math.min(Math.max(Math.floor(intervalSeconds), 1), 30);
  let deadlineMs = Number(options.deadlineMs);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    let expiresInSeconds = Number(options.expiresInSeconds ?? 900);
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) expiresInSeconds = 900;
    expiresInSeconds = Math.min(Math.max(Math.floor(expiresInSeconds), 60), 1800);
    const base = typeof options.now === 'number' ? options.now : Date.now();
    deadlineMs = base + expiresInSeconds * 1000;
  }
  const nowFn = typeof options.now === 'function' ? options.now : null;
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
  const url = authUrl + MUSE_DEVICE_TOKEN_PATH;
  const deviceCode = options.deviceCode;
  for (;;) {
    const current = nowFn ? nowFn() : Date.now();
    if (current >= deadlineMs) throw fail(410, 'Muse Code sign-in request expired');
    checkAborted(options.signal);
    await sleep(intervalSeconds * 1000);
    checkAborted(options.signal);
    const signal = combinedSignal(options.signal, options.timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: MUSE_GRANT_DEVICE_CODE, device_code: deviceCode, client_id: MUSE_CLIENT_ID }).toString(),
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw fail(499, 'Muse Code sign-in was cancelled');
      throw fail(502, 'Muse Code sign-in failed');
    }
    checkAborted(options.signal);
    if (response && response.ok) {
      const body = await readJsonObject(response);
      const token = typeof body.access_token === 'string' ? body.access_token : '';
      if (!isCleanToken(token)) throw fail(502, 'Muse Code sign-in failed');
      return token;
    }
    const body = await readJsonObject(response);
    const code = typeof body.error === 'string' ? body.error : '';
    if (code === 'authorization_pending') continue;
    if (code === 'slow_down') { intervalSeconds = Math.min(intervalSeconds + 5, 30); continue; }
    if (code === 'access_denied') throw fail(403, 'Muse Code sign-in was denied');
    if (code === 'expired_token') throw fail(410, 'Muse Code sign-in request expired');
    throw fail(response?.status || 502, 'Muse Code sign-in failed');
  }
}

// EXPERIMENTAL key exchange (reverse engineered, not in official docs).
export async function requestMuseKey(options = {}) {
  const identityToken = options.identityToken;
  if (!isCleanToken(identityToken)) throw fail(401, 'Muse Code session expired; sign in again');
  const fetchImpl = resolveFetch(options.fetchImpl ?? options.fetch);
  checkAborted(options.signal);
  const signal = combinedSignal(options.signal, options.timeoutMs);
  const onboard = options.onboard === true;
  let response;
  try {
    response = await fetchImpl(MUSE_KEY_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-version': MUSE_API_VERSION, Authorization: 'Bearer ' + identityToken },
      body: JSON.stringify(onboard ? { onboard: true } : {}),
      redirect: 'error',
      signal,
    });
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) throw fail(499, 'Muse Code request was cancelled');
    throw fail(502, 'Muse Code key request failed');
  }
  checkAborted(options.signal);
  if (!response || !response.ok) throw fail(response?.status || 502, 'Muse Code key request failed');
  const body = await readJsonObject(response);
  if (body.is_subs_active !== true) throw fail(403, 'Muse Code subscription is inactive');
  if (body.require_payment === true) throw fail(403, 'Muse Code subscription needs payment');
  const actionUrl = typeof body.action_url === 'string' ? body.action_url.trim() : '';
  const paymentUrl = typeof body.require_payment_action_url === 'string' ? body.require_payment_action_url.trim() : '';
  if (actionUrl || paymentUrl) throw fail(403, 'Muse Code subscription needs payment');
  const apiKey = typeof body.api_key === 'string' ? body.api_key : '';
  if (!isCleanToken(apiKey)) throw fail(502, 'Muse Code key response is invalid');
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const emailRaw = typeof body.user_email === 'string' ? body.user_email.trim().toLowerCase() : '';
  const accountId = userId || emailRaw;
  if (!accountId) throw fail(502, 'Muse Code key response is invalid');
  const tierId = typeof body.subs_tier_id === 'string' && body.subs_tier_id.trim() ? body.subs_tier_id.trim() : undefined;
  const tierName = typeof body.subs_tier_name === 'string' && body.subs_tier_name.trim() ? body.subs_tier_name.trim() : undefined;
  return { apiKey, accountId, email: emailRaw || undefined, tierId, tierName };
}

export function encodeMuseCredential(oauthAccessToken, apiKey) {
  if (!isCleanToken(oauthAccessToken) || !isCleanToken(apiKey)) {
    throw fail(400, 'Muse Code credential is invalid; sign in again');
  }
  return JSON.stringify({ oauthAccessToken, apiKey });
}

export function parseMuseCredential(value) {
  let raw = value;
  if (raw && typeof raw === 'object' && typeof raw.access === 'string') raw = raw.access;
  if (typeof raw !== 'string' || !raw || raw.length > 16384) {
    throw fail(400, 'Muse Code credential is invalid; sign in again');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw fail(400, 'Muse Code credential is invalid; sign in again'); }
  const oauthAccessToken = parsed && typeof parsed.oauthAccessToken === 'string' ? parsed.oauthAccessToken : '';
  const apiKey = parsed && typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
  if (!isCleanToken(oauthAccessToken) || !isCleanToken(apiKey)) {
    throw fail(400, 'Muse Code credential is invalid; sign in again');
  }
  return { oauthAccessToken, apiKey };
}

// Inference uses ONLY the minted subscription key. No account token. No env key.
export function getInferenceApiKey(stored) {
  return parseMuseCredential(stored).apiKey;
}

export function buildInferenceHeaders(mintedKey) {
  if (!isCleanToken(mintedKey)) throw fail(400, 'Muse Code credential is invalid; sign in again');
  return { Authorization: 'Bearer ' + mintedKey, 'x-api-version': MUSE_API_VERSION };
}

export function isMuseCredentialExpired(stored, now = Date.now()) {
  const expires = stored && typeof stored.expires === 'number' ? stored.expires : NaN;
  if (!Number.isFinite(expires) || expires <= 0) return true;
  const current = typeof now === 'number' ? now : Date.now();
  return current >= expires;
}

export async function refreshMuseCredential(stored, options = {}) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw fail(401, 'Muse Code session expired; sign in again');
  }
  if (stored.type !== undefined && stored.type !== 'oauth') {
    throw fail(401, 'Muse Code session expired; sign in again');
  }
  let identity = '';
  if (typeof stored.refresh === 'string' && stored.refresh.trim()) identity = stored.refresh.trim();
  if (!identity) {
    try { identity = parseMuseCredential(stored.access).oauthAccessToken; } catch {
      throw fail(401, 'Muse Code session expired; sign in again');
    }
  }
  if (!isCleanToken(identity)) throw fail(401, 'Muse Code session expired; sign in again');
  const fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis?.fetch;
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const minted = await requestMuseKey({ identityToken: identity, fetchImpl, signal: options.signal, onboard: false, timeoutMs: options.timeoutMs });
  return { type: 'oauth', access: encodeMuseCredential(identity, minted.apiKey), refresh: identity,
    expires: now + MUSE_KEY_REFRESH_INTERVAL_MS, accountId: minted.accountId, email: minted.email };
}

export const refreshMuseKey = refreshMuseCredential;

// Login runs ONLY when the user starts it from the provider card.
// Maps device code to onAuth display, polls, then mints the subscription key.
// Native contract (pi-ai OAuthLoginCallbacks + OAuthProviderInterface):
// login(callbacks) with signal inside callbacks; the second options arg is a
// local test hook only (fetchImpl/sleep/now/timeoutMs/authUrl). Native calls
// with a single arg, which still works because options defaults to {}.
// onAuth rejection stops login before polling: the UI rejected the URL or job.
export async function museCodeLogin(callbacks = {}, options = {}) {
  const ui = callbacks && typeof callbacks === 'object' ? callbacks : {};
  const opts = options && typeof options === 'object' ? options : {};
  const effectiveSignal = opts.signal ?? ui.signal;
  const fetchImpl = opts.fetchImpl ?? opts.fetch ?? globalThis?.fetch;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  const startNow = typeof opts.now === 'number' ? opts.now : Date.now();
  if (typeof ui.onProgress === 'function') { try { ui.onProgress('Starting Muse Code sign-in'); } catch {} }
  const started = await startDeviceAuthorization({ fetchImpl, signal: effectiveSignal, authUrl: opts.authUrl, timeoutMs: opts.timeoutMs, now: startNow });
  const url = started.verificationUriComplete || started.verificationUri;
  if (typeof ui.onAuth === 'function') {
    await ui.onAuth({ url, instructions: 'Enter code: ' + started.userCode });
  }
  if (typeof ui.onProgress === 'function') { try { ui.onProgress('Waiting for Muse Code approval'); } catch {} }
  const identityToken = await pollDeviceToken({ fetchImpl, deviceCode: started.deviceCode,
    intervalSeconds: started.intervalSeconds, deadlineMs: started.deadlineMs,
    signal: effectiveSignal, authUrl: opts.authUrl, timeoutMs: opts.timeoutMs, sleep });
  if (typeof ui.onProgress === 'function') { try { ui.onProgress('Confirming Muse Code subscription'); } catch {} }
  const minted = await requestMuseKey({ identityToken, fetchImpl, signal: effectiveSignal, onboard: true, timeoutMs: opts.timeoutMs });
  const endNow = typeof opts.now === 'number' ? opts.now : Date.now();
  return { access: encodeMuseCredential(identityToken, minted.apiKey), refresh: identityToken,
    expires: endNow + MUSE_KEY_REFRESH_INTERVAL_MS, accountId: minted.accountId, email: minted.email };
}

// Native contract (pi-ai OAuthProviderInterface):
// refreshToken(credentials) with a single param, no signal, no fetch hook.
// The native engine calls it with one arg and persists the returned shape
// under its own file lock. Any second arg is ignored by design so unknown
// native context shapes can never change refresh behavior. Use the low level
// refreshMuseCredential(stored, { fetchImpl, signal, timeoutMs, now }) in app
// code and tests when fetch injection is needed.
export async function museCodeRefresh(credentials) {
  return refreshMuseCredential(credentials, {});
}

// Sync native accessor: never throws, so fingerprinting and listing stay up
// with a corrupt stored entry. Strict parsing lives in getInferenceApiKey
// (low level) and refresh validation; invalid credentials yield empty string
// here and fail closed at request time. Empty string cannot fall back to paid
// keys: muse-code is a separate id with no apiKey field and no env mapping.
export function museCodeGetApiKey(credentials) {
  try {
    return getInferenceApiKey(credentials);
  } catch {
    return '';
  }
}

export const museCodeOAuthAdapter = {
  name: 'Muse Code (browser login)',
  login: museCodeLogin,
  refreshToken: museCodeRefresh,
  getApiKey: museCodeGetApiKey,
};

export const oauth = museCodeOAuthAdapter;
export const MUSE_OAUTH_ADAPTER = museCodeOAuthAdapter;

