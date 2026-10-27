// Native Computer Use extension: real desktop tools for Studio agents.
// Loaded through the Prime Agent native --extension option, like the roadmap
// extension. Identity comes from the native context, never from tool args.
// computer_observe returns ImageContent plus JSON metadata, never base64 text.

import { Type } from 'typebox';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { dirname, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeContextImagesWithReport } from './computer-use-image-safety.mjs';

const optional = Type.Optional;
const object = (properties) => Type.Object(properties, { additionalProperties: false });
const literal = (values) => Type.Union(values.map((value) => Type.Literal(value)));
const ENABLE_HINT =
  'Computer Use is off. Enable it in Studio with the Computer Use toggle before using desktop tools. Tools cannot enable it themselves.';

function observeScopeSchema() {
  return object({
    windowId: optional(Type.String({ minLength: 1, maxLength: 500 })),
    region: optional(
      object({
        x: Type.Number(),
        y: Type.Number(),
        width: Type.Number({ minimum: 1, maximum: 8192 }),
        height: Type.Number({ minimum: 1, maximum: 8192 }),
      }),
    ),
    maxWidth: optional(Type.Integer({ minimum: 16, maximum: 4096 })),
  });
}

function applicationStateOf(response) {
  return typeof response?.applicationState === 'string' && response.applicationState
    ? response.applicationState
    : 'unverified';
}

function observationErrorOf(response) {
  const value = response?.observationError;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return undefined;
}

// Text payloads never carry image bytes. Image results expose pixels only
// through ImageContent; the JSON side carries executed counts, frames and
// verification metadata.
function stripImageBytes(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripImageBytes);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'image' && entry && typeof entry === 'object' && typeof entry.data === 'string') {
      const { data: _dropped, ...rest } = entry;
      out[key] = rest;
    } else if (entry && typeof entry === 'object') {
      out[key] = stripImageBytes(entry);
    } else {
      out[key] = entry;
    }
  }
  return out;
}

// Engine photon resizer for user-pasted attachments. Resolved lazily from
// the running engine install (Studio launches dist/bundle/cli{,-node}.js,
// the helper ships at dist/utils/image-resize.js) and cached for the process
// lifetime. Returns null when unavailable so oversized attachments fall back
// to a removal marker instead of breaking the provider request.
// PRIME_STUDIO_IMAGE_RESIZER=off forces the fallback (hermetic unit tests).
let engineImageResizerPromise = null;
function engineImageResizeFile() {
  for (const candidate of [process.env.PRIME_AGENT_CLI, process.argv?.[1]]) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    try {
      return resolvePath(dirname(candidate), '..', 'utils', 'image-resize.js');
    } catch {
      /* Try the next candidate. */
    }
  }
  return null;
}
function loadEngineImageResizer() {
  if (!engineImageResizerPromise) {
    engineImageResizerPromise = (async () => {
      try {
        if (process.env.PRIME_STUDIO_IMAGE_RESIZER === 'off') return null;
        const file = engineImageResizeFile();
        if (!file) return null;
        await stat(file);
        const mod = await import(pathToFileURL(file).href);
        return typeof mod.resizeImage === 'function' ? mod.resizeImage : null;
      } catch {
        return null;
      }
    })();
  }
  return engineImageResizerPromise;
}

// Bounded per-process cache of downscaled attachments: the context hook runs
// before every provider request while history keeps the oversized originals,
// so without this each turn would re-resize the same bytes. Capped at 8
// entries, FIFO eviction, successes only.
const RESIZED_CACHE_LIMIT = 8;
const resizedAttachmentCache = new Map();
async function cachedResizeAttachment(resizeImage, part) {
  const key = createHash('sha256').update(part.data).digest('hex');
  const hit = resizedAttachmentCache.get(key);
  if (hit) {
    resizedAttachmentCache.delete(key);
    resizedAttachmentCache.set(key, hit);
    return { data: hit.data, mimeType: hit.mimeType };
  }
  const result = await resizeImage({ type: 'image', data: part.data, mimeType: part.mimeType });
  if (result && typeof result.data === 'string' && result.data.length > 0) {
    resizedAttachmentCache.set(key, { data: result.data, mimeType: result.mimeType });
    while (resizedAttachmentCache.size > RESIZED_CACHE_LIMIT) {
      resizedAttachmentCache.delete(resizedAttachmentCache.keys().next().value);
    }
  }
  return result;
}

export default function studioComputerUse(pi) {
  // Normalize only the transient provider context. Never rewrite session logs.
  // Computer Use screenshots are dropped (rescaling them without updating the
  // stored coordinate frame would corrupt frame safety); user attachments are
  // downscaled, dropped only when no resizer is available. Small images are
  // never touched. Async is supported: the engine awaits context handlers and
  // keeps the previous context when a handler throws, plus the try/catch
  // below keeps this hook fail-open by construction.
  pi.on('context', async (event) => {
    try {
      const engineResizer = await loadEngineImageResizer();
      const report = await normalizeContextImagesWithReport(event.messages, {
        ...(engineResizer ? { resizeImage: (part) => cachedResizeAttachment(engineResizer, part) } : {}),
      });
      if (report.dropped > 0 || report.resized > 0) return { messages: report.messages };
    } catch {
      /* Fail-open: never block the provider call. */
    }
    return undefined;
  });
  if (!process.env.PRIME_STUDIO_COMPUTER_USE_CONFIG) return;
  let config;
  try {
    config = JSON.parse(process.env.PRIME_STUDIO_COMPUTER_USE_CONFIG);
  } catch {
    return;
  }
  if (typeof config?.socketPath !== 'string' || typeof config?.token !== 'string') return;
  const states = new Map();

  function modelRefOf(model) {
    if (!model || typeof model !== 'object') return undefined;
    const provider = typeof model.provider === 'string' ? model.provider.trim() : '';
    const id =
      typeof model.id === 'string'
        ? model.id.trim()
        : typeof model.model === 'string'
          ? model.model.trim()
          : '';
    if (!provider || !id) return undefined;
    const ref = `${provider}/${id}`;
    return ref.length <= 500 ? ref : undefined;
  }

  // Identity preserves only native cwd/sessionId/sessionFile.
  // Bridge ignores wire model hints and trusts resolveCaller provenance only;
  // modelRefOf(ctx.model) is used locally for child guidance.
  function identity(ctx) {
    return {
      cwd: ctx?.cwd,
      sessionId: ctx?.sessionManager?.getSessionId?.(),
      sessionFile: ctx?.sessionManager?.getSessionFile?.(),
    };
  }

  function boundedDetailsText(body) {
    if (!body || typeof body !== 'object') return '';
    let details = null;
    if (body.details && typeof body.details === 'object' && !Array.isArray(body.details)) {
      details = body.details;
    } else if (body.details !== undefined) {
      details = { details: body.details };
    } else {
      const rest = {};
      for (const [key, value] of Object.entries(body)) {
        if (key === 'error' || key === 'code') continue;
        if (value === undefined) continue;
        rest[key] = value;
      }
      if (Object.keys(rest).length > 0) details = rest;
    }
    if (!details) return '';
    try {
      let text = JSON.stringify(details);
      // Bounded: native journal keeps content only, so keep the visible detail small.
      if (text.length > 1200) text = `${text.slice(0, 1200)}…`;
      return ` details ${text}`;
    } catch {
      return '';
    }
  }

  function bridgeError(statusCode, body) {
    const message =
      body && typeof body.error === 'string' && body.error ? body.error : 'Computer Use request failed.';
    const code = body && typeof body.code === 'string' && body.code ? body.code : 'computer_use_failed';
    // Native engine wrapping ignores Error.details and provider adapters read
    // msg.content only, so bridge details must live inside the thrown message
    // (bounded) in addition to Error.code/details properties. Throwing keeps isError true.
    const suffix = boundedDetailsText(body);
    const text =
      code && code !== 'computer_use_failed' ? `${message} [${code}]${suffix}` : `${message}${suffix}`;
    return Object.assign(new Error(text), {
      code,
      status: Number.isInteger(statusCode) ? statusCode : 500,
      details: body,
    });
  }

  function mainDelegationPrompt(routing) {
    const hasModel = routing && typeof routing.model === 'string' && routing.model;
    const hasThinking = routing && typeof routing.thinking === 'string' && routing.thinking;
    const configured = hasModel
      ? `Configured CU model ${routing.model}${hasThinking ? `, thinking ${routing.thinking}` : ''} overrides general subagent defaults.`
      : 'Use the configured Computer Use model/thinking from status routing; it overrides general subagent defaults.';
    // Exact native call shape is Python with named kwargs and JSON-quoted strings.
    const spawnLine = hasModel
      ? `For whole-task desktop work only, create one normal subagent via await rlm.spawn(task, name="unique-name", model=${JSON.stringify(routing.model)}${hasThinking ? `, thinking=${JSON.stringify(routing.thinking)}` : ''}) and reuse via agent_message when suitable.`
      : 'For whole-task desktop work only, create one normal subagent via await rlm.spawn(task, name="unique-name", model=<configured routing model>) and reuse via agent_message when suitable.';
    return [
      'Computer Use desktop is enabled for on-demand delegation only.',
      'Main never calls desktop tools; any desktop action returns computer_use_delegate_required.',
      configured,
      spawnLine,
      'Do not auto-create computer subagents on ordinary tasks.',
      'Collect result/blocker via parent messages; do not poll.',
    ].join(' ');
  }

  function childDelegationPrompt(routing, ownModel, matched) {
    const routingModel = routing && typeof routing.model === 'string' && routing.model ? routing.model : null;
    const routingThinking =
      routing && typeof routing.thinking === 'string' && routing.thinking ? routing.thinking : null;
    const where = routingModel
      ? `routing ${routingModel}${routingThinking ? ` (thinking ${routingThinking})` : ''}`
      : 'status routing';
    if (matched) {
      return (
        `Computer Use is available to this subagent ONLY if this task requires desktop interaction (model ${ownModel} matches ${where}). ` +
        'Otherwise use normal tools and do not touch desktop tools. ' +
        'First desktop use acquires the exclusive lock; report result/blocker to parent via messages. ' +
        'Recoverable refusals keep the lock until task end; lock releases at task end.'
      );
    }
    const you = ownModel ? `you are ${ownModel}` : 'your model is unknown';
    return (
      `You are not the configured Computer Use model (need ${routingModel || 'status routing model'}, ${you}). ` +
      'Do not use desktop tools or switch models silently; delegate to the configured model or ask parent. ' +
      'Desktop actions as non-holder return computer_use_delegate_required.'
    );
  }

  function stateFor(ctx) {
    const value = identity(ctx);
    let state = states.get(value.sessionId);
    if (!state) {
      state = { identity: value, ended: false };
      states.set(value.sessionId, state);
    } else {
      state.identity = value;
    }
    return state;
  }

  function requestIpc(action, params, ide, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted)
        return reject(
          bridgeError(409, { error: 'Computer Use operation cancelled.', code: 'computer_use_cancelled' }),
        );
      let payload;
      try {
        payload = JSON.stringify({ action, params, identity: ide });
      } catch {
        return reject(new Error('Computer Use request exceeds 128 KiB. Use a smaller action batch.'));
      }
      if (Buffer.byteLength(payload) > 128 * 1024)
        return reject(new Error('Computer Use request exceeds 128 KiB. Use a smaller action batch.'));
      let complete = false;
      const finish = (error, result) => {
        if (complete) return;
        complete = true;
        signal?.removeEventListener('abort', cancel);
        if (error) {
          try {
            req.destroy();
          } catch {}
          reject(error);
        } else resolve(result);
      };
      const cancel = () =>
        finish(
          bridgeError(409, { error: 'Computer Use operation cancelled.', code: 'computer_use_cancelled' }),
        );
      const req = httpRequest(
        {
          socketPath: config.socketPath,
          path: '/',
          method: 'POST',
          agent: false,
          headers: {
            Authorization: `Bearer ${config.token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          const chunks = [];
          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 10 * 1024 * 1024)
              return finish(new Error('Computer Use response is too large. Retry with a smaller region.'));
            chunks.push(chunk);
          });
          res.on('error', () => finish(new Error('Computer Use connection interrupted.')));
          res.on('end', () => {
            let result;
            try {
              result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              return finish(new Error('Computer Use response was invalid.'));
            }
            // Preserve precise bridge code/details: non-200 carries {error, code}.
            // Throwing keeps isError true while the message keeps code visible to the LLM.
            if (res.statusCode !== 200) return finish(bridgeError(res.statusCode, result));
            finish(null, result);
          });
        },
      );
      req.setTimeout(35000, () =>
        finish(new Error('Computer Use operation timed out. Observe again before acting.')),
      );
      req.on('error', () => finish(new Error('Computer Use service is unavailable.')));
      signal?.addEventListener('abort', cancel, { once: true });
      req.end(payload);
    });
  }

  function send(action, params, state, signal) {
    return requestIpc(action, params, state.identity, signal);
  }

  function sendRaw(action, params, ide, signal) {
    return requestIpc(action, params, ide, signal);
  }

  async function bestEffortRelease(ide) {
    if (!ide || typeof ide.sessionId !== 'string' || !ide.sessionId) return;
    try {
      await sendRaw('release', {}, ide, undefined).catch(() => {});
    } catch {
      /* Best-effort: failed release never masks the task result. */
    }
  }

  const textResult = (action, data) => ({
    content: [{ type: 'text', text: JSON.stringify(data) }],
    details: { action },
  });

  function actImageResult(response) {
    const frame = response.observe.frame;
    const applicationState = applicationStateOf(response);
    const observationError = observationErrorOf(response);
    const { observe, ...safe } = stripImageBytes(response);
    const textPayload = {
      ...safe,
      frame,
      applicationState,
      ...(observe?.elements ? { elements: observe.elements, truncated: observe.truncated } : {}),
    };
    if (observationError) textPayload.observationError = observationError;
    const details = {
      action: 'computer_act',
      executed: response.executed,
      frame,
      applicationState,
      ...(response.partial !== undefined ? { partial: response.partial } : {}),
    };
    if (observationError) details.observationError = observationError;
    return {
      content: [
        { type: 'image', data: response.observe.image.data, mimeType: response.observe.image.mimeType },
        { type: 'text', text: JSON.stringify(textPayload) },
      ],
      details,
    };
  }

  function actTextResult(response) {
    const safe = stripImageBytes(response);
    const applicationState = applicationStateOf(response);
    const observationError = observationErrorOf(response);
    const textPayload = { ...safe, applicationState };
    const details = { action: 'computer_act', applicationState };
    if (typeof response?.executed === 'number') details.executed = response.executed;
    if (response?.observe?.frame) details.frame = response.observe.frame;
    if (response?.frame) details.frame = response.frame;
    if (observationError) details.observationError = observationError;
    return {
      content: [{ type: 'text', text: JSON.stringify(textPayload) }],
      details,
    };
  }

  function register(name, label, description, parameters, execute, parallel = false) {
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      executionMode: parallel ? 'parallel' : 'sequential',
      execute: async (_id, params, signal, _update, ctx) => {
        const state = stateFor(ctx);
        if (state.ended) throw new Error('This agent turn has ended.');
        return execute(params, state, signal, ctx);
      },
    });
  }

  pi.on('before_agent_start', async (event, ctx) => {
    try {
      // Release any leftover own hold before a new mission (no-op for non-holders, idempotent).
      // Fail-open: leftover release never blocks the new prompt.
      try {
        await bestEffortRelease(identity(ctx));
      } catch {}
      // Permission-scoped read-only status over local IPC: no LLM call, no driver spawn.
      // Only appends SHORT instructions when permission is enabled.
      let status = null;
      try {
        const probe = identity(ctx);
        if (!probe || typeof probe.sessionId !== 'string' || !probe.sessionId) return undefined;
        status = await sendRaw('status', {}, probe, ctx?.signal).catch(() => null);
      } catch {
        return undefined;
      }
      if (!status || status.enabled !== true) return undefined;
      const routing =
        status.routing && typeof status.routing === 'object' && !Array.isArray(status.routing)
          ? status.routing
          : null;
      const delegated = status.delegated === true;
      const ownModel = modelRefOf(ctx?.model);
      const routingModel =
        routing && typeof routing.model === 'string' && routing.model ? routing.model : null;
      let extra = null;
      if (!delegated) {
        extra = mainDelegationPrompt(routing);
      } else {
        const matched = Boolean(routingModel && ownModel && routingModel === ownModel);
        extra = childDelegationPrompt(routing, ownModel, matched);
      }
      if (!extra) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
    } catch {
      return undefined;
    }
  });

  pi.on('agent_start', (_event, ctx) => {
    try {
      const value = identity(ctx);
      if (!value || typeof value.sessionId !== 'string' || !value.sessionId) return;
      states.set(value.sessionId, { identity: value, ended: false });
    } catch {}
  });
  pi.on('agent_end', async (_event, ctx) => {
    try {
      const sid = ctx?.sessionManager?.getSessionId?.();
      const state = typeof sid === 'string' ? states.get(sid) : undefined;
      if (state) state.ended = true;
    } catch {}
    // Lifecycle release is best-effort via raw send after state ended (idempotent).
    // Only the actual holder affects the manager; recoverable refusals stay owned until here.
    await bestEffortRelease(identity(ctx));
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    try {
      const sid = ctx?.sessionManager?.getSessionId?.();
      const state = typeof sid === 'string' ? states.get(sid) : undefined;
      if (state) state.ended = true;
    } catch {}
    await bestEffortRelease(identity(ctx));
  });

  register(
    'computer_status',
    'Computer status',
    'Check Computer Use desktop state (read-only, permission-scoped, never enables): enabled, mine (exact holder), delegated (native caller agentId exists), routing {model, thinking}, owner/busy, last action and last frame metadata. Returns the true off state while disabled and tells how to enable. Reports the selected backend (native or cua) and availability without enabling or switching it. Never returns pixels, never captures, never moves input. Main never holds desktop; desktop actions as non-holder return computer_use_delegate_required.',
    object({}),
    async (_params, state, signal) => textResult('computer_status', await send('status', {}, state, signal)),
    true,
  );

  register(
    'computer_windows',
    'Computer windows',
    'List visible desktop windows, focus one by windowId, or wait for a window to appear. Coordinates are screen physical pixels. Enable Computer Use in Studio first. Wait is read-only and bounded: it never focuses, launches, or captures, and it follows turn cancellation within timeoutMs. Filters processName (case-insensitive exact, .exe suffix accepted), title (case-insensitive substring), and windowId combine with AND; wait needs at least one nonempty filter. timeoutMs is an integer from 100 to 20000, default 10000. The response carries found, timedOut, window on success, the matching windows list, elapsedMs, and a note. found means the window exists, not that the app UI or sound is ready. timedOut means it was not seen within budget, not that the app failed. After launching an app, wait for its window, focus it if needed, then observe that window before claiming an outcome. Every screenshot is point-in-time and can show loading or unsettled UI. If focus changes, observe again instead of repeating the launch or acting from a stale frame. Main never holds desktop; use via a delegated subagent whose model matches status routing.model. Recoverable refusals keep the lock until task end; lock releases at agent_end/session_shutdown or via computer_release (only the actual holder releases).',
    object({
      action: optional(literal(['list', 'focus', 'wait'])),
      windowId: optional(Type.String({ minLength: 1, maxLength: 500 })),
      processName: optional(Type.String({ minLength: 1, maxLength: 500 })),
      title: optional(Type.String({ minLength: 1, maxLength: 500 })),
      timeoutMs: optional(Type.Integer({ minimum: 100, maximum: 20000 })),
    }),
    async (params, state, signal) => {
      if (params?.action === 'wait') {
        const hasProcess = typeof params.processName === 'string' && params.processName.trim().length > 0;
        const hasTitle = typeof params.title === 'string' && params.title.trim().length > 0;
        const hasWindow = typeof params.windowId === 'string' && params.windowId.trim().length > 0;
        if (!hasProcess && !hasTitle && !hasWindow) {
          throw new Error(
            'Computer windows wait needs at least one nonempty filter: processName, title, or windowId.',
          );
        }
        if (
          params.timeoutMs !== undefined &&
          (!Number.isInteger(params.timeoutMs) || params.timeoutMs < 100 || params.timeoutMs > 20000)
        ) {
          throw new Error('Computer windows wait timeoutMs must be an integer between 100 and 20000.');
        }
      }
      return textResult('computer_windows', await send('windows', params, state, signal));
    },
  );

  register(
    'computer_observe',
    'Computer observe',
    'Capture a screenshot of the real Windows desktop. Returns an image plus frame metadata with frameId, width, height and bounds. Coordinates in later actions use screenshot pixels of that exact frame. The image is point-in-time and can show loading or unsettled UI, so after launching an app wait for its window and observe that window before claiming an outcome. Observe again after every action batch. If off, the error explains how to enable in Studio. Images are capped at 2000 pixels on both axes, even when maxWidth is larger, for provider compatibility. With CUA, named-window captures also include accessibility elements; use their elementId for semantic actions. CUA in this beta supports full windows or the primary desktop, not region crops. maxWidth limits the long edge of window captures; primary-desktop captures stay at native resolution and are refused above 2000 pixels on either axis, so select a windowId instead. The original backend supports regions and the full multi-monitor desktop. Inspect or observe is always required after changing backend. Main never holds desktop and returns computer_use_delegate_required; only a delegated child matching routing.model may observe. Recoverable refusals keep the lock until task end; lock releases at task end.',
    object({
      windowId: optional(Type.String({ minLength: 1, maxLength: 500 })),
      region: optional(
        object({
          x: Type.Number(),
          y: Type.Number(),
          width: Type.Number({ minimum: 1, maximum: 8192 }),
          height: Type.Number({ minimum: 1, maximum: 8192 }),
        }),
      ),
      maxWidth: optional(Type.Integer({ minimum: 16, maximum: 4096 })),
    }),
    async (params, state, signal) => {
      const response = await send('observe', params, state, signal);
      if (!response?.image || typeof response.image.data !== 'string') {
        if (response && (typeof response.error === 'string' || typeof response.code === 'string'))
          throw bridgeError(409, response);
        throw new Error(ENABLE_HINT);
      }
      return {
        content: [
          { type: 'image', data: response.image.data, mimeType: response.image.mimeType },
          { type: 'text', text: JSON.stringify(stripImageBytes({ ...response, image: undefined })) },
        ],
        details: { action: 'computer_observe', frame: response.frame },
      };
    },
  );

  register(
    'computer_inspect',
    'Computer inspect',
    'CUA mode only: read a window accessibility tree without taking a screenshot. Get windowId from computer_windows first. Returns bounded elements with elementId and a fresh accessibility-only frameId. Prefer this for named buttons and text fields when CUA is selected. Use elementId in computer_act, or set_value with elementId and value. This frame has no pixel coordinates. Inspect or observe again after each batch; old tokens are not reusable. Accessibility state is point-in-time, not proof that an app is ready or the task succeeded. Does not enable Computer Use or change the selected backend. Main never holds desktop and returns computer_use_delegate_required; only a delegated child matching routing.model may inspect. Lock releases at task end.',
    object({ windowId: Type.String({ minLength: 1, maxLength: 500 }) }),
    async (params, state, signal) =>
      textResult('computer_inspect', await send('inspect', params, state, signal)),
  );

  const actionSchema = Type.Object(
    {
      type: Type.Union(
        ['click', 'double_click', 'move', 'drag', 'scroll', 'keypress', 'type', 'wait', 'set_value'].map(
          (value) => Type.Literal(value),
        ),
      ),
      x: optional(Type.Number({ minimum: 0 })),
      y: optional(Type.Number({ minimum: 0 })),
      elementId: optional(Type.String({ minLength: 1, maxLength: 256 })),
      value: optional(Type.String({ maxLength: 2000 })),
      button: optional(literal(['left', 'right', 'middle'])),
      text: optional(Type.String({ minLength: 1, maxLength: 2000 })),
      keys: optional(Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 8 })),
      deltaX: optional(Type.Integer({ minimum: -100, maximum: 100 })),
      deltaY: optional(Type.Integer({ minimum: -100, maximum: 100 })),
      path: optional(
        Type.Array(
          Type.Object(
            { x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }) },
            { additionalProperties: false },
          ),
          { maxItems: 20 },
        ),
      ),
      ms: optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    },
    { additionalProperties: false },
  );

  register(
    'computer_act',
    'Computer act',
    'Drive the real desktop with a short bounded batch (1 to 12 actions). frameId must come from the latest computer_observe or CUA computer_inspect call and is consumed by the act. Coordinates x and y use screenshot pixels of that frame (0 <= x < width, 0 <= y < height); the bridge maps them to physical screen pixels and the native worker revalidates screen layout, window geometry and focus before input. Observe again after acting and never replay a timed out batch blindly. Scroll deltas are wheel ticks: positive deltaY scrolls down, positive deltaX scrolls right, range -100 to 100, at least one nonzero. Drag presses at x,y, moves through each path point in order (up to 20), and releases at the last path point. Key names are 1 to 32 characters, up to 8 per press. Wait accepts 1 to 5000 ms. Set observeAfter true to capture a verification screenshot in the same call. By default the verification reuses the original frame capture options (windowId, region, maxWidth); pass observeOptions {} for a whole desktop capture or a windowId, region, maxWidth object for a scoped capture. observeOptions is valid only with observeAfter true. A new app window can appear on another monitor, so prefer wait plus observe of the new window before acting on it. Every screenshot is point-in-time and can show loading or unsettled UI, so observe the target window before claiming an outcome. Results carry applicationState unverified because sent input is not task success. If verification capture fails after successful input, the result keeps executed plus observationError {code, message} without failing the whole call; observe again instead of replaying the batch. In CUA mode only, use elementId from the same frame instead of x/y, and set_value with elementId plus value for editable fields (empty value clears). Accessibility-only frames reject pixel coordinates. deliveryMode may explicitly select foreground or background for the batch; by default CUA pixel actions use foreground and element-targeted actions use background; a refusal is not permission to replay in another mode. CUA unsupported operations return explicit errors, never native fallback. CUA results include per-action effects and may be partial or unverifiable: executed does not prove success. Main never holds desktop and returns computer_use_delegate_required; only the delegated child whose model matches routing.model may act. Recoverable refusals (including delegate-required) keep the lock until task end; do not release on every refusal. Lock releases at agent_end/session_shutdown or via computer_release.',
    object({
      frameId: Type.String({ minLength: 1, maxLength: 60 }),
      actions: Type.Array(actionSchema, { minItems: 1, maxItems: 12 }),
      observeAfter: optional(Type.Boolean()),
      observeOptions: optional(observeScopeSchema()),
      deliveryMode: optional(literal(['foreground', 'background'])),
    }),
    async (params, state, signal) => {
      if (params?.observeOptions !== undefined && params?.observeAfter !== true) {
        throw new Error(
          'observeOptions is valid only with observeAfter:true. Set observeAfter:true or drop observeOptions.',
        );
      }
      const response = await send('act', params, state, signal);
      if (response?.observe?.image && typeof response.observe.image.data === 'string') {
        return actImageResult(response);
      }
      return actTextResult(response);
    },
  );

  register(
    'computer_release',
    'Computer release',
    'Release own desktop lock (idempotent, best-effort): stop any in-flight desktop input and discard every screenshot frame so later actions cannot replay them. Only the actual holder affects the manager; non-holders are no-ops. Auto-sent at agent_end/session_shutdown; keeps Computer Use enabled. Use before switching tasks.',
    object({}),
    async (_params, state, signal) =>
      textResult('computer_release', await send('release', {}, state, signal)),
  );
}
