---
type: feature
title: Dashboard chat sessions
description: A prompt input on the Sessions page that starts a real session through the proxy — by a headless Claude Code process in local dev, or a keyed HTTP client in a deployment — so the proxy logs and transcribes it and the new thread appears in the sessions list. Runs either as a full agent at parity with the device's own CLI, or in a sandboxed chat posture with no tools.
tags: [dashboard, backend, usage, auth]
timestamp: 2026-07-24
---

# Dashboard chat sessions

## Summary

The dashboard can now **start a session**, not only read the ones Claude Code left behind.
A prompt input at the top of the **Sessions** page posts to a new `POST /api/chat/sessions`
route on the server, and the turn goes out through the **proxy** — which treats it as
ordinary traffic: forwards it to `api.anthropic.com`, writes the
`.md`/`.request.txt`/`.audit.json` trio, and appends the turn to a session transcript. So
the chat shows up in the sessions table (live, over the existing SSE stream) and in every
usage digest, with no new logging path.

There are two transports to the proxy, chosen by `CHAT_TRANSPORT`:

- **`cli` (the default).** The server spawns a headless Claude Code — `claude --print`,
  pointed at the proxy — which authenticates itself from the device's own login. Local dev
  needs no credential in the server, and the turn bills the subscription already being paid
  for. Design detail: [Headless Chat Transport](../specs/2026-07-24-headless-chat-transport-design.md).
- **`api`.** A streamed `POST /v1/messages` carrying `ANTHROPIC_API_KEY`, in the header and
  body shape Claude Code sends. This is the path a deployment uses, where there is no
  interactive login to inherit.

The server holds the conversation in memory for display, and for replaying history on the
next turn under `api`; the durable record is the transcript the proxy writes.

Under `cli` the turn runs in one of two **modes**, and they differ in what a prompt is
allowed to do:

- **`agent` (the default).** A full Claude Code session at parity with the device's own —
  CLAUDE.md, settings, plugins, MCP servers, hooks, subagents, custom slash commands
  (`/task` works), and real tools, with the flags taken from the user's actual `claude`
  shell alias. **A prompt sent from the dashboard in this mode can read and write this
  repository and run commands in it.** That is the point of the mode and the cost of it;
  the box is reachable by anything that can reach the server's port. Its reach is bounded
  to one directory — the checkout the server itself is running from.
- **`chat`.** The sandboxed posture: no tools, no device customizations, a scratch cwd.
  Nothing a prompt says can reach the filesystem. Select it with `CHAT_MODE=chat` or per
  request; it is unchanged and remains fully supported.

`api` is always `chat` — a bare `/v1/messages` call has no harness to run a tool with, so
asking for `agent` over it is rejected rather than silently downgraded. Design detail:
[Dashboard Agent Mode](../specs/2026-07-25-dashboard-agent-mode-design.md).

## Motivation

Every dashboard page so far is read-only over already-captured logs, which means the only
way to produce data is to run Claude Code. Sending a turn *through* the proxy closes the
loop: the dashboard becomes both the producer and the reader, which makes the pipeline
testable end to end (chat, then watch the row appear, then read the transcript) without a
second client.

Routing through the proxy rather than straight to `api.anthropic.com` is the whole point.
A direct call would be invisible to every analytic in the repo. Going through the proxy
means the chat is logged, redacted, skim-eligible, and transcribed by exactly the code path
production traffic uses.

## Behavior

**Credentials are not borrowed.** The proxy forwards whatever `authorization` / `x-api-key`
its client sent and redacts them from the logs; it never supplies a credential. Neither does
the server: under `cli` the child process holds its own, and under `api` the key comes from
the environment. Claude Code's OAuth token is never lifted out of the keychain or
`~/.claude/.credentials.json` and replayed by hand — that would be presenting this dashboard
as Claude Code. `GET /api/chat/config` reports `ready` and, when it isn't, a `readyHint`
naming what is missing; the UI disables the input and shows that hint, and a send
returns `503`.

**The headless child in `chat` mode** runs with no tools (`--tools ""`, so nothing a prompt
says can reach the filesystem and a captured turn audits at `0 tools`), no device
customizations (`--safe-mode --strict-mcp-config` — which disables CLAUDE.md, skills,
plugins, hooks, MCP servers, custom commands *and* subagents), and a scratch cwd. The
proxy's base URL is passed through `--settings` rather than only the environment, because a
settings-file `env` block — which this repo's own README setup writes — otherwise wins and
sends the turn to a different proxy. History is the CLI's: turn one opens
`--session-id <uuid>`, later turns `--resume` it. Output is `stream-json`, decoded from its
terminal `result` event.

**The headless child in `agent` mode** drops exactly those three flags, which is what lets
the CLI load its normal setting sources. In their place it takes the flags parsed from the
user's `claude` shell alias — the same parser the config-inventory feature uses — so an
alias that withholds a tool withholds it here too, with no dashboard configuration. Its cwd
is the checkout the server is running from, resolved from the server's own module location;
when the server is launched out of `.claude/worktrees/<name>`, that worktree is the root,
which is deliberately the same root `LOG_DIR` resolves against. Because a `--print` child
has no one to answer a permission prompt, it carries a standing `--permission-mode`, chosen
per session and defaulting to `bypassPermissions`. Its system prompt is *appended*, so Claude Code
keeps its own.
Both modes strip `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the child environment, and
both force the base URL the same way.

**The permission mode is a per-session choice.** A `--print` child has no one to answer a
permission prompt, so it carries a standing `--permission-mode`, picked on the start form
next to the mode and pinned for the session's life. `CHAT_AGENT_PERMISSION_MODE` still sets
the default the form opens on, but it is no longer the only lever — changing it used to mean
restarting the server, and which answer a turn needs is a property of that turn. A value
outside the four is ignored with a warning and `bypassPermissions` is used instead, since an
unchecked default would be rejected by the CLI a turn later and would leave the form's
select with no option matching its own value.

What each one does to a *command* is the part worth stating, because the narrower modes
surprise:

- **`bypassPermissions` (the default).** Nothing is asked and nothing is denied: commands
  run, git writes included. This is the mode `/task` needs, so it is the one the form opens
  on — the narrower modes are there for turns that should not be able to act.
- **`acceptEdits`.** File edits are pre-approved; Bash is not. A command the CLI classifies
  as read-only still runs (`git status --short` does), but any command that *would* have
  prompted comes back `This command requires approval` and is denied, because there is
  nobody to approve it. Every mutating command is in that group — so an agent turn under it
  can rewrite a file and cannot `git commit` it, and `/task` stalls at its first git write.
- **`default`.** Every gated tool asks, which in a headless child means it is denied.
- **`plan`.** Read-only; the turn plans and does not act.

Sandbox limits are separate and still apply under every one of them: a write outside the
session's working directory is blocked by the CLI regardless of permission mode.

**Tool activity is surfaced, not dropped.** An agent turn's `tool_use` blocks are collected
in order from the stream and matched by id to their `tool_result`, so a failed tool is
marked; the send response carries the list and the Sessions page renders it as chips under
the reply. A failure carries the `tool_result`'s own text (trimmed to 400 characters) and
the chip shows it, because `Bash ✗` on its own reads as a broken tool or an auth problem
when it is usually the permission mode declining — the chip now says
`This command requires approval` and means it. It is still a summary; the full record of
every call is what the proxy already writes to the transcript.

**A turn can be stopped.** `POST /api/chat/stop` ends the run in flight without ending the
session. The child is spawned **detached**, so it leads its own process group, and stopping
signals the whole group — SIGTERM, then SIGKILL for anything still alive 3s later. That is
the difference between ending a turn and orphaning the shells and subagents an agent turn
started, which would keep working in the repo with nothing left to report to. The `send`
that was in flight does not fail: it returns the prefix of the stream that arrived, so the
text and the tool chips the turn got through survive, tagged `interrupted: "stopped"`. A
turn ended by either clock below takes the same path rather than throwing the output away.

**A turn is timed on silence, not on how long it takes.** An agent turn is a tool loop that
can legitimately run for an hour, so a total-elapsed budget kills healthy work mid-loop: a
`/revive` run that streamed steadily for 294s was SIGTERMed at the 300s cap with an edit
issued and never applied, leaving the branch half-changed. What actually wants catching is
a *wedged* run — a hung tool, a permission prompt a headless child cannot answer — and under
`--output-format stream-json` that shows up as a stream that has stopped emitting. So the
`cli` transport runs two clocks: `CHAT_IDLE_TIMEOUT_MS` (default 5m) is re-armed by every
chunk of stdout or stderr and reports `interrupted: "timeout"`, while `CHAT_MAX_TURN_MS`
(default 1h) is the absolute ceiling on one turn and reports `"limit"`. They are reported
apart because they say different things: one turn went quiet, the other simply ran out of
room. `CHAT_TIMEOUT_MS` still sets the idle window when the newer variable is unset, so a
deployment that tuned it keeps its value — now spent per silence rather than per turn. The
`api` transport keeps `CHAT_TIMEOUT_MS` as a plain total-elapsed cap, which is the right
shape for a single HTTP request.

**Stop is reachable from the transcript, not only from the tab that started the chat.** The
Sessions page holds a running turn in component state, so navigating away — or that page
refreshing under it — takes the Stop button away while the child keeps working; the turn
that most needs stopping is exactly the long one you walk away from. `GET /api/chat/running`
names the turns in flight, and because a running chat's CLI session id is the same `session:`
the proxy records in the transcript, a session detail page recognises *itself* in that list
and offers its own Stop. It polls every 3s and renders nothing when the session is idle. The
route is a read — it names sessions, never their content — so it keeps the open CORS the
other `GET`s have.

**What the child is running under is reported, not assumed.** The stream's opening
`system`/`init` event states the permission mode the child actually started in, which is
read as it arrives (not at the end of the turn, since the first turn is the long one) and
returned as `effectivePermissionMode` alongside the requested `permissionMode`. They should
be identical; when they are not, the request never reached the child as asked — an older
server still running the previous code will pin its own default and silently ignore the
choice — and both the start form and the running bar say so. Without this, the only symptom
is a turn full of denials, which reads like a broken agent rather than a stale process.

**The mode is pinned when the session starts** and cannot change on a later turn, so what a
session was allowed to do is answerable from its first request alone. The permission mode is
pinned with it, for the same reason.

**Sessions are evicted, not accumulated.** "New chat" calls `POST /api/chat/sessions/end`,
which stops any turn in flight and drops the session from the server's map; without it every
chat a browser tab ever started stayed resident for the life of the process. The session id
is chosen by the *dashboard* and sent with the start request rather than read off its
response — it is the handle `stop` needs, and waiting for the response would leave the first
turn, the long one, the only turn that cannot be stopped.

**Request shape** under `api` is copied from a captured Claude Code request and defaulted to it:
`model: claude-opus-5`, `max_tokens: 64000`, `stream: true`,
`anthropic-version: 2023-06-01`, an `x-claude-code-session-id` header, and a
`metadata.user_id` JSON blob. Two deliberate departures: no `anthropic-beta` list (the
CLI's entries are OAuth/CLI-specific; opt in with `CHAT_BETA`) and no `tools` (this is a
plain chat, not an agent loop). Every default is overridable by env —
`CHAT_TRANSPORT`, `CHAT_MODE`, `CHAT_BASE_URL`/`ANTHROPIC_BASE_URL`, `CHAT_MODEL`,
`CHAT_MAX_TOKENS`, `CHAT_SYSTEM`, `CHAT_BETA`, `CHAT_TIMEOUT_MS`,
`CHAT_IDLE_TIMEOUT_MS`/`CHAT_MAX_TURN_MS` for the two `cli` clocks, plus `CHAT_CLI_PATH` and
`CHAT_CLI_CWD` for the child, `CHAT_AGENT_ALIAS`/`CHAT_AGENT_PERMISSION_MODE` for agent
turns, and `CHAT_ALLOWED_ORIGINS` for the write surface — and per-request by
`model`/`maxTokens`/`system` in the body, plus `mode`, `permissionMode` and `sessionId` on
start.

**The chat routes do not answer `*`.** Every read-only route serves
`access-control-allow-origin: *`, which is fine for a view over already-captured logs. The
four POST routes cannot share it: one of them starts an agent turn that runs commands in
this checkout, and `*` would let any page the browser happens to be on drive one. They echo
only an allowed origin — `http://localhost:5173` and its `127.0.0.1` form by default,
overridable with a comma-separated `CHAT_ALLOWED_ORIGINS` — and a request that *declares* a
different origin is refused with `403` rather than trusting the browser to withhold the
response it already produced. A request with no `Origin` at all (curl, a test) is unaffected.
This is a scope fix, not an auth story; the open question below still stands.

Because the default list names a port, the dashboard has to actually be on it: the admin
Vite server is `strictPort`, so a taken 5173 fails the dev server outright instead of
sliding to 5174 and leaving a dashboard whose every chat POST comes back `403`. Serving the
dashboard from any other origin — a second checkout, a preview build, another host — means
naming that origin in `CHAT_ALLOWED_ORIGINS`.

**One-shot filter exemption.** The proxy suppresses a thread's first sighting and flushes
it only once the thread reappears larger, which is how one-shot helper calls stay out of
the sessions list. A chat started from the dashboard would therefore be invisible until its
second turn. It declares itself instead — a human is waiting on the Sessions page for it, so
it is interactive by construction — through either of two doors. The `api` transport sends
`x-claude-proxy-chat: 1`. The CLI builds its own headers and cannot, so the server writes a
marker file, `<store>/.chat/<session id>.json`, before it spawns; `proxy/session.mjs` treats
a declared session id exactly as it treats the header. Markers sit beside the store rather
than inside `sessions/` (which SSE watches) and are swept after 7 days. Claude Code itself
neither sends the header nor gets a marker, so the filter is otherwise unchanged.

**Linking to the transcript.** The thread id is read back from the transcript the proxy
wrote — matched on its `- session:` line, polled briefly because the proxy writes after it
has answered — so the response carries the id the transcript actually has and the card
renders an "open transcript" link straight to `/sessions/$id`. It is not predicted: the
proxy fingerprints a thread from the first user message *as it went over the wire*, which
the CLI wraps in harness context this side never sees.

**Starting a session goes to that session's page.** The turn *is* the session, so watching
it from a list of every other session buries it; a send now navigates straight to
`/sessions/$id` and the reply lands there. The complication is that at the moment of
navigating there is no thread id to navigate to — see above, it is a fingerprint of a
request that has not been sent yet. So the session route accepts the *chat session id* as
well, which the dashboard chose before the first turn: it is a uuid, and a thread id is 16
hex characters, so the two can never be confused. That page polls
`GET /api/chat/thread?sessionId=`, which answers from the sessions dir rather than the
in-memory map — so it survives a server restart and outlives the turn — and replaces the URL
with the thread id the moment the transcript exists. Measured at ~2s on a real turn, which
is while the turn is still running rather than after it. Until then the page says it is
waiting for the transcript, and it gives up after two minutes — far past the moment a real
session writes its first request — so a start that never happened stops polling and says so. A reload on the pre-resolution URL still lands on the transcript,
because the lookup reads from disk and needs nothing the tab was holding.

**The conversation follows you there.** It used to live in the Sessions page's own component
state, which made starting a session and *reading* it mutually exclusive: navigating to the
transcript unmounted the card and took the turn log, the Stop button and the pending prompt
with it. It is held above the router instead, and rendered on the session page too — between
the stats and the transcript, in a section that shows the prompt that was sent and the reply
when it lands, with an input to carry on from there. The transcript below is the durable
record and lags a turn behind; this is the turn as it happens. It renders only for the
session it belongs to, so every session Claude Code left behind is unchanged.

The unsent input travels with them. What was typed into the composer but never sent used to
sit in the same component state the turn log did, so clicking through to a session or the
graph discarded it; the draft is held above the router alongside the turn log, the pending
prompt and the Stop button. It still clears where clearing is the point: on submit, since
the prompt is already on screen as a turn, and on "New chat", with the session it belonged
to.

**The prompt in flight is shown as a turn.** The server returns history only once the turn
resolves and an agent turn can run for an hour, so a page you were just navigated to would
otherwise sit empty with nothing saying what it is working on. The prompt is rendered as a
user turn the moment it is handed off, above a `Working…` placeholder. For the same reason
the session page suppresses its own running-turn Stop bar when *this* tab is the one running
the turn — the chat section already offers that turn's Stop, and two of them invite pressing
the second after the first has taken.

**The input** is the shadcn AI prompt-input anatomy — one auto-growing textarea, Enter to
send, Shift+Enter for a newline, IME-safe, a button that disables while a send is in
flight. It is hand-rolled: this app styles itself with plain CSS tokens and has no Tailwind
or `components.json`, so `shadcn add` has nothing to write into.

Flow: `apps/admin` (Sessions page `PromptInput`) → `server` (`/api/chat/*`, `chat.ts`,
`chat-cli.ts`) → `claude --print` *or* a keyed `fetch` → `proxy` (`/v1/messages`, logging +
`session.mjs`) → `api.anthropic.com`. The chat routes are the only non-`GET` routes the
server accepts; everything else stays read-only.

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
      grows. Both doors are covered in `proxy/proxy.test.mjs`, each alongside a case proving
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
      that spawns a child of its own, and confirmed live against a real agent turn.
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
      divergence from the requested mode is shown rather than left to be inferred from a
      turn full of denials.
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
- [x] Starting a session navigates to `/sessions/$id` immediately, addressed by the chat
      session id, without waiting on the turn.
- [x] `GET /api/chat/thread?sessionId=` answers the transcript's thread id, `null` while it
      has yet to be written, `400` with no `sessionId`, and `400` for a `sessionId` that is
      not a uuid — the same shape the POST routes validate. Confirmed live against an
      existing transcript, an unknown id, and a real turn — which resolved ~2s in, while the
      turn was still running.
- [x] The poll is bounded: after two minutes with no transcript the page stops asking and
      says none arrived, rather than polling forever on a start that failed or on a uuid
      someone typed into the address bar.
- [x] That page replaces its URL with the thread id once it resolves, so the address bar,
      a reload and a shared link all end on the transcript.
- [x] The session page carries a chat section between the stats and the transcript showing
      the prompt that was sent and the reply when it lands, and an input that continues the
      session from there. Confirmed live that the resolved transcript's `- session:` id is
      the chat's own session id, which is what attaches the section to the page.
- [x] The conversation survives the navigation — turn log, usage, tool chips, Stop, the
      prompt in flight and an unsent draft in the composer — because it is held above the
      router rather than in the Sessions page's state.
- [x] A start that fails after navigating still shows its error on the session page rather
      than dropping the section for want of a turn.

## Open questions

- **The reply is not streamed to the browser.** The server decodes the whole SSE stream and
  returns the finished text, so a long answer shows nothing until it completes. Streaming it
  onward would reuse the dashboard's existing `serveSse` plumbing.
- **Sessions are in-memory.** A server restart loses the handle on a chat (the transcript
  survives, and under `cli` so does the CLI's own session); resuming a chat from either is
  not implemented.
- **The transports differ in what they cost and what they produce.** `cli` adds Claude
  Code's own system prompt and its out-of-band titling request, so a CLI-started chat gets a
  real title in the sessions list and an `api` one does not. Comparing token counts across
  the two is not comparing like with like.
- **Agent mode has no authentication in front of it.** The server is read-only apart from
  the chat routes and binds locally, and those routes now answer only the dashboard's
  origin — but an origin check is a browser-side control, and the mode's whole premise is
  that a POST body can cause work on the machine. Anything that can reach the port directly
  is unaffected by it. Exposing this port — a tunnel, a bind to `0.0.0.0` — still needs a
  real auth story, and there isn't one yet. `CHAT_MODE=chat` is the answer in the meantime.
- **Tool activity is summarized, not streamed.** Chips name the tools a turn ran, mark
  failures and say why; arguments and full results are only in the proxy's transcript. A
  long agent turn still shows nothing until it finishes or is stopped.
- **The permission mode is a standing answer, not a judgment.** A headless child can't be
  asked, so every decision in an agent turn is pre-made when the session starts. Picking it
  per session narrows the gap — the choice is now made per task instead of per server
  process — but `bypassPermissions` is still all-or-nothing, and choosing it from a web form
  is choosing it for anything that can reach the port. A real approval path would mean
  streaming permission requests to the dashboard and back.
- **Stopping is not resuming.** A stopped turn returns what it had, and the session stays
  open for a follow-up, but the CLI's own view of that turn ended mid-flight; the next turn
  resumes a session whose last turn was cut off rather than continuing the work in place.
- **No UI screenshot evidence.** Browser automation was unavailable in the sessions that
  built this and that added the navigate-on-start flow, so the pages were verified through
  the API, the typecheck and the build, not visually. The navigation change in particular
  was proven at its seams — the resolve route against a real transcript and a real turn, and
  the id that attaches the chat section to the session page — but nobody has watched it
  happen.
- **The chat is one at a time, and in memory.** Held above the router now rather than in a
  page, so it survives navigation, but not a reload and not a second concurrent chat.
  "New chat" still evicts it. A tab reloaded onto a pre-resolution URL recovers the
  transcript and loses the turn log.

## Related

- [Headless Chat Transport — Design Spec](../specs/2026-07-24-headless-chat-transport-design.md)
- [Dashboard Agent Mode — Design Spec](../specs/2026-07-25-dashboard-agent-mode-design.md)
- [Config inventory](config-inventory.md) — the shell-alias parser agent mode reuses
- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md)
- [Session transcripts](session-transcripts.md)
- [Live session graph](live-session-graph.md)
