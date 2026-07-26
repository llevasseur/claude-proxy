/**
 * chat — the package's one outbound path, over either of two transports. Both send
 * to the **proxy's** base URL rather than `api.anthropic.com`, so the proxy captures
 * a dashboard chat as it captures a CLI turn: audit sidecar, context table, and an
 * append-only Session transcript. There is no second logging path.
 *
 *   - `cli` (default, local dev): a headless Claude Code process, which authenticates
 *     itself from the device's own login. The server holds no credential — see
 *     `chat-cli.ts`.
 *   - `api` (for a deployment): a direct streamed `POST /v1/messages` carrying
 *     `ANTHROPIC_API_KEY`, in the request shape Claude Code sends. The proxy forwards
 *     credentials and never supplies them, so this transport needs its own key.
 *
 * The `cli` transport runs in one of two modes. `agent` (the default) is a full
 * Claude Code session at parity with the device's own — its tools run and its custom
 * slash commands work, so **a dashboard prompt can change this repo**; the flags come
 * from the user's real `claude` alias, read off the shell rc. `chat` is the sandboxed
 * posture: no tools, no customizations, a scratch cwd. `api` is always `chat` — a
 * bare `/v1/messages` call has no harness to run a tool with.
 *
 * A thread id is read back from the transcript the proxy wrote, never predicted: the
 * proxy fingerprints a thread from the *wire* text of its first user message, which
 * under the CLI carries harness context this side never sees.
 *
 * Sessions live in memory only; the durable record is the proxy's transcript, so a
 * restart drops the ability to *continue* a chat, never its history.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { INTERRUPTION_LINE } from "@claude-proxy/core";
import {
  type AgentLaunchFlags,
  type ChatMode,
  type CliInterruption,
  type CliRunHandle,
  type CliToolUse,
  DEFAULT_AGENT_FLAGS,
  findOnPath,
  resolveAgentCwd,
  resolveCliCwd,
  runCliTurn,
} from "./chat-cli.js";
import { listSessions, resolveSessionsDir } from "./sessions.js";
import { readLaunchAliases } from "./shell-rc.js";

const ANTHROPIC_VERSION = "2023-06-01";

/** Defaults, each overridable per env. */
const DEFAULT_BASE_URL = "http://127.0.0.1:8787"; // the proxy's own default PORT
const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TOKENS = 64_000;
const DEFAULT_CLI_PATH = "claude";
const DEFAULT_SYSTEM =
  "You are Claude, answering in a chat started from the claude-proxy dashboard. " +
  "Be direct and concise.";
/** Appended to Claude Code's own prompt in agent mode, never replacing it. */
const DEFAULT_AGENT_SYSTEM =
  "You are running as an agent started from the claude-proxy dashboard, in this " +
  "repository's checkout. Be direct and concise.";

/** The shell alias an agent turn mirrors; the user's everyday `claude`. */
const DEFAULT_AGENT_ALIAS = "claude";

/**
 * The standing answers a `--print` child can be pinned to, since it has no one to ask.
 * They are not degrees of the same thing — what each does to a *command* differs:
 *
 *   - `default` — every gated tool asks, and asking fails in a `--print` child, so a
 *     Bash command that isn't already allowed by settings is denied.
 *   - `acceptEdits` — file edits are pre-approved; Bash is **not**, so every command
 *     that would have prompted is auto-denied.
 *   - `bypassPermissions` — nothing is asked and nothing is denied: commands run,
 *     including git writes.
 *   - `plan` — read-only; the turn plans and does not act.
 */
export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Commands included; the default the start form opens on, so `/task` runs as-is. */
const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

const MAX_PROMPT_CHARS = 100_000;

/**
 * Read a positive integer out of the environment, falling back on anything else.
 *
 * `Number("")` is `0` and a typo is `NaN`; `setTimeout` treats both as ~1ms, so an
 * unguarded clock below would end every turn the instant it started.
 */
const envInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * The `api` transport's cap on one `POST /v1/messages`. Total elapsed is the right shape
 * here: it bounds a single HTTP request/response, not a body of work.
 */
const REQUEST_TIMEOUT_MS = envInt(process.env.CHAT_TIMEOUT_MS, 300_000);

/**
 * The `cli` transport's two caps, which are deliberately not the one above. A CLI turn is
 * a whole agent loop and normally outlasts any single request, so the child is judged on
 * whether it is still *producing*; only the ceiling is absolute.
 *
 * `CHAT_TIMEOUT_MS` still sets the idle window, so a deployment that tuned it keeps its
 * value — now spent per silence rather than per turn.
 */
const CLI_IDLE_TIMEOUT_MS = envInt(process.env.CHAT_IDLE_TIMEOUT_MS, envInt(process.env.CHAT_TIMEOUT_MS, 300_000));
const CLI_MAX_TURN_MS = envInt(process.env.CHAT_MAX_TURN_MS, 3_600_000);

/** How long to wait for the proxy to write the transcript the id is read from. */
const THREAD_WAIT_MS = 5_000;
const THREAD_POLL_MS = 150;

/** Markers older than this are swept whenever a chat starts. */
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ChatTransport = "cli" | "api";

export type { ChatMode };

/** What an agent turn inherits from the device, reported to the dashboard. */
export interface AgentConfig {
  /** The only directory an agent turn can reach. */
  cwd: string;
  /** The shell alias being mirrored, and whether it was actually found. */
  alias: string;
  aliasFound: boolean;
  /** Where the alias was looked for, and whether that file could be read. */
  rcPath: string;
  rcReadable: boolean;
  /** The flags replayed onto the child, as parsed from that alias. */
  flags: AgentLaunchFlags;
  /** The standing answer to permission prompts a headless child can't be asked. */
  permissionMode: PermissionMode;
}

/** The resolved configuration a chat runs with — surfaced by `GET /api/chat/config`. */
export interface ChatConfig {
  /** Which outbound path a chat takes. */
  transport: ChatTransport;
  /** The posture new turns default to. `agent` can act; `chat` cannot. */
  mode: ChatMode;
  /** Resolved device parity for agent turns; null when the transport can't run them. */
  agent: AgentConfig | null;
  /** Where the request is sent: the proxy, not `api.anthropic.com`. */
  baseUrl: string;
  model: string;
  maxTokens: number;
  system: string;
  anthropicVersion: string;
  /** The `anthropic-beta` header value, or null when none is sent (`api` only). */
  beta: string | null;
  /** `api` cannot start a chat without it. */
  apiKeySet: boolean;
  /** The command `cli` spawns, and where it resolved to — null when not installed. */
  cliPath: string;
  cliFound: string | null;
  /** Whether a chat can start at all, and what is missing when it can't. */
  ready: boolean;
  readyHint: string | null;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** Billed usage, read off the turn's usage events. */
export interface ChatUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

interface ChatSession {
  /** The session id this chat runs under — the proxy's session key, and the CLI's. */
  id: string;
  /** The proxy's transcript id, read back from the transcript; null until it exists. */
  threadId: string | null;
  transport: ChatTransport;
  /** Fixed when the chat starts: a chat that could not act must not gain that power
   * on its second turn, and vice versa. */
  mode: ChatMode;
  /** The device posture resolved at start; null in `chat` mode. Pinned for the same
   * reason — editing the shell rc mid-chat must not re-arm a running agent. */
  agent: AgentConfig | null;
  model: string;
  maxTokens: number;
  system: string;
  createdAt: string;
  /** The conversation as the dashboard shows it. Replayed on the wire by `api` only —
   * the CLI keeps its own history and is resumed instead. */
  messages: AnthropicMessage[];
  /** Turns already sent; the CLI resumes rather than opens once this is non-zero. */
  sent: number;
  /** The turn in flight, so `stopChat` can end it; null between turns. */
  run: CliRunHandle | null;
  /** When the turn in flight began; null between turns. */
  runStartedAt: string | null;
  /** What the child reported it was running under, once one has said. */
  effectivePermissionMode: string | null;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string }[];
}

export interface ChatSendResult {
  session: {
    id: string;
    threadId: string | null;
    model: string;
    createdAt: string;
    transport: ChatTransport;
    mode: ChatMode;
    /** The permission answer pinned at start; null outside `agent` mode. */
    permissionMode: string | null;
    /**
     * The mode the child reported on startup. Normally identical to `permissionMode`;
     * a difference means the request never reached the child as asked — a server
     * running older code, say — which is worth seeing rather than inferring from
     * a turn full of denials.
     */
    effectivePermissionMode: string | null;
  };
  reply: string;
  usage: ChatUsage;
  turns: ChatTurn[];
  /** Tools this turn ran. Always empty in `chat` mode, which has none. */
  tools: CliToolUse[];
  /** Set when the turn was stopped, went quiet, or hit its ceiling — what follows is the partial reply. */
  interrupted: CliInterruption | null;
}

/** Live chats, keyed by session id. Lost on restart; the transcript is not. */
const sessions = new Map<string, ChatSession>();

/**
 * `CHAT_BASE_URL` wins; otherwise `ANTHROPIC_BASE_URL`, which on a device set up
 * per the README already points at the running proxy.
 */
export function resolveChatBaseUrl(): string {
  const raw = process.env.CHAT_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/** `cli` unless `CHAT_TRANSPORT` says otherwise: local dev should not need a key. */
export function resolveChatTransport(raw = process.env.CHAT_TRANSPORT): ChatTransport {
  return raw?.trim().toLowerCase() === "api" ? "api" : "cli";
}

/** `agent` unless `CHAT_MODE=chat` asks for the sandboxed posture. */
export function resolveChatMode(raw = process.env.CHAT_MODE): ChatMode {
  return raw?.trim().toLowerCase() === "chat" ? "chat" : "agent";
}

/**
 * Read the device's own `claude` alias and turn it into the flags an agent turn
 * replays — the alias is the user's real launch posture.
 *
 * A missing alias or unreadable rc is not an error: it means a bare `claude`, which
 * is still parity. `aliasFound` reports which of the two happened.
 */
export async function resolveAgentConfig(): Promise<AgentConfig> {
  const alias = process.env.CHAT_AGENT_ALIAS ?? DEFAULT_AGENT_ALIAS;
  const { rcPath, rcReadable, aliases } = await readLaunchAliases();
  const match = aliases.find((a) => a.name === alias);

  return {
    cwd: resolveAgentCwd(),
    alias,
    aliasFound: !!match,
    rcPath,
    rcReadable,
    flags: match
      ? {
          disallowedTools: match.withheld,
          settingSources: match.settingSources,
          settingsOverrides: match.settingsOverrides,
        }
      : DEFAULT_AGENT_FLAGS,
    permissionMode: resolveDefaultPermissionMode(process.env.CHAT_AGENT_PERMISSION_MODE),
  };
}

/**
 * `CHAT_AGENT_PERMISSION_MODE`, validated. An unrecognized value warns and falls back
 * rather than propagating to the CLI and the form's select.
 */
function resolveDefaultPermissionMode(raw: string | undefined): PermissionMode {
  const value = raw?.trim();
  if (!value) return DEFAULT_PERMISSION_MODE;
  if ((PERMISSION_MODES as readonly string[]).includes(value)) return value as PermissionMode;
  console.warn(
    `[chat] ignoring CHAT_AGENT_PERMISSION_MODE=${value}: expected one of ${PERMISSION_MODES.join(", ")} — using ${DEFAULT_PERMISSION_MODE}`,
  );
  return DEFAULT_PERMISSION_MODE;
}

export async function resolveChatConfig(): Promise<ChatConfig> {
  const transport = resolveChatTransport();
  const mode = resolveChatMode();
  const cliPath = process.env.CHAT_CLI_PATH ?? DEFAULT_CLI_PATH;
  const cliFound = transport === "cli" ? findOnPath(cliPath) : null;
  const apiKeySet = !!process.env.ANTHROPIC_API_KEY;
  // Only the CLI transport can be an agent — `api` is a bare `/v1/messages` call
  // with no harness to run tools or expand a slash command.
  const agent = transport === "cli" ? await resolveAgentConfig() : null;

  const readyHint =
    transport === "api"
      ? mode === "agent"
        ? "agent mode needs the cli transport — unset CHAT_TRANSPORT=api, or set CHAT_MODE=chat"
        : apiKeySet
          ? null
          : "set ANTHROPIC_API_KEY — the proxy forwards credentials, it never supplies them"
      : cliFound
        ? null
        : `install Claude Code, or point CHAT_CLI_PATH at it (${cliPath} is not on PATH)`;

  return {
    transport,
    mode,
    agent,
    baseUrl: resolveChatBaseUrl(),
    model: process.env.CHAT_MODEL ?? DEFAULT_MODEL,
    maxTokens: envInt(process.env.CHAT_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    system: process.env.CHAT_SYSTEM ?? (mode === "agent" ? DEFAULT_AGENT_SYSTEM : DEFAULT_SYSTEM),
    anthropicVersion: ANTHROPIC_VERSION,
    beta: process.env.CHAT_BETA ?? null,
    apiKeySet,
    cliPath,
    cliFound,
    ready: !readyHint,
    readyHint,
  };
}

function normalizePrompt(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("invalid prompt: expected a string");
  const prompt = raw.trim();
  if (!prompt) throw new Error("invalid prompt: empty");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`invalid prompt: longer than ${MAX_PROMPT_CHARS} characters`);
  }
  return prompt;
}

const textMessage = (role: "user" | "assistant", text: string): AnthropicMessage => ({
  role,
  content: [{ type: "text", text }],
});

const publicSession = (s: ChatSession): ChatSendResult["session"] => ({
  id: s.id,
  threadId: s.threadId,
  model: s.model,
  createdAt: s.createdAt,
  transport: s.transport,
  mode: s.mode,
  permissionMode: s.agent?.permissionMode ?? null,
  effectivePermissionMode: s.effectivePermissionMode,
});

const turnsOf = (s: ChatSession): ChatTurn[] =>
  s.messages.map((m) => ({ role: m.role, text: m.content.map((b) => b.text).join("\n") }));

// --- Declaring a chat to the proxy ------------------------------------------
//
// The proxy buffers a thread's first sighting and only writes it once the thread
// reappears larger, so one-shot helpers leave no transcript. An interactive chat
// needs no such proof, and the `api` transport says so with `x-claude-proxy-chat`.
// The CLI cannot be made to send that header, so the exemption is claimed
// out-of-band instead: a marker file per session id, which the proxy checks.

/** Marker files live beside the store, not inside `sessions/` — that dir is watched. */
export const chatMarkersDir = (logDir: string): string => path.join(logDir, ".chat");

/** Announce a session id as an interactive chat. Best-effort: a miss only delays
 * the transcript to the second turn. */
export function declareChatSession(logDir: string, sessionId: string): void {
  const dir = chatMarkersDir(logDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ declaredAt: new Date().toISOString() }));
    pruneChatMarkers(dir);
  } catch {
    /* best-effort */
  }
}

function pruneChatMarkers(dir: string, now = Date.now()): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (now - fs.statSync(full).mtimeMs > MARKER_TTL_MS) fs.rmSync(full, { force: true });
    }
  } catch {
    /* best-effort */
  }
}

/**
 * The transcript's own id for this chat, read back from what the proxy wrote. The
 * proxy hashes the first user message *as it went over the wire*, which the CLI
 * wraps in harness context, so this cannot be computed here. Returns null while the
 * thread is still buffered — a first turn under the `api`-style growth filter.
 */
export async function resolveThreadId(logDir: string, sessionId: string, waitMs = THREAD_WAIT_MS): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    // listSessions is newest-first, so a session id reused across threads resolves
    // to the one still being written.
    const match = (await listSessions(logDir)).find((s) => s.sessionId === sessionId);
    if (match) return match.threadId;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, THREAD_POLL_MS));
  }
}

/**
 * Record that this turn was cut short, as a line on the thread's own transcript.
 *
 * A dashboard **Stop** kills the child before it answers, so — unlike Claude Code's
 * Esc, which prepends `[Request interrupted by user]` to the next turn and rides in
 * over the wire — nothing about it ever reaches the proxy. The transcript is the only
 * durable record (chat sessions are in-memory), so the server appends the fact itself.
 *
 * Append-only and best-effort, matching how the proxy writes: the proxy tracks its own
 * progress by message count rather than file offset, so an extra line can't desync it.
 * A thread whose transcript hasn't been flushed yet is skipped rather than created —
 * a headerless file would parse as a session with no model, session id, or start time.
 */
export function recordInterruption(logDir: string, threadId: string, why: CliInterruption): void {
  const file = path.join(resolveSessionsDir(logDir), `${threadId}.md`);
  try {
    if (!fs.existsSync(file)) return;
    fs.appendFileSync(file, `${INTERRUPTION_LINE(why)}\n`);
  } catch {
    /* best-effort — a chat turn is not worth failing over a transcript write */
  }
}

// --- The `api` transport ----------------------------------------------------

/** The subset of a streamed `/v1/messages` event this path reads. */
interface StreamEvent {
  type?: string;
  delta?: { text?: string };
  message?: { usage?: Record<string, unknown> };
  usage?: Record<string, unknown>;
  error?: { message?: string };
}

/**
 * Reassemble a streamed reply: concatenated text deltas plus billed usage. Non-text
 * blocks can't occur here — no tools are sent — so text is the whole reply.
 */
export function decodeChatStream(raw: string): { text: string; usage: ChatUsage } {
  const usage: ChatUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let text = "";
  let apiError: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const payload = /^data:\s?(.*)$/.exec(line)?.[1];
    if (!payload?.trim() || payload === "[DONE]") continue;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(payload) as StreamEvent;
    } catch {
      continue;
    }
    if (ev.type === "content_block_delta" && typeof ev.delta?.text === "string") text += ev.delta.text;
    else if (ev.type === "message_start" && ev.message?.usage) applyUsage(usage, ev.message.usage);
    else if (ev.type === "message_delta" && ev.usage) applyUsage(usage, ev.usage);
    else if (ev.type === "error") apiError = ev.error?.message ?? "unknown streaming error";
  }

  // A stream can carry an error event after a 200.
  if (apiError && !text) throw new Error(`anthropic stream error: ${apiError}`);
  return { text, usage };
}

function applyUsage(into: ChatUsage, u: Record<string, unknown>): void {
  if (typeof u.input_tokens === "number") into.input = u.input_tokens;
  if (typeof u.output_tokens === "number") into.output = u.output_tokens;
  if (typeof u.cache_read_input_tokens === "number") into.cacheRead = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === "number") into.cacheCreation = u.cache_creation_input_tokens;
}

/** Headers a chat request carries — Claude Code's identifying set, minus its auth. */
function chatHeaders(config: ChatConfig, apiKey: string, sessionId: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": config.anthropicVersion,
    // Read back by `extractSession` in proxy.mjs; "cli"/"cli-bg" stay Claude Code's.
    "x-app": "dashboard",
    // The proxy keys a transcript thread by (this header + the first user message).
    "x-claude-code-session-id": sessionId,
    // Exempts the thread from the proxy's one-shot growth filter, so the transcript
    // exists after the first turn.
    "x-claude-proxy-chat": "1",
    "user-agent": "claude-proxy-dashboard/0.1.0",
  };
  if (config.beta) headers["anthropic-beta"] = config.beta;
  return headers;
}

async function postTurn(config: ChatConfig, session: ChatSession): Promise<{ text: string; usage: ChatUsage }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error(`chat is not configured: ${config.readyHint ?? "missing ANTHROPIC_API_KEY"}`);

  const body = {
    model: session.model,
    max_tokens: session.maxTokens,
    system: session.system,
    // The whole running conversation, which is what the proxy rebuilds a transcript from.
    messages: session.messages,
    stream: true,
    metadata: { user_id: JSON.stringify({ session_id: session.id }) },
  };

  const url = `${config.baseUrl}/v1/messages`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: chatHeaders(config, apiKey, session.id),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = (err as Error).message;
    throw new Error(`chat request to ${url} failed (${reason}) — is the proxy running on that port?`);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`chat request rejected: HTTP ${res.status} ${raw.slice(0, 500)}`.trim());
  }
  return decodeChatStream(raw);
}

// --- Dispatch ---------------------------------------------------------------

/** What a turn produced, whichever transport carried it. */
interface TurnResult {
  text: string;
  usage: ChatUsage;
  tools: CliToolUse[];
  interrupted: CliInterruption | null;
  /** The CLI's own session id, which only exists once the child got that far. */
  cliSessionId: string | null;
  /** What the child said it was running under; null when it never got that far. */
  permissionMode: string | null;
}

async function runTurn(config: ChatConfig, session: ChatSession, prompt: string): Promise<TurnResult> {
  if (session.transport === "api") {
    return { ...(await postTurn(config, session)), tools: [], interrupted: null, cliSessionId: null, permissionMode: null };
  }
  if (!config.cliFound) throw new Error(`chat is not configured: ${config.readyHint}`);

  const agent = session.mode === "agent" ? session.agent : null;
  try {
    const turn = await runCliTurn({
      cliPath: config.cliFound,
      // An agent works in the repo; a chat is kept out of it entirely.
      cwd: agent ? agent.cwd : resolveCliCwd(process.env.CHAT_CLI_CWD),
      baseUrl: config.baseUrl,
      mode: session.mode,
      model: session.model,
      system: session.system,
      sessionId: session.id,
      resume: session.sent > 0,
      prompt,
      idleTimeoutMs: CLI_IDLE_TIMEOUT_MS,
      maxTurnMs: CLI_MAX_TURN_MS,
      agentFlags: agent?.flags,
      permissionMode: agent?.permissionMode,
      // The handle `stopChat` reaches through while the child runs. The timestamp rides
      // along so a session page can say how long the turn it is offering to stop has run.
      onStart: (run) => {
        session.run = run;
        session.runStartedAt = new Date().toISOString();
      },
      // The child's own answer, available while the turn still runs rather than after it.
      onInit: (info) => {
        if (info.permissionMode) session.effectivePermissionMode = info.permissionMode;
      },
    });
    return { ...turn, cliSessionId: turn.sessionId };
  } finally {
    session.run = null;
    session.runStartedAt = null;
  }
}

async function send(session: ChatSession, config: ChatConfig, logDir: string, prompt: string): Promise<ChatSendResult> {
  session.messages.push(textMessage("user", prompt));
  let result: TurnResult;
  try {
    result = await runTurn(config, session, prompt);
  } catch (err) {
    session.messages.pop(); // keep the history exactly as the model last saw it
    throw err;
  }
  // A turn killed before the child opened its session left nothing to `--resume`, so the
  // next turn has to open it instead.
  if (session.transport !== "cli" || result.cliSessionId) session.sent += 1;
  if (result.permissionMode) session.effectivePermissionMode = result.permissionMode;
  if (result.text) session.messages.push(textMessage("assistant", result.text));
  // The proxy writes the transcript after it has answered us, so this is the first
  // moment the thread can exist. A first turn may still be buffered — try again next turn.
  if (!session.threadId) session.threadId = await resolveThreadId(logDir, session.id);
  if (result.interrupted && session.threadId) recordInterruption(logDir, session.threadId, result.interrupted);
  return {
    session: publicSession(session),
    reply: result.text,
    usage: result.usage,
    turns: turnsOf(session),
    tools: result.tools,
    interrupted: result.interrupted,
  };
}

/** A per-request `mode`, falling back to the configured default. */
function pickMode(raw: unknown, fallback: ChatMode): ChatMode {
  if (raw === undefined || raw === null) return fallback;
  if (raw !== "chat" && raw !== "agent") throw new Error(`invalid mode: expected "chat" or "agent"`);
  return raw;
}

/** A per-session `permissionMode`, falling back to the resolved default. */
function pickPermissionMode(raw: unknown, fallback: PermissionMode): PermissionMode {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string" || !(PERMISSION_MODES as readonly string[]).includes(raw)) {
    throw new Error(`invalid permissionMode: expected one of ${PERMISSION_MODES.join(", ")}`);
  }
  return raw as PermissionMode;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session id, which the caller may supply — it is also the CLI's `--session-id` and
 * the handle `POST /api/chat/stop` needs, so the dashboard names it before the first
 * turn. Must be a UUID and not already live here.
 */
function pickSessionId(raw: unknown): string {
  if (raw === undefined || raw === null) return crypto.randomUUID();
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new Error("invalid sessionId: expected a uuid");
  if (sessions.has(raw)) throw new Error(`invalid sessionId: already in use (${raw})`);
  return raw;
}

export async function startChat(
  input: {
    prompt: unknown;
    model?: unknown;
    maxTokens?: unknown;
    system?: unknown;
    mode?: unknown;
    sessionId?: unknown;
    permissionMode?: unknown;
  },
  logDir: string,
): Promise<ChatSendResult> {
  const prompt = normalizePrompt(input.prompt);
  const config = await resolveChatConfig();
  const mode = pickMode(input.mode, config.mode);
  if (mode === "agent" && config.transport !== "cli") {
    throw new Error("chat is not configured: agent mode needs the cli transport");
  }
  // `ready` is judged against the configured default; a request that opts into the
  // other mode must not inherit a hint about the one it isn't using.
  if (!config.ready && !(mode === "chat" && config.transport === "cli" && config.cliFound)) {
    throw new Error(`chat is not configured: ${config.readyHint}`);
  }

  // Pinned at start, like the mode: what a session may do is fixed by its first request,
  // not by the environment as it is now.
  const permissionMode = pickPermissionMode(input.permissionMode, config.agent?.permissionMode ?? DEFAULT_PERMISSION_MODE);

  const session: ChatSession = {
    id: pickSessionId(input.sessionId),
    threadId: null,
    transport: config.transport,
    mode,
    agent: mode === "agent" && config.agent ? { ...config.agent, permissionMode } : null,
    model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : config.model,
    maxTokens: typeof input.maxTokens === "number" && input.maxTokens > 0 ? Math.floor(input.maxTokens) : config.maxTokens,
    // `config.system` is resolved for the *default* mode, so a request that opts into
    // the other one picks its own default directly.
    system:
      typeof input.system === "string" && input.system.trim()
        ? input.system
        : (process.env.CHAT_SYSTEM ?? (mode === "agent" ? DEFAULT_AGENT_SYSTEM : DEFAULT_SYSTEM)),
    createdAt: new Date().toISOString(),
    messages: [],
    sent: 0,
    run: null,
    runStartedAt: null,
    effectivePermissionMode: null,
  };
  declareChatSession(logDir, session.id);
  sessions.set(session.id, session);

  try {
    return await send(session, config, logDir, prompt);
  } catch (err) {
    sessions.delete(session.id); // nothing was recorded
    throw err;
  }
}

/** Continues where the transport left off: the CLI resumes, `api` replays the history. */
export async function continueChat(input: { sessionId: unknown; prompt: unknown }, logDir: string): Promise<ChatSendResult> {
  const session = requireSession(input.sessionId);
  const prompt = normalizePrompt(input.prompt);
  return send(session, await resolveChatConfig(), logDir, prompt);
}

function requireSession(raw: unknown): ChatSession {
  if (typeof raw !== "string" || !raw) throw new Error("missing sessionId");
  const session = sessions.get(raw);
  if (!session) throw new Error(`chat session not found: ${raw}`);
  return session;
}

/** A chat with a turn in flight, as any page that can offer to stop it needs to see it. */
export interface RunningChat {
  /** The CLI session id — also the `session:` a transcript records, which is how a
   * session page recognises itself here without knowing the dashboard's tab state. */
  sessionId: string;
  /** Null until the first turn resolves it; a page found by thread id already knows it. */
  threadId: string | null;
  mode: ChatMode;
  permissionMode: string | null;
  effectivePermissionMode: string | null;
  /** When the turn in flight started. */
  startedAt: string;
}

/**
 * The turns in flight right now.
 *
 * The dashboard holds a running turn in component state, so navigating away — or the
 * Sessions list refreshing under it — loses the only handle that could stop it while the
 * child keeps working. This is the handle rediscovered from the server: a session page
 * matches its transcript's `session:` id here and offers Stop on its own.
 */
export function listRunningChats(): RunningChat[] {
  const out: RunningChat[] = [];
  for (const s of sessions.values()) {
    if (!s.run || !s.runStartedAt) continue;
    out.push({
      sessionId: s.id,
      threadId: s.threadId,
      mode: s.mode,
      permissionMode: s.agent?.permissionMode ?? null,
      effectivePermissionMode: s.effectivePermissionMode,
      startedAt: s.runStartedAt,
    });
  }
  return out;
}

/**
 * End the turn in flight without ending the session: the child's whole process group is
 * signalled and the `send` in progress returns the partial reply rather than an error.
 * `stopped: false` means there was nothing running — a no-op, not a failure.
 */
export function stopChat(input: { sessionId: unknown }): { sessionId: string; stopped: boolean } {
  const session = requireSession(input.sessionId);
  const run = session.run;
  run?.stop();
  return { sessionId: session.id, stopped: !!run };
}

/**
 * Forget a chat — what the dashboard's "New chat" does. Without it the Map only ever
 * grows: every session a tab started stays resident for the life of the process. Any
 * turn in flight is stopped first.
 */
export function endChat(input: { sessionId: unknown }): { sessionId: string; stopped: boolean } {
  const session = requireSession(input.sessionId);
  const run = session.run;
  run?.stop();
  sessions.delete(session.id);
  return { sessionId: session.id, stopped: !!run };
}

/** Test seam: forget in-memory chats. */
export function _resetChats(): void {
  sessions.clear();
}

/** Test seam: how many chats are resident. */
export function _chatCount(): number {
  return sessions.size;
}
