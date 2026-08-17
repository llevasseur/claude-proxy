/**
 * Slash-command runs: what a `/task`, `/god` or `/review` invocation costs, which of
 * its declared steps the tokens went to, and where it stopped.
 *
 * A **run** is any session whose opening prompt carries the CLI's `<command-name>`
 * envelope, plus every command a run invokes inside itself, which is a run of its own
 * *and* part of its parent. Capture is passive: every real invocation is a run, with no
 * tagging. A nested one is found on its `Skill(…)` call — see {@link findNestedInvocations}.
 *
 * The **step catalogue** is the `## Step N` headings of the installed command file
 * (`~/.claude/commands/<name>.md`). It is snapshotted into each run record along with
 * the file's content hash, so a run stays interpretable after `/sync` rewrites the
 * file and a hash change marks a before/after on the timeline.
 *
 * **Attribution is a heuristic and says so.** The agent narrates its steps only
 * sometimes ("Step 2 — scope: …", "Now step 2, the PR."), so anchors are sparse: a
 * marker fixes the current step and the steps that follow inherit it until the next
 * anchor, with everything before the first anchor left in an explicit
 * {@link UNATTRIBUTED} bucket the UI shows rather than hides. Every attribution
 * carries the {@link StepConfidence} that produced it. The logic lives here, apart
 * from storage and rendering, so an explicit `STEP n/N` marker — already the
 * highest-confidence rule below — can take over without touching anything else.
 *
 * Pure: no I/O, no clock, no Node builtins. The server reads the files and captured
 * requests and hands the pieces here.
 */

import { jsonNumber, jsonObject, jsonText, jsonValueOf } from './json.js';
import { estimateCost } from './pricing.js';
import type { InterruptionKind, SessionNode } from './sessions.js';
import type { AuditTokens } from './types.js';

/**
 * Run-record schema version. Bump on any change to {@link CommandRun}'s shape.
 * Readers keep older records and render what they carry — see {@link isCommandRun},
 * which validates only the identity fields every version has had.
 */
export const COMMAND_RUN_SCHEMA = 4;

/** The bucket holding turns and steps no anchor could place. Never a real step id. */
export const UNATTRIBUTED = null;

// --- The command file ------------------------------------------------------

/**
 * A distinctive thing a step's body tells the agent to invoke. These are what make
 * attribution work in practice: runs seldom announce "Step 2", but a run that calls
 * `my-command-tools worktree begin` is unmistakably in the step that prescribes it.
 */
export interface StepArtifact {
  /** `shell` — a command line; `skill` — a `/name` sub-command; `tool` — a named tool. */
  kind: 'shell' | 'skill' | 'tool';
  /** Normalized form: shell lowercased and cut at its first flag, skill without its slash. */
  value: string;
}

/** One `## Step N — Title` heading from an installed command file. */
export interface CommandStep {
  /** The ordinal exactly as written — `"0"`, `"1"`, `"1.5"`. Also the record key. */
  id: string;
  /** `id` as a number, so `1.5` sorts between `1` and `2`. */
  order: number;
  title: string;
  /**
   * What the step's body prescribes. Optional so a run recorded before artifacts
   * existed — or by a future writer that drops them — still reads back.
   */
  artifacts?: StepArtifact[];
}

/**
 * `## Step 1 — Set up the workspace`, and the `1.5` form the commands actually use.
 * The title runs to end of line; an em dash, en dash, hyphen or colon separates it.
 */
const STEP_HEADING_RE = /^##\s+Step\s+(\d+(?:\.\d+)?)\s*(?:[—–\-:]\s*)?(.*)$/;
/** Any level-2 heading — what ends the preceding step's body. */
const ANY_H2_RE = /^##\s+.*$/gm;

/** Code spans, which is where a command file writes the things it wants invoked. */
const BACKTICK_RE = /`([^`\n]+)`/g;
/** A placeholder or shell punctuation: everything from here on is not literal. */
const NOT_LITERAL_RE = /[<>…|;&*"']/;
/** `EnterWorktree`, `NotebookEdit` — a tool name, as opposed to a shouted word like `HEAD`. */
const TOOL_SPAN_RE = /^[A-Z][a-z]+(?:[A-Z][a-z]+)*$/;

/**
 * Tools every step can use, so naming one marks nothing. Command files mention these
 * as advice on *how* to work rather than as the act of a particular step; taken as
 * anchors they swamp everything else.
 */
const AMBIENT_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'Grep',
  'Glob',
  'Skill',
  'Agent',
  'Task',
  'Monitor',
  'WebFetch',
  'WebSearch',
  'Artifact',
]);

/**
 * Turn one code span into an artifact, or null when it names nothing invocable.
 *
 * A shell line is cut at its first flag or placeholder, the prefix being the only part
 * invoked literally. What survives must still be two words, which keeps the bare nouns
 * these files are full of out of the vocabulary.
 */
function toArtifact(raw: string): StepArtifact | null {
  const span = raw.trim().replace(/[.,:;]+$/, '');
  if (!span) return null;

  if (/^\/[a-z][a-z0-9:_-]*$/.test(span)) return { kind: 'skill', value: span.slice(1).toLowerCase() };
  if (TOOL_SPAN_RE.test(span)) return AMBIENT_TOOLS.has(span) ? null : { kind: 'tool', value: span };

  const tokens: string[] = [];
  for (const token of span.split(/\s+/)) {
    if (token.startsWith('-') || NOT_LITERAL_RE.test(token)) break;
    tokens.push(token);
  }
  if (tokens.length === 0) return null;

  // A lone token is only distinctive when it is a path, not a word.
  if (tokens.length === 1) {
    const only = tokens[0]!;
    if (!only.includes('/') || only.length < 6) return null;
    return { kind: 'shell', value: only.toLowerCase() };
  }
  if (!/^[a-z][a-z0-9._/-]*$/.test(tokens[0]!)) return null;
  return { kind: 'shell', value: tokens.join(' ').toLowerCase() };
}

/** The artifacts one step's body prescribes, deduped. */
function parseStepArtifacts(body: string): StepArtifact[] {
  const seen = new Map<string, StepArtifact>();
  for (const m of body.matchAll(BACKTICK_RE)) {
    const artifact = toArtifact(m[1]!);
    if (artifact) seen.set(`${artifact.kind}:${artifact.value}`, artifact);
  }
  return [...seen.values()];
}

/**
 * The declared steps of a command file, in document order, each with the artifacts its
 * body prescribes. A command with no `## Step N` headings — `/clean` has none, `/pr`
 * has a single `## Steps` list — yields an empty catalogue, which is a valid run with
 * everything unattributed.
 */
export function parseCommandSteps(content: string): CommandStep[] {
  // Every h2, so a step's body can be cut at whatever heading follows it.
  const headings = [...content.matchAll(ANY_H2_RE)];

  const steps: CommandStep[] = [];
  const byId = new Map<string, CommandStep>();
  headings.forEach((heading, i) => {
    const parsed = STEP_HEADING_RE.exec(heading[0]);
    if (!parsed) return;
    const body = content.slice(heading.index + heading[0].length, headings[i + 1]?.index ?? content.length);
    const artifacts = parseStepArtifacts(body);

    // A repeated heading continues the same step rather than declaring a new one.
    const existing = byId.get(parsed[1]!);
    if (existing) {
      existing.artifacts = [...(existing.artifacts ?? []), ...artifacts];
      return;
    }
    const step: CommandStep = { id: parsed[1]!, order: Number(parsed[1]!), title: (parsed[2] ?? '').trim(), artifacts };
    byId.set(step.id, step);
    steps.push(step);
  });

  // Drop the duplicates the merge above may have introduced within one step.
  for (const step of steps) {
    const seen = new Map<string, StepArtifact>();
    for (const a of step.artifacts ?? []) seen.set(`${a.kind}:${a.value}`, a);
    step.artifacts = [...seen.values()];
  }
  return steps;
}

/**
 * A stable content fingerprint, 16 hex chars. FNV-1a over UTF-16 code units in two
 * lanes — not a cryptographic hash, and it doesn't need to be: it only has to change
 * when the command file changes, and Node's `crypto` isn't available to this package's
 * browser consumers.
 */
export function contentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ (c + i), 0x85ebca6b);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(a) + hex(b);
}

// --- The prompt envelope ---------------------------------------------------

/**
 * Either tag the CLI writes a command's name into, anywhere in a prompt — a prompt that
 * kept only `<command-message>` still names its run. {@link envelopes} folds the pair back
 * into one envelope.
 *
 * The closing tag is a backreference, so mismatched tags are damage, not an envelope.
 */
const COMMAND_TAG_RE = /<command-(name|message)>\s*\/?([A-Za-z0-9:_-]+)\s*<\/command-\1>/gi;
const ARGS_OPEN_RE = /<command-args>/gi;
const ARGS_CLOSE_RE = /<\/command-args>/gi;
/**
 * The CLI's caveat sitting immediately ahead of an envelope, marking that envelope a
 * **locally-run** command — `/clear`, `/compact`.
 *
 * Adjacency is the whole test: the caveat's text also survives into compaction summaries,
 * thousands of characters from an unrelated envelope it says nothing about. Nothing may sit
 * between the two — the CLI emits `<command-name>` first behind the caveat.
 */
const LOCAL_ENVELOPE_RE = /<\/local-command-caveat>\s*$/i;
/** The caveat the CLI prepends to a locally-run command, and the leftover envelope tags. */
const COMMAND_NOISE_RE = /<local-command-caveat>[\s\S]*?<\/local-command-caveat>|<\/?command-[a-z-]+>/gi;
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;

/** A leading `--flag` / `-f` token. Flags run at the front of the args, as every command parses them. */
const FLAG_RE = /^--?([A-Za-z][A-Za-z0-9-]*)$/;

/** What a run's opening prompt declares about itself. */
export interface CommandEnvelope {
  /** The command name without its slash — `task`, `review`, `my-command:merge-deps`. */
  command: string;
  /** Everything inside `<command-args>`, verbatim. */
  args: string;
  /**
   * Flag names parsed off the front of the args, without dashes, in the order given.
   *
   * Only the *leading* run is read, and only the flag tokens in it: nothing here knows
   * which flags take a value, so `--base main` records `base` and stops at `main`. That
   * is enough for the facet — which flags a run used — and never mistakes a word in the
   * criteria for a flag.
   */
  flags: string[];
  /** The criteria: the args with the envelope and any injected reminders stripped. */
  prompt: string;
}

/** One envelope's span in a prompt: the command it names, and where its tags start and end. */
interface EnvelopeSpan {
  command: string;
  /** Index of the first tag of the run — what the local-command caveat has to sit against. */
  start: number;
  /** One past the last tag of the run — where this envelope's `<command-args>` is looked for. */
  end: number;
}

/**
 * Every envelope in a prompt, in order, with the adjacent tags naming one command folded
 * into a single span.
 *
 * Adjacency is the whole test, as it is for the local-command caveat: the CLI emits
 * `<command-message>` and `<command-name>` back to back with only whitespace between them,
 * so a same-named neighbour is the same envelope written twice. Read as two, each would
 * bound the other's `<command-args>` block and leave every run with empty arguments.
 */
function envelopes(text: string): EnvelopeSpan[] {
  const spans: EnvelopeSpan[] = [];
  for (const tag of text.matchAll(COMMAND_TAG_RE)) {
    const command = tag[2]!.toLowerCase();
    const previous = spans[spans.length - 1];
    if (previous && previous.command === command && text.slice(previous.end, tag.index).trim() === '') {
      previous.end = tag.index + tag[0].length;
      continue;
    }
    spans.push({ command, start: tag.index, end: tag.index + tag[0].length });
  }
  return spans;
}

/**
 * One envelope's own `<command-args>` body, from `from` to the `next` envelope.
 *
 * The block ends at its **closing tag**, not at the next envelope, since criteria quote
 * envelopes all the time. The *opening* tag is what has to fall ahead of the next envelope;
 * past it the block belongs to that envelope and this one carried no args. A block left
 * unclosed by a truncated prompt falls back to that bound.
 */
function readArgs(text: string, from: number, next: number): string {
  ARGS_OPEN_RE.lastIndex = from;
  const open = ARGS_OPEN_RE.exec(text);
  if (!open || open.index >= next) return '';

  const body = open.index + open[0].length;
  ARGS_CLOSE_RE.lastIndex = body;
  return text.slice(body, ARGS_CLOSE_RE.exec(text)?.index ?? next).trim();
}

/**
 * Read a run's command, arguments and flags off its opening prompt, or null when the
 * prompt declares no command the model was asked to carry out — i.e. it is an ordinary
 * session, not a run.
 *
 * The **first non-local** envelope wins: a session opened by `/clear` is the run of
 * whatever was typed after it, or no run at all when nothing was. Each envelope's args
 * are read from its own block, not the first in the prompt — a skipped local command
 * carries args too.
 */
export function parseCommandEnvelope(prompt: string | null | undefined): CommandEnvelope | null {
  if (!prompt) return null;
  const text = prompt.replace(REMINDER_RE, '').replace(/<system-reminder>[\s\S]*$/i, '');

  const found = envelopes(text);
  for (const [i, envelope] of found.entries()) {
    if (LOCAL_ENVELOPE_RE.test(text.slice(0, envelope.start))) continue;

    const args = readArgs(text, envelope.end, found[i + 1]?.start ?? text.length);
    const flags: string[] = [];
    for (const token of args.split(/\s+/)) {
      const flag = FLAG_RE.exec(token);
      if (!flag) break; // the first non-flag token starts the criteria
      flags.push(flag[1]!);
    }

    return {
      command: envelope.command,
      args,
      flags,
      prompt: args.replace(COMMAND_NOISE_RE, '').replace(/\s+/g, ' ').trim(),
    };
  }
  return null;
}

/**
 * A block the envelope wraps around text that is not the person's, dropped content and all.
 * `<command-message>` carries only the bare name `<command-name>` already states.
 */
const ENVELOPE_BLOCK_RE =
  /<command-message>[\s\S]*?<\/command-message>|<local-command-caveat>[\s\S]*?<\/local-command-caveat>|<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi;
/**
 * A matched `<command-name>` pair around a name, unwrapped to the name itself.
 *
 * The pair is the whole test, so a prompt that merely *writes* `<command-name>` in prose keeps
 * the word: this text is read verbatim in a drawer, and deleting every tag-shaped token there
 * turns a sentence about the envelope into one with a hole in it.
 */
const NAME_TAG_RE = /<command-name>\s*(\/?[A-Za-z0-9:_-]+)\s*<\/command-name>/gi;
const ARGS_OPEN = '<command-args>';
const ARGS_CLOSE = '</command-args>';

/**
 * One prompt with its command envelope taken out, for a human to read — the display
 * counterpart to {@link parseCommandEnvelope}.
 *
 * `<command-args>` is **unwrapped, not dropped**: its body is the criteria a person wrote. Only
 * the run's *own* block is unwrapped — its first opening tag and the last close after it — so
 * an envelope quoted inside those criteria survives as the prose it is.
 *
 * Whitespace inside what is kept is left exactly as written. The drawer renders `pre-wrap`, so
 * collapsing runs of spaces would flatten every indented code block and nested list a prompt
 * carries; only the trailing space a removed tag leaves behind, and the blank-line runs it
 * opens up, are tidied. Text carrying no envelope comes back unchanged apart from its trim.
 */
export function stripCommandEnvelope(text: string): string {
  let out = text
    .replace(ENVELOPE_BLOCK_RE, '')
    // A prompt cut mid-caveat never closes its tag, so that shape comes off by its opening.
    .replace(/<local-command-caveat>[\s\S]*$/i, '')
    .replace(NAME_TAG_RE, '$1');

  const open = out.toLowerCase().indexOf(ARGS_OPEN);
  if (open !== -1) {
    const close = out.toLowerCase().lastIndexOf(ARGS_CLOSE);
    const body = out.slice(open + ARGS_OPEN.length, close > open ? close : undefined);
    const after = close > open ? out.slice(close + ARGS_CLOSE.length) : '';
    out = out.slice(0, open) + body + after;
  }

  return out
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Step attribution ------------------------------------------------------

/**
 * How a step was pinned to a node, strongest first:
 *
 * - `explicit` — an unambiguous `STEP n/N` marker, or the agent naming the step at
 *   the head of the line it opens the step with ("Step 2 — scope: …").
 * - `narrated` — the step number appears, but mid-sentence, so it may be a reference
 *   rather than an entry ("per `/task`'s Step 3").
 * - `boundary` — no number, but the node runs the sub-command a single step names
 *   (`Skill(skill=clean)` against "Clean, then PR").
 * - `inferred` — no anchor of its own; carried forward from the last one.
 */
export type StepConfidence = 'explicit' | 'narrated' | 'boundary' | 'inferred';

/** Rank for picking the better of two competing anchors on one node. */
const CONFIDENCE_RANK = { explicit: 3, narrated: 2, boundary: 1, inferred: 0 } satisfies Record<StepConfidence, number>;

/** One node's placement: the step it belongs to, and how sure that is. */
export interface StepAttribution {
  /** The node's `index` in the transcript's stream. */
  node: number;
  /** Step id, or {@link UNATTRIBUTED} when nothing placed it. */
  step: string | null;
  /** Null exactly when `step` is {@link UNATTRIBUTED}. */
  confidence: StepConfidence | null;
  /** True when this node is where the step was entered, rather than carried into. */
  anchor: boolean;
}

/**
 * The forward-looking marker this parser is built to hand over to: an agent that
 * writes `STEP 2/6` states its step outright and needs no heuristic at all. Matched
 * first, so the day the commands emit it the narration rules stop mattering.
 */
const STEP_MARKER_RE = /\bSTEP\s+(\d+(?:\.\d+)?)\s*\/\s*\d+/;

/**
 * The agent naming a step in prose. A digit is required, which rejects the stepless
 * false friends that otherwise dominate.
 */
const STEP_NARRATION_RE = /\bstep\s+(\d+(?:\.\d+)?)\b/i;

/**
 * How far into a line a step mention still reads as *entering* that step rather than
 * referring to it. Openers lead with it; references trail the sentence.
 */
const ENTERING_WINDOW = 48;

/** A `Skill(skill=clean)` call: the sub-command boundary signal. */
const SKILL_CALL_RE = /^Skill\(skill=\/?([^,)\s]+)/i;
/** The tool a call names, e.g. `EnterWorktree` in `EnterWorktree(path=…)`. */
const TOOL_NAME_RE = /^([A-Za-z]\w*)\(/;

/** An anchor found on one node, before conflicts are resolved. */
interface Anchor {
  step: string;
  confidence: StepConfidence;
}

/**
 * The step a node explicitly names, if any. `explicit` when it leads the line (or uses
 * the `STEP n/N` marker), `narrated` when the mention is buried further in.
 */
function narratedAnchor(text: string, byId: ReadonlyMap<string, CommandStep>): Anchor | null {
  const marked = STEP_MARKER_RE.exec(text);
  if (marked && byId.has(marked[1]!)) return { step: marked[1]!, confidence: 'explicit' };

  const said = STEP_NARRATION_RE.exec(text);
  if (!said || !byId.has(said[1]!)) return null;
  return { step: said[1]!, confidence: said.index <= ENTERING_WINDOW ? 'explicit' : 'narrated' };
}

/** Does this call invoke that artifact? */
function callMatches(sig: string, lower: string, artifact: StepArtifact): boolean {
  if (artifact.kind === 'skill') {
    const call = SKILL_CALL_RE.exec(sig);
    return !!call && call[1]!.toLowerCase() === artifact.value;
  }
  if (artifact.kind === 'tool') return TOOL_NAME_RE.exec(sig)?.[1] === artifact.value;
  return lower.includes(artifact.value);
}

/**
 * The step a call implies, from the artifacts each step's body prescribes.
 *
 * The **longest** matching artifact wins, which resolves the overlaps these files are
 * full of: a step naming something in passing does not outrank the step that spells it
 * out. A tie across two steps is genuinely ambiguous and anchors nothing.
 */
function boundaryAnchor(tool: string | null, steps: readonly CommandStep[]): Anchor | null {
  if (!tool) return null;
  const lower = tool.toLowerCase();

  let best = 0;
  let found: string | null = null;
  for (const step of steps) {
    for (const artifact of step.artifacts ?? []) {
      if (artifact.value.length < best || !callMatches(tool, lower, artifact)) continue;
      if (artifact.value.length === best && found !== null && found !== step.id) {
        found = null; // a tie across two steps distinguishes nothing
        continue;
      }
      best = artifact.value.length;
      found = step.id;
    }
  }
  return found ? { step: found, confidence: 'boundary' } : null;
}

/**
 * Place every node of a run against its command's declared steps.
 *
 * Anchors come from the agent's own narration and from sub-command boundaries; the
 * steps between them are filled forward, since a run stays in a step until it says
 * otherwise. Nodes before the first anchor stay {@link UNATTRIBUTED} — a run that
 * never narrates attributes nothing, which is the honest answer rather than a guess.
 *
 * A catalogue with no steps attributes nothing, by the same rule.
 */
export function attributeSteps(nodes: readonly SessionNode[], steps: readonly CommandStep[]): StepAttribution[] {
  const byId = new Map(steps.map((s) => [s.id, s]));

  const out: StepAttribution[] = [];
  let current: string | null = UNATTRIBUTED;

  for (const node of nodes) {
    let anchor: Anchor | null = null;
    if (byId.size > 0) {
      // A decision or outcome is where the agent narrates; a tool call is where a
      // sub-command boundary shows up. Neither ever carries the other's signal.
      anchor =
        node.type === 'decision' || node.type === 'done' || node.type === 'task'
          ? narratedAnchor(node.text, byId)
          : boundaryAnchor(node.tool, steps);
    }

    if (anchor) {
      current = anchor.step;
      out.push({ node: node.index, step: anchor.step, confidence: anchor.confidence, anchor: true });
      continue;
    }
    out.push({
      node: node.index,
      step: current,
      confidence: current === UNATTRIBUTED ? null : 'inferred',
      anchor: false,
    });
  }

  return out;
}

/** The best confidence any anchor gave a step, or null if it was never anchored. */
export function stepConfidence(attributions: readonly StepAttribution[], step: string | null): StepConfidence | null {
  let best: StepConfidence | null = null;
  for (const a of attributions) {
    if (a.step !== step || !a.anchor || !a.confidence) continue;
    if (!best || CONFIDENCE_RANK[a.confidence] > CONFIDENCE_RANK[best]) best = a.confidence;
  }
  return best;
}

// --- Nested runs -----------------------------------------------------------
//
// A command invoked mid-session carries no envelope: the CLI expands the call itself,
// injecting the command file's body as an ordinary user turn with `$ARGUMENTS`
// substituted and the `<command-name>` tags stripped. The `Skill(skill=…)` call the
// transcript already records is the only durable marker.

/**
 * The command a node invokes as a nested run, or null when it invokes none.
 *
 * `Skill` also launches plain skills, so only names `isCommand` knows open a run.
 */
export function nestedCommandOf(node: SessionNode, isCommand: (name: string) => boolean): string | null {
  if (node.type !== 'tool' || !node.tool) return null;
  const call = SKILL_CALL_RE.exec(node.tool);
  if (!call) return null;
  const name = call[1]!.toLowerCase();
  return isCommand(name) ? name : null;
}

/** One command invoked inside a run, and the span of its host's transcript it covers. */
export interface NestedInvocation {
  command: string;
  /** Index of the `Skill(…)` node that opened it. */
  from: number;
  /** One past its last node. */
  to: number;
}

/**
 * Every command a transcript invokes inside itself, in order, each holding the nodes
 * from its call until the next nested command opens — or, for the last one, to the end.
 *
 * Nothing marks where a nested command *finishes* — it returns by the agent simply
 * carrying on in the same thread — so a span runs to the next invocation, which never
 * charges a node to two nested runs.
 */
export function findNestedInvocations(
  nodes: readonly SessionNode[],
  isCommand: (name: string) => boolean,
): NestedInvocation[] {
  const end = nodes.length === 0 ? 0 : nodes[nodes.length - 1]!.index + 1;
  const found: NestedInvocation[] = [];
  for (const node of nodes) {
    const command = nestedCommandOf(node, isCommand);
    if (!command) continue;
    const previous = found[found.length - 1];
    if (previous) previous.to = node.index;
    found.push({ command, from: node.index, to: end });
  }
  return found;
}

/**
 * A nested run's id: its host thread and the node its call sits on. `~` is unreserved
 * in a URL path, so the id doubles as the route param.
 */
export function nestedRunId(threadId: string, node: number): string {
  return `${threadId}~${node}`;
}

// --- Waste & rework --------------------------------------------------------

/**
 * Rework counters, tallied per step. Deliberately narrow and mechanical: the prose
 * diagnosis is the existing per-session suggestions engine's job, which this does not
 * duplicate — it is per-session and step-blind, which is exactly the gap these fill.
 */
export interface CommandRunWaste {
  /** `- ✗` results: a tool call that came back an error. */
  erroredTools: number;
  /** Reads of a path already read in this run — every read past the first. */
  duplicateReads: number;
  /** A call reissued with the same signature right after that call errored. */
  retriedAfterError: number;
  /** A narration turn that produced no tool call at all before the next one. */
  noOpTurns: number;
  /** Prompt tokens that missed the cache (`realInput − cacheRead`) over the step's turns. */
  cacheMissTokens: number;
}

export const ZERO_WASTE: CommandRunWaste = {
  erroredTools: 0,
  duplicateReads: 0,
  retriedAfterError: 0,
  noOpTurns: 0,
  cacheMissTokens: 0,
};

/** The path a call reads, when it is a read at all — the handle duplicate reads are counted on. */
const READ_CALL_RE = /^(Read|NotebookRead)\((?:file_path|notebook_path)=(.+)\)$/;

/**
 * Tally the node-derived waste counters per step. Token-derived counters
 * (`cacheMissTokens`) come from the turn series and are added by the caller.
 */
export function countWaste(
  nodes: readonly SessionNode[],
  attributions: readonly StepAttribution[],
): Map<string | null, CommandRunWaste> {
  const byNode = new Map(attributions.map((a) => [a.node, a.step]));
  const out = new Map<string | null, CommandRunWaste>();
  const bump = (step: string | null, key: keyof CommandRunWaste, by = 1) => {
    const w = out.get(step) ?? { ...ZERO_WASTE };
    w[key] += by;
    out.set(step, w);
  };

  const readPaths = new Set<string>();
  /** The call the last error blamed — a repeat of it is a retry. */
  let erroredCall: string | null = null;

  nodes.forEach((node, i) => {
    const step = byNode.get(node.index) ?? UNATTRIBUTED;

    if (node.type === 'error') {
      bump(step, 'erroredTools');
      erroredCall = node.tool;
      return;
    }

    if (node.type === 'tool') {
      const sig = node.tool ?? node.text;
      if (erroredCall && sig === erroredCall) {
        bump(step, 'retriedAfterError');
        erroredCall = null;
      }
      const read = READ_CALL_RE.exec(sig);
      if (read) {
        const path = read[2]!.trim();
        if (readPaths.has(path)) bump(step, 'duplicateReads');
        else readPaths.add(path);
      }
      return;
    }

    // Narration that led to nothing: the next node is more narration, or a new task.
    if (node.type === 'decision') {
      const next = nodes[i + 1];
      if (!next || next.type === 'decision' || next.type === 'task') bump(step, 'noOpTurns');
    }
  });

  return out;
}

// --- Patterns --------------------------------------------------------------

/** A deterministic rule that fired on one node of one run. */
export interface CommandPattern {
  /** Stable rule id — the key a cross-run frequency is counted on. */
  id: CommandPatternId;
  /** The rule's one-line name. */
  title: string;
  /** What it saw, on this node. */
  detail: string;
  /** The step it fired under, or {@link UNATTRIBUTED}. */
  step: string | null;
  /** The node it is badged on. */
  node: number;
}

export type CommandPatternId =
  | 'repeat-read'
  | 'retry-after-error'
  | 'step-reentered'
  | 'subagent-fanout'
  | 'context-respike'
  | 'step-errors-first';

/** Human names for the rule ids, for a table that lists rules a run didn't trip. */
export const COMMAND_PATTERN_TITLES = {
  'repeat-read': 'Same file read twice',
  'retry-after-error': 'Tool retried after an error',
  'step-reentered': 'Step re-entered',
  'subagent-fanout': 'Subagent fan-out',
  'context-respike': 'Context re-send spike',
  'step-errors-first': 'Step errors before it does anything',
} satisfies Record<CommandPatternId, string>;

/** Spawns under one step past which the fan-out is worth badging. */
const FANOUT_THRESHOLD = 3;
/** Growth in prompt size over the previous turn that counts as a re-send spike. */
const RESPIKE_RATIO = 1.5;
/** Below this a spike is noise, not a re-send — a small prompt can double cheaply. */
const RESPIKE_FLOOR = 20_000;

/** The fields {@link detectPatterns} needs from a run's turn series. */
export interface PatternTurn {
  step: string | null;
  realInput: number;
  /** Position in the run's turn series — what a spike is badged on when no node fits. */
  index: number;
  /** The node current when the turn was issued, if one was. */
  node: number | null;
}

/**
 * Run the rule catalogue over one run. Deterministic and order-preserving: same
 * inputs, same findings, each pinned to the node the UI badges it on. Cross-run
 * frequency is a join over the store afterwards — see {@link patternFrequency} — not
 * anything mined here.
 */
export function detectPatterns(
  nodes: readonly SessionNode[],
  attributions: readonly StepAttribution[],
  turns: readonly PatternTurn[] = [],
): CommandPattern[] {
  const byNode = new Map(attributions.map((a) => [a.node, a.step]));
  const found: CommandPattern[] = [];
  const add = (id: CommandPatternId, detail: string, node: number) =>
    found.push({ id, title: COMMAND_PATTERN_TITLES[id], detail, step: byNode.get(node) ?? UNATTRIBUTED, node });

  const readAt = new Map<string, number>();
  let erroredCall: string | null = null;
  const spawnsPerStep = new Map<string | null, number>();
  /** Steps already left, so a later anchor on one is a re-entry. */
  const visited = new Set<string>();
  let currentStep: string | null = UNATTRIBUTED;
  /** Steps whose first node so far has been an error and nothing else. */
  const stepSawWork = new Set<string | null>();

  nodes.forEach((node) => {
    const step = byNode.get(node.index) ?? UNATTRIBUTED;

    if (step !== currentStep) {
      if (currentStep !== UNATTRIBUTED) visited.add(currentStep);
      if (step !== UNATTRIBUTED && visited.has(step)) {
        add('step-reentered', `Step ${step} was entered again after moving on`, node.index);
      }
      currentStep = step;
    }

    if (node.type === 'error') {
      if (!stepSawWork.has(step)) {
        add('step-errors-first', `The first call step ${step ?? '—'} made came back an error`, node.index);
        stepSawWork.add(step);
      }
      erroredCall = node.tool;
      return;
    }

    // Only a call counts as the step doing something. Narrating its way in does not,
    // or a step that announces itself and then immediately fails would never fire.
    if (node.type !== 'tool') return;
    stepSawWork.add(step);
    const sig = node.tool ?? node.text;

    if (erroredCall && sig === erroredCall) {
      add('retry-after-error', `${sig} was reissued unchanged after it errored`, node.index);
      erroredCall = null;
    }

    const read = READ_CALL_RE.exec(sig);
    if (read) {
      const path = read[2]!.trim();
      const first = readAt.get(path);
      if (first === undefined) readAt.set(path, node.index);
      else add('repeat-read', `${path} was already read at step ${first}`, node.index);
    }

    if (/^(Agent|Task)\(/.test(sig)) {
      const n = (spawnsPerStep.get(step) ?? 0) + 1;
      spawnsPerStep.set(step, n);
      if (n === FANOUT_THRESHOLD) {
        add('subagent-fanout', `${n} subagents spawned under step ${step ?? '—'}`, node.index);
      }
    }
  });

  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1]!;
    const turn = turns[i]!;
    if (turn.realInput < RESPIKE_FLOOR || prev.realInput <= 0) continue;
    if (turn.realInput < prev.realInput * RESPIKE_RATIO) continue;
    const node = turn.node;
    if (node === null) continue; // nothing to badge it on
    add(
      'context-respike',
      `Prompt grew from ${prev.realInput.toLocaleString()} to ${turn.realInput.toLocaleString()} tokens in one turn`,
      node,
    );
  }

  return found.sort((a, b) => a.node - b.node);
}

// --- The run record --------------------------------------------------------

/** How a run ended. `running` is a run the store caught mid-flight. */
export type CommandRunOutcome = 'completed' | 'interrupted' | 'errored' | 'running';

/** One captured request in a run, placed against the step that was current when it went out. */
export interface CommandRunTurn {
  /** Sidecar base name — the handle the context drill-downs take. */
  file: string;
  timestamp: string;
  /** Which thread of the family sent it (the root, or one of its subagents). */
  threadId: string;
  /** The step it is charged to, or {@link UNATTRIBUTED}. */
  step: string | null;
  /** The node current when it was issued — the delta inspector's anchor. */
  node: number | null;
  tokens: AuditTokens;
  systemBytes: number;
  toolsBytes: number;
  toolCount: number;
  messageCount: number;
}

// --- Spawns and agent types ------------------------------------------------
//
// The proxy records what each spawn called itself (`subagent_type`, else the skill name)
// on the child transcript's header. These carry it into the run record, so an agent
// type's cost is a read off the store rather than a walk of the session graph.

/** One subagent a run spawned, and what its own turns cost. */
export interface CommandRunSpawn {
  /** The subagent's own transcript. */
  threadId: string;
  /** The thread whose call spawned it — the run's root, or another subagent. */
  parentThreadId: string | null;
  /**
   * What the spawn called itself: `subagent_type` from the call, else the skill name.
   * Null when the call named neither — a fact about the call, not missing data.
   */
  agentType: string | null;
  /** The spawning node in the parent's transcript, when the link records one. */
  spawnNode: number | null;
  /** The step the spawn is charged to, or {@link UNATTRIBUTED}. */
  step: string | null;
  /** How deep beneath this run's root it sits — 1 for a spawn the root made itself. */
  depth: number;
  /** This subagent's own turns only; a spawn of its own is a row of its own. */
  tokens: AuditTokens;
  cost: number;
  turns: number;
}

/**
 * Spawns of one agent type, rolled up. Keyed on the type the call named, so
 * `agentType: null` is its own bucket rather than folded away.
 */
export interface AgentTypeUsage {
  agentType: string | null;
  spawns: number;
  /** Captured requests those spawns sent between them. */
  turns: number;
  tokens: AuditTokens;
  cost: number;
  /** Runs that spawned at least one of this type. 1 when rolling up a single run. */
  runs: number;
}

/**
 * Roll every run's spawns up by agent type, most-used first.
 *
 * A record written before this field existed contributes nothing rather than throwing.
 * Ties break on cost, then on name, with the unnamed bucket last.
 */
export function summarizeAgentTypes(runs: readonly CommandRun[]): AgentTypeUsage[] {
  const byType = new Map<string | null, AgentTypeUsage>();
  for (const run of runs) {
    const seen = new Set<string | null>();
    for (const spawn of run.spawns ?? []) {
      const type = spawn.agentType ?? null;
      const row = byType.get(type) ?? {
        agentType: type,
        spawns: 0,
        turns: 0,
        tokens: ZERO_TOKENS,
        cost: 0,
        runs: 0,
      };
      row.spawns += 1;
      row.turns += spawn.turns ?? 0;
      row.tokens = addTokens(row.tokens, spawn.tokens ?? ZERO_TOKENS);
      row.cost += spawn.cost ?? 0;
      if (!seen.has(type)) {
        row.runs += 1;
        seen.add(type);
      }
      byType.set(type, row);
    }
  }

  return [...byType.values()].sort(
    (a, b) =>
      b.spawns - a.spawns ||
      b.cost - a.cost ||
      (a.agentType === null ? 1 : b.agentType === null ? -1 : a.agentType.localeCompare(b.agentType)),
  );
}

export interface CommandRunTotals {
  tokens: AuditTokens;
  /** USD, via `pricing.ts`. */
  cost: number;
  turns: number;
  toolCalls: number;
  /** Wall clock from first to last captured request, in ms. */
  durationMs: number;
  /**
   * End-to-end wall clock in ms.
   *
   * {@link durationMs} spans the *requests*, so it stops at the last one and reports 0 for
   * a run that only ever sent one. A top-level run brackets its whole session; a nested run
   * has no such bracket and falls back to the request span.
   *
   * 0 means unknown, not instant — there is no backfill.
   */
  wallMs: number;
}

export const ZERO_TOKENS: AuditTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, realInput: 0 };

export function addTokens(a: AuditTokens, b: AuditTokens): AuditTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    realInput: a.realInput + b.realInput,
  };
}

/** One step's slice of a run — the same figures as the totals, plus whether it was reached. */
export interface CommandRunStepStats {
  /** Step id, or {@link UNATTRIBUTED} for the bucket the UI shows rather than hides. */
  step: string | null;
  title: string;
  /** True when any node was attributed here. */
  reached: boolean;
  /** The best confidence behind that, or null when it was only ever filled forward. */
  confidence: StepConfidence | null;
  tokens: AuditTokens;
  cost: number;
  turns: number;
  nodes: number;
  toolCalls: number;
  waste: CommandRunWaste;
}

/** One command invocation, as stored. Append-only and versioned — see {@link COMMAND_RUN_SCHEMA}. */
export interface CommandRun {
  schema: number;
  /**
   * The record's key: the thread id for a top-level run, {@link nestedRunId} for a
   * nested one. Absent on records written before nested runs existed — read it through
   * {@link runKey}, which falls back to the thread id those records were keyed by.
   */
  runId: string;
  /** The run that invoked this one, or null when nothing did. */
  parentRunId: string | null;
  /** That run's command, so a nested record can name and link its parent on its own. */
  parentCommand: string | null;
  /** The host node holding the `Skill(…)` call that opened it; null at top level. */
  spawnNode: number | null;
  /** The host transcript's nodes this run covers, `[from, to)`; null when it covers all of them. */
  nodeRange: { from: number; to: number } | null;
  /** The session this run ran in. A nested run shares its host's. */
  threadId: string;
  command: string;
  args: string;
  flags: string[];
  /** The opening prompt with the envelope and reminders stripped. */
  prompt: string;
  /** Content hash of the command file as installed at capture time; null if unreadable. */
  commandHash: string | null;
  /** The step catalogue as it stood then, so the run survives a `/sync`. */
  steps: CommandStep[];
  model: string | null;
  started: string | null;
  ended: string | null;
  /** The run's whole agent family, root first. */
  threadIds: string[];
  totals: CommandRunTotals;
  /** Per-turn series — context growth turn over turn, not just the total. */
  turns: CommandRunTurn[];
  /**
   * Every subagent in this run's family below its root, parents before children, each
   * with the agent type its call named and what its own turns cost. Records written
   * before schema 4 carry none, and there is no backfill.
   */
  spawns: CommandRunSpawn[];
  /** Per declared step, plus the unattributed bucket last. */
  stepStats: CommandRunStepStats[];
  outcome: CommandRunOutcome;
  /**
   * A tombstone: this thread was recorded as a run and no longer parses as one. The store
   * is append-only, so retracting a record means writing it again with this set, and
   * readers drop it — see `readCommandRuns`.
   */
  retired?: true;
  interruption: InterruptionKind | null;
  /** The last declared step was attributed *and* the transcript emitted `- done:`. */
  reachedEnd: boolean;
  patterns: CommandPattern[];
  meta: {
    /** Turns no step could be placed against, so they carry tokens but no step. */
    turnsUnmapped: number;
    nodes: number;
    /** Nodes an anchor or a fill placed — the rest are the unattributed bucket. */
    attributed: number;
    /** Nodes an anchor placed directly, rather than a fill carrying the step forward. */
    anchored: number;
  };
  updatedAt: string;
}

/**
 * Structural guard for a record read back off the store. Checks only the identity
 * fields, which every schema version has carried: a record written by a newer or
 * older writer is kept and rendered from what it has, rather than crashing the page.
 * Callers read optional fields defensively — see {@link runTotals}.
 *
 * Generic in its input so the store reader keeps whatever type its own
 * `JSON.parse` produced through the narrowing; the three fields are decoded here.
 */
export function isCommandRun<Candidate>(value: Candidate): value is Candidate & CommandRun {
  const record = jsonObject(jsonValueOf(value));
  if (record === null) return false;
  return (
    jsonText(record.threadId) !== null && jsonText(record.command) !== null && jsonNumber(record.schema) !== null
  );
}

/**
 * A record's store key. Records written before nested runs carry no `runId` and were
 * keyed by thread id, which for a top-level run is the same string, so the upsert stays
 * stable across the schema bump.
 */
export function runKey(run: CommandRun): string {
  return run.runId || run.threadId;
}

/** A record's totals, defaulted — an older record missing the block still lists and sums. */
export function runTotals(run: CommandRun): CommandRunTotals {
  // SAFETY: `totals` is declared required, but the store is append-only and records
  // predating the block have no such key — `isCommandRun` admits them on the three
  // identity fields alone. Widening to `| undefined` is what makes the reads below
  // describe the record actually in hand rather than the current writer's schema.
  const t = run.totals as CommandRunTotals | undefined;
  return {
    tokens: t?.tokens ?? ZERO_TOKENS,
    cost: t?.cost ?? 0,
    turns: t?.turns ?? 0,
    toolCalls: t?.toolCalls ?? 0,
    durationMs: t?.durationMs ?? 0,
    wallMs: t?.wallMs ?? 0,
  };
}

/**
 * Classify how a run ended.
 *
 * "Reached the end" is the strict reading: the last declared step was attributed *and*
 * a `- done:` landed. Everything else falls to the interruption kind the transcript
 * already records, then to an unrecovered error, then to still-running.
 */
export function classifyOutcome(input: {
  reachedEnd: boolean;
  interruption: InterruptionKind | null;
  /** The run's last node, for the errored case. */
  lastNodeType: SessionNode['type'] | null;
  /** True while the transcript is still being appended to. */
  active: boolean;
}): CommandRunOutcome {
  if (input.reachedEnd) return 'completed';
  if (input.interruption) return 'interrupted';
  if (input.active) return 'running';
  if (input.lastNodeType === 'error') return 'errored';
  return 'interrupted';
}

/**
 * Whether a run reached its last declared step and said it was done. A command with no
 * declared steps can only be judged on the `- done:`.
 */
export function reachedEnd(
  steps: readonly CommandStep[],
  attributions: readonly StepAttribution[],
  nodes: readonly SessionNode[],
): boolean {
  const done = nodes.some((n) => n.type === 'done');
  if (!done) return false;
  const last = steps[steps.length - 1];
  if (!last) return true;
  return attributions.some((a) => a.step === last.id);
}

/**
 * Roll one run's nodes and turns up into per-step stats: every declared step in
 * order — reached or not, so the drop-off funnel has its full spine — with the
 * unattributed bucket appended last.
 */
export function summarizeSteps(input: {
  steps: readonly CommandStep[];
  nodes: readonly SessionNode[];
  attributions: readonly StepAttribution[];
  turns: readonly CommandRunTurn[];
  model: string;
}): CommandRunStepStats[] {
  const { steps, nodes, attributions, turns, model } = input;
  const waste = countWaste(nodes, attributions);
  const byNode = new Map(attributions.map((a) => [a.node, a.step]));

  const keys: (string | null)[] = [...steps.map((s) => s.id), UNATTRIBUTED];
  const titles = new Map<string | null, string>(steps.map((s) => [s.id, s.title]));

  return keys.map((step) => {
    const stepNodes = nodes.filter((n) => (byNode.get(n.index) ?? UNATTRIBUTED) === step);
    const stepTurns = turns.filter((t) => t.step === step);
    const tokens = stepTurns.reduce((acc, t) => addTokens(acc, t.tokens), ZERO_TOKENS);
    const w = { ...ZERO_WASTE, ...waste.get(step) };
    w.cacheMissTokens = stepTurns.reduce((n, t) => n + Math.max(0, t.tokens.realInput - t.tokens.cacheRead), 0);

    return {
      step,
      title: step === UNATTRIBUTED ? 'Unattributed' : (titles.get(step) ?? ''),
      reached: stepNodes.length > 0,
      confidence: stepConfidence(attributions, step),
      tokens,
      cost: estimateCost(tokens, model).total,
      turns: stepTurns.length,
      nodes: stepNodes.length,
      toolCalls: stepNodes.filter((n) => n.type === 'tool').length,
      waste: w,
    };
  });
}

// --- Aggregation across the store ------------------------------------------

/** One installed command's row on the `/commands` index. */
export interface CommandSummary {
  command: string;
  /** True when `~/.claude/commands/<name>.md` is still installed. */
  installed: boolean;
  /** The catalogue as installed now — the current one, not a run's snapshot. */
  steps: CommandStep[];
  /** Content hash of the installed file, or null when it is gone. */
  commandHash: string | null;
  runs: number;
  /** Runs whose `reachedEnd`, over runs that are no longer running. */
  completionRate: number;
  totalCost: number;
  totalTokens: number;
  /** Cost per run, oldest first — the sparkline. */
  costSeries: { date: string; value: number }[];
  lastRun: string | null;
  /** Every flag any run of it used, for the facet control. */
  flags: string[];
  /** What this command delegates to, most-used first — the agent-type column. */
  agentTypes: AgentTypeUsage[];
}

/**
 * The `/commands` index: one row per installed command, plus any command the store has
 * runs for that is no longer installed (so history doesn't vanish with a `/sync`).
 * Ordered by invocations, then name.
 */
export function summarizeCommands(
  installed: readonly { command: string; steps: CommandStep[]; commandHash: string }[],
  runs: readonly CommandRun[],
): CommandSummary[] {
  const byCommand = new Map<string, CommandRun[]>();
  for (const run of runs) {
    const list = byCommand.get(run.command);
    if (list) list.push(run);
    else byCommand.set(run.command, [run]);
  }

  const names = new Set<string>([...installed.map((c) => c.command), ...byCommand.keys()]);
  const installedBy = new Map(installed.map((c) => [c.command, c]));

  const rows: CommandSummary[] = [];
  for (const command of names) {
    const own = (byCommand.get(command) ?? []).slice().sort((a, b) => (a.started ?? '').localeCompare(b.started ?? ''));
    const settled = own.filter((r) => r.outcome !== 'running');
    const spec = installedBy.get(command);

    rows.push({
      command,
      installed: !!spec,
      steps: spec?.steps ?? own[own.length - 1]?.steps ?? [],
      commandHash: spec?.commandHash ?? null,
      runs: own.length,
      completionRate: settled.length === 0 ? 0 : settled.filter((r) => r.reachedEnd).length / settled.length,
      totalCost: own.reduce((n, r) => n + runTotals(r).cost, 0),
      totalTokens: own.reduce((n, r) => n + runTotals(r).tokens.realInput, 0),
      costSeries: own.map((r) => ({ date: r.started ?? '', value: runTotals(r).cost })),
      lastRun: own[own.length - 1]?.started ?? null,
      flags: [...new Set(own.flatMap((r) => r.flags ?? []))].sort(),
      agentTypes: summarizeAgentTypes(own),
    });
  }

  return rows.sort((a, b) => b.runs - a.runs || a.command.localeCompare(b.command));
}

/** How often one rule fires across a command's runs — the badge's "seen in 8 of 10". */
export interface PatternFrequency {
  id: CommandPatternId;
  title: string;
  /** Runs it fired in at least once. */
  runs: number;
  /** Runs considered — the denominator. */
  ofRuns: number;
  /** Total firings, which can exceed `runs`. */
  hits: number;
}

/**
 * Cross-run frequency for every rule in the catalogue, over the runs given. A cheap
 * join over the store, listing rules that never fired at zero so the table is a
 * catalogue rather than only a highlight reel.
 */
export function patternFrequency(runs: readonly CommandRun[]): PatternFrequency[] {
  // SAFETY: `COMMAND_PATTERN_TITLES` is a literal keyed by every `CommandPatternId`
  // and nothing else — the `satisfies` on it is what holds that — so its own keys
  // are exactly the catalogue, which `Object.keys` only ever types as `string[]`.
  const ids = Object.keys(COMMAND_PATTERN_TITLES) as CommandPatternId[];
  return ids
    .map((id) => {
      let inRuns = 0;
      let hits = 0;
      for (const run of runs) {
        const fired = (run.patterns ?? []).filter((p) => p.id === id).length;
        if (fired > 0) inRuns += 1;
        hits += fired;
      }
      return { id, title: COMMAND_PATTERN_TITLES[id], runs: inRuns, ofRuns: runs.length, hits };
    })
    .sort((a, b) => b.runs - a.runs || a.title.localeCompare(b.title));
}

/** Per declared step, how many runs got that far — the drop-off funnel. */
export interface StepReach {
  step: string | null;
  title: string;
  /** Runs that attributed at least one node here. */
  reached: number;
  ofRuns: number;
  tokens: number;
  cost: number;
}

/**
 * The drop-off funnel and the stacked tokens-by-step bar, in one pass. The spine is
 * the *current* catalogue so the shape is stable across runs whose snapshots differ;
 * the unattributed bucket is appended, never folded away.
 */
export function stepReach(steps: readonly CommandStep[], runs: readonly CommandRun[]): StepReach[] {
  const keys: (string | null)[] = [...steps.map((s) => s.id), UNATTRIBUTED];
  const titles = new Map<string | null, string>(steps.map((s) => [s.id, s.title]));

  return keys.map((step) => {
    let reached = 0;
    let tokens = 0;
    let cost = 0;
    for (const run of runs) {
      const stat = (run.stepStats ?? []).find((s) => s.step === step);
      if (!stat) continue;
      if (stat.reached) reached += 1;
      tokens += stat.tokens?.realInput ?? 0;
      cost += stat.cost ?? 0;
    }
    return {
      step,
      title: step === UNATTRIBUTED ? 'Unattributed' : (titles.get(step) ?? ''),
      reached,
      ofRuns: runs.length,
      tokens,
      cost,
    };
  });
}

/**
 * One run's **profile**: how much work it did, and how long it took end to end.
 *
 * Distinct from {@link CommandRunStepStats}, which asks where the *tokens* went. Every
 * field is read off the stored record, so nothing here needs the raw logs.
 */
export interface CommandRunProfile {
  /** The record's key, so a point on the trend can link to its run. */
  runId: string;
  started: string | null;
  /**
   * Declared `## Step N` steps this run attributed at least one node to.
   *
   * Counted against the run's **own** snapshot, not the current catalogue: a step added
   * afterwards was never available to reach.
   */
  stepsReached: number;
  /** Steps that snapshot declared — the ceiling {@link stepsReached} is out of. */
  stepsDeclared: number;
  /** Transcript nodes in the run: agent steps, the literal unit of work done. */
  nodes: number;
  /** The tool calls among them — work that touched something, not narration. */
  toolCalls: number;
  /** Captured requests. Not chat messages, and not the same as a step. */
  turns: number;
  /** {@link CommandRunTotals.wallMs} when the record carries one, else the request span. */
  endToEndMs: number;
  /** False when {@link endToEndMs} fell back to the narrower request span. */
  wallMeasured: boolean;
  outcome: CommandRunOutcome;
  /** The command file's hash then, so the trend can mark where a `/sync` moved it. */
  commandHash: string | null;
}

/**
 * The per-run profile series for one command's trend, **oldest first** — a trend reads
 * left to right, unlike the run list.
 *
 * Runs with no start are dropped — they have no place on the x-axis.
 */
export function commandRunProfiles(runs: readonly CommandRun[]): CommandRunProfile[] {
  return runs
    .filter((run) => !!run.started)
    .map((run): CommandRunProfile => {
      const totals = runTotals(run);
      const declared = run.steps ?? [];
      const stats = run.stepStats ?? [];
      // The unattributed bucket is a row on the step table, but not a step the run got to.
      const declaredIds = new Set(declared.map((s) => s.id));
      const wall = totals.wallMs;

      return {
        runId: runKey(run),
        started: run.started ?? null,
        stepsReached: stats.filter((s) => s.step !== null && s.reached && declaredIds.has(s.step)).length,
        stepsDeclared: declared.length,
        nodes: run.meta?.nodes ?? 0,
        toolCalls: totals.toolCalls,
        turns: totals.turns,
        endToEndMs: wall > 0 ? wall : totals.durationMs,
        wallMeasured: wall > 0,
        outcome: run.outcome ?? 'interrupted',
        commandHash: run.commandHash ?? null,
      };
    })
    .sort((a, b) => (a.started ?? '').localeCompare(b.started ?? ''));
}

/**
 * Keep only the runs that used every one of `flags`. An empty filter keeps everything —
 * the facet narrows a command's runs, it never splits the command into variants.
 */
export function filterRunsByFlags(runs: readonly CommandRun[], flags: readonly string[]): CommandRun[] {
  if (flags.length === 0) return [...runs];
  return runs.filter((run) => flags.every((f) => (run.flags ?? []).includes(f)));
}
