---
type: adr
title: Three providers and three harnesses, paired but not fused
description: Provider and harness are two independent columns with two independent adapter registries; no code infers either from the other.
tags: [monorepo, architecture, providers, harness, campaign]
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

# Three providers and three harnesses, paired but not fused

## Status

Accepted. Decided by the repository owner before the `monorepo-fusion` campaign began.

**This record is load-bearing for every ticket in this campaign and for the two campaigns
after it.** It is the one whose softening is most expensive, because the softening is
invisible: code that quietly assumes the pairing works perfectly until the pairing changes.

## Context

The fused repository observes three stacks. Each is a **pair** of two independent things:

| Provider | Harness |
|---|---|
| Anthropic | Claude Code |
| OpenAI | Codex |
| Ox Alpha | opencode |

The trap is the shorthand. The two absorbed repositories are habitually called "codex/ox",
and that phrase is easy to read as a category — as though there were a claude-shaped thing
and a codex/ox-shaped thing, and code could branch on which one it had.

## Decision

**These are three distinct pairs. "codex/ox" names shared repository lineage and nothing
else.** It records that two of the three stacks were absorbed from sibling repositories
built from a common template. It is a fact about where files came from. It is not a
provider, not a harness, not a protocol, not a wire contract, and not a behaviour class.
No runtime decision may be made on it.

**Provider and harness are two independent columns.** A record carries both, separately,
and neither is derivable from the other:

- **No code may infer the harness from the provider.** Anthropic is not Claude Code.
- **No code may infer the provider from the harness.** Codex is not OpenAI.

**Two independent adapter registries.** One keyed by provider, one keyed by harness.
Neither registry is indexed by the other's key, and there is no combined
`provider-harness` key that would smuggle the pairing back in as a single enum value.

The pairing that exists today is **data, not structure**: today's three pairs are three
rows, and a fourth pair — an existing provider under a new harness, or an existing harness
against a new provider — is a new row rather than a new code path.

## Consequences

- Every record carries a provider column and a harness column. A schema with one column
  covering both is a defect against this record, not a simplification of it.
- A `switch` over three stack names, anywhere in the codebase, is the anti-pattern this
  record exists to forbid. Dispatch through the registry for the axis that actually
  governs the behaviour: wire contract and pricing are the provider's, session shape and
  transcript format are the harness's.
- Pricing is keyed by provider and model. Skim and session parsing are keyed by harness.
  Neither reaches for the other's key.
- The dashboard's provider picker ([0041](0041-provider-picker-drives-the-navigation.md))
  selects a provider, and the stations it shows are what that provider supports — resolved
  through the provider registry, never through a stack name.
- Adding a pair costs two registry entries and no branching.

## Provenance

Decided by the repository owner before the `monorepo-fusion` campaign started, and
recorded here by that campaign's ticket 13.
