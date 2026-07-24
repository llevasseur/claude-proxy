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
}

const DECIDED_TEXT_RE = /^- decided:\s*(.*)$/;
const DONE_TEXT_RE = /^- done:\s*(.*)$/;

/**
 * Parse a transcript into its ordered stream of appended nodes (task, decision,
 * tool, error, done), skipping the header. Uses the same line grammar as
 * {@link parseSessionTranscript}; `error` nodes carry the nearest preceding tool
 * call so the graph can show what failed. Order is the file's line order.
 */
export function parseSessionNodes(content: string): SessionNode[] {
  const nodes: SessionNode[] = [];
  let task: string | null = null;
  let lastTool: string | null = null;

  const push = (type: SessionNodeType, text: string, tool: string | null) => {
    nodes.push({ index: nodes.length, type, text: text.trim(), tool, task });
  };

  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");

    const taskMatch = TASK_RE.exec(line);
    if (taskMatch) {
      task = (taskMatch[1] ?? "").trim() || null;
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

/**
 * Untruncated node texts from a transcript's `<threadId>.nodes.jsonl` sidecar,
 * keyed by node index — the whole text behind the gists {@link parseSessionNodes}
 * reads back. Sparse: only nodes whose line dropped something get an entry, and
 * transcripts predating the sidecar have none. Malformed lines are skipped.
 */
export function parseSessionNodeTexts(content: string): Record<number, string> {
  const texts: Record<number, string> = {};
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { i?: unknown; text?: unknown };
      if (typeof row.i === "number" && Number.isInteger(row.i) && row.i >= 0 && typeof row.text === "string") {
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
