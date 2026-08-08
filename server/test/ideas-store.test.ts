import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addIdeasToStore,
  claimIdeasInStore,
  markIdeasInStore,
  readIdeasStore,
  resolveIdeasPath,
} from '../src/ideas-store.js';

let logDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'ideas-store-'));
});

const ADD = {
  slug: 'rolling-window',
  title: 'A rolling last-10 window beside the fixed buckets',
  rationale: 'The fixed windows split a habit that spans a boundary.',
  evidence: [{ source: 'open-question' as const, path: 'docs/features/session-suggestions.md' }],
  repo: 'llevasseur/claude-proxy',
};

describe('the ledger file', () => {
  it('reads a missing file as empty', async () => {
    expect((await readIdeasStore(logDir)).ideas).toEqual({});
  });

  it('is a different file from the suggestion flags', async () => {
    await addIdeasToStore(logDir, [ADD]);
    expect(await readdir(logDir)).toEqual(['ideas.json']);
    // The two stores never merge: one evidence standard per file.
    expect(resolveIdeasPath(logDir).endsWith('ideas.json')).toBe(true);
  });

  it('round-trips an entry through the file', async () => {
    const written = await addIdeasToStore(logDir, [ADD]);
    expect(written.added).toEqual(['rolling-window']);
    const store = await readIdeasStore(logDir);
    expect(store.ideas['rolling-window']?.title).toBe(ADD.title);
    expect(store.ideas['rolling-window']?.status).toBe('proposed');
  });

  it('leaves no temp file behind', async () => {
    await addIdeasToStore(logDir, [ADD]);
    expect((await readdir(logDir)).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('marks an entry already on disk', async () => {
    await addIdeasToStore(logDir, [ADD]);
    const result = await markIdeasInStore(logDir, [{ slug: 'rolling-window', status: 'accepted' }]);
    expect(result.updated).toEqual(['rolling-window']);
    expect((await readIdeasStore(logDir)).ideas['rolling-window']?.status).toBe('accepted');
  });

  it('refuses to add over a slug already on disk', async () => {
    await addIdeasToStore(logDir, [ADD]);
    await markIdeasInStore(logDir, [{ slug: 'rolling-window', status: 'rejected', note: 'not now' }]);
    const again = await addIdeasToStore(logDir, [{ ...ADD, title: 'Rewritten' }]);
    expect(again.refused).toEqual(['rolling-window']);
    const entry = (await readIdeasStore(logDir)).ideas['rolling-window'];
    expect(entry?.status).toBe('rejected');
    expect(entry?.note).toBe('not now');
  });

  it('survives a claim through the file, so a second process reads the idea as taken', async () => {
    await addIdeasToStore(logDir, [ADD]);
    await markIdeasInStore(logDir, [{ slug: 'rolling-window', status: 'accepted' }]);
    const claimed = await claimIdeasInStore(logDir, [{ slug: 'rolling-window', by: 'feat/rolling-window' }]);
    expect(claimed.claimed).toEqual(['rolling-window']);

    // The whole point is the *next* read, by whoever comes along after.
    const entry = (await readIdeasStore(logDir)).ideas['rolling-window'];
    expect(entry?.status).toBe('claimed');
    expect(entry?.claim?.by).toBe('feat/rolling-window');

    const second = await claimIdeasInStore(logDir, [{ slug: 'rolling-window', by: 'someone-else' }]);
    expect(second.claimed).toEqual([]);
    expect(second.refused[0]?.heldBy).toBe('feat/rolling-window');
  });

  it('releases a claim through mark, and keeps it through shipped', async () => {
    await addIdeasToStore(logDir, [ADD]);
    await markIdeasInStore(logDir, [{ slug: 'rolling-window', status: 'accepted' }]);
    await claimIdeasInStore(logDir, [{ slug: 'rolling-window', by: 'feat/rolling-window' }]);

    await markIdeasInStore(logDir, [{ slug: 'rolling-window', status: 'accepted' }]);
    expect((await readIdeasStore(logDir)).ideas['rolling-window']?.claim).toBeUndefined();

    await claimIdeasInStore(logDir, [{ slug: 'rolling-window', by: 'feat/rolling-window' }]);
    await markIdeasInStore(logDir, [{ slug: 'rolling-window', status: 'shipped', note: 'https://…/141' }]);
    expect((await readIdeasStore(logDir)).ideas['rolling-window']?.claim?.by).toBe('feat/rolling-window');
  });

  it('throws rather than reading a corrupt-but-present ledger as empty', async () => {
    await writeFile(resolveIdeasPath(logDir), '{ this is not json', 'utf8');
    // The deliberate divergence from the suggestion store: a waterfall caller
    // needs "absent" and "broken" to be different answers.
    await expect(readIdeasStore(logDir)).rejects.toThrow(/exists but is not valid JSON/);
  });

  it('writes valid JSON with a trailing newline', async () => {
    const { file } = await addIdeasToStore(logDir, [ADD]);
    const text = await readFile(file, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text).version).toBe(1);
  });
});
