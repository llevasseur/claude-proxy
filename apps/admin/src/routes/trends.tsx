import { blendRate, isPartialDay, type UsageDigest } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { getSummary, type SummaryResponse } from '../api';
import { DayWindowControls, useWindowDigests } from '../components/DayWindow';
import { QueryState } from '../components/QueryState';
import { type SkeletonColumn, SkeletonTableCard } from '../components/Skeleton';
import { TrendCarousel, TrendCarouselSkeleton } from '../components/TrendCarousel';
import { METRICS, REPORT_TZ_ABBR, type StatMetric } from '../metrics';
import { useLiveQuery } from '../useLiveQuery';
import { useTransitionState } from '../useTransitionState';

/** Metric, its blended value, what that value is per, and the days behind it. */
const BLENDED_COLUMNS: readonly SkeletonColumn[] = [{}, { className: 'num' }, {}, { className: 'num' }];

/**
 * Every statistic per day, blended across the window. Today is in the window
 * while it is still being written to: the blend is `Σ num / Σ den`, so a day
 * carries the weight of its own volume and a part-day is not a whole day's vote.
 * That is what keeps the figure live rather than a day behind.
 */
export function TrendsPage() {
  const [days, selectDays, isSwitching] = useTransitionState(30);
  // The same summary feed the Overview's badge reports on: it keeps the window's
  // closing day moving rather than frozen at page load.
  const summary = useQuery({ queryKey: ['summary'], queryFn: () => getSummary() });
  const summaryLive = useLiveQuery<SummaryResponse>('/api/summary/stream', ['summary']);
  // Same key and window as the Overview's mini charts, so switching between the
  // two pages costs no fetch.
  const query = useWindowDigests(days, summary.data?.digest);
  const snapshots = query.digests;
  const busy = isSwitching || query.isFetching;

  const first = snapshots.at(0);
  const last = snapshots.at(-1);
  const range = !first || !last ? '—' : first.date === last.date ? first.date : `${first.date} → ${last.date}`;
  const live = !!last && isPartialDay(last.date);

  return (
    <section>
      <div className='pagehead'>
        <div className='pagehead-title'>
          <h1>Trends</h1>
          <div className='muted'>
            Every statistic day by day, blended across the window — a rate weighted by volume rather than one day
            counting as much as the next.{' '}
            {live ? 'Today counts as far as it has run, so the figures track the day as it happens.' : ''}
          </div>
        </div>
        <DayWindowControls days={days} onDays={selectDays} label='Trend window' busy={busy} live={summaryLive} />
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<TrendsSkeleton days={days} />} busy={busy}>
        {snapshots.length === 0 ? (
          <div className='card empty'>Nothing was captured in the last {days} days.</div>
        ) : (
          <>
            <TrendCarousel metrics={METRICS} digests={snapshots} />
            <BlendedTable digests={snapshots} range={range} live={live} />
          </>
        )}
      </QueryState>
    </section>
  );
}

/** Every metric's blended figure at once, for the comparison the carousel cannot show. */
function BlendedTable({ digests, range, live }: { digests: UsageDigest[]; range: string; live: boolean }) {
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>All trends, blended</h2>
        {/* The closing date is today when the window runs to it, and today is
            only as long as it has got so far — said here so the range is not
            read as a run of whole days. */}
        <span className='range'>
          {range} ({REPORT_TZ_ABBR}){live ? ', today so far' : ''}
        </span>
      </div>
      <table className='table'>
        <thead>
          <tr>
            <th>Metric</th>
            <th className='num'>Blended</th>
            <th>Per</th>
            <th className='num'>Days</th>
          </tr>
        </thead>
        <tbody>
          {METRICS.map((m) => (
            <BlendedRow key={m.key} def={m} digests={digests} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlendedRow({ def, digests }: { def: StatMetric; digests: UsageDigest[] }) {
  const blended = blendRate(digests, def.blend.num, def.blend.den);
  return (
    <tr>
      <td>
        <Link to='/trends/$metric' params={{ metric: def.key }} className='link'>
          {def.label}
        </Link>
      </td>
      <td className='num'>{blended ? def.format(blended.value) : '—'}</td>
      <td className='muted'>{def.blend.unit}</td>
      {/* Days that carried a denominator, not days in the window. */}
      <td className='num'>{blended?.days ?? 0}</td>
    </tr>
  );
}

/** Everything the loaded page puts in this slot, at the size it will land at. */
function TrendsSkeleton({ days }: { days: number }) {
  return (
    <>
      <TrendCarouselSkeleton metrics={METRICS} days={days} />
      <SkeletonTableCard title='All trends, blended' columns={BLENDED_COLUMNS} rows={METRICS.length} />
    </>
  );
}
