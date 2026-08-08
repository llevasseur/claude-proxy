// The ideas ledger's builders: the list the Advice page reads, and the adjudication it
// writes. Both refusals live in `applyIdeaStatus` rather than in the route, so they are
// asserted here; the CORS and the method gate are in `route-methods.test.ts`, which
// already runs a server.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyIdeaStatus, BROWSER_IDEA_STATUSES, buildIdeas } from '../src/api.js';
import { addIdeasToStore, claimIdeasInStore, readIdeasStore } from '../src/ideas-store.js';

let logDir: string;

const ADD = {
  slug: 'rolling-window',
  title: 'A rolling last-10 window beside the fixed buckets',
  rationale: 'The fixed windows split a habit that spans a boundary.',
  evidence: [
    { source: 'open-question' as const, path: 'docs/features/session-suggestions.md', quote: 'a habit that spans' },
    { source: 'judge-note' as const, bucket: 3, id: 'serial-discovery' },
  ],
  repo: 'llevasseur/claude-proxy',
};
const OTHER = { ...ADD, slug: 'step-reach-chart', title: 'Chart declared steps reached', repo: 'llevasseur/other' };

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'ideas-api-'));
  await addIdeasToStore(logDir, [ADD, OTHER]);
});

describe('buildIdeas', () => {
  it('returns the ledger with its status counts and the file it came from', async () => {
    const { rows, meta } = await buildIdeas(logDir);

    expect(rows.map((r) => r.slug).sort()).toEqual(['rolling-window', 'step-reach-chart']);
    expect(meta.counts).toEqual({ proposed: 2, accepted: 0, claimed: 0, rejected: 0, shipped: 0 });
    expect(meta.total).toBe(2);
    expect(meta.file.endsWith('ideas.json')).toBe(true);
    // The evidence is what makes an idea approvable, so it has to reach the card.
    expect(rows.find((r) => r.slug === 'rolling-window')?.evidence).toEqual(ADD.evidence);
  });

  it('narrows by status and by repo, while `total` still counts the whole ledger', async () => {
    expect((await buildIdeas(logDir, { statuses: ['accepted'] })).rows).toEqual([]);
    expect((await buildIdeas(logDir, { statuses: ['accepted'] })).meta.total).toBe(2);

    const mine = await buildIdeas(logDir, { repo: 'llevasseur/other' });
    expect(mine.rows.map((r) => r.slug)).toEqual(['step-reach-chart']);
    expect(mine.meta.total).toBe(2);
  });

  it('reads an empty ledger as no rows rather than failing', async () => {
    const empty = await buildIdeas(await mkdtemp(path.join(tmpdir(), 'ideas-empty-')));
    expect(empty.rows).toEqual([]);
    expect(empty.meta.total).toBe(0);
  });
});

describe('applyIdeaStatus', () => {
  it('accepts an idea and rejects another, and both survive a re-read', async () => {
    const accepted = await applyIdeaStatus(logDir, [{ slug: 'rolling-window', status: 'accepted' }]);
    expect(accepted.meta.updated).toEqual(['rolling-window']);
    expect(accepted.rows[0]?.status).toBe('accepted');

    const rejected = await applyIdeaStatus(logDir, [
      { slug: 'step-reach-chart', status: 'rejected', note: 'covered by /trends' },
    ]);
    expect(rejected.rows[0]?.note).toBe('covered by /trends');
    // Counted over the whole ledger, not the write that just happened.
    expect(rejected.meta.counts).toEqual({ proposed: 0, accepted: 1, claimed: 0, rejected: 1, shipped: 0 });

    const store = await readIdeasStore(logDir);
    expect(store.ideas['rolling-window']?.status).toBe('accepted');
    expect(store.ideas['step-reach-chart']?.status).toBe('rejected');
  });

  it('restores an idea with `proposed` without erasing the entry or its note', async () => {
    await applyIdeaStatus(logDir, [{ slug: 'rolling-window', status: 'rejected', note: 'not now' }]);
    const undone = await applyIdeaStatus(logDir, [{ slug: 'rolling-window', status: 'proposed' }]);

    expect(undone.rows[0]?.status).toBe('proposed');
    expect(undone.rows[0]?.note).toBe('not now');
  });

  it('refuses a rejection with no reason, writing nothing', async () => {
    // The reason is the ledger's dedupe record — what stops the idea coming back.
    for (const note of [undefined, '', '   ']) {
      const mark = { slug: 'rolling-window', status: 'rejected' as const, ...(note === undefined ? {} : { note }) };
      await expect(applyIdeaStatus(logDir, [mark])).rejects.toThrow(/needs a reason/);
    }
    expect((await readIdeasStore(logDir)).ideas['rolling-window']?.status).toBe('proposed');
  });

  it('refuses `shipped`, which carries a PR url and stays with the CLI', async () => {
    await expect(
      applyIdeaStatus(logDir, [{ slug: 'rolling-window', status: 'shipped', note: 'https://example.test/pr/1' }]),
    ).rejects.toThrow(/cannot be set from the dashboard/);
    expect((await readIdeasStore(logDir)).ideas['rolling-window']?.status).toBe('proposed');
    expect(BROWSER_IDEA_STATUSES).toEqual(['proposed', 'accepted', 'rejected']);
  });

  it('refuses `claimed`, since a claim names the run building the idea', async () => {
    // A button would park an idea for the whole expiry under a holder nobody can find.
    await expect(applyIdeaStatus(logDir, [{ slug: 'rolling-window', status: 'claimed' }])).rejects.toThrow(
      /ideas claim --by/,
    );
    expect((await readIdeasStore(logDir)).ideas['rolling-window']?.status).toBe('proposed');
  });

  it('releases a claim with `accepted`, which is the dashboard escape hatch for a hung run', async () => {
    await applyIdeaStatus(logDir, [{ slug: 'rolling-window', status: 'accepted' }]);
    await claimIdeasInStore(logDir, [{ slug: 'rolling-window', by: 'run-a' }]);

    const released = await applyIdeaStatus(logDir, [{ slug: 'rolling-window', status: 'accepted' }]);
    expect(released.rows[0]?.status).toBe('accepted');
    expect(released.rows[0]?.claim).toBeUndefined();
  });

  it('refuses the whole batch when one mark is bad, rather than half-applying it', async () => {
    await expect(
      applyIdeaStatus(logDir, [
        { slug: 'rolling-window', status: 'accepted' },
        { slug: 'step-reach-chart', status: 'rejected' },
      ]),
    ).rejects.toThrow(/needs a reason/);

    const store = await readIdeasStore(logDir);
    expect(store.ideas['rolling-window']?.status).toBe('proposed');
    expect(store.ideas['step-reach-chart']?.status).toBe('proposed');
  });

  it('writes nothing for a slug the ledger does not carry', async () => {
    const result = await applyIdeaStatus(logDir, [{ slug: 'never-proposed', status: 'accepted' }]);

    expect(result.meta.unknown).toEqual(['never-proposed']);
    expect(result.meta.updated).toEqual([]);
    expect(result.rows).toEqual([]);
    expect((await readIdeasStore(logDir)).ideas['never-proposed']).toBeUndefined();
  });

  it('refuses an empty batch', async () => {
    await expect(applyIdeaStatus(logDir, [])).rejects.toThrow(/no idea marks given/);
  });
});
