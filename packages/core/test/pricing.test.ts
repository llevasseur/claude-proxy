import { describe, expect, it } from "vitest";
import { estimateCost, priceFor, MODEL_PRICES, FALLBACK_PRICE } from "../src/pricing.js";

describe("priceFor", () => {
  it("matches families by substring", () => {
    expect(priceFor("claude-opus-4-8")).toBe(MODEL_PRICES.opus);
    expect(priceFor("claude-3-5-sonnet-20241022")).toBe(MODEL_PRICES.sonnet);
    expect(priceFor("claude-haiku-4-5")).toBe(MODEL_PRICES.haiku);
  });

  it("falls back for unknown models", () => {
    expect(priceFor("gpt-5")).toBe(FALLBACK_PRICE);
    expect(priceFor("")).toBe(FALLBACK_PRICE);
  });
});

describe("estimateCost", () => {
  it("prices each token bucket at its rate", () => {
    // 1M of each bucket under opus → exactly the opus rates.
    const cost = estimateCost(
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreation: 1_000_000, realInput: 3_000_000 },
      "claude-opus-4-8",
    );
    expect(cost.input).toBeCloseTo(15);
    expect(cost.output).toBeCloseTo(75);
    expect(cost.cacheRead).toBeCloseTo(1.5);
    expect(cost.cacheWrite).toBeCloseTo(18.75);
    expect(cost.total).toBeCloseTo(15 + 75 + 1.5 + 18.75);
  });

  it("is zero for zero tokens", () => {
    const cost = estimateCost({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, realInput: 0 }, "claude-opus-4-8");
    expect(cost.total).toBe(0);
  });
});
