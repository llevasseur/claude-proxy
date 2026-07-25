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
has no one to answer a permission prompt, it carries a standing `--permission-mode`
(`acceptEdits` by default). Its system prompt is *appended*, so Claude Code keeps its own.
Both modes strip `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the child environment, and
both force the base URL the same way.

**Tool activity is surfaced, not dropped.** An agent turn's `tool_use` blocks are collected
in order from the stream and matched by id to their `tool_result`, so a failed tool is
marked; the send response carries the list and the Sessions page renders it as chips under
the reply. It is a summary — the full record of every call is what the proxy already writes
to the transcript.

**The mode is pinned when the session starts** and cannot change on a later turn, so what a
session was allowed to do is answerable from its first request alone.

**Request shape** under `api` is copied from a captured Claude Code request and defaulted to it:
`model: claude-opus-5`, `max_tokens: 64000`, `stream: true`,
`anthropic-version: 2023-06-01`, an `x-claude-code-session-id` header, and a
`metadata.user_id` JSON blob. Two deliberate departures: no `anthropic-beta` list (the
CLI's entries are OAuth/CLI-specific; opt in with `CHAT_BETA`) and no `tools` (this is a
plain chat, not an agent loop). Every default is overridable by env —
`CHAT_TRANSPORT`, `CHAT_MODE`, `CHAT_BASE_URL`/`ANTHROPIC_BASE_URL`, `CHAT_MODEL`,
`CHAT_MAX_TOKENS`, `CHAT_SYSTEM`, `CHAT_BETA`, `CHAT_TIMEOUT_MS`, plus `CHAT_CLI_PATH` and
`CHAT_CLI_CWD` for the child and `CHAT_AGENT_ALIAS`/`CHAT_AGENT_PERMISSION_MODE` for agent
turns — and per-request by `model`/`maxTokens`/`system` in the body, plus `mode` on start.

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
- [x] An agent turn expands a custom slash command from `~/.claude/commands` and runs a
      real tool, and the proxy's transcript shows both — proven end to end, on turn one.
- [x] A `chat` turn on the same server still reports zero tools, so the mode is additive.
- [x] `agent` requested over `CHAT_TRANSPORT=api` is rejected rather than downgraded.

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
  the chat routes and binds locally, but the mode's whole premise is that a POST body can
  cause work on the machine. Anything that exposes this port — a tunnel, a bind to `0.0.0.0`
  — needs an auth story first, and there isn't one yet. `CHAT_MODE=chat` is the answer in
  the meantime.
- **Tool activity is summarized, not streamed.** Chips name the tools a turn ran and mark
  failures; arguments and results are only in the proxy's transcript. A long agent turn
  shows nothing until it finishes.
- **`acceptEdits` is a standing answer, not a judgment.** A headless child can't be asked,
  so every permission decision in an agent turn is pre-made. A real approval path would
  mean streaming permission requests to the dashboard and back.
- **No UI screenshot evidence.** Browser automation was unavailable in the session that
  built this, so the page was verified through the API and the build, not visually.

## Related

- [Headless Chat Transport — Design Spec](../specs/2026-07-24-headless-chat-transport-design.md)
- [Dashboard Agent Mode — Design Spec](../specs/2026-07-25-dashboard-agent-mode-design.md)
- [Config inventory](config-inventory.md) — the shell-alias parser agent mode reuses
- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md)
- [Session transcripts](session-transcripts.md)
- [Live session graph](live-session-graph.md)
