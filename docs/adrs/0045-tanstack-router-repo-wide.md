---
type: adr
title: TanStack Router, repo-wide
description: One router across the fused dashboard, with the hand-written route registry as the single place a page is declared.
tags: [monorepo, dashboard, frontend, routing, campaign]
timestamp: 2026-08-23
scope: all
provenance:
  - campaign: monorepo-fusion
    decided: before the campaign began, by the repository owner
    recorded-by: monorepo-fusion ticket 13
decided-by: user
ratified: true
wayfinder: monorepo-fusion
needs-human: false
---

# TanStack Router, repo-wide

## Status

Accepted. Decided by the repository owner before the `monorepo-fusion` campaign began.
Extends [0002](0002-monorepo-with-pnpm-tanstack-and-node.md), which chose TanStack for
claude-proxy's dashboard, to the whole fused repository.

## Context

The fused dashboard is one application. The three absorbed dashboards did not necessarily
agree on how a page is declared or how its URL state is typed, and a dashboard running two
routers is a dashboard with two navigation models, two ideas of what a link is, and two
places to look when a route does not resolve.

claude-proxy's dashboard already runs TanStack Router against a **hand-written** registry:
`apps/admin/src/routes/registry.ts` lists the route modules, each page file exports its own
`createRoute` call carrying path, component, `staticData.title` and any `validateSearch`,
and `router.tsx` is thin. There is no file-based routing and no generated route tree.

## Decision

**TanStack Router, repo-wide, one router.** Every page in the fused dashboard is a TanStack
route. Absorbed pages are migrated onto it rather than kept on whatever they arrived with.

**The hand-written registry stays hand-written.** A new page is a new file in `routes/` plus
one line in `registry.ts`. Nothing is generated, and the absorbed pages do not bring a
generated route tree with them.

**The `as const` discipline is load-bearing rather than stylistic**, and is restated here
because absorbing three dashboards' worth of routes is exactly when it gets dropped:
`ROUTES` and the rail's `STATIONS` are `as const`, and a `nav` is written
`as const satisfies NavEntry`, never `: NavEntry`. A plain array literal widens to a union
array, the route tree loses which paths exist, and `<Link to>` and `useParams({ from })`
degrade silently — the failure is a loss of type checking, not an error.

**URL state is typed at the route** through `validateSearch`, so a filtered view is
reproducible from its URL. That is what [0034](0034-car-dashboard-routes.md) committed to
for history and trends, and it generalizes to every page carrying filter state.

## Consequences

- One navigation model, one place a page is declared, one router to debug.
- The provider picker ([0041](0041-provider-picker-drives-the-navigation.md)) builds the
  side rail from this same registry, so which stations exist and which are shown are
  answered from one list rather than two.
- Migrating absorbed pages costs a rewrite of their route declarations. That is a
  build-time change, not a runtime one, and the pages' behaviour is unchanged by it.
- The registry grows to whatever the three stacks' pages total. One line per page is the
  price of not generating it, and it is deliberate: the list is readable, greppable, and
  reviewable in a diff.
- The import cycle between `registry`, the page files and `route-root` is deliberate and
  benign, since every edge is read lazily. It is not a defect to repair.

## Provenance

Decided by the repository owner before the `monorepo-fusion` campaign started, and
recorded here by that campaign's ticket 13.
