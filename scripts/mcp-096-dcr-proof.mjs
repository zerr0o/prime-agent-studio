// Native 0.9.6 DCR confidential OAuth proof: exchange AND refresh send the
// client secret through the REAL isolated engine modules. Local HTTPS fake
// server only (cert/key passed in); prints one JSON summary line on stdout.
// Usage: node scripts/mcp-096-dcr-proof.mjs <pkgDir> <certPem> <keyPem>
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [pkgDir, certPem, keyPem] = process.argv.slice(2);
if (!pkgDir || !certPem || !keyPem) {
  console.log(JSON.stringify({ ok: false, error: 'usage: <pkgDir> <certPem> <keyPem>' }));
  process.exitCode = 2;
  process.exit(2);
}
const timer = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, error: 'proof timed out' }));
  process.exit(1);
}, 45000);
timer.unref();

const seen = [];
let requests = 0;
let registration;
const challenges = new Map();
const server = createServer({ key: readFileSync(keyPem), cert: readFileSync(certPem) }, async (req, res) => {
  requests++;
  let raw = '';
  for await (const c of req) raw += c;
  const url = new URL(req.url, 'https://localhost');
  const json = (st, d) => {
    res.writeHead(st, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(d));
  };
  const origin = `https://localhost:${server.address().port}`;
  if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
    return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
  if (url.pathname === '/.well-known/oauth-authorization-server')
    return json(200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    });
  if (url.pathname === '/register') {
    let requested = {};
    try {
      requested = JSON.parse(raw);
    } catch {}
    registration = {
      client_id: 'dcr-proof-id',
      client_secret: 'dcr-proof-secret',
      redirect_uris: requested.redirect_uris || ['http://localhost:53700/callback'],
      token_endpoint_auth_method: 'client_secret_basic',
    };
    return json(201, registration);
  }
  if (url.pathname === '/authorize') {
    const code = `code-${Math.random().toString(36).slice(2)}`;
    challenges.set(code, {
      challenge: url.searchParams.get('code_challenge'),
      redirect: url.searchParams.get('redirect_uri'),
      resource: url.searchParams.get('resource'),
    });
    res.writeHead(302, {
      Location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}`,
    });
    return res.end();
  }
  if (url.pathname === '/token') {
    const form = new URLSearchParams(raw);
    const header = req.headers.authorization || '';
    let user;
    let secret;
    if (header.startsWith('Basic ')) {
      const [u, s] = Buffer.from(header.slice(6), 'base64').toString().split(':');
      user = u;
      secret = s;
    } else {
      user = form.get('client_id');
      secret = form.get('client_secret');
    }
    const authed = user === registration?.client_id && secret === registration?.client_secret;
    seen.push({ grant: form.get('grant_type'), authed });
    if (!authed) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_client' }));
    }
    if (form.get('grant_type') === 'authorization_code') {
      const record = challenges.get(form.get('code'));
      if (!record) return json(400, { error: 'invalid_grant' });
      return json(200, {
        access_token: 'proof-access-1',
        refresh_token: 'proof-refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (form.get('refresh_token') !== 'proof-refresh-1') return json(400, { error: 'invalid_grant' });
      return json(200, {
        access_token: 'proof-access-2',
        refresh_token: 'proof-refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }
  res.writeHead(404);
  res.end();
});
await new Promise((done) => server.listen(0, 'localhost', done));
const origin = `https://localhost:${server.address().port}`;
const summary = { originBound: true };
try {
  const sc = await import(pathToFileURL(join(pkgDir, 'dist', 'core', 'mcp', 'service-catalog.js')).href);
  const endpoint = `${origin}/mcp`;
  // Byte-identical identity at login and refresh time.
  const idLogin = sc.resolveMcpOAuthIdentity({ type: 'http', url: endpoint, oauth: true });
  const idRefresh = sc.resolveMcpOAuthIdentity({ type: 'http', url: endpoint, oauth: true });
  summary.identityStable = JSON.stringify(idLogin) === JSON.stringify(idRefresh);
  summary.publicIdentity = Object.keys(idLogin).length === 0;
  const provider = sc.createConfiguredMcpProvider({ server: 'dcrproof', url: endpoint, identity: idLogin });
  let manualResolve;
  const manual = new Promise((resolve) => {
    manualResolve = resolve;
  });
  const loginPromise = provider.login({
    onAuth: async ({ url }) => {
      const response = await fetch(url, { redirect: 'manual' });
      manualResolve(response.headers.get('location'));
    },
    onProgress: () => {},
    onManualCodeInput: () => manual,
  });
  const creds = await loginPromise;
  summary.exchangeSecret = seen.some((s) => s.grant === 'authorization_code' && s.authed);
  summary.loginAccess = creds.access === 'proof-access-1';
  summary.dcrSecretPersisted = creds.clientSecret === 'dcr-proof-secret';
  const refreshed = await provider.refreshToken(creds);
  summary.refreshSecret = seen.some((s) => s.grant === 'refresh_token' && s.authed);
  summary.refreshAccess = refreshed.access === 'proof-access-2';
  // Studio-shaped stored grant (saveCredential stores {...credentials, type})
  // must satisfy the 0.9.6 manager's shared usability rule at this endpoint.
  summary.grantUsable =
    sc.oauthGrantUsable({ ...creds, type: 'oauth' }, endpoint).usable === true &&
    sc.oauthGrantUsable({ ...refreshed, type: 'oauth' }, endpoint).usable === true;
  // Missing configured secret fails before any network request.
  const mark = requests;
  delete process.env.MCP096_PROOF_MISSING;
  const badProvider = sc.createConfiguredMcpProvider({
    server: 'dcrproof',
    url: endpoint,
    identity: sc.resolveMcpOAuthIdentity({
      type: 'http',
      url: endpoint,
      oauthClientSecretEnvVar: 'MCP096_PROOF_MISSING',
    }),
  });
  summary.missingSecretValue =
    sc.resolveMcpOAuthIdentity({
      type: 'http',
      url: endpoint,
      oauthClientSecretEnvVar: 'MCP096_PROOF_MISSING',
    }).clientSecret === '';
  let failed = false;
  try {
    await badProvider.login({ onAuth: () => {}, onPrompt: async () => 'x' });
  } catch {
    failed = true;
  }
  summary.preNetworkFail = failed && requests === mark;
  summary.ok =
    summary.identityStable &&
    summary.publicIdentity &&
    summary.exchangeSecret &&
    summary.loginAccess &&
    summary.refreshSecret &&
    summary.refreshAccess &&
    summary.dcrSecretPersisted &&
    summary.grantUsable &&
    summary.preNetworkFail;
} catch (error) {
  summary.ok = false;
  summary.error = String(error?.message || error).slice(0, 300);
} finally {
  server.closeAllConnections();
  server.close();
  clearTimeout(timer);
}
console.log(JSON.stringify(summary));
process.exitCode = summary.ok ? 0 : 1;
