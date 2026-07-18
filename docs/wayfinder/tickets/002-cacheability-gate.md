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

Findings written up in [research-002-cacheability.md](../research-002-cacheability.md),
grounded in the real corpus (1787 non-empty request bodies, `2026-07-13` →
`2026-07-18`, single device — so a *floor*, not a population estimate).

- **Byte-exact repeat fraction (exact-match floor):** ~**1.1%** full corpus
  (1768 distinct of 1787), and ~**0.6%** for the `stream:true` /v1/messages
  subset ticket 001 actually caches (1172 distinct of 1179). Near-zero, because
  every body is salted with a rotating per-session UUID and live git/date/tool
  state.
- **Recurs-but-not-identical (semantic candidates):** ~99% of traffic collapses
  into ~63 recurring *shapes*, but within each, distinct-hash ≈ member count. The
  realistic semantic target is the small stateless utility tail — the `mt=64`
  CLAUDE.md-config classifier, the title/label generator, and the `mt=1` `quota`
  ping — not the `mt=64000` agent turns (high volume, ~100% unique, stuffed with
  live state).
- **Volatile signals to exclude/scope/refuse:** `session_id` / `device_id` /
  `account_uuid` (100%, exclude — a `quota` pair proved session_id is the *sole*
  byte difference); clock / "Today's date" (67%) + ISO timestamps (33%) (exclude
  + TTL); cwd (92%), git HEAD/branch (96%), platform block (66%) (scope);
  `tool_result` (61%) and live `gitStatus` (91%) (refuse — statelessness fails).

Feeds the key/invalidation policy in ticket 003.
