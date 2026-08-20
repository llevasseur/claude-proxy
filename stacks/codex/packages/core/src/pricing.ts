import type { CostResult, ModelPricing, PriceCategory, UsageTotals } from './types.ts';

export const PRICING_CATALOGUE_VERSION = '2025-08-07';
export const PRICING_SOURCE = 'https://openai.com/api/pricing/';

export const PRICING_CATALOGUE: Readonly<Record<string, ModelPricing>> = Object.freeze({
  'gpt-5': pricing('gpt-5', '1.25', '0.125', '10.00'),
  'gpt-5-2025-08-07': pricing('gpt-5-2025-08-07', '1.25', '0.125', '10.00'),
  'gpt-5-mini': pricing('gpt-5-mini', '0.25', '0.025', '2.00'),
  'gpt-5-nano': pricing('gpt-5-nano', '0.05', '0.005', '0.40'),
});

function pricing(model: string, input: string, cachedInput: string, output: string): ModelPricing {
  return Object.freeze({
    model,
    currency: 'USD',
    unit: 'one-million-tokens',
    effectiveDate: PRICING_CATALOGUE_VERSION,
    source: PRICING_SOURCE,
    usdPerMillionTokens: Object.freeze({ input, cachedInput, output, reasoningOutput: output }),
  });
}

function decimalRateToPicoUsdPerToken(rate: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(rate)) throw new Error(`invalid USD-per-million rate: ${rate}`);
  const [whole = '0', fraction = ''] = rate.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function picoUsdToDecimal(value: bigint): string {
  const whole = value / 1_000_000_000_000n;
  const fraction = (value % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '');
  return fraction.length === 0 ? `${whole}.000000` : `${whole}.${fraction.padEnd(6, '0')}`;
}

export function estimateUsageCost(
  model: string,
  usage: UsageTotals,
  catalogue: Readonly<Record<string, ModelPricing>> = PRICING_CATALOGUE,
): CostResult {
  const modelPricing = catalogue[model];
  if (!modelPricing) {
    return Object.freeze({ cost: null, unavailableReason: Object.freeze({ code: 'unknown-model', model }) });
  }

  const categories: ReadonlyArray<readonly [PriceCategory, number]> = [
    ['input', usage.inputTokens - usage.cachedInputTokens],
    ['cachedInput', usage.cachedInputTokens],
    ['output', usage.outputTokens - usage.reasoningOutputTokens],
    ['reasoningOutput', usage.reasoningOutputTokens],
  ];
  let picoUsd = 0n;

  for (const [category, tokens] of categories) {
    if (tokens === 0) continue;
    const rate = modelPricing.usdPerMillionTokens[category];
    if (rate === undefined) {
      return Object.freeze({
        cost: null,
        unavailableReason: Object.freeze({ code: 'missing-category-price', model, category }),
      });
    }
    picoUsd += BigInt(tokens) * decimalRateToPicoUsdPerToken(rate);
  }

  return Object.freeze({
    cost: Object.freeze({
      currency: 'USD',
      amountUsd: picoUsdToDecimal(picoUsd),
      catalogueVersion: PRICING_CATALOGUE_VERSION,
    }),
    unavailableReason: null,
  });
}

export function addUsdAmounts(amounts: readonly string[]): string {
  let total = 0n;
  for (const amount of amounts) {
    if (!/^\d+(?:\.\d{1,12})?$/.test(amount)) throw new Error(`invalid USD amount: ${amount}`);
    const [whole = '0', fraction = ''] = amount.split('.');
    total += BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0'));
  }
  return picoUsdToDecimal(total);
}
