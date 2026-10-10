import { networkInterfaces } from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import { createLanGateway, hashAccessCode, isPrivateIPv4, isTailscaleIPv4 } from './lan.mjs';
import { HttpError } from './store.mjs';
import { createTailscaleHttps } from './tailscale-https.mjs';
import { formatMessage as tr } from '../public/i18n-core.js';

export function networkAddresses(interfaces = networkInterfaces()) {
  const result = { lan: [], tailscale: [] };
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const item of addresses || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const kind =
        /tailscale/i.test(name) && isTailscaleIPv4(item.address)
          ? 'tailscale'
          : !/(vEthernet|WSL|Virtual|Docker|tailscale)/i.test(name) && isPrivateIPv4(item.address)
            ? 'lan'
            : null;
      if (kind && !result[kind].some((entry) => entry.address === item.address))
        result[kind].push({ name, address: item.address });
    }
  }
  return result;
}

export function createRemoteNetwork({
  access,
  upstreamPort,
  publicApiAccess,
  interfaces = networkInterfaces,
  makeGateway = createLanGateway,
  httpsService = createTailscaleHttps(),
}) {
  let active = new Map(),
    closed = false,
    starting;
  const errors = new Map();
  const endpoint = (config, kind) => {
    if (kind === 'lan')
      return { enabled: config?.enabled === true, host: config?.host, port: config?.port || 3089 };
    if (kind === 'tailscale')
      return {
        enabled: config?.tailscale?.enabled === true,
        host: config?.tailscale?.host,
        port: config?.port || 3089,
      };
    return {
      enabled: config?.tailscale?.https?.enabled === true,
      host: '127.0.0.1',
      port: config?.tailscale?.https?.port,
      publicOrigin: config?.tailscale?.https?.origin,
    };
  };
  const same = (a, b) => a?.host === b?.host && a?.port === b?.port && a?.publicOrigin === b?.publicOrigin;
  function stop(entry) {
    entry.gateway.disconnectClients?.();
    entry.gateway.closeAllConnections();
    entry.gateway.close();
  }
  function ensureOpen() {
    if (closed) throw new HttpError(503, tr('network.closed'));
  }
  function validPort(value, config) {
    if (
      !Number.isInteger(value) ||
      value < 1024 ||
      value > 65535 ||
      value === upstreamPort() ||
      value === config?.tailscale?.https?.port
    )
      throw new HttpError(400, tr('network.invalid_port'));
  }
  async function launch(config, kind, target) {
    ensureOpen();
    if (
      !Number.isInteger(target.port) ||
      target.port < 1024 ||
      target.port > 65535 ||
      target.port === upstreamPort()
    )
      throw new HttpError(400, tr('network.invalid_port'));
    if (
      (kind === 'lan' && !isPrivateIPv4(target.host)) ||
      (kind === 'tailscale' && !isTailscaleIPv4(target.host))
    )
      throw new HttpError(400, tr('network.invalid_address'));
    const gateway = makeGateway({ ...target, upstreamPort: upstreamPort(), config, publicApiAccess });
    await new Promise((resolve, reject) => {
      gateway.once('error', reject);
      gateway.listen(target.port, target.host, () => {
        gateway.removeListener('error', reject);
        resolve();
      });
    }).catch((error) => {
      gateway.close();
      throw new HttpError(409, tr(error.code === 'EADDRINUSE' ? 'network.port_busy' : 'network.bind_failed'));
    });
    const entry = { ...target, gateway };
    gateway.on('error', () => errors.set(kind, tr('network.bind_failed')));
    if (closed) {
      stop(entry);
      ensureOpen();
    }
    return entry;
  }
  async function prepare(config, oldConfig, changedChannel) {
    ensureOpen();
    const next = new Map(),
      created = [];
    try {
      for (const kind of ['lan', 'tailscale', 'https']) {
        const target = endpoint(config, kind);
        if (!target.enabled) continue;
        const previous = active.get(kind);
        if (previous?.gateway.listening && same(previous, target)) next.set(kind, previous);
        else if (kind === changedChannel || previous || !same(endpoint(oldConfig, kind), target)) {
          const entry = await launch(config, kind, target);
          created.push(entry);
          next.set(kind, entry);
        }
      }
    } catch (error) {
      created.forEach(stop);
      throw error;
    }
    return {
      rollback: async () => created.forEach(stop),
      commit() {
        if (closed) {
          created.forEach(stop);
          return;
        }
        for (const [kind, entry] of active) if (next.get(kind) !== entry) stop(entry);
        active = next;
        for (const kind of ['lan', 'tailscale', 'https'])
          if (next.has(kind) || !endpoint(config, kind).enabled) errors.delete(kind);
        for (const entry of active.values()) {
          access.trackGateway(entry.gateway, config);
          entry.gateway.setReadOnly(config.readOnly !== false);
        }
      },
    };
  }
  async function start() {
    if (starting) return starting;
    starting = (async () => {
      const data = await access.readConfig();
      if (!data || closed) return;
      for (const kind of ['lan', 'tailscale', 'https']) {
        const target = endpoint(data.config, kind);
        if (!target.enabled || active.has(kind)) continue;
        try {
          const entry = await launch(data.config, kind, target);
          if (closed) {
            stop(entry);
            return;
          }
          active.set(kind, entry);
          await access.registerGateway(entry.gateway);
        } catch (error) {
          errors.set(kind, error.message);
        }
      }
    })();
    try {
      await starting;
    } finally {
      starting = undefined;
    }
  }
  async function get() {
    const state = await access.get(),
      data = await access.readConfig(),
      addresses = networkAddresses(interfaces());
    const httpsStatus = data?.config.tailscale?.https?.enabled
      ? await httpsService.verify(data.config.tailscale.https.origin, data.config.tailscale.https.port)
      : {};
    const channels = ['lan', 'tailscale', 'https'].map((kind) => {
      const target = endpoint(data?.config, kind),
        listener = active.get(kind);
      const listening = !!listener?.gateway.listening && same(listener, target);
      const serviceError = kind === 'https' ? httpsStatus.error : '';
      const available = kind === 'https' ? [] : addresses[kind];
      const addressMissing =
        target.enabled && kind !== 'https' && !available.some((item) => item.address === target.host);
      return {
        kind,
        enabled: target.enabled,
        host: target.host || '',
        port: target.port,
        status: !target.enabled
          ? 'disabled'
          : addressMissing || errors.has(kind) || !listening || serviceError
            ? 'error'
            : 'active',
        error:
          serviceError ||
          errors.get(kind) ||
          (addressMissing
            ? tr('network.address_lost')
            : target.enabled && !listening
              ? tr('network.not_listening')
              : ''),
        url:
          listening && !addressMissing && !errors.has(kind) && !serviceError
            ? target.publicOrigin || `http://${target.host}:${target.port}`
            : null,
        addresses: available,
      };
    });
    return { ...state, readOnly: data?.config.readOnly !== false, channels };
  }
  async function configure(body) {
    ensureOpen();
    if (
      !body ||
      Object.keys(body).some(
        (key) => !['channel', 'enabled', 'host', 'port', 'revision', 'readOnly'].includes(key),
      ) ||
      !['lan', 'tailscale', 'https', 'permissions'].includes(body.channel) ||
      (body.revision !== null && !/^[a-f0-9]{64}$/.test(body.revision || ''))
    )
      throw new HttpError(400, tr('network.invalid_config'));
    if (
      body.channel === 'permissions' ? typeof body.readOnly !== 'boolean' : typeof body.enabled !== 'boolean'
    )
      throw new HttpError(400, tr('network.invalid_config'));
    await starting;
    let generatedCode, httpsChange;
    await access.updateConfig({
      revision: body.revision,
      async build(previous) {
        ensureOpen();
        if (!previous && (body.channel === 'permissions' || !body.enabled))
          throw new HttpError(400, tr('network.enable_first'));
        let config = previous;
        if (!config) {
          generatedCode = String(randomInt(10000000, 100000000));
          const salt = randomBytes(16).toString('hex');
          config = {
            enabled: false,
            port: 3089,
            readOnly: false,
            salt,
            codeHash: hashAccessCode(generatedCode, salt),
          };
        }
        if (body.channel === 'permissions') {
          config.readOnly = body.readOnly;
          return config;
        }
        if (body.channel === 'https') {
          const old = config.tailscale?.https;
          if (body.enabled) {
            const port = body.port ?? old?.port ?? 3090;
            if (
              !Number.isInteger(port) ||
              port < 1024 ||
              port > 65535 ||
              port === upstreamPort() ||
              port === config.port
            )
              throw new HttpError(400, tr('network.invalid_port'));
            httpsChange = await httpsService.prepare(port, old);
            config.tailscale = {
              ...config.tailscale,
              https: { ...old, enabled: true, origin: httpsChange.origin, port },
            };
          } else {
            config.tailscale = { ...config.tailscale, https: { ...old, enabled: false } };
          }
          return config;
        }
        if (body.enabled) {
          const candidates = networkAddresses(interfaces())[body.channel];
          if (!candidates.some((item) => item.address === body.host))
            throw new HttpError(400, tr('network.invalid_address'));
          validPort(body.port ?? config.port, config);
          config.port = body.port ?? config.port;
        }
        if (body.channel === 'lan') {
          config.enabled = body.enabled;
          if (body.enabled) config.host = body.host;
        } else
          config.tailscale = {
            ...config.tailscale,
            enabled: body.enabled,
            ...(body.enabled ? { host: body.host } : {}),
          };
        return config;
      },
      prepare: async (config, previous) => {
        const listeners = await prepare(config, previous, body.channel);
        if (!httpsChange) return listeners;
        try {
          await httpsChange.activate();
        } catch (error) {
          await listeners.rollback();
          throw error;
        }
        return {
          commit: listeners.commit,
          rollback: async () => {
            await listeners.rollback();
            try {
              await httpsChange.rollback();
            } catch {
              throw new HttpError(500, tr('https.rollback_failed'));
            }
          },
        };
      },
    });
    return { ...(await get()), ...(generatedCode ? { generatedCode } : {}) };
  }
  async function qr(kind) {
    const channel = (await get()).channels.find((entry) => entry.kind === kind);
    if (!channel?.url || channel.status !== 'active') throw new HttpError(409, tr('network.qr_unavailable'));
    return {
      url: channel.url,
      image: await QRCode.toDataURL(channel.url, { width: 256, margin: 4, errorCorrectionLevel: 'M' }),
    };
  }
  function close() {
    closed = true;
    for (const entry of active.values()) stop(entry);
    active.clear();
  }
  return { start, get, configure, qr, close };
}
