/**
 * An `inputSchema` packed with keywords the DSH schema subset does not support,
 * shared by the stub server and the projection tests so both assert against the
 * exact same document.
 */

export const NASTY_SCHEMA = {
  type: 'object',
  $defs: {
    Message: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        level: { type: 'string', enum: ['info', 'warn'] },
      },
      required: ['text'],
    },
  },
  properties: {
    message: { $ref: '#/$defs/Message' },
    // anyOf must widen to "anything", never silently pick a branch.
    mode: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    // nullable union -> plain string
    tag: { type: ['string', 'null'] },
    // unsupported numeric keywords are dropped
    count: { type: 'integer', minimum: 1, maximum: 10, multipleOf: 1 },
    // unsupported string keywords are dropped
    stamp: { type: 'string', format: 'date-time', pattern: '^\\d{4}' },
    // nested array-of-object with a $ref inside
    nested: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { deep: { $ref: '#/$defs/Message' } },
        required: ['deep'],
      },
    },
    // a genuine oneOf survives
    choice: { oneOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'integer' }] },
  },
  // 'ghost' is not a declared property and must be filtered out
  required: ['message', 'ghost'],
  additionalProperties: false,
};

/** Two definitions that reference each other; projection must terminate. */
export const CYCLIC_SCHEMA = {
  type: 'object',
  $defs: {
    A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
    B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
  },
  properties: { start: { $ref: '#/$defs/A' } },
};
