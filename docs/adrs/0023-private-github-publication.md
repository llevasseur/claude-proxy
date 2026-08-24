---
type: adr
title: Publish the repository privately
description: Ship each sibling repository through a private GitHub remote from day one, regardless of what stays untracked.
tags: [repository, github, publication, process]
timestamp: 2026-08-19
scope: all
provenance:
  - repo: codex-proxy
    number: "0006"
    file: docs/adrs/0006-private-github-publication.md
  - repo: ox-alpha-proxy
    number: "0006"
    file: docs/adrs/0006-private-github-publication.md
decided-by: /dev
ratified: false
needs-human: true
---

# Publish the repository privately

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> "What remote publication boundary does 'ship the repo' require — should `/dev` create
> the GitHub repository, and with what visibility?"

Each repository contains a traffic proxy and local operational tooling. A private
boundary allows the Bike campaign to land without implicitly choosing a public release or
a support promise.

## Decision

Create and publish through a private GitHub repository, owned by `llevasseur`, before any
campaign work lands. Runtime secrets, logs, databases, and sidecars stay untracked
regardless of repository visibility.

## Consequences

- Campaign branches and pull requests use that private remote.
- CI runs against a private remote from the first push.
- A later public release requires an explicit visibility and readiness decision — a
  deliberate human act rather than a default.

## Provenance

**One decision, recorded separately by two repositories, restated here once.** Merged
from `codex-proxy` `docs/adrs/0006-private-github-publication.md` (`codex#0006`) and
`ox-alpha-proxy` `docs/adrs/0006-private-github-publication.md` (`ox-alpha#0006`) during
the `monorepo-fusion` campaign, under ADR 0053. It carries codex's earlier `2026-08-19`
timestamp; ox-alpha-proxy restated it on `2026-08-22`, citing the codex record.

**Governs the `codex` and `ox-alpha` stacks.** Each named its own remote —
`llevasseur/codex-proxy` and `llevasseur/ox-alpha-proxy` — and the merged statement keeps
the rule rather than either name, since both remotes are now upstreams of this
repository's history rather than live publication targets.

**This record replaces both originals rather than superseding them.** Both persist in
this repository's own git history, the form ADR 0029 blessed. See
[the legacy map](legacy-map.md) for why a merge is not a supersession.
