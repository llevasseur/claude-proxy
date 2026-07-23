import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";

export interface SparkPoint {
  /** `YYYY-MM-DD` for this day. */
  date: string;
  value: number;
}

export interface SparklineProps {
  points: SparkPoint[];
  /** Stroke colour (a CSS custom property). */
  color: string;
  height?: number;
}

/**
 * Chrome-free mini line chart for a stat card. The Y domain hugs the data so
 * day-to-day variation stays visible even when the values are large.
 */
export function Sparkline({ points, color, height = 40 }: SparklineProps) {
  // A single day can't form a line; show a dot instead.
  const single = points.length === 1;
  return (
    <div className="sparkline" style={{ height }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 3, right: 2, bottom: 3, left: 2 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            dot={single ? { r: 2, fill: color } : false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
