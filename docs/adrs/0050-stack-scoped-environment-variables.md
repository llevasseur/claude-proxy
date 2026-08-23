---
type: adr
title: Keep port defaults verbatim and scope environment variable names per stack
description: Fusion may not change a stack's default port, but must namespace the variables that one root .env would otherwise collapse.
tags: [monorepo, configuration, runtime]
timestamp: 2026-08-23
scope: all
decided-by: /dev
ratified: false
wayfinder: monorepo-fusion
grill-round: 1
needs-human: true
---

# Keep port defaults verbatim and scope environment variable names per stack

## Status

Proposed by `/dev` during the `monorepo-fusion` campaign. **A human has not ratified
this decision.** It changes a documented operator interface — the names of the
environment variables each stack reads — which is why it is flagged.

## Context

The campaign brief listed as a blocker that "codex and ox both default the proxy to
port 8787 and cannot run side by side", and proposed allocating nine distinct ports.
The griller asked:

> "What is the campaign's actual rule for env-var and port defaults — does
> zero-behaviour-change mean every stack keeps its current default port and its
> current variable names verbatim (accepting that `PORT` now means two different
> things depending on which package reads it, and that claude's server and ox's
> server both claim 8788), or does the campaign permit renaming/renumbering these,
> in which case what distinguishes that permitted behaviour change from the ones the
> rejection rule forbids?"

The blocker's premise is false. The three proxies already hold three distinct ports —
`8787` (claude, `proxy/proxy.ts`), `8026` (codex, `proxy/src/config.ts`), `8807` (ox,
`proxy/src/config.ts`) — and both sibling repos carry source comments recording that
they moved off `8787` deliberately to avoid the siblings.

The collisions that do exist are elsewhere. claude's server and ox's server both
default to `8788`. All three admin dev servers default to Vite's `5173`. And the
sharpest one is not a number at all: claude's **proxy** reads `PORT` while codex's
**server** reads `PORT`. Today those live in separate repos. After fusion there is one
root and one `.env`, and codex's `--env-file-if-exists=../.env` points at it, so a
single exported `PORT` binds two different processes.

## Decision

**Default values stay verbatim. No port number changes in this campaign.** Every
stack keeps the port it has today. Recording the nine actual defaults in `.zellij/`
and the merged `AGENTS.md` replaces the "allocate nine distinct ports" step, which was
a remedy for a collision that is not there and would itself have been the runtime
change the campaign's rejection rule forbids.

**Environment variable names become stack-scoped**: `CLAUDE_PROXY_PORT`,
`CLAUDE_SERVER_PORT`, `CODEX_PROXY_PORT`, `CODEX_SERVER_PORT`, `OX_PROXY_PORT`,
`OX_SERVER_PORT`. **Each package still honours its current bare name as a fallback,
scoped to that package alone**, so a stack launched exactly as it is launched today
resolves exactly as it does today.

The general test this establishes, which governs the campaign beyond ports:

> **A fusion-caused regression is in scope to prevent. Pre-existing awkwardness is out
> of scope to fix.**

The `PORT` namespace collapse is the first kind — it exists only because fusion
created one root. The claude/ox `8788` duplication is the second — running both repos
today already collides, and fusing them neither creates nor worsens it.

## Consequences

- A stack launched as documented behaves identically. That is checkable rather than
  asserted: each package's config test gains one case asserting the scoped name wins,
  one asserting the legacy bare name still resolves, and one asserting the default is
  the unchanged number.
- `pnpm verify` gains sight of a class of failure it currently cannot see at all.
- The `8788` and `5173` duplications survive, documented rather than fixed. The
  per-stack variable names are what make them operationally overridable.
- Operators who export a bare `PORT` for more than one stack must move to the scoped
  names. This is the interface change a human should sign off on.

## Provenance

Decided in this repository during `monorepo-fusion`. No prior record in any of the
three source corpora addresses it, because the collision it prevents cannot exist
until the three repositories share a root.
