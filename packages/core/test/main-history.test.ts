// The lane layout, driven by hand-built graphs rather than a repository: every case
// here is a shape `main` can actually be slid into, written out as commits and refs.
import { describe, expect, it } from 'vitest';
import {
  buildMainHistory,
  classifyMainHistoryRefs,
  hiddenRefFor,
  type MainHistoryCommit,
  type MainHistoryRef,
  type MainPosition,
  needsPin,
  pinRefFor,
  shortSha,
} from '../src/main-history.js';

/** Shas are readable stand-ins — nothing here parses them, it only follows them. */
const commit = (sha: string, ...parents: string[]): MainHistoryCommit => ({ sha, parents });

/** `t` orders the rail: bigger is newer, matching a later `mergedAt`. */
const at = (sha: string, prNumber: number, t: number): MainPosition => ({
  sha,
  prNumber,
  mergedAt: `2026-08-0${t}T00:00:00Z`,
});

const pin = (sha: string): MainHistoryRef => ({ ref: pinRefFor(sha), sha });
const hide = (sha: string): MainHistoryRef => ({ ref: hiddenRefFor(sha), sha });

/** A straight run of five merges, oldest to newest. */
const CHAIN: MainHistoryCommit[] = [
  commit('aaaaaaa1'),
  commit('bbbbbbb2', 'aaaaaaa1'),
  commit('ccccccc3', 'bbbbbbb2'),
  commit('ddddddd4', 'ccccccc3'),
  commit('eeeeeee5', 'ddddddd4'),
];

const CHAIN_POSITIONS: MainPosition[] = [
  at('aaaaaaa1', 1, 1),
  at('bbbbbbb2', 2, 2),
  at('ccccccc3', 3, 3),
  at('ddddddd4', 4, 4),
  at('eeeeeee5', 5, 5),
];

/** Row shas in the order they are drawn, newest first. */
const shas = (g: { rows: { sha: string }[] }): string[] => g.rows.map((r) => r.sha);
const lanes = (g: { rows: { sha: string; lane: number }[] }): Record<string, number> =>
  Object.fromEntries(g.rows.map((r) => [r.sha, r.lane]));

describe('ref naming', () => {
  it('names a pin for the commit it holds, so pinning twice writes the same ref', () => {
    expect(pinRefFor('eeeeeee5abcdef')).toBe('refs/main-history/eeeeeee');
    expect(pinRefFor('eeeeeee5abcdef')).toBe(pinRefFor('eeeeeee5999999'.replace('999999', 'abcdef')));
    expect(shortSha('eeeeeee5abcdef')).toBe('eeeeeee');
  });

  it('keeps the hidden marker on its own ref, never replacing the pin', () => {
    expect(hiddenRefFor('eeeeeee5')).toBe('refs/main-history/hidden/eeeeeee');
    expect(hiddenRefFor('eeeeeee5')).not.toBe(pinRefFor('eeeeeee5'));
  });

  it('splits the namespace into lines and the markers that hide them', () => {
    const { pins, hidden } = classifyMainHistoryRefs([
      pin('eeeeeee5'),
      hide('eeeeeee5'),
      { ref: 'refs/main-history/local-orphan/20260808T101500Z', sha: 'fff0000' },
      { ref: 'refs/heads/main', sha: 'ccccccc3' },
    ]);

    expect(pins.map((p) => p.ref)).toEqual([
      'refs/main-history/eeeeeee',
      'refs/main-history/local-orphan/20260808T101500Z',
    ]);
    expect([...hidden]).toEqual(['eeeeeee']);
  });
});

describe('buildMainHistory', () => {
  it('draws one rail when main is at the tip and nothing has been pinned', () => {
    const g = buildMainHistory({ mainSha: 'eeeeeee5', commits: CHAIN, positions: CHAIN_POSITIONS, refs: [] });

    expect(shas(g)).toEqual(['eeeeeee5', 'ddddddd4', 'ccccccc3', 'bbbbbbb2', 'aaaaaaa1']);
    expect(g.rows.every((r) => r.lane === 0 && r.onMain)).toBe(true);
    expect(g.rows.filter((r) => r.isMain).map((r) => r.prNumber)).toEqual([5]);
    expect(g.mainPr).toBe(5);
    expect(g.width).toBe(1);
    expect(g.lanes).toEqual([]);
  });

  it('puts what main slid off into its own lane, kinked off where it forked', () => {
    const g = buildMainHistory({
      mainSha: 'ccccccc3',
      commits: CHAIN,
      positions: CHAIN_POSITIONS,
      refs: [pin('eeeeeee5')],
    });

    expect(lanes(g)).toEqual({ eeeeeee5: 1, ddddddd4: 1, ccccccc3: 0, bbbbbbb2: 0, aaaaaaa1: 0 });
    expect(g.width).toBe(2);
    expect(g.lanes).toEqual([
      { lane: 1, refs: ['refs/main-history/eeeeeee'], divergesFrom: 'ccccccc3', tip: 'eeeeeee5', base: 'ddddddd4' },
    ]);
    // Sliding back does not change what is reachable — those rows are simply not on main.
    expect(g.rows.filter((r) => !r.onMain).map((r) => r.prNumber)).toEqual([5, 4]);
  });

  it('keeps main a straight rail when a new PR lands on the position it slid back to', () => {
    // The real shape after a slide: F forks off C, which is where the old line forks too.
    const commits = [...CHAIN, commit('fffffff6', 'ccccccc3')];
    const positions = [...CHAIN_POSITIONS, at('fffffff6', 6, 6)];

    const g = buildMainHistory({ mainSha: 'fffffff6', commits, positions, refs: [pin('eeeeeee5')] });

    expect(shas(g)).toEqual(['fffffff6', 'eeeeeee5', 'ddddddd4', 'ccccccc3', 'bbbbbbb2', 'aaaaaaa1']);
    expect(lanes(g)).toEqual({ fffffff6: 0, eeeeeee5: 1, ddddddd4: 1, ccccccc3: 0, bbbbbbb2: 0, aaaaaaa1: 0 });
    expect(g.lanes[0]?.divergesFrom).toBe('ccccccc3');
    expect(g.mainPr).toBe(6);
    expect(g.width).toBe(2);
  });

  it('reads several refs on one commit as one line rather than several', () => {
    const g = buildMainHistory({
      mainSha: 'ccccccc3',
      commits: CHAIN,
      positions: CHAIN_POSITIONS,
      refs: [pin('eeeeeee5'), { ref: 'refs/main-history/local-orphan/20260808T090000Z', sha: 'eeeeeee5' }],
    });

    expect(g.lanes).toHaveLength(1);
    expect(g.lanes[0]?.refs).toEqual(['refs/main-history/eeeeeee', 'refs/main-history/local-orphan/20260808T090000Z']);
    expect(g.width).toBe(2);
  });

  it('folds a pin partway up a line into that line', () => {
    // D is pinned as well as E, but D is already on E's line — that is one lane, not two.
    const g = buildMainHistory({
      mainSha: 'ccccccc3',
      commits: CHAIN,
      positions: CHAIN_POSITIONS,
      refs: [pin('eeeeeee5'), pin('ddddddd4')],
    });

    expect(g.lanes).toHaveLength(1);
    expect(g.lanes[0]?.refs).toEqual(['refs/main-history/ddddddd', 'refs/main-history/eeeeeee']);
    expect(g.width).toBe(2);
  });

  it('reuses a lane once its line has rejoined the rail', () => {
    //   X   forks off D (newest)        Y forks off A (oldest)
    // Their vertical runs do not overlap, so the page stays two lanes wide.
    const commits = [...CHAIN, commit('xxxxxxx7', 'ddddddd4'), commit('yyyyyyy8', 'aaaaaaa1')];
    const positions = [
      at('aaaaaaa1', 1, 1),
      at('yyyyyyy8', 8, 2),
      at('bbbbbbb2', 2, 3),
      at('ccccccc3', 3, 4),
      at('ddddddd4', 4, 5),
      at('xxxxxxx7', 7, 6),
    ];

    const g = buildMainHistory({
      mainSha: 'ddddddd4',
      commits,
      positions,
      refs: [pin('xxxxxxx7'), pin('yyyyyyy8')],
    });

    expect(shas(g)).toEqual(['xxxxxxx7', 'ddddddd4', 'ccccccc3', 'bbbbbbb2', 'yyyyyyy8', 'aaaaaaa1']);
    expect(g.lanes.map((l) => l.lane)).toEqual([1, 1]);
    expect(g.width).toBe(2);
  });

  it('gives overlapping lines lanes of their own', () => {
    // Both fork off A, and both run the whole height, so they cannot share.
    const commits = [...CHAIN, commit('xxxxxxx7', 'aaaaaaa1'), commit('yyyyyyy8', 'aaaaaaa1')];
    const positions = [...CHAIN_POSITIONS, at('xxxxxxx7', 7, 6), at('yyyyyyy8', 8, 7)];

    const g = buildMainHistory({
      mainSha: 'eeeeeee5',
      commits,
      positions,
      refs: [pin('xxxxxxx7'), pin('yyyyyyy8')],
    });

    expect(g.lanes.map((l) => l.lane).sort()).toEqual([1, 2]);
    expect(g.width).toBe(3);
    expect(g.lanes.every((l) => l.divergesFrom === 'aaaaaaa1')).toBe(true);
  });

  it('hides a line without dropping it, and says the row is hidden rather than stranded', () => {
    const g = buildMainHistory({
      mainSha: 'ccccccc3',
      commits: CHAIN,
      positions: CHAIN_POSITIONS,
      refs: [pin('eeeeeee5'), hide('eeeeeee5')],
    });

    expect(g.lanes).toEqual([]);
    expect(g.width).toBe(1);
    expect(g.rows.filter((r) => r.hidden).map((r) => r.prNumber)).toEqual([5, 4]);
    // The pin is still there — hiding never deletes the ref that keeps the line alive.
    expect(g.pins).toEqual([
      { ref: 'refs/main-history/eeeeeee', name: 'eeeeeee', sha: 'eeeeeee5', hidden: true, lane: -1 },
    ]);
  });

  it('marks a landing commit nothing reaches, and does not call it hidden', () => {
    const g = buildMainHistory({ mainSha: 'ccccccc3', commits: CHAIN, positions: CHAIN_POSITIONS, refs: [] });

    const stranded = g.rows.filter((r) => r.lane === -1);
    expect(stranded.map((r) => r.prNumber)).toEqual([5, 4]);
    expect(stranded.every((r) => !r.hidden)).toBe(true);
  });

  it('ignores a pin that is already on main', () => {
    const g = buildMainHistory({
      mainSha: 'eeeeeee5',
      commits: CHAIN,
      positions: CHAIN_POSITIONS,
      refs: [pin('ccccccc3')],
    });

    expect(g.lanes).toEqual([]);
    expect(g.width).toBe(1);
    expect(g.pins.map((p) => p.lane)).toEqual([-1]);
    expect(g.rows.find((r) => r.sha === 'ccccccc3')?.pins).toEqual(['refs/main-history/ccccccc']);
  });

  it('orders by merge time, breaking a tie on the PR number so the layout is stable', () => {
    const positions = [at('bbbbbbb2', 2, 3), at('ccccccc3', 9, 3), at('aaaaaaa1', 1, 1)];
    const g = buildMainHistory({ mainSha: 'ccccccc3', commits: CHAIN, positions, refs: [] });

    expect(shas(g)).toEqual(['ccccccc3', 'bbbbbbb2', 'aaaaaaa1']);
  });
});

describe('needsPin', () => {
  const graph = { commits: CHAIN };

  it('is false moving forward, because the old position stays reachable', () => {
    expect(needsPin('ccccccc3', 'eeeeeee5', { ...graph, refs: [] })).toBe(false);
  });

  it('is true moving back, because nothing else would hold the old tip', () => {
    expect(needsPin('eeeeeee5', 'ccccccc3', { ...graph, refs: [] })).toBe(true);
  });

  it('is false moving back when a pin already reaches the old tip', () => {
    expect(needsPin('eeeeeee5', 'ccccccc3', { ...graph, refs: [pin('eeeeeee5')] })).toBe(false);
    // A pin above it holds it too — reachability, not an exact match.
    expect(needsPin('ddddddd4', 'bbbbbbb2', { ...graph, refs: [pin('eeeeeee5')] })).toBe(false);
  });

  it('still holds a hidden line, which is why hiding is not deleting', () => {
    expect(needsPin('eeeeeee5', 'ccccccc3', { ...graph, refs: [pin('eeeeeee5'), hide('eeeeeee5')] })).toBe(false);
  });

  it('ignores refs outside the namespace', () => {
    expect(needsPin('eeeeeee5', 'ccccccc3', { ...graph, refs: [{ ref: 'refs/heads/keep', sha: 'eeeeeee5' }] })).toBe(
      true,
    );
  });
});
