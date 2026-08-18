import { type ContextThreadRow, promptMatches, shiftDay } from '@claude-proxy/core';
import type { ContextSort, ContextSortDir } from './api';
import { ALL_DAYS } from './components/Segmented';

/**
 * The window arithmetic the context page used to leave to the server, now that the
 * page holds its days one at a time.
 *
 * Everything here is pure and mirrors `buildContext` in `server/src/api.ts` field for
 * field — the span it walks, the comparison it sorts by, the search it filters with.
 * Only the *fold* is shared code (`mergeContextDays` in `packages/core`); these three
 * are small enough that a second copy reads better than a third export, and each
 * carries the rule it mirrors so a drift is visible rather than silent.
 */

/**
 * The reporting days a window covers, oldest first — the same span `windowDays` composes
 * server-side, so the days the page sums are the days the route would have.
 *
 * `anchor` is the server's own reporting day, read off a response rather than computed
 * here: the reporting calendar is the server's (`REPORT_TZ`), and a browser guessing at
 * it would ask for the wrong days near midnight. `since` is the corpus floor, which is
 * what `ALL_DAYS` resolves against and what every window is clamped to — asking for days
 * older than the oldest one on record only buys empty aggregates.
 */
export function contextWindowDates(days: number, anchor: string, since: string | null): string[] {
  const asked = days === ALL_DAYS ? since : shiftDay(anchor, -(days - 1));
  // No floor at all means an empty corpus: the day in progress is the whole window.
  let from = asked ?? anchor;
  if (since !== null && from < since) from = since;
  if (from > anchor) from = anchor;
  const dates: string[] = [];
  for (let day = from; day <= anchor; day = shiftDay(day, 1)) dates.push(day);
  return dates;
}

/**
 * Signed comparison for a column, ascending — the same order `compareThreads` applies
 * in `server/src/api.ts`, including `size` drawing the same number as `realInput`.
 */
export function compareContextThreads(a: ContextThreadRow, b: ContextThreadRow, sort: ContextSort): number {
  switch (sort) {
    case 'when':
      return a.firstTimestamp.localeCompare(b.firstTimestamp);
    case 'model':
      return a.models.join(' ').localeCompare(b.models.join(' '));
    case 'systemBytes':
      return a.systemBytes - b.systemBytes;
    case 'toolsBytes':
      return a.toolsBytes - b.toolsBytes;
    default:
      return a.realInput - b.realInput;
  }
}

/** What one page of the table draws, and the counts its caption reports. */
export interface ContextRowsPage {
  rows: ContextThreadRow[];
  /** Threads in the window, before any search narrowed it. */
  total: number;
  /** Threads the search kept — equal to `total` when there is no search. */
  matched: number;
  /** Threads carrying an opening prompt at all, which is what a search can reach. */
  searchable: number;
}

/**
 * Search, order and slice the window's thread rows — the work `/api/context` used to
 * do per keystroke and per column click, over rows the page already holds.
 *
 * The sort is over a copy: the merged rows are React Query's cached day objects folded
 * together, and re-ordering them in place would reorder what the next fold reads.
 */
export function contextRowsPage(
  rows: readonly ContextThreadRow[],
  opts: { sort: ContextSort; dir: ContextSortDir; offset: number; limit: number; q: string },
): ContextRowsPage {
  const matched = opts.q ? rows.filter((row) => promptMatches(row.prompt, opts.q)) : rows;
  const ordered = [...matched].sort((a, b) => {
    const diff = compareContextThreads(a, b, opts.sort);
    return opts.dir === 'asc' ? diff : -diff;
  });
  return {
    rows: ordered.slice(opts.offset, opts.offset + opts.limit),
    total: rows.length,
    matched: matched.length,
    searchable: rows.filter((row) => row.prompt !== null).length,
  };
}
