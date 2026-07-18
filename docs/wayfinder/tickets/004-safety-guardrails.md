---
id: "004"
title: Correctness guardrails for serving cached replies
map: map-proxy-skim
labels: [wayfinder:grilling]
assignee: null
blockedBy: ["001"]
status: open
---

## Question

The skim trades a small chance of a stale/wrong reply for saved calls. Decide the
guardrails that keep that trade honest, reacting to the prototype's real behavior:

- **Default posture** — stays opt-in forever, or on-by-default once trusted?
- **Kill switch & observability** — how does a user notice the skim served a
  wrong answer, and undo it fast? (Sidecar flag + dashboard from ticket 005 is
  part of this.)
- **What must never be cached** — error responses, non-200s, partial streams,
  requests carrying secrets/tool_results?
- **Poison / staleness bound** — max TTL, max entries, eviction; what happens when
  a stored reply references state that has since changed.

Blocked by 001 (needs the prototype's replay behavior to react to).
