/**
 * Project an arbitrary JSON Schema — whatever an MCP server chose to publish —
 * onto the schema subset the DSH tool registry accepts.
 *
 * Supported subset (confirmed against dsh-keyless-search/lib/host.js and the
 * `JsonSchemaNode` contract exposed by the live Service Inspect provider):
 *
 *   type, oneOf, properties, required, additionalProperties, items,
 *   enum, const  —  plus the annotations description / title / default
 *
 * Everything else ($ref / $defs / definitions, allOf, anyOf, format, pattern,
 * minimum, prefixItems, ...) is resolved, folded, or dropped. Dropping a
 * constraint only *widens* what the model is allowed to send; the MCP server
 * still validates the call on its own side, so an over-permissive projection
 * degrades into a normal tool error instead of a broken tool schema.
 *
 * This module is pure and dependency-free so it can be unit-tested directly.
 */

/** Primitive JSON Schema types. */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** Every type name the subset understands. */
const ALL_TYPES = new Set([...SCALAR_TYPES, 'object', 'array']);

/** Hard recursion cap; deeper schemas degrade to "accept anything". */
const DEFAULT_MAX_DEPTH = 12;

/** Cap on how many properties / oneOf branches we are willing to mirror. */
const MAX_BRANCHES = 40;

/** True for a non-null, non-array object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` survives a JSON round trip unchanged. */
function isJsonValue(value) {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (kind === 'object') return Object.values(value).every(isJsonValue);
  return false;
}

/** Keep only scalars, which is all `enum` / `const` may hold. */
function toScalars(values) {
  if (!Array.isArray(values)) return [];
  return values.filter(
    (value) =>
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null,
  );
}

/**
 * Resolve a local JSON Pointer (`#/...`) against the schema document.
 * Returns `undefined` when the pointer is remote, malformed, or unresolvable.
 */
function resolvePointer(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  const segments = ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cursor = root;
  for (const segment of segments) {
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

/** Normalize a `type` that may be a string or a union array. */
function normalizeType(type) {
  if (typeof type === 'string') return ALL_TYPES.has(type) ? type : undefined;
  if (!Array.isArray(type)) return undefined;
  const named = [...new Set(type.filter((entry) => ALL_TYPES.has(entry) && entry !== 'null'))];
  if (named.length === 1) return named[0];
  // A real union (`["string","number"]`) has no single-type spelling in the
  // subset; dropping `type` widens the schema rather than lying about it.
  if (named.length === 0 && type.includes('null')) return 'null';
  return undefined;
}

/** Fold `allOf` into one object-ish schema (properties merge, required unions). */
function foldAllOf(node) {
  if (!Array.isArray(node.allOf) || node.allOf.length === 0) return node;
  const properties = isPlainObject(node.properties) ? { ...node.properties } : {};
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const merged = { ...node };
  delete merged.allOf;
  for (const branch of node.allOf) {
    if (!isPlainObject(branch)) continue;
    if (isPlainObject(branch.properties)) Object.assign(properties, branch.properties);
    if (Array.isArray(branch.required)) for (const key of branch.required) required.add(key);
    for (const key of ['type', 'items', 'additionalProperties', 'description', 'title']) {
      if (merged[key] === undefined && branch[key] !== undefined) merged[key] = branch[key];
    }
  }
  merged.properties = properties;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

/**
 * Project one schema node.
 *
 * @param node    the raw node
 * @param root    the document root, for `$ref` resolution
 * @param refPath refs already expanded on this branch (cycle guard)
 * @param depth   current recursion depth
 * @param maxDepth hard cap
 */
function projectNode(node, root, refPath, depth, maxDepth) {
  if (depth > maxDepth) return {};
  if (!isPlainObject(node)) return {};

  // --- $ref: expand, then let local sibling keywords refine the result ------
  if (typeof node.$ref === 'string') {
    if (refPath.has(node.$ref)) return {}; // cycle — widen instead of recursing
    const target = resolvePointer(root, node.$ref);
    if (target === undefined) {
      // Unresolvable (remote or dangling) ref: keep the local annotations only.
      const { $ref: _ignored, ...siblings } = node;
      return projectNode(siblings, root, refPath, depth, maxDepth);
    }
    const nextPath = new Set(refPath);
    nextPath.add(node.$ref);
    const { $ref: _ignored, ...siblings } = node;
    const resolved = projectNode(target, root, nextPath, depth, maxDepth);
    const local = projectNode(siblings, root, nextPath, depth, maxDepth);
    return { ...resolved, ...local };
  }

  const folded = foldAllOf(node);
  const out = {};

  // --- annotations ---------------------------------------------------------
  if (typeof folded.description === 'string' && folded.description !== '') {
    out.description = folded.description;
  }
  if (typeof folded.title === 'string' && folded.title !== '') {
    out.title = folded.title;
  }
  if (isJsonValue(folded.default) && folded.default !== undefined) {
    out.default = folded.default;
  }

  // --- const / enum --------------------------------------------------------
  const scalars = toScalars(folded.enum);
  if (scalars.length > 0) out.enum = scalars;
  if (
    typeof folded.const === 'string' ||
    typeof folded.const === 'number' ||
    typeof folded.const === 'boolean' ||
    folded.const === null
  ) {
    out.const = folded.const;
  }

  // --- type ----------------------------------------------------------------
  let type = normalizeType(folded.type);
  if (type === undefined) {
    if (isPlainObject(folded.properties)) type = 'object';
    else if (folded.items !== undefined) type = 'array';
  }
  if (type !== undefined) out.type = type;

  // --- union: oneOf survives, anyOf does not -------------------------------
  // `anyOf` is intentionally downgraded to "accept anything": the subset has no
  // anyOf, and picking one branch would silently forbid the others.
  if (Array.isArray(folded.oneOf) && folded.oneOf.length > 0) {
    const branches = [];
    let anyEmpty = false;
    for (const branch of folded.oneOf.slice(0, MAX_BRANCHES)) {
      const projected = projectNode(branch, root, refPath, depth + 1, maxDepth);
      if (Object.keys(projected).length === 0) anyEmpty = true;
      branches.push(projected);
    }
    // A branch that projects to `{}` means "any value", which makes the whole
    // oneOf vacuous — emitting it would only confuse the model.
    if (!anyEmpty && branches.length > 0) out.oneOf = branches;
  }

  // --- object --------------------------------------------------------------
  if (out.type === 'object' || (out.type === undefined && isPlainObject(folded.properties))) {
    const properties = {};
    if (isPlainObject(folded.properties)) {
      for (const [key, value] of Object.entries(folded.properties).slice(0, MAX_BRANCHES)) {
        properties[key] = projectNode(value, root, refPath, depth + 1, maxDepth);
      }
    }
    if (Object.keys(properties).length > 0) out.properties = properties;
    if (Array.isArray(folded.required)) {
      const required = [
        ...new Set(
          folded.required.filter(
            (key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(properties, key),
          ),
        ),
      ];
      if (required.length > 0) out.required = required;
    }
    // Mirror an explicit `false`; MCP's own default is permissive, so anything
    // else becomes an open object rather than an accidental no-extra-keys lock.
    out.additionalProperties = folded.additionalProperties === false ? false : true;
  }

  // --- array ---------------------------------------------------------------
  if (out.type === 'array') {
    if (isPlainObject(folded.items)) {
      out.items = projectNode(folded.items, root, refPath, depth + 1, maxDepth);
    } else if (Array.isArray(folded.items) && isPlainObject(folded.items[0])) {
      // Tuple form has no subset spelling; the first entry is the best guess.
      out.items = projectNode(folded.items[0], root, refPath, depth + 1, maxDepth);
    } else {
      out.items = {};
    }
  }

  return out;
}

/**
 * Project a full schema document.
 *
 * @param input   the raw schema (typically an MCP tool `inputSchema`)
 * @param options `{ maxDepth }`
 * @returns a schema node that only uses the supported subset
 */
export function projectSchema(input, options = {}) {
  const root = isPlainObject(input) ? input : {};
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  return projectNode(root, root, new Set(), 0, maxDepth);
}

/**
 * Project an MCP tool `inputSchema` into DSH tool `parameters`.
 *
 * DSH tools always take an object argument bag, so a missing or non-object
 * schema widens to an open object instead of producing an unusable tool.
 */
export function projectToolParameters(inputSchema) {
  const projected = projectSchema(inputSchema);
  if (projected.type !== 'object') {
    return { type: 'object', additionalProperties: true };
  }
  if (projected.properties === undefined) {
    projected.additionalProperties = true;
  }
  return projected;
}

/** The output schema used by every bridged tool: an open, lossless JSON object. */
export function openObjectSchema() {
  return { type: 'object', additionalProperties: true };
}
