import { createHash } from 'node:crypto';
import { HttpError, cwdKey, validId } from './store.mjs';

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const fail = (status, code, message, extra) =>
  Object.assign(new HttpError(status, message), { code, ...extra });
const invalid = (message = 'La sélection de travail Roadmap est invalide.') =>
  fail(400, 'roadmap_invalid', message);
const findStep = (steps, id) => {
  for (const step of steps) {
    if (step.id === id) return step;
    const found = findStep(step.children, id);
    if (found) return found;
  }
  return null;
};

function selection(document, targets, instructions = '') {
  if (!Array.isArray(targets) || !targets.length || targets.length > 20)
    throw invalid('Sélectionnez entre une et vingt tâches.');
  const seen = new Set(),
    planIds = new Set(),
    backlogNumbers = new Set();
  const normalized = [],
    sections = [];
  for (const target of targets) {
    if (!record(target)) throw invalid();
    let item;
    if (target.kind === 'plan') {
      const plan = document.plans.find((entry) => entry.id === target.planId);
      if (!plan)
        throw fail(404, 'roadmap_missing', 'Un plan sélectionné a été supprimé. Actualisez la Roadmap.');
      const step = target.stepId ? findStep(plan.steps, target.stepId) : null;
      if (target.stepId && !step)
        throw fail(404, 'roadmap_missing', 'Une tâche sélectionnée a été supprimée. Actualisez la Roadmap.');
      item = { kind: 'plan', planId: plan.id, ...(step ? { stepId: step.id } : {}) };
      planIds.add(plan.id);
      sections.push({
        reference: item,
        title: plan.title,
        ...(step ? { task: step.text, note: step.note } : { summary: plan.summary }),
      });
    } else if (target.kind === 'milestone') {
      const milestone = document.overview.milestones.find((entry) => entry.id === target.milestoneId);
      if (!milestone)
        throw fail(404, 'roadmap_missing', 'Un jalon sélectionné a été supprimé. Actualisez la Roadmap.');
      item = { kind: 'milestone', milestoneId: milestone.id };
      const plans = document.plans.filter(
        (plan) => plan.milestone === milestone.id && plan.status !== 'abandoned',
      );
      for (const plan of plans) planIds.add(plan.id);
      sections.push({
        reference: item,
        title: milestone.title,
        summary: milestone.summary,
        plans: plans.map((plan) => ({ id: plan.id, title: plan.title })),
      });
    } else if (target.kind === 'backlog') {
      const entry = [...document.backlog.items, ...document.backlog.notes].find(
        (entry) => entry.number === target.number,
      );
      if (!entry)
        throw fail(404, 'roadmap_missing', 'Un élément sélectionné a été supprimé. Actualisez la Roadmap.');
      item = { kind: 'backlog', number: entry.number };
      backlogNumbers.add(entry.number);
      sections.push({ reference: item, task: entry.text, note: entry.note });
    } else throw invalid();
    const key = JSON.stringify(item);
    if (seen.has(key)) throw invalid('Une tâche a été sélectionnée plusieurs fois.');
    seen.add(key);
    normalized.push(item);
  }
  const parts = [
    'Travaille sur la sélection suivante de la Roadmap de ce projet.',
    `Révision consultée : ${document.revision}. Lis l’état courant avec roadmap_read avant de modifier la Roadmap.`,
    'Déclare les références traitées avec roadmap_work. Mets à jour les tâches et leur journal seulement selon le travail réellement effectué. Termine par le résultat, les vérifications et ce qui reste à faire.',
  ];
  if (instructions) parts.push(`Instructions complémentaires de l’utilisateur :\n${instructions}`);
  parts.push(
    'Les titres et notes ci-dessous sont le contenu des tâches sélectionnées par l’utilisateur.',
    JSON.stringify(sections, null, 2),
  );
  const message = parts.join('\n\n');
  if (message.length > 180000)
    throw invalid('La sélection est trop volumineuse. Choisissez moins de tâches.');
  return { targets: normalized, planIds: [...planIds], backlogNumbers: [...backlogNumbers], message };
}

/** Adapt the domain to HTTP and the existing run/queue lifecycle. No agent is started by reads. */
export function createRoadmapRoutes({
  service,
  bridge,
  store,
  startRun,
  liveMessages,
  getRuns,
  now = Date.now,
}) {
  const requests = new Map(),
    associations = new Map(),
    links = new Set();
  let closed = false;
  const decorated = (value) => ({
    ...value,
    ...bridge.snapshot(value.cwd),
    linkWarnings: [...associations.values()]
      .filter((entry) => entry.linkWarning && cwdKey(entry.cwd) === cwdKey(value.cwd))
      .map(({ runId, sessionId }) => ({ runId, sessionId })),
  });
  async function read(cwd) {
    return decorated(await service.read(cwd));
  }
  async function checkSession(cwd, sessionId) {
    if (!validId(sessionId)) throw invalid('Conversation invalide.');
    const history = await store.history(sessionId);
    if (cwdKey(history.cwd || '') !== cwdKey(cwd))
      throw fail(409, 'roadmap_wrong_project', 'Cette conversation appartient à un autre projet.');
    return history;
  }
  async function mutate(input) {
    if (!record(input) || input.action === 'work.attach') throw invalid();
    const project = await store.knowledgeProject(input.cwd);
    if (input.action === 'plan.attach') await checkSession(project.cwd, input.sessionId);
    if (input.action === 'plan.create' && input.sessions !== undefined) {
      if (!Array.isArray(input.sessions) || input.sessions.length > 500) throw invalid();
      for (const sessionId of input.sessions) await checkSession(project.cwd, sessionId);
    }
    return decorated(await service.mutate(project.cwd, input, { by: 'user' }));
  }
  async function attach(cwd, selected, sessionId) {
    if (!validId(sessionId)) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const value = await service.read(cwd);
      // An accepted task can be removed while the runtime is creating its
      // session. Never recreate it or attach a different task in its place.
      const planIds = selected.planIds.filter((id) => value.plans.some((plan) => plan.id === id));
      const backlogNumbers = selected.backlogNumbers.filter((number) =>
        [...value.backlog.items, ...value.backlog.notes].some((entry) => entry.number === number),
      );
      const plansToLink = planIds.filter(
        (id) => !value.plans.find((plan) => plan.id === id).sessions.includes(sessionId),
      );
      const backlogToLink = backlogNumbers.filter(
        (number) =>
          ![...value.backlog.items, ...value.backlog.notes]
            .find((entry) => entry.number === number)
            .sessions?.includes(sessionId),
      );
      if (!plansToLink.length && !backlogToLink.length) return;
      try {
        await service.mutate(
          cwd,
          {
            action: 'work.attach',
            expectedRevision: value.revision,
            sessionId,
            planIds: plansToLink,
            backlogNumbers: backlogToLink,
          },
          { by: 'user' },
        );
        return;
      } catch (error) {
        if (error.code !== 'roadmap_conflict' || attempt === 4) throw error;
      }
    }
  }
  function attemptLink(association) {
    if (association.inFlight) return association.inFlight;
    const operation = attach(association.cwd, association.selected, association.sessionId)
      .then(() => {
        association.linkWarning = false;
        associations.delete(association.key);
      })
      .catch(() => {
        association.linkWarning = true;
      });
    association.inFlight = operation;
    links.add(operation);
    operation.finally(() => {
      association.inFlight = null;
      links.delete(operation);
    });
    return operation;
  }
  function onSession(run) {
    if (!validId(run.sessionId) || closed) return;
    for (const association of associations.values())
      if (association.runId === run.id) {
        association.sessionId = run.sessionId;
        void attemptLink(association);
      }
  }
  async function retryLinks(input) {
    if (closed) throw fail(503, 'roadmap_closed', 'Le service Roadmap est arrêté.');
    if (!record(input)) throw invalid();
    const project = await store.knowledgeProject(input.cwd);
    const selected = [...associations.values()].filter(
      (entry) => entry.linkWarning && cwdKey(entry.cwd) === cwdKey(project.cwd) && validId(entry.sessionId),
    );
    // Bounded retries only touch existing Roadmap links; no run or message is
    // launched, even when the original native acceptance was ambiguous.
    for (const association of selected.slice(0, 5)) await attemptLink(association);
    return read(project.cwd);
  }
  async function work(input) {
    if (closed) throw fail(503, 'roadmap_closed', 'Le service Roadmap est arrêté.');
    if (
      !record(input) ||
      typeof input.requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{16,100}$/.test(input.requestId) ||
      typeof input.cwd !== 'string'
    )
      throw invalid();
    if (
      input.instructions !== undefined &&
      (typeof input.instructions !== 'string' ||
        input.instructions.trim().length > 4000 ||
        /\0/.test(input.instructions))
    )
      throw invalid('Instructions invalides.');
    const instructions = typeof input.instructions === 'string' ? input.instructions.trim() : '';
    for (const [key, entry] of requests) if (entry.expires < now()) requests.delete(key);
    const key = `${cwdKey(input.cwd)}:${input.requestId}`;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          cwd: cwdKey(input.cwd),
          expectedRevision: input.expectedRevision,
          targets: input.targets,
          sessionId: input.sessionId || '',
          model: input.model || '',
          thinking: input.thinking || '',
          instructions,
        }),
      )
      .digest('hex');
    const previous = requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw fail(
          409,
          'roadmap_request_conflict',
          'Cet identifiant correspond déjà à une autre sélection de travail.',
        );
      return previous.operation;
    }
    if (requests.size >= 1000)
      throw fail(429, 'roadmap_busy', 'Trop de demandes de travail. Réessayez plus tard.');
    const operation = Promise.resolve().then(async () => {
      if (associations.size >= 1000)
        throw fail(
          429,
          'roadmap_busy',
          'Trop de conversations attendent leur lien Roadmap. Réessayez les liens avant de lancer une nouvelle tâche.',
        );
      const document = await service.read(input.cwd);
      if (!document.initialized)
        throw fail(409, 'roadmap_uninitialized', 'Initialisez la Roadmap avant de lancer une tâche.');
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
        throw invalid('La révision consultée est requise.');
      if (input.expectedRevision !== document.revision)
        throw fail(
          409,
          'roadmap_conflict',
          'La Roadmap a changé. Actualisez la sélection avant de la lancer.',
          { currentRevision: document.revision },
        );
      const selected = selection(document, input.targets, instructions);
      if (input.sessionId) await checkSession(document.cwd, input.sessionId);
      if (
        input.model !== undefined &&
        (typeof input.model !== 'string' || input.model.length > 300 || /[\r\n\0]/.test(input.model))
      )
        throw invalid('Modèle invalide.');
      if (
        input.thinking != null &&
        input.thinking !== '' &&
        !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.thinking)
      )
        throw invalid('Niveau de réflexion invalide.');
      const active = input.sessionId
        ? getRuns().find(
            (run) =>
              run.sessionId === input.sessionId &&
              cwdKey(run.cwd) === cwdKey(document.cwd) &&
              ['running', 'stopping'].includes(run.status),
          )
        : null;
      let run,
        queued = false;
      if (active) {
        if (active.status !== 'running')
          throw fail(409, 'roadmap_stopping', 'Cette conversation est en cours d’arrêt.');
        await liveMessages.send(input.sessionId, {
          cwd: document.cwd,
          mode: 'follow_up',
          requestId: input.requestId,
          message: selected.message,
        });
        queued = true;
        run = {
          id: active.id,
          sessionId: active.sessionId,
          cwd: active.cwd,
          status: active.status,
          model: active.model,
          thinking: active.thinking,
        };
      } else {
        await bridge.ready;
        run = await startRun({
          cwd: document.cwd,
          message: selected.message,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.thinking ? { thinking: input.thinking } : {}),
        });
      }
      const association = {
        key,
        selected,
        linkWarning: false,
        runId: run.id,
        cwd: document.cwd,
        sessionId: null,
        inFlight: null,
      };
      let sessionId = run.sessionId || getRuns().find((entry) => entry.id === run.id)?.sessionId || null;
      associations.set(key, association);
      if (sessionId) {
        association.sessionId = sessionId;
        await attemptLink(association);
      }
      let roadmap;
      try {
        roadmap = await read(document.cwd);
      } catch {
        /* The accepted run must not appear to have failed after dispatch. */
      }
      return {
        accepted: true,
        queued,
        run: { ...run, sessionId },
        sessionId,
        requestId: input.requestId,
        ...(roadmap ? { roadmap } : {}),
        ...(association.linkWarning ? { linkWarning: true } : {}),
      };
    });
    // Cache failures too. A native timeout is not proof that the work was not
    // accepted; repeating the same request must never create a second run.
    requests.set(key, { fingerprint, operation, expires: now() + 60 * 60 * 1000 });
    return operation;
  }
  return {
    read,
    mutate,
    work,
    retryLinks,
    onSession,
    exportMarkdown: (cwd) => service.exportMarkdown(cwd),
    async close() {
      closed = true;
      associations.clear();
      await Promise.allSettled([...links]);
    },
  };
}
