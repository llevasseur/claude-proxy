/**
 * session — a passive, append-only "Session" transcript per agent.
 *
 * The proxy already sees every request, and every request carries the full
 * running `messages[]` array. That makes the proxy the natural place to keep a
 * durable, external record of what each agent did — a handoff artifact if an
 * agent dies mid-run, and a history that survives the agent's own context
 * compaction. No agent-side hook or tool is needed; it falls out of the wire.
 *
 * Design (all deterministic — no model calls, zero dependencies):
 *   - Identity is per *conversation-root thread*, not per session id. One
 *     `x-claude-code-session-id` carries the main agent, its subagents, and many
 *     tiny one-shot helper calls (title-gen, summaries). The stable per-agent key
 *     is a fingerprint of the first real user message, namespaced by session id.
 *   - The transcript is the sole source of truth: `messages[]` grows
 *     monotonically for a real thread, so each request's new turns are just
 *     `messages.slice(lastSeenCount)`. We distill those and append — never
 *     rewrite or delete.
 *   - One-shot helper calls are filtered by *growth*: a thread's first sighting
 *     is buffered, not written; only when the same thread reappears larger (a
 *     real back-and-forth) do we flush. A thread seen once never gets a file.
 *   - Per-thread progress is mirrored to a `.state.json` sidecar so a proxy
 *     restart resumes where it left off instead of re-appending the history.
 *
 * What a line captures: the task (user prompt), decisions (assistant text before
 * a tool call), tools used (name + a key arg — never the schema or full input),
 * failures (errored tool results), and outcomes (a plain-text assistant turn).
 * It never records the system prompt, tool schemas, tool-result payloads, full
 * assistant prose, or anything redacted.
 *
 * Zero runtime dependencies — Node built-ins only.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Where transcripts live: a `sessions/` dir under the proxy's log dir. */
export const sessionsDir = (logDir) => path.join(logDir, "sessions");

/** Collapse to one line and cap length, so a transcript line stays lean. */
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

/** A small allowlist of tool inputs worth recording — identifying, never bulky.
 * We record at most one, truncated. The full input never lands in the transcript. */
const ARG_KEYS = ["file_path", "notebook_path", "path", "command", "pattern", "glob", "url", "query", "subagent_type", "skill", "cron", "description", "prompt"];

function toolArgs(input) {
  if (!input || typeof input !== "object") return "";
  for (const k of ARG_KEYS) {
    if (typeof input[k] === "string" && input[k].trim()) return `${k}=${gist(input[k], 60)}`;
  }
  const k = Object.keys(input).find((k) => ["string", "number", "boolean"].includes(typeof input[k]));
  return k ? `${k}=${gist(String(input[k]), 60)}` : "";
}

/** The first real user text in a conversation — its stable root. Tool-result-only
 * user turns don't count; we want the human/instruction prompt that seeded the thread. */
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

/** Stable per-agent identity: hash of (session id + conversation root). Namespacing
 * by session id keeps identical prompts in different sessions from colliding. */
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
      // `thinking` is intentionally skipped — it is neither a decision nor an outcome.
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

/** In-memory per-thread progress. Recovered from the `.state.json` sidecar on a
 * cold thread so a restart doesn't re-append what's already on disk. */
const threads = new Map();

/**
 * Observe one request and append any new turns to its thread transcript.
 * Best-effort and side-effecting: a failure here must never break the proxy.
 */
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
    if (total <= entry.count) return; // no growth — a retry or duplicate, nothing new
    const lines = distillMessages(messages.slice(entry.count));

    if (entry.started) {
      if (lines.length) appendLines(mdPath, lines);
      entry.count = total;
      writeState(statePath, entry);
      return;
    }

    // Not yet confirmed a real agent. Buffer the first sighting; a one-shot helper
    // call is seen exactly once and so never reaches disk.
    if (entry.pending === null) {
      entry.pending = [header(threadId, reqJson, sessionId), ...lines];
      entry.count = total;
      return;
    }

    // Growth observed → a real back-and-forth. Flush the buffer plus the new turns.
    appendLines(mdPath, [...entry.pending, ...lines]);
    entry.started = true;
    entry.pending = null;
    entry.count = total;
    writeState(statePath, entry);
  } catch {
    /* best-effort: transcript failures never break the proxy */
  }
}

/** Test seam: forget in-memory thread progress (does not touch disk). */
export function _resetThreads() {
  threads.clear();
}
