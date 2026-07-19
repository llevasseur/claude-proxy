---
id: "004"
title: Correctness guardrails for serving cached replies
map: map-proxy-skim
labels: [wayfinder:grilling]
assignee: claude
blockedBy: ["001"]
status: closed
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

## Resolution

Charted as a **proposal** in
[decision-004-guardrails.md](../decision-004-guardrails.md) — grounded in the
real ticket-001 prototype (`proxy/skim.mjs` + the skim branch of
`proxy/proxy.mjs`). Recommended answers to the four questions:

- **Default posture:** opt-in forever for the whole skim; on-by-default only
  later, only for a proven-safe slice, and only after guardrails + the ticket-005
  dashboard land.
- **Kill switch & observability:** keep `SKIM_CACHE` as the global off switch;
  document per-entry `rm` undo keyed by the sidecar's `cacheKey`; rely on the
  ticket-005 dashboard to make hits (and risky hits) visible.
- **Never cache:** non-200s (already enforced), **partial/truncated streams**
  (add a `message_stop` completeness check before storing), and
  **`tool_result`-bearing requests** (new default exclusion — the main way
  changed live state enters a byte-identical request); keep `count_tokens` and
  non-streaming excluded.
- **Poison / staleness bound:** shorten the default TTL to ~5–15 min, add
  `SKIM_MAX_ENTRIES` + eviction + expired-file cleanup (all absent today), and
  exclude live-state carriers rather than trying to invalidate them under
  byte-exact keying.

**Proposed — needs human ratification.** These were charted AFK (no live human);
the doc opens with that banner and each answer flags what still needs sign-off.
The doc does not claim the human settled these.
