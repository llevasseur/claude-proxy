/**
 * chat-cli — the local-dev transport: a headless Claude Code process rather than
 * an HTTP client.
 *
 * `claude --print` authenticates itself from the device's own Claude Code login,
 * so this server holds no credential; `ANTHROPIC_BASE_URL` points the child at the
 * proxy, which then sees an ordinary CLI turn and captures it through its existing
 * path. `ANTHROPIC_API_KEY` is stripped from the child's environment — its presence
 * would silently switch the CLI onto key billing, which is the other transport's job.
 * Both modes below share that credential posture.
 *
 * Two modes, differing only in what the child is permitted to be:
 *
 *   - `chat` — no tools, no customizations, a scratch cwd. Nothing a dashboard
 *     prompt says can reach the filesystem.
 *   - `agent` — a full Claude Code session at parity with the device's own `claude`
 *     sessions: user settings sources, CLAUDE.md, custom slash commands, plugins,
 *     MCP servers and subagents all load, and real tools run. **A dashboard prompt
 *     in this mode can read and write the repo.** Two things bound it: the cwd is
 *     the running server's own checkout and nothing else (no `--add-dir`), and the
 *     device's `claude` alias flags are replayed onto it, so a tool that alias
 *     withholds stays withheld here (see {@link AgentLaunchFlags}).
 *
 * History lives in the CLI's own session store, so a follow-up turn resumes rather
 * than replaying `messages[]`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src

/** Which posture a turn runs under. */
export type ChatMode = "chat" | "agent";

/**
 * The device's own `claude` launch flags, replayed onto an agent turn so it matches
 * the sessions the user actually runs. Parsed from the shell rc by
 * `@claude-proxy/core`'s `parseLaunchAliases` — e.g. an
 * `alias claude='command claude --disallowed-tools Monitor'` withholds Monitor here
 * too. All fields empty/null means "the CLI's own defaults", which is still parity:
 * that is what a bare `claude` does.
 */
export interface AgentLaunchFlags {
  /** Tools the alias withholds via `--disallowed-tools`. */
  disallowedTools: string[];
  /** Sources the alias names via `--setting-sources`; null → the CLI's default set. */
  settingSources: string[] | null;
  /** Static `--settings` JSON the alias injects; null when absent or non-static. */
  settingsOverrides: Record<string, unknown> | null;
}

/** Nothing withheld, nothing overridden — a bare `claude`. */
export const DEFAULT_AGENT_FLAGS: AgentLaunchFlags = {
  disallowedTools: [],
  settingSources: null,
  settingsOverrides: null,
};

/** One tool the agent ran, as the dashboard reports it. */
export interface CliToolUse {
  name: string;
  /** True when the tool returned an error result. */
  failed: boolean;
}

export interface CliTurnResult {
  text: string;
  usage: { input: number; output: number; cacheRead: number; cacheCreation: number };
  /** The session id the CLI reports back, which should match the one we asked for. */
  sessionId: string | null;
  /** Tools the turn ran, in order. Always empty in `chat` mode — it has none. */
  tools: CliToolUse[];
}

export interface CliTurnInput {
  cliPath: string;
  cwd: string;
  /** The proxy's base URL, handed to the child as `ANTHROPIC_BASE_URL`. */
  baseUrl: string;
  mode: ChatMode;
  model: string;
  system: string;
  sessionId: string;
  /** First turn opens the session id; later turns resume it. */
  resume: boolean;
  prompt: string;
  timeoutMs: number;
  /** `agent` only: the device flags to replay. Ignored by `chat`. */
  agentFlags?: AgentLaunchFlags;
  /** `agent` only: how the headless child answers permission prompts. */
  permissionMode?: string;
}

/** Enough of a `stream-json` line to reassemble a turn. */
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

/** The content blocks of a message event, as objects we can inspect. */
const blocksOf = (content: unknown): Record<string, unknown>[] =>
  Array.isArray(content) ? content.filter((b): b is Record<string, unknown> => !!b && typeof b === "object") : [];

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
 *
 * An agent turn also runs tools: each is announced as a `tool_use` block on an
 * `assistant` event and answered by a `tool_result` block on a `user` event, which
 * is where a failure shows up. Both are collected so the dashboard can show what the
 * turn actually did rather than only what it said. A `chat` turn has no tools, so
 * this costs it nothing.
 */
export function decodeCliStream(raw: string): CliTurnResult {
  const out: CliTurnResult = { text: "", usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, sessionId: null, tools: [] };
  let assistantText = "";
  let resultText: string | null = null;
  let failure: string | null = null;
  // tool_use id → its entry in `out.tools`, so a later tool_result can mark it failed.
  const byId = new Map<string, CliToolUse>();

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
      for (const b of blocksOf(ev.message?.content)) {
        if (b.type !== "tool_use") continue;
        const use: CliToolUse = { name: typeof b.name === "string" ? b.name : "unknown", failed: false };
        out.tools.push(use);
        if (typeof b.id === "string") byId.set(b.id, use);
      }
    } else if (ev.type === "user") {
      for (const b of blocksOf(ev.message?.content)) {
        if (b.type !== "tool_result" || b.is_error !== true) continue;
        const use = typeof b.tool_use_id === "string" ? byId.get(b.tool_use_id) : undefined;
        if (use) use.failed = true;
      }
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
 * The `--settings` payload: the alias's own static overrides, with the proxy's base
 * URL layered on top.
 *
 * The base URL rides here rather than only in the environment because a device that
 * set `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json` — which the README's own
 * setup does — otherwise overrides the child's environment and sends the turn to
 * whatever proxy that file names instead of the one we mean. Agent mode loads that
 * settings file *by design*, so this matters more there, not less: the base URL is
 * written last so it wins over both the file and anything the alias injects.
 */
export function cliSettings(baseUrl: string, overrides?: Record<string, unknown> | null): Record<string, unknown> {
  const base = overrides && typeof overrides === "object" ? { ...overrides } : {};
  const env = base.env && typeof base.env === "object" ? { ...(base.env as Record<string, unknown>) } : {};
  return { ...base, env: { ...env, ANTHROPIC_BASE_URL: baseUrl } };
}

/**
 * The argv for one turn.
 *
 * `chat` locks the child down; `agent` hands it the device's own posture. The one
 * thing neither mode yields is where the turn is sent — see {@link cliSettings}.
 *
 * Agent mode deliberately omits three flags chat mode passes. `--safe-mode` would
 * disable the very customizations parity is about, `--tools ""` would leave the agent
 * unable to act, and `--strict-mcp-config` would drop the device's MCP servers. It
 * also *appends* its system prompt instead of replacing it: `--system-prompt` would
 * discard Claude Code's own harness prompt, which is what teaches the child to use
 * its tools at all.
 */
export function cliArgs(
  input: Pick<CliTurnInput, "mode" | "model" | "system" | "sessionId" | "resume" | "baseUrl" | "agentFlags" | "permissionMode">,
): string[] {
  const session = [input.resume ? "--resume" : "--session-id", input.sessionId];

  if (input.mode === "agent") {
    const flags = input.agentFlags ?? DEFAULT_AGENT_FLAGS;
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--settings",
      JSON.stringify(cliSettings(input.baseUrl, flags.settingsOverrides)),
    ];
    // Absent → the CLI's default set (user, project, local) loads, which is parity.
    if (flags.settingSources?.length) args.push("--setting-sources", flags.settingSources.join(","));
    // Replay whatever the device's own alias withholds, so the dashboard is never
    // *more* capable than the terminal the user trusts.
    if (flags.disallowedTools.length) args.push("--disallowed-tools", ...flags.disallowedTools);
    // A headless child cannot answer a permission prompt, so one is chosen for it.
    if (input.permissionMode) args.push("--permission-mode", input.permissionMode);
    args.push("--model", input.model, "--append-system-prompt", input.system, ...session);
    return args;
  }

  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    JSON.stringify(cliSettings(input.baseUrl)),
    // No tools to call and none defined, so nothing the dashboard sends can touch the device.
    "--tools",
    "",
    // Ignore this device's CLAUDE.md, hooks, plugins, MCP servers, custom commands
    // and subagents — `--safe-mode` disables all of them.
    "--safe-mode",
    "--strict-mcp-config",
    "--model",
    input.model,
    "--system-prompt",
    input.system,
    ...session,
  ];
}

/** The child's environment: the proxy as upstream, and no API key to fall back on.
 * Agent mode keeps that stripping — a device login is still the right credential for
 * a turn the user is watching, and key billing should never start by accident. */
export function cliEnv(baseUrl: string, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...from, ANTHROPIC_BASE_URL: baseUrl };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/** Where a `chat` turn runs: never the server's own tree, so `--add-dir`-less tools see nothing. */
export function resolveCliCwd(configured?: string): string {
  const dir = configured ?? path.join(os.tmpdir(), "claude-proxy-chat");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Where an `agent` turn runs: the checkout of the *running server*, and nothing else.
 *
 * This is the same root `resolveLogDir` derives `logs/` from, which is what keeps the
 * capture path coherent — a server started from a worktree audits that worktree's
 * store and drives an agent in that same tree, rather than editing one checkout while
 * writing markers into another. No env override and no `--add-dir`: the whole point
 * is that a dashboard prompt has exactly one reachable tree.
 */
export function resolveAgentCwd(): string {
  return path.resolve(HERE, "../..");
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
