/**
 * Parse a proxy-written Session transcript (`logs/sessions/<threadId>.md`) into
 * the handful of facts the dashboard lists: which model/session it belongs to,
 * when it started, and how much happened (tasks, decisions, tools, failures).
 *
 * The transcript is produced by `proxy/session.ts` and has a fixed, line-based
 * shape, so parsing is a cheap single pass — no markdown library needed:
 *
 *   # Session <threadId>
 *   - model: claude-opus-4-8
 *   - session: <sessionId>
 *   - started: 2026-07-23T17:40:51.064Z
 *   - title: <CLI-generated chat title>        (present once the CLI titles it)
 *   - subtitle: <first user prompt, reminder stripped>
 *
 *   ## Task: <first user prompt>
 *   - decided: <assistant reasoning before a tool call>
 *   - Bash(command=…)
 *   - ✗ <errored tool result>
 *   - done: <outcome>
 */

export interface SessionMeta {
  /** The 16-hex-char thread id (also the file name stem and route param). */
  threadId: string;
  model: string | null;
  sessionId: string | null;
  /** ISO 8601 start time from the header, or null if absent. */
  started: string | null;
  /** How many `## Task:` blocks the transcript records. */
  tasks: number;
  /** `- decided:` lines (an assistant decision before a tool call). */
  decisions: number;
  /** Tool-call lines, e.g. `- Edit(file_path=…)`. */
  tools: number;
  /** `- ✗ …` lines (an errored tool result). */
  errors: number;
  /** The first task's text, for a one-line preview in the list. */
  firstTask: string | null;
  /**
   * The CLI's auto-generated chat title, captured from the titling request's
   * response, or null if the session was never titled. User-*renamed* titles
   * aren't sent to the API, so only the generated title is observable.
   */
  title: string | null;
  /** The first user message with its injected `<system-reminder>` context stripped — a clean subtitle. */
  subtitle: string | null;
  /** A short name condensed from the opening prompt, subordinate to {@link title}. */
  derivedTitle: string | null;
}

/** One errored tool result from a transcript, tagged with its task and most-likely originating tool call. */
export interface SessionError {
  /** Position among the transcript's errors, 0-based — also the deep-link anchor. */
  index: number;
  /** The `## Task:` heading this error fell under, or null if it preceded any task. */
  task: string | null;
  /** The nearest preceding tool-call line (e.g. `Bash(command=npm test)`), or null. */
  tool: string | null;
  /** The error text captured on the `- ✗ …` line. */
  text: string;
}

const HEADER_RE = {
  model: /^- model:\s*(.*)$/,
  session: /^- session:\s*(.*)$/,
  started: /^- started:\s*(.*)$/,
  title: /^- title:\s*(.*)$/,
  subtitle: /^- subtitle:\s*(.*)$/,
} as const;

// --- Deriving a name when the CLI never sends one --------------------------
//
// Only interactive chats get a `- title:` line: headless runs (`claude --print`)
// and subagents never trigger the CLI's out-of-band titling request. Condense their
// opening prompt instead, in the same sentence-case shape the CLI's titles use.

/**
 * A slash command arrives wrapped in an envelope, the command definition inlined
 * after the tags. The command and its arguments are the name; the definition is
 * boilerplate identical across every run.
 */
const COMMAND_NAME_RE = /<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/i;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/i;
/** The caveat the CLI prepends to a locally-run command, and the leftover envelope tags. */
const COMMAND_NOISE_RE = /<local-command-caveat>[\s\S]*?<\/local-command-caveat>|<\/?command-[a-z-]+>/gi;

/** Drop the envelope. A prompt cut mid-caveat never closes its tag, so take that shape too. */
const stripCommandNoise = (s: string): string =>
  s.replace(COMMAND_NOISE_RE, '').replace(/<local-command-caveat>[\s\S]*$/i, '');

/** Openers a prompt leads with that name nothing about the work. */
const LEAD_FILLER_RE =
  /^(?:hey|hi|ok|okay|so|now|please|pls|can you|could you|would you|i(?:'d|'ll| would)? (?:like you to|want you to)|let'?s|help me|go ahead and|just)\b[\s,:—-]*/i;

/** Where a prompt's first sentence ends — the rest is elaboration, not the name. */
const SENTENCE_END_RE = /[.!?](?:\s|$)/;

/** The most words a derived name carries, matching the CLI's own 3–7 word titles. */
const NAME_WORDS = 7;
/** …and its hard character cap, so one long token can't run away with the row. */
const NAME_CHARS = 60;

/**
 * Condense an opening prompt into a short session name, or null when there's nothing
 * to name. A slash command names itself; anything else has its leading filler dropped
 * and its first sentence kept, capped at {@link NAME_WORDS} words / {@link NAME_CHARS}
 * chars with an `…` marking the cut.
 */
export function deriveSessionName(prompt: string | null): string | null {
  if (!prompt) return null;

  // Transcripts predating the reminder-free subtitle open with an injected context
  // blob; one truncated mid-block never closes its tag, so drop that shape too.
  let text = prompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<system-reminder>[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Name a slash command by its command and arguments, not the definition inlined after.
  const command = COMMAND_NAME_RE.exec(text);
  if (command) {
    const args = COMMAND_ARGS_RE.exec(text)?.[1] ?? '';
    const named = stripCommandNoise(`${command[1]} ${args}`).replace(/\s+/g, ' ').trim();
    return capped(named);
  }
  text = stripCommandNoise(text).replace(/\s+/g, ' ').trim();

  // Filler stacks, so peel until nothing more comes off.
  for (let i = 0; i < 3; i++) {
    const stripped = text.replace(LEAD_FILLER_RE, '');
    if (stripped === text) break;
    text = stripped;
  }

  const end = SENTENCE_END_RE.exec(text);
  if (end && end.index > 0) text = text.slice(0, end.index);
  return capped(text.trim());
}

/**
 * Cut a one-line string down to a name: {@link NAME_WORDS} words and {@link NAME_CHARS}
 * chars at most, an `…` marking either cut. Null when nothing is left.
 */
function capped(text: string): string | null {
  if (!text) return null;

  const words = text.split(' ');
  let cut = words.length > NAME_WORDS;
  let name = words.slice(0, NAME_WORDS).join(' ');
  if (name.length > NAME_CHARS) {
    name = name.slice(0, NAME_CHARS).trimEnd();
    cut = true;
  }
  if (!name) return null;

  // Sentence case, but never on a path/flag/quoted command — those stay as typed.
  if (/^[a-z]+$/.test(words[0] ?? '')) name = name[0]!.toUpperCase() + name.slice(1);
  return cut ? `${name}…` : name;
}

/**
 * The most human name a transcript offers, in falling order of authority: CLI title,
 * derived name, opening prompt. Null when only the id is left.
 */
export function sessionName(meta: SessionMeta): string | null {
  return meta.title ?? meta.derivedTitle ?? meta.subtitle ?? meta.firstTask;
}

/** {@link sessionName} with the thread id as the last resort, for callers needing a string. */
export function sessionDisplayName(meta: SessionMeta): string {
  return sessionName(meta) ?? meta.threadId;
}

const TASK_RE = /^## Task:\s*(.*)$/;
const DECIDED_RE = /^- decided:\s/;
const ERROR_RE = /^- ✗\s(.*)$/;
/**
 * Marks the *first* `tool_use` of an assistant message (`- ▸ Name(…)`); every call after
 * it in that message stays unmarked. `proxy/session.ts` mirrors this constant rather than
 * importing it — it is zero-dependency — and a cross-check test pins the two together.
 */
export const TURN_MARKER = '▸';

/**
 * A tool-call line: `- Name(` — distinct from `- decided:` / `- done:` prose. Group 1 is
 * {@link TURN_MARKER} when the call opened a turn, group 2 the call signature. Transcripts
 * written before the marker existed carry no group 1, so their turns are unrecoverable.
 */
const TOOL_RE = /^- (?:(▸) )?([A-Za-z]\w*\(.*)$/;
/** The dashboard's own cut, written as its own line (see {@link INTERRUPTION_LINE}). */
const INTERRUPTED_RE = /^- interrupted:\s*(.*)$/;

// --- Interruptions ---------------------------------------------------------
//
// A run can be cut off mid-flight two ways, each leaving a different trace.
// Claude Code's Esc prepends `[Request interrupted by user]` to the user turn that
// redirected it, so the marker rides in on the *next* task line. A dashboard chat
// stopped through `POST /api/chat/stop` never reaches the wire — the child is killed —
// so the server records it as an `- interrupted: <why>` line. Both read the same to
// the graph: the step before was cut short, and what follows is a new trail.

/** Why a run stopped mid-flight. */
export type InterruptionKind = 'user' | 'tool-use' | 'stopped' | 'timeout' | 'limit';

/** Claude Code's marker, prepended to the user turn that interrupted the run. */
const INTERRUPT_MARKER_RE = /^\[Request interrupted by user(?<tool> for tool use)?\]\s*/;

const INTERRUPTION_KINDS = new Set<string>(['user', 'tool-use', 'stopped', 'timeout', 'limit']);

/** Read an `- interrupted:` line's reason; anything unrecognized reads as a plain stop. */
export function interruptionKind(raw: string): InterruptionKind {
  const one = raw.trim().toLowerCase();
  return (INTERRUPTION_KINDS.has(one) ? one : 'stopped') as InterruptionKind;
}

/** The transcript line the dashboard appends when its own Stop (or a ceiling) cut a turn. */
export const INTERRUPTION_LINE = (kind: InterruptionKind): string => `- interrupted: ${kind}`;

/**
 * Split Claude Code's interruption marker off a user turn: the kind it names, and the
 * words that followed it (the redirection, which is the resumed run's first task). Text
 * with no marker comes back unchanged and `null`.
 */
export function splitInterruption(text: string): { kind: InterruptionKind | null; text: string } {
  const m = INTERRUPT_MARKER_RE.exec(text);
  if (!m) return { kind: null, text };
  return { kind: m.groups?.tool ? 'tool-use' : 'user', text: text.slice(m[0].length) };
}

/** Distill one transcript's text into its listing/detail metadata. */
export function parseSessionTranscript(threadId: string, content: string): SessionMeta {
  const meta: SessionMeta = {
    threadId,
    model: null,
    sessionId: null,
    started: null,
    tasks: 0,
    decisions: 0,
    tools: 0,
    errors: 0,
    firstTask: null,
    title: null,
    subtitle: null,
    derivedTitle: null,
  };

  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');

    const task = TASK_RE.exec(line);
    if (task) {
      meta.tasks += 1;
      if (meta.firstTask === null) meta.firstTask = (task[1] ?? '').trim() || null;
      continue;
    }
    if (DECIDED_RE.test(line)) {
      meta.decisions += 1;
      continue;
    }
    if (ERROR_RE.test(line)) {
      meta.errors += 1;
      continue;
    }
    if (TOOL_RE.test(line)) {
      meta.tools += 1;
      continue;
    }

    // Header fields only fill until first set (the header is at the top).
    if (meta.model === null) {
      const m = HEADER_RE.model.exec(line);
      if (m) {
        meta.model = (m[1] ?? '').trim() || null;
        continue;
      }
    }
    if (meta.sessionId === null) {
      const m = HEADER_RE.session.exec(line);
      if (m) {
        meta.sessionId = (m[1] ?? '').trim() || null;
        continue;
      }
    }
    if (meta.started === null) {
      const m = HEADER_RE.started.exec(line);
      if (m) {
        meta.started = (m[1] ?? '').trim() || null;
        continue;
      }
    }
    // `- title:` may be written into the header or appended later (the titling
    // request arrives out of band), so it isn't confined to the header block.
    if (meta.title === null) {
      const m = HEADER_RE.title.exec(line);
      if (m) {
        meta.title = (m[1] ?? '').trim() || null;
        continue;
      }
    }
    if (meta.subtitle === null) {
      const m = HEADER_RE.subtitle.exec(line);
      if (m) meta.subtitle = (m[1] ?? '').trim() || null;
    }
  }

  // The subtitle is the opening prompt stripped of reminders; the first task is the
  // same prompt raw, for transcripts written before subtitles existed.
  meta.derivedTitle = deriveSessionName(meta.subtitle ?? meta.firstTask);
  return meta;
}

/** The kinds of appended line a transcript records after its header, in emit order. */
export type SessionNodeType = 'task' | 'decision' | 'tool' | 'error' | 'done';

/** One appended transcript line, structured for the live session graph. */
export interface SessionNode {
  /** Position among the transcript's nodes, 0-based — stable across polls, so a graph can append. */
  index: number;
  type: SessionNodeType;
  /** The human-readable gist (task text, decision, tool signature, error, or outcome). */
  text: string;
  /** For `tool` nodes the call signature; for `error` nodes the nearest preceding tool call; else null. */
  tool: string | null;
  /** The `## Task:` heading this node falls under, or null if it preceded any task. */
  task: string | null;
  /** The interruption this step picked back up after — head of a side trail; null on an ordinary step. */
  interruption: InterruptionKind | null;
  /** True when the run was cut off *at* this step: the interruption landed right after it. */
  interrupted: boolean;
  /**
   * Index into the captured request's `messages[]` this step was read from. Null on a step
   * read back off a transcript, which records no such position.
   */
  message: number | null;
  /**
   * Which assistant turn emitted this call — 0-based, counting only turns that made calls.
   * Every `tool_use` block of one message shares a number, so calls that went out *together*
   * stay distinguishable from calls that each cost their own round-trip.
   *
   * Null on every non-`tool` node, and on a `tool` node whose turn is unknowable: a
   * transcript written before {@link TURN_MARKER} existed records no boundary at all.
   */
  turn: number | null;
}

const DECIDED_TEXT_RE = /^- decided:\s*(.*)$/;
const DONE_TEXT_RE = /^- done:\s*(.*)$/;

/**
 * Parse a transcript into its ordered stream of appended nodes (task, decision,
 * tool, error, done), skipping the header. Uses the same line grammar as
 * {@link parseSessionTranscript}; `error` nodes carry the nearest preceding tool
 * call so the graph can show what failed. Order is the file's line order.
 *
 * An interruption is a flag, not a step: it marks the node it cut short and the node
 * the run resumed on, so every node's `index` still counts transcript lines (the agent
 * linkage is built from those positions).
 *
 * Turns are counted off {@link TURN_MARKER}: each marked call opens a turn and the unmarked
 * calls after it share it. Calls seen *before* the transcript's first marker keep
 * `turn: null` — a thread can straddle the change.
 */
export function parseSessionNodes(content: string): SessionNode[] {
  const nodes: SessionNode[] = [];
  let task: string | null = null;
  let lastTool: string | null = null;
  /** An interruption seen but not yet attached — it belongs to the step that resumes. */
  let pending: InterruptionKind | null = null;
  /** The turn the calls being read belong to, or null until the first marker names one. */
  let turn: number | null = null;

  const push = (type: SessionNodeType, text: string, tool: string | null) => {
    nodes.push({
      index: nodes.length,
      type,
      text: text.trim(),
      tool,
      task,
      interruption: pending,
      interrupted: false,
      message: null,
      turn: type === 'tool' ? turn : null,
    });
    pending = null;
  };

  /** Sever the run here: the last step so far was cut off, and the next one resumes. */
  const cut = (kind: InterruptionKind) => {
    const last = nodes[nodes.length - 1];
    if (last) last.interrupted = true;
    pending = kind;
  };

  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');

    const stopped = INTERRUPTED_RE.exec(line);
    if (stopped) {
      cut(interruptionKind(stopped[1] ?? ''));
      continue;
    }

    const taskMatch = TASK_RE.exec(line);
    if (taskMatch) {
      const split = splitInterruption((taskMatch[1] ?? '').trim());
      if (split.kind) cut(split.kind);
      task = split.text.trim() || null;
      lastTool = null;
      push('task', task ?? '', null);
      continue;
    }

    const decided = DECIDED_TEXT_RE.exec(line);
    if (decided) {
      push('decision', decided[1] ?? '', null);
      continue;
    }

    const done = DONE_TEXT_RE.exec(line);
    if (done) {
      push('done', done[1] ?? '', null);
      continue;
    }

    const errorMatch = ERROR_RE.exec(line);
    if (errorMatch) {
      push('error', errorMatch[1] ?? '', lastTool);
      lastTool = null;
      continue;
    }

    const toolMatch = TOOL_RE.exec(line);
    if (toolMatch) {
      // A marked call opens the next turn; an unmarked one joins whatever turn is open.
      if (toolMatch[1]) turn = turn === null ? 0 : turn + 1;
      const sig = (toolMatch[2] ?? '').trim();
      lastTool = sig;
      push('tool', sig, sig);
    }
  }

  return nodes;
}

/**
 * Untruncated node texts from a transcript's `<threadId>.nodes.jsonl` sidecar,
 * keyed by node index — the whole text behind the gists {@link parseSessionNodes}
 * reads back. Sparse: only nodes whose line dropped something get an entry, and
 * transcripts predating the sidecar have none. Malformed lines are skipped.
 */
export function parseSessionNodeTexts(content: string): Record<number, string> {
  const texts: Record<number, string> = {};
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { i?: unknown; text?: unknown };
      if (typeof row.i === 'number' && Number.isInteger(row.i) && row.i >= 0 && typeof row.text === 'string') {
        texts[row.i] = row.text;
      }
    } catch {
      /* skip a torn or truncated line */
    }
  }
  return texts;
}

// --- Subagent linkage ------------------------------------------------------
//
// A subagent runs under its parent's session id but with its own conversation
// root, so the proxy writes it as a *separate* transcript (see proxy/session.ts).
// Nothing on the wire names the pair, so the tree is reconstructed here from the
// parent's `Agent(...)` spawn lines and the group's other transcripts.

/** Tool names whose call spawns a subagent that gets its own transcript. */
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

/** A tool-call signature, split into name and recorded args. */
const TOOL_SIG_RE = /^([A-Za-z]\w*)\((.*)\)$/;
const SUBAGENT_TYPE_RE = /(?:^|,\s*)subagent_type=([^,]*)/;

/**
 * The `subagent_type` a node spawns — `""` when the call recorded no type — or
 * null when the node isn't a spawn at all.
 */
export function spawnAgentType(node: SessionNode): string | null {
  if (node.type !== 'tool' || !node.tool) return null;
  const sig = TOOL_SIG_RE.exec(node.tool);
  if (!sig || !SPAWN_TOOLS.has(sig[1] ?? '')) return null;
  return (SUBAGENT_TYPE_RE.exec(sig[2] ?? '')?.[1] ?? '').trim();
}

/** True when this node is an `Agent(…)` / `Task(…)` call — a subagent spawn. */
export function isAgentSpawn(node: SessionNode): boolean {
  return spawnAgentType(node) !== null;
}

/** The fields {@link linkAgentSessions} needs from a transcript. */
export interface LinkableSession {
  threadId: string;
  sessionId: string | null;
  started: string | null;
  nodes: SessionNode[];
}

/** Where one transcript sits in its session id's agent tree. */
export interface SessionAgentLink {
  /** The transcript that spawned this one, or null for a top-level session. */
  parentThreadId: string | null;
  /** Index of the parent node that spawned this one, or null at top level. */
  spawnIndex: number | null;
  /** `subagent_type` from the spawn call (e.g. `Explore`), or null when unknown. */
  agentType: string | null;
  /**
   * The parent node this subagent's work flows back into: the parent's first step
   * after the spawn that isn't itself a spawn. Null while the subagent is in flight.
   */
  returnIndex: number | null;
  /** 0 for a top-level session, 1 for its subagents, 2 for theirs, and so on. */
  depth: number;
  /**
   * True when the caller recorded this subagent's result flowing back — the report that
   * *is* a subagent's outcome. Always false for a top-level session, which closes with a
   * `done:` line of its own instead.
   */
  reported: boolean;
  /** Subagents spawned by this transcript, in spawn order. */
  childThreadIds: string[];
}

const topLevelLink = (): SessionAgentLink => ({
  parentThreadId: null,
  spawnIndex: null,
  agentType: null,
  returnIndex: null,
  depth: 0,
  reported: false,
  childThreadIds: [],
});

/** Where a spawn's result rejoins the parent: its next non-spawn step, or null while in flight. */
function returnIndexAfter(nodes: SessionNode[], spawnIndex: number): number | null {
  for (const node of nodes) {
    if (node.index > spawnIndex && !isAgentSpawn(node)) return node.index;
  }
  return null;
}

/**
 * Whether a spawn's result came back to its caller: the parent resumed at `returnIndex`,
 * and that step is not the spawn coming back as a failure or cut short at it.
 *
 * The subagent's own transcript cannot say. Its report is the reply to its last request,
 * and no later request in that thread carries that reply, so a subagent transcript always
 * ends on the last tool call it made however cleanly it finished.
 */
function reportedBack(nodes: SessionNode[], spawnIndex: number, returnIndex: number | null): boolean {
  const spawn = nodes.find((n) => n.index === spawnIndex);
  if (spawn?.interrupted) return false;
  if (returnIndex === null) return false;
  const at = nodes.find((n) => n.index === returnIndex);
  if (!at) return false;
  // An `- ✗` blamed on the spawn call is the subagent failing, not reporting.
  return !(at.type === 'error' && at.tool === spawn?.tool);
}

/**
 * Reconstruct the agent tree across a set of transcripts, keyed by thread id.
 *
 * Transcripts sharing a session id are one agent family. Within a family, each
 * transcript's `Agent(…)` spawn lines claim, in order, the earliest unclaimed
 * transcript that started no earlier than the spawner. Claiming is one-to-one, so
 * leftovers stay top-level and a spawn whose transcript was never captured goes
 * unmatched.
 *
 * Start times are the only ordering the transcripts carry — individual lines have
 * no timestamps — so pairing is positional, not proven. A transcript with no start
 * time is never claimed.
 */
export function linkAgentSessions(sessions: readonly LinkableSession[]): Map<string, SessionAgentLink> {
  const links = new Map<string, SessionAgentLink>();
  for (const s of sessions) links.set(s.threadId, topLevelLink());

  const families = new Map<string, LinkableSession[]>();
  for (const s of sessions) {
    if (!s.sessionId) continue;
    const family = families.get(s.sessionId);
    if (family) family.push(s);
    else families.set(s.sessionId, [s]);
  }

  /** Guard against a cycle: is `id` already somewhere above `of` in the tree? */
  const isAncestor = (id: string, of: LinkableSession): boolean => {
    let at: string | null = of.threadId;
    for (let hops = 0; at && hops <= sessions.length; hops++) {
      if (at === id) return true;
      at = links.get(at)?.parentThreadId ?? null;
    }
    return false;
  };

  for (const family of families.values()) {
    if (family.length < 2) continue;
    const ordered = [...family].sort(
      (a, b) => (a.started ?? '').localeCompare(b.started ?? '') || a.threadId.localeCompare(b.threadId),
    );
    const claimed = new Set<string>();

    // Every transcript is a candidate spawner, so nested subagents link too; going
    // in start order means an outer parent claims before its own children do.
    for (const parent of ordered) {
      const parentLink = links.get(parent.threadId)!;
      for (const spawn of parent.nodes) {
        const agentType = spawnAgentType(spawn);
        if (agentType === null) continue;
        const child = ordered.find(
          (c) =>
            c.threadId !== parent.threadId &&
            !claimed.has(c.threadId) &&
            !!c.started &&
            !!parent.started &&
            c.started >= parent.started &&
            !isAncestor(c.threadId, parent),
        );
        if (!child) continue;
        claimed.add(child.threadId);
        const link = links.get(child.threadId)!;
        link.parentThreadId = parent.threadId;
        link.spawnIndex = spawn.index;
        link.agentType = agentType || null;
        link.returnIndex = returnIndexAfter(parent.nodes, spawn.index);
        link.reported = reportedBack(parent.nodes, spawn.index, link.returnIndex);
        parentLink.childThreadIds.push(child.threadId);
      }
    }
  }

  // Depth is only knowable once every parent is assigned.
  for (const [threadId, link] of links) {
    let depth = 0;
    let at = link.parentThreadId;
    while (at && depth <= links.size) {
      depth += 1;
      at = links.get(at)?.parentThreadId ?? null;
    }
    links.set(threadId, { ...link, depth });
  }

  return links;
}

/**
 * Pull every errored tool result out of a transcript, in order, each tagged with
 * its task and nearest preceding tool call. The proxy records only a one-line
 * gist per error, disconnected from the tool call that produced it (that call is
 * in a prior turn), so this re-links them, blaming each call at most once.
 */
export function parseSessionErrors(content: string): SessionError[] {
  const errors: SessionError[] = [];
  let task: string | null = null;
  let lastTool: string | null = null;

  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');

    const taskMatch = TASK_RE.exec(line);
    if (taskMatch) {
      task = (taskMatch[1] ?? '').trim() || null;
      lastTool = null;
      continue;
    }

    const errorMatch = ERROR_RE.exec(line);
    if (errorMatch) {
      errors.push({ index: errors.length, task, tool: lastTool, text: (errorMatch[1] ?? '').trim() });
      lastTool = null;
      continue;
    }

    const toolMatch = TOOL_RE.exec(line);
    if (toolMatch) lastTool = (toolMatch[2] ?? '').trim();
  }

  return errors;
}

// --- Nodes derived from a captured request ---------------------------------
//
// A transcript is a lossy render of the same `messages[]` a captured request carries:
// `proxy/session.ts` gists every line to 160 chars and every tool arg to 60. Re-running
// the proxy's grammar over the whole body yields the same node stream, same emission
// order, with the text intact.

/** Normalize a message `content` (string | block array) to a block array. */
function asBlocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The transcript's own normalization: every line it records is whitespace-collapsed. */
const collapseWhitespace = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The proxy's `gist` — collapse to one line and cap, cut marked with an `…`. */
function gist(s: unknown, max: number): string {
  const one = collapseWhitespace(String(s ?? ''));
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Drop the harness-injected `<system-reminder>…</system-reminder>` context blocks. */
const stripReminderBlocks = (s: string): string => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');

/** The readable text of a `tool_result` block (string or nested block array). */
function resultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((x) => (typeof x === 'string' ? x : str((x as Record<string, unknown>)?.text))).join(' ');
}

/** Allowlist of identifying tool inputs, in the proxy's precedence order. */
const ARG_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'command',
  'pattern',
  'glob',
  'url',
  'query',
  'subagent_type',
  'skill',
  'cron',
  'description',
  'prompt',
];

/**
 * The one identifying arg the proxy records for a call, uncapped. Still collapsed to a single
 * line: a transcript's tool signature is one line by construction, and consumers rely on it —
 * {@link spawnAgentType}'s signature pattern doesn't match across a newline.
 */
function toolArgs(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const obj = input as Record<string, unknown>;
  for (const k of ARG_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return `${k}=${collapseWhitespace(v)}`;
  }
  const k = Object.keys(obj).find((key) => ['string', 'number', 'boolean'].includes(typeof obj[key]));
  return k ? `${k}=${collapseWhitespace(String(obj[k]))}` : '';
}

/**
 * The thread's conversation root: its first real user text, tool-result-only turns not
 * counting. Mirrors `firstUserText` in `proxy/session.ts`, the string the proxy hashes
 * into a thread id — including its fallback to the first message's serialized content, so
 * a body with no user text hashes to the same id there and here.
 */
export function firstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (const m of messages) {
    if ((m as Record<string, unknown>)?.role !== 'user') continue;
    const text = asBlocks((m as Record<string, unknown>).content)
      .filter((b) => b.type === 'text')
      .map((b) => str(b.text))
      .join(' ')
      .trim();
    if (text) return text;
  }
  const first = messages[0] as Record<string, unknown> | undefined;
  return first ? gist(JSON.stringify(first.content), 200) : '';
}

/**
 * A transcript's node stream derived from a captured request body — the same
 * task/decision/tool/error/done steps {@link parseSessionNodes} reads back, at full text
 * length. A body with no `messages` array yields no nodes.
 *
 * Emission order matches the proxy's: within a user turn, errored tool results come
 * before the task they precede; within an assistant turn, the decision comes before
 * the calls it explains.
 */
export function deriveSessionNodes(body: unknown): SessionNode[] {
  const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const messages = Array.isArray(obj.messages) ? obj.messages : [];

  const nodes: SessionNode[] = [];
  let task: string | null = null;
  let lastTool: string | null = null;
  let pending: InterruptionKind | null = null;
  /** The `messages[]` position being read, carried onto every step it yields. */
  let message = 0;
  /** How many assistant turns have made calls so far — the turn the next call belongs to. */
  let turns = 0;

  const push = (type: SessionNodeType, text: string, tool: string | null) => {
    nodes.push({
      index: nodes.length,
      type,
      text: text.trim(),
      tool,
      task,
      interruption: pending,
      interrupted: false,
      message,
      turn: type === 'tool' ? turns : null,
    });
    pending = null;
  };

  for (let m = 0; m < messages.length; m++) {
    message = m;
    const raw = messages[m];
    const msg = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const blocks = asBlocks(msg.content);

    if (msg.role === 'user') {
      const texts: string[] = [];
      for (const b of blocks) {
        if (b.type === 'text') texts.push(str(b.text));
        else if (b.type === 'tool_result' && b.is_error === true) {
          push('error', resultText(b), lastTool);
          lastTool = null;
        }
      }
      const split = splitInterruption(stripReminderBlocks(texts.join(' ')).trim());
      const next = split.text.trim();
      if (split.kind || next) {
        if (split.kind) {
          const last = nodes[nodes.length - 1];
          if (last) last.interrupted = true;
          pending = split.kind;
        }
        task = next || null;
        lastTool = null;
        push('task', next, null);
      }
      continue;
    }

    if (msg.role !== 'assistant') continue;

    const texts: string[] = [];
    const calls: string[] = [];
    for (const b of blocks) {
      if (b.type === 'text') texts.push(str(b.text));
      else if (b.type === 'tool_use') calls.push(`${str(b.name) || 'tool'}(${toolArgs(b.input)})`);
      // `thinking` is skipped — neither a decision nor an outcome.
    }
    const reasoning = texts.join(' ').trim();

    if (calls.length > 0) {
      if (reasoning) push('decision', reasoning, null);
      for (const sig of calls) {
        lastTool = sig;
        push('tool', sig, sig);
      }
      turns += 1;
    } else if (reasoning) {
      push('done', reasoning, null);
    }
  }

  return nodes;
}

/**
 * Whether `full` is the untruncated original of the transcript line `gisted`. A gist is the
 * line collapsed and, past its cap, cut with an `…` — which for a tool call lands inside the
 * parens rather than at the end, so only whatever precedes it can be matched.
 */
export function isSameStep(gisted: string, full: string): boolean {
  const one = collapseWhitespace(full);
  if (one === gisted) return true;
  const cut = gisted.indexOf('…');
  return cut > 0 && one.startsWith(gisted.slice(0, cut));
}

/** Whether a derived step is the untruncated original of a transcript one. */
const pairs = (step: SessionNode, cand: SessionNode): boolean =>
  cand.type === step.type && isSameStep(step.text, cand.text);

/**
 * How far apart in steps the two streams may drift before the merge stops looking for its
 * place again; past this the transcript carries the rest alone.
 */
const RESYNC_WINDOW = 24;

/**
 * The nearest pairing at or after (`t`, `d`), searched along growing diagonals so the
 * alignment that skips fewest steps on either side wins. Null when the streams don't meet
 * again inside {@link RESYNC_WINDOW}.
 */
function resync(
  transcript: SessionNode[],
  t: number,
  derived: SessionNode[],
  d: number,
): { t: number; d: number } | null {
  for (let span = 1; span < RESYNC_WINDOW; span++) {
    for (let i = 0; i <= span; i++) {
      const ti = t + i;
      const di = d + (span - i);
      if (ti >= transcript.length || di >= derived.length) continue;
      if (pairs(transcript[ti]!, derived[di]!)) return { t: ti, d: di };
    }
  }
  return null;
}

/**
 * Lay request-derived steps over a transcript's. The transcript stays the authority on which
 * steps exist — the agent linkage (spawn/return indices) is built from its positions — so the
 * result is always its length, with the same `index` on every node. Everything else about a
 * step, including which request message it came from, comes from the request.
 *
 * The two are not positionally aligned: a transcript accumulates every request the proxy ever
 * saw, so it carries turns no single body holds (Claude Code's one-shot spinner prompts land
 * mid-thread and shift everything after them), and a step whose text the two record
 * differently pairs with nothing at all. So the walk re-synchronizes rather than running in
 * lockstep: on a mismatch it looks ahead on *both* sides for where the streams meet again,
 * hands the steps in between their transcript text, and carries on from there.
 */
export function mergeSessionNodes(transcript: SessionNode[], derived: SessionNode[]): SessionNode[] {
  if (derived.length === 0) return transcript;

  const merged: SessionNode[] = [];
  let t = 0;
  let d = 0;
  while (t < transcript.length) {
    const step = transcript[t]!;
    const cand = derived[d];
    if (cand && pairs(step, cand)) {
      // Text comes from the request; which steps exist — and where the run was cut —
      // stays the transcript's, since it alone carries the dashboard's own stops. `turn`
      // goes with structure: the two streams number turns off different starting points,
      // so taking one from each side would merge unrelated turns.
      merged.push({
        ...cand,
        index: step.index,
        interruption: step.interruption,
        interrupted: step.interrupted,
        turn: step.turn,
      });
      t += 1;
      d += 1;
      continue;
    }
    const at = resync(transcript, t, derived, d);
    if (!at) break;
    // Unpaired transcript steps keep their gist; unpaired derived steps have no transcript
    // position to sit at, so they go unplaced.
    for (; t < at.t; t++) merged.push(transcript[t]!);
    d = at.d;
  }
  for (; t < transcript.length; t++) merged.push(transcript[t]!);
  return merged;
}

// --- Linking a transcript's errors back into a captured request -------------
//
// A transcript records an error as one gisted line, with no handle on the turn it
// came from. The same turn is a `tool_result` block inside a captured request's
// `messages[]`, and that array position is exactly what the Message details
// drill-down takes — so locating the block gives the error a deep link.

/** Where one errored tool result sits inside a captured request's `messages[]`. */
export interface RequestErrorSite {
  /** Index into the request's `messages[]` — the drill-down handle. */
  messageIndex: number;
  /** The tool result's text, at full length. */
  text: string;
}

/**
 * Every errored tool result a captured request carries, tagged with the message
 * holding it — one entry per block, in the order {@link deriveSessionNodes} emits its
 * `error` nodes. A body with no `messages` array yields none.
 */
export function deriveRequestErrors(body: unknown): RequestErrorSite[] {
  const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const messages = Array.isArray(obj.messages) ? obj.messages : [];

  const sites: RequestErrorSite[] = [];
  messages.forEach((raw, messageIndex) => {
    const msg = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (msg.role !== 'user') return;
    for (const b of asBlocks(msg.content)) {
      if (b.type === 'tool_result' && b.is_error === true) sites.push({ messageIndex, text: resultText(b) });
    }
  });
  return sites;
}

/**
 * Match a transcript's errors to the request messages that hold them, returning one
 * message index per error — `null` where the request has no counterpart.
 *
 * A captured request holds only the turns in flight when it was sent, so the two align
 * as subsequences rather than positionally — a request sent mid-session misses the
 * errors after it, one sent after a compaction the errors before it. Both are walked in
 * order, each site claiming the next transcript line it expands, so a partial overlap
 * links what it covers instead of nothing.
 */
export function linkRequestErrors(
  errors: readonly SessionError[],
  sites: readonly RequestErrorSite[],
): (number | null)[] {
  const linked: (number | null)[] = errors.map(() => null);
  let e = 0;
  for (const site of sites) {
    while (e < errors.length && !isSameStep(errors[e]!.text, site.text)) e += 1;
    if (e >= errors.length) break;
    linked[e] = site.messageIndex;
    e += 1;
  }
  return linked;
}

/** The captured-request message behind one error — the Message details route's two params. */
export interface SessionErrorLink {
  /** The request's file handle, the `$file` route param. */
  file: string;
  /** 0-based position in that request's `messages[]`, the `$index` route param. */
  messageIndex: number;
}

/** A transcript error with the turn it came from, when a captured request still holds it. */
export interface LinkedSessionError extends SessionError {
  link: SessionErrorLink | null;
}
