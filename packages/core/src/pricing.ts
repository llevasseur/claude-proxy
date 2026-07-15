import type { AuditTokens } from "./types.js";

/** Price per **million tokens** (USD). Explicitly approximate and editable. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Editable price map keyed by model *family* keyword. Matched by substring
 * against the model name (so `claude-opus-4-8`, `claude-3-opus`, etc. all map
 * to the opus row). Numbers are list prices in $/MTok and are approximate —
 * adjust as pricing changes.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 0.8, output: 4, cacheWrite: 1.0, cacheRead: 0.08 },
};

/** Used when a model name matches no known family (mirrors the sonnet row). */
export const FALLBACK_PRICE: ModelPrice = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

/** Resolve the price row for a model name by family keyword. */
export function priceFor(model: string): ModelPrice {
  const m = model.toLowerCase();
  for (const family of Object.keys(MODEL_PRICES)) {
    if (m.includes(family)) return MODEL_PRICES[family]!;
  }
  return FALLBACK_PRICE;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
}

export const ZERO_COST: CostBreakdown = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };

/** Estimated USD cost of one request's token usage under the given model. */
export function estimateCost(tokens: AuditTokens, model: string): CostBreakdown {
  const p = priceFor(model);
  const per = (tok: number, rate: number) => (tok / 1_000_000) * rate;
  const input = per(tokens.input, p.input);
  const output = per(tokens.output, p.output);
  const cacheWrite = per(tokens.cacheCreation, p.cacheWrite);
  const cacheRead = per(tokens.cacheRead, p.cacheRead);
  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
}

export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    total: a.total + b.total,
  };
}
