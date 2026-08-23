import type { CostUnavailableReason, SummaryPayload } from '../api';

export type CostView =
  | { readonly kind: 'estimate'; readonly text: string }
  | { readonly kind: 'unavailable'; readonly detail: string };

// Per ADR 0003 the aggregate cost is either a complete estimate or an
// explicit unavailable state; unknown cost is never rendered as $0.
export function costView(summary: SummaryPayload): CostView {
  if (summary.cost !== null) {
    return {
      kind: 'estimate',
      text: `$${summary.cost.amountUsd} ${summary.cost.currency}`,
    };
  }
  return { kind: 'unavailable', detail: describeUnavailableCost(summary.costUnavailableReason) };
}

export function describeUnavailableCost(reason: CostUnavailableReason | null): string {
  if (reason === null) return 'cost cannot be computed for every request today';
  switch (reason.code) {
    case 'unknown-model':
      return `model "${reason.model}" is not in the price catalogue`;
    case 'missing-category-price':
      return `model "${reason.model}" has no price for ${reason.category} tokens`;
    case 'aggregate-incomplete':
      return `estimate incomplete: ${reason.detail}`;
  }
}

function formatTokens(value: number): string {
  return value.toLocaleString('en-US');
}

export interface OverviewText {
  readonly requestCount: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly totalTokens: string;
  readonly latestActivity: string;
}

export function overviewText(summary: SummaryPayload): OverviewText {
  let latestActivity: string;
  if (summary.latestEventTimestamp === null) {
    latestActivity = 'no requests yet today';
  } else {
    const timestamp = Date.parse(summary.latestEventTimestamp);
    latestActivity = Number.isNaN(timestamp)
      ? summary.latestEventTimestamp
      : new Intl.DateTimeFormat('en-US', {
          timeZone: summary.reportTimezone,
          dateStyle: 'medium',
          timeStyle: 'medium',
        }).format(new Date(timestamp));
  }
  return {
    requestCount: formatTokens(summary.requestCount),
    inputTokens: formatTokens(summary.inputTokens),
    outputTokens: formatTokens(summary.outputTokens),
    totalTokens: formatTokens(summary.totalTokens),
    latestActivity,
  };
}
