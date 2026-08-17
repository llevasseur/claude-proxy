import { arrayAt, type JsonValue, jsonObject, jsonText, jsonValueOf } from './json.js';
import { userPromptText } from './prompt-text.js';
import { type AuditSidecar, isAuditSidecar } from './types.js';

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
  /** Claude Code session id that sent it; null on legacy sidecars. */
  sessionId: string | null;
  /**
   * The transcript it is a turn of; null on legacy sidecars. A session id spans a
   * whole agent family, so this is the only handle that names one thread.
   */
  threadId: string | null;
  /**
   * What the person typed to open this request's thread, via
   * {@link attachContextPrompts}. Null until the server attaches it, and on a
   * request whose thread is unknown or recorded no opening prompt.
   */
  prompt: string | null;
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
  /** Every request, oldest first — the full list the context table sorts client-side. */
  entries: ContextEntry[];
}

/**
 * The summary's aggregate half — every field that does not depend on the entry
 * list's chronological order, and so can be answered without one.
 */
export interface ContextAggregates {
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
  /**
   * The aggregate half, already computed. Omitted, {@link aggregateContext} derives
   * it from `entries`.
   */
  aggregates?: ContextAggregates;
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * Count, mean, median, peak and largest-`topN` over the entries — in one pass,
 * **without sorting the entries themselves**. Pure.
 *
 * `max` is the running maximum and `top` a `topN`-slot list. **Insertion is on
 * strictly-greater**, which is what reproduces the old descending sort exactly:
 * `Array.prototype.sort` is stable, so a tie kept the entry that appeared first in
 * the read order, and refusing to displace an equal value keeps that same entry.
 *
 * The median needs order statistics, so the token values are collected and sorted —
 * numbers rather than entries.
 */
export function aggregateContext(entries: readonly ContextEntry[], opts: { topN?: number } = {}): ContextAggregates {
  const topN = opts.topN ?? 10;
  const requestCount = entries.length;

  if (requestCount === 0) {
    return { requestCount: 0, avgRealInput: 0, medianRealInput: 0, maxRealInput: 0, max: null, top: [] };
  }

  const tokens: number[] = [];
  const top: ContextEntry[] = [];
  let sum = 0;
  let max: ContextEntry | null = null;

  for (let i = 0; i < requestCount; i += 1) {
    const entry = entries[i]!;
    const value = entry.realInput;
    tokens.push(value);
    sum += value;
    // Strictly greater, so a tie keeps the earlier entry — the stable sort's answer.
    if (max === null || value > max.realInput) max = entry;
    if (topN <= 0) continue;
    if (top.length === topN && value <= top[top.length - 1]!.realInput) continue;
    let at = top.length;
    while (at > 0 && value > top[at - 1]!.realInput) at -= 1;
    top.splice(at, 0, entry);
    if (top.length > topN) top.pop();
  }

  tokens.sort((a, b) => a - b);

  return {
    requestCount,
    avgRealInput: Math.round(sum / requestCount),
    medianRealInput: median(tokens),
    maxRealInput: max!.realInput,
    max,
    top,
  };
}

/**
 * Aggregate context entries into averages, the peak, the largest N, and the full
 * chronological list. Pure.
 */
export function summarizeContext(entries: readonly ContextEntry[], opts: SummarizeContextOptions = {}): ContextSummary {
  const aggregates = opts.aggregates ?? aggregateContext(entries, opts);

  return {
    requestCount: aggregates.requestCount,
    avgRealInput: aggregates.avgRealInput,
    medianRealInput: aggregates.medianRealInput,
    maxRealInput: aggregates.maxRealInput,
    max: aggregates.max,
    top: aggregates.top,
    entries: [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
  };
}

/**
 * Map an audit sidecar to a {@link ContextEntry}. Returns null for a malformed
 * sidecar so callers can skip it. `file` is the sidecar's base name, supplied
 * by the caller (the sidecar itself doesn't carry its filename).
 */
export function toContextEntry<Candidate>(sidecar: Candidate, file: string): ContextEntry | null {
  if (!isAuditSidecar(sidecar)) return null;
  const s: AuditSidecar = sidecar;
  return {
    file,
    timestamp: s.timestamp,
    model: s.model,
    sessionId: s.session?.sessionId ?? null,
    threadId: s.session?.threadId ?? null,
    // A sidecar records who sent the request, never what was asked.
    prompt: null,
    realInput: s.tokens.realInput,
    systemBytes: s.request.systemBytes,
    toolsBytes: s.request.toolsBytes,
    totalBytes: s.request.totalBytes,
    toolCount: s.request.toolCount,
  };
}

/**
 * Fill each entry's {@link ContextEntry.prompt} from the opening prompts of the
 * threads they belong to, reduced by {@link userPromptText} to the part a person
 * typed. Keyed on thread id alone: a session id spans a whole agent family, so it
 * would hand a subagent's request the parent's prompt.
 *
 * An entry with no thread id, or one whose thread recorded no opening prompt,
 * keeps `prompt: null` and so never matches a search. Pure.
 */
export function attachContextPrompts(
  entries: readonly ContextEntry[],
  rootPrompts: ReadonlyMap<string, string>,
): ContextEntry[] {
  const texts = new Map<string, string>();
  for (const [threadId, root] of rootPrompts) {
    const text = userPromptText(root);
    if (text) texts.set(threadId, text);
  }
  return entries.map((e) => ({ ...e, prompt: (e.threadId && texts.get(e.threadId)) || null }));
}

/** The requests of one thread, gathered — what the context table shows as one row. */
export interface ContextThreadGroup {
  /** The thread id, or the lone request's sidecar when it has none. */
  key: string;
  /** Null when the request carries no thread id, in which case the group holds it alone. */
  threadId: string | null;
  /** The thread's requests, in the order they were given. */
  entries: ContextEntry[];
  /** The thread's opening prompt, from the first request that recorded one. */
  prompt: string | null;
  /** Oldest and newest timestamp in the group, regardless of the order given. */
  firstTimestamp: string;
  lastTimestamp: string;
  /**
   * The thread's largest request, which is what the single row's cells show. Ties
   * keep the earlier entry.
   */
  peak: ContextEntry;
  /** Distinct models the thread used, first seen first — usually one. */
  models: string[];
}

/**
 * Gather every request of a thread into one {@link ContextThreadGroup}, whatever
 * positions the caller's sort put them in — concurrent sessions interleave in time,
 * so grouping only adjacent requests would leave one thread as many groups.
 *
 * Groups come back in the order their first request appears, so the caller's sort
 * still decides which thread leads. A null thread id names no thread, so each such
 * request gets a group of its own. Pure.
 */
export function groupContextThreads(entries: readonly ContextEntry[]): ContextThreadGroup[] {
  const groups: ContextThreadGroup[] = [];
  const byThread = new Map<string, ContextThreadGroup>();
  for (const entry of entries) {
    const existing = entry.threadId === null ? undefined : byThread.get(entry.threadId);
    if (existing) {
      existing.entries.push(entry);
      existing.prompt ??= entry.prompt;
      if (entry.timestamp.localeCompare(existing.firstTimestamp) < 0) existing.firstTimestamp = entry.timestamp;
      if (entry.timestamp.localeCompare(existing.lastTimestamp) > 0) existing.lastTimestamp = entry.timestamp;
      if (entry.realInput > existing.peak.realInput) existing.peak = entry;
      if (!existing.models.includes(entry.model)) existing.models.push(entry.model);
      continue;
    }
    const group: ContextThreadGroup = {
      key: entry.threadId ?? `no-thread:${entry.file}`,
      threadId: entry.threadId,
      entries: [entry],
      prompt: entry.prompt,
      firstTimestamp: entry.timestamp,
      lastTimestamp: entry.timestamp,
      peak: entry,
      models: [entry.model],
    };
    groups.push(group);
    if (entry.threadId !== null) byThread.set(entry.threadId, group);
  }
  return groups;
}

/** One session's captured requests, reduced to the one worth drilling into. */
export interface SessionContextPeak {
  /** How many captured requests were matched to this thread. */
  requestCount: number;
  /** The largest of them — the drill-down handle. */
  peak: ContextEntry | null;
}

/**
 * Which entries belong to one transcript. Prefers the recorded thread id, which names
 * exactly one; falls back to the session id, which spans a whole agent family and so
 * can hand a subagent's request to its parent.
 */
function matching(
  entries: readonly ContextEntry[],
  sessionId: string | null,
  threadId?: string | null,
): readonly ContextEntry[] {
  if (threadId) {
    const exact = entries.filter((e) => e.threadId === threadId);
    if (exact.length) return exact;
  }
  if (!sessionId) return [];
  return entries.filter((e) => e.sessionId === sessionId);
}

/**
 * The largest-context request a transcript sent, matched by {@link matching}. Ties
 * keep the earlier entry; no match gives an empty result.
 */
export function sessionContextPeak(
  entries: readonly ContextEntry[],
  sessionId: string | null,
  threadId?: string | null,
): SessionContextPeak {
  const mine = matching(entries, sessionId, threadId);
  let peak: ContextEntry | null = null;
  for (const e of mine) {
    if (!peak || e.realInput > peak.realInput) peak = e;
  }
  return { requestCount: mine.length, peak };
}

/**
 * Every captured request belonging to one transcript, matched the same way
 * {@link sessionContextPeak} matches.
 */
export function sessionContextEntries(
  entries: readonly ContextEntry[],
  sessionId: string | null,
  threadId?: string | null,
): ContextEntry[] {
  return [...matching(entries, sessionId, threadId)];
}

// Raw-request breakdown — "why was this one so large?"

export interface BreakdownTool {
  /** Position in the request's `tools` array — the drill-down handle. */
  index: number;
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
function byteLength(value: JsonValue | undefined): number {
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
export function analyzeRequestBody<Candidate>(body: Candidate): RequestBreakdown {
  const value = jsonValueOf(body);
  const record = jsonObject(value);
  // A body that is not a member map contributes no fields, but is still weighed
  // as itself — a bare array measures its own size, everything else measures `{}`.
  const measured: JsonValue = record ?? (Array.isArray(value) ? value : {});

  const tools: BreakdownTool[] = arrayAt(record, 'tools')
    .map((t, index) => {
      const bytes = byteLength(t);
      const name = jsonText(jsonObject(t)?.name) ?? '(unnamed)';
      return { index, name, bytes, estTokens: estTokens(bytes) };
    })
    .sort((a, b) => b.bytes - a.bytes);

  const rawMessages = arrayAt(record, 'messages');
  const messages: BreakdownMessage[] = rawMessages.map((m, index) => {
    const bytes = byteLength(m);
    const role = jsonText(jsonObject(m)?.role) ?? 'unknown';
    return { index, role, bytes, estTokens: estTokens(bytes) };
  });

  const toolsBytes = tools.reduce((n, t) => n + t.bytes, 0);
  const systemBytes = byteLength(record?.system);
  const totalBytes = byteLength(measured);

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
export function extractRequestMessage<Candidate>(body: Candidate, index: number): RequestMessageDetail | null {
  const rawMessages = arrayAt(jsonObject(jsonValueOf(body)), 'messages');
  if (!Number.isInteger(index) || index < 0 || index >= rawMessages.length) return null;

  const m = rawMessages[index];
  const bytes = byteLength(m);
  const role = jsonText(jsonObject(m)?.role) ?? 'unknown';
  return {
    index,
    role,
    bytes,
    estTokens: estTokens(bytes),
    messageCount: rawMessages.length,
    content: JSON.stringify(m, null, 2),
  };
}

export interface RequestToolDetail {
  index: number;
  name: string;
  bytes: number;
  estTokens: number;
  /** How many tool schemas the request had. */
  toolCount: number;
  /** The full tool schema, pretty-printed as JSON. */
  content: string;
}

/**
 * Pull one tool schema from a parsed request body by its position in the
 * `tools` array, with its full definition (pretty-printed JSON) and the same
 * size facts {@link analyzeRequestBody} reports. Returns null for a missing
 * tools array or out-of-range `index`. Pure and tolerant of malformed shapes.
 */
export function extractRequestTool<Candidate>(body: Candidate, index: number): RequestToolDetail | null {
  const rawTools = arrayAt(jsonObject(jsonValueOf(body)), 'tools');
  if (!Number.isInteger(index) || index < 0 || index >= rawTools.length) return null;

  const t = rawTools[index];
  const bytes = byteLength(t);
  const name = jsonText(jsonObject(t)?.name) ?? '(unnamed)';
  return {
    index,
    name,
    bytes,
    estTokens: estTokens(bytes),
    toolCount: rawTools.length,
    content: JSON.stringify(t, null, 2),
  };
}
