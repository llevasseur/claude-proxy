import { describe, expect, it } from 'vitest';
import {
  aggregateToday,
  DEFAULT_REPORT_TIMEZONE,
  formatReportDate,
  getCalendarDayWindow,
  getTodayWindow,
} from '../src/today.ts';
import type { SanitizedAuditSidecarV1 } from '../src/types.ts';

function sidecar(overrides: Partial<SanitizedAuditSidecarV1> = {}): SanitizedAuditSidecarV1 {
  const base: SanitizedAuditSidecarV1 = {
    schemaVersion: 1,
    recordId: `record-${Math.random()}`,
    timestamp: '2026-03-08T10:00:00.000Z',
    model: 'gpt-5',
    endpoint: '/v1/responses',
    responseStatus: 200,
    requestId: null,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      reasoningOutputTokens: 0,
      totalTokens: 150,
    },
    cost: { currency: 'USD', amountUsd: '1.500000', catalogueVersion: '2025-08-07' },
    costUnavailableReason: null,
  };
  return Object.freeze({ ...base, ...overrides });
}

describe('day boundaries', () => {
  it('uses half-open local-midnight boundaries in the report timezone', () => {
    const { start, end } = getCalendarDayWindow('2026-03-09', 'America/New_York');
    expect(start.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-10T04:00:00.000Z');
  });

  it('handles the spring-forward day as a 23-hour window', () => {
    const { start, end } = getCalendarDayWindow('2026-03-08', 'America/New_York');
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('handles the fall-back day as a 25-hour window', () => {
    const { start, end } = getCalendarDayWindow('2026-11-01', 'America/New_York');
    expect(start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it('formats report dates in the given timezone', () => {
    expect(formatReportDate(Date.UTC(2026, 2, 8, 23, 30), 'America/New_York')).toBe('2026-03-08');
    expect(formatReportDate(Date.UTC(2026, 2, 8, 23, 30), 'UTC')).toBe('2026-03-08');
    expect(formatReportDate(Date.UTC(2026, 2, 8, 23, 30), 'Asia/Tokyo')).toBe('2026-03-09');
  });

  it('rejects invalid calendar dates', () => {
    expect(() => getCalendarDayWindow('2026-02-30')).toThrow(/invalid calendar date/);
    expect(() => getCalendarDayWindow('nope')).toThrow(/invalid calendar date/);
  });
});

describe('aggregateToday', () => {
  it('aggregates only events inside the half-open window', () => {
    const now = new Date('2026-03-09T15:00:00.000Z');
    const inside = sidecar({
      recordId: 'inside',
      timestamp: '2026-03-09T12:00:00.000Z',
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 15,
      },
      cost: { currency: 'USD', amountUsd: '0.050000', catalogueVersion: '2025-08-07' },
    });
    const atStart = sidecar({
      recordId: 'at-start',
      timestamp: '2026-03-09T04:00:00.000Z',
      usage: {
        inputTokens: 20,
        cachedInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 0,
        totalTokens: 30,
      },
      cost: { currency: 'USD', amountUsd: '0.100000', catalogueVersion: '2025-08-07' },
    });
    const atEnd = sidecar({ recordId: 'at-end', timestamp: '2026-03-10T04:00:00.000Z' });
    const yesterday = sidecar({ recordId: 'yesterday', timestamp: '2026-03-09T03:59:59.999Z' });
    const summary = aggregateToday([inside, atStart, atEnd, yesterday], now, 'America/New_York');
    expect(summary.requestCount).toBe(2);
    expect(summary.inputTokens).toBe(30);
    expect(summary.outputTokens).toBe(15);
    expect(summary.totalTokens).toBe(45);
    expect(summary.cost?.amountUsd).toBe('0.150000');
    expect(summary.latestEventTimestamp).toBe('2026-03-09T12:00:00.000Z');
    expect(summary.reportTimezone).toBe('America/New_York');
    expect(summary.startInclusive).toBe('2026-03-09T04:00:00.000Z');
    expect(summary.endExclusive).toBe('2026-03-10T04:00:00.000Z');
  });

  it('propagates cost unavailability across the whole aggregate while retaining tokens', () => {
    const now = new Date('2026-03-09T15:00:00.000Z');
    const priced = sidecar({
      recordId: 'priced',
      timestamp: '2026-03-09T12:00:00.000Z',
      cost: { currency: 'USD', amountUsd: '1.000000', catalogueVersion: '2025-08-07' },
    });
    const unpriced = sidecar({
      recordId: 'unpriced',
      timestamp: '2026-03-09T13:00:00.000Z',
      cost: null,
      costUnavailableReason: { code: 'unknown-model', model: 'gpt-9-future' },
    });
    const summary = aggregateToday([priced, unpriced], now, 'America/New_York');
    expect(summary.requestCount).toBe(2);
    expect(summary.inputTokens).toBe(200);
    expect(summary.totalTokens).toBe(300);
    expect(summary.cost).toBeNull();
    expect(summary.costUnavailableReason).toEqual({
      code: 'aggregate-incomplete',
      detail: 'unknown-model',
    });
  });

  it('keeps an empty day fully priced at zero', () => {
    const now = new Date('2026-03-09T15:00:00.000Z');
    const summary = aggregateToday([], now, 'America/New_York');
    expect(summary.requestCount).toBe(0);
    expect(summary.latestEventTimestamp).toBeNull();
    expect(summary.cost?.amountUsd).toBe('0.000000');
    expect(summary.costUnavailableReason).toBeNull();
  });

  it('derives the window from the explicit clock in the explicit timezone', () => {
    // Same instant reported in New York vs Tokyo lands on different days.
    const now = new Date('2026-03-09T16:30:00.000Z');
    const ny = getTodayWindow(now, 'America/New_York');
    const tokyo = getTodayWindow(now, 'Asia/Tokyo');
    expect(ny.start.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(tokyo.start.toISOString()).toBe('2026-03-09T15:00:00.000Z');
    // One instant reported from New York vs Tokyo yields different day windows:
    // an event at 14:30Z is still "yesterday evening" in Tokyo but mid-morning in New York.
    const nySummary = aggregateToday([sidecar({ timestamp: '2026-03-09T14:30:00.000Z' })], now, 'America/New_York');
    const tokyoSummary = aggregateToday([sidecar({ timestamp: '2026-03-09T14:30:00.000Z' })], now, 'Asia/Tokyo');
    expect(nySummary.requestCount).toBe(1);
    expect(tokyoSummary.requestCount).toBe(0);
    expect(DEFAULT_REPORT_TIMEZONE).toBe('America/New_York');
  });

  it('rejects an invalid clock value', () => {
    expect(() => aggregateToday([], new Date('not-a-date'))).toThrow(/valid Date/);
  });
});
