// Decoding for the JSON that crosses this package's HTTP boundary. A payload is
// classified once here; callers branch on the parsed value, not on a runtime tag.

/** A JSON object; the only payload shape `PUT /api/config` accepts. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** One JSON value, as `JSON.parse` can produce it. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

/**
 * The payload as a JSON object, or null when it is anything else.
 * `Object.prototype.toString` tags a plain object `[object Object]`, and arrays,
 * null and every primitive differently, so one test excludes them all.
 */
export function asJsonObject(value: JsonValue | undefined): JsonObject | null {
  // SAFETY: the tag is `[object Object]` for a plain object alone, so `value`
  // here is neither null, nor an array, nor a primitive.
  return Object.prototype.toString.call(value) === '[object Object]' ? (value as JsonObject) : null;
}

/** Whether the value is a JSON string: `String(x) === x` holds for string primitives alone. */
export function isJsonString(value: JsonValue): value is string {
  return String(value) === value;
}

/**
 * The value as a safe integer, or null when it is not one. `Number.isSafeInteger`
 * answers false, without coercing, for everything that is not an integral number.
 */
export function asSafeInteger(value: JsonValue): number | null {
  // SAFETY: `Number.isSafeInteger` answers true for number primitives alone.
  return Number.isSafeInteger(value) ? (value as number) : null;
}
