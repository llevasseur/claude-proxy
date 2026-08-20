---
type: adr
title: Start with fresh repository history
description: Build codex-proxy as a new repository instead of rewriting claude-proxy history.
tags: [repository, migration]
timestamp: 2026-08-19
decided-by: /dev
ratified: false
wayfinder: bike-release
grill-round: 9
needs-human: true
---

# Start with fresh repository history

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “Should codex-proxy start as a fresh repository containing only Bike and its roadmap, or preserve claude-proxy’s Git history and remove post-Bike code?”

The new repository changes protocol, product staging, and privacy defaults.
Rewriting the source history would obscure which code was actually adapted and
would retain unrelated product evolution.

## Decision

Start codex-proxy with fresh Git history. Add only Bike, its delivery roadmap,
and records that explain intentional adaptation from claude-proxy.

## Consequences

- History describes codex-proxy's own decisions and increments.
- Source attribution and pinned reference commits remain in durable docs.
- Useful code and styles may be adapted deliberately without importing unrelated
  commits.
