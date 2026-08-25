---
type: roadmap
title: Bike to Plane (codex)
description: Five complete outcomes from live sanitized usage to pinned claude-proxy parity.
tags: [roadmap, bike, car, boat, train, plane]
timestamp: 2026-08-19
scope: codex
provenance:
  - repo: codex-proxy
    file: docs/roadmap/bike-to-plane.md
---

# Bike to Plane

> “Incremental delivery ships a bike, then a plane: every phase reaches the destination on its own, and each phase is more complex.”

The ladder is fixed by [ADR 0021](../adrs/0021-outcome-ladder.md). Every phase must remain independently useful,
and each later phase must preserve the safety and operating path of every earlier one.

## Bike

Bike transparently forwards OpenAI/Codex traffic, records sanitized metrics, materializes a disposable SQLite view,
reports live process status, and presents one Overview with today's input tokens, output tokens, and cost. Cost is
nullable and explicit. The proxy, server, and browser stay separate. Final sidecars, not SQLite, are durable truth.

Bike excludes history, trends, filters, body capture, inspection, and operator automation.

## Car

Car adds durable history, trend views, date ranges, and model/range filters. It retains the live Overview and remains
fully useful without any Boat inspection data or body capture.

Car shipped through the `car-release` campaign (PRs #14–#19): core range and aggregation domain, server history API
on view schema v2, `/history` and `/trends` dashboard routes, and durable feature/spec documentation verified against
the running server. See [docs/features/codex-car.md](../features/codex-car.md) and
[docs/specs/codex-car-architecture.md](../specs/codex-car-architecture.md).

```text
$dev --slug car-release build Car in codex-proxy: add durable usage history, trend views, date ranges, and model/range filters while preserving Bike's transparent forwarding, sanitized-only storage, nullable complete cost, live Overview, process separation, and rebuildable SQLite view. Exclude request/response body capture, prompt/tool/session inspection, and operator automation. Update durable feature, architecture, roadmap, and decision docs; verify fresh install, aggregate gates, historical accuracy, filters, timezone boundaries, SSE continuity, and Bike regression coverage; ship through the repository's campaign workflow.
```

## Boat

Boat adds explicit opt-in request and response body capture with redaction and retention controls, then uses that
data for context, tool, prompt, and session inspection. Capture defaults off; Bike and Car remain safe and complete
when inspection data does not exist.

```text
$dev --slug boat-release build Boat in codex-proxy: add explicit opt-in body capture with tested redaction and retention controls plus context, tool, prompt, and session inspection while preserving every Bike and Car outcome. Capture MUST default off, sanitized metrics MUST remain sufficient for usage/history, and the repository MUST remain useful with no inspection data. Exclude operator automation, coaching, suggestions, and final parity catch-up. Update durable feature, privacy, retention, architecture, roadmap, and decision docs; verify secret non-retention when disabled, redaction and deletion when enabled, historical views without bodies, aggregate gates, and end-to-end inspection flows; ship through the repository's campaign workflow.
```

## Train

Train adds operator workflows, automation, daily summaries, suggestions, coaching, recovery, and maintenance
surfaces. Every action has a headless command or a documented operational path; the dashboard is not the only way
to operate or recover the system.

```text
$dev --slug train-release build Train in codex-proxy: add operator workflows, automation, daily summaries, suggestions, coaching, recovery, and maintenance surfaces while preserving all Bike, Car, and Boat outcomes and privacy defaults. Give every action a headless command or documented operational path. Exclude undifferentiated Plane parity work. Update durable feature, operations, recovery, architecture, roadmap, and decision docs; verify CLI/UI parity, unattended failure handling, restore and maintenance drills, aggregate gates, and regressions across all earlier phases; ship through the repository's campaign workflow.
```

## Plane

Plane reaches complete capability and operational parity with `claude-proxy` commit
`cc25696504e724bd78824e639e97a0a1d846abea`, adapted to the OpenAI Responses contract under
[ADR 0018](../adrs/0018-use-responses-contract.md) and pinned by
[ADR 0025](../adrs/0025-pin-plane-parity.md). Plane is complete only when every applicable matrix row below is
implemented and verified, and every non-applicable row carries an explicit OpenAI-specific rationale. A category
summary or visual resemblance is not parity.

```text
$dev --slug plane-release build Plane in codex-proxy: close every unresolved row in docs/roadmap/bike-to-plane.md against claude-proxy commit cc25696504e724bd78824e639e97a0a1d846abea, adapting applicable behavior to the OpenAI Responses contract and writing an explicit OpenAI-specific rationale for every non-applicable row. Preserve every Bike, Car, Boat, and Train outcome, privacy default, headless path, recovery promise, and the source dashboard style system. Update the parity matrix and all affected durable feature, spec, operations, and decision docs; verify every row with tests or recorded operational evidence, run the aggregate verifier, and ship through the repository's campaign workflow. Plane is incomplete while any row is unresolved.
```

## Pinned Plane parity matrix

`Pinned evidence` names the stable source surface at the pinned commit. `Plane closure` is the required adapted
outcome. All rows begin unresolved; the Plane campaign changes a row only to `implemented` with evidence or `N/A`
with an OpenAI-specific rationale.

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Transparent proxy wire behavior | `proxy/proxy.ts`, `proxy/wire.ts`, `proxy/json.ts` | Preserve all HTTP traffic and adapt recognized extraction to Responses JSON/SSE. | unresolved |
| Proxy process and session state | `proxy/session.ts`, `proxy/usage-live.ts` | Provide equivalent OpenAI request/session attribution and live state where applicable. | unresolved |
| Proxy prompt and cache analysis | `proxy/system-prompt.ts`, `proxy/cache-breakpoint.ts`, `proxy/skim.ts` | Adapt prompt/cache/skim outcomes to Responses input items, or record protocol-specific N/A rationale. | unresolved |
| Health and summary APIs | `server/src/server.ts`, `server/src/api.ts`, `server/src/summary-render.ts` | Match applicable health, summary, and live-update outcomes on codex-proxy data. | unresolved |
| Usage, trends, and prompt mix | `/api/usage*`, `/api/trends`, `/api/prompt-mix`, `/api/prompt*` | Implement usage limits, trends, prompt analysis, and streams using OpenAI categories. | unresolved |
| Tool and context inspection | `/api/tools`, `/api/tool-schema`, `/api/context*`, `server/src/context-day-memo.ts` | Provide context, message, tool, schema, pagination, and memoized day inspection. | unresolved |
| Projects and memories | `/api/projects*`, `server/src/projects.ts`, `server/src/prompt-store.ts` | Adapt project and memory discovery to Codex sources or justify each unavailable source. | unresolved |
| Sessions and graphs | `/api/sessions*`, `server/src/sessions.ts`, `server/src/pr-sessions.ts` | Match session list/detail, graph, liveness, errors, breakdown, and streams. | unresolved |
| Commands and concepts | `/api/commands*`, `/api/concepts*`, `server/src/command-runs.ts`, `server/src/concepts*.ts` | Preserve command evaluation and concept-store outcomes with headless access. | unresolved |
| Ideas, suggestions, and coaching | `/api/ideas*`, `/api/sessions/suggestions*`, `server/src/ideas*.ts`, `server/src/suggestions-cli.ts` | Match idea lifecycle, suggestion buckets/status, and coaching workflows. | unresolved |
| Operator notes | `/api/notes*`, `server/src/notes-remote.ts` | Preserve notes create/update/archive/restore/search and concurrency semantics. | unresolved |
| Chat and agent transport | `/api/chat*`, `server/src/chat*.ts`, `server/src/chat-cli.ts` | Adapt interactive/headless agent transport to the supported Codex execution model. | unresolved |
| Jobs and maintenance APIs | `/api/jobs*`, `/api/main-history*`, `/api/pull-requests*`, `/api/hooks-plugins`, `/api/cli-internals*` | Match applicable job browsing, maintenance, repository, hook/plugin, and CLI-internal surfaces. | unresolved |
| Remaining analytical APIs | `/api/skim*`, `/api/withheld`, `/api/system-prompt`, `/api/filters` | Adapt each analysis to Responses/Codex semantics or record a row-specific N/A rationale. | unresolved |
| Headless daily summary | `server/src/daily-summary.ts` and `summary` package command | Produce and document equivalent unattended daily reporting. | unresolved |
| Headless ingest and repair | `server/src/ingest-cli.ts`, `prompt-backfill-cli.ts`, `maintain-cli.ts` | Match ingest, backfill, retention, archive, and recovery operations. | unresolved |
| Headless ideas and suggestions | `server/src/ideas-cli.ts`, `suggestions-cli.ts` | Match list, lifecycle, and automation operations outside the browser. | unresolved |
| Core domain library | `packages/core/src/*.ts` | Account for every exported domain: usage, trends, context, sessions, commands, concepts, ideas, notes, jobs, advice, filters, liveness, and support types. | unresolved |
| SQLite persistence | `server/src/db/*.ts`, migrations, source/watermark runtime | Match applicable stores, transactional ingest, migrations, rebuilds, and data-source parity checks. | unresolved |
| Dashboard route inventory | `apps/admin/src/routes/*.tsx`, `registry.ts`, `route-root.tsx`, `router.tsx` | Account for all 38 registered modules/routes with an implemented destination or explicit N/A rationale. | unresolved |
| Dashboard shared components | `apps/admin/src/components/*.tsx`, hooks, formatting and graph modules | Match each applicable shared interaction, live-state, loading, navigation, and visualization outcome. | unresolved |
| Exact visual system | `apps/admin/src/styles/**`, `styles.css` | Preserve token names/values and applicable base, shell, card, badge, status, responsive, theme, focus, and motion contracts. | unresolved |
| Operational documentation | `README.md`, `AGENTS.md`, `docs/features/**`, `docs/specs/**`, `docs/adrs/**`, `docs/wayfinder/**` | Provide equivalent setup, headless operation, recovery, feature, architecture, and decision coverage for codex-proxy. | unresolved |
| Repository verification and tooling | root scripts, Biome/Oxlint configuration, worktree/bootstrap scripts | Match applicable install, generated-state, lint, test, build, environment, and worktree guarantees. | unresolved |

When Plane begins, expand grouped rows into individual checkable rows before implementation. The immutable comparison
point stays the pinned commit; a later `claude-proxy` default branch does not add scope silently.
