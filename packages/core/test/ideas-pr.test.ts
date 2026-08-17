import { describe, expect, it } from 'vitest';
import {
  applyIdeaAdds,
  applyIdeaClaims,
  applyIdeaMarks,
  emptyIdeasStore,
  type IdeaAdd,
  type IdeaClaimRequest,
  type IdeaEvidence,
  type IdeasStore,
  ideaPrLinks,
  parseIdeaPrObservations,
  planIdeaPrTransitions,
  sameIdeaPr,
} from '../src/index.js';

const EVIDENCE: IdeaEvidence[] = [{ source: 'open-question', path: 'docs/features/session-suggestions.md' }];
const PR = 'https://github.com/llevasseur/claude-proxy/pull/141';

function add(slug: string): IdeaAdd {
  return {
    slug,
    title: `Idea ${slug}`,
    rationale: 'Because the open question says so.',
    evidence: EVIDENCE,
    repo: 'llevasseur/claude-proxy',
    area: 'ui-ux',
  };
}

/** An idea claimed by `feat/x` with `pr` on the claim. `null` asks for a claim with no PR. */
function claimed(slug: string, pr: string | null = PR): IdeasStore {
  const added = applyIdeaAdds(emptyIdeasStore(), [add(slug)]).store;
  const accepted = applyIdeaMarks(added, [{ slug, status: 'accepted' }]).store;
  // `pr` stays off the request when the caller passed `null`: the case under test is a
  // claim taken before a PR exists, which is a missing key, not a `pr: undefined`.
  const request: IdeaClaimRequest = { slug, by: 'feat/x' };
  if (pr) request.pr = pr;
  return applyIdeaClaims(accepted, [request]).store;
}

describe('the links a PR outcome can settle', () => {
  it('finds a claimed idea carrying a PR', () => {
    expect(ideaPrLinks(claimed('a'))).toEqual([{ slug: 'a', status: 'claimed', pr: PR }]);
  });

  it('finds a shipped one too, since the mark keeps the claim', () => {
    const shipped = applyIdeaMarks(claimed('a'), [{ slug: 'a', status: 'shipped', note: PR }]).store;
    expect(ideaPrLinks(shipped)).toEqual([{ slug: 'a', status: 'shipped', pr: PR }]);
  });

  it('finds nothing on a claim with no PR, and nothing on a released idea', () => {
    expect(ideaPrLinks(claimed('a', null))).toEqual([]);
    // `accepted` drops the claim, and the url with it.
    const released = applyIdeaMarks(claimed('a'), [{ slug: 'a', status: 'accepted' }]).store;
    expect(ideaPrLinks(released)).toEqual([]);
  });

  it('matches a url the ledger stored with a trailing slash', () => {
    expect(sameIdeaPr(`${PR}/`, PR)).toBe(true);
    expect(sameIdeaPr(` ${PR} `, PR)).toBe(true);
    // Not the same PR, and a GitHub path is case-sensitive.
    expect(sameIdeaPr(`${PR}1`, PR)).toBe(false);
  });
});

describe('planning a status change from a PR', () => {
  it('ships a claimed idea whose PR merged, with the url as the note', () => {
    const plan = planIdeaPrTransitions(claimed('a'), [{ pr: PR, outcome: 'merged' }]);
    expect(plan.transitions).toEqual([
      { slug: 'a', pr: PR, from: 'claimed', to: 'shipped', outcome: 'merged', why: `${PR} merged` },
    ]);
    // The same row `ideas mark -s shipped -n <url>` writes by hand.
    expect(plan.marks).toEqual([{ slug: 'a', status: 'shipped', note: PR }]);
  });

  it('keeps the claim through the shipped mark, so who built it survives', () => {
    const plan = planIdeaPrTransitions(claimed('a'), [{ pr: PR, outcome: 'merged' }]);
    const after = applyIdeaMarks(claimed('a'), plan.marks).store;
    expect(after.ideas.a?.status).toBe('shipped');
    expect(after.ideas.a?.claim?.by).toBe('feat/x');
    expect(after.ideas.a?.note).toBe(PR);
  });

  it('releases a claim back to accepted when the PR was closed unmerged', () => {
    const plan = planIdeaPrTransitions(claimed('a'), [{ pr: PR, outcome: 'closed' }]);
    expect(plan.marks).toEqual([{ slug: 'a', status: 'accepted' }]);
    const after = applyIdeaMarks(claimed('a'), plan.marks).store;
    // Released means claimable again: the human sign-off stays, the holder goes.
    expect(after.ideas.a?.status).toBe('accepted');
    expect(after.ideas.a?.claim).toBeUndefined();
  });

  it('releases it the same way when the head branch is gone', () => {
    const plan = planIdeaPrTransitions(claimed('a'), [{ pr: PR, outcome: 'detached' }]);
    expect(plan.transitions[0]?.to).toBe('accepted');
    expect(plan.transitions[0]?.why).toContain('head branch');
  });

  it('leaves an open PR alone — the claim is doing its job', () => {
    const plan = planIdeaPrTransitions(claimed('a'), [{ pr: PR, outcome: 'open' }]);
    expect(plan.transitions).toEqual([]);
    expect(plan.unchanged).toEqual([{ slug: 'a', status: 'claimed', pr: PR }]);
  });

  it('never un-ships a shipped idea, whatever later happens to its PR', () => {
    const shipped = applyIdeaMarks(claimed('a'), [{ slug: 'a', status: 'shipped', note: PR }]).store;
    for (const outcome of ['open', 'closed', 'detached', 'merged'] as const) {
      const plan = planIdeaPrTransitions(shipped, [{ pr: PR, outcome }]);
      expect(plan.transitions).toEqual([]);
      // Reported as checked rather than silently dropped.
      expect(plan.unchanged.map((l) => l.slug)).toEqual(['a']);
    }
  });

  it('reports a link no observation covered rather than guessing at it', () => {
    // An absent PR is missing data; treating it as closed would release a live claim.
    const plan = planIdeaPrTransitions(claimed('a'), []);
    expect(plan.transitions).toEqual([]);
    expect(plan.unobserved).toEqual([{ slug: 'a', status: 'claimed', pr: PR }]);
  });

  it('stamps the reconciling run onto the marks it plans', () => {
    const by = { thread: '0123456789abcdef' };
    const plan = planIdeaPrTransitions(claimed('a'), [{ pr: PR, outcome: 'merged' }], by);
    expect(plan.marks[0]?.by).toEqual(by);
  });
});

describe('reading observations off untrusted input', () => {
  it('takes a well-formed batch', () => {
    expect(parseIdeaPrObservations([{ pr: ` ${PR} `, outcome: 'merged' }])).toEqual([{ pr: PR, outcome: 'merged' }]);
  });

  it('refuses an unknown outcome, an empty url, and a non-array', () => {
    expect(() => parseIdeaPrObservations([{ pr: PR, outcome: 'reopened' }])).toThrow(/outcome must be one of/);
    expect(() => parseIdeaPrObservations([{ pr: '  ', outcome: 'merged' }])).toThrow(/non-empty PR url/);
    expect(() => parseIdeaPrObservations({})).toThrow(/must be an array/);
  });
});
