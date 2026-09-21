import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverCli } from '../lib/agent.mjs';
import {
  MUSE_OAUTH_PROVIDER_ID,
  MUSE_CODE_PROVIDER_ID,
  MUSE_AUTH_URL,
  MUSE_CLIENT_ID,
  MUSE_DEVICE_AUTHZ_PATH,
  MUSE_DEVICE_TOKEN_PATH,
  MUSE_GRANT_DEVICE_CODE,
  MUSE_KEY_URL,
  MUSE_API_VERSION,
  MUSE_BASE_URL,
  MUSE_API,
  MUSE_ALLOWED_VERIFICATION_HOSTS,
  MUSE_CODE_MODELS,
  museCodeModels,
  startDeviceAuthorization,
  pollDeviceToken,
  requestMuseKey,
  encodeMuseCredential,
  parseMuseCredential,
  getInferenceApiKey,
  buildInferenceHeaders,
  isMuseCredentialExpired,
  refreshMuseCredential,
  refreshMuseKey,
  museCodeLogin,
  museCodeRefresh,
  museCodeGetApiKey,
  museCodeOAuthAdapter,
  oauth,
  MUSE_OAUTH_ADAPTER,
} from '../lib/muse-oauth-provider.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const mockFetch = (handler) => {
  const calls = [];
  const fn = async (url, opts = {}) => { calls.push({ url, opts }); return handler(url, opts, calls); };
  fn.calls = calls;
  return fn;
};
const noSleep = async () => {};

test('contract matches sibling gate and public launcher facts', async () => {
  assert.equal(MUSE_OAUTH_PROVIDER_ID, 'muse-code');
  assert.equal(MUSE_CODE_PROVIDER_ID, 'muse-code');
  assert.equal(MUSE_AUTH_URL, 'https://auth.meta.com');
  assert.equal(MUSE_CLIENT_ID, '1031625952748946');
  assert.equal(MUSE_DEVICE_AUTHZ_PATH, '/oidc/device/authorization/');
  assert.equal(MUSE_DEVICE_TOKEN_PATH, '/oidc/device/token/');
  assert.equal(MUSE_GRANT_DEVICE_CODE, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(MUSE_KEY_URL, 'https://api.meta.ai/muse-code/key');
  assert.equal(MUSE_API_VERSION, '1.0.0');
  assert.equal(MUSE_BASE_URL, 'https://api.meta.ai/v1');
  assert.equal(MUSE_API, 'openai-responses');
  assert.deepEqual(MUSE_ALLOWED_VERIFICATION_HOSTS, ['auth.meta.com']);
  assert.equal(museCodeOAuthAdapter.name, 'Muse Code (browser login)');
  assert.equal(oauth, museCodeOAuthAdapter);
  assert.equal(MUSE_OAUTH_ADAPTER, museCodeOAuthAdapter);
  assert.equal(typeof museCodeOAuthAdapter.login, 'function');
  assert.equal(typeof museCodeOAuthAdapter.refreshToken, 'function');
  assert.equal(typeof museCodeOAuthAdapter.getApiKey, 'function');
  assert.equal(refreshMuseKey, refreshMuseCredential);
  const source = await readFile(join(ROOT, 'lib/muse-oauth-provider.mjs'), 'utf8');
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /MODEL_API_KEY/);
  assert.doesNotMatch(source, /META_API_KEY/);
  assert.doesNotMatch(source, /\u2014/);
  assert.match(source, /EXPERIMENTAL/);
});

test('models stay subscription scoped with reasoning defaults', () => {
  assert.equal(MUSE_CODE_MODELS.length, 2);
  for (const model of museCodeModels()) {
    assert.equal(model.reasoning, true);
    assert.equal(model.thinkingLevelMap.off, null);
    assert.ok(!Object.values(model.thinkingLevelMap).includes('none'));
    assert.deepEqual(model.input, ['text', 'image']);
    assert.equal(model.contextWindow, 1048576);
  }
  const first = museCodeModels();
  first[0].id = 'mutated';
  assert.notEqual(museCodeModels()[0].id, 'mutated');
});

test('credential encode and parse roundtrip and fail closed', () => {
  const encoded = encodeMuseCredential('identity-abc', 'minted-key-123');
  assert.deepEqual(parseMuseCredential(encoded), { oauthAccessToken: 'identity-abc', apiKey: 'minted-key-123' });
  assert.deepEqual(parseMuseCredential({ access: encoded }), { oauthAccessToken: 'identity-abc', apiKey: 'minted-key-123' });
  for (const bad of ['', 'not-json', JSON.stringify({}), JSON.stringify({ oauthAccessToken: '', apiKey: 'k' }), 'a\n b']) {
    assert.throws(() => parseMuseCredential(bad), (e) => e.message.includes('sign in again'));
  }
  assert.throws(() => encodeMuseCredential('', 'k'));
  assert.throws(() => encodeMuseCredential('id', ''));
  try { parseMuseCredential(JSON.stringify({ oauthAccessToken: 'secret-id', apiKey: '' })); assert.fail('must throw'); }
  catch (e) { assert.doesNotMatch(e.message, /secret-id/); }
});

test('device authorization posts client_id and validates allowlisted link', async () => {
  const fetch = mockFetch(async (url, opts) => {
    assert.equal(url, 'https://auth.meta.com/oidc/device/authorization/');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.redirect, 'error');
    assert.ok(opts.signal);
    assert.match(opts.headers['Content-Type'], /x-www-form-urlencoded/);
    assert.match(String(opts.body), /client_id=1031625952748946/);
    return jsonResponse({ device_code: 'dev-1', user_code: 'USER-1', verification_uri: 'https://auth.meta.com/oidc/verify', verification_uri_complete: 'https://auth.meta.com/oidc/verify?code=USER-1', interval: 5, expires_in: 900 });
  });
  const started = await startDeviceAuthorization({ fetchImpl: fetch, sleep: noSleep, now: 1000 });
  assert.equal(started.deviceCode, 'dev-1');
  assert.equal(started.userCode, 'USER-1');
  assert.equal(started.verificationUri, 'https://auth.meta.com/oidc/verify');
  assert.equal(started.intervalSeconds, 5);
  assert.equal(started.deadlineMs, 1000 + 900 * 1000);
  assert.equal(fetch.calls.length, 1);
});

test('device authorization rejects arbitrary browser links', async () => {
  for (const uri of ['http://auth.meta.com/oidc/verify', 'https://evil.example/verify', 'javascript:alert(1)', 'https://auth.meta.com:443@evil.example/']) {
    const fetch = mockFetch(async () => jsonResponse({ device_code: 'd', user_code: 'U', verification_uri: uri, interval: 5, expires_in: 900 }));
    await assert.rejects(startDeviceAuthorization({ fetchImpl: fetch, sleep: noSleep }), (e) => e.message.includes('link is invalid'));
  }
  const missing = mockFetch(async () => jsonResponse({ device_code: '', user_code: '', verification_uri: '' }));
  await assert.rejects(startDeviceAuthorization({ fetchImpl: missing, sleep: noSleep }), /could not start/);
  const denied = mockFetch(async () => jsonResponse({ error: 'x' }, 500));
  try { await startDeviceAuthorization({ fetchImpl: denied, sleep: noSleep }); assert.fail('must throw'); }
  catch (e) { assert.equal(e.status, 500); assert.doesNotMatch(e.message, /x/); }
});

test('device authorization honors cancellation and short deadlines', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = mockFetch(async () => { assert.fail('aborted fetch must not run'); });
  await assert.rejects(startDeviceAuthorization({ fetchImpl: fetch, signal: controller.signal }), (e) => e.status === 499);
  const slow = mockFetch(async (url, opts) => {
    assert.ok(opts.signal);
    return jsonResponse({ device_code: 'd', user_code: 'U', verification_uri: 'https://auth.meta.com/v', interval: 5, expires_in: 900 });
  });
  await startDeviceAuthorization({ fetchImpl: slow, timeoutMs: 50 });
});

test('device polling handles pending and slow_down then returns token', async () => {
  const delays = [];
  let polls = 0;
  const fetch = mockFetch(async (url, opts) => {
    assert.equal(url, 'https://auth.meta.com/oidc/device/token/');
    assert.equal(opts.redirect, 'error');
    polls += 1;
    if (polls === 1) return jsonResponse({ error: 'authorization_pending' }, 400);
    if (polls === 2) return jsonResponse({ error: 'slow_down' }, 400);
    return jsonResponse({ access_token: 'identity-xyz' });
  });
  const token = await pollDeviceToken({ fetchImpl: fetch, deviceCode: 'dev-1', intervalSeconds: 1, expiresInSeconds: 900, sleep: async (ms) => { delays.push(ms); } });
  assert.equal(token, 'identity-xyz');
  assert.deepEqual(delays, [1000, 1000, 6000]);
});

test('device polling fails closed on denial expiry deadline and cancel', async () => {
  const denied = mockFetch(async () => jsonResponse({ error: 'access_denied' }, 400));
  await assert.rejects(pollDeviceToken({ fetchImpl: denied, deviceCode: 'd', sleep: noSleep }), (e) => e.status === 403);
  const expired = mockFetch(async () => jsonResponse({ error: 'expired_token' }, 400));
  await assert.rejects(pollDeviceToken({ fetchImpl: expired, deviceCode: 'd', sleep: noSleep }), (e) => e.status === 410);
  const never = mockFetch(async () => { assert.fail('deadline must stop polling'); });
  await assert.rejects(pollDeviceToken({ fetchImpl: never, deviceCode: 'd', deadlineMs: Date.now() - 1, sleep: noSleep }), (e) => e.status === 410);
  const controller = new AbortController();
  controller.abort();
  const cancelled = mockFetch(async () => { assert.fail('aborted poll must not fetch'); });
  await assert.rejects(pollDeviceToken({ fetchImpl: cancelled, deviceCode: 'd', signal: controller.signal, sleep: noSleep }), (e) => e.status === 499);
});

test('experimental key mint requires active subscription and hides raw bodies', async () => {
  const good = { api_key: 'minted-1', user_id: 'user-1', user_email: 'User@Example.com', is_subs_active: true, subs_tier_id: 'high', subs_tier_name: 'High' };
  const fetch = mockFetch(async (url, opts) => {
    assert.equal(url, 'https://api.meta.ai/muse-code/key');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.headers['x-api-version'], '1.0.0');
    assert.match(opts.headers.Authorization, /^Bearer identity-1$/);
    assert.match(String(opts.body), /onboard/);
    return jsonResponse(good);
  });
  const minted = await requestMuseKey({ identityToken: 'identity-1', fetchImpl: fetch, onboard: true });
  assert.equal(minted.apiKey, 'minted-1');
  assert.equal(minted.accountId, 'user-1');
  assert.equal(minted.email, 'user@example.com');
  for (const body of [{}, { is_subs_active: false }, { is_subs_active: 'yes' }, { is_subs_active: true, require_payment: true }, { is_subs_active: true, action_url: 'https://pay.example/' }, { is_subs_active: true, require_payment_action_url: 'https://pay.example/' }, { is_subs_active: true }]) {
    const f = mockFetch(async () => jsonResponse(body));
    await assert.rejects(requestMuseKey({ identityToken: 'identity-1', fetchImpl: f }), (e) => e.status === 403 || e.status === 502);
  }
  const secretBody = { error_detail: 'leaked-secret-value-xyz', is_subs_active: false };
  const f2 = mockFetch(async () => jsonResponse(secretBody, 403));
  try { await requestMuseKey({ identityToken: 'identity-1', fetchImpl: f2 }); assert.fail('must throw'); }
  catch (e) { assert.doesNotMatch(e.message, /leaked-secret/); assert.equal(e.status, 403); }
  const authed = mockFetch(async () => jsonResponse({ error: 'denied' }, 401));
  await assert.rejects(requestMuseKey({ identityToken: 'identity-1', fetchImpl: authed }), (e) => e.status === 401);
});

test('inference uses only minted key with no env fallback', async (t) => {
  t.after(() => { delete process.env.MUSE_TEST_MODEL_KEY; delete process.env.MUSE_TEST_META_KEY; });
  process.env.MUSE_TEST_MODEL_KEY = 'env-payg-key';
  process.env.MUSE_TEST_META_KEY = 'env-meta-key';
  const encoded = encodeMuseCredential('identity-1', 'minted-only');
  assert.equal(getInferenceApiKey(encoded), 'minted-only');
  assert.equal(getInferenceApiKey({ access: encoded }), 'minted-only');
  assert.equal(museCodeGetApiKey({ access: encoded }), 'minted-only');
  assert.throws(() => getInferenceApiKey('identity-1'));
  const headers = buildInferenceHeaders('minted-only');
  assert.deepEqual(headers, { Authorization: 'Bearer minted-only', 'x-api-version': '1.0.0' });
  assert.throws(() => buildInferenceHeaders(''));
});

test('expiry and refresh return native shape under caller lock', async () => {
  assert.equal(isMuseCredentialExpired({}), true);
  assert.equal(isMuseCredentialExpired({ expires: Date.now() + 10000 }), false);
  assert.equal(isMuseCredentialExpired({ expires: Date.now() - 1 }), true);
  const fetch = mockFetch(async (url, opts) => {
    assert.match(String(opts.body), /\{\}/);
    assert.doesNotMatch(String(opts.body), /onboard/);
    return jsonResponse({ api_key: 'minted-2', user_id: 'user-1', is_subs_active: true });
  });
  const stored = { type: 'oauth', access: encodeMuseCredential('identity-1', 'minted-1'), refresh: 'identity-1', expires: 1, accountId: 'user-1' };
  const now = 5000;
  const next = await refreshMuseCredential(stored, { fetchImpl: fetch, now });
  assert.equal(next.type, 'oauth');
  assert.equal(next.refresh, 'identity-1');
  assert.equal(next.accountId, 'user-1');
  assert.equal(next.expires, now + 24 * 60 * 60 * 1000);
  assert.equal(parseMuseCredential(next.access).apiKey, 'minted-2');
  assert.equal(museCodeGetApiKey(next), 'minted-2');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    const viaAdapter = await museCodeRefresh(stored);
    assert.equal(parseMuseCredential(viaAdapter.access).apiKey, 'minted-2');
    const ignoredSecondArg = await museCodeRefresh(stored, { fetchImpl: async () => { throw new Error('second arg must be ignored'); } });
    assert.equal(parseMuseCredential(ignoredSecondArg.access).apiKey, 'minted-2');
  } finally {
    globalThis.fetch = previousFetch;
  }
  await assert.rejects(refreshMuseCredential({ type: 'api_key' }, { fetchImpl: fetch }));
  await assert.rejects(refreshMuseCredential({ type: 'oauth' }, { fetchImpl: fetch }));
});

test('adapter login maps device code to onAuth and mints without env use', async () => {
  let step = 0;
  const fetch = mockFetch(async (url) => {
    step += 1;
    if (url.endsWith('/oidc/device/authorization/')) return jsonResponse({ device_code: 'dev-9', user_code: 'CODE-9', verification_uri: 'https://auth.meta.com/oidc/verify', verification_uri_complete: 'https://auth.meta.com/oidc/verify?code=CODE-9', interval: 1, expires_in: 900 });
    if (url.endsWith('/oidc/device/token/')) {
      if (step === 2) return jsonResponse({ error: 'authorization_pending' }, 400);
      return jsonResponse({ access_token: 'identity-9' });
    }
    if (url === 'https://api.meta.ai/muse-code/key') return jsonResponse({ api_key: 'minted-9', user_id: 'user-9', is_subs_active: true });
    throw new Error('unexpected url');
  });
  let authShown = null;
  const credential = await museCodeLogin({ onAuth: async (info) => { authShown = info; }, onProgress: () => {} }, { fetchImpl: fetch, sleep: noSleep });
  assert.equal(authShown.url, 'https://auth.meta.com/oidc/verify?code=CODE-9');
  assert.match(authShown.instructions, /CODE-9/);
  assert.doesNotMatch(JSON.stringify(authShown), /dev-9/);
  assert.equal(credential.refresh, 'identity-9');
  assert.equal(credential.accountId, 'user-9');
  assert.equal(parseMuseCredential(credential.access).apiKey, 'minted-9');
  assert.equal(museCodeOAuthAdapter.getApiKey(credential), 'minted-9');
  assert.equal(step, 4);
});

test('adapter login fails closed when subscription is inactive', async () => {
  const fetch = mockFetch(async (url) => {
    if (url.endsWith('/oidc/device/authorization/')) return jsonResponse({ device_code: 'd', user_code: 'U', verification_uri: 'https://auth.meta.com/v', interval: 1, expires_in: 900 });
    if (url.endsWith('/oidc/device/token/')) return jsonResponse({ access_token: 'identity-x' });
    return jsonResponse({ is_subs_active: false });
  });
  await assert.rejects(museCodeLogin({ onAuth: async () => {} }, { fetchImpl: fetch, sleep: noSleep }), (e) => e.status === 403);
});


test('login honors callbacks.signal and stops when onAuth rejects', async () => {
  const startedFetch = mockFetch(async () => jsonResponse({ device_code: 'd', user_code: 'U', verification_uri: 'https://auth.meta.com/v', interval: 1, expires_in: 900 }));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    museCodeLogin({ signal: aborted.signal, onAuth: async () => { assert.fail('aborted login must not show UI'); } }, { fetchImpl: startedFetch, sleep: noSleep }),
    (e) => e.status === 499,
  );
  assert.equal(startedFetch.calls.length, 0);
  let polls = 0;
  const pollingFetch = mockFetch(async (url) => {
    if (url.endsWith('/oidc/device/authorization/')) return jsonResponse({ device_code: 'dev-stop', user_code: 'STOP-1', verification_uri: 'https://auth.meta.com/v', interval: 1, expires_in: 900 });
    polls += 1;
    return jsonResponse({ access_token: 'identity-stop' });
  });
  const uiError = new Error('job closed by user');
  await assert.rejects(
    museCodeLogin({ onAuth: async () => { throw uiError; } }, { fetchImpl: pollingFetch, sleep: noSleep }),
    (e) => e === uiError,
  );
  assert.equal(polls, 0);
});

test('verification rejects nondefault ports and malformed bodies map to 502', async () => {
  const ported = mockFetch(async () => jsonResponse({ device_code: 'd', user_code: 'U', verification_uri: 'https://auth.meta.com:8443/v', interval: 5, expires_in: 900 }));
  await assert.rejects(startDeviceAuthorization({ fetchImpl: ported, sleep: noSleep }), (e) => e.status === 400);
  const defaultPort = mockFetch(async () => jsonResponse({ device_code: 'd', user_code: 'U', verification_uri: 'https://auth.meta.com/v', interval: 5, expires_in: 900 }));
  const okDefault = await startDeviceAuthorization({ fetchImpl: defaultPort, sleep: noSleep });
  assert.equal(okDefault.verificationUri, 'https://auth.meta.com/v');
  const malformed = mockFetch(async () => ({ ok: true, status: 200, text: async () => 'not-json{{{' }));
  try {
    await startDeviceAuthorization({ fetchImpl: malformed, sleep: noSleep });
    assert.fail('malformed 200 must throw');
  } catch (e) { assert.equal(e.status, 502); }
  const malformedKey = mockFetch(async () => ({ ok: true, status: 200, text: async () => 'oops' }));
  try {
    await requestMuseKey({ identityToken: 'identity-1', fetchImpl: malformedKey });
    assert.fail('malformed key 200 must throw');
  } catch (e) { assert.equal(e.status, 502); }
});

test('bearer and header values reject all whitespace', () => {
  assert.throws(() => encodeMuseCredential('id with space', 'k'));
  assert.throws(() => encodeMuseCredential('id', 'key with space'));
  assert.throws(() => encodeMuseCredential('a\tb', 'k'));
  assert.throws(() => buildInferenceHeaders('minted key'));
  assert.throws(() => buildInferenceHeaders('a\nb'));
  assert.throws(() => parseMuseCredential(JSON.stringify({ oauthAccessToken: 'a b', apiKey: 'k' })));
});


test('sync accessor never throws and strict low level still rejects', () => {
  const encoded = encodeMuseCredential('identity-1', 'minted-only');
  assert.equal(museCodeGetApiKey(encoded), 'minted-only');
  assert.equal(museCodeGetApiKey({ access: encoded }), 'minted-only');
  for (const bad of ['', 'not-json', '{}', null, undefined, 42, { access: 'corrupt' }, { access: JSON.stringify({ oauthAccessToken: 'identity-1' }) }]) {
    assert.equal(museCodeGetApiKey(bad), '');
  }
  assert.throws(() => getInferenceApiKey('corrupt'), (e) => e.message.includes('sign in again'));
  assert.throws(() => parseMuseCredential('corrupt'));
});

test('corrupt muse-code credential cannot break listing or leak into paid keys', async (t) => {
  const agentHome = await mkdtemp(join(tmpdir(), 'prime-muse-corrupt-'));
  t.after(() => rm(agentHome, { recursive: true, force: true }));
  const paidMetaKey = 'paid-meta-key-value';
  const rawIdentity = 'raw-identity-must-stay-hidden';
  await writeFile(
    join(agentHome, 'auth.json'),
    JSON.stringify({
      'muse-code': { type: 'oauth', access: 'corrupt-not-json', refresh: rawIdentity, expires: Date.now() + 3600000 },
      openai: { type: 'api_key', key: 'valid-openai-key' },
      meta: { type: 'api_key', key: paidMetaKey },
    }),
  );
  const { createProviderAuth } = await import('../lib/provider-auth.mjs');
  const store = await createProviderAuth({ agentHome });
  const list = store.list();
  const dumped = JSON.stringify(list);
  assert.doesNotMatch(dumped, /corrupt-not-json/);
  assert.doesNotMatch(dumped, /raw-identity-must-stay-hidden/);
  assert.doesNotMatch(dumped, /paid-meta-key-value/);
  assert.doesNotMatch(dumped, /valid-openai-key/);
  const openai = list.providers.find((p) => p.id === 'openai');
  assert.ok(openai);
  assert.equal(openai.stored, true);
  assert.equal(openai.credentialType, 'api_key');
  const muse = list.providers.find((p) => p.id === 'muse-code');
  if (muse) {
    assert.equal(muse.credentialType, 'oauth');
    assert.equal(muse.stored, true);
  }
  const cli = discoverCli();
  if (!cli?.packageDir) {
    t.skip('Prime Agent engine unavailable');
    return;
  }
  const localImport = (path) => import(pathToFileURL(join(cli.packageDir, path)).href);
  const [authMod, regMod] = await Promise.all([
    localImport('dist/core/auth-storage.js'),
    localImport('dist/core/model-registry.js'),
  ]);
  const { ensureMetaProvider } = await import('../lib/meta-provider.mjs');
  const { ensureMuseCodeProvider, loadMuseCodeConfig } = await import('../lib/muse-code-gate.mjs');
  const auth = authMod.AuthStorage.create(join(agentHome, 'auth.json'), { usePrimeCliConfig: false });
  const registry = regMod.ModelRegistry.create(auth, join(agentHome, 'models.json'));
  ensureMetaProvider(registry, {});
  const loaded = await loadMuseCodeConfig(() => import('../lib/muse-oauth-provider.mjs'));
  assert.ok(loaded);
  ensureMuseCodeProvider(registry, loaded.config, {});
  let museKey;
  try {
    museKey = await auth.getApiKey('muse-code');
  } catch {
    assert.fail('native getApiKey for corrupt muse-code must not throw');
  }
  assert.equal(museKey, '');
  assert.notEqual(museKey, paidMetaKey);
  const metaKey = await auth.getApiKey('meta');
  assert.equal(metaKey, paidMetaKey);
});

