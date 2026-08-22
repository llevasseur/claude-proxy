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
