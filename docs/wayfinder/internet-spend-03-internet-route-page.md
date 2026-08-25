---
type: wayfinder-plan
title: "Internet Spend 03 — admin /internet route page"
description: The /internet page — headline period total, daily upload/download stacked bars with hatched gaps, approximate agent share, budget editor, collector status line.
tags: [wayfinder, dashboard, recharts]
timestamp: 2026-08-25
scope: claude
campaign: internet-spend
number: "03"
---

# Internet Spend 03 — admin /internet route page

Branch: `task/internet-spend-03-internet-route-page`, cut from `wayfinder/internet-spend`.
Lane: `stacks/claude/admin/src/routes/internet.tsx` (new), one line in
`stacks/claude/admin/src/routes/registry.ts`, a new fetch module
`stacks/claude/admin/src/net-api.ts` (do NOT edit the shared `src/api.ts`),
`CHANGELOG.md`. Requires ticket 02 merged (API contract below is what 02 ships).

## Criteria

1. **Route self-declared** per AGENTS.md: `internet.tsx` exports its component,
   its own `route` (`createRoute` with path `/internet`,
   `staticData.title 'Internet'`), and a rail `nav` written
   `as const satisfies NavEntry`; exactly one line added to `registry.ts`;
   `ROUTES` stays `as const`.
2. **Base URL** from `VITE_NET_SERVER_URL` following the exact two-outcome
   pattern of `API_BASE` in `src/api.ts`, defaulting to
   `http://localhost:8531`. All net-server reads go through `net-api.ts` typed
   to ticket 02's response shapes; no `any`.
3. **Headline**: total wire bytes for the current budget period when
   limit+resetDay are configured, month-to-date otherwise (decision 003), with
   the period's date range stated beside it. Rendered from `/api/summary`.
4. **Daily stacked bar chart**: upload/download per local day over a selectable
   window (7/14/30/90 days) from `/api/days?window=`, copying the Trends page's
   rechart patterns (`routes/trends.tsx` is the reference — read it first).
   Hole days render as nothing (no fabricated zero-height bar); gap/decrease/
   boot spans render as hatched unknown bands (Recharts `ReferenceArea` with a
   hatch-pattern `<defs>` fill); days intersecting any span carry a visible
   partial marker.
5. **Agent share**: secondary series/table labeled approximate ("attributed by
   process name; hourly sampling does not see processes that start and finish
   between samples") fed by `/api/summary.agentShare`.
6. **Collector status line**: "last sample N ago" plus first-sample date from
   `/api/summary.coverage`, so sparse data reads as sparseness (decision 005).
7. **Budget editor on the page**: `limitBytes` input (positive integer or
   cleared for unset) and `resetDay` input (1–31, blank = unset) PUTting
   `/api/config`; optimistic-free plain refetch on success; server 400s surface
   inline.
8. **Unreachable net-server degrades gracefully**: fetch failures render an
   explicit "net-server unreachable at <url>" state — never a crash, never a
   fake zero.
9. Styling through tokens.css steps only (`var(--space-N)`, `var(--text-N)`,
   `var(--radius-N)`) — the repo-wide no-bare-size Grit plugin applies;
   Biome-clean.
10. `pnpm --filter @agent-proxy/claude-admin typecheck` green (admin's only
    gate); `biome check .` green; CHANGELOG.md bullet prepended.

## Verification

With ticket 02's server running, load the admin dev server and confirm
/internet renders charts from live data. State in the PR body whether visual
proof was captured; full browser verification belongs to campaign close.
