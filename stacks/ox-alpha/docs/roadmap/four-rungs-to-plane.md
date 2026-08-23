---
type: roadmap
title: Four rungs to Plane
description: Four complete outcomes from live sanitized usage to pinned claude-proxy parity.
tags: [roadmap, bike, car, boat, plane]
timestamp: 2026-08-22
---

# Four rungs to Plane

> "Incremental delivery ships a bike, then a plane: every phase reaches the destination on its own, and each phase is more complex."

The ladder is fixed by [ADR 0004](../adrs/0004-four-rung-outcome-ladder.md). Every phase must remain independently
useful, and each later phase must preserve the safety and operating path of every earlier one. Train — codex-proxy's
operator-workflows phase — is deliberately absent; its parity rows close as `N/A` citing that record.

## Bike

Bike transparently forwards OpenAI traffic, records sanitized metrics, materializes a disposable SQLite view,
reports live process status, and presents one Overview with today's input tokens, output tokens, and cost. Cost is
nullable and explicit. The proxy, server, and browser stay separate. Final sidecars, not SQLite, are durable truth.

Bike excludes history, trends, filters, body capture, inspection, and operator automation.

## Car

Car adds durable history, trend views, date ranges, and model/range filters bucketed by report-timezone day. It
retains the live Overview and remains fully useful without any Boat inspection data or body capture.

Verification at the Car boundary: fresh install, aggregate gates, historical accuracy, filters, timezone boundaries,
SSE continuity, and Bike regression coverage.

## Boat

Boat adds explicit opt-in request and response body capture with tested redaction and retention controls, then uses
that data for context, tool, prompt, and session inspection. Capture defaults off; sanitized metrics remain
sufficient for usage and history; the repository remains useful with no inspection data.

Boat excludes operator automation, coaching, suggestions, and parity catch-up.

Verification at the Boat boundary: secret non-retention when disabled, redaction and deletion when enabled,
historical views without bodies, aggregate gates, and end-to-end inspection flows against fixtures.

## Plane

Plane reaches capability parity with `claude-proxy` commit
`cc25696504e724bd78824e639e97a0a1d846abea`, adapted to the OpenAI Responses contract under
[ADR 0001](../adrs/0001-use-responses-contract.md) and pinned by [ADR 0008](../adrs/0008-pin-plane-parity.md).
Plane is complete only when every applicable matrix row below is implemented and verified with evidence, and every
non-applicable row carries an explicit rationale. A category summary or visual resemblance is not parity.

## Pinned Plane parity matrix

`Pinned evidence` names the stable source surface at pinned commit
`cc25696504e724bd78824e639e97a0a1d846abea`; every path was verified present in that tree. A row closes only as
`implemented` with concrete evidence from this repository or `N/A` with a rationale — there is no third state
([ADR 0008](../adrs/0008-pin-plane-parity.md)). Every other row starts `unresolved` and names the test, route,
or artifact that will close it. Rows whose only producer would have been Train are pre-closed `N/A` per
[ADR 0004](../adrs/0004-four-rung-outcome-ladder.md); restoring them requires superseding that record.

### Proxy wire and process state

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Transparent HTTP pass-through of all traffic | `proxy/proxy.ts` | Every request and response forwarded unmodified through the OpenAI upstream (ADR 0007). | implemented — `proxy/test/forwarding.test.ts` |
| Upstream observation and usage extraction | `proxy/wire.ts` | Adapted to Responses JSON/SSE observation without altering the wire. | implemented — `proxy/src/observe.ts`, `packages/core/src/adapters.ts`, `packages/core/src/usage.ts`; `proxy/test/observation.test.ts`, `packages/core/test/adapters.test.ts`, `packages/core/test/usage.test.ts` |
| Safe JSON parsing on the wire path | `proxy/json.ts` | Defensive parse of streamed JSON bodies before sanitization. | implemented — `packages/core/src/adapters.ts` (`jsonResponseIdentity`, `SseResponseObserver`); `packages/core/test/adapters.test.ts` |
| Prompt-cache breakpoint injection | `proxy/cache-breakpoint.ts` | N/A — repairs Claude Code's intermittently dropped `cache_control` message breakpoints; the OpenAI Responses contract has no client-side cache-control field (caching is server-side and automatic, [ADR 0001](../adrs/0001-use-responses-contract.md)), and injecting into any request body would break the transparent surface ([ADR 0007](../adrs/0007-transparent-http-surface.md)). There is no client defect to repair. | N/A (ADR 0001, ADR 0007) |
| Skim / system-prompt request rewriting | `proxy/skim.ts`, `proxy/system-prompt.ts` | N/A — skim intercepts byte-exact repeats before the upstream is called and system-prompt rewrites bodies in flight; both replace the upstream response or alter the request, which ADR 0007 forbids on this repository's transparent surface. | N/A (ADR 0007) |
| Per-request session attribution | `proxy/session.ts` | Attribute captured traffic to derived session identifiers. | implemented — `deriveSessionId` in `packages/core/src/inspection.ts`; `packages/core/test/inspection.test.ts`, `server/test/capture.test.ts` |
| Live process lifecycle status | `proxy/session.ts` | Startup/ready/upstream-error/shutdown status consumed by the dashboard. | implemented — `proxy/src/proxy-status.ts`; `proxy/test/status.test.ts`, surfaced through `/api/events` (`server/test/events.test.ts`) |
| Live rolling usage at the proxy | `proxy/usage-live.ts` | implemented (adapted) — the pinned surface polls Anthropic's OAuth usage endpoint with forwarded credentials; under OpenAI Responses semantics the proxy instead accumulates its own observed per-process usage counters into the status signal: `ProxyStatusWriter.noteUsage` writes `rollingUsage` beside lifecycle state (`proxy/src/proxy-status.ts`), consumed from the status file into `/api/health` and every `/api/events` snapshot. Evidence: `a live Responses exchange publishes rolling usage beside the lifecycle state` in `proxy/test/status.test.ts`; `proxy rolling usage from the status file rides the snapshot and updates` in `server/test/events.test.ts`. Sanitized token counts only — never bodies or credentials. | implemented — `proxy/src/proxy-status.ts`, `server/src/service.ts`; cases above |

### Health, summary, and history APIs

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Health endpoint | `/api/health` | Process-health read. | implemented — `GET /api/health` in `server/src/service.ts`; `server/test/api.test.ts` |
| Today summary endpoint | `/api/summary` | Today's input/output tokens and nullable cost ([ADR 0003](../adrs/0003-unavailable-incomplete-cost.md)). | implemented — `GET /api/summary` in `server/src/service.ts`; `server/test/api.test.ts`, `packages/core/test/today.test.ts`, `packages/core/test/pricing.test.ts` |
| Live summary stream | `/api/summary/stream`, `/api/usage/stream` | Live updates push summary-shaped payloads. | implemented (adapted) — one SSE channel `/api/events` replaces per-route streams; `server/src/events.ts`, `server/test/events.test.ts`, `apps/admin/src/overview/useLiveOverview.ts` |
| Date-range aggregates by report-timezone day | `/api/trends` | Daily buckets over a window, model-filterable. | implemented — `/api/history` and `/api/trends` in `server/src/service.ts`; `server/test/history.test.ts`, `packages/core/test/history.test.ts`, `packages/core/test/today.test.ts` |
| Usage limits endpoint | `/api/usage`, `packages/core/src/usage-limits.ts` | OpenAI-adapted limits payload or recorded rationale. | unresolved — define the limits domain beside `packages/core/src/usage.ts` with a core test, then add the GET route covered by `server/test/api.test.ts` |

### Prompt analysis

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Prompt mix endpoint | `/api/prompt-mix`, `packages/core/src/prompt-mix.ts` | Section categorization over captured prompts. | unresolved — build the mix domain over `analyzePrompt` (`packages/core/src/inspection.ts`) with `packages/core/test/prompt-mix.test.ts`, then serve `/api/prompt-mix` covered by `server/test/api.test.ts` |
| Prompt drill-down endpoints | `/api/prompt`, `/api/prompt/section` | Hash- and section-level prompt lookups. | unresolved — persist per-day prompt analysis at ingest and serve hash/section lookups; close with cases in `server/test/api.test.ts` and a Boat page destination |

### Tool and context inspection (Boat)

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Tool inventory with schema summaries | `/api/tools` | Tools observed in captured traffic. | implemented — `/api/inspection/tools` in `server/src/service.ts`; `server/test/inspection.test.ts`, `packages/core/test/inspection.test.ts` |
| Name-keyed tool schema detail | `/api/tool-schema` | One tool's schema across days. | unresolved — extend `/api/inspection/tools` with name-scoped detail; case in `server/test/inspection.test.ts` |
| Context window table (pagination + search) | `/api/context` | Paginated, searchable table of captured windows. | unresolved — add search/sort parameters to an inspection listing; cases in `server/test/inspection.test.ts` |
| Day context window | `/api/context/day` | One report day summarized whole. | implemented — `/api/inspection/day` in `server/src/service.ts`; `server/test/inspection.test.ts` |
| Memoized day/digest caches | `server/src/context-day-memo.ts`, `server/src/day-digest-memo.ts` | Per-day inspection results computed once. | unresolved — memoize day inspection in the server; measurable via a repeated-request case in `server/test/inspection.test.ts` |
| Message drill-down | `/api/context/detail`, `/api/context/message` | Individual captured messages by record and index. | implemented — `/api/inspection/messages` in `server/src/service.ts`; `server/test/inspection.test.ts` |
| Tool-call drill-down | `/api/context/tool` | Individual captured tool calls. | implemented — `/api/inspection/tool-calls` in `server/src/service.ts`; `server/test/inspection.test.ts` |

### Sessions, liveness, and graphs

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Captured-session listing | `/api/sessions` | Sessions reconstructed from captures. | implemented — `/api/inspection/sessions` in `server/src/service.ts`; `server/test/inspection.test.ts` |
| Session detail and breakdown | `/api/sessions/session`, `/api/sessions/breakdown` | Id-scoped detail and per-session breakdowns. | unresolved — id-scoped routes over stored envelopes; cases in `server/test/inspection.test.ts` |
| Session liveness | `packages/core/src/liveness.ts`, `/api/sessions/liveness` | Live-vs-finished classification for OpenAI sessions. | unresolved — define the liveness source in core with tests, then expose it |
| Live session graph | `/api/sessions/graph*`, `/api/sessions/node-text`, `apps/admin/src/graph-agents.ts`, `graph-layout.ts` | Graph view of agent sessions. | unresolved — core graph model plus an admin route with component tests |
| Session errors view | `/api/sessions/errors` | Error classification and listing. | unresolved — classify upstream/ingest errors; cases in `server/test/ingest.test.ts` |

### Projects and memories

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Project discovery and memory browsing | `/api/projects*`, `server/src/projects.ts` | Local project/memory discovery adapted to the OpenAI ecosystem. | unresolved — identify a source or record an explicit `N/A` rationale in this matrix citing [ADR 0008](../adrs/0008-pin-plane-parity.md) before Plane closes |

### Chat and agent transport

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Dashboard agent-chat transport | `/api/chat*`, `server/src/chat*.ts`, `chat-stream.ts`, `apps/admin/src/useChatStream.ts`, `ChatConversation.tsx` | Interactive/headless agent transport adapted to Responses streaming. | unresolved — implement a Responses-backed chat stream route with an events-style test, or record a protocol-specific rationale |

### Train-closed surfaces

Every row below has no producing phase; see [ADR 0004](../adrs/0004-four-rung-outcome-ladder.md).

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Ideas ledger APIs | `/api/ideas*`, `server/src/ideas-cli.ts`, `ideas-pr.ts`, `ideas-store.ts`, `ideas-remote.ts`, `packages/core/src/ideas.ts` | N/A — Train surface. | N/A (ADR 0004) |
| Suggestion buckets and coaching | `/api/sessions/suggestions*`, `server/src/suggestions-cli.ts`, `suggestion-status.ts`, `packages/core/src/suggestions.ts`, `suggestion-status.ts`, `advice.ts`, `components/AdviceCard.tsx`, `routes/advice.tsx` | N/A — Train surface. | N/A (ADR 0004) |
| Operator notes | `/api/notes*`, `server/src/notes-remote.ts`, `packages/core/src/notes.ts`, `routes/notes.tsx` | N/A — Train surface. | N/A (ADR 0004) |
| Headless daily summary | `server/src/daily-summary.ts`, `summary-render.ts`, `packages/core/src/digest.ts` | N/A — Train surface. | N/A (ADR 0004) |
| Jobs browsing and deletion | `/api/jobs*` including `POST /api/jobs/delete`, `server/src/jobs.ts`, `packages/core/src/jobs.ts`, `routes/jobs.tsx`, `job-detail.tsx`, `components/JobFileTree.tsx`, `JobFileView.tsx` | N/A — Train surface; no read-only fallout occurred in earlier phases. | N/A (ADR 0004) |
| Hooks/plugins inventory | `/api/hooks-plugins`, `packages/core/src/hooks-plugins.ts`, `routes/hooks-plugins.tsx` | N/A — Train surface; no read-only fallout occurred in earlier phases. | N/A (ADR 0004) |
| Pull-request tree | `/api/pull-requests*`, `server/src/pr-sessions.ts`, `github.ts`, `db/pr-scan-store.ts`, `db/pull-request-store.ts`, `packages/core/src/pull-requests.ts`, `routes/pull-requests.tsx` | N/A — only producer was the Train ideas/jobs pipeline. | N/A (ADR 0004) |
| Scheduled maintenance launcher | `scripts/com.llevasseur.claude-proxy.maintain.plist` | N/A — Train maintenance automation. | N/A (ADR 0004) |
| Archive/backfill/recovery CLI | `server/src/maintain-cli.ts` (archive/recovery slices), `prompt-backfill-cli.ts`, `prompt-backfill.ts` | N/A — Train maintenance/recovery operations. | N/A (ADR 0004) |
| Operator route inventory | `routes/registry.ts` entries for advice, ideas, suggestion-bucket, notes, jobs, hooks-plugins, pull-requests | N/A — Train surfaces above. | N/A (ADR 0004) |

### Headless ingest and maintenance

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Transactional sidecar-to-SQLite ingest | `server/src/db/ingest.ts`, `ingest-sessions.ts`, `ingest-commands.ts`, `ingest-concepts.ts` | Watermarked, idempotent ingest from final sidecars (truth stays in sidecars, [ADR 0002](../adrs/0002-sanitized-sidecars.md)). | implemented — `SidecarIngestor` in `server/src/ingest.ts` with `ingest_watermarks` in `server/src/database.ts`; `server/test/ingest.test.ts` |
| Rebuildable disposable store | `server/src/db/open.ts`, `runtime.ts`, `usage-day-store.ts` | SQLite rebuildable from sidecars; never durable truth. | implemented — schema bootstrap in `server/src/database.ts`; `server/test/index.test.ts`, `server/test/ingest.test.ts` |
| Capture retention pass | `server/src/retention.ts` and the retention slice of `maintain-cli.ts` | Expire and cap captured bodies when capture is enabled. | implemented — headless pass in `server/src/maintain.ts`; `docs/specs/capture-retention.md`, `server/test/capture.test.ts` |
| Store/source consistency checks | `server/src/db/source.ts` | Detect drift between SQLite and sidecars. | unresolved — consistency assertion over rebuild output; case in `server/test/ingest.test.ts` |

### Core domain library

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Model pricing catalogue | `packages/core/src/pricing.ts` | Deterministic cost estimation with explicit catalogue version. | implemented — `packages/core/src/pricing.ts`; `packages/core/test/pricing.test.ts` |
| Operator cost-rate overrides | `packages/core/src/cost-rate.ts`, `components/CostRateCard.tsx` | Editable rates feeding estimates. | unresolved — override input plus recomputation test in `packages/core/test/pricing.test.ts` and a dashboard affordance |
| Report-timezone day math | `packages/core/src/time.ts` | Calendar-day windows and formatting in the report timezone. | implemented — `packages/core/src/today.ts`; `packages/core/test/today.test.ts` |
| History, trend, filter, and type domains | `packages/core/src/trends.ts`, `filters.ts`, `types.ts` | Aggregation, filtering, and shared types with OpenAI categories. | implemented — `packages/core/src/history.ts`, `types.ts`, `usage.ts`; `packages/core/test/history.test.ts`, `packages/core/test/usage.test.ts` |
| Prompt-text analysis domain | `packages/core/src/prompt-text.ts`, `wire-prompt.ts` | Prompt section analysis from wire bodies. | implemented (adapted) — `inspectCaptureRequest`/`analyzePrompt` over Responses bodies in `packages/core/src/inspection.ts`; `packages/core/test/inspection.test.ts` |
| Claude-source domains awaiting rationale | `packages/core/src/{commands,concepts,cli-args,cli-internals,code-view,fallbacks,launch-aliases,main-history,provenance,skim,system-prompt,withheld,json}.ts` | Each module closes as adapted or explicitly non-applicable. | unresolved — rationale sweep against [ADR 0008](../adrs/0008-pin-plane-parity.md), decided per module and recorded in this matrix |

### Dashboard routes

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Overview route | `routes/overview.tsx` | Today's tokens, cost (nullable), and live status. | implemented — `apps/admin/src/OverviewPage.tsx` at `#/`; `apps/admin/src/overview/machine.test.ts` |
| Trends route | `routes/trends.tsx` | Windowed daily trends. | implemented — `#/trends` via `apps/admin/src/car/trendsPage.tsx`; `apps/admin/src/car/trendsPage.test.tsx` |
| History and filter route | `routes/filters.tsx` | Date ranges and model filters. | implemented (adapted) — `#/history` with URL-parameter filters; `apps/admin/src/car/historyPage.tsx`, `filterBar.tsx`, `searchParams.ts`; `apps/admin/src/car/historyPage.test.tsx` |
| Trend drill-down route | `routes/trend-detail.tsx` | Per-model/per-day trend destination. | unresolved — destination off `#/trends`; component test beside `trendsPage.test.tsx` |
| Inspection routes | `routes/context.tsx`, `context-thread.tsx`, `context-detail.tsx`, `context-message.tsx`, `context-tool.tsx`, `tools.tsx`, `tool-schema.tsx`, `prompt-detail.tsx`, `prompt-section.tsx` | Context, message, tool, schema, and prompt inspection pages. | implemented — `#/boat*` pages in `apps/admin/src/boat/boatPages.tsx`, registered in `router.tsx` `BOAT_PATHS`; `apps/admin/src/boat/boatPages.test.tsx` |
| Session routes | `routes/sessions.tsx`, `session-detail.tsx`, `session-graph.tsx`, `session-errors.tsx` | Session list, detail, graph, and error destinations. | unresolved — destinations for the session endpoints above; component tests |
| Source-browser routes | `routes/{concepts,concept-detail,projects,project-detail,memory-detail,skim,withheld,cli-function,cli-internals,system-prompt,commands,command-detail,command-run}.tsx` | Browser pages for Claude-local sources. | unresolved — each closes with an implemented destination or an explicit rationale citing [ADR 0008](../adrs/0008-pin-plane-parity.md) |

### Shared components and hooks

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Stat cards and usage meter | `components/StatCard.tsx`, `UsageMeter.tsx` | Aggregate display cards on the Overview. | implemented — Overview cards in `apps/admin/src/OverviewPage.tsx`; aggregation covered by `apps/admin/src/overview/machine.test.ts` |
| Live indicator and badges | `components/LiveIndicator.tsx`, `LivenessBadge.tsx`, `HealthBadge.tsx`, `useLiveQuery.ts` | Live-state indication driven by SSE. | implemented (adapted) — SSE-driven refresh in `apps/admin/src/overview/useLiveOverview.ts`; `apps/admin/src/overview/machine.test.ts` |
| Filter controls and model picker | `components/ModelPicker.tsx`, `Segmented.tsx` | Model selection and segmented controls. | implemented (adapted) — `apps/admin/src/car/filterBar.tsx`; `apps/admin/src/car/historyPage.test.tsx` |
| Formatting utilities | `apps/admin/src/format.ts`, `metrics.ts` | Token/cost/date formatting shared by pages. | implemented — `apps/admin/src/car/format.ts`, `apps/admin/src/overview/format.ts`; exercised by `historyPage.test.tsx` |
| Charts | `components/BarChart.tsx`, `Sparkline.tsx`, `SeriesLineChart.tsx`, `TrendCarousel.tsx` | Visualization components for trends and mixes. | unresolved — extract chart components with rendering tests; current `trendsPage.tsx` ships a plain table |
| Query, loading, and skeleton states | `components/QueryState.tsx`, `Skeleton.tsx` | Loading, empty, and error states. | unresolved — states component with rendering test used by Car and Boat pages |
| Markdown and code rendering | `components/Markdown.tsx`, `CodeBlock.tsx` | Message-body rendering in inspection views. | unresolved — render step for Boat message pages with a component test |
| Navigation affordances | `components/Breadcrumbs.tsx`, `SessionsSidenav.tsx`, `useNavDrawer.ts`, `routes/nav.ts` | Drill-down navigation between related views. | unresolved — navigation for the session/drill-down routes above; component test |
| Scroll, theme, and transition hooks | `useRestoredScroll.ts`, `useTheme.ts`, `useTransitionState.ts`, `scrollbar-activity.ts`, `useRailCollapsed.ts`, `useStationInView.ts`, `useResolvedSessions.ts` | Interaction-polish hooks where a route needs them. | unresolved — adopt per interaction with component tests naming each hook |

### Visual system

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Design token contract | `styles/tokens.css` | Token custom properties preserved by name and value. | unresolved — adopt token names into `apps/admin/src/styles.css` and assert presence in the emitted CSS bundle |
| Base, shell, and layout contracts | `styles/base.css`, `layout/shell.css`, `layout/narrow-shell.css`, `layout/card.css`, `layout/workspace.css` | Page shell and card layout structure. | unresolved — shell parity asserted against rendered admin pages |
| Component styling | `styles/components/*.css` (badge, chart, stat-card, table, timeline, skeleton, markdown, rawjson, …) | Card, badge, status, table, and chart styling. | unresolved — style each adopted component with class-level assertions |
| Theme, focus, and motion contracts | `styles/base.css`, `scrollbar.css` | Responsive breakpoints, theme switching, focus-visible, reduced motion. | unresolved — `prefers-color-scheme`/focus/reduced-motion rules asserted in emitted CSS |

### Documentation and tooling

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Setup, architecture, and decision documentation | `README.md`, `AGENTS.md`, `docs/adrs/`, `docs/features/` | Setup, architecture, features, and decisions. | implemented — root `README.md` quickstart, `AGENTS.md` map and constraints, `docs/specs/bike-architecture.md`, `docs/features/`, `docs/adrs/index.md` |
| Headless operation and recovery documentation | `README.md`, `docs/features/retention-lifecycle.md` | Documented ingest, rebuild, and retention operation. | unresolved — document the ingest/rebuild/`maintain` invocations in a dedicated README section |
| Verification gates and CI | root `package.json`, `biome.json`, `.oxlintrc.json`, CI workflow | Install, lint, format, test, build, and anti-slop guarantees. | implemented — `pnpm verify` chains the five gates mirrored by `.github/workflows/verify.yml`; `biome.json`, `.oxlintrc.json` |
| Worktree bootstrap | `scripts/bootstrap-worktree.sh` | Reproducible worktrees: env symlinks and frozen install. | implemented — `scripts/bootstrap-worktree.sh` resolving the main checkout from `git rev-parse --git-common-dir` |
| All-up dev session layout | `.zellij/claude-proxy.kdl`, `scripts/zellij.sh` | One session launching every process. | unresolved — add a zellij layout opening proxy, server, and admin panes |

The immutable comparison point stays the pinned commit; a later `claude-proxy` default branch does not add scope
silently. Moving the pin requires superseding [ADR 0008](../adrs/0008-pin-plane-parity.md).
