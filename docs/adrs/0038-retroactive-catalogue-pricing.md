---
type: adr
title: Price historical records against the current catalogue
description: The view derives cost for unknown-model records from model and usage at ingest and read time; sidecars stay untouched.
tags: [architecture, pricing, sqlite, car]
timestamp: 2026-08-23
scope: codex
provenance:
  - repo: codex-proxy
    number: "0016"
    file: docs/adrs/0016-retroactive-catalogue-pricing.md
decided-by: user
ratified: true
needs-human: false
---

# Price historical records against the current catalogue

## Status

Decided by the repository owner on 2026-08-23. Ratified; this record documents an explicit human product call made
outside a campaign grill.

## Context

Bike's cost semantics (ADR 0020) mark an unpriced record unavailable with a typed reason instead of guessing, and the
proxy stamps cost once at sidecar-write time. When a model was missing from the catalogue — as every request was
before the 2026-08-22 catalogue update — its records stayed permanently unpriced even after the model became known.
The owner rejected permanence: "cost should be computed against actual model + API costs."

## Decision

The disposable SQLite view resolves cost against the current pricing catalogue whenever it materializes a record whose
only obstacle is `unknown-model`: at column write time during ingest, when parsing stored sidecars for Today and trend
aggregates, and therefore in history, trends, and the Overview. A model still absent from the catalogue remains
explicitly unavailable with its typed reason.

Sidecar files are never rewritten. They remain the sanitized source of truth; derived cost is view state. Bumping the
view to user_version 3 discards existing databases once and backfills them through the same path (ADR 0028).

## Consequences

- Adding models to `PRICING_CATALOGUE` reprices affected history without data migration beyond the version bump.
- Costs computed under an older catalogue keep their original amounts and `catalogueVersion`; only `unknown-model`
  records adopt the current catalogue.
- Aggregates gain cost coverage automatically: a day whose records were all unknown-model becomes fully priced after
  the catalogue learns those models.

## Provenance

Inherited from `codex-proxy` `docs/adrs/0016-retroactive-catalogue-pricing.md` (`codex#0016`) and
renumbered to 0038 when the three corpora were merged into this bundle during the
`monorepo-fusion` campaign. The decision itself is unchanged; its ratification fields are
carried over verbatim under ADR 0052, and references to sibling records were repointed at
their new numbers. The original persists in this repository's own git history, which is the
form ADR 0029 blessed.
