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
  /**
   * A short name condensed from the opening prompt, for the many transcripts the CLI
   * never titles — see {@link deriveSessionName}. Always subordinate to {@link title}.
   */
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
// A `- title:` line only exists when Claude Code issued its out-of-band titling
// request, and it only does that for interactive chats: a dashboard-started run is
// headless (`claude --print`) and a subagent shares its parent's session id, so
// neither is ever titled. Those transcripts would otherwise list as a bare hex id,
// even though their opening prompt says plainly what they are. So condense that
// prompt here, in the same sentence-case shape the CLI's own titles use.

/**
 * A slash command reaches the wire wrapped in an envelope — `<command-message>`,
 * `<command-name>`, `<command-args>`, and then the whole command definition inlined.
 * The command and its arguments are the session's real name; the definition that
 * follows is boilerplate identical across every run of it.
 */
const COMMAND_NAME_RE = /<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/i;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/i;
/** The caveat the CLI prepends to a locally-run command, and the leftover envelope tags. */
const COMMAND_NOISE_RE = /<local-command-caveat>[\s\S]*?<\/local-command-caveat>|<\/?command-[a-z-]+>/gi;

/** Drop the envelope. A prompt cut mid-caveat never closes its tag, so take that shape too. */
const stripCommandNoise = (s: string): string =>
  s.replace(COMMAND_NOISE_RE, "").replace(/<local-command-caveat>[\s\S]*$/i, "");

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
 * to name. A slash command names itself (`/task fix the flaky test`); anything else has
 * its leading filler dropped and its first sentence kept. Either way the result is
 * capped at {@link NAME_WORDS} words / {@link NAME_CHARS} chars, an `…` marking the cut.
 *
 * The first word is capitalized only when it is purely letters, so a prompt opening on
 * a path, a flag or a backticked command (`src/api.ts`, `--watch`, `` `pnpm test` ``) is
 * left exactly as typed.
 */
export function deriveSessionName(prompt: string | null): string | null {
  if (!prompt) return null;

  // Transcripts predating the reminder-free subtitle open with an injected context
  // blob, and one truncated mid-block never closes its tag — drop both shapes.
  let text = prompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<system-reminder>[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  // A slash command: name it by the command and its arguments, not by the definition
  // inlined after them, which is identical for every run of that command.
  const command = COMMAND_NAME_RE.exec(text);
  if (command) {
    const args = COMMAND_ARGS_RE.exec(text)?.[1] ?? "";
    const named = stripCommandNoise(`${command[1]} ${args}`).replace(/\s+/g, " ").trim();
    return capped(named);
  }
  text = stripCommandNoise(text).replace(/\s+/g, " ").trim();

  // Filler can stack ("ok so please …"), so peel until nothing more comes off.
  for (let i = 0; i < 3; i++) {
    const stripped = text.replace(LEAD_FILLER_RE, "");
    if (stripped === text) break;
    text = stripped;
  }

  const end = SENTENCE_END_RE.exec(text);
  if (end && end.index > 0) text = text.slice(0, end.index);
  return capped(text.trim());
}

/**
 * Cut a one-line string down to a name: {@link NAME_WORDS} words and {@link NAME_CHARS}
 * chars at most, an `…` marking either cut, sentence-cased when its first word is one.
 * Null when there's nothing left to show.
 */
function capped(text: string): string | null {
  if (!text) return null;

  const words = text.split(" ");
  let cut = words.length > NAME_WORDS;
  let name = words.slice(0, NAME_WORDS).join(" ");
  if (name.length > NAME_CHARS) {
    name = name.slice(0, NAME_CHARS).trimEnd();
    cut = true;
  }
  if (!name) return null;

  // Sentence case, but never on a path/flag/quoted command — those stay as typed.
  if (/^[a-z]+$/.test(words[0] ?? "")) name = name[0]!.toUpperCase() + name.slice(1);
  return cut ? `${name}…` : name;
}

/**
 * The most human name a transcript offers, in falling order of authority: the CLI's
 * own title, the name derived from its opening prompt, then that prompt itself. Null
 * when the transcript says nothing about itself and only its id is left.
 */
export function sessionName(meta: SessionMeta): string | null {
  return meta.title ?? meta.derivedTitle ?? meta.subtitle ?? meta.firstTask;
}

/**
 * {@link sessionName} with the thread id as the last resort — the single answer to
 * "what is this session called" wherever a name is required rather than optional.
 * The listing, the graph and a suggestion's sources all read it from here.
 */
export function sessionDisplayName(meta: SessionMeta): string {
  return sessionName(meta) ?? meta.threadId;
}

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
    derivedTitle: null,
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

  // The subtitle is the opening prompt already stripped of reminders; the first task
  // is the same prompt raw, for transcripts written before subtitles existed.
  meta.derivedTitle = deriveSessionName(meta.subtitle ?? meta.firstTask);
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

  const push = (type: SessionNodeType, text: string, tool: string | null) => {
    nodes.push({ index: nodes.length, type, text: text.trim(), tool, task });
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
      const next = stripReminderBlocks(texts.join(" ")).trim();
      if (next) {
        task = next;
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
      merged.push({ ...cand, index: step.index });
      d += 1;
    } else {
      merged.push(step);
    }
  }
  return merged;
}
