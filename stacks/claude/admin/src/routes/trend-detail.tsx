import { isPartialDay, lastNonZeroComparison, type UsageDigest } from '@agent-proxy/claude-core';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { createRoute, Link, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { getSummary, getTrends, type SummaryResponse } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { trendsKey, UnfilterableNote, useModelOptions, withLiveToday } from '../components/DayWindow';
import { FixedPrefixTools } from '../components/FixedPrefixTools';
import { HeaderHint } from '../components/HeaderHint';
import { LiveIndicator } from '../components/LiveIndicator';
import { MAX_MODEL_SERIES, ModelSeriesToggle, modelColor, shortModelName } from '../components/ModelPicker';
import { PerCallNextSteps, PerCallPanel, PerCallSkeleton } from '../components/PerCallPanel';
import { PromptMixPanel, PromptMixSkeleton } from '../components/PromptMixPanel';
import { QueryState } from '../components/QueryState';
import { DAY_WINDOWS, Segmented } from '../components/Segmented';
import { type ChartRow, SeriesLineChart } from '../components/SeriesLineChart';
import { Skeleton, SkeletonChartCard, type SkeletonColumn, SkeletonTableCard } from '../components/Skeleton';
import { deltaLabel, deltaTone } from '../format';
import { isJsonNumber } from '../json';
import { findMetric, REPORT_TZ_ABBR, type StatMetric } from '../metrics';
import { rootRoute } from '../route-root';
import { useLiveQuery } from '../useLiveQuery';
import { useTransitionState } from '../useTransitionState';

/** The tall chart this page leads with, in px. */
const CHART_HEIGHT = 340;

/** Date and the metric's own value. */
const BY_DAY_COLUMNS: readonly SkeletonColumn[] = [{}, { className: 'num' }];

/**
 * A model's column in the chart rows. recharts reads a `dataKey` holding a dot as a
 * path into the row, so the id is reduced to word characters rather than used whole.
 */
const seriesKey = (id: string) => `m_${id.replace(/\W/g, '_')}`;

/** Large-scale trend for one Overview statistic, reached by clicking its card. */
export function TrendDetailPage() {
  const { metric } = useParams({ from: '/trends/$metric' });
  const def = findMetric(metric);
  const [days, selectDays, isSwitching] = useTransitionState(30);
  // Models drawn beside the all-models line, in the order they were added — the
  // order their colours follow, so removing one does not recolour the rest above it.
  const [selected, setSelected] = useState<readonly string[]>([]);
  const models = useModelOptions(days);
  // The same summary feed Overview and Trends read: it carries today's digest as
  // the day is written, which is what keeps the closing point moving.
  const summary = useQuery({ queryKey: ['summary'], queryFn: () => getSummary(), enabled: !!def });
  const summaryLive = useLiveQuery<SummaryResponse>('/api/summary/stream', ['summary'], !!def);
  const query = useQuery({
    queryKey: trendsKey(days, null),
    queryFn: () => getTrends(days),
    enabled: !!def,
    placeholderData: keepPreviousData,
  });
  // One window per added model. The key is the one the Trends and Overview pages
  // filter under, so a model already looked at there costs no fetch here.
  const modelQueries = useQueries({
    queries: selected.map((id) => ({
      queryKey: trendsKey(days, id),
      queryFn: () => getTrends(days, [id]),
      enabled: !!def,
      placeholderData: keepPreviousData,
    })),
  });
  const fetched = query.data?.digests;
  const today = summary.data?.digest;
  // Today spliced onto the all-models line alone: the summary digest counts every
  // model, so the per-model series above stay a fetch behind on the day in progress
  // rather than being told an all-models figure is theirs.
  const digests = useMemo(() => {
    const rows = fetched ?? [];
    return today ? withLiveToday(rows, today) : rows;
  }, [fetched, today]);
  const busy = isSwitching || query.isFetching || modelQueries.some((q) => q.isFetching);

  const toggleModel = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= MAX_MODEL_SERIES ? prev : [...prev, id],
    );

  if (!def) {
    return (
      <section>
        <Breadcrumbs>
          <Link to='/trends' className='link'>
            Trends
          </Link>
          <span className='crumb-current'>Unknown</span>
        </Breadcrumbs>
        <div className='card empty'>No trend metric named “{metric}”.</div>
      </section>
    );
  }

  // One entry per added model: where its line goes, its colour, and the metric's
  // value on each day it was used. A day the model missed is left out of the row
  // rather than zeroed, so the line breaks over it instead of diving to the floor.
  const modelSeries = selected.map((id, i) => ({
    id,
    key: seriesKey(id),
    color: modelColor(i),
    byDate: new Map((modelQueries[i]?.data?.digests ?? []).map((d) => [d.date, def.value(d)])),
  }));
  // What the filtered windows had to leave out. The models share a window, so the
  // largest count is the one to state rather than their sum.
  const unfilterable = modelQueries.reduce((most, q) => Math.max(most, q.data?.meta.unfilterableDays ?? 0), 0);

  const rows: ChartRow[] = digests.map((d) => {
    const row: ChartRow = { label: d.date, value: def.value(d) };
    for (const s of modelSeries) {
      const v = s.byDate.get(d.date);
      if (v !== undefined) row[s.key] = v;
    }
    return row;
  });
  const series = [
    { dataKey: 'value', name: modelSeries.length ? `${def.label} (all models)` : def.label, color: def.color },
    ...modelSeries.map((s) => ({ dataKey: s.key, name: shortModelName(s.id), color: s.color })),
  ];
  const first = digests.at(0);
  const last = digests.at(-1);
  const rangeLabel = !first || !last ? '—' : first.date === last.date ? first.date : `${first.date} → ${last.date}`;
  const compare = sinceLastRecorded(digests, def);
  // Which composition panel sits above the chart, at most one: `avg-system-prompt`
  // splits a day by prompt cohort, a per-call mean by what was held out of it.
  const hasMix = def.key === 'avg-system-prompt';
  const hasPerCall = !!def.perCall;

  return (
    <section>
      {/* Trends, not Overview: both the carousel and the Overview's cards arrive
          here through `/trends/$metric`. */}
      <Breadcrumbs>
        <Link to='/trends' className='link'>
          Trends
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
        {/* Stream health, then which models are drawn, beside how far back — the
            order `DayWindowControls` puts them in. */}
        <div className='pagehead-controls'>
          <LiveIndicator status={summaryLive} />
          <ModelSeriesToggle options={models} selected={selected} onToggle={toggleModel} busy={busy} />
          <Segmented options={DAY_WINDOWS} value={days} onSelect={selectDays} label='Trend window' busy={busy} />
        </div>
      </div>

      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        skeleton={<TrendDetailSkeleton days={days} label={def.label} mix={hasMix} perCall={hasPerCall} />}
        busy={busy}>
        {digests.length === 0 ? (
          <div className='card empty'>No usage captured in the last {days} days.</div>
        ) : (
          <>
            <UnfilterableNote days={unfilterable} />
            {hasMix && <PromptMixPanel days={days} />}
            {hasPerCall && <PerCallPanel digests={digests} def={def} />}

            <div className='grid wide-two chart-lead'>
              <div className='card'>
                <div className='card-head'>
                  <h2>{def.label} / day</h2>
                  <span className='range'>{rangeLabel}</span>
                </div>
                {/* Hovering shows one day; pinning keeps the rest in the tooltip
                    so days can be read against each other. */}
                <SeriesLineChart
                  data={rows}
                  series={series}
                  xKey='label'
                  format={def.format}
                  formatTick={def.formatTick}
                  height={CHART_HEIGHT}
                  pinnable
                />
              </div>

              <div className='card'>
                <h2>By day</h2>
                <div className='table-scroll'>
                  <table className='table'>
                    <thead>
                      <tr>
                        <th>
                          Date ({REPORT_TZ_ABBR})
                          <HeaderHint
                            text={`The report day, bucketed in ${REPORT_TZ_ABBR}. Newest first; the latest day may still be partial.`}
                          />
                        </th>
                        <th className='num'>
                          {modelSeries.length > 0 ? 'All models' : def.label}
                          <HeaderHint text={`${def.description} The chart beside this table plots the same values.`} />
                        </th>
                        {/* One column per added model, in the chart's own order and colour. */}
                        {modelSeries.map((s) => (
                          <th className='num' key={s.id}>
                            <span className='model-chip-dot' style={{ background: s.color }} />
                            {shortModelName(s.id)}
                            <HeaderHint
                              text={`${def.label} across ${s.id} alone. An em dash is a day it was not used.`}
                            />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...rows].reverse().map((r) => (
                        <tr key={String(r.label)}>
                          <td>{r.label}</td>
                          <td className='num'>{def.format(Number(r.value))}</td>
                          {modelSeries.map((s) => {
                            const v = r[s.key];
                            return (
                              <td className='num' key={s.id}>
                                {isJsonNumber(v) ? def.format(v) : '—'}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {def.key === 'fixed-prefix' && <FixedPrefixTools digests={digests} />}
            {hasPerCall && <PerCallNextSteps def={def} />}
          </>
        )}
      </QueryState>
    </section>
  );
}

/** The latest day against the last one that recorded the metric, ready to render. */
interface DayComparison {
  date: string;
  /** The baseline's date, or null when no earlier day recorded the metric. */
  priorDate: string | null;
  /** Both values already run through the metric's own formatter. */
  value: string;
  /** null alongside a null `priorDate` — there is no earlier figure to state. */
  priorValue: string | null;
  /** null when nothing earlier recorded the metric, which no percentage describes. */
  deltaPct: number | null;
  tone: 'up' | 'down' | 'flat';
  /** `delta` modifier — whether this direction reads as a win or a regression. */
  toneClass: 'good' | 'bad' | 'flat';
  /** The newest day is still running, so it is a part-day figure against a whole one. */
  partial: boolean;
}

/**
 * The window's latest day against the last date that recorded this metric,
 * stated rather than left to be read off the chart. The baseline skips days that
 * recorded nothing, so it is often neither yesterday nor the previous row of the
 * table — which is why both dates are named.
 */
function sinceLastRecorded(digests: UsageDigest[], def: StatMetric): DayComparison | null {
  const compared = digests.length > 1 ? lastNonZeroComparison(digests, def.value) : null;
  if (!compared) return null;

  const { closing, baseline, deltaPct } = compared;
  const tone = deltaPct === null ? 'flat' : deltaTone(deltaPct);
  return {
    date: closing.date,
    priorDate: baseline?.date ?? null,
    value: def.format(def.value(closing)),
    priorValue: baseline ? def.format(def.value(baseline)) : null,
    deltaPct,
    tone,
    toneClass: tone === 'flat' ? 'flat' : (tone === 'up') === (def.increaseIsBad ?? true) ? 'bad' : 'good',
    partial: isPartialDay(closing.date),
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
        <span className='muted'>— no earlier day in this window recorded anything to compare against.</span>
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
function TrendDetailSkeleton({
  days,
  label,
  mix,
  perCall,
}: {
  days: number;
  label: string;
  mix: boolean;
  perCall: boolean;
}) {
  return (
    <>
      {mix && <PromptMixSkeleton />}
      {perCall && <PerCallSkeleton />}
      <div className='grid wide-two chart-lead'>
        <SkeletonChartCard title={`${label} / day`} height={CHART_HEIGHT} bars={days} />
        <SkeletonTableCard title='By day' columns={BY_DAY_COLUMNS} rows={days} />
      </div>
    </>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/trends/$metric',
  component: TrendDetailPage,
  staticData: { title: 'Trend' },
});
