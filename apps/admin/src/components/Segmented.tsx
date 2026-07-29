export interface SegmentedOption<T> {
  value: T;
  label: string;
}

/** The day windows every trend-shaped page offers. */
export const DAY_WINDOWS: readonly SegmentedOption<number>[] = [
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 30, label: "30d" },
];

export type PrettyRawView = "pretty" | "raw";

/** The rendered-or-source toggle every document-shaped page carries. */
export const PRETTY_RAW: readonly SegmentedOption<PrettyRawView>[] = [
  { value: "pretty", label: "Pretty" },
  { value: "raw", label: "Raw" },
];

/**
 * The pill switcher in a page head. `busy` marks the control while the view it
 * selects is still settling — the buttons stay live throughout, because the pending
 * work is a transition and the previous window is still on screen behind it.
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
    <div className="segmented" role="group" aria-label={label} aria-busy={busy || undefined}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={o.value === value ? "active" : undefined}
          aria-pressed={o.value === value}
          onClick={() => onSelect(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
