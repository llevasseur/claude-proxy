import { mergeContextDays, promptExcerpt } from '@claude-proxy/core';
import { type Query, useQueries, useQuery } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import { Gauge, Search } from 'lucide-react';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import {
  CONTEXT_PAGE_SIZE,
  type ContextDayResponse,
  type ContextResponse,
  type ContextSort,
  type ContextSortDir,
  type ContextThreadRow,
  getContextDay,
} from '../api';
import { LiveIndicator } from '../components/LiveIndicator';
import { QueryState } from '../components/QueryState';
import { ALL_DAYS, DAY_WINDOWS, Segmented } from '../components/Segmented';
import { Skeleton, type SkeletonColumn, SkeletonStats, SkeletonTable } from '../components/Skeleton';
import { StatCard } from '../components/StatCard';
import { contextRowsPage, contextWindowDates } from '../context-window';
import { fmtBytes, fmtInt, fmtLocalTs, LOCAL_TZ_ABBR } from '../format';
import type { JsonValue } from '../json';
import { rootRoute } from '../route-root';
import { useLiveQuery } from '../useLiveQuery';
import { useTransitionState } from '../useTransitionState';
import type { NavEntry } from './nav';

/** Thread, when, model, three numeric columns, then the size bar. */
const THREAD_COLUMNS: readonly SkeletonColumn[] = [
  { cell: '74%' },
  { cell: '62%' },
  { cell: '58%' },
  { className: 'num' },
  { className: 'num' },
  { className: 'num' },
  { className: 'bar-col' },
];

type Sort = { key: ContextSort; dir: ContextSortDir };

/** Direction applied the first time a column becomes the sort key. */
const DEFAULT_DIR = {
  when: 'desc',
  model: 'asc',
  realInput: 'desc',
  systemBytes: 'desc',
  toolsBytes: 'desc',
  size: 'desc',
} as const satisfies Record<ContextSort, ContextSortDir>;

/**
 * A search filters rows the page already holds, so the debounce only keeps a long window
 * from re-filtering per keystroke. Long enough to swallow a word, short enough that the
 * table follows the typing.
 */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * How long the day in progress is held before it is asked for again — **only while the
 * stream is not in charge.** The open day is pushed over `/api/context/day/stream`, so
 * this is the fallback `useLiveQuery` documents: no `EventSource`, or a stream that
 * closed. It is the client-wide default, restated here because every *other* day on this
 * page departs from it.
 *
 * A closed day gets `Infinity` regardless. That vouch is per response, not per date, so a
 * day still split across the live directory and the archive keeps this window until it
 * settles — and those are the days no stream covers, since the stream follows the open day
 * alone.
 */
const OPEN_DAY_STALE_MS = 30_000;

/** A day's staleness window, decided by the server's own vouch rather than by its date. */
const dayStaleTime = (query: Query<ContextDayResponse, Error>): number =>
  query.state.data?.closed ? Number.POSITIVE_INFINITY : OPEN_DAY_STALE_MS;

/**
 * `value`, but only after it has stopped changing for `ms`. Deliberately the same
 * shape as the copy in `concepts.tsx`, which debounces the same kind of box; the two
 * are worth hoisting into one module the next time a third search wants it.
 */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The window's tiles, and one page of its threads. **The window is held as its days, and
 * folded here.**
 *
 * Each day is one query keyed by its date and held for the session, so widening 7d to 30d
 * asks only for the days it does not have, and the day in progress is the only query with
 * a staleness window at all. `mergeContextDays` is the same pure fold `/api/context` sums
 * with server-side.
 *
 * The order, the search and the slice are this page's own, over rows it already holds.
 */
export function ContextPage() {
  const [days, selectDays, isSwitching] = useTransitionState(14);
  const [sort, setSort] = useState<Sort>({ key: 'when', dir: 'desc' });
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const q = useDebounced(search, SEARCH_DEBOUNCE_MS);

  // A new order, a new search or a new window is a new first page.
  const chooseDays = (next: number) => {
    setOffset(0);
    selectDays(next);
  };
  const onSort = (key: ContextSort) => {
    setOffset(0);
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] },
    );
  };
  const onSearch = (next: string) => {
    setOffset(0);
    setSearch(next);
  };

  // **One subscription makes the whole page live.** Every tile, every row and the search
  // are folded from the day queries, and the open day is the only one of them that can
  // change. A closed day streams nothing.
  const live = useLiveQuery<ContextDayResponse>('/api/context/day/stream', ['context-day', 'today']);

  // The day in progress, which every window contains and no window may cache. It also
  // carries the two facts the span needs: the server's reporting day, and the corpus floor.
  // Held forever while the stream is in charge — a poll would only re-fetch what the last
  // frame already wrote.
  const anchorQuery = useQuery({
    queryKey: ['context-day', 'today'],
    queryFn: () => getContextDay(),
    staleTime: live === 'live' ? Number.POSITIVE_INFINITY : OPEN_DAY_STALE_MS,
  });
  const anchor = anchorQuery.data;

  const closedDates = anchor
    ? contextWindowDates(days, anchor.date, anchor.since).filter((d) => d !== anchor.date)
    : [];
  const dayQueries = useQueries({
    queries: closedDates.map((date) => ({
      queryKey: ['context-day', date],
      queryFn: () => getContextDay(date),
      staleTime: dayStaleTime,
      // A settled day is a few kB and cannot change; holding it for the session is what
      // makes widening the window cheap.
      gcTime: Number.POSITIVE_INFINITY,
    })),
  });

  // `closedDates` is oldest-first and the anchor is the window's last day, so this stays
  // oldest-first — the order every tie-break in `mergeContextDays` is fixed against.
  const held = [...dayQueries.map((day) => day.data), anchor].filter((day): day is ContextDayResponse => !!day);
  // Which days are folded **and which version of each**. A date alone is not enough: a
  // day can be inside the window without being `closed` — yesterday's late sidecars sit
  // in the live root until the archiver's next rotation — and `dayStaleTime` refetches
  // exactly those on the open day's schedule, so a fold keyed on dates would hold the
  // first snapshot of one forever. `dataUpdatedAt` moves whenever a fetch lands.
  const heldKey = [...dayQueries, anchorQuery].map((day) => `${day.data?.date ?? ''}@${day.dataUpdatedAt}`).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `held` is rebuilt every render, so depending on it would refold on every render and defeat the memo. `heldKey` names both the days folded and the fetch each was folded from, which is the whole of what the fold reads.
  const merged = useMemo(() => mergeContextDays(held.map((day) => day.aggregate)), [heldKey]);

  const page = useMemo(
    () => ({
      ...contextRowsPage(merged.rows, { sort: sort.key, dir: sort.dir, offset, limit: CONTEXT_PAGE_SIZE, q }),
      sort: sort.key,
      dir: sort.dir,
      offset,
      limit: CONTEXT_PAGE_SIZE,
      q,
    }),
    [merged, sort.key, sort.dir, offset, q],
  );

  const summary = merged.aggregates;
  // Only the anchor gates the skeleton — the days a window is still waiting on do not.
  // Widening 14d to 30d holds every day of the old window already, so a partial fold
  // *is* the previous window; dimming it through `busy` keeps it on screen the way
  // `keepPreviousData` used to, where gating on the slowest of 23 new days would blank
  // the tiles and the table outright.
  const isLoading = anchorQuery.isPending;
  const error = anchorQuery.error ?? dayQueries.find((day) => day.error)?.error ?? null;
  const busy = isSwitching || anchorQuery.isFetching || dayQueries.some((day) => day.isFetching);

  return (
    <section>
      <div className='pagehead'>
        <h1>Context size</h1>
        {/* Stream health, then how far back — the order every other page's head uses. */}
        <div className='pagehead-controls'>
          <LiveIndicator status={live} />
          <Segmented options={DAY_WINDOWS} value={days} onSelect={chooseDays} label='Context window' busy={busy} />
        </div>
      </div>

      <QueryState isLoading={isLoading} error={error} skeleton={<ContextSkeleton />} busy={busy}>
        {summary.requestCount === 0 ? (
          <div className='card empty'>No context captured in the last {days} days.</div>
        ) : (
          <>
            <div className='muted' style={{ marginBottom: '0.75rem' }}>
              Real input tokens (input + cache) — the true prompt size sent to the model · {summary.requestCount}{' '}
              request{summary.requestCount === 1 ? '' : 's'}
            </div>

            <div className='grid stats'>
              <StatCard label='Average context' value={fmtInt(summary.avgRealInput)} sub='tokens / request' />
              <StatCard label='Median context' value={fmtInt(summary.medianRealInput)} sub='tokens / request' />
              <StatCard label='Largest context' value={fmtInt(summary.maxRealInput)} sub='tokens' />
              <StatCard label='Requests' value={fmtInt(summary.requestCount)} sub={`last ${days} days`} />
            </div>

            <ThreadsTable
              page={page}
              peakOf={summary.maxRealInput}
              days={days}
              sort={sort}
              onSort={onSort}
              search={search}
              onSearch={onSearch}
              onOffset={setOffset}
              stale={busy}
            />
          </>
        )}
      </QueryState>
    </section>
  );
}

/** The caption, four stat tiles, and the threads table, all at their loaded size. */
function ContextSkeleton() {
  return (
    <>
      <div className='muted' style={{ marginBottom: '0.75rem' }} aria-hidden>
        <Skeleton w='34rem' />
      </div>
      <SkeletonStats count={4} />
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='18%' h='0.95em' />
          <Skeleton w='34%' />
        </div>
        <SkeletonTable columns={THREAD_COLUMNS} rows={10} />
      </div>
    </>
  );
}

/**
 * Per-column floors — every column needs one, or a wrap in Thread squeezes its
 * neighbours. Their sum is wider than a phone, which is what `.table-scroll` is for.
 */
const COLUMN = {
  thread: { minWidth: 220 },
  when: { minWidth: 150 },
  model: { minWidth: 130 },
  num: { minWidth: 88 },
  bar: { minWidth: 90 },
} as const satisfies Record<string, CSSProperties>;

function ThreadsTable({
  page,
  peakOf,
  days,
  sort,
  onSort,
  search,
  onSearch,
  onOffset,
  stale,
}: {
  page: ContextResponse['page'];
  peakOf: number;
  days: number;
  sort: Sort;
  onSort: (key: ContextSort) => void;
  search: string;
  onSearch: (next: string) => void;
  onOffset: (next: number) => void;
  stale: boolean;
}) {
  // Scaled by the whole window, so paging and filtering don't re-scale the bars.
  const max = Math.max(1, peakOf);
  const searching = page.q.length > 0;
  const first = page.matched === 0 ? 0 : page.offset + 1;
  const last = Math.min(page.offset + page.rows.length, page.matched);

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Threads</h2>
        <label className='sessions-search context-search'>
          <Search size={14} strokeWidth={1.75} aria-hidden />
          <input
            type='search'
            value={search}
            placeholder='Search what was asked'
            aria-label='Search threads by opening prompt'
            onChange={(e) => onSearch(e.target.value)}
          />
        </label>
        <span className='muted'>
          {searching
            ? `${fmtInt(page.matched)} of ${fmtInt(page.total)} · searching ${fmtInt(page.searchable)} recorded prompt${page.searchable === 1 ? '' : 's'}`
            : 'one row per thread, showing its largest request · click it to see every request it sent'}
        </span>
      </div>
      <div className='table-scroll'>
        <table className={stale ? 'table is-stale' : 'table'} aria-busy={stale || undefined}>
          <thead>
            <tr>
              <th style={COLUMN.thread}>Thread</th>
              <SortHeader
                label={`Started (${LOCAL_TZ_ABBR})`}
                sortKey='when'
                sort={sort}
                onSort={onSort}
                style={COLUMN.when}
              />
              <SortHeader label='Model' sortKey='model' sort={sort} onSort={onSort} style={COLUMN.model} />
              <SortHeader
                label='Peak input'
                sortKey='realInput'
                sort={sort}
                onSort={onSort}
                className='num'
                style={COLUMN.num}
              />
              <SortHeader
                label='System'
                sortKey='systemBytes'
                sort={sort}
                onSort={onSort}
                className='num'
                style={COLUMN.num}
              />
              <SortHeader
                label='Tools'
                sortKey='toolsBytes'
                sort={sort}
                onSort={onSort}
                className='num'
                style={COLUMN.num}
              />
              <SortHeader
                label='Size'
                sortKey='size'
                sort={sort}
                onSort={onSort}
                className='bar-col'
                style={COLUMN.bar}
              />
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <ThreadRow key={row.key} row={row} query={page.q} days={days} max={max} peakOf={peakOf} />
            ))}
            {page.rows.length === 0 && (
              <tr>
                <td colSpan={7} className='empty'>
                  {searching ? `No thread's opening prompt matches “${page.q}”.` : 'No threads on this page.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {page.matched > page.limit && (
        <nav className='pager' aria-label='Thread pages'>
          <button
            type='button'
            className='pager-btn'
            disabled={page.offset === 0}
            onClick={() => onOffset(Math.max(0, page.offset - page.limit))}>
            ‹ Previous
          </button>
          <span className='pager-pos muted'>
            {fmtInt(first)}–{fmtInt(last)} of {fmtInt(page.matched)}
          </span>
          <button
            type='button'
            className='pager-btn'
            disabled={last >= page.matched}
            onClick={() => onOffset(page.offset + page.limit)}>
            Next ›
          </button>
        </nav>
      )}
    </div>
  );
}

/**
 * One thread, on one row, showing its largest request. A thread-less request has no
 * thread page, so it links to its own breakdown instead.
 */
function ThreadRow({
  row,
  query,
  days,
  max,
  peakOf,
}: {
  row: ContextThreadRow;
  query: string;
  days: number;
  max: number;
  peakOf: number;
}) {
  const count = row.requestCount;
  const title = row.prompt ? promptExcerpt(row.prompt, query) : 'No opening prompt recorded';
  return (
    <tr>
      <td style={COLUMN.thread}>
        {row.threadId ? (
          <Link
            to='/context/thread/$threadId'
            params={{ threadId: row.threadId }}
            search={{ days }}
            className='thread-link'>
            <span className='thread-title' title={row.prompt ?? undefined}>
              {title}
            </span>
            <span className='thread-sub'>
              <span className='thread-id'>{row.threadId.slice(-8)}</span>
              {fmtInt(count)} request{count === 1 ? '' : 's'}
            </span>
          </Link>
        ) : (
          <Link to='/context/$file' params={{ file: row.file }} className='thread-link'>
            <span className='thread-title'>{title}</span>
            <span className='thread-sub'>no thread recorded · 1 request</span>
          </Link>
        )}
      </td>
      <td style={COLUMN.when}>
        <span className='thread-when'>{fmtLocalTs(row.firstTimestamp)}</span>
        {count > 1 && <span className='thread-sub'>→ {fmtLocalTs(row.lastTimestamp)}</span>}
      </td>
      <td className='muted' style={COLUMN.model}>
        {row.models.length === 1 ? row.models[0] : `${row.models.length} models`}
      </td>
      <td className='num' style={COLUMN.num}>
        {fmtInt(row.realInput)}
        {row.realInput === peakOf && <span className='muted'> · peak</span>}
      </td>
      <td className='num' style={COLUMN.num}>
        {fmtBytes(row.systemBytes)}
      </td>
      <td className='num' style={COLUMN.num}>
        {fmtBytes(row.toolsBytes)}
      </td>
      <td className='bar-col' style={COLUMN.bar}>
        <div className='rowbar' style={{ width: `${(row.realInput / max) * 100}%` }} />
      </td>
    </tr>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
  style,
}: {
  label: string;
  sortKey: ContextSort;
  sort: Sort;
  onSort: (key: ContextSort) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={['sortable', className].filter(Boolean).join(' ')}
      style={style}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(sortKey)}>
      {label}
      {active && <span className='sort-arrow'>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}

/**
 * `?days=` clamped to 1–365 the way `/api/context` clamps it, plus `ALL_DAYS` for
 * every day on record; anything unreadable falls back to the default rather than
 * erroring. The clamp bounds a requested count, not the corpus — `All` passes
 * through it untouched and has its floor resolved server-side.
 *
 * Exported because the two drill-downs below this page validate `?days=` the same way.
 */
export function contextDays(raw: JsonValue | undefined): number {
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14;
  if (days === ALL_DAYS) return ALL_DAYS;
  return days > 0 ? Math.min(Math.round(days), 365) : 14;
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/context',
  component: ContextPage,
  staticData: { title: 'Context size' },
});

export const nav = {
  section: 'Context',
  to: '/context',
  label: 'Context size',
  hint: 'prompt',
  exact: false,
  icon: Gauge,
} as const satisfies NavEntry;
