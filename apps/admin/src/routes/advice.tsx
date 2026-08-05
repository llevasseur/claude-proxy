import type { SessionBucket, SuggestionStatusRow } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { getSessionSuggestions, getSuggestionStatus, getSummary } from '../api';
import { AdviceCard } from '../components/AdviceCard';
import { QueryState } from '../components/QueryState';
import { Skeleton, SkeletonCardList } from '../components/Skeleton';
import {
  BucketJudgementBadge,
  isResolved,
  isSettled,
  RECURRENCE_LABEL,
  STATUS_LABEL,
  SUGGESTION_STATUS_KEY,
} from '../components/SuggestionStatus';
import { fmtInt, fmtLocalTsShort } from '../format';

export function AdvicePage() {
  const query = useQuery({ queryKey: ['summary'], queryFn: () => getSummary() });
  const advice = query.data?.advice ?? [];

  return (
    <section>
      <div className='pagehead'>
        <h1>Advice</h1>
        <div className='muted'>{query.data?.digest.date} · deterministic coaching from today's digest</div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<SkeletonCardList count={3} lines={3} />}>
        <div className='advice-list wide'>
          {advice.map((a) => (
            <AdviceCard key={a.id} advice={a} />
          ))}
        </div>
      </QueryState>

      <SessionSuggestions />
    </section>
  );
}

/**
 * Session suggestions, ten transcripts at a time. The whole history is recomputed
 * server-side on every load, so this list backfills itself — a window that gains
 * its tenth session simply appears with the next fetch.
 */
function SessionSuggestions() {
  const query = useQuery({ queryKey: ['session-suggestions'], queryFn: getSessionSuggestions });
  // Every bucket's flags in one lean call. Marking happens on the detail page.
  const statusQuery = useQuery({ queryKey: [SUGGESTION_STATUS_KEY, 'all'], queryFn: () => getSuggestionStatus() });
  const buckets = query.data?.buckets ?? [];
  const statusByKey = new Map((statusQuery.data?.rows ?? []).map((row) => [`${row.bucket}:${row.id}`, row] as const));
  const counts = statusQuery.data?.meta.counts;
  const resolved = (counts?.done ?? 0) + (counts?.skipped ?? 0) + (counts?.dismissed ?? 0);
  const regressed = statusQuery.data?.meta.recurrences.regressed ?? 0;
  const dirty = statusQuery.data?.meta.bucketStates.dirty ?? 0;

  return (
    <>
      <div className='card-head'>
        <h2>Session suggestions</h2>
        <span className='muted'>
          {query.data ? `${fmtInt(query.data.meta.sessions)} sessions in ${query.data.meta.buckets} windows of 10` : ''}
          {resolved > 0 &&
            ` · ${counts?.done ?? 0} done · ${counts?.skipped ?? 0} skipped · ${counts?.dismissed ?? 0} dismissed`}
        </span>
        {dirty > 0 && (
          <span className='badge bucket-dirty' title='complete windows no agent has adjudicated yet'>
            {dirty} unjudged
          </span>
        )}
        {regressed > 0 && (
          <span className='badge recurrence-regressed' title='marked done, still tripping in windows recorded since'>
            {regressed} regressed
          </span>
        )}
        {statusQuery.error && <span className='error'>flags unavailable: {(statusQuery.error as Error).message}</span>}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<BucketListSkeleton />}>
        {buckets.length === 0 ? (
          <div className='card empty'>No session transcripts yet.</div>
        ) : (
          <div className='bucket-list'>
            {buckets.map((b) => (
              <BucketRow key={b.index} bucket={b} statusByKey={statusByKey} />
            ))}
          </div>
        )}
      </QueryState>
    </>
  );
}

/** Bucket rows at the shape `BucketRow` fills: a head, its suggestions, then the stats line. */
function BucketListSkeleton({ rows = 4, suggestions = 3 }: { rows?: number; suggestions?: number }) {
  return (
    <div className='bucket-list' aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length run of identical loading placeholders — the index is all that distinguishes them
        <div className='card bucket-row' key={i}>
          <div className='bucket-row-head'>
            <span className='bucket-label'>
              <Skeleton w='8rem' />
            </span>
            <Skeleton w='3rem' />
            <span className='muted bucket-range'>
              <Skeleton w='12rem' />
            </span>
          </div>
          <ul className='bucket-suggestions'>
            {Array.from({ length: suggestions }, (_, s) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length run of identical loading placeholders — the index is all that distinguishes them
              <li key={s}>
                <Skeleton w={`${64 - s * 8}%`} />
              </li>
            ))}
          </ul>
          <div className='bucket-stats muted'>
            <Skeleton w='58%' />
          </div>
        </div>
      ))}
    </div>
  );
}

const SEV_LABEL = { high: 'High', warn: 'Warn', info: 'Info' } as const;

function BucketRow({ bucket, statusByKey }: { bucket: SessionBucket; statusByKey: Map<string, SuggestionStatusRow> }) {
  const worst = bucket.suggestions[0];
  const rowOf = (id: string): SuggestionStatusRow | undefined => statusByKey.get(`${bucket.index}:${id}`);
  // Open counts what is still actionable, so a window predating its rule's fix isn't open.
  const open = bucket.suggestions.filter((s) => !isSettled(rowOf(s.id))).length;
  // Judged-ness is a fact about the bucket, so any of its rows carries it; until the
  // flags land, incompleteness is all the bucket alone can say.
  const state =
    bucket.suggestions.map((s) => rowOf(s.id)).find((r) => r)?.bucketState ??
    (bucket.complete ? undefined : 'not-ready');
  return (
    <Link to='/advice/sessions/$bucket' params={{ bucket: String(bucket.index) }} className='card bucket-row'>
      <div className='bucket-row-head'>
        <span className='bucket-label'>Sessions {bucket.label}</span>
        {worst && <span className={`badge sev-${worst.severity}`}>{SEV_LABEL[worst.severity]}</span>}
        {state && <BucketJudgementBadge state={state} />}
        <span className='muted bucket-range'>
          {fmtLocalTsShort(bucket.startedFirst ?? '')} → {fmtLocalTsShort(bucket.startedLast ?? '')}
        </span>
      </div>
      <ul className='bucket-suggestions'>
        {bucket.suggestions.map((s) => {
          const row = rowOf(s.id);
          const status = row?.status ?? 'pending';
          const recurrence = row?.recurrence ?? 'none';
          return (
            <li
              key={s.id}
              className={[isSettled(row) ? 'is-resolved' : '', recurrence === 'regressed' ? 'is-regressed' : '']
                .filter(Boolean)
                .join(' ')}>
              <span className={`dot sev-${s.severity}`} aria-hidden />
              {s.title}
              {isResolved(status) && <span className='suggestion-flag'>{STATUS_LABEL[status].toLowerCase()}</span>}
              {recurrence !== 'none' && (
                <span className='suggestion-flag'>{RECURRENCE_LABEL[recurrence].toLowerCase()}</span>
              )}
            </li>
          );
        })}
      </ul>
      <div className='bucket-stats muted'>
        {fmtInt(bucket.stats.tasks)} tasks · {fmtInt(bucket.stats.tools)} tool calls · {fmtInt(bucket.stats.errors)}{' '}
        errors · {bucket.stats.toolsPerTask}/task
        {bucket.suggestions.length > 0 && ` · ${open}/${bucket.suggestions.length} open`}
      </div>
    </Link>
  );
}
