import { promptExcerpt } from '@claude-proxy/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import { Gauge, Search } from 'lucide-react';
import { type CSSProperties, useEffect, useState } from 'react';
import {
  CONTEXT_PAGE_SIZE,
  type ContextResponse,
  type ContextSort,
  type ContextSortDir,
  type ContextThreadRow,
  getContext,
} from '../api';
import { QueryState } from '../components/QueryState';
import { ALL_DAYS, DAY_WINDOWS, Segmented } from '../components/Segmented';
import { Skeleton, type SkeletonColumn, SkeletonStats, SkeletonTable } from '../components/Skeleton';
import { StatCard } from '../components/StatCard';
import { fmtBytes, fmtInt, fmtLocalTs, LOCAL_TZ_ABBR } from '../format';
import { rootRoute } from '../route-root';
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
const DEFAULT_DIR: Record<ContextSort, ContextSortDir> = {
  when: 'desc',
  model: 'asc',
  realInput: 'desc',
  systemBytes: 'desc',
  toolsBytes: 'desc',
  size: 'desc',
};

/**
 * A search is typed a letter at a time and answered by the server, so the query
 * settles before it is asked. Long enough to swallow a word, short enough that the
 * table follows the typing.
 */
const SEARCH_SETTLE_MS = 250;

function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The window's tiles, and one page of its threads. **The order, the search and the
 * slice are all the server's**: a month is tens of thousands of requests and the
 * table only ever draws a screenful, so sorting a column asks for that column's
 * first page rather than re-sorting a corpus in the browser.
 */
export function ContextPage() {
  const [days, selectDays, isSwitching] = useTransitionState(14);
  const [sort, setSort] = useState<Sort>({ key: 'when', dir: 'desc' });
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const q = useSettled(search, SEARCH_SETTLE_MS);

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

  const query = useQuery({
    queryKey: ['context', days, sort.key, sort.dir, offset, q],
    queryFn: () => getContext(days, { sort: sort.key, dir: sort.dir, offset, limit: CONTEXT_PAGE_SIZE, q }),
    placeholderData: keepPreviousData,
  });
  const summary = query.data?.summary;
  const page = query.data?.page;
  const busy = isSwitching || query.isFetching;

  return (
    <section>
      <div className='pagehead'>
        <h1>Context size</h1>
        <Segmented options={DAY_WINDOWS} value={days} onSelect={chooseDays} label='Context window' busy={busy} />
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<ContextSkeleton />} busy={busy}>
        {!summary || !page || summary.requestCount === 0 ? (
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
export function contextDays(raw: unknown): number {
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
