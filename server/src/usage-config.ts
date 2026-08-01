import { USAGE_LIMIT_ENV_SUFFIX, type UsageLimitConfig, type UsageWindowKind } from "@claude-proxy/core";

/**
 * Ceilings for the usage meters' estimated fallback, consulted only for windows
 * Anthropic's rate-limit headers don't cover. Anthropic doesn't publish
 * subscription quotas as token counts, so there is deliberately no default: an
 * unset window falls back to a ceiling learned from history, and failing that is
 * omitted rather than measured against an invented number. Setting one of these
 * overrides the learned floor with a figure that actually knows the allowance.
 *
 * Values are in the weighted units `usageUnits` counts, with `k`/`m` suffixes.
 */
const ENV_KEYS = Object.fromEntries(
  Object.entries(USAGE_LIMIT_ENV_SUFFIX).map(([kind, suffix]) => [kind, `USAGE_LIMIT_${suffix}`]),
) as Record<UsageWindowKind, string>;

/** Parse a digit-group or `k`/`m`-suffixed count; null unless it is a positive number. */
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
