import type { ContextEntry } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useParams, useSearch } from '@tanstack/react-router';
import { type CSSProperties, useMemo } from 'react';
import { getContextThread } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { QueryState } from '../components/QueryState';
import { Skeleton, type SkeletonColumn, SkeletonStats, SkeletonTable } from '../components/Skeleton';
import { StatCard } from '../components/StatCard';
import { fmtBytes, fmtInt, fmtLocalTs, LOCAL_TZ_ABBR } from '../format';
import { rootRoute } from '../route-root';
import { useRestoredScroll } from '../useRestoredScroll';
import { contextDays } from './context';

/** When, model, three numeric columns, then the size bar. */
const REQUEST_COLUMNS: readonly SkeletonColumn[] = [
  { cell: '70%' },
  { cell: '58%' },
  { className: 'num' },
  { className: 'num' },
  { className: 'num' },
  { className: 'bar-col' },
];

/**
 * Per-column floors, as on the Context size table — every column needs one, or a
 * wrap in When squeezes its neighbours instead.
 */
const COLUMN = {
  when: { minWidth: 170 },
  model: { minWidth: 130 },
  num: { minWidth: 88 },
  bar: { minWidth: 90 },
} as const satisfies Record<string, CSSProperties>;

/** Every request one thread sent; its rows drill into each request's own breakdown. */
export function ContextThreadPage() {
  const { threadId } = useParams({ from: '/context/thread/$threadId' });
  const { days } = useSearch({ from: '/context/thread/$threadId' });
  const query = useQuery({
    queryKey: ['context-thread', threadId, days],
    queryFn: () => getContextThread(threadId, days),
  });
  const data = query.data;
  useRestoredScroll(!!data);

  return (
    <section>
      <Breadcrumbs>
        <Link to='/context' className='link'>
          Context size
        </Link>
        <span className='crumb-current'>Thread</span>
      </Breadcrumbs>
      <div className='pagehead'>
        <h1>Thread</h1>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<ThreadSkeleton />}>
        {data &&
          (data.entries.length === 0 ? (
            <div className='card empty'>
              No captured request of thread <span className='rule-name'>{threadId}</span> in the last {days} days.
            </div>
          ) : (
            <ThreadBody entries={data.entries} prompt={data.prompt} threadId={threadId} days={days} />
          ))}
      </QueryState>
    </section>
  );
}

function ThreadSkeleton() {
  return (
    <>
      <div className='card'>
        <Skeleton w='60%' />
      </div>
      <SkeletonStats count={4} />
      <div className='card'>
        <Skeleton w='30%' className='skeleton-h2' />
        <SkeletonTable columns={REQUEST_COLUMNS} rows={8} />
      </div>
    </>
  );
}

function ThreadBody({
  entries,
  prompt,
  threadId,
  days,
}: {
  entries: ContextEntry[];
  prompt: string | null;
  threadId: string;
  days: number;
}) {
  const stats = useMemo(() => {
    const realInputs = entries.map((e) => e.realInput);
    const peak = Math.max(...realInputs);
    return {
      peak,
      avg: Math.round(realInputs.reduce((n, v) => n + v, 0) / entries.length),
      first: entries[0]!.timestamp,
      last: entries[entries.length - 1]!.timestamp,
    };
  }, [entries]);

  return (
    <>
      <div className='card thread-prompt'>
        <div className='stat-label'>Opening prompt</div>
        {prompt ? <p className='thread-prompt-text'>{prompt}</p> : <p className='muted'>No opening prompt recorded.</p>}
        <div className='muted thread-prompt-foot'>
          <span className='rule-name'>{threadId}</span>
        </div>
      </div>

      <div className='grid stats'>
        <StatCard label='Requests' value={fmtInt(entries.length)} sub='captured in the window' />
        <StatCard label='Peak context' value={fmtInt(stats.peak)} sub='tokens' />
        <StatCard label='Average context' value={fmtInt(stats.avg)} sub='tokens / request' />
        <StatCard label='Span' value={fmtLocalTs(stats.first)} sub={`→ ${fmtLocalTs(stats.last)}`} />
      </div>

      <RequestsTable entries={entries} peak={stats.peak} threadId={threadId} days={days} />
    </>
  );
}

/** Every request of the thread, oldest first, each linking to its own breakdown. */
function RequestsTable({
  entries,
  peak,
  threadId,
  days,
}: {
  entries: ContextEntry[];
  peak: number;
  threadId: string;
  days: number;
}) {
  const max = Math.max(1, peak);
  return (
    <div className='card'>
      <h2>Requests</h2>
      <div className='table-scroll'>
        <table className='table'>
          <thead>
            <tr>
              <th style={COLUMN.when}>When ({LOCAL_TZ_ABBR})</th>
              <th style={COLUMN.model}>Model</th>
              <th className='num' style={COLUMN.num}>
                Real input
              </th>
              <th className='num' style={COLUMN.num}>
                System
              </th>
              <th className='num' style={COLUMN.num}>
                Tools
              </th>
              <th className='bar-col' style={COLUMN.bar}>
                Size
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.file}>
                <td style={COLUMN.when}>
                  <Link
                    to='/context/$file'
                    params={{ file: entry.file }}
                    search={{ thread: threadId, days }}
                    className='link'>
                    {fmtLocalTs(entry.timestamp)}
                  </Link>
                  {entry.realInput === peak && <span className='muted'> · peak</span>}
                </td>
                <td className='muted' style={COLUMN.model}>
                  {entry.model}
                </td>
                <td className='num' style={COLUMN.num}>
                  {fmtInt(entry.realInput)}
                </td>
                <td className='num' style={COLUMN.num}>
                  {fmtBytes(entry.systemBytes)}
                </td>
                <td className='num' style={COLUMN.num}>
                  {fmtBytes(entry.toolsBytes)}
                </td>
                <td className='bar-col' style={COLUMN.bar}>
                  <div className='rowbar' style={{ width: `${(entry.realInput / max) * 100}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** `?days=` carries the window the thread was reached from. */
export interface ContextThreadSearch {
  days: number;
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  // A static segment, so it can never be read as a `$file` drill-down.
  path: '/context/thread/$threadId',
  component: ContextThreadPage,
  staticData: { title: 'Context thread' },
  validateSearch: (search: Record<string, unknown>): ContextThreadSearch => ({ days: contextDays(search.days) }),
});
