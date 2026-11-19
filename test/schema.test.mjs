import test from 'node:test';
import assert from 'node:assert/strict';

import { projectSchema, projectToolParameters, openObjectSchema } from '../lib/schema.js';
import { CYCLIC_SCHEMA, NASTY_SCHEMA } from './fixtures/nasty-schema.mjs';

test('projects the hostile MCP inputSchema into the supported subset', () => {
  const out = projectToolParameters(NASTY_SCHEMA);

  assert.equal(out.type, 'object');
  assert.equal(out.additionalProperties, false);
  // 'ghost' is required but undeclared -> filtered out.
  assert.deepEqual(out.required, ['message']);

  // $ref resolved through $defs, annotations and nested required preserved.
  assert.deepEqual(out.properties.message, {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' }, level: { type: 'string', enum: ['info', 'warn'] } },
    required: ['text'],
  });

  // anyOf is unsupported: widen to "anything" rather than pick a branch.
  assert.deepEqual(out.properties.mode, {});

  // Nullable union collapses to the single non-null type.
  assert.equal(out.properties.tag.type, 'string');

  // Unsupported numeric/string keywords disappear; the type survives.
  assert.deepEqual(out.properties.count, { type: 'integer' });
  assert.deepEqual(out.properties.stamp, { type: 'string' });

  // Nested array/object structure is projected recursively.
  assert.equal(out.properties.nested.type, 'array');
  assert.equal(out.properties.nested.items.type, 'object');
  assert.equal(out.properties.nested.items.additionalProperties, false);
  assert.deepEqual(out.properties.nested.items.required, ['deep']);
  assert.equal(out.properties.nested.items.properties.deep.type, 'object');

  // A real oneOf is representable, so it survives.
  assert.equal(Array.isArray(out.properties.choice.oneOf), true);
  assert.equal(out.properties.choice.oneOf.length, 2);
  assert.deepEqual(out.properties.choice.oneOf[1], { type: 'integer' });
});

test('emits only keywords from the supported subset, recursively', () => {
  // The DSH subset is type/oneOf/properties/required/additionalProperties/
  // items/enum/const plus description/title/default.
  const allowed = new Set([
    'type',
    'oneOf',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'description',
    'title',
    'default',
  ]);

  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      assert.ok(allowed.has(key), `unsupported keyword "${key}" at ${path}`);
    }
    if (node.properties) {
      for (const [key, value] of Object.entries(node.properties)) walk(value, `${path}.${key}`);
    }
    if (node.items) walk(node.items, `${path}[]`);
    if (Array.isArray(node.oneOf)) node.oneOf.forEach((branch, i) => walk(branch, `${path}.oneOf[${i}]`));
  };

  walk(projectToolParameters(NASTY_SCHEMA), 'root');
});

test('cyclic $ref terminates instead of recursing forever', () => {
  const out = projectToolParameters(CYCLIC_SCHEMA);
  assert.equal(out.type, 'object');
  assert.equal(out.properties.start.type, 'object');
  // The cycle is cut, so the nested self-reference widens to an empty node.
  assert.deepEqual(out.properties.start.properties.b.properties.a, {});
});

test('dangling and remote $refs degrade to their local annotations', () => {
  const out = projectSchema({
    type: 'object',
    properties: {
      dangling: { $ref: '#/$defs/Missing', description: 'gone' },
      remote: { $ref: 'https://example.com/schema.json' },
    },
  });
  assert.deepEqual(out.properties.dangling, { description: 'gone' });
  assert.deepEqual(out.properties.remote, {});
});

test('allOf folds into a single object schema', () => {
  const out = projectSchema({
    allOf: [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
    ],
  });
  assert.equal(out.type, 'object');
  assert.deepEqual(Object.keys(out.properties).sort(), ['a', 'b']);
  assert.deepEqual([...out.required].sort(), ['a', 'b']);
});

test('non-object and missing schemas widen to an open object', () => {
  for (const input of [undefined, null, 'nonsense', { type: 'string' }, { type: 'array' }]) {
    assert.deepEqual(projectToolParameters(input), { type: 'object', additionalProperties: true });
  }
});

test('an object schema without properties stays open', () => {
  assert.deepEqual(projectSchema({ type: 'object', title: 'Nothing' }), {
    type: 'object',
    title: 'Nothing',
    additionalProperties: true,
  });
});

test('enum values are filtered to scalars', () => {
  const out = projectSchema({
    type: 'string',
    enum: ['a', 1, true, null, { nested: true }, ['x']],
  });
  assert.deepEqual(out.enum, ['a', 1, true, null]);
});

test('output schema is an open object in the supported subset', () => {
  assert.deepEqual(openObjectSchema(), { type: 'object', additionalProperties: true });
});
