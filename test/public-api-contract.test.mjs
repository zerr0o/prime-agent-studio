import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLIC_API_VERSION,
  PUBLIC_API_PREFIX,
  publicApiOperations,
  roadmapMutationFields,
  generateOpenApi,
  validatePublicApiBody,
} from '../lib/public-api-contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Native action union: every `case '<action>':` inside apply() in lib/roadmap.mjs.
async function nativeMutationActions() {
  const source = await readFile(resolve(ROOT, 'lib/roadmap.mjs'), 'utf8');
  const body = source.slice(source.indexOf('function apply('));
  const end = body.search(/\nfunction (?!apply)/);
  const actions = new Set();
  for (const match of body.slice(0, end).matchAll(/case '([^']+)':/g)) actions.add(match[1]);
  return actions;
}

test('generated openapi-v1.json equals generateOpenApi()', async () => {
  const stored = JSON.parse(await readFile(resolve(ROOT, 'docs/api/openapi-v1.json'), 'utf8'));
  assert.deepEqual(stored, generateOpenApi());
});

test('operations: agreed IDs, methods, /api/v1 prefix and scope coverage', () => {
  const expectedScopes = {
    machine: ['read'],
    projects: ['read'],
    models: ['read'],
    sessions: ['read'],
    messages: ['read'],
    createRun: ['read', 'runs:write'],
    runs: ['read'],
    run: ['read'],
    events: ['read'],
    stop: ['read', 'runs:write'],
    interaction: ['read', 'runs:write'],
    sendMessage: ['read', 'runs:write'],
    roadmap: ['read'],
    mutateRoadmap: ['read', 'roadmaps:write'],
    roadmapWork: ['read', 'runs:write', 'roadmaps:write'],
    files: ['read'],
    download: ['read', 'files:download'],
    fileHead: ['read', 'files:download'],
  };
  assert.deepEqual(
    publicApiOperations.map((entry) => entry.operationId).sort(),
    Object.keys(expectedScopes).sort(),
  );
  const seen = new Set();
  for (const entry of publicApiOperations) {
    assert.match(entry.method, /^(GET|POST|HEAD)$/);
    assert.ok(entry.path.startsWith(`${PUBLIC_API_PREFIX}/`), entry.operationId);
    assert.deepEqual(entry.scopes, expectedScopes[entry.operationId]);
    assert.ok(entry.scopes.includes('read'), entry.operationId);
    const key = `${entry.method} ${entry.path}`;
    assert.ok(!seen.has(key), `duplicate route ${key}`);
    seen.add(key);
    if (entry.bodyFields !== undefined) {
      assert.ok(Array.isArray(entry.bodyFields), entry.operationId);
      for (const field of entry.requiredFields ?? [])
        assert.ok(entry.bodyFields.includes(field), `${entry.operationId} requires ${field}`);
    }
  }
  assert.equal(PUBLIC_API_VERSION, 'v1');
  assert.equal(PUBLIC_API_PREFIX, '/api/v1');
});

test('mutation allowlists are closed against the native action list', async () => {
  const native = await nativeMutationActions();
  assert.ok(native.has('work.attach'), 'native fixture must include the internal action');
  native.delete('work.attach');
  assert.deepEqual(new Set(Object.keys(roadmapMutationFields)), native);
  for (const [action, spec] of Object.entries(roadmapMutationFields)) {
    assert.ok(Array.isArray(spec.fields) && !spec.fields.includes('cwd'), action);
    assert.ok(!spec.fields.includes('actor') && !spec.fields.includes('action'), action);
    assert.ok(!spec.fields.includes('expectedRevision'), action);
    for (const field of spec.required ?? []) assert.ok(spec.fields.includes(field), action);
  }
});

test('validatePublicApiBody rejects unknown and missing fields', () => {
  assert.deepEqual(validatePublicApiBody('nope', {}), {
    ok: false,
    status: 404,
    code: 'not_found',
    error: 'Unknown operation: nope.',
  });
  assert.equal(validatePublicApiBody('stop', {}).ok, true);
  assert.equal(validatePublicApiBody('stop', undefined).ok, true);
  const extra = validatePublicApiBody('stop', { force: true });
  assert.equal(extra.ok, false);
  assert.equal(extra.status, 400);
  assert.equal(extra.code, 'invalid_request');
  const missing = validatePublicApiBody('createRun', { requestId: 'abcdefghijklmnop' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Missing required field: message/);
  const badId = validatePublicApiBody('createRun', { requestId: 'short', message: 'hi' });
  assert.equal(badId.ok, false);
  const forbidden = validatePublicApiBody('createRun', {
    requestId: 'abcdefghijklmnop',
    message: 'hi',
    images: [],
  });
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.error, /Unknown field: images/);
});

test('validatePublicApiBody checks interaction, message and work scalars', () => {
  const id = 'abcdefghijklmnop';
  assert.equal(validatePublicApiBody('interaction', { id: 'q1', response: { cancelled: true } }).ok, true);
  assert.equal(validatePublicApiBody('interaction', { id: 'q1', response: { confirmed: false } }).ok, true);
  assert.equal(validatePublicApiBody('interaction', { id: 'q1', response: { value: 'A' } }).ok, true);
  assert.equal(
    validatePublicApiBody('interaction', { id: 'q1', response: { value: 'A', extra: 1 } }).ok,
    false,
  );
  assert.equal(
    validatePublicApiBody('sendMessage', { requestId: id, mode: 'bogus', message: 'hi' }).ok,
    false,
  );
  assert.equal(
    validatePublicApiBody('sendMessage', { requestId: id, mode: 'steer', message: 'hi' }).ok,
    true,
  );
  const work = {
    requestId: id,
    expectedRevision: 3,
    targets: [{ kind: 'plan', planId: 'plan-abc' }],
  };
  assert.equal(validatePublicApiBody('roadmapWork', work).ok, true);
  assert.equal(validatePublicApiBody('roadmapWork', { ...work, cwd: '/tmp' }).ok, false);
  const mutation = validatePublicApiBody('mutateRoadmap', {
    action: 'step.check',
    expectedRevision: 0,
    planId: 'plan-abc',
    stepId: 'step-1',
    done: true,
  });
  assert.equal(mutation.ok, true);
  assert.equal(
    validatePublicApiBody('mutateRoadmap', { action: 'work.attach', expectedRevision: 0 }).ok,
    false,
  );
  assert.equal(validatePublicApiBody('mutateRoadmap', { action: 'vision', expectedRevision: 0 }).ok, false);
});

test('mutateRoadmap rejects prototype-chain actions without crashing', () => {
  for (const action of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const result = validatePublicApiBody('mutateRoadmap', { action, expectedRevision: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'invalid_request');
  }
});

test('mutation schemas are fully typed and match the contract allowlists', () => {
  const document = generateOpenApi();
  const mutations =
    document.paths['/api/v1/projects/{projectId}/roadmap/mutations'].post.requestBody.content[
      'application/json'
    ].schema.oneOf;
  assert.equal(mutations.length, Object.keys(roadmapMutationFields).length);
  const empty = [];
  const walk = (schema, where) => {
    if (!schema || typeof schema !== 'object') return;
    if (schema.$ref) return;
    if (Array.isArray(schema.oneOf)) return schema.oneOf.forEach((entry) => walk(entry, where));
    if (schema.type === 'object' && !schema.properties) empty.push(where);
    if (schema.properties)
      for (const [key, entry] of Object.entries(schema.properties))
        if (entry && typeof entry === 'object' && !entry.$ref && !entry.type && !entry.oneOf && !entry.enum)
          empty.push(`${where}.${key}`);
    if (schema.items) walk(schema.items, `${where}[]`);
  };
  for (const schema of mutations) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      [
        'action',
        'expectedRevision',
        ...roadmapMutationFields[schema.properties.action.enum[0]].fields,
      ].sort(),
    );
    walk(schema, `mutation ${schema.properties.action.enum[0]}`);
  }
  assert.deepEqual(empty, []);
});

test('step.check needs exactly one of stepId/stepIds; unknown mutation fields reject', () => {
  const base = { action: 'step.check', expectedRevision: 0, planId: 'plan-abc', done: true };
  assert.equal(validatePublicApiBody('mutateRoadmap', { ...base, stepId: 'step-1' }).ok, true);
  assert.equal(validatePublicApiBody('mutateRoadmap', { ...base, stepIds: ['step-1'] }).ok, true);
  assert.equal(validatePublicApiBody('mutateRoadmap', base).ok, false);
  assert.equal(
    validatePublicApiBody('mutateRoadmap', { ...base, stepId: 'step-1', stepIds: ['step-1'] }).ok,
    false,
  );
  assert.equal(
    validatePublicApiBody('mutateRoadmap', {
      action: 'vision',
      expectedRevision: 0,
      text: 'v',
      bogus: 1,
    }).ok,
    false,
  );
});

test('Model schema matches the native catalog projection', () => {
  const schema = generateOpenApi().components.schemas.Model;
  assert.deepEqual(schema.required, ['id']);
  assert.ok(!('thinking' in schema.properties), 'catalog uses thinkingLevels, not thinking');
  assert.deepEqual(schema.properties.reasoning, { type: 'boolean' });
  assert.deepEqual(schema.properties.thinkingLevels, {
    type: 'array',
    items: { type: 'string', enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  });
  for (const field of ['name', 'provider', 'input', 'contextWindow', 'availability'])
    assert.ok(field in schema.properties, field);
});

test('x-required-scopes derive from publicApiOperations, not a static matrix', () => {
  const document = generateOpenApi();
  const seen = new Set();
  for (const item of Object.values(document.paths))
    for (const operation of Object.values(item)) {
      const expected = publicApiOperations.find(
        (entry) => entry.operationId === operation.operationId,
      ).scopes;
      assert.deepEqual(operation['x-required-scopes'], expected);
      seen.add(operation.operationId);
    }
  assert.equal(seen.size, publicApiOperations.length);
});

test('openapi paths cover every operation exactly once', () => {
  const document = generateOpenApi();
  const covered = [];
  for (const [path, item] of Object.entries(document.paths))
    for (const [method, operation] of Object.entries(item))
      covered.push(`${method} ${operation.operationId}`);
  const expected = publicApiOperations.map((entry) => `${entry.method.toLowerCase()} ${entry.operationId}`);
  assert.deepEqual(covered.sort(), expected.sort());
});

test('step.check accepts an optional caller sessionId; other actions keep their meaning', () => {
  assert.deepEqual(roadmapMutationFields['step.check'].fields.includes('sessionId'), true);
  const base = { action: 'step.check', expectedRevision: 0, planId: 'plan-abc', stepId: 'step-1', done: true };
  assert.equal(validatePublicApiBody('mutateRoadmap', base).ok, true);
  assert.equal(validatePublicApiBody('mutateRoadmap', { ...base, sessionId: 'native-session' }).ok, true);
  assert.equal(
    validatePublicApiBody('mutateRoadmap', { ...base, sessionId: 'bad id!' }).ok,
    false,
  );
  // Other actions do not gain sessionId: vision stays closed.
  assert.equal(
    validatePublicApiBody('mutateRoadmap', { action: 'vision', expectedRevision: 0, text: 'v', sessionId: 'native-session' })
      .ok,
    false,
  );
  // Existing sessionId meanings are unchanged.
  assert.equal(
    validatePublicApiBody('mutateRoadmap', { action: 'plan.attach', expectedRevision: 0, planId: 'plan-abc', sessionId: 'native-session' })
      .ok,
    true,
  );
  const work = {
    requestId: 'abcdefghijklmnop',
    expectedRevision: 0,
    targets: [{ kind: 'plan', planId: 'plan-abc' }],
    sessionId: 'native-session',
  };
  assert.equal(validatePublicApiBody('roadmapWork', work).ok, true);
});

test('completion, machineId and completedAt are output-only and never accepted', () => {
  const base = { action: 'step.check', expectedRevision: 0, planId: 'plan-abc', stepId: 'step-1', done: true };
  for (const forged of [
    { ...base, completion: null },
    { ...base, machineId: 'm' },
    { ...base, completedAt: 1 },
    { ...base, sessionId: 'native-session', completion: { machineId: 'm', sessionId: null, completedAt: 1 } },
  ])
    assert.equal(validatePublicApiBody('mutateRoadmap', forged).ok, false);
  assert.equal(
    validatePublicApiBody('mutateRoadmap', {
      action: 'plan.create',
      expectedRevision: 0,
      title: 'T',
      steps: [{ text: 'hi', completion: null }],
    }).ok,
    false,
  );
  assert.equal(
    validatePublicApiBody('mutateRoadmap', {
      action: 'plan.steps',
      expectedRevision: 0,
      planId: 'plan-abc',
      steps: [{ id: 'step-1', text: 'hi', done: false, children: [], machineId: 'm' }],
    }).ok,
    false,
  );
  assert.equal(
    validatePublicApiBody('mutateRoadmap', {
      action: 'backlog.add',
      expectedRevision: 0,
      items: [{ text: 'hi', completedAt: 5 }],
    }).ok,
    false,
  );
  assert.equal(
    validatePublicApiBody('roadmapWork', {
      requestId: 'abcdefghijklmnop',
      expectedRevision: 0,
      targets: [{ kind: 'plan', planId: 'plan-abc' }],
      completion: null,
    }).ok,
    false,
  );
});

test('RoadmapStep input stays closed; completion lives in output schemas only', () => {
  const document = generateOpenApi();
  const input = document.components.schemas.RoadmapStep;
  assert.equal(input.additionalProperties, false);
  assert.ok(!('completion' in input.properties));
  assert.ok(!('machineId' in input.properties));
  assert.ok(!('completedAt' in input.properties));
  const completion = document.components.schemas.RoadmapCompletion;
  // OAS 3.0.x: nullable object, never { type: 'null' }.
  assert.equal(completion.type, 'object');
  assert.equal(completion.nullable, true);
  assert.equal(completion.readOnly, true);
  assert.deepEqual(completion.required, ['machineId', 'sessionId', 'completedAt']);
  assert.equal(completion.additionalProperties, false);
  assert.equal(completion.properties.sessionId.nullable, true);
  const output = document.components.schemas.RoadmapOutputStep;
  assert.ok('completion' in output.properties);
  assert.ok(!('allOf' in output));
  assert.ok(!('oneOf' in output.properties.completion));
  assert.equal(output.properties.completion.$ref, '#/components/schemas/RoadmapCompletion');
  assert.deepEqual(output.required, ['id', 'text', 'done', 'completion', 'children']);
  const childrenRef = output.properties.children.items.$ref;
  assert.equal(childrenRef, '#/components/schemas/RoadmapOutputStep');
  // OAS 3.0.x forbids { type: 'null' }: walk the whole document.
  const nullTypes = [];
  const forbidNull = (schema, where) => {
    if (!schema || typeof schema !== 'object') return;
    if (schema.type === 'null') nullTypes.push(where);
    if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((entry, index) => forbidNull(entry, `${where}.oneOf[${index}]`));
    if (schema.properties)
      for (const [key, entry] of Object.entries(schema.properties)) forbidNull(entry, `${where}.${key}`);
    if (schema.items) forbidNull(schema.items, `${where}[]`);
  };
  forbidNull(document.components.schemas, 'schemas');
  for (const [path, item] of Object.entries(document.paths))
    for (const [method, operation] of Object.entries(item)) {
      if (operation.requestBody) forbidNull(operation.requestBody, `${method} ${path} request`);
      for (const [status, response] of Object.entries(operation.responses || {}))
        forbidNull(response, `${method} ${path} ${status}`);
    }
  assert.deepEqual(nullTypes, []);
  const docSchema = document.components.schemas.RoadmapDocument;
  assert.ok(docSchema.properties.plans);
  assert.equal(document.components.schemas.Roadmap.properties.roadmap.$ref, '#/components/schemas/RoadmapDocument');
  assert.equal(
    document.components.schemas.RoadmapWorkAccept.properties.roadmap.$ref,
    '#/components/schemas/RoadmapDocument',
  );
  // Request mutations still reference the closed input step, not the output.
  const mutations =
    document.paths['/api/v1/projects/{projectId}/roadmap/mutations'].post.requestBody.content[
      'application/json'
    ].schema.oneOf;
  const refs = [];
  const collect = (schema) => {
    if (!schema || typeof schema !== 'object') return;
    if (schema.$ref) refs.push(schema.$ref);
    if (Array.isArray(schema.oneOf)) schema.oneOf.forEach(collect);
    if (schema.properties) Object.values(schema.properties).forEach(collect);
    if (schema.items) collect(schema.items);
  };
  mutations.forEach(collect);
  assert.ok(refs.includes('#/components/schemas/RoadmapStep'));
  assert.ok(!refs.includes('#/components/schemas/RoadmapOutputStep'));
  assert.ok(!refs.includes('#/components/schemas/RoadmapCompletion'));
});

test('forged-key guard never recurses into RangeError on deeply nested bodies', () => {
  let deep = { text: 'leaf' };
  for (let depth = 0; depth < 5000; depth++) deep = { nest: deep };
  const body = { action: 'plan.create', expectedRevision: 0, title: 'T', steps: [deep] };
  let result;
  assert.doesNotThrow(() => {
    result = validatePublicApiBody('mutateRoadmap', body);
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  let hidden = { text: 'leaf' };
  for (let depth = 0; depth < 5000; depth++) hidden = { nest: hidden };
  hidden.completion = null;
  const forged = { action: 'plan.create', expectedRevision: 0, title: 'T', steps: [hidden] };
  let rejected;
  assert.doesNotThrow(() => {
    rejected = validatePublicApiBody('mutateRoadmap', forged);
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 400);
});
