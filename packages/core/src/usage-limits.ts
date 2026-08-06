import { dayStartMs, shiftDay } from './time.js';
import { type AuditSidecar, type AuditTokens, isAuditSidecar } from './types.js';

/**
 * Usage meters for the rolling allowances a Claude subscription meters separately.
 *
 * Captured `anthropic-ratelimit-*` response headers win when present: they carry
 * the real allowance and reset instant. Otherwise the numbers are estimated from
 * logged tokens against an operator-supplied ceiling. With neither, a window is
 * omitted rather than shown against an invented denominator.
 */

/** The separately-metered allowances, in display order. */
export const USAGE_WINDOWS = ['5h', 'week', 'weekFable'] as const;
export type UsageWindowKind = (typeof USAGE_WINDOWS)[number];

/** Nominal span of each window; every pace calculation divides by it. */
export const USAGE_WINDOW_MS: Record<UsageWindowKind, number> = {
  '5h': 5 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  weekFable: 7 * 24 * 60 * 60 * 1000,
};

/** Suffix of each window's override env var; the server builds `USAGE_LIMIT_<suffix>` from this. */
export const USAGE_LIMIT_ENV_SUFFIX: Record<UsageWindowKind, string> = {
  '5h': '5H',
  week: 'WEEK',
  weekFable: 'WEEK_FABLE',
};

const WINDOW_LABELS: Record<UsageWindowKind, string> = {
  '5h': '5-hour window',
  week: 'Weekly window',
  weekFable: 'Weekly Fable',
};

/**
 * What a cache read *meters* at against fresh input, for the rate-limit allowances.
 * This is **not** the cost ratio: Anthropic bills cache reads at about a tenth of
 * fresh input ($1.50/MTok against $15/MTok on Opus — see `MODEL_PRICES` in
 * `pricing.ts`, which is the only place money is computed), and metering at that
 * tenth reads every cache-heavy window several times too high.
 *
 * Measured rather than assumed. Each completed 5-hour window whose sidecars carry an
 * `anthropic-ratelimit-unified-5h-utilization` header pairs a weighted token count
 * with Anthropic's own reading of how much of the allowance it consumed, so each
 * window implies an allowance; one allowance produced them all, so the weight that
 * makes them agree is the measured one. `node scripts/derive-metering-weight.mjs`
 * re-derives it from the captured sidecars, and `usage-limits.test.ts` pins it to four
 * such windows checked in as fixtures.
 *
 * **Held loosely — the order of magnitude is solid, the second digit is not.** Those
 * four windows are near-collinear: their cache-read share of units spans just 1.2pp
 * (0.963–0.975), so identification rests mostly on the single window with materially
 * more fresh input. Weights within a tenth of the best fit (0.019) span 0.011–0.023,
 * and ~6% of the four-window disagreement is residual that no weight removes. A
 * far larger-sample check corroborates the direction without pinning the value:
 * regressing every per-request reading inside a window against the cumulative units at
 * that instant — hundreds of points per window rather than four in total — bottoms out
 * near 0.016 and roughly halves the residual against 0.1.
 *
 * A wrong weight here is quiet in two ways. Usage and a *learned* ceiling are both
 * counted in these units, so the error cancels out of that ratio until the cache-hit
 * ratio moves, then shifts both meters at once. A *configured* `USAGE_LIMIT_*` ceiling
 * is an absolute number in this unit, so changing this weight silently invalidates any
 * value already set — see `server/.env.example`.
 */
export const CACHE_READ_METERING_WEIGHT = 0.02;

/**
 * Weighted usage units for one request, in the rate-limit metering unit.
 * `input`, not `realInput`, to avoid double-counting.
 */
export function usageUnits(t: AuditTokens): number {
  return t.input + t.output + t.cacheCreation + t.cacheRead * CACHE_READ_METERING_WEIGHT;
}

/** Per-window ceilings for the estimated path, in {@link usageUnits}. */
export type UsageLimitConfig = Partial<Record<UsageWindowKind, number>>;

/** One window as Anthropic's own usage endpoint reports it. */
export interface LiveUsageWindow {
  /** Fraction of the allowance consumed, `percent / 100`. */
  utilization: number;
  resetsAt: string | null;
}

/** Windows read from `/api/oauth/usage`, keyed the way this module keys them. */
export type LiveUsage = Partial<Record<UsageWindowKind, LiveUsageWindow>>;

/**
 * `kind` values the usage endpoint emits, mapped onto our windows. `weekly_scoped`
 * carries the model in `scope.model.display_name` instead of in the kind.
 *
 * Both the `session`/`weekly_all` spelling the endpoint returns and the
 * `five_hour`/`seven_day` one the client also accepts are matched.
 */
const LIVE_KINDS: Record<string, UsageWindowKind> = {
  session: '5h',
  weekly_all: 'week',
  five_hour: '5h',
  seven_day: 'week',
  seven_day_opus: 'weekFable',
};

/**
 * A ceiling inferred from history: the busiest completed window we have logs for.
 *
 * A *lower bound* on the real allowance, never the allowance. The error runs one
 * way only — dividing by a ceiling that is too low reads too *high*, so a learned
 * meter overstates closeness to the limit and cannot invent headroom.
 */
export interface LearnedCeiling {
  /** Peak weighted {@link usageUnits} seen in any single completed window. */
  units: number;
  /** Completed windows the peak was drawn from. More windows, tighter bound. */
  windows: number;
  /** Span of history those windows came out of. */
  observedMs: number;
}

/** What a window's learning pass turned up, per kind. */
export type LearnedCeilings = Partial<Record<UsageWindowKind, LearnedCeiling>>;

/** How hard the current rate is pushing against the allowance. */
export type UsagePaceStatus = 'safe' | 'on-pace' | 'aggressive' | 'exhausted';

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
  /**
   * Where the ceiling came from: Anthropic's own accounting, an operator-supplied
   * limit, or {@link LearnedCeiling}.
   */
  source: 'live' | 'headers' | 'estimated' | 'learned';
  /** How the ceiling was inferred; null unless `source` is `learned`. */
  learned: LearnedCeiling | null;
  /** Weighted {@link usageUnits} counted; estimated path only. */
  usedUnits: number | null;
  /**
   * The ceiling measured against. On the estimated path this is the configured
   * limit in {@link usageUnits}; on the header path it is Anthropic's own reported
   * limit, in Anthropic's units — the two are not comparable.
   */
  limitUnits: number | null;
  /**
   * Fraction of the window backed by retained logs (estimated path). Below 1 the
   * reading is a floor, not a total. Always 1 on the header path.
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
    /**
     * Windows Anthropic reported itself — the polled endpoint or the response
     * headers — rather than ones estimated against a configured or learned
     * ceiling. Named for the headers, which were once the only such source.
     */
    fromHeaders: number;
  };
}

// Header names are matched by shape, not against an exact list, so a renamed or
// newly-added window still lands on the right meter: one segment names the span,
// an optional one narrows it to a model family, and the last names the field.

const FIVE_HOUR_RE = /(^|[^a-z0-9])(5h|5_?hour|five_?hour)([^a-z0-9]|$)/;
const WEEKLY_RE = /(^|[^a-z0-9])(7d|7_?day|seven_?day|week(ly)?)([^a-z0-9]|$)/;
/** Fable is the current top tier; Anthropic has historically named this window after Opus. */
const TOP_TIER_RE = /(fable|opus)/;
const FIELD_RE = /(utilization|remaining|limit|reset|used|status)$/;

/** Which window a rate-limit header describes, or null when it describes none. */
export function windowOfHeader(name: string): UsageWindowKind | null {
  const n = name.toLowerCase();
  if (FIVE_HOUR_RE.test(n)) return '5h';
  if (!WEEKLY_RE.test(n)) return null;
  return TOP_TIER_RE.test(n) ? 'weekFable' : 'week';
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
  if (raw.trim() !== '' && Number.isFinite(n)) {
    if (n >= 1e12) return new Date(n).toISOString();
    if (n >= 1e9) return new Date(n * 1000).toISOString();
    return new Date(now.getTime() + n * 1000).toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Is this `weekly_scoped` entry the Fable window? */
function isFableScope(entry: Record<string, unknown>): boolean {
  const scope = entry.scope as { model?: { display_name?: unknown } } | undefined;
  const name = scope?.model?.display_name;
  return typeof name === 'string' && /fable/i.test(name);
}

/**
 * Windows out of an `/api/oauth/usage` payload: an array of entries carrying a
 * `kind`, a `percent`, and a `resets_at`.
 *
 * Unknown kinds are skipped rather than guessed at, so a window Anthropic adds
 * falls through to the estimate instead of landing on the wrong meter. Entries
 * without a usable `percent` are dropped for the same reason.
 */
export function parseLiveUsage(raw: unknown, now: Date = new Date()): LiveUsage {
  const entries = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { limits?: unknown })?.limits)
      ? (raw as { limits: unknown[] }).limits
      : [];
  const out: LiveUsage = {};
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const entry = e as Record<string, unknown>;
    const rawKind = entry.kind;
    if (typeof rawKind !== 'string') continue;
    const kind =
      rawKind === 'weekly_scoped' ? (isFableScope(entry) ? 'weekFable' : null) : (LIVE_KINDS[rawKind] ?? null);
    if (!kind) continue;
    const percent = Number(entry.percent);
    if (!Number.isFinite(percent)) continue;
    const reset = entry.resets_at;
    out[kind] = {
      utilization: Math.max(0, percent / 100),
      resetsAt: reset == null ? null : parseReset(String(reset), now),
    };
  }
  return out;
}

/**
 * Fraction of the window `[since, now]` whose logs are actually on disk.
 *
 * Counts the days held, not the span back to the oldest surviving request:
 * measuring from the oldest record reads a hole in the middle of the window as
 * complete coverage, taking the `partial` marking with it. Days are the unit
 * because rotation is day-granular, so a quiet stretch inside a retained day is
 * genuinely quiet. Day ends resolve as the next day's start, so the two DST days
 * keep their real 23 and 25 hours.
 */
function retainedCoverage(days: ReadonlySet<string>, since: number, now: number, windowMs: number): number {
  let covered = 0;
  for (const day of days) {
    const start = dayStartMs(day);
    if (Number.isNaN(start)) continue;
    covered += Math.max(0, Math.min(dayStartMs(shiftDay(day, 1)), now) - Math.max(start, since));
  }
  return clamp01(covered / windowMs);
}

function num(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Group a sidecar's captured rate-limit headers by the window each describes. */
function groupHeaders(headers: Record<string, string>, now: Date): Map<UsageWindowKind, HeaderFields> {
  const out = new Map<UsageWindowKind, HeaderFields>();
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (typeof rawValue !== 'string') continue;
    const kind = windowOfHeader(rawName);
    if (!kind) continue;
    const field = FIELD_RE.exec(rawName.toLowerCase())?.[1];
    if (!field) continue;

    const fields = out.get(kind) ?? {};
    switch (field) {
      case 'limit':
        fields.limit = num(rawValue);
        break;
      case 'remaining':
        fields.remaining = num(rawValue);
        break;
      case 'used':
        fields.used = num(rawValue);
        break;
      case 'utilization': {
        const v = num(rawValue);
        // Reported either as a 0–1 fraction or a percentage.
        if (v != null) fields.utilization = v > 1 ? v / 100 : v;
        break;
      }
      case 'reset': {
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

/** Above this projected utilization the window runs out before it resets. */
const AGGRESSIVE_PROJECTION = 1;
/** Above this it is close enough to the ceiling to be worth saying so. */
const ON_PACE_PROJECTION = 0.8;
/** At or above this the allowance is effectively spent. */
const EXHAUSTED_UTILIZATION = 0.995;

/** A duration at blurb width, down to the minute. */
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
 * Read the rate against the window. The sustainable rate spends the whole
 * allowance over the whole window, so `utilization / elapsed` projected forward
 * above 1 means running dry before the reset.
 *
 * A trailing estimate has no reset to run up against — the window *is* the last
 * N hours — so `elapsed` is 1 and the projection is where it already sits.
 */
function assessPace(args: {
  kind: UsageWindowKind;
  label: string;
  utilization: number;
  elapsed: number;
  resetsAt: string | null;
  now: Date;
  trailing: boolean;
  /**
   * The span runs from a known reset instant rather than backwards from now.
   * Set alongside `trailing`, which picks the estimate's vocabulary rather than
   * naming which end of the span is pinned.
   */
  anchored?: boolean;
  coverage?: number;
  learned?: LearnedCeiling | null;
  /** Span actually measured; shorter than the nominal window once anchored to a reset. */
  spanMs?: number;
}): UsagePace {
  const { label, utilization, elapsed, resetsAt, now, trailing } = args;
  const windowMs = args.spanMs ?? USAGE_WINDOW_MS[args.kind];
  const untilReset = resetsAt ? Math.max(0, new Date(resetsAt).getTime() - now.getTime()) : null;
  const resetPhrase = untilReset != null ? `resets in ${fmtDuration(untilReset)}` : 'no reset time reported';

  const projected = elapsed > 0 ? utilization / elapsed : null;

  // A trailing estimate measures against an operator-supplied ceiling, so it gets
  // its own vocabulary: exceeding it means passing a configured budget, not that
  // Anthropic is refusing anything.
  if (trailing) {
    // A partly-covered window can only read low, so the blurb says so.
    const coverage = args.coverage ?? 1;
    const caveat =
      coverage < 0.95
        ? ` Counts only the ${fmtDuration(coverage * windowMs)} of logs still on disk, so the real figure is higher.`
        : '';
    const span = fmtDuration(windowMs);
    // An anchored span is measured from the instant the window opened, so
    // "trailing" would name the wrong end of it.
    const spanPhrase = args.anchored ? `the ${span} since it reset` : `the trailing ${span}`;
    const resetTail = args.anchored && untilReset != null ? ` It ${resetPhrase}.` : '';
    const learned = args.learned ?? null;

    // Its own vocabulary: readings are against the most we have seen, and passing
    // the bar is a new record, not a refusal.
    if (learned) {
      const basis = `the busiest of ${learned.windows} completed ${label.toLowerCase()}s in ${fmtDuration(learned.observedMs)} of logs`;
      if (utilization >= EXHAUSTED_UTILIZATION) {
        return {
          status: 'exhausted',
          elapsed,
          projected: utilization,
          exhaustsInMs: 0,
          blurb: `Busiest ${label} on record — ${pct(utilization)} of ${basis}. The real allowance is unknown and may be higher; this only says you are in new territory.${resetTail}${caveat}`,
        };
      }
      const status: UsagePaceStatus = utilization >= ON_PACE_PROJECTION ? 'on-pace' : 'safe';
      return {
        status,
        elapsed,
        projected,
        exhaustsInMs: null,
        blurb: `${pct(utilization)} of ${basis}. That bar is a floor on the real allowance, not the allowance — set USAGE_LIMIT_${USAGE_LIMIT_ENV_SUFFIX[args.kind]} if you know the true ceiling.${resetTail}${caveat}`,
      };
    }

    if (utilization >= EXHAUSTED_UTILIZATION) {
      return {
        status: 'exhausted',
        elapsed,
        projected: utilization,
        exhaustsInMs: 0,
        blurb: `Over the configured ${label} budget — ${pct(utilization)} of it used in ${spanPhrase}. Either the rate is unsustainable or the budget is set too low.${resetTail}${caveat}`,
      };
    }

    const status: UsagePaceStatus = utilization >= ON_PACE_PROJECTION ? 'on-pace' : 'safe';
    const tail =
      status === 'safe' ? 'comfortably sustainable at this rate' : 'sustainable, but with little headroom left';
    return {
      status,
      elapsed,
      projected,
      exhaustsInMs: null,
      blurb: `${pct(utilization)} of the ${label} budget used over ${spanPhrase} — ${tail}.${resetTail}${caveat}`,
    };
  }

  // Header path: the allowance really does bind.
  if (utilization >= EXHAUSTED_UTILIZATION) {
    return {
      status: 'exhausted',
      elapsed,
      projected: utilization,
      exhaustsInMs: 0,
      blurb: `${label} allowance is spent — ${resetPhrase}. Requests will be refused until it resets.`,
    };
  }

  if (projected == null) {
    return {
      status: 'safe',
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
          (early && early > 60_000 ? ` — ${fmtDuration(early)} short of the reset` : '')
        : "you'd hit the cap before it resets";
    return {
      status: 'aggressive',
      elapsed,
      projected,
      exhaustsInMs,
      blurb: `Using the ${label} allowance faster than it refills — ${pct(utilization)} spent with ${pct(1 - elapsed)} of the window left, so ${earlyPhrase}. Ease off to stay under it.`,
    };
  }

  if (projected >= ON_PACE_PROJECTION) {
    return {
      status: 'on-pace',
      elapsed,
      projected,
      exhaustsInMs,
      blurb: `Tracking close to the ${label} limit — ${pct(utilization)} used, projecting about ${pct(projected)} by the time it ${resetPhrase}. Within limits, but not much slack.`,
    };
  }

  return {
    status: 'safe',
    elapsed,
    projected,
    exhaustsInMs,
    blurb: `Well inside the ${label} limit — ${pct(utilization)} used, projecting about ${pct(projected)} by the time it ${resetPhrase}.`,
  };
}

/** A sidecar's captured response rate-limit headers, if the proxy recorded any. */
function rateLimitHeaders(s: AuditSidecar): Record<string, string> | null {
  const raw: unknown = s.rateLimit;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, string>;
}

const isFable = (model: string): boolean => model.toLowerCase().includes('fable');

/**
 * Infer each window's ceiling from the busiest completed window on record.
 *
 * Only *completed* windows count — the one in progress is still filling and would
 * peg every meter at 100% — and only windows the logs fully span, since one that
 * starts before the oldest retained request is a fragment, not a window.
 *
 * A gap *inside* the retained span is indistinguishable from a quiet stretch, but
 * that only costs peak, never invents one — see {@link LearnedCeiling}.
 */
export function learnCeilings(sidecars: readonly unknown[], now: Date = new Date()): LearnedCeilings {
  const nowMs = now.getTime();
  const entries: Array<{ at: number; model: string; tokens: AuditTokens }> = [];
  let oldest = Infinity;
  for (const raw of sidecars) {
    if (!isAuditSidecar(raw)) continue;
    const at = new Date(raw.timestamp).getTime();
    if (Number.isNaN(at) || at > nowMs + 60_000) continue; // skip clock-skewed futures
    entries.push({ at, model: raw.model, tokens: raw.tokens });
    if (at < oldest) oldest = at;
  }
  if (entries.length === 0) return {};

  const out: LearnedCeilings = {};
  const observedMs = nowMs - oldest;

  for (const kind of USAGE_WINDOWS) {
    const windowMs = USAGE_WINDOW_MS[kind];
    // Index 0 is the window in progress, 1 the most recent completed one; the last
    // fully-spanned index is the whole windows in the history minus that one.
    const complete = Math.floor(observedMs / windowMs) - 1;
    if (complete < 1) continue; // not one whole window of history yet — say nothing

    const totals = new Array<number>(complete + 1).fill(0);
    for (const e of entries) {
      if (kind === 'weekFable' && !isFable(e.model)) continue;
      const idx = Math.floor((nowMs - e.at) / windowMs);
      if (idx < 1 || idx > complete) continue;
      totals[idx]! += usageUnits(e.tokens);
    }

    // `totals[0]` is the in-progress window and was never filled.
    const units = Math.max(...totals.slice(1));
    // A window kind with no traffic learns nothing rather than a ceiling of zero.
    if (!(units > 0)) continue;
    out[kind] = { units, windows: complete, observedMs };
  }
  return out;
}

export interface BuildUsageLimitsOptions {
  /** Ceilings for windows that must fall back to an estimate. */
  limits?: UsageLimitConfig;
  /**
   * Sidecars reaching further back than `sidecars`, for learning ceilings where
   * `limits` is unset. Defaults to `sidecars`, which rarely spans a whole week.
   */
  history?: readonly unknown[];
  /** Ceilings already learned, for callers that cache the pass. Wins over `history`. */
  learned?: LearnedCeilings;
  /** Anthropic's own figures, from `/api/oauth/usage`. Wins over every other source. */
  live?: LiveUsage;
  /**
   * Reset instants for windows `live` cannot currently answer for, newest known.
   *
   * Anthropic's weekly allowance is a *fixed* window resetting at a published
   * instant, not a trailing 7 days; without an anchor the estimate sweeps up the
   * whole preceding week and overcounts several-fold. A stale live reading still
   * carries a usable anchor, so it is kept after its percentages have expired.
   */
  anchors?: Partial<Record<UsageWindowKind, string>>;
  /**
   * Day labels (`YYYY-MM-DD`, reporting zone) whose logs are retained — live or
   * archived. Omitted, `coverage` falls back to the oldest-record span.
   */
  retainedDays?: readonly string[];
  now?: Date;
}

/**
 * Build the Overview's usage meters from captured requests.
 *
 * Pass sidecars covering at least the weekly window; anything older is ignored.
 * Malformed entries are skipped rather than failing the whole snapshot.
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

  const learnedAll = opts.learned ?? learnCeilings(opts.history ?? sidecars, now);
  const retainedDays = opts.retainedDays ? new Set(opts.retainedDays) : null;

  const newest = valid.at(-1) ?? null;
  // Headers describe only the moment they were returned, so only the newest
  // request's are current.
  const headerGroups = newest ? groupHeaders(rateLimitHeaders(newest) ?? {}, now) : new Map();

  const windows: UsageWindowMeter[] = [];
  let fromHeaders = 0;

  for (const kind of USAGE_WINDOWS) {
    const label = WINDOW_LABELS[kind];
    const windowMs = USAGE_WINDOW_MS[kind];
    const fields = headerGroups.get(kind);
    const utilFromHeaders = fields ? headerUtilization(fields) : null;

    // The only source that knows the real allowance on subscription OAuth
    // traffic, where no rate-limit headers are ever returned.
    const fromLive = opts.live?.[kind];
    if (fromLive) {
      const resetsAt = fromLive.resetsAt;
      const elapsed = resetsAt ? clamp01(1 - (new Date(resetsAt).getTime() - nowMs) / windowMs) : 0;
      windows.push({
        kind,
        label,
        utilization: fromLive.utilization,
        resetsAt,
        source: 'live',
        learned: null,
        usedUnits: null,
        limitUnits: null,
        coverage: 1,
        pace: assessPace({ kind, label, utilization: fromLive.utilization, elapsed, resetsAt, now, trailing: false }),
      });
      fromHeaders += 1;
      continue;
    }

    if (fields && utilFromHeaders != null) {
      const resetsAt = fields.resetsAt ?? null;
      // Elapsed follows from the reset instant against the nominal span.
      const elapsed = resetsAt ? clamp01(1 - (new Date(resetsAt).getTime() - nowMs) / windowMs) : 0;
      windows.push({
        kind,
        label,
        utilization: utilFromHeaders,
        resetsAt,
        source: 'headers',
        learned: null,
        usedUnits: null,
        limitUnits: fields.limit ?? null,
        coverage: 1,
        pace: assessPace({ kind, label, utilization: utilFromHeaders, elapsed, resetsAt, now, trailing: false }),
      });
      fromHeaders += 1;
      continue;
    }

    // A configured ceiling states the allowance; a learned one guesses at its
    // floor, so the statement wins.
    const configured = limits[kind];
    const learned = configured != null && configured > 0 ? null : (learnedAll[kind] ?? null);
    const limitUnits = configured != null && configured > 0 ? configured : learned?.units;
    if (limitUnits == null || !(limitUnits > 0)) continue; // no allowance to measure against
    // Nothing captured means nothing to estimate from; a 0% meter would read as
    // "well within limits" when the truth is "we cannot see".
    if (valid.length === 0) continue;

    // A known reset instant makes the window fixed rather than trailing: count
    // from where it actually opened, not from `windowMs` ago. An anchor whose
    // window has not opened yet is dropped outright, so the count and the
    // reported reset cannot disagree.
    const anchor = opts.anchors?.[kind];
    const anchorMs = anchor ? new Date(anchor).getTime() : Number.NaN;
    const anchoredSince = Number.isNaN(anchorMs) || anchorMs - windowMs > nowMs ? null : anchorMs - windowMs;
    const anchoredResetsAt = anchoredSince != null ? (anchor ?? null) : null;
    const since = anchoredSince ?? nowMs - windowMs;
    let usedUnits = 0;
    for (const s of valid) {
      if (new Date(s.timestamp).getTime() < since) continue;
      if (kind === 'weekFable' && !isFable(s.model)) continue;
      usedUnits += usageUnits(s.tokens);
    }
    // An anchored window has only run since it opened, so coverage is measured
    // against the elapsed part rather than the full nominal span.
    const spanMs = Math.max(1, Math.min(windowMs, nowMs - since));
    const coverage = retainedDays
      ? retainedCoverage(retainedDays, since, nowMs, spanMs)
      : // No retention map, so the oldest surviving request is the only bound available.
        clamp01((nowMs - Math.max(new Date(valid[0]!.timestamp).getTime(), since)) / spanMs);
    const utilization = usedUnits / limitUnits;
    windows.push({
      kind,
      label,
      utilization,
      resetsAt: anchoredResetsAt,
      source: learned ? 'learned' : 'estimated',
      learned,
      usedUnits,
      limitUnits,
      coverage,
      pace: assessPace({
        kind,
        label,
        utilization,
        elapsed: 1,
        resetsAt: anchoredResetsAt,
        now,
        trailing: true,
        anchored: anchoredSince != null,
        coverage,
        learned,
        spanMs,
      }),
    });
  }

  // `valid` is already trimmed to the weekly window.
  const requests = valid.length;

  let unavailable: string | null = null;
  if (windows.length === 0) {
    unavailable = valid.length
      ? 'No rate-limit headers captured, and not enough history to infer a ceiling yet — that takes at least one completed window of retained logs. Set USAGE_LIMIT_5H / USAGE_LIMIT_WEEK to measure against a known ceiling instead of waiting.'
      : 'No requests captured in the last 7 days.';
  }

  return {
    windows,
    unavailable,
    observedAt: newest?.timestamp ?? null,
    meta: { requests, fromHeaders },
  };
}
