import { apiRouteUrl, type ContextEntry } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useParams, useSearch } from '@tanstack/react-router';
import { type CSSProperties, useMemo } from 'react';
import { type ContextThreadResponse, getContextThread, getSessionsLiveness } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { LiveIndicator } from '../components/LiveIndicator';
import { QueryState } from '../components/QueryState';
import { Skeleton, type SkeletonColumn, SkeletonStats, SkeletonTable } from '../components/Skeleton';
import { StatCard } from '../components/StatCard';
import { fmtBytes, fmtInt, fmtLocalTs, LOCAL_TZ_ABBR } from '../format';
import type { JsonRecord } from '../json';
import { rootRoute } from '../route-root';
import { useLiveQuery } from '../useLiveQuery';
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

/** How long a subscription outlives the thread it follows: the verdicts' refetch window. */
const LIVENESS_POLL_MS = 15_000;

/**
 * Whether this thread can still add requests, from `/api/sessions/liveness`.
 *
 * `undefined` until the verdicts land, so neither branch is taken on a guess. **Absent
 * from the list counts as finished**, not as unknown: the list is built from the
 * transcripts under `logs/sessions/`, which holds roughly today, so every older thread is
 * absent. `quiet` and `unknown` both subscribe — neither says the conversation ended.
 *
 * Polling stops on `false`, which is terminal: a finished transcript does not resume.
 */
function useThreadRuns(threadId: string): boolean | undefined {
  const query = useQuery({
    queryKey: ['sessions-liveness'],
    queryFn: getSessionsLiveness,
    refetchInterval: (q) => {
      const state = q.state.data?.threads.find((t) => t.threadId === threadId)?.liveness.state;
      return state === undefined || state === 'finished' ? false : LIVENESS_POLL_MS;
    },
  });
  if (!query.data) return undefined;
  const state = query.data.threads.find((t) => t.threadId === threadId)?.liveness.state;
  return state !== undefined && state !== 'finished';
}

/** Every request one thread sent; its rows drill into each request's own breakdown. */
export function ContextThreadPage() {
  const { threadId } = useParams({ from: '/context/thread/$threadId' });
  const { days } = useSearch({ from: '/context/thread/$threadId' });

  // **A running thread is subscribed; a finished one is not**, so a settled transcript
  // costs no connection. When a thread finishes under a reader this flips and
  // `useLiveQuery`'s cleanup closes the `EventSource` — the client unsubscribing is what
  // ends the stream, never the server, which keeps no per-connection state and whose
  // orderly close `EventSource` could not tell from a drop.
  const runs = useThreadRuns(threadId);
  const live = useLiveQuery<ContextThreadResponse>(
    apiRouteUrl('/api/context/thread/stream', { thread: threadId, days }),
    ['context-thread', threadId, days],
    runs === true,
  );

  const query = useQuery({
    queryKey: ['context-thread', threadId, days],
    queryFn: () => getContextThread(threadId, days),
    // Held for the session while the stream is in charge, and once nothing more can arrive
    // — a finished thread's requests are an immutable answer. Otherwise the client-wide
    // window stands, the fallback `useLiveQuery` documents for a stream that never opened.
    staleTime: runs === false || live === 'live' ? Number.POSITIVE_INFINITY : undefined,
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
        {/* Only while there is a subscription to report on: with none, the badge would
            read "Connecting…" for good. */}
        {runs === true && <LiveIndicator status={live} />}
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
  validateSearch: (search: JsonRecord): ContextThreadSearch => ({ days: contextDays(search.days) }),
});
