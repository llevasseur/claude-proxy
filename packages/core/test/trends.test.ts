import { describe, expect, it } from 'vitest';
import { blendRate, endOfDaySnapshots, lastNonZeroComparison } from '../src/trends.js';

/** A day of traffic, reduced to the two numbers a blended rate reads. */
interface Day {
  date: string;
  cost: number;
  requests: number;
}

const day = (date: string, cost: number, requests: number): Day => ({ date, cost, requests });

const cost = (d: Day) => d.cost;
const requests = (d: Day) => d.requests;
const perDay = () => 1;

describe('endOfDaySnapshots', () => {
  // A fixed instant in the report timezone, not the suite's own clock.
  const during = new Date('2026-08-03T18:00:00-04:00');

  it('drops the day still being written to', () => {
    const days = [day('2026-08-01', 3, 10), day('2026-08-02', 4, 10), day('2026-08-03', 1, 2)];
    expect(endOfDaySnapshots(days, during).map((d) => d.date)).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('keeps every day once the window is entirely in the past', () => {
    const days = [day('2026-08-01', 3, 10), day('2026-08-02', 4, 10)];
    expect(endOfDaySnapshots(days, during)).toHaveLength(2);
  });

  it('comes back empty when today is all that was captured', () => {
    expect(endOfDaySnapshots([day('2026-08-03', 1, 2)], during)).toEqual([]);
  });
});

describe('lastNonZeroComparison', () => {
  it('compares against yesterday when yesterday recorded something', () => {
    const days = [day('2026-08-01', 10, 10), day('2026-08-02', 20, 10)];
    const compared = lastNonZeroComparison(days, cost);
    expect(compared?.baseline?.date).toBe('2026-08-01');
    expect(compared?.deltaPct).toBeCloseTo(100);
  });

  it('reaches past the idle days to the last one that recorded the metric', () => {
    // Yesterday and the day before captured nothing; the honest baseline is the
    // 1st, and comparing against a zero day would report no movement at all.
    const days = [
      day('2026-08-01', 40, 10),
      day('2026-08-02', 0, 0),
      day('2026-08-03', 0, 0),
      day('2026-08-04', 10, 4),
    ];
    const compared = lastNonZeroComparison(days, cost);
    expect(compared?.baseline?.date).toBe('2026-08-01');
    expect(compared?.deltaPct).toBeCloseTo(-75);
  });

  it('picks a baseline per metric, so two fields can land on different days', () => {
    const days = [day('2026-08-01', 40, 10), day('2026-08-02', 0, 5), day('2026-08-03', 10, 10)];
    expect(lastNonZeroComparison(days, cost)?.baseline?.date).toBe('2026-08-01');
    expect(lastNonZeroComparison(days, requests)?.baseline?.date).toBe('2026-08-02');
  });

  it('has no baseline when every earlier day was empty, rather than dividing by zero', () => {
    const days = [day('2026-08-01', 0, 0), day('2026-08-02', 10, 4)];
    const compared = lastNonZeroComparison(days, cost);
    expect(compared?.closing.date).toBe('2026-08-02');
    expect(compared?.baseline).toBeNull();
    expect(compared?.deltaPct).toBeNull();
  });

  it('has no baseline on a single day, and nothing at all on none', () => {
    expect(lastNonZeroComparison([day('2026-08-02', 10, 4)], cost)?.baseline).toBeNull();
    expect(lastNonZeroComparison([], cost)).toBeNull();
  });

  it('reports the closing day even when it is the zero one', () => {
    // Today has recorded nothing yet. That is a real reading to show, not a
    // reason to fall back to an earlier day as the headline.
    const days = [day('2026-08-01', 40, 10), day('2026-08-02', 0, 0)];
    const compared = lastNonZeroComparison(days, cost);
    expect(compared?.closing.date).toBe('2026-08-02');
    expect(compared?.deltaPct).toBeCloseTo(-100);
  });
});

describe('blendRate', () => {
  it('weights by volume, so a quiet day cannot count as much as a busy one', () => {
    // The mean of the two daily rates is $5.50; the blended rate is what was
    // actually spent per call.
    const days = [day('2026-08-01', 100, 100), day('2026-08-02', 10, 1)];
    const blended = blendRate(days, cost, requests);
    expect(blended?.value).toBeCloseTo(110 / 101);
    expect(blended?.numerator).toBe(110);
    expect(blended?.denominator).toBe(101);
  });

  it('averages per day when the denominator is the day itself', () => {
    const days = [day('2026-08-01', 3, 10), day('2026-08-02', 5, 10), day('2026-08-03', 4, 10)];
    expect(blendRate(days, cost, perDay)?.value).toBe(4);
  });

  it('skips a day with no denominator instead of pulling the rate toward zero', () => {
    const days = [day('2026-08-01', 10, 10), day('2026-08-02', 0, 0), day('2026-08-03', 30, 10)];
    const blended = blendRate(days, cost, requests);
    expect(blended?.value).toBe(2);
    // The idle day had no say in the number.
    expect(blended?.days).toBe(2);
  });

  it('is null when nothing was captured, rather than dividing by zero', () => {
    expect(blendRate([], cost, requests)).toBeNull();
    expect(blendRate([day('2026-08-01', 0, 0)], cost, requests)).toBeNull();
  });
});
