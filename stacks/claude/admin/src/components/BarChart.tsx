export interface BarPoint {
  label: string;
  value: number;
}

/** Plot height, in px. Shared so a placeholder reserves the same box. */
export const BAR_CHART_HEIGHT = 200;

export interface BarChartProps {
  data: BarPoint[];
  format: (n: number) => string;
  color?: string;
}

/** Lightweight CSS bar chart — no charting dependency. */
export function BarChart({ data, format, color = 'var(--accent)' }: BarChartProps) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className='barchart' style={{ height: BAR_CHART_HEIGHT }}>
      {data.map((d) => (
        <div className='barcol' key={d.label} title={`${d.label}: ${format(d.value)}`}>
          <div className='barval'>{format(d.value)}</div>
          <div className='bartrack'>
            <div className='bar' style={{ height: `${(d.value / max) * 100}%`, background: color }} />
          </div>
          <div className='barlabel'>{d.label.slice(5)}</div>
        </div>
      ))}
    </div>
  );
}
