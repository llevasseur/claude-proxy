import {
  aggregateCost,
  type CostResult,
  type CostUnavailableReason,
  type ExactCost,
  type ModelPrice,
  resolveCost,
} from './pricing.js';
import type { AuditTokens } from './types.js';

/**
 * The rate table, and cost resolved against it at read time.
 *
 * Two decisions shape everything here and neither is re-opened in this file.
 *
 * `docs/adrs/0044-every-model-gets-a-price-row.md` — pricing is a **table**, not
 * a lookup that can miss: a row for every model the corpus contains, each proxy
 * declaring its own fallback, a fallback-priced record **stamped** with its
 * source, and a model with no defensible rate priced `null` rather than `0`.
 * There is **no effective dating** — one current rate per model prices every row
 * in the corpus, so nothing here carries a `valid_from`, a rate history, or an
 * as-of date, and adding one would be a new decision rather than a feature.
 *
 * `docs/adrs/0065-cost-is-resolved-at-read-time.md` — `cost` and
 * `pricing_source` are **resolved on every read and stored nowhere**. They are
 * functions of a table an operator may edit at any moment, so freezing them onto
 * a record is a cache with no invalidation rule, and a stale
 * `pricing_source` defeats the exact purpose 0044 line 71 gives the stamp: a
 * share-of-fallback figure that is confidently wrong. That is why this module is
 * a pure function of `(tokens, model, table)` and owns no storage.
 *
 * ## Why this is not a second cost path
 *
 * The arithmetic is **not** re-implemented here. Selecting the row is this
 * module's job; turning a row and a token count into money stays in
 * `pricing.ts`'s {@link resolveCost}, which already does it in integer picoUSD
 * and already encodes ADR 0020's rule that only a **consumed** bucket needs a
 * usable rate. Duplicating that rule is the mistake this split avoids — it is
 * subtle, load-bearing, and belongs in one place.
 *
 * What this module adds over `pricing.ts`'s catalogue is the **keying**.
 * `MODEL_PRICES` matches a model to a *family* by substring, which is the right
 * shape for a hand-maintained constant and the wrong shape for an operator-edited
 * dimension table: a table with a row per model must match that model and no
 * other, or an added row silently reprices its neighbours.
 */

/**
 * One rate row, in USD per million tokens.
 *
 * `null` means **not configured** for that bucket, which is not the same fact as
 * a rate of `0`. Zero is a real price — 0044's "free tier that genuinely costs
 * nothing" — and it prices a bucket at nothing. `null` is the absence of a
 * defensible rate, and a *consumed* bucket carrying one makes the whole cost
 * unavailable with a typed reason rather than quietly billing it at zero.
 */
export interface RateRow {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheWrite: number | null;
  readonly cacheRead: number | null;
}

/**
 * Where a resolved cost's rates came from — 0044's stamp, as a value.
 *
 * It is a discriminated union rather than a bare string so a reader can act on
 * it without parsing text; {@link pricingSourceLabel} renders 0044's literal
 * `fallback:<proxy>` wire form when one is needed.
 */
export type PricingSource =
  | { readonly kind: 'table'; readonly model: string }
  | { readonly kind: 'fallback'; readonly proxy: string };

/** 0044's stamp as written: `table` for a model's own row, `fallback:<proxy>` otherwise. */
export function pricingSourceLabel(source: PricingSource): string {
  return source.kind === 'table' ? 'table' : `fallback:${source.proxy}`;
}

/**
 * A cost resolved against the table, with the stamp that says how.
 *
 * Cost and stamp travel together and are both `null` together: an unpriced
 * record has no source to name, and a priced one is never anonymous. That
 * pairing is what keeps a share-of-fallback figure honest.
 */
export type PricedRecord =
  | { readonly cost: ExactCost; readonly pricingSource: PricingSource; readonly unavailableReason: null }
  | { readonly cost: null; readonly pricingSource: null; readonly unavailableReason: CostUnavailableReason };

/**
 * The rate table as a value: rows keyed by model, plus the one fallback this
 * proxy declares.
 *
 * `fallback` is `null` when the proxy declares none. That is a real state rather
 * than an oversight — 0044 gives each proxy its *own* fallback precisely because
 * a rate defensible for one provider is not defensible for another, so a proxy
 * with no defensible blanket rate declares nothing and its unpriced models
 * resolve unknown.
 */
export interface RateTable {
  /** The proxy whose fallback this table declares — the `<proxy>` in the stamp. */
  readonly proxy: string;
  /** Rows by normalized model key. Use {@link rateRowFor} rather than reading this directly. */
  readonly rows: ReadonlyMap<string, RateRow>;
  /** This proxy's declared fallback row, or `null` when it declares none. */
  readonly fallback: RateRow | null;
}

/**
 * Model names are compared case-insensitively and without surrounding space, so
 * `Claude-Opus-5 ` and `claude-opus-5` are one row rather than two. Nothing else
 * is normalized: a version suffix is part of the model's identity, and folding
 * one away here would be the substring matching this table exists to avoid.
 */
export function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase();
}

/** Build a table from rows keyed by model name, normalizing the keys once. */
export function createRateTable(input: {
  proxy: string;
  rows: Iterable<readonly [string, RateRow]>;
  fallback?: RateRow | null;
}): RateTable {
  const rows = new Map<string, RateRow>();
  for (const [model, row] of input.rows) {
    const key = normalizeModelKey(model);
    if (key !== '') rows.set(key, row);
  }
  return { proxy: input.proxy, rows, fallback: input.fallback ?? null };
}

/** A row selected from the table, and the stamp that selection earns. */
export interface SelectedRate {
  readonly row: RateRow;
  readonly source: PricingSource;
}

/**
 * The rate row for `model`, or `null` when the table can price it no way at all.
 *
 * Exact match first, this proxy's declared fallback second, nothing third. The
 * match is exact **by design** — see the module note above. It is also what makes
 * ADR 0065's "a deleted price row needs no special handling" true: deleting a row
 * simply removes it from this map, and the next read falls to the fallback if one
 * is declared and to `null` if not. There is no dangling reference to clean up,
 * because nothing ever pointed at the row.
 *
 * A record with **no model recorded at all** takes neither branch and is always
 * `null`. The fallback answers "this model is not in the table", which is a
 * different fact from "this record does not say what produced it" — applying a
 * rate to the second would put a number on a record nothing is known about, and
 * 0044's unknown state is what that record is owed.
 */
export function rateRowFor(table: RateTable, model: string): SelectedRate | null {
  const key = normalizeModelKey(model);
  if (key === '') return null;
  const row = table.rows.get(key);
  if (row !== undefined) return { row, source: { kind: 'table', model: key } };
  if (table.fallback !== null) return { row: table.fallback, source: fallbackSource(table) };
  return null;
}

function fallbackSource(table: RateTable): PricingSource {
  return { kind: 'fallback', proxy: table.proxy };
}

/**
 * A rate row as the arithmetic wants it.
 *
 * An unconfigured bucket becomes `NaN` rather than being checked here, so that
 * {@link resolveCost} applies ADR 0020's consumed-bucket rule in the single place
 * it lives: `NaN` fails that function's rate pattern exactly as any other
 * unusable rate does, yielding `missing-category-price` for a bucket that
 * actually consumed tokens and being left unread for one that did not. Checking
 * for `null` here instead would mean restating "only consumed buckets matter" in
 * a second place, and the two would drift.
 */
function toModelPrice(row: RateRow): ModelPrice {
  return {
    input: row.input ?? Number.NaN,
    output: row.output ?? Number.NaN,
    cacheWrite: row.cacheWrite ?? Number.NaN,
    cacheRead: row.cacheRead ?? Number.NaN,
  };
}

/**
 * The cost of one record's tokens against the table, resolved now.
 *
 * This is the read-time resolution ADR 0065 requires: call it on the way out of a
 * query, never on the way in, and store neither field it returns.
 */
export function resolveRecordCost(table: RateTable, tokens: AuditTokens, model: string): PricedRecord {
  const selected = rateRowFor(table, model);
  if (selected === null) {
    return { cost: null, pricingSource: null, unavailableReason: { code: 'unknown-model', model } };
  }

  // A single-entry catalogue whose one key is the model itself: the row is
  // already chosen, so this hands `resolveCost` the arithmetic and nothing else.
  // `rateRowFor` answered non-null, so the key is non-empty and matches itself.
  const key = normalizeModelKey(model);
  const result: CostResult = resolveCost(tokens, key, { [key]: toModelPrice(selected.row) });

  if (result.cost === null) {
    // The row was selected above, so `unknown-model` is unreachable here and the
    // reason is a rate the row cannot state. Report it against the model as the
    // record spells it rather than the normalized key used for the lookup.
    const reason = result.unavailableReason;
    return {
      cost: null,
      pricingSource: null,
      unavailableReason: reason.code === 'missing-category-price' ? { ...reason, model } : reason,
    };
  }
  return { cost: result.cost, pricingSource: selected.source, unavailableReason: null };
}

/**
 * Roll resolved records into one total. Unavailability propagates exactly as it
 * does in {@link aggregateCost} — one unpriced record makes the total
 * unavailable rather than silently understating it (ADR 0020).
 */
export function aggregatePricedRecords(records: readonly PricedRecord[]): CostResult {
  return aggregateCost(
    records.map((record) =>
      record.cost === null
        ? ({ cost: null, unavailableReason: record.unavailableReason } as const)
        : ({ cost: record.cost, unavailableReason: null } as const),
    ),
  );
}

/**
 * What share of a total rests on fallback rates rather than published ones.
 *
 * This is the question ADR 0044 line 71 says the stamp exists to answer, and
 * answering it from freshly resolved records rather than from a stored column is
 * the whole of ADR 0065. `fallbackShare` is `null` for an empty set — a share of
 * nothing is undefined, not zero.
 */
export interface PricingSummary {
  readonly total: number;
  readonly fromTable: number;
  readonly fromFallback: number;
  readonly unpriced: number;
  readonly fallbackShare: number | null;
}

export function summarizePricing(records: readonly PricedRecord[]): PricingSummary {
  let fromTable = 0;
  let fromFallback = 0;
  let unpriced = 0;
  for (const record of records) {
    if (record.pricingSource === null) unpriced += 1;
    else if (record.pricingSource.kind === 'table') fromTable += 1;
    else fromFallback += 1;
  }
  const total = records.length;
  const priced = fromTable + fromFallback;
  return {
    total,
    fromTable,
    fromFallback,
    unpriced,
    fallbackShare: priced === 0 ? null : fromFallback / priced,
  };
}

/**
 * ## Editing the table
 *
 * Everything below serves the operator's surface over these rows — the four
 * declarations an editor needs and the one rule that says whether what they typed
 * is a rate. It is deliberately in core rather than in the page or the handler,
 * because **both** of them ask the same question and a form that accepts what the
 * server rejects is worse than no validation at all: the operator is told their
 * correction landed, and the corpus reprices to something else.
 *
 * Still no effective dating. Nothing here takes a date, returns one, or orders two
 * rows in time — a rate is edited in place and the previous value is gone, which
 * is what ADR 0044 means by one current rate per model.
 */

/** The four buckets a rate row prices, in the order an editor shows them. */
export const RATE_FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead'] as const;

export type RateField = (typeof RATE_FIELDS)[number];

/** What each bucket is called in prose. The wire keys stay camelCase. */
export const RATE_FIELD_LABELS = {
  input: 'Input',
  output: 'Output',
  cacheWrite: 'Cache write',
  cacheRead: 'Cache read',
} as const satisfies Record<RateField, string>;

/**
 * Why a value is not a rate, as a value rather than a sentence.
 *
 * Typed for the same reason {@link CostUnavailableReason} is: the page renders one
 * of these beside the field the operator is typing in, and it should be able to
 * act on the kind without parsing the message.
 */
export type RateProblem =
  | { readonly kind: 'not-a-number'; readonly text: string }
  | { readonly kind: 'negative'; readonly value: number }
  | { readonly kind: 'too-precise'; readonly value: number };

/** One field's parse: a usable rate, `null` for not configured, or what is wrong. */
export type RateFieldParse =
  | { readonly ok: true; readonly value: number | null }
  | { readonly ok: false; readonly problem: RateProblem };

/**
 * Only decimal digits with at most one point, and an optional leading sign.
 *
 * Deliberately narrower than `Number()`, which accepts `0x1f`, `1e5` and
 * `Infinity`. None of those is a rate anybody means to type, and each would be
 * silently accepted and then stored — a rate table is an operator-edited dimension
 * table, so the failure mode to avoid is a plausible-looking typo becoming a
 * price. The sign is matched here rather than rejected, so a negative number
 * reports {@link RateProblem} `negative` and names its value instead of being
 * lumped in with `abc`.
 */
const RATE_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * How many decimals a rate may carry.
 *
 * Six, because that is what `pricing.ts`'s `RATE_PATTERN` already accepts when it
 * reads a rate out of the catalogue, and a table an operator types into must not
 * accept a value the rest of the pricing path would refuse. The number lives here
 * as well as there because the two are read in different places, but it is one
 * decision rather than two — change both together or neither.
 */
export const RATE_MAX_DECIMALS = 6;

function decimalsOf(value: number): number {
  const point = String(value).indexOf('.');
  return point === -1 ? 0 : String(value).length - point - 1;
}

/**
 * Whether an already-numeric rate is usable, or `null` when it is.
 *
 * The shared half of the rule: {@link parseRateField} calls it after turning text
 * into a number, and a handler receiving JSON calls it directly, so the two cannot
 * drift. `null` in means not configured, which is always allowed — that is the
 * absence of a rate, not a bad one.
 */
export function checkRateValue(value: number | null): RateProblem | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return { kind: 'not-a-number', text: String(value) };
  if (value < 0) return { kind: 'negative', value };
  if (decimalsOf(value) > RATE_MAX_DECIMALS) return { kind: 'too-precise', value };
  return null;
}

/**
 * One field as the operator typed it.
 *
 * **Blank is `null`, not zero.** That is the whole of the distinction this table
 * turns on: `0` is a real price for a bucket that genuinely costs nothing, and
 * `null` is the absence of a defensible rate, which makes a *consumed* bucket's
 * cost unavailable rather than free. An editor that coerced blank to zero would
 * quietly bill an unpriced model at nothing.
 */
export function parseRateField(text: string): RateFieldParse {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!RATE_TEXT.test(trimmed)) return { ok: false, problem: { kind: 'not-a-number', text: trimmed } };
  const value = Number(trimmed);
  const problem = checkRateValue(value);
  return problem === null ? { ok: true, value } : { ok: false, problem };
}

/**
 * The problem as a sentence naming what is wrong — never a generic failure.
 *
 * It says what was typed and what a rate is, because the message appears at the
 * field while the operator is still in it: "invalid input" would make them guess
 * which of the four they got wrong.
 */
export function rateProblemMessage(problem: RateProblem): string {
  switch (problem.kind) {
    case 'negative':
      return "A rate can't be negative. Use 0 for a free bucket.";
    case 'too-precise':
      return `${RATE_MAX_DECIMALS} decimal places at most.`;
    default:
      return 'Enter a number, like 3 or 0.25.';
  }
}

/** Why a model name is not usable as a key. */
export type ModelNameProblem = { readonly kind: 'empty' } | { readonly kind: 'taken'; readonly model: string };

export function modelNameProblemMessage(problem: ModelNameProblem): string {
  return problem.kind === 'empty'
    ? 'A rate row needs a model name — this is the exact name the proxy records, matched in full.'
    : `The table already has a row for "${problem.model}". Edit that row instead of adding a second one.`;
}

/**
 * Whether `model` can be added to a table already holding `existing`.
 *
 * The duplicate check runs on the **normalized** key, so `Claude-Opus-5 ` and
 * `claude-opus-5` are caught as one row rather than added as two that then race to
 * price the same model.
 */
export function checkModelName(model: string, existing: Iterable<string>): ModelNameProblem | null {
  const key = normalizeModelKey(model);
  if (key === '') return { kind: 'empty' };
  for (const other of existing) {
    if (normalizeModelKey(other) === key) return { kind: 'taken', model: other };
  }
  return null;
}

/** One stored rate row, as the wire carries it. */
export interface StoredModelRate {
  readonly model: string;
  readonly rates: RateRow;
  readonly updatedAt: string;
}

/** The proxy's declared fallback, as the wire carries it. */
export interface StoredFallbackRate {
  readonly proxy: string;
  readonly rates: RateRow;
  readonly updatedAt: string;
}

/**
 * The whole editable table in one payload: every row, and the fallback rows fall
 * through to.
 *
 * The fallback rides along because it is what makes a *deleted* row's consequence
 * legible — remove a model and it prices at the fallback if one is declared, and
 * resolves unknown if none is. An editor that showed the rows alone could not say
 * which of those two a delete would cause.
 */
export interface RateTableSnapshot {
  readonly proxy: string;
  readonly models: readonly StoredModelRate[];
  readonly fallback: StoredFallbackRate | null;
}
