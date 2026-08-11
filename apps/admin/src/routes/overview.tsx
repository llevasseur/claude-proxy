import type { UsageDigest } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import { Monitor } from 'lucide-react';
import { useMemo } from 'react';
import { getSummary, getUsage, type SummaryResponse, type UsageResponse } from '../api';
import { AdviceCard } from '../components/AdviceCard';
import { CostRateCard, CostRateSkeleton } from '../components/CostRateCard';
import {
  DayWindowControls,
  DayWindowProvider,
  UnfilterableNote,
  useModelOptions,
  useWindowDigests,
} from '../components/DayWindow';
import { type ModelOption, shortModelName } from '../components/ModelPicker';
import { PerRequestCard, PerRequestSkeleton } from '../components/PerRequestCard';
import { QueryState } from '../components/QueryState';
import { Skeleton, SkeletonStats, SkeletonText } from '../components/Skeleton';
import { StatCard } from '../components/StatCard';
import { UsageMeter } from '../components/UsageMeter';
import { fmtInt, fmtPct } from '../format';
import { METRICS, REPORT_TZ_ABBR } from '../metrics';
import { rootRoute } from '../route-root';
import { type LiveStatus, useLiveQuery } from '../useLiveQuery';
import { useTransitionState } from '../useTransitionState';
import type { NavEntry } from './nav';

export function OverviewPage() {
  const [days, selectDays, isSwitching] = useTransitionState(7);
  // What the page is showing, beside how far back. Every plot here reads both off
  // the same context, so this one control moves the whole page.
  const [model, selectModel, isModelSwitching] = useTransitionState<string | null>(null);
  const summary = useQuery({ queryKey: ['summary'], queryFn: () => getSummary() });
  const models = useModelOptions(days);
  // Per-day history feeds every card's mini chart; shares cache with /trends.
  const trends = useWindowDigests(days, summary.data?.digest, model);
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => getUsage() });
  // Both streams watch the log directory, so a request in flight moves the meters
  // and today's digest without a reload; the queries above cover SSE being down.
  const usageLive = useLiveQuery<UsageResponse>('/api/usage/stream', ['usage']);
  const summaryLive = useLiveQuery<SummaryResponse>('/api/summary/stream', ['summary']);
  const data = summary.data;
  // What every card below follows until it pins a window of its own.
  const pageWindow = useMemo(() => ({ days, today: data?.digest, model }), [days, data, model]);

  return (
    <DayWindowProvider value={pageWindow}>
      <section>
        <PageHead
          data={data}
          loading={summary.isLoading}
          days={days}
          onDays={selectDays}
          model={model}
          onModel={selectModel}
          models={models}
          // The mini charts and the two plots below follow this window; the headline
          // numbers come from today's digest, so the switcher marks itself and the
          // stat tiles stay at full strength.
          busy={isSwitching || isModelSwitching || trends.isFetching}
          live={worstStatus(usageLive, summaryLive)}
        />

        <UsageSection data={usage.data} isLoading={usage.isLoading} error={usage.error} />
        {/* Both queries gate the skeleton: the tiles carry a mini chart drawn from the
            trends window, so landing them separately would grow the row twice. */}
        <QueryState
          isLoading={summary.isLoading || trends.isLoading}
          error={summary.error}
          skeleton={<OverviewSkeleton days={days} />}>
          {data && (
            <>
              <UnfilterableNote days={trends.unfilterableDays} />
              <OverviewBody data={data} digests={trends.digests} model={model} />
            </>
          )}
        </QueryState>
      </section>
    </DayWindowProvider>
  );
}

/** The less healthy of two stream states — one badge speaks for both. */
function worstStatus(a: LiveStatus, b: LiveStatus): LiveStatus {
  if (a === 'offline' || b === 'offline') return 'offline';
  if (a === 'connecting' || b === 'connecting') return 'connecting';
  return 'live';
}

/**
 * The subscription allowances, above the day's statistics. Renders nothing when
 * no window can be measured and nothing went wrong — neither captured headers
 * nor configured ceilings means there is no meter worth showing.
 */
function UsageSection({ data, isLoading, error }: { data?: UsageResponse; isLoading: boolean; error: Error | null }) {
  if (isLoading) {
    return (
      <div className='grid usage' aria-hidden>
        {Array.from({ length: 2 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length run of identical loading placeholders — the index is all that distinguishes them
          <div className='card usage-meter' key={i}>
            <Skeleton w='42%' h='0.8em' />
            <div style={{ margin: '10px 0' }}>
              <Skeleton w='30%' h='1.6em' />
            </div>
            <Skeleton w='100%' h='7px' />
            <SkeletonText lines={2} />
          </div>
        ))}
      </div>
    );
  }
  // A failed usage read must not take the whole Overview down with it.
  if (error) return <div className='card usage-note'>Usage limits unavailable: {error.message}</div>;
  if (!data) return null;

  const { windows, unavailable } = data.usage;
  if (windows.length === 0) {
    return unavailable ? <div className='card usage-note'>{unavailable}</div> : null;
  }

  return (
    <div className='grid usage'>
      {windows.map((w) => (
        <UsageMeter key={w.kind} meter={w} />
      ))}
    </div>
  );
}

/** The cards and panels this page loads into, at their loaded size. */
function OverviewSkeleton({ days }: { days: number }) {
  return (
    <>
      <SkeletonStats count={METRICS.length} spark baseline />
      <CostRateSkeleton days={days} />
      <PerRequestSkeleton days={days} />
      <div className='grid two' aria-hidden>
        <div className='card'>
          <div className='card-head'>
            <Skeleton w='52%' h='0.95em' />
          </div>
          <ul className='minilist'>
            {Array.from({ length: 5 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length run of identical loading placeholders — the index is all that distinguishes them
              <li key={i}>
                <Skeleton w='34%' />
                <Skeleton w='28%' />
              </li>
            ))}
          </ul>
        </div>
        <div className='card'>
          <div className='card-head'>
            <Skeleton w='30%' h='0.95em' />
          </div>
          <div className='advice-list'>
            {Array.from({ length: 2 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length run of identical loading placeholders — the index is all that distinguishes them
              <div className='card' key={i}>
                <Skeleton w='56%' className='skeleton-h2' />
                <SkeletonText lines={2} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Everything under the head. `model` narrows the series and the day the tiles
 * headline — the summary stream reports today across every model, so a filtered
 * page reads its own day out of the filtered window instead.
 */
function OverviewBody({
  data,
  digests,
  model,
}: {
  data: SummaryResponse;
  digests: UsageDigest[];
  model: string | null;
}) {
  const date = data.digest.date;
  const d = model ? digests.find((x) => x.date === date) : data.digest;
  const trend = new Map((d?.trend ?? []).map((t) => [t.field, t]));

  if (!model && data.digest.requestCount === 0) {
    return <div className='card empty'>No Claude activity captured for {date}.</div>;
  }

  return (
    <>
      {d ? (
        <div className='grid stats'>
          {METRICS.map((m) => {
            const t = m.trendField ? trend.get(m.trendField) : undefined;
            return (
              <StatCard
                key={m.key}
                label={m.label}
                value={m.headline ? m.headline(d) : m.format(m.value(d))}
                sub={m.sub?.(d)}
                deltaPct={t?.deltaPct}
                baseline={t?.priorDate ? { date: t.priorDate, value: m.format(t.prior) } : undefined}
                increaseIsBad={m.increaseIsBad}
                metric={m.key}
                spark={{
                  points: digests.map((x) => ({ date: x.date, value: m.value(x) })),
                  color: m.color,
                  format: m.format,
                }}
              />
            );
          })}
        </div>
      ) : (
        // The window can still hold this model on earlier days, so the plots below stay.
        <div className='card empty'>
          No {model && shortModelName(model)} requests captured for {date}.
        </div>
      )}

      {/* Both plots follow the page head until their own picker is touched, and each
          fetches the days it is actually drawing. */}
      <CostRateCard />
      <PerRequestCard />

      <div className='grid two'>
        <div className='card'>
          <div className='card-head'>
            <h2>Top context-eating tools</h2>
            <Link to='/tools' className='link'>
              all →
            </Link>
          </div>
          <ul className='minilist'>
            {(d?.topTools ?? []).slice(0, 5).map((t) => (
              <li key={t.name}>
                <span>{t.name}</span>
                <span className='muted'>
                  {fmtPct(t.pctOfToolBytes, 1)} · ~{fmtInt(t.estTokens)} tok
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className='card'>
          <div className='card-head'>
            <h2>Advice</h2>
            <Link to='/advice' className='link'>
              all →
            </Link>
          </div>
          <div className='advice-list'>
            {data.advice.slice(0, 2).map((a) => (
              <AdviceCard key={a.id} advice={a} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The page head, above the loading boundary: title and window switcher stay usable
 * while the digest loads, and only the day's request-count line waits for data.
 */
function PageHead({
  data,
  loading,
  days,
  onDays,
  model,
  onModel,
  models,
  busy,
  live,
}: {
  data?: SummaryResponse;
  loading: boolean;
  days: number;
  onDays: (d: number) => void;
  model: string | null;
  onModel: (next: string | null) => void;
  models: readonly ModelOption[];
  busy?: boolean;
  live: LiveStatus;
}) {
  return (
    <div className='pagehead'>
      <div className='pagehead-title'>
        <h1>Overview</h1>
        <div className='muted'>
          {data ? (
            <>
              {data.digest.date} ({REPORT_TZ_ABBR}) · {data.meta.files} request{data.meta.files === 1 ? '' : 's'}
              {data.meta.parseErrors > 0 && ` · ${data.meta.parseErrors} skipped`}
            </>
          ) : loading ? (
            <Skeleton w='14rem' />
          ) : null}
        </div>
      </div>
      <DayWindowControls
        days={days}
        onDays={onDays}
        label='Mini-chart window'
        busy={busy}
        live={live}
        model={model}
        onModel={onModel}
        models={models}
        modelLabel='Model shown on this page'
      />
    </div>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewPage,
  staticData: { title: 'Overview' },
});

export const nav = {
  section: 'Dashboard',
  to: '/',
  label: 'Overview',
  hint: 'today',
  exact: true,
  icon: Monitor,
} as const satisfies NavEntry;
