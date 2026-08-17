import type { SkimDigest } from '@claude-proxy/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { Zap } from 'lucide-react';
import { useMemo } from 'react';
import { getSkim, getSkimTrend } from '../api';
import { BAR_CHART_HEIGHT, BarChart } from '../components/BarChart';
import { QueryState } from '../components/QueryState';
import { DAY_WINDOWS, Segmented } from '../components/Segmented';
import { type Series, SeriesLineChart } from '../components/SeriesLineChart';
import { SkeletonChartCard, type SkeletonColumn, SkeletonStats, SkeletonTableCard } from '../components/Skeleton';
import { StatCard } from '../components/StatCard';
import { fmtInt, fmtPct, fmtUsd, fmtUsdCompact } from '../format';
import { rootRoute } from '../route-root';
import { useTransitionState } from '../useTransitionState';
import type { NavEntry } from './nav';

const HIT_RATE_SERIES: Series[] = [{ dataKey: 'hitRate', name: 'Hit rate', color: 'var(--good)' }];
const SAVED_SERIES: Series[] = [{ dataKey: 'cumUsd', name: 'Cumulative saved', color: 'var(--accent-2)' }];

/** Cache key, the request, then four numeric columns. */
const KEY_COLUMNS: readonly SkeletonColumn[] = [
  { cell: '72%' },
  {},
  { className: 'num' },
  { className: 'num' },
  { className: 'num' },
  { className: 'num' },
];

const shortKey = (k: string): string => (k.length > 12 ? `${k.slice(0, 12)}…` : k);

function toHitRateRow(d: SkimDigest) {
  return { label: d.date.slice(5), hitRate: Number((d.hitRate * 100).toFixed(1)) };
}

function toCumulativeRows(digests: SkimDigest[]) {
  let running = 0;
  return digests.map((d) => {
    running += d.estSavedUsd;
    return { label: d.date.slice(5), cumUsd: Number(running.toFixed(4)) };
  });
}

export function SkimPage() {
  const [days, selectDays, isSwitching] = useTransitionState(14);
  const trendQuery = useQuery({
    queryKey: ['skim-trend', days],
    queryFn: () => getSkimTrend(days),
    placeholderData: keepPreviousData,
  });
  const dayQuery = useQuery({ queryKey: ['skim-day'], queryFn: () => getSkim() });

  const digests = trendQuery.data?.digests ?? [];
  const topKeys = trendQuery.data?.topKeys ?? [];
  const today = dayQuery.data?.skim;
  const hitRateRows = useMemo(() => digests.map(toHitRateRow), [digests]);
  const cumulativeRows = useMemo(() => toCumulativeRows(digests), [digests]);
  const windowTotalUsd = digests.reduce((n, d) => n + d.estSavedUsd, 0);
  const busy = isSwitching || trendQuery.isFetching;

  return (
    <section>
      <div className='pagehead'>
        <h1>Skim</h1>
        <Segmented options={DAY_WINDOWS} value={days} onSelect={selectDays} label='Skim window' busy={busy} />
      </div>

      <QueryState
        isLoading={trendQuery.isLoading || dayQuery.isLoading}
        error={trendQuery.error}
        skeleton={<SkimSkeleton days={days} stats={!dayQuery.isError} />}
        busy={busy}>
        {today && (
          <div className='grid stats'>
            <StatCard
              label='Hit rate (today)'
              value={fmtPct(today.hitRate * 100, 1)}
              sub={`${fmtInt(today.hits)} / ${fmtInt(today.enabledRequests)} enabled`}
              increaseIsBad={false}
            />
            <StatCard label='Saved today' value={fmtUsd(today.estSavedUsd)} sub='approx.' increaseIsBad={false} />
            <StatCard label={`Saved (${days}d)`} value={fmtUsd(windowTotalUsd)} sub='approx.' increaseIsBad={false} />
            <StatCard label='Saved input tokens (today)' value={fmtInt(today.savedInputTokens)} increaseIsBad={false} />
          </div>
        )}

        {digests.length === 0 ? (
          <div className='card empty'>No skim activity captured in the last {days} days.</div>
        ) : (
          <>
            <div className='grid wide-two'>
              <div className='card'>
                <h2>Hit-rate over time</h2>
                <SeriesLineChart
                  data={hitRateRows}
                  series={HIT_RATE_SERIES}
                  xKey='label'
                  format={(n) => fmtPct(n, 1)}
                />
              </div>

              <div className='card'>
                <h2>Cumulative $ saved</h2>
                <SeriesLineChart
                  data={cumulativeRows}
                  series={SAVED_SERIES}
                  xKey='label'
                  format={fmtUsd}
                  formatTick={fmtUsdCompact}
                />
              </div>
            </div>

            {topKeys.length > 0 && (
              <>
                <div className='card'>
                  <h2>Top repeated cache keys ({days}d)</h2>
                  <BarChart
                    data={topKeys.slice(0, 12).map((s) => ({ label: shortKey(s.cacheKey), value: s.requests }))}
                    format={fmtInt}
                    color='var(--accent)'
                  />
                </div>

                <div className='card'>
                  <h2>By cache key</h2>
                  <div className='table-scroll'>
                    <table className='table'>
                      <thead>
                        <tr>
                          <th>Cache key</th>
                          <th>Request</th>
                          <th className='num'>Requests</th>
                          <th className='num'>Hits</th>
                          <th className='num'>Saved tokens</th>
                          <th className='num'>Est. saved</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topKeys.map((s) => (
                          <tr key={s.cacheKey}>
                            <td title={s.cacheKey}>{shortKey(s.cacheKey)}</td>
                            <td className='skim-request'>
                              {s.requestText ? (
                                <details>
                                  <summary>{s.requestText.split('\n', 1)[0]}</summary>
                                  <pre>{s.requestText}</pre>
                                </details>
                              ) : (
                                <span className='muted'>Request log unavailable</span>
                              )}
                            </td>
                            <td className='num'>{fmtInt(s.requests)}</td>
                            <td className='num'>{fmtInt(s.hits)}</td>
                            <td className='num'>{fmtInt(s.savedInputTokens)}</td>
                            <td className='num'>{fmtUsd(s.estSavedUsd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </QueryState>
    </section>
  );
}

/**
 * Today's four tiles, the two trend charts side by side, then the per-key breakdown.
 * `stats` is false once the day query has failed — those tiles are never coming.
 */
function SkimSkeleton({ days, stats = true }: { days: number; stats?: boolean }) {
  return (
    <>
      {stats && <SkeletonStats count={4} />}
      <div className='grid wide-two'>
        <SkeletonChartCard title='Hit-rate over time' bars={days} />
        <SkeletonChartCard title='Cumulative $ saved' bars={days} />
      </div>
      <SkeletonChartCard title={`Top repeated cache keys (${days}d)`} height={BAR_CHART_HEIGHT} bars={12} />
      <SkeletonTableCard title='By cache key' columns={KEY_COLUMNS} rows={8} />
    </>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/skim',
  component: SkimPage,
  staticData: { title: 'Skim' },
});

export const nav = {
  section: 'Context',
  to: '/skim',
  label: 'Skim',
  hint: 'cache',
  exact: false,
  icon: Zap,
} as const satisfies NavEntry;
