import { isAuditSidecar, type AuditSidecar, type AuditTokens } from "./types.js";

/**
 * Usage meters for the rolling allowances a Claude subscription meters separately.
 *
 * Two sources, in order of preference. When the proxy has captured Anthropic's
 * own `anthropic-ratelimit-*` response headers, those are the authority: they
 * carry the real allowance and the real reset instant, and need no configuration.
 * Otherwise the numbers are *estimated* from the logged token counts against a
 * ceiling the operator supplies. With neither, a window is omitted rather than
 * shown against an invented denominator.
 */

/** The separately-metered allowances, in display order. */
export const USAGE_WINDOWS = ["5h", "week", "weekFable"] as const;
export type UsageWindowKind = (typeof USAGE_WINDOWS)[number];

/** Nominal span of each window — the denominator every pace calculation divides by. */
export const USAGE_WINDOW_MS: Record<UsageWindowKind, number> = {
  "5h": 5 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  weekFable: 7 * 24 * 60 * 60 * 1000,
};

const WINDOW_LABELS: Record<UsageWindowKind, string> = {
  "5h": "5-hour window",
  week: "Weekly window",
  weekFable: "Weekly Fable",
};

/**
 * Weighted tokens — the unit both the estimate and its configured ceiling are in.
 * Cache reads bill at roughly a tenth of fresh input, so they weigh a tenth here;
 * counting them at par would let a cache-heavy hour dwarf every real request.
 * `input` (not `realInput`) is used so cached tokens aren't counted twice.
 */
const CACHE_READ_WEIGHT = 0.1;

/** Weighted usage units for one request. */
export function usageUnits(t: AuditTokens): number {
  return t.input + t.output + t.cacheCreation + t.cacheRead * CACHE_READ_WEIGHT;
}

/** Per-window ceilings for the estimated path, in {@link usageUnits}. */
export type UsageLimitConfig = Partial<Record<UsageWindowKind, number>>;

/** How hard the current rate is pushing against the allowance. */
export type UsagePaceStatus = "safe" | "on-pace" | "aggressive" | "exhausted";

export interface UsagePace {
  status: UsagePaceStatus;
  /** Fraction of the window already elapsed; `1` for a trailing estimate. */
  elapsed: number;
  /** Utilization this rate lands on by the window's end; null when unknowable. */
  projected: number | null;
  /** Milliseconds until the allowance would be exhausted at this rate; null if never. */
  exhaustsInMs: number | null;
  /** One-line plain-language read, for the card under the meter. */
  blurb: string;
}

export interface UsageWindowMeter {
  kind: UsageWindowKind;
  label: string;
  /** Fraction of the allowance consumed. Can exceed 1 on the estimated path. */
  utilization: number;
  /** When the allowance resets (ISO 8601); null when the source cannot say. */
  resetsAt: string | null;
  /** `headers` is Anthropic's accounting; `estimated` is ours, from logged tokens. */
  source: "headers" | "estimated";
  /** Units counted and the ceiling measured against — estimated path only. */
  usedUnits: number | null;
  limitUnits: number | null;
  /**
   * Fraction of the window actually backed by captured requests (estimated path).
   * Below 1 the reading is a floor, not a total: this repo's `logs/` keeps only
   * the recent past, so a weekly estimate routinely can't see the whole window.
   * Always 1 on the header path, where Anthropic counts the window itself.
   */
  coverage: number;
  pace: UsagePace;
}

export interface UsageLimitsSnapshot {
  windows: UsageWindowMeter[];
  /** Why there is nothing to show, when `windows` is empty. */
  unavailable: string | null;
  /** Timestamp of the newest request the snapshot reflects. */
  observedAt: string | null;
  meta: {
    /** Requests counted in the weekly window. */
    requests: number;
    /** Windows sourced from Anthropic's headers rather than estimated. */
    fromHeaders: number;
  };
}

// ---------------------------------------------------------------------------
// Header parsing
//
// The unified header names are matched by shape rather than by an exact list, so
// a renamed or newly-added window still lands on the right meter: one segment
// names the span (`5h`, `7d`/`week`), an optional one narrows it to a model
// family, and the last names the field.
// ---------------------------------------------------------------------------

const FIVE_HOUR_RE = /(^|[^a-z0-9])(5h|5_?hour|five_?hour)([^a-z0-9]|$)/;
const WEEKLY_RE = /(^|[^a-z0-9])(7d|7_?day|seven_?day|week(ly)?)([^a-z0-9]|$)/;
/** Fable is the top tier; Anthropic has historically named this window after Opus. */
const TOP_TIER_RE = /(fable|opus)/;
const FIELD_RE = /(utilization|remaining|limit|reset|used|status)$/;

/** Which window a rate-limit header describes, or null when it describes none. */
export function windowOfHeader(name: string): UsageWindowKind | null {
  const n = name.toLowerCase();
  if (FIVE_HOUR_RE.test(n)) return "5h";
  if (!WEEKLY_RE.test(n)) return null;
  return TOP_TIER_RE.test(n) ? "weekFable" : "week";
}

interface HeaderFields {
  limit?: number;
  remaining?: number;
  used?: number;
  utilization?: number;
  resetsAt?: string;
}

/**
 * A reset header may be an ISO instant, epoch seconds, epoch milliseconds, or a
 * plain seconds-from-now count. Magnitude disambiguates the numeric forms.
 */
function parseReset(raw: string, now: Date): string | null {
  const n = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(n)) {
    if (n >= 1e12) return new Date(n).toISOString();
    if (n >= 1e9) return new Date(n * 1000).toISOString();
    return new Date(now.getTime() + n * 1000).toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function num(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Group a sidecar's captured rate-limit headers by the window each describes. */
function groupHeaders(headers: Record<string, string>, now: Date): Map<UsageWindowKind, HeaderFields> {
  const out = new Map<UsageWindowKind, HeaderFields>();
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (typeof rawValue !== "string") continue;
    const kind = windowOfHeader(rawName);
    if (!kind) continue;
    const field = FIELD_RE.exec(rawName.toLowerCase())?.[1];
    if (!field) continue;

    const fields = out.get(kind) ?? {};
    switch (field) {
      case "limit":
        fields.limit = num(rawValue);
        break;
      case "remaining":
        fields.remaining = num(rawValue);
        break;
      case "used":
        fields.used = num(rawValue);
        break;
      case "utilization": {
        const v = num(rawValue);
        // Reported either as a 0–1 fraction or a percentage.
        if (v != null) fields.utilization = v > 1 ? v / 100 : v;
        break;
      }
      case "reset": {
        const at = parseReset(rawValue, now);
        if (at) fields.resetsAt = at;
        break;
      }
      // `status` is a coarse allowed/warning/rejected label; utilization is finer.
      default:
        break;
    }
    out.set(kind, fields);
  }
  return out;
}

/** Utilization a header group implies, or null when its fields can't produce one. */
function headerUtilization(f: HeaderFields): number | null {
  if (f.utilization != null) return clamp01(f.utilization);
  if (f.limit != null && f.limit > 0) {
    if (f.remaining != null) return clamp01((f.limit - f.remaining) / f.limit);
    if (f.used != null) return clamp01(f.used / f.limit);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pace
// ---------------------------------------------------------------------------

/** Above this projected utilization the window runs out before it resets. */
const AGGRESSIVE_PROJECTION = 1;
/** Above this it is close enough to the ceiling to be worth saying so. */
const ON_PACE_PROJECTION = 0.8;
/** At or above this the allowance is effectively spent. */
const EXHAUSTED_UTILIZATION = 0.995;

/** `3h 40m` / `12m` / `2d 4h` — a duration at blurb width. */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(total / (60 * 24));
  const hours = Math.floor((total % (60 * 24)) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * Read the rate against the window. The sustainable rate is spending the whole
 * allowance over the whole window, so `utilization / elapsed` is what this
 * projects forward — above 1 means running dry before the reset.
 *
 * A trailing estimate has no reset to run up against: the window *is* the last
 * N hours, so `elapsed` is 1 and the projection is simply where it already sits.
 */
function assessPace(args: {
  kind: UsageWindowKind;
  label: string;
  utilization: number;
  elapsed: number;
  resetsAt: string | null;
  now: Date;
  trailing: boolean;
  coverage?: number;
}): UsagePace {
  const { label, utilization, elapsed, resetsAt, now, trailing } = args;
  const windowMs = USAGE_WINDOW_MS[args.kind];
  const untilReset = resetsAt ? Math.max(0, new Date(resetsAt).getTime() - now.getTime()) : null;
  const resetPhrase = untilReset != null ? `resets in ${fmtDuration(untilReset)}` : "no reset time reported";

  const projected = elapsed > 0 ? utilization / elapsed : null;

  // A trailing estimate is measured against a ceiling the operator supplied, so
  // it gets its own vocabulary throughout: exceeding it means the estimate has
  // passed a configured budget, *not* that Anthropic is refusing anything.
  if (trailing) {
    // A partly-covered window can only ever read low, so say so rather than
    // letting a reassuring number stand on incomplete data.
    const coverage = args.coverage ?? 1;
    const caveat =
      coverage < 0.95
        ? ` Counts only the ${fmtDuration(coverage * windowMs)} of logs still on disk, so the real figure is higher.`
        : "";
    const span = fmtDuration(windowMs);

    if (utilization >= EXHAUSTED_UTILIZATION) {
      return {
        status: "exhausted",
        elapsed,
        projected: utilization,
        exhaustsInMs: 0,
        blurb: `Over the configured ${label} budget — ${pct(utilization)} of it used in the trailing ${span}. Either the rate is unsustainable or the budget is set too low.${caveat}`,
      };
    }

    const status: UsagePaceStatus = utilization >= ON_PACE_PROJECTION ? "on-pace" : "safe";
    const tail =
      status === "safe" ? "comfortably sustainable at this rate" : "sustainable, but with little headroom left";
    return {
      status,
      elapsed,
      projected,
      exhaustsInMs: null,
      blurb: `${pct(utilization)} of the ${label} budget used over the trailing ${span} — ${tail}.${caveat}`,
    };
  }

  // Header path: Anthropic reported this, so the allowance really does bind.
  if (utilization >= EXHAUSTED_UTILIZATION) {
    return {
      status: "exhausted",
      elapsed,
      projected: utilization,
      exhaustsInMs: 0,
      blurb: `${label} allowance is spent — ${resetPhrase}. Requests will be refused until it resets.`,
    };
  }

  if (projected == null) {
    return {
      status: "safe",
      elapsed,
      projected: null,
      exhaustsInMs: null,
      blurb: `${pct(utilization)} of the ${label} allowance used — too early in the window to judge the rate.`,
    };
  }

  // Window-fraction still affordable at this rate, converted back to wall time.
  const exhaustsInMs = utilization > 0 ? ((1 - utilization) * elapsed * windowMs) / utilization : null;

  if (projected >= AGGRESSIVE_PROJECTION) {
    const early = untilReset != null && exhaustsInMs != null ? Math.max(0, untilReset - exhaustsInMs) : null;
    const earlyPhrase =
      exhaustsInMs != null
        ? `you'd hit the cap in about ${fmtDuration(exhaustsInMs)}` +
          (early && early > 60_000 ? ` — ${fmtDuration(early)} short of the reset` : "")
        : "you'd hit the cap before it resets";
    return {
      status: "aggressive",
      elapsed,
      projected,
      exhaustsInMs,
      blurb: `Using the ${label} allowance faster than it refills — ${pct(utilization)} spent with ${pct(1 - elapsed)} of the window left, so ${earlyPhrase}. Ease off to stay under it.`,
    };
  }

  if (projected >= ON_PACE_PROJECTION) {
    return {
      status: "on-pace",
      elapsed,
      projected,
      exhaustsInMs,
      blurb: `Tracking close to the ${label} limit — ${pct(utilization)} used, projecting about ${pct(projected)} by the time it ${resetPhrase}. Within limits, but not much slack.`,
    };
  }

  return {
    status: "safe",
    elapsed,
    projected,
    exhaustsInMs,
    blurb: `Well inside the ${label} limit — ${pct(utilization)} used, projecting about ${pct(projected)} by the time it ${resetPhrase}.`,
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** A sidecar's captured response rate-limit headers, if the proxy recorded any. */
function rateLimitHeaders(s: AuditSidecar): Record<string, string> | null {
  const raw = (s as { rateLimit?: unknown }).rateLimit;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, string>;
}

const isFable = (model: string): boolean => model.toLowerCase().includes("fable");

export interface BuildUsageLimitsOptions {
  /** Ceilings for windows that must fall back to an estimate. */
  limits?: UsageLimitConfig;
  now?: Date;
}

/**
 * Build the Overview's usage meters from captured requests.
 *
 * Pass sidecars covering at least the weekly window; anything older is ignored.
 * Malformed entries are skipped rather than failing the whole snapshot, matching
 * the digest's tolerance for a half-written file.
 */
export function buildUsageLimits(
  sidecars: readonly unknown[],
  opts: BuildUsageLimitsOptions = {},
): UsageLimitsSnapshot {
  const now = opts.now ?? new Date();
  const limits = opts.limits ?? {};
  const nowMs = now.getTime();

  const valid: AuditSidecar[] = [];
  for (const raw of sidecars) {
    if (!isAuditSidecar(raw)) continue;
    const at = new Date(raw.timestamp).getTime();
    if (Number.isNaN(at) || at > nowMs + 60_000) continue; // skip clock-skewed futures
    if (nowMs - at > USAGE_WINDOW_MS.week) continue;
    valid.push(raw);
  }
  valid.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const newest = valid.at(-1) ?? null;
  // Headers only describe the moment they were returned, so only the most recent
  // request's are current. Older ones would understate everything since.
  const headerGroups = newest ? groupHeaders(rateLimitHeaders(newest) ?? {}, now) : new Map();

  const windows: UsageWindowMeter[] = [];
  let fromHeaders = 0;

  for (const kind of USAGE_WINDOWS) {
    const label = WINDOW_LABELS[kind];
    const windowMs = USAGE_WINDOW_MS[kind];
    const fields = headerGroups.get(kind);
    const utilFromHeaders = fields ? headerUtilization(fields) : null;

    if (fields && utilFromHeaders != null) {
      const resetsAt = fields.resetsAt ?? null;
      // Elapsed follows from the reset instant: a window resetting in 1h of 5h is 80% gone.
      const elapsed = resetsAt
        ? clamp01(1 - (new Date(resetsAt).getTime() - nowMs) / windowMs)
        : 0;
      windows.push({
        kind,
        label,
        utilization: utilFromHeaders,
        resetsAt,
        source: "headers",
        usedUnits: null,
        limitUnits: fields.limit ?? null,
        coverage: 1,
        pace: assessPace({ kind, label, utilization: utilFromHeaders, elapsed, resetsAt, now, trailing: false }),
      });
      fromHeaders += 1;
      continue;
    }

    const limitUnits = limits[kind];
    if (limitUnits == null || !(limitUnits > 0)) continue; // no allowance to measure against
    // Nothing captured means nothing to estimate from — a 0% meter here would
    // report "well within limits" when the truth is "we cannot see".
    if (valid.length === 0) continue;

    const since = nowMs - windowMs;
    let usedUnits = 0;
    for (const s of valid) {
      if (new Date(s.timestamp).getTime() < since) continue;
      if (kind === "weekFable" && !isFable(s.model)) continue;
      usedUnits += usageUnits(s.tokens);
    }
    // Oldest retained request bounds how far back the count can actually see.
    const oldest = new Date(valid[0]!.timestamp).getTime();
    const coverage = clamp01((nowMs - Math.max(oldest, since)) / windowMs);
    const utilization = usedUnits / limitUnits;
    windows.push({
      kind,
      label,
      utilization,
      resetsAt: null,
      source: "estimated",
      usedUnits,
      limitUnits,
      coverage,
      pace: assessPace({ kind, label, utilization, elapsed: 1, resetsAt: null, now, trailing: true, coverage }),
    });
  }

  const weekAgo = nowMs - USAGE_WINDOW_MS.week;
  const requests = valid.filter((s) => new Date(s.timestamp).getTime() >= weekAgo).length;

  let unavailable: string | null = null;
  if (windows.length === 0) {
    unavailable = valid.length
      ? "No rate-limit headers captured yet, and no usage ceilings configured. Set USAGE_LIMIT_5H / USAGE_LIMIT_WEEK to estimate from logged tokens."
      : "No requests captured in the last 7 days.";
  }

  return {
    windows,
    unavailable,
    observedAt: newest?.timestamp ?? null,
    meta: { requests, fromHeaders },
  };
}
