import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtBytes } from '../format';
import { isJsonNumber } from '../json';
import type { NetDay } from '../net-api';

/** Plot height, in px. Overview scale — about a third of the `/internet` page's own chart. */
const CHART_HEIGHT = 110;

/** One bar's day. */
interface MiniRow {
  date: string;
  /** `null` for a day with no attributed samples; recharts draws nothing for a null. */
  total: number | null;
  known: boolean;
}

/**
 * `/api/days` answers newest first; a chart reads left to right.
 *
 * A hole becomes `null` rather than `0`. A zero-height bar would be a claim that
 * nothing crossed the wire that day, where the only thing known is that nothing was
 * recorded — the collector runs solely while net-server does (ADR 0072), so an
 * unattended machine leaves holes rather than quiet days (ADR 0069).
 */
function toRows(days: readonly NetDay[]): MiniRow[] {
  return [...days].reverse().map((day) => ({
    date: day.date,
    total: day.known ? day.bytesIn + day.bytesOut : null,
    known: day.known,
  }));
}

interface TooltipEntry {
  value?: number;
}

/** The card-style tooltip the other plots on this page use, narrowed to one series. */
function DayTooltip({
  rows,
  active,
  label,
  payload,
}: {
  rows: readonly MiniRow[];
  active?: boolean;
  label?: string | number;
  payload?: TooltipEntry[];
}) {
  if (!active || !payload?.length) return null;
  const date = label == null ? '' : String(label);
  const row = rows.find((candidate) => candidate.date === date);
  const total = payload[0]?.value ?? null;

  return (
    <div className='charttip'>
      <div className='charttip-lead'>
        <div className='charttip-label'>{date}</div>
        {total !== null && (
          <div className='charttip-row'>
            <span className='charttip-dot' style={{ background: 'var(--signal)' }} />
            <span className='charttip-name'>Wire bytes</span>
            <span className='charttip-value'>{fmtBytes(total)}</span>
          </div>
        )}
      </div>
      {row && !row.known && <div className='charttip-hint'>No samples attributed to this day.</div>}
    </div>
  );
}

/**
 * Daily wire-byte totals over a short window, as one bar per local calendar day.
 *
 * Download and upload are summed into a single bar rather than stacked: this is the
 * Overview's glance at internet activity, and the split belongs on `/internet`.
 */
export function InternetDaysChart({ days }: { days: readonly NetDay[] }) {
  const rows = toRows(days);

  if (!rows.some((row) => row.known)) {
    return (
      <div className='empty'>
        No day in this window has attributed samples yet — net-server records only while it is running.
      </div>
    );
  }

  return (
    <div style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer width='100%' height='100%'>
        {/* Off for the same reason the other plots turn it off: recharts otherwise
            marks the plot surface `tabIndex=0`. */}
        <BarChart accessibilityLayer={false} data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray='3 3' stroke='var(--border)' vertical={false} />
          <XAxis
            dataKey='date'
            tick={{ fontSize: 10, fill: 'var(--muted)' }}
            axisLine={false}
            tickLine={false}
            interval='preserveStartEnd'
            minTickGap={20}
            tickFormatter={(value: string) => value.slice(5)}
          />
          <YAxis
            width='auto'
            tick={{ fontSize: 10, fill: 'var(--muted)' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value) => (isJsonNumber(value) ? fmtBytes(value) : String(value))}
          />
          <Tooltip cursor={{ fill: 'var(--hover-veil)' }} content={<DayTooltip rows={rows} />} />
          <Bar dataKey='total' name='Wire bytes' fill='var(--signal)' isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
