import { Link } from '@tanstack/react-router';
import {
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { deltaLabel, deltaTone } from '../format';
import { Sparkline, type SparkPoint } from './Sparkline';

/** Gap between card and popover; mirrors the offset in `.stat-popover`. */
const POPOVER_GAP = 8;

/** The value never shrinks past this, however narrow the card. */
const MIN_VALUE_PX = 13;

/**
 * Shrinks the value's font just enough to fit its card on one line. A raw
 * token count at display size can outgrow a grid cell; the ratio of rendered
 * width to available width is exactly the correction, and full size returns
 * whenever full size fits again.
 */
function useFitText(value: string): MutableRefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies(value): the effect reads the figure off the DOM, but must re-measure when the rendered value changes — which no resize event reports
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastWidth = -1;
    const fit = () => {
      el.style.fontSize = '';
      lastWidth = el.clientWidth;
      const overflow = el.scrollWidth / lastWidth;
      if (overflow > 1) {
        const base = Number.parseFloat(getComputedStyle(el).fontSize);
        el.style.fontSize = `${Math.max(base / overflow, MIN_VALUE_PX)}px`;
      }
    };
    fit();
    // Only a width change re-fits: the shrink itself changes the height, and
    // reacting to that would loop the observer.
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [value]);
  return ref;
}

/** Per-day series and how to render it, for the mini chart and popover. */
export interface StatSpark {
  points: SparkPoint[];
  /** Line colour (a CSS custom property). */
  color: string;
  format: (n: number) => string;
}

/**
 * What a card's delta is measured against: the last day that actually recorded
 * the field. Idle days are skipped, so it is often not yesterday and differs
 * from card to card.
 */
export interface StatBaseline {
  date: string;
  /** That day's value, already formatted. */
  value: string;
}

export interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  /** Delta % against `baseline`, if available. */
  deltaPct?: number;
  /**
   * Absent when no earlier day recorded the field, and on digests archived
   * before the baseline was tracked.
   */
  baseline?: StatBaseline;
  /** Whether an increase is good (e.g. cache-hit) or bad (e.g. cost). */
  increaseIsBad?: boolean;
  /** Metric slug — makes the whole card a link to `/trends/$metric`. */
  metric?: string;
  /** Per-day history: renders a sparkline and a hover popover of values. */
  spark?: StatSpark;
}

export function StatCard({
  label,
  value,
  sub,
  deltaPct,
  baseline,
  increaseIsBad = true,
  metric,
  spark,
}: StatCardProps) {
  const tone = deltaPct === undefined ? null : deltaTone(deltaPct);
  const good = tone === 'flat' ? 'flat' : (tone === 'up') === increaseIsBad ? 'bad' : 'good';
  // Shared by the mini chart and the popover, so hovering either highlights both.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [above, setAbove] = useState(false);
  const valueRef = useFitText(value);

  // Placement is settled as the cursor arrives: below, or over the card when the
  // viewport would clip it.
  const place = useCallback((event: SyntheticEvent<HTMLElement>) => {
    const popover = popoverRef.current;
    if (!popover) return;
    const box = event.currentTarget.getBoundingClientRect();
    // Its height, not its rect — the rect moves with the placement being decided.
    const needed = popover.offsetHeight + POPOVER_GAP;
    const fitsBelow = box.bottom + needed <= window.innerHeight;
    setAbove(!fitsBelow && box.top - needed >= 0);
  }, []);

  const body = (
    <>
      <div className='stat-label'>{label}</div>
      <div className='stat-value' ref={valueRef}>
        {value}
      </div>
      <div className='stat-foot'>
        {sub && <span className='muted'>{sub}</span>}
        {deltaPct !== undefined && tone !== 'flat' && <span className={`delta ${good}`}>{deltaLabel(deltaPct)}</span>}
      </div>
      {tone !== null && <div className='stat-baseline'>{baselineText(tone, baseline, deltaPct)}</div>}
      {spark && spark.points.length > 0 && (
        <>
          <Sparkline
            points={spark.points}
            color={spark.color}
            activeIndex={activeIndex}
            onActiveIndexChange={setActiveIndex}
          />
          <StatPopover
            popoverRef={popoverRef}
            label={label}
            spark={spark}
            above={above}
            activeIndex={activeIndex}
            onActiveIndexChange={setActiveIndex}
          />
        </>
      )}
    </>
  );

  if (metric) {
    return (
      <Link
        to='/trends/$metric'
        params={{ metric }}
        className='card stat stat-link'
        onMouseEnter={place}
        onFocus={place}>
        {body}
      </Link>
    );
  }
  return <div className='card stat'>{body}</div>;
}

/**
 * The line under the delta chip, worded as `/trends/$metric` words it. With no
 * date to name, a zero delta means nothing earlier recorded the field at all,
 * and a non-zero one a digest archived before the baseline date was kept.
 */
function baselineText(tone: 'up' | 'down' | 'flat', baseline: StatBaseline | undefined, deltaPct?: number): string {
  if (!baseline) return deltaPct ? 'vs an earlier day (date not recorded)' : 'no earlier day recorded this yet';
  const verb = tone === 'flat' ? 'unchanged from' : tone === 'up' ? 'up from' : 'down from';
  return `${verb} ${baseline.value} on ${baseline.date}`;
}

/**
 * Hover panel listing each day's value, newest first. Rows highlight the active
 * day and mark it on the mini chart. `above` flips it over the card, for a card
 * low enough that the panel would fall past the bottom of the viewport.
 */
function StatPopover({
  popoverRef,
  label,
  spark,
  above,
  activeIndex,
  onActiveIndexChange,
}: {
  popoverRef: MutableRefObject<HTMLDivElement | null>;
  label: string;
  spark: StatSpark;
  above: boolean;
  activeIndex: number | null;
  onActiveIndexChange: (index: number | null) => void;
}): ReactNode {
  // Keep each point's index through the reverse so it still addresses the chart.
  const rows = spark.points.map((p, index) => ({ ...p, index })).reverse();
  // CSS reads `--spark-color` for the row highlight.
  const tint = { '--spark-color': spark.color } as CSSProperties;

  return (
    <div ref={popoverRef} className={`stat-popover${above ? ' is-above' : ''}`} role='tooltip' style={tint}>
      <div className='stat-popover-head'>{label} · by day</div>
      <ul className='stat-popover-list' onMouseLeave={() => onActiveIndexChange(null)}>
        {rows.map((p) => (
          <li
            key={p.date}
            className={p.index === activeIndex ? 'is-active' : undefined}
            onMouseEnter={() => onActiveIndexChange(p.index)}>
            <span className='stat-popover-date'>{p.date.slice(5)}</span>
            <span className='stat-popover-value'>{spark.format(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
