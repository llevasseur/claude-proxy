import { type CostRatePoint, costRatePoints, isPartialDay, summarizeCostRate } from '@agent-proxy/claude-core';
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { deltaLabel, deltaTone, fmtInt, fmtTokensShort, fmtUsd, fmtUsdCompact, fmtUsdPerMTok } from '../format';
import { CardWindowPicker, useCardWindow, useWindowDigests } from './DayWindow';
import { Skeleton, SkeletonCard } from './Skeleton';

/** Plot height, in px. Matched by the skeleton so the card does not resize on load. */
export const COST_RATE_CHART_HEIGHT = 260;

/** Colour for the newest day. Not `--accent`, which resolves to the same teal as `--signal`. */
const TODAY_COLOR = 'var(--amber)';

/** Legend entries, in the order they are drawn. */
const LEGEND = [
  { name: 'Earlier days', color: 'var(--accent)' },
  { name: 'Today', color: TODAY_COLOR },
  { name: 'Median rate', color: 'var(--muted)' },
];

/**
 * Spend against volume, one dot per day, over the median $/MTok of the earlier
 * days: a dot below the line bought its tokens more cheaply than usual.
 *
 * The window is the page head's until this card's own picker is touched.
 */
export function CostRateCard() {
  const { days, choice, select, switching, today: liveToday, model } = useCardWindow();
  const { digests, isLoading, isFetching, error } = useWindowDigests(days, liveToday, model);
  const points = costRatePoints(digests);
  const summary = summarizeCostRate(digests);
  const today = summary.today;
  const prior = points.filter((p) => p.date !== today?.date);

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Cost per token</h2>
        <div className='card-head-aside'>
          <span className='range'>{rangeLabel(points)}</span>
          <CardWindowPicker
            choice={choice}
            onSelect={select}
            label='Cost-per-token window'
            busy={switching || isFetching}
          />
        </div>
      </div>

      {isLoading ? (
        // The verdict goes with the numbers: stated over an outgoing window it names the wrong model.
        <CostRateSkeletonBody days={days} />
      ) : (
        <>
          <Verdict summary={summary} priorDays={prior.length} />

          {error ? (
            <div className='empty'>Could not load this window: {error.message}</div>
          ) : points.length === 0 ? (
            <div className='empty'>No tokens captured in this window.</div>
          ) : (
            <>
              <CostRateChart prior={prior} today={today} baseline={summary.baseline} />
              <div className='chartlegend'>
                {LEGEND.map((l) => (
                  <span className='chartlegend-item' key={l.name}>
                    <span className='chartlegend-swatch' style={{ background: l.color }} />
                    {l.name}
                  </span>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

const rangeLabel = (points: CostRatePoint[]): string => {
  const first = points.at(0);
  const last = points.at(-1);
  if (!first || !last) return '—';
  return first.date === last.date ? first.date : `${first.date} → ${last.date}`;
};

/**
 * Today's spend, its rate, and how that compares — stated above the plot.
 * Rendered even with nothing to compare against, so the card keeps its height.
 */
function Verdict({ summary, priorDays }: { summary: ReturnType<typeof summarizeCostRate>; priorDays: number }) {
  const { today, baseline, deltaPct } = summary;
  if (!today) {
    return <div className='trend-compare muted'>No tokens moved yet on the newest day in this window.</div>;
  }

  const tone = deltaPct === null ? 'flat' : deltaTone(deltaPct);
  // A rising price per token is always the regression, so `up` is the bad tone.
  const toneClass = tone === 'flat' ? 'flat' : tone === 'up' ? 'bad' : 'good';

  return (
    <div className='trend-compare'>
      <span className='trend-compare-value'>
        {today.date}: {fmtUsd(today.cost)}
      </span>
      {isPartialDay(today.date) && <span className='muted'> (so far today)</span>}{' '}
      <span className='muted'>
        · {fmtUsdPerMTok(today.rate)} across {fmtInt(today.tokens)} tokens
      </span>{' '}
      {baseline === null || deltaPct === null ? (
        <span className='muted'>— no earlier day in this window to compare against.</span>
      ) : tone === 'flat' ? (
        <span className='muted'>
          — level with the {fmtUsdPerMTok(baseline)} median of the {priorDays} day
          {priorDays === 1 ? '' : 's'} before it.
        </span>
      ) : (
        <>
          <span className={`delta ${toneClass}`}>{deltaLabel(deltaPct)}</span>{' '}
          <span className='muted'>
            {tone === 'up' ? 'above' : 'below'} the {fmtUsdPerMTok(baseline)} median of the {priorDays} day
            {priorDays === 1 ? '' : 's'} before it.
          </span>
        </>
      )}
    </div>
  );
}

/** Up to the next quarter of a power of ten — 465.2M becomes 500M, 12.1M becomes 12.5M. */
function roundUp(n: number): number {
  if (n <= 0) return 0;
  const step = 10 ** Math.floor(Math.log10(n)) / 4;
  return Math.ceil(n / step) * step;
}

interface CostRateChartProps {
  prior: CostRatePoint[];
  today: CostRatePoint | null;
  baseline: number | null;
}

/**
 * Volume on x, spend on y, so a day's slope from the origin is its price per
 * token — which is why the baseline is a line through the origin, not a rule.
 */
function CostRateChart({ prior, today, baseline }: CostRateChartProps) {
  // `z` drives dot area through the shared ZAxis; today sits at the top of the range.
  const priorRows = prior.map((p) => ({ ...p, z: 1 }));
  const todayRows = today ? [{ ...today, z: 3 }] : [];
  const days = [...prior, ...(today ? [today] : [])];
  // Headroom so the largest day is not drawn on the frame, rounded because recharts
  // labels the domain edge and a raw 1.08x lands on something like `465.2M`.
  const domainMax = roundUp(Math.max(...days.map((p) => p.tokens)) * 1.08);
  // Fixed rather than `auto`: the baseline below is clamped against this maximum.
  const costMax = roundUp(Math.max(...days.map((p) => p.cost)) * 1.08);
  // Where the median-rate line leaves the plot — through the top whenever the
  // priciest day out-slopes the median. recharts silently drops a `ReferenceLine`
  // whose segment runs outside the domain, so clamp to the first edge reached.
  const lineEndX = baseline === null ? 0 : Math.min(domainMax, (costMax * 1_000_000) / baseline);

  return (
    <div style={{ height: COST_RATE_CHART_HEIGHT }}>
      <ResponsiveContainer width='100%' height='100%'>
        {/* Off: recharts otherwise marks the surface `tabIndex=0`, ringing the whole plot. */}
        <ScatterChart accessibilityLayer={false} margin={{ top: 8, right: 14, bottom: 2, left: 2 }}>
          <CartesianGrid strokeDasharray='3 3' stroke='var(--border)' />
          <XAxis
            type='number'
            dataKey='tokens'
            name='Tokens'
            domain={[0, domainMax]}
            tick={{ fontSize: 11, fill: 'var(--muted)' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={fmtTokensShort}
          />
          <YAxis
            type='number'
            dataKey='cost'
            name='Est. cost'
            domain={[0, costMax]}
            width='auto'
            tick={{ fontSize: 11, fill: 'var(--muted)' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={fmtUsdCompact}
          />
          <ZAxis type='number' dataKey='z' domain={[1, 3]} range={[55, 190]} />
          {baseline !== null && (
            <ReferenceLine
              stroke='var(--muted)'
              strokeDasharray='5 4'
              segment={[
                { x: 0, y: 0 },
                { x: lineEndX, y: (lineEndX * baseline) / 1_000_000 },
              ]}
            />
          )}
          <Tooltip cursor={{ stroke: 'var(--border)', strokeDasharray: '3 3' }} content={<CostRateTooltip />} />
          <Scatter data={priorRows} fill='var(--accent)' isAnimationActive={false} />
          {todayRows.length > 0 && <Scatter data={todayRows} fill={TODAY_COLOR} isAnimationActive={false} />}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

interface CostRateTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: CostRatePoint }>;
}

/** Card-style tooltip matching the admin's panels rather than recharts' default. */
function CostRateTooltip({ active, payload }: CostRateTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className='charttip'>
      <div className='charttip-label'>{point.date}</div>
      <div className='charttip-row'>
        <span className='charttip-name'>Tokens</span>
        <span className='charttip-value'>{fmtInt(point.tokens)}</span>
      </div>
      <div className='charttip-row'>
        <span className='charttip-name'>Est. cost</span>
        <span className='charttip-value'>{fmtUsd(point.cost)}</span>
      </div>
      <div className='charttip-row'>
        <span className='charttip-name'>Rate</span>
        <span className='charttip-value'>{fmtUsdPerMTok(point.rate)}</span>
      </div>
    </div>
  );
}

/**
 * The verdict line, plot and legend as placeholders — unlike `SkeletonChart`, which has
 * no verdict line. No card of its own, so a card already on screen can drop to it.
 */
function CostRateSkeletonBody({ days }: { days: number }) {
  // Deterministic sawtooth, so the bars don't flicker between renders.
  const heights = Array.from({ length: days }, (_, i) => 34 + ((i * 37) % 61));

  return (
    <>
      <div className='trend-compare' aria-hidden>
        <Skeleton w='72%' />
      </div>
      <div className='skeleton-chart' style={{ height: COST_RATE_CHART_HEIGHT }} aria-hidden>
        {heights.map((h, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length run of identical loading placeholders — the index is all that distinguishes them
          <span className='skeleton skeleton-bar' key={i} style={{ height: `${h}%` }} />
        ))}
      </div>
      <div className='chartlegend' aria-hidden>
        {LEGEND.map((l) => (
          <span className='chartlegend-item' key={l.name}>
            <Skeleton w='4.5rem' />
          </span>
        ))}
      </div>
    </>
  );
}

/** That body at the card's loaded size, for the page's own first load. */
export function CostRateSkeleton({ days }: { days: number }) {
  return (
    <SkeletonCard title='Cost per token'>
      <CostRateSkeletonBody days={days} />
    </SkeletonCard>
  );
}
