---
type: adr
title: Use the OpenAI Responses contract
description: Define Bike on OpenAI Responses traffic with a configurable upstream host.
tags: [architecture, proxy, responses-api]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: ox-alpha-proxy
grill-round: 2
needs-human: true
---

# Use the OpenAI Responses contract

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> "What upstream provider and wire contract will ox-alpha-proxy transparently forward ... and if it is the same OpenAI Responses contract, what distinct purpose justifies a separate repository instead of extending codex-proxy?"

## Decision

Define Bike on the OpenAI Responses contract, exactly as codex-proxy does. The
upstream host is deployment configuration read from the environment, not an
architecture decision. ox-alpha-proxy exists as a clean-room rebuild from the
recorded decision corpus — an independently deployable instance for the
ox-alpha workspace, not a fork of codex-proxy code.

## Consequences

- Core usage normalization names OpenAI Responses categories.
- The proxy recognizes Responses JSON and streaming events.
- Distinctness comes from fresh history and independent deployment, not from a different wire contract.
