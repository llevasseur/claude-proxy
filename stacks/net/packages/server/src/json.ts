// Decoding for the JSON that crosses this package's HTTP boundary. Callers
// branch on the parsed domain value these return rather than on a runtime
// representation tag, so a payload is classified once, here, and never
// re-derived at each use site.

/** A JSON object; the only payload shape `PUT /api/config` accepts. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** One JSON value, as `JSON.parse` can produce it. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

/**
 * The payload as a JSON object, or null when it is anything else.
 * `Object.prototype.toString` tags a plain object `[object Object]` and tags
 * arrays, null and every primitive differently, so one test excludes them all.
 */
export function asJsonObject(value: JsonValue | undefined): JsonObject | null {
  // SAFETY: the tag is `[object Object]` for a plain object alone, so `value`
  // here is neither null, nor an array, nor a primitive.
  return Object.prototype.toString.call(value) === '[object Object]' ? (value as JsonObject) : null;
}

/**
 * Whether the value is a JSON string. `String(x) === x` holds for string
 * primitives and for nothing else: every other value stringifies to something
 * that fails the identity comparison.
 */
export function isJsonString(value: JsonValue): value is string {
  return String(value) === value;
}

/**
 * The value as a safe integer, or null when it is not one.
 * `Number.isSafeInteger` accepts any input and answers false — without
 * coercing — for everything that is not an integral number.
 */
export function asSafeInteger(value: JsonValue): number | null {
  // SAFETY: `Number.isSafeInteger` answers true for number primitives alone.
  return Number.isSafeInteger(value) ? (value as number) : null;
}
