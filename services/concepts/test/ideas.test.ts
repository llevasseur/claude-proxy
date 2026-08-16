/**
 * The hosted ideas ledger, against the real SQLite the Worker will run on.
 *
 * The point of interest is the seam ADR 0006 draws: replay reproduces exactly
 * what `packages/core` says a sequence of writes means, and the one thing replay
 * cannot arbitrate — two runs claiming at once — is settled by the conditional
 * write rather than by whoever read last.
 */

import { IDEA_CLAIM_TTL_MS } from '@claude-proxy/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.ts';
import {
  addIdeas,
  claimIdeas,
  commentIdeas,
  exportIdeas,
  fileIdeas,
  getIdea,
  listIdeas,
  markIdeas,
  readIdeas,
} from '../src/ideas.ts';
import { testDb } from './harness.ts';

let db: Db;

beforeEach(() => {
  db = testDb();
});

const T0 = new Date('2026-08-10T10:00:00.000Z');

function idea(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'rolling-window',
    title: 'A rolling last-10 window beside the fixed buckets',
    rationale: 'The fixed windows split a habit that spans a boundary.',
    evidence: [{ source: 'open-question' as const, path: 'docs/features/session-suggestions.md' }],
    repo: 'llevasseur/claude-proxy',
    area: 'ui-ux',
    ...overrides,
  };
}

describe('replay', () => {
  it('reads an empty database as an empty ledger', async () => {
    expect((await readIdeas(db)).ideas).toEqual({});
  });

  it('round-trips an entry through the event log', async () => {
    const result = await addIdeas(db, [idea()], T0);
    expect(result.added).toEqual(['rolling-window']);

    const entry = (await readIdeas(db)).ideas['rolling-window'];
    expect(entry?.title).toBe(idea().title);
    expect(entry?.status).toBe('proposed');
    // The timestamps come out of the log rather than out of the read.
    expect(entry?.created).toBe(T0.toISOString());
  });

  it('replays marks, filings and comments in the order they were written', async () => {
    await addIdeas(db, [idea()], T0);
    await markIdeas(db, [{ slug: 'rolling-window', status: 'rejected', note: 'covered by /trends' }], T0);
    await fileIdeas(db, [{ slug: 'rolling-window', area: 'infrastructure' }], T0);
    await commentIdeas(db, [{ slug: 'rolling-window', text: 'revisit once /trends lands' }], T0);

    const entry = (await readIdeas(db)).ideas['rolling-window'];
    // Filing is not deciding: the status and its reason survive the move.
    expect(entry?.area).toBe('infrastructure');
    expect(entry?.status).toBe('rejected');
    expect(entry?.note).toBe('covered by /trends');
    expect(entry?.comment).toBe('revisit once /trends lands');
  });

  it('refuses a slug already on the ledger in any status, and keeps the rejection reason', async () => {
    await addIdeas(db, [idea()], T0);
    await markIdeas(db, [{ slug: 'rolling-window', status: 'rejected', note: 'not now' }], T0);

    const again = await addIdeas(db, [idea({ title: 'Rewritten' })], T0);
    expect(again.added).toEqual([]);
    expect(again.refused).toEqual(['rolling-window']);

    const entry = (await readIdeas(db)).ideas['rolling-window'];
    expect(entry?.title).toBe(idea().title);
    expect(entry?.note).toBe('not now');
  });

  it('lands the rest of a batch when one slug collides', async () => {
    await addIdeas(db, [idea()], T0);
    const batch = await addIdeas(db, [idea(), idea({ slug: 'second-idea' })], T0);
    expect(batch.added).toEqual(['second-idea']);
    expect(batch.refused).toEqual(['rolling-window']);
  });

  it('writes no event for a refused add, so the refusal does not replay as a second entry', async () => {
    await addIdeas(db, [idea()], T0);
    await addIdeas(db, [idea({ title: 'Rewritten' })], T0);
    const events = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM idea_event');
    expect(events[0]?.n).toBe(1);
  });

  it('writes nothing for a mark on a slug the ledger does not carry', async () => {
    const result = await markIdeas(db, [{ slug: 'never-proposed', status: 'accepted' }], T0);
    expect(result.updated).toEqual([]);
    expect(result.unknown).toEqual(['never-proposed']);
    expect((await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM idea_event'))[0]?.n).toBe(0);
  });

  it('is idempotent: the same event written twice is one row', async () => {
    await addIdeas(db, [idea()], T0);
    // The add is refused the second time, so drive the duplicate through a mark,
    // whose event is byte-identical at the same timestamp.
    await markIdeas(db, [{ slug: 'rolling-window', status: 'accepted' }], T0);
    await markIdeas(db, [{ slug: 'rolling-window', status: 'accepted' }], T0);
    const marks = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM idea_event WHERE kind = 'mark'");
    expect(marks[0]?.n).toBe(1);
  });

  it('refuses to file a command-gap idea out of the commands area, as core does', async () => {
    await addIdeas(db, [idea({ slug: 'a-new-command', area: 'commands', evidence: [{ source: 'command-gap' }] })], T0);
    await expect(fileIdeas(db, [{ slug: 'a-new-command', area: 'ui-ux' }], T0)).rejects.toThrow(/command-gap/);
  });
});

describe('dedupe across the whole corpus', () => {
  it('surfaces a near-duplicate slug without refusing it', async () => {
    await addIdeas(db, [idea({ slug: 'rolling-window-view' })], T0);
    const result = await addIdeas(db, [idea({ slug: 'add-rolling-window' })], T0);
    // Recorded, and the look-alike reported beside it — a prompt to look, never a verdict.
    expect(result.added).toEqual(['add-rolling-window']);
    expect(result.similar['add-rolling-window']).toContain('rolling-window-view');
  });

  it('checks a proposal against rejected rows too, which is the point of a shared ledger', async () => {
    await addIdeas(db, [idea({ slug: 'rolling-window-view' })], T0);
    await markIdeas(db, [{ slug: 'rolling-window-view', status: 'rejected', note: 'covered by /trends' }], T0);

    const result = await addIdeas(db, [idea({ slug: 'add-rolling-window' })], T0);
    expect(result.similar['add-rolling-window']).toContain('rolling-window-view');
  });

  it('reports a near-miss area while still landing the entry', async () => {
    await addIdeas(db, [idea({ slug: 'first', area: 'infrastructure' })], T0);
    const result = await addIdeas(db, [idea({ slug: 'second', area: 'infra' })], T0);
    expect(result.added).toEqual(['second']);
    expect(result.similarAreas.second).toContain('infrastructure');
  });
});

describe('claiming', () => {
  async function accepted(slug = 'rolling-window'): Promise<void> {
    await addIdeas(db, [idea({ slug })], T0);
    await markIdeas(db, [{ slug, status: 'accepted' }], T0);
  }

  it('takes an accepted idea and reads back as claimed', async () => {
    await accepted();
    const result = await claimIdeas(db, [{ slug: 'rolling-window', by: 'feat/rolling-window' }], T0);
    expect(result.claimed).toEqual(['rolling-window']);

    const entry = (await readIdeas(db, T0)).ideas['rolling-window'];
    expect(entry?.status).toBe('claimed');
    expect(entry?.claim?.by).toBe('feat/rolling-window');
  });

  it('refuses a proposed idea, so a claim cannot route around the human sign-off', async () => {
    await addIdeas(db, [idea()], T0);
    const result = await claimIdeas(db, [{ slug: 'rolling-window', by: 'run-a' }], T0);
    expect(result.claimed).toEqual([]);
    expect(result.refused[0]?.status).toBe('proposed');
  });

  it('refuses a second holder and names the first', async () => {
    await accepted();
    await claimIdeas(db, [{ slug: 'rolling-window', by: 'run-a' }], T0);

    const second = await claimIdeas(db, [{ slug: 'rolling-window', by: 'run-b' }], T0);
    expect(second.claimed).toEqual([]);
    expect(second.refused[0]?.heldBy).toBe('run-a');
  });

  it('is atomic: of two runs claiming at the same instant, exactly one wins', async () => {
    await accepted();
    // Both read the idea as free — which is precisely the race the file-backed
    // store could not settle — and then both write.
    const [a, b] = await Promise.all([
      claimIdeas(db, [{ slug: 'rolling-window', by: 'run-a' }], T0),
      claimIdeas(db, [{ slug: 'rolling-window', by: 'run-b' }], T0),
    ]);
    expect(a.claimed.length + b.claimed.length).toBe(1);
    expect(a.refused.length + b.refused.length).toBe(1);

    // And the ledger agrees with whichever one won.
    const entry = (await readIdeas(db, T0)).ideas['rolling-window'];
    const winner = a.claimed.length > 0 ? 'run-a' : 'run-b';
    expect(entry?.claim?.by).toBe(winner);
  });

  it('lets the same holder re-claim, which is how a run attaches its PR later', async () => {
    await accepted();
    await claimIdeas(db, [{ slug: 'rolling-window', by: 'run-a' }], T0);
    const again = await claimIdeas(db, [{ slug: 'rolling-window', by: 'run-a', pr: 'https://…/141' }], T0);
    expect(again.claimed).toEqual(['rolling-window']);
    expect((await readIdeas(db, T0)).ideas['rolling-window']?.claim?.pr).toBe('https://…/141');
  });

  it('keeps a PR the claim already had through a bare re-claim', async () => {
    await accepted();
    await claimIdeas(db, [{ slug: 'rolling-window', by: 'run-a', pr: 'https://…/141' }], T0);
    await claimIdeas(db, [{ slug: 'rolling-window', by: 'run-a' }], T0);
    expect((await readIdeas(db, T0)).ideas['rolling-window']?.claim?.pr).toBe('https://…/141');
  });

  it('expires an unevidenced claim after the TTL, with nothing written to expire it', async () => {
    await accepted();
    await claimIdeas(db, [{ slug: 'rolling-window', by: 'died' }], T0);

    const justBefore = new Date(T0.getTime() + IDEA_CLAIM_TTL_MS - 1);
    expect((await readIdeas(db, justBefore)).ideas['rolling-window']?.status).toBe('claimed');

    const atExpiry = new Date(T0.getTime() + IDEA_CLAIM_TTL_MS);
    // Read at read time from the lease's own timestamp: no sweeper ran.
    expect((await readIdeas(db, atExpiry)).ideas['rolling-window']?.status).toBe('accepted');
    expect((await claimIdeas(db, [{ slug: 'rolling-window', by: 'run-b' }], atExpiry)).claimed).toEqual([
      'rolling-window',
    ]);
  });

  it('never expires a claim carrying a PR, however old', async () => {
    await accepted();
    await claimIdeas(db, [{ slug: 'rolling-window', by: 'run-a', pr: 'https://…/141' }], T0);

    const muchLater = new Date(T0.getTime() + IDEA_CLAIM_TTL_MS * 100);
    expect((await readIdeas(db, muchLater)).ideas['rolling-window']?.status).toBe('claimed');
    expect((await claimIdeas(db, [{ slug: 'rolling-window', by: 'run-b' }], muchLater)).claimed).toEqual([]);
  });

  it('releases the claim on every mark but shipped, and keeps it on shipped', async () => {
    await accepted();
    await claimIdeas(db, [{ slug: 'rolling-window', by: 'run-a' }], T0);

    await markIdeas(db, [{ slug: 'rolling-window', status: 'accepted' }], T0);
    expect((await readIdeas(db, T0)).ideas['rolling-window']?.claim).toBeUndefined();

    await claimIdeas(db, [{ slug: 'rolling-window', by: 'run-a' }], T0);
    await markIdeas(db, [{ slug: 'rolling-window', status: 'shipped', note: 'https://…/141' }], T0);
    const entry = (await readIdeas(db, T0)).ideas['rolling-window'];
    expect(entry?.status).toBe('shipped');
    expect(entry?.claim?.by).toBe('run-a');
  });

  it('reports an unknown slug rather than inventing an entry to hold the claim', async () => {
    const result = await claimIdeas(db, [{ slug: 'never-proposed', by: 'run-a' }], T0);
    expect(result.unknown).toEqual(['never-proposed']);
    expect(result.claimed).toEqual([]);
  });
});

describe('reading one idea by its key', () => {
  /**
   * `getIdea` replays only that key's events, so these cases check it against
   * what the whole-ledger replay holds for the same key — a partial replay that
   * disagreed would answer differently depending on the route asked through.
   */
  it('answers with exactly what a full replay holds for that key', async () => {
    await addIdeas(db, [idea(), idea({ slug: 'second-idea', area: 'services' })], T0);
    await markIdeas(db, [{ slug: 'rolling-window', status: 'accepted' }], T0);
    await commentIdeas(db, [{ slug: 'rolling-window', text: 'revisit once /trends lands' }], T0);
    await fileIdeas(db, [{ slug: 'rolling-window', area: 'infrastructure' }], T0);

    const store = await readIdeas(db, T0);
    expect(await getIdea(db, 'rolling-window', T0)).toEqual(store.ideas['rolling-window']);
    expect(await getIdea(db, 'second-idea', T0)).toEqual(store.ideas['second-idea']);
  });

  it('replays that key in order, so a later mark wins over the add', async () => {
    await addIdeas(db, [idea()], T0);
    await markIdeas(db, [{ slug: 'rolling-window', status: 'accepted' }], T0);
    await markIdeas(db, [{ slug: 'rolling-window', status: 'rejected', note: 'covered by /trends' }], T0);

    const entry = await getIdea(db, 'rolling-window', T0);
    expect(entry?.status).toBe('rejected');
    expect(entry?.note).toBe('covered by /trends');
  });

  it('keeps answering for a rejected key, which is what stops it being re-proposed', async () => {
    await addIdeas(db, [idea()], T0);
    await markIdeas(db, [{ slug: 'rolling-window', status: 'rejected', note: 'not now' }], T0);
    expect((await getIdea(db, 'rolling-window', T0))?.status).toBe('rejected');
  });

  it('overlays a live claim, and reads takeable again once it goes stale', async () => {
    await addIdeas(db, [idea()], T0);
    await markIdeas(db, [{ slug: 'rolling-window', status: 'accepted' }], T0);
    await claimIdeas(db, [{ slug: 'rolling-window', by: 'run-a' }], T0);

    const held = await getIdea(db, 'rolling-window', T0);
    expect(held?.status).toBe('claimed');
    expect(held?.claim?.by).toBe('run-a');

    // The lease row outlives the claim — nothing sweeps it — so the by-key read
    // applies the same staleness rule the ledger read does.
    const later = new Date(T0.getTime() + IDEA_CLAIM_TTL_MS + 1000);
    expect((await getIdea(db, 'rolling-window', later))?.status).toBe('accepted');
  });

  it('is null for a well-formed key nothing was ever added under', async () => {
    await addIdeas(db, [idea()], T0);
    expect(await getIdea(db, 'never-proposed', T0)).toBeNull();
  });

  it('refuses a malformed key as a 400, rather than reporting it merely absent', async () => {
    await expect(getIdea(db, 'Not A Slug', T0)).rejects.toThrow(/invalid slug/);
    await expect(getIdea(db, '', T0)).rejects.toThrow(/invalid slug/);
  });
});

describe('listing and export', () => {
  it('narrows by status, repo and area, and counts the whole ledger regardless', async () => {
    await addIdeas(db, [idea(), idea({ slug: 'second-idea', area: 'services', repo: 'llevasseur/other' })], T0);
    await markIdeas(db, [{ slug: 'second-idea', status: 'accepted' }], T0);

    const accepted = await listIdeas(db, { statuses: ['accepted'] }, false, T0);
    expect(accepted.rows.map((row) => row.slug)).toEqual(['second-idea']);
    // `total` is the ledger, not the view, so a filtered page says how much it hid.
    expect(accepted.total).toBe(2);

    expect((await listIdeas(db, { repo: 'llevasseur/other' }, false, T0)).rows).toHaveLength(1);
    expect((await listIdeas(db, { area: 'ui-ux' }, false, T0)).rows.map((row) => row.slug)).toEqual(['rolling-window']);
  });

  it('answers --available with accepted plus expired claims, and not with live ones', async () => {
    await addIdeas(db, [idea({ slug: 'free' }), idea({ slug: 'abandoned' }), idea({ slug: 'live' })], T0);
    for (const slug of ['free', 'abandoned', 'live']) {
      await markIdeas(db, [{ slug, status: 'accepted' }], T0);
    }
    await claimIdeas(db, [{ slug: 'abandoned', by: 'died' }], T0);
    const later = new Date(T0.getTime() + IDEA_CLAIM_TTL_MS + 1);
    await claimIdeas(db, [{ slug: 'live', by: 'run-a' }], later);

    const available = await listIdeas(db, {}, true, later);
    expect(available.rows.map((row) => row.slug).sort()).toEqual(['abandoned', 'free']);
  });

  it('exports the ledger in the shape the file held, so the backup is restorable', async () => {
    await addIdeas(db, [idea()], T0);
    const parsed = JSON.parse(await exportIdeas(db, T0)) as { version: number; ideas: Record<string, unknown> };
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.ideas)).toEqual(['rolling-window']);
  });
});
