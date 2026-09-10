/**
 * The Alive View derivation: one emotion word and one trigger line describing a
 * watched agent family right now (docs/adrs/0018–0026).
 *
 * Input is the shape `/api/sessions/graph/nodes` returns per thread — its node
 * stream plus the transcript-level `modified` — because individual steps carry no
 * timestamps of their own; the transcript's last-append time is the only clock
 * there is (ADR 0019). During a fan-out the emotion describes whichever family
 * transcript appended last, so a quiet parent beside running branches still reads
 * alive (ADR 0022).
 *
 * Pure and deterministic: `now` is injected, nothing is read from the environment,
 * the filesystem, or the network.
 */

import { mergeSessionNodes, type SessionNode, truncateWords } from './sessions.js';

/**
 * How long a Thinking family may sit without an append before it reads Stressed:
 * thirty minutes past the newest transcript's last append.
 */
export const STRESS_THRESHOLD_MS = 30 * 60_000;

/** How much of a node's text a trigger line carries before cutting to a word boundary. */
const TEXT_CHARS = 80;

/** How much of a tool call's first argument a trigger line carries. Matches the proxy's own gist cap. */
const ARG_CHARS = 60;

/**
 * What the watched family is doing.
 *
 * - `Smiling` — finished (`done`), or cut off mid-flight (`interrupted`; ADR 0023),
 *   or nothing to judge at all.
 * - `Thinking` — mid-run: a task, decision or tool call was the last step.
 * - `Disgruntled` — the last step was an `error`.
 * - `Stressed` — mid-run but nothing has appended for {@link STRESS_THRESHOLD_MS}.
 */
export type AliveEmotion = 'Smiling' | 'Thinking' | 'Disgruntled' | 'Stressed';

/** One family transcript's facts, as the graph-nodes response carries them per thread. */
export interface FamilyTranscript {
  threadId: string;
  /**
   * The transcript's last-append time, ISO 8601 — the same field and clock that
   * drive the stress rule and every relative timestamp (ADR 0019).
   */
  modified: string;
  /**
   * The thread's node stream. Pass the caller-merged stream here, or leave it off
   * and give the two raw arrays — the transcript's gists and the captured request's
   * full-text steps — to be merged here instead.
   */
  nodes?: readonly SessionNode[];
  /** The transcript's own node stream, when {@link FamilyTranscript.nodes} is not given. */
  transcript?: readonly SessionNode[];
  /** The captured request's node stream, when {@link FamilyTranscript.nodes} is not given. */
  derived?: readonly SessionNode[];
}

/** One Alive View reading: the emotion word and its trigger line. */
export interface AliveView {
  emotion: AliveEmotion;
  /**
   * The line under the emotion word. Empty when there is nothing to describe — an
   * empty family, or a newest transcript carrying no nodes.
   */
  trigger: string;
}

/**
 * A transcript's node stream: the caller's merged stream when it gave one,
 * otherwise `mergeSessionNodes` over the two raw arrays.
 */
function nodesOf(t: FamilyTranscript): readonly SessionNode[] {
  if (t.nodes) return t.nodes;
  return mergeSessionNodes([...(t.transcript ?? [])], [...(t.derived ?? [])]);
}

/**
 * Split a call signature into `Name(first-arg)`: the identifying head of
 * `Bash(command=npm test, timeout=…)` without the tail. Unparsable signatures
 * come back whole.
 */
function toolHead(sig: string): string {
  const open = sig.indexOf('(');
  const name = open > 0 ? sig.slice(0, open) : sig;
  const args = open > 0 ? sig.slice(open + 1).replace(/\)$/, '') : '';
  const first = args.split(', ')[0] ?? '';
  const arg = first.length > ARG_CHARS ? `${first.slice(0, ARG_CHARS)}…` : first;
  return args ? `${name}(${arg})` : name;
}

/** Elapsed minutes, floored — never negative, however skewed the writer's clock. */
function minutesOf(ageMs: number): number {
  return Math.max(0, Math.floor(ageMs / 60_000));
}

/**
 * The trigger line for one derived state (ADRs 0019, 0024, 0026): Stressed renders
 * only how long the family has sat idle; everything else renders
 * "`<lead>` · step `<index>` · `<age>`m ago", where the lead names what happened —
 * the emotion for a decision or outcome, the failing tool for an error (the node's
 * own distilled text when it blames no tool), the call for a tool step, and
 * `stopped` for a run cut off mid-flight.
 */
export function aliveTriggerLine(emotion: AliveEmotion, last: SessionNode, ageMs: number): string {
  if (emotion === 'Stressed') return `idle for ${minutesOf(ageMs)}m`;

  const tail = `step ${last.index} · ${minutesOf(ageMs)}m ago`;
  let lead: string;
  if (last.interrupted) lead = `stopped · ${truncateWords(last.text, TEXT_CHARS)}`;
  else if (last.type === 'tool') lead = `tool · ${toolHead(last.tool ?? last.text)}`;
  else if (last.type === 'error') {
    lead = last.tool ? `error · ${last.tool} failed` : `error · ${truncateWords(last.text, TEXT_CHARS)}`;
  } else lead = `${emotion} · ${truncateWords(last.text, TEXT_CHARS)}`;

  return `${lead} · ${tail}`;
}

/**
 * Derive what a watched family is doing at `now` (epoch ms).
 *
 * The newest-`modified` transcript supplies both the last node and the staleness
 * clock (ADR 0022); equal stamps keep the family's earlier entry. Its LAST node maps
 * straight onto an emotion — `done` Smiling, `error` Disgruntled, everything
 * mid-run Thinking — except that a run cut off at its last step reads Smiling
 * whatever the step was (ADR 0023). Only Thinking ages into Stressed, and only
 * once the family's newest append is strictly older than
 * {@link STRESS_THRESHOLD_MS}: all three ways a run ends are non-aging.
 */
export function deriveAliveView(family: readonly FamilyTranscript[], now: number): AliveView {
  let newest: FamilyTranscript | null = null;
  let newestAt = Number.NaN;
  for (const t of family) {
    const at = Date.parse(t.modified);
    if (Number.isNaN(at)) continue;
    if (Number.isNaN(newestAt) || at > newestAt) {
      newest = t;
      newestAt = at;
    }
  }
  if (!newest) return { emotion: 'Smiling', trigger: '' };

  const nodes = nodesOf(newest);
  const last = nodes[nodes.length - 1];
  if (!last) return { emotion: 'Smiling', trigger: '' };

  const ageMs = Math.max(0, now - newestAt);

  let emotion: AliveEmotion;
  if (last.interrupted || last.type === 'done') emotion = 'Smiling';
  else if (last.type === 'error') emotion = 'Disgruntled';
  else emotion = 'Thinking';
  if (emotion === 'Thinking' && ageMs > STRESS_THRESHOLD_MS) emotion = 'Stressed';

  return { emotion, trigger: aliveTriggerLine(emotion, last, ageMs) };
}
