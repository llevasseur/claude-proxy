import type { UsageDigest } from '@claude-proxy/core';

/** One model the window captured, and how many requests went to it. */
export interface ModelOption {
  /** The id as the wire reports it — what `?models=` is keyed by. */
  id: string;
  requests: number;
}

/**
 * Every model a window's digests recorded, busiest first. Read off `models`,
 * which each digest carries whether it was computed from raw sidecars or read
 * back from a finalized day — so the picker offers the same list either way.
 */
export function modelsIn(digests: readonly UsageDigest[]): ModelOption[] {
  const counts = new Map<string, number>();
  for (const d of digests) {
    for (const [id, n] of Object.entries(d.models)) counts.set(id, (counts.get(id) ?? 0) + n);
  }
  return [...counts.entries()]
    .map(([id, requests]) => ({ id, requests }))
    .sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id));
}

/** Trailing release date on a model id — `claude-opus-5-20260514`. */
const DATED = /-\d{8}$/;

/**
 * A model id at label length: the vendor prefix and the release date carry no
 * information a picker of Claude models needs, and dropping them is what lets
 * several sit in one legend. Anything that is not shaped that way is left alone,
 * since a name this does not recognise is better shown whole than truncated.
 */
export function shortModelName(id: string): string {
  return id.replace(/^claude-/, '').replace(DATED, '') || id;
}

/**
 * Line colours for model series, in the order models are added. Five, because a
 * sixth would have to repeat one of the metric colours the chart already uses
 * for its own line — the picker stops offering at that point instead.
 */
export const MODEL_SERIES_COLORS: readonly string[] = [
  'var(--accent)',
  'var(--good)',
  'var(--accent-2)',
  'var(--amber)',
  'var(--signal)',
];

/** How many models may be plotted at once — one per colour above. */
export const MAX_MODEL_SERIES = MODEL_SERIES_COLORS.length;

/** The colour a model gets from its position in the selection, not its name. */
export const modelColor = (index: number): string =>
  MODEL_SERIES_COLORS[index % MODEL_SERIES_COLORS.length] ?? 'var(--accent)';

/**
 * The whole window, or one model of it. A select rather than a segmented control:
 * model ids are long and there is no fixed number of them.
 *
 * Renders nothing when the window holds a single model — a filter offering only
 * the answer already on screen is chrome, not a control.
 */
export function ModelFilter({
  value,
  onSelect,
  options,
  label,
  busy,
}: {
  /** The selected model id, or null for every model. */
  value: string | null;
  onSelect: (next: string | null) => void;
  options: readonly ModelOption[];
  label: string;
  busy?: boolean;
}) {
  if (options.length < 2 && !value) return null;

  return (
    <span className='select-field' aria-busy={busy || undefined}>
      <select
        aria-label={label}
        value={value ?? ''}
        onChange={(e) => onSelect(e.target.value === '' ? null : e.target.value)}>
        <option value=''>All models</option>
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {shortModelName(m.id)}
          </option>
        ))}
        {/* A model selected in a wider window, then kept while the window narrowed
            past its last request: listed so the select still shows what it filters by. */}
        {value !== null && !options.some((m) => m.id === value) && (
          <option value={value}>{shortModelName(value)} (none in window)</option>
        )}
      </select>
    </span>
  );
}

/**
 * Which models are drawn beside the all-models line. Each toggle carries the
 * colour its series will be, so the control doubles as the chart's legend.
 */
export function ModelSeriesToggle({
  options,
  selected,
  onToggle,
  busy,
}: {
  options: readonly ModelOption[];
  /** Selected model ids, in the order they were added — the order colours follow. */
  selected: readonly string[];
  onToggle: (id: string) => void;
  busy?: boolean;
}) {
  if (options.length < 2) return null;
  const full = selected.length >= MAX_MODEL_SERIES;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own box and legend layout; this control is styled from scratch
    <div className='model-toggle' role='group' aria-label='Models plotted' aria-busy={busy || undefined}>
      <span className='model-toggle-label'>Add model</span>
      {options.map((m) => {
        const at = selected.indexOf(m.id);
        const on = at !== -1;
        return (
          <button
            key={m.id}
            type='button'
            className={on ? 'model-chip active' : 'model-chip'}
            aria-pressed={on}
            // A full selection still lets its own members off, so the control never traps.
            disabled={!on && full}
            title={`${m.id} · ${m.requests} request${m.requests === 1 ? '' : 's'} in this window`}
            onClick={() => onToggle(m.id)}>
            <span className='model-chip-dot' style={{ background: on ? modelColor(at) : 'var(--line)' }} />
            {shortModelName(m.id)}
          </button>
        );
      })}
    </div>
  );
}
