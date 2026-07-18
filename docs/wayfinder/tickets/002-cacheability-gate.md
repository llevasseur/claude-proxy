---
id: "002"
title: Which requests are safe to serve — cacheability gate
map: map-proxy-skim
labels: [wayfinder:research]
assignee: claude
blockedBy: []
status: closed
---

## Question

Read the captured `logs/*.audit.json` + `.request.txt` corpus and characterize
real Claude Code traffic against the three cacheability gates established with the
user: **determinism** (same input reliably → same output), **statelessness**
(answer doesn't depend on live files / git HEAD / clock / tool results), and
**recurrence** (actually asked more than once). Deliverable: a markdown summary,
linked here, that answers:

- What fraction of requests are byte-exact repeats (the exact-match hit-rate
  floor)? Ticket 001's `skim` sidecar fields make this countable once traffic
  accumulates.
- What request shapes recur but are *not* byte-identical (candidates for the
  semantic layer in *Not yet specified*)?
- What volatile signals appear in bodies (timestamps, tool_result content, cwd)
  that would make a naive cache serve stale answers — i.e. what the key must
  exclude or scope on.

This is read-only research over existing logs; it informs the key/invalidation
policy (ticket 003).

## Resolution

Full study: [research-002-cacheability-corpus.md](../research-002-cacheability-corpus.md).
Analyzed 663 captured `POST /v1/messages` bodies (446 in the skim gate — streamed;
the other 217 are `count_tokens` preflights the gate already excludes).

- **Byte-exact hit-rate floor: 0.7%** (3/446 identical repeats; only 2 distinct
  bodies ever recur). Relaxing to identical conversation *prefix* still only reaches
  1.8%. Confirms ticket 001's "byte-exact hits rarely" with a number.
- **Recurrence is semantic, not byte-level.** The stable scaffold repeats hard —
  ≤35 distinct system+tools scaffolds cover 92% of requests (system 94%, tools 95%,
  first-user-message 93%) — while the full body is almost always unique. Variance
  lives in the growing tail (`tool_result` turns, appended reminders). These are the
  candidates for the *Semantic skim layer*, unreachable by any exact key.
- **Volatile signals are near-universal** (~100% of bodies): injected date, absolute
  cwd paths, git branch/HEAD, `gitStatus`, `<system-reminder>` blocks; `tool_result`
  content in 91%. For ticket 003 the key must **exclude** pure noise (date/clock,
  reminder wrappers, cwd paths) but **scope on** git state and treat `tool_result`
  as an invalidation dependency — the same fields that block byte-exact hits are what
  a naive cache would serve stale.
