import { describe, expect, it } from 'vitest';
import type { SummaryPayload } from '../api';
import { costView, overviewText } from './format';
import { type ConnectionInput, computeConnectionStatus, STALE_THRESHOLD_MS, statusCopy } from './machine';

const LIVE: ConnectionInput = {
  bootstrapFailed: false,
  hasSnapshot: true,
  sseOpen: true,
  lastSignalAgeMs: 1_000,
  proxyStatus: 'healthy',
};

function summary(overrides: Partial<SummaryPayload> = {}): SummaryPayload {
  return {
    reportTimezone: 'America/New_York',
    startInclusive: '2026-08-22T04:00:00.000Z',
    endExclusive: '2026-08-23T04:00:00.000Z',
    inputTokens: 120,
    outputTokens: 45,
    totalTokens: 165,
    requestCount: 3,
    latestEventTimestamp: '2026-08-22T15:30:00.000Z',
    cost: {
      currency: 'USD',
      amountUsd: '0.0025',
      catalogueVersion: 'aggregate',
    },
    costUnavailableReason: null,
    ...overrides,
  };
}

describe('computeConnectionStatus', () => {
  it('starts in bootstrapping until a snapshot arrives', () => {
    expect(computeConnectionStatus({ ...LIVE, hasSnapshot: false, lastSignalAgeMs: null })).toBe('bootstrapping');
  });

  it('reports unavailable when the server cannot be reached', () => {
    expect(computeConnectionStatus({ ...LIVE, bootstrapFailed: true })).toBe('unavailable');
  });

  it('stays unavailable even with a retained snapshot and open stream', () => {
    expect(
      computeConnectionStatus({
        ...LIVE,
        bootstrapFailed: true,
        sseOpen: false,
      }),
    ).toBe('unavailable');
  });

  it('moves to reconnecting when the stream drops but the server answers', () => {
    const input: ConnectionInput = { ...LIVE, bootstrapFailed: false, sseOpen: false };
    expect(computeConnectionStatus(input)).toBe('reconnecting');
  });

  it('transitions live to reconnecting to live across a drop and reopen', () => {
    expect(computeConnectionStatus(LIVE)).toBe('live');
    expect(computeConnectionStatus({ ...LIVE, sseOpen: false })).toBe('reconnecting');
    expect(computeConnectionStatus(LIVE)).toBe('live');
  });

  it('goes stale once connected but silent past the keepalive budget', () => {
    expect(computeConnectionStatus({ ...LIVE, lastSignalAgeMs: STALE_THRESHOLD_MS + 1 })).toBe('stale');
  });

  it('recovers stale back to live when a signal lands again', () => {
    const stale = { ...LIVE, lastSignalAgeMs: STALE_THRESHOLD_MS + 5_000 };
    expect(computeConnectionStatus(stale)).toBe('stale');
    expect(computeConnectionStatus({ ...stale, lastSignalAgeMs: 500 })).toBe('live');
  });

  it('reports degraded while the proxy is not healthy', () => {
    expect(computeConnectionStatus({ ...LIVE, proxyStatus: 'degraded' })).toBe('degraded');
    expect(computeConnectionStatus({ ...LIVE, proxyStatus: 'unavailable' })).toBe('degraded');
  });

  it('ranks unreachable above reconnecting above stale above degraded', () => {
    const base = { ...LIVE, bootstrapFailed: true, sseOpen: false };
    expect(computeConnectionStatus(base)).toBe('unavailable');
    expect(
      computeConnectionStatus({
        ...base,
        bootstrapFailed: false,
        sseOpen: true,
        lastSignalAgeMs: STALE_THRESHOLD_MS * 10,
        proxyStatus: 'degraded',
      }),
    ).toBe('stale');
  });
});

describe('statusCopy', () => {
  it('gives every state human-readable copy', () => {
    for (const state of ['bootstrapping', 'live', 'reconnecting', 'stale', 'degraded', 'unavailable'] as const) {
      expect(statusCopy(state).length).toBeGreaterThan(0);
    }
  });
});

describe('costView', () => {
  it('renders a complete estimate when every request was priced', () => {
    const view = costView(summary());
    expect(view).toEqual({ kind: 'estimate', text: '$0.0025 USD' });
  });

  it('renders an explicit unavailable state instead of $0 for unknown cost', () => {
    const view = costView(summary({ cost: null }));
    expect(view.kind).toBe('unavailable');
    if (view.kind === 'unavailable') {
      expect(view.detail).not.toContain('$0');
      expect(view.detail.length).toBeGreaterThan(0);
    }
  });

  it('explains unknown models', () => {
    const reason = { code: 'unknown-model', model: 'gpt-zeta' } as const;
    const view = costView(summary({ cost: null, costUnavailableReason: reason }));
    expect(view).toEqual({
      kind: 'unavailable',
      detail: 'model "gpt-zeta" is not in the price catalogue',
    });
  });

  it('explains missing category prices', () => {
    const reason = {
      code: 'missing-category-price',
      model: 'gpt-alpha',
      category: 'output',
    } as const;
    const view = costView(summary({ cost: null, costUnavailableReason: reason }));
    expect(view).toEqual({
      kind: 'unavailable',
      detail: 'model "gpt-alpha" has no price for output tokens',
    });
  });

  it('explains aggregate-incomplete estimates while keeping token counts', () => {
    const reason = { code: 'aggregate-incomplete', detail: 'unknown cost' } as const;
    const text = overviewText(summary({ cost: null, costUnavailableReason: reason }));
    expect(text.totalTokens).toBe('165');
    const view = costView(summary({ cost: null, costUnavailableReason: reason }));
    expect(view).toEqual({
      kind: 'unavailable',
      detail: 'estimate incomplete: unknown cost',
    });
  });
});

describe('overviewText', () => {
  it('formats counts and latest activity in the report timezone', () => {
    const text = overviewText(summary());
    expect(text.requestCount).toBe('3');
    expect(text.inputTokens).toBe('120');
    expect(text.outputTokens).toBe('45');
    expect(text.totalTokens).toBe('165');
    expect(text.latestActivity).toContain('2026');
  });

  it('says so when nothing has happened yet today', () => {
    const text = overviewText(summary({ latestEventTimestamp: null }));
    expect(text.latestActivity).toBe('no requests yet today');
  });
});
