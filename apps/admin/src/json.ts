/**
 * The one place the dashboard turns a payload it did not produce into values it
 * may branch on: an API response body, an error envelope, an SSE frame.
 *
 * `JsonValue` replaces `unknown` at those boundaries. `unknown` says "nothing is
 * known", which licenses a `typeof` ladder and an `as` at every use; `JsonValue`
 * says the true thing — this came out of `JSON.parse`, so it is one of six cases
 * — and the guards below are how a caller reaches a domain value from there.
 *
 * There is no `typeof` in this file, and that is the design rather than a
 * concession. Each predicate is a `value is T` guard over a primitive that
 * answers about the value rather than its representation, so it narrows at the
 * call site and the assertions this module replaces do not come back in its
 * callers.
 *
 * The typed `read`/`write` helpers in `./api` are the other half: they name a
 * route's response type from the manifest, so a caller that goes through them
 * needs nothing here. This is for the payloads no manifest describes.
 */

/** Exactly what `JSON.parse` can produce, and therefore what any parsed payload is. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;

/** A parsed JSON object. Keys are the sender's; values stay inside the domain. */
export interface JsonRecord {
  [key: string]: JsonValue;
}

/**
 * `Object.prototype.toString` rather than `typeof`, and rather than `instanceof`:
 * it reports one tag for a primitive and its wrapper alike, and a parsed object
 * carries no `Symbol.toStringTag` for it to trip over.
 */
function tagOf(value: JsonValue | undefined): string {
  return Object.prototype.toString.call(value);
}

/** True for a parsed object — not an array, and not `null`, both of which tag apart. */
export function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return tagOf(value) === '[object Object]';
}

export function isJsonArray(value: JsonValue | undefined): value is JsonValue[] {
  return Array.isArray(value);
}

export function isJsonText(value: JsonValue | undefined): value is string {
  return tagOf(value) === '[object String]';
}

/**
 * Finite only. `NaN` and the infinities cannot survive `JSON.stringify`, so they are
 * not values a payload can carry, and a caller may do arithmetic with what it gets.
 */
export function isJsonNumber(value: JsonValue | undefined): value is number {
  return Number.isFinite(value);
}

export function isJsonFlag(value: JsonValue | undefined): value is boolean {
  return value === true || value === false;
}

/** One text field, with absent, empty and not-a-string all answering `undefined`. */
export function textField(source: JsonRecord, key: string): string | undefined {
  const value = source[key];
  return isJsonText(value) && value ? value : undefined;
}

export function numberField(source: JsonRecord, key: string): number | undefined {
  const value = source[key];
  return isJsonNumber(value) ? value : undefined;
}

export function recordField(source: JsonRecord, key: string): JsonRecord | undefined {
  const value = source[key];
  return isJsonRecord(value) ? value : undefined;
}

/**
 * The `{ error }` envelope the server sends with a failing status. `undefined` means
 * the body carried no message, so the caller falls back to naming the status itself.
 */
export function errorMessage(body: JsonValue | undefined): string | undefined {
  return isJsonRecord(body) ? textField(body, 'error') : undefined;
}

/**
 * Parse JSON text. `undefined` means it did not parse; callers differ on whether that
 * is an error or a frame to skip, so this reports it rather than deciding.
 */
export function parseJson(text: string): JsonValue | undefined {
  try {
    // SAFETY: `JSON.parse` produces only the six JSON cases `JsonValue` enumerates;
    // its one other outcome is a throw, which this `catch` owns.
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * A response body as JSON, with a non-JSON body reported as `undefined` rather than
 * thrown — an error response is often HTML, and the status is still worth reporting.
 */
export async function readJsonBody(response: Response): Promise<JsonValue | undefined> {
  try {
    // SAFETY: `Response.json` resolves with the parse of the body, so it inhabits
    // `JsonValue` for the same reason `JSON.parse` does, and rejects otherwise.
    return (await response.json()) as JsonValue;
  } catch {
    return undefined;
  }
}
