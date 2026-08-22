import type { CostUnavailableReason, PricedCost, UsageTotals } from '@codex-proxy/core';

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

export interface UsageAggregate {
  readonly requestCount: number;
  readonly usage: UsageTotals;
  readonly latestEventTimestamp: string | null;
  readonly cost: PricedCost | null;
  readonly costUnavailableReason: CostUnavailableReason | null;
}

export interface HistoryRecord {
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

export interface HistoryResponse {
  readonly dataVersion: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalRecords: number;
  readonly records: readonly HistoryRecord[];
}

export interface DailyTrendBucket extends UsageAggregate {
  readonly startInclusive: string;
  readonly endExclusive: string;
}

export interface TrendsResponse {
  readonly dataVersion: number;
  readonly reportTimezone?: string;
  readonly buckets: readonly DailyTrendBucket[];
  readonly rangeTotal: UsageAggregate;
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
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
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
