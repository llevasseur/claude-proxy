import { blendRate, lastNonZeroComparison, type UsageDigest } from '@agent-proxy/claude-core';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { deltaLabel, deltaTone } from '../format';
import type { StatMetric } from '../metrics';
import { SeriesLineChart } from './SeriesLineChart';
import { Skeleton } from './Skeleton';

/** Plot height inside a slide, in px. The skeleton reserves the same. */
const SLIDE_CHART_HEIGHT = 240;

/**
 * Where a panel sits relative to the selection: the one showing, the sliver of
 * the previous or next peeking out from under it, or off the stage entirely.
 */
function seat(offset: number): 'current' | 'prev' | 'next' | 'off' {
  if (offset === 0) return 'current';
  if (offset === -1) return 'prev';
  if (offset === 1) return 'next';
  return 'off';
}

/**
 * The graphs, one metric per panel, with the chip strip that chooses between
 * them. The panels are a stack rather than a scrolling row: the selected one is
 * on top, and its neighbours peek out from under it, dimmed. A panel is the
 * Overview's stat card at full size — clicking the selected one opens that
 * metric's trend over time, clicking a neighbour just brings it to the front.
 */
export function TrendCarousel({ metrics, digests }: { metrics: readonly StatMetric[]; digests: UsageDigest[] }) {
  const [active, setActive] = useState(0);

  return (
    <section className='trend-carousel' aria-label='Trend graphs'>
      <div className='trend-carousel-head'>
        <div className='trend-chips'>
          {metrics.map((m, index) => (
            <button
              key={m.key}
              type='button'
              className={index === active ? 'trend-chip active' : 'trend-chip'}
              aria-pressed={index === active}
              onClick={() => setActive(index)}>
              {m.label}
            </button>
          ))}
        </div>
        <span className='range'>
          {active + 1} / {metrics.length}
        </span>
      </div>

      <div className='trend-stage'>
        {metrics.map((m, index) => (
          <TrendSlide
            key={m.key}
            def={m}
            digests={digests}
            seat={seat(index - active)}
            onSelect={() => setActive(index)}
          />
        ))}
      </div>
    </section>
  );
}

function TrendSlide({
  def,
  digests,
  seat,
  onSelect,
}: {
  def: StatMetric;
  digests: UsageDigest[];
  seat: 'current' | 'prev' | 'next' | 'off';
  onSelect: () => void;
}) {
  const blended = blendRate(digests, def.blend.num, def.blend.den);
  const rows = digests.map((d) => ({ label: d.date, value: def.value(d) }));
  const delta = closingDelta(digests, def);
  const tone = delta === null ? 'flat' : deltaTone(delta);
  const toneClass = (tone === 'up') === (def.increaseIsBad ?? true) ? 'bad' : 'good';
  const current = seat === 'current';

  return (
    <Link
      to='/trends/$metric'
      params={{ metric: def.key }}
      className={`card stat stat-link trend-panel seat-${seat}`}
      // The same element in every seat, so promoting one animates it across
      // rather than swapping it out. Off the selection it is a chooser, not a
      // link: the click is cancelled and the panel comes to the front on the
      // spot, with no navigation to wait on.
      onClick={(e) => {
        if (current) return;
        e.preventDefault();
        // Recharts marks its `<svg>` focusable, so a click inside the plot
        // leaves the ring around the chart of a panel that is only being
        // chosen. Put it on the panel the click was actually for.
        e.currentTarget.focus();
        onSelect();
      }}
      // Only the front panel is in the tab order; the chips reach the rest.
      tabIndex={current ? undefined : -1}
      aria-hidden={seat === 'off' || undefined}
      title={current ? `Open the ${def.label} trend over time` : `Show ${def.label}`}>
      <div className='stat-label'>{def.label}</div>
      <div className='stat-value'>{blended ? def.format(blended.value) : '—'}</div>
      <div className='stat-foot'>
        <span className='muted'>{def.blend.unit}</span>
        {delta !== null && tone !== 'flat' && <span className={`delta ${toneClass}`}>{deltaLabel(delta)}</span>}
      </div>
      <SeriesLineChart
        data={rows}
        series={[{ dataKey: 'value', name: def.label, color: def.color }]}
        xKey='label'
        format={def.format}
        formatTick={def.formatTick}
        height={SLIDE_CHART_HEIGHT}
      />
      <p className='trend-slide-note'>{def.description}</p>
    </Link>
  );
}

/**
 * The window's closing day against the last date that recorded this metric, in
 * percent. `null` when no earlier day in the window recorded it at all.
 */
function closingDelta(digests: readonly UsageDigest[], def: StatMetric): number | null {
  return lastNonZeroComparison(digests, def.value)?.deltaPct ?? null;
}

/**
 * The carousel at its loaded size. Every chip is a fixed string from `METRICS`,
 * so the strip renders as real text and only the panels shimmer.
 */
export function TrendCarouselSkeleton({ metrics, days }: { metrics: readonly StatMetric[]; days: number }) {
  // Deterministic sawtooth, so the bars don't flicker between renders.
  const heights = Array.from({ length: days }, (_, i) => 34 + ((i * 37) % 61));

  return (
    <section className='trend-carousel' aria-hidden>
      <div className='trend-carousel-head'>
        <div className='trend-chips'>
          {metrics.map((m, index) => (
            <span key={m.key} className={index === 0 ? 'trend-chip active' : 'trend-chip'}>
              {m.label}
            </span>
          ))}
        </div>
        <span className='range'>1 / {metrics.length}</span>
      </div>
      <div className='trend-stage'>
        {/* The first two seats only: the loaded stage shows the selection and
            the sliver of the one behind it, and nothing else is on screen. */}
        {metrics.slice(0, 2).map((m, index) => (
          <div className={`card stat trend-panel ${index === 0 ? 'seat-current' : 'seat-next'}`} key={m.key}>
            <div className='stat-label'>{m.label}</div>
            <div className='stat-value'>
              <Skeleton w='62%' />
            </div>
            {/* Real text, not a shimmer: `.stat-foot` is a flex row, so a shimmer
                span sets the row's height itself instead of the loaded text's line
                box — 8.6px against 18.6px. */}
            <div className='stat-foot'>
              <span className='muted'>{m.blend.unit}</span>
            </div>
            <div className='skeleton-chart' style={{ height: SLIDE_CHART_HEIGHT }}>
              {heights.map((h, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length run of identical placeholder bars — the index is all that distinguishes them
                <span className='skeleton skeleton-bar' key={i} style={{ height: `${h}%` }} />
              ))}
            </div>
            <p className='trend-slide-note'>{m.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
