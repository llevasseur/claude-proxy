/**
 * The Anthropic wire shapes this proxy reads, as types.
 *
 * Everything here is optional and several fields are `unknown`, deliberately: the
 * proxy sees whatever the CLI sends, must forward it untouched, and must degrade
 * rather than throw on a body it does not recognise. These describe what the code
 * *looks at*, not a schema it enforces.
 *
 * Zero runtime dependencies — this module emits nothing at all.
 */

/** One block of a message's `content` array. */
export interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  source?: { data?: unknown; media_type?: unknown };
  cache_control?: unknown;
  [key: string]: unknown;
}

/** One turn. `content` is a bare string or a block array, depending on the client. */
export interface WireMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

/** A tool definition as it ships in every request — the proxy's main cut list. */
export interface ToolDefinition {
  name?: string;
  description?: string;
  input_schema?: unknown;
  [key: string]: unknown;
}

/** The billed token counts, as reported by the response. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [key: string]: unknown;
}

/** A parsed `/v1/messages` request body. */
export interface RequestBody {
  model?: unknown;
  system?: unknown;
  tools?: unknown;
  messages?: unknown;
  metadata?: { user_id?: unknown } | null;
  stream?: unknown;
  [key: string]: unknown;
}

/** Node hands back a string, a string array for repeated names, or nothing. */
export type HeaderBag = Record<string, string | string[] | undefined>;

/** Narrow an `unknown` to an array of `T`, treating anything else as empty. */
export function asArrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Read a header that may have been repeated, keeping the first value. */
export function firstHeader(headers: HeaderBag | undefined | null, name: string): string | null {
  const value = headers?.[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}
