// Shapes mirrored from the local server contract in `server/src/service.ts`
// and the Today domain in `packages/core/src/types.ts`. The dashboard talks
// only to the local server, so it depends on the wire shape alone.

export type ProxyStatus = "healthy" | "degraded" | "unavailable";

export interface HealthPayload {
  readonly ready: boolean;
  readonly server: { readonly status: string; readonly startedAt: string | null };
  readonly proxy: {
    readonly status: ProxyStatus;
    readonly state: string | null;
    readonly updatedAt: string | null;
  };
  readonly database: {
    readonly status: string;
    readonly path: string;
    readonly schemaVersion: number;
    readonly journalMode: string;
    readonly recordCount: number;
  };
  readonly ingest: {
    readonly lastSuccessfulAt: string | null;
    readonly rejectedSidecars: number;
  };
  readonly sse: { readonly subscribers: number };
}

export interface PricedCost {
  readonly currency: string;
  readonly amountUsd: string;
  readonly catalogueVersion: string;
}

export type CostUnavailableReason =
  | { readonly code: "unknown-model"; readonly model: string }
  | { readonly code: "missing-category-price"; readonly model: string; readonly category: string }
  | { readonly code: "aggregate-incomplete"; readonly detail: string };

export interface SummaryPayload {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseCost(value: unknown): PricedCost | null {
  if (value === null) return null;
  if (!isRecord(value) || !string(value.currency) || !string(value.amountUsd)) return null;
  if (typeof value.catalogueVersion !== "string") return null;
  return {
    currency: value.currency,
    amountUsd: value.amountUsd,
    catalogueVersion: value.catalogueVersion,
  };
}

function parseCostUnavailableReason(value: unknown): CostUnavailableReason | null {
  if (value === null) return null;
  if (!isRecord(value)) return null;
  switch (value.code) {
    case "unknown-model":
      return string(value.model) ? { code: "unknown-model", model: value.model } : null;
    case "missing-category-price":
      return string(value.model) && string(value.category)
        ? { code: "missing-category-price", model: value.model, category: value.category }
        : null;
    case "aggregate-incomplete":
      return string(value.detail) ? { code: "aggregate-incomplete", detail: value.detail } : null;
    default:
      return null;
  }
}

export function parseHealth(value: unknown): HealthPayload {
  if (
    !isRecord(value) ||
    typeof value.ready !== "boolean" ||
    !isRecord(value.server) ||
    !isRecord(value.proxy) ||
    !isRecord(value.database) ||
    !isRecord(value.ingest) ||
    !isRecord(value.sse)
  ) {
    throw new Error("malformed health payload");
  }
  const proxy = value.proxy;
  const database = value.database;
  const ingest = value.ingest;
  const sse = value.sse;
  if (
    !string(value.server.status) ||
    !(
      proxy.status === "healthy" ||
      proxy.status === "degraded" ||
      proxy.status === "unavailable"
    ) ||
    !number(database.recordCount) ||
    !number(ingest.rejectedSidecars) ||
    !number(sse.subscribers)
  ) {
    throw new Error("malformed health payload");
  }
  return {
    ready: value.ready,
    server: {
      status: value.server.status,
      startedAt: string(value.server.startedAt) ? value.server.startedAt : null,
    },
    proxy: {
      status: proxy.status,
      state: string(proxy.state) ? proxy.state : null,
      updatedAt: string(proxy.updatedAt) ? proxy.updatedAt : null,
    },
    database: {
      status: string(database.status) ? database.status : "unknown",
      path: string(database.path) ? database.path : "",
      schemaVersion: number(database.schemaVersion) ? database.schemaVersion : 0,
      journalMode: string(database.journalMode) ? database.journalMode : "",
      recordCount: database.recordCount,
    },
    ingest: {
      lastSuccessfulAt: string(ingest.lastSuccessfulAt) ? ingest.lastSuccessfulAt : null,
      rejectedSidecars: ingest.rejectedSidecars,
    },
    sse: { subscribers: sse.subscribers },
  };
}

export function parseSummary(value: unknown): SummaryPayload {
  if (!isRecord(value)) throw new Error("malformed summary payload");
  const numeric = [value.inputTokens, value.outputTokens, value.totalTokens, value.requestCount];
  if (
    !string(value.reportTimezone) ||
    !string(value.startInclusive) ||
    !string(value.endExclusive) ||
    numeric.some((entry) => !number(entry)) ||
    !(value.latestEventTimestamp === null || string(value.latestEventTimestamp))
  ) {
    throw new Error("malformed summary payload");
  }
  return {
    reportTimezone: value.reportTimezone,
    startInclusive: value.startInclusive,
    endExclusive: value.endExclusive,
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number,
    totalTokens: value.totalTokens as number,
    requestCount: value.requestCount as number,
    latestEventTimestamp: string(value.latestEventTimestamp) ? value.latestEventTimestamp : null,
    cost: parseCost(value.cost),
    costUnavailableReason: parseCostUnavailableReason(value.costUnavailableReason),
  };
}

export interface UsageTotals {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export interface UsageAggregate {
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

export interface HistoryPayload {
  readonly dataVersion: number;
  readonly total: number;
  readonly offset: number;
  readonly limit: number | null;
  readonly nextOffset: number | null;
  readonly records: readonly HistoryRecord[];
}

export interface DailyUsageBucket extends UsageAggregate {
  readonly reportTimezone: string;
  readonly date: string;
  readonly startInclusive: string;
  readonly endExclusive: string;
}

export interface TrendsPayload {
  readonly dataVersion: number;
  readonly reportTimezone: string;
  readonly startInclusive: string | null;
  readonly endExclusive: string;
  readonly buckets: readonly DailyUsageBucket[];
  readonly total: UsageAggregate;
}

export interface CarFilters {
  readonly from?: string;
  readonly to?: string;
  readonly model?: readonly string[];
}

function parseUsageTotals(value: unknown): UsageTotals {
  if (!isRecord(value)) throw new Error("malformed usage totals");
  const numeric = [
    value.inputTokens,
    value.cachedInputTokens,
    value.outputTokens,
    value.reasoningOutputTokens,
    value.totalTokens,
  ];
  if (numeric.some((entry) => !number(entry))) throw new Error("malformed usage totals");
  return {
    inputTokens: value.inputTokens as number,
    cachedInputTokens: value.cachedInputTokens as number,
    outputTokens: value.outputTokens as number,
    reasoningOutputTokens: value.reasoningOutputTokens as number,
    totalTokens: value.totalTokens as number,
  };
}

function parseAggregate(value: unknown): UsageAggregate {
  if (!isRecord(value)) throw new Error("malformed aggregate");
  const usage = parseUsageTotals(value);
  if (!number(value.requestCount)) throw new Error("malformed aggregate");
  return {
    requestCount: value.requestCount,
    ...usage,
    latestEventTimestamp: string(value.latestEventTimestamp) ? value.latestEventTimestamp : null,
    cost: parseCost(value.cost),
    costUnavailableReason: parseCostUnavailableReason(value.costUnavailableReason),
  };
}

function parseHistoryRecord(value: unknown): HistoryRecord {
  if (
    !isRecord(value) ||
    !string(value.recordId) ||
    !string(value.timestamp) ||
    !string(value.model) ||
    !string(value.endpoint) ||
    !number(value.responseStatus)
  ) {
    throw new Error("malformed history record");
  }
  return {
    recordId: value.recordId,
    timestamp: value.timestamp,
    model: value.model,
    endpoint: value.endpoint,
    responseStatus: value.responseStatus,
    requestId: string(value.requestId) ? value.requestId : null,
    usage: parseUsageTotals(value.usage),
    cost: parseCost(value.cost),
    costUnavailableReason: parseCostUnavailableReason(value.costUnavailableReason),
  };
}

export function parseHistory(value: unknown): HistoryPayload {
  if (
    !isRecord(value) ||
    !number(value.dataVersion) ||
    !number(value.total) ||
    !number(value.offset)
  ) {
    throw new Error("malformed history payload");
  }
  if (!Array.isArray(value.records)) throw new Error("malformed history payload");
  return {
    dataVersion: value.dataVersion,
    total: value.total,
    offset: value.offset,
    limit: number(value.limit) ? value.limit : null,
    nextOffset: number(value.nextOffset) ? value.nextOffset : null,
    records: value.records.map(parseHistoryRecord),
  };
}

function parseBucket(value: unknown): DailyUsageBucket {
  if (
    !isRecord(value) ||
    !string(value.reportTimezone) ||
    !string(value.date) ||
    !string(value.startInclusive) ||
    !string(value.endExclusive)
  ) {
    throw new Error("malformed trend bucket");
  }
  return {
    reportTimezone: value.reportTimezone,
    date: value.date,
    startInclusive: value.startInclusive,
    endExclusive: value.endExclusive,
    ...parseAggregate(value),
  };
}

export function parseTrends(value: unknown): TrendsPayload {
  if (
    !isRecord(value) ||
    !number(value.dataVersion) ||
    !string(value.reportTimezone) ||
    !string(value.endExclusive) ||
    !Array.isArray(value.buckets)
  ) {
    throw new Error("malformed trends payload");
  }
  return {
    dataVersion: value.dataVersion,
    reportTimezone: value.reportTimezone,
    startInclusive: string(value.startInclusive) ? value.startInclusive : null,
    endExclusive: value.endExclusive,
    buckets: value.buckets.map(parseBucket),
    total: parseAggregate(value.total),
  };
}

function carParams(filters: CarFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  for (const model of filters.model ?? []) params.append("model", model);
  return params;
}

export function historyPath(filters: CarFilters, limit: number, offset: number): string {
  const params = carParams(filters);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return `/api/history?${params.toString()}`;
}

export function trendsPath(filters: CarFilters): string {
  const params = carParams(filters);
  const query = params.toString();
  return `/api/trends${query ? `?${query}` : ""}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

export async function fetchHealth(): Promise<HealthPayload> {
  return parseHealth(await fetchJson("/api/health"));
}

export async function fetchSummary(): Promise<SummaryPayload> {
  return parseSummary(await fetchJson("/api/summary"));
}

export async function fetchHistory(
  filters: CarFilters,
  limit: number,
  offset: number,
): Promise<HistoryPayload> {
  return parseHistory(await fetchJson(historyPath(filters, limit, offset)));
}

export async function fetchTrends(filters: CarFilters): Promise<TrendsPayload> {
  return parseTrends(await fetchJson(trendsPath(filters)));
}
