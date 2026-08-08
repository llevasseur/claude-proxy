/**
 * Who made a write, and how much of the evidence they actually opened.
 *
 * Both adjudicating stores record a decision an *agent* made and neither records
 * anything about the agent. `suggestions judge` files a verdict on a window of ten
 * transcripts; `ideas mark -s accepted` files the sign-off that is the only thing
 * making an idea actionable. In both, the write is trusted exactly as much whether
 * the agent read the evidence or not — `--amnesty` exists precisely because a
 * no-notes verdict was otherwise indistinguishable from a careful one.
 *
 * This module is the envelope both write paths attach, and it is deliberately
 * **additive**: every field is optional, an entry written before it reads back
 * unchanged, and nothing here decides anything. It records two things.
 *
 * - **Who.** A judging run is itself a Claude session the proxy transcribes, so
 *   the writer already has a thread id and passing it through is the whole of the
 *   instrumentation. It is a claim the writer makes about itself, which is why it
 *   is not the interesting half.
 * - **How much they read.** This is *not* self-reported. The judging thread's own
 *   `logs/sessions/<threadId>.md` transcript records every tool call it made, so
 *   how many of the window's transcripts it opened is arithmetic over data the
 *   proxy already wrote — see {@link transcriptsOpened}. An agent that claims a
 *   thread id it did not run is claiming a transcript that will not show the reads.
 *
 * Pure: no I/O and no clock. The reading of a judging thread's nodes lives in the
 * server package, which hands the parsed nodes here.
 */

import type { SessionNode } from './sessions.js';

/** A thread id is the 16-hex-char stem the proxy names a transcript with. */
const THREAD_ID_RE = /^[0-9a-f]{16}$/;

/** True when `value` is a well-formed thread id. */
export function isThreadId(value: unknown): value is string {
  return typeof value === 'string' && THREAD_ID_RE.test(value);
}

/**
 * Who wrote a verdict or a sign-off, and how much of the window they opened.
 *
 * Shared verbatim by the suggestion store's per-bucket `judged` record and the
 * ideas ledger's entries, so "which agent decided this" is one shape across both
 * evidence standards rather than two near-misses.
 *
 * `opened`/`window` are absent on a write with no window to measure — an idea mark
 * has no transcripts behind it — and on one whose judging thread has no transcript
 * on disk. Absent is *unknown*, never zero: {@link isThinPass} is false for both.
 */
export interface WriteProvenance {
  /** Thread id of the Claude session that made the write. */
  thread: string;
  /** Transcripts in the window the write covers — the denominator. */
  window?: number;
  /** How many of those the thread opened, counted off its own transcript. */
  opened?: number;
}

/**
 * Read an untrusted value as an envelope, or null when it carries no usable
 * thread id. Tolerant by construction: an entry stored before provenance existed
 * has no envelope at all, and reads back as null rather than as a defect.
 */
export function parseWriteProvenance(raw: unknown): WriteProvenance | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { thread, window, opened } = raw as Record<string, unknown>;
  if (!isThreadId(thread)) return null;
  const out: WriteProvenance = { thread };
  if (Number.isInteger(window) && (window as number) >= 0) out.window = window as number;
  if (Number.isInteger(opened) && (opened as number) >= 0) out.opened = opened as number;
  // A count with no denominator measures nothing, and vice versa — keep the pair or neither.
  if (out.window === undefined || out.opened === undefined) {
    delete out.window;
    delete out.opened;
  }
  return out;
}

/**
 * Share of the window's transcripts the writer opened, 0–1, or null when the
 * envelope carries no measurable pair.
 */
export function provenanceCoverage(by: WriteProvenance | undefined | null): number | null {
  if (!by || by.window === undefined || by.opened === undefined || by.window === 0) return null;
  return by.opened / by.window;
}

/**
 * Below this share of a window's transcripts, a verdict is marked as a thin pass.
 *
 * 0.3 over the fixed window of ten means a judge that opened two transcripts or
 * fewer is flagged, and three is enough to clear it. The number is a judgement
 * call with no data behind it yet, and it is set deliberately low: the marker's
 * job is to catch the pass that read *almost nothing*, not to prescribe how much
 * reading a careful verdict takes. A judge can reach a sound verdict off three
 * transcripts when the rule it is checking only fired in three.
 */
export const THIN_PASS_RATIO = 0.3;

/**
 * True when a write's own record says it opened less than {@link THIN_PASS_RATIO}
 * of the window it judged.
 *
 * **Advisory, and false whenever the evidence is missing.** No envelope, no
 * measurable pair, or an empty window all read as false — an unattributed verdict
 * is a different thing from a careless one, and inferring carelessness from a
 * legacy row would indict every verdict written before this existed.
 */
export function isThinPass(by: WriteProvenance | undefined | null): boolean {
  const coverage = provenanceCoverage(by);
  return coverage !== null && coverage < THIN_PASS_RATIO;
}

/**
 * Which of `threadIds` the judging thread actually opened, counted off the nodes
 * of its own transcript.
 *
 * This is the half of the envelope that is *derived rather than claimed*. A tool
 * call is recorded in the judging thread's transcript as its call signature, so a
 * transcript in the window counts as opened when some tool call of the judging
 * thread names it. `texts` is that thread's `.nodes.jsonl` sidecar, which carries
 * the untruncated argument text behind a gisted line — without it a long path
 * truncated at capture can hide the id it ends with, so an absent sidecar
 * undercounts rather than miscounts.
 *
 * **Any tool naming the transcript counts, not only `Read`.** The question being
 * answered is whether the judge looked at the window's evidence, and a `Bash` that
 * greps a transcript opened it just as a `Read` did. The judging thread's own
 * transcript never counts, so a judge cannot credit itself by being in its own
 * window.
 */
export function transcriptsOpened(
  nodes: readonly SessionNode[],
  threadIds: readonly string[],
  texts: Record<number, string> = {},
  judgingThreadId?: string,
): string[] {
  const wanted = threadIds.filter((id) => id !== judgingThreadId);
  if (wanted.length === 0) return [];
  const haystack = nodes
    .filter((node) => node.type === 'tool')
    .map((node) => texts[node.index] ?? node.text)
    .join('\n');
  return wanted.filter((id) => haystack.includes(id));
}
