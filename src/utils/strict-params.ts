import { z } from "zod";

/**
 * Strict tool parameters, applied at the registration choke point.
 *
 * Every tool here is registered with a zod *raw shape*; the MCP SDK turns that
 * into a plain `z.object(shape)`, whose default is to STRIP unknown keys. A
 * misspelled parameter (`timezone` for `timeZone`, `bcc_list` for `bcc`) is
 * therefore discarded silently and the call reports success.
 *
 * `strictifyRegisteredSchema` rebuilds a registered input schema so that every
 * object node — the top level and every nested object reachable through
 * optional / nullable / default / array / union wrappers — rejects unknown keys.
 * Leaves are reused by identity, so descriptions, defaults, enums and checks are
 * untouched; wrappers are cloned with their `def` intact (checks such as
 * `.min(1)` survive) and parented to the original, so registry metadata
 * (`.describe()`) is inherited.
 *
 * Objects that already declare a catchall (`.passthrough()`, `.strict()`,
 * `.catchall()`) are an explicit choice and are left alone. Node types this
 * walker does not know how to traverse (`z.preprocess`/`.transform`/`.pipe`,
 * `z.lazy`, `z.intersection`, `z.tuple`, and anything else added later) might
 * hide an object below them, so the walker cannot vouch for strictness past
 * that point — it throws immediately, naming the tool and the path, rather
 * than registering a tool whose nested strictness is merely unverified.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = any;

export interface StrictifyStats {
  /** Object nodes made strict (top level included). */
  objects: number;
  /** Object nodes left alone because they already declared a catchall. */
  explicitCatchall: number;
}

export function newStrictifyStats(): StrictifyStats {
  return { objects: 0, explicitCatchall: 0 };
}

/** Wrapper types whose single child lives at `def.innerType`. */
const INNER_TYPE_WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "nonoptional",
  "readonly",
  "catch",
]);

/** Leaf types: nothing below them can carry object keys. */
const LEAF_TYPES = new Set([
  "string",
  "number",
  "int",
  "boolean",
  "bigint",
  "date",
  "enum",
  "literal",
  "unknown",
  "any",
  "null",
  "undefined",
  "never",
  "void",
  "nan",
  "symbol",
  "file",
  "template_literal",
  // record keys are open by definition (a map), so nothing to make strict at
  // this level; its value schema is traversed below via `valueType`.
]);

function cloneWith(schema: AnySchema, patch: Record<string, unknown>): AnySchema {
  // Merge by property descriptor, not spread: some defs expose getters (a
  // `default` def's `defaultValue` re-evaluates function defaults per parse),
  // and a spread would freeze them into a single value.
  const def = Object.defineProperties(
    {},
    { ...Object.getOwnPropertyDescriptors(schema._zod.def), ...Object.getOwnPropertyDescriptors(patch) }
  );
  // `{ parent: schema }` makes the clone inherit registry metadata (.describe()).
  return schema.clone(def, { parent: schema });
}

function formatPath(path: ReadonlyArray<string | number>): string {
  return path.length === 0 ? "<root>" : path.join(".");
}

/**
 * Walks a schema and rebuilds every reachable object node as strict
 * (unknown keys rejected). `toolName` and `path` are used only to name the
 * offending tool/location if the walk hits a node type it cannot traverse.
 */
export function deepStrict(
  schema: AnySchema,
  stats: StrictifyStats,
  toolName = "<unknown>",
  path: ReadonlyArray<string | number> = []
): AnySchema {
  const def = schema?._zod?.def;
  if (!def) return schema;
  const type: string = def.type;

  if (type === "object") {
    if (def.catchall !== undefined) {
      stats.explicitCatchall++;
      return schema;
    }
    const shape: Record<string, AnySchema> = {};
    for (const [key, child] of Object.entries(def.shape as Record<string, AnySchema>)) {
      shape[key] = deepStrict(child, stats, toolName, [...path, key]);
    }
    stats.objects++;
    return cloneWith(schema, { shape, catchall: z.never() });
  }

  if (INNER_TYPE_WRAPPERS.has(type)) {
    const inner = deepStrict(def.innerType, stats, toolName, path);
    return inner === def.innerType ? schema : cloneWith(schema, { innerType: inner });
  }

  if (type === "array") {
    const element = deepStrict(def.element, stats, toolName, [...path, "[]"]);
    return element === def.element ? schema : cloneWith(schema, { element });
  }

  if (type === "union") {
    const options = (def.options as AnySchema[]).map((o, i) => deepStrict(o, stats, toolName, [...path, `|${i}`]));
    return options.every((o, i) => o === def.options[i]) ? schema : cloneWith(schema, { options });
  }

  if (type === "record") {
    const valueType = deepStrict(def.valueType, stats, toolName, [...path, "{}"]);
    return valueType === def.valueType ? schema : cloneWith(schema, { valueType });
  }

  if (!LEAF_TYPES.has(type)) {
    throw new Error(
      `strict-params: tool ${toolName} has a node of type "${type}" at ${formatPath(path)} that this choke ` +
        `point cannot traverse; it may hide an object that would stay non-strict, so registration is refused`
    );
  }
  return schema;
}

/**
 * Rebuilds a RegisteredTool's `inputSchema` (as produced by the SDK from a raw
 * shape) as a deep-strict object. Returns `undefined` for tools registered with
 * no schema at all — those receive `(extra)` instead of `(args, extra)`, so
 * adding a schema would change the callback's arity.
 *
 * Throws on a top-level schema that is not an object: that is a registration
 * form this choke point does not understand, and it must fail at startup rather
 * than register a tool with an unknown strictness posture. (A non-object node
 * found deeper in the walk is handled by `deepStrict` itself, the same way.)
 */
export function strictifyRegisteredSchema(
  toolName: string,
  inputSchema: AnySchema,
  stats: StrictifyStats
): AnySchema {
  if (inputSchema === undefined) return undefined;
  const def = inputSchema?._zod?.def;
  if (!def || def.type !== "object") {
    throw new Error(
      `strict-params: tool ${toolName} has a non-object input schema (type ${def?.type ?? "unknown"}); ` +
        `the registration choke point cannot make it strict`
    );
  }
  return deepStrict(inputSchema, stats, toolName);
}
