import { type ContextEntry, promptExcerpt, promptMatches } from '@claude-proxy/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getContext } from '../api';
import { QueryState } from '../components/QueryState';
import { DAY_WINDOWS, Segmented } from '../components/Segmented';
import { Skeleton, type SkeletonColumn, SkeletonStats, SkeletonTable } from '../components/Skeleton';
import { StatCard } from '../components/StatCard';
import { fmtBytes, fmtInt, fmtLocalTs, LOCAL_TZ_ABBR } from '../format';
import { useTransitionState } from '../useTransitionState';

/** When, model, three numeric columns, then the size bar. */
const REQUEST_COLUMNS: readonly SkeletonColumn[] = [
  { cell: '70%' },
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

            <RequestsTable entries={summary.entries} maxRealInput={summary.maxRealInput} />
          </>
        )}
      </QueryState>
    </section>
  );
}

/** The caption, four stat tiles, and the requests table, all at their loaded size. */
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
        <SkeletonTable columns={REQUEST_COLUMNS} rows={12} />
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

/** Signed comparison for a column, ascending. The Size bar is drawn from
 * realInput, so it sorts on the same underlying value. */
function compare(a: ContextEntry, b: ContextEntry, key: SortKey): number {
  switch (key) {
    case 'when':
      return a.timestamp.localeCompare(b.timestamp);
    case 'model':
      return a.model.localeCompare(b.model);
    case 'systemBytes':
      return a.systemBytes - b.systemBytes;
    case 'toolsBytes':
      return a.toolsBytes - b.toolsBytes;
    default:
      return a.realInput - b.realInput;
  }
}

function RequestsTable({ entries, maxRealInput }: { entries: ContextEntry[]; maxRealInput: number }) {
  const [sort, setSort, isSorting] = useTransitionState<{ key: SortKey; dir: SortDir }>({
    key: 'when',
    dir: 'desc',
  });
  const [query, setQuery] = useState('');
  // The bar is scaled by the whole window, so filtering doesn't silently re-scale it.
  const max = Math.max(1, ...entries.map((e) => e.realInput));

  const sorted = useMemo(() => {
    const rows = entries.filter((e) => promptMatches(e.prompt, query));
    rows.sort((a, b) => {
      const diff = compare(a, b, sort.key);
      return sort.dir === 'asc' ? diff : -diff;
    });
    return rows;
  }, [entries, sort, query]);

  // Only requests whose thread recorded an opening prompt can be searched at all.
  const searchable = useMemo(() => entries.filter((e) => e.prompt).length, [entries]);

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Requests</h2>
        <label className='sessions-search context-search'>
          <Search size={14} strokeWidth={1.75} aria-hidden />
          <input
            type='search'
            value={query}
            placeholder='Search what was asked'
            aria-label='Search requests by opening prompt'
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className='muted'>
          {query.trim()
            ? `${fmtInt(sorted.length)} of ${fmtInt(entries.length)} · searching ${fmtInt(searchable)} recorded prompt${searchable === 1 ? '' : 's'}`
            : 'click a column to sort · click a row for the breakdown'}
        </span>
      </div>
      <table className={isSorting ? 'table is-stale' : 'table'} aria-busy={isSorting || undefined}>
        <thead>
          <tr>
            <SortHeader label={`When (${LOCAL_TZ_ABBR})`} sortKey='when' sort={sort} onSort={onSort} />
            <SortHeader label='Model' sortKey='model' sort={sort} onSort={onSort} />
            <SortHeader label='Real input' sortKey='realInput' sort={sort} onSort={onSort} className='num' />
            <SortHeader label='System' sortKey='systemBytes' sort={sort} onSort={onSort} className='num' />
            <SortHeader label='Tools' sortKey='toolsBytes' sort={sort} onSort={onSort} className='num' />
            <SortHeader label='Size' sortKey='size' sort={sort} onSort={onSort} className='bar-col' />
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => (
            <tr key={e.file}>
              <td>
                <Link to='/context/$file' params={{ file: e.file }} className='link'>
                  {fmtLocalTs(e.timestamp)}
                  {e.realInput === maxRealInput && <span className='muted'> · peak</span>}
                </Link>
                {e.prompt && (
                  // The excerpt follows the match, so a hit shows the words that found it.
                  <div className='muted context-prompt' title={e.prompt}>
                    {promptExcerpt(e.prompt, query)}
                  </div>
                )}
              </td>
              <td className='muted'>{e.model}</td>
              <td className='num'>{fmtInt(e.realInput)}</td>
              <td className='num'>{fmtBytes(e.systemBytes)}</td>
              <td className='num'>{fmtBytes(e.toolsBytes)}</td>
              <td className='bar-col'>
                <div className='rowbar' style={{ width: `${(e.realInput / max) * 100}%` }} />
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={6} className='empty'>
                No request's opening prompt matches “{query.trim()}”.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={['sortable', className].filter(Boolean).join(' ')}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(sortKey)}>
      {label}
      {active && <span className='sort-arrow'>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}
