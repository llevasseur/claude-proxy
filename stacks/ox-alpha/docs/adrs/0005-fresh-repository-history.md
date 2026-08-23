---
type: adr
title: Start with fresh repository history
description: Begin ox-alpha-proxy at one initial commit instead of importing codex-proxy history.
tags: [process, repository]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: ox-alpha-proxy
grill-round: 8
---

# Start with fresh repository history

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Provenance

Adapted from `codex-proxy` `docs/adrs/0005-fresh-repository-history.md`.

## Decision

Start ox-alpha-proxy at one fresh initial commit on its default branch. Inherit
decisions through adapted republication (ADR 0010), never through imported git
history or copied source files.

## Consequences

- Provenance lives in citation sections, not in shared history.
- The repository speaks as ox-alpha-proxy from its first commit.
