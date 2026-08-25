// Bar chart (`components/BarChart.tsx` at the pinned commit): an accessible
// SVG column chart for daily aggregates. Pure presentation — values in, bars
// out, with the numeric summary kept in text for screen readers.

export interface BarChartDatum {
  readonly label: string;
  readonly value: number;
}

export function BarChart({
  data,
  testId,
  valueLabel = 'Total tokens',
}: {
  readonly data: readonly BarChartDatum[];
  readonly testId?: string;
  readonly valueLabel?: string;
}) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((datum) => datum.value));
  return (
    <figure className='car-chart' data-testid={testId} role='img'>
      <figcaption className='sr-only'>
        {valueLabel} per day as a bar chart; highest {max.toLocaleString()}
      </figcaption>
      <svg viewBox={`0 0 ${data.length * 24} 64`} preserveAspectRatio='none' aria-hidden='true'>
        {data.map((datum, index) => {
          // The tallest bar fills the plot; zero-value days draw a stub so the
          // day is still visible rather than silently absent.
          const height = max === 0 ? 1 : Math.max(1, Math.round((datum.value / max) * 60));
          return (
            <rect key={`${datum.label}-${index}`} x={index * 24 + 4} y={62 - height} width={16} height={height} rx={2}>
              <title>{`${datum.label}: ${datum.value.toLocaleString()}`}</title>
            </rect>
          );
        })}
      </svg>
    </figure>
  );
}
