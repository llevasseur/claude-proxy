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

/**
 * One thread's row, with the thread's own requests left on the server. Every cell
 * the table draws is the thread's largest request — {@link ContextThreadGroup.peak} —
 * so the request list behind it never had a reader.
 *
 * It lives here rather than beside the route because a row is a **stored** value:
 * {@link contextDayAggregate} writes one per thread per reporting day, and
 * {@link mergeContextDays} folds a thread's per-day rows back into the one row the
 * table draws.
 */
export interface ContextThreadRow {
  key: string;
  threadId: string | null;
  /** The peak request's sidecar: what a thread-less row drills into. */
  file: string;
  requestCount: number;
  prompt: string | null;
  firstTimestamp: string;
  lastTimestamp: string;
  models: string[];
  realInput: number;
  systemBytes: number;
  toolsBytes: number;
}

/** A grouped thread reduced to the cells its row draws. */
export function toContextThreadRow(group: ContextThreadGroup): ContextThreadRow {
  return {
    key: group.key,
    threadId: group.threadId,
    file: group.peak.file,
    requestCount: group.entries.length,
    prompt: group.prompt,
    firstTimestamp: group.firstTimestamp,
    lastTimestamp: group.lastTimestamp,
    models: group.models,
    realInput: group.peak.realInput,
    systemBytes: group.peak.systemBytes,
    toolsBytes: group.peak.toolsBytes,
  };
}

/**
 * One reporting day of context work, reduced to what a window read over it needs.
 * **This is the unit the server stores** for a day that has closed.
 *
 * Every field is chosen so {@link mergeContextDays} can fold days together and land
 * on the answer a single pass over the whole window would have given:
 *
 * - `realInputSum` with `requestCount` gives the window's mean, which a mean of
 *   means would not.
 * - `sortedRealInput` is kept whole because a median is an **order statistic**:
 *   there is no summary of a day from which the window's median can be recovered.
 * - `max` and `top` use the same strictly-greater rule the one-pass aggregate
 *   uses, so merging days oldest-first keeps the same tie-winner.
 * - `rows` is the day's slice of the thread index. A thread spanning two days
 *   contributes a partial row to each, and the merge combines them.
 */
export interface ContextDayAggregate {
  requestCount: number;
  /** Σ `realInput` over the day. The window's mean is this summed, over the count summed. */
  realInputSum: number;
  /** Every request's `realInput`, ascending — the order statistics a median needs. */
  sortedRealInput: number[];
  /** The day's largest-context request, or null when it captured none. */
  max: ContextEntry | null;
  /** The day's largest requests, largest first, capped at `topN`. */
  top: ContextEntry[];
  /** The day's thread rows, in the order each thread's first request appears. */
  rows: ContextThreadRow[];
}

/** What a reporting day with nothing captured in it contributes. */
export function emptyContextDay(): ContextDayAggregate {
  return { requestCount: 0, realInputSum: 0, sortedRealInput: [], max: null, top: [], rows: [] };
}

/**
 * Reduce one reporting day's entries to the {@link ContextDayAggregate} a window
 * read sums. `entries` must be that day's requests in chronological order, which
 * is what fixes every tie the merge later has to reproduce. Pure.
 *
 * `topN` has to match the one the window will ask for, since a request outside its
 * own day's top `N` can never be inside the window's.
 */
export function contextDayAggregate(
  entries: readonly ContextEntry[],
  opts: { topN?: number } = {},
): ContextDayAggregate {
  const aggregates = aggregateContext(entries, opts);
  let realInputSum = 0;
  const sortedRealInput: number[] = [];
  for (const entry of entries) {
    realInputSum += entry.realInput;
    sortedRealInput.push(entry.realInput);
  }
  sortedRealInput.sort((a, b) => a - b);
  return {
    requestCount: aggregates.requestCount,
    realInputSum,
    sortedRealInput,
    max: aggregates.max,
    top: aggregates.top,
    rows: groupContextThreads(entries).map(toContextThreadRow),
  };
}

/**
 * Insert `entry` into a descending `top` list under the one-pass aggregate's rule:
 * displace only on **strictly** greater, so an equal value leaves the incumbent —
 * which, with days merged oldest-first, is the earlier request, exactly as the
 * stable sort over the whole window would have left it.
 */
function insertTop(top: ContextEntry[], entry: ContextEntry, topN: number): void {
  if (topN <= 0) return;
  if (top.length === topN && entry.realInput <= top[top.length - 1]!.realInput) return;
  let at = top.length;
  while (at > 0 && entry.realInput > top[at - 1]!.realInput) at -= 1;
  top.splice(at, 0, entry);
  if (top.length > topN) top.pop();
}

/** Fold a thread's later-day row into the row already held for it. */
function mergeThreadRow(held: ContextThreadRow, later: ContextThreadRow): ContextThreadRow {
  // The four peak cells move as one: they are all read off the same request, so
  // taking the larger `realInput` without its own `file` would draw a row that
  // drills into a different request than the one it measures.
  const peak = later.realInput > held.realInput ? later : held;
  const models = [...held.models];
  for (const model of later.models) if (!models.includes(model)) models.push(model);
  return {
    key: held.key,
    threadId: held.threadId,
    file: peak.file,
    requestCount: held.requestCount + later.requestCount,
    prompt: held.prompt ?? later.prompt,
    firstTimestamp: held.firstTimestamp <= later.firstTimestamp ? held.firstTimestamp : later.firstTimestamp,
    lastTimestamp: held.lastTimestamp >= later.lastTimestamp ? held.lastTimestamp : later.lastTimestamp,
    models,
    realInput: peak.realInput,
    systemBytes: peak.systemBytes,
    toolsBytes: peak.toolsBytes,
  };
}

/** What a window read gets back once its days are summed. */
export interface MergedContextDays {
  /** The tiles and the `top` cap, over every request in the window. */
  aggregates: ContextAggregates;
  /** The window's thread index, in the order each thread's first request appears. */
  rows: ContextThreadRow[];
}

/**
 * Sum the days a window covers into the one answer a single pass over all of them
 * would have produced. `days` must be **oldest first** — that is what makes every
 * tie-break below the same one the whole-window pass made. Pure.
 *
 * The median is the one field that cannot be summed: the days' sorted token arrays
 * are concatenated and re-sorted.
 *
 * A request that belongs in the window's `top` is necessarily in its own day's, so
 * merging the per-day lists loses none of it — a day's competitors are a subset of
 * the window's.
 */
export function mergeContextDays(
  days: readonly ContextDayAggregate[],
  opts: { topN?: number } = {},
): MergedContextDays {
  const topN = opts.topN ?? 10;
  const tokens: number[] = [];
  const top: ContextEntry[] = [];
  const rows: ContextThreadRow[] = [];
  const byKey = new Map<string, number>();
  let requestCount = 0;
  let sum = 0;
  let max: ContextEntry | null = null;

  for (const day of days) {
    requestCount += day.requestCount;
    sum += day.realInputSum;
    for (const value of day.sortedRealInput) tokens.push(value);
    // Strictly greater, so the earlier day's peak survives a tie — the same rule
    // the one-pass aggregate applies within a day.
    if (day.max !== null && (max === null || day.max.realInput > max.realInput)) max = day.max;
    for (const entry of day.top) insertTop(top, entry, topN);
    for (const row of day.rows) {
      const at = byKey.get(row.key);
      if (at === undefined) {
        byKey.set(row.key, rows.length);
        rows.push(row);
        continue;
      }
      rows[at] = mergeThreadRow(rows[at]!, row);
    }
  }

  tokens.sort((a, b) => a - b);

  return {
    aggregates: {
      requestCount,
      avgRealInput: requestCount === 0 ? 0 : Math.round(sum / requestCount),
      medianRealInput: median(tokens),
      maxRealInput: max?.realInput ?? 0,
      max,
      top,
    },
    rows,
  };
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

/**
 * Rough token estimate for display — matches the proxy's `estTokens`, divisor
 * included. 2.78 is the median bytes-per-token of 530 cold-start requests in the
 * log window; `proxy/proxy.ts` carries the measurement and the reason it is the
 * median rather than the pooled figure.
 */
const BYTES_PER_TOKEN = 2.78;
export const estTokens = (bytes: number): number => Math.round(bytes / BYTES_PER_TOKEN);

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
