import type { CostUnavailableReason, PricedCost } from '@codex-proxy/core';

export interface CarFilters {
  readonly from?: string;
  readonly to?: string;
  readonly models?: readonly string[];
}

export interface HistoryQuery extends CarFilters {
  readonly page: number;
  readonly pageSize: number;
}

export const HISTORY_PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_HISTORY_PAGE_SIZE = 25;

export interface HistoryRecord {
  readonly recordId: string;
  readonly timestamp: string;
  readonly model: string;
  readonly endpoint: string;
  readonly responseStatus: number;
  readonly requestId: string | null;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly cost: PricedCost | null;
  readonly costUnavailableReason: CostUnavailableReason | null;
}

export interface HistoryResponse {
  readonly dataVersion: number;
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly records: readonly HistoryRecord[];
}

export interface DailyTrendBucket {
  readonly reportTimezone: string;
  readonly date: string;
  readonly startInclusive: string;
  readonly endExclusive: string;
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly latestEventTimestamp: string | null;
  readonly cost: PricedCost | null;
  readonly costUnavailableReason: CostUnavailableReason | null;
}

export interface TrendRangeTotal {
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly latestEventTimestamp: string | null;
  readonly cost: PricedCost | null;
  readonly costUnavailableReason: CostUnavailableReason | null;
}

export interface TrendsResponse {
  readonly dataVersion: number;
  readonly reportTimezone: string;
  readonly startInclusive: string | null;
  readonly endExclusive: string;
  readonly buckets: readonly DailyTrendBucket[];
  readonly total: TrendRangeTotal;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

function carParams(filters: CarFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  for (const model of filters.models ?? []) params.append('model', model);
  return params;
}

export function historyPath(query: HistoryQuery): string {
  const params = carParams(query);
  params.set('limit', String(query.pageSize));
  params.set('offset', String((query.page - 1) * query.pageSize));
  return `/api/history?${params.toString()}`;
}

export function trendsPath(filters: CarFilters): string {
  return `/api/trends?${carParams(filters).toString()}`;
}

export function getHistory(query: HistoryQuery): Promise<HistoryResponse> {
  return getJson(historyPath(query));
}

export function getTrends(filters: CarFilters): Promise<TrendsResponse> {
  return getJson(trendsPath(filters));
}
