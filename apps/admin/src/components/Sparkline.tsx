import type { MouseEvent } from 'react';
import { Line, LineChart, ReferenceDot, ResponsiveContainer, XAxis, YAxis } from 'recharts';

export interface SparkPoint {
  /** `YYYY-MM-DD` for this day. */
  date: string;
  value: number;
}

/** Plot inset. Mirrored in `indexAtClientX` so hit-testing matches the scale. */
const MARGIN = { top: 3, right: 2, bottom: 3, left: 2 };

/** Default plot height, in px. Shared so a placeholder reserves the same box. */
export const SPARKLINE_HEIGHT = 40;

export interface SparklineProps {
  points: SparkPoint[];
  /** Stroke colour (a CSS custom property). */
  color: string;
  height?: number;
  /** Point to mark, as an index into `points`; `null` marks none. */
  activeIndex?: number | null;
  /** Reports the point nearest the cursor, or `null` once it leaves. */
  onActiveIndexChange?: (index: number | null) => void;
}

/**
 * Chrome-free mini line chart for a stat card. The Y domain hugs the data so
 * day-to-day variation stays visible even when the values are large.
 *
 * Hovering marks the nearest day and reports it upward.
 */
export function Sparkline({
  points,
  color,
  height = SPARKLINE_HEIGHT,
  activeIndex = null,
  onActiveIndexChange,
}: SparklineProps) {
  // A single day can't form a line; show a dot instead.
  const single = points.length === 1;
  const active = activeIndex === null ? undefined : points[activeIndex];

  /** Nearest point index to the cursor. The category scale spaces days evenly across the plot. */
  const indexAtClientX = (event: MouseEvent<HTMLDivElement>): number | null => {
    const box = event.currentTarget.getBoundingClientRect();
    const plot = box.width - MARGIN.left - MARGIN.right;
    if (plot <= 0 || points.length === 0) return null;
    if (single) return 0;
    const step = plot / (points.length - 1);
    const nearest = Math.round((event.clientX - box.left - MARGIN.left) / step);
    return Math.min(points.length - 1, Math.max(0, nearest));
  };

  const track = onActiveIndexChange
    ? {
        onMouseMove: (event: MouseEvent<HTMLDivElement>) => onActiveIndexChange(indexAtClientX(event)),
        onMouseLeave: () => onActiveIndexChange(null),
      }
    : {};

  return (
    <div className='sparkline' style={{ height }} aria-hidden {...track}>
      <ResponsiveContainer width='100%' height='100%'>
        <LineChart data={points} margin={MARGIN}>
          {/* Hidden, but it gives ReferenceDot a scale to place the marker on. */}
          <XAxis dataKey='date' type='category' hide />
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Line
            type='monotone'
            dataKey='value'
            stroke={color}
            strokeWidth={1.5}
            dot={single ? { r: 2, fill: color } : false}
            isAnimationActive={false}
          />
          {/* Declared after the line, so the marker paints over it. */}
          {active && (
            <ReferenceDot x={active.date} y={active.value} r={3.2} fill={color} stroke='var(--ink)' strokeWidth={1} />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
