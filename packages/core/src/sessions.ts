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
}

/**
 * One errored tool result pulled from a transcript, with the context needed to
 * make sense of it in isolation: the task it happened under and the tool call it
 * most likely came from. The `text` is the proxy's already-gisted `- ✗ …` line.
 */
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
      if (m) meta.started = (m[1] ?? "").trim() || null;
    }
  }

  return meta;
}

/**
 * Pull every errored tool result out of a transcript, in order, each tagged with
 * the task it fell under and the tool call it most likely came from. The proxy
 * records only a one-line gist per error and disconnects it from its tool call
 * (the call is in a prior assistant turn), so this single pass re-links them: it
 * tracks the current `## Task:` heading and the nearest preceding tool-call line,
 * attributing that line to the next error and then clearing it so a second error
 * in a row isn't blamed on the same call.
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
