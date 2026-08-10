import { describe, expect, it } from 'vitest';
import {
  applyIdeaAdds,
  applyIdeaClaims,
  applyIdeaComments,
  applyIdeaFilings,
  applyIdeaMarks,
  canShipIdea,
  claimableIdeaRows,
  countIdeaAreas,
  countIdeaStatuses,
  emptyIdeasStore,
  IDEA_CLAIM_TTL_MS,
  type IdeaAdd,
  type IdeaEntry,
  type IdeaEvidence,
  type IdeasStore,
  ideaAreaLabel,
  ideaOf,
  ideaRationaleBullets,
  ideaRows,
  ideaTaskPrompt,
  isIdeaArea,
  isIdeaClaimStale,
  isIdeaRepo,
  isIdeaSlug,
  isIdeaTakeable,
  parseIdeaAdds,
  parseIdeaClaims,
  parseIdeaComments,
  parseIdeaFilings,
  parseIdeaMarks,
  parseIdeasStore,
  SEED_IDEA_AREAS,
  similarAreas,
  similarIdeaSlugs,
} from '../src/index.js';

const EVIDENCE: IdeaEvidence[] = [{ source: 'open-question', path: 'docs/features/session-suggestions.md' }];

function add(slug: string, over: Partial<IdeaAdd> = {}): IdeaAdd {
  return {
    slug,
    title: `Idea ${slug}`,
    rationale: 'Because the open question says so.',
    evidence: EVIDENCE,
    repo: 'llevasseur/claude-proxy',
    area: 'ui-ux',
    ...over,
  };
}

describe('slug and repo shapes', () => {
  it('accepts kebab-case and refuses everything else', () => {
    expect(isIdeaSlug('rolling-window-view')).toBe(true);
    expect(isIdeaSlug('one')).toBe(true);
    expect(isIdeaSlug('Rolling-Window')).toBe(false);
    expect(isIdeaSlug('rolling--window')).toBe(false);
    expect(isIdeaSlug('-rolling')).toBe(false);
    expect(isIdeaSlug('rolling_window')).toBe(false);
    expect(isIdeaSlug('')).toBe(false);
  });

  it('refuses a checkout path where a remote slug belongs', () => {
    expect(isIdeaRepo('llevasseur/claude-proxy')).toBe(true);
    // The ledger is device-wide, so a path names a different thing elsewhere.
    expect(isIdeaRepo('/Users/someone/Documents/ghub/claude-proxy')).toBe(false);
    expect(isIdeaRepo('~/claude-proxy')).toBe(false);
    expect(isIdeaRepo('claude-proxy')).toBe(false);
    expect(isIdeaRepo('a/b/c')).toBe(false);
  });
});

describe('adding', () => {
  it('records a proposal as proposed, and persists it', () => {
    const { store, added, refused } = applyIdeaAdds(emptyIdeasStore(), [add('rolling-window')], new Date('2026-08-05'));
    expect(added).toEqual(['rolling-window']);
    expect(refused).toEqual([]);
    const entry = ideaOf(store, 'rolling-window');
    expect(entry?.status).toBe('proposed');
    expect(entry?.created).toBe('2026-08-05T00:00:00.000Z');
    // Unlike a pending suggestion, a proposed idea survives a round trip.
    expect(ideaOf(parseIdeasStore(JSON.parse(JSON.stringify(store))), 'rolling-window')?.status).toBe('proposed');
  });

  it('refuses a slug already present, in any status, without overwriting it', () => {
    const first = applyIdeaAdds(emptyIdeasStore(), [add('rolling-window')], new Date('2026-08-01'));
    const marked = applyIdeaMarks(
      first.store,
      [{ slug: 'rolling-window', status: 'rejected', note: 'covered by /trends' }],
      new Date('2026-08-02'),
    );
    const second = applyIdeaAdds(
      marked.store,
      [add('rolling-window', { title: 'Different title' })],
      new Date('2026-08-05'),
    );

    expect(second.added).toEqual([]);
    expect(second.refused).toEqual(['rolling-window']);
    const entry = ideaOf(second.store, 'rolling-window');
    // The reason is the row worth keeping.
    expect(entry?.status).toBe('rejected');
    expect(entry?.note).toBe('covered by /trends');
    expect(entry?.title).toBe('Idea rolling-window');
  });

  it('records the rest of a batch when one slug collides', () => {
    const first = applyIdeaAdds(emptyIdeasStore(), [add('one')]);
    const second = applyIdeaAdds(first.store, [add('one'), add('two'), add('three')]);
    expect(second.added).toEqual(['two', 'three']);
    expect(second.refused).toEqual(['one']);
  });

  it('never mutates the input store', () => {
    const store = emptyIdeasStore();
    applyIdeaAdds(store, [add('one')]);
    expect(store.ideas).toEqual({});
  });
});

describe('marking', () => {
  it('moves an idea and dates the change, keeping created', () => {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('one')], new Date('2026-08-01'));
    const result = applyIdeaMarks(store, [{ slug: 'one', status: 'accepted' }], new Date('2026-08-05'));
    const entry = ideaOf(result.store, 'one');
    expect(entry?.status).toBe('accepted');
    expect(entry?.created).toBe('2026-08-01T00:00:00.000Z');
    expect(entry?.updated).toBe('2026-08-05T00:00:00.000Z');
  });

  it('writes nothing for a slug the ledger does not carry', () => {
    const result = applyIdeaMarks(emptyIdeasStore(), [{ slug: 'nope', status: 'accepted' }]);
    expect(result.unknown).toEqual(['nope']);
    expect(result.updated).toEqual([]);
    // The opposite of a suggestion flag, which is written for an unknown id.
    expect(result.store.ideas).toEqual({});
  });

  it('keeps an existing note when the mark carries none', () => {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('one')]);
    const rejected = applyIdeaMarks(store, [{ slug: 'one', status: 'rejected', note: 'too big' }]);
    const revived = applyIdeaMarks(rejected.store, [{ slug: 'one', status: 'proposed' }]);
    expect(ideaOf(revived.store, 'one')?.note).toBe('too big');
  });
});

describe('claiming', () => {
  const T0 = new Date('2026-08-07T00:00:00.000Z');
  /** An accepted idea — the only state a fresh claim may be taken from. */
  function accepted(slug = 'one') {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add(slug)], new Date('2026-08-01'));
    return applyIdeaMarks(store, [{ slug, status: 'accepted' }], new Date('2026-08-02')).store;
  }

  it('takes an accepted idea, stamping the holder and the start of work', () => {
    const result = applyIdeaClaims(accepted(), [{ slug: 'one', by: 'feat/one' }], T0);
    expect(result.claimed).toEqual(['one']);
    const entry = ideaOf(result.store, 'one');
    expect(entry?.status).toBe('claimed');
    expect(entry?.claim).toEqual({ by: 'feat/one', at: '2026-08-07T00:00:00.000Z' });
    // `created` is still the proposal, not the claim.
    expect(entry?.created).toBe('2026-08-01T00:00:00.000Z');
  });

  it('refuses an idea another run already holds, naming the holder', () => {
    const held = applyIdeaClaims(accepted(), [{ slug: 'one', by: 'run-a' }], T0).store;
    const second = applyIdeaClaims(held, [{ slug: 'one', by: 'run-b' }], new Date('2026-08-07T01:00:00.000Z'));
    expect(second.claimed).toEqual([]);
    expect(second.refused).toEqual([
      { slug: 'one', status: 'claimed', heldBy: 'run-a', since: '2026-08-07T00:00:00.000Z' },
    ]);
    // Nothing was written for it: the loser walks away, it does not overwrite.
    expect(ideaOf(second.store, 'one')?.claim?.by).toBe('run-a');
  });

  it('refuses a proposed idea, so a claim cannot route around the human sign-off', () => {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('one')]);
    const result = applyIdeaClaims(store, [{ slug: 'one', by: 'run-a' }], T0);
    expect(result.claimed).toEqual([]);
    expect(result.refused).toEqual([{ slug: 'one', status: 'proposed' }]);
  });

  it('lets a second run take over once the claim goes stale, but not a moment before', () => {
    const held = applyIdeaClaims(accepted(), [{ slug: 'one', by: 'died' }], T0).store;
    const justBefore = new Date(T0.getTime() + IDEA_CLAIM_TTL_MS - 1);
    const atExpiry = new Date(T0.getTime() + IDEA_CLAIM_TTL_MS);

    expect(isIdeaClaimStale(ideaOf(held, 'one')!, justBefore)).toBe(false);
    expect(applyIdeaClaims(held, [{ slug: 'one', by: 'run-b' }], justBefore).claimed).toEqual([]);

    expect(isIdeaClaimStale(ideaOf(held, 'one')!, atExpiry)).toBe(true);
    const taken = applyIdeaClaims(held, [{ slug: 'one', by: 'run-b' }], atExpiry);
    expect(taken.claimed).toEqual(['one']);
    expect(ideaOf(taken.store, 'one')?.claim?.by).toBe('run-b');
  });

  it('never expires a claim that has produced a PR, however old', () => {
    const held = applyIdeaClaims(accepted(), [{ slug: 'one', by: 'run-a', pr: 'https://…/141' }], T0).store;
    // A PR review outlives the TTL by days; the open PR is the evidence the work exists.
    const muchLater = new Date(T0.getTime() + IDEA_CLAIM_TTL_MS * 100);
    expect(isIdeaClaimStale(ideaOf(held, 'one')!, muchLater)).toBe(false);
    expect(applyIdeaClaims(held, [{ slug: 'one', by: 'run-b' }], muchLater).claimed).toEqual([]);
  });

  it('treats a re-claim by the same holder as idempotent, and as how a PR is attached', () => {
    const held = applyIdeaClaims(accepted(), [{ slug: 'one', by: 'run-a' }], T0).store;
    const later = new Date(T0.getTime() + 60_000);
    const again = applyIdeaClaims(held, [{ slug: 'one', by: 'run-a', pr: 'https://…/141' }], later);
    expect(again.claimed).toEqual(['one']);
    expect(ideaOf(again.store, 'one')?.claim).toEqual({
      by: 'run-a',
      at: later.toISOString(),
      pr: 'https://…/141',
    });
    // And a plain re-claim keeps the PR rather than dropping it.
    expect(applyIdeaClaims(again.store, [{ slug: 'one', by: 'run-a' }], later).store.ideas.one?.claim?.pr).toBe(
      'https://…/141',
    );
  });

  it('takes the free ideas in a batch that also collides, and writes nothing unknown', () => {
    let store = accepted('one');
    store = applyIdeaAdds(store, [add('two')], new Date('2026-08-01')).store;
    store = applyIdeaMarks(store, [{ slug: 'two', status: 'accepted' }]).store;
    store = applyIdeaClaims(store, [{ slug: 'one', by: 'run-a' }], T0).store;

    const result = applyIdeaClaims(
      store,
      [
        { slug: 'one', by: 'run-b' },
        { slug: 'two', by: 'run-b' },
        { slug: 'nope', by: 'run-b' },
      ],
      T0,
    );
    expect(result.claimed).toEqual(['two']);
    expect(result.refused.map((r) => r.slug)).toEqual(['one']);
    expect(result.unknown).toEqual(['nope']);
    expect(result.store.ideas.nope).toBeUndefined();
  });

  it('never mutates the input store', () => {
    const store = accepted();
    applyIdeaClaims(store, [{ slug: 'one', by: 'run-a' }], T0);
    expect(ideaOf(store, 'one')?.status).toBe('accepted');
    expect(ideaOf(store, 'one')?.claim).toBeUndefined();
  });
});

describe('releasing a claim', () => {
  const T0 = new Date('2026-08-07T00:00:00.000Z');
  function claimed() {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('one')], new Date('2026-08-01'));
    const signed = applyIdeaMarks(store, [{ slug: 'one', status: 'accepted' }]).store;
    return applyIdeaClaims(signed, [{ slug: 'one', by: 'run-a' }], T0).store;
  }

  it('drops the claim on every mark but shipped, which is the explicit release', () => {
    for (const status of ['accepted', 'proposed', 'rejected'] as const) {
      const released = applyIdeaMarks(claimed(), [{ slug: 'one', status, note: 'why' }]);
      expect(ideaOf(released.store, 'one')?.claim, status).toBeUndefined();
      expect(ideaOf(released.store, 'one')?.status).toBe(status);
    }
  });

  it('keeps the claim on shipped, as the record of who built it', () => {
    const shipped = applyIdeaMarks(claimed(), [{ slug: 'one', status: 'shipped', note: 'https://…/141' }]);
    expect(ideaOf(shipped.store, 'one')?.claim?.by).toBe('run-a');
  });

  it('offers a released idea back to the next run that asks', () => {
    const released = applyIdeaMarks(claimed(), [{ slug: 'one', status: 'accepted' }]).store;
    const retaken = applyIdeaClaims(released, [{ slug: 'one', by: 'run-b' }], new Date(T0.getTime() + 60_000));
    expect(retaken.claimed).toEqual(['one']);
  });

  // The release drops the holder and the PR url with it, so a reader offering a
  // re-claim has to collect both again rather than restore them.
  it('takes the PR url with the claim, leaving nothing to restore it from', () => {
    const withPr = applyIdeaClaims(claimed(), [{ slug: 'one', by: 'run-a', pr: 'https://…/141' }], T0).store;
    const released = applyIdeaMarks(withPr, [{ slug: 'one', status: 'accepted' }]).store;

    expect(ideaOf(released, 'one')?.claim).toBeUndefined();
    expect(ideaOf(released, 'one')?.note).toBeUndefined();
  });
});

describe('what may be shipped', () => {
  it('is the two statuses carrying a sign-off, and never the terminal one', () => {
    // `claimed` is the ordinary case; `accepted` is a released claim whose PR
    // merged anyway, which the release did not un-land.
    expect(canShipIdea('claimed')).toBe(true);
    expect(canShipIdea('accepted')).toBe(true);
    // Terminal by design — see `planIdeaPrTransitions`, where no outcome moves it.
    expect(canShipIdea('shipped')).toBe(false);
    // No sign-off, so shipping one would record work against an idea nobody agreed to.
    expect(canShipIdea('proposed')).toBe(false);
    expect(canShipIdea('rejected')).toBe(false);
  });
});

describe('what a holder may take', () => {
  const T0 = new Date('2026-08-07T00:00:00.000Z');

  function stored(slug: string): IdeasStore {
    return applyIdeaAdds(emptyIdeasStore(), [add(slug)], new Date('2026-08-01')).store;
  }
  function entry(store: IdeasStore, slug: string): IdeaEntry {
    const found = ideaOf(store, slug);
    if (!found) throw new Error(`no entry for ${slug}`);
    return found;
  }

  it('answers exactly what applyIdeaClaims then does', () => {
    const proposed = stored('one');
    expect(isIdeaTakeable(entry(proposed, 'one'), 'run-a', T0)).toBe(false);
    expect(applyIdeaClaims(proposed, [{ slug: 'one', by: 'run-a' }], T0).claimed).toEqual([]);

    const accepted = applyIdeaMarks(proposed, [{ slug: 'one', status: 'accepted' }]).store;
    expect(isIdeaTakeable(entry(accepted, 'one'), 'run-a', T0)).toBe(true);

    const held = applyIdeaClaims(accepted, [{ slug: 'one', by: 'run-a' }], T0).store;
    // The holder's own re-claim is idempotent; a second run is refused until the TTL.
    expect(isIdeaTakeable(entry(held, 'one'), 'run-a', T0)).toBe(true);
    expect(isIdeaTakeable(entry(held, 'one'), 'run-b', T0)).toBe(false);
    expect(isIdeaTakeable(entry(held, 'one'), 'run-b', new Date(T0.getTime() + IDEA_CLAIM_TTL_MS))).toBe(true);

    const shipped = applyIdeaMarks(held, [{ slug: 'one', status: 'shipped', note: 'https://…/141' }]).store;
    expect(isIdeaTakeable(entry(shipped, 'one'), 'run-a', T0)).toBe(false);
  });
});

describe('what an implementation run may take', () => {
  const T0 = new Date('2026-08-07T00:00:00.000Z');

  it('is accepted plus expired claims — never a live one, never an unsigned idea', () => {
    let store = applyIdeaAdds(emptyIdeasStore(), [add('unsigned')], new Date('2026-08-01')).store;
    store = applyIdeaAdds(store, [add('free')], new Date('2026-08-02')).store;
    store = applyIdeaAdds(store, [add('live')], new Date('2026-08-03')).store;
    store = applyIdeaAdds(store, [add('abandoned')], new Date('2026-08-04')).store;
    store = applyIdeaMarks(store, [
      { slug: 'free', status: 'accepted' },
      { slug: 'live', status: 'accepted' },
      { slug: 'abandoned', status: 'accepted' },
    ]).store;
    store = applyIdeaClaims(store, [{ slug: 'abandoned', by: 'died' }], T0).store;
    const now = new Date(T0.getTime() + IDEA_CLAIM_TTL_MS + 1);
    store = applyIdeaClaims(store, [{ slug: 'live', by: 'run-a' }], now).store;

    expect(claimableIdeaRows(store, {}, now).map((r) => r.slug)).toEqual(['free', 'abandoned']);
    // The two queries a run might reach for instead, and what each gets wrong.
    expect(ideaRows(store, { statuses: ['accepted'] }).map((r) => r.slug)).toEqual(['free']);
    expect(ideaRows(store, { statuses: ['accepted', 'claimed'] }).map((r) => r.slug)).toEqual([
      'free',
      'live',
      'abandoned',
    ]);
  });
});

describe('parsing untrusted input', () => {
  it('refuses an idea that cites nothing', () => {
    expect(() => parseIdeaAdds([{ ...add('one'), evidence: [] }])).toThrow(/must cite at least one/);
    expect(() => parseIdeaAdds([{ ...add('one'), evidence: undefined }])).toThrow(/must cite at least one/);
  });

  it('refuses evidence with a source but no locator', () => {
    expect(() => parseIdeaAdds([{ ...add('one'), evidence: [{ source: 'open-question' }] }])).toThrow(
      /must cite at least one/,
    );
  });

  it('accepts a judge note located by bucket and id', () => {
    const [parsed] = parseIdeaAdds([
      { ...add('one'), evidence: [{ source: 'judge-note', bucket: 38, id: 'redundant-reads' }] },
    ]);
    expect(parsed?.evidence[0]).toEqual({ source: 'judge-note', bucket: 38, id: 'redundant-reads' });
  });

  it('refuses a bad slug, a bad repo, and a repeated slug in one batch', () => {
    expect(() => parseIdeaAdds([add('Not_Kebab')])).toThrow(/kebab-case/);
    expect(() => parseIdeaAdds([add('one', { repo: '/Users/x/repo' })])).toThrow(/git remote slug/);
    expect(() => parseIdeaAdds([add('one'), add('one')])).toThrow(/repeats one/);
  });

  it('refuses a non-array and an empty array', () => {
    expect(() => parseIdeaAdds({})).toThrow(/must be an array/);
    expect(() => parseIdeaAdds([])).toThrow(/must not be empty/);
    expect(() => parseIdeaMarks([])).toThrow(/must not be empty/);
  });

  it('refuses a mark with an unknown status', () => {
    expect(() => parseIdeaMarks([{ slug: 'one', status: 'done' }])).toThrow(/must be one of/);
  });

  it('accepts claimed as a status, since it is one of the five', () => {
    expect(parseIdeaMarks([{ slug: 'one', status: 'claimed' }])[0]?.status).toBe('claimed');
  });

  it('refuses a claim with no holder', () => {
    expect(() => parseIdeaClaims([{ slug: 'one' }])).toThrow(/must name the holder/);
    expect(() => parseIdeaClaims([{ slug: 'one', by: '  ' }])).toThrow(/must name the holder/);
    expect(() => parseIdeaClaims([])).toThrow(/must not be empty/);
    expect(parseIdeaClaims([{ slug: 'one', by: ' run-a ' }])[0]).toEqual({ slug: 'one', by: 'run-a' });
  });
});

describe('reading a stored file', () => {
  it('drops an entry with no evidence, a bad repo, or an unknown status', () => {
    const store = parseIdeasStore({
      version: 1,
      ideas: {
        good: { title: 'Good', rationale: 'r', evidence: EVIDENCE, repo: 'a/b', status: 'proposed' },
        naked: { title: 'No evidence', rationale: 'r', evidence: [], repo: 'a/b', status: 'proposed' },
        pathy: { title: 'Path repo', rationale: 'r', evidence: EVIDENCE, repo: '/abs/path', status: 'proposed' },
        weird: { title: 'Bad status', rationale: 'r', evidence: EVIDENCE, repo: 'a/b', status: 'done' },
        Bad_Key: { title: 'Bad key', rationale: 'r', evidence: EVIDENCE, repo: 'a/b', status: 'proposed' },
      },
    });
    expect(Object.keys(store.ideas)).toEqual(['good']);
  });

  it('round-trips a claim, and drops a malformed one without dropping the idea', () => {
    const store = parseIdeasStore({
      version: 1,
      ideas: {
        held: {
          title: 'Held',
          rationale: 'r',
          evidence: EVIDENCE,
          repo: 'a/b',
          status: 'claimed',
          claim: { by: 'run-a', at: '2026-08-07T00:00:00.000Z', pr: 'https://…/141' },
        },
        headless: {
          title: 'Bad claim',
          rationale: 'r',
          evidence: EVIDENCE,
          repo: 'a/b',
          status: 'claimed',
          claim: { at: '2026-08-07T00:00:00.000Z' },
        },
      },
    });
    expect(store.ideas.held?.claim).toEqual({ by: 'run-a', at: '2026-08-07T00:00:00.000Z', pr: 'https://…/141' });
    // The idea survives; only the unreadable holder is dropped, which leaves the
    // entry takeable rather than locked by a row nobody can act on.
    expect(store.ideas.headless).toBeDefined();
    expect(store.ideas.headless?.claim).toBeUndefined();
  });

  it('reads an unparseable claim timestamp as stale rather than as a permanent lock', () => {
    const store = parseIdeasStore({
      version: 1,
      ideas: {
        stuck: {
          title: 'Stuck',
          rationale: 'r',
          evidence: EVIDENCE,
          repo: 'a/b',
          status: 'claimed',
          claim: { by: 'run-a', at: 'not a date' },
        },
      },
    });
    expect(isIdeaClaimStale(store.ideas.stuck!, new Date('2026-08-07'))).toBe(true);
  });

  it('reads a missing or malformed file as empty', () => {
    expect(parseIdeasStore(null).ideas).toEqual({});
    expect(parseIdeasStore([]).ideas).toEqual({});
    expect(parseIdeasStore({ ideas: 'nope' }).ideas).toEqual({});
  });
});

describe('listing', () => {
  it('filters by status and repo, oldest first', () => {
    let store = applyIdeaAdds(emptyIdeasStore(), [add('first')], new Date('2026-08-01')).store;
    store = applyIdeaAdds(store, [add('second', { repo: 'llevasseur/my-command' })], new Date('2026-08-02')).store;
    store = applyIdeaAdds(store, [add('third')], new Date('2026-08-03')).store;
    store = applyIdeaMarks(store, [{ slug: 'third', status: 'accepted' }]).store;

    expect(ideaRows(store).map((r) => r.slug)).toEqual(['first', 'second', 'third']);
    expect(ideaRows(store, { statuses: ['accepted'] }).map((r) => r.slug)).toEqual(['third']);
    expect(ideaRows(store, { repo: 'llevasseur/my-command' }).map((r) => r.slug)).toEqual(['second']);
    expect(ideaRows(store, { statuses: ['accepted'], repo: 'llevasseur/my-command' })).toEqual([]);
    expect(countIdeaStatuses(ideaRows(store))).toEqual({
      proposed: 2,
      accepted: 1,
      claimed: 0,
      rejected: 0,
      shipped: 0,
    });
  });
});

describe('near-duplicate detection', () => {
  it('surfaces an existing slug that shares most of its tokens', () => {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('rolling-window-view'), add('defect-threshold-link')]);
    expect(similarIdeaSlugs(store, 'rolling-window')).toEqual(['rolling-window-view']);
    expect(similarIdeaSlugs(store, 'add-the-rolling-window')).toEqual(['rolling-window-view']);
    expect(similarIdeaSlugs(store, 'session-graph-zoom')).toEqual([]);
  });

  it('does not report the slug itself', () => {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('rolling-window')]);
    expect(similarIdeaSlugs(store, 'rolling-window')).toEqual([]);
  });
});

describe('areas', () => {
  it('takes the same shape as a slug, and nothing else', () => {
    expect(isIdeaArea('ui-ux')).toBe(true);
    expect(isIdeaArea('infrastructure')).toBe(true);
    expect(isIdeaArea('UI-UX')).toBe(false);
    expect(isIdeaArea('ui--ux')).toBe(false);
    expect(isIdeaArea('-unfiled')).toBe(false);
    expect(isIdeaArea('')).toBe(false);
    expect(isIdeaArea(undefined)).toBe(false);
  });

  it('is required on the way in — refused exactly as evidence is', () => {
    const { area: _dropped, ...arealess } = add('one');
    expect(() => parseIdeaAdds([arealess])).toThrow(/area must be a kebab-case area/);
    expect(() => parseIdeaAdds([add('one', { area: 'Not_Kebab' })])).toThrow(/area must be a kebab-case area/);
    // Any word will do: the seeds are a vocabulary, never a whitelist.
    expect(parseIdeaAdds([add('one', { area: 'observability' })])[0]?.area).toBe('observability');
  });

  it('names the seeds in the refusal, so the vocabulary is discoverable from the error', () => {
    const { area: _dropped, ...arealess } = add('one');
    for (const seed of SEED_IDEA_AREAS) expect(() => parseIdeaAdds([arealess])).toThrow(seed.area);
  });

  it('is tolerated absent on the way out, so a legacy row keeps its rejection reason', () => {
    const store = parseIdeasStore({
      version: 1,
      ideas: {
        legacy: {
          title: 'Written before areas existed',
          rationale: 'r',
          evidence: EVIDENCE,
          repo: 'a/b',
          status: 'rejected',
          note: 'covered by /trends',
        },
      },
    });
    // Dropping it would lose the reason, and the reason is what dedupes the ledger.
    expect(store.ideas.legacy).toBeDefined();
    expect(store.ideas.legacy?.area).toBeUndefined();
    expect(store.ideas.legacy?.note).toBe('covered by /trends');
    expect(ideaAreaLabel(store.ideas.legacy?.area)).toBe('Unfiled');
  });

  it('labels a seed by its written-out name and an invented one by its own words', () => {
    expect(ideaAreaLabel('ui-ux')).toBe('UI/UX');
    expect(ideaAreaLabel('code-quality')).toBe('Code Quality');
    // An invented area has no label to look up, so the slug's own words are it.
    expect(ideaAreaLabel('observability')).toBe('Observability');
    expect(ideaAreaLabel('build-times')).toBe('Build Times');
  });

  it('filters and counts by area, with every seed present at zero', () => {
    let store = applyIdeaAdds(emptyIdeasStore(), [add('one')], new Date('2026-08-01')).store;
    store = applyIdeaAdds(store, [add('two', { area: 'infrastructure' })], new Date('2026-08-02')).store;
    // A legacy row, as it comes off disk: no area at all.
    store = parseIdeasStore({
      version: 1,
      ideas: {
        ...JSON.parse(JSON.stringify(store)).ideas,
        old: { title: 'Legacy', rationale: 'r', evidence: EVIDENCE, repo: 'a/b', status: 'proposed' },
      },
    });

    expect(ideaRows(store, { area: 'ui-ux' }).map((r) => r.slug)).toEqual(['one']);
    // An area-less row matches no area filter at all, rather than every one.
    expect(ideaRows(store, { area: 'infrastructure' }).map((r) => r.slug)).toEqual(['two']);
    expect(countIdeaAreas(ideaRows(store))).toEqual({
      areas: { 'ui-ux': 1, infrastructure: 1, 'code-quality': 0, services: 0, commands: 0 },
      unfiled: 1,
    });
  });

  it('surfaces an abbreviation of an area already in use, without refusing it', () => {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('one', { area: 'infrastructure' })]);
    expect(similarAreas(store, 'infra')).toEqual(['infrastructure']);
    expect(similarAreas(store, 'infrastructure')).toEqual([]);
    expect(similarAreas(store, 'observability')).toEqual([]);
  });
});

describe('the commands area, which is the one area core knows the meaning of', () => {
  const GAP: IdeaEvidence[] = [{ source: 'command-gap' }];

  it('accepts a command-gap standing alone, which no other source may do', () => {
    const [parsed] = parseIdeaAdds([add('one', { area: 'commands', evidence: GAP })]);
    expect(parsed?.evidence).toEqual([{ source: 'command-gap' }]);
    // Every other source still needs a locator, alone or not.
    expect(() => parseIdeaAdds([add('one', { evidence: [{ source: 'deferral' }] })])).toThrow(/must cite at least one/);
  });

  it('refuses a command-gap filed anywhere else, however much else it cites', () => {
    expect(() => parseIdeaAdds([add('one', { area: 'ui-ux', evidence: GAP })])).toThrow(/confined to the commands/);
    expect(() =>
      parseIdeaAdds([add('one', { area: 'ui-ux', evidence: [...EVIDENCE, { source: 'command-gap' }] })]),
    ).toThrow(/confined to the commands/);
  });

  it('refuses re-filing one out of commands, since that is the other way into the forbidden state', () => {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('one', { area: 'commands', evidence: GAP })]);
    expect(() => applyIdeaFilings(store, [{ slug: 'one', area: 'ui-ux' }])).toThrow(/confined to the commands/);
    // Refused over the whole batch before anything is written, never half-applied.
    const both = applyIdeaAdds(store, [add('two')]).store;
    expect(() =>
      applyIdeaFilings(both, [
        { slug: 'two', area: 'services' },
        { slug: 'one', area: 'services' },
      ]),
    ).toThrow(/confined to the commands/);
    expect(ideaOf(both, 'two')?.area).toBe('ui-ux');
  });
});

describe('re-filing', () => {
  it('changes the area and nothing else — not the status, the note, or the claim', () => {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('one')], new Date('2026-08-01'));
    const rejected = applyIdeaMarks(store, [{ slug: 'one', status: 'rejected', note: 'too big' }]).store;
    const filed = applyIdeaFilings(rejected, [{ slug: 'one', area: 'infrastructure' }], new Date('2026-08-05'));

    const entry = ideaOf(filed.store, 'one');
    expect(filed.updated).toEqual(['one']);
    expect(entry?.area).toBe('infrastructure');
    expect(entry?.status).toBe('rejected');
    expect(entry?.note).toBe('too big');
    expect(entry?.created).toBe('2026-08-01T00:00:00.000Z');
    expect(entry?.updated).toBe('2026-08-05T00:00:00.000Z');
  });

  it('classifies a legacy row that reads as Unfiled', () => {
    const store = parseIdeasStore({
      version: 1,
      ideas: { old: { title: 'Legacy', rationale: 'r', evidence: EVIDENCE, repo: 'a/b', status: 'proposed' } },
    });
    expect(ideaOf(applyIdeaFilings(store, [{ slug: 'old', area: 'services' }]).store, 'old')?.area).toBe('services');
  });

  it('writes nothing for a slug the ledger does not carry, and never mutates the input', () => {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('one')]);
    const result = applyIdeaFilings(store, [{ slug: 'nope', area: 'services' }]);
    expect(result.unknown).toEqual(['nope']);
    expect(result.updated).toEqual([]);
    expect(result.store.ideas.nope).toBeUndefined();
    expect(ideaOf(store, 'one')?.area).toBe('ui-ux');
  });

  it('refuses a malformed filing at the parse boundary', () => {
    expect(() => parseIdeaFilings([])).toThrow(/must not be empty/);
    expect(() => parseIdeaFilings([{ slug: 'one' }])).toThrow(/area must be a kebab-case area/);
    expect(() => parseIdeaFilings([{ slug: 'Not_Kebab', area: 'services' }])).toThrow(/slug must be kebab-case/);
    expect(parseIdeaFilings([{ slug: 'one', area: 'services' }])[0]).toEqual({ slug: 'one', area: 'services' });
  });
});

describe('commenting', () => {
  it('round-trips a comment without touching the note', () => {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('one')], new Date('2026-08-01'));
    const rejected = applyIdeaMarks(store, [{ slug: 'one', status: 'rejected', note: 'too big' }]).store;
    const commented = applyIdeaComments(rejected, [{ slug: 'one', text: '  scope it to one page  ' }]);

    const entry = ideaOf(commented.store, 'one');
    expect(commented.updated).toEqual(['one']);
    expect(entry?.comment).toBe('scope it to one page');
    // The two fields are separate on purpose: `note` stays the rejection reason.
    expect(entry?.note).toBe('too big');
    expect(entry?.status).toBe('rejected');
    expect(ideaOf(parseIdeasStore(JSON.parse(JSON.stringify(commented.store))), 'one')?.comment).toBe(
      'scope it to one page',
    );
  });

  it('replaces the comment on each write rather than appending', () => {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('one')]);
    const first = applyIdeaComments(store, [{ slug: 'one', text: 'first' }]).store;
    const second = applyIdeaComments(first, [{ slug: 'one', text: 'second' }]).store;
    expect(ideaOf(second, 'one')?.comment).toBe('second');
  });

  it('clears the comment with an empty one, dropping the field rather than storing ""', () => {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('one')]);
    const written = applyIdeaComments(store, [{ slug: 'one', text: 'something' }]).store;
    const cleared = applyIdeaComments(written, [{ slug: 'one', text: '   ' }]).store;
    expect(ideaOf(cleared, 'one')?.comment).toBeUndefined();
    expect('comment' in (ideaOf(cleared, 'one') as object)).toBe(false);
  });

  it('writes nothing for an unknown slug, and refuses a malformed comment', () => {
    expect(applyIdeaComments(emptyIdeasStore(), [{ slug: 'nope', text: 'x' }]).unknown).toEqual(['nope']);
    expect(() => parseIdeaComments([])).toThrow(/must not be empty/);
    expect(() => parseIdeaComments([{ slug: 'one' }])).toThrow(/text must be a string/);
    // An empty string is the clear, so it parses where a missing field does not.
    expect(parseIdeaComments([{ slug: 'one', text: '' }])[0]).toEqual({ slug: 'one', text: '' });
  });
});

describe('the /task prompt an idea produces', () => {
  function entryOf(over: Partial<IdeaAdd> = {}) {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('rolling-window-view', over)]);
    return { store, entry: ideaOf(store, 'rolling-window-view')! };
  }

  it('opens as a /task invocation naming the slug, area and repo', () => {
    const { entry } = entryOf({ title: 'Rolling window view' });
    const prompt = ideaTaskPrompt(entry);

    expect(prompt.startsWith('/task ')).toBe(true);
    expect(prompt).toContain('Rolling window view');
    expect(prompt).toContain('rolling-window-view');
    expect(prompt).toContain('llevasseur/claude-proxy');
    expect(prompt).toContain('UI/UX');
  });

  it('carries the rationale and every citation, so the premise can be checked', () => {
    const { entry } = entryOf({
      evidence: [{ source: 'open-question', path: 'docs/features/x.md', quote: 'nobody counts a missing command' }],
    });
    const prompt = ideaTaskPrompt(entry);

    expect(prompt).toContain('Because the open question says so.');
    expect(prompt).toContain('open-question docs/features/x.md');
    expect(prompt).toContain('"nobody counts a missing command"');
  });

  it('tells a run to claim the idea before it writes anything, and to attach the PR after', () => {
    const { entry } = entryOf();
    const prompt = ideaTaskPrompt(entry);

    expect(prompt).toContain('ideas claim --slug rolling-window-view --by <your branch>');
    expect(prompt).toContain('--pr <PR url>');
  });

  it('quotes the comment as build criteria, and says nothing about them when there is none', () => {
    const { store, entry } = entryOf();
    expect(ideaTaskPrompt(entry)).not.toContain('Build criteria');

    const commented = applyIdeaComments(store, [{ slug: 'rolling-window-view', text: 'start with the reader' }]);
    const after = ideaOf(commented.store, 'rolling-window-view')!;
    const prompt = ideaTaskPrompt(after);

    expect(prompt).toContain('Build criteria');
    expect(prompt).toContain('start with the reader');
  });

  // Derived rather than stored: the ledger holds no copy to go stale, so a
  // re-filing or a rewritten comment moves the prompt with it.
  it('follows the entry rather than a stored copy', () => {
    const { store } = entryOf();
    const filed = applyIdeaFilings(store, [{ slug: 'rolling-window-view', area: 'infrastructure' }]);
    const prompt = ideaTaskPrompt(ideaOf(filed.store, 'rolling-window-view')!);

    expect(prompt).toContain('Infrastructure');
    expect(prompt).not.toContain('UI/UX');
  });

  it('renders a locator-less command-gap citation without a dangling path', () => {
    const { entry } = entryOf({ area: 'commands', evidence: [{ source: 'command-gap' }] });
    const prompt = ideaTaskPrompt(entry);

    expect(prompt).toContain('command-gap');
    expect(prompt).toContain('the command was never written');
  });
});

describe('ideaRationaleBullets', () => {
  it('reads the shape /ideate writes, label and text apart', () => {
    const rationale = [
      '- **What it is** — a helper that splits a rationale into bullets.',
      '- **The problem** — the dashboard renders the rationale as one line.',
      '',
      '- **Size** — small.',
    ].join('\n');
    expect(ideaRationaleBullets(rationale)).toEqual([
      { label: 'What it is', text: 'a helper that splits a rationale into bullets.' },
      { label: 'The problem', text: 'the dashboard renders the rationale as one line.' },
      { label: 'Size', text: 'small.' },
    ]);
  });

  it('accepts the other bullet markers and the other label separators', () => {
    expect(ideaRationaleBullets('* **Size**: small.\n• plain bullet')).toEqual([
      { label: 'Size', text: 'small.' },
      { text: 'plain bullet' },
    ]);
  });

  it('keeps a label-only bullet as text rather than as an empty label', () => {
    expect(ideaRationaleBullets('- **Depends on `idea-areas`**')).toEqual([{ text: 'Depends on `idea-areas`' }]);
  });

  it('reads the leading run, so bullets closed by a paragraph still preview as a list', () => {
    const rationale = ['- What it is: a preview reading.', '- Size: small.', '', 'The evidence, in prose.'].join('\n');
    expect(ideaRationaleBullets(rationale)).toEqual([
      { text: 'What it is: a preview reading.' },
      { text: 'Size: small.' },
    ]);
  });

  it('returns nothing for a paragraph, so the legacy shape renders as prose', () => {
    expect(ideaRationaleBullets('One paragraph on why it is worth building.')).toEqual([]);
    // The run leads: prose *before* a bullet is prose, never a list with an orphan.
    expect(ideaRationaleBullets('Some prose — with a dash.\n- and a bullet')).toEqual([]);
    expect(ideaRationaleBullets('   ')).toEqual([]);
    // A dash with no word after it is a sentence's punctuation, not a marker.
    expect(ideaRationaleBullets('- ')).toEqual([]);
  });
});
