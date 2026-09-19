// Real parent/child kernels and message routing; only the model is a local fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime } from '../lib/agent.mjs';

const root = await mkdtemp(join(tmpdir(), 'prime-kernel-messages-'));
const cwd = join(root, 'projet é'),
  agentHome = join(root, 'agent'),
  sessionDir = join(agentHome, 'sessions');
await Promise.all([cwd, sessionDir].map((path) => mkdir(path, { recursive: true })));
const nonce = randomUUID(),
  issued = new Set(),
  requests = [],
  events = [];
let phase = 1,
  runtime,
  sessionId,
  sessionFile;
const token = (direction) => `${direction}:${nonce}:${phase}`;
const provider = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw),
      role = body.model;
    requests.push({ phase, role, messages: body.messages });
    const key = `${phase}:${role}`;
    let code;
    if (!issued.has(key)) {
      issued.add(key);
      code =
        role === 'parent'
          ? [
              'import rlm, agent_message, json, sys',
              'assert callable(agent_message.send)',
              'print("PARENT_IMPORT_OK", sys.executable)',
              `child = await rlm.spawn("MESSENGER_TASK_${phase}", model="fixture/child", thinking="low", name="messenger-${phase}")`,
              `receipt = await agent_message.send(${JSON.stringify(token('PARENT_TO_CHILD'))}, receiver_role="child", receiver_name="messenger-${phase}")`,
              'assert receipt["deliveryStatus"] in ("queued", "delivered"), receipt',
              'print("PARENT_SEND_OK", json.dumps(receipt))',
            ].join('\n')
          : [
              'import agent_message, json, sys',
              'assert callable(agent_message.send)',
              'print("CHILD_IMPORT_OK", sys.executable)',
              `receipt = await agent_message.send(${JSON.stringify(token('CHILD_TO_PARENT'))}, receiver_role="parent")`,
              'assert receipt["deliveryStatus"] in ("queued", "delivered"), receipt',
              'print("CHILD_SEND_OK", json.dumps(receipt))',
            ].join('\n');
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: `message-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: role,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    frame({ role: 'assistant' });
    if (code) {
      frame({
        tool_calls: [
          {
            index: 0,
            id: `tool_${phase}_${role}`,
            type: 'function',
            function: { name: 'ipython', arguments: JSON.stringify({ code }) },
          },
        ],
      });
      frame({}, 'tool_calls');
    } else {
      frame({ content: 'Messagerie vérifiée.' });
      frame({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
await writeFile(join(agentHome, 'auth.json'), '{}');
await writeFile(
  join(agentHome, 'models.json'),
  JSON.stringify({
    providers: {
      fixture: {
        api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        apiKey: 'fixture-only',
        models: ['parent', 'child'].map((id) => ({
          id,
          name: id,
          reasoning: true,
          input: ['text'],
          contextWindow: 131072,
          maxTokens: 4096,
        })),
      },
    },
  }),
);
await writeFile(
  join(agentHome, 'settings.json'),
  JSON.stringify({
    defaultProvider: 'fixture',
    defaultModel: 'parent',
    autoRefine: { enabled: false },
    compaction: { enabled: false },
    retry: { enabled: false },
    telemetry: { enabled: false, noticeShown: true },
  }),
);
async function histories() {
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.jsonl')) {
        const entries = (await readFile(path, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const header = entries.find((entry) => entry.type === 'session');
        if (header) result.push({ path, id: header.id, entries });
      }
    }
  }
  await walk(sessionDir);
  await walk(join(agentHome, 'session-artifacts'));
  return result;
}
try {
  for (phase = 1; phase <= 2; phase++) {
    runtime = createAgentRuntime({
      agentHome,
      sessionDir,
      env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' },
    });
    const handle = await runtime.start({
      cwd,
      message: `ROOT_MESSAGING_${phase}`,
      model: 'fixture/parent',
      ...(sessionId ? { sessionId, sessionFile } : {}),
      onEvent: (event) => events.push(event),
    });
    let timer;
    const done = await Promise.race([
      handle.done,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Messagerie native bloquée : ${JSON.stringify(events.slice(-5))}`)),
          120000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(done.status, 'completed', JSON.stringify(done));
    if (sessionId) assert.equal(handle.sessionId, sessionId, 'Reprise du même parent natif');
    sessionId = handle.sessionId;
    const saved = await histories(),
      parent = saved.find((history) => history.id === sessionId);
    assert.ok(parent);
    sessionFile = parent.path;
    const incoming = (history, message) =>
      history.entries
        .map((entry) => (entry.type === 'custom_message' ? entry : entry.message))
        .find(
          (entry) =>
            entry?.customType === 'agent_message' &&
            entry.details?.message === message &&
            !entry.details.id.startsWith('spawn:'),
        );
    const received = incoming(parent, token('CHILD_TO_PARENT'));
    assert.ok(
      received,
      'Le parent doit enregistrer le message explicite de l’enfant, pas sa notification de fin',
    );
    const child = saved.find((history) => history.id === received.details.from.sessionId);
    assert.ok(child, 'Le message reçu doit identifier le vrai enfant');
    assert.ok(
      incoming(child, token('PARENT_TO_CHILD')),
      'Le message du parent doit atteindre le kernel enfant',
    );
    const toolText = (history) =>
      history.entries
        .filter((entry) => entry.message?.role === 'toolResult')
        .map((entry) => JSON.stringify(entry.message))
        .join('\n');
    assert.match(toolText(parent), /PARENT_IMPORT_OK/);
    assert.match(toolText(parent), /PARENT_SEND_OK/);
    assert.match(toolText(child), /CHILD_IMPORT_OK/);
    assert.match(toolText(child), /CHILD_SEND_OK/);
    for (const role of ['parent', 'child']) {
      const wanted = token(role === 'parent' ? 'CHILD_TO_PARENT' : 'PARENT_TO_CHILD');
      assert.ok(
        requests.some(
          (request) =>
            request.phase === phase &&
            request.role === role &&
            request.messages.some(
              (message) => message.role === 'user' && JSON.stringify(message.content).includes(wanted),
            ),
        ),
        'La livraison doit aussi atteindre le contexte du modèle destinataire',
      );
    }
    // Force actual fresh Python kernels for the resume test, not just another turn.
    await runtime.close();
    runtime = null;
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          'Imports réels de agent_message et send dans les deux kernels',
          'Messages explicites enfant → parent et parent → enfant avec jetons uniques',
          'Réception dans les historiques natifs et les contextes des modèles destinataires',
          'Même validation après arrêt du moteur et reprise du même parent dans de nouveaux kernels',
        ],
        root,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  await writeFile(join(root, 'diagnostic.json'), JSON.stringify({ events, requests }, null, 2));
  console.error(`Diagnostic : ${root}`);
  process.exitCode = 1;
} finally {
  await runtime?.close();
  await new Promise((resolve) => provider.close(resolve));
}
