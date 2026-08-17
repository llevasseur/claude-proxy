/**
 * The JSON value domain, and the accessors that decode a wire value into it.
 *
 * Everything this proxy reads is a parsed JSON document — a `/v1/messages` body, a
 * captured SSE frame, a `.state.json` sidecar — so one type describes all of it and
 * one small set of accessors is the only place a wire value is ever narrowed. A
 * caller asks for the domain it wants (`asText`, `asRecord`, …) and gets `null` when
 * the wire carried something else, so nothing downstream re-checks a representation.
 *
 * The narrowing reads each value's own internal class rather than its `typeof`,
 * because `typeof` answers `"object"` for `null`, for an array and for a plain object
 * alike — three cases this proxy has to tell apart on every request.
 *
 * Zero runtime dependencies — this module imports nothing.
 */

/**
 * An object as JSON carries it. A read is `JsonValue | undefined` because a key may
 * simply be absent, which is the shape `noUncheckedIndexedAccess` gives anyway.
 */
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** Any value `JSON.parse` can produce. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** `Object.prototype.toString` tag — `[object Null]`, `[object Array]`, `[object Object]`, … */
const internalClass = (value: JsonValue | undefined): string => Object.prototype.toString.call(value);

/** Parse a JSON document, or `null` when the bytes were not JSON at all. */
export function parseJson(text: string): JsonValue | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The value when the wire carried a JSON string, else null. */
export function asText(value: JsonValue | undefined): string | null {
  // SAFETY: `[object String]` is the internal class of a string primitive and of a
  // `String` wrapper alone, and neither `JSON.parse` nor a JSON literal produces a
  // wrapper — so the only union member still standing here is the primitive.
  return internalClass(value) === '[object String]' ? (value as string) : null;
}

/** The value when the wire carried a JSON number, else null. `NaN` and `Infinity` are not JSON. */
export function asNumber(value: JsonValue | undefined): number | null {
  // SAFETY: `Number.isFinite` coerces nothing — a numeric string, `true` and `null`
  // all fail it — so a true answer leaves `number` as the only member it can be.
  return Number.isFinite(value) ? (value as number) : null;
}

/** The value when the wire carried a JSON object — not an array, not null — else null. */
export function asRecord(value: JsonValue | undefined): JsonObject | null {
  // SAFETY: `[object Object]` separates a plain object from `null` (`[object Null]`)
  // and from an array (`[object Array]`), the two members a truthiness check alone
  // would have let through here.
  return internalClass(value) === '[object Object]' ? (value as JsonObject) : null;
}

/** The value when the wire carried a JSON array, else null. */
export function asList(value: JsonValue | undefined): JsonValue[] | null {
  return Array.isArray(value) ? value : null;
}

/** Whether the wire carried a value a one-line summary can print as it stands. */
export function isScalar(value: JsonValue | undefined): boolean {
  return value === true || value === false || asText(value) !== null || asNumber(value) !== null;
}
