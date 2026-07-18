---
id: "002"
title: Which requests are safe to serve — cacheability gate
map: map-proxy-skim
labels: [wayfinder:research]
assignee: null
blockedBy: []
status: open
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
