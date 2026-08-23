/**
 * The one place this package turns parsed JSON into domain values.
 *
 * Everything `@agent-proxy/claude-core` reads from disk or from an API — audit
 * sidecars, `.nodes.jsonl` records, the suggestion-status store, GitHub
 * payloads, hook and plugin settings — arrives as text. Each of those readers
 * used to re-derive the same primitive facts inline, so a single malformed
 * field was checked in a dozen slightly different ways. The decoders below are
 * that check, written once: a reader parses at its boundary with
 * `parseJsonText`, then works in `JsonValue`/`JsonObject` and asks these
 * functions for the field it wants.
 */

/**
 * A value that came out of `JSON.parse` and has not been given a domain meaning
 * yet. The union enumerates exactly the six productions the JSON grammar can
 * yield, which is what makes the assertion in `parseJsonText` sound.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/**
 * A JSON object's member map. `noUncheckedIndexedAccess` is on repo-wide, so
 * reading a key yields `JsonValue | undefined` — which is exactly the input
 * every decoder below accepts.
 */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * Read a JSON document. Returns `null` when the text is not JSON at all, so one
 * corrupt file is skipped rather than aborting the run that walked into it.
 */
export function parseJsonText(text: string): JsonValue | null {
  try {
    // SAFETY: `JSON.parse` is typed `any`, but the values it can actually
    // produce are only objects, arrays, strings, numbers, booleans and null —
    // the six members `JsonValue` lists. Nothing else can come back from it, and
    // a text that is not JSON throws instead of returning, which the catch takes.
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

/** Accept a value a caller already parsed and carry it into the JSON domain. */
export function jsonValueOf<Candidate>(value: Candidate): JsonValue {
  // SAFETY: every caller passes the result of a `JSON.parse` it performed itself,
  // so the runtime value is one of the six JSON productions. The decoders below
  // re-check the production before any field is read, so a caller that breaks
  // that promise gets `null` rather than a wrong value.
  return value as JsonValue;
}

/*
 * The three `typeof` operators below are the only ones left in this package,
 * and they are deliberate. `anti-slop/no-runtime-typeof` asks that external
 * values be decoded at their I/O boundary so callers can branch on a domain
 * value instead of on a representation — this module is that boundary. Once a
 * JSON string and a JSON number are both in hand as `JsonValue`, JavaScript
 * offers no other operator that tells them apart, so the check has to happen
 * somewhere; confining it to three lines here is what lets every reader
 * downstream branch on `string | null` instead. `jsonBoolean` and `jsonArray`
 * need no exemption because `=== true` and `Array.isArray` already say it.
 */

/** The string this value is, or `null` when it is any other JSON production. */
export function jsonText(value: JsonValue | undefined): string | null {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  return typeof value === 'string' ? value : null;
}

/**
 * The finite number this value is, or `null` otherwise. Infinities and `NaN`
 * cannot survive a JSON round trip, so a non-finite number here means a caller
 * built the value in memory and the field is not trustworthy either way.
 */
export function jsonNumber(value: JsonValue | undefined): number | null {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The boolean this value is, or `null` when it is any other JSON production. */
export function jsonBoolean(value: JsonValue | undefined): boolean | null {
  return value === true || value === false ? value : null;
}

/** The member map this value is — arrays and `null` are not objects here. */
export function jsonObject(value: JsonValue | undefined): JsonObject | null {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

/** The element list this value is, or `null` when it is not a JSON array. */
export function jsonArray(value: JsonValue | undefined): readonly JsonValue[] | null {
  return Array.isArray(value) ? value : null;
}

/**
 * Field readers. Each takes a possibly-absent object so a caller can chain from
 * `jsonObject(...)` without a null check, and each falls back to the empty value
 * for its type — the reading these files want almost everywhere, since a
 * missing field in a legacy record means "not recorded", not "invalid".
 */

/** This field's string, or `''` when absent or of another type. */
export function textAt(source: JsonObject | null, key: string): string {
  return source === null ? '' : (jsonText(source[key]) ?? '');
}

/** This field's finite number, or `fallback` (default `0`) when absent. */
export function numberAt(source: JsonObject | null, key: string, fallback = 0): number {
  return source === null ? fallback : (jsonNumber(source[key]) ?? fallback);
}

/** True only when this field is literally `true`. */
export function booleanAt(source: JsonObject | null, key: string): boolean {
  return source !== null && source[key] === true;
}

/** This field's member map, or `null` when absent or of another type. */
export function objectAt(source: JsonObject | null, key: string): JsonObject | null {
  return source === null ? null : jsonObject(source[key]);
}

/** This field's elements, or an empty list when absent or of another type. */
export function arrayAt(source: JsonObject | null, key: string): readonly JsonValue[] {
  return source === null ? [] : (jsonArray(source[key]) ?? []);
}

/** Every own entry of this object, in insertion order. */
export function jsonEntries(source: JsonObject | null): readonly (readonly [string, JsonValue])[] {
  return source === null ? [] : Object.entries(source);
}
