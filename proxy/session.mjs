/**
 * session — a passive, append-only transcript per agent, built from the wire.
 *
 * Every request carries the full running `messages[]`, so the proxy can keep a
 * durable record of what each agent did with no agent-side hook. Deterministic,
 * Node built-ins only.
 *
 * Design:
 *   - Identity is per conversation-root thread, not per session id: one session
 *     id carries the main agent, its subagents, and one-shot helpers, so a thread
 *     is keyed by (session id + fingerprint of its first user message).
 *   - `messages[]` grows monotonically, so each request's new turns are
 *     `messages.slice(lastSeenCount)` — we distill and append, never rewrite.
 *   - One-shot helpers are filtered by growth: a thread's first sighting is
 *     buffered, and only flushed once it reappears larger. Seen once → no file.
 *   - Per-thread progress mirrors to a `.state.json` sidecar so a restart resumes
 *     instead of re-appending.
 *
 * A line captures the task, a decision (assistant text before a tool call), a
 * tool used (name + one key arg), a failure (errored tool result), or an outcome.
 * Never the system prompt, tool schemas, tool-result payloads, or full prose.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sessionsDir = (logDir) => path.join(logDir, "sessions");

/** Collapse to one line and cap length. */
const gist = (s, max = 160) => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
};

/** Normalize a message `content` (string | block array) to a block array. */
const asBlocks = (content) =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? content
      : [];

const firstHeader = (h, k) => {
  const v = (h ?? {})[k];
  return (Array.isArray(v) ? v[0] : v) ?? null;
};

/** Pull the readable text out of a tool_result block (string or block array). */
function resultText(b) {
  const c = b?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x?.type === "text" ? x.text : "")).join(" ");
  return "";
}

/** Allowlist of identifying tool inputs; at most one is recorded, truncated. */
const ARG_KEYS = ["file_path", "notebook_path", "path", "command", "pattern", "glob", "url", "query", "subagent_type", "skill", "cron", "description", "prompt"];

function toolArgs(input) {
  if (!input || typeof input !== "object") return "";
  for (const k of ARG_KEYS) {
    if (typeof input[k] === "string" && input[k].trim()) return `${k}=${gist(input[k], 60)}`;
  }
  const k = Object.keys(input).find((k) => ["string", "number", "boolean"].includes(typeof input[k]));
  return k ? `${k}=${gist(String(input[k]), 60)}` : "";
}

/** First real user text — the thread's root. Tool-result-only turns don't count. */
export function firstUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (const m of messages) {
    if (m?.role !== "user") continue;
    const t = asBlocks(m.content).filter((b) => b?.type === "text").map((b) => b.text).join(" ").trim();
    if (t) return t;
  }
  const first = messages[0];
  return first ? gist(JSON.stringify(first.content), 200) : "";
}

/** Per-agent identity: hash of (session id + conversation root). */
export function threadIdFor(sessionId, messages) {
  const root = firstUserText(messages);
  if (!root) return null;
  return crypto.createHash("sha256").update(`${sessionId ?? ""}\n${root}`).digest("hex").slice(0, 16);
}

/** Distill one message into zero or more transcript lines (deterministic). */
export function distillMessage(msg) {
  const lines = [];
  const blocks = asBlocks(msg?.content);

  if (msg?.role === "user") {
    const texts = [];
    for (const b of blocks) {
      if (b?.type === "text") texts.push(b.text);
      else if (b?.type === "tool_result" && b.is_error) lines.push(`- ✗ ${gist(resultText(b), 120)}`);
    }
    const task = texts.join(" ").trim();
    if (task) lines.push(`\n## Task: ${gist(task, 200)}`);
    return lines;
  }

  if (msg?.role === "assistant") {
    const texts = [];
    const toolLines = [];
    for (const b of blocks) {
      if (b?.type === "text") texts.push(b.text);
      else if (b?.type === "tool_use") toolLines.push(`- ${b.name ?? "tool"}(${toolArgs(b.input)})`);
      // `thinking` is skipped — neither a decision nor an outcome.
    }
    const reasoning = texts.join(" ").trim();
    if (toolLines.length) {
      if (reasoning) lines.push(`- decided: ${gist(reasoning)}`);
      lines.push(...toolLines);
    } else if (reasoning) {
      lines.push(`- done: ${gist(reasoning)}`);
    }
  }
  return lines;
}

/** Distill a run of new messages (the delta since we last looked). */
export function distillMessages(delta) {
  return (Array.isArray(delta) ? delta : []).flatMap(distillMessage);
}

/** The one-time header written when a thread is first confirmed real. */
function header(threadId, reqJson, sessionId) {
  return [
    "",
    `# Session ${threadId}`,
    `- model: ${reqJson?.model ?? "unknown"}`,
    `- session: ${sessionId ?? "unknown"}`,
    `- started: ${new Date().toISOString()}`,
    "",
  ].join("\n");
}

function readState(statePath) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return { count: s.count ?? 0, started: true, pending: null };
  } catch {
    return null;
  }
}

function writeState(statePath, entry) {
  try {
    fs.writeFileSync(statePath, JSON.stringify({ count: entry.count, started: entry.started }));
  } catch {
    /* best-effort */
  }
}

function appendLines(mdPath, lines) {
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.appendFileSync(mdPath, lines.join("\n") + "\n");
}

/** In-memory per-thread progress, recovered from the `.state.json` sidecar. */
const threads = new Map();

/** Observe one request and append its new turns. Best-effort: never throws. */
export function appendSession({ logDir, reqPath, reqJson, headers }) {
  try {
    if (!reqPath?.includes("/v1/messages")) return; // only real agent turns
    const messages = reqJson?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const sessionId = firstHeader(headers, "x-claude-code-session-id");
    const threadId = threadIdFor(sessionId, messages);
    if (!threadId) return;

    const dir = sessionsDir(logDir);
    const mdPath = path.join(dir, `${threadId}.md`);
    const statePath = path.join(dir, `${threadId}.state.json`);

    let entry = threads.get(threadId);
    if (!entry) {
      entry = readState(statePath) ?? { count: 0, started: false, pending: null };
      threads.set(threadId, entry);
    }

    const total = messages.length;
    if (total <= entry.count) return; // no growth — retry or duplicate
    const lines = distillMessages(messages.slice(entry.count));

    if (entry.started) {
      if (lines.length) appendLines(mdPath, lines);
      entry.count = total;
      writeState(statePath, entry);
      return;
    }

    // Unconfirmed thread: buffer the first sighting; a one-shot helper is seen
    // once and never reaches disk.
    if (entry.pending === null) {
      entry.pending = [header(threadId, reqJson, sessionId), ...lines];
      entry.count = total;
      return;
    }

    // Growth → a real thread. Flush the buffer plus the new turns.
    appendLines(mdPath, [...entry.pending, ...lines]);
    entry.started = true;
    entry.pending = null;
    entry.count = total;
    writeState(statePath, entry);
  } catch {
    /* best-effort */
  }
}

/** Test seam: forget in-memory thread progress (does not touch disk). */
export function _resetThreads() {
  threads.clear();
}
