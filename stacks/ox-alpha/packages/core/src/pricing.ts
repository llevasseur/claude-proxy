import type { CostResult, ModelPricing, PriceCategory, UsageTotals } from "./types.ts";

// Pricing mechanics and OpenAI catalogue rates ported verbatim from codex-proxy
// `packages/core/src/pricing.ts` — rates are never invented here. The one
// borrowed entry is declared as such in ADR 0013 rather than passed off as the
// model's own price.
export const PRICING_CATALOGUE_VERSION = "2025-08-07";
export const PRICING_SOURCE = "https://openai.com/api/pricing/";

// Ox Alpha (`x-preview-f-free`) is served by opencode zen, which publishes no
// rate card, so ADR 0013 prices it with Anthropic's Claude Fable 5 rates as a
// declared stand-in. Its provenance is recorded per entry rather than under
// the OpenAI constants above, which would misattribute it.
const FABLE_STANDIN_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const FABLE_STANDIN_VERSION = "2026-08-22";

export interface RateProvenance {
  readonly effectiveDate: string;
  readonly source: string;
}

// Provenance is per entry, so reading it needs the entry rather than the
// catalogue-wide constants. Callers that display or audit a rate use this.
export function pricingProvenance(
  model: string,
  catalogue: Readonly<Record<string, ModelPricing>> = PRICING_CATALOGUE,
): RateProvenance | null {
  const entry = catalogue[model];
  if (!entry) return null;
  return Object.freeze({ effectiveDate: entry.effectiveDate, source: entry.source });
}

export const PRICING_CATALOGUE: Readonly<Record<string, ModelPricing>> = Object.freeze({
  "gpt-5": pricing("gpt-5", "1.25", "0.125", "10.00"),
  "gpt-5-2025-08-07": pricing("gpt-5-2025-08-07", "1.25", "0.125", "10.00"),
  "gpt-5-mini": pricing("gpt-5-mini", "0.25", "0.025", "2.00"),
  "gpt-5-nano": pricing("gpt-5-nano", "0.05", "0.005", "0.40"),
  "x-preview-f-free": pricing("x-preview-f-free", "10.00", "1.00", "50.00", {
    effectiveDate: FABLE_STANDIN_VERSION,
    source: FABLE_STANDIN_SOURCE,
  }),
});

function pricing(
  model: string,
  input: string,
  cachedInput: string,
  output: string,
  provenance: RateProvenance = { effectiveDate: PRICING_CATALOGUE_VERSION, source: PRICING_SOURCE },
): ModelPricing {
  return Object.freeze({
    model,
    currency: "USD",
    unit: "one-million-tokens",
    effectiveDate: provenance.effectiveDate,
    source: provenance.source,
    usdPerMillionTokens: Object.freeze({ input, cachedInput, output, reasoningOutput: output }),
  });
}

function decimalRateToPicoUsdPerToken(rate: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(rate)) throw new Error(`invalid USD-per-million rate: ${rate}`);
  const [whole = "0", fraction = ""] = rate.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function picoUsdToDecimal(value: bigint): string {
  const whole = value / 1_000_000_000_000n;
  const fraction = (value % 1_000_000_000_000n).toString().padStart(12, "0").replace(/0+$/, "");
  return fraction.length === 0 ? `${whole}.000000` : `${whole}.${fraction.padEnd(6, "0")}`;
}

export function estimateUsageCost(
  model: string,
  usage: UsageTotals,
  catalogue: Readonly<Record<string, ModelPricing>> = PRICING_CATALOGUE,
): CostResult {
  const modelPricing = catalogue[model];
  if (!modelPricing) {
    return Object.freeze({
      cost: null,
      unavailableReason: Object.freeze({ code: "unknown-model", model }),
    });
  }

  // Per ADR 0003: any consumed category without a rate makes the entire cost
  // unavailable; tokens are still reported in full.
  const categories: ReadonlyArray<readonly [PriceCategory, number]> = [
    ["input", usage.inputTokens - usage.cachedInputTokens],
    ["cachedInput", usage.cachedInputTokens],
    ["output", usage.outputTokens - usage.reasoningOutputTokens],
    ["reasoningOutput", usage.reasoningOutputTokens],
  ];
  let picoUsd = 0n;

  for (const [category, tokens] of categories) {
    if (tokens === 0) continue;
    const rate = modelPricing.usdPerMillionTokens[category];
    if (rate === undefined) {
      return Object.freeze({
        cost: null,
        unavailableReason: Object.freeze({ code: "missing-category-price", model, category }),
      });
    }
    picoUsd += BigInt(tokens) * decimalRateToPicoUsdPerToken(rate);
  }

  return Object.freeze({
    cost: Object.freeze({
      currency: "USD",
      amountUsd: picoUsdToDecimal(picoUsd),
      catalogueVersion: modelPricing.effectiveDate,
    }),
    unavailableReason: null,
  });
}

export function addUsdAmounts(amounts: readonly string[]): string {
  let total = 0n;
  for (const amount of amounts) {
    if (!/^\d+(?:\.\d{1,12})?$/.test(amount)) throw new Error(`invalid USD amount: ${amount}`);
    const [whole = "0", fraction = ""] = amount.split(".");
    total += BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, "0"));
  }
  return picoUsdToDecimal(total);
}
