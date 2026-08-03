import { blendRate, type UsageDigest } from '@claude-proxy/core';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { deltaLabel, deltaTone } from '../format';
import type { StatMetric } from '../metrics';
import { SeriesLineChart } from './SeriesLineChart';
import { Skeleton } from './Skeleton';

/** Plot height inside a slide, in px. The skeleton reserves the same. */
const SLIDE_CHART_HEIGHT = 240;

/**
 * The graphs, one metric per slide, with the chip strip and arrows that choose
 * between them. A slide is the Overview's stat card at full size — same label,
 * value and footer, with the sparkline grown into a real plot — and is itself
 * the link to that metric's trend over time.
 */
export function TrendCarousel({ metrics, digests }: { metrics: readonly StatMetric[]; digests: UsageDigest[] }) {
  const [active, setActive] = useState(0);
  const trackRef = useRef<HTMLDivElement | null>(null);

  /**
   * The track is moved by assigning `scrollLeft`, not by an animated `scrollTo`:
   * arriving at the slide is the behaviour, and an animation that does not run —
   * reduced motion, a background tab — must not leave the track where it was
   * while the chips claim it moved.
   */
  const show = useCallback((index: number) => {
    const track = trackRef.current;
    const slide = track?.children[index];
    if (track && slide instanceof HTMLElement) track.scrollLeft = slide.offsetLeft;
    setActive(index);
  }, []);

  /**
   * The track decides which slide is showing, not the last button pressed — a
   * swipe or a trackpad flick moves it without going through `show`.
   */
  const syncActive = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (const [index, el] of [...track.children].entries()) {
      if (!(el instanceof HTMLElement)) continue;
      const gap = Math.abs(el.offsetLeft - track.scrollLeft);
      if (gap < best) {
        best = gap;
        nearest = index;
      }
    }
    setActive(nearest);
  }, []);

  const last = metrics.length - 1;

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
              onClick={() => show(index)}>
              {m.label}
            </button>
          ))}
        </div>
        <div className='trend-carousel-nav'>
          <span className='range'>
            {active + 1} / {metrics.length}
          </span>
          <button
            type='button'
            onClick={() => show(active - 1)}
            disabled={active === 0}
            aria-label='Previous graph'
            title='Previous graph'>
            <ChevronLeft size={16} aria-hidden />
          </button>
          <button
            type='button'
            onClick={() => show(active + 1)}
            disabled={active === last}
            aria-label='Next graph'
            title='Next graph'>
            <ChevronRight size={16} aria-hidden />
          </button>
        </div>
      </div>

      <div className='trend-track' ref={trackRef} onScroll={syncActive}>
        {metrics.map((m) => (
          <TrendSlide key={m.key} def={m} digests={digests} />
        ))}
      </div>
    </section>
  );
}

function TrendSlide({ def, digests }: { def: StatMetric; digests: UsageDigest[] }) {
  const blended = blendRate(digests, def.blend.num, def.blend.den);
  const rows = digests.map((d) => ({ label: d.date, value: def.value(d) }));
  const delta = closingDelta(digests, def);
  const tone = delta === null ? 'flat' : deltaTone(delta);
  const toneClass = (tone === 'up') === (def.increaseIsBad ?? true) ? 'bad' : 'good';

  return (
    <Link
      to='/trends/$metric'
      params={{ metric: def.key }}
      className='card stat stat-link trend-slide'
      title={`Open the ${def.label} trend over time`}>
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
 * The window's closing day against the day before it, in percent. `null` when
 * the window holds fewer than two days, or when the earlier one was zero — no
 * percentage describes a rise from nothing.
 */
function closingDelta(digests: readonly UsageDigest[], def: StatMetric): number | null {
  const closing = digests.at(-1);
  const prior = digests.at(-2);
  if (!closing || !prior) return null;
  const was = def.value(prior);
  return was > 0 ? ((def.value(closing) - was) / was) * 100 : null;
}

/**
 * The carousel at its loaded size. Every chip is a fixed string from `METRICS`,
 * so the strip renders as real text and only the slides shimmer.
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
        {/* The arrows render inert rather than absent: at 28px they are the tallest
            thing in this row whenever the chip strip fits on one line, so leaving
            them out would let the head grow when the real ones arrive. */}
        <div className='trend-carousel-nav'>
          <span className='range'>1 / {metrics.length}</span>
          <button type='button' disabled>
            <ChevronLeft size={16} aria-hidden />
          </button>
          <button type='button' disabled>
            <ChevronRight size={16} aria-hidden />
          </button>
        </div>
      </div>
      <div className='trend-track'>
        {metrics.slice(0, 2).map((m) => (
          <div className='card stat trend-slide' key={m.key}>
            <div className='stat-label'>{m.label}</div>
            <div className='stat-value'>
              <Skeleton w='62%' />
            </div>
            {/* Real text, not a shimmer: the unit is a fixed string like the chip
                labels, and `.stat-foot` is a flex row, so a shimmer span would set
                the row's height itself — 8.6px against the 18.6px line box the
                loaded text lands in, and the slide would grow when data arrived. */}
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
