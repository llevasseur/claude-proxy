import { describe, expect, it } from 'vitest';
import {
  conceptFacets,
  exportJsonl,
  getConceptById,
  getConceptsByTerm,
  listConcepts,
  saveConcept,
  searchConcepts,
  toMatchQuery,
} from '../src/store.ts';
import { concept, testDb } from './harness.ts';

describe('saveConcept', () => {
  it('stores a concept and returns it with a sortable id', async () => {
    const db = testDb();
    const { concept: saved, created } = await saveConcept(db, concept());
    expect(created).toBe(true);
    expect(saved.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(saved.term).toBe('Backpressure');
    expect(await getConceptById(db, saved.id)).toMatchObject({ term: 'Backpressure' });
  });

  it('orders ids chronologically, since the timestamp is the id prefix', async () => {
    const db = testDb();
    const older = await saveConcept(db, concept({ term: 'A', savedAt: '2026-01-01T00:00:00.000Z' }));
    const newer = await saveConcept(db, concept({ term: 'B', savedAt: '2026-06-01T00:00:00.000Z' }));
    expect(older.concept.id < newer.concept.id).toBe(true);
  });

  it('is idempotent: replaying the identical record does not duplicate it', async () => {
    const db = testDb();
    const first = await saveConcept(db, concept());
    const second = await saveConcept(db, concept());
    expect(second.created).toBe(false);
    expect(second.concept.id).toBe(first.concept.id);
    expect(await listConcepts(db)).toHaveLength(1);
  });

  it('preserves absent optional fields rather than defaulting them to empty', async () => {
    const db = testDb();
    const { concept: saved } = await saveConcept(db, concept());
    const loaded = await getConceptById(db, saved.id);
    expect(loaded).not.toBeNull();
    expect('notes' in loaded!).toBe(false);
    expect('tips' in loaded!).toBe(false);
  });

  it('round-trips the optional detail fields when they are present', async () => {
    const db = testDb();
    const { concept: saved } = await saveConcept(
      db,
      concept({ notes: 'Long form.', tips: ['one', 'two'], sources: ['https://example.com'] }),
    );
    const loaded = await getConceptById(db, saved.id);
    expect(loaded?.tips).toEqual(['one', 'two']);
    expect(loaded?.sources).toEqual(['https://example.com']);
  });

  it('rejects a body that is not a concept', async () => {
    const db = testDb();
    await expect(saveConcept(db, { term: 'no timestamp' })).rejects.toThrow(/must be a concept/);
  });
});

describe('listConcepts', () => {
  it('returns the newest version per term and hides the superseded one', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'Idempotence', sentence: 'first', savedAt: '2026-01-01T00:00:00.000Z' }));
    await saveConcept(db, concept({ term: 'Idempotence', sentence: 'second', savedAt: '2026-02-01T00:00:00.000Z' }));

    const current = await listConcepts(db);
    expect(current).toHaveLength(1);
    expect(current[0]?.sentence).toBe('second');

    expect(await listConcepts(db, { includeSuperseded: true })).toHaveLength(2);
  });

  it('treats a term as the same concept regardless of case and spacing', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'write ahead log', savedAt: '2026-01-01T00:00:00.000Z' }));
    await saveConcept(db, concept({ term: 'Write  Ahead  Log', savedAt: '2026-02-01T00:00:00.000Z' }));
    const current = await listConcepts(db);
    expect(current).toHaveLength(1);
    expect(current[0]?.term).toBe('Write  Ahead  Log');
  });

  it('sorts newest first and carries the skills array', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'Old', savedAt: '2026-01-01T00:00:00.000Z' }));
    await saveConcept(db, concept({ term: 'New', savedAt: '2026-03-01T00:00:00.000Z', skills: ['a', 'b'] }));
    const listed = await listConcepts(db);
    expect(listed.map((c) => c.term)).toEqual(['New', 'Old']);
    expect(listed[0]?.skills).toEqual(['a', 'b']);
  });

  it('filters by field, skill, since and hasNotes', async () => {
    const db = testDb();
    await saveConcept(
      db,
      concept({ term: 'Raft', field: 'consensus', skills: ['systems-design'], savedAt: '2026-01-01T00:00:00.000Z' }),
    );
    await saveConcept(
      db,
      concept({
        term: 'Debounce',
        field: 'frontend',
        skills: ['ui'],
        notes: 'why it matters',
        savedAt: '2026-05-01T00:00:00.000Z',
      }),
    );

    expect((await listConcepts(db, { field: 'consensus' })).map((c) => c.term)).toEqual(['Raft']);
    expect((await listConcepts(db, { skill: 'ui' })).map((c) => c.term)).toEqual(['Debounce']);
    expect((await listConcepts(db, { since: '2026-03-01T00:00:00.000Z' })).map((c) => c.term)).toEqual(['Debounce']);
    expect((await listConcepts(db, { hasNotes: true })).map((c) => c.term)).toEqual(['Debounce']);
  });

  it('honours limit', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'One', savedAt: '2026-01-01T00:00:00.000Z' }));
    await saveConcept(db, concept({ term: 'Two', savedAt: '2026-02-01T00:00:00.000Z' }));
    expect(await listConcepts(db, { limit: 1 })).toHaveLength(1);
  });
});

describe('getConceptsByTerm', () => {
  it('returns every version newest first', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'Cache', sentence: 'v1', savedAt: '2026-01-01T00:00:00.000Z' }));
    await saveConcept(db, concept({ term: 'cache', sentence: 'v2', savedAt: '2026-02-01T00:00:00.000Z' }));
    const versions = await getConceptsByTerm(db, 'CACHE');
    expect(versions.map((v) => v.sentence)).toEqual(['v2', 'v1']);
  });

  it('returns nothing for an unknown term', async () => {
    expect(await getConceptsByTerm(testDb(), 'nope')).toEqual([]);
  });
});

describe('searchConcepts', () => {
  it('matches prose in the notes, not just the term', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'Quorum', notes: 'A majority of replicas must acknowledge a write.' }));
    await saveConcept(db, concept({ term: 'Debounce', savedAt: '2026-02-01T00:00:00.000Z', notes: 'Delay a call.' }));
    const hits = await searchConcepts(db, 'replicas');
    expect(hits.map((h) => h.term)).toEqual(['Quorum']);
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it('ranks a term match above a body-only match', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'Latency', savedAt: '2026-01-01T00:00:00.000Z' }));
    await saveConcept(
      db,
      concept({ term: 'Throughput', savedAt: '2026-02-01T00:00:00.000Z', notes: 'Trades against latency.' }),
    );
    const hits = await searchConcepts(db, 'latency');
    expect(hits).toHaveLength(2);
    expect(hits[0]?.term).toBe('Latency');
  });

  it('excludes superseded versions by default', async () => {
    const db = testDb();
    await saveConcept(
      db,
      concept({ term: 'Sharding', sentence: 'splitting data', savedAt: '2026-01-01T00:00:00.000Z' }),
    );
    await saveConcept(
      db,
      concept({ term: 'Sharding', sentence: 'splitting data', savedAt: '2026-02-01T00:00:00.000Z' }),
    );
    expect(await searchConcepts(db, 'sharding')).toHaveLength(1);
    expect(await searchConcepts(db, 'sharding', { includeSuperseded: true })).toHaveLength(2);
  });

  it('applies filters alongside the query', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'Retry', field: 'reliability', notes: 'backoff and jitter' }));
    await saveConcept(
      db,
      concept({ term: 'Jitter', field: 'frontend', savedAt: '2026-02-01T00:00:00.000Z', notes: 'backoff and jitter' }),
    );
    const hits = await searchConcepts(db, 'backoff', { field: 'reliability' });
    expect(hits.map((h) => h.term)).toEqual(['Retry']);
  });

  it('does not throw on punctuation a user would reasonably type', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'C++ move semantics' }));
    await expect(searchConcepts(db, 'C++ (move)')).resolves.toBeInstanceOf(Array);
    await expect(searchConcepts(db, '"unbalanced')).resolves.toBeInstanceOf(Array);
    await expect(searchConcepts(db, 'NEAR/')).resolves.toBeInstanceOf(Array);
  });

  it('returns nothing for an empty query rather than every row', async () => {
    const db = testDb();
    await saveConcept(db, concept());
    expect(await searchConcepts(db, '   ')).toEqual([]);
  });
});

describe('toMatchQuery', () => {
  it('quotes bare tokens and passes capitalised operators through', () => {
    expect(toMatchQuery('write ahead')).toBe('"write" "ahead"');
    expect(toMatchQuery('raft OR paxos')).toBe('"raft" OR "paxos"');
    expect(toMatchQuery('say "hi')).toBe('"say" """hi"');
  });
});

describe('conceptFacets', () => {
  it('counts fields and skills, ignoring meta skills', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'A', field: 'systems', skills: ['systems-design', 'find-skills'] }));
    await saveConcept(
      db,
      concept({ term: 'B', field: 'systems', skills: ['systems-design'], savedAt: '2026-02-01T00:00:00.000Z' }),
    );
    await saveConcept(
      db,
      concept({ term: 'C', field: 'frontend', skills: ['ui'], savedAt: '2026-03-01T00:00:00.000Z' }),
    );

    const facets = await conceptFacets(db);
    expect(facets.fields).toEqual([
      { value: 'systems', count: 2 },
      { value: 'frontend', count: 1 },
    ]);
    expect(facets.skills).toEqual([
      { value: 'systems-design', count: 2 },
      { value: 'ui', count: 1 },
    ]);
  });
});

describe('exportJsonl', () => {
  it('emits every version oldest first, one JSON record per line', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'X', sentence: 'v1', savedAt: '2026-01-01T00:00:00.000Z' }));
    await saveConcept(db, concept({ term: 'X', sentence: 'v2', savedAt: '2026-02-01T00:00:00.000Z' }));
    const lines = (await exportJsonl(db)).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).sentence)).toEqual(['v1', 'v2']);
  });

  it('round-trips through a fresh database with identical ids', async () => {
    const source = testDb();
    await saveConcept(source, concept({ term: 'X', notes: 'keep me' }));
    await saveConcept(source, concept({ term: 'Y', savedAt: '2026-02-01T00:00:00.000Z' }));
    const exported = await exportJsonl(source);

    const restored = testDb();
    for (const line of exported.split('\n')) await saveConcept(restored, JSON.parse(line));

    expect(await exportJsonl(restored)).toBe(exported);
    const before = await listConcepts(source);
    const after = await listConcepts(restored);
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
  });

  it('is empty for an empty store', async () => {
    expect(await exportJsonl(testDb())).toBe('');
  });
});
