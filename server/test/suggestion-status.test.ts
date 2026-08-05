// The flags outlive the process, so what matters here is the file: where it lands,
// that a missing or corrupt one reads as "nothing decided yet", and that a write
// round-trips through it.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  judgeSuggestionStatusStore,
  readSuggestionStatusStore,
  resolveSuggestionStatusPath,
  updateSuggestionStatusStore,
  writeSuggestionStatusStore,
} from '../src/suggestion-status.js';

const logDir = () => mkdtemp(path.join(tmpdir(), 'suggestion-status-'));

describe('suggestion status file', () => {
  it('sits beside the logs it describes', async () => {
    expect(resolveSuggestionStatusPath('/logs')).toBe(path.join('/logs', 'suggestion-status.json'));
  });

  it('reads a missing file as nothing decided yet', async () => {
    expect((await readSuggestionStatusStore(path.join(await logDir(), 'nope'))).buckets).toEqual({});
  });

  it('reads a corrupt file as empty rather than throwing', async () => {
    const dir = await logDir();
    await writeFile(resolveSuggestionStatusPath(dir), '{ not json', 'utf8');
    expect((await readSuggestionStatusStore(dir)).buckets).toEqual({});
  });

  it('round-trips a flag through the file', async () => {
    const dir = await logDir();
    const written = await updateSuggestionStatusStore(dir, [
      { bucket: 9, id: 'serial-discovery', status: 'done', note: 'PR #71' },
    ]);
    expect(written.buckets['9']?.['serial-discovery']?.status).toBe('done');

    const reread = await readSuggestionStatusStore(dir);
    expect(reread.buckets['9']?.['serial-discovery']).toMatchObject({ status: 'done', note: 'PR #71' });
  });

  it('merges into what is already recorded instead of replacing it', async () => {
    const dir = await logDir();
    await updateSuggestionStatusStore(dir, [{ bucket: 1, id: 'a', status: 'done' }]);
    await updateSuggestionStatusStore(dir, [{ bucket: 2, id: 'b', status: 'skipped' }]);
    const store = await readSuggestionStatusStore(dir);
    expect(Object.keys(store.buckets).sort()).toEqual(['1', '2']);
  });

  it('writes readable JSON, not a one-line blob', async () => {
    const dir = await logDir();
    await writeSuggestionStatusStore(dir, {
      version: 2,
      buckets: { '1': { a: { status: 'done', updated: '2026-07-26T00:00:00.000Z' } } },
      judged: {},
    });
    const text = await readFile(resolveSuggestionStatusPath(dir), 'utf8');
    expect(text.split('\n').length).toBeGreaterThan(3);
    expect(text.endsWith('\n')).toBe(true);
  });
});

// A v1 file on disk is the ordinary starting state on any device that recorded flags
// before the judgement layer existed. It must keep every flag and gain an empty
// `judged`, and the next write must leave a v2 file behind.
describe('v1 → v2 migration', () => {
  const v1 = {
    version: 1,
    buckets: {
      '9': { 'serial-discovery': { status: 'done', updated: '2026-07-26T00:00:00.000Z', note: 'PR #71' } },
    },
  };

  it('reads a v1 file as v2 with nothing judged, keeping every flag', async () => {
    const dir = await logDir();
    await writeFile(resolveSuggestionStatusPath(dir), `${JSON.stringify(v1, null, 2)}\n`, 'utf8');
    const store = await readSuggestionStatusStore(dir);
    expect(store.version).toBe(2);
    expect(store.judged).toEqual({});
    expect(store.buckets['9']?.['serial-discovery']).toMatchObject({ status: 'done', note: 'PR #71' });
  });

  it('leaves a v2 file on disk after the next write', async () => {
    const dir = await logDir();
    await writeFile(resolveSuggestionStatusPath(dir), `${JSON.stringify(v1, null, 2)}\n`, 'utf8');
    await updateSuggestionStatusStore(dir, [{ bucket: 1, id: 'a', status: 'skipped' }]);
    const raw = JSON.parse(await readFile(resolveSuggestionStatusPath(dir), 'utf8'));
    expect(raw.version).toBe(2);
    expect(raw.judged).toEqual({});
    expect(raw.buckets['9']['serial-discovery'].status).toBe('done');
  });
});

describe('judging through the file', () => {
  it('commits the dismissals and the verdict in one write', async () => {
    const dir = await logDir();
    const written = await judgeSuggestionStatusStore(dir, {
      updates: [{ bucket: 3, id: 'serial-discovery', status: 'dismissed', note: 'reads were dependent' }],
      judged: [{ bucket: 3, notes: { 'redundant-reads': 're-read api.ts 4×' } }],
    });
    expect(written.buckets['3']?.['serial-discovery']?.status).toBe('dismissed');

    const reread = await readSuggestionStatusStore(dir);
    expect(reread.buckets['3']?.['serial-discovery']).toMatchObject({
      status: 'dismissed',
      note: 'reads were dependent',
    });
    expect(reread.judged['3']?.notes).toEqual({ 'redundant-reads': 're-read api.ts 4×' });
    expect(reread.judged['3']?.at).toMatch(/^\d{4}-/);
  });

  it('records a verdict alone, and leaves earlier flags in place', async () => {
    const dir = await logDir();
    await updateSuggestionStatusStore(dir, [{ bucket: 1, id: 'a', status: 'done', note: 'PR #1' }]);
    await judgeSuggestionStatusStore(dir, { judged: [{ bucket: 1 }, { bucket: 2 }] });
    const store = await readSuggestionStatusStore(dir);
    expect(Object.keys(store.judged).sort()).toEqual(['1', '2']);
    expect(store.buckets['1']?.a).toMatchObject({ status: 'done', note: 'PR #1' });
  });

  // Amnesty draws a line under a backlog; it must not overwrite a verdict that
  // carries enrichment, since re-recording with no notes would delete it.
  it('leaves an already-judged bucket’s notes alone', async () => {
    const dir = await logDir();
    await judgeSuggestionStatusStore(dir, { judged: [{ bucket: 1, notes: { 'redundant-reads': 'two files' } }] });
    // What amnesty does to a bucket it *does* cover — no notes — applied to one it should not.
    await judgeSuggestionStatusStore(dir, { judged: [{ bucket: 2 }] });
    const store = await readSuggestionStatusStore(dir);
    expect(store.judged['1']?.notes).toEqual({ 'redundant-reads': 'two files' });
    expect(store.judged['2']?.notes).toEqual({});
  });

  it('keeps a bucket judged when its dismissal is undone', async () => {
    const dir = await logDir();
    await judgeSuggestionStatusStore(dir, {
      updates: [{ bucket: 4, id: 'serial-discovery', status: 'dismissed', note: 'wrong' }],
      judged: [{ bucket: 4 }],
    });
    await updateSuggestionStatusStore(dir, [{ bucket: 4, id: 'serial-discovery', status: 'pending' }]);
    const store = await readSuggestionStatusStore(dir);
    expect(store.buckets['4']).toBeUndefined();
    expect(store.judged['4']).toBeDefined();
  });
});
