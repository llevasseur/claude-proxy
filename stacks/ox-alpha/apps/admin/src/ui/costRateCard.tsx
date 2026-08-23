import {
  estimateUsageCost,
  type ModelPricing,
  PRICING_CATALOGUE,
  type PriceCategory,
  pricingProvenance,
  type RateProvenance,
  type UsageTotals,
} from "@agent-proxy/ox-core";
import { useEffect, useState } from "react";

// Operator cost-rate overrides (`components/CostRateCard.tsx` at the pinned
// commit): editable USD-per-million-token rates that recompute cost estimates
// client-side from the loaded records' token totals. The durable sidecar costs
// are never rewritten — this card answers "what would my own rates say?".

export interface RateOverrides {
  readonly input: string;
  readonly cachedInput: string;
  readonly output: string;
}

const STORAGE_KEY = "ox-alpha.cost-rate-overrides";

const EMPTY_OVERRIDES: RateOverrides = { input: "", cachedInput: "", output: "" };

const FIELDS: ReadonlyArray<readonly [keyof RateOverrides, string, PriceCategory]> = Object.freeze([
  ["input", "Fresh input $/MTok", "input"],
  ["cachedInput", "Cached input $/MTok", "cachedInput"],
  ["output", "Output $/MTok", "output"],
]);

// localStorage is unavailable in some environments (tests, hardened
// browsers); overrides then live in a process-wide memory store so they still
// survive remounts within the session.
const MEMORY_STORE = new Map<string, string>();

// Rates are provenanced per entry (ADR 0013), so the card names each entry's
// own date and rate card rather than one catalogue-wide footnote.
const CATALOGUE_PROVENANCE: ReadonlyArray<readonly [string, RateProvenance]> = Object.freeze(
  Object.keys(PRICING_CATALOGUE)
    .map((model) => [model, pricingProvenance(model)] as const)
    .filter((entry): entry is readonly [string, RateProvenance] => entry[1] !== null),
);

function readStorage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return MEMORY_STORE.get(STORAGE_KEY) ?? null;
  }
}

function writeStorage(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    MEMORY_STORE.set(STORAGE_KEY, value);
  }
}

function loadOverrides(): RateOverrides {
  const raw = readStorage();
  if (raw === null) return EMPTY_OVERRIDES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_OVERRIDES;
    const record = parsed as Record<string, unknown>;
    const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : "");
    return { input: text("input"), cachedInput: text("cachedInput"), output: text("output") };
  } catch {
    return EMPTY_OVERRIDES;
  }
}

/** Recompute a usage total under operator rates; null where a rate is unset or invalid. */
export function recomputeCost(
  overrides: RateOverrides,
  usage: UsageTotals,
): Readonly<{ amountUsd: string | null; invalid: boolean }> {
  const entered = Object.values(overrides).filter((rate) => rate.trim() !== "");
  if (entered.length === 0) {
    return { amountUsd: null, invalid: false };
  }
  const rates: Record<PriceCategory, string> = {
    input: overrides.input,
    cachedInput: overrides.cachedInput,
    output: overrides.output,
    reasoningOutput: overrides.output,
  };
  for (const rate of Object.values(rates)) {
    if (!/^\d+(?:\.\d{1,6})?$/.test(rate)) return { amountUsd: null, invalid: true };
  }
  const catalogue: Record<string, ModelPricing> = {
    override: {
      model: "override",
      currency: "USD",
      unit: "one-million-tokens",
      effectiveDate: "operator-override",
      source: "operator",
      usdPerMillionTokens: rates,
    },
  };
  const result = estimateUsageCost("override", usage, catalogue);
  return { amountUsd: result.cost?.amountUsd ?? null, invalid: false };
}

export function CostRateCard({ usage }: { readonly usage: UsageTotals | null }) {
  const [overrides, setOverrides] = useState<RateOverrides>(EMPTY_OVERRIDES);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setOverrides(loadOverrides());
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    writeStorage(JSON.stringify(overrides));
  }, [loaded, overrides]);

  const result =
    usage !== null && loaded
      ? recomputeCost(overrides, usage)
      : { amountUsd: null, invalid: false };

  return (
    <section className="card cost-rate-card" data-testid="cost-rate-card">
      <h2>Cost-rate overrides</h2>
      <p className="muted">
        Estimates recomputed from the tokens currently listed, using your rates. Recorded sidecar
        costs stay untouched.
      </p>
      <div className="cost-rate-fields">
        {FIELDS.map(([key, label]) => (
          <label key={key} className="car-filter-field">
            <span className="car-filter-label">{label}</span>
            <input
              type="text"
              inputMode="decimal"
              value={overrides[key]}
              placeholder="catalogue"
              onChange={(event) =>
                setOverrides((current) => ({ ...current, [key]: event.target.value }))
              }
              data-testid={`cost-rate-${key}`}
            />
          </label>
        ))}
      </div>
      <output className="cost-rate-result" data-testid="cost-rate-result">
        {result.invalid
          ? "Rates must be decimal numbers."
          : result.amountUsd !== null
            ? `Estimated cost at your rates: $${result.amountUsd}`
            : "Enter rates to recompute the listed usage."}
      </output>
      <ul className="cost-rate-provenance muted" data-testid="cost-rate-provenance">
        {CATALOGUE_PROVENANCE.map(([model, provenance]) => (
          <li key={model}>
            <code>{model}</code> — effective {provenance.effectiveDate},{" "}
            <a href={provenance.source} rel="noreferrer noopener" target="_blank">
              rate card
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
