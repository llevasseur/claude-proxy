import type { AuditTokens } from './types.js';

/** Price per **million tokens** (USD). Explicitly approximate and editable. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Editable price map keyed by model *family* keyword. Matched by substring
 * against the model name (so `claude-opus-5`, `claude-opus-4-8`, `claude-3-opus`
 * all map to the opus row). Numbers are list prices in $/MTok.
 *
 * A row prices one generation and every model matching its keyword bills at it,
 * so name the generation when changing a row. These are Opus 5, Sonnet 5,
 * Haiku 4.5.
 *
 * `cacheWrite` is 1.25x `input` (5-minute TTL) and `cacheRead` 0.1x; a row
 * breaking that shape is a transcription error.
 */
export const MODEL_PRICES = {
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  // Sonnet 5 intro pricing ($2/$10) runs to 2026-08-31; list is carried instead.
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
} satisfies Record<string, ModelPrice>;

/** Used when a model name matches no known family (mirrors the sonnet row). */
export const FALLBACK_PRICE: ModelPrice = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

/** Resolve the price row for a model name by family keyword. */
export function priceFor(model: string): ModelPrice {
  const m = model.toLowerCase();
  for (const family of Object.keys(MODEL_PRICES)) {
    if (!m.includes(family)) continue;
    // SAFETY: `family` is an element of `Object.keys(MODEL_PRICES)`, so it is one of
    // that object's own keys by construction; `Object.keys` merely types its result
    // as `string[]`, losing which object the keys were read off.
    return MODEL_PRICES[family as keyof typeof MODEL_PRICES];
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
