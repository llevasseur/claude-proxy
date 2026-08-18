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
 *
 * While busy, the *selected* chip swaps its label for a spinner. That is in-place
 * feedback: the result of pressing `30d` belongs on `30d`, so the control that was
 * pressed is what reports the wait and the page needs no separate loading message
 * beside it. Only the selected chip spins, because it is the only one whose press is
 * outstanding — marking all four would say four windows were loading.
 *
 * The label stays in flow underneath, hidden rather than removed, so the group holds
 * its width and the chips either side of the spinning one do not shift. A hidden span
 * leaves the accessibility tree along with the layer, so the button carries the same
 * text as `aria-label` for that interval and keeps its name; the group's `aria-busy`
 * already announces the wait itself.
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
      {options.map((o) => {
        const selected = o.value === value;
        const spinning = Boolean(busy) && selected;
        const classes = [selected && 'active', spinning && 'is-busy'].filter(Boolean).join(' ');
        return (
          <button
            key={String(o.value)}
            type='button'
            className={classes || undefined}
            aria-pressed={selected}
            aria-label={spinning ? o.label : undefined}
            onClick={() => onSelect(o.value)}>
            <span className='segmented-label'>{o.label}</span>
            {spinning && <span className='segmented-spinner' aria-hidden='true' />}
          </button>
        );
      })}
    </div>
  );
}
