// The native Python bridge must enforce the same parameter contract as the
// legacy Studio Roadmap tools before forwarding a request to the writer.
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (min, max) => (value) => typeof value === 'string' && value.length >= min && value.length <= max;
const integer = (min, max = Number.MAX_SAFE_INTEGER) =>
  (value) => Number.isSafeInteger(value) && value >= min && value <= max;
const array = (item, min, max) =>
  (value) => Array.isArray(value) && value.length >= min && value.length <= max && value.every(item);
const choice = (...values) => (value) => values.includes(value);
const nullable = (item) => (value) => value === null || item(value);
const id = string(1, 200);
const shortText = string(1, 1000);
const note = string(0, 12000);
const title = string(1, 300);
const revision = integer(0);
const boolean = (value) => typeof value === 'boolean';
const positive = integer(1);

function shape(fields, required = []) {
  return (value) => record(value) &&
    Object.keys(value).every((key) => Object.hasOwn(fields, key) && fields[key](value[key])) &&
    required.every((key) => Object.hasOwn(value, key));
}

function step(depth) {
  return shape({
    id,
    text: shortText,
    note,
    done: boolean,
    children: array(depth > 1 ? step(depth - 1) : () => false, 0, depth > 1 ? 100 : 0),
  }, ['text']);
}

const workTarget = (value) =>
  shape({ kind: choice('plan'), planId: id, stepId: id }, ['kind', 'planId'])(value) ||
  shape({ kind: choice('milestone'), milestoneId: id }, ['kind', 'milestoneId'])(value) ||
  shape({ kind: choice('backlog'), number: positive }, ['kind', 'number'])(value);

const schemas = {
  roadmap_read: shape({
    target: choice('overview', 'plan', 'backlog'), planId: id, offset: integer(0), limit: integer(1, 50),
  }),
  roadmap_plan: shape({
    action: choice('init', 'create', 'patch', 'attach', 'steps', 'delete', 'step_add', 'step_edit',
      'step_remove', 'step_move', 'journal'),
    expectedRevision: revision, planId: id, title, summary: note,
    status: choice('active', 'paused', 'done', 'abandoned'), milestone: nullable(id),
    sessionId: id, sessions: array(id, 0, 30), steps: array(step(3), 0, 100),
    stepId: id, text: shortText, note, parentId: nullable(id), afterId: nullable(id),
    targetId: id, position: choice('before', 'after', 'inside'),
    direction: choice('up', 'down', 'indent', 'outdent'),
  }, ['action', 'expectedRevision']),
  roadmap_check: shape({
    expectedRevision: revision, planId: id, stepId: id, stepIds: array(id, 1, 100),
    done: boolean, note, comment: note,
  }, ['expectedRevision', 'planId', 'done']),
  roadmap_backlog: shape({
    action: choice('add', 'set', 'edit', 'remove', 'convert', 'move'), expectedRevision: revision,
    items: array(shape({ text: shortText, note }, ['text']), 0, 100),
    notes: array(shape({ text: shortText, note }, ['text']), 0, 100),
    numbers: array(positive, 1, 100), number: positive, text: shortText, note, done: boolean,
    kind: choice('item', 'note'), targetNumber: positive, position: choice('before', 'after'),
  }, ['action', 'expectedRevision']),
  roadmap_milestone: shape({
    action: choice('vision', 'create', 'patch', 'delete', 'move'), expectedRevision: revision,
    milestoneId: id, title, summary: note, text: note,
    status: choice('planned', 'active', 'done'), targetId: id, position: choice('before', 'after'),
  }, ['action', 'expectedRevision']),
  roadmap_work: shape({ targets: array(workTarget, 0, 20) }, ['targets']),
};

export function validateRustRoadmapCall(action, params) {
  if (!schemas[action]?.(params)) {
    const cause = new Error(`Invalid ${action} parameters; use prime_studio.${action}.__doc__ for the contract.`);
    cause.code = 'studio_tool_invalid';
    throw cause;
  }
}
