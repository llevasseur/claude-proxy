import { describe, expect, it } from 'vitest';
import {
  applyIdeaAdds,
  applyIdeaMarks,
  countIdeaStatuses,
  emptyIdeasStore,
  type IdeaAdd,
  type IdeaEvidence,
  ideaOf,
  ideaRows,
  isIdeaRepo,
  isIdeaSlug,
  parseIdeaAdds,
  parseIdeaMarks,
  parseIdeasStore,
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
    // The whole point of the field: the ledger is device-wide, so a path names a
    // different thing on another machine.
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
    // Unlike a pending suggestion, a proposed idea survives a round trip — the
    // ledger has to record what was considered, not only what was liked.
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
    // A rejected idea returning every run is the failure the key prevents, and
    // the reason is the row worth keeping.
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
    // The opposite of a suggestion flag, which is written for an unknown id
    // because the rules are recomputed. An idea exists only here.
    expect(result.store.ideas).toEqual({});
  });

  it('keeps an existing note when the mark carries none', () => {
    const { store } = applyIdeaAdds(emptyIdeasStore(), [add('one')]);
    const rejected = applyIdeaMarks(store, [{ slug: 'one', status: 'rejected', note: 'too big' }]);
    const revived = applyIdeaMarks(rejected.store, [{ slug: 'one', status: 'proposed' }]);
    expect(ideaOf(revived.store, 'one')?.note).toBe('too big');
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
    expect(countIdeaStatuses(ideaRows(store))).toEqual({ proposed: 2, accepted: 1, rejected: 0, shipped: 0 });
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
