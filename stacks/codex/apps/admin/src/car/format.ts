import type { CostUnavailableReason, PricedCost } from '@agent-proxy/codex-core';

const TOKEN_FORMAT = new Intl.NumberFormat();
const TIMESTAMP_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatTokens(value: number): string {
  return TOKEN_FORMAT.format(value);
}

export function formatUsd(cost: PricedCost): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: cost.currency,
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  }).format(Number(cost.amountUsd));
}

export interface CostCellText {
  readonly text: string;
  readonly unavailable: boolean;
}

export function costCell(cost: PricedCost | null): CostCellText {
  return cost ? { text: formatUsd(cost), unavailable: false } : { text: 'Unavailable', unavailable: true };
}

export function unavailableReasonText(reason: CostUnavailableReason): string {
  if (reason.code === 'unknown-model') return `Unknown model: ${reason.model}`;
  if (reason.code === 'missing-category-price') return `Missing ${reason.category} price for ${reason.model}.`;
  return `Incomplete aggregate: ${reason.detail}.`;
}

export function formatTimestamp(timestamp: string): string {
  return TIMESTAMP_FORMAT.format(new Date(timestamp));
}

export function formatDay(startInclusive: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone }).format(new Date(startInclusive));
}
