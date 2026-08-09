import type { UsageDigest } from './digest.js';

export type Severity = 'info' | 'warn' | 'high';

export interface Advice {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** The metric this advice is derived from (for UI drill-down). */
  metric?: string;
}

/** Editable thresholds for the heuristic rules. */
export const ADVICE_THRESHOLDS = {
  dominantToolPct: 15, // a single tool this % of tool bytes → flag it
  toolOverheadPct: 50, // tool schemas this % of input tokens → flag it
  lowCacheHitRatio: 0.5, // below this (with enough traffic) → suggest reuse
  minRequestsForCacheAdvice: 20,
  largeSystemPromptBytes: 20_000,
  highDailyCostUsd: 20,
};

const SEVERITY_RANK: Record<Severity, number> = { high: 0, warn: 1, info: 2 };

/**
 * Deterministic advice from the digest numbers. Same digest in → same advice
 * out; no network, no model. Each rule is small and independently testable.
 */
export class HeuristicAdviceProvider {
  advise(d: UsageDigest): Advice[] {
    const out: Advice[] = [];

    if (d.requestCount === 0) {
      out.push({
        id: 'no-activity',
        severity: 'info',
        title: 'No Claude activity',
        detail: 'No requests were captured for this day.',
        metric: 'requestCount',
      });
      return out;
    }

    const top = d.topTools[0];
    if (top && top.pctOfToolBytes >= ADVICE_THRESHOLDS.dominantToolPct) {
      out.push({
        id: 'dominant-tool',
        severity: 'warn',
        title: `"${top.name}" dominates your tool payload`,
        detail: `${top.name} is ${top.pctOfToolBytes.toFixed(1)}% of all tool bytes (~${top.estTokens.toLocaleString()} tokens/day). If you rarely use it, disabling the tool trims every request's context.`,
        metric: 'topTools',
      });
    }

    if (d.toolOverheadPctOfInput >= ADVICE_THRESHOLDS.toolOverheadPct) {
      out.push({
        id: 'tool-overhead',
        severity: 'warn',
        title: 'Tool schemas are a large share of input',
        detail: `Tool definitions account for ~${d.toolOverheadPctOfInput.toFixed(0)}% of your input tokens. Pruning unused tools / MCP servers is the highest-leverage context cut.`,
        metric: 'toolOverheadPctOfInput',
      });
    }

    if (
      d.requestCount >= ADVICE_THRESHOLDS.minRequestsForCacheAdvice &&
      d.tokens.cacheHitRatio < ADVICE_THRESHOLDS.lowCacheHitRatio
    ) {
      out.push({
        id: 'low-cache-hit',
        severity: 'info',
        title: 'Low prompt-cache hit ratio',
        detail: `Only ${(d.tokens.cacheHitRatio * 100).toFixed(0)}% of your input came from cache. Frequent context resets / new sessions re-send the prompt at full price — keep sessions alive to reuse the cache.`,
        metric: 'cacheHitRatio',
      });
    }

    if (d.avgSystemPromptBytes >= ADVICE_THRESHOLDS.largeSystemPromptBytes) {
      out.push({
        id: 'large-system-prompt',
        severity: 'info',
        title: 'Large system prompt',
        detail: `Your system prompt averages ${d.avgSystemPromptBytes.toLocaleString()} bytes/request. Trimming CLAUDE.md / project instructions reduces every request.`,
        metric: 'avgSystemPromptBytes',
      });
    }

    if (d.cost.total >= ADVICE_THRESHOLDS.highDailyCostUsd) {
      out.push({
        id: 'high-cost',
        severity: 'high',
        title: 'High estimated spend today',
        detail: `Estimated ~$${d.cost.total.toFixed(2)} today. Output tokens (~$${d.cost.output.toFixed(2)}) and cache-writes (~$${d.cost.cacheWrite.toFixed(2)}) are usually the biggest levers.`,
        metric: 'cost',
      });
    }

    if (out.length === 0) {
      out.push({
        id: 'healthy',
        severity: 'info',
        title: 'Usage looks healthy',
        detail: 'No context-bloat or cost thresholds were tripped for this day.',
      });
    }

    return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  }
}

/** Convenience default instance. */
export const heuristicAdvice = new HeuristicAdviceProvider();

/** Relative move below which a metric counts as unchanged — loose, since the question is only whether this is yesterday's finding. */
export const ADVICE_STEADY_PCT = 0.1;

/**
 * How to read the number a rule fired on back off a digest, keyed by the rule's
 * own `metric`. A rule declaring no metric is not comparable, and its advice
 * always renders in full.
 */
const METRIC_READERS: Record<string, (d: UsageDigest) => number> = {
  requestCount: (d) => d.requestCount,
  topTools: (d) => d.topTools[0]?.pctOfToolBytes ?? 0,
  toolOverheadPctOfInput: (d) => d.toolOverheadPctOfInput,
  cacheHitRatio: (d) => d.tokens.cacheHitRatio,
  avgSystemPromptBytes: (d) => d.avgSystemPromptBytes,
  cost: (d) => d.cost.total,
};

/** Where one piece of advice stands against the last day that recorded its metric. */
export interface AdviceMovement {
  /** The advice this describes. */
  id: string;
  /** The metric compared, or null when the rule declares none this can read. */
  metric: string | null;
  current: number | null;
  prior: number | null;
  /** The date `prior` was read from; null when there was no day to compare against. */
  since: string | null;
  /** `|current - prior| / |prior|`, or null when nothing was comparable. */
  change: number | null;
  /**
   * True only when the metric was read on both days and moved less than
   * {@link ADVICE_STEADY_PCT}. **Absent evidence never makes a card steady**: an
   * unreadable metric and a missing prior day both report false, like a number
   * that genuinely moved.
   */
  steady: boolean;
}

/**
 * Rate each piece of advice against the prior day that recorded something.
 *
 * Reports what moved and nothing more — the caller decides how to render a
 * finding that has not changed. A zero prior with a non-zero current reports
 * `change: 1` rather than infinity; both zero is unchanged.
 */
export function adviceMovement(
  advice: readonly Advice[],
  digest: UsageDigest,
  prior: UsageDigest | null,
): AdviceMovement[] {
  return advice.map((a) => {
    const read = a.metric ? METRIC_READERS[a.metric] : undefined;
    const metric = a.metric ?? null;
    if (!read) return { id: a.id, metric, current: null, prior: null, since: null, change: null, steady: false };
    const current = read(digest);
    if (!prior) return { id: a.id, metric, current, prior: null, since: null, change: null, steady: false };
    const before = read(prior);
    const change = before === 0 ? (current === 0 ? 0 : 1) : Math.abs(current - before) / Math.abs(before);
    return {
      id: a.id,
      metric,
      current,
      prior: before,
      since: prior.date,
      change,
      steady: change < ADVICE_STEADY_PCT,
    };
  });
}
