// Which request bodies the errors page opens. The biggest bodies cluster at the end of
// a run, so a size-ordered scan reads only what a compacted session already dropped its
// early failures from.
import type { ContextEntry } from '@claude-proxy/core';
import { describe, expect, it } from 'vitest';
import { requestsToScan } from '../src/api.js';

const START = Date.parse('2026-07-23T17:00:00.000Z');

/** One capture: `n` fixes both its place in the timeline and its file handle. */
const entry = (n: number, realInput: number): ContextEntry => ({
  file: `req-${String(n).padStart(3, '0')}`,
  timestamp: new Date(START + n * 60_000).toISOString(),
  model: 'claude-opus-4-8',
  sessionId: 'be4b71b3-ccaf-4350-b1aa-b0cf0218897a',
  threadId: null,
  prompt: null,
  realInput,
  systemBytes: 100,
  toolsBytes: 200,
  totalBytes: realInput,
  toolCount: 2,
});

/** A run whose bodies grow toward the end — the shape a real session has. */
const growing = (count: number): ContextEntry[] =>
  Array.from({ length: count }, (_, i) => entry(i + 1, 1000 * (i + 1)));

describe('requestsToScan', () => {
  it('does not order a set inside the budget by size', () => {
    const requests = growing(5);
    const picked = requestsToScan(requests);

    const bySize = [...requests].sort((a, b) => b.realInput - a.realInput).map((e) => e.file);
    expect(picked.map((e) => e.file)).not.toEqual(bySize);
  });

  it('leads a small set with the peak, then walks the timeline', () => {
    const picked = requestsToScan(growing(5)).map((e) => e.file);

    // The general path's walk: the peak, evenly spaced samples, then the timeline
    // filling whatever budget the walk's repeats left over.
    expect(picked).toEqual(['req-005', 'req-002', 'req-003', 'req-004', 'req-001']);
  });

  it('still reads every body when the whole set fits the budget', () => {
    const picked = requestsToScan(growing(4));

    expect(new Set(picked.map((e) => e.file)).size).toBe(4);
  });

  it('caps a larger set and samples it across the timeline rather than the top of the sizes', () => {
    const picked = requestsToScan(growing(200));

    // At most the budget — a growing run's peak is also its last sample, so the walk's
    // own dedupe spends one fewer read here.
    expect(picked.length).toBeLessThanOrEqual(6);
    expect(picked[0]?.file).toBe('req-200'); // the peak leads
    // Back into the first quarter, where a size-ordered scan of a growing run never
    // gets — its top six are the last six.
    const ranks = picked.slice(1).map((e) => Number(e.file.slice(4)));
    expect(Math.min(...ranks)).toBeLessThan(50);
  });

  it('handles a single request and an empty set', () => {
    expect(requestsToScan([entry(1, 500)]).map((e) => e.file)).toEqual(['req-001']);
    expect(requestsToScan([])).toEqual([]);
  });
});
