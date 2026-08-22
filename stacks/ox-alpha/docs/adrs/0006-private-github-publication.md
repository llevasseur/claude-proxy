---
type: adr
title: Publish the repository privately
description: Ship through a private GitHub repository from day one.
tags: [process, publication]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: ox-alpha-proxy
grill-round: 8
---

# Publish the repository privately

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Provenance

Adapted from `codex-proxy` `docs/adrs/0006-private-github-publication.md`.

## Decision

Create and publish ox-alpha-proxy as a private GitHub repository before any
campaign work lands. Runtime secrets and data stay untracked regardless of
repository visibility.

## Consequences

- CI runs against a private remote from the first push.
- Visibility changes later require a deliberate human act.
