import { estTokens } from './context.js';
import { addCost, type CostBreakdown, estimateCost, ZERO_COST } from './pricing.js';
import { reportDay, reportHour } from './time.js';
import { lastNonZeroComparison } from './trends.js';
import { type AuditSidecar, isAuditSidecar } from './types.js';

export interface DigestTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  realInput: number;
  /** cacheRead / realInput — how much of the prompt was served from cache. */
  cacheHitRatio: number;
}

export interface TopTool {
  name: string;
  totalBytes: number;
  estTokens: number;
  /** This tool's share of all tool bytes across the day. */
  pctOfToolBytes: number;
}

export interface TrendEntry {
  field: string;
  today: number;
  prior: number;
  deltaPct: number;
  /**
   * The day `prior` was read from — the last one that recorded this field, not
   * necessarily yesterday. Absent when no earlier day recorded it, and on
   * digests archived before the baseline was tracked.
   */
  priorDate?: string;
}

/**
 * What one request costs and carries, averaged over a cohort of them.
 *
 * The levers a per-day total hides: a day's spend is roughly
 * `requests × costUsd`, and `costUsd` barely moves with conversation depth once
 * compaction caps the prefix.
 */
export interface PerCallStats {
  requests: number;
  /** Distinct `session.sessionId` values seen; requests without one are uncounted. */
  sessions: number;
  /** Mean estimated USD per request. */
  costUsd: number;
  /** Total estimated USD, the numerator behind `costUsd`. */
  costTotal: number;
  /**
   * Mean estimated tokens of tool schemas plus system prompt per request — the
   * part of the prompt that is resent every turn regardless of what was asked.
   */
  fixedPrefixTokens: number;
  /** Mean uncached input tokens per request: what was genuinely new that turn. */
  freshInputTokens: number;
  /** `requests / sessions`; 0 when no request carried a session id. */
  callsPerSession: number;
}

/**
 * A day's requests split by whether they are work or overhead.
 *
 * Auto-mode fires a permission classifier as a separate ~110 KB request per
 * agent tool call. Averaging it in makes the mean track the *ratio* of
 * classifier to work traffic rather than either — the same denominator artifact
 * that moves `avgSystemPromptBytes` when no prompt changed size. So `work` is
 * the headline, `classifier` sits beside it, and `all` reconciles to the day's
 * totals.
 */
export interface PerCallSplit {
  /** Everything that is not a permission-classifier call. The headline. */
  work: PerCallStats;
  /** Permission-classifier calls only; empty when none were identified. */
  classifier: PerCallStats;
  /** Both cohorts together — reconciles with `requestCount` and `cost.total`. */
  all: PerCallStats;
  /**
   * Whether classifier identification actually ran. False when no prompt-hash
   * set was supplied, in which case `classifier` is empty because nothing was
   * *checked*, not because nothing was found.
   */
  identified: boolean;
}

export interface UsageDigest {
  date: string;
  requestCount: number;
  /** Malformed sidecars encountered and skipped. */
  skipped: number;
  models: Record<string, number>;
  tokens: DigestTokens;
  cost: CostBreakdown;
  topTools: TopTool[];
  avgSystemPromptBytes: number;
  /** Est. tool-schema tokens as a % of real input tokens — the "tax" tools add. */
  toolOverheadPctOfInput: number;
  busiestHour: { hour: number; requestCount: number } | null;
  /** Per-request means, split into work and permission-classifier overhead. */
  perCall: PerCallSplit;
  trend?: TrendEntry[];
}

export interface ComputeDigestOptions {
  /** Label for the digest (e.g. "2026-07-15"). */
  date: string;
  /** Prior day's digest to compute a trend against — shorthand for a one-day `priorDigests`. */
  priorDigest?: UsageDigest | null;
  /**
   * Every day before this one, oldest→newest, so each field is compared against
   * the last date that recorded it. Takes precedence over `priorDigest`; include
   * the idle days, since which of them counts as empty is decided per field.
   */
  priorDigests?: readonly UsageDigest[];
  /** How many tools to include in `topTools`. Default 12. */
  topN?: number;
  /**
   * System-prompt hashes known to be permission-classifier prompts, so
   * `perCall` can hold them apart from work. Passed in because resolving it
   * needs the outline store on disk and this function is pure; omitting it
   * leaves `perCall.identified` false and every request in `work`.
   */
  classifierHashes?: ReadonlySet<string>;
}

/**
 * Every token a day moved, and the denominator of its rate: the whole prompt —
 * `realInput` already counts cache reads and writes — plus what came back.
 */
export function rateTokens(d: UsageDigest): number {
  return d.tokens.realInput + d.tokens.output;
}

/**
 * A day's blended price in USD per million tokens, independent of how many it
 * moved. Cache reads are an order of magnitude cheaper than fresh input and are
 * counted in the denominator, so leaning on the cache pulls this down. Zero for
 * a day that moved no tokens.
 */
export function costPerMTok(d: UsageDigest): number {
  const tokens = rateTokens(d);
  return tokens > 0 ? (d.cost.total / tokens) * 1_000_000 : 0;
}

const TREND_FIELDS: Array<{ field: string; pick: (d: UsageDigest) => number }> = [
  { field: 'realInput', pick: (d) => d.tokens.realInput },
  { field: 'output', pick: (d) => d.tokens.output },
  { field: 'cost', pick: (d) => d.cost.total },
  { field: 'requestCount', pick: (d) => d.requestCount },
  { field: 'avgSystemPromptBytes', pick: (d) => d.avgSystemPromptBytes },
  { field: 'costPerMTok', pick: costPerMTok },
  { field: 'costPerCall', pick: (d) => d.perCall.work.costUsd },
  { field: 'fixedPrefixTokens', pick: (d) => d.perCall.work.fixedPrefixTokens },
  { field: 'freshInputPerCall', pick: (d) => d.perCall.work.freshInputTokens },
  { field: 'callsPerSession', pick: (d) => d.perCall.work.callsPerSession },
];

/** Running totals for one per-call cohort, before the means are taken. */
interface PerCallAcc {
  requests: number;
  costTotal: number;
  fixedPrefixTokens: number;
  freshInputTokens: number;
  sessions: Set<string>;
}

function emptyAcc(): PerCallAcc {
  return { requests: 0, costTotal: 0, fixedPrefixTokens: 0, freshInputTokens: 0, sessions: new Set() };
}

/**
 * One request folded into a cohort. `fixedPrefixTokens` is estimated from bytes
 * rather than billed: the wire gives one `input` count for the whole prompt, so
 * the tools-and-system share of it can only be approximated — the same estimate
 * `toolOverheadPctOfInput` already uses.
 */
function accumulate(acc: PerCallAcc, s: AuditSidecar): void {
  acc.requests += 1;
  acc.costTotal += estimateCost(s.tokens, s.model).total;
  acc.fixedPrefixTokens += estTokens(s.request.toolsBytes + s.request.systemBytes);
  acc.freshInputTokens += s.tokens.input;
  const id = s.session?.sessionId;
  if (id) acc.sessions.add(id);
}

function finish(acc: PerCallAcc): PerCallStats {
  const n = acc.requests;
  return {
    requests: n,
    sessions: acc.sessions.size,
    costUsd: n > 0 ? acc.costTotal / n : 0,
    costTotal: acc.costTotal,
    fixedPrefixTokens: n > 0 ? acc.fixedPrefixTokens / n : 0,
    freshInputTokens: n > 0 ? acc.freshInputTokens / n : 0,
    callsPerSession: acc.sessions.size > 0 ? n / acc.sessions.size : 0,
  };
}

const EMPTY_PER_CALL_STATS: PerCallStats = {
  requests: 0,
  sessions: 0,
  costUsd: 0,
  costTotal: 0,
  fixedPrefixTokens: 0,
  freshInputTokens: 0,
  callsPerSession: 0,
};

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/** The sidecar's calendar day in the reporting zone, `YYYY-MM-DD`; the timestamp's UTC prefix if unparseable. */
export function dayOf(sidecar: AuditSidecar): string {
  return reportDay(sidecar.timestamp) ?? sidecar.timestamp.slice(0, 10);
}

/**
 * Aggregate a day's audit sidecars into a `UsageDigest`. Pure: no I/O, no clock.
 * Untrusted input is validated per item; malformed entries are skipped and
 * counted in `skipped`.
 */
export function computeDigest(sidecars: readonly unknown[], opts: ComputeDigestOptions): UsageDigest {
  const topN = opts.topN ?? 12;
  const valid: AuditSidecar[] = [];
  let skipped = 0;
  for (const s of sidecars) {
    if (isAuditSidecar(s)) valid.push(s);
    else skipped += 1;
  }

  const models: Record<string, number> = {};
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, realInput: 0 };
  let cost = ZERO_COST;
  let systemBytesSum = 0;
  let toolEstTokensSum = 0;
  const toolBytes = new Map<string, { totalBytes: number; estTokens: number }>();
  const hourCounts = new Map<number, number>();
  const work = emptyAcc();
  const classifier = emptyAcc();
  const all = emptyAcc();
  const classifierHashes = opts.classifierHashes;

  for (const s of valid) {
    models[s.model] = (models[s.model] ?? 0) + 1;

    const hash = s.request.system?.hash;
    const isClassifier = classifierHashes !== undefined && hash !== undefined && classifierHashes.has(hash);
    accumulate(isClassifier ? classifier : work, s);
    accumulate(all, s);

    tokens.input += s.tokens.input;
    tokens.output += s.tokens.output;
    tokens.cacheRead += s.tokens.cacheRead;
    tokens.cacheCreation += s.tokens.cacheCreation;
    tokens.realInput += s.tokens.realInput;

    cost = addCost(cost, estimateCost(s.tokens, s.model));
    systemBytesSum += s.request.systemBytes;

    for (const t of s.tools) {
      const acc = toolBytes.get(t.name) ?? { totalBytes: 0, estTokens: 0 };
      acc.totalBytes += t.bytes;
      acc.estTokens += t.estTokens;
      toolBytes.set(t.name, acc);
      toolEstTokensSum += t.estTokens;
    }

    const hour = reportHour(s.timestamp);
    if (hour !== null) hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
  }

  const allToolBytes = [...toolBytes.values()].reduce((n, v) => n + v.totalBytes, 0);
  const topTools: TopTool[] = [...toolBytes.entries()]
    .map(([name, v]) => ({
      name,
      totalBytes: v.totalBytes,
      estTokens: v.estTokens,
      pctOfToolBytes: pct(v.totalBytes, allToolBytes),
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes)
    .slice(0, topN);

  let busiestHour: UsageDigest['busiestHour'] = null;
  for (const [hour, count] of hourCounts) {
    if (!busiestHour || count > busiestHour.requestCount) busiestHour = { hour, requestCount: count };
  }

  const requestCount = valid.length;
  const digest: UsageDigest = {
    date: opts.date,
    requestCount,
    skipped,
    models,
    tokens: { ...tokens, cacheHitRatio: tokens.realInput > 0 ? tokens.cacheRead / tokens.realInput : 0 },
    cost,
    topTools,
    avgSystemPromptBytes: requestCount > 0 ? Math.round(systemBytesSum / requestCount) : 0,
    toolOverheadPctOfInput: pct(toolEstTokensSum, tokens.realInput),
    busiestHour,
    perCall: {
      work: finish(work),
      classifier: finish(classifier),
      all: finish(all),
      identified: classifierHashes !== undefined,
    },
  };

  const history = opts.priorDigests ?? (opts.priorDigest ? [opts.priorDigest] : []);
  if (history.length > 0) digest.trend = buildTrend(digest, history);
  return digest;
}

function buildTrend(today: UsageDigest, history: readonly UsageDigest[]): TrendEntry[] {
  const series = [...history, today];
  return TREND_FIELDS.map(({ field, pick }) => {
    // `series` ends with `today`, so the comparison is never null.
    const { baseline, deltaPct } = lastNonZeroComparison(series, pick)!;
    return {
      field,
      today: pick(today),
      prior: baseline ? pick(baseline) : 0,
      // Zero, not null, when nothing recorded the field — the delta chips read an
      // absent number as "no trend yet" and a zero one as "flat".
      deltaPct: deltaPct ?? 0,
      priorDate: baseline?.date,
    };
  });
}

/**
 * Split sidecars into one digest per calendar day in the reporting zone (see
 * `REPORT_TZ`), oldest→newest, with each day's `trend` computed against the last
 * earlier day that recorded each field. Handy for the multi-day trend view.
 */
export function digestsByDay(
  sidecars: readonly unknown[],
  opts: Pick<ComputeDigestOptions, 'topN' | 'classifierHashes'> = {},
): UsageDigest[] {
  const byDay = new Map<string, unknown[]>();
  for (const s of sidecars) {
    const day = isAuditSidecar(s) ? dayOf(s) : 'invalid';
    const bucket = byDay.get(day) ?? [];
    bucket.push(s);
    byDay.set(day, bucket);
  }
  byDay.delete('invalid');

  const days = [...byDay.keys()].sort();
  const digests: UsageDigest[] = [];
  for (const day of days) {
    digests.push(computeDigest(byDay.get(day)!, { ...opts, date: day, priorDigests: digests }));
  }
  return digests;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function numOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** One persisted cohort, with every absent field reading as zero. */
function normalizePerCallStats(raw: unknown): PerCallStats {
  if (!isRec(raw)) return { ...EMPTY_PER_CALL_STATS };
  const requests = numOf(raw.requests);
  const sessions = numOf(raw.sessions);
  return {
    requests,
    sessions,
    costUsd: numOf(raw.costUsd),
    costTotal: numOf(raw.costTotal),
    fixedPrefixTokens: numOf(raw.fixedPrefixTokens),
    freshInputTokens: numOf(raw.freshInputTokens),
    // Derived for a digest archived before the field existed but with both parts.
    callsPerSession: raw.callsPerSession != null ? numOf(raw.callsPerSession) : sessions > 0 ? requests / sessions : 0,
  };
}

/**
 * A persisted `perCall` split. A digest archived before this existed has none,
 * and comes back with `identified: false` — no cohort was ever separated, so
 * reporting an empty classifier cohort as a *finding* would be a lie.
 */
function normalizePerCall(raw: unknown): PerCallSplit {
  if (!isRec(raw)) {
    return {
      work: { ...EMPTY_PER_CALL_STATS },
      classifier: { ...EMPTY_PER_CALL_STATS },
      all: { ...EMPTY_PER_CALL_STATS },
      identified: false,
    };
  }
  return {
    work: normalizePerCallStats(raw.work),
    classifier: normalizePerCallStats(raw.classifier),
    all: normalizePerCallStats(raw.all),
    identified: raw.identified === true,
  };
}

/**
 * Coerce a persisted digest into a `UsageDigest`, tolerating the archive's range
 * of schema versions — from near-complete digests down to a flat legacy
 * `{ requestCount, realInput, output, costTotal }`. Unknown fields default to
 * zero. Returns `null` only for non-object input. `fallbackDate` fills in a
 * missing `date` (e.g. the archive folder name).
 */
export function normalizeDigest(raw: unknown, fallbackDate: string): UsageDigest | null {
  if (!isRec(raw)) return null;

  const rt = isRec(raw.tokens) ? raw.tokens : {};
  const realInput = numOf(rt.realInput ?? raw.realInput);
  const cacheRead = numOf(rt.cacheRead);
  const tokens: DigestTokens = {
    input: numOf(rt.input),
    output: numOf(rt.output ?? raw.output),
    cacheRead,
    cacheCreation: numOf(rt.cacheCreation),
    realInput,
    // Prefer the stored ratio; derive it for legacy digests that predate it.
    cacheHitRatio: rt.cacheHitRatio != null ? numOf(rt.cacheHitRatio) : realInput > 0 ? cacheRead / realInput : 0,
  };

  const rc = isRec(raw.cost) ? raw.cost : {};
  const cost: CostBreakdown = {
    input: numOf(rc.input),
    output: numOf(rc.output),
    cacheWrite: numOf(rc.cacheWrite),
    cacheRead: numOf(rc.cacheRead),
    total: numOf(rc.total ?? raw.costTotal),
  };

  const models = isRec(raw.models) ? (raw.models as Record<string, number>) : {};
  const topTools = Array.isArray(raw.topTools) ? (raw.topTools as TopTool[]) : [];
  const busiestHour = isRec(raw.busiestHour)
    ? { hour: numOf(raw.busiestHour.hour), requestCount: numOf(raw.busiestHour.requestCount) }
    : null;

  return {
    date: typeof raw.date === 'string' ? raw.date : fallbackDate,
    requestCount: numOf(raw.requestCount),
    skipped: numOf(raw.skipped),
    models,
    tokens,
    cost,
    topTools,
    avgSystemPromptBytes: numOf(raw.avgSystemPromptBytes),
    toolOverheadPctOfInput: numOf(raw.toolOverheadPctOfInput),
    busiestHour,
    perCall: normalizePerCall(raw.perCall),
    trend: Array.isArray(raw.trend) ? (raw.trend as UsageDigest['trend']) : undefined,
  };
}
