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
 *
 * Two header fields name the session for the dashboard: a `subtitle` (the first
 * user prompt, minus its `<system-reminder>` context) known at the first sighting,
 * and a `title` (the CLI's own generated chat title). The title comes from a
 * separate, out-of-band titling request under a different session id, so it's
 * linked back by content and may arrive before or after the thread is confirmed.
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

/** Collapse whitespace to a single line, uncapped (for exact/prefix matching). */
const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Drop the harness-injected `<system-reminder>…</system-reminder>` context blocks. */
const stripReminders = (s) => String(s ?? "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");

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

/**
 * The thread's opening prompt with its `<system-reminder>` context removed and
 * whitespace collapsed. This is the human subtitle, and — because the CLI's
 * titling request wraps this same reminder-free prompt in `<session>` tags — the
 * key used to link an out-of-band title back to its thread.
 */
export function rootPrompt(messages) {
  return collapse(stripReminders(firstUserText(messages)));
}

// --- Session titling (a separate, out-of-band CLI request) -----------------
//
// Claude Code names a chat with its own `/v1/messages` request under a *different*
// session id: a small system prompt asking for a title, a user message wrapping
// the session so far in `<session>…</session>`, and a `{"title": "…"}` reply. It
// shares no id with the conversation, so we link it by content (its `<session>`
// payload opens with the thread's reminder-free root prompt). A user *renaming* a
// chat is local to the CLI and never hits the wire, so only generated titles are
// observable.

/** Anchor on stable phrasing from the titling system prompt (wording may drift). */
const TITLE_SYSTEM_RE = /generate a concise,?\s+sentence-case title/i;

/** True when this request is the CLI asking the model to title a session. */
export function isTitleRequest(reqJson) {
  const sys = reqJson?.system;
  const text =
    typeof sys === "string"
      ? sys
      : Array.isArray(sys)
        ? sys.map((b) => (typeof b === "string" ? b : (b?.text ?? ""))).join(" ")
        : "";
  return TITLE_SYSTEM_RE.test(text);
}

/** The `<session>…</session>` payload a titling request summarizes, collapsed. */
function titledContent(messages) {
  const first = Array.isArray(messages) ? messages[0] : null;
  if (!first) return "";
  const text = asBlocks(first.content).filter((b) => b?.type === "text").map((b) => b.text).join(" ");
  const m = /<session>([\s\S]*?)<\/session>/i.exec(text);
  return collapse(m ? m[1] : "");
}

/** Pull the title out of a `{"title": "…"}` titling reply, or null. */
export function extractTitle(responseText) {
  if (!responseText) return null;
  const m = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(responseText);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

/** A titling `<session>` payload matches a thread when it opens with that thread's root. */
const titleMatches = (content, root) =>
  !!root && !!content && (content === root || content.startsWith(root) || root.startsWith(content));

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

/** The one-time header written when a thread is first confirmed real. Built from
 * ingredients captured at the first sighting, plus the subtitle/title known by
 * flush time (a title that arrives later is appended as its own line instead). */
function header(threadId, entry) {
  const lines = [
    "",
    `# Session ${threadId}`,
    `- model: ${entry.model ?? "unknown"}`,
    `- session: ${entry.sessionId ?? "unknown"}`,
    `- started: ${entry.startedAt ?? new Date().toISOString()}`,
  ];
  if (entry.title) lines.push(`- title: ${gist(entry.title, 120)}`);
  if (entry.root) lines.push(`- subtitle: ${gist(entry.root, 200)}`);
  lines.push("");
  return lines.join("\n");
}

function readState(statePath) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return { count: s.count ?? 0, started: true, pending: null, root: s.root ?? null, title: s.title ?? null, titled: s.titled ?? false };
  } catch {
    return null;
  }
}

function writeState(statePath, entry) {
  try {
    fs.writeFileSync(statePath, JSON.stringify({ count: entry.count, started: entry.started, root: entry.root, title: entry.title, titled: entry.titled }));
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

/** Titles seen before their thread appeared, keyed by titled `<session>` content. */
const pendingTitles = new Map();

/** Link a captured title to the thread it names, writing/deferring as needed. */
function recordTitle(dir, content, title) {
  if (!content || !title) return;
  for (const [threadId, entry] of threads) {
    if (!titleMatches(content, entry.root)) continue;
    entry.title = title;
    // Already flushed to disk → append a standalone title line. Still pending →
    // the title rides into the header when the thread is confirmed.
    if (entry.started && !entry.titled) {
      appendLines(path.join(dir, `${threadId}.md`), [`- title: ${gist(title, 120)}`]);
      entry.titled = true;
      writeState(path.join(dir, `${threadId}.state.json`), entry);
    }
    return;
  }
  pendingTitles.set(content, title); // thread not seen yet — claim it on arrival
}

/** Observe one request (and its decoded reply) and append its new turns.
 * Best-effort: never throws. `responseText` carries the reply so a titling
 * request's `{"title": …}` can be captured. */
export function appendSession({ logDir, reqPath, reqJson, headers, responseText }) {
  try {
    if (!reqPath?.includes("/v1/messages")) return; // only real agent turns
    const messages = reqJson?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const dir = sessionsDir(logDir);

    // A titling request names some *other* thread — capture its reply and link
    // it by content; it's never a transcript turn of its own.
    if (isTitleRequest(reqJson)) {
      recordTitle(dir, titledContent(messages), extractTitle(responseText));
      return;
    }

    const sessionId = firstHeader(headers, "x-claude-code-session-id");
    const threadId = threadIdFor(sessionId, messages);
    if (!threadId) return;

    const mdPath = path.join(dir, `${threadId}.md`);
    const statePath = path.join(dir, `${threadId}.state.json`);

    let entry = threads.get(threadId);
    if (!entry) {
      entry = readState(statePath) ?? { count: 0, started: false, pending: null, root: null, title: null, titled: false };
      threads.set(threadId, entry);
    }

    // Learn the thread's identity from its first sighting: the root prompt (for
    // subtitle + title matching) and the header ingredients.
    if (!entry.root) entry.root = rootPrompt(messages);
    if (entry.model === undefined || entry.model == null) entry.model = reqJson?.model ?? "unknown";
    if (!entry.sessionId) entry.sessionId = sessionId ?? "unknown";
    if (!entry.startedAt) entry.startedAt = new Date().toISOString();
    // Claim a title that arrived before this thread existed.
    if (!entry.title) {
      for (const [content, title] of pendingTitles) {
        if (titleMatches(content, entry.root)) {
          entry.title = title;
          pendingTitles.delete(content);
          break;
        }
      }
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

    // Unconfirmed thread: buffer the first sighting's lines; a one-shot helper is
    // seen once and never reaches disk. The header is built at flush time so a
    // title claimed in between rides into it.
    if (entry.pending === null) {
      entry.pending = lines;
      entry.count = total;
      return;
    }

    // Growth → a real thread. Flush header + buffer + new turns.
    appendLines(mdPath, [header(threadId, entry), ...entry.pending, ...lines]);
    entry.started = true;
    entry.titled = !!entry.title; // the header already carries any known title
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
  pendingTitles.clear();
}
