---
type: design
title: Dashboard Agent Mode — Design Spec
description: Run a dashboard prompt as a full Claude Code session at parity with the device's own CLI — real tools, custom slash commands, the user's alias — bounded to this repo's checkout, alongside the sandboxed chat posture it does not replace.
tags: [chat, agent, dashboard, proxy, security, design]
timestamp: 2026-07-25
---

# Dashboard Agent Mode — Design Spec

**Date:** 2026-07-25
**Status:** Shipped
**Feature:** [Dashboard chat sessions](../features/dashboard-chat-sessions.md)
**Follows:** [Headless Chat Transport](2026-07-24-headless-chat-transport-design.md)

## Problem

[Headless Chat Transport](2026-07-24-headless-chat-transport-design.md) spawns a real
Claude Code and then removes almost everything that makes it Claude Code: `--safe-mode`
turns off CLAUDE.md, skills, plugins, hooks, MCP servers, **custom commands and
subagents**, and `--tools ""` removes the tools. What is left answers questions in a
scratch directory.

That was the right default for a box exposed over HTTP, but it is not what the dashboard
is for. Typing `/task` into it does nothing — not because the command is missing from the
device, but because the child was told not to look. The ask is the inverse posture: a
dashboard prompt should run **the same way the user's own `claude` runs**, alias and all.

The two postures are both legitimate and they are not reconcilable in one flag set. So
this spec adds a mode rather than changing one.

## Approach

The `cli` transport gains a **mode**, pinned per session:

| | `agent` (default) | `chat` |
|---|---|---|
| Selected by | default, or `CHAT_MODE=agent`, or `"mode":"agent"` in the start body | `CHAT_MODE=chat`, or `"mode":"chat"` |
| Tools | the device's real set, minus what the alias withholds | none (`--tools ""`) |
| Device config | loaded: CLAUDE.md, settings, commands, plugins, MCP, hooks, subagents | none (`--safe-mode --strict-mcp-config`) |
| `/task` and friends | work | do not exist |
| cwd | this repo's checkout | a scratch dir under `os.tmpdir()` |
| System prompt | `--append-system-prompt` (Claude Code keeps its own) | `--system-prompt` (replaces it) |
| Can change files | **yes** | no |

`api` is always `chat`: a bare `POST /v1/messages` has no harness to run a tool with, so
`startChat` rejects `agent` over that transport rather than pretending.

The mode is **fixed when the session starts** and carried on the in-memory session. A
chat cannot gain — or lose — the ability to act on a later turn, which keeps "what could
this session have done?" answerable from its first request alone.

### The child, in agent mode

```
claude --print
       --output-format stream-json --verbose
       --settings '{"env":{"ANTHROPIC_BASE_URL":"<proxy>"}}'
       [--setting-sources <from alias>]
       [--disallowed-tools <from alias>...]
       --permission-mode acceptEdits
       --model <model> --append-system-prompt <system>
       (--session-id <uuid> | --resume <uuid>)
```

Three flags are gone versus chat mode (`--safe-mode`, `--strict-mcp-config`, `--tools`),
and that absence *is* the feature — omitting them is what lets the CLI load its normal
setting sources.

## Parity comes from the user's actual alias

"The same settings as my CLI agents" is not a guess: the repo already parses shell
aliases in `packages/core/src/launch-aliases.ts`, for the config-inventory feature. Agent
mode reuses it. The alias named `claude` is read off the shell rc, and its
`--disallowed-tools`, `--setting-sources` and `--settings` are replayed onto the child.

So a device with

```sh
alias claude='command claude --disallowed-tools Monitor'
```

gets a dashboard agent that also withholds `Monitor` — without anyone configuring the
dashboard. `GET /api/chat/config` reports the alias, whether it was found, which rc file
was read, and the flags parsed from it, so the posture is visible in the UI rather than
inferred. A missing alias is not an error: the child then runs on the CLI's own defaults,
which is still parity with a user who has no alias.

**Setting sources are only passed when the alias names them.** Omitting
`--setting-sources` entirely is what loads the CLI's default set; passing a list would
narrow it and quietly break the parity this mode exists to provide.

## Load-bearing decisions

**The base URL still wins.** It rides in `--settings`, exactly as chat mode does, and
`cliSettings` merges it *over* any `env` block the alias supplies. Loading the device's
settings makes this more important, not less: `~/.claude/settings.json` on a machine set
up per this repo's README names a proxy, and without the override an agent turn would be
captured by that proxy instead of the one the server is reporting to the dashboard. A
unit test pins the precedence.

**Credentials are still stripped.** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are
deleted from the child's environment in both modes. The reason is unchanged — their
presence silently moves the turn onto key billing, which is the other transport's job.

**A headless child cannot answer a permission prompt.** `--print` has no one to ask, so
an agent turn would hang or refuse at the first write. It gets a standing answer:
`--permission-mode acceptEdits`, overridable with `CHAT_AGENT_PERMISSION_MODE`.
`acceptEdits` rather than `bypassPermissions` — edits proceed, but the modes that skip
every check are opt-in, not the default a dashboard ships with.

**cwd is the checkout of the running server**, resolved from the server's own module
location (`server/src` → `../..`) — not a picker, not an env var, not `--add-dir`. This
was chosen deliberately over a projects root: the blast radius of the HTTP-exposed box is
one repo. It resolves to the **worktree** when the server is launched from
`.claude/worktrees/<name>`, which is the same root `LOG_DIR` resolves against — the two
must agree or the transcript-capture path breaks, since the marker file the proxy reads
lives under that store.

## Tool events become real

`decodeCliStream` previously assumed tool events could not occur. In agent mode they do,
so it now collects them: `tool_use` blocks on `assistant` events, in order, matched by id
to their `tool_result` so an `is_error` marks the tool failed. The list rides back on the
send response and the Sessions page renders it as chips under the reply, red when failed.

This is deliberately a *summary*, not a live feed. The full record — every argument,
every result — is what the proxy already writes to the transcript, and adding a second
rendering of it in the chat card would duplicate the drill-down views this dashboard
already has.

## What this costs

**A dashboard prompt in agent mode can read and write this repo, and run commands.** The
chat box is reachable by anything that can reach the server's port. That is the trade the
mode makes, and it is stated at the top of the feature doc, in the README, in the module
header of `chat-cli.ts`, and in the server's startup banner. `CHAT_MODE=chat` restores
the old posture in full, and nothing about it was removed.

The recursion is intentional but worth naming: the agent runs in claude-proxy's own
checkout, so it loads *this* repo's CLAUDE.md and hooks, and its turns are captured by
the proxy it is running inside.

## Alternatives rejected

- **Replace chat mode.** The sandboxed posture is the current PR's stated security
  boundary and the right default for a deployment. Additive, not a swap.
- **A per-turn directory picker.** Explicitly declined by the user: a bounded blast
  radius is worth more than reach, and "which repo did that prompt touch?" should have
  one answer.
- **Copy the alias's flags into config.** They would drift the moment the user edits
  their rc. Reading the alias each turn is the only version that stays true.
- **`bypassPermissions` as the default.** Strictly more capable, and a bad default for a
  surface exposed over HTTP.

## Acceptance

- [x] Default mode is `agent`; `CHAT_MODE=chat` and a per-request `mode` both select.
- [x] An agent turn expands a **custom slash command** from `~/.claude/commands` and runs
      a **real tool** — verified end to end, with the proxy's transcript showing both.
- [x] That transcript is written on the **first** turn, so the marker exemption still
      fires for an agent session.
- [x] The turn is captured by the proxy the server names, even with the device's own
      settings loaded.
- [x] A chat-mode turn in the same server still reports zero tools.
- [x] The alias's `--disallowed-tools` reach the child; a missing alias is not an error.
- [x] `agent` over `CHAT_TRANSPORT=api` is rejected rather than silently downgraded.
- [x] The mode, the alias, the withheld tools, and the cwd are reported by
      `GET /api/chat/config` and shown on the Sessions page and the startup banner.
