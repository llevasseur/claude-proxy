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

/**
 * The price row for a model name by family keyword, or `null` when no family
 * matches. This is the honest lookup: it reports the miss rather than covering
 * it, which is what lets `resolveCost` mark the cost unavailable.
 */
export function priceRowFor(
  model: string,
  prices: Readonly<Record<string, ModelPrice>> = MODEL_PRICES,
): ModelPrice | null {
  const m = model.toLowerCase();
  for (const [family, row] of Object.entries(prices)) {
    if (m.includes(family)) return row;
  }
  return null;
}

/**
 * Resolve the price row for a model name by family keyword, falling back to the
 * sonnet-shaped row when none matches. The fallback is a *stamped estimate*, not
 * a measurement — `resolveCost` is the path that refuses to guess.
 */
export function priceFor(model: string): ModelPrice {
  return priceRowFor(model) ?? FALLBACK_PRICE;
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

/**
 * Exact money, and the typed reason a cost can be missing.
 *
 * The float API above stays exactly as it was — every existing caller reads the
 * same numbers it always did. What follows is the exact path, ported from the
 * sibling stacks (`stacks/codex/packages/core/src/pricing.ts` and
 * `stacks/ox-alpha/packages/core/src/pricing.ts`, whose mechanics are identical).
 * Two things came across and nothing else: integer arithmetic in picoUSD, and a
 * typed unavailable reason.
 */

/** The four buckets a claude request bills into. */
export type PriceCategory = 'input' | 'output' | 'cacheWrite' | 'cacheRead';

/**
 * Why a cost is `null`. Per ADR 0020 an unpriced request reports its tokens in
 * full and marks the *entire* cost unavailable with one of these — never a
 * substituted zero, and never a partial estimate labelled as a total.
 *
 * The shape is the pattern, not just this enum: a `code` discriminant plus the
 * context needed to act on it. A store's absence (ADR 0060) is a different kind
 * of absence and gets its own union, written this same way, so the two stay
 * recognisably one idea instead of drifting into unrelated enums.
 */
export type CostUnavailableReason =
  | { readonly code: 'unknown-model'; readonly model: string }
  | { readonly code: 'missing-category-price'; readonly model: string; readonly category: PriceCategory }
  | { readonly code: 'aggregate-incomplete'; readonly detail: string };

/**
 * A priced cost, exact. Every field is a decimal string in USD, so it survives
 * addition and storage without the drift a float accumulates.
 */
export interface ExactCost {
  readonly currency: 'USD';
  readonly input: string;
  readonly output: string;
  readonly cacheWrite: string;
  readonly cacheRead: string;
  readonly total: string;
}

/** Either a cost or the reason there isn't one — never both, never neither. */
export type CostResult =
  | { readonly cost: ExactCost; readonly unavailableReason: null }
  | { readonly cost: null; readonly unavailableReason: CostUnavailableReason };

/** A $/MTok rate as written: whole dollars, optionally up to six decimal places. */
const RATE_PATTERN = /^\d+(?:\.\d{1,6})?$/;

/** A USD amount this module produced: six to twelve decimal places. */
const AMOUNT_PATTERN = /^\d+(?:\.\d{1,12})?$/;

/**
 * A $/MTok rate as picoUSD (1e-12 USD) per single token — `rate * 1e12 / 1e6`,
 * done on the decimal text so no float ever holds the value. `null` when the
 * rate is not a number this scale can represent exactly, which is the row-level
 * fault `missing-category-price` reports.
 */
function picoUsdPerToken(rate: number): bigint | null {
  const text = String(rate);
  if (!RATE_PATTERN.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

/** picoUSD as a decimal string, trailing zeros trimmed but never below six places. */
function picoUsdToDecimal(value: bigint): string {
  const whole = value / 1_000_000_000_000n;
  const fraction = (value % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '');
  return fraction.length === 0 ? `${whole}.000000` : `${whole}.${fraction.padEnd(6, '0')}`;
}

/**
 * The exact cost of one request's tokens, or the typed reason there is none.
 *
 * Unlike `estimateCost` this never falls back to a guessed row: a model matching
 * no family is `unknown-model`, and a row whose rate for a *consumed* bucket is
 * unusable is `missing-category-price`. A bucket that consumed nothing is not
 * consulted, so a broken rate on an unused bucket does not sink the request —
 * that is ADR 0020's "any consumed usage category" read literally.
 */
export function resolveCost(
  tokens: AuditTokens,
  model: string,
  prices: Readonly<Record<string, ModelPrice>> = MODEL_PRICES,
): CostResult {
  const row = priceRowFor(model, prices);
  if (row === null) return { cost: null, unavailableReason: { code: 'unknown-model', model } };

  const buckets: ReadonlyArray<readonly [PriceCategory, number, number]> = [
    ['input', tokens.input, row.input],
    ['output', tokens.output, row.output],
    ['cacheWrite', tokens.cacheCreation, row.cacheWrite],
    ['cacheRead', tokens.cacheRead, row.cacheRead],
  ];
  const picoUsd = { input: 0n, output: 0n, cacheWrite: 0n, cacheRead: 0n } satisfies Record<PriceCategory, bigint>;
  let total = 0n;

  for (const [category, count, rate] of buckets) {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`${category} token count must be a non-negative integer, got ${count}`);
    }
    if (count === 0) continue;
    const perToken = picoUsdPerToken(rate);
    if (perToken === null)
      return { cost: null, unavailableReason: { code: 'missing-category-price', model, category } };
    const amount = BigInt(count) * perToken;
    picoUsd[category] = amount;
    total += amount;
  }

  return {
    cost: {
      currency: 'USD',
      input: picoUsdToDecimal(picoUsd.input),
      output: picoUsdToDecimal(picoUsd.output),
      cacheWrite: picoUsdToDecimal(picoUsd.cacheWrite),
      cacheRead: picoUsdToDecimal(picoUsd.cacheRead),
      total: picoUsdToDecimal(total),
    },
    unavailableReason: null,
  };
}

/**
 * Sum USD decimal strings exactly. Adding the same amounts as floats is what
 * drifts; this goes through integer picoUSD and comes back, so a thousand
 * fractions of a cent total to the cent they actually are.
 */
export function addUsdAmounts(amounts: readonly string[]): string {
  let total = 0n;
  for (const amount of amounts) {
    if (!AMOUNT_PATTERN.test(amount)) throw new Error(`invalid USD amount: ${amount}`);
    const [whole = '0', fraction = ''] = amount.split('.');
    total += BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0'));
  }
  return picoUsdToDecimal(total);
}

/**
 * Roll many resolved costs into one. Unavailability propagates: a single
 * unpriced request makes the whole aggregate unavailable rather than quietly
 * understating it (ADR 0020). An empty list totals zero, which is a real
 * measurement of nothing rather than a missing one.
 */
export function aggregateCost(results: readonly CostResult[]): CostResult {
  const costs: ExactCost[] = [];
  for (const result of results) {
    if (result.cost === null) {
      return { cost: null, unavailableReason: { code: 'aggregate-incomplete', detail: result.unavailableReason.code } };
    }
    costs.push(result.cost);
  }
  return {
    cost: {
      currency: 'USD',
      input: addUsdAmounts(costs.map((c) => c.input)),
      output: addUsdAmounts(costs.map((c) => c.output)),
      cacheWrite: addUsdAmounts(costs.map((c) => c.cacheWrite)),
      cacheRead: addUsdAmounts(costs.map((c) => c.cacheRead)),
      total: addUsdAmounts(costs.map((c) => c.total)),
    },
    unavailableReason: null,
  };
}
