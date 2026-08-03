import { isPartialDay, type UsageDigest } from '@claude-proxy/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { getTrends } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PromptMixPanel, PromptMixSkeleton } from '../components/PromptMixPanel';
import { QueryState } from '../components/QueryState';
import { DAY_WINDOWS, Segmented } from '../components/Segmented';
import { SeriesLineChart } from '../components/SeriesLineChart';
import { Skeleton, SkeletonChartCard, type SkeletonColumn, SkeletonTableCard } from '../components/Skeleton';
import { deltaLabel, deltaTone } from '../format';
import { findMetric, REPORT_TZ_ABBR, type StatMetric } from '../metrics';
import { useTransitionState } from '../useTransitionState';

/** The tall chart this page leads with, in px. */
const CHART_HEIGHT = 340;

/** Date and the metric's own value. */
const BY_DAY_COLUMNS: readonly SkeletonColumn[] = [{}, { className: 'num' }];

/** Large-scale trend for one Overview statistic, reached by clicking its card. */
export function TrendDetailPage() {
  const { metric } = useParams({ from: '/trends/$metric' });
  const def = findMetric(metric);
  const [days, selectDays, isSwitching] = useTransitionState(30);
  const query = useQuery({
    queryKey: ['trends', days],
    queryFn: () => getTrends(days),
    enabled: !!def,
    placeholderData: keepPreviousData,
  });
  const digests = query.data?.digests ?? [];
  const busy = isSwitching || query.isFetching;

  if (!def) {
    return (
      <section>
        <Breadcrumbs>
          <Link to='/' className='link'>
            Overview
          </Link>
          <span className='crumb-current'>Unknown</span>
        </Breadcrumbs>
        <div className='card empty'>No trend metric named “{metric}”.</div>
      </section>
    );
  }

  const rows = digests.map((d) => ({ label: d.date, value: def.value(d) }));
  const first = digests.at(0);
  const last = digests.at(-1);
  const rangeLabel = !first || !last ? '—' : first.date === last.date ? first.date : `${first.date} → ${last.date}`;
  const compare = dayOverDay(digests, def);
  const hasMix = def.key === 'avg-system-prompt';

  return (
    <section>
      <Breadcrumbs>
        <Link to='/' className='link'>
          Overview
        </Link>
        <span className='crumb-current'>{def.label}</span>
      </Breadcrumbs>

      <div className='pagehead'>
        <div>
          <h1>{def.title ?? def.label}</h1>
          <div className='muted'>{def.description}</div>
          {compare ? (
            <DayOverDay compare={compare} />
          ) : (
            // Outside the skeleton, so it holds its own line while the trend loads.
            query.isLoading && (
              <div className='trend-compare' aria-hidden>
                <Skeleton w='76%' />
              </div>
            )
          )}
        </div>
        <Segmented options={DAY_WINDOWS} value={days} onSelect={selectDays} label='Trend window' busy={busy} />
      </div>

      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        skeleton={<TrendDetailSkeleton days={days} label={def.label} mix={hasMix} />}
        busy={busy}>
        {digests.length === 0 ? (
          <div className='card empty'>No usage captured in the last {days} days.</div>
        ) : (
          <>
            {hasMix && <PromptMixPanel days={days} />}

            <div className='grid wide-two chart-lead'>
              <div className='card'>
                <div className='card-head'>
                  <h2>{def.label} / day</h2>
                  <span className='range'>{rangeLabel}</span>
                </div>
                <SeriesLineChart
                  data={rows}
                  series={[{ dataKey: 'value', name: def.label, color: def.color }]}
                  xKey='label'
                  format={def.format}
                  height={CHART_HEIGHT}
                />
              </div>

              <div className='card'>
                <h2>By day</h2>
                <table className='table'>
                  <thead>
                    <tr>
                      <th>Date ({REPORT_TZ_ABBR})</th>
                      <th className='num'>{def.label}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...rows].reverse().map((r) => (
                      <tr key={r.label}>
                        <td>{r.label}</td>
                        <td className='num'>{def.format(r.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </QueryState>
    </section>
  );
}

/** The latest day against the one before it, ready to render. */
interface DayComparison {
  date: string;
  priorDate: string;
  /** Both values already run through the metric's own formatter. */
  value: string;
  priorValue: string;
  /** null when the prior day was zero, which no percentage describes. */
  deltaPct: number | null;
  tone: 'up' | 'down' | 'flat';
  /** `delta` modifier — whether this direction reads as a win or a regression. */
  toneClass: 'good' | 'bad' | 'flat';
  /** The newest day is still running, so it is a part-day figure against a whole one. */
  partial: boolean;
}

/**
 * The last two days in the window, stated rather than left to be read off the
 * chart. Days come from the digests, not the clock — a gap in captured traffic
 * means the two most recent need not be today and yesterday, so both dates show.
 */
function dayOverDay(digests: UsageDigest[], def: StatMetric): DayComparison | null {
  const today = digests.at(-1);
  const prior = digests.at(-2);
  if (!today || !prior) return null;

  const now = def.value(today);
  const was = def.value(prior);
  const deltaPct = was > 0 ? ((now - was) / was) * 100 : null;
  const tone = deltaPct === null ? 'flat' : deltaTone(deltaPct);
  return {
    date: today.date,
    priorDate: prior.date,
    value: def.format(now),
    priorValue: def.format(was),
    deltaPct,
    tone,
    toneClass: tone === 'flat' ? 'flat' : (tone === 'up') === (def.increaseIsBad ?? true) ? 'bad' : 'good',
    partial: isPartialDay(today.date),
  };
}

function DayOverDay({ compare }: { compare: DayComparison }) {
  return (
    <div className='trend-compare'>
      <span className='trend-compare-value'>
        {compare.date}: {compare.value}
      </span>
      {compare.partial && <span className='muted'> (so far today)</span>}{' '}
      {compare.deltaPct === null ? (
        <span className='muted'>— nothing recorded on {compare.priorDate} to compare against.</span>
      ) : compare.tone === 'flat' ? (
        <span className='muted'>
          — unchanged from {compare.priorValue} on {compare.priorDate}.
        </span>
      ) : (
        <>
          <span className={`delta ${compare.toneClass}`}>{deltaLabel(compare.deltaPct)}</span>{' '}
          <span className='muted'>
            {compare.tone === 'up' ? 'up from' : 'down from'} {compare.priorValue} on {compare.priorDate}.
          </span>
        </>
      )}
    </div>
  );
}

/** Everything the loaded page puts in this slot, in order — one row and point per day. */
function TrendDetailSkeleton({ days, label, mix }: { days: number; label: string; mix: boolean }) {
  return (
    <>
      {mix && <PromptMixSkeleton />}
      <div className='grid wide-two chart-lead'>
        <SkeletonChartCard title={`${label} / day`} height={CHART_HEIGHT} bars={days} />
        <SkeletonTableCard title='By day' columns={BY_DAY_COLUMNS} rows={days} />
      </div>
    </>
  );
}
