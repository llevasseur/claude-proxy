import { describe, expect, it } from "vitest";
import {
  aggregateDailyBuckets,
  aggregateRangeFromBuckets,
  modelFilter,
  paginateHistoryRecords,
  projectHistoryRecords,
  resolveCalendarRange,
  selectByModels,
} from "../src/history.ts";
import type { SanitizedAuditSidecarV1 } from "../src/types.ts";

function sidecar(overrides: Partial<SanitizedAuditSidecarV1> = {}): SanitizedAuditSidecarV1 {
  const base: SanitizedAuditSidecarV1 = {
    schemaVersion: 1,
    recordId: `record-${Math.random()}`,
    timestamp: "2026-03-09T10:00:00.000Z",
    model: "gpt-5",
    endpoint: "/v1/responses",
    responseStatus: 200,
    requestId: null,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      reasoningOutputTokens: 0,
      totalTokens: 150,
    },
    cost: { currency: "USD", amountUsd: "1.500000", catalogueVersion: "2025-08-07" },
    costUnavailableReason: null,
  };
  return Object.freeze({ ...base, ...overrides });
}

describe("resolveCalendarRange", () => {
  it("resolves explicit from/to into half-open UTC instants", () => {
    const range = resolveCalendarRange(
      "2026-03-08",
      "2026-03-10",
      new Date("2026-03-10T15:00:00Z"),
      "America/New_York",
    );
    expect(range.startInclusive?.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-03-11T04:00:00.000Z");
    expect(range.reportTimezone).toBe("America/New_York");
  });

  it("treats to as an inclusive calendar date", () => {
    const range = resolveCalendarRange(null, "2026-03-09", new Date(), "America/New_York");
    expect(range.endExclusive.toISOString()).toBe("2026-03-10T04:00:00.000Z");
  });

  it("handles the spring-forward day as a 23-hour window", () => {
    const range = resolveCalendarRange("2026-03-08", "2026-03-08", new Date(), "America/New_York");
    expect(range.startInclusive?.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(range.endExclusive.getTime() - (range.startInclusive?.getTime() ?? 0)).toBe(
      23 * 60 * 60 * 1000,
    );
  });

  it("handles the fall-back day as a 25-hour window", () => {
    const range = resolveCalendarRange("2026-11-01", "2026-11-01", new Date(), "America/New_York");
    expect(range.startInclusive?.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(range.endExclusive.getTime() - (range.startInclusive?.getTime() ?? 0)).toBe(
      25 * 60 * 60 * 1000,
    );
  });

  it("treats a missing from as an open-ended start", () => {
    const range = resolveCalendarRange(null, "2026-03-10", new Date(), "UTC");
    expect(range.startInclusive).toBeNull();
    expect(range.endExclusive.toISOString()).toBe("2026-03-11T00:00:00.000Z");
  });

  it("derives the end from the clock's today window when to is absent", () => {
    const now = new Date("2026-03-09T15:00:00.000Z");
    const range = resolveCalendarRange("2026-03-01", null, now, "America/New_York");
    expect(range.endExclusive.toISOString()).toBe("2026-03-10T04:00:00.000Z");
  });

  it("rejects an inverted range and invalid inputs", () => {
    expect(() => resolveCalendarRange("2026-03-10", "2026-03-09", new Date())).toThrow(
      /must precede/,
    );
    expect(() => resolveCalendarRange("2026-02-30", null, new Date())).toThrow(
      /invalid calendar date/,
    );
    expect(() => resolveCalendarRange(null, "nope", new Date())).toThrow(/invalid calendar date/);
    expect(() => resolveCalendarRange(null, null, new Date("not-a-date"))).toThrow(/valid Date/);
  });
});

describe("aggregateDailyBuckets", () => {
  const now = new Date("2026-03-10T15:00:00.000Z");

  it("includes events at the half-open boundaries exactly once", () => {
    const events = [
      sidecar({ recordId: "at-start", timestamp: "2026-03-09T04:00:00.000Z" }),
      sidecar({ recordId: "at-end", timestamp: "2026-03-10T04:00:00.000Z" }),
    ];
    const buckets = aggregateDailyBuckets(
      events,
      "2026-03-09",
      "2026-03-10",
      now,
      "America/New_York",
    );
    expect(buckets).toHaveLength(2);
    expect(buckets[0]?.date).toBe("2026-03-09");
    expect(buckets[0]?.requestCount).toBe(1);
    expect(buckets[1]?.date).toBe("2026-03-10");
    expect(buckets[1]?.requestCount).toBe(1);
  });

  it("produces exact DST spring-forward bucket windows", () => {
    const events = [
      sidecar({ recordId: "spring", timestamp: "2026-03-08T06:00:00.000Z" }),
      sidecar({ recordId: "after", timestamp: "2026-03-09T06:00:00.000Z" }),
    ];
    const buckets = aggregateDailyBuckets(
      events,
      "2026-03-08",
      "2026-03-09",
      now,
      "America/New_York",
    );
    expect(buckets[0]?.startInclusive).toBe("2026-03-08T05:00:00.000Z");
    expect(buckets[0]?.endExclusive).toBe("2026-03-09T04:00:00.000Z");
    expect(buckets[0]?.requestCount).toBe(1);
    expect(buckets[1]?.startInclusive).toBe("2026-03-09T04:00:00.000Z");
    expect(buckets[1]?.requestCount).toBe(1);
  });

  it("produces exact DST fall-back bucket windows", () => {
    const events = [sidecar({ timestamp: "2026-11-01T05:30:00.000Z" })];
    const buckets = aggregateDailyBuckets(
      events,
      "2026-11-01",
      "2026-11-02",
      now,
      "America/New_York",
    );
    expect(buckets[0]?.startInclusive).toBe("2026-11-01T04:00:00.000Z");
    expect(buckets[0]?.endExclusive).toBe("2026-11-02T05:00:00.000Z");
    expect(buckets[0]?.requestCount).toBe(1);
  });

  it("returns one zero-priced bucket for an empty single-day window", () => {
    const buckets = aggregateDailyBuckets([], "2026-03-09", "2026-03-09", now, "America/New_York");
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.date).toBe("2026-03-09");
    expect(buckets[0]?.requestCount).toBe(0);
    expect(buckets[0]?.cost?.amountUsd).toBe("0.000000");
    expect(buckets[0]?.costUnavailableReason).toBeNull();
    expect(buckets[0]?.latestEventTimestamp).toBeNull();
  });

  it("propagates cost unavailability independently per bucket", () => {
    const pricedDayOne = sidecar({
      recordId: "day-one",
      timestamp: "2026-03-09T12:00:00.000Z",
      cost: { currency: "USD", amountUsd: "1.000000", catalogueVersion: "2025-08-07" },
    });
    const unpricedDayTwo = sidecar({
      recordId: "day-two",
      timestamp: "2026-03-10T12:00:00.000Z",
      cost: null,
      costUnavailableReason: { code: "unknown-model", model: "gpt-9-future" },
    });
    const buckets = aggregateDailyBuckets(
      [pricedDayOne, unpricedDayTwo],
      "2026-03-09",
      "2026-03-11",
      now,
      "America/New_York",
    );
    expect(buckets[0]?.cost?.amountUsd).toBe("1.000000");
    expect(buckets[0]?.costUnavailableReason).toBeNull();
    expect(buckets[1]?.cost).toBeNull();
    expect(buckets[1]?.costUnavailableReason).toEqual({
      code: "aggregate-incomplete",
      detail: "unknown-model",
    });
    // Tokens are retained on the unpriced bucket per ADR 0003.
    expect(buckets[1]?.totalTokens).toBe(150);
  });

  it("groups by report-date in the explicit timezone, not UTC", () => {
    // 23:30Z is still the same New York date but already the next Tokyo date.
    const event = sidecar({ timestamp: "2026-03-09T23:30:00.000Z" });
    const ny = aggregateDailyBuckets([event], "2026-03-09", "2026-03-11", now, "America/New_York");
    const tokyo = aggregateDailyBuckets([event], "2026-03-09", "2026-03-11", now, "Asia/Tokyo");
    expect(ny.find((bucket) => bucket.date === "2026-03-09")?.requestCount).toBe(1);
    expect(tokyo.find((bucket) => bucket.date === "2026-03-09")?.requestCount).toBe(0);
    expect(tokyo.find((bucket) => bucket.date === "2026-03-10")?.requestCount).toBe(1);
  });

  it("supports an open-ended range anchored on the earliest event", () => {
    const events = [
      sidecar({ recordId: "old", timestamp: "2026-03-07T10:00:00.000Z" }),
      sidecar({ recordId: "newer", timestamp: "2026-03-09T10:00:00.000Z" }),
    ];
    const buckets = aggregateDailyBuckets(events, null, "2026-03-10", now, "America/New_York");
    expect(buckets.map((bucket) => bucket.date)).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
    expect(buckets[0]?.requestCount).toBe(1);
    expect(buckets[1]?.requestCount).toBe(0);
    expect(buckets[2]?.requestCount).toBe(1);
    expect(buckets[3]?.requestCount).toBe(0);
  });

  it("rejects a sidecar timestamp that is not a valid instant", () => {
    expect(() =>
      aggregateDailyBuckets(
        [sidecar({ timestamp: "not-a-time" })],
        "2026-03-09",
        "2026-03-10",
        now,
      ),
    ).toThrow(/valid instant/);
  });
});

describe("aggregateRangeFromBuckets", () => {
  const now = new Date("2026-03-11T15:00:00.000Z");

  it("makes bucket sums equal range totals through one shared path", () => {
    const events = [
      sidecar({
        recordId: "a",
        timestamp: "2026-03-09T12:00:00.000Z",
        cost: { currency: "USD", amountUsd: "1.250000", catalogueVersion: "2025-08-07" },
      }),
      sidecar({
        recordId: "b",
        timestamp: "2026-03-10T18:00:00.000Z",
        usage: {
          inputTokens: 40,
          cachedInputTokens: 10,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 60,
        },
        cost: { currency: "USD", amountUsd: "0.750000", catalogueVersion: "2025-08-07" },
      }),
    ];
    const buckets = aggregateDailyBuckets(
      events,
      "2026-03-09",
      "2026-03-11",
      now,
      "America/New_York",
    );
    const direct = aggregateDailyBuckets(events, null, "2026-03-11", now, "America/New_York");
    const summary = aggregateRangeFromBuckets(buckets);
    const directSummary = aggregateRangeFromBuckets(direct);
    expect(summary.requestCount).toBe(2);
    expect(summary.inputTokens).toBe(buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0));
    expect(summary.cachedInputTokens).toBe(
      buckets.reduce((sum, bucket) => sum + bucket.cachedInputTokens, 0),
    );
    expect(summary.outputTokens).toBe(
      buckets.reduce((sum, bucket) => sum + bucket.outputTokens, 0),
    );
    expect(summary.reasoningOutputTokens).toBe(
      buckets.reduce((sum, bucket) => sum + bucket.reasoningOutputTokens, 0),
    );
    expect(summary.totalTokens).toBe(buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0));
    expect(summary.cost?.amountUsd).toBe("2.000000");
    expect(directSummary.cost?.amountUsd).toBe(summary.cost?.amountUsd);
    expect(directSummary.requestCount).toBe(summary.requestCount);
    expect(summary.latestEventTimestamp).toBe("2026-03-10T18:00:00.000Z");
  });

  it("propagates unavailability from any single bucket to the whole range while retaining tokens", () => {
    const buckets = aggregateDailyBuckets(
      [
        sidecar({
          recordId: "priced",
          timestamp: "2026-03-09T12:00:00.000Z",
          cost: { currency: "USD", amountUsd: "1.000000", catalogueVersion: "2025-08-07" },
        }),
        sidecar({
          recordId: "unpriced",
          timestamp: "2026-03-10T12:00:00.000Z",
          cost: null,
          costUnavailableReason: {
            code: "missing-category-price",
            model: "gpt-5",
            category: "input",
          },
        }),
      ],
      "2026-03-09",
      "2026-03-11",
      now,
      "America/New_York",
    );
    const summary = aggregateRangeFromBuckets(buckets);
    expect(summary.requestCount).toBe(2);
    expect(summary.totalTokens).toBe(300);
    expect(summary.cost).toBeNull();
    expect(summary.costUnavailableReason).toEqual({
      code: "aggregate-incomplete",
      // Faithful to the shared-path port: the bucket's own aggregate reason
      // becomes the detail of the range-level aggregate reason.
      detail: "aggregate-incomplete",
    });
  });

  it("keeps an empty range fully priced at zero", () => {
    const buckets = aggregateDailyBuckets([], "2026-03-09", "2026-03-10", now);
    const summary = aggregateRangeFromBuckets(buckets);
    expect(summary.requestCount).toBe(0);
    expect(summary.cost?.amountUsd).toBe("0.000000");
    expect(summary.costUnavailableReason).toBeNull();
  });
});

describe("model filters", () => {
  const records = [
    { model: "gpt-5", id: 1 },
    { model: "gpt-5-mini", id: 2 },
    { model: "gpt-5-nano", id: 3 },
  ];

  it("matches all records when the selection is empty", () => {
    expect(selectByModels(records, [])).toEqual(records);
    expect(modelFilter([])("anything")).toBe(true);
  });

  it("matches exact identifiers only, with no aliasing or normalization", () => {
    expect(selectByModels(records, ["gpt-5"]).map((record) => record.id)).toEqual([1]);
    expect(selectByModels(records, ["GPT-5"])).toEqual([]);
    expect(selectByModels(records, ["gpt-5 "])).toEqual([]);
  });

  it("supports multi-select via multiple exact values", () => {
    expect(selectByModels(records, ["gpt-5", "gpt-5-nano"]).map((record) => record.id)).toEqual([
      1, 3,
    ]);
  });

  it("degrades an unmatched value to an ordinary empty result set", () => {
    expect(selectByModels(records, ["o4-future"])).toEqual([]);
    expect(selectByModels(records, ["gpt-5", "o4-future"]).map((record) => record.id)).toEqual([1]);
  });
});

describe("history record projection", () => {
  it("projects sanitized per-record values for a listing without request data", () => {
    const event = sidecar({ requestId: "req_123" });
    const projected = projectHistoryRecords([event]);
    expect(projected).toHaveLength(1);
    const record = projected[0];
    expect(record?.recordId).toBe(event.recordId);
    expect(record?.timestamp).toBe(event.timestamp);
    expect(record?.model).toBe(event.model);
    expect(record?.endpoint).toBe(event.endpoint);
    expect(record?.responseStatus).toBe(200);
    expect(record?.usage).toEqual(event.usage);
    expect(record?.cost).toEqual(event.cost);
    expect(Object.keys(record ?? {})).not.toContain("requestId");
    expect(projected).toEqual(
      projectHistoryRecords([sidecar({ requestId: "req_123", recordId: event.recordId })]),
    );
  });

  it("paginates deterministically with total and next-offset metadata", () => {
    const records = projectHistoryRecords([
      sidecar({ recordId: "r1", timestamp: "2026-03-09T10:00:00.000Z" }),
      sidecar({ recordId: "r2", timestamp: "2026-03-09T11:00:00.000Z" }),
      sidecar({ recordId: "r3", timestamp: "2026-03-09T12:00:00.000Z" }),
    ]);
    const page = paginateHistoryRecords(records, 2, 0);
    expect(page.records.map((record) => record.recordId)).toEqual(["r1", "r2"]);
    expect(page.total).toBe(3);
    expect(page.offset).toBe(0);
    expect(page.nextOffset).toBe(2);

    const last = paginateHistoryRecords(records, 2, 2);
    expect(last.records.map((record) => record.recordId)).toEqual(["r3"]);
    expect(last.nextOffset).toBeNull();

    const all = paginateHistoryRecords(records, null, 1);
    expect(all.records.map((record) => record.recordId)).toEqual(["r2", "r3"]);
    expect(all.nextOffset).toBeNull();

    expect(() => paginateHistoryRecords(records, -1)).toThrow(/limit/);
    expect(() => paginateHistoryRecords(records, 2, -1)).toThrow(/offset/);
    expect(() => paginateHistoryRecords(records, 1.5)).toThrow(/limit/);
  });
});
