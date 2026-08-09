export interface SegmentedOption<T> {
  value: T;
  label: string;
}

/**
 * Every day on record, as a `?days=` value. A count of days cannot say "all", so
 * `0` names it: the server reads that as the window whose floor is the oldest day
 * the log corpus holds, rather than clamping it up to one.
 */
export const ALL_DAYS = 0;

/**
 * The day windows the trend-shaped pages offer. `All` sits at the end because it
 * is the widest, and it is a window like the others — the reader resolves its
 * floor per request instead of the picker pretending the span does not exist.
 */
export const DAY_WINDOWS: readonly SegmentedOption<number>[] = [
  { value: 7, label: '7d' },
  { value: 14, label: '14d' },
  { value: 30, label: '30d' },
  { value: ALL_DAYS, label: 'All' },
];

export type PrettyRawView = 'pretty' | 'raw';

/** The rendered-or-source toggle the document-shaped pages carry. */
export const PRETTY_RAW: readonly SegmentedOption<PrettyRawView>[] = [
  { value: 'pretty', label: 'Pretty' },
  { value: 'raw', label: 'Raw' },
];

/**
 * The pill switcher in a page head. `busy` marks the control while the view it selects
 * is still settling; the buttons stay live throughout.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onSelect,
  label,
  busy,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onSelect: (next: T) => void;
  label?: string;
  busy?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own box and legend layout; this control is styled from scratch
    <div className='segmented' role='group' aria-label={label} aria-busy={busy || undefined}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type='button'
          className={o.value === value ? 'active' : undefined}
          aria-pressed={o.value === value}
          onClick={() => onSelect(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
