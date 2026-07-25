/**
 * guard — refuse tool calls that rewrite the agent's own permission config.
 *
 * The CLI already guards `.claude/settings.json` (the auto-mode classifier blocks
 * agent self-modification of permission config). This is the out-of-band second
 * layer: the proxy is a separate process whose behaviour is not configured by the
 * file it protects, so an agent that talked its way past the in-process gate still
 * can't land the write. It also closes a gap the permission rules can't reach —
 * `permissions.deny` scopes `Edit`/`Write` by path, but says nothing about
 * `Bash(cat > .claude/settings.json)`, `sed -i`, `tee`, or `python -c`.
 *
 * Unlike `WITHHELD_TOOLS` and `INJECTED_REMINDERS` in `proxy.mjs`, which edit the
 * *request* on the way out, this inspects the *response* on the way back: a
 * `tool_use` block is held until its input is complete, then either forwarded
 * byte-for-byte or replaced with a text block explaining the refusal.
 *
 * Every refusal is recorded on `ResponseGuard.blocked` so the caller can log it —
 * the point is a tamper-evident record, not a silent drop.
 */

/** Tools that can write a file. `Bash` is included because a shell redirect
 * reaches the same paths that `permissions.deny` only covers for `Edit`/`Write`. */
export const GUARDED_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);

/** Permission config: the settings files that carry `permissions` and `hooks`
 * blocks, plus the hook scripts those blocks point at (a hook script *is* the
 * enforcement, so rewriting one disables the rule as surely as deleting it).
 * Matches relative, absolute, and `~`-prefixed forms on both path separators.
 *
 * The leading lookbehind rejects a longer name ending in `.claude` (`app.claude/`)
 * without requiring a separator — inside a shell command the path is preceded by a
 * space or a quote, not a `/`. */
export const GUARDED_PATH =
  /(?<![\w.-])\.claude[/\\](?:settings(?:\.[\w-]+)?\.json|hooks[/\\])/i;

/** Device- and org-managed settings, which live outside any `.claude` directory. */
export const MANAGED_PATH =
  /(?:ClaudeCode[/\\]managed-settings\.json|[/\\]etc[/\\]claude-code[/\\]managed-settings\.json)/i;

/** Shell constructs that write. A command naming a guarded path is only refused
 * when it also looks like a mutation — reading the file (`cat`, `grep`, `jq`) stays
 * allowed, since inspecting your own permissions is legitimate and common. */
const BASH_WRITE =
  />|\b(?:tee|cp|mv|rm|rmdir|truncate|dd|ln|chmod|install|patch|python3?|node|perl|ruby)\b|\bsed\b[^|]*\s-i/i;

const isGuardedPath = (p) => typeof p === "string" && (GUARDED_PATH.test(p) || MANAGED_PATH.test(p));

/**
 * Decide whether a completed tool call would rewrite permission config.
 * Pure and total: unknown tools, malformed input, and non-matching paths all
 * return `null` (allow). Returns `{ tool, target, reason }` to refuse.
 */
export function inspectToolUse(name, input) {
  if (!GUARDED_TOOLS.has(name) || !input || typeof input !== "object") return null;

  if (name === "Bash") {
    const command = input.command;
    if (typeof command !== "string" || !isGuardedPath(command)) return null;
    if (!BASH_WRITE.test(command)) return null; // reading permission config is fine
    return {
      tool: name,
      target: command.slice(0, 200),
      reason: "shell command writes to permission config",
    };
  }

  // File tools: whichever path field this tool uses.
  const target = [input.file_path, input.notebook_path, input.path].find(isGuardedPath);
  if (!target) return null;
  return { tool: name, target, reason: "writes to permission config" };
}

/** The text the agent sees in place of the refused call. Written to be actionable:
 * it should understand what happened and tell the user, not silently retry. */
export function refusalText(hit) {
  return (
    `[claude-proxy] Refused \`${hit.tool}\` — ${hit.reason}: ${hit.target}\n\n` +
    "This call was blocked by the proxy, out of process, because it would modify the " +
    "agent's own permission configuration. A permission system an agent can widen on " +
    "its own is not a permission system. Do not attempt to reach this path another " +
    "way. Stop and tell the user what you were trying to change and why, and let them " +
    "make the edit themselves."
  );
}

const sse = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

/** Replacement events for a refused block: an empty text block, the refusal text,
 * and a stop — same index, so the surrounding message stays well-formed. */
function refusalEvents(index, hit) {
  return (
    sse({ type: "content_block_start", index, content_block: { type: "text", text: "" } }) +
    sse({ type: "content_block_delta", index, delta: { type: "text_delta", text: refusalText(hit) } }) +
    sse({ type: "content_block_stop", index })
  );
}

/**
 * Streaming SSE filter. Feed it upstream chunks, write what it returns.
 *
 * Events pass through byte-for-byte until a `content_block_start` opens a
 * `tool_use` for a guarded tool. From there the block's events are held (not
 * dropped) while `input_json_delta` fragments accumulate. At `content_block_stop`
 * the assembled input is inspected: clean blocks are flushed exactly as received,
 * so a normal turn is bit-identical to no proxy at all.
 *
 * Holding costs nothing the user can perceive — text blocks still stream, and a
 * half-arrived tool call can't run.
 */
export class ResponseGuard {
  constructor({ inspect = inspectToolUse } = {}) {
    this.inspect = inspect;
    this.buf = "";
    this.held = null; // { index, name, raw, json }
    /** Refusals, for the caller to log. */
    this.blocked = [];
    /** Guarded tool_use blocks that passed — decides whether `stop_reason` still holds. */
    this.passedToolUses = 0;
    /** Non-guarded tool_use blocks, which we never inspect but must still count. */
    this.otherToolUses = 0;
  }

  /** Feed one upstream chunk; returns the bytes to forward (possibly empty). */
  push(chunk) {
    this.buf += chunk.toString("utf8");
    let out = "";
    let i;
    // SSE events are separated by a blank line. Work whole events so framing
    // (`event:` + `data:`) is never split by a decision.
    while ((i = this.buf.indexOf("\n\n")) !== -1) {
      const evt = this.buf.slice(0, i + 2);
      this.buf = this.buf.slice(i + 2);
      out += this.#event(evt);
    }
    return out;
  }

  /** Emit anything left after upstream ends (a trailing event with no blank line). */
  flush() {
    let out = "";
    if (this.buf) { out += this.#event(this.buf); this.buf = ""; }
    if (this.held) { out += this.held.raw; this.held = null; } // truncated mid-block: forward as-is
    return out;
  }

  #event(evt) {
    const line = evt.split("\n").find((l) => l.startsWith("data:"));
    const payload = line ? line.slice(5).trim() : "";
    let ev = null;
    if (payload && payload !== "[DONE]") { try { ev = JSON.parse(payload); } catch { /* pass through */ } }
    if (!ev) return this.held ? (this.held.raw += evt, "") : evt;

    if (this.held) return this.#heldEvent(evt, ev);

    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      const name = ev.content_block.name;
      if (GUARDED_TOOLS.has(name)) {
        this.held = { index: ev.index, name, raw: evt, json: "" };
        return "";
      }
      this.otherToolUses += 1;
    }

    // Every guarded call was refused and nothing else wants a tool result, so the
    // turn ended in text — say so, or the CLI waits for a call that isn't coming.
    if (
      ev.type === "message_delta" &&
      ev.delta?.stop_reason === "tool_use" &&
      this.blocked.length > 0 &&
      this.passedToolUses === 0 &&
      this.otherToolUses === 0
    ) {
      return sse({ ...ev, delta: { ...ev.delta, stop_reason: "end_turn" } });
    }

    return evt;
  }

  #heldEvent(evt, ev) {
    const h = this.held;
    h.raw += evt;

    if (ev.type === "content_block_delta" && ev.index === h.index) {
      h.json += ev.delta?.partial_json ?? "";
      return "";
    }
    if (ev.type !== "content_block_stop" || ev.index !== h.index) return "";

    let input = null;
    try { input = h.json ? JSON.parse(h.json) : {}; } catch { /* unparseable — treat as opaque */ }

    const hit = input ? this.inspect(h.name, input) : null;
    this.held = null;
    if (!hit) { this.passedToolUses += 1; return h.raw; } // clean: byte-for-byte

    this.blocked.push(hit);
    return refusalEvents(h.index, hit);
  }
}

/**
 * Whole-buffer equivalent for responses that aren't SSE — a non-streaming
 * `/messages` reply, or a skim-cache replay. Returns `{ body, blocked }`, with
 * `body` the original buffer when nothing was refused.
 */
export function guardBuffer(body, { inspect = inspectToolUse } = {}) {
  const text = body.toString("utf8");

  if (text.includes("event:") || text.startsWith("data:")) {
    const g = new ResponseGuard({ inspect });
    const out = g.push(body) + g.flush();
    return { body: g.blocked.length ? Buffer.from(out, "utf8") : body, blocked: g.blocked };
  }

  let obj = null;
  try { obj = JSON.parse(text); } catch { return { body, blocked: [] }; }
  if (!obj || !Array.isArray(obj.content)) return { body, blocked: [] };

  const blocked = [];
  const content = obj.content.map((b) => {
    if (b?.type !== "tool_use") return b;
    const hit = inspect(b.name, b.input);
    if (!hit) return b;
    blocked.push(hit);
    return { type: "text", text: refusalText(hit) };
  });
  if (!blocked.length) return { body, blocked };

  const stop_reason = content.some((b) => b?.type === "tool_use") ? obj.stop_reason : "end_turn";
  return { body: Buffer.from(JSON.stringify({ ...obj, content, stop_reason }), "utf8"), blocked };
}
