---
type: adr
title: Use the OpenAI Responses contract and adapt Plane parity
description: Define Bike on OpenAI/Codex Responses traffic and translate later claude-proxy parity to that contract.
tags: [architecture, proxy, responses-api]
timestamp: 2026-08-19
decided-by: /dev
ratified: false
wayfinder: bike-release
grill-round: 2
needs-human: true
---

# Use the OpenAI Responses contract and adapt Plane parity

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “Which upstream contract defines Bike: a transparent OpenAI/Codex Responses API proxy, or the existing Anthropic Messages API behavior copied unchanged?”

The repository exists to observe Codex. Copying the source repository's
Anthropic wire behavior would preserve an implementation shape but would not
serve the new product's traffic.

## Decision

Define Bike on the OpenAI Responses API contract used by Codex. Adapt every
later parity feature to OpenAI semantics while preserving the user-visible and
operational outcome of its claude-proxy counterpart.

## Consequences

- Core usage normalization names OpenAI Responses categories.
- The proxy recognizes Responses JSON and streaming events.
- Plane means capability parity, not byte-for-byte reuse of Anthropic protocol
  code.
