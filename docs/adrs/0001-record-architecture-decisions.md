---
type: adr
title: Record architecture decisions
description: Use ADRs to capture significant, hard-to-reverse decisions.
tags: [process]
timestamp: 2026-07-15
scope: claude
provenance:
  - repo: claude-proxy
    number: "0001"
    file: docs/adrs/0001-record-architecture-decisions.md
ratified: true
needs-human: false
---

# Record architecture decisions

## Status

Accepted.

## Context

We need to record the architectural decisions made on this project — the
significant, hard-to-reverse ones — so the reasoning survives turnover and time.

## Decision

We will use Architecture Decision Records, as [described by Michael
Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
Each record is one Markdown file in `adrs/`, numbered, with Status / Context /
Decision / Consequences.

## Consequences

The rationale behind decisions is preserved and queryable
(`okq find --type adr`). One lightweight step is added when making a
significant decision.

## Provenance

Native to `claude-proxy`, this repository's own corpus. It kept its number through the
`monorepo-fusion` merge because the claude block sorts first by timestamp and its numbering
was already dense. See [the legacy map](legacy-map.md) for how every inherited identifier
resolves.
