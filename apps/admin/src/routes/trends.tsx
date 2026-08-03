import { blendRate, endOfDaySnapshots, type UsageDigest } from '@claude-proxy/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { getTrends } from '../api';
import { QueryState } from '../components/QueryState';
import { DAY_WINDOWS, Segmented } from '../components/Segmented';
import { type SkeletonColumn, SkeletonTableCard } from '../components/Skeleton';
import { TrendCarousel, TrendCarouselSkeleton } from '../components/TrendCarousel';
import { METRICS, REPORT_TZ_ABBR, type StatMetric } from '../metrics';
import { useTransitionState } from '../useTransitionState';

/** Metric, its blended value, what that value is per, and the days behind it. */
const BLENDED_COLUMNS: readonly SkeletonColumn[] = [{}, { className: 'num' }, {}, { className: 'num' }];

/**
 * Every statistic as of the close of each day, blended across the window.
 *
 * The Overview answers "how is today going"; this page answers "what has the
 * rate settled at", which is a different question and needs the current day
 * left out — a day still being written to is a part-day figure and would drag
 * every number on the page down against the finished days beside it.
 */
export function TrendsPage() {
  const [days, selectDays, isSwitching] = useTransitionState(30);
  // Same key and window as the Overview's mini charts, so switching between the
  // two pages costs no fetch.
  const query = useQuery({
    queryKey: ['trends', days],
    queryFn: () => getTrends(days),
    placeholderData: keepPreviousData,
  });
  const digests = query.data?.digests ?? [];
  const snapshots = useMemo(() => endOfDaySnapshots(digests), [digests]);
  const busy = isSwitching || query.isFetching;

  const first = snapshots.at(0);
  const last = snapshots.at(-1);
  const range = !first || !last ? '—' : first.date === last.date ? first.date : `${first.date} → ${last.date}`;

  return (
    <section>
      <div className='pagehead'>
        <div>
          <h1>Trends</h1>
          <div className='muted'>
            Every statistic at the close of each day, blended across the window — a rate weighted by volume rather than
            one day counting as much as the next. Today is still open and is left out.
          </div>
        </div>
        {/* The wrapper is what keeps the switcher off the description: `.pagehead`
            is a flex row, and a bare control shrinks until its last pill clips. */}
        <div className='pagehead-controls'>
          <Segmented options={DAY_WINDOWS} value={days} onSelect={selectDays} label='Trend window' busy={busy} />
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<TrendsSkeleton days={days} />} busy={busy}>
        {snapshots.length === 0 ? (
          <div className='card empty'>No day has closed in the last {days} days.</div>
        ) : (
          <>
            <TrendCarousel metrics={METRICS} digests={snapshots} />
            <BlendedTable digests={snapshots} range={range} />
          </>
        )}
      </QueryState>
    </section>
  );
}

/** Every metric's blended figure at once, for the comparison the carousel cannot show. */
function BlendedTable({ digests, range }: { digests: UsageDigest[]; range: string }) {
  return (
    <div className='card'>
      <div className='card-head'>
        <h2>All trends, blended</h2>
        <span className='range'>
          {range} ({REPORT_TZ_ABBR})
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
      {/* Days that carried a denominator, not days in the window — an idle day
          has no rate to contribute and is not counted as one. */}
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
