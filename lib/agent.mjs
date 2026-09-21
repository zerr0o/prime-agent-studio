import { formatMessage as tr } from '../public/i18n-core.js';
import { nativeAgentMessage } from '../public/agent-messages.js';
import { spawn, execFile } from 'node:child_process';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, delimiter, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { ensureLocalKernel } from './kernel.mjs';
import { createOwnedDaemon } from './daemon.mjs';
import { validateImages, persistImages, imageAttachments, imageMessageText } from './images.mjs';
import { splitFileMessage } from './files.mjs';
import { createNativeModelCatalog } from './native-model-catalog.mjs';
import { createModelAvailability } from './model-availability.mjs';
import { stripJsonComments } from './model-config.mjs';
import { createNativeInteractions } from './native-interactions.mjs';
import { META_PROVIDER_ID, META_MODELS, META_CREDENTIAL_ENV } from './meta-provider.mjs';
import { isBlockedMuseCodeBackup } from './muse-code-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const MAX_LINE = 16 * 1024 * 1024;
const MODEL_ENV = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  xai: ['XAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  [META_PROVIDER_ID]: [META_CREDENTIAL_ENV],
};

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const cleanString = (value, limit = 300) => (typeof value === 'string' ? value.slice(0, limit) : '');
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((c) => c?.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
      : '';

function diagnostic(value) {
  return String(value || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(sk-[a-zA-Z0-9_-]{12,}|Bearer\s+[a-zA-Z0-9._-]{12,})/g, '[secret masqué]')
    .slice(-8000)
    .trim();
}

async function readJson(path, jsonc = false) {
  try {
    const info = await stat(path);
    if (info.size > 8 * 1024 * 1024) return {};
    const source = await readFile(path, 'utf8');
    const value = JSON.parse(jsonc ? stripJsonComments(source) : source);
    return record(value) ? value : {};
  } catch {
    return {};
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve npm's actual JavaScript entrypoint, avoiding Windows .cmd shims. */
export function discoverCli(explicit = process.env.PRIME_AGENT_CLI, env = process.env, { all = false } = {}) {
  // Prime Agent 0.9.5 public dist/bundle/cli.js is an npm-native bridge: it always
  // re-spawns (native launcher or sibling cli-node.js with execArgv), so its PID
  // never equals the supervisor and Studio loaders are consumed before the real CLI.
  // Preserve the public path for receipts/packaging, but expose a safe direct Node
  // entrypoint for Studio launches needing hooks/PID. Old layouts fall back to path.
  function launchPathFor(path, packageDir) {
    try {
      const normalized = path.replaceAll('\\', '/');
      if (normalized.endsWith('dist/bundle/cli-node.js')) return path;
      if (normalized.endsWith('dist/bundle/cli.js')) {
        const sibling = packageDir
          ? join(packageDir, 'dist', 'bundle', 'cli-node.js')
          : join(dirname(path), 'cli-node.js');
        if (isFile(sibling)) return sibling;
      }
    } catch {
      /* Fall through to the public path. */
    }
    return path;
  }
  function inspect(candidate) {
    if (!candidate) return null;
    let path = resolve(candidate);
    try {
      if (statSync(path).isDirectory()) {
        const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
        path = resolve(
          path,
          typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['prime-agent'] || 'dist/bundle/cli.js',
        );
      }
    } catch {
      return null;
    }
    if (/\.(cmd|bat|ps1)$/i.test(path)) {
      const base = dirname(path);
      for (const packageDir of [join(base, 'node_modules', 'prime-agent'), join(base, '..', 'prime-agent')]) {
        const found = inspect(packageDir);
        if (found) return found;
      }
      return null;
    }
    if (!isFile(path)) return null;
    let packageDir = dirname(path);
    for (let depth = 0; depth < 5; depth++, packageDir = dirname(packageDir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
        if (pkg.name === 'prime-agent')
          return {
            path,
            launchPath: launchPathFor(path, packageDir),
            node: !/\.exe$/i.test(path),
            packageDir,
            version: cleanString(pkg.version),
          };
      } catch {
        /* Walk upward to the npm package root. */
      }
    }
    return {
      path,
      launchPath: launchPathFor(path, null),
      node: !/\.exe$/i.test(path),
      packageDir: null,
      version: null,
    };
  }
  if (explicit) return inspect(explicit);
  const candidates = [
    join(ROOT, 'node_modules', 'prime-agent'),
    join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', 'prime-agent'),
    join(homedir(), '.local', 'share', 'prime-agent', 'node_modules', 'prime-agent'),
    join(dirname(process.execPath), 'node_modules', 'prime-agent'),
    '/usr/local/lib/node_modules/prime-agent',
    '/usr/lib/node_modules/prime-agent',
  ];
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    candidates.push(
      join(dir, 'node_modules', 'prime-agent'),
      join(dir, 'prime-agent'),
      join(dir, 'prime-agent.exe'),
    );
  }
  const foundCandidates = [];
  for (const candidate of candidates) {
    const found = inspect(candidate);
    if (found) {
      if (!all) return found;
      if (!foundCandidates.some((entry) => entry.path === found.path)) foundCandidates.push(found);
    }
  }
  return all ? foundCandidates : null;
}

export function agentEnvironment({ agentHome, sessionDir, env = process.env } = {}) {
  const result = { ...env, PRIME_GUI_SILENT: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  // Requests launched by the Studio are independent native clients, even when
  // the Studio itself was started from another agent's terminal.
  for (const name of Object.keys(result))
    if (
      name.startsWith('PRIME_AGENT_INTERNAL_') ||
      [
        'PRIME_GUI_CONTROL',
        'PRIME_GUI_CLI_ROOT',
        'PRIME_STUDIO_SUBAGENT_POLICY',
        'PRIME_STUDIO_POLICY_CLI_ROOT',
        'PRIME_STUDIO_KERNEL_ROOT',
        'PRIME_STUDIO_KERNEL_PACKAGE',
        'PRIME_STUDIO_TRANSPORT_PACKAGE',
        'PRIME_STUDIO_RELAY_PACKAGE',
        'PRIME_STUDIO_SESSION_PACKAGE',
        'PRIME_STUDIO_KNOWLEDGE_CONFIG',
      ].includes(name)
    )
      delete result[name];
  if (agentHome) result.PRIME_AGENT_CODING_AGENT_DIR = agentHome;
  if (sessionDir) result.PRIME_AGENT_SESSION_DIR = sessionDir;
  const preload = join(ROOT, 'runtime', 'windows-hidden.cjs');
  // Forward slashes also avoid ambiguity in NODE_OPTIONS quoted Windows paths.
  const requireOption = `--require="${preload.replaceAll('\\', '/')}"`;
  if (!(result.NODE_OPTIONS || '').includes(preload.replaceAll('\\', '/'))) {
    result.NODE_OPTIONS = [result.NODE_OPTIONS, requireOption].filter(Boolean).join(' ');
  }
  const pythonPath = join(ROOT, 'runtime', 'python');
  result.PYTHONPATH = [
    pythonPath,
    ...(result.PYTHONPATH || '').split(delimiter).filter((p) => p && p !== pythonPath),
  ].join(delimiter);
  return result;
}

function usageOf(value) {
  if (!record(value)) return undefined;
  const usage = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
    if (finite(value[key]) !== undefined) usage[key] = value[key];
  }
  if (record(value.cost)) {
    usage.cost = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
      if (finite(value.cost[key]) !== undefined) usage.cost[key] = value.cost[key];
    }
  }
  return usage;
}

export function normalizeMessage(message = {}) {
  message = record(message) ? message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  return {
    ...(nativeAgentMessage(message) ? { agentMessage: nativeAgentMessage(message) } : {}),
    ...(message.role === 'custom' && typeof message.customType === 'string'
      ? { customType: cleanString(message.customType, 100) }
      : {}),
    role:
      message.role === 'custom' && message.display === true
        ? message.customType === 'session_slash_command'
          ? 'user'
          : 'system'
        : cleanString(message.role, 40),
    text: splitFileMessage(imageMessageText(textOf(message.content))).text,
    attachments: [
      ...imageAttachments(content),
      ...splitFileMessage(imageMessageText(textOf(message.content))).attachments,
    ],
    thinking: content
      .filter((c) => c?.type === 'thinking')
      .map((c) => cleanString(c.thinking, MAX_LINE))
      .join('\n'),
    tools: content
      .filter((c) => c?.type === 'toolCall')
      .map((c) => ({
        id: cleanString(c.id),
        name: cleanString(c.name),
        args: c.arguments,
        status: 'pending',
      })),
    timestamp: message.timestamp ?? null,
    usage: usageOf(message.usage),
    model: message.model ? [message.provider, message.model].filter(Boolean).join('/') : undefined,
    stopReason: cleanString(message.stopReason, 40) || undefined,
    error: message.errorMessage ? diagnostic(message.errorMessage) : undefined,
    toolCallId: cleanString(message.toolCallId) || undefined,
    toolName: cleanString(message.toolName) || undefined,
    isError: message.isError === true,
  };
}

/** Stateless projection of documented Prime Agent JSON events to GUI events. */
export function normalizeEvent(event) {
  if (!record(event)) return [];
  switch (event.type) {
    case 'session':
      return [{ kind: 'session', sessionId: cleanString(event.id), cwd: cleanString(event.cwd, 32768) }];
    case 'message_start':
      return [{ kind: 'message_start', role: cleanString(event.message?.role, 40) }];
    case 'message_update': {
      const update = event.assistantMessageEvent;
      if (!update || typeof update.delta !== 'string') return [];
      // Never infer the delta type from the last content block: tool argument
      // JSON, text and reasoning can be interleaved in a single assistant turn.
      if (update.type === 'text_delta') return [{ kind: 'text', delta: update.delta }];
      if (update.type === 'thinking_delta') return [{ kind: 'thinking', delta: update.delta }];
      return [];
    }
    case 'message_end':
      return [{ kind: 'message', message: normalizeMessage(event.message) }];
    case 'tool_execution_start':
      return [
        {
          kind: 'tool_start',
          id: cleanString(event.toolCallId),
          name: cleanString(event.toolName),
          args: event.args,
        },
      ];
    case 'tool_execution_update':
      return [
        {
          kind: 'tool_update',
          id: cleanString(event.toolCallId),
          name: cleanString(event.toolName),
          result: event.partialResult,
        },
      ];
    case 'tool_execution_end':
      return [
        {
          kind: 'tool_end',
          id: cleanString(event.toolCallId),
          name: cleanString(event.toolName),
          result: event.result,
          isError: event.isError === true,
        },
      ];
    case 'auto_retry_start':
      return [
        {
          kind: 'status',
          status: 'retrying',
          message: diagnostic(event.errorMessage),
          attempt: finite(event.attempt),
          delayMs: finite(event.delayMs),
          maxAttempts: finite(event.maxAttempts),
          reason: ['usage', 'unavailable', 'backup'].includes(event.reason) ? event.reason : undefined,
          backupModel: cleanString(event.backupModel, 400) || undefined,
        },
      ];
    case 'auto_retry_end':
      return [
        {
          kind: 'status',
          status: event.success === true ? 'running' : 'retry_failed',
          retryEnded: true,
          message: event.success === true ? undefined : diagnostic(event.finalError),
          attempt: finite(event.attempt),
          restoredModel: cleanString(event.restoredModel, 400) || undefined,
        },
      ];
    case 'compaction_start':
      return [{ kind: 'status', status: 'compacting', message: 'Optimisation du contexte…' }];
    case 'compaction_end':
      return [
        {
          kind: 'status',
          status: 'running',
          message: event.errorMessage ? diagnostic(event.errorMessage) : tr('server.contexte_optimise'),
        },
      ];
    case 'agent_start':
      return [{ kind: 'status', status: 'running' }];
    case 'agent_input':
      return [{ kind: 'status', status: 'running' }];
    case 'agent_end':
      // Nonterminal turn boundary: the run stays alive (background work,
      // resident handle, or scheduler delay). Never emit done here. Only the
      // process close barrier emits done. Later agent_start, input, tool,
      // compaction or retry events resume activity in the UI.
      return [{ kind: 'status', status: 'turn_end' }];
    default:
      return [];
  }
}

/** Terminate only a running child owned by this runtime, including descendants. */
export async function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolvePromise) => {
      execFile(
        join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, shell: false, timeout: 10000 },
        () => resolvePromise(),
      );
    });
    // A failed taskkill must not leave the owning process alive.
    if (child.exitCode === null && child.signalCode === null) child.kill();
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }, 1500);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
}

/**
 * Project-local adapter. start(options) resolves a handle {pid, sessionId,
 * done, cancel()}. onEvent receives normalized events and one final `done`.
 * An HTTP disconnect does not cancel a run: the server owns its lifetime.
 */
export function createAgentRuntime(options = {}) {
  const agentHome = resolve(
    options.agentHome || process.env.PRIME_AGENT_CODING_AGENT_DIR || join(homedir(), '.prime', 'agent'),
  );
  const sessionDir = resolve(
    options.sessionDir || process.env.PRIME_AGENT_SESSION_DIR || join(agentHome, 'sessions'),
  );
  const cli = discoverCli(options.cliPath);
  const env = agentEnvironment({ agentHome, sessionDir, env: options.env || process.env });
  const knowledgeExtension =
    options.knowledge?.dataDir && cli?.packageDir
      ? join(ROOT, 'runtime', 'studio-knowledge-extension.mjs')
      : null;
  if (knowledgeExtension) {
    env.PRIME_STUDIO_KNOWLEDGE_CONFIG = JSON.stringify({
      dataDir: resolve(options.knowledge.dataDir),
      agentHome,
      sessionDir,
    });
  }
  const roadmapExtension =
    options.roadmap?.config && cli?.packageDir ? join(ROOT, 'runtime', 'studio-roadmap-extension.mjs') : null;
  if (roadmapExtension) env.PRIME_STUDIO_ROADMAP_CONFIG = JSON.stringify(options.roadmap.config);
  if (cli?.packageDir) {
    env.PRIME_STUDIO_SESSION_PACKAGE = cli.packageDir;
    const preferences = pathToFileURL(join(ROOT, 'runtime', 'session-preferences-loader.mjs')).href;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --import="${preferences}"`.trim();
    env.PRIME_STUDIO_RELAY_PACKAGE = cli.packageDir;
    const relayLoader = pathToFileURL(join(ROOT, 'runtime', 'daemon-stream-loader.mjs')).href;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --import="${relayLoader}"`.trim();
    env.PRIME_STUDIO_TRANSPORT_PACKAGE = cli.packageDir;
    const loader = pathToFileURL(join(ROOT, 'runtime', 'transport-loader.mjs')).href;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --import="${loader}"`.trim();
  }
  if (cli?.packageDir && (process.platform === 'win32' || env.PRIME_AGENT_KERNEL_PYTHON)) {
    env.PRIME_STUDIO_KERNEL_ROOT = resolve(options.kernelRoot || ROOT);
    env.PRIME_STUDIO_KERNEL_PACKAGE = cli.packageDir;
    const loader = pathToFileURL(join(ROOT, 'runtime', 'kernel-loader.mjs')).href;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --import="${loader}"`.trim();
  }
  if (options.subagentPolicyFile && cli?.packageDir) {
    env.PRIME_STUDIO_SUBAGENT_POLICY = resolve(options.subagentPolicyFile);
    env.PRIME_STUDIO_POLICY_CLI_ROOT = cli.packageDir;
    const loader = pathToFileURL(join(ROOT, 'runtime', 'subagent-loader.mjs')).href;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --import="${loader}"`.trim();
  }
  const active = new Set();
  const nativeModelCatalog =
    options.nativeModelCatalog ||
    (cli?.packageDir ? createNativeModelCatalog({ cli, agentHome, env }) : null);
  const modelAvailability = options.modelAvailability || createModelAvailability();
  const pendingStarts = new Set();
  const setupAbort = new AbortController();
  let closing = false;
  let statusPromise;
  let daemon;

  function getStatus() {
    if (env.PRIME_STUDIO_COMPONENTS_REQUIRED === '1')
      return Promise.resolve({
        available: false,
        version: cli?.version || null,
        cli: cli?.path || null,
        nodeVersion: process.versions.node,
        error:
          'Terminez la configuration dans les réglages de l’application. / Finish component setup in application settings.',
      });
    if (!cli)
      return Promise.resolve({
        available: false,
        version: null,
        cli: null,
        nodeVersion: process.versions.node,
        error: 'Prime Agent introuvable. Définissez PRIME_AGENT_CLI vers son fichier cli.js.',
      });
    if (!statusPromise)
      statusPromise = new Promise((resolvePromise) => {
        const entry = cli.launchPath ?? cli.path;
        execFile(
          cli.node ? process.execPath : cli.path,
          cli.node ? [entry, '--version'] : ['--version'],
          { env, windowsHide: true, shell: false, timeout: 20000, maxBuffer: 256 * 1024 },
          (error, stdout, stderr) => {
            const version =
              diagnostic(stdout)
                .split('\n')
                .find((line) => /\d+\.\d+/.test(line)) || cli.version;
            resolvePromise({
              available: !error,
              version,
              cli: cli.path,
              nodeVersion: process.versions.node,
              ...(error ? { error: diagnostic(stderr || error.message) } : {}),
            });
          },
        );
      });
    return statusPromise;
  }

  async function getModels({ refresh = false } = {}) {
    const [custom, settings, auth] = await Promise.all([
      readJson(join(agentHome, 'models.json'), true),
      readJson(join(agentHome, 'settings.json')),
      readJson(join(agentHome, 'auth.json')),
    ]);
    const configured = new Set(Object.keys(auth));
    for (const [provider, names] of Object.entries(MODEL_ENV))
      if (names.some((name) => env[name])) configured.add(provider);
    const models = new Map();
    const rawModels = new Map();
    let supportedThinking;
    const providers = record(custom.providers) ? custom.providers : {};
    Object.keys(providers).forEach((name) => configured.add(name));
    const configuredProviders = [...configured];
    const defaultProvider = cleanString(settings.defaultProvider);
    const defaultModel = cleanString(settings.defaultModel);
    if (defaultProvider) configured.add(defaultProvider);
    const recent = Array.isArray(settings.recentModels) ? settings.recentModels : [];
    for (const value of recent) {
      if (record(value) && typeof value.provider === 'string') configured.add(value.provider);
      else if (typeof value === 'string' && value.includes('/'))
        configured.add(value.slice(0, value.indexOf('/')));
    }
    function add(provider, model) {
      if (!record(model) || typeof model.id !== 'string' || !model.id || !provider) return;
      const id = `${cleanString(provider)}/${cleanString(model.id)}`;
      rawModels.set(id, model);
      // Positive allowlist: never return raw model/provider objects, headers,
      // API keys, endpoint URLs, compatibility settings, or auth.json values.
      models.set(id, {
        id,
        name: cleanString(model.name) || cleanString(model.id),
        provider: cleanString(provider),
        reasoning: model.reasoning === true,
        thinkingLevels: Array.isArray(model.thinkingLevels)
          ? model.thinkingLevels.filter((value) => THINKING.has(value))
          : supportedThinking
            ? supportedThinking(model)
            : model.reasoning === false
              ? ['off']
              : [],
        contextWindow: finite(model.contextWindow),
        maxTokens: finite(model.maxTokens),
        ...(['available', 'unavailable', 'unknown'].includes(model.availability)
          ? { availability: model.availability }
          : {}),
        ...(Array.isArray(model.input)
          ? { input: model.input.filter((value) => ['text', 'image'].includes(value)) }
          : {}),
      });
    }
    let nativeSnapshot;
    try {
      nativeSnapshot = await nativeModelCatalog?.read({ refresh });
    } catch {
      // Older installations keep the bundled fallback; no raw native errors or credentials leave here.
    }
    if (nativeSnapshot) {
      for (const model of nativeSnapshot.models) add(model.provider, model);
    } else if (cli?.packageDir) {
      for (const library of ['@earendil-works/pi-ai', '@mariozechner/pi-ai']) {
        const path = join(cli.packageDir, 'node_modules', library, 'dist', 'models.js');
        if (!existsSync(path)) continue;
        try {
          const builtin = await import(pathToFileURL(path).href);
          supportedThinking = builtin.getSupportedThinkingLevels;
          for (const provider of builtin.getProviders()) {
            if (configured.has(provider))
              for (const model of builtin.getModels(provider))
                if (!model.id.startsWith('internal/')) add(provider, model);
          }
        } catch {
          /* Custom and recent models remain available. */
        }
        break;
      }
    }
    // Canonical Meta fallback when the native catalog is unavailable (older
    // engines). Only with a real credential (auth.json key or MODEL_API_KEY)
    // and never over a user models.json meta entry.
    if (
      !nativeSnapshot &&
      configured.has(META_PROVIDER_ID) &&
      !record(providers[META_PROVIDER_ID]) &&
      ![...models.keys()].some((id) => id.startsWith(`${META_PROVIDER_ID}/`))
    ) {
      for (const model of META_MODELS)
        add(META_PROVIDER_ID, {
          ...model,
          thinkingLevels: Object.entries(model.thinkingLevelMap || {})
            .filter(([level, mapped]) => mapped !== null && THINKING.has(level))
            .map(([level]) => level),
        });
    }
    for (const [provider, value] of Object.entries(nativeSnapshot ? {} : providers)) {
      for (const model of Array.isArray(value?.models) ? value.models : [])
        add(provider, { api: value.api, ...model });
      if (record(value?.modelOverrides)) {
        for (const [modelId, model] of Object.entries(value.modelOverrides)) {
          const old = rawModels.get(`${provider}/${modelId}`);
          add(provider, { ...old, ...model, id: modelId });
        }
      }
    }
    for (const value of recent) {
      const id =
        typeof value === 'string'
          ? value
          : record(value)
            ? `${value.provider || ''}/${value.modelId || value.model || ''}`
            : '';
      const slash = id.indexOf('/');
      if (slash > 0 && slash < id.length - 1 && !models.has(id))
        add(id.slice(0, slash), {
          id: id.slice(slash + 1),
          ...(nativeSnapshot ? { availability: nativeSnapshot.refreshing ? 'unknown' : 'unavailable' } : {}),
        });
    }
    const defaultId = defaultModel
      ? defaultProvider && !defaultModel.startsWith(`${defaultProvider}/`)
        ? `${defaultProvider}/${defaultModel}`
        : defaultModel
      : '';
    if (defaultId.includes('/') && !models.has(defaultId)) {
      const slash = defaultId.indexOf('/');
      add(defaultId.slice(0, slash), {
        id: defaultId.slice(slash + 1),
        ...(nativeSnapshot ? { availability: nativeSnapshot.refreshing ? 'unknown' : 'unavailable' } : {}),
      });
    }
    const availability = await modelAvailability.apply([...models.values()], {
      refresh,
      customProviders: providers,
      skipIds: new Set(
        [...rawModels].filter(([, model]) => model.openRouterPublic === false).map(([id]) => id),
      ),
    });
    return {
      models: availability.models.sort(
        (a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
      ),
      configuredProviders: [
        ...new Set([...configuredProviders, ...(nativeSnapshot?.configuredProviders || [])]),
      ],
      refreshing: !!nativeSnapshot?.refreshing || availability.refreshing,
      default: {
        model: defaultId || null,
        thinking: THINKING.has(settings.defaultThinkingLevel) ? settings.defaultThinkingLevel : 'medium',
      },
    };
  }

  async function startInner(input) {
    if (closing) throw new Error(tr('server.le_runtime_est_en_cours_d_arret'));
    if (env.PRIME_STUDIO_COMPONENTS_REQUIRED === '1')
      throw new Error(
        'Terminez la configuration dans les réglages de l’application. / Finish component setup in application settings.',
      );
    if (!cli) throw new Error('Prime Agent introuvable. Définissez PRIME_AGENT_CLI.');
    if (!record(input)) throw new TypeError(tr('server.parametres_de_session_invalides'));
    if (
      typeof input.cwd !== 'string' ||
      !isAbsolute(input.cwd) ||
      !(await stat(input.cwd).catch(() => null))?.isDirectory()
    )
      throw new Error(tr('server.le_dossier_du_projet_est_introuvable'));
    const images = validateImages(input.images);
    if (typeof input.message !== 'string' || (!input.message.trim() && !images.length))
      throw new Error('Le message est vide.');
    if (Buffer.byteLength(input.message) > 512 * 1024)
      throw new Error(tr('server.le_message_depasse_512_ko'));
    for (const field of ['model', 'provider'])
      if (
        input[field] != null &&
        (typeof input[field] !== 'string' || input[field].length > 500 || /[\x00-\x1f]/.test(input[field]))
      )
        throw new Error(`${field} invalide.`);
    // Muse Code subscription runs must never silently inherit the global
    // provider backup: the native retry path would switch billing on quota or
    // outage with no per-run override available, so Studio fails closed with
    // a clear instruction (clear the engine fallback model first).
    {
      const explicitProvider = typeof input.provider === 'string' ? input.provider.trim() : '';
      const modelRef = typeof input.model === 'string' ? input.model.trim() : '';
      const modelProvider =
        !explicitProvider && modelRef.includes('/') ? modelRef.slice(0, modelRef.indexOf('/')).trim() : '';
      const engineDefaults = await readJson(join(agentHome, 'settings.json'));
      const defaultProvider =
        typeof engineDefaults.defaultProvider === 'string' ? engineDefaults.defaultProvider.trim() : '';
      const primaryProvider = explicitProvider || modelProvider || defaultProvider;
      const backupRef =
        typeof engineDefaults.providerBackupModel === 'string' ? engineDefaults.providerBackupModel : '';
      if (isBlockedMuseCodeBackup({ primaryProvider, backupRef })) {
        throw new Error(tr('server.muse_backup_run_refused'));
      }
    }
    if (input.thinking && !THINKING.has(input.thinking)) throw new Error('Niveau de réflexion invalide.');
    if (input.sessionId && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.sessionId))
      throw new Error('Identifiant de session invalide.');
    if (
      input.sessionFile &&
      (!isAbsolute(input.sessionFile) || !(await stat(input.sessionFile).catch(() => null))?.isFile())
    )
      throw new Error(tr('server.fichier_de_session_introuvable'));
    await mkdir(sessionDir, { recursive: true });
    if (cli.packageDir && (process.platform === 'win32' || env.PRIME_AGENT_KERNEL_PYTHON)) {
      await ensureLocalKernel({
        packageDir: cli.packageDir,
        cwd: input.cwd,
        agentHome,
        root: options.kernelRoot || ROOT,
        env,
        signal: setupAbort.signal,
        onProgress(message) {
          try {
            input.onEvent?.({ kind: 'status', status: 'preparing', message });
          } catch {
            /* Keep setup independent of observers. */
          }
        },
      });
    }
    if (closing) throw new Error(tr('server.le_runtime_est_en_cours_d_arret'));
    let daemonStatus;
    if (cli.node && cli.packageDir) {
      daemon ||= createOwnedDaemon({
        cli,
        env,
        cwd: ROOT,
        terminateProcess: terminateProcessTree,
        onDiagnostic: ({ kind, message }) => console.error(`[${kind}] ${diagnostic(message)}`),
      });
      daemonStatus = await daemon.ensureReady();
      if (closing) throw new Error(tr('server.le_runtime_est_en_cours_d_arret'));
    }
    const interactive = input.allowQuestions === true && !!daemon;
    const autonomousLimitReason = interactive
      ? (await import(pathToFileURL(join(cli.packageDir, 'dist/core/autonomous.js')).href))
          .autonomousLimitReason
      : null;
    if (input.allowQuestions === true && !interactive)
      throw new Error('Les questions nécessitent le moteur natif de Prime Agent.');
    const args = [
      '-p',
      '--mode',
      interactive ? 'rpc' : 'json',
      '--cwd',
      resolve(input.cwd),
      '--session-dir',
      sessionDir,
    ];
    if (cli.packageDir) args.push('--extension', join(ROOT, 'runtime', 'studio-image-extension.mjs'));
    // Canonical Meta provider for execution and subagents. User models.json
    // meta entries win: the extension skips registration when one exists.
    if (cli.packageDir)
      args.push('--extension', join(ROOT, 'runtime', 'studio-meta-provider-extension.mjs'));
    // Gated Muse Code subscription provider (experimental, OAuth-only). The
    // extension hides the provider until the real protocol adapter
    // (lib/muse-oauth-provider.mjs) validates, so shipping this line exposes
    // no stub. No MODEL_ENV entry and no offline fallback exist for this id:
    // stored OAuth is the only credential source.
    if (cli.packageDir)
      args.push('--extension', join(ROOT, 'runtime', 'studio-muse-code-extension.mjs'));
    if (interactive) args.push('--extension', join(ROOT, 'runtime', 'studio-question-extension.mjs'));
    if (knowledgeExtension) args.push('--extension', knowledgeExtension);
    if (roadmapExtension) args.push('--extension', roadmapExtension);
    if (daemon) args.push('--daemon-socket', daemon.socketPath);
    if (input.sessionFile || input.sessionId) args.push('--resume', input.sessionFile || input.sessionId);
    if (input.provider) args.push('--provider', input.provider);
    if (input.model) args.push('--model', input.model);
    if (input.thinking) args.push('--thinking', input.thinking);
    if (!interactive)
      for (const file of await persistImages(images, join(sessionDir, '.studio-images')))
        args.push(`@${file}`);
    const entry = cli.launchPath ?? cli.path;
    const nodeArgs = daemon
      ? [
          '--require',
          join(ROOT, 'runtime', 'cli-control.cjs'),
          '--import',
          pathToFileURL(join(ROOT, 'runtime', interactive ? 'studio-rpc-loader.mjs' : 'headless-loader.mjs'))
            .href,
          entry,
          ...args,
        ]
      : [entry, ...args];
    const child = spawn(cli.node ? process.execPath : cli.path, cli.node ? nodeArgs : args, {
      cwd: input.cwd,
      env: daemon ? { ...env, PRIME_GUI_CONTROL: '1', PRIME_GUI_CLI_ROOT: cli.packageDir } : env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: daemon ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
    });
    const emit = (event) => {
      try {
        input.onEvent?.(event);
      } catch {
        /* Observers cannot interrupt process cleanup. */
      }
    };
    const sendRpc = (command) => child.stdin.write(JSON.stringify(command) + '\n');
    const interactions = createNativeInteractions({ emit, send: sendRpc });
    let sessionId = input.sessionId || null;
    let stopped = false,
      finished = false,
      stderr = '',
      failure = '',
      providerFailure = '',
      buffer = '';
    const decoder = new StringDecoder('utf8');
    let complete;
    let cancellation;
    const done = new Promise((resolvePromise) => {
      complete = resolvePromise;
    });
    const handle = {
      pid: child.pid,
      daemonPid: daemonStatus?.pid,
      get sessionId() {
        return sessionId;
      },
      done,
      respond: (id, response) => interactions.respond(id, response),
      async cancel() {
        if (finished) return done;
        cancellation ||= (async () => {
          stopped = true;
          if (daemon && child.connected) {
            // Windows kill() bypasses signal handlers. IPC lets the owning CLI
            // close its native worker and delegated children before it exits.
            try {
              child.send({ type: 'prime-studio:cancel', version: 1 }, () => {});
              let timeout;
              await Promise.race([
                done,
                new Promise((resolvePromise) => {
                  timeout = setTimeout(resolvePromise, 10000);
                }),
              ]);
              clearTimeout(timeout);
            } catch {
              /* Fall back to the owned CLI process tree. */
            }
          }
          if (!finished) await terminateProcessTree(child);
          return done;
        })();
        return cancellation;
      },
    };
    active.add(handle);
    function finish(code, signal) {
      if (finished) return;
      finished = true;
      interactions.close();
      active.delete(handle);
      const error =
        failure ||
        providerFailure ||
        (code !== 0 && !stopped
          ? diagnostic(stderr) || `Prime Agent s'est arrêté (code ${code ?? signal ?? 'inconnu'}).`
          : null);
      const event = {
        kind: 'done',
        sessionId,
        status: stopped ? 'stopped' : error ? 'failed' : 'completed',
        code,
        ...(error && !stopped ? { error } : {}),
      };
      emit(event);
      complete(event);
    }
    function consume(line) {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        stderr = (stderr + '\n' + line).slice(-8000);
        return;
      }
      if (!record(event)) return;
      if (interactive) {
        if (interactions.consume(event)) return;
        if (event.type === 'response') {
          if (!event.success) {
            failure = diagnostic(event.error);
            child.stdin.end();
            return;
          }
          if (event.id === 'studio-state') {
            sessionId = event.data?.sessionId;
            if (!sessionId) {
              failure = 'Le moteur n’a pas identifié la conversation.';
              child.stdin.end();
              return;
            }
            emit({ kind: 'session', sessionId, cwd: resolve(input.cwd) });
            sendRpc({
              type: 'prompt',
              id: 'studio-prompt',
              message: input.message.trim() || 'Analyse les images jointes.',
              ...(images.length ? { images } : {}),
            });
          } else if (event.id === 'studio-prompt') {
            sendRpc({ type: 'studio_wait_for_completion', id: 'studio-complete' });
          } else if (event.id === 'studio-complete') {
            const autonomous = event.data;
            if (
              autonomous?.enabled &&
              ((autonomous.gates.commands.length > 0 && autonomous.lastGateFailure) ||
                (autonomous.gates.commands.length === 0 && autonomousLimitReason(autonomous)))
            )
              failure = 'La vérification autonome du moteur n’a pas abouti.';
            child.stdin.end();
          }
          return;
        }
      }
      if (event.type === 'session' && typeof event.id === 'string') sessionId = event.id;
      if (
        event.type === 'message_end' &&
        event.message?.role === 'assistant' &&
        event.message.stopReason === 'error'
      )
        providerFailure =
          diagnostic(event.message.errorMessage) ||
          tr('server.le_fournisseur_de_modele_a_renvoye_une_erreur');
      if (event.type === 'auto_retry_end' && event.success === true) providerFailure = null;
      for (const normalized of normalizeEvent(event)) emit(normalized);
    }
    child.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > MAX_LINE) {
        failure = tr('server.une_reponse_de_prime_agent_depasse_la_limite_de_lecture_16_mo');
        void terminateProcessTree(child);
        buffer = '';
      }
    });
    child.stdout.on('end', () => {
      buffer += decoder.end();
      if (buffer.trim()) consume(buffer);
      buffer = '';
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') failure = diagnostic(error.message);
    });
    child.on('error', (error) => {
      failure = diagnostic(error.message);
      finish(-1);
    });
    child.on('close', finish);
    if (interactive) sendRpc({ type: 'get_state', id: 'studio-state' });
    else child.stdin.end(input.message.trim() || 'Analyse les images jointes.');
    return handle;
  }

  function start(input) {
    const pending = startInner(input);
    pendingStarts.add(pending);
    pending.then(
      () => pendingStarts.delete(pending),
      () => pendingStarts.delete(pending),
    );
    return pending;
  }

  return {
    agentHome,
    sessionDir,
    getStatus,
    getModels,
    start,
    getLiveEndpoint() {
      return daemon && cli?.packageDir
        ? {
            packageDir: cli.packageDir,
            socketPath: daemon.socketPath,
            agentDir: agentHome,
            supervisorPid: daemon.pid,
          }
        : null;
    },
    async close() {
      closing = true;
      setupAbort.abort();
      await Promise.allSettled([...pendingStarts, ...[...active].map((handle) => handle.cancel())]);
      await daemon?.close();
      await Promise.allSettled([nativeModelCatalog?.close(), modelAvailability.close()]);
    },
  };
}
