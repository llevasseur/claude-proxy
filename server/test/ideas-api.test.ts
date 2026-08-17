// The ideas ledger's builders: the list the Advice page reads, and the adjudication it
// writes. Both refusals live in `applyIdeaStatus` rather than in the route, so they are
// asserted here; the CORS and the method gate are in `route-methods.test.ts`, which
// already runs a server.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyIdeaArea,
  applyIdeaClaim,
  applyIdeaComment,
  applyIdeaStatus,
  BROWSER_IDEA_STATUSES,
  buildIdeas,
} from '../src/api.js';
import { addIdeasToStore, claimIdeasInStore, readIdeasStore } from '../src/ideas-store.js';
import { type FakeIdeasWorker, installFakeIdeasWorker } from './ideas-fake-worker.js';

let worker: FakeIdeasWorker;

const ADD = {
  slug: 'rolling-window',
  title: 'A rolling last-10 window beside the fixed buckets',
  rationale: 'The fixed windows split a habit that spans a boundary.',
  evidence: [
    { source: 'open-question' as const, path: 'docs/features/session-suggestions.md', quote: 'a habit that spans' },
    { source: 'judge-note' as const, bucket: 3, id: 'serial-discovery' },
  ],
  repo: 'llevasseur/claude-proxy',
  area: 'ui-ux',
};
const OTHER = {
  ...ADD,
  slug: 'step-reach-chart',
  title: 'Chart declared steps reached',
  repo: 'llevasseur/other',
  area: 'infrastructure',
};

beforeEach(async () => {
  worker = installFakeIdeasWorker();
  await addIdeasToStore([ADD, OTHER]);
});

afterEach(() => {
  worker.restore();
});

describe('buildIdeas', () => {
  it('returns the ledger with its status counts and the file it came from', async () => {
    const { rows, meta } = await buildIdeas();

    expect(rows.map((r) => r.slug).sort()).toEqual(['rolling-window', 'step-reach-chart']);
    expect(meta.counts).toEqual({ proposed: 2, accepted: 0, claimed: 0, rejected: 0, shipped: 0 });
    expect(meta.total).toBe(2);
    // Where the ledger is, which is a hosted URL rather than a path now.
    expect(meta.file).toBe('https://ledger.test/api/ideas');
    // The evidence is what makes an idea approvable, so it has to reach the card.
    expect(rows.find((r) => r.slug === 'rolling-window')?.evidence).toEqual(ADD.evidence);
  });

  it('narrows by status and by repo, while `total` still counts the whole ledger', async () => {
    expect((await buildIdeas({ statuses: ['accepted'] })).rows).toEqual([]);
    expect((await buildIdeas({ statuses: ['accepted'] })).meta.total).toBe(2);

    const mine = await buildIdeas({ repo: 'llevasseur/other' });
    expect(mine.rows.map((r) => r.slug)).toEqual(['step-reach-chart']);
    expect(mine.meta.total).toBe(2);
  });

  it('narrows by area, and counts every area over the whole ledger', async () => {
    const ui = await buildIdeas({ area: 'ui-ux' });
    expect(ui.rows.map((r) => r.slug)).toEqual(['rolling-window']);
    // Counted over the whole ledger, never the filtered rows — otherwise selecting
    // one tab would rewrite the numbers on all the others.
    expect(ui.meta.areas).toEqual({
      areas: { 'ui-ux': 1, infrastructure: 1, 'code-quality': 0, services: 0, commands: 0 },
      unfiled: 0,
    });
    expect((await buildIdeas({ area: 'services' })).rows).toEqual([]);
  });

  it('reads an empty ledger as no rows rather than failing', async () => {
    worker.set({ version: 1, ideas: {} });
    const empty = await buildIdeas();
    expect(empty.rows).toEqual([]);
    expect(empty.meta.total).toBe(0);
  });
});

describe('applyIdeaStatus', () => {
  it('accepts an idea and rejects another, and both survive a re-read', async () => {
    const accepted = await applyIdeaStatus([{ slug: 'rolling-window', status: 'accepted' }]);
    expect(accepted.meta.updated).toEqual(['rolling-window']);
    expect(accepted.rows[0]?.status).toBe('accepted');

    const rejected = await applyIdeaStatus([
      { slug: 'step-reach-chart', status: 'rejected', note: 'covered by /trends' },
    ]);
    expect(rejected.rows[0]?.note).toBe('covered by /trends');
    // Counted over the whole ledger, not the write that just happened.
    expect(rejected.meta.counts).toEqual({ proposed: 0, accepted: 1, claimed: 0, rejected: 1, shipped: 0 });

    const store = await readIdeasStore();
    expect(store.ideas['rolling-window']?.status).toBe('accepted');
    expect(store.ideas['step-reach-chart']?.status).toBe('rejected');
  });

  it('restores an idea with `proposed` without erasing the entry or its note', async () => {
    await applyIdeaStatus([{ slug: 'rolling-window', status: 'rejected', note: 'not now' }]);
    const undone = await applyIdeaStatus([{ slug: 'rolling-window', status: 'proposed' }]);

    expect(undone.rows[0]?.status).toBe('proposed');
    expect(undone.rows[0]?.note).toBe('not now');
  });

  it('refuses a rejection with no reason, writing nothing', async () => {
    // The reason is the ledger's dedupe record — what stops the idea coming back.
    for (const note of [undefined, '', '   ']) {
      const mark =
        note === undefined
          ? { slug: 'rolling-window', status: 'rejected' as const }
          : { slug: 'rolling-window', status: 'rejected' as const, note };
      await expect(applyIdeaStatus([mark])).rejects.toThrow(/needs a reason/);
    }
    expect((await readIdeasStore()).ideas['rolling-window']?.status).toBe('proposed');
  });

  it('ships a claimed idea with the PR url as its note, keeping the claim', async () => {
    await applyIdeaStatus([{ slug: 'rolling-window', status: 'accepted' }]);
    await claimIdeasInStore([{ slug: 'rolling-window', by: 'run-a' }]);

    const shipped = await applyIdeaStatus([
      { slug: 'rolling-window', status: 'shipped', note: 'https://example.test/pr/1' },
    ]);

    expect(shipped.rows[0]?.status).toBe('shipped');
    expect(shipped.rows[0]?.note).toBe('https://example.test/pr/1');
    // `shipped` is the one mark that keeps the claim — the record of who built it.
    expect(shipped.rows[0]?.claim?.by).toBe('run-a');
    expect(BROWSER_IDEA_STATUSES).toEqual(['proposed', 'accepted', 'rejected', 'shipped']);
  });

  it('ships a released idea too, since letting the claim go did not un-land the PR', async () => {
    await applyIdeaStatus([{ slug: 'rolling-window', status: 'accepted' }]);

    const shipped = await applyIdeaStatus([
      { slug: 'rolling-window', status: 'shipped', note: 'https://example.test/pr/2' },
    ]);

    expect(shipped.rows[0]?.status).toBe('shipped');
    expect(shipped.rows[0]?.note).toBe('https://example.test/pr/2');
  });

  it('refuses a shipped mark with no PR url, writing nothing', async () => {
    await applyIdeaStatus([{ slug: 'rolling-window', status: 'accepted' }]);
    for (const note of [undefined, '', '   ']) {
      const mark =
        note === undefined
          ? { slug: 'rolling-window', status: 'shipped' as const }
          : { slug: 'rolling-window', status: 'shipped' as const, note };
      await expect(applyIdeaStatus([mark])).rejects.toThrow(/needs the PR url/);
    }
    expect((await readIdeasStore()).ideas['rolling-window']?.status).toBe('accepted');
  });

  it('refuses shipping an idea nobody signed off, and re-shipping a terminal one', async () => {
    await expect(
      applyIdeaStatus([{ slug: 'rolling-window', status: 'shipped', note: 'https://example.test/pr/3' }]),
    ).rejects.toThrow(/only an accepted or claimed idea may be shipped/);
    expect((await readIdeasStore()).ideas['rolling-window']?.status).toBe('proposed');

    await applyIdeaStatus([{ slug: 'rolling-window', status: 'accepted' }]);
    await applyIdeaStatus([{ slug: 'rolling-window', status: 'shipped', note: 'https://example.test/pr/3' }]);
    await expect(
      applyIdeaStatus([{ slug: 'rolling-window', status: 'shipped', note: 'https://example.test/pr/4' }]),
    ).rejects.toThrow(/shipped is terminal/);
    // The first url stands: nothing un-ships work that landed.
    expect((await readIdeasStore()).ideas['rolling-window']?.note).toBe('https://example.test/pr/3');
  });

  it('refuses `claimed`, since a claim names the run building the idea', async () => {
    // A button would park an idea for the whole expiry under a holder nobody can find.
    await expect(applyIdeaStatus([{ slug: 'rolling-window', status: 'claimed' }])).rejects.toThrow(/ideas claim --by/);
    expect((await readIdeasStore()).ideas['rolling-window']?.status).toBe('proposed');
  });

  it('releases a claim with `accepted`, which is the dashboard escape hatch for a hung run', async () => {
    await applyIdeaStatus([{ slug: 'rolling-window', status: 'accepted' }]);
    await claimIdeasInStore([{ slug: 'rolling-window', by: 'run-a' }]);

    const released = await applyIdeaStatus([{ slug: 'rolling-window', status: 'accepted' }]);
    expect(released.rows[0]?.status).toBe('accepted');
    expect(released.rows[0]?.claim).toBeUndefined();
  });

  it('refuses the whole batch when one mark is bad, rather than half-applying it', async () => {
    await expect(
      applyIdeaStatus([
        { slug: 'rolling-window', status: 'accepted' },
        { slug: 'step-reach-chart', status: 'rejected' },
      ]),
    ).rejects.toThrow(/needs a reason/);

    const store = await readIdeasStore();
    expect(store.ideas['rolling-window']?.status).toBe('proposed');
    expect(store.ideas['step-reach-chart']?.status).toBe('proposed');
  });

  it('writes nothing for a slug the ledger does not carry', async () => {
    const result = await applyIdeaStatus([{ slug: 'never-proposed', status: 'accepted' }]);

    expect(result.meta.unknown).toEqual(['never-proposed']);
    expect(result.meta.updated).toEqual([]);
    expect(result.rows).toEqual([]);
    expect((await readIdeasStore()).ideas['never-proposed']).toBeUndefined();
  });

  it('refuses an empty batch', async () => {
    await expect(applyIdeaStatus([])).rejects.toThrow(/no idea marks given/);
  });
});

describe('applyIdeaClaim', () => {
  it('takes a released idea back under a named holder, with the PR url re-entered', async () => {
    await applyIdeaStatus([{ slug: 'rolling-window', status: 'accepted' }]);

    const claimed = await applyIdeaClaim([
      { slug: 'rolling-window', by: 'feat/rolling-window', pr: 'https://example.test/pr/9' },
    ]);

    expect(claimed.meta.claimed).toEqual(['rolling-window']);
    expect(claimed.rows[0]?.status).toBe('claimed');
    expect(claimed.rows[0]?.claim?.by).toBe('feat/rolling-window');
    expect(claimed.rows[0]?.claim?.pr).toBe('https://example.test/pr/9');
  });

  it('reports a live holder as a refusal rather than throwing, and writes nothing', async () => {
    await applyIdeaStatus([{ slug: 'rolling-window', status: 'accepted' }]);
    await claimIdeasInStore([{ slug: 'rolling-window', by: 'run-a' }]);

    const refused = await applyIdeaClaim([{ slug: 'rolling-window', by: 'run-b' }]);

    expect(refused.meta.claimed).toEqual([]);
    expect(refused.meta.refused[0]?.heldBy).toBe('run-a');
    expect((await readIdeasStore()).ideas['rolling-window']?.claim?.by).toBe('run-a');
  });

  it('refuses a claim on an idea nobody signed off, since a claim may not skip the sign-off', async () => {
    const refused = await applyIdeaClaim([{ slug: 'rolling-window', by: 'run-a' }]);

    expect(refused.meta.claimed).toEqual([]);
    expect(refused.meta.refused[0]?.status).toBe('proposed');
  });

  it('refuses a blank holder and an empty batch, since a claim nobody holds parks the idea', async () => {
    await expect(applyIdeaClaim([{ slug: 'rolling-window', by: '  ' }])).rejects.toThrow(/needs a holder/);
    await expect(applyIdeaClaim([])).rejects.toThrow(/no idea claims given/);
  });

  it('writes nothing for a slug the ledger does not carry', async () => {
    const result = await applyIdeaClaim([{ slug: 'never-proposed', by: 'run-a' }]);

    expect(result.meta.unknown).toEqual(['never-proposed']);
    expect(result.rows).toEqual([]);
  });
});

describe('applyIdeaArea', () => {
  it('re-files an idea, leaving its decision exactly where it was', async () => {
    await applyIdeaStatus([{ slug: 'rolling-window', status: 'rejected', note: 'covered by /trends' }]);
    const filed = await applyIdeaArea([{ slug: 'rolling-window', area: 'services' }]);

    expect(filed.meta.updated).toEqual(['rolling-window']);
    expect(filed.rows[0]?.area).toBe('services');
    expect(filed.rows[0]?.status).toBe('rejected');
    expect(filed.rows[0]?.note).toBe('covered by /trends');
    expect(filed.meta.areas.areas.services).toBe(1);
    expect((await readIdeasStore()).ideas['rolling-window']?.area).toBe('services');
  });

  it('refuses an area that is not kebab-case, and an empty batch, writing nothing', async () => {
    await expect(applyIdeaArea([{ slug: 'rolling-window', area: 'Not Kebab' }])).rejects.toThrow(
      /not a kebab-case area/,
    );
    await expect(applyIdeaArea([])).rejects.toThrow(/no idea filings given/);
    expect((await readIdeasStore()).ideas['rolling-window']?.area).toBe('ui-ux');
  });

  it('writes nothing for a slug the ledger does not carry', async () => {
    const result = await applyIdeaArea([{ slug: 'never-proposed', area: 'services' }]);
    expect(result.meta.unknown).toEqual(['never-proposed']);
    expect(result.rows).toEqual([]);
  });
});

describe('applyIdeaComment', () => {
  it('writes a comment beside the note rather than over it', async () => {
    await applyIdeaStatus([{ slug: 'rolling-window', status: 'rejected', note: 'covered by /trends' }]);
    const commented = await applyIdeaComment([{ slug: 'rolling-window', text: 'revisit once /trends lands' }]);

    expect(commented.rows[0]?.comment).toBe('revisit once /trends lands');
    expect(commented.rows[0]?.note).toBe('covered by /trends');
    expect(commented.rows[0]?.status).toBe('rejected');

    // And an empty one clears it, which is the editor's Clear button.
    const cleared = await applyIdeaComment([{ slug: 'rolling-window', text: '' }]);
    expect(cleared.rows[0]?.comment).toBeUndefined();
    expect(cleared.rows[0]?.note).toBe('covered by /trends');
  });

  it('refuses a comment that is not text, and an empty batch', async () => {
    // What a caller who skipped validation would send, left untyped up to the cast below.
    const notText: unknown[] = [{ slug: 'rolling-window', text: 42 }];
    // SAFETY: deliberately mistyped to exercise applyIdeaComment's own runtime
    // rejection of a non-string `text` — the assertion opts out of the compile-time
    // check that would otherwise catch what this test wants to reach at runtime.
    await expect(applyIdeaComment(notText as Parameters<typeof applyIdeaComment>[0])).rejects.toThrow(
      /needs a comment/,
    );
    await expect(applyIdeaComment([])).rejects.toThrow(/no idea comments given/);
  });
});
