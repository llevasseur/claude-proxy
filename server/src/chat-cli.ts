/**
 * chat-cli — the local-dev chat transport: a headless Claude Code process rather
 * than an HTTP client.
 *
 * `claude --print` authenticates itself from the device's own Claude Code login,
 * so this server holds no credential; `ANTHROPIC_BASE_URL` points the child at the
 * proxy, which then sees an ordinary CLI turn and captures it through its existing
 * path. `ANTHROPIC_API_KEY` is stripped from the child's environment — its presence
 * would silently switch the CLI onto key billing, which is the other transport's job.
 *
 * The child runs with no tools and no customizations, so nothing a dashboard prompt
 * says reaches the filesystem. History lives in the CLI's own session store, so a
 * follow-up turn resumes rather than replaying `messages[]`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliTurnResult {
  text: string;
  usage: { input: number; output: number; cacheRead: number; cacheCreation: number };
  /** The session id the CLI reports back, which should match the one we asked for. */
  sessionId: string | null;
}

export interface CliTurnInput {
  cliPath: string;
  cwd: string;
  /** The proxy's base URL, handed to the child as `ANTHROPIC_BASE_URL`. */
  baseUrl: string;
  model: string;
  system: string;
  sessionId: string;
  /** First turn opens the session id; later turns resume it. */
  resume: boolean;
  prompt: string;
  timeoutMs: number;
}

/** Enough of a `stream-json` line for a chat turn; tool events can't occur here. */
interface CliEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  usage?: Record<string, unknown>;
  message?: { content?: unknown; usage?: Record<string, unknown> };
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
        .filter(Boolean)
        .join("")
    : typeof content === "string"
      ? content
      : "";

function applyUsage(into: CliTurnResult["usage"], u: Record<string, unknown>): void {
  if (typeof u.input_tokens === "number") into.input = u.input_tokens;
  if (typeof u.output_tokens === "number") into.output = u.output_tokens;
  if (typeof u.cache_read_input_tokens === "number") into.cacheRead = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === "number") into.cacheCreation = u.cache_creation_input_tokens;
}

/**
 * Reassemble a `--output-format stream-json` run: newline-delimited JSON, one event
 * per line. The terminal `result` event carries the finished reply and the billed
 * usage; the `assistant` events are the fallback when a run ends without one.
 */
export function decodeCliStream(raw: string): CliTurnResult {
  const out: CliTurnResult = { text: "", usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, sessionId: null };
  let assistantText = "";
  let resultText: string | null = null;
  let failure: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: CliEvent;
    try {
      ev = JSON.parse(line) as CliEvent;
    } catch {
      continue; // a non-JSON line is CLI chatter, not an event
    }
    if (typeof ev.session_id === "string" && !out.sessionId) out.sessionId = ev.session_id;

    if (ev.type === "assistant") {
      assistantText += textOf(ev.message?.content);
      if (ev.message?.usage) applyUsage(out.usage, ev.message.usage);
    } else if (ev.type === "result") {
      if (ev.usage) applyUsage(out.usage, ev.usage);
      if (ev.is_error) failure = ev.result ?? ev.subtype ?? "unknown error";
      else if (typeof ev.result === "string") resultText = ev.result;
    }
  }

  if (failure) throw new Error(`claude cli reported an error: ${failure}`);
  out.text = resultText ?? assistantText;
  return out;
}

/**
 * The argv for one turn.
 *
 * The base URL rides in `--settings` rather than only in the environment: a device
 * that set `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json` — which the README's
 * own setup does — otherwise overrides the child's environment and sends the turn to
 * whatever proxy that file names instead of the one we mean.
 */
export function cliArgs(input: Pick<CliTurnInput, "model" | "system" | "sessionId" | "resume" | "baseUrl">): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: input.baseUrl } }),
    // No tools to call and none defined, so nothing the dashboard sends can touch the device.
    "--tools",
    "",
    // Ignore this device's CLAUDE.md, hooks, plugins and MCP servers.
    "--safe-mode",
    "--strict-mcp-config",
    "--model",
    input.model,
    "--system-prompt",
    input.system,
    input.resume ? "--resume" : "--session-id",
    input.sessionId,
  ];
}

/** The child's environment: the proxy as upstream, and no API key to fall back on. */
export function cliEnv(baseUrl: string, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...from, ANTHROPIC_BASE_URL: baseUrl };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/** Where the child runs: never the server's own tree, so `--add-dir`-less tools see nothing. */
export function resolveCliCwd(configured?: string): string {
  const dir = configured ?? path.join(os.tmpdir(), "claude-proxy-chat");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve an executable the way a shell would, without spawning one. */
export function findOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (cmd.includes(path.sep)) return fs.existsSync(cmd) ? cmd : null;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Run one headless turn. The prompt goes over stdin so it is never argv-quoted. */
export async function runCliTurn(input: CliTurnInput): Promise<CliTurnResult> {
  const args = cliArgs(input);
  const child = spawn(input.cliPath, args, {
    cwd: input.cwd,
    env: cliEnv(input.baseUrl, process.env),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => stdout.push(c));
  child.stderr.on("data", (c: Buffer) => stderr.push(c));

  const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs);
  timer.unref?.();

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  child.stdin.end(input.prompt);

  let closed: { code: number | null; signal: NodeJS.Signals | null };
  try {
    closed = await exit;
  } catch (err) {
    clearTimeout(timer);
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "not found on PATH" : (err as Error).message;
    throw new Error(`chat cli could not start (${input.cliPath}: ${reason})`);
  }
  clearTimeout(timer);

  const raw = Buffer.concat(stdout).toString("utf8");
  if (closed.signal === "SIGKILL") {
    throw new Error(`chat cli timed out after ${input.timeoutMs}ms`);
  }
  if (closed.code !== 0) {
    const tail = Buffer.concat(stderr).toString("utf8").trim().split("\n").slice(-4).join("\n");
    throw new Error(`chat cli exited ${closed.code}${tail ? `: ${tail}` : ""}`);
  }
  return decodeCliStream(raw);
}
