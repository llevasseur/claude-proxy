import {
  type ContextEntry,
  type ContextThreadGroup,
  groupContextThreads,
  promptExcerpt,
  promptMatches,
} from '@claude-proxy/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
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
  // Scaled by the whole window, so filtering doesn't re-scale the bars.
  const max = Math.max(1, ...entries.map((e) => e.realInput));

  const sorted = useMemo(() => {
    const rows = entries.filter((e) => promptMatches(e.prompt, query));
    rows.sort((a, b) => {
      const diff = compare(a, b, sort.key);
      return sort.dir === 'asc' ? diff : -diff;
    });
    return rows;
  }, [entries, sort, query]);

  // Grouped after sorting, so the sort still decides which thread leads.
  const groups = useMemo(() => groupContextThreads(sorted), [sorted]);
  const searching = query.trim() !== '';
  // Only a thread the reader opened or closed appears here; the rest follow the default.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const isOpen = (group: ContextThreadGroup) => opened[group.key] ?? (searching || group.entries.length === 1);
  const toggle = (key: string, open: boolean) => setOpened((prev) => ({ ...prev, [key]: !open }));

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
            : 'one heading per thread · click it to see that thread’s requests'}
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
          {groups.map((group) =>
            group.threadId === null ? (
              <RequestRow key={group.key} entry={group.entries[0]!} max={max} maxRealInput={maxRealInput} />
            ) : (
              <Fragment key={group.key}>
                <ThreadHead
                  group={group}
                  query={query}
                  open={isOpen(group)}
                  onToggle={toggle}
                  maxRealInput={maxRealInput}
                />
                {isOpen(group) &&
                  group.entries.map((e) => (
                    <RequestRow key={e.file} entry={e} max={max} maxRealInput={maxRealInput} grouped />
                  ))}
              </Fragment>
            ),
          )}
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

/**
 * The heading a thread's requests sit under. It carries what they all share — the
 * opening prompt, the thread id, the span and peak — so the rows below never repeat
 * it, and a collapsed thread still names itself.
 */
function ThreadHead({
  group,
  query,
  open,
  onToggle,
  maxRealInput,
}: {
  group: ContextThreadGroup;
  query: string;
  open: boolean;
  onToggle: (key: string, open: boolean) => void;
  maxRealInput: number;
}) {
  const count = group.entries.length;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <tr className='thread-run'>
      <td colSpan={6}>
        <button type='button' className='thread-head' aria-expanded={open} onClick={() => onToggle(group.key, open)}>
          <Chevron size={14} strokeWidth={1.75} aria-hidden />
          <span className='thread-title' title={group.prompt ?? undefined}>
            {group.prompt ? promptExcerpt(group.prompt, query) : 'No opening prompt recorded'}
          </span>
          <span className='thread-meta'>
            {group.threadId && <span className='thread-id'>{group.threadId.slice(-8)}</span>}
            {fmtInt(count)} request{count === 1 ? '' : 's'} · {fmtLocalTs(group.firstTimestamp)}
            {count > 1 && ` → ${fmtLocalTs(group.lastTimestamp)}`}
            {group.peakRealInput === maxRealInput && ' · peak'}
          </span>
        </button>
      </td>
    </tr>
  );
}

/** One request. `grouped` indents it under the thread heading it belongs to. */
function RequestRow({
  entry,
  max,
  maxRealInput,
  grouped,
}: {
  entry: ContextEntry;
  max: number;
  maxRealInput: number;
  grouped?: boolean;
}) {
  return (
    <tr className={grouped ? 'thread-child' : undefined}>
      <td>
        <Link to='/context/$file' params={{ file: entry.file }} className='link'>
          {fmtLocalTs(entry.timestamp)}
          {entry.realInput === maxRealInput && <span className='muted'> · peak</span>}
        </Link>
      </td>
      <td className='muted'>{entry.model}</td>
      <td className='num'>{fmtInt(entry.realInput)}</td>
      <td className='num'>{fmtBytes(entry.systemBytes)}</td>
      <td className='num'>{fmtBytes(entry.toolsBytes)}</td>
      <td className='bar-col'>
        <div className='rowbar' style={{ width: `${(entry.realInput / max) * 100}%` }} />
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
