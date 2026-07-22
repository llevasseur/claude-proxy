import { isAuditSidecar, type AuditSidecar } from "./types.js";
import { addCost, estimateCost, ZERO_COST, type CostBreakdown } from "./pricing.js";

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
  trend?: TrendEntry[];
}

export interface ComputeDigestOptions {
  /** Label for the digest (e.g. "2026-07-15"). */
  date: string;
  /** Prior day's digest to compute a day-over-day trend against. */
  priorDigest?: UsageDigest | null;
  /** How many tools to include in `topTools`. Default 12. */
  topN?: number;
}

const TREND_FIELDS: Array<{ field: string; pick: (d: UsageDigest) => number }> = [
  { field: "realInput", pick: (d) => d.tokens.realInput },
  { field: "output", pick: (d) => d.tokens.output },
  { field: "cost", pick: (d) => d.cost.total },
  { field: "requestCount", pick: (d) => d.requestCount },
];

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

/** The ISO timestamp's calendar day in UTC, `YYYY-MM-DD`. */
export function dayOf(sidecar: AuditSidecar): string {
  return sidecar.timestamp.slice(0, 10);
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

  for (const s of valid) {
    models[s.model] = (models[s.model] ?? 0) + 1;

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

    const hour = Number(s.timestamp.slice(11, 13));
    if (!Number.isNaN(hour)) hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
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

  let busiestHour: UsageDigest["busiestHour"] = null;
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
  };

  if (opts.priorDigest) digest.trend = buildTrend(digest, opts.priorDigest);
  return digest;
}

function buildTrend(today: UsageDigest, prior: UsageDigest): TrendEntry[] {
  return TREND_FIELDS.map(({ field, pick }) => {
    const t = pick(today);
    const p = pick(prior);
    return { field, today: t, prior: p, deltaPct: p > 0 ? ((t - p) / p) * 100 : 0 };
  });
}

/**
 * Split sidecars into one digest per calendar day (UTC), oldest→newest, with
 * each day's `trend` computed against the previous day. Handy for the multi-day
 * trend view.
 */
export function digestsByDay(sidecars: readonly unknown[], topN?: number): UsageDigest[] {
  const byDay = new Map<string, unknown[]>();
  for (const s of sidecars) {
    const day = isAuditSidecar(s) ? dayOf(s) : "invalid";
    const bucket = byDay.get(day) ?? [];
    bucket.push(s);
    byDay.set(day, bucket);
  }
  byDay.delete("invalid");

  const days = [...byDay.keys()].sort();
  const digests: UsageDigest[] = [];
  let prior: UsageDigest | null = null;
  for (const day of days) {
    const d = computeDigest(byDay.get(day)!, { date: day, priorDigest: prior, topN });
    digests.push(d);
    prior = d;
  }
  return digests;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function numOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Coerce a persisted digest (JSON read back from a durable per-day archive) into
 * a well-formed {@link UsageDigest}. Tolerant by design: the archive spans schema
 * versions — recent days are near-complete digests, older days a flat
 * `{ requestCount, realInput, output, costTotal }`. Unknown fields default to
 * zero rather than throwing, so a partial history still charts. Returns `null`
 * only for non-object input. `fallbackDate` is used when the object has no `date`
 * (e.g. the archive folder name).
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
    date: typeof raw.date === "string" ? raw.date : fallbackDate,
    requestCount: numOf(raw.requestCount),
    skipped: numOf(raw.skipped),
    models,
    tokens,
    cost,
    topTools,
    avgSystemPromptBytes: numOf(raw.avgSystemPromptBytes),
    toolOverheadPctOfInput: numOf(raw.toolOverheadPctOfInput),
    busiestHour,
    trend: Array.isArray(raw.trend) ? (raw.trend as UsageDigest["trend"]) : undefined,
  };
}
