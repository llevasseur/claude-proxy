import type { SanitizedAuditSidecarV1 } from "./types.ts";

// Usage meters for rolling allowances an operator meters separately
// (`packages/core/src/usage-limits.ts` at the pinned commit). Adapted to the
// OpenAI Responses contract: there is no polled subscription-usage endpoint and
// no captured allowance header survives the privacy boundary, so every meter is
// estimated from recorded tokens against an operator-supplied ceiling. With no
// ceiling a window is omitted rather than shown against an invented denominator.

/** The separately-metered rolling allowances, in display order. */
export const USAGE_WINDOWS = ["5h", "week"] as const;
export type UsageWindowKind = (typeof USAGE_WINDOWS)[number];

/** Nominal span of each window in milliseconds; every pace calculation divides by it. */
export const USAGE_WINDOW_MS: Readonly<Record<UsageWindowKind, number>> = Object.freeze({
  "5h": 5 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
});

export const USAGE_WINDOW_LABELS: Readonly<Record<UsageWindowKind, string>> = Object.freeze({
  "5h": "5-hour window",
  week: "Weekly window",
});

/**
 * What one cached input token *meters* at against a fresh one, for the
 * allowances. This is not the cost ratio's source: it equals the catalogue's
 * cached-input discount on the gpt-5 family (0.125 against 1.25 USD per million
 * tokens), so cache-heavy windows do not read several times too high. Held
 * loosely like the pinned 0.02: both sides of the ratio move together until the
 * cache-hit mix shifts materially.
 */
export const CACHED_INPUT_METERING_WEIGHT = 0.1;

/**
 * Weighted usage units for one record, in whole deci-units so the arithmetic
 * stays in exact integers (`CACHED_INPUT_METERING_WEIGHT` has one decimal).
 * Cached input is already inside `inputTokens`, so it is reweighted rather than
 * added again; reasoning output is already inside `outputTokens`.
 */
function usageDeciUnits(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number {
  return 10 * (inputTokens - cachedInputTokens) + cachedInputTokens + 10 * outputTokens;
}

function formatUnits(deciUnits: number): string {
  const sign = deciUnits < 0 ? "-" : "";
  const absolute = Math.abs(deciUnits);
  const whole = Math.trunc(absolute / 10);
  const tenth = absolute % 10;
  return `${sign}${whole}.${tenth}`;
}

export interface UsageWindowMeter {
  readonly kind: UsageWindowKind;
  readonly label: string;
  readonly windowStartInclusive: string;
  readonly windowEndExclusive: string;
  readonly requests: number;
  /** Weighted metering units consumed inside the window, exact to one decimal. */
  readonly usedUnits: string;
  /** Operator-supplied denominator; present only when configured. */
  readonly ceilingUnits: string | null;
  /** usedUnits / ceilingUnits when a ceiling exists; null otherwise. */
  readonly utilization: number | null;
}

/**
 * Meters for each configured window ending at `now`. Windows without a
 * configured ceiling are omitted entirely, mirroring the pinned behaviour.
 */
export function computeUsageWindows(
  records: readonly Pick<SanitizedAuditSidecarV1, "timestamp" | "usage">[],
  ceilings: Readonly<Partial<Record<UsageWindowKind, number>>>,
  now: Date,
): readonly UsageWindowMeter[] {
  const timestamp = now.getTime();
  const meters: UsageWindowMeter[] = [];
  for (const kind of USAGE_WINDOWS) {
    const ceiling = ceilings[kind];
    if (typeof ceiling !== "number") continue;
    const span = USAGE_WINDOW_MS[kind];
    const start = timestamp - span;
    let requests = 0;
    let deciUnits = 0;
    for (const record of records) {
      const at = Date.parse(record.timestamp);
      if (Number.isNaN(at) || at < start || at >= timestamp) continue;
      requests += 1;
      deciUnits += usageDeciUnits(
        record.usage.inputTokens,
        record.usage.cachedInputTokens,
        record.usage.outputTokens,
      );
    }
    meters.push(
      Object.freeze({
        kind,
        label: USAGE_WINDOW_LABELS[kind],
        windowStartInclusive: new Date(start).toISOString(),
        windowEndExclusive: new Date(timestamp).toISOString(),
        requests,
        usedUnits: formatUnits(deciUnits),
        ceilingUnits: formatUnits(Math.round(ceiling * 10)),
        utilization: ceiling > 0 ? deciUnits / 10 / ceiling : null,
      }),
    );
  }
  return Object.freeze(meters);
}
