// Prime Agent Studio — public API v1 contract (single source of truth).
//
// This module is the ONLY place that defines the generic v1 surface:
// operation IDs, HTTP method + path, required scopes, and the top-level
// request field allowlists (including the per-action roadmap mutation map).
// docs/api/openapi-v1.json is generated from here, never edited by hand.
// The HTTP root derives its path matcher from publicApiOperations and
// enforces bodyFields/requiredFields (via validatePublicApiBody) before
// delegating semantic validation to the existing domain services.
//
// Protected token management and API preferences stay local-only under
// /api/public-api and are NOT part of this public contract.
//
// Stdlib only. No framework, no general JSON-schema runtime.

export const PUBLIC_API_VERSION = 'v1';
export const PUBLIC_API_PREFIX = '/api/v1';

export const PUBLIC_API_SCOPES = ['read', 'runs:write', 'roadmaps:write', 'files:download'];

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Every operation carries `read`; writes add their scope. Byte downloads
// (GET + HEAD) additionally require `files:download`.
export const publicApiOperations = [
  { operationId: 'machine', method: 'GET', path: '/api/v1/machine', scopes: ['read'] },
  { operationId: 'projects', method: 'GET', path: '/api/v1/projects', scopes: ['read'] },
  { operationId: 'models', method: 'GET', path: '/api/v1/models', scopes: ['read'] },
  {
    operationId: 'sessions',
    method: 'GET',
    path: '/api/v1/projects/{projectId}/sessions',
    scopes: ['read'],
  },
  {
    operationId: 'messages',
    method: 'GET',
    path: '/api/v1/sessions/{sessionId}/messages',
    scopes: ['read'],
  },
  {
    operationId: 'createRun',
    method: 'POST',
    path: '/api/v1/projects/{projectId}/runs',
    scopes: ['read', 'runs:write'],
    bodyFields: ['requestId', 'message', 'sessionId', 'model', 'thinking', 'allowQuestions'],
    requiredFields: ['requestId', 'message'],
  },
  { operationId: 'runs', method: 'GET', path: '/api/v1/runs', scopes: ['read'] },
  { operationId: 'run', method: 'GET', path: '/api/v1/runs/{runId}', scopes: ['read'] },
  {
    operationId: 'events',
    method: 'GET',
    path: '/api/v1/runs/{runId}/events',
    scopes: ['read'],
  },
  {
    operationId: 'stop',
    method: 'POST',
    path: '/api/v1/runs/{runId}/stop',
    scopes: ['read', 'runs:write'],
    bodyFields: [],
    requiredFields: [],
  },
  {
    operationId: 'interaction',
    method: 'POST',
    path: '/api/v1/runs/{runId}/interactions',
    scopes: ['read', 'runs:write'],
    bodyFields: ['id', 'response'],
    requiredFields: ['id', 'response'],
  },
  {
    operationId: 'sendMessage',
    method: 'POST',
    path: '/api/v1/sessions/{sessionId}/messages',
    scopes: ['read', 'runs:write'],
    bodyFields: ['requestId', 'mode', 'message'],
    requiredFields: ['requestId', 'mode', 'message'],
  },
  {
    operationId: 'roadmap',
    method: 'GET',
    path: '/api/v1/projects/{projectId}/roadmap',
    scopes: ['read'],
  },
  {
    operationId: 'mutateRoadmap',
    method: 'POST',
    path: '/api/v1/projects/{projectId}/roadmap/mutations',
    scopes: ['read', 'roadmaps:write'],
    bodyFields: ['action', 'expectedRevision'],
    requiredFields: ['action', 'expectedRevision'],
  },
  {
    operationId: 'roadmapWork',
    method: 'POST',
    path: '/api/v1/projects/{projectId}/roadmap/work',
    scopes: ['read', 'runs:write', 'roadmaps:write'],
    bodyFields: [
      'requestId',
      'expectedRevision',
      'targets',
      'instructions',
      'sessionId',
      'model',
      'thinking',
    ],
    requiredFields: ['requestId', 'expectedRevision', 'targets'],
  },
  {
    operationId: 'files',
    method: 'GET',
    path: '/api/v1/sessions/{sessionId}/files',
    scopes: ['read'],
  },
  {
    operationId: 'download',
    method: 'GET',
    path: '/api/v1/sessions/{sessionId}/files/{fileId}',
    scopes: ['read', 'files:download'],
  },
  {
    operationId: 'fileHead',
    method: 'HEAD',
    path: '/api/v1/sessions/{sessionId}/files/{fileId}',
    scopes: ['read', 'files:download'],
  },
];

// Per-action field allowlists for mutateRoadmap. Keys mirror the native
// action union in lib/roadmap.mjs apply(), excluding the internal
// `work.attach` (owned by roadmapRoutes, never accepted over HTTP).
// `action`, `expectedRevision` (required integer >= 0) and `cwd`/actor stay
// top-level concerns: the API handler injects cwd internally, never the client.
// `fields` lists every accepted action-specific key; `required` the subset
// that must be present (deeper semantic checks stay in the native service).
export const roadmapMutationFields = {
  init: { fields: [], required: [] },
  vision: { fields: ['text'], required: ['text'] },
  'milestone.create': { fields: ['title', 'summary', 'status'], required: ['title'] },
  'milestone.patch': {
    fields: ['milestoneId', 'title', 'summary', 'status'],
    required: ['milestoneId'],
  },
  'milestone.delete': { fields: ['milestoneId'], required: ['milestoneId'] },
  'milestone.move': {
    fields: ['milestoneId', 'targetId', 'position'],
    required: ['milestoneId', 'targetId', 'position'],
  },
  'plan.create': {
    fields: ['title', 'summary', 'status', 'milestone', 'color', 'sessions', 'steps'],
    required: ['title'],
  },
  'plan.patch': {
    fields: ['planId', 'title', 'summary', 'status', 'milestone', 'color'],
    required: ['planId'],
  },
  'plan.attach': { fields: ['planId', 'sessionId'], required: ['planId', 'sessionId'] },
  'plan.delete': { fields: ['planId'], required: ['planId'] },
  'plan.archive': { fields: ['planId'], required: ['planId'] },
  'plan.unarchive': { fields: ['planId'], required: ['planId'] },
  'plan.steps': { fields: ['planId', 'steps'], required: ['planId', 'steps'] },
  'step.add': {
    fields: ['planId', 'text', 'note', 'parentId', 'afterId'],
    required: ['planId', 'text'],
  },
  'step.edit': { fields: ['planId', 'stepId', 'text', 'note'], required: ['planId', 'stepId'] },
  'step.check': {
    fields: ['planId', 'stepId', 'stepIds', 'done', 'note', 'comment'],
    required: ['planId', 'done'],
  },
  'step.remove': { fields: ['planId', 'stepId'], required: ['planId', 'stepId'] },
  'step.move': {
    fields: ['planId', 'stepId', 'direction', 'targetId', 'position'],
    required: ['planId', 'stepId'],
  },
  'journal.add': { fields: ['planId', 'text'], required: ['planId', 'text'] },
  'backlog.add': { fields: ['items', 'notes'], required: [] },
  'backlog.edit': { fields: ['number', 'text', 'note'], required: ['number'] },
  'backlog.set': { fields: ['numbers', 'done'], required: ['numbers', 'done'] },
  'backlog.remove': { fields: ['numbers'], required: ['numbers'] },
  'backlog.move': {
    fields: ['number', 'targetNumber', 'position'],
    required: ['number', 'targetNumber', 'position'],
  },
  'backlog.convert': { fields: ['number', 'kind'], required: ['number', 'kind'] },
};

// ---------------------------------------------------------------------------
// Validation helper (optional for the root, which owns enforcement).
// Rejects unknown top-level fields and missing required fields, applies the
// closed mutation action union, and checks basic scalar types/bounds.
// Deeper semantic validation stays in the existing domain services.
// Error shape: { ok:false, status, code, error }.
// ---------------------------------------------------------------------------

const fail = (error, status = 400, code = 'invalid_request') => ({ ok: false, status, code, error });

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const hasNul = (value) => typeof value === 'string' && value.includes('\0');
const isSafeInteger = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const isIdentifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);

function checkRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value))
    return 'requestId must match [A-Za-z0-9_-]{16,100}.';
  return null;
}

function checkOptionalModel(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\r\n\0]/.test(value))
    return 'model must be a non-empty string of at most 300 characters.';
  return null;
}

function checkOptionalThinking(value) {
  if (value === undefined) return null;
  if (!THINKING_LEVELS.includes(value)) return `thinking must be one of ${THINKING_LEVELS.join(', ')}.`;
  return null;
}

function checkOptionalSessionId(value) {
  if (value === undefined) return null;
  if (!isIdentifier(value)) return 'sessionId is invalid.';
  return null;
}

// Closed interaction response union: cancel, confirm boolean, or value string.
// Nothing else passes; the native service validates against the live request.
function checkInteractionResponse(value) {
  if (!isRecord(value)) return 'response must be an object.';
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'cancelled' && value.cancelled === true) return null;
  if (keys.length === 1 && keys[0] === 'confirmed' && typeof value.confirmed === 'boolean') return null;
  if (
    keys.length === 1 &&
    keys[0] === 'value' &&
    typeof value.value === 'string' &&
    value.value.trim() &&
    value.value.length <= 10000
  )
    return null;
  return 'response must be exactly {cancelled:true}, {confirmed:boolean} or {value:string(1..10000)}.';
}

// Light scalar checks for known mutation fields. Presence/allowlist is
// enforced for every field; types here cover the unambiguous cases and the
// native service validates the rest (nested steps, items, sessions, colors).
function checkMutationScalar(action, field, value) {
  switch (field) {
    case 'text':
    case 'comment': {
      const max = action === 'vision' ? 20000 : action === 'journal.add' ? 16000 : 8000;
      if (typeof value !== 'string' || !value.trim() || value.length > max || hasNul(value))
        return `${field} must be a non-empty string of at most ${max} characters.`;
      return null;
    }
    case 'title': {
      if (typeof value !== 'string' || !value.trim() || value.length > 300 || hasNul(value))
        return 'title must be a non-empty string of at most 300 characters.';
      return null;
    }
    case 'note':
    case 'summary':
    case 'instructions': {
      if (typeof value !== 'string' || value.length > 16000 || hasNul(value))
        return `${field} must be a string of at most 16000 characters.`;
      return null;
    }
    case 'done':
    case 'allowQuestions': {
      if (typeof value !== 'boolean') return `${field} must be a boolean.`;
      return null;
    }
    case 'number':
    case 'targetNumber': {
      if (!isSafeInteger(value)) return `${field} must be an integer >= 0.`;
      return null;
    }
    case 'numbers': {
      if (!Array.isArray(value) || !value.length || !value.every((entry) => isSafeInteger(entry)))
        return 'numbers must be a non-empty array of integers >= 0.';
      return null;
    }
    case 'milestoneId':
    case 'planId':
    case 'stepId':
    case 'targetId':
    case 'afterId':
    case 'sessionId': {
      if (!isIdentifier(value)) return `${field} is invalid.`;
      return null;
    }
    case 'parentId': {
      if (value !== null && !isIdentifier(value)) return 'parentId is invalid.';
      return null;
    }
    case 'milestone': {
      if (value !== null && !isIdentifier(value)) return 'milestone is invalid.';
      return null;
    }
    case 'stepIds':
    case 'planIds': {
      if (!Array.isArray(value) || !value.length || !value.every(isIdentifier))
        return `${field} must be a non-empty array of identifiers.`;
      return null;
    }
    case 'backlogNumbers': {
      if (!Array.isArray(value) || !value.every((entry) => isSafeInteger(entry)))
        return 'backlogNumbers must be an array of integers >= 0.';
      return null;
    }
    case 'status': {
      const allowed = action.startsWith('milestone.')
        ? ['planned', 'active', 'done']
        : ['active', 'done', 'paused', 'abandoned'];
      if (!allowed.includes(value)) return `status must be one of ${allowed.join(', ')}.`;
      return null;
    }
    case 'kind': {
      if (value !== 'item' && value !== 'note') return 'kind must be item or note.';
      return null;
    }
    case 'direction': {
      if (!['up', 'down', 'indent', 'outdent'].includes(value))
        return 'direction must be up, down, indent or outdent.';
      return null;
    }
    case 'position': {
      const allowed = action === 'step.move' ? ['before', 'after', 'inside'] : ['before', 'after'];
      if (!allowed.includes(value)) return `position must be one of ${allowed.join(', ')}.`;
      return null;
    }
    default:
      return null;
  }
}

function checkUnknown(body, allowed, label) {
  for (const key of Object.keys(body))
    if (!allowed.includes(key)) return fail(`Unknown field: ${key} in ${label}.`);
  return null;
}

function checkRequired(body, required, label) {
  for (const key of required)
    if (body[key] === undefined) return fail(`Missing required field: ${key} in ${label}.`);
  return null;
}

export function validatePublicApiBody(operationId, body) {
  const operation = publicApiOperations.find((entry) => entry.operationId === operationId);
  if (!operation) return fail(`Unknown operation: ${operationId}.`, 404, 'not_found');
  if (operation.bodyFields === undefined) {
    if (body !== undefined && body !== null) return fail(`${operationId} accepts no request body.`);
    return { ok: true };
  }
  const value = body === undefined || body === null ? {} : body;
  if (!isRecord(value)) return fail(`${operationId} request body must be a JSON object.`);
  const label = `${operationId} request body`;
  if (operationId !== 'mutateRoadmap') {
    const unknown = checkUnknown(value, operation.bodyFields, label);
    if (unknown) return unknown;
  }
  const missing = checkRequired(value, operation.requiredFields ?? [], label);
  if (missing) return missing;

  switch (operationId) {
    case 'stop':
      return { ok: true };
    case 'createRun': {
      const invalidId = checkRequestId(value.requestId);
      if (invalidId) return fail(invalidId);
      if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 200000)
        return fail('message must be a non-empty string of at most 200000 characters.');
      const model = checkOptionalModel(value.model);
      if (model) return fail(model);
      const thinking = checkOptionalThinking(value.thinking);
      if (thinking) return fail(thinking);
      const session = checkOptionalSessionId(value.sessionId);
      if (session) return fail(session);
      if (value.allowQuestions !== undefined && typeof value.allowQuestions !== 'boolean')
        return fail('allowQuestions must be a boolean.');
      return { ok: true };
    }
    case 'interaction': {
      if (!isNonEmptyString(value.id)) return fail('id must be a non-empty string.');
      const response = checkInteractionResponse(value.response);
      if (response) return fail(response);
      return { ok: true };
    }
    case 'sendMessage': {
      const invalidId = checkRequestId(value.requestId);
      if (invalidId) return fail(invalidId);
      if (value.mode !== 'steer' && value.mode !== 'follow_up')
        return fail('mode must be steer or follow_up.');
      if (
        typeof value.message !== 'string' ||
        !value.message.trim() ||
        Buffer.byteLength(value.message, 'utf8') > 256 * 1024
      )
        return fail('message must be a non-empty string of at most 256 KiB.');
      return { ok: true };
    }
    case 'mutateRoadmap': {
      if (typeof value.action !== 'string' || !Object.hasOwn(roadmapMutationFields, value.action))
        return fail('action must be a known roadmap mutation action.');
      if (!isSafeInteger(value.expectedRevision)) return fail('expectedRevision must be an integer >= 0.');
      const spec = roadmapMutationFields[value.action];
      const allowed = [...spec.fields, 'action', 'expectedRevision'];
      const unknownField = checkUnknown(value, allowed, `mutation ${value.action}`);
      if (unknownField) return unknownField;
      const missingField = checkRequired(value, spec.required ?? [], `mutation ${value.action}`);
      if (missingField) return missingField;
      if (value.action === 'step.check') {
        const byId = value.stepId !== undefined;
        const byIds = value.stepIds !== undefined;
        if (byId && byIds) return fail('Choose stepId or stepIds, not both.');
        if (!byId && !byIds) return fail('stepId or stepIds is required.');
      }
      for (const field of spec.fields) {
        if (value[field] === undefined) continue;
        const invalid = checkMutationScalar(value.action, field, value[field]);
        if (invalid) return fail(invalid);
      }
      return { ok: true };
    }
    case 'roadmapWork': {
      const invalidId = checkRequestId(value.requestId);
      if (invalidId) return fail(invalidId);
      if (!isSafeInteger(value.expectedRevision)) return fail('expectedRevision must be an integer >= 0.');
      if (!Array.isArray(value.targets) || !value.targets.length || value.targets.length > 20)
        return fail('targets must be an array of 1 to 20 selection entries.');
      for (const target of value.targets) {
        if (!isRecord(target)) return fail('Each target must be an object.');
        if (target.kind === 'plan') {
          if (!isIdentifier(target.planId)) return fail('Plan targets need a planId.');
          if (target.stepId !== undefined && !isIdentifier(target.stepId)) return fail('stepId is invalid.');
        } else if (target.kind === 'milestone') {
          if (!isIdentifier(target.milestoneId)) return fail('Milestone targets need a milestoneId.');
        } else if (target.kind === 'backlog') {
          if (!isSafeInteger(target.number)) return fail('Backlog targets need a number >= 0.');
        } else {
          return fail('Target kind must be plan, milestone or backlog.');
        }
      }
      if (
        value.instructions !== undefined &&
        (typeof value.instructions !== 'string' ||
          !value.instructions.trim() ||
          value.instructions.trim().length > 4000 ||
          hasNul(value.instructions))
      )
        return fail('instructions must be a non-empty string of at most 4000 characters.');
      const session = checkOptionalSessionId(value.sessionId);
      if (session) return fail(session);
      const model = checkOptionalModel(value.model);
      if (model) return fail(model);
      const thinking = checkOptionalThinking(value.thinking);
      if (thinking) return fail(thinking);
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// OpenAPI generation (sole writer of docs/api/openapi-v1.json).
// ---------------------------------------------------------------------------

const fileHeaders = {
  'Accept-Ranges': { schema: { type: 'string' } },
  'Content-Type': { schema: { type: 'string' } },
  'Content-Disposition': { schema: { type: 'string' } },
  ETag: { schema: { type: 'string' } },
  'Last-Modified': { schema: { type: 'string' } },
};

const errorSchema = {
  type: 'object',
  required: ['error', 'code'],
  properties: {
    error: { type: 'string' },
    code: { type: 'string' },
    currentRevision: { type: 'integer', minimum: 0 },
  },
};

const paginated = (itemRef) => ({
  type: 'object',
  required: ['items', 'nextOffset'],
  properties: {
    items: { type: 'array', items: itemRef },
    nextOffset: { type: 'integer', minimum: 0, nullable: true },
  },
});

const limitParameter = {
  name: 'limit',
  in: 'query',
  schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
};
const offsetParameter = {
  name: 'offset',
  in: 'query',
  schema: { type: 'integer', minimum: 0, default: 0 },
};

const identifierSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$',
};
const nullableIdentifier = (description) => ({
  oneOf: [identifierSchema, { type: 'null' }],
  description,
});
const textSchema = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
const freeTextSchema = (maxLength) => ({ type: 'string', maxLength });

// Closed per-field schemas mirroring the native bounds in lib/roadmap.mjs.
// Nested step/backlog structure stays bounded (2000 entries, 3 levels);
// deeper semantic rules (identifier uniqueness, xor choices, list membership)
// remain in the native service.
function mutationFieldSchema(action, field) {
  switch (field) {
    case 'text':
      return textSchema(action === 'vision' ? 20000 : action === 'journal.add' ? 16000 : 8000);
    case 'comment':
      return textSchema(16000);
    case 'title':
      return textSchema(300);
    case 'note':
    case 'summary':
      return freeTextSchema(16000);
    case 'done':
      return { type: 'boolean' };
    case 'number':
    case 'targetNumber':
      return { type: 'integer', minimum: 0 };
    case 'numbers':
      return { type: 'array', minItems: 1, maxItems: 2000, items: { type: 'integer', minimum: 0 } };
    case 'milestoneId':
    case 'planId':
    case 'stepId':
    case 'targetId':
    case 'afterId':
    case 'sessionId':
      return identifierSchema;
    case 'parentId':
      return nullableIdentifier('Null or omitted for a top-level step.');
    case 'milestone':
      return nullableIdentifier('Null unassigns the plan milestone.');
    case 'stepIds':
      return { type: 'array', minItems: 1, maxItems: 2000, items: identifierSchema };
    case 'planIds':
      return { type: 'array', maxItems: 200, items: identifierSchema };
    case 'backlogNumbers':
      return { type: 'array', maxItems: 2000, items: { type: 'integer', minimum: 0 } };
    case 'sessions':
      return { type: 'array', maxItems: 500, items: identifierSchema };
    case 'steps':
      return {
        type: 'array',
        maxItems: 2000,
        items: { $ref: '#/components/schemas/RoadmapStep' },
      };
    case 'status':
      return action.startsWith('milestone.')
        ? { type: 'string', enum: ['planned', 'active', 'done'] }
        : { type: 'string', enum: ['active', 'done', 'paused', 'abandoned'] };
    case 'color':
      return {
        type: 'string',
        enum: ['transparent', '#0d9488', '#db2777', '#4f46e5', '#65a30d', '#ea580c'],
      };
    case 'kind':
      return { type: 'string', enum: ['item', 'note'] };
    case 'direction':
      return { type: 'string', enum: ['up', 'down', 'indent', 'outdent'] };
    case 'position':
      return action === 'step.move'
        ? { type: 'string', enum: ['before', 'after', 'inside'] }
        : { type: 'string', enum: ['before', 'after'] };
    case 'items':
    case 'notes':
      return {
        type: 'array',
        maxItems: 2000,
        items: { $ref: '#/components/schemas/BacklogEntry' },
      };
    default:
      throw new Error(`No schema for mutation field: ${field}`);
  }
}

function mutationSchema(action) {
  const spec = roadmapMutationFields[action];
  return {
    type: 'object',
    required: ['action', 'expectedRevision', ...(spec.required ?? [])],
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: [action] },
      expectedRevision: { type: 'integer', minimum: 0 },
      ...Object.fromEntries(spec.fields.map((field) => [field, mutationFieldSchema(action, field)])),
    },
  };
}

export function generateOpenApi() {
  const schemas = {
    Machine: {
      type: 'object',
      required: ['apiVersion', 'studioVersion', 'machineId', 'name', 'capabilities', 'idempotency'],
      properties: {
        apiVersion: { type: 'string', enum: ['v1'] },
        studioVersion: { type: 'string' },
        machineId: { type: 'string' },
        name: { type: 'string' },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Currently projects, conversations, runs, roadmaps and files.',
        },
        idempotency: {
          type: 'object',
          required: ['retentionSeconds', 'persistent'],
          properties: {
            retentionSeconds: { type: 'integer', enum: [3600] },
            persistent: { type: 'boolean', enum: [false] },
          },
        },
      },
    },
    Project: {
      type: 'object',
      required: ['id', 'name', 'syncId', 'exists', 'machineId'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        syncId: { type: 'string', nullable: true },
        exists: { type: 'boolean' },
        machineId: { type: 'string' },
      },
    },
    // Engine catalog projection: per-model capability flags use
    // reasoning:boolean + thinkingLevels:string[], never a `thinking` field
    // (request-level thinking on runs/messages is unchanged).
    Model: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        provider: { type: 'string' },
        input: { type: 'string' },
        reasoning: { type: 'boolean' },
        thinkingLevels: { type: 'array', items: { type: 'string', enum: THINKING_LEVELS } },
        contextWindow: { type: 'integer', minimum: 0 },
        availability: { type: 'string' },
      },
    },
    Session: {
      type: 'object',
      required: ['id', 'title', 'machineId', 'projectId'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' },
        model: { type: 'string' },
        thinking: { type: 'string', enum: THINKING_LEVELS },
        machineId: { type: 'string' },
        projectId: { type: 'string' },
      },
    },
    // Persisted message projection. Attachments are metadata only
    // (type, id, name, size, mimeType); v1 uploads accept no attachments and
    // inline image bytes are never fetched through this API.
    MessageItem: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        role: { type: 'string' },
        text: { type: 'string' },
        thinking: { type: 'string' },
        timestamp: { type: 'string' },
        usage: { type: 'object' },
        model: { type: 'string' },
        provider: { type: 'string' },
        error: { type: 'string' },
        stopReason: { type: 'string' },
        customType: { type: 'string' },
        contextKind: { type: 'string' },
        agentMessage: { type: 'object' },
        tools: { type: 'array', items: { type: 'object' } },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              id: { type: 'string' },
              name: { type: 'string' },
              size: { type: 'integer', minimum: 0, nullable: true },
              mimeType: { type: 'string' },
            },
          },
        },
      },
    },
    Message: {
      type: 'object',
      required: ['sessionId', 'projectId', 'machineId', 'items', 'nextOffset'],
      properties: {
        sessionId: { type: 'string' },
        projectId: { type: 'string' },
        machineId: { type: 'string' },
        items: { type: 'array', items: { $ref: '#/components/schemas/MessageItem' } },
        nextOffset: { type: 'integer', minimum: 0, nullable: true },
      },
    },
    Run: {
      type: 'object',
      required: [
        'id',
        'sessionId',
        'projectId',
        'machineId',
        'status',
        'startedAt',
        'model',
        'thinking',
        'allowQuestions',
        'interactions',
      ],
      properties: {
        id: { type: 'string' },
        sessionId: { type: 'string', nullable: true },
        projectId: { type: 'string' },
        machineId: { type: 'string' },
        status: { type: 'string' },
        startedAt: { type: 'string' },
        endedAt: { type: 'string', description: 'Present once the run finishes.' },
        error: { type: 'string', nullable: true, description: 'Present when the run fails.' },
        model: { type: 'string', nullable: true },
        thinking: { type: 'string', nullable: true },
        allowQuestions: { type: 'boolean' },
        interactions: { type: 'array', items: { type: 'object' } },
        requestId: { type: 'string' },
      },
    },
    // Projected live event carried as SSE `data:`. Frames are sent as
    // `id: <seq>` + `data: <this envelope>`; `: heartbeat` comments keep the
    // stream alive and the stream ends when the run finishes.
    RunEvent: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string' },
        seq: { type: 'integer', minimum: 0 },
        machineId: { type: 'string' },
        projectId: { type: 'string' },
        runId: { type: 'string' },
        sessionId: { type: 'string', nullable: true },
        message: { $ref: '#/components/schemas/MessageItem' },
      },
    },
    Roadmap: {
      type: 'object',
      required: ['machineId', 'projectId', 'roadmap'],
      properties: {
        machineId: { type: 'string' },
        projectId: { type: 'string' },
        roadmap: {
          type: 'object',
          description: 'Current roadmap DTO, identical to the native document minus cwd.',
        },
      },
    },
    RoadmapWorkAccept: {
      type: 'object',
      required: ['accepted', 'queued', 'requestId', 'run', 'sessionId', 'machineId', 'projectId'],
      properties: {
        accepted: { type: 'boolean', enum: [true] },
        queued: { type: 'boolean' },
        requestId: { type: 'string' },
        run: { $ref: '#/components/schemas/Run' },
        sessionId: { type: 'string', nullable: true },
        roadmap: {
          type: 'object',
          description: 'Bare roadmap document (no machineId/projectId envelope).',
        },
        linkWarning: { type: 'boolean' },
        machineId: { type: 'string' },
        projectId: { type: 'string' },
      },
    },
    StopResult: {
      type: 'object',
      required: ['stopped'],
      properties: {
        stopped: { type: 'boolean', enum: [true] },
      },
      description: 'Stop acknowledgement plus the current Run projection fields.',
    },
    // File entries carry per-reference local proof: receipts recorded from
    // live native run message events on the machine that produced the link.
    // A legacy or synced reference without a local receipt on THIS machine
    // reports originMachineId null, available false and size null; serving
    // its bytes answers 409 origin_unknown. Only a newly emitted local
    // reference creates a receipt there; receipts never grant a whole
    // session by origin guess, and the server never substitutes a same-named
    // file from another machine. Inline image bytes stay metadata-only;
    // stored UUID attachment blobs and generated files linked as local
    // Markdown references are servable.
    FileRef: {
      type: 'object',
      required: ['id', 'name', 'size', 'available', 'machineId', 'originMachineId', 'kind'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        size: { type: 'integer', minimum: 0, nullable: true },
        available: { type: 'boolean' },
        machineId: { type: 'string' },
        originMachineId: { type: 'string', nullable: true },
        kind: { type: 'string', enum: ['link', 'attachment'] },
      },
    },
    RoadmapStep: {
      type: 'object',
      required: ['text'],
      additionalProperties: false,
      properties: {
        id: identifierSchema,
        text: { type: 'string', minLength: 1, maxLength: 8000 },
        note: { type: 'string', maxLength: 16000 },
        done: { type: 'boolean' },
        children: {
          type: 'array',
          maxItems: 2000,
          items: { $ref: '#/components/schemas/RoadmapStep' },
          description: 'Checklists accept three levels and 2 000 steps at most.',
        },
      },
    },
    BacklogEntry: {
      type: 'object',
      required: ['text'],
      additionalProperties: false,
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 8000 },
        note: { type: 'string', maxLength: 16000 },
      },
    },
    Error: errorSchema,
  };

  const mutationActions = Object.keys(roadmapMutationFields);

  const paths = {
    '/api/v1/machine': {
      get: {
        operationId: 'machine',
        summary: 'Studio identity and API capabilities.',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Machine identity.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Machine' } } },
          },
        },
      },
    },
    '/api/v1/projects': {
      get: {
        operationId: 'projects',
        summary: 'Projects authorized for this token.',
        security: [{ bearerAuth: [] }],
        parameters: [limitParameter, offsetParameter],
        responses: {
          200: {
            description: 'Project page.',
            content: {
              'application/json': { schema: paginated({ $ref: '#/components/schemas/Project' }) },
            },
          },
        },
      },
    },
    '/api/v1/models': {
      get: {
        operationId: 'models',
        summary: 'Engine model catalog page.',
        security: [{ bearerAuth: [] }],
        parameters: [limitParameter, offsetParameter],
        responses: {
          200: {
            description: 'Model page.',
            content: {
              'application/json': { schema: paginated({ $ref: '#/components/schemas/Model' }) },
            },
          },
        },
      },
    },
    '/api/v1/projects/{projectId}/sessions': {
      get: {
        operationId: 'sessions',
        summary: 'Conversations of an authorized project.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          limitParameter,
          offsetParameter,
        ],
        responses: {
          200: {
            description: 'Session page.',
            content: {
              'application/json': { schema: paginated({ $ref: '#/components/schemas/Session' }) },
            },
          },
        },
      },
    },
    '/api/v1/sessions/{sessionId}/messages': {
      get: {
        operationId: 'messages',
        summary: 'Persisted history of an authorized conversation.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
          limitParameter,
          offsetParameter,
        ],
        responses: {
          200: {
            description: 'Message page.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Message' } },
            },
          },
        },
      },
      post: {
        operationId: 'sendMessage',
        summary: 'Send a message to the live run of a conversation.',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['requestId', 'mode', 'message'],
                additionalProperties: false,
                properties: {
                  requestId: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,100}$' },
                  mode: { type: 'string', enum: ['steer', 'follow_up'] },
                  message: { type: 'string', maxLength: 262144 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Message accepted.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/api/v1/projects/{projectId}/runs': {
      post: {
        operationId: 'createRun',
        summary: 'Start a run in an authorized project (idempotent by requestId).',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['requestId', 'message'],
                additionalProperties: false,
                properties: {
                  requestId: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,100}$' },
                  message: { type: 'string', maxLength: 200000 },
                  sessionId: { type: 'string' },
                  model: { type: 'string', maxLength: 300 },
                  thinking: { type: 'string', enum: THINKING_LEVELS },
                  allowQuestions: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Run accepted (existing run returned on idempotent retry).',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Run' } },
            },
          },
          409: {
            description: 'Same requestId with different content.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/api/v1/runs': {
      get: {
        operationId: 'runs',
        summary: 'Runs visible to this token.',
        security: [{ bearerAuth: [] }],
        parameters: [limitParameter, offsetParameter],
        responses: {
          200: {
            description: 'Run page.',
            content: {
              'application/json': { schema: paginated({ $ref: '#/components/schemas/Run' }) },
            },
          },
        },
      },
    },
    '/api/v1/runs/{runId}': {
      get: {
        operationId: 'run',
        summary: 'One run with its owning machine, project and session.',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Run state.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Run' } },
            },
          },
          404: {
            description: 'Unknown or expired run.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/api/v1/runs/{runId}/events': {
      get: {
        operationId: 'events',
        summary: 'Server-sent event stream of a run.',
        description:
          'Frames are `id: <seq>` + `data: <RunEvent>`, with `: heartbeat` comments. ' +
          'Resume with the Last-Event-ID header or the after query cursor: buffered events ' +
          'with a higher sequence replay, a `replay_truncated` marker precedes them when the ' +
          'buffer start is newer than the cursor, and the stream ends when the run finishes.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'after',
            in: 'query',
            schema: { type: 'integer', minimum: 0, default: 0 },
            description: 'Replay events with a sequence above this cursor.',
          },
          {
            name: 'Last-Event-ID',
            in: 'header',
            schema: { type: 'integer', minimum: 0 },
            description: 'Same cursor as after, via the SSE resume header.',
          },
        ],
        responses: {
          200: {
            description: 'text/event-stream of RunEvent envelopes.',
            content: {
              'text/event-stream': {
                schema: { $ref: '#/components/schemas/RunEvent' },
              },
            },
          },
        },
      },
    },
    '/api/v1/runs/{runId}/stop': {
      post: {
        operationId: 'stop',
        summary: 'Request a run to stop.',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: false, properties: {} },
            },
          },
        },
        responses: {
          200: {
            description: 'Stop requested.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/StopResult' } },
            },
          },
        },
      },
    },
    '/api/v1/runs/{runId}/interactions': {
      post: {
        operationId: 'interaction',
        summary: 'Answer a pending run interaction (cancel, confirm or value).',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id', 'response'],
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  response: {
                    oneOf: [
                      {
                        type: 'object',
                        required: ['cancelled'],
                        additionalProperties: false,
                        properties: { cancelled: { type: 'boolean', enum: [true] } },
                      },
                      {
                        type: 'object',
                        required: ['confirmed'],
                        additionalProperties: false,
                        properties: { confirmed: { type: 'boolean' } },
                      },
                      {
                        type: 'object',
                        required: ['value'],
                        additionalProperties: false,
                        properties: { value: { type: 'string', maxLength: 10000 } },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Response recorded.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/api/v1/projects/{projectId}/roadmap': {
      get: {
        operationId: 'roadmap',
        summary: 'Local roadmap copy of an authorized project.',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Roadmap document.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Roadmap' } },
            },
          },
        },
      },
    },
    '/api/v1/projects/{projectId}/roadmap/mutations': {
      post: {
        operationId: 'mutateRoadmap',
        summary: 'Apply one closed roadmap mutation at the read revision.',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { oneOf: mutationActions.map((action) => mutationSchema(action)) },
            },
          },
        },
        responses: {
          200: {
            description: 'Updated roadmap.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Roadmap' } },
            },
          },
          409: {
            description: 'Revision conflict; reread before reapplying.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/api/v1/projects/{projectId}/roadmap/work': {
      post: {
        operationId: 'roadmapWork',
        summary: 'Start work on this machine from a roadmap selection.',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['requestId', 'expectedRevision', 'targets'],
                additionalProperties: false,
                properties: {
                  requestId: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,100}$' },
                  expectedRevision: { type: 'integer', minimum: 0 },
                  targets: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 20,
                    items: {
                      oneOf: [
                        {
                          type: 'object',
                          required: ['kind', 'planId'],
                          properties: {
                            kind: { type: 'string', enum: ['plan'] },
                            planId: { type: 'string' },
                            stepId: { type: 'string' },
                          },
                        },
                        {
                          type: 'object',
                          required: ['kind', 'milestoneId'],
                          properties: {
                            kind: { type: 'string', enum: ['milestone'] },
                            milestoneId: { type: 'string' },
                          },
                        },
                        {
                          type: 'object',
                          required: ['kind', 'number'],
                          properties: {
                            kind: { type: 'string', enum: ['backlog'] },
                            number: { type: 'integer', minimum: 0 },
                          },
                        },
                      ],
                    },
                  },
                  instructions: { type: 'string', maxLength: 4000 },
                  sessionId: { type: 'string' },
                  model: { type: 'string', maxLength: 300 },
                  thinking: { type: 'string', enum: THINKING_LEVELS },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Work accepted on this machine.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RoadmapWorkAccept' } },
            },
          },
          409: {
            description: 'Revision conflict or requestId reuse with different content.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/api/v1/sessions/{sessionId}/files': {
      get: {
        operationId: 'files',
        summary: 'File references proven in the history of an authorized conversation.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
          limitParameter,
          offsetParameter,
        ],
        responses: {
          200: {
            description: 'File reference page.',
            content: {
              'application/json': { schema: paginated({ $ref: '#/components/schemas/FileRef' }) },
            },
          },
        },
      },
    },
    '/api/v1/sessions/{sessionId}/files/{fileId}': {
      get: {
        operationId: 'download',
        summary: 'Download the bytes served by the machine holding the file.',
        description:
          'Streaming with no application cap. Validators are checked per request against the ' +
          'live file, not an immutable snapshot. Wait for the producer to finish writing before ' +
          'downloading; bytes are not frozen during a transfer. One single Range per request: a valid range ' +
          'answers 206 with Content-Range; an unsatisfiable, malformed or multi-range value ' +
          'answers 416 with Content-Range bytes */size. If-Range with a stale validator ' +
          're-downloads the whole file as 200 instead of mixing versions. If-None-Match or ' +
          'If-Modified-Since matching the current ETag/mtime answers 304; a failed If-Match ' +
          'or If-Unmodified-Since precondition answers 412.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'fileId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'Range', in: 'header', schema: { type: 'string' } },
          { name: 'If-Range', in: 'header', schema: { type: 'string' } },
          { name: 'If-None-Match', in: 'header', schema: { type: 'string' } },
          { name: 'If-Modified-Since', in: 'header', schema: { type: 'string' } },
          { name: 'If-Match', in: 'header', schema: { type: 'string' } },
          { name: 'If-Unmodified-Since', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'File bytes.',
            headers: { ...fileHeaders, 'Content-Length': { schema: { type: 'string' } } },
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
          206: {
            description: 'Single valid range.',
            headers: {
              ...fileHeaders,
              'Content-Length': { schema: { type: 'string' } },
              'Content-Range': { schema: { type: 'string' } },
            },
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
          304: {
            description: 'Current ETag/mtime still matches the conditional headers. No JSON body.',
            headers: { ETag: { schema: { type: 'string' } } },
          },
          412: {
            description: 'Failed If-Match or If-Unmodified-Since precondition. No JSON body.',
            headers: { ETag: { schema: { type: 'string' } } },
          },
          416: {
            description: 'Unsatisfiable, malformed or multi-range request. No JSON body.',
            headers: { 'Content-Range': { schema: { type: 'string' } } },
          },
          404: {
            description: 'Unknown file, or bytes missing on this machine.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          409: {
            description: 'No local provenance (origin_unknown) or file changed while opening.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
      head: {
        operationId: 'fileHead',
        summary: 'File metadata headers without the bytes.',
        description: 'Same validators as download, headers only. Range is ignored on HEAD.',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'fileId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'If-None-Match', in: 'header', schema: { type: 'string' } },
          { name: 'If-Modified-Since', in: 'header', schema: { type: 'string' } },
          { name: 'If-Match', in: 'header', schema: { type: 'string' } },
          { name: 'If-Unmodified-Since', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'Headers only (Content-Length, Accept-Ranges, ETag, Last-Modified).',
            headers: { ...fileHeaders, 'Content-Length': { schema: { type: 'string' } } },
          },
          304: {
            description: 'Current ETag/mtime still matches the conditional headers. No JSON body.',
            headers: { ETag: { schema: { type: 'string' } } },
          },
          412: {
            description: 'Failed If-Match or If-Unmodified-Since precondition. No JSON body.',
            headers: { ETag: { schema: { type: 'string' } } },
          },
          404: {
            description: 'Unknown file, or bytes missing on this machine.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          409: {
            description: 'No local provenance (origin_unknown) or file changed while opening.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
  };
  const errorResponse = (description) => ({
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  });
  const scopesOf = (operationId) =>
    publicApiOperations.find((entry) => entry.operationId === operationId)?.scopes ?? [];
  for (const item of Object.values(paths))
    for (const operation of Object.values(item)) {
      operation['x-required-scopes'] = [...scopesOf(operation.operationId)];
      operation.responses ??= {};
      operation.responses['400'] ??= errorResponse('Invalid request.');
      operation.responses['401'] ??= errorResponse('Missing or invalid token.');
      operation.responses['403'] ??= errorResponse('Valid token without the needed scope or project.');
    }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Prime Agent Studio public API',
      version: 'v1',
      description:
        'Generic documented v1 surface. Tokens are created locally in Studio Preferences; ' +
        'every request authenticates with `Authorization: Bearer <token>`. Token management ' +
        'and API preferences stay local-only under /api/public-api and are not part of this contract.',
    },
    servers: [
      {
        url: 'http://127.0.0.1:{port}',
        description: 'Studio chosen by the client (direct per-Studio calls).',
        variables: {
          port: { default: '3088', description: 'Studio HTTP port (PORT, default 3088).' },
        },
      },
    ],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' },
      },
      schemas,
    },
  };
}
