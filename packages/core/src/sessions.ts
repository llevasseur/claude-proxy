/**
 * Parse a proxy-written Session transcript (`logs/sessions/<threadId>.md`) into
 * the handful of facts the dashboard lists: which model/session it belongs to,
 * when it started, and how much happened (tasks, decisions, tools, failures).
 *
 * The transcript is produced by `proxy/session.mjs` and has a fixed, line-based
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

const TASK_RE = /^## Task:\s*(.*)$/;
const DECIDED_RE = /^- decided:\s/;
const ERROR_RE = /^- ✗\s(.*)$/;
/** A tool-call line: `- Name(` — distinct from `- decided:` / `- done:` prose. */
const TOOL_RE = /^- ([A-Za-z]\w*\(.*)$/;
/** The dashboard's own cut, written as its own line (see {@link INTERRUPTION_LINE}). */
const INTERRUPTED_RE = /^- interrupted:\s*(.*)$/;

// --- Interruptions ---------------------------------------------------------
//
// A run can be cut off mid-flight two ways, and each leaves a different trace.
// Claude Code's own Esc prepends `[Request interrupted by user]` to the user turn
// that redirected it, so the marker rides in on the *next* task line. A dashboard
// chat stopped through `POST /api/chat/stop` never reaches the wire at all — the
// child is killed — so the server records it itself as an `- interrupted: <why>`
// line. Both mean the same thing to the graph: the step before was cut short, and
// whatever comes next is a new trail rather than a continuation.

/** Why a run stopped mid-flight. */
export type InterruptionKind = "user" | "tool-use" | "stopped" | "timeout" | "limit";

/** Claude Code's marker, prepended to the user turn that interrupted the run. */
const INTERRUPT_MARKER_RE = /^\[Request interrupted by user(?<tool> for tool use)?\]\s*/;

const INTERRUPTION_KINDS = new Set<string>(["user", "tool-use", "stopped", "timeout", "limit"]);

/** Read an `- interrupted:` line's reason; anything unrecognized reads as a plain stop. */
export function interruptionKind(raw: string): InterruptionKind {
  const one = raw.trim().toLowerCase();
  return (INTERRUPTION_KINDS.has(one) ? one : "stopped") as InterruptionKind;
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
  return { kind: m.groups?.tool ? "tool-use" : "user", text: text.slice(m[0].length) };
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
  };

  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");

    const task = TASK_RE.exec(line);
    if (task) {
      meta.tasks += 1;
      if (meta.firstTask === null) meta.firstTask = (task[1] ?? "").trim() || null;
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
        meta.model = (m[1] ?? "").trim() || null;
        continue;
      }
    }
    if (meta.sessionId === null) {
      const m = HEADER_RE.session.exec(line);
      if (m) {
        meta.sessionId = (m[1] ?? "").trim() || null;
        continue;
      }
    }
    if (meta.started === null) {
      const m = HEADER_RE.started.exec(line);
      if (m) {
        meta.started = (m[1] ?? "").trim() || null;
        continue;
      }
    }
    // `- title:` may be written into the header or appended later (the titling
    // request arrives out of band), so it isn't confined to the header block.
    if (meta.title === null) {
      const m = HEADER_RE.title.exec(line);
      if (m) {
        meta.title = (m[1] ?? "").trim() || null;
        continue;
      }
    }
    if (meta.subtitle === null) {
      const m = HEADER_RE.subtitle.exec(line);
      if (m) meta.subtitle = (m[1] ?? "").trim() || null;
    }
  }

  return meta;
}

/** The kinds of appended line a transcript records after its header, in emit order. */
export type SessionNodeType = "task" | "decision" | "tool" | "error" | "done";

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
  /**
   * Set when this step is where the run picked back up after being cut off — the head of
   * a side trail, and the kind of interruption that opened it. Null on an ordinary step.
   */
  interruption: InterruptionKind | null;
  /** True when the run was cut off *at* this step: the interruption landed right after it. */
  interrupted: boolean;
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
 */
export function parseSessionNodes(content: string): SessionNode[] {
  const nodes: SessionNode[] = [];
  let task: string | null = null;
  let lastTool: string | null = null;
  /** An interruption seen but not yet attached — it belongs to the step that resumes. */
  let pending: InterruptionKind | null = null;

  const push = (type: SessionNodeType, text: string, tool: string | null) => {
    nodes.push({ index: nodes.length, type, text: text.trim(), tool, task, interruption: pending, interrupted: false });
    pending = null;
  };

  /** Sever the run here: the last step so far was cut off, and the next one resumes. */
  const cut = (kind: InterruptionKind) => {
    const last = nodes[nodes.length - 1];
    if (last) last.interrupted = true;
    pending = kind;
  };

  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");

    const stopped = INTERRUPTED_RE.exec(line);
    if (stopped) {
      cut(interruptionKind(stopped[1] ?? ""));
      continue;
    }

    const taskMatch = TASK_RE.exec(line);
    if (taskMatch) {
      const split = splitInterruption((taskMatch[1] ?? "").trim());
      if (split.kind) cut(split.kind);
      task = split.text.trim() || null;
      lastTool = null;
      push("task", task ?? "", null);
      continue;
    }

    const decided = DECIDED_TEXT_RE.exec(line);
    if (decided) {
      push("decision", decided[1] ?? "", null);
      continue;
    }

    const done = DONE_TEXT_RE.exec(line);
    if (done) {
      push("done", done[1] ?? "", null);
      continue;
    }

    const errorMatch = ERROR_RE.exec(line);
    if (errorMatch) {
      push("error", errorMatch[1] ?? "", lastTool);
      lastTool = null;
      continue;
    }

    const toolMatch = TOOL_RE.exec(line);
    if (toolMatch) {
      const sig = (toolMatch[1] ?? "").trim();
      lastTool = sig;
      push("tool", sig, sig);
    }
  }

  return nodes;
}

// --- Subagent linkage ------------------------------------------------------
//
// A subagent runs under its parent's session id but with its own conversation
// root, so the proxy writes it as a *separate* transcript (see proxy/session.mjs).
// Nothing on the wire names the pair, so the tree is reconstructed here from the
// parent's `Agent(...)` spawn lines and the group's other transcripts.

/** Tool names whose call spawns a subagent that gets its own transcript. */
const SPAWN_TOOLS = new Set(["Agent", "Task"]);

/** A tool-call signature, split into name and recorded args. */
const TOOL_SIG_RE = /^([A-Za-z]\w*)\((.*)\)$/;
const SUBAGENT_TYPE_RE = /(?:^|,\s*)subagent_type=([^,]*)/;

/**
 * The `subagent_type` a node spawns — `""` when the call recorded no type — or
 * null when the node isn't a spawn at all.
 */
export function spawnAgentType(node: SessionNode): string | null {
  if (node.type !== "tool" || !node.tool) return null;
  const sig = TOOL_SIG_RE.exec(node.tool);
  if (!sig || !SPAWN_TOOLS.has(sig[1] ?? "")) return null;
  return (SUBAGENT_TYPE_RE.exec(sig[2] ?? "")?.[1] ?? "").trim();
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
  /** Subagents spawned by this transcript, in spawn order. */
  childThreadIds: string[];
}

const topLevelLink = (): SessionAgentLink => ({
  parentThreadId: null,
  spawnIndex: null,
  agentType: null,
  returnIndex: null,
  depth: 0,
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
      (a, b) => (a.started ?? "").localeCompare(b.started ?? "") || a.threadId.localeCompare(b.threadId),
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

  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");

    const taskMatch = TASK_RE.exec(line);
    if (taskMatch) {
      task = (taskMatch[1] ?? "").trim() || null;
      lastTool = null;
      continue;
    }

    const errorMatch = ERROR_RE.exec(line);
    if (errorMatch) {
      errors.push({ index: errors.length, task, tool: lastTool, text: (errorMatch[1] ?? "").trim() });
      lastTool = null;
      continue;
    }

    const toolMatch = TOOL_RE.exec(line);
    if (toolMatch) lastTool = (toolMatch[1] ?? "").trim();
  }

  return errors;
}

// --- Nodes derived from a captured request ---------------------------------
//
// A transcript is a lossy render of the same `messages[]` a captured request carries:
// `proxy/session.mjs` gists every line to 160 chars and every tool arg to 60. Re-running
// the proxy's grammar over the whole body yields the same node stream, same emission
// order, with the text intact.

/** Normalize a message `content` (string | block array) to a block array. */
function asBlocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The transcript's own normalization: every line it records is whitespace-collapsed. */
const collapseWhitespace = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The proxy's `gist` — collapse to one line and cap, cut marked with an `…`. */
function gist(s: unknown, max: number): string {
  const one = collapseWhitespace(String(s ?? ""));
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Drop the harness-injected `<system-reminder>…</system-reminder>` context blocks. */
const stripReminderBlocks = (s: string): string => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");

/** The readable text of a `tool_result` block (string or nested block array). */
function resultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((x) => (typeof x === "string" ? x : str((x as Record<string, unknown>)?.text))).join(" ");
}

/** Allowlist of identifying tool inputs, in the proxy's precedence order. */
const ARG_KEYS = [
  "file_path",
  "notebook_path",
  "path",
  "command",
  "pattern",
  "glob",
  "url",
  "query",
  "subagent_type",
  "skill",
  "cron",
  "description",
  "prompt",
];

/**
 * The one identifying arg the proxy records for a call, uncapped. Still collapsed to a single
 * line: a transcript's tool signature is one line by construction, and consumers rely on it —
 * {@link spawnAgentType}'s signature pattern doesn't match across a newline.
 */
function toolArgs(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const obj = input as Record<string, unknown>;
  for (const k of ARG_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return `${k}=${collapseWhitespace(v)}`;
  }
  const k = Object.keys(obj).find((key) => ["string", "number", "boolean"].includes(typeof obj[key]));
  return k ? `${k}=${collapseWhitespace(String(obj[k]))}` : "";
}

/**
 * The thread's conversation root: its first real user text, tool-result-only turns not
 * counting. Mirrors `firstUserText` in `proxy/session.mjs`, the string the proxy hashes
 * into a thread id — including its fallback to the first message's serialized content, so
 * a body with no user text hashes to the same id there and here.
 */
export function firstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const m of messages) {
    if ((m as Record<string, unknown>)?.role !== "user") continue;
    const text = asBlocks((m as Record<string, unknown>).content)
      .filter((b) => b.type === "text")
      .map((b) => str(b.text))
      .join(" ")
      .trim();
    if (text) return text;
  }
  const first = messages[0] as Record<string, unknown> | undefined;
  return first ? gist(JSON.stringify(first.content), 200) : "";
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
  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const messages = Array.isArray(obj.messages) ? obj.messages : [];

  const nodes: SessionNode[] = [];
  let task: string | null = null;
  let lastTool: string | null = null;
  let pending: InterruptionKind | null = null;

  const push = (type: SessionNodeType, text: string, tool: string | null) => {
    nodes.push({ index: nodes.length, type, text: text.trim(), tool, task, interruption: pending, interrupted: false });
    pending = null;
  };

  for (const raw of messages) {
    const msg = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const blocks = asBlocks(msg.content);

    if (msg.role === "user") {
      const texts: string[] = [];
      for (const b of blocks) {
        if (b.type === "text") texts.push(str(b.text));
        else if (b.type === "tool_result" && b.is_error === true) {
          push("error", resultText(b), lastTool);
          lastTool = null;
        }
      }
      const split = splitInterruption(stripReminderBlocks(texts.join(" ")).trim());
      const next = split.text.trim();
      if (split.kind || next) {
        if (split.kind) {
          const last = nodes[nodes.length - 1];
          if (last) last.interrupted = true;
          pending = split.kind;
        }
        task = next || null;
        lastTool = null;
        push("task", next, null);
      }
      continue;
    }

    if (msg.role !== "assistant") continue;

    const texts: string[] = [];
    const calls: string[] = [];
    for (const b of blocks) {
      if (b.type === "text") texts.push(str(b.text));
      else if (b.type === "tool_use") calls.push(`${str(b.name) || "tool"}(${toolArgs(b.input)})`);
      // `thinking` is skipped — neither a decision nor an outcome.
    }
    const reasoning = texts.join(" ").trim();

    if (calls.length > 0) {
      if (reasoning) push("decision", reasoning, null);
      for (const sig of calls) {
        lastTool = sig;
        push("tool", sig, sig);
      }
    } else if (reasoning) {
      push("done", reasoning, null);
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
  const cut = gisted.indexOf("…");
  return cut > 0 && one.startsWith(gisted.slice(0, cut));
}

/**
 * Lay request-derived steps over a transcript's. The transcript stays the authority on which
 * steps exist — the agent linkage (spawn/return indices) is built from its positions — so the
 * result is always its length, with the same `index` on every node.
 *
 * The two are not positionally aligned: a transcript accumulates every request the proxy ever
 * saw, so it carries turns no single body holds (Claude Code's one-shot spinner prompts land
 * mid-thread and shift everything after them). A captured request is therefore a
 * *subsequence* — take a derived step only where it matches the transcript line it expands,
 * and otherwise keep the transcript's abbreviated text.
 */
export function mergeSessionNodes(transcript: SessionNode[], derived: SessionNode[]): SessionNode[] {
  if (derived.length === 0) return transcript;

  const merged: SessionNode[] = [];
  let d = 0;
  for (const step of transcript) {
    const cand = derived[d];
    if (cand && cand.type === step.type && isSameStep(step.text, cand.text)) {
      // Text comes from the request; which steps exist — and where the run was cut —
      // stays the transcript's, since it alone carries the dashboard's own stops.
      merged.push({ ...cand, index: step.index, interruption: step.interruption, interrupted: step.interrupted });
      d += 1;
    } else {
      merged.push(step);
    }
  }
  return merged;
}
