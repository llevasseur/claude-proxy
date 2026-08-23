---
type: adr
title: Make incomplete cost unavailable
description: Never represent an unknown or partially priced request as a zero or complete estimate.
tags: [architecture, pricing, usage]
timestamp: 2026-08-19
decided-by: /dev
ratified: false
wayfinder: bike-release
grill-round: 4
---

# Make incomplete cost unavailable

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “What must Bike report when an OpenAI model or usage category has no configured price: ‘cost unavailable’ while still showing tokens, or a partial/zero estimate?”

A zero or partial estimate looks complete in an aggregate and understates spend.
Token counts remain useful even when a catalogue lacks a required rate.

## Decision

Return the complete token metrics and mark the entire cost unavailable when the
model or any consumed usage category lacks a configured price. Include a typed
reason. Never substitute zero and never label a partial estimate as total cost.

## Consequences

- Cost is nullable in sidecars, database rows, API summaries, and the UI.
- Aggregation propagates unavailability when any included request is not fully
  priced.
- The Overview renders an unavailable state instead of `$0`.
