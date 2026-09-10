import { describe, expect, it } from 'vitest';
import { type CivilDate, periodBounds } from '../src/model.ts';

function civil(year: number, month: number, day: number): CivilDate {
  return { year, month, day };
}

describe('periodBounds (decision internet-spend 003)', () => {
  it('uses the calendar month when resetDay is 1', () => {
    expect(periodBounds(civil(2026, 7, 15), 1)).toEqual({
      start: civil(2026, 7, 1),
      endExclusive: civil(2026, 8, 1),
    });
  });

  it('falls back to the 1st when resetDay is unset', () => {
    expect(periodBounds(civil(2026, 7, 15), undefined)).toEqual(periodBounds(civil(2026, 7, 15), 1));
    expect(periodBounds(civil(2026, 7, 15), null)).toEqual(periodBounds(civil(2026, 7, 15), 1));
  });

  it('starts the period on the anchor day when now is on or after it', () => {
    expect(periodBounds(civil(2026, 7, 15), 5)).toEqual({
      start: civil(2026, 7, 5),
      endExclusive: civil(2026, 8, 5),
    });
    // On the boundary itself the new period has begun.
    expect(periodBounds(civil(2026, 7, 5), 5)).toEqual({
      start: civil(2026, 7, 5),
      endExclusive: civil(2026, 8, 5),
    });
  });

  it('reaches back to the previous month when now falls before the anchor', () => {
    expect(periodBounds(civil(2026, 7, 3), 5)).toEqual({
      start: civil(2026, 6, 5),
      endExclusive: civil(2026, 7, 5),
    });
  });

  it('clamps February to its last day for resetDay 29 in a common year', () => {
    // 2026 is not a leap year.
    expect(periodBounds(civil(2026, 3, 2), 29)).toEqual({
      start: civil(2026, 2, 28),
      endExclusive: civil(2026, 3, 29),
    });
  });

  it('clamps February to the 29th for resetDay 30 and 31 in a leap year', () => {
    // 2028 is a leap year.
    expect(periodBounds(civil(2028, 3, 2), 31)).toEqual({
      start: civil(2028, 2, 29),
      endExclusive: civil(2028, 3, 31),
    });
    expect(periodBounds(civil(2028, 2, 20), 30)).toEqual({
      start: civil(2028, 1, 30),
      endExclusive: civil(2028, 2, 29),
    });
  });

  it('clamps the next month too when the anchor exceeds its length', () => {
    expect(periodBounds(civil(2026, 1, 31), 31)).toEqual({
      start: civil(2026, 1, 31),
      endExclusive: civil(2026, 2, 28),
    });
  });

  it('crosses the year boundary from December', () => {
    expect(periodBounds(civil(2026, 12, 25), 1)).toEqual({
      start: civil(2026, 12, 1),
      endExclusive: civil(2027, 1, 1),
    });
  });

  it('is unaffected by DST spring-forward and fall-back dates — civil arithmetic only', () => {
    // US spring-forward 2026-03-08 and fall-back 2026-11-01 land inside these periods.
    expect(periodBounds(civil(2026, 3, 9), 10)).toEqual({
      start: civil(2026, 2, 10),
      endExclusive: civil(2026, 3, 10),
    });
    expect(periodBounds(civil(2026, 11, 2), 3)).toEqual({
      start: civil(2026, 10, 3),
      endExclusive: civil(2026, 11, 3),
    });
  });
});
