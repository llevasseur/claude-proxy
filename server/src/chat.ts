/**
 * chat — the package's one outbound path. Posts streamed `/v1/messages` at the
 * **proxy's** base URL rather than `api.anthropic.com`, in the request shape
 * Claude Code sends, so the proxy captures it as it captures a CLI turn: audit
 * sidecar, context table, and an append-only Session transcript.
 *
 * Auth is not borrowed — the proxy forwards credentials and never supplies them,
 * so this path needs its own `ANTHROPIC_API_KEY`. No `tools` are sent, and the
 * CLI's `anthropic-beta` list is OAuth-specific, so it is off unless `CHAT_BETA`
 * asks for it.
 *
 * Sessions live in memory only; the durable record is the proxy's transcript, so
 * a restart drops the ability to *continue* a chat, never its history.
 */

import crypto from "node:crypto";

const ANTHROPIC_VERSION = "2023-06-01";

/** Defaults, each overridable per env. */
const DEFAULT_BASE_URL = "http://127.0.0.1:8787"; // the proxy's own default PORT
const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TOKENS = 64_000;
const DEFAULT_SYSTEM =
  "You are Claude, answering in a chat started from the claude-proxy dashboard. " +
  "Be direct and concise.";

const MAX_PROMPT_CHARS = 100_000;

const REQUEST_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS ?? 300_000);

/** The resolved configuration a chat runs with — surfaced by `GET /api/chat/config`. */
export interface ChatConfig {
  /** Where the request is sent: the proxy, not `api.anthropic.com`. */
  baseUrl: string;
  model: string;
  maxTokens: number;
  system: string;
  anthropicVersion: string;
  /** The `anthropic-beta` header value, or null when none is sent. */
  beta: string | null;
  /** A chat cannot start without it. */
  apiKeySet: boolean;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** Billed usage, read off the streamed usage events. */
export interface ChatUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

interface ChatSession {
  /** The `x-claude-code-session-id` this chat sends — the proxy's session key. */
  id: string;
  /** The proxy's transcript id for this conversation, or null before the first turn. */
  threadId: string | null;
  model: string;
  maxTokens: number;
  system: string;
  createdAt: string;
  /** Full running `messages[]`, replayed on every turn exactly as the CLI does. */
  messages: AnthropicMessage[];
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string }[];
}

export interface ChatSendResult {
  session: { id: string; threadId: string | null; model: string; createdAt: string };
  reply: string;
  usage: ChatUsage;
  turns: ChatTurn[];
}

/** Live chats, keyed by session id. Lost on restart; the transcript is not. */
const sessions = new Map<string, ChatSession>();

const envInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * `CHAT_BASE_URL` wins; otherwise `ANTHROPIC_BASE_URL`, which on a device set up
 * per the README already points at the running proxy.
 */
export function resolveChatBaseUrl(): string {
  const raw = process.env.CHAT_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

export function resolveChatConfig(): ChatConfig {
  return {
    baseUrl: resolveChatBaseUrl(),
    model: process.env.CHAT_MODEL ?? DEFAULT_MODEL,
    maxTokens: envInt(process.env.CHAT_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    system: process.env.CHAT_SYSTEM ?? DEFAULT_SYSTEM,
    anthropicVersion: ANTHROPIC_VERSION,
    beta: process.env.CHAT_BETA ?? null,
    apiKeySet: !!process.env.ANTHROPIC_API_KEY,
  };
}

/**
 * The proxy's transcript id for a thread: SHA-256 of `sessionId\nfirstUserText`,
 * first 16 hex chars. Mirrors `threadIdFor` in `proxy/session.mjs`; the two must
 * agree, and `proxy/proxy.test.mjs` pins a known digest against drift.
 */
export function threadIdFor(sessionId: string, rootText: string): string {
  return crypto.createHash("sha256").update(`${sessionId}\n${rootText}`).digest("hex").slice(0, 16);
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
});

const turnsOf = (s: ChatSession): ChatTurn[] =>
  s.messages.map((m) => ({ role: m.role, text: m.content.map((b) => b.text).join("\n") }));

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

async function postTurn(config: ChatConfig, apiKey: string, session: ChatSession): Promise<{ text: string; usage: ChatUsage }> {
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

/** Checked before anything is sent. */
function requireApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "chat needs an ANTHROPIC_API_KEY: the proxy forwards credentials, it never supplies them, " +
        "and Claude Code's OAuth token is not reusable here",
    );
  }
  return key;
}

export async function startChat(input: {
  prompt: unknown;
  model?: unknown;
  maxTokens?: unknown;
  system?: unknown;
}): Promise<ChatSendResult> {
  const prompt = normalizePrompt(input.prompt);
  const apiKey = requireApiKey();
  const config = resolveChatConfig();

  const session: ChatSession = {
    id: crypto.randomUUID(),
    threadId: null,
    model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : config.model,
    maxTokens: typeof input.maxTokens === "number" && input.maxTokens > 0 ? Math.floor(input.maxTokens) : config.maxTokens,
    system: typeof input.system === "string" && input.system.trim() ? input.system : config.system,
    createdAt: new Date().toISOString(),
    messages: [],
  };
  // The thread's root is its first user text, so the id is knowable before sending.
  session.threadId = threadIdFor(session.id, prompt);
  sessions.set(session.id, session);

  try {
    return await send(session, config, apiKey, prompt);
  } catch (err) {
    sessions.delete(session.id); // nothing was recorded
    throw err;
  }
}

/** The full history is replayed, as the CLI replays it. */
export async function continueChat(input: { sessionId: unknown; prompt: unknown }): Promise<ChatSendResult> {
  if (typeof input.sessionId !== "string" || !input.sessionId) throw new Error("missing sessionId");
  const session = sessions.get(input.sessionId);
  if (!session) throw new Error(`chat session not found: ${input.sessionId}`);
  const prompt = normalizePrompt(input.prompt);
  return send(session, resolveChatConfig(), requireApiKey(), prompt);
}

async function send(session: ChatSession, config: ChatConfig, apiKey: string, prompt: string): Promise<ChatSendResult> {
  session.messages.push(textMessage("user", prompt));
  let result: { text: string; usage: ChatUsage };
  try {
    result = await postTurn(config, apiKey, session);
  } catch (err) {
    session.messages.pop(); // keep the history exactly as the model last saw it
    throw err;
  }
  if (result.text) session.messages.push(textMessage("assistant", result.text));
  return { session: publicSession(session), reply: result.text, usage: result.usage, turns: turnsOf(session) };
}

/** Test seam: forget in-memory chats. */
export function _resetChats(): void {
  sessions.clear();
}
