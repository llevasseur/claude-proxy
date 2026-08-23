import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import { createElement } from "react";
import { type Mock, vi } from "vitest";
import { DashboardShell } from "../App";
import type { HistoryPayload, TrendsPayload } from "../api";

// Shared component-test scaffolding: a scriptable fetch stub, a fake
// EventSource that lets tests emit SSE frames, and a harness rendering the
// real DashboardShell so hash routing drives the pages exactly as in the app.

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  close(): void {}

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }
}

export function installTestGlobals(): void {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("EventSource", FakeEventSource);
}

export function stubFetch(
  respond: (url: string) => unknown,
): Mock<(url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>> {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => respond(url),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export interface RecordOverrides {
  readonly recordId?: string;
  readonly timestamp?: string;
  readonly model?: string;
  readonly cost?: HistoryPayload["records"][number]["cost"];
  readonly costUnavailableReason?: HistoryPayload["records"][number]["costUnavailableReason"];
}

export function historyRecord(overrides: RecordOverrides = {}): HistoryPayload["records"][number] {
  return {
    recordId: overrides.recordId ?? "record-1",
    timestamp: overrides.timestamp ?? "2026-08-19T12:00:00.000Z",
    model: overrides.model ?? "gpt-5",
    endpoint: "/v1/responses",
    responseStatus: 200,
    requestId: "req-1",
    usage: {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 0,
      totalTokens: 14,
    },
    cost: overrides.cost ?? { currency: "USD", amountUsd: "0.0002", catalogueVersion: "test" },
    costUnavailableReason: overrides.costUnavailableReason ?? null,
  };
}

export function historyPageResponse(
  records: HistoryPayload["records"],
  overrides: Partial<Omit<HistoryPayload, "records">> = {},
): HistoryPayload {
  return {
    dataVersion: 1,
    total: records.length,
    offset: 0,
    limit: 25,
    nextOffset: null,
    records,
    ...overrides,
  };
}

export function bucket(
  date: string,
  startInclusive: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    reportTimezone: "America/New_York",
    date,
    startInclusive,
    endExclusive: new Date(Date.parse(startInclusive) + 86_400_000).toISOString(),
    requestCount: 2,
    inputTokens: 20,
    cachedInputTokens: 0,
    outputTokens: 8,
    reasoningOutputTokens: 0,
    totalTokens: 28,
    latestEventTimestamp: startInclusive,
    cost: { currency: "USD", amountUsd: "0.0010", catalogueVersion: "test" },
    costUnavailableReason: null,
    ...overrides,
  };
}

export function trendsResponse(
  buckets: ReturnType<typeof bucket>[],
  overrides: Partial<TrendsPayload> = {},
): TrendsPayload {
  return {
    dataVersion: 1,
    reportTimezone: "America/New_York",
    startInclusive: buckets[0]?.startInclusive ?? null,
    endExclusive: "2026-03-10T04:00:00.000Z",
    buckets,
    total: {
      requestCount: buckets.reduce((sum, entry) => sum + entry.requestCount, 0),
      inputTokens: buckets.length * 20,
      cachedInputTokens: 0,
      outputTokens: buckets.length * 8,
      reasoningOutputTokens: 0,
      totalTokens: buckets.length * 28,
      latestEventTimestamp: null,
      cost: { currency: "USD", amountUsd: "0.0030", catalogueVersion: "test" },
      costUnavailableReason: null,
    },
    ...overrides,
  } as TrendsPayload;
}

// Renders the production shell under a fresh QueryClient; the caller sets
// window.location.hash beforehand to choose the route.
export function renderShell(): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, createElement(DashboardShell)));
}

export function healthPayload(): unknown {
  return {
    ready: true,
    server: { status: "ready", startedAt: "2026-08-22T00:00:00.000Z" },
    proxy: { status: "healthy", state: "ready", updatedAt: "2026-08-22T00:00:00.000Z" },
    database: {
      status: "ready",
      path: ":memory:",
      schemaVersion: 1,
      journalMode: "wal",
      recordCount: 0,
    },
    ingest: { lastSuccessfulAt: null, rejectedSidecars: 0 },
    capture: { enabled: true },
    sse: { subscribers: 1 },
  };
}

export function summaryPayload(): unknown {
  return {
    reportTimezone: "America/New_York",
    startInclusive: "2026-08-22T04:00:00.000Z",
    endExclusive: "2026-08-23T04:00:00.000Z",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requestCount: 0,
    latestEventTimestamp: null,
    cost: null,
    costUnavailableReason: null,
  };
}
