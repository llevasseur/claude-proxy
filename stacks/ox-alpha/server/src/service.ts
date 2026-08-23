import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  aggregateDailyBuckets,
  aggregateRangeFromBuckets,
  resolveCalendarRange,
} from "@ox-alpha-proxy/core";
import { CaptureStore } from "./capture.ts";
import type { ServerConfig } from "./config.ts";
import { UsageDatabase } from "./database.ts";
import { EventHub } from "./events.ts";
import { SidecarIngestor } from "./ingest.ts";

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

type ProxyState = "startup" | "starting" | "ready" | "upstream-error" | "shutdown";

interface ProxyStatusFile {
  readonly state: ProxyState;
  readonly updatedAt: string;
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

function validProxyStatus(value: unknown): value is ProxyStatusFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return (
    ["startup", "starting", "ready", "upstream-error", "shutdown"].includes(String(status.state)) &&
    typeof status.updatedAt === "string" &&
    !Number.isNaN(Date.parse(status.updatedAt))
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
  private ready = false;
  private startedAt: string | null = null;
  private proxy: Readonly<{
    status: "healthy" | "degraded" | "unavailable";
    state: ProxyState | null;
    updatedAt: string | null;
  }> = Object.freeze({ status: "unavailable", state: null, updatedAt: null });
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
      });
    } catch {
      this.proxy = Object.freeze({ status: "unavailable", state: null, updatedAt: null });
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
    await this.captures.maintain();
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
    if (url.pathname === "/api/events") {
      this.events.subscribe(response, this.snapshot());
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
