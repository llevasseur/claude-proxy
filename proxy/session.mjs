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

/** The recorded arg as it goes on the line (`shown`) and in full (`full`). */
function toolArgs(input) {
  const both = (k, v) => ({ shown: `${k}=${gist(v, 60)}`, full: `${k}=${collapse(v)}` });
  if (!input || typeof input !== "object") return { shown: "", full: "" };
  for (const k of ARG_KEYS) {
    if (typeof input[k] === "string" && input[k].trim()) return both(k, input[k]);
  }
  const k = Object.keys(input).find((k) => ["string", "number", "boolean"].includes(typeof input[k]));
  return k ? both(k, String(input[k])) : { shown: "", full: "" };
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
 * The thread's opening prompt, reminders stripped and whitespace collapsed — the
 * subtitle, and the key that links an out-of-band title back to its thread.
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

/**
 * Distill one message into zero or more transcript entries (deterministic).
 *
 * Each entry is one line for the transcript plus the untruncated text behind it —
 * null when the gist already says the whole thing. Every entry is exactly one node
 * of the graph, in order, so the sidecar {@link appendNodeTexts} writes lines up
 * with what `parseSessionNodes` reads back.
 */
export function distillEntries(msg) {
  const entries = [];
  const blocks = asBlocks(msg?.content);
  /** `whole` was truncated iff its collapsed form isn't what the line carries. */
  const push = (line, whole, shown) => entries.push({ line, full: collapse(whole) === shown ? null : String(whole).trim() });

  if (msg?.role === "user") {
    const texts = [];
    for (const b of blocks) {
      if (b?.type === "text") texts.push(b.text);
      else if (b?.type === "tool_result" && b.is_error) {
        const err = resultText(b);
        push(`- ✗ ${gist(err, 120)}`, err, gist(err, 120));
      }
    }
    const task = stripReminders(texts.join(" ")).trim();
    if (task) push(`\n## Task: ${gist(task, 200)}`, task, gist(task, 200));
    return entries;
  }

  if (msg?.role === "assistant") {
    const texts = [];
    const tools = [];
    for (const b of blocks) {
      if (b?.type === "text") texts.push(b.text);
      else if (b?.type === "tool_use") {
        const args = toolArgs(b.input);
        const name = b.name ?? "tool";
        // A tool node's text *is* its signature, so the full form is the signature rebuilt.
        tools.push({ line: `- ${name}(${args.shown})`, full: args.shown === args.full ? null : `${name}(${args.full})` });
      }
      // `thinking` is skipped — neither a decision nor an outcome.
    }
    const reasoning = texts.join(" ").trim();
    if (tools.length) {
      if (reasoning) push(`- decided: ${gist(reasoning)}`, reasoning, gist(reasoning));
      entries.push(...tools);
    } else if (reasoning) {
      push(`- done: ${gist(reasoning)}`, reasoning, gist(reasoning));
    }
  }
  return entries;
}

/** Distill one message into zero or more transcript lines (deterministic). */
export function distillMessage(msg) {
  return distillEntries(msg).map((e) => e.line);
}

/** Distill a run of new messages (the delta since we last looked). */
export function distillMessages(delta) {
  return distillMessagesEntries(delta).map((e) => e.line);
}

/** {@link distillMessages}, keeping each line's untruncated text. */
export function distillMessagesEntries(delta) {
  return (Array.isArray(delta) ? delta : []).flatMap(distillEntries);
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
    return { count: s.count ?? 0, started: true, pending: null, root: s.root ?? null, title: s.title ?? null, titled: s.titled ?? false, subtitled: s.subtitled ?? false, nodes: typeof s.nodes === "number" ? s.nodes : null };
  } catch {
    return null;
  }
}

function writeState(statePath, entry) {
  try {
    fs.writeFileSync(statePath, JSON.stringify({ count: entry.count, started: entry.started, root: entry.root, title: entry.title, titled: entry.titled, subtitled: entry.subtitled, nodes: entry.nodes }));
  } catch {
    /* best-effort */
  }
}

function appendLines(mdPath, lines) {
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.appendFileSync(mdPath, lines.join("\n") + "\n");
}

// --- Untruncated node text -------------------------------------------------
//
// Transcript lines are one-line gists, so anything long lands with a `…`. The
// whole text goes to a sidecar instead of the transcript, which stays a digest
// the summary pipeline can read cheaply. One JSON line per node that has more to
// show — `{"i": <node index>, "text": "…"}` — appended as the transcript grows.

const nodeTextsPath = (dir, threadId) => path.join(dir, `${threadId}.nodes.jsonl`);

/**
 * The transcript lines `parseSessionNodes` turns into nodes, mirrored here so the
 * sidecar's indices line up with the ones the dashboard parses. The two grammars
 * are pinned together by a cross-check test in `packages/core`.
 */
const NODE_LINE_RE = /^(?:## Task:|- decided:|- done:|- ✗\s|- [A-Za-z]\w*\()/;

/** How many nodes a transcript's text holds. */
export function countNodeLines(content) {
  let n = 0;
  for (const raw of String(content ?? "").split("\n")) {
    if (NODE_LINE_RE.test(raw.replace(/\r$/, ""))) n += 1;
  }
  return n;
}

/**
 * Record the untruncated text behind each new line, keyed by node index, and
 * advance the thread's node count. State written by an older proxy carries no
 * count, so it's recovered once by counting the transcript already on disk.
 */
function appendNodeTexts(dir, threadId, entry, mdPath, entries) {
  if (entry.nodes === null || entry.nodes === undefined) {
    try {
      entry.nodes = countNodeLines(fs.readFileSync(mdPath, "utf8"));
    } catch {
      entry.nodes = 0; // no transcript yet — this append starts at zero
    }
  }
  const rows = [];
  entries.forEach((e, i) => {
    if (e.full !== null) rows.push(JSON.stringify({ i: entry.nodes + i, text: e.full }));
  });
  entry.nodes += entries.length;
  if (!rows.length) return;
  try {
    fs.mkdirSync(dir, { recursive: true }); // the transcript's own dir may not exist yet
    fs.appendFileSync(nodeTextsPath(dir, threadId), rows.join("\n") + "\n");
  } catch {
    /* best-effort */
  }
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
      entry = readState(statePath) ?? { count: 0, started: false, pending: null, root: null, title: null, titled: false, subtitled: false, nodes: 0 };
      threads.set(threadId, entry);
    }

    // Learn the thread's identity from its first sighting: the root prompt (for
    // subtitle + title matching) and the header ingredients.
    if (!entry.root) entry.root = rootPrompt(messages);
    if (entry.model == null) entry.model = reqJson?.model ?? "unknown";
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

    // Root learned only now, after the write-once header was flushed without it
    // (older proxy, or restart from state predating `root`): append it standalone.
    if (entry.started && !entry.subtitled && entry.root) {
      appendLines(mdPath, [`- subtitle: ${gist(entry.root, 200)}`]);
      entry.subtitled = true;
      writeState(statePath, entry);
    }

    const total = messages.length;
    if (total <= entry.count) return; // no growth — retry or duplicate
    const entries = distillMessagesEntries(messages.slice(entry.count));

    if (entry.started) {
      if (entries.length) {
        appendNodeTexts(dir, threadId, entry, mdPath, entries); // counts the transcript as it stands
        appendLines(mdPath, entries.map((e) => e.line));
      }
      entry.count = total;
      writeState(statePath, entry);
      return;
    }

    // Unconfirmed thread: buffer the first sighting's lines; a one-shot helper is
    // seen once and never reaches disk. The header is built at flush time so a
    // title claimed in between rides into it.
    if (entry.pending === null) {
      entry.pending = entries;
      entry.count = total;
      return;
    }

    // Growth → a real thread. Flush header + buffer + new turns.
    const flushed = [...entry.pending, ...entries];
    appendNodeTexts(dir, threadId, entry, mdPath, flushed);
    appendLines(mdPath, [header(threadId, entry), ...flushed.map((e) => e.line)]);
    entry.started = true;
    entry.titled = !!entry.title; // the header already carries any known title
    entry.subtitled = !!entry.root; // the header already carries any known subtitle
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
