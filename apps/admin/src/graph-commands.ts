import type { SessionNode } from '@claude-proxy/core';
import { findNestedInvocations, parseCommandEnvelope } from '@claude-proxy/core';
import type { SessionGraphEntry } from './api';

/**
 * The command grain's projection: one box per command **run** rather than one per turn.
 *
 * `findNestedInvocations` already cuts a transcript into spans — a nested command owns every
 * node from its `Skill(…)` call until the next one opens — so a run is a span, and this folds
 * each span into a single synthetic {@link SessionNode} the layout engine places like any
 * other step. Nothing else about the engine changes: consecutive spans are consecutive nodes,
 * so the chain it already draws between neighbouring boxes *is* "the command this run started
 * next".
 *
 * Two consequences of that span rule are worth stating, because they are the transcript's
 * limits rather than this view's choices:
 *
 * - **Spans never nest.** A span ends where the next one opens, so no node is charged to two
 *   runs and a command invoked inside another cannot be drawn *inside* it. The view is a
 *   sequence of runs, not a containment tree.
 * - **The last span has no end.** Nothing records where a nested command returned, so the last
 *   run in a transcript absorbs whatever its host did after it.
 */

/**
 * What a command mostly does, and — through {@link FAMILY_TOKEN} — the hue it draws in.
 *
 * The families are ordered by how much a run of one changes: `build` writes code and ships it,
 * `shape` reworks what is already there, `review` judges without changing, `read` only looks
 * things up. `other` is any command this table does not name, which draws grey.
 */
export type CommandFamily = 'build' | 'shape' | 'review' | 'read' | 'other';

/** Which family each installed command belongs to. Anything absent is `other`. */
const FAMILY_OF: Record<string, CommandFamily> = {
  task: 'build',
  work: 'build',
  god: 'build',
  manage: 'build',
  fb: 'build',
  improve: 'build',
  revive: 'build',
  unblock: 'build',
  dev: 'build',
  prototype: 'build',
  'task-bootstrap': 'build',

  clean: 'shape',
  trim: 'shape',
  truncate: 'shape',
  docs: 'shape',
  changelog: 'shape',
  'req-table': 'shape',
  'create-spec': 'shape',
  sync: 'shape',
  'merge-deps': 'shape',
  mc: 'shape',
  pr: 'shape',
  diagram: 'shape',

  review: 'review',
  judge: 'review',
  grilling: 'review',
  retro: 'review',
  ideate: 'review',

  lookup: 'read',
  research: 'read',
  teach: 'read',
  learn: 'read',
  'find-skills': 'read',
  'read-tweet': 'read',
  wayfinder: 'read',
  'web-perf': 'read',
  cp: 'read',
  stay: 'read',
};

export const familyOf = (command: string | null): CommandFamily =>
  command === null ? 'other' : (FAMILY_OF[command.toLowerCase()] ?? 'other');

/**
 * Family → the pair of CSS custom properties it draws in: a dark fill and the border that
 * frames it.
 *
 * The colour rule behind the tokens is stated once, in `tokens.css`, and is not a per-command
 * hue: hue names the family, chroma says how much a command changes, and an unnamed command
 * has zero chroma because grey claims nothing about its power.
 */
export const FAMILY_TOKEN: Record<CommandFamily, { fill: string; edge: string }> = {
  build: { fill: 'var(--cmd-build-fill)', edge: 'var(--cmd-build-edge)' },
  shape: { fill: 'var(--cmd-shape-fill)', edge: 'var(--cmd-shape-edge)' },
  review: { fill: 'var(--cmd-review-fill)', edge: 'var(--cmd-review-edge)' },
  read: { fill: 'var(--cmd-read-fill)', edge: 'var(--cmd-read-edge)' },
  other: { fill: 'var(--cmd-other-fill)', edge: 'var(--cmd-other-edge)' },
};

/** How each family reads on a box and in the legend. */
export const FAMILY_LABEL: Record<CommandFamily, string> = {
  build: 'builds',
  shape: 'reshapes',
  review: 'reviews',
  read: 'reads',
  other: 'unknown',
};

/** One command run inside a transcript, and what its span of that transcript holds. */
export interface CommandRunSpan {
  /**
   * The command invoked — for the host span, the command the transcript *is*, read off its
   * own opening envelope. Null only when nothing names it: an ordinary session, or a
   * command run whose opening prompt was never captured.
   */
  command: string | null;
  /** True for the host's own steps ahead of the first nested run, named or not. */
  host: boolean;
  family: CommandFamily;
  /** Index of the node that opened the run, and one past its last. */
  from: number;
  to: number;
  steps: number;
  tools: number;
  errors: number;
  /** True when the run was cut off anywhere inside its span. */
  interrupted: boolean;
  /** The interruption the run *opened* on, so a run resumed after a cut still opens a trail. */
  interruption: SessionNode['interruption'];
}

/**
 * One transcript's command runs, in order. The first span is the host's own steps — every node
 * before the first nested call.
 *
 * The host span **is** named, from the envelope the transcript's own opening prompt carries:
 * `<command-message>god</command-message><command-name>/god</command-name>` says which command
 * the session is, so drawing that span grey and labelling it "unknown" threw away a fact the
 * transcript states outright — and the host run is usually the largest box on the canvas.
 * `parseCommandEnvelope` reads either tag, so a prompt that kept only the first still names it.
 * A session that opened on no command has nothing to read and stays null, which is the honest
 * answer rather than a guess.
 */
export function commandRuns(entry: SessionGraphEntry, isCommand: (name: string) => boolean): CommandRunSpan[] {
  const nodes = entry.nodes;
  if (nodes.length === 0) return [];

  const end = nodes[nodes.length - 1]!.index + 1;
  const nested = findNestedInvocations(nodes, isCommand);
  const bounds: { command: string | null; host: boolean; from: number; to: number }[] = [];
  const head = nested[0]?.from ?? end;
  if (head > nodes[0]!.index) {
    const opening = parseCommandEnvelope(entry.subtitle ?? entry.firstTask);
    bounds.push({ command: opening?.command ?? null, host: true, from: nodes[0]!.index, to: head });
  }
  for (const run of nested) bounds.push({ command: run.command, host: false, from: run.from, to: run.to });

  return bounds.map(({ command, host, from, to }) => {
    const inside = nodes.filter((n) => n.index >= from && n.index < to);
    return {
      command,
      host,
      family: familyOf(command),
      from,
      to,
      steps: inside.length,
      tools: inside.filter((n) => n.type === 'tool').length,
      errors: inside.filter((n) => n.type === 'error').length,
      interrupted: inside.some((n) => n.interrupted),
      interruption: inside[0]?.interruption ?? null,
    };
  });
}

/** How a run's box reads: the command with its leading slash, or the host run itself. */
export const runLabel = (span: CommandRunSpan): string => (span.command === null ? 'this run' : `/${span.command}`);

/**
 * A run as one step the engine can place. The node is keyed on the index of the node that
 * opened the run, so a box's key stays the transcript position it came from and clicking one
 * still resolves to a real step.
 *
 * `tool` is deliberately null: a synthetic node carrying its host's `Skill(…)` signature would
 * read as that tool call everywhere the engine labels a step, which is the very confusion this
 * view exists to remove.
 */
const runNode = (span: CommandRunSpan): SessionNode => ({
  index: span.from,
  type: 'tool',
  text: runLabel(span),
  tool: null,
  task: null,
  interruption: span.interruption,
  interrupted: span.interrupted,
  message: null,
  turn: null,
  argsHash: null,
});

/** The grain itself: one transcript's steps folded into one node per command run. */
export const projectCommandRuns = (entry: SessionGraphEntry, isCommand: (name: string) => boolean): SessionNode[] =>
  commandRuns(entry, isCommand).map(runNode);

/** Every transcript's runs, keyed thread → opening index, so a placed box can find its span. */
export function indexCommandRuns(
  entries: readonly SessionGraphEntry[],
  isCommand: (name: string) => boolean,
): Map<string, Map<number, CommandRunSpan>> {
  const index = new Map<string, Map<number, CommandRunSpan>>();
  for (const entry of entries) {
    index.set(entry.threadId, new Map(commandRuns(entry, isCommand).map((span) => [span.from, span])));
  }
  return index;
}
