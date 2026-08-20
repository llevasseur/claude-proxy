---
type: adr
title: Publish the repository privately
description: Ship codex-proxy to a private repository owned by llevasseur.
tags: [repository, github, publication]
timestamp: 2026-08-19
decided-by: /dev
ratified: false
wayfinder: bike-release
grill-round: 10
needs-human: true
---

# Publish the repository privately

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “What remote publication boundary does ‘ship the repo’ require: should /dev create llevasseur/codex-proxy on GitHub, and with what visibility?”

The repository will contain a traffic proxy and local operational tooling. A
private boundary allows the Bike campaign to land without implicitly choosing a
public release or support promise.

## Decision

Publish and ship through the private GitHub repository
`llevasseur/codex-proxy`.

## Consequences

- Campaign branches and pull requests use that private remote.
- A later public release requires an explicit visibility and readiness decision.
- Runtime secrets, logs, databases, and sidecars remain ignored regardless of
  repository visibility.
