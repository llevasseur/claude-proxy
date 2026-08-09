---
type: feature
title: Dashboard chat sessions
description: A prompt input on the Sessions page that starts a real session through the proxy — by a headless Claude Code process in local dev, or a keyed HTTP client in a deployment — so the proxy logs and transcribes it and the new thread appears in the sessions list. Runs either as a full agent at parity with the device's own CLI, or in a sandboxed chat posture with no tools.
tags: [dashboard, backend, usage, auth]
timestamp: 2026-07-24
---

# Dashboard chat sessions

## Summary

The **Sessions** page starts sessions through `POST /api/chat/sessions`. Turns pass
through the proxy as ordinary traffic: forwarded to `api.anthropic.com`, written as
`.md`/`.request.txt`/`.audit.json`, appended to a transcript, and surfaced live over
the existing SSE stream in the sessions table and in every usage digest. There is no
separate logging path.

There are two transports to the proxy, chosen by `CHAT_TRANSPORT`:

- **`cli` (default).** The server runs `claude --print` through the proxy, using the
  device login and subscription without a server credential. See
  [Headless Chat Transport](../specs/2026-07-24-headless-chat-transport-design.md).
- **`api`.** A streamed `POST /v1/messages` carrying `ANTHROPIC_API_KEY`, in the header and
  body shape Claude Code sends, for deployments without an interactive login.

The server holds the conversation in memory for display, and for replaying history on the
next turn under `api`; the durable record is the transcript the proxy writes.

Under `cli` the turn runs in one of two **modes**, which differ in what a prompt MAY do:

- **`agent` (default).** A full Claude Code session at parity with the device's own —
  CLAUDE.md, settings, plugins, MCP servers, hooks, subagents, custom slash commands
  (`/task` works), and real tools, with the flags taken from the user's actual `claude`
  shell alias. **A prompt sent from the dashboard in this mode can read and write this
  repository and run commands in it.** Anything reaching the server port can reach this
  capability; its filesystem scope is the server's checkout.
- **`chat`.** The sandboxed posture: no tools, no device customizations, a scratch cwd.
  Nothing a prompt says can reach the filesystem. Select it with `CHAT_MODE=chat` or per
  request.

`api` is always `chat` — a bare `/v1/messages` call has no harness to run a tool with, so
asking for `agent` over it is rejected rather than silently downgraded. Design detail:
[Dashboard Agent Mode](../specs/2026-07-25-dashboard-agent-mode-design.md).

## Motivation

Sending through the proxy makes the dashboard both producer and reader: one client
exercises chat → live row → transcript end to end. A direct `api.anthropic.com` call would
be invisible; proxied turns get production logging, redaction, Skim eligibility, and
transcription.

## Behavior

**Credentials are not borrowed.** The proxy forwards client `authorization` / `x-api-key`
headers and redacts logs; it never supplies credentials. Under `cli`, the child owns its
credential; under `api`, the key comes from the environment. The server never extracts
Claude Code OAuth from the keychain or `~/.claude/.credentials.json`. `GET
/api/chat/config` reports `ready` and a missing-resource `readyHint`; the UI disables send,
shows the hint, and returns `503`.

**The headless `chat` child** uses no tools (`--tools ""`; audits show `0 tools`), a
scratch cwd, and no device customizations: `--safe-mode --strict-mcp-config` disables
CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands, and subagents. The proxy
URL goes through `--settings`, preventing a settings-file `env` block (which the repository
README setup writes) from overriding it. The first turn uses `--session-id <uuid>`, later
turns `--resume`; `stream-json` output is decoded from the terminal `result`.

**The headless `agent` child** drops those three isolation flags so normal setting
sources load, then applies flags parsed from the user's `claude` alias; withheld tools
therefore need no dashboard configuration. Its cwd is the server module's checkout, so
launching from `.claude/worktrees/<name>` makes that worktree both cwd and `LOG_DIR` root.
Its per-session `--permission-mode` defaults to `bypassPermissions`, and its system prompt
is appended to Claude Code's own. Both modes strip `ANTHROPIC_API_KEY` /
`ANTHROPIC_AUTH_TOKEN` from the child environment and force the base URL through settings.

**Permission mode is per-session.** The start form chooses the standing
`--permission-mode` for a headless `--print` child and pins it for the session.
`CHAT_AGENT_PERMISSION_MODE` sets the form default. Values outside the four are warned,
ignored, and replaced by `bypassPermissions`.

- **`bypassPermissions` (the default).** Nothing is asked and nothing is denied: commands
  and git writes run. `/task` needs this, so the form opens on it.
- **`acceptEdits`.** File edits are pre-approved; Bash is not. A command the CLI classifies
  as read-only still runs (`git status --short` does), but any command that *would* have
  prompted is denied with `This command requires approval`. Mutating commands are in that
  group: an agent can edit files but cannot `git commit`, so `/task` stalls at its first
  git write.
- **`default`.** Every gated tool asks, which in a headless child means it is denied.
- **`plan`.** Read-only; the turn plans and does not act.

Sandbox limits are separate and apply under every mode: the CLI blocks a write outside the
session's working directory regardless of permission mode.

**Tool activity is surfaced.** Ordered `tool_use` blocks are matched by id to
`tool_result`; the send response renders them as chips. Failures include up to 400
characters of result text, so a denial says `This command requires approval`. Full calls
remain in the proxy transcript.

**A turn can be stopped.** `POST /api/chat/stop` preserves the session while signaling
the detached child's whole process group: SIGTERM, then SIGKILL after 3s. Shells and
subagents are not orphaned. The in-flight send returns received text/tool chips tagged
`interrupted: "stopped"`; clock interruptions preserve output through the same path.

**Turns are timed on silence.** Under `--output-format stream-json`, wedged tools/prompts
stop emitting rather than running long. `cli` therefore uses `CHAT_IDLE_TIMEOUT_MS` (default
5m, re-armed by stdout/stderr; `interrupted: "timeout"`) plus `CHAT_MAX_TURN_MS` (default
1h ceiling; `"limit"`). If the idle variable is unset, `CHAT_TIMEOUT_MS` supplies it for
backward compatibility. Under `api`, `CHAT_TIMEOUT_MS` remains a total-elapsed HTTP cap.

**Stop is reachable from the transcript.** `GET /api/chat/running` lists in-flight
sessions; because the CLI id matches transcript `session:`, a detail page recognizes
itself and offers Stop after navigation/refresh. It polls every 3s, renders nothing while
idle, exposes no content, and keeps open GET CORS.

**Effective permission mode is reported.** The opening `system`/`init` event is read
immediately and returned as `effectivePermissionMode` beside requested `permissionMode`.
The start form and running bar expose divergence, such as an older server pinning its
default.

**Mode and permission mode are pinned at start** and cannot change later.

**Sessions are evicted.** "New chat" calls `POST /api/chat/sessions/end`, stops any
in-flight turn, and removes the session from memory. The dashboard chooses and sends the
session id at start because it is the `stop` handle; waiting for the response would leave
the first turn unstoppable.

**Request shape** under `api` is copied from a captured Claude Code request and defaulted to it:
`model: claude-opus-5`, `max_tokens: 64000`, `stream: true`,
`anthropic-version: 2023-06-01`, an `x-claude-code-session-id` header, and a
`metadata.user_id` JSON blob. Two deliberate departures: no `anthropic-beta` list (the
CLI's entries are OAuth/CLI-specific; opt in with `CHAT_BETA`) and no `tools` (this is a
plain chat, not an agent loop). Every default is overridable by env —
`CHAT_TRANSPORT`, `CHAT_MODE`, `CHAT_BASE_URL`/`ANTHROPIC_BASE_URL`, `CHAT_MODEL`,
`CHAT_MAX_TOKENS`, `CHAT_SYSTEM`, `CHAT_BETA`, `CHAT_TIMEOUT_MS`,
`CHAT_IDLE_TIMEOUT_MS`/`CHAT_MAX_TURN_MS` for the two `cli` clocks, plus `CHAT_CLI_PATH` for
the child and `CHAT_CLI_CWD` for a `chat` turn's scratch cwd (an agent turn's cwd is the
server's checkout and takes no override), `CHAT_AGENT_ALIAS`/`CHAT_AGENT_PERMISSION_MODE` for agent
turns, and `CHAT_ALLOWED_ORIGINS` for the write surface — and per-request by
`model`/`maxTokens`/`system` in the body, plus `mode`, `permissionMode` and `sessionId` on
start.

**Chat routes do not answer `*`.** Read routes serve
`access-control-allow-origin: *`; the seven command-capable POSTs (the four chat routes,
suggestion status, job delete, the device system prompt) echo only allowed
origins—`http://localhost:5173` and `http://127.0.0.1:5173` by default, overridden by
comma-separated `CHAT_ALLOWED_ORIGINS`. A declared foreign origin gets `403`; no-Origin
clients such as curl/tests are unaffected. This scopes browsers but is not authentication.

The Vite server uses `strictPort`: if 5173 is occupied it fails instead of moving to 5174
and receiving `403` for every POST. Add any second-checkout, preview, or remote origin to
`CHAT_ALLOWED_ORIGINS`.

**One-shot filter exemption.** The proxy normally buffers a first sighting until the
thread grows, excluding one-shot helpers. Dashboard chats declare interactivity on turn
one: `api` sends `x-claude-proxy-chat: 1`; CLI cannot set headers, so the server creates
`<store>/.chat/<session id>.json` before spawn. `proxy/session.ts` treats both alike.
Markers live beside, not inside, SSE-watched `sessions/`, expire after 7 days, and are
never created for ordinary Claude Code.

**Transcript links use the written id.** The server briefly polls the proxy-written
`- session:` line after the answer, returning the actual thread id for an "open
transcript" link to `/sessions/$id`. It cannot predict the fingerprint because the CLI
wraps the first user message in unseen harness context.

**Starts stay in their pane.** Send and reply remain on Sessions; the rail marks the run
and exposes an "open transcript" link rather than navigating to `/sessions/$id`. Because
the unsent request has no thread fingerprint yet,
`useChatThread(sessionId, enabled)` asks `GET /api/chat/thread?sessionId=`. The lookup
reads the sessions directory, survives server restart, outlives the turn, and resolves
~2s into a real run so highlighting/linking appear before the answer.

**The session route accepts a pre-turn chat id.** Dashboard ids are UUIDs; thread ids are
16 hex characters, so they cannot collide. A bookmarked/shared pre-resolution URL waits,
then replaces itself with the thread id when written; after two minutes it reports no
transcript and stops polling. Because lookup is disk-backed, reloading the temporary URL
still reaches the transcript.

**The conversation follows navigation.** Router-level state preserves turn log, Stop,
pending prompt, and unsent draft. The owning session page renders prompt/reply plus a
continuation input between stats and the durable, one-turn-lagging transcript; unrelated
Claude Code sessions are unchanged. Drafts clear on submit and "New chat".

**In-flight prompts render immediately** as a user turn above the reply as it arrives,
without waiting for returned history. The session page suppresses its duplicate
running-turn Stop bar when this tab owns the turn.

**The reply and its tool activity are one stream, not two features.** Both transports
already decode a stream that interleaves text with the tools a turn runs — `chat-cli.ts`'s
`CliLiveReader` over the headless child's `stream-json` stdout, and `chat.ts`'s
`readStreamedBody` over `/v1/messages` SSE — so that same interleaving is re-emitted through
the dashboard's existing `serveSse` plumbing on `GET /api/chat/stream?sessionId=`. The
bubble appends text as it lands and appends a chip per tool in the order the turn actually
ran them, which turns the chips from a post-hoc summary into a live account of the turn. The
composer's summary chip row is hidden while a turn is in flight, since the bubble is
carrying that turn's chips and the row still holds the previous turn's.

**The stream is an accessory; the POST is the record.** `server/src/chat-stream.ts` is a
per-session bus of live-turn buffers, keyed by session id independently of the session map —
the dashboard names its session id before turn one and opens the stream in the same tick as
the POST, so a reader routinely asks for a session the server has not heard of yet. Nothing
about a turn depends on anyone watching: `ChatSendResult` is still decoded from the whole
stream, and the browser replaces the live bubble with it when the POST resolves. So a
dropped stream re-reads the finished reply rather than leaving a half-written one on screen,
and there is no retry policy beyond `EventSource`'s own reconnect, which is answered with a
snapshot of the live buffer. A turn that outruns the 4,000-event replay buffer keeps
streaming; only the replay is trimmed, and the frame says `truncated` so a reader is told
there is a hole rather than shown one. Because the frames carry chat content, the route is
origin-checked like the write routes rather than open like the other read routes.

**The live region moves onto the streaming bubble** rather than being deleted with the
`Working…` span it replaces — otherwise a screen reader loses the turn's only announcement.
It carries a short status ("Reply arriving — 3 tools run so far"), and the streaming prose
and chips are `aria-hidden`, because a live region over streaming markdown re-announces a
half-written document on every append.

**Input** follows shadcn AI prompt-input anatomy: hand-rolled auto-growing textarea,
Enter send, Shift+Enter newline, IME safety, and a send button disabled in flight. The
plain-CSS app has no Tailwind or `components.json`, so `shadcn add` cannot be used.

Flow: `apps/admin` (Sessions page `PromptInput`) → `server` (`/api/chat/*`, `chat.ts`,
`chat-cli.ts`) → `claude --print` *or* a keyed `fetch` → `proxy` (`/v1/messages`, logging +
`session.ts`) → `api.anthropic.com`. The chat POSTs are four of the server's seven write
routes — suggestion status, job delete and the device system prompt are the others; every
other route stays read-only.

## Acceptance criteria

- [x] `GET /api/chat/config` reports the transport, the live mode, the agent posture (cwd,
      the alias being mirrored and whether it was found, the tools it withholds, the
      permission mode), the resolved base URL, model, max tokens, system prompt, anthropic
      version, beta list, where `claude` resolved to, whether an API key is set, and
      whether a chat can start at all.
- [x] `POST /api/chat/sessions` starts a session from one prompt and returns the session
      id, thread id, the reply, token usage, and the turn list.
- [x] `POST /api/chat/sessions/message` continues a session — by CLI resume under `cli`,
      by replaying the full history under `api` — so the transcript grows.
- [x] The request goes to the **proxy's** base URL, so it lands in the proxy's logs and
      transcripts like any other request, whichever transport carried it.
- [x] Local dev needs no credential: with `CHAT_TRANSPORT` unset and no `ANTHROPIC_API_KEY`
      anywhere, a chat starts and the turn bills the device's own Claude Code login.
- [x] `CHAT_TRANSPORT=api` without a key reports `ready: false`, the UI disables the input,
      and a send returns `503` naming the missing key.
- [x] Errors map to meaningful statuses: `400` bad body/prompt, `404` unknown session,
      `405` non-POST, `502` upstream, stream, or CLI failure, `503` unconfigured. Bodies
      over 1 MB are rejected.
- [x] A failed send leaves history untouched — the user turn is popped back off, so the
      next attempt matches what the model last saw.
- [x] A thread that declares itself interactive is written on its first turn — by header or
      by marker file — and its header block is still written exactly once when it later
      grows. Both doors are covered in `proxy/proxy.test.ts`, each alongside a case proving
      an undeclared request still buffers.
- [x] The Sessions page renders the config line, the turn log (assistant text as Markdown),
      the prompt input, token counts, an "open transcript" link, and a "New chat" reset,
      and invalidates the sessions query after each turn.
- [x] A mode toggle picks `agent` or `chat` before the first turn and locks once a session
      exists, since the mode is pinned at start.
- [x] A permission picker on the same form chooses the standing answer per session, is
      accepted by `POST /api/chat/sessions`, is pinned like the mode, and is rejected with
      `400` outside the four the CLI defines. Proven live: the same `git config --local`
      write is denied under `acceptEdits` and succeeds under `bypassPermissions`, with no
      server restart between them.
- [x] `POST /api/chat/stop` ends the turn in flight and the send returns the partial stream
      — text and tool chips — tagged `interrupted`, rather than an error. The whole process
      group goes, so tools the CLI started are not orphaned; covered against a stand-in CLI
      that spawns a child of its own.
- [x] A timeout returns the same partial result rather than discarding stdout.
- [x] The idle clock is re-armed by the child's own output, so a turn that keeps streaming
      outlives the window many times over and only the ceiling ends it; a turn that goes
      silent is still ended at the window. Both covered against stand-in CLIs — one that
      emits on an interval, one that emits once and hangs.
- [x] `GET /api/chat/running` names the turns in flight, and a session detail page whose
      transcript carries a running chat's session id offers its own Stop — so a turn stays
      stoppable after the page that started it is gone. Confirmed live: a long agent turn
      appeared in the list, was stopped through the route, returned `interrupted: "stopped"`
      with its partial tools, and left the list.
- [x] The permission mode the child reports at startup is returned as
      `effectivePermissionMode`, while the turn is still running rather than after it, and a
      divergence from the requested mode is shown.
- [x] A failed tool chip carries its `tool_result` text, so a permission denial reads as a
      denial. Confirmed live: the chip shows `This command requires approval`.
- [x] The chat POST routes answer only the dashboard origin, refuse a declared foreign
      origin with `403`, and leave the read-only routes on `*`.
- [x] "New chat" evicts the session server-side (`POST /api/chat/sessions/end`), so the
      in-memory map does not grow with every chat a tab starts; a follow-up on an evicted
      id is `404`.
- [x] An agent turn expands a custom slash command from `~/.claude/commands` and runs a
      real tool, and the proxy's transcript shows both — proven end to end, on turn one.
- [x] A `chat` turn on the same server still reports zero tools, so the mode is additive.
- [x] `agent` requested over `CHAT_TRANSPORT=api` is rejected rather than downgraded.
- [x] Starting a session stays on `/sessions` — the send does not navigate, and the reply
      lands in the pane the prompt was typed in. The rail marks the running session and the
      "open transcript" link appears once the thread id resolves, mid-turn.
- [x] `GET /api/chat/thread?sessionId=` answers the transcript's thread id, `null` while it
      has yet to be written, `400` with no `sessionId`, and `400` for a `sessionId` that is
      not a uuid — the same shape the POST routes validate.
- [x] The poll is bounded: after two minutes with no transcript the page stops asking and
      says none arrived.
- [x] That page replaces its URL with the thread id once it resolves, so the address bar,
      a reload and a shared link all end on the transcript.
- [x] The session page carries a chat section between the stats and the transcript showing
      the prompt that was sent and the reply when it lands, and an input that continues the
      session from there. Confirmed live that the resolved transcript's `- session:` id is
      the chat's own session id, which is what attaches the section to the page.
- [x] The conversation survives navigating to a session or the graph — turn log, usage, tool
      chips, Stop, the prompt in flight and an unsent draft in the composer — because it is
      held above the router rather than in the Sessions page's state.
- [x] A start that fails shows its error in the pane it was typed in, and on the session page
      when the chat is opened there.
- [x] `CliLiveReader` reports the child's text and tools interleaved in the order the turn
      produced them, indexes each tool the way the finished decode does — so a live chip and a
      summary chip are the same chip — and reads the same events however the chunk boundaries
      fall, including mid-character and mid-line.
- [x] `GET /api/chat/stream?sessionId=` answers a session the server has never heard of with
      an empty inactive turn rather than a 404, replays the live turn to a reader that
      connects mid-turn, starts a new turn rather than appending to the last, and reports the
      turn ending and how it ended.
- [x] A turn that outruns the replay buffer keeps streaming; only the replay is trimmed, and
      the frame says `truncated` so the reader is told its text starts mid-reply.
- [x] The stream route validates `sessionId` as a uuid and answers a foreign origin `403`,
      the same shape the write routes use — it carries chat content, unlike every other read
      route.
- [x] A buffer whose last reader leaves mid-turn survives, so a reconnect still finds what it
      missed; an idle one is dropped, and "New chat" drops it outright.
- [x] The three-dot wait still renders until the first slice lands, so a browser with no
      `EventSource`, a blocked stream or a buffering proxy sees exactly the old behaviour and
      the reply lands whole when the POST resolves.
- [x] Proven end to end on a real `cli` agent turn: the raw frames arrive `tool` → `tool-result`
      → `text` in the order the turn ran them, bracketed by the opening and closing frames, and
      the foreign-origin `403` and non-uuid `400` were exercised against the running server.
- [x] Watched live in a browser at 5173 against this server: mid-turn the bubble carried the
      reply so far with `Bash` and `Read` chips beside it under the bubble's own rule, and when
      the turn resolved the finished reply replaced it and the composer's summary row came back.

## Open questions

- **The streamed reply is an accessory, so a browser that cannot open the stream sees the old
  behaviour.** `EventSource` carries no headers, so the stream is origin-checked rather than
  authenticated, and a reader behind a proxy that buffers `text/event-stream` gets nothing
  until the turn ends. That is a degradation and not a failure — the POST still answers with
  the finished reply — but it means the live view cannot be relied on as the only account of
  a turn.
- **The streamed prose is not announced.** The live region on the streaming bubble says a
  reply is arriving and how many tools have run; the text itself is `aria-hidden` until the
  turn resolves, because re-announcing half-written markdown on every append is noise rather
  than access. A screen reader therefore learns *that* the reply is coming and reads it once
  it is whole, rather than following it word by word.
- **Sessions are in-memory.** A server restart loses the handle on a chat (the transcript
  survives, and under `cli` so does the CLI's own session); resuming a chat from either is
  not implemented.
- **The transports differ in what they cost and what they produce.** `cli` adds Claude
  Code's own system prompt and its out-of-band titling request, so a CLI-started chat gets a
  real title in the sessions list and an `api` one does not. Comparing token counts across
  the two is not comparing like with like.
- **Agent mode has no authentication.** Apart from chat, suggestion-status, job-delete and
  device-system-prompt writes, the locally bound server is read-only. Origin checks constrain
  browsers, not direct
  callers; exposing the port (tunnel or `0.0.0.0`) still needs authentication. Until then,
  use `CHAT_MODE=chat`.
- **Tool arguments and results are still only in the transcript.** A live chip names the tool
  and, on failure, the first line of its `tool_result`; what it was called with and what it
  answered are the proxy's transcript's business. The chip says a turn is working, not what
  it did.
- **Permission mode is a standing answer, not a judgment.** A headless child cannot ask;
  `bypassPermissions` remains all-or-nothing for anything reaching the port. Real approval
  requires streaming permission requests to and from the dashboard.
- **Stopping is not resuming.** A stopped turn returns what it had, and the session stays
  open for a follow-up, but the next turn resumes a session whose last turn was cut off
  rather than continuing the work in place.
- **UI evidence is partial.** The streaming turn has been watched in a browser; the rest of
  the flow — the session page's chat section, the error states — was verified through the API,
  typecheck and build rather than visually.
- **The chat is one at a time, and in memory.** Held above the router, so it survives
  navigation, but not a reload and not a second concurrent chat. "New chat" still evicts
  it. A tab reloaded onto a pre-resolution URL recovers the transcript and loses the turn
  log.

## Related

- [Headless Chat Transport — Design Spec](../specs/2026-07-24-headless-chat-transport-design.md)
- [Dashboard Agent Mode — Design Spec](../specs/2026-07-25-dashboard-agent-mode-design.md)
- [Config inventory](config-inventory.md) — the shell-alias parser agent mode reuses
- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md)
- [Session transcripts](session-transcripts.md)
- [Live session graph](live-session-graph.md)
