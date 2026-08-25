---
type: wayfinder-plan
title: Alive View 03 — the /sessions/alive route page
description: Register the route, wire polls and optional SSE, render emotion word and trigger line, verify in Chrome.
tags: [wayfinder, dashboard, sessions, live]
timestamp: 2026-08-25
scope: claude
campaign: alive-view-mote
number: "03"
---

# Alive View 03 — the /sessions/alive route page

Branch: `task/alive-view-mote-03-alive-route-page`, cut from `wayfinder/alive-view-mote` **after tickets 01 and 02 have merged** (it consumes both the shell and the derivation).
**Status:** done · 2026-08-25
Lane: one new file `stacks/claude/admin/src/routes/sessions-alive.tsx`, one line in `stacks/claude/admin/src/routes/registry.ts`, and a layout-spec doc under `docs/features/` or `docs/specs/`. It must not re-edit ticket 01's shell or ticket 02's core except to import them.

## Criteria

0. BEFORE implementation, write the layout spec against `stacks/claude/admin/src/styles/tokens.css`: every size, spacing, radius and text step the page uses named as a token step, committed in this branch before the component lands. No bare px anywhere.
1. New file declaring its own route per AGENTS.md: path `/sessions/alive`, `staticData.title`, exported component, plus `nav` only if it belongs in the rail (it does NOT — it lives under Sessions). Registered once in `routes/registry.ts`; `ROUTES` and `STATIONS` stay `as const`.
2. Page renders through ticket 01's shared shell. Selecting a row swaps the watched session via the sidenav's `onSelect`; local state initialised from the tab-owned thread (`useChatSession` + `useChatThread`).
3. Data: poll `/api/sessions/graph/nodes` for the watched family exactly as `session-graph.tsx` does; optionally subscribe to `/api/sessions/session/stream` via `useLiveQuery` for `modified` freshness, dropping it if redundant. Emotion and trigger line come from ticket 02's derivation with `Date.now()` injected at render.
4. States: empty watch → Smiling + "nothing active · select a session in the rail", no fetches (`enabled: false`); stressed → bare "idle for Xm"; aria-live="polite" on the emotion word only, trigger line outside any live region (ADR 0027). Text only, standard transitions.
5. `my-command-tools verify` green.

## Verification

After implementation, verify in Chrome: toggle works both directions; selecting different sessions swaps the emotion line within the poll cadence; a stale fixture reads Stressed. If no browser automation backend is available this session, record the missing evidence verbatim in the PR body instead of simulating it.
