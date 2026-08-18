import { describe, expect, it } from 'vitest';
import {
  aggregateContext,
  type ContextEntry,
  contextDayAggregate,
  emptyContextDay,
  groupContextThreads,
  mergeContextDays,
  toContextThreadRow,
} from '../src/context.js';

/**
 * The context route no longer reads its window as a span: it reduces each
 * reporting day to a {@link ContextDayAggregate}, keeps the closed ones, and sums
 * whatever days the window covers. That is only worth doing if the sum is the
 * *same answer* the one-pass read gave — so every test here is the same claim in
 * a different corner: splitting entries into days and merging them back must be
 * indistinguishable from never having split them.
 *
 * The interesting cases are the ones a sum cannot reach naively. A mean of daily
 * means is not the window's mean. A median has no per-day summary at all. A
 * thread that ran across midnight is a partial row on each side. And the `top`
 * list's ties are decided by read order, which the split has to preserve.
 */

/** 15:00Z, where the UTC day and the reporting day agree — the fixture convention. */
function entryAt(day: string, minute: number, realInput: number, threadId: string | null): ContextEntry {
  const stamp = `${day}T15:${String(minute).padStart(2, '0')}:00.000Z`;
  return {
    file: `${stamp.replace(/[:.]/g, '-')}_anthropic`,
    timestamp: stamp,
    model: minute % 2 === 0 ? 'claude-opus-5' : 'claude-haiku-4',
    sessionId: 'session',
    threadId,
    prompt: threadId === null ? null : `opened ${threadId}`,
    realInput,
    systemBytes: realInput / 10,
    toolsBytes: realInput / 20,
    totalBytes: realInput * 2,
    toolCount: 3,
  };
}

/** Split a chronological run of entries into its days, oldest day first. */
function byDay(entries: readonly ContextEntry[]): ContextEntry[][] {
  const days = new Map<string, ContextEntry[]>();
  for (const entry of entries) {
    const day = entry.timestamp.slice(0, 10);
    const held = days.get(day);
    if (held) held.push(entry);
    else days.set(day, [entry]);
  }
  return [...days.values()];
}

/** The whole-window answer, computed the way the route used to compute it. */
function wholeWindow(entries: readonly ContextEntry[]) {
  return {
    aggregates: aggregateContext(entries),
    rows: groupContextThreads(entries).map(toContextThreadRow),
  };
}

/** Days reduced and summed, the way the route computes it now. */
function summedDays(entries: readonly ContextEntry[]) {
  return mergeContextDays(byDay(entries).map((day) => contextDayAggregate(day)));
}

describe('summing a window out of its per-day aggregates', () => {
  it('lands on the whole-window answer for a run spread across days', () => {
    // Sizes deliberately unequal per day, so a mean of daily means would differ
    // from the window's mean: two requests on the first day, five on the second.
    const entries = [
      entryAt('2026-07-20', 1, 1000, 'aaaa'),
      entryAt('2026-07-20', 2, 9000, 'bbbb'),
      entryAt('2026-07-21', 1, 100, 'cccc'),
      entryAt('2026-07-21', 2, 200, 'cccc'),
      entryAt('2026-07-21', 3, 300, 'dddd'),
      entryAt('2026-07-21', 4, 400, 'dddd'),
      entryAt('2026-07-21', 5, 500, 'eeee'),
    ];

    expect(summedDays(entries)).toEqual(wholeWindow(entries));
  });

  it('keeps the median an order statistic rather than an average of medians', () => {
    // The days' own medians are 2 and 53; the window's is 3. Neither their mean
    // (27.5) nor their count-weighted mean (22.4) is anywhere near it, which is
    // why a day's token counts are stored whole rather than summarized.
    const entries = [
      entryAt('2026-07-20', 1, 1, 'aaaa'),
      entryAt('2026-07-20', 2, 2, 'aaaa'),
      entryAt('2026-07-20', 3, 3, 'aaaa'),
      entryAt('2026-07-21', 1, 5, 'bbbb'),
      entryAt('2026-07-21', 2, 100, 'bbbb'),
    ];

    const summed = summedDays(entries);
    expect(summed.aggregates.medianRealInput).toBe(3);
    expect(summed.aggregates.medianRealInput).toBe(wholeWindow(entries).aggregates.medianRealInput);
  });

  it('folds a thread that ran across midnight back into one row', () => {
    const entries = [
      entryAt('2026-07-20', 10, 400, 'night'),
      entryAt('2026-07-20', 20, 900, 'night'),
      entryAt('2026-07-21', 11, 700, 'night'),
    ];

    const { rows } = summedDays(entries);
    expect(rows).toHaveLength(1);
    // Three requests, one row, and every peak cell read off the same request —
    // the 900 on the first day, not the last day's 700.
    expect(rows[0]).toMatchObject({
      threadId: 'night',
      requestCount: 3,
      realInput: 900,
      file: entries[1]!.file,
      firstTimestamp: entries[0]!.timestamp,
      lastTimestamp: entries[2]!.timestamp,
      models: ['claude-opus-5', 'claude-haiku-4'],
    });
    expect(rows).toEqual(wholeWindow(entries).rows);
  });

  it('breaks a tie in `top` and `max` for the earlier request, across the day seam', () => {
    // Same size on both days: the window's peak is the one that came first, which
    // is what merging days oldest-first with a strictly-greater rule preserves.
    const entries = [entryAt('2026-07-20', 1, 5000, 'first'), entryAt('2026-07-21', 1, 5000, 'second')];

    const summed = summedDays(entries);
    expect(summed.aggregates.max?.threadId).toBe('first');
    expect(summed.aggregates.top.map((e) => e.threadId)).toEqual(['first', 'second']);
    expect(summed).toEqual(wholeWindow(entries));
  });

  it('does not lose a window-wide top request to its own day being busy', () => {
    // Twelve requests on one day and one on the next, with `topN` at 10: the lone
    // request is large enough for the window's top, and its day's list has room.
    const busy = Array.from({ length: 12 }, (_, i) => entryAt('2026-07-20', i, (i + 1) * 100, `t${i}`));
    const entries = [...busy, entryAt('2026-07-21', 0, 50_000, 'huge')];

    expect(summedDays(entries).aggregates.top[0]?.threadId).toBe('huge');
    expect(summedDays(entries)).toEqual(wholeWindow(entries));
  });

  it('gives each thread-less request its own row and keeps them apart', () => {
    const entries = [entryAt('2026-07-20', 1, 100, null), entryAt('2026-07-21', 1, 200, null)];

    const { rows } = summedDays(entries);
    expect(rows.map((r) => r.key)).toEqual([`no-thread:${entries[0]!.file}`, `no-thread:${entries[1]!.file}`]);
    expect(rows.every((r) => r.requestCount === 1)).toBe(true);
  });

  it('reads an idle day as contributing nothing at all', () => {
    const entries = [entryAt('2026-07-21', 1, 300, 'aaaa')];
    const withGap = mergeContextDays([emptyContextDay(), contextDayAggregate(entries), emptyContextDay()]);

    expect(withGap).toEqual(wholeWindow(entries));
  });

  it('answers the empty window with zeros rather than a null aggregate', () => {
    expect(mergeContextDays([])).toEqual({
      aggregates: { requestCount: 0, avgRealInput: 0, medianRealInput: 0, maxRealInput: 0, max: null, top: [] },
      rows: [],
    });
  });
});
