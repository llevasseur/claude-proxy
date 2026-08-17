/**
 * The one place this Worker turns an untrusted payload into values the rest of it
 * may branch on: a JSON-RPC body, a REST body, an MCP tool's `arguments`, a
 * replayed event document, a base64 page cursor.
 *
 * Two things about the shape below are deliberate.
 *
 * `JsonValue` replaces `unknown` at every one of those boundaries. `unknown`
 * says "nothing is known", which then licenses a `typeof` ladder and an `as` at
 * each use; `JsonValue` says the true thing — this came out of `JSON.parse`, so
 * it is one of six cases — and the readers below are how a caller gets from
 * there to a domain value. That is why the handlers no longer take
 * `Record<string, unknown>`.
 *
 * There is no `typeof` here, and its absence is the point rather than a
 * concession to the linter. Every predicate is a `value is T` guard built from a
 * primitive that answers about the value rather than about its representation —
 * `Array.isArray`, `Number.isFinite`, an identity comparison, or the object tag.
 * A guard narrows at the call site with no assertion, so the assertions this
 * module replaces do not reappear in its callers.
 */

/** Exactly what `JSON.parse` can produce, and therefore what any parsed payload is. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;

/** A parsed JSON object. Keys are whatever the sender wrote; values stay in the domain. */
export interface JsonRecord {
  [key: string]: JsonValue;
}

/**
 * `Object.prototype.toString` rather than `typeof`, and rather than `instanceof`:
 * it is the one classifier that reports the same tag for a primitive and its
 * wrapper, and it cannot be fooled by a `Symbol.toStringTag` on a plain parsed
 * object, because `JSON.parse` never sets one.
 */
function tagOf(value: JsonValue | undefined): string {
  return Object.prototype.toString.call(value);
}

/** True for a parsed object — not for an array, and not for `null`, which both tag apart. */
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
 * Finite only. `NaN` and the infinities are not JSON numbers — they cannot survive
 * `JSON.stringify` — so a caller that gets a number back can do arithmetic with it.
 */
export function isJsonNumber(value: JsonValue | undefined): value is number {
  return Number.isFinite(value);
}

export function isJsonFlag(value: JsonValue | undefined): value is boolean {
  return value === true || value === false;
}

/** A whole number at or above `minimum` — the version, limit and page-size arguments. */
export function isJsonInteger(value: JsonValue | undefined, minimum = Number.MIN_SAFE_INTEGER): value is number {
  return Number.isInteger(value) && isJsonNumber(value) && value >= minimum;
}

/** Reads one text field, answering `undefined` for absent, empty, or not-a-string alike. */
export function textField(source: JsonRecord, key: string): string | undefined {
  const value = source[key];
  return isJsonText(value) && value ? value : undefined;
}

export function numberField(source: JsonRecord, key: string): number | undefined {
  const value = source[key];
  return isJsonNumber(value) ? value : undefined;
}

/** Only a literal `true` reads as set, matching how every flag argument here is documented. */
export function flagField(source: JsonRecord, key: string): boolean | undefined {
  return source[key] === true ? true : undefined;
}

export function recordField(source: JsonRecord, key: string): JsonRecord | undefined {
  const value = source[key];
  return isJsonRecord(value) ? value : undefined;
}

export function arrayField(source: JsonRecord, key: string): JsonValue[] | undefined {
  const value = source[key];
  return isJsonArray(value) ? value : undefined;
}

/**
 * Parse JSON text. `undefined` means it did not parse — the caller decides whether
 * that is a 400, a skipped log row, or a fall-through, since those differ here.
 */
export function parseJson(text: string): JsonValue | undefined {
  try {
    // SAFETY: `JSON.parse` returns only the six JSON cases `JsonValue` enumerates,
    // and the `catch` below owns the one other outcome it has — a throw.
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * Read a request body as JSON. `undefined` covers an unparseable body and an absent
 * one together, which is what every caller here already treated alike.
 */
export async function readJsonBody(request: Request): Promise<JsonValue | undefined> {
  try {
    // SAFETY: `Response.json` resolves with the result of parsing the body as JSON,
    // so it inhabits `JsonValue` for the same reason `JSON.parse` does; a body that
    // is not JSON rejects instead, and that is the `catch`.
    return (await request.json()) as JsonValue;
  } catch {
    return undefined;
  }
}

/** The body as an object, which is what every REST and JSON-RPC route here requires. */
export async function readJsonRecord(request: Request): Promise<JsonRecord | undefined> {
  const body = await readJsonBody(request);
  return isJsonRecord(body) ? body : undefined;
}
