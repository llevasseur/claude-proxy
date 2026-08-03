import type {
  BreakdownPattern,
  BucketBreakdownSummary,
  SessionSuggestion,
  SuggestionStatusRow,
} from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { getSessionSuggestionBucket, getSuggestionStatus, type SessionSummary } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { QueryState } from '../components/QueryState';
import {
  Skeleton,
  SkeletonCardList,
  type SkeletonColumn,
  SkeletonStats,
  SkeletonTable,
  SkeletonTableCard,
  SkeletonText,
} from '../components/Skeleton';
import {
  isSettled,
  SUGGESTION_STATUS_KEY,
  SuggestionRecurrenceBadge,
  SuggestionStatusBadge,
  SuggestionStatusControl,
} from '../components/SuggestionStatus';
import { fmtBytes, fmtInt, fmtLocalTsShort, fmtPct } from '../format';
import { useTransitionState } from '../useTransitionState';

const SEV_LABEL = { high: 'High', warn: 'Warn', info: 'Info' } as const;

/**
 * One ten-session window in full: what the transcripts suggest, and the Request
 * Breakdown patterns those sessions share. Each suggestion names the sessions it
 * was counted in, so every claim on this page is traceable to a transcript.
 */
export function SuggestionBucketPage() {
  const { bucket: param } = useParams({ from: '/advice/sessions/$bucket' });
  const index = Number(param);
  const query = useQuery({
    queryKey: ['suggestion-bucket', index],
    queryFn: () => getSessionSuggestionBucket(index),
    enabled: Number.isInteger(index) && index >= 1,
  });
  // The flags for this window only, separate from the drill-down: a write
  // re-reads this and nothing else.
  const statusQuery = useQuery({
    queryKey: [SUGGESTION_STATUS_KEY, index],
    queryFn: () => getSuggestionStatus({ range: String(index) }),
    enabled: Number.isInteger(index) && index >= 1,
  });
  const [hideResolved, setHideResolved, isFiltering] = useTransitionState(false);
  const data = query.data;
  const statusById = new Map((statusQuery.data?.rows ?? []).map((row) => [row.id, row]));
  const counts = statusQuery.data?.meta.counts;
  const recurrences = statusQuery.data?.meta.recurrences;
  const regressed = recurrences?.regressed ?? 0;
  // "Resolved" counts settled rows: acted on, or a window its rule's fix predates.
  const resolvedCount = (statusQuery.data?.rows ?? []).filter((row) => isSettled(row)).length;
  const suggestions = (data?.bucket.suggestions ?? []).filter((s) => !hideResolved || !isSettled(statusById.get(s.id)));

  return (
    <section>
      <Breadcrumbs>
        <Link to='/advice' className='link'>
          Advice
        </Link>
        <span className='crumb-current'>Sessions {data?.bucket.label ?? param}</span>
      </Breadcrumbs>
      <div className='pagehead'>
        <h1>Sessions {data?.bucket.label ?? param}</h1>
        {data && (
          <span className='muted'>
            {fmtLocalTsShort(data.bucket.startedFirst ?? '')} → {fmtLocalTsShort(data.bucket.startedLast ?? '')}
          </span>
        )}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<BucketSkeleton />}>
        {data && (
          <>
            <div className='grid stats'>
              <StatTile label='Sessions' value={fmtInt(data.bucket.stats.sessions)} />
              <StatTile
                label='Tasks'
                value={fmtInt(data.bucket.stats.tasks)}
                sub={`${data.bucket.stats.unfinishedTasks} unfinished`}
              />
              <StatTile
                label='Tool calls'
                value={fmtInt(data.bucket.stats.tools)}
                sub={`${data.bucket.stats.toolsPerTask}/task`}
              />
              <StatTile
                label='Errors'
                value={fmtInt(data.bucket.stats.errors)}
                sub={`${fmtPct(data.bucket.stats.discoveryRatio * 100)} discovery`}
              />
            </div>

            <div className='card-head suggestions-head'>
              <h2>Suggestions</h2>
              <span className='muted'>
                from these {data.bucket.stats.sessions} transcripts
                {resolvedCount > 0 && ` · ${counts?.done ?? 0} done · ${counts?.skipped ?? 0} skipped`}
                {(recurrences?.historical ?? 0) > 0 && ` · ${recurrences?.historical} predating the fix`}
              </span>
              {regressed > 0 && (
                <span
                  className='badge recurrence-regressed'
                  title='these sessions were all recorded after the rule was marked done'>
                  {regressed} regressed
                </span>
              )}
              {statusQuery.error && (
                <span className='error'>flags unavailable: {(statusQuery.error as Error).message}</span>
              )}
              {resolvedCount > 0 && (
                <button type='button' className='link toggle-resolved' onClick={() => setHideResolved((v) => !v)}>
                  {hideResolved ? `Show resolved (${resolvedCount})` : 'Hide resolved'}
                </button>
              )}
            </div>
            <div className={isFiltering ? 'advice-list wide is-stale' : 'advice-list wide'}>
              {suggestions.map((s) => (
                <SuggestionCard key={s.id} suggestion={s} bucket={index} status={statusById.get(s.id)} />
              ))}
              {suggestions.length === 0 && data.bucket.suggestions.length > 0 && (
                <div className='card empty'>Nothing left to act on in this window.</div>
              )}
            </div>

            {data.breakdownSuggestions.length > 0 && (
              <>
                <div className='card-head'>
                  <h2>From the request breakdowns</h2>
                  <span className='muted'>what these sessions actually sent</span>
                </div>
                <div className='advice-list wide'>
                  {data.breakdownSuggestions.map((s) => (
                    <SuggestionCard key={s.id} suggestion={s} />
                  ))}
                </div>
              </>
            )}

            <BreakdownPatterns summary={data.breakdown} missing={data.meta.requestsMissing} />
            <SessionTable sessions={data.sessions} />
          </>
        )}
      </QueryState>
    </section>
  );
}

/** Region or tool, four numeric columns, then the share bar. */
const PATTERN_COLUMNS: readonly SkeletonColumn[] = [
  { cell: '58%' },
  { className: 'num' },
  { className: 'num' },
  { className: 'num' },
  { className: 'num' },
  { className: 'bar-col' },
];

/** Session, when it started, then its three counts. */
const SESSION_COLUMNS: readonly SkeletonColumn[] = [
  { cell: '64%' },
  { cell: '48%' },
  { className: 'num' },
  { className: 'num' },
  { className: 'num' },
];

/**
 * A window's four stat tiles, its suggestions, the breakdown patterns, and the ten
 * sessions it covers — a bucket is always ten.
 */
function BucketSkeleton() {
  return (
    <>
      <SkeletonStats count={4} />
      <div className='card-head' aria-hidden>
        <Skeleton w='18%' h='0.95em' />
        <Skeleton w='30%' />
      </div>
      <SkeletonCardList count={3} lines={3} />
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='36%' h='0.95em' />
          <Skeleton w='28%' />
        </div>
        <SkeletonText lines={2} />
        <SkeletonTable columns={PATTERN_COLUMNS} rows={6} />
      </div>
      <SkeletonTableCard title='Sessions in this window' columns={SESSION_COLUMNS} rows={10} />
    </>
  );
}

/**
 * One suggestion, with its flag when it can carry one. Only the transcript rules
 * are flaggable — breakdown-derived suggestions are computed per request, not per
 * bucket, so the status store has no row for them.
 */
function SuggestionCard({
  suggestion: s,
  bucket,
  status,
}: {
  suggestion: SessionSuggestion;
  bucket?: number;
  status?: SuggestionStatusRow;
}) {
  const settled = isSettled(status);
  const regressed = status?.recurrence === 'regressed';
  return (
    <div className={`card advice sev-${s.severity}${settled ? ' is-resolved' : ''}${regressed ? ' is-regressed' : ''}`}>
      <div className='advice-head'>
        <span className={`badge sev-${s.severity}`}>{SEV_LABEL[s.severity]}</span>
        <h3>{s.title}</h3>
        {status && <SuggestionStatusBadge status={status.status} />}
        {status && <SuggestionRecurrenceBadge row={status} />}
      </div>
      <p>{s.detail}</p>
      <div className='advice-metric muted'>evidence: {s.evidence}</div>
      {s.sources.length > 0 && (
        <div className='suggestion-sources'>
          <span className='suggestion-sources-label'>Seen in</span>
          <ul>
            {s.sources.map((src) => (
              <li key={src.threadId}>
                <Link to='/sessions/$id' params={{ id: src.threadId }} className='link'>
                  {src.label}
                </Link>
                {src.nodeIndexes.length > 0 && (
                  <span className='muted'>
                    {' '}
                    · {src.nodeIndexes.length} step{src.nodeIndexes.length === 1 ? '' : 's'}
                  </span>
                )}
                {src.sample && <div className='suggestion-sample'>{src.sample}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {bucket !== undefined && <SuggestionStatusControl bucket={bucket} id={s.id} row={status} />}
    </div>
  );
}

/** Regions and tool schemas that recur across the bucket's peak requests. */
function BreakdownPatterns({ summary, missing }: { summary: BucketBreakdownSummary; missing: number }) {
  if (summary.requests === 0) {
    return (
      <div className='card empty'>
        No captured requests remain for these sessions — the raw bodies have aged out of the log.
      </div>
    );
  }
  const max = Math.max(1, ...summary.patterns.map((p) => p.avgBytes));

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Request breakdown patterns</h2>
        <span className='muted'>
          averaged over {summary.requests} peak request{summary.requests === 1 ? '' : 's'}
          {missing > 0 ? ` · ${missing} session${missing === 1 ? '' : 's'} without one` : ''}
        </span>
      </div>
      <p className='muted'>
        Each session contributes its largest captured request. A region carried by every one of them is a fixed cost on
        every turn these sessions took.
      </p>
      <table className='table'>
        <thead>
          <tr>
            <th>Region / tool</th>
            <th className='num'>In requests</th>
            <th className='num'>Avg bytes</th>
            <th className='num'>Avg tokens</th>
            <th className='num'>% of request</th>
            <th className='bar-col'>Share</th>
          </tr>
        </thead>
        <tbody>
          {summary.patterns.map((p) => (
            <PatternRow key={`${p.kind}:${p.name}`} pattern={p} max={max} total={summary.requests} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PatternRow({ pattern: p, max, total }: { pattern: BreakdownPattern; max: number; total: number }) {
  const everywhere = p.requests === total;
  return (
    <tr>
      <td>{p.kind === 'tool' ? <code className='md-code'>{p.name}</code> : p.name}</td>
      <td className='num'>
        {p.requests}/{total}
        {everywhere && <span className='muted'> all</span>}
      </td>
      <td className='num'>{fmtBytes(p.avgBytes)}</td>
      <td className='num'>{fmtInt(p.avgEstTokens)}</td>
      <td className='num'>{fmtPct(p.avgPctOfRequest, 1)}</td>
      <td className='bar-col'>
        <div className='rowbar' style={{ width: `${(p.avgBytes / max) * 100}%` }} />
      </td>
    </tr>
  );
}

function SessionTable({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <div className='card'>
      <h2>Sessions in this window</h2>
      <table className='table'>
        <thead>
          <tr>
            <th>Session</th>
            <th>Started</th>
            <th className='num'>Tasks</th>
            <th className='num'>Tools</th>
            <th className='num'>Errors</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.threadId}>
              <td>
                <Link to='/sessions/$id' params={{ id: s.threadId }} className='link'>
                  {s.title ?? s.subtitle ?? s.threadId}
                </Link>
              </td>
              <td>{fmtLocalTsShort(s.started ?? '')}</td>
              <td className='num'>{fmtInt(s.tasks)}</td>
              <td className='num'>{fmtInt(s.tools)}</td>
              <td className='num'>{fmtInt(s.errors)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className='card stat'>
      <div className='stat-label'>{label}</div>
      <div className='stat-value'>{value}</div>
      <div className='stat-foot'>{sub && <span className='muted'>{sub}</span>}</div>
    </div>
  );
}
