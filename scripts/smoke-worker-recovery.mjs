// Explicit real-account integration smoke; invoke with --run-luna to opt in.
// Every transcript and artifact lives under .local/recovery-smoke-workspace.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime } from '../lib/agent.mjs';
import { createStore } from '../lib/store.mjs';

if (!process.argv.includes('--run-luna')) {
  console.log('Test réel facultatif : node scripts/smoke-worker-recovery.mjs --run-luna');
  process.exit(0);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = resolve(root, '.local', 'recovery-smoke-workspace');
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const directory = join(workspaceRoot, runId);
const cwd = join(directory, 'project');
const sessionDir = join(directory, 'sessions');
const artifactsDir = join(directory, 'session-artifacts');
const model = 'openai-codex/gpt-5.6-luna';
const parentMarker = `PRIME_RECOVERY_PARENT_${randomUUID().replaceAll('-', '')}`;
const childToken = randomUUID();
const cancelToken = randomUUID();
const childResultFile = join(cwd, 'child-result.json');
const cancelStartedFile = join(cwd, 'cancel-started.json');
const cancelCompletedFile = join(cwd, 'cancel-completed.txt');
const resultFile = join(directory, 'report.json');
const report = {
  at: new Date().toISOString(),
  model,
  thinking: 'low',
  passed: false,
  isolatedDirectory: directory,
  checks: [],
  phases: [],
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const safeError = (error) =>
  String(error?.message || error || '')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/gi, '[secret masqué]')
    .slice(0, 2000);
const py = (value) => JSON.stringify(String(value));
const inside = (path) => resolve(path).startsWith(resolve(directory) + sep);
const processExists = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};
async function within(promise, timeout, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Délai dépassé : ${description}`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(check, timeout, description) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`Délai dépassé : ${description}`);
}
async function jsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}
async function findChildDisplay(path = artifactsDir, depth = 0) {
  if (!inside(path) || depth > 4) return null;
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (entries.some((entry) => entry.name === 'rlm-subagent.json')) {
    const display = await jsonIfPresent(join(path, 'rlm-subagent.json'));
    if (display?.sessionName === 'recovery-child') return display;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const display = await findChildDisplay(join(path, entry.name), depth + 1);
    if (display) return display;
  }
  return null;
}
async function assertChildHasNotFailed() {
  const display = await findChildDisplay();
  if (!display?.sessionFile || !inside(display.sessionFile)) return;
  const content = await readFile(display.sessionFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const entries = content.split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    } // A worker may currently be appending the final line.
  });
  const lastAssistant = entries.findLast((entry) => entry.message?.role === 'assistant')?.message;
  if (['aborted', 'error'].includes(lastAssistant?.stopReason))
    throw new Error(
      `Le sous-agent a échoué après l'admission : ${safeError(lastAssistant.errorMessage || lastAssistant.stopReason)}`,
    );
}
const toolText = (events) =>
  events
    .filter((event) => event.kind === 'tool_end' && !event.isError)
    .map((event) => JSON.stringify(event.result))
    .join('\n');
const phaseSummary = (name, startedAt, result, events) => ({
  name,
  status: result.status,
  durationMs: Date.now() - startedAt,
  sessionId: result.sessionId,
  tools: events
    .filter((event) => event.kind === 'tool_end')
    .map((event) => ({ name: event.name, isError: !!event.isError })),
  ...(result.error ? { error: safeError(result.error) } : {}),
});

await Promise.all([mkdir(cwd, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
const runtime = createAgentRuntime({ sessionDir });
const store = createStore({ sessionDir, dataDir: join(directory, 'metadata') });
let handle;
async function turn(name, message, previous) {
  const events = [];
  const startedAt = Date.now();
  console.log(JSON.stringify({ phase: name, status: 'starting', model }));
  handle = await within(
    runtime.start({
      cwd,
      model,
      thinking: 'low',
      message,
      ...(previous ? { sessionId: previous.id, sessionFile: previous.file } : {}),
      onEvent: (event) => events.push(event),
    }),
    120000,
    `démarrage de ${name}`,
  );
  const result = await within(handle.done, 180000, name);
  report.phases.push(phaseSummary(name, startedAt, result, events));
  console.log(JSON.stringify({ phase: name, status: result.status, sessionId: result.sessionId }));
  assert.equal(result.status, 'completed', `${name} : ${safeError(result.error || result.status)}`);
  return { result, events };
}

try {
  const childCode = [
    'from pathlib import Path',
    'import json, os, subprocess, sys',
    "assert os.environ.get('PRIME_GUI_SILENT') == '1'",
    "assert getattr(subprocess.Popen, '_prime_gui_hidden', False), 'hidden process patch missing'",
    "probe = subprocess.run([sys.executable, '-c', \"print('PRIME_CHILD_SUBPROCESS_OK')\"], capture_output=True, text=True, check=True)",
    "assert probe.stdout.strip() == 'PRIME_CHILD_SUBPROCESS_OK'",
    `Path(${py(childResultFile)}).write_text(json.dumps({'token': ${py(childToken)}, 'silent': True, 'subprocess': probe.stdout.strip()}), encoding='utf8')`,
    "print('PRIME_RECOVERY_CHILD_OK')",
  ].join('\n');
  const childPrompt = `Test technique borné. Ne délègue pas. N'utilise aucun fichier hormis le fichier de résultat explicitement indiqué. Exécute exactement le code Python ci-dessous dans un appel ipython, puis réponds seulement PRIME_RECOVERY_CHILD_OK. Ne contacte pas le parent : le fichier est le résultat convenu.\n${childCode}`;
  const admissionCode = [
    `recovery_parent_marker = ${py(parentMarker)}`,
    `recovery_child = await rlm.spawn(${py(childPrompt)}, name='recovery-child', model=${py(model)}, thinking='low')`,
    "print('PRIME_RECOVERY_ADMITTED', recovery_child.name)",
  ].join('\n');
  const admission = await turn(
    'delegate-child',
    `Test technique isolé. Utilise un seul appel ipython pour exécuter exactement ce code. rlm renvoie un handle d'admission, pas la réponse : termine ton tour après l'admission, sans attendre ni consulter le fichier de l'enfant et sans le créer toi-même. Ne lance aucun autre enfant. Réponds uniquement PRIME_RECOVERY_ADMITTED. Le marqueur de contexte à conserver est ${parentMarker}.\n${admissionCode}`,
  );
  assert.ok(
    toolText(admission.events).includes('PRIME_RECOVERY_ADMITTED'),
    'Admission RLM non confirmée par un outil',
  );
  const firstHistory = await store.history(admission.result.sessionId);
  assert.ok(inside(firstHistory.file), 'Le transcript parent doit être isolé');
  report.parentSessionId = firstHistory.id;
  const childResult = await until(
    async () => {
      await assertChildHasNotFailed();
      const value = await jsonIfPresent(childResultFile);
      return value?.token === childToken ? value : null;
    },
    180000,
    'résultat du sous-agent Luna',
  );
  assert.equal(childResult.silent, true);
  assert.equal(childResult.subprocess, 'PRIME_CHILD_SUBPROCESS_OK');
  const display = await until(
    async () => {
      const value = await findChildDisplay();
      return value?.status === 'completed' ? value : null;
    },
    30000,
    'transcript terminé du sous-agent',
  );
  assert.ok(inside(display.sessionFile), 'Le transcript enfant doit être isolé');
  const childEntries = (await readFile(display.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(
    childEntries.some(
      (entry) =>
        entry.type === 'message' &&
        entry.message?.role === 'assistant' &&
        entry.message?.model === 'gpt-5.6-luna',
    ),
    'Le sous-agent doit utiliser Luna',
  );
  assert.ok(
    childEntries.some(
      (entry) =>
        entry.message?.role === 'toolResult' &&
        JSON.stringify(entry.message.content).includes('PRIME_RECOVERY_CHILD_OK'),
    ),
    'L’outil doit réellement avoir été exécuté par le sous-agent',
  );
  report.checks.push(
    'Parent Luna : admission RLM, sous-agent Luna low, résultat attendu et sous-processus Python caché',
  );

  const resume = await turn(
    'resume-with-tool',
    `Reprends ce même test. Retrouve dans notre historique le marqueur commençant par PRIME_RECOVERY_PARENT_. Exécute un appel ipython qui importe pathlib et json, lit uniquement ${py(childResultFile)}, vérifie le token ${py(childToken)}, puis vérifie que la variable Python recovery_parent_marker déjà sauvegardée vaut exactement le marqueur retrouvé dans l'historique. Ne réassigne pas cette variable et ne recrée pas l'enfant. Affiche recovery_parent_marker et PRIME_RECOVERY_RESUME_TOOL_OK. Termine par PRIME_RECOVERY_RESUME_TOOL_OK.`,
    firstHistory,
  );
  assert.equal(resume.result.sessionId, firstHistory.id);
  assert.ok(
    toolText(resume.events).includes(parentMarker),
    'Le marqueur historique et l’état Python doivent être repris',
  );
  assert.ok(
    toolText(resume.events).includes('PRIME_RECOVERY_RESUME_TOOL_OK'),
    'La reprise doit exécuter un outil',
  );
  const resumedHistory = await store.history(firstHistory.id);
  const resumedIds = new Set(resumedHistory.messages.map((message) => message.id));
  assert.ok(
    firstHistory.messages.every((message) => resumedIds.has(message.id)),
    'La branche native précédente doit être conservée',
  );
  assert.ok(
    resumedHistory.messages.length > firstHistory.messages.length,
    'La reprise doit enrichir le transcript',
  );
  report.checks.push(
    'Reprise du même fichier natif avec historique intact et exécution d’un outil utilisant l’état Python restauré',
  );

  const cancelEvents = [];
  const cancelStartedAt = Date.now();
  const cancelCode = [
    'from pathlib import Path',
    'import asyncio, json, os',
    `Path(${py(cancelStartedFile)}).write_text(json.dumps({'token': ${py(cancelToken)}, 'kernelPid': os.getpid()}), encoding='utf8')`,
    'await asyncio.sleep(90)',
    `Path(${py(cancelCompletedFile)}).write_text('UNEXPECTED_COMPLETION', encoding='utf8')`,
  ].join('\n');
  console.log(JSON.stringify({ phase: 'cancel-running-tool', status: 'starting', model }));
  handle = await within(
    runtime.start({
      cwd,
      model,
      thinking: 'low',
      sessionId: resumedHistory.id,
      sessionFile: resumedHistory.file,
      message: `Test d'arrêt. Exécute exactement le code ipython ci-dessous en un seul appel, sans autre action. Il attend volontairement ; le contrôleur externe interrompra cet appel.\n${cancelCode}`,
      onEvent: (event) => cancelEvents.push(event),
    }),
    120000,
    'démarrage du test d’arrêt',
  );
  const cancelStarted = await until(
    async () => {
      const value = await jsonIfPresent(cancelStartedFile);
      return value?.token === cancelToken ? value : null;
    },
    120000,
    'démarrage effectif de l’outil à interrompre',
  );
  assert.ok(processExists(cancelStarted.kernelPid), 'Le noyau de test doit être actif avant l’arrêt');
  const stopRequestedAt = Date.now();
  const stopped = await within(handle.cancel(), 25000, 'arrêt du worker');
  const stopDurationMs = Date.now() - stopRequestedAt;
  report.phases.push({
    ...phaseSummary('cancel-running-tool', cancelStartedAt, stopped, cancelEvents),
    stopDurationMs,
  });
  assert.equal(stopped.status, 'stopped');
  await until(() => !processExists(cancelStarted.kernelPid), 15000, 'fermeture du noyau interrompu');
  const completedFile = await readFile(cancelCompletedFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(completedFile, null, 'Le code suivant l’attente ne doit pas être exécuté');
  const stoppedHistory = await store.history(firstHistory.id);
  assert.ok(
    stoppedHistory.messages.some((message) => message.text?.includes(parentMarker)),
    'L’historique doit rester accessible après l’arrêt',
  );
  report.checks.push(
    'Arrêt pendant un outil actif, noyau fermé, suite du code non exécutée et historique conservé',
  );
  report.passed = true;
} catch (error) {
  report.error = safeError(error);
  process.exitCode = 1;
} finally {
  try {
    await within(runtime.close(), 30000, 'fermeture du runtime privé');
  } catch (error) {
    report.passed = false;
    report.cleanupError = safeError(error);
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(resultFile, JSON.stringify(report, null, 2));
  await writeFile(join(workspaceRoot, 'latest-report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        report: resultFile,
        checks: report.checks,
        ...(report.error ? { error: report.error } : {}),
      },
      null,
      2,
    ),
  );
}
