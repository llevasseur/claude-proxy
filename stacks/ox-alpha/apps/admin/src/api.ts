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
  readonly capture: { readonly enabled: boolean };
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
    !isRecord(value.capture) ||
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
    capture: { enabled: value.capture.enabled === true },
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

// --- Boat inspection surfaces (shapes mirrored from server/src/service.ts) ---

export interface InspectionPage<T> {
  readonly captureEnabled: boolean;
  readonly total: number;
  readonly offset: number;
  readonly limit: number | null;
  readonly nextOffset: number | null;
  readonly records: readonly T[];
}

export interface ContextSummaryRecord {
  readonly recordId: string;
  readonly capturedAt: string;
  readonly endpoint: string;
  readonly model: string | null;
  readonly messageCount: number;
  readonly instructionsPresent: boolean;
  readonly toolCount: number;
  readonly toolCallCount: number;
  readonly sessionId: string;
}

export interface MessageRecord {
  readonly recordId: string;
  readonly role: string | null;
  readonly itemType: string | null;
  readonly text: string;
}

export interface ToolSchemaRecord {
  readonly recordId: string;
  readonly capturedAt: string;
  readonly name: string;
  readonly type: string;
  readonly description: string | null;
  readonly schemaJson: string;
}

export interface ToolCallRecord {
  readonly recordId: string;
  readonly capturedAt: string;
  readonly callId: string | null;
  readonly name: string;
  readonly argumentsText: string;
}

export interface SessionGroupRecord {
  readonly sessionId: string;
  readonly captureCount: number;
  readonly firstCapturedAt: string;
  readonly lastCapturedAt: string;
  readonly recordIds: readonly string[];
}

export interface PromptAnalysisPayload {
  readonly captureEnabled: boolean;
  readonly parsed: boolean;
  readonly model: string | null;
  readonly instructionsPresent: boolean;
  readonly instructionsChars: number;
  readonly inputMessageCount: number;
  readonly inputChars: number;
  readonly toolCount: number;
  readonly estimatedInputTokens: number;
}

function parseInspectionPage<T>(
  value: unknown,
  parseRecord: (record: unknown) => T,
): InspectionPage<T> {
  if (
    !isRecord(value) ||
    typeof value.captureEnabled !== "boolean" ||
    !number(value.total) ||
    !number(value.offset) ||
    !Array.isArray(value.records)
  ) {
    throw new Error("malformed inspection payload");
  }
  return {
    captureEnabled: value.captureEnabled,
    total: value.total,
    offset: value.offset,
    limit: number(value.limit) ? value.limit : null,
    nextOffset: number(value.nextOffset) ? value.nextOffset : null,
    records: value.records.map(parseRecord),
  };
}

export function parseContextSummary(value: unknown): ContextSummaryRecord {
  if (
    !isRecord(value) ||
    !string(value.recordId) ||
    !string(value.capturedAt) ||
    !string(value.endpoint) ||
    !number(value.messageCount)
  ) {
    throw new Error("malformed context summary");
  }
  return {
    recordId: value.recordId,
    capturedAt: value.capturedAt,
    endpoint: value.endpoint,
    model: string(value.model) ? value.model : null,
    messageCount: value.messageCount,
    instructionsPresent: value.instructionsPresent === true,
    toolCount: typeof value.toolCount === "number" ? value.toolCount : 0,
    toolCallCount: typeof value.toolCallCount === "number" ? value.toolCallCount : 0,
    sessionId: string(value.sessionId) ? value.sessionId : "",
  };
}

function requiredStringPair(value: unknown, firstKey: string, secondKey: string): void {
  if (!isRecord(value) || !string(value[firstKey]) || !string(value[secondKey])) {
    throw new Error("malformed inspection record");
  }
}

export function parseMessageRecord(value: unknown): MessageRecord {
  requiredStringPair(value, "recordId", "text");
  const record = value as Record<string, unknown>;
  return {
    recordId: record.recordId as string,
    role: string(record.role) ? record.role : null,
    itemType: string(record.itemType) ? record.itemType : null,
    text: record.text as string,
  };
}

export function parseToolSchemaRecord(value: unknown): ToolSchemaRecord {
  requiredStringPair(value, "recordId", "name");
  const record = value as Record<string, unknown>;
  return {
    recordId: record.recordId as string,
    capturedAt: string(record.capturedAt) ? record.capturedAt : "",
    name: record.name as string,
    type: string(record.type) ? record.type : "unknown",
    description: string(record.description) ? record.description : null,
    schemaJson: string(record.schemaJson) ? record.schemaJson : "{}",
  };
}

export function parseToolCallRecord(value: unknown): ToolCallRecord {
  requiredStringPair(value, "recordId", "name");
  const record = value as Record<string, unknown>;
  return {
    recordId: record.recordId as string,
    capturedAt: string(record.capturedAt) ? record.capturedAt : "",
    callId: string(record.callId) ? record.callId : null,
    name: record.name as string,
    argumentsText: string(record.argumentsText) ? record.argumentsText : "",
  };
}

export function parseSessionGroup(value: unknown): SessionGroupRecord {
  requiredStringPair(value, "sessionId", "firstCapturedAt");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.recordIds)) throw new Error("malformed session group");
  return {
    sessionId: record.sessionId as string,
    captureCount: number(record.captureCount) ? record.captureCount : 0,
    firstCapturedAt: record.firstCapturedAt as string,
    lastCapturedAt: string(record.lastCapturedAt) ? record.lastCapturedAt : "",
    recordIds: record.recordIds.filter(string),
  };
}

export function parsePromptAnalysis(value: unknown): PromptAnalysisPayload {
  if (!isRecord(value) || typeof value.captureEnabled !== "boolean") {
    throw new Error("malformed prompt analysis payload");
  }
  return {
    captureEnabled: value.captureEnabled,
    parsed: value.parsed === true,
    model: string(value.model) ? value.model : null,
    instructionsPresent: value.instructionsPresent === true,
    instructionsChars: number(value.instructionsChars) ? value.instructionsChars : 0,
    inputMessageCount: number(value.inputMessageCount) ? value.inputMessageCount : 0,
    inputChars: number(value.inputChars) ? value.inputChars : 0,
    toolCount: number(value.toolCount) ? value.toolCount : 0,
    estimatedInputTokens: number(value.estimatedInputTokens) ? value.estimatedInputTokens : 0,
  };
}

function inspectionPath(base: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return `/api/inspection/${base}${query ? `?${query}` : ""}`;
}

async function fetchInspectionPage<T>(url: string, parseRecord: (record: unknown) => T) {
  return parseInspectionPage(await fetchJson(url), parseRecord);
}

const DEFAULT_INSPECTION_LIMIT = 25;

export function fetchInspectionDay(date: string | undefined, limit: number, offset: number) {
  return fetchInspectionPage(inspectionPath("day", { date, limit, offset }), parseContextSummary);
}

export function fetchInspectionMessages(recordId: string, limit: number, offset: number) {
  return fetchInspectionPage(
    inspectionPath("messages", { recordId, limit, offset }),
    parseMessageRecord,
  );
}

export function fetchInspectionTools(limit: number, offset: number) {
  return fetchInspectionPage(inspectionPath("tools", { limit, offset }), parseToolSchemaRecord);
}

export function fetchInspectionToolCalls(limit: number, offset: number) {
  return fetchInspectionPage(inspectionPath("tool-calls", { limit, offset }), parseToolCallRecord);
}

export function fetchInspectionSessions(limit: number, offset: number) {
  return fetchInspectionPage(inspectionPath("sessions", { limit, offset }), parseSessionGroup);
}

export interface SessionLivenessRecord {
  readonly state: "running" | "quiet" | "finished" | "unknown";
  readonly lastActivity: string | null;
  readonly idleMs: number | null;
  readonly quietAfterMs: number;
  readonly terminal: boolean;
}

function parseLiveness(value: unknown): SessionLivenessRecord | null {
  if (!isRecord(value) || !string(value.state)) return null;
  return {
    state: value.state as SessionLivenessRecord["state"],
    lastActivity: string(value.lastActivity) ? (value.lastActivity as string) : null,
    idleMs: number(value.idleMs) ? (value.idleMs as number) : null,
    quietAfterMs: number(value.quietAfterMs) ? (value.quietAfterMs as number) : 0,
    terminal: value.terminal === true,
  };
}

export interface SessionDetailPayload extends InspectionPage<ContextSummaryRecord> {
  readonly sessionId: string;
}

export function fetchSessionDetail(id: string): Promise<SessionDetailPayload> {
  return fetchInspectionPage(
    inspectionPath("sessions/detail", { id }),
    parseContextSummary,
  ) as Promise<SessionDetailPayload>;
}

export interface SessionBreakdownPayload {
  readonly captureEnabled: boolean;
  readonly sessionId: string;
  readonly captures: number;
  readonly models: ReadonlyArray<{ readonly model: string; readonly requests: number }>;
  readonly hours: ReadonlyArray<{ readonly hour: string; readonly captures: number }>;
}

export async function fetchSessionBreakdown(id: string): Promise<SessionBreakdownPayload> {
  const value = await fetchJson(inspectionPath("sessions/breakdown", { id }));
  if (!isRecord(value) || !number(value.captures) || !Array.isArray(value.models)) {
    throw new Error("malformed session breakdown");
  }
  const record = value as Record<string, unknown>;
  return {
    captureEnabled: record.captureEnabled === true,
    sessionId: string(record.sessionId) ? (record.sessionId as string) : "",
    captures: record.captures as number,
    models: (record.models as unknown[]).map((entry) => {
      if (!isRecord(entry) || !string(entry.model)) throw new Error("malformed model count");
      return {
        model: entry.model as string,
        requests: number(entry.requests) ? (entry.requests as number) : 0,
      };
    }),
    hours: Array.isArray(record.hours)
      ? (record.hours as unknown[]).map((entry) => {
          if (!isRecord(entry) || !string(entry.hour)) throw new Error("malformed hour count");
          return {
            hour: entry.hour as string,
            captures: number(entry.captures) ? (entry.captures as number) : 0,
          };
        })
      : [],
  };
}

export interface ErrorsPayload {
  readonly rejectedSidecars: ReadonlyArray<{
    readonly filename: string;
    readonly reason: string;
    readonly rejectedAt: string;
  }>;
  readonly unreadableCaptures: number;
}

export async function fetchErrors(): Promise<ErrorsPayload> {
  const value = await fetchJson("/api/inspection/errors");
  if (
    !isRecord(value) ||
    !Array.isArray(value.rejectedSidecars) ||
    !number(value.unreadableCaptures)
  ) {
    throw new Error("malformed errors payload");
  }
  return {
    rejectedSidecars: (value.rejectedSidecars as unknown[]).map((entry) => {
      if (!isRecord(entry) || !string(entry.filename) || !string(entry.reason)) {
        throw new Error("malformed rejected sidecar");
      }
      return {
        filename: entry.filename as string,
        reason: entry.reason as string,
        rejectedAt: string(entry.rejectedAt) ? (entry.rejectedAt as string) : "",
      };
    }),
    unreadableCaptures: value.unreadableCaptures as number,
  };
}

export async function fetchPromptAnalysis(recordId: string): Promise<PromptAnalysisPayload> {
  return parsePromptAnalysis(await fetchJson(inspectionPath("prompt", { recordId })));
}

export interface PromptCohortRecord {
  readonly key: string;
  readonly label: string;
  readonly identified: boolean;
  readonly hash: string | null;
  readonly models: readonly string[];
  readonly requests: number;
  readonly share: number;
  readonly meanChars: number;
  readonly totalChars: number;
  readonly contribution: number;
}

export interface PromptMixPayload {
  readonly captureEnabled: boolean;
  readonly date: string;
  readonly requests: number;
  readonly meanChars: number;
  readonly medianChars: number;
  readonly identifiedShare: number;
  readonly cohorts: readonly PromptCohortRecord[];
}

export function fetchPromptMix(date?: string): Promise<PromptMixPayload> {
  return fetchJson(inspectionPath("prompt-mix", { date })) as Promise<PromptMixPayload>;
}

export interface PromptListingRecord {
  readonly recordId: string;
  readonly capturedAt: string;
  readonly model: string | null;
  readonly instructionsHash: string | null;
  readonly sectionCount: number;
}

export function fetchPromptListings(
  date?: string,
  hash?: string,
): Promise<InspectionPage<PromptListingRecord>> {
  return fetchInspectionPage(
    inspectionPath("prompts", { date, hash }),
    (record: unknown): PromptListingRecord => {
      if (!isRecord(record) || !string(record.recordId)) {
        throw new Error("malformed prompt listing record");
      }
      const value = record as Record<string, unknown>;
      return {
        recordId: value.recordId as string,
        capturedAt: string(value.capturedAt) ? (value.capturedAt as string) : "",
        model: string(value.model) ? (value.model as string) : null,
        instructionsHash: string(value.instructionsHash)
          ? (value.instructionsHash as string)
          : null,
        sectionCount: number(value.sectionCount) ? (value.sectionCount as number) : 0,
      };
    },
  );
}

export interface PromptSectionsPayload {
  readonly captureEnabled: boolean;
  readonly instructionsHash: string | null;
  readonly sections: ReadonlyArray<{
    readonly kind: "instructions" | "message";
    readonly index: number | null;
    readonly role: string | null;
    readonly itemType: string | null;
    readonly chars: number;
  }>;
}

export function fetchPromptSections(recordId: string): Promise<PromptSectionsPayload> {
  return fetchJson(
    inspectionPath("prompt-sections", { recordId }),
  ) as Promise<PromptSectionsPayload>;
}

export { DEFAULT_INSPECTION_LIMIT };
