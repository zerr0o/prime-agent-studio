import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';

const PROTOCOL = { name: 'prime-agent.daemon', version: 7 };
const SCHEMA_ID = 'protocol-7-schema-30-8e4b17c2a9f5';
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 128;
const DEFAULT_TIMEOUT_MS = 30_000;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const samePath = (left, right) =>
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);

/** A bounded, non-retrying client for the Rust supervisor's public JSONL socket. */
export class RustDaemonClient {
  constructor(socketPath, { expectedIdentity = {} } = {}) {
    if (typeof socketPath !== 'string' || !socketPath || socketPath.includes('\0'))
      throw new TypeError('A daemon socket path is required');
    if (!record(expectedIdentity)) throw new TypeError('Expected identity must be an object');
    this.socketPath = socketPath;
    this.expectedIdentity = expectedIdentity;
    this.protocolClientId = `studio:${randomUUID()}`;
    this.requestId = 0;
    this.socket = undefined;
    this.hello = undefined;
    this.pending = new Map();
    this.helloWaiters = new Set();
    this.messageListeners = new Set();
    this.closeListeners = new Set();
    this.buffer = Buffer.alloc(0);
    this.connectPromise = undefined;
  }

  get isConnected() {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  supportsServerCapability(capability) {
    return this.hello?.serverCapabilities?.includes(capability) === true;
  }

  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async connect(timeoutMs = 3000) {
    if (this.socket) throw new Error('Daemon client is already connected');
    this.#timeout(timeoutMs);
    this.hello = undefined;
    this.buffer = Buffer.alloc(0);
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.on('data', (chunk) => this.#receive(socket, chunk));
    socket.on('error', (error) => this.#disconnect(socket, error));
    socket.on('close', () => this.#disconnect(socket, new Error('Daemon socket closed')));
    this.connectPromise = new Promise((resolveConnect, rejectConnect) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectConnect(error);
      };
      const timer = setTimeout(() => {
        const error = new Error(`Timed out connecting to daemon after ${timeoutMs}ms`);
        fail(error);
        this.#disconnect(socket, error);
      }, timeoutMs);
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveConnect();
      });
      socket.once('error', fail);
      socket.once('close', () => fail(new Error('Daemon socket closed before connect')));
    });
    return this.connectPromise;
  }

  async waitForHello(timeoutMs = 3000) {
    this.#timeout(timeoutMs);
    if (this.hello) return this.hello;
    if (!this.isConnected) throw new Error('Daemon is not connected');
    return new Promise((resolveHello, rejectHello) => {
      const waiter = { resolve: resolveHello, reject: rejectHello };
      waiter.timer = setTimeout(() => {
        this.helloWaiters.delete(waiter);
        rejectHello(new Error(`Timed out waiting for daemon hello after ${timeoutMs}ms`));
      }, timeoutMs);
      this.helloWaiters.add(waiter);
    });
  }

  async request(command, timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
    this.#timeout(timeoutMs);
    if (!record(command) || typeof command.type !== 'string' || !command.type)
      throw new TypeError('Daemon command must have a type');
    if (!this.isConnected) throw new Error('Daemon is not connected');
    await this.waitForHello(Math.min(timeoutMs, 3000));
    if (!this.isConnected) throw new Error('Daemon socket closed before command delivery');
    if (this.pending.size >= MAX_PENDING) throw new Error('Too many pending daemon commands');
    if (
      !Number.isSafeInteger(this.requestId) ||
      this.requestId < 0 ||
      this.requestId === Number.MAX_SAFE_INTEGER
    )
      throw new Error('Invalid daemon request counter');
    if (typeof this.protocolClientId !== 'string' || !this.protocolClientId)
      throw new Error('Invalid daemon client identity');
    const id = `daemon_${++this.requestId}`;
    const envelope = {
      type: 'command',
      id,
      protocol: PROTOCOL,
      clientId: this.protocolClientId,
      command: { ...command, id },
    };
    const wire = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(wire) > MAX_LINE_BYTES) throw new Error('Daemon command exceeds frame limit');
    return new Promise((resolveResponse, rejectResponse) => {
      const pending = { resolve: resolveResponse, reject: rejectResponse, options, type: command.type };
      pending.timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(
          new Error(
            `Timed out waiting for daemon ${command.type} response after ${timeoutMs}ms; delivery is uncertain`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, pending);
      const socket = this.socket;
      socket.write(wire, (error) => {
        if (error) this.#disconnect(socket, error);
      });
    });
  }

  close() {
    if (this.socket) this.#disconnect(this.socket, new Error('Daemon client closed'));
  }

  #timeout(value) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError('Timeout must be a positive integer');
  }

  #validateHello(message) {
    if (
      !record(message.protocol) ||
      message.protocol.name !== PROTOCOL.name ||
      message.protocol.version !== PROTOCOL.version ||
      message.schemaId !== SCHEMA_ID ||
      message.schemaRevision !== 30 ||
      typeof message.appVersion !== 'string' ||
      !/^0\.10\./.test(message.appVersion) ||
      typeof message.socketPath !== 'string' ||
      !samePath(message.socketPath, this.socketPath) ||
      !Number.isSafeInteger(message.supervisorPid) ||
      message.supervisorPid <= 0 ||
      typeof message.clientId !== 'string' ||
      !message.clientId ||
      !Array.isArray(message.serverCapabilities) ||
      message.serverCapabilities.some((item) => typeof item !== 'string') ||
      !record(message.runtime) ||
      typeof message.runtime.buildId !== 'string' ||
      !message.runtime.buildId.startsWith('pa-daemon-rs-0.10.')
    )
      throw new Error('Invalid or incompatible Rust daemon hello');
    const expected = this.expectedIdentity;
    if (
      (expected.supervisorPid !== undefined && message.supervisorPid !== expected.supervisorPid) ||
      (expected.supervisorProcessStartId !== undefined &&
        message.supervisorProcessStartId !== expected.supervisorProcessStartId) ||
      (expected.supervisorGeneration !== undefined &&
        message.supervisorGeneration !== expected.supervisorGeneration) ||
      (expected.schemaId !== undefined && message.schemaId !== expected.schemaId)
    )
      throw new Error('Rust daemon identity mismatch');
  }

  #receive(socket, chunk) {
    if (this.socket !== socket) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes(10)) {
      this.#disconnect(socket, new Error('Daemon frame exceeds limit'));
      return;
    }
    for (;;) {
      const end = this.buffer.indexOf(10);
      if (end < 0) break;
      if (end > MAX_LINE_BYTES) {
        this.#disconnect(socket, new Error('Daemon frame exceeds limit'));
        return;
      }
      const line = this.buffer.subarray(0, end).toString('utf8');
      this.buffer = this.buffer.subarray(end + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#disconnect(socket, new Error('Invalid daemon JSON frame'));
        return;
      }
      if (!record(message)) {
        this.#disconnect(socket, new Error('Invalid daemon message'));
        return;
      }
      if (message.type === 'daemon_hello') {
        try {
          if (this.hello) throw new Error('Duplicate daemon hello');
          this.#validateHello(message);
        } catch (error) {
          this.#disconnect(socket, error);
          return;
        }
        this.hello = message;
        for (const waiter of this.helloWaiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
        this.helloWaiters.clear();
      } else if (!this.hello) {
        this.#disconnect(socket, new Error('Daemon sent a frame before hello'));
        return;
      }
      if (message.type === 'response' && typeof message.id === 'string') {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          try {
            if (message.command !== pending.type || typeof message.success !== 'boolean')
              throw new Error('Malformed daemon response');
            pending.options.onResponse?.(message);
            pending.resolve(message);
          } catch (error) {
            pending.reject(error);
          }
          continue;
        }
      }
      if (
        typeof message.id === 'string' &&
        (message.type === 'session_list_progress' || message.type === 'session_list_item')
      ) {
        const pending = this.pending.get(message.id);
        if (pending) {
          try {
            pending.options.onProgress?.(message);
          } catch {
            /* Consumer errors are isolated. */
          }
          continue;
        }
      }
      for (const listener of this.messageListeners) {
        try {
          listener(message);
        } catch {
          /* Consumer errors are isolated. */
        }
      }
    }
    if (this.buffer.length > MAX_LINE_BYTES)
      this.#disconnect(socket, new Error('Daemon frame exceeds limit'));
  }

  #disconnect(socket, error) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.hello = undefined;
    this.buffer = Buffer.alloc(0);
    socket.destroy();
    for (const waiter of this.helloWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.helloWaiters.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) {
      try {
        listener(error);
      } catch {
        /* Consumer errors are isolated. */
      }
    }
  }
}
