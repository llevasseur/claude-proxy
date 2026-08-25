---
type: wayfinder-plan
title: "Internet Spend 04 — Overview budget meter"
description: Config-driven usage-limit meter beside the existing Overview meters, with a rechart fallback when no budget is set, and graceful degradation when net-server is unreachable.
tags: [wayfinder, dashboard, overview]
timestamp: 2026-08-25
scope: claude
campaign: internet-spend
number: "04"
---

# Internet Spend 04 — Overview budget meter

Branch: `task/internet-spend-04-overview-budget-meter`, cut from `wayfinder/internet-spend`.
Lane: the Overview route file in `stacks/claude/admin/src/routes/` (read
`registry.ts` to find it), one or two new component files under
`stacks/claude/admin/src/components/`, `CHANGELOG.md`. Requires ticket 02
merged. Independent of ticket 03 — shares no file with it.

## Criteria

1. **Purely config-driven**: fetch `/api/config` and `/api/summary` from
   net-server (base URL per the same two-outcome `VITE_NET_SERVER_URL` pattern;
   put shared typing/fetch in a new small module or duplicate minimally — do
   NOT edit `src/api.ts` or ticket 03's files). When `limitBytes` AND
   `resetDay` are both configured, render a usage-limit meter (bytes used this
   period / limit, period bounds labeled) beside the existing meters.
2. When not configured, render instead a small rechart component (daily total
   bytes over the last 14 days from `/api/days?window=14`) so the Overview
   still shows internet activity without a budget.
3. **Overview must not break when net-server is unreachable**: all net-server
   fetching is isolated behind its own error boundary / query-state handling —
   on failure the section renders nothing (or an inline "net-server
   unreachable" line), and every existing Overview meter keeps rendering
   byte-for-byte as before. Zero changes to any data path that feeds existing
   meters.
4. Styling through tokens.css steps only; Biome-clean; matches the visual
   grammar of the neighboring meters (copy their markup patterns).
5. The meter links to `/internet` for detail.
6. `pnpm --filter @agent-proxy/claude-admin typecheck` green; `biome check .`
   green; CHANGELOG.md bullet prepended.

## Verification

With net-server running: configure a budget via PUT and confirm the meter
appears with real numbers; unset it and confirm the fallback chart appears;
stop net-server and confirm the rest of Overview is unaffected. State in the
PR body which of these were visually confirmed; full browser verification
belongs to campaign close.

## Docs

Write the durable feature doc `docs/features/internet-usage-meter.md`
(one concept: what the feature shows, where data comes from, hole semantics,
the approximate labels, config surface), regenerate the docs index, and note it
in the PR body. Reference the five `decision-internet-spend-*` records rather
than duplicating them.
