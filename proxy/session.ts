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
 *     A client declaring itself interactive is exempt, by header
 *     (`x-claude-proxy-chat: 1`) or by a `.chat/<session id>.json` marker for a
 *     client that cannot set one.
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
 * linked back by content and may arrive before or after the thread is confirmed —
 * or before this process even started, which a `.pending-titles.json` sidecar keeps
 * claimable across a restart.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  asArrayOf,
  type ContentBlock,
  firstHeader,
  type HeaderBag,
  type RequestBody,
  type WireMessage,
} from './wire.ts';

/** One distilled transcript line, plus the untruncated text behind it (null when
 * the line already says the whole thing). */
export interface TranscriptEntry {
  line: string;
  full: string | null;
}

/** Per-thread progress, held in memory and mirrored to `<threadId>.state.json`. */
interface ThreadEntry {
  count: number;
  started: boolean;
  pending: TranscriptEntry[] | null;
  root: string | null;
  title: string | null;
  titled: boolean;
  subtitled: boolean;
  /** Null until recovered — state written by an older proxy carries no count. */
  nodes: number | null;
  lastSeen: number;
  model?: string;
  sessionId?: string;
  startedAt?: string;
}

export const sessionsDir = (logDir: string): string => path.join(logDir, 'sessions');

/**
 * Marks the first `tool_use` of an assistant message, so a batch of calls issued in one
 * turn reads as one marked line plus the unmarked run under it. `packages/core` mirrors
 * this constant (`TURN_MARKER` in `sessions.ts`) rather than sharing it — this file has no
 * dependencies by design — and a cross-check test there pins the two grammars together.
 */
const TURN_MARKER = '▸';

/** Collapse to one line and cap length. */
const gist = (s: unknown, max = 160): string => {
  const one = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** Collapse whitespace to a single line, uncapped (for exact/prefix matching). */
const collapse = (s: unknown): string =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** Drop the harness-injected `<system-reminder>…</system-reminder>` context blocks. */
const stripReminders = (s: unknown): string =>
  String(s ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');

/** Normalize a message `content` (string | block array) to a block array. */
const asBlocks = (content: unknown): ContentBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : asArrayOf<ContentBlock>(content);

/**
 * A client declaring itself an interactive chat (the dashboard's `POST /api/chat/*`).
 * Such a thread is a real conversation from its first turn, so it is exempt from the
 * growth filter that suppresses one-shot helpers. Claude Code never sends this header.
 */
const isInteractiveChat = (headers: HeaderBag | undefined): boolean =>
  firstHeader(headers, 'x-claude-proxy-chat') === '1';

/** Marker files the dashboard writes to declare a session id interactive. */
export const chatMarkersDir = (logDir: string): string => path.join(logDir, '.chat');

/**
 * The same exemption, claimed out-of-band. A dashboard chat carried by a headless
 * Claude Code process cannot add a header — the CLI builds its own — so the server
 * announces the session id as a file before it spawns, and this reads it back.
 */
const isDeclaredChat = (logDir: string, sessionId: string | null): boolean => {
  if (!sessionId) return false;
  try {
    return fs.existsSync(path.join(chatMarkersDir(logDir), `${sessionId}.json`));
  } catch {
    return false;
  }
};

/** Pull the readable text out of a tool_result block (string or block array). */
function resultText(b: ContentBlock | undefined): string {
  const c = b?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((x) => (typeof x === 'string' ? x : x?.type === 'text' ? (x.text ?? '') : '')).join(' ');
  }
  return '';
}

/** Allowlist of identifying tool inputs; at most one is recorded, truncated. */
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

/** The recorded arg as it goes on the line (`shown`) and in full (`full`). */
function toolArgs(input: unknown): { shown: string; full: string } {
  const both = (k: string, v: unknown) => ({ shown: `${k}=${gist(v, 60)}`, full: `${k}=${collapse(v)}` });
  if (!input || typeof input !== 'object') return { shown: '', full: '' };
  const record = input as Record<string, unknown>;
  for (const k of ARG_KEYS) {
    const v = record[k];
    if (typeof v === 'string' && v.trim()) return both(k, v);
  }
  const k = Object.keys(record).find((key) => ['string', 'number', 'boolean'].includes(typeof record[key]));
  return k ? both(k, String(record[k])) : { shown: '', full: '' };
}

/** First real user text — the thread's root. Tool-result-only turns don't count. */
export function firstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (const m of messages as WireMessage[]) {
    if (m?.role !== 'user') continue;
    const t = asBlocks(m.content)
      .filter((b) => b?.type === 'text')
      .map((b) => b.text ?? '')
      .join(' ')
      .trim();
    if (t) return t;
  }
  const first = (messages as WireMessage[])[0];
  return first ? gist(JSON.stringify(first.content), 200) : '';
}

/** Per-agent identity: hash of (session id + conversation root). */
export function threadIdFor(sessionId: string | null | undefined, messages: unknown): string | null {
  const root = firstUserText(messages);
  if (!root) return null;
  return crypto
    .createHash('sha256')
    .update(`${sessionId ?? ''}\n${root}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * The thread's opening prompt, reminders stripped and whitespace collapsed — the
 * subtitle, and the key that links an out-of-band title back to its thread.
 */
export function rootPrompt(messages: unknown): string {
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
export function isTitleRequest(reqJson: RequestBody | null | undefined): boolean {
  const sys = reqJson?.system;
  const text =
    typeof sys === 'string'
      ? sys
      : Array.isArray(sys)
        ? sys.map((b) => (typeof b === 'string' ? b : ((b as ContentBlock)?.text ?? ''))).join(' ')
        : '';
  return TITLE_SYSTEM_RE.test(text);
}

/** The `<session>…</session>` payload a titling request summarizes, collapsed. */
function titledContent(messages: unknown): string {
  const first = Array.isArray(messages) ? (messages[0] as WireMessage | undefined) : null;
  if (!first) return '';
  const text = asBlocks(first.content)
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join(' ');
  const m = /<session>([\s\S]*?)<\/session>/i.exec(text);
  return collapse(m?.[1] ?? '');
}

/** Pull the title out of a `{"title": "…"}` titling reply, or null. */
export function extractTitle(responseText: string | null | undefined): string | null {
  if (!responseText) return null;
  const m = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(responseText);
  if (!m) return null;
  const raw = m[1] ?? '';
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** A titling `<session>` payload matches a thread when it opens with that thread's root. */
const titleMatches = (content: string | null, root: string | null | undefined): boolean =>
  !!root && !!content && (content === root || content.startsWith(root) || root.startsWith(content));

/**
 * Distill one message into zero or more transcript entries (deterministic). Each
 * entry is one transcript line plus the untruncated text behind it — null when the
 * line already says the whole thing. One entry per graph node, in order, so the
 * sidecar's indices match what `parseSessionNodes` reads back.
 */
export function distillEntries(msg: WireMessage | undefined | null): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const blocks = asBlocks(msg?.content);
  /** `whole` was truncated iff its collapsed form isn't what the line carries. */
  const push = (line: string, whole: unknown, shown: string) =>
    entries.push({ line, full: collapse(whole) === shown ? null : String(whole).trim() });

  if (msg?.role === 'user') {
    const texts: string[] = [];
    for (const b of blocks) {
      if (b?.type === 'text') texts.push(b.text ?? '');
      else if (b?.type === 'tool_result' && b.is_error) {
        const err = resultText(b);
        push(`- ✗ ${gist(err, 120)}`, err, gist(err, 120));
      }
    }
    const task = stripReminders(texts.join(' ')).trim();
    if (task) push(`\n## Task: ${gist(task, 200)}`, task, gist(task, 200));
    return entries;
  }

  if (msg?.role === 'assistant') {
    const texts: string[] = [];
    const tools: TranscriptEntry[] = [];
    for (const b of blocks) {
      if (b?.type === 'text') texts.push(b.text ?? '');
      else if (b?.type === 'tool_use') {
        const args = toolArgs(b.input);
        const name = b.name ?? 'tool';
        // Only this message's *first* call is marked, so the reader can tell calls that went
        // out together from calls that each cost a round-trip. `full` stays the bare
        // signature: a tool node's text *is* its signature, the marker is line grammar.
        tools.push({
          line: `- ${tools.length === 0 ? `${TURN_MARKER} ` : ''}${name}(${args.shown})`,
          full: args.shown === args.full ? null : `${name}(${args.full})`,
        });
      }
      // `thinking` is skipped — neither a decision nor an outcome.
    }
    const reasoning = texts.join(' ').trim();
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
export function distillMessage(msg: WireMessage | undefined | null): string[] {
  return distillEntries(msg).map((e) => e.line);
}

/** Distill a run of new messages (the delta since we last looked). */
export function distillMessages(delta: unknown): string[] {
  return distillMessagesEntries(delta).map((e) => e.line);
}

/** {@link distillMessages}, keeping each line's untruncated text. */
export function distillMessagesEntries(delta: unknown): TranscriptEntry[] {
  return asArrayOf<WireMessage>(delta).flatMap(distillEntries);
}

/** The one-time header written when a thread is first confirmed real. Built from
 * ingredients captured at the first sighting, plus the subtitle/title known by
 * flush time (a title that arrives later is appended as its own line instead). */
function header(threadId: string, entry: ThreadEntry): string {
  const lines = [
    '',
    `# Session ${threadId}`,
    `- model: ${entry.model ?? 'unknown'}`,
    `- session: ${entry.sessionId ?? 'unknown'}`,
    `- started: ${entry.startedAt ?? new Date().toISOString()}`,
  ];
  if (entry.title) lines.push(`- title: ${gist(entry.title, 120)}`);
  if (entry.root) lines.push(`- subtitle: ${gist(entry.root, 200)}`);
  lines.push('');
  return lines.join('\n');
}

/** The `.state.json` sidecar as it comes off disk — every field may be missing. */
type StoredState = Partial<Record<keyof ThreadEntry, unknown>>;

function readState(statePath: string): ThreadEntry | null {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8')) as StoredState;
    return {
      count: (s.count as number) ?? 0,
      started: true,
      pending: null,
      root: (s.root as string | null) ?? null,
      title: (s.title as string | null) ?? null,
      titled: (s.titled as boolean) ?? false,
      subtitled: (s.subtitled as boolean) ?? false,
      nodes: typeof s.nodes === 'number' ? s.nodes : null,
      lastSeen: typeof s.lastSeen === 'number' ? s.lastSeen : 0,
    };
  } catch {
    return null;
  }
}

function writeState(statePath: string, entry: StoredState): void {
  try {
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        count: entry.count,
        started: entry.started,
        root: entry.root,
        title: entry.title,
        titled: entry.titled,
        subtitled: entry.subtitled,
        nodes: entry.nodes,
        lastSeen: entry.lastSeen ?? 0,
      }),
    );
  } catch {
    /* best-effort */
  }
}

function appendLines(mdPath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.appendFileSync(mdPath, `${lines.join('\n')}\n`);
}

// --- Untruncated node text -------------------------------------------------
//
// Transcript lines are one-line gists, so anything long lands with a `…`. The whole
// text goes to a sidecar instead, keeping the transcript a digest the summary
// pipeline can read cheaply. One JSON line per node that has more to show —
// `{"i": <node index>, "text": "…"}` — appended as the transcript grows.

const nodeTextsPath = (dir: string, threadId: string): string => path.join(dir, `${threadId}.nodes.jsonl`);

/**
 * The transcript lines `parseSessionNodes` turns into nodes, mirrored here so the
 * sidecar's indices match the dashboard's. A cross-check test in `packages/core`
 * pins the two grammars together.
 */
const NODE_LINE_RE = /^(?:## Task:|- decided:|- done:|- ✗\s|- (?:▸ )?[A-Za-z]\w*\()/;

/** How many nodes a transcript's text holds. */
export function countNodeLines(content: unknown): number {
  let n = 0;
  for (const raw of String(content ?? '').split('\n')) {
    if (NODE_LINE_RE.test(raw.replace(/\r$/, ''))) n += 1;
  }
  return n;
}

/**
 * Record the untruncated text behind each new line, keyed by node index, and
 * advance the thread's node count. State written by an older proxy carries no
 * count, so it's recovered once by counting the transcript already on disk.
 */
function appendNodeTexts(
  dir: string,
  threadId: string,
  entry: ThreadEntry,
  mdPath: string,
  entries: TranscriptEntry[],
): void {
  if (entry.nodes === null || entry.nodes === undefined) {
    try {
      entry.nodes = countNodeLines(fs.readFileSync(mdPath, 'utf8'));
    } catch {
      entry.nodes = 0; // no transcript yet
    }
  }
  const base = entry.nodes;
  const rows: string[] = [];
  entries.forEach((e, i) => {
    if (e.full !== null) rows.push(JSON.stringify({ i: base + i, text: e.full }));
  });
  entry.nodes = base + entries.length;
  if (!rows.length) return;
  try {
    fs.mkdirSync(dir, { recursive: true }); // the transcript's own dir may not exist yet
    fs.appendFileSync(nodeTextsPath(dir, threadId), `${rows.join('\n')}\n`);
  } catch {
    /* best-effort */
  }
}

/** In-memory per-thread progress, recovered from the `.state.json` sidecar. */
const threads = new Map<string, ThreadEntry>();

/**
 * A thread's last sighting, in epoch ms but never repeating: titles are matched by
 * recency, and two threads seen inside the same millisecond would tie. Nudging forward
 * keeps every sighting orderable while staying a real timestamp on disk.
 */
let lastTick = 0;
function nowSeen(): number {
  lastTick = Math.max(Date.now(), lastTick + 1);
  return lastTick;
}

/** Titles seen before their thread appeared, keyed by titled `<session>` content. */
const pendingTitles = new Map<string, string>();

/** Where unclaimed titles wait out a proxy restart. Dot-prefixed: not a transcript. */
const pendingPath = (dir: string): string => path.join(dir, '.pending-titles.json');

/** How many unclaimed titles the sidecar keeps — newest win; an old one is never claimed. */
const PENDING_LIMIT = 50;

/** The sessions dir whose sidecar is already folded into {@link pendingTitles}. */
let pendingLoadedFrom: string | null = null;

/** Fold the sidecar in once per dir, so a title that outlived a restart is still claimable. */
function loadPendingTitles(dir: string): void {
  if (pendingLoadedFrom === dir) return;
  pendingLoadedFrom = dir;
  try {
    const rows: unknown = JSON.parse(fs.readFileSync(pendingPath(dir), 'utf8'));
    for (const row of asArrayOf<{ content?: unknown; title?: unknown }>(rows)) {
      if (typeof row?.content === 'string' && typeof row?.title === 'string' && !pendingTitles.has(row.content)) {
        pendingTitles.set(row.content, row.title);
      }
    }
  } catch {
    /* no sidecar yet */
  }
}

/** Mirror the unclaimed titles to disk, oldest dropped past {@link PENDING_LIMIT}. */
function savePendingTitles(dir: string): void {
  try {
    while (pendingTitles.size > PENDING_LIMIT) {
      const oldest = pendingTitles.keys().next().value;
      if (oldest === undefined) break;
      pendingTitles.delete(oldest);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      pendingPath(dir),
      JSON.stringify([...pendingTitles].map(([content, title]) => ({ content, title }))),
    );
  } catch {
    /* best-effort */
  }
}

/** Write a title onto a thread this process is following. */
function titleThread(dir: string, threadId: string, entry: ThreadEntry, title: string): void {
  entry.title = title;
  // Already flushed to disk → append a standalone title line. Still pending →
  // the title rides into the header when the thread is confirmed.
  if (entry.started && !entry.titled) {
    appendLines(path.join(dir, `${threadId}.md`), [`- title: ${gist(title, 120)}`]);
    entry.titled = true;
    writeState(path.join(dir, `${threadId}.state.json`), entry);
  }
}

/**
 * Title a thread that exists only on disk, written before this process started. Picks
 * the most recently written untitled match and returns whether it found one.
 */
function titleDiskThread(dir: string, content: string, title: string): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }

  let best: { threadId: string; statePath: string; state: StoredState; at: number } | null = null;
  for (const name of names) {
    const m = /^([0-9a-f]{16})\.state\.json$/.exec(name);
    const threadId = m?.[1];
    if (!threadId || threads.has(threadId)) continue; // in-memory threads already had their turn
    const statePath = path.join(dir, name);
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as StoredState;
      if (state.title || !titleMatches(content, state.root as string | null)) continue;
      const at = fs.statSync(statePath).mtimeMs;
      if (!best || at > best.at) best = { threadId, statePath, state, at };
    } catch {
      /* unreadable sidecar — skip it */
    }
  }
  if (!best) return false;

  appendLines(path.join(dir, `${best.threadId}.md`), [`- title: ${gist(title, 120)}`]);
  writeState(best.statePath, { ...best.state, title, titled: true });
  return true;
}

/**
 * Link a captured title to the thread it names, writing/deferring as needed.
 *
 * The match is by content, which is not unique: the same opening prompt run twice
 * yields two threads. Already-titled matches are skipped and the most recently active
 * untitled one wins; failing that the thread is on disk only, or not yet seen.
 */
function recordTitle(dir: string, content: string, title: string | null): void {
  if (!content || !title) return;

  const untitled = [...threads]
    .filter(([, entry]) => !entry.title && titleMatches(content, entry.root))
    .sort((a, b) => (b[1].lastSeen ?? 0) - (a[1].lastSeen ?? 0));
  const first = untitled[0];
  if (first) {
    const [threadId, entry] = first;
    titleThread(dir, threadId, entry, title);
    return;
  }

  if (titleDiskThread(dir, content, title)) return;

  loadPendingTitles(dir);
  pendingTitles.set(content, title); // thread not seen yet — claim it on arrival
  savePendingTitles(dir);
}

/** One observed request: the body, who sent it, and the reply it drew. */
export interface AppendSessionInput {
  logDir: string;
  reqPath?: string;
  reqJson?: RequestBody | null;
  headers?: HeaderBag;
  responseText?: string | null;
}

/** Observe one request (and its decoded reply) and append its new turns.
 * Best-effort: never throws. `responseText` carries the reply so a titling
 * request's `{"title": …}` can be captured. */
export function appendSession({ logDir, reqPath, reqJson, headers, responseText }: AppendSessionInput): void {
  try {
    if (!reqPath?.includes('/v1/messages')) return; // only real agent turns
    const messages = reqJson?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const dir = sessionsDir(logDir);

    // A titling request names some *other* thread — capture its reply and link
    // it by content; it's never a transcript turn of its own.
    if (isTitleRequest(reqJson)) {
      recordTitle(dir, titledContent(messages), extractTitle(responseText));
      return;
    }

    const sessionId = firstHeader(headers, 'x-claude-code-session-id');
    const threadId = threadIdFor(sessionId, messages);
    if (!threadId) return;

    const mdPath = path.join(dir, `${threadId}.md`);
    const statePath = path.join(dir, `${threadId}.state.json`);

    let entry = threads.get(threadId);
    if (!entry) {
      entry = readState(statePath) ?? {
        count: 0,
        started: false,
        pending: null,
        root: null,
        title: null,
        titled: false,
        subtitled: false,
        nodes: 0,
        lastSeen: 0,
      };
      threads.set(threadId, entry);
    }
    // Which thread a title belongs to is decided by recency, so every sighting counts.
    entry.lastSeen = nowSeen();

    // Learn the thread's identity from its first sighting: the root prompt (for
    // subtitle + title matching) and the header ingredients.
    if (!entry.root) entry.root = rootPrompt(messages);
    if (entry.model == null) entry.model = typeof reqJson?.model === 'string' ? reqJson.model : 'unknown';
    if (!entry.sessionId) entry.sessionId = sessionId ?? 'unknown';
    if (!entry.startedAt) entry.startedAt = new Date().toISOString();
    // Claim a title that arrived before this thread existed, including one the sidecar
    // carried across a restart.
    if (!entry.title) {
      loadPendingTitles(dir);
      for (const [content, title] of pendingTitles) {
        if (titleMatches(content, entry.root)) {
          entry.title = title;
          pendingTitles.delete(content);
          savePendingTitles(dir);
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
        appendNodeTexts(dir, threadId, entry, mdPath, entries); // before the lines land — it counts the transcript as it stands
        appendLines(
          mdPath,
          entries.map((e) => e.line),
        );
      }
      entry.count = total;
      writeState(statePath, entry);
      return;
    }

    // Unconfirmed thread: buffer the first sighting's lines; a one-shot helper is
    // seen once and never reaches disk. The header is built at flush time so a
    // title claimed in between rides into it. An interactive chat needs no proof
    // of growth — it is confirmed on sight.
    if (entry.pending === null && !isInteractiveChat(headers) && !isDeclaredChat(logDir, sessionId)) {
      entry.pending = entries;
      entry.count = total;
      return;
    }

    // Growth (or a declared chat) → a real thread. Flush header + buffer + new turns.
    const flushed = [...(entry.pending ?? []), ...entries];
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
export function _resetThreads(): void {
  threads.clear();
  pendingTitles.clear();
  pendingLoadedFrom = null; // a restart re-reads the sidecar; so does a test
}
