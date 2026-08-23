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
 * The store's second half is the **judgement layer**: the rules are pattern
 * matches with high recall and no judgment, so some of what they report is simply
 * wrong. `dismissed` records that, and a per-bucket `judged` record says an agent
 * has already adjudicated that window — see {@link bucketJudgementState}.
 *
 * Pure: no I/O, no clock (callers pass `now`). The reading and writing of the
 * file lives in the server package.
 */

import type { Severity } from './advice.js';
import {
  type JsonValue,
  jsonArray,
  jsonEntries,
  jsonNumber,
  jsonObject,
  jsonText,
  jsonValueOf,
  objectAt,
  textAt,
} from './json.js';
import { isThinPass, parseWriteProvenance, type WriteProvenance } from './provenance.js';
import { type SessionBucket, SUGGESTION_DEFECT_THRESHOLDS, type SuggestionSource } from './suggestions.js';

/**
 * The flags a suggestion can carry. `pending` is the default.
 *
 * `skipped` and `dismissed` are different claims and must not be conflated:
 * `skipped` means the finding was right and was deliberately passed over,
 * `dismissed` means **the rule was wrong here**. A `skipped` may be worth
 * revisiting; a `dismissed` never is.
 */
export const SUGGESTION_STATUSES = ['pending', 'done', 'skipped', 'dismissed'] as const;

export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/** What a suggestion is until someone says otherwise. */
export const DEFAULT_SUGGESTION_STATUS: SuggestionStatus = 'pending';

/**
 * True when `value` names one of the flags.
 *
 * Generic in its input: the guard runs on CLI argv and HTTP bodies, and each
 * caller keeps its own type alongside the answer.
 */
export function isSuggestionStatus<Candidate>(value: Candidate): value is Candidate & SuggestionStatus {
  const found = jsonText(jsonValueOf(value));
  return found !== null && SUGGESTION_STATUSES.some((status) => status === found);
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
 * That an agent has adjudicated one bucket, and what it recorded while doing so.
 *
 * `notes` is the judge's **enrichment**: the context a confirmed suggestion needs
 * for someone to act on it, keyed by suggestion id. It lives here rather than on
 * the suggestion's own entry for two reasons, both structural:
 *
 * - A confirmed suggestion is still `pending`, and a pending entry cannot persist
 *   at all — it is dropped on read and deleted on write, which is exactly what
 *   makes `Pending` the undo.
 * - The entry's single `note` is overwritten by whoever marks the suggestion
 *   `done -n "<PR url>"`, so anything written there is clobbered by the act of
 *   fixing it.
 *
 * Bucket-level storage keeps `note` single-purpose and the judge's context
 * unclobberable.
 */
export interface SuggestionJudgement {
  /** ISO timestamp of the write that recorded the verdict. */
  at: string;
  /** Suggestion id → the judge's context for it. Empty when it had nothing to add. */
  notes: Record<string, string>;
  /**
   * Which agent judged the window and how much of it that agent opened. Absent on
   * a verdict recorded before provenance existed, or one whose caller passed no
   * thread id — unattributed, not invalid.
   */
  by?: WriteProvenance;
}

/**
 * The persisted file: bucket index (as a string key) → suggestion id → entry, plus
 * the per-bucket judgement records. Versioned so a shape change is migrated rather
 * than guessed at — a v1 file simply has no `judged`, which reads as `{}`.
 */
export interface SuggestionStatusStore {
  version: 2;
  buckets: Record<string, Record<string, SuggestionStatusEntry>>;
  /** Bucket index (as a string key) → what the judge recorded about that window. */
  judged: Record<string, SuggestionJudgement>;
}

/** A store with nothing recorded — what a missing file reads as. */
export function emptySuggestionStatusStore(): SuggestionStatusStore {
  return { version: 2, buckets: {}, judged: {} };
}

/**
 * Read an untrusted parsed JSON value as a store, dropping anything malformed.
 * A corrupt file costs the flags it held, never a crash on an otherwise healthy
 * dashboard — the suggestions underneath are recomputed regardless.
 *
 * This is also the v1 → v2 migration: a file written before the judgement layer
 * carries no `judged` key, and defaulting it to `{}` is the whole of what that
 * upgrade needs. Every bucket in such a file therefore reads as unjudged, which
 * is true.
 */
export function parseSuggestionStatusStore(raw: JsonValue): SuggestionStatusStore {
  const store = emptySuggestionStatusStore();
  const source = jsonObject(raw);
  if (source === null) return store;

  for (const [bucketKey, entries] of jsonEntries(objectAt(source, 'buckets'))) {
    const index = bucketIndexOf(bucketKey);
    if (index === null) continue;
    const rows = jsonObject(entries);
    if (rows === null) continue;
    const kept: Record<string, SuggestionStatusEntry> = {};
    for (const [id, entry] of jsonEntries(rows)) {
      const flag = jsonObject(entry);
      if (!id || flag === null) continue;
      const status = flag.status;
      if (!isSuggestionStatus(status) || status === DEFAULT_SUGGESTION_STATUS) continue;
      const decided: SuggestionStatusEntry = { status, updated: textAt(flag, 'updated') };
      const note = textAt(flag, 'note');
      if (note) decided.note = note;
      kept[id] = decided;
    }
    if (Object.keys(kept).length > 0) store.buckets[String(index)] = kept;
  }

  for (const [bucketKey, verdict] of jsonEntries(objectAt(source, 'judged'))) {
    const index = bucketIndexOf(bucketKey);
    if (index === null) continue;
    const fields = jsonObject(verdict);
    if (fields === null) continue;
    const kept: Record<string, string> = {};
    for (const [id, note] of jsonEntries(objectAt(fields, 'notes'))) {
      const text = jsonText(note);
      if (id && text) kept[id] = text;
    }
    // A record with no timestamp and no notes still means "judged", which is the
    // whole claim — `--amnesty` writes exactly that.
    const provenance = parseWriteProvenance(fields.by);
    const judgement: SuggestionJudgement = { at: textAt(fields, 'at'), notes: kept };
    if (provenance) judgement.by = provenance;
    store.judged[String(index)] = judgement;
  }
  return store;
}

/** A store key read as a bucket index, or null when it isn't one. */
function bucketIndexOf(key: string): number | null {
  const index = Number(key);
  return Number.isInteger(index) && index >= 1 ? index : null;
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

/**
 * True when `value` names one of the four recurrence states. Generic for the same
 * reason as {@link isSuggestionStatus}: its callers are argv and request bodies.
 */
export function isSuggestionRecurrence<Candidate>(value: Candidate): value is Candidate & SuggestionRecurrence {
  const found = jsonText(jsonValueOf(value));
  return found !== null && SUGGESTION_RECURRENCES.some((recurrence) => recurrence === found);
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
 *
 * Only `done` is a claim. `skipped` and `dismissed` are both decisions about one
 * window and neither asserts a fix landed, so neither can produce a recurrence
 * state — a `dismissed` rule is one that was *wrong*, and reading a regression off
 * it would be reading a fix off a finding that never existed.
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
      const resolution: SuggestionResolution = { bucket, updated: entry.updated };
      if (entry.note) resolution.note = entry.note;
      latest.set(id, resolution);
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
 *
 * The `judged` records are carried through untouched. That separation is
 * deliberate: un-dismissing a suggestion must not re-dirty its bucket, or the
 * judge would revisit the window and re-dismiss the thing a human just undid.
 */
export function applySuggestionStatusUpdates(
  store: SuggestionStatusStore,
  updates: readonly SuggestionStatusUpdate[],
  now: Date = new Date(),
): SuggestionStatusStore {
  const next: SuggestionStatusStore = {
    version: 2,
    buckets: Object.fromEntries(Object.entries(store.buckets).map(([k, v]) => [k, { ...v }])),
    judged: Object.fromEntries(Object.entries(store.judged).map(([k, v]) => [k, { ...v, notes: { ...v.notes } }])),
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
    next.buckets[key] = { ...next.buckets[key], [update.id]: entry };
  }
  return next;
}

/**
 * Read untrusted input (an HTTP body's `updates`, a CLI's argv) as updates, or
 * throw with the first thing wrong. Shared so the API and the command line refuse
 * exactly the same shapes.
 */
export function parseSuggestionStatusUpdates<Candidate>(raw: Candidate): SuggestionStatusUpdate[] {
  const items = jsonArray(jsonValueOf(raw));
  if (items === null) throw new Error('updates must be an array');
  if (items.length === 0) throw new Error('updates must not be empty');

  return items.map((item, i) => {
    const where = `updates[${i}]`;
    const fields = jsonObject(item);
    if (fields === null) throw new Error(`${where} must be an object`);
    const bucket = jsonNumber(fields.bucket);
    if (bucket === null || !Number.isInteger(bucket) || bucket < 1)
      throw new Error(`${where}.bucket must be an integer >= 1`);
    const id = jsonText(fields.id);
    if (id === null || !id.trim()) throw new Error(`${where}.id must be a non-empty string`);
    const status = fields.status;
    if (!isSuggestionStatus(status))
      throw new Error(`${where}.status must be one of ${SUGGESTION_STATUSES.join(', ')}`);
    const update: SuggestionStatusUpdate = { bucket, id: id.trim(), status };
    if (fields.note !== undefined) {
      const note = jsonText(fields.note);
      if (note === null) throw new Error(`${where}.note must be a string`);
      update.note = note;
    }
    return update;
  });
}

// --- The judgement layer ---------------------------------------------------

/** One bucket's verdict, as a caller asks for it to be recorded. */
export interface SuggestionJudgementWrite {
  bucket: number;
  /** Suggestion id → the judge's context. Omitted or empty records the verdict alone. */
  notes?: Record<string, string>;
  /**
   * Who is judging, and how much of this bucket they opened. Omitted records the
   * verdict unattributed. The caller derives it; the judge does not report it.
   */
  by?: WriteProvenance;
}

/**
 * Record judgements against a store, returning a new one — the input is never
 * mutated. A second judgement of the same bucket replaces the first, so a re-judge
 * is not an append.
 *
 * The suggestion flags are carried through untouched: dismissals are ordinary
 * status writes, and a caller that wants both in one file write composes this with
 * {@link applySuggestionStatusUpdates}.
 */
export function applySuggestionJudgements(
  store: SuggestionStatusStore,
  writes: readonly SuggestionJudgementWrite[],
  now: Date = new Date(),
): SuggestionStatusStore {
  const next: SuggestionStatusStore = {
    version: 2,
    buckets: Object.fromEntries(Object.entries(store.buckets).map(([k, v]) => [k, { ...v }])),
    judged: Object.fromEntries(Object.entries(store.judged).map(([k, v]) => [k, { ...v, notes: { ...v.notes } }])),
  };
  const at = now.toISOString();
  for (const write of writes) {
    const notes: Record<string, string> = {};
    for (const [id, text] of Object.entries(write.notes ?? {})) {
      if (id.trim() && text) notes[id.trim()] = text;
    }
    const judgement: SuggestionJudgement = { at, notes };
    if (write.by) judgement.by = write.by;
    next.judged[String(write.bucket)] = judgement;
  }
  return next;
}

/**
 * Read untrusted input as judgement writes, or throw with the first thing wrong.
 * Shared so the API and the command line refuse exactly the same shapes.
 */
export function parseSuggestionJudgements<Candidate>(raw: Candidate): SuggestionJudgementWrite[] {
  const items = jsonArray(jsonValueOf(raw));
  if (items === null) throw new Error('judged must be an array');
  if (items.length === 0) throw new Error('judged must not be empty');

  return items.map((item, i) => {
    const where = `judged[${i}]`;
    const fields = jsonObject(item);
    if (fields === null) throw new Error(`${where} must be an object`);
    const bucket = jsonNumber(fields.bucket);
    if (bucket === null || !Number.isInteger(bucket) || bucket < 1)
      throw new Error(`${where}.bucket must be an integer >= 1`);
    // An unreadable envelope is dropped rather than thrown on — refusing a verdict
    // over it would make the audit trail a precondition for what it audits.
    const provenance = parseWriteProvenance(fields.by);
    const write: SuggestionJudgementWrite = { bucket };
    if (provenance) write.by = provenance;
    if (fields.notes === undefined) return write;
    const notes = jsonObject(fields.notes);
    if (notes === null) throw new Error(`${where}.notes must be an object`);
    const kept: Record<string, string> = {};
    for (const [id, note] of jsonEntries(notes)) {
      const text = jsonText(note);
      if (text === null) throw new Error(`${where}.notes.${id} must be a string`);
      if (id.trim() && text) kept[id.trim()] = text;
    }
    write.notes = kept;
    return write;
  });
}

/**
 * Where a bucket stands with the judge.
 *
 * - `not-ready` — a partial window, short of {@link SESSION_BUCKET_SIZE}. It will
 *   gain sessions and its rules will re-fire over a different window, so there is
 *   nothing stable to judge yet. Never judged, never improved upon.
 * - `dirty` — complete, and nothing recorded against it. Work to do.
 * - `clean` — complete, and a judgement is on record.
 */
export const BUCKET_JUDGEMENT_STATES = ['not-ready', 'dirty', 'clean'] as const;

export type BucketJudgementState = (typeof BUCKET_JUDGEMENT_STATES)[number];

/**
 * Which of the three states one bucket is in.
 *
 * **Read off the bucket only, never off its suggestion entries.** Deriving
 * cleanliness from "does every suggestion carry a decision" would make the
 * `Pending` undo re-dirty the window — that undo *deletes* the entry — so the judge
 * would run again and re-dismiss precisely what a human had just un-dismissed.
 * Keeping the flag at bucket level breaks that loop: a human override survives,
 * because the judge never revisits a clean bucket.
 */
export function bucketJudgementState(
  bucket: Pick<SessionBucket, 'index' | 'complete'>,
  store: SuggestionStatusStore,
): BucketJudgementState {
  if (!bucket.complete) return 'not-ready';
  return store.judged[String(bucket.index)] ? 'clean' : 'dirty';
}

/** One bucket as the `buckets` listing reports it. */
export interface BucketJudgementRow {
  bucket: number;
  /** The bucket's session span, e.g. `"11–20"`. */
  label: string;
  complete: boolean;
  state: BucketJudgementState;
  /** ISO timestamp of the verdict, when there is one. Empty on an undated record. */
  judgedAt?: string;
  /** How many suggestions the judge left context on. */
  notes?: number;
  /** How many suggestions the window currently carries. */
  suggestions: number;
  /** Who judged it and how much of it they opened. Absent on an unattributed verdict. */
  by?: WriteProvenance;
  /** True only when `by` measures a pass under {@link THIN_PASS_RATIO}. Advisory. */
  thin?: boolean;
}

/** Every bucket with its judgement state, oldest first. */
export function bucketJudgements(
  buckets: readonly SessionBucket[],
  store: SuggestionStatusStore,
): BucketJudgementRow[] {
  return buckets
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((bucket) => {
      const record = store.judged[String(bucket.index)];
      const row: BucketJudgementRow = {
        bucket: bucket.index,
        label: bucket.label,
        complete: bucket.complete,
        state: bucketJudgementState(bucket, store),
        suggestions: bucket.suggestions.length,
      };
      if (record?.at) row.judgedAt = record.at;
      const notes = Object.keys(record?.notes ?? {}).length;
      if (notes > 0) row.notes = notes;
      if (record?.by) row.by = record.by;
      if (isThinPass(record?.by)) row.thin = true;
      return row;
    });
}

/** How many buckets sit in each judgement state. */
export function countBucketJudgementStates(rows: readonly BucketJudgementRow[]): Record<BucketJudgementState, number> {
  // SAFETY: `Object.fromEntries` widens its key type to `string`, because it cannot
  // see where the keys came from. The `map` above walks `BUCKET_JUDGEMENT_STATES`,
  // the tuple `BucketJudgementState` is derived from, so every member of that union
  // is present as a key and no other key is — which is what the assertion states.
  const counts = Object.fromEntries(BUCKET_JUDGEMENT_STATES.map((s) => [s, 0])) as Record<BucketJudgementState, number>;
  for (const row of rows) counts[row.state]++;
  return counts;
}

/**
 * The sessions that would move every bucket boundary if they were bucketed.
 *
 * Membership is ordered by `(a.started ?? '').localeCompare(b.started ?? '')`, so a
 * session with no `started` sorts ahead of every real timestamp, lands at the front
 * of bucket 1, and shifts every boundary after it by one — silently re-pointing
 * every stored verdict at sessions it never examined. Judging is refused while any
 * exist rather than recording verdicts against indexes that are about to move.
 */
export function unstartedSessions<T extends { started: string | null; threadId: string }>(sessions: readonly T[]): T[] {
  return sessions.filter((s) => !s.started);
}

/**
 * Throw unless the corpus can be bucketed stably, naming the sessions at fault so
 * the offender can be fixed rather than hunted for.
 */
export function assertJudgeableCorpus<T extends { started: string | null; threadId: string }>(
  sessions: readonly T[],
): void {
  const bad = unstartedSessions(sessions);
  if (bad.length === 0) return;
  const named = bad
    .slice(0, 5)
    .map((s) => s.threadId)
    .join(', ');
  const more = bad.length > 5 ? `, and ${bad.length - 5} more` : '';
  throw new Error(
    `refusing to judge: ${bad.length} session${bad.length === 1 ? '' : 's'} carry no start timestamp, ` +
      `which would shift every bucket boundary and re-point stored verdicts at sessions they never examined — ` +
      `${named}${more}`,
  );
}

// --- Rule-level defects ----------------------------------------------------

/** A rule dismissed often enough that the rule, not the window, is the problem. */
export interface RuleDefect {
  /** The rule's id — the same id its suggestions carry. */
  id: string;
  /** Complete buckets the rule was dismissed in. */
  dismissed: number;
  /** Complete buckets it fired in — the denominator. */
  fired: number;
  /** `dismissed / fired`, 0–1, rounded to two places. */
  ratio: number;
  /** Oldest and newest bucket the dismissals span — the age of the record, at a glance. */
  span: { from: number; to: number };
  /**
   * Judged complete buckets after `span.to` that recorded no dismissal of this rule.
   * A long tail is the evidence that the rule was repaired: dismissals stopped.
   */
  cleanTail: number;
  /**
   * True when {@link RuleDefect.cleanTail} cleared
   * {@link SUGGESTION_DEFECT_THRESHOLDS.minCleanTailBuckets} — the counts still indict
   * the rule, but every one of them predates a fix. Reported apart from the live
   * defects rather than dropped, so the record stays readable.
   */
  stale: boolean;
  /** Why it was suppressed, ready to print. Absent on a live defect. */
  staleReason?: string;
  /** Each dismissal, oldest bucket first, with the reason recorded for it. */
  buckets: RuleDismissal[];
}

/** One bucket a rule was dismissed in, and the reason the dismissal recorded. */
export interface RuleDismissal {
  bucket: number;
  /** The dismissing entry's note, when it carried one. */
  reason?: string;
}

/**
 * Rules whose dismissals have accumulated past
 * {@link SUGGESTION_DEFECT_THRESHOLDS} — dismissed in enough buckets *and* in
 * enough of the buckets they fired in. This is the point of keeping dismissals at
 * all: repeated noise about one rule is evidence the *rule* needs fixing, not a
 * chore to redo every ten sessions.
 *
 * Only complete buckets count on either side. A partial window is never judged, so
 * counting it in the denominator would dilute every ratio by a window that can
 * never contribute a dismissal.
 *
 * Each defect also carries the **age** of its record — the span of the dismissals, the
 * newest one, and how many judged buckets have passed since without another — and is
 * marked `stale` once that tail clears
 * {@link SUGGESTION_DEFECT_THRESHOLDS.minCleanTailBuckets}. A repaired rule keeps its
 * dismissals forever, so without this a fixed rule is reported as a live defect until
 * someone remembers the fix; see that constant for why the tail is the signal and why
 * five is where it sits. Stale defects are returned rather than dropped, last, so a
 * caller can show them as history instead of as work.
 *
 * Live first, then worst first within each half: most dismissals, then highest ratio,
 * then id.
 */
export function ruleDefects(buckets: readonly SessionBucket[], store: SuggestionStatusStore): RuleDefect[] {
  const fired = new Map<string, Set<number>>();
  const complete = new Set<number>();
  for (const bucket of buckets) {
    if (!bucket.complete) continue;
    complete.add(bucket.index);
    for (const suggestion of bucket.suggestions) {
      const seen = fired.get(suggestion.id);
      if (seen) seen.add(bucket.index);
      else fired.set(suggestion.id, new Set([bucket.index]));
    }
  }

  const dismissals = new Map<string, RuleDismissal[]>();
  for (const [bucketKey, entries] of Object.entries(store.buckets)) {
    const bucket = Number(bucketKey);
    if (!complete.has(bucket)) continue;
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.status !== 'dismissed') continue;
      // A rule can stop firing after being dismissed — the dismissal still counts,
      // and still needs a denominator, so record the bucket as one it fired in.
      const seen = fired.get(id);
      if (seen) seen.add(bucket);
      else fired.set(id, new Set([bucket]));
      const list = dismissals.get(id) ?? [];
      const dismissal: RuleDismissal = { bucket };
      if (entry.note) dismissal.reason = entry.note;
      list.push(dismissal);
      dismissals.set(id, list);
    }
  }

  // The windows an agent actually looked at. A bucket nobody judged carries no verdict
  // either way, so it can neither indict a rule nor clear one.
  const judged = [...complete].filter((index) => store.judged[String(index)]).sort((a, b) => a - b);

  const out: RuleDefect[] = [];
  for (const [id, hits] of dismissals) {
    const total = fired.get(id)?.size ?? hits.length;
    const ratio = total === 0 ? 0 : hits.length / total;
    if (hits.length < SUGGESTION_DEFECT_THRESHOLDS.minDismissedBuckets) continue;
    if (ratio < SUGGESTION_DEFECT_THRESHOLDS.minDismissedRatio) continue;
    const ordered = hits.slice().sort((a, b) => a.bucket - b.bucket);
    const from = ordered[0]!.bucket;
    const to = ordered[ordered.length - 1]!.bucket;
    const cleanTail = judged.filter((index) => index > to).length;
    const stale = cleanTail >= SUGGESTION_DEFECT_THRESHOLDS.minCleanTailBuckets;
    const defect: RuleDefect = {
      id,
      dismissed: hits.length,
      fired: total,
      ratio: Math.round(ratio * 100) / 100,
      span: { from, to },
      cleanTail,
      stale,
      buckets: ordered,
    };
    if (stale) {
      defect.staleReason =
        `every dismissal predates bucket ${to}, and the ${cleanTail} judged bucket${cleanTail === 1 ? '' : 's'} ` +
        `since ${to} recorded none — the record reads as already fixed rather than still misfiring`;
    }
    out.push(defect);
  }
  return out.sort(
    (a, b) =>
      Number(a.stale) - Number(b.stale) || b.dismissed - a.dismissed || b.ratio - a.ratio || a.id.localeCompare(b.id),
  );
}

/** One `<id>` or `<id>:<note>` entry, as the judge's command line spells it. */
export interface JudgeEntry {
  id: string;
  /** Empty when the entry carried no note. */
  note: string;
}

/**
 * Parse a `--confirm` / `--dismiss` value into `(id, note)` entries.
 *
 * A note is prose and prose contains commas, so splitting on every comma turns one
 * reason into a second bogus entry — worse than an error, since a fragment carrying
 * a colon would be written as a dismissal of a rule nobody named. So a value with
 * **no colon** is a plain comma-separated list of bare ids, and otherwise it splits
 * only at a comma **introducing a new entry**: one followed by an id-shaped token
 * and a colon.
 *
 * Repeating the flag is the escape hatch for anything this cannot see, and each
 * entry splits at its *first* colon so a reason may contain further ones.
 */
export function parseJudgeEntries(values: readonly string[]): JudgeEntry[] {
  const out: JudgeEntry[] = [];
  for (const value of values) {
    // A comma that starts the next `<id>:` — the only comma that is a separator.
    const parts = value.includes(':') ? value.split(/,(?=\s*[A-Za-z][\w-]*\s*:)/) : value.split(',');
    for (const rawPart of parts) {
      const part = rawPart.trim();
      if (!part) continue;
      const at = part.indexOf(':');
      const id = (at === -1 ? part : part.slice(0, at)).trim();
      if (!id) throw new Error(`invalid entry: ${part} (expected <id> or <id>:<note>)`);
      out.push({ id, note: at === -1 ? '' : part.slice(at + 1).trim() });
    }
  }
  return out;
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
  /** Where this row's bucket stands with the judge. See {@link bucketJudgementState}. */
  bucketState: BucketJudgementState;
  /** ISO timestamp of that bucket's verdict, when one is on record and dated. */
  judgedAt?: string;
  /** Who judged this row's bucket, and how much of it they opened. Absent when unattributed. */
  judgedBy?: WriteProvenance;
  /** The judge's context for this suggestion, from `judged[bucket].notes[id]`. */
  enrichment?: string;
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
  /** Only suggestions carrying one of these flags. Omit for every flag. */
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
        const judgement = store.judged[String(bucket.index)];
        const row: SuggestionStatusRow = {
          bucket: bucket.index,
          label: bucket.label,
          id: suggestion.id,
          severity: suggestion.severity,
          title: suggestion.title,
          status: entry.status,
          recurrence,
          bucketState: bucketJudgementState(bucket, store),
        };
        if (entry.updated) row.updated = entry.updated;
        if (entry.note) row.note = entry.note;
        if (recurrence !== 'none' && resolution) row.resolved = resolution;
        if (judgement?.at) row.judgedAt = judgement.at;
        if (judgement?.by) row.judgedBy = judgement.by;
        const enrichment = judgement?.notes[suggestion.id];
        if (enrichment) row.enrichment = enrichment;
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
  // Built from the enum so a new flag is counted without a second edit here.
  // SAFETY: the keys are exactly the members of `SUGGESTION_STATUSES`, the tuple
  // `SuggestionStatus` is derived from, so the object has one entry per member of
  // that union and none besides — the fact `Object.fromEntries`'s `string` key type
  // throws away.
  const counts = Object.fromEntries(SUGGESTION_STATUSES.map((s) => [s, 0])) as Record<SuggestionStatus, number>;
  for (const row of rows) counts[row.status]++;
  return counts;
}

/** How many rows sit in each recurrence state. */
export function countSuggestionRecurrences(rows: readonly SuggestionStatusRow[]): Record<SuggestionRecurrence, number> {
  // Built from the enum, like {@link countSuggestionStatuses}, so a fifth state is
  // counted without a second edit here.
  // SAFETY: the keys are exactly the members of `SUGGESTION_RECURRENCES`, the tuple
  // `SuggestionRecurrence` is derived from, so every recurrence state indexes the
  // object and nothing else does.
  const counts = Object.fromEntries(SUGGESTION_RECURRENCES.map((r) => [r, 0])) as Record<SuggestionRecurrence, number>;
  for (const row of rows) counts[row.recurrence]++;
  return counts;
}
