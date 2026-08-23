import type { CostUnavailableReason, PricedCost } from "../api";
import { describeUnavailableCost } from "../overview/format";

// Cell formatting ported from codex-proxy `apps/admin/src/car/format.ts`;
// ADR 0003 applies unchanged: unavailable cost is never rendered as $0.

export interface CostCell {
  readonly text: string;
  readonly unavailable: boolean;
}

export function costCell(value: {
  readonly cost: PricedCost | null;
  readonly costUnavailableReason: CostUnavailableReason | null;
}): CostCell {
  if (value.cost !== null) {
    return { text: `$${value.cost.amountUsd} ${value.cost.currency}`, unavailable: false };
  }
  return { text: "unavailable", unavailable: true };
}

export function unavailableReasonText(reason: CostUnavailableReason | null): string {
  return reason === null
    ? "cost cannot be computed for every request"
    : describeUnavailableCost(reason);
}

export function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatTimestamp(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return timestamp;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "medium" }).format(
    new Date(ms),
  );
}

// Day labels come from the bucket's own start instant rendered in the report
// timezone, so DST-shifted days (23- and 25-hour) label correctly.
export function formatDay(startInclusive: string, timeZone: string): string {
  const ms = Date.parse(startInclusive);
  if (Number.isNaN(ms)) return startInclusive;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}
