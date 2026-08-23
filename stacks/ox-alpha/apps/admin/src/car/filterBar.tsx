import { useMemo } from "react";

// Filter bar ported from codex-proxy `apps/admin/src/car/filter-bar.tsx`;
// empty model selection means all models (codex-proxy ADR 0014 semantics
// inherited by the server's exact-match parameter).

export interface FilterBarFilters {
  readonly from?: string;
  readonly to?: string;
  readonly model?: readonly string[];
}

interface FilterBarProps {
  filters: FilterBarFilters;
  modelOptions: readonly string[];
  onChange: (filters: FilterBarFilters) => void;
}

function mergeOptions(
  modelOptions: readonly string[],
  selected: readonly string[],
): readonly string[] {
  const seen = new Set(modelOptions);
  const merged = [...modelOptions];
  for (const model of selected) {
    if (!seen.has(model)) {
      seen.add(model);
      merged.push(model);
    }
  }
  return merged.sort((left, right) => left.localeCompare(right));
}

export function FilterBar({ filters, modelOptions, onChange }: FilterBarProps) {
  const { from, to } = filters;
  const models = useMemo(() => filters.model ?? [], [filters.model]);
  const options = useMemo(() => mergeOptions(modelOptions, models), [modelOptions, models]);
  const hasFilters = from !== undefined || to !== undefined || models.length > 0;

  const apply = (patch: {
    from?: string | null;
    to?: string | null;
    models?: readonly string[];
  }) => {
    const nextModels = patch.models ?? models;
    onChange({
      from: patch.from === null ? undefined : (patch.from ?? from),
      to: patch.to === null ? undefined : (patch.to ?? to),
      model: nextModels.length > 0 ? [...nextModels] : undefined,
    });
  };

  const toggleModel = (model: string) => {
    apply({
      models: models.includes(model)
        ? models.filter((entry) => entry !== model)
        : [...models, model],
    });
  };

  return (
    <section className="card car-filters" aria-label="Range and model filters">
      <label className="car-filter-field">
        <span className="car-filter-label">From</span>
        <input
          type="date"
          value={from ?? ""}
          onChange={(event) => apply({ from: event.target.value || null })}
        />
      </label>
      <label className="car-filter-field">
        <span className="car-filter-label">To</span>
        <input
          type="date"
          value={to ?? ""}
          onChange={(event) => apply({ to: event.target.value || null })}
        />
      </label>

      <details className="car-multiselect">
        <summary>{models.length > 0 ? `Models (${models.length})` : "All models"}</summary>
        <div className="car-multiselect-list">
          {options.length === 0 && (
            <p className="muted">
              No models observed yet. They appear here as requests are recorded.
            </p>
          )}
          {options.map((model) => (
            <label key={model} className="car-multiselect-option">
              <input
                type="checkbox"
                checked={models.includes(model)}
                onChange={() => toggleModel(model)}
              />
              <span>{model}</span>
            </label>
          ))}
        </div>
      </details>

      {hasFilters && (
        <button
          type="button"
          className="car-filters-clear"
          onClick={() => onChange({ from: undefined, to: undefined, model: undefined })}
        >
          Clear filters
        </button>
      )}
    </section>
  );
}
