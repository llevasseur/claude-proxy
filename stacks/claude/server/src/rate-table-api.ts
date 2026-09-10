import {
  checkRateValue,
  type RateField,
  type RateRow,
  type RateTableSnapshot,
  rateProblemMessage,
} from '@agent-proxy/claude-core';
import { CLAUDE_PROXY_ID } from './db/open.js';
import { deleteModelRate, listModelRates, readProxyFallbackRate, upsertModelRate } from './db/rate-table-store.js';
import { substrateDb } from './db/runtime.js';
import { type JsonInput, jsonField, jsonNumber, jsonObject, jsonString } from './json.js';

/**
 * The three routes behind the pricing page: read the table, correct one row, remove
 * one row.
 *
 * This file is the boundary and nothing more. The *rule* about what a rate may be
 * lives in core's `rate-table.ts` and is called from here rather than restated, so
 * the form and the handler agree by construction — a page that accepted what this
 * rejected would tell an operator their correction landed while the corpus repriced
 * to something else.
 *
 * ## Every write answers with the whole table
 *
 * A write returns the same {@link RateTableSnapshot} a read does, rather than an
 * acknowledgement. Two reasons, and both are about honesty rather than convenience.
 * The stored row is the *normalized* one, so an operator who typed `Claude-Opus-5 `
 * needs to see what was actually filed under. And a delete's consequence depends on
 * whether a fallback is declared — the row either reprices at the fallback or goes
 * unknown — which the caller can only show if the fallback comes back with it.
 *
 * ## Nothing here is dated
 *
 * No function takes a date, stores one, or reads a previous value before
 * overwriting. There is one current rate per model
 * ([ADR 0044](../../../../docs/adrs/0044-every-model-gets-a-price-row.md)), resolved
 * on every read ([ADR 0065](../../../../docs/adrs/0065-cost-is-resolved-at-read-time.md)),
 * so an edit reprices the whole corpus immediately and there is no history to keep.
 * `updatedAt` records when a row was last touched — it is a note about the edit, not
 * a date the rate applies from, and nothing resolves against it.
 */

/**
 * Raised when the request is not a usable edit. The message names what is wrong with
 * *which* field, because the page renders it beside that field.
 */
export class RateEditError extends Error {}

/**
 * What {@link RateTableUnavailableError} says, as a constant.
 *
 * Exported because `servePost` hands its status function the *message* rather than
 * the error, so the dispatcher tells this case from a bad request by comparing
 * against this rather than by re-typing the sentence at the call site.
 */
export const RATE_TABLE_UNAVAILABLE_MESSAGE = 'the rate table is unavailable — this server has no open substrate';

/** Raised when the substrate never opened, so there is no table to read or write. */
export class RateTableUnavailableError extends Error {
  constructor() {
    super(RATE_TABLE_UNAVAILABLE_MESSAGE);
  }
}

function db() {
  const handle = substrateDb();
  if (handle === null) throw new RateTableUnavailableError();
  return handle;
}

/** The table as it stands: every row, plus the fallback rows fall through to. */
export function readRateTableSnapshot(): RateTableSnapshot {
  const handle = db();
  const fallback = readProxyFallbackRate(handle, CLAUDE_PROXY_ID);
  return {
    proxy: CLAUDE_PROXY_ID,
    models: listModelRates(handle),
    fallback: fallback ?? null,
  };
}

/**
 * One rate off the wire.
 *
 * `null` and a missing key both mean **not configured**, which is a real state
 * rather than an omission — a bucket with no defensible rate makes a consumed
 * bucket's cost unavailable instead of free. Anything that is neither a number nor
 * null is rejected here rather than coerced: `Number("")` is `0`, and silently
 * turning a blank into a free bucket is the one mistake this table cannot afford.
 */
function rateFromJson(value: JsonInput, field: RateField): number | null {
  if (value === undefined || value === null) return null;
  // `jsonNumber` is this file's parser for the boundary: it answers `undefined`
  // for anything that is not a JSON number, and the absent case is already
  // returned above, so `undefined` here means present-but-not-a-number.
  const rate = jsonNumber(value);
  if (rate === undefined) throw new RateEditError(`${field}: expected a number or null`);
  const problem = checkRateValue(rate);
  if (problem !== null) throw new RateEditError(`${field}: ${rateProblemMessage(problem)}`);
  return rate;
}

function ratesFromJson(value: JsonInput): RateRow {
  const rates = jsonObject(value);
  if (rates === undefined) throw new RateEditError('rates: expected an object of the four rates');
  const read = (field: RateField) => rateFromJson(jsonField(rates, field), field);
  // Named rather than mapped so the result is a `RateRow` the compiler checked, not a
  // record that happens to carry the right keys today.
  return {
    input: read('input'),
    output: read('output'),
    cacheWrite: read('cacheWrite'),
    cacheRead: read('cacheRead'),
  };
}

function modelFromJson(value: JsonInput): string {
  const model = jsonString(value)?.trim();
  if (model === undefined || model === '') throw new RateEditError('model: a rate row needs a model name');
  return model;
}

/**
 * Add or correct one model's four rates, and answer with the table that results.
 *
 * The store normalizes the key, so this neither lower-cases nor trims beyond
 * rejecting a blank: doing it twice in two places is how the two would drift.
 */
export function applyModelRateEdit(body: JsonInput): RateTableSnapshot {
  const model = modelFromJson(jsonField(body, 'model'));
  const rates = ratesFromJson(jsonField(body, 'rates'));
  upsertModelRate(db(), model, rates);
  return readRateTableSnapshot();
}

/** What a delete answers: whether a row was there, and the table without it. */
export interface RateRowDeleted extends RateTableSnapshot {
  readonly removed: boolean;
}

/**
 * Remove one model's row.
 *
 * `removed: false` for a model the table did not hold is an outcome rather than an
 * error — two operators clearing the same stale row should both see the row gone,
 * not one of them see a failure.
 */
export function applyModelRateDelete(body: JsonInput): RateRowDeleted {
  const model = modelFromJson(jsonField(body, 'model'));
  const removed = deleteModelRate(db(), model);
  return { removed, ...readRateTableSnapshot() };
}
