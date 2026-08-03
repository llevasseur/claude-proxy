/**
 * Suggestion status: which of a bucket's suggestions have actually been acted on.
 *
 * The suggestions themselves are recomputed from every transcript on each load
 * (see `suggestions.ts`) — they carry no state, so a rule that keeps tripping
 * keeps reappearing whether or not anyone did anything about it. This module adds
 * the one piece of state worth keeping: a flag per suggestion saying it was
 * applied, or deliberately passed over.
 *
 * The key is `(bucket index, suggestion id)`. Both halves are stable: buckets are
 * fixed windows of ten sessions numbered oldest-first, so bucket 3 covers the same
 * ten transcripts forever, and a suggestion's id is its rule's id, so the same
 * finding in the same window is the same row across recomputations.
 *
 * Because a window is frozen, a rule that tripped on sessions recorded last week
 * will trip on them forever, whatever changed since. A flag is therefore read as a
 * *dated* claim — see {@link suggestionRecurrence}.
 *
 * `pending` is the default and is never persisted — the file only carries
 * decisions, so it stays small and an empty file means "nothing done yet".
 *
 * Pure: no I/O, no clock (callers pass `now`). The reading and writing of the
 * file lives in the server package.
 */

import type { Severity } from './advice.js';
import type { SessionBucket, SuggestionSource } from './suggestions.js';

/** The flags a suggestion can carry. `pending` is the default. */
export const SUGGESTION_STATUSES = ['pending', 'done', 'skipped'] as const;

export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/** What a suggestion is until someone says otherwise. */
export const DEFAULT_SUGGESTION_STATUS: SuggestionStatus = 'pending';

/** True when `value` names one of the three flags. */
export function isSuggestionStatus(value: unknown): value is SuggestionStatus {
  return typeof value === 'string' && (SUGGESTION_STATUSES as readonly string[]).includes(value);
}

/** One recorded decision about one suggestion. */
export interface SuggestionStatusEntry {
  status: SuggestionStatus;
  /** ISO timestamp of the write that set it. */
  updated: string;
  /** Free text the writer attached — a PR link, why it was skipped. */
  note?: string;
}

/**
 * The persisted file: bucket index (as a string key) → suggestion id → entry.
 * Versioned so a future shape change can be migrated rather than guessed at.
 */
export interface SuggestionStatusStore {
  version: 1;
  buckets: Record<string, Record<string, SuggestionStatusEntry>>;
}

/** A store with nothing recorded — what a missing file reads as. */
export function emptySuggestionStatusStore(): SuggestionStatusStore {
  return { version: 1, buckets: {} };
}

/**
 * Read an untrusted parsed JSON value as a store, dropping anything malformed.
 * A corrupt file costs the flags it held, never a crash on an otherwise healthy
 * dashboard — the suggestions underneath are recomputed regardless.
 */
export function parseSuggestionStatusStore(raw: unknown): SuggestionStatusStore {
  const store = emptySuggestionStatusStore();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store;
  const buckets = (raw as { buckets?: unknown }).buckets;
  if (!buckets || typeof buckets !== 'object' || Array.isArray(buckets)) return store;

  for (const [bucketKey, entries] of Object.entries(buckets as Record<string, unknown>)) {
    const index = Number(bucketKey);
    if (!Number.isInteger(index) || index < 1) continue;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    const kept: Record<string, SuggestionStatusEntry> = {};
    for (const [id, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (!id || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const { status, updated, note } = entry as { status?: unknown; updated?: unknown; note?: unknown };
      if (!isSuggestionStatus(status) || status === DEFAULT_SUGGESTION_STATUS) continue;
      kept[id] = {
        status,
        updated: typeof updated === 'string' ? updated : '',
        ...(typeof note === 'string' && note ? { note } : {}),
      };
    }
    if (Object.keys(kept).length > 0) store.buckets[String(index)] = kept;
  }
  return store;
}

/** The flag recorded for one suggestion, or `pending` when none is. */
export function suggestionStatusOf(store: SuggestionStatusStore, bucket: number, id: string): SuggestionStatusEntry {
  const entry = store.buckets[String(bucket)]?.[id];
  return entry ?? { status: DEFAULT_SUGGESTION_STATUS, updated: '' };
}

/**
 * How a window's evidence stands against the dated `done` its rule carries.
 *
 * - `historical` — every session in the window predates the claim; nothing left to
 *   do about this window.
 * - `regressed` — every session started after the claim and the rule tripped anyway.
 * - `mixed` — the window straddles the claim, so its evidence proves nothing either way.
 * - `none` — no dated `done` for this rule, or the dates to compare are missing.
 *
 * Only `done` is a claim; `skipped` never produces a `regressed`.
 */
export const SUGGESTION_RECURRENCES = ['none', 'historical', 'mixed', 'regressed'] as const;

export type SuggestionRecurrence = (typeof SUGGESTION_RECURRENCES)[number];

/** True when `value` names one of the four recurrence states. */
export function isSuggestionRecurrence(value: unknown): value is SuggestionRecurrence {
  return typeof value === 'string' && (SUGGESTION_RECURRENCES as readonly string[]).includes(value);
}

/** The claim a rule carries: the latest dated `done` recorded for it, in any bucket. */
export interface SuggestionResolution {
  /** The bucket whose flag carried the claim. */
  bucket: number;
  /** ISO timestamp of that write — when the fix is claimed to have landed. */
  updated: string;
  note?: string;
}

/**
 * Collapse the store into one dated claim per rule id, keeping the most recent
 * `done`, so one mark carries across every window recorded afterwards.
 *
 * Entries with no parseable `updated` are skipped — an undated claim can't be
 * placed against a window.
 */
export function ruleResolutions(store: SuggestionStatusStore): Map<string, SuggestionResolution> {
  const latest = new Map<string, SuggestionResolution>();
  for (const [bucketKey, entries] of Object.entries(store.buckets)) {
    const bucket = Number(bucketKey);
    if (!Number.isInteger(bucket)) continue;
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.status !== 'done') continue;
      const at = Date.parse(entry.updated);
      if (Number.isNaN(at)) continue;
      const held = latest.get(id);
      if (held && Date.parse(held.updated) >= at) continue;
      latest.set(id, { bucket, updated: entry.updated, ...(entry.note ? { note: entry.note } : {}) });
    }
  }
  return latest;
}

/** Place one window against one rule's dated claim. Undated on either side reads as `none`. */
export function suggestionRecurrence(
  bucket: Pick<SessionBucket, 'startedFirst' | 'startedLast'>,
  resolution: SuggestionResolution | undefined,
): SuggestionRecurrence {
  if (!resolution) return 'none';
  const claimed = Date.parse(resolution.updated);
  const first = Date.parse(bucket.startedFirst ?? '');
  const last = Date.parse(bucket.startedLast ?? '');
  if (Number.isNaN(claimed) || Number.isNaN(first) || Number.isNaN(last)) return 'none';
  if (last <= claimed) return 'historical';
  if (first >= claimed) return 'regressed';
  return 'mixed';
}

/** One requested flag change. */
export interface SuggestionStatusUpdate {
  bucket: number;
  id: string;
  status: SuggestionStatus;
  /** Replaces any existing note. Pass `""` to clear it. */
  note?: string;
}

/**
 * Apply updates to a store, returning a new one — the input is never mutated.
 * Setting a suggestion back to `pending` deletes its entry (and its bucket, when
 * that empties it), which is what keeps the file to just the decisions made.
 */
export function applySuggestionStatusUpdates(
  store: SuggestionStatusStore,
  updates: readonly SuggestionStatusUpdate[],
  now: Date = new Date(),
): SuggestionStatusStore {
  const next: SuggestionStatusStore = {
    version: 1,
    buckets: Object.fromEntries(Object.entries(store.buckets).map(([k, v]) => [k, { ...v }])),
  };
  const updated = now.toISOString();

  for (const update of updates) {
    const key = String(update.bucket);
    if (update.status === DEFAULT_SUGGESTION_STATUS) {
      if (next.buckets[key]) {
        delete next.buckets[key][update.id];
        if (Object.keys(next.buckets[key]).length === 0) delete next.buckets[key];
      }
      continue;
    }
    const entry: SuggestionStatusEntry = { status: update.status, updated };
    // An explicit empty note clears; an absent one keeps whatever was there.
    const note = update.note ?? next.buckets[key]?.[update.id]?.note;
    if (note) entry.note = note;
    next.buckets[key] = { ...(next.buckets[key] ?? {}), [update.id]: entry };
  }
  return next;
}

/**
 * Read untrusted input (an HTTP body's `updates`, a CLI's argv) as updates, or
 * throw with the first thing wrong. Shared so the API and the command line refuse
 * exactly the same shapes.
 */
export function parseSuggestionStatusUpdates(raw: unknown): SuggestionStatusUpdate[] {
  if (!Array.isArray(raw)) throw new Error('updates must be an array');
  if (raw.length === 0) throw new Error('updates must not be empty');

  return raw.map((item, i) => {
    const where = `updates[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where} must be an object`);
    const { bucket, id, status, note } = item as Record<string, unknown>;
    if (!Number.isInteger(bucket) || (bucket as number) < 1) throw new Error(`${where}.bucket must be an integer >= 1`);
    if (typeof id !== 'string' || !id.trim()) throw new Error(`${where}.id must be a non-empty string`);
    if (!isSuggestionStatus(status))
      throw new Error(`${where}.status must be one of ${SUGGESTION_STATUSES.join(', ')}`);
    if (note !== undefined && typeof note !== 'string') throw new Error(`${where}.note must be a string`);
    return { bucket: bucket as number, id: id.trim(), status, ...(note === undefined ? {} : { note }) };
  });
}

/**
 * Parse a bucket range spec into ascending, de-duplicated bucket indexes.
 *
 * Accepts a single bucket (`"9"`), a comma-separated list (`"2,3,9"`), a span
 * (`"2-9"`, en dash accepted since the UI labels use one), and any mix of those
 * (`"2-4,9"`). Whitespace around the parts is ignored. Throws on anything else,
 * so a typo is a refusal rather than a silently empty run.
 */
export function parseBucketRange(spec: string): number[] {
  const out = new Set<number>();
  for (const rawPart of spec.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const span = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
    if (span) {
      const from = Number(span[1]);
      const to = Number(span[2]);
      if (from < 1 || to < 1) throw new Error(`invalid bucket range: ${part} (buckets start at 1)`);
      if (to < from) throw new Error(`invalid bucket range: ${part} (end is before start)`);
      for (let i = from; i <= to; i++) out.add(i);
      continue;
    }
    if (!/^\d+$/.test(part)) throw new Error(`invalid bucket range: ${part}`);
    const one = Number(part);
    if (one < 1) throw new Error(`invalid bucket range: ${part} (buckets start at 1)`);
    out.add(one);
  }
  if (out.size === 0) throw new Error('invalid bucket range: empty');
  return [...out].sort((a, b) => a - b);
}

/**
 * One suggestion as the status list reports it: enough to decide whether to work
 * on it, and the handle to mark it afterwards. Deliberately lean by default — the
 * `detail`/`evidence`/`sources` half is opt-in, so scanning a wide range stays
 * cheap while a caller about to act on a suggestion can get the whole thing
 * without a second round trip per bucket.
 */
export interface SuggestionStatusRow {
  bucket: number;
  /** The bucket's session span, e.g. `"11–20"`. */
  label: string;
  id: string;
  severity: Severity;
  title: string;
  status: SuggestionStatus;
  /** ISO timestamp of the flag's last write; absent while pending. */
  updated?: string;
  note?: string;
  /** How this window stands against its rule's dated `done`. See {@link suggestionRecurrence}. */
  recurrence: SuggestionRecurrence;
  /** The dated claim `recurrence` was measured against. Absent when there is none. */
  resolved?: SuggestionResolution;
  /** What to change, in the user's terms. Only with `detail`. */
  detail?: string;
  /** What the rule counted — the claim's arithmetic. Only with `detail`. */
  evidence?: string;
  /** The sessions it was counted in, strongest first. Only with `detail`. */
  sources?: SuggestionSource[];
}

export interface SuggestionStatusFilter {
  /** Only these bucket indexes. Omit for every bucket. */
  buckets?: readonly number[];
  /** Only suggestions carrying one of these flags. Omit for all three. */
  statuses?: readonly SuggestionStatus[];
  /** Only suggestions in one of these recurrence states. Omit for all four. */
  recurrences?: readonly SuggestionRecurrence[];
  /** Include each suggestion's detail, evidence and sources. Off by default. */
  detail?: boolean;
}

/**
 * Join computed buckets with recorded flags into the lean status list, oldest
 * bucket first so a range reads in the order the sessions happened.
 *
 * Buckets named in the filter that don't exist are simply absent from the result;
 * the caller reports them from `requested` vs what came back rather than this
 * function inventing empty rows.
 */
export function suggestionStatusRows(
  buckets: readonly SessionBucket[],
  store: SuggestionStatusStore,
  filter: SuggestionStatusFilter = {},
): SuggestionStatusRow[] {
  const wanted = filter.buckets ? new Set(filter.buckets) : null;
  const statuses = filter.statuses ? new Set<SuggestionStatus>(filter.statuses) : null;
  const recurrences = filter.recurrences ? new Set<SuggestionRecurrence>(filter.recurrences) : null;
  // Claims are rule-wide, so resolve the whole store once rather than per row.
  const resolutions = ruleResolutions(store);

  return buckets
    .filter((bucket) => !wanted || wanted.has(bucket.index))
    .slice()
    .sort((a, b) => a.index - b.index)
    .flatMap((bucket) =>
      bucket.suggestions.map((suggestion) => {
        const entry = suggestionStatusOf(store, bucket.index, suggestion.id);
        const resolution = resolutions.get(suggestion.id);
        const recurrence = suggestionRecurrence(bucket, resolution);
        const row: SuggestionStatusRow = {
          bucket: bucket.index,
          label: bucket.label,
          id: suggestion.id,
          severity: suggestion.severity,
          title: suggestion.title,
          status: entry.status,
          recurrence,
        };
        if (entry.updated) row.updated = entry.updated;
        if (entry.note) row.note = entry.note;
        if (recurrence !== 'none' && resolution) row.resolved = resolution;
        if (filter.detail) {
          row.detail = suggestion.detail;
          row.evidence = suggestion.evidence;
          row.sources = suggestion.sources;
        }
        return row;
      }),
    )
    .filter((row) => (!statuses || statuses.has(row.status)) && (!recurrences || recurrences.has(row.recurrence)));
}

/** How many rows carry each flag — the one-line summary a caller prints. */
export function countSuggestionStatuses(rows: readonly SuggestionStatusRow[]): Record<SuggestionStatus, number> {
  const counts: Record<SuggestionStatus, number> = { pending: 0, done: 0, skipped: 0 };
  for (const row of rows) counts[row.status]++;
  return counts;
}

/** How many rows sit in each recurrence state. */
export function countSuggestionRecurrences(rows: readonly SuggestionStatusRow[]): Record<SuggestionRecurrence, number> {
  const counts: Record<SuggestionRecurrence, number> = { none: 0, historical: 0, mixed: 0, regressed: 0 };
  for (const row of rows) counts[row.recurrence]++;
  return counts;
}
