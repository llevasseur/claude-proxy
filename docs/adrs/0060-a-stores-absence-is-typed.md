---
type: adr
title: A store's absence is typed, and never rendered as data
description: A fan-out read returns a typed reason per provider rather than a gap, so a store that was never created and a store that is broken stay distinct from a provider that genuinely served nothing.
tags: [storage, providers, dashboard, reliability]
timestamp: 2026-08-25
scope: all
decided-by: /dev
ratified: false
wayfinder: provider-seam
grill-round: 1
needs-human: true
---

# A store's absence is typed, and never rendered as data

## Status

Proposed by `/dev` during the `provider-seam` campaign. **A human has not ratified this
decision.** Flagged because it commits to a typed vocabulary that surfaces in the API and
in the dashboard, and because it forbids a rendering — a plain gap in a cross-provider
series — that a reader might otherwise expect.

## Context

The campaign brief proposed per-proxy storage with the rule that **a missing store is
treated as a missing series**. It also asserted that per-proxy storage was ungoverned.

The griller established that the second claim is false, which is what makes the first one
a real decision rather than part of a larger one.
[ADR 0046](0046-narrowly-scoped-local-writes.md) already decides n stores at line 41 —
"Three proxies, three databases, three writers — n for n, never a shared store and never
two writers against one file" — and already decides reader-side combination at line 72:
"no cross-provider join at the storage layer." So the storage shape is ratified, and the
only unrecorded part of the brief was the absence rule, which contradicts it.

The griller asked:

> "ADR 0046 justifies per-proxy stores on blast radius, and states the required
> operator-visible outcome: a store going down 'costs only its own provider's pages... and
> the failure is legible as *this provider is unavailable* rather than as a dead
> dashboard.' Your rule — a missing store is treated as a missing series — is the opposite
> of legible: a gap in a chart is indistinguishable from a provider that genuinely served
> no traffic that day, and it collapses at least three distinct states into one rendering
> (store never created because that proxy has never run; store present but
> locked/corrupt/mid-migration; store present and healthy with zero rows in range). The
> corpus elsewhere refuses exactly this collapse — `docs/adrs/0020-unavailable-incomplete-cost.md`
> and `docs/adrs/0044-every-model-gets-a-price-row.md` insist an unknown cost is null and
> *not* zero, with a typed reason, precisely so absence never reads as a real measurement
> of nothing. Why does a missing store get the treatment 0020/0044 deny to a missing
> price — and if it does not, what typed unavailability reason does a fan-out read return
> per store, and where does 0046's 'this provider is unavailable' actually surface?"

It does not, and the brief's rule is withdrawn.

## Decision

**A fan-out read never returns a bare gap.** Each provider contributes either data or a
typed reason, in a per-provider envelope.

This follows the shape [ADR 0020](0020-unavailable-incomplete-cost.md) already sets for an
unknown cost: "Return the complete token metrics and mark the entire cost unavailable ...
**Include a typed reason.** Never substitute zero," with cost "nullable in sidecars,
database rows, API summaries, and the UI." The reason 0020 gives at line 30 is the reason
here — an absence rendered as a real value "looks complete in an aggregate and understates
spend."

**Three states stay distinct, because two are absences and one is a measurement:**

1. **Store never created** — that proxy has never run. Typed reason; null, not zero. This
   is "no instrument", not "no traffic". It is a steady state and a human should be able
   to ignore it.
2. **Store present but unreadable** — locked, corrupt, or mid-migration. A typed reason
   **distinct from (1)**, because this is a fault a human should act on. This is the state
   [ADR 0046](0046-narrowly-scoped-local-writes.md) means when it requires the failure to
   be legible as "this provider is unavailable".
3. **Store present, healthy, zero rows in range** — a **real measurement of zero**, which
   renders as a genuine zero series. Collapsing this into (1) or (2) is the mirror of the
   same error: reporting a fault where the honest answer is that nothing happened.

**The typed reason mirrors `CostUnavailableReason`**, which this campaign already folds in
from codex on the grounds that it makes the codebase stronger. This is that pattern applied
to a second kind of absence, not a new invention.

**One source, three readers.** The per-provider envelope is what a cross-provider page
renders its per-provider unavailable state from, what an aggregate reads to decide
propagation, and what the picker in
[ADR 0041](0041-provider-picker-drives-the-navigation.md) reads to show a provider as
degraded rather than as empty. That is the same "one source, many readers" shape 0041
already requires of the route registry.

## Consequences

- **A chart may not draw a gap for a provider it could not read.** It draws an explicit
  unavailable state carrying the reason. This is a rendering constraint on every
  cross-provider surface, not a data-layer detail.
- **Zero is now a meaningful value again.** Because states (1) and (2) are null with a
  reason, a zero series is unambiguous: that provider ran and served nothing.
- **The typed reason is API surface**, so adding a state later is a versioned change rather
  than a free addition.
- **A provider unavailable for a cause outside the store — for example a server that
  failed to bind — must not be reported as state (2).** State (2) means the store is
  unreadable. Misattributing an infrastructure fault to the store is the failure mode
  [ADR 0062](0062-three-servers-and-one-moved-port.md) exists to prevent, and the two
  records are read together.

## Alternatives considered

**Keep the brief's rule: a missing store is a missing series.** Rejected. It renders three
states identically, and the one it most resembles — a real zero — is the one it is most
likely to be mistaken for. It also fails 0046's own stated outcome, which is not merely
that the dashboard survives but that the failure is *legible*.

**Report any absence as an error.** Rejected. It converts state (1), which is a normal
steady state on any device running fewer than three proxies, into a fault, and a dashboard
that always shows two faults trains its reader to ignore faults.
