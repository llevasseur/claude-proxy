/**
 * chat-cli — the local-dev transport: a headless Claude Code process rather than
 * an HTTP client.
 *
 * `claude --print` authenticates itself from the device's own Claude Code login,
 * so this server holds no credential; `ANTHROPIC_BASE_URL` points the child at the
 * proxy, which then sees an ordinary CLI turn and captures it through its existing
 * path. `ANTHROPIC_API_KEY` is stripped from the child's environment — its presence
 * would silently switch the CLI onto key billing, which is the other transport's job.
 * Both modes share that credential posture.
 *
 * Two modes, differing only in what the child is permitted to be:
 *
 *   - `chat` — no tools, no customizations, a scratch cwd. Nothing a dashboard
 *     prompt says can reach the filesystem.
 *   - `agent` — a full Claude Code session at parity with the device's own: settings
 *     sources, CLAUDE.md, custom slash commands, plugins, MCP servers and subagents
 *     all load, and real tools run. **A dashboard prompt in this mode can read and
 *     write the repo.** Two things bound it: the cwd is the running server's own
 *     checkout and nothing else (no `--add-dir`), and the device's `claude` alias
 *     flags are replayed onto it (see {@link AgentLaunchFlags}).
 *
 * History lives in the CLI's own session store, so a follow-up turn resumes rather
 * than replaying `messages[]`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src

/** Which posture a turn runs under. */
export type ChatMode = "chat" | "agent";

/**
 * The device's own `claude` launch flags, replayed onto an agent turn so it matches
 * the sessions the user actually runs. Parsed from the shell rc by
 * `@claude-proxy/core`'s `parseLaunchAliases`. All fields empty/null means the CLI's
 * own defaults, which is still parity: that is what a bare `claude` does.
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
  /** The failing `tool_result`'s own text, trimmed to a chip's worth. */
  error?: string;
}

/**
 * Why a turn ended before the CLI was finished with it.
 *
 *   - `stopped` — a caller ended it.
 *   - `timeout` — it went quiet: nothing on stdout or stderr for the idle window.
 *   - `limit` — it stayed lively but outran the absolute ceiling on one turn.
 */
export type CliInterruption = "stopped" | "timeout" | "limit";

export interface CliTurnResult {
  text: string;
  usage: { input: number; output: number; cacheRead: number; cacheCreation: number };
  /** The session id the CLI reports back, which should match the one we asked for. */
  sessionId: string | null;
  /** Tools the turn ran, in order. Always empty in `chat` mode — it has none. */
  tools: CliToolUse[];
  /**
   * The permission mode the child reports on startup — what it *is* running under,
   * as against what was asked for. Null when the run ended before it said.
   */
  permissionMode: string | null;
  /** Set when the run was cut short; the text and tools are whatever had arrived by then. */
  interrupted: CliInterruption | null;
}

/** A turn in flight, handed to the caller so it can be ended from elsewhere. */
export interface CliRunHandle {
  /** End the run: SIGTERM the process group, then SIGKILL whatever survives. Idempotent. */
  stop: () => void;
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
  /**
   * How long the child may produce *nothing* before the run is ended — re-armed on every
   * chunk of stdout or stderr, so it measures silence rather than total elapsed time.
   *
   * An agent turn is a tool loop that can legitimately run for an hour; a total cap kills
   * healthy work mid-loop and leaves a half-applied edit behind. What actually wants
   * catching is a wedged run — a hung tool, a permission prompt nobody can answer — and
   * that shows up as a stream that has stopped emitting. Under `--output-format
   * stream-json` a working child emits an event every few seconds, so silence is the
   * signal and progress buys as much time as it needs.
   */
  idleTimeoutMs: number;
  /** The absolute ceiling on one turn, however lively it stays. Armed once, never re-armed. */
  maxTurnMs: number;
  /** `agent` only: the device flags to replay. Ignored by `chat`. */
  agentFlags?: AgentLaunchFlags;
  /** `agent` only: how the headless child answers permission prompts. */
  permissionMode?: string;
  /** Called once the child is up, with the handle that ends it early. */
  onStart?: (run: CliRunHandle) => void;
  /**
   * Called when the child announces itself, before it has done any work. The whole
   * stream is only decoded at the end, and the longest turn is the one whose posture
   * a watcher most wants to see — so this one fact is reported as it arrives.
   */
  onInit?: (info: { permissionMode: string | null }) => void;
}

/** Enough of a `stream-json` line to reassemble a turn. */
interface CliEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  /** On the `system`/`init` event: the mode the child actually started in. */
  permissionMode?: string;
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

const MAX_TOOL_ERROR_CHARS = 400;

/**
 * Find the child's `system`/`init` event in a prefix of the stream, if it has arrived.
 * The full decode happens once at the end; this reads the one line a watcher needs early.
 */
export function findInitEvent(raw: string): { permissionMode: string | null } | null {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes(`"init"`)) continue;
    let ev: CliEvent;
    try {
      ev = JSON.parse(line) as CliEvent;
    } catch {
      continue; // a partial trailing line; it will be whole on the next chunk
    }
    if (ev.type !== "system" || ev.subtype !== "init") continue;
    return { permissionMode: typeof ev.permissionMode === "string" ? ev.permissionMode : null };
  }
  return null;
}

/**
 * Reassemble a `--output-format stream-json` run: newline-delimited JSON, one event
 * per line. The terminal `result` event carries the finished reply and the billed
 * usage; the `assistant` events are the fallback when a run ends without one.
 *
 * An agent turn also runs tools: each is announced as a `tool_use` block on an
 * `assistant` event and answered by a `tool_result` block on a `user` event, which
 * is where a failure shows up — with the reason, which is carried through. A `chat`
 * turn has no tools.
 *
 * `partial` decodes the prefix of a killed run: an error `result` event then reports the
 * kill rather than a failure to raise, so what did arrive still stands.
 */
export function decodeCliStream(raw: string, opts: { partial?: boolean } = {}): CliTurnResult {
  const out: CliTurnResult = {
    text: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    sessionId: null,
    tools: [],
    permissionMode: null,
    interrupted: null,
  };
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
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.permissionMode === "string") {
      out.permissionMode = ev.permissionMode;
    }

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
        if (!use) continue;
        use.failed = true;
        const why = textOf(b.content).trim();
        if (why) use.error = why.length > MAX_TOOL_ERROR_CHARS ? `${why.slice(0, MAX_TOOL_ERROR_CHARS)}…` : why;
      }
    } else if (ev.type === "result") {
      if (ev.usage) applyUsage(out.usage, ev.usage);
      if (ev.is_error) failure = ev.result ?? ev.subtype ?? "unknown error";
      else if (typeof ev.result === "string") resultText = ev.result;
    }
  }

  if (failure && !opts.partial) throw new Error(`claude cli reported an error: ${failure}`);
  out.text = resultText ?? assistantText;
  return out;
}

/**
 * The `--settings` payload: the alias's own static overrides, with the proxy's base
 * URL layered on top.
 *
 * The base URL rides here rather than only in the environment because an
 * `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json` otherwise overrides the
 * child's environment and sends the turn to whatever proxy that file names. Agent
 * mode loads that file by design, so the base URL is written last and wins over both
 * it and anything the alias injects.
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
 * Agent mode omits three flags chat mode passes: `--safe-mode` would disable the
 * customizations parity is about, `--tools ""` would leave the agent unable to act,
 * and `--strict-mcp-config` would drop the device's MCP servers. It also *appends*
 * its system prompt rather than replacing it — `--system-prompt` would discard the
 * harness prompt that teaches the child to use its tools.
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
    // Replay what the device's alias withholds, so the dashboard is never *more*
    // capable than the terminal the user trusts.
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
 * Both modes strip it — key billing should never start by accident. */
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
 * The same root `resolveLogDir` derives `logs/` from, so a server started from a
 * worktree drives an agent in that same tree rather than writing markers into
 * another. No env override and no `--add-dir`: exactly one reachable tree.
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

/** How long a SIGTERMed run has to flush and exit before it is SIGKILLed. */
const STOP_GRACE_MS = 3_000;

/**
 * Run one headless turn. The prompt goes over stdin so it is never argv-quoted.
 *
 * The child is spawned **detached** so it leads its own process group: an agent turn
 * spawns its own tools, and signalling the CLI alone would orphan them still holding the
 * repo. Ending a run signals `-pid`, the whole group — SIGTERM first so the CLI can
 * flush, then SIGKILL for anything that ignores it.
 *
 * Two clocks bound a run, and neither is a total-elapsed budget on the work itself:
 * `idleTimeoutMs` measures silence and is re-armed by every chunk the child writes, so a
 * turn that keeps streaming keeps running; `maxTurnMs` is the ceiling that ends even a
 * lively one. They are reported apart — `timeout` and `limit` — because they mean
 * different things about the run that hit them.
 *
 * A run ended any of these three ways is not a failure: it returns the prefix of the
 * stream that arrived, text and tools included.
 */
export async function runCliTurn(input: CliTurnInput): Promise<CliTurnResult> {
  const args = cliArgs(input);
  const child = spawn(input.cliPath, args, {
    cwd: input.cwd,
    env: cliEnv(input.baseUrl, process.env),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  // On an object: these are written from callbacks, and a `let` would read back as its
  // initializer across the await below.
  const state = {
    interrupted: null as CliInterruption | null,
    sigkill: null as NodeJS.Timeout | null,
    idle: null as NodeJS.Timeout | null,
  };

  /** Signal the child's whole group, falling back to the child alone where there isn't one. */
  const signalGroup = (sig: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try {
        child.kill(sig); // no group, or already reaped
      } catch {
        /* already gone */
      }
    }
  };

  const end = (why: CliInterruption): void => {
    if (state.interrupted) return;
    state.interrupted = why;
    if (state.idle) clearTimeout(state.idle);
    signalGroup("SIGTERM");
    state.sigkill = setTimeout(() => signalGroup("SIGKILL"), STOP_GRACE_MS);
    state.sigkill.unref?.();
  };

  /** Restart the silence clock. Called at spawn, then on every chunk the child writes. */
  const armIdle = (): void => {
    if (state.interrupted) return;
    if (state.idle) clearTimeout(state.idle);
    state.idle = setTimeout(() => end("timeout"), input.idleTimeoutMs);
    state.idle.unref?.();
  };

  // The watch for the child's opening `init` event reads each chunk once as it lands,
  // rather than re-reading the whole stream every time: a child that never announces —
  // an older CLI, or a run that dies before it says — would otherwise make every chunk
  // rescan everything before it, which is quadratic on exactly the long turns this
  // watch exists to report on. The decoder holds a multi-byte character split across a
  // chunk boundary; `pending` holds a line split across one, so it is whole when parsed.
  let announced = false;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  child.stdout.on("data", (c: Buffer) => {
    stdout.push(c);
    armIdle(); // the child is alive and working; the silence clock starts over
    if (announced || !input.onInit) return;
    pending += decoder.write(c);
    const init = findInitEvent(pending);
    const lastBreak = pending.lastIndexOf("\n");
    if (lastBreak >= 0) pending = pending.slice(lastBreak + 1);
    if (!init) return;
    announced = true;
    input.onInit(init);
  });
  child.stderr.on("data", (c: Buffer) => {
    stderr.push(c);
    armIdle(); // stderr counts as life too — a child logging its way through is not wedged
  });

  // Both clocks start at spawn: the silence one, which every chunk pushes back, and the
  // ceiling, which nothing does.
  armIdle();
  const ceiling = setTimeout(() => end("limit"), input.maxTurnMs);
  ceiling.unref?.();
  input.onStart?.({ stop: () => end("stopped") });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  child.stdin.end(input.prompt);

  const done = () => {
    clearTimeout(ceiling);
    if (state.idle) clearTimeout(state.idle);
    if (state.sigkill) clearTimeout(state.sigkill);
  };

  let closed: { code: number | null; signal: NodeJS.Signals | null };
  try {
    closed = await exit;
  } catch (err) {
    done();
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "not found on PATH" : (err as Error).message;
    throw new Error(`chat cli could not start (${input.cliPath}: ${reason})`);
  }
  done();

  const raw = Buffer.concat(stdout).toString("utf8");
  if (state.interrupted) {
    return { ...decodeCliStream(raw, { partial: true }), interrupted: state.interrupted };
  }
  if (closed.code !== 0) {
    const tail = Buffer.concat(stderr).toString("utf8").trim().split("\n").slice(-4).join("\n");
    throw new Error(`chat cli exited ${closed.code}${tail ? `: ${tail}` : ""}`);
  }
  return decodeCliStream(raw);
}
