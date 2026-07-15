import { describe, expect, it } from "vitest";
import { computeDigest, digestsByDay, type UsageDigest } from "../src/digest.js";
import { makeSidecar } from "./helpers.js";

describe("computeDigest", () => {
  it("returns a well-formed empty digest for no input", () => {
    const d = computeDigest([], { date: "2026-07-15" });
    expect(d.requestCount).toBe(0);
    expect(d.skipped).toBe(0);
    expect(d.tokens.realInput).toBe(0);
    expect(d.tokens.cacheHitRatio).toBe(0);
    expect(d.cost.total).toBe(0);
    expect(d.topTools).toEqual([]);
    expect(d.busiestHour).toBeNull();
    expect(d.avgSystemPromptBytes).toBe(0);
  });

  it("aggregates a single request", () => {
    const d = computeDigest([makeSidecar()], { date: "2026-07-15" });
    expect(d.requestCount).toBe(1);
    expect(d.tokens.realInput).toBe(9_100);
    expect(d.tokens.cacheHitRatio).toBeCloseTo(8_000 / 9_100);
    expect(d.cost.total).toBeGreaterThan(0);
    expect(d.models).toEqual({ "claude-opus-4-8": 1 });
    expect(d.topTools[0]!.name).toBe("Workflow");
    expect(d.busiestHour).toEqual({ hour: 13, requestCount: 1 });
  });

  it("counts multiple models and sums cost", () => {
    const d = computeDigest(
      [makeSidecar({ model: "claude-opus-4-8" }), makeSidecar({ model: "claude-haiku-4-5" })],
      { date: "2026-07-15" },
    );
    expect(d.requestCount).toBe(2);
    expect(d.models).toEqual({ "claude-opus-4-8": 1, "claude-haiku-4-5": 1 });
    const single = computeDigest([makeSidecar({ model: "claude-opus-4-8" })], { date: "x" });
    expect(d.cost.total).toBeGreaterThan(single.cost.total);
  });

  it("skips malformed sidecars but keeps valid ones", () => {
    const d = computeDigest([makeSidecar(), { nope: true }, null, "garbage"], { date: "2026-07-15" });
    expect(d.requestCount).toBe(1);
    expect(d.skipped).toBe(3);
  });

  it("ranks tools by total bytes and computes share", () => {
    const s = makeSidecar({
      tools: [
        { name: "Big", bytes: 30_000, estTokens: 7_500 },
        { name: "Small", bytes: 10_000, estTokens: 2_500 },
      ],
    });
    const d = computeDigest([s], { date: "2026-07-15" });
    expect(d.topTools.map((t) => t.name)).toEqual(["Big", "Small"]);
    expect(d.topTools[0]!.pctOfToolBytes).toBeCloseTo(75);
  });

  it("computes a day-over-day trend against a prior digest", () => {
    const prior: UsageDigest = computeDigest([makeSidecar()], { date: "2026-07-14" });
    const today = computeDigest([makeSidecar(), makeSidecar()], { date: "2026-07-15", priorDigest: prior });
    expect(today.trend).toBeDefined();
    const reqTrend = today.trend!.find((t) => t.field === "requestCount")!;
    expect(reqTrend.today).toBe(2);
    expect(reqTrend.prior).toBe(1);
    expect(reqTrend.deltaPct).toBeCloseTo(100);
  });

  it("finds the busiest hour", () => {
    const at = (h: string) => makeSidecar({ timestamp: `2026-07-15T${h}:00:00.000Z` });
    const d = computeDigest([at("09"), at("14"), at("14")], { date: "2026-07-15" });
    expect(d.busiestHour).toEqual({ hour: 14, requestCount: 2 });
  });
});

describe("digestsByDay", () => {
  it("splits by UTC day and chains trend across days", () => {
    const day1 = makeSidecar({ timestamp: "2026-07-14T10:00:00.000Z" });
    const day2a = makeSidecar({ timestamp: "2026-07-15T10:00:00.000Z" });
    const day2b = makeSidecar({ timestamp: "2026-07-15T11:00:00.000Z" });
    const digests = digestsByDay([day2b, day1, day2a]);
    expect(digests.map((d) => d.date)).toEqual(["2026-07-14", "2026-07-15"]);
    expect(digests[0]!.trend).toBeUndefined();
    expect(digests[1]!.trend).toBeDefined();
    expect(digests[1]!.requestCount).toBe(2);
  });
});
