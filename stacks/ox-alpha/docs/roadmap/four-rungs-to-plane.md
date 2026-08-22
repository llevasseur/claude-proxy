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

`Pinned evidence` names the stable source surface at the pinned commit. A row closes only as `implemented` with
evidence or `N/A` with a rationale; rows whose only producer would have been Train are pre-closed `N/A` per
[ADR 0004](../adrs/0004-four-rung-outcome-ladder.md).

| Surface | Pinned evidence | Plane closure | Status |
|---|---|---|---|
| Transparent proxy wire behavior | `proxy/proxy.ts`, `proxy/wire.ts`, `proxy/json.ts` | Preserve all HTTP traffic and adapt recognized extraction to Responses JSON/SSE. | unresolved |
| Proxy process and session state | `proxy/session.ts`, `proxy/usage-live.ts` | Provide equivalent request/session attribution and live state where applicable. | unresolved |
| Health and summary APIs | `server/src/server.ts`, `server/src/api.ts` | Match applicable health, summary, and live-update outcomes. | unresolved |
| Usage, trends, and prompt mix | `/api/usage*`, `/api/trends`, `/api/prompt-mix`, `/api/prompt*` | Implement usage limits, trends, prompt analysis, and streams using OpenAI categories. | unresolved |
| Tool and context inspection | `/api/tools`, `/api/tool-schema`, `/api/context*` | Provide context, message, tool, schema, pagination, and memoized day inspection (Boat). | unresolved |
| Projects and memories | `/api/projects*`, `server/src/projects.ts` | Adapt project and memory discovery or justify each unavailable source. | unresolved |
| Sessions and graphs | `/api/sessions*`, `server/src/sessions.ts` | Match session list/detail, graph, liveness, errors, breakdown, and streams. | unresolved |
| Ideas, suggestions, and coaching | `/api/ideas*`, `server/src/ideas*.ts`, `suggestions-cli.ts` | N/A — Train surface closed by ADR 0004. | N/A (ADR 0004) |
| Operator notes | `/api/notes*`, `server/src/notes-remote.ts` | N/A — Train surface closed by ADR 0004. | N/A (ADR 0004) |
| Chat and agent transport | `/api/chat*`, `server/src/chat*.ts` | Adapt interactive/headless agent transport or record a protocol-specific rationale. | unresolved |
| Jobs and maintenance APIs | `/api/jobs*`, `/api/hooks-plugins` | N/A — Train surface closed by ADR 0004 except where a read-only browsing outcome falls out of earlier phases. | N/A (ADR 0004) |
| Headless daily summary | `server/src/daily-summary.ts` | N/A — Train surface closed by ADR 0004. | N/A (ADR 0004) |
| Headless ingest and repair | `server/src/ingest-cli.ts`, `maintain-cli.ts` | Match ingest, backfill, retention, archive, and recovery operations as headless commands. | unresolved |
| Core domain library | `packages/core/src/*.ts` | Account for every applicable exported domain with OpenAI categories. | unresolved |
| SQLite persistence | `server/src/db/*.ts`, migrations, source/watermark runtime | Match applicable stores, transactional ingest, migrations, rebuilds, and data-source checks. | unresolved |
| Dashboard route inventory | `apps/admin/src/routes/*.tsx`, `registry.ts` | Account for all applicable routes with an implemented destination or explicit rationale. | unresolved |
| Dashboard shared components | `apps/admin/src/components/*.tsx`, hooks, formatting modules | Match each applicable shared interaction, live-state, loading, navigation, and visualization outcome. | unresolved |
| Exact visual system | `apps/admin/src/styles/**`, `styles.css` | Preserve token names/values and applicable base, shell, card, badge, status, responsive, theme, focus, and motion contracts. | unresolved |
| Operational documentation | `README.md`, `AGENTS.md`, `docs/**` | Provide equivalent setup, headless operation, recovery, feature, architecture, and decision coverage. | unresolved |
| Repository verification and tooling | root scripts, Biome/Oxlint configuration, worktree/bootstrap scripts | Match applicable install, generated-state, lint, test, build, environment, and worktree guarantees. | unresolved |

When Plane begins, expand grouped rows into individual checkable rows before implementation. The immutable comparison
point stays the pinned commit; a later `claude-proxy` default branch does not add scope silently.
