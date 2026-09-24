import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from './store.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_STEPS = 2000;
const PLAN_STATUSES = new Set(['active', 'done', 'paused', 'abandoned']);
const MILESTONE_STATUSES = new Set(['planned', 'active', 'done']);
const queues = new Map();
const own = (value, key) => Object.hasOwn(value, key);
const id = (prefix) => `${prefix}-${randomUUID()}`;
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const error = (status, code, message, extra) =>
  Object.assign(new HttpError(status, message), { code, ...extra });
const invalid = (message = 'La modification de la Roadmap est invalide.') =>
  error(400, 'roadmap_invalid', message);
const missing = (message) => error(404, 'roadmap_missing', message);

function text(value, label, max = 8000, optional = false) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value) || (!optional && !value.trim()))
    throw invalid(`${label} invalide (maximum ${max} caractères).`);
  return value.trim();
}

function identifier(value, label = 'Identifiant') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value))
    throw invalid(`${label} invalide.`);
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw invalid(`${label} invalide.`);
  return value;
}

function boolean(value) {
  if (typeof value !== 'boolean') throw invalid('La case doit être cochée ou décochée explicitement.');
  return value;
}

function list(value, label, max = 2000) {
  if (!Array.isArray(value) || value.length > max)
    throw invalid(`${label} invalide (maximum ${max} éléments).`);
  return value;
}

function status(value, values) {
  if (!values.has(value)) throw invalid('Statut de Roadmap invalide.');
  return value;
}

function who(actor = {}) {
  if (!isObject(actor) || !['user', 'agent'].includes(actor.by ?? 'user')) throw invalid('Auteur invalide.');
  const result = { by: actor.by ?? 'user' };
  for (const key of ['sessionId', 'rootSessionId'])
    if (actor[key] !== undefined) result[key] = identifier(actor[key], 'Session');
  if (actor.name !== undefined) result.name = text(actor.name, 'Nom', 200, true);
  return result;
}

function progress(steps) {
  let done = 0;
  let total = 0;
  for (const step of steps) {
    if (step.children.length) {
      const value = progress(step.children);
      total += value.total;
      done += value.done;
    } else {
      total++;
      if (step.done) done++;
    }
  }
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

function aggregate(plans) {
  const value = plans.reduce(
    (acc, plan) => ({ done: acc.done + plan.progress.done, total: acc.total + plan.progress.total }),
    { done: 0, total: 0 },
  );
  return { ...value, percent: value.total ? Math.round((value.done / value.total) * 100) : 0 };
}

function derivedSteps(steps) {
  return steps.map((step) => {
    const children = derivedSteps(step.children);
    const value = progress(children);
    return {
      ...step,
      children,
      done: children.length ? value.done === value.total : step.done,
      partial: children.length ? value.done > 0 && value.done < value.total : false,
    };
  });
}

function empty() {
  return {
    schemaVersion: 1,
    revision: 0,
    lastEdit: null,
    overview: { vision: '', milestones: [] },
    plans: [],
    backlog: { items: [], notes: [], nextNumber: 1 },
    // Additive .pastudio import marker (v1). Older documents omit it; validation defaults to [].
    pastudioImports: [],
  };
}

function dto(project, document) {
  const plans = document.plans.map((plan) => ({
    ...plan,
    steps: derivedSteps(plan.steps),
    progress: progress(plan.steps),
  }));
  const activePlans = plans.filter((plan) => plan.status !== 'abandoned' && !plan.archived);
  const value = aggregate(activePlans);
  return {
    cwd: project.cwd,
    name: project.name,
    initialized: document.revision > 0,
    revision: document.revision,
    lastEdit: document.lastEdit,
    overview: {
      ...document.overview,
      milestones: document.overview.milestones.map((milestone) => ({
        ...milestone,
        progress: aggregate(activePlans.filter((plan) => plan.milestone === milestone.id)),
      })),
      progress: value,
    },
    plans,
    backlog: document.backlog,
    progress: value,
    pastudioImports: Array.isArray(document.pastudioImports) ? document.pastudioImports : [],
  };
}

function collectSteps(steps, map = new Map(), parent = null, depth = 1) {
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    map.set(step.id, { step, siblings: steps, index, parent, depth });
    collectSteps(step.children, map, step, depth + 1);
  }
  return map;
}

function normalizeSteps(input, { old = [], creating = false, exact = false } = {}) {
  const existing = collectSteps(old);
  const seen = new Set();
  let count = 0;
  const visit = (nodes, depth) =>
    list(nodes, 'Tâches', MAX_STEPS).map((node) => {
      if (++count > MAX_STEPS || depth > 3 || !isObject(node))
        throw invalid('Une checklist accepte trois niveaux et 2 000 tâches au maximum.');
      if (exact && (!Array.isArray(node.children) || typeof node.done !== 'boolean')) throw invalid('Une tâche enregistrée est incomplète.');
      const stepId = node.id === undefined && !exact ? id('step') : identifier(node.id, 'Tâche');
      if (seen.has(stepId)) throw invalid('Chaque tâche doit avoir un identifiant unique.');
      seen.add(stepId);
      const previous = existing.get(stepId)?.step;
      if (!creating && !exact && node.id !== undefined && !previous)
        throw invalid(
          'Une nouvelle tâche doit omettre son identifiant ; les identifiants existants restent inchangés.',
        );
      const children = visit(
        node.children === undefined && previous ? previous.children : (node.children ?? []),
        depth + 1,
      );
      return {
        id: stepId,
        text: text(node.text === undefined && previous ? previous.text : node.text, 'Texte de tâche'),
        note: text(node.note === undefined && previous ? previous.note : node.note, 'Note', 16000, true),
        done: children.length
          ? progress(children).done === progress(children).total
          : node.done === undefined && previous
            ? previous.done
            : node.done === undefined && !exact
              ? false
              : boolean(node.done),
        children,
      };
    });
  const result = visit(input, 1);
  if (!creating && !exact && [...existing.keys()].some((stepId) => !seen.has(stepId)))
    throw invalid('Une tâche existante manque. Supprimez-la explicitement avant de remplacer le plan.');
  return result;
}

function validateDocument(raw) {
  if (!isObject(raw) || raw.schemaVersion !== 1 || !isObject(raw.overview) || !isObject(raw.backlog))
    throw invalid();
  const revision = integer(raw.revision, 'Révision', 1);
  const edit = { ...who(raw.lastEdit), at: integer(raw.lastEdit?.at, 'Date', 1) };
  const milestoneIds = new Set();
  const milestones = list(raw.overview.milestones, 'Jalons', 200).map((entry) => {
    if (!isObject(entry)) throw invalid();
    const milestoneId = identifier(entry.id, 'Jalon');
    if (milestoneIds.has(milestoneId)) throw invalid();
    milestoneIds.add(milestoneId);
    return {
      id: milestoneId,
      title: text(entry.title, 'Titre', 300),
      summary: text(entry.summary, 'Résumé', 16000, true),
      status: status(entry.status, MILESTONE_STATUSES),
    };
  });
  const planIds = new Set();
  const slugs = new Set();
  const allStepIds = new Set();
  const plans = list(raw.plans, 'Plans', 200).map((entry) => {
    if (!isObject(entry)) throw invalid();
    const planId = identifier(entry.id, 'Plan');
    const slug = identifier(entry.slug, 'Nom de plan');
    if (planIds.has(planId) || slugs.has(slug) || !planId.startsWith('plan-')) throw invalid();
    planIds.add(planId);
    slugs.add(slug);
    const milestone = entry.milestone === null ? null : identifier(entry.milestone, 'Jalon');
    if (milestone !== null && !milestoneIds.has(milestone)) throw invalid();
    const steps = normalizeSteps(entry.steps, { exact: true });
    for (const stepId of collectSteps(steps).keys()) {
      if (allStepIds.has(stepId)) throw invalid('Chaque tâche du projet doit avoir son propre identifiant.');
      allStepIds.add(stepId);
    }
    const sessions = list(entry.sessions, 'Conversations', 500).map((value) => identifier(value, 'Session'));
    if (new Set(sessions).size !== sessions.length) throw invalid();
    const journalIds = new Set();
    const journal = list(entry.journal, 'Journal', 2000).map((item) => {
      if (!isObject(item)) throw invalid();
      const journalId = identifier(item.id, 'Entrée du journal');
      if (journalIds.has(journalId)) throw invalid();
      journalIds.add(journalId);
      return {
        id: journalId,
        at: integer(item.at, 'Date', 1),
        text: text(item.text, 'Entrée du journal', 16000),
        ...who(item),
      };
    });
    return {
      id: planId,
      slug,
      title: text(entry.title, 'Titre', 300),
      summary: text(entry.summary, 'Résumé', 16000, true),
      status: status(entry.status, PLAN_STATUSES),
      milestone,
      sessions,
      steps,
      journal,
      createdAt: integer(entry.createdAt, 'Date', 1),
      updatedAt: integer(entry.updatedAt, 'Date', 1),
      archived: entry.archived === undefined ? false : boolean(entry.archived),
      archivedAt:
        entry.archivedAt === undefined || entry.archivedAt === null
          ? null
          : integer(entry.archivedAt, 'Date', 1),
    };
  });
  const backlogNumbers = new Set();
  const backlogEntries = (entries, isNote) =>
    list(entries, 'Backlog', 2000).map((entry) => {
      if (!isObject(entry)) throw invalid();
      const number = integer(entry.number, 'Numéro', 1);
      if (backlogNumbers.has(number)) throw invalid();
      backlogNumbers.add(number);
      const sessions = [
        ...new Set(
          list(entry.sessions ?? [], 'Conversations', 500).map((value) => identifier(value, 'Session')),
        ),
      ];
      return {
        number,
        text: text(entry.text, 'Texte'),
        note: text(entry.note, 'Note', 16000, true),
        ...(isNote ? {} : { done: boolean(entry.done) }),
        addedAt: integer(entry.addedAt, 'Date', 1),
        ...who(entry),
        sessions,
      };
    });
  const items = backlogEntries(raw.backlog.items, false);
  const notes = backlogEntries(raw.backlog.notes, true);
  const nextNumber = integer(raw.backlog.nextNumber, 'Prochain numéro', 1);
  if ([...backlogNumbers].some((number) => number >= nextNumber)) throw invalid();
  // Additive .pastudio marker: backward compatible, preserved on every write, never overwrites other fields.
  const pastudioImports = list(raw.pastudioImports ?? [], 'Imports', 1000).map((entry) => {
    if (!isObject(entry)) throw invalid();
    const archiveId = text(entry.archiveId, 'Archive', 200);
    const payloadDigest = text(entry.payloadDigest, 'Empreinte', 128);
    if (!/^[0-9a-f]{64}$/.test(payloadDigest)) throw invalid('Empreinte invalide.');
    if (!archiveId.trim()) throw invalid('Archive invalide.');
    return {
      archiveId: archiveId.trim(),
      payloadDigest,
      importedAt: integer(entry.importedAt, 'Date', 1),
      sourceProject:
        entry.sourceProject === undefined
          ? undefined
          : {
              name: text(entry.sourceProject?.name ?? '', 'Projet', 300, true),
              cwd: text(entry.sourceProject?.cwd ?? '', 'Dossier', 4096, true),
            },
    };
  });
  const seenDigests = new Set();
  const seenArchives = new Set();
  for (const entry of pastudioImports) {
    if (seenDigests.has(entry.payloadDigest) || seenArchives.has(entry.archiveId)) throw invalid();
    seenDigests.add(entry.payloadDigest);
    seenArchives.add(entry.archiveId);
  }
  return {
    schemaVersion: 1,
    revision,
    lastEdit: edit,
    overview: { vision: text(raw.overview.vision, 'Vision', 20000, true), milestones },
    plans,
    backlog: { items, notes, nextNumber },
    pastudioImports,
  };
}

// Additive export for .pastudio coordinator: validate an archived roadmap.json without side effects.
export function validateRoadmapDocument(raw) {
  return validateDocument(raw);
}

function findPlan(document, planId) {
  identifier(planId, 'Plan');
  const plan = document.plans.find((entry) => entry.id === planId || entry.slug === planId);
  if (!plan) throw missing('Ce plan est introuvable dans le projet.');
  return plan;
}

function findStep(plan, stepId) {
  identifier(stepId, 'Tâche');
  const found = collectSteps(plan.steps).get(stepId);
  if (!found) throw missing('Cette tâche est introuvable dans le plan.');
  return found;
}

function findMilestone(document, milestoneId) {
  identifier(milestoneId, 'Jalon');
  const found = document.overview.milestones.find((entry) => entry.id === milestoneId);
  if (!found) throw missing('Ce jalon est introuvable dans le projet.');
  return found;
}

function findBacklog(document, number) {
  integer(number, 'Numéro', 1);
  for (const entries of [document.backlog.items, document.backlog.notes]) {
    const index = entries.findIndex((entry) => entry.number === number);
    if (index !== -1)
      return { entry: entries[index], entries, index, isNote: entries === document.backlog.notes };
  }
  throw missing('Cet élément est introuvable dans le backlog.');
}

function addJournal(plan, value, actor, now) {
  if (plan.journal.length >= 2000) throw invalid('Le journal contient déjà 2 000 entrées.');
  plan.journal.push({ id: id('journal'), at: now, text: text(value, 'Entrée du journal', 16000), ...actor });
}

function moveInList(entries, value, target, position) {
  if (!['before', 'after'].includes(position)) throw invalid('Position de déplacement invalide.');
  if (value === target) return;
  entries.splice(entries.indexOf(value), 1);
  entries.splice(entries.indexOf(target) + (position === 'after' ? 1 : 0), 0, value);
}

function subtreeDepth(step) {
  return 1 + Math.max(0, ...step.children.map(subtreeDepth));
}

function moveStep(plan, input) {
  const source = findStep(plan, input.stepId);
  let destination;
  let index;
  if (input.direction !== undefined) {
    if (input.targetId !== undefined || input.position !== undefined)
      throw invalid('Choisissez une direction ou une cible de déplacement.');
    switch (input.direction) {
      case 'up':
      case 'down': {
        const next = source.index + (input.direction === 'up' ? -1 : 1);
        if (next < 0 || next >= source.siblings.length) return;
        source.siblings.splice(source.index, 1);
        source.siblings.splice(next, 0, source.step);
        return;
      }
      case 'indent': {
        const previous = source.siblings[source.index - 1];
        if (!previous) throw invalid('Aucune tâche précédente ne peut accueillir ce groupe.');
        if (source.depth + subtreeDepth(source.step) > 3)
          throw invalid('La checklist est limitée à trois niveaux.');
        destination = previous.children;
        index = destination.length;
        break;
      }
      case 'outdent': {
        if (!source.parent) throw invalid('Cette tâche est déjà au premier niveau.');
        const parent = findStep(plan, source.parent.id);
        destination = parent.siblings;
        index = parent.index + 1;
        break;
      }
      default:
        throw invalid('Direction de déplacement invalide.');
    }
  } else {
    if (!['before', 'after', 'inside'].includes(input.position))
      throw invalid('Position de déplacement invalide.');
    const target = findStep(plan, input.targetId);
    if (source.step === target.step) return;
    if (collectSteps([source.step]).has(target.step.id))
      throw invalid('Une tâche ne peut pas être déplacée dans ses descendants.');
    const depth = target.depth + (input.position === 'inside' ? 1 : 0);
    if (depth + subtreeDepth(source.step) - 1 > 3) throw invalid('La checklist est limitée à trois niveaux.');
    destination = input.position === 'inside' ? target.step.children : target.siblings;
    index =
      input.position === 'inside' ? destination.length : target.index + (input.position === 'after' ? 1 : 0);
  }
  if (destination === source.siblings && source.index < index) index--;
  source.siblings.splice(source.index, 1);
  destination.splice(index, 0, source.step);
}

function apply(document, input, actor, now) {
  const plan =
    (input.action.startsWith('plan.') && input.action !== 'plan.create') ||
    input.action.startsWith('step.') ||
    input.action === 'journal.add'
      ? findPlan(document, input.planId)
      : null;
  if (plan?.archived && !['plan.delete', 'plan.archive', 'plan.unarchive'].includes(input.action))
    throw error(400, 'roadmap_archived', 'Ce plan est archivé. Restaurez-le avant de le modifier.');
  if (plan) plan.updatedAt = now;
  switch (input.action) {
    case 'init':
      break;
    case 'vision':
      document.overview.vision = text(input.text, 'Vision', 20000, true);
      break;
    case 'milestone.create':
      document.overview.milestones.push({
        id: id('milestone'),
        title: text(input.title, 'Titre', 300),
        summary: text(input.summary, 'Résumé', 16000, true),
        status: status(input.status ?? 'planned', MILESTONE_STATUSES),
      });
      break;
    case 'milestone.patch': {
      const milestone = findMilestone(document, input.milestoneId);
      if (own(input, 'title')) milestone.title = text(input.title, 'Titre', 300);
      if (own(input, 'summary')) milestone.summary = text(input.summary, 'Résumé', 16000, true);
      if (own(input, 'status')) milestone.status = status(input.status, MILESTONE_STATUSES);
      break;
    }
    case 'milestone.delete': {
      const milestone = findMilestone(document, input.milestoneId);
      document.overview.milestones = document.overview.milestones.filter((entry) => entry !== milestone);
      for (const entry of document.plans)
        if (entry.milestone === milestone.id) {
          entry.milestone = null;
          entry.updatedAt = now;
        }
      break;
    }
    case 'milestone.move':
      moveInList(
        document.overview.milestones,
        findMilestone(document, input.milestoneId),
        findMilestone(document, input.targetId),
        input.position,
      );
      break;
    case 'plan.create': {
      const planId = id('plan');
      const title = text(input.title, 'Titre', 300);
      const slugBase =
        title
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 70) || 'plan';
      const milestone = input.milestone == null ? null : findMilestone(document, input.milestone).id;
      const sessions = [
        ...new Set(
          list(input.sessions ?? [], 'Conversations', 500).map((value) => identifier(value, 'Session')),
        ),
      ];
      document.plans.push({
        id: planId,
        slug: `${slugBase}-${planId.slice(-8)}`,
        title,
        summary: text(input.summary, 'Résumé', 16000, true),
        status: status(input.status ?? 'active', PLAN_STATUSES),
        milestone,
        sessions,
        steps: normalizeSteps(input.steps ?? [], { creating: true }),
        journal: [],
        createdAt: now,
        updatedAt: now,
        archived: false,
        archivedAt: null,
      });
      break;
    }
    case 'plan.patch': {
      if (own(input, 'title')) plan.title = text(input.title, 'Titre', 300);
      if (own(input, 'summary')) plan.summary = text(input.summary, 'Résumé', 16000, true);
      if (own(input, 'status')) {
        const value = status(input.status, PLAN_STATUSES);
        if (plan.status !== value) addJournal(plan, `Statut : ${plan.status} → ${value}`, actor, now);
        plan.status = value;
      }
      if (own(input, 'milestone'))
        plan.milestone = input.milestone === null ? null : findMilestone(document, input.milestone).id;
      break;
    }
    case 'plan.attach': {
      const sessionId = identifier(input.sessionId, 'Session');
      if (!plan.sessions.includes(sessionId)) plan.sessions.push(sessionId);
      break;
    }
    case 'plan.delete':
      document.plans = document.plans.filter((entry) => entry !== plan);
      break;
    case 'plan.archive':
      plan.archived = true;
      plan.archivedAt = now;
      break;
    case 'plan.unarchive':
      plan.archived = false;
      plan.archivedAt = null;
      break;
    case 'plan.steps':
      plan.steps = normalizeSteps(input.steps, { old: plan.steps });
      break;
    case 'step.add': {
      const parent =
        input.parentId === undefined || input.parentId === null ? null : findStep(plan, input.parentId);
      if (parent?.depth >= 3) throw invalid('La checklist est limitée à trois niveaux.');
      const entries = parent ? parent.step.children : plan.steps;
      const next = {
        id: id('step'),
        text: text(input.text, 'Texte de tâche'),
        note: text(input.note, 'Note', 16000, true),
        done: false,
        children: [],
      };
      let index = entries.length;
      if (input.afterId !== undefined && input.afterId !== null) {
        const after = findStep(plan, input.afterId);
        if (after.siblings !== entries) throw invalid('La tâche précédente doit appartenir au même groupe.');
        index = after.index + 1;
      }
      entries.splice(index, 0, next);
      break;
    }
    case 'step.edit': {
      const { step } = findStep(plan, input.stepId);
      if (own(input, 'text')) step.text = text(input.text, 'Texte de tâche');
      if (own(input, 'note')) step.note = text(input.note, 'Note', 16000, true);
      break;
    }
    case 'step.check': {
      if (own(input, 'stepId') && own(input, 'stepIds'))
        throw invalid('Choisissez une tâche ou une liste de tâches.');
      const stepIds = own(input, 'stepIds')
        ? list(input.stepIds, 'Tâches à cocher', MAX_STEPS)
        : [input.stepId];
      if (!stepIds.length || (stepIds.length !== 1 && own(input, 'note')))
        throw invalid('Une note de tâche doit viser une seule tâche.');
      const selected = [...new Set(stepIds)].map((stepId) => findStep(plan, stepId).step);
      const done = boolean(input.done);
      for (const selectedStep of selected)
        for (const { step } of collectSteps([selectedStep]).values()) step.done = done;
      if (own(input, 'note')) selected[0].note = text(input.note, 'Note', 16000, true);
      if (input.comment !== undefined && input.comment !== '') addJournal(plan, input.comment, actor, now);
      break;
    }
    case 'step.remove': {
      const found = findStep(plan, input.stepId);
      found.siblings.splice(found.index, 1);
      break;
    }
    case 'step.move':
      moveStep(plan, input);
      break;
    case 'journal.add':
      addJournal(plan, input.text, actor, now);
      break;
    case 'work.attach': {
      const sessionId = identifier(input.sessionId, 'Session');
      const plans = list(input.planIds ?? [], 'Plans', 200).map((planId) => findPlan(document, planId));
      if (plans.some((entry) => entry.archived))
        throw error(400, 'roadmap_archived', 'Ce plan est archivé. Restaurez-le avant de le modifier.');
      const entries = list(input.backlogNumbers ?? [], 'Éléments du backlog').map(
        (number) => findBacklog(document, number).entry,
      );
      for (const entry of [...plans, ...entries]) {
        entry.sessions ??= [];
        if (!entry.sessions.includes(sessionId)) entry.sessions.push(sessionId);
      }
      for (const linkedPlan of plans) linkedPlan.updatedAt = now;
      break;
    }
    case 'backlog.add': {
      const items = list(input.items ?? [], 'Éléments du backlog');
      const notes = list(input.notes ?? [], 'Notes du backlog');
      if (!items.length && !notes.length) throw invalid('Ajoutez au moins un élément au backlog.');
      for (const [entries, isNote] of [
        [items, false],
        [notes, true],
      ])
        for (const entry of entries) {
          if (!isObject(entry)) throw invalid();
          document.backlog[isNote ? 'notes' : 'items'].push({
            number: document.backlog.nextNumber++,
            text: text(entry.text, 'Texte'),
            note: text(entry.note, 'Note', 16000, true),
            ...(isNote ? {} : { done: false }),
            addedAt: now,
            ...actor,
          });
        }
      break;
    }
    case 'backlog.edit': {
      const { entry } = findBacklog(document, input.number);
      if (own(input, 'text')) entry.text = text(input.text, 'Texte');
      if (own(input, 'note')) entry.note = text(input.note, 'Note', 16000, true);
      break;
    }
    case 'backlog.set': {
      const numbers = list(input.numbers, 'Éléments du backlog');
      if (!numbers.length) throw invalid('Sélectionnez au moins un élément.');
      const done = boolean(input.done);
      const entries = numbers.map((number) => findBacklog(document, number));
      if (entries.some((entry) => entry.isNote)) throw invalid('Une note ne possède pas de case à cocher.');
      for (const { entry } of entries) entry.done = done;
      break;
    }
    case 'backlog.remove': {
      const numbers = new Set(list(input.numbers, 'Éléments du backlog'));
      if (!numbers.size) throw invalid('Sélectionnez au moins un élément.');
      for (const number of numbers) findBacklog(document, number);
      document.backlog.items = document.backlog.items.filter((entry) => !numbers.has(entry.number));
      document.backlog.notes = document.backlog.notes.filter((entry) => !numbers.has(entry.number));
      break;
    }
    case 'backlog.move': {
      const source = findBacklog(document, input.number);
      const target = findBacklog(document, input.targetNumber);
      if (source.entries !== target.entries)
        throw invalid('Convertissez cet élément avant de le déplacer dans un autre groupe.');
      moveInList(source.entries, source.entry, target.entry, input.position);
      break;
    }
    case 'backlog.convert': {
      if (!['item', 'note'].includes(input.kind)) throw invalid('Type de backlog invalide.');
      const source = findBacklog(document, input.number);
      if (source.isNote === (input.kind === 'note')) break;
      source.entries.splice(source.index, 1);
      if (input.kind === 'note') delete source.entry.done;
      else source.entry.done = false;
      document.backlog[input.kind === 'note' ? 'notes' : 'items'].push(source.entry);
      break;
    }
    default:
      throw invalid('Action de Roadmap inconnue.');
  }
}

async function info(path) {
  try {
    return await lstat(path);
  } catch (reason) {
    if (reason.code === 'ENOENT') return null;
    throw reason;
  }
}

async function safePaths(project, create = false) {
  const root = await realpath(project.cwd);
  let directory = root;
  for (const segment of ['.prime', 'studio']) {
    directory = join(directory, segment);
    let entry = await info(directory);
    if (!entry && create) {
      try {
        await mkdir(directory);
      } catch (reason) {
        if (reason.code !== 'EEXIST') throw reason;
      }
      entry = await info(directory);
    }
    if (!entry) return { directory, file: join(root, '.prime', 'studio', 'roadmap.json'), missing: true };
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw error(
        409,
        'roadmap_unsafe_path',
        'Le dossier Roadmap doit être un dossier normal dans le projet.',
      );
  }
  if ((await realpath(directory)) !== directory)
    throw error(409, 'roadmap_unsafe_path', 'Le dossier Roadmap ne doit pas être redirigé.');
  const file = join(directory, 'roadmap.json');
  const entry = await info(file);
  if (entry && (entry.isSymbolicLink() || !entry.isFile() || entry.nlink > 1))
    throw error(
      409,
      'roadmap_unsafe_path',
      'Le document Roadmap doit être un fichier normal dans le projet.',
    );
  return { directory, file, missing: !entry };
}

async function readDocument(project) {
  const paths = await safePaths(project);
  if (paths.missing) return empty();
  try {
    const handle = await open(paths.file, 'r');
    let raw;
    try {
      if ((await handle.stat()).size > MAX_BYTES) throw invalid('Le document Roadmap est trop volumineux.');
      raw = await handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close();
    }
    if (Buffer.byteLength(raw) > MAX_BYTES) throw invalid('Le document Roadmap est trop volumineux.');
    return validateDocument(JSON.parse(raw));
  } catch (reason) {
    if (reason.code === 'ENOENT')
      throw error(409, 'roadmap_changed', 'Le document Roadmap a été déplacé pendant sa lecture. Réessayez.');
    if (reason.status === 409) throw reason;
    throw error(
      500,
      'roadmap_corrupt',
      'Le document Roadmap est illisible ou invalide. Il est conservé intact ; restaurez une copie valide avant de le modifier.',
    );
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (reason) {
    return reason.code !== 'ESRCH';
  }
}

async function ownerAt(lock) {
  const stat = await info(lock);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw error(409, 'roadmap_unsafe_path', 'Le verrou Roadmap est invalide.');
  const ownerFile = join(lock, 'owner.json');
  const ownerInfo = await info(ownerFile);
  if (!ownerInfo) return { pending: true };
  if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile() || ownerInfo.nlink > 1 || ownerInfo.size > 4096)
    throw error(409, 'roadmap_unsafe_path', 'Le propriétaire du verrou Roadmap est invalide.');
  let owner;
  try {
    owner = JSON.parse(await readFile(ownerFile, 'utf8'));
  } catch (reason) {
    if (reason.code === 'ENOENT') return { pending: true };
    return { pending: true };
  }
  if (
    !isObject(owner) ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !/^[a-f0-9-]{36}$/.test(owner.nonce) ||
    !Number.isSafeInteger(owner.at)
  )
    return { pending: true };
  return owner;
}

async function acquire(project, isClosed) {
  const paths = await safePaths(project, true);
  const lock = join(paths.directory, '.roadmap.lock');
  const owner = { pid: process.pid, nonce: randomUUID(), at: Date.now() };
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (isClosed()) throw error(503, 'roadmap_closed', 'Le service Roadmap est arrêté.');
    let claimed = false;
    try {
      await mkdir(lock);
      claimed = true;
      const handle = await open(join(lock, 'owner.json'), 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(owner));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        const current = await ownerAt(lock);
        if (current?.nonce !== owner.nonce) return;
        await unlink(join(lock, 'owner.json'));
        await rmdir(lock);
      };
    } catch (reason) {
      if (claimed) {
        await unlink(join(lock, 'owner.json')).catch(() => {});
        await rmdir(lock).catch(() => {});
        throw error(
          500,
          'roadmap_write_failed',
          'Le verrou de sauvegarde de la Roadmap n’a pas pu être créé.',
        );
      }
      if (reason.code !== 'EEXIST') throw reason;
      const current = await ownerAt(lock);
      if (current && !current.pending && !alive(current.pid)) {
        // Keep this non-empty tombstone: simultaneous stale-lock recoverers cannot
        // rename a newly acquired lock over it and erase its live owner.
        const retired = join(paths.directory, `.roadmap.retired-${current.nonce}`);
        const verified = await ownerAt(lock);
        if (verified?.nonce === current.nonce) {
          try {
            await rename(lock, retired);
          } catch (failure) {
            if (!['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(failure.code)) throw failure;
          }
        }
      }
      await delay(25 + Math.floor(Math.random() * 30));
    }
  }
  throw error(
    423,
    'roadmap_busy',
    'Une autre écriture de la Roadmap est en cours. Réessayez dans un instant.',
  );
}

async function writeDocument(project, document) {
  const data = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(data) > MAX_BYTES) throw invalid('Le document Roadmap dépasse la limite de 4 Mio.');
  const paths = await safePaths(project);
  const temporary = join(paths.directory, `.roadmap-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    const checked = await safePaths(project);
    if (checked.file !== paths.file || checked.directory !== paths.directory)
      throw error(409, 'roadmap_unsafe_path', 'Le dossier du projet a changé pendant la sauvegarde.');
    await rename(temporary, paths.file);
  } catch (reason) {
    if (reason instanceof HttpError) throw reason;
    throw error(
      500,
      'roadmap_write_failed',
      'La Roadmap n’a pas pu être enregistrée. La version précédente est conservée.',
    );
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function markdown(value) {
  const title = (input) => input.replace(/[\r\n]+/g, ' ');
  const lines = [
    `# Roadmap — ${title(value.name)}`,
    '',
    `Révision : ${value.revision}`,
    `Avancement déclaré : ${value.progress.done}/${value.progress.total} tâches cochées (${value.progress.percent} %).`,
    '',
    '> Export Markdown. Le document JSON du projet reste la source des modifications.',
    '',
  ];
  if (!value.initialized) return `${lines.join('\n')}\nRoadmap non initialisée.\n`;
  if (value.overview.vision) lines.push('## Vision', '', value.overview.vision, '');
  if (value.overview.milestones.length) {
    lines.push('## Jalons', '');
    for (const milestone of value.overview.milestones) {
      lines.push(
        `### ${title(milestone.title)}`,
        '',
        `Statut : ${milestone.status} · ${milestone.progress.done}/${milestone.progress.total} tâches cochées`,
      );
      if (milestone.summary) lines.push('', milestone.summary);
      lines.push('');
    }
  }
  const emitSteps = (steps, depth = 0) => {
    for (const step of steps) {
      const pad = '  '.repeat(depth);
      const content = step.text.split('\n');
      lines.push(`${pad}- [${step.done ? 'x' : ' '}] ${content[0]}`);
      for (const extra of content.slice(1)) lines.push(`${pad}  ${extra}`);
      if (step.note) for (const note of step.note.split('\n')) lines.push(`${pad}  > ${note}`);
      emitSteps(step.children, depth + 1);
    }
  };
  if (value.plans.length) lines.push('## Plans', '');
  for (const plan of value.plans) {
    lines.push(
      `### ${title(plan.title)}`,
      '',
      `Identifiant : ${plan.id}`,
      `Statut : ${plan.status}${plan.status === 'abandoned' ? ' (exclu de l’avancement du projet)' : ''}${plan.archived ? ' (archivé)' : ''} · ${plan.progress.done}/${plan.progress.total} tâches cochées`,
    );
    if (plan.milestone)
      lines.push(
        `Jalon : ${title(value.overview.milestones.find((entry) => entry.id === plan.milestone).title)}`,
      );
    if (plan.sessions.length) lines.push(`Conversations : ${plan.sessions.join(', ')}`);
    if (plan.summary) lines.push('', plan.summary);
    lines.push('');
    emitSteps(plan.steps);
    if (plan.journal.length) {
      lines.push('', '#### Journal', '');
      for (const entry of plan.journal)
        lines.push(
          `- ${new Date(entry.at).toISOString()} · ${entry.name || entry.by}${entry.sessionId ? ` · ${entry.sessionId}` : ''}\n  ${entry.text.replace(/\n/g, '\n  ')}`,
        );
    }
    lines.push('');
  }
  lines.push('## Backlog', '', 'Hors avancement des plans engagés.', '');
  for (const entry of value.backlog.items)
    lines.push(
      `- [${entry.done ? 'x' : ' '}] #${entry.number} ${entry.text.replace(/\n/g, '\n  ')}${entry.note ? `\n  > ${entry.note.replace(/\n/g, '\n  > ')}` : ''}`,
    );
  if (value.backlog.notes.length) lines.push('', '### Notes', '');
  for (const entry of value.backlog.notes)
    lines.push(
      `- #${entry.number} ${entry.text.replace(/\n/g, '\n  ')}${entry.note ? `\n  > ${entry.note.replace(/\n/g, '\n  > ')}` : ''}`,
    );
  return `${lines.join('\n')}\n`;
}

export function createRoadmapService({ resolveProject, onChange } = {}) {
  if (typeof resolveProject !== 'function') throw new TypeError('resolveProject is required');
  let closed = false;
  const pending = new Set();
  async function projectFor(cwd) {
    if (closed) throw error(503, 'roadmap_closed', 'Le service Roadmap est arrêté.');
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 4096) throw invalid('Projet invalide.');
    const project = await resolveProject(cwd);
    if (!project || typeof project.cwd !== 'string' || !isAbsolute(project.cwd))
      throw missing('Ce projet est introuvable.');
    return {
      cwd: resolve(project.cwd),
      name: typeof project.name === 'string' && project.name.trim() ? project.name : basename(project.cwd),
    };
  }
  async function read(cwd) {
    const project = await projectFor(cwd);
    return dto(project, await readDocument(project));
  }
  async function mutate(cwd, input, actor = { by: 'user' }) {
    if (!isObject(input) || typeof input.action !== 'string') throw invalid();
    const attribution = who(actor);
    const project = await projectFor(cwd);
    const root = await realpath(project.cwd);
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    const prior = queues.get(key) ?? Promise.resolve();
    const operation = prior
      .catch(() => {})
      .then(async () => {
        if (closed) throw error(503, 'roadmap_closed', 'Le service Roadmap est arrêté.');
        // Invalid reads are never treated as empty and initialization is harmless
        // when another caller has already created a valid document.
        const before = await readDocument(project);
        if (input.action === 'init' && before.revision > 0) return dto(project, before);
        integer(input.expectedRevision, 'Révision attendue');
        if (!before.revision && input.action !== 'init')
          throw error(409, 'roadmap_uninitialized', 'Initialisez la Roadmap avant de la modifier.');
        const release = await acquire(project, () => closed);
        try {
          const document = await readDocument(project);
          if (input.action === 'init' && document.revision > 0) return dto(project, document);
          if (input.expectedRevision !== document.revision)
            throw error(
              409,
              'roadmap_conflict',
              'La Roadmap a changé depuis votre lecture. Actualisez-la avant de réappliquer votre modification.',
              { currentRevision: document.revision },
            );
          const now = Date.now();
          apply(document, input, attribution, now);
          document.revision++;
          document.lastEdit = { ...attribution, at: now };
          const valid = validateDocument(document);
          await writeDocument(project, valid);
          const result = dto(project, valid);
          try {
            await onChange?.(project.cwd, structuredClone(result));
          } catch {
            /* Observers cannot roll back a committed transaction. */
          }
          return result;
        } finally {
          await release();
        }
      });
    queues.set(key, operation);
    pending.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(operation);
      if (queues.get(key) === operation) queues.delete(key);
    }
  }
  // Additive .pastudio export: validated raw document (not DTO) for archiving.
  async function readRaw(cwd) {
    const project = await projectFor(cwd);
    return validateDocument(await readDocument(project));
  }
  // Additive .pastudio import: single queued operation, single lock, single revision++.
  // Appends milestones/plans/backlog/journal additively; never overwrites vision or existing entries.
  // Source vision is preserved as an imported backlog note. Marker commits atomically with content.
  async function importPastudio(cwd, payload, actor = { by: 'user' }) {
    if (!isObject(payload)) throw invalid();
    const attribution = who(actor);
    const project = await projectFor(cwd);
    const root = await realpath(project.cwd);
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    const prior = queues.get(key) ?? Promise.resolve();
    const operation = prior
      .catch(() => {})
      .then(async () => {
        if (closed) throw error(503, 'roadmap_closed', 'Le service Roadmap est arrêté.');
        const marker = payload.marker;
        if (!isObject(marker)) throw invalid();
        const archiveId = text(marker.archiveId, 'Archive', 200).trim();
        const payloadDigest = text(marker.payloadDigest, 'Empreinte', 128);
        if (!archiveId || !/^[0-9a-f]{64}$/.test(payloadDigest)) throw invalid('Marqueur invalide.');
        const release = await acquire(project, () => closed);
        try {
          const document = await readDocument(project);
          const imports = Array.isArray(document.pastudioImports) ? document.pastudioImports : [];
          const byDigest = imports.find((e) => e.payloadDigest === payloadDigest);
          if (byDigest) return { duplicate: true, result: dto(project, document) };
          const byArchive = imports.find((e) => e.archiveId === archiveId);
          if (byArchive)
            throw error(
              409,
              'pastudio_archive_changed',
              'Cette archive a déjà été importée avec un contenu différent. Importez la copie d’origine ou une nouvelle exportation.',
            );
          const now = Date.now();
          // Validate limits before mutating: milestones/plans/backlog caps.
          const inMilestones = list(payload.milestones ?? [], 'Jalons', 200);
          const inPlans = list(payload.plans ?? [], 'Plans', 200);
          const inItems = list(payload.backlogItems ?? [], 'Éléments', 2000);
          const inNotes = list(payload.backlogNotes ?? [], 'Notes', 2000);
          if (document.overview.milestones.length + inMilestones.length > 200)
            throw error(409, 'pastudio_limits', 'Trop de jalons après import (maximum 200).');
          if (document.plans.length + inPlans.length > 200)
            throw error(409, 'pastudio_limits', 'Trop de plans après import (maximum 200).');
          if (
            document.backlog.items.length + inItems.length > 2000 ||
            document.backlog.notes.length + inNotes.length + (payload.visionNoteText ? 1 : 0) > 2000
          )
            throw error(409, 'pastudio_limits', 'Backlog trop volumineux après import (maximum 2 000).');
          // Append milestones with fresh IDs; remap plan milestone refs by index.
          const milestoneIdByIndex = new Map();
          for (let idx = 0; idx < inMilestones.length; idx++) {
            const entry = inMilestones[idx];
            if (!isObject(entry)) throw invalid();
            const created = {
              id: id('milestone'),
              title: text(entry.title, 'Titre', 300),
              summary: text(entry.summary, 'Résumé', 16000, true),
              status: status(entry.status ?? 'planned', MILESTONE_STATUSES),
            };
            document.overview.milestones.push(created);
            milestoneIdByIndex.set(idx, created.id);
          }
          // Append plans with fresh IDs/slugs/steps/journal; sessions are already-remapped new IDs.
          for (const entry of inPlans) {
            if (!isObject(entry)) throw invalid();
            const planId = id('plan');
            const title = text(entry.title, 'Titre', 300);
            const slugBase =
              title
                .normalize('NFKD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
                .slice(0, 70) || 'plan';
            let milestone = null;
            if (entry.milestoneIndex !== undefined && entry.milestoneIndex !== null) {
              integer(entry.milestoneIndex, 'Jalon', 0);
              milestone = milestoneIdByIndex.get(entry.milestoneIndex) ?? null;
              if (!milestone) throw invalid('Jalon importé introuvable.');
            }
            const sessions = [
              ...new Set(
                list(entry.sessions ?? [], 'Conversations', 500).map((v) => identifier(v, 'Session')),
              ),
            ];
            const steps = normalizeSteps(entry.steps ?? [], { creating: true });
            const journalInput = list(entry.journal ?? [], 'Journal', 2000);
            if (document.plans.some((p) => p.id === planId)) throw invalid();
            const journal = [];
            for (const item of journalInput) {
              if (!isObject(item)) throw invalid();
              if (journal.length >= 2000) throw invalid('Le journal contient déjà 2 000 entrées.');
              journal.push({
                id: id('journal'),
                at: item.at !== undefined ? integer(item.at, 'Date', 1) : now,
                text: text(item.text, 'Entrée du journal', 16000),
                ...who({ by: item.by ?? 'user', sessionId: item.sessionId, rootSessionId: item.rootSessionId, name: item.name }),
              });
            }
            if (journal.length >= 2000) throw invalid('Le journal contient déjà 2 000 entrées.');
            journal.push({
              id: id('journal'),
              at: now,
              text: text(
                `Import .pastudio ${archiveId} : plan « ${title} » ajouté sans écraser la Roadmap locale.`,
                'Entrée du journal',
                16000,
              ),
              ...attribution,
            });
            document.plans.push({
              id: planId,
              slug: `${slugBase}-${planId.slice(-8)}`,
              title,
              summary: text(entry.summary, 'Résumé', 16000, true),
              status: status(entry.status ?? 'active', PLAN_STATUSES),
              milestone,
              sessions,
              steps,
              journal,
              createdAt: now,
              updatedAt: now,
              archived: false,
              archivedAt: null,
            });
          }
          // Append backlog items/notes with destination nextNumber allocation.
          for (const entry of inItems) {
            if (!isObject(entry)) throw invalid();
            document.backlog.items.push({
              number: document.backlog.nextNumber++,
              text: text(entry.text, 'Texte'),
              note: text(entry.note, 'Note', 16000, true),
              done: false,
              addedAt: now,
              ...attribution,
            });
          }
          for (const entry of inNotes) {
            if (!isObject(entry)) throw invalid();
            document.backlog.notes.push({
              number: document.backlog.nextNumber++,
              text: text(entry.text, 'Texte'),
              note: text(entry.note, 'Note', 16000, true),
              addedAt: now,
              ...attribution,
            });
          }
          if (payload.visionNoteText) {
            document.backlog.notes.push({
              number: document.backlog.nextNumber++,
              text: text(
                `Vision importée (.pastudio ${archiveId}) — la vision locale est inchangée.`,
                'Texte',
              ),
              note: text(payload.visionNoteText, 'Note', 16000, true),
              addedAt: now,
              ...attribution,
            });
          }
          imports.push({
            archiveId,
            payloadDigest,
            importedAt: now,
            ...(payload.sourceProject
              ? {
                  sourceProject: {
                    name: text(payload.sourceProject.name ?? '', 'Projet', 300, true),
                    cwd: text(payload.sourceProject.cwd ?? '', 'Dossier', 4096, true),
                  },
                }
              : {}),
          });
          document.pastudioImports = imports;
          document.revision++;
          document.lastEdit = { ...attribution, at: now };
          const valid = validateDocument(document);
          await writeDocument(project, valid);
          const result = dto(project, valid);
          try {
            await onChange?.(project.cwd, structuredClone(result));
          } catch {
            /* Observers cannot roll back a committed transaction. */
          }
          return { duplicate: false, result };
        } finally {
          await release();
        }
      });
    queues.set(key, operation);
    pending.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(operation);
      if (queues.get(key) === operation) queues.delete(key);
    }
  }
  return {
    read,
    readRaw,
    mutate,
    importPastudio,
    async exportMarkdown(cwd) {
      return markdown(await read(cwd));
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };
}
