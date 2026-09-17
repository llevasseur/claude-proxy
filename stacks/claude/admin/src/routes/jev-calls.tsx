import { useQuery } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { Radar } from 'lucide-react';
import { useState } from 'react';
import { getJevCalls, type JevCallFilter, type JevCallOutcome, type JevCallRow, type JevCallsResponse } from '../api';
import { QueryState } from '../components/QueryState';
import { SkeletonTableCard } from '../components/Skeleton';
import { fmtBytes, fmtDuration, fmtInt, fmtLocalTsShort } from '../format';
import { rootRoute } from '../route-root';
import type { NavEntry } from './nav';

/**
 * The recorded Jev traffic, and what it cost to get nothing back.
 *
 * Jev is a small fast classifier reached over HTTP, and **its client is built never to
 * throw**: every failure — a 401, a 422, a transport error that never got a status —
 * returns an empty answer map, which reaches the caller looking exactly like a result.
 * The recorded traffic is the only place those failures are visible at all, and this
 * page is what makes them visible to a person.
 *
 * So the two readings below are the page rather than decoration on it. A call that
 * asked 125 questions and got 7 answers is a **short** row with 118 unanswered, and a
 * call that failed outright is a **failed** row carrying its status or its transport
 * error — both legible from the table without opening anything.
 *
 * **Read-only, and deliberately so.** Nothing here asks Jev anything; the rows are
 * ingested from a keep a recording proxy writes outside this repository. There is no
 * control on this page that could start a call.
 */

/** The badge each outcome wears. Coral for a call that produced nothing, amber for a short one. */
const OUTCOME_BADGE = {
  failed: 'sev-high',
  empty: 'sev-high',
  partial: 'sev-warn',
  ok: 'status-done',
} as const satisfies Record<JevCallOutcome, string>;

/**
 * What each outcome is called. The label carries the distinction the colour cannot:
 * `failed` and `no answers` are both coral, and they are not the same thing — one
 * never got a usable response, the other got one carrying nothing.
 */
const OUTCOME_LABEL = {
  failed: 'failed',
  empty: 'no answers',
  partial: 'short',
  ok: 'ok',
} as const satisfies Record<JevCallOutcome, string>;

/** The rows each filter asks for, and what the tab is called. */
const FILTERS: readonly { value: JevCallFilter; label: string; hint: string }[] = [
  { value: 'all', label: 'All', hint: 'every recorded call' },
  { value: 'unanswered', label: 'Short', hint: 'fewer answers came back than questions went out' },
  { value: 'failed', label: 'Failed', hint: 'no usable response — a status, or a transport error' },
];

/**
 * A nullable count, rendered as the absence it is.
 *
 * **Never zero.** A null usage figure means the response reported no counts at all,
 * and drawing that as `0` would claim the call was free when what is actually known
 * is nothing.
 */
function Count({ value }: { value: number | null }) {
  if (value === null) return <span className='muted'>—</span>;
  return <>{fmtInt(value)}</>;
}

/**
 * What the response was, in one cell: the HTTP status, or the transport error that
 * arrived instead of one.
 */
function StatusCell({ call }: { call: JevCallRow }) {
  return (
    <>
      {call.status === null ? <span className='muted'>no response</span> : `HTTP ${call.status}`}
      {call.errorName !== null && (
        <div className='muted' style={{ fontSize: 'var(--text-3)' }}>
          {call.errorName}
          {call.errorMessage !== null && `: ${call.errorMessage}`}
        </div>
      )}
    </>
  );
}

/** The questions that got no answer, as a count that is hard to miss when there are any. */
function UnansweredCell({ call }: { call: JevCallRow }) {
  if (call.unansweredCount === 0) return <span className='muted'>—</span>;
  return (
    <span className={`badge ${call.answerCount === 0 ? 'sev-high' : 'sev-warn'}`}>{fmtInt(call.unansweredCount)}</span>
  );
}

export function JevCallsPage() {
  const [filter, setFilter] = useState<JevCallFilter>('all');
  const query = useQuery({ queryKey: ['jev-calls', filter], queryFn: () => getJevCalls(filter) });

  return (
    <section>
      <div className='pagehead'>
        <div className='pagehead-title'>
          <h1>Jev calls</h1>
          <div className='muted'>
            Recorded traffic to the classifier. Its client never throws — a failed call returns an empty answer map and
            reads as a result — so this is the only place a call that asked for answers and got none is visible.
          </div>
        </div>
      </div>

      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        busy={query.isFetching}
        skeleton={<SkeletonTableCard columns={SKELETON_COLUMNS} rows={8} />}>
        <JevCallsBody data={query.data ?? null} filter={filter} onFilter={setFilter} />
      </QueryState>
    </section>
  );
}

/** The real table's columns, so the placeholder holds the same shape. */
const SKELETON_COLUMNS = [
  { head: '40%', cell: '72%', lines: 2 },
  { head: '52%', cell: '46%' },
  { head: '58%', cell: '60%', lines: 2 },
  { className: 'num', head: '70%', cell: '38%' },
  { className: 'num', head: '70%', cell: '38%' },
  { className: 'num', head: '70%', cell: '38%' },
  { className: 'num', head: '70%', cell: '44%' },
  { className: 'num', head: '70%', cell: '44%' },
] as const;

function JevCallsBody({
  data,
  filter,
  onFilter,
}: {
  data: JevCallsResponse | null;
  filter: JevCallFilter;
  onFilter: (next: JevCallFilter) => void;
}) {
  if (!data) return null;

  // Nothing recorded on this machine is the normal state, not a failure: the keep is
  // written by a proxy in another repository that may simply never have been run here.
  if (!data.meta.substrate || data.meta.counts.total === 0) {
    return (
      <div className='card'>
        <div className='empty'>
          Nothing recorded. Calls appear here once the recording proxy has run and its keep has been ingested — a
          machine that has never run it has no rows, which is not an error.
        </div>
      </div>
    );
  }

  return (
    <>
      <Tally counts={data.meta.counts} />
      <Calls data={data} filter={filter} onFilter={onFilter} />
    </>
  );
}

/** What the whole table holds — counted server-side before any filter narrowed it. */
function Tally({ counts }: { counts: JevCallsResponse['meta']['counts'] }) {
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Recorded</h2>
        <span className='range'>{fmtInt(counts.total)} calls</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-9)' }}>
        <Figure label='Answered in full' value={fmtInt(counts.ok)} />
        <Figure label='Short' value={fmtInt(counts.partial)} />
        <Figure label='No answers' value={fmtInt(counts.empty)} />
        <Figure label='Failed' value={fmtInt(counts.failed)} />
        <Figure label='Questions unanswered' value={fmtInt(counts.unansweredQuestions)} />
      </div>
      <p className='muted' style={{ marginBottom: 0 }}>
        <strong>Failed</strong> got no usable response — a 401, a 422, or a transport error that never got a status.{' '}
        <strong>No answers</strong> did get a response, and it carried nothing. <strong>Short</strong> got fewer answers
        back than it asked questions. All three reach the caller as an empty or partial answer map rather than as an
        error, which is why they are counted here.
      </p>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className='stat-label'>{label}</div>
      <div className='stat-value'>{value}</div>
    </div>
  );
}

function Calls({
  data,
  filter,
  onFilter,
}: {
  data: JevCallsResponse;
  filter: JevCallFilter;
  onFilter: (next: JevCallFilter) => void;
}) {
  const active = FILTERS.find((f) => f.value === filter);
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Calls</h2>
        <span className='range'>
          {data.meta.returned === data.meta.matched
            ? `${fmtInt(data.meta.returned)} shown`
            : `${fmtInt(data.meta.returned)} of ${fmtInt(data.meta.matched)} shown`}
        </span>
        <div className='badge-row'>
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type='button'
              className='btn-quiet'
              aria-pressed={f.value === filter}
              title={f.hint}
              onClick={() => onFilter(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {active && <p className='muted'>{active.hint}.</p>}

      {data.calls.length === 0 ? (
        <div className='empty'>No call matches this filter — nothing recorded here came back short or failed.</div>
      ) : (
        <div className='table-scroll'>
          <table className='table'>
            <thead>
              <tr>
                <th>When</th>
                <th>Outcome</th>
                <th>Response</th>
                <th className='num'>Asked</th>
                <th className='num'>Answered</th>
                <th className='num'>Unanswered</th>
                <th className='num'>Took</th>
                <th className='num'>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {data.calls.map((call) => (
                <tr key={`${call.session}:${call.id}`}>
                  <td>
                    {fmtLocalTsShort(call.startedAt)}
                    <div className='muted' style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-3)' }}>
                      {call.session} · #{call.id}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${OUTCOME_BADGE[call.outcome]}`}>{OUTCOME_LABEL[call.outcome]}</span>
                    {call.model !== null && (
                      <div className='muted' style={{ fontSize: 'var(--text-3)' }}>
                        {call.model}
                      </div>
                    )}
                  </td>
                  <td>
                    <StatusCell call={call} />
                    <div className='muted' style={{ fontSize: 'var(--text-3)' }}>
                      {fmtBytes(call.responseBytes)}
                    </div>
                  </td>
                  <td className='num'>{fmtInt(call.questionCount)}</td>
                  <td className='num'>{fmtInt(call.answerCount)}</td>
                  <td className='num'>
                    <UnansweredCell call={call} />
                  </td>
                  <td className='num'>
                    {call.durationMs === null ? <span className='muted'>—</span> : fmtDuration(call.durationMs)}
                  </td>
                  <td className='num'>
                    <Count value={call.usageInputTokens} /> / <Count value={call.usageOutputTokens} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jev-calls',
  component: JevCallsPage,
  staticData: { title: 'Jev calls' },
});

export const nav = {
  section: 'Learning',
  to: '/jev-calls',
  label: 'Jev calls',
  hint: 'classifier traffic',
  exact: true,
  icon: Radar,
} as const satisfies NavEntry;
