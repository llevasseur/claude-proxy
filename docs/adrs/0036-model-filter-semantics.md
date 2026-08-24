---
type: adr
title: Filter by exact multi-select model identifiers
description: Model filters take repeated exact-match parameters and return an empty result set when nothing matches.
tags: [architecture, api, filters, car]
timestamp: 2026-08-22
scope: codex
provenance:
  - repo: codex-proxy
    number: "0014"
    file: docs/adrs/0014-model-filter-semantics.md
decided-by: /dev
ratified: false
wayfinder: car-release
grill-round: 8
needs-human: true
---

# Filter by exact multi-select model identifiers

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “Does the Car model filter accept exactly one exact-match model identifier per request, or multiple models simultaneously — and does an unmatched model value simply produce an empty result set rather than a validation error?”

The sidecar stores `model` as the exact identifier used for pricing; no document defines filter semantics over it.

## Decision

Accept multi-select via repeated query parameter (`model=a&model=b`), matched exactly against the stored sidecar `model` field. A well-formed value that matches no ingested record returns an ordinary empty result set with valid envelope metadata, never a validation error. Add no normalization or aliasing layer.

## Consequences

- Exact matching is the only faithful semantics; no alias machinery exists anywhere in core.
- Shareable URLs survive catalogue naming drift because unmatched values degrade to empty results.
- Single-model filtering is the one-element case of multi-select.

## Provenance

Inherited from `codex-proxy` `docs/adrs/0014-model-filter-semantics.md` (`codex#0014`) and
renumbered to 0036 when the three corpora were merged into this bundle during the
`monorepo-fusion` campaign. The decision itself is unchanged; its ratification fields are
carried over verbatim under ADR 0052, and references to sibling records were repointed at
their new numbers. The original persists in this repository's own git history, which is the
form ADR 0029 blessed.
