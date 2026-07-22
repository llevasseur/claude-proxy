import { describe, expect, it } from "vitest";
import { normalizeDigest } from "../src/digest.js";

describe("normalizeDigest", () => {
  it("passes through a full persisted digest, keeping the fields the trends chart reads", () => {
    const raw = {
      date: "2026-07-20",
      requestCount: 1133,
      skipped: 0,
      models: { "claude-opus-4-8": 867 },
      tokens: {
        input: 155093,
        output: 772404,
        cacheRead: 136852827,
        cacheCreation: 4768446,
        realInput: 141776366,
        cacheHitRatio: 0.9653,
      },
      cost: { input: 2.0275, output: 56.5525, cacheWrite: 79.6181, cacheRead: 186.0761, total: 324.2741 },
      topTools: [{ name: "X", totalBytes: 10, estTokens: 3, pctOfToolBytes: 1 }],
    };
    const d = normalizeDigest(raw, "2026-07-20")!;
    expect(d.date).toBe("2026-07-20");
    expect(d.requestCount).toBe(1133);
    expect(d.tokens.realInput).toBe(141776366);
    expect(d.tokens.output).toBe(772404);
    expect(d.tokens.cacheRead).toBe(136852827);
    expect(d.tokens.cacheCreation).toBe(4768446);
    expect(d.tokens.cacheHitRatio).toBeCloseTo(0.9653);
    expect(d.cost.total).toBeCloseTo(324.2741);
    expect(d.models).toEqual({ "claude-opus-4-8": 867 });
    expect(d.topTools[0]!.name).toBe("X");
  });

  it("derives cacheHitRatio when the persisted digest omits it", () => {
    const d = normalizeDigest(
      { requestCount: 1, tokens: { realInput: 100, cacheRead: 80, output: 5 } },
      "2026-07-19",
    )!;
    expect(d.tokens.cacheHitRatio).toBeCloseTo(0.8);
  });

  it("normalizes the legacy flat shape into a valid digest with zeroed unknowns", () => {
    const raw = { requestCount: 42, realInput: 5000, output: 300, costTotal: 12.5 };
    const d = normalizeDigest(raw, "2026-07-13")!;
    expect(d.date).toBe("2026-07-13");
    expect(d.requestCount).toBe(42);
    expect(d.tokens.realInput).toBe(5000);
    expect(d.tokens.output).toBe(300);
    expect(d.cost.total).toBe(12.5);
    expect(d.tokens.cacheRead).toBe(0);
    expect(d.tokens.cacheCreation).toBe(0);
    expect(d.tokens.cacheHitRatio).toBe(0);
    expect(d.models).toEqual({});
    expect(d.topTools).toEqual([]);
    expect(d.busiestHour).toBeNull();
  });

  it("uses the fallback date when the object has none", () => {
    const d = normalizeDigest({ requestCount: 0 }, "2026-07-01")!;
    expect(d.date).toBe("2026-07-01");
  });

  it("returns null for non-object input", () => {
    expect(normalizeDigest(null, "2026-07-01")).toBeNull();
    expect(normalizeDigest("nope", "2026-07-01")).toBeNull();
  });
});
