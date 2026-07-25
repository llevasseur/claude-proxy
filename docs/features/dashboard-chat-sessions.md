---
type: feature
title: Dashboard chat sessions
description: A prompt input on the Sessions page that starts a real session by posting /v1/messages through the proxy the way Claude Code does, so the proxy logs and transcribes it and the new thread appears in the sessions list.
tags: [dashboard, backend, usage]
timestamp: 2026-07-24
---

# Dashboard chat sessions

## Summary

The dashboard can now **start a session**, not only read the ones Claude Code left behind.
A prompt input at the top of the **Sessions** page posts to a new `POST /api/chat/sessions`
route on the server; the server sends a streamed `POST /v1/messages` request to the
**proxy's** base URL, with the same headers and body shape Claude Code sends. The proxy
treats it as ordinary traffic: it forwards it to `api.anthropic.com`, writes the
`.md`/`.request.txt`/`.audit.json` trio, and appends the turn to a session transcript — so
the chat shows up in the sessions table (live, over the existing SSE stream) and in every
usage digest, with no new logging path.

The server holds the conversation in memory only for replaying history on the next turn;
the durable record is the transcript the proxy writes.

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
its client sent and redacts them from the logs; it never supplies a credential. So the chat
path needs its own `ANTHROPIC_API_KEY` in the server's environment. Claude Code's OAuth
token is deliberately not reused — it is not read from the keychain or
`~/.claude/.credentials.json`. With no key set, `GET /api/chat/config` reports
`apiKeySet: false`, the UI disables the input and says so, and a send returns `503`.

**Request shape** is copied from a captured Claude Code request and defaulted to it:
`model: claude-opus-5`, `max_tokens: 64000`, `stream: true`,
`anthropic-version: 2023-06-01`, an `x-claude-code-session-id` header, and a
`metadata.user_id` JSON blob. Two deliberate departures: no `anthropic-beta` list (the
CLI's entries are OAuth/CLI-specific; opt in with `CHAT_BETA`) and no `tools` (this is a
plain chat, not an agent loop). Every default is overridable by env —
`CHAT_BASE_URL`/`ANTHROPIC_BASE_URL`, `CHAT_MODEL`, `CHAT_MAX_TOKENS`, `CHAT_SYSTEM`,
`CHAT_BETA`, `CHAT_TIMEOUT_MS` — and per-request by `model`/`maxTokens`/`system` in the
body.

**One-shot filter exemption.** The proxy suppresses a thread's first sighting and flushes
it only once the thread reappears larger, which is how one-shot helper calls stay out of
the sessions list. A chat started from the dashboard would therefore be invisible until its
second turn. The dashboard's chat declares itself with `x-claude-proxy-chat: 1`, and
`proxy/session.mjs` treats a thread carrying that header as confirmed on sight — a human is
waiting on the Sessions page for it, so it is interactive by construction. Claude Code
never sends the header, so the filter is otherwise unchanged.

**Linking to the transcript.** The thread id is `sha256(sessionId + "\n" + firstUserText)`
truncated to 16 chars, computable before the first send, so the response carries it and the
card renders an "open transcript" link straight to `/sessions/$id`. The TS mirror of that
digest is pinned against drift by a fixed-value assertion in `proxy/proxy.test.mjs`.

**The input** is the shadcn AI prompt-input anatomy — one auto-growing textarea, Enter to
send, Shift+Enter for a newline, IME-safe, a button that disables while a send is in
flight. It is hand-rolled: this app styles itself with plain CSS tokens and has no Tailwind
or `components.json`, so `shadcn add` has nothing to write into.

Flow: `apps/admin` (Sessions page `PromptInput`) → `server` (`/api/chat/*`, `chat.ts`) →
`proxy` (`/v1/messages`, logging + `session.mjs`) → `api.anthropic.com`. The chat routes
are the only non-`GET` routes the server accepts; everything else stays read-only.

## Acceptance criteria

- [x] `GET /api/chat/config` reports the resolved base URL, model, max tokens, system
      prompt, anthropic version, beta list, and whether an API key is set.
- [x] `POST /api/chat/sessions` starts a session from one prompt and returns the session
      id, thread id, the reply, token usage, and the turn list.
- [x] `POST /api/chat/sessions/message` continues a session, replaying the full history so
      the transcript grows.
- [x] The request goes to the **proxy's** base URL with Claude Code's header and body
      shape, so it lands in the proxy's logs and transcripts like any other request.
- [x] The chat supplies its own `ANTHROPIC_API_KEY`; with none set the config reports
      `apiKeySet: false`, the UI disables the input, and a send returns `503`.
- [x] Errors map to meaningful statuses: `400` bad body/prompt, `404` unknown session,
      `405` non-POST, `502` upstream or stream failure, `503` missing key. Bodies over
      1 MB are rejected.
- [x] A failed send leaves history untouched — the user turn is popped back off, so the
      next attempt matches what the model last saw.
- [x] A thread sending `x-claude-proxy-chat: 1` is written on its first turn, and its header
      block is still written exactly once when it later grows — covered in
      `proxy/proxy.test.mjs`, alongside a case proving a request *without* the marker still
      buffers.
- [x] The Sessions page renders the config line, the turn log (assistant text as Markdown),
      the prompt input, token counts, an "open transcript" link, and a "New chat" reset,
      and invalidates the sessions query after each turn.

## Open questions

- **The reply is not streamed to the browser.** The server decodes the whole SSE stream and
  returns the finished text, so a long answer shows nothing until it completes. Streaming it
  onward would reuse the dashboard's existing `serveSse` plumbing.
- **Sessions are in-memory.** A server restart loses the replayable history (the transcript
  survives); resuming a chat from a transcript is not implemented.
- **No tools, no agent loop.** Chat only. Anything that would make this an agent —
  `tools`, `tool_result` turns, subagents — is out of scope and would change what the
  transcripts mean.
- **No UI screenshot evidence.** Browser automation was unavailable in the session that
  built this, so the page was verified through the API and the build, not visually.

## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md)
- [Session transcripts](session-transcripts.md)
- [Live session graph](live-session-graph.md)
