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

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { asError } from './errors.js';
import {
  type JsonInput,
  type JsonObject,
  jsonField,
  jsonObject,
  jsonString,
  numberField,
  objectArray,
  parseJson,
  stringField,
} from './json.js';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src

/** Which posture a turn runs under. */
export type ChatMode = 'chat' | 'agent';

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
  settingsOverrides: JsonObject | null;
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
export type CliInterruption = 'stopped' | 'timeout' | 'limit';

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
   * Under `--output-format stream-json` a working child emits an event every few seconds,
   * so this catches a wedged run — a hung tool, a permission prompt nobody can answer —
   * without capping the length of a healthy one.
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
  /**
   * Called for each thing the turn does as it does it — see {@link CliLiveReader}.
   * Purely a watcher: the returned {@link CliTurnResult} is decoded from the whole
   * stream either way, so nothing depends on these having been observed.
   */
  onEvent?: (event: CliLiveEvent) => void;
}

/** The `content` of a `stream-json` message event, whichever event carried it. */
const contentOf = (event: JsonInput): JsonInput => jsonField(jsonField(event, 'message'), 'content');

/**
 * The text of a message's content: the `text` blocks joined, or the content itself
 * when the CLI sent a bare string rather than a block list.
 */
const textOf = (content: JsonInput): string => {
  const bare = jsonString(content);
  if (bare !== undefined) return bare;
  let text = '';
  for (const block of objectArray(content)) {
    if (stringField(block, 'type') !== 'text') continue;
    const value = jsonField(block, 'text');
    if (value !== null && value !== undefined) text += String(value);
  }
  return text;
};

function applyUsage(into: CliTurnResult['usage'], usage: JsonInput): void {
  const input = numberField(usage, 'input_tokens');
  const output = numberField(usage, 'output_tokens');
  const cacheRead = numberField(usage, 'cache_read_input_tokens');
  const cacheCreation = numberField(usage, 'cache_creation_input_tokens');
  if (input !== undefined) into.input = input;
  if (output !== undefined) into.output = output;
  if (cacheRead !== undefined) into.cacheRead = cacheRead;
  if (cacheCreation !== undefined) into.cacheCreation = cacheCreation;
}

const MAX_TOOL_ERROR_CHARS = 400;

/**
 * What a turn is doing, reported while it does it rather than once it is over.
 *
 * The same events {@link decodeCliStream} reads at the end, read a second time as they
 * land. `index` is the tool's position in the finished `tools` list, which is what makes
 * a live chip and a summary chip the same chip.
 */
export type CliLiveEvent =
  | { kind: 'init'; permissionMode: string | null }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; index: number; name: string }
  | { kind: 'tool-result'; index: number; failed: boolean; error?: string };

/**
 * A single line of `stream-json` can be a whole tool result, so a run of chunks with no
 * newline in them is normal — but an unbounded one is a leak. Past this the partial line
 * is abandoned and reading resumes at the next newline; only the live view misses that
 * event, since the end-of-run decode still sees the whole stream.
 */
const MAX_PENDING_LINE_CHARS = 4_000_000;

/**
 * Reads the child's stdout as it arrives and reports what the turn is doing.
 *
 * {@link decodeCliStream} remains the authority on the finished turn, and is what a
 * caller falls back on when nothing was watching. This reads the same stream for a
 * watcher who wants the turn *while* it runs: text as each assistant message lands, and
 * a tool announced when it is called and again when it is answered, interleaved in the
 * order the turn actually ran them.
 *
 * Chunk boundaries fall anywhere, so the reader holds a partial trailing line until its
 * newline arrives, and a `StringDecoder` holds a multi-byte character split across two
 * chunks.
 */
export class CliLiveReader {
  private pending = '';
  private readonly decoder = new StringDecoder('utf8');
  /** How many tools have been announced — the next one's index in the finished list. */
  private tools = 0;
  /** `tool_use` id → its index, so its `tool_result` can be matched to it later. */
  private readonly byId = new Map<string, number>();
  /** Set once the partial line was abandoned, so reading resumes at a line boundary. */
  private skipping = false;

  constructor(private readonly emit: (event: CliLiveEvent) => void) {}

  /** Feed one chunk of stdout. Complete lines are reported; a split line waits for the rest. */
  write(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    for (let br = this.pending.indexOf('\n'); br >= 0; br = this.pending.indexOf('\n')) {
      const line = this.pending.slice(0, br);
      this.pending = this.pending.slice(br + 1);
      if (this.skipping) this.skipping = false;
      else this.read(line);
    }
    if (this.pending.length > MAX_PENDING_LINE_CHARS) {
      this.pending = '';
      this.skipping = true;
    }
  }

  private read(raw: string): void {
    if (!raw.trim()) return;
    // A non-JSON line is CLI chatter, not an event: it decodes to nothing and every
    // reader below falls through it.
    const ev = parseJson(raw);
    const type = stringField(ev, 'type');

    if (type === 'system' && stringField(ev, 'subtype') === 'init') {
      this.emit({ kind: 'init', permissionMode: stringField(ev, 'permissionMode') ?? null });
      return;
    }

    if (type === 'assistant') {
      const content = contentOf(ev);
      const text = textOf(content);
      if (text) this.emit({ kind: 'text', text });
      for (const block of objectArray(content)) {
        if (stringField(block, 'type') !== 'tool_use') continue;
        const index = this.tools++;
        const id = stringField(block, 'id');
        if (id !== undefined) this.byId.set(id, index);
        this.emit({ kind: 'tool', index, name: stringField(block, 'name') ?? 'unknown' });
      }
      return;
    }

    if (type !== 'user') return;
    for (const block of objectArray(contentOf(ev))) {
      if (stringField(block, 'type') !== 'tool_result') continue;
      const id = stringField(block, 'tool_use_id');
      const index = id === undefined ? undefined : this.byId.get(id);
      if (index === undefined) continue;
      const failed = jsonField(block, 'is_error') === true;
      this.emit(toolResultEvent(index, failed, failed ? textOf(jsonField(block, 'content')).trim() : ''));
    }
  }
}

/** A `tool-result` event, carrying the reason only when the tool gave one. */
function toolResultEvent(index: number, failed: boolean, why: string): CliLiveEvent {
  if (!why) return { kind: 'tool-result', index, failed };
  return { kind: 'tool-result', index, failed, error: trimToolError(why) };
}

/** A failing `tool_result`'s text, cut to a chip's worth. */
function trimToolError(why: string): string {
  return why.length > MAX_TOOL_ERROR_CHARS ? `${why.slice(0, MAX_TOOL_ERROR_CHARS)}…` : why;
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
    text: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    sessionId: null,
    tools: [],
    permissionMode: null,
    interrupted: null,
  };
  let assistantText = '';
  let resultText: string | null = null;
  let failure: string | null = null;
  // tool_use id → its entry in `out.tools`, so a later tool_result can mark it failed.
  const byId = new Map<string, CliToolUse>();

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // A non-JSON line is CLI chatter, not an event: it decodes to nothing and every
    // reader below falls through it.
    const ev = parseJson(line);
    const sessionId = stringField(ev, 'session_id');
    if (sessionId !== undefined && !out.sessionId) out.sessionId = sessionId;
    const type = stringField(ev, 'type');
    if (type === 'system' && stringField(ev, 'subtype') === 'init') {
      out.permissionMode = stringField(ev, 'permissionMode') ?? out.permissionMode;
    }

    if (type === 'assistant') {
      const content = contentOf(ev);
      assistantText += textOf(content);
      applyUsage(out.usage, jsonField(jsonField(ev, 'message'), 'usage'));
      for (const block of objectArray(content)) {
        if (stringField(block, 'type') !== 'tool_use') continue;
        const use: CliToolUse = { name: stringField(block, 'name') ?? 'unknown', failed: false };
        out.tools.push(use);
        const id = stringField(block, 'id');
        if (id !== undefined) byId.set(id, use);
      }
    } else if (type === 'user') {
      for (const block of objectArray(contentOf(ev))) {
        if (stringField(block, 'type') !== 'tool_result' || jsonField(block, 'is_error') !== true) continue;
        const id = stringField(block, 'tool_use_id');
        const use = id === undefined ? undefined : byId.get(id);
        if (!use) continue;
        use.failed = true;
        const why = textOf(jsonField(block, 'content')).trim();
        if (why) use.error = trimToolError(why);
      }
    } else if (type === 'result') {
      applyUsage(out.usage, jsonField(ev, 'usage'));
      const result = stringField(ev, 'result');
      if (jsonField(ev, 'is_error')) failure = result ?? stringField(ev, 'subtype') ?? 'unknown error';
      else if (result !== undefined) resultText = result;
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
export function cliSettings(baseUrl: string, overrides?: JsonObject | null): JsonObject {
  const base: JsonObject = { ...overrides };
  const env = jsonObject(base.env) ?? {};
  base.env = { ...env, ANTHROPIC_BASE_URL: baseUrl };
  return base;
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
  input: Pick<
    CliTurnInput,
    'mode' | 'model' | 'system' | 'sessionId' | 'resume' | 'baseUrl' | 'agentFlags' | 'permissionMode'
  >,
): string[] {
  const session = [input.resume ? '--resume' : '--session-id', input.sessionId];

  if (input.mode === 'agent') {
    const flags = input.agentFlags ?? DEFAULT_AGENT_FLAGS;
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--settings',
      JSON.stringify(cliSettings(input.baseUrl, flags.settingsOverrides)),
    ];
    // Absent → the CLI's default set (user, project, local) loads, which is parity.
    if (flags.settingSources?.length) args.push('--setting-sources', flags.settingSources.join(','));
    // Replay what the device's alias withholds, so the dashboard is never *more*
    // capable than the terminal the user trusts.
    if (flags.disallowedTools.length) args.push('--disallowed-tools', ...flags.disallowedTools);
    // A headless child cannot answer a permission prompt, so one is chosen for it.
    if (input.permissionMode) args.push('--permission-mode', input.permissionMode);
    args.push('--model', input.model, '--append-system-prompt', input.system, ...session);
    return args;
  }

  return [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--settings',
    JSON.stringify(cliSettings(input.baseUrl)),
    // No tools to call and none defined, so nothing the dashboard sends can touch the device.
    '--tools',
    '',
    // Ignore this device's CLAUDE.md, hooks, plugins, MCP servers, custom commands
    // and subagents — `--safe-mode` disables all of them.
    '--safe-mode',
    '--strict-mcp-config',
    '--model',
    input.model,
    '--system-prompt',
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
  const dir = configured ?? path.join(os.tmpdir(), 'claude-proxy-chat');
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
  return path.resolve(HERE, '../..');
}

/** Resolve an executable the way a shell would, without spawning one. */
export function findOnPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (cmd.includes(path.sep)) return fs.existsSync(cmd) ? cmd : null;
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
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

/** What a run in flight has decided so far, written from the callbacks that decide it. */
interface RunState {
  /** Why the run was cut short, once something has cut it short. */
  interrupted: CliInterruption | null;
  /** The pending SIGKILL that follows an unheeded SIGTERM. */
  sigkill: NodeJS.Timeout | null;
  /** The silence clock, re-armed by every chunk the child writes. */
  idle: NodeJS.Timeout | null;
}

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
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  // On an object: these are written from callbacks, and a `let` would read back as its
  // initializer across the await below.
  const state: RunState = { interrupted: null, sigkill: null, idle: null };

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
    signalGroup('SIGTERM');
    state.sigkill = setTimeout(() => signalGroup('SIGKILL'), STOP_GRACE_MS);
    state.sigkill.unref?.();
  };

  /** Restart the silence clock. Called at spawn, then on every chunk the child writes. */
  const armIdle = (): void => {
    if (state.interrupted) return;
    if (state.idle) clearTimeout(state.idle);
    state.idle = setTimeout(() => end('timeout'), input.idleTimeoutMs);
    state.idle.unref?.();
  };

  // Watchers read each chunk once as it lands: a rescan per chunk is quadratic on exactly
  // the long turns a watcher exists to report on. Built only when someone is watching, so
  // an unwatched turn still just buffers and decodes at the end.
  let announced = false;
  const live =
    input.onInit || input.onEvent
      ? new CliLiveReader((event) => {
          if (event.kind !== 'init') {
            input.onEvent?.(event);
            return;
          }
          // The first announcement is the one that counts; a resumed child can say twice.
          if (announced) return;
          announced = true;
          input.onInit?.({ permissionMode: event.permissionMode });
        })
      : null;
  child.stdout.on('data', (c: Buffer) => {
    stdout.push(c);
    armIdle();
    live?.write(c);
  });
  child.stderr.on('data', (c: Buffer) => {
    stderr.push(c);
    armIdle(); // a child logging its way through is not wedged
  });

  armIdle();
  const ceiling = setTimeout(() => end('limit'), input.maxTurnMs);
  ceiling.unref?.();
  input.onStart?.({ stop: () => end('stopped') });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
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
  } catch (cause) {
    done();
    // `spawn` reports a missing executable as an `ErrnoException`, so the `code` is read
    // through an `in` guard rather than assumed — anything else keeps its own message.
    const error = asError(cause);
    const reason = 'code' in error && error.code === 'ENOENT' ? 'not found on PATH' : error.message;
    throw new Error(`chat cli could not start (${input.cliPath}: ${reason})`);
  }
  done();

  const raw = Buffer.concat(stdout).toString('utf8');
  if (state.interrupted) {
    return { ...decodeCliStream(raw, { partial: true }), interrupted: state.interrupted };
  }
  if (closed.code !== 0) {
    const tail = Buffer.concat(stderr).toString('utf8').trim().split('\n').slice(-4).join('\n');
    throw new Error(`chat cli exited ${closed.code}${tail ? `: ${tail}` : ''}`);
  }
  return decodeCliStream(raw);
}
