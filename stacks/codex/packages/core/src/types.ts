export interface UsageTotals {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export type PriceCategory = 'input' | 'cachedInput' | 'output' | 'reasoningOutput';

export interface ModelPricing {
  readonly model: string;
  readonly currency: 'USD';
  readonly unit: 'one-million-tokens';
  readonly effectiveDate: string;
  readonly source: string;
  readonly usdPerMillionTokens: Readonly<Partial<Record<PriceCategory, string>>>;
}

export interface PricedCost {
  readonly currency: 'USD';
  readonly amountUsd: string;
  readonly catalogueVersion: string;
}

export type CostUnavailableReason =
  | { readonly code: 'unknown-model'; readonly model: string }
  | { readonly code: 'missing-category-price'; readonly model: string; readonly category: PriceCategory }
  | { readonly code: 'aggregate-incomplete'; readonly detail: string };

export type CostResult =
  | { readonly cost: PricedCost; readonly unavailableReason: null }
  | { readonly cost: null; readonly unavailableReason: CostUnavailableReason };

export interface SanitizedAuditSidecarV1 {
  readonly schemaVersion: 1;
  readonly recordId: string;
  readonly timestamp: string;
  readonly model: string;
  readonly endpoint: string;
  readonly responseStatus: number;
  readonly requestId: string | null;
  readonly usage: UsageTotals;
  readonly cost: PricedCost | null;
  readonly costUnavailableReason: CostUnavailableReason | null;
}

export interface TodaySummary {
  readonly reportTimezone: string;
  readonly startInclusive: string;
  readonly endExclusive: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly requestCount: number;
  readonly latestEventTimestamp: string | null;
  readonly cost: PricedCost | null;
  readonly costUnavailableReason: CostUnavailableReason | null;
}
