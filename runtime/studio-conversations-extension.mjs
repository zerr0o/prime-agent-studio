import { Type } from 'typebox';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';

// Uses the existing Studio native extension capability; no public API token.
export default function studioConversations(pi) {
  if (!process.env.PRIME_STUDIO_ROADMAP_CONFIG) return;
  const config = JSON.parse(process.env.PRIME_STUDIO_ROADMAP_CONFIG);
  if (typeof config.socketPath !== 'string' || typeof config.token !== 'string') return;
  const states = new Map();
  function stateFor(ctx) {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!states.has(sessionId))
      states.set(sessionId, {
        identity: { cwd: ctx.cwd, sessionId, sessionFile: ctx.sessionManager.getSessionFile() },
        epoch: randomUUID(),
        ended: false,
      });
    return states.get(sessionId);
  }
  function call(action, params, state, signal) {
    return new Promise((resolve, reject) => {
      let req,
        settled = false;
      const unknown = () =>
        Object.assign(
          new Error(
            'Delivery UNKNOWN; inspect the target and reconcile requestId. Do not automatically retry.',
          ),
          { code: 'delivery_uncertain', delivery: 'UNKNOWN' },
        );
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        if (error) {
          req?.destroy();
          reject(error);
        } else resolve(value);
      };
      const cancel = () => finish(unknown());
      if (signal?.aborted) return finish(unknown());
      const payload = JSON.stringify({ action, params, identity: state.identity, epoch: state.epoch });
      if (Buffer.byteLength(payload) > 128 * 1024)
        return finish(
          Object.assign(new Error('Conversation request exceeds 128 KiB.'), { code: 'conversation_invalid' }),
        );
      req = request(
        {
          socketPath: config.socketPath,
          method: 'POST',
          path: '/',
          agent: false,
          headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        },
        (res) => {
          const chunks = [];
          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 128 * 1024) return finish(unknown());
            chunks.push(chunk);
          });
          res.on('error', () => finish(unknown()));
          res.on('aborted', () => finish(unknown()));
          res.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (res.statusCode !== 200) {
                if (res.statusCode >= 500 || value.code === 'delivery_uncertain') return finish(unknown());
                return finish(
                  Object.assign(new Error(value.error || 'Conversation request denied.'), {
                    code: value.code,
                  }),
                );
              }
              finish(null, value);
            } catch {
              finish(unknown());
            }
          });
        },
      );
      req.setTimeout(10000, cancel);
      req.on('error', cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      req.end(payload);
    });
  }
  const end = async (_event, ctx) => {
    const state = stateFor(ctx);
    state.ended = true;
    await call('conversations.end', {}, state).catch(() => {});
  };
  pi.on('agent_start', (_event, ctx) => {
    const previous = states.get(ctx.sessionManager.getSessionId());
    if (previous) {
      previous.ended = true;
      void call('conversations.end', {}, previous).catch(() => {});
    }
    states.delete(ctx.sessionManager.getSessionId());
    stateFor(ctx);
  });
  pi.on('agent_end', end);
  pi.on('session_shutdown', end);
  const id = Type.String({ minLength: 1, maxLength: 200 });
  const optional = Type.Optional;
  const page = {
    limit: optional(Type.Integer({ minimum: 1, maximum: 50 })),
    offset: optional(Type.Integer({ minimum: 0 })),
  };
  const message = Type.String({ minLength: 1, maxLength: 64000 });
  const input = { requestId: id, message, model: optional(id), thinking: optional(id) };
  const schemas = {
    projects: page,
    list: { projectId: id, ...page },
    inspect: { sessionId: id },
    history: { sessionId: id, ...page },
    create: { projectId: id, ...input, name: optional(id) },
    continue: { sessionId: id, ...input },
    send: {
      sessionId: id,
      requestId: id,
      message,
      mode: optional(Type.Union([Type.Literal('follow_up'), Type.Literal('steer')])),
    },
    interrupt: { sessionId: id, expectedRunId: id },
  };
  for (const [operation, schema] of Object.entries(schemas))
    pi.registerTool({
      name: `conversations_${operation}`,
      label: `Conversations: ${operation}`,
      description:
        `Owner-wide ordinary Studio conversations: ${operation}. Only registered projects and saved conversation IDs. ` +
        'Chats are independent, not children. Inspect is passive; saved does not mean native idle. History is bounded. ' +
        'Send defaults to follow_up; steer is explicit. Accepted is not completion. Reuse requestId only to reconcile; never replay UNKNOWN automatically. ' +
        'Interrupt requires the exact runId from inspect and can discard queued input. No deletion or automatic approvals.',
      parameters: Type.Object(schema, { additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (_id, params, signal, _update, ctx) => {
        const state = stateFor(ctx);
        if (state.ended) throw new Error('This agent turn has ended.');
        const value = await call('conversations', { operation, arguments: params }, state, signal);
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: { operation } };
      },
    });
}
