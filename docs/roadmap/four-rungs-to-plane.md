---
type: roadmap
title: Four rungs to Plane (ox-alpha)
description: Four complete outcomes from live sanitized usage to pinned claude-proxy parity.
tags: [roadmap, bike, car, boat, plane]
timestamp: 2026-08-22
scope: ox-alpha
provenance:
  - repo: ox-alpha-proxy
    file: docs/roadmap/four-rungs-to-plane.md
---

# Four rungs to Plane

> "Incremental delivery ships a bike, then a plane: every phase reaches the destination on its own, and each phase is more complex."

The ladder is fixed by [ADR 0021](../adrs/0021-outcome-ladder.md). Every phase must remain independently
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
[ADR 0018](../adrs/0018-use-responses-contract.md) and pinned by [ADR 0025](../adrs/0025-pin-plane-parity.md).
Plane is complete only when every applicable matrix row below is implemented and verified with evidence, and every
non-applicable row carries an explicit rationale. A category summary or visual resemblance is not parity.

## Live validation outstanding

[ADR 0031](../adrs/0031-automated-boundary-evidence.md) certifies every phase
boundary with automated evidence and defers live end-to-end validation through a
real upstream to the human. Each boundary merge recorded its note in the merged
pull request body; this section consolidates those notes into the single
outstanding list for human post-review. Nothing below has been exercised against
a real upstream yet.

- [ ] Bike boundary (PR #6): forward real OpenAI Responses traffic through the
  proxy with the server attached and confirm sidecars land in `AUDIT_DIR` and
  the Overview updates live.
- [ ] Car boundary (PR #9): confirm live upstream validation through a real
  upstream — history, trends, and filters reflecting real traffic across
  report-timezone days.
- [ ] Boat boundary (PR #11): run proxy + server with `CAPTURE_BODIES=true`
  against real OpenAI Responses traffic and confirm captures appear in each
  dashboard inspection surface.
- [ ] Boat boundary (PR #11): confirm redacted bodies parse correctly through
  the message, tool, prompt, and session views with production-shaped payloads.
- [ ] Boat boundary (PR #11): confirm retention deletion reflects immediately in
  the memoized day view during live operation.

Cross-phase regression coverage in the automated suite: inspection endpoints
serve typed empties and Bike/Car stay exact with zero capture data
(`server/test/capture.test.ts`, `server/test/inspection.test.ts`); summaries
stay exact with capture enabled and a valid capture present
(`server/test/capture.test.ts`); proxy forwarding fidelity is proven per-request
against a fixture upstream (`proxy/test/forwarding.test.ts`). Known structural
gap: forwarding fidelity is never asserted while a populated Car history store
exists in the same running system, because the proxy and server are separate
processes sharing no state — the isolation is architectural, not tested.

## Pinned Plane parity matrix

`Pinned evidence` names the stable source surface at pinned commit
`cc25696504e724bd78824e639e97a0a1d846abea`; every path was verified present in that tree. A row closes only as
`implemented` with concrete evidence from this repository or `N/A` with a rationale — there is no third state
([ADR 0025](../adrs/0025-pin-plane-parity.md)). Every other row starts `unresolved` and names the test, route,
or artifact that will close it. Rows whose only producer would have been Train are pre-closed `N/A` per
[ADR 0021](../adrs/0021-outcome-ladder.md); restoring them requires superseding that record.

### Proxy wire and process state

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Transparent HTTP pass-through of all traffic | `proxy/proxy.ts` | Every request and response forwarded unmodified through the OpenAI upstream (ADR 0024). | implemented — `proxy/test/forwarding.test.ts` |
| Upstream observation and usage extraction | `proxy/wire.ts` | Adapted to Responses JSON/SSE observation without altering the wire. | implemented — `proxy/src/observe.ts`, `packages/core/src/adapters.ts`, `packages/core/src/usage.ts`; `proxy/test/observation.test.ts`, `packages/core/test/adapters.test.ts`, `packages/core/test/usage.test.ts` |
| Safe JSON parsing on the wire path | `proxy/json.ts` | Defensive parse of streamed JSON bodies before sanitization. | implemented — `packages/core/src/adapters.ts` (`jsonResponseIdentity`, `SseResponseObserver`); `packages/core/test/adapters.test.ts` |
| Prompt-cache breakpoint injection | `proxy/cache-breakpoint.ts` | N/A — repairs Claude Code's intermittently dropped `cache_control` message breakpoints; the OpenAI Responses contract has no client-side cache-control field (caching is server-side and automatic, [ADR 0018](../adrs/0018-use-responses-contract.md)), and injecting into any request body would break the transparent surface ([ADR 0024](../adrs/0024-transparent-http-surface.md)). There is no client defect to repair. | N/A (ADR 0018, ADR 0024) |
| Skim / system-prompt request rewriting | `proxy/skim.ts`, `proxy/system-prompt.ts` | N/A — skim intercepts byte-exact repeats before the upstream is called and system-prompt rewrites bodies in flight; both replace the upstream response or alter the request, which ADR 0024 forbids on this repository's transparent surface. | N/A (ADR 0024) |
| Per-request session attribution | `proxy/session.ts` | Attribute captured traffic to derived session identifiers. | implemented — `deriveSessionId` in `packages/core/src/inspection.ts`; `packages/core/test/inspection.test.ts`, `server/test/capture.test.ts` |
| Live process lifecycle status | `proxy/session.ts` | Startup/ready/upstream-error/shutdown status consumed by the dashboard. | implemented — `proxy/src/proxy-status.ts`; `proxy/test/status.test.ts`, surfaced through `/api/events` (`server/test/events.test.ts`) |
| Live rolling usage at the proxy | `proxy/usage-live.ts` | implemented (adapted) — the pinned surface polls Anthropic's OAuth usage endpoint with forwarded credentials; under OpenAI Responses semantics the proxy instead accumulates its own observed per-process usage counters into the status signal: `ProxyStatusWriter.noteUsage` writes `rollingUsage` beside lifecycle state (`proxy/src/proxy-status.ts`), consumed from the status file into `/api/health` and every `/api/events` snapshot. Evidence: `a live Responses exchange publishes rolling usage beside the lifecycle state` in `proxy/test/status.test.ts`; `proxy rolling usage from the status file rides the snapshot and updates` in `server/test/events.test.ts`. Sanitized token counts only — never bodies or credentials. | implemented — `proxy/src/proxy-status.ts`, `server/src/service.ts`; cases above |

### Health, summary, and history APIs

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Health endpoint | `/api/health` | Process-health read. | implemented — `GET /api/health` in `server/src/service.ts`; `server/test/api.test.ts` |
| Today summary endpoint | `/api/summary` | Today's input/output tokens and nullable cost ([ADR 0020](../adrs/0020-unavailable-incomplete-cost.md)). | implemented — `GET /api/summary` in `server/src/service.ts`; `server/test/api.test.ts`, `packages/core/test/today.test.ts`, `packages/core/test/pricing.test.ts` |
| Live summary stream | `/api/summary/stream`, `/api/usage/stream` | Live updates push summary-shaped payloads. | implemented (adapted) — one SSE channel `/api/events` replaces per-route streams; `server/src/events.ts`, `server/test/events.test.ts`, `apps/admin/src/overview/useLiveOverview.ts` |
| Date-range aggregates by report-timezone day | `/api/trends` | Daily buckets over a window, model-filterable. | implemented — `/api/history` and `/api/trends` in `server/src/service.ts`; `server/test/history.test.ts`, `packages/core/test/history.test.ts`, `packages/core/test/today.test.ts` |
| Usage limits endpoint | `/api/usage`, `packages/core/src/usage-limits.ts` | implemented (adapted) — the pinned surface reads Anthropic's OAuth usage endpoint and captured `anthropic-ratelimit-*` headers; neither exists under the OpenAI Responses contract and captured headers would cross the privacy boundary, so meters estimate from recorded tokens against operator-supplied ceilings (`USAGE_LIMIT_5H`, `USAGE_LIMIT_WEEK`), omitting any window with no configured denominator. Domain: `packages/core/src/limits.ts` (`computeUsageWindows`, exact integer deci-unit math, catalogue-derived cached-input weight); route: `GET /api/limits`. Evidence: `packages/core/test/limits.test.ts`; `meters configured rolling windows and omits unconfigured ones` in `server/test/api.test.ts`. | implemented — `packages/core/src/limits.ts`, `server/src/service.ts` (`/api/limits`); tests above |

### Prompt analysis

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Prompt mix endpoint | `/api/prompt-mix`, `packages/core/src/prompt-mix.ts` | implemented (adapted) — the pinned surface cohorts a day's requests by captured system-prompt hash with size-band fallbacks; under Responses semantics the cohort key is the deterministic FNV-1a hash of the captured `instructions` text (`packages/core/src/prompt-mix.ts`, `buildPromptMix`). Served at `GET /api/inspection/prompt-mix` and rendered at `#/boat/prompt-mix`. Evidence: `packages/core/test/prompt-mix.test.ts`; `prompt mix decomposes a report day into cohorts without body text` in `server/test/inspection.test.ts`; `renders the prompt mix and drills down by cohort hash to prompts` in `apps/admin/src/boat/boatPages.test.tsx`. | implemented — `packages/core/src/prompt-mix.ts`, `/api/inspection/prompt-mix`, `#/boat/prompt-mix`; tests above |
| Prompt drill-down endpoints | `/api/prompt`, `/api/prompt/section` | implemented (adapted) — hash- and section-level lookups over captured requests instead of a persisted prompt store: `GET /api/inspection/prompts?date=&hash=` lists per-day prompt entries by instructions hash, and `GET /api/inspection/prompt-sections?recordId=` returns the named section breakdown (instructions plus indexed input messages, char counts only). The existing `#/boat/prompt` page renders the section table; the mix page links cohorts to their hash listing. Evidence: `prompt listings support hash drill-down and section lookups` in `server/test/inspection.test.ts`; `shows prompt sections with sizes but no body text on the prompt page` in `apps/admin/src/boat/boatPages.test.tsx`. | implemented — `/api/inspection/prompts`, `/api/inspection/prompt-sections`; tests above |

### Tool and context inspection (Boat)

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Tool inventory with schema summaries | `/api/tools` | Tools observed in captured traffic. | implemented — `/api/inspection/tools` in `server/src/service.ts`; `server/test/inspection.test.ts`, `packages/core/test/inspection.test.ts` |
| Name-keyed tool schema detail | `/api/tool-schema` | implemented — `GET /api/inspection/tool-schema?name=` aggregates one tool's occurrences, schema variants, first/last seen, and recordIds across days. Evidence: `tool schema detail aggregates one tool name across captures` in `server/test/inspection.test.ts`. | implemented — `server/src/service.ts`; case above |
| Context window table (pagination + search) | `/api/context` | implemented (adapted) — `GET /api/inspection/context` paginates every captured window with `search=` substring matching over recordId/model/session/endpoint plus `sort` (asc/desc) by capture time. Evidence: `context listing searches and sorts across all captures` in `server/test/inspection.test.ts`. | implemented — `server/src/service.ts`; case above |
| Day context window | `/api/context/day` | One report day summarized whole. | implemented — `/api/inspection/day` in `server/src/service.ts`; `server/test/inspection.test.ts` |
| Memoized day/digest caches | `server/src/context-day-memo.ts`, `server/src/day-digest-memo.ts` | implemented — day assemblies and parsed-capture listings memoize in the server against a capture-signature + retention-deletion epoch key (`LiveUsageService.dayMemos`/`captureMemo`, `inspectionEpoch` in `server/src/service.ts`). Evidence: `memoized day inspection invalidates on capture change and retention deletion` and the repeated-request assertions in `server/test/inspection.test.ts`; `service.inspectionStats()` exposes assembly/cache-hit counters. | implemented — `server/src/service.ts`; `server/test/inspection.test.ts` |
| Message drill-down | `/api/context/detail`, `/api/context/message` | Individual captured messages by record and index. | implemented — `/api/inspection/messages` in `server/src/service.ts`; `server/test/inspection.test.ts` |
| Tool-call drill-down | `/api/context/tool` | Individual captured tool calls. | implemented — `/api/inspection/tool-calls` in `server/src/service.ts`; `server/test/inspection.test.ts` |

### Sessions, liveness, and graphs

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Captured-session listing | `/api/sessions` | Sessions reconstructed from captures. | implemented — `/api/inspection/sessions` in `server/src/service.ts`; `server/test/inspection.test.ts` |
| Session detail and breakdown | `/api/sessions/session`, `/api/sessions/breakdown` | implemented — `GET /api/inspection/sessions/detail?id=` returns one session's capture summaries; `GET /api/inspection/sessions/breakdown?id=` counts its captures by model and by hour. Evidence: `session detail and breakdown are id-scoped` in `server/test/inspection.test.ts`. | implemented — `server/src/service.ts`; cases above |
| Session liveness | `packages/core/src/liveness.ts`, `/api/sessions/liveness` | implemented (adapted) — the pinned verdict is derived from transcript mtimes plus terminal turns; under Responses captures it derives from newest-capture time plus terminal `response.completed` evidence: pure `classifyLiveness` in `packages/core/src/liveness.ts`, exposed as a `liveness` field on every session listing entry. Evidence: `packages/core/test/liveness.test.ts`; `session listings carry derived liveness verdicts` in `server/test/inspection.test.ts`. | implemented — `packages/core/src/liveness.ts`; tests above |
| Live session graph | `/api/sessions/graph*`, `/api/sessions/node-text`, `apps/admin/src/graph-agents.ts`, `graph-layout.ts` | N/A — the pinned graph renders Claude Code harness parent/subagent transcript trees (`SessionNode` streams with delegation stripes). OpenAI Responses captures carry no parent–child agent relationship and none can be derived without inventing one, so no faithful adaptation exists. Session structure remains addressable through the session list, detail, breakdown, and liveness surfaces above. | N/A (ADR 0025) |
| Session errors view | `/api/sessions/errors` | implemented (adapted) — error classification over ingest sources: `GET /api/inspection/errors` lists rejected sidecars with reasons and timestamps plus unreadable-capture counts. Evidence: `error inspection lists rejected sidecars and unreadable captures` in `server/test/inspection.test.ts`. | implemented — `server/src/service.ts`; case above |

### Projects and memories

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Project discovery and memory browsing | `/api/projects*`, `server/src/projects.ts` | N/A — the pinned surface browses local Claude Code project directories and CLAUDE.md-style memory files on the operator's machine. This repository proxies OpenAI Responses API traffic and records only sanitized sidecars and redacted captures; it deliberately holds no local project or memory source to discover, and inventing one would cross the privacy boundary. | N/A (ADR 0025) |

### Chat and agent transport

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Dashboard agent-chat transport | `/api/chat*`, `server/src/chat*.ts`, `chat-stream.ts`, `apps/admin/src/useChatStream.ts`, `ChatConversation.tsx` | N/A — the pinned chat drives operator conversations with agents, which is Train's operator-automation domain ([ADR 0021](../adrs/0021-outcome-ladder.md)); it would also make the dashboard originate upstream traffic, which the transparent surface forbids ([ADR 0024](../adrs/0024-transparent-http-surface.md)). Restoring it requires superseding ADR 0021. | N/A (ADR 0021, ADR 0024) |

### Train-closed surfaces

Every row below has no producing phase; see [ADR 0021](../adrs/0021-outcome-ladder.md).

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Ideas ledger APIs | `/api/ideas*`, `server/src/ideas-cli.ts`, `ideas-pr.ts`, `ideas-store.ts`, `ideas-remote.ts`, `packages/core/src/ideas.ts` | N/A — Train surface. | N/A (ADR 0021) |
| Suggestion buckets and coaching | `/api/sessions/suggestions*`, `server/src/suggestions-cli.ts`, `suggestion-status.ts`, `packages/core/src/suggestions.ts`, `suggestion-status.ts`, `advice.ts`, `components/AdviceCard.tsx`, `routes/advice.tsx` | N/A — Train surface. | N/A (ADR 0021) |
| Operator notes | `/api/notes*`, `server/src/notes-remote.ts`, `packages/core/src/notes.ts`, `routes/notes.tsx` | N/A — Train surface. | N/A (ADR 0021) |
| Headless daily summary | `server/src/daily-summary.ts`, `summary-render.ts`, `packages/core/src/digest.ts` | N/A — Train surface. | N/A (ADR 0021) |
| Jobs browsing and deletion | `/api/jobs*` including `POST /api/jobs/delete`, `server/src/jobs.ts`, `packages/core/src/jobs.ts`, `routes/jobs.tsx`, `job-detail.tsx`, `components/JobFileTree.tsx`, `JobFileView.tsx` | N/A — Train surface; no read-only fallout occurred in earlier phases. | N/A (ADR 0021) |
| Hooks/plugins inventory | `/api/hooks-plugins`, `packages/core/src/hooks-plugins.ts`, `routes/hooks-plugins.tsx` | N/A — Train surface; no read-only fallout occurred in earlier phases. | N/A (ADR 0021) |
| Pull-request tree | `/api/pull-requests*`, `server/src/pr-sessions.ts`, `github.ts`, `db/pr-scan-store.ts`, `db/pull-request-store.ts`, `packages/core/src/pull-requests.ts`, `routes/pull-requests.tsx` | N/A — only producer was the Train ideas/jobs pipeline. | N/A (ADR 0021) |
| Scheduled maintenance launcher | `scripts/com.llevasseur.claude-proxy.maintain.plist` | N/A — Train maintenance automation. | N/A (ADR 0021) |
| Archive/backfill/recovery CLI | `server/src/maintain-cli.ts` (archive/recovery slices), `prompt-backfill-cli.ts`, `prompt-backfill.ts` | N/A — Train maintenance/recovery operations. | N/A (ADR 0021) |
| Operator route inventory | `routes/registry.ts` entries for advice, ideas, suggestion-bucket, notes, jobs, hooks-plugins, pull-requests | N/A — Train surfaces above. | N/A (ADR 0021) |

### Headless ingest and maintenance

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Transactional sidecar-to-SQLite ingest | `server/src/db/ingest.ts`, `ingest-sessions.ts`, `ingest-commands.ts`, `ingest-concepts.ts` | Watermarked, idempotent ingest from final sidecars (truth stays in sidecars, [ADR 0019](../adrs/0019-sanitized-audit-sidecars.md)). | implemented — `SidecarIngestor` in `server/src/ingest.ts` with `ingest_watermarks` in `server/src/database.ts`; `server/test/ingest.test.ts` |
| Rebuildable disposable store | `server/src/db/open.ts`, `runtime.ts`, `usage-day-store.ts` | SQLite rebuildable from sidecars; never durable truth. | implemented — schema bootstrap in `server/src/database.ts`; `server/test/index.test.ts`, `server/test/ingest.test.ts` |
| Capture retention pass | `server/src/retention.ts` and the retention slice of `maintain-cli.ts` | Expire and cap captured bodies when capture is enabled. | implemented — headless pass in `server/src/maintain.ts`; `docs/specs/capture-retention.md`, `server/test/capture.test.ts` |
| Store/source consistency checks | `server/src/db/source.ts` | implemented — read-only `auditConsistency`/`isConsistent` over the sidecar directory versus `usage_records`, watermarks, and orphaned sources (`server/src/consistency.ts`), run headlessly by the `maintain` command alongside retention. Evidence: `consistency audit detects records, watermarks, and orphans drifting apart` and the rebuild-consistency assertions in `server/test/ingest.test.ts`. | implemented — `server/src/consistency.ts`, `server/src/maintain.ts`; cases above |

### Core domain library

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Model pricing catalogue | `packages/core/src/pricing.ts` | Deterministic cost estimation with explicit catalogue version. | implemented — `packages/core/src/pricing.ts`; `packages/core/test/pricing.test.ts` |
| Operator cost-rate overrides | `packages/core/src/cost-rate.ts`, `components/CostRateCard.tsx` | implemented — `apps/admin/src/ui/costRateCard.tsx` accepts operator USD/MTok rates (persisted per browser), rebuilds a catalogue and recomputes the listed usage through core's exact `estimateUsageCost` (`recomputeCost`); mounted under the History table where full usage splits are available. Recorded sidecar costs are never rewritten. Evidence: `apps/admin/src/ui/costRateCard.test.tsx` (exact arithmetic, invalid-rate rejection, persistence across remounts). | implemented — `apps/admin/src/ui/costRateCard.tsx`; tests above |
| Report-timezone day math | `packages/core/src/time.ts` | Calendar-day windows and formatting in the report timezone. | implemented — `packages/core/src/today.ts`; `packages/core/test/today.test.ts` |
| History, trend, filter, and type domains | `packages/core/src/trends.ts`, `filters.ts`, `types.ts` | Aggregation, filtering, and shared types with OpenAI categories. | implemented — `packages/core/src/history.ts`, `types.ts`, `usage.ts`; `packages/core/test/history.test.ts`, `packages/core/test/usage.test.ts` |
| Prompt-text analysis domain | `packages/core/src/prompt-text.ts`, `wire-prompt.ts` | Prompt section analysis from wire bodies. | implemented (adapted) — `inspectCaptureRequest`/`analyzePrompt` over Responses bodies in `packages/core/src/inspection.ts`; `packages/core/test/inspection.test.ts` |
| Claude-source domains awaiting rationale | `packages/core/src/{commands,concepts,cli-args,cli-internals,code-view,fallbacks,launch-aliases,main-history,provenance,skim,system-prompt,withheld,json}.ts` | Each module closes explicitly. `json` → implemented as safe JSON parsing in `packages/core/src/adapters.ts` (`jsonResponseIdentity`, `SseResponseObserver`; `packages/core/test/adapters.test.ts`). `skim`, `system-prompt`, `fallbacks` → N/A: response caching and request-body rewriting violate the transparent surface ([ADR 0024](../adrs/0024-transparent-http-surface.md)). `commands`, `concepts`, `cli-args`, `cli-internals`, `code-view`, `launch-aliases`, `main-history`, `provenance`, `withheld` → N/A: browsers of Claude-local sources (CLI internals, transcripts, provenance ledgers) with no OpenAI-ecosystem equivalent in a clean-room rebuild; nothing analogous exists to adapt ([ADR 0025](../adrs/0025-pin-plane-parity.md)). | closed — per-module rationales above |

### Dashboard routes

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Overview route | `routes/overview.tsx` | Today's tokens, cost (nullable), and live status. | implemented — `apps/admin/src/OverviewPage.tsx` at `#/`; `apps/admin/src/overview/machine.test.ts` |
| Trends route | `routes/trends.tsx` | Windowed daily trends. | implemented — `#/trends` via `apps/admin/src/car/trendsPage.tsx`; `apps/admin/src/car/trendsPage.test.tsx` |
| History and filter route | `routes/filters.tsx` | Date ranges and model filters. | implemented (adapted) — `#/history` with URL-parameter filters; `apps/admin/src/car/historyPage.tsx`, `filterBar.tsx`, `searchParams.ts`; `apps/admin/src/car/historyPage.test.tsx` |
| Trend drill-down route | `routes/trend-detail.tsx` | implemented — `#/trends/detail?date=&model=` renders one report day's records, reached from a linked day cell in the trends table. Evidence: `links each day to its drill-down and renders that day's records` in `apps/admin/src/car/trendsPage.test.tsx`. | implemented — `apps/admin/src/car/trendDetailPage.tsx`; test above |
| Inspection routes | `routes/context.tsx`, `context-thread.tsx`, `context-detail.tsx`, `context-message.tsx`, `context-tool.tsx`, `tools.tsx`, `tool-schema.tsx`, `prompt-detail.tsx`, `prompt-section.tsx` | Context, message, tool, schema, and prompt inspection pages. | implemented — `#/boat*` pages in `apps/admin/src/boat/boatPages.tsx`, registered in `router.tsx` `BOAT_PATHS`; `apps/admin/src/boat/boatPages.test.tsx` |
| Session routes | `routes/sessions.tsx`, `session-detail.tsx`, `session-graph.tsx`, `session-errors.tsx` | implemented (graph N/A above) — `#/boat/sessions/detail?id=` renders one session's captures plus model/hour breakdown; `#/boat/sessions/errors` lists rejected sidecars and unreadable captures. Evidence: `renders session detail with breakdown from the sessions listing` and `lists ingest errors and renders the all-clear state` in `apps/admin/src/boat/boatPages.test.tsx`. | implemented — `apps/admin/src/boat/boatPages.tsx`; tests above |
| Source-browser routes | `routes/{concepts,concept-detail,projects,project-detail,memory-detail,skim,withheld,cli-function,cli-internals,system-prompt,commands,command-detail,command-run}.tsx` | N/A — every pinned destination browses a Claude-local source whose producing module closes N/A in the core-domain sweep above (projects/memories, skim/withheld, CLI internals and commands). There is no source to browse in this repository's scope. | N/A (ADR 0025) |

### Shared components and hooks

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Stat cards and usage meter | `components/StatCard.tsx`, `UsageMeter.tsx` | Aggregate display cards on the Overview. | implemented — Overview cards in `apps/admin/src/OverviewPage.tsx`; aggregation covered by `apps/admin/src/overview/machine.test.ts` |
| Live indicator and badges | `components/LiveIndicator.tsx`, `LivenessBadge.tsx`, `HealthBadge.tsx`, `useLiveQuery.ts` | Live-state indication driven by SSE. | implemented (adapted) — SSE-driven refresh in `apps/admin/src/overview/useLiveOverview.ts`; `apps/admin/src/overview/machine.test.ts` |
| Filter controls and model picker | `components/ModelPicker.tsx`, `Segmented.tsx` | Model selection and segmented controls. | implemented (adapted) — `apps/admin/src/car/filterBar.tsx`; `apps/admin/src/car/historyPage.test.tsx` |
| Formatting utilities | `apps/admin/src/format.ts`, `metrics.ts` | Token/cost/date formatting shared by pages. | implemented — `apps/admin/src/car/format.ts`, `apps/admin/src/overview/format.ts`; exercised by `historyPage.test.tsx` |
| Charts | `components/BarChart.tsx`, `Sparkline.tsx`, `SeriesLineChart.tsx`, `TrendCarousel.tsx` | implemented (adapted) — `apps/admin/src/ui/BarChart.tsx` renders daily aggregates as an accessible SVG column chart above the trends table (the pinned carousel/sparkline/series variants serve surfaces this repository closes N/A or does not need). Evidence: `draws one bar per datum…` in `apps/admin/src/ui/ui.test.tsx`; `trends-chart` asserted in the trends drill-down test. | implemented — `apps/admin/src/ui/BarChart.tsx` on `#/trends`; tests above |
| Query, loading, and skeleton states | `components/QueryState.tsx`, `Skeleton.tsx` | implemented — shared `QueryState` (`apps/admin/src/ui/QueryState.tsx`) renders loading/error/empty with stable test hooks and an optional skeleton class; adopted by the trend drill-down page. Evidence: `renders loading, error, and empty states…` in `apps/admin/src/ui/ui.test.tsx`. | implemented — `apps/admin/src/ui/QueryState.tsx`; test above |
| Markdown and code rendering | `components/Markdown.tsx`, `CodeBlock.tsx` | implemented — `MarkdownText`/`CodeBlock` (`apps/admin/src/ui/Markdown.tsx`) render message bodies as paragraphs, inline code, and fenced blocks with no HTML injection; used by the Boat messages page. Evidence: `splits paragraphs, inline code, and fenced blocks without injecting HTML` in `apps/admin/src/ui/ui.test.tsx`. | implemented — `apps/admin/src/ui/Markdown.tsx`; test above |
| Navigation affordances | `components/Breadcrumbs.tsx`, `SessionsSidenav.tsx`, `useNavDrawer.ts`, `routes/nav.ts` | implemented (adapted) — `Breadcrumbs` (`apps/admin/src/ui/Breadcrumbs.tsx`) links Context → Sessions → detail and Trends → day drill-down pages (a drawer/rail sidenav has no counterpart in this flatter route set). Evidence: `links ancestors and marks the current page` in `apps/admin/src/ui/ui.test.tsx`. | implemented — `apps/admin/src/ui/Breadcrumbs.tsx`; test above |
| Scroll, theme, and transition hooks | `useRestoredScroll.ts`, `useTheme.ts`, `useTransitionState.ts`, `scrollbar-activity.ts`, `useRailCollapsed.ts`, `useStationInView.ts`, `useResolvedSessions.ts` | N/A — those hooks polish a dense shell UI (nav drawer, rails, view transitions, custom scrollbars) that no route in this repository has; theme follows the OS through CSS `color-scheme` and `prefers-color-scheme` without JavaScript. Adopting them now would ship dead code; they reopen alongside any future route that needs them. | N/A (ADR 0025) |

### Visual system

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Design token contract | `styles/tokens.css` | Token custom properties adopted by name and value (ink/surface/line/text/muted/faint, signal palette, font/tracking/radius/motion tokens) in `apps/admin/src/styles.css`, asserted against the emitted bundle. Evidence: `emitted CSS keeps the adopted design token names and values` in `apps/admin/src/css.test.ts`. | implemented — `apps/admin/src/css.test.ts` builds the bundle and reads the produced stylesheet |
| Base, shell, and layout contracts | `styles/base.css`, `layout/shell.css`, `layout/narrow-shell.css`, `layout/card.css`, `layout/workspace.css` | Page shell, card, nav, and table layout classes asserted in the emitted bundle and exercised by rendered-page tests. Evidence: `adopted components keep their styled class contracts` in `apps/admin/src/css.test.ts`; `apps/admin/src/car/historyPage.test.tsx`. | implemented — assertions above |
| Component styling | `styles/components/*.css` (badge, chart, stat-card, table, timeline, skeleton, markdown, rawjson, …) | Chart bars, skeleton sweep, code block, inline code, breadcrumbs, cost-rate card, table, banner badges, and stat metrics styled with class-level assertions on the emitted CSS. Evidence: `adopted components keep their styled class contracts` in `apps/admin/src/css.test.ts`. | implemented (adapted) — assertions above |
| Theme, focus, and motion contracts | `styles/base.css`, `scrollbar.css` | `color-scheme: light dark`, a `prefers-color-scheme: light` token override block carrying the pinned light-theme values, `:focus-visible` outlines, and a reduced-motion block that zeroes `--motion-duration`, asserted in the emitted CSS. Evidence: `emitted CSS carries theme switching, focus-visible, and reduced-motion rules` in `apps/admin/src/css.test.ts`. | implemented — assertion above |

### Documentation and tooling

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Setup, architecture, and decision documentation | `README.md`, `AGENTS.md`, `docs/adrs/`, `docs/features/` | Setup, architecture, features, and decisions. | implemented — root `README.md` quickstart, `AGENTS.md` map and constraints, `docs/specs/bike-architecture.md`, `docs/features/`, `docs/adrs/index.md` |
| Headless operation and recovery documentation | `README.md`, `docs/features/retention-lifecycle.md` | Documented ingest, rebuild, retention, consistency, and limits operation. | implemented — "Headless operation and recovery" section in the root `README.md` covering idempotent watermarked ingest, the delete-and-reconcile rebuild path, `pnpm --filter @agent-proxy/ox-server maintain`, `/api/inspection/errors`, and `GET /api/limits`; retention semantics stay in `docs/specs/capture-retention.md` |
| Verification gates and CI | root `package.json`, `biome.json`, `.oxlintrc.json`, CI workflow | Install, lint, format, test, build, and anti-slop guarantees. | implemented — `pnpm verify` chains the five gates mirrored by `.github/workflows/verify.yml`; `biome.json`, `.oxlintrc.json` |
| Worktree bootstrap | `scripts/bootstrap-worktree.sh` | Reproducible worktrees: env symlinks and frozen install. | implemented — `scripts/bootstrap-worktree.sh` resolving the main checkout from `git rev-parse --git-common-dir` |
| All-up dev session layout | `.zellij/claude-proxy.kdl`, `scripts/zellij.sh` | One session launching every process. | implemented — `.zellij/ox-alpha-proxy.kdl` opens proxy, server, and admin panes plus a spare shell tab; launched via `pnpm zellij`. Evidence: layout parses under zellij 0.44 (`setup --check`). |

The immutable comparison point stays the pinned commit; a later `claude-proxy` default branch does not add scope
silently. Moving the pin requires superseding [ADR 0025](../adrs/0025-pin-plane-parity.md).
