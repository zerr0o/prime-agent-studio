import { formatMessage as tr, messageKey, knownMessage, requestLanguage } from '../public/i18n-core.js';
import { createServer, request } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { imageBodyLimit } from './images.mjs';
import { PWA_PUBLIC_PATHS, PWA_LOGIN_HEAD, validatePwaOrigin } from './pwa.mjs';

export const hashAccessCode = (code, salt) => scryptSync(code, salt, 32).toString('hex');
export function isTailscaleIPv4(address) {
  if (typeof address !== 'string' || isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
}
export function isGatewayPeerAllowed(host, peer) {
  return peer === '127.0.0.1' || (isTailscaleIPv4(host) ? isTailscaleIPv4(peer) : isPrivateIPv4(peer));
}
export function isPrivateIPv4(address) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(address))) return false;
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
const page = (
  error = '',
  accessLabel = tr('server.acces_prive_au_studio'),
  locale = 'fr',
) => `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title data-i18n="login.title">${tr('login.title', {}, locale)}</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:#1b1c1e;color:#ededea;font:16px/1.6 system-ui,sans-serif;display:grid;place-items:center;padding:24px}main{width:100%;max-width:410px}.brand{width:48px;height:48px;display:grid;place-items:center;background:#b7b2e7;color:#292737;border-radius:14px;font-size:30px;font-weight:700;margin-bottom:36px}h1{font-size:34px;line-height:1.2;letter-spacing:-1px;font-weight:600;margin:0 0 16px}p{color:#aaaab2;margin-bottom:30px}label{display:block;font-size:14px;margin:0 0 10px}input{display:block;width:100%;padding:16px;border:1px solid #575363;border-radius:12px;background:#242528;color:#fff;font:24px system-ui;letter-spacing:6px;text-align:center}input:focus{outline:2px solid #b7b2e7;outline-offset:3px}button{width:100%;background:#b7b2e7;color:#262437;border:0;border-radius:12px;padding:16px;font:600 15px system-ui;margin-top:18px;cursor:pointer}small{display:block;color:#a6a4b5;margin-top:22px;text-align:center;font-size:12px}.login-language{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:24px}.login-language label{margin:0}.login-language select{max-width:60%;padding:10px;border:1px solid #575363;border-radius:10px;background:#242528;color:#ededea;font:14px system-ui}.error{color:#f0adad;font-size:14px;margin:12px 0}</style></head><body><main><div class="brand">P</div><h1 data-i18n="login.heading">${tr('login.heading', {}, locale)}</h1><p data-i18n="login.intro">${tr('login.intro', {}, locale)}</p><form method="post" action="/lan/login"><label for="code" data-i18n="login.code">${tr('login.code', {}, locale)}</label><input id="code" name="code" type="password" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{8,12}" required maxlength="12" placeholder="••••••••" autofocus>${error ? `<div class="error" role="alert"${messageKey(error) ? ` data-i18n="${messageKey(error)}"` : ''}>${escapeHtml(knownMessage(error, locale))}</div>` : ''}<button type="submit" data-i18n="login.open">${tr('login.open', {}, locale)}</button></form><small data-i18n="${messageKey(accessLabel)}">${escapeHtml(knownMessage(accessLabel, locale))}</small><div class="login-language"><label for="login-language" data-i18n="language.label">${tr('language.label', {}, locale)}</label><select id="login-language" data-language-select></select></div></main></body></html>`;

/** Authenticated gateway bound to one LAN or Tailscale address; the engine stays loopback-only. */
export function createLanGateway({ host, upstreamPort, config, publicOrigin }) {
  if (!isPrivateIPv4(host) && !isTailscaleIPv4(host) && host !== '127.0.0.1')
    throw new Error(tr('server.l_acces_mobile_doit_utiliser_une_adresse_locale_privee'));
  if (!/^[a-f0-9]{64}$/.test(config?.codeHash) || !/^[a-f0-9]{32}$/.test(config?.salt))
    throw new Error(tr('server.configuration_du_code_d_acces_invalide'));
  if (publicOrigin !== undefined) {
    validatePwaOrigin(publicOrigin);
    if (host !== '127.0.0.1')
      throw new Error(tr('server.la_passerelle_https_doit_ecouter_uniquement_sur_loopback'));
  }
  // Existing consultation configurations retain their permissions until explicitly upgraded.
  let readOnly = config.readOnly !== false;
  let credentials = { salt: config.salt, codeHash: config.codeHash };
  const sessions = new Map(),
    attempts = new Map();
  const connections = new Map();
  const cookieName = 'prime_studio_lan';
  let passkeys, unsubscribePasskeys;
  const sessionKeys = new Map(), passkeyAttempts = new Map(), revokedKeys = new Set();
  const cookie = (req, name) => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
  function dropSession(token) {
    sessions.delete(token); sessionKeys.delete(token);
    for (const connection of connections.get(token) || []) connection.destroy();
    connections.delete(token);
  }
  function issueSession(res, key) {
    if (sessions.size >= 64) dropSession(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
    if (key) sessionKeys.set(token, key);
    res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${publicOrigin ? '; Secure' : ''}`);
    return token;
  }
  const validCode = code => typeof code === 'string' && /^\d{8}$/.test(code) && timingSafeEqual(Buffer.from(hashAccessCode(code, credentials.salt), 'hex'), Buffer.from(credentials.codeHash, 'hex'));
  function respond(res, status, data) {
    res.req.resume();
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
  function login(res, status, error = '') {
    res.req.resume();
    // Keep same-origin form POSTs identifiable; no-referrer makes browsers send Origin:null.
    res.setHeader('Referrer-Policy', 'same-origin');
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      page(
        error,
        publicOrigin
          ? tr('server.acces_prive_tailscale_https')
          : isTailscaleIPv4(host)
            ? tr('server.acces_prive_tailscale')
            : tr('server.acces_prive_reseau_local'),
        requestLanguage(res.req.headers),
      )
        .replace('</head>', PWA_LOGIN_HEAD + '</head>')
        .replace('</main>', publicOrigin && passkeys ? '<button id="passkey-login" type="button" data-i18n="passkeys.login" hidden></button><p id="passkey-login-status" role="status"></p><script type="module" src="/public/passkeys.js"></script></main>' : '</main>')
        .replace(
          '</main>',
          '<button id="pwa-install" class="pwa-install" type="button" data-i18n="ui.installer_le_studio">Installer le Studio</button></main>',
        ),
    );
  }
  const gateway = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const authority = `${host}:${gateway.address()?.port}`;
      const origin = publicOrigin || `http://${authority}`;
      const url = new URL(req.url, origin);
      // Only the loopback listener behind Serve accepts its exact HTTPS host.
      // Never derive the trusted origin from forwarded request headers.
      const validHosts = publicOrigin ? [new URL(publicOrigin).host, authority] : [authority];
      // A service worker's fetch(event.request) preserves navigate but changes document to empty.
      // Cross-site launch metadata can survive a reload. Only the GET landing page is exempt;
      // Host/Origin checks, access cookies, API checks and frame blocking still apply.
      const landingNavigation =
        req.method === 'GET' &&
        (url.pathname === '/' || url.pathname === '/index.html') &&
        req.headers['sec-fetch-mode'] === 'navigate' &&
        ['document', 'empty'].includes(req.headers['sec-fetch-dest']);
      if (
        !validHosts.includes(req.headers.host) ||
        (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers['sec-fetch-site'] === 'cross-site' && !landingNavigation)
      )
        return respond(res, 403, { error: tr('server.origine_non_autorisee') });
      const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
      if (publicOrigin ? peer !== '127.0.0.1' : !isGatewayPeerAllowed(host, peer))
        return respond(res, 403, { error: tr('server.acces_limite_au_reseau_prive_configure') });
      const now = Date.now();
      for (const [token, expiry] of sessions) if (expiry <= now) dropSession(token);
      for (const [address, entry] of attempts) if (entry.until <= now) attempts.delete(address);
      if (url.pathname.startsWith('/lan/passkeys/')) {
        if (!publicOrigin || !passkeys) return respond(res, 404, { error: tr('passkeys.https') });
        const epoch = credentials.codeHash, token = cookie(req, cookieName);
        const authenticated = token && sessions.has(token);
        if (url.pathname === '/lan/passkeys/list' && req.method === 'GET') {
          if (!authenticated) return respond(res, 401, { error: tr('passkeys.failed') });
          return respond(res, 200, { keys: await passkeys.list(epoch, publicOrigin) });
        }
        if (req.method !== 'POST' || req.headers.origin !== publicOrigin || !req.headers['content-type']?.startsWith('application/json'))
          return respond(res, 403, { error: tr('passkeys.failed') });
        for (const [address, entry] of passkeyAttempts) if (entry.until <= now) passkeyAttempts.delete(address);
        const rate = passkeyAttempts.get(peer) || { count: 0, until: now + 60000 };
        if (++rate.count > 30) return respond(res, 429, { error: tr('passkeys.retry') });
        passkeyAttempts.set(peer, rate);
        let bytes = 0; const chunks = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) return respond(res, 413, { error: tr('passkeys.failed') }); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return respond(res, 400, { error: tr('passkeys.failed') }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(res, 400, { error: tr('passkeys.failed') });
        const action = url.pathname.slice('/lan/passkeys/'.length);
        if (!['register-options', 'register-verify', 'login-options', 'login-verify'].includes(action)) return respond(res, 404, { error: tr('passkeys.failed') });
        const kind = action.startsWith('register') ? 'register' : 'login';
        if (kind === 'register' && (!authenticated || readOnly)) return respond(res, 403, { error: tr('passkeys.failed') });
        let binding = kind === 'register' ? token : cookie(req, 'prime_studio_passkey');
        if (action === 'register-options') {
          const entry = attempts.get(peer) || { count: 0, until: now + 600000 };
          if (entry.count >= 5) return respond(res, 429, { error: tr('passkeys.retry') });
          if (!validCode(body.code)) { entry.count++; attempts.set(peer, entry); return respond(res, 401, { error: tr('server.code_incorrect_reessayez') }); }
          attempts.delete(peer);
        }
        if (action === 'login-options') {
          binding = randomBytes(32).toString('hex');
          res.setHeader('Set-Cookie', `prime_studio_passkey=${binding}; HttpOnly; Secure; SameSite=Strict; Path=/lan/passkeys/; Max-Age=120`);
        }
        try {
          if (action.endsWith('-options')) return respond(res, 200, await passkeys.options({ kind, origin: publicOrigin, epoch, binding, name: body.name }));
          const id = await passkeys.verify({ id: body.id, kind, origin: publicOrigin, epoch, binding, response: body.response });
          if (epoch !== credentials.codeHash || (kind === 'register' && (!sessions.has(token) || readOnly))) return respond(res, 401, { error: tr('passkeys.failed') });
          if (kind === 'login') { if (revokedKeys.has(id)) return respond(res, 401, { error: tr('passkeys.failed') }); issueSession(res, id); }
          return respond(res, 200, { verified: true });
        } catch (error) { return respond(res, error.status || 400, { error: error.status ? error.message : tr('passkeys.failed') }); }
      }
      if (req.method === 'POST' && url.pathname === '/lan/login') {
        const entry = attempts.get(peer) || { count: 0, until: now + 10 * 60 * 1000 };
        if (entry.count >= 5) {
          res.setHeader('Retry-After', Math.ceil((entry.until - now) / 1000));
          return login(res, 429, tr('server.trop_de_tentatives_reessayez_dans_quelques_minutes'));
        }
        if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))
          return respond(res, 415, { error: tr('server.formulaire_attendu') });
        let body = '',
          length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 1024) return respond(res, 413, { error: tr('server.formulaire_trop_long') });
          body += chunk;
        }
        const code = (new URLSearchParams(body).get('code') || '').replace(/\s/g, '');
        const match =
          /^\d{8}$/.test(code) &&
          timingSafeEqual(
            Buffer.from(hashAccessCode(code, credentials.salt), 'hex'),
            Buffer.from(credentials.codeHash, 'hex'),
          );
        if (!match) {
          entry.count++;
          if (attempts.size >= 256 && !attempts.has(peer)) attempts.delete(attempts.keys().next().value);
          attempts.set(peer, entry);
          return login(res, 401, tr('server.code_incorrect_reessayez'));
        }
        attempts.delete(peer);
        issueSession(res);
        res.writeHead(303, {
          Location: '/',
        });
        res.end();
        return;
      }
      const token = (req.headers.cookie || '')
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith(cookieName + '='))
        ?.slice(cookieName.length + 1);
      const publicResource =
        (req.method === 'GET' || req.method === 'HEAD') && PWA_PUBLIC_PATHS.has(url.pathname);
      if ((!token || !sessions.has(token)) && !publicResource) {
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html'))
          return login(res, 200);
        return respond(res, 401, { error: tr('server.saisissez_votre_code_d_acces_sur_la_page_d_accueil') });
      }
      if (req.method === 'POST' && url.pathname === '/lan/logout') {
        dropSession(token);
        res.setHeader(
          'Set-Cookie',
          `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${publicOrigin ? '; Secure' : ''}`,
        );
        return respond(res, 200, { loggedOut: true });
      }
      const reading = req.method === 'GET' || req.method === 'HEAD';
      const readReceipt = req.method === 'POST' && url.pathname === '/api/sessions/read';
      if (!reading && readOnly && !readReceipt)
        return respond(res, 405, {
          error: tr('server.cet_acces_permet_uniquement_de_consulter_les_sessions'),
        });
      // Route and method pairs are explicit; local lifecycle/health endpoints stay private.
      const readRoute =
        publicResource ||
        (!readOnly &&
          (url.pathname === '/api/mcp' || /^\/api\/mcp\/login\/[a-f0-9-]{36}$/.test(url.pathname))) ||
        /^\/api\/files\/[a-f0-9-]+$/.test(url.pathname) ||
        url.pathname === '/' ||
        url.pathname === '/index.html' ||
        url.pathname.startsWith('/public/') ||
        [
          '/vendor/marked.js',
          '/vendor/purify.js',
          '/api/bootstrap',
          '/api/overview',
          '/api/push/vapid-key',
          '/api/push/subscriptions',
          '/api/knowledge',
          '/api/knowledge/item',
          '/api/roadmap',
          '/api/roadmap/export',
          '/api/roadmap/session',
          '/api/history',
          '/api/models',
          '/api/version',
          '/api/updates/metadata',
          '/api/runs',
          '/api/commands',
          '/api/inspector',
          '/api/inspector/history',
          // Sanitized read-only Codex quota only. Never provider credentials/config.
          // Both GETs stay allowed in consultation (readOnly) mode.
          '/api/providers/codex-link',
          '/api/providers/codex-usage',
          '/api/project-subagent-defaults',
          '/api/project-files',
          '/api/project-files/changes',
          '/api/project-files/preview',
          '/api/project-files/image',
          '/api/project-files/diff',
          '/api/project-files/download',
          '/api/project-files/resolve',
        ].includes(url.pathname) ||
        /^\/api\/runs\/[a-f0-9-]+\/events$/.test(url.pathname) ||
        url.pathname === '/api/live/capabilities' ||
        /^\/api\/live\/sessions\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
        (!readOnly && url.pathname === '/api/check-cwd');
      const writeRoute =
        (['POST', 'PATCH', 'DELETE'].includes(req.method) && url.pathname === '/api/mcp') ||
        (req.method === 'POST' &&
          ['/api/mcp/test', '/api/mcp/login', '/api/mcp/disconnect', '/api/mcp/login/complete'].includes(
            url.pathname,
          )) ||
        (req.method === 'DELETE' && /^\/api\/mcp\/login\/[a-f0-9-]{36}$/.test(url.pathname)) ||
        (req.method === 'POST' &&
          ([
            '/api/projects',
            '/api/projects/open',
            '/api/projects/move',
            '/api/sessions/move',
            '/api/commands/open-directory',
            '/api/project-files/open',
            '/api/project-subagent-defaults',
            '/api/models/refresh',
            '/api/roadmap',
            '/api/roadmap/work',
            '/api/roadmap/retry-links',
            '/api/runs',
            '/api/updates/request',
          ].includes(url.pathname) ||
            /^\/api\/runs\/[a-f0-9-]+\/(stop|interactions)$/.test(url.pathname))) ||
        (req.method === 'POST' &&
          /^\/api\/live\/sessions\/[A-Za-z0-9_-]+\/(messages|queue)$/.test(url.pathname)) ||
        (req.method === 'PATCH' &&
          ['/api/projects', '/api/sessions', '/api/conversation-settings'].includes(url.pathname)) ||
        (req.method === 'DELETE' && url.pathname === '/api/projects');
      // Push subscriptions manage only the caller's own device registration (ownership
      // token required). Read-only devices may subscribe without gaining answer rights.
      const pushWrite =
        (['POST', 'PATCH', 'DELETE'].includes(req.method) &&
          url.pathname === '/api/push/subscriptions') ||
        (req.method === 'POST' && url.pathname === '/api/push/focus');
      const allowed = reading ? readRoute : readReceipt || pushWrite || (!readOnly && writeRoute);
      if (!allowed) return respond(res, 404, { error: tr('server.route_introuvable') });
      const headers = { accept: req.headers.accept || '*/*' };
      if (req.headers['last-event-id']) headers['last-event-id'] = req.headers['last-event-id'];
      let body;
      if (!reading) {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
          return respond(res, 415, { error: tr('server.un_corps_json_est_requis') });
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > imageBodyLimit(url.pathname))
            return respond(res, 413, { error: tr('server.la_demande_depasse_la_taille_autorisee') });
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
        try {
          const value = JSON.parse(body.toString('utf8'));
          if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
          if (length > 512 * 1024 && !value.images?.length && !value.files?.length)
            return respond(res, 413, { error: tr('server.la_demande_depasse_512_ko') });
        } catch {
          return respond(res, 400, { error: tr('server.la_demande_json_est_invalide') });
        }
        headers['content-type'] = 'application/json';
        headers['content-length'] = body.length;
      }
      // A code change may occur while a request body is still arriving.
      if (!publicResource && (!token || !sessions.has(token)))
        return respond(res, 401, {
          error: tr('server.saisissez_le_nouveau_code_d_acces_sur_la_page_d_accueil'),
        });
      const proxy = request(
        {
          hostname: '127.0.0.1',
          port: upstreamPort,
          path: url.pathname + url.search,
          method: req.method,
          headers,
        },
        (upstream) => {
          upstream.on('error', () => res.destroy());
          if (url.pathname === '/api/bootstrap' && upstream.statusCode === 200 && req.method === 'GET') {
            const chunks = [];
            let size = 0;
            upstream.on('data', (chunk) => {
              size += chunk.length;
              if (size > 8 * 1024 * 1024) {
                proxy.destroy();
                return;
              }
              chunks.push(chunk);
            });
            upstream.on('end', () => {
              if (res.destroyed) return;
              try {
                const data = JSON.parse(Buffer.concat(chunks));
                data.preferences = { ...data.preferences, remote: true, readOnly, directoryPicker: false };
                respond(res, 200, data);
              } catch {
                respond(res, 502, { error: tr('server.impossible_de_lire_le_studio_local') });
              }
            });
          } else {
            const forward = { ...upstream.headers };
            delete forward['set-cookie'];
            delete forward.connection;
            delete forward['transfer-encoding'];
            forward['referrer-policy'] = 'same-origin';
            res.writeHead(upstream.statusCode || 502, forward);
            upstream.pipe(res);
          }
        },
      );
      proxy.on('error', () => {
        if (!res.headersSent)
          respond(res, 502, { error: tr('server.le_studio_local_ne_repond_pas_reessayez_dans_un_instant') });
        else res.destroy();
      });
      proxy.setTimeout(35000, () => proxy.destroy());
      if (token && sessions.has(token)) {
        if (!connections.has(token)) connections.set(token, new Set());
        connections.get(token).add(proxy);
        proxy.once('close', () => {
          const current = connections.get(token);
          current?.delete(proxy);
          if (!current?.size) connections.delete(token);
        });
      }
      res.on('close', () => proxy.destroy());
      proxy.end(body);
    } catch {
      if (!res.headersSent) respond(res, 500, { error: tr('server.une_erreur_est_survenue') });
      else res.end();
    }
  });
  gateway.headersTimeout = 15000;
  gateway.requestTimeout = 20000;
  gateway.disconnectClients = () => {
    sessions.clear();
    sessionKeys.clear();
    attempts.clear();
    for (const requests of connections.values()) for (const connection of requests) connection.destroy();
    connections.clear();
  };
  gateway.setPasskeys = service => {
    if (passkeys === service) return;
    unsubscribePasskeys?.(); passkeys = service;
    unsubscribePasskeys = service.onRevoked(id => { revokedKeys.add(id); for (const [token, key] of sessionKeys) if (key === id) dropSession(token); });
  };
  gateway.once('close', () => unsubscribePasskeys?.());
  gateway.setReadOnly = (value) => {
    if (readOnly === value) return;
    readOnly = value;
    gateway.disconnectClients();
  };
  gateway.setAccessCode = ({ salt, codeHash }) => {
    if (!/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{64}$/.test(codeHash))
      throw new Error(tr('server.configuration_du_code_d_acces_invalide'));
    if (credentials.salt === salt && credentials.codeHash === codeHash) return;
    credentials = { salt, codeHash };
    gateway.disconnectClients();
  };
  return gateway;
}
