/**
 * The Anthropic wire shapes this proxy reads, as types.
 *
 * Everything here is optional and several fields are a bare `JsonValue`,
 * deliberately: the proxy sees whatever the CLI sends, must forward it untouched,
 * and must degrade rather than throw on a body it does not recognise. These describe
 * what the code *looks at*, not a schema it enforces — the narrowing itself lives in
 * `json.ts`, so a field typed `JsonValue` here is read through `asText`/`asRecord`
 * and never trusted on sight.
 *
 * Every type below is an object type rather than an interface, so each stays
 * assignable to `JsonObject`: a rewritten `messages` array goes back into a
 * `RequestBody` field, and TypeScript only grants that implicit index signature to
 * an alias.
 *
 * Zero runtime dependencies — this module emits only `asArrayOf` and `firstHeader`.
 */

import type { JsonObject, JsonValue } from './json.ts';

/** One block of a message's `content` array. */
export type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: JsonValue;
  tool_use_id?: string;
  is_error?: boolean;
  content?: JsonValue;
  source?: JsonObject;
  cache_control?: JsonValue;
  [key: string]: JsonValue | undefined;
};

/** One turn. `content` is a bare string or a block array, depending on the client. */
export type WireMessage = {
  role?: string;
  content?: JsonValue;
  [key: string]: JsonValue | undefined;
};

/** A tool definition as it ships in every request — the proxy's main cut list. */
export type ToolDefinition = {
  name?: string;
  description?: string;
  input_schema?: JsonValue;
  [key: string]: JsonValue | undefined;
};

/** The billed token counts, as reported by the response. */
export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [key: string]: JsonValue | undefined;
};

/** A parsed `/v1/messages` request body. */
export type RequestBody = {
  model?: JsonValue;
  system?: JsonValue;
  tools?: JsonValue;
  messages?: JsonValue;
  metadata?: JsonObject | null;
  stream?: JsonValue;
  [key: string]: JsonValue | undefined;
};

/** Node hands back a string, a string array for repeated names, or nothing. */
export type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * Narrow a wire value to an array of `T`, treating anything else as empty. `T` is the
 * caller's claim about which wire field this is; every reader downstream goes through
 * `json.ts` for each member, so a member that turns out to be something else reads as
 * absent rather than being trusted.
 */
export function asArrayOf<T>(value: JsonValue | undefined): T[] {
  // SAFETY: `Array.isArray` establishes that this is an array before the element type
  // is claimed, and no reader dereferences a member without decoding it first.
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Read a header that may have been repeated, keeping the first value. */
export function firstHeader(headers: HeaderBag | undefined | null, name: string): string | null {
  const value = headers?.[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}
