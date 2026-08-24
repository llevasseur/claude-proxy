---
type: feature
title: Admin dashboard for claude-proxy usage
description: A local web dashboard that monitors Claude Code usage, context size, sessions, cache savings, and advice from the proxy's audit logs.
tags: [dashboard, usage, trends, advice]
timestamp: 2026-07-24
scope: claude
---

# Admin dashboard for claude-proxy usage

## Summary

A local, single-user dashboard over the proxy's `.audit.json` sidecars and
finalized-digest archive, showing token burn and estimated cost, context bloat,
day-over-day trends, transcripts, cache savings, and deterministic advice.

## Motivation

Browsable counterpart to the end-of-day summary in
[`2026-07-13-claude-usage-summary-design.md`](../2026-07-13-claude-usage-summary-design.md);
designed in
[`2026-07-15-monorepo-admin-dashboard-design.md`](../specs/2026-07-15-monorepo-admin-dashboard-design.md).

## Behavior

Eighteen stations in the side rail, several with drill-down subpages beneath them. They sit
under six section headings — **Dashboard**, **Context**, **Sessions**, **Activity**,
**Device**, **Learning** — and a heading is a label for the stations under it, never a
destination: there is no page behind "Context", only the five stations it names.

**Dashboard**

- **Overview** (`/`) — today's real input / output tokens, estimated cost, cache-hit
  ratio, request count, busiest hour, tool overhead, and average system prompt, each
  with a delta against the last day that recorded it and a 7/14/30-day sparkline,
  above the plan's session and
  weekly [usage limit meters](usage-limit-meters.md).
- **Trends** (`/trends`) — per-day tokens and cost over a 7/14/30-day window (bar
  charts + table), a tokens-per-request line chart, and a per-metric drill-down
  (`/trends/$metric`). A model picker in the page head narrows every card on the page
  to one model; the drill-down instead adds up to five models as extra lines beside
  the all-models one; and the Overview carries the same single-select picker in its
  range-picker cluster, which its whole page follows. The split is server-side because
  a digest's `models` field is request counts alone: `/api/trends` takes `?models=`
  (comma-separated, empty meaning no filter) and `computeDigest` keeps only the
  sidecars that match, so an excluded request counts in neither `requestCount` nor
  `skipped`. Two limits are reported rather than papered over — a day surviving only
  as a finalized digest cannot be split, so it is dropped under a filter and counted
  in `meta.unfilterableDays`, which the page states above the cards; and today is not
  spliced in from the summary stream while filtered, since that stream reports the day
  across every model.
**Context**

- **Context size** (`/context`) — how large the prompt to the model gets, and why the
  largest was so large. See [Context-size analytics](context-size-analytics.md) and
  [Message drill-down](message-drill-down.md).
- **Tool bloat** (`/tools`) — every tool ranked by bytes, est-tokens, and share of the
  tool payload. See [Tool bloat](tool-bloat.md).
- **Skim** (`/skim`) — the proxy's opt-in reply cache: hit rate over time, tokens and
  dollars saved, and the most-repeated request shapes. See
  [Skim response cache](skim-response-cache.md).
- **Not added** (`/withheld`) — tools the device's settings keep out of every request,
  cross-referenced against tools recently observed in traffic.
- **Proxy filters** (`/filters`) — the inventory of what the proxy itself strips.
**Sessions**

- **Projects** (`/projects`) — per-project auto-memory files, with a page per project and
  per memory. See [Project memory browser](project-memory-browser.md).
- **Sessions** (`/sessions`) — a two-pane chat client over per-thread transcripts, listed
  live over SSE, with controls to start and continue local agent sessions plus detail and
  error pages. See [Session transcripts](session-transcripts.md) and
  [Dashboard chat sessions](dashboard-chat-sessions.md).
- **Live graph** (`/sessions/graph`) — a full-bleed graph of sessions and their subagent
  branches, refreshed on a 4-second poll (this page does not use SSE). See
  [Live session graph](live-session-graph.md).
**Activity**

- **Pull requests** (`/pull-requests`) — this repository's own pull requests drawn as the tree
  they formed, read-only, with a detail drawer tying each PR back to the sessions that worked
  on it. See [Pull request tree](pull-request-tree.md).
- **Jobs** (`/jobs`) — the device's `~/.claude` background jobs, with a per-job file tree
  and viewer. See [Background jobs browser](background-jobs-browser.md).
**Device**

- **Hooks & Plugins** (`/hooks-plugins`) — the hooks and plugins the device's settings
  declare. This station, Not added, and Proxy filters share one doc:
  [Config inventory](config-inventory.md).
- **System prompt** (`/system-prompt`) — `~/.claude/CLAUDE.md`, the device-wide instructions
  every session loads, sized in bytes and per-request tokens and edited in place. The one
  station that writes back. See [Device system prompt](device-system-prompt.md).
- **Commands** (`/commands`) — what each slash command costs per declared step and where
  its runs stop, with a page per command and per run. See
  [Commands eval](commands-eval.md).
- **CLI internals** (`/cli-internals`) — a catalogue of functions read out of the installed
  Claude Code bundle. The bundle is minified, so each row is keyed to a signal that survives
  minification and a row whose signal no longer matches says so rather than showing stale
  source.

**Learning**

- **Concepts** (`/concepts`) — every term `/teach` has explained, with its one Simplified
  Technical English sentence, and a detail page per term. See
  [Concepts page](concepts-page.md).
- **Advice** (`/advice`) — three stacked sections, ordered by how actionable they are.
  **Ideas** comes first: the [ideas ledger](ideas-ledger.md) as approve/deny cards, each
  showing what it cites, so a proposal is signed off in the browser rather than at a
  terminal. Then the **heuristic coaching** derived deterministically from the day's
  digest (dominant tool, tool overhead, low cache-hit, large system prompt, high cost) —
  with any card whose metric has not moved since the prior day folded into one
  "unchanged since &lt;date&gt;" line that expands back to the full cards. Then
  ten-session suggestion buckets with persistent pending/done/skipped/dismissed flags.
  See [Session suggestions](session-suggestions.md).

Each station has a [lucide](https://lucide.dev) icon. The headings cost the rail about a
station's worth of height apiece, so on a short viewport the station list is what scrolls:
the brand holds the top of the rail and the health badge stays pinned to the bottom, above
its hairline, rather than dropping off with the last group. Both fixed ends carry a soft
box-shadow over that scroller, so a station clipped at either edge reads as passing under
them rather than as stopping short. That scroller follows the page:
after a navigation, and again as the narrow-viewport drawer opens, the lit station is brought
back inside it — reaching up stops at the station's section heading so it arrives labelled,
reaching down only clears the bottom edge, and a station already in view leaves the reader's
scroll position where it is. The move is a jump rather than a smooth scroll, which the
incoming page's own layout would abandon partway. The rail toggles between full and
a 64px icon-only strip; `localStorage` key `admin:rail-collapsed` persists the choice.
Collapsed labels remain visually hidden in the accessibility tree and appear as hover
tooltips, and the section headings are hidden the same way — a hairline rule between groups
carries the grouping at that width, while the heading stays in the accessibility tree so each
group keeps its name. At 860px and below, the rail becomes a top bar: the toggle and persisted
state are ignored, while icons remain beside labels.

Day-bucketed values use `REPORT_TZ` (`America/New_York`, following EST/EDT), so
Overview, Trends, busiest hour, and Skim roll over at Eastern midnight, not the UTC
filename date. `readArchivedDay` merges the two UTC archive folders a reporting day can
span, then filters by sidecar timestamp. Individual events use the viewer's local zone.

Most `server` routes are read-only JSON views; SSE streams feed the Overview summary and
usage meters, the session list and detail, the ideas ledger, and the commands pages. An
explicit POST allowlist with origin-checked CORS starts, continues, stops, or ends
dashboard chats, records suggestion flags, adjudicates an idea, rewrites the device system
prompt, and deletes a background job. See
[ADR 0003](../adrs/0003-allow-narrowly-scoped-writes-in-the-local-server.md).
A page waiting on any of those routes renders a shaped placeholder rather than a spinner —
see [Skeleton loading](skeleton-loading.md). Analysis is computed via `packages/core`.
Advice comes from `heuristicAdvice`, the deterministic rule set itself — there is no
provider interface in front of it.

## Acceptance criteria

- [x] `pnpm install` wires the workspace; `pnpm -r typecheck` and `pnpm -r test` pass.
- [x] `packages/core` unit tests cover digest, cost, and advice.
- [x] `server` serves `/api/*` over the real `logs/` dir; the dashboard renders
      token burn, trends, tool bloat, and advice from live data.
- [x] The proxy still runs with bare `node proxy/proxy.ts` (zero deps).
- [x] Day buckets and busiest-hour labels use `America/New_York`, including the EST/EDT
      boundary and late-evening requests whose UTC date is already the next day.
- [x] `okq validate` passes on this bundle.

## Open questions

- Whether to replace heuristics with an in-repo `agents/` LLM provider. Nothing is
  wired, and the interface that anticipated it has been deleted — the abstraction is
  one line to reintroduce in the commit that adds a second implementation.
