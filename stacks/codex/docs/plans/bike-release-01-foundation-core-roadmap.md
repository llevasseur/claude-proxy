---
type: plan
title: Bike release 01 — Repository foundation, usage core, and roadmap
description: Establish the workspace, pure usage and pricing contracts, and the durable Bike-to-Plane delivery roadmap.
tags: [planning, foundation, core, roadmap]
timestamp: 2026-08-19
wayfinder: bike-release
task: 01
status: todo
---

# Bike release 01 — Repository foundation, usage core, and roadmap

## Outcome

Create the reproducible pnpm/TypeScript repository foundation and the pure
domain contract that every Bike process shares. Publish durable product docs
that define Bike, Car, Boat, Train, and Plane as complete outcomes and provide a
copy-ready `$dev` prompt for each post-Bike phase.

## Dependencies

None. Tasks 02 and 03 depend on this task. Task 04 depends on tasks 01 and 03.

## Owned paths

This ticket alone owns:

- Root project files and contributor tooling, including `package.json`,
  `pnpm-workspace.yaml`, `pnpm-lock.yaml`, TypeScript/Biome/Vitest configuration,
  `.gitignore`, environment examples, verification scripts, and repository
  instructions.
- All workspace package manifests and build configuration under `proxy/`,
  `server/`, `packages/core/`, and `apps/admin/`. Create the complete dependency
  graph here so later tickets do not touch the shared lockfile or manifests.
- `packages/core/**`.
- Durable documentation under `docs/features/**`, `docs/specs/**`, and
  `docs/roadmap/**`, plus documentation indexes. Preserve and link the existing
  `/dev` ADRs in `docs/adrs/**`.

Do not implement proxy forwarding, server routes/storage, or dashboard UI.

## Requirements

### Repository foundation

- Use a pnpm workspace with `proxy/`, `server/`, `packages/core/`, and
  `apps/admin/`. Require Node 22 or newer because Bike uses `node:sqlite`.
- Keep `proxy/` at zero runtime dependencies. Point its executable at TypeScript
  source that Node can run directly with type stripping and explicit `.ts`
  import extensions; do not add a proxy build or `dist/` directory.
- Keep `@codex-proxy/core` pure and free of runtime dependencies. Export its
  TypeScript source directly; do not add a core build or `dist/` directory.
- Give the root deterministic `typecheck`, `test`, `build`, `check`, and
  aggregate `verify` scripts. Ensure a fresh clone needs one documented install
  followed by one documented verification command.
- Commit the lockfile generated from the complete workspace manifests. The
  foundation must not leave a stale lockfile for later tickets.

### Pure usage and pricing core

- Define a versioned sanitized audit-sidecar schema shared by the proxy and
  server. It records only identifiers and metrics needed by Bike: timestamp,
  model, endpoint, response status, request ID when present, input tokens,
  cached input tokens when reported, output tokens, total tokens, and estimated
  cost.
- Normalize non-stream and streaming Responses API usage into one immutable
  domain type. Input and output token totals are required Bike fields; keep
  distinct cached/reasoning categories when the upstream reports them without
  confusing those categories with the headline totals.
- Implement decimal-safe pricing by model and usage category. Prices live in one
  explicit, testable catalogue with units and effective-date/source metadata.
- Return `null` with an availability reason for the whole cost estimate when a
  model or any consumed category has no configured price. Never report zero or
  a partial cost as if it were complete.
- Provide pure aggregation for a Today summary: input tokens, output tokens,
  total tokens, cost or unavailable state, request count, and most recent event
  timestamp. Today is computed in `REPORT_TZ`, defaulting to
  `America/New_York`, and handles daylight-saving boundaries.
- Validate sidecars strictly at the process boundary while keeping core
  calculation functions deterministic and free of filesystem, database,
  environment, clock, or network access.

### Durable product documentation

- Add a Bike feature document and architecture spec explaining the proxy →
  sanitized sidecar → idempotent SQLite view → REST/SSE → Overview flow, process
  boundaries, configuration, data lifecycle, privacy boundary, and recovery.
- Add a durable roadmap whose opening principle quotes exactly:

  > “Incremental delivery ships a bike, then a plane: every phase reaches the destination on its own, and each phase is more complex.”

- Define the fixed outcome ladder:

  - **Bike:** transparent OpenAI/Codex forwarding, sanitized metrics, a
    disposable SQLite view, live status, and one Overview showing today's input
    tokens, output tokens, and cost.
  - **Car:** durable history, trend views, date ranges, and model/range filters;
    the repository remains useful without Boat inspection data.
  - **Boat:** explicit opt-in body capture with redaction/retention controls,
    plus context, tool, prompt, and session inspection; Bike and Car remain safe
    with capture disabled.
  - **Train:** operator workflows, automation, daily summaries, suggestions,
    coaching, and recovery/maintenance surfaces; every action has a headless or
    documented operational path.
  - **Plane:** complete capability and operational parity with
    `claude-proxy` commit
    `cc25696504e724bd78824e639e97a0a1d846abea`, adapted to the OpenAI Responses
    contract. Create a parity matrix from that commit's proxy, server routes,
    CLI jobs, core domains, dashboard routes, persistence, and operational docs;
    Plane is complete only when every applicable row is implemented and every
    non-applicable row has an explicit OpenAI-specific rationale.

- Put at least one copy-ready fenced `$dev` command prompt after Bike. Prefer one
  for Car, Boat, Train, and Plane. Each prompt must state its outcome, exclusions,
  durable-doc updates, verification, and the earlier phase it must preserve.
- Document the fresh-repository and private-publication boundary, sanitized-only
  Bike storage, transparent forwarding promise, nullable cost behavior, live SSE
  overview, process separation, and the disposable database. Link the ADR that
  owns each ungrounded choice.
- Keep `docs/index.md` and all section indexes complete with valid relative
  links. Planning scaffolding remains under `docs/plans/` until the campaign
  closes.

## Acceptance criteria

- A fresh clone installs with the documented command and the aggregate verifier
  passes without generated artifacts copied from another checkout.
- Core tests cover known-model input/output cost, cached or reasoning categories,
  unknown model, missing category price, malformed usage, Today boundaries in
  `America/New_York`, and a daylight-saving transition.
- No core function imports Node runtime modules or reads process state.
- Proxy and core package manifests contain zero runtime dependencies.
- The roadmap contains the exact incremental-delivery quote, all five outcomes,
  the pinned Plane commit, and copy-ready `$dev` prompts for every phase after
  Bike.
- Documentation links resolve and the docs index includes all durable records.

## Verification

- Run `pnpm install --frozen-lockfile` in a clean checkout after the lockfile is
  created.
- Run the repository's aggregate verifier and each root script it delegates to.
- Run the core unit tests directly and inspect package manifests to confirm the
  zero-runtime-dependency guarantees.
- Search the roadmap for the exact quote, all five phase headings, the pinned
  SHA, and four fenced `$dev` prompts.
- Run the repository's documentation link/index check.
