import type { UsageDigest } from "./digest.js";

export type Severity = "info" | "warn" | "high";

export interface Advice {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** The metric this advice is derived from (for UI drill-down). */
  metric?: string;
}

/**
 * Pluggable source of coaching for a digest. The dashboard and daily job depend
 * only on this interface, so an LLM/agent-backed provider (e.g. an in-repo
 * `agents/` package) can replace the deterministic one without touching callers.
 */
export interface AdviceProvider {
  advise(digest: UsageDigest): Advice[] | Promise<Advice[]>;
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
export class HeuristicAdviceProvider implements AdviceProvider {
  advise(d: UsageDigest): Advice[] {
    const out: Advice[] = [];

    if (d.requestCount === 0) {
      out.push({
        id: "no-activity",
        severity: "info",
        title: "No Claude activity",
        detail: "No requests were captured for this day.",
        metric: "requestCount",
      });
      return out;
    }

    const top = d.topTools[0];
    if (top && top.pctOfToolBytes >= ADVICE_THRESHOLDS.dominantToolPct) {
      out.push({
        id: "dominant-tool",
        severity: "warn",
        title: `"${top.name}" dominates your tool payload`,
        detail: `${top.name} is ${top.pctOfToolBytes.toFixed(1)}% of all tool bytes (~${top.estTokens.toLocaleString()} tokens/day). If you rarely use it, disabling the tool trims every request's context.`,
        metric: "topTools",
      });
    }

    if (d.toolOverheadPctOfInput >= ADVICE_THRESHOLDS.toolOverheadPct) {
      out.push({
        id: "tool-overhead",
        severity: "warn",
        title: "Tool schemas are a large share of input",
        detail: `Tool definitions account for ~${d.toolOverheadPctOfInput.toFixed(0)}% of your input tokens. Pruning unused tools / MCP servers is the highest-leverage context cut.`,
        metric: "toolOverheadPctOfInput",
      });
    }

    if (
      d.requestCount >= ADVICE_THRESHOLDS.minRequestsForCacheAdvice &&
      d.tokens.cacheHitRatio < ADVICE_THRESHOLDS.lowCacheHitRatio
    ) {
      out.push({
        id: "low-cache-hit",
        severity: "info",
        title: "Low prompt-cache hit ratio",
        detail: `Only ${(d.tokens.cacheHitRatio * 100).toFixed(0)}% of your input came from cache. Frequent context resets / new sessions re-send the prompt at full price — keep sessions alive to reuse the cache.`,
        metric: "cacheHitRatio",
      });
    }

    if (d.avgSystemPromptBytes >= ADVICE_THRESHOLDS.largeSystemPromptBytes) {
      out.push({
        id: "large-system-prompt",
        severity: "info",
        title: "Large system prompt",
        detail: `Your system prompt averages ${d.avgSystemPromptBytes.toLocaleString()} bytes/request. Trimming CLAUDE.md / project instructions reduces every request.`,
        metric: "avgSystemPromptBytes",
      });
    }

    if (d.cost.total >= ADVICE_THRESHOLDS.highDailyCostUsd) {
      out.push({
        id: "high-cost",
        severity: "high",
        title: "High estimated spend today",
        detail: `Estimated ~$${d.cost.total.toFixed(2)} today. Output tokens (~$${d.cost.output.toFixed(2)}) and cache-writes (~$${d.cost.cacheWrite.toFixed(2)}) are usually the biggest levers.`,
        metric: "cost",
      });
    }

    if (out.length === 0) {
      out.push({
        id: "healthy",
        severity: "info",
        title: "Usage looks healthy",
        detail: "No context-bloat or cost thresholds were tripped for this day.",
      });
    }

    return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  }
}

/** Convenience default instance. */
export const heuristicAdvice = new HeuristicAdviceProvider();
