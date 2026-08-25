---
type: adr
title: A site-wide provider picker drives the navigation
description: One picker selects the provider; only that provider streams, and the side rail renders only the stations it supports.
tags: [monorepo, dashboard, navigation, providers, campaign]
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

# A site-wide provider picker drives the navigation

## Status

Accepted. Decided by the repository owner before the `monorepo-fusion` campaign began.

## Context

Three stacks land in one dashboard. Three separate dashboards would triple the surface;
one dashboard showing everything at once would put three providers' rows in the same table
with no way to read them apart, and would open three live streams for a page the operator
is reading one third of.

The three stacks do not support the same pages. Some views are a provider's own — its
history, its trends, its route budget. Others are the repository's and have no provider at
all: Ideas, Concepts, Advice.

## Decision

**One site-wide provider picker, at the top level of the dashboard, selects the active
provider.** It selects a **provider** in the sense of
[0040](0040-three-providers-and-three-harnesses.md) — one column, not a stack name.

- **It defaults to Anthropic.**
- **Only the selected provider streams.** One live connection at a time. Switching the
  picker closes the previous provider's stream and opens the new one.
- **The side rail renders only the stations the selected provider supports.** A station
  the provider does not support is absent, not present-and-disabled: a greyed row invites
  a click that cannot work and reads as breakage rather than as scope.
- **Switching provider on a page the new provider does not support redirects to the
  Overview.** The picker is site-wide, so it is reachable from a page the switch is about
  to invalidate; the Overview is the one station every provider has.
- **Model-agnostic pages are available under every provider.** Ideas, Concepts, and the
  rest of the repository's own pages are not a provider's data, so they neither disappear
  from the rail nor trigger the redirect.

## Consequences

- The rail is derived from the provider registry plus the route registry, rather than
  hand-maintained per provider.
- One stream at a time bounds the dashboard's connection cost at one regardless of how
  many pairs the repository grows to.
- A deep link into a provider-specific page carries its provider, so the picker is
  restored from the URL rather than reset to the default on load.
- The redirect is a visible state change, so it is announced in the UI rather than
  happening silently — an operator who switched provider and lost their page should be
  able to see why.
- Defaulting to Anthropic is a product call, not a technical one, and is recorded as such:
  it is the stack with the largest corpus and the dashboard the other two are measured
  against ([0042](0042-claude-dashboard-is-the-design-baseline.md)).

## Provenance

Decided by the repository owner before the `monorepo-fusion` campaign started, and
recorded here by that campaign's ticket 13.
