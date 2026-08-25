---
type: design
title: Headless Chat Transport — Design Spec
description: Run dashboard chat through a headless Claude Code process in local dev so it bills the device's own subscription, keeping the API-key HTTP client as the transport a deployment uses.
tags: [chat, dashboard, proxy, auth, design]
timestamp: 2026-07-24
scope: claude
---

# Headless Chat Transport — Design Spec

**Date:** 2026-07-24
**Status:** Shipped
**Feature:** [Dashboard chat sessions](../features/dashboard-chat-sessions.md)
**Extended by:** [Dashboard Agent Mode](2026-07-25-dashboard-agent-mode-design.md) — the
locked-down child described here is now one of two modes, and no longer the default.

## Problem

[Dashboard chat sessions](../features/dashboard-chat-sessions.md) shipped with one outbound
path: a hand-rolled streamed `POST /v1/messages` carrying `ANTHROPIC_API_KEY`. That is the
right shape for a deployment and the wrong one for the machine this repo is developed on.
Locally the developer already pays for Claude Code, and the dashboard is a window onto that
same traffic — so a chat box that only works if you *also* hold a metered API key is a
setup step that buys nothing.

The obvious shortcut is wrong. Claude Code's subscription credential is an OAuth token held
for Claude Code, and copying it into a bespoke HTTP client means presenting that client as
Claude Code. This spec does not do that, and the code does not read the keychain or
`~/.claude/.credentials.json`.

## Approach

Stop hand-rolling the request in local dev. Let **Claude Code make it**, headless, as a
child process, and point that child at the proxy:

```
apps/admin  →  server /api/chat/*  →  claude --print  →  proxy  →  api.anthropic.com
```

The CLI authenticates itself from the device's own login, so the server holds no
credential at all. To the proxy the result is an ordinary CLI turn — the same request
shape, the same session header, the same capture path. Nothing about logging, redaction,
skim, or transcripts changes, which is the property worth protecting.

The existing HTTP client stays, unchanged in shape, as the second transport:

| | `cli` (default) | `api` |
|---|---|---|
| Selected by | default, or `CHAT_TRANSPORT=cli` | `CHAT_TRANSPORT=api` |
| Auth | the device's Claude Code login, held by the child | `ANTHROPIC_API_KEY` in the server env |
| Billing | the developer's subscription | metered API usage |
| Intended for | local dev | a deployment, where no interactive login exists |
| History | the CLI's own session store, resumed | `messages[]` replayed each turn |

`GET /api/chat/config` reports which transport is live, whether it is `ready`, and a
`readyHint` naming what is missing when it is not — a missing key for `api`, a missing
`claude` binary for `cli`.

## The child process

```
claude --print
       --output-format stream-json --verbose
       --settings '{"env":{"ANTHROPIC_BASE_URL":"<proxy>"}}'
       --tools ""
       --safe-mode --strict-mcp-config
       --model <model> --system-prompt <system>
       (--session-id <uuid> | --resume <uuid>)
```

with the prompt on stdin, in a scratch cwd, and with `ANTHROPIC_API_KEY` /
`ANTHROPIC_AUTH_TOKEN` deleted from the child's environment.

Four of those choices are load-bearing:

- **`--settings` carries the base URL, not just the environment.** A device set up per this
  repo's README puts `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json`, and settings
  `env` beats the inherited process environment. Passing the URL only as an env var sends
  the turn to whatever proxy that file names — verified by watching a turn land in the
  wrong store.
- **`--tools ""` makes it a chat.** No tool definitions are sent (a captured turn audits at
  `0 tools`, ~200 input tokens), and nothing a dashboard prompt says can reach the
  filesystem. This is the safety boundary as much as the cost one: the chat box is exposed
  over HTTP, and an agent loop behind it would be an arbitrary-code-execution surface.
- **Stripping `ANTHROPIC_API_KEY` from the child.** Its presence would silently move the
  turn onto key billing — the other transport's job, chosen explicitly.
- **`--safe-mode --strict-mcp-config`.** A dashboard chat should not vary with the
  device's CLAUDE.md, hooks, plugins, or MCP servers.

Output is newline-delimited JSON. The terminal `result` event carries the finished reply
(`result`), billed `usage`, and `is_error`; `assistant` events are the fallback when a run
ends without one. This is a different decoder from the `api` transport's SSE parse, so both
live side by side: `decodeCliStream` and `decodeChatStream`.

## Consequences the transport forces

**The interactive exemption needs a second door.** The proxy buffers a thread's first
sighting and writes it only once the thread reappears larger, which keeps one-shot helpers
out of the sessions list. The `api` transport opts out with `x-claude-proxy-chat: 1`; the
CLI builds its own headers and cannot be made to send one. So the server *declares* the
session id before it spawns, by writing `<store>/.chat/<session id>.json`, and
`proxy/session.mjs` treats a declared session id exactly as it treats the header. Markers
live beside the store rather than inside `sessions/`, which the dashboard's SSE watches,
and are swept after 7 days.

**Thread ids can no longer be predicted.** The proxy fingerprints a thread from the first
user message *as it went over the wire*, and the CLI wraps a prompt in harness context the
server never sees. The precomputed mirror of that digest is therefore deleted; the server
instead reads the id back from the transcript, matching on the `- session:` line, polling
briefly because the proxy writes after it has answered. This is strictly more correct — it
now reports the id the transcript actually has — and it applies to both transports.

**A first turn resolves only because of the marker.** Without it the transcript would not
exist until turn two and the "open transcript" link would be dark on the first reply.

**Cost profile differs by transport.** `api` sends exactly the running `messages[]`. `cli`
adds Claude Code's own system prompt and its out-of-band titling request — which is also
why a CLI-started chat gets a real title in the sessions list, and an `api` one does not.

## Alternatives rejected

- **Reuse the OAuth token in the HTTP client.** Impersonates Claude Code; out of bounds.
- **`--bare`.** Would strip the harness nicely, but it documents auth as strictly
  `ANTHROPIC_API_KEY`/`apiKeyHelper` with OAuth and keychain never read — the opposite of
  the goal.
- **`@anthropic-ai/claude-agent-sdk` instead of spawning.** Same auth story, but it puts a
  dependency in a workspace whose server has none, to wrap a process boundary we want
  anyway.
- **Make `cli` the only transport.** A deployment has no interactive login to inherit, so
  the key path has to survive.

## Acceptance

- [x] Default transport is `cli`; a chat starts with no `ANTHROPIC_API_KEY` anywhere.
- [x] The turn is captured by the proxy the server names, not by whichever proxy the
      device's settings name.
- [x] A captured turn audits at `0 tools`.
- [x] Turn one returns a thread id, and turn two continues the same thread by resume.
- [x] `CHAT_TRANSPORT=api` with no key returns `503` with an actionable message.
