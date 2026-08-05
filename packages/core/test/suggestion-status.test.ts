import { describe, expect, it } from 'vitest';
import {
  applySuggestionJudgements,
  applySuggestionStatusUpdates,
  assertJudgeableCorpus,
  bucketJudgementState,
  bucketJudgements,
  countBucketJudgementStates,
  countSuggestionRecurrences,
  countSuggestionStatuses,
  emptySuggestionStatusStore,
  parseBucketRange,
  parseJudgeEntries,
  parseSuggestionJudgements,
  parseSuggestionStatusStore,
  parseSuggestionStatusUpdates,
  ruleDefects,
  ruleResolutions,
  suggestionRecurrence,
  suggestionStatusOf,
  suggestionStatusRows,
  unstartedSessions,
} from '../src/suggestion-status.js';
import type { SessionBucket } from '../src/suggestions.js';

/** A bucket carrying just what the status join reads off it. */
function bucket(index: number, ids: string[], span?: { first: string; last: string }, complete = true): SessionBucket {
  const from = (index - 1) * 10 + 1;
  return {
    index,
    from,
    to: from + 9,
    label: `${from}–${from + 9}`,
    complete,
    startedFirst: span?.first ?? null,
    startedLast: span?.last ?? null,
    threadIds: [],
    stats: {
      sessions: 10,
      tasks: 0,
      decisions: 0,
      tools: 0,
      errors: 0,
      toolsPerTask: 0,
      unfinishedTasks: 0,
      topLevelTasks: 0,
      unfinishedSubagents: 0,
      subagentThreads: 0,
      discoveryRatio: 0,
      topTools: [],
    },
    suggestions: ids.map((id) => ({
      id,
      severity: 'warn' as const,
      title: `Fix ${id}`,
      detail: '',
      evidence: '',
      sources: [],
    })),
  };
}

const now = new Date('2026-07-26T12:00:00.000Z');

describe('parseBucketRange', () => {
  it('reads a single bucket, a list, a span, and a mix', () => {
    expect(parseBucketRange('9')).toEqual([9]);
    expect(parseBucketRange('2,3,9')).toEqual([2, 3, 9]);
    expect(parseBucketRange('2-5')).toEqual([2, 3, 4, 5]);
    expect(parseBucketRange(' 2 - 4 , 9 ')).toEqual([2, 3, 4, 9]);
  });

  it('accepts the en dash the bucket labels use', () => {
    expect(parseBucketRange('2–4')).toEqual([2, 3, 4]);
  });

  it('de-duplicates overlapping parts', () => {
    expect(parseBucketRange('2-4,3,4')).toEqual([2, 3, 4]);
  });

  it('refuses a typo rather than running over nothing', () => {
    expect(() => parseBucketRange('abc')).toThrow(/invalid bucket range/);
    expect(() => parseBucketRange('0')).toThrow(/buckets start at 1/);
    expect(() => parseBucketRange('9-2')).toThrow(/end is before start/);
    expect(() => parseBucketRange('')).toThrow(/empty/);
  });
});

describe('store', () => {
  it('defaults every suggestion to pending', () => {
    expect(suggestionStatusOf(emptySuggestionStatusStore(), 3, 'serial-discovery').status).toBe('pending');
  });

  it('records a flag without mutating the input store', () => {
    const before = emptySuggestionStatusStore();
    const after = applySuggestionStatusUpdates(
      before,
      [{ bucket: 3, id: 'serial-discovery', status: 'done', note: 'PR #71' }],
      now,
    );
    expect(before.buckets).toEqual({});
    expect(suggestionStatusOf(after, 3, 'serial-discovery')).toEqual({
      status: 'done',
      updated: now.toISOString(),
      note: 'PR #71',
    });
  });

  it('keeps an existing note when a later update omits one, and clears it on an empty note', () => {
    const done = applySuggestionStatusUpdates(
      emptySuggestionStatusStore(),
      [{ bucket: 1, id: 'a', status: 'done', note: 'PR #1' }],
      now,
    );
    const reflagged = applySuggestionStatusUpdates(done, [{ bucket: 1, id: 'a', status: 'skipped' }], now);
    expect(suggestionStatusOf(reflagged, 1, 'a').note).toBe('PR #1');
    const cleared = applySuggestionStatusUpdates(reflagged, [{ bucket: 1, id: 'a', status: 'skipped', note: '' }], now);
    expect(suggestionStatusOf(cleared, 1, 'a').note).toBeUndefined();
  });

  it('stores nothing for pending, so the file only carries decisions', () => {
    const done = applySuggestionStatusUpdates(
      emptySuggestionStatusStore(),
      [{ bucket: 1, id: 'a', status: 'done' }],
      now,
    );
    const back = applySuggestionStatusUpdates(done, [{ bucket: 1, id: 'a', status: 'pending' }], now);
    expect(back.buckets).toEqual({});
  });

  it('survives a corrupt file by dropping only what is malformed', () => {
    const parsed = parseSuggestionStatusStore({
      version: 1,
      buckets: {
        '1': { good: { status: 'done', updated: '2026-07-01T00:00:00.000Z' }, bad: { status: 'nonsense' }, worse: 7 },
        notANumber: { a: { status: 'done' } },
        '2': 'nope',
      },
    });
    expect(Object.keys(parsed.buckets)).toEqual(['1']);
    expect(Object.keys(parsed.buckets['1'] ?? {})).toEqual(['good']);
  });

  it('reads junk as empty rather than throwing', () => {
    expect(parseSuggestionStatusStore(null).buckets).toEqual({});
    expect(parseSuggestionStatusStore('nope').buckets).toEqual({});
    expect(parseSuggestionStatusStore([1, 2]).buckets).toEqual({});
  });
});

describe('suggestionStatusRows', () => {
  const buckets = [
    bucket(3, ['serial-discovery', 'redundant-reads']),
    bucket(1, ['blocked-guardrails']),
    bucket(2, ['high-tool-churn']),
  ];
  const store = applySuggestionStatusUpdates(
    emptySuggestionStatusStore(),
    [{ bucket: 3, id: 'serial-discovery', status: 'done' }],
    now,
  );

  it('lists oldest bucket first, whatever order the buckets came in', () => {
    expect(suggestionStatusRows(buckets, store).map((r) => `${r.bucket}/${r.id}`)).toEqual([
      '1/blocked-guardrails',
      '2/high-tool-churn',
      '3/serial-discovery',
      '3/redundant-reads',
    ]);
  });

  it('filters to a range and to a flag, which is how pending work is found', () => {
    const rows = suggestionStatusRows(buckets, store, { buckets: [2, 3], statuses: ['pending'] });
    expect(rows.map((r) => `${r.bucket}/${r.id}`)).toEqual(['2/high-tool-churn', '3/redundant-reads']);
  });

  it('carries the flag and its timestamp, and omits both while pending', () => {
    const [done] = suggestionStatusRows(buckets, store, { buckets: [3], statuses: ['done'] });
    expect(done).toMatchObject({
      bucket: 3,
      id: 'serial-discovery',
      status: 'done',
      updated: now.toISOString(),
      label: '21–30',
    });
    const [pending] = suggestionStatusRows(buckets, store, { buckets: [1] });
    expect(pending?.status).toBe('pending');
    expect(pending?.updated).toBeUndefined();
  });

  it('leaves detail out unless asked, so scanning a wide range stays lean', () => {
    const [lean] = suggestionStatusRows(buckets, store, { buckets: [1] });
    expect(lean?.detail).toBeUndefined();
    expect(lean?.sources).toBeUndefined();
    const [full] = suggestionStatusRows(buckets, store, { buckets: [1], detail: true });
    expect(full).toMatchObject({ detail: '', evidence: '', sources: [] });
  });

  it('counts the flags it returned', () => {
    expect(countSuggestionStatuses(suggestionStatusRows(buckets, store))).toEqual({
      pending: 3,
      done: 1,
      skipped: 0,
      dismissed: 0,
    });
  });
});

describe('parseSuggestionStatusUpdates', () => {
  it('accepts a well-formed batch', () => {
    expect(
      parseSuggestionStatusUpdates([{ bucket: 9, id: ' serial-discovery ', status: 'done', note: 'PR #71' }]),
    ).toEqual([{ bucket: 9, id: 'serial-discovery', status: 'done', note: 'PR #71' }]);
  });

  it('names the first thing wrong', () => {
    expect(() => parseSuggestionStatusUpdates('nope')).toThrow(/must be an array/);
    expect(() => parseSuggestionStatusUpdates([])).toThrow(/must not be empty/);
    expect(() => parseSuggestionStatusUpdates([{ bucket: 0, id: 'a', status: 'done' }])).toThrow(/updates\[0\].bucket/);
    expect(() => parseSuggestionStatusUpdates([{ bucket: 1, id: '', status: 'done' }])).toThrow(/updates\[0\].id/);
    expect(() => parseSuggestionStatusUpdates([{ bucket: 1, id: 'a', status: 'finished' }])).toThrow(
      /updates\[0\].status/,
    );
    expect(() => parseSuggestionStatusUpdates([{ bucket: 1, id: 'a', status: 'done', note: 7 }])).toThrow(
      /updates\[0\].note/,
    );
  });
});

describe('recurrence against a dated fix', () => {
  const fixedAt = new Date('2026-07-20T00:00:00.000Z');
  const before = { first: '2026-07-01T00:00:00.000Z', last: '2026-07-05T00:00:00.000Z' };
  const straddling = { first: '2026-07-15T00:00:00.000Z', last: '2026-07-25T00:00:00.000Z' };
  const after = { first: '2026-07-22T00:00:00.000Z', last: '2026-07-28T00:00:00.000Z' };

  const dated = [
    bucket(1, ['serial-discovery'], before),
    bucket(2, ['serial-discovery'], straddling),
    bucket(3, ['serial-discovery', 'redundant-reads'], after),
  ];
  const fixed = applySuggestionStatusUpdates(
    emptySuggestionStatusStore(),
    [{ bucket: 1, id: 'serial-discovery', status: 'done', note: 'PR #84' }],
    fixedAt,
  );

  it("carries one window's mark across every window, dated", () => {
    const rows = suggestionStatusRows(dated, fixed);
    expect(rows.map((r) => `${r.bucket}/${r.id}:${r.recurrence}`)).toEqual([
      '1/serial-discovery:historical',
      '2/serial-discovery:mixed',
      '3/serial-discovery:regressed',
      '3/redundant-reads:none',
    ]);
  });

  it('names the claim a regression broke, so it is not mistaken for a new finding', () => {
    const [regressed] = suggestionStatusRows(dated, fixed, { buckets: [3], recurrences: ['regressed'] });
    expect(regressed).toMatchObject({ bucket: 3, id: 'serial-discovery', status: 'pending', recurrence: 'regressed' });
    expect(regressed?.resolved).toEqual({ bucket: 1, updated: fixedAt.toISOString(), note: 'PR #84' });
  });

  it('leaves an unclaimed rule alone — no recurrence, no claim', () => {
    const [row] = suggestionStatusRows(dated, fixed, { buckets: [3], statuses: ['pending'], recurrences: ['none'] });
    expect(row).toMatchObject({ id: 'redundant-reads', recurrence: 'none' });
    expect(row?.resolved).toBeUndefined();
  });

  it('treats skipped as a decision, not a claim, so nothing regresses off it', () => {
    const skipped = applySuggestionStatusUpdates(
      emptySuggestionStatusStore(),
      [{ bucket: 1, id: 'serial-discovery', status: 'skipped' }],
      fixedAt,
    );
    expect(ruleResolutions(skipped).size).toBe(0);
    expect(suggestionStatusRows(dated, skipped).every((r) => r.recurrence === 'none')).toBe(true);
  });

  it('ignores an undated flag rather than inventing a regression from it', () => {
    const undated = parseSuggestionStatusStore({
      version: 1,
      buckets: { '1': { 'serial-discovery': { status: 'done' } } },
    });
    expect(undated.buckets['1']?.['serial-discovery']?.updated).toBe('');
    expect(ruleResolutions(undated).size).toBe(0);
    expect(suggestionStatusRows(dated, undated).every((r) => r.recurrence === 'none')).toBe(true);
  });

  it('cannot place a window whose sessions carry no start', () => {
    const rows = suggestionStatusRows([bucket(1, ['serial-discovery'])], fixed);
    expect(rows[0]?.recurrence).toBe('none');
  });

  it('keeps the most recent done when several windows carry one', () => {
    const again = applySuggestionStatusUpdates(
      fixed,
      [{ bucket: 2, id: 'serial-discovery', status: 'done', note: 'PR #91' }],
      new Date('2026-07-27T00:00:00.000Z'),
    );
    expect(ruleResolutions(again).get('serial-discovery')).toEqual({
      bucket: 2,
      updated: '2026-07-27T00:00:00.000Z',
      note: 'PR #91',
    });
    // Bucket 3 ran 07-22 → 07-28, so it now straddles the later claim rather than following it.
    const rows = suggestionStatusRows(dated, again, { buckets: [3], recurrences: ['mixed'] });
    expect(rows.map((r) => r.id)).toEqual(['serial-discovery']);
  });

  it('counts a session recorded at the moment of the mark as before it', () => {
    const claim = { bucket: 1, updated: fixedAt.toISOString() };
    expect(suggestionRecurrence({ startedFirst: before.first, startedLast: claim.updated }, claim)).toBe('historical');
    expect(suggestionRecurrence({ startedFirst: claim.updated, startedLast: after.last }, claim)).toBe('regressed');
    expect(suggestionRecurrence({ startedFirst: before.first, startedLast: after.last }, undefined)).toBe('none');
  });

  it('counts each recurrence state over the rows it returned', () => {
    expect(countSuggestionRecurrences(suggestionStatusRows(dated, fixed))).toEqual({
      none: 1,
      historical: 1,
      mixed: 1,
      regressed: 1,
    });
  });

  it('filters out the windows a fix predates, which is what leaves only actionable work', () => {
    const rows = suggestionStatusRows(dated, fixed, { recurrences: ['none', 'mixed', 'regressed'] });
    expect(rows.map((r) => `${r.bucket}/${r.id}`)).toEqual([
      '2/serial-discovery',
      '3/serial-discovery',
      '3/redundant-reads',
    ]);
  });

  // The recurrence model must be untouched by the judgement layer: `dismissed` says the
  // rule was wrong, which is the opposite of a claim that a fix landed.
  it('treats dismissed as no claim at all, so nothing regresses off it', () => {
    const dismissed = applySuggestionStatusUpdates(
      emptySuggestionStatusStore(),
      [{ bucket: 1, id: 'serial-discovery', status: 'dismissed', note: 'reads were dependent' }],
      fixedAt,
    );
    expect(ruleResolutions(dismissed).size).toBe(0);
    expect(suggestionStatusRows(dated, dismissed).every((r) => r.recurrence === 'none')).toBe(true);
    expect(countSuggestionRecurrences(suggestionStatusRows(dated, dismissed))).toEqual({
      none: 4,
      historical: 0,
      mixed: 0,
      regressed: 0,
    });
  });

  it('leaves the recurrence states alone when a judgement is recorded over them', () => {
    const before = suggestionStatusRows(dated, fixed).map((r) => `${r.bucket}/${r.id}:${r.recurrence}`);
    const judged = applySuggestionJudgements(fixed, [
      { bucket: 1 },
      { bucket: 3, notes: { 'redundant-reads': 'ctx' } },
    ]);
    expect(suggestionStatusRows(dated, judged).map((r) => `${r.bucket}/${r.id}:${r.recurrence}`)).toEqual(before);
  });
});

describe('judgement records', () => {
  const buckets = [
    bucket(1, ['serial-discovery', 'redundant-reads']),
    bucket(2, ['high-tool-churn'], undefined, false),
  ];

  it('records a verdict without mutating the input store', () => {
    const before = emptySuggestionStatusStore();
    const after = applySuggestionJudgements(
      before,
      [{ bucket: 1, notes: { 'redundant-reads': 'two files, not one' } }],
      now,
    );
    expect(before.judged).toEqual({});
    expect(after.judged['1']).toEqual({ at: now.toISOString(), notes: { 'redundant-reads': 'two files, not one' } });
  });

  it('records the verdict alone when there is nothing to enrich', () => {
    const after = applySuggestionJudgements(emptySuggestionStatusStore(), [{ bucket: 4 }], now);
    expect(after.judged['4']).toEqual({ at: now.toISOString(), notes: {} });
  });

  it('replaces a bucket’s earlier verdict rather than appending to it', () => {
    const first = applySuggestionJudgements(emptySuggestionStatusStore(), [{ bucket: 1, notes: { a: 'one' } }], now);
    const later = new Date('2026-07-27T12:00:00.000Z');
    const second = applySuggestionJudgements(first, [{ bucket: 1, notes: { b: 'two' } }], later);
    expect(second.judged['1']).toEqual({ at: later.toISOString(), notes: { b: 'two' } });
  });

  it('carries the verdict through an unrelated flag write', () => {
    const judged = applySuggestionJudgements(emptySuggestionStatusStore(), [{ bucket: 1, notes: { a: 'ctx' } }], now);
    const flagged = applySuggestionStatusUpdates(judged, [{ bucket: 1, id: 'serial-discovery', status: 'done' }], now);
    expect(flagged.judged['1']?.notes).toEqual({ a: 'ctx' });
  });

  // The loop this exists to break: the Pending undo deletes the entry, so deriving
  // cleanliness from the entries would re-dirty the bucket and the judge would
  // re-dismiss what a human just un-dismissed.
  it('keeps a bucket clean when a dismissal is undone', () => {
    const dismissed = applySuggestionStatusUpdates(
      emptySuggestionStatusStore(),
      [{ bucket: 1, id: 'serial-discovery', status: 'dismissed', note: 'wrong here' }],
      now,
    );
    const judged = applySuggestionJudgements(dismissed, [{ bucket: 1 }], now);
    expect(bucketJudgementState(buckets[0]!, judged)).toBe('clean');
    const undone = applySuggestionStatusUpdates(
      judged,
      [{ bucket: 1, id: 'serial-discovery', status: 'pending' }],
      now,
    );
    expect(undone.buckets['1']).toBeUndefined();
    expect(bucketJudgementState(buckets[0]!, undone)).toBe('clean');
  });

  it('never calls a partial window judged, however much is recorded against it', () => {
    const judged = applySuggestionJudgements(emptySuggestionStatusStore(), [{ bucket: 2 }], now);
    expect(bucketJudgementState(buckets[1]!, judged)).toBe('not-ready');
  });

  it('lists every bucket with its state, oldest first, and counts them', () => {
    const judged = applySuggestionJudgements(emptySuggestionStatusStore(), [{ bucket: 1, notes: { a: 'x' } }], now);
    const rows = bucketJudgements([buckets[1]!, buckets[0]!], judged);
    expect(rows.map((r) => `${r.bucket}:${r.state}`)).toEqual(['1:clean', '2:not-ready']);
    expect(rows[0]).toMatchObject({ label: '1–10', complete: true, judgedAt: now.toISOString(), notes: 1 });
    expect(rows[1]?.notes).toBeUndefined();
    expect(countBucketJudgementStates(rows)).toEqual({ 'not-ready': 1, dirty: 0, clean: 1 });
  });

  it('reads a dirty bucket as one that is complete with nothing on record', () => {
    expect(countBucketJudgementStates(bucketJudgements(buckets, emptySuggestionStatusStore()))).toEqual({
      'not-ready': 1,
      dirty: 1,
      clean: 0,
    });
  });

  it('puts the enrichment on the row, and on a still-pending suggestion', () => {
    const judged = applySuggestionJudgements(
      emptySuggestionStatusStore(),
      [{ bucket: 1, notes: { 'redundant-reads': 're-read api.ts 4×' } }],
      now,
    );
    const rows = suggestionStatusRows(buckets, judged, { buckets: [1] });
    expect(rows.map((r) => [r.id, r.status, r.enrichment])).toEqual([
      ['serial-discovery', 'pending', undefined],
      ['redundant-reads', 'pending', 're-read api.ts 4×'],
    ]);
    expect(rows[0]?.bucketState).toBe('clean');
    expect(rows[0]?.judgedAt).toBe(now.toISOString());
  });

  it('reads junk judgements as nothing rather than throwing', () => {
    const parsed = parseSuggestionStatusStore({
      version: 2,
      buckets: {},
      judged: { '1': { at: 7, notes: { a: 'keep', b: 9 } }, notANumber: { at: '' }, '2': 'nope', '3': { notes: [] } },
    });
    expect(Object.keys(parsed.judged).sort()).toEqual(['1', '3']);
    expect(parsed.judged['1']).toEqual({ at: '', notes: { a: 'keep' } });
    expect(parsed.judged['3']).toEqual({ at: '', notes: {} });
  });

  it('defaults judged to empty for a v1 file, which is the whole migration', () => {
    const parsed = parseSuggestionStatusStore({
      version: 1,
      buckets: { '1': { a: { status: 'done', updated: '2026-07-01T00:00:00.000Z' } } },
    });
    expect(parsed.version).toBe(2);
    expect(parsed.judged).toEqual({});
    expect(parsed.buckets['1']?.a?.status).toBe('done');
  });
});

describe('parseSuggestionJudgements', () => {
  it('accepts a bucket with and without notes', () => {
    expect(parseSuggestionJudgements([{ bucket: 3 }, { bucket: 4, notes: { ' a ': 'x', b: '' } }])).toEqual([
      { bucket: 3 },
      { bucket: 4, notes: { a: 'x' } },
    ]);
  });

  it('names the first thing wrong', () => {
    expect(() => parseSuggestionJudgements('nope')).toThrow(/must be an array/);
    expect(() => parseSuggestionJudgements([])).toThrow(/must not be empty/);
    expect(() => parseSuggestionJudgements([{ bucket: 0 }])).toThrow(/judged\[0\].bucket/);
    expect(() => parseSuggestionJudgements([{ bucket: 1, notes: 'nope' }])).toThrow(/judged\[0\].notes/);
    expect(() => parseSuggestionJudgements([{ bucket: 1, notes: { a: 7 } }])).toThrow(/judged\[0\].notes.a/);
  });
});

describe('parseJudgeEntries', () => {
  it('reads a bare id list when no note is given', () => {
    expect(parseJudgeEntries(['serial-discovery,redundant-reads'])).toEqual([
      { id: 'serial-discovery', note: '' },
      { id: 'redundant-reads', note: '' },
    ]);
  });

  it('splits an entry at its first colon, so a reason may contain more', () => {
    expect(parseJudgeEntries(['serial-discovery:see AGENTS.md: the reads were dependent'])).toEqual([
      { id: 'serial-discovery', note: 'see AGENTS.md: the reads were dependent' },
    ]);
  });

  // The bug this parser exists for: comma-splitting the whole value turned one
  // reason into a second entry naming a rule nobody mentioned.
  it('keeps a comma inside a reason out of the entry list', () => {
    expect(parseJudgeEntries(['high-tool-churn:one long migration, not many tasks'])).toEqual([
      { id: 'high-tool-churn', note: 'one long migration, not many tasks' },
    ]);
  });

  it('still separates two entries at the comma that introduces the second', () => {
    expect(parseJudgeEntries(['a:one, and more,b:two'])).toEqual([
      { id: 'a', note: 'one, and more' },
      { id: 'b', note: 'two' },
    ]);
  });

  it('accumulates repeated flags, which is the escape hatch for anything else', () => {
    expect(parseJudgeEntries(['a:first, tricky', 'b:second'])).toEqual([
      { id: 'a', note: 'first, tricky' },
      { id: 'b', note: 'second' },
    ]);
  });

  it('ignores empty parts and refuses an entry with no id', () => {
    expect(parseJudgeEntries(['a,,b'])).toEqual([
      { id: 'a', note: '' },
      { id: 'b', note: '' },
    ]);
    expect(() => parseJudgeEntries([':no id here'])).toThrow(/invalid entry/);
  });
});

describe('the bucket-index guard', () => {
  const ok = [
    { threadId: 'a', started: '2026-07-01T00:00:00.000Z' },
    { threadId: 'b', started: '2026-07-02T00:00:00.000Z' },
  ];

  it('passes a corpus where every session carries a start', () => {
    expect(unstartedSessions(ok)).toEqual([]);
    expect(() => assertJudgeableCorpus(ok)).not.toThrow();
  });

  it('refuses, and says which session is at fault', () => {
    const bad = [...ok, { threadId: 'no-start-here', started: null }];
    expect(unstartedSessions(bad).map((s) => s.threadId)).toEqual(['no-start-here']);
    expect(() => assertJudgeableCorpus(bad)).toThrow(/no-start-here/);
    expect(() => assertJudgeableCorpus(bad)).toThrow(/refusing to judge/);
  });

  it('caps how many it names but still reports the total', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ threadId: `s${i}`, started: null }));
    expect(() => assertJudgeableCorpus(many)).toThrow(/8 sessions carry no start/);
    expect(() => assertJudgeableCorpus(many)).toThrow(/and 3 more/);
  });
});

describe('ruleDefects', () => {
  /** `count` complete buckets, every one of them firing `ids`. */
  const firing = (count: number, ids: string[]): SessionBucket[] =>
    Array.from({ length: count }, (_, i) => bucket(i + 1, ids));

  const dismissAll = (buckets: readonly number[], id: string) =>
    applySuggestionStatusUpdates(
      emptySuggestionStatusStore(),
      buckets.map((b) => ({ bucket: b, id, status: 'dismissed' as const, note: `wrong in ${b}` })),
      now,
    );

  it('indicts a rule dismissed in enough buckets and enough of what it fired in', () => {
    const defects = ruleDefects(firing(4, ['serial-discovery']), dismissAll([1, 2, 3], 'serial-discovery'));
    expect(defects).toEqual([
      {
        id: 'serial-discovery',
        dismissed: 3,
        fired: 4,
        ratio: 0.75,
        buckets: [
          { bucket: 1, reason: 'wrong in 1' },
          { bucket: 2, reason: 'wrong in 2' },
          { bucket: 3, reason: 'wrong in 3' },
        ],
      },
    ]);
  });

  it('spares a rule that is usually right, however many dismissals it has', () => {
    // 3 dismissals clears the count, but 3 of 10 is under half.
    expect(ruleDefects(firing(10, ['serial-discovery']), dismissAll([1, 2, 3], 'serial-discovery'))).toEqual([]);
  });

  it('spares a rule dismissed every time it fired but too few times to tell', () => {
    expect(ruleDefects(firing(2, ['serial-discovery']), dismissAll([1, 2], 'serial-discovery'))).toEqual([]);
  });

  it('ignores a partial window on both sides of the ratio', () => {
    const buckets = [...firing(3, ['serial-discovery']), bucket(4, ['serial-discovery'], undefined, false)];
    const store = dismissAll([1, 2, 3, 4], 'serial-discovery');
    const [defect] = ruleDefects(buckets, store);
    // Bucket 4 is not ready, so neither its firing nor its dismissal is counted.
    expect(defect).toMatchObject({ dismissed: 3, fired: 3, ratio: 1 });
  });

  it('still counts a dismissal in a bucket the rule has since stopped firing in', () => {
    const buckets = [bucket(1, ['other']), bucket(2, ['other']), bucket(3, ['other'])];
    const [defect] = ruleDefects(buckets, dismissAll([1, 2, 3], 'serial-discovery'));
    expect(defect).toMatchObject({ id: 'serial-discovery', dismissed: 3, fired: 3 });
  });

  it('reads nothing off skipped or done — only a dismissal says the rule was wrong', () => {
    const store = applySuggestionStatusUpdates(
      emptySuggestionStatusStore(),
      [1, 2, 3].map((b) => ({ bucket: b, id: 'serial-discovery', status: 'skipped' as const })),
      now,
    );
    expect(ruleDefects(firing(3, ['serial-discovery']), store)).toEqual([]);
  });

  it('ranks the worst offender first', () => {
    const buckets = firing(4, ['serial-discovery', 'redundant-reads']);
    const store = applySuggestionStatusUpdates(
      emptySuggestionStatusStore(),
      [
        ...[1, 2, 3].map((b) => ({ bucket: b, id: 'redundant-reads', status: 'dismissed' as const })),
        ...[1, 2, 3, 4].map((b) => ({ bucket: b, id: 'serial-discovery', status: 'dismissed' as const })),
      ],
      now,
    );
    expect(ruleDefects(buckets, store).map((d) => d.id)).toEqual(['serial-discovery', 'redundant-reads']);
  });
});
