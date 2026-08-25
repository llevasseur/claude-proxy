---
type: adr
title: Three servers, and ox's server port moves off 8788
description: Each stack keeps its own server and its own routes; the dashboard fans out over three origins, which makes the claude/ox port collision campaign-caused and moves ox's server default.
tags: [runtime, configuration, providers, dashboard]
timestamp: 2026-08-25
scope: all
decided-by: /dev
ratified: false
wayfinder: provider-seam
grill-round: 3
needs-human: true
---

# Three servers, and ox's server port moves off 8788

## Status

Proposed by `/dev` during the `provider-seam` campaign. **A human has not ratified this
decision.** Flagged because it amends one clause of
[ADR 0050](0050-stack-scoped-environment-variables.md) — and because **0050 is itself
unratified**, carrying `decided-by: /dev`, `ratified: false`, `needs-human: true`. This is
one unratified proposal amending another, so **both should reach the human together**;
neither is a settled decision the other is overturning.

## Context

The campaign brief said every server route is provider-scoped and reads exactly one store,
but never said *which server process*. The griller asked:

> "So: one server or three? And if three, does 0050's verbatim-port rule survive the picker
> requiring simultaneous binding — or does that collision now qualify as fusion-caused and
> get reallocated, superseding 0050's decision rather than inheriting it?"

Measured at source:

- `stacks/claude/server/src/config.ts:11` — `DEFAULT_PORT = 8788`.
- `stacks/ox-alpha/server/src/config.ts:86` — defaults `OX_SERVER_PORT ?? SERVER_PORT` to
  `8788`.
- `stacks/codex/server/src/config.ts:11` — `DEFAULT_PORT = 4319`, which does not collide.

So the collision is exactly the claude/ox server pair.

## Decision

### Three servers, not one

**One server growing codex- and ox-scoped routes is refused.**
[ADR 0046](0046-narrowly-scoped-local-writes.md) gives each store one controller — "three
writers, never a shared store and never two writers against one file" — and a second
process opening ox's database file to read is a second party against a file whose sole
controller is ox's server. It also re-couples the blast radius 0046 bought: one process
reading three stores means one crash takes all three providers' pages, which is the "dead
dashboard" outcome 0046 exists to prevent.

It is refused a second time by this campaign's own scope, under which **every existing
capability survives**. Stranding `stacks/codex/server` and `stacks/ox-alpha/server` would
discard ratified route behaviour governed by
[0034](0034-car-dashboard-routes.md), [0037](0037-history-record-listing.md),
[0030](0030-calendar-date-range-api.md) and [0026](0026-daily-trend-granularity.md).

**So three servers keep their own routes, and claude's dashboard fans out over three
origins.** Only claude's `admin` is the picker surface, because
[ADR 0042](0042-claude-dashboard-is-the-design-baseline.md) makes claude's dashboard the
baseline — which is why this campaign touches only claude's `registry.ts` and leaves the
other two admin apps alone.

### ox's server default port moves off 8788

**0050's boundary test, applied rather than overridden:** a fusion-caused regression is in
scope to prevent, pre-existing awkwardness is out of scope to fix.

0050 placed the 8788 duplication on the "pre-existing" side with a stated warrant —
running both repositories today already collided. **That warrant held because nothing ever
required both servers to be up at once.** Two things that collide only when run together
are awkward. Two things that *must* run together and cannot are broken.

[ADR 0041](0041-provider-picker-drives-the-navigation.md) makes them run together: one
site-wide picker over Anthropic and Ox Alpha means switching the picker requires both
servers bound simultaneously. At that moment the second server does not bind, and the
typed-absence envelope of [ADR 0060](0060-a-stores-absence-is-typed.md) faithfully reports
"provider unavailable" **for a cause that is not the provider's at all**. That is worse
than an untyped gap: it is a *misattributed* fault, and it would be this campaign's own
doing.

So by 0050's own test the collision is now campaign-caused and in scope.

**One default moves: ox's server, `8788` → `8808`.** ox rather than claude because claude's
is the baseline dashboard and the far more widely referenced default, so moving ox is the
smaller blast radius; `8808` because it sits beside ox's own proxy default of `8807` and is
therefore memorable as ox's pair. `OX_SERVER_PORT` already exists from the fusion
campaign's ticket 22, so the override path is in place — but **an override is not
sufficient**, because the requirement is that a default checkout works with the picker out
of the box, and today's default does not.

### The amendment is partial, so it is recorded in prose and adds no key

This amends **one clause** of 0050 — its "change none of these numbers" — and nothing else.

[ADR 0058](0058-supersession-is-recorded-from-both-ends.md) governs how that is written
down, and it is explicit that **a partial supersession is not a supersession**. Its own
worked example is exactly this shape: 0003 supersedes the read-only `server/` constraint in
0002 and says the rest of 0002 remains in force, and 0058 records that marking 0002
`superseded-by: 0003` "would tell a reader to disregard a record that still governs." So
that relation is stated **in prose, as 0003 does, and adds no key**.

**0050 therefore gains no frontmatter key, and neither does this record.** Marking either
would misrepresent both: 0050 still governs the other eight ports, the scoped-variable
scheme, and the deliberate non-validation in claude's two packages. Nothing about it is
withdrawn except the one number.

**0050 stands otherwise**: its port-verbatim rule holds for the other eight ports, its
scoped-variable scheme is untouched, and the three admin dev servers on `5173` stay as they
are, because the picker does not require them bound simultaneously.

## Consequences

- **A default checkout must be able to run claude's and ox's servers at once.** That is a
  new requirement this campaign introduces, and it is what the port move buys.
- **Anyone running ox's server on `8788` today by relying on the default moves to `8808`**,
  or sets `OX_SERVER_PORT=8788` explicitly. This is the one runtime default this campaign
  changes.
- **The dashboard now depends on three origins being reachable**, so its per-provider
  unavailable state (ADR 0060) must distinguish "server not reachable" from "store
  unreadable". They are different faults with different fixes, and collapsing them
  reproduces the misattribution this decision exists to prevent.
- **codex's `4319` is untouched**, so only one of the three moves.

## Alternatives considered

**One server reading all three stores.** Rejected on ADR 0046, twice over: it puts a second
party against a file with a designated sole controller, and it restores the single point of
failure per-proxy storage was chosen to remove.

**Keep `8788` on both and require an operator override.** Rejected. It leaves the default
checkout broken for the picker, and the failure surfaces as a misattributed "provider
unavailable" rather than as a port conflict — the least legible possible presentation of
the most mundane possible cause.

**Move claude's server instead.** Rejected as the larger blast radius: claude's `8788` is
the baseline dashboard's server and the more widely referenced of the two.
