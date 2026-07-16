import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface Series {
  /** Key into each data row. */
  dataKey: string;
  /** Human label shown in the tooltip. */
  name: string;
  /** Line stroke colour. */
  color: string;
}

export interface SeriesLineChartProps {
  data: Array<Record<string, string | number>>;
  series: Series[];
  /** X-axis category key. */
  xKey: string;
  format: (n: number) => string;
  height?: number;
}

/** Multi-series line chart. Chrome is themed via the admin's CSS variables. */
export function SeriesLineChart({ data, series, xKey, format, height = 220 }: SeriesLineChartProps) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 12, bottom: 2, left: 2 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey={xKey}
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            width={48}
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => (typeof v === "number" ? format(v) : String(v))}
          />
          <Tooltip
            cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
            content={<SeriesTooltip series={series} format={format} />}
          />
          {series.map((s) => (
            <Line
              key={s.dataKey}
              type="monotone"
              name={s.name}
              dataKey={s.dataKey}
              stroke={s.color}
              strokeWidth={1.5}
              dot={{ r: 2, fill: s.color }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

interface TooltipPayloadEntry {
  dataKey?: string | number;
  value?: number;
}

interface SeriesTooltipProps {
  series: Series[];
  format: (n: number) => string;
  active?: boolean;
  label?: string | number;
  payload?: TooltipPayloadEntry[];
}

/** Card-style tooltip matching the admin's panels rather than recharts' default. */
function SeriesTooltip({ series, format, active, label, payload }: SeriesTooltipProps) {
  if (!active || !payload?.length) return null;
  const valueFor = (key: string) => payload.find((p) => p.dataKey === key)?.value;
  return (
    <div className="charttip">
      <div className="charttip-label">{label}</div>
      {series.map((s) => {
        const value = valueFor(s.dataKey);
        if (value == null) return null;
        return (
          <div className="charttip-row" key={s.dataKey}>
            <span className="charttip-dot" style={{ background: s.color }} />
            <span className="charttip-name">{s.name}</span>
            <span className="charttip-value">{format(value)}</span>
          </div>
        );
      })}
    </div>
  );
}
