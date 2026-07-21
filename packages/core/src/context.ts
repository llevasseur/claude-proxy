import { isAuditSidecar, type AuditSidecar } from "./types.js";

/**
 * "Context size" analytics: how large the prompt sent to the model gets.
 * The headline metric is `realInput` (input + cacheRead + cacheCreation), the
 * true prompt size that fills the model's context window.
 *
 * Pure: no I/O, no clock. The server maps sidecars → {@link ContextEntry} (it
 * owns the filenames) and hands them here.
 */

/** One request's context facts, keyed by its sidecar base name for drill-down. */
export interface ContextEntry {
  /** Sidecar base name (`<stamp>_anthropic`) — the drill-down handle. */
  file: string;
  timestamp: string;
  model: string;
  /** input + cacheRead + cacheCreation — the true prompt size. */
  realInput: number;
  systemBytes: number;
  toolsBytes: number;
  totalBytes: number;
  toolCount: number;
}

export interface ContextSummary {
  requestCount: number;
  avgRealInput: number;
  medianRealInput: number;
  maxRealInput: number;
  /** The single largest-context request, or null when there were none. */
  max: ContextEntry | null;
  /** Largest requests first, capped at `topN`. */
  top: ContextEntry[];
}

export interface SummarizeContextOptions {
  /** How many of the largest requests to include in `top`. Default 10. */
  topN?: number;
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/** Aggregate context entries into averages, the peak, and the largest N. Pure. */
export function summarizeContext(
  entries: readonly ContextEntry[],
  opts: SummarizeContextOptions = {},
): ContextSummary {
  const topN = opts.topN ?? 10;
  const requestCount = entries.length;

  if (requestCount === 0) {
    return { requestCount: 0, avgRealInput: 0, medianRealInput: 0, maxRealInput: 0, max: null, top: [] };
  }

  const sortedTokens = entries.map((e) => e.realInput).sort((a, b) => a - b);
  const sum = sortedTokens.reduce((n, v) => n + v, 0);
  const byLargest = [...entries].sort((a, b) => b.realInput - a.realInput);

  return {
    requestCount,
    avgRealInput: Math.round(sum / requestCount),
    medianRealInput: median(sortedTokens),
    maxRealInput: sortedTokens[sortedTokens.length - 1]!,
    max: byLargest[0]!,
    top: byLargest.slice(0, topN),
  };
}

/**
 * Map an audit sidecar to a {@link ContextEntry}. Returns null for a malformed
 * sidecar so callers can skip it. `file` is the sidecar's base name, supplied
 * by the caller (the sidecar itself doesn't carry its filename).
 */
export function toContextEntry(sidecar: unknown, file: string): ContextEntry | null {
  if (!isAuditSidecar(sidecar)) return null;
  const s: AuditSidecar = sidecar;
  return {
    file,
    timestamp: s.timestamp,
    model: s.model,
    realInput: s.tokens.realInput,
    systemBytes: s.request.systemBytes,
    toolsBytes: s.request.toolsBytes,
    totalBytes: s.request.totalBytes,
    toolCount: s.request.toolCount,
  };
}

// Raw-request breakdown — "why was this one so large?"

export interface BreakdownTool {
  name: string;
  bytes: number;
  estTokens: number;
}

export interface BreakdownMessage {
  index: number;
  role: string;
  bytes: number;
  estTokens: number;
}

export interface RequestBreakdown {
  totalBytes: number;
  systemBytes: number;
  toolsBytes: number;
  toolCount: number;
  messageCount: number;
  tools: BreakdownTool[];
  messages: BreakdownMessage[];
}

/** UTF-8 byte length, portable across Node and the browser (matches the proxy's
 * `Buffer.byteLength` for JSON strings). */
function byteLength(value: unknown): number {
  if (value === undefined) return 0;
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Rough token estimate for display — matches the proxy's `estTokens`. */
export const estTokens = (bytes: number): number => Math.round(bytes / 4);

/**
 * Break a captured request body into its size-contributing regions: the system
 * prompt, each tool schema, and each conversation message. Pure and tolerant of
 * malformed shapes — missing/renamed fields yield zeros rather than throwing.
 */
export function analyzeRequestBody(body: unknown): RequestBreakdown {
  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const rawTools = Array.isArray(obj.tools) ? obj.tools : [];
  const tools: BreakdownTool[] = rawTools
    .map((t) => {
      const bytes = byteLength(t);
      const name =
        typeof t === "object" && t !== null && typeof (t as { name?: unknown }).name === "string"
          ? (t as { name: string }).name
          : "(unnamed)";
      return { name, bytes, estTokens: estTokens(bytes) };
    })
    .sort((a, b) => b.bytes - a.bytes);

  const rawMessages = Array.isArray(obj.messages) ? obj.messages : [];
  const messages: BreakdownMessage[] = rawMessages.map((m, index) => {
    const bytes = byteLength(m);
    const role =
      typeof m === "object" && m !== null && typeof (m as { role?: unknown }).role === "string"
        ? (m as { role: string }).role
        : "unknown";
    return { index, role, bytes, estTokens: estTokens(bytes) };
  });

  const toolsBytes = tools.reduce((n, t) => n + t.bytes, 0);
  const systemBytes = obj.system !== undefined ? byteLength(obj.system) : 0;
  const totalBytes = byteLength(obj);

  return {
    totalBytes,
    systemBytes,
    toolsBytes,
    toolCount: tools.length,
    messageCount: messages.length,
    tools,
    messages,
  };
}

export interface RequestMessageDetail {
  index: number;
  role: string;
  bytes: number;
  estTokens: number;
  /** How many messages the request had. */
  messageCount: number;
  /** The full message object, pretty-printed as JSON. */
  content: string;
}

/**
 * Pull one conversation message from a parsed request body by position, with
 * its full content (pretty-printed JSON) and the same size facts
 * {@link analyzeRequestBody} reports. Returns null for a missing messages array
 * or out-of-range `index`. Pure and tolerant of malformed shapes.
 */
export function extractRequestMessage(body: unknown, index: number): RequestMessageDetail | null {
  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const rawMessages = Array.isArray(obj.messages) ? obj.messages : [];
  if (!Number.isInteger(index) || index < 0 || index >= rawMessages.length) return null;

  const m = rawMessages[index];
  const bytes = byteLength(m);
  const role =
    typeof m === "object" && m !== null && typeof (m as { role?: unknown }).role === "string"
      ? (m as { role: string }).role
      : "unknown";
  return { index, role, bytes, estTokens: estTokens(bytes), messageCount: rawMessages.length, content: JSON.stringify(m, null, 2) };
}
