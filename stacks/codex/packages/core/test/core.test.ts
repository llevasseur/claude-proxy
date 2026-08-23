import { describe, expect, it } from 'vitest';
import type { ModelPricing, SanitizedAuditSidecarV1, UsageTotals } from '../src/index.ts';
import {
  aggregateToday,
  estimateUsageCost,
  getTodayWindow,
  normalizeResponsesUsage,
  parseSanitizedAuditSidecar,
  SidecarValidationError,
  UsageValidationError,
} from '../src/index.ts';

const baseUsage: UsageTotals = Object.freeze({
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  outputTokens: 100_000,
  reasoningOutputTokens: 0,
  totalTokens: 1_100_000,
});

function sidecar(timestamp: string, costAvailable = true): SanitizedAuditSidecarV1 {
  return {
    schemaVersion: 1,
    recordId: timestamp,
    timestamp,
    model: 'gpt-5',
    endpoint: '/v1/responses',
    responseStatus: 200,
    requestId: null,
    usage: baseUsage,
    cost: costAvailable ? { currency: 'USD', amountUsd: '2.250000', catalogueVersion: 'test' } : null,
    costUnavailableReason: costAvailable ? null : { code: 'unknown-model', model: 'future-model' },
  };
}

describe('Responses usage normalization', () => {
  it('normalizes headline totals and reported detail categories immutably', () => {
    const usage = normalizeResponsesUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 30,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 130,
    });
    expect(usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 30,
      reasoningOutputTokens: 20,
      totalTokens: 130,
    });
    expect(Object.isFrozen(usage)).toBe(true);
  });

  it.each([
    null,
    {},
    { input_tokens: -1, output_tokens: 1, total_tokens: 0 },
    { input_tokens: 1, output_tokens: 1, total_tokens: 3 },
    { input_tokens: 1, input_tokens_details: { cached_tokens: 2 }, output_tokens: 0, total_tokens: 1 },
  ])('rejects malformed usage %#', (usage) => {
    expect(() => normalizeResponsesUsage(usage)).toThrow(UsageValidationError);
  });
});

describe('decimal-safe pricing', () => {
  it('prices known-model input and output exactly', () => {
    expect(estimateUsageCost('gpt-5', baseUsage)).toEqual({
      cost: { currency: 'USD', amountUsd: '2.250000', catalogueVersion: '2026-08-22' },
      unavailableReason: null,
    });
  });

  it.each([
    ['gpt-5.6-luna', '0.320000'],
    ['gpt-5.6-terra', '3.200000'],
    ['gpt-5.6-sol', '6.000000'],
    ['gpt-5.3-codex', '3.150000'],
  ])('prices %s at its catalogue rates', (model, expected) => {
    expect(estimateUsageCost(model, baseUsage)).toEqual({
      cost: { currency: 'USD', amountUsd: expected, catalogueVersion: '2026-08-22' },
      unavailableReason: null,
    });
  });

  it('prices cached input and reasoning output without double counting headline totals', () => {
    expect(
      estimateUsageCost('gpt-5', {
        inputTokens: 1_000_000,
        cachedInputTokens: 500_000,
        outputTokens: 100_000,
        reasoningOutputTokens: 80_000,
        totalTokens: 1_100_000,
      }),
    ).toEqual({
      cost: { currency: 'USD', amountUsd: '1.687500', catalogueVersion: '2026-08-22' },
      unavailableReason: null,
    });
  });

  it('makes the whole estimate unavailable for an unknown model', () => {
    expect(estimateUsageCost('future-model', baseUsage)).toEqual({
      cost: null,
      unavailableReason: { code: 'unknown-model', model: 'future-model' },
    });
  });

  it('makes the whole estimate unavailable when a consumed category has no price', () => {
    const incomplete: Record<string, ModelPricing> = {
      test: {
        model: 'test',
        currency: 'USD',
        unit: 'one-million-tokens',
        effectiveDate: '2026-08-19',
        source: 'test',
        usdPerMillionTokens: { input: '1.00' },
      },
    };
    expect(estimateUsageCost('test', baseUsage, incomplete)).toEqual({
      cost: null,
      unavailableReason: { code: 'missing-category-price', model: 'test', category: 'output' },
    });
  });
});

describe('strict sidecar validation', () => {
  it('accepts the versioned sanitized contract', () => {
    expect(parseSanitizedAuditSidecar(sidecar('2026-08-19T12:00:00.000Z'))).toEqual(
      sidecar('2026-08-19T12:00:00.000Z'),
    );
  });

  it('rejects fields outside the privacy boundary', () => {
    expect(() => parseSanitizedAuditSidecar({ ...sidecar('2026-08-19T12:00:00.000Z'), prompt: 'secret' })).toThrow(
      SidecarValidationError,
    );
  });
});

describe('Today reporting', () => {
  it('uses America/New_York boundaries and excludes adjacent events', () => {
    const summary = aggregateToday(
      [sidecar('2026-08-19T03:59:59.999Z'), sidecar('2026-08-19T04:00:00.000Z'), sidecar('2026-08-20T03:59:59.999Z')],
      new Date('2026-08-19T16:00:00.000Z'),
    );
    expect(summary.requestCount).toBe(2);
    expect(summary.inputTokens).toBe(2_000_000);
    expect(summary.outputTokens).toBe(200_000);
    expect(summary.totalTokens).toBe(2_200_000);
    expect(summary.cost?.amountUsd).toBe('4.500000');
  });

  it('propagates cost unavailability without hiding tokens', () => {
    const summary = aggregateToday([sidecar('2026-08-19T12:00:00.000Z', false)], new Date('2026-08-19T16:00:00.000Z'));
    expect(summary.inputTokens).toBe(1_000_000);
    expect(summary.cost).toBeNull();
    expect(summary.costUnavailableReason?.code).toBe('aggregate-incomplete');
  });

  it('makes the spring daylight-saving day 23 hours', () => {
    const window = getTodayWindow(new Date('2025-03-09T16:00:00.000Z'));
    expect(window.start.toISOString()).toBe('2025-03-09T05:00:00.000Z');
    expect(window.end.toISOString()).toBe('2025-03-10T04:00:00.000Z');
  });

  it('makes the autumn daylight-saving day 25 hours', () => {
    const window = getTodayWindow(new Date('2025-11-02T16:00:00.000Z'));
    expect(window.start.toISOString()).toBe('2025-11-02T04:00:00.000Z');
    expect(window.end.toISOString()).toBe('2025-11-03T05:00:00.000Z');
  });
});
