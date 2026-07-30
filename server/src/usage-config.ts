import type { UsageLimitConfig } from "@claude-proxy/core";

/**
 * Ceilings for the usage meters' estimated fallback, read from the environment.
 *
 * These are only consulted for a window Anthropic's own rate-limit headers don't
 * cover — with headers the real allowance is already known. Anthropic doesn't
 * publish subscription quotas as token counts, so there is deliberately no
 * built-in default: an unset window is omitted from the dashboard rather than
 * measured against a number this repo made up.
 *
 * Values are in the weighted units `usageUnits` counts (cache reads at a tenth).
 * `k`/`m` suffixes are accepted since the useful magnitudes are large.
 */
const ENV_KEYS: Record<keyof UsageLimitConfig, string> = {
  "5h": "USAGE_LIMIT_5H",
  week: "USAGE_LIMIT_WEEK",
  weekFable: "USAGE_LIMIT_WEEK_FABLE",
};

/** Parse `2_500_000`, `2.5m`, or `900k`; null when absent or not a positive number. */
export function parseLimit(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/[_,]/g, "");
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(cleaned);
  if (!m) return null;
  const scale = m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1;
  const n = Number(m[1]) * scale;
  return n > 0 ? n : null;
}

/** Resolve the configured per-window ceilings. Unset windows are simply absent. */
export function resolveUsageLimits(env: NodeJS.ProcessEnv = process.env): UsageLimitConfig {
  const out: UsageLimitConfig = {};
  for (const [kind, key] of Object.entries(ENV_KEYS) as [keyof UsageLimitConfig, string][]) {
    const limit = parseLimit(env[key]);
    if (limit != null) out[kind] = limit;
  }
  return out;
}
