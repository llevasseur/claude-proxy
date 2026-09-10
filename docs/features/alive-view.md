---
type: feature
title: Alive View
description: A text-only live emotion line at /sessions/alive — one emotion word plus one trigger line describing the watched agent family right now.
tags: [dashboard, sessions, live, accessibility]
timestamp: 2026-08-25
scope: claude
---

# Alive View

## Summary

`/sessions/alive` renders two lines of text and nothing else: an emotion word —
Smiling, Thinking, Disgruntled or Stressed — and a trigger line naming what the
watched family last did. The reading comes from `deriveAliveView`
(`@agent-proxy/claude-core`), fed by the same server-built node streams the live
session graph consumes. There are no boxes, no charts and no colours of its own;
the page renders inside `SessionsShell`, under the Chat/Alive switch that shell
already carries ([ADR 0028](../adrs/0028-the-view-toggle-lives-in-the-shared-shell-header-row.md)).

## Data flow

- The thin session index is polled every 4 s (`['sessions-graph']`), exactly as
  `session-graph.tsx` polls it; the watched id resolves up to its top-level
  family root and the family walk fingerprints step counts into the nodes query
  key, so a new step refetches the streams within one index poll.
- The family's node streams come from `/api/sessions/graph/nodes` with a 20 s
  backstop interval, `keepPreviousData` holding the last reading while a
  step-count change refetches.
- Each thread enters the derivation as a raw transcript/derived pair — the shape
  `/api/sessions/graph/nodes` already returns; `mergeSessionNodes` runs inside
  the core ([ADR 0018](../adrs/0018-alive-view-reads-server-built-node-streams.md),
  [ADR 0022](../adrs/0022-alive-view-derives-from-newest-family-transcript.md)).
- `Date.now()` is injected at render through a 15 s tick, so relative ages stay
  inside their displayed minute without waiting for a poll to change anything.
- **No SSE subscription.** [ADR 0018](../adrs/0018-alive-view-reads-server-built-node-streams.md)
  allows dropping `/api/sessions/session/stream` when the poll already delivers
  `modified` freshness; here it does — the index poll refreshes the staleness
  clock every 4 s against a 30-minute stress threshold
  ([ADR 0020](../adrs/0020-stress-threshold-stays-view-local.md)), three orders
  of magnitude finer than any state the view can express. The subscription would
  be decoration, so it is not kept.

## States

- **Empty watch** — no tab-owned thread and nothing picked in the rail: emotion
  Smiling over the muted line "nothing active · select a session in the rail";
  the nodes query is disabled (`enabled: false`) and opens no stream
  ([ADR 0025](../adrs/0025-the-alive-views-empty-state-explains-itself.md)).
- **Stressed** — Thinking past `STRESS_THRESHOLD_MS`: the bare "idle for Xm"
  line, no step index ([ADR 0026](../adrs/0026-stressed-renders-a-bare-idle-line.md)).
- **Otherwise** — the general "`<lead>` · step `<index>` · `<age>`m ago" grammar.

## Accessibility

`aria-live="polite"` sits on the element holding only the emotion word; the
trigger line is ordinary text outside any live region
([ADR 0027](../adrs/0027-the-emotion-word-is-the-live-region.md)). During a run
the word holds steady at Thinking across appends, so nothing announces until the
word itself changes.

## Layout spec

Text only, styled inline against the token scale in
`stacks/claude/admin/src/styles/tokens.css` — every size below is a named step,
and the page declares no radius because it draws no box:

| Declaration | Token | Step |
|---|---|---|
| Pane padding | `var(--space-12)` | 32px |
| Gap between word and line | `var(--space-7)` | 12px |
| Emotion word size | `var(--text-10)` | 28px |
| Trigger line size | `var(--text-5)` | 13px |

Emotion word colour `var(--text)`, weight 600; trigger line `var(--muted)`. The
word's colour transitions on `var(--motion-duration)` / `var(--ease-out)` — a
standard property transition, not a keyframe animation.
