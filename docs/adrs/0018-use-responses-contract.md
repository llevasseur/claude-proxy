---
type: adr
title: Use the OpenAI Responses contract
description: Define Bike on OpenAI Responses traffic, with the upstream host as deployment configuration rather than an architecture decision.
tags: [architecture, proxy, responses-api]
timestamp: 2026-08-19
scope: all
provenance:
  - repo: codex-proxy
    number: "0001"
    file: docs/adrs/0001-use-responses-contract.md
  - repo: ox-alpha-proxy
    number: "0001"
    file: docs/adrs/0001-use-responses-contract.md
decided-by: /dev
ratified: false
needs-human: true
---

# Use the OpenAI Responses contract

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

Both non-Anthropic stacks had to name the upstream contract that defines Bike, and both
were asked the question in the same terms — codex-proxy against the alternative of
copying claude-proxy's Anthropic Messages behaviour unchanged, ox-alpha-proxy against
the alternative of extending codex-proxy rather than existing separately.

Each repository exists to observe a Codex-shaped client. Copying the source
repository's Anthropic wire behaviour would preserve an implementation shape without
serving the new product's traffic.

## Decision

Define Bike on the OpenAI Responses API contract used by Codex. Adapt every later parity
feature to OpenAI semantics while preserving the user-visible and operational outcome of
its claude-proxy counterpart.

**The upstream host is deployment configuration read from the environment, not an
architecture decision.** Two stacks speaking the same wire contract to different
configured hosts are one decision instantiated twice, not two contracts.

## Consequences

- Core usage normalization names OpenAI Responses categories.
- The proxy recognizes Responses JSON and streaming events.
- Plane means capability parity, not byte-for-byte reuse of Anthropic protocol code.
- Distinctness between the two stacks comes from fresh history and independent
  deployment, not from a different wire contract.

## Provenance

**One decision, recorded separately by two repositories, restated here once.** Merged
from `codex-proxy` `docs/adrs/0001-use-responses-contract.md` (`codex#0001`) and
`ox-alpha-proxy` `docs/adrs/0001-use-responses-contract.md` (`ox-alpha#0001`) during the
`monorepo-fusion` campaign, under ADR 0053.

It carries codex's `2026-08-19` timestamp rather than ox-alpha's `2026-08-22`, because
that is when the decision was made; ox-alpha restated it three days later.

**Governs the `codex` and `ox-alpha` stacks.** Where the two records differ they differ
in emphasis rather than in substance: codex-proxy frames the contract as the thing later
Plane parity is adapted *to*, while ox-alpha-proxy frames it as what it shares with
codex-proxy while remaining a clean-room rebuild from the recorded corpus — an
independently deployable instance for the ox-alpha workspace, not a fork of codex-proxy
code.

**This record replaces both originals rather than superseding them.** Both persist in
this repository's own git history, which is the form ADR 0029 blessed. See
[the legacy map](legacy-map.md) for why a merge is not a supersession.
