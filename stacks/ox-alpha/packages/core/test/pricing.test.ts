import { describe, expect, it } from "vitest";
import { estimateUsageCost, PRICING_CATALOGUE, PRICING_CATALOGUE_VERSION } from "../src/pricing.ts";
import type { UsageTotals } from "../src/types.ts";

const usage: UsageTotals = Object.freeze({
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  outputTokens: 500_000,
  reasoningOutputTokens: 200_000,
  totalTokens: 1_500_000,
});

describe("estimateUsageCost", () => {
  it("prices a fully consumed request in exact pico-dollar decimal USD", () => {
    // gpt-5: input 1.25, output 10.00 USD per million tokens.
    // (1M uncached input x 1.25) + (300k output x 10) + (200k reasoning x 10)
    const result = estimateUsageCost("gpt-5", usage);
    expect(result).toEqual({
      cost: { currency: "USD", amountUsd: "6.250000", catalogueVersion: PRICING_CATALOGUE_VERSION },
      unavailableReason: null,
    });
  });

  it("prices cached input at the cached rate", () => {
    const result = estimateUsageCost("gpt-5", {
      ...usage,
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
    });
    // (600k uncached x 1.25) + (400k cached x 0.125) + 3.00 + 2.00
    expect(result.cost?.amountUsd).toBe("5.800000");
  });

  it("carries a catalogue version and ported rates for every catalogue model", () => {
    expect(PRICING_CATALOGUE_VERSION).toBe("2025-08-07");
    expect(Object.keys(PRICING_CATALOGUE)).toEqual([
      "gpt-5",
      "gpt-5-2025-08-07",
      "gpt-5-mini",
      "gpt-5-nano",
    ]);
    expect(PRICING_CATALOGUE["gpt-5-mini"]?.usdPerMillionTokens).toEqual({
      input: "0.25",
      cachedInput: "0.025",
      output: "2.00",
      reasoningOutput: "2.00",
    });
  });

  it("returns a typed unknown-model reason without inventing a price", () => {
    const result = estimateUsageCost("gpt-9-future", usage);
    expect(result.cost).toBeNull();
    expect(result.unavailableReason).toEqual({ code: "unknown-model", model: "gpt-9-future" });
  });

  it("returns a typed missing-category-price reason per ADR 0003", () => {
    const partialCatalogue = {
      "partial-model": {
        model: "partial-model",
        currency: "USD" as const,
        unit: "one-million-tokens" as const,
        effectiveDate: PRICING_CATALOGUE_VERSION,
        source: "test",
        usdPerMillionTokens: { input: "1.00" },
      },
    };
    const result = estimateUsageCost(
      "partial-model",
      { ...usage, outputTokens: 100_000, reasoningOutputTokens: 50_000, totalTokens: 1_100_000 },
      partialCatalogue,
    );
    expect(result.cost).toBeNull();
    expect(result.unavailableReason).toEqual({
      code: "missing-category-price",
      model: "partial-model",
      category: "output",
    });
  });

  it("skips zero-token categories even when their rate is missing", () => {
    const noCachedRate = {
      m: {
        model: "m",
        currency: "USD" as const,
        unit: "one-million-tokens" as const,
        effectiveDate: PRICING_CATALOGUE_VERSION,
        source: "test",
        usdPerMillionTokens: { input: "1.00", output: "2.00" },
      },
    };
    const result = estimateUsageCost(
      "m",
      { ...usage, cachedInputTokens: 0, reasoningOutputTokens: 0 },
      noCachedRate,
    );
    expect(result.cost?.amountUsd).toBe("2.000000");
  });

  it("returns zero cost as an exact decimal when nothing is consumed", () => {
    const result = estimateUsageCost("gpt-5", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    });
    expect(result.cost?.amountUsd).toBe("0.000000");
  });
});
