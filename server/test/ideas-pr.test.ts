import type { PullRequestRow } from '@claude-proxy/core';
import { describe, expect, it } from 'vitest';
import { observePullRequest, renderIdeaPrTransition } from '../src/ideas-pr.js';

function pr(over: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    number: 141,
    title: 'Link PRs to ideas',
    author: 'llevasseur',
    state: 'open',
    isDraft: false,
    url: 'https://github.com/llevasseur/claude-proxy/pull/141',
    baseRefName: 'main',
    headRefName: 'feat/link-prs-to-ideas',
    body: '',
    labels: [],
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    mergedAt: null,
    mergeCommit: null,
    closedAt: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    ...over,
  };
}

const LIVE = new Set(['main', 'feat/link-prs-to-ideas']);

describe('what a PR row means for a claim', () => {
  it('reads merged and closed straight off the row', () => {
    expect(observePullRequest(pr({ state: 'merged' }), LIVE).outcome).toBe('merged');
    expect(observePullRequest(pr({ state: 'closed' }), LIVE).outcome).toBe('closed');
  });

  it('is open while the head branch is still on the remote', () => {
    expect(observePullRequest(pr(), LIVE).outcome).toBe('open');
  });

  it('is detached when an open PR has lost its head branch', () => {
    expect(observePullRequest(pr(), new Set(['main'])).outcome).toBe('detached');
  });

  it('assumes every branch is alive when the remote could not be read', () => {
    // The dangerous direction: an offline scheduled run must not read "no heads"
    // as "every branch deleted" and release the whole ledger.
    expect(observePullRequest(pr(), null).outcome).toBe('open');
  });

  it('does not call a merged PR detached just because its branch was deleted after', () => {
    expect(observePullRequest(pr({ state: 'merged' }), new Set(['main'])).outcome).toBe('merged');
  });
});

describe('the log line', () => {
  it('says the slug, the move and the reason', () => {
    const line = renderIdeaPrTransition({
      slug: 'rolling-window',
      pr: 'https://example.test/1',
      from: 'claimed',
      to: 'shipped',
      outcome: 'merged',
      why: 'https://example.test/1 merged',
    });
    expect(line).toBe('rolling-window: claimed → shipped — https://example.test/1 merged');
  });
});
