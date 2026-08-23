import { describe, expect, it } from 'vitest';
import type { DailyUsageBucket, SanitizedAuditSidecarV1 } from '../src/index.ts';
import {
  addUsdAmounts,
  aggregateDailyBuckets,
  aggregateRangeFromBuckets,
  getCalendarDayWindow,
  modelFilter,
  resolveCalendarRange,
  selectByModels,
} from '../src/index.ts';

const TIMEZONE = 'America/New_York';
const NOW = new Date('2026-08-19T16:00:00.000Z');

function sidecar(
  timestamp: string,
  overrides: Partial<Pick<SanitizedAuditSidecarV1, 'model' | 'cost' | 'costUnavailableReason'>> = {},
): SanitizedAuditSidecarV1 {
  return {
    schemaVersion: 1,
    recordId: timestamp,
    timestamp,
    model: 'gpt-5',
    endpoint: '/v1/responses',
    responseStatus: 200,
    requestId: null,
    usage: {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 100_000,
      reasoningOutputTokens: 0,
      totalTokens: 1_100_000,
    },
    cost: { currency: 'USD', amountUsd: '2.250000', catalogueVersion: 'test' },
    costUnavailableReason: null,
    ...overrides,
  };
}

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function bucketAt(buckets: readonly DailyUsageBucket[], index: number): DailyUsageBucket {
  const bucket = buckets[index];
  if (!bucket) throw new Error(`missing daily bucket at index ${index}`);
  return bucket;
}

function pick<T>(values: readonly T[], random: () => number): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error('empty selection');
  return value;
}

describe('calendar range resolution', () => {
  it('resolves an inclusive bounded range into half-open UTC instants', () => {
    const range = resolveCalendarRange('2026-06-01', '2026-06-03', NOW, TIMEZONE);
    expect(range.reportTimezone).toBe(TIMEZONE);
    expect(range.startInclusive?.toISOString()).toBe('2026-06-01T04:00:00.000Z');
    expect(range.endExclusive.toISOString()).toBe('2026-06-04T04:00:00.000Z');
  });

  it('treats from == to as a single-day half-open window', () => {
    const range = resolveCalendarRange('2026-06-05', '2026-06-05', NOW, TIMEZONE);
    const window = getCalendarDayWindow('2026-06-05', TIMEZONE);
    expect(range.startInclusive?.getTime()).toBe(window.start.getTime());
    expect(range.endExclusive.getTime()).toBe(window.end.getTime());
  });

  it('resolves an omitted to to the current instant report-day end and keeps an open lower bound', () => {
    const range = resolveCalendarRange(null, null, NOW, TIMEZONE);
    expect(range.startInclusive).toBeNull();
    expect(range.endExclusive.toISOString()).toBe('2026-08-20T04:00:00.000Z');
  });

  it('makes spring daylight-saving days 23 hours inside a spanning range', () => {
    const buckets = aggregateDailyBuckets([], '2025-03-08', '2025-03-10', NOW, TIMEZONE);
    expect(buckets.map((bucket) => bucket.date)).toEqual(['2025-03-08', '2025-03-09', '2025-03-10']);
    expect(bucketAt(buckets, 0).startInclusive).toBe('2025-03-08T05:00:00.000Z');
    expect(bucketAt(buckets, 0).endExclusive).toBe('2025-03-09T05:00:00.000Z');
    expect(bucketAt(buckets, 1).startInclusive).toBe('2025-03-09T05:00:00.000Z');
    expect(bucketAt(buckets, 1).endExclusive).toBe('2025-03-10T04:00:00.000Z');
    expect(bucketAt(buckets, 2).startInclusive).toBe('2025-03-10T04:00:00.000Z');
    expect(bucketAt(buckets, 2).endExclusive).toBe('2025-03-11T04:00:00.000Z');
  });

  it('makes autumn daylight-saving days 25 hours inside a spanning range', () => {
    const buckets = aggregateDailyBuckets([], '2025-11-01', '2025-11-02', NOW, TIMEZONE);
    expect(bucketAt(buckets, 0).startInclusive).toBe('2025-11-01T04:00:00.000Z');
    expect(bucketAt(buckets, 0).endExclusive).toBe('2025-11-02T04:00:00.000Z');
    expect(bucketAt(buckets, 1).startInclusive).toBe('2025-11-02T04:00:00.000Z');
    expect(bucketAt(buckets, 1).endExclusive).toBe('2025-11-03T05:00:00.000Z');
  });

  it.each([
    ['junk', '2026-06-02'],
    ['2026-13-01', '2026-06-02'],
    ['2026-06-31', '2026-06-02'],
    ['2026-06-02', 'junk'],
  ])('rejects malformed calendar dates %#', (from, to) => {
    expect(() => resolveCalendarRange(from, to, NOW, TIMEZONE)).toThrow(RangeError);
  });

  it('rejects a reversed range', () => {
    expect(() => resolveCalendarRange('2026-06-05', '2026-06-04', NOW, TIMEZONE)).toThrow(RangeError);
  });
});

describe('daily buckets over a range', () => {
  it('excludes records outside the requested window and fills empty days', () => {
    const events = [
      sidecar('2026-06-01T03:59:59.999Z'),
      sidecar('2026-06-01T04:00:00.000Z'),
      sidecar('2026-06-01T12:00:00.000Z'),
      sidecar('2026-06-02T12:00:00.000Z'),
      sidecar('2026-06-04T12:00:00.000Z'),
      sidecar('2026-06-05T04:00:00.000Z'),
    ];
    const buckets = aggregateDailyBuckets(events, '2026-06-01', '2026-06-04', NOW, TIMEZONE);
    expect(buckets.map((bucket) => bucket.date)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']);
    expect(bucketAt(buckets, 0).requestCount).toBe(2);
    expect(bucketAt(buckets, 0).latestEventTimestamp).toBe('2026-06-01T12:00:00.000Z');
    expect(bucketAt(buckets, 1).requestCount).toBe(1);
    expect(bucketAt(buckets, 2)).toMatchObject({ requestCount: 0, latestEventTimestamp: null });
    expect(bucketAt(buckets, 3).requestCount).toBe(1);
    expect(bucketAt(buckets, 3).latestEventTimestamp).toBe('2026-06-04T12:00:00.000Z');
    expect(bucketAt(buckets, 0).cost?.amountUsd).toBe('4.500000');
    expect(bucketAt(buckets, 2).cost?.amountUsd).toBe('0.000000');
  });

  it('derives the first day from the earliest event when the lower bound is open', () => {
    const events = [sidecar('2026-08-18T12:00:00.000Z'), sidecar('2026-08-19T12:00:00.000Z')];
    const buckets = aggregateDailyBuckets(events, null, null, NOW, TIMEZONE);
    expect(buckets.map((bucket) => bucket.date)).toEqual(['2026-08-18', '2026-08-19']);
    expect(bucketAt(buckets, 0).endExclusive).toBe('2026-08-19T04:00:00.000Z');
  });

  it('propagates unpriced requests at the bucket boundary per ADR 0003', () => {
    const events = [
      sidecar('2026-06-01T12:00:00.000Z'),
      sidecar('2026-06-01T13:00:00.000Z', {
        cost: null,
        costUnavailableReason: { code: 'unknown-model', model: 'future-model' },
      }),
      sidecar('2026-06-02T12:00:00.000Z'),
    ];
    const buckets = aggregateDailyBuckets(events, '2026-06-01', '2026-06-02', NOW, TIMEZONE);
    expect(bucketAt(buckets, 0).cost).toBeNull();
    expect(bucketAt(buckets, 0).costUnavailableReason).toEqual({
      code: 'aggregate-incomplete',
      detail: 'unknown-model',
    });
    expect(bucketAt(buckets, 0).inputTokens).toBe(2_000_000);
    expect(bucketAt(buckets, 1).cost?.amountUsd).toBe('2.250000');
    expect(bucketAt(buckets, 1).costUnavailableReason).toBeNull();
  });
});

describe('range aggregation through one shared path', () => {
  it('summing daily buckets reproduces the direct range aggregate exactly', () => {
    const random = lcg(20260822);
    for (let fixture = 0; fixture < 50; fixture += 1) {
      const models = ['gpt-5', 'gpt-5-mini', 'future-model'];
      const events: SanitizedAuditSidecarV1[] = [];
      const count = Math.floor(random() * 40);
      for (let index = 0; index < count; index += 1) {
        const startMs = Date.UTC(2026, 5, 1, 4, 0, 0);
        const endMs = Date.UTC(2026, 5, 15, 4, 0, 0);
        const ms = startMs + Math.floor(random() * (endMs - startMs));
        const model = pick(models, random);
        const priced = random() > 0.25;
        events.push(
          sidecar(new Date(ms).toISOString(), {
            model,
            cost: priced ? { currency: 'USD', amountUsd: (random() * 10).toFixed(6), catalogueVersion: 'test' } : null,
            costUnavailableReason: priced ? null : { code: 'unknown-model', model },
          }),
        );
      }
      const shuffled = [...events].sort(() => random() - 0.5);
      const bucketsA = aggregateDailyBuckets(events, '2026-06-01', '2026-06-14', NOW, TIMEZONE);
      const bucketsB = aggregateDailyBuckets(shuffled, '2026-06-01', '2026-06-14', NOW, TIMEZONE);
      const rangeA = aggregateRangeFromBuckets(bucketsA);
      const rangeB = aggregateRangeFromBuckets(bucketsB);

      expect(rangeA).toEqual(rangeB);
      expect(bucketsA.reduce((sum, bucket) => sum + bucket.requestCount, 0)).toBe(events.length);
      expect(bucketsA.map((bucket) => bucket.date)).toHaveLength(14);
      expect(rangeA.requestCount).toBe(events.length);
      expect(rangeA.inputTokens).toBe(events.length * 1_000_000);
      expect(rangeA.totalTokens).toBe(events.length * 1_100_000);

      const expectedCost = events.every((event) => event.cost !== null)
        ? addUsdAmounts(events.flatMap((event) => (event.cost ? [event.cost.amountUsd] : [])))
        : null;
      if (expectedCost === null) {
        expect(rangeA.cost).toBeNull();
        expect(rangeA.costUnavailableReason?.code).toBe('aggregate-incomplete');
      } else {
        expect(rangeA.cost?.amountUsd).toBe(expectedCost);
        expect(rangeA.costUnavailableReason).toBeNull();
      }
    }
  });

  it('propagates unpriced requests across every included request at the range level', () => {
    const buckets = aggregateDailyBuckets(
      [
        sidecar('2026-06-01T12:00:00.000Z'),
        sidecar('2026-06-03T12:00:00.000Z', {
          cost: null,
          costUnavailableReason: { code: 'missing-category-price', model: 'gpt-5', category: 'output' },
        }),
      ],
      '2026-06-01',
      '2026-06-03',
      NOW,
      TIMEZONE,
    );
    const range = aggregateRangeFromBuckets(buckets);
    expect(range.requestCount).toBe(2);
    expect(range.inputTokens).toBe(2_000_000);
    expect(range.cost).toBeNull();
    expect(range.costUnavailableReason).toEqual({
      code: 'aggregate-incomplete',
      detail: 'aggregate-incomplete',
    });
  });

  it('returns an available zero-cost summary for an empty range of buckets', () => {
    const buckets = aggregateDailyBuckets([], '2026-06-01', '2026-06-02', NOW, TIMEZONE);
    const range = aggregateRangeFromBuckets(buckets);
    expect(range.requestCount).toBe(0);
    expect(range.latestEventTimestamp).toBeNull();
    expect(range.cost?.amountUsd).toBe('0.000000');
    expect(range.costUnavailableReason).toBeNull();
  });
});

describe('exact multi-select model filter', () => {
  it('matches repeated exact identifiers with no normalization or aliasing', () => {
    const matches = modelFilter(['gpt-5', 'gpt-5']);
    expect(matches('gpt-5')).toBe(true);
    expect(matches('GPT-5')).toBe(false);
    expect(matches('gpt-5-mini')).toBe(false);
    expect(matches(' gpt-5')).toBe(false);
  });

  it('matches any selected model in a multi-select', () => {
    const matches = modelFilter(['gpt-5', 'gpt-5-nano']);
    expect(matches('gpt-5')).toBe(true);
    expect(matches('gpt-5-nano')).toBe(true);
    expect(matches('gpt-5-mini')).toBe(false);
  });

  it('matches everything when the selection is empty', () => {
    const matches = modelFilter([]);
    expect(matches('anything-at-all')).toBe(true);
  });

  it('degrades unmatched values to no matches instead of erroring', () => {
    const matches = modelFilter('retired-model-2019'.split(','));
    const events = [sidecar('2026-06-01T12:00:00.000Z')];
    expect(selectByModels(events, ['retired-model-2019'])).toHaveLength(0);
    expect(selectByModels(events, ['retired-model-2019']).map((event) => matches(event.model))).toHaveLength(0);
  });

  it('filters records by the stored model field exactly', () => {
    const events = [
      sidecar('2026-06-01T12:00:00.000Z'),
      sidecar('2026-06-01T13:00:00.000Z', { model: 'gpt-5-mini' }),
      sidecar('2026-06-01T14:00:00.000Z', { model: 'future-model' }),
    ];
    expect(selectByModels(events, ['gpt-5-mini']).map((event) => event.model)).toEqual(['gpt-5-mini']);
    expect(selectByModels(events, [])).toHaveLength(3);
  });
});
