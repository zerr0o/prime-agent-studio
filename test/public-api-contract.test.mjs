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
