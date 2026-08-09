/**
 * Where `main` sits in its own history, and the lines that hang off it.
 *
 * `main` can be slid backwards and forwards across the commits merged pull requests
 * landed. Sliding it back does not destroy what was above it — those commits are kept
 * alive by a `refs/main-history/*` pin — so the page has to draw two things at once:
 * the rail `main` is on, and every line that once was the rail and now runs beside it.
 *
 * This module is the geometry, and only the geometry. It takes a commit graph, the
 * landing commits, and the pins, and answers which lane each commit is drawn in and
 * where each lane kinks off the rail. No git, no I/O, no clock — the caller reads the
 * graph out of the ref store and hands the result here.
 */

import type { PullRequestRow } from './pull-requests.js';

/** The first seven characters of a sha — how a pin ref is named. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/** Every ref this feature writes lives under here, out of the branch and tag lists. */
export const MAIN_HISTORY_PREFIX = 'refs/main-history/';

/**
 * The ref that keeps `sha` reachable once `main` has moved off it.
 *
 * Named for the content it points at rather than for when it was written, which is what
 * makes pinning idempotent: two devices pinning the same commit write the same ref with
 * the same value, so neither can clobber the other's work.
 */
export const pinRefFor = (sha: string): string => `${MAIN_HISTORY_PREFIX}${shortSha(sha)}`;

/**
 * The marker that hides a line from the page. Hiding is a ref rather than a local
 * setting so it reaches every device, and it is a *separate* ref because the pin itself
 * must never be deleted — deleting the last ref to a line is what would let GitHub
 * collect those commits.
 */
export const hiddenRefFor = (sha: string): string => `${MAIN_HISTORY_PREFIX}hidden/${shortSha(sha)}`;

/** Where commits only a local checkout had are parked before a sync resets over them. */
export const localOrphanRefFor = (stamp: string): string => `${MAIN_HISTORY_PREFIX}local-orphan/${stamp}`;

/** One ref as `git ls-remote` reports it. */
export interface MainHistoryRef {
  /** Full ref name, e.g. `refs/main-history/a1b2c3d`. */
  ref: string;
  sha: string;
}

/** A commit in the graph: itself and the shas it descends from. */
export interface MainHistoryCommit {
  sha: string;
  /** First parent first, as `git rev-list --parents` reports them. */
  parents: readonly string[];
}

/** A merged pull request's landing commit — one place `main` can be moved to. */
export interface MainPosition {
  sha: string;
  prNumber: number;
  /** ISO merge timestamp. The rail is drawn in this order, newest at the top. */
  mergedAt: string;
}

/** A pin ref and what became of it once the graph was laid out. */
export interface MainHistoryPin {
  ref: string;
  /** The `<short-sha>` segment the ref is named for. */
  name: string;
  sha: string;
  /** Whether a `hidden/` marker keeps this line off the page. */
  hidden: boolean;
  /**
   * The lane this pin's line was drawn in, or -1 when it draws nothing — because its
   * commits are already on `main`, because it is hidden, or because none of them is a
   * landing commit the page has a row for.
   */
  lane: number;
}

/** A line of commits that is not `main`, running in its own vertical lane. */
export interface MainHistoryLane {
  /** 1 and up. Lane 0 is `main` itself and never appears here. */
  lane: number;
  /** Every pin ref that keeps this line alive. */
  refs: string[];
  /** The commit on `main` this lane kinks off, or null when the fork is off-graph. */
  divergesFrom: string | null;
  /** Newest and oldest drawn row on the line — the extent of its vertical run. */
  tip: string;
  base: string;
}

/** One landing commit, placed. */
export interface MainHistoryRow {
  sha: string;
  prNumber: number;
  mergedAt: string;
  /** 0 is `main`'s rail, 1 and up are pinned lines, -1 is drawn on no line at all. */
  lane: number;
  /** The commit `origin/main` points at right now. */
  isMain: boolean;
  /** Reachable from `origin/main`, so sliding here would move backwards. */
  onMain: boolean;
  /**
   * On a line a `hidden/` marker keeps off the page. Still pinned, still safe — just not
   * drawn, which is what tells it apart from the other `lane: -1` case, a landing commit
   * nothing reaches at all.
   */
  hidden: boolean;
  /** Pin refs pointing at exactly this commit. */
  pins: string[];
}

export interface MainHistoryInput {
  /** What `origin/main` points at. */
  mainSha: string;
  /** Enough of the graph to walk from `mainSha` and every pin back to their fork. */
  commits: readonly MainHistoryCommit[];
  /** Merged pull requests' landing commits, in any order. */
  positions: readonly MainPosition[];
  /** Everything under `refs/main-history/`, pins and hidden markers alike. */
  refs: readonly MainHistoryRef[];
}

/** The whole drawn shape. */
export interface MainHistoryGraph {
  mainSha: string;
  /** The pull request whose merge put `main` where it is, or null if it isn't a landing commit. */
  mainPr: number | null;
  /** Newest merge first, matching the order the page already draws the trunk in. */
  rows: MainHistoryRow[];
  lanes: MainHistoryLane[];
  pins: MainHistoryPin[];
  /** Lanes in use including `main` — how wide a gutter the page needs. */
  width: number;
}

/**
 * The positions `main` can be moved to: every merged pull request GitHub still reports a
 * landing commit for. One it does not — an old merge whose commit is gone from the API —
 * simply is not a position, rather than a row with nowhere to point.
 */
export function mainPositions(rows: readonly PullRequestRow[]): MainPosition[] {
  const positions: MainPosition[] = [];
  for (const pr of rows) {
    if (pr.state !== 'merged' || !pr.mergeCommit) continue;
    positions.push({ sha: pr.mergeCommit, prNumber: pr.number, mergedAt: pr.mergedAt ?? pr.updatedAt });
  }
  return positions;
}

/**
 * Split the `refs/main-history/` namespace into the pins that hold lines open and the
 * markers that hide them. A `hidden/<name>` ref names the pin it hides rather than
 * carrying a line of its own.
 */
export function classifyMainHistoryRefs(refs: readonly MainHistoryRef[]): {
  pins: MainHistoryRef[];
  hidden: Set<string>;
} {
  const pins: MainHistoryRef[] = [];
  const hidden = new Set<string>();
  for (const ref of refs) {
    if (!ref.ref.startsWith(MAIN_HISTORY_PREFIX)) continue;
    const rest = ref.ref.slice(MAIN_HISTORY_PREFIX.length);
    if (rest.startsWith('hidden/')) hidden.add(rest.slice('hidden/'.length));
    else pins.push(ref);
  }
  return { pins, hidden };
}

/** Every commit reachable from `starts`, `starts` included. Unknown shas end the walk. */
function ancestorsOf(starts: readonly string[], byS: Map<string, MainHistoryCommit>): Set<string> {
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    for (const parent of byS.get(sha)?.parents ?? []) {
      if (!seen.has(parent)) stack.push(parent);
    }
  }
  return seen;
}

/** A line under construction: the commits only it has, and where it rejoins `main`. */
interface Line {
  refs: string[];
  tipSha: string;
  exclusive: Set<string>;
  /** Commits on `main` the walk ran into — the fork is the newest of them. */
  touches: Set<string>;
}

/**
 * Walk back from a pin until every path reaches `main`. What the walk collects on the
 * way is the line's own commits; what it stops at is where the line forks.
 */
function lineFrom(tipSha: string, onMain: Set<string>, byS: Map<string, MainHistoryCommit>): Line {
  const exclusive = new Set<string>();
  const touches = new Set<string>();
  const stack = [tipSha];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (onMain.has(sha)) {
      touches.add(sha);
      continue;
    }
    if (exclusive.has(sha)) continue;
    exclusive.add(sha);
    for (const parent of byS.get(sha)?.parents ?? []) stack.push(parent);
  }
  return { refs: [], tipSha, exclusive, touches };
}

/** Newest merge first; the PR number breaks a tie so the order never depends on input order. */
const byMergedDesc = (a: MainPosition, b: MainPosition): number =>
  b.mergedAt.localeCompare(a.mergedAt) || b.prNumber - a.prNumber;

/**
 * Lay the graph out: `main` as lane 0, and every pinned line in a lane of its own.
 *
 * Lanes are reused once a line has rejoined the rail, so the page's width is set by how
 * many lines overlap vertically rather than by how many pins exist.
 */
export function buildMainHistory(input: MainHistoryInput): MainHistoryGraph {
  const { mainSha } = input;
  const byS = new Map(input.commits.map((c) => [c.sha, c]));
  const onMain = ancestorsOf([mainSha], byS);
  const { pins: pinRefs, hidden } = classifyMainHistoryRefs(input.refs);

  // One row per landing commit. A sha merged twice (a re-merge of the same commit) keeps
  // its newest row, so the rail never draws the same commit in two places.
  const seenSha = new Set<string>();
  const positions = [...input.positions].sort(byMergedDesc).filter((p) => {
    if (seenSha.has(p.sha)) return false;
    seenSha.add(p.sha);
    return true;
  });
  const rowIndex = new Map(positions.map((p, i) => [p.sha, i]));

  // Group the pins by the commit they point at: several refs can name one line.
  const byTip = new Map<string, string[]>();
  for (const pin of pinRefs) {
    const name = pin.ref.slice(MAIN_HISTORY_PREFIX.length);
    if (hidden.has(name)) continue;
    byTip.set(pin.sha, [...(byTip.get(pin.sha) ?? []), pin.ref]);
  }

  // Walk each distinct tip, then fold a line that is wholly contained in another into
  // it — a pin on a commit halfway up a line is the same line, not a second one.
  const walked = [...byTip.entries()]
    .filter(([sha]) => !onMain.has(sha))
    .map(([sha, refs]) => ({ ...lineFrom(sha, onMain, byS), refs }))
    .sort((a, b) => b.exclusive.size - a.exclusive.size);

  const lines: Line[] = [];
  for (const line of walked) {
    const host = lines.find((l) => l.exclusive.has(line.tipSha));
    if (host) host.refs.push(...line.refs);
    else lines.push(line);
  }

  /** The newest commit on `main` a line touches — the one place it visibly kinks off. */
  const forkOf = (line: Line): string | null => {
    let best: string | null = null;
    let bestRow = Number.POSITIVE_INFINITY;
    for (const sha of line.touches) {
      const row = rowIndex.get(sha) ?? Number.POSITIVE_INFINITY;
      if (best === null || row < bestRow) {
        best = sha;
        bestRow = row;
      }
    }
    return best;
  };

  // A line is only drawable where it has rows to draw: its commits that are landing
  // commits. One with none is real and still pinned, it just has nothing on the page.
  const drawable = lines
    .map((line) => {
      const rows = [...line.exclusive].map((sha) => rowIndex.get(sha)).filter((i): i is number => i !== undefined);
      const fork = forkOf(line);
      const forkRow = fork === null ? undefined : rowIndex.get(fork);
      return {
        line,
        fork,
        tipRow: Math.min(...rows),
        baseRow: Math.max(...rows),
        // The lane runs down to where it rejoins the rail, so it occupies that row too.
        endRow: Math.max(...rows, forkRow ?? Math.max(...rows)),
        rows,
      };
    })
    .filter((d) => d.rows.length > 0)
    .sort((a, b) => a.tipRow - b.tipRow || a.endRow - b.endRow);

  // First fit from lane 1 up: a lane is free again below the row its last line rejoined.
  const takenUntil: number[] = [];
  const laneOfSha = new Map<string, number>();
  const lanes: MainHistoryLane[] = [];
  for (const d of drawable) {
    let lane = 1;
    while (takenUntil[lane] !== undefined && takenUntil[lane]! >= d.tipRow) lane += 1;
    takenUntil[lane] = d.endRow;
    for (const sha of d.line.exclusive) laneOfSha.set(sha, lane);
    lanes.push({
      lane,
      refs: [...d.line.refs].sort(),
      divergesFrom: d.fork,
      tip: positions[d.tipRow]!.sha,
      base: positions[d.baseRow]!.sha,
    });
  }

  // Hidden lines are walked too, so a row on one reads as hidden rather than as a commit
  // nothing reaches. They are pinned exactly as the drawn ones are.
  const hiddenShas = new Set<string>();
  for (const pin of pinRefs) {
    if (!hidden.has(pin.ref.slice(MAIN_HISTORY_PREFIX.length)) || onMain.has(pin.sha)) continue;
    for (const sha of lineFrom(pin.sha, onMain, byS).exclusive) hiddenShas.add(sha);
  }

  const refsAt = new Map<string, string[]>();
  for (const pin of pinRefs) refsAt.set(pin.sha, [...(refsAt.get(pin.sha) ?? []), pin.ref]);

  const rows: MainHistoryRow[] = positions.map((p) => ({
    sha: p.sha,
    prNumber: p.prNumber,
    mergedAt: p.mergedAt,
    lane: onMain.has(p.sha) ? 0 : (laneOfSha.get(p.sha) ?? -1),
    isMain: p.sha === mainSha,
    onMain: onMain.has(p.sha),
    hidden: !onMain.has(p.sha) && !laneOfSha.has(p.sha) && hiddenShas.has(p.sha),
    pins: (refsAt.get(p.sha) ?? []).sort(),
  }));

  const pins: MainHistoryPin[] = pinRefs
    .map((pin) => {
      const name = pin.ref.slice(MAIN_HISTORY_PREFIX.length);
      return {
        ref: pin.ref,
        name,
        sha: pin.sha,
        hidden: hidden.has(name),
        lane: laneOfSha.get(pin.sha) ?? -1,
      };
    })
    .sort((a, b) => a.ref.localeCompare(b.ref));

  return {
    mainSha,
    mainPr: positions.find((p) => p.sha === mainSha)?.prNumber ?? null,
    rows,
    lanes: lanes.sort((a, b) => a.lane - b.lane),
    pins,
    width: 1 + lanes.reduce((w, l) => Math.max(w, l.lane), 0),
  };
}

/**
 * The tip of the pinned line `sha` sits on — the commit a pin is named for, and so the
 * name a `hidden/` marker has to carry to hide that line.
 *
 * A landing commit partway up a line is not what the pin is named for, so a marker named
 * after it would match no pin. Null when `sha` is on `main` or no pin reaches it.
 */
export function lineTipFor(sha: string, input: Omit<MainHistoryInput, 'positions'>): string | null {
  const byS = new Map(input.commits.map((c) => [c.sha, c]));
  const onMain = ancestorsOf([input.mainSha], byS);
  if (onMain.has(sha)) return null;
  const { pins } = classifyMainHistoryRefs(input.refs);
  // Longest line first, matching how `buildMainHistory` folds a contained line into its
  // host; the sha breaks a tie so the answer never depends on ref order.
  const reaching = pins
    .filter((p) => !onMain.has(p.sha))
    .map((p) => ({ sha: p.sha, line: lineFrom(p.sha, onMain, byS) }))
    .filter((c) => c.line.exclusive.has(sha))
    .sort((a, b) => b.line.exclusive.size - a.line.exclusive.size || a.sha.localeCompare(b.sha));
  return reaching[0]?.sha ?? null;
}

/**
 * Whether sliding `main` from `from` to `to` would strand `from`.
 *
 * This is the whole safety rule. GitHub's own merges only ever append to `main`, so a
 * slide is the only thing that can leave a commit unreferenced — and a commit already
 * reachable from a pin needs no second one.
 *
 * `input.refs` must be the refs `origin` holds. A ref only a local store has would answer
 * for a commit `origin` itself reaches from nothing.
 */
export function needsPin(from: string, to: string, input: Omit<MainHistoryInput, 'mainSha' | 'positions'>): boolean {
  const byS = new Map(input.commits.map((c) => [c.sha, c]));
  if (ancestorsOf([to], byS).has(from)) return false;
  const { pins } = classifyMainHistoryRefs(input.refs);
  return !ancestorsOf(
    pins.map((p) => p.sha),
    byS,
  ).has(from);
}
