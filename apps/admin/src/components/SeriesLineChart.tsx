import { type ReactElement, useCallback, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { deltaLabel, deltaTone } from '../format';

export interface Series {
  /** Key into each data row. */
  dataKey: string;
  /** Human label shown in the tooltip. */
  name: string;
  /** Line stroke colour. */
  color: string;
}

export type ChartRow = Record<string, string | number>;

export interface SeriesLineChartProps {
  data: ChartRow[];
  series: Series[];
  /** X-axis category key. */
  xKey: string;
  format: (n: number) => string;
  /** Compact form of `format` for y-axis ticks; defaults to `format`. */
  formatTick?: (n: number) => string;
  height?: number;
  /** Let a click pin a point into the tooltip's comparison list. Off where the surroundings own the click. */
  pinnable?: boolean;
}

/** Pinned x values, held as strings so they compare the same however recharts hands one back. */
type PinKey = string;

/** Multi-series line chart. Chrome is themed via the admin's CSS variables. */
export function SeriesLineChart({
  data,
  series,
  xKey,
  format,
  formatTick = format,
  height = 220,
  pinnable = false,
}: SeriesLineChartProps) {
  const [pinned, setPinned] = useState<PinKey[]>([]);

  // Keyed off the point's own datum: the chart's `activeLabel` lags a fast pointer.
  const togglePin = useCallback((key: PinKey) => {
    setPinned((current) => (current.includes(key) ? current.filter((p) => p !== key) : [...current, key]));
  }, []);

  const pins = pinnable ? pinned : [];
  const pinSet = new Set(pins);

  return (
    <div style={{ height }}>
      <ResponsiveContainer width='100%' height='100%'>
        {/* Off: recharts otherwise marks the surface `tabIndex=0`. The keyboard reaches
            the points through the pin switches below instead. */}
        <LineChart accessibilityLayer={false} data={data} margin={{ top: 6, right: 12, bottom: 2, left: 2 }}>
          <CartesianGrid strokeDasharray='3 3' stroke='var(--border)' />
          <XAxis
            dataKey={xKey}
            tick={{ fontSize: 11, fill: 'var(--muted)' }}
            axisLine={false}
            tickLine={false}
            interval='preserveStartEnd'
            minTickGap={24}
          />
          {/* `auto` sizes the gutter to the widest rendered tick. */}
          <YAxis
            width='auto'
            tick={{ fontSize: 11, fill: 'var(--muted)' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => (typeof v === 'number' ? formatTick(v) : String(v))}
          />
          <Tooltip
            cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
            // The card sizes to its content instead of scrolling inside the plot,
            // so it may leave the plot vertically — and must draw over the
            // neighbouring cards when it does.
            allowEscapeViewBox={{ x: false, y: true }}
            wrapperStyle={{ zIndex: 10 }}
            content={
              <SeriesTooltip series={series} format={format} data={data} xKey={xKey} pins={pins} pinnable={pinnable} />
            }
          />
          {series.map((s) => (
            <Line
              key={s.dataKey}
              type='monotone'
              name={s.name}
              dataKey={s.dataKey}
              stroke={s.color}
              strokeWidth={1.5}
              dot={
                pinnable
                  ? (props: unknown) => renderDot(props, s.color, pinSet, xKey, togglePin)
                  : { r: 2, fill: s.color }
              }
              // The hover marker draws over the point, so without this it swallows
              // every click — a point is always hovered before it is clicked.
              activeDot={pinnable ? { r: 4, fill: s.color, style: { pointerEvents: 'none' } } : undefined}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

interface DotRenderProps {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: ChartRow;
}

/**
 * A pinned point draws as a hollow ring, an unpinned one as the plain dot. The
 * state has to read off the line, since the tooltip only exists while hovering.
 */
function renderDot(
  props: unknown,
  color: string,
  pinSet: Set<PinKey>,
  xKey: string,
  onToggle: (key: PinKey) => void,
): ReactElement {
  const { cx, cy, index, payload } = props as DotRenderProps;
  const x = payload?.[xKey];
  const key = x == null ? null : String(x);
  const isPinned = key !== null && pinSet.has(key);
  const placed = typeof cx === 'number' && typeof cy === 'number';

  return (
    <g key={`dot-${index}`}>
      <circle
        cx={cx}
        cy={cy}
        r={isPinned ? 4.5 : 2}
        fill={isPinned ? 'var(--surface)' : color}
        stroke={color}
        strokeWidth={isPinned ? 2 : 0}
      />
      {/* The visible dot is 2px across. This invisible disc is the click target,
          wide enough to hit without overlapping its neighbours. */}
      {key !== null && placed && (
        <circle
          cx={cx}
          cy={cy}
          r={9}
          fill='transparent'
          style={{ cursor: 'pointer' }}
          // A switch rather than a button: pinning is a two-state control.
          role='switch'
          tabIndex={0}
          aria-checked={isPinned}
          aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${key}`}
          // Mouse-down, not click: hovering re-renders the dots, so the pressed
          // node is gone before the release and no `click` is ever dispatched.
          onMouseDown={(e) => {
            e.stopPropagation();
            onToggle(key);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            onToggle(key);
          }}
        />
      )}
    </g>
  );
}

interface TooltipPayloadEntry {
  dataKey?: string | number;
  value?: number;
}

/**
 * Pins shown in the tooltip before the rest collapse to a count — the card must
 * fit its content, so the list is capped by number rather than scrolled.
 */
const MAX_TIP_PINS = 4;

interface SeriesTooltipProps {
  series: Series[];
  format: (n: number) => string;
  /** Every row, so a pinned x value can be read back out of it — the payload only carries the hovered one. */
  data: ChartRow[];
  xKey: string;
  pins: PinKey[];
  pinnable: boolean;
  active?: boolean;
  label?: string | number;
  payload?: TooltipPayloadEntry[];
}

/** Card-style tooltip matching the admin's panels rather than recharts' default. */
function SeriesTooltip({ series, format, data, xKey, pins, pinnable, active, label, payload }: SeriesTooltipProps) {
  if (!active || !payload?.length) return null;
  const hovered = label == null ? '' : String(label);
  const valueFor = (key: string) => payload.find((p) => p.dataKey === key)?.value ?? null;

  // Hovered point heads the list, pins follow in click order. A hovered pin is
  // promoted rather than listed twice; a pin outside the window drops out.
  const compared = pins
    .filter((key) => key !== hovered)
    .map((key) => data.find((row) => String(row[xKey]) === key))
    .filter((row): row is ChartRow => !!row);

  return (
    <div className='charttip'>
      <div className='charttip-lead'>
        <div className='charttip-label'>{label}</div>
        {series.map((s) => {
          const value = valueFor(s.dataKey);
          if (value == null) return null;
          return (
            <div className='charttip-row' key={s.dataKey}>
              <span className='charttip-dot' style={{ background: s.color }} />
              <span className='charttip-name'>{s.name}</span>
              <span className='charttip-value'>{format(value)}</span>
            </div>
          );
        })}
      </div>

      {compared.length > 0 && (
        <div className='charttip-pins'>
          {compared.slice(0, MAX_TIP_PINS).map((row) => (
            <PinnedEntry
              key={String(row[xKey])}
              row={row}
              xKey={xKey}
              series={series}
              format={format}
              baseline={valueFor}
            />
          ))}
          {compared.length > MAX_TIP_PINS && (
            <div className='charttip-more'>+{compared.length - MAX_TIP_PINS} more pinned</div>
          )}
        </div>
      )}

      {pinnable && (
        <div className='charttip-hint'>
          {pins.length > 0 ? 'Click a point to pin or unpin it' : 'Click a point to pin it for comparison'}
        </div>
      )}
    </div>
  );
}

/**
 * One pinned point, measured against whatever is hovered. A single-series chart
 * collapses to one row per point — only the date distinguishes them.
 */
function PinnedEntry({
  row,
  xKey,
  series,
  format,
  baseline,
}: {
  row: ChartRow;
  xKey: string;
  series: Series[];
  format: (n: number) => string;
  baseline: (key: string) => number | null;
}) {
  const date = String(row[xKey]);
  const lead = series.length === 1 ? series[0] : null;

  if (lead) {
    const value = numberAt(row, lead.dataKey);
    if (value == null) return null;
    return (
      <div className='charttip-row'>
        <span className='charttip-dot pinned' style={{ borderColor: lead.color }} />
        <span className='charttip-name'>{date}</span>
        <span className='charttip-value'>{format(value)}</span>
        <Delta base={baseline(lead.dataKey)} value={value} />
      </div>
    );
  }

  return (
    <div className='charttip-pin'>
      <div className='charttip-label'>{date}</div>
      {series.map((s) => {
        const value = numberAt(row, s.dataKey);
        if (value == null) return null;
        return (
          <div className='charttip-row' key={s.dataKey}>
            <span className='charttip-dot pinned' style={{ borderColor: s.color }} />
            <span className='charttip-name'>{s.name}</span>
            <span className='charttip-value'>{format(value)}</span>
            <Delta base={baseline(s.dataKey)} value={value} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * How the pinned figure sits against the hovered one, in percent. Uncoloured —
 * the chart is not told whether up is a win for this metric.
 */
function Delta({ base, value }: { base: number | null; value: number }) {
  if (base == null || base === 0) return null;
  const pct = ((value - base) / base) * 100;
  return (
    <span className='charttip-delta' title='Against the hovered point'>
      {deltaTone(pct) === 'flat' ? '±0%' : deltaLabel(pct)}
    </span>
  );
}

function numberAt(row: ChartRow, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' ? value : null;
}
