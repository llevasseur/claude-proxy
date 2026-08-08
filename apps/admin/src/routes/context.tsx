import { type ContextThreadGroup, groupContextThreads, promptExcerpt, promptMatches } from '@claude-proxy/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { type CSSProperties, useMemo, useState } from 'react';
import { type ContextResponse, getContext } from '../api';
import { QueryState } from '../components/QueryState';
import { DAY_WINDOWS, Segmented } from '../components/Segmented';
import { Skeleton, type SkeletonColumn, SkeletonStats, SkeletonTable } from '../components/Skeleton';
import { StatCard } from '../components/StatCard';
import { fmtBytes, fmtInt, fmtLocalTs, LOCAL_TZ_ABBR } from '../format';
import { useTransitionState } from '../useTransitionState';

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

export function ContextPage() {
  const [days, selectDays, isSwitching] = useTransitionState(14);
  const query = useQuery({
    queryKey: ['context', days],
    queryFn: () => getContext(days),
    placeholderData: keepPreviousData,
  });
  const summary = query.data?.summary;
  const busy = isSwitching || query.isFetching;

  return (
    <section>
      <div className='pagehead'>
        <h1>Context size</h1>
        <Segmented options={DAY_WINDOWS} value={days} onSelect={selectDays} label='Context window' busy={busy} />
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<ContextSkeleton />} busy={busy}>
        {!summary || summary.requestCount === 0 ? (
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

            <ThreadsTable summary={summary} days={days} />
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

type SortKey = 'when' | 'model' | 'realInput' | 'systemBytes' | 'toolsBytes' | 'size';
type SortDir = 'asc' | 'desc';

/** Direction applied the first time a column becomes the sort key. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  when: 'desc',
  model: 'asc',
  realInput: 'desc',
  systemBytes: 'desc',
  toolsBytes: 'desc',
  size: 'desc',
};

/**
 * Signed comparison for a column, ascending. Every numeric column reads the
 * thread's peak request, which is what its single row shows, so the Size bar
 * sorts on the same underlying value as Real input.
 */
function compare(a: ContextThreadGroup, b: ContextThreadGroup, key: SortKey): number {
  switch (key) {
    case 'when':
      return a.firstTimestamp.localeCompare(b.firstTimestamp);
    case 'model':
      return a.models.join(' ').localeCompare(b.models.join(' '));
    case 'systemBytes':
      return a.peak.systemBytes - b.peak.systemBytes;
    case 'toolsBytes':
      return a.peak.toolsBytes - b.peak.toolsBytes;
    default:
      return a.peak.realInput - b.peak.realInput;
  }
}

/**
 * Per-column floors — every column needs one, or a wrap in Thread just
 * redistributes the squeeze onto its neighbours. Their sum is wider than a phone,
 * which is what `.table-scroll` is for.
 */
const COLUMN = {
  thread: { minWidth: 220 },
  when: { minWidth: 150 },
  model: { minWidth: 130 },
  num: { minWidth: 88 },
  bar: { minWidth: 90 },
} as const satisfies Record<string, CSSProperties>;

function ThreadsTable({ summary, days }: { summary: ContextResponse['summary']; days: number }) {
  const [sort, setSort, isSorting] = useTransitionState<{ key: SortKey; dir: SortDir }>({
    key: 'when',
    dir: 'desc',
  });
  const [query, setQuery] = useState('');
  const { entries, maxRealInput } = summary;
  // Scaled by the whole window, so filtering doesn't re-scale the bars.
  const max = Math.max(1, maxRealInput);

  // Grouped before filtering and sorting, so a thread is one row however its
  // requests were interleaved with another's.
  const groups = useMemo(() => groupContextThreads(entries), [entries]);

  const rows = useMemo(() => {
    const kept = groups.filter((g) => promptMatches(g.prompt, query));
    kept.sort((a, b) => {
      const diff = compare(a, b, sort.key);
      return sort.dir === 'asc' ? diff : -diff;
    });
    return kept;
  }, [groups, sort, query]);

  const searchable = useMemo(() => groups.filter((g) => g.prompt).length, [groups]);

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Threads</h2>
        <label className='sessions-search context-search'>
          <Search size={14} strokeWidth={1.75} aria-hidden />
          <input
            type='search'
            value={query}
            placeholder='Search what was asked'
            aria-label='Search threads by opening prompt'
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className='muted'>
          {query.trim()
            ? `${fmtInt(rows.length)} of ${fmtInt(groups.length)} · searching ${fmtInt(searchable)} recorded prompt${searchable === 1 ? '' : 's'}`
            : 'one row per thread, showing its largest request · click it to see every request it sent'}
        </span>
      </div>
      <div className='table-scroll'>
        <table className={isSorting ? 'table is-stale' : 'table'} aria-busy={isSorting || undefined}>
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
            {rows.map((group) => (
              <ThreadRow key={group.key} group={group} query={query} days={days} max={max} peakOf={maxRealInput} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className='empty'>
                  No thread's opening prompt matches “{query.trim()}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * One thread, on one row. Its numbers are the thread's largest request — the row
 * stands in for every request it sent, and the peak is the one worth drilling
 * into. A thread-less request has no thread page, so it links to its own
 * breakdown instead.
 */
function ThreadRow({
  group,
  query,
  days,
  max,
  peakOf,
}: {
  group: ContextThreadGroup;
  query: string;
  days: number;
  max: number;
  peakOf: number;
}) {
  const count = group.entries.length;
  const title = group.prompt ? promptExcerpt(group.prompt, query) : 'No opening prompt recorded';
  return (
    <tr>
      <td style={COLUMN.thread}>
        {group.threadId ? (
          <Link
            to='/context/thread/$threadId'
            params={{ threadId: group.threadId }}
            search={{ days }}
            className='thread-link'>
            <span className='thread-title' title={group.prompt ?? undefined}>
              {title}
            </span>
            <span className='thread-sub'>
              <span className='thread-id'>{group.threadId.slice(-8)}</span>
              {fmtInt(count)} request{count === 1 ? '' : 's'}
            </span>
          </Link>
        ) : (
          <Link to='/context/$file' params={{ file: group.peak.file }} className='thread-link'>
            <span className='thread-title'>{title}</span>
            <span className='thread-sub'>no thread recorded · 1 request</span>
          </Link>
        )}
      </td>
      <td style={COLUMN.when}>
        <span className='thread-when'>{fmtLocalTs(group.firstTimestamp)}</span>
        {count > 1 && <span className='thread-sub'>→ {fmtLocalTs(group.lastTimestamp)}</span>}
      </td>
      <td className='muted' style={COLUMN.model}>
        {group.models.length === 1 ? group.models[0] : `${group.models.length} models`}
      </td>
      <td className='num' style={COLUMN.num}>
        {fmtInt(group.peak.realInput)}
        {group.peak.realInput === peakOf && <span className='muted'> · peak</span>}
      </td>
      <td className='num' style={COLUMN.num}>
        {fmtBytes(group.peak.systemBytes)}
      </td>
      <td className='num' style={COLUMN.num}>
        {fmtBytes(group.peak.toolsBytes)}
      </td>
      <td className='bar-col' style={COLUMN.bar}>
        <div className='rowbar' style={{ width: `${(group.peak.realInput / max) * 100}%` }} />
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
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
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
