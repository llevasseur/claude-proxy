import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  aggregateDailyBuckets,
  aggregateRangeFromBuckets,
  type CaptureEnvelopeV1,
  computeUsageWindows,
  formatReportDate,
  resolveCalendarRange,
} from "@ox-alpha-proxy/core";
import { CaptureStore } from "./capture.ts";
import type { ServerConfig } from "./config.ts";
import { UsageDatabase } from "./database.ts";
import { EventHub } from "./events.ts";
import { SidecarIngestor } from "./ingest.ts";
import {
  assembleDay,
  collectContextSummaries,
  collectLiveness,
  collectMessages,
  collectPromptListings,
  collectPromptMix,
  collectPromptSections,
  collectSessionBreakdown,
  collectSessionDetail,
  collectSessions,
  collectToolCalls,
  collectToolSchemas,
  type DayInspection,
} from "./inspection.ts";

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

type ProxyState = "startup" | "starting" | "ready" | "upstream-error" | "shutdown";

interface ProxyStatusFile {
  readonly state: ProxyState;
  readonly updatedAt: string;
  readonly rollingUsage?: unknown;
}

// Typed rejection for malformed query strings on the new endpoints; Bike
// endpoints keep their untouched contract (ADR 0011).
class BadRequestError extends Error {}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function calendarParameter(searchParams: URLSearchParams, name: string): string | null {
  const value = searchParams.get(name);
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestError(`${name} must be a YYYY-MM-DD calendar date`);
  }
  return value;
}

function pagination(searchParams: URLSearchParams): Readonly<{ limit: number; offset: number }> {
  const rawLimit = searchParams.get("limit");
  const rawOffset = searchParams.get("offset");
  const limit = rawLimit === null ? HISTORY_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > HISTORY_MAX_LIMIT) {
    throw new BadRequestError(`limit must be an integer between 1 and ${HISTORY_MAX_LIMIT}`);
  }
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new BadRequestError("offset must be a non-negative integer");
  }
  return Object.freeze({ limit, offset });
}

function invalidQuery(error: unknown): boolean {
  return error instanceof BadRequestError || error instanceof RangeError;
}

// Offset pagination shared by every Boat inspection listing.
function page<T>(
  records: readonly T[],
  limit: number,
  offset: number,
): Readonly<{
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  records: readonly T[];
}> {
  return Object.freeze({
    total: records.length,
    offset,
    limit,
    nextOffset: offset + limit < records.length ? offset + limit : null,
    records: Object.freeze(records.slice(offset, offset + limit)),
  });
}

interface ProxyRollingUsage {
  readonly windowStartedAt: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

function validRollingUsage(value: unknown): value is ProxyRollingUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rolling = value as Record<string, unknown>;
  const counters = [
    rolling.requests,
    rolling.inputTokens,
    rolling.cachedInputTokens,
    rolling.outputTokens,
    rolling.reasoningOutputTokens,
    rolling.totalTokens,
  ];
  return (
    typeof rolling.windowStartedAt === "string" &&
    !Number.isNaN(Date.parse(rolling.windowStartedAt)) &&
    counters.every((counter) => typeof counter === "number" && Number.isSafeInteger(counter))
  );
}

function validProxyStatus(value: unknown): value is ProxyStatusFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return (
    ["startup", "starting", "ready", "upstream-error", "shutdown"].includes(String(status.state)) &&
    typeof status.updatedAt === "string" &&
    !Number.isNaN(Date.parse(status.updatedAt)) &&
    (status.rollingUsage === undefined || validRollingUsage(status.rollingUsage))
  );
}

export class LiveUsageService {
  private readonly database: UsageDatabase;
  private readonly events = new EventHub();
  private readonly ingestor: SidecarIngestor;
  private readonly captures: CaptureStore;
  private captureMaintenance: NodeJS.Timeout | null = null;
  // ADR 0012: monotonic version advanced whenever ingest changes the view,
  // including backfill of records outside today.
  private dataVersion = 0;
  // Inspection memoization (inherited codex-proxy `context-day-memo`
  // pattern): parsed captures and per-day assemblies are memoized against a
  // key combining the directory signature and a retention-deletion epoch, so
  // either a capture write/change or a retention deletion invalidates.
  private inspectionEpoch = 0;
  private captureMemo: Readonly<{
    key: string;
    value: Readonly<{ envelopes: readonly CaptureEnvelopeV1[]; unreadable: number }>;
  }> | null = null;
  private readonly dayMemos = new Map<string, { key: string; assembly: DayInspection }>();
  private inspectionAssemblyCount = 0;
  private inspectionCacheHitCount = 0;
  private ready = false;
  private startedAt: string | null = null;
  private proxy: Readonly<{
    status: "healthy" | "degraded" | "unavailable";
    state: ProxyState | null;
    updatedAt: string | null;
    rollingUsage: ProxyRollingUsage | null;
  }> = Object.freeze({
    status: "unavailable",
    state: null,
    updatedAt: null,
    rollingUsage: null,
  });
  private readonly server = createServer(async (request, response) => {
    try {
      await this.route(request, response);
    } catch {
      if (!response.headersSent) json(response, 500, { error: "internal_error" });
      else response.end();
    }
  });

  constructor(
    private readonly config: ServerConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.database = new UsageDatabase(config.databasePath);
    this.captures = new CaptureStore(
      config.captureDirectory,
      config.captureEnabled,
      config.captureRetentionMs,
      config.captureMaxBytes,
      clock,
    );
    this.ingestor = new SidecarIngestor(
      config.auditDirectory,
      this.database,
      clock,
      async (result) => {
        if (result.changed) {
          this.dataVersion += 1;
          this.events.publishDataVersion(this.dataVersion);
        }
        await this.refresh();
      },
    );
  }

  private async readProxyStatus(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.config.proxyStatusPath, "utf8"));
      if (!validProxyStatus(parsed)) throw new Error("invalid proxy status");
      this.proxy = Object.freeze({
        status: parsed.state === "ready" ? "healthy" : "degraded",
        state: parsed.state,
        updatedAt: parsed.updatedAt,
        rollingUsage: validRollingUsage(parsed.rollingUsage)
          ? Object.freeze({ ...parsed.rollingUsage })
          : null,
      });
    } catch {
      this.proxy = Object.freeze({
        status: "unavailable",
        state: null,
        updatedAt: null,
        rollingUsage: null,
      });
    }
  }

  health(): unknown {
    const diagnostics = this.database.diagnostics();
    return Object.freeze({
      ready: this.ready,
      server: Object.freeze({
        status: this.ready ? "ready" : "starting",
        startedAt: this.startedAt,
      }),
      proxy: this.proxy,
      database: Object.freeze({
        status: "ready",
        path: this.database.path,
        schemaVersion: this.database.schemaVersion,
        journalMode: this.database.journalMode,
        recordCount: diagnostics.recordCount,
      }),
      ingest: Object.freeze({
        lastSuccessfulAt: diagnostics.lastSuccessfulIngest,
        rejectedSidecars: diagnostics.rejectedSidecars,
      }),
      capture: Object.freeze({ enabled: this.config.captureEnabled }),
      sse: Object.freeze({ subscribers: this.events.subscriberCount }),
    });
  }

  summary(): unknown {
    return this.database.summary(this.clock(), this.config.reportTimezone);
  }

  snapshot(): Readonly<{ health: unknown; summary: unknown }> {
    return Object.freeze({ health: this.health(), summary: this.summary() });
  }

  async refresh(): Promise<boolean> {
    await this.readProxyStatus();
    return this.events.publish(this.snapshot());
  }

  async reconcile(): Promise<void> {
    await this.ingestor.reconcile();
  }

  // Retention maintenance is also headless-invocable via `pnpm --filter
  // @ox-alpha-proxy/server maintain`; this periodic pass keeps a running
  // server within its window and size cap without operator action.
  async maintainCaptures(): Promise<void> {
    const result = await this.captures.maintain();
    if (result.deletedExpired + result.deletedOverCap > 0) this.inspectionEpoch += 1;
  }

  // Test-visible memoization counters; deliberately not an HTTP surface.
  inspectionStats(): Readonly<{ assemblies: number; cacheHits: number }> {
    return Object.freeze({
      assemblies: this.inspectionAssemblyCount,
      cacheHits: this.inspectionCacheHitCount,
    });
  }

  private async captureKey(): Promise<string> {
    const signature = this.config.captureEnabled ? await this.captures.signature() : "disabled";
    return `${this.inspectionEpoch}:${signature}`;
  }

  private async envelopes(): Promise<
    Readonly<{ envelopes: readonly CaptureEnvelopeV1[]; unreadable: number }>
  > {
    // A disabled server never reads the capture directory (typed empties).
    if (!this.config.captureEnabled) {
      return Object.freeze({ envelopes: Object.freeze([]), unreadable: 0 });
    }
    const key = await this.captureKey();
    if (this.captureMemo?.key === key) return this.captureMemo.value;
    const value = await this.captures.list();
    this.captureMemo = { key, value };
    return value;
  }

  private async dayAssembly(date: string): Promise<DayInspection> {
    // A disabled server assembles nothing and counts nothing.
    if (!this.config.captureEnabled) {
      return Object.freeze({
        date,
        captureCount: 0,
        unreadableCaptures: 0,
        totalMessages: 0,
        totalToolCalls: 0,
        captures: Object.freeze([]),
      });
    }
    const key = await this.captureKey();
    const memo = this.dayMemos.get(date);
    if (memo !== undefined && memo.key === key) {
      this.inspectionCacheHitCount += 1;
      return memo.assembly;
    }
    this.inspectionAssemblyCount += 1;
    const { envelopes, unreadable } = await this.envelopes();
    const assembly = assembleDay(date, envelopes, unreadable);
    this.dayMemos.set(date, { key, assembly });
    return assembly;
  }

  private findEnvelope(recordId: string): CaptureEnvelopeV1 | null {
    // Synchronous lookup is safe here because every handler awaits
    // `envelopes()` (which populates the memo) before resolving a recordId.
    return (
      this.captureMemo?.value.envelopes.find((envelope) => envelope.recordId === recordId) ?? null
    );
  }

  private requireRecordId(searchParams: URLSearchParams): string {
    const recordId = searchParams.get("recordId");
    if (recordId === null || recordId.length === 0) {
      throw new BadRequestError("recordId is required");
    }
    return recordId;
  }

  private inspectionPage<T>(
    response: ServerResponse,
    captureEnabled: boolean,
    listing: readonly T[],
    limit: number,
    offset: number,
  ): void {
    json(response, 200, {
      captureEnabled,
      ...page(listing, limit, offset),
    });
  }

  private async handleInspection(
    pathname: string,
    searchParams: URLSearchParams,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const enabled = this.config.captureEnabled;
      switch (pathname) {
        case "/api/inspection/day": {
          const rawDate = calendarParameter(searchParams, "date");
          const date =
            rawDate ?? formatReportDate(this.clock().getTime(), this.config.reportTimezone);
          const { limit, offset } = pagination(searchParams);
          const assembly = await this.dayAssembly(date);
          this.inspectionPage(response, enabled, assembly.captures, limit, offset);
          return;
        }
        case "/api/inspection/messages": {
          // Query validity does not depend on whether the record exists, so
          // pagination is parsed before the lookup that can 404.
          const { limit, offset } = pagination(searchParams);
          const recordId = this.requireRecordId(searchParams);
          await this.envelopes();
          const envelope = this.findEnvelope(recordId);
          if (envelope === null) {
            // Degrade gracefully when capture is off; a real miss with
            // capture on is a 404.
            if (!enabled) {
              this.inspectionPage(response, enabled, [], limit, offset);
              return;
            }
            json(response, 404, { error: "not_found" });
            return;
          }
          const { request, response: responseEntries } = collectMessages(envelope);
          const merged = [...request, ...responseEntries];
          this.inspectionPage(response, enabled, merged, limit, offset);
          return;
        }
        case "/api/inspection/prompt": {
          const recordId = this.requireRecordId(searchParams);
          await this.envelopes();
          const envelope = this.findEnvelope(recordId);
          if (envelope === null) {
            if (!enabled) {
              json(response, 200, {
                captureEnabled: false,
                parsed: false,
                model: null,
                instructionsPresent: false,
                instructionsChars: 0,
                inputMessageCount: 0,
                inputChars: 0,
                toolCount: 0,
                estimatedInputTokens: 0,
              });
              return;
            }
            json(response, 404, { error: "not_found" });
            return;
          }
          json(response, 200, { captureEnabled: true, ...collectMessages(envelope).analysis });
          return;
        }
        case "/api/inspection/prompt-mix": {
          const rawDate = calendarParameter(searchParams, "date");
          const date =
            rawDate ?? formatReportDate(this.clock().getTime(), this.config.reportTimezone);
          await this.envelopes();
          json(response, 200, {
            captureEnabled: enabled,
            ...collectPromptMix(date, this.captureMemo?.value.envelopes ?? []),
          });
          return;
        }
        case "/api/inspection/prompts": {
          const rawDate = calendarParameter(searchParams, "date");
          const date =
            rawDate ?? formatReportDate(this.clock().getTime(), this.config.reportTimezone);
          await this.envelopes();
          let listings = collectPromptListings(date, this.captureMemo?.value.envelopes ?? []);
          const hash = searchParams.get("hash");
          if (hash !== null) listings = listings.filter((entry) => entry.instructionsHash === hash);
          const { limit, offset } = pagination(searchParams);
          this.inspectionPage(response, enabled, listings, limit, offset);
          return;
        }
        case "/api/inspection/prompt-sections": {
          const recordId = this.requireRecordId(searchParams);
          await this.envelopes();
          const envelope = this.findEnvelope(recordId);
          if (envelope === null) {
            if (!enabled) {
              json(response, 200, {
                captureEnabled: false,
                instructionsHash: null,
                sections: [],
              });
              return;
            }
            json(response, 404, { error: "not_found" });
            return;
          }
          const { instructionsHash, sections } = collectPromptSections(envelope);
          json(response, 200, { captureEnabled: true, instructionsHash, sections });
          return;
        }
        case "/api/inspection/tools":
        case "/api/inspection/tool-calls": {
          await this.envelopes();
          const { limit, offset } = pagination(searchParams);
          const filterRecordId = searchParams.get("recordId");
          if (pathname === "/api/inspection/tools") {
            let schemas = collectToolSchemas(this.captureMemo?.value.envelopes ?? []);
            if (filterRecordId !== null)
              schemas = schemas.filter((entry) => entry.recordId === filterRecordId);
            this.inspectionPage(response, enabled, schemas, limit, offset);
            return;
          }
          let calls = collectToolCalls(this.captureMemo?.value.envelopes ?? []);
          if (filterRecordId !== null)
            calls = calls.filter((entry) => entry.recordId === filterRecordId);
          this.inspectionPage(response, enabled, calls, limit, offset);
          return;
        }
        case "/api/inspection/sessions": {
          await this.envelopes();
          const groups = collectSessions(this.captureMemo?.value.envelopes ?? []);
          const liveness = collectLiveness(
            groups,
            this.captureMemo?.value.envelopes ?? [],
            this.clock(),
          );
          const { limit, offset } = pagination(searchParams);
          this.inspectionPage(
            response,
            enabled,
            groups.map((group) => ({ ...group, liveness: liveness.get(group.sessionId) ?? null })),
            limit,
            offset,
          );
          return;
        }
        case "/api/inspection/context": {
          await this.envelopes();
          let summaries = collectContextSummaries(this.captureMemo?.value.envelopes ?? []);
          const search = searchParams.get("search");
          if (search !== null && search.length > 0) {
            const needle = search.toLowerCase();
            summaries = summaries.filter((entry) =>
              [entry.recordId, entry.model ?? "", entry.sessionId, entry.endpoint].some((field) =>
                field.toLowerCase().includes(needle),
              ),
            );
          }
          const sort = searchParams.get("sort");
          if (sort !== null) {
            if (sort !== "asc" && sort !== "desc") {
              throw new BadRequestError('sort must be "asc" or "desc"');
            }
            summaries =
              sort === "asc"
                ? [...summaries].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
                : [...summaries].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
          }
          const { limit, offset } = pagination(searchParams);
          this.inspectionPage(response, enabled, summaries, limit, offset);
          return;
        }
        case "/api/inspection/tool-schema": {
          const name = searchParams.get("name");
          if (name === null || name.length === 0) {
            throw new BadRequestError("name is required");
          }
          await this.envelopes();
          const schemas = collectToolSchemas(this.captureMemo?.value.envelopes ?? []).filter(
            (entry) => entry.name === name,
          );
          if (schemas.length === 0) {
            // Capture off is "nothing was ever recorded", not a miss.
            if (!enabled) {
              json(response, 200, {
                captureEnabled: false,
                name,
                type: "unknown",
                description: null,
                occurrences: 0,
                variants: [],
                firstSeenAt: null,
                lastSeenAt: null,
                recordIds: [],
              });
              return;
            }
            json(response, 404, { error: "not_found" });
            return;
          }
          const variants = [...new Set(schemas.map((entry) => entry.schemaJson))];
          json(response, 200, {
            captureEnabled: enabled,
            name,
            type: schemas[0]?.type ?? "unknown",
            description: schemas.find((entry) => entry.description !== null)?.description ?? null,
            occurrences: schemas.length,
            variants,
            firstSeenAt: schemas.reduce<string | null>(
              (first, entry) =>
                first === null || entry.capturedAt < first ? entry.capturedAt : first,
              null,
            ),
            lastSeenAt: schemas.reduce<string | null>(
              (last, entry) => (last === null || entry.capturedAt > last ? entry.capturedAt : last),
              null,
            ),
            recordIds: [...new Set(schemas.map((entry) => entry.recordId))],
          });
          return;
        }
        case "/api/inspection/sessions/detail":
        case "/api/inspection/sessions/breakdown": {
          const id = searchParams.get("id");
          if (id === null || id.length === 0) {
            throw new BadRequestError("id is required");
          }
          // Parsed before the lookup so a malformed page stays a 400 whether
          // or not the session exists.
          const { limit, offset } = pagination(searchParams);
          await this.envelopes();
          const envelopes = this.captureMemo?.value.envelopes ?? [];
          if (pathname.endsWith("/detail")) {
            const captures = collectSessionDetail(id, envelopes);
            if (captures.length === 0 && enabled) {
              json(response, 404, { error: "not_found" });
              return;
            }
            json(response, 200, {
              captureEnabled: enabled,
              sessionId: id,
              ...page(captures, limit, offset),
            });
            return;
          }
          const breakdown = collectSessionBreakdown(id, envelopes);
          if (breakdown.captures === 0 && enabled) {
            json(response, 404, { error: "not_found" });
            return;
          }
          json(response, 200, { captureEnabled: enabled, sessionId: id, ...breakdown });
          return;
        }
        case "/api/inspection/errors": {
          const rejected = this.database.listRejected();
          const { unreadable } = await this.envelopes();
          json(response, 200, {
            rejectedSidecars: rejected,
            unreadableCaptures: unreadable,
          });
          return;
        }
        default:
          json(response, 404, { error: "not_found" });
          return;
      }
    } catch (error) {
      if (invalidQuery(error)) {
        json(response, 400, { error: "invalid_query" });
        return;
      }
      throw error;
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET") {
      json(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (url.pathname === "/api/health") {
      json(response, 200, this.health());
      return;
    }
    if (url.pathname === "/api/summary") {
      json(response, 200, this.summary());
      return;
    }
    if (url.pathname === "/api/history") {
      this.handleHistory(url.searchParams, response);
      return;
    }
    if (url.pathname === "/api/trends") {
      this.handleTrends(url.searchParams, response);
      return;
    }
    if (url.pathname === "/api/limits") {
      this.handleLimits(response);
      return;
    }
    if (url.pathname === "/api/events") {
      this.events.subscribe(response, this.snapshot());
      return;
    }
    if (url.pathname.startsWith("/api/inspection/")) {
      await this.handleInspection(url.pathname, url.searchParams, response);
      return;
    }
    json(response, 404, { error: "not_found" });
  }

  // ADR 0011: from/to are optional report-timezone calendar dates; invalid
  // values and ranges reject as 400 invalid_query.
  private handleHistory(searchParams: URLSearchParams, response: ServerResponse): void {
    try {
      const range = resolveCalendarRange(
        calendarParameter(searchParams, "from"),
        calendarParameter(searchParams, "to"),
        this.clock(),
        this.config.reportTimezone,
      );
      const { limit, offset } = pagination(searchParams);
      const page = this.database.history(range, searchParams.getAll("model"), limit, offset);
      json(response, 200, {
        dataVersion: this.dataVersion,
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        nextOffset: page.nextOffset,
        records: page.records,
      });
    } catch (error) {
      if (invalidQuery(error)) {
        json(response, 400, { error: "invalid_query" });
        return;
      }
      throw error;
    }
  }

  private handleTrends(searchParams: URLSearchParams, response: ServerResponse): void {
    try {
      const from = calendarParameter(searchParams, "from");
      const to = calendarParameter(searchParams, "to");
      const now = this.clock();
      const range = resolveCalendarRange(from, to, now, this.config.reportTimezone);
      const events = this.database.sidecarsInRange(range, searchParams.getAll("model"));
      const buckets = aggregateDailyBuckets(events, from, to, now, this.config.reportTimezone);
      json(response, 200, {
        dataVersion: this.dataVersion,
        reportTimezone: range.reportTimezone,
        startInclusive: range.startInclusive?.toISOString() ?? null,
        endExclusive: range.endExclusive.toISOString(),
        buckets,
        total: aggregateRangeFromBuckets(buckets),
      });
    } catch (error) {
      if (invalidQuery(error)) {
        json(response, 400, { error: "invalid_query" });
        return;
      }
      throw error;
    }
  }

  // Rolling usage meters against operator-supplied ceilings (USAGE_LIMIT_*).
  // Windows without a configured ceiling are omitted entirely; nothing is shown
  // against an invented denominator.
  private handleLimits(response: ServerResponse): void {
    const kinds = Object.keys(this.config.usageLimitCeilings) as Array<
      keyof typeof this.config.usageLimitCeilings
    >;
    if (kinds.length === 0) {
      json(response, 200, { reportTimezone: this.config.reportTimezone, windows: [] });
      return;
    }
    const rows = this.database.allSidecars();
    const windows = computeUsageWindows(rows, this.config.usageLimitCeilings, this.clock());
    json(response, 200, { reportTimezone: this.config.reportTimezone, windows });
  }

  async start(): Promise<Readonly<{ host: string; port: number }>> {
    await this.ingestor.reconcile();
    await this.readProxyStatus();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.ready = true;
    this.startedAt = this.clock().toISOString();
    this.events.startKeepalives(this.config.keepaliveIntervalMs);
    await this.ingestor.start(this.config.reconcileIntervalMs);
    await this.maintainCaptures();
    if (this.config.captureEnabled) {
      this.captureMaintenance = setInterval(() => {
        void this.maintainCaptures().catch(() => {});
      }, this.config.reconcileIntervalMs);
      this.captureMaintenance.unref();
    }
    this.events.publish(this.snapshot());
    const address = this.server.address() as AddressInfo;
    return Object.freeze({ host: address.address, port: address.port });
  }

  async close(): Promise<void> {
    this.ready = false;
    this.events.publish(this.snapshot());
    if (this.captureMaintenance) clearInterval(this.captureMaintenance);
    this.captureMaintenance = null;
    await this.ingestor.close();
    this.events.close();
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) =>
        this.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    this.database.close();
  }
}
