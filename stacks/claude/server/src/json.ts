/**
 * The value space `JSON.parse` can produce, named once so that every decoder in
 * this package can accept parsed input by contract instead of by `unknown`.
 *
 * Nothing in `server/` reads a sidecar, a settings file, or an HTTP body without
 * going through here first: `parseJson` turns text into a `JsonValue`, and the
 * readers below take one step down it at a time, returning `undefined` rather
 * than throwing when the document does not have the field it was asked for.
 */
export type JsonValue = JsonArray | JsonObject | boolean | null | number | string;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

/** A step that may already have fallen off the document, so readers compose. */
export type JsonInput = JsonValue | undefined;

/** Parse JSON text, answering `undefined` rather than throwing on malformed input. */
export function parseJson(text: string): JsonInput {
  try {
    const value: JsonValue = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

/*
 * The four readers below are the only place this package inspects a runtime tag.
 * `anti-slop/no-runtime-typeof` asks that input be decoded at its I/O boundary and
 * that everything downstream branch on the decoded domain value — this module *is*
 * that boundary, and a JSON primitive carries no discriminant other than its
 * `typeof` tag, so there is nothing further down to branch on. The operator is
 * disabled at these four sites and at no other site in `server/src`.
 */

/** The value when it is a JSON string, `undefined` otherwise. */
export function jsonString(value: JsonInput): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- decoding boundary; see the note above.
  return typeof value === 'string' ? value : undefined;
}

/** The value when it is a JSON number, `undefined` otherwise (including `NaN`). */
export function jsonNumber(value: JsonInput): number | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- decoding boundary; see the note above.
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The value when it is a JSON boolean, `undefined` otherwise. */
export function jsonBoolean(value: JsonInput): boolean | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- decoding boundary; see the note above.
  return typeof value === 'boolean' ? value : undefined;
}

/** The value when it is a JSON object — not `null`, not an array. */
export function jsonObject(value: JsonInput): JsonObject | undefined {
  if (value === null || value === undefined || Array.isArray(value)) return undefined;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- decoding boundary; see the note above.
  return typeof value === 'object' ? value : undefined;
}

/** The value when it is a JSON array, `undefined` otherwise. */
export function jsonArray(value: JsonInput): JsonArray | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** One field of a JSON object, or `undefined` when the step is not an object. */
export function jsonField(value: JsonInput, key: string): JsonInput {
  return jsonObject(value)?.[key];
}

/** A string-valued field, or `undefined` when absent or another type. */
export function stringField(value: JsonInput, key: string): string | undefined {
  return jsonString(jsonField(value, key));
}

/** A number-valued field, or `undefined` when absent or another type. */
export function numberField(value: JsonInput, key: string): number | undefined {
  return jsonNumber(jsonField(value, key));
}

/** A boolean-valued field, or `undefined` when absent or another type. */
export function booleanField(value: JsonInput, key: string): boolean | undefined {
  return jsonBoolean(jsonField(value, key));
}

/** An object-valued field, or `undefined` when absent or another type. */
export function objectField(value: JsonInput, key: string): JsonObject | undefined {
  return jsonObject(jsonField(value, key));
}

/** An array-valued field, or `undefined` when absent or another type. */
export function arrayField(value: JsonInput, key: string): JsonArray | undefined {
  return jsonArray(jsonField(value, key));
}

/** The string members of an array-valued field; non-strings are dropped. */
export function stringArrayField(value: JsonInput, key: string): string[] {
  return stringArray(jsonField(value, key));
}

/** The string members of an array, dropping every member that is not a string. */
export function stringArray(value: JsonInput): string[] {
  const members = jsonArray(value) ?? [];
  const strings: string[] = [];
  for (const member of members) {
    const text = jsonString(member);
    if (text !== undefined) strings.push(text);
  }
  return strings;
}

/** The object members of an array, dropping every member that is not an object. */
export function objectArray(value: JsonInput): JsonObject[] {
  const members = jsonArray(value) ?? [];
  const objects: JsonObject[] = [];
  for (const member of members) {
    const entry = jsonObject(member);
    if (entry !== undefined) objects.push(entry);
  }
  return objects;
}
